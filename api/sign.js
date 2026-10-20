/**
 * PresuVoz — api/sign.js
 * Endpoint Vercel: recibe el presupuesto + firmas → sella el PDF → envía email al cliente
 */

import PDFDocument from 'pdfkit';
import { Resend }  from 'resend';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// ─── Generar PDF con firmas estampadas ──────────────────────────────────────
function generateSignedPDF(budget, signaturePro, signatureClient, signedAt) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40,
        info: { Title: `Contrato ${budget.id || 'PresuVoz'}`, Author: budget.company?.name || 'PresuVoz', Subject: 'Contrato de obra firmado' }
      });

      const bufs = [];
      doc.on('data', c => bufs.push(c));
      doc.on('end',  ()  => resolve(Buffer.concat(bufs)));
      doc.on('error', e  => reject(e));

      const primary = '#059669';
      const dark    = '#0f172a';
      const gray    = '#64748b';
      const border  = '#e2e8f0';

      // Barra superior
      doc.rect(0, 0, 595.28, 8).fill(primary);

      // Cabecera empresa
      doc.fontSize(16).fillColor(dark).font('Helvetica-Bold')
        .text(budget.company?.name || 'PresuVoz Reformas S.L.', 40, 30);
      doc.fontSize(8).fillColor(gray).font('Helvetica')
        .text(`CIF: ${budget.company?.cif || 'Sin indicar'}`, 40, 50)
        .text(budget.company?.address || 'Dirección no indicada', 40, 62)
        .text(`${budget.company?.phone || ''}${budget.company?.email ? ` | ${budget.company.email}` : ''}`, 40, 74);

      // Caja documento — estado CONTRATO ACEPTADO
      doc.roundedRect(350, 25, 205, 65, 4).strokeColor(border).stroke();
      doc.fontSize(7).fillColor(primary).font('Helvetica-Bold')
        .text('ACEPTACIÓN ELECTRÓNICA', 360, 33);
      doc.fontSize(12).fillColor(dark).font('Helvetica-Bold')
        .text(budget.id || 'PV-2026-001', 360, 45);
      doc.fontSize(7).fillColor(gray).font('Helvetica')
        .text(`Fecha: ${new Date().toLocaleDateString('es-ES')}`, 360, 62)
        .text(`Firmado: ${new Date(signedAt).toLocaleString('es-ES')}`, 360, 73);

      // Bloque cliente
      const clientY = 105;
      doc.roundedRect(40, clientY, 515, 55, 4).fillColor('#f8fafc').fillAndStroke('#f8fafc', border);
      doc.fontSize(8).fillColor(primary).font('Helvetica-Bold')
        .text('DATOS DEL CLIENTE Y UBICACIÓN DE OBRA', 50, clientY + 8);
      doc.fontSize(9).fillColor(dark).font('Helvetica-Bold')
        .text(`Cliente: ${budget.client?.name || 'Cliente Particular'}`, 50, clientY + 22);
      doc.fontSize(8).fillColor(gray).font('Helvetica')
        .text(`Dirección de obra: ${budget.client?.address || 'Ubicación según visita'}`, 50, clientY + 36);

      // Tabla de partidas
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
        const pending    = item.isPricePending || item.total === 0;
        const totalText  = pending ? 'A valorar' : `${(item.total||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`;
        const priceText  = pending ? '-'          : `${(item.unitPrice||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`;
        if (idx % 2 === 1) doc.rect(40, tableY, 515, 24).fill('#f8fafc');
        doc.fontSize(8).fillColor(gray).font('Helvetica').text(String(idx+1), 48, tableY+6, {width:20});
        doc.fontSize(8).fillColor(dark).font('Helvetica').text(item.description, 75, tableY+6, {width:285});
        doc.fontSize(8).fillColor(gray).font('Helvetica')
          .text(`${item.qty||1} ${item.unit||'pa'}`, 365, tableY+6, {width:50,align:'right'})
          .text(priceText, 420, tableY+6, {width:60,align:'right'});
        doc.fontSize(8).fillColor(pending?'#b45309':dark).font(pending?'Helvetica-Oblique':'Helvetica-Bold')
          .text(totalText, 485, tableY+6, {width:60,align:'right'});
        doc.moveTo(40,tableY+24).lineTo(555,tableY+24).strokeColor('#f1f5f9').stroke();
        tableY += 24;
      });

      // Totales
      tableY += 15;
      const fin = budget.financials || {};
      const totalsX = 350;
      doc.fontSize(8).fillColor(gray).font('Helvetica');
      if ((fin.discountAmount||0) > 0) {
        doc.text('Subtotal:', totalsX, tableY).text(`${(fin.subtotal||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 485, tableY, {width:60,align:'right'}); tableY+=14;
        doc.text(`Descuento (${fin.discountPercentage}%):`, totalsX, tableY).text(`-${(fin.discountAmount||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 485, tableY, {width:60,align:'right'}); tableY+=14;
      }
      doc.text('Base Imponible:', totalsX, tableY).text(`${(fin.taxableBase||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 485, tableY, {width:60,align:'right'}); tableY+=14;
      doc.text(`IVA (${fin.taxRatePercentage ?? 21}%):`, totalsX, tableY).text(`${(fin.taxAmount||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 485, tableY, {width:60,align:'right'}); tableY+=16;
      doc.rect(totalsX-10, tableY-4, 215, 26).fill(primary);
      doc.fontSize(9).fillColor('#fff').font('Helvetica-Bold')
        .text('TOTAL PRESUPUESTO:', totalsX, tableY+4)
        .text(`${(fin.totalAmount||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 475, tableY+4, {width:70,align:'right'});

      // Condiciones de pago
      const termsY = tableY - 40;
      doc.fontSize(8).fillColor(dark).font('Helvetica-Bold').text('CONDICIONES GENERALES Y FORMA DE PAGO:', 40, termsY);
      doc.fontSize(7.5).fillColor(gray).font('Helvetica')
        .text(`• Anticipo: ${fin.advancePercentage ?? 30}% a la aceptación (${(fin.advanceAmount||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €).`, 40, termsY+12)
        .text(`• Resto: ${100-(fin.advancePercentage ?? 30)}% a la finalización y recepción de los trabajos.`, 40, termsY+22)
        .text(`• Precios válidos durante ${Number(budget.terms?.validityDays) || 15} días desde la fecha de emisión.`, 40, termsY+32)
        .text(`• ${String(budget.terms?.conditions || 'Forma de pago según lo acordado en el presupuesto.').slice(0, 180)}`, 40, termsY+42);

      // ── Cajas de firma ──────────────────────────────────────────────────────
      const signY = 700;

      // Firma profesional
      doc.rect(40, signY, 240, 70).strokeColor(border).stroke();
      doc.fontSize(7.5).fillColor(gray).font('Helvetica')
        .text('POR LA EMPRESA INSTALADORA', 50, signY + 8)
        .text('Firma y Sello:', 50, signY + 55);

      // Firma cliente
      doc.rect(315, signY, 240, 70).strokeColor(border).stroke();
      doc.fontSize(7.5).fillColor(gray).font('Helvetica')
        .text('CONFORME DEL CLIENTE', 325, signY + 8);

      // Estampar las imágenes de firma si se pasan como base64
      const embedSignature = (b64, x, y, w, h) => {
        if (!b64 || !b64.startsWith('data:image')) return false;
        const mimeMatch = b64.match(/data:(image\/\w+);base64,/);
        if (!mimeMatch) return false;
        const imgBuf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imgBuf, x, y, { fit: [w, h], align: 'center', valign: 'center' });
        return true;
      };

      const hasProSig = embedSignature(signaturePro, 50, signY + 18, 210, 35);
      if (!hasProSig) {
        doc.fontSize(7).fillColor(primary).font('Helvetica-Bold')
        .text('EMITIDO POR LA EMPRESA', 50, signY + 22, { width: 220, align: 'center' });
        doc.fontSize(6.5).fillColor(gray).font('Helvetica')
          .text(`Por ${budget.company?.name || 'la empresa instaladora'}`, 50, signY + 34, { width: 220, align: 'center' });
        doc.fontSize(6).fillColor('#94a3b8').font('Helvetica')
          .text(`CIF: ${budget.company?.cif || ''}`, 50, signY + 45, { width: 220, align: 'center' });
      }

      const hasClientSig = embedSignature(signatureClient, 325, signY + 18, 210, 35);
      if (!hasClientSig) {
        doc.fontSize(7).fillColor(primary).font('Helvetica-Bold')
        .text('ACEPTACIÓN REGISTRADA', 325, signY + 25, { width: 220, align: 'center' });
      }

      // Pie legal con timestamp de firma
      const signedDate = new Date(signedAt).toLocaleString('es-ES');
      doc.fontSize(6.5).fillColor('#94a3b8').font('Helvetica')
        .text(`Aceptación electrónica registrada el ${signedDate} | Ref: ${budget.id || 'PV'}`, 40, 785, {align:'center',width:515});

      doc.end();
    } catch(e) { reject(e); }
  });
}

// ─── Control de firmas únicas (Persistencia remota) ───────────────────────────
function getSigningStoreConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('El registro seguro de firmas no está configurado.');
  return { url: url.replace(/\/$/, ''), token };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function constantTimeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function getTrustedBudget(signedPayload, proof) {
  const secret = process.env.PRESUVOZ_SIGNING_SECRET;
  if (!secret || secret.length < 32) throw new Error('El servicio de firma no está configurado.');
  const expected = createHmac('sha256', secret).update(signedPayload).digest('base64url');
  if (!constantTimeTextEqual(expected, proof)) throw new Error('El enlace de firma no es válido o ha sido alterado.');

  const compact = JSON.parse(inflateRawSync(Buffer.from(signedPayload, 'base64url'), { maxOutputLength: 512 * 1024 }).toString('utf8'));
  if (!compact || typeof compact.i !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(compact.i) ||
      !Array.isArray(compact.t) || compact.t.length === 0 || compact.t.length > 60) {
    throw new Error('El presupuesto del enlace no tiene un formato válido.');
  }
  const items = compact.t.map((item, index) => ({
    id: index + 1,
    description: String(item?.d || '').slice(0, 500),
    qty: Number(item?.q ?? 1),
    unit: String(item?.u || 'pa').slice(0, 20),
    unitPrice: Number(item?.p ?? 0),
    total: Number(item?.t ?? 0),
    isPricePending: Boolean(item?.pen)
  }));
  if (items.some(item => !item.description || !Number.isFinite(item.qty) || item.qty <= 0 ||
      !Number.isFinite(item.unitPrice) || item.unitPrice < 0 || !Number.isFinite(item.total) || item.total < 0 ||
      item.isPricePending || Math.abs(item.total - item.qty * item.unitPrice) > 0.03)) {
    throw new Error('Las partidas del presupuesto no son válidas.');
  }

  const financials = compact.f || {};
  const taxableBase = Number(financials.b);
  const taxRatePercentage = Number(financials.r);
  const taxAmount = Number(financials.a ?? financials.x);
  const totalAmount = Number(financials.t);
  const discountAmount = Number(financials.da ?? 0);
  const discountPercentage = Number(financials.dp ?? 0);
  const advancePercentage = Number(financials.ap ?? 30);
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const closeEnough = (a, b) => Math.abs(a - b) <= 0.03;
  if (![taxableBase, taxRatePercentage, taxAmount, totalAmount, discountAmount, discountPercentage, advancePercentage].every(Number.isFinite) ||
      ![0, 4, 5, 10, 21].includes(taxRatePercentage) || discountAmount < 0 || discountAmount > subtotal ||
      discountPercentage < 0 || discountPercentage > 100 || advancePercentage < 0 || advancePercentage > 100 ||
      totalAmount <= 0 ||
      !closeEnough(taxableBase, subtotal - discountAmount) ||
      !closeEnough(taxAmount, taxableBase * taxRatePercentage / 100) ||
      !closeEnough(totalAmount, taxableBase + taxAmount)) {
    throw new Error('Los importes del presupuesto no cuadran. Solicita un nuevo enlace.');
  }

  return {
    id: compact.i,
    company: {
      name: String(compact.c?.n || 'Empresa'), cif: String(compact.c?.c || ''),
      address: String(compact.c?.a || ''), phone: String(compact.c?.p || ''), email: String(compact.c?.e || '')
    },
    client: {
      name: String(compact.k?.n || 'Cliente Particular'), address: String(compact.k?.a || ''),
      phone: String(compact.k?.p || ''), email: String(compact.k?.e || '')
    },
    items,
    financials: {
      subtotal, discountPercentage, discountAmount,
      taxableBase, taxRatePercentage, taxAmount, totalAmount,
      advancePercentage, advanceAmount: Number(financials.aa ?? 0)
    },
    terms: compact.terms || { validityDays: 15, conditions: 'Condiciones según presupuesto.' },
    status: String(compact.s || 'PENDIENTE_ACEPTACION')
  };
}

async function checkSignedRemote(budgetId) {
  if (!budgetId) return null;
  const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
  const { url, token } = getSigningStoreConfig();
  const key = `presuvoz:signed:${cleanId}`;
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`No se pudo consultar el registro de firmas (HTTP ${response.status}).`);
  const data = await response.json();
  if (!data.result) return null;
  return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
}

function getSigningKey() {
  const secret = process.env.PRESUVOZ_SIGNING_SECRET;
  if (!secret || secret.length < 32) throw new Error('El servicio de firma no está configurado.');
  return secret;
}

function getRequestFingerprint({ signedPayload, proof, signaturePro, signatureClient, clientEmail }) {
  return createHmac('sha256', getSigningKey())
    .update(JSON.stringify({ signedPayload, proof, signaturePro: signaturePro || '', signatureClient, clientEmail }))
    .digest('hex');
}

async function markSignedRemote(budgetId, info) {
  if (!budgetId) return;
  const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
  const { url, token } = getSigningStoreConfig();
  const record = {
    signed: true,
    budgetId: cleanId,
    signedAt: info.signedAt || new Date().toISOString(),
    clientEmail: info.clientEmail || '',
    clientName: info.clientName || '',
    requestFingerprint: info.requestFingerprint,
    emailSent: false,
    emailId: null
  };
  const key = `presuvoz:signed:${cleanId}`;
  const response = await fetch(`${url}/set/${encodeURIComponent(key)}?NX=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`No se pudo guardar el registro de firma (HTTP ${response.status}).`);
  const data = await response.json();
  return data.result === 'OK';
}

async function updateSignedRemote(budgetId, record) {
  const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
  const { url, token } = getSigningStoreConfig();
  const response = await fetch(`${url}/set/presuvoz%3Asigned%3A${encodeURIComponent(cleanId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`No se pudo actualizar el estado del correo (HTTP ${response.status}).`);
  const data = await response.json();
  if (data.result !== 'OK') throw new Error('No se pudo guardar el estado del correo.');
}

async function acquireEmailRetryLock(budgetId) {
  const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
  const { url, token } = getSigningStoreConfig();
  const lockKey = `presuvoz:email-lock:${cleanId}`;
  const lockToken = randomUUID();
  const response = await fetch(`${url}/set/${encodeURIComponent(lockKey)}?NX=true&EX=120`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: lockToken,
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`No se pudo bloquear el reintento del correo (HTTP ${response.status}).`);
  const data = await response.json();
  return data.result === 'OK' ? { lockKey, lockToken } : null;
}

async function releaseEmailRetryLock(lock) {
  if (!lock) return;
  const { url, token } = getSigningStoreConfig();
  try {
    const current = await fetch(`${url}/get/${encodeURIComponent(lock.lockKey)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000)
    });
    const body = await current.json();
    if (body.result !== lock.lockToken) return;
    await fetch(`${url}/del/${encodeURIComponent(lock.lockKey)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000)
    });
  } catch (_) {}
}

// ─── Handler principal ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  const origin = req.headers.origin;
  const host = String(req.headers.host || '').toLowerCase();
  const allowedOrigins = [
    'https://albmarmar6.github.io',
    'https://presuvoz.online',
    'https://www.presuvoz.online',
    'https://presuvoz.vercel.app',
    ...(process.env.PRESUVOZ_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  ];
  let originAllowed = allowedOrigins.includes(origin);
  try { originAllowed ||= Boolean(origin) && new URL(origin).host.toLowerCase() === host; } catch (_) {}
  if (originAllowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return originAllowed ? res.status(200).end() : res.status(403).end();

  // Endpoint de comprobación: GET /api/sign?id=ID_DEL_PRESUPUESTO
  if (req.method === 'GET') {
    if (req.query.all) return res.status(404).json({ ok: false, error: 'Endpoint no disponible.' });

    const budgetId = req.query.id || req.query.check;
    if (!budgetId) {
      return res.status(400).json({ ok: false, error: 'Falta parámetro id o check.' });
    }
    let check;
    try { check = await checkSignedRemote(budgetId); }
    catch (error) { return res.status(503).json({ ok: false, error: error.message }); }
    return res.status(200).json({
      ok: true,
      budgetId,
      alreadySigned: Boolean(check),
      details: check ? {
        signed: true, budgetId: check.budgetId, signedAt: check.signedAt,
        clientEmail: check.clientEmail, emailSent: Boolean(check.emailSent),
        emailId: check.emailId || null, retryable: !check.emailSent
      } : null
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  }

  const { signaturePro, signatureClient, signedPayload, proof } = req.body || {};
  const clientEmail = String(req.body?.clientEmail || '').trim();

  if (!signedPayload || typeof signedPayload !== 'string' || signedPayload.length > 300000 || !proof || !signatureClient || !clientEmail) {
    return res.status(400).json({ ok: false, error: 'Faltan el presupuesto, el email o la firma del cliente.' });
  }
  let budget;
  try {
    budget = getTrustedBudget(signedPayload, proof);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  if (!/^[^\s@<>]{1,100}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i.test(clientEmail)) {
    return res.status(400).json({ ok: false, error: 'El email no tiene un formato válido.' });
  }
  if ([signatureClient, signaturePro].some(signature => signature &&
      (typeof signature !== 'string' || signature.length > 350000 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(signature)))) {
    return res.status(400).json({ ok: false, error: 'El formato de la firma no es válido.' });
  }

  const budgetId = budget.id || 'PRE-2026';
  let requestFingerprint;
  try { requestFingerprint = getRequestFingerprint({ signedPayload, proof, signaturePro, signatureClient, clientEmail }); }
  catch (error) { return res.status(503).json({ ok: false, error: error.message }); }

  // Repetir exactamente la misma petición puede reintentar el correo, nunca aceptar una segunda firma.
  let alreadySigned;
  try { alreadySigned = await checkSignedRemote(budgetId); }
  catch (error) { return res.status(503).json({ ok: false, error: error.message }); }
  if (alreadySigned) {
    if (alreadySigned.requestFingerprint !== requestFingerprint) {
      return res.status(409).json({
        ok: false, alreadySigned: true, emailSent: Boolean(alreadySigned.emailSent),
        error: 'Este presupuesto ya fue aceptado. La petición no coincide con la aceptación registrada.',
        details: alreadySigned
      });
    }
    if (alreadySigned.emailSent) {
      return res.status(409).json({
        ok: false, alreadySigned: true, emailSent: true,
        error: 'La aceptación y el envío del correo ya se completaron.',
        details: alreadySigned
      });
    }
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'Servicio de email no configurado en el servidor (falta RESEND_API_KEY).' });
  }

  const signedAt = alreadySigned?.signedAt || new Date().toISOString();
  if (!alreadySigned) {
    let recorded;
    try { recorded = await markSignedRemote(budgetId, { budgetId, clientEmail, signedAt, clientName: budget.client?.name, requestFingerprint }); }
    catch (error) { return res.status(503).json({ ok: false, error: error.message }); }
    if (!recorded) {
      try { alreadySigned = await checkSignedRemote(budgetId); }
      catch (error) { return res.status(503).json({ ok: false, error: error.message }); }
      if (!alreadySigned || alreadySigned.requestFingerprint !== requestFingerprint || alreadySigned.emailSent) {
        return res.status(409).json({ ok: false, alreadySigned: true, emailSent: Boolean(alreadySigned?.emailSent), error: 'Este presupuesto ya tiene una aceptación registrada.', details: alreadySigned });
      }
    }
  }

  let deliveryLock;
  try { deliveryLock = await acquireEmailRetryLock(budgetId); }
  catch (error) { return res.status(503).json({ ok: false, signed: true, emailSent: false, retryable: true, error: error.message }); }
  if (!deliveryLock) {
    return res.status(409).json({
      ok: false, emailSent: false, retryable: true,
      error: 'La copia se está enviando en otra petición. Espera un momento antes de reintentar.',
      details: alreadySigned
    });
  }

  const resend = new Resend(apiKey);

  try {
    const pdfBuffer = await generateSignedPDF(budget, signaturePro, signatureClient, signedAt);
    const pdfBase64 = pdfBuffer.toString('base64');
    const budgetId  = budget.id || 'PRE-2026';
    const companyName = escapeHtml(budget.company?.name || 'PresuVoz Reformas');
    const clientName  = escapeHtml(budget.client?.name || 'Cliente');
    const safeBudgetId = escapeHtml(budgetId);
    const total = (budget.financials?.totalAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 });

    const recipients = [clientEmail];
    if (budget.company?.email && /^[^\s@<>]{1,100}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i.test(budget.company.email) && !recipients.includes(budget.company.email)) {
      recipients.push(budget.company.email);
    }

    const emailHtml = `
      <!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background:#f0fdf4;font-family:Arial,sans-serif;">
        <div style="max-width:560px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <div style="background:#059669;padding:28px 32px;">
            <div style="font-size:22px;font-weight:700;color:white;margin-bottom:4px;">✅ Presupuesto Aceptado</div>
          <div style="font-size:14px;color:#d1fae5;">${safeBudgetId} · ${companyName}</div>
          </div>
          <div style="padding:28px 32px;">
            <p style="color:#374151;font-size:15px;margin:0 0 16px;">Estimado/a <strong>${clientName}</strong>,</p>
            <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 20px;">
              Adjuntamos una copia del presupuesto de obra <strong>${safeBudgetId}</strong> con la aceptación electrónica registrada.
            </p>
            <div style="background:#f0fdf4;border:1px solid #d1fae5;border-radius:12px;padding:20px;margin:0 0 24px;">
              <div style="font-size:13px;color:#374151;margin-bottom:8px;"><strong>📄 Resumen del contrato:</strong></div>
              <div style="font-size:13px;color:#6b7280;">Referencia: <strong style="color:#111827;">${safeBudgetId}</strong></div>
              <div style="font-size:13px;color:#6b7280;margin-top:4px;">Importe total: <strong style="color:#059669;font-size:16px;">${total} €</strong></div>
              <div style="font-size:13px;color:#6b7280;margin-top:4px;">Empresa: ${companyName}</div>
            </div>
            <p style="color:#9ca3af;font-size:12px;line-height:1.5;border-top:1px solid #f3f4f6;padding-top:16px;margin:0;">
              La eficacia jurídica de esta aceptación dependerá del documento, las evidencias disponibles y las circunstancias de cada operación.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    let emailSentId = null;

    let mailError = null;
    try {
      const emailResult = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'PresuVoz <onboarding@resend.dev>',
        to:   recipients,
        subject: `Presupuesto Firmado ${budgetId} — ${companyName}`,
        html: emailHtml,
        attachments: [
          {
            filename: `Contrato_${budgetId}.pdf`,
            content:  pdfBase64
          }
        ]
      }, { idempotencyKey: `presuvoz-acceptance/${budgetId}` });

      if (emailResult?.error) throw new Error(emailResult.error.message || 'El proveedor de correo rechazó el envío.');
      emailSentId = emailResult?.data?.id || null;
      if (!emailSentId) throw new Error('El proveedor no confirmó la entrega del correo.');
    } catch (mailErr) {
      console.warn('⚠️ No se pudo remitir email por Resend:', mailErr.message);
      mailError = mailErr.message;
    }

    const finalRecord = {
      ...(alreadySigned || {}), signed: true, budgetId, signedAt, clientEmail,
      clientName: budget.client?.name || '', requestFingerprint,
      emailSent: Boolean(emailSentId), emailId: emailSentId,
      emailError: mailError ? String(mailError).slice(0, 300) : null
    };
    try { await updateSignedRemote(budgetId, finalRecord); }
    catch (error) {
      console.error('No se pudo actualizar el estado de entrega del correo:', error.message);
      if (emailSentId) {
        return res.status(200).json({ ok: true, signed: true, emailSent: true, emailId: emailSentId, budgetId, signedAt, statusWarning: true });
      }
    }
    return res.status(200).json({ ok: true, signed: true, emailSent: Boolean(emailSentId), retryable: !emailSentId, emailError: mailError, emailId: emailSentId, budgetId, signedAt });

  } catch (err) {
    console.error('sign.js error:', err);
    return res.status(200).json({ ok: true, signed: true, emailSent: false, retryable: true, error: err.message || 'No se pudo generar o enviar la copia. Reintenta el envío.' });
  } finally {
    await releaseEmailRetryLock(deliveryLock);
  }
}
