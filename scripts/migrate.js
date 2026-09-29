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
import { runMigrations, isProductionDatabase, initMigrationTable, getPendingMigrations } from '../src/migration_service.js';

const targetDbPath = process.env.PRESUVOZ_DB_PATH || path.resolve('data', 'presuvoz.db');
const isProd = isProductionDatabase(targetDbPath);
const allowProd = process.env.ALLOW_PRODUCTION_MIGRATIONS === 'true';

console.log('====================================================');
console.log(' PresuVoz — Gestor Controlado de Migraciones SQL');
console.log('====================================================');
console.log(`Base de datos objetivo: ${targetDbPath}`);
console.log(`¿Es producción?:       ${isProd ? 'SÍ (data/presuvoz.db)' : 'NO'}`);

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
const pending = getPendingMigrations(db);

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
  allowProduction: allowProd
});

db.close();
console.log(`\n✨ Éxito: ${result.appliedCount} migración/es aplicada/s correctamente.`);
console.log('====================================================');
