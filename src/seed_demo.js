/**
 * seed_demo.js — Inserta datos de demostración en la BD SQLite de PresuVoz.
 *
 * Uso: node src/seed_demo.js
 *
 * Lee el primer número de ALLOWED_NUMBERS del .env como teléfono del profesional.
 * Inserta: 2 presupuestos, 3 citas, 2 materiales de compra y 1 factura de anticipo.
 * Si los datos ya existen (misma ID) los omite sin error.
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'presuvoz.db');

const db = new Database(DB_PATH);

// ── Teléfono del profesional ────────────────────────────────────────────────
const rawNumbers = (process.env.ALLOWED_NUMBERS || '').split(',');
const PHONE = rawNumbers[0]?.trim() || '34601022367';
console.log(`📱 Insertando datos demo para el teléfono: ${PHONE}`);

// ── Fecha helpers ────────────────────────────────────────────────────────────
const today = new Date();
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().slice(0, 10); };
const fmt = (d) => d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

// ── 1. PRESUPUESTOS ──────────────────────────────────────────────────────────
const budgets = [
  {
    id: 'PRE-DEMO-001',
    status: 'PENDIENTE',
    client_name: 'María García',
    client_address: 'Calle Alcalá 45, Madrid',
    total_amount: 4800.00,
    tax_amount: 436.36,
    data_json: JSON.stringify({
      id: 'PRE-DEMO-001',
      status: 'PENDIENTE',
      client: { name: 'María García', address: 'Calle Alcalá 45, Madrid', nif: 'Consignado en contrato' },
      items: [
        { id: 'i1', description: 'Reforma baño completo: demolición, alicatado y sanitarios', qty: 1, unit: 'pa', unitPrice: 4363.64, total: 4363.64 }
      ],
      financials: { subtotal: 4363.64, taxableBase: 4363.64, taxRatePercentage: 10, taxAmount: 436.36, totalAmount: 4800.00, discountPercentage: 0, discountAmount: 0, advanceAmount: 0, remainingAmount: 4800.00 },
      payments: [],
      paymentSummary: { totalPaid: 0, pendingAmount: 4800.00 },
      createdAt: new Date().toISOString()
    })
  },
  {
    id: 'PRE-DEMO-002',
    status: 'ACEPTADO',
    client_name: 'Carlos Ruiz',
    client_address: 'Avenida de la Paz 12, Sevilla',
    total_amount: 2200.00,
    tax_amount: 200.00,
    data_json: JSON.stringify({
      id: 'PRE-DEMO-002',
      status: 'ACEPTADO',
      client: { name: 'Carlos Ruiz', address: 'Avenida de la Paz 12, Sevilla', nif: 'Consignado en contrato' },
      items: [
        { id: 'i1', description: 'Pintura interior vivienda: aparejo, primera y segunda mano', qty: 85, unit: 'm²', unitPrice: 23.64, total: 2009.09 },
        { id: 'i2', description: 'Reparación de grietas y masillado previo', qty: 1, unit: 'pa', unitPrice: 181.82, total: 181.82 }
      ],
      financials: { subtotal: 2000.00, taxableBase: 2000.00, taxRatePercentage: 10, taxAmount: 200.00, totalAmount: 2200.00, discountPercentage: 0, discountAmount: 0, advanceAmount: 660.00, remainingAmount: 1540.00 },
      payments: [{ amount: 660.00, method: 'Bizum', date: fmt(today), concept: 'Anticipo 30%' }],
      paymentSummary: { totalPaid: 660.00, pendingAmount: 1540.00 },
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    })
  }
];

const insertBudget = db.prepare(`
  INSERT OR IGNORE INTO budgets (id, company_phone, status, client_name, client_address, total_amount, tax_amount, data_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const now = new Date().toISOString();
for (const b of budgets) {
  insertBudget.run(b.id, PHONE, b.status, b.client_name, b.client_address, b.total_amount, b.tax_amount, b.data_json, now, now);
  console.log(`  ✅ Presupuesto: ${b.id} — ${b.client_name} (${b.status})`);
}

// ── 2. CITAS ─────────────────────────────────────────────────────────────────
const appointments = [
  {
    id: 'APT-DEMO-001',
    client_name: 'María García',
    client_phone: '612345678',
    client_address: 'Calle Alcalá 45, Madrid',
    date: addDays(today, 0), // hoy
    time: '10:00',
    notes: 'Toma de medidas y revisión del estado del baño antes de comenzar obra'
  },
  {
    id: 'APT-DEMO-002',
    client_name: 'Antonio López',
    client_phone: '698765432',
    client_address: 'Calle Gran Vía 100, Madrid',
    date: addDays(today, 1), // mañana
    time: '16:30',
    notes: 'Visita técnica para valorar instalación de suelo radiante en salon'
  },
  {
    id: 'APT-DEMO-003',
    client_name: 'Sara Martínez',
    client_phone: '677123456',
    client_address: 'Plaza Mayor 5, Segovia',
    date: addDays(today, 7), // próxima semana
    time: '09:00',
    notes: 'Medición para presupuesto de cocina nueva completa'
  }
];

const insertAppt = db.prepare(`
  INSERT OR IGNORE INTO appointments (id, company_phone, client_name, client_phone, client_address, date, time, notes, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', ?, ?)
`);
for (const a of appointments) {
  insertAppt.run(a.id, PHONE, a.client_name, a.client_phone, a.client_address, a.date, a.time, a.notes, now, now);
  console.log(`  📅 Cita: ${a.id} — ${a.client_name} (${a.date} ${a.time})`);
}

// ── 3. LISTA DE COMPRA (MATERIALES) ─────────────────────────────────────────
const shoppingItems = [
  {
    id: 'SHP-DEMO-001',
    client_name: 'María García',
    description: 'Azulejo gris mate 60x60 porcelánico',
    qty: 22,
    unit: 'm²',
    status: 'PENDING'
  },
  {
    id: 'SHP-DEMO-002',
    client_name: 'María García',
    description: 'Junta epóxica antracita Mapei Ultracolor Plus',
    qty: 5,
    unit: 'kg',
    status: 'PENDING'
  }
];

// Detectar si existe tabla shopping_items o shopping_list
let shoppingTable = null;
try {
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shopping_items'").get();
  shoppingTable = 'shopping_items';
} catch(e) {}
if (!shoppingTable) {
  try {
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shopping_list'").get();
    shoppingTable = 'shopping_list';
  } catch(e) {}
}

if (shoppingTable) {
  // Detectar columnas disponibles
  const cols = db.prepare(`PRAGMA table_info(${shoppingTable})`).all().map(c => c.name);
  if (cols.includes('company_phone') && cols.includes('description')) {
    const insertShop = db.prepare(`
      INSERT OR IGNORE INTO ${shoppingTable} (id, company_phone, client_name, description, qty, unit, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of shoppingItems) {
      insertShop.run(s.id, PHONE, s.client_name, s.description, s.qty, s.unit, s.status, now, now);
      console.log(`  🛒 Material: ${s.id} — ${s.description} (${s.qty} ${s.unit})`);
    }
  } else {
    console.log('  ⚠️  Tabla shopping sin columnas esperadas, omitiendo materiales.');
  }
} else {
  console.log('  ⚠️  No se encontró tabla de lista de compra, omitiendo materiales.');
}

// ── 4. FACTURA DE ANTICIPO ───────────────────────────────────────────────────
const advanceInvoice = {
  id: 'FAC-DEMO-001',
  budget_id: 'PRE-DEMO-002',
  client_name: 'Carlos Ruiz',
  total_amount: 660.00,
  status: 'PAGADA',
  data_json: JSON.stringify({
    id: 'FAC-DEMO-001',
    type: 'ANTICIPO',
    budgetId: 'PRE-DEMO-002',
    issueDate: fmt(today),
    operationDate: fmt(today),
    client: { name: 'Carlos Ruiz', address: 'Avenida de la Paz 12, Sevilla', nif: 'Consignado en contrato' },
    financials: {
      taxableBase: 600.00,
      taxRatePercentage: 10,
      taxAmount: 60.00,
      totalAmount: 660.00
    },
    status: 'PAGADA',
    paymentMethod: 'Bizum'
  })
};

const insertInvoice = db.prepare(`
  INSERT OR IGNORE INTO invoices (id, company_phone, budget_id, client_name, total_amount, status, data_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insertInvoice.run(advanceInvoice.id, PHONE, advanceInvoice.budget_id, advanceInvoice.client_name, advanceInvoice.total_amount, advanceInvoice.status, advanceInvoice.data_json, now, now);
console.log(`  🧾 Factura anticipo: ${advanceInvoice.id} — ${advanceInvoice.client_name} (${advanceInvoice.total_amount}€)`);

console.log('\n🎉 Seed demo completado. Reinicia el bot y prueba:\n');
console.log('  • "¿qué citas tengo hoy?"         → verás cita con María García');
console.log('  • "agenda de mañana"               → cita con Antonio López');
console.log('  • "mis presupuestos"               → PRE-DEMO-001 y PRE-DEMO-002');
console.log('  • "lista de la compra"             → materiales de María García');
console.log('  • "resumen del día" al arrancar    → briefing con todo');
