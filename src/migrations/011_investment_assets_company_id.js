/**
 * PresuVoz — Migración 011: Investment Assets Company ID
 * 
 * Versión: 11
 * Fecha: 2026-09-30
 * 
 * Contrato:
 * 1. Establece la identidad canónica multi-tenant para `investment_assets`:
 *    - Añade columna `company_id TEXT NOT NULL` con FOREIGN KEY a `companies(id) ON DELETE RESTRICT`.
 *      (ON DELETE RESTRICT previene la eliminación accidental del registro de activos si una empresa es borrada).
 *    - Conserva `id TEXT PRIMARY KEY` intacto.
 *    - Conserva `purchase_invoice_id TEXT` (nullable) intacto para vinculación documental con facturas recibidas.
 *    - Conserva `business_id TEXT NOT NULL` para compatibilidad legacy e interoperabilidad (dual-write).
 *    - Conserva la lógica e importes fiscales actuales íntegros (no altera reglas fiscales ni de amortización).
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_investment_assets_company` (company_id)
 *        `idx_investment_assets_company_date` (company_id, purchase_date)
 *        `idx_investment_assets_invoice` (purchase_invoice_id)
 *        `idx_investment_assets_biz_date` (business_id, purchase_date)
 * 2. Backfill determinista de `investment_assets`:
 *    - Resuelve `investment_assets.business_id -> companies.phone -> companies.id`.
 *    - Si no existe empresa asociada o es ambigua: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Validación relacional: Si la factura de compra asociada existe, verifica que su company_id coincida (prevención cross-tenant).
 *    - Valida que el recuento final de filas coincida exactamente con el recuento original.
 * 3. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 11,
  name: '011_investment_assets_company_id',
  up: (db) => {
    // 1. Comprobar si la tabla ya existe
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investment_assets'").get();

    if (!tableExists) {
      // Base de datos nueva: crear directamente con el esquema canónico
      db.exec(`
        CREATE TABLE IF NOT EXISTS investment_assets (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          business_id TEXT NOT NULL,
          purchase_invoice_id TEXT,
          description TEXT NOT NULL,
          purchase_date TEXT NOT NULL,
          supplier_name TEXT,
          purchase_base REAL NOT NULL,
          vat_amount REAL NOT NULL,
          total_amount REAL NOT NULL,
          business_use_percentage REAL DEFAULT 100,
          depreciation_method TEXT DEFAULT 'TABLAS_OFICIALES',
          depreciation_status TEXT DEFAULT 'NEEDS_GESTOR_REVIEW',
          notes TEXT,
          created_at TEXT,
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_investment_assets_company ON investment_assets(company_id);
        CREATE INDEX IF NOT EXISTS idx_investment_assets_company_date ON investment_assets(company_id, purchase_date);
        CREATE INDEX IF NOT EXISTS idx_investment_assets_invoice ON investment_assets(purchase_invoice_id);
        CREATE INDEX IF NOT EXISTS idx_investment_assets_biz_date ON investment_assets(business_id, purchase_date);
      `);
      return;
    }

    const cols = db.prepare('PRAGMA table_info("investment_assets")').all();
    const companyIdCol = cols.find(c => c.name === 'company_id');
    if (companyIdCol) {
      // Ya migrada
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_investment_assets_company ON investment_assets(company_id);
        CREATE INDEX IF NOT EXISTS idx_investment_assets_company_date ON investment_assets(company_id, purchase_date);
        CREATE INDEX IF NOT EXISTS idx_investment_assets_invoice ON investment_assets(purchase_invoice_id);
        CREATE INDEX IF NOT EXISTS idx_investment_assets_biz_date ON investment_assets(business_id, purchase_date);
      `);
      return;
    }

    // 2. Obtener todas las filas existentes
    const rows = db.prepare('SELECT * FROM investment_assets').all();

    // 3. Crear tabla temporal investment_assets_new
    db.exec(`
      CREATE TABLE investment_assets_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        purchase_invoice_id TEXT,
        description TEXT NOT NULL,
        purchase_date TEXT NOT NULL,
        supplier_name TEXT,
        purchase_base REAL NOT NULL,
        vat_amount REAL NOT NULL,
        total_amount REAL NOT NULL,
        business_use_percentage REAL DEFAULT 100,
        depreciation_method TEXT DEFAULT 'TABLAS_OFICIALES',
        depreciation_status TEXT DEFAULT 'NEEDS_GESTOR_REVIEW',
        notes TEXT,
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

    // Helper para verificar existencia e identidad de la factura recibida asociada (si existe la tabla)
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
      INSERT INTO investment_assets_new (
        id, company_id, business_id, purchase_invoice_id, description,
        purchase_date, supplier_name, purchase_base, vat_amount, total_amount,
        business_use_percentage, depreciation_method, depreciation_status, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      let resolvedCompanyId = null;

      if (row.company_id && typeof row.company_id === 'string' && row.company_id.includes('-')) {
        const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(row.company_id);
        if (!comp) {
          throw new Error(`❌ [Migración 011] Fallo de integridad: company_id '${row.company_id}' no existe en companies.`);
        }
        resolvedCompanyId = comp.id;
      } else {
        if (!row.business_id) {
          throw new Error(`❌ [Migración 011] Fallo de integridad: Bien de inversión '${row.id}' sin business_id.`);
        }
        const matches = findCompaniesByPhone(row.business_id);
        if (matches.length === 0) {
          throw new Error(
            `❌ [Migración 011] Fallo crítico de integridad: Bien de inversión '${row.id}' con business_id '${row.business_id}' huérfano. No existe empresa asociada en companies (fail-closed).`
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `❌ [Migración 011] Ambigüedad crítica: Múltiples empresas coinciden con el business_id '${row.business_id}' para bien de inversión '${row.id}'.`
          );
        }
        resolvedCompanyId = matches[0].id;
      }

      // Validación relacional: Si la factura recibida existe, asegurar coincidencia de tenant
      if (getInvoiceStmt && row.purchase_invoice_id) {
        const invRow = getInvoiceStmt.get(row.purchase_invoice_id);
        if (invRow && invRow.company_id && invRow.company_id !== resolvedCompanyId) {
          throw new Error(
            `❌ [Migración 011] Fallo crítico de aislamiento: Bien de inversión '${row.id}' pertenece a empresa '${resolvedCompanyId}' pero su factura asociada '${row.purchase_invoice_id}' pertenece a empresa '${invRow.company_id}'. Inconsistencia cross-tenant detectada.`
          );
        }
      }

      // Normalizar business_id a dígitos para mantener consistencia
      const cleanBusinessId = String(row.business_id).replace(/\D/g, '') || String(row.business_id);

      insertStmt.run(
        row.id,
        resolvedCompanyId,
        cleanBusinessId,
        row.purchase_invoice_id || null,
        row.description,
        row.purchase_date,
        row.supplier_name || null,
        Number(row.purchase_base || 0),
        Number(row.vat_amount || 0),
        Number(row.total_amount || 0),
        row.business_use_percentage != null ? Number(row.business_use_percentage) : 100,
        row.depreciation_method || 'TABLAS_OFICIALES',
        row.depreciation_status || 'NEEDS_GESTOR_REVIEW',
        row.notes || null,
        row.created_at || new Date().toISOString()
      );
    }

    // 4. Reemplazo atómico de tabla
    db.exec('DROP TABLE investment_assets;');
    db.exec('ALTER TABLE investment_assets_new RENAME TO investment_assets;');

    // 5. Crear índices
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_investment_assets_company ON investment_assets(company_id);
      CREATE INDEX IF NOT EXISTS idx_investment_assets_company_date ON investment_assets(company_id, purchase_date);
      CREATE INDEX IF NOT EXISTS idx_investment_assets_invoice ON investment_assets(purchase_invoice_id);
      CREATE INDEX IF NOT EXISTS idx_investment_assets_biz_date ON investment_assets(business_id, purchase_date);
    `);

    // 6. Verificar conteos
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM investment_assets').get().cnt;
    if (newCount !== rows.length) {
      throw new Error(
        `❌ [Migración 011] Discrepancia en recuento de filas tras migración: antes=${rows.length}, después=${newCount}`
      );
    }
  }
};
