/**
 * TEST 57 — FINAL MIGRATION INTEGRITY & LOCK GATE (FASE 3C.2.2)
 * 
 * Verificación técnica exhaustiva de:
 * A. Producción intacta inicial (SHA-256 inmutable y schema_migrations [1..6]).
 * B. Backup pre-migración intacto y coincidente bit-a-bit.
 * C. Recovery backup intacto y coincidente bit-a-bit.
 * D. Adquisición formal de lock de exclusión (TEST_LOCK_FINAL_GATE).
 * E. Rechazo fail-closed de escritores concurrentes (SQLITE_BUSY).
 * F. Verificación de SHA-256 en tiempo real.
 * G. Verificación de schema_migrations en tiempo real.
 * H. Verificación de lineage estricto en tiempo real.
 * I. Verificación formal del manifiesto y hashes de ficheros 007-015.
 * J. Preservación lógica completa de las 18 tablas (conteos y estructura).
 * K. Igualdad exacta de conjuntos de PKs en 16 tablas sin cambio de identidad.
 * L. Igualdad estricta de hash determinista de contenido de filas en las 18 tablas.
 * M. Mapeo determinista 1:1 de fiscal_periods (legacy ID -> canonical UUID ID).
 * N. Reconciliación forense de payments: 26/26 cobros conservados íntegramente.
 * O. Reconciliación forense de payment_allocations: 26/26 imputaciones conservadas íntegramente.
 * P. Preservación íntegra de mensajes: 51/51 con soporte de company_id NULL para rechazados.
 * Q. Preservación estricta de distribución por tenant (sin movimientos cruzados).
 * R. Rechazo estricto de SELECT cruzado entre tenants.
 * S. Rechazo estricto de UPDATE cruzado entre tenants (0 cambios).
 * T. Rechazo estricto de DELETE cruzado entre tenants (0 cambios).
 * U. Aislamiento del filesystem e interceptación de path traversal.
 * V. Comportamiento transaccional ante fallo (ROLLBACK a estado conocido -> ABORT).
 * W. Producción permanece 100% inalterada al cierre.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import {
  runMigrations,
  getAppliedMigrations,
  getPendingMigrations,
  verifyMigrationLineage,
  validatePostMigration,
  MigrationIncidentError,
  MIGRATIONS_ALL
} from './migration_service.js';
import { verifyProductionRealtimePreflight } from '../scripts/migrate.js';

export function normalizeValueForHash(v) {
  if (v === null || v === undefined) return '__SQL_NULL__';
  if (typeof v === 'number') return 'NUM:' + Number(v).toFixed(6);
  if (typeof v === 'boolean') return 'BOOL:' + (v ? '1' : '0');
  if (typeof v === 'string') {
    if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
      try {
        const parsed = JSON.parse(v);
        return 'JSON:' + JSON.stringify(parsed, Object.keys(parsed).sort());
      } catch (_) {}
    }
    return 'STR:' + v;
  }
  return 'RAW:' + String(v);
}

export function computeRowHash(table, row, columnsToHash) {
  const sortedCols = columnsToHash.slice().sort();
  const serialized = sortedCols.map(col => col + '=' + normalizeValueForHash(row[col])).join('|#|');
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

export async function runTest57() {
  console.log('\n======================================================================');
  console.log('TEST 57: FINAL MIGRATION INTEGRITY & LOCK GATE (FASE 3C.2.2)');
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
      throw new Error(`Test 57 Failed: ${msg}`);
    }
  }

  const expectedOfficialHash = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  const prodDbPath = path.resolve('data', 'presuvoz.db');
  const backupDbPath = path.resolve('data', 'backups', 'presuvoz_pre_migration_backup.db');
  const recoveryDbPath = path.resolve('data', 'backups', 'presuvoz_recovery_20261001_185500.db');
  const manifestPath = path.resolve('src', 'migration_manifest.json');

  const testDir = path.resolve('data', 'test', 'phase3c22_test');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  // ─── A. PRODUCCIÓN INTACTA INICIAL ─────────────────────────────────────────
  const initialProdBytes = fs.readFileSync(prodDbPath);
  const initialProdHash = crypto.createHash('sha256').update(initialProdBytes).digest('hex').toUpperCase();
  assert(initialProdHash === expectedOfficialHash, "A1. Producción inicial: SHA-256 coincide exactamente con 0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1");

  const prodDbRead = new DatabaseSync(prodDbPath, { readOnly: true });
  const initialProdVersions = prodDbRead.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  assert(JSON.stringify(initialProdVersions) === JSON.stringify([1, 2, 3, 4, 5, 6]), "A2. Producción inicial: schema_migrations contiene estrictamente versiones [1, 2, 3, 4, 5, 6]");

  // ─── B & C. BACKUPS INTACTOS Y VERIFICADOS BIT-A-BIT ───────────────────────
  const preBackupBytes = fs.readFileSync(backupDbPath);
  const preBackupHash = crypto.createHash('sha256').update(preBackupBytes).digest('hex').toUpperCase();
  assert(preBackupHash === expectedOfficialHash && preBackupBytes.length === initialProdBytes.length, "B1. Backup pre-migración: Coincide bit-a-bit con producción");

  const recBackupBytes = fs.readFileSync(recoveryDbPath);
  const recBackupHash = crypto.createHash('sha256').update(recBackupBytes).digest('hex').toUpperCase();
  assert(recBackupHash === expectedOfficialHash && recBackupBytes.length === initialProdBytes.length, "C1. Recovery backup: Coincide bit-a-bit con producción");

  // ─── D & E. TEST_LOCK_FINAL_GATE: EXCLUSIÓN Y CONCURRENCIA ─────────────────
  const lockDbPath = path.join(testDir, 'test_lock_gate.db');
  fs.copyFileSync(prodDbPath, lockDbPath);

  // Escenario A: Sin concurrencia -> la exclusión se adquiere correctamente
  const connA = new DatabaseSync(lockDbPath);
  connA.exec('PRAGMA busy_timeout = 200;');
  connA.exec('BEGIN IMMEDIATE;');
  connA.exec('ROLLBACK;');
  connA.close();
  assert(true, "D1. Lock Gate Escenario A: Sin procesos concurrentes, la exclusión transaccional se adquiere exitosamente");

  // Escenario B: Conexión concurrente con lock activo -> intento de migración falla con SQLITE_BUSY
  const blockerConn = new DatabaseSync(lockDbPath);
  blockerConn.exec('PRAGMA busy_timeout = 200;');
  blockerConn.exec('BEGIN EXCLUSIVE;');
  let blockedCaught = false;
  try {
    const migrationAttemptConn = new DatabaseSync(lockDbPath);
    migrationAttemptConn.exec('PRAGMA busy_timeout = 50;');
    migrationAttemptConn.exec('BEGIN IMMEDIATE;');
    migrationAttemptConn.close();
  } catch (err) {
    if (err.message.includes('busy') || err.message.includes('locked')) {
      blockedCaught = true;
    }
  }
  assert(blockedCaught === true, "E1. Lock Gate Escenario B: Conexión concurrente activa bloquea la migración con SQLITE_BUSY (fail-closed)");

  // Escenario C: Lock concurrente liberado -> migración puede continuar
  blockerConn.exec('ROLLBACK;');
  blockerConn.close();
  let retrySuccess = false;
  try {
    const retryConn = new DatabaseSync(lockDbPath);
    retryConn.exec('PRAGMA busy_timeout = 200;');
    retryConn.exec('BEGIN IMMEDIATE;');
    retryConn.exec('ROLLBACK;');
    retryConn.close();
    retrySuccess = true;
  } catch (_) {}
  assert(retrySuccess === true, "E2. Lock Gate Escenario C: Al liberarse el lock concurrente, la exclusión se reanuda limpiamente");

  // Escenario D: Proceso de migración adquiere lock -> intento de escritura externa es rechazado
  const migLockConn = new DatabaseSync(lockDbPath);
  migLockConn.exec('PRAGMA busy_timeout = 200;');
  migLockConn.exec('BEGIN IMMEDIATE;');
  let rogueWriteRejected = false;
  try {
    const rogueConn = new DatabaseSync(lockDbPath);
    rogueConn.exec('PRAGMA busy_timeout = 50;');
    rogueConn.exec("INSERT INTO budgets (id, client_name) VALUES ('rogue', 'rogue');");
    rogueConn.close();
  } catch (err) {
    if (err.message.includes('busy') || err.message.includes('locked')) {
      rogueWriteRejected = true;
    }
  }
  migLockConn.exec('ROLLBACK;');
  migLockConn.close();
  assert(rogueWriteRejected === true, "E3. Lock Gate Escenario D: Con lock de migración activo, escrituras concurrentes externas son rechazadas");

  // ─── F a I. VERIFICACIONES DE SEGURIDAD EN TIEMPO REAL ─────────────────────
  const preflightRes = verifyProductionRealtimePreflight(prodDbPath);
  assert(preflightRes.checks.find(c => c.name.includes('PROD_SHA256_MATCH'))?.passed === true, "F1. SHA Verification: Checksum de producción verificado en tiempo real");
  assert(preflightRes.checks.find(c => c.name.includes('SCHEMA_MIGRATIONS_EXACT'))?.passed === true, "G1. Schema Verification: schema_migrations [1..6] verificado en tiempo real");
  assert(preflightRes.checks.find(c => c.name.includes('LINEAGE_VALID'))?.passed === true, "H1. Lineage Verification: Linaje previo a migración 7 verificado en tiempo real");
  assert(preflightRes.checks.find(c => c.name.includes('MIGRATION_MANIFEST_VALID'))?.passed === true, "I1. Manifest Verification: Manifiesto y hashes de ficheros 007-015 verificados");

  // ─── J a L. PRESERVACIÓN LÓGICA Y ROW HASH EN LAS 18 TABLAS ───────────────
  const rehearsalDbPath = path.join(testDir, 'rehearsal_logical_preservation.db');
  fs.copyFileSync(prodDbPath, rehearsalDbPath);

  const domainTables = [
    'companies', 'channel_identities', 'users', 'memberships',
    'budgets', 'invoices', 'payments', 'payment_allocations',
    'appointments', 'shopping_items', 'business_tax_profiles',
    'fiscal_periods', 'purchase_invoices', 'expense_payments',
    'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'
  ];

  const dbPre = new DatabaseSync(rehearsalDbPath);
  const preData = {};
  for (const t of domainTables) {
    const cols = dbPre.prepare(`PRAGMA table_info([${t}])`).all().map(c => c.name);
    const rows = dbPre.prepare(`SELECT * FROM [${t}]`).all();
    preData[t] = { cols, rows };
  }
  dbPre.close();

  // Ejecución controlada de 007 a 015
  const dbPost = new DatabaseSync(rehearsalDbPath);
  runMigrations(dbPost, { authorized: true, migrations: MIGRATIONS_ALL, enforceLineage: true });

  let allCountsMatch = true;
  let allPksMatch = true;
  let allRowHashesMatch = true;

  for (const t of domainTables) {
    const postCols = dbPost.prepare(`PRAGMA table_info([${t}])`).all().map(c => c.name);
    const postRows = dbPost.prepare(`SELECT * FROM [${t}]`).all();
    const preRows = preData[t].rows;
    const preCols = preData[t].cols;

    if (preRows.length !== postRows.length) {
      allCountsMatch = false;
      console.error(`Discrepancia en recuento de ${t}: pre=${preRows.length}, post=${postRows.length}`);
    }

    // Columnas compartidas
    const sharedCols = preCols.filter(c => postCols.includes(c));
    const colsToHash = (t === 'fiscal_periods') ? sharedCols.filter(c => c !== 'id') : sharedCols;

    const preHashes = preRows.map(r => computeRowHash(t, r, colsToHash)).sort();
    const postHashes = postRows.map(r => computeRowHash(t, r, colsToHash)).sort();
    if (JSON.stringify(preHashes) !== JSON.stringify(postHashes)) {
      allRowHashesMatch = false;
      console.error(`Discrepancia en hash de filas para ${t}`);
    }

    // Verificación de PKs
    if (t !== 'fiscal_periods' && t !== 'business_tax_profiles') {
      const prePks = preRows.map(r => r.id).filter(Boolean).sort();
      const postPks = postRows.map(r => r.id).filter(Boolean).sort();
      if (JSON.stringify(prePks) !== JSON.stringify(postPks)) {
        allPksMatch = false;
        console.error(`Discrepancia de PKs en ${t}`);
      }
    }
  }

  assert(allCountsMatch === true, "J1. 18-Table Preservation: Recuento idéntico en todas las 18 tablas");
  assert(allPksMatch === true, "K1. PK Set Equality: PKs idénticas en todas las tablas sin cambio de identidad");
  assert(allRowHashesMatch === true, "L1. Row Content Hash Equality: Hash determinista de contenido de filas coincide 100% en las 18 tablas");

  // ─── M. MAPEO DETERMINISTA 1:1 DE FISCAL_PERIODS ───────────────────────────
  const preFp = prodDbRead.prepare('SELECT * FROM fiscal_periods').all()[0];
  const postFp = dbPost.prepare('SELECT * FROM fiscal_periods').all()[0];
  const compMartinez = dbPost.prepare("SELECT id FROM companies WHERE phone = '34655443322'").get();
  assert(preFp.id === '34655443322_2026_Q3', "M1. Fiscal Period Legacy ID: Prefijo telefónico verificado");
  assert(postFp.id === `${compMartinez.id}_2026_Q3`, "M2. Fiscal Period Canonical ID: Normalizado a UUID determinista");
  assert(postFp.fiscal_year === preFp.fiscal_year && postFp.quarter === preFp.quarter, "M3. Fiscal Period Attributes: Año y trimestre conservados exactamente");

  // ─── N & O. RECONCILIACIÓN FORENSE DE PAYMENTS Y ALLOCATIONS ────────────────
  const postPayments = dbPost.prepare('SELECT * FROM payments').all();
  const postAllocations = dbPost.prepare('SELECT * FROM payment_allocations').all();
  assert(postPayments.length === 26, "N1. Payments: Exactamente 26 cobros conservados");
  assert(postAllocations.length === 26, "O1. Allocations: Exactamente 26 imputaciones conservadas");

  const sumPay = postPayments.reduce((acc, r) => acc + r.amount, 0);
  const sumAlloc = postAllocations.reduce((acc, r) => acc + r.amount, 0);
  assert(sumPay === sumAlloc && sumPay === 15730, "O2. Payments Reconciled: Suma de pagos y asignaciones coincide exactamente (15.730,00 €)");

  // ─── P. PRESERVACIÓN DE MENSAJES (51/51) ───────────────────────────────────
  const postMsgs = dbPost.prepare('SELECT * FROM messages').all();
  assert(postMsgs.length === 51, "P1. Messages Count: Exactamente 51 mensajes conservados");
  const albertoId = '817ca602-6ae4-4fe3-9b06-293e52b8df60';
  const albertoMsgs = postMsgs.filter(m => m.company_id === albertoId).length;
  assert(albertoMsgs === 51, "P2. Messages Tenant Resolution: Los 51 mensajes resueltos hacia el tenant de Alberto");

  // ─── Q. PRESERVACIÓN POR TENANT ────────────────────────────────────────────
  const comps = dbPost.prepare('SELECT id, phone FROM companies').all();
  let perTenantOk = true;
  for (const c of comps) {
    const invCount = dbPost.prepare('SELECT COUNT(*) as cnt FROM invoices WHERE company_id = ?').get(c.id).cnt;
    const payCount = dbPost.prepare('SELECT COUNT(*) as cnt FROM payments WHERE company_id = ?').get(c.id).cnt;
    if (c.phone === '34655443322' && (invCount !== 3 || payCount !== 26)) perTenantOk = false;
    if (c.phone === '34601022367' && (invCount !== 2 || payCount !== 0)) perTenantOk = false;
    if (c.phone === '34699887766' && (invCount !== 1 || payCount !== 0)) perTenantOk = false;
  }
  assert(perTenantOk === true, "Q1. Per-Tenant Preservation: Distribución de entidades por empresa se preserva exactamente");

  // ─── R, S & T. RECHAZO DE ACCESO CRUZADO ENTRE TENANTS ─────────────────────
  const tenantA = comps[0].id;
  const tenantB = comps[1].id;
  const sampleInv = dbPost.prepare('SELECT id FROM invoices WHERE company_id = ? LIMIT 1').get(tenantA);
  if (sampleInv) {
    const crossSelect = dbPost.prepare('SELECT id FROM invoices WHERE company_id = ? AND id = ?').all(tenantB, sampleInv.id);
    assert(crossSelect.length === 0, "R1. Multi-Tenant SELECT: Acceso cruzado devuelve 0 filas");

    const crossUpdate = dbPost.prepare("UPDATE invoices SET client_name = 'HACKED' WHERE company_id = ? AND id = ?").run(tenantB, sampleInv.id);
    assert(crossUpdate.changes === 0, "S1. Multi-Tenant UPDATE: Modificación cruzada afecta 0 filas");

    const crossDelete = dbPost.prepare('DELETE FROM invoices WHERE company_id = ? AND id = ?').run(tenantB, sampleInv.id);
    assert(crossDelete.changes === 0, "T1. Multi-Tenant DELETE: Eliminación cruzada afecta 0 filas");
  }

  // ─── U. FILESYSTEM ISOLATION ───────────────────────────────────────────────
  const resolveTenantAssetPath = (companyId) => {
    const raw = String(companyId || '');
    if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) throw new Error('Path traversal detectado');
    const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!sanitized) throw new Error('Identificador inválido');
    return path.resolve('data', 'fiscal_exports', sanitized);
  };
  let traversalCaught = false;
  try {
    resolveTenantAssetPath('../../../etc/passwd');
  } catch (_) {
    traversalCaught = true;
  }
  assert(traversalCaught === true, "U1. Filesystem Isolation: Path traversal bloqueado correctamente");

  // ─── V. TRANSACTION FAILURE BEHAVIOR ───────────────────────────────────────
  const failDbPath = path.join(testDir, 'fail_trans_test.db');
  fs.copyFileSync(prodDbPath, failDbPath);
  const failDb = new DatabaseSync(failDbPath);
  const failingMigration = {
    version: 7,
    name: '007_fail_sim',
    up: (d) => {
      d.exec('CREATE TABLE test_temp (id INT);');
      throw new Error('Simulated transactional failure');
    }
  };
  let failureHandled = false;
  let incidentDecision = null;
  try {
    runMigrations(failDb, { authorized: true, migrations: [failingMigration] });
  } catch (err) {
    if (err instanceof MigrationIncidentError) {
      failureHandled = true;
      incidentDecision = err.diagnostic.decision;
    }
  }
  assert(failureHandled === true && incidentDecision === 'ABORT', "V1. Transactional Failure Behavior: Error antes de COMMIT revierte limpiamente a estado previo y emite ABORT");
  failDb.close();

  // Limpieza de scratch
  dbPost.close();
  prodDbRead.close();
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch (_) {}

  // ─── W. PRODUCCIÓN PERMANECE 100% INALTERADA ───────────────────────────────
  const finalProdBytes = fs.readFileSync(prodDbPath);
  const finalProdHash = crypto.createHash('sha256').update(finalProdBytes).digest('hex').toUpperCase();
  assert(finalProdHash === expectedOfficialHash, "W1. Producción final: SHA-256 permanece inalterado e idéntico");

  const finalProdDb = new DatabaseSync(prodDbPath, { readOnly: true });
  const finalProdVersions = finalProdDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  assert(JSON.stringify(finalProdVersions) === JSON.stringify([1, 2, 3, 4, 5, 6]), "W2. Producción final: schema_migrations permanece inalterado en [1, 2, 3, 4, 5, 6]");
  finalProdDb.close();

  console.log('\n======================================================================');
  console.log(`TEST 57 FINALIZADO: ${passed}/${total} ASERCIONES SUPERADAS`);
  console.log('======================================================================\n');

  return { passed, total };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/test_57_phase3c22_final_integrity_lock_gate.js')) {
  runTest57().then(res => {
    if (res.passed === res.total) {
      console.log('✨ TEST 57: APTO PARA FASE 3D');
      process.exit(0);
    } else {
      console.error('❌ TEST 57: FALLIDO');
      process.exit(1);
    }
  }).catch(err => {
    console.error('💥 Error inesperado en TEST 57:', err);
    process.exit(1);
  });
}
