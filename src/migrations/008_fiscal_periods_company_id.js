/**
 * PresuVoz — Migración 008: Fiscal Periods Company ID
 * 
 * Versión: 8
 * Fecha: 2026-09-29
 * 
 * Contrato:
 * 1. Establece la identidad canónica multi-tenant para `fiscal_periods`:
 *    - Reconstruye la tabla con clave primaria compuesta: `PRIMARY KEY (company_id, fiscal_year, quarter)`.
 *    - Añade columna `company_id TEXT NOT NULL` con FOREIGN KEY a `companies(id) ON DELETE RESTRICT`.
 *      (ON DELETE RESTRICT previene la eliminación accidental del historial fiscal si una empresa es borrada).
 *    - Conserva `business_id TEXT NOT NULL` para compatibilidad legacy e interoperabilidad.
 *    - Conserva `id TEXT NOT NULL` con índice UNIQUE (`idx_fiscal_periods_id`).
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_fiscal_periods_id` (UNIQUE)
 *        `idx_fiscal_periods_company` (company_id)
 *        `idx_fiscal_periods_biz_year_q` (business_id, fiscal_year, quarter)
 *        `idx_fiscal_periods_company_status` (company_id, status)
 * 2. Backfill determinista de `fiscal_periods`:
 *    - Resuelve `fiscal_periods.business_id -> companies.phone -> companies.id`.
 *    - Si no existe empresa asociada o es ambigua: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Si hay colisión de tenant en un mismo año y trimestre: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Valida que el recuento final de filas coincida exactamente con el recuento original.
 * 3. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 8,
  name: '008_fiscal_periods_company_id',
  up: (db) => {
    // 1. Comprobar si la tabla ya existe y ya tiene company_id como parte de la PK
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fiscal_periods'").get();

    if (!tableExists) {
      // Base de datos nueva: crear directamente con el esquema canónico
      db.exec(`
        CREATE TABLE IF NOT EXISTS fiscal_periods (
          id TEXT NOT NULL,
          company_id TEXT NOT NULL,
          business_id TEXT NOT NULL,
          fiscal_year INTEGER NOT NULL,
          quarter INTEGER NOT NULL,
          status TEXT DEFAULT 'OPEN',
          last_quality_check_at TEXT,
          critical_incidents_count INTEGER DEFAULT 0,
          warnings_count INTEGER DEFAULT 0,
          package_path TEXT,
          sent_at TEXT,
          sent_to_email TEXT,
          created_at TEXT,
          updated_at TEXT,
          PRIMARY KEY (company_id, fiscal_year, quarter),
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_periods_id ON fiscal_periods(id);
        CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company ON fiscal_periods(company_id);
        CREATE INDEX IF NOT EXISTS idx_fiscal_periods_biz_year_q ON fiscal_periods(business_id, fiscal_year, quarter);
        CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company_status ON fiscal_periods(company_id, status);
      `);
      return;
    }

    const cols = db.prepare('PRAGMA table_info("fiscal_periods")').all();
    const companyIdCol = cols.find(c => c.name === 'company_id');
    if (companyIdCol && companyIdCol.pk > 0) {
      // Ya migrada
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_periods_id ON fiscal_periods(id);
        CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company ON fiscal_periods(company_id);
        CREATE INDEX IF NOT EXISTS idx_fiscal_periods_biz_year_q ON fiscal_periods(business_id, fiscal_year, quarter);
        CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company_status ON fiscal_periods(company_id, status);
      `);
      return;
    }

    // 2. Obtener todas las filas existentes
    const rows = db.prepare('SELECT * FROM fiscal_periods').all();

    // 3. Crear tabla temporal fiscal_periods_new
    db.exec(`
      CREATE TABLE fiscal_periods_new (
        id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        fiscal_year INTEGER NOT NULL,
        quarter INTEGER NOT NULL,
        status TEXT DEFAULT 'OPEN',
        last_quality_check_at TEXT,
        critical_incidents_count INTEGER DEFAULT 0,
        warnings_count INTEGER DEFAULT 0,
        package_path TEXT,
        sent_at TEXT,
        sent_to_email TEXT,
        created_at TEXT,
        updated_at TEXT,
        PRIMARY KEY (company_id, fiscal_year, quarter),
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

    const insertStmt = db.prepare(`
      INSERT INTO fiscal_periods_new (
        id, company_id, business_id, fiscal_year, quarter, status,
        last_quality_check_at, critical_incidents_count, warnings_count,
        package_path, sent_at, sent_to_email, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seenPeriods = new Set();

    for (const row of rows) {
      let resolvedCompanyId = null;

      if (row.company_id && typeof row.company_id === 'string' && row.company_id.includes('-')) {
        const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(row.company_id);
        if (!comp) {
          throw new Error(`❌ [Migración 008] Fallo de integridad: company_id '${row.company_id}' no existe en companies.`);
        }
        resolvedCompanyId = comp.id;
      } else {
        if (!row.business_id) {
          throw new Error(`❌ [Migración 008] Fallo de integridad: Periodo fiscal '${row.id}' sin business_id.`);
        }
        const matches = findCompaniesByPhone(row.business_id);
        if (matches.length === 0) {
          throw new Error(
            `❌ [Migración 008] Fallo crítico de integridad: Periodo fiscal '${row.id}' con business_id '${row.business_id}' huérfano. No existe empresa asociada en companies (fail-closed).`
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `❌ [Migración 008] Ambigüedad crítica: Múltiples empresas coinciden con el business_id '${row.business_id}' para periodo '${row.id}'.`
          );
        }
        resolvedCompanyId = matches[0].id;
      }

      // Validar unicidad de PK compuesta (company_id, fiscal_year, quarter)
      const periodKey = `${resolvedCompanyId}_${row.fiscal_year}_Q${row.quarter}`;
      if (seenPeriods.has(periodKey)) {
        throw new Error(
          `❌ [Migración 008] Colisión crítica: Múltiples registros colisionarían en la clave primaria (company_id: '${resolvedCompanyId}', year: ${row.fiscal_year}, quarter: ${row.quarter}).`
        );
      }
      seenPeriods.add(periodKey);

      // Normalizar business_id a dígitos para mantener consistencia
      const cleanBusinessId = String(row.business_id).replace(/\D/g, '') || String(row.business_id);

      // ID canónico preservando el UUID intacto
      const canonicalId = (row.id && row.id.includes(resolvedCompanyId))
        ? row.id
        : `${resolvedCompanyId}_${row.fiscal_year}_Q${row.quarter}`;

      insertStmt.run(
        canonicalId,
        resolvedCompanyId,
        cleanBusinessId,
        Number(row.fiscal_year),
        Number(row.quarter),
        row.status || 'OPEN',
        row.last_quality_check_at || null,
        Number(row.critical_incidents_count || 0),
        Number(row.warnings_count || 0),
        row.package_path || null,
        row.sent_at || null,
        row.sent_to_email || null,
        row.created_at || new Date().toISOString(),
        row.updated_at || new Date().toISOString()
      );
    }

    // 4. Reemplazo atómico de tabla
    db.exec('DROP TABLE fiscal_periods;');
    db.exec('ALTER TABLE fiscal_periods_new RENAME TO fiscal_periods;');

    // 5. Crear índices
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_periods_id ON fiscal_periods(id);
      CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company ON fiscal_periods(company_id);
      CREATE INDEX IF NOT EXISTS idx_fiscal_periods_biz_year_q ON fiscal_periods(business_id, fiscal_year, quarter);
      CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company_status ON fiscal_periods(company_id, status);
    `);

    // 6. Verificar conteos
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM fiscal_periods').get().cnt;
    if (newCount !== rows.length) {
      throw new Error(
        `❌ [Migración 008] Discrepancia en recuento de filas tras migración: antes=${rows.length}, después=${newCount}`
      );
    }
  }
};
