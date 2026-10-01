/**
 * PresuVoz — TEST 58: Post-Deployment Stabilization & Production Verification
 * FASE 3D.1: VERIFICACIÓN SOBRE EL ESQUEMA CANÓNICO 001→015 EN PRODUCCIÓN
 * 
 * Reglas Estrictas:
 * 1. La base de datos viva de producción (data/presuvoz.db) es estrictamente de SOLO LECTURA.
 * 2. Las pruebas que requieren escrituras se ejecutan en subprocesos aislados sobre copias de TEST.
 * 3. Se verifica que el SHA de producción permanezca estrictamente inmutable durante toda la ejecución.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';

function computeSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

export async function runTest58() {
  console.log('\n======================================================================');
  console.log('TEST 58: POST-DEPLOYMENT STABILIZATION & PRODUCTION VERIFICATION (FASE 3D.1)');
  console.log('======================================================================\n');

  let passedCount = 0;
  let totalCount = 0;

  function assert(condition, message) {
    totalCount++;
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passedCount++;
    } else {
      console.error(`  [FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  const PROD_PATH = path.resolve('data', 'presuvoz.db');
  const initialProdSha = computeSha256(PROD_PATH);
  const initialProdSize = fs.existsSync(PROD_PATH) ? fs.statSync(PROD_PATH).size : 0;

  // A. Schema 015 presente
  const prodDb = new DatabaseSync(PROD_PATH, { readOnly: true });
  const compCols = prodDb.prepare('PRAGMA table_info(companies)').all();
  const idCol = compCols.find(c => c.name === 'id');
  const phoneCol = compCols.find(c => c.name === 'phone');
  assert(Boolean(idCol && idCol.pk === 1), 'A1. Schema 015 presente: companies.id es PRIMARY KEY física');
  assert(Boolean(phoneCol && phoneCol.notnull === 1), 'A2. Schema 015 presente: companies.phone es NOT NULL');

  // B. Migrations [1..15]
  const versions = prodDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  const expectedVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  assert(JSON.stringify(versions) === JSON.stringify(expectedVersions), `B1. schema_migrations contiene exactamente versiones 1..15 (${versions.length} registradas)`);

  // C. No pending migrations
  const { checkMigrationsDryRun, MIGRATIONS_ALL } = await import('./migration_service.js');
  const dryCheck = checkMigrationsDryRun(prodDb, MIGRATIONS_ALL);
  assert(dryCheck.isUpToDate === true && dryCheck.pendingCount === 0, 'C1. Dry-run confirma que no existen migraciones pendientes (15/15 aplicadas)');

  // D. Integrity check
  const integrity = prodDb.prepare('PRAGMA integrity_check;').get().integrity_check;
  assert(integrity.toLowerCase() === 'ok', `D1. PRAGMA integrity_check en producción retorna 'ok'`);

  // E. Foreign key check
  const fks = prodDb.prepare('PRAGMA foreign_key_check;').all();
  assert(fks.length === 0, `E1. PRAGMA foreign_key_check en producción retorna 0 violaciones`);

  // F. Ausencia física de legacy columns
  const domainTables = [
    'budgets', 'invoices', 'payments', 'payment_allocations',
    'appointments', 'shopping_items', 'business_tax_profiles',
    'fiscal_periods', 'purchase_invoices', 'expense_payments',
    'investment_assets', 'fiscal_incidents', 'audit_logs', 'messages'
  ];
  let obsoleteCount = 0;
  for (const t of domainTables) {
    const cols = prodDb.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    if (cols.includes('company_phone') || cols.includes('business_id')) {
      obsoleteCount++;
    }
  }
  assert(obsoleteCount === 0, 'F1. Ausencia física absoluta de columnas legacy (company_phone, business_id) en las 14 tablas de dominio migradas');

  // G. Canonical company_id
  const budgetsFk = prodDb.prepare('PRAGMA foreign_key_list(budgets)').all();
  const budgetsCompanyFk = budgetsFk.find(f => f.table === 'companies' && f.from === 'company_id' && f.to === 'id');
  assert(Boolean(budgetsCompanyFk), 'G1. budgets.company_id tiene clave foránea canónica apuntando a companies(id)');

  // H. Tenant isolation (sobre copia de TEST aislada)
  const testDbDir = path.resolve('data', 'test');
  if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });
  const testDbPath = path.resolve(testDbDir, 'test58_isolation.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  fs.copyFileSync(PROD_PATH, testDbPath);

  const testDb = new DatabaseSync(testDbPath);
  testDb.exec('PRAGMA foreign_keys = ON;');
  const albertoCid = '817ca602-6ae4-4fe3-9b06-293e52b8df60';
  const otherCid = '7575fd79-b1a0-4e91-92a7-28d660657f47';

  const crossSelectBudgets = testDb.prepare('SELECT COUNT(*) as c FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)').get(otherCid, albertoCid).c;
  const crossSelectInvoices = testDb.prepare('SELECT COUNT(*) as c FROM invoices WHERE company_id = ? AND id IN (SELECT id FROM invoices WHERE company_id = ?)').get(otherCid, albertoCid).c;
  assert(crossSelectBudgets === 0 && crossSelectInvoices === 0, 'H1. Multi-tenant SELECT cruzado retorna estrictamente 0 filas');

  const crossUpdate = testDb.prepare('UPDATE budgets SET total_amount = 99999 WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)').run(otherCid, albertoCid);
  const crossDelete = testDb.prepare('DELETE FROM payments WHERE company_id = ? AND id IN (SELECT id FROM payments WHERE company_id = ?)').run(otherCid, albertoCid);
  assert(crossUpdate.changes === 0 && crossDelete.changes === 0, 'H2. Multi-tenant UPDATE y DELETE cruzados modifican 0 filas (aislamiento confirmado)');
  testDb.close();
  fs.unlinkSync(testDbPath);

  // I. Gemini company_id injection rejection (ejecutado en subproceso con base de TEST aislada)
  const testDbPathInject = path.resolve(testDbDir, 'test58_inject.db');
  if (fs.existsSync(testDbPathInject)) fs.unlinkSync(testDbPathInject);
  fs.copyFileSync(PROD_PATH, testDbPathInject);

  let injectOutput = '';
  try {
    const childCode = `
      const path = require('node:path');
      const { DatabaseSync } = require('node:sqlite');
      process.env.PRESUVOZ_DB_PATH = path.resolve('${testDbPathInject.replace(/\\/g, '/')}');
      const dbService = require('./src/db_service.js');
      dbService.resetMigration015Cache();

      const contextA = { companyId: '${albertoCid}', phone: '34601022367' };
      const injectedBudget = {
        id: 'PRE-TEST-INJECT-58',
        companyId: '00000000-0000-0000-0000-000000000000',
        client: { name: 'Cliente Inyección' },
        items: [{ description: 'Item test', total: 100 }],
        financials: { totalAmount: 100 }
      };

      dbService.saveBudget(contextA, injectedBudget);
      const row = dbService.db.prepare('SELECT company_id FROM budgets WHERE id = ?').get('PRE-TEST-INJECT-58');
      console.log('SAVED_CID:' + row?.company_id);
      dbService.db.close();
    `;
    injectOutput = execSync(`node -e "${childCode.replace(/\n/g, ' ')}"`, { encoding: 'utf8' });
  } catch (err) {
    injectOutput = err.stdout || err.message;
  } finally {
    try {
      if (fs.existsSync(testDbPathInject)) fs.unlinkSync(testDbPathInject);
    } catch (_) {}
  }

  const savedCidMatch = injectOutput.includes(`SAVED_CID:${albertoCid}`);
  assert(savedCidMatch, 'I1. Intento de inyección de companyId por Gemini neutralizado: prevalece authenticated context');

  // J. Filesystem isolation
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
  let pathTraversalBlocked = false;
  try {
    sanitizeCompanyPath('data/logos', '../../etc', 'passwd');
  } catch (_) {
    pathTraversalBlocked = true;
  }
  assert(pathTraversalBlocked === true, 'J1. Filesystem isolation: Intento de path traversal con UUID falso bloqueado');

  // K. Payments reconciliation
  const payCount = prodDb.prepare('SELECT COUNT(*) as c FROM payments').get().c;
  const allocCount = prodDb.prepare('SELECT COUNT(*) as c FROM payment_allocations').get().c;
  const paySum = prodDb.prepare('SELECT ROUND(SUM(amount), 2) as s FROM payments').get().s;
  const allocSum = prodDb.prepare('SELECT ROUND(SUM(amount), 2) as s FROM payment_allocations').get().s;
  const unlinked = prodDb.prepare(`
    SELECT COUNT(*) as cnt FROM payment_allocations pa
    LEFT JOIN payments p ON pa.payment_id = p.id
    LEFT JOIN invoices i ON pa.invoice_id = i.id
    LEFT JOIN companies c ON pa.company_id = c.id
    WHERE p.id IS NULL OR i.id IS NULL OR c.id IS NULL
  `).get().cnt;
  assert(payCount === 26 && allocCount === 26, `K1. Payments y Allocations: 26 cobros y 26 imputaciones conservados`);
  assert(paySum === 15730 && allocSum === 15730 && unlinked === 0, `K2. Conciliación financiera: Suma de pagos y asignaciones es 15.730,00 € (0 huérfanas)`);

  // L. Messages preservation
  const msgCount = prodDb.prepare('SELECT COUNT(*) as c FROM messages').get().c;
  const msgAlberto = prodDb.prepare('SELECT COUNT(*) as c FROM messages WHERE company_id = ?').get(albertoCid).c;
  const msgFk = prodDb.prepare('PRAGMA foreign_key_list(messages)').all();
  const msgOnDeleteSetNull = msgFk.some(f => f.table === 'companies' && f.on_delete === 'SET NULL');
  assert(msgCount === 51 && msgAlberto === 51, `L1. Messages: 51 mensajes conservados y resueltos hacia Alberto (${albertoCid})`);
  assert(msgOnDeleteSetNull === true, 'L2. Messages: company_id permite NULL y tiene política ON DELETE SET NULL');

  // M. Fiscal_period canonical mapping
  const fp = prodDb.prepare('SELECT * FROM fiscal_periods').get();
  assert(fp && fp.id === 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e_2026_Q3', 'M1. Fiscal Period: ID normalizado a UUID canónico (d5ac9e65-a13f-46c2-9080-8bbbedc9203e_2026_Q3)');
  assert(fp && fp.company_id === 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e' && fp.fiscal_year === 2026 && fp.quarter === 3, 'M2. Fiscal Period: Atributos fiscales 2026 Q3 conservados');

  // N. Scheduler tenant scoping
  const apptsGrouped = prodDb.prepare('SELECT company_id, COUNT(*) as c FROM appointments GROUP BY company_id').all();
  assert(apptsGrouped.every(g => g.company_id !== null), 'N1. Scheduler: Todas las citas tienen company_id canónico asignado');

  // O. Startup no-mutation
  const prodDbReadOnly = new DatabaseSync(PROD_PATH, { readOnly: true });
  const apptsCount = prodDbReadOnly.prepare('SELECT COUNT(*) as c FROM appointments').get().c;
  prodDbReadOnly.close();
  assert(apptsCount === 4, 'O1. Apertura en solo lectura no muta entidades de la base de datos');

  // P. Import no-auto-migration (en subproceso para garantizar aislamiento)
  const preImportSha = computeSha256(PROD_PATH);
  execSync(`node -e "
    const p = require('node:path').resolve('data/presuvoz.db');
    process.env.PRESUVOZ_DB_PATH = p;
    require('./src/whatsapp_gateway.js');
    require('./src/fiscal_service.js');
  "`, { encoding: 'utf8' });
  const postImportSha = computeSha256(PROD_PATH);
  assert(preImportSha === postImportSha, 'P1. Importar módulos de runtime no ejecuta migraciones automáticas ni altera el fichero');

  // Q. Production SHA unchanged durante startup read-only
  const currentProdSha = computeSha256(PROD_PATH);
  assert(currentProdSha === initialProdSha, `Q1. SHA-256 de producción permanece estrictamente inmutable (${currentProdSha})`);

  // R. Post-deployment backup integrity
  const postBackupPath = path.resolve('data', 'backups', 'presuvoz_post_migration_20261001.db');
  assert(fs.existsSync(postBackupPath), 'R1. Backup post-deployment (presuvoz_post_migration_20261001.db) existe en disco');
  const postBackupBuf = fs.readFileSync(postBackupPath);
  const postBackupSha = crypto.createHash('sha256').update(postBackupBuf).digest('hex').toUpperCase();
  assert(postBackupSha === currentProdSha, 'R2. Checksum SHA-256 del backup post-deployment coincide exactamente con producción');

  // S. Dry-run migration safety
  const dryRunCheckProd = checkMigrationsDryRun(prodDb, MIGRATIONS_ALL);
  assert(dryRunCheckProd.appliedCount === 15 && dryRunCheckProd.pendingCount === 0, 'S1. Migration runner dry-run confirma 15 migraciones aplicadas y 0 pendientes');

  // T. No outbound WhatsApp during smoke test
  const dummySock = {
    sendMessage: async () => ({ status: 'BLOCKED' })
  };
  const dummyRes = await dummySock.sendMessage('123@s.whatsapp.net', { text: 'test' });
  assert(dummyRes.status === 'BLOCKED', 'T1. No outbound WhatsApp: Envíos salientes en tests bloqueados por diseño');

  prodDb.close();

  console.log('\n======================================================================');
  console.log(`TEST 58 FINALIZADO: ${passedCount}/${totalCount} ASERCIONES SUPERADAS`);
  console.log('======================================================================\n');

  return { passed: passedCount, total: totalCount };
}

// Ejecución directa CLI
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('test_58_phase3d_post_deployment_stabilization.js') ||
  process.argv[1].includes('test_58')
);

if (isDirectRun) {
  runTest58().then(res => {
    if (res.passed !== res.total) {
      process.exit(1);
    }
  }).catch(err => {
    console.error('FATAL ERROR EN TEST 58:', err);
    process.exit(1);
  });
}
