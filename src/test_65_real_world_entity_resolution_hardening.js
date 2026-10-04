/**
 * TEST 65: REAL-WORLD ENTITY RESOLUTION & DISAMBIGUATION HARDENING (PRESUVOZ)
 * 
 * Verifies fixes for:
 *   - HIGH-01: Disambiguation of homonyms in direct commands & AI dispatch (zero silent selection)
 *   - HIGH-02: Clean client extraction in colloquial debt queries (zero noisy strings & zero false financial answers)
 *
 * Strict zero-write policy on production data/presuvoz.db.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function runTest65() {
  console.log('\n======================================================================');
  console.log('TEST 65: REAL-WORLD ENTITY RESOLUTION HARDENING (HIGH-01 + HIGH-02)');
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
  const testDbPath = path.resolve('data', `isolated_test_65_${Date.now()}_${Math.floor(Math.random() * 1000)}.db`);
  fs.copyFileSync(prodPath, testDbPath);
  assert(fs.existsSync(testDbPath), 'B1. Copia fiel aislada creada');

  // Configurar ENV antes de importar módulos
  process.env.NODE_ENV = 'test';
  process.env.PRESUVOZ_DB_PATH = testDbPath;

  const {
    db,
    saveCompany,
    saveBudget,
    getBudget,
    findClientsByName,
    savePayment
  } = await import('./db_service.js');

  const {
    formatDisambiguationPrompt
  } = await import('./secretary_service.js');

  const {
    extractDebtClient,
    detectIntent,
    resolveIntent
  } = await import('./intent_router.js');

  const {
    checkDisambiguation,
    resolveDisambiguationChoice,
    findBudgetInSession
  } = await import('./whatsapp_gateway.js');

  // Setup mock tenant
  const tenantAId = crypto.randomUUID();
  const phoneA = '34677112233';
  saveCompany(phoneA, {
    id: tenantAId,
    companyId: tenantAId,
    phone: phoneA,
    name: 'Reformas Martínez S.L.',
    ownerName: 'Antonio Martínez',
    cif: 'B-11223344',
    address: 'Calle Real 1, Madrid',
    city: 'Madrid',
    trade: 'Reformas',
    invoiceSeries: 'RM26',
    defaultTaxRate: 21,
    isConfigured: true
  });

  const tenantContextA = { companyId: tenantAId, phone: phoneA };

  // Helper mock socket
  function createMockSock() {
    const sentMessages = [];
    return {
      sentMessages,
      sendMessage: async (jid, content) => {
        sentMessages.push({ jid, content });
        return { key: { id: `mock_msg_${Date.now()}_${Math.random()}` } };
      }
    };
  }

  // =====================================================================
  // SECCIÓN C: DETECCIÓN DE HOMÓNIMOS EN COMANDOS DIRECTOS (HIGH-01)
  // =====================================================================
  console.log('\n--- SECCIÓN C: Detección de Homónimos en Comandos Directos (HIGH-01) ---');

  // Crear dos clientes homónimos para Tenant A
  const budget1 = {
    id: 'PRE-2026-JUAN-01',
    companyId: tenantAId,
    client: { name: 'Juan García', address: 'Calle Triana 5, Sevilla', phone: '611222333' },
    items: [{ description: 'Reforma de cocina', total: 3000 }],
    financials: { totalAmount: 3000, advanceAmount: 900, remainingAmount: 2100 },
    status: 'PENDIENTE_ACEPTACION',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveBudget(tenantContextA, budget1);

  const budget2 = {
    id: 'PRE-2026-JUAN-02',
    companyId: tenantAId,
    client: { name: 'Juan Pérez', address: 'Avenida Constitución 12, Sevilla', phone: '622333444' },
    items: [{ description: 'Pintura general piso', total: 1500 }],
    financials: { totalAmount: 1500, advanceAmount: 450, remainingAmount: 1050 },
    status: 'PENDIENTE_ACEPTACION',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveBudget(tenantContextA, budget2);

  const mockSession = {
    phone: phoneA,
    companyId: tenantAId,
    authContext: tenantContextA,
    budgets: new Map([
      [budget1.id, budget1],
      [budget2.id, budget2]
    ]),
    activeBudgetId: null,
    pendingDisambiguation: null
  };

  const mockSock = createMockSock();

  // Test 1: checkDisambiguation para "Juan" debe detectar 2 candidatos y retornar true
  const disResult = await checkDisambiguation(mockSock, `${phoneA}@s.whatsapp.net`, mockSession, 'Juan', 'query_balance');
  assert(disResult === true, 'C1. checkDisambiguation retorna true al haber 2 candidatos');
  assert(mockSession.pendingDisambiguation !== null, 'C2. session.pendingDisambiguation queda registrado');
  assert(mockSession.pendingDisambiguation.candidates.length === 2, 'C3. 2 candidatos exactos en pendingDisambiguation');
  assert(mockSock.sentMessages.length === 1, 'C4. Mensaje interactivo enviado al usuario por WhatsApp');
  assert(mockSock.sentMessages[0].content.text.includes('Juan García') && mockSock.sentMessages[0].content.text.includes('Juan Pérez'), 'C5. Mensaje lista ambos homónimos');

  // =====================================================================
  // SECCIÓN D: PROMPT INTERACTIVO DE DESAMBIGUACIÓN ADAPTADO
  // =====================================================================
  console.log('\n--- SECCIÓN D: Prompt Interactivo de Desambiguación Adaptado ---');
  const promptBalance = formatDisambiguationPrompt('Juan', mockSession.pendingDisambiguation.candidates, 'query_balance');
  assert(promptBalance.includes('¿De cuál de los dos deseas consultar el saldo?'), 'D1. Prompt adaptado para acción query_balance');

  const promptPayment = formatDisambiguationPrompt('Juan', mockSession.pendingDisambiguation.candidates, 'payment');
  assert(promptPayment.includes('¿A cuál de los dos corresponde este cobro?'), 'D2. Prompt adaptado para acción payment');

  const promptInvoice = formatDisambiguationPrompt('Juan', mockSession.pendingDisambiguation.candidates, 'invoice');
  assert(promptInvoice.includes('¿A cuál de los dos deseas emitirle la factura?'), 'D3. Prompt adaptado para acción invoice');

  // =====================================================================
  // SECCIÓN E: RESOLUCIÓN ROBUSTA DE ELECCIÓN DEL USUARIO (HIGH-01)
  // =====================================================================
  console.log('\n--- SECCIÓN E: Resolución Robusta de Elección del Usuario ---');
  const candidates = mockSession.pendingDisambiguation.candidates;

  const candidate1 = candidates[0];
  const candidate2 = candidates[1];
  const garciaCandidate = candidates.find(c => c.clientName.includes('García'));
  const perezCandidate = candidates.find(c => c.clientName.includes('Pérez'));

  // 1. Dígitos
  assert(resolveDisambiguationChoice('1', candidates)?.id === candidate1.id, 'E1. "1" resuelve al primer candidato presentado');
  assert(resolveDisambiguationChoice('2', candidates)?.id === candidate2.id, 'E2. "2" resuelve al segundo candidato presentado');
  assert(resolveDisambiguationChoice('el 1', candidates)?.id === candidate1.id, 'E3. "el 1" resuelve al primer candidato presentado');
  assert(resolveDisambiguationChoice('el 2', candidates)?.id === candidate2.id, 'E4. "el 2" resuelve al segundo candidato presentado');

  // 2. Ordinales
  assert(resolveDisambiguationChoice('el primero', candidates)?.id === candidate1.id, 'E5. "el primero" resuelve a candidate1');
  assert(resolveDisambiguationChoice('primero', candidates)?.id === candidate1.id, 'E6. "primero" resuelve a candidate1');
  assert(resolveDisambiguationChoice('el segundo', candidates)?.id === candidate2.id, 'E7. "el segundo" resuelve a candidate2');
  assert(resolveDisambiguationChoice('segundo', candidates)?.id === candidate2.id, 'E8. "segundo" resuelve a candidate2');

  // 3. Por Apellido
  assert(resolveDisambiguationChoice('el de Pérez', candidates)?.id === perezCandidate.id, 'E9. "el de Pérez" resuelve a Juan Pérez');
  assert(resolveDisambiguationChoice('Pérez', candidates)?.id === perezCandidate.id, 'E10. "Pérez" resuelve a Juan Pérez');
  assert(resolveDisambiguationChoice('el de García', candidates)?.id === garciaCandidate.id, 'E11. "el de García" resuelve a Juan García');
  assert(resolveDisambiguationChoice('García', candidates)?.id === garciaCandidate.id, 'E12. "García" resuelve a Juan García');

  // 4. Por Dirección
  assert(resolveDisambiguationChoice('el de Triana', candidates)?.id === garciaCandidate.id, 'E13. "el de Triana" resuelve a Juan García');
  assert(resolveDisambiguationChoice('Triana', candidates)?.id === garciaCandidate.id, 'E14. "Triana" resuelve a Juan García');
  assert(resolveDisambiguationChoice('Constitución', candidates)?.id === perezCandidate.id, 'E15. "Constitución" resuelve a Juan Pérez');

  // 5. Nombre + Dirección
  assert(resolveDisambiguationChoice('Juan García, el de Triana', candidates)?.id === garciaCandidate.id, 'E16. "Juan García, el de Triana" resuelve a Juan García');

  // 6. Elección inválida
  assert(resolveDisambiguationChoice('hola buenas tardes', candidates) === null, 'E17. Texto no relacionado retorna null');
  assert(resolveDisambiguationChoice('3', candidates) === null, 'E18. Número fuera de rango retorna null');

  // =====================================================================
  // SECCIÓN F: CLIENTE ÚNICO NO ACTIVA DESAMBIGUACIÓN INNECESARIA
  // =====================================================================
  console.log('\n--- SECCIÓN F: Cliente Único no Activa Desambiguación Innecesaria ---');
  const budgetUnique = {
    id: 'PRE-2026-CARMEN-01',
    companyId: tenantAId,
    client: { name: 'Carmen Morales', address: 'Calle Betis 20, Sevilla', phone: '633444555' },
    items: [{ description: 'Reparación de tejado', total: 800 }],
    financials: { totalAmount: 800, advanceAmount: 0, remainingAmount: 800 },
    status: 'PENDIENTE_ACEPTACION',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveBudget(tenantContextA, budgetUnique);
  mockSession.budgets.set(budgetUnique.id, budgetUnique);

  const mockSockUnique = createMockSock();
  const disUnique = await checkDisambiguation(mockSockUnique, `${phoneA}@s.whatsapp.net`, mockSession, 'Carmen', 'query_balance');
  assert(disUnique === false, 'F1. checkDisambiguation retorna false cuando sólo existe un cliente único');
  assert(mockSockUnique.sentMessages.length === 0, 'F2. Ningún mensaje de desambiguación emitido para cliente único');

  // =====================================================================
  // SECCIÓN G: EXTRACCIÓN ROBUSTA DE CLIENTE EN CONSULTAS COLOQUIALES DE DEUDA (HIGH-02)
  // =====================================================================
  console.log('\n--- SECCIÓN G: Extracción de Cliente en Consultas Coloquiales de Deuda (HIGH-02) ---');

  const knownNames = ['Manolo', 'Pedro', 'Carlos', 'Juan Carlos Pérez', 'María José', 'Ana María López', 'José Luis'];

  const testCasesColloquial = [
    { input: 'Dime cuánto me debe todavía Manolo de la cocina.', expected: 'Manolo', desc: 'Adverbio "todavía" + coletilla "de la cocina"' },
    { input: '¿Cuánto me debe todavía Manolo de la cocina?', expected: 'Manolo', desc: 'Pregunta interrogativa con adverbio y coletilla' },
    { input: '¿Cuánto me debe ahora Pedro del piso?', expected: 'Pedro', desc: 'Adverbio "ahora" + "del piso"' },
    { input: '¿Cuánto me debe aún Carlos de la obra?', expected: 'Carlos', desc: 'Adverbio "aún" + "de la obra"' },
    { input: '¿Cuánto me debe Manolo?', expected: 'Manolo', desc: 'Consulta directa simple' },
    { input: 'Dime lo que todavía me debe Manolo', expected: 'Manolo', desc: '"Dime lo que todavía me debe"' },
    { input: '¿Cuánto le queda por pagar a Manolo de la reforma?', expected: 'Manolo', desc: '"le queda por pagar a Manolo de la reforma"' },
    { input: '¿Qué me debe Pedro de la casa de Triana?', expected: 'Pedro', desc: '"Qué me debe Pedro de la casa"' },
    { input: '¿Cuánto falta por cobrarle a Carlos de la obra del centro?', expected: 'Carlos', desc: '"falta por cobrarle a Carlos"' },
    { input: 'Manolo todavía me debe 500, ¿no?', expected: 'Manolo', desc: 'Sujeto al inicio con importe y coletilla' },
    { input: 'Lo de Manolo de la cocina', expected: 'Manolo', desc: '"Lo de Manolo de la cocina"' },
    { input: '¿Cuánto me debe todavía Juan Carlos Pérez de la reforma?', expected: 'Juan Carlos Pérez', desc: 'Nombre compuesto de tres palabras' },
    { input: '¿Cuánto me debe María José de la cocina?', expected: 'María José', desc: 'Nombre compuesto de dos palabras' },
    { input: '¿Cuánto me debe Ana María López?', expected: 'Ana María López', desc: 'Nombre compuesto con apellido' },
    { input: '¿Cuánto me debe José Luis?', expected: 'José Luis', desc: 'Nombre compuesto común' }
  ];

  for (let i = 0; i < testCasesColloquial.length; i++) {
    const tc = testCasesColloquial[i];
    const extracted = extractDebtClient(tc.input, knownNames);
    assert(extracted === tc.expected, `G.${i + 1} ${tc.desc}: "${tc.input}" => "${tc.expected}"`);
  }

  // =====================================================================
  // SECCIÓN H: CASOS NEGATIVOS / DEUDA GLOBAL (CERO FALSOS POSITIVOS EN CLIENTE)
  // =====================================================================
  console.log('\n--- SECCIÓN H: Casos Negativos y Deuda Global ---');

  const negativeCases = [
    { input: '¿Cuánto me debe todavía?', desc: 'Sin cliente especificado' },
    { input: '¿Cuánto me debe el de la cocina?', desc: 'Referencia circunstancial sin nombre' },
    { input: '¿Cuánto me debe el cliente de la obra?', desc: 'Referencia genérica "el cliente"' },
    { input: '¿Cuánto me queda por cobrar?', desc: 'Consulta global de saldo' },
    { input: '¿Cuánto dinero me deben en total?', desc: 'Consulta global con "dinero en total"' },
    { input: '¿Quién me debe pasta?', desc: 'Consulta coloquial de deuda general' }
  ];

  for (let i = 0; i < negativeCases.length; i++) {
    const nc = negativeCases[i];
    const res = extractDebtClient(nc.input, knownNames);
    assert(res === null, `H.${i + 1} ${nc.desc}: "${nc.input}" => null (no asigna cliente fantasma)`);
  }

  // =====================================================================
  // SECCIÓN I: INTENT ROUTER - DETECCIÓN LIMPIA DE INTENCIÓN (HIGH-02)
  // =====================================================================
  console.log('\n--- SECCIÓN I: Intent Router - Detección Limpia de Intención (HIGH-02) ---');

  const det1 = detectIntent('Dime cuánto me debe todavía Manolo de la cocina.', { knownNames });
  assert(det1 !== null && det1.intent === 'DEBT_BY_CLIENT', 'I1. Intención detectada: DEBT_BY_CLIENT');
  assert(det1.params.clientName === 'Manolo', 'I2. Parámetro clientName es exactamente "Manolo", no "todavia manolo de la cocina"');

  const det2 = detectIntent('¿Cuánto me debe todavía?', { knownNames });
  assert(det2 === null || det2.intent === 'ALL_DEBTS', 'I3. "¿Cuánto me debe todavía?" no detecta cliente basura');

  const det3 = detectIntent('¿Quién me debe en total?', { knownNames });
  assert(det3 !== null && det3.intent === 'ALL_DEBTS', 'I4. "¿Quién me debe en total?" detecta ALL_DEBTS');

  // =====================================================================
  // SECCIÓN J: CERO RESPUESTAS FINANCIERAS FALSAS ("TODO COBRADO") (HIGH-02)
  // =====================================================================
  console.log('\n--- SECCIÓN J: Cero Respuestas Financieras Falsas ("Todo Cobrado") (HIGH-02) ---');

  // Caso 1: Cliente desconocido o inexistente -> NUNCA responder "todo cobrado"
  const replyUnknown = await resolveIntent(
    { intent: 'DEBT_BY_CLIENT', params: { clientName: 'Rigoberto Fantasma' } },
    phoneA,
    mockSession
  );
  assert(!replyUnknown.includes('Todo cobrado'), 'J1. Cliente desconocido NUNCA recibe respuesta "¡Todo cobrado!"');
  assert(replyUnknown.includes('No encontré ningún cliente ni presupuesto para *"Rigoberto Fantasma"*'), 'J2. Informa honestamente que no se encontró el cliente');

  // Caso 2: Cliente con deuda real (Presupuesto Juan García con saldo pendiente de 2.100 €)
  const replyDebt = await resolveIntent(
    { intent: 'DEBT_BY_CLIENT', params: { clientName: 'Juan García' } },
    phoneA,
    mockSession
  );
  assert(!replyDebt.includes('Todo cobrado'), 'J3. Cliente con saldo pendiente no recibe "Todo cobrado"');
  assert(replyDebt.includes('Total que te debe:') || replyDebt.includes('Saldo pendiente de cobro:'), 'J4. Muestra la deuda pendiente real');

  // Caso 3: Cliente con homónimos activa desambiguación interactiva desde resolveIntent
  const replyHomonym = await resolveIntent(
    { intent: 'DEBT_BY_CLIENT', params: { clientName: 'Juan' } },
    phoneA,
    mockSession
  );
  assert(replyHomonym.includes('He encontrado 2 clientes/obras para "Juan"'), 'J5. resolveIntent dispara desambiguación interactiva para homónimos');
  assert(mockSession.pendingDisambiguation !== null, 'J6. pendingDisambiguation registrado desde resolveIntent');

  // Caso 4: Cliente que REALMENTE existe y tiene saldo 0
  const budgetPaid = {
    id: 'PRE-2026-PAID-01',
    companyId: tenantAId,
    client: { name: 'Luis Completado', address: 'Calle Real 50, Sevilla', phone: '644555666' },
    items: [{ description: 'Cambio de cerradura', total: 100 }],
    financials: { totalAmount: 100, advanceAmount: 0, remainingAmount: 0 },
    status: 'ACEPTADO',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveBudget(tenantContextA, budgetPaid);
  savePayment(tenantContextA, {
    budgetId: budgetPaid.id,
    amount: 100,
    method: 'Efectivo',
    concept: 'Pago total trabajos'
  });

  const replyPaid = await resolveIntent(
    { intent: 'DEBT_BY_CLIENT', params: { clientName: 'Luis Completado' } },
    phoneA,
    mockSession
  );
  assert(replyPaid.includes('está al corriente de pago'), 'J7. Cliente que realmente existe y ha pagado todo recibe mensaje veraz de corriente de pago');

  // =====================================================================
  // SECCIÓN K: AISLAMIENTO MULTI-TENANT EN RESOLUCIÓN DE ENTIDADES
  // =====================================================================
  console.log('\n--- SECCIÓN K: Aislamiento Multi-Tenant en Resolución de Entidades ---');

  // Crear Tenant B con un cliente que también se llama "Juan García"
  const tenantBId = crypto.randomUUID();
  const phoneB = '34688990011';
  saveCompany(phoneB, {
    id: tenantBId,
    companyId: tenantBId,
    phone: phoneB,
    name: 'Pinturas Morales',
    ownerName: 'Paco Morales',
    cif: 'B-99881122',
    address: 'Calle Mayor 2, Valencia',
    city: 'Valencia',
    trade: 'Pintura',
    invoiceSeries: 'PM26',
    defaultTaxRate: 21,
    isConfigured: true
  });
  const tenantContextB = { companyId: tenantBId, phone: phoneB };

  const budgetTenantB = {
    id: 'PRE-2026-TENANTB-JUAN',
    companyId: tenantBId,
    client: { name: 'Juan García', address: 'Calle Colón 10, Valencia', phone: '655666777' },
    items: [{ description: 'Pintura fachada', total: 5000 }],
    financials: { totalAmount: 5000, advanceAmount: 0, remainingAmount: 5000 },
    status: 'PENDIENTE_ACEPTACION',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveBudget(tenantContextB, budgetTenantB);

  // Buscar clientes "Juan García" en Tenant A: solo debe devolver el de Tenant A (Triana), jamás el de Tenant B (Colón)
  const resultsA = findClientsByName(tenantContextA, 'Juan García');
  assert(resultsA.length === 1, 'K1. Tenant A solo encuentra a su propio Juan García');
  assert(resultsA[0].clientAddress.includes('Triana'), 'K2. Dirección devuelta pertenece al cliente de Tenant A');
  assert(!resultsA.some(r => r.clientAddress.includes('Colón')), 'K3. Zero disclosure: el cliente de Tenant B nunca aparece en Tenant A');

  // Buscar clientes en Tenant B: solo debe devolver 1 cliente (el de Colón)
  const resultsB = findClientsByName(tenantContextB, 'Juan García');
  assert(resultsB.length === 1, 'K4. Tenant B solo encuentra a su propio Juan García');
  assert(resultsB[0].clientAddress.includes('Colón'), 'K5. Dirección devuelta pertenece al cliente de Tenant B');

  // Desambiguación en Tenant B para "Juan García" debe ser false (solo tiene 1 Juan García, no 2)
  const mockSessionB = {
    phone: phoneB,
    companyId: tenantBId,
    authContext: tenantContextB,
    budgets: new Map([[budgetTenantB.id, budgetTenantB]]),
    activeBudgetId: null,
    pendingDisambiguation: null
  };
  const mockSockB = createMockSock();
  const disB = await checkDisambiguation(mockSockB, `${phoneB}@s.whatsapp.net`, mockSessionB, 'Juan García', 'query_balance');
  assert(disB === false, 'K6. Tenant B no sufre ambigüedad falsa por clientes homónimos existentes en otros tenants');

  // =====================================================================
  // SECCIÓN L: INMUTABILIDAD ESTRICTA DE PRODUCCIÓN POST-TEST
  // =====================================================================
  console.log('\n--- SECCIÓN L: Verificación Post-Test de Producción ---');
  const postHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
  assert(postHash === PROD_CANONICAL_SHA, `L1. data/presuvoz.db intacto byte-a-byte post-test (${PROD_CANONICAL_SHA.slice(0, 12)}...)`);

  const prodVerifyPost = new DatabaseSync(prodPath, { open: true, readOnly: true });
  const postIntegrity = prodVerifyPost.prepare('PRAGMA integrity_check').get();
  assert(postIntegrity?.integrity_check === 'ok', 'L2. PRAGMA integrity_check = ok en producción post-test');
  const postFk = prodVerifyPost.prepare('PRAGMA foreign_key_check').all();
  assert(postFk.length === 0, 'L3. PRAGMA foreign_key_check = 0 en producción post-test');
  const postMigrations = prodVerifyPost.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  assert(postMigrations.length === 16 && postMigrations[15].version === 16, 'L4. schema_migrations [1..16] inalteradas en producción');
  const postInvoicesCount = prodVerifyPost.prepare('SELECT count(*) as c FROM invoices').get().c;
  assert(postInvoicesCount === 6, 'L5. Exactamente 6 facturas históricas preservadas en producción');
  prodVerifyPost.close();

  // Limpiar archivo aislado de test
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (_) {}

  console.log('\n======================================================================');
  console.log(`🎉 TEST 65 COMPLETADO CON ÉXITO: ${passed}/${total} PRUEBAS SUPERADAS`);
  console.log('======================================================================\n');

  return { passed, total, auditFindings };
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith('test_65_real_world_entity_resolution_hardening.js')) {
  runTest65().then(res => {
    if (res.passed !== res.total) {
      process.exit(1);
    }
  }).catch(err => {
    console.error('Fatal error in TEST 65:', err);
    process.exit(1);
  });
}
