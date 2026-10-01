/**
 * PresuVoz — Migration Service (Motor Formal de Migraciones)
 * 
 * Gestiona la evolución del esquema relacional de SQLite de forma:
 * - Determinista y ordenada (por versión numérica ascendente).
 * - Idempotente (no repite migraciones ya aplicadas).
 * - Transaccional (BEGIN / COMMIT / ROLLBACK) para garantizar cero corrupción.
 * - Compatible con bases de datos nuevas y adopción de bases de datos existentes.
 */

import path from 'node:path';
import { migration as baselineMigration } from './migrations/001_baseline_schema.js';
import { migration as identityMigration } from './migrations/002_identity_foundation.js';
import { migration as budgetsMigration } from './migrations/003_budgets_company_id.js';
import { migration as invoicesMigration } from './migrations/004_invoices_company_id.js';
import { migration as paymentsMigration } from './migrations/005_payments_company_id.js';
import { migration as appointmentsShoppingMigration } from './migrations/006_appointments_shopping_company_id.js';
import { migration as businessTaxProfilesMigration } from './migrations/007_business_tax_profiles_company_id.js';
import { migration as fiscalPeriodsMigration } from './migrations/008_fiscal_periods_company_id.js';
import { migration as purchaseInvoicesMigration } from './migrations/009_purchase_invoices_company_id.js';
import { migration as expensePaymentsMigration } from './migrations/010_expense_payments_company_id.js';
import { migration as investmentAssetsMigration } from './migrations/011_investment_assets_company_id.js';
import { migration as fiscalIncidentsMigration } from './migrations/012_fiscal_incidents_company_id.js';
import { migration as auditLogsMigration } from './migrations/013_audit_logs_company_id.js';
import { migration as messagesMigration } from './migrations/014_messages_company_id.js';
import { migration as canonicalMigration } from './migrations/015_structural_canonical_company_id.js';

export const MIGRATIONS = [
  baselineMigration,
  identityMigration,
  budgetsMigration,
  invoicesMigration,
  paymentsMigration,
  appointmentsShoppingMigration,
  businessTaxProfilesMigration,
  fiscalPeriodsMigration,
  purchaseInvoicesMigration,
  expensePaymentsMigration,
  investmentAssetsMigration,
  fiscalIncidentsMigration,
  auditLogsMigration,
  messagesMigration
];

export const MIGRATIONS_ALL = [
  ...MIGRATIONS,
  canonicalMigration
];

/**
 * Inicializa la tabla de control de migraciones si no existe.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function initMigrationTable(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Obtiene todas las migraciones aplicadas en la base de datos.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{ id: number, version: number, name: string, applied_at: string }>}
 */
export function getAppliedMigrations(db, options = {}) {
  const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!tableExists) {
    if (options.dryRun || options.readOnly) {
      return [];
    }
    initMigrationTable(db);
  }
  return db.prepare('SELECT id, version, name, applied_at FROM schema_migrations ORDER BY version ASC').all();
}

/**
 * Obtiene las migraciones pendientes de aplicar.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array} [migrationList] Lista opcional de migraciones (por defecto MIGRATIONS)
 * @param {object} [options] Opciones (dryRun, readOnly)
 * @returns {Array} Migraciones pendientes ordenadas por versión
 */
export function getPendingMigrations(db, migrationList = MIGRATIONS, options = {}) {
  const applied = getAppliedMigrations(db, options);
  const appliedVersions = new Set(applied.map(m => m.version));
  return migrationList
    .slice()
    .sort((a, b) => a.version - b.version)
    .filter(m => !appliedVersions.has(m.version));
}

/**
 * Realiza una comprobación en modo estrictamente READ-ONLY / DRY-RUN.
 * NO ejecuta ninguna modificación, no crea tablas, no altera esquemas.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array} [migrationList]
 * @returns {{ isUpToDate: boolean, appliedCount: number, pendingCount: number, applied: Array, pending: Array }}
 */
export function checkMigrationsDryRun(db, migrationList = MIGRATIONS) {
  const applied = getAppliedMigrations(db, { dryRun: true });
  const appliedVersions = new Set(applied.map(m => m.version));
  const pending = migrationList
    .slice()
    .sort((a, b) => a.version - b.version)
    .filter(m => !appliedVersions.has(m.version));

  return {
    isUpToDate: pending.length === 0,
    appliedCount: applied.length,
    pendingCount: pending.length,
    applied,
    pending
  };
}

/**
 * Obtiene la ruta física del archivo SQLite de una instancia DatabaseSync.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string|null}
 */
export function getDatabaseFilePath(db) {
  try {
    const list = db.prepare('PRAGMA database_list;').all();
    const main = list.find(entry => entry.name === 'main');
    return main ? main.file : null;
  } catch (_) {
    return null;
  }
}

/**
 * Determina si una base de datos o ruta corresponde a la base de datos de producción (data/presuvoz.db).
 * @param {import('node:sqlite').DatabaseSync|string} dbOrPath
 * @returns {boolean}
 */
export function isProductionDatabase(dbOrPath) {
  let p = null;
  if (typeof dbOrPath === 'string') {
    p = dbOrPath;
  } else if (dbOrPath && typeof dbOrPath.prepare === 'function') {
    p = getDatabaseFilePath(dbOrPath);
  }
  if (!p) return false;
  const resolved = path.resolve(p).toLowerCase();
  const prod = path.resolve('data', 'presuvoz.db').toLowerCase();
  if (process.env.PRESUVOZ_PRE015_REHEARSAL_DB) {
    const rehearsal = path.resolve(process.env.PRESUVOZ_PRE015_REHEARSAL_DB).toLowerCase();
    return resolved === prod || resolved === rehearsal;
  }
  return resolved === prod;
}

/**
 * Verifica que el linaje de migraciones sea estrictamente monotónico y sin huecos
 * antes de aplicar una migración específica.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} nextVersion
 * @returns {boolean}
 */
export function verifyMigrationLineage(db, nextVersion) {
  const applied = getAppliedMigrations(db).map(m => m.version);
  const expected = Array.from({ length: nextVersion - 1 }, (_, i) => i + 1);
  const isValid = applied.length === expected.length && applied.every((v, i) => v === expected[i]);
  if (!isValid) {
    throw new Error(`🛑 [LINEAGE GUARD] Infracción de linaje previa a migración ${nextVersion}: se esperaba [${expected.join(',')}], pero se encontró [${applied.join(',')}]`);
  }
  return true;
}

/**
 * Ejecuta todas las migraciones pendientes en estricto orden transaccional.
 * 
 * BARRERAS DE SEGURIDAD (FAIL-CLOSED):
 * - Ninguna importación o apertura accidental puede mutar la base de datos.
 * - Requiere autorización explícita (options.authorized === true || ALLOW_DATABASE_MIGRATIONS === 'true').
 * - Si es la base de datos de PRODUCCIÓN, requiere autorización de producción explícita (ALLOW_PRODUCTION_MIGRATIONS === 'true').
 * - Soporte para barrera de linaje estricto (options.enforceLineage === true).
 * 
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {Array} [options.migrations] Lista personalizada de migraciones
 * @param {number} [options.targetVersion] Versión máxima hasta la que migrar
 * @param {boolean} [options.authorized] Autorización explícita para ejecutar migraciones
 * @param {boolean} [options.allowProduction] Autorización explícita para ejecutar en producción
 * @param {boolean} [options.enforceLineage] Exigir linaje estricto sin huecos
 * @returns {{ appliedCount: number, appliedVersions: number[] }}
 */
export class MigrationIncidentError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = 'MigrationIncidentError';
    this.diagnostic = diagnostic;
  }
}

export function runMigrations(db, options = {}) {
  // 1. Barrera General: Por defecto NO migrar (Opening/inspecting a database must NEVER mutate its schema)
  const isAuthorized = options.authorized === true || (options.authorized !== false && process.env.ALLOW_DATABASE_MIGRATIONS === 'true');
  if (!isAuthorized) {
    throw new Error("🛑 [MIGRATION GUARD] Migraciones no autorizadas. 'Opening/inspecting a database must NEVER mutate its schema'. Se requiere autorización explícita para migrar (ALLOW_DATABASE_MIGRATIONS='true' o scripts/migrate.js).");
  }

  // 2. Barrera de Producción: Fail-closed estricto
  const isProd = isProductionDatabase(db);
  const allowProd = options.allowProduction === true || process.env.ALLOW_PRODUCTION_MIGRATIONS === 'true';
  if (isProd && !allowProd) {
    throw new Error("🛑 [MIGRATION GUARD CRÍTICO] Se ha detectado la base de datos de PRODUCCIÓN (data/presuvoz.db). Las migraciones en producción están bloqueadas salvo autorización explícita (ALLOW_PRODUCTION_MIGRATIONS='true').");
  }

  initMigrationTable(db);
  const migrationList = options.migrations || MIGRATIONS;
  const pending = getPendingMigrations(db, migrationList);

  const appliedVersions = [];

  for (const m of pending) {
    if (options.targetVersion && m.version > options.targetVersion) {
      break;
    }

    if (options.enforceLineage) {
      verifyMigrationLineage(db, m.version);
    }

    if (m.standaloneTransaction) {
      // Migración estructural canónica autónoma (gestiona su propio PRAGMA foreign_keys y transacción atómica)
      try {
        m.up(db);
        appliedVersions.push(m.version);
        console.log(`✅ [Migración ${m.version}] '${m.name}' aplicada con éxito.`);
      } catch (err) {
        console.error(`❌ [Migración ${m.version}] Fallo crítico al aplicar '${m.name}':`, err.message);
        let integrityOk = false;
        let fkViolations = -1;
        let versionsAfter = [];
        try {
          const integ = db.prepare('PRAGMA integrity_check;').get();
          integrityOk = integ && (integ.integrity_check === 'ok' || integ.integrity_check === 'OK');
          const fks = db.prepare('PRAGMA foreign_key_check;').all();
          fkViolations = fks.length;
          versionsAfter = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC;').all().map(r => r.version);
        } catch (_) {}

        // Matriz Formal D:
        // Si el rollback de 015 deja un estado exactamente equivalente al esperado antes de 015 y todas las verificaciones pasan: ABORT.
        // Si el estado no es inequívocamente seguro: RESTORE.
        const isSafeRollback = integrityOk && fkViolations === 0 && !versionsAfter.includes(m.version);
        const decision = isSafeRollback ? 'ABORT' : 'RESTORE';

        const incident = {
          phase: 'STANDALONE_TRANSACTION_FAILURE',
          versionAttempted: m.version,
          migrationName: m.name,
          rolledBack: true,
          versionsBefore: appliedVersions.slice(),
          versionsAfter,
          integrityOk,
          fkViolations,
          decision,
          originalError: err.message
        };

        const incidentErr = new MigrationIncidentError(
          `🛑 [MIGRATION FAILURE] Error en migración ${m.version} (${m.name}): ${err.message}. Decisión operativa: ${decision}.`,
          incident
        );
        throw incidentErr;
      }
    } else {
      // Ejecutar cada migración en su propia transacción atómica
      db.exec('BEGIN;');
      try {
        m.up(db);
        const now = new Date().toISOString();
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, now);
        db.exec('COMMIT;');
        appliedVersions.push(m.version);
        console.log(`✅ [Migración ${m.version}] '${m.name}' aplicada con éxito.`);
      } catch (err) {
        let rolledBack = false;
        try {
          db.exec('ROLLBACK;');
          rolledBack = true;
        } catch (rbErr) {
          console.error('⚠️ Error al hacer rollback de migración:', rbErr.message);
        }

        let integrityOk = false;
        let fkViolations = -1;
        let versionsAfter = [];
        try {
          const integ = db.prepare('PRAGMA integrity_check;').get();
          integrityOk = integ && (integ.integrity_check === 'ok' || integ.integrity_check === 'OK');
          const fks = db.prepare('PRAGMA foreign_key_check;').all();
          fkViolations = fks.length;
          versionsAfter = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC;').all().map(r => r.version);
        } catch (_) {}

        // Matriz Formal B:
        // Si la migración falla antes de COMMIT y ROLLBACK tiene éxito en estado conocido: DECISIÓN = ABORT.
        // Si el estado queda indeterminado o integridad corrupta: DECISIÓN = RESTORE.
        const isKnownSafe = rolledBack && integrityOk && fkViolations === 0 && !versionsAfter.includes(m.version);
        const decision = isKnownSafe ? 'ABORT' : 'RESTORE';

        const incident = {
          phase: 'TRANSACTIONAL_MIGRATION_FAILURE',
          versionAttempted: m.version,
          migrationName: m.name,
          rolledBack,
          versionsBefore: appliedVersions.slice(),
          versionsAfter,
          integrityOk,
          fkViolations,
          decision,
          originalError: err.message
        };

        console.error(`❌ [Migración ${m.version}] Fallo crítico al aplicar '${m.name}'. Decisión: ${decision}. Rolled back: ${rolledBack}. Integrity: ${integrityOk ? 'OK' : 'FAIL'}. FKs: ${fkViolations}`);
        const incidentErr = new MigrationIncidentError(
          `🛑 [MIGRATION FAILURE] Error en migración ${m.version} (${m.name}): ${err.message}. Decisión operativa: ${decision}.`,
          incident
        );
        throw incidentErr;
      }
    }
  }

  return {
    appliedCount: appliedVersions.length,
    appliedVersions
  };
}

/**
 * Realiza una validación exhaustiva post-migración del esquema y datos.
 * Criterio E: Si algo falla -> RESTORE.
 * Criterio F: Todo correcto -> CONTINUE.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} [expectedVersions]
 * @returns {{ success: boolean, decision: 'CONTINUE' | 'RESTORE', integrityOk: boolean, fkViolations: number, versionsOk: boolean, tablesOk: boolean, appliedVersions: number[] }}
 */
export function validatePostMigration(db, expectedVersions = Array.from({ length: 15 }, (_, i) => i + 1)) {
  const integrity = db.prepare('PRAGMA integrity_check;').get();
  const integrityOk = integrity && (integrity.integrity_check === 'ok' || integrity.integrity_check === 'OK');
  const fks = db.prepare('PRAGMA foreign_key_check;').all();
  const fksOk = fks.length === 0;
  const applied = getAppliedMigrations(db).map(m => m.version);
  const versionsOk = JSON.stringify(applied) === JSON.stringify(expectedVersions);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  const requiredTables = [
    'companies', 'channel_identities', 'users', 'memberships',
    'budgets', 'invoices', 'payments', 'payment_allocations',
    'appointments', 'shopping_items', 'business_tax_profiles',
    'fiscal_periods', 'purchase_invoices', 'expense_payments',
    'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'
  ];
  const tablesOk = requiredTables.every(t => tables.includes(t));

  const allOk = Boolean(integrityOk && fksOk && versionsOk && tablesOk);
  return {
    success: allOk,
    decision: allOk ? 'CONTINUE' : 'RESTORE',
    integrityOk: Boolean(integrityOk),
    fkViolations: fks.length,
    versionsOk,
    tablesOk,
    appliedVersions: applied
  };
}

