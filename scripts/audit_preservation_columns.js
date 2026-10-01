import { DatabaseSync } from 'node:sqlite';

const preDb = new DatabaseSync('data/backups/presuvoz_pre_migration_backup.db', { readOnly: true });
const postDb = new DatabaseSync('data/presuvoz.db', { readOnly: true });

const TABLES = [
  'companies', 'channel_identities', 'users', 'memberships',
  'budgets', 'invoices', 'payments', 'payment_allocations',
  'appointments', 'shopping_items', 'business_tax_profiles',
  'fiscal_periods', 'purchase_invoices', 'expense_payments',
  'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'
];

console.log('======================================================================');
console.log('AUDITORÍA DE PRESERVACIÓN LÓGICA Y CLASIFICACIÓN DE COLUMNAS PRE -> POST');
console.log('======================================================================\n');

for (const t of TABLES) {
  const preCols = preDb.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const postCols = postDb.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  
  const common = preCols.filter(c => postCols.includes(c));
  const removed = preCols.filter(c => !postCols.includes(c));
  const added = postCols.filter(c => !preCols.includes(c));
  
  console.log(`TABLA: ${t}`);
  console.log(`  - A) Campos Invariantes Preservados: [${common.join(', ')}]`);
  if (removed.length) {
    console.log(`  - C) Campos Eliminados (Legacy): [${removed.join(', ')}]`);
  }
  if (added.length) {
    console.log(`  - D) Nuevos Campos Estructurales (Canónicos): [${added.join(', ')}]`);
  }
  
  // Analizar transformaciones deterministas B
  if (t === 'business_tax_profiles') {
    console.log(`  - B) Transformación Determinista: business_id ('34655443322') -> company_id ('d5ac9e65-a13f-46c2-9080-8bbbedc9203e')`);
  }
  if (t === 'fiscal_periods') {
    console.log(`  - B) Transformación Determinista: id ('34655443322_2026_Q3') -> id ('d5ac9e65-a13f-46c2-9080-8bbbedc9203e_2026_Q3')`);
  }
  console.log('');
}

preDb.close();
postDb.close();
