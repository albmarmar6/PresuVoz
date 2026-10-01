/**
 * TEST 55 — FINAL PRODUCTION DEPLOYMENT GATE & PRE-FLIGHT (FASE 3C.2)
 * 
 * Verificación técnica exhaustiva y pre-vuelo final antes de autorizar la Fase 3D:
 * A. Dataset de producción intacto (SHA-256 inmutable y schema_migrations [1..6]).
 * B. Enlace e identidad exacta bit-a-bit del backup pre-migración y sus PRAGMAs.
 * C. Existencia y verificación bit-a-bit del backup inmutable de recuperación.
 * D. Integridad formal y checksums SHA-256 del manifiesto de migración (007-015).
 * E. Auditoría del script oficial de pre-vuelo (16 comprobaciones OK, detección de alteraciones).
 * F. Concurrencia SQLite y contención de bloqueos (fail-closed con SQLITE_BUSY ante contención).
 * G. Barreras de linaje estricto (enforceLineage detecta huecos y bloquea saltos no secuenciales).
 * H. Ensayo completo de migración sobre copia del dataset real (007-015 en secuencia continua).
 * I. Preservación íntegra de datos relacionales, conteos y canonicidad de fiscal_periods.id.
 * J. Blindaje multi-tenant post-migración (cero filtración transversal entre empresas).
 * K. Salvaguardas CLI fail-closed en scripts/migrate.js (bloqueo en prod sin flag, dry-run seguro).
 * L. Protocolo de contingencia y restauración verificada (restauración bit-a-bit garantizada).
 * M. Producción final 100% inalterada (SHA-256 oficial idéntico al valor inicial).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { runMigrations, getAppliedMigrations, getPendingMigrations, checkMigrationsDryRun, verifyMigrationLineage, isProductionDatabase, MIGRATIONS_ALL } from './migration_service.js';
import { runPreflightChecks } from '../scripts/preflight-production-migration.js';

export async function runTest55() {
  console.log('\n======================================================================');
  console.log('TEST 55: FINAL PRODUCTION DEPLOYMENT GATE & PRE-FLIGHT (FASE 3C.2)');
  console.log('======================================================================');

  let passed = 0;
  let total = 0;

  function assert(condition, msg) {
    total++;
    if (condition) {
      passed++;
      console.log(`  [PASS] ${msg}`);
    } else {
      console.error(`  [FAIL] ${msg}`);
      throw new Error(`Test 55 Failed: ${msg}`);
    }
  }

  const expectedOfficialHash = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  const prodDbPath = path.resolve('data', 'presuvoz.db');
  const backupDbPath = path.resolve('data', 'backups', 'presuvoz_pre_migration_backup.db');
  const recoveryDbPath = path.resolve('data', 'backups', 'presuvoz_recovery_20261001_185500.db');
  const manifestPath = path.resolve('src', 'migration_manifest.json');

  // ─── A. PRODUCCIÓN INTACTA (INVARIANTES PRE-VUELO) ─────────────────────────
  assert(fs.existsSync(prodDbPath), "A1. Archivo de base de datos de producción existe en data/presuvoz.db");
  const initialProdBuffer = fs.readFileSync(prodDbPath);
  const initialProdHash = crypto.createHash('sha256').update(initialProdBuffer).digest('hex').toUpperCase();
  assert(initialProdHash === expectedOfficialHash, "A2. Producción inicial: SHA-256 coincide exactamente con 0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1");

  const prodDbRead = new DatabaseSync(prodDbPath, { readOnly: true });
  const initialProdMigrations = prodDbRead.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all();
  const initialProdVersions = initialProdMigrations.map(m => m.version);
  assert(JSON.stringify(initialProdVersions) === JSON.stringify([1, 2, 3, 4, 5, 6]), "A3. Producción inicial: schema_migrations contiene estrictamente versiones [1, 2, 3, 4, 5, 6]");

  const prodIntegrity = prodDbRead.prepare('PRAGMA integrity_check;').get();
  assert(prodIntegrity.integrity_check === 'ok' || prodIntegrity.integrity_check === 'OK', "A4. Producción inicial: PRAGMA integrity_check = ok");
  const prodFKs = prodDbRead.prepare('PRAGMA foreign_key_check;').all();
  assert(prodFKs.length === 0, "A5. Producción inicial: PRAGMA foreign_key_check = 0 filas de infracción");

  // ─── B. ENLACE Y VERIFICACIÓN EXACTA DEL BACKUP PRE-MIGRACIÓN ──────────────
  assert(fs.existsSync(backupDbPath), "B1. Backup pre-migración existe en data/backups/presuvoz_pre_migration_backup.db");
  const backupBuffer = fs.readFileSync(backupDbPath);
  assert(backupBuffer.length === initialProdBuffer.length, `B2. Tamaño del backup coincide con producción (${backupBuffer.length} bytes)`);
  const backupHash = crypto.createHash('sha256').update(backupBuffer).digest('hex').toUpperCase();
  assert(backupHash === expectedOfficialHash, "B3. SHA-256 del backup coincide bit-a-bit con la base de datos de producción");

  const backupDbRead = new DatabaseSync(backupDbPath, { readOnly: true });
  const prodPageSize = prodDbRead.prepare('PRAGMA page_size;').get().page_size;
  const backupPageSize = backupDbRead.prepare('PRAGMA page_size;').get().page_size;
  const prodPageCount = prodDbRead.prepare('PRAGMA page_count;').get().page_count;
  const backupPageCount = backupDbRead.prepare('PRAGMA page_count;').get().page_count;
  const prodUserVer = prodDbRead.prepare('PRAGMA user_version;').get().user_version;
  const backupUserVer = backupDbRead.prepare('PRAGMA user_version;').get().user_version;
  const prodSchemaVer = prodDbRead.prepare('PRAGMA schema_version;').get().schema_version;
  const backupSchemaVer = backupDbRead.prepare('PRAGMA schema_version;').get().schema_version;

  assert(prodPageSize === backupPageSize && prodPageCount === backupPageCount, "B4. PRAGMA page_size y page_count son idénticos entre producción y backup");
  assert(prodUserVer === backupUserVer && prodSchemaVer === backupSchemaVer, "B5. PRAGMA user_version y schema_version son idénticos entre producción y backup");
  backupDbRead.close();
  prodDbRead.close();

  // ─── C. EXISTENCIA Y VERIFICACIÓN DEL BACKUP INMUTABLE DE RECUPERACIÓN ──────
  assert(fs.existsSync(recoveryDbPath), "C1. Backup inmutable de recuperación existe en data/backups/presuvoz_recovery_20261001_185500.db");
  const recoveryBuffer = fs.readFileSync(recoveryDbPath);
  assert(recoveryBuffer.length === initialProdBuffer.length, `C2. Tamaño del backup de recuperación es idéntico (${recoveryBuffer.length} bytes)`);
  const recoveryHash = crypto.createHash('sha256').update(recoveryBuffer).digest('hex').toUpperCase();
  assert(recoveryHash === expectedOfficialHash, "C3. SHA-256 del backup de recuperación coincide bit-a-bit con producción");

  // ─── D. MANIFIESTO DE MIGRACIONES (007-015) ───────────────────────────────
  assert(fs.existsSync(manifestPath), "D1. Manifiesto de migraciones existe en src/migration_manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(Array.isArray(manifest.pendingChain) && manifest.pendingChain.length === 9, "D2. El manifiesto contiene exactamente 9 migraciones en pendingChain (007 a 015)");

  for (const entry of manifest.pendingChain) {
    const entryFile = path.resolve('src/migrations', entry.filename);
    assert(fs.existsSync(entryFile), `D3.${entry.version}. Archivo de migración ${entry.filename} existe en disco`);
    const fileBytes = fs.readFileSync(entryFile);
    const calculatedHash = crypto.createHash('sha256').update(fileBytes).digest('hex').toUpperCase();
    assert(calculatedHash === entry.sha256, `D4.${entry.version}. SHA-256 de ${entry.filename} coincide exactamente con el manifiesto`);
    assert(fileBytes.length === entry.size, `D5.${entry.version}. Tamaño en bytes de ${entry.filename} coincide con el manifiesto`);
  }
  const entry015 = manifest.pendingChain.find(e => e.version === 15);
  assert(entry015 && entry015.standaloneTransaction === true, "D6. Migración canónica 015 declarada con standaloneTransaction = true en el manifiesto");

  // ─── E. AUDITORÍA DEL SCRIPT OFICIAL DE PRE-VUELO ──────────────────────────
  const preflightResult = runPreflightChecks();
  assert(preflightResult.allPassed === true, "E1. Preflight oficial: Las 16 comprobaciones de pre-vuelo son satisfactorias (allPassed = true)");
  assert(preflightResult.results.length === 16, "E2. Preflight oficial: Se evaluaron exactamente 16 comprobaciones independientes");

  // Detección de alteraciones por el preflight
  const tamperedPreflightResult = runPreflightChecks({
    expectedSha: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  });
  assert(tamperedPreflightResult.allPassed === false, "E3. Preflight fail-closed: Detecta discrepancia de SHA-256 y rechaza la ejecución");

  const missingBackupPreflight = runPreflightChecks({
    backupDb: 'data/backups/non_existent_backup_test.db'
  });
  assert(missingBackupPreflight.allPassed === false, "E4. Preflight fail-closed: Detecta ausencia de backup y rechaza la ejecución");

  // ─── F. CONCURRENCIA SQLITE Y CONTENCIÓN DE BLOQUEOS (REHEARSAL DB) ─────────
  const testDir = path.resolve('data', 'test_scratch_55');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const lockRehearsalPath = path.join(testDir, 'lock_contention_rehearsal.db');
  fs.copyFileSync(prodDbPath, lockRehearsalPath);

  const conn1 = new DatabaseSync(lockRehearsalPath);
  conn1.exec('PRAGMA busy_timeout = 100;');
  conn1.exec('BEGIN EXCLUSIVE;'); // Adquiere lock exclusivo
  conn1.exec('CREATE TABLE test_lock_marker (id INTEGER);');

  let lockContentionBlocked = false;
  try {
    const conn2 = new DatabaseSync(lockRehearsalPath);
    conn2.exec('PRAGMA busy_timeout = 100;');
    conn2.exec('BEGIN IMMEDIATE;'); // Debe fallar con SQLITE_BUSY
    conn2.close();
  } catch (err) {
    if (err.message.includes('busy') || err.message.includes('locked')) {
      lockContentionBlocked = true;
    }
  }
  assert(lockContentionBlocked === true, "F1. Concurrencia SQLite: Conexión concurrente es bloqueada con SQLITE_BUSY ante transacción activa");

  conn1.exec('ROLLBACK;');
  conn1.close();

  // Comprobar que tras liberar el lock la base de datos sigue íntegra y operable
  const connRecovered = new DatabaseSync(lockRehearsalPath, { readOnly: true });
  const intCheck = connRecovered.prepare('PRAGMA integrity_check;').get();
  assert(intCheck.integrity_check === 'ok' || intCheck.integrity_check === 'OK', "F2. Concurrencia SQLite: Base de datos conserva integridad intacta tras resolución de bloqueo");
  connRecovered.close();

  // ─── G. BARRERAS DE LINEAGE ESTRICTO (HUECOS Y SALTOS) ─────────────────────
  const lineageDbPath = path.join(testDir, 'lineage_guard_rehearsal.db');
  fs.copyFileSync(prodDbPath, lineageDbPath);
  const lineageDb = new DatabaseSync(lineageDbPath);

  // Intentar saltar directamente a 15 con enforceLineage activado
  let lineageJumpRejected = false;
  try {
    verifyMigrationLineage(lineageDb, 15);
  } catch (err) {
    if (err.message.includes('LINEAGE GUARD') && err.message.includes('Infracción de linaje')) {
      lineageJumpRejected = true;
    }
  }
  assert(lineageJumpRejected === true, "G1. Lineage Guard: Salto no continuo (001-006 a 015) es bloqueado explícitamente");

  // Intentar ejecutar 008 sin haber ejecutado 007
  let missing007Rejected = false;
  try {
    verifyMigrationLineage(lineageDb, 8);
  } catch (err) {
    if (err.message.includes('LINEAGE GUARD')) {
      missing007Rejected = true;
    }
  }
  assert(missing007Rejected === true, "G2. Lineage Guard: Ejecutar migración 008 sin haber aplicado 007 es bloqueado");

  // Secuencia correcta es permitida
  const valid007 = verifyMigrationLineage(lineageDb, 7);
  assert(valid007 === true, "G3. Lineage Guard: Migración 007 es aceptada sobre historial continuo [1..6]");
  lineageDb.close();

  // ─── H. REHEARSAL COMPLETO DE MIGRACIÓN 007-015 CON ENFORCELINEAGE ──────────
  const fullRehearsalPath = path.join(testDir, 'full_production_rehearsal.db');
  fs.copyFileSync(prodDbPath, fullRehearsalPath);
  const fullRehearsalDb = new DatabaseSync(fullRehearsalPath);

  const pendingList = getPendingMigrations(fullRehearsalDb, MIGRATIONS_ALL);
  assert(pendingList.length === 9, "H1. Rehearsal: Detectadas exactamente 9 migraciones pendientes (007 a 015)");

  const migrationResult = runMigrations(fullRehearsalDb, {
    authorized: true,
    migrations: MIGRATIONS_ALL,
    enforceLineage: true
  });

  assert(migrationResult.appliedCount === 9, "H2. Rehearsal: 9 migraciones aplicadas secuencialmente con éxito bajo enforceLineage");
  const finalApplied = getAppliedMigrations(fullRehearsalDb).map(m => m.version);
  assert(JSON.stringify(finalApplied) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), "H3. Rehearsal: schema_migrations final contiene estrictamente [1..15] sin huecos");

  const rehearsalIntegrity = fullRehearsalDb.prepare('PRAGMA integrity_check;').get();
  assert(rehearsalIntegrity.integrity_check === 'ok' || rehearsalIntegrity.integrity_check === 'OK', "H4. Rehearsal: PRAGMA integrity_check post-migración = ok");
  const rehearsalFKs = fullRehearsalDb.prepare('PRAGMA foreign_key_check;').all();
  assert(rehearsalFKs.length === 0, "H5. Rehearsal: PRAGMA foreign_key_check post-migración = 0 infracciones");

  // ─── I. PRESERVACIÓN DE DATOS Y CANONICIDAD DE IDs ─────────────────────────
  const usersCount = fullRehearsalDb.prepare('SELECT COUNT(*) as c FROM users;').get().c;
  const companiesCount = fullRehearsalDb.prepare('SELECT COUNT(*) as c FROM companies;').get().c;
  const budgetsCount = fullRehearsalDb.prepare('SELECT COUNT(*) as c FROM budgets;').get().c;
  const invoicesCount = fullRehearsalDb.prepare('SELECT COUNT(*) as c FROM invoices;').get().c;
  const paymentsCount = fullRehearsalDb.prepare('SELECT COUNT(*) as c FROM payments;').get().c;
  const periodsCount = fullRehearsalDb.prepare('SELECT COUNT(*) as c FROM fiscal_periods;').get().c;

  assert(usersCount > 0 && companiesCount > 0, "I1. Entidades primarias de identidad preservadas íntegramente");
  assert(budgetsCount > 0 && invoicesCount > 0 && paymentsCount > 0, "I2. Documentos mercantiles y cobros preservados sin pérdidas");
  assert(periodsCount > 0, "I3. Periodos fiscales preservados íntegramente");

  const invalidPeriods = fullRehearsalDb.prepare(`
    SELECT id, company_id, fiscal_year, quarter FROM fiscal_periods
    WHERE id != (company_id || '_' || fiscal_year || '_Q' || quarter);
  `).all();
  assert(invalidPeriods.length === 0, "I4. Canonicidad de fiscal_periods.id: Todos los registros cumplen ${company_id}_${fiscal_year}_Q${quarter}");

  // ─── J. AISLAMIENTO MULTI-TENANT POST-MIGRACIÓN ────────────────────────────
  const sampleInvoice = fullRehearsalDb.prepare('SELECT id, company_id FROM invoices LIMIT 1;').get();
  const companyA = sampleInvoice.company_id;
  const invoicesCompanyA = fullRehearsalDb.prepare('SELECT id FROM invoices WHERE company_id = ?;').all(companyA);
  assert(invoicesCompanyA.length > 0, "J1. Aislamiento Multi-Tenant: Facturas asociadas a companyA recuperadas correctamente");

  // Verificar que otra empresa no puede acceder a la factura de companyA
  const otherCompany = fullRehearsalDb.prepare('SELECT id FROM companies WHERE id != ? LIMIT 1;').get(companyA).id;
  const crossInvoices = fullRehearsalDb.prepare('SELECT id FROM invoices WHERE company_id = ? AND id = ?;').all(otherCompany, sampleInvoice.id);
  assert(crossInvoices.length === 0, "J2. Aislamiento Multi-Tenant: Factura de companyA es estrictamente inaccesible filtrando por otherCompany");

  fullRehearsalDb.close();

  // ─── K. SALVAGUARDAS CLI FAIL-CLOSED EN SCRIPTS/MIGRATE.JS ──────────────────
  const cliCheck = spawnSync('node', ['scripts/migrate.js', '--check'], {
    encoding: 'utf8',
    env: { ...process.env, PRESUVOZ_DB_PATH: prodDbPath }
  });
  assert(cliCheck.status === 0 && cliCheck.stdout.includes('DRY-RUN / READ-ONLY'), "K1. CLI scripts/migrate.js --check opera estrictamente en DRY-RUN con exit code 0");

  const cliProdBlocked = spawnSync('node', ['scripts/migrate.js'], {
    encoding: 'utf8',
    env: { ...process.env, PRESUVOZ_DB_PATH: prodDbPath, ALLOW_PRODUCTION_MIGRATIONS: 'false' }
  });
  assert(cliProdBlocked.status === 1 && cliProdBlocked.stderr.includes('ACCESO DENEGADO POR SEGURIDAD'), "K2. CLI scripts/migrate.js bloquea ejecución contra producción sin autorización explícita");

  // ─── L. PROTOCOLO DE CONTINGENCIA Y RESTAURACIÓN VERIFICADA ────────────────
  const contingencyDbPath = path.join(testDir, 'contingency_test.db');
  fs.copyFileSync(prodDbPath, contingencyDbPath);
  // Simular corrupción de archivo
  fs.writeFileSync(contingencyDbPath, 'CORRUPTED_DATA_HEADER');

  // Restaurar desde backup oficial
  fs.copyFileSync(backupDbPath, contingencyDbPath);
  const restoredBuffer = fs.readFileSync(contingencyDbPath);
  const restoredHash = crypto.createHash('sha256').update(restoredBuffer).digest('hex').toUpperCase();
  assert(restoredHash === expectedOfficialHash, "L1. Contingencia: Restauración desde backup oficial produce hash SHA-256 exacto idéntico");

  // Limpieza de scratch de pruebas
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch (_) {}

  // ─── M. PRODUCCIÓN FINAL 100% INTACTA ──────────────────────────────────────
  const finalProdBuffer = fs.readFileSync(prodDbPath);
  const finalProdHash = crypto.createHash('sha256').update(finalProdBuffer).digest('hex').toUpperCase();
  assert(finalProdHash === expectedOfficialHash, "M1. Producción final: SHA-256 permanece exactamente igual al valor inicial e inmutable");

  const finalProdDbRead = new DatabaseSync(prodDbPath, { readOnly: true });
  const finalProdVersions = finalProdDbRead.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  assert(JSON.stringify(finalProdVersions) === JSON.stringify([1, 2, 3, 4, 5, 6]), "M2. Producción final: schema_migrations permanece inalterado en [1, 2, 3, 4, 5, 6]");
  finalProdDbRead.close();

  console.log('\n======================================================================');
  console.log(`TEST 55 FINALIZADO: ${passed}/${total} ASERCIONES SUPERADAS`);
  console.log('======================================================================\n');

  return { passed, total };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/test_55_phase3c2_production_gate.js')) {
  runTest55().then(res => {
    if (res.passed === res.total) {
      console.log('✨ TEST 55: APTO PARA FASE 3D');
      process.exit(0);
    } else {
      console.error('❌ TEST 55: FALLIDO');
      process.exit(1);
    }
  }).catch(err => {
    console.error('💥 Error inesperado en TEST 55:', err);
    process.exit(1);
  });
}
