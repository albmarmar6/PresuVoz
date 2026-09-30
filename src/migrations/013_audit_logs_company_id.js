/**
 * PresuVoz — Migración 013: Audit Logs Company ID
 * 
 * Versión: 13
 * Fecha: 2026-09-30
 * 
 * Contrato:
 * 1. Establece la identidad canónica multi-tenant para `audit_logs`:
 *    - Añade columna `company_id TEXT NOT NULL` con FOREIGN KEY a `companies(id) ON DELETE RESTRICT`.
 *      (ON DELETE RESTRICT previene la eliminación accidental de registros de auditoría si una empresa es borrada).
 *    - Conserva `id TEXT PRIMARY KEY` intacto.
 *    - Conserva `business_id TEXT NOT NULL` para compatibilidad legacy e interoperabilidad (dual-write).
 *    - Conserva `entity_type TEXT NOT NULL`, `entity_id TEXT NOT NULL`, `action TEXT NOT NULL`,
 *      `field_changed TEXT`, `old_value TEXT`, `new_value TEXT`, `changed_by TEXT`,
 *      `reason TEXT`, `timestamp TEXT NOT NULL`.
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_audit_logs_company` (company_id)
 *        `idx_audit_logs_company_time` (company_id, timestamp)
 *        `idx_audit_logs_company_entity` (company_id, entity_type, entity_id)
 *        `idx_audit_logs_biz_time` (business_id, timestamp)
 *        `idx_audit_logs_entity` (entity_type, entity_id)
 * 2. Backfill determinista de `audit_logs`:
 *    - Resuelve `audit_logs.business_id -> companies.phone -> companies.id` o por UUID directo.
 *    - Si no existe empresa asociada o es ambigua: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Validación relacional: Si la entidad referenciada (factura emitida, factura recibida o cita) existe,
 *      verifica que su company_id coincida (prevención cross-tenant).
 *    - Valida que el recuento final de filas coincida exactamente con el recuento original.
 * 3. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 13,
  name: '013_audit_logs_company_id',
  up: (db) => {
    // 1. Comprobar si la tabla ya existe
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_logs'").get();

    if (!tableExists) {
      // Base de datos nueva: crear directamente con el esquema canónico
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          business_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          field_changed TEXT,
          old_value TEXT,
          new_value TEXT,
          changed_by TEXT DEFAULT 'USER_WHATSAPP',
          reason TEXT,
          timestamp TEXT NOT NULL,
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_company_time ON audit_logs(company_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_company_entity ON audit_logs(company_id, entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_biz_time ON audit_logs(business_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
      `);
      return;
    }

    const cols = db.prepare('PRAGMA table_info("audit_logs")').all();
    const companyIdCol = cols.find(c => c.name === 'company_id');
    if (companyIdCol) {
      // Ya migrada
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_company_time ON audit_logs(company_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_company_entity ON audit_logs(company_id, entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_biz_time ON audit_logs(business_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
      `);
      return;
    }

    // 2. Obtener todas las filas existentes
    const rows = db.prepare('SELECT * FROM audit_logs').all();

    // 3. Crear tabla temporal audit_logs_new
    db.exec(`
      CREATE TABLE audit_logs_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        field_changed TEXT,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT DEFAULT 'USER_WHATSAPP',
        reason TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);

    // Helper para buscar empresa por UUID directo o teléfono exacto / normalizado
    const findCompaniesByTarget = (rawTarget) => {
      if (!rawTarget) return [];
      const trimmed = String(rawTarget).trim();
      if (trimmed.length === 36 && trimmed.includes('-')) {
        const byId = db.prepare('SELECT id, phone FROM companies WHERE id = ?').all(trimmed);
        if (byId.length > 0) return byId;
      }
      const clean = trimmed.replace(/\D/g, '');
      return db.prepare(`
        SELECT id, phone FROM companies 
        WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
      `).all(trimmed, clean);
    };

    // Helper para verificar existencia e identidad de entidades asociadas
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

    const aptTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='appointments'").get();
    let getAptStmt = null;
    if (aptTableExists) {
      const aptCols = db.prepare('PRAGMA table_info("appointments")').all();
      if (aptCols.some(c => c.name === 'company_id')) {
        getAptStmt = db.prepare('SELECT id, company_id FROM appointments WHERE id = ?');
      }
    }

    const insertStmt = db.prepare(`
      INSERT INTO audit_logs_new (
        id, company_id, business_id, entity_type, entity_id,
        action, field_changed, old_value, new_value, changed_by, reason, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      let resolvedCompanyId = null;

      if (row.company_id && typeof row.company_id === 'string' && row.company_id.includes('-')) {
        const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(row.company_id);
        if (!comp) {
          throw new Error(`❌ [Migración 013] Fallo de integridad: company_id '${row.company_id}' no existe en companies.`);
        }
        resolvedCompanyId = comp.id;
      } else {
        if (!row.business_id) {
          throw new Error(`❌ [Migración 013] Fallo de integridad: Registro de auditoría '${row.id}' sin business_id.`);
        }
        const matches = findCompaniesByTarget(row.business_id);
        if (matches.length === 0) {
          throw new Error(
            `❌ [Migración 013] Fallo crítico de integridad: Registro de auditoría '${row.id}' con business_id '${row.business_id}' huérfano. No existe empresa asociada en companies (fail-closed).`
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `❌ [Migración 013] Ambigüedad crítica: Múltiples empresas coinciden con el business_id '${row.business_id}' para registro de auditoría '${row.id}'.`
          );
        }
        resolvedCompanyId = matches[0].id;
      }

      // Validación relacional: Si la entidad asociada existe, asegurar coincidencia de tenant
      if (row.entity_type === 'INVOICE' && getIssuedInvoiceStmt && row.entity_id) {
        const invRow = getIssuedInvoiceStmt.get(row.entity_id);
        if (invRow && invRow.company_id && invRow.company_id !== resolvedCompanyId) {
          throw new Error(
            `❌ [Migración 013] Fallo crítico de aislamiento: Registro de auditoría '${row.id}' pertenece a empresa '${resolvedCompanyId}' pero su factura emitida asociada '${row.entity_id}' pertenece a empresa '${invRow.company_id}'. Inconsistencia cross-tenant detectada.`
          );
        }
      }

      if (row.entity_type === 'PURCHASE_INVOICE' && getPurchaseInvoiceStmt && row.entity_id) {
        const pinvRow = getPurchaseInvoiceStmt.get(row.entity_id);
        if (pinvRow && pinvRow.company_id && pinvRow.company_id !== resolvedCompanyId) {
          throw new Error(
            `❌ [Migración 013] Fallo crítico de aislamiento: Registro de auditoría '${row.id}' pertenece a empresa '${resolvedCompanyId}' pero su factura recibida asociada '${row.entity_id}' pertenece a empresa '${pinvRow.company_id}'. Inconsistencia cross-tenant detectada.`
          );
        }
      }

      if (row.entity_type === 'APPOINTMENT' && getAptStmt && row.entity_id) {
        const aptRow = getAptStmt.get(row.entity_id);
        if (aptRow && aptRow.company_id && aptRow.company_id !== resolvedCompanyId) {
          throw new Error(
            `❌ [Migración 013] Fallo crítico de aislamiento: Registro de auditoría '${row.id}' pertenece a empresa '${resolvedCompanyId}' pero su cita asociada '${row.entity_id}' pertenece a empresa '${aptRow.company_id}'. Inconsistencia cross-tenant detectada.`
          );
        }
      }

      // Normalizar business_id para mantener consistencia
      const cleanBusinessId = String(row.business_id).includes('-') 
        ? String(row.business_id) 
        : (String(row.business_id).replace(/\D/g, '') || String(row.business_id));

      insertStmt.run(
        row.id,
        resolvedCompanyId,
        cleanBusinessId,
        row.entity_type || 'FISCAL_RECORD',
        row.entity_id || '',
        row.action || 'UPDATE',
        row.field_changed || null,
        row.old_value || null,
        row.new_value || null,
        row.changed_by || 'USER_WHATSAPP',
        row.reason || null,
        row.timestamp || new Date().toISOString()
      );
    }

    // 4. Reemplazo atómico de tabla
    db.exec('DROP TABLE audit_logs;');
    db.exec('ALTER TABLE audit_logs_new RENAME TO audit_logs;');

    // 5. Crear índices
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_company_time ON audit_logs(company_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_company_entity ON audit_logs(company_id, entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_biz_time ON audit_logs(business_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
    `);

    // 6. Verificar conteos
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get().cnt;
    if (newCount !== rows.length) {
      throw new Error(
        `❌ [Migración 013] Discrepancia en recuento de filas tras migración: antes=${rows.length}, después=${newCount}`
      );
    }
  }
};
