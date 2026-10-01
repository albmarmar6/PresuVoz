#!/usr/bin/env node
/**
 * PresuVoz — Script Oficial de Pre-Vuelo para Migración de Producción
 * FASE 3C.2: PRODUCTION PRE-FLIGHT AUDIT & SAFETY VERIFICATION
 * 
 * Este script es ESTRICTAMENTE DE SOLO LECTURA.
 * NO modifica la base de datos de producción (data/presuvoz.db).
 * NO ejecuta DDL ni DML.
 * NO altera schema_migrations.
 * 
 * Realiza 16 comprobaciones rigurosas y devuelve exit code 0 únicamente
 * si todos los requisitos de seguridad e integridad están al 100%.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_ALL, checkMigrationsDryRun } from '../src/migration_service.js';

const EXPECTED_PRODUCTION_SHA256 = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
const EXPECTED_INITIAL_VERSIONS = [1, 2, 3, 4, 5, 6];

export function runPreflightChecks(customOptions = {}) {
  const results = [];
  let allPassed = true;

  function recordCheck(code, title, passed, details = '') {
    results.push({ code, title, passed, details });
    if (!passed) allPassed = false;
  }

  const targetDbPath = path.resolve(customOptions.targetDb || process.env.PRESUVOZ_PRE015_REHEARSAL_DB || 'data/presuvoz.db');
  const backupDbPath = path.resolve(customOptions.backupDb || 'data/backups/presuvoz_pre_migration_backup.db');
  const recoveryDbPath = path.resolve(customOptions.recoveryDb || 'data/backups/presuvoz_recovery_20261001_185500.db');
  const manifestPath = path.resolve(customOptions.manifestPath || 'src/migration_manifest.json');
  const expectedSha = customOptions.expectedSha || EXPECTED_PRODUCTION_SHA256;

  // 1. TARGET_DB_EXISTS
  const dbExists = fs.existsSync(targetDbPath);
  recordCheck('TARGET_DB_EXISTS', 'Existencia del archivo de base de datos objetivo', dbExists, `Ruta: ${targetDbPath}`);
  if (!dbExists) return { allPassed: false, results };

  // 2. TARGET_DB_NOT_EMPTY
  const dbStats = fs.statSync(targetDbPath);
  recordCheck('TARGET_DB_NOT_EMPTY', 'Tamaño no nulo de la base de datos objetivo', dbStats.size > 0, `Tamaño: ${dbStats.size} bytes`);

  // 3. PROD_SHA256_MATCH
  const targetBuffer = fs.readFileSync(targetDbPath);
  const actualHash = crypto.createHash('sha256').update(targetBuffer).digest('hex').toUpperCase();
  const hashMatches = actualHash === expectedSha;
  recordCheck('PROD_SHA256_MATCH', 'SHA-256 coincide con el hash inmutable de producción', hashMatches, `Esperado: ${expectedSha} | Actual: ${actualHash}`);

  // 4. SQLITE_MAGIC_HEADER
  const magic = targetBuffer.subarray(0, 16).toString('utf8');
  const magicValid = magic.startsWith('SQLite format 3');
  recordCheck('SQLITE_MAGIC_HEADER', 'Encabezado binario canónico SQLite v3', magicValid, `Header: ${magic.replace(/\0/g, '')}`);

  // 5. DB_READONLY_OPENS
  let db = null;
  let canOpenReadOnly = false;
  try {
    db = new DatabaseSync(targetDbPath, { open: true, readOnly: true });
    canOpenReadOnly = true;
  } catch (err) {
    canOpenReadOnly = false;
  }
  recordCheck('DB_READONLY_OPENS', 'Apertura limpia en modo STRICTLY READ-ONLY', canOpenReadOnly);

  if (db && canOpenReadOnly) {
    try {
      // 6. PRAGMA_INTEGRITY
      const integrity = db.prepare('PRAGMA integrity_check;').get();
      const integrityOk = integrity && (integrity.integrity_check === 'ok' || integrity.integrity_check === 'OK');
      recordCheck('PRAGMA_INTEGRITY', 'Integridad física de páginas (PRAGMA integrity_check)', integrityOk, `Resultado: ${integrity?.integrity_check}`);

      // 7. PRAGMA_FOREIGN_KEYS
      const fkCheck = db.prepare('PRAGMA foreign_key_check;').all();
      const fkOk = Array.isArray(fkCheck) && fkCheck.length === 0;
      recordCheck('PRAGMA_FOREIGN_KEYS', 'Consistencia relacional inicial (PRAGMA foreign_key_check)', fkOk, `Infracciones: ${fkCheck.length}`);

      // 8. SCHEMA_MIGRATIONS_EXISTS
      const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      recordCheck('SCHEMA_MIGRATIONS_EXISTS', 'Existencia de tabla de control schema_migrations', !!tableExists);

      // 9. BASELINE_VERSIONS_VALID
      let versionsMatch = false;
      let appliedList = [];
      if (tableExists) {
        appliedList = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
        versionsMatch = JSON.stringify(appliedList) === JSON.stringify(EXPECTED_INITIAL_VERSIONS);
      }
      recordCheck('BASELINE_VERSIONS_VALID', 'Historial actual de versiones es exactamente [1, 2, 3, 4, 5, 6]', versionsMatch, `Versiones: [${appliedList.join(', ')}]`);

      // 10. PRE_BACKUP_EXISTS_AND_MATCHES
      const preBackupExists = fs.existsSync(backupDbPath);
      let preBackupHashMatches = false;
      if (preBackupExists) {
        const preBackupHash = crypto.createHash('sha256').update(fs.readFileSync(backupDbPath)).digest('hex').toUpperCase();
        preBackupHashMatches = preBackupHash === expectedSha;
      }
      recordCheck('PRE_BACKUP_EXISTS_AND_MATCHES', 'Backup pre-migración existe y coincide bit-a-bit con producción', preBackupExists && preBackupHashMatches, `Ruta: ${backupDbPath}`);

      // 11. RECOVERY_BACKUP_EXISTS_AND_MATCHES
      const recoveryExists = fs.existsSync(recoveryDbPath);
      let recoveryHashMatches = false;
      if (recoveryExists) {
        const recoveryHash = crypto.createHash('sha256').update(fs.readFileSync(recoveryDbPath)).digest('hex').toUpperCase();
        recoveryHashMatches = recoveryHash === expectedSha;
      }
      recordCheck('RECOVERY_BACKUP_EXISTS_AND_MATCHES', 'Backup inmutable de recuperación existe y coincide bit-a-bit', recoveryExists && recoveryHashMatches, `Ruta: ${recoveryDbPath}`);

      // 12. BACKUP_PRAGMA_BINDING
      let pragmaBindingOk = false;
      if (preBackupExists && preBackupHashMatches) {
        try {
          const backupDb = new DatabaseSync(backupDbPath, { open: true, readOnly: true });
          const pSize1 = db.prepare('PRAGMA page_size;').get().page_size;
          const pSize2 = backupDb.prepare('PRAGMA page_size;').get().page_size;
          const pCount1 = db.prepare('PRAGMA page_count;').get().page_count;
          const pCount2 = backupDb.prepare('PRAGMA page_count;').get().page_count;
          const uVer1 = db.prepare('PRAGMA user_version;').get().user_version;
          const uVer2 = backupDb.prepare('PRAGMA user_version;').get().user_version;
          backupDb.close();
          pragmaBindingOk = (pSize1 === pSize2) && (pCount1 === pCount2) && (uVer1 === uVer2);
        } catch (_) {
          pragmaBindingOk = false;
        }
      }
      recordCheck('BACKUP_PRAGMA_BINDING', 'Enlace e identidad de PRAGMAs entre BD y backup', pragmaBindingOk);

      // 13. MANIFEST_EXISTS_AND_VALID
      let manifest = null;
      let manifestValid = false;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          manifestValid = manifest && Array.isArray(manifest.pendingChain) && manifest.pendingChain.length === 9;
        } catch (_) {
          manifestValid = false;
        }
      }
      recordCheck('MANIFEST_EXISTS_AND_VALID', 'Manifiesto de migración existe y es JSON válido', manifestValid, `Ruta: ${manifestPath}`);

      // 14. MIGRATION_FILES_INTEGRITY
      let filesIntegrityOk = false;
      if (manifestValid && manifest.pendingChain) {
        filesIntegrityOk = manifest.pendingChain.every(entry => {
          const filePath = path.resolve('src/migrations', entry.filename);
          if (!fs.existsSync(filePath)) return false;
          const content = fs.readFileSync(filePath);
          const hash = crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
          return hash === entry.sha256 && content.length === entry.size;
        });
      }
      recordCheck('MIGRATION_FILES_INTEGRITY', 'Integridad de archivos 007-015 coincide 100% con el manifiesto', filesIntegrityOk);

      // 15. MIGRATION_SERVICE_LOADABLE
      const dryCheck = checkMigrationsDryRun(db, MIGRATIONS_ALL);
      const serviceOk = Array.isArray(MIGRATIONS_ALL) && MIGRATIONS_ALL.length === 15 && dryCheck.pendingCount === 9;
      recordCheck('MIGRATION_SERVICE_LOADABLE', 'Módulo migration_service carga 15 migraciones y detecta exactamente 9 pendientes', serviceOk, `Pendientes detectadas: ${dryCheck.pendingCount}`);

      // 16. PRODUCTION_FLAG_SAFETY
      const prodFlag = process.env.ALLOW_PRODUCTION_MIGRATIONS;
      const flagSafe = prodFlag !== 'true';
      recordCheck('PRODUCTION_FLAG_SAFETY', 'Variable ALLOW_PRODUCTION_MIGRATIONS está desactivada para preflight', flagSafe, `Valor actual: ${prodFlag || 'undefined'}`);

    } finally {
      db.close();
    }
  }

  return { allPassed, results };
}

// Ejecución CLI directa
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/preflight-production-migration.js')) {
  console.log('======================================================================');
  console.log(' PresuVoz — Auditoría de Pre-Vuelo para Migración de Producción');
  console.log('======================================================================\n');

  const { allPassed, results } = runPreflightChecks();

  for (const check of results) {
    const icon = check.passed ? '✅ [PASS]' : '❌ [FAIL]';
    console.log(`${icon} ${check.code}: ${check.title}`);
    if (check.details) {
      console.log(`         Detalle: ${check.details}`);
    }
  }

  console.log('\n----------------------------------------------------------------------');
  if (allPassed) {
    console.log('✨ VEREDICTO DE PRE-VUELO: APTO PARA EJECUCIÓN CONTROLADA (FASE 3D)');
    console.log('======================================================================');
    process.exit(0);
  } else {
    console.error('🛑 VEREDICTO DE PRE-VUELO: NO APTO — SE HAN DETECTADO DISCREPANCIAS');
    console.log('======================================================================');
    process.exit(1);
  }
}
