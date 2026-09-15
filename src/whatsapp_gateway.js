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
import dotenv from 'dotenv';
import { PresuVozEngine } from './engine.js';
import { GEMINI_SYSTEM_PROMPT } from './ai_service.js';

dotenv.config();

const makeWASocket = makeWASocketPkg.default || makeWASocketPkg;
const engine = new PresuVozEngine();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const PRESUVOZ_BACKEND_URL = process.env.PRESUVOZ_BACKEND_URL || 'https://presuvoz.vercel.app';
const SAFE_MODE = (process.env.SAFE_MODE ?? 'true').toLowerCase() === 'true';
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map(s => s.trim().replace(/\D/g, ''))
  .filter(Boolean);

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-preview',
  'gemini-2.0-flash',
  'gemini-2.5-flash-preview-05-20'
];

async function callGemini(payload) {
  if (!GEMINI_API_KEY && typeof payload === 'string' && PRESUVOZ_BACKEND_URL) {
    const res = await fetch(`${PRESUVOZ_BACKEND_URL}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPrompt: payload,
        systemInstruction: GEMINI_SYSTEM_PROMPT
      })
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
    parts.push({
      inlineData: {
        mimeType: payload.mimeType || 'audio/ogg',
        data: payload.audioBuffer.toString('base64')
      }
    });
    parts.push({
      text: 'Analiza este audio de obra de un profesional de la construcción. Extrae todas las partidas, mediciones, precios e instrucciones, y genera el presupuesto formal en JSON cumpliendo las reglas del sistema.'
    });
  }

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048
          }
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMsg = data.error?.message || `Error HTTP ${response.status}`;
        lastError = new Error(errMsg);
        continue;
      }

      const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!jsonText) throw new Error('Respuesta vacía de Gemini');
      return JSON.parse(jsonText);
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('No se pudo conectar con ningún modelo de Gemini');
}

function formatBudgetForWhatsApp(budget, warnings = []) {
  const isDraft = budget.isDraft;
  const statusHeader = isDraft 
    ? '📋 *BORRADOR DE PRESUPUESTO TÉCNICO*' 
    : '✅ *PRESUPUESTO FORMAL DE OBRA*';

  const lines = [
    statusHeader,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `👤 *Cliente:* ${budget.client.name}`,
    `📍 *Ubicación:* ${budget.client.address}`,
    `📅 *Fecha:* ${new Date().toLocaleDateString('es-ES')}`,
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
  lines.push('🤖 _Generado automáticamente por PresuVoz AI. Reenvía este mensaje a tu cliente o escribe correcciones para actualizar precios._');

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
    browser: ['PresuVoz Bot', 'Chrome', '1.0.0']
  });

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
    }
  });

  const botSentMessageIds = new Set();

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Aceptar tanto 'notify' (mensajes de terceros) como 'append' (mensajes a ti mismo desde tu móvil)
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      // Evitar procesar mensajes que el propio bot acaba de enviar
      if (msg.key?.id && botSentMessageIds.has(msg.key.id)) {
        continue;
      }

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes('@broadcast') || remoteJid.includes('@newsletter')) {
        continue;
      }

      const senderNumber = remoteJid.replace(/\D/g, '');
      const isFromMe = msg.key.fromMe;
      const myNumber = sock.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '';

      // Comprobación de seguridad: Modo Seguro
      if (SAFE_MODE) {
        const isAllowedNumber = ALLOWED_NUMBERS.includes(senderNumber);
        const isSelfChat = remoteJid.includes(myNumber) || (isFromMe && senderNumber === myNumber);

        if (!isSelfChat && !isAllowedNumber) {
          // Ignorar mensajes de otros contactos para no molestar a amigos o familiares
          continue;
        }
      }

      const isAudio = Boolean(msg.message.audioMessage);
      const isText = Boolean(msg.message.conversation || msg.message.extendedTextMessage?.text);

      if (!isAudio && !isText) continue;

      // Evitar que el bot reaccione a sus propios textos de presupuesto
      const existingText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (existingText.includes('PRESUPUESTO') || existingText.includes('PresuVoz AI')) {
        continue;
      }

      try {
        await sock.sendPresenceUpdate('composing', remoteJid);

        let aiResult;

        if (isAudio) {
          console.log('\n🎙️ Nota de voz recibida. Descargando audio de WhatsApp...');
          const buffer = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          );

          console.log(`🎙️ Audio descargado (${buffer.length} bytes). Enviando a Gemini para escucha y análisis...`);
          aiResult = await callGemini({
            audioBuffer: buffer,
            mimeType: msg.message.audioMessage.mimetype || 'audio/ogg'
          });
        } else {
          const textContent = msg.message.conversation || msg.message.extendedTextMessage.text;
          console.log(`\n💬 Texto recibido: "${textContent}"`);
          aiResult = await callGemini(textContent);
        }

        if (!aiResult || !aiResult.items || aiResult.items.length === 0) {
          await sock.sendMessage(remoteJid, {
            text: `🤖 *PresuVoz Bot*\n\nNo he detectado partidas técnicas en el mensaje. Puedes dictarme los trabajos de obra (ej: _"tirar tabique de 4x3 metros y mover 2 enchufes por 600 euros"_).`
          });
          continue;
        }

        const engineResult = engine.process({
          rawTranscript: '',
          clientName: aiResult.clientName,
          clientAddress: aiResult.clientAddress,
          items: aiResult.items,
          taxRate: (aiResult.taxRate || 10) / 100,
          discount: aiResult.discount || null,
          customConditions: aiResult.paymentTerms
            ? `${aiResult.paymentTerms.advancePercentage}% al aceptar. ${100 - aiResult.paymentTerms.advancePercentage}% a la entrega.`
            : null
        });

        if (!engineResult.success) {
          await sock.sendMessage(remoteJid, {
            text: `⚠️ *PresuVoz*: ${engineResult.assistantFeedback || 'No se pudo calcular el presupuesto.'}`
          });
          continue;
        }

        const replyText = formatBudgetForWhatsApp(engineResult.budget, aiResult.warnings || []);
        const sent = await sock.sendMessage(remoteJid, { text: replyText });
        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
        console.log('✅ Presupuesto enviado con éxito por WhatsApp.');

      } catch (err) {
        console.error('❌ Error procesando mensaje de WhatsApp:', err.message);
        const sentErr = await sock.sendMessage(remoteJid, {
          text: `⚠️ *Error al procesar presupuesto*: ${err.message}`
        });
        if (sentErr?.key?.id) botSentMessageIds.add(sentErr.key.id);
      } finally {
        await sock.sendPresenceUpdate('paused', remoteJid);
      }
    }
  });
}

startWhatsAppGateway().catch((err) => {
  console.error('Error fatal al iniciar WhatsApp Gateway:', err);
});
