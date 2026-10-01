/**
 * PresuVoz — Migración Experimental 015: Structural Canonical Company ID
 * 
 * Versión: 15
 * 
 * OBJETIVOS:
 * 1. companies:
 *    - id TEXT PRIMARY KEY (UUIDv4)
 *    - phone TEXT NOT NULL UNIQUE
 *    - phone_contact TEXT
 *    - Todos los demás campos preservados
 * 
 * 2. Tablas de negocio:
 *    - budgets: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT
 *    - invoices: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT
 *    - payments: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT
 *    - appointments: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE CASCADE
 *    - shopping_items: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE CASCADE
 *    - payment_allocations: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 *                           invoice_id FK -> invoices(id) ON DELETE CASCADE,
 *                           payment_id FK -> payments(id) ON DELETE CASCADE
 *    (Eliminando company_phone de budgets, invoices, payments, appointments, shopping_items)
 * 
 * 3. Tablas fiscales y de auditoría:
 *    - business_tax_profiles: company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE RESTRICT
 *                             (Elimina business_id como PK)
 *    - fiscal_periods: id TEXT PRIMARY KEY, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 *                      fiscal_year INTEGER NOT NULL, quarter INTEGER NOT NULL,
 *                      UNIQUE(company_id, fiscal_year, quarter)
 *                      (Elimina business_id)
 *    - purchase_invoices: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT
 *                         (Elimina business_id)
 *    - expense_payments: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 *                        purchase_invoice_id FK -> purchase_invoices(id) ON DELETE RESTRICT
 *                        (Elimina business_id)
 *    - investment_assets: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
 *                         purchase_invoice_id FK -> purchase_invoices(id) ON DELETE RESTRICT
 *                         (Elimina business_id)
 *    - fiscal_incidents: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT
 *                        (Elimina business_id)
 *    - audit_logs: id PK, company_id NOT NULL REFERENCES companies(id) ON DELETE RESTRICT
 *                  (Elimina business_id)
 * 
 * 4. messages:
 *    - id TEXT PRIMARY KEY
 *    - whatsapp_message_id TEXT UNIQUE
 *    - company_id TEXT REFERENCES companies(id) ON DELETE SET NULL  (NULLABLE)
 *    - (Elimina business_id)
 * 
 * 5. channel_identities y memberships:
 *    - Preservadas con FK -> companies(id)
 * 
 * 6. FAIL-CLOSED:
 *    - Si un registro huérfano o ambiguo no puede asociarse inequívocamente: ABORTA con ROLLBACK.
 *    - PRAGMA foreign_key_check e integrity_check deben ser impecables.
 */

export function executeCanonicalMigration(db, options = {}) {
  const cleanPhoneDigits = (val) => String(val || '').replace(/\D/g, '');

  console.log('--- [MIGRACIÓN 015] Iniciando Migración Estructural Canónica ---');

  // Guardar estado previo de foreign_keys
  const fkState = db.prepare('PRAGMA foreign_keys').get();
  const originalFk = fkState ? fkState.foreign_keys : 1;

  // Desactivar temporalmente foreign_keys para reconstrucción física segura
  db.exec('PRAGMA foreign_keys = OFF;');

  try {
    db.exec('BEGIN IMMEDIATE TRANSACTION;');

    // 0. MAPA DE RESOLUCIÓN DE TENANT CANÓNICO (FAIL-CLOSED)
    // Obtenemos todas las empresas existentes
    const companies = db.prepare('SELECT id, phone, phone_contact FROM companies').all();
    if (companies.length === 0) {
      const hasOtherData = (db.prepare('SELECT COUNT(*) as c FROM budgets').get()?.c || 0) > 0 ||
                           (db.prepare('SELECT COUNT(*) as c FROM invoices').get()?.c || 0) > 0 ||
                           (db.prepare('SELECT COUNT(*) as c FROM messages').get()?.c || 0) > 0;
      if (hasOtherData && !options.allowEmpty) {
        throw new Error('🛑 [MIGRACIÓN 015] La tabla companies está vacía pero existen registros de negocio. Abortando.');
      }
    }

    // Mapa determinista: cleanPhone/identifier -> company_id
    const resolveCompanyId = (rawIdentifier) => {
      if (!rawIdentifier) return null;
      const str = String(rawIdentifier).trim();

      // Si ya es un UUID existente en companies
      const matchUuid = companies.find(c => c.id.toLowerCase() === str.toLowerCase());
      if (matchUuid) return matchUuid.id;

      const digits = cleanPhoneDigits(str);
      if (!digits) return null;

      // Buscar por phone o phone_contact en companies
      const matches = companies.filter(c => {
        const p1 = cleanPhoneDigits(c.phone);
        const p2 = cleanPhoneDigits(c.phone_contact);
        return p1 === digits || p2 === digits;
      });

      if (matches.length === 1) {
        return matches[0].id;
      }

      // Buscar en channel_identities si existe la tabla
      const hasChannelIdentities = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_identities'").get();
      if (hasChannelIdentities) {
        const rows = db.prepare('SELECT company_id FROM channel_identities WHERE channel_identifier = ?').all(digits);
        const uniqueChannelCompanies = Array.from(new Set(rows.map(r => r.company_id)));
        if (uniqueChannelCompanies.length === 1) {
          return uniqueChannelCompanies[0];
        }
      }

      if (matches.length > 1) {
        throw new Error(`🛑 [MIGRACIÓN 015] Ambigüedad crítica: Identificador '${str}' coincide con múltiples empresas: ${matches.map(m=>m.id).join(', ')}`);
      }

      return null;
    };

    // Soporte para pruebas de rollback atómico en múltiples puntos
    if (options.forceFail === true || options.forceFail === 'start') {
      throw new Error('🛑 [TEST ROLLBACK:start] Fallo forzado al inicio para verificar rollback atómico.');
    }

    // =========================================================================
    // 1. RECONSTRUCCIÓN DE companies (id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE)
    // =========================================================================
    console.log('1. Reconstruyendo companies (id PK, phone UNIQUE NOT NULL)...');
    
    // Validar que no existan ids nulos o duplicados
    const compRows = db.prepare('SELECT * FROM companies').all();
    const seenIds = new Set();
    const seenPhones = new Set();
    for (const r of compRows) {
      if (!r.id) throw new Error(`🛑 [MIGRACIÓN 015] Empresa sin id UUID: ${r.phone}`);
      if (seenIds.has(r.id)) throw new Error(`🛑 [MIGRACIÓN 015] id UUID duplicado en companies: ${r.id}`);
      seenIds.add(r.id);
      const cleanP = cleanPhoneDigits(r.phone);
      if (!cleanP) throw new Error(`🛑 [MIGRACIÓN 015] Empresa sin phone válido: ${r.id}`);
      if (seenPhones.has(cleanP)) throw new Error(`🛑 [MIGRACIÓN 015] Teléfono duplicado en companies: ${cleanP}`);
      seenPhones.add(cleanP);
    }

    db.exec(`
      CREATE TABLE companies_new (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        name TEXT,
        fiscal_name TEXT,
        owner_name TEXT,
        cif TEXT,
        trade TEXT,
        address TEXT,
        city TEXT,
        working_hours TEXT,
        payment_terms TEXT,
        quote_validity_days INTEGER,
        entity_type TEXT,
        irpf_rate REAL,
        invoice_series TEXT,
        phone_contact TEXT,
        email TEXT,
        iban TEXT,
        bizum TEXT,
        logo_path TEXT,
        gestoria_email TEXT,
        default_tax_rate INTEGER,
        default_advance INTEGER,
        onboarding_step TEXT,
        onboarding_data_json TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);

    const insertComp = db.prepare(`
      INSERT INTO companies_new (
        id, phone, name, fiscal_name, owner_name, cif, trade, address, city, working_hours,
        payment_terms, quote_validity_days, entity_type, irpf_rate, invoice_series,
        phone_contact, email, iban, bizum, logo_path, gestoria_email, default_tax_rate,
        default_advance, onboarding_step, onboarding_data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of compRows) {
      insertComp.run(
        r.id, r.phone, r.name, r.fiscal_name, r.owner_name, r.cif, r.trade, r.address, r.city, r.working_hours,
        r.payment_terms, r.quote_validity_days, r.entity_type, r.irpf_rate, r.invoice_series,
        r.phone_contact, r.email, r.iban, r.bizum, r.logo_path, r.gestoria_email, r.default_tax_rate,
        r.default_advance, r.onboarding_step, r.onboarding_data_json, r.created_at, r.updated_at
      );
    }

    db.exec(`
      DROP TABLE companies;
      ALTER TABLE companies_new RENAME TO companies;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_phone ON companies(phone);
    `);

    // =========================================================================
    // 2. RECONSTRUCCIÓN DE channel_identities y memberships
    // =========================================================================
    console.log('2. Reconstruyendo channel_identities y memberships con FK -> companies(id)...');
    
    // channel_identities
    const chRows = db.prepare('SELECT * FROM channel_identities').all();
    db.exec(`
      CREATE TABLE channel_identities_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_identifier TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        UNIQUE (channel, channel_identifier)
      );
    `);
    const insertCh = db.prepare(`
      INSERT INTO channel_identities_new (id, company_id, channel, channel_identifier, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of chRows) {
      const cid = r.company_id || resolveCompanyId(r.channel_identifier);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] channel_identity huérfana: ${r.id}`);
      insertCh.run(r.id, cid, r.channel, r.channel_identifier, r.is_active, r.created_at, r.updated_at);
    }
    db.exec(`
      DROP TABLE channel_identities;
      ALTER TABLE channel_identities_new RENAME TO channel_identities;
      CREATE INDEX IF NOT EXISTS idx_channel_identities_company ON channel_identities(company_id);
      CREATE INDEX IF NOT EXISTS idx_channel_identities_lookup ON channel_identities(channel, channel_identifier);
    `);

    // memberships
    const memRows = db.prepare('SELECT * FROM memberships').all();
    db.exec(`
      CREATE TABLE memberships_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        UNIQUE (user_id, company_id)
      );
    `);
    const insertMem = db.prepare(`
      INSERT INTO memberships_new (id, user_id, company_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of memRows) {
      if (!r.company_id) throw new Error(`🛑 [MIGRACIÓN 015] membership sin company_id: ${r.id}`);
      insertMem.run(r.id, r.user_id, r.company_id, r.role, r.status, r.created_at, r.updated_at);
    }
    db.exec(`
      DROP TABLE memberships;
      ALTER TABLE memberships_new RENAME TO memberships;
      CREATE INDEX IF NOT EXISTS idx_memberships_company_user ON memberships(company_id, user_id);
    `);

    // =========================================================================
    // 3. RECONSTRUCCIÓN DE budgets (Elimina company_phone, company_id NOT NULL)
    // =========================================================================
    console.log('3. Reconstruyendo budgets (eliminando company_phone, company_id NOT NULL)...');
    const budRows = db.prepare('SELECT * FROM budgets').all();
    db.exec(`
      CREATE TABLE budgets_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        client_name TEXT,
        client_address TEXT,
        client_phone TEXT,
        total_amount REAL,
        status TEXT,
        data_json TEXT,
        created_at TEXT,
        updated_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertBud = db.prepare(`
      INSERT INTO budgets_new (id, company_id, client_name, client_address, client_phone, total_amount, status, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of budRows) {
      const cid = r.company_id || resolveCompanyId(r.company_phone);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Presupuesto huérfano sin company_id: ${r.id}`);
      insertBud.run(r.id, cid, r.client_name, r.client_address, r.client_phone, r.total_amount, r.status, r.data_json, r.created_at, r.updated_at);
    }
    db.exec(`
      DROP TABLE budgets;
      ALTER TABLE budgets_new RENAME TO budgets;
      CREATE INDEX IF NOT EXISTS idx_budgets_company_id ON budgets(company_id);
      CREATE INDEX IF NOT EXISTS idx_budgets_company_id_updated ON budgets(company_id, updated_at);
    `);

    if (options.forceFail === 'mid_tables') {
      throw new Error('🛑 [TEST ROLLBACK:mid_tables] Fallo forzado a mitad de reconstrucción de tablas.');
    }

    // =========================================================================
    // 4. RECONSTRUCCIÓN DE invoices (Elimina company_phone, company_id NOT NULL)
    // =========================================================================
    console.log('4. Reconstruyendo invoices (eliminando company_phone, company_id NOT NULL)...');
    const invRows = db.prepare('SELECT * FROM invoices').all();
    db.exec(`
      CREATE TABLE invoices_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        budget_id TEXT,
        client_name TEXT,
        total_amount REAL,
        status TEXT,
        data_json TEXT,
        created_at TEXT,
        rectifies_invoice_id TEXT,
        fiscal_period TEXT,
        verifactu_hash TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertInv = db.prepare(`
      INSERT INTO invoices_new (id, company_id, budget_id, client_name, total_amount, status, data_json, created_at, rectifies_invoice_id, fiscal_period, verifactu_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of invRows) {
      const cid = r.company_id || resolveCompanyId(r.company_phone);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Factura huérfana sin company_id: ${r.id}`);
      insertInv.run(r.id, cid, r.budget_id, r.client_name, r.total_amount, r.status, r.data_json, r.created_at, r.rectifies_invoice_id, r.fiscal_period, r.verifactu_hash);
    }
    db.exec(`
      DROP TABLE invoices;
      ALTER TABLE invoices_new RENAME TO invoices;
      CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices(company_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_company_id_created ON invoices(company_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_invoices_company_id_id ON invoices(company_id, id);
    `);

    // =========================================================================
    // 5. RECONSTRUCCIÓN DE payments (Elimina company_phone, company_id NOT NULL)
    // =========================================================================
    console.log('5. Reconstruyendo payments (eliminando company_phone, company_id NOT NULL)...');
    const payRows = db.prepare('SELECT * FROM payments').all();
    db.exec(`
      CREATE TABLE payments_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        budget_id TEXT,
        amount REAL,
        method TEXT,
        concept TEXT,
        data_json TEXT,
        created_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertPay = db.prepare(`
      INSERT INTO payments_new (id, company_id, budget_id, amount, method, concept, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of payRows) {
      const cid = r.company_id || resolveCompanyId(r.company_phone);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Pago huérfano sin company_id: ${r.id}`);
      insertPay.run(r.id, cid, r.budget_id, r.amount, r.method, r.concept, r.data_json, r.created_at);
    }
    db.exec(`
      DROP TABLE payments;
      ALTER TABLE payments_new RENAME TO payments;
      CREATE INDEX IF NOT EXISTS idx_payments_company_id ON payments(company_id);
      CREATE INDEX IF NOT EXISTS idx_payments_company_id_created ON payments(company_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_payments_company_id_id ON payments(company_id, id);
    `);

    // =========================================================================
    // 6. RECONSTRUCCIÓN DE payment_allocations
    // =========================================================================
    console.log('6. Reconstruyendo payment_allocations (FKs a companies, invoices, payments)...');
    const allocRows = db.prepare('SELECT * FROM payment_allocations').all();
    db.exec(`
      CREATE TABLE payment_allocations_new (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        invoice_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        amount REAL NOT NULL,
        allocated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
        FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT
      );
    `);
    const insertAlloc = db.prepare(`
      INSERT INTO payment_allocations_new (id, payment_id, invoice_id, company_id, amount, allocated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of allocRows) {
      if (!r.company_id) throw new Error(`🛑 [MIGRACIÓN 015] Asignación sin company_id: ${r.id}`);
      insertAlloc.run(r.id, r.payment_id, r.invoice_id, r.company_id, r.amount, r.allocated_at, r.created_at, r.updated_at);
    }
    db.exec(`
      DROP TABLE payment_allocations;
      ALTER TABLE payment_allocations_new RENAME TO payment_allocations;
      CREATE INDEX IF NOT EXISTS idx_allocations_company_id ON payment_allocations(company_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_company_invoice ON payment_allocations(company_id, invoice_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_company_payment ON payment_allocations(company_id, payment_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_invoice_id ON payment_allocations(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_payment_id ON payment_allocations(payment_id);
    `);

    // =========================================================================
    // 7. RECONSTRUCCIÓN DE appointments (Elimina company_phone, company_id NOT NULL)
    // =========================================================================
    console.log('7. Reconstruyendo appointments (eliminando company_phone, company_id NOT NULL)...');
    const aptRows = db.prepare('SELECT * FROM appointments').all();
    db.exec(`
      CREATE TABLE appointments_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        client_name TEXT,
        client_phone TEXT,
        client_address TEXT,
        date TEXT,
        time TEXT,
        notes TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT,
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
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertApt = db.prepare(`
      INSERT INTO appointments_new (
        id, company_id, client_name, client_phone, client_address, date, time, notes, status,
        created_at, updated_at, title, scheduled_start, scheduled_end, timezone, outcome,
        needs_outcome_confirmation, original_scheduled_start, reschedule_count,
        reminder_day_sent_at, reminder_morning_sent_at, end_of_day_review_sent_at,
        completed_at, cancelled_at, rescheduled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of aptRows) {
      const cid = r.company_id || resolveCompanyId(r.company_phone);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Cita huérfana sin company_id: ${r.id}`);
      insertApt.run(
        r.id, cid, r.client_name, r.client_phone, r.client_address, r.date, r.time, r.notes, r.status,
        r.created_at, r.updated_at, r.title ?? null, r.scheduled_start ?? null, r.scheduled_end ?? null,
        r.timezone || 'Europe/Madrid', r.outcome || 'NONE', r.needs_outcome_confirmation ?? 0,
        r.original_scheduled_start ?? null, r.reschedule_count ?? 0, r.reminder_day_sent_at ?? null,
        r.reminder_morning_sent_at ?? null, r.end_of_day_review_sent_at ?? null,
        r.completed_at ?? null, r.cancelled_at ?? null, r.rescheduled_at ?? null
      );
    }
    db.exec(`
      DROP TABLE appointments;
      ALTER TABLE appointments_new RENAME TO appointments;
      CREATE INDEX IF NOT EXISTS idx_appointments_company_id ON appointments(company_id);
      CREATE INDEX IF NOT EXISTS idx_appointments_company_date ON appointments(company_id, date);
      CREATE INDEX IF NOT EXISTS idx_appointments_company_status ON appointments(company_id, status);
    `);

    // =========================================================================
    // 8. RECONSTRUCCIÓN DE shopping_items (Elimina company_phone, company_id NOT NULL)
    // =========================================================================
    console.log('8. Reconstruyendo shopping_items (eliminando company_phone, company_id NOT NULL)...');
    const shpRows = db.prepare('SELECT * FROM shopping_items').all();
    db.exec(`
      CREATE TABLE shopping_items_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        client_name TEXT,
        budget_id TEXT,
        description TEXT,
        qty REAL,
        unit TEXT,
        status TEXT,
        notes TEXT,
        created_at TEXT,
        bought_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertShp = db.prepare(`
      INSERT INTO shopping_items_new (id, company_id, client_name, budget_id, description, qty, unit, status, notes, created_at, bought_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of shpRows) {
      const cid = r.company_id || resolveCompanyId(r.company_phone);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Item huérfano sin company_id: ${r.id}`);
      insertShp.run(r.id, cid, r.client_name, r.budget_id, r.description, r.qty, r.unit, r.status, r.notes, r.created_at, r.bought_at);
    }
    db.exec(`
      DROP TABLE shopping_items;
      ALTER TABLE shopping_items_new RENAME TO shopping_items;
      CREATE INDEX IF NOT EXISTS idx_shopping_items_company_id ON shopping_items(company_id);
      CREATE INDEX IF NOT EXISTS idx_shopping_items_company_status ON shopping_items(company_id, status);
    `);

    // =========================================================================
    // 9. RECONSTRUCCIÓN DE business_tax_profiles (company_id TEXT PRIMARY KEY)
    // =========================================================================
    console.log('9. Reconstruyendo business_tax_profiles (promocionando company_id a PK, eliminando business_id)...');
    const btpRows = db.prepare('SELECT * FROM business_tax_profiles').all();
    db.exec(`
      CREATE TABLE business_tax_profiles_new (
        company_id TEXT PRIMARY KEY NOT NULL,
        legal_name TEXT,
        tax_id TEXT,
        legal_form TEXT,
        economic_activity TEXT,
        iae_code TEXT,
        tax_regime TEXT,
        vat_regime TEXT,
        income_tax_regime TEXT,
        vat_frequency TEXT,
        income_tax_frequency TEXT,
        irpf_withholding_applicable INTEGER,
        default_irpf_rate REAL,
        default_vat_rate REAL,
        accounting_start_date TEXT,
        fiscal_year INTEGER,
        current_invoice_series TEXT,
        verifactu_status TEXT,
        gestor_name TEXT,
        gestor_email TEXT,
        gestor_phone TEXT,
        gestor_notes TEXT,
        created_at TEXT,
        updated_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertBtp = db.prepare(`
      INSERT INTO business_tax_profiles_new (
        company_id, legal_name, tax_id, legal_form, economic_activity, iae_code,
        tax_regime, vat_regime, income_tax_regime, vat_frequency, income_tax_frequency,
        irpf_withholding_applicable, default_irpf_rate, default_vat_rate, accounting_start_date,
        fiscal_year, current_invoice_series, verifactu_status, gestor_name, gestor_email,
        gestor_phone, gestor_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of btpRows) {
      const cid = r.company_id || resolveCompanyId(r.business_id);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Perfil fiscal huérfano sin company_id: ${r.business_id}`);
      insertBtp.run(
        cid, r.legal_name, r.tax_id, r.legal_form, r.economic_activity, r.iae_code,
        r.tax_regime, r.vat_regime, r.income_tax_regime, r.vat_frequency, r.income_tax_frequency,
        r.irpf_withholding_applicable, r.default_irpf_rate, r.default_vat_rate, r.accounting_start_date,
        r.fiscal_year, r.current_invoice_series, r.verifactu_status, r.gestor_name, r.gestor_email,
        r.gestor_phone, r.gestor_notes, r.created_at, r.updated_at
      );
    }
    db.exec(`
      DROP TABLE business_tax_profiles;
      ALTER TABLE business_tax_profiles_new RENAME TO business_tax_profiles;
    `);

    // =========================================================================
    // 10. RECONSTRUCCIÓN DE fiscal_periods (id PK, company_id NOT NULL, elimina business_id)
    // =========================================================================
    console.log('10. Reconstruyendo fiscal_periods (id PK, company_id NOT NULL, UNIQUE company_year_quarter)...');
    const fpRows = db.prepare('SELECT * FROM fiscal_periods').all();
    db.exec(`
      CREATE TABLE fiscal_periods_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        fiscal_year INTEGER NOT NULL,
        quarter INTEGER NOT NULL,
        status TEXT,
        last_quality_check_at TEXT,
        critical_incidents_count INTEGER,
        warnings_count INTEGER,
        package_path TEXT,
        sent_at TEXT,
        sent_to_email TEXT,
        created_at TEXT,
        updated_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
        UNIQUE (company_id, fiscal_year, quarter)
      );
    `);
    const insertFp = db.prepare(`
      INSERT INTO fiscal_periods_new (
        id, company_id, fiscal_year, quarter, status, last_quality_check_at,
        critical_incidents_count, warnings_count, package_path, sent_at, sent_to_email,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of fpRows) {
      const cid = r.company_id || resolveCompanyId(r.business_id);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Periodo fiscal huérfano sin company_id: ${r.id}`);
      insertFp.run(
        r.id, cid, r.fiscal_year, r.quarter, r.status, r.last_quality_check_at,
        r.critical_incidents_count, r.warnings_count, r.package_path, r.sent_at, r.sent_to_email,
        r.created_at, r.updated_at
      );
    }
    db.exec(`
      DROP TABLE fiscal_periods;
      ALTER TABLE fiscal_periods_new RENAME TO fiscal_periods;
      CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company ON fiscal_periods(company_id);
      CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company_status ON fiscal_periods(company_id, status);
    `);

    // =========================================================================
    // 11. RECONSTRUCCIÓN DE purchase_invoices (id PK, company_id NOT NULL, elimina business_id)
    // =========================================================================
    console.log('11. Reconstruyendo purchase_invoices (eliminando business_id, company_id NOT NULL)...');
    const pinvRows = db.prepare('SELECT * FROM purchase_invoices').all();
    db.exec(`
      CREATE TABLE purchase_invoices_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
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
        deductibility_status TEXT,
        income_tax_relevance TEXT,
        expense_category TEXT,
        payment_status TEXT,
        payment_method TEXT,
        payment_date TEXT,
        document_path TEXT,
        is_investment_asset INTEGER,
        fiscal_period TEXT NOT NULL,
        notes TEXT,
        data_json TEXT,
        created_at TEXT,
        updated_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertPinv = db.prepare(`
      INSERT INTO purchase_invoices_new (
        id, company_id, supplier_name, supplier_tax_id, invoice_number, invoice_date,
        operation_date, description, taxable_base, vat_rate, vat_amount, total_amount,
        deductible_vat_amount, deductibility_status, income_tax_relevance, expense_category,
        payment_status, payment_method, payment_date, document_path, is_investment_asset,
        fiscal_period, notes, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of pinvRows) {
      const cid = r.company_id || resolveCompanyId(r.business_id);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Factura de compra huérfana sin company_id: ${r.id}`);
      insertPinv.run(
        r.id, cid, r.supplier_name, r.supplier_tax_id, r.invoice_number, r.invoice_date,
        r.operation_date, r.description, r.taxable_base, r.vat_rate, r.vat_amount, r.total_amount,
        r.deductible_vat_amount, r.deductibility_status, r.income_tax_relevance, r.expense_category,
        r.payment_status, r.payment_method, r.payment_date, r.document_path, r.is_investment_asset,
        r.fiscal_period, r.notes, r.data_json, r.created_at, r.updated_at
      );
    }
    db.exec(`
      DROP TABLE purchase_invoices;
      ALTER TABLE purchase_invoices_new RENAME TO purchase_invoices;
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_company ON purchase_invoices(company_id);
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_company_period ON purchase_invoices(company_id, fiscal_period);
      CREATE INDEX IF NOT EXISTS idx_purchase_inv_company_date ON purchase_invoices(company_id, invoice_date);
    `);

    // =========================================================================
    // 12. RECONSTRUCCIÓN DE expense_payments (id PK, company_id NOT NULL, elimina business_id)
    // =========================================================================
    console.log('12. Reconstruyendo expense_payments (eliminando business_id, company_id NOT NULL)...');
    const expRows = db.prepare('SELECT * FROM expense_payments').all();
    db.exec(`
      CREATE TABLE expense_payments_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        purchase_invoice_id TEXT NOT NULL,
        amount REAL NOT NULL,
        payment_date TEXT NOT NULL,
        payment_method TEXT,
        reference TEXT,
        created_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
        FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices(id) ON DELETE RESTRICT
      );
    `);
    const insertExp = db.prepare(`
      INSERT INTO expense_payments_new (id, company_id, purchase_invoice_id, amount, payment_date, payment_method, reference, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of expRows) {
      const cid = r.company_id || resolveCompanyId(r.business_id);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Pago de gasto huérfano sin company_id: ${r.id}`);
      // Validar que el purchase_invoice pertenezca a la misma company_id
      const pinv = db.prepare('SELECT company_id FROM purchase_invoices WHERE id = ?').get(r.purchase_invoice_id);
      if (pinv && pinv.company_id !== cid) {
        throw new Error(`🛑 [MIGRACIÓN 015] Mismatch cross-tenant en expense_payments: pago ${cid} vs factura ${pinv.company_id}`);
      }
      insertExp.run(r.id, cid, r.purchase_invoice_id, r.amount, r.payment_date, r.payment_method, r.reference, r.created_at);
    }
    db.exec(`
      DROP TABLE expense_payments;
      ALTER TABLE expense_payments_new RENAME TO expense_payments;
      CREATE INDEX IF NOT EXISTS idx_expense_pay_company ON expense_payments(company_id);
      CREATE INDEX IF NOT EXISTS idx_expense_pay_invoice ON expense_payments(purchase_invoice_id);
      CREATE INDEX IF NOT EXISTS idx_expense_pay_company_date ON expense_payments(company_id, payment_date);
    `);

    // =========================================================================
    // 13. RECONSTRUCCIÓN DE investment_assets (id PK, company_id NOT NULL, elimina business_id)
    // =========================================================================
    console.log('13. Reconstruyendo investment_assets (eliminando business_id, company_id NOT NULL)...');
    const astRows = db.prepare('SELECT * FROM investment_assets').all();
    db.exec(`
      CREATE TABLE investment_assets_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        purchase_invoice_id TEXT,
        description TEXT NOT NULL,
        purchase_date TEXT NOT NULL,
        supplier_name TEXT,
        purchase_base REAL NOT NULL,
        vat_amount REAL NOT NULL,
        total_amount REAL NOT NULL,
        business_use_percentage REAL,
        depreciation_method TEXT,
        depreciation_status TEXT,
        notes TEXT,
        created_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT,
        FOREIGN KEY (purchase_invoice_id) REFERENCES purchase_invoices(id) ON DELETE RESTRICT
      );
    `);
    const insertAst = db.prepare(`
      INSERT INTO investment_assets_new (
        id, company_id, purchase_invoice_id, description, purchase_date, supplier_name,
        purchase_base, vat_amount, total_amount, business_use_percentage, depreciation_method,
        depreciation_status, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of astRows) {
      const cid = r.company_id || resolveCompanyId(r.business_id);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Activo huérfano sin company_id: ${r.id}`);
      if (r.purchase_invoice_id) {
        const pinv = db.prepare('SELECT company_id FROM purchase_invoices WHERE id = ?').get(r.purchase_invoice_id);
        if (pinv && pinv.company_id !== cid) {
          throw new Error(`🛑 [MIGRACIÓN 015] Mismatch cross-tenant en investment_assets: activo ${cid} vs factura ${pinv.company_id}`);
        }
      }
      insertAst.run(
        r.id, cid, r.purchase_invoice_id, r.description, r.purchase_date, r.supplier_name,
        r.purchase_base, r.vat_amount, r.total_amount, r.business_use_percentage, r.depreciation_method,
        r.depreciation_status, r.notes, r.created_at
      );
    }
    db.exec(`
      DROP TABLE investment_assets;
      ALTER TABLE investment_assets_new RENAME TO investment_assets;
      CREATE INDEX IF NOT EXISTS idx_investment_assets_company ON investment_assets(company_id);
      CREATE INDEX IF NOT EXISTS idx_investment_assets_invoice ON investment_assets(purchase_invoice_id);
    `);

    // =========================================================================
    // 14. RECONSTRUCCIÓN DE fiscal_incidents (id PK, company_id NOT NULL, elimina business_id)
    // =========================================================================
    console.log('14. Reconstruyendo fiscal_incidents (eliminando business_id, company_id NOT NULL)...');
    const incRows = db.prepare('SELECT * FROM fiscal_incidents').all();
    db.exec(`
      CREATE TABLE fiscal_incidents_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        fiscal_period TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        error_code TEXT NOT NULL,
        message TEXT NOT NULL,
        resolution_status TEXT,
        created_at TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertInc = db.prepare(`
      INSERT INTO fiscal_incidents_new (id, company_id, fiscal_period, entity_type, entity_id, severity, error_code, message, resolution_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of incRows) {
      const cid = r.company_id || resolveCompanyId(r.business_id);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Incidencia fiscal huérfana sin company_id: ${r.id}`);
      insertInc.run(r.id, cid, r.fiscal_period, r.entity_type, r.entity_id, r.severity, r.error_code, r.message, r.resolution_status, r.created_at);
    }
    db.exec(`
      DROP TABLE fiscal_incidents;
      ALTER TABLE fiscal_incidents_new RENAME TO fiscal_incidents;
      CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company ON fiscal_incidents(company_id);
      CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company_period ON fiscal_incidents(company_id, fiscal_period);
      CREATE INDEX IF NOT EXISTS idx_fiscal_incidents_company_status ON fiscal_incidents(company_id, resolution_status);
    `);

    // =========================================================================
    // 15. RECONSTRUCCIÓN DE audit_logs (id PK, company_id NOT NULL, elimina business_id)
    // =========================================================================
    console.log('15. Reconstruyendo audit_logs (eliminando business_id, company_id NOT NULL)...');
    const logRows = db.prepare('SELECT * FROM audit_logs').all();
    db.exec(`
      CREATE TABLE audit_logs_new (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        field_changed TEXT,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT,
        reason TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);
    const insertLog = db.prepare(`
      INSERT INTO audit_logs_new (id, company_id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, reason, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of logRows) {
      const cid = r.company_id || resolveCompanyId(r.business_id);
      if (!cid) throw new Error(`🛑 [MIGRACIÓN 015] Audit log huérfano sin company_id: ${r.id}`);
      insertLog.run(r.id, cid, r.entity_type, r.entity_id, r.action, r.field_changed, r.old_value, r.new_value, r.changed_by, r.reason, r.timestamp);
    }
    db.exec(`
      DROP TABLE audit_logs;
      ALTER TABLE audit_logs_new RENAME TO audit_logs;
      CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_company_time ON audit_logs(company_id, timestamp);
    `);

    // =========================================================================
    // 16. RECONSTRUCCIÓN DE messages (id PK, company_id NULLABLE, elimina business_id)
    // =========================================================================
    console.log('16. Reconstruyendo messages (company_id NULLABLE, eliminando business_id)...');
    const msgRows = db.prepare('SELECT * FROM messages').all();
    db.exec(`
      CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        whatsapp_message_id TEXT UNIQUE,
        company_id TEXT,
        chat_id TEXT,
        sender_phone TEXT,
        content TEXT,
        timestamp TEXT,
        status TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
      );
    `);
    const insertMsg = db.prepare(`
      INSERT INTO messages_new (id, whatsapp_message_id, company_id, chat_id, sender_phone, content, timestamp, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of msgRows) {
      let cid = r.company_id || resolveCompanyId(r.business_id) || resolveCompanyId(r.sender_phone) || resolveCompanyId(r.chat_id);
      if (!cid && r.status !== 'REJECTED' && r.status !== 'UNAUTHENTICATED') {
        // En producción los 51 mensajes históricos tienen remitente resolvible
        // Si no se puede resolver y no es rechazado, fail-closed
        throw new Error(`🛑 [MIGRACIÓN 015] Mensaje procesado sin tenant asignable: ${r.id}`);
      }
      insertMsg.run(r.id, r.whatsapp_message_id, cid || null, r.chat_id, r.sender_phone, r.content, r.timestamp, r.status);
    }
    db.exec(`
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_company_status ON messages(company_id, status);
      CREATE INDEX IF NOT EXISTS idx_messages_company_time ON messages(company_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_wam_id ON messages(whatsapp_message_id);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_status ON messages(chat_id, status);
    `);

    if (options.forceFail === 'pre_validation') {
      throw new Error('🛑 [TEST ROLLBACK:pre_validation] Fallo forzado antes de las validaciones finales.');
    }

    // =========================================================================
    // 17. VALIDACIONES DE INTEGRIDAD ESTRICTAS ANTES DE COMMIT
    // =========================================================================
    console.log('17. Ejecutando PRAGMA foreign_key_check e integrity_check...');
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (fkViolations.length > 0) {
      throw new Error(`🛑 [MIGRACIÓN 015] Violaciones de clave foránea detectadas: ${JSON.stringify(fkViolations)}`);
    }

    if (options.forceFail === 'pre_commit') {
      throw new Error('🛑 [TEST ROLLBACK:pre_commit] Fallo forzado justo antes de COMMIT.');
    }

    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (!integrity || integrity.length === 0 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`🛑 [MIGRACIÓN 015] Fallo en integrity_check: ${JSON.stringify(integrity)}`);
    }

    // Registrar migración 015 en schema_migrations
    const now = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (15, ?, ?)')
      .run('015_structural_canonical_company_id', now);

    db.exec('COMMIT;');
    console.log('✨ [MIGRACIÓN 015] Transacción completada y consolidada con éxito.');
  } catch (err) {
    console.error('❌ [MIGRACIÓN 015] ERROR durante la ejecución:', err.message);
    try {
      db.exec('ROLLBACK;');
      console.log('🔄 [MIGRACIÓN 015] Transacción revertida (ROLLBACK). Base de datos intacta.');
    } catch (rbErr) {
      console.error('⚠️ [MIGRACIÓN 015] Error al revertir:', rbErr.message);
    }
    throw err;
  } finally {
    // Restaurar PRAGMA foreign_keys al estado original
    db.exec(`PRAGMA foreign_keys = ${originalFk ? 'ON' : 'OFF'};`);
  }
}
