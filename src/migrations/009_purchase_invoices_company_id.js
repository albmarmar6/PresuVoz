/**
 * PresuVoz — Migración 009: Purchase Invoices Company ID
 * 
 * Versión: 9
 * Fecha: 2026-09-30
 * 
 * Contrato:
 * 1. Establece la identidad canónica multi-tenant para `purchase_invoices`:
 *    - Añade columna `company_id TEXT NOT NULL` con FOREIGN KEY a `companies(id) ON DELETE RESTRICT`.
 *      (ON DELETE RESTRICT previene la eliminación accidental de facturas de compra históricas al borrar empresa).
 *    - Conserva `id TEXT PRIMARY KEY` intacto como identidad documental para total compatibilidad con `expense_payments`.
 *    - Conserva `business_id TEXT NOT NULL` para compatibilidad legacy e interoperabilidad (dual-write).
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_purchase_inv_company` (company_id)
 *        `idx_purchase_inv_company_period` (company_id, fiscal_period)
 *        `idx_purchase_inv_company_date` (company_id, invoice_date)
 *        `idx_purchase_inv_biz_period` (business_id, fiscal_period)
 *        `idx_purchase_inv_biz_date` (business_id, invoice_date)
 * 2. Backfill determinista de `purchase_invoices`:
 *    - Resuelve `purchase_invoices.business_id -> companies.phone -> companies.id`.
 *    - BARRERA CRÍTICA: La resolución de tenant NUNCA utiliza datos del proveedor (supplier_tax_id / supplier_name).
 *    - Si no existe empresa asociada o es ambigua: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Valida que el recuento final de filas coincida exactamente con el recuento original.
 * 3. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 9,
  name: '009_purchase_invoices_company_id',
  up: (db) => {
    // 1. Comprobar si la tabla ya existe
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_invoices'").get();

    if (!tableExists) {
      // Base de datos nueva: crear directamente con el esquema canónico
      db.exec(`
        CREATE TABLE IF NOT EXISTS purchase_invoices (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          business_id TEXT NOT NULL,
          supplier_name TEXT NOT NULL,
          supplier_tax_id TEXT,
          invoice_number TEXT,
          invoice_date TEXT NOT NULL,
          operation_date TEXT,
          description TEXT,
          taxable_base REAL NOT NULL,
          vat_rate REAL NOT NULL,
          vat_amount REAL NOT NULL,
          total_amount REAL NOT NULL,
          deductible_vat_amount REAL NOT NULL,
          deductibility_status TEXT DEFAULT 'LIKELY_DEDUCTIBLE',
          income_tax_relevance TEXT DEFAULT 'DEDUCTIBLE',
          expense_category TEXT DEFAULT 'MATERIALES',
          payment_status TEXT DEFAULT 'PAGADA',
          payment_method TEXT,
          payment_date TEXT,
          document_path TEXT,
          is_investment_asset INTEGER DEFAULT 0,
          fiscal_period TEXT NOT NULL,
          notes TEXT,
          data_json TEXT,
          created_at TEXT,
          updated_at TEXT,
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_company ON purchase_invoices(company_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_company_period ON purchase_invoices(company_id, fiscal_period);
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_company_date ON purchase_invoices(company_id, invoice_date);
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_biz_period ON purchase_invoices(business_id, fiscal_period);
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_biz_date ON purchase_invoices(business_id, invoice_date);
      `);
      return;
    }

    const cols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
    const companyIdCol = cols.find(c => c.name === 'company_id');
    if (companyIdCol) {
      // Ya migrada
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_company ON purchase_invoices(company_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_company_period ON purchase_invoices(company_id, fiscal_period);
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_company_date ON purchase_invoices(company_id, invoice_date);
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_biz_period ON purchase_invoices(business_id, fiscal_period);
        CREATE INDEX IF NOT EXISTS idx_purchase_inv_biz_date ON purchase_invoices(business_id, invoice_date);
      `);
      return;
    }

    // 2. Obtener todas las filas existentes
    const rows = db.prepare('SELECT * FROM purchase_invoices').all();

    // 3. Crear tabla temporal purchase_invoices_new
    db.exec(`
      CREATE TABLE purchase_invoices_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        supplier_tax_id TEXT,
        invoice_number TEXT,
        invoice_date TEXT NOT NULL,
        operation_date TEXT,
        description TEXT,
        taxable_base REAL NOT NULL,
        vat_rate REAL NOT NULL,
        vat_amount REAL NOT NULL,
        total_amount REAL NOT NULL,
        deductible_vat_amount REAL NOT NULL,
        deductibility_status TEXT DEFAULT 'LIKELY_DEDUCTIBLE',
        income_tax_relevance TEXT DEFAULT 'DEDUCTIBLE',
        expense_category TEXT DEFAULT 'MATERIALES',
        payment_status TEXT DEFAULT 'PAGADA',
        payment_method TEXT,
        payment_date TEXT,
        document_path TEXT,
        is_investment_asset INTEGER DEFAULT 0,
        fiscal_period TEXT NOT NULL,
        notes TEXT,
        data_json TEXT,
        created_at TEXT,
        updated_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);

    // Helper para buscar empresa por teléfono exacto o normalizado (el tenant de PresuVoz, NO el proveedor)
    const findCompaniesByPhone = (rawPhone) => {
      if (!rawPhone) return [];
      const clean = String(rawPhone).replace(/\D/g, '');
      return db.prepare(`
        SELECT id, phone FROM companies 
        WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
      `).all(rawPhone, clean);
    };

    const insertStmt = db.prepare(`
      INSERT INTO purchase_invoices_new (
        id, company_id, business_id, supplier_name, supplier_tax_id,
        invoice_number, invoice_date, operation_date, description,
        taxable_base, vat_rate, vat_amount, total_amount, deductible_vat_amount,
        deductibility_status, income_tax_relevance, expense_category,
        payment_status, payment_method, payment_date, document_path,
        is_investment_asset, fiscal_period, notes, data_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      let resolvedCompanyId = null;

      if (row.company_id && typeof row.company_id === 'string' && row.company_id.includes('-')) {
        const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(row.company_id);
        if (!comp) {
          throw new Error(`❌ [Migración 009] Fallo de integridad: company_id '${row.company_id}' no existe en companies.`);
        }
        resolvedCompanyId = comp.id;
      } else {
        if (!row.business_id) {
          throw new Error(`❌ [Migración 009] Fallo de integridad: Factura recibida '${row.id}' sin business_id.`);
        }
        const matches = findCompaniesByPhone(row.business_id);
        if (matches.length === 0) {
          throw new Error(
            `❌ [Migración 009] Fallo crítico de integridad: Factura recibida '${row.id}' con business_id '${row.business_id}' huérfana. No existe empresa asociada en companies (fail-closed).`
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `❌ [Migración 009] Ambigüedad crítica: Múltiples empresas coinciden con el business_id '${row.business_id}' para factura recibida '${row.id}'.`
          );
        }
        resolvedCompanyId = matches[0].id;
      }

      // Normalizar business_id a dígitos para mantener consistencia
      const cleanBusinessId = String(row.business_id).replace(/\D/g, '') || String(row.business_id);

      insertStmt.run(
        row.id,
        resolvedCompanyId,
        cleanBusinessId,
        row.supplier_name,
        row.supplier_tax_id || null,
        row.invoice_number || null,
        row.invoice_date,
        row.operation_date || null,
        row.description || null,
        Number(row.taxable_base || 0),
        Number(row.vat_rate || 0),
        Number(row.vat_amount || 0),
        Number(row.total_amount || 0),
        Number(row.deductible_vat_amount || 0),
        row.deductibility_status || 'LIKELY_DEDUCTIBLE',
        row.income_tax_relevance || 'DEDUCTIBLE',
        row.expense_category || 'MATERIALES',
        row.payment_status || 'PAGADA',
        row.payment_method || null,
        row.payment_date || null,
        row.document_path || null,
        Number(row.is_investment_asset || 0),
        row.fiscal_period,
        row.notes || null,
        row.data_json || null,
        row.created_at || new Date().toISOString(),
        row.updated_at || new Date().toISOString()
      );
    }

    // 4. Reemplazo atómico de tabla
    db.exec('DROP TABLE purchase_invoices;');
    db.exec('ALTER TABLE purchase_invoices_new RENAME TO purchase_invoices;');

    // 5. Crear índices
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_company ON purchase_invoices(company_id);
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_company_period ON purchase_invoices(company_id, fiscal_period);
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_company_date ON purchase_invoices(company_id, invoice_date);
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_biz_period ON purchase_invoices(business_id, fiscal_period);
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_biz_date ON purchase_invoices(business_id, invoice_date);
    `);

    // 6. Verificar conteos
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM purchase_invoices').get().cnt;
    if (newCount !== rows.length) {
      throw new Error(
        `❌ [Migración 009] Discrepancia en recuento de filas tras migración: antes=${rows.length}, después=${newCount}`
      );
    }
  }
};
