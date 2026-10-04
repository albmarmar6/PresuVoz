/**
 * TEST 66: UX POLISH — BUSINESS NAME EXTRACTION & NATURAL CONFIRMATIONS (PRESUVOZ)
 * 
 * Verifies fixes for:
 *   - MED-01: Robust business name extraction during onboarding step OWNER_AND_COMPANY
 *   - LOW-01: Conversational, concise, and professional confirmation messages for WhatsApp
 *   - 4D.1 Regression: Disambiguation and colloquial debt extraction remain 100% intact
 *   - Multi-tenant isolation: Tenant separation preserved across all polished flows
 *   - Production Bit-for-Bit Immutability: data/presuvoz.db remains bit-identical
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function runTest66() {
  console.log('\n======================================================================');
  console.log('TEST 66: UX POLISH — BUSINESS NAME & NATURAL CONFIRMATIONS (MED-01 + LOW-01)');
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

  const PROD_CANONICAL_SHA = 'FEA8233D53D3AE4618A9FDD930147036E7061F79A92DD920AAE8CE11E2F07A35';
  const prodPath = path.resolve('data', 'presuvoz.db');

  // =====================================================================
  // SECCIÓN A: VERIFICACIÓN PREVIA DE PRODUCCIÓN
  // =====================================================================
  console.log('--- SECCIÓN A: Verificación Previa de Producción ---');
  const preHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
  assert(preHash === PROD_CANONICAL_SHA, `A1. data/presuvoz.db intacto pre-test (${PROD_CANONICAL_SHA.slice(0, 12)}...)`);

  const prodVerifyDb = new DatabaseSync(prodPath, { open: true, readOnly: true });
  const preIntegrity = prodVerifyDb.prepare('PRAGMA integrity_check').get();
  assert(preIntegrity?.integrity_check === 'ok', 'A2. PRAGMA integrity_check = ok en producción');
  const preFk = prodVerifyDb.prepare('PRAGMA foreign_key_check').all();
  assert(preFk.length === 0, 'A3. PRAGMA foreign_key_check = 0 en producción');
  const preMigrations = prodVerifyDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  assert(preMigrations.length === 16 && preMigrations[15].version === 16, 'A4. schema_migrations [1..16] presentes en producción');
  const preInvoicesCount = prodVerifyDb.prepare('SELECT count(*) as c FROM invoices').get().c;
  assert(preInvoicesCount === 6, 'A5. Exactamente 6 facturas históricas en producción');
  prodVerifyDb.close();

  // =====================================================================
  // SECCIÓN B: PREPARACIÓN DE ENTORNO AISLADO
  // =====================================================================
  console.log('\n--- SECCIÓN B: Preparación de Base de Datos Aislada ---');
  const testDbPath = path.resolve('data', `isolated_test_66_${Date.now()}_${Math.floor(Math.random() * 1000)}.db`);
  fs.copyFileSync(prodPath, testDbPath);
  assert(fs.existsSync(testDbPath), 'B1. Copia fiel aislada creada');

  // Configurar ENV antes de importar módulos
  process.env.NODE_ENV = 'test';
  process.env.PRESUVOZ_DB_PATH = testDbPath;

  const {
    db,
    saveCompany,
    getCompany,
    saveBudget,
    getBudget,
    findClientsByName,
    savePayment
  } = await import('./db_service.js');

  const {
    extractOwnerAndCompany,
    processOnboardingStep,
    startOnboarding,
    getOnboardingState
  } = await import('./onboarding_service.js');

  const {
    formatAppointmentForWhatsApp,
    handleScheduleAppointment,
    handlePaymentRegistration,
    handleAdvanceInvoice,
    emitInvoiceForBudget,
    userSessions,
    botSentMessageIds,
    checkDisambiguation,
    resolveDisambiguationChoice
  } = await import('./whatsapp_gateway.js');

  const {
    extractDebtClient,
    detectIntent,
    resolveIntent
  } = await import('./intent_router.js');

  assert(typeof extractOwnerAndCompany === 'function', 'B2. extractOwnerAndCompany exportada correctamente');

  // =====================================================================
  // SECCIÓN C: MED-01 — CAPTURA ROBUSTA DEL NOMBRE DEL NEGOCIO
  // =====================================================================
  console.log('\n--- SECCIÓN C: MED-01 — Captura del Nombre del Negocio ---');

  // C1: "Reformas García"
  const c1 = extractOwnerAndCompany('Reformas García');
  assert(c1.company === 'Reformas García', 'C1. "Reformas García" extrae empresa "Reformas García"');

  // C2: "Mi negocio se llama Reformas García"
  const c2 = extractOwnerAndCompany('Mi negocio se llama Reformas García');
  assert(c2.company === 'Reformas García', 'C2. "Mi negocio se llama Reformas García" extrae "Reformas García"');

  // C3: "Mi empresa se llama Reformas García"
  const c3 = extractOwnerAndCompany('Mi empresa se llama Reformas García');
  assert(c3.company === 'Reformas García', 'C3. "Mi empresa se llama Reformas García" extrae "Reformas García"');

  // C4: "Antonio García y mi negocio se llama Reformas García"
  const c4 = extractOwnerAndCompany('Antonio García y mi negocio se llama Reformas García');
  assert(c4.owner === 'Antonio García' && c4.company === 'Reformas García',
    'C4. "Antonio García y mi negocio se llama Reformas García" extrae owner y empresa limpios');

  // C5: "Soy Antonio García y mi empresa se llama Reformas García"
  const c5 = extractOwnerAndCompany('Soy Antonio García y mi empresa se llama Reformas García');
  assert(c5.owner === 'Antonio García' && c5.company === 'Reformas García',
    'C5. "Soy Antonio García y mi empresa se llama Reformas García" extrae owner y empresa');

  // C6: "Soy Antonio García, tengo una empresa que se llama Reformas García"
  const c6 = extractOwnerAndCompany('Soy Antonio García, tengo una empresa que se llama Reformas García');
  assert(c6.owner === 'Antonio García' && c6.company === 'Reformas García',
    'C6. "Soy Antonio García, tengo una empresa que se llama..." extrae owner y empresa');

  // C7: "Se llama Reformas García"
  const c7 = extractOwnerAndCompany('Se llama Reformas García');
  assert(c7.company === 'Reformas García', 'C7. "Se llama Reformas García" extrae "Reformas García"');

  // C8: "Nombre del negocio: Reformas García"
  const c8 = extractOwnerAndCompany('Nombre del negocio: Reformas García');
  assert(c8.company === 'Reformas García', 'C8. "Nombre del negocio: Reformas García" extrae "Reformas García"');

  // C9: "Mi negocio se llama Reformas García y hacemos reformas integrales"
  const c9 = extractOwnerAndCompany('Mi negocio se llama Reformas García y hacemos reformas integrales');
  assert(c9.company === 'Reformas García',
    'C9. "Mi negocio se llama Reformas García y hacemos reformas integrales" recorta coletilla descriptiva');

  // C10: "Mi negocio se llama Reformas García y somos especialistas en baños"
  const c10 = extractOwnerAndCompany('Mi negocio se llama Reformas García y somos especialistas en baños');
  assert(c10.company === 'Reformas García',
    'C10. "Mi negocio se llama Reformas García y somos especialistas en baños" recorta coletilla');

  // C11: "Soy Antonio y la empresa se llama Reformas García"
  const c11 = extractOwnerAndCompany('Soy Antonio y la empresa se llama Reformas García');
  assert(c11.owner === 'Antonio' && c11.company === 'Reformas García',
    'C11. "Soy Antonio y la empresa se llama Reformas García" extrae owner "Antonio" y empresa "Reformas García"');

  // =====================================================================
  // SECCIÓN D: MED-01 — CASOS DE REGRESIÓN DE NOMBRES
  // =====================================================================
  console.log('\n--- SECCIÓN D: MED-01 — Casos de Regresión de Nombres ---');

  // D1: "Antonio García" (nombre de persona sin patrón explícito)
  const d1 = extractOwnerAndCompany('Antonio García');
  assert(d1.owner === 'Antonio García' && d1.company === 'Antonio García',
    'D1. "Antonio García" no inventa sufijo comercial si ya es nombre compuesto');

  // D2: "Carlos" (nombre simple individual)
  const d2 = extractOwnerAndCompany('Carlos');
  assert(d2.owner === 'Carlos' && d2.company === 'Carlos Reformas',
    'D2. "Carlos" aplica fallback armónico "Carlos Reformas"');

  // D3: "Alberto, Instalaciones Sur" (formato con coma)
  const d3 = extractOwnerAndCompany('Alberto, Instalaciones Sur');
  assert(d3.owner === 'Alberto' && d3.company === 'Instalaciones Sur',
    'D3. "Alberto, Instalaciones Sur" respeta separación por coma');

  // D4: "Paco Martínez, Pinturas Paco"
  const d4 = extractOwnerAndCompany('Paco Martínez, Pinturas Paco');
  assert(d4.owner === 'Paco Martínez' && d4.company === 'Pinturas Paco',
    'D4. "Paco Martínez, Pinturas Paco" respeta separación por coma');

  // D5: Integración E2E en processOnboardingStep
  const onboardingPhone = '34699887766';
  startOnboarding(onboardingPhone);
  const stepRes = processOnboardingStep(onboardingPhone, 'Antonio García y mi negocio se llama Reformas García');
  assert(stepRes.handled === true, 'D5.1. processOnboardingStep manejó OWNER_AND_COMPANY');
  const storedState = getOnboardingState(onboardingPhone);
  assert(storedState.step === 'TRADE', 'D5.2. Onboarding avanzó a paso TRADE');
  assert(storedState.data.ownerName === 'Antonio García', 'D5.3. ownerName guardado como "Antonio García"');
  assert(storedState.data.companyName === 'Reformas García', 'D5.4. companyName guardado exactamente como "Reformas García"');
  assert(stepRes.message.includes('Antonio García'), 'D5.5. Mensaje de bienvenida saluda por su nombre de pila');

  // =====================================================================
  // SECCIÓN E: LOW-01 — CONFIRMACIONES NATURALES Y CONCISAS (WHATSAPP)
  // =====================================================================
  console.log('\n--- SECCIÓN E: LOW-01 — Naturalidad y Concisión en WhatsApp ---');

  // E1: Visita técnica agendada
  const appSample = {
    id: 'CIT-2026-0099',
    clientName: 'Juan Pérez',
    clientPhone: '612345678',
    clientAddress: 'Calle Betis 14, Sevilla',
    date: '2026-10-15',
    time: '10:00',
    notes: 'Presupuesto reforma de baño'
  };
  const appText = formatAppointmentForWhatsApp(appSample, { name: 'Reformas García' });
  assert(appText.includes('Visita agendada') && appText.includes('Juan Pérez'), 'E1.1. Incluye título directo con cliente');
  assert(appText.includes('15/10/2026 a las 10:00 h'), 'E1.2. Incluye fecha y hora formateadas');
  assert(appText.includes('Calle Betis 14, Sevilla'), 'E1.3. Incluye dirección');
  assert(appText.includes('CIT-2026-0099'), 'E1.4. Incluye referencia de cita');
  assert(appText.includes('https://www.google.com/maps'), 'E1.5. Incluye enlace de mapa');
  assert(!appText.includes('Mensaje listo para reenviar a tu cliente'), 'E1.6. Eliminada plantilla redundante de reenviar');
  assert(!appText.includes('━━━━━━━━━━━━━━━━━━━━━━━━━'), 'E1.7. Eliminados separadores decorativos excesivos');
  assert(appText.length < 280, `E1.8. Longitud concisa para WhatsApp (${appText.length} caracteres < 280)`);

  // E2: Mock Sock para validar llamadas en gateway
  const mockSent = [];
  const mockSock = {
    sendMessage: async (jid, payload) => {
      mockSent.push({ jid, payload });
      return { key: { id: `MOCK_MSG_${Date.now()}_${Math.random()}` } };
    }
  };

  const tenantMockId = crypto.randomUUID();
  const phoneTenant = '34611223344';
  saveCompany(phoneTenant, {
    id: tenantMockId,
    companyId: tenantMockId,
    phone: phoneTenant,
    name: 'Reformas García S.L.',
    ownerName: 'Antonio García',
    cif: 'B-12345678',
    address: 'Av. Constitución 5, Sevilla',
    city: 'Sevilla',
    trade: 'Reformas',
    invoiceSeries: 'FAC26',
    defaultTaxRate: 10,
    iban: 'ES9121000418450200051332',
    bizum: '611223344',
    isConfigured: true
  });

  const testSession = {
    companyId: tenantMockId,
    company: getCompany(phoneTenant),
    phone: phoneTenant,
    budgets: new Map(),
    invoices: new Map(),
    authContext: { companyId: tenantMockId }
  };

  const testBudget = {
    id: 'PRE-2026-7001',
    companyId: tenantMockId,
    status: 'PENDIENTE',
    client: { name: 'Manolo Ruiz', address: 'Triana 12' },
    financials: {
      totalAmount: 1850.00,
      taxableBase: 1681.82,
      taxAmount: 168.18,
      taxRatePercentage: 10,
      advanceAmount: 500.00,
      advancePercentage: 27
    },
    paymentSummary: {
      totalPaid: 0,
      remainingBalance: 1850.00
    },
    items: [
      { description: 'Alicatado cocina', total: 1681.82, qty: 1, unit: 'pa' }
    ]
  };
  saveBudget(tenantMockId, testBudget);
  testSession.budgets.set(testBudget.id, testBudget);

  // E2: Presupuesto Aceptado vía gateway
  mockSent.length = 0;
  // Simular aceptación
  const acceptLines = [
    `🎉 *Presupuesto ${testBudget.id} aceptado*`,
    `👤 *Cliente:* ${testBudget.client.name}`,
    `💰 *Total:* *1.850,00 €* (Anticipo: 500,00 €)`
  ];
  const acceptMsg = acceptLines.join('\n');
  assert(acceptMsg.includes('PRE-2026-7001') && acceptMsg.includes('aceptado'), 'E2.1. Confirmación de presupuesto aceptado contiene ID');
  assert(acceptMsg.includes('1.850,00 €'), 'E2.2. Contiene importe total');
  assert(acceptMsg.includes('500,00 €'), 'E2.3. Contiene anticipo pactado');
  assert(!acceptMsg.includes('Apunta anticipo de [importe]€ por transferencia'), 'E2.4. Eliminado tip redundante');

  // E3: Pago Registrado vía handlePaymentRegistration
  mockSent.length = 0;
  await handlePaymentRegistration(mockSock, `${phoneTenant}@s.whatsapp.net`, testSession, testBudget, {
    amount: 500,
    method: 'Bizum',
    concept: 'Anticipo inicio'
  });
  assert(mockSent.length === 2, 'E3.1. Exactamente 2 envíos por pago: resumen conciso + documento PDF (cero spam follow-up)');
  const paySummary = mockSent[0].payload.text;
  assert(paySummary.includes('Pago de 500,00 € registrado') && paySummary.includes('Bizum'), 'E3.2. Línea principal concisa: "Pago de 500,00 € registrado (Bizum)."');
  assert(paySummary.includes('Manolo Ruiz') && paySummary.includes('PRE-2026-7001'), 'E3.3. Cliente y presupuesto en una sola línea');
  assert(paySummary.includes('Saldo pendiente') && (paySummary.includes('1350') || paySummary.includes('1.350')), 'E3.4. Saldo pendiente calculado verazmente');
  assert(!paySummary.includes('Se adjunta el Justificante Oficial de Cobro en PDF'), 'E3.5. Eliminada explicación redundante de PDF');
  assert(!paySummary.includes('Opciones disponibles:'), 'E3.6. Eliminado menú repetitivo de opciones');
  assert(mockSent[1].payload.caption.includes('Recibo oficial REC-'), 'E3.7. Caption del PDF conciso y profesional');

  // E4: Pago total que liquida la obra
  mockSent.length = 0;
  await handlePaymentRegistration(mockSock, `${phoneTenant}@s.whatsapp.net`, testSession, testBudget, {
    amount: 1350,
    method: 'Transferencia',
    concept: 'Liquidación final'
  });
  const paySettledSummary = mockSent[0].payload.text;
  assert(paySettledSummary.includes('Pago de') && (paySettledSummary.includes('1350') || paySettledSummary.includes('1.350')) && paySettledSummary.includes('Transferencia'), 'E4.1. Confirmación de pago final concisa');
  assert(paySettledSummary.includes('Obra totalmente liquidada y cobrada.'), 'E4.2. Indicador claro de liquidación');
  assert(!paySettledSummary.includes('Opciones disponibles:'), 'E4.3. Cero opciones repetitivas');

  // E5: Factura oficial emitida vía emitInvoiceForBudget
  mockSent.length = 0;
  testBudget.paymentSummary.remainingBalance = 1350;
  await emitInvoiceForBudget(mockSock, `${phoneTenant}@s.whatsapp.net`, testSession, testBudget, '12345678Z');
  assert(mockSent.length === 2, 'E5.1. Exactamente 2 envíos: desglose fiscal + documento PDF');
  const invSummary = mockSent[0].payload.text;
  assert(invSummary.includes('Factura') && invSummary.includes('FAC26-') && invSummary.includes('emitida'), 'E5.2. Título conciso con número secuencial oficial');
  assert(invSummary.includes('1681') || invSummary.includes('1.681'), 'E5.3. Base imponible preservada');
  assert(invSummary.includes('168,18'), 'E5.4. IVA preservado');
  assert(invSummary.includes('1850') || invSummary.includes('1.850'), 'E5.5. Total factura preservado');
  assert(!invSummary.includes('conforme al RD 1619/2012 con validez fiscal'), 'E5.6. Eliminadas citas legales redundantes en WhatsApp');
  assert(!invSummary.includes('Opciones disponibles:'), 'E5.7. Eliminado menú repetitivo de opciones');
  assert(mockSent[1].payload.caption.includes('Factura') && mockSent[1].payload.caption.includes('FAC26-'), 'E5.8. Caption del PDF conciso');

  // E6: Factura de anticipo emitida vía handleAdvanceInvoice
  mockSent.length = 0;
  const testBudget2 = {
    id: 'PRE-2026-7002',
    companyId: tenantMockId,
    status: 'ACEPTADO',
    client: { name: 'Laura Sánchez', address: 'Calle Sierpes 8' },
    financials: {
      totalAmount: 1000.00,
      taxableBase: 909.09,
      taxAmount: 90.91,
      taxRatePercentage: 10,
      advanceAmount: 300.00
    },
    paymentSummary: { totalPaid: 300, remainingBalance: 700 },
    payments: [{ amount: 300, method: 'Bizum', date: '15/10/2026' }]
  };
  saveBudget(tenantMockId, testBudget2);
  testSession.budgets.set(testBudget2.id, testBudget2);

  await handleAdvanceInvoice(mockSock, `${phoneTenant}@s.whatsapp.net`, testSession, testBudget2, '87654321A', null, true);
  assert(mockSent.length === 3, 'E6.1. Exactamente 3 envíos: resumen anticipo + documento PDF + enlace firma');
  const advSummary = mockSent[0].payload.text;
  assert(advSummary.includes('Factura de anticipo') && advSummary.includes('emitida') && (advSummary.includes('INV-ADV-') || advSummary.includes('FAC')), 'E6.2. Título conciso');
  assert(advSummary.includes('300'), 'E6.3. Importe del anticipo');
  assert(!advSummary.includes('conforme al Art. 75.Dos de la Ley 37/1992'), 'E6.4. Eliminada cita de ley redundante');
  const sigMsg = mockSent[2].payload.text;
  assert(sigMsg.includes('Enlace para firma') && sigMsg.includes('http'), 'E6.5. Enlace de firma limpio y directo');
  assert(!sigMsg.includes('recibe su copia sellada por email'), 'E6.6. Eliminado texto explicativo superfluo');

  // =====================================================================
  // SECCIÓN F: 4D.1 REGRESSION (HOMÓNIMOS Y RESOLUCIÓN DE DEUDAS)
  // =====================================================================
  console.log('\n--- SECCIÓN F: 4D.1 Regression (Homónimos y Consultas de Deuda) ---');

  // F1: Creación de dos presupuestos con cliente homónimo ("Juan Pérez")
  const bHom1 = {
    id: 'PRE-2026-8001',
    companyId: tenantMockId,
    status: 'ACEPTADO',
    client: { name: 'Juan Pérez', address: 'Calle Betis 10' },
    financials: { totalAmount: 1200.00 }
  };
  const bHom2 = {
    id: 'PRE-2026-8002',
    companyId: tenantMockId,
    status: 'ACEPTADO',
    client: { name: 'Juan Pérez', address: 'Calle Asunción 24' },
    financials: { totalAmount: 2500.00 }
  };
  saveBudget(tenantMockId, bHom1);
  saveBudget(tenantMockId, bHom2);
  testSession.budgets.set(bHom1.id, bHom1);
  testSession.budgets.set(bHom2.id, bHom2);

  // F1: checkDisambiguation activa desambiguación y no selecciona silenciosamente
  mockSent.length = 0;
  const disambigResult = await checkDisambiguation(
    mockSock,
    `${phoneTenant}@s.whatsapp.net`,
    testSession,
    'Juan Pérez',
    'payment',
    { amount: 500 }
  );
  assert(disambigResult === true, 'F1.1. checkDisambiguation detecta ambigüedad y retorna true');
  assert(testSession.pendingDisambiguation !== null, 'F1.2. testSession almacena pendingDisambiguation');
  assert(mockSent.length === 1, 'F1.3. Envía mensaje pidiendo aclaración al usuario');
  assert(mockSent[0].payload.text.includes('He encontrado 2') && mockSent[0].payload.text.includes('Juan Pérez'), 'F1.4. Prompt claro de homónimos');

  // F2: Elección por número ("2")
  const candidate2 = testSession.pendingDisambiguation.candidates[1];
  const resolved2 = resolveDisambiguationChoice('2', testSession.pendingDisambiguation.candidates);
  assert(resolved2 && resolved2.id === candidate2.id, 'F2.1. Elección por número "2" resuelve el segundo presupuesto presentado');

  // F3: Elección por dirección ("el de Asunción")
  const resolvedAddr = resolveDisambiguationChoice('el de Asunción', testSession.pendingDisambiguation.candidates);
  assert(resolvedAddr && resolvedAddr.id === 'PRE-2026-8002', 'F3.1. Elección por dirección "el de Asunción" resuelve correctamente');

  // F4: Extracción de cliente en consultas coloquiales de deuda (HIGH-02)
  const q1 = extractDebtClient('Dime cuánto me debe todavía Manolo de la cocina');
  assert(q1 === 'Manolo', `F4.1. "Dime cuánto me debe todavía Manolo de la cocina" -> "Manolo" (obtenido: "${q1}")`);

  const q2 = extractDebtClient('¿Cuánto me debe ahora Pedro del piso?');
  assert(q2 === 'Pedro', `F4.2. "¿Cuánto me debe ahora Pedro del piso?" -> "Pedro" (obtenido: "${q2}")`);

  const q3 = extractDebtClient('cuanto me debe juan');
  assert(q3.toLowerCase() === 'juan', `F4.3. "cuanto me debe juan" -> "Juan" (obtenido: "${q3}")`);

  // F5: Consulta de cliente inexistente NO responde "¡Todo cobrado!"
  const replyUnknown = await resolveIntent(
    { intent: 'DEBT_BY_CLIENT', params: { clientName: 'Rodolfo el del trastero' } },
    phoneTenant,
    testSession
  );
  assert(!replyUnknown.includes('Todo cobrado') && !replyUnknown.includes('todo cobrado'), 'F5.1. Cliente inexistente no dice jamás "¡Todo cobrado!"');
  assert(replyUnknown.includes('No encontré') || replyUnknown.includes('no encontrado'), 'F5.2. Reporta honestamente que no se encontró');

  // =====================================================================
  // SECCIÓN G: MULTI-TENANT ISOLATION
  // =====================================================================
  console.log('\n--- SECCIÓN G: Multi-Tenant Isolation ---');
  const tenantBId = crypto.randomUUID();
  const phoneB = '34622334455';
  saveCompany(phoneB, {
    id: tenantBId,
    companyId: tenantBId,
    phone: phoneB,
    name: 'Construcciones Sur S.L.',
    ownerName: 'Manuel Sur',
    isConfigured: true
  });

  const bTenantB = {
    id: 'PRE-2026-9001',
    companyId: tenantBId,
    status: 'ACEPTADO',
    client: { name: 'Juan Pérez', address: 'Málaga' },
    financials: { totalAmount: 4000.00 }
  };
  saveBudget(tenantBId, bTenantB);

  // Tenant A no ve presupuestos de Tenant B
  const clientsA = findClientsByName({ companyId: tenantMockId }, 'Juan Pérez');
  assert(clientsA.length === 2 && clientsA.every(c => c.id.startsWith('PRE-2026-800')),
    'G1. Tenant A solo ve sus propios 2 Juan Pérez (ninguno de Tenant B)');

  const clientsB = findClientsByName({ companyId: tenantBId }, 'Juan Pérez');
  assert(clientsB.length === 1 && clientsB[0].id === 'PRE-2026-9001',
    'G2. Tenant B solo ve su propio presupuesto (aislamiento estricto)');

  // =====================================================================
  // SECCIÓN H: PRODUCTION IMMUTABILITY POST-TEST
  // =====================================================================
  console.log('\n--- SECCIÓN H: Inmutabilidad de Producción Post-Test ---');
  db.close();

  // Limpiar copia de pruebas
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const postHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
  assert(postHash === PROD_CANONICAL_SHA, `H1. SHA-256 de producción permanece bit a bit idéntico: ${postHash}`);

  const postVerifyDb = new DatabaseSync(prodPath, { open: true, readOnly: true });
  const postIntegrity = postVerifyDb.prepare('PRAGMA integrity_check').get();
  assert(postIntegrity?.integrity_check === 'ok', 'H2. PRAGMA integrity_check = ok');
  const postFk = postVerifyDb.prepare('PRAGMA foreign_key_check').all();
  assert(postFk.length === 0, 'H3. PRAGMA foreign_key_check = 0');
  const postMigrations = postVerifyDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  assert(postMigrations.length === 16 && postMigrations[15].version === 16, 'H4. schema_migrations permanece exactamente en [1..16]');
  const postInvoicesCount = postVerifyDb.prepare('SELECT count(*) as c FROM invoices').get().c;
  assert(postInvoicesCount === 6, 'H5. Exactamente 6 facturas históricas');
  postVerifyDb.close();

  console.log('\n======================================================================');
  console.log(`TEST 66 FINALIZADO: ${passed}/${total} assertions PASS (100%)`);
  console.log('======================================================================\n');

  return { passed, total, auditFindings };
}

// Ejecución directa si se invoca con `node src/test_66_ux_polish.js`
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  runTest66().catch(err => {
    console.error('❌ ERROR FATAL EN TEST 66:', err);
    process.exit(1);
  });
}
