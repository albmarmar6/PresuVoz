#!/usr/bin/env node
/**
 * PresuVoz — Dedicated Migration CLI Tool
 * 
 * Permite ejecutar formal y explícitamente las migraciones pendientes sobre la base de datos objetivo.
 * 
 * FAIL-CLOSED SAFETY GUARDS:
 * 1. Opening/inspecting a database must NEVER mutate its schema.
 * 2. Migrations require explicit execution via this script.
 * 3. Targeting production (data/presuvoz.db) REQUIRES ALLOW_PRODUCTION_MIGRATIONS='true'.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { runMigrations, isProductionDatabase, initMigrationTable, getPendingMigrations, checkMigrationsDryRun, MIGRATIONS_ALL } from '../src/migration_service.js';

const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('--check');
const targetDbPath = process.env.PRESUVOZ_DB_PATH || path.resolve('data', 'presuvoz.db');
const isProd = isProductionDatabase(targetDbPath);
const allowProd = process.env.ALLOW_PRODUCTION_MIGRATIONS === 'true';

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
  process.exit(1);
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

const result = runMigrations(db, {
  authorized: true,
  allowProduction: allowProd,
  migrations: MIGRATIONS_ALL,
  enforceLineage: true
});

db.close();
console.log(`\n✨ Éxito: ${result.appliedCount} migración/es aplicada/s correctamente.`);
console.log('====================================================');
