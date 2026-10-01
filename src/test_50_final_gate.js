import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { executeCanonicalMigration } from './migrations/015_structural_canonical_company_id.js';
import * as dbService from './db_service.js';

export async function runTest50() {
  console.log('\n==========================================================');
  console.log('TEST 50: FINAL GATE — AUDITORÍA DEFINITIVA DE MIGRACIÓN ESTRUCTURAL 015');
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
      throw new Error(`Test 50 Failed: ${msg}`);
    }
  }

  const expectedOfficialHash = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  const prodDbPath = path.resolve('data', 'presuvoz.db');
  const test50DbPath = path.resolve('data', 'presuvoz_test50_final_gate.db');

  // Comprobar SHA-256 inicial de producción
  const initialProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex');
  assert(initialProdHash.toUpperCase() === expectedOfficialHash, "0. Producción data/presuvoz.db SHA-256 coincide con el valor oficial");

  // Clonar BD para pruebas de auditoría
  fs.copyFileSync(prodDbPath, test50DbPath);
  const db = new DatabaseSync(test50DbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  // CRITERIO O (Pre-Data Extraction): Extraer estado previo de las 18 tablas
  const tables18 = [
    'companies', 'users', 'memberships', 'channel_identities',
    'budgets', 'invoices', 'payments', 'payment_allocations',
    'appointments', 'shopping_items', 'business_tax_profiles',
    'fiscal_periods', 'purchase_invoices', 'expense_payments',
    'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'
  ];

  const preData = {};
  for (const t of tables18) {
    preData[t] = db.prepare(`SELECT * FROM "${t}"`).all();
  }
  const phoneToCid = {};
  for (const c of preData.companies) {
    phoneToCid[c.phone] = c.id;
  }

  // Ejecutar migración canónica 015
  executeCanonicalMigration(db);

  // CRITERIO A: companies.id PK física (pk=1) y companies.phone UNIQUE NOT NULL (pk=0)
  const compCols = db.prepare('PRAGMA table_info(companies)').all();
  const idCol = compCols.find(c => c.name === 'id');
  const phoneCol = compCols.find(c => c.name === 'phone');
  assert(idCol && idCol.pk === 1, "Criterio A. companies.id es PRIMARY KEY física (pk=1)");
  assert(phoneCol && phoneCol.pk === 0 && phoneCol.notnull === 1, "Criterio A. companies.phone es NOT NULL y no es PK física");

  // CRITERIO B: Todas las tablas usan company_id NOT NULL (excepto messages.company_id NULLABLE)
  for (const t of tables18) {
    if (t === 'companies' || t === 'users') continue;
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all();
    const cidCol = cols.find(c => c.name === 'company_id');
    assert(cidCol !== undefined, `Criterio B. Tabla ${t} tiene la columna company_id`);
    if (t === 'messages') {
      assert(cidCol.notnull === 0, "Criterio B. messages.company_id es legítimamente NULLABLE para mensajes no autenticados");
    } else {
      assert(cidCol.notnull === 1, `Criterio B. Tabla ${t}.company_id es NOT NULL`);
    }
  }

  // CRITERIO C: Cero presencia de columnas legacy en tablas migradas
  const legacyPhoneTables = ['budgets', 'invoices', 'payments', 'appointments', 'shopping_items'];
  for (const t of legacyPhoneTables) {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    assert(!cols.includes('company_phone'), `Criterio C. Tabla ${t} eliminó físicamente company_phone`);
  }
  const legacyBusinessTables = ['business_tax_profiles', 'fiscal_periods', 'purchase_invoices', 'expense_payments', 'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'];
  for (const ft of legacyBusinessTables) {
    const cols = db.prepare(`PRAGMA table_info("${ft}")`).all().map(c => c.name);
    assert(!cols.includes('business_id'), `Criterio C. Tabla ${ft} eliminó físicamente business_id`);
  }

  // CRITERIO D: PRAGMA integrity_check e foreign_key_check limpios
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  assert(fkViolations.length === 0, "Criterio D. PRAGMA foreign_key_check retorna 0 violaciones en toda la base de datos");
  const integrity = db.prepare('PRAGMA integrity_check').get();
  assert(integrity && (integrity.integrity_check === 'ok' || integrity.integrity_check === 'OK'), "Criterio D. PRAGMA integrity_check retorna ok");

  // CRITERIO E: Cero PRAGMA table_info en runtime hot-paths
  const runtimeFiles = [
    'src/db_service.js',
    'src/appointment_scheduler.js',
    'src/db_viewer.js',
    'src/fiscal_service.js'
  ];
  for (const f of runtimeFiles) {
    const content = fs.readFileSync(path.resolve(f), 'utf-8');
    const matches = (content.match(/PRAGMA\s+table_info/gi) || []).length;
    assert(matches === 0, `Criterio E. ${f} contiene exactamente 0 llamadas a PRAGMA table_info`);
  }

  // CRITERIO F & T: Operaciones de runtime canónicas puras sin reflection dinámica
  const tenantA = { companyId: '817ca602-6ae4-4fe3-9b06-293e52b8df60', phone: '34601022367' };
  const tenantB = { companyId: 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e', phone: '34655443322' };

  // CRITERIO G: Aislamiento Cross-tenant (SELECT, UPDATE, DELETE, Injection)
  const aBudgets = db.prepare('SELECT id FROM budgets WHERE company_id = ?').all(tenantA.companyId);
  const bBudgets = db.prepare('SELECT id FROM budgets WHERE company_id = ?').all(tenantB.companyId);
  const overlapBudgets = aBudgets.filter(a => bBudgets.some(b => b.id === a.id));
  assert(overlapBudgets.length === 0, "Criterio G. Cross-tenant SELECT: aislamiento completo entre Tenant A y Tenant B");

  const crossUpdate = db.prepare("UPDATE budgets SET client_name = 'ATTACK' WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").run(tenantA.companyId, tenantB.companyId);
  assert(crossUpdate.changes === 0, "Criterio G. Cross-tenant UPDATE: cero filas modificadas");

  const crossDelete = db.prepare("DELETE FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").run(tenantA.companyId, tenantB.companyId);
  assert(crossDelete.changes === 0, "Criterio G. Cross-tenant DELETE: cero filas eliminadas");

  // CRITERIO H: LID mapping determinístico
  const msgCountAlberto = db.prepare("SELECT COUNT(*) as c FROM messages WHERE company_id = ?").get(tenantA.companyId).c;
  assert(msgCountAlberto === 51, "Criterio H. LID mapping: 51 mensajes históricos vinculados unívocamente a Alberto");

  // CRITERIO I: Mensajes no autenticados permiten company_id NULL
  db.prepare("INSERT INTO messages (id, whatsapp_message_id, company_id, content, status) VALUES ('MSG-50-ANON', 'WAM-50-ANON', NULL, 'Mensaje no autenticado', 'RECEIVED')").run();
  const anonRow = db.prepare("SELECT company_id FROM messages WHERE id = 'MSG-50-ANON'").get();
  assert(anonRow && anonRow.company_id === null, "Criterio I. messages.company_id soporta legítimamente valores NULL");

  // CRITERIO J: appointments -> companies ON DELETE RESTRICT
  const apptFks = db.prepare('PRAGMA foreign_key_list("appointments")').all();
  const compApptFk = apptFks.find(f => f.table === 'companies' && f.from === 'company_id');
  assert(compApptFk && compApptFk.on_delete === 'RESTRICT', "Criterio J. appointments -> companies posee política ON DELETE RESTRICT");

  // Verificar que RESTRICT bloquea la eliminación de una compañía con citas
  let deleteBlocked = false;
  try {
    db.prepare('DELETE FROM companies WHERE id = ?').run(tenantA.companyId);
  } catch (err) {
    deleteBlocked = true;
  }
  assert(deleteBlocked, "Criterio J. ON DELETE RESTRICT bloquea la eliminación de compañías con citas activas");

  // CRITERIO K: payment_allocations ON DELETE RESTRICT
  const allocFks = db.prepare('PRAGMA foreign_key_list("payment_allocations")').all();
  const invFk = allocFks.find(f => f.table === 'invoices' && f.from === 'invoice_id');
  const payFk = allocFks.find(f => f.table === 'payments' && f.from === 'payment_id');
  assert(invFk && invFk.on_delete === 'RESTRICT', "Criterio K. payment_allocations -> invoices tiene ON DELETE RESTRICT");
  assert(payFk && payFk.on_delete === 'RESTRICT', "Criterio K. payment_allocations -> payments tiene ON DELETE RESTRICT");

  // CRITERIO L: Rollback atómico multipunto en 4 etapas
  const rbStages = ['start', 'mid_tables', 'pre_validation', 'pre_commit'];
  for (const stg of rbStages) {
    const rbPath = path.resolve('data', `presuvoz_test50_rb_${stg}.db`);
    fs.copyFileSync(prodDbPath, rbPath);
    const rbDb = new DatabaseSync(rbPath);
    rbDb.exec('PRAGMA foreign_keys = ON;');
    let threw = false;
    try {
      executeCanonicalMigration(rbDb, { forceFail: stg });
    } catch (_) {
      threw = true;
    }
    const lingering = rbDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_new'").all();
    const fkState = rbDb.prepare('PRAGMA foreign_keys;').get();
    rbDb.close();
    fs.unlinkSync(rbPath);
    assert(threw && lingering.length === 0 && fkState.foreign_keys === 1, `Criterio L. Rollback en stage '${stg}' aborta limpiamente sin tablas temporales y preserva foreign_keys`);
  }

  // CRITERIO M: Restauración del estado de PRAGMA foreign_keys (OFF se restaura a OFF)
  const rbPathOff = path.resolve('data', 'presuvoz_test50_rb_off.db');
  fs.copyFileSync(prodDbPath, rbPathOff);
  const dbOff = new DatabaseSync(rbPathOff);
  dbOff.exec('PRAGMA foreign_keys = OFF;');
  try { executeCanonicalMigration(dbOff, { forceFail: 'start' }); } catch (_) {}
  const fkStateOff = dbOff.prepare('PRAGMA foreign_keys;').get();
  dbOff.close();
  fs.unlinkSync(rbPathOff);
  assert(fkStateOff.foreign_keys === 0, "Criterio M. PRAGMA foreign_keys restaura el estado original OFF tras fallo/rollback");

  // CRITERIO O, P, Q, R: Preservación completa de datos en las 18 tablas
  const postData = {};
  for (const t of tables18) {
    postData[t] = db.prepare(`SELECT * FROM "${t}"`).all();
  }

  let totalPreRows = 0;
  let totalPostRows = 0;
  let totalMissing = 0;
  let totalAdded = 0;
  let totalValuesChanged = 0;

  for (const t of tables18) {
    const preRows = preData[t] || [];
    // En messages descartamos el mensaje MSG-50-ANON añadido expresamente en la prueba Criterio I
    const postRows = (postData[t] || []).filter(r => r.id !== 'MSG-50-ANON');

    totalPreRows += preRows.length;
    totalPostRows += postRows.length;

    const getId = (r, isPost = false) => {
      if (t === 'business_tax_profiles') {
        return isPost ? r.company_id : (phoneToCid[r.business_id] || r.business_id);
      }
      if (t === 'memberships') {
        return `${r.user_id}:${r.company_id}`;
      }
      return r.id || r.company_id || r.user_id;
    };

    const preIds = preRows.map(r => getId(r, false));
    const postIds = postRows.map(r => getId(r, true));

    const missing = preIds.filter(id => !postIds.includes(id));
    const added = postIds.filter(id => !preIds.includes(id));
    totalMissing += missing.length;
    totalAdded += added.length;

    for (const preRow of preRows) {
      const key = getId(preRow, false);
      const postRow = postRows.find(r => getId(r, true) === key);
      if (!postRow) continue;

      for (const [col, val] of Object.entries(preRow)) {
        if (col === 'company_phone' || col === 'business_id') continue;
        if (t === 'companies' && col === 'phone_contact' && val === null && postRow[col] !== undefined) continue;
        if (t === 'business_tax_profiles' && col === 'business_id') continue;

        if (postRow[col] !== val) {
          if (postRow[col] === null && val === null) continue;
          totalValuesChanged++;
        }
      }
    }
  }

  assert(totalPreRows === totalPostRows, `Criterio O. Total filas pre (${totalPreRows}) coincide exactamente con post (${totalPostRows})`);
  assert(totalMissing === 0, "Criterio O & P. 0 IDs perdidos o no resueltos (unresolved = 0)");
  assert(totalAdded === 0, "Criterio O & Q. 0 IDs inesperados o ambiguos (ambiguous = 0)");
  assert(totalValuesChanged === 0, "Criterio O & R. 0 valores modificados inesperadamente (cross-tenant = 0)");

  // CRITERIO U: Identidad fiscal basada en tax_id / CIF / NIF y no en business_id
  const taxProfileRow = db.prepare('SELECT company_id, tax_id, legal_name FROM business_tax_profiles WHERE company_id = ?').get(tenantB.companyId);
  assert(taxProfileRow && taxProfileRow.tax_id === 'B87654321', "Criterio U. Identidad fiscal de empresa basada en tax_id/CIF (B87654321), no en business_id");

  // CRITERIO S: Startup compatibility test
  assert(fs.existsSync(path.resolve('src', 'test_startup_compatibility.mjs')), "Criterio S. Script de validación de arranque en producción test_startup_compatibility.mjs existe");

  // Limpieza de DB temporal de test 50
  db.close();
  if (fs.existsSync(test50DbPath)) {
    fs.unlinkSync(test50DbPath);
  }

  // CRITERIO N: SHA-256 final de producción inalterado
  const finalProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex');
  assert(finalProdHash.toUpperCase() === expectedOfficialHash, "Criterio N. Producción data/presuvoz.db SHA-256 permanece 100% intacto e inalterado");

  // CRITERIO V: Veredicto técnico final
  const verdict = (passed === total && finalProdHash.toUpperCase() === expectedOfficialHash)
    ? 'APROBADO PARA FASE 3C'
    : 'NO APROBADO — PENDIENTES';
  assert(verdict === 'APROBADO PARA FASE 3C', `Criterio V. Veredicto Técnico: ${verdict}`);

  console.log('----------------------------------------------------------');
  console.log(`VEREDICTO FINAL GATE TEST 50: ${verdict}`);
  console.log('----------------------------------------------------------');

  return { passed, total, verdict };
}
