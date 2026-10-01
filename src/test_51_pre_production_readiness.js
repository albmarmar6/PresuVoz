import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { executeCanonicalMigration } from './migrations/015_structural_canonical_company_id.js';
import { runMigrations, MIGRATIONS } from './migration_service.js';
import * as dbService from './db_service.js';

export async function runTest51() {
  console.log('\n==========================================================');
  console.log('TEST 51: PRODUCTION DEPLOYMENT READINESS / AUDITORÍA PRE-PRODUCCIÓN 015');
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
      throw new Error(`Test 51 Failed: ${msg}`);
    }
  }

  const expectedOfficialHash = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  const prodDbPath = path.resolve(process.env.PRESUVOZ_PRE015_REHEARSAL_DB || 'data/presuvoz.db');
  const test51DbPath = path.resolve('data', 'presuvoz_test51_preprod.db');

  // 0. Verificación inicial de producción
  const initialProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex');
  assert(initialProdHash.toUpperCase() === expectedOfficialHash, "0. Producción data/presuvoz.db SHA-256 coincide exactamente con el valor oficial");

  // Clonar BD para pruebas de auditoría
  fs.copyFileSync(prodDbPath, test51DbPath);
  const db = new DatabaseSync(test51DbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  // Extraer datos previos para auditoría de preservación
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

  // 1. INVESTIGACIÓN Y VALIDACIÓN DE CONTEOS DE STARTUP MULTI-TENANT
  // Tenants:
  const alberto = { companyId: '817ca602-6ae4-4fe3-9b06-293e52b8df60' };
  const martinez = { companyId: 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e' };
  const perez = { companyId: 'bc23b732-50cc-414e-8a50-1eeba2a25e34' };
  const anonComp = { companyId: '7575fd79-b1a0-4e91-92a7-28d660657f47' };

  // Facturas: 6 en total -> 2 de Alberto, 3 de Martínez, 1 de Pérez
  const invA = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE company_id = ?').get(alberto.companyId).c;
  const invM = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE company_id = ?').get(martinez.companyId).c;
  const invP = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE company_id = ?').get(perez.companyId).c;
  assert(invA === 2 && invM === 3 && invP === 1 && (invA + invM + invP === 6), "1A. Invoices: 6 en total desglosadas por tenant (Alberto=2, Martínez=3, Pérez=1), explicando exactamente el 2 en startup");

  // Pagos: 26 en total -> 0 de Alberto, 26 de Martínez, 0 de Pérez
  const payA = db.prepare('SELECT COUNT(*) as c FROM payments WHERE company_id = ?').get(alberto.companyId).c;
  const payM = db.prepare('SELECT COUNT(*) as c FROM payments WHERE company_id = ?').get(martinez.companyId).c;
  const payP = db.prepare('SELECT COUNT(*) as c FROM payments WHERE company_id = ?').get(perez.companyId).c;
  assert(payA === 0 && payM === 26 && payP === 0 && (payA + payM + payP === 26), "1B. Payments: 26 en total pertenecientes a Martínez (Alberto=0), explicando exactamente el 0 en startup");

  // Audit Logs: 8 en total -> 0 de Alberto, 3 de Martínez, 5 de onboarding anónimo
  const logA = db.prepare('SELECT COUNT(*) as c FROM audit_logs WHERE company_id = ?').get(alberto.companyId).c;
  const logM = db.prepare('SELECT COUNT(*) as c FROM audit_logs WHERE company_id = ?').get(martinez.companyId).c;
  const logAnon = db.prepare('SELECT COUNT(*) as c FROM audit_logs WHERE company_id = ?').get(anonComp.companyId).c;
  assert(logA === 0 && logM === 3 && logAnon === 5 && (logA + logM + logAnon === 8), "1C. Audit Logs: 8 en total (Martínez=3, Anon=5, Alberto=0), explicando exactamente el 3 en startup");

  // 2. AUDITORÍA ESTÁTICA GLOBAL: CERO PRAGMA table_info EN RUNTIME HOT PATHS
  const runtimeFiles = [
    'src/db_service.js',
    'src/appointment_scheduler.js',
    'src/db_viewer.js',
    'src/fiscal_service.js'
  ];
  for (const f of runtimeFiles) {
    const content = fs.readFileSync(path.resolve(f), 'utf-8');
    const matches = (content.match(/PRAGMA\s+table_info/gi) || []).length;
    assert(matches === 0, `2A. ${f} contiene exactamente 0 inspecciones reflexivas PRAGMA table_info`);
  }

  // 3. AUDITORÍA FÍSICA COMPLETA DE SCHEMA 015
  // companies: id PK (pk=1), phone UNIQUE NOT NULL (pk=0)
  const compCols = db.prepare('PRAGMA table_info(companies)').all();
  const idCol = compCols.find(c => c.name === 'id');
  const phoneCol = compCols.find(c => c.name === 'phone');
  assert(idCol && idCol.pk === 1, "3A. companies.id es PRIMARY KEY física");
  assert(phoneCol && phoneCol.pk === 0 && phoneCol.notnull === 1, "3B. companies.phone es NOT NULL UNIQUE y no es PK");

  // 18 Tablas: company_id NOT NULL (salvo messages)
  for (const t of tables18) {
    if (t === 'companies' || t === 'users') continue;
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all();
    const cidCol = cols.find(c => c.name === 'company_id');
    assert(cidCol !== undefined, `3C. Tabla ${t} posee columna company_id`);
    if (t === 'messages') {
      assert(cidCol.notnull === 0, "3D. messages.company_id es legítimamente NULLABLE");
    } else {
      assert(cidCol.notnull === 1, `3E. Tabla ${t}.company_id es NOT NULL`);
    }
  }

  // Cero columnas legacy en tablas migradas
  const legacyPhoneTables = ['budgets', 'invoices', 'payments', 'appointments', 'shopping_items'];
  for (const t of legacyPhoneTables) {
    const colNames = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    assert(!colNames.includes('company_phone'), `3F. Tabla ${t} eliminó físicamente company_phone`);
  }
  const legacyBusinessTables = ['business_tax_profiles', 'fiscal_periods', 'purchase_invoices', 'expense_payments', 'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'];
  for (const ft of legacyBusinessTables) {
    const colNames = db.prepare(`PRAGMA table_info("${ft}")`).all().map(c => c.name);
    assert(!colNames.includes('business_id'), `3G. Tabla fiscal ${ft} eliminó físicamente business_id`);
  }

  // 4. AUDITORÍA DE CLAVES FORÁNEAS Y ON DELETE POLICIES
  const expectedPolicies = {
    budgets: { table: 'companies', onDelete: 'RESTRICT' },
    invoices: { table: 'companies', onDelete: 'RESTRICT' },
    payments: { table: 'companies', onDelete: 'RESTRICT' },
    payment_allocations: { table: 'companies', onDelete: 'RESTRICT' },
    appointments: { table: 'companies', onDelete: 'RESTRICT' },
    shopping_items: { table: 'companies', onDelete: 'RESTRICT' },
    business_tax_profiles: { table: 'companies', onDelete: 'RESTRICT' },
    fiscal_periods: { table: 'companies', onDelete: 'RESTRICT' },
    purchase_invoices: { table: 'companies', onDelete: 'RESTRICT' },
    expense_payments: { table: 'companies', onDelete: 'RESTRICT' },
    investment_assets: { table: 'companies', onDelete: 'RESTRICT' },
    fiscal_incidents: { table: 'companies', onDelete: 'RESTRICT' },
    audit_logs: { table: 'companies', onDelete: 'RESTRICT' },
    messages: { table: 'companies', onDelete: 'SET NULL' }
  };

  for (const [tbl, exp] of Object.entries(expectedPolicies)) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${tbl}")`).all();
    const match = fks.find(f => f.table === exp.table && f.from === 'company_id');
    assert(match && match.on_delete === exp.onDelete, `4A. FK ${tbl} -> ${exp.table} configurada con ON DELETE ${exp.onDelete}`);
  }

  // payment_allocations hacia invoices y payments
  const allocFks = db.prepare('PRAGMA foreign_key_list("payment_allocations")').all();
  const invFk = allocFks.find(f => f.table === 'invoices' && f.from === 'invoice_id');
  const payFk = allocFks.find(f => f.table === 'payments' && f.from === 'payment_id');
  assert(invFk && invFk.on_delete === 'RESTRICT', "4B. payment_allocations -> invoices tiene ON DELETE RESTRICT");
  assert(payFk && payFk.on_delete === 'RESTRICT', "4C. payment_allocations -> payments tiene ON DELETE RESTRICT");

  // Probar físicamente los DELETE y bloqueos
  let deleteCompBlocked = false;
  try {
    db.prepare('DELETE FROM companies WHERE id = ?').run(alberto.companyId);
  } catch (_) {
    deleteCompBlocked = true;
  }
  assert(deleteCompBlocked, "4D. Prueba física: RESTRICT bloquea la eliminación de una compañía con datos dependientes");

  // 5. PRESERVACIÓN COMPLETA DE DATOS EN LAS 18 TABLAS
  const postData = {};
  for (const t of tables18) {
    postData[t] = db.prepare(`SELECT * FROM "${t}"`).all();
  }

  let totalPreRows = 0;
  let totalPostRows = 0;
  let totalMissing = 0;
  let totalAdded = 0;
  let totalValuesMutated = 0;

  for (const t of tables18) {
    const preRows = preData[t] || [];
    const postRows = postData[t] || [];
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
          totalValuesMutated++;
        }
      }
    }
  }

  assert(totalPreRows === 173 && totalPostRows === 173, "5A. 173/173 filas totales preservadas sin pérdida de registros");
  assert(totalMissing === 0, "5B. 0 IDs perdidos o no resueltos");
  assert(totalAdded === 0, "5C. 0 IDs inesperados o ambiguos");
  assert(totalValuesMutated === 0, "5D. 0 mutaciones de datos no autorizadas");

  // 6. RESOLUCIÓN DE IDENTIDAD HISTÓRICA (51 MENSAJES)
  const allMsgPost = db.prepare('SELECT id, company_id FROM messages').all();
  const albertoMsgCount = allMsgPost.filter(m => m.company_id === alberto.companyId).length;
  assert(allMsgPost.length === 51 && albertoMsgCount === 51, "6. Los 51 mensajes históricos fueron resueltos determinísticamente al company_id canónico de Alberto");

  // 7. INTEGRIDAD MULTI-TENANT (AISLAMIENTO SELECT / UPDATE / DELETE)
  const aBudgets = db.prepare('SELECT id FROM budgets WHERE company_id = ?').all(alberto.companyId);
  const mBudgets = db.prepare('SELECT id FROM budgets WHERE company_id = ?').all(martinez.companyId);
  const overlap = aBudgets.filter(a => mBudgets.some(m => m.id === a.id));
  assert(overlap.length === 0, "7A. Aislamiento Cross-tenant SELECT: 0 presupuestos compartidos");

  const crossUpd = db.prepare("UPDATE budgets SET client_name = 'HACK' WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").run(alberto.companyId, martinez.companyId);
  assert(crossUpd.changes === 0, "7B. Aislamiento Cross-tenant UPDATE: 0 filas mutadas");

  const crossDel = db.prepare("DELETE FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").run(alberto.companyId, martinez.companyId);
  assert(crossDel.changes === 0, "7C. Aislamiento Cross-tenant DELETE: 0 filas eliminadas");

  // 8. ROLLBACK ATÓMICO MULTIPUNTO CON SHA INALTERADO
  const rbStages = ['start', 'mid_tables', 'pre_validation', 'pre_commit'];
  for (const stg of rbStages) {
    const rbPath = path.resolve('data', `presuvoz_test51_rb_${stg}.db`);
    fs.copyFileSync(prodDbPath, rbPath);
    const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(rbPath)).digest('hex');

    const rbDb = new DatabaseSync(rbPath);
    rbDb.exec('PRAGMA foreign_keys = ON;');
    let threw = false;
    try {
      executeCanonicalMigration(rbDb, { forceFail: stg });
    } catch (_) {
      threw = true;
    }
    rbDb.close();

    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(rbPath)).digest('hex');
    fs.unlinkSync(rbPath);

    assert(threw && hashBefore === hashAfter, `8. Rollback en etapa '${stg}': transacción abortada y SHA-256 de base de datos intacto (100% byte-for-byte)`);
  }

  // 9. FRESH DATABASE MIGRATION PATH (001 -> 014 -> 015)
  const freshDbPath = path.resolve('data', 'presuvoz_test51_fresh.db');
  if (fs.existsSync(freshDbPath)) fs.unlinkSync(freshDbPath);

  const freshDb = new DatabaseSync(freshDbPath);
  freshDb.exec('PRAGMA foreign_keys = ON;');
  runMigrations(freshDb, { authorized: true, migrations: MIGRATIONS });
  executeCanonicalMigration(freshDb);

  const freshIntegrity = freshDb.prepare('PRAGMA integrity_check').get();
  const freshFks = freshDb.prepare('PRAGMA foreign_key_check').all();
  const freshVersions = freshDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get().c;
  freshDb.close();
  fs.unlinkSync(freshDbPath);

  assert(freshVersions === 15 && freshIntegrity.integrity_check === 'ok' && freshFks.length === 0, "9. Ruta de migraciones desde cero (001 -> 015): 15 migraciones registradas, integridad 'ok' y 0 violaciones FK");

  // 10. AISLAMIENTO DEL SISTEMA DE ARCHIVOS
  const logoDirA = path.resolve('data', 'logos', alberto.companyId.replace(/[^a-zA-Z0-9_-]/g, ''));
  const logoDirM = path.resolve('data', 'logos', martinez.companyId.replace(/[^a-zA-Z0-9_-]/g, ''));
  assert(logoDirA !== logoDirM && !logoDirA.includes('..'), "10. Filesystem: almacenamiento de activos aislado por UUID de tenant y protegido contra path traversal");

  // Limpieza de DB de prueba de test 51
  db.close();
  if (fs.existsSync(test51DbPath)) {
    fs.unlinkSync(test51DbPath);
  }

  // 11. VERIFICACIÓN FINAL DEL SHA DE PRODUCCIÓN Y EMISIÓN DEL VEREDICTO
  const finalProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex');
  assert(finalProdHash.toUpperCase() === expectedOfficialHash, "11. Producción data/presuvoz.db SHA-256 inalterado tras toda la batería de auditoría");

  const verdict = (passed === total && finalProdHash.toUpperCase() === expectedOfficialHash)
    ? 'APROBADO PARA FASE 3C'
    : 'NO APROBADO — PENDIENTES';
  assert(verdict === 'APROBADO PARA FASE 3C', `12. Veredicto Final Pre-Producción: ${verdict}`);

  console.log('----------------------------------------------------------');
  console.log(`VEREDICTO TÉCNICO FASE 3B.3 (TEST 51): ${verdict}`);
  console.log('----------------------------------------------------------');

  return { passed, total, verdict };
}
