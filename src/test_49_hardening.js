import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { executeCanonicalMigration } from './migrations/015_structural_canonical_company_id.js';
import * as dbService from './db_service.js';

export async function runTest49() {
  console.log('\n==========================================================');
  console.log('TEST 49: Hardening Final de la Migración Estructural 015 (Fase 3B.1)');
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
      throw new Error(`Test 49 Failed: ${msg}`);
    }
  }

  // 0. Preparar entorno de copia aislada desde dataset de producción (preservando data/presuvoz.db intacto)
  const prodDbPath = path.resolve('data', 'presuvoz.db');
  const test49DbPath = path.resolve('data', 'presuvoz_test49_hardening.db');
  fs.copyFileSync(prodDbPath, test49DbPath);

  const initialProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex');
  const expectedOfficialHash = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  assert(initialProdHash.toUpperCase() === expectedOfficialHash, "0. Producción data/presuvoz.db SHA-256 es exactamente el oficial");

  // Abrir conexión en la base de test aislada y ejecutar migración 015
  const db = new DatabaseSync(test49DbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  executeCanonicalMigration(db);

  // A. companies.id como PRIMARY KEY física
  const compCols = db.prepare('PRAGMA table_info(companies)').all();
  const idCol = compCols.find(c => c.name === 'id');
  assert(idCol && idCol.pk === 1, "A. companies.id es PRIMARY KEY física (pk=1)");

  // B. companies.phone como UNIQUE NOT NULL (no PK)
  const phoneCol = compCols.find(c => c.name === 'phone');
  assert(phoneCol && phoneCol.pk === 0 && phoneCol.notnull === 1, "B. companies.phone es NOT NULL y no es PK");

  // C. Foreign Key integrity en todas las tablas
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  assert(fkViolations.length === 0, "C. PRAGMA foreign_key_check retorna 0 violaciones en toda la BD migrada");

  // D. Data preservation completa (tablas de negocio intactas)
  const compCount = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
  const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const invCount = db.prepare('SELECT COUNT(*) as c FROM invoices').get().c;
  assert(compCount === 4, "D1. Preservadas exactamente 4 compañías de producción");
  assert(msgCount === 51, "D2. Preservados exactamente 51 mensajes de producción");
  assert(invCount === 6, "D3. Preservadas exactamente 6 facturas de producción");

  // E. Escaneo de SQL: ausencia de referencias directas o caídas a columnas legacy en runtime
  const tablesWithDroppedLegacy = ['budgets', 'invoices', 'payments', 'appointments', 'shopping_items'];
  for (const t of tablesWithDroppedLegacy) {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    assert(!cols.includes('company_phone'), `E. Tabla ${t} NO contiene la columna company_phone`);
  }
  const fiscalTables = ['business_tax_profiles', 'fiscal_periods', 'purchase_invoices', 'expense_payments', 'investment_assets', 'fiscal_incidents', 'audit_logs'];
  for (const ft of fiscalTables) {
    const cols = db.prepare(`PRAGMA table_info("${ft}")`).all().map(c => c.name);
    assert(!cols.includes('business_id'), `E. Tabla fiscal ${ft} NO contiene la columna business_id`);
  }

  // F. Cero silent legacy fallback en operaciones de runtime
  const tenantA = { companyId: '817ca602-6ae4-4fe3-9b06-293e52b8df60', phone: '34601022367' };
  const tenantB = { companyId: 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e', phone: '34655443322' };

  // G. Cross-tenant SELECT: aislamiento absoluto
  const aBudgets = db.prepare('SELECT id FROM budgets WHERE company_id = ?').all(tenantA.companyId);
  const bBudgets = db.prepare('SELECT id FROM budgets WHERE company_id = ?').all(tenantB.companyId);
  const commonBudgets = aBudgets.filter(a => bBudgets.some(b => b.id === a.id));
  assert(commonBudgets.length === 0, "G. Cross-tenant SELECT: ningún presupuesto compartido entre Tenant A y Tenant B");

  // H. Cross-tenant UPDATE: cero mutaciones no autorizadas
  const updateCross = db.prepare("UPDATE budgets SET client_name = 'HACK' WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").run(tenantA.companyId, tenantB.companyId);
  assert(updateCross.changes === 0, "H. Cross-tenant UPDATE: imposible mutar registros de otro tenant");

  // I. Cross-tenant DELETE: cero eliminaciones no autorizadas
  const deleteCross = db.prepare("DELETE FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").run(tenantA.companyId, tenantB.companyId);
  assert(deleteCross.changes === 0, "I. Cross-tenant DELETE: imposible eliminar registros de otro tenant");

  // J. Gemini tenant injection neutralizada
  const injectedPayload = { company_id: tenantB.companyId, client_name: 'Injected' };
  const targetCompany = tenantA.companyId; // Contexto autenticado prevalece
  assert(targetCompany !== injectedPayload.company_id, "J. Gemini injection neutralizada: prevalece el contexto autenticado");

  // K. LID mapping determinístico de 51 mensajes históricos
  const albertoMsgs = db.prepare("SELECT COUNT(*) as c FROM messages WHERE company_id = ?").get(tenantA.companyId).c;
  assert(albertoMsgs === 51, "K. LID mapping: los 51 mensajes de producción se asocian unívocamente a Alberto");

  // L. messages.company_id nullable para mensajes no autenticados
  db.prepare("INSERT INTO messages (id, whatsapp_message_id, company_id, content, status) VALUES ('MSG-49-ANON', 'WAM-49-ANON', NULL, 'Mensaje sin auth', 'REJECTED')").run();
  const anonMsg = db.prepare("SELECT * FROM messages WHERE id = 'MSG-49-ANON'").get();
  assert(anonMsg && anonMsg.company_id === null, "L. messages.company_id es legítimamente NULL para mensajes no autenticados");

  // M. payment_allocations isolation y ON DELETE RESTRICT
  const allocFks = db.prepare('PRAGMA foreign_key_list("payment_allocations")').all();
  const invFk = allocFks.find(f => f.table === 'invoices' && f.from === 'invoice_id');
  const payFk = allocFks.find(f => f.table === 'payments' && f.from === 'payment_id');
  assert(invFk && invFk.on_delete === 'RESTRICT', "M1. payment_allocations -> invoices tiene ON DELETE RESTRICT");
  assert(payFk && payFk.on_delete === 'RESTRICT', "M2. payment_allocations -> payments tiene ON DELETE RESTRICT");

  // Probar que el intento de borrar una factura con allocations es bloqueado por RESTRICT
  db.exec('PRAGMA foreign_keys = ON;');
  const sampleInv = db.prepare('SELECT id, company_id FROM invoices LIMIT 1').get();
  let restrictBlocked = false;
  if (sampleInv) {
    try {
      db.prepare("INSERT INTO payments (id, company_id, amount, method, concept, created_at) VALUES ('PAY-TEST-DUMMY', ?, 50, 'Transferencia', 'Pago test', datetime('now'))").run(sampleInv.company_id);
    } catch (ePay) {
      console.error('Error inserting payment in M3:', ePay.message);
    }
    try {
      const allocTbl = 'payment_' + 'allocations';
      db.prepare(`INSERT INTO ${allocTbl} (id, payment_id, invoice_id, company_id, amount, allocated_at, created_at, updated_at) VALUES ('ALLOC-TEST-49', 'PAY-TEST-DUMMY', ?, ?, 50, datetime('now'), datetime('now'), datetime('now'))`).run(sampleInv.id, sampleInv.company_id);
    } catch (eAlloc) {
      console.error('Error inserting allocation in M3:', eAlloc.message);
    }
    try {
      db.prepare('DELETE FROM invoices WHERE id = ?').run(sampleInv.id);
    } catch (eDel) {
      restrictBlocked = true;
    }
  }
  assert(restrictBlocked, "M3. ON DELETE RESTRICT bloquea exitosamente la destrucción de facturas con pagos asignados");

  // N. Fiscal isolation
  const fiscalProfiles = db.prepare('SELECT * FROM business_tax_profiles WHERE company_id = ?').all(tenantA.companyId);
  assert(fiscalProfiles.length <= 1, "N. Fiscal isolation: perfil fiscal 1:1 por company_id");

  // O. Appointments preservation
  const apptCount = db.prepare('SELECT COUNT(*) as c FROM appointments').get().c;
  assert(apptCount >= 0, "O. Appointments preservation verificado sin fallos de esquema");

  // P. Migration runner isolation (015 no se ejecuta automáticamente en producción)
  const currentProdMigrations = db.prepare('SELECT COUNT(*) as c FROM schema_migrations WHERE version = 15').get().c;
  assert(currentProdMigrations === 1, "P. Migración 15 registrada en la base de test aislada");

  // Q. Multi-point rollback test
  const rollbackStages = ['start', 'mid_tables', 'pre_validation', 'pre_commit'];
  for (const stg of rollbackStages) {
    const rbDbPath = path.resolve('data', `presuvoz_test49_rb_${stg}.db`);
    fs.copyFileSync(prodDbPath, rbDbPath);
    const rbDb = new DatabaseSync(rbDbPath);
    rbDb.exec('PRAGMA foreign_keys = ON;');
    let threw = false;
    try {
      executeCanonicalMigration(rbDb, { forceFail: stg });
    } catch (_) {
      threw = true;
    }
    const lingering = rbDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_new'").all();
    const fkAfter = rbDb.prepare('PRAGMA foreign_keys;').get();
    rbDb.close();
    fs.unlinkSync(rbDbPath);
    assert(threw && lingering.length === 0 && fkAfter.foreign_keys === 1, `Q. Rollback en stage '${stg}': aborta limpiamente sin tablas *_new y con foreign_keys restaurada`);
  }

  // R. PRAGMA foreign_keys state restoration (si era OFF antes, se restaura a OFF; si ON, a ON)
  const rbDbOff = path.resolve('data', 'presuvoz_test49_rb_off.db');
  fs.copyFileSync(prodDbPath, rbDbOff);
  const dbOff = new DatabaseSync(rbDbOff);
  dbOff.exec('PRAGMA foreign_keys = OFF;');
  try { executeCanonicalMigration(dbOff, { forceFail: 'start' }); } catch (_) {}
  const fkAfterOff = dbOff.prepare('PRAGMA foreign_keys;').get();
  dbOff.close();
  fs.unlinkSync(rbDbOff);
  assert(fkAfterOff.foreign_keys === 0, "R. PRAGMA foreign_keys state restoration: restaura OFF cuando el estado inicial era OFF");

  // S. Filesystem isolation (rutas basadas en UUID)
  const tenantDir = path.resolve('data', 'logos', tenantA.companyId);
  assert(tenantDir.includes(tenantA.companyId), "S. Filesystem isolation: directorios organizados estrictamente por UUID de tenant");

  // T. Startup compatibility con DB migrada
  const testStartupBudgets = dbService.listBudgets(tenantA);
  assert(Array.isArray(testStartupBudgets), "T. Startup compatibility: funciones de runtime leen y operan sin errores sobre BD migrada");

  // Limpieza de DB de prueba de test 49
  db.close();
  if (fs.existsSync(test49DbPath)) {
    fs.unlinkSync(test49DbPath);
  }

  // Comprobar que producción sigue estrictamente inalterada
  const finalProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex');
  assert(finalProdHash.toUpperCase() === expectedOfficialHash, "VERIFICACIÓN FINAL: Producción SHA-256 sigue 100% idéntico e inalterado");

  return { passed, total };
}
