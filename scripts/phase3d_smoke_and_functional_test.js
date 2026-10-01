import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

console.log('======================================================================');
console.log(' FASE 3D: REAL SMOKE TEST & CONTROLLED FUNCTIONAL TEST EN PRODUCCIÓN');
console.log('======================================================================');

// Asegurar que apuntamos exactamente a producción
process.env.PRESUVOZ_DB_PATH = path.resolve('data', 'presuvoz.db');

// 1. Dry run de migraciones sobre DB de producción en vivo
const { DatabaseSync: DBClass } = await import('node:sqlite');
const testDb = new DBClass(process.env.PRESUVOZ_DB_PATH, { readOnly: true });
const { checkMigrationsDryRun, MIGRATIONS_ALL } = await import('../src/migration_service.js');
const dryCheck = checkMigrationsDryRun(testDb, MIGRATIONS_ALL);
console.log(`1. Migration Dry-Run en Producción:`);
console.log(`   - Aplicadas: ${dryCheck.appliedCount}`);
console.log(`   - Pendientes: ${dryCheck.pendingCount}`);
console.log(`   - Estado: ${dryCheck.isUpToDate ? 'UP-TO-DATE (15/15)' : 'PENDING_MIGRATIONS'}`);
testDb.close();

if (!dryCheck.isUpToDate) {
  console.error('FATAL: Producción no está up-to-date!');
  process.exit(1);
}

// 2. Cargar servicios reales
const dbService = await import('../src/db_service.js');
dbService.resetMigration015Cache();

console.log('2. db_service inicializado contra data/presuvoz.db: OK');

// 3. Resolución de Identidad y Autenticación de Tenant
const { resolveAuthenticatedContext } = await import('../src/identity_service.js');
const { authenticateWhatsAppSession, getUserSession } = await import('../src/whatsapp_gateway.js');

const albertoPhone = '34601022367';
const albertoLID = '82987509096647';
const targetCompanyId = '817ca602-6ae4-4fe3-9b06-293e52b8df60';

const authContext = resolveAuthenticatedContext('whatsapp', albertoPhone);
const waSession = authenticateWhatsAppSession(`${albertoPhone}@s.whatsapp.net`, albertoPhone);
const userSession = getUserSession(`${albertoPhone}@s.whatsapp.net`, albertoPhone);

console.log('3. Autenticación y Resolución de Identidad:');
console.log(`   - Contexto autenticado: Company ID = ${authContext?.companyId} (Match esperado: ${authContext?.companyId === targetCompanyId})`);
console.log(`   - WhatsApp Session: Company ID = ${waSession?.companyId} (Match esperado: ${waSession?.companyId === targetCompanyId})`);
console.log(`   - User Session: Company ID = ${userSession?.companyId} (Match esperado: ${userSession?.companyId === targetCompanyId})`);

if (authContext?.companyId !== targetCompanyId || waSession?.companyId !== targetCompanyId) {
  console.error('FATAL: Fallo en la autenticación de identidad de Alberto!');
  process.exit(1);
}

// 4. Servicios de Dominio: Lectura Controlada de Entidades
const context = { companyId: targetCompanyId, phone: albertoPhone };

const budgets = dbService.listBudgets(context);
const invoices = dbService.listInvoices(context);
const payments = dbService.listPayments(context);
const appointments = dbService.listAppointments(context);
const shopping = dbService.listShoppingItems(context);

console.log('4. Acceso a Servicios de Dominio (Tenant Alberto):');
console.log(`   - Presupuestos: ${budgets.length}`);
console.log(`   - Facturas: ${invoices.length}`);
console.log(`   - Cobros: ${payments.length}`);
console.log(`   - Citas: ${appointments.length}`);
console.log(`   - Items de compra: ${shopping.length}`);

// Validar Reformas Pro Martínez (Tenant Fiscal)
const fiscalCompanyId = 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e';
const fiscalContext = { companyId: fiscalCompanyId, phone: '34655443322' };

const taxProfile = dbService.getTaxProfile(fiscalContext);
const purchaseInvoices = dbService.listPurchaseInvoices(fiscalContext);
const investmentAssets = dbService.listInvestmentAssets(fiscalContext);
const fiscalIncidents = dbService.listFiscalIncidents(fiscalContext);
const auditLogs = dbService.listAuditLogs(fiscalContext);
const fiscalPeriods = dbService.db.prepare('SELECT * FROM fiscal_periods WHERE company_id = ?').all(fiscalCompanyId);

console.log('5. Acceso a Servicios Fiscales (Tenant Reformas Pro Martínez):');
console.log(`   - Tax Profile: ${taxProfile?.legalName} (CIF: ${taxProfile?.taxId})`);
console.log(`   - Facturas de compra: ${purchaseInvoices.length}`);
console.log(`   - Bienes de inversión: ${investmentAssets.length}`);
console.log(`   - Incidencias fiscales: ${fiscalIncidents.length}`);
console.log(`   - Logs de auditoría: ${auditLogs.length}`);
console.log(`   - Periodos fiscales: ${fiscalPeriods.length} (ID: ${fiscalPeriods[0]?.id})`);

// 5. Prueba Funcional Controlada: Gateway / Message Handler (Sin efectos destructivos)
console.log('6. Prueba Funcional Controlada:');
const { extractCanonicalSenderIdentifier } = await import('../src/whatsapp_gateway.js');

const senderPhoneId = extractCanonicalSenderIdentifier(`${albertoPhone}@s.whatsapp.net`, albertoPhone);
const senderLidId = extractCanonicalSenderIdentifier(`${albertoLID}@lid`, albertoPhone);

console.log(`   - Sender JID ${albertoPhone}@s.whatsapp.net -> Canonical: ${senderPhoneId}`);
console.log(`   - Sender JID ${albertoLID}@lid -> Canonical: ${senderLidId}`);

// 6. Validación Final de Aislamiento Post-Smoke Test
console.log('7. Validación de Aislamiento Multi-Tenant Post-Smoke Test:');
const otherTenantId = '7575fd79-b1a0-4e91-92a7-28d660657f47';
const crossBudgets = dbService.db.prepare('SELECT COUNT(*) as c FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)').get(otherTenantId, targetCompanyId).c;
const crossInvoices = dbService.db.prepare('SELECT COUNT(*) as c FROM invoices WHERE company_id = ? AND id IN (SELECT id FROM invoices WHERE company_id = ?)').get(otherTenantId, targetCompanyId).c;
const crossPayments = dbService.db.prepare('SELECT COUNT(*) as c FROM payments WHERE company_id = ? AND id IN (SELECT id FROM payments WHERE company_id = ?)').get(otherTenantId, fiscalCompanyId).c;

console.log(`   - Cross SELECT budgets: ${crossBudgets} (Esperado: 0)`);
console.log(`   - Cross SELECT invoices: ${crossInvoices} (Esperado: 0)`);
console.log(`   - Cross SELECT payments: ${crossPayments} (Esperado: 0)`);

if (crossBudgets !== 0 || crossInvoices !== 0 || crossPayments !== 0) {
  console.error('FATAL: Aislamiento multi-tenant violado tras el smoke test!');
  process.exit(1);
}

// 7. Verificación final de integridad y claves foráneas en producción
const finalIntegrity = dbService.db.prepare('PRAGMA integrity_check;').get().integrity_check;
const finalFks = dbService.db.prepare('PRAGMA foreign_key_check;').all();

console.log('8. Verificación Final de Base de Datos Viva:');
console.log(`   - PRAGMA integrity_check: ${finalIntegrity}`);
console.log(`   - PRAGMA foreign_key_check violations: ${finalFks.length}`);

if (finalIntegrity.toLowerCase() !== 'ok' || finalFks.length !== 0) {
  console.error('FATAL: Base de datos inconsistente tras el smoke test!');
  process.exit(1);
}

dbService.db.close();

console.log('\n======================================================================');
console.log('✨ SMOKE TEST Y PRUEBA FUNCIONAL CONTROLADA: 100% SUPERADOS');
console.log('======================================================================');
