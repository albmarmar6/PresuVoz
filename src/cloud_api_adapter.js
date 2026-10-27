/**
 * PresuVoz — Meta WhatsApp Business Cloud API Adapter & Self-Hosted Signing Server
 *
 * Responsabilidades:
 * 1. Adaptador compatible con la interfaz de Baileys (`sock.ev`, `sock.sendMessage`, `sock.sendPresenceUpdate`)
 *    para conectar PresuVoz a la API Oficial de WhatsApp Business de Meta (Graph API) sin alterar
 *    las llamadas de negocio existentes en `whatsapp_gateway.js`.
 * 2. Verificación criptográfica de Webhooks de Meta (`hub.verify_token` y firma HMAC `X-Hub-Signature-256`).
 * 3. Subida y descarga de archivos multimedia (notas de voz `.ogg`, imágenes de facturas/logos, PDFs de presupuestos/facturas).
 * 4. Servidor de Enlaces Cortos de Firma (`/f/:code`) y API local de firma (`/api/sign`), eliminando
 *    las URLs gigantescas y permitiendo alojar la firma digital bajo el propio dominio de PresuVoz.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto, { EventEmitter } from 'node:events';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { Resend } from 'resend';

const require = createRequire(import.meta.url);

function renderQrSvg(text) {
  try {
    const QRCode = require('qrcode-terminal/vendor/QRCode');
    const qr = new QRCode(0, 1);
    qr.addData(text);
    qr.make();
    const count = qr.modules.length;
    let rects = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          rects += '<rect x="' + c + '" y="' + r + '" width="1" height="1" fill="#000"/>';
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + count + ' ' + count + '" shape-rendering="crispEdges" width="280" height="280">' + rects + '</svg>';
  } catch (err) {
    return '<p style="color:red">Error al generar QR: ' + err.message + '</p>';
  }
}

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getSigningLinksFilePath() {
  if (process.env.PRESUVOZ_SIGNING_LINKS_FILE) {
    return path.resolve(process.env.PRESUVOZ_SIGNING_LINKS_FILE);
  }
  return process.env.NODE_ENV === 'test'
    ? path.join(DATA_DIR, 'signing_links_test.json')
    : path.join(DATA_DIR, 'signing_links.json');
}

function getSignedBudgetsFilePath() {
  if (process.env.PRESUVOZ_SIGNED_BUDGETS_FILE) {
    return path.resolve(process.env.PRESUVOZ_SIGNED_BUDGETS_FILE);
  }
  return process.env.NODE_ENV === 'test'
    ? path.join(DATA_DIR, 'signed_budgets_test.json')
    : path.join(DATA_DIR, 'signed_budgets.json');
}

const signingLinksMemory = new Map();
const signedBudgetsMemory = new Map();
let storesLoaded = false;

function ensureStoresLoaded() {
  if (storesLoaded) return;
  storesLoaded = true;
  try {
    const linksFile = getSigningLinksFilePath();
    if (fs.existsSync(linksFile)) {
      const parsed = JSON.parse(fs.readFileSync(linksFile, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          signingLinksMemory.set(k, v);
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ [CloudAdapter] No se pudo cargar signing_links:', err.message);
  }

  try {
    const signedFile = getSignedBudgetsFilePath();
    if (fs.existsSync(signedFile)) {
      const parsed = JSON.parse(fs.readFileSync(signedFile, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          signedBudgetsMemory.set(k, v);
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ [CloudAdapter] No se pudo cargar signed_budgets:', err.message);
  }
}

function persistSigningLinks() {
  try {
    const obj = Object.fromEntries(signingLinksMemory.entries());
    fs.writeFileSync(getSigningLinksFilePath(), JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('⚠️ [CloudAdapter] Error guardando signing_links:', err.message);
  }
}

function persistSignedBudgets() {
  try {
    const obj = Object.fromEntries(signedBudgetsMemory.entries());
    fs.writeFileSync(getSignedBudgetsFilePath(), JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn('⚠️ [CloudAdapter] Error guardando signed_budgets:', err.message);
  }
}

/**
 * Registra un enlace corto de firma (`/f/:code`) para un presupuesto comprimido y firmado.
 * Devuelve un código corto alfanumérico de 8 caracteres determinista e infalsificable.
 *
 * @param {object} params
 * @param {string} params.budgetId
 * @param {string} [params.companyId]
 * @param {string} [params.companyPhone]
 * @param {string} params.z - Payload comprimido en base64url
 * @param {string} params.s - Prueba HMAC-SHA256 en base64url
 * @param {string} params.secret - Secreto de firma PRESUVOZ_SIGNING_SECRET
 * @returns {string} Código corto de 8 caracteres (ej. "Ab3xK9pQ")
 */
export function registerShortSigningLink({ budgetId, companyId = null, companyPhone = null, z, s, secret }) {
  ensureStoresLoaded();
  const seed = `${companyId || companyPhone || ''}:${budgetId || ''}:${z}`;
  const rawHash = createHmac('sha256', String(secret || 'presuvoz'))
    .update(seed)
    .digest('base64url')
    .replace(/[^a-zA-Z0-9]/g, '');
  const code = rawHash.slice(0, 8) || 'pvz00001';

  const entry = {
    code,
    budgetId: String(budgetId || '').trim(),
    companyId: companyId || null,
    companyPhone: companyPhone ? String(companyPhone).replace(/\D/g, '') : null,
    z,
    s,
    createdAt: new Date().toISOString()
  };

  signingLinksMemory.set(code, entry);
  persistSigningLinks();
  return code;
}

/**
 * Obtiene los datos de un enlace corto de firma por su código.
 * @param {string} code
 * @returns {object|null}
 */
export function getShortSigningLink(code) {
  ensureStoresLoaded();
  if (!code || typeof code !== 'string') return null;
  const cleanCode = code.trim().replace(/[^a-zA-Z0-9]/g, '');
  return signingLinksMemory.get(cleanCode) || null;
}

/**
 * Consulta si un presupuesto ya ha sido firmado en el almacén local del servidor.
 * @param {string} budgetId
 * @param {string|null} [companyId=null]
 * @returns {object|null}
 */
export function getLocalSignedBudget(budgetId, companyId = null) {
  ensureStoresLoaded();
  if (!budgetId) return null;
  const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
  const cleanCompanyId = companyId ? String(companyId).trim() : null;
  if (cleanCompanyId) {
    const scoped = signedBudgetsMemory.get(`${cleanCompanyId}::${cleanId}`);
    if (scoped) return scoped;
    const unscoped = signedBudgetsMemory.get(cleanId);
    if (unscoped && (!unscoped.companyId || unscoped.companyId === cleanCompanyId)) {
      return unscoped;
    }
    return null;
  }
  return signedBudgetsMemory.get(cleanId) || null;
}

/**
 * Registra una firma completada en el almacén local del servidor.
 * @param {string} budgetId
 * @param {object} details
 * @param {string|null} [companyId=null]
 */
export function saveLocalSignedBudget(budgetId, details, companyId = null) {
  ensureStoresLoaded();
  if (!budgetId) return null;
  const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
  const effectiveCompanyId = (companyId || details?.companyId || '')
    ? String(companyId || details?.companyId).trim()
    : null;
  const record = {
    signed: true,
    budgetId: String(budgetId).trim(),
    ...details,
    ...(effectiveCompanyId ? { companyId: effectiveCompanyId } : {}),
    signedAt: details?.signedAt || new Date().toISOString()
  };
  if (effectiveCompanyId) {
    signedBudgetsMemory.set(`${effectiveCompanyId}::${cleanId}`, record);
    if (!signedBudgetsMemory.has(cleanId)) {
      signedBudgetsMemory.set(cleanId, record);
    }
  } else {
    signedBudgetsMemory.set(cleanId, record);
  }
  persistSignedBudgets();
  return record;
}

/**
 * Limpia la caché en memoria para pruebas unitarias.
 */
export function clearShortLinksAndSignaturesForTesting() {
  signingLinksMemory.clear();
  signedBudgetsMemory.clear();
  try {
    const lf = getSigningLinksFilePath();
    if (lf.includes('_test.json') && fs.existsSync(lf)) fs.unlinkSync(lf);
  } catch {}
  try {
    const sf = getSignedBudgetsFilePath();
    if (sf.includes('_test.json') && fs.existsSync(sf)) fs.unlinkSync(sf);
  } catch {}
}

/**
 * Verifica la firma criptográfica `X-Hub-Signature-256` enviada por Meta en cada POST al webhook.
 *
 * @param {Buffer|string} rawBody - Cuerpo crudo de la petición HTTP
 * @param {string} signatureHeader - Cabecera `x-hub-signature-256` (formato `sha256=...`)
 * @param {string} appSecret - `META_APP_SECRET` de la app de Meta
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || typeof appSecret !== 'string') return false;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const providedHex = signatureHeader.slice('sha256='.length).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) return false;

  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf-8');
  const expectedHex = createHmac('sha256', appSecret).update(bodyBuf).digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(providedHex, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Convierte un payload de Webhook de Meta WhatsApp Cloud API en un array de mensajes
 * con la estructura exacta de Baileys (`messages.upsert`) que espera `whatsapp_gateway.js`.
 *
 * @param {object} payload - Objeto JSON enviado por Meta al webhook
 * @returns {Array<object>} Lista de mensajes compatibles con Baileys
 */
export function parseCloudWebhookToBaileysMessages(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return [];
  }

  const normalizedMessages = [];

  for (const entry of payload.entry) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value || !Array.isArray(value.messages) || value.messages.length === 0) {
        continue;
      }

      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const contactMap = new Map();
      for (const c of contacts) {
        if (c?.wa_id) {
          contactMap.set(String(c.wa_id).replace(/\D/g, ''), c?.profile?.name || '');
        }
      }

      for (const m of value.messages) {
        if (!m || !m.from) continue;
        const cleanFrom = String(m.from).replace(/\D/g, '');
        if (!cleanFrom) continue;

        const remoteJid = `${cleanFrom}@s.whatsapp.net`;
        const msgId = m.id || `wamid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = Number(m.timestamp || Math.floor(Date.now() / 1000));
        const pushName = contactMap.get(cleanFrom) || '';

        let messageContent = null;
        let cloudMediaId = null;

        if (m.type === 'text' && m.text) {
          messageContent = {
            conversation: String(m.text.body || '')
          };
        } else if (m.type === 'interactive' && m.interactive) {
          const replyText =
            m.interactive.button_reply?.title ||
            m.interactive.list_reply?.title ||
            m.interactive.button_reply?.id ||
            m.interactive.list_reply?.id ||
            '';
          if (replyText) {
            messageContent = { conversation: String(replyText) };
          }
        } else if (m.type === 'button' && m.button) {
          const btnText = m.button.text || m.button.payload || '';
          if (btnText) {
            messageContent = { conversation: String(btnText) };
          }
        } else if (m.type === 'audio' && m.audio) {
          cloudMediaId = m.audio.id || null;
          messageContent = {
            audioMessage: {
              mimetype: m.audio.mime_type || 'audio/ogg; codecs=opus',
              ptt: Boolean(m.audio.voice ?? true),
              _cloudMediaId: cloudMediaId
            }
          };
        } else if (m.type === 'image' && m.image) {
          cloudMediaId = m.image.id || null;
          messageContent = {
            imageMessage: {
              mimetype: m.image.mime_type || 'image/jpeg',
              caption: m.image.caption || '',
              _cloudMediaId: cloudMediaId
            }
          };
        } else if (m.type === 'document' && m.document) {
          cloudMediaId = m.document.id || null;
          const mime = String(m.document.mime_type || '');
          // Si el usuario envía una imagen adjunta como documento, permitir procesarla como imagen si es imagen
          if (mime.startsWith('image/')) {
            messageContent = {
              imageMessage: {
                mimetype: mime,
                caption: m.document.caption || m.document.filename || '',
                _cloudMediaId: cloudMediaId
              }
            };
          } else {
            messageContent = {
              documentMessage: {
                mimetype: mime || 'application/pdf',
                fileName: m.document.filename || 'documento',
                caption: m.document.caption || '',
                _cloudMediaId: cloudMediaId
              }
            };
          }
        }

        if (!messageContent) continue;

        normalizedMessages.push({
          key: {
            remoteJid,
            fromMe: false,
            id: msgId
          },
          messageTimestamp: timestamp,
          pushName,
          message: messageContent,
          _cloudMediaId: cloudMediaId
        });
      }
    }
  }

  return normalizedMessages;
}

/**
 * Descarga un archivo multimedia (nota de voz, imagen de ticket/logo) desde Meta Graph API.
 *
 * @param {string} mediaId - ID del media devuelto por Meta en el webhook
 * @param {object} options
 * @param {string} options.accessToken - Token de acceso (`META_ACCESS_TOKEN`)
 * @param {string} [options.apiVersion='v21.0']
 * @param {Function} [options.fetchImpl=fetch]
 * @returns {Promise<Buffer>}
 */
export async function downloadCloudMedia(mediaId, options = {}) {
  const accessToken = options.accessToken || process.env.META_ACCESS_TOKEN || '';
  const apiVersion = options.apiVersion || process.env.META_GRAPH_API_VERSION || 'v21.0';
  const fetchFn = options.fetchImpl || globalThis.fetch;

  if (!mediaId) {
    throw new Error('Falta mediaId para descargar el archivo de WhatsApp Cloud API.');
  }
  if (!accessToken) {
    throw new Error('Falta META_ACCESS_TOKEN para descargar multimedia de WhatsApp Cloud API.');
  }

  // 1. Obtener la URL temporal de descarga desde Graph API
  const metaRes = await fetchFn(`https://graph.facebook.com/${apiVersion}/${encodeURIComponent(mediaId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    signal: AbortSignal.timeout(15000)
  });

  const metaData = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok || !metaData.url) {
    const errMsg = metaData.error?.message || `HTTP ${metaRes.status}`;
    throw new Error(`Error obteniendo URL de media en Meta Graph API: ${errMsg}`);
  }

  // 2. Descargar el binario real desde la URL temporal de Meta
  const binRes = await fetchFn(metaData.url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!binRes.ok) {
    throw new Error(`Error descargando binario multimedia de Meta (HTTP ${binRes.status})`);
  }

  const arrayBuf = await binRes.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Sube un Buffer (PDF, CSV, imagen) a Meta Graph API `/media` y devuelve su `media_id`.
 *
 * @param {Buffer} buffer
 * @param {object} options
 * @param {string} options.mimetype
 * @param {string} options.fileName
 * @param {string} options.phoneNumberId
 * @param {string} options.accessToken
 * @param {string} [options.apiVersion='v21.0']
 * @param {Function} [options.fetchImpl=fetch]
 * @returns {Promise<string>} mediaId
 */
export async function uploadCloudMedia(buffer, options = {}) {
  const phoneNumberId = options.phoneNumberId || process.env.META_PHONE_NUMBER_ID || '';
  const accessToken = options.accessToken || process.env.META_ACCESS_TOKEN || '';
  const apiVersion = options.apiVersion || process.env.META_GRAPH_API_VERSION || 'v21.0';
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const mimetype = options.mimetype || 'application/pdf';
  const fileName = options.fileName || 'documento.pdf';

  if (!phoneNumberId || !accessToken) {
    throw new Error('Faltan META_PHONE_NUMBER_ID o META_ACCESS_TOKEN para subir documentos a WhatsApp Cloud API.');
  }

  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('type', mimetype);
  const blob = new Blob([buffer], { type: mimetype });
  formData.append('file', blob, fileName);

  const res = await fetchFn(`https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneNumberId)}/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    body: formData,
    signal: AbortSignal.timeout(30000)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const errMsg = data.error?.message || `HTTP ${res.status}`;
    throw new Error(`Error subiendo documento a Meta Graph API: ${errMsg}`);
  }

  return data.id;
}

function verifyPayloadProof(signedPayload, payloadProof, signingSecret) {
  if (!signedPayload || !payloadProof || !signingSecret || signingSecret.length < 32) return false;
  const expectedProof = createHmac('sha256', signingSecret).update(String(signedPayload)).digest('base64url');
  const expectedBuffer = Buffer.from(expectedProof);
  const receivedBuffer = Buffer.from(String(payloadProof));
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}


function normalizeCompactBudgetForPdf(raw) {
  if (!raw) return null;
  const items = (raw.t || raw.items || []).map((it, idx) => {
    if (Array.isArray(it)) {
      const desc = it[0] || '';
      const qty = typeof it[1] === 'number' ? it[1] : 1;
      const unit = typeof it[2] === 'string' ? it[2] : 'pa';
      const unitPrice = Number(typeof it[2] === 'string' ? (it[3] || 0) : (it[2] || 0));
      const total = Number(typeof it[2] === 'string' ? (it[4] ?? qty * unitPrice) : (it[3] ?? qty * unitPrice));
      return { id: idx + 1, description: desc, qty, unit, unitPrice, total, isPricePending: unitPrice === 0 && total === 0 };
    }
    const desc = it.d || it.description || '';
    const qty = Number(it.q ?? it.qty ?? 1);
    const unit = it.u || it.unit || 'pa';
    const unitPrice = Number(it.p ?? it.unitPrice ?? 0);
    const total = Number(it.t ?? it.total ?? (qty * unitPrice));
    return { id: idx + 1, description: desc, qty, unit, unitPrice, total, isPricePending: Boolean(it.pen || it.isPricePending) };
  });
  return {
    id: String(raw.i || raw.id || 'PRE-2026'),
    company: {
      id: String(raw.c?.id || raw.company?.id || ''),
      name: String(raw.c?.n || raw.company?.name || 'Empresa Instaladora'),
      cif: String(raw.c?.c || raw.c?.f || raw.company?.cif || ''),
      address: String(raw.c?.a || raw.company?.address || ''),
      phone: String(raw.c?.p || raw.company?.phone || ''),
      email: String(raw.c?.e || raw.company?.email || '')
    },
    client: {
      name: String(raw.k?.n || raw.client?.name || 'Cliente Particular'),
      address: String(raw.k?.a || raw.client?.address || 'Ubicación según visita'),
      phone: String(raw.k?.p || raw.client?.phone || ''),
      email: String(raw.k?.e || raw.client?.email || '')
    },
    items,
    financials: {
      subtotal: Number(raw.f?.b ?? raw.financials?.subtotal ?? 0),
      taxableBase: Number(raw.f?.b ?? raw.financials?.taxableBase ?? 0),
      taxRatePercentage: Number(raw.f?.r ?? raw.financials?.taxRatePercentage ?? 10),
      taxAmount: Number(raw.f?.a ?? raw.f?.x ?? raw.financials?.taxAmount ?? 0),
      totalAmount: Number(raw.f?.t ?? raw.financials?.totalAmount ?? 0),
      advancePercentage: Number(raw.f?.ap ?? raw.financials?.advancePercentage ?? 30),
      advanceAmount: Number(raw.f?.aa ?? raw.financials?.advanceAmount ?? 0),
      discountPercentage: Number(raw.f?.dp ?? raw.financials?.discountPercentage ?? 0),
      discountAmount: Number(raw.f?.da ?? raw.financials?.discountAmount ?? 0)
    },
    terms: raw.terms || { validityDays: 15, conditions: 'Condiciones según presupuesto.' }
  };
}

function generateSignedBudgetPdfLocal(budget, signaturePro, signatureClient, signedAt) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Contrato ${budget.id || 'PresuVoz'}`,
          Author: budget.company?.name || 'PresuVoz',
          Subject: 'Contrato de obra firmado'
        }
      });
      const bufs = [];
      doc.on('data', c => bufs.push(c));
      doc.on('end', () => resolve(Buffer.concat(bufs)));
      doc.on('error', e => reject(e));

      const primary = '#059669';
      const dark = '#0f172a';
      const gray = '#64748b';
      const border = '#e2e8f0';

      doc.rect(0, 0, 595.28, 8).fill(primary);
      doc.fontSize(16).fillColor(dark).font('Helvetica-Bold').text(budget.company?.name || 'PresuVoz Reformas', 40, 30);
      doc.fontSize(8).fillColor(gray).font('Helvetica')
        .text(`CIF: ${budget.company?.cif || 'Sin indicar'}`, 40, 50)
        .text(budget.company?.address || 'Dirección no indicada', 40, 62)
        .text(`${budget.company?.phone || ''}${budget.company?.email ? ` | ${budget.company.email}` : ''}`, 40, 74);

      doc.roundedRect(350, 25, 205, 65, 4).strokeColor(border).stroke();
      doc.fontSize(7).fillColor(primary).font('Helvetica-Bold').text('ACEPTACIÓN ELECTRÓNICA', 360, 33);
      doc.fontSize(12).fillColor(dark).font('Helvetica-Bold').text(budget.id || 'PRE-2026', 360, 45);
      doc.fontSize(7).fillColor(gray).font('Helvetica')
        .text(`Fecha: ${new Date().toLocaleDateString('es-ES')}`, 360, 62)
        .text(`Firmado: ${signedAt}`, 360, 73);

      const clientY = 105;
      doc.roundedRect(40, clientY, 515, 55, 4).fillColor('#f8fafc').fillAndStroke('#f8fafc', border);
      doc.fontSize(8).fillColor(primary).font('Helvetica-Bold').text('DATOS DEL CLIENTE Y UBICACIÓN DE OBRA', 50, clientY + 8);
      doc.fontSize(9).fillColor(dark).font('Helvetica-Bold').text(`Cliente: ${budget.client?.name || 'Cliente Particular'}`, 50, clientY + 22);
      doc.fontSize(8).fillColor(gray).font('Helvetica').text(`Dirección de obra: ${budget.client?.address || 'Ubicación según visita'}`, 50, clientY + 36);

      let tableY = 175;
      doc.rect(40, tableY, 515, 20).fill(dark);
      doc.fontSize(8).fillColor('#fff').font('Helvetica-Bold')
        .text('#', 48, tableY + 6, { width: 20 })
        .text('DESCRIPCIÓN DE LOS TRABAJOS', 75, tableY + 6, { width: 285 })
        .text('CANT.', 365, tableY + 6, { width: 50, align: 'right' })
        .text('PRECIO UD.', 420, tableY + 6, { width: 60, align: 'right' })
        .text('TOTAL', 485, tableY + 6, { width: 60, align: 'right' });
      tableY += 20;

      (budget.items || []).forEach((item, idx) => {
        const pending = item.isPricePending || item.total === 0;
        const totalText = pending ? 'A valorar' : `${(item.total || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`;
        const priceText = pending ? '-' : `${(item.unitPrice || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`;
        if (idx % 2 === 1) doc.rect(40, tableY, 515, 24).fill('#f8fafc');
        doc.fontSize(8).fillColor(gray).font('Helvetica').text(String(idx + 1), 48, tableY + 6, { width: 20 });
        doc.fontSize(8).fillColor(dark).font('Helvetica').text(item.description || '', 75, tableY + 6, { width: 285 });
        doc.fontSize(8).fillColor(gray).font('Helvetica')
          .text(`${item.qty || 1} ${item.unit || 'pa'}`, 365, tableY + 6, { width: 50, align: 'right' })
          .text(priceText, 420, tableY + 6, { width: 60, align: 'right' });
        doc.fontSize(8).fillColor(pending ? '#b45309' : dark).font(pending ? 'Helvetica-Oblique' : 'Helvetica-Bold')
          .text(totalText, 485, tableY + 6, { width: 60, align: 'right' });
        doc.moveTo(40, tableY + 24).lineTo(555, tableY + 24).strokeColor('#f1f5f9').stroke();
        tableY += 24;
      });

      tableY += 15;
      const fin = budget.financials || {};
      const totalsX = 350;
      doc.fontSize(8).fillColor(gray).font('Helvetica');
      doc.text('Base Imponible:', totalsX, tableY).text(`${(fin.taxableBase || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
      tableY += 14;
      doc.text(`IVA (${fin.taxRatePercentage ?? 10}%):`, totalsX, tableY).text(`${(fin.taxAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
      tableY += 16;
      doc.rect(totalsX - 10, tableY - 4, 215, 26).fill(primary);
      doc.fontSize(9).fillColor('#fff').font('Helvetica-Bold')
        .text('TOTAL PRESUPUESTO:', totalsX, tableY + 4)
        .text(`${(fin.totalAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 475, tableY + 4, { width: 70, align: 'right' });

      const signY = 700;
      doc.rect(40, signY, 240, 70).strokeColor(border).stroke();
      doc.fontSize(7.5).fillColor(gray).font('Helvetica')
        .text('POR LA EMPRESA INSTALADORA', 50, signY + 8)
        .text('Firma y Sello:', 50, signY + 55);

      doc.rect(315, signY, 240, 70).strokeColor(border).stroke();
      doc.fontSize(7.5).fillColor(gray).font('Helvetica').text('CONFORME DEL CLIENTE', 325, signY + 8);

      const embedSig = (b64, x, y, w, h) => {
        if (!b64 || !b64.startsWith('data:image')) return false;
        const imgBuf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imgBuf, x, y, { fit: [w, h], align: 'center', valign: 'center' });
        return true;
      };

      if (!embedSig(signaturePro, 50, signY + 18, 210, 35)) {
        doc.fontSize(7).fillColor(primary).font('Helvetica-Bold').text('EMITIDO POR LA EMPRESA', 50, signY + 22, { width: 220, align: 'center' });
        doc.fontSize(6.5).fillColor(gray).font('Helvetica').text(`Por ${budget.company?.name || 'la empresa instaladora'}`, 50, signY + 34, { width: 220, align: 'center' });
      }
      if (!embedSig(signatureClient, 325, signY + 18, 210, 35)) {
        doc.fontSize(7).fillColor(primary).font('Helvetica-Bold').text('ACEPTACIÓN REGISTRADA', 325, signY + 25, { width: 220, align: 'center' });
      }

      doc.fontSize(6.5).fillColor('#94a3b8').font('Helvetica')
        .text(`Aceptación electrónica registrada el ${signedAt} | Ref: ${budget.id || 'PV'}`, 40, 785, { align: 'center', width: 515 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function sendSignedBudgetEmailLocal({ verifiedBudget, signaturePro, signatureClient, clientEmail, signedAt }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || process.env.NODE_ENV === 'test') {
    return { emailSent: false, emailId: null, emailError: null };
  }
  try {
    const budget = normalizeCompactBudgetForPdf(verifiedBudget);
    const pdfBuffer = await generateSignedBudgetPdfLocal(budget, signaturePro, signatureClient, signedAt);
    const resend = new Resend(apiKey);
    const recipients = [String(clientEmail).trim()];
    if (budget.company?.email && /^[^\s@<>]{1,100}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i.test(budget.company.email) && !recipients.includes(budget.company.email)) {
      recipients.push(budget.company.email);
    }
    const total = (budget.financials?.totalAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 });
    const emailResult = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'PresuVoz <onboarding@resend.dev>',
      to: recipients,
      subject: `Presupuesto Firmado ${budget.id} — ${budget.company?.name || 'PresuVoz'}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:24px auto;padding:24px;border:1px solid #d1fae5;border-radius:16px;background:#ffffff;">
        <h2 style="color:#059669;margin-top:0;">✅ Presupuesto Aceptado (${budget.id})</h2>
        <p>Estimado/a <strong>${budget.client?.name || 'Cliente'}</strong>,</p>
        <p>Adjuntamos copia en PDF del presupuesto <strong>${budget.id}</strong> (importe total: <strong>${total} €</strong>) con la firma electrónica registrada el ${signedAt}.</p>
        <p style="font-size:12px;color:#6b7280;margin-top:24px;">Empresa emisora: ${budget.company?.name || 'PresuVoz'}</p>
      </div>`,
      attachments: [
        {
          filename: `Contrato_${budget.id}.pdf`,
          content: pdfBuffer.toString('base64')
        }
      ]
    });
    if (emailResult?.error) {
      return { emailSent: false, emailId: null, emailError: emailResult.error.message || 'Error enviando email' };
    }
    return { emailSent: Boolean(emailResult?.data?.id), emailId: emailResult?.data?.id || null, emailError: null };
  } catch (err) {
    console.warn('⚠️ [Sign API Local] No se pudo enviar copia por email (Resend):', err.message);
    return { emailSent: false, emailId: null, emailError: err.message };
  }
}

function inflateSignedBudget(signedPayload) {
  const compressed = Buffer.from(String(signedPayload), 'base64url');
  const jsonText = zlib.inflateRawSync(compressed).toString('utf-8');
  return JSON.parse(jsonText);
}

function readRequestBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Crea el servidor HTTP unificado de PresuVoz que gestiona:
 * 1. `GET /webhook` y `POST /webhook` (Meta WhatsApp Cloud API)
 * 2. `GET /f/:code` (Enlaces cortos de firma digital alojados en el propio dominio)
 * 3. `GET /api/sign` y `POST /api/sign` (Verificación y registro directo de firmas en SQLite)
 * 4. `GET /health` (Comprobación de salud del servidor)
 */
export function createPresuVozHttpServer(options = {}) {
  const verifyToken = options.verifyToken ?? process.env.META_WEBHOOK_VERIFY_TOKEN ?? '';
  const appSecret = options.appSecret ?? process.env.META_APP_SECRET ?? '';
  const signingSecret = options.signingSecret ?? process.env.PRESUVOZ_SIGNING_SECRET ?? '';
  const onIncomingMessages = options.onIncomingMessages || null;
  const onBudgetSigned = options.onBudgetSigned || null;
  const firmarHtmlPath = options.firmarHtmlPath || path.resolve('studio', 'firmar.html');

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || 'localhost';
      const parsedUrl = new URL(req.url || '/', `http://${host}`);
      const pathname = parsedUrl.pathname;

      // CORS para /api/sign
      if (pathname === '/api/sign') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }
      }

      // 1b. Visual QR Code for WhatsApp linking
      if ((pathname === '/' || pathname === '/qr' || pathname === '/login') && req.method === 'GET') {
        const qrString = globalThis.__PRESUVOZ_LATEST_QR__;
        const isConnected = Boolean(globalThis.__PRESUVOZ_WHATSAPP_CONNECTED__);
        if (!qrString || isConnected) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>PresuVoz WhatsApp</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0b0f19;color:#f1f5f9;text-align:center;padding:20px;box-sizing:border-box;}.card{background:#1e293b;padding:36px;border-radius:20px;box-shadow:0 20px 40px rgba(0,0,0,0.5);border:1px solid #334155;max-width:420px;width:100%;}h1{font-size:22px;margin:0 0 12px;color:#10b981;}p{color:#94a3b8;font-size:14px;margin:0 0 16px;line-height:1.5;}</style></head><body><div class="card"><h1>' + (isConnected ? '✅ WhatsApp Vinculado con Éxito' : '⏳ Esperando Código QR...') + '</h1><p>' + (isConnected ? 'El bot de PresuVoz está conectado y listo para procesar audios y presupuestos.' : 'Generando código de vinculación. Esta página se actualizará automáticamente.') + '</p>' + (isConnected ? '' : '<script>setTimeout(() => location.reload(), 2500);</script>') + '</div></body></html>');
          return;
        }
        const svg = renderQrSvg(qrString);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="refresh" content="20"><title>Vincular WhatsApp - PresuVoz</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0b0f19;color:#f1f5f9;text-align:center;padding:20px;box-sizing:border-box;}.card{background:#1e293b;padding:32px;border-radius:20px;box-shadow:0 20px 40px rgba(0,0,0,0.5);border:1px solid #334155;max-width:420px;width:100%;}h1{font-size:22px;margin:0 0 8px;color:#38bdf8;}p{color:#94a3b8;font-size:14px;margin:0 0 20px;line-height:1.5;}.qr-container{background:#ffffff;padding:16px;border-radius:12px;display:inline-block;margin-bottom:20px;box-shadow:0 8px 24px rgba(0,0,0,0.3);}ol{text-align:left;color:#cbd5e1;font-size:13px;line-height:1.8;margin:0 auto;padding-left:20px;}.badge{display:inline-block;background:rgba(56,189,248,0.1);color:#38bdf8;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:16px;}</style></head><body><div class="card"><div class="badge">PresuVoz WhatsApp Gateway</div><h1>Vincula tu WhatsApp Business</h1><p>Escanea este código con la cámara de WhatsApp desde tu móvil</p><div class="qr-container">' + svg + '</div><ol><li>Abre <b>WhatsApp Business</b> en tu móvil</li><li>Toca en <b>Ajustes</b> &gt; <b>Dispositivos vinculados</b></li><li>Toca en <b>Vincular un dispositivo</b> y enfoca este código</li></ol></div></body></html>');
        return;
      }

      // 1. Healthcheck
      if (pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, service: 'presuvoz-gateway', timestamp: new Date().toISOString() }));
        return;
      }

      // 2. Meta Webhook Verification (GET /webhook)
      if (pathname === '/webhook' && req.method === 'GET') {
        const mode = parsedUrl.searchParams.get('hub.mode');
        const token = parsedUrl.searchParams.get('hub.verify_token') || '';
        const challenge = parsedUrl.searchParams.get('hub.challenge') || '';

        let tokenMatches = false;
        if (verifyToken && token) {
          const expectedBuf = Buffer.from(String(verifyToken), 'utf-8');
          const receivedBuf = Buffer.from(String(token), 'utf-8');
          if (expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf)) {
            tokenMatches = true;
          }
        }

        if (mode === 'subscribe' && tokenMatches) {
          console.log('✅ [Meta Webhook] Verificación hub.challenge superada con éxito.');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(challenge);
          return;
        }

        console.warn('🛑 [Meta Webhook] Fallo en verificación GET /webhook (token inválido o modo incorrecto).');
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Webhook verification failed' }));
        return;
      }

      // 3. Meta Incoming Messages Webhook (POST /webhook)
      if (pathname === '/webhook' && req.method === 'POST') {
        const rawBody = await readRequestBody(req);
        const sigHeader = req.headers['x-hub-signature-256'];

        // Si META_APP_SECRET está configurado (o estamos en producción), exigir firma HMAC válida
        const requireSignature = Boolean(appSecret) || process.env.NODE_ENV === 'production';
        if (requireSignature) {
          if (!verifyWebhookSignature(rawBody, sigHeader, appSecret)) {
            console.warn('🛑 [Meta Webhook] Firma X-Hub-Signature-256 inválida o ausente. Petición rechazada.');
            res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid X-Hub-Signature-256' }));
            return;
          }
        }

        let payload;
        try {
          payload = JSON.parse(rawBody.toString('utf-8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
          return;
        }

        // Responder 200 OK inmediatamente a Meta para evitar reintentos por timeout
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'EVENT_RECEIVED' }));

        const baileysMessages = parseCloudWebhookToBaileysMessages(payload);
        if (baileysMessages.length > 0 && typeof onIncomingMessages === 'function') {
          try {
            await onIncomingMessages(baileysMessages);
          } catch (err) {
            console.error('❌ [Meta Webhook] Error procesando mensajes entrantes:', err.message);
          }
        }
        return;
      }

      // 4. Enlace Corto de Firma Digital (GET /f/:code)
      const shortMatch = pathname.match(/^\/f\/([a-zA-Z0-9_-]{4,32})$/);
      if (shortMatch && req.method === 'GET') {
        const code = shortMatch[1];
        const entry = getShortSigningLink(code);
        if (!entry || !entry.z || !entry.s) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enlace no encontrado — PresuVoz</title></head><body style="font-family:sans-serif;text-align:center;padding:48px 20px;color:#1f2937;"><h2>⚠️ Enlace de presupuesto no encontrado o caducado</h2><p>Pide al profesional que te reenvíe el presupuesto actualizado por WhatsApp.</p></body></html>`);
          return;
        }

        if (!fs.existsSync(firmarHtmlPath)) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Plantilla de firma no disponible.');
          return;
        }

        const rawHtml = fs.readFileSync(firmarHtmlPath, 'utf-8');
        const preloadPayload = JSON.stringify({
          z: entry.z,
          s: entry.s,
          signEndpoint: '/api/sign',
          shortCode: entry.code
        }).replace(/</g, '\\u003c');

        const preloadScript = `<script>window.__PRESUVOZ_PRELOAD__ = ${preloadPayload};</script>\n</head>`;
        const injectedHtml = rawHtml.includes('</head>')
          ? rawHtml.replace('</head>', preloadScript)
          : `<script>window.__PRESUVOZ_PRELOAD__ = ${preloadPayload};</script>\n` + rawHtml;

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0'
        });
        res.end(injectedHtml);
        return;
      }

      // 4b. Portal directo de firma (GET /studio/firmar.html o GET /firmar.html) alojado en el propio servidor (Railway/Node) sin depender de Vercel
      if ((pathname === '/studio/firmar.html' || pathname === '/firmar.html') && req.method === 'GET') {
        if (!fs.existsSync(firmarHtmlPath)) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Plantilla de firma no disponible.');
          return;
        }

        const rawHtml = fs.readFileSync(firmarHtmlPath, 'utf-8');
        const zParam = parsedUrl.searchParams.get('z') || '';
        const sParam = parsedUrl.searchParams.get('s') || '';
        const preloadPayload = JSON.stringify({
          ...(zParam ? { z: zParam } : {}),
          ...(sParam ? { s: sParam } : {}),
          signEndpoint: '/api/sign'
        }).replace(/</g, '\\u003c');

        const preloadScript = `<script>window.__PRESUVOZ_PRELOAD__ = ${preloadPayload};</script>\n</head>`;
        const injectedHtml = rawHtml.includes('</head>')
          ? rawHtml.replace('</head>', preloadScript)
          : `<script>window.__PRESUVOZ_PRELOAD__ = ${preloadPayload};</script>\n` + rawHtml;

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0'
        });
        res.end(injectedHtml);
        return;
      }

      // 5. API de Firma Digital Local (GET /api/sign?check=... & POST /api/sign)
      if (pathname === '/api/sign' && req.method === 'GET') {
        const checkId = parsedUrl.searchParams.get('check') || parsedUrl.searchParams.get('id');
        const companyId = parsedUrl.searchParams.get('companyId') || null;
        if (!checkId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Falta parámetro check' }));
          return;
        }
        const record = getLocalSignedBudget(checkId, companyId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          budgetId: checkId,
          alreadySigned: Boolean(record && record.signed),
          details: record || null
        }));
        return;
      }

      if (pathname === '/api/sign' && req.method === 'POST') {
        const activeSecret = signingSecret || process.env.PRESUVOZ_SIGNING_SECRET || '';
        if (!activeSecret || activeSecret.length < 32) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'La firma electrónica no está configurada en el servidor.' }));
          return;
        }

        const rawBody = await readRequestBody(req);
        let body;
        try {
          body = JSON.parse(rawBody.toString('utf-8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
          return;
        }

        const {
          signedPayload,
          payloadProof,
          proof,
          clientName,
          clientNif,
          clientAddress,
          clientEmail,
          signatureDataUrl,
          signatureClient,
          signedAt
        } = body || {};

        const activeProof = payloadProof || proof;
        const activeSignature = signatureDataUrl || signatureClient;

        if (!verifyPayloadProof(signedPayload, activeProof, activeSecret)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'El enlace de firma no es válido o ha sido modificado.' }));
          return;
        }

        let verifiedBudget;
        try {
          verifiedBudget = inflateSignedBudget(signedPayload);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'No se pudo leer el presupuesto firmado.' }));
          return;
        }

        const budgetId = String(verifiedBudget?.i || verifiedBudget?.id || '').trim();
        const companyId = String(verifiedBudget?.c?.id || verifiedBudget?.company?.id || '').trim() || null;
        const companyName = String(verifiedBudget?.c?.n || verifiedBudget?.company?.name || '').trim();
        const companyEmail = String(verifiedBudget?.c?.e || verifiedBudget?.company?.email || '').trim();
        const companyPhone = String(verifiedBudget?.c?.p || verifiedBudget?.company?.phone || '').replace(/\D/g, '');
        const resolvedClientName = String(clientName || verifiedBudget?.k?.n || verifiedBudget?.client?.name || 'Cliente Particular').trim();
        const resolvedClientAddress = String(clientAddress || verifiedBudget?.k?.a || verifiedBudget?.client?.address || 'Ubicación según visita').trim();
        const totalFormatted = `${Number(verifiedBudget?.f?.t ?? verifiedBudget?.financials?.totalAmount ?? 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (
          !budgetId ||
          !resolvedClientName || resolvedClientName.length < 2 ||
          (clientNif !== undefined && String(clientNif).trim().length > 0 && String(clientNif).trim().length < 5) ||
          !resolvedClientAddress || resolvedClientAddress.length < 2 ||
          !clientEmail || !emailRegex.test(String(clientEmail).trim()) ||
          typeof activeSignature !== 'string' ||
          !activeSignature.startsWith('data:image/png;base64,')
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Datos obligatorios de firma incompletos o inválidos.' }));
          return;
        }

        const existingRecord = getLocalSignedBudget(budgetId, companyId);
        if (existingRecord && existingRecord.signed) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            alreadySigned: true,
            signedAt: existingRecord.signedAt,
            details: existingRecord,
            message: 'Este presupuesto ya constaba como firmado y aceptado.'
          }));
          return;
        }

        const timestamp = signedAt || new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
        const savedRecord = saveLocalSignedBudget(budgetId, {
          budgetId,
          ...(companyId ? { companyId } : {}),
          clientName: resolvedClientName,
          clientNif: clientNif ? String(clientNif).trim() : '',
          clientAddress: resolvedClientAddress,
          clientEmail: String(clientEmail).trim(),
          companyName,
          companyPhone,
          totalFormatted,
          signedAt: timestamp
        }, companyId);

        if (typeof onBudgetSigned === 'function') {
          try {
            await onBudgetSigned(savedRecord);
          } catch (cbErr) {
            console.warn('⚠️ [Sign API] Aviso ejecutando callback onBudgetSigned:', cbErr.message);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          signedAt: timestamp,
          details: savedRecord
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (err) {
      if (err.message === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
        return;
      }
      console.error('❌ [PresuVoz HTTP Server] Error interno:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
      }
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.warn('ℹ️ [HTTP] Puerto ya en uso en el host. Continuando con la instancia activa.');
      return;
    }
    console.error('❌ [HTTP Server Error]:', err.message);
  });

  return server;
}

/**
 * Crea un socket compatible con la interfaz de Baileys (`sock.ev`, `sock.sendMessage`, `sock.sendPresenceUpdate`)
 * respaldado por la API Oficial de WhatsApp Business de Meta (Cloud API) y el servidor HTTP integrado.
 *
 * @param {object} [options]
 * @param {string} [options.phoneNumberId] - `META_PHONE_NUMBER_ID`
 * @param {string} [options.accessToken] - `META_ACCESS_TOKEN`
 * @param {string} [options.verifyToken] - `META_WEBHOOK_VERIFY_TOKEN`
 * @param {string} [options.appSecret] - `META_APP_SECRET`
 * @param {string} [options.displayPhoneNumber] - `META_DISPLAY_PHONE_NUMBER` (ej. '34600112233')
 * @param {string} [options.apiVersion='v21.0'] - `META_GRAPH_API_VERSION`
 * @param {number} [options.port] - Puerto HTTP para el webhook y enlaces cortos
 * @param {Function} [options.fetchImpl] - Implementación de fetch (inyectable para tests)
 * @param {Function} [options.onBudgetSigned] - Callback al firmarse un presupuesto en `/api/sign`
 */
export function createCloudApiSocket(options = {}) {
  const ev = new EventEmitter();
  const phoneNumberId = options.phoneNumberId ?? process.env.META_PHONE_NUMBER_ID ?? '';
  const accessToken = options.accessToken ?? process.env.META_ACCESS_TOKEN ?? '';
  const apiVersion = options.apiVersion ?? process.env.META_GRAPH_API_VERSION ?? 'v21.0';
  const displayPhone = String(options.displayPhoneNumber ?? process.env.META_DISPLAY_PHONE_NUMBER ?? '').replace(/\D/g, '');
  const fetchFn = options.fetchImpl || globalThis.fetch;

  let httpServer = null;

  const sock = {
    isCloudApi: true,
    ev,
    user: {
      id: displayPhone ? `${displayPhone}@s.whatsapp.net` : 'cloud_api@s.whatsapp.net',
      lid: ''
    },
    signalRepository: {
      lidMapping: {
        getPNForLID: async () => null
      }
    },
    updateMediaMessage: async () => {},
    sendPresenceUpdate: async (_type, _toJid) => {
      // En Cloud API la presencia ('composing' / 'paused') es opcional y no requiere mantener socket WS
      return;
    },
    downloadMedia: async (mediaId) => {
      return downloadCloudMedia(mediaId, {
        accessToken,
        apiVersion,
        fetchImpl: fetchFn
      });
    },
    sendMessage: async (jid, content = {}) => {
      const to = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
      if (!to) {
        throw new Error(`Destinatario JID inválido para Cloud API: ${jid}`);
      }
      if (!phoneNumberId || !accessToken) {
        throw new Error('Faltan META_PHONE_NUMBER_ID o META_ACCESS_TOKEN para enviar mensajes por WhatsApp Cloud API.');
      }

      const messagesUrl = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
      let requestPayload = null;

      if (content.document) {
        const mediaId = await uploadCloudMedia(content.document, {
          mimetype: content.mimetype || 'application/pdf',
          fileName: content.fileName || 'Documento_PresuVoz.pdf',
          phoneNumberId,
          accessToken,
          apiVersion,
          fetchImpl: fetchFn
        });

        requestPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'document',
          document: {
            id: mediaId,
            filename: content.fileName || 'Documento_PresuVoz.pdf',
            ...(content.caption ? { caption: String(content.caption) } : {})
          }
        };
      } else if (content.image) {
        const mediaId = await uploadCloudMedia(content.image, {
          mimetype: content.mimetype || 'image/png',
          fileName: content.fileName || 'imagen.png',
          phoneNumberId,
          accessToken,
          apiVersion,
          fetchImpl: fetchFn
        });

        requestPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'image',
          image: {
            id: mediaId,
            ...(content.caption ? { caption: String(content.caption) } : {})
          }
        };
      } else if (content.template) {
        requestPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'template',
          template: content.template
        };
      } else if (typeof content.text === 'string') {
        requestPayload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: {
            preview_url: true,
            body: content.text
          }
        };
      } else {
        throw new Error(`Tipo de contenido no soportado en Cloud API sendMessage: ${Object.keys(content).join(', ')}`);
      }

      const res = await fetchFn(messagesUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(20000)
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg = data.error?.message || `HTTP ${res.status}`;
        throw new Error(`Error enviando mensaje por Meta Cloud API: ${errMsg}`);
      }

      const wamId = data.messages?.[0]?.id || `wamid_out_${Date.now()}`;
      return {
        key: {
          remoteJid: jid,
          fromMe: true,
          id: wamId
        },
        message: content,
        status: 'SENT'
      };
    },
    startServer: (listenPort = options.port ?? Number(process.env.WEBHOOK_PORT || process.env.PORT || 3000), listenHost = options.host || '0.0.0.0') => {
      return new Promise((resolve, reject) => {
        httpServer = createPresuVozHttpServer({
          ...options,
          onIncomingMessages: async (messages) => {
            ev.emit('messages.upsert', {
              messages,
              type: 'notify'
            });
          }
        });

        httpServer.once('error', reject);
        httpServer.listen(listenPort, listenHost, () => {
          const addr = httpServer.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
          console.log(`🌐 [Cloud API & Enlaces Cortos] Servidor HTTP activo en http://${listenHost}:${actualPort}`);
          ev.emit('connection.update', { connection: 'open' });
          resolve({ port: actualPort, server: httpServer });
        });
      });
    },
    end: () => {
      if (httpServer) {
        try {
          httpServer.close();
        } catch {}
        httpServer = null;
      }
    }
  };

  return sock;
}
