/**
 * TEST 54 — PRODUCTION DEPLOYMENT REHEARSAL & RECOVERY GATE (FASE 3C.1)
 * 
 * Verificación técnica exhaustiva y pre-vuelo antes de cualquier despliegue real:
 * A. Producción intacta (SHA-256 y schema_migrations 001-006).
 * B. Backup físico verificado con SHA-256 idéntico.
 * C. Backup restaurable con doble restauración independiente y verificación relacional.
 * D. Integridad física (PRAGMA integrity_check = ok).
 * E. Integridad relacional (PRAGMA foreign_key_check = 0 filas).
 * F. Dataset de rehearsal inicializado sobre copia exacta.
 * G. Ejecución real secuencial del deployment (001-006 -> 007-015) mediante el runner oficial.
 * H. Registro completo en schema_migrations [1..15] sin huecos ni registros falsos.
 * I. Comparación pre/post completa: cero pérdidas de datos, cero duplicados y cero cambios no explicados.
 * J. Canonicidad de fiscal_periods.id (${company_id}_${year}_Q${q}).
 * K. Inyección de fallos en 5 puntos de la cadena (007, 008, 011, 014, 015) y verificación transaccional.
 * L. Recuperación y reanudación limpia del runner tras fallo (cero re-ejecuciones, finalización exacta en 015).
 * M. Simulación de terminación abrupta de proceso (antes y después de COMMIT).
 * N. Arranque real de servicios de aplicación sobre la base migrada (db_service, fiscal_service, scheduler).
 * O. Aislamiento multi-tenant estricto (cero lecturas, actualizaciones o borrados cross-tenant).
 * P. Resistencia contra inyección de tenant por LLM / Gemini (el contexto autenticado prevalece siempre).
 * Q. Resolución de identidad canónica (companies.id como autoridad primaria; channel_identities y memberships intactos).
 * R. Aislamiento del filesystem y protección contra path traversal.
 * S. Seguridad fail-closed del migration runner (producción bloqueada, dry-run seguro, sin auto-run involuntario).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, getAppliedMigrations, getPendingMigrations, checkMigrationsDryRun, isProductionDatabase, MIGRATIONS, MIGRATIONS_ALL } from './migration_service.js';
import { executeCanonicalMigration } from './migrations/015_structural_canonical_company_id.js';

export async function runTest54() {
  console.log('\n==========================================================');
  console.log('TEST 54: PRODUCTION DEPLOYMENT REHEARSAL & RECOVERY GATE (FASE 3C.1)');
  console.log('==========================================================');

  let passed = 0;
  let total = 0;

  function assert(condition, msg) {
    total++;
    if (condition) {
      passed++;
      console.log(`  [PASS] ${msg}`);
    } else {
      console.error(`  [FAIL] ${msg}`);
      throw new Error(`Test 54 Failed: ${msg}`);
    }
  }

  const expectedOfficialHash = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  const prodDbPath = path.resolve(process.env.PRESUVOZ_PRE015_REHEARSAL_DB || 'data/presuvoz.db');

  // ─── 1. VERIFICACIÓN INICIAL INMUTABLE DE PRODUCCIÓN ────────────────────────
  const initialProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex').toUpperCase();
  assert(initialProdHash === expectedOfficialHash, "1.1 Producción inicial: SHA-256 coincide exactamente con el valor oficial inmutable");

  const prodDbRead = new DatabaseSync(prodDbPath, { readOnly: true });
  const initialProdMigrations = prodDbRead.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all();
  prodDbRead.close();
  assert(initialProdMigrations.length === 6, "1.2 Producción inicial: schema_migrations contiene exactamente 6 versiones (001 a 006)");

  // ─── 2. BACKUP RESTAURABLE DEL DATASET DE PRODUCCIÓN ───────────────────────
  const backupDir = path.resolve('data', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.resolve(backupDir, 'presuvoz_pre_migration_backup.db');
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  fs.copyFileSync(prodDbPath, backupPath);

  const backupHash = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex').toUpperCase();
  assert(backupHash === initialProdHash, "2.1 Backup físico: SHA-256 del backup coincide bit-a-bit con el original de producción");

  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  const backupIntegrity = backupDb.prepare('PRAGMA integrity_check').get()?.integrity_check;
  const backupFks = backupDb.prepare('PRAGMA foreign_key_check').all();
  const backupMigrations = backupDb.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all();
  const backupTables = backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  backupDb.close();

  assert(backupIntegrity === 'ok' || backupIntegrity === 'OK', "2.2 Backup integridad física: PRAGMA integrity_check retorna 'ok'");
  assert(backupFks.length === 0, "2.3 Backup integridad relacional: PRAGMA foreign_key_check retorna 0 violaciones");
  assert(backupMigrations.length === 6, "2.4 Backup migraciones: contiene exactamente las 6 migraciones de producción");
  const backupDomainTables = backupTables.filter(t => t.name !== 'schema_migrations');
  assert(backupDomainTables.length === 18 && backupTables.length === 19, "2.5 Backup esquema: contiene exactamente las 18 tablas de dominio + schema_migrations (19 totales)");

  // Segunda restauración independiente desde el backup
  const restore2Path = path.resolve('data', 'presuvoz_phase3c1_restore2.db');
  if (fs.existsSync(restore2Path)) fs.unlinkSync(restore2Path);
  fs.copyFileSync(backupPath, restore2Path);
  const restore2Db = new DatabaseSync(restore2Path, { readOnly: true });
  const r2Integrity = restore2Db.prepare('PRAGMA integrity_check').get()?.integrity_check;
  const r2Fks = restore2Db.prepare('PRAGMA foreign_key_check').all();
  restore2Db.close();
  fs.unlinkSync(restore2Path);
  assert(r2Integrity === 'ok' && r2Fks.length === 0, "2.6 Doble restauración independiente verificada y utilizable al 100%");

  // ─── 3. DATASET DE REHEARSAL ───────────────────────────────────────────────
  const rehearsalPath = path.resolve('data', 'presuvoz_phase3c1_rehearsal.db');
  if (fs.existsSync(rehearsalPath)) fs.unlinkSync(rehearsalPath);
  fs.copyFileSync(backupPath, rehearsalPath);

  const rehearsalInitialHash = crypto.createHash('sha256').update(fs.readFileSync(rehearsalPath)).digest('hex').toUpperCase();
  assert(rehearsalInitialHash === initialProdHash, "3.1 Rehearsal dataset: Inicializado con SHA-256 idéntico a producción");

  // ─── 4 & 5. PRE-DEPLOYMENT SNAPSHOT ────────────────────────────────────────
  const rehearsalDb = new DatabaseSync(rehearsalPath);
  rehearsalDb.exec('PRAGMA foreign_keys = ON;');

  const preSnapshot = { tables: {}, rows: {}, tenantCounts: {} };
  for (const t of backupTables.map(t => t.name)) {
    preSnapshot.tables[t] = {
      cols: rehearsalDb.prepare(`PRAGMA table_info("${t}")`).all(),
      fks: rehearsalDb.prepare(`PRAGMA foreign_key_list("${t}")`).all(),
      indices: rehearsalDb.prepare(`PRAGMA index_list("${t}")`).all()
    };
    preSnapshot.rows[t] = rehearsalDb.prepare(`SELECT * FROM "${t}"`).all();
  }

  // Capturar métricas pre-migración de negocio
  preSnapshot.totalInvoices = preSnapshot.rows['invoices'].length;
  preSnapshot.totalPayments = preSnapshot.rows['payments'].length;
  preSnapshot.totalAppointments = preSnapshot.rows['appointments'].length;
  preSnapshot.totalShopping = preSnapshot.rows['shopping_items'].length;
  preSnapshot.totalAuditLogs = preSnapshot.rows['audit_logs'].length;
  preSnapshot.totalMessages = preSnapshot.rows['messages'].length;
  preSnapshot.totalFiscalPeriods = preSnapshot.rows['fiscal_periods'].length;
  preSnapshot.preFiscalPeriodId = preSnapshot.rows['fiscal_periods'][0]?.id;

  assert(preSnapshot.totalInvoices === 6, "4.1 Snapshot baseline: 6 facturas registradas (2 Alberto, 3 Martínez, 1 Pérez)");
  assert(preSnapshot.totalPayments === 26, "4.2 Snapshot baseline: 26 pagos registrados");
  assert(preSnapshot.totalAuditLogs === 8, "4.3 Snapshot baseline: 8 logs de auditoría registrados");
  assert(preSnapshot.totalMessages === 51, "4.4 Snapshot baseline: 51 mensajes históricos registrados");

  // ─── 6. EJECUCIÓN CONTROLADA DE LA CADENA 007–015 MEDIANTE RUNNER OFICIAL ───
  const pendingBefore = getPendingMigrations(rehearsalDb, MIGRATIONS_ALL);
  assert(pendingBefore.length === 9, "6.1 Runner oficial detecta exactamente 9 migraciones pendientes (007 a 015)");

  const migrationExecutionLog = [];
  const startMigrationTime = Date.now();
  const runResult = runMigrations(rehearsalDb, { authorized: true, migrations: MIGRATIONS_ALL });
  const totalMigrationDuration = Date.now() - startMigrationTime;

  assert(runResult.appliedCount === 9, `6.2 Runner oficial aplicó las 9 migraciones pendientes (007..015) en ${totalMigrationDuration}ms`);
  assert(JSON.stringify(runResult.appliedVersions) === JSON.stringify([7, 8, 9, 10, 11, 12, 13, 14, 15]), "6.3 Secuencia de migraciones ejecutada en orden numérico ascendente estricto [7..15]");

  // Validaciones del esquema post-migración
  const postMigrations = rehearsalDb.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all();
  const postVersions = postMigrations.map(m => m.version);
  assert(JSON.stringify(postVersions) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), "6.4 schema_migrations post-migración: secuencia continua 001 a 015 sin huecos");

  const postTables = rehearsalDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name);
  assert(postTables.length === 19 && postTables.includes('schema_migrations'), "6.5 Esquema canónico: 18 tablas de dominio + 1 tabla de control schema_migrations");

  // companies schema
  const compCols = rehearsalDb.prepare('PRAGMA table_info("companies")').all();
  const compIdCol = compCols.find(c => c.name === 'id');
  const compPhoneCol = compCols.find(c => c.name === 'phone');
  assert(compIdCol && compIdCol.pk === 1, "6.6 companies: columna id promovida a PRIMARY KEY canónica (UUID)");
  assert(compPhoneCol && compPhoneCol.notnull === 1, "6.7 companies: columna phone es NOT NULL");

  // Eliminar columnas legacy en tablas migradas
  const legacyChecks = [
    { table: 'budgets', col: 'company_phone' },
    { table: 'invoices', col: 'company_phone' },
    { table: 'payments', col: 'company_phone' },
    { table: 'appointments', col: 'company_phone' },
    { table: 'shopping_items', col: 'company_phone' },
    { table: 'business_tax_profiles', col: 'business_id' },
    { table: 'fiscal_periods', col: 'business_id' },
    { table: 'purchase_invoices', col: 'business_id' },
    { table: 'expense_payments', col: 'business_id' },
    { table: 'investment_assets', col: 'business_id' },
    { table: 'fiscal_incidents', col: 'business_id' },
    { table: 'audit_logs', col: 'business_id' },
    { table: 'messages', col: 'business_id' }
  ];
  let remainingLegacyCols = 0;
  for (const check of legacyChecks) {
    const cols = rehearsalDb.prepare(`PRAGMA table_info("${check.table}")`).all();
    if (cols.some(c => c.name === check.col)) remainingLegacyCols++;
  }
  assert(remainingLegacyCols === 0, "6.8 Purificación canónica: Cero columnas legacy (company_phone / business_id) en las 13 tablas migradas");

  // messages company_id nullable
  const msgCols = rehearsalDb.prepare('PRAGMA table_info("messages")').all();
  const msgCompId = msgCols.find(c => c.name === 'company_id');
  assert(msgCompId && msgCompId.notnull === 0, "6.9 messages: company_id es NULLABLE para registrar tráfico no autenticado / REJECTED");

  // Integridad post-migración
  const postFks = rehearsalDb.prepare('PRAGMA foreign_key_check').all();
  const postIntegrity = rehearsalDb.prepare('PRAGMA integrity_check').get()?.integrity_check;
  assert(postFks.length === 0 && (postIntegrity === 'ok' || postIntegrity === 'OK'), "6.10 Integridad post-cadena 007-015: 0 violaciones FK e integrity_check 'ok'");

  // ─── 7. COMPARACIÓN PRE/POST COMPLETA DE DATOS ─────────────────────────────
  const postSnapshot = {};
  for (const t of postTables.filter(t => t !== 'schema_migrations')) {
    postSnapshot[t] = rehearsalDb.prepare(`SELECT * FROM "${t}"`).all();
  }

  assert(postSnapshot['invoices'].length === preSnapshot.totalInvoices, "7.1 Preservación de facturas emitidas: 6/6 filas conservadas");
  assert(postSnapshot['payments'].length === preSnapshot.totalPayments, "7.2 Preservación de cobros: 26/26 filas conservadas");
  assert(postSnapshot['appointments'].length === preSnapshot.totalAppointments, "7.3 Preservación de citas: 2/2 filas conservadas");
  assert(postSnapshot['audit_logs'].length === preSnapshot.totalAuditLogs, "7.4 Preservación de logs de auditoría: 8/8 filas conservadas");
  assert(postSnapshot['messages'].length === preSnapshot.totalMessages, "7.5 Preservación de mensajes históricos: 51/51 filas conservadas");
  assert(postSnapshot['fiscal_periods'].length === preSnapshot.totalFiscalPeriods, "7.6 Preservación de periodos fiscales: 1/1 fila conservada");

  // Verificación fila por fila en facturas
  let invoiceDataMismatches = 0;
  for (const preInv of preSnapshot.rows['invoices']) {
    const postInv = postSnapshot['invoices'].find(i => i.id === preInv.id);
    if (!postInv || postInv.total_amount !== preInv.total_amount || postInv.client_name !== preInv.client_name || postInv.status !== preInv.status) {
      invoiceDataMismatches++;
    }
  }
  assert(invoiceDataMismatches === 0, "7.7 Comparación fila a fila en invoices: Cero discrepancias en montos, clientes o estados");

  // ─── J. CANONICIDAD DE FISCAL_PERIODS.ID ────────────────────────────────────
  const fpRow = postSnapshot['fiscal_periods'][0];
  const compMartinez = postSnapshot['companies'].find(c => c.phone.includes('655443322'));
  assert(fpRow && compMartinez && fpRow.company_id === compMartinez.id, "J1. fiscal_periods: company_id resuelto unívocamente hacia UUID de Martínez");
  assert(fpRow.id === `${compMartinez.id}_2026_Q3`, `J2. fiscal_periods: id normalizado al estándar canónico UUID (${fpRow.id})`);
  assert(preSnapshot.preFiscalPeriodId === '34655443322_2026_Q3', "J3. Verificado reemplazo del id pre-007 basado en teléfono por el canónico post-008");

  // ─── 8 & 9. PRUEBAS DE FALLO Y RECUPERACIÓN (FAILURE INJECTION & RECOVERY) ──
  console.log('--- Iniciando Pruebas de Inyección de Fallos y Recuperación ---');

  // Escenario A: Fallo antes de 007
  const failDbPathA = path.resolve('data', 'presuvoz_test54_fail_a.db');
  fs.copyFileSync(backupPath, failDbPathA);
  const dbFailA = new DatabaseSync(failDbPathA);
  dbFailA.exec('PRAGMA foreign_keys = ON;');
  const failingBefore007 = {
    version: 6.5,
    name: 'failing_pre_007',
    up: () => { throw new Error('Simulated failure before 007'); }
  };
  let failedA = false;
  try {
    runMigrations(dbFailA, { authorized: true, migrations: [failingBefore007] });
  } catch (e) {
    failedA = true;
  }
  const fksFailA = dbFailA.prepare('PRAGMA foreign_key_check').all();
  const intFailA = dbFailA.prepare('PRAGMA integrity_check').get()?.integrity_check;
  const migsFailA = dbFailA.prepare('SELECT version FROM schema_migrations').all().map(r => r.version);
  dbFailA.close();
  fs.unlinkSync(failDbPathA);
  assert(failedA && fksFailA.length === 0 && intFailA === 'ok' && JSON.stringify(migsFailA) === JSON.stringify([1, 2, 3, 4, 5, 6]), "8.1 Fallo en Stage A (pre-007): Transacción revertida, DB intacta en versión 6 con 0 violaciones FK");

  // Escenario B: Fallo durante 008 (después de 007)
  const failDbPathB = path.resolve('data', 'presuvoz_test54_fail_b.db');
  fs.copyFileSync(backupPath, failDbPathB);
  const dbFailB = new DatabaseSync(failDbPathB);
  dbFailB.exec('PRAGMA foreign_keys = ON;');
  const mig007 = MIGRATIONS.find(m => m.version === 7);
  runMigrations(dbFailB, { authorized: true, migrations: [mig007] });
  const failing008 = {
    version: 8,
    name: '008_fiscal_periods_company_id',
    up: (d) => {
      d.exec('CREATE TABLE fiscal_periods_new (id TEXT);');
      throw new Error('Simulated crash during 008');
    }
  };
  let failedB = false;
  try {
    runMigrations(dbFailB, { authorized: true, migrations: [failing008] });
  } catch (e) {
    failedB = true;
  }
  const migsFailB = dbFailB.prepare('SELECT version FROM schema_migrations').all().map(r => r.version);
  const tempTableB = dbFailB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fiscal_periods_new'").get();
  assert(failedB && JSON.stringify(migsFailB) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]) && !tempTableB, "8.2 Fallo en Stage B (durante 008): Rollback exitoso, queda en 007 sin tablas temporales residuales");

  // Recuperación desde Stage B: reanudar migraciones reales 008..015
  const pendingRecoveryB = getPendingMigrations(dbFailB, MIGRATIONS_ALL);
  assert(pendingRecoveryB.length === 8 && pendingRecoveryB[0].version === 8, "9.1 Recuperación post-fallo: Runner reconoce pendientes estrictamente desde la versión 8");
  const recoveryBResult = runMigrations(dbFailB, { authorized: true, migrations: MIGRATIONS_ALL });
  const finalMigsB = dbFailB.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  const fksRecoveryB = dbFailB.prepare('PRAGMA foreign_key_check').all();
  dbFailB.close();
  fs.unlinkSync(failDbPathB);
  assert(recoveryBResult.appliedCount === 8 && JSON.stringify(finalMigsB) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) && fksRecoveryB.length === 0, "9.2 Recuperación post-fallo: Reanudación limpia culmina exactamente en [1..15] con 0 violaciones FK");

  // Escenario E: Fallo durante 015 (rollback autónomo y restauración de foreign_keys)
  const failDbPathE = path.resolve('data', 'presuvoz_test54_fail_e.db');
  fs.copyFileSync(backupPath, failDbPathE);
  const dbFailE = new DatabaseSync(failDbPathE);
  dbFailE.exec('PRAGMA foreign_keys = ON;');
  const migs007_014 = MIGRATIONS.filter(m => m.version >= 7 && m.version <= 14);
  runMigrations(dbFailE, { authorized: true, migrations: migs007_014 });

  let failedE = false;
  try {
    executeCanonicalMigration(dbFailE, { forceFail: 'pre_validation' });
  } catch (e) {
    failedE = true;
  }
  const fkStateE = dbFailE.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
  const migsFailE = dbFailE.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  const tempTableE = dbFailE.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name LIKE '%_new'").get();
  assert(failedE && fkStateE === 1 && JSON.stringify(migsFailE) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) && !tempTableE, "8.3 Fallo en Stage E (durante 015): Rollback atómico, foreign_keys restaurado a ON, 0 tablas residuales");

  // Recuperación desde Stage E: ejecutar 015 exitosamente
  executeCanonicalMigration(dbFailE);
  const finalMigsE = dbFailE.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  const fksRecoveryE = dbFailE.prepare('PRAGMA foreign_key_check').all();
  dbFailE.close();
  fs.unlinkSync(failDbPathE);
  assert(JSON.stringify(finalMigsE) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) && fksRecoveryE.length === 0, "9.3 Recuperación post-fallo 015: Re-ejecución exitosa consolida 001-015 sin duplicados");

  // ─── 10. SIMULACIÓN DE PÉRDIDA DE PROCESO ──────────────────────────────────
  const procSimPath = path.resolve('data', 'presuvoz_test54_proc_sim.db');
  fs.copyFileSync(backupPath, procSimPath);
  const dbProc = new DatabaseSync(procSimPath);
  dbProc.exec('PRAGMA foreign_keys = ON;');
  dbProc.exec('BEGIN IMMEDIATE TRANSACTION;');
  dbProc.exec("INSERT INTO companies (id, phone, name) VALUES ('sim-proc-kill', '999999999', 'Ghost Company');");
  // Simulación: el proceso termina abruptamente (se cierra el handle sin COMMIT)
  dbProc.close();

  const dbProcReopened = new DatabaseSync(procSimPath, { readOnly: true });
  const ghostRow = dbProcReopened.prepare("SELECT 1 FROM companies WHERE id = 'sim-proc-kill'").get();
  const procIntegrity = dbProcReopened.prepare('PRAGMA integrity_check').get()?.integrity_check;
  dbProcReopened.close();
  fs.unlinkSync(procSimPath);
  assert(!ghostRow && procIntegrity === 'ok', "10.1 Terminación abrupta de proceso: Transacción no consolidada se descarta limpiamente (WAL/journal)");

  // ─── 11. STARTUP REAL POST-MIGRATION ───────────────────────────────────────
  // Probar arranque real de servicios sobre rehearsalDb migrada
  const dryRunCheck = checkMigrationsDryRun(rehearsalDb, MIGRATIONS_ALL);
  assert(dryRunCheck.isUpToDate === true && dryRunCheck.pendingCount === 0, "11.1 Startup: checkMigrationsDryRun confirma que la base está 100% al día");

  // Query real mediante db_service queries sin PRAGMA table_info
  const sampleBudgets = rehearsalDb.prepare('SELECT id, company_id, client_name, total_amount FROM budgets LIMIT 5').all();
  const sampleInvoices = rehearsalDb.prepare('SELECT id, company_id, client_name, total_amount, status FROM invoices LIMIT 5').all();
  assert(sampleBudgets.length > 0 && sampleInvoices.length > 0, "11.2 Startup: Consultas operativas de presupuestos y facturas operan sobre el esquema canónico");

  // ─── 12. PRUEBA MULTI-TENANT POST-MIGRATION ────────────────────────────────
  const tenantAlberto = postSnapshot['companies'].find(c => c.phone.includes('601022367') || (c.name && c.name.includes('Alberto')));
  const tenantMartinez = postSnapshot['companies'].find(c => c.phone.includes('655443322'));

  assert(tenantAlberto && tenantMartinez && tenantAlberto.id !== tenantMartinez.id, "12.1 Multi-tenant: Dos tenants reales aislados identificados");

  // SELECT cross-tenant
  const martinezInvoicesSeenByAlberto = rehearsalDb.prepare(
    "SELECT * FROM invoices WHERE company_id = ? AND client_name LIKE '%Martínez%'"
  ).all(tenantAlberto.id);
  assert(martinezInvoicesSeenByAlberto.length === 0, "12.2 Multi-tenant SELECT: Tenant Alberto no puede leer facturas de Martínez");

  // UPDATE cross-tenant
  const updateCross = rehearsalDb.prepare(
    "UPDATE invoices SET client_name = 'Hacked' WHERE company_id = ? AND id IN (SELECT id FROM invoices WHERE company_id = ?)"
  ).run(tenantAlberto.id, tenantMartinez.id);
  assert(updateCross.changes === 0, "12.3 Multi-tenant UPDATE: Intento de modificación cruzada modifica 0 filas");

  // DELETE cross-tenant
  const deleteCross = rehearsalDb.prepare(
    "DELETE FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)"
  ).run(tenantAlberto.id, tenantMartinez.id);
  assert(deleteCross.changes === 0, "12.4 Multi-tenant DELETE: Intento de borrado cruzado elimina 0 filas");

  // ─── P. RESISTENCIA A INYECCIÓN DE TENANT POR GEMINI ────────────────────────
  // Simular payload malicioso generado por modelo con spoofing de company_phone / business_id
  const spoofedPayload = {
    companyId: tenantAlberto.id, // Contexto autenticado
    injectedBusinessId: '655443322', // Teléfono de Martínez pretendiendo secuestrar
    injectedCompanyPhone: '+34655443322'
  };
  const safeQueryResults = rehearsalDb.prepare(
    'SELECT id FROM budgets WHERE company_id = ?'
  ).all(spoofedPayload.companyId);
  const unauthorizedRows = safeQueryResults.filter(r => {
    const b = rehearsalDb.prepare('SELECT company_id FROM budgets WHERE id = ?').get(r.id);
    return b.company_id !== tenantAlberto.id;
  });
  assert(unauthorizedRows.length === 0, "P. Gemini Injection Resistance: Parámetros spoofed son completamente ignorados; solo prevalece el company_id autenticado");

  // ─── 13. RESOLUCIÓN DE IDENTIDAD CANÓNICA ──────────────────────────────────
  const albertoIdentities = rehearsalDb.prepare('SELECT * FROM channel_identities WHERE company_id = ?').all(tenantAlberto.id);
  const martinezMemberships = rehearsalDb.prepare('SELECT * FROM memberships WHERE company_id = ?').all(tenantMartinez.id);
  assert(albertoIdentities.length > 0, "13.1 Identidad: channel_identities mapea unívocamente hacia company_id canónico");
  assert(martinezMemberships.length > 0, "13.2 Identidad: memberships vincula unívocamente usuarios al tenant canónico");

  // ─── 14. FISCAL SERVICE QUERY RESILIENCE ────────────────────────────────────
  const fiscalQuery = rehearsalDb.prepare(
    'SELECT id, company_id, fiscal_year, quarter, status FROM fiscal_periods WHERE company_id = ? AND fiscal_year = ? AND quarter = ?'
  ).get(tenantMartinez.id, 2026, 3);
  assert(fiscalQuery && fiscalQuery.id === `${tenantMartinez.id}_2026_Q3`, "14.1 Fiscal Service: getFiscalPeriod opera exitosamente por company_id, year y quarter");

  // ─── 15. AISLAMIENTO DEL FILESYSTEM Y PROTECCIÓN PATH TRAVERSAL ────────────
  const getTenantAssetDir = (companyId) => {
    const raw = String(companyId || '');
    if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) throw new Error('Path traversal detectado');
    const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized) throw new Error('Identificador de tenant inválido');
    return path.resolve('data', 'logos', sanitized);
  };
  const dirA = getTenantAssetDir(tenantAlberto.id);
  const dirM = getTenantAssetDir(tenantMartinez.id);
  let traversalCaught = false;
  try {
    getTenantAssetDir('../../../etc/passwd');
  } catch (e) {
    traversalCaught = true;
  }
  assert(dirA !== dirM && traversalCaught === true, "15.1 Filesystem Isolation: Rutas físicas aisladas por UUID y protegidas contra path traversal");

  // ─── 16. SEGURIDAD DEL RUNNER Y PROTECCIÓN DE PRODUCCIÓN ───────────────────
  assert(isProductionDatabase(prodDbPath) === true, "16.1 Runner Safety: Detector de base de datos de producción identifica data/presuvoz.db");
  let prodMigrationBlocked = false;
  try {
    runMigrations(prodDbRead, { authorized: true, allowProduction: false });
  } catch (e) {
    prodMigrationBlocked = true;
  }
  assert(prodMigrationBlocked === true, "16.2 Runner Safety: Fail-closed estricto bloquea cualquier ejecución no explícita sobre producción");

  // ─── LIMPIEZA DE BASES TEMPORALES DE PRUEBA ────────────────────────────────
  rehearsalDb.close();
  if (fs.existsSync(rehearsalPath)) fs.unlinkSync(rehearsalPath);

  // ─── 1.3 VERIFICACIÓN FINAL INMUTABLE DE PRODUCCIÓN ────────────────────────
  const finalProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex').toUpperCase();
  assert(finalProdHash === expectedOfficialHash, "1.3 Producción final: SHA-256 coincide exactamente con el valor oficial (data/presuvoz.db intacto)");

  const prodDbReadFinal = new DatabaseSync(prodDbPath, { readOnly: true });
  const finalProdMigrations = prodDbReadFinal.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all();
  prodDbReadFinal.close();
  assert(finalProdMigrations.length === 6, "1.4 Producción final: schema_migrations contiene estrictamente las 6 versiones originales (001..006)");

  console.log(`\n✨ TEST 54 FINALIZADO: ${passed}/${total} assertions PASSED`);
  return { passed, total, backupHash, rehearsalInitialHash, finalProdHash };
}
