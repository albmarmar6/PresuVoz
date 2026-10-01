import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executeCanonicalMigration } from './migrations/015_structural_canonical_company_id.js';

console.log('=== TEST DE ARRANQUE Y COMPATIBILIDAD CON DB MIGRADA ===');

const runtimeDbPath = 'data/presuvoz_phase3b_runtime_startup_test.db';
// Copiar desde el dataset de producción de forma completamente aislada
fs.copyFileSync('data/presuvoz.db', runtimeDbPath);

// Aplicar migración canónica 015 en la base de test aislada
const setupDb = new DatabaseSync(runtimeDbPath);
setupDb.exec('PRAGMA foreign_keys = ON;');
executeCanonicalMigration(setupDb);
setupDb.close();

// Configurar entorno apuntando exclusivamente a la DB migrada antes de importar los servicios
process.env.PRESUVOZ_DB_PATH = path.resolve(runtimeDbPath);

// Importar servicios dinámicamente con la DB migrada conectada
const dbService = await import('./db_service.js');
dbService.resetMigration015Cache();

// Validar que abre sin errores
console.log('1. DB Connection: OK');

// Validar operaciones básicas en todos los módulos
const albertoCompanyId = '817ca602-6ae4-4fe3-9b06-293e52b8df60';
const context = { companyId: albertoCompanyId, phone: '34601022367' };

// Presupuestos
const budgets = dbService.listBudgets(context);
console.log(`2. listBudgets: OK (${budgets.length} encontrados)`);

// Facturas
const invoices = dbService.listInvoices(context);
console.log(`3. listInvoices: OK (${invoices.length} encontradas)`);

// Pagos
const payments = dbService.listPayments(context);
console.log(`4. listPayments: OK (${payments.length} encontrados)`);

// Citas
const appointments = dbService.listAppointments(context);
console.log(`5. listAppointments: OK (${appointments.length} encontradas)`);

// Shopping items
const shopping = dbService.listShoppingItems(context);
console.log(`6. listShoppingItems: OK (${shopping.length} encontrados)`);

// Fiscal
const fiscalCompanyId = 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e';
const fiscalContext = { companyId: fiscalCompanyId, phone: '34655443322' };
const taxProfile = dbService.getTaxProfile(fiscalContext);
console.log(`7. getTaxProfile: OK (tax_id: ${taxProfile?.taxId || taxProfile?.tax_id})`);

const purchaseInvoices = dbService.listPurchaseInvoices(fiscalContext);
console.log(`8. listPurchaseInvoices: OK (${purchaseInvoices.length} encontradas)`);

const assets = dbService.listInvestmentAssets(fiscalContext);
console.log(`9. listInvestmentAssets: OK (${assets.length} encontrados)`);

const incidents = dbService.listFiscalIncidents(fiscalContext);
console.log(`10. listFiscalIncidents: OK (${incidents.length} encontradas)`);

const logs = dbService.listAuditLogs(fiscalContext);
console.log(`11. listAuditLogs: OK (${logs.length} encontrados)`);

// Storage y Filesystem
const logoPath = path.resolve('data', 'logos', albertoCompanyId);
const receiptPath = path.resolve('data', 'purchase_receipts', fiscalCompanyId);
const exportPath = path.resolve('data', 'fiscal_exports', 'Cierre_Fiscal_2026_Q3_B87654321.zip');

console.log(`12. Filesystem check:`);
console.log(`    - Logo dir: ${logoPath}`);
console.log(`    - Receipt dir: ${receiptPath}`);
console.log(`    - Export zip exists? ${fs.existsSync(exportPath)}`);

dbService.db.close();
try { fs.unlinkSync(runtimeDbPath); } catch (_) {}

console.log('✨ TEST DE ARRANQUE Y COMPATIBILIDAD CONCLUIDO CON ÉXITO: Cero errores de columna legacy.');
