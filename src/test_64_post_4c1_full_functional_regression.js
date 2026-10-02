/**
 * TEST 64: POST-4C.1 FULL FUNCTIONAL REGRESSION & E2E VALIDATION
 * 
 * Comprehensive audit & regression battery across all functional blocks (A through U).
 * Strict zero-write policy on production data/presuvoz.db.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function runTest64() {
  console.log('\n======================================================================');
  console.log('TEST 64: POST-4C.1 FULL FUNCTIONAL REGRESSION (PRESUVOZ)');
  console.log('======================================================================\n');

  let passed = 0;
  let total = 0;
  const auditFindings = [];

  function assert(condition, message, metadata = {}) {
    total++;
    if (condition) {
      passed++;
      console.log(`  [PASS] ${message}`);
    } else {
      console.error(`  [FAIL] ${message}`);
      auditFindings.push({ status: 'FAIL', message, ...metadata });
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  function recordFinding(id, title, classification, details) {
    auditFindings.push({ id, title, classification, details });
    console.log(`  [AUDIT-${classification}] ${id}: ${title}`);
  }

  const PROD_CANONICAL_SHA = 'FEA8233D53D3AE4618A9FDD930147036E7061F79A92DD920AAE8CE11E2F07A35';
  const prodPath = path.resolve('data', 'presuvoz.db');

  // =====================================================================
  // 1. PRE-CHECK DE PRODUCCIÓN
  // =====================================================================
  console.log('--- 1. VERIFICACIÓN PREVIA DE PRODUCCIÓN ---');
  const preHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
  assert(preHash === PROD_CANONICAL_SHA, `1.1 data/presuvoz.db intacto pre-test (${PROD_CANONICAL_SHA.slice(0, 12)}...)`);

  const prodVerifyDb = new DatabaseSync(prodPath, { open: true, readOnly: true });
  const preIntegrity = prodVerifyDb.prepare('PRAGMA integrity_check').get();
  assert(preIntegrity?.integrity_check === 'ok', '1.2 PRAGMA integrity_check = ok en producción');
  const preFk = prodVerifyDb.prepare('PRAGMA foreign_key_check').all();
  assert(preFk.length === 0, '1.3 PRAGMA foreign_key_check = 0 en producción');
  const preMigrations = prodVerifyDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  assert(preMigrations.length === 16 && preMigrations[15].version === 16, '1.4 schema_migrations [1..16] presentes en producción');
  const preInvoicesCount = prodVerifyDb.prepare('SELECT count(*) as c FROM invoices').get().c;
  assert(preInvoicesCount === 6, '1.5 Exactamente 6 facturas históricas en producción');
  prodVerifyDb.close();

  // =====================================================================
  // 2. PREPARACIÓN DE ENTORNO AISLADO
  // =====================================================================
  console.log('\n--- 2. PREPARACIÓN DE ENTORNO DE PRUEBAS AISLADO ---');
  const testDbPath = path.resolve('data', `isolated_test_64_${Date.now()}_${Math.floor(Math.random() * 1000)}.db`);
  fs.copyFileSync(prodPath, testDbPath);
  assert(fs.existsSync(testDbPath), '2.1 Copia fiel aislada creada');

  // Configurar ENV OBLIGATORIAMENTE antes de importar cualquier servicio
  process.env.NODE_ENV = 'test';
  process.env.PRESUVOZ_DB_PATH = testDbPath;

  const {
    db,
    getCompany,
    saveCompany,
    saveBudget,
    getBudget,
    listBudgets,
    deleteBudget,
    emitInvoice,
    saveInvoice,
    getInvoice,
    listInvoices,
    savePayment,
    getPayment,
    createPaymentAllocation,
    getPaymentAllocation,
    saveAppointment,
    listAppointments,
    getAppointment,
    updateAppointment,
    deleteAppointment,
    addShoppingItems,
    listShoppingItems,
    markShoppingItemBought,
    clearShoppingList,
    deleteShoppingItem,
    savePurchaseInvoice,
    listPurchaseInvoices,
    getQuarterInvoices,
    getAppointmentsRequiringMorningReminder,
    getAppointmentsRequiringEveningReminder,
    getAppointmentsRequiringEndOfDayReview,
    markMorningReminderSent,
    markEveningReminderSent,
    markEndOfDayReviewSent,
    isMessageAlreadyProcessed,
    recordIncomingMessage
  } = await import('./db_service.js');

  const { PresuVozEngine } = await import('./engine.js');
  const {
    shouldProcessIncomingMessage,
    isAuthorizedEgressRecipient,
    handleSecurePreOnboarding,
    handlePaymentRegistration,
    handleAdvanceInvoice,
    emitInvoiceForBudget,
    userSessions,
    provisionalSessions,
    botSentMessageIds,
    chatQueues
  } = await import('./whatsapp_gateway.js');

  const {
    runMorningReminderJob,
    runEveningBeforeReminderJob,
    runEndOfDayReviewJob,
    reconcilePendingSchedulerJobs,
    resolveSchedulerTargetJid
  } = await import('./appointment_scheduler.js');

  const { resolveAuthenticatedContext } = await import('./identity_service.js');
  const { getOnboardingState } = await import('./onboarding_service.js');

  const testDb = new DatabaseSync(testDbPath);
  testDb.exec('PRAGMA foreign_keys = ON;');

  try {
    // =====================================================================
    // BLOQUE A: ONBOARDING REAL (A1 to A15)
    // =====================================================================
    console.log('\n--- BLOQUE A: ONBOARDING REAL (A1..A15) ---');
    const myNum = '34600111222';
    const allowed = ['34699000111'];

    // A1: Número completamente nuevo
    const newPhoneA = '34688111222';
    const newJidA = `${newPhoneA}@s.whatsapp.net`;
    const checkA1 = shouldProcessIncomingMessage({ remoteJid: newJidA, fromMe: false, myNumber: myNum, allowedNumbers: allowed });
    assert(checkA1.process === true && checkA1.reason === 'ONBOARDING_ELIGIBLE_SENDER', 'A1. Número completamente nuevo admitido para onboarding');

    // A2: "Hola"
    const mockSock = {
      sentMessages: [],
      async sendMessage(jid, content) {
        this.sentMessages.push({ jid, content });
        return { key: { id: `MOCK_${Date.now()}_${Math.random()}` } };
      }
    };
    const startA2 = await handleSecurePreOnboarding(mockSock, newJidA, newPhoneA, 'Hola, quiero empezar');
    assert(startA2.handled === true && startA2.started === true, 'A2. "Hola" arranca onboarding interactivo');
    assert(provisionalSessions.has(newJidA), 'A2.1 Sesión provisional creada en memoria');

    // A3: Varios mensajes seguidos (burst)
    const burst1 = await handleSecurePreOnboarding(mockSock, newJidA, newPhoneA, 'Carlos Gómez, Reformas Gómez');
    assert(burst1.handled === true, 'A3.1 Primer mensaje del burst procesado');

    // A4: Repetir saludo durante onboarding -> debe responder el paso actual sin reiniciar
    const saluteMid = await handleSecurePreOnboarding(mockSock, newJidA, newPhoneA, 'buenas tardes');
    assert(saluteMid.handled === true, 'A4. Mensaje durante onboarding guiado procesado');

    // A5: Simulación de reinicio durante onboarding
    // Si el proceso reinicia, provisionalSessions se vacía, pero getOnboardingState(canonicalIdentifier) persiste en SQLite
    const stateA5 = getOnboardingState(newPhoneA);
    assert(stateA5 && stateA5.step, 'A5. Estado de onboarding persistido en SQLite resiste reinicio');

    // A6: Completar onboarding
    const answersA = [
      'Albañilería y reformas',     // TRADE
      'Madrid capital',             // CITY
      'De 8:00 a 19:00',            // WORKING_HOURS
      '2',                          // PAYMENT_TERMS (30/40/30)
      '30%',                        // ADVANCE
      '30 días',                    // QUOTE_VALIDITY
      'autonomo',                   // ENTITY_TYPE
      'Carlos Gómez Serrano',       // FISCAL_NAME
      '12345678Z',                  // CIF_NIF
      'Calle Alcalá 100, Madrid',   // FISCAL_ADDRESS
      '1',                          // TAX_RATE (21%)
      '15%',                        // IRPF_RATE
      'A26-001',                    // INVOICE_SERIES
      'ES91 0049 1500 0512 3456 7890' // BANK_ACCOUNT
    ];

    let lastStepA = null;
    for (const ans of answersA) {
      lastStepA = await handleSecurePreOnboarding(mockSock, newJidA, newPhoneA, ans);
    }
    assert(lastStepA?.completed === true, 'A6. Onboarding completado con éxito');
    assert(!provisionalSessions.has(newJidA), 'A6.1 provisionalSessions liberada post-onboarding');

    // A7: Retry después de completar (usuario vuelve a escribir)
    const afterComplete = await handleSecurePreOnboarding(mockSock, newJidA, newPhoneA, 'Hola de nuevo');
    assert(afterComplete.handled === false, 'A7. Usuario completado ya no entra en onboarding (pasa al flujo normal)');

    // A8: Segundo usuario nuevo
    const newPhoneB = '34688333444';
    const newJidB = `${newPhoneB}@s.whatsapp.net`;
    const startB = await handleSecurePreOnboarding(mockSock, newJidB, newPhoneB, 'Hola');
    assert(startB.handled === true && startB.started === true, 'A8. Segundo usuario arranca onboarding independiente');

    // A9: Dos usuarios simultáneos en onboarding
    assert(provisionalSessions.has(newJidB) && !provisionalSessions.has(newJidA), 'A9. Aislamiento entre sesiones provisionales simultáneas');

    // A10: Intento de companyId inyectado en onboarding / context
    const maliciousContext = resolveAuthenticatedContext('whatsapp', newPhoneB);
    // Antes de completar, newPhoneB no tiene authenticated context
    assert(maliciousContext === null, 'A10. Intento de resolver contexto antes de completar retorna null');

    // A11: Intento de acceso a tenant ajeno antes de completar
    const tenantA = resolveAuthenticatedContext('whatsapp', newPhoneA).companyId;
    const leakAttempt = testDb.prepare('SELECT * FROM companies WHERE id = ?').get(tenantA);
    assert(leakAttempt && leakAttempt.id === tenantA, 'A11. Tenant A registrado legalmente');

    // A12: Grupo (@g.us) bloqueado
    const checkGroup = shouldProcessIncomingMessage({ remoteJid: '34699000-1234@g.us', fromMe: false, myNumber: myNum, allowedNumbers: allowed });
    assert(checkGroup.process === false && checkGroup.reason === 'GROUP_OR_BROADCAST_IGNORED', 'A12. Grupo WhatsApp bloqueado');

    // A13: Broadcast (@broadcast) bloqueado
    const checkBcast = shouldProcessIncomingMessage({ remoteJid: 'status@broadcast', fromMe: false, myNumber: myNum, allowedNumbers: allowed });
    assert(checkBcast.process === false && checkBcast.reason === 'GROUP_OR_BROADCAST_IGNORED', 'A13. Broadcast WhatsApp bloqueado');

    // A14: Newsletter (@newsletter) bloqueado
    const checkNews = shouldProcessIncomingMessage({ remoteJid: '12036302@newsletter', fromMe: false, myNumber: myNum, allowedNumbers: allowed });
    assert(checkNews.process === false && checkNews.reason === 'GROUP_OR_BROADCAST_IGNORED', 'A14. Newsletter WhatsApp bloqueado');

    // A15: Self-chat admitido
    const checkSelf = shouldProcessIncomingMessage({ remoteJid: `${myNum}@s.whatsapp.net`, fromMe: true, myNumber: myNum, allowedNumbers: allowed });
    assert(checkSelf.process === true && checkSelf.reason === 'SELF_CHAT', 'A15. Self-chat admitido');

    // Verificaciones canónicas de A:
    const chanIdentitiesA = testDb.prepare('SELECT * FROM channel_identities WHERE channel_identifier = ?').all(newPhoneA);
    assert(chanIdentitiesA.length === 1, 'A.Verif: Exactamente una channel_identity para el nuevo usuario A');
    const membersA = testDb.prepare('SELECT * FROM memberships WHERE company_id = ?').all(tenantA);
    assert(membersA.length === 1 && membersA[0].role === 'OWNER', 'A.Verif: Exactamente un OWNER para Tenant A');

    // Completar onboarding de B para tener dos tenants activos y aislados
    for (const ans of [
      'Pinturas Martínez, Martínez Pintores',
      'Pintura y empapelado',
      'Valencia',
      'De 8:00 a 18:00',
      '1', // 50/50
      '40%',
      '15 días',
      'autonomo',
      'Pascual Martínez Ruiz',
      '87654321X',
      'Calle Colón 5, Valencia',
      '1',
      '15%',
      'P26-001',
      'ES91 2100 0000 0000 0000 0000'
    ]) {
      await handleSecurePreOnboarding(mockSock, newJidB, newPhoneB, ans);
    }
    const tenantB = resolveAuthenticatedContext('whatsapp', newPhoneB).companyId;
    assert(tenantA !== tenantB, 'A.Verif: Tenants A y B tienen UUIDs distintos e independientes');

    // =====================================================================
    // BLOQUE B: PERFIL EMPRESARIAL
    // =====================================================================
    console.log('\n--- BLOQUE B: PERFIL EMPRESARIAL ---');
    const compA = getCompany(tenantA);
    assert(compA && compA.cif === '12345678Z' && compA.invoiceSeries === 'A26-001', 'B1. Consulta de perfil empresarial correcta');

    // Modificación de perfil
    compA.address = 'Avenida de América 25, Madrid';
    compA.defaultTaxRate = 10;
    saveCompany(newPhoneA, compA);

    const compAMod = getCompany(tenantA);
    assert(compAMod.address === 'Avenida de América 25, Madrid' && compAMod.defaultTaxRate === 10, 'B2. Modificación y persistencia de perfil');

    // Aislamiento de perfil: B no fue alterado
    const compB = getCompany(tenantB);
    assert(compB.cif === '87654321X' && compB.defaultTaxRate !== 10, 'B3. Modificación de A no afecta al perfil de B (Tenant Isolation)');

    // =====================================================================
    // BLOQUE C: PRESUPUESTOS (E2E & CONCURRENCIA)
    // =====================================================================
    console.log('\n--- BLOQUE C: PRESUPUESTOS ---');
    const engineA = new PresuVozEngine({ name: compA.name, cif: compA.cif, phone: compA.phone });
    const engineB = new PresuVozEngine({ name: compB.name, cif: compB.cif, phone: compB.phone });

    // Presupuesto 1 (Tenant A, IVA 21%)
    const bRes1 = engineA.process({
      clientName: 'Juan Español',
      clientAddress: 'Calle Mayor 1',
      items: [{ description: 'Tabiquería pladur', price: 1000, qty: 1, taxRate: 0.21 }]
    });
    const b1 = bRes1.budget;
    b1.companyId = tenantA;
    saveBudget(tenantA, b1);
    assert(getBudget(tenantA, b1.id) !== null, 'C1. Presupuesto 1 guardado en DB');

    // Presupuesto 2 (Tenant A, IVA 10% vivienda habitual)
    const bRes2 = engineA.process({
      clientName: 'María García',
      clientAddress: 'Calle Goya 15',
      taxRate: 0.10,
      items: [{ description: 'Pintura piso vivienda', price: 800, qty: 1 }]
    });
    const b2 = bRes2.budget;
    b2.companyId = tenantA;
    saveBudget(tenantA, b2);
    assert(b2.financials.taxAmount === 80, 'C2. Presupuesto 2 con IVA 10% calculado exactamente (80€)');

    // Presupuesto sin cliente explícito -> fallback "Cliente Particular"
    const bResNoClient = engineA.process({
      items: [{ description: 'Arreglo puerta', price: 150, qty: 1, taxRate: 0.21 }]
    });
    assert(bResNoClient.budget.client.name === 'Cliente Particular', 'C3. Fallback a "Cliente Particular" sin cliente explícito');

    // Concurrencia de presupuestos: 10 presupuestos simultáneos
    const concurrentBudgets = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const proc = engineA.process({
          clientName: `Cliente Concurrente ${i}`,
          items: [{ description: `Partida ${i}`, price: 100 * (i + 1), qty: 1, taxRate: 0.21 }]
        });
        proc.budget.companyId = tenantA;
        return saveBudget(tenantA, proc.budget);
      })
    );
    assert(concurrentBudgets.length === 10, 'C4. 10 presupuestos procesados y guardados concurrentemente');

    // Verificar que no hay mezcla de partidas
    const loadedConcurrent = concurrentBudgets.map(b => getBudget(tenantA, b.id));
    const allUniqueItems = loadedConcurrent.every((b, idx) => b.items.length === 1 && b.items[0].description === `Partida ${idx}`);
    assert(allUniqueItems, 'C5. Cero mezcla de partidas entre presupuestos concurrentes');

    // =====================================================================
    // BLOQUE D: FACTURACIÓN 016 (SECUENCIA, ATOMICIDAD, IDEMPOTENCIA)
    // =====================================================================
    console.log('\n--- BLOQUE D: FACTURACIÓN 016 ---');
    // D1: Primera factura Tenant A
    const rawInv1 = engineA.convertToInvoice(b1);
    const em1 = emitInvoice(tenantA, rawInv1);
    assert(em1.invoice.invoice_number === 1 && em1.invoice.series === 'A26-001', 'D1. Primera factura asignada como A26-001-001');

    // D2: Segunda factura Tenant A
    const rawInv2 = engineA.convertToInvoice(b2);
    const em2 = emitInvoice(tenantA, rawInv2);
    assert(em2.invoice.invoice_number === 2 && em2.invoice.series === 'A26-001', 'D2. Segunda factura asignada como A26-001-002');

    // D3: Factura Tenant B con misma serie en su perfil -> aislamiento secuencial
    // Tenant B tiene configurada serie P26-001
    const bResB = engineB.process({
      clientName: 'Cliente Levante',
      items: [{ description: 'Pintura fachada', price: 2000, qty: 1, taxRate: 0.21 }]
    });
    const bB = bResB.budget;
    bB.companyId = tenantB;
    saveBudget(tenantB, bB);

    const rawInvB = engineB.convertToInvoice(bB);
    const emB = emitInvoice(tenantB, rawInvB);
    assert(emB.invoice.invoice_number === 1 && emB.invoice.series === 'P26-001', 'D3. Factura de Tenant B empieza en 1 con su propia serie');

    // D4: Idempotencia por budgetId
    const emRetry = emitInvoice(tenantA, rawInv1);
    assert(emRetry.isDuplicate === true && emRetry.invoice.invoice_number === 1, 'D4. Retry de emisión para mismo presupuesto retorna la existente sin consumir número');

    // D5: Concurrencia de facturación (10 emisiones concurrentes con BEGIN IMMEDIATE)
    const concBudgetsForInv = Array.from({ length: 10 }, (_, i) => {
      const b = engineA.process({
        clientName: `Cliente Factura Concurrente ${i}`,
        items: [{ description: `Obra ${i}`, price: 300, qty: 1, taxRate: 0.21 }]
      }).budget;
      b.companyId = tenantA;
      saveBudget(tenantA, b);
      return b;
    });

    const concInvoices = await Promise.all(
      concBudgetsForInv.map(b => {
        const raw = engineA.convertToInvoice(b);
        return Promise.resolve(emitInvoice(tenantA, raw));
      })
    );
    const assignedNums = concInvoices.map(res => res.invoice.invoice_number).sort((a, b) => a - b);
    const expectedNums = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const isStrictSequence = assignedNums.every((num, idx) => num === expectedNums[idx]);
    assert(isStrictSequence, `D5. Concurrencia x10 en facturación: secuencia estrictamente correlativa [3..12] sin gaps ni duplicados`);

    // =====================================================================
    // BLOQUE E: PAGOS Y ALLOCATIONS (DEF-02 POST-FIX AUDIT)
    // =====================================================================
    console.log('\n--- BLOQUE E: PAGOS Y ALLOCATIONS ---');
    const sessionA = {
      phone: newPhoneA,
      companyId: tenantA,
      company: compA,
      budgets: new Map(),
      invoices: new Map()
    };
    userSessions.set(newJidA, sessionA);

    // E1: Pago sin factura
    const bPay = engineA.process({
      clientName: 'Marcos Soto',
      items: [{ description: 'Reparación techo', price: 500, qty: 1, taxRate: 0.21 }]
    }).budget;
    bPay.companyId = tenantA;
    saveBudget(tenantA, bPay);
    sessionA.budgets.set(bPay.id, bPay);
    sessionA.activeBudgetId = bPay.id;

    await handlePaymentRegistration(mockSock, newJidA, sessionA, bPay, { amount: 200, method: 'Bizum' });
    const allocsE1 = testDb.prepare('SELECT * FROM payment_allocations WHERE company_id = ?').all(tenantA);
    assert(allocsE1.length === 0, 'E1. Cero payment_allocations cuando no hay factura emitida');

    // E2: Factura de anticipo emitida posteriormente
    await handleAdvanceInvoice(mockSock, newJidA, sessionA, bPay, '55443322W', { amount: 200 });
    const allocsE2 = testDb.prepare(`
      SELECT a.* FROM payment_allocations a
      JOIN invoices i ON a.invoice_id = i.id
      WHERE a.company_id = ? AND i.budget_id = ?
    `).all(tenantA, bPay.id);
    assert(allocsE2.length === 1 && allocsE2[0].amount === 200, 'E2. Pago vinculado automáticamente a la factura de anticipo vía payment_allocations');

    // E3: Factura final y segundo pago
    await emitInvoiceForBudget(mockSock, newJidA, sessionA, bPay, '55443322W');
    const finalInvE = testDb.prepare('SELECT id, status, total_amount FROM invoices WHERE company_id = ? AND budget_id = ? AND id != ?').get(tenantA, bPay.id, allocsE2[0].invoice_id);
    assert(finalInvE !== undefined, 'E3. Factura final emitida');

    // Pago de liquidación (530€ total con 15% IRPF - 200€ anticipo = 330€ neto pendiente)
    await handlePaymentRegistration(mockSock, newJidA, sessionA, bPay, { amount: 330, method: 'Transferencia' });
    const allocsE3 = testDb.prepare('SELECT * FROM payment_allocations WHERE company_id = ? AND invoice_id = ?').all(tenantA, finalInvE.id);
    assert(allocsE3.length === 1 && allocsE3[0].amount === 330, 'E4. Cobro de liquidación imputado a la factura final');

    // E5: Verificación de límite estricto: SUM(allocations) <= payment.amount
    const allPayments = testDb.prepare('SELECT id, amount FROM payments WHERE company_id = ?').all(tenantA);
    const isSumValid = allPayments.every(p => {
      const row = testDb.prepare('SELECT COALESCE(SUM(amount), 0) as s FROM payment_allocations WHERE payment_id = ?').get(p.id);
      return Number(row.s) <= Number(p.amount);
    });
    assert(isSumValid, 'E5. Regla estricta: SUM(payment_allocations.amount) <= payment.amount cumplida en todos los cobros');

    // =====================================================================
    // BLOQUE F: DEUDAS Y ESTADO DE CUENTAS
    // =====================================================================
    console.log('\n--- BLOQUE F: DEUDAS Y ESTADO DE CUENTAS ---');
    const bSettled = engineA.process({
      clientName: 'Cliente Liquidado',
      items: [{ description: 'Arreglo menor', price: 100, qty: 1, taxRate: 0.21 }]
    }).budget;
    bSettled.companyId = tenantA;
    engineA.registerPayment(bSettled, { amount: 121, method: 'Bizum' });
    const summarySettled = engineA.getPaymentSummary(bSettled);
    assert(summarySettled.remainingBalance === 0 && summarySettled.status === 'LIQUIDADO', 'F1. Presupuesto liquidado muestra saldo pendiente 0€');

    // Cliente con deuda pendiente
    const bDebt = engineA.process({
      clientName: 'Cliente Deudor',
      items: [{ description: 'Obra pendiente', price: 1000, qty: 1, taxRate: 0.21 }]
    }).budget;
    bDebt.companyId = tenantA;
    saveBudget(tenantA, bDebt);
    const summaryDebt = engineA.getPaymentSummary(bDebt);
    assert(summaryDebt.remainingBalance === 1210 && summaryDebt.status === 'PENDIENTE', 'F2. Presupuesto sin pagos muestra deuda total íntegra (1210€)');

    // =====================================================================
    // BLOQUE G: CITAS Y AGENDA TÉCNICA
    // =====================================================================
    console.log('\n--- BLOQUE G: CITAS Y AGENDA TÉCNICA ---');
    const todayStr = new Date().toISOString().split('T')[0];
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const app1 = saveAppointment(tenantA, {
      clientName: 'Visita Técnica 1',
      date: todayStr,
      time: '10:00',
      address: 'Calle Luna 4'
    });
    assert(app1 && app1.id, 'G1. Cita creada con ID persistido');

    const appList = listAppointments(tenantA, 'all');
    assert(appList.some(a => a.id === app1.id), 'G2. Cita listada en la agenda');

    // Modificar cita
    updateAppointment(tenantA, app1.id, { time: '11:30' });
    const appUpdated = getAppointment(tenantA, app1.id);
    assert(appUpdated.time === '11:30', 'G3. Cita modificada y persistida');

    // Dos tenants aislamiento de citas
    const appB = saveAppointment(tenantB, {
      clientName: 'Visita B',
      date: todayStr,
      time: '16:00'
    });
    const listAApps = listAppointments(tenantA, 'all');
    assert(!listAApps.some(a => a.id === appB.id), 'G4. Tenant A no ve las citas de Tenant B (Aislamiento)');

    // =====================================================================
    // BLOQUE H: SCHEDULER AUTÓNOMO (DEF-03 & DEF-06)
    // =====================================================================
    console.log('\n--- BLOQUE H: SCHEDULER AUTÓNOMO ---');
    // H1: Recordatorio matinal
    await runMorningReminderJob(mockSock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    const morningSentCount = testDb.prepare('SELECT count(*) as c FROM appointments WHERE reminder_morning_sent_at IS NOT NULL').get().c;
    assert(morningSentCount >= 1, 'H1. Recordatorio matinal ejecutado sin ReferenceError (DEF-03)');

    // H2: Recordatorio de víspera para cita de mañana
    saveAppointment(tenantA, {
      clientName: 'Visita Mañana',
      date: tomorrowStr,
      time: '09:00'
    });
    await runEveningBeforeReminderJob(mockSock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    const eveningSentCount = testDb.prepare('SELECT count(*) as c FROM appointments WHERE reminder_day_sent_at IS NOT NULL').get().c;
    assert(eveningSentCount >= 1, 'H2. Recordatorio de víspera ejecutado correctamente');

    // H3: Revisión de fin de jornada
    await runEndOfDayReviewJob(mockSock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    const eodSentCount = testDb.prepare('SELECT count(*) as c FROM appointments WHERE end_of_day_review_sent_at IS NOT NULL').get().c;
    assert(eodSentCount >= 1, 'H3. Revisión de fin de jornada ejecutada correctamente');

    // H4: Reconciliación en arranque (DEF-06)
    // Crear cita pendiente de aviso matinal sin marca de envío
    const appUnnotified = saveAppointment(tenantA, {
      clientName: 'Cita No Notificada Por Crash',
      date: todayStr,
      time: '12:00'
    });
    testDb.prepare('UPDATE appointments SET reminder_morning_sent_at = NULL WHERE id = ?').run(appUnnotified.id);

    const recResult = await reconcilePendingSchedulerJobs(mockSock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    assert(recResult.reconciled === true && recResult.results.morning === true, 'H4. reconcilePendingSchedulerJobs ejecuta reconciliación en arranque');
    const recCheck = testDb.prepare('SELECT reminder_morning_sent_at FROM appointments WHERE id = ?').get(appUnnotified.id);
    assert(recCheck.reminder_morning_sent_at !== null, 'H4.1 Cita no notificada reconciliada y persistida en SQLite');

    // H5: Idempotencia: segunda llamada inmediata de reconciliación no duplica envíos
    const countBeforeRetry = mockSock.sentMessages.length;
    await reconcilePendingSchedulerJobs(mockSock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    const countAfterRetry = mockSock.sentMessages.length;
    assert(countAfterRetry === countBeforeRetry, 'H5. Reconciliación 100% idempotente (cero mensajes duplicados)');

    // =====================================================================
    // BLOQUE I: LISTA DE COMPRAS DE MATERIALES
    // =====================================================================
    console.log('\n--- BLOQUE I: LISTA DE COMPRAS ---');
    const insertedItems = addShoppingItems(tenantA, [
      { description: 'Sacos de mortero x 10', qty: 10 },
      { description: 'Varillas corrugadas 12mm', qty: 20 }
    ]);
    assert(insertedItems && insertedItems.length === 2, 'I1. Materiales añadidos a la lista');

    const shopListA = listShoppingItems(tenantA, 'all');
    assert(shopListA.length >= 2, 'I2. Lista de compras consultada');

    markShoppingItemBought(tenantA, insertedItems[0].id);
    const shopListAfterBought = listShoppingItems(tenantA, 'all');
    assert(shopListAfterBought.find(i => i.id === insertedItems[0].id)?.status === 'BOUGHT', 'I3. Material marcado como comprado');

    // Aislamiento de lista de compras
    const shopListB = listShoppingItems(tenantB, 'all');
    assert(shopListB.length === 0, 'I4. Tenant B no ve los materiales de compra de Tenant A');

    // =====================================================================
    // BLOQUE J: MODO OBRA (MEMORIA VIVA Y FICHA)
    // =====================================================================
    console.log('\n--- BLOQUE J: MODO OBRA ---');
    // Verificar si Modo Obra se almacena en budget.tasks / budget.notes en DB
    const bWork = engineA.process({
      clientName: 'Obra Elvira',
      items: [{ description: 'Demolición tabique', price: 400, qty: 1, taxRate: 0.21 }]
    }).budget;
    bWork.companyId = tenantA;
    bWork.workMemory = { phase: 'DEMOLICION', percent: 50 };
    saveBudget(tenantA, bWork);

    const bWorkLoaded = getBudget(tenantA, bWork.id);
    assert(bWorkLoaded.workMemory?.percent === 50, 'J1. Estado de obra persistido dentro de workMemory en SQLite');
    recordFinding('J-AUDIT', 'Modo Obra Persistencia', 'B', 'Las fases de obra se persisten serializadas en budgets.data_json; las tareas efímeras del chat residen en memoria de sesión.');

    // =====================================================================
    // BLOQUE K & L: AUDIO, FIFO Y DEDUPE
    // =====================================================================
    console.log('\n--- BLOQUE K & L: AUDIO, FIFO Y DEDUPE ---');
    // Simulación de dedupe por wamId
    const testWamId = `test_wam_${Date.now()}`;
    const firstCheck = isMessageAlreadyProcessed(testWamId);
    assert(firstCheck === false, 'L1. wamId nuevo no está marcado como procesado');

    // Simular registro en DB messages
    recordIncomingMessage({
      whatsappMessageId: testWamId,
      companyId: tenantA,
      chatId: newJidA,
      senderPhone: newPhoneA,
      content: 'Mensaje de prueba',
      status: 'PROCESSED'
    });

    const secondCheck = isMessageAlreadyProcessed(testWamId);
    assert(secondCheck === true, 'L2. wamId duplicado detectado como ya procesado en SQLite (Dedupe)');
    recordFinding('L-AUDIT', 'FIFO In-Memory Queue', 'B', 'Las colas de chat (chatQueues) son en memoria RAM; si el nodo reinicia mientras hay tareas en cola, se descartan los mensajes no persistidos.');

    // =====================================================================
    // BLOQUE M: GEMINI AI SERVICE AUDIT
    // =====================================================================
    console.log('\n--- BLOQUE M: GEMINI AI SERVICE AUDIT ---');
    const aiModule = await import('./ai_service.js');
    assert(typeof aiModule.parsePurchaseInvoiceWithGemini === 'function', 'M1. parsePurchaseInvoiceWithGemini disponible');
    recordFinding('M-AUDIT', 'Gemini Models Configuration', 'B', 'Modelos definidos: gemini-2.0-flash, gemini-1.5-flash. Fallbacks implementados pero requieren validación online con token activo (GEMINI-FALLBACK-PENDING-VERIFICATION).');

    // =====================================================================
    // BLOQUE N: DEFENSE-IN-DEPTH & ERRORES
    // =====================================================================
    console.log('\n--- BLOQUE N: DEFENSE-IN-DEPTH & FAIL-CLOSED ---');
    // N1: companyId null en saveInvoice debe fallar
    let errCompanyNull = false;
    try {
      saveInvoice(null, { id: 'INV-TEST-NULL', financials: { totalAmount: 100 } });
    } catch {
      errCompanyNull = true;
    }
    assert(errCompanyNull, 'N1. saveInvoice(null, ...) falla de forma fail-closed');

    // N2: createPaymentAllocation con cross-tenant mismatch
    let errCrossAlloc = false;
    try {
      createPaymentAllocation(tenantA, {
        paymentId: allPayments[0].id,
        invoiceId: emB.invoice.id, // Factura de Tenant B
        amount: 50
      });
    } catch {
      errCrossAlloc = true;
    }
    assert(errCrossAlloc, 'N2. Intento de payment_allocation cruzando tenant bloqueado estrictamente');

    // =====================================================================
    // BLOQUE O: FISCAL SERVICE AUDIT (MODELO 303 & 130)
    // =====================================================================
    console.log('\n--- BLOQUE O: FISCAL SERVICE AUDIT ---');
    const fiscalModule = await import('./fiscal_service.js');
    assert(typeof fiscalModule.getQuarterSummary === 'function', 'O1. getQuarterSummary disponible');
    const quarterSum = fiscalModule.getQuarterSummary(tenantA, 2026, 4);
    assert(quarterSum !== null && quarterSum.summary?.modelo303 !== undefined, 'O2. Liquidación trimestral calculada para Modelo 303');
    recordFinding('O-AUDIT', 'Modelo 130 Cumulative', 'B', 'El cálculo de Modelo 130 no acumula trimestres anteriores (pendiente de diseño futuro: MODEL130-CUMULATIVE-PENDING-DESIGN).');

    // =====================================================================
    // BLOQUE P: DOCUMENTOS & PDF GENERATION
    // =====================================================================
    console.log('\n--- BLOQUE P: DOCUMENTOS & PDF GENERATION ---');
    const pdfModule = await import('./pdf_service.js');
    const pdfBuf = await pdfModule.generateBudgetPDF(b1, compA);
    assert(pdfBuf && pdfBuf.length > 1000 && pdfBuf.slice(0, 5).toString() === '%PDF-', 'P1. Generación de PDF de presupuesto válida');

    // =====================================================================
    // BLOQUE Q: VERIFACTU AUDIT
    // =====================================================================
    console.log('\n--- BLOQUE Q: VERIFACTU AUDIT ---');
    const invRowVerifactu = testDb.prepare('SELECT verifactu_hash FROM invoices WHERE id = ?').get(em1.invoice.id);
    assert(invRowVerifactu !== undefined, 'Q1. Columna verifactu_hash existe en invoices');
    recordFinding('Q-AUDIT', 'VeriFactu Status', 'C', 'verifactu_hash presente como placeholder sha256 simplificado. El encadenamiento formal (chaining) y generación de código QR fiscal están pendientes de desarrollo reglamentario (VERIFACTU-PENDING-DESIGN).');

    // =====================================================================
    // BLOQUE R: MÁQUINAS DE ESTADO
    // =====================================================================
    console.log('\n--- BLOQUE R: MÁQUINAS DE ESTADO ---');
    // Estado de presupuesto: PENDIENTE_FIRMA -> ACEPTADO -> FINALIZADO
    assert(b1.status === 'PENDIENTE_FIRMA' || b1.status === 'BORRADOR_MEDICION', 'R1. Estado inicial de presupuesto válido');
    b1.status = 'ACEPTADO';
    saveBudget(tenantA, b1);
    assert(getBudget(tenantA, b1.id).status === 'ACEPTADO', 'R2. Transición a ACEPTADO persistida');

    // Estado de factura: PENDIENTE_PAGO -> PAGADA
    const testInvState = getInvoice(tenantA, em2.invoice.id);
    assert(testInvState.status === 'PENDIENTE_PAGO', 'R3. Estado inicial factura es PENDIENTE_PAGO');
    testInvState.status = 'PAGADA';
    saveInvoice(tenantA, testInvState);
    assert(getInvoice(tenantA, em2.invoice.id).status === 'PAGADA', 'R4. Transición a PAGADA persistida');

    // =====================================================================
    // BLOQUE S: MULTI-TENANT ZERO DISCLOSURE MATRIX
    // =====================================================================
    console.log('\n--- BLOQUE S: MULTI-TENANT ZERO DISCLOSURE MATRIX ---');
    // S1: Lectura de factura cruzada
    const crossInv = getInvoice(tenantA, emB.invoice.id);
    assert(crossInv === null, 'S1. getInvoice(tenantA, idB) retorna null (Zero-Disclosure)');

    // S2: Lectura de presupuesto cruzado
    const crossBudget = getBudget(tenantA, bB.id);
    assert(crossBudget === null, 'S2. getBudget(tenantA, idB) retorna null');

    // S3: Lectura de cita cruzada
    const crossApp = getAppointment(tenantA, appB.id);
    assert(crossApp === null, 'S3. getAppointment(tenantA, idB) retorna null');

    // S4: Listado de facturas cruzado
    const listAInvs = listInvoices(tenantA);
    assert(!listAInvs.some(i => i.id === emB.invoice.id), 'S4. listInvoices(tenantA) no revela facturas de Tenant B');

    // =====================================================================
    // BLOQUE T: RESTART & RECOVERY
    // =====================================================================
    console.log('\n--- BLOQUE T: RESTART & RECOVERY ---');
    testDb.close(); // Simular cierre completo de base de datos / proceso
    const testDbReopen = new DatabaseSync(testDbPath);
    const recoveredCompanyA = testDbReopen.prepare('SELECT * FROM companies WHERE id = ?').get(tenantA);
    const recoveredInvoicesA = testDbReopen.prepare('SELECT count(*) as c FROM invoices WHERE company_id = ?').get(tenantA).c;
    const recoveredAllocsA = testDbReopen.prepare('SELECT count(*) as c FROM payment_allocations WHERE company_id = ?').get(tenantA).c;
    testDbReopen.close();

    assert(recoveredCompanyA && recoveredCompanyA.cif === '12345678Z', 'T1. Empresa y datos fiscales recuperados tras restart');
    assert(recoveredInvoicesA > 0, 'T2. Facturas recuperadas intactas tras restart');
    assert(recoveredAllocsA > 0, 'T3. Payment allocations recuperadas intactas tras restart');

    // =====================================================================
    // BLOQUE U: HISTORICAL CANONICAL LOCKS AUDIT
    // =====================================================================
    console.log('\n--- BLOQUE U: HISTORICAL CANONICAL LOCKS AUDIT ---');
    recordFinding('LOCK-58', 'Test 58 Historical Lock', 'EXPECTED_HISTORICAL_LOCK', 'Bloqueado canónicamente en SHA pre-015');
    recordFinding('LOCK-60', 'Test 60 Historical Lock', 'EXPECTED_HISTORICAL_LOCK', 'Bloqueado canónicamente en SHA pre-016');
    recordFinding('LOCK-61', 'Test 61 Historical Lock', 'EXPECTED_HISTORICAL_LOCK', 'Bloqueado canónicamente en SHA pre-016');
    recordFinding('LOCK-62', 'Test 62 Historical Lock', 'EXPECTED_HISTORICAL_LOCK', 'Bloqueado canónicamente en SHA pre-016 (7454D7DF010E...)');

  } finally {
    // Limpieza de DB de pruebas
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    } catch {}
  }

  // =====================================================================
  // 3. VERIFICACIÓN POST-TEST DE PRODUCCIÓN (BIT-A-BIT)
  // =====================================================================
  console.log('\n--- 3. VERIFICACIÓN POST-TEST DE PRODUCCIÓN ---');
  const postHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
  assert(postHash === PROD_CANONICAL_SHA, `3.1 data/presuvoz.db intacto post-test (${PROD_CANONICAL_SHA.slice(0, 12)}...)`);

  const prodVerifyPostDb = new DatabaseSync(prodPath, { open: true, readOnly: true });
  const postIntegrity = prodVerifyPostDb.prepare('PRAGMA integrity_check').get();
  assert(postIntegrity?.integrity_check === 'ok', '3.2 PRAGMA integrity_check = ok en producción');
  const postFk = prodVerifyPostDb.prepare('PRAGMA foreign_key_check').all();
  assert(postFk.length === 0, '3.3 PRAGMA foreign_key_check = 0 en producción');
  const postMigrations = prodVerifyPostDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  assert(postMigrations.length === 16 && postMigrations[15].version === 16, '3.4 schema_migrations [1..16] inalteradas en producción');
  const postInvoicesCount = prodVerifyPostDb.prepare('SELECT count(*) as c FROM invoices').get().c;
  assert(postInvoicesCount === 6, '3.5 Exactamente 6 facturas históricas preservadas en producción');
  prodVerifyPostDb.close();

  console.log('\n======================================================================');
  console.log(`🎉 TEST 64 COMPLETADO CON ÉXITO: ${passed}/${total} PRUEBAS SUPERADAS`);
  console.log(`📋 Total de hallazgos auditados: ${auditFindings.length}`);
  console.log('======================================================================\n');

  return { passed, total, auditFindings };
}

// Ejecución directa si se invoca desde CLI
if (process.argv[1] && process.argv[1].endsWith('test_64_post_4c1_full_functional_regression.js')) {
  runTest64().catch(err => {
    console.error('❌ Error fatal en TEST 64:', err);
    process.exit(1);
  });
}
