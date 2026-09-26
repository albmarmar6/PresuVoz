/**
 * PresuVoz — Migración 001: Baseline Schema (14 Tablas + 7 Índices)
 * 
 * Versión: 1
 * Fecha: 2026-09-26
 * 
 * Contrato:
 * Define y congela el esquema relacional completo de PresuVoz previo a la
 * introducción de multi-tenant (company_id) y clientes unificados (customers).
 * 
 * Idempotencia y Adopción:
 * - Asegura la existencia de las 14 tablas con CREATE TABLE IF NOT EXISTS.
 * - En bases de datos existentes con esquemas previos o incompletos, comprueba y
 *   añade de forma segura e idempotente cualquier columna evolutiva faltante.
 * - Asegura la creación de los 7 índices de rendimiento.
 */

export const migration = {
  version: 1,
  name: '001_baseline_schema',
  up: (db) => {
    // 1. Crear todas las tablas del baseline si no existen
    db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        phone TEXT PRIMARY KEY,
        name TEXT,
        cif TEXT,
        address TEXT,
        phone_contact TEXT,
        email TEXT,
        iban TEXT,
        bizum TEXT,
        trade TEXT,
        logo_path TEXT,
        gestoria_email TEXT,
        default_tax_rate INTEGER DEFAULT 10,
        default_advance INTEGER DEFAULT 30,
        owner_name TEXT,
        city TEXT,
        working_hours TEXT,
        payment_terms TEXT,
        quote_validity_days INTEGER DEFAULT 15,
        entity_type TEXT,
        fiscal_name TEXT,
        irpf_rate REAL DEFAULT 0,
        invoice_series TEXT DEFAULT '2026-',
        onboarding_step TEXT,
        onboarding_data_json TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        company_phone TEXT,
        client_name TEXT,
        client_address TEXT,
        client_phone TEXT,
        total_amount REAL,
        status TEXT,
        data_json TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        budget_id TEXT,
        company_phone TEXT,
        client_name TEXT,
        total_amount REAL,
        status TEXT,
        rectifies_invoice_id TEXT,
        fiscal_period TEXT,
        verifactu_hash TEXT,
        data_json TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        budget_id TEXT,
        company_phone TEXT,
        amount REAL,
        method TEXT,
        concept TEXT,
        data_json TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        company_phone TEXT,
        client_name TEXT,
        client_phone TEXT,
        client_address TEXT,
        date TEXT,
        time TEXT,
        notes TEXT,
        status TEXT,
        title TEXT,
        scheduled_start TEXT,
        scheduled_end TEXT,
        timezone TEXT DEFAULT 'Europe/Madrid',
        outcome TEXT DEFAULT 'NONE',
        needs_outcome_confirmation INTEGER DEFAULT 0,
        original_scheduled_start TEXT,
        reschedule_count INTEGER DEFAULT 0,
        reminder_day_sent_at TEXT,
        reminder_morning_sent_at TEXT,
        end_of_day_review_sent_at TEXT,
        completed_at TEXT,
        cancelled_at TEXT,
        rescheduled_at TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS shopping_items (
        id TEXT PRIMARY KEY,
        company_phone TEXT,
        client_name TEXT,
        budget_id TEXT,
        description TEXT,
        qty REAL,
        unit TEXT,
        status TEXT DEFAULT 'PENDING',
        notes TEXT,
        created_at TEXT,
        bought_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        whatsapp_message_id TEXT UNIQUE,
        business_id TEXT,
        chat_id TEXT,
        sender_phone TEXT,
        content TEXT,
        timestamp TEXT,
        status TEXT
      );

      CREATE TABLE IF NOT EXISTS business_tax_profiles (
        business_id TEXT PRIMARY KEY,
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

      CREATE TABLE IF NOT EXISTS purchase_invoices (
        id TEXT PRIMARY KEY,
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
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS expense_payments (
        id TEXT PRIMARY KEY,
        purchase_invoice_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        amount REAL NOT NULL,
        payment_date TEXT NOT NULL,
        payment_method TEXT,
        reference TEXT,
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS investment_assets (
        id TEXT PRIMARY KEY,
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
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS fiscal_periods (
        id TEXT PRIMARY KEY,
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
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS fiscal_incidents (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        fiscal_period TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        error_code TEXT NOT NULL,
        message TEXT NOT NULL,
        resolution_status TEXT DEFAULT 'OPEN',
        created_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        field_changed TEXT,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT DEFAULT 'USER_WHATSAPP',
        reason TEXT,
        timestamp TEXT NOT NULL
      );
    `);

    // 2. Helper de adopción: asegurar columnas faltantes en tablas preexistentes
    const ensureColumn = (table, colName, colDef) => {
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!tableCheck) return;
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
      if (!cols.some(c => c.name === colName)) {
        try {
          db.exec(`ALTER TABLE "${table}" ADD COLUMN ${colDef};`);
        } catch (e) {
          // Ignorar si la columna ya existía
        }
      }
    };

    // Columnas evolutivas en companies
    const companyCols = [
      ['gestoria_email', 'gestoria_email TEXT'],
      ['trade', 'trade TEXT'],
      ['owner_name', 'owner_name TEXT'],
      ['city', 'city TEXT'],
      ['working_hours', 'working_hours TEXT'],
      ['payment_terms', 'payment_terms TEXT'],
      ['quote_validity_days', 'quote_validity_days INTEGER DEFAULT 15'],
      ['entity_type', 'entity_type TEXT'],
      ['fiscal_name', 'fiscal_name TEXT'],
      ['irpf_rate', 'irpf_rate REAL DEFAULT 0'],
      ['invoice_series', 'invoice_series TEXT DEFAULT "2026-"'],
      ['onboarding_step', 'onboarding_step TEXT'],
      ['onboarding_data_json', 'onboarding_data_json TEXT']
    ];
    for (const [colName, colDef] of companyCols) {
      ensureColumn('companies', colName, colDef);
    }

    // Columnas evolutivas en shopping_items
    ensureColumn('shopping_items', 'client_name', 'client_name TEXT');
    ensureColumn('shopping_items', 'budget_id', 'budget_id TEXT');

    // Columnas evolutivas en invoices
    ensureColumn('invoices', 'rectifies_invoice_id', 'rectifies_invoice_id TEXT');
    ensureColumn('invoices', 'fiscal_period', 'fiscal_period TEXT');
    ensureColumn('invoices', 'verifactu_hash', 'verifactu_hash TEXT');

    // Columnas evolutivas en appointments
    const appCols = [
      ['title', 'title TEXT'],
      ['scheduled_start', 'scheduled_start TEXT'],
      ['scheduled_end', 'scheduled_end TEXT'],
      ['timezone', 'timezone TEXT DEFAULT "Europe/Madrid"'],
      ['outcome', 'outcome TEXT DEFAULT "NONE"'],
      ['needs_outcome_confirmation', 'needs_outcome_confirmation INTEGER DEFAULT 0'],
      ['original_scheduled_start', 'original_scheduled_start TEXT'],
      ['reschedule_count', 'reschedule_count INTEGER DEFAULT 0'],
      ['reminder_day_sent_at', 'reminder_day_sent_at TEXT'],
      ['reminder_morning_sent_at', 'reminder_morning_sent_at TEXT'],
      ['end_of_day_review_sent_at', 'end_of_day_review_sent_at TEXT'],
      ['completed_at', 'completed_at TEXT'],
      ['cancelled_at', 'cancelled_at TEXT'],
      ['rescheduled_at', 'rescheduled_at TEXT']
    ];
    for (const [colName, colDef] of appCols) {
      ensureColumn('appointments', colName, colDef);
    }

    // 3. Asegurar los 7 índices de rendimiento
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_wam_id ON messages(whatsapp_message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_status ON messages(chat_id, status);
      CREATE INDEX IF NOT EXISTS idx_appointments_business_date ON appointments(company_phone, date, time);
      CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(company_phone, status);
      CREATE INDEX IF NOT EXISTS idx_appointments_review ON appointments(company_phone, needs_outcome_confirmation, status);
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_period ON purchase_invoices(business_id, fiscal_period);
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_date ON purchase_invoices(business_id, invoice_date);
    `);
  }
};

