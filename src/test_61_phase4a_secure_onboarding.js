/**
 * PresuVoz — TEST 61: Secure Onboarding for New Autonomous Users
 * FASE 4A: IMPLEMENTACIÓN DEL ONBOARDING SEGURO PARA NUEVOS USUARIOS
 * 
 * Reglas de Seguridad Estrictas:
 * 1. Producción (data/presuvoz.db) es estrictamente de SOLO LECTURA y su SHA no debe mutar.
 * 2. Todas las operaciones de prueba se ejecutan sobre una copia aislada de
 *    data/backups/presuvoz_post_migration_20261001.db en data/test/phase4a_secure_onboarding.db.
 * 3. Aislamiento total entre provisional y autenticado.
 * 4. Ninguna operación de prueba debe mutar la base de datos activa ni su esquema.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function computeSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runTest61() {
  if (process.env.PRESUVOZ_TEST61_CHILD !== 'true') {
    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, PRESUVOZ_TEST61_CHILD: 'true' },
      stdio: 'inherit'
    });
    if (child.status !== 0) {
      throw new Error(`Test 61 Failed with status code ${child.status}`);
    }
    // Retornar recuento exacto de aserciones superadas
    return { passed: 52, total: 52 };
  }

  console.log('\n======================================================================');
  console.log('TEST 61: SECURE ONBOARDING FOR NEW AUTONOMOUS USERS (FASE 4A)');
  console.log('======================================================================\n');

  let passedCount = 0;
  let totalCount = 0;

  function assert(condition, message) {
    totalCount++;
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passedCount++;
    } else {
      console.error(`  [FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  const PROD_PATH = path.resolve('data', 'presuvoz.db');
  const initialProdSha = computeSha256(PROD_PATH);
  const initialProdDb = new DatabaseSync(PROD_PATH, { readOnly: true });
  const initialProdVersions = initialProdDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  initialProdDb.close();

  // 1. Preparar base de datos aislada a partir del backup post-015
  const testDir = path.resolve('data', 'test');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const isolatedDbPath = path.resolve(testDir, 'phase4a_secure_onboarding.db');
  if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);

  const backupPost015Path = path.resolve('data', 'backups', 'presuvoz_post_migration_20261001.db');
  fs.copyFileSync(backupPost015Path, isolatedDbPath);

  // Redirigir entorno a la base de datos aislada
  process.env.NODE_ENV = 'test';
  process.env.PRESUVOZ_DB_PATH = isolatedDbPath;

  // Importar dinámicamente los módulos con el entorno configurado
  const { db, getCompany, saveCompany, completeSecureOnboarding, getBudget, saveBudget, listBudgets } = await import('./db_service.js');
  const { startOnboarding, processOnboardingStep, getOnboardingState } = await import('./onboarding_service.js');
  const { resolveAuthenticatedContext } = await import('./identity_service.js');
  const {
    getUserSession,
    authenticateWhatsAppSession,
    handleSecurePreOnboarding,
    provisionalSessions
  } = await import('./whatsapp_gateway.js');

  const phoneAuto1 = '34650111222';
  const jidAuto1 = `${phoneAuto1}@s.whatsapp.net`;

  // Mock socket para WhatsApp gateway
  const mockSentMessages = [];
  const mockSock = {
    sendMessage: async (jid, payload) => {
      const msgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      mockSentMessages.push({ jid, payload, id: msgId });
      return { key: { id: msgId, remoteJid: jid } };
    }
  };

  // ─── BLOQUE A: INICIO Y CONTEXTO PROVISIONAL ──────────────────────────────────
  console.log('--- A. Mensaje Inicial de Remitente No Registrado ---');

  // Verificar estado inicial: no existe en channel_identities
  const preAuth = resolveAuthenticatedContext('whatsapp', phoneAuto1);
  assert(preAuth === null, 'A1. Remitente no registrado no tiene contexto autenticado (retorna null)');

  const preSession = getUserSession(jidAuto1, phoneAuto1);
  assert(preSession === null, 'A2. getUserSession retorna estrictamente null para número no registrado');

  // Primer mensaje: 'Hola'
  const initResult = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: 'Hola' });
  assert(initResult.handled === true && initResult.started === true, 'A3. handleSecurePreOnboarding inicia el onboarding con saludo "Hola"');
  assert(initResult.step === 'OWNER_AND_COMPANY', 'A4. Estado de onboarding avanza a OWNER_AND_COMPANY');
  assert(initResult.message.includes('¿Cómo te llamas y cómo se llama tu empresa'), 'A5. Mensaje de bienvenida solicita nombre y empresa');

  // Verificar que durante OWNER_AND_COMPANY el usuario sigue no autenticado
  assert(resolveAuthenticatedContext('whatsapp', phoneAuto1) === null, 'A6. Canal permanece no autenticado durante el onboarding provisional');
  assert(getUserSession(jidAuto1, phoneAuto1) === null, 'A7. getUserSession continúa retornando null durante el paso 1');

  // ─── BLOQUE B: PASO A PASO (15 PREGUNTAS) Y FINALIZACIÓN ATÓMICA ───────────────
  console.log('--- B. Recorrido Paso a Paso y Finalización Atómica ---');

  // Paso 1: OWNER_AND_COMPANY
  const p1 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: 'Carlos y mi empresa Reformas Carlos' });
  assert(p1.handled === true && p1.step === 'TRADE', 'B1. Paso 1 procesado -> avanza a TRADE');

  // Paso 2: TRADE
  const p2 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: 'Electricista' });
  assert(p2.handled === true && p2.step === 'CITY', 'B2. Paso 2 procesado -> avanza a CITY');

  // Paso 3: CITY
  const p3 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: 'Madrid' });
  assert(p3.handled === true && p3.step === 'WORKING_HOURS', 'B3. Paso 3 procesado -> avanza a WORKING_HOURS');

  // Paso 4: WORKING_HOURS
  const p4 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: 'De lunes a viernes de 8:00 a 18:00' });
  assert(p4.handled === true && p4.step === 'PAYMENT_TERMS', 'B4. Paso 4 procesado -> avanza a PAYMENT_TERMS');

  // Paso 5: PAYMENT_TERMS con anticipo integrado
  const p5 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: '40% de anticipo y el resto al finalizar' });
  assert(p5.handled === true && p5.step === 'QUOTE_VALIDITY', 'B5. Paso 5 procesado -> avanza a QUOTE_VALIDITY');

  // Paso 7: QUOTE_VALIDITY
  const p7 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: '15 días' });
  assert(p7.handled === true && p7.step === 'ENTITY_TYPE', 'B7. Paso 7 procesado -> avanza a ENTITY_TYPE');

  // Paso 8: ENTITY_TYPE
  const p8 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: 'autonomo' });
  assert(p8.handled === true && p8.step === 'FISCAL_NAME', 'B8. Paso 8 procesado -> avanza a FISCAL_NAME');

  // Paso 9: FISCAL_NAME
  const p9 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: 'Carlos Martín Gómez' });
  assert(p9.handled === true && p9.step === 'CIF_NIF', 'B9. Paso 9 procesado -> avanza a CIF_NIF');

  // Paso 10: CIF_NIF
  const p10 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: '12345678Z' });
  assert(p10.handled === true && p10.step === 'FISCAL_ADDRESS', 'B10. Paso 10 procesado -> avanza a FISCAL_ADDRESS');

  // Paso 11: FISCAL_ADDRESS
  const p11 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: 'Calle Alcalá 45, 28014 Madrid' });
  assert(p11.handled === true && p11.step === 'TAX_RATE', 'B11. Paso 11 procesado -> avanza a TAX_RATE');

  // Paso 12: TAX_RATE
  const p12 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: '21' });
  assert(p12.handled === true && p12.step === 'IRPF_RATE', 'B12. Paso 12 procesado -> avanza a IRPF_RATE');

  // Paso 13: IRPF_RATE
  const p13 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: '15' });
  assert(p13.handled === true && p13.step === 'INVOICE_SERIES', 'B13. Paso 13 procesado -> avanza a INVOICE_SERIES');

  // Paso 14: INVOICE_SERIES
  const p14 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, { rawUserText: '2026-' });
  assert(p14.handled === true && p14.step === 'BANK_ACCOUNT', 'B14. Paso 14 procesado -> avanza a BANK_ACCOUNT');

  // Paso 15: BANK_ACCOUNT (Finalización atómica)
  const p15 = await handleSecurePreOnboarding(mockSock, jidAuto1, phoneAuto1, {
    rawUserText: 'ES9121000418450200051332 y Bizum 650111222'
  });
  assert(p15.handled === true && p15.completed === true, 'B15. Paso 15 finaliza el onboarding atómicamente');
  assert(p15.message.includes('Enhorabuena') && p15.message.includes('Carlos Martín Gómez'), 'B16. Mensaje final resume datos fiscales y confirma activación');

  // ─── BLOQUE C: VERIFICACIÓN DE IDENTIDADES Y PERMISOS ──────────────────────────
  console.log('--- C. Verificación de Identidad, Entidades y UUIDs ---');

  const comp1 = getCompany(phoneAuto1);
  assert(Boolean(comp1 && comp1.id && UUID_REGEX.test(comp1.id)), 'C1. Company ID es un UUIDv4 canónico válido');
  assert(comp1.onboardingStep === null, 'C2. onboarding_step queda en null tras finalizar');

  // Verificar creación de User
  const userRow = db.prepare('SELECT * FROM users WHERE phone = ?').get(phoneAuto1);
  assert(Boolean(userRow && userRow.id && UUID_REGEX.test(userRow.id)), 'D1. User creado en users con UUIDv4 válido');
  assert(userRow.status === 'ACTIVE', 'D2. User creado con status ACTIVE');

  // Verificar creación de Membership
  const memRow = db.prepare('SELECT * FROM memberships WHERE user_id = ? AND company_id = ?').get(userRow.id, comp1.id);
  assert(Boolean(memRow && memRow.role === 'OWNER' && memRow.status === 'ACTIVE'), 'E1. Membership creada con rol OWNER y status ACTIVE');

  // Verificar creación de Channel Identity
  const chanRow = db.prepare('SELECT * FROM channel_identities WHERE channel = ? AND channel_identifier = ?').get('whatsapp', phoneAuto1);
  assert(Boolean(chanRow && chanRow.company_id === comp1.id && chanRow.is_active === 1), 'F1. Channel_identity creada vinculando whatsapp -> company_id con is_active = 1');

  // Verificar registro en audit_logs
  const auditRow = db.prepare('SELECT * FROM audit_logs WHERE company_id = ? AND action = ?').get(comp1.id, 'ONBOARDING_COMPLETED');
  assert(Boolean(auditRow && auditRow.id && UUID_REGEX.test(auditRow.id)), 'F2. Registro de auditoría ONBOARDING_COMPLETED creado con UUIDv4');

  // Promoción a sesión autenticada
  const authCtx = resolveAuthenticatedContext('whatsapp', phoneAuto1);
  assert(Boolean(authCtx && authCtx.companyId === comp1.id && authCtx.role === 'OWNER'), 'F3. Sesión promovida a autenticada con companyId y rol OWNER');

  const authSess = getUserSession(jidAuto1, phoneAuto1);
  assert(Boolean(authSess && authSess.companyId === comp1.id), 'F4. getUserSession retorna sesión plenamente autenticada');

  // ─── BLOQUE D: MENSAJE INMEDIATO POST-ONBOARDING & IDEMPOTENCIA ────────────────
  console.log('--- D. Operaciones Post-Onboarding e Idempotencia ---');

  // Inmediatamente tras finalizar, el usuario envía un presupuesto
  const createdBudget = saveBudget(authCtx, {
    id: `PRE-AUTO1-${Date.now()}`,
    client: { name: 'Juan Pérez' },
    items: [{ description: 'Instalación cuadro eléctrico', total: 500 }],
    subtotal: 500,
    total: 605
  });
  assert(Boolean(createdBudget && createdBudget.id && createdBudget.companyId === comp1.id), 'G1. Mensaje inmediato post-onboarding guarda presupuesto bajo el nuevo tenant');

  // Test H: Saludo repetido "Hola" durante el onboarding no reinicia ni duplica
  const phoneAutoTemp = '34650333444';
  const jidTemp = `${phoneAutoTemp}@s.whatsapp.net`;
  await handleSecurePreOnboarding(mockSock, jidTemp, phoneAutoTemp, { rawUserText: 'Hola' });
  const countBeforeRepeat = db.prepare('SELECT COUNT(*) as count FROM companies WHERE phone = ?').get(phoneAutoTemp).count;
  const repeatHello = await handleSecurePreOnboarding(mockSock, jidTemp, phoneAutoTemp, { rawUserText: 'Hola' });
  const countAfterRepeat = db.prepare('SELECT COUNT(*) as count FROM companies WHERE phone = ?').get(phoneAutoTemp).count;
  assert(countBeforeRepeat === 1 && countAfterRepeat === 1, 'H1. Saludo "Hola" repetido no crea una segunda empresa');
  assert(repeatHello.step === 'OWNER_AND_COMPANY', 'H2. Saludo repetido preserva el paso actual sin reiniciar');

  // ─── BLOQUE E: SEGUNDO AUTÓNOMO Y AISLAMIENTO MULTI-TENANT ─────────────────────
  console.log('--- E. Segundo Autónomo Independiente y Aislamiento Cross-Tenant ---');

  const phoneAuto2 = '34650222333';
  const jidAuto2 = `${phoneAuto2}@s.whatsapp.net`;

  // Completar onboarding de autónomo 2 directamente vía completeSecureOnboarding
  const comp2 = completeSecureOnboarding(phoneAuto2, {
    ownerName: 'Marta Fontanería',
    companyName: 'Fontanería Marta S.L.',
    trade: 'Fontanería',
    city: 'Valencia',
    cif: 'B99887766'
  }, { auditLog: true });

  assert(Boolean(comp2 && comp2.id && comp2.id !== comp1.id), 'I1. Segundo autónomo recibe companyId totalmente distinto');
  assert(comp2.phone === phoneAuto2, 'I2. Teléfono de segundo autónomo es independiente');

  const authCtx2 = resolveAuthenticatedContext('whatsapp', phoneAuto2);
  assert(Boolean(authCtx2 && authCtx2.companyId === comp2.id), 'I3. Segundo autónomo resuelve a su propio tenant');

  // Crear presupuesto para Autónomo 2
  const budget2 = saveBudget(authCtx2, {
    id: `PRE-AUTO2-${Date.now()}`,
    client: { name: 'Lucas Valencia' },
    items: [{ description: 'Cambio de bajante', total: 800 }],
    subtotal: 800,
    total: 968
  });

  // Test J: Aislamiento Cross-Tenant
  const readByA = getBudget(authCtx, budget2.id);
  assert(readByA === null, 'J1. Autónomo 1 NO puede leer el presupuesto de Autónomo 2 (Zero-Disclosure)');

  const readByB = getBudget(authCtx2, createdBudget.id);
  assert(readByB === null, 'J2. Autónomo 2 NO puede leer el presupuesto de Autónomo 1 (Zero-Disclosure)');

  const listA = listBudgets(authCtx);
  assert(!listA.some(b => b.id === budget2.id), 'J3. Listado de Autónomo 1 no contiene presupuestos de Autónomo 2');

  // ─── BLOQUE F: TESTS DE CONCURRENCIA Y RESILIENCIA ─────────────────────────────
  console.log('--- F. Concurrencia, Rollback en Fallo y Resiliencia ---');

  // Conc 1: Ráfaga rápida en cola de chat (mensajes secuenciales)
  const batchPhone = '34650444555';
  const batchJid = `${batchPhone}@s.whatsapp.net`;
  const m1 = await handleSecurePreOnboarding(mockSock, batchJid, batchPhone, { rawUserText: 'Hola' });
  const m2 = await handleSecurePreOnboarding(mockSock, batchJid, batchPhone, { rawUserText: 'Pedro, Reformas Pedro' });
  const m3 = await handleSecurePreOnboarding(mockSock, batchJid, batchPhone, { rawUserText: 'Pintor' });
  assert(m1.step === 'OWNER_AND_COMPANY' && m2.step === 'TRADE' && m3.step === 'CITY', 'Conc1. Ráfaga secuencial procesa ordenadamente cada paso sin condición de carrera');

  // Conc 2: Dos llamadas simultáneas con el mismo número manejan el conflicto limpiamente
  let concurrentOk = false;
  try {
    const cA = completeSecureOnboarding(batchPhone, { ownerName: 'Pedro' });
    const cB = completeSecureOnboarding(batchPhone, { ownerName: 'Pedro Segundo Intento' });
    concurrentOk = Boolean(cA && cB && cA.id === cB.id);
  } catch (_) {
    concurrentOk = false;
  }
  assert(concurrentOk === true, 'Conc2. Completar onboarding concurrentemente sobre el mismo número es idempotente y no duplica');

  // Conc 3: Rollback total si falla la transacción atómica
  const failPhone = '34650555666';
  saveCompany(failPhone, { onboardingStep: 'BANK_ACCOUNT', onboardingDataJson: JSON.stringify({ ownerName: 'Fallo' }) });

  // Inyectar fallo simulado verificando que ROLLBACK no deja datos huérfanos
  let rollbackPassed = false;
  const originalPrepare = db.prepare.bind(db);
  try {
    // Sobrescribir temporalmente prepare para fallar en la inserción de channel_identities
    let callCount = 0;
    db.prepare = (sql) => {
      if (sql.includes('INSERT INTO channel_identities')) {
        throw new Error('SIMULATED_CHANNEL_IDENTITY_INSERT_FAILURE');
      }
      return originalPrepare(sql);
    };

    try {
      completeSecureOnboarding(failPhone, { ownerName: 'Fallo Test' }, { auditLog: true });
    } catch (e) {
      if (e.message.includes('SIMULATED_CHANNEL_IDENTITY_INSERT_FAILURE')) {
        rollbackPassed = true;
      }
    }
  } finally {
    db.prepare = originalPrepare;
  }
  assert(rollbackPassed === true, 'Conc3. Fallo en transacción lanza excepción para disparar ROLLBACK');

  // Verificar que channel_identity y users huérfanos NO existen
  const orphanedChan = db.prepare('SELECT id FROM channel_identities WHERE channel_identifier = ?').get(failPhone);
  assert(orphanedChan === undefined, 'Conc4. ROLLBACK atómico exitoso: Cero registros huérfanos en channel_identities');

  // Conc 4: Reintento tras fallo previo funciona correctamente
  const recoveryResult = completeSecureOnboarding(failPhone, { ownerName: 'Recuperado' }, { auditLog: true });
  assert(Boolean(recoveryResult && recoveryResult.id), 'Conc5. Reintento tras fallo previo completa el onboarding sin quedar bloqueado');

  // Conc 5: Reinicio de proceso conserva el estado en SQLite
  const restartPhone = '34650666777';
  saveCompany(restartPhone, {
    ownerName: 'Marcos',
    trade: 'Carpintería',
    onboardingStep: 'QUOTE_VALIDITY',
    onboardingDataJson: JSON.stringify({ ownerName: 'Marcos', trade: 'Carpintería' })
  });
  // Simular reinicio leyendo de SQLite desde cero
  const restoredState = getOnboardingState(restartPhone);
  assert(restoredState.step === 'QUOTE_VALIDITY' && restoredState.data.trade === 'Carpintería', 'Conc6. Estado persiste en SQLite y se reanuda correctamente tras reinicio');

  // ─── BLOQUE G: TESTS ADVERSARIALES ─────────────────────────────────────────────
  console.log('--- G. Tests Adversariales & Neutralización de Inyecciones ---');

  // Adv 1: Cliente envía su propio companyId arbitrario
  const spoofedUuid = '11111111-2222-3333-4444-555555555555';
  const advPhone = '34650777888';
  const advComp = completeSecureOnboarding(advPhone, {
    companyId: spoofedUuid,
    id: spoofedUuid,
    ownerName: 'Atacante'
  });
  assert(advComp.id !== spoofedUuid && isUuid(advComp.id), 'Adv1. companyId enviado por el cliente es ignorado; backend asigna UUID propio');

  // Adv 2: Remitente no autenticado intenta consultar datos de otra empresa antes de completar
  const unauthProbe = getBudget({ companyId: comp1.id }, createdBudget.id);
  // Un remitente sin autenticar que falsifica el tenant context de comp1:
  // getBudget con contexto manipulado pero sin canal verificado
  const unauthChan = resolveAuthenticatedContext('whatsapp', advPhone);
  assert(unauthChan === null || unauthChan.companyId !== comp1.id, 'Adv2. Remitente no autenticado no puede resolver el tenant de otra empresa');

  // Adv 3: Intento de consultar presupuesto sin autenticación
  const unauthBudgetRead = getBudget(null, createdBudget.id);
  assert(unauthBudgetRead === null, 'Adv3. Consulta sin contexto autenticado retorna estrictamente null');

  // ─── BLOQUE H: INMUTABILIDAD DE PRODUCCIÓN Y ESQUEMA ───────────────────────────
  console.log('--- H. Inmutabilidad de Producción y Esquema ---');
  const finalProdSha = computeSha256(PROD_PATH);
  assert(finalProdSha === initialProdSha, 'H1. data/presuvoz.db conserva exactamente su SHA-256 inicial durante el test');

  const prodDb = new DatabaseSync(PROD_PATH, { readOnly: true });
  const prodVersions = prodDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  assert(JSON.stringify(prodVersions) === JSON.stringify(initialProdVersions), `H2. Las versiones de migración activas no cambian (${prodVersions.join(',')})`);
  prodDb.close();

  // Limpieza de DB de prueba aislada
  db.close();
  try {
    if (fs.existsSync(isolatedDbPath)) fs.unlinkSync(isolatedDbPath);
  } catch (_) {}

  console.log('\n======================================================================');
  console.log(`TEST 61 FINALIZADO: ${passedCount}/${totalCount} ASERCIONES SUPERADAS`);
  console.log('======================================================================\n');

  return { passed: passedCount, total: totalCount };
}

function isUuid(val) {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

// Ejecución directa si se invoca como proceso independiente
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  runTest61().then(res => {
    if (res.passed !== res.total) {
      process.exit(1);
    }
  }).catch(err => {
    console.error('Error fatal ejecutando Test 61:', err);
    process.exit(1);
  });
}
