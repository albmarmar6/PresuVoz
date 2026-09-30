/**
 * PresuVoz — Migración 012: Fiscal Incidents Company ID
 * 
 * Versión: 12
 * Fecha: 2026-09-30
 * 
 * Contrato:
 * 1. Establece la identidad canónica multi-tenant para `fiscal_incidents`:
 *    - Añade columna `company_id TEXT NOT NULL` con FOREIGN KEY a `companies(id) ON DELETE RESTRICT`.
 *      (ON DELETE RESTRICT previene la eliminación accidental de incidentes de auditoría si una empresa es borrada).
 *    - Conserva `id TEXT PRIMARY KEY` intacto.
 *    - Conserva `business_id TEXT NOT NULL` para compatibilidad legacy e interoperabilidad (dual-write).
 *    - Conserva `fiscal_period TEXT NOT NULL`, `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`,
 *      `severity TEXT NOT NULL`, `error_code TEXT NOT NULL`, `message TEXT NOT NULL`,
 *      `resolution_status TEXT DEFAULT 'OPEN'`, `created_at TEXT`.
 *    - Conserva la lógica de detección de calidad fiscal íntegra (no altera reglas fiscales).
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_fiscal_incidents_company` (company_id)
 *        `idx_fiscal_incidents_company_period` (company_id, fiscal_period)
 *        `idx_fiscal_incidents_company_status` (company_id, resolution_status)
 *        `idx_fiscal_incidents_biz_period` (business_id, fiscal_period)
 *        `idx_fiscal_incidents_entity` (entity_type, entity_id)
 * 2. Backfill determinista de `fiscal_incidents`:
 *    - Resuelve `fiscal_incidents.business_id -> companies.phone -> companies.id`.
 *    - Si no existe empresa asociada o es ambigua: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Validación relacional: Si la entidad referenciada (factura emitida o factura recibida) existe,
 *      verifica que su company_id coincida (prevención cross-tenant).
 *    - Valida que el recuento final de filas coincida exactamente con el recuento original.
 * 3. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 12,
  name: '012_fiscal_incidents_company_id',
  up: (db) => {
    // 1. Comprobar si la tabla ya existe
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fiscal_incidents'").get();

    if (!tableExists) {
      // Base de datos nueva: crear directamente con el esquema canónico
      db.exec(`
        CREATE TABLE IF NOT EXISTS fiscal_incidents (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          business_id TEXT NOT NULL,
          fiscal_period TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          error_code TEXT NOT NULL,
          message TEXT NOT NULL,
          resolution_status TEXT DEFAULT 'OPEN',
          created_at TEXT,
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company ON fiscal_incidents(company_id);
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company_period ON fiscal_incidents(company_id, fiscal_period);
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company_status ON fiscal_incidents(company_id, resolution_status);
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_biz_period ON fiscal_incidents(business_id, fiscal_period);
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_entity ON fiscal_incidents(entity_type, entity_id);
      `);
      return;
    }

    const cols = db.prepare('PRAGMA table_info("fiscal_incidents")').all();
    const companyIdCol = cols.find(c => c.name === 'company_id');
    if (companyIdCol) {
      // Ya migrada
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company ON fiscal_incidents(company_id);
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company_period ON fiscal_incidents(company_id, fiscal_period);
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company_status ON fiscal_incidents(company_id, resolution_status);
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_biz_period ON fiscal_incidents(business_id, fiscal_period);
        CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_entity ON fiscal_incidents(entity_type, entity_id);
      `);
      return;
    }

    // 2. Obtener todas las filas existentes
    const rows = db.prepare('SELECT * FROM fiscal_incidents').all();

    // 3. Crear tabla temporal fiscal_incidents_new
    db.exec(`
      CREATE TABLE fiscal_incidents_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        fiscal_period TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        error_code TEXT NOT NULL,
        message TEXT NOT NULL,
        resolution_status TEXT DEFAULT 'OPEN',
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

    // Helper para verificar existencia e identidad de facturas asociadas
    const invoicesTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoices'").get();
    let getIssuedInvoiceStmt = null;
    if (invoicesTableExists) {
      const invCols = db.prepare('PRAGMA table_info("invoices")').all();
      if (invCols.some(c => c.name === 'company_id')) {
        getIssuedInvoiceStmt = db.prepare('SELECT id, company_id FROM invoices WHERE id = ?');
      }
    }

    const pinvTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_invoices'").get();
    let getPurchaseInvoiceStmt = null;
    if (pinvTableExists) {
      const pinvCols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
      if (pinvCols.some(c => c.name === 'company_id')) {
        getPurchaseInvoiceStmt = db.prepare('SELECT id, company_id FROM purchase_invoices WHERE id = ?');
      }
    }

    const insertStmt = db.prepare(`
      INSERT INTO fiscal_incidents_new (
        id, company_id, business_id, fiscal_period, entity_type, entity_id,
        severity, error_code, message, resolution_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      let resolvedCompanyId = null;

      if (row.company_id && typeof row.company_id === 'string' && row.company_id.includes('-')) {
        const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(row.company_id);
        if (!comp) {
          throw new Error(`❌ [Migración 012] Fallo de integridad: company_id '${row.company_id}' no existe en companies.`);
        }
        resolvedCompanyId = comp.id;
      } else {
        if (!row.business_id) {
          throw new Error(`❌ [Migración 012] Fallo de integridad: Incidencia fiscal '${row.id}' sin business_id.`);
        }
        const matches = findCompaniesByPhone(row.business_id);
        if (matches.length === 0) {
          throw new Error(
            `❌ [Migración 012] Fallo crítico de integridad: Incidencia fiscal '${row.id}' con business_id '${row.business_id}' huérfano. No existe empresa asociada en companies (fail-closed).`
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `❌ [Migración 012] Ambigüedad crítica: Múltiples empresas coinciden con el business_id '${row.business_id}' para incidencia fiscal '${row.id}'.`
          );
        }
        resolvedCompanyId = matches[0].id;
      }

      // Validación relacional: Si la factura asociada existe, asegurar coincidencia de tenant
      if (row.entity_type === 'INVOICE' && getIssuedInvoiceStmt && row.entity_id) {
        const invRow = getIssuedInvoiceStmt.get(row.entity_id);
        if (invRow && invRow.company_id && invRow.company_id !== resolvedCompanyId) {
          throw new Error(
            `❌ [Migración 012] Fallo crítico de aislamiento: Incidencia fiscal '${row.id}' pertenece a empresa '${resolvedCompanyId}' pero su factura emitida asociada '${row.entity_id}' pertenece a empresa '${invRow.company_id}'. Inconsistencia cross-tenant detectada.`
          );
        }
      }

      if (row.entity_type === 'PURCHASE_INVOICE' && getPurchaseInvoiceStmt && row.entity_id) {
        const pinvRow = getPurchaseInvoiceStmt.get(row.entity_id);
        if (pinvRow && pinvRow.company_id && pinvRow.company_id !== resolvedCompanyId) {
          throw new Error(
            `❌ [Migración 012] Fallo crítico de aislamiento: Incidencia fiscal '${row.id}' pertenece a empresa '${resolvedCompanyId}' pero su factura recibida asociada '${row.entity_id}' pertenece a empresa '${pinvRow.company_id}'. Inconsistencia cross-tenant detectada.`
          );
        }
      }

      // Normalizar business_id a dígitos para mantener consistencia
      const cleanBusinessId = String(row.business_id).replace(/\D/g, '') || String(row.business_id);

      insertStmt.run(
        row.id,
        resolvedCompanyId,
        cleanBusinessId,
        row.fiscal_period || 'GENERAL',
        row.entity_type || 'INVOICE',
        row.entity_id || '',
        row.severity || 'WARNING',
        row.error_code || 'UNKNOWN_ERROR',
        row.message || 'Incidencia fiscal detectada',
        row.resolution_status || 'OPEN',
        row.created_at || new Date().toISOString()
      );
    }

    // 4. Reemplazo atómico de tabla
    db.exec('DROP TABLE fiscal_incidents;');
    db.exec('ALTER TABLE fiscal_incidents_new RENAME TO fiscal_incidents;');

    // 5. Crear índices
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company ON fiscal_incidents(company_id);
      CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company_period ON fiscal_incidents(company_id, fiscal_period);
      CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company_status ON fiscal_incidents(company_id, resolution_status);
      CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_biz_period ON fiscal_incidents(business_id, fiscal_period);
      CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_entity ON fiscal_incidents(entity_type, entity_id);
    `);

    // 6. Verificar conteos
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM fiscal_incidents').get().cnt;
    if (newCount !== rows.length) {
      throw new Error(
        `❌ [Migración 012] Discrepancia en recuento de filas tras migración: antes=${rows.length}, después=${newCount}`
      );
    }
  }
};
