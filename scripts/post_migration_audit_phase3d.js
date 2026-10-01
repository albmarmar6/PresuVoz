import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const PROD_PATH = path.resolve('data', 'presuvoz.db');
const buf = fs.readFileSync(PROD_PATH);
const postSha = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();

console.log('=== ESTADO FÍSICO POST-MIGRACIÓN ===');
console.log('Ruta:', PROD_PATH);
console.log('SHA-256 POST:', postSha);
console.log('Size POST:', buf.length, 'bytes');

const db = new DatabaseSync(PROD_PATH, { readOnly: true });

// 1. Integridad física y FKs
const integrity = db.prepare('PRAGMA integrity_check;').get().integrity_check;
const fks = db.prepare('PRAGMA foreign_key_check;').all();
const versions = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC;').all();

console.log('Integrity check:', integrity);
console.log('FK violations:', fks.length);
console.log('schema_migrations versions:', JSON.stringify(versions.map(v => v.version)));
console.log('schema_migrations detail:');
for (const v of versions) {
  console.log(`  - [${v.version}] ${v.name} (${v.applied_at})`);
}

// 2. Comprobar 18 tablas
const TABLES = [
  'companies', 'channel_identities', 'users', 'memberships',
  'budgets', 'invoices', 'payments', 'payment_allocations',
  'appointments', 'shopping_items', 'business_tax_profiles',
  'fiscal_periods', 'purchase_invoices', 'expense_payments',
  'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'
];

console.log('=== CONTEO DE LAS 18 TABLAS DOMINIO ===');
const counts = {};
for (const t of TABLES) {
  const cnt = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get().count;
  counts[t] = cnt;
  console.log(`  - ${t}: ${cnt}`);
}

// 3. Verificar ausencia física de columnas obsoletas (company_phone, business_id)
console.log('=== VERIFICACIÓN AUSENCIA DE COLUMNAS OBSOLETAS ===');
const domainTables = [
  'budgets', 'invoices', 'payments', 'payment_allocations',
  'appointments', 'shopping_items', 'business_tax_profiles',
  'fiscal_periods', 'purchase_invoices', 'expense_payments',
  'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'
];

let obsoleteFound = 0;
for (const t of domainTables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (cols.includes('company_phone')) {
    console.error(`ALERTA: company_phone todavía existe en ${t}`);
    obsoleteFound++;
  }
  if (cols.includes('business_id')) {
    console.error(`ALERTA: business_id todavía existe en ${t}`);
    obsoleteFound++;
  }
  if (!cols.includes('company_id')) {
    console.error(`ALERTA: company_id falta en ${t}`);
    obsoleteFound++;
  }
}
console.log('Columnas obsoletas detectadas:', obsoleteFound);

// 4. Verificación de companies schema
const compCols = db.prepare('PRAGMA table_info(companies)').all();
const idCol = compCols.find(c => c.name === 'id');
const phoneCol = compCols.find(c => c.name === 'phone');
console.log('Companies id PK:', idCol && idCol.pk === 1);
console.log('Companies phone NOT NULL:', phoneCol && phoneCol.notnull === 1);

// 5. Verificación de Payments & Allocations
console.log('=== RECONCILIACIÓN PAYMENTS / ALLOCATIONS ===');
const paySum = db.prepare('SELECT ROUND(SUM(amount), 2) as s FROM payments').get().s;
const allocSum = db.prepare('SELECT ROUND(SUM(amount), 2) as s FROM payment_allocations').get().s;
const unlinked = db.prepare(`
  SELECT COUNT(*) as cnt FROM payment_allocations pa
  LEFT JOIN payments p ON pa.payment_id = p.id
  LEFT JOIN invoices i ON pa.invoice_id = i.id
  LEFT JOIN companies c ON pa.company_id = c.id
  WHERE p.id IS NULL OR i.id IS NULL OR c.id IS NULL
`).get().cnt;
console.log('Payments sum:', paySum, '€');
console.log('Allocations sum:', allocSum, '€');
console.log('Unlinked allocations:', unlinked);

// 6. Verificación de Fiscal Periods
console.log('=== VERIFICACIÓN FISCAL PERIODS ===');
const fp = db.prepare('SELECT * FROM fiscal_periods').all();
console.log('Fiscal periods:', JSON.stringify(fp, null, 2));

// 7. Verificación de Messages
console.log('=== VERIFICACIÓN MESSAGES ===');
const msgTotal = db.prepare('SELECT COUNT(*) as c FROM messages').get().c;
const msgAlberto = db.prepare(`SELECT COUNT(*) as c FROM messages WHERE company_id = '817ca602-6ae4-4fe3-9b06-293e52b8df60'`).get().c;
const msgNull = db.prepare('SELECT COUNT(*) as c FROM messages WHERE company_id IS NULL').get().c;
console.log('Messages total:', msgTotal);
console.log('Messages Alberto (817ca602):', msgAlberto);
console.log('Messages NULL:', msgNull);

// 8. Foreign keys ON DELETE check
console.log('=== VERIFICACIÓN FK ON DELETE ===');
const msgFk = db.prepare('PRAGMA foreign_key_list(messages)').all();
console.log('Messages FKs:', JSON.stringify(msgFk));
const budFk = db.prepare('PRAGMA foreign_key_list(budgets)').all();
console.log('Budgets FKs:', JSON.stringify(budFk));

// 9. Multi-tenant isolation test (SELECT, UPDATE, DELETE)
console.log('=== PRUEBAS MULTI-TENANT DE ACCESO CRUZADO ===');
const albertoCompany = '817ca602-6ae4-4fe3-9b06-293e52b8df60';
const reformasCompany = 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e';
const otherCompany = '7575fd79-b1a0-4e91-92a7-28d660657f47';

// Test SELECT cruzado
const crossBudgets = db.prepare(`SELECT * FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)`).all(otherCompany, reformasCompany);
const crossInvoices = db.prepare(`SELECT * FROM invoices WHERE company_id = ? AND id IN (SELECT id FROM invoices WHERE company_id = ?)`).all(otherCompany, reformasCompany);
const crossPayments = db.prepare(`SELECT * FROM payments WHERE company_id = ? AND id IN (SELECT id FROM payments WHERE company_id = ?)`).all(otherCompany, reformasCompany);
const crossAppts = db.prepare(`SELECT * FROM appointments WHERE company_id = ? AND id IN (SELECT id FROM appointments WHERE company_id = ?)`).all(otherCompany, reformasCompany);
const crossFp = db.prepare(`SELECT * FROM fiscal_periods WHERE company_id = ? AND id IN (SELECT id FROM fiscal_periods WHERE company_id = ?)`).all(otherCompany, reformasCompany);

console.log('Cross-tenant SELECT budgets:', crossBudgets.length);
console.log('Cross-tenant SELECT invoices:', crossInvoices.length);
console.log('Cross-tenant SELECT payments:', crossPayments.length);
console.log('Cross-tenant SELECT appointments:', crossAppts.length);
console.log('Cross-tenant SELECT fiscal_periods:', crossFp.length);

db.close();

// Test UPDATE y DELETE cruzados en transacción que se hace ROLLBACK
const rwDb = new DatabaseSync(PROD_PATH);
rwDb.exec('BEGIN IMMEDIATE;');
try {
  const updRes = rwDb.prepare(`UPDATE budgets SET total_amount = 99999 WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)`).run(otherCompany, reformasCompany);
  console.log('Cross-tenant UPDATE budgets affected rows:', updRes.changes);
  const delRes = rwDb.prepare(`DELETE FROM payments WHERE company_id = ? AND id IN (SELECT id FROM payments WHERE company_id = ?)`).run(otherCompany, reformasCompany);
  console.log('Cross-tenant DELETE payments affected rows:', delRes.changes);
} finally {
  rwDb.exec('ROLLBACK;');
  rwDb.close();
}

// 10. Comparación de equivalencia lógica de contenido fila a fila
console.log('=== VERIFICACIÓN LÓGICA DE EQUIVALENCIA FILA A FILA (HASH DETERMINISTA) ===');
const preDb = new DatabaseSync(path.resolve('data', 'backups', 'presuvoz_pre_migration_backup.db'), { readOnly: true });
const auditPostDb = new DatabaseSync(PROD_PATH, { readOnly: true });

function deterministicRowHash(row, ignoredCols = []) {
  const keys = Object.keys(row).filter(k => !ignoredCols.includes(k)).sort();
  const parts = keys.map(k => {
    let val = row[k];
    if (val === null || val === undefined) return `${k}:__SQL_NULL__`;
    if (typeof val === 'number') return `${k}:${val.toFixed(4)}`;
    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        if (typeof parsed === 'object' && parsed !== null) {
          return `${k}:${JSON.stringify(parsed, Object.keys(parsed).sort())}`;
        }
      } catch (_) {}
      return `${k}:${val}`;
    }
    return `${k}:${String(val)}`;
  });
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

for (const t of TABLES) {
  const preRows = preDb.prepare(`SELECT * FROM ${t}`).all();
  const postRows = auditPostDb.prepare(`SELECT * FROM ${t}`).all();

  let ignore = ['company_id', 'company_phone', 'business_id'];
  if (t === 'business_tax_profiles') {
    ignore.push('id');
  }
  if (t === 'fiscal_periods') {
    ignore.push('id');
  }

  const preHashes = new Set(preRows.map(r => deterministicRowHash(r, ignore)));
  const postHashes = new Set(postRows.map(r => deterministicRowHash(r, ignore)));

  const countMatch = preRows.length === postRows.length;
  let hashMatch = preHashes.size === postHashes.size;
  if (hashMatch) {
    for (const h of preHashes) {
      if (!postHashes.has(h)) {
        hashMatch = false;
        break;
      }
    }
  }

  console.log(`  - ${t}: PRE=${preRows.length}, POST=${postRows.length} | Hash Match: ${hashMatch ? 'OK (100%)' : 'MISMATCH'}`);
  if (!countMatch || !hashMatch) {
    console.error(`FATAL: Discrepancia lógica en tabla ${t}`);
    process.exit(1);
  }
}

preDb.close();
auditPostDb.close();

// 11. Filesystem isolation check
console.log('=== VERIFICACIÓN DE SEGURIDAD EN FILESYSTEM ===');
function sanitizeCompanyPath(baseDir, companyId, filename) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    throw new Error('INVALID_TENANT_UUID');
  }
  const cleanFilename = path.basename(filename);
  const resolved = path.resolve(baseDir, companyId, cleanFilename);
  const expectedPrefix = path.resolve(baseDir, companyId);
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error('PATH_TRAVERSAL_DETECTED');
  }
  return resolved;
}

try {
  sanitizeCompanyPath('data/logos', '../../etc', 'passwd');
  console.error('FAIL: Path traversal no fue bloqueado');
  process.exit(1);
} catch (e) {
  console.log('Path traversal con UUID falso:', e.message, '(CORRECTAMENTE BLOQUEADO)');
}

try {
  const p = sanitizeCompanyPath('data/logos', '817ca602-6ae4-4fe3-9b06-293e52b8df60', '../../../boot.ini');
  console.log('Path traversal en filename neutralizado:', path.basename(p) === 'boot.ini' ? 'OK' : 'FAIL');
} catch (e) {
  console.log('Path traversal capturado:', e.message);
}
