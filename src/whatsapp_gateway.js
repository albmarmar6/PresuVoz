/**
 * PresuVoz — WhatsApp QR Gateway
 * Conecta un número de WhatsApp real mediante código QR (Baileys).
 * Escucha mensajes de texto y notas de voz (.ogg), los procesa con Gemini AI
 * y responde automáticamente con presupuestos formales de obra.
 */

import makeWASocketPkg, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import dotenv from 'dotenv';
import { Resend } from 'resend';
import { PresuVozEngine } from './engine.js';
import {
  GEMINI_SYSTEM_PROMPT,
  GEMINI_UPDATE_PROMPT,
  parsePurchaseInvoiceWithGemini,
  validateAndNormalizePurchaseInvoice
} from './ai_service.js';
import {
  generateBudgetPDF,
  generateInvoicePDF,
  generateReceiptPDF,
  generateQuarterTaxPDF
} from './pdf_service.js';
import { initAppointmentScheduler } from './appointment_scheduler.js';
import {
  buildGestoriaPackageZip,
  sendFiscalPackageToGestoria,
  formatQuarterWhatsAppSummary,
  getQuarterSummary
} from './fiscal_service.js';
import { resolveAuthenticatedContext } from './identity_service.js';
import {
  getCompany,
  saveCompany,
  saveBudget,
  getBudget,
  listBudgets,
  saveInvoice,
  getInvoice,
  listInvoices,
  savePayment,
  getPayments,
  savePurchaseInvoice,
  saveExpensePayment,
  saveInvestmentAsset,
  getTaxProfile,
  saveTaxProfile,
  getQuarterInvoices,
  generateQuarterCSV,
  saveAppointment,
  getAppointment,
  findAppointments,
  rescheduleAppointment,
  completeAppointments,
  findConflictingAppointments,
  getAppointmentHistory,
  listAppointments,
  updateAppointmentStatus,
  updateAppointment,
  cancelAppointment,
  updateBudgetStatus,
  syncPendingSignaturesFromCloud,
  getUnpaidInvoices,
  getBudgetsPendingFollowUp,
  addShoppingItems,
  listShoppingItems,
  markShoppingItemBought,
  clearShoppingList,
  getWorkMemory,
  updateWorkTaskStatus,
  updateWorkDates,
  findClientsByName,
  renameClientBudget,
  getMonthlyRevenue,
  listAppointmentsWeek,
  getDashboard,
  recordIncomingMessage,
  updateMessageStatus,
  isMessageAlreadyProcessed
} from './db_service.js';
import {
  PERMISSION_LEVELS,
  classifyActionPermission,
  createProposedAction,
  evaluateConfirmationResponse,
  generateDailyBriefing,
  generateEveningReminder,
  buildBudgetFollowUpProposal,
  buildInvoiceFollowUpProposal,
  formatDisambiguationPrompt,
  formatDuplicateClientWarning
} from './secretary_service.js';
import {
  getOnboardingState,
  startOnboarding,
  processOnboardingStep
} from './onboarding_service.js';
import { detectIntent, resolveIntent } from './intent_router.js';

dotenv.config();

// Silenciar volcados internos de depuración de claves criptográficas de libsignal (Signal Protocol)
const _origInfo = console.info;
console.info = (...args) => {
  if (typeof args[0] === 'string' && (args[0].includes('session:') || args[0].includes('Session:') || args[0].includes('Migrating session'))) {
    return;
  }
  _origInfo(...args);
};
const _origWarn = console.warn;
console.warn = (...args) => {
  if (typeof args[0] === 'string' && (args[0].includes('Session already') || args[0].includes('Closing open session'))) {
    return;
  }
  _origWarn(...args);
};

const makeWASocket = makeWASocketPkg.default || makeWASocketPkg;
const engine = new PresuVozEngine();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const PRESUVOZ_BACKEND_URL = process.env.PRESUVOZ_BACKEND_URL || 'https://presuvoz.vercel.app';
const SAFE_MODE = (process.env.SAFE_MODE ?? 'true').toLowerCase() === 'true';
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map(s => s.trim().replace(/\D/g, ''))
  .filter(Boolean);

const GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-flash-lite-latest',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.8-flash'
];

// Almacén en memoria de mensajes de WhatsApp para responder a solicitudes 'retry' (evita 'Esperando mensaje')
const messageStore = new Map();

// ─── Control de Estados de Conversación y Cola FIFO por Chat ───
// Estados de la conversación: 'IDLE' | 'PROCESSING' | 'WAITING_FOR_INPUT'
export const conversationStates = new Map(); // remoteJid -> 'IDLE' | 'PROCESSING' | 'WAITING_FOR_INPUT'
export const chatQueues = new Map();         // remoteJid -> Array of pending queue items
export const chatDebounceTimers = new Map(); // remoteJid -> NodeJS.Timeout
export const chatPendingBatches = new Map(); // remoteJid -> Array of text messages in burst

export function getConversationState(remoteJid) {
  return conversationStates.get(remoteJid) || 'IDLE';
}

export function setConversationState(remoteJid, state) {
  conversationStates.set(remoteJid, state);
  console.log(`💬 [Conversación: ${String(remoteJid).split('@')[0]}] Estado -> ${state}`);
}

function storeMessage(keyId, message) {
  if (!keyId || !message) return;
  if (messageStore.size > 2000) {
    const oldestKey = messageStore.keys().next().value;
    messageStore.delete(oldestKey);
  }
  messageStore.set(keyId, message);
}

/**
 * ─── INGRESS GATEKEEPER: Blindaje Estricto de Entrada ───
 * Determina si un mensaje recibido en WhatsApp debe ser procesado por el bot o descartado inmediatamente.
 * 
 * Reglas Fundamentales de Seguridad:
 * 1. Grupos (@g.us), difusiones (@broadcast) y canales (@newsletter) NUNCA se procesan.
 * 2. Mensajes salientes del móvil (fromMe): SOLO se procesan si son Self-Chat (chat consigo mismo).
 *    Si el usuario escribe a cualquier otra persona o contacto ajeno, el bot lo descarta de inmediato.
 * 3. Mensajes entrantes de terceros (!fromMe): SOLO se procesan si el remitente está
 *    explícitamente en ALLOWED_NUMBERS (ej. familiares/testers para sus pruebas). Contactos ajenos se descartan.
 */
export function shouldProcessIncomingMessage({ remoteJid, fromMe, myNumber, myLid, allowedNumbers = [] }) {
  if (!remoteJid || typeof remoteJid !== 'string') {
    return { process: false, reason: 'INVALID_JID' };
  }

  // 1. Grupos, listas de difusión y canales: PROHIBIDO TOTALMENTE
  if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast') || remoteJid.includes('@newsletter')) {
    return { process: false, reason: 'GROUP_OR_BROADCAST_IGNORED' };
  }

  const cleanMyNum = String(myNumber || '').replace(/\D/g, '');
  const cleanMyLid = String(myLid || '').replace(/\D/g, '');
  const remoteUser = remoteJid.split('@')[0].split(':')[0].replace(/\D/g, '');
  const isFromMe = Boolean(fromMe);

  // 2. Comprobar si es Self-Chat (chat consigo mismo por número de teléfono o LID propio)
  const isSelfChat = isFromMe && (
    (cleanMyNum && remoteUser === cleanMyNum) ||
    (cleanMyLid && remoteUser === cleanMyLid)
  );

  // 3. REGLA INMUTABLE PARA MENSAJES SALIENTES (fromMe):
  // Si no es self-chat, el profesional está chateando con un contacto ajeno desde su propio móvil.
  // ¡El bot NUNCA debe interceptar ni responder en conversaciones personales o externas!
  if (isFromMe && !isSelfChat) {
    return { process: false, reason: 'OUTGOING_THIRD_PARTY_IGNORED' };
  }

  // 4. REGLA INMUTABLE PARA MENSAJES ENTRANTES DE TERCEROS (!fromMe):
  // Solo se procesan si el número remitente está expresamente autorizado.
  if (!isFromMe) {
    const isAllowed = allowedNumbers.some(num => num && remoteUser === String(num).replace(/\D/g, ''));
    if (!isAllowed) {
      return { process: false, reason: 'UNAUTHORIZED_INCOMING_SENDER' };
    }
    return { process: true, reason: 'AUTHORIZED_EXTERNAL_SENDER', senderNumber: remoteUser };
  }

  // 5. Self-chat autorizado
  return { process: true, reason: 'SELF_CHAT', senderNumber: cleanMyNum || remoteUser };
}

/**
 * ─── EGRESS FIREWALL: Blindaje Absoluto de Salida ───
 * Verifica si un destinatario tiene permiso para recibir mensajes del bot.
 * Actúa como cortafuegos central en sock.sendMessage para garantizar que NINGÚN
 * mensaje o notificación se filtre a contactos no autorizados bajo ninguna circunstancia.
 */
export function isAuthorizedEgressRecipient(targetJid, { myNumber, myLid, allowedNumbers = [] }) {
  if (!targetJid || typeof targetJid !== 'string') {
    return { allowed: false, reason: 'INVALID_TARGET_JID' };
  }

  // 1. Grupos, listas de difusión y canales: PROHIBIDO TOTALMENTE
  if (targetJid.includes('@g.us') || targetJid.includes('@broadcast') || targetJid.includes('@newsletter')) {
    return { allowed: false, reason: 'GROUP_OR_BROADCAST_TARGET_BLOCKED' };
  }

  const cleanMyNum = String(myNumber || '').replace(/\D/g, '');
  const cleanMyLid = String(myLid || '').replace(/\D/g, '');
  const targetUser = targetJid.split('@')[0].split(':')[0].replace(/\D/g, '');

  // 2. Chat consigo mismo (self-chat por número o por LID)
  const isSelf = (cleanMyNum && targetUser === cleanMyNum) || (cleanMyLid && targetUser === cleanMyLid);
  if (isSelf) {
    return { allowed: true, reason: 'SELF_CHAT' };
  }

  // 3. Números expresamente autorizados en ALLOWED_NUMBERS
  const isAllowed = allowedNumbers.some(num => num && targetUser === String(num).replace(/\D/g, ''));
  if (isAllowed) {
    return { allowed: true, reason: 'AUTHORIZED_NUMBER' };
  }

  return { allowed: false, reason: 'UNAUTHORIZED_TARGET' };
}

// Cola de tareas en espera (stand-by) para Gemini ante saturación o alta demanda temporal (429/503)
const aiStandbyQueue = [];
let isProcessingAiQueue = false;

let cachedWorkingModel = null;

async function callGemini(payload, systemInstruction = GEMINI_SYSTEM_PROMPT) {
  if (!GEMINI_API_KEY && typeof payload === 'string' && PRESUVOZ_BACKEND_URL) {
    const res = await fetch(`${PRESUVOZ_BACKEND_URL}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPrompt: payload,
        systemInstruction: systemInstruction
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Error del backend ${res.status}`);
    }
    return data.result;
  }

  if (!GEMINI_API_KEY) {
    throw new Error('Falta GEMINI_API_KEY en el archivo .env. Añádela para procesar audios y texto directamente.');
  }

  let parts = [];
  if (typeof payload === 'string') {
    parts.push({ text: payload });
  } else if (payload && payload.audioBuffer) {
    const cleanMime = (payload.mimeType || 'audio/ogg').split(';')[0].trim();
    parts.push({
      inlineData: {
        mimeType: cleanMime,
        data: payload.audioBuffer.toString('base64')
      }
    });
    const instructionText = payload.promptText || 'Analiza este audio de obra de un profesional de la construcción. Extrae todas las partidas, mediciones, precios e instrucciones, y genera el presupuesto formal en JSON cumpliendo las reglas del sistema.';
    parts.push({ text: instructionText });
  }

  const modelsToTry = cachedWorkingModel
    ? [cachedWorkingModel, ...GEMINI_MODELS.filter(m => m !== cachedWorkingModel)]
    : GEMINI_MODELS;

  let lastError = null;
  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048
          }
        }),
        signal: AbortSignal.timeout(12000)
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMsg = data.error?.message || `Error HTTP ${response.status}`;
        console.warn(`PresuVoz ⚠ Modelo "${model}" no disponible (${response.status}): ${errMsg.substring(0, 100)}`);
        
        // Priorizar errores de cuota o alta demanda (429/503) para activar correctamente la cola stand-by
        if (response.status === 429 || response.status === 503 || /demand|quota|busy|exhausted/i.test(errMsg)) {
          lastError = new Error(`Servidores de Gemini saturados (${response.status}: ${errMsg.substring(0, 100)})`);
          await new Promise(r => setTimeout(r, 1000));
        } else if (!lastError || !/demand|quota|busy|exhausted|429|503/i.test(lastError.message)) {
          lastError = new Error(errMsg);
        }
        continue;
      }

      const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!jsonText) throw new Error('Respuesta vacía de Gemini');
      
      cachedWorkingModel = model;
      return JSON.parse(jsonText);
    } catch (e) {
      const isTimeout = e.name === 'TimeoutError' || /timeout|aborted/i.test(e.message || '');
      if (isTimeout) {
        console.warn(`PresuVoz ⚠ Modelo "${model}" agotó tiempo de espera (12s sin respuesta)`);
        lastError = new Error('Servidores de Gemini saturados (timeout: modelo no respondió en 12s)');
      } else {
        console.warn(`PresuVoz ⚠ Error con modelo "${model}":`, e.message);
        if (!lastError || !/demand|quota|busy|exhausted|429|503/i.test(lastError.message)) {
          lastError = e;
        }
      }
    }
  }

  throw lastError || new Error('No se pudo conectar con ningún modelo de Gemini');
}

function formatBudgetForWhatsApp(budget, warnings = []) {
  const isDraft = budget.isDraft;
  const isAccepted = budget.status === 'ACEPTADO';
  const statusHeader = isAccepted
    ? '🎉 *PRESUPUESTO ACEPTADO DE OBRA*'
    : (isDraft 
        ? '📋 *BORRADOR DE PRESUPUESTO TÉCNICO*' 
        : '✅ *PRESUPUESTO FORMAL DE OBRA*');

  const statusLabel = isAccepted
    ? '🟢 *Estado:* Aceptado'
    : (isDraft ? '🟡 *Estado:* Borrador (partidas pendientes de valorar)' : '⏳ *Estado:* Pendiente de aceptación');

  const lines = [
    statusHeader,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `👤 *Cliente:* ${budget.client.name}`,
    `📍 *Ubicación:* ${budget.client.address}`,
    `📅 *Fecha:* ${new Date().toLocaleDateString('es-ES')}`,
    statusLabel,
    '',
    '🛠️ *PARTIDAS Y MEDICIONES:*'
  ];

  budget.items.forEach((item, index) => {
    const num = `${index + 1}️⃣`;
    const priceText = item.isPricePending 
      ? '_(Pendiente de valorar)_' 
      : `${item.total.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
    const unitText = item.qty > 1 || item.unit !== 'pa' ? ` (${item.qty} ${item.unit})` : '';
    lines.push(`${num} *${item.description}*${unitText}`);
    lines.push(`   └ Importe: *${priceText}*`);
  });

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💰 *DESGLOSE ECONÓMICO:*');

  if (budget.financials.discountAmount > 0) {
    lines.push(`• Subtotal: ${budget.financials.subtotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
    lines.push(`• Descuento (${budget.financials.discountPercentage}%): -${budget.financials.discountAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
  }

  lines.push(`• Base imponible: ${budget.financials.taxableBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
  lines.push(`• IVA (${budget.financials.taxRatePercentage}%): ${budget.financials.taxAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
  lines.push(`• *TOTAL PRESUPUESTO: ${budget.financials.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €*`);

  if (!isDraft && budget.financials.advanceAmount > 0) {
    lines.push('');
    lines.push('💳 *Condiciones de pago:*');
    lines.push(`• ${budget.financials.advancePercentage}% al aceptar (${budget.financials.advanceAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €)`);
    lines.push(`• ${100 - budget.financials.advancePercentage}% a la entrega (${budget.financials.remainingAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €)`);
  }

  if (warnings && warnings.length > 0) {
    lines.push('');
    lines.push('⚠️ *Avisos:*');
    warnings.forEach(w => lines.push(`• ${w}`));
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('🤖 _Generado por PresuVoz AI. Envía otro audio o texto para modificar este presupuesto. Escribe *#nuevo* para empezar uno nuevo._');

  return lines.join('\n');
}

async function shortenUrl(longUrl) {
  // 1. Intentar da.gd (capacidad de más de 3.000 caracteres sin truncar, redirección 302 directa limpia)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://da.gd/s?url=${encodeURIComponent(longUrl)}`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      const short = (await res.text()).trim();
      if (short.startsWith('http')) {
        return short;
      }
    }
  } catch (e) {
    console.warn('⚠️ da.gd no disponible, probando CleanURI...');
  }

  // 2. Intentar CleanURI (rápido y limpio para URLs comprimidas)
  try {
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 4000);
    const res2 = await fetch('https://cleanuri.com/api/v1/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url: longUrl }),
      signal: controller2.signal
    });
    clearTimeout(timeout2);
    if (res2.ok) {
      const data = await res2.json().catch(() => ({}));
      if (data.result_url && data.result_url.startsWith('http')) {
        return data.result_url;
      }
    }
  } catch (e) {
    console.warn('⚠️ CleanURI no disponible, probando TinyURL...');
  }

  // 3. Fallback a TinyURL
  try {
    const controller3 = new AbortController();
    const timeout3 = setTimeout(() => controller3.abort(), 4000);
    const res3 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`, {
      signal: controller3.signal
    });
    clearTimeout(timeout3);
    if (res3.ok) {
      const short = (await res3.text()).trim();
      if (short.startsWith('http')) {
        return short;
      }
    }
  } catch (e) {
    console.warn('⚠️ No se pudo acortar URL:', e.message);
  }

  return longUrl;
}

function generateSigningUrl(budget, company, cleanPhone) {
  const compactBudget = {
    i: budget.id,
    c: {
      n: company?.name || budget.company?.name || 'Carpintería y Reformas Manolo S.L.',
      c: company?.cif || budget.company?.cif || 'B-41987654',
      f: company?.cif || budget.company?.cif || 'B-41987654',
      p: company?.phone || cleanPhone,
      e: company?.email || 'presupuestos@presuvoz.app',
      a: company?.address || budget.company?.address || 'Pol. Ind. El Pino, Nave 4 - Sevilla'
    },
    k: {
      n: budget.client?.name || 'Cliente Particular',
      a: budget.client?.address || 'Ubicación según visita',
      p: budget.client?.phone || '',
      e: budget.client?.email || ''
    },
    t: (budget.items || []).map(it => ({
      d: it.description || '',
      q: it.qty ?? 1,
      u: it.unit || 'pa',
      p: it.unitPrice ?? 0,
      t: it.total ?? ((it.qty ?? 1) * (it.unitPrice ?? 0)),
      pen: Boolean(it.isPricePending)
    })),
    f: {
      b: budget.financials?.taxableBase ?? budget.financials?.subtotal ?? 0,
      r: budget.financials?.taxRatePercentage ?? 10,
      x: budget.financials?.taxAmount ?? 0,
      a: budget.financials?.taxAmount ?? 0,
      t: budget.financials?.totalAmount ?? 0,
      ap: budget.financials?.advancePercentage ?? 30,
      aa: budget.financials?.advanceAmount ?? 0,
      dp: budget.financials?.discountPercentage ?? 0,
      da: budget.financials?.discountAmount ?? 0
    },
    terms: budget.terms,
    status: budget.status || 'PENDIENTE_ACEPTACION'
  };

  const compressed = zlib.deflateRawSync(Buffer.from(JSON.stringify(compactBudget), 'utf-8'));
  const budgetZ = compressed.toString('base64url');
  return `https://albmarmar6.github.io/PresuVoz/studio/firmar.html?z=${budgetZ}`;
}

function detectBudgetListIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();

  // Excluir intenciones explícitas de otro tipo
  if (/nuevo\s+presupuesto|presupuesto\s+nuevo|factura|cobro|pago|anticipo|cu[aá]nto\s+me\s+debe/i.test(t)) {
    return null;
  }

  // Tiene que referirse a presupuestos o borradores o ser comando clave
  if (!/(?:presupuesto|borrador|sin\s+firmar|por\s+firmar)/i.test(t)) {
    if (!/^(?:1|lista)$/i.test(t)) return null;
  }

  const isListQuery = /^(?:1|lista|mis\s+presupuestos|ver\s+presupuestos)$/i.test(t) ||
    /(?:list(?:ar?|ame|a)?|ver|dime|cu[aá]les|qu[eé]|mostrar|enseñar|consultar|sacar)/i.test(t) ||
    /^(?:presupuestos|borradores)/i.test(t);

  if (!isListQuery) return null;

  if (/pendiente|sin\s+firmar|por\s+firmar|falta(?:n)?\s+por\s+firmar/i.test(t)) {
    return 'pending_signature';
  }
  if (/aceptad|firmad/i.test(t)) {
    return 'accepted';
  }
  if (/borrador/i.test(t)) {
    return 'draft';
  }
  return 'all';
}

// ─────────────────────────────────────────────────────────────────────────────
// MODO OBRA: Formato WhatsApp — Memoria Viva y Ficha de Obra
// ─────────────────────────────────────────────────────────────────────────────

export function formatWorkMemoryForWhatsApp(workMem, onlyMissing = false) {
  if (!workMem) return 'ℹ️ No se ha encontrado información de esta obra.';

  const clientHeader = (workMem.clientName || 'CLIENTE PARTICULAR').toUpperCase();
  const formatCur = (n) => String(Number(n || 0).toFixed(2)).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' €';

  const lines = [
    `🏠 *${onlyMissing ? 'LO QUE FALTA EN LA OBRA' : 'MODO OBRA'} — ${clientHeader}*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `💰 *Presupuesto:* ${formatCur(workMem.totalAmount)}`,
    `💵 *Pagado:* ${formatCur(workMem.totalPaid)}`,
    `⏳ *Pendiente:* ${formatCur(workMem.remainingBalance)}`
  ];

  if (!onlyMissing && (workMem.startDate || workMem.estimatedEndDate)) {
    lines.push('');
    if (workMem.startDate) lines.push(`📅 *Inicio:* ${workMem.startDate}`);
    if (workMem.estimatedEndDate) lines.push(`🏁 *Final estimado:* ${workMem.estimatedEndDate}`);
  }

  lines.push('');
  lines.push('🛒 *Materiales:*');
  const matBought = workMem.materials?.bought || [];
  const matPending = workMem.materials?.pending || [];

  if (!onlyMissing && matBought.length > 0) {
    matBought.forEach(m => {
      const q = m.qty && m.unit ? `${m.qty} ${m.unit} ` : '';
      lines.push(`  ✓ ${q}${m.description}`);
    });
  }

  if (matPending.length > 0) {
    matPending.forEach(m => {
      const q = m.qty && m.unit ? `${m.qty} ${m.unit} ` : '';
      lines.push(`  ❌ ${q}${m.description}`);
    });
  } else if (onlyMissing) {
    lines.push('  ✓ _Todos los materiales comprados_');
  } else if (matBought.length === 0 && matPending.length === 0) {
    lines.push('  _Sin materiales registrados_');
  }

  lines.push('');
  lines.push('🔨 *Tareas:*');
  const tasksDone = workMem.tasks?.done || [];
  const tasksPending = workMem.tasks?.pending || [];

  if (!onlyMissing && tasksDone.length > 0) {
    tasksDone.forEach(t => {
      lines.push(`  ✓ ${t.description}`);
    });
  }

  if (tasksPending.length > 0) {
    tasksPending.forEach(t => {
      lines.push(`  ⏳ ${t.description}`);
    });
  } else if (onlyMissing) {
    lines.push('  ✓ _Todas las tareas finalizadas_');
  } else if (tasksDone.length === 0 && tasksPending.length === 0) {
    lines.push('  _Sin tareas registradas_');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (onlyMissing) {
    lines.push(`💡 _Faltan ${matPending.length} material(es) y ${tasksPending.length} tarea(s) por finalizar._`);
  } else {
    lines.push('💡 _Puedes marcar tareas diciendo: "ya terminamos la fontanería de ' + (workMem.clientName || 'este cliente') + '"._');
  }

  return lines.join('\n');
}

async function startWhatsAppGateway() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' });

  console.log('\n======================================================');
  console.log('🚀 PresuVoz — WhatsApp Gateway');
  console.log(`Versión Baileys: ${version.join('.')}`);
  console.log(`Modo Seguro: ${SAFE_MODE ? 'ACTIVADO (solo responde a ti o lista blanca)' : 'DESACTIVADO (responde a todos)'}`);
  if (ALLOWED_NUMBERS.length > 0) {
    console.log(`Números autorizados: ${ALLOWED_NUMBERS.join(', ')}`);
  }
  console.log('======================================================\n');

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['PresuVoz Bot', 'Chrome', '1.0.0'],
    getMessage: async (key) => {
      if (key?.id && messageStore.has(key.id)) {
        return messageStore.get(key.id);
      }
      return undefined;
    }
  });

  // Interceptar todos los envíos con el Cortafuegos de Salida (Egress Firewall) para garantizar
  // que jamás salga un mensaje a un destinatario no autorizado o ajeno.
  const _rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const targetJid = args[0];
    const myNum = (sock.user?.id || state.creds?.me?.id || '').split(':')[0].replace(/\D/g, '');
    const myLid = (sock.user?.lid || state.creds?.me?.lid || '').split(':')[0].replace(/\D/g, '');

    const egressCheck = isAuthorizedEgressRecipient(targetJid, {
      myNumber: myNum,
      myLid: myLid,
      allowedNumbers: ALLOWED_NUMBERS
    });

    if (!egressCheck.allowed) {
      console.error(`🛡️ [EGRESS FIREWALL] ¡ENVÍO BLOQUEADO! Destinatario no autorizado (${egressCheck.reason}): ${targetJid}`);
      const fwLog = `[${new Date().toLocaleTimeString()}] 🛡️ [EGRESS FIREWALL] Envío bloqueado a ${targetJid} (${egressCheck.reason})\n`;
      try { (await import('fs')).appendFileSync('gateway.log', fwLog); } catch(e) {}
      return { key: { id: `blocked_${Date.now()}` }, status: 'BLOCKED' };
    }

    let attempts = 0;
    while (attempts < 2) {
      try {
        const sentMsg = await _rawSendMessage(...args);
        if (sentMsg?.key?.id) {
          botSentMessageIds.add(sentMsg.key.id);
          if (sentMsg.message) {
            storeMessage(sentMsg.key.id, sentMsg.message);
          }
        }
        return sentMsg;
      } catch (err) {
        attempts++;
        if (attempts < 2 && /connection closed|socket|econnreset|etimedout/i.test(err.message || '')) {
          console.warn(`⚠️ Error transitorio de socket WhatsApp (${err.message}). Reintentando envío en 1.5s...`);
          await new Promise(r => setTimeout(r, 1500));
        } else {
          throw err;
        }
      }
    }
  };

  const _rawSendPresence = sock.sendPresenceUpdate.bind(sock);
  sock.sendPresenceUpdate = async (type, toJid) => {
    const myNum = (sock.user?.id || state.creds?.me?.id || '').split(':')[0].replace(/\D/g, '');
    const myLid = (sock.user?.lid || state.creds?.me?.lid || '').split(':')[0].replace(/\D/g, '');
    const egressCheck = isAuthorizedEgressRecipient(toJid, {
      myNumber: myNum,
      myLid: myLid,
      allowedNumbers: ALLOWED_NUMBERS
    });
    if (!egressCheck.allowed) {
      return;
    }
    return _rawSendPresence(type, toJid);
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📲 ESCANEA ESTE CÓDIGO QR CON WHATSAPP:');
      console.log('1. Abre WhatsApp en tu móvil');
      console.log('2. Ve a Ajustes ➔ Dispositivos vinculados ➔ Vincular un dispositivo');
      console.log('3. Apunta tu cámara a este código:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Conexión cerrada. ¿Reconectando?:', shouldReconnect);
      if (shouldReconnect) {
        startWhatsAppGateway();
      } else {
        console.log('❌ Sesión cerrada. Elimina la carpeta auth_info_baileys para vincular de nuevo.');
      }
    } else if (connection === 'open') {
      console.log('\n✅ ¡WHATSAPP CONECTADO CON ÉXITO!');
      console.log('🤖 PresuVoz Bot listo para recibir audios y mensajes.\n');

      // Sondeo automático cada 8 segundos para detectar firmas del cliente en la web
      setInterval(async () => {
        try {
          const acceptedList = await syncPendingSignaturesFromCloud();
          for (const item of acceptedList) {
            const targetJids = new Set();
            const cleanPhone = String(item.companyPhone || '').replace(/\D/g, '');
            const myNum = (sock.user?.id || state.creds?.me?.id || '').split(':')[0].replace(/\D/g, '');
            const myLid = (sock.user?.lid || state.creds?.me?.lid || '').split(':')[0].replace(/\D/g, '');

            // 1. Buscar en sesiones activas el chat del profesional dueño de este presupuesto
            let foundActiveJid = null;
            for (const [activeJid, sess] of userSessions.entries()) {
              if (activeJid.includes('broadcast') || activeJid.includes('@g.us')) continue;
              const sessPhone = String(sess.phone || '').replace(/\D/g, '');
              const activeUser = String(activeJid.split('@')[0]).replace(/\D/g, '');

              // Coincidencia con el teléfono de la empresa o self-chat
              const matchesCompany = (cleanPhone && (sessPhone === cleanPhone || activeUser === cleanPhone));
              const matchesSelf = (cleanPhone && cleanPhone === myNum && (activeUser === myNum || activeUser === myLid));

              if (matchesCompany || matchesSelf) {
                // Verificar que activeJid es un destinatario autorizado
                const isAuth = isAuthorizedEgressRecipient(activeJid, { myNumber: myNum, myLid, allowedNumbers: ALLOWED_NUMBERS }).allowed;
                if (isAuth) {
                  foundActiveJid = activeJid;
                  if (sess.budgets && sess.budgets.has(item.budgetId)) {
                    const b = sess.budgets.get(item.budgetId);
                    b.status = 'ACEPTADO';
                    b.signedAt = item.signedAt;
                    b.signedEmail = item.signedEmail;
                  }
                  break;
                }
              }
            }

            if (foundActiveJid) {
              targetJids.add(foundActiveJid);
            } else if (cleanPhone) {
              // Si no hay sesión activa, enviar a su JID directo si está autorizado
              const directJid = `${cleanPhone}@s.whatsapp.net`;
              if (isAuthorizedEgressRecipient(directJid, { myNumber: myNum, myLid, allowedNumbers: ALLOWED_NUMBERS }).allowed) {
                targetJids.add(directJid);
              }
            }

            for (const jid of targetJids) {
              try {
                await sock.sendMessage(jid, {
                  text: `🎉 *¡Presupuesto Aceptado!*\n\nEl cliente *${item.clientName}* acaba de firmar formalmente el presupuesto *${item.budgetId}* a través del enlace digital.\n\n✅ *Estado actualizado:* \`🟢 ACEPTADO\`\n📧 *Copia legal enviada a:* ${item.signedEmail || 'Email registrado'}\n\n_Ya puedes preparar los trabajos o registrar el cobro de anticipo cuando lo recibas._`
                });
                console.log(`🎉 Notificación de firma enviada por WhatsApp a ${jid} para ${item.budgetId}.`);
              } catch (sendErr) {
                console.warn(`⚠️ No se pudo enviar notificación de firma a ${jid}:`, sendErr.message);
              }
            }
          }
        } catch (e) {}
      }, 8000);

      // Sondeo cada 4 segundos para reintentar tareas en cola de espera (stand-by)
      setInterval(async () => {
        try {
          await processAiStandbyQueue(sock);
        } catch (e) {}
      }, 4000);

      // Inicializar Scheduler Autónomo e Idempotente de Visitas (Víspera 19:30, Mañana 07:30, Fin de Día 20:30)
      initAppointmentScheduler(sock, userSessions, botSentMessageIds);
    }
  });

  const botSentMessageIds = new Set();
  const processedIncomingMsgIds = new Set();
  const recentMessageTexts = new Map();
  const activeProcessingJids = new Set();
  


  // Memoria multi-presupuesto y facturas por chat conectada a SQLite
  const userSessions = new Map();

  function getUserSession(remoteJid, senderNumber) {
    const cleanPhone = senderNumber || String(remoteJid).replace(/\D/g, '');
    const authContext = resolveAuthenticatedContext('whatsapp', cleanPhone);
    const resolvedCompany = authContext ? authContext.company : getCompany(cleanPhone);
    const companyId = authContext ? authContext.companyId : resolvedCompany?.id || null;

    if (!userSessions.has(remoteJid)) {
      userSessions.set(remoteJid, {
        phone: cleanPhone,
        companyId: companyId,
        authContext: authContext,
        company: resolvedCompany,
        activeBudgetId: null,
        budgets: new Map(),
        invoices: new Map(),
        pendingAction: null,
        pendingDisambiguation: null,
        lastBriefingDate: null,
        lastEveningReminderDate: null
      });
      console.log(`📦 Sesión inicializada para ${cleanPhone} (companyId: ${companyId || 'legacy'})`);
    }
    const session = userSessions.get(remoteJid);
    session.authContext = authContext;
    session.companyId = companyId;
    session.company = resolvedCompany;

    // Refrescar siempre desde SQLite para reflejar cambios en tiempo real (firmas web, cobros, etc.)
    const dbBudgets = listBudgets(cleanPhone, 100);
    for (const b of dbBudgets) {
      if (b && b.id) session.budgets.set(b.id, b);
    }
    const dbInvoices = listInvoices(cleanPhone, 100);
    for (const inv of dbInvoices) {
      if (inv && inv.id) session.invoices.set(inv.id, inv);
    }
    if (!session.activeBudgetId && session.budgets.size > 0) {
      session.activeBudgetId = Array.from(session.budgets.keys())[0];
    }
    return session;
  }

  function formatCompanyForWhatsApp(company) {
    const hasLogo = Boolean(company.logoPath && fs.existsSync(company.logoPath));
    const isConf = company.isConfigured !== false;
    return [
      '🏢 *PERFIL DE TU EMPRESA / NEGOCIO:*',
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      `👤 *Profesional:* *${company.ownerName || 'No indicado'}*`,
      `🏢 *Nombre Comercial:* ${company.name || 'No indicado'}`,
      `📛 *Razón Social:* ${company.fiscalName || company.name || 'No indicada'}`,
      `🛠️ *Oficio / Especialidad:* *${company.trade || 'No indicado'}*`,
      `📍 *Zona de trabajo:* ${company.city || 'No indicada'}`,
      `⏰ *Horario habitual:* ${company.workingHours || 'No indicado'}`,
      `💶 *Condiciones cobro:* ${company.paymentTerms || 'No especificadas'}`,
      `🤝 *Anticipo habitual:* ${company.defaultAdvance !== null && company.defaultAdvance !== undefined ? company.defaultAdvance + '%' : 'No configurado'}`,
      `⏳ *Validez presupuestos:* ${company.quoteValidityDays ? company.quoteValidityDays + ' días' : 'No indicada'}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      '📑 *Datos Fiscales para Facturación:*',
      `• *Tipo:* ${company.entityType === 'empresa' ? 'Empresa / Sociedad' : (company.entityType === 'autonomo' ? 'Autónomo' : 'No indicado')}`,
      `• *NIF / CIF:* ${company.cif || 'No indicado'}`,
      `• *Dirección Fiscal:* ${company.address || 'No indicada'}`,
      `• *IVA por defecto:* ${company.defaultTaxRate !== null && company.defaultTaxRate !== undefined ? company.defaultTaxRate + '%' : 'No indicado'}`,
      `• *IRPF:* ${company.irpfRate ? company.irpfRate + '%' : '0% (No aplica / Sin retención)'}`,
      `• *Serie facturas:* ${company.invoiceSeries || 'No configurada'}`,
      `• *Teléfono:* ${company.phone || 'No indicado'}`,
      `• *Email:* ${company.email || 'No indicado'}`,
      `• *IBAN:* ${company.iban || 'No configurado'}`,
      `• *Bizum profesional:* ${company.bizum || 'No configurado'}`,
      `• *Email de tu Gestoría:* ${company.gestoriaEmail ? `*${company.gestoriaEmail}*` : '❌ _No configurado_'}`,
      `🖼️ *Logotipo:* ${hasLogo ? '✅ Configurado (se incluye en tus PDFs)' : '❌ Sin logotipo (envía una foto con el texto "logo")'}`,
      `📌 *Estado de perfil:* ${isConf ? '🟢 Configurado y activo' : '🟡 Pendiente de completar'}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      '💡 _Para reiniciar el cuestionario guiado di: "configurar todo" o "empezar de nuevo"._\n💡 _Para cambiar oficio rápido di: "Soy electricista", "Soy fontanero", etc._'
    ].join('\n');
  }

  function findBudgetInSession(session, query) {
    if (!query || query.trim() === '') {
      if (session.activeBudgetId && session.budgets.has(session.activeBudgetId)) {
        return session.budgets.get(session.activeBudgetId);
      }
      if (session.budgets.size === 1) {
        return Array.from(session.budgets.values())[0];
      }
      return null;
    }
    const q = query.toLowerCase().trim();
    for (const [id, b] of session.budgets.entries()) {
      if (id.toLowerCase().includes(q)) return b;
      if (b.client?.name && b.client.name.toLowerCase().includes(q)) return b;
    }
    if (session.activeBudgetId && session.budgets.has(session.activeBudgetId)) {
      return session.budgets.get(session.activeBudgetId);
    }
    return null;
  }

  async function emitInvoiceForBudget(sock, remoteJid, session, targetBudget, clientNif = null) {
    if (!targetBudget) {
      const sentErr = await sock.sendMessage(remoteJid, {
        text: '⚠️ *No se encontró el presupuesto para facturar.*\n\nPor favor, indica el nombre del cliente o el número de presupuesto (ej: *"facturar presupuesto PRE-2026-5129"* o *"factura de José Luis"*).'
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
      return;
    }

    try {
      console.log(`🧾 Emitiendo factura legal para el presupuesto ${targetBudget.id}...`);
      const invoice = engine.convertToInvoice(targetBudget, { clientNif, company: session.company });

      if (!session.invoices) session.invoices = new Map();
      session.invoices.set(invoice.id, invoice);

      // Persistir factura en SQLite
      const cleanPhone = session.phone || remoteJid.replace(/\D/g, '');
      saveInvoice(cleanPhone, invoice);

      // Generar PDF formal de Factura
      const invoicePdfBuffer = await generateInvoicePDF(invoice);
      const invoiceFileName = `Factura_${invoice.id}.pdf`;

      // Texto de resumen de factura para WhatsApp
      const fin = invoice.financials || {};
      const advance = fin.advanceAmount || 0;
      const remaining = fin.remainingAmount !== undefined ? fin.remainingAmount : (fin.totalAmount || 0);
      const isSettlement = Boolean(invoice.advanceDeductions && invoice.advanceDeductions.length > 0);
      const title = isSettlement ? `🧾 *FACTURA OFICIAL DE LIQUIDACIÓN: ${invoice.id}*` : `🧾 *FACTURA OFICIAL EMITIDA: ${invoice.id}*`;

      const invoiceMsgLines = [
        title,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `👤 *Cliente:* ${invoice.client.name}`,
        `📍 *Dirección:* ${invoice.client.address}`,
        `📄 *Presupuesto de origen:* ${invoice.budgetId}`,
        `📅 *Fecha emisión:* ${invoice.issueDate}`,
        ''
      ];

      if (isSettlement) {
        invoiceMsgLines.push(`💰 *Base Imponible total obra:* ${fin.taxableBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
        invoice.advanceDeductions.forEach(adv => {
          invoiceMsgLines.push(`📉 *Menos Anticipo (Factura ${adv.id}):* -${adv.taxableBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
        });
        const netBase = Math.max(0, fin.taxableBase - (fin.advanceTaxableBase || 0));
        const netTax = Math.max(0, fin.taxAmount - (fin.advanceTaxAmount || 0));
        invoiceMsgLines.push(`💵 *Base Imponible a liquidar:* ${netBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
        invoiceMsgLines.push(`📊 *IVA liquidado (${fin.taxRatePercentage}%):* ${netTax.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
        invoiceMsgLines.push(`🏷️ *TOTAL A PAGAR LIQUIDACIÓN:* *${remaining.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €*`);
      } else {
        invoiceMsgLines.push(`💰 *Base Imponible:* ${fin.taxableBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
        invoiceMsgLines.push(`📊 *IVA (${fin.taxRatePercentage}%):* ${fin.taxAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
        invoiceMsgLines.push(`🏷️ *TOTAL FACTURA:* *${fin.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €*`);
        if (advance > 0) {
          invoiceMsgLines.push(`💵 *Anticipo abonado:* -${advance.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`);
          invoiceMsgLines.push(`💳 *TOTAL PENDIENTE DE COBRO:* *${remaining.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €*`);
        }
      }

      invoiceMsgLines.push('');
      invoiceMsgLines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
      invoiceMsgLines.push('🏦 *Datos bancarios para cobro:*');
      if (session.company?.iban) {
        invoiceMsgLines.push(`• IBAN: *${session.company.iban}*`);
      }
      if (session.company?.bizum) {
        invoiceMsgLines.push(`• Bizum profesional: *${session.company.bizum}*`);
      }

      const sentSummary = await sock.sendMessage(remoteJid, { text: invoiceMsgLines.join('\n') });
      if (sentSummary?.key?.id) botSentMessageIds.add(sentSummary.key.id);

      // Enviar documento PDF de factura adjunto
      const sentDoc = await sock.sendMessage(remoteJid, {
        document: invoicePdfBuffer,
        mimetype: 'application/pdf',
        fileName: invoiceFileName,
        caption: `🧾 *${invoiceFileName}*\nFactura legal formal conforme al RD 1619/2012 con validez fiscal ante Hacienda.`
      });
      if (sentDoc?.key?.id) botSentMessageIds.add(sentDoc.key.id);

      console.log(`✅ Factura ${invoice.id} (${invoicePdfBuffer.length} bytes) enviada por WhatsApp.`);

      // Opciones posteriores
      const followUpText = [
        '👉 *Opciones disponibles:*',
        '• Si quieres ver todos tus presupuestos y facturas responde *1*.',
        '• Para consultar tus números para la gestoría di *"gestoría"*.',
        '• Si quieres un presupuesto nuevo manda un audio o texto diciendo *presupuesto nuevo*.'
      ].join('\n');

      const sentOpts = await sock.sendMessage(remoteJid, { text: followUpText });
      if (sentOpts?.key?.id) botSentMessageIds.add(sentOpts.key.id);

    } catch (invErr) {
      console.error('❌ Error generando factura:', invErr.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *No se pudo generar la factura:* ${invErr.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleAdvanceInvoice(sock, remoteJid, session, targetBudget, clientNif = null, explicitPaymentInfo = null, sendSigningLink = false) {
    if (!targetBudget) {
      const sentErr = await sock.sendMessage(remoteJid, {
        text: '⚠️ *No se encontró el presupuesto para emitir la factura de anticipo.*\n\nPor favor, indica el nombre del cliente o número de obra (ej: *"factura de anticipo de Juan"*).'
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
      return;
    }

    try {
      const fin = targetBudget.financials || {};
      const paidSoFar = targetBudget.paymentSummary?.totalPaid || 0;
      const customAmount = explicitPaymentInfo?.amount;
      const advanceAmount = (customAmount && customAmount > 0)
        ? customAmount
        : (paidSoFar > 0 ? paidSoFar : (fin.advanceAmount || (fin.totalAmount ? Number((fin.totalAmount * 0.3).toFixed(2)) : 300)));
      
      const payments = targetBudget.payments || [];
      const lastMethod = explicitPaymentInfo?.method || (payments.length > 0 ? payments[payments.length - 1].method : 'Transferencia bancaria / Bizum');
      const lastDate = explicitPaymentInfo?.date || (payments.length > 0 ? payments[payments.length - 1].date : new Date().toLocaleDateString('es-ES'));

      console.log(`🧾 Emitiendo Factura Legal de Anticipo (${advanceAmount} €) para ${targetBudget.id}...`);

      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');

      // Registrar también el cobro en el presupuesto si se indicó un importe explícito
      if (customAmount && customAmount > 0) {
        engine.registerPayment(targetBudget, {
          amount: advanceAmount,
          method: lastMethod,
          date: lastDate,
          concept: 'Anticipo para inicio de obra'
        });
      }

      const advanceInvoice = engine.createAdvanceInvoice(targetBudget, {
        amount: advanceAmount,
        method: lastMethod,
        date: lastDate
      }, { clientNif, company: session.company });

      if (!session.invoices) session.invoices = new Map();
      session.invoices.set(advanceInvoice.id, advanceInvoice);

      saveInvoice(cleanPhone, advanceInvoice);
      saveBudget(cleanPhone, targetBudget);

      const invoicePdfBuffer = await generateInvoicePDF(advanceInvoice);
      const invoiceFileName = `Factura_Anticipo_${advanceInvoice.id}.pdf`;

      const advFin = advanceInvoice.financials || {};
      const invoiceMsgLines = [
        `🧾 *FACTURA OFICIAL DE ANTICIPO: ${advanceInvoice.id}*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `👤 *Cliente:* ${advanceInvoice.client.name}`,
        `📍 *Dirección:* ${advanceInvoice.client.address}`,
        `📄 *Presupuesto de referencia:* ${advanceInvoice.budgetId}`,
        `📅 *Fecha emisión / devengo:* ${advanceInvoice.issueDate}`,
        '',
        `💰 *Base Imponible Anticipo:* ${advFin.taxableBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`,
        `📊 *IVA (${advFin.taxRatePercentage}%):* ${advFin.taxAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`,
        `🏷️ *TOTAL FACTURA ANTICIPO:* *${advFin.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €*`,
        '',
        '⚖️ _Factura emitida conforme al Art. 75.Dos de la Ley 37/1992 del IVA (devengo anticipado) y RD 1619/2012. Esta base e IVA se deducirán automáticamente al emitir la factura final de liquidación._',
        '━━━━━━━━━━━━━━━━━━━━━━━━━'
      ];

      const sentSummary = await sock.sendMessage(remoteJid, { text: invoiceMsgLines.join('\n') });
      if (sentSummary?.key?.id) botSentMessageIds.add(sentSummary.key.id);

      const sentDoc = await sock.sendMessage(remoteJid, {
        document: invoicePdfBuffer,
        mimetype: 'application/pdf',
        fileName: invoiceFileName,
        caption: `🧾 *${invoiceFileName}*\nFactura legal de anticipo lista para entregar al cliente o deducir en gestoría.`
      });
      if (sentDoc?.key?.id) botSentMessageIds.add(sentDoc.key.id);

      console.log(`✅ Factura de anticipo ${advanceInvoice.id} enviada por WhatsApp.`);

      // Si además se solicitó el enlace para firmar
      if (sendSigningLink) {
        const signingUrl = generateSigningUrl(targetBudget, session.company, cleanPhone);
        const sentSig = await sock.sendMessage(remoteJid, {
          text: `✍️ *Enlace para firma del cliente — Presupuesto ${targetBudget.id}:*\n${signingUrl}\n\n📲 _Puedes reenviárselo a ${targetBudget.client?.name || 'tu cliente'} para que lo firme y acepte las condiciones de la obra._`
        });
        if (sentSig?.key?.id) botSentMessageIds.add(sentSig.key.id);
      }

      const followUpText = [
        '👉 *Opciones disponibles:*',
        '• Para emitir la factura final de liquidación cuando acaben los trabajos di *"facturar"*.',
        '• Para consultar tus números para la gestoría di *"gestoría"*.',
        '• Para un nuevo trabajo di *"presupuesto nuevo"*.'
      ].join('\n');

      const sentOpts = await sock.sendMessage(remoteJid, { text: followUpText });
      if (sentOpts?.key?.id) botSentMessageIds.add(sentOpts.key.id);

    } catch (advErr) {
      console.error('❌ Error emitiendo factura de anticipo:', advErr.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *No se pudo generar la factura de anticipo:* ${advErr.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handlePaymentRegistration(sock, remoteJid, session, targetBudget, paymentInfo = {}) {
    if (!targetBudget) {
      const sentErr = await sock.sendMessage(remoteJid, {
        text: '⚠️ *No se encontró el presupuesto para registrar el cobro.*\n\nPor favor, indica el nombre del cliente o número de obra (ej: *"cobro 1.500€ de José Luis"* o *"apunta pago de 800€ para PRE-2026-..."*).'
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
      return;
    }

    const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
    let amount = Number(paymentInfo.amount);

    const remainingBalance = targetBudget.paymentSummary?.remainingBalance !== undefined
      ? targetBudget.paymentSummary.remainingBalance
      : (targetBudget.financials?.totalAmount || 0);

    // Si no se detectó un importe explícito (ej: el usuario dijo "pago recibido", "pago completo", "factura pagada", etc.)
    if (!amount || isNaN(amount) || amount <= 0) {
      if (remainingBalance > 0) {
        amount = remainingBalance;
        paymentInfo.amount = remainingBalance;
        paymentInfo.concept = paymentInfo.concept || 'Liquidación final de obra y factura';
      } else {
        const sentErr = await sock.sendMessage(remoteJid, {
          text: '⚠️ *Importe de cobro no detectado o el presupuesto ya está liquidado.*\n\nPor favor, especifica la cantidad que te han pagado (ej: *"Alberto me ha pagado 1.500€"*).'
        });
        if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
        return;
      }
    }

    try {
      console.log(`💰 Registrando cobro de ${amount} € para el presupuesto ${targetBudget.id}...`);
      const { receipt } = engine.registerPayment(targetBudget, paymentInfo);

      // Persistir cobro y asegurar que el presupuesto pasa a estado FINALIZADO (si saldo es 0) o ACEPTADO
      targetBudget.status = receipt.remainingBalance <= 0 ? 'FINALIZADO' : 'ACEPTADO';
      savePayment(cleanPhone, receipt);
      saveBudget(cleanPhone, targetBudget);

      // Si la obra queda liquidada o se cubre el saldo, actualizar las facturas pendientes a 'PAGADA'
      if (receipt.remainingBalance <= 0) {
        const allInvoices = listInvoices(cleanPhone, 50);
        for (const inv of allInvoices) {
          if (inv.budgetId === targetBudget.id && inv.status !== 'PAGADA') {
            inv.status = 'PAGADA';
            inv.paidAt = new Date().toISOString();
            saveInvoice(cleanPhone, inv);
            if (session.invoices && session.invoices.has(inv.id)) {
              session.invoices.set(inv.id, inv);
            }
            console.log(`✅ Factura ${inv.id} actualizada automáticamente a estado 'PAGADA' en SQLite y sesión.`);
          }
        }
      }

      // Generar PDF formal del recibo
      const receiptPdfBuffer = await generateReceiptPDF(receipt);
      const receiptFileName = `Recibo_${receipt.id}.pdf`;

      const isSettled = receipt.status === 'LIQUIDADO';
      const statusEmoji = isSettled ? '✅' : '⏳';
      const statusTitle = isSettled ? '*¡OBRA TOTALMENTE LIQUIDADA Y COBRADA!*' : '*ANTICIPO / PAGO A CUENTA REGISTRADO*';

      const paymentMsgLines = [
        `💰 ${statusTitle}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `👤 *Cliente:* ${receipt.client?.name || 'Cliente'}`,
        `📍 *Dirección:* ${receipt.client?.address || 'Ubicación de obra'}`,
        `📄 *Presupuesto:* ${receipt.budgetId} (🟢 *Estado:* Aceptado)`,
        `💵 *Importe recibido:* *+${receipt.amount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €*`,
        `💳 *Método de pago:* ${receipt.method}`,
        `📝 *Concepto:* ${receipt.concept}`,
        `📅 *Fecha valor:* ${receipt.date}`,
        '',
        '📊 *ESTADO ACTUAL DE LA CUENTA:*',
        `• Total obra presupuestado: ${receipt.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`,
        `• Total cobrado acumulado: ${receipt.totalPaid.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`,
        `• ${statusEmoji} *SALDO PENDIENTE:* *${receipt.remainingBalance.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        '📄 _Se adjunta el Justificante Oficial de Cobro en PDF (no requiere firma del cliente, es emitido formalmente por tu empresa)._'
      ];

      const sentSummary = await sock.sendMessage(remoteJid, { text: paymentMsgLines.join('\n') });
      if (sentSummary?.key?.id) botSentMessageIds.add(sentSummary.key.id);

      // Enviar documento PDF del recibo
      const sentDoc = await sock.sendMessage(remoteJid, {
        document: receiptPdfBuffer,
        mimetype: 'application/pdf',
        fileName: receiptFileName,
        caption: `📄 *${receiptFileName}*\nJustificante oficial de cobro expedido por ${receipt.company?.name || 'la empresa'}.`
      });
      if (sentDoc?.key?.id) botSentMessageIds.add(sentDoc.key.id);

      console.log(`✅ Recibo ${receipt.id} (${receiptPdfBuffer.length} bytes) enviado por WhatsApp.`);

      // Opciones posteriores
      const followUpText = [
        '👉 *Opciones disponibles:*',
        '• Si deseas emitir la *Factura Oficial de Anticipo* con IVA desglosado responde *"factura de anticipo"*.',
        '• Si quieres ver el resumen de todas tus cuentas responde *1*.',
        '• Para emitir la factura final di *"facturar"*.',
        '• Si quieres un presupuesto nuevo di *presupuesto nuevo*.'
      ].join('\n');

      const sentOpts = await sock.sendMessage(remoteJid, { text: followUpText });
      if (sentOpts?.key?.id) botSentMessageIds.add(sentOpts.key.id);

    } catch (payErr) {
      console.error('❌ Error registrando cobro:', payErr.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *No se pudo registrar el cobro:* ${payErr.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleQueryBalance(sock, remoteJid, session, targetBudget) {
    if (!targetBudget) {
      const sentErr = await sock.sendMessage(remoteJid, {
        text: '⚠️ *No se encontró el presupuesto para consultar el saldo.*\n\nPor favor, indica el nombre del cliente (ej: *"¿cuánto me debe José Luis?"*).'
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
      return;
    }

    const summary = engine.getPaymentSummary(targetBudget);
    const isSettled = summary.status === 'LIQUIDADO';
    const statusEmoji = isSettled ? '✅' : (summary.status === 'PARCIAL' ? '⏳' : '🔴');
    const statusText = isSettled ? 'Totalmente pagado (sin deuda)' : (summary.status === 'PARCIAL' ? 'Pago parcial' : 'Pendiente de cobro íntegro');

    const lines = [
      `📊 *ESTADO DE CUENTA: ${summary.clientName}*`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      `📄 *Presupuesto:* ${summary.budgetId}`,
      `💰 *Total de la obra:* ${summary.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`,
      `💵 *Total cobrado:* ${summary.totalPaid.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`,
      `📌 *Estado:* ${statusEmoji} ${statusText}`,
      '',
      `⚠️ *SALDO PENDIENTE DE COBRO:* *${summary.remainingBalance.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €*`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━'
    ];

    if (summary.payments && summary.payments.length > 0) {
      lines.push('🧾 *Pagos registrados:*');
      summary.payments.forEach((p, idx) => {
        lines.push(`${idx + 1}. ${p.date}: *+${p.amount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €* (${p.method} - ${p.concept})`);
      });
    } else {
      lines.push('ℹ️ _Aún no se ha registrado ningún cobro para este cliente._');
    }

    const sentSummary = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
    if (sentSummary?.key?.id) botSentMessageIds.add(sentSummary.key.id);
  }

  async function handleAcceptBudget(sock, remoteJid, session, targetBudget) {
    if (!targetBudget) {
      const sentErr = await sock.sendMessage(remoteJid, {
        text: '⚠️ *No se encontró el presupuesto para marcar como aceptado.*\n\nIndica el nombre del cliente o número de obra (ej: *"aceptar presupuesto de Alberto"* o *"presupuesto aceptado"*).'
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
      return;
    }

    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      targetBudget.status = 'ACEPTADO';
      saveBudget(cleanPhone, targetBudget);

      const total = targetBudget.financials?.totalAmount ? `${targetBudget.financials.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €` : '';
      const advance = targetBudget.financials?.advanceAmount ? `${targetBudget.financials.advanceAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €` : '';

      const lines = [
        '🎉 *¡PRESUPUESTO MARCADO COMO ACEPTADO!*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `🆔 *Documento:* ${targetBudget.id}`,
        `👤 *Cliente:* ${targetBudget.client?.name || 'Cliente Particular'}`,
        `📍 *Ubicación:* ${targetBudget.client?.address || 'Ubicación de obra'}`,
        `💰 *Total Presupuestado:* *${total}*`,
        advance ? `💳 *Anticipo pactado:* ${advance} (${targetBudget.financials?.advancePercentage || 30}%)` : null,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        '🟢 *Nuevo estado:* *Aceptado* (antes: _Pendiente de aceptación_)',
        '',
        '💡 _Si el cliente te ha pagado el anticipo por transferencia bancaria o Bizum, puedes registrarlo diciendo:_\n*"Apunta anticipo de [importe]€ por transferencia"*'
      ].filter(Boolean);

      const sent = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
      console.log(`✅ Presupuesto ${targetBudget.id} marcado como ACEPTADO para ${cleanPhone}`);
    } catch (err) {
      console.error('❌ Error aceptando presupuesto:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error al marcar el presupuesto como aceptado:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  function formatQuarterSummaryForWhatsApp(company, quarterData) {
    const s = quarterData.summary;
    const formatEur = (n) => `${Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

    const lines = [
      `📊 *INFORME FISCAL PARA GESTORÍA — ${quarterData.quarterLabel}*`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      `🏢 *Empresa:* ${company.name || 'Empresa'} (${company.cif || 'Sin CIF'})`,
      `📅 *Periodo:* ${quarterData.startDateFormatted} al ${quarterData.endDateFormatted}`,
      '',
      '📈 *LIQUIDACIÓN ESTIMADA IVA (MOD. 303):*',
      `• Facturas emitidas: *${s.totalInvoices}*`,
      `• Base Imponible Total: *${formatEur(s.totalTaxableBase)}*`,
      `• Cuota IVA al 10% (reducido): ${formatEur(s.tax10)} _(Base: ${formatEur(s.base10)})_`,
      `• Cuota IVA al 21% (general): ${formatEur(s.tax21)} _(Base: ${formatEur(s.base21)})_`,
      `📌 *TOTAL IVA REPERCUTIDO A DECLARAR:* *${formatEur(s.totalTaxAmount)}*`,
      `🏷️ *TOTAL FACTURADO:* *${formatEur(s.totalAmount)}*`,
      '',
      '💳 *ESTADO DE COBROS Y TESORERÍA:*',
      `• Cobrado acumulado: *${formatEur(s.totalPaid)}* (${s.paidCount} cobradas)`,
      `• ${s.totalRemaining > 0 ? '⏳' : '✅'} Saldo pendiente de cobro: *${formatEur(s.totalRemaining)}* (${s.pendingCount} pendientes)`
    ];

    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📎 _Te adjunto el **Libro de Facturas en Excel (CSV)** y el **Informe Oficial en PDF** listos para enviar a tu gestor._');

    if (company.gestoriaEmail) {
      lines.push(`\n📧 *Email de tu gestoría configurado:* ${company.gestoriaEmail}`);
      lines.push('💡 _Para enviárselo directamente por correo di: "Enviar a mi gestoría"_');
    } else {
      lines.push('\n💡 _Si quieres enviarlo por email con 1 clic, guarda el correo de tu gestor diciendo:_\n*"Mi gestoría es despacho@asesoria.com"*');
    }

    return lines.join('\n');
  }

  async function handleQuarterExport(sock, remoteJid, session, quarterInput = null, yearInput = null, sendToGestoria = false) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const quarterData = getQuarterInvoices(cleanPhone, quarterInput, yearInput);

      console.log(`📊 Generando exportación fiscal para ${cleanPhone} (${quarterData.quarterLabel})... Facturas: ${quarterData.invoices.length}`);

      if (quarterData.invoices.length === 0) {
        const sentEmpty = await sock.sendMessage(remoteJid, {
          text: `📂 *No se encontraron facturas emitidas en el periodo ${quarterData.quarterLabel}*\n(${quarterData.startDateFormatted} al ${quarterData.endDateFormatted})\n\n💡 _Para emitir una factura legal de una obra existente, di por ejemplo: *"facturar"* o *"facturar el de José Luis"*. En cuanto emitas tu primera factura podrás exportar el libro trimestral completo._`
        });
        if (sentEmpty?.key?.id) botSentMessageIds.add(sentEmpty.key.id);
        return;
      }

      // 1. Generar CSV estándar para gestorías
      const csvContent = generateQuarterCSV(session.company, quarterData);
      const csvBuffer = Buffer.from(csvContent, 'utf8');
      const cleanLabel = quarterData.quarterLabel.replace(/\s+/g, '_');
      const csvFileName = `Libro_Facturas_Emitidas_${cleanLabel}.csv`;

      // 2. Generar PDF oficial
      const pdfBuffer = await generateQuarterTaxPDF(session.company, quarterData);
      const pdfFileName = `Informe_Fiscal_Gestoria_${cleanLabel}.pdf`;

      // 3. Enviar resumen en texto a WhatsApp
      const summaryText = formatQuarterSummaryForWhatsApp(session.company, quarterData);
      const sentText = await sock.sendMessage(remoteJid, { text: summaryText });
      if (sentText?.key?.id) botSentMessageIds.add(sentText.key.id);

      // 4. Enviar archivo CSV para Excel
      const sentCsv = await sock.sendMessage(remoteJid, {
        document: csvBuffer,
        mimetype: 'text/csv',
        fileName: csvFileName,
        caption: `📊 *${csvFileName}*\nLibro Oficial normalizado en Excel/CSV (con delimitador punto y coma y UTF-8 con BOM para apertura directa en Microsoft Excel, A3 y Contasol).`
      });
      if (sentCsv?.key?.id) botSentMessageIds.add(sentCsv.key.id);

      // 5. Enviar archivo PDF del informe fiscal
      const sentPdf = await sock.sendMessage(remoteJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: pdfFileName,
        caption: `📄 *${pdfFileName}*\nInforme fiscal en PDF con desglose de bases y cuotas de IVA para la liquidación del Modelo 303 de la AEAT.`
      });
      if (sentPdf?.key?.id) botSentMessageIds.add(sentPdf.key.id);

      console.log(`✅ Archivos de trimestre ${quarterData.quarterLabel} enviados por WhatsApp con éxito.`);

      // 6. Si el usuario solicitó envío directo por email a su gestoría
      if (sendToGestoria || (typeof quarterInput === 'string' && /enviar|mandar/i.test(quarterInput))) {
        if (!session.company.gestoriaEmail) {
          const sentNoEmail = await sock.sendMessage(remoteJid, {
            text: '⚠️ *No tienes configurado el email de tu gestoría.*\n\nEscribe *"mi gestoría es correo@ejemplo.com"* para guardarlo y poder enviarlo en 1 clic.'
          });
          if (sentNoEmail?.key?.id) botSentMessageIds.add(sentNoEmail.key.id);
        } else if (!resend) {
          const sentNoResend = await sock.sendMessage(remoteJid, {
            text: '⚠️ *El servicio de correo electrónico no está configurado en el servidor.*'
          });
          if (sentNoResend?.key?.id) botSentMessageIds.add(sentNoResend.key.id);
        } else {
          try {
            console.log(`📧 Enviando trimestre por email a la gestoría (${session.company.gestoriaEmail})...`);
            await resend.emails.send({
              from: 'PresuVoz <onboarding@resend.dev>',
              to: session.company.gestoriaEmail,
              subject: `Cierre Fiscal y Facturas ${quarterData.quarterLabel} — ${session.company.name}`,
              html: `
                <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px;">
                  <h2 style="color: #1e40af; margin-bottom: 5px;">Libro de Facturas y Cierre Fiscal — ${quarterData.quarterLabel}</h2>
                  <p style="color: #64748b; font-size: 14px; margin-top: 0;">Periodo: ${quarterData.startDateFormatted} al ${quarterData.endDateFormatted}</p>
                  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 15px 0;">
                  <p>Estimada asesoría / gestoría,</p>
                  <p>Remitimos adjunto el <b>Libro Oficial de Facturas Emitidas</b> y el <b>Informe Fiscal</b> de la empresa <b>${session.company.name}</b> (CIF: <b>${session.company.cif}</b>) para la preparación de las declaraciones tributarias del <b>${quarterData.quarterLabel}</b>.</p>
                  <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 15px; margin: 15px 0;">
                    <h4 style="margin: 0 0 10px 0; color: #0f172a;">Resumen Económico Declarable (Modelo 303):</h4>
                    <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">
                      <li><b>Facturas expedidas:</b> ${quarterData.summary.totalInvoices}</li>
                      <li><b>Base Imponible Total:</b> ${quarterData.summary.totalTaxableBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</li>
                      <li><b>Cuota IVA 10%:</b> ${quarterData.summary.tax10.toLocaleString('es-ES', { minimumFractionDigits: 2 })} € (Base: ${quarterData.summary.base10.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €)</li>
                      <li><b>Cuota IVA 21%:</b> ${quarterData.summary.tax21.toLocaleString('es-ES', { minimumFractionDigits: 2 })} € (Base: ${quarterData.summary.base21.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €)</li>
                      <li><b>Total IVA Repercutido:</b> ${quarterData.summary.totalTaxAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</li>
                      <li><b>Total Facturado:</b> <b>${quarterData.summary.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</b></li>
                    </ul>
                  </div>
                  <p style="font-size: 13px; color: #64748b;">Se adjuntan los archivos <b>${csvFileName}</b> (Excel) y <b>${pdfFileName}</b> (PDF oficial).</p>
                  <br>
                  <p>Atentamente,<br><b>${session.company.name}</b><br>Tel: ${session.company.phone || ''}</p>
                </div>
              `,
              attachments: [
                { filename: csvFileName, content: csvBuffer },
                { filename: pdfFileName, content: pdfBuffer }
              ]
            });

            const sentEmailOk = await sock.sendMessage(remoteJid, {
              text: `📧 *¡Enviado con éxito a tu gestoría!*\n\nSe han remitido el Excel y el PDF por correo a *${session.company.gestoriaEmail}* para que preparen tus impuestos.`
            });
            if (sentEmailOk?.key?.id) botSentMessageIds.add(sentEmailOk.key.id);
            console.log(`✅ Email enviado con éxito a ${session.company.gestoriaEmail}`);
          } catch (mailErr) {
            console.error('❌ Error enviando email a gestoría:', mailErr.message);
            const sentEmailErr = await sock.sendMessage(remoteJid, {
              text: `⚠️ *No se pudo enviar el email a la gestoría:* ${mailErr.message}`
            });
            if (sentEmailErr?.key?.id) botSentMessageIds.add(sentEmailErr.key.id);
          }
        }
      }

    } catch (exportErr) {
      console.error('❌ Error exportando trimestre:', exportErr);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error generando la exportación del trimestre:* ${exportErr.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  function formatAppointmentForWhatsApp(app, company) {
    const query = app.clientAddress ? `${app.clientAddress}` : (app.clientName || 'Ubicación');
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

    const dateParts = (app.date || '').split('-');
    const formattedDate = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}` : app.date;

    const lines = [
      '📅 *VISITA TÉCNICA AGENDADA*',
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      `🆔 *Ref:* ${app.id}`,
      `👤 *Cliente:* ${app.clientName}`,
      app.clientPhone ? `📞 *Teléfono:* ${app.clientPhone}` : null,
      `📍 *Dirección:* ${app.clientAddress || 'Por concretar'}`,
      `🗓️ *Fecha:* ${formattedDate}`,
      `⏰ *Hora:* ${app.time} h`,
      `📝 *Motivo:* ${app.notes}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      '🗺️ *Abrir ruta en Google Maps:*',
      mapsUrl,
      '',
      '💬 *Mensaje listo para reenviar a tu cliente:*',
      `_"Hola ${app.clientName.split(' ')[0]}, te confirmamos la visita técnica para valorar los trabajos el ${formattedDate} a las ${app.time} h${app.clientAddress ? ` en ${app.clientAddress}` : ''}. ¡Nos vemos entonces! (${company?.name || 'El técnico'})"_`
    ].filter(Boolean);

    return lines.join('\n');
  }

  function formatAppointmentsListForWhatsApp(appointments, title = '📅 *TUS VISITAS TÉCNICAS AGENDADAS:*') {
    if (!appointments || appointments.length === 0) {
      return '📅 *AGENDA VACÍA*\n\nNo tienes visitas técnicas en tu agenda.\n\n💡 _Para apuntar una cita di por ejemplo: "Apunta visita con Juan el jueves a las 11:00 en Calle Mayor 14 para ver la caldera"_.';
    }

    let text = `${title}\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    appointments.forEach((app, idx) => {
      const dateParts = (app.date || '').split('-');
      const formattedDate = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}` : app.date;
      const query = app.clientAddress ? `${app.clientAddress}` : app.clientName;
      const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

      text += `\n${idx + 1}️⃣ *${formattedDate} a las ${app.time} h* · ${app.clientName}\n`;
      if (app.clientPhone) text += `   📞 ${app.clientPhone}\n`;
      if (app.clientAddress) text += `   📍 ${app.clientAddress}\n`;
      if (app.notes) text += `   📝 ${app.notes}\n`;
      if (app.clientAddress) text += `   🗺️ ${mapsUrl}\n`;
    });

    text += '\n━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Para anular una cita di: "Cancela la cita con [Nombre]"_\n💡 _Para agendar otra di: "Apunta visita con [Nombre] el [Día] a las [Hora]"_';
    return text;
  }

  async function handleScheduleAppointment(sock, remoteJid, session, appointmentInfo = {}) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      
      // Chequeo de colisión de horario (Aviso sin bloquear)
      const conflicts = findConflictingAppointments(cleanPhone, appointmentInfo.date, appointmentInfo.time);
      
      const saved = saveAppointment(cleanPhone, appointmentInfo);
      console.log(`📅 Cita técnica agendada para ${cleanPhone}: ${saved.id} - ${saved.clientName} (${saved.date} ${saved.time})`);
      
      let conflictWarning = '';
      if (conflicts.length > 0) {
        conflictWarning = `\n\n⚠️ *Aviso de horario:* Ya tenías una visita agendada a esa misma hora con *${conflicts[0].clientName}*. He registrado ambas en tu agenda.`;
      }

      const text = formatAppointmentForWhatsApp(saved, session.company) + conflictWarning;
      const sent = await sock.sendMessage(remoteJid, { text });
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
    } catch (err) {
      console.error('❌ Error agendando cita:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error guardando la cita:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleListAppointments(sock, remoteJid, session, filter = 'all') {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const appointments = listAppointments(cleanPhone, filter);

      let title = '📅 *TUS VISITAS TÉCNICAS AGENDADAS:*';
      if (filter === 'today') title = '📅 *TUS VISITAS TÉCNICAS DE HOY:*';
      else if (filter === 'tomorrow') title = '📅 *TUS VISITAS TÉCNICAS DE MAÑANA:*';
      else if (filter === 'completed') title = '✅ *VISITAS TÉCNICAS REALIZADAS:*';
      else if (filter === 'past') title = '🕒 *HISTORIAL DE VISITAS PASADAS:*';

      const text = formatAppointmentsListForWhatsApp(appointments, title);
      const sent = await sock.sendMessage(remoteJid, { text });
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
    } catch (err) {
      console.error('❌ Error listando citas:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error consultando la agenda:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleCancelAppointment(sock, remoteJid, session, query) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const cancelled = cancelAppointment(cleanPhone, query);
      if (!cancelled) {
        const sentNotFound = await sock.sendMessage(remoteJid, {
          text: `⚠️ *No se encontró ninguna visita activa* que coincida con "${query}".\n\nEscribe *"agenda"* para ver tus citas programadas.`
        });
        if (sentNotFound?.key?.id) botSentMessageIds.add(sentNotFound.key.id);
        return;
      }

      if (cancelled.ambiguous) {
        const lines = [
          `⚠️ *Tienes varias visitas con "${query}":*`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━'
        ];
        cancelled.matches.forEach((m, idx) => {
          lines.push(`${idx + 1}️⃣ *${m.date} a las ${m.time} h* — ${m.clientName} (${m.id})`);
        });
        lines.push('\n¿Cuál de ellas deseas anular?');
        const sentAmb = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
        if (sentAmb?.key?.id) botSentMessageIds.add(sentAmb.key.id);
        return;
      }

      const dateParts = (cancelled.date || '').split('-');
      const formattedDate = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}` : cancelled.date;

      const sentOk = await sock.sendMessage(remoteJid, {
        text: `❌ *Visita cancelada*\n\nHe anulado la visita con *${cancelled.clientName}* prevista para el ${formattedDate} a las ${cancelled.time} h (${cancelled.id}).\n\nEl hueco ha quedado libre en tu agenda.`
      });
      if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
      console.log(`❌ Cita ${cancelled.id} cancelada para ${cleanPhone}`);
    } catch (err) {
      console.error('❌ Error cancelando cita:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error cancelando la cita:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleUpdateAppointment(sock, remoteJid, session, updateInfo = {}) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const query = updateInfo.appointmentQuery || updateInfo.clientName || '';
      
      // Si el usuario pide cambiar fecha u hora, usamos rescheduleAppointment para trazabilidad total
      if (updateInfo.date || updateInfo.time) {
        const res = rescheduleAppointment(cleanPhone, query, updateInfo.date, updateInfo.time, 'Reagendamiento por WhatsApp');
        if (!res.success) {
          if (res.error === 'AMBIGUOUS') {
            const lines = [
              `⚠️ *Tienes varias visitas con "${query}":*`,
              '━━━━━━━━━━━━━━━━━━━━━━━━━'
            ];
            res.matches.forEach((m, idx) => {
              lines.push(`${idx + 1}️⃣ *${m.date} a las ${m.time} h* — ${m.clientName}`);
            });
            lines.push('\n¿A cuál de ellas te refieres? Indícame la fecha o la hora.');
            const sentAmb = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
            if (sentAmb?.key?.id) botSentMessageIds.add(sentAmb.key.id);
            return;
          }
          const sentNotFound = await sock.sendMessage(remoteJid, {
            text: `⚠️ No encontré ninguna visita activa que coincida con *"${query}"*.\n\nEscribe *"agenda"* para ver tus citas.`
          });
          if (sentNotFound?.key?.id) botSentMessageIds.add(sentNotFound.key.id);
          return;
        }

        const apt = res.appointment;
        const dp = (apt.date || '').split('-');
        const fd = dp.length === 3 ? `${dp[2]}/${dp[1]}/${dp[0]}` : apt.date;
        const sentOk = await sock.sendMessage(remoteJid, {
          text: `🗓️ *Visita reagendada con éxito*\n\nHe movido la visita con *${apt.clientName}* al *${fd}* a las *${apt.time} h*.\n\n_Se ha actualizado en tu agenda y el contador de reagendamientos es ${apt.rescheduleCount}._`
        });
        if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
        return;
      }

      // Modificación de dirección, notas o nombre
      const changes = {
        clientAddress: updateInfo.clientAddress || null,
        notes: updateInfo.notes || null,
        clientName: updateInfo.newClientName || null,
        clientPhone: updateInfo.clientPhone || null
      };
      Object.keys(changes).forEach(k => { if (!changes[k]) delete changes[k]; });

      const updated = updateAppointment(cleanPhone, query, changes);
      if (!updated) {
        const sentNotFound = await sock.sendMessage(remoteJid, {
          text: `⚠️ No encontré ninguna visita activa que coincida con *"${query}"*.\n\nEscribe *"agenda"* para ver tus citas.`
        });
        if (sentNotFound?.key?.id) botSentMessageIds.add(sentNotFound.key.id);
        return;
      }

      if (updated.ambiguous) {
        const lines = [
          `⚠️ *Tienes varias visitas con "${query}":*`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━'
        ];
        updated.matches.forEach((m, idx) => {
          lines.push(`${idx + 1}️⃣ *${m.date} a las ${m.time} h* — ${m.clientName}`);
        });
        lines.push('\n¿A cuál de ellas te refieres?');
        const sentAmb = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
        if (sentAmb?.key?.id) botSentMessageIds.add(sentAmb.key.id);
        return;
      }

      const dp = (updated.date || '').split('-');
      const fd = dp.length === 3 ? `${dp[2]}/${dp[1]}/${dp[0]}` : updated.date;

      const lines = [
        `✅ *Visita actualizada con éxito*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `👤 *Cliente:* ${updated.clientName}`,
        updated.clientPhone ? `📞 *Teléfono:* ${updated.clientPhone}` : null,
        `📍 *Dirección:* ${updated.clientAddress || 'Por concretar'}`,
        `🗓️ *Fecha:* ${fd}`,
        `⏰ *Hora:* ${updated.time} h`,
        updated.notes ? `📝 *Notas:* ${updated.notes}` : null
      ].filter(Boolean);

      const sentOk = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
      if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
    } catch (err) {
      console.error('❌ Error modificando cita:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error modificando la visita:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleCompleteAppointments(sock, remoteJid, session, completionInfo = {}, rescheduleInfo = null) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const messagesToSend = [];

      // 1. Si el usuario dijo "todas hechas" o similar
      if (completionInfo.allCompleted) {
        const pendingToday = listAppointments(cleanPhone, 'today');
        const ids = pendingToday.map(a => a.id);
        const res = completeAppointments(cleanPhone, ids, 'SUCCESSFUL', 'Confirmado por profesional al fin de día');
        messagesToSend.push(`✅ *¡Estupendo!* He marcado tus *${res.completed.length} visitas* de hoy como finalizadas.`);
      } else if (completionInfo.completedQueries && completionInfo.completedQueries.length > 0) {
        const res = completeAppointments(cleanPhone, completionInfo.completedQueries, 'SUCCESSFUL');
        const names = res.completed.map(c => `*${c.clientName}*`).join(', ');
        messagesToSend.push(`✅ He marcado como realizada${res.completed.length === 1 ? '' : 's'} la visita con ${names}.`);
      }

      // 2. Si además pidió reagendar otra visita no realizada
      if (rescheduleInfo && rescheduleInfo.query && (rescheduleInfo.date || rescheduleInfo.time)) {
        const resch = rescheduleAppointment(cleanPhone, rescheduleInfo.query, rescheduleInfo.date, rescheduleInfo.time, 'Reagendada tras fin de jornada');
        if (resch.success) {
          const a = resch.appointment;
          const dp = (a.date || '').split('-');
          const fd = dp.length === 3 ? `${dp[2]}/${dp[1]}/${dp[0]}` : a.date;
          messagesToSend.push(`🗓️ La visita con *${a.clientName}* la he movido al *${fd}* a las *${a.time} h*.`);
        }
      }

      // Si quedaron visitas sin resolver
      if (completionInfo.uncompletedQueries && completionInfo.uncompletedQueries.length > 0 && (!rescheduleInfo || !rescheduleInfo.query)) {
        const unDone = completionInfo.uncompletedQueries.join(', ');
        messagesToSend.push(`ℹ️ La visita con *${unDone}* queda pendiente. ¿Deseas que la pasemos a otro día? Dímelo y la reagendo.`);
      }

      const finalText = messagesToSend.join('\n\n') || '✅ Anotado todo en tu agenda.';
      const sentOk = await sock.sendMessage(remoteJid, { text: finalText });
      if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
    } catch (err) {
      console.error('❌ Error completando visitas:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error guardando estado de visitas:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  function formatShoppingListForWhatsApp(items, clientFilter = null) {
    if (!items || items.length === 0) {
      if (clientFilter) {
        return `🛒 *No hay materiales pendientes para la obra de ${clientFilter}.*\n\n💡 Para añadir materiales para este cliente, di: _"comprar 14 m² de azulejo para ${clientFilter}"_.`;
      }
      return '🛒 *Tu lista de la compra está vacía.*\n\nNo tienes materiales pendientes por comprar.\n\n💡 Para añadir materiales, di: _"para la obra de Carlos comprar 2 sacos de cemento cola y 14 m² de azulejo"_ o mándame una nota de voz.';
    }

    const pending = items.filter(i => i.status === 'PENDING');
    const bought = items.filter(i => i.status === 'BOUGHT');

    const title = clientFilter
      ? `🛒 *LISTA DE MATERIALES — OBRA DE ${clientFilter.toUpperCase()}*`
      : '🛒 *LISTA GENERAL DE COMPRAS Y MATERIALES*';

    const lines = [
      title,
      '━━━━━━━━━━━━━━━━━━━━━━━━━'
    ];

    if (pending.length > 0) {
      // Agrupar pendientes por obra/cliente
      const groups = new Map();
      pending.forEach(it => {
        const groupKey = it.clientName ? `🏠 *Obra de ${it.clientName}:*` : '📦 *Materiales Generales / Almacén:*';
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push(it);
      });

      let globalIdx = 1;
      for (const [groupHeader, groupItems] of groups.entries()) {
        lines.push(`\n${groupHeader}`);
        groupItems.forEach(it => {
          const qtyUnit = it.qty && it.unit ? `*${it.qty} ${it.unit}* ` : '';
          lines.push(`  ${globalIdx}️⃣ ${qtyUnit}${it.description}`);
          globalIdx++;
        });
      }
    } else {
      lines.push('\n✅ _¡No tienes ningún material pendiente de compra!_');
    }

    if (bought.length > 0) {
      lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━');
      lines.push(`✔️ *Comprados / Tachados recientemente (${bought.length}):*`);
      bought.slice(0, 5).forEach(it => {
        const clientTag = it.clientName ? ` _(${it.clientName})_` : '';
        lines.push(`   ~${it.description}~${clientTag}`);
      });
    }

    lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (!clientFilter) {
      lines.push('💡 _Puedes consultar una obra concreta diciendo: "¿qué tengo que comprar para Carlos?" o tachar diciendo: "ya compré el cemento"._');
    } else {
      lines.push('💡 _Para tachar: "ya compré el cemento de ' + clientFilter + '" o "tachar azulejo"._');
    }
    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DESAMBIGUACIÓN DE HOMÓNIMOS Y DISTINTIVOS DE CLIENTE
  // ─────────────────────────────────────────────────────────────────────────────

  async function checkDisambiguation(sock, remoteJid, session, clientQuery, actionType, originalPayload = {}) {
    if (!clientQuery) return false;
    const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
    const candidates = findClientsByName(cleanPhone, clientQuery);

    if (candidates && candidates.length > 1) {
      session.pendingDisambiguation = {
        actionType,
        clientQuery,
        candidates,
        originalPayload
      };

      const text = formatDisambiguationPrompt(clientQuery, candidates);
      const sent = await sock.sendMessage(remoteJid, { text });
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
      return true;
    }
    return false;
  }

  async function handleRenameClient(sock, remoteJid, session, targetQuery, newName) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const candidates = findClientsByName(cleanPhone, targetQuery);

      if (candidates.length > 1) {
        session.pendingDisambiguation = {
          actionType: 'rename_client',
          clientQuery: targetQuery,
          candidates,
          originalPayload: { newName }
        };
        const text = formatDisambiguationPrompt(targetQuery, candidates) + `\n\n👉 Elige el número de obra que deseas renombrar a *"${newName}"*.`;
        const sent = await sock.sendMessage(remoteJid, { text });
        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
        return;
      }

      const renamed = renameClientBudget(cleanPhone, targetQuery, newName);
      if (!renamed) {
        const sentErr = await sock.sendMessage(remoteJid, {
          text: `ℹ️ No se ha encontrado ningún cliente o presupuesto que coincida con *"${targetQuery}"* para renombrar.`
        });
        if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
        return;
      }

      for (const b of session.budgets.values()) {
        if (b.id === renamed.budgetId && b.client) {
          b.client.name = renamed.newName;
        }
      }

      const lines = [
        '🏷️ *¡Distintivo / Nombre de cliente actualizado!* ✅',
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `👤 *Nombre anterior:* ${renamed.oldName}`,
        `✨ *Nuevo nombre:* *${renamed.newName}*`,
        `📍 *Ubicación:* ${renamed.clientAddress}`,
        `📁 *Presupuesto:* ${renamed.budgetId}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        '💡 _A partir de ahora puedes referirte a esta obra como "' + renamed.newName + '" para evitar confusiones con otros clientes homónimos._'
      ];

      const sentOk = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
      if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
    } catch (err) {
      console.error('❌ Error renombrando cliente:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error renombrando cliente:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleAddShoppingItems(sock, remoteJid, session, items, clientName = null, explicitBudgetId = null) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const activeBudget = session.activeBudgetId ? session.budgets.get(session.activeBudgetId) : null;
      const effectiveClient = clientName || (activeBudget?.client?.name !== 'Cliente Particular' ? activeBudget?.client?.name : null);
      const budgetId = explicitBudgetId || activeBudget?.id || null;

      if (effectiveClient && !explicitBudgetId) {
        const isDis = await checkDisambiguation(sock, remoteJid, session, effectiveClient, 'add_shopping_items', { items });
        if (isDis) return;
      }

      const added = addShoppingItems(cleanPhone, items, { clientName: effectiveClient, budgetId });
      if (added.length === 0) {
        const sentErr = await sock.sendMessage(remoteJid, {
          text: '⚠️ No he podido identificar los materiales a comprar. Prueba diciendo: _"para la obra de Carlos comprar 14 m² azulejo gris y 2 sacos cemento cola"_.'
        });
        if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
        return;
      }

      const clientTitle = effectiveClient ? ` para la obra de *${effectiveClient}*` : '';
      const lines = [
        `🛒 *¡${added.length === 1 ? 'Material añadido' : `${added.length} materiales añadidos`}${clientTitle}!* ✅`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━'
      ];
      added.forEach(it => {
        const qtyUnit = it.qty && it.unit ? `*${it.qty} ${it.unit}* ` : '';
        lines.push(`• ${qtyUnit}${it.description}`);
      });
      lines.push('');
      lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
      lines.push('💡 _Guardado por obra. Te lo recordaré en tu briefing matinal o cuando preguntes "¿qué tengo que comprar?"._');

      const sentOk = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
      if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
    } catch (err) {
      console.error('❌ Error añadiendo materiales a la compra:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error guardando materiales:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleListShoppingItems(sock, remoteJid, session, clientQuery = null, explicitBudgetId = null) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');

      if (clientQuery && !explicitBudgetId) {
        const isDis = await checkDisambiguation(sock, remoteJid, session, clientQuery, 'list_shopping_items', {});
        if (isDis) return;
      }

      const items = listShoppingItems(cleanPhone, 'all', clientQuery);
      const text = formatShoppingListForWhatsApp(items, clientQuery);
      const sent = await sock.sendMessage(remoteJid, { text });
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
    } catch (err) {
      console.error('❌ Error listando compras:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error consultando la lista de compras:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleMarkShoppingItemBought(sock, remoteJid, session, query, clientQuery = null, explicitBudgetId = null) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');

      if (clientQuery && !explicitBudgetId) {
        const isDis = await checkDisambiguation(sock, remoteJid, session, clientQuery, 'mark_shopping_items', { query });
        if (isDis) return;
      }

      const updated = markShoppingItemBought(cleanPhone, query, clientQuery);
      if (updated.length === 0) {
        const sentNotFound = await sock.sendMessage(remoteJid, {
          text: `ℹ️ No he encontrado ningún material pendiente que coincida con *"${query}"*${clientQuery ? ` para la obra de ${clientQuery}` : ''}.\n\nEscribe *"lista de la compra"* para ver todos tus materiales pendientes.`
        });
        if (sentNotFound?.key?.id) botSentMessageIds.add(sentNotFound.key.id);
        return;
      }

      const names = updated.map(u => `*${u.description}*${u.clientName ? ` (Obra: ${u.clientName})` : ''}`).join(', ');
      const sentOk = await sock.sendMessage(remoteJid, {
        text: `✔️ *¡Tachado de la lista:* ${names}! ✅\n\nMarcado como comprado en tu historial.`
      });
      if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
    } catch (err) {
      console.error('❌ Error marcando material comprado:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error actualizando material:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleClearShoppingList(sock, remoteJid, session) {
    session.pendingAction = createProposedAction('B', 'clear_shopping_list', {}, 'Vaciar lista de compras');
    const sentReq = await sock.sendMessage(remoteJid, {
      text: '🗑️ *¿Deseas vaciar todos los materiales de tu lista de la compra?*\n\nResponde *"Sí"* para confirmar o *"No"* para cancelarlo.'
    });
    if (sentReq?.key?.id) botSentMessageIds.add(sentReq.key.id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MODO OBRA: Memoria Viva y Ficha de Seguimiento por Obra
  // ─────────────────────────────────────────────────────────────────────────────

  async function handleQueryWorkStatus(sock, remoteJid, session, clientQuery = null, onlyMissing = false) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const activeBudget = session.activeBudgetId ? session.budgets.get(session.activeBudgetId) : null;
      const targetQuery = clientQuery || (activeBudget?.client?.name !== 'Cliente Particular' ? activeBudget?.client?.name : null) || activeBudget?.id || null;

      if (clientQuery) {
        const isDis = await checkDisambiguation(sock, remoteJid, session, clientQuery, 'query_work_status', { onlyMissing });
        if (isDis) return;
      }

      const workMem = getWorkMemory(cleanPhone, targetQuery);
      if (!workMem) {
        const sentNotFound = await sock.sendMessage(remoteJid, {
          text: `ℹ️ No he encontrado ninguna obra activa o presupuesto${targetQuery ? ` para *"${targetQuery}"*` : ''}.\n\nEscribe *"ver presupuestos"* para ver todas tus obras.`
        });
        if (sentNotFound?.key?.id) botSentMessageIds.add(sentNotFound.key.id);
        return;
      }

      const text = formatWorkMemoryForWhatsApp(workMem, onlyMissing);
      const sent = await sock.sendMessage(remoteJid, { text });
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
    } catch (err) {
      console.error('❌ Error consultando modo obra:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error consultando estado de la obra:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleUpdateWorkTask(sock, remoteJid, session, clientQuery = null, taskQuery = '', isDone = true) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const activeBudget = session.activeBudgetId ? session.budgets.get(session.activeBudgetId) : null;
      const targetQuery = clientQuery || (activeBudget?.client?.name !== 'Cliente Particular' ? activeBudget?.client?.name : null) || activeBudget?.id || null;

      if (clientQuery) {
        const isDis = await checkDisambiguation(sock, remoteJid, session, clientQuery, 'update_work_task', { taskQuery, isDone });
        if (isDis) return;
      }

      const res = updateWorkTaskStatus(cleanPhone, targetQuery, taskQuery, isDone);
      if (!res) {
        const sentNotFound = await sock.sendMessage(remoteJid, {
          text: `ℹ️ No se pudo actualizar la tarea *"${taskQuery}"*${targetQuery ? ` para la obra de ${targetQuery}` : ''}.\nComprueba que el nombre de la obra o presupuesto sea correcto.`
        });
        if (sentNotFound?.key?.id) botSentMessageIds.add(sentNotFound.key.id);
        return;
      }

      // Sincronizar en memoria de sesión si coincide con activeBudget
      if (session.activeBudgetId === res.budgetId && session.budgets.has(res.budgetId)) {
        const b = session.budgets.get(res.budgetId);
        if (b && b.items) {
          for (const it of b.items) {
            if (it.description && it.description.toLowerCase().includes(taskQuery.toLowerCase())) {
              it.isDone = Boolean(isDone);
              it.status = isDone ? 'DONE' : 'PENDING';
              break;
            }
          }
        }
      }

      const statusIcon = res.task.isDone ? '✓' : '⏳';
      const statusText = res.task.isDone ? 'COMPLETADA' : 'PENDIENTE';
      const lines = [
        `🔨 *¡Fase de obra actualizada!* ✅`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `👤 *Obra:* ${res.clientName}`,
        `${statusIcon} *Tarea:* ${res.task.description}`,
        `📌 *Estado:* ${statusText}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `💡 _Escribe "modo obra ${res.clientName}" para ver la ficha completa._`
      ];

      const sentOk = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
      if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
    } catch (err) {
      console.error('❌ Error actualizando tarea de obra:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error actualizando tarea:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleUpdateWorkDates(sock, remoteJid, session, clientQuery = null, startDate = null, estimatedEndDate = null) {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const activeBudget = session.activeBudgetId ? session.budgets.get(session.activeBudgetId) : null;
      const targetQuery = clientQuery || (activeBudget?.client?.name !== 'Cliente Particular' ? activeBudget?.client?.name : null) || activeBudget?.id || null;

      const res = updateWorkDates(cleanPhone, targetQuery, startDate, estimatedEndDate);
      if (!res) {
        const sentNotFound = await sock.sendMessage(remoteJid, {
          text: `ℹ️ No se pudo actualizar los plazos${targetQuery ? ` para la obra de ${targetQuery}` : ''}.\nComprueba que el nombre de la obra sea correcto.`
        });
        if (sentNotFound?.key?.id) botSentMessageIds.add(sentNotFound.key.id);
        return;
      }

      const lines = [
        `📅 *¡Plazos de obra actualizados!* ✅`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `👤 *Obra:* ${res.clientName}`,
        `📅 *Inicio:* ${res.startDate || 'No definido'}`,
        `🏁 *Final estimado:* ${res.estimatedEndDate || 'No definido'}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━'
      ];

      const sentOk = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
      if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
    } catch (err) {
      console.error('❌ Error actualizando fechas de obra:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error actualizando fechas:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  function formatBudgetsListForWhatsApp(budgets, filter = 'all', company = null, invoices = null) {
    if (!budgets || budgets.length === 0) {
      if (filter === 'pending_signature') {
        return '⏳ *NO TIENES PRESUPUESTOS PENDIENTES DE FIRMA*\n\nTodos tus presupuestos creados ya han sido firmados por los clientes o aceptados.';
      }
      if (filter === 'accepted') {
        return '🟢 *NO TIENES PRESUPUESTOS ACEPTADOS*\n\nTodavía no hay presupuestos aceptados o firmados.';
      }
      if (filter === 'draft') {
        return '📝 *NO TIENES BORRADORES PENDIENTES*\n\nTodas las partidas de tus presupuestos tienen precio asignado.';
      }
      return '📂 *NO TIENES PRESUPUESTOS GUARDADOS TODAVÍA*\n\nEnvíame un audio o mensaje describiendo una obra para generar el primero.';
    }

    let title = '📂 *TUS DOCUMENTOS GUARDADOS:*';
    if (filter === 'pending_signature') {
      title = '⏳ *PRESUPUESTOS PENDIENTES DE FIRMA:*';
    } else if (filter === 'accepted') {
      title = '🟢 *PRESUPUESTOS ACEPTADOS / FIRMADOS:*';
    } else if (filter === 'draft') {
      title = '📝 *BORRADORES PENDIENTES DE VALORACIÓN:*';
    }

    let text = `${title}\n━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    let totalSum = 0;

    budgets.forEach((b, idx) => {
      const isFinalized = b.status === 'FINALIZADO' || b.paymentSummary?.status === 'LIQUIDADO';
      const isAccepted = b.status === 'ACEPTADO' || b.status === 'FIRMADO';
      const isDraft = b.isDraft || b.status === 'BORRADOR_MEDICION';
      const statusLabel = isFinalized
        ? '🏁 *Finalizado*'
        : (isAccepted ? '🟢 *Aceptado*' : (isDraft ? '📝 *Borrador*' : '⏳ *Pendiente de firma*'));

      const clientName = b.client?.name || 'Cliente Particular';
      const address = b.client?.address || 'Ubicación según visita';
      const totalAmount = b.financials?.totalAmount || 0;
      totalSum += totalAmount;
      const formattedTotal = totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

      const paid = b.paymentSummary?.totalPaid || 0;
      const remaining = b.paymentSummary?.remainingBalance !== undefined ? b.paymentSummary.remainingBalance : totalAmount;
      const payBadge = isFinalized
        ? ' | 🟢 *Cobrado 100%*'
        : (paid > 0 ? ` | ⏳ *Pdte. cobro:* ${remaining.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €` : '');

      text += `\n${idx + 1}️⃣ *Presupuesto ${b.id}*\n`;
      text += `   👤 *Cliente:* ${clientName}\n`;
      text += `   📍 *Dirección:* ${address}\n`;
      text += `   💰 *Total:* *${formattedTotal}* · ${statusLabel}${payBadge}\n`;
    });

    if (filter === 'all' && invoices && invoices.size > 0) {
      text += '\n🧾 *FACTURAS OFICIALES EMITIDAS:*\n━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      let invIdx = 1;
      for (const [invId, inv] of invoices.entries()) {
        const clientName = inv.client?.name || 'Cliente';
        const total = inv.financials?.totalAmount ? `${inv.financials.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €` : '';
        const status = inv.status === 'PAGADA' ? '✅ Pagada' : '⏳ Pendiente de cobro';
        text += `\n${invIdx}️⃣ *${invId}* (Ref: ${inv.budgetId})\n   👤 ${clientName}\n   💰 Total: *${total}* (${status})\n`;
        invIdx++;
      }
    }

    text += '\n━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    const filterLabel = filter === 'pending_signature' ? 'pendientes de firma' : (filter === 'accepted' ? 'aceptados/finalizados' : 'registrados');
    text += `📊 *Total:* ${budgets.length} presupuesto${budgets.length === 1 ? '' : 's'} ${filterLabel} por valor de *${totalSum.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €*.\n`;
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '💡 _Para reenviar el enlace de firma di: "Enlace [Nombre o ID]"_\n';
    text += '💡 _Para marcarlo como aceptado di: "El cliente ha firmado el de [Nombre]"_\n';
    text += '💡 _Para registrar cobro/anticipo di: "Cobro [Cantidad] [Nombre]"_\n';
    text += '💡 _Para emitir factura di: "Facturar [Nombre]"_\n';
    text += '💡 _Para crear una obra nueva di: "Presupuesto nuevo..."_';

    return text;
  }

  async function handleListBudgets(sock, remoteJid, session, filter = 'all') {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const dbBudgets = listBudgets(cleanPhone, 100);
      for (const b of dbBudgets) {
        if (b && b.id) session.budgets.set(b.id, b);
      }

      const allBudgets = Array.from(session.budgets.values());
      let filtered = allBudgets;

      if (filter === 'pending_signature') {
        filtered = allBudgets.filter(b => {
          const isDone = b.status === 'ACEPTADO' || b.status === 'FIRMADO' || b.status === 'FINALIZADO';
          return !isDone && !b.isDraft;
        });
      } else if (filter === 'accepted') {
        filtered = allBudgets.filter(b => b.status === 'ACEPTADO' || b.status === 'FIRMADO' || b.status === 'FINALIZADO');
      } else if (filter === 'finalized') {
        filtered = allBudgets.filter(b => b.status === 'FINALIZADO' || b.paymentSummary?.status === 'LIQUIDADO');
      } else if (filter === 'draft') {
        filtered = allBudgets.filter(b => b.isDraft || b.status === 'BORRADOR_MEDICION');
      }

      const text = formatBudgetsListForWhatsApp(filtered, filter, session.company, session.invoices);
      const sent = await sock.sendMessage(remoteJid, { text });
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
    } catch (err) {
      console.error('❌ Error listando presupuestos:', err.message);
      const sentErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *Error consultando los presupuestos:* ${err.message}`
      });
      if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
    }
  }

  async function handleSendSigningLink(sock, remoteJid, session, query = '') {
    try {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const dbBudgets = listBudgets(cleanPhone, 100);
      for (const b of dbBudgets) {
        if (b && b.id) session.budgets.set(b.id, b);
      }

      let target = null;
      if (query && query.trim() !== '') {
        target = findBudgetInSession(session, query);
      }
      if (!target && session.activeBudgetId) {
        target = session.budgets.get(session.activeBudgetId);
      }
      if (!target && session.budgets.size > 0) {
        target = Array.from(session.budgets.values())[session.budgets.size - 1];
      }

      if (!target) {
        const sentErr = await sock.sendMessage(remoteJid, {
          text: '⚠️ *No se encontró el presupuesto solicitado.*\n\nIndica el nombre del cliente o número (ej: *"enlace de Alberto"* o *"enlace PRE-2026-6136"*).'
        });
        if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
        return;
      }

      const signingUrl = generateSigningUrl(target, session.company, cleanPhone);
      const isAccepted = target.status === 'ACEPTADO' || target.status === 'FIRMADO';
      const statusNote = isAccepted
        ? 'ℹ️ _Nota: Este presupuesto ya figura como ACEPTADO/FIRMADO en el sistema._'
        : '📲 _Puedes abrir el enlace tú mismo o reenviárselo al cliente para que firme desde su móvil o PC._';

      const sentSig = await sock.sendMessage(remoteJid, {
        text: `✍️ *Enlace de Firma Digital — Presupuesto ${target.id}*\n━━━━━━━━━━━━━━━━━━━━━━━━━\n👤 *Cliente:* ${target.client?.name || 'Cliente Particular'}\n💰 *Importe:* ${(target.financials?.totalAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €\n📍 *Ubicación:* ${target.client?.address || 'Ubicación según visita'}\n\n🔗 *Enlace:* ${signingUrl}\n\n${statusNote}`
      });
      if (sentSig?.key?.id) botSentMessageIds.add(sentSig.key.id);
    } catch (err) {
      console.error('❌ Error generando enlace de firma:', err.message);
    }
  }

  async function handleAiProcessing(sock, remoteJid, session, taskData, isRetry = false) {
    await sock.sendPresenceUpdate('composing', remoteJid);

    const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');

    // Construir contexto enriquecido
    const budgetsList = Array.from(session.budgets.values()).slice(-5).map(b => ({
      id: b.id,
      clientName: b.client?.name !== 'Cliente Particular' ? b.client?.name : null,
      clientAddress: b.client?.address !== 'Ubicación obra según visita' ? b.client?.address : null,
      isDraft: b.isDraft,
      items: (b.items || []).map(i => ({
        id: i.id,
        description: i.description,
        qty: i.qty,
        unit: i.unit,
        unitPrice: i.unitPrice,
        isPricePending: i.isPricePending
      })),
      taxRate: b.financials?.taxRatePercentage || 10,
      discount: b.financials?.discountPercentage > 0 ? { type: 'percentage', value: b.financials.discountPercentage } : null
    }));

    const companyContext = {
      name: session.company?.name,
      cif: session.company?.cif,
      trade: session.company?.trade || 'Reformas y Construcción',
      address: session.company?.address,
      phone: session.company?.phone,
      email: session.company?.email,
      iban: session.company?.iban,
      bizum: session.company?.bizum
    };

    const nowObj = new Date();
    const daysOfWeek = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const dayName = daysOfWeek[nowObj.getDay()];
    const currentDateStr = nowObj.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
    const currentIsoDate = nowObj.toISOString().split('T')[0];
    const currentTimeStr = nowObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });

    const contextPrompt = `FECHA Y HORA ACTUAL (utilízala como referencia para resolver días relativos como "hoy", "mañana", "el jueves", etc.):\n${dayName}, ${currentDateStr} (${currentIsoDate}), ${currentTimeStr}\n\nPRESUPUESTOS GUARDADOS EN MEMORIA DEL PROFESIONAL:\n${budgetsList.length > 0 ? JSON.stringify(budgetsList, null, 2) : 'Ninguno todavía'}\n\nPRESUPUESTO ACTIVO ACTUALMENTE: ${session.activeBudgetId || 'Ninguno (modo nuevo cliente)'}\n\nDATOS DE LA EMPRESA DEL PROFESIONAL:\n${JSON.stringify(companyContext, null, 2)}`;

    let aiResult;
    if (taskData.isAudio) {
      console.log(`🎙️ Enviando audio a Gemini (${taskData.audioBuffer?.length} bytes)...`);
      if (!isRetry) {
        try {
          const sentAudioNotice = await sock.sendMessage(remoteJid, {
            text: '🎙️ _Escuchando tu nota de voz y procesando los datos... Te aviso en unos segundos._'
          });
          if (sentAudioNotice?.key?.id) botSentMessageIds.add(sentAudioNotice.key.id);
        } catch (noticeErr) {}
      }
      aiResult = await callGemini({
        audioBuffer: taskData.audioBuffer,
        mimeType: taskData.audioMimeType || 'audio/ogg',
        promptText: `${contextPrompt}\n\nEl profesional está dictando una nota de voz. Identifica su intención: si es configurar datos de su perfil o empresa (Bizum, IBAN, CIF, nombre comercial, dirección, oficio), consultar datos de empresa, agendar cita/visita, consultar agenda, cancelar cita, registrar cobro, consultar saldo, facturar, factura de anticipo, exportar trimestre, o crear/modificar presupuesto.`
      }, GEMINI_UPDATE_PROMPT);
    } else {
      console.log(`\n💬 Enviando texto a Gemini: "${taskData.rawUserText}"`);
      aiResult = await callGemini(
        `${contextPrompt}\n\nINSTRUCCIONES DEL PROFESIONAL:\n${taskData.rawUserText}`,
        GEMINI_UPDATE_PROMPT
      );
    }

    console.log(`🤖 Intención detectada por Gemini: action="${aiResult?.action}"`, JSON.stringify(aiResult).substring(0, 160));

    if (isRetry && (!aiResult?.action || aiResult?.action === 'budget')) {
      const sentRetryNote = await sock.sendMessage(remoteJid, {
        text: '🎉 *¡Tu petición guardada en espera ha sido procesada con éxito!*\nAquí tienes el documento generado:'
      });
      if (sentRetryNote?.key?.id) botSentMessageIds.add(sentRetryNote.key.id);
    }

    // 0. Listar o consultar presupuestos
    if (aiResult?.action === 'list_budgets') {
      await handleListBudgets(sock, remoteJid, session, aiResult.budgetFilter || 'all');
      return;
    }

    // 1. Factura de anticipo
    if (aiResult?.action === 'advance_invoice') {
      const target = (aiResult.targetBudgetId && session.budgets.get(aiResult.targetBudgetId))
        || findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId)
        || (session.activeBudgetId && session.budgets.get(session.activeBudgetId))
        || (session.budgets.size > 0 ? Array.from(session.budgets.values())[session.budgets.size - 1] : null);

      await handleAdvanceInvoice(
        sock,
        remoteJid,
        session,
        target,
        aiResult.clientNif,
        aiResult.paymentInfo,
        Boolean(aiResult.sendSigningLink || /firm|enlace/i.test(taskData.rawUserText || ''))
      );
      return;
    }

    // 2. Facturación general / liquidación
    if (aiResult?.action === 'invoice' || aiResult?.isInvoice) {
      const target = (aiResult.targetBudgetId && session.budgets.get(aiResult.targetBudgetId))
        || findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId)
        || (session.activeBudgetId && session.budgets.get(session.activeBudgetId))
        || (session.budgets.size > 0 ? Array.from(session.budgets.values())[session.budgets.size - 1] : null);

      await emitInvoiceForBudget(sock, remoteJid, session, target, aiResult.clientNif);
      return;
    }

    // 3. Registro de cobro o anticipo
    if (aiResult?.action === 'payment') {
      const target = (aiResult.targetBudgetId && session.budgets.get(aiResult.targetBudgetId))
        || findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId)
        || (session.activeBudgetId && session.budgets.get(session.activeBudgetId))
        || (session.budgets.size > 0 ? Array.from(session.budgets.values())[session.budgets.size - 1] : null);

      // Si además de cobro pidió expresamente emitir factura de anticipo (ej: "hazme la factura de anticipo de Juan")
      // y NO es simplemente una notificación de que una factura ha sido pagada (ej: "factura pagada", "pago recibido de la factura")
      const rawText = taskData.rawUserText || '';
      const isExplicitInvoiceRequest = /(?:hacer|hazme|emite|emitir|saca|sacarme|generar|crear|pásame).*(?:factura)/i.test(rawText) || /factura.*(?:anticipo|adelanto)/i.test(rawText);
      const isPaymentNotice = /(?:pagad|recibid|cobrad|abonad|ingresad|transferid|liquidada?)/i.test(rawText);

      if (isExplicitInvoiceRequest && !isPaymentNotice) {
        await handleAdvanceInvoice(
          sock,
          remoteJid,
          session,
          target,
          aiResult.clientNif,
          aiResult.paymentInfo,
          Boolean(aiResult.sendSigningLink || /firm|enlace/i.test(rawText))
        );
        return;
      }

      await handlePaymentRegistration(sock, remoteJid, session, target, aiResult.paymentInfo || {});
      return;
    }

    // 4. Consulta de saldo o deuda
    if (aiResult?.action === 'query_balance') {
      const target = (aiResult.targetBudgetId && session.budgets.get(aiResult.targetBudgetId))
        || findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId)
        || (session.activeBudgetId && session.budgets.get(session.activeBudgetId))
        || (session.budgets.size > 0 ? Array.from(session.budgets.values())[session.budgets.size - 1] : null);

      await handleQueryBalance(sock, remoteJid, session, target);
      return;
    }

    // 4.1 Factura de compra / gasto recibido (desde audio o texto interpretado por Gemini)
    if (aiResult?.action === 'purchase_invoice' && aiResult?.purchaseInvoiceInfo) {
      const cleanPhone = session.phone || String(remoteJid).replace(/\D/g, '');
      const normalizedInvoice = validateAndNormalizePurchaseInvoice(aiResult.purchaseInvoiceInfo, cleanPhone);
      const savedInvoice = savePurchaseInvoice(cleanPhone, normalizedInvoice);

      if (normalizedInvoice.isInvestmentAsset) {
        saveInvestmentAsset(cleanPhone, {
          purchaseInvoiceId: savedInvoice.id,
          description: savedInvoice.description || savedInvoice.supplierName,
          purchaseDate: savedInvoice.issueDate,
          supplierName: savedInvoice.supplierName,
          purchaseBase: savedInvoice.taxBase,
          vatAmount: savedInvoice.vatAmount,
          totalAmount: savedInvoice.totalAmount
        });
      }

      saveExpensePayment(cleanPhone, {
        purchaseInvoiceId: savedInvoice.id,
        amount: savedInvoice.paidAmount,
        paymentDate: savedInvoice.issueDate,
        paymentMethod: aiResult.paymentInfo?.method || 'Tarjeta',
        reference: `Factura ${savedInvoice.invoiceNumber}`
      });

      const fmtEur = num => `${Number(num || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
      const lines = [
        '🧾 *¡GASTO / FACTURA DE PROVEEDOR REGISTRADA!*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `🏢 *Proveedor:* ${savedInvoice.supplierName} _(${savedInvoice.supplierTaxId || '⚠️ Sin NIF/CIF'})_`,
        `📄 *Nº Factura:* ${savedInvoice.invoiceNumber}`,
        `📅 *Fecha:* ${savedInvoice.issueDate}`,
        `📦 *Concepto:* ${savedInvoice.description}`,
        `💰 *Base Imponible:* ${fmtEur(savedInvoice.taxBase)}`,
        `📊 *IVA (${savedInvoice.vatRate}%):* ${fmtEur(savedInvoice.vatAmount)}`,
        savedInvoice.irpfRetention > 0 ? `✂️ *Retención IRPF:* ${fmtEur(savedInvoice.irpfRetention)}` : '',
        `🏷️ *TOTAL:* *${fmtEur(savedInvoice.totalAmount)}*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        savedInvoice.deductibilityStatus === 'NEEDS_REVIEW'
          ? '⚠️ *Nota fiscal:* Pendiente de revisión del gestor.'
          : '✅ *Incorporado al libro registro oficial del IVA e IRPF.*',
        normalizedInvoice.isInvestmentAsset ? '🏗️ *Aviso:* Registrado como Bien de Inversión sujeto a amortización.' : ''
      ].filter(Boolean);

      const sentPinv = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
      if (sentPinv?.key?.id) botSentMessageIds.add(sentPinv.key.id);
      return;
    }

    // 5. Consulta datos empresa
    if (aiResult?.action === 'show_company') {
      const companyText = formatCompanyForWhatsApp(session.company);
      const sentComp = await sock.sendMessage(remoteJid, { text: companyText });
      if (sentComp?.key?.id) botSentMessageIds.add(sentComp.key.id);
      return;
    }

    // 6. Configurar empresa
    if (aiResult?.action === 'configure_company') {
      const cleanInfo = {};
      if (aiResult.companyInfo) {
        for (const [k, v] of Object.entries(aiResult.companyInfo)) {
          if (v && typeof v === 'string' && v.trim() !== '') {
            cleanInfo[k] = v.trim();
          }
        }
      }

      // Si la IA detectó la intención de configurar pero el usuario aún no indicó el valor concreto
      if (Object.keys(cleanInfo).length === 0) {
        const feedbackMsg = aiResult.assistantFeedback || '¿Qué dato de tu perfil o empresa deseas añadir o modificar? Puedes indicarme por ejemplo:\n• *Bizum:* _"Mi Bizum es 611223344"_\n• *IBAN:* _"Mi IBAN es ES21..."_\n• *Nombre:* _"Mi empresa es Reformas..."_\n• *CIF o Dirección*';
        const sentConf = await sock.sendMessage(remoteJid, { text: feedbackMsg });
        if (sentConf?.key?.id) botSentMessageIds.add(sentConf.key.id);
        return;
      }

      const updated = saveCompany(taskData.senderNumber, cleanInfo);
      session.company = updated;

      const confText = [
        '✅ *¡Datos de tu empresa actualizados con éxito!*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `🛠️ *Oficio / Especialidad:* ${updated.trade || 'No indicado'}`,
        `📛 *Empresa:* ${updated.name || 'No indicado'}`,
        `🆔 *CIF:* ${updated.cif || 'No indicado'}`,
        `📍 *Dirección:* ${updated.address || 'No indicada'}`,
        `🏦 *IBAN:* ${updated.iban || 'No configurado'}`,
        `📱 *Bizum:* ${updated.bizum || 'No configurado'}`,
        `📞 *Teléfono:* ${updated.phone || 'No indicado'}`,
        `✉️ *Email:* ${updated.email || 'No indicado'}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        '📄 _Tus nuevos presupuestos, facturas y recibos oficiales se emitirán con estos datos fiscales y opciones de cobro._'
      ].join('\n');

      const sentConf = await sock.sendMessage(remoteJid, { text: confText });
      if (sentConf?.key?.id) botSentMessageIds.add(sentConf.key.id);
      return;
    }

    // 7. Configurar email gestoría
    if (aiResult?.action === 'configure_gestoria') {
      const gestoriaEmail = (aiResult.gestoriaEmail || '').trim().toLowerCase();
      if (gestoriaEmail) {
        const updated = saveCompany(taskData.senderNumber, { gestoriaEmail });
        session.company = updated;
        const sentConf = await sock.sendMessage(remoteJid, {
          text: `✅ *¡Email de tu gestoría guardado!*\n\n📧 *Gestoría:* ${gestoriaEmail}\n\nCuando quieras enviar tus facturas di: *"Enviar trimestre a mi gestoría"* o *"gestoría"* para enviarle el Excel y PDF en 1 clic.`
        });
        if (sentConf?.key?.id) botSentMessageIds.add(sentConf.key.id);
      }
      return;
    }

    // 8. Exportar trimestre
    if (aiResult?.action === 'export_quarter') {
      await handleQuarterExport(sock, remoteJid, session, aiResult.quarter, aiResult.year, Boolean(aiResult.sendToGestoria));
      return;
    }

    // 9. Agendar cita (Nivel A: Automático — el empresario ya lo tiene decidido)
    if (aiResult?.action === 'schedule_appointment') {
      const appsList = (aiResult.appointmentsList && aiResult.appointmentsList.length > 0)
        ? aiResult.appointmentsList
        : [aiResult.appointmentInfo || {}];

      if (appsList.length > 1) {
        // ── MÚLTIPLES CITAS: guardar todas de golpe y confirmar en bloque ────
        for (const appInfo of appsList) {
          await handleScheduleAppointment(sock, remoteJid, session, appInfo);
        }
        const summaryLines = [
          `✅ *${appsList.length} VISITAS AGENDADAS*`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━'
        ];
        appsList.forEach((app, idx) => {
          const dp = (app.date || '').split('-');
          const fd = dp.length === 3 ? `${dp[2]}/${dp[1]}/${dp[0]}` : (app.date || 'Por concretar');
          summaryLines.push(`${idx + 1}. *${app.clientName || 'Cliente'}* · ${fd} · ${app.time || '10:00'} h`);
        });
        summaryLines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
        summaryLines.push('Escribe *"agenda"* para verlas todas.');
        const sentSum = await sock.sendMessage(remoteJid, { text: summaryLines.join('\n') });
        if (sentSum?.key?.id) botSentMessageIds.add(sentSum.key.id);
      } else {
        // ── CITA INDIVIDUAL: guardar y confirmar directamente ────────────────
        await handleScheduleAppointment(sock, remoteJid, session, appsList[0]);
      }
      return;
    }

    // 10. Listar citas (Nivel A: Automático)
    if (aiResult?.action === 'list_appointments') {
      const filter = (aiResult.appointmentFilter === 'today' || aiResult.appointmentFilter === 'tomorrow')
        ? aiResult.appointmentFilter
        : 'all';
      await handleListAppointments(sock, remoteJid, session, filter);
      return;
    }

    // 11. Cancelar cita / visita técnica
    if (aiResult?.action === 'cancel_appointment') {
      const query = (aiResult.appointmentQuery || aiResult.clientName || '').trim();
      await handleCancelAppointment(sock, remoteJid, session, query);
      return;
    }

    // 11b. Modificar / Reagendar cita (Nivel A: Directo si es inequívoco)
    if (aiResult?.action === 'update_appointment') {
      const updateInfo = aiResult.appointmentInfo || {};
      updateInfo.appointmentQuery = updateInfo.appointmentQuery || aiResult.appointmentQuery || aiResult.clientName || '';
      await handleUpdateAppointment(sock, remoteJid, session, updateInfo);
      return;
    }

    // 11c. Confirmar visitas realizadas / finalizadas (Revisión de fin de día o manual)
    if (aiResult?.action === 'complete_appointments') {
      await handleCompleteAppointments(sock, remoteJid, session, aiResult.completionInfo || {}, aiResult.rescheduleInfo || null);
      return;
    }

    // 12. Aceptar presupuesto
    if (aiResult?.action === 'accept_budget') {
      const target = (aiResult.targetBudgetId && session.budgets.get(aiResult.targetBudgetId))
        || findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId)
        || (session.activeBudgetId && session.budgets.get(session.activeBudgetId))
        || (session.budgets.size > 0 ? Array.from(session.budgets.values())[session.budgets.size - 1] : null);

      await handleAcceptBudget(sock, remoteJid, session, target);
      return;
    }

    // 13. Añadir materiales a la lista de compra (Nivel A: Automático)
    if (aiResult?.action === 'add_shopping_items') {
      await handleAddShoppingItems(sock, remoteJid, session, aiResult.shoppingItems || [], aiResult.clientName || null);
      return;
    }

    // 14. Consultar lista de materiales a comprar (Nivel A: Automático)
    if (aiResult?.action === 'list_shopping_items') {
      await handleListShoppingItems(sock, remoteJid, session, aiResult.clientName || null);
      return;
    }

    // 15. Marcar materiales como comprados (Nivel A: Automático)
    if (aiResult?.action === 'mark_shopping_items') {
      await handleMarkShoppingItemBought(sock, remoteJid, session, aiResult.shoppingQuery || '', aiResult.clientName || null);
      return;
    }

    // 16. Vaciar lista de compras (Nivel B: Confirmación simple)
    if (aiResult?.action === 'clear_shopping_list') {
      await handleClearShoppingList(sock, remoteJid, session);
      return;
    }

    // 17. Consultar estado o memoria de obra / Modo Obra (Nivel A: Automático)
    if (aiResult?.action === 'query_work_status') {
      await handleQueryWorkStatus(sock, remoteJid, session, aiResult.clientName || null, Boolean(aiResult.onlyMissing));
      return;
    }

    // 18. Actualizar tarea o fase de obra (Nivel A: Automático)
    if (aiResult?.action === 'update_work_task') {
      await handleUpdateWorkTask(sock, remoteJid, session, aiResult.clientName || null, aiResult.taskQuery || '', aiResult.isDone !== false);
      return;
    }

    // 19. Actualizar fechas/plazos de obra (Nivel A: Automático)
    if (aiResult?.action === 'update_work_dates') {
      await handleUpdateWorkDates(sock, remoteJid, session, aiResult.clientName || null, aiResult.startDate || null, aiResult.estimatedEndDate || null);
      return;
    }

    if (!aiResult || !aiResult.items || aiResult.items.length === 0) {
      const sentHelp = await sock.sendMessage(remoteJid, {
        text: `🤖 *PresuVoz Bot*\n\nNo he detectado partidas técnicas en el mensaje. Puedes dictarme los trabajos de obra (ej: _"tirar tabique de 4x3 metros y mover 2 enchufes por 600 euros"_).`
      });
      if (sentHelp?.key?.id) botSentMessageIds.add(sentHelp.key.id);
      return;
    }

    // 13. Cálculo y guardado de Presupuesto
    let targetId = aiResult.targetBudgetId || session.activeBudgetId;
    const isUpdate = !aiResult.isNewBudget && targetId && session.budgets.has(targetId);
    const prevBudget = isUpdate ? session.budgets.get(targetId) : null;

    if (prevBudget) {
      if (!aiResult.clientName && prevBudget.client?.name && prevBudget.client.name !== 'Cliente Particular') {
        aiResult.clientName = prevBudget.client.name;
      }
      if (!aiResult.clientAddress && prevBudget.client?.address && prevBudget.client.address !== 'Ubicación obra según visita') {
        aiResult.clientAddress = prevBudget.client.address;
      }
    }

    const engineResult = engine.process({
      rawTranscript: '',
      company: session.company,
      clientName: aiResult.clientName,
      clientAddress: aiResult.clientAddress,
      items: aiResult.items,
      taxRate: (aiResult.taxRate || session.company?.defaultTaxRate || 10) / 100,
      discount: aiResult.discount || null,
      customConditions: aiResult.paymentTerms
        ? `${aiResult.paymentTerms.advancePercentage}% al aceptar. ${100 - aiResult.paymentTerms.advancePercentage}% a la entrega.`
        : null
    });

    if (!engineResult.success) {
      const sentErrEngine = await sock.sendMessage(remoteJid, {
        text: `⚠️ *PresuVoz*: ${engineResult.assistantFeedback || 'No se pudo calcular el presupuesto.'}`
      });
      if (sentErrEngine?.key?.id) botSentMessageIds.add(sentErrEngine.key.id);
      return;
    }

    if (prevBudget && prevBudget.id) {
      engineResult.budget.id = prevBudget.id;
      engineResult.budget.payments = prevBudget.payments || [];
      engineResult.budget.paymentSummary = prevBudget.paymentSummary || engineResult.budget.paymentSummary;
      engineResult.budget.advanceInvoices = prevBudget.advanceInvoices || [];
    }

    engineResult.budget.company = session.company;
    session.budgets.set(engineResult.budget.id, engineResult.budget);
    session.activeBudgetId = engineResult.budget.id;

    saveBudget(cleanPhone, engineResult.budget);
    console.log(`💾 Presupuesto guardado en SQLite y sesión: ${engineResult.budget.id} (Total guardados: ${session.budgets.size})`);

    // Detección preventiva de cliente homónimo / repetido al crear presupuesto nuevo
    let homonymWarningText = '';
    if (!isUpdate && aiResult.clientName && aiResult.clientName !== 'Cliente Particular') {
      const existingSameName = findClientsByName(cleanPhone, aiResult.clientName);
      const otherBudgets = existingSameName.filter(b => b.id !== engineResult.budget.id);
      if (otherBudgets.length > 0) {
        homonymWarningText = '\n\n' + formatDuplicateClientWarning(aiResult.clientName, aiResult.clientAddress, otherBudgets);
      }
    }

    const replyText = formatBudgetForWhatsApp(engineResult.budget, aiResult.warnings || []) + homonymWarningText;
    const sent = await sock.sendMessage(remoteJid, { text: replyText });
    if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
    console.log('✅ Resumen de texto enviado por WhatsApp.');

    try {
      console.log('📄 Generando documento PDF oficial...');
      const pdfBuffer = await generateBudgetPDF(engineResult.budget);
      const pdfFileName = `Presupuesto_${engineResult.budget.id || 'Obra'}.pdf`;

      const sentDoc = await sock.sendMessage(remoteJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: pdfFileName,
        caption: `📄 *${pdfFileName}*\nPresupuesto formal en PDF listo para enviar a tu cliente o imprimir con firma y validez legal.`
      });
      if (sentDoc?.key?.id) botSentMessageIds.add(sentDoc.key.id);
      console.log(`✅ Archivo PDF (${pdfBuffer.length} bytes) enviado con éxito por WhatsApp.`);

      try {
        const signingUrl = generateSigningUrl(engineResult.budget, session.company, cleanPhone);

        const sentSig = await sock.sendMessage(remoteJid, {
          text: `✍️ *Enlace de Aceptación y Firma Digital:*\n${signingUrl}\n\n📲 _Puedes abrirlo tú o enviárselo a tu cliente para que firme cómodamente desde su móvil o desde su casa. Al firmar, el presupuesto pasa a estado *Aceptado* y el cliente recibe su copia sellada por email._`
        });
        if (sentSig?.key?.id) botSentMessageIds.add(sentSig.key.id);
        console.log(`✅ Enlace de firma enviado por WhatsApp (${signingUrl}).`);
      } catch (sigErr) {
        console.warn('⚠️ No se pudo generar el enlace de firma:', sigErr.message);
      }

    } catch (pdfErr) {
      console.error('⚠️ No se pudo generar o enviar el PDF:', pdfErr.message);
      const budgetIdForRecovery = engineResult.budget.id || '';
      const clientNameForRecovery = engineResult.budget.client?.name || 'el cliente';
      const sentPdfErr = await sock.sendMessage(remoteJid, {
        text: `⚠️ *El presupuesto se ha guardado correctamente*, pero no se pudo generar el PDF en este momento (posiblemente por conexión inestable).\n\nCuando quieras el PDF di: *"pdf de ${clientNameForRecovery}"* y te lo mando al instante junto con el enlace de firma.`
      });
      if (sentPdfErr?.key?.id) botSentMessageIds.add(sentPdfErr.key.id);
    }

    const optionsLines = [
      '👉 *Opciones disponibles:*',
      '• Si quieres ver todos tus presupuestos, facturas y saldos responde *1*.',
      '• Para *registrar un cobro/anticipo* di: *"José Luis me ha pagado 1.500€ por Bizum"*.',
      '• Para *emitir la factura oficial* di: *"facturar"*.',
      '• Si quieres uno nuevo manda un audio o texto comentando *presupuesto nuevo*.'
    ];

    if (session.company?.isConfigured === false && !session.onboardingPrompted) {
      session.onboardingPrompted = true;
      optionsLines.push('');
      optionsLines.push('💡 *Consejo:* Para que tus próximos presupuestos y facturas salgan con tu nombre legal y oficio en lugar de datos demo, di por ejemplo: *"Soy electricista"* o *"Configurar empresa..."*.');
    }

    const optionsText = optionsLines.join('\n');

    const sentOptions = await sock.sendMessage(remoteJid, { text: optionsText });
    if (sentOptions?.key?.id) botSentMessageIds.add(sentOptions.key.id);
  }

  async function processAiStandbyQueue(sock) {
    if (isProcessingAiQueue || aiStandbyQueue.length === 0) return;
    isProcessingAiQueue = true;

    try {
      const now = Date.now();
      for (let i = 0; i < aiStandbyQueue.length; i++) {
        const item = aiStandbyQueue[i];
        if (now < item.nextRetryAt || item.processing) continue;

        // Evitar procesar si ya hay una petición activa para este JID
        if (activeProcessingJids.has(item.remoteJid)) {
          continue;
        }

        // Extraer de la cola antes de ejecutar para evitar reintentos concurrentes
        aiStandbyQueue.splice(i, 1);
        i--;
        item.processing = true;

        console.log(`⏳ Reintentando tarea en stand-by para ${item.remoteJid} (intento ${item.attempts + 1})...`);
        try {
          activeProcessingJids.add(item.remoteJid);
          await handleAiProcessing(sock, item.remoteJid, item.session, item.taskData, true);
          console.log(`✅ Tarea en cola completada con éxito para ${item.remoteJid}.`);
        } catch (queueErr) {
          item.processing = false;
          item.attempts += 1;
          const isRetryable = /429|503|quota|exhausted|overload|demand|busy|unavailable|high demand|saturad|connection closed|econnreset|etimedout|socket|abort|timeout/i.test(queueErr.message || '');
          if (item.attempts >= 12 || !isRetryable) {
            console.warn(`❌ Tarea en stand-by cancelada tras ${item.attempts} intentos:`, queueErr.message);
            try {
              await sock.sendMessage(item.remoteJid, {
                text: `⚠️ *No se pudo procesar tu mensaje tras varios intentos en cola*\n\nHa habido una incidencia temporal (${queueErr.message.substring(0, 80)}...). Por favor, reenvía tu solicitud en unos minutos.`
              });
            } catch(e) {}
          } else {
            const delay = Math.min(60000, 5000 * Math.pow(1.35, item.attempts));
            item.nextRetryAt = Date.now() + delay;
            console.log(`⏳ Próximo reintento para ${item.remoteJid} en ${Math.round(delay / 1000)}s.`);
            aiStandbyQueue.push(item);
          }
        } finally {
          activeProcessingJids.delete(item.remoteJid);
        }
      }
    } finally {
      isProcessingAiQueue = false;
    }
  }


  async function executeMessageDispatch(sock, remoteJid, senderNumber, item) {
    const { msg, messageContent, rawUserText, isAudio, isImage, isText, imageMsg, audioMsg, wamId, allWamIds } = item;

    if (wamId) updateMessageStatus(wamId, 'PROCESSING');
    if (allWamIds) {
      allWamIds.forEach(id => updateMessageStatus(id, 'PROCESSING'));
    }
    setConversationState(remoteJid, 'PROCESSING');

    let isSuccess = false;
    try {
      const session = getUserSession(remoteJid, senderNumber);

      // Si recibimos una imagen para logotipo de empresa o factura de gasto/ticket
      if (isImage) {
        const rawCaption = (imageMsg.caption || '').trim();
        const caption = rawCaption.toLowerCase();
        const isExplicitLogo = caption.includes('logo') || caption === 'logotipo' || caption === 'mi logo';

        if (isExplicitLogo) {
          try {
            console.log(`🖼️ Imagen de logotipo recibida de ${senderNumber}...`);
            const buffer = await downloadMediaMessage(
              { key: msg.key, message: messageContent },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );
            const logosDir = path.resolve('data', 'logos');
            if (!fs.existsSync(logosDir)) fs.mkdirSync(logosDir, { recursive: true });
            const logoPath = path.join(logosDir, `${senderNumber}.png`);
            fs.writeFileSync(logoPath, buffer);

            saveCompany(senderNumber, { logoPath });
            session.company = getCompany(senderNumber);

            const sentLogo = await sock.sendMessage(remoteJid, {
              text: `✅ *¡Logotipo de empresa guardado con éxito!*\n\n🖼️ A partir de ahora aparecerá en la cabecera de todos tus nuevos presupuestos, facturas y recibos oficiales en PDF.`
            });
            if (sentLogo?.key?.id) botSentMessageIds.add(sentLogo.key.id);
          } catch (logoErr) {
            console.error('❌ Error guardando logotipo:', logoErr.message);
            const sentErr = await sock.sendMessage(remoteJid, {
              text: `⚠️ *No se pudo guardar el logotipo:* ${logoErr.message}`
            });
            if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
          }
          return;
        } else {
          // Procesamiento inteligente de factura recibida / ticket de gasto con IA Multimodal y validación determinística
          try {
            console.log(`🧾 Imagen de factura/ticket recibida de ${senderNumber}... Descargando...`);
            const buffer = await downloadMediaMessage(
              { key: msg.key, message: messageContent },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );

            // Guardar justificante en disco
            const receiptsDir = path.resolve('data', 'purchase_receipts');
            if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
            const receiptPath = path.join(receiptsDir, `${senderNumber}_${Date.now()}.jpg`);
            fs.writeFileSync(receiptPath, buffer);

            const rawExtraction = await parsePurchaseInvoiceWithGemini(
              { buffer, mimeType: 'image/jpeg', caption: rawCaption },
              GEMINI_API_KEY
            );

            const normalizedInvoice = validateAndNormalizePurchaseInvoice(rawExtraction, senderNumber, receiptPath);
            const savedInvoice = savePurchaseInvoice(senderNumber, normalizedInvoice);

            // Si es un bien de inversión (>3.005,06€), registrar automáticamente en inventario
            if (normalizedInvoice.isInvestmentAsset) {
              saveInvestmentAsset(senderNumber, {
                purchaseInvoiceId: savedInvoice.id,
                description: savedInvoice.description || savedInvoice.supplierName,
                purchaseDate: savedInvoice.issueDate,
                supplierName: savedInvoice.supplierName,
                purchaseBase: savedInvoice.taxBase,
                vatAmount: savedInvoice.vatAmount,
                totalAmount: savedInvoice.totalAmount
              });
            }

            // También registrar el pago del gasto
            saveExpensePayment(senderNumber, {
              purchaseInvoiceId: savedInvoice.id,
              amount: savedInvoice.paidAmount,
              paymentDate: savedInvoice.issueDate,
              paymentMethod: rawExtraction.paymentMethod || 'Tarjeta',
              reference: `Ticket ${savedInvoice.invoiceNumber}`
            });

            const fmtEur = num => `${Number(num || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
            const lines = [
              '🧾 *¡GASTO / FACTURA REGISTRADA PARA LA GESTORÍA!*',
              '━━━━━━━━━━━━━━━━━━━━━━━━━',
              `🏢 *Proveedor:* ${savedInvoice.supplierName} _(${savedInvoice.supplierTaxId || '⚠️ Sin NIF/CIF en ticket'})_`,
              `📄 *Nº Factura / Ticket:* ${savedInvoice.invoiceNumber}`,
              `📅 *Fecha:* ${savedInvoice.issueDate}`,
              `📦 *Concepto:* ${savedInvoice.description}`,
              `💰 *Base Imponible:* ${fmtEur(savedInvoice.taxBase)}`,
              `📊 *IVA (${savedInvoice.vatRate}%):* ${fmtEur(savedInvoice.vatAmount)}`,
              savedInvoice.irpfRetention > 0 ? `✂️ *Retención IRPF:* ${fmtEur(savedInvoice.irpfRetention)}` : '',
              `🏷️ *TOTAL:* *${fmtEur(savedInvoice.totalAmount)}*`,
              '━━━━━━━━━━━━━━━━━━━━━━━━━',
              savedInvoice.deductibilityStatus === 'NEEDS_REVIEW'
                ? '⚠️ *Nota fiscal:* Marcado para revisión del gestor (deducibilidad parcial o falta de CIF).'
                : '✅ *Listo para deducir:* Incorporado al libro registro oficial del IVA e IRPF.',
              normalizedInvoice.isInvestmentAsset ? '🏗️ *Aviso:* Supera 3.005,06 €, registrado como Bien de Inversión sujeto a amortización.' : ''
            ].filter(Boolean);

            const sentSuccess = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
            if (sentSuccess?.key?.id) botSentMessageIds.add(sentSuccess.key.id);
            return;
          } catch (receiptErr) {
            console.error('❌ Error procesando factura recibida:', receiptErr.message);
            const sentErr = await sock.sendMessage(remoteJid, {
              text: `⚠️ *No se pudo procesar la factura/ticket:* ${receiptErr.message}`
            });
            if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
            return;
          }
        }
      }

      // 0.1 Interceptor de Desambiguación de Clientes Homónimos (Cero Suposiciones)
      if (isText && session.pendingDisambiguation) {
        const dis = session.pendingDisambiguation;
        const norm = rawUserText.trim().toLowerCase();

        // 1. Si el usuario cancela
        if (norm === 'cancelar' || norm === 'ninguno' || norm === 'ninguna' || norm === 'no' || norm === 'descartar') {
          session.pendingDisambiguation = null;
          const sentCancel = await sock.sendMessage(remoteJid, {
            text: '👍 *Operación cancelada.* No se ha modificado ninguna obra.'
          });
          if (sentCancel?.key?.id) botSentMessageIds.add(sentCancel.key.id);
          return;
        }

        // 2. Si pide renombrar un candidato en particular
        // ej: "renombrar el 1 a Alberto Martín Centro", "el 1 y llámalo Alberto Centro", "el 2 ponle Alberto Constitución"
        let renameTargetCandidate = null;
        let renameNewName = null;
        const renameInDisMatch = rawUserText.match(/(?:renombrar\s+(?:el\s+)?([1-9]\d*)|(?:el\s+)?([1-9]\d*)\s+(?:y\s+)?(?:ll[aá]malo|ponle))\s+(?:a|por|como)?\s*(.+)/i);
        if (renameInDisMatch) {
          const num = parseInt(renameInDisMatch[1] || renameInDisMatch[2], 10);
          if (num >= 1 && num <= dis.candidates.length) {
            renameTargetCandidate = dis.candidates[num - 1];
            renameNewName = renameInDisMatch[3].trim();
          }
        }

        // 3. Identificar candidato por número (1, 2, 3...) o por texto (dirección o ID)
        let selectedCandidate = null;
        const numMatch = rawUserText.match(/^([1-9]\d*)$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0 && idx < dis.candidates.length) {
            selectedCandidate = dis.candidates[idx];
          }
        } else if (renameTargetCandidate) {
          selectedCandidate = renameTargetCandidate;
        } else {
          // Búsqueda por coincidencia en ID o dirección
          selectedCandidate = dis.candidates.find(c =>
            norm.includes(c.id.toLowerCase()) ||
            (c.clientAddress && norm.includes(c.clientAddress.toLowerCase())) ||
            (c.clientAddress && c.clientAddress.toLowerCase().includes(norm))
          );
        }

        if (selectedCandidate) {
          session.pendingDisambiguation = null;

          // Si el usuario pidió renombrar al elegir el candidato
          if (renameNewName) {
            renameClientBudget(session.phone || remoteJid, selectedCandidate.id, renameNewName);
            selectedCandidate.clientName = renameNewName;
            const sentRen = await sock.sendMessage(remoteJid, {
              text: `🏷️ *Cliente renombrado a "${renameNewName}"* para diferenciarlo.`
            });
            if (sentRen?.key?.id) botSentMessageIds.add(sentRen.key.id);
          }

          // Ejecutar la acción original con el presupuesto específico del cliente seleccionado
          if (dis.actionType === 'query_work_status') {
            await handleQueryWorkStatus(sock, remoteJid, session, selectedCandidate.id, dis.originalPayload?.onlyMissing);
            return;
          } else if (dis.actionType === 'update_work_task') {
            await handleUpdateWorkTask(sock, remoteJid, session, selectedCandidate.id, dis.originalPayload?.taskQuery, dis.originalPayload?.isDone);
            return;
          } else if (dis.actionType === 'add_shopping_items') {
            await handleAddShoppingItems(sock, remoteJid, session, dis.originalPayload?.items || [], selectedCandidate.clientName, selectedCandidate.id);
            return;
          } else if (dis.actionType === 'list_shopping_items') {
            await handleListShoppingItems(sock, remoteJid, session, selectedCandidate.clientName, selectedCandidate.id);
            return;
          } else if (dis.actionType === 'mark_shopping_items') {
            await handleMarkShoppingItemBought(sock, remoteJid, session, dis.originalPayload?.query, selectedCandidate.clientName, selectedCandidate.id);
            return;
          } else if (dis.actionType === 'rename_client') {
            if (dis.originalPayload?.newName) {
              await handleRenameClient(sock, remoteJid, session, selectedCandidate.id, dis.originalPayload.newName);
            }
            return;
          }
        } else {
          const sentClarify = await sock.sendMessage(remoteJid, {
            text: `⚠️ No he podido identificar tu elección. Por favor, responde con el número (*1* o *${dis.candidates.length}*) o escribe *"cancelar"*.`
          });
          if (sentClarify?.key?.id) botSentMessageIds.add(sentClarify.key.id);
          return;
        }
      }

      // 0. Interceptor de Permisos y Confirmaciones (Nivel B y C)
      if (isText && session.pendingAction) {
        const evalResult = evaluateConfirmationResponse(session.pendingAction, rawUserText);

        if (evalResult.status === 'APPROVED') {
          const act = session.pendingAction;
          session.pendingAction = null;

          if (act.type === 'remind_budget' || act.type === 'remind_invoice') {
            const clientName = act.data.clientName || 'el cliente';
            const lines = [
              `✍️ *¡Mensaje preparado para ${clientName}! (Listo para copiar y pegar)*`,
              '━━━━━━━━━━━━━━━━━━━━━━━━━',
              `${act.data.clientMessage}`,
              '━━━━━━━━━━━━━━━━━━━━━━━━━',
              '📋 _El bot nunca envía mensajes a tus clientes directamente. Solo tienes que copiar el texto superior y enviárselo desde tu propio WhatsApp._'
            ];

            if (act.data.directWaUrl) {
              lines.push('');
              lines.push('👉 *O pulsa aquí para abrir su WhatsApp con el texto ya escrito (1 clic):*');
              lines.push(act.data.directWaUrl);
            }

            const sentOk = await sock.sendMessage(remoteJid, { text: lines.join('\n') });
            if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);
            return;
          }

          if (act.type === 'schedule_appointment') {
            await handleScheduleAppointment(sock, remoteJid, session, act.data.appointmentInfo || {});
            return;
          }

          if (act.type === 'schedule_multiple_appointments') {
            const appsList = act.data.appointmentsList || [];
            for (const appInfo of appsList) {
              await handleScheduleAppointment(sock, remoteJid, session, appInfo);
            }
            const sentConfirm = await sock.sendMessage(remoteJid, {
              text: `✅ *${appsList.length} visitas guardadas en tu agenda.* Puedes escribir *"agenda"* en cualquier momento para verlas todas.`
            });
            if (sentConfirm?.key?.id) botSentMessageIds.add(sentConfirm.key.id);
            return;
          }

          if (act.type === 'cancel_appointment') {
            await handleCancelAppointment(sock, remoteJid, session, act.data.query);
            return;
          }

          if (act.type === 'update_appointment') {
            await handleUpdateAppointment(sock, remoteJid, session, act.data.updateInfo || {});
            return;
          }

          if (act.type === 'clear_shopping_list') {
            const phone = session.phone || String(remoteJid).replace(/\D/g, '');
            const res = clearShoppingList(phone);
            const sentClr = await sock.sendMessage(remoteJid, {
              text: `🗑️ *Lista de compras vaciada con éxito.* Se han eliminado ${res.deletedCount} materiales de tu lista.`
            });
            if (sentClr?.key?.id) botSentMessageIds.add(sentClr.key.id);
            return;
          }

          if (act.type === 'send_gestoria_package') {
            const phone = session.phone || String(remoteJid).replace(/\D/g, '');
            try {
              const res = await sendFiscalPackageToGestoria({
                businessId: phone,
                year: act.data.year,
                quarter: act.data.quarter,
                resendInstance: resend
              });

              // También enviar el paquete ZIP y el informe PDF a WhatsApp para el profesional
              const { zipBuffer, pdfBuffer, fileName } = await buildGestoriaPackageZip(phone, act.data.year, act.data.quarter);

              const sentOk = await sock.sendMessage(remoteJid, {
                text: `✅ *¡Paquete de Cierre Trimestral enviado con éxito!*\n\n📧 Se ha remitido el dossier completo a tu gestoría en *${res.targetEmail || session.company?.gestoriaEmail}*.\n\n📎 Te dejo aquí también una copia del ZIP oficial y el PDF para tu archivo personal:`
              });
              if (sentOk?.key?.id) botSentMessageIds.add(sentOk.key.id);

              const sentZip = await sock.sendMessage(remoteJid, {
                document: zipBuffer,
                mimetype: 'application/zip',
                fileName: fileName,
                caption: `📦 *${fileName}*\nLibros Registro Oficiales AEAT en Excel multicapa y CSVs.`
              });
              if (sentZip?.key?.id) botSentMessageIds.add(sentZip.key.id);

              const sentPdf = await sock.sendMessage(remoteJid, {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: `Informe_Fiscal_${act.data.year || '2026'}_Q${act.data.quarter || '3'}.pdf`,
                caption: `📄 *Informe Oficial para Gestoría (PDF)*`
              });
              if (sentPdf?.key?.id) botSentMessageIds.add(sentPdf.key.id);

            } catch (err) {
              const sentErr = await sock.sendMessage(remoteJid, {
                text: `⚠️ *Error al enviar el paquete a la gestoría:* ${err.message}`
              });
              if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
            }
            return;
          }
        } else if (evalResult.status === 'REJECTED') {
          session.pendingAction = null;
          const sentRej = await sock.sendMessage(remoteJid, {
            text: '👍 *Acción descartada.* No se ha enviado ningún mensaje ni se han modificado datos.'
          });
          if (sentRej?.key?.id) botSentMessageIds.add(sentRej.key.id);
          return;
        } else if (evalResult.status === 'NEED_STRONG_CONFIRMATION') {
          const sentReq = await sock.sendMessage(remoteJid, {
            text: '🔒 *Confirmación de seguridad requerida (Nivel C):*\n\nEsta acción modificará tu agenda o datos financieros. Por favor, responde exactamente *"CONFIRMAR"* para proceder o *"CANCELAR"* para descartar.'
          });
          if (sentReq?.key?.id) botSentMessageIds.add(sentReq.key.id);
          return;
        }
      }

      // Comando directo para invocar al Secretario Digital / Resumen del día
      if (/^(?:secretario|briefing|resumen(?:\s+(?:del?\s+)?d[ií]a)?|agenda\s+de\s+hoy|mi\s+d[ií]a)$/i.test(rawUserText)) {
        const briefingText = generateDailyBriefing(senderNumber);

        // Comprobar si hay presupuestos fríos (>= 2 días) o facturas pendientes (>= 7 días) para sugerir acción (Nivel B)
        const pendingBudgets = getBudgetsPendingFollowUp(senderNumber);
        const urgentBudget = pendingBudgets.find(b => b.daysWaiting >= 2);

        let extraText = '';
        if (urgentBudget) {
          const proposal = buildBudgetFollowUpProposal(urgentBudget);
          session.pendingAction = createProposedAction('B', 'remind_budget', {
            clientName: urgentBudget.clientName,
            clientPhone: urgentBudget.clientPhone,
            totalAmount: urgentBudget.totalAmount,
            clientMessage: proposal.clientMessage,
            directWaUrl: proposal.directWaUrl
          }, proposal.promptMessage);

          extraText = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\n👉 *Sugerencia del Secretario (Nivel B):*\n${proposal.promptMessage}\n\n_(Responde *"Sí"* para preparar el recordatorio o *"No"* para descartar)_`;
        } else {
          const unpaidInvoices = getUnpaidInvoices(senderNumber);
          const urgentInv = unpaidInvoices.find(i => i.daysPending >= 7);
          if (urgentInv) {
            const proposal = buildInvoiceFollowUpProposal(urgentInv, session.company);
            session.pendingAction = createProposedAction('B', 'remind_invoice', {
              clientName: urgentInv.clientName,
              clientPhone: urgentInv.clientPhone,
              totalAmount: urgentInv.totalAmount,
              clientMessage: proposal.clientMessage,
              directWaUrl: proposal.directWaUrl
            }, proposal.promptMessage);

            extraText = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━\n👉 *Sugerencia del Secretario (Nivel B):*\n${proposal.promptMessage}\n\n_(Responde *"Sí"* para preparar el mensaje de cobro o *"No"* para descartar)_`;
          }
        }

        const sentBriefing = await sock.sendMessage(remoteJid, { text: briefingText + extraText });
        if (sentBriefing?.key?.id) botSentMessageIds.add(sentBriefing.key.id);
        return;
      }

      // 0. Si el profesional está en medio del onboarding conversacional guiado
      const onboardingState = getOnboardingState(senderNumber);
      if (onboardingState.step) {
        const stepResult = processOnboardingStep(senderNumber, rawUserText);
        if (stepResult.handled) {
          session.company = getCompany(senderNumber);
          const sentStep = await sock.sendMessage(remoteJid, { text: stepResult.message });
          if (sentStep?.key?.id) botSentMessageIds.add(sentStep.key.id);
          return;
        }
      }

      // 1. Detección de saludo inicial / Onboarding para profesionales no configurados
      const isGreeting = /^(?:hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|hey|qu[eé]\s+tal|empezar|inicio|ayuda)$/i.test(rawUserText);
      const isExplicitOnboarding = /^(?:onboarding|configurar todo|configurar perfil|reiniciar onboarding|registro)$/i.test(rawUserText);

      if ((isGreeting && session.company && session.company.isConfigured === false) || isExplicitOnboarding) {
        const welcomeText = startOnboarding(senderNumber);
        session.company = getCompany(senderNumber);
        const sentWelcome = await sock.sendMessage(remoteJid, { text: welcomeText });
        if (sentWelcome?.key?.id) botSentMessageIds.add(sentWelcome.key.id);
        return;
      }

      // 2. Comando directo para configurar oficio o especialidad
      const tradeDirectMatch = rawUserText.match(/^(?:soy|mi oficio es|mi gremio es|somos|oficio|gremio|cambiar oficio a|cambiar gremio a)\s+([a-záéíóúñ\s/]+)$/i);
      if (tradeDirectMatch) {
        const rawTrade = tradeDirectMatch[1].trim().toLowerCase();
        let normalizedTrade = 'Reformas y Construcción';
        let defaultTax = 10;

        if (/electri/i.test(rawTrade)) {
          normalizedTrade = 'Electricidad y Telecomunicaciones';
          defaultTax = 21;
        } else if (/fontan|plomer/i.test(rawTrade)) {
          normalizedTrade = 'Fontanería y Saneamiento';
          defaultTax = 21;
        } else if (/albañil|obra|construc|reforma/i.test(rawTrade)) {
          normalizedTrade = 'Albañilería y Reformas';
          defaultTax = 10;
        } else if (/carpinter/i.test(rawTrade)) {
          normalizedTrade = 'Carpintería y Madera';
          defaultTax = 21;
        } else if (/clima|aire|calefac/i.test(rawTrade)) {
          normalizedTrade = 'Climatización y Calefacción';
          defaultTax = 21;
        } else if (/pint/i.test(rawTrade)) {
          normalizedTrade = 'Pintura y Revestimientos';
          defaultTax = 21;
        } else if (/cerraj/i.test(rawTrade)) {
          normalizedTrade = 'Cerrajería y C. Metálica';
          defaultTax = 21;
        } else {
          normalizedTrade = rawTrade.charAt(0).toUpperCase() + rawTrade.slice(1);
        }

        const updated = saveCompany(senderNumber, { trade: normalizedTrade, defaultTaxRate: defaultTax });
        session.company = updated;

        const sentTrade = await sock.sendMessage(remoteJid, {
          text: `🛠️ *¡Oficio configurado con éxito: ${normalizedTrade}!* 🎉\n━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `• A partir de ahora, la IA adaptará las mediciones, capítulos y terminología técnica oficial a tu sector (*${normalizedTrade}*).\n` +
            `• Tipo de IVA por defecto: *${defaultTax}%* (modificable en cualquier presupuesto).\n\n` +
            `💡 _Para completar tus datos fiscales (Nombre, CIF, IBAN) di: "Configurar empresa Nombre..., CIF..." o consúltalos con "mi empresa"._`
        });
        if (sentTrade?.key?.id) botSentMessageIds.add(sentTrade.key.id);
        return;
      }

      // Comando directo para consultar ficha y datos fiscales de la empresa
      if (/^(?:mi empresa|mis datos|datos empresa|perfil|datos fiscales)$/i.test(rawUserText)) {
        const companyText = formatCompanyForWhatsApp(session.company);
        const sentComp = await sock.sendMessage(remoteJid, { text: companyText });
        if (sentComp?.key?.id) botSentMessageIds.add(sentComp.key.id);
        return;
      }

      // Comando directo para configurar datos de la empresa: ej. "configurar empresa CIF B-12345678, Nombre Reformas Pepe..."
      const configCompanyMatch = rawUserText.match(/^(?:configurar empresa|cambiar empresa|datos empresa|modificar empresa)\s+(.+)$/i);
      if (configCompanyMatch) {
        const configText = configCompanyMatch[1];
        const newCompanyData = {};

        const cifMatch = configText.match(/\b([ABCDEFGHJKLMNPQRSUVW][0-9]{7}[0-9A-J]|[0-9]{8}[TRWAGMYFPDXBNJZSQVHLCKE])\b/i);
        if (cifMatch) newCompanyData.cif = cifMatch[1].toUpperCase();

        const ibanMatch = configText.match(/\b(ES\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/i);
        if (ibanMatch) newCompanyData.iban = ibanMatch[1].replace(/[\s-]/g, '').replace(/(.{4})/g, '$1 ').trim();

        const bizumMatch = configText.match(/(?:bizum|m[oó]vil)[:\s]+([67]\d{8})\b/i);
        if (bizumMatch) newCompanyData.bizum = bizumMatch[1];

        const emailMatch = configText.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
        if (emailMatch) newCompanyData.email = emailMatch[1];

        const nameMatch = configText.match(/(?:nombre|empresa|raz[oó]n social)[:\s]+([^,;\n]+)/i);
        if (nameMatch) newCompanyData.name = nameMatch[1].trim();

        const dirMatch = configText.match(/(?:direcci[oó]n|calle|ubicaci[oó]n)[:\s]+([^,;\n]+)/i);
        if (dirMatch) newCompanyData.address = dirMatch[1].trim();

        const tradeMatch = configText.match(/(?:oficio|gremio|especialidad|profesi[oó]n)[:\s]+([^,;\n]+)/i);
        if (tradeMatch) newCompanyData.trade = tradeMatch[1].trim();

        if (!newCompanyData.name && !cifMatch && !ibanMatch) {
          newCompanyData.name = configText.trim();
        }

        const updated = saveCompany(senderNumber, newCompanyData);
        session.company = updated;

        const confText = [
          '✅ *¡Datos de tu empresa actualizados con éxito!*',
          '━━━━━━━━━━━━━━━━━━━━━━━━━',
          `🛠️ *Oficio / Especialidad:* ${updated.trade}`,
          `📛 *Empresa:* ${updated.name}`,
          `🆔 *CIF:* ${updated.cif}`,
          `📍 *Dirección:* ${updated.address}`,
          `🏦 *IBAN:* ${updated.iban}`,
          `📱 *Bizum:* ${updated.bizum}`,
          `📞 *Teléfono:* ${updated.phone}`,
          `✉️ *Email:* ${updated.email}`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━',
          '📄 _Todos tus próximos presupuestos, facturas y recibos oficiales se emitirán con estos datos._'
        ].join('\n');

        const sentConf = await sock.sendMessage(remoteJid, { text: confText });
        if (sentConf?.key?.id) botSentMessageIds.add(sentConf.key.id);
        return;
      }

      // Comando directo para configurar email de la gestoría: ej. "mi gestoría es gestoria@ejemplo.com"
      const configGestoriaMatch = rawUserText.match(/^(?:mi gestor[ií]a es|email gestor[ií]a|configurar gestor[ií]a)\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
      if (configGestoriaMatch) {
        const gestoriaEmail = configGestoriaMatch[1].trim().toLowerCase();
        const updated = saveCompany(senderNumber, { gestoriaEmail });
        session.company = updated;
        const sentConf = await sock.sendMessage(remoteJid, {
          text: `✅ *¡Email de tu gestoría guardado con éxito!*\n\n📧 *Gestoría:* ${gestoriaEmail}\n\nA partir de ahora, cuando quieras enviar tus facturas solo di: *"Enviar trimestre a mi gestoría"* o *"gestoría"* y se le remitirá el Excel y el PDF en 1 clic.`
        });
        if (sentConf?.key?.id) botSentMessageIds.add(sentConf.key.id);
        return;
      }

      // Comando directo para exportar el trimestre para la gestoría: ej. "gestoría", "trimestre", "3T", "exportar 3T"
      const quarterCmdMatch = rawUserText.match(/^(?:(?:exportar|cerrar|sacar|enviar|mandar|resumen)?\s*(?:el\s+)?(?:trimestre|gestor[ií]a|modelo\s*303|informe\s*fiscal)|1t|2t|3t|4t)(?:\s+(?:del?\s+)?(1t|2t|3t|4t|\d{4}))?(?:\s+(?:del?\s+)?(\d{4}))?$/i);
      if (quarterCmdMatch) {
        let qInput = null;
        let yInput = null;

        const directQ = rawUserText.match(/\b([1-4]t)\b/i);
        if (directQ) qInput = directQ[1];
        else if (quarterCmdMatch[1] && /[1-4]t/i.test(quarterCmdMatch[1])) qInput = quarterCmdMatch[1];

        const yearMatch = rawUserText.match(/\b(202[4-9])\b/);
        if (yearMatch) yInput = yearMatch[1];

        const shouldEmail = /enviar|mandar/i.test(rawUserText);

        await handleQuarterExport(sock, remoteJid, session, qInput, yInput, shouldEmail);
        return;
      }

      // Comando directo para listar o consultar presupuestos (todos, pendientes de firma, aceptados, borradores)
      const budgetListFilter = detectBudgetListIntent(rawUserText);
      if (budgetListFilter) {
        await handleListBudgets(sock, remoteJid, session, budgetListFilter);
        return;
      }

      // Comando directo para obtener el enlace de firma digital de un presupuesto: ej. "enlace alberto", "enlace PRE-2026-6136", "link"
      const signingLinkMatch = rawUserText.match(/^(?:enlace|link|url|firma|firmar)(?:\s+(?:de|del)?\s*(.+))?$/i);
      if (signingLinkMatch && !/^(?:firmar|firma)\s+(?:presupuesto|obra)$/i.test(rawUserText)) {
        await handleSendSigningLink(sock, remoteJid, session, signingLinkMatch[1] || '');
        return;
      }

      // Comando de recuperación de PDF: "pdf de [cliente]", "reenviar pdf alberto", "pdf PRE-2026-xxxx"
      const pdfRecoveryMatch = rawUserText.match(/^(?:pdf|reenviar\s+pdf|enviar\s+pdf|mandar\s+pdf|volver\s+a\s+enviar\s+pdf)(?:\s+(?:de|del)?\s*(.+))?$/i);
      if (pdfRecoveryMatch) {
        const query = (pdfRecoveryMatch[1] || '').trim();
        const budgetList = [...session.budgets.values()];
        let target = null;
        if (query) {
          target = budgetList.find(b =>
            (b.id && b.id.toLowerCase().includes(query.toLowerCase())) ||
            (b.client?.name && b.client.name.toLowerCase().includes(query.toLowerCase()))
          );
        }
        if (!target && session.activeBudgetId) target = session.budgets.get(session.activeBudgetId);
        if (!target && budgetList.length > 0) target = budgetList[budgetList.length - 1];

        if (!target) {
          const sentNoBudget = await sock.sendMessage(remoteJid, {
            text: '⚠️ No encontré ningún presupuesto para regenerar el PDF. Indica el nombre del cliente o el número de presupuesto.'
          });
          if (sentNoBudget?.key?.id) botSentMessageIds.add(sentNoBudget.key.id);
        } else {
          try {
            const pdfBuffer = await generateBudgetPDF(target);
            const pdfFileName = `Presupuesto_${target.id || 'Obra'}.pdf`;
            const sentDoc = await sock.sendMessage(remoteJid, {
              document: pdfBuffer,
              mimetype: 'application/pdf',
              fileName: pdfFileName,
              caption: `📄 *${pdfFileName}*\nPresupuesto formal en PDF listo para enviar a tu cliente.`
            });
            if (sentDoc?.key?.id) botSentMessageIds.add(sentDoc.key.id);
            try {
              const signingUrl = generateSigningUrl(target, session.company, cleanPhone);
              const sentSig = await sock.sendMessage(remoteJid, {
                text: `✍️ *Enlace de Aceptación y Firma Digital:*\n${signingUrl}\n\n📲 _Compártelo con tu cliente para que firme desde su móvil._`
              });
              if (sentSig?.key?.id) botSentMessageIds.add(sentSig.key.id);
            } catch (sigErr) {
              console.warn('⚠️ No se pudo generar enlace de firma en recuperación PDF:', sigErr.message);
            }
          } catch (pdfRecovErr) {
            console.error('⚠️ Error regenerando PDF:', pdfRecovErr.message);
            const sentErrRecov = await sock.sendMessage(remoteJid, {
              text: `⚠️ No se pudo regenerar el PDF: ${pdfRecovErr.message}`
            });
            if (sentErrRecov?.key?.id) botSentMessageIds.add(sentErrRecov.key.id);
          }
        }
        return;
      }


      if (/^(presupuesto nuevo|nuevo presupuesto|nuevo|otro cliente|empezar de nuevo|#nuevo)$/i.test(rawUserText)) {
        session.activeBudgetId = null;
        const sentReset = await sock.sendMessage(remoteJid, {
          text: '🔄 *Listo para un nuevo presupuesto.*\n\nEnvíame un audio o mensaje con los trabajos y el cliente de la nueva obra.'
        });
        if (sentReset?.key?.id) botSentMessageIds.add(sentReset.key.id);
        console.log(`🔄 Sesión puesta en modo NUEVO presupuesto para ${remoteJid}`);
        return;
      }

      // Comando directo para registrar cobro: ej. "cobro 1500", "pago 1000 Jose Luis Bizum", "anticipo 800 transferencia"
      const paymentCmdMatch = rawUserText.match(/^(?:cobro|pago|cobrado|pagado|ingreso|anticipo)\s+(\d+(?:[.,]\d+)?)\s*(?:€|euros?)?(?:\s+(?:de|por|en|para)?\s*(.+))?$/i);
      if (paymentCmdMatch) {
        if (session.budgets.size === 0) {
          const sentNoBudg = await sock.sendMessage(remoteJid, {
            text: '📂 *No tienes ningún presupuesto activo para registrar cobros.*\n\nPrimero crea una obra y luego podrás apuntar los anticipos y pagos.'
          });
          if (sentNoBudg?.key?.id) botSentMessageIds.add(sentNoBudg.key.id);
          return;
        }

        const rawAmount = paymentCmdMatch[1].replace(',', '.');
        const amount = parseFloat(rawAmount);
        const rest = (paymentCmdMatch[2] || '').trim();

        let method = 'Bizum';
        if (/transferencia|banco|cuenta/i.test(rest)) method = 'Transferencia';
        else if (/efectivo|met[aá]lico|mano/i.test(rest)) method = 'Efectivo';
        else if (/bizum/i.test(rest)) method = 'Bizum';

        const cleanQuery = rest.replace(/bizum|transferencia|efectivo|met[aá]lico|en\s+mano/gi, '').trim();
        const target = findBudgetInSession(session, cleanQuery);

        await handlePaymentRegistration(sock, remoteJid, session, target, {
          amount,
          method,
          concept: 'Entrega a cuenta de trabajos'
        });
        return;
      }

      // Comando directo para consultar saldo o deuda: ej. "¿cuánto me debe José Luis?", "deuda José Luis", "saldo"
      const balanceCmdMatch = rawUserText.match(/^(?:[¿?]?(?:cu[aá]nto\s+me\s+debe|deuda|saldo|pagos|estado\s+de\s+cuenta)\s*(?:de\s+)?(.+)?)$/i);
      if (balanceCmdMatch) {
        const query = (balanceCmdMatch[1] || '').replace(/[?¿]/g, '').trim();
        const target = findBudgetInSession(session, query);
        await handleQueryBalance(sock, remoteJid, session, target);
        return;
      }

      // Comando directo para aceptar presupuesto: ej. "aceptar", "aceptado", "presupuesto aceptado", "aceptar José Luis", "firmado"
      const acceptCmdMatch = rawUserText.match(/^(?:aceptar|aceptado|firmado|aprobar|confirmar)\s*(?:el\s+)?(?:presupuesto)?(?:\s+(?:de\s+)?(.+))?$/i);
      if (acceptCmdMatch && !/^(?:citas|visitas|agenda)/i.test(rawUserText)) {
        const query = (acceptCmdMatch[1] || '').trim();
        const target = findBudgetInSession(session, query);
        await handleAcceptBudget(sock, remoteJid, session, target);
        return;
      }

      // Comando directo para Factura de Anticipo con IVA: "factura de anticipo", "facturar anticipo", "factura anticipo Juan"
      const advanceInvCmdMatch = rawUserText.match(/^(?:factura\s+(?:de\s+)?anticipo|facturar\s+anticipo|emitir\s+factura\s+(?:de\s+)?anticipo)(?:\s+(?:de\s+|del\s+presupuesto\s+|de\s+la\s+obra\s+de\s+|el\s+presupuesto\s+)?(.+))?$/i);
      if (advanceInvCmdMatch) {
        if (session.budgets.size === 0) {
          const sentNoBudget = await sock.sendMessage(remoteJid, {
            text: '📂 *No tienes ningún presupuesto registrado todavía.*\n\nPrimero genera un presupuesto y podrás emitir la factura de anticipo.'
          });
          if (sentNoBudget?.key?.id) botSentMessageIds.add(sentNoBudget.key.id);
          return;
        }

        const query = advanceInvCmdMatch[1] ? advanceInvCmdMatch[1].trim() : '';
        const target = findBudgetInSession(session, query);
        await handleAdvanceInvoice(sock, remoteJid, session, target);
        return;
      }

      // Comando directo para facturar: "factura", "facturar", "factura de José Luis", "facturar 5129"
      const invoiceCmdMatch = rawUserText.match(/^(?:factura|facturar|emitir factura)(?:\s+(?:de\s+|del\s+presupuesto\s+|de\s+la\s+obra\s+de\s+|el\s+presupuesto\s+)?(.+))?$/i);
      if (invoiceCmdMatch) {
        if (session.budgets.size === 0) {
          const sentNoBudget = await sock.sendMessage(remoteJid, {
            text: '📂 *No tienes ningún presupuesto para facturar todavía.*\n\nPrimero genera un presupuesto con una obra y luego podrás emitir su factura oficial.'
          });
          if (sentNoBudget?.key?.id) botSentMessageIds.add(sentNoBudget.key.id);
          return;
        }

        const query = invoiceCmdMatch[1] ? invoiceCmdMatch[1].trim() : '';
        const target = findBudgetInSession(session, query);
        await emitInvoiceForBudget(sock, remoteJid, session, target);
        return;
      }

      // Comando directo para consultar agenda: ej. "agenda", "mis citas", "visitas", "cual es el estado de mis citas", etc.
      const isAgendaCmd = /^(?:[¿?]?\s*(?:cu[aá]l\s+es\s+el\s+estado\s+de\s+(?:mis\s+)?citas|qu[eé]\s+(?:citas|visitas)\s+tengo(?:\s+agendadas)?|agenda|mis citas|visitas|citas|mis visitas|ver citas|ver agenda|mis citas agendadas|citas pendientes))[¿?]?$/i.test(rawUserText.trim())
        || /^(?:agenda|mis citas|visitas|citas|mis visitas)(?:\s+(hoy|ma[ñn]ana|todas|pr[oó]ximas))?$/i.test(rawUserText.trim())
        || /^(?:citas hoy|visitas hoy|agenda hoy)$/i.test(rawUserText.trim())
        || /^(?:citas ma[ñn]ana|visitas ma[ñn]ana|agenda ma[ñn]ana)$/i.test(rawUserText.trim());

      if (isAgendaCmd) {
        let filter = 'all';
        if (/hoy/i.test(rawUserText)) filter = 'today';
        else if (/ma[ñn]ana/i.test(rawUserText)) filter = 'tomorrow';

        await handleListAppointments(sock, remoteJid, session, filter);
        return;
      }

      // Comando directo para cancelar cita: ej. "cancelar cita Juan", "anular visita Pedro"
      const cancelCmdMatch = rawUserText.match(/^(?:cancelar|anular|borrar)\s+(?:la\s+)?(?:cita|visita)(?:\s+(?:con|de)?\s*(.+))?$/i);
      if (cancelCmdMatch) {
        const query = (cancelCmdMatch[1] || '').trim();
        if (!query) {
          const sentNeedQuery = await sock.sendMessage(remoteJid, {
            text: '⚠️ *Indica el nombre del cliente o referencia de la cita* que deseas anular (ej: *"cancelar cita Juan"*).'
          });
          if (sentNeedQuery?.key?.id) botSentMessageIds.add(sentNeedQuery.key.id);
        } else {
          await handleCancelAppointment(sock, remoteJid, session, query);
        }
        return;
      }

      // Comando directo para consultar lista de compras / materiales: ej. "lista de la compra", "¿qué tengo que comprar?", "¿qué tengo que comprar para Carlos?"
      const listShoppingMatch = rawUserText.match(/^(?:lista\s+de\s+(?:la\s+)?compras?|materiales\s+pendientes|qu[eé]\s+(?:tengo\s+que|hay\s+que)\s+comprar|ver\s+compras?|mis\s+compras|materiales)(?:\s+(?:de|para|en\s+la\s+obra\s+de)\s+(.+))?$/i);
      if (listShoppingMatch) {
        const clientFilter = (listShoppingMatch[1] || '').trim() || null;
        await handleListShoppingItems(sock, remoteJid, session, clientFilter);
        return;
      }

      // Comando directo para marcar material como comprado: ej. "ya compré el cemento", "comprado azulejo", "tachar cable de Carlos"
      const boughtCmdMatch = rawUserText.match(/^(?:ya\s+compr[eé]|comprad[oa]s?|tachad[oa]s?|tachar)\s+(.+)$/i);
      if (boughtCmdMatch) {
        const fullQuery = boughtCmdMatch[1].trim();
        let clientQuery = null;
        let itemQuery = fullQuery;
        const deMatch = fullQuery.match(/^(.+?)\s+(?:de|para)\s+(.+)$/i);
        if (deMatch) {
          itemQuery = deMatch[1].trim();
          clientQuery = deMatch[2].trim();
        }
        await handleMarkShoppingItemBought(sock, remoteJid, session, itemQuery, clientQuery);
        return;
      }

      // Comando directo para vaciar o borrar la lista de compras: ej. "vaciar lista de compras", "borrar lista de la compra"
      if (/^(?:borrar|vaciar|limpiar)\s+(?:la\s+)?lista\s+de\s+(?:la\s+)?compras?$/i.test(rawUserText)) {
        await handleClearShoppingList(sock, remoteJid, session);
        return;
      }

      // Comando directo para consultar qué falta en una obra (Modo Obra - Faltantes)
      const missingWorkMatch = rawUserText.match(/^(?:qu[eé]\s+(?:nos\s+)?falta\s+(?:en\s+la\s+obra\s+de|en|para)\s+|qu[eé]\s+falta\s+(?:de|en|para)\s+)(.+)$/i);
      if (missingWorkMatch) {
        const clientFilter = (missingWorkMatch[1] || '').replace(/[?¿!¡]/g, '').trim();
        await handleQueryWorkStatus(sock, remoteJid, session, clientFilter, true);
        return;
      }

      // Comando directo para consultar estado o modo obra completo
      const modeWorkMatch = rawUserText.match(/^(?:modo\s+obra|estado\s+(?:de\s+la\s+)?obra|ficha\s+(?:de\s+la\s+)?obra|memoria\s+obra|c[oó]mo\s+va\s+la\s+obra\s+de)\s+(.+)$/i);
      if (modeWorkMatch) {
        const clientFilter = (modeWorkMatch[1] || '').replace(/[?¿!¡]/g, '').trim();
        await handleQueryWorkStatus(sock, remoteJid, session, clientFilter, false);
        return;
      }

      // Comando directo para marcar tarea/partida como realizada o completada
      const taskDoneMatch = rawUserText.match(/^(?:ya\s+(?:hemos\s+)?terminad[oa]|terminad[oa]|hech[oa]|lista)\s+(?:la\s+|el\s+)?(demolici[oó]n|fontaner[ií]a|alicatado|pintura|sanitarios?|electricidad|carpinter[ií]a|solado|tabiquer[ií]a|[a-záéíóúñ\s]+?)\s+(?:de|en\s+la\s+obra\s+de)\s+(.+)$/i);
      if (taskDoneMatch) {
        const taskQuery = (taskDoneMatch[1] || '').trim();
        const clientFilter = (taskDoneMatch[2] || '').trim();
        await handleUpdateWorkTask(sock, remoteJid, session, clientFilter, taskQuery, true);
        return;
      }

      const markTaskExplicitMatch = rawUserText.match(/^(?:marca[r]?|poner)\s+(?:la\s+|el\s+)?(.+?)\s+(?:de|para)\s+(.+?)\s+como\s+(?:hech[oa]|list[oa]|terminad[oa])$/i);
      if (markTaskExplicitMatch) {
        const taskQuery = (markTaskExplicitMatch[1] || '').trim();
        const clientFilter = (markTaskExplicitMatch[2] || '').trim();
        await handleUpdateWorkTask(sock, remoteJid, session, clientFilter, taskQuery, true);
        return;
      }

      // Comando directo para renombrar cliente o añadir distintivo:
      // ej: "renombrar cliente Alberto Martín a Alberto Martín (Centro)", "cambiar nombre de cliente Alberto a Alberto Centro"
      const renameCmdMatch = rawUserText.match(/^(?:renombrar\s+cliente|ponerle\s+distintivo\s+a|cambiar\s+nombre\s+(?:de\s+)?cliente)\s+(.+?)\s+(?:a|por|como)\s+(.+)$/i);
      if (renameCmdMatch) {
        const targetQuery = renameCmdMatch[1].trim();
        const newName = renameCmdMatch[2].trim();
        await handleRenameClient(sock, remoteJid, session, targetQuery, newName);
        return;
      }

      // 3. Router de Intenciones Determinístico (Resuelve con SQLite sin pasar por Gemini)
      if (!isAudio && rawUserText) {
        const detected = detectIntent(rawUserText);
        if (detected) {
          console.log(`⚡ [IntentRouter] Intención detectada: ${detected.intent}`, detected.params);

          if (detected.intent === 'SEND_TO_GESTORIA') {
            const comp = getCompany(senderNumber);
            if (comp.gestoriaEmail) {
              session.pendingAction = createProposedAction('C', 'send_gestoria_package', {
                quarter: detected.params.quarter,
                year: detected.params.year
              }, 'Enviar paquete fiscal a gestoría');
            }
            const resolvedReply = await resolveIntent(detected, senderNumber, session);
            if (resolvedReply) {
              const sentIntentMsg = await sock.sendMessage(remoteJid, { text: resolvedReply });
              if (sentIntentMsg?.key?.id) botSentMessageIds.add(sentIntentMsg.key.id);
            }
            return;
          }

          if (detected.intent === 'FISCAL_QUARTER_SUMMARY') {
            const resolvedReply = await resolveIntent(detected, senderNumber, session);
            if (resolvedReply) {
              const sentIntentMsg = await sock.sendMessage(remoteJid, { text: resolvedReply });
              if (sentIntentMsg?.key?.id) botSentMessageIds.add(sentIntentMsg.key.id);
            }
            try {
              const { zipBuffer, pdfBuffer, fileName } = await buildGestoriaPackageZip(
                senderNumber,
                detected.params.year,
                detected.params.quarter
              );
              const sentZip = await sock.sendMessage(remoteJid, {
                document: zipBuffer,
                mimetype: 'application/zip',
                fileName: fileName,
                caption: `📦 *${fileName}*\nLibro Oficial normalizado en Excel multicapa + CSVs.`
              });
              if (sentZip?.key?.id) botSentMessageIds.add(sentZip.key.id);

              const sentPdf = await sock.sendMessage(remoteJid, {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: `Informe_Fiscal_${detected.params.year || new Date().getFullYear()}_Q${detected.params.quarter || 'Activo'}.pdf`,
                caption: `📄 *Informe Oficial de Cierre para Gestoría (PDF)*`
              });
              if (sentPdf?.key?.id) botSentMessageIds.add(sentPdf.key.id);
            } catch (fileErr) {
              console.error('Error generando adjuntos de trimestre:', fileErr.message);
            }
            return;
          }

          const resolvedReply = await resolveIntent(detected, senderNumber, session);
          if (resolvedReply) {
            const sentIntentMsg = await sock.sendMessage(remoteJid, { text: resolvedReply });
            if (sentIntentMsg?.key?.id) botSentMessageIds.add(sentIntentMsg.key.id);
            return;
          }
        }
      }

      // Preparar payload de IA (audio o texto)
      let audioBuffer = null;
      if (isAudio) {
        try {
          console.log('\n🎙️ Nota de voz recibida. Descargando audio de WhatsApp...');
          audioBuffer = await downloadMediaMessage(
            { key: msg.key, message: messageContent },
            'buffer',
            {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          );
        } catch (dlErr) {
          console.error('❌ Error descargando audio:', dlErr.message);
          const sentDlErr = await sock.sendMessage(remoteJid, {
            text: '⚠️ *No se pudo descargar la nota de voz.* Por favor, vuelve a enviarla.'
          });
          if (sentDlErr?.key?.id) botSentMessageIds.add(sentDlErr.key.id);
          return;
        }
      }

      // Debounce anti-duplicados por contenido idéntico en <5s (evita dobles envíos por sincronización Baileys/WhatsApp)
      const contentKey = isAudio 
        ? `audio_${audioBuffer?.length || ''}`
        : `text_${rawUserText.trim().toLowerCase()}`;
      
      if (contentKey && contentKey !== 'text_') {
        const lastMsg = recentMessageTexts.get(remoteJid);
        const nowMs = Date.now();
        if (lastMsg && lastMsg.key === contentKey && (nowMs - lastMsg.time) < 5000) {
          console.log(`   ⏭️ Mensaje con contenido idéntico en <5s para ${remoteJid} ignorado (debounce anti-duplicados).`);
          return;
        }
        recentMessageTexts.set(remoteJid, { key: contentKey, time: nowMs });
        if (recentMessageTexts.size > 2000) {
          const oldestKey = recentMessageTexts.keys().next().value;
          recentMessageTexts.delete(oldestKey);
        }
      }

      const taskData = {
        isAudio,
        audioBuffer,
        audioMimeType: audioMsg?.mimetype || 'audio/ogg',
        rawUserText,
        senderNumber
      };

      try {
        await handleAiProcessing(sock, remoteJid, session, taskData, false);
      } catch (err) {
        console.error('❌ Error procesando mensaje de WhatsApp:', err.message);
        const isOverload = /429|503|quota|exhausted|overload|demand|busy|unavailable|high demand|saturad/i.test(err.message || '');
        if (isOverload) {
          const alreadyQueued = aiStandbyQueue.some(item =>
            item.remoteJid === remoteJid &&
            ((taskData.rawUserText && item.taskData.rawUserText === taskData.rawUserText) ||
             (taskData.isAudio && item.taskData.isAudio && item.taskData.audioBuffer?.length === taskData.audioBuffer?.length))
          );
          if (alreadyQueued) {
            console.log(`⏳ Petición idéntica ya en cola stand-by para ${remoteJid}. No se duplica.`);
            return;
          }
          aiStandbyQueue.push({
            id: Date.now(),
            remoteJid,
            session,
            taskData,
            attempts: 0,
            processing: false,
            nextRetryAt: Date.now() + 5000
          });
          console.log(`⏳ Petición guardada en cola stand-by para ${remoteJid} por alta demanda de Gemini.`);
          const sentStandby = await sock.sendMessage(remoteJid, {
            text: `⏳ *Servidores de IA con alta demanda temporal*\n\nHe dejado tu ${isAudio ? 'nota de voz' : 'mensaje'} guardado en *cola de espera (stand-by)*. El bot reintentará procesarlo automáticamente en segundo plano hasta que se genere tu presupuesto, sin que tengas que volver a grabar ni enviar nada.\n\n_En cuanto esté listo, te llegará aquí el presupuesto._`
          });
          if (sentStandby?.key?.id) botSentMessageIds.add(sentStandby.key.id);
        } else {
          const sentErr = await sock.sendMessage(remoteJid, {
            text: `⚠️ *No se ha podido procesar el presupuesto*\n\nHa habido una incidencia temporal (${err.message.substring(0, 80)}...). Por favor, reenvía tu solicitud.`
          });
          if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
        }
      } finally {
        await sock.sendPresenceUpdate('paused', remoteJid);
      }
      isSuccess = true;
    } catch (err) {
      console.error(`❌ Error en executeMessageDispatch para ${remoteJid}:`, err);
      if (wamId) updateMessageStatus(wamId, 'FAILED');
      if (allWamIds) {
        allWamIds.forEach(id => updateMessageStatus(id, 'FAILED'));
      }
      throw err;
    } finally {
      if (isSuccess) {
        if (wamId) updateMessageStatus(wamId, 'PROCESSED');
        if (allWamIds) {
          allWamIds.forEach(id => updateMessageStatus(id, 'PROCESSED'));
        }
      }
    }
  }

  async function processChatQueue(sock, remoteJid, senderNumber) {
    if (activeProcessingJids.has(remoteJid)) {
      return;
    }
    activeProcessingJids.add(remoteJid);
    setConversationState(remoteJid, 'PROCESSING');

    try {
      while (true) {
        const queue = chatQueues.get(remoteJid);
        if (!queue || queue.length === 0) break;
        const nextItem = queue.shift();
        try {
          await executeMessageDispatch(sock, remoteJid, senderNumber, nextItem);
        } catch (itemErr) {
          console.error(`❌ Error en cola procesando mensaje para ${remoteJid}:`, itemErr.message);
        }
      }
    } finally {
      activeProcessingJids.delete(remoteJid);
      const session = getUserSession(remoteJid, senderNumber);
      const onboardingState = getOnboardingState(senderNumber);
      if (session.pendingAction || onboardingState?.step || session.pendingDisambiguation) {
        setConversationState(remoteJid, 'WAITING_FOR_INPUT');
      } else {
        setConversationState(remoteJid, 'IDLE');
      }
      await sock.sendPresenceUpdate('paused', remoteJid);
    }
  }

  function enqueueChatMessage(sock, remoteJid, senderNumber, item) {
    if (!chatQueues.has(remoteJid)) {
      chatQueues.set(remoteJid, []);
    }
    if (item.wamId) updateMessageStatus(item.wamId, 'QUEUED');
    if (item.allWamIds) {
      item.allWamIds.forEach(id => updateMessageStatus(id, 'QUEUED'));
    }
    chatQueues.get(remoteJid).push(item);
    console.log(`📥 [Cola Chat: ${senderNumber}] Mensaje encolado (posición ${chatQueues.get(remoteJid).length}). Estado mensaje: QUEUED`);
    processChatQueue(sock, remoteJid, senderNumber).catch(err => {
      console.error(`❌ Error en processChatQueue para ${remoteJid}:`, err);
    });
  }


  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Aceptar tanto 'notify' (mensajes de terceros) como 'append' (mensajes a ti mismo desde tu móvil)
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      if (msg.key?.id) {
        storeMessage(msg.key.id, msg.message);
        if (botSentMessageIds.has(msg.key.id)) {
          continue;
        }
        if (processedIncomingMsgIds.has(msg.key.id)) {
          console.log(`   ⏭️ Ignorado mensaje duplicado por ID [id: ${msg.key.id}]`);
          continue;
        }
        processedIncomingMsgIds.add(msg.key.id);
        if (processedIncomingMsgIds.size > 5000) {
          const oldest = processedIncomingMsgIds.values().next().value;
          processedIncomingMsgIds.delete(oldest);
        }
      }

      const remoteJid = msg.key?.remoteJid;
      const isFromMe = Boolean(msg.key?.fromMe);
      const myNumber = (sock.user?.id || state.creds?.me?.id || '').split(':')[0].replace(/\D/g, '');
      const myLid = (sock.user?.lid || state.creds?.me?.lid || '').split(':')[0].replace(/\D/g, '');

      // ─── INGRESS GATEKEEPER: Blindaje Estricto de Entrada ───
      const ingressCheck = shouldProcessIncomingMessage({
        remoteJid,
        fromMe: isFromMe,
        myNumber,
        myLid,
        allowedNumbers: ALLOWED_NUMBERS
      });

      if (!ingressCheck.process) {
        if (!remoteJid?.includes('@g.us') && !remoteJid?.includes('@broadcast') && !remoteJid?.includes('@newsletter')) {
          const ignoreMsg = `[${new Date().toLocaleTimeString()}] 🛡️ [Ingress Gatekeeper] Ignorado [${ingressCheck.reason}]: jid=${remoteJid}, fromMe=${isFromMe}\n`;
          try { (await import('fs')).appendFileSync('gateway.log', ignoreMsg); } catch(e) {}
          console.log(`🛡️ [Ingress Gatekeeper] Ignorado [${ingressCheck.reason}]: jid=${remoteJid}, fromMe=${isFromMe}`);
        }
        continue;
      }

      const senderNumber = ingressCheck.senderNumber;
      const logMsg = `[${new Date().toLocaleTimeString()}] 📩 Mensaje autorizado [jid: ${remoteJid}, fromMe: ${isFromMe}, sender: ${senderNumber}, myNumber: ${myNumber}, myLid: ${myLid}]\n`;
      try { (await import('fs')).appendFileSync('gateway.log', logMsg); } catch(e) {}
      console.log(`📩 Mensaje autorizado [jid: ${remoteJid}, fromMe: ${isFromMe}, sender: ${senderNumber}, myNumber: ${myNumber}, myLid: ${myLid}]`);

      // Desempaquetar contenedores de WhatsApp (efímeros, vista única, etc.)
      let messageContent = msg.message;
      while (
        messageContent?.ephemeralMessage ||
        messageContent?.viewOnceMessage ||
        messageContent?.viewOnceMessageV2 ||
        messageContent?.documentWithCaptionMessage
      ) {
        messageContent = (
          messageContent.ephemeralMessage?.message ||
          messageContent.viewOnceMessage?.message ||
          messageContent.viewOnceMessageV2?.message ||
          messageContent.documentWithCaptionMessage?.message
        );
      }

      const imageMsg = messageContent?.imageMessage;
      const isImage = Boolean(imageMsg);
      const audioMsg = messageContent?.audioMessage;
      const isAudio = Boolean(audioMsg);
      const isText = Boolean(messageContent?.conversation || messageContent?.extendedTextMessage?.text);

      if (!isAudio && !isText && !isImage) {
        const keys = Object.keys(msg.message || {}).join(', ');
        const ignoreMsg = `   ⏭️ Ignorado (no es texto, nota de voz ni imagen [claves: ${keys}])\n`;
        try { (await import('fs')).appendFileSync('gateway.log', ignoreMsg); } catch(e) {}
        console.log(`   ⏭️ Ignorado (no es texto, nota de voz ni imagen [claves: ${keys}])`);
        continue;
      }

      // Evitar que el bot reaccione a sus propios textos de presupuesto
      const rawUserText = (messageContent?.conversation || messageContent?.extendedTextMessage?.text || '').trim();
      if (
        rawUserText.includes('PRESUPUESTO') ||
        rawUserText.includes('PresuVoz AI') ||
        rawUserText.includes('Opciones disponibles') ||
        rawUserText.includes('presupuestos guardados responde') ||
        rawUserText.includes('¿Qué deseas hacer ahora?')
      ) {
        console.log(`   ⏭️ Ignorado (es un mensaje de interfaz enviado por el bot)`);
        continue;
      }

      // 1. Persistencia y tracking en SQLite (Tabla messages)
      const wamId = msg.key?.id;
      if (wamId) {
        if (isMessageAlreadyProcessed(wamId)) {
          console.log(`   ⏭️ Ignorado mensaje ya procesado en base de datos [id: ${wamId}]`);
          continue;
        }
        recordIncomingMessage({
          whatsappMessageId: wamId,
          businessId: senderNumber,
          chatId: remoteJid,
          senderPhone: senderNumber,
          content: isAudio ? '[Nota de voz]' : (isImage ? `[Imagen: ${imageMsg?.caption || ''}]` : rawUserText),
          status: 'RECEIVED'
        });
      }

      const currentItem = {
        msg,
        messageContent,
        rawUserText,
        isAudio,
        isImage,
        isText,
        imageMsg,
        audioMsg,
        wamId,
        allWamIds: wamId ? [wamId] : []
      };

      const session = getUserSession(remoteJid, senderNumber);
      const onboardingState = getOnboardingState(senderNumber);
      const isWaitingForInput = getConversationState(remoteJid) === 'WAITING_FOR_INPUT' ||
        Boolean(session.pendingAction || onboardingState?.step || session.pendingDisambiguation);
      const isUrgentSingleWord = isText && /^(?:s[ií]|no|confirmar|cancelar|descartar|1|2|3|4|5|#nuevo|resumen|agenda|estado)$/i.test(rawUserText);

      // Si es audio, imagen, o estamos esperando una respuesta concreta (WAITING_FOR_INPUT), o es comando urgente:
      if (isAudio || isImage || isWaitingForInput || isUrgentSingleWord) {
        // Si había una ráfaga previa de texto en debounce, vaciarla primero
        if (chatPendingBatches.has(remoteJid) && chatPendingBatches.get(remoteJid).length > 0) {
          if (chatDebounceTimers.has(remoteJid)) {
            clearTimeout(chatDebounceTimers.get(remoteJid));
            chatDebounceTimers.delete(remoteJid);
          }
          const pendingBatch = chatPendingBatches.get(remoteJid);
          chatPendingBatches.delete(remoteJid);
          const combinedText = pendingBatch.map(b => b.rawUserText).filter(Boolean).join('\n');
          const batchedItem = {
            ...pendingBatch[0],
            rawUserText: combinedText,
            allWamIds: pendingBatch.map(b => b.wamId).filter(Boolean)
          };
          enqueueChatMessage(sock, remoteJid, senderNumber, batchedItem);
        }

        enqueueChatMessage(sock, remoteJid, senderNumber, currentItem);
      } else {
        // Mensaje de texto conversacional ordinario: aplicar ventana de debounce de 1500ms
        // para agrupar pensamientos enviados en varias líneas seguidas
        if (!chatPendingBatches.has(remoteJid)) {
          chatPendingBatches.set(remoteJid, []);
        }
        chatPendingBatches.get(remoteJid).push(currentItem);

        if (chatDebounceTimers.has(remoteJid)) {
          clearTimeout(chatDebounceTimers.get(remoteJid));
        }

        const timer = setTimeout(() => {
          chatDebounceTimers.delete(remoteJid);
          const batch = chatPendingBatches.get(remoteJid) || [];
          chatPendingBatches.delete(remoteJid);
          if (batch.length === 0) return;

          const combinedText = batch.map(b => b.rawUserText).filter(Boolean).join('\n');
          const primaryItem = {
            ...batch[0],
            rawUserText: combinedText,
            allWamIds: batch.map(b => b.wamId).filter(Boolean)
          };
          console.log(`⏱️ [Debounce Chat: ${senderNumber}] Agrupados ${batch.length} mensajes de texto en una sola petición.`);
          enqueueChatMessage(sock, remoteJid, senderNumber, primaryItem);
        }, 1500);

        chatDebounceTimers.set(remoteJid, timer);
      }
    }
  });
}

import { fileURLToPath } from 'node:url';

const isDirectRun = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('whatsapp_gateway.js')
);

if (isDirectRun) {
  startWhatsAppGateway().catch((err) => {
    console.error('Error fatal al iniciar WhatsApp Gateway:', err);
  });
}
