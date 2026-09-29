/**
 * PresuVoz — Migración 010: Expense Payments Company ID
 * 
 * Versión: 10
 * Fecha: 2026-09-30
 * 
 * Contrato:
 * 1. Establece la identidad canónica multi-tenant para `expense_payments`:
 *    - Añade columna `company_id TEXT NOT NULL` con FOREIGN KEY a `companies(id) ON DELETE RESTRICT`.
 *      (ON DELETE RESTRICT previene la eliminación accidental de registros de pagos de gastos si una empresa es borrada).
 *    - Conserva `id TEXT PRIMARY KEY` intacto como clave primaria.
 *    - Conserva `purchase_invoice_id TEXT NOT NULL` intacto para vinculación documental con `purchase_invoices`.
 *    - Conserva `business_id TEXT NOT NULL` para compatibilidad legacy e interoperabilidad (dual-write).
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_expense_pay_company` (company_id)
 *        `idx_expense_pay_company_date` (company_id, payment_date)
 *        `idx_expense_pay_invoice` (purchase_invoice_id)
 *        `idx_expense_pay_biz_date` (business_id, payment_date)
 *        `idx_expense_pay_biz_invoice` (business_id, purchase_invoice_id)
 * 2. Backfill determinista de `expense_payments`:
 *    - Resuelve `expense_payments.business_id -> companies.phone -> companies.id`.
 *    - Si no existe empresa asociada o es ambigua: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Validación relacional: Si la factura recibida asociada existe, verifica que su company_id coincida (prevención cross-tenant).
 *    - Valida que el recuento final de filas coincida exactamente con el recuento original.
 * 3. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 10,
  name: '010_expense_payments_company_id',
  up: (db) => {
    // 1. Comprobar si la tabla ya existe
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='expense_payments'").get();

    if (!tableExists) {
      // Base de datos nueva: crear directamente con el esquema canónico
      db.exec(`
        CREATE TABLE IF NOT EXISTS expense_payments (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          purchase_invoice_id TEXT NOT NULL,
          business_id TEXT NOT NULL,
          amount REAL NOT NULL,
          payment_date TEXT NOT NULL,
          payment_method TEXT,
          reference TEXT,
          created_at TEXT,
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_expense_pay_company ON expense_payments(company_id);
        CREATE INDEX IF NOT EXISTS idx_expense_pay_company_date ON expense_payments(company_id, payment_date);
        CREATE INDEX IF NOT EXISTS idx_expense_pay_invoice ON expense_payments(purchase_invoice_id);
        CREATE INDEX IF NOT EXISTS idx_expense_pay_biz_date ON expense_payments(business_id, payment_date);
        CREATE INDEX IF NOT EXISTS idx_expense_pay_biz_invoice ON expense_payments(business_id, purchase_invoice_id);
      `);
      return;
    }

    const cols = db.prepare('PRAGMA table_info("expense_payments")').all();
    const companyIdCol = cols.find(c => c.name === 'company_id');
    if (companyIdCol) {
      // Ya migrada
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_expense_pay_company ON expense_payments(company_id);
        CREATE INDEX IF NOT EXISTS idx_expense_pay_company_date ON expense_payments(company_id, payment_date);
        CREATE INDEX IF NOT EXISTS idx_expense_pay_invoice ON expense_payments(purchase_invoice_id);
        CREATE INDEX IF NOT EXISTS idx_expense_pay_biz_date ON expense_payments(business_id, payment_date);
        CREATE INDEX IF NOT EXISTS idx_expense_pay_biz_invoice ON expense_payments(business_id, purchase_invoice_id);
      `);
      return;
    }

    // 2. Obtener todas las filas existentes
    const rows = db.prepare('SELECT * FROM expense_payments').all();

    // 3. Crear tabla temporal expense_payments_new
    db.exec(`
      CREATE TABLE expense_payments_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        purchase_invoice_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        amount REAL NOT NULL,
        payment_date TEXT NOT NULL,
        payment_method TEXT,
        reference TEXT,
        created_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);

    // Helper para buscar empresa por teléfono exacto o normalizado
    const findCompaniesByPhone = (rawPhone) => {
      if (!rawPhone) return [];
      const clean = String(rawPhone).replace(/\D/g, '');
      return db.prepare(`
        SELECT id, phone FROM companies 
        WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
      `).all(rawPhone, clean);
    };

    // Helper para verificar existencia e identidad de la factura recibida (si existe la tabla)
    const pinvTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_invoices'").get();
    let getInvoiceStmt = null;
    if (pinvTableExists) {
      const pinvCols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
      const pinvHasCompanyId = pinvCols.some(c => c.name === 'company_id');
      if (pinvHasCompanyId) {
        getInvoiceStmt = db.prepare('SELECT id, company_id, business_id FROM purchase_invoices WHERE id = ?');
      }
    }

    const insertStmt = db.prepare(`
      INSERT INTO expense_payments_new (
        id, company_id, purchase_invoice_id, business_id, amount,
        payment_date, payment_method, reference, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      let resolvedCompanyId = null;

      if (row.company_id && typeof row.company_id === 'string' && row.company_id.includes('-')) {
        const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(row.company_id);
        if (!comp) {
          throw new Error(`❌ [Migración 010] Fallo de integridad: company_id '${row.company_id}' no existe en companies.`);
        }
        resolvedCompanyId = comp.id;
      } else {
        if (!row.business_id) {
          throw new Error(`❌ [Migración 010] Fallo de integridad: Pago de gasto '${row.id}' sin business_id.`);
        }
        const matches = findCompaniesByPhone(row.business_id);
        if (matches.length === 0) {
          throw new Error(
            `❌ [Migración 010] Fallo crítico de integridad: Pago de gasto '${row.id}' con business_id '${row.business_id}' huérfano. No existe empresa asociada en companies (fail-closed).`
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `❌ [Migración 010] Ambigüedad crítica: Múltiples empresas coinciden con el business_id '${row.business_id}' para pago de gasto '${row.id}'.`
          );
        }
        resolvedCompanyId = matches[0].id;
      }

      // Validación relacional: Si la factura recibida existe, asegurar coincidencia de tenant
      if (getInvoiceStmt && row.purchase_invoice_id) {
        const invRow = getInvoiceStmt.get(row.purchase_invoice_id);
        if (invRow && invRow.company_id && invRow.company_id !== resolvedCompanyId) {
          throw new Error(
            `❌ [Migración 010] Fallo crítico de aislamiento: Pago de gasto '${row.id}' pertenece a empresa '${resolvedCompanyId}' pero su factura asociada '${row.purchase_invoice_id}' pertenece a empresa '${invRow.company_id}'. Inconsistencia cross-tenant detectada.`
          );
        }
      }

      // Normalizar business_id a dígitos para mantener consistencia
      const cleanBusinessId = String(row.business_id).replace(/\D/g, '') || String(row.business_id);

      insertStmt.run(
        row.id,
        resolvedCompanyId,
        row.purchase_invoice_id || '',
        cleanBusinessId,
        Number(row.amount || 0),
        row.payment_date,
        row.payment_method || null,
        row.reference || null,
        row.created_at || new Date().toISOString()
      );
    }

    // 4. Reemplazo atómico de tabla
    db.exec('DROP TABLE expense_payments;');
    db.exec('ALTER TABLE expense_payments_new RENAME TO expense_payments;');

    // 5. Crear índices
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_expense_pay_company ON expense_payments(company_id);
      CREATE INDEX IF NOT EXISTS idx_expense_pay_company_date ON expense_payments(company_id, payment_date);
      CREATE INDEX IF NOT EXISTS idx_expense_pay_invoice ON expense_payments(purchase_invoice_id);
      CREATE INDEX IF NOT EXISTS idx_expense_pay_biz_date ON expense_payments(business_id, payment_date);
      CREATE INDEX IF NOT EXISTS idx_expense_pay_biz_invoice ON expense_payments(business_id, purchase_invoice_id);
    `);

    // 6. Verificar conteos
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM expense_payments').get().cnt;
    if (newCount !== rows.length) {
      throw new Error(
        `❌ [Migración 010] Discrepancia en recuento de filas tras migración: antes=${rows.length}, después=${newCount}`
      );
    }
  }
};
