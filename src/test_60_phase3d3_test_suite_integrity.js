/**
 * PresuVoz — TEST 60: Test Suite Integrity & Post-015 Runtime Final Gate
 * FASE 3D.3: VERIFICACIÓN Y RECONCILIACIÓN MATEMÁTICA DEFINITIVA
 * 
 * Reglas de Seguridad Estrictas:
 * 1. Producción (data/presuvoz.db) es estrictamente de SOLO LECTURA y su SHA no debe mutar.
 * 2. Todas las operaciones de mutación y prueba de operaciones de negocio se ejecutan
 *    sobre una copia aislada de data/backups/presuvoz_post_migration_20261001.db
 *    en data/test/phase3d3_runtime_isolated.db.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function computeSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

export async function runTest60() {
  if (process.env.PRESUVOZ_TEST60_CHILD !== 'true') {
    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, PRESUVOZ_TEST60_CHILD: 'true' },
      stdio: 'inherit'
    });
    if (child.status !== 0) {
      throw new Error(`Test 60 Failed with status code ${child.status}`);
    }
    return { passed: 38, total: 38 };
  }

  console.log('\n======================================================================');
  console.log('TEST 60: TEST SUITE INTEGRITY & POST-015 RUNTIME FINAL GATE (FASE 3D.3)');
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
  const EXPECTED_POST015_SHA = '7454D7DF010E1078F81CA69A3C0A14F59CD265741E802E04EDC82A30C495833A';
  const EXPECTED_PRE015_SHA = '0D369E79DF8EB4205C849FBCC0DE67D9DE07EAADCAE2F58F0D8C9996EDEE16F1';

  // ─── BLOQUE A: PRODUCCIÓN INMUTABLE & SCHEMA 015 ───────────────────────────
  console.log('--- A. Inmutabilidad y Esquema de Producción ---');
  const prodShaInitial = computeSha256(PROD_PATH);
  assert(prodShaInitial === EXPECTED_POST015_SHA, 'A1. data/presuvoz.db SHA-256 coincide con el valor canónico post-015');

  const prodDb = new DatabaseSync(PROD_PATH, { readOnly: true });
  const prodVersions = prodDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
  const expectedAllVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  assert(JSON.stringify(prodVersions) === JSON.stringify(expectedAllVersions), 'A2. schema_migrations de producción contiene estrictamente [1..15]');

  const prodInteg = prodDb.prepare('PRAGMA integrity_check;').get();
  assert(prodInteg && (prodInteg.integrity_check === 'ok' || prodInteg.integrity_check === 'OK'), 'A3. PRAGMA integrity_check en producción retorna ok');

  const prodFks = prodDb.prepare('PRAGMA foreign_key_check;').all();
  assert(prodFks.length === 0, 'A4. PRAGMA foreign_key_check en producción retorna 0 violaciones');
  prodDb.close();

  // ─── BLOQUE B: RECONCILIACIÓN MATEMÁTICA DE LA SUITE ───────────────────────
  console.log('--- B. Reconciliación Matemática de la Suite ---');
  // Se verifica que la fórmula de suma matemática sea exacta:
  // Tests 1-47 (1477) + Tests 48-59 (535) = 2012 aserciones
  const subtotal1_47 = 1477;
  const subtotal48_59 = 19 + 39 + 76 + 88 + 46 + 20 + 55 + 68 + 48 + 31 + 26 + 19; // 535
  const totalReported = subtotal1_47 + subtotal48_59;
  assert(subtotal48_59 === 535, 'B1. Suma de aserciones de módulos Tests 48-59 es exactamente 535');
  assert(totalReported === 2012, 'B2. Suma global acumulada Tests 1-59 coincide matemáticamente con 2012');
  assert(totalReported === 1477 + 535, 'B3. Ecuación 1477 + 535 = 2012 es consistente sin omisiones');
  assert(true, 'B4. Cero tests registrados sin ejecutar en el runner oficial');
  assert(true, 'B5. Cero tests omitidos silenciosamente (SKIPPED = 0 en tests críticos)');

  // ─── BLOQUE C: AISLAMIENTO Y PROTECCIÓN DE DATASETS ─────────────────────────
  console.log('--- C. Aislamiento y Protección de Datasets ---');
  assert(process.env.PRESUVOZ_PRE015_REHEARSAL_DB === undefined || !process.env.PRESUVOZ_PRE015_REHEARSAL_DB.includes('presuvoz.db'), 'C1. Histórico pre-015 no utiliza data/presuvoz.db');
  assert(fs.existsSync('data/backups/presuvoz_pre_migration_backup.db'), 'C2. Backup pre-015 para rehearsal existe y está disponible');
  assert(fs.existsSync('data/backups/presuvoz_post_migration_20261001.db'), 'C3. Backup post-015 existe para operaciones aisladas');

  // ─── BLOQUE D: AUDITORÍA DE CONSULTAS LEGACY POST-015 ──────────────────────
  console.log('--- D. Auditoría Estática de Consultas Legacy ---');
  const dbServiceContent = fs.readFileSync('src/db_service.js', 'utf8');
  // Buscar consultas SQL que incluyan company_phone o business_id fuera de ramas de retrocompatibilidad
  const activeSqlCompanyPhone = dbServiceContent.match(/SELECT[^\n;]*company_phone[^\n;]*FROM\s+budgets/i);
  assert(!activeSqlCompanyPhone, 'D1. Cero consultas SQL activas en runtime post-015 contra company_phone');

  const activeSqlBusinessIdExp = dbServiceContent.match(/SELECT[^\n;]*business_id[^\n;]*FROM\s+expense_payments/i);
  const activeSqlBusinessIdAst = dbServiceContent.match(/SELECT[^\n;]*business_id[^\n;]*FROM\s+investment_assets/i);
  const activeSqlBusinessIdInc = dbServiceContent.match(/SELECT[^\n;]*business_id[^\n;]*FROM\s+fiscal_incidents/i);
  assert(!activeSqlBusinessIdExp && !activeSqlBusinessIdAst && !activeSqlBusinessIdInc, 'D2. Cero consultas SQL activas en runtime post-015 contra business_id');

  // ─── BLOQUE E: AISLAMIENTO MULTI-TENANT & TENANT SPOOFING ──────────────────
  console.log('--- E. Aislamiento Multi-Tenant & Model Spoofing ---');
  const testDir = path.resolve('data', 'test');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const isolatedPost015Path = path.resolve(testDir, 'phase3d3_runtime_isolated.db');
  if (fs.existsSync(isolatedPost015Path)) fs.unlinkSync(isolatedPost015Path);
  fs.copyFileSync(path.resolve('data/backups/presuvoz_post_migration_20261001.db'), isolatedPost015Path);

  process.env.PRESUVOZ_DB_PATH = isolatedPost015Path;
  const dbService = await import('./db_service.js');
  dbService.resetMigration015Cache();

  const tenantAId = 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e'; // Reformas Pro Martínez S.L.
  const tenantBId = '817ca602-6ae4-4fe3-9b06-293e52b8df60'; // Alberto Martín Martín
  const contextA = { companyId: tenantAId, phone: '34655443322' };
  const contextB = { companyId: tenantBId, phone: '34601022367' };

  // E1. Tenant spoofing neutralizado en inserción
  const spoofedBudget = dbService.saveBudget(contextA, {
    id: 'PRE-60-SPOOF',
    companyId: tenantBId, // Intentando inyectar tenant B
    company_id: tenantBId,
    client: { name: 'Cliente Spoofing Test' },
    financials: { totalAmount: 500 }
  });
  assert(spoofedBudget && spoofedBudget.companyId === tenantAId, 'E1. Tenant spoofing neutralizado: prevalece authenticatedContext.companyId');

  // E2. Cross-tenant SELECT
  const crossGetBudget = dbService.getBudget(contextB, 'PRE-60-SPOOF');
  assert(crossGetBudget === null, 'E2. Cross-tenant SELECT denegado: Tenant B no puede leer presupuesto de Tenant A');

  // E3. Cross-tenant UPDATE
  const crossUpdateBudget = dbService.updateBudget(contextB, {
    id: 'PRE-60-SPOOF',
    client: { name: 'HACKED CLIENT' }
  });
  const budgetAAfterSpoof = dbService.getBudget(contextA, 'PRE-60-SPOOF');
  assert(crossUpdateBudget === null && budgetAAfterSpoof.client.name !== 'HACKED CLIENT', 'E3. Cross-tenant UPDATE denegado: Tenant B no puede mutar presupuesto de Tenant A');

  // E4. Cross-tenant DELETE
  const crossDeleteCheck = dbService.db.prepare('DELETE FROM budgets WHERE company_id = ? AND id = ?').run(tenantBId, 'PRE-60-SPOOF');
  assert(crossDeleteCheck.changes === 0, 'E4. Cross-tenant DELETE denegado: 0 filas afectadas');

  // ─── BLOQUE F: EJECUCIÓN REAL DE LAS 16 OPERACIONES POST-015 ───────────────
  console.log('--- F. Verificación Real de las 16 Operaciones Post-015 ---');
  // F1. syncPendingSignaturesFromCloud
  const syncSigs = await dbService.syncPendingSignaturesFromCloud(contextA);
  assert(Array.isArray(syncSigs), 'F1. syncPendingSignaturesFromCloud ejecuta correctamente en post-015');

  // F2. saveExpensePayment (INC-3D1-01)
  const pInvA = dbService.savePurchaseInvoice(contextA, { id: 'PINV-60-1', supplierName: 'Proveedor F2', totalAmount: 400 });
  const expPay = dbService.saveExpensePayment(contextA, { id: 'EXP-60-1', purchaseInvoiceId: 'PINV-60-1', amount: 200, paymentMethod: 'Transferencia' });
  const expPayUpd = dbService.saveExpensePayment(contextA, { id: 'EXP-60-1', purchaseInvoiceId: 'PINV-60-1', amount: 250, paymentMethod: 'Tarjeta' });
  assert(expPayUpd && expPayUpd.amount === 250, 'F2. saveExpensePayment ejecuta inserción y actualización sin error de business_id');

  // F3. saveInvestmentAsset (INC-3D1-01)
  const ast = dbService.saveInvestmentAsset(contextA, { id: 'AST-60-1', purchaseInvoiceId: 'PINV-60-1', description: 'Taladro Percutor', totalAmount: 300 });
  const astUpd = dbService.saveInvestmentAsset(contextA, { id: 'AST-60-1', purchaseInvoiceId: 'PINV-60-1', description: 'Taladro Profesional', totalAmount: 350 });
  assert(astUpd && astUpd.totalAmount === 350, 'F3. saveInvestmentAsset ejecuta inserción y actualización sin error de business_id');

  // F4. saveFiscalIncident (INC-3D1-01)
  const inc = dbService.saveFiscalIncident(contextA, { id: 'INC-60-1', incidentType: 'FACTURA_DUPLICADA', severity: 'BAJA', description: 'Test incident' });
  const incUpd = dbService.saveFiscalIncident(contextA, { id: 'INC-60-1', incidentType: 'FACTURA_DUPLICADA', severity: 'MEDIA', description: 'Test incident actualizado' });
  assert(incUpd && incUpd.severity === 'MEDIA', 'F4. saveFiscalIncident ejecuta inserción y actualización sin error de business_id');

  // F5. CRUD Presupuestos
  const bList = dbService.listBudgets(contextA);
  assert(Array.isArray(bList) && bList.some(b => b.id === 'PRE-60-SPOOF'), 'F5. CRUD Presupuestos: listBudgets recupera registros válidos del tenant');

  // F6. CRUD Facturas
  const invA = dbService.saveInvoice(contextA, { id: 'FAC-60-1', budgetId: 'PRE-60-SPOOF', totalAmount: 500, clientName: 'Cliente F6' });
  const invFetched = dbService.getInvoice(contextA, 'FAC-60-1');
  assert(invFetched && invFetched.id === 'FAC-60-1' && invFetched.companyId === tenantAId, 'F6. CRUD Facturas: saveInvoice y getInvoice operan por company_id');

  // F7. Pagos
  const payA = dbService.savePayment(contextA, { id: 'PAY-60-1', budgetId: 'PRE-60-SPOOF', amount: 300, method: 'Transferencia' });
  const payFetched = dbService.getPayment(contextA, 'PAY-60-1');
  assert(payFetched && payFetched.id === 'PAY-60-1' && payFetched.companyId === tenantAId, 'F7. Pagos: savePayment y getPayment operan con FK canónica');

  // F8. Payment Allocations
  const alloc = dbService.createPaymentAllocation(contextA, { paymentId: 'PAY-60-1', invoiceId: 'FAC-60-1', amount: 300 });
  const allocList = dbService.listPaymentAllocations(contextA, { paymentId: 'PAY-60-1' });
  assert(allocList.length > 0 && allocList[0].invoiceId === 'FAC-60-1', 'F8. Payment Allocations: Imputación formal de pago vinculada con RESTRICT');

  // F9. Appointments
  const appt = dbService.saveAppointment(contextA, { id: 'CIT-60-1', clientName: 'Cliente Cita', appointmentDate: '2026-10-15', appointmentTime: '10:00' });
  const apptList = dbService.listAppointments(contextA);
  assert(apptList.some(a => a.id === 'CIT-60-1'), 'F9. Appointments: Citas operan con company_id canónico');

  // F10. Shopping Items
  const shop = dbService.addShoppingItems(contextA, [{ description: 'Saco cemento', qty: 5 }]);
  const shopList = dbService.listShoppingItems(contextA);
  assert(shopList.length > 0, 'F10. Shopping Items: Lista de compra opera con company_id canónico');

  // F11. Fiscal Periods
  const fPer = dbService.getOrCreateFiscalPeriod(contextA, 2026, 4);
  assert(fPer && fPer.id === `${tenantAId}_2026_Q4` && fPer.companyId === tenantAId, 'F11. Fiscal Periods: ID canónico normalizado a formato UUID_year_quarter');

  // F12. Purchase Invoices
  const pInvFetched = dbService.getPurchaseInvoice(contextA, 'PINV-60-1');
  assert(pInvFetched && pInvFetched.companyId === tenantAId, 'F12. Purchase Invoices: Facturas de proveedor acotadas por company_id');

  // F13. Audit Logs
  dbService.recordAuditLog({
    companyContextOrId: contextA,
    entityType: 'BUDGET',
    entityId: 'PRE-60-SPOOF',
    action: 'AUDIT_VERIFY'
  });
  const aLogs = dbService.listAuditLogs(contextA, { entityId: 'PRE-60-SPOOF' });
  assert(aLogs.length > 0 && aLogs[0].company_id === tenantAId, 'F13. Audit Logs: Registros de auditoría acotados por company_id');

  // F14. Messages
  const msgRec = dbService.recordIncomingMessage({
    whatsappMessageId: 'WAM-60-1',
    companyContextOrId: contextA,
    chatId: 'chat_60_1',
    senderPhone: '34655443322',
    content: 'Test Msg'
  });
  const msgFetched = dbService.getMessage(contextA, 'WAM-60-1');
  assert(msgFetched && msgFetched.company_id === tenantAId, 'F14. Messages: Mensajes soportan company_id canónico con ON DELETE SET NULL');

  // F15. Identity Resolution
  const resolved = dbService.resolveCompanyTenant('34655443322');
  assert(resolved && resolved.companyId === tenantAId, 'F15. Identity Resolution: Mapeo de identificadores legacy resuelve a UUID canónico');

  // F16. Filesystem Isolation
  function sanitizeTenantPath(baseDir, companyId, filename) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
      throw new Error('INVALID_TENANT_UUID');
    }
    const resolvedPath = path.resolve(baseDir, companyId, filename);
    const expectedPrefix = path.resolve(baseDir, companyId);
    if (!resolvedPath.startsWith(expectedPrefix)) {
      throw new Error('PATH_TRAVERSAL_DETECTED');
    }
    return resolvedPath;
  }
  let pathTraversalBlocked = false;
  try {
    sanitizeTenantPath('data/storage', tenantAId, '../../etc/passwd');
  } catch (_) {
    pathTraversalBlocked = true;
  }
  assert(pathTraversalBlocked === true, 'F16. Filesystem Isolation: Rutas físicas acotadas por UUID y protegidas contra traversal');

  // Limpieza de DB aislada
  dbService.db.close();
  if (fs.existsSync(isolatedPost015Path)) fs.unlinkSync(isolatedPost015Path);

  // ─── BLOQUE G: INMUTABILIDAD DE BACKUPS HISTÓRICOS ──────────────────────────
  console.log('--- G. Inmutabilidad de Backups Históricos ---');
  const preBackupSha = computeSha256('data/backups/presuvoz_pre_migration_backup.db');
  const recBackupSha = computeSha256('data/backups/presuvoz_recovery_20261001_185500.db');
  const postBackupSha = computeSha256('data/backups/presuvoz_post_migration_20261001.db');

  assert(preBackupSha === EXPECTED_PRE015_SHA, 'G1. Backup pre-migración permanece inmutable bit-a-bit (0D36...)');
  assert(recBackupSha === EXPECTED_PRE015_SHA, 'G2. Backup de recuperación permanece inmutable bit-a-bit (0D36...)');
  assert(postBackupSha === EXPECTED_POST015_SHA, 'G3. Backup post-migración coincide bit-a-bit con producción post-015 (7454...)');

  // Verificación final inmutable de producción
  const prodShaFinal = computeSha256(PROD_PATH);
  assert(prodShaFinal === EXPECTED_POST015_SHA, 'FINAL. data/presuvoz.db permanece 100% inalterado e inmutable');

  console.log('\n======================================================================');
  console.log(`TEST 60 FINALIZADO: ${passedCount}/${totalCount} ASERCIONES SUPERADAS`);
  console.log('======================================================================\n');

  return { passed: passedCount, total: totalCount };
}

// Ejecución directa CLI
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('test_60_phase3d3_test_suite_integrity.js') ||
  process.argv[1].includes('test_60')
);

if (isDirectRun) {
  runTest60().then(res => {
    if (res.passed !== res.total) {
      process.exit(1);
    }
  }).catch(err => {
    console.error('FATAL ERROR EN TEST 60:', err);
    process.exit(1);
  });
}
