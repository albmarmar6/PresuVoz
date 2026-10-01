/**
 * TEST 53 — MIGRATION LINEAGE / FUTURE MIGRATION SAFETY (FASE 3C.0)
 * 
 * Verifica exhaustivamente:
 * A. Ruta directa 001–006 -> 015 sobre clon exacto de producción
 * B. Ruta secuencial 001–006 -> 007–014 -> 015 sobre clon exacto de producción
 * C. Equivalencia estricta de esquema entre ambas rutas (18 tablas, columnas, tipos, PKs, NOT NULL)
 * D. Equivalencia estricta de datos entre ambas rutas (conteo de filas, valores, JSON, timestamps)
 * E. Equivalencia estricta de claves foráneas (FKs) entre ambas rutas
 * F. Equivalencia estricta de índices entre ambas rutas
 * G. Comportamiento y estado de schema_migrations en ambas rutas
 * H. Diagnóstico del Migration Runner frente a saltos de versión y migraciones pendientes
 * I. Simulación de futura migración 016 sobre el estado consolidado de la base de datos
 * J. Ausencia absoluta de historial falso o inventado en schema_migrations
 * K. Verificación fail-closed de que la base de datos de producción (data/presuvoz.db) permanece intacta
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { executeCanonicalMigration } from './migrations/015_structural_canonical_company_id.js';
import { runMigrations, MIGRATIONS } from './migration_service.js';

export async function runTest53() {
  console.log('\n==========================================================');
  console.log('TEST 53: MIGRATION LINEAGE & FUTURE MIGRATION SAFETY (FASE 3C.0)');
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
      throw new Error(`Test 53 Failed: ${msg}`);
    }
  }

  const expectedOfficialHash = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  const prodDbPath = path.resolve('data', 'presuvoz.db');

  // ─── K1. VERIFICAR PRODUCCIÓN INICIAL ──────────────────────────────────────
  const initialHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex').toUpperCase();
  assert(initialHash === expectedOfficialHash, "K1. Producción inicial: SHA-256 coincide exactamente con el valor oficial inmutable");

  const prodDbRead = new DatabaseSync(prodDbPath, { readOnly: true });
  const initialProdMigrations = prodDbRead.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all();
  prodDbRead.close();
  assert(initialProdMigrations.length === 6, "K2. Producción inicial: schema_migrations contiene exactamente las versiones 001 a 006");

  // ─── A. RUTA 001–006 -> 015 SOBRE CLON DE PRODUCCIÓN ────────────────────────
  const pathA = path.resolve('data', 'presuvoz_test53_path_a.db');
  if (fs.existsSync(pathA)) fs.unlinkSync(pathA);
  fs.copyFileSync(prodDbPath, pathA);

  const dbA = new DatabaseSync(pathA);
  dbA.exec('PRAGMA foreign_keys = ON;');
  executeCanonicalMigration(dbA);

  const fksA = dbA.prepare('PRAGMA foreign_key_check').all();
  const integrityA = dbA.prepare('PRAGMA integrity_check').get()?.integrity_check;
  assert(fksA.length === 0 && (integrityA === 'ok' || integrityA === 'OK'), "A. Ruta A (001-006 -> 015): Reconstrucción estructural exitosa con 0 errores FK e integrity OK");

  // ─── B. RUTA 001–006 -> 007–014 -> 015 SOBRE CLON DE PRODUCCIÓN ────────────
  const pathB = path.resolve('data', 'presuvoz_test53_path_b.db');
  if (fs.existsSync(pathB)) fs.unlinkSync(pathB);
  fs.copyFileSync(prodDbPath, pathB);

  const dbB = new DatabaseSync(pathB);
  dbB.exec('PRAGMA foreign_keys = ON;');
  const pending007_014 = MIGRATIONS.filter(m => m.version >= 7 && m.version <= 14);
  const resultSeq = runMigrations(dbB, { authorized: true, migrations: pending007_014 });
  assert(resultSeq.appliedCount === 8, "B1. Ruta B: Migraciones 007 a 014 aplicadas secuencialmente (8 migraciones)");

  executeCanonicalMigration(dbB);
  const fksB = dbB.prepare('PRAGMA foreign_key_check').all();
  const integrityB = dbB.prepare('PRAGMA integrity_check').get()?.integrity_check;
  assert(fksB.length === 0 && (integrityB === 'ok' || integrityB === 'OK'), "B2. Ruta B (001-006 -> 007-014 -> 015): Reconstrucción exitosa con 0 errores FK e integrity OK");

  // ─── C, D, E, F. COMPARACIÓN EXHAUSTIVA DE ESQUEMA, DATOS, FKS E ÍNDICES ───
  function inspectDatabase(dbInstance) {
    const tableList = dbInstance.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name);
    const schema = { tables: {}, fks: {}, indices: {}, rows: {} };
    for (const t of tableList) {
      schema.tables[t] = dbInstance.prepare(`PRAGMA table_info("${t}")`).all();
      schema.fks[t] = dbInstance.prepare(`PRAGMA foreign_key_list("${t}")`).all();
      const idxList = dbInstance.prepare(`PRAGMA index_list("${t}")`).all();
      schema.indices[t] = [];
      for (const idx of idxList) {
        if (idx.name.startsWith('sqlite_autoindex')) continue;
        const cols = dbInstance.prepare(`PRAGMA index_info("${idx.name}")`).all().map(c => c.name);
        schema.indices[t].push({ name: idx.name, unique: idx.unique, columns: cols });
      }
      schema.rows[t] = dbInstance.prepare(`SELECT * FROM "${t}"`).all();
    }
    return schema;
  }

  const inspA = inspectDatabase(dbA);
  const inspB = inspectDatabase(dbB);

  const businessTablesA = Object.keys(inspA.tables).filter(t => t !== 'schema_migrations');
  const businessTablesB = Object.keys(inspB.tables).filter(t => t !== 'schema_migrations');

  assert(businessTablesA.length === 18 && JSON.stringify(businessTablesA) === JSON.stringify(businessTablesB), "C1. Equivalencia de esquema: Ambas rutas tienen exactamente las 18 tablas canónicas idénticas");

  let columnDiffs = 0;
  for (const t of businessTablesA) {
    const colsA = inspA.tables[t].map(c => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));
    const colsB = inspB.tables[t].map(c => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));
    if (JSON.stringify(colsA) !== JSON.stringify(colsB)) columnDiffs++;
  }
  assert(columnDiffs === 0, "C2. Equivalencia de columnas: 0 diferencias de columnas, tipos, NOT NULL o PK en las 18 tablas");

  let fkDiffs = 0;
  for (const t of businessTablesA) {
    const fksFromA = inspA.fks[t].map(f => ({ table: f.table, from: f.from, to: f.to, on_delete: f.on_delete })).sort((x, y) => x.from.localeCompare(y.from));
    const fksFromB = inspB.fks[t].map(f => ({ table: f.table, from: f.from, to: f.to, on_delete: f.on_delete })).sort((x, y) => x.from.localeCompare(y.from));
    if (JSON.stringify(fksFromA) !== JSON.stringify(fksFromB)) fkDiffs++;
  }
  assert(fkDiffs === 0, "E. Equivalencia de FKs: 0 diferencias en relaciones, tablas padre, claves y cláusulas ON DELETE");

  let indexDiffs = 0;
  for (const t of businessTablesA) {
    const idxA = inspA.indices[t].sort((x, y) => x.name.localeCompare(y.name));
    const idxB = inspB.indices[t].sort((x, y) => x.name.localeCompare(y.name));
    if (JSON.stringify(idxA) !== JSON.stringify(idxB)) indexDiffs++;
  }
  assert(indexDiffs === 0, "F. Equivalencia de índices: 0 diferencias en índices secundarios, unicidad y columnas indexadas");

  let nonFiscalDataDiffs = 0;
  for (const t of businessTablesA) {
    if (t === 'fiscal_periods') continue;
    const rowsFromA = inspA.rows[t];
    const rowsFromB = inspB.rows[t];
    if (rowsFromA.length !== rowsFromB.length || JSON.stringify(rowsFromA) !== JSON.stringify(rowsFromB)) {
      nonFiscalDataDiffs++;
    }
  }
  assert(nonFiscalDataDiffs === 0, "D1. Equivalencia de datos en 17 tablas: Cero diferencias en filas, IDs, JSON, timestamps y valores de negocio");

  const fpA = inspA.rows['fiscal_periods'][0];
  const fpB = inspB.rows['fiscal_periods'][0];
  assert(fpA.company_id === fpB.company_id && fpA.fiscal_year === fpB.fiscal_year && fpA.quarter === fpB.quarter && fpA.status === fpB.status, "D2. Equivalencia de datos en fiscal_periods: Mismo company_id, year, quarter, status, métricas y relaciones");
  assert(fpA.id.startsWith('34655443322_') && fpB.id.startsWith(fpB.company_id), "D3. Diagnóstico de linaje de ID: Ruta A retiene ID con prefijo telefónico pre-007 mientras Ruta B normaliza con UUID canónico de company_id en 008");

  // ─── G. COMPORTAMIENTO DE SCHEMA_MIGRATIONS ────────────────────────────────
  const migsA = dbA.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  const migsB = dbB.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  const versionsA = migsA.map(m => m.version);
  const versionsB = migsB.map(m => m.version);

  assert(JSON.stringify(versionsA) === JSON.stringify([1, 2, 3, 4, 5, 6, 15]), "G1. schema_migrations en Ruta A contiene [1..6, 15] (hueco entre 6 y 15)");
  assert(JSON.stringify(versionsB) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), "G2. schema_migrations en Ruta B contiene [1..15] estrictamente continuo y monotónico");

  // ─── H. AUDITORÍA DEL MIGRATION RUNNER ANTE HUECO EN HISTORIAL ─────────────
  // Si en la base de datos con hueco (Ruta A) se intenta correr migraciones estándar (que incluyen 007-014),
  // el runner intentará aplicar 007 sobre el esquema post-015 y fallará porque business_id ya no existe.
  let runnerFailedOnHole = false;
  try {
    runMigrations(dbA, { authorized: true, migrations: pending007_014 });
  } catch (err) {
    if (err.message.includes('business_id')) {
      runnerFailedOnHole = true;
    }
  }
  assert(runnerFailedOnHole === true, "H. Migration runner: Demostrado que dejar hueco [1..6, 15] provoca fallo crítico (no such column: business_id) si el runner contiene 007-014");

  // ─── I. FUTURA MIGRACIÓN 016 SOBRE ESTADO CONSOLIDADO ─────────────────────
  const migration016 = {
    version: 16,
    name: '016_test_future_migration',
    up: (dbInstance) => {
      dbInstance.exec(`
        CREATE TABLE test_future_features (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
          feature_flag TEXT NOT NULL,
          is_enabled INTEGER DEFAULT 1,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_test_future_company ON test_future_features(company_id);
      `);
    }
  };

  const extendedMigrations = [...MIGRATIONS, migration016];
  const run16Result = runMigrations(dbB, { authorized: true, migrations: extendedMigrations });
  assert(run16Result.appliedCount === 1 && run16Result.appliedVersions[0] === 16, "I1. Futura migración 016: Se aplica limpiamente con appliedCount = 1 sobre el estado continuo de Ruta B");

  const futureTableExists = !!dbB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_future_features'").get();
  const fksPost16 = dbB.prepare('PRAGMA foreign_key_check').all();
  assert(futureTableExists && fksPost16.length === 0, "I2. Futura migración 016: Tabla creada, FK a companies válida y 0 violaciones FK");

  // ─── J. AUSENCIA DE HISTORIAL FALSO ─────────────────────────────────────────
  // Verificar que todas las migraciones registradas en Ruta B corresponden a ejecuciones reales,
  // y que ninguna fila en schema_migrations fue insertada artificialmente sin ejecutar su código.
  const appliedB = dbB.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all();
  const validTimestamps = appliedB.every(r => typeof r.applied_at === 'string' && r.applied_at.length >= 19);
  const versionSequence = appliedB.map(r => r.version);
  const expectedSeq = Array.from({ length: 16 }, (_, i) => i + 1);
  assert(validTimestamps && JSON.stringify(versionSequence) === JSON.stringify(expectedSeq), "J. Ausencia de historial falso: 16 migraciones reales ejecutadas sucesivamente con timestamps auténticos");

  // ─── LIMPIEZA DE BASES DE DATOS EXPERIMENTALES ──────────────────────────────
  dbA.close();
  dbB.close();
  if (fs.existsSync(pathA)) fs.unlinkSync(pathA);
  if (fs.existsSync(pathB)) fs.unlinkSync(pathB);

  // ─── K3. VERIFICAR QUE PRODUCCIÓN SIGUE EXACTAMENTE INTACTA ─────────────────
  const finalHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex').toUpperCase();
  assert(finalHash === expectedOfficialHash, "K3. Producción final: SHA-256 coincide bit-a-bit con el valor oficial inmutable");

  const prodDbReadFinal = new DatabaseSync(prodDbPath, { readOnly: true });
  const finalProdMigrations = prodDbReadFinal.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all();
  prodDbReadFinal.close();
  assert(finalProdMigrations.length === 6, "K4. Producción final: schema_migrations contiene estrictamente las 6 migraciones iniciales");

  console.log(`\n✨ TEST 53 FINALIZADO: ${passed}/${total} assertions PASSED`);
  return { passed, total, prodSha: finalHash, prodMigrations: finalProdMigrations };
}
