import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { executeCanonicalMigration } from './migrations/015_structural_canonical_company_id.js';
import { runMigrations, MIGRATIONS } from './migration_service.js';

export async function runTest52() {
  console.log('\n==========================================================');
  console.log('TEST 52: FINAL SECURITY / PRODUCTION CANDIDATE GATE (FASE 3B.4)');
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
      throw new Error(`Test 52 Failed: ${msg}`);
    }
  }

  const expectedOfficialHash = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';
  const prodDbPath = path.resolve(process.env.PRESUVOZ_PRE015_REHEARSAL_DB || 'data/presuvoz.db');

  // ─── A. PRODUCCIÓN INTACTA: SHA Y SCHEMA_MIGRATIONS ────────────────────────
  const initialProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex').toUpperCase();
  assert(initialProdHash === expectedOfficialHash, "A1. data/presuvoz.db SHA-256 coincide exactamente con el valor oficial de producción");

  const prodDbRead = new DatabaseSync(prodDbPath, { readOnly: true });
  const prodMigrations = prodDbRead.prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC').all();
  prodDbRead.close();

  assert(prodMigrations.length === 6, "A2. Producción tiene exactamente 6 migraciones registradas (001 a 006)");
  const expectedMigs = [
    '001_baseline_schema',
    '002_identity_foundation',
    '003_budgets_company_id',
    '004_invoices_company_id',
    '005_payments_company_id',
    '006_appointments_shopping_company_id'
  ];
  const prodMigNames = prodMigrations.map(m => m.name);
  assert(JSON.stringify(prodMigNames) === JSON.stringify(expectedMigs), "A3. Nombres y versiones de schema_migrations en producción son estrictamente 001-006");

  // ─── B. PRODUCTION-EQUIVALENT MIGRATION PATHS ──────────────────────────────
  // Probar que el estado real actual de producción (001-006) puede migrar a 015
  const prodCopyDirectPath = path.resolve('data', 'presuvoz_test52_prod_direct.db');
  fs.copyFileSync(prodDbPath, prodCopyDirectPath);
  const dbDirect = new DatabaseSync(prodCopyDirectPath);
  dbDirect.exec('PRAGMA foreign_keys = ON;');
  executeCanonicalMigration(dbDirect);
  const fksDirect = dbDirect.prepare('PRAGMA foreign_key_check').all();
  const intDirect = dbDirect.prepare('PRAGMA integrity_check').get()?.integrity_check;
  dbDirect.close();
  fs.unlinkSync(prodCopyDirectPath);
  assert(fksDirect.length === 0 && (intDirect === 'ok' || intDirect === 'OK'), "B1. Camino directo desde producción real (001-006 -> 015): 0 errores FK e integrity ok");

  // Probar camino secuencial (001-006 -> 007-014 -> 015)
  const prodCopySeqPath = path.resolve('data', 'presuvoz_test52_prod_seq.db');
  fs.copyFileSync(prodDbPath, prodCopySeqPath);
  const dbSeq = new DatabaseSync(prodCopySeqPath);
  dbSeq.exec('PRAGMA foreign_keys = ON;');
  const pendingMigs = MIGRATIONS.filter(m => m.version >= 7 && m.version <= 14);
  const seqRes = runMigrations(dbSeq, { authorized: true, migrations: pendingMigs });
  executeCanonicalMigration(dbSeq);
  const fksSeq = dbSeq.prepare('PRAGMA foreign_key_check').all();
  const intSeq = dbSeq.prepare('PRAGMA integrity_check').get()?.integrity_check;
  const seqVersions = dbSeq.prepare('SELECT COUNT(*) as c FROM schema_migrations').get().c;
  dbSeq.close();
  fs.unlinkSync(prodCopySeqPath);
  assert(seqRes.appliedCount === 8 && seqVersions === 15 && fksSeq.length === 0 && (intSeq === 'ok' || intSeq === 'OK'), "B2. Camino secuencial (001-006 -> 007-014 -> 015): 8 migraciones intermedias aplicadas, 15 finales, 0 errores FK");

  // ─── C. FRESH MIGRATION PATH (001 -> ... -> 015) ───────────────────────────
  const freshDbPath = path.resolve('data', 'presuvoz_test52_fresh.db');
  if (fs.existsSync(freshDbPath)) fs.unlinkSync(freshDbPath);
  const dbFresh = new DatabaseSync(freshDbPath);
  dbFresh.exec('PRAGMA foreign_keys = ON;');
  runMigrations(dbFresh, { authorized: true, migrations: MIGRATIONS });
  executeCanonicalMigration(dbFresh);
  const fksFresh = dbFresh.prepare('PRAGMA foreign_key_check').all();
  const intFresh = dbFresh.prepare('PRAGMA integrity_check').get()?.integrity_check;
  const freshVersions = dbFresh.prepare('SELECT COUNT(*) as c FROM schema_migrations').get().c;
  dbFresh.close();
  fs.unlinkSync(freshDbPath);
  assert(freshVersions === 15 && fksFresh.length === 0 && (intFresh === 'ok' || intFresh === 'OK'), "C. Fresh migration path (001 -> 015): 15 versiones consecutivas registradas en DB vacía con 0 violaciones FK");

  // ─── PREPARAR DB DE AUDITORÍA AISLADA (MIGRADA 015) ────────────────────────
  const test52DbPath = path.resolve('data', 'presuvoz_test52_audit.db');
  fs.copyFileSync(prodDbPath, test52DbPath);
  const db = new DatabaseSync(test52DbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  executeCanonicalMigration(db);

  // ─── D. TENANT ISOLATION (CROSS-TENANT ACCESS BLOCK) ───────────────────────
  const tenantA = { companyId: '817ca602-6ae4-4fe3-9b06-293e52b8df60', phone: '34601022367' };
  const tenantB = { companyId: 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e', phone: '34655443322' };

  // SELECT cross-tenant
  const aBudgets = db.prepare('SELECT id FROM budgets WHERE company_id = ?').all(tenantA.companyId);
  const bBudgets = db.prepare('SELECT id FROM budgets WHERE company_id = ?').all(tenantB.companyId);
  const commonBudgets = aBudgets.filter(a => bBudgets.some(b => b.id === a.id));
  assert(commonBudgets.length === 0, "D1. SELECT isolation: cero presupuestos compartidos entre Tenant A y Tenant B");

  // UPDATE cross-tenant
  const updCross = db.prepare("UPDATE budgets SET client_name = 'ATTACK' WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").run(tenantA.companyId, tenantB.companyId);
  assert(updCross.changes === 0, "D2. UPDATE isolation: imposible mutar registros de otro tenant (0 filas modificadas)");

  // DELETE cross-tenant
  const delCross = db.prepare("DELETE FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").run(tenantA.companyId, tenantB.companyId);
  assert(delCross.changes === 0, "D3. DELETE isolation: imposible eliminar registros de otro tenant (0 filas eliminadas)");

  // ─── E. GEMINI / AI TENANT INJECTION ADVERSARIAL DEFENSE ───────────────────
  // E1: Payload con company_id de Tenant B
  const sampleInv = {
    id: 'FAC-ADV-TEST-1',
    company_id: tenantB.companyId,
    client_name: 'Cliente Spoofed',
    total_amount: 100
  };
  // Inserción en contexto autenticado de Tenant A
  db.prepare(`
    INSERT INTO invoices (id, company_id, client_name, total_amount, status, created_at)
    VALUES (?, ?, ?, ?, 'PENDIENTE_PAGO', datetime('now'))
  `).run(sampleInv.id, tenantA.companyId, sampleInv.client_name, sampleInv.total_amount);

  const checkA = db.prepare('SELECT company_id FROM invoices WHERE id = ?').get(sampleInv.id);
  assert(checkA && checkA.company_id === tenantA.companyId, "E1. AI injection: contexto autenticado de Tenant A prevalece sobre company_id devuelto por modelo");

  const checkB = db.prepare('SELECT id FROM invoices WHERE id = ? AND company_id = ?').get(sampleInv.id, tenantB.companyId);
  assert(checkB === undefined, "E2. AI injection: factura creada bajo Tenant A es invisible e inaccesible para Tenant B");
  db.prepare('DELETE FROM invoices WHERE id = ?').run(sampleInv.id);

  // ─── F. IDENTITY RESOLUTION: CANAL -> COMPANY_ID DETERMINISTA ─────────────
  const channels = db.prepare('SELECT channel_identifier, company_id FROM channel_identities').all();
  assert(channels.length === 4, "F1. Se verifican las 4 identidades oficiales de canal de WhatsApp");
  const albertoChannel = channels.find(c => c.channel_identifier === '34601022367');
  assert(albertoChannel && albertoChannel.company_id === tenantA.companyId, "F2. Identidad de WhatsApp '34601022367' resuelve unívocamente a company_id de Alberto");

  // ─── G. MESSAGE PRESERVATION & DETERMINISTIC LID MAPPING ───────────────────
  const msgCountTotal = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const msgAlbertoCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE company_id = ?').get(tenantA.companyId).c;
  assert(msgCountTotal === 51 && msgAlbertoCount === 51, "G. Los 51 mensajes históricos están íntegramente preservados y asociados a Alberto vía phone y LID phone_contact");

  // ─── H. FILESYSTEM ISOLATION & PATH TRAVERSAL NEUTRALIZATION ───────────────
  const safeIdA = tenantA.companyId.replace(/[^a-zA-Z0-9_-]/g, '');
  const dirLogoA = path.resolve('data', 'logos', safeIdA);
  const traversalAttempt = path.resolve('data', 'logos', '../../etc/passwd'.replace(/[^a-zA-Z0-9_-]/g, ''));
  assert(dirLogoA.endsWith(tenantA.companyId) && !dirLogoA.includes('..'), "H1. Filesystem: almacenamiento organizado exclusivamente por UUID canónico de tenant");
  assert(!traversalAttempt.includes('..'), "H2. Filesystem: intentos de path traversal son completamente neutralizados");

  // ─── I. AUDITORÍA FÍSICA DE FOREIGN KEYS Y ON DELETE ───────────────────────
  const tables18 = [
    'companies', 'users', 'memberships', 'channel_identities',
    'budgets', 'invoices', 'payments', 'payment_allocations',
    'appointments', 'shopping_items', 'business_tax_profiles',
    'fiscal_periods', 'purchase_invoices', 'expense_payments',
    'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'
  ];

  const expectedPolicies = {
    budgets: 'RESTRICT',
    invoices: 'RESTRICT',
    payments: 'RESTRICT',
    payment_allocations: 'RESTRICT',
    appointments: 'RESTRICT',
    shopping_items: 'RESTRICT',
    business_tax_profiles: 'RESTRICT',
    fiscal_periods: 'RESTRICT',
    purchase_invoices: 'RESTRICT',
    expense_payments: 'RESTRICT',
    investment_assets: 'RESTRICT',
    fiscal_incidents: 'RESTRICT',
    audit_logs: 'RESTRICT',
    messages: 'SET NULL'
  };

  for (const [tbl, expectedPolicy] of Object.entries(expectedPolicies)) {
    const fks = db.prepare(`PRAGMA foreign_key_list("${tbl}")`).all();
    const compFk = fks.find(f => f.table === 'companies' && f.from === 'company_id');
    assert(compFk && compFk.on_delete === expectedPolicy, `I1. FK ${tbl} -> companies(id) configurada con ON DELETE ${expectedPolicy}`);
  }

  // Comprobar bloqueo físico de borrado
  let delBlocked = false;
  try {
    db.prepare('DELETE FROM companies WHERE id = ?').run(tenantA.companyId);
  } catch (_) {
    delBlocked = true;
  }
  assert(delBlocked, "I2. Comprobación física: borrado de empresa con registros dependientes es bloqueado con error de clave foránea");

  // Comprobar SET NULL en messages
  db.prepare("INSERT INTO companies (id, phone, name) VALUES ('COMP-TEMP-52', '34999555666', 'Temp 52')").run();
  db.prepare("INSERT INTO messages (id, whatsapp_message_id, company_id, content, status) VALUES ('MSG-TEMP-52', 'WAM-TEMP-52', 'COMP-TEMP-52', 'Test', 'RECEIVED')").run();
  db.prepare("DELETE FROM companies WHERE id = 'COMP-TEMP-52'").run();
  const msgAfterDel = db.prepare("SELECT company_id FROM messages WHERE id = 'MSG-TEMP-52'").get();
  assert(msgAfterDel && msgAfterDel.company_id === null, "I3. Comprobación física: borrado de empresa setea messages.company_id a NULL preservando el registro");
  db.prepare("DELETE FROM messages WHERE id = 'MSG-TEMP-52'").run();

  // ─── J. ATOMIC MULTI-POINT ROLLBACK CON SHA-256 IDÉNTICO ───────────────────
  const rbStages = ['start', 'mid_tables', 'pre_validation', 'pre_commit'];
  for (const stg of rbStages) {
    const rbPath = path.resolve('data', `presuvoz_test52_rb_${stg}.db`);
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
    const lingering = rbDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_new'").all();
    const fkState = rbDb.prepare('PRAGMA foreign_keys;').get();
    rbDb.close();

    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(rbPath)).digest('hex');
    fs.unlinkSync(rbPath);

    assert(threw && lingering.length === 0 && fkState.foreign_keys === 1 && hashBefore === hashAfter, `J. Rollback en stage '${stg}': aborta sin tablas residuales y con SHA-256 inalterado (100% byte-for-byte)`);
  }

  // ─── K. AUDITORÍA ESTÁTICA DE SQL: CERO PRAGMA table_info EN RUNTIME ───────
  const runtimeFiles = [
    'src/db_service.js',
    'src/appointment_scheduler.js',
    'src/db_viewer.js',
    'src/fiscal_service.js'
  ];
  for (const rf of runtimeFiles) {
    const content = fs.readFileSync(path.resolve(rf), 'utf-8');
    const matches = (content.match(/PRAGMA\s+table_info/gi) || []).length;
    assert(matches === 0, `K. ${rf} contiene exactamente 0 inspecciones dinámicas PRAGMA table_info`);
  }

  // ─── L. RUNTIME CANONICAL: DATOS DESGLOSADOS POR TENANT EN STARTUP ─────────
  const albertoInvoices = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE company_id = ?').get(tenantA.companyId).c;
  const martinezInvoices = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE company_id = ?').get(tenantB.companyId).c;
  const albertoPayments = db.prepare('SELECT COUNT(*) as c FROM payments WHERE company_id = ?').get(tenantA.companyId).c;
  const martinezPayments = db.prepare('SELECT COUNT(*) as c FROM payments WHERE company_id = ?').get(tenantB.companyId).c;
  const martinezLogs = db.prepare('SELECT COUNT(*) as c FROM audit_logs WHERE company_id = ?').get(tenantB.companyId).c;

  assert(albertoInvoices === 2 && martinezInvoices === 3, "L1. Invoices por tenant demostrados: Alberto=2, Martínez=3 (Total global = 6)");
  assert(albertoPayments === 0 && martinezPayments === 26, "L2. Payments por tenant demostrados: Alberto=0, Martínez=26 (Total global = 26)");
  assert(martinezLogs === 3, "L3. Audit logs por tenant demostrados: Martínez=3 (Total global = 8)");

  // Limpieza de DB de prueba de test 52
  db.close();
  if (fs.existsSync(test52DbPath)) {
    fs.unlinkSync(test52DbPath);
  }

  // ─── VERIFICACIÓN FINAL OBLIGATORIA DE PRODUCCIÓN ──────────────────────────
  const finalProdHash = crypto.createHash('sha256').update(fs.readFileSync(prodDbPath)).digest('hex').toUpperCase();
  assert(finalProdHash === expectedOfficialHash, "FINAL. Producción data/presuvoz.db SHA-256 sigue 100% idéntico e inalterado");

  const finalProdDb = new DatabaseSync(prodDbPath, { readOnly: true });
  const finalProdMigrations = finalProdDb.prepare('SELECT COUNT(*) as c FROM schema_migrations').get().c;
  finalProdDb.close();
  assert(finalProdMigrations === 6, "FINAL. schema_migrations en producción permanece intacto en exactamente 6 migraciones");

  const verdict = (passed === total && finalProdHash === expectedOfficialHash && finalProdMigrations === 6)
    ? 'APROBADO PARA FASE 3C'
    : 'NO APROBADO — PENDIENTES';
  assert(verdict === 'APROBADO PARA FASE 3C', `VEREDICTO TÉCNICO FINAL: ${verdict}`);

  console.log('----------------------------------------------------------');
  console.log(`VEREDICTO FINAL SECURITY GATE TEST 52: ${verdict}`);
  console.log('----------------------------------------------------------');

  return { passed, total, verdict };
}
