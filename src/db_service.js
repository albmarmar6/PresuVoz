import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const LOGOS_DIR = path.join(DATA_DIR, 'logos');
if (!fs.existsSync(LOGOS_DIR)) {
  fs.mkdirSync(LOGOS_DIR, { recursive: true });
}

export const DB_PATH = process.env.PRESUVOZ_DB_PATH
  || (process.env.NODE_ENV === 'test' ? path.resolve('data', 'presuvoz_test.db') : path.resolve('data', 'presuvoz.db'));

// Barrera de seguridad para entorno de tests
if (process.env.NODE_ENV === 'test' && path.resolve(DB_PATH) === path.resolve('data', 'presuvoz.db')) {
  throw new Error('🛑 [BARRERA DE SEGURIDAD CRÍTICA] db_service.js se ha inicializado en NODE_ENV=test apuntando a la base de datos de producción (data/presuvoz.db)! Abortando.');
}

export const db = new DatabaseSync(DB_PATH);

// Activar integridad referencial estricta
db.exec('PRAGMA foreign_keys = ON;');

// NOTA DE SEGURIDAD CRÍTICA:
// Opening/inspecting a database must NEVER mutate its schema.
// Las migraciones NO se ejecutan automáticamente al importar db_service.js.
// Para migrar, se debe usar explícitamente scripts/migrate.js o runMigrations(db, { authorized: true }).

// Migración automática de datos creados accidentalmente bajo el LID de WhatsApp
try {
  const primaryAllowed = (process.env.ALLOWED_NUMBERS || '').split(',')[0]?.trim();
  if (primaryAllowed && primaryAllowed.length >= 9) {
    const oldLid = '82987509096647';
    const oldComp = db.prepare('SELECT * FROM companies WHERE phone = ?').get(oldLid);
    if (oldComp) {
      db.prepare('DELETE FROM companies WHERE phone = ?').run(primaryAllowed);
      db.prepare('UPDATE companies SET phone = ? WHERE phone = ?').run(primaryAllowed, oldLid);
    }
    db.prepare('UPDATE OR IGNORE budgets SET company_phone = ? WHERE company_phone = ?').run(primaryAllowed, oldLid);
    db.prepare('UPDATE OR IGNORE invoices SET company_phone = ? WHERE company_phone = ?').run(primaryAllowed, oldLid);
    db.prepare('UPDATE OR IGNORE appointments SET company_phone = ? WHERE company_phone = ?').run(primaryAllowed, oldLid);
    db.prepare('UPDATE OR IGNORE shopping_items SET company_phone = ? WHERE company_phone = ?').run(primaryAllowed, oldLid);
    db.prepare('UPDATE OR IGNORE payments SET company_phone = ? WHERE company_phone = ?').run(primaryAllowed, oldLid);
  }
} catch (e) {
  // Ignorar errores en migración de LID
}

export const DEFAULT_COMPANY = {
  name: null,
  fiscalName: null,
  ownerName: null,
  cif: null,
  trade: 'Reformas y Construcción',
  address: null,
  city: null,
  workingHours: null,
  paymentTerms: null,
  quoteValidityDays: 15,
  entityType: 'autonomo',
  irpfRate: 0,
  invoiceSeries: '2026-',
  phone: null,
  email: null,
  iban: null,
  bizum: null,
  logoPath: null,
  gestoriaEmail: null,
  defaultTaxRate: 10,
  defaultAdvance: 30,
  onboardingStep: null,
  onboardingDataJson: null,
  isConfigured: false
};

// ─── Métodos de Empresa ───────────────────────────────────────────────────────

export function getCompany(phone) {
  if (!phone) return { ...DEFAULT_COMPANY, isConfigured: false };
  if (typeof phone === 'string' && isUuid(phone)) {
    return getCompanyById(phone) || { ...DEFAULT_COMPANY, id: phone, companyId: phone, isConfigured: false };
  }
  const cleanPhone = String(phone).replace(/\D/g, '');
  const stmt = db.prepare('SELECT * FROM companies WHERE phone = ?');
  const row = stmt.get(cleanPhone);
  if (!row) {
    return { ...DEFAULT_COMPANY, phone: cleanPhone, isConfigured: false };
  }
  return {
    id: row.id || null,
    companyId: row.id || null,
    phone: row.phone,
    name: row.name || null,
    fiscalName: row.fiscal_name || row.name || null,
    ownerName: row.owner_name || null,
    cif: row.cif || null,
    trade: row.trade || DEFAULT_COMPANY.trade,
    address: row.address || null,
    city: row.city || null,
    workingHours: row.working_hours || null,
    paymentTerms: row.payment_terms || null,
    quoteValidityDays: row.quote_validity_days !== null && row.quote_validity_days !== undefined ? row.quote_validity_days : 15,
    entityType: row.entity_type || 'autonomo',
    irpfRate: row.irpf_rate !== null && row.irpf_rate !== undefined ? row.irpf_rate : 0,
    invoiceSeries: row.invoice_series || '2026-',
    phone: row.phone_contact || cleanPhone,
    email: row.email || null,
    iban: row.iban ? row.iban : null,
    bizum: row.bizum ? row.bizum : null,
    logoPath: row.logo_path || null,
    gestoriaEmail: row.gestoria_email || null,
    defaultTaxRate: row.default_tax_rate !== null && row.default_tax_rate !== undefined ? row.default_tax_rate : 10,
    defaultAdvance: row.default_advance !== null && row.default_advance !== undefined ? row.default_advance : 30,
    onboardingStep: row.onboarding_step || null,
    onboardingDataJson: row.onboarding_data_json || null,
    isConfigured: Boolean(row.name && row.cif && !row.onboarding_step)
  };
}

export function getCompanyById(companyId) {
  if (!companyId) return null;
  const stmt = db.prepare('SELECT phone FROM companies WHERE id = ?');
  const row = stmt.get(companyId);
  if (!row) return null;
  return getCompany(row.phone);
}

export function saveCompany(phone, data = {}) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const existing = getCompany(cleanPhone);
  const now = new Date().toISOString();
  const companyId = data.id || data.companyId || existing.id || crypto.randomUUID();

  const name = data.name !== undefined ? data.name : existing.name;
  const fiscalName = data.fiscalName !== undefined ? data.fiscalName : existing.fiscalName;
  const ownerName = data.ownerName !== undefined ? data.ownerName : existing.ownerName;
  const cif = data.cif !== undefined ? data.cif : existing.cif;
  const trade = data.trade !== undefined ? data.trade : (existing.trade || DEFAULT_COMPANY.trade);
  const address = data.address !== undefined ? data.address : existing.address;
  const city = data.city !== undefined ? data.city : existing.city;
  const workingHours = data.workingHours !== undefined ? data.workingHours : existing.workingHours;
  const paymentTerms = data.paymentTerms !== undefined ? data.paymentTerms : existing.paymentTerms;
  const quoteValidityDays = data.quoteValidityDays !== undefined ? data.quoteValidityDays : existing.quoteValidityDays;
  const entityType = data.entityType !== undefined ? data.entityType : existing.entityType;
  const irpfRate = data.irpfRate !== undefined ? data.irpfRate : existing.irpfRate;
  const invoiceSeries = data.invoiceSeries !== undefined ? data.invoiceSeries : existing.invoiceSeries;
  const phoneContact = data.phone !== undefined ? data.phone : (existing.phone || cleanPhone);
  const email = data.email !== undefined ? data.email : existing.email;
  const iban = data.iban !== undefined ? data.iban : (existing.iban || null);
  const bizum = data.bizum !== undefined ? data.bizum : (existing.bizum || null);
  const logoPath = data.logoPath !== undefined ? data.logoPath : existing.logoPath;
  const gestoriaEmail = data.gestoriaEmail !== undefined ? data.gestoriaEmail : existing.gestoriaEmail;
  const defaultTaxRate = data.defaultTaxRate !== undefined ? data.defaultTaxRate : existing.defaultTaxRate;
  const defaultAdvance = data.defaultAdvance !== undefined ? data.defaultAdvance : existing.defaultAdvance;
  const onboardingStep = data.onboardingStep !== undefined ? data.onboardingStep : existing.onboardingStep;
  const onboardingDataJson = data.onboardingDataJson !== undefined ? data.onboardingDataJson : existing.onboardingDataJson;

  const stmt = db.prepare(`
    INSERT INTO companies (
      id, phone, name, fiscal_name, owner_name, cif, trade, address, city, working_hours,
      payment_terms, quote_validity_days, entity_type, irpf_rate, invoice_series,
      phone_contact, email, iban, bizum, logo_path, gestoria_email, default_tax_rate,
      default_advance, onboarding_step, onboarding_data_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      id = COALESCE(companies.id, excluded.id),
      name = excluded.name,
      fiscal_name = excluded.fiscal_name,
      owner_name = excluded.owner_name,
      cif = excluded.cif,
      trade = excluded.trade,
      address = excluded.address,
      city = excluded.city,
      working_hours = excluded.working_hours,
      payment_terms = excluded.payment_terms,
      quote_validity_days = excluded.quote_validity_days,
      entity_type = excluded.entity_type,
      irpf_rate = excluded.irpf_rate,
      invoice_series = excluded.invoice_series,
      phone_contact = excluded.phone_contact,
      email = excluded.email,
      iban = excluded.iban,
      bizum = excluded.bizum,
      logo_path = excluded.logo_path,
      gestoria_email = excluded.gestoria_email,
      default_tax_rate = excluded.default_tax_rate,
      default_advance = excluded.default_advance,
      onboarding_step = excluded.onboarding_step,
      onboarding_data_json = excluded.onboarding_data_json,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    companyId, cleanPhone, name, fiscalName, ownerName, cif, trade, address, city, workingHours,
    paymentTerms, quoteValidityDays, entityType, irpfRate, invoiceSeries,
    phoneContact, email, iban, bizum, logoPath, gestoriaEmail, defaultTaxRate,
    defaultAdvance, onboardingStep, onboardingDataJson, now, now
  );

  // Sincronizar automáticamente channel_identity, user y membership
  try {
    const chExisting = db.prepare('SELECT id FROM channel_identities WHERE channel = ? AND channel_identifier = ?').get('whatsapp', cleanPhone);
    if (!chExisting) {
      db.prepare(`
        INSERT INTO channel_identities (id, company_id, channel, channel_identifier, is_active, created_at, updated_at)
        VALUES (?, ?, 'whatsapp', ?, 1, ?, ?)
      `).run(crypto.randomUUID(), companyId, cleanPhone, now, now);
    }

    let user = db.prepare('SELECT id FROM users WHERE phone = ?').get(cleanPhone);
    let userId = user ? user.id : null;
    if (!userId) {
      userId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (id, name, email, phone, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
      `).run(userId, ownerName || name || 'Propietario', email, cleanPhone, now, now);
    }

    const memExisting = db.prepare('SELECT id FROM memberships WHERE user_id = ? AND company_id = ?').get(userId, companyId);
    if (!memExisting) {
      db.prepare(`
        INSERT INTO memberships (id, user_id, company_id, role, status, created_at, updated_at)
        VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?, ?)
      `).run(crypto.randomUUID(), userId, companyId, now, now);
    }
  } catch (syncErr) {
    // Sincronización silenciosa en caso de que aún no existan las tablas (p. ej. pre-migración)
  }

  return getCompany(cleanPhone);
}

// ─── Métodos de Presupuestos (Tenant-Scoped por company_id) ──────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(val) {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

/**
 * Resuelve el tenant canónico (companyId y phone) a partir de:
 * - un authenticatedContext ({ companyId, company: { phone } })
 * - un companyId (UUID)
 * - un teléfono legacy (resuelve contra companies para obtener su company_id canónico)
 */
export function resolveCompanyTenant(companyContextOrIdOrPhone) {
  if (!companyContextOrIdOrPhone) return null;

  // Si es un authenticatedContext
  if (typeof companyContextOrIdOrPhone === 'object') {
    const companyId = companyContextOrIdOrPhone.companyId || companyContextOrIdOrPhone.id || null;
    let phone = companyContextOrIdOrPhone.company?.phone || companyContextOrIdOrPhone.phone || '';
    if (!phone && companyId && isUuid(companyId)) {
      const row = db.prepare('SELECT phone FROM companies WHERE id = ?').get(companyId);
      if (row) phone = row.phone;
    }
    const cleanPhone = String(phone).replace(/\D/g, '');
    return { companyId, phone: cleanPhone };
  }

  const str = String(companyContextOrIdOrPhone).trim();

  // Si es un UUID
  if (isUuid(str)) {
    const comp = getCompanyById(str);
    return { companyId: str, phone: comp ? String(comp.phone).replace(/\D/g, '') : '' };
  }

  // Si es un teléfono plano (modo legacy)
  const cleanPhone = str.replace(/\D/g, '');
  const comp = getCompany(cleanPhone);
  return { companyId: comp?.id || comp?.companyId || null, phone: cleanPhone };
}

/**
 * Resuelve el business_id legacy (normalizado a dígitos) a partir del tenant canónico:
 * - Recibe companyId (UUID) o companyContext.
 * - Comprueba que la compañía existe en la tabla companies.
 * - Obtiene internamente companies.phone.
 * - Aplica la normalización legacy existente (replace(/\D/g, '')).
 * - Devuelve el business_id legacy.
 * - NO acepta business_id externo para autorizar.
 * - NO modifica DB ni crea compañías.
 * - Soporta llamadas de compatibilidad heredada que pasan el teléfono de una compañía registrada.
 *
 * @param {object|string} companyContextOrId
 * @returns {string|null}
 */
export function resolveLegacyBusinessId(companyContextOrId) {
  if (!companyContextOrId) return null;

  let companyId = null;
  if (typeof companyContextOrId === 'object') {
    companyId = companyContextOrId.companyId || companyContextOrId.id || null;
    if (!companyId && companyContextOrId.company?.phone) {
      const clean = String(companyContextOrId.company.phone).replace(/\D/g, '');
      const row = db.prepare('SELECT phone FROM companies WHERE phone = ?').get(clean);
      return row ? String(row.phone).replace(/\D/g, '') : null;
    }
    if (!companyId && companyContextOrId.phone) {
      const clean = String(companyContextOrId.phone).replace(/\D/g, '');
      const row = db.prepare('SELECT phone FROM companies WHERE phone = ?').get(clean);
      return row ? String(row.phone).replace(/\D/g, '') : null;
    }
  } else if (typeof companyContextOrId === 'string') {
    const trimmed = companyContextOrId.trim();
    if (isUuid(trimmed)) {
      companyId = trimmed;
    } else {
      // Compatibilidad legacy: buscar si el teléfono corresponde a una compañía existente
      const clean = trimmed.replace(/\D/g, '');
      if (!clean) return null;
      const row = db.prepare('SELECT phone FROM companies WHERE phone = ?').get(clean);
      return row ? String(row.phone).replace(/\D/g, '') : null;
    }
  }

  if (!companyId) return null;

  const row = db.prepare('SELECT phone FROM companies WHERE id = ?').get(companyId);
  if (!row || !row.phone) return null;
  return String(row.phone).replace(/\D/g, '');
}


export function saveBudget(companyContextOrIdOrPhone, budget) {
  if (!budget || !budget.id) return null;
  if (!companyContextOrIdOrPhone) {
    throw new Error("❌ [Tenant Boundary] saveBudget requiere un companyId o contexto autenticado obligatorio.");
  }

  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId || null;
  const cleanPhone = tenant?.phone || (typeof companyContextOrIdOrPhone === 'string' ? companyContextOrIdOrPhone.replace(/\D/g, '') : '');

  const now = new Date().toISOString();
  const total = budget.financials?.totalAmount || budget.totals?.total || budget.totalAmount || 0;

  const cleanBudget = {
    id: budget.id,
    companyId: companyId,
    company_id: companyId,
    issueDate: budget.issueDate,
    company: budget.company,
    client: budget.client,
    items: budget.items,
    financials: budget.financials || { totalAmount: total },
    terms: budget.terms,
    payments: budget.payments || [],
    paymentSummary: budget.paymentSummary || { totalPaid: 0, remainingBalance: total, status: 'PENDIENTE' },
    isDraft: budget.isDraft,
    status: budget.status || 'PENDIENTE_ACEPTACION',
    workMemory: budget.workMemory || {}
  };

  const stmt = db.prepare(`
    INSERT INTO budgets (id, company_id, company_phone, client_name, client_address, client_phone, total_amount, status, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_id = COALESCE(excluded.company_id, budgets.company_id),
      company_phone = COALESCE(excluded.company_phone, budgets.company_phone),
      client_name = excluded.client_name,
      client_address = excluded.client_address,
      client_phone = excluded.client_phone,
      total_amount = excluded.total_amount,
      status = excluded.status,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
    WHERE budgets.company_id = excluded.company_id 
       OR budgets.company_id IS NULL
       OR (budgets.company_phone = excluded.company_phone AND budgets.company_id IS NULL)
  `);

  stmt.run(
    budget.id,
    companyId,
    cleanPhone,
    budget.client?.name || 'Cliente Particular',
    budget.client?.address || '',
    budget.client?.phone || '',
    total,
    budget.status || 'PENDIENTE_ACEPTACION',
    JSON.stringify(cleanBudget),
    now,
    now
  );

  return cleanBudget;
}

export function updateBudget(companyContextOrIdOrPhone, budget) {
  if (!companyContextOrIdOrPhone || !budget || !budget.id) return null;
  const existing = getBudget(companyContextOrIdOrPhone, budget.id);
  if (!existing) {
    // Cross-tenant o inexistente: no revelar si existe en otra empresa
    return null;
  }
  return saveBudget(companyContextOrIdOrPhone, budget);
}

export function updateBudgetStatus(companyContextOrIdOrPhone, budgetId, status) {
  if (!companyContextOrIdOrPhone || !budgetId) return null;
  const budget = getBudget(companyContextOrIdOrPhone, budgetId);
  if (!budget) return null;
  budget.status = status;
  saveBudget(companyContextOrIdOrPhone, budget);
  return budget;
}

export function deleteBudget(companyContextOrIdOrPhone, id) {
  if (!companyContextOrIdOrPhone || !id) return { deleted: false };
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const phone = tenant?.phone;

  let result = { changes: 0 };
  if (companyId) {
    result = db.prepare('DELETE FROM budgets WHERE id = ? AND company_id = ?').run(id, companyId);
  } else if (phone) {
    result = db.prepare('DELETE FROM budgets WHERE id = ? AND company_phone = ?').run(id, phone);
  }

  return { deleted: result.changes > 0, id };
}

export async function syncPendingSignaturesFromCloud() {
  try {
    const stmt = db.prepare("SELECT id, company_phone, data_json FROM budgets WHERE status != 'ACEPTADO' AND status != 'FIRMADO'");
    const rows = stmt.all();
    if (!rows || rows.length === 0) return [];

    const newlyAccepted = [];

    await Promise.all(rows.map(async (row) => {
      try {
        const budgetId = row.id;
        const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
        let signInfo = null;

        // 1. Consultar el backend oficial de PresuVoz (Vercel)
        try {
          const vUrl = `https://presuvoz.vercel.app/api/sign?check=${encodeURIComponent(cleanId)}`;
          const vRes = await fetch(vUrl, { signal: AbortSignal.timeout(3500) });
          if (vRes.ok) {
            const vData = await vRes.json();
            if (vData && vData.alreadySigned && vData.details) {
              signInfo = vData.details;
            }
          }
        } catch (eVercel) {}

        // 2. Fallback a nube secundaria de sincronización
        if (!signInfo) {
          try {
            const url = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/presuvoz2026/signed_${encodeURIComponent(cleanId)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (res.ok) {
              const raw = await res.json();
              if (raw && typeof raw === 'string') {
                const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
                const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=');
                const decoded = Buffer.from(padded, 'base64').toString('utf-8');
                signInfo = JSON.parse(decoded);
              }
            }
          } catch (eKv) {}
        }

        if (signInfo && (signInfo.signed || signInfo.signedAt)) {
          let budgetObj = null;
          try { budgetObj = JSON.parse(row.data_json); } catch(e) {}
          if (budgetObj) {
            budgetObj.status = 'ACEPTADO';
            budgetObj.signedAt = signInfo.signedAt || new Date().toISOString();
            budgetObj.signedEmail = signInfo.clientEmail || '';
          }

          const now = new Date().toISOString();
          db.prepare(`
            UPDATE budgets
            SET status = 'ACEPTADO',
                updated_at = ?,
                data_json = ?
            WHERE id = ?
          `).run(now, JSON.stringify(budgetObj || { id: budgetId, status: 'ACEPTADO' }), budgetId);

          newlyAccepted.push({
            budgetId,
            clientName: signInfo.clientName || budgetObj?.client?.name || 'Cliente',
            companyPhone: row.company_phone,
            signedEmail: signInfo.clientEmail,
            signedAt: signInfo.signedAt
          });
        }
      } catch (err) {
        // Ignorar fallos de red en sondeos individuales
      }
    }));

    return newlyAccepted;
  } catch (e) {
    return [];
  }
}

export function getBudget(companyContextOrIdOrPhone, id) {
  // Manejo de llamada canónica tenant-scoped: getBudget(companyId, budgetId)
  if (id !== undefined && id !== null) {
    if (!companyContextOrIdOrPhone || !id) return null;
    const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
    const companyId = tenant?.companyId;
    const phone = tenant?.phone;

    let row = null;
    if (companyId) {
      // Búsqueda canónica estricta por company_id
      const stmt = db.prepare('SELECT data_json, company_id FROM budgets WHERE id = ? AND company_id = ?');
      row = stmt.get(id, companyId);
      // Fallback transitorio si el registro aún no ha sido migrado a company_id
      if (!row && phone) {
        const stmtLegacy = db.prepare('SELECT data_json, company_id FROM budgets WHERE id = ? AND company_phone = ? AND company_id IS NULL');
        row = stmtLegacy.get(id, phone);
      }
    } else if (phone) {
      // Búsqueda legacy por company_phone cuando no existe company_id
      const stmt = db.prepare('SELECT data_json, company_id FROM budgets WHERE id = ? AND company_phone = ?');
      row = stmt.get(id, phone);
    }

    if (!row) return null;
    try { return JSON.parse(row.data_json); } catch(e) { return null; }
  }

  // REGLA DE SEGURIDAD ESTRICTA:
  // Nunca debe existir una consulta de budget que dependa únicamente de budgetId sin tenant context
  console.warn("🛑 [Seguridad Tenant] getBudget invocado sin tenant context obligatorio. Retornando null.");
  return null;
}

export function listBudgets(companyContextOrIdOrPhone, limit = 20) {
  if (!companyContextOrIdOrPhone) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const phone = tenant?.phone;

  let rows = [];
  if (companyId) {
    const stmt = db.prepare('SELECT data_json FROM budgets WHERE company_id = ? ORDER BY updated_at DESC LIMIT ?');
    rows = stmt.all(companyId, limit);
  } else if (phone) {
    const stmt = db.prepare('SELECT data_json FROM budgets WHERE company_phone = ? ORDER BY updated_at DESC LIMIT ?');
    rows = stmt.all(phone, limit);
  }

  const results = [];
  for (const r of rows) {
    try { results.push(JSON.parse(r.data_json)); } catch(e) {}
  }
  return results;
}

// ─── Métodos de Facturas ──────────────────────────────────────────────────────

export function saveInvoice(companyContextOrIdOrPhone, invoice) {
  if (!invoice || !invoice.id) return null;
  if (!companyContextOrIdOrPhone) {
    throw new Error("❌ [Tenant Boundary] saveInvoice requiere un companyId o contexto autenticado obligatorio.");
  }

  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId || null;
  const cleanPhone = tenant?.phone || (typeof companyContextOrIdOrPhone === 'string' ? companyContextOrIdOrPhone.replace(/\D/g, '') : '');

  // Defensa activa contra inyección de companyId/company_id por parte de la IA o cliente
  if (invoice.companyId && companyId && invoice.companyId !== companyId) {
    console.warn(`⚠️ [DEFENSA ACTIVA] Intento de inyección de companyId detectado en factura: '${invoice.companyId}' ignorado. Se fuerza '${companyId}'.`);
  }
  if (invoice.company_id && companyId && invoice.company_id !== companyId) {
    console.warn(`⚠️ [DEFENSA ACTIVA] Intento de inyección de company_id detectado en factura: '${invoice.company_id}' ignorado. Se fuerza '${companyId}'.`);
  }
  invoice.companyId = companyId;
  invoice.company_id = companyId;

  // Defensa activa contra inyección de company_phone
  if (invoice.company_phone && cleanPhone && String(invoice.company_phone).replace(/\D/g, '') !== cleanPhone) {
    console.warn(`⚠️ [DEFENSA ACTIVA] Intento de inyección de company_phone detectado en factura: '${invoice.company_phone}' ignorado. Se fuerza '${cleanPhone}'.`);
    invoice.company_phone = cleanPhone;
  }

  // Validación estricta de la invariante con presupuestos (invoice.company_id == budget.company_id)
  const rawBudgetId = invoice.budgetId || invoice.budget_id || '';
  const budgetId = typeof rawBudgetId === 'string' ? rawBudgetId.trim() : '';

  if (budgetId) {
    const linkedBudget = getBudget(companyContextOrIdOrPhone, budgetId);
    if (!linkedBudget) {
      throw new Error(`❌ [Tenant Boundary] Violación de invariante: No se puede asociar la factura '${invoice.id}' al presupuesto '${budgetId}' porque no pertenece a la empresa autenticada o no existe.`);
    }
    const budgetCompId = linkedBudget.companyId || linkedBudget.company_id;
    if (budgetCompId && companyId && budgetCompId !== companyId) {
      throw new Error(`❌ [Tenant Boundary] Violación de invariante: La factura (${companyId}) y el presupuesto (${budgetCompId}) pertenecen a tenants distintos.`);
    }
  }

  const now = new Date().toISOString();
  const total = Number(invoice.financials?.totalAmount ?? invoice.total_amount ?? invoice.totalAmount ?? 0);

  const rectifiesId = invoice.rectifies_invoice_id || invoice.rectifiesInvoiceId || null;
  const fiscalPeriod = invoice.fiscal_period || invoice.fiscalPeriod || null;
  const verifactuHash = invoice.verifactu_hash || invoice.verifactuHash || null;

  const stmt = db.prepare(`
    INSERT INTO invoices (id, company_id, budget_id, company_phone, client_name, total_amount, status, data_json, rectifies_invoice_id, fiscal_period, verifactu_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_id = COALESCE(excluded.company_id, invoices.company_id),
      company_phone = COALESCE(excluded.company_phone, invoices.company_phone),
      budget_id = excluded.budget_id,
      client_name = excluded.client_name,
      total_amount = excluded.total_amount,
      status = excluded.status,
      data_json = excluded.data_json,
      rectifies_invoice_id = excluded.rectifies_invoice_id,
      fiscal_period = excluded.fiscal_period,
      verifactu_hash = excluded.verifactu_hash
    WHERE invoices.company_id = excluded.company_id 
       OR invoices.company_id IS NULL
       OR (invoices.company_phone = excluded.company_phone AND invoices.company_id IS NULL)
  `);

  invoice.rectifiesInvoiceId = rectifiesId;
  invoice.fiscalPeriod = fiscalPeriod;
  invoice.verifactuHash = verifactuHash;
  if (invoice.is_advance !== undefined) {
    invoice.isAdvance = Boolean(invoice.is_advance);
  }

  stmt.run(
    invoice.id,
    companyId,
    budgetId,
    cleanPhone,
    invoice.client?.name || invoice.client_name || 'Cliente Particular',
    total,
    invoice.status || 'PENDIENTE_PAGO',
    JSON.stringify(invoice),
    rectifiesId,
    fiscalPeriod,
    verifactuHash,
    now
  );
  return invoice;
}

export function updateInvoice(companyContextOrIdOrPhone, invoice) {
  if (!companyContextOrIdOrPhone || !invoice || !invoice.id) return null;
  const existing = getInvoice(companyContextOrIdOrPhone, invoice.id);
  if (!existing) {
    // Cross-tenant o inexistente: no revelar metadatos ni existencia
    return null;
  }
  return saveInvoice(companyContextOrIdOrPhone, invoice);
}

export function deleteInvoice(companyContextOrIdOrPhone, id) {
  if (!companyContextOrIdOrPhone || !id) return { deleted: false };
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const phone = tenant?.phone;

  let result = { changes: 0 };
  if (companyId) {
    result = db.prepare('DELETE FROM invoices WHERE id = ? AND company_id = ?').run(id, companyId);
  } else if (phone) {
    result = db.prepare('DELETE FROM invoices WHERE id = ? AND company_phone = ?').run(id, phone);
  }

  return { deleted: result.changes > 0, id };
}

export function getInvoice(companyContextOrIdOrPhone, id) {
  // Manejo de llamada canónica tenant-scoped: getInvoice(companyId, invoiceId)
  if (id !== undefined && id !== null) {
    if (!companyContextOrIdOrPhone || !id) return null;
    const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
    const companyId = tenant?.companyId;
    const phone = tenant?.phone;

    let row = null;
    if (companyId) {
      // Búsqueda canónica estricta por company_id
      const stmt = db.prepare('SELECT data_json, company_id FROM invoices WHERE id = ? AND company_id = ?');
      row = stmt.get(id, companyId);
      // Fallback transitorio si el registro aún no ha sido migrado a company_id
      if (!row && phone) {
        const stmtLegacy = db.prepare('SELECT data_json, company_id FROM invoices WHERE id = ? AND company_phone = ? AND company_id IS NULL');
        row = stmtLegacy.get(id, phone);
      }
    } else if (phone) {
      // Búsqueda legacy por company_phone cuando no existe company_id
      const stmt = db.prepare('SELECT data_json, company_id FROM invoices WHERE id = ? AND company_phone = ?');
      row = stmt.get(id, phone);
    }

    if (!row) return null;
    try { return JSON.parse(row.data_json); } catch(e) { return null; }
  }

  // REGLA DE SEGURIDAD ESTRICTA:
  // Nunca debe existir una consulta de factura que dependa únicamente de invoiceId sin tenant context
  console.warn("🛑 [Seguridad Tenant] getInvoice invocado sin tenant context obligatorio. Retornando null.");
  return null;
}

export function listInvoices(companyContextOrIdOrPhone, limit = 20) {
  if (!companyContextOrIdOrPhone) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const phone = tenant?.phone;

  let rows = [];
  if (companyId) {
    const stmt = db.prepare('SELECT data_json FROM invoices WHERE company_id = ? ORDER BY created_at DESC LIMIT ?');
    rows = stmt.all(companyId, limit);
  } else if (phone) {
    const stmt = db.prepare('SELECT data_json FROM invoices WHERE company_phone = ? ORDER BY created_at DESC LIMIT ?');
    rows = stmt.all(phone, limit);
  }

  const results = [];
  for (const r of rows) {
    try { results.push(JSON.parse(r.data_json)); } catch(e) {}
  }
  return results;
}

// ─── Métodos de Cobros ────────────────────────────────────────────────────────

/**
 * Inserción interna segura y validada de registros en payment_allocations.
 * Encapsula la validación de invariantes, tenant isolation y límites monetarios en céntimos enteros.
 * 
 * Invariante canónico: allocation.company_id == payment.company_id == invoice.company_id.
 * Validación de límites: SUM(allocations.amount) <= payment.amount (precisión de céntimos enteros).
 * 
 * @param {object} dbInstance - Instancia de SQLite
 * @param {object} params - Parámetros de asignación
 * @returns {string} ID de la asignación creada
 */
function insertPaymentAllocationInternal(dbInstance, { id, paymentId, invoiceId, companyId, amount, allocatedAt, now }) {
  if (!companyId) {
    throw new Error("❌ [Payment Allocation] company_id es obligatorio.");
  }
  const allocAmount = Number(amount);
  if (typeof allocAmount !== 'number' || isNaN(allocAmount) || allocAmount <= 0) {
    throw new Error("❌ [Payment Allocation] El importe de la asignación debe ser estrictamente positivo (> 0).");
  }

  // 1. Validar que el pago existe y pertenece al mismo company_id
  const paymentRow = dbInstance.prepare('SELECT id, company_id, amount FROM payments WHERE id = ?').get(paymentId);
  if (!paymentRow) {
    throw new Error(`❌ [Payment Allocation] El pago '${paymentId}' no existe.`);
  }
  if (paymentRow.company_id !== companyId) {
    throw new Error(`❌ [Payment Allocation] Invariante violada: payment.company_id ('${paymentRow.company_id}') != allocation.company_id ('${companyId}').`);
  }

  // 2. Validar que la factura existe y pertenece al mismo company_id
  const invoiceRow = dbInstance.prepare('SELECT id, company_id FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoiceRow) {
    throw new Error(`❌ [Payment Allocation] La factura '${invoiceId}' no existe.`);
  }
  if (invoiceRow.company_id !== companyId) {
    throw new Error(`❌ [Payment Allocation] Invariante violada: invoice.company_id ('${invoiceRow.company_id}') != allocation.company_id ('${companyId}').`);
  }

  // 3. Validar suma de allocations <= payment.amount (aritmética exacta en céntimos enteros)
  const existingAllocs = dbInstance.prepare(
    'SELECT id, amount FROM payment_allocations WHERE payment_id = ? AND company_id = ?'
  ).all(paymentId, companyId);

  const existingCents = existingAllocs.reduce((sum, a) => sum + Math.round(Number(a.amount) * 100), 0);
  const newCents = Math.round(allocAmount * 100);
  const paymentTotalCents = Math.round(Number(paymentRow.amount || 0) * 100);

  if (existingCents + newCents > paymentTotalCents) {
    const excessEur = ((existingCents + newCents - paymentTotalCents) / 100).toFixed(2);
    throw new Error(
      `❌ [Payment Allocation] Superación de importe: La suma de asignaciones (${(existingCents + newCents)/100} €) supera el total del pago (${paymentTotalCents/100} €) en ${excessEur} €.`
    );
  }

  const allocId = id || `ALLOC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const allocTimestamp = allocatedAt || now;

  dbInstance.prepare(`
    INSERT INTO payment_allocations (id, payment_id, invoice_id, company_id, amount, allocated_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(allocId, paymentId, invoiceId, companyId, allocAmount, allocTimestamp, now, now);

  return allocId;
}

export function savePayment(companyContextOrIdOrPhone, paymentOrBudgetId, maybePayment) {
  if (!companyContextOrIdOrPhone) {
    throw new Error("❌ [Tenant Boundary] savePayment requiere un companyId o contexto autenticado obligatorio.");
  }

  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId || null;
  const cleanPhone = tenant?.phone || (typeof companyContextOrIdOrPhone === 'string' ? companyContextOrIdOrPhone.replace(/\D/g, '') : '');

  let payment = maybePayment || paymentOrBudgetId;
  let targetId = maybePayment ? paymentOrBudgetId : (payment?.targetId || payment?.budgetId || payment?.invoiceId || '');
  if (!payment) return null;
  const pId = payment.id || `PAY-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const now = new Date().toISOString();

  // Defensa activa contra inyección de companyId / company_phone
  if (payment.companyId && companyId && payment.companyId !== companyId) {
    console.warn(`⚠️ [DEFENSA ACTIVA] Intento de inyección de companyId detectado en pago: '${payment.companyId}' ignorado. Se fuerza '${companyId}'.`);
  }
  if (payment.company_id && companyId && payment.company_id !== companyId) {
    console.warn(`⚠️ [DEFENSA ACTIVA] Intento de inyección de company_id detectado en pago: '${payment.company_id}' ignorado. Se fuerza '${companyId}'.`);
  }
  payment.companyId = companyId;
  payment.company_id = companyId;

  if (payment.company_phone && cleanPhone && String(payment.company_phone).replace(/\D/g, '') !== cleanPhone) {
    console.warn(`⚠️ [DEFENSA ACTIVA] Intento de inyección de company_phone detectado en pago: '${payment.company_phone}' ignorado. Se fuerza '${cleanPhone}'.`);
  }
  payment.company_phone = cleanPhone;

  payment.id = pId;
  payment.budgetId = targetId;

  // Validación de relación con targetId (si targetId es factura o presupuesto)
  let linkedInvoice = null;
  if (targetId) {
    linkedInvoice = getInvoice(companyContextOrIdOrPhone, targetId);
    if (!linkedInvoice) {
      // Verificar si targetId pertenece a una factura de OTRA empresa (intento cross-tenant)
      const foreignInv = db.prepare('SELECT id, company_id FROM invoices WHERE id = ?').get(targetId);
      if (foreignInv && foreignInv.company_id !== companyId) {
        throw new Error(`❌ [Tenant Boundary] Violación de aislamiento: No se puede asociar el pago a la factura '${targetId}' de otra empresa.`);
      }
      // Verificar si targetId pertenece a un presupuesto de OTRA empresa (intento cross-tenant)
      const foreignBud = db.prepare('SELECT id, company_id FROM budgets WHERE id = ?').get(targetId);
      if (foreignBud && foreignBud.company_id !== companyId) {
        throw new Error(`❌ [Tenant Boundary] Violación de aislamiento: No se puede asociar el pago al presupuesto '${targetId}' de otra empresa.`);
      }
    }
  }

  // Si está asociado a una factura en invoices, actualizar sus pagos dentro de data_json (retrocompatibilidad)
  if (linkedInvoice) {
    try {
      if (!linkedInvoice.payments) linkedInvoice.payments = [];
      linkedInvoice.payments.push({
        id: pId,
        amount: Number(payment.amount || 0),
        date: payment.date || now.split('T')[0],
        method: payment.method || 'Transferencia',
        concept: payment.concept || ''
      });
      db.prepare('UPDATE invoices SET data_json = ? WHERE id = ? AND company_id = ?').run(
        JSON.stringify(linkedInvoice), targetId, companyId
      );
    } catch (e) {}
  }

  // DEUDA TÉCNICA DOCUMENTADA (Fase 2B-3):
  // La columna legacy 'payments.budget_id' tiene una semántica ambigua porque históricamente
  // ha almacenado tanto budget_id (PRE-...) como invoice_id (INV-...).
  // La nueva arquitectura formal desacopla los cobros de las facturas a través de la tabla
  // canónica 'payment_allocations', donde la relación con la factura se almacena unívocamente
  // en la columna 'invoice_id'. Se mantiene 'payments.budget_id' estrictamente por retrocompatibilidad.
  const stmt = db.prepare(`
    INSERT INTO payments (id, company_id, budget_id, company_phone, amount, method, concept, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_id = COALESCE(excluded.company_id, payments.company_id),
      company_phone = COALESCE(excluded.company_phone, payments.company_phone),
      budget_id = excluded.budget_id,
      amount = excluded.amount,
      method = excluded.method,
      concept = excluded.concept,
      data_json = excluded.data_json
    WHERE payments.company_id = excluded.company_id 
       OR payments.company_id IS NULL
       OR (payments.company_phone = excluded.company_phone AND payments.company_id IS NULL)
  `);

  // Ejecución transaccional estrictamente atómica
  db.exec('BEGIN IMMEDIATE;');
  try {
    stmt.run(
      pId,
      companyId,
      targetId,
      cleanPhone,
      Number(payment.amount || 0),
      payment.method || 'Bizum',
      payment.concept || '',
      JSON.stringify(payment),
      now
    );

    // Si targetId es una factura legítima del tenant y el importe es estrictamente positivo (> 0),
    // registrar automáticamente su allocation inicial si no existe previamente
    if (linkedInvoice && companyId && Number(payment.amount || 0) > 0) {
      const existingAlloc = db.prepare('SELECT id FROM payment_allocations WHERE payment_id = ? AND invoice_id = ?').get(pId, linkedInvoice.id);
      if (!existingAlloc) {
        const allocId = `ALLOC-${pId}`;
        insertPaymentAllocationInternal(db, {
          id: allocId,
          paymentId: pId,
          invoiceId: linkedInvoice.id,
          companyId,
          amount: Number(payment.amount || 0),
          allocatedAt: now,
          now
        });
      }
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return payment;
}

export function getPayment(companyContextOrIdOrPhone, id) {
  if (id !== undefined && id !== null) {
    if (!companyContextOrIdOrPhone || !id) return null;
    const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
    const companyId = tenant?.companyId;
    const phone = tenant?.phone;

    let row = null;
    if (companyId) {
      row = db.prepare('SELECT data_json, company_id FROM payments WHERE id = ? AND company_id = ?').get(id, companyId);
      if (!row && phone) {
        row = db.prepare('SELECT data_json, company_id FROM payments WHERE id = ? AND company_phone = ? AND company_id IS NULL').get(id, phone);
      }
    } else if (phone) {
      row = db.prepare('SELECT data_json, company_id FROM payments WHERE id = ? AND company_phone = ?').get(id, phone);
    }

    if (!row) return null;
    try { return JSON.parse(row.data_json); } catch(e) { return null; }
  }

  console.warn("🛑 [Seguridad Tenant] getPayment invocado sin tenant context obligatorio. Retornando null.");
  return null;
}

export function listPayments(companyContextOrIdOrPhone, limit = 50) {
  if (!companyContextOrIdOrPhone) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const phone = tenant?.phone;

  let rows = [];
  if (companyId) {
    rows = db.prepare('SELECT data_json FROM payments WHERE company_id = ? ORDER BY created_at DESC LIMIT ?').all(companyId, limit);
  } else if (phone) {
    rows = db.prepare('SELECT data_json FROM payments WHERE company_phone = ? ORDER BY created_at DESC LIMIT ?').all(phone, limit);
  }

  const results = [];
  for (const r of rows) {
    try { results.push(JSON.parse(r.data_json)); } catch(e) {}
  }
  return results;
}

export function updatePayment(companyContextOrIdOrPhone, payment) {
  if (!companyContextOrIdOrPhone || !payment || !payment.id) return null;
  const existing = getPayment(companyContextOrIdOrPhone, payment.id);
  if (!existing) return null;
  return savePayment(companyContextOrIdOrPhone, payment);
}

export function deletePayment(companyContextOrIdOrPhone, id) {
  if (!companyContextOrIdOrPhone || !id) return { deleted: false };
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const phone = tenant?.phone;

  let result = { changes: 0 };
  if (companyId) {
    result = db.prepare('DELETE FROM payments WHERE id = ? AND company_id = ?').run(id, companyId);
  } else if (phone) {
    result = db.prepare('DELETE FROM payments WHERE id = ? AND company_phone = ?').run(id, phone);
  }

  return { deleted: result.changes > 0, id };
}

export function getPayments(companyContextOrIdOrPhone, maybeBudgetId) {
  let budgetId = maybeBudgetId !== undefined ? maybeBudgetId : companyContextOrIdOrPhone;
  let companyContext = maybeBudgetId !== undefined ? companyContextOrIdOrPhone : null;

  if (companyContext) {
    const tenant = resolveCompanyTenant(companyContext);
    const companyId = tenant?.companyId;
    if (companyId) {
      const stmt = db.prepare('SELECT data_json FROM payments WHERE budget_id = ? AND company_id = ? ORDER BY created_at ASC');
      const rows = stmt.all(budgetId, companyId);
      const results = [];
      for (const r of rows) {
        try { results.push(JSON.parse(r.data_json)); } catch(e) {}
      }
      return results;
    }
  }

  const stmt = db.prepare('SELECT data_json FROM payments WHERE budget_id = ? ORDER BY created_at ASC');
  const rows = stmt.all(budgetId);
  const results = [];
  for (const r of rows) {
    try { results.push(JSON.parse(r.data_json)); } catch(e) {}
  }
  return results;
}

// ─── Métodos de Payment Allocations (Aplicación de Cobros a Facturas) ────────

export function createPaymentAllocation(companyContextOrIdOrPhone, allocationData) {
  if (!companyContextOrIdOrPhone) {
    throw new Error("❌ [Tenant Boundary] createPaymentAllocation requiere un companyId o contexto autenticado obligatorio.");
  }
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  if (!companyId) {
    throw new Error("❌ [Tenant Boundary] No se pudo resolver companyId para la asignación.");
  }

  const paymentId = allocationData.paymentId || allocationData.payment_id;
  const invoiceId = allocationData.invoiceId || allocationData.invoice_id;
  const amount = Number(allocationData.amount);

  // 1. Validar importe positivo
  if (isNaN(amount) || amount <= 0) {
    throw new Error("❌ [Payment Allocation] El importe de la asignación debe ser un número positivo mayor que cero.");
  }

  // 2. Obtener y validar payment en el tenant autenticado
  const payment = getPayment(companyContextOrIdOrPhone, paymentId);
  if (!payment) {
    const foreignPayment = db.prepare('SELECT id, company_id FROM payments WHERE id = ?').get(paymentId);
    if (foreignPayment && foreignPayment.company_id !== companyId) {
      throw new Error(`❌ [Tenant Boundary] Violación de aislamiento: El pago '${paymentId}' pertenece a otra empresa.`);
    }
    throw new Error(`❌ [Payment Allocation] Pago '${paymentId}' no encontrado en la empresa autenticada.`);
  }

  // 3. Obtener y validar invoice en el tenant autenticado
  const invoice = getInvoice(companyContextOrIdOrPhone, invoiceId);
  if (!invoice) {
    const foreignInvoice = db.prepare('SELECT id, company_id FROM invoices WHERE id = ?').get(invoiceId);
    if (foreignInvoice && foreignInvoice.company_id !== companyId) {
      throw new Error(`❌ [Tenant Boundary] Violación de aislamiento: La factura '${invoiceId}' pertenece a otra empresa.`);
    }
    throw new Error(`❌ [Payment Allocation] Factura '${invoiceId}' no encontrada en la empresa autenticada.`);
  }

  // Invariantes estrictas
  if (payment.companyId && payment.companyId !== companyId) {
    throw new Error("❌ [Payment Allocation] Invariante violada: payment.company_id != allocation.company_id.");
  }
  if (invoice.companyId && invoice.companyId !== companyId) {
    throw new Error("❌ [Payment Allocation] Invariante violada: invoice.company_id != allocation.company_id.");
  }

  // 4. Validar suma de allocations <= payment.amount (utilizando aritmética entera en céntimos)
  const existingAllocs = db.prepare(`
    SELECT id, amount FROM payment_allocations 
    WHERE payment_id = ? AND company_id = ?
  `).all(paymentId, companyId);

  const existingCents = existingAllocs.reduce((sum, a) => sum + Math.round(Number(a.amount) * 100), 0);
  const newCents = Math.round(amount * 100);
  const paymentTotalCents = Math.round(Number(payment.amount || 0) * 100);

  if (existingCents + newCents > paymentTotalCents) {
    const excessEur = ((existingCents + newCents - paymentTotalCents) / 100).toFixed(2);
    throw new Error(
      `❌ [Payment Allocation] Superación de importe: La suma de asignaciones (${(existingCents + newCents)/100} €) supera el total del pago (${paymentTotalCents/100} €) en ${excessEur} €.`
    );
  }

  // 5. Inserción atómica transaccional
  const allocId = allocationData.id || `ALLOC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const now = new Date().toISOString();
  const allocatedAt = allocationData.allocatedAt || allocationData.allocated_at || now;

  db.exec('BEGIN IMMEDIATE;');
  try {
    insertPaymentAllocationInternal(db, {
      id: allocId,
      paymentId,
      invoiceId,
      companyId,
      amount,
      allocatedAt,
      now
    });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    id: allocId,
    paymentId,
    invoiceId,
    companyId,
    amount,
    allocatedAt,
    createdAt: now,
    updatedAt: now
  };
}

export function getPaymentAllocation(companyContextOrIdOrPhone, id) {
  if (id !== undefined && id !== null) {
    if (!companyContextOrIdOrPhone || !id) return null;
    const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
    const companyId = tenant?.companyId;
    if (!companyId) return null;

    const row = db.prepare('SELECT * FROM payment_allocations WHERE id = ? AND company_id = ?').get(id, companyId);
    if (!row) return null;
    return {
      id: row.id,
      paymentId: row.payment_id,
      invoiceId: row.invoice_id,
      companyId: row.company_id,
      amount: row.amount,
      allocatedAt: row.allocated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  console.warn("🛑 [Seguridad Tenant] getPaymentAllocation invocado sin tenant context obligatorio. Retornando null.");
  return null;
}

export function listPaymentAllocations(companyContextOrIdOrPhone, filter = {}) {
  if (!companyContextOrIdOrPhone) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  if (!companyId) return [];

  let query = 'SELECT * FROM payment_allocations WHERE company_id = ?';
  const params = [companyId];

  if (filter.paymentId || filter.payment_id) {
    query += ' AND payment_id = ?';
    params.push(filter.paymentId || filter.payment_id);
  }
  if (filter.invoiceId || filter.invoice_id) {
    query += ' AND invoice_id = ?';
    params.push(filter.invoiceId || filter.invoice_id);
  }

  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);
  return rows.map(row => ({
    id: row.id,
    paymentId: row.payment_id,
    invoiceId: row.invoice_id,
    companyId: row.company_id,
    amount: row.amount,
    allocatedAt: row.allocated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function deletePaymentAllocation(companyContextOrIdOrPhone, id) {
  if (!companyContextOrIdOrPhone || !id) return { deleted: false };
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  if (!companyId) return { deleted: false };

  const result = db.prepare('DELETE FROM payment_allocations WHERE id = ? AND company_id = ?').run(id, companyId);
  return { deleted: result.changes > 0, id };
}

// ─── Métodos de Trimestres y Gestoría ──────────────────────────────────────────

/**
 * Obtiene las facturas emitidas de un trimestre y calcula los agregados fiscales
 * @param {string} phone - Teléfono de la empresa
 * @param {number|string} [quarterInput] - 1, 2, 3, 4 o '1T', '2T', etc.
 * @param {number|string} [yearInput] - Año (ej: 2026)
 * @returns {object} Datos del trimestre con facturas y resumen para Modelo 303
 */
export function getQuarterInvoices(phoneOrCompany, quarterInput = null, yearInput = null) {
  const tenant = resolveCompanyTenant(phoneOrCompany);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone || (typeof phoneOrCompany === 'string' ? phoneOrCompany.replace(/\D/g, '') : '');
  const now = new Date();
  let currentYear = now.getFullYear();
  let currentMonth = now.getMonth(); // 0 a 11

  // Determinar trimestre por defecto si no se especifica
  let quarter = 3;
  if (!quarterInput) {
    // Si estamos en los primeros 20 días de abril, julio, octubre o enero, priorizar el trimestre que se liquida
    const day = now.getDate();
    if (currentMonth === 3 && day <= 20) {
      quarter = 1;
    } else if (currentMonth === 6 && day <= 20) {
      quarter = 2;
    } else if (currentMonth === 9 && day <= 20) {
      quarter = 3;
    } else if (currentMonth === 0 && day <= 20) {
      quarter = 4;
      currentYear -= 1;
    } else {
      quarter = Math.floor(currentMonth / 3) + 1;
    }
  } else {
    const qStr = String(quarterInput).toUpperCase();
    if (qStr.includes('1')) quarter = 1;
    else if (qStr.includes('2')) quarter = 2;
    else if (qStr.includes('3')) quarter = 3;
    else if (qStr.includes('4')) quarter = 4;
  }

  const year = yearInput ? parseInt(yearInput, 10) : currentYear;

  // Fechas límites del trimestre
  let startMonth = 0;
  let endMonth = 2;
  let endDay = 31;
  if (quarter === 2) {
    startMonth = 3;
    endMonth = 5;
    endDay = 30;
  } else if (quarter === 3) {
    startMonth = 6;
    endMonth = 8;
    endDay = 30;
  } else if (quarter === 4) {
    startMonth = 9;
    endMonth = 11;
    endDay = 31;
  }

  const startDate = new Date(year, startMonth, 1, 0, 0, 0);
  const endDate = new Date(year, endMonth, endDay, 23, 59, 59, 999);

  const startStr = `01/${String(startMonth + 1).padStart(2, '0')}/${year}`;
  const endStr = `${String(endDay).padStart(2, '0')}/${String(endMonth + 1).padStart(2, '0')}/${year}`;

  // Consultar todas las facturas de la empresa
  let rows = [];
  if (companyId) {
    rows = db.prepare('SELECT data_json, created_at FROM invoices WHERE company_id = ? ORDER BY created_at ASC').all(companyId);
  } else if (cleanPhone) {
    rows = db.prepare('SELECT data_json, created_at FROM invoices WHERE company_phone = ? ORDER BY created_at ASC').all(cleanPhone);
  }

  const quarterInvoices = [];
  for (const r of rows) {
    try {
      const inv = JSON.parse(r.data_json);
      if (!inv || !inv.id) continue;

      let invDate = null;
      if (r.created_at) {
        invDate = new Date(r.created_at);
      } else if (inv.issueDate) {
        const parts = inv.issueDate.split('/');
        if (parts.length === 3) {
          invDate = new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
        }
      }

      // Si la fecha cae dentro del trimestre o si no tiene fecha pero el id contiene el año y coincide
      if (invDate && !isNaN(invDate.getTime())) {
        if (invDate >= startDate && invDate <= endDate) {
          quarterInvoices.push(inv);
        }
      } else if (inv.id && inv.id.includes(String(year))) {
        quarterInvoices.push(inv);
      }
    } catch (e) {}
  }

  // Calcular agregados económicos y fiscales (Modelo 303)
  let totalInvoices = quarterInvoices.length;
  let totalTaxableBase = 0;
  let totalTaxAmount = 0;
  let base10 = 0;
  let tax10 = 0;
  let base21 = 0;
  let tax21 = 0;
  let totalAmount = 0;
  let totalPaid = 0;
  let totalRemaining = 0;
  let paidCount = 0;
  let pendingCount = 0;

  for (const inv of quarterInvoices) {
    const fin = inv.financials || {};
    const base = Number(fin.taxableBase || 0);
    const tax = Number(fin.taxAmount || 0);
    const tot = Number(fin.totalAmount || 0);
    const rate = Math.round(Number(fin.taxRatePercentage || 10));
    const advance = Number(fin.advanceAmount || 0);
    const remaining = fin.remainingAmount !== undefined ? Number(fin.remainingAmount) : Math.max(0, tot - advance);

    totalTaxableBase += base;
    totalTaxAmount += tax;
    totalAmount += tot;

    if (rate === 10) {
      base10 += base;
      tax10 += tax;
    } else if (rate === 21) {
      base21 += base;
      tax21 += tax;
    }

    if (inv.status === 'PAGADA' || remaining <= 0) {
      totalPaid += tot;
      paidCount++;
    } else {
      totalPaid += advance;
      totalRemaining += remaining;
      pendingCount++;
    }
  }

  return {
    quarter,
    year,
    quarterLabel: `${quarter}T ${year}`,
    startDate,
    endDate,
    startDateFormatted: startStr,
    endDateFormatted: endStr,
    invoices: quarterInvoices,
    summary: {
      totalInvoices,
      totalTaxableBase: Number(totalTaxableBase.toFixed(2)),
      totalTaxAmount: Number(totalTaxAmount.toFixed(2)),
      base10: Number(base10.toFixed(2)),
      tax10: Number(tax10.toFixed(2)),
      base21: Number(base21.toFixed(2)),
      tax21: Number(tax21.toFixed(2)),
      totalAmount: Number(totalAmount.toFixed(2)),
      totalPaid: Number(totalPaid.toFixed(2)),
      totalRemaining: Number(totalRemaining.toFixed(2)),
      paidCount,
      pendingCount
    }
  };
}

/**
 * Genera el contenido del archivo CSV en formato estándar para gestorías españolas
 * Delimitador: ';' | Codificación: UTF-8 con BOM (\uFEFF) | Números con coma decimal
 */
export function generateQuarterCSV(company, quarterData) {
  const BOM = '\uFEFF';
  const sep = ';';
  const lines = [];

  // 1. Cabecera con datos de la empresa y del periodo
  lines.push(`"LIBRO REGISTRO DE FACTURAS EMITIDAS - ${quarterData.quarterLabel}"`);
  lines.push(`"Empresa:";"${company.name || 'Empresa'}";"CIF:";"${company.cif || ''}"`);
  lines.push(`"Periodo:";"${quarterData.startDateFormatted} al ${quarterData.endDateFormatted}";"Fecha emisión:";"${new Date().toLocaleDateString('es-ES')}"`);
  lines.push('');

  // 2. Cabecera de columnas para el software contable
  const headers = [
    'Número Factura',
    'Fecha Expedición',
    'NIF / CIF Cliente',
    'Nombre / Razón Social Cliente',
    'Concepto Principal',
    'Base Imponible (€)',
    'Tipo IVA (%)',
    'Cuota IVA (€)',
    'Total Factura (€)',
    'Total Cobrado (€)',
    'Pendiente Cobro (€)',
    'Estado Cobro',
    'Ref. Presupuesto'
  ];
  lines.push(headers.map(h => `"${h}"`).join(sep));

  const formatNum = (num) => {
    return Number(num || 0).toFixed(2).replace('.', ',');
  };

  // 3. Filas de facturas
  for (const inv of quarterData.invoices) {
    const fin = inv.financials || {};
    const base = fin.taxableBase || 0;
    const rate = fin.taxRatePercentage || 10;
    const tax = fin.taxAmount || 0;
    const total = fin.totalAmount || 0;
    const advance = fin.advanceAmount || 0;
    const remaining = fin.remainingAmount !== undefined ? fin.remainingAmount : Math.max(0, total - advance);
    const paid = inv.status === 'PAGADA' ? total : advance;
    const concept = (inv.items && inv.items[0]?.description) ? inv.items[0].description.replace(/[\r\n;]/g, ' ') : 'Trabajos de reforma según presupuesto';

    const row = [
      inv.id,
      inv.issueDate || quarterData.startDateFormatted,
      inv.client?.nif || 'Consignado en contrato',
      (inv.client?.name || 'Cliente Particular').replace(/[\r\n;]/g, ' '),
      concept.length > 50 ? concept.substring(0, 47) + '...' : concept,
      formatNum(base),
      `${rate}%`,
      formatNum(tax),
      formatNum(total),
      formatNum(paid),
      formatNum(remaining),
      inv.status === 'PAGADA' || remaining <= 0 ? 'PAGADA' : 'PENDIENTE',
      inv.budgetId || ''
    ];
    lines.push(row.map(cell => `"${cell}"`).join(sep));
  }

  // 4. Bloque de totales al final para el contable
  lines.push('');
  const s = quarterData.summary;
  lines.push(`"";"";"";"TOTALES TRIMESTRE:";"";"${formatNum(s.totalTaxableBase)}";"";"${formatNum(s.totalTaxAmount)}";"${formatNum(s.totalAmount)}";"${formatNum(s.totalPaid)}";"${formatNum(s.totalRemaining)}";"";""`);
  lines.push(`"";"";"";"Desglose IVA 10% (Modelo 303):";"";"${formatNum(s.base10)}";"10%";"${formatNum(s.tax10)}";"";"";"";"";""`);
  lines.push(`"";"";"";"Desglose IVA 21% (Modelo 303):";"";"${formatNum(s.base21)}";"21%";"${formatNum(s.tax21)}";"";"";"";"";""`);

  return BOM + lines.join('\r\n');
}

// ─── Métodos de Agenda de Citas y Visitas ─────────────────────────────────────

// ─── Métodos de Agenda de Citas y Visitas ─────────────────────────────────────

export function toMadridIso(dateStr, timeStr) {
  const safeDate = (dateStr || new Date().toISOString().split('T')[0]).trim();
  const safeTime = (timeStr || '10:00').trim().padStart(5, '0');
  return `${safeDate}T${safeTime}:00`;
}

export function calculateDefaultEndTime(dateStr, timeStr, durationMinutes = 60) {
  const [h, m] = (timeStr || '10:00').split(':').map(Number);
  const totalMin = (h * 60 + m) + durationMinutes;
  const endH = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
  const endM = String(totalMin % 60).padStart(2, '0');
  return `${dateStr}T${endH}:${endM}:00`;
}

export function saveAppointment(companyContextOrIdOrPhone, appointment = {}) {
  if (!companyContextOrIdOrPhone) {
    throw new Error("❌ [Tenant Boundary] saveAppointment requiere un companyId o contexto autenticado obligatorio.");
  }
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId || null;
  const cleanPhone = tenant?.phone || (typeof companyContextOrIdOrPhone === 'string' ? companyContextOrIdOrPhone.replace(/\D/g, '') : '');
  const now = new Date().toISOString();
  const currentYear = new Date().getFullYear();

  let id = appointment.id;
  let isNew = false;
  const existing = id ? getAppointment(companyContextOrIdOrPhone, id) : null;
  
  if (id && !existing) {
    // Verificar si el ID ya existe en otro tenant (cross-tenant overwrite attempt)
    const crossCheck = db.prepare('SELECT id, company_id, company_phone FROM appointments WHERE id = ?').get(id);
    if (crossCheck) {
      console.warn(`🛑 [Seguridad Tenant] Intento de sobreescritura cross-tenant en cita '${id}'. Rechazado.`);
      return null;
    }
  }

  if (!id) {
    const countRow = db.prepare("SELECT COUNT(*) as c FROM appointments WHERE id LIKE ?").get(`CIT-${currentYear}-%`);
    const nextSeq = String((countRow?.c || 0) + 1).padStart(4, '0');
    id = `CIT-${currentYear}-${nextSeq}`;
    isNew = true;
  }

  const clientName = (appointment.clientName || appointment.client_name || existing?.clientName || 'Cliente Particular').trim();
  const clientPhone = (appointment.clientPhone || appointment.client_phone || existing?.clientPhone || '').trim();
  const clientAddress = (appointment.clientAddress || appointment.client_address || existing?.clientAddress || '').trim();
  const date = (appointment.date || existing?.date || now.split('T')[0]).trim();
  const time = (appointment.time || existing?.time || '10:00').trim();
  const title = (appointment.title || existing?.title || `Visita con ${clientName}`).trim();
  const notes = (appointment.notes || existing?.notes || 'Visita técnica y toma de medidas').trim();
  const timezone = appointment.timezone || existing?.timezone || 'Europe/Madrid';
  
  // Regla de Oro: Siempre que el empresario crea o agenda, inicia CONFIRMED
  const status = appointment.status || existing?.status || 'CONFIRMED';
  const outcome = appointment.outcome || existing?.outcome || 'NONE';
  const needsOutcomeConfirmation = appointment.needs_outcome_confirmation !== undefined 
    ? Number(appointment.needs_outcome_confirmation) 
    : (existing ? (existing.needsOutcomeConfirmation ? 1 : 0) : 0);
  
  const scheduledStart = appointment.scheduled_start || (existing?.scheduledStart) || toMadridIso(date, time);
  const scheduledEnd = appointment.scheduled_end || (existing?.scheduledEnd) || calculateDefaultEndTime(date, time, 60);
  const originalScheduledStart = appointment.original_scheduled_start || existing?.originalScheduledStart || scheduledStart;
  const rescheduleCount = appointment.reschedule_count !== undefined 
    ? Number(appointment.reschedule_count) 
    : (existing?.rescheduleCount || 0);

  const stmt = db.prepare(`
    INSERT INTO appointments (
      id, company_id, company_phone, client_name, client_phone, client_address,
      date, time, title, notes, timezone,
      status, outcome, needs_outcome_confirmation,
      scheduled_start, scheduled_end, original_scheduled_start, reschedule_count,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_id = COALESCE(excluded.company_id, appointments.company_id),
      company_phone = COALESCE(excluded.company_phone, appointments.company_phone),
      client_name = excluded.client_name,
      client_phone = excluded.client_phone,
      client_address = excluded.client_address,
      date = excluded.date,
      time = excluded.time,
      title = excluded.title,
      notes = excluded.notes,
      timezone = excluded.timezone,
      status = excluded.status,
      outcome = excluded.outcome,
      needs_outcome_confirmation = excluded.needs_outcome_confirmation,
      scheduled_start = excluded.scheduled_start,
      scheduled_end = excluded.scheduled_end,
      reschedule_count = excluded.reschedule_count,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    id, companyId, cleanPhone, clientName, clientPhone, clientAddress,
    date, time, title, notes, timezone,
    status, outcome, needsOutcomeConfirmation,
    scheduledStart, scheduledEnd, originalScheduledStart, rescheduleCount,
    now, now
  );

  if (isNew) {
    recordAuditLog({
      businessId: companyId || cleanPhone,
      entityType: 'APPOINTMENT',
      entityId: id,
      action: 'CREATE',
      fieldChanged: 'status',
      oldValue: null,
      newValue: 'CONFIRMED',
      changedBy: 'USER_WHATSAPP',
      reason: `Visita agendada para ${date} a las ${time} h con ${clientName}`
    });
  }

  return getAppointment(companyContextOrIdOrPhone, id);
}

export function getAppointment(companyContextOrIdOrPhone, id) {
  // Manejo de llamada canónica tenant-scoped: getAppointment(companyContext, id)
  if (id !== undefined && id !== null) {
    if (!companyContextOrIdOrPhone || !id) return null;
    const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
    const companyId = tenant?.companyId;
    const phone = tenant?.phone;

    let row = null;
    if (companyId) {
      // Búsqueda canónica estricta por company_id
      const stmt = db.prepare('SELECT * FROM appointments WHERE id = ? AND company_id = ?');
      row = stmt.get(id, companyId);
      // Fallback transitorio si el registro aún no ha sido migrado a company_id
      if (!row && phone) {
        const stmtLegacy = db.prepare('SELECT * FROM appointments WHERE id = ? AND company_phone = ? AND company_id IS NULL');
        row = stmtLegacy.get(id, phone);
      }
    } else if (phone) {
      // Búsqueda legacy por company_phone cuando no existe company_id
      const stmt = db.prepare('SELECT * FROM appointments WHERE id = ? AND company_phone = ?');
      row = stmt.get(id, phone);
    }

    if (!row) return null;
    return {
      id: row.id,
      companyId: row.company_id,
      companyPhone: row.company_phone,
      clientName: row.client_name,
      clientPhone: row.client_phone,
      clientAddress: row.client_address,
      title: row.title,
      date: row.date,
      time: row.time,
      notes: row.notes,
      timezone: row.timezone || 'Europe/Madrid',
      status: row.status || 'CONFIRMED',
      outcome: row.outcome || 'NONE',
      needsOutcomeConfirmation: Boolean(row.needs_outcome_confirmation),
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      originalScheduledStart: row.original_scheduled_start,
      rescheduleCount: row.reschedule_count || 0,
      reminderDaySentAt: row.reminder_day_sent_at,
      reminderMorningSentAt: row.reminder_morning_sent_at,
      endOfDayReviewSentAt: row.end_of_day_review_sent_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      rescheduledAt: row.rescheduled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // REGLA DE SEGURIDAD ESTRICTA:
  // Nunca debe existir una consulta de cita que dependa únicamente de id sin tenant context
  console.warn("🛑 [Seguridad Tenant] getAppointment invocado sin tenant context obligatorio. Retornando null.");
  return null;
}

/**
 * Busca visitas que coincidan con un término de búsqueda (tenant-scoped).
 */
export function findAppointments(companyContextOrIdOrPhone, query, options = {}) {
  if (!companyContextOrIdOrPhone) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  const q = `%${(query || '').trim().toLowerCase()}%`;
  const statusFilter = options.includeCancelled ? '' : "AND status != 'CANCELLED'";

  let rows = [];
  if (companyId) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE (company_id = ? OR (company_id IS NULL AND company_phone = ?))
        ${statusFilter}
        AND (LOWER(id) LIKE ? OR LOWER(client_name) LIKE ? OR LOWER(notes) LIKE ? OR LOWER(client_address) LIKE ?)
      ORDER BY date ASC, time ASC
    `);
    rows = stmt.all(companyId, cleanPhone || '', q, q, q, q);
  } else if (cleanPhone) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE company_phone = ?
        ${statusFilter}
        AND (LOWER(id) LIKE ? OR LOWER(client_name) LIKE ? OR LOWER(notes) LIKE ? OR LOWER(client_address) LIKE ?)
      ORDER BY date ASC, time ASC
    `);
    rows = stmt.all(cleanPhone, q, q, q, q);
  }

  return rows.map(r => ({
    id: r.id,
    companyId: r.company_id,
    companyPhone: r.company_phone,
    clientName: r.client_name,
    clientPhone: r.client_phone,
    clientAddress: r.client_address,
    date: r.date,
    time: r.time,
    notes: r.notes,
    status: r.status,
    scheduledStart: r.scheduled_start
  }));
}

/**
 * Detecta si una visita solapa en horario con otra visita existente del mismo profesional.
 */
export function findConflictingAppointments(companyContextOrIdOrPhone, dateStr, timeStr, excludeId = null) {
  if (!companyContextOrIdOrPhone || !dateStr || !timeStr) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  let rows = [];
  if (companyId) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE (company_id = ? OR (company_id IS NULL AND company_phone = ?))
        AND date = ?
        AND time = ?
        AND status = 'CONFIRMED'
        AND (? IS NULL OR id != ?)
    `);
    rows = stmt.all(companyId, cleanPhone || '', dateStr, timeStr, excludeId, excludeId);
  } else if (cleanPhone) {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE company_phone = ?
        AND date = ?
        AND time = ?
        AND status = 'CONFIRMED'
        AND (? IS NULL OR id != ?)
    `);
    rows = stmt.all(cleanPhone, dateStr, timeStr, excludeId, excludeId);
  }

  return rows.map(r => ({
    id: r.id,
    companyId: r.company_id,
    companyPhone: r.company_phone,
    clientName: r.client_name,
    date: r.date,
    time: r.time,
    clientAddress: r.client_address
  }));
}

/**
 * Reagenda una visita existente manteniendo el mismo registro en SQLite.
 * Incrementa reschedule_count, audita en audit_logs y resetea flags de recordatorio.
 */
/**
 * Reagenda una visita existente manteniendo el mismo registro en SQLite (tenant-scoped).
 */
export function rescheduleAppointment(companyContextOrIdOrPhone, queryOrId, newDate, newTime, reason = 'Reagendamiento solicitado por usuario') {
  if (!companyContextOrIdOrPhone || !queryOrId || (!newDate && !newTime)) return { success: false, error: 'MISSING_DATA' };
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  const matches = findAppointments(companyContextOrIdOrPhone, queryOrId);
  if (matches.length === 0) return { success: false, error: 'NOT_FOUND' };
  if (matches.length > 1) return { success: false, error: 'AMBIGUOUS', matches };

  const target = matches[0];
  const oldRow = getAppointment(companyContextOrIdOrPhone, target.id);
  if (!oldRow) return { success: false, error: 'NOT_FOUND' };
  const now = new Date().toISOString();

  const finalDate = (newDate || oldRow.date).trim();
  const finalTime = (newTime || oldRow.time).trim();
  const finalStart = toMadridIso(finalDate, finalTime);
  const finalEnd = calculateDefaultEndTime(finalDate, finalTime, 60);
  const oldDisplay = `${oldRow.date} ${oldRow.time} h`;
  const newDisplay = `${finalDate} ${finalTime} h`;

  if (companyId) {
    const stmt = db.prepare(`
      UPDATE appointments
      SET date = ?,
          time = ?,
          scheduled_start = ?,
          scheduled_end = ?,
          status = 'CONFIRMED',
          outcome = 'NONE',
          needs_outcome_confirmation = 0,
          reschedule_count = reschedule_count + 1,
          rescheduled_at = ?,
          reminder_day_sent_at = NULL,
          reminder_morning_sent_at = NULL,
          end_of_day_review_sent_at = NULL,
          updated_at = ?
      WHERE id = ? AND (company_id = ? OR (company_id IS NULL AND company_phone = ?))
    `);
    stmt.run(finalDate, finalTime, finalStart, finalEnd, now, now, target.id, companyId, cleanPhone || '');
  } else {
    const stmt = db.prepare(`
      UPDATE appointments
      SET date = ?,
          time = ?,
          scheduled_start = ?,
          scheduled_end = ?,
          status = 'CONFIRMED',
          outcome = 'NONE',
          needs_outcome_confirmation = 0,
          reschedule_count = reschedule_count + 1,
          rescheduled_at = ?,
          reminder_day_sent_at = NULL,
          reminder_morning_sent_at = NULL,
          end_of_day_review_sent_at = NULL,
          updated_at = ?
      WHERE id = ? AND company_phone = ?
    `);
    stmt.run(finalDate, finalTime, finalStart, finalEnd, now, now, target.id, cleanPhone);
  }

  recordAuditLog({
    businessId: companyId || cleanPhone,
    entityType: 'APPOINTMENT',
    entityId: target.id,
    action: 'RESCHEDULE',
    fieldChanged: 'scheduled_start',
    oldValue: oldDisplay,
    newValue: newDisplay,
    changedBy: 'USER_WHATSAPP',
    reason
  });

  return { success: true, appointment: getAppointment(companyContextOrIdOrPhone, target.id) };
}

/**
 * Marca una o varias visitas como COMPLETED con su resultado (tenant-scoped).
 */
export function completeAppointments(companyContextOrIdOrPhone, queriesOrIds = [], outcome = 'SUCCESSFUL', reason = 'Confirmación de visita realizada') {
  if (!companyContextOrIdOrPhone) return { completed: [], notFound: queriesOrIds };
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;
  const completed = [];
  const notFound = [];
  const now = new Date().toISOString();

  for (const q of queriesOrIds) {
    const matches = findAppointments(companyContextOrIdOrPhone, q);
    if (matches.length === 1) {
      const apt = matches[0];
      if (companyId) {
        db.prepare(`
          UPDATE appointments
          SET status = 'COMPLETED',
              outcome = ?,
              completed_at = ?,
              needs_outcome_confirmation = 0,
              updated_at = ?
          WHERE id = ? AND (company_id = ? OR (company_id IS NULL AND company_phone = ?))
        `).run(outcome, now, now, apt.id, companyId, cleanPhone || '');
      } else {
        db.prepare(`
          UPDATE appointments
          SET status = 'COMPLETED',
              outcome = ?,
              completed_at = ?,
              needs_outcome_confirmation = 0,
              updated_at = ?
          WHERE id = ? AND company_phone = ?
        `).run(outcome, now, now, apt.id, cleanPhone);
      }

      recordAuditLog({
        businessId: companyId || cleanPhone,
        entityType: 'APPOINTMENT',
        entityId: apt.id,
        action: 'COMPLETE',
        fieldChanged: 'status',
        oldValue: apt.status || 'CONFIRMED',
        newValue: 'COMPLETED',
        changedBy: 'USER_WHATSAPP',
        reason
      });

      completed.push(getAppointment(companyContextOrIdOrPhone, apt.id));
    } else {
      notFound.push(q);
    }
  }

  return { completed, notFound };
}

/**
 * Modifica campos generales de una cita existente sin borrarla (tenant-scoped).
 */
export function updateAppointment(companyContextOrIdOrPhone, query, changes = {}) {
  if (!companyContextOrIdOrPhone || (!query && !changes)) return null;
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  const matches = findAppointments(companyContextOrIdOrPhone, query);
  if (matches.length === 0) return null;
  if (matches.length > 1) return { ambiguous: true, matches };

  const row = getAppointment(companyContextOrIdOrPhone, matches[0].id);
  if (!row) return null;
  const now = new Date().toISOString();

  const newDate = changes.date || row.date;
  const newTime = changes.time || row.time;
  const newAddress = changes.clientAddress || row.clientAddress;
  const newNotes = changes.notes || row.notes;
  const newClientName = changes.clientName || row.clientName;
  const newClientPhone = changes.clientPhone || row.clientPhone;
  const newStart = toMadridIso(newDate, newTime);
  const newEnd = calculateDefaultEndTime(newDate, newTime, 60);

  // Model injection defense: solo actualizar campos permitidos
  if (companyId) {
    const updateStmt = db.prepare(`
      UPDATE appointments
      SET date = ?, time = ?, scheduled_start = ?, scheduled_end = ?,
          client_address = ?, notes = ?, client_name = ?, client_phone = ?,
          updated_at = ?
      WHERE id = ? AND (company_id = ? OR (company_id IS NULL AND company_phone = ?))
    `);
    updateStmt.run(newDate, newTime, newStart, newEnd, newAddress, newNotes, newClientName, newClientPhone, now, row.id, companyId, cleanPhone || '');
  } else {
    const updateStmt = db.prepare(`
      UPDATE appointments
      SET date = ?, time = ?, scheduled_start = ?, scheduled_end = ?,
          client_address = ?, notes = ?, client_name = ?, client_phone = ?,
          updated_at = ?
      WHERE id = ? AND company_phone = ?
    `);
    updateStmt.run(newDate, newTime, newStart, newEnd, newAddress, newNotes, newClientName, newClientPhone, now, row.id, cleanPhone);
  }

  recordAuditLog({
    businessId: companyId || cleanPhone,
    entityType: 'APPOINTMENT',
    entityId: row.id,
    action: 'UPDATE',
    fieldChanged: 'details',
    oldValue: `${row.date} ${row.time} - ${row.clientAddress}`,
    newValue: `${newDate} ${newTime} - ${newAddress}`,
    changedBy: 'USER_WHATSAPP',
    reason: 'Modificación de detalles de visita'
  });

  return getAppointment(companyContextOrIdOrPhone, row.id);
}

/**
 * Cancela una visita preservando el registro y la trazabilidad (Soft-cancel tenant-scoped).
 */
export function cancelAppointment(companyContextOrIdOrPhone, query, reason = 'Cancelación solicitada por usuario') {
  if (!companyContextOrIdOrPhone || !query) return null;
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  const matches = findAppointments(companyContextOrIdOrPhone, query);
  if (matches.length === 0) return null;
  if (matches.length > 1) return { ambiguous: true, matches };

  const row = matches[0];
  const now = new Date().toISOString();

  if (companyId) {
    db.prepare(`
      UPDATE appointments
      SET status = 'CANCELLED',
          cancelled_at = ?,
          needs_outcome_confirmation = 0,
          updated_at = ?
      WHERE id = ? AND (company_id = ? OR (company_id IS NULL AND company_phone = ?))
    `).run(now, now, row.id, companyId, cleanPhone || '');
  } else {
    db.prepare(`
      UPDATE appointments
      SET status = 'CANCELLED',
          cancelled_at = ?,
          needs_outcome_confirmation = 0,
          updated_at = ?
      WHERE id = ? AND company_phone = ?
    `).run(now, now, row.id, cleanPhone);
  }

  recordAuditLog({
    businessId: companyId || cleanPhone,
    entityType: 'APPOINTMENT',
    entityId: row.id,
    action: 'CANCEL',
    fieldChanged: 'status',
    oldValue: row.status || 'CONFIRMED',
    newValue: 'CANCELLED',
    changedBy: 'USER_WHATSAPP',
    reason
  });

  return getAppointment(companyContextOrIdOrPhone, row.id);
}

export function listAppointments(companyContextOrIdOrPhone, filter = 'all') {
  if (!companyContextOrIdOrPhone) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const tenantFilter = companyId 
    ? "(company_id = ? OR (company_id IS NULL AND company_phone = ?))"
    : "company_phone = ?";
  const tenantParams = companyId ? [companyId, cleanPhone || ''] : [cleanPhone];

  let rows = [];
  if (filter === 'today') {
    const stmt = db.prepare(`SELECT * FROM appointments WHERE ${tenantFilter} AND date = ? AND status != 'CANCELLED' ORDER BY time ASC`);
    rows = stmt.all(...tenantParams, todayStr);
  } else if (filter === 'tomorrow') {
    const stmt = db.prepare(`SELECT * FROM appointments WHERE ${tenantFilter} AND date = ? AND status != 'CANCELLED' ORDER BY time ASC`);
    rows = stmt.all(...tenantParams, tomorrowStr);
  } else if (filter === 'completed') {
    const stmt = db.prepare(`SELECT * FROM appointments WHERE ${tenantFilter} AND status = 'COMPLETED' ORDER BY date DESC, time DESC`);
    rows = stmt.all(...tenantParams);
  } else if (filter === 'past') {
    const stmt = db.prepare(`SELECT * FROM appointments WHERE ${tenantFilter} AND date < ? AND status != 'CANCELLED' ORDER BY date DESC, time DESC`);
    rows = stmt.all(...tenantParams, todayStr);
  } else if (filter === 'pending_review') {
    const stmt = db.prepare(`
      SELECT * FROM appointments
      WHERE ${tenantFilter}
        AND status = 'CONFIRMED'
        AND (needs_outcome_confirmation = 1 OR date <= ?)
      ORDER BY date ASC, time ASC
    `);
    rows = stmt.all(...tenantParams, todayStr);
  } else if (filter === 'confirmed') {
    const stmt = db.prepare(`SELECT * FROM appointments WHERE ${tenantFilter} AND status = 'CONFIRMED' ORDER BY date ASC, time ASC`);
    rows = stmt.all(...tenantParams);
  } else {
    // 'all': Todas las visitas activas o no canceladas ordenadas cronológicamente
    const stmt = db.prepare(`SELECT * FROM appointments WHERE ${tenantFilter} AND status != 'CANCELLED' ORDER BY date ASC, time ASC`);
    rows = stmt.all(...tenantParams);
  }

  return rows.map(r => ({
    id: r.id,
    companyId: r.company_id,
    companyPhone: r.company_phone,
    clientName: r.client_name,
    clientPhone: r.client_phone,
    clientAddress: r.client_address,
    title: r.title,
    date: r.date,
    time: r.time,
    notes: r.notes,
    timezone: r.timezone || 'Europe/Madrid',
    status: r.status || 'CONFIRMED',
    outcome: r.outcome || 'NONE',
    needsOutcomeConfirmation: Boolean(r.needs_outcome_confirmation),
    scheduledStart: r.scheduled_start,
    scheduledEnd: r.scheduled_end,
    rescheduleCount: r.reschedule_count || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

export function updateAppointmentStatus(companyContextOrIdOrPhone, id, status) {
  // Verificación estricta de tenant context (3 argumentos requeridos)
  if (status === undefined || !companyContextOrIdOrPhone || !id) {
    console.warn("🛑 [Seguridad Tenant] updateAppointmentStatus invocado sin tenant context obligatorio.");
    return;
  }
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;
  const now = new Date().toISOString();

  if (companyId) {
    const stmt = db.prepare(`
      UPDATE appointments 
      SET status = ?, updated_at = ? 
      WHERE id = ? AND (company_id = ? OR (company_id IS NULL AND company_phone = ?))
    `);
    stmt.run(status, now, id, companyId, cleanPhone || '');
  } else if (cleanPhone) {
    const stmt = db.prepare('UPDATE appointments SET status = ?, updated_at = ? WHERE id = ? AND company_phone = ?');
    stmt.run(status, now, id, cleanPhone);
  }
}

export function getAppointmentHistory(companyContextOrIdOrPhone, appointmentId) {
  if (!companyContextOrIdOrPhone || !appointmentId) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  const cols = db.prepare('PRAGMA table_info("audit_logs")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let rows = [];
  if (hasCompanyIdCol && companyId) {
    rows = db.prepare(`
      SELECT * FROM audit_logs
      WHERE (company_id = ? OR (company_id IS NULL AND business_id = ?))
        AND entity_type = 'APPOINTMENT'
        AND entity_id = ?
      ORDER BY timestamp ASC
    `).all(companyId, cleanPhone || '', appointmentId);
  } else {
    rows = db.prepare(`
      SELECT * FROM audit_logs
      WHERE (business_id = ? OR business_id = ?)
        AND entity_type = 'APPOINTMENT'
        AND entity_id = ?
      ORDER BY timestamp ASC
    `).all(companyId || cleanPhone, cleanPhone, appointmentId);
  }

  return rows.map(r => ({
    id: r.id,
    companyId: r.company_id || companyId,
    businessId: r.business_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    action: r.action,
    fieldChanged: r.field_changed,
    oldValue: r.old_value,
    newValue: r.new_value,
    changedBy: r.changed_by,
    reason: r.reason,
    timestamp: r.timestamp
  }));
}


// ─── Métodos del Secretario Digital (Briefing y Seguimiento) ──────────────────

export function getUnpaidInvoices(phoneOrCompany) {
  const tenant = resolveCompanyTenant(phoneOrCompany);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone || (typeof phoneOrCompany === 'string' ? phoneOrCompany.replace(/\D/g, '') : '');
  let rows = [];
  if (companyId) {
    rows = db.prepare("SELECT id, budget_id, client_name, total_amount, status, created_at, data_json FROM invoices WHERE company_id = ? AND status != 'PAGADA' ORDER BY created_at ASC").all(companyId);
  } else if (cleanPhone) {
    rows = db.prepare("SELECT id, budget_id, client_name, total_amount, status, created_at, data_json FROM invoices WHERE company_phone = ? AND status != 'PAGADA' ORDER BY created_at ASC").all(cleanPhone);
  }
  const now = Date.now();
  return rows.map(r => {
    let parsed = null;
    try { parsed = JSON.parse(r.data_json); } catch(e) {}
    const createdAt = r.created_at ? new Date(r.created_at).getTime() : now;
    const daysPending = Math.max(0, Math.floor((now - createdAt) / (1000 * 60 * 60 * 24)));
    return {
      id: r.id,
      budgetId: r.budget_id,
      clientName: r.client_name || parsed?.client?.name || 'Cliente Particular',
      clientPhone: parsed?.client?.phone || null,
      totalAmount: r.total_amount || parsed?.financials?.totalAmount || 0,
      status: r.status,
      createdAt: r.created_at,
      daysPending,
      invoice: parsed
    };
  });
}

export function getBudgetsPendingFollowUp(phoneOrCompany) {
  const tenant = resolveCompanyTenant(phoneOrCompany);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  let rows = [];
  if (companyId) {
    rows = db.prepare("SELECT id, client_name, client_phone, total_amount, status, created_at, updated_at, data_json FROM budgets WHERE company_id = ? AND status NOT IN ('ACEPTADO', 'FIRMADO', 'FINALIZADO') ORDER BY created_at ASC").all(companyId);
  } else if (cleanPhone) {
    rows = db.prepare("SELECT id, client_name, client_phone, total_amount, status, created_at, updated_at, data_json FROM budgets WHERE company_phone = ? AND status NOT IN ('ACEPTADO', 'FIRMADO', 'FINALIZADO') ORDER BY created_at ASC").all(cleanPhone);
  }
  const now = Date.now();
  return rows.map(r => {
    let parsed = null;
    try { parsed = JSON.parse(r.data_json); } catch(e) {}
    if (parsed?.isDraft) return null; // Ignorar borradores incompletos de medición
    const createdAt = r.created_at ? new Date(r.created_at).getTime() : now;
    const daysWaiting = Math.max(0, Math.floor((now - createdAt) / (1000 * 60 * 60 * 24)));
    return {
      id: r.id,
      clientName: r.client_name || parsed?.client?.name || 'Cliente Particular',
      clientPhone: r.client_phone || parsed?.client?.phone || null,
      totalAmount: r.total_amount || parsed?.financials?.totalAmount || 0,
      status: r.status,
      createdAt: r.created_at,
      daysWaiting,
      budget: parsed
    };
  }).filter(Boolean);
}

// ─── Métodos de Consultas Agregadas (Intent Router — sin IA) ─────────────────

/**
 * Calcula los ingresos facturados, cobrados y pendientes en un mes concreto.
 * Usado por el Intent Router para responder "¿cuánto llevo este mes?" sin IA.
 * @param {string|object} phoneOrCompany
 * @param {number} year  - ej. 2026
 * @param {number} month - 1 a 12
 * @returns {{ invoiceCount, budgetCount, totalInvoiced, totalCollected, totalPending }}
 */
export function getMonthlyRevenue(phoneOrCompany, year, month) {
  const tenant = resolveCompanyTenant(phoneOrCompany);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone || (typeof phoneOrCompany === 'string' ? phoneOrCompany.replace(/\D/g, '') : '');
  const startISO = new Date(year, month - 1, 1, 0, 0, 0).toISOString();
  const endISO   = new Date(year, month, 0, 23, 59, 59, 999).toISOString();

  // Facturas del mes
  let invoiceRows = [];
  if (companyId) {
    invoiceRows = db.prepare(`
      SELECT total_amount, status, data_json
      FROM invoices
      WHERE company_id = ? AND created_at >= ? AND created_at <= ?
    `).all(companyId, startISO, endISO);
  } else if (cleanPhone) {
    invoiceRows = db.prepare(`
      SELECT total_amount, status, data_json
      FROM invoices
      WHERE company_phone = ? AND created_at >= ? AND created_at <= ?
    `).all(cleanPhone, startISO, endISO);
  }

  let totalInvoiced  = 0;
  let totalCollected = 0;
  let totalPending   = 0;

  for (const r of invoiceRows) {
    let parsed = null;
    try { parsed = JSON.parse(r.data_json); } catch (e) {}
    const total    = r.total_amount || parsed?.financials?.totalAmount || 0;
    const advance  = parsed?.financials?.advanceAmount || 0;
    const remaining = parsed?.financials?.remainingAmount ?? Math.max(0, total - advance);
    const collected = r.status === 'PAGADA' ? total : advance;
    totalInvoiced  += total;
    totalCollected += collected;
    totalPending   += remaining;
  }

  // Presupuestos del mes
  let budgetCount = 0;
  if (companyId) {
    budgetCount = db.prepare(`
      SELECT COUNT(*) as c FROM budgets
      WHERE company_id = ? AND created_at >= ? AND created_at <= ?
    `).get(companyId, startISO, endISO)?.c || 0;
  } else if (cleanPhone) {
    budgetCount = db.prepare(`
      SELECT COUNT(*) as c FROM budgets
      WHERE company_phone = ? AND created_at >= ? AND created_at <= ?
    `).get(cleanPhone, startISO, endISO)?.c || 0;
  }

  return {
    invoiceCount:  invoiceRows.length,
    budgetCount:   Number(budgetCount),
    totalInvoiced:  Number(totalInvoiced.toFixed(2)),
    totalCollected: Number(totalCollected.toFixed(2)),
    totalPending:   Number(totalPending.toFixed(2))
  };
}

/**
 * Devuelve las citas y visitas de los proximos 7 dias (agenda semanal).
 * Usado por el Intent Router para "que tengo esta semana?" sin IA.
 * @param {string} phone
 * @returns {Array<object>} - Lista de citas ordenadas cronologicamente
 */
export function listAppointmentsWeek(companyContextOrIdOrPhone) {
  if (!companyContextOrIdOrPhone) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;
  const now    = new Date();
  const todayStr  = now.toISOString().split('T')[0];
  const weekEnd   = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().split('T')[0];

  const tenantFilter = companyId 
    ? "(company_id = ? OR (company_id IS NULL AND company_phone = ?))"
    : "company_phone = ?";
  const tenantParams = companyId ? [companyId, cleanPhone || ''] : [cleanPhone];

  const rows = db.prepare(`
    SELECT * FROM appointments
    WHERE ${tenantFilter}
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC, time ASC
  `).all(...tenantParams, todayStr, weekEndStr);

  return rows.map(r => ({
    id:            r.id,
    companyId:     r.company_id,
    companyPhone:  r.company_phone,
    clientName:    r.client_name,
    clientPhone:   r.client_phone,
    clientAddress: r.client_address,
    date:          r.date,
    time:          r.time,
    notes:         r.notes
  }));
}

/**
 * Dashboard global rapido: combina deudas, citas de hoy, presupuestos pendientes
 * y resumen del mes en una sola consulta compuesta.
 * Usado por el Intent Router para "resumen" / "como estoy?" sin IA.
 * @param {string|object} phoneOrCompany
 * @returns {{ totalDebt, debtCount, todayAppointments, pendingBudgets, monthlyStats }}
 */
export function getDashboard(phoneOrCompany) {
  const tenant = resolveCompanyTenant(phoneOrCompany);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone || (typeof phoneOrCompany === 'string' ? phoneOrCompany.replace(/\D/g, '') : '');
  const now     = new Date();
  const todayStr   = now.toISOString().split('T')[0];
  const month   = now.getMonth() + 1;
  const year    = now.getFullYear();

  // 1. Deudas totales
  let unpaidRows = [];
  if (companyId) {
    unpaidRows = db.prepare(`
      SELECT total_amount, data_json FROM invoices
      WHERE company_id = ? AND status != 'PAGADA'
    `).all(companyId);
  } else if (cleanPhone) {
    unpaidRows = db.prepare(`
      SELECT total_amount, data_json FROM invoices
      WHERE company_phone = ? AND status != 'PAGADA'
    `).all(cleanPhone);
  }

  let totalDebt  = 0;
  for (const r of unpaidRows) {
    let parsed = null;
    try { parsed = JSON.parse(r.data_json); } catch (e) {}
    const total    = r.total_amount || parsed?.financials?.totalAmount || 0;
    const advance  = parsed?.financials?.advanceAmount || 0;
    const remaining = parsed?.financials?.remainingAmount ?? Math.max(0, total - advance);
    totalDebt += remaining;
  }

  // 2. Citas de hoy (tenant-scoped)
  const aptTenantFilter = companyId 
    ? "(company_id = ? OR (company_id IS NULL AND company_phone = ?))" 
    : "company_phone = ?";
  const aptParams = companyId ? [companyId, cleanPhone || '', todayStr] : [cleanPhone, todayStr];

  const todayAppointments = db.prepare(`
    SELECT client_name, client_address, time FROM appointments
    WHERE ${aptTenantFilter} AND date = ?
    ORDER BY time ASC
  `).all(...aptParams).map(r => ({
    clientName:    r.client_name,
    clientAddress: r.client_address,
    time:          r.time
  }));

  // 3. Presupuestos pendientes de firma
  let pendingBudgets = 0;
  if (companyId) {
    pendingBudgets = db.prepare(`
      SELECT COUNT(*) as c FROM budgets
      WHERE company_id = ?
        AND status IN ('PENDIENTE_ACEPTACION', 'ENVIADO')
    `).get(companyId)?.c || 0;
  } else if (cleanPhone) {
    pendingBudgets = db.prepare(`
      SELECT COUNT(*) as c FROM budgets
      WHERE company_phone = ?
        AND status IN ('PENDIENTE_ACEPTACION', 'ENVIADO')
    `).get(cleanPhone)?.c || 0;
  }

  // 4. Resumen del mes actual
  const monthlyStats = getMonthlyRevenue(phoneOrCompany, year, month);

  return {
    totalDebt:          Number(totalDebt.toFixed(2)),
    debtCount:          unpaidRows.length,
    todayAppointments,
    pendingBudgets:     Number(pendingBudgets),
    monthlyStats
  };
}

// ─── Métodos de Lista de Compras y Materiales ────────────────────────────────

export function addShoppingItems(companyContextOrIdOrPhone, items, defaultClientContext = {}) {
  if (!companyContextOrIdOrPhone || !items) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId || null;
  const cleanPhone = tenant?.phone || (typeof companyContextOrIdOrPhone === 'string' ? companyContextOrIdOrPhone.replace(/\D/g, '') : '');
  const itemsList = Array.isArray(items) ? items : [items];
  const now = new Date().toISOString();
  const inserted = [];

  const stmt = db.prepare(`
    INSERT INTO shopping_items (id, company_id, company_phone, client_name, budget_id, description, qty, unit, status, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
  `);

  for (const item of itemsList) {
    if (!item) continue;
    let description = '';
    let qty = 1;
    let unit = 'ud';
    let notes = null;
    let clientName = defaultClientContext.clientName || null;
    let budgetId = defaultClientContext.budgetId || null;

    if (typeof item === 'string') {
      description = item.trim();
    } else {
      description = (item.description || item.itemText || item.name || '').trim();
      qty = item.qty !== undefined && item.qty !== null ? Number(item.qty) : 1;
      unit = item.unit || 'ud';
      notes = item.notes || null;
      if (item.clientName) clientName = item.clientName.trim();
      if (item.budgetId) budgetId = item.budgetId.trim();
    }

    if (!description) continue;

    // Si hay budgetId, validar que pertenezca al mismo tenant si es posible
    if (budgetId && companyId) {
      const bRow = db.prepare('SELECT company_id FROM budgets WHERE id = ?').get(budgetId);
      if (bRow && bRow.company_id && bRow.company_id !== companyId) {
        console.warn(`🛑 [Seguridad Tenant] Intento de asociar item de compra a presupuesto '${budgetId}' de otro tenant.`);
        continue;
      }
    }

    const id = `MAT-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    stmt.run(id, companyId, cleanPhone, clientName, budgetId, description, qty, unit, notes, now);
    inserted.push({
      id,
      companyId,
      companyPhone: cleanPhone,
      clientName,
      budgetId,
      description,
      qty,
      unit,
      status: 'PENDING',
      notes,
      createdAt: now
    });
  }

  return inserted;
}

export function listShoppingItems(companyContextOrIdOrPhone, filter = 'pending', clientQuery = null) {
  if (!companyContextOrIdOrPhone) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  const tenantFilter = companyId 
    ? "(company_id = ? OR (company_id IS NULL AND company_phone = ?))"
    : "company_phone = ?";
  const params = companyId ? [companyId, cleanPhone || ''] : [cleanPhone];

  let query = `SELECT * FROM shopping_items WHERE ${tenantFilter}`;

  if (filter === 'pending') {
    query += " AND status = 'PENDING'";
  } else if (filter === 'bought') {
    query += " AND status = 'BOUGHT'";
  }

  if (clientQuery && typeof clientQuery === 'string' && clientQuery.trim() !== '') {
    query += " AND LOWER(client_name) LIKE ?";
    params.push(`%${clientQuery.trim().toLowerCase()}%`);
  }

  query += " ORDER BY status ASC, client_name ASC, created_at DESC";

  const rows = db.prepare(query).all(...params);
  return rows.map(r => ({
    id: r.id,
    companyId: r.company_id,
    companyPhone: r.company_phone,
    clientName: r.client_name,
    budgetId: r.budget_id,
    description: r.description,
    qty: r.qty,
    unit: r.unit,
    status: r.status,
    notes: r.notes,
    createdAt: r.created_at,
    boughtAt: r.bought_at
  }));
}

export function markShoppingItemBought(companyContextOrIdOrPhone, queryOrId, clientQuery = null) {
  if (!companyContextOrIdOrPhone || !queryOrId) return [];
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;
  const cleanQuery = String(queryOrId).trim().toLowerCase();
  const now = new Date().toISOString();

  const tenantFilter = companyId 
    ? "(company_id = ? OR (company_id IS NULL AND company_phone = ?))"
    : "company_phone = ?";
  const params = companyId ? [companyId, cleanPhone || ''] : [cleanPhone];

  let sql = `
    SELECT * FROM shopping_items
    WHERE ${tenantFilter} AND status = 'PENDING'
      AND (id = ? OR LOWER(description) LIKE ?)
  `;
  params.push(queryOrId, `%${cleanQuery}%`);

  if (clientQuery && typeof clientQuery === 'string' && clientQuery.trim() !== '') {
    sql += " AND LOWER(client_name) LIKE ?";
    params.push(`%${clientQuery.trim().toLowerCase()}%`);
  }

  const rows = db.prepare(sql).all(...params);
  if (rows.length === 0) return [];

  const updateStmt = db.prepare(`
    UPDATE shopping_items
    SET status = 'BOUGHT', bought_at = ?
    WHERE id = ?
  `);

  const updated = [];
  for (const r of rows) {
    updateStmt.run(now, r.id);
    updated.push({
      id: r.id,
      companyId: r.company_id,
      companyPhone: r.company_phone,
      clientName: r.client_name,
      budgetId: r.budget_id,
      description: r.description,
      qty: r.qty,
      unit: r.unit,
      status: 'BOUGHT',
      boughtAt: now
    });
  }
  return updated;
}

export function clearShoppingList(companyContextOrIdOrPhone) {
  if (!companyContextOrIdOrPhone) return { deletedCount: 0 };
  const tenant = resolveCompanyTenant(companyContextOrIdOrPhone);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone;

  let result = { changes: 0 };
  if (companyId) {
    result = db.prepare("DELETE FROM shopping_items WHERE company_id = ? OR (company_id IS NULL AND company_phone = ?)").run(companyId, cleanPhone || '');
  } else if (cleanPhone) {
    result = db.prepare("DELETE FROM shopping_items WHERE company_phone = ?").run(cleanPhone);
  }
  return { deletedCount: result.changes || 0 };
}

// ─── Métodos de Modo Obra (Memoria y Estado de Obra en Vivo) ─────────────────

export function getWorkMemory(phoneOrCompany, clientOrBudgetId = null) {
  const tenant = resolveCompanyTenant(phoneOrCompany);
  const companyId = tenant?.companyId;
  const cleanPhone = tenant?.phone || String(phoneOrCompany || '').replace(/\D/g, '');
  
  // 1. Buscar presupuesto correspondiente
  let query = companyId 
    ? 'SELECT * FROM budgets WHERE (company_id = ? OR company_phone = ?)' 
    : 'SELECT * FROM budgets WHERE company_phone = ?';
  const params = companyId ? [companyId, cleanPhone] : [cleanPhone];

  if (clientOrBudgetId) {
    const q = String(clientOrBudgetId).trim().toLowerCase();
    query += ' AND (LOWER(id) = ? OR LOWER(client_name) LIKE ?)';
    params.push(q, `%${q}%`);
  }
  query += ' ORDER BY updated_at DESC LIMIT 1';

  const budgetRow = db.prepare(query).get(...params);
  if (!budgetRow) return null;

  let parsed = null;
  try { parsed = JSON.parse(budgetRow.data_json); } catch(e) {}

  const budgetId = budgetRow.id;
  const clientName = budgetRow.client_name || parsed?.client?.name || 'Cliente Particular';
  const clientAddress = budgetRow.client_address || parsed?.client?.address || 'Ubicación según visita';
  const clientPhone = budgetRow.client_phone || parsed?.client?.phone || null;
  const totalAmount = budgetRow.total_amount || parsed?.financials?.totalAmount || 0;

  // 2. Pagos acumulados
  const paymentRows = db.prepare('SELECT amount FROM payments WHERE budget_id = ?').all(budgetId);
  const totalPaid = paymentRows.reduce((sum, p) => sum + (p.amount || 0), 0);
  const remainingBalance = Math.max(0, totalAmount - totalPaid);

  // 3. Fechas de obra
  const workMemory = parsed?.workMemory || {};
  const startDate = workMemory.startDate || null;
  const estimatedEndDate = workMemory.estimatedEndDate || null;

  // 4. Materiales asociados (por budgetId o por nombre de cliente)
  const shopTenantFilter = companyId 
    ? "(company_id = ? OR (company_id IS NULL AND company_phone = ?))"
    : "company_phone = ?";
  const shopParams = companyId ? [companyId, cleanPhone || '', budgetId, clientName] : [cleanPhone, budgetId, clientName];

  const materialsRows = db.prepare(`
    SELECT id, description, qty, unit, status, created_at, bought_at
    FROM shopping_items
    WHERE ${shopTenantFilter} AND (budget_id = ? OR LOWER(client_name) = LOWER(?))
    ORDER BY created_at ASC
  `).all(...shopParams);

  const materialsBought = [];
  const materialsPending = [];

  for (const m of materialsRows) {
    const itemObj = {
      id: m.id,
      description: m.description,
      qty: m.qty,
      unit: m.unit
    };
    if (m.status === 'BOUGHT') {
      materialsBought.push(itemObj);
    } else {
      materialsPending.push(itemObj);
    }
  }

  // 5. Tareas y partidas presupuestadas + tareas extra
  const tasksDone = [];
  const tasksPending = [];

  const items = parsed?.items || [];
  items.forEach((item, idx) => {
    const taskObj = {
      id: item.id || idx + 1,
      description: item.description,
      isDone: Boolean(item.isDone || item.status === 'DONE'),
      source: 'budget_item'
    };
    if (taskObj.isDone) {
      tasksDone.push(taskObj);
    } else {
      tasksPending.push(taskObj);
    }
  });

  const extraTasks = workMemory.extraTasks || [];
  extraTasks.forEach(task => {
    const taskObj = {
      id: task.id,
      description: task.description,
      isDone: Boolean(task.isDone),
      source: 'extra_task'
    };
    if (taskObj.isDone) {
      tasksDone.push(taskObj);
    } else {
      tasksPending.push(taskObj);
    }
  });

  return {
    budgetId,
    clientName,
    clientAddress,
    clientPhone,
    totalAmount,
    totalPaid,
    remainingBalance,
    startDate,
    estimatedEndDate,
    materials: {
      bought: materialsBought,
      pending: materialsPending,
      totalCount: materialsRows.length
    },
    tasks: {
      done: tasksDone,
      pending: tasksPending,
      totalCount: tasksDone.length + tasksPending.length
    },
    rawBudget: parsed
  };
}

export function updateWorkTaskStatus(phone, clientOrBudgetId, taskQuery, isDone = true) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  if (!taskQuery) return null;

  // Buscar presupuesto
  let query = 'SELECT * FROM budgets WHERE company_phone = ?';
  const params = [cleanPhone];

  if (clientOrBudgetId) {
    const q = String(clientOrBudgetId).trim().toLowerCase();
    query += ' AND (LOWER(id) = ? OR LOWER(client_name) LIKE ?)';
    params.push(q, `%${q}%`);
  }
  query += ' ORDER BY updated_at DESC LIMIT 1';

  const budgetRow = db.prepare(query).get(...params);
  if (!budgetRow) return null;

  let parsed = null;
  try { parsed = JSON.parse(budgetRow.data_json); } catch(e) {}
  if (!parsed || !parsed.items) return null;

  const tQuery = String(taskQuery).trim().toLowerCase();
  let matchedTask = null;

  // 1. Buscar en items del presupuesto
  for (const it of parsed.items) {
    if (it.description && it.description.toLowerCase().includes(tQuery)) {
      it.isDone = Boolean(isDone);
      it.status = isDone ? 'DONE' : 'PENDING';
      matchedTask = { description: it.description, isDone: it.isDone };
      break;
    }
  }

  // 2. Si no se encontró en items, buscar en extraTasks
  if (!matchedTask) {
    parsed.workMemory = parsed.workMemory || {};
    parsed.workMemory.extraTasks = parsed.workMemory.extraTasks || [];
    for (const et of parsed.workMemory.extraTasks) {
      if (et.description && et.description.toLowerCase().includes(tQuery)) {
        et.isDone = Boolean(isDone);
        matchedTask = { description: et.description, isDone: et.isDone };
        break;
      }
    }
  }

  // 3. Si sigue sin existir y el usuario dijo que ya está hecha, podemos añadirla a extraTasks directamente
  if (!matchedTask) {
    parsed.workMemory = parsed.workMemory || {};
    parsed.workMemory.extraTasks = parsed.workMemory.extraTasks || [];
    const newTask = {
      id: `TASK-${Date.now()}`,
      description: taskQuery.trim(),
      isDone: Boolean(isDone)
    };
    parsed.workMemory.extraTasks.push(newTask);
    matchedTask = { description: newTask.description, isDone: newTask.isDone };
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE budgets SET data_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(parsed),
    now,
    budgetRow.id
  );

  return {
    budgetId: budgetRow.id,
    clientName: budgetRow.client_name,
    task: matchedTask,
    workMemory: getWorkMemory(cleanPhone, budgetRow.id)
  };
}

export function updateWorkDates(phone, clientOrBudgetId, startDate, estimatedEndDate) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');

  let query = 'SELECT * FROM budgets WHERE company_phone = ?';
  const params = [cleanPhone];

  if (clientOrBudgetId) {
    const q = String(clientOrBudgetId).trim().toLowerCase();
    query += ' AND (LOWER(id) = ? OR LOWER(client_name) LIKE ?)';
    params.push(q, `%${q}%`);
  }
  query += ' ORDER BY updated_at DESC LIMIT 1';

  const budgetRow = db.prepare(query).get(...params);
  if (!budgetRow) return null;

  let parsed = null;
  try { parsed = JSON.parse(budgetRow.data_json); } catch(e) {}
  if (!parsed) return null;

  parsed.workMemory = parsed.workMemory || {};
  if (startDate) parsed.workMemory.startDate = startDate;
  if (estimatedEndDate) parsed.workMemory.estimatedEndDate = estimatedEndDate;

  const now = new Date().toISOString();
  db.prepare('UPDATE budgets SET data_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(parsed),
    now,
    budgetRow.id
  );

  return {
    budgetId: budgetRow.id,
    clientName: budgetRow.client_name,
    startDate: parsed.workMemory.startDate,
    estimatedEndDate: parsed.workMemory.estimatedEndDate
  };
}

// ─── Desambiguación de Clientes Homónimos y Gestión de Distintivos ──────────

/**
 * Busca clientes/obras que coincidan con un nombre o término de búsqueda.
 * Permite detectar si existen múltiples personas con el mismo nombre y apellido.
 */
export function findClientsByName(phone, clientNameQuery) {
  if (!clientNameQuery) return [];
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const q = String(clientNameQuery).trim().toLowerCase();

  const rows = db.prepare(`
    SELECT id, client_name, client_address, client_phone, total_amount, status, created_at, updated_at, data_json
    FROM budgets
    WHERE company_phone = ? AND (
      LOWER(client_name) = ? OR
      LOWER(client_name) LIKE ? OR
      LOWER(client_address) LIKE ? OR
      LOWER(id) = ?
    )
    ORDER BY updated_at DESC
  `).all(cleanPhone, q, `%${q}%`, `%${q}%`, q);

  return rows.map(r => {
    let parsed = null;
    try { parsed = JSON.parse(r.data_json); } catch(e) {}
    return {
      id: r.id,
      clientName: r.client_name,
      clientAddress: r.client_address || parsed?.client?.address || 'Sin dirección registrada',
      clientPhone: r.client_phone || parsed?.client?.phone || null,
      totalAmount: r.total_amount || parsed?.financials?.totalAmount || 0,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  });
}

/**
 * Renombra o añade un distintivo a un cliente/obra existente en la base de datos.
 * Actualiza en cascada presupuestos, compras y facturas vinculadas.
 */
export function renameClientBudget(phone, budgetIdOrQuery, newNameWithBadge) {
  if (!budgetIdOrQuery || !newNameWithBadge) return null;
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const newName = String(newNameWithBadge).trim();

  // Localizar el presupuesto
  let budgetRow = db.prepare('SELECT * FROM budgets WHERE company_phone = ? AND id = ?').get(cleanPhone, budgetIdOrQuery);
  if (!budgetRow) {
    const q = String(budgetIdOrQuery).trim().toLowerCase();
    budgetRow = db.prepare(`
      SELECT * FROM budgets 
      WHERE company_phone = ? AND (LOWER(client_name) = ? OR LOWER(client_name) LIKE ?)
      ORDER BY updated_at DESC LIMIT 1
    `).get(cleanPhone, q, `%${q}%`);
  }

  if (!budgetRow) return null;

  const oldName = budgetRow.client_name;
  let parsed = null;
  try { parsed = JSON.parse(budgetRow.data_json); } catch(e) {}
  if (parsed && parsed.client) {
    parsed.client.name = newName;
  }

  const now = new Date().toISOString();

  // 1. Actualizar budget
  db.prepare(`
    UPDATE budgets 
    SET client_name = ?, data_json = ?, updated_at = ?
    WHERE id = ?
  `).run(newName, parsed ? JSON.stringify(parsed) : budgetRow.data_json, now, budgetRow.id);

  // 2. Actualizar compras vinculadas (por budget_id o por nombre anterior de cliente)
  const shopTenantFilter = budgetRow.company_id
    ? "(company_id = ? OR (company_id IS NULL AND company_phone = ?))"
    : "company_phone = ?";
  const shopParams = budgetRow.company_id
    ? [newName, budgetRow.company_id, cleanPhone, budgetRow.id, oldName]
    : [newName, cleanPhone, budgetRow.id, oldName];

  db.prepare(`
    UPDATE shopping_items
    SET client_name = ?
    WHERE ${shopTenantFilter} AND (budget_id = ? OR client_name = ?)
  `).run(...shopParams);

  // 3. Actualizar facturas vinculadas
  db.prepare(`
    UPDATE invoices
    SET client_name = ?
    WHERE company_phone = ? AND budget_id = ?
  `).run(newName, cleanPhone, budgetRow.id);

  return {
    budgetId: budgetRow.id,
    oldName,
    newName,
    clientAddress: budgetRow.client_address
  };
}

// ─── Métodos de Tracking y Persistencia de Mensajes (Cola y Deduplicación) ───

/**
 * Registra un mensaje entrante en la tabla messages de SQLite con estado inicial RECEIVED.
 * Si ya existía por whatsapp_message_id, no lo duplica.
 * Soporta companyId / companyContext para mensajes autenticados, y NULL para no autenticados.
 */
export function recordIncomingMessage({
  id = null,
  whatsappMessageId,
  companyContextOrId = null,
  companyId = null,
  businessId = null,
  chatId,
  senderPhone,
  content = '',
  status = 'RECEIVED'
}) {
  if (!whatsappMessageId) return null;
  const msgId = id || `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const now = new Date().toISOString();

  // Model injection defense: resolver companyId canónico estrictamente desde la autoridad
  let canonicalCompanyId = null;
  const authTarget = companyContextOrId || companyId;
  if (authTarget) {
    const tenant = resolveCompanyTenant(authTarget);
    if (tenant && tenant.companyId) {
      canonicalCompanyId = tenant.companyId;
    } else if (typeof authTarget === 'string' && isUuid(authTarget.trim())) {
      const comp = db.prepare('SELECT id FROM companies WHERE id = ?').get(authTarget.trim());
      if (comp) canonicalCompanyId = comp.id;
    }
  }

  const cols = db.prepare('PRAGMA table_info("messages")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  if (hasCompanyIdCol) {
    const stmt = db.prepare(`
      INSERT INTO messages (
        id, whatsapp_message_id, company_id, business_id,
        chat_id, sender_phone, content, timestamp, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(whatsapp_message_id) DO NOTHING
    `);
    stmt.run(
      msgId,
      whatsappMessageId,
      canonicalCompanyId,
      businessId || '',
      chatId || '',
      senderPhone || '',
      content || '',
      now,
      status
    );
  } else {
    const stmt = db.prepare(`
      INSERT INTO messages (
        id, whatsapp_message_id, business_id,
        chat_id, sender_phone, content, timestamp, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(whatsapp_message_id) DO NOTHING
    `);
    stmt.run(
      msgId,
      whatsappMessageId,
      businessId || '',
      chatId || '',
      senderPhone || '',
      content || '',
      now,
      status
    );
  }

  return getMessageByWhatsappId(whatsappMessageId);
}

/**
 * Actualiza el estado de procesamiento de un mensaje en SQLite:
 * RECEIVED -> QUEUED -> PROCESSING -> PROCESSED (o FAILED / REJECTED)
 * Soporta llamadas técnicas de gateway (wamId, status) o tenant-scoped (context, wamId, status).
 */
export function updateMessageStatus(companyContextOrWamId, whatsappMessageIdOrStatus, maybeStatus = null) {
  let whatsappMessageId = null;
  let status = null;
  let targetCompanyId = null;

  if (maybeStatus !== null) {
    // Llamada tenant-scoped: updateMessageStatus(context, wamId, status)
    const tenant = resolveCompanyTenant(companyContextOrWamId);
    targetCompanyId = tenant?.companyId || (typeof companyContextOrWamId === 'string' && isUuid(companyContextOrWamId.trim()) ? companyContextOrWamId.trim() : null);
    whatsappMessageId = whatsappMessageIdOrStatus;
    status = maybeStatus;
  } else {
    // Llamada técnica interna de gateway: updateMessageStatus(wamId, status)
    whatsappMessageId = companyContextOrWamId;
    status = whatsappMessageIdOrStatus;
  }

  if (!whatsappMessageId || !status) return false;

  const cols = db.prepare('PRAGMA table_info("messages")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  if (targetCompanyId && hasCompanyIdCol) {
    const res = db.prepare('UPDATE messages SET status = ? WHERE whatsapp_message_id = ? AND company_id = ?').run(status, whatsappMessageId, targetCompanyId);
    return res.changes > 0;
  } else {
    const res = db.prepare('UPDATE messages SET status = ? WHERE whatsapp_message_id = ?').run(status, whatsappMessageId);
    return res.changes > 0;
  }
}

/**
 * Obtiene un mensaje por su whatsapp_message_id.
 * Soporta llamada interna (wamId) o tenant-scoped con Zero-Disclosure (context, wamId).
 */
export function getMessageByWhatsappId(companyContextOrWamId, maybeWamId = null) {
  let whatsappMessageId = null;
  let targetCompanyId = null;

  if (maybeWamId !== null) {
    const tenant = resolveCompanyTenant(companyContextOrWamId);
    targetCompanyId = tenant?.companyId || (typeof companyContextOrWamId === 'string' && isUuid(companyContextOrWamId.trim()) ? companyContextOrWamId.trim() : null);
    whatsappMessageId = maybeWamId;
  } else {
    whatsappMessageId = companyContextOrWamId;
  }

  if (!whatsappMessageId) return null;

  const cols = db.prepare('PRAGMA table_info("messages")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  const stmt = db.prepare('SELECT * FROM messages WHERE whatsapp_message_id = ?');
  const row = stmt.get(whatsappMessageId);
  if (!row) return null;

  // Zero-Disclosure: si se solicitó con ámbito tenant y no pertenece a dicho tenant -> null
  if (targetCompanyId && hasCompanyIdCol && row.company_id !== targetCompanyId) {
    return null;
  }

  return {
    id: row.id,
    whatsappMessageId: row.whatsapp_message_id,
    companyId: row.company_id || null,
    company_id: row.company_id || null,
    businessId: row.business_id,
    chatId: row.chat_id,
    senderPhone: row.sender_phone,
    content: row.content,
    timestamp: row.timestamp,
    status: row.status
  };
}

/**
 * Obtiene un mensaje de forma tenant-scoped con Zero-Disclosure garantizado.
 */
export function getMessage(companyContextOrId, messageIdOrWamId) {
  if (messageIdOrWamId === undefined) {
    console.warn("🛑 [Seguridad Tenant] getMessage invocado sin tenant context obligatorio. Retornando null.");
    return null;
  }
  if (!companyContextOrId || !messageIdOrWamId) return null;

  const tenant = resolveCompanyTenant(companyContextOrId);
  const companyId = tenant?.companyId || (typeof companyContextOrId === 'string' && isUuid(companyContextOrId.trim()) ? companyContextOrId.trim() : null);
  if (!companyId) return null;

  const cols = db.prepare('PRAGMA table_info("messages")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  if (!hasCompanyIdCol) {
    const row = db.prepare('SELECT * FROM messages WHERE id = ? OR whatsapp_message_id = ?').get(messageIdOrWamId, messageIdOrWamId);
    if (!row) return null;
    return {
      id: row.id,
      whatsappMessageId: row.whatsapp_message_id,
      companyId: null,
      company_id: null,
      businessId: row.business_id,
      chatId: row.chat_id,
      senderPhone: row.sender_phone,
      content: row.content,
      timestamp: row.timestamp,
      status: row.status
    };
  }

  const row = db.prepare('SELECT * FROM messages WHERE (id = ? OR whatsapp_message_id = ?) AND company_id = ?').get(messageIdOrWamId, messageIdOrWamId, companyId);
  if (!row) return null;

  return {
    id: row.id,
    whatsappMessageId: row.whatsapp_message_id,
    companyId: row.company_id,
    company_id: row.company_id,
    businessId: row.business_id,
    chatId: row.chat_id,
    senderPhone: row.sender_phone,
    content: row.content,
    timestamp: row.timestamp,
    status: row.status
  };
}

/**
 * Comprueba si un mensaje ya está siendo procesado, ya fue procesado o fue rechazado
 * para evitar ejecuciones duplicadas en caso de reenvíos de WhatsApp/API.
 */
export function isMessageAlreadyProcessed(whatsappMessageId) {
  if (!whatsappMessageId) return false;
  const stmt = db.prepare('SELECT status FROM messages WHERE whatsapp_message_id = ?');
  const row = stmt.get(whatsappMessageId);
  if (!row) return false;
  return row.status === 'PROCESSING' || row.status === 'PROCESSED' || row.status === 'REJECTED';
}

/**
 * Lista los mensajes recientes para auditoría y debug con aislamiento tenant-scoped.
 * Si se pasa companyContext o UUID, aísla estrictamente por company_id.
 * Soporta firma legacy: listRecentMessages(chatId, limit)
 */
export function listRecentMessages(companyContextOrChatId, limitOrChatId = 50, maybeLimit = 50) {
  if (!companyContextOrChatId) return [];

  let companyId = null;
  let chatId = null;
  let limit = 50;

  const tenant = resolveCompanyTenant(companyContextOrChatId);
  if (tenant?.companyId) {
    companyId = tenant.companyId;
    if (typeof limitOrChatId === 'string') {
      chatId = limitOrChatId;
      limit = Number(maybeLimit) || 50;
    } else {
      limit = Number(limitOrChatId) || 50;
    }
  } else if (typeof companyContextOrChatId === 'string' && isUuid(companyContextOrChatId.trim())) {
    companyId = companyContextOrChatId.trim();
    if (typeof limitOrChatId === 'string') {
      chatId = limitOrChatId;
      limit = Number(maybeLimit) || 50;
    } else {
      limit = Number(limitOrChatId) || 50;
    }
  } else {
    // Modo legacy por chatId
    chatId = String(companyContextOrChatId);
    limit = Number(limitOrChatId) || 50;
  }

  const cols = db.prepare('PRAGMA table_info("messages")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let rows = [];
  if (hasCompanyIdCol && companyId) {
    if (chatId) {
      rows = db.prepare('SELECT * FROM messages WHERE company_id = ? AND chat_id = ? ORDER BY timestamp DESC LIMIT ?').all(companyId, chatId, limit);
    } else {
      rows = db.prepare('SELECT * FROM messages WHERE company_id = ? ORDER BY timestamp DESC LIMIT ?').all(companyId, limit);
    }
  } else if (chatId) {
    rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?').all(chatId, limit);
  }

  return rows.map(row => ({
    id: row.id,
    whatsappMessageId: row.whatsapp_message_id,
    companyId: row.company_id || companyId,
    company_id: row.company_id || companyId,
    businessId: row.business_id,
    chatId: row.chat_id,
    senderPhone: row.sender_phone,
    content: row.content,
    timestamp: row.timestamp,
    status: row.status
  }));
}

// ─── Métodos de Gestión Fiscal y Libros Registro (AEAT / Gestoría) ────────────

/**
 * Obtiene el perfil fiscal completo de un negocio.
 * Soporta companyId (UUID canónico), authenticatedContext ({ companyId, ... }),
 * o identificador legacy (teléfono de WhatsApp de una compañía registrada).
 */
export function getTaxProfile(companyContextOrId) {
  if (!companyContextOrId) return null;

  let canonicalCompanyId = null;
  let legacyPhone = null;

  if (typeof companyContextOrId === 'object') {
    canonicalCompanyId = companyContextOrId.companyId || companyContextOrId.id || null;
    if (!canonicalCompanyId && (companyContextOrId.phone || companyContextOrId.company?.phone)) {
      const rawPhone = companyContextOrId.company?.phone || companyContextOrId.phone;
      legacyPhone = String(rawPhone).replace(/\D/g, '');
      const compRow = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(legacyPhone);
      if (compRow) {
        canonicalCompanyId = compRow.id;
        legacyPhone = String(compRow.phone).replace(/\D/g, '');
      }
    }
  } else if (typeof companyContextOrId === 'string') {
    const trimmed = companyContextOrId.trim();
    if (isUuid(trimmed)) {
      canonicalCompanyId = trimmed;
    } else {
      // Compatibilidad legacy: buscar por teléfono
      legacyPhone = trimmed.replace(/\D/g, '');
      if (legacyPhone) {
        const compRow = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(legacyPhone);
        if (compRow) {
          canonicalCompanyId = compRow.id;
          legacyPhone = String(compRow.phone).replace(/\D/g, '');
        }
      }
    }
  }

  // Si tenemos canonicalCompanyId pero no legacyPhone, obtener phone de companies
  if (canonicalCompanyId && !legacyPhone) {
    const compRow = db.prepare('SELECT id, phone FROM companies WHERE id = ?').get(canonicalCompanyId);
    if (compRow && compRow.phone) {
      legacyPhone = String(compRow.phone).replace(/\D/g, '');
    }
  }

  // Verificar si la tabla tiene ya la columna company_id (post-migración 007)
  const cols = db.prepare('PRAGMA table_info("business_tax_profiles")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let row = null;
  if (hasCompanyIdCol && canonicalCompanyId) {
    row = db.prepare('SELECT * FROM business_tax_profiles WHERE company_id = ?').get(canonicalCompanyId);
  }
  // Fallback de compatibilidad por business_id si no se encontró por company_id o no existe la columna
  if (!row && legacyPhone) {
    row = db.prepare('SELECT * FROM business_tax_profiles WHERE business_id = ?').get(legacyPhone);
  }

  if (!row) {
    // Si aún no existe el perfil fiscal específico, inicializarlo a partir de la tabla companies
    let comp = null;
    if (canonicalCompanyId) {
      comp = getCompanyById(canonicalCompanyId);
    } else if (legacyPhone) {
      comp = getCompany(legacyPhone);
    }
    if (!comp || (!canonicalCompanyId && !legacyPhone)) return null;

    const resolvedCid = canonicalCompanyId || comp.id || comp.companyId || null;
    const resolvedBid = legacyPhone || (comp.phone ? String(comp.phone).replace(/\D/g, '') : null);

    return {
      companyId: resolvedCid,
      businessId: resolvedBid,
      legalName: comp.fiscalName || comp.name || 'Empresa de Reformas',
      taxId: comp.cif || '',
      legalForm: comp.entityType === 'empresa' ? 'SL' : 'AUTONOMO',
      economicActivity: comp.trade || 'Reformas y Construcción',
      iaeCode: '504.1',
      taxRegime: 'GENERAL',
      vatRegime: 'GENERAL',
      incomeTaxRegime: comp.entityType === 'empresa' ? 'IMPUESTO_SOCIEDADES' : 'ESTIMACION_DIRECTA_SIMPLIFICADA',
      vatFrequency: 'QUARTERLY',
      incomeTaxFrequency: comp.entityType === 'empresa' ? 'NOT_APPLICABLE' : 'QUARTERLY',
      irpfWithholdingApplicable: comp.irpfRate > 0 ? 1 : 0,
      defaultIrpfRate: Number(comp.irpfRate || 0),
      defaultVatRate: 21,
      accountingStartDate: `${new Date().getFullYear()}-01-01`,
      fiscalYear: new Date().getFullYear(),
      currentInvoiceSeries: comp.invoiceSeries || '2026-',
      verifactuStatus: 'PREPARED',
      gestorName: 'Asesoría Fiscal',
      gestorEmail: comp.gestoriaEmail || null,
      gestorPhone: null,
      gestorNotes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  return {
    companyId: row.company_id || canonicalCompanyId,
    businessId: row.business_id || legacyPhone,
    legalName: row.legal_name,
    taxId: row.tax_id,
    legalForm: row.legal_form,
    economicActivity: row.economic_activity,
    iaeCode: row.iae_code,
    taxRegime: row.tax_regime,
    vatRegime: row.vat_regime,
    incomeTaxRegime: row.income_tax_regime,
    vatFrequency: row.vat_frequency,
    incomeTaxFrequency: row.income_tax_frequency,
    irpfWithholdingApplicable: Boolean(row.irpf_withholding_applicable),
    defaultIrpfRate: Number(row.default_irpf_rate || 0),
    defaultVatRate: Number(row.default_vat_rate || 21),
    accountingStartDate: row.accounting_start_date,
    fiscalYear: Number(row.fiscal_year || 2026),
    currentInvoiceSeries: row.current_invoice_series,
    verifactuStatus: row.verifactu_status,
    gestorName: row.gestor_name,
    gestorEmail: row.gestor_email,
    gestorPhone: row.gestor_phone,
    gestorNotes: row.gestor_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Guarda o actualiza el perfil fiscal del negocio.
 * 
 * Tenant Hardening & Dual-Write:
 * - Requiere companyId (UUID) o authenticatedContext como autoridad canónica.
 * - Soporta adapter transitorio por teléfono legacy para compañías existentes.
 * - Inyección de modelo: cualquier company_id o business_id dentro de profileData es ignorado.
 * - Dual-write: escribe company_id como clave primaria y mantiene business_id sincronizado.
 */
export function saveTaxProfile(companyContextOrId, profileData = {}) {
  if (!companyContextOrId) {
    throw new Error("❌ [Tenant Boundary] saveTaxProfile requiere un companyId o contexto autenticado válido.");
  }

  let canonicalCompanyId = null;
  let canonicalPhone = null;

  if (typeof companyContextOrId === 'object') {
    canonicalCompanyId = companyContextOrId.companyId || companyContextOrId.id || null;
    if (!canonicalCompanyId && (companyContextOrId.phone || companyContextOrId.company?.phone)) {
      const rawPhone = companyContextOrId.company?.phone || companyContextOrId.phone;
      const clean = String(rawPhone).replace(/\D/g, '');
      const compRow = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(clean);
      if (compRow) {
        canonicalCompanyId = compRow.id;
        canonicalPhone = String(compRow.phone).replace(/\D/g, '');
      }
    }
  } else if (typeof companyContextOrId === 'string') {
    const trimmed = companyContextOrId.trim();
    if (isUuid(trimmed)) {
      canonicalCompanyId = trimmed;
    } else {
      // Compatibilidad legacy: buscar por teléfono
      const clean = trimmed.replace(/\D/g, '');
      if (clean) {
        const compRow = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(clean);
        if (compRow) {
          canonicalCompanyId = compRow.id;
          canonicalPhone = String(compRow.phone).replace(/\D/g, '');
        }
      }
    }
  }

  if (!canonicalCompanyId) {
    throw new Error("❌ [Tenant Boundary] saveTaxProfile: no se pudo resolver un tenant válido.");
  }

  const companyRow = db.prepare('SELECT id, phone FROM companies WHERE id = ?').get(canonicalCompanyId);
  if (!companyRow) {
    throw new Error(`❌ [Tenant Boundary] saveTaxProfile: la empresa '${canonicalCompanyId}' no existe en la base de datos.`);
  }

  if (!canonicalPhone && companyRow.phone) {
    canonicalPhone = String(companyRow.phone).replace(/\D/g, '');
  }

  // Defensa contra inyección: Ignorar cualquier companyId o businessId provisto en el payload
  const { companyId: _ignoredCid, businessId: _ignoredBid, ...safeProfileData } = profileData;

  const existing = getTaxProfile(canonicalCompanyId) || {};
  const updated = {
    ...existing,
    ...safeProfileData,
    companyId: canonicalCompanyId,
    businessId: canonicalPhone,
    updatedAt: new Date().toISOString()
  };

  const cols = db.prepare('PRAGMA table_info("business_tax_profiles")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  if (hasCompanyIdCol) {
    const stmt = db.prepare(`
      INSERT INTO business_tax_profiles (
        company_id, business_id, legal_name, tax_id, legal_form, economic_activity, iae_code,
        tax_regime, vat_regime, income_tax_regime, vat_frequency, income_tax_frequency,
        irpf_withholding_applicable, default_irpf_rate, default_vat_rate,
        accounting_start_date, fiscal_year, current_invoice_series, verifactu_status,
        gestor_name, gestor_email, gestor_phone, gestor_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id) DO UPDATE SET
        business_id = excluded.business_id,
        legal_name = excluded.legal_name,
        tax_id = excluded.tax_id,
        legal_form = excluded.legal_form,
        economic_activity = excluded.economic_activity,
        iae_code = excluded.iae_code,
        tax_regime = excluded.tax_regime,
        vat_regime = excluded.vat_regime,
        income_tax_regime = excluded.income_tax_regime,
        vat_frequency = excluded.vat_frequency,
        income_tax_frequency = excluded.income_tax_frequency,
        irpf_withholding_applicable = excluded.irpf_withholding_applicable,
        default_irpf_rate = excluded.default_irpf_rate,
        default_vat_rate = excluded.default_vat_rate,
        accounting_start_date = excluded.accounting_start_date,
        fiscal_year = excluded.fiscal_year,
        current_invoice_series = excluded.current_invoice_series,
        verifactu_status = excluded.verifactu_status,
        gestor_name = excluded.gestor_name,
        gestor_email = excluded.gestor_email,
        gestor_phone = excluded.gestor_phone,
        gestor_notes = excluded.gestor_notes,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      updated.companyId,
      updated.businessId,
      updated.legalName,
      updated.taxId,
      updated.legalForm,
      updated.economicActivity,
      updated.iaeCode,
      updated.taxRegime,
      updated.vatRegime,
      updated.incomeTaxRegime,
      updated.vatFrequency,
      updated.incomeTaxFrequency,
      updated.irpfWithholdingApplicable ? 1 : 0,
      updated.defaultIrpfRate,
      updated.defaultVatRate,
      updated.accountingStartDate,
      updated.fiscalYear,
      updated.currentInvoiceSeries,
      updated.verifactuStatus,
      updated.gestorName,
      updated.gestorEmail,
      updated.gestorPhone,
      updated.gestorNotes,
      updated.createdAt,
      updated.updatedAt
    );
  } else {
    // Compatibilidad pre-migración 007
    const stmt = db.prepare(`
      INSERT INTO business_tax_profiles (
        business_id, legal_name, tax_id, legal_form, economic_activity, iae_code,
        tax_regime, vat_regime, income_tax_regime, vat_frequency, income_tax_frequency,
        irpf_withholding_applicable, default_irpf_rate, default_vat_rate,
        accounting_start_date, fiscal_year, current_invoice_series, verifactu_status,
        gestor_name, gestor_email, gestor_phone, gestor_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(business_id) DO UPDATE SET
        legal_name = excluded.legal_name,
        tax_id = excluded.tax_id,
        legal_form = excluded.legal_form,
        economic_activity = excluded.economic_activity,
        iae_code = excluded.iae_code,
        tax_regime = excluded.tax_regime,
        vat_regime = excluded.vat_regime,
        income_tax_regime = excluded.income_tax_regime,
        vat_frequency = excluded.vat_frequency,
        income_tax_frequency = excluded.income_tax_frequency,
        irpf_withholding_applicable = excluded.irpf_withholding_applicable,
        default_irpf_rate = excluded.default_irpf_rate,
        default_vat_rate = excluded.default_vat_rate,
        accounting_start_date = excluded.accounting_start_date,
        fiscal_year = excluded.fiscal_year,
        current_invoice_series = excluded.current_invoice_series,
        verifactu_status = excluded.verifactu_status,
        gestor_name = excluded.gestor_name,
        gestor_email = excluded.gestor_email,
        gestor_phone = excluded.gestor_phone,
        gestor_notes = excluded.gestor_notes,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      updated.businessId,
      updated.legalName,
      updated.taxId,
      updated.legalForm,
      updated.economicActivity,
      updated.iaeCode,
      updated.taxRegime,
      updated.vatRegime,
      updated.incomeTaxRegime,
      updated.vatFrequency,
      updated.incomeTaxFrequency,
      updated.irpfWithholdingApplicable ? 1 : 0,
      updated.defaultIrpfRate,
      updated.defaultVatRate,
      updated.accountingStartDate,
      updated.fiscalYear,
      updated.currentInvoiceSeries,
      updated.verifactuStatus,
      updated.gestorName,
      updated.gestorEmail,
      updated.gestorPhone,
      updated.gestorNotes,
      updated.createdAt,
      updated.updatedAt
    );
  }

  return getTaxProfile(canonicalCompanyId);
}

/**
 * Elimina el perfil fiscal de un tenant de forma aislada y controlada.
 */
export function deleteTaxProfile(companyContextOrId) {
  if (!companyContextOrId) return false;
  let canonicalCompanyId = null;
  if (typeof companyContextOrId === 'object') {
    canonicalCompanyId = companyContextOrId.companyId || companyContextOrId.id || null;
  } else if (typeof companyContextOrId === 'string' && isUuid(companyContextOrId.trim())) {
    canonicalCompanyId = companyContextOrId.trim();
  }
  if (!canonicalCompanyId) {
    const legacyId = resolveLegacyBusinessId(companyContextOrId);
    if (!legacyId) return false;
    const comp = db.prepare('SELECT id FROM companies WHERE phone = ?').get(legacyId);
    canonicalCompanyId = comp?.id || null;
  }
  if (!canonicalCompanyId) return false;

  const cols = db.prepare('PRAGMA table_info("business_tax_profiles")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');
  if (hasCompanyIdCol) {
    const result = db.prepare('DELETE FROM business_tax_profiles WHERE company_id = ?').run(canonicalCompanyId);
    return result.changes > 0;
  } else {
    const legacyPhone = resolveLegacyBusinessId(canonicalCompanyId);
    if (!legacyPhone) return false;
    const result = db.prepare('DELETE FROM business_tax_profiles WHERE business_id = ?').run(legacyPhone);
    return result.changes > 0;
  }
}

/**
 * Guarda o actualiza una Factura Recibida (Compra / Proveedor)
 * 
 * Tenant Hardening & Dual-Write:
 * - Requiere companyId (UUID) o authenticatedContext como autoridad canónica.
 * - Soporta adapter transitorio por teléfono legacy para compañías existentes.
 * - Inyección de modelo: cualquier company_id o business_id dentro de inv es ignorado.
 * - Dual-write: escribe company_id como autoridad y mantiene business_id sincronizado.
 */
export function savePurchaseInvoice(companyContextOrId, inv = {}) {
  if (!companyContextOrId) {
    throw new Error("❌ [Tenant Boundary] savePurchaseInvoice requiere un companyId o contexto autenticado obligatorio.");
  }
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    throw new Error("❌ [Tenant Boundary] savePurchaseInvoice: no se pudo resolver un tenant válido.");
  }
  const { companyId, phone: cleanPhone } = tenant;

  // Defensa contra inyección: Ignorar company_id y business_id provistos en payload del modelo
  const {
    companyId: _ignoredCid,
    company_id: _ignoredCid2,
    businessId: _ignoredBid,
    business_id: _ignoredBid2,
    companyPhone: _ignoredPhone1,
    company_phone: _ignoredPhone2,
    phone: _ignoredPhone3,
    ...safeInv
  } = inv;

  const id = safeInv.id || `REC-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;

  const cols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  if (safeInv.id) {
    if (hasCompanyIdCol) {
      const existing = db.prepare('SELECT company_id, business_id FROM purchase_invoices WHERE id = ?').get(safeInv.id);
      if (existing && existing.company_id !== companyId) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de modificar factura recibida ${safeInv.id} de otro tenant.`);
        return null;
      }
    } else {
      const existing = db.prepare('SELECT business_id FROM purchase_invoices WHERE id = ?').get(safeInv.id);
      if (existing && existing.business_id !== cleanPhone) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de modificar factura recibida ${safeInv.id} de otro tenant.`);
        return null;
      }
    }
  }
  const now = new Date().toISOString();

  // Calcular periodo fiscal por fecha de factura si no viene dado
  let fiscalPeriod = safeInv.fiscalPeriod || safeInv.fiscal_period;
  const invDate = safeInv.invoiceDate || safeInv.issueDate || safeInv.issue_date || now.split('T')[0];
  if (!fiscalPeriod && invDate) {
    const d = new Date(invDate);
    if (!isNaN(d.getTime())) {
      const q = Math.floor(d.getMonth() / 3) + 1;
      fiscalPeriod = `${d.getFullYear()}_Q${q}`;
    }
  }
  if (!fiscalPeriod) {
    const q = Math.floor(new Date().getMonth() / 3) + 1;
    fiscalPeriod = `${new Date().getFullYear()}_Q${q}`;
  }

  const base = Number(safeInv.taxableBase ?? safeInv.taxBase ?? safeInv.baseAmount ?? 0);
  const vatRate = Number(safeInv.vatRate !== undefined ? safeInv.vatRate : 21);
  const vatAmount = Number(safeInv.vatAmount !== undefined ? safeInv.vatAmount : (base * vatRate) / 100);
  const total = Number(safeInv.totalAmount !== undefined ? safeInv.totalAmount : base + vatAmount);

  // Deducibilidad de IVA
  const deductibilityStatus = safeInv.deductibilityStatus || 'LIKELY_DEDUCTIBLE';
  const deductPercent = Number(safeInv.deductiblePercentage !== undefined ? safeInv.deductiblePercentage : (safeInv.vatDeductible === false || deductibilityStatus === 'NOT_DEDUCTIBLE' ? 0 : 100));
  const deductibleVat = deductibilityStatus === 'NOT_DEDUCTIBLE' || safeInv.vatDeductible === false ? 0 : (vatAmount * (deductPercent / 100));
  const isAsset = Boolean(safeInv.isInvestmentAsset || base >= 3005.06 || total >= 3005.06);

  if (hasCompanyIdCol) {
    const stmt = db.prepare(`
      INSERT INTO purchase_invoices (
        id, company_id, business_id, supplier_name, supplier_tax_id, invoice_number,
        invoice_date, operation_date, description, taxable_base, vat_rate,
        vat_amount, total_amount, deductible_vat_amount, deductibility_status,
        income_tax_relevance, expense_category, payment_status, payment_method,
        payment_date, document_path, is_investment_asset, fiscal_period, notes,
        data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        company_id = excluded.company_id,
        business_id = excluded.business_id,
        supplier_name = excluded.supplier_name,
        supplier_tax_id = excluded.supplier_tax_id,
        invoice_number = excluded.invoice_number,
        invoice_date = excluded.invoice_date,
        operation_date = excluded.operation_date,
        description = excluded.description,
        taxable_base = excluded.taxable_base,
        vat_rate = excluded.vat_rate,
        vat_amount = excluded.vat_amount,
        total_amount = excluded.total_amount,
        deductible_vat_amount = excluded.deductible_vat_amount,
        deductibility_status = excluded.deductibility_status,
        income_tax_relevance = excluded.income_tax_relevance,
        expense_category = excluded.expense_category,
        payment_status = excluded.payment_status,
        payment_method = excluded.payment_method,
        payment_date = excluded.payment_date,
        document_path = excluded.document_path,
        is_investment_asset = excluded.is_investment_asset,
        fiscal_period = excluded.fiscal_period,
        notes = excluded.notes,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      id,
      companyId,
      cleanPhone,
      safeInv.supplierName || 'Proveedor General',
      safeInv.supplierTaxId || null,
      safeInv.invoiceNumber || id,
      invDate,
      safeInv.operationDate || invDate,
      safeInv.description || 'Compra de materiales y suministros',
      Number(base.toFixed(2)),
      vatRate,
      Number(vatAmount.toFixed(2)),
      Number(total.toFixed(2)),
      Number(deductibleVat.toFixed(2)),
      deductibilityStatus,
      safeInv.incomeTaxRelevance || 'DEDUCTIBLE',
      safeInv.expenseCategory || safeInv.category || 'MATERIALES',
      safeInv.paymentStatus || 'PAGADA',
      safeInv.paymentMethod || 'Tarjeta',
      safeInv.paymentDate || invDate,
      safeInv.documentPath || null,
      isAsset ? 1 : 0,
      fiscalPeriod,
      safeInv.notes || null,
      JSON.stringify(inv),
      now,
      now
    );
  } else {
    // Compatibilidad pre-migración 009
    const stmt = db.prepare(`
      INSERT INTO purchase_invoices (
        id, business_id, supplier_name, supplier_tax_id, invoice_number,
        invoice_date, operation_date, description, taxable_base, vat_rate,
        vat_amount, total_amount, deductible_vat_amount, deductibility_status,
        income_tax_relevance, expense_category, payment_status, payment_method,
        payment_date, document_path, is_investment_asset, fiscal_period, notes,
        data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        business_id = excluded.business_id,
        supplier_name = excluded.supplier_name,
        supplier_tax_id = excluded.supplier_tax_id,
        invoice_number = excluded.invoice_number,
        invoice_date = excluded.invoice_date,
        operation_date = excluded.operation_date,
        description = excluded.description,
        taxable_base = excluded.taxable_base,
        vat_rate = excluded.vat_rate,
        vat_amount = excluded.vat_amount,
        total_amount = excluded.total_amount,
        deductible_vat_amount = excluded.deductible_vat_amount,
        deductibility_status = excluded.deductibility_status,
        income_tax_relevance = excluded.income_tax_relevance,
        expense_category = excluded.expense_category,
        payment_status = excluded.payment_status,
        payment_method = excluded.payment_method,
        payment_date = excluded.payment_date,
        document_path = excluded.document_path,
        is_investment_asset = excluded.is_investment_asset,
        fiscal_period = excluded.fiscal_period,
        notes = excluded.notes,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      id,
      cleanPhone,
      safeInv.supplierName || 'Proveedor General',
      safeInv.supplierTaxId || null,
      safeInv.invoiceNumber || id,
      invDate,
      safeInv.operationDate || invDate,
      safeInv.description || 'Compra de materiales y suministros',
      Number(base.toFixed(2)),
      vatRate,
      Number(vatAmount.toFixed(2)),
      Number(total.toFixed(2)),
      Number(deductibleVat.toFixed(2)),
      deductibilityStatus,
      safeInv.incomeTaxRelevance || 'DEDUCTIBLE',
      safeInv.expenseCategory || safeInv.category || 'MATERIALES',
      safeInv.paymentStatus || 'PAGADA',
      safeInv.paymentMethod || 'Tarjeta',
      safeInv.paymentDate || invDate,
      safeInv.documentPath || null,
      isAsset ? 1 : 0,
      fiscalPeriod,
      safeInv.notes || null,
      JSON.stringify(inv),
      now,
      now
    );
  }

  return getPurchaseInvoice(companyContextOrId, id);
}

/**
 * Obtiene una factura recibida por su ID (Tenant-Scoped)
 */
export function getPurchaseInvoice(companyContextOrId, id) {
  if (id === undefined) {
    console.warn("🛑 [Seguridad Tenant] getPurchaseInvoice invocado sin tenant context obligatorio. Retornando null.");
    return null;
  }
  if (!companyContextOrId || !id) return null;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] getPurchaseInvoice: no se pudo resolver un tenant válido.");
    return null;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let row = null;
  if (hasCompanyIdCol) {
    row = db.prepare('SELECT * FROM purchase_invoices WHERE id = ? AND company_id = ?').get(id, companyId);
    if (!row && cleanPhone) {
      row = db.prepare('SELECT * FROM purchase_invoices WHERE id = ? AND business_id = ?').get(id, cleanPhone);
    }
  } else {
    row = db.prepare('SELECT * FROM purchase_invoices WHERE id = ? AND business_id = ?').get(id, cleanPhone);
  }
  if (!row) return null;

  return {
    id: row.id,
    companyId: row.company_id || companyId,
    businessId: row.business_id || cleanPhone,
    supplierName: row.supplier_name,
    supplierTaxId: row.supplier_tax_id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    issueDate: row.invoice_date,
    operationDate: row.operation_date,
    description: row.description,
    taxableBase: Number(row.taxable_base) || 0,
    taxBase: Number(row.taxable_base) || 0,
    vatRate: row.vat_rate != null ? Number(row.vat_rate) : 21,
    vatAmount: row.vat_amount != null ? Number(row.vat_amount) : 0,
    totalAmount: Number(row.total_amount) || 0,
    deductibleVatAmount: Number(row.deductible_vat_amount) || 0,
    vatDeductible: row.deductibility_status !== 'NOT_DEDUCTIBLE' && Number(row.deductible_vat_amount) > 0,
    deductiblePercentage: row.deductibility_status === 'NOT_DEDUCTIBLE' ? 0 : 100,
    deductibilityStatus: row.deductibility_status,
    incomeTaxRelevance: row.income_tax_relevance,
    expenseCategory: row.expense_category,
    category: row.expense_category,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    paymentDate: row.payment_date,
    paidAmount: Number(row.total_amount) || 0,
    documentPath: row.document_path,
    isInvestmentAsset: Boolean(row.is_investment_asset),
    fiscalPeriod: row.fiscal_period,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Lista facturas recibidas de un negocio con filtros opcionales (Tenant-Scoped)
 */
export function listPurchaseInvoices(companyContextOrId, { fiscalPeriod, startDate, endDate } = {}) {
  if (!companyContextOrId) return [];
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) return [];
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let query = '';
  const params = [];

  if (hasCompanyIdCol) {
    query = 'SELECT * FROM purchase_invoices WHERE (company_id = ? OR (company_id IS NULL AND business_id = ?))';
    params.push(companyId, cleanPhone);
  } else {
    query = 'SELECT * FROM purchase_invoices WHERE business_id = ?';
    params.push(cleanPhone);
  }

  if (fiscalPeriod) {
    const altPeriod = fiscalPeriod.includes('_') ? fiscalPeriod.replace('_', '-') : fiscalPeriod.replace('-', '_');
    query += ' AND (fiscal_period = ? OR fiscal_period = ?)';
    params.push(fiscalPeriod, altPeriod);
  }
  if (startDate) {
    query += ' AND invoice_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    query += ' AND invoice_date <= ?';
    params.push(endDate);
  }
  query += ' ORDER BY invoice_date ASC, created_at ASC';

  const rows = db.prepare(query).all(...params);
  return rows.map(row => ({
    id: row.id,
    companyId: row.company_id || companyId,
    businessId: row.business_id || cleanPhone,
    supplierName: row.supplier_name,
    supplierTaxId: row.supplier_tax_id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    issueDate: row.invoice_date,
    operationDate: row.operation_date,
    description: row.description,
    taxableBase: Number(row.taxable_base) || 0,
    taxBase: Number(row.taxable_base) || 0,
    vatRate: row.vat_rate != null ? Number(row.vat_rate) : 21,
    vatAmount: row.vat_amount != null ? Number(row.vat_amount) : 0,
    totalAmount: Number(row.total_amount) || 0,
    deductibleVatAmount: Number(row.deductible_vat_amount) || 0,
    vatDeductible: row.deductibility_status !== 'NOT_DEDUCTIBLE' && Number(row.deductible_vat_amount) > 0,
    deductiblePercentage: row.deductibility_status === 'NOT_DEDUCTIBLE' ? 0 : 100,
    deductibilityStatus: row.deductibility_status,
    incomeTaxRelevance: row.income_tax_relevance,
    expenseCategory: row.expense_category,
    category: row.expense_category,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    paymentDate: row.payment_date,
    paidAmount: Number(row.total_amount) || 0,
    documentPath: row.document_path,
    isInvestmentAsset: Boolean(row.is_investment_asset),
    fiscalPeriod: row.fiscal_period,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

/**
 * Elimina una factura recibida por su ID (Tenant-Scoped)
 */
export function deletePurchaseInvoice(companyContextOrId, id) {
  if (id === undefined) {
    console.warn("🛑 [Seguridad Tenant] deletePurchaseInvoice invocado sin tenant context obligatorio.");
    return false;
  }
  if (!companyContextOrId || !id) return false;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] deletePurchaseInvoice: no se pudo resolver un tenant válido.");
    return false;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let res;
  if (hasCompanyIdCol) {
    res = db.prepare('DELETE FROM purchase_invoices WHERE id = ? AND company_id = ?').run(id, companyId);
  } else {
    res = db.prepare('DELETE FROM purchase_invoices WHERE id = ? AND business_id = ?').run(id, cleanPhone);
  }
  return res.changes > 0;
}

/**
 * Registra o actualiza un pago de gasto/compra (desacoplamiento de pagos)
 * 
 * Tenant Hardening & Dual-Write:
 * - Requiere companyId (UUID) o authenticatedContext como autoridad canónica.
 * - Soporta adapter transitorio por teléfono legacy para compañías existentes.
 * - Inyección de modelo: cualquier company_id o business_id dentro de p es ignorado.
 * - Dual-write: escribe company_id como autoridad y mantiene business_id sincronizado.
 * - Validación relacional: Si purchaseInvoiceId pertenece a otro tenant, bloquea en fail-closed.
 */
export function saveExpensePayment(companyContextOrId, p = {}) {
  if (!companyContextOrId) {
    throw new Error("❌ [Tenant Boundary] saveExpensePayment requiere un companyId o contexto autenticado obligatorio.");
  }
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    throw new Error("❌ [Tenant Boundary] saveExpensePayment: no se pudo resolver un tenant válido.");
  }
  const { companyId, phone: cleanPhone } = tenant;

  // Defensa contra inyección: Ignorar company_id y business_id provistos en payload del modelo
  const {
    companyId: _ignoredCid,
    company_id: _ignoredCid2,
    businessId: _ignoredBid,
    business_id: _ignoredBid2,
    companyPhone: _ignoredPhone1,
    company_phone: _ignoredPhone2,
    phone: _ignoredPhone3,
    ...safeP
  } = p;

  const id = safeP.id || `EXP-PAY-${Date.now()}`;
  const purchaseInvoiceId = safeP.purchaseInvoiceId || safeP.purchase_invoice_id || '';

  const cols = db.prepare('PRAGMA table_info("expense_payments")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  // Comprobar existencia y tenant en caso de actualización
  if (safeP.id) {
    if (hasCompanyIdCol) {
      const existing = db.prepare('SELECT company_id, business_id FROM expense_payments WHERE id = ?').get(safeP.id);
      if (existing && existing.company_id !== companyId) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de modificar pago de gasto ${safeP.id} de otro tenant.`);
        return null;
      }
    } else {
      const existing = db.prepare('SELECT business_id FROM expense_payments WHERE id = ?').get(safeP.id);
      if (existing && existing.business_id !== cleanPhone) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de modificar pago de gasto ${safeP.id} de otro tenant.`);
        return null;
      }
    }
  }

  // Validación relacional: Si la factura de compra asociada existe, asegurar que pertenece al mismo tenant
  if (purchaseInvoiceId) {
    const pinvCols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
    const pinvHasCompanyId = pinvCols.some(c => c.name === 'company_id');
    if (pinvHasCompanyId) {
      const pinv = db.prepare('SELECT company_id FROM purchase_invoices WHERE id = ?').get(purchaseInvoiceId);
      if (pinv && pinv.company_id !== companyId) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de asociar pago ${id} a factura ${purchaseInvoiceId} de otro tenant.`);
        return null;
      }
    }
  }

  const now = new Date().toISOString();
  const paymentDate = safeP.paymentDate || safeP.payment_date || now.split('T')[0];
  const amount = Number(safeP.amount || 0);
  const paymentMethod = safeP.paymentMethod || safeP.payment_method || 'Transferencia';
  const reference = safeP.reference || null;

  if (hasCompanyIdCol) {
    const stmt = db.prepare(`
      INSERT INTO expense_payments (
        id, company_id, purchase_invoice_id, business_id, amount,
        payment_date, payment_method, reference, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        company_id = excluded.company_id,
        purchase_invoice_id = excluded.purchase_invoice_id,
        business_id = excluded.business_id,
        amount = excluded.amount,
        payment_date = excluded.payment_date,
        payment_method = excluded.payment_method,
        reference = excluded.reference
    `);

    stmt.run(
      id,
      companyId,
      purchaseInvoiceId,
      cleanPhone,
      amount,
      paymentDate,
      paymentMethod,
      reference,
      now
    );
  } else {
    // Compatibilidad pre-migración 010
    const stmt = db.prepare(`
      INSERT INTO expense_payments (
        id, purchase_invoice_id, business_id, amount,
        payment_date, payment_method, reference, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        purchase_invoice_id = excluded.purchase_invoice_id,
        business_id = excluded.business_id,
        amount = excluded.amount,
        payment_date = excluded.payment_date,
        payment_method = excluded.payment_method,
        reference = excluded.reference
    `);

    stmt.run(
      id,
      purchaseInvoiceId,
      cleanPhone,
      amount,
      paymentDate,
      paymentMethod,
      reference,
      now
    );
  }

  return getExpensePayment(companyContextOrId, id);
}

/**
 * Obtiene un pago de gasto por su ID (Tenant-Scoped)
 */
export function getExpensePayment(companyContextOrId, id) {
  if (id === undefined) {
    console.warn("🛑 [Seguridad Tenant] getExpensePayment invocado sin tenant context obligatorio. Retornando null.");
    return null;
  }
  if (!companyContextOrId || !id) return null;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] getExpensePayment: no se pudo resolver un tenant válido.");
    return null;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("expense_payments")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let row = null;
  if (hasCompanyIdCol) {
    row = db.prepare('SELECT * FROM expense_payments WHERE id = ? AND company_id = ?').get(id, companyId);
    if (!row && cleanPhone) {
      row = db.prepare('SELECT * FROM expense_payments WHERE id = ? AND business_id = ?').get(id, cleanPhone);
    }
  } else {
    row = db.prepare('SELECT * FROM expense_payments WHERE id = ? AND business_id = ?').get(id, cleanPhone);
  }
  if (!row) return null;

  return {
    id: row.id,
    companyId: row.company_id || companyId,
    businessId: row.business_id || cleanPhone,
    purchaseInvoiceId: row.purchase_invoice_id,
    amount: Number(row.amount || 0),
    paymentDate: row.payment_date,
    paymentMethod: row.payment_method,
    reference: row.reference,
    createdAt: row.created_at
  };
}

/**
 * Lista pagos de gasto de un negocio con filtros opcionales (Tenant-Scoped)
 */
export function listExpensePayments(companyContextOrId, purchaseInvoiceId = null) {
  if (!companyContextOrId) return [];
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) return [];
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("expense_payments")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let query = '';
  const params = [];

  if (hasCompanyIdCol) {
    query = 'SELECT * FROM expense_payments WHERE (company_id = ? OR (company_id IS NULL AND business_id = ?))';
    params.push(companyId, cleanPhone);
  } else {
    query = 'SELECT * FROM expense_payments WHERE business_id = ?';
    params.push(cleanPhone);
  }

  if (purchaseInvoiceId) {
    query += ' AND purchase_invoice_id = ?';
    params.push(purchaseInvoiceId);
  }
  query += ' ORDER BY payment_date ASC, created_at ASC';

  const rows = db.prepare(query).all(...params);
  return rows.map(row => ({
    id: row.id,
    companyId: row.company_id || companyId,
    businessId: row.business_id || cleanPhone,
    purchaseInvoiceId: row.purchase_invoice_id,
    amount: Number(row.amount || 0),
    paymentDate: row.payment_date,
    paymentMethod: row.payment_method,
    reference: row.reference,
    createdAt: row.created_at
  }));
}

/**
 * Elimina un pago de gasto por su ID (Tenant-Scoped)
 */
export function deleteExpensePayment(companyContextOrId, id) {
  if (id === undefined) {
    console.warn("🛑 [Seguridad Tenant] deleteExpensePayment invocado sin tenant context obligatorio.");
    return false;
  }
  if (!companyContextOrId || !id) return false;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] deleteExpensePayment: no se pudo resolver un tenant válido.");
    return false;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("expense_payments")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let res;
  if (hasCompanyIdCol) {
    res = db.prepare('DELETE FROM expense_payments WHERE id = ? AND company_id = ?').run(id, companyId);
  } else {
    res = db.prepare('DELETE FROM expense_payments WHERE id = ? AND business_id = ?').run(id, cleanPhone);
  }
  return res.changes > 0;
}

/**
 * Bienes de Inversión (Activos > 3.005,06 €)
 * 
 * Tenant Hardening & Dual-Write:
 * - Requiere companyId (UUID) o authenticatedContext como autoridad canónica.
 * - Soporta adapter transitorio por teléfono legacy para compañías existentes.
 * - Inyección de modelo: cualquier company_id o business_id dentro de asset es ignorado.
 * - Dual-write: escribe company_id como autoridad y mantiene business_id sincronizado.
 * - Validación relacional: Si purchaseInvoiceId pertenece a otro tenant, bloquea en fail-closed.
 * - Conserva intacta la lógica fiscal y montos existentes (no altera reglas de amortización ni deducción).
 */
export function saveInvestmentAsset(companyContextOrId, asset = {}) {
  if (!companyContextOrId) {
    throw new Error("❌ [Tenant Boundary] saveInvestmentAsset requiere un companyId o contexto autenticado obligatorio.");
  }
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    throw new Error("❌ [Tenant Boundary] saveInvestmentAsset: no se pudo resolver un tenant válido.");
  }
  const { companyId, phone: cleanPhone } = tenant;

  // Defensa contra inyección: Ignorar company_id y business_id provistos en payload del modelo
  const {
    companyId: _ignoredCid,
    company_id: _ignoredCid2,
    businessId: _ignoredBid,
    business_id: _ignoredBid2,
    companyPhone: _ignoredPhone1,
    company_phone: _ignoredPhone2,
    phone: _ignoredPhone3,
    ...safeAsset
  } = asset;

  const id = safeAsset.id || `AST-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
  const purchaseInvoiceId = safeAsset.purchaseInvoiceId || safeAsset.purchase_invoice_id || null;

  const cols = db.prepare('PRAGMA table_info("investment_assets")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  // Comprobar existencia y tenant en caso de actualización
  if (safeAsset.id) {
    if (hasCompanyIdCol) {
      const existing = db.prepare('SELECT company_id, business_id FROM investment_assets WHERE id = ?').get(safeAsset.id);
      if (existing && existing.company_id !== companyId) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de modificar bien de inversión ${safeAsset.id} de otro tenant.`);
        return null;
      }
    } else {
      const existing = db.prepare('SELECT business_id FROM investment_assets WHERE id = ?').get(safeAsset.id);
      if (existing && existing.business_id !== cleanPhone) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de modificar bien de inversión ${safeAsset.id} de otro tenant.`);
        return null;
      }
    }
  }

  // Validación relacional: Si la factura de compra asociada existe, asegurar que pertenece al mismo tenant
  if (purchaseInvoiceId) {
    const pinvCols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
    const pinvHasCompanyId = pinvCols.some(c => c.name === 'company_id');
    if (pinvHasCompanyId) {
      const pinv = db.prepare('SELECT company_id FROM purchase_invoices WHERE id = ?').get(purchaseInvoiceId);
      if (pinv && pinv.company_id !== companyId) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de asociar activo ${id} a factura ${purchaseInvoiceId} de otro tenant.`);
        return null;
      }
    }
  }

  const now = new Date().toISOString();
  const purchaseDate = safeAsset.purchaseDate || safeAsset.purchase_date || now.split('T')[0];
  const supplierName = safeAsset.supplierName || safeAsset.supplier_name || 'Proveedor Maquinaria';
  const purchaseBase = Number(safeAsset.purchaseBase ?? safeAsset.purchase_base ?? 0);
  const vatAmount = Number(safeAsset.vatAmount ?? safeAsset.vat_amount ?? 0);
  const totalAmount = Number(safeAsset.totalAmount ?? safeAsset.total_amount ?? 0);
  const businessUsePercentage = Number(safeAsset.businessUsePercentage ?? safeAsset.business_use_percentage ?? 100);
  const depreciationMethod = safeAsset.depreciationMethod || safeAsset.depreciation_method || 'TABLAS_OFICIALES';
  const depreciationStatus = safeAsset.depreciationStatus || safeAsset.depreciation_status || 'NEEDS_GESTOR_REVIEW';
  const description = safeAsset.description || 'Bien de inversión / maquinaria';
  const notes = safeAsset.notes || null;

  if (hasCompanyIdCol) {
    const stmt = db.prepare(`
      INSERT INTO investment_assets (
        id, company_id, business_id, purchase_invoice_id, description,
        purchase_date, supplier_name, purchase_base, vat_amount, total_amount,
        business_use_percentage, depreciation_method, depreciation_status, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        company_id = excluded.company_id,
        business_id = excluded.business_id,
        purchase_invoice_id = excluded.purchase_invoice_id,
        description = excluded.description,
        purchase_date = excluded.purchase_date,
        supplier_name = excluded.supplier_name,
        purchase_base = excluded.purchase_base,
        vat_amount = excluded.vat_amount,
        total_amount = excluded.total_amount,
        business_use_percentage = excluded.business_use_percentage,
        depreciation_method = excluded.depreciation_method,
        depreciation_status = excluded.depreciation_status,
        notes = excluded.notes
    `);

    stmt.run(
      id,
      companyId,
      cleanPhone,
      purchaseInvoiceId,
      description,
      purchaseDate,
      supplierName,
      purchaseBase,
      vatAmount,
      totalAmount,
      businessUsePercentage,
      depreciationMethod,
      depreciationStatus,
      notes,
      now
    );
  } else {
    // Compatibilidad pre-migración 011
    const stmt = db.prepare(`
      INSERT INTO investment_assets (
        id, business_id, purchase_invoice_id, description, purchase_date,
        supplier_name, purchase_base, vat_amount, total_amount,
        business_use_percentage, depreciation_method, depreciation_status, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        description = excluded.description,
        purchase_base = excluded.purchase_base,
        vat_amount = excluded.vat_amount,
        total_amount = excluded.total_amount,
        business_use_percentage = excluded.business_use_percentage,
        notes = excluded.notes
      `);

    stmt.run(
      id,
      cleanPhone,
      purchaseInvoiceId,
      description,
      purchaseDate,
      supplierName,
      purchaseBase,
      vatAmount,
      totalAmount,
      businessUsePercentage,
      depreciationMethod,
      depreciationStatus,
      notes,
      now
    );
  }

  return getInvestmentAsset(companyContextOrId, id);
}

/**
 * Obtiene un bien de inversión por su ID (Tenant-Scoped)
 */
export function getInvestmentAsset(companyContextOrId, id) {
  if (id === undefined) {
    console.warn("🛑 [Seguridad Tenant] getInvestmentAsset invocado sin tenant context obligatorio. Retornando null.");
    return null;
  }
  if (!companyContextOrId || !id) return null;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] getInvestmentAsset: no se pudo resolver un tenant válido.");
    return null;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("investment_assets")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let row = null;
  if (hasCompanyIdCol) {
    row = db.prepare('SELECT * FROM investment_assets WHERE id = ? AND company_id = ?').get(id, companyId);
    if (!row && cleanPhone) {
      row = db.prepare('SELECT * FROM investment_assets WHERE id = ? AND business_id = ?').get(id, cleanPhone);
    }
  } else {
    row = db.prepare('SELECT * FROM investment_assets WHERE id = ? AND business_id = ?').get(id, cleanPhone);
  }
  function mapInvestmentAssetRow(row, fallbackCompanyId, fallbackPhone) {
    if (!row) return null;
    const cid = row.company_id || fallbackCompanyId;
    const bid = row.business_id || fallbackPhone;
    const pBase = Number(row.purchase_base || 0);
    const vAmount = Number(row.vat_amount || 0);
    const tAmount = Number(row.total_amount || 0);
    const usePct = Number(row.business_use_percentage != null ? row.business_use_percentage : 100);

    return {
      ...row,
      id: row.id,
      companyId: cid,
      businessId: bid,
      company_id: cid,
      business_id: bid,
      purchaseInvoiceId: row.purchase_invoice_id,
      purchase_invoice_id: row.purchase_invoice_id,
      description: row.description,
      purchaseDate: row.purchase_date,
      purchase_date: row.purchase_date,
      supplierName: row.supplier_name,
      supplier_name: row.supplier_name,
      purchaseBase: pBase,
      purchase_base: pBase,
      vatAmount: vAmount,
      vat_amount: vAmount,
      totalAmount: tAmount,
      total_amount: tAmount,
      businessUsePercentage: usePct,
      business_use_percentage: usePct,
      depreciationMethod: row.depreciation_method,
      depreciation_method: row.depreciation_method,
      depreciationStatus: row.depreciation_status,
      depreciation_status: row.depreciation_status,
      notes: row.notes,
      createdAt: row.created_at,
      created_at: row.created_at
    };
  }

  return mapInvestmentAssetRow(row, companyId, cleanPhone);
}

/**
 * Lista bienes de inversión de un negocio (Tenant-Scoped)
 */
export function listInvestmentAssets(companyContextOrId) {
  if (!companyContextOrId) return [];
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) return [];
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("investment_assets")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let rows = [];
  if (hasCompanyIdCol) {
    rows = db.prepare('SELECT * FROM investment_assets WHERE (company_id = ? OR (company_id IS NULL AND business_id = ?)) ORDER BY purchase_date ASC').all(companyId, cleanPhone);
  } else {
    rows = db.prepare('SELECT * FROM investment_assets WHERE business_id = ? ORDER BY purchase_date ASC').all(cleanPhone);
  }

  return rows.map(row => {
    const cid = row.company_id || companyId;
    const bid = row.business_id || cleanPhone;
    const pBase = Number(row.purchase_base || 0);
    const vAmount = Number(row.vat_amount || 0);
    const tAmount = Number(row.total_amount || 0);
    const usePct = Number(row.business_use_percentage != null ? row.business_use_percentage : 100);

    return {
      ...row,
      id: row.id,
      companyId: cid,
      businessId: bid,
      company_id: cid,
      business_id: bid,
      purchaseInvoiceId: row.purchase_invoice_id,
      purchase_invoice_id: row.purchase_invoice_id,
      description: row.description,
      purchaseDate: row.purchase_date,
      purchase_date: row.purchase_date,
      supplierName: row.supplier_name,
      supplier_name: row.supplier_name,
      purchaseBase: pBase,
      purchase_base: pBase,
      vatAmount: vAmount,
      vat_amount: vAmount,
      totalAmount: tAmount,
      total_amount: tAmount,
      businessUsePercentage: usePct,
      business_use_percentage: usePct,
      depreciationMethod: row.depreciation_method,
      depreciation_method: row.depreciation_method,
      depreciationStatus: row.depreciation_status,
      depreciation_status: row.depreciation_status,
      notes: row.notes,
      createdAt: row.created_at,
      created_at: row.created_at
    };
  });
}

/**
 * Elimina un bien de inversión por su ID (Tenant-Scoped)
 */
export function deleteInvestmentAsset(companyContextOrId, id) {
  if (id === undefined) {
    console.warn("🛑 [Seguridad Tenant] deleteInvestmentAsset invocado sin tenant context obligatorio.");
    return false;
  }
  if (!companyContextOrId || !id) return false;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] deleteInvestmentAsset: no se pudo resolver un tenant válido.");
    return false;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("investment_assets")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let res;
  if (hasCompanyIdCol) {
    res = db.prepare('DELETE FROM investment_assets WHERE id = ? AND company_id = ?').run(id, companyId);
  } else {
    res = db.prepare('DELETE FROM investment_assets WHERE id = ? AND business_id = ?').run(id, cleanPhone);
  }
  return res.changes > 0;
}

/**
 * Resuelve el tenant canónico (companyId UUID y phone limpio) para funciones fiscales.
 * Garantiza comportamiento Fail-Closed si la empresa no existe.
 */
function resolveCanonicalFiscalTenant(companyContextOrId) {
  if (!companyContextOrId) return null;
  let companyId = null;
  let phone = null;

  if (typeof companyContextOrId === 'object') {
    companyId = companyContextOrId.companyId || companyContextOrId.id || null;
    if (!companyId && (companyContextOrId.phone || companyContextOrId.company?.phone)) {
      const rawPhone = companyContextOrId.company?.phone || companyContextOrId.phone;
      const clean = String(rawPhone).replace(/\D/g, '');
      const comp = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(clean);
      if (comp) {
        companyId = comp.id;
        phone = String(comp.phone).replace(/\D/g, '');
      }
    }
  } else if (typeof companyContextOrId === 'string') {
    const trimmed = companyContextOrId.trim();
    if (isUuid(trimmed)) {
      companyId = trimmed;
    } else {
      const clean = trimmed.replace(/\D/g, '');
      if (clean) {
        const comp = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(clean);
        if (comp) {
          companyId = comp.id;
          phone = String(comp.phone).replace(/\D/g, '');
        }
      }
    }
  }

  if (!companyId) return null;

  if (!phone) {
    const comp = db.prepare('SELECT phone FROM companies WHERE id = ?').get(companyId);
    if (!comp) return null; // Fail-closed: la empresa no existe en companies
    phone = comp.phone ? String(comp.phone).replace(/\D/g, '') : '';
  }

  return { companyId, phone };
}

/**
 * Periodos Fiscales y Control de Trimestre
 * Identidad canónica: (company_id, fiscal_year, quarter)
 */
export function getOrCreateFiscalPeriod(companyContextOrId, year, quarter) {
  if (!companyContextOrId || !year || !quarter) return null;
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant) return null;

  const { companyId, phone: cleanPhone } = tenant;
  const fiscalYear = Number(year);
  const q = Number(quarter);

  const cols = db.prepare('PRAGMA table_info("fiscal_periods")').all();
  const hasCompanyId = cols.some(c => c.name === 'company_id');

  let period = null;

  if (hasCompanyId) {
    period = db.prepare('SELECT * FROM fiscal_periods WHERE company_id = ? AND fiscal_year = ? AND quarter = ?').get(companyId, fiscalYear, q);

    if (!period) {
      const now = new Date().toISOString();
      const canonicalId = `${companyId}_${fiscalYear}_Q${q}`;
      db.prepare(`
        INSERT INTO fiscal_periods (
          id, company_id, business_id, fiscal_year, quarter, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)
      `).run(canonicalId, companyId, cleanPhone || '', fiscalYear, q, now, now);
      period = db.prepare('SELECT * FROM fiscal_periods WHERE company_id = ? AND fiscal_year = ? AND quarter = ?').get(companyId, fiscalYear, q);
    }
  } else {
    // Compatibilidad pre-migración 008
    const id = `${cleanPhone}_${fiscalYear}_Q${q}`;
    period = db.prepare('SELECT * FROM fiscal_periods WHERE id = ?').get(id);

    if (!period) {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO fiscal_periods (id, business_id, fiscal_year, quarter, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'OPEN', ?, ?)
      `).run(id, cleanPhone, fiscalYear, q, now, now);
      period = db.prepare('SELECT * FROM fiscal_periods WHERE id = ?').get(id);
    }
  }

  if (!period) return null;

  return {
    id: period.id,
    companyId: period.company_id || companyId,
    businessId: period.business_id || cleanPhone,
    fiscalYear: period.fiscal_year,
    year: period.fiscal_year,
    quarter: period.quarter,
    status: period.status,
    lastQualityCheckAt: period.last_quality_check_at,
    criticalIncidentsCount: period.critical_incidents_count,
    warningsCount: period.warnings_count,
    packagePath: period.package_path,
    sentAt: period.sent_at,
    sentToEmail: period.sent_to_email,
    createdAt: period.created_at,
    updatedAt: period.updated_at
  };
}

/**
 * Obtiene un periodo fiscal existente (Tenant-Scoped por company_id)
 */
export function getFiscalPeriod(companyContextOrId, year, quarter) {
  if (!companyContextOrId || !year || !quarter) return null;
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant) return null;

  const { companyId, phone: cleanPhone } = tenant;
  const fiscalYear = Number(year);
  const q = Number(quarter);

  const cols = db.prepare('PRAGMA table_info("fiscal_periods")').all();
  const hasCompanyId = cols.some(c => c.name === 'company_id');

  let period = null;

  if (hasCompanyId) {
    period = db.prepare('SELECT * FROM fiscal_periods WHERE company_id = ? AND fiscal_year = ? AND quarter = ?').get(companyId, fiscalYear, q);
    // Fallback legacy por business_id si no se encontrara por company_id
    if (!period && cleanPhone) {
      period = db.prepare('SELECT * FROM fiscal_periods WHERE business_id = ? AND fiscal_year = ? AND quarter = ?').get(cleanPhone, fiscalYear, q);
    }
  } else {
    const id = `${cleanPhone}_${fiscalYear}_Q${q}`;
    period = db.prepare('SELECT * FROM fiscal_periods WHERE id = ? AND business_id = ?').get(id, cleanPhone);
  }

  if (!period) return null;

  return {
    id: period.id,
    companyId: period.company_id || companyId,
    businessId: period.business_id || cleanPhone,
    fiscalYear: period.fiscal_year,
    year: period.fiscal_year,
    quarter: period.quarter,
    status: period.status,
    lastQualityCheckAt: period.last_quality_check_at,
    criticalIncidentsCount: period.critical_incidents_count,
    warningsCount: period.warnings_count,
    packagePath: period.package_path,
    sentAt: period.sent_at,
    sentToEmail: period.sent_to_email,
    createdAt: period.created_at,
    updatedAt: period.updated_at
  };
}

/**
 * Actualiza el estado y metadatos de un periodo fiscal (Tenant-Scoped)
 */
export function updateFiscalPeriodStatus(companyContextOrId, year, quarter, status, extra = {}) {
  if (!companyContextOrId || !year || !quarter) return null;
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant) return null;

  const { companyId, phone: cleanPhone } = tenant;
  const fiscalYear = Number(year);
  const q = Number(quarter);

  // Asegurar que el periodo existe
  const existing = getOrCreateFiscalPeriod(companyContextOrId, fiscalYear, q);
  if (!existing) return null;

  // Sanitización de extra: Ignorar cualquier intento de inyección de tenant
  const { companyId: _ignoredCid, businessId: _ignoredBid, ...safeExtra } = extra;

  const cols = db.prepare('PRAGMA table_info("fiscal_periods")').all();
  const hasCompanyId = cols.some(c => c.name === 'company_id');
  const now = new Date().toISOString();

  let query = 'UPDATE fiscal_periods SET status = ?, updated_at = ?';
  const params = [status, now];

  if (safeExtra.packagePath !== undefined) {
    query += ', package_path = ?';
    params.push(safeExtra.packagePath);
  }
  if (safeExtra.sentToEmail !== undefined) {
    query += ', sent_to_email = ?, sent_at = ?';
    params.push(safeExtra.sentToEmail, now);
  }
  if (safeExtra.criticalCount !== undefined) {
    query += ', critical_incidents_count = ?';
    params.push(safeExtra.criticalCount);
  }
  if (safeExtra.warningsCount !== undefined) {
    query += ', warnings_count = ?';
    params.push(safeExtra.warningsCount);
  }
  if (safeExtra.lastQualityCheckAt !== undefined) {
    query += ', last_quality_check_at = ?';
    params.push(safeExtra.lastQualityCheckAt);
  }

  if (hasCompanyId) {
    query += ' WHERE company_id = ? AND fiscal_year = ? AND quarter = ?';
    params.push(companyId, fiscalYear, q);
  } else {
    query += ' WHERE id = ? AND business_id = ?';
    params.push(`${cleanPhone}_${fiscalYear}_Q${q}`, cleanPhone);
  }

  db.prepare(query).run(...params);
  return getFiscalPeriod(companyContextOrId, fiscalYear, q);
}

/**
 * Elimina un periodo fiscal de forma aislada y controlada (Tenant-Scoped).
 */
export function deleteFiscalPeriod(companyContextOrId, year, quarter) {
  if (!companyContextOrId || !year || !quarter) return false;
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant) return false;

  const { companyId, phone: cleanPhone } = tenant;
  const fiscalYear = Number(year);
  const q = Number(quarter);

  const cols = db.prepare('PRAGMA table_info("fiscal_periods")').all();
  const hasCompanyId = cols.some(c => c.name === 'company_id');

  let result;
  if (hasCompanyId) {
    result = db.prepare('DELETE FROM fiscal_periods WHERE company_id = ? AND fiscal_year = ? AND quarter = ?').run(companyId, fiscalYear, q);
  } else {
    result = db.prepare('DELETE FROM fiscal_periods WHERE business_id = ? AND fiscal_year = ? AND quarter = ?').run(cleanPhone, fiscalYear, q);
  }
  return result.changes > 0;
}

/**
 * Incidencias de Calidad Fiscal (Data Quality Checks) — Tenant Scoped
 */
function mapFiscalIncidentRow(row, fallbackCompanyId, fallbackPhone) {
  if (!row) return null;
  const cid = row.company_id || fallbackCompanyId;
  const bid = row.business_id || fallbackPhone;
  return {
    ...row,
    id: row.id,
    companyId: cid,
    company_id: cid,
    businessId: bid,
    business_id: bid,
    fiscalPeriod: row.fiscal_period,
    fiscal_period: row.fiscal_period,
    entityType: row.entity_type,
    entity_type: row.entity_type,
    entityId: row.entity_id,
    entity_id: row.entity_id,
    severity: row.severity,
    errorCode: row.error_code,
    error_code: row.error_code,
    message: row.message,
    resolutionStatus: row.resolution_status,
    resolution_status: row.resolution_status,
    createdAt: row.created_at,
    created_at: row.created_at
  };
}

export function saveFiscalIncident(companyContextOrId, incident = {}) {
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] saveFiscalIncident: no se pudo resolver un tenant válido.");
    return null;
  }
  const { companyId, phone: cleanPhone } = tenant;
  const id = incident.id || `INC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const cols = db.prepare('PRAGMA table_info("fiscal_incidents")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  if (incident.id) {
    if (hasCompanyIdCol) {
      const existing = db.prepare('SELECT company_id, business_id FROM fiscal_incidents WHERE id = ?').get(incident.id);
      if (existing && existing.company_id !== companyId && (!cleanPhone || existing.business_id !== cleanPhone)) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de modificar incidencia fiscal ${incident.id} de otro tenant.`);
        return null;
      }
    } else {
      const existing = db.prepare('SELECT business_id FROM fiscal_incidents WHERE id = ?').get(incident.id);
      if (existing && cleanPhone && existing.business_id !== cleanPhone) {
        console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de modificar incidencia fiscal ${incident.id} de otro tenant.`);
        return null;
      }
    }
  }

  // Prevención cross-tenant contra entidades referenciadas
  if (incident.entityType === 'INVOICE' && incident.entityId) {
    const invTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoices'").get();
    if (invTableExists) {
      const invCols = db.prepare('PRAGMA table_info("invoices")').all();
      if (invCols.some(c => c.name === 'company_id')) {
        const inv = db.prepare('SELECT company_id FROM invoices WHERE id = ?').get(incident.entityId);
        if (inv && inv.company_id && inv.company_id !== companyId) {
          console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de asociar incidencia ${id} a factura emitida ${incident.entityId} de otro tenant.`);
          return null;
        }
      }
    }
  }

  if (incident.entityType === 'PURCHASE_INVOICE' && incident.entityId) {
    const pinvTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_invoices'").get();
    if (pinvTableExists) {
      const pinvCols = db.prepare('PRAGMA table_info("purchase_invoices")').all();
      if (pinvCols.some(c => c.name === 'company_id')) {
        const pinv = db.prepare('SELECT company_id FROM purchase_invoices WHERE id = ?').get(incident.entityId);
        if (pinv && pinv.company_id && pinv.company_id !== companyId) {
          console.warn(`🛑 [Seguridad Cross-Tenant] Intento no autorizado de asociar incidencia ${id} a factura recibida ${incident.entityId} de otro tenant.`);
          return null;
        }
      }
    }
  }

  const now = new Date().toISOString();
  const fiscalPeriod = incident.fiscalPeriod || incident.fiscal_period || 'GENERAL';
  const entityType = incident.entityType || incident.entity_type || 'INVOICE';
  const entityId = incident.entityId || incident.entity_id || '';
  const severity = incident.severity || 'WARNING';
  const errorCode = incident.errorCode || incident.error_code || 'UNKNOWN_ERROR';
  const message = incident.message || 'Incidencia fiscal detectada';
  const resolutionStatus = incident.resolutionStatus || incident.resolution_status || 'OPEN';
  const createdAt = incident.createdAt || incident.created_at || now;

  if (hasCompanyIdCol) {
    db.prepare(`
      INSERT INTO fiscal_incidents (
        id, company_id, business_id, fiscal_period, entity_type, entity_id,
        severity, error_code, message, resolution_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        company_id = excluded.company_id,
        business_id = excluded.business_id,
        fiscal_period = excluded.fiscal_period,
        entity_type = excluded.entity_type,
        entity_id = excluded.entity_id,
        severity = excluded.severity,
        error_code = excluded.error_code,
        message = excluded.message,
        resolution_status = excluded.resolution_status
    `).run(
      id,
      companyId,
      cleanPhone,
      fiscalPeriod,
      entityType,
      entityId,
      severity,
      errorCode,
      message,
      resolutionStatus,
      createdAt
    );
  } else {
    db.prepare(`
      INSERT INTO fiscal_incidents (
        id, business_id, fiscal_period, entity_type, entity_id,
        severity, error_code, message, resolution_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        business_id = excluded.business_id,
        fiscal_period = excluded.fiscal_period,
        entity_type = excluded.entity_type,
        entity_id = excluded.entity_id,
        severity = excluded.severity,
        error_code = excluded.error_code,
        message = excluded.message,
        resolution_status = excluded.resolution_status
    `).run(
      id,
      cleanPhone,
      fiscalPeriod,
      entityType,
      entityId,
      severity,
      errorCode,
      message,
      resolutionStatus,
      createdAt
    );
  }

  return getFiscalIncident(companyContextOrId, id);
}

export function listFiscalIncidents(companyContextOrId, fiscalPeriod = null, status = 'OPEN') {
  if (!companyContextOrId) return [];
  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) return [];
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("fiscal_incidents")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let query = '';
  const params = [];

  if (hasCompanyIdCol) {
    query = 'SELECT * FROM fiscal_incidents WHERE (company_id = ? OR (company_id IS NULL AND business_id = ?))';
    params.push(companyId, cleanPhone);
  } else {
    query = 'SELECT * FROM fiscal_incidents WHERE business_id = ?';
    params.push(cleanPhone);
  }

  if (fiscalPeriod) {
    const altPeriod = fiscalPeriod.includes('_') ? fiscalPeriod.replace('_', '-') : fiscalPeriod.replace('-', '_');
    query += ' AND (fiscal_period = ? OR fiscal_period = ?)';
    params.push(fiscalPeriod, altPeriod);
  }
  if (status) {
    query += ' AND resolution_status = ?';
    params.push(status);
  }
  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params);
  return rows.map(r => mapFiscalIncidentRow(r, companyId, cleanPhone));
}

/**
 * Resuelve una incidencia de calidad fiscal (Tenant-Scoped)
 */
export function resolveFiscalIncident(companyContextOrId, incidentId) {
  if (incidentId === undefined) {
    console.warn("🛑 [Seguridad Tenant] resolveFiscalIncident invocado sin tenant context obligatorio.");
    return false;
  }
  if (!companyContextOrId || !incidentId) return false;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] resolveFiscalIncident: no se pudo resolver un tenant válido.");
    return false;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("fiscal_incidents")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let res;
  if (hasCompanyIdCol) {
    res = db.prepare(`
      UPDATE fiscal_incidents 
      SET resolution_status = 'RESOLVED' 
      WHERE id = ? AND (company_id = ? OR (company_id IS NULL AND business_id = ?))
    `).run(incidentId, companyId, cleanPhone);
  } else {
    res = db.prepare("UPDATE fiscal_incidents SET resolution_status = 'RESOLVED' WHERE id = ? AND business_id = ?").run(incidentId, cleanPhone);
  }
  return res.changes > 0;
}

/**
 * Obtiene una incidencia fiscal por su ID (Tenant-Scoped)
 */
export function getFiscalIncident(companyContextOrId, incidentId) {
  if (incidentId === undefined) {
    console.warn("🛑 [Seguridad Tenant] getFiscalIncident invocado sin tenant context obligatorio.");
    return null;
  }
  if (!companyContextOrId || !incidentId) return null;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] getFiscalIncident: no se pudo resolver un tenant válido.");
    return null;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("fiscal_incidents")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let row = null;
  if (hasCompanyIdCol) {
    row = db.prepare('SELECT * FROM fiscal_incidents WHERE id = ? AND company_id = ?').get(incidentId, companyId);
    if (!row && cleanPhone) {
      row = db.prepare('SELECT * FROM fiscal_incidents WHERE id = ? AND business_id = ?').get(incidentId, cleanPhone);
    }
  } else {
    row = db.prepare('SELECT * FROM fiscal_incidents WHERE id = ? AND business_id = ?').get(incidentId, cleanPhone);
  }
  return mapFiscalIncidentRow(row, companyId, cleanPhone);
}

/**
 * Elimina una incidencia fiscal por su ID (Tenant-Scoped)
 */
export function deleteFiscalIncident(companyContextOrId, incidentId) {
  if (incidentId === undefined) {
    console.warn("🛑 [Seguridad Tenant] deleteFiscalIncident invocado sin tenant context obligatorio.");
    return false;
  }
  if (!companyContextOrId || !incidentId) return false;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (!tenant || !tenant.companyId) {
    console.warn("🛑 [Seguridad Tenant] deleteFiscalIncident: no se pudo resolver un tenant válido.");
    return false;
  }
  const { companyId, phone: cleanPhone } = tenant;

  const cols = db.prepare('PRAGMA table_info("fiscal_incidents")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let res;
  if (hasCompanyIdCol) {
    res = db.prepare('DELETE FROM fiscal_incidents WHERE id = ? AND (company_id = ? OR (company_id IS NULL AND business_id = ?))').run(incidentId, companyId, cleanPhone);
  } else {
    res = db.prepare('DELETE FROM fiscal_incidents WHERE id = ? AND business_id = ?').run(incidentId, cleanPhone);
  }
  return res.changes > 0;
}

/**
 * Trazabilidad y Auditoría Fiscal (Audit Log) — Tenant Scoped
 */
export function recordAuditLog({
  companyContextOrId = null,
  businessId = null,
  companyId = null,
  entityType,
  entityId,
  action,
  fieldChanged = null,
  oldValue = null,
  newValue = null,
  changedBy = 'USER_WHATSAPP',
  reason = null
}) {
  const target = companyContextOrId || companyId || businessId;
  if (!target) return null;

  let resolvedCompanyId = null;
  let cleanPhone = null;

  const tenant = resolveCanonicalFiscalTenant(target);
  if (tenant && tenant.companyId) {
    resolvedCompanyId = tenant.companyId;
    cleanPhone = tenant.phone;
  } else {
    const compTenant = resolveCompanyTenant(target);
    if (compTenant && compTenant.companyId) {
      resolvedCompanyId = compTenant.companyId;
      cleanPhone = compTenant.phone;
    } else if (typeof target === 'string') {
      const trimmed = target.trim();
      if (isUuid(trimmed)) {
        const comp = db.prepare('SELECT id, phone FROM companies WHERE id = ?').get(trimmed);
        if (comp) {
          resolvedCompanyId = comp.id;
          cleanPhone = comp.phone ? String(comp.phone).replace(/\D/g, '') : '';
        }
      } else {
        const clean = trimmed.replace(/\D/g, '');
        if (clean) {
          let comp = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(clean);
          if (!comp) {
            saveCompany(clean);
            comp = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(clean);
          }
          if (comp) {
            resolvedCompanyId = comp.id;
            cleanPhone = String(comp.phone).replace(/\D/g, '');
          }
        }
      }
    }
  }

  if (!resolvedCompanyId) return null;

  const id = `LOG-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const now = new Date().toISOString();

  const cols = db.prepare('PRAGMA table_info("audit_logs")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  if (hasCompanyIdCol) {
    db.prepare(`
      INSERT INTO audit_logs (
        id, company_id, business_id, entity_type, entity_id,
        action, field_changed, old_value, new_value, changed_by, reason, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      resolvedCompanyId,
      cleanPhone || resolvedCompanyId,
      entityType || 'FISCAL_RECORD',
      entityId || '',
      action || 'UPDATE',
      fieldChanged,
      oldValue != null ? String(oldValue) : null,
      newValue != null ? String(newValue) : null,
      changedBy,
      reason,
      now
    );
  } else {
    db.prepare(`
      INSERT INTO audit_logs (
        id, business_id, entity_type, entity_id,
        action, field_changed, old_value, new_value, changed_by, reason, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      cleanPhone || resolvedCompanyId,
      entityType || 'FISCAL_RECORD',
      entityId || '',
      action || 'UPDATE',
      fieldChanged,
      oldValue != null ? String(oldValue) : null,
      newValue != null ? String(newValue) : null,
      changedBy,
      reason,
      now
    );
  }

  return { id, companyId: resolvedCompanyId, businessId: cleanPhone, timestamp: now };
}

export function listAuditLogs(companyContextOrId, { entityType, entityId } = {}) {
  if (!companyContextOrId) return [];

  let resolvedCompanyId = null;
  let cleanPhone = null;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (tenant && tenant.companyId) {
    resolvedCompanyId = tenant.companyId;
    cleanPhone = tenant.phone;
  } else {
    const compTenant = resolveCompanyTenant(companyContextOrId);
    if (compTenant && compTenant.companyId) {
      resolvedCompanyId = compTenant.companyId;
      cleanPhone = compTenant.phone;
    } else if (typeof companyContextOrId === 'string') {
      const trimmed = companyContextOrId.trim();
      if (isUuid(trimmed)) {
        const comp = db.prepare('SELECT id, phone FROM companies WHERE id = ?').get(trimmed);
        if (comp) {
          resolvedCompanyId = comp.id;
          cleanPhone = comp.phone ? String(comp.phone).replace(/\D/g, '') : '';
        }
      } else {
        const clean = trimmed.replace(/\D/g, '');
        if (clean) {
          const comp = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(clean);
          if (comp) {
            resolvedCompanyId = comp.id;
            cleanPhone = String(comp.phone).replace(/\D/g, '');
          }
        }
      }
    }
  }

  if (!resolvedCompanyId) return [];

  const cols = db.prepare('PRAGMA table_info("audit_logs")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let query = '';
  const params = [];

  if (hasCompanyIdCol) {
    query = 'SELECT * FROM audit_logs WHERE (company_id = ? OR (company_id IS NULL AND business_id = ?))';
    params.push(resolvedCompanyId, cleanPhone || '');
  } else {
    query = 'SELECT * FROM audit_logs WHERE business_id = ?';
    params.push(cleanPhone || resolvedCompanyId);
  }

  if (entityType) {
    query += ' AND entity_type = ?';
    params.push(entityType);
  }
  if (entityId) {
    query += ' AND entity_id = ?';
    params.push(entityId);
  }
  query += ' ORDER BY timestamp DESC';

  const rows = db.prepare(query).all(...params);
  return rows.map(r => ({
    ...r,
    id: r.id,
    companyId: r.company_id || resolvedCompanyId,
    company_id: r.company_id || resolvedCompanyId,
    businessId: r.business_id || cleanPhone,
    business_id: r.business_id || cleanPhone,
    entityType: r.entity_type,
    entity_type: r.entity_type,
    entityId: r.entity_id,
    entity_id: r.entity_id,
    action: r.action,
    fieldChanged: r.field_changed,
    field_changed: r.field_changed,
    oldValue: r.old_value,
    old_value: r.old_value,
    newValue: r.new_value,
    new_value: r.new_value,
    changedBy: r.changed_by,
    changed_by: r.changed_by,
    reason: r.reason,
    timestamp: r.timestamp
  }));
}

export function getAuditLog(companyContextOrId, logId) {
  if (logId === undefined) {
    console.warn("🛑 [Seguridad Tenant] getAuditLog invocado sin tenant context obligatorio.");
    return null;
  }
  if (!companyContextOrId || !logId) return null;

  let resolvedCompanyId = null;
  let cleanPhone = null;

  const tenant = resolveCanonicalFiscalTenant(companyContextOrId);
  if (tenant && tenant.companyId) {
    resolvedCompanyId = tenant.companyId;
    cleanPhone = tenant.phone;
  } else {
    const compTenant = resolveCompanyTenant(companyContextOrId);
    if (compTenant && compTenant.companyId) {
      resolvedCompanyId = compTenant.companyId;
      cleanPhone = compTenant.phone;
    } else if (typeof companyContextOrId === 'string') {
      const trimmed = companyContextOrId.trim();
      if (isUuid(trimmed)) {
        const comp = db.prepare('SELECT id, phone FROM companies WHERE id = ?').get(trimmed);
        if (comp) {
          resolvedCompanyId = comp.id;
          cleanPhone = comp.phone ? String(comp.phone).replace(/\D/g, '') : '';
        }
      } else {
        const clean = trimmed.replace(/\D/g, '');
        if (clean) {
          const comp = db.prepare('SELECT id, phone FROM companies WHERE phone = ?').get(clean);
          if (comp) {
            resolvedCompanyId = comp.id;
            cleanPhone = String(comp.phone).replace(/\D/g, '');
          }
        }
      }
    }
  }

  if (!resolvedCompanyId) return null;

  const cols = db.prepare('PRAGMA table_info("audit_logs")').all();
  const hasCompanyIdCol = cols.some(c => c.name === 'company_id');

  let row = null;
  if (hasCompanyIdCol) {
    row = db.prepare('SELECT * FROM audit_logs WHERE id = ? AND (company_id = ? OR (company_id IS NULL AND business_id = ?))').get(logId, resolvedCompanyId, cleanPhone || '');
  } else {
    row = db.prepare('SELECT * FROM audit_logs WHERE id = ? AND business_id = ?').get(logId, cleanPhone || resolvedCompanyId);
  }

  if (!row) return null;

  return {
    ...row,
    id: row.id,
    companyId: row.company_id || resolvedCompanyId,
    company_id: row.company_id || resolvedCompanyId,
    businessId: row.business_id || cleanPhone,
    business_id: row.business_id || cleanPhone,
    entityType: row.entity_type,
    entity_type: row.entity_type,
    entityId: row.entity_id,
    entity_id: row.entity_id,
    action: row.action,
    fieldChanged: row.field_changed,
    field_changed: row.field_changed,
    oldValue: row.old_value,
    old_value: row.old_value,
    newValue: row.new_value,
    new_value: row.new_value,
    changedBy: row.changed_by,
    changed_by: row.changed_by,
    reason: row.reason,
    timestamp: row.timestamp
  };
}


