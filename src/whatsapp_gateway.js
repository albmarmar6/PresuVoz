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
import { GEMINI_SYSTEM_PROMPT, GEMINI_UPDATE_PROMPT } from './ai_service.js';
import { generateBudgetPDF } from './pdf_service.js';

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
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash'
];

let cachedWorkingModel = null;

async function callGemini(payload, systemInstruction = GEMINI_SYSTEM_PROMPT) {
  if (!GEMINI_API_KEY && typeof payload === 'string' && PRESUVOZ_BACKEND_URL) {
    const res = await fetch(`${PRESUVOZ_BACKEND_URL}/api/gemini`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPrompt: payload,
        systemInstruction: systemInstruction
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
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMsg = data.error?.message || `Error HTTP ${response.status}`;
        console.warn(`PresuVoz ⚠ Modelo "${model}" no disponible (${response.status}): ${errMsg.substring(0, 100)}`);
        lastError = new Error(errMsg);
        if (response.status === 429 || response.status === 503) {
          await new Promise(r => setTimeout(r, 1200));
        }
        continue;
      }

      const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!jsonText) throw new Error('Respuesta vacía de Gemini');
      
      cachedWorkingModel = model;
      return JSON.parse(jsonText);
    } catch (e) {
      console.warn(`PresuVoz ⚠ Error con modelo "${model}":`, e.message);
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
  lines.push('🤖 _Generado por PresuVoz AI. Envía otro audio o texto para modificar este presupuesto. Escribe *#nuevo* para empezar uno nuevo._');

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
  
  // Memoria multi-presupuesto por chat:
  // Map<remoteJid, { activeBudgetId: string|null, budgets: Map<string, object> }>
  const userSessions = new Map();

  function getUserSession(remoteJid) {
    if (!userSessions.has(remoteJid)) {
      userSessions.set(remoteJid, {
        activeBudgetId: null,
        budgets: new Map()
      });
    }
    return userSessions.get(remoteJid);
  }

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
      const myNumber = (sock.user?.id || state.creds?.me?.id || '').split(':')[0].replace(/\D/g, '');
      const myLid = (sock.user?.lid || state.creds?.me?.lid || '').split(':')[0].replace(/\D/g, '');

      const logMsg = `[${new Date().toLocaleTimeString()}] 📩 Mensaje detectado [jid: ${remoteJid}, fromMe: ${isFromMe}, sender: ${senderNumber}, myNumber: ${myNumber}, myLid: ${myLid}]\n`;
      try { (await import('fs')).appendFileSync('gateway.log', logMsg); } catch(e) {}
      console.log(`📩 Mensaje detectado [jid: ${remoteJid}, fromMe: ${isFromMe}, sender: ${senderNumber}, myNumber: ${myNumber}, myLid: ${myLid}]`);

      // Comprobación de seguridad: Modo Seguro
      if (SAFE_MODE) {
        const isAllowedNumber = ALLOWED_NUMBERS.includes(senderNumber);
        const isSelfChat = isFromMe && (
          (myNumber && remoteJid.includes(myNumber)) ||
          (myLid && remoteJid.includes(myLid))
        );

        if (!isSelfChat && !isAllowedNumber) {
          const ignoreMsg = `   ⏭️ Ignorado por Modo Seguro (${isFromMe ? 'mensaje saliente a contacto ajeno' : 'mensaje de contacto ajeno'})\n`;
          try { (await import('fs')).appendFileSync('gateway.log', ignoreMsg); } catch(e) {}
          console.log(`   ⏭️ Ignorado por Modo Seguro (${isFromMe ? 'mensaje saliente a contacto ajeno' : 'mensaje de contacto ajeno'})`);
          continue;
        }
      }

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

      const audioMsg = messageContent?.audioMessage;
      const isAudio = Boolean(audioMsg);
      const isText = Boolean(messageContent?.conversation || messageContent?.extendedTextMessage?.text);

      if (!isAudio && !isText) {
        const keys = Object.keys(msg.message || {}).join(', ');
        const ignoreMsg = `   ⏭️ Ignorado (no es texto ni nota de voz [claves: ${keys}])\n`;
        try { (await import('fs')).appendFileSync('gateway.log', ignoreMsg); } catch(e) {}
        console.log(`   ⏭️ Ignorado (no es texto ni nota de voz [claves: ${keys}])`);
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

      const session = getUserSession(remoteJid);

      // Opción 1: Ver lista de presupuestos guardados
      if (/^(1|presupuestos|mis presupuestos|ver presupuestos|lista)$/i.test(rawUserText)) {
        if (session.budgets.size === 0) {
          const sentEmpty = await sock.sendMessage(remoteJid, {
            text: '📂 *No tienes presupuestos guardados todavía.*\n\nEnvíame un audio describiendo una obra para generar el primero.'
          });
          if (sentEmpty?.key?.id) botSentMessageIds.add(sentEmpty.key.id);
          continue;
        }

        let listText = '📂 *TUS PRESUPUESTOS GUARDADOS:*\n━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        let idx = 1;
        for (const [id, b] of session.budgets.entries()) {
          const isActive = id === session.activeBudgetId ? ' 🟢 *(ACTIVO)*' : '';
          const clientName = b.client?.name || 'Cliente Particular';
          const address = b.client?.address || 'Ubicación según visita';
          const total = b.financials?.totalAmount ? `${b.financials.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €` : 'A valorar';
          const status = b.isDraft ? 'Borrador' : 'Formal';
          listText += `\n${idx}️⃣ *${id}*${isActive}\n   👤 ${clientName} (${address})\n   💰 Total: *${total}* (${status})\n`;
          idx++;
        }
        listText += '\n━━━━━━━━━━━━━━━━━━━━━━━━━\n💡 _Para modificar alguno, solo di en un audio o texto: "En el de José Luis cambia..." o "En el presupuesto PRE-... ponle..."_\n💡 _Para crear uno nuevo, envía un audio o texto diciendo: "Presupuesto nuevo..."_';

        const sentList = await sock.sendMessage(remoteJid, { text: listText });
        if (sentList?.key?.id) botSentMessageIds.add(sentList.key.id);
        continue;
      }

      // Iniciar presupuesto nuevo
      if (/^(presupuesto nuevo|nuevo presupuesto|nuevo|otro cliente|empezar de nuevo|#nuevo)$/i.test(rawUserText)) {
        session.activeBudgetId = null;
        const sentReset = await sock.sendMessage(remoteJid, {
          text: '🔄 *Listo para un nuevo presupuesto.*\n\nEnvíame un audio o mensaje con los trabajos y el cliente de la nueva obra.'
        });
        if (sentReset?.key?.id) botSentMessageIds.add(sentReset.key.id);
        console.log(`🔄 Sesión puesta en modo NUEVO presupuesto para ${remoteJid}`);
        continue;
      }

      try {
        await sock.sendPresenceUpdate('composing', remoteJid);

        let aiResult;
        const hasHistory = session.budgets.size > 0;

        if (hasHistory) {
          // Construir resumen de los presupuestos guardados para dar contexto a Gemini
          const budgetsList = Array.from(session.budgets.values()).slice(-5).map(b => ({
            id: b.id,
            clientName: b.client?.name !== 'Cliente Particular' ? b.client?.name : null,
            clientAddress: b.client?.address !== 'Ubicación obra según visita' ? b.client?.address : null,
            isDraft: b.isDraft,
            items: b.items.map(i => ({
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

          const contextPrompt = `PRESUPUESTOS GUARDADOS EN MEMORIA DEL PROFESIONAL:\n${JSON.stringify(budgetsList, null, 2)}\n\nPRESUPUESTO ACTIVO ACTUALMENTE: ${session.activeBudgetId || 'Ninguno (modo nuevo cliente)'}`;

          if (isAudio) {
            console.log('\n🎙️ Nota de voz recibida. Descargando audio de WhatsApp...');
            const buffer = await downloadMediaMessage(
              { key: msg.key, message: messageContent },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );

            console.log(`🎙️ Audio descargado (${buffer.length} bytes). Enviando a Gemini con contexto multi-presupuesto...`);
            aiResult = await callGemini({
              audioBuffer: buffer,
              mimeType: audioMsg?.mimetype || 'audio/ogg',
              promptText: `${contextPrompt}\n\nEl profesional está dictando una nota de voz. Identifica si menciona un cliente o presupuesto específico, o si continúa valorando el activo actual, y actualízalo manteniendo intactas las descripciones técnicas originales. Si describe una obra para un cliente totalmente nuevo, pon isNewBudget: true y extrae los datos para un nuevo presupuesto.`
            }, GEMINI_UPDATE_PROMPT);
          } else {
            console.log(`\n💬 Texto recibido: "${rawUserText}"`);
            aiResult = await callGemini(
              `${contextPrompt}\n\nINSTRUCCIONES DEL PROFESIONAL:\n${rawUserText}`,
              GEMINI_UPDATE_PROMPT
            );
          }
        } else {
          // No hay historial previo: modo nuevo presupuesto estándar
          if (isAudio) {
            console.log('\n🎙️ Nota de voz recibida. Descargando audio de WhatsApp...');
            const buffer = await downloadMediaMessage(
              { key: msg.key, message: messageContent },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );
            console.log(`🎙️ Audio descargado (${buffer.length} bytes). Enviando a Gemini...`);
            aiResult = await callGemini({
              audioBuffer: buffer,
              mimeType: audioMsg?.mimetype || 'audio/ogg'
            }, GEMINI_SYSTEM_PROMPT);
          } else {
            console.log(`\n💬 Texto recibido: "${rawUserText}"`);
            aiResult = await callGemini(rawUserText, GEMINI_SYSTEM_PROMPT);
          }
        }

        if (!aiResult || !aiResult.items || aiResult.items.length === 0) {
          const sentHelp = await sock.sendMessage(remoteJid, {
            text: `🤖 *PresuVoz Bot*\n\nNo he detectado partidas técnicas en el mensaje. Puedes dictarme los trabajos de obra (ej: _"tirar tabique de 4x3 metros y mover 2 enchufes por 600 euros"_).`
          });
          if (sentHelp?.key?.id) botSentMessageIds.add(sentHelp.key.id);
          continue;
        }

        // Determinar si actualiza un presupuesto existente o crea uno nuevo
        let targetId = aiResult.targetBudgetId || session.activeBudgetId;
        const isUpdate = !aiResult.isNewBudget && targetId && session.budgets.has(targetId);
        const prevBudget = isUpdate ? session.budgets.get(targetId) : null;

        // Preservar datos de cliente si es actualización y no los modificó
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
          const sentErrEngine = await sock.sendMessage(remoteJid, {
            text: `⚠️ *PresuVoz*: ${engineResult.assistantFeedback || 'No se pudo calcular el presupuesto.'}`
          });
          if (sentErrEngine?.key?.id) botSentMessageIds.add(sentErrEngine.key.id);
          continue;
        }

        // Mantener el mismo número de presupuesto si es actualización
        if (prevBudget && prevBudget.id) {
          engineResult.budget.id = prevBudget.id;
        }

        // Guardar en el historial de la sesión y marcarlo como activo
        session.budgets.set(engineResult.budget.id, engineResult.budget);
        session.activeBudgetId = engineResult.budget.id;
        console.log(`💾 Presupuesto guardado en sesión: ${engineResult.budget.id} (Total guardados: ${session.budgets.size})`);

        // Enviar resumen por WhatsApp
        const replyText = formatBudgetForWhatsApp(engineResult.budget, aiResult.warnings || []);
        const sent = await sock.sendMessage(remoteJid, { text: replyText });
        if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
        console.log('✅ Resumen de texto enviado por WhatsApp.');

        // Generar y enviar documento PDF oficial adjunto
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

          // Generar enlace de firma digital táctil
          try {
            const budgetJson   = JSON.stringify(engineResult.budget);
            const budgetBase64 = Buffer.from(budgetJson).toString('base64')
              .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const signingUrl = `https://albmarmar6.github.io/PresuVoz/studio/firmar.html?data=${budgetBase64}`;
            const sentSig = await sock.sendMessage(remoteJid, {
              text: `✍️ *Firma del presupuesto*\n\nCuando el cliente esté presente, abre este enlace para firmar digitalmente y que reciba el contrato por email:\n${signingUrl}`
            });
            if (sentSig?.key?.id) botSentMessageIds.add(sentSig.key.id);
            console.log('✅ Enlace de firma enviado por WhatsApp.');
          } catch (sigErr) {
            console.warn('⚠️ No se pudo generar el enlace de firma:', sigErr.message);
          }

        } catch (pdfErr) {
          console.error('⚠️ No se pudo generar o enviar el PDF:', pdfErr.message);
        }

        // Enviar mensaje interactivo de opciones
        const optionsText = [
          '👉 *Opciones disponibles:*',
          '• Si quieres ver todos tus presupuestos guardados responde *1*.',
          '• Si quieres modificar alguno di el número del presupuesto o el nombre del cliente.',
          '• Si quieres uno nuevo manda un audio o texto comentando *presupuesto nuevo*.'
        ].join('\n');

        const sentOptions = await sock.sendMessage(remoteJid, { text: optionsText });
        if (sentOptions?.key?.id) botSentMessageIds.add(sentOptions.key.id);

      } catch (err) {
        console.error('❌ Error procesando mensaje de WhatsApp:', err.message);
        const sentErr = await sock.sendMessage(remoteJid, {
          text: `⚠️ *No se ha podido procesar el presupuesto*\n\nHa habido una saturación momentánea en el servicio de IA. Por favor, reenvía tu audio o mensaje en unos segundos.`
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
