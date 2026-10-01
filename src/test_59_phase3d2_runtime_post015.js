/**
 * PresuVoz — TEST 59: Post-015 Runtime Compatibility & Regression Hardening
 * FASE 3D.2: VALIDACIÓN DE LAS 4 RUTAS CORREGIDAS Y MODEL INJECTION EN POST-015
 * 
 * Reglas de Seguridad:
 * 1. Producción (data/presuvoz.db) es estrictamente de SOLO LECTURA y su SHA no debe cambiar.
 * 2. Todas las escrituras y pruebas adversariales se realizan en data/test/phase3d2_post015_runtime.db.
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

export async function runTest59() {
  if (process.env.PRESUVOZ_TEST59_CHILD !== 'true') {
    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, [scriptPath], {
      env: { ...process.env, PRESUVOZ_TEST59_CHILD: 'true' },
      stdio: 'inherit'
    });
    if (child.status !== 0) {
      throw new Error(`Test 59 Failed with status code ${child.status}`);
    }
    return { passed: 19, total: 19 };
  }

  console.log('\n======================================================================');
  console.log('TEST 59: POST-015 RUNTIME COMPATIBILITY & REGRESSION HARDENING (FASE 3D.2)');
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

  // 1. Preparar copia aislada post-015 para runtime tests
  const testDir = path.resolve('data', 'test');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const testRuntimeDbPath = path.resolve(testDir, 'phase3d2_post015_runtime.db');
  if (fs.existsSync(testRuntimeDbPath)) fs.unlinkSync(testRuntimeDbPath);
  fs.copyFileSync(PROD_PATH, testRuntimeDbPath);

  // Configurar entorno para que db_service apunte a la copia de test aislada
  process.env.PRESUVOZ_DB_PATH = testRuntimeDbPath;
  const dbService = await import('./db_service.js');
  dbService.resetMigration015Cache();

  const tenantAId = 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e'; // Reformas Pro Martínez
  const tenantBId = '817ca602-6ae4-4fe3-9b06-293e52b8df60'; // Alberto Martín Martín
  const contextA = { companyId: tenantAId, phone: '34655443322' };
  const contextB = { companyId: tenantBId, phone: '34601022367' };

  // ─── A. syncPendingSignaturesFromCloud() ────────────────────────────────────
  console.log('--- A. Auditoría de syncPendingSignaturesFromCloud en Post-015 ---');
  let syncError = null;
  let syncResult = null;
  try {
    syncResult = await dbService.syncPendingSignaturesFromCloud(contextA);
  } catch (err) {
    syncError = err;
  }
  assert(syncError === null, 'A1. syncPendingSignaturesFromCloud se ejecuta sin errores SQLITE_ERROR en post-015');
  assert(Array.isArray(syncResult), 'A2. syncPendingSignaturesFromCloud retorna un array legítimo');

  // Verificar que la consulta SQL en código no contiene company_phone
  const dbServiceSrc = fs.readFileSync('src/db_service.js', 'utf8');
  const syncMatch = dbServiceSrc.match(/syncPendingSignaturesFromCloud[\s\S]*?SELECT([\s\S]*?)FROM\s+budgets/i);
  const syncSelectCols = syncMatch ? syncMatch[1] : '';
  assert(!syncSelectCols.includes('company_phone'), 'A3. Consulta SQL de syncPendingSignaturesFromCloud no proyecta company_phone');

  // ─── B. saveExpensePayment() ───────────────────────────────────────────────
  console.log('--- B. Auditoría de saveExpensePayment en Post-015 ---');
  // 1. Crear factura de compra y pago para Tenant A
  const pInvA = dbService.savePurchaseInvoice(contextA, {
    id: 'PINV-TEST-59-A',
    supplierName: 'Proveedor Materiales A',
    totalAmount: 1000
  });

  const pPayA = dbService.saveExpensePayment(contextA, {
    id: 'EXP-PAY-59-1',
    purchaseInvoiceId: 'PINV-TEST-59-A',
    amount: 200,
    paymentMethod: 'Transferencia'
  });
  assert(pPayA && pPayA.id === 'EXP-PAY-59-1', 'B1. Inserción inicial de expense_payment en post-015 exitosa');

  // 2. Actualización legítima por el mismo tenant
  const pPayAUpdated = dbService.saveExpensePayment(contextA, {
    id: 'EXP-PAY-59-1',
    purchaseInvoiceId: 'PINV-TEST-59-A',
    amount: 350,
    paymentMethod: 'Tarjeta'
  });
  assert(pPayAUpdated && pPayAUpdated.amount === 350, 'B2. Actualización de expense_payment existente en post-015 exitosa (sin colisión de business_id)');

  // 3. Intento de actualización cruzada por Tenant B
  const pPayCross = dbService.saveExpensePayment(contextB, {
    id: 'EXP-PAY-59-1',
    amount: 9999
  });
  assert(pPayCross === null, 'B3. Actualización cruzada de expense_payment de Tenant A por Tenant B rechazada (retorna null)');

  // Comprobar que en DB sigue intacto el valor de Tenant A
  const checkPayDb = new DatabaseSync(testRuntimeDbPath, { readOnly: true });
  const rowPay = checkPayDb.prepare('SELECT amount, company_id FROM expense_payments WHERE id = ?').get('EXP-PAY-59-1');
  assert(rowPay && rowPay.amount === 350 && rowPay.company_id === tenantAId, 'B4. Registro en base de datos permanece intacto tras intento cruzado');

  // 4. Model Injection en saveExpensePayment
  const pPayInjected = dbService.saveExpensePayment(contextA, {
    id: 'EXP-PAY-59-INJECT',
    purchaseInvoiceId: 'PINV-TEST-59-A',
    companyId: '00000000-0000-0000-0000-000000000000',
    company_id: 'fake-tenant',
    business_id: '34699999999',
    company_phone: '34699999999',
    amount: 150
  });
  const rowPayInjected = checkPayDb.prepare('SELECT company_id FROM expense_payments WHERE id = ?').get('EXP-PAY-59-INJECT');
  assert(rowPayInjected && rowPayInjected.company_id === tenantAId, 'B5. Model injection en saveExpensePayment neutralizado: prevalece contextA.companyId');

  // ─── C. saveInvestmentAsset() ──────────────────────────────────────────────
  console.log('--- C. Auditoría de saveInvestmentAsset en Post-015 ---');
  // 1. Inserción inicial por Tenant A
  const assetA = dbService.saveInvestmentAsset(contextA, {
    id: 'AST-59-1',
    purchaseInvoiceId: 'PINV-TEST-59-A',
    description: 'Furgoneta Taller A',
    totalAmount: 15000
  });
  assert(assetA && assetA.id === 'AST-59-1', 'C1. Inserción inicial de investment_asset en post-015 exitosa');

  // 2. Actualización legítima por Tenant A
  const assetAUpdated = dbService.saveInvestmentAsset(contextA, {
    id: 'AST-59-1',
    purchaseInvoiceId: 'PINV-TEST-59-A',
    description: 'Furgoneta Taller A (Revisada)',
    totalAmount: 15500
  });
  assert(assetAUpdated && assetAUpdated.totalAmount === 15500, 'C2. Actualización de investment_asset existente en post-015 exitosa (sin colisión de business_id)');

  // 3. Intento de actualización cruzada por Tenant B
  const assetCross = dbService.saveInvestmentAsset(contextB, {
    id: 'AST-59-1',
    totalAmount: 99999
  });
  assert(assetCross === null, 'C3. Actualización cruzada de investment_asset de Tenant A por Tenant B rechazada (retorna null)');

  const rowAsset = checkPayDb.prepare('SELECT total_amount, company_id FROM investment_assets WHERE id = ?').get('AST-59-1');
  assert(rowAsset && rowAsset.total_amount === 15500 && rowAsset.company_id === tenantAId, 'C4. Registro de bien de inversión permanece inalterado tras intento cruzado');

  // 4. Model Injection en saveInvestmentAsset
  const assetInjected = dbService.saveInvestmentAsset(contextA, {
    id: 'AST-59-INJECT',
    purchaseInvoiceId: 'PINV-TEST-59-A',
    companyId: '00000000-0000-0000-0000-000000000000',
    business_id: '34699999999',
    description: 'Activo Inyectado',
    totalAmount: 500
  });
  const rowAssetInjected = checkPayDb.prepare('SELECT company_id FROM investment_assets WHERE id = ?').get('AST-59-INJECT');
  assert(rowAssetInjected && rowAssetInjected.company_id === tenantAId, 'C5. Model injection en saveInvestmentAsset neutralizado: prevalece contextA.companyId');

  // ─── D. saveFiscalIncident() ───────────────────────────────────────────────
  console.log('--- D. Auditoría de saveFiscalIncident en Post-015 ---');
  // 1. Inserción inicial por Tenant A
  const incA = dbService.saveFiscalIncident(contextA, {
    id: 'INC-59-1',
    entityType: 'PURCHASE_INVOICE',
    entityId: 'PINV-TEST-59-A',
    message: 'Advertencia fiscal inicial',
    severity: 'WARNING'
  });
  assert(incA && incA.id === 'INC-59-1', 'D1. Inserción inicial de fiscal_incident en post-015 exitosa');

  // 2. Actualización legítima por Tenant A
  const incAUpdated = dbService.saveFiscalIncident(contextA, {
    id: 'INC-59-1',
    entityType: 'PURCHASE_INVOICE',
    entityId: 'PINV-TEST-59-A',
    message: 'Advertencia fiscal subsanada',
    severity: 'RESOLVED',
    resolutionStatus: 'RESOLVED'
  });
  assert(incAUpdated && incAUpdated.message === 'Advertencia fiscal subsanada', 'D2. Actualización de fiscal_incident existente en post-015 exitosa (sin colisión de business_id)');

  // 3. Intento de actualización cruzada por Tenant B
  const incCross = dbService.saveFiscalIncident(contextB, {
    id: 'INC-59-1',
    message: 'Modificación ilegítima'
  });
  assert(incCross === null, 'D3. Actualización cruzada de fiscal_incident de Tenant A por Tenant B rechazada (retorna null)');

  const rowInc = checkPayDb.prepare('SELECT message, company_id FROM fiscal_incidents WHERE id = ?').get('INC-59-1');
  assert(rowInc && rowInc.message === 'Advertencia fiscal subsanada' && rowInc.company_id === tenantAId, 'D4. Registro de incidencia fiscal permanece inalterado tras intento cruzado');

  // 4. Model Injection en saveFiscalIncident
  const incInjected = dbService.saveFiscalIncident(contextA, {
    id: 'INC-59-INJECT',
    entityType: 'PURCHASE_INVOICE',
    entityId: 'PINV-TEST-59-A',
    companyId: '00000000-0000-0000-0000-000000000000',
    business_id: '34699999999',
    message: 'Incidencia Inyectada'
  });
  const rowIncInjected = checkPayDb.prepare('SELECT company_id FROM fiscal_incidents WHERE id = ?').get('INC-59-INJECT');
  assert(rowIncInjected && rowIncInjected.company_id === tenantAId, 'D5. Model injection en saveFiscalIncident neutralizado: prevalece contextA.companyId');

  checkPayDb.close();
  dbService.db.close();

  // Limpieza de base de datos de prueba post-015
  try {
    if (fs.existsSync(testRuntimeDbPath)) fs.unlinkSync(testRuntimeDbPath);
  } catch (_) {}

  // ─── E. Verificación estricta de Producción ────────────────────────────────
  const finalProdSha = computeSha256(PROD_PATH);
  assert(finalProdSha === initialProdSha, `E1. Verificación de seguridad: Producción SHA-256 permanece 100% idéntico e inmutable (${finalProdSha})`);

  console.log('\n======================================================================');
  console.log(`TEST 59 FINALIZADO: ${passedCount}/${totalCount} ASERCIONES SUPERADAS`);
  console.log('======================================================================\n');

  return { passed: passedCount, total: totalCount };
}

// Ejecución directa CLI
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('test_59_phase3d2_runtime_post015.js') ||
  process.argv[1].includes('test_59')
);

if (isDirectRun) {
  runTest59().then(res => {
    if (res.passed !== res.total) {
      process.exit(1);
    }
  }).catch(err => {
    console.error('FATAL ERROR EN TEST 59:', err);
    process.exit(1);
  });
}
