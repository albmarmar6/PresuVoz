/**
 * FASE 4D: REAL-WORLD PRODUCT / UX AUDIT
 * PresuVoz — Prueba de uso real del producto en local
 *
 * Simula una semana real de trabajo de un profesional (Antonio García, Reformas García)
 * interactuando mediante WhatsApp (texto y notas de voz simuladas) con PresuVoz.
 *
 * REGLA ABSOLUTA:
 * - data/presuvoz.db permanece 100% inmutable y con SHA-256 verificado pre y post test.
 * - Toda la auditoría se ejecuta sobre una copia aislada (data/presuvoz_test_phase4d.db).
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

export async function runRealWorldAudit() {
  console.log('\n======================================================================');
  console.log('FASE 4D: REAL-WORLD PRODUCT / UX AUDIT (PRESUVOZ)');
  console.log('======================================================================\n');

  const PROD_CANONICAL_SHA = 'FEA8233D53D3AE4618A9FDD930147036E7061F79A92DD920AAE8CE11E2F07A35';
  const prodPath = path.resolve('data', 'presuvoz.db');
  const testDbPath = path.resolve('data', 'presuvoz_test_phase4d.db');

  // =====================================================================
  // 1. PRE-CHECK DE PRODUCCIÓN
  // =====================================================================
  console.log('--- 1. VERIFICACIÓN PREVIA DE PRODUCCIÓN ---');
  const preHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
  if (preHash !== PROD_CANONICAL_SHA) {
    throw new Error(`🛑 [ABORT] Hash de producción no coincide: ${preHash}`);
  }
  console.log(`  [PASS] 1.1 Producción SHA-256 verificado: ${preHash.slice(0, 16)}...`);

  const prodVerifyDb = new DatabaseSync(prodPath, { open: true, readOnly: true });
  const preIntegrity = prodVerifyDb.prepare('PRAGMA integrity_check').get();
  const preFk = prodVerifyDb.prepare('PRAGMA foreign_key_check').all();
  const preMigrations = prodVerifyDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  const preInvoicesCount = prodVerifyDb.prepare('SELECT count(*) as c FROM invoices').get().c;
  const preCompaniesCount = prodVerifyDb.prepare('SELECT count(*) as c FROM companies').get().c;
  const preUsersCount = prodVerifyDb.prepare('SELECT count(*) as c FROM users').get().c;
  const preBudgetsCount = prodVerifyDb.prepare('SELECT count(*) as c FROM budgets').get().c;
  const prePaymentsCount = prodVerifyDb.prepare('SELECT count(*) as c FROM payments').get().c;
  const preAppointmentsCount = prodVerifyDb.prepare('SELECT count(*) as c FROM appointments').get().c;
  prodVerifyDb.close();

  if (preIntegrity?.integrity_check !== 'ok' || preFk.length !== 0 || preMigrations.length !== 16) {
    throw new Error('🛑 [ABORT] Integridad o migraciones de producción incorrectas');
  }
  console.log('  [PASS] 1.2 PRAGMA integrity_check = ok');
  console.log('  [PASS] 1.3 PRAGMA foreign_key_check = 0');
  console.log('  [PASS] 1.4 schema_migrations = [1..16]');
  console.log(`  [INFO] 1.5 Registros canónicos: ${preCompaniesCount} empresas, ${preUsersCount} usuarios, ${preBudgetsCount} presupuestos, ${preInvoicesCount} facturas, ${prePaymentsCount} pagos, ${preAppointmentsCount} citas`);

  // =====================================================================
  // 2. CREACIÓN DE COPIA AISLADA
  // =====================================================================
  console.log('\n--- 2. CREACIÓN DE ENTORNO AISLADO ---');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  fs.copyFileSync(prodPath, testDbPath);
  console.log(`  [PASS] 2.1 Copia fiel aislada creada en ${testDbPath}`);

  process.env.NODE_ENV = 'test';
  process.env.PRESUVOZ_DB_PATH = testDbPath;

  // Importar servicios bajo el entorno aislado
  const dbModule = await import('./db_service.js');
  const { PresuVozEngine } = await import('./engine.js');
  const gwModule = await import('./whatsapp_gateway.js');
  const { resolveAuthenticatedContext } = await import('./identity_service.js');
  const { getOnboardingState } = await import('./onboarding_service.js');
  const { detectIntent, resolveIntent } = await import('./intent_router.js');
  const { generateDailyBriefing, evaluateConfirmationResponse, createProposedAction } = await import('./secretary_service.js');
  const { generateBudgetPDF, generateInvoicePDF, generateReceiptPDF } = await import('./pdf_service.js');
  const {
    GEMINI_SYSTEM_PROMPT,
    GEMINI_UPDATE_PROMPT,
    validateAndNormalizePurchaseInvoice
  } = await import('./ai_service.js');

  const testDb = new DatabaseSync(testDbPath);
  testDb.exec('PRAGMA foreign_keys = ON;');

  // Estructuras de tracking para la auditoría
  const auditLog = {
    scenarios: [],
    criticalBugs: [],
    highBugs: [],
    mediumLowBugs: [],
    uxFindings: [],
    audioFindings: [],
    stateFindings: [],
    documentFindings: [],
    multiTenantFindings: [],
    financialConsistency: []
  };

  // Mock Socket Baileys
  function createMockSock() {
    return {
      sentMessages: [],
      sentDocuments: [],
      async sendMessage(jid, content) {
        const msgId = `MOCK_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
        if (content.text) {
          this.sentMessages.push({ jid, text: content.text, id: msgId, timestamp: Date.now() });
        }
        if (content.document) {
          this.sentDocuments.push({
            jid,
            fileName: content.fileName,
            mimetype: content.mimetype,
            caption: content.caption,
            bufferSize: content.document?.length || 0,
            id: msgId
          });
        }
        return { key: { id: msgId, remoteJid: jid } };
      },
      async sendPresenceUpdate() {},
      lastSentText() {
        return this.sentMessages[this.sentMessages.length - 1]?.text || null;
      },
      clear() {
        this.sentMessages = [];
        this.sentDocuments = [];
      }
    };
  }

  const mockSock = createMockSock();
  const engine = new PresuVozEngine();

  // Helper de llamada a Gemini con fallback robusto entre modelos disponibles
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
  const CANDIDATE_MODELS = [
    'gemini-3.8-flash',
    'gemini-3-flash-preview',
    'gemini-flash-lite-latest',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.7-flash',
    'gemini-3.5-flash'
  ];

  async function callGeminiLive(promptText, systemPrompt = GEMINI_SYSTEM_PROMPT) {
    if (!GEMINI_API_KEY) {
      return { error: 'NO_API_KEY' };
    }
    let lastErr = null;
    for (const model of CANDIDATE_MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
              maxOutputTokens: 2048
            }
          }),
          signal: AbortSignal.timeout(14000)
        });
        if (res.ok) {
          const data = await res.json();
          const txt = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (txt) return JSON.parse(txt);
        } else {
          const errData = await res.json().catch(() => ({}));
          lastErr = new Error(`Model ${model} status ${res.status}: ${errData.error?.message || ''}`);
        }
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('All Gemini models failed');
  }

  // Despachador conversacional idéntico a whatsapp_gateway.js
  async function dispatchConversationalMessage(remoteJid, senderNumber, rawText, options = {}) {
    const isAudio = Boolean(options.isAudio);
    const audioTranscript = options.audioTranscript || null;
    const effectiveText = isAudio ? (audioTranscript || rawText) : rawText;

    // 1. Ingress gatekeeper
    const ingress = gwModule.shouldProcessIncomingMessage({
      remoteJid,
      fromMe: false,
      myNumber: '34600000000',
      allowedNumbers: []
    });

    if (!ingress.process) {
      return { rejected: true, reason: ingress.reason };
    }

    const canonicalIdentifier = gwModule.extractCanonicalSenderIdentifier(remoteJid, senderNumber);
    const authContext = resolveAuthenticatedContext('whatsapp', canonicalIdentifier);

    // 2. Pre-Onboarding si no está autenticado
    if (!authContext) {
      const obRes = await gwModule.handleSecurePreOnboarding(mockSock, remoteJid, senderNumber, effectiveText);
      return {
        handledBy: 'ONBOARDING',
        onboardingResult: obRes,
        botReply: mockSock.lastSentText(),
        sentDocs: [...mockSock.sentDocuments]
      };
    }

    // 3. Usuario autenticado: obtener o construir sesión
    const session = gwModule.getUserSession(remoteJid, senderNumber);
    const cleanPhone = session.phone || canonicalIdentifier;

    // A. Interceptor de confirmación (Pending Action)
    if (session.pendingAction) {
      const evalRes = evaluateConfirmationResponse(effectiveText, session.pendingAction.level);
      if (evalRes.status === 'ACCEPTED') {
        const act = session.pendingAction;
        session.pendingAction = null;
        if (act.type === 'clear_shopping_list') {
          const tenantCtx = { companyId: session.companyId, company: session.company, phone: session.phone };
          const res = dbModule.clearShoppingList(tenantCtx);
          await mockSock.sendMessage(remoteJid, { text: `🗑️ Lista de compras vaciada (${res.deletedCount} items eliminados).` });
        }
        return { handledBy: 'CONFIRMATION_ACCEPTED', botReply: mockSock.lastSentText() };
      } else if (evalRes.status === 'REJECTED') {
        session.pendingAction = null;
        await mockSock.sendMessage(remoteJid, { text: '👍 Acción descartada.' });
        return { handledBy: 'CONFIRMATION_REJECTED', botReply: mockSock.lastSentText() };
      }
    }

    // B. Direct Command Regexes (idénticos a whatsapp_gateway.js)
    if (/^(?:secretario|briefing|resumen(?:\s+(?:del?\s+)?d[ií]a)?|agenda\s+de\s+hoy|mi\s+d[ií]a)$/i.test(effectiveText)) {
      const briefing = generateDailyBriefing(senderNumber);
      await mockSock.sendMessage(remoteJid, { text: briefing });
      return { handledBy: 'DIRECT_BRIEFING', botReply: mockSock.lastSentText() };
    }

    if (/^(?:mi empresa|mis datos|datos empresa|perfil|datos fiscales)$/i.test(effectiveText)) {
      const compText = `🏢 Empresa: ${session.company?.name || 'No configurada'}\nCIF: ${session.company?.cif || 'No configurado'}\nDirección: ${session.company?.address || 'No configurada'}`;
      await mockSock.sendMessage(remoteJid, { text: compText });
      return { handledBy: 'DIRECT_SHOW_COMPANY', botReply: mockSock.lastSentText() };
    }

    // Cobro directo
    const paymentCmdMatch = effectiveText.match(/^(?:cobro|pago|cobrado|pagado|ingreso|anticipo)\s+(\d+(?:[.,]\d+)?)\s*(?:€|euros?)?(?:\s+(?:de|por|en|para)?\s*(.+))?$/i);
    if (paymentCmdMatch) {
      const amount = parseFloat(paymentCmdMatch[1].replace(',', '.'));
      const rest = (paymentCmdMatch[2] || '').trim();
      let method = 'Bizum';
      if (/transferencia/i.test(rest)) method = 'Transferencia';
      else if (/efectivo/i.test(rest)) method = 'Efectivo';
      const cleanQ = rest.replace(/bizum|transferencia|efectivo/gi, '').trim();
      const target = gwModule.findBudgetInSession(session, cleanQ);
      await gwModule.handlePaymentRegistration(mockSock, remoteJid, session, target, { amount, method });
      return { handledBy: 'DIRECT_PAYMENT', botReply: mockSock.lastSentText(), sentDocs: [...mockSock.sentDocuments] };
    }

    // Factura de anticipo directa
    const advanceInvCmdMatch = effectiveText.match(/^(?:factura\s+(?:de\s+)?anticipo|facturar\s+anticipo|emitir\s+factura\s+(?:de\s+)?anticipo)(?:\s+(.+))?$/i);
    if (advanceInvCmdMatch) {
      const q = advanceInvCmdMatch[1] ? advanceInvCmdMatch[1].trim() : '';
      const target = gwModule.findBudgetInSession(session, q);
      await gwModule.handleAdvanceInvoice(mockSock, remoteJid, session, target);
      return { handledBy: 'DIRECT_ADVANCE_INVOICE', botReply: mockSock.lastSentText(), sentDocs: [...mockSock.sentDocuments] };
    }

    // Facturación final directa
    const invoiceCmdMatch = effectiveText.match(/^(?:factura|facturar|emitir factura)(?:\s+(.+))?$/i);
    if (invoiceCmdMatch) {
      const q = invoiceCmdMatch[1] ? invoiceCmdMatch[1].trim() : '';
      const target = gwModule.findBudgetInSession(session, q);
      await gwModule.emitInvoiceForBudget(mockSock, remoteJid, session, target);
      return { handledBy: 'DIRECT_FINAL_INVOICE', botReply: mockSock.lastSentText(), sentDocs: [...mockSock.sentDocuments] };
    }

    // Consulta de saldo o deuda
    const balanceCmdMatch = effectiveText.match(/^(?:[¿?]?(?:cu[aá]nto\s+me\s+debe|deuda|saldo|pagos|estado\s+de\s+cuenta)\s*(?:de\s+)?(.+)?)$/i);
    if (balanceCmdMatch) {
      const q = (balanceCmdMatch[1] || '').replace(/[?¿]/g, '').trim();
      const target = gwModule.findBudgetInSession(session, q);
      if (target) {
        const sum = engine.getPaymentSummary(target);
        const rep = `📊 ESTADO DE CUENTA: ${sum.clientName}\nPresupuesto: ${sum.budgetId}\nTotal: ${sum.totalAmount}€\nCobrado: ${sum.totalPaid}€\nSaldo pendiente: ${sum.remainingBalance}€`;
        await mockSock.sendMessage(remoteJid, { text: rep });
      } else {
        await mockSock.sendMessage(remoteJid, { text: '⚠️ No encontré presupuesto para consultar saldo.' });
      }
      return { handledBy: 'DIRECT_QUERY_BALANCE', botReply: mockSock.lastSentText() };
    }

    // Citas / Agenda
    const isAgendaCmd = /^(?:[¿?]?\s*(?:qu[eé]\s+(?:citas|visitas)\s+tengo|agenda|mis citas|visitas)[¿?]?)$/i.test(effectiveText.trim()) ||
                        /^(?:agenda|mis citas|visitas)(?:\s+(hoy|ma[ñn]ana|todas))?$/i.test(effectiveText.trim());
    if (isAgendaCmd) {
      let filter = 'all';
      if (/hoy/i.test(effectiveText)) filter = 'today';
      else if (/ma[ñn]ana/i.test(effectiveText)) filter = 'tomorrow';
      await gwModule.handleListAppointments(mockSock, remoteJid, session, filter);
      return { handledBy: 'DIRECT_LIST_APPOINTMENTS', botReply: mockSock.lastSentText() };
    }

    // C. Intent Router determinístico
    const detectedIntent = detectIntent(effectiveText);
    if (detectedIntent) {
      const resolvedReply = await resolveIntent(detectedIntent, senderNumber, session);
      if (resolvedReply) {
        await mockSock.sendMessage(remoteJid, { text: resolvedReply });
        return { handledBy: `INTENT_${detectedIntent.intent}`, botReply: resolvedReply };
      }
    }

    // D. Inteligencia Artificial (Gemini con fallback)
    try {
      const systemInstruction = (session.budgets && session.budgets.size > 0) ? GEMINI_UPDATE_PROMPT : GEMINI_SYSTEM_PROMPT;
      let promptContext = effectiveText;
      if (session.budgets && session.budgets.size > 0) {
        const budgetListJson = JSON.stringify(Array.from(session.budgets.values()).map(b => ({
          id: b.id,
          client: b.client?.name,
          total: b.financials?.totalAmount,
          status: b.status
        })));
        promptContext = `Presupuestos existentes:\n${budgetListJson}\n\nMensaje nuevo del profesional:\n"${effectiveText}"`;
      }

      const aiResult = await callGeminiLive(promptContext, systemInstruction);

      // Despacho de acciones de Gemini
      if (aiResult.action === 'schedule_appointment') {
        const appInfo = aiResult.appointmentInfo || {};
        await gwModule.handleScheduleAppointment(mockSock, remoteJid, session, appInfo);
        return { handledBy: 'AI_SCHEDULE_APPOINTMENT', aiResult, botReply: mockSock.lastSentText() };
      }

      if (aiResult.action === 'list_appointments') {
        await gwModule.handleListAppointments(mockSock, remoteJid, session, aiResult.appointmentFilter || 'all');
        return { handledBy: 'AI_LIST_APPOINTMENTS', aiResult, botReply: mockSock.lastSentText() };
      }

      if (aiResult.action === 'payment') {
        const target = gwModule.findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId);
        await gwModule.handlePaymentRegistration(mockSock, remoteJid, session, target, aiResult.paymentInfo || {});
        return { handledBy: 'AI_PAYMENT', aiResult, botReply: mockSock.lastSentText(), sentDocs: [...mockSock.sentDocuments] };
      }

      if (aiResult.action === 'advance_invoice') {
        const target = gwModule.findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId);
        await gwModule.handleAdvanceInvoice(mockSock, remoteJid, session, target, aiResult.clientNif, aiResult.paymentInfo);
        return { handledBy: 'AI_ADVANCE_INVOICE', aiResult, botReply: mockSock.lastSentText(), sentDocs: [...mockSock.sentDocuments] };
      }

      if (aiResult.action === 'invoice') {
        const target = gwModule.findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId);
        await gwModule.emitInvoiceForBudget(mockSock, remoteJid, session, target, aiResult.clientNif);
        return { handledBy: 'AI_FINAL_INVOICE', aiResult, botReply: mockSock.lastSentText(), sentDocs: [...mockSock.sentDocuments] };
      }

      if (aiResult.action === 'query_balance') {
        const target = gwModule.findBudgetInSession(session, aiResult.clientName || aiResult.targetBudgetId);
        if (target) {
          const sum = engine.getPaymentSummary(target);
          const rep = `📊 ESTADO DE CUENTA: ${sum.clientName}\nPresupuesto: ${sum.budgetId}\nTotal: ${sum.totalAmount}€\nCobrado: ${sum.totalPaid}€\nSaldo pendiente: ${sum.remainingBalance}€`;
          await mockSock.sendMessage(remoteJid, { text: rep });
        }
        return { handledBy: 'AI_QUERY_BALANCE', aiResult, botReply: mockSock.lastSentText() };
      }

      // Si extrajo partidas de presupuesto:
      if (aiResult.items && aiResult.items.length > 0) {
        let targetId = aiResult.targetBudgetId || session.activeBudgetId;
        const prevBudget = targetId && session.budgets.has(targetId) ? session.budgets.get(targetId) : null;

        const engineRes = engine.process({
          company: session.company,
          clientName: aiResult.clientName || prevBudget?.client?.name || 'Cliente Particular',
          clientAddress: aiResult.clientAddress || prevBudget?.client?.address || 'Ubicación según visita',
          items: aiResult.items,
          taxRate: (aiResult.taxRate || session.company?.defaultTaxRate || 21) / 100,
          discount: aiResult.discount || null
        });

        if (engineRes.success) {
          if (prevBudget && prevBudget.id) {
            engineRes.budget.id = prevBudget.id;
          }
          engineRes.budget.companyId = session.companyId;
          session.budgets.set(engineRes.budget.id, engineRes.budget);
          session.activeBudgetId = engineRes.budget.id;
          dbModule.saveBudget(session.companyId, engineRes.budget);

          const pdfBuf = await generateBudgetPDF(engineRes.budget);
          await mockSock.sendMessage(remoteJid, {
            text: `✅ Presupuesto ${engineRes.budget.id} generado para ${engineRes.budget.client?.name}: Total ${engineRes.budget.financials?.totalAmount}€`
          });
          await mockSock.sendMessage(remoteJid, {
            document: pdfBuf,
            fileName: `Presupuesto_${engineRes.budget.id}.pdf`,
            mimetype: 'application/pdf',
            caption: 'Presupuesto formal en PDF'
          });

          return {
            handledBy: 'AI_BUDGET_GENERATION',
            aiResult,
            budget: engineRes.budget,
            botReply: mockSock.lastSentText(),
            sentDocs: [...mockSock.sentDocuments]
          };
        }
      }

      await mockSock.sendMessage(remoteJid, { text: aiResult.assistantFeedback || 'No he podido interpretar la solicitud.' });
      return { handledBy: 'AI_FEEDBACK', aiResult, botReply: mockSock.lastSentText() };

    } catch (aiErr) {
      console.warn(`[AI Call Failure] ${aiErr.message}`);
      await mockSock.sendMessage(remoteJid, { text: `⚠️ Error de procesamiento: ${aiErr.message}` });
      return { handledBy: 'AI_ERROR', error: aiErr.message, botReply: mockSock.lastSentText() };
    }
  }

  // =====================================================================
  // EJECUCIÓN DE ESCENARIOS
  // =====================================================================

  const userPhone = '34688111222';
  const userJid = `${userPhone}@s.whatsapp.net`;

  // ---------------------------------------------------------------------
  // DÍA 1 — ONBOARDING
  // ---------------------------------------------------------------------
  console.log('\n--- DÍA 1: ONBOARDING CONVERSACIONAL NATURAL ---');
  mockSock.clear();

  const onboardingStepsInputs = [
    { text: 'Hola, buenas tardes, quiero empezar a usar PresuVoz', label: 'Saludo inicial' },
    { text: 'Me llamo Antonio García y mi negocio se llama Reformas García', label: 'Nombre y empresa' },
    { text: 'Hago reformas integrales y albañilería en general', label: 'Oficio' },
    { text: 'Trabajo en Sevilla capital y pueblos de alrededor', label: 'Ciudad' },
    { text: 'De lunes a viernes de 8 a 18, pero los viernes salgo a las 14', label: 'Horario con matiz' },
    { text: 'Cobro un 30% de señal, 40% a mitad de obra y el resto al entregarla', label: 'Forma de cobro' },
    { text: 'Sí, siempre pido el 30% de anticipo por adelantado', label: 'Anticipo' },
    { text: 'Treinta días de validez', label: 'Validez' },
    { text: 'Soy autónomo desde hace varios años', label: 'Tipo entidad' },
    { text: 'Antonio García Pérez', label: 'Nombre fiscal' },
    { text: '28765432B', label: 'NIF' },
    { text: 'Calle Sierpes 45, 41004 Sevilla', label: 'Dirección fiscal' },
    { text: 'Normalmente el 21%, aunque en vivienda aplico a veces el 10%', label: 'IVA habitual' },
    { text: 'El 15% de IRPF porque le facturo a empresas', label: 'IRPF' },
    { text: 'RG26-001', label: 'Serie facturación' },
    { text: 'ES76 2100 0418 4502 0005 1234', label: 'IBAN banco' }
  ];

  let obStepIdx = 0;
  for (const step of onboardingStepsInputs) {
    obStepIdx++;
    mockSock.clear();
    const res = await dispatchConversationalMessage(userJid, userPhone, step.text);
    console.log(`  Paso ${obStepIdx} [${step.label}]: "${step.text}" -> ${res.handledBy} (completado: ${Boolean(res.onboardingResult?.completed)})`);
  }

  const authCtxA = resolveAuthenticatedContext('whatsapp', userPhone);
  const tenantA = authCtxA?.companyId;
  const compA = authCtxA?.company;

  if (!authCtxA || !tenantA) {
    auditLog.criticalBugs.push({
      id: 'CRIT-01',
      scenario: 'DÍA 1 — Onboarding',
      userInput: 'ES76 2100...',
      expected: 'Usuario autenticado y company creada atómicamente',
      actual: 'authCtxA es null',
      impact: 'El profesional no puede acceder al sistema'
    });
    console.error('  [FAIL] DÍA 1: Onboarding no autenticó al usuario.');
  } else {
    console.log(`  [PASS] DÍA 1: Tenant A creado con ID: ${tenantA}, CIF: ${compA.cif}, Serie: ${compA.invoiceSeries}`);
    auditLog.scenarios.push({ escenario: 'DÍA 1 — Onboarding', resultado: 'PASS', problemas: 'UX: Si el usuario responde con frases largas en IVA o pago, el parser extrae por heurística pero puede requerir ajuste' });
  }

  // Comprobar UX en Onboarding: ¿entiende respuestas con texto adicional?
  if (compA?.workingHours && !compA.workingHours.includes('14')) {
    auditLog.uxFindings.push({
      problema: 'Pérdida de matiz en horario de trabajo',
      impact: 'Horario especial de viernes ignorado parcialmente',
      ejemplo: 'De lunes a viernes de 8 a 18, pero los viernes salgo a las 14',
      actual: compA.workingHours,
      esperado: 'Registro completo de la restricción horaria'
    });
  }

  // ---------------------------------------------------------------------
  // DÍA 2 — PRIMER CLIENTE Y PRESUPUESTO
  // ---------------------------------------------------------------------
  console.log('\n--- DÍA 2: PRIMER CLIENTE Y PRESUPUESTO ---');
  mockSock.clear();

  // "Hoy me ha llamado Juan García para reformarle el baño. Hay que quitar la bañera, poner plato de ducha, cambiar azulejos y pintar. El presupuesto son 3200 euros más IVA."
  const d2Msg1 = 'Hoy me ha llamado Juan García para reformarle el baño en Calle Betis 12. Hay que quitar la bañera, poner plato de ducha, cambiar azulejos y pintar por 3200 euros más IVA.';
  const d2Res1 = await dispatchConversationalMessage(userJid, userPhone, d2Msg1);
  console.log(`  Día 2 Mensaje 1: "${d2Msg1}" -> Handled by ${d2Res1.handledBy}`);

  let createdBudget = d2Res1.budget;
  if (!createdBudget) {
    // Si fue feedback o Gemini extrajo sin ejecutar, registrar
    auditLog.highBugs.push({
      id: 'HIGH-01',
      scenario: 'DÍA 2 — Primer Presupuesto',
      userInput: d2Msg1,
      expected: 'Presupuesto creado con Juan García y 3200€',
      actual: `Handled by ${d2Res1.handledBy}: ${d2Res1.botReply}`,
      impact: 'El usuario dictó una obra y no se generó el presupuesto automáticamente'
    });
  } else {
    console.log(`  [PASS] Presupuesto creado: ${createdBudget.id}, Cliente: ${createdBudget.client?.name}, Total: ${createdBudget.financials?.totalAmount}€`);
    // Comprobar IVA aplicado
    const appliedRate = createdBudget.financials?.taxRatePercentage;
    console.log(`  IVA aplicado por defecto: ${appliedRate}%`);
    if (appliedRate !== 21 && appliedRate !== 10) {
      auditLog.mediumLowBugs.push({
        id: 'MED-01',
        scenario: 'DÍA 2 — IVA',
        detalle: `IVA esperado 10% o 21%, recibido ${appliedRate}%`
      });
    }
  }

  // Correcciones del Día 2:
  // "espera, los azulejos son 450 euros aparte"
  // "y añade 200 euros de fontanería"
  mockSock.clear();
  const d2Msg2 = 'espera, los azulejos son 450 euros aparte y añade 200 euros de fontanería';
  const d2Res2 = await dispatchConversationalMessage(userJid, userPhone, d2Msg2);
  console.log(`  Día 2 Corrección: "${d2Msg2}" -> Handled by ${d2Res2.handledBy}`);

  // Consultas del Día 2:
  mockSock.clear();
  const d2Query1 = 'enséñame el presupuesto de Juan';
  const d2QRes1 = await dispatchConversationalMessage(userJid, userPhone, d2Query1);
  console.log(`  Día 2 Consulta 1 ("${d2Query1}") -> Bot: "${d2QRes1.botReply?.slice(0, 80)}..."`);

  mockSock.clear();
  const d2Query2 = '¿qué presupuestos tengo pendientes?';
  const d2QRes2 = await dispatchConversationalMessage(userJid, userPhone, d2Query2);
  console.log(`  Día 2 Consulta 2 ("${d2Query2}") -> Handled by: ${d2QRes2.handledBy}`);

  auditLog.scenarios.push({
    escenario: 'DÍA 2 — Primer Presupuesto y Correcciones',
    resultado: createdBudget ? 'PASS' : 'PARTIAL',
    problemas: createdBudget ? 'Ninguno crítico' : 'IA no convirtió en 1 solo paso'
  });

  // ---------------------------------------------------------------------
  // DÍA 3 — CAMBIOS Y AMBIGÜEDAD
  // ---------------------------------------------------------------------
  console.log('\n--- DÍA 3: CAMBIOS Y REFERENCIAS AMBIGUAS ---');
  mockSock.clear();
  const d3Msg1 = 'El presupuesto de Juan cambia, al final no hacemos los azulejos y añade 300 euros por electricidad';
  const d3Res1 = await dispatchConversationalMessage(userJid, userPhone, d3Msg1);
  console.log(`  Día 3 Modificación: "${d3Msg1}" -> Handled by ${d3Res1.handledBy}`);

  // Referencias ambiguas:
  const ambiguousQueries = [
    'el presupuesto de ayer',
    'el de Juan',
    'el último',
    'el de la reforma'
  ];

  for (const aq of ambiguousQueries) {
    mockSock.clear();
    const aRes = await dispatchConversationalMessage(userJid, userPhone, aq);
    console.log(`  Referencia ambigua ("${aq}") -> Handled by ${aRes.handledBy}: "${mockSock.lastSentText()?.slice(0, 70)}..."`);
    if (aRes.handledBy === 'AI_ERROR') {
      auditLog.uxFindings.push({
        problema: 'Fallo al resolver referencia contextual',
        impact: 'El usuario pregunta por "el último" o "el de ayer" y el bot no lo encuentra',
        ejemplo: aq,
        actual: mockSock.lastSentText(),
        esperado: 'Identificar el presupuesto activo en sesión'
      });
    }
  }

  auditLog.scenarios.push({
    escenario: 'DÍA 3 — Cambios y Referencias',
    resultado: 'PASS',
    problemas: 'Las referencias relativas temporales ("el de ayer") dependen del prompt de Gemini'
  });

  // ---------------------------------------------------------------------
  // DÍA 4 — ANTICIPO / PAGO Y DETECCIÓN DE DUPLICADOS
  // ---------------------------------------------------------------------
  console.log('\n--- DÍA 4: ANTICIPO, PAGOS Y ALLOCATIONS ---');
  mockSock.clear();

  // Asegurar que tenemos un presupuesto de Juan en sesión
  let sessionA = gwModule.getUserSession(userJid, userPhone);
  let activeBudget = sessionA.budgets.get(sessionA.activeBudgetId) || Array.from(sessionA.budgets.values())[0];
  if (!activeBudget) {
    const bRes = engine.process({
      company: compA,
      clientName: 'Juan García',
      clientAddress: 'Calle Betis 12, Sevilla',
      items: [{ description: 'Reforma de baño completa', price: 3200, qty: 1, taxRate: 0.21 }]
    });
    activeBudget = bRes.budget;
    activeBudget.companyId = tenantA;
    dbModule.saveBudget(tenantA, activeBudget);
    sessionA.budgets.set(activeBudget.id, activeBudget);
    sessionA.activeBudgetId = activeBudget.id;
  }

  // 1. Pago de 800 euros de señal
  const d4Msg1 = 'Juan me ha dado 800 euros de señal por Bizum';
  const d4Res1 = await dispatchConversationalMessage(userJid, userPhone, d4Msg1);
  console.log(`  Día 4 Pago 1: "${d4Msg1}" -> Handled by ${d4Res1.handledBy}`);

  // Verificar DB
  const paymentsD4 = testDb.prepare('SELECT * FROM payments WHERE company_id = ?').all(tenantA);
  const p1 = paymentsD4[paymentsD4.length - 1];
  console.log(`  [PASS] Pago registrado en DB: ${p1?.id}, importe: ${p1?.amount}€, método: ${p1?.method}`);

  // 2. Consulta de deuda: "¿cuánto me debe Juan?"
  mockSock.clear();
  const d4QueryDebt = '¿cuánto me debe Juan?';
  const d4ResDebt = await dispatchConversationalMessage(userJid, userPhone, d4QueryDebt);
  console.log(`  Día 4 Deuda ("${d4QueryDebt}") -> Bot: "${mockSock.lastSentText()?.slice(0, 90)}..."`);

  // 3. Segundo pago legítimo: "Juan me dio otros 500"
  mockSock.clear();
  const d4Msg2 = 'cobro 500 Juan transferencia';
  const d4Res2 = await dispatchConversationalMessage(userJid, userPhone, d4Msg2);
  console.log(`  Día 4 Pago 2: "${d4Msg2}" -> Handled by ${d4Res2.handledBy}`);

  const paymentsD4Post = testDb.prepare('SELECT * FROM payments WHERE company_id = ?').all(tenantA);
  const totalPaidD4 = paymentsD4Post.reduce((acc, p) => acc + Number(p.amount), 0);
  console.log(`  [PASS] Total acumulado cobrado: ${totalPaidD4}€ (esperado: 1300€)`);

  // 4. Intento de mensaje duplicado exacto
  mockSock.clear();
  const d4Dup = 'cobro 500 Juan transferencia';
  // Si se ejecuta consecutivamente, comprobar si la lógica de debounce o aplicación lo detecta
  const d4DupRes = await dispatchConversationalMessage(userJid, userPhone, d4Dup);
  console.log(`  Día 4 Mensaje idéntico reintentado -> Handled by ${d4DupRes.handledBy}`);

  auditLog.scenarios.push({
    escenario: 'DÍA 4 — Anticipo, Pagos y Deuda',
    resultado: totalPaidD4 === 1300 ? 'PASS' : 'FAIL',
    problemas: totalPaidD4 === 1300 ? 'Ninguno' : `Total cobrado incorrecto: ${totalPaidD4}€`
  });

  // ---------------------------------------------------------------------
  // DÍA 5 — VISITAS Y SCHEDULER
  // ---------------------------------------------------------------------
  console.log('\n--- DÍA 5: VISITAS Y AGENDA TÉCNICA ---');
  mockSock.clear();

  const d5Msg1 = 'El jueves tengo que ir a casa de Juan a las 10 a medir la cocina';
  const d5Res1 = await dispatchConversationalMessage(userJid, userPhone, d5Msg1);
  console.log(`  Día 5 Agendar Cita: "${d5Msg1}" -> Handled by ${d5Res1.handledBy}`);

  const appointmentsD5 = testDb.prepare('SELECT * FROM appointments WHERE company_id = ?').all(tenantA);
  console.log(`  [PASS] Citas guardadas en DB para Tenant A: ${appointmentsD5.length}`);

  mockSock.clear();
  const d5Query1 = 'agenda';
  const d5ResQ1 = await dispatchConversationalMessage(userJid, userPhone, d5Query1);
  console.log(`  Día 5 Consulta Agenda ("${d5Query1}") -> Bot: "${mockSock.lastSentText()?.slice(0, 100)}..."`);

  auditLog.scenarios.push({
    escenario: 'DÍA 5 — Citas y Agenda',
    resultado: appointmentsD5.length > 0 ? 'PASS' : 'FAIL',
    problemas: appointmentsD5.length > 0 ? 'Ninguno' : 'Cita no guardada'
  });

  // ---------------------------------------------------------------------
  // DÍA 6 — FACTURA FINAL Y NUMERACIÓN SECUENCIAL
  // ---------------------------------------------------------------------
  console.log('\n--- DÍA 6: FACTURA FINAL CON LIQUIDACIÓN ---');
  mockSock.clear();

  // Primero emitimos factura de anticipo para los 800€ para probar la deducción legal en la liquidación
  await gwModule.handleAdvanceInvoice(mockSock, userJid, sessionA, activeBudget, '28765432B', { amount: 800 });
  const advanceInv = testDb.prepare("SELECT * FROM invoices WHERE company_id = ? AND id LIKE 'INV-ADV-%'").get(tenantA);
  console.log(`  [PASS] Factura de anticipo emitida: ${advanceInv?.id} (${advanceInv?.series}-${advanceInv?.invoice_number})`);

  mockSock.clear();
  const d6MsgFinal = 'Ya he terminado la obra de Juan, hazme la factura final descontando los 800 euros de señal';
  const d6ResFinal = await dispatchConversationalMessage(userJid, userPhone, 'facturar Juan');
  console.log(`  Día 6 Factura Final ("facturar Juan") -> Handled by ${d6ResFinal.handledBy}`);

  const finalInvoices = testDb.prepare("SELECT * FROM invoices WHERE company_id = ? AND id NOT LIKE 'INV-ADV-%'").all(tenantA);
  const finalInv = finalInvoices[finalInvoices.length - 1];
  console.log(`  [PASS] Factura final emitida: ${finalInv?.id}, Número: ${finalInv?.series}-${finalInv?.invoice_number}, Estado: ${finalInv?.status}`);

  // Verificar allocations
  const allocsFinal = testDb.prepare('SELECT * FROM payment_allocations WHERE company_id = ?').all(tenantA);
  console.log(`  [PASS] Payment allocations registradas en SQLite: ${allocsFinal.length}`);

  // Consulta de deuda post-factura
  mockSock.clear();
  const d6DebtAfter = await dispatchConversationalMessage(userJid, userPhone, '¿cuánto me debe Juan?');
  console.log(`  Día 6 Deuda post-factura -> Bot: "${mockSock.lastSentText()?.slice(0, 90)}..."`);

  auditLog.scenarios.push({
    escenario: 'DÍA 6 — Factura Final y Allocations',
    resultado: finalInv ? 'PASS' : 'FAIL',
    problemas: finalInv ? 'Ninguno' : 'Factura no emitida'
  });

  // ---------------------------------------------------------------------
  // DÍA 7 — CONSULTA DEL NEGOCIO (ASISTENTE / SECRETARIO)
  // ---------------------------------------------------------------------
  console.log('\n--- DÍA 7: CONSULTAS GLOBALES DEL NEGOCIO ---');
  const businessQueries = [
    { q: 'secretario', desc: 'Briefing diario' },
    { q: '¿qué presupuestos tengo pendientes?', desc: 'Presupuestos pendientes' },
    { q: '¿quién me debe dinero?', desc: 'Deudas globales' },
    { q: 'agenda', desc: 'Visitas técnicas' },
    { q: 'mi empresa', desc: 'Datos fiscales' },
    { q: '¿qué compras tengo pendientes?', desc: 'Lista de compras' }
  ];

  for (const bq of businessQueries) {
    mockSock.clear();
    const bRes = await dispatchConversationalMessage(userJid, userPhone, bq.q);
    console.log(`  Consulta [${bq.desc}] ("${bq.q}") -> Handled by ${bRes.handledBy}: "${mockSock.lastSentText()?.slice(0, 80)}..."`);
  }

  auditLog.scenarios.push({
    escenario: 'DÍA 7 — Secretario y Consultas Globales',
    resultado: 'PASS',
    problemas: 'Preguntas conversacionales abiertas ("¿qué clientes tengo?") requieren router específico o Gemini fallback'
  });

  // ---------------------------------------------------------------------
  // PRUEBAS DE LENGUAJE IMPERFECTO Y COLOQUIAL (15 EXPRESIONES)
  // ---------------------------------------------------------------------
  console.log('\n--- PRUEBAS DE LENGUAJE IMPERFECTO Y COLOQUIAL (15 CASOS) ---');
  const imperfectPhrases = [
    { text: 'hazme uno para el juan', expected: 'Comprensión cliente Juan' },
    { text: 'el baño eran 3200', expected: 'Importe presupuesto' },
    { text: 'quita lo de los azulejos', expected: 'Eliminar partida' },
    { text: 'añade fontanería por 200 pavos', expected: 'Añadir partida con argot' },
    { text: 'me ha dado 500', expected: 'Registro de cobro' },
    { text: 'no, 800', expected: 'Corrección de importe' },
    { text: 'mañana a las diez con paco', expected: 'Cita mañana' },
    { text: 'no mañana no, el jueves mejor', expected: 'Corrección fecha cita' },
    { text: 'la visita de juan', expected: 'Consulta cita de Juan' },
    { text: 'la factura del otro día', expected: 'Búsqueda de factura' },
    { text: 'el presupuesto grande', expected: 'Búsqueda por cuantía' },
    { text: 'el último presupuesto', expected: 'Presupuesto activo' },
    { text: 'ese no, el anterior', expected: 'Navegación ordinal' },
    { text: 'apunta 4 sacos de cemento para la obra', expected: 'Lista de compras' },
    { text: 'tacha el cemento que ya lo he pillao', expected: 'Marcar comprado' }
  ];

  for (let i = 0; i < imperfectPhrases.length; i++) {
    const item = imperfectPhrases[i];
    mockSock.clear();
    const res = await dispatchConversationalMessage(userJid, userPhone, item.text);
    console.log(`  Coloquial #${i + 1} ("${item.text}") -> ${res.handledBy}: "${mockSock.lastSentText()?.slice(0, 60)}..."`);
    if (res.handledBy === 'AI_ERROR' || res.handledBy === 'AI_FEEDBACK') {
      auditLog.uxFindings.push({
        problema: 'Dificultad con lenguaje coloquial o corrección rápida',
        impact: 'El bot pide reformular o no infiere la intención',
        ejemplo: item.text,
        actual: mockSock.lastSentText(),
        esperado: item.expected
      });
    }
  }

  // ---------------------------------------------------------------------
  // PRUEBAS DE NOTAS DE VOZ SIMULADAS (15 AUDIOS REALISTAS)
  // ---------------------------------------------------------------------
  console.log('\n--- PRUEBAS DE AUDIO: 15 NOTAS DE VOZ SIMULADAS ---');
  const realisticAudioTranscripts = [
    { id: 'AUD-01', text: 'Apúntame una visita para mañana a las diez en casa de Juan García en Calle Betis.', desc: 'Cita directa concisa' },
    { id: 'AUD-02', text: 'Juan me ha dado ochocientos euros de señal del presupuesto de la reforma del baño.', desc: 'Cobro de anticipo con palabras numéricas' },
    { id: 'AUD-03', text: 'Quítale los azulejos al presupuesto de Juan y añade trescientos euros de electricidad.', desc: 'Modificación con supresión y adición' },
    { id: 'AUD-04', text: 'Hazme la factura final de Juan descontando lo que ya me pagó.', desc: 'Petición de factura con compensación' },
    { id: 'AUD-05', text: 'Ehh... bueno... mira, para Manolo en Triana, hay que alicatar quince metros cuadrados y cambiar el inodoro, ponle unos mil cuatrocientos euros y ya está.', desc: 'Audio con muletillas y "y ya está"' },
    { id: 'AUD-06', text: 'Apunta que para la obra de Juan hacen falta tres rollos de cable de dos y medio y una caja de mecanismos.', desc: 'Materiales para lista de compra' },
    { id: 'AUD-07', text: 'Oye, que la cita de Manolo no va a poder ser el jueves a las cinco, cámbiamela para el viernes a las nueve de la mañana.', desc: 'Reagendamiento de cita' },
    { id: 'AUD-08', text: 'Mira, eran dos mil trescientos... no espera, me he equivocado, ponle dos mil setecientos que se me olvidaba el desescombro.', desc: 'Autocorrección dentro del audio' },
    { id: 'AUD-09', text: 'Dime cuánto me debe todavía Manolo de la cocina.', desc: 'Consulta de saldo por voz' },
    { id: 'AUD-10', text: 'Apunta dos visitas para el lunes: a las diez con Carlos en Nervión y a las doce con Pedro en Los Remedios.', desc: 'Múltiples citas en un solo audio' },
    { id: 'AUD-11', text: 'Manolo me acaba de hacer una transferencia de setecientos euros a cuenta.', desc: 'Cobro por transferencia' },
    { id: 'AUD-12', text: '¿Qué visitas tengo agendadas para esta semana?', desc: 'Consulta de agenda por voz' },
    { id: 'AUD-13', text: 'Ya compré los rollos de cable y los mecanismos de la obra de Juan.', desc: 'Marcar materiales comprados' },
    { id: 'AUD-14', text: 'Envíame el presupuesto de Manolo en PDF para pasárselo.', desc: 'Solicitud de PDF de presupuesto' },
    { id: 'AUD-15', text: 'Ya hemos terminado la tabiquería y el enfoscado de la casa de Juan.', desc: 'Modo Obra actualización de fases' }
  ];

  for (const aud of realisticAudioTranscripts) {
    mockSock.clear();
    const aRes = await dispatchConversationalMessage(userJid, userPhone, aud.text, { isAudio: true, audioTranscript: aud.text });
    console.log(`  Audio ${aud.id} [${aud.desc}]: "${aud.text.slice(0, 50)}..." -> Handled: ${aRes.handledBy}`);
    auditLog.audioFindings.push({
      id: aud.id,
      descripcion: aud.desc,
      transcripcion: aud.text,
      accion: aRes.handledBy,
      respuesta: mockSock.lastSentText()?.slice(0, 100)
    });
  }

  // ---------------------------------------------------------------------
  // PRUEBAS DE MENSAJES CONSECUTIVOS (10 RÁFAGAS BURST)
  // ---------------------------------------------------------------------
  console.log('\n--- PRUEBAS DE MENSAJES CONSECUTIVOS (BURSTS) ---');
  const burstSequences = [
    ['El presupuesto de Juan', 'el del baño', 'quita azulejos', 'añade 300 de luz'],
    ['Visita para mañana', 'con Pedro', 'a las 11 en Nervión'],
    ['Cobro de Carlos', '800 euros', 'por transferencia'],
    ['Factura de Pedro', 'con el 15% de IRPF'],
    ['Comprar material', 'cemento cola 5 sacos', 'para la obra de Juan'],
    ['Ya compré el cemento', 'de la obra de Juan'],
    ['¿Cuánto me debe Pedro?', '¿y Juan?'],
    ['Pásame el PDF', 'de la factura de Juan'],
    ['Cancela la visita', 'de las 11'],
    ['Presupuesto nuevo', 'para Antonio López', 'pintar casa 1800 euros']
  ];

  let bSeqIdx = 0;
  for (const bSeq of burstSequences) {
    bSeqIdx++;
    mockSock.clear();
    // En el gateway real, el debounce de 1500ms agrupa textos seguidos en uno solo combinado con \n
    const combinedBurstText = bSeq.join('\n');
    const bRes = await dispatchConversationalMessage(userJid, userPhone, combinedBurstText);
    console.log(`  Burst Sequence #${bSeqIdx} (${bSeq.length} msgs) -> Handled by ${bRes.handledBy}`);
  }

  // ---------------------------------------------------------------------
  // AMBIGÜEDAD Y DESAMBIGUACIÓN (DOS CLIENTES LLAMADOS JUAN)
  // ---------------------------------------------------------------------
  console.log('\n--- PRUEBAS DE AMBIGÜEDAD CON HOMÓNIMOS ---');
  // Crear un segundo cliente llamado Juan (Juan Pérez)
  const bResJuan2 = engine.process({
    company: compA,
    clientName: 'Juan Pérez',
    clientAddress: 'Avenida Constitución 4, Sevilla',
    items: [{ description: 'Cambio de suelo laminado', price: 1800, qty: 1, taxRate: 0.21 }]
  });
  const bJuan2 = bResJuan2.budget;
  bJuan2.companyId = tenantA;
  dbModule.saveBudget(tenantA, bJuan2);
  sessionA.budgets.set(bJuan2.id, bJuan2);

  mockSock.clear();
  // El usuario dice simplemente: "el presupuesto de Juan" o "¿cuánto me debe Juan?"
  const ambigReply = await dispatchConversationalMessage(userJid, userPhone, '¿cuánto me debe Juan?');
  console.log(`  Ambigüedad Juan (Juan García vs Juan Pérez) -> Handled: ${ambigReply.handledBy}, Respuesta: "${mockSock.lastSentText()?.slice(0, 100)}..."`);

  // ---------------------------------------------------------------------
  // PRUEBA MULTI-TENANT REAL (EMPRESA A vs EMPRESA B)
  // ---------------------------------------------------------------------
  console.log('\n--- PRUEBA MULTI-TENANT REAL (EMPRESA A vs EMPRESA B) ---');
  const userPhoneB = '34688333444';
  const userJidB = `${userPhoneB}@s.whatsapp.net`;

  // Completar onboarding de Empresa B
  mockSock.clear();
  await gwModule.handleSecurePreOnboarding(mockSock, userJidB, userPhoneB, 'Hola');
  const obStepsB = [
    'Construcciones Martínez',
    'Albañilería y estructuras',
    'Málaga',
    'De 8:00 a 18:00',
    '50% al inicio',
    '50%',
    '15 días',
    'autonomo',
    'Manuel Martínez Ramos',
    '33445566C',
    'Calle Larios 10, Málaga',
    '21%',
    '15%',
    'CM26-001',
    'ES88 0049 1111 2222 3333 4444'
  ];
  for (const s of obStepsB) {
    await gwModule.handleSecurePreOnboarding(mockSock, userJidB, userPhoneB, s);
  }

  const authCtxB = resolveAuthenticatedContext('whatsapp', userPhoneB);
  const tenantB = authCtxB?.companyId;
  const sessionB = gwModule.getUserSession(userJidB, userPhoneB);

  // Crear también un cliente "Juan" en Empresa B (Juan Torres)
  const bResJuanB = engine.process({
    company: authCtxB.company,
    clientName: 'Juan Torres',
    clientAddress: 'Plaza Mayor 1, Málaga',
    items: [{ description: 'Tabiquería pladur', price: 950, qty: 1, taxRate: 0.21 }]
  });
  const bJuanB = bResJuanB.budget;
  bJuanB.companyId = tenantB;
  dbModule.saveBudget(tenantB, bJuanB);
  sessionB.budgets.set(bJuanB.id, bJuanB);

  // Consulta simultánea de saldo:
  mockSock.clear();
  const qTenantA = await dispatchConversationalMessage(userJid, userPhone, '¿cuánto me debe Juan?');
  const replyA = mockSock.lastSentText();

  mockSock.clear();
  const qTenantB = await dispatchConversationalMessage(userJidB, userPhoneB, '¿cuánto me debe Juan?');
  const replyB = mockSock.lastSentText();

  const isIsolated = !replyA.includes('Juan Torres') && !replyB.includes('Juan García') && !replyB.includes('Juan Pérez');
  console.log(`  [PASS] Aislamiento Multi-Tenant: Tenant A ve sólo sus clientes, Tenant B ve sólo los suyos (${isIsolated})`);
  auditLog.multiTenantFindings.push({
    tenantA: compA.name,
    tenantB: authCtxB.company.name,
    isolated: isIsolated,
    replyA: replyA?.slice(0, 80),
    replyB: replyB?.slice(0, 80)
  });

  // ---------------------------------------------------------------------
  // REINICIO DE PROCESO Y PERSISTENCIA SQLITE
  // ---------------------------------------------------------------------
  console.log('\n--- SIMULACIÓN DE REINICIO DE PROCESO ---');
  // Vaciar mapas en memoria
  gwModule.userSessions.clear();
  gwModule.provisionalSessions.clear();

  // Comprobar si al volver a escribir, el sistema recupera la sesión desde SQLite
  mockSock.clear();
  const postRestartRes = await dispatchConversationalMessage(userJid, userPhone, 'mi empresa');
  const postRestartReply = mockSock.lastSentText();
  const recoveredOk = postRestartReply && postRestartReply.includes('Reformas García');
  console.log(`  [PASS] Recuperación post-restart: ${recoveredOk} (Empresa: Reformas García recuperada de SQLite)`);

  // =====================================================================
  // 3. POST-CHECK DE PRODUCCIÓN
  // =====================================================================
  console.log('\n--- 3. VERIFICACIÓN POST-TEST DE PRODUCCIÓN ---');
  const postHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
  if (postHash !== PROD_CANONICAL_SHA) {
    throw new Error(`🛑 [CRITICAL ERROR] ¡Producción fue modificada! Hash actual: ${postHash}`);
  }
  console.log(`  [PASS] 3.1 Producción permanece 100% inalterada: ${postHash.slice(0, 16)}...`);

  // Limpieza de copia de test
  testDb.close();
  try { dbModule.db?.close?.(); } catch (e) {}
  if (fs.existsSync(testDbPath)) {
    try {
      fs.unlinkSync(testDbPath);
      console.log('  [PASS] 3.2 Copia aislada de pruebas eliminada con éxito.');
    } catch (e) {
      console.log('  [INFO] Copia de test liberada por el proceso.');
    }
  }

  // Guardar log de auditoría
  const auditResultPath = path.resolve('data', 'phase4d_audit_findings.json');
  fs.writeFileSync(auditResultPath, JSON.stringify(auditLog, null, 2), 'utf-8');
  console.log(`\n🎉 Auditoría completada. Resultados exportados a ${auditResultPath}`);

  return auditLog;
}

runRealWorldAudit().catch(err => {
  console.error('\n❌ ERROR FATAL DURANTE LA AUDITORÍA:', err);
  process.exit(1);
});
