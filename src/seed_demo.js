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
import { db } from './db_service.js';

// ── Teléfono del profesional ────────────────────────────────────────────────
const rawNumbers = (process.env.ALLOWED_NUMBERS || '').split(',');
const PHONE = rawNumbers[0]?.trim() || '34601022367';
console.log(`📱 Insertando datos demo para el teléfono: ${PHONE}\n`);

// ── Fecha helpers ────────────────────────────────────────────────────────────
const today = new Date();
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r.toISOString().slice(0, 10); };
const fmt = (d) => d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
const now = new Date().toISOString();

// ── 1. PRESUPUESTOS ──────────────────────────────────────────────────────────
// Columnas reales: id, company_phone, client_name, client_address, client_phone, total_amount, status, data_json, created_at, updated_at
const budgets = [
  {
    id: 'PRE-DEMO-001',
    client_name: 'María García',
    client_address: 'Calle Alcalá 45, Madrid',
    client_phone: '612345678',
    total_amount: 4800.00,
    status: 'PENDIENTE',
    data_json: JSON.stringify({
      id: 'PRE-DEMO-001',
      status: 'PENDIENTE',
      client: { name: 'María García', address: 'Calle Alcalá 45, Madrid', nif: 'Consignado en contrato', phone: '612345678' },
      items: [
        { id: 'i1', description: 'Reforma baño completo: demolición, alicatado y sanitarios', qty: 1, unit: 'pa', unitPrice: 4363.64, total: 4363.64 }
      ],
      financials: { subtotal: 4363.64, taxableBase: 4363.64, taxRatePercentage: 10, taxAmount: 436.36, totalAmount: 4800.00, discountPercentage: 0, discountAmount: 0, advanceAmount: 0, remainingAmount: 4800.00 },
      payments: [],
      paymentSummary: { totalPaid: 0, pendingAmount: 4800.00 },
      createdAt: now
    })
  },
  {
    id: 'PRE-DEMO-002',
    client_name: 'Carlos Ruiz',
    client_address: 'Avenida de la Paz 12, Sevilla',
    client_phone: '698765432',
    total_amount: 2200.00,
    status: 'ACEPTADO',
    data_json: JSON.stringify({
      id: 'PRE-DEMO-002',
      status: 'ACEPTADO',
      client: { name: 'Carlos Ruiz', address: 'Avenida de la Paz 12, Sevilla', nif: 'Consignado en contrato', phone: '698765432' },
      items: [
        { id: 'i1', description: 'Pintura interior vivienda: aparejo, primera y segunda mano', qty: 85, unit: 'm²', unitPrice: 23.64, total: 2009.09 },
        { id: 'i2', description: 'Reparación de grietas y masillado previo', qty: 1, unit: 'pa', unitPrice: 181.82, total: 181.82 }
      ],
      financials: { subtotal: 2000.00, taxableBase: 2000.00, taxRatePercentage: 10, taxAmount: 200.00, totalAmount: 2200.00, discountPercentage: 0, discountAmount: 0, advanceAmount: 660.00, remainingAmount: 1540.00 },
      payments: [{ amount: 660.00, method: 'Bizum', date: fmt(today), concept: 'Anticipo 30%' }],
      paymentSummary: { totalPaid: 660.00, pendingAmount: 1540.00 },
      signedAt: now,
      createdAt: now
    })
  }
];

for (const b of budgets) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO budgets (id, company_phone, client_name, client_address, client_phone, total_amount, status, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(b.id, PHONE, b.client_name, b.client_address, b.client_phone, b.total_amount, b.status, b.data_json, now, now);
    console.log(`  ✅ Presupuesto: ${b.id} — ${b.client_name} (${b.status})`);
  } catch(e) {
    console.warn(`  ⚠️  Presupuesto ${b.id} omitido: ${e.message}`);
  }
}

// ── 2. CITAS ─────────────────────────────────────────────────────────────────
const appointments = [
  {
    id: 'APT-DEMO-001',
    client_name: 'María García',
    client_phone: '612345678',
    client_address: 'Calle Alcalá 45, Madrid',
    date: addDays(today, 0),   // hoy
    time: '10:00',
    notes: 'Toma de medidas y revisión del estado del baño antes de comenzar obra'
  },
  {
    id: 'APT-DEMO-002',
    client_name: 'Antonio López',
    client_phone: '698765432',
    client_address: 'Calle Gran Vía 100, Madrid',
    date: addDays(today, 1),   // mañana
    time: '16:30',
    notes: 'Visita técnica para valorar instalación de suelo radiante en salón'
  },
  {
    id: 'APT-DEMO-003',
    client_name: 'Sara Martínez',
    client_phone: '677123456',
    client_address: 'Plaza Mayor 5, Segovia',
    date: addDays(today, 7),   // próxima semana
    time: '09:00',
    notes: 'Medición para presupuesto de cocina nueva completa'
  }
];

for (const a of appointments) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO appointments (id, company_phone, client_name, client_phone, client_address, date, time, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(a.id, PHONE, a.client_name, a.client_phone, a.client_address, a.date, a.time, a.notes, now, now);
    console.log(`  📅 Cita: ${a.id} — ${a.client_name} (${a.date} ${a.time})`);
  } catch(e) {
    console.warn(`  ⚠️  Cita ${a.id} omitida: ${e.message}`);
  }
}

// ── 3. LISTA DE COMPRA ───────────────────────────────────────────────────────
// Columnas reales: id, company_phone, description, qty, unit, status, notes, created_at, bought_at, client_name, budget_id
const shoppingItems = [
  {
    id: 'SHP-DEMO-001',
    client_name: 'María García',
    budget_id: 'PRE-DEMO-001',
    description: 'Azulejo gris mate 60x60 porcelánico',
    qty: 22,
    unit: 'm²',
    notes: 'Reforma baño'
  },
  {
    id: 'SHP-DEMO-002',
    client_name: 'María García',
    budget_id: 'PRE-DEMO-001',
    description: 'Junta epóxica antracita Mapei Ultracolor Plus',
    qty: 5,
    unit: 'kg',
    notes: 'Reforma baño'
  }
];

for (const s of shoppingItems) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO shopping_items (id, company_phone, description, qty, unit, status, notes, created_at, client_name, budget_id)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)
    `).run(s.id, PHONE, s.description, s.qty, s.unit, s.notes, now, s.client_name, s.budget_id);
    console.log(`  🛒 Material: ${s.id} — ${s.description} (${s.qty} ${s.unit})`);
  } catch(e) {
    console.warn(`  ⚠️  Material ${s.id} omitido: ${e.message}`);
  }
}

// ── 4. FACTURA DE ANTICIPO ───────────────────────────────────────────────────
// Columnas reales: id, budget_id, company_phone, client_name, total_amount, status, data_json, created_at, rectifies_invoice_id, fiscal_period, verifactu_hash
try {
  db.prepare(`
    INSERT OR IGNORE INTO invoices (id, budget_id, company_phone, client_name, total_amount, status, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'FAC-DEMO-001', 'PRE-DEMO-002', PHONE, 'Carlos Ruiz', 660.00, 'PAGADA',
    JSON.stringify({
      id: 'FAC-DEMO-001',
      type: 'ANTICIPO',
      budgetId: 'PRE-DEMO-002',
      issueDate: fmt(today),
      operationDate: fmt(today),
      client: { name: 'Carlos Ruiz', address: 'Avenida de la Paz 12, Sevilla', nif: 'Consignado en contrato' },
      financials: { taxableBase: 600.00, taxRatePercentage: 10, taxAmount: 60.00, totalAmount: 660.00 },
      status: 'PAGADA',
      paymentMethod: 'Bizum'
    }),
    now
  );
  console.log('  🧾 Factura anticipo: FAC-DEMO-001 — Carlos Ruiz (660€)');
} catch(e) {
  console.warn(`  ⚠️  Factura omitida: ${e.message}`);
}

console.log('\n🎉 Seed demo completado. Prueba en el bot:\n');
console.log('  • "¿qué citas tengo hoy?"       → cita con María García a las 10:00');
console.log('  • "agenda de mañana"             → cita con Antonio López a las 16:30');
console.log('  • "mis presupuestos"             → PRE-DEMO-001 y PRE-DEMO-002');
console.log('  • "lista de la compra"           → azulejo y junta de María García');
