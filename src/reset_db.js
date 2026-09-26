import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const targetDbPath = process.env.PRESUVOZ_DB_PATH 
  || (process.env.NODE_ENV === 'test' ? path.resolve('data', 'presuvoz_test.db') : path.resolve('data', 'presuvoz.db'));

const DB_PATH = path.resolve(targetDbPath);
const PROD_DB_PATH = path.resolve('data', 'presuvoz.db');
const BACKUP_DIR = path.resolve('data', 'backups');

const isRealDb = (DB_PATH === PROD_DB_PATH);
const forceReal = process.argv.includes('--force-real-db') || process.env.ALLOW_PRODUCTION_RESET === 'true';

if (isRealDb && !forceReal) {
  console.error('\n🛑 [BARRERA DE SEGURIDAD] Operación bloqueada.');
  console.error('Has intentado resetear la base de datos principal de producción (data/presuvoz.db).');
  console.error('Para resetear la base de datos de prueba ejecuta:');
  console.error('  NODE_ENV=test node src/reset_db.js');
  console.error('O para forzar el reset de producción especifica el flag:');
  console.error('  node src/reset_db.js --force-real-db\n');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.log('No existe la base de datos en', DB_PATH);
  process.exit(0);
}

// 1. Crear copia de seguridad preventiva
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `presuvoz_backup_${timestamp}.db`);
fs.copyFileSync(DB_PATH, backupPath);
console.log(`📦 Copia de seguridad guardada en: ${backupPath}`);

// 2. Conectar y limpiar todas las tablas
const db = new DatabaseSync(DB_PATH);

const tables = [
  'budgets',
  'invoices',
  'payments',
  'appointments',
  'shopping_items',
  'messages',
  'companies',
  'business_tax_profiles',
  'purchase_invoices',
  'expense_payments',
  'investment_assets',
  'fiscal_periods',
  'fiscal_incidents',
  'audit_logs'
];

console.log('🗑️  Borrando datos de la base de datos...');
for (const table of tables) {
  try {
    db.exec(`DELETE FROM ${table};`);
    console.log(`  ✓ Tabla '${table}' vaciada.`);
  } catch (err) {
    console.warn(`  ⚠️ Error al vaciar '${table}':`, err.message);
  }
}

// 3. Compactar base de datos
try {
  db.exec('VACUUM;');
  console.log('✨ Base de datos compactada con VACUUM.');
} catch (err) {
  console.warn('⚠️ No se pudo ejecutar VACUUM:', err.message);
}

// 4. Verificar conteos
console.log('\n📊 Estado final de las tablas:');
for (const table of tables) {
  try {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
    console.log(`  - ${table}: ${row.count} registros`);
  } catch (err) {
    console.log(`  - ${table}: error al verificar (${err.message})`);
  }
}

console.log('\n✅ Base de datos completamente limpia y lista para nuevas pruebas.');
