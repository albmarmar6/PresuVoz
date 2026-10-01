#!/usr/bin/env node
/**
 * PresuVoz — Dedicated Migration CLI Tool
 * FASE 3C.2.1: PRODUCTION DEPLOYMENT SAFETY HARDENING
 * 
 * Permite ejecutar formal y explícitamente las migraciones pendientes sobre la base de datos objetivo.
 * 
 * FAIL-CLOSED SAFETY GUARDS:
 * 1. Opening/inspecting a database must NEVER mutate its schema.
 * 2. Migrations require explicit execution via this script.
 * 3. Targeting production (data/presuvoz.db) REQUIRES:
 *    - ALLOW_PRODUCTION_MIGRATIONS='true'
 *    - Real-time preflight audit (16 checks) passing 100% IMMEDIATELY before write access
 *    - Post-migration validation (PRAGMAs, entity count, schema completeness)
 *    - Explicit operational decision: ABORT / CONTINUE / RESTORE
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  runMigrations,
  isProductionDatabase,
  initMigrationTable,
  getPendingMigrations,
  checkMigrationsDryRun,
  verifyMigrationLineage,
  validatePostMigration,
  MIGRATIONS_ALL
} from '../src/migration_service.js';

export function verifyProductionRealtimePreflight(targetDbPath) {
  const EXPECTED_PROD_SHA = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  const EXPECTED_INITIAL_VERSIONS = [1, 2, 3, 4, 5, 6];
  const EXPECTED_PENDING_VERSIONS = [7, 8, 9, 10, 11, 12, 13, 14, 15];

  const checks = [];
  function addCheck(name, passed, detail = '') {
    checks.push({ name, passed, detail });
    if (!passed) {
      console.error(`  ❌ [FAIL] ${name}: ${detail}`);
    } else {
      console.log(`  ✅ [PASS] ${name}`);
    }
  }

  // 1. Target path exact: data/presuvoz.db
  const resolvedTarget = path.resolve(targetDbPath).toLowerCase();
  const expectedTarget = path.resolve('data', 'presuvoz.db').toLowerCase();
  addCheck('1. TARGET_PATH_EXACT', resolvedTarget === expectedTarget, `Target: ${resolvedTarget}`);

  // 2. SHA-256 esperado
  const prodBuf = fs.readFileSync(targetDbPath);
  const actualSha = crypto.createHash('sha256').update(prodBuf).digest('hex').toUpperCase();
  addCheck('2. PROD_SHA256_MATCH', actualSha === EXPECTED_PROD_SHA, `Esperado: ${EXPECTED_PROD_SHA} | Actual: ${actualSha}`);

  // 3-5. SQLite checks via readOnly
  let readOnlyDb = null;
  try {
    readOnlyDb = new DatabaseSync(targetDbPath, { open: true, readOnly: true });
    // 3. schema_migrations exactamente [1, 2, 3, 4, 5, 6]
    const versions = readOnlyDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
    addCheck('3. SCHEMA_MIGRATIONS_EXACT', JSON.stringify(versions) === JSON.stringify(EXPECTED_INITIAL_VERSIONS), `Versiones: [${versions.join(',')}]`);

    // 4. integrity_check = ok
    const integ = readOnlyDb.prepare('PRAGMA integrity_check;').get();
    const integOk = integ && (integ.integrity_check === 'ok' || integ.integrity_check === 'OK');
    addCheck('4. INTEGRITY_CHECK', Boolean(integOk), `Resultado: ${integ?.integrity_check}`);

    // 5. foreign_key_check = 0
    const fks = readOnlyDb.prepare('PRAGMA foreign_key_check;').all();
    addCheck('5. FOREIGN_KEY_CHECK', fks.length === 0, `Infracciones: ${fks.length}`);

    // 13. Lineage valid
    const lineageOk = verifyMigrationLineage(readOnlyDb, 7);
    addCheck('13. LINEAGE_VALID', lineageOk === true, 'Lineage valid pre-007');

    // 14. Exactamente pendientes: [7..15]
    const pending = getPendingMigrations(readOnlyDb, MIGRATIONS_ALL);
    const pendingVersions = pending.map(m => m.version);
    addCheck('14. EXACTLY_PENDING', JSON.stringify(pendingVersions) === JSON.stringify(EXPECTED_PENDING_VERSIONS), `Pendientes: [${pendingVersions.join(',')}]`);
  } catch (err) {
    addCheck('SQLITE_READONLY_OPENS', false, err.message);
  } finally {
    if (readOnlyDb) readOnlyDb.close();
  }

  // 6. Backup pre-migration existe
  const preBackupPath = path.resolve('data', 'backups', 'presuvoz_pre_migration_backup.db');
  const preBackupExists = fs.existsSync(preBackupPath);
  addCheck('6. PRE_BACKUP_EXISTS', preBackupExists, `Ruta: ${preBackupPath}`);

  // 7. Backup pre-migration SHA coincide
  let preShaMatch = false;
  if (preBackupExists) {
    const preSha = crypto.createHash('sha256').update(fs.readFileSync(preBackupPath)).digest('hex').toUpperCase();
    preShaMatch = preSha === EXPECTED_PROD_SHA;
  }
  addCheck('7. PRE_BACKUP_SHA_MATCH', preShaMatch, 'SHA backup coincide con producción');

  // 8. Recovery backup existe
  const recBackupPath = path.resolve('data', 'backups', 'presuvoz_recovery_20261001_185500.db');
  const recBackupExists = fs.existsSync(recBackupPath);
  addCheck('8. RECOVERY_BACKUP_EXISTS', recBackupExists, `Ruta: ${recBackupPath}`);

  // 9. Recovery backup SHA coincide
  let recShaMatch = false;
  if (recBackupExists) {
    const recSha = crypto.createHash('sha256').update(fs.readFileSync(recBackupPath)).digest('hex').toUpperCase();
    recShaMatch = recSha === EXPECTED_PROD_SHA;
  }
  addCheck('9. RECOVERY_BACKUP_SHA_MATCH', recShaMatch, 'SHA recovery backup coincide con producción');

  // 10. Migration manifest válido
  const manifestPath = path.resolve('src', 'migration_manifest.json');
  let manifest = null;
  let manifestValid = false;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifestValid = manifest && Array.isArray(manifest.pendingChain) && manifest.pendingChain.length === 9;
    } catch (_) {}
  }
  addCheck('10. MIGRATION_MANIFEST_VALID', manifestValid, `Ruta: ${manifestPath}`);

  // 11. Hashes 007-015 coinciden exactamente con manifest
  let hashesMatch = false;
  if (manifestValid) {
    hashesMatch = manifest.pendingChain.every(entry => {
      const p = path.resolve('src', 'migrations', entry.filename);
      if (!fs.existsSync(p)) return false;
      const b = fs.readFileSync(p);
      const h = crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
      return h === entry.sha256 && b.length === entry.size;
    });
  }
  addCheck('11. MIGRATION_HASHES_MATCH', hashesMatch, 'Hashes y tamaños de 007 a 015 coinciden');

  // 12. Git working tree limpio
  let gitClean = false;
  try {
    const gitStatus = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    gitClean = gitStatus === '';
  } catch (_) {
    gitClean = false;
  }
  addCheck('12. GIT_WORKING_TREE_CLEAN', gitClean, gitClean ? 'Working tree 100% limpio' : 'Modificaciones no guardadas detectadas');

  // 15. No existe otra ejecución de migraciones concurrente / lock check
  let lockSafe = false;
  try {
    const lockTestDb = new DatabaseSync(targetDbPath);
    lockTestDb.exec('PRAGMA busy_timeout = 200;');
    lockTestDb.exec('BEGIN IMMEDIATE;');
    lockTestDb.exec('ROLLBACK;');
    lockTestDb.close();
    lockSafe = true;
  } catch (_) {
    lockSafe = false;
  }
  addCheck('15. NO_CONCURRENT_LOCK', lockSafe, lockSafe ? 'Lock inmediato disponible' : 'Base de datos bloqueada por otro proceso');

  // 16. Autorización explícita
  const allowProd = process.env.ALLOW_PRODUCTION_MIGRATIONS === 'true';
  addCheck('16. AUTHORIZATION_EXPLICIT', allowProd, `ALLOW_PRODUCTION_MIGRATIONS=${process.env.ALLOW_PRODUCTION_MIGRATIONS}`);

  const allPassed = checks.every(c => c.passed);
  return { allPassed, checks };
}

// Lógica de ejecución CLI
const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('--check');
const targetDbPath = process.env.PRESUVOZ_DB_PATH || path.resolve('data', 'presuvoz.db');
const isProd = isProductionDatabase(targetDbPath);
const allowProd = process.env.ALLOW_PRODUCTION_MIGRATIONS === 'true';

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/migrate.js')) {
  console.log('====================================================');
  console.log(' PresuVoz — Gestor Controlado de Migraciones SQL');
  console.log('====================================================');
  console.log(`Base de datos objetivo: ${targetDbPath}`);
  console.log(`¿Es producción?:       ${isProd ? 'SÍ (data/presuvoz.db)' : 'NO'}`);
  console.log(`Modo:                  ${isDryRun ? 'DRY-RUN / READ-ONLY (Sin modificaciones)' : 'EJECUCIÓN'}`);

  if (isDryRun) {
    const readOnlyDb = new DatabaseSync(targetDbPath, { open: true, readOnly: true });
    const check = checkMigrationsDryRun(readOnlyDb, MIGRATIONS_ALL);
    console.log(`\n📋 Estado del Esquema:`);
    console.log(`  - Migraciones aplicadas: ${check.appliedCount}`);
    for (const m of check.applied) {
      console.log(`    ✅ [${m.version}] ${m.name} (${m.applied_at})`);
    }
    console.log(`  - Migraciones pendientes: ${check.pendingCount}`);
    for (const p of check.pending) {
      console.log(`    ⏳ [${p.version}] ${p.name}`);
    }
    if (check.isUpToDate) {
      console.log('\n✨ La base de datos está 100% actualizada. Cero migraciones pendientes.');
    } else {
      console.log(`\n⚠️ Hay ${check.pendingCount} migración/es pendiente/s.`);
    }
    readOnlyDb.close();
    console.log('====================================================');
    process.exit(0);
  }

  if (isProd && !allowProd) {
    console.error('\n🛑 [ACCESO DENEGADO POR SEGURIDAD]');
    console.error('Se ha detectado un intento de migrar la base de datos de PRODUCCIÓN.');
    console.error('Por directiva de seguridad, la migración de producción requiere autorización explícita:');
    console.error('ALLOW_PRODUCTION_MIGRATIONS=true node scripts/migrate.js\n');
    console.error('DECISIÓN OPERATIVA: ABORT (Producción inalterada).\n');
    process.exit(1);
  }

  if (isProd) {
    console.log('\n🔍 [AUDITORÍA DE PRE-VUELO EN TIEMPO REAL (PRE-WRITE GUARD)]');
    const preflight = verifyProductionRealtimePreflight(targetDbPath);
    if (!preflight.allPassed) {
      console.error('\n🛑 [PRE-VUELO EN TIEMPO REAL FALLIDO — BARRERA CRÍTICA TOCTOU]');
      console.error('Se han detectado discrepancias antes de abrir la base de datos de producción.');
      console.error('DECISIÓN OPERATIVA: ABORT (No se inicia la migración; producción inalterada).\n');
      process.exit(1);
    }
    console.log('✨ [PRE-VUELO EN TIEMPO REAL SUPERADO]: 16/16 comprobaciones conformes.');
  }

  const db = new DatabaseSync(targetDbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  initMigrationTable(db);
  const pending = getPendingMigrations(db, MIGRATIONS_ALL);

  if (pending.length === 0) {
    console.log('\n✅ No hay migraciones pendientes. El esquema ya está actualizado.');
    db.close();
    process.exit(0);
  }

  console.log(`\n📦 Migraciones pendientes a aplicar: ${pending.length}`);
  for (const m of pending) {
    console.log(`  - [${m.version}] ${m.name}`);
  }

  try {
    const result = runMigrations(db, {
      authorized: true,
      allowProduction: allowProd,
      migrations: MIGRATIONS_ALL,
      enforceLineage: true
    });

    console.log(`\n✨ Éxito: ${result.appliedCount} migración/es aplicada/s correctamente.`);

    // Validación Post-Migración formal
    console.log('\n🔍 [VALIDACIÓN POST-MIGRACIÓN]');
    const postValidation = validatePostMigration(db);
    console.log(`  - Integridad física: ${postValidation.integrityOk ? 'OK' : 'FALLO'}`);
    console.log(`  - Infracciones FK:   ${postValidation.fkViolations}`);
    console.log(`  - Historial [1..15]: ${postValidation.versionsOk ? 'OK' : 'FALLO'}`);
    console.log(`  - Tablas canónicas:  ${postValidation.tablesOk ? 'OK' : 'FALLO'}`);
    console.log(`  - DECISIÓN OPERATIVA: ${postValidation.decision}`);

    db.close();
    console.log('====================================================');

    if (postValidation.decision === 'CONTINUE') {
      process.exit(0);
    } else {
      console.error('🛑 [VALIDACIÓN POST-MIGRACIÓN FALLIDA]: Se requiere RESTORE.');
      process.exit(1);
    }
  } catch (err) {
    db.close();
    console.error('\n💥 [ERROR CRÍTICO EN MIGRACIÓN]:', err.message);
    if (err.diagnostic) {
      console.error('  Diagnóstico formal:', JSON.stringify(err.diagnostic, null, 2));
      console.error(`  DECISIÓN OPERATIVA RECOMENDADA: ${err.diagnostic.decision}`);
    }
    process.exit(1);
  }
}
