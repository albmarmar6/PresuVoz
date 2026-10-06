import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const targetDbPath = process.env.PRESUVOZ_DB_PATH
  || (process.env.NODE_ENV === 'test' ? path.resolve('data', 'presuvoz_test.db') : path.resolve('data', 'presuvoz.db'));
const DB_PATH = path.resolve(targetDbPath);
const PROD_DB_PATH = path.resolve('data', 'presuvoz.db');
const BACKUP_DIR = path.resolve('data', 'backups');
const isRealDb = DB_PATH === PROD_DB_PATH;
const forceReal = process.argv.includes('--force-real-db') || process.env.ALLOW_PRODUCTION_RESET === 'true';

if (isRealDb && !forceReal) {
  console.error('\n🛑 [BARRERA DE SEGURIDAD] Operación bloqueada.');
  console.error('Has intentado resetear la base de datos principal (data/presuvoz.db).');
  console.error('Para resetear la base de datos de prueba ejecuta: NODE_ENV=test node src/reset_db.js');
  console.error('El reset explícito de la base principal requiere: node src/reset_db.js --force-real-db\n');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.log('No existe la base de datos en', DB_PATH);
  process.exit(0);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `presuvoz_backup_${timestamp}.db`);
const db = new DatabaseSync(DB_PATH);

try {
  // VACUUM INTO crea una copia SQLite consistente, incluyendo transacciones confirmadas en WAL.
  db.exec('PRAGMA wal_checkpoint(FULL);');
  const escapedBackupPath = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedBackupPath}';`);
  if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
    throw new Error('La copia de seguridad no se creó correctamente.');
  }
  console.log(`📦 Copia de seguridad verificada: ${backupPath}`);

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE;');
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
    ORDER BY name
  `).all().map(row => row.name);

  console.log('🗑️  Borrando todos los datos de aplicación y preservando schema_migrations...');
  for (const table of tables) {
    const quotedTable = `"${table.replace(/"/g, '""')}"`;
    db.exec(`DELETE FROM ${quotedTable};`);
  }
  try { db.exec('DELETE FROM sqlite_sequence;'); } catch (error) {
    if (!/no such table/i.test(error.message)) throw error;
  }

  const remaining = tables.flatMap(table => {
    const quotedTable = `"${table.replace(/"/g, '""')}"`;
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quotedTable}`).get().count;
    return count === 0 ? [] : [`${table}: ${count}`];
  });
  if (remaining.length) throw new Error(`Quedaron registros después del reset: ${remaining.join(', ')}`);
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');

  const violations = db.prepare('PRAGMA foreign_key_check;').all();
  if (violations.length) throw new Error(`El reset dejó ${violations.length} violaciones de claves foráneas.`);
  const migrationCount = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count;
  console.log(`✅ Base vacía: ${tables.length} tablas de aplicación sin registros; ${migrationCount} migraciones conservadas.`);
  console.log('ℹ️  auth_info_baileys no se toca; reinicia el gateway para que cargue la base vacía.');
} catch (error) {
  try { db.exec('ROLLBACK;'); } catch {}
  console.error('❌ Reset cancelado; la transacción se revirtió. Copia disponible en:', backupPath);
  throw error;
} finally {
  db.close();
}
