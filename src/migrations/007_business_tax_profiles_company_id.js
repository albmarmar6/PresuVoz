/**
 * PresuVoz — Migración 007: Business Tax Profiles Company ID
 * 
 * Versión: 7
 * Fecha: 2026-09-29
 * 
 * Contrato:
 * 1. Establece `company_id` como identificador canónico de tenant para `business_tax_profiles`:
 *    - Reconstruye la tabla preservando las 24 columnas existentes.
 *    - Define `company_id TEXT NOT NULL PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE`.
 *    - Conserva `business_id TEXT NOT NULL` con índice único para compatibilidad legacy y dual-write.
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_btp_business_id` (UNIQUE)
 *        `idx_btp_company_id`
 * 2. Backfill determinista de `business_tax_profiles`:
 *    - Resuelve `business_tax_profiles.business_id -> companies.phone -> companies.id`.
 *    - Si no existe empresa asociada o es ambigua: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Si hay colisión de tenant (múltiples perfiles al mismo company_id): ABORTA INMEDIATAMENTE.
 *    - Valida que el recuento final de filas coincida exactamente con el recuento original.
 * 3. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 7,
  name: '007_business_tax_profiles_company_id',
  up: (db) => {
    // 1. Comprobar si la tabla ya existe y ya tiene company_id como PRIMARY KEY
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='business_tax_profiles'").get();
    
    if (!tableExists) {
      // Base de datos nueva: crear directamente con el esquema canónico
      db.exec(`
        CREATE TABLE IF NOT EXISTS business_tax_profiles (
          company_id TEXT NOT NULL PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
          business_id TEXT NOT NULL,
          legal_name TEXT,
          tax_id TEXT,
          legal_form TEXT DEFAULT 'AUTONOMO',
          economic_activity TEXT,
          iae_code TEXT,
          tax_regime TEXT DEFAULT 'GENERAL',
          vat_regime TEXT DEFAULT 'GENERAL',
          income_tax_regime TEXT DEFAULT 'ESTIMACION_DIRECTA_SIMPLIFICADA',
          vat_frequency TEXT DEFAULT 'QUARTERLY',
          income_tax_frequency TEXT DEFAULT 'QUARTERLY',
          irpf_withholding_applicable INTEGER DEFAULT 0,
          default_irpf_rate REAL DEFAULT 0,
          default_vat_rate REAL DEFAULT 21,
          accounting_start_date TEXT,
          fiscal_year INTEGER DEFAULT 2026,
          current_invoice_series TEXT DEFAULT '2026-',
          verifactu_status TEXT DEFAULT 'PREPARED',
          gestor_name TEXT,
          gestor_email TEXT,
          gestor_phone TEXT,
          gestor_notes TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_btp_business_id ON business_tax_profiles(business_id);
        CREATE INDEX IF NOT EXISTS idx_btp_company_id ON business_tax_profiles(company_id);
      `);
      return;
    }

    const cols = db.prepare('PRAGMA table_info("business_tax_profiles")').all();
    const companyIdCol = cols.find(c => c.name === 'company_id');
    if (companyIdCol && companyIdCol.pk === 1) {
      // Ya migrada
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_btp_business_id ON business_tax_profiles(business_id);
        CREATE INDEX IF NOT EXISTS idx_btp_company_id ON business_tax_profiles(company_id);
      `);
      return;
    }

    // 2. Obtener todas las filas existentes
    const rows = db.prepare('SELECT * FROM business_tax_profiles').all();

    // 3. Crear tabla temporal business_tax_profiles_new
    db.exec(`
      CREATE TABLE business_tax_profiles_new (
        company_id TEXT NOT NULL PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
        business_id TEXT NOT NULL,
        legal_name TEXT,
        tax_id TEXT,
        legal_form TEXT DEFAULT 'AUTONOMO',
        economic_activity TEXT,
        iae_code TEXT,
        tax_regime TEXT DEFAULT 'GENERAL',
        vat_regime TEXT DEFAULT 'GENERAL',
        income_tax_regime TEXT DEFAULT 'ESTIMACION_DIRECTA_SIMPLIFICADA',
        vat_frequency TEXT DEFAULT 'QUARTERLY',
        income_tax_frequency TEXT DEFAULT 'QUARTERLY',
        irpf_withholding_applicable INTEGER DEFAULT 0,
        default_irpf_rate REAL DEFAULT 0,
        default_vat_rate REAL DEFAULT 21,
        accounting_start_date TEXT,
        fiscal_year INTEGER DEFAULT 2026,
        current_invoice_series TEXT DEFAULT '2026-',
        verifactu_status TEXT DEFAULT 'PREPARED',
        gestor_name TEXT,
        gestor_email TEXT,
        gestor_phone TEXT,
        gestor_notes TEXT,
        created_at TEXT,
        updated_at TEXT
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
      INSERT INTO business_tax_profiles_new (
        company_id, business_id, legal_name, tax_id, legal_form, economic_activity, iae_code,
        tax_regime, vat_regime, income_tax_regime, vat_frequency, income_tax_frequency,
        irpf_withholding_applicable, default_irpf_rate, default_vat_rate,
        accounting_start_date, fiscal_year, current_invoice_series, verifactu_status,
        gestor_name, gestor_email, gestor_phone, gestor_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seenCompanyIds = new Set();

    for (const row of rows) {
      let resolvedCompanyId = null;

      if (row.company_id && typeof row.company_id === 'string' && row.company_id.includes('-')) {
        const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(row.company_id);
        if (!comp) {
          throw new Error(`❌ [Migración 007] Fallo de integridad: company_id '${row.company_id}' no existe en companies.`);
        }
        resolvedCompanyId = comp.id;
      } else {
        if (!row.business_id) {
          throw new Error(`❌ [Migración 007] Fallo de integridad: Perfil fiscal sin business_id.`);
        }
        const matches = findCompaniesByPhone(row.business_id);
        if (matches.length === 0) {
          throw new Error(
            `❌ [Migración 007] Fallo crítico de integridad: Perfil fiscal con business_id '${row.business_id}' huérfano. No existe empresa asociada en companies (fail-closed).`
          );
        }
        if (matches.length > 1) {
          throw new Error(
            `❌ [Migración 007] Ambigüedad crítica: Múltiples empresas coinciden con el business_id '${row.business_id}'.`
          );
        }
        resolvedCompanyId = matches[0].id;
      }

      if (seenCompanyIds.has(resolvedCompanyId)) {
        throw new Error(
          `❌ [Migración 007] Colisión crítica: Múltiples perfiles fiscales corresponden al mismo company_id '${resolvedCompanyId}'.`
        );
      }
      seenCompanyIds.add(resolvedCompanyId);

      // Normalizar business_id a dígitos para mantener consistencia
      const cleanBusinessId = String(row.business_id).replace(/\D/g, '') || String(row.business_id);

      insertStmt.run(
        resolvedCompanyId,
        cleanBusinessId,
        row.legal_name !== undefined ? row.legal_name : null,
        row.tax_id !== undefined ? row.tax_id : null,
        row.legal_form !== undefined ? row.legal_form : 'AUTONOMO',
        row.economic_activity !== undefined ? row.economic_activity : null,
        row.iae_code !== undefined ? row.iae_code : null,
        row.tax_regime !== undefined ? row.tax_regime : 'GENERAL',
        row.vat_regime !== undefined ? row.vat_regime : 'GENERAL',
        row.income_tax_regime !== undefined ? row.income_tax_regime : 'ESTIMACION_DIRECTA_SIMPLIFICADA',
        row.vat_frequency !== undefined ? row.vat_frequency : 'QUARTERLY',
        row.income_tax_frequency !== undefined ? row.income_tax_frequency : 'QUARTERLY',
        row.irpf_withholding_applicable ? 1 : 0,
        Number(row.default_irpf_rate || 0),
        Number(row.default_vat_rate !== undefined && row.default_vat_rate !== null ? row.default_vat_rate : 21),
        row.accounting_start_date !== undefined ? row.accounting_start_date : null,
        Number(row.fiscal_year || 2026),
        row.current_invoice_series !== undefined ? row.current_invoice_series : '2026-',
        row.verifactu_status !== undefined ? row.verifactu_status : 'PREPARED',
        row.gestor_name !== undefined ? row.gestor_name : null,
        row.gestor_email !== undefined ? row.gestor_email : null,
        row.gestor_phone !== undefined ? row.gestor_phone : null,
        row.gestor_notes !== undefined ? row.gestor_notes : null,
        row.created_at || new Date().toISOString(),
        row.updated_at || new Date().toISOString()
      );
    }

    // 4. Reemplazo atómico de tabla
    db.exec('DROP TABLE business_tax_profiles;');
    db.exec('ALTER TABLE business_tax_profiles_new RENAME TO business_tax_profiles;');

    // 5. Crear índices
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_btp_business_id ON business_tax_profiles(business_id);
      CREATE INDEX IF NOT EXISTS idx_btp_company_id ON business_tax_profiles(company_id);
    `);

    // 6. Verificar conteos
    const newCount = db.prepare('SELECT COUNT(*) as cnt FROM business_tax_profiles').get().cnt;
    if (newCount !== rows.length) {
      throw new Error(
        `❌ [Migración 007] Discrepancia en recuento de filas tras migración: antes=${rows.length}, después=${newCount}`
      );
    }
  }
};
