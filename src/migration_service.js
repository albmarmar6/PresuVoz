/**
 * PresuVoz — Migration Service (Motor Formal de Migraciones)
 * 
 * Gestiona la evolución del esquema relacional de SQLite de forma:
 * - Determinista y ordenada (por versión numérica ascendente).
 * - Idempotente (no repite migraciones ya aplicadas).
 * - Transaccional (BEGIN / COMMIT / ROLLBACK) para garantizar cero corrupción.
 * - Compatible con bases de datos nuevas y adopción de bases de datos existentes.
 */

import { migration as baselineMigration } from './migrations/001_baseline_schema.js';

export const MIGRATIONS = [
  baselineMigration
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
export function getAppliedMigrations(db) {
  initMigrationTable(db);
  return db.prepare('SELECT id, version, name, applied_at FROM schema_migrations ORDER BY version ASC').all();
}

/**
 * Obtiene las migraciones pendientes de aplicar.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array} [migrationList] Lista opcional de migraciones (por defecto MIGRATIONS)
 * @returns {Array} Migraciones pendientes ordenadas por versión
 */
export function getPendingMigrations(db, migrationList = MIGRATIONS) {
  const applied = getAppliedMigrations(db);
  const appliedVersions = new Set(applied.map(m => m.version));
  return migrationList
    .slice()
    .sort((a, b) => a.version - b.version)
    .filter(m => !appliedVersions.has(m.version));
}

/**
 * Ejecuta todas las migraciones pendientes en estricto orden transaccional.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {Array} [options.migrations] Lista personalizada de migraciones
 * @param {number} [options.targetVersion] Versión máxima hasta la que migrar
 * @returns {{ appliedCount: number, appliedVersions: number[] }}
 */
export function runMigrations(db, options = {}) {
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

/**
 * Revierte la última migración aplicada si tiene soporte de `down`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {Array} [options.migrations]
 * @returns {{ revertedVersion: number, name: string } | null}
 */
export function rollbackLastMigration(db, options = {}) {
  initMigrationTable(db);
  const migrationList = options.migrations || MIGRATIONS;
  const applied = getAppliedMigrations(db);
  if (applied.length === 0) return null;

  const lastApplied = applied[applied.length - 1];
  const migrationDef = migrationList.find(m => m.version === lastApplied.version);

  if (!migrationDef || typeof migrationDef.down !== 'function') {
    throw new Error(`La migración ${lastApplied.version} (${lastApplied.name}) no implementa método down para reversión.`);
  }

  db.exec('BEGIN;');
  try {
    migrationDef.down(db);
    db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(lastApplied.version);
    db.exec('COMMIT;');
    console.log(`↩️ [Migración ${lastApplied.version}] '${lastApplied.name}' revertida con éxito.`);
    return {
      revertedVersion: lastApplied.version,
      name: lastApplied.name
    };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (rbErr) {}
    console.error(`❌ Error al revertir migración ${lastApplied.version}:`, err.message);
    throw err;
  }
}
