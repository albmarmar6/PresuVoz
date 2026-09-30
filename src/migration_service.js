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
  auditLogsMigration
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
  return resolved === prod;
}

/**
 * Ejecuta todas las migraciones pendientes en estricto orden transaccional.
 * 
 * BARRERAS DE SEGURIDAD (FAIL-CLOSED):
 * - Ninguna importación o apertura accidental puede mutar la base de datos.
 * - Requiere autorización explícita (options.authorized === true || ALLOW_DATABASE_MIGRATIONS === 'true').
 * - Si es la base de datos de PRODUCCIÓN, requiere autorización de producción explícita (ALLOW_PRODUCTION_MIGRATIONS === 'true').
 * 
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {Array} [options.migrations] Lista personalizada de migraciones
 * @param {number} [options.targetVersion] Versión máxima hasta la que migrar
 * @param {boolean} [options.authorized] Autorización explícita para ejecutar migraciones
 * @param {boolean} [options.allowProduction] Autorización explícita para ejecutar en producción
 * @returns {{ appliedCount: number, appliedVersions: number[] }}
 */
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
      try {
        db.exec('ROLLBACK;');
      } catch (rbErr) {
        console.error('⚠️ Error al hacer rollback de migración:', rbErr.message);
      }
      console.error(`❌ [Migración ${m.version}] Fallo crítico al aplicar '${m.name}':`, err.message);
      throw err;
    }
  }

  return {
    appliedCount: appliedVersions.length,
    appliedVersions
  };
}

