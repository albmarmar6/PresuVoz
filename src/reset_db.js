import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = path.resolve('data', 'presuvoz.db');
const BACKUP_DIR = path.resolve('data', 'backups');

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

const tables = ['budgets', 'invoices', 'payments', 'appointments', 'companies'];

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
