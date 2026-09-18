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
    gestoria_email TEXT,
    default_tax_rate INTEGER DEFAULT 10,
    default_advance INTEGER DEFAULT 30,
    created_at TEXT,
    updated_at TEXT
  );
`);

// Migración para bases de datos SQLite ya creadas
try {
  db.exec('ALTER TABLE companies ADD COLUMN gestoria_email TEXT;');
} catch (e) {
  // Ignorar si la columna ya existe
}

db.exec(`

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
  gestoriaEmail: null,
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
    gestoriaEmail: row.gestoria_email || null,
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
  const gestoriaEmail = data.gestoriaEmail !== undefined ? data.gestoriaEmail : existing.gestoriaEmail;
  const defaultTaxRate = data.defaultTaxRate || existing.defaultTaxRate || 10;
  const defaultAdvance = data.defaultAdvance || existing.defaultAdvance || 30;

  const stmt = db.prepare(`
    INSERT INTO companies (phone, name, cif, address, phone_contact, email, iban, bizum, logo_path, gestoria_email, default_tax_rate, default_advance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = excluded.name,
      cif = excluded.cif,
      address = excluded.address,
      phone_contact = excluded.phone_contact,
      email = excluded.email,
      iban = excluded.iban,
      bizum = excluded.bizum,
      logo_path = excluded.logo_path,
      gestoria_email = excluded.gestoria_email,
      default_tax_rate = excluded.default_tax_rate,
      default_advance = excluded.default_advance,
      updated_at = excluded.updated_at
  `);

  stmt.run(cleanPhone, name, cif, address, phoneContact, email, iban, bizum, logoPath, gestoriaEmail, defaultTaxRate, defaultAdvance, now, now);
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

// ─── Métodos de Trimestres y Gestoría ──────────────────────────────────────────

/**
 * Obtiene las facturas emitidas de un trimestre y calcula los agregados fiscales
 * @param {string} phone - Teléfono de la empresa
 * @param {number|string} [quarterInput] - 1, 2, 3, 4 o '1T', '2T', etc.
 * @param {number|string} [yearInput] - Año (ej: 2026)
 * @returns {object} Datos del trimestre con facturas y resumen para Modelo 303
 */
export function getQuarterInvoices(phone, quarterInput = null, yearInput = null) {
  const cleanPhone = String(phone).replace(/\D/g, '');
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
  const stmt = db.prepare('SELECT data_json, created_at FROM invoices WHERE company_phone = ? ORDER BY created_at ASC');
  const rows = stmt.all(cleanPhone);

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
