import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const LOGOS_DIR = path.join(DATA_DIR, 'logos');
if (!fs.existsSync(LOGOS_DIR)) {
  fs.mkdirSync(LOGOS_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'presuvoz.db');
const db = new DatabaseSync(DB_PATH);

// Inicializar tablas relacionales
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
    logo_path TEXT,
    default_tax_rate INTEGER DEFAULT 10,
    default_advance INTEGER DEFAULT 30,
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
`);

export const DEFAULT_COMPANY = {
  name: 'Carpintería y Reformas Manolo S.L.',
  cif: 'B-41987654',
  address: 'Pol. Ind. El Pino, Nave 4 - Sevilla',
  phone: '601 02 23 67',
  email: 'presupuestos@presuvoz.app',
  iban: 'ES91 2100 0418 4502 0005 1332',
  bizum: '601 02 23 67',
  logoPath: null,
  defaultTaxRate: 10,
  defaultAdvance: 30
};

// ─── Métodos de Empresa ───────────────────────────────────────────────────────

export function getCompany(phone) {
  if (!phone) return { ...DEFAULT_COMPANY };
  const cleanPhone = String(phone).replace(/\D/g, '');
  const stmt = db.prepare('SELECT * FROM companies WHERE phone = ?');
  const row = stmt.get(cleanPhone);
  if (!row) {
    return { ...DEFAULT_COMPANY, phone: cleanPhone };
  }
  return {
    phone: row.phone,
    name: row.name || DEFAULT_COMPANY.name,
    cif: row.cif || DEFAULT_COMPANY.cif,
    address: row.address || DEFAULT_COMPANY.address,
    phone: row.phone_contact || cleanPhone || DEFAULT_COMPANY.phone,
    email: row.email || DEFAULT_COMPANY.email,
    iban: row.iban || DEFAULT_COMPANY.iban,
    bizum: row.bizum || cleanPhone || DEFAULT_COMPANY.bizum,
    logoPath: row.logo_path || null,
    defaultTaxRate: row.default_tax_rate || 10,
    defaultAdvance: row.default_advance || 30,
    isConfigured: Boolean(row.name && row.cif)
  };
}

export function saveCompany(phone, data = {}) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const existing = getCompany(cleanPhone);
  const now = new Date().toISOString();

  const name = data.name || existing.name;
  const cif = data.cif || existing.cif;
  const address = data.address || existing.address;
  const phoneContact = data.phone || existing.phone || cleanPhone;
  const email = data.email || existing.email;
  const iban = data.iban || existing.iban;
  const bizum = data.bizum || existing.bizum || cleanPhone;
  const logoPath = data.logoPath !== undefined ? data.logoPath : existing.logoPath;
  const defaultTaxRate = data.defaultTaxRate || existing.defaultTaxRate || 10;
  const defaultAdvance = data.defaultAdvance || existing.defaultAdvance || 30;

  const stmt = db.prepare(`
    INSERT INTO companies (phone, name, cif, address, phone_contact, email, iban, bizum, logo_path, default_tax_rate, default_advance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = excluded.name,
      cif = excluded.cif,
      address = excluded.address,
      phone_contact = excluded.phone_contact,
      email = excluded.email,
      iban = excluded.iban,
      bizum = excluded.bizum,
      logo_path = excluded.logo_path,
      default_tax_rate = excluded.default_tax_rate,
      default_advance = excluded.default_advance,
      updated_at = excluded.updated_at
  `);

  stmt.run(cleanPhone, name, cif, address, phoneContact, email, iban, bizum, logoPath, defaultTaxRate, defaultAdvance, now, now);
  return getCompany(cleanPhone);
}

// ─── Métodos de Presupuestos ──────────────────────────────────────────────────

export function saveBudget(phone, budget) {
  if (!budget || !budget.id) return;
  const cleanPhone = String(phone).replace(/\D/g, '');
  const now = new Date().toISOString();
  const total = budget.financials?.totalAmount || 0;

  const cleanBudget = {
    id: budget.id,
    issueDate: budget.issueDate,
    company: budget.company,
    client: budget.client,
    items: budget.items,
    financials: budget.financials,
    terms: budget.terms,
    payments: budget.payments || [],
    paymentSummary: budget.paymentSummary || { totalPaid: 0, remainingBalance: total, status: 'PENDIENTE' },
    isDraft: budget.isDraft,
    status: budget.status
  };

  const stmt = db.prepare(`
    INSERT INTO budgets (id, company_phone, client_name, client_address, client_phone, total_amount, status, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      client_name = excluded.client_name,
      client_address = excluded.client_address,
      client_phone = excluded.client_phone,
      total_amount = excluded.total_amount,
      status = excluded.status,
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    budget.id,
    cleanPhone,
    budget.client?.name || 'Cliente Particular',
    budget.client?.address || '',
    budget.client?.phone || '',
    total,
    budget.status || 'PENDIENTE_FIRMA',
    JSON.stringify(cleanBudget),
    now,
    now
  );
}

export function getBudget(id) {
  if (!id) return null;
  const stmt = db.prepare('SELECT data_json FROM budgets WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;
  try { return JSON.parse(row.data_json); } catch(e) { return null; }
}

export function listBudgets(phone, limit = 20) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const stmt = db.prepare('SELECT data_json FROM budgets WHERE company_phone = ? ORDER BY updated_at DESC LIMIT ?');
  const rows = stmt.all(cleanPhone, limit);
  const results = [];
  for (const r of rows) {
    try { results.push(JSON.parse(r.data_json)); } catch(e) {}
  }
  return results;
}

// ─── Métodos de Facturas ──────────────────────────────────────────────────────

export function saveInvoice(phone, invoice) {
  if (!invoice || !invoice.id) return;
  const cleanPhone = String(phone).replace(/\D/g, '');
  const now = new Date().toISOString();
  const total = invoice.financials?.totalAmount || 0;

  const stmt = db.prepare(`
    INSERT INTO invoices (id, budget_id, company_phone, client_name, total_amount, status, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      data_json = excluded.data_json
  `);

  stmt.run(
    invoice.id,
    invoice.budgetId || '',
    cleanPhone,
    invoice.client?.name || 'Cliente Particular',
    total,
    invoice.status || 'PENDIENTE_PAGO',
    JSON.stringify(invoice),
    now
  );
}

export function getInvoice(id) {
  if (!id) return null;
  const stmt = db.prepare('SELECT data_json FROM invoices WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;
  try { return JSON.parse(row.data_json); } catch(e) { return null; }
}

export function listInvoices(phone, limit = 20) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  const stmt = db.prepare('SELECT data_json FROM invoices WHERE company_phone = ? ORDER BY created_at DESC LIMIT ?');
  const rows = stmt.all(cleanPhone, limit);
  const results = [];
  for (const r of rows) {
    try { results.push(JSON.parse(r.data_json)); } catch(e) {}
  }
  return results;
}

// ─── Métodos de Cobros ────────────────────────────────────────────────────────

export function savePayment(phone, payment) {
  if (!payment || !payment.id) return;
  const cleanPhone = String(phone).replace(/\D/g, '');
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO payments (id, budget_id, company_phone, amount, method, concept, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data_json = excluded.data_json
  `);

  stmt.run(
    payment.id,
    payment.budgetId || '',
    cleanPhone,
    Number(payment.amount || 0),
    payment.method || 'Bizum',
    payment.concept || '',
    JSON.stringify(payment),
    now
  );
}

export function getPayments(budgetId) {
  const stmt = db.prepare('SELECT data_json FROM payments WHERE budget_id = ? ORDER BY created_at ASC');
  const rows = stmt.all(budgetId);
  const results = [];
  for (const r of rows) {
    try { results.push(JSON.parse(r.data_json)); } catch(e) {}
  }
  return results;
}
