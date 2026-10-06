/**
 * Carga datos de prueba no destructivos para una empresa ya registrada.
 * Uso: npm run seed:manual
 * Usa PRESUVOZ_DEMO_PHONE o, si falta, el primer ALLOWED_NUMBERS del .env.
 * Nunca borra datos ni crea/sobrescribe la ficha de empresa.
 */
import 'dotenv/config';
import {
  db, getCompany, getBudget, getInvoice, getAppointment,
  saveBudget, saveInvoice, saveAppointment, addShoppingItems
} from './db_service.js';

const phone = String(process.env.PRESUVOZ_DEMO_PHONE || process.env.ALLOWED_NUMBERS || '')
  .split(',')[0].replace(/\D/g, '');
if (!phone) throw new Error('Define PRESUVOZ_DEMO_PHONE o ALLOWED_NUMBERS con el teléfono del profesional de pruebas.');

const companyRow = db.prepare('SELECT id FROM companies WHERE phone = ?').get(phone);
if (!companyRow) throw new Error('No existe una empresa para el teléfono indicado. Completa primero el onboarding en el número compartido del bot.');
const migrated = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 16 OR name = '016_sequential_invoice_numbering'").get();
if (!migrated) throw new Error('La base de datos activa no tiene las migraciones requeridas; no se modificó ningún dato.');

const company = getCompany(phone);
const companyId = companyRow.id;
const tag = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const now = new Date();
const dateAt = days => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const money = n => Number(n.toFixed(2));
const created = [];
const createdCounts = { budgets: 0, invoices: 0, appointments: 0, materials: 0 };

const sampleBudgets = [
  ['01', 'Lucía Fernández', 'Reforma de baño: demolición y alicatado', 2450, 10, 'PENDIENTE_FIRMA'],
  ['02', 'Óscar Martín', 'Pintura de salón y dormitorios', 1380, 21, 'ACEPTADO'],
  ['03', 'Comunidad Calle Olivo', 'Reparación de cubierta y canalón', 3920, 21, 'PENDIENTE_FIRMA'],
  ['04', 'Nuria Sánchez', 'Armario empotrado a medida', 1875, 21, 'FACTURADO'],
  ['05', 'David Romero', 'Cambio de instalación eléctrica', 2890, 21, 'ACEPTADO'],
  ['06', 'Marta Gil', 'Visita de medición cocina', 0, 21, 'BORRADOR_MEDICION'],
  ['07', 'Clínica Alameda', 'Reparación de puertas interiores', 760, 21, 'PENDIENTE_FIRMA'],
  ['08', 'Rafael Torres', 'Fontanería y cambio de termo', 1120, 10, 'ACEPTADO']
];

for (const [suffix, clientName, description, total, taxRate, status] of sampleBudgets) {
  const id = `PVTEST-${tag}-B${suffix}`;
  if (getBudget(companyId, id)) continue;
  const taxableBase = total ? money(total / (1 + taxRate / 100)) : 0;
  const taxAmount = money(total - taxableBase);
  const itemTotal = total ? taxableBase : 0;
  const budget = {
    id, issueDate: new Date().toLocaleDateString('es-ES'), status,
    company: { ...company },
    client: { name: clientName, address: `Calle de Prueba ${Number(suffix) + 10}, ${company.city || 'Madrid'}`, phone: `6000001${suffix}` },
    items: [{ id: 1, description, qty: 1, unit: 'pa', unitPrice: itemTotal, total: itemTotal, isPricePending: total === 0 }],
    financials: {
      subtotal: itemTotal, discountPercentage: 0, discountAmount: 0,
      taxableBase, taxRatePercentage: taxRate, taxAmount, totalAmount: total,
      advancePercentage: 30, advanceAmount: money(total * 0.3), remainingAmount: money(total * 0.7)
    },
    terms: { validityDays: 15, conditions: '30% al aceptar y 70% al finalizar.' },
    payments: [], paymentSummary: { totalPaid: 0, remainingBalance: total, status: total ? 'PENDIENTE' : 'SIN_VALORAR' },
    isDraft: total === 0
  };
  saveBudget(companyId, budget);
  created.push(`presupuesto ${id}`);
  createdCounts.budgets++;
}

const invoiceSamples = [
  { suffix: '01', budget: '04', name: 'Nuria Sánchez', amount: 1875, rate: 21, status: 'PENDIENTE_PAGO', type: 'FINAL' },
  { suffix: '02', budget: '02', name: 'Óscar Martín', amount: 414, rate: 21, status: 'PAGADA', type: 'ANTICIPO' },
  { suffix: '03', budget: '05', name: 'David Romero', amount: 867, rate: 21, status: 'PENDIENTE_PAGO', type: 'ANTICIPO' },
  { suffix: '04', budget: '08', name: 'Rafael Torres', amount: 1120, rate: 10, status: 'PAGADA', type: 'FINAL' }
];

for (const inv of invoiceSamples) {
  const id = `PVTEST-${tag}-F${inv.suffix}`;
  if (getInvoice(companyId, id)) continue;
  const linkedBudgetId = `PVTEST-${tag}-B${inv.budget}`;
  const base = money(inv.amount / (1 + inv.rate / 100));
  const invoice = {
    id, budgetId: linkedBudgetId, type: inv.type, isAdvance: inv.type === 'ANTICIPO',
    issueDate: new Date().toLocaleDateString('es-ES'), operationDate: new Date().toLocaleDateString('es-ES'),
    client: { name: inv.name, address: `Dirección de prueba, ${company.city || 'Madrid'}` },
    items: [{ description: `Factura demo ${inv.type.toLowerCase()} PresuVoz`, qty: 1, unit: 'pa', unitPrice: base, total: base }],
    financials: {
      taxableBase: base, taxRatePercentage: inv.rate, taxAmount: money(inv.amount - base),
      totalAmount: inv.amount, advanceAmount: 0, remainingAmount: inv.status === 'PAGADA' ? 0 : inv.amount
    },
    status: inv.status, paymentMethod: inv.status === 'PAGADA' ? 'Transferencia' : null
  };
  saveInvoice(companyId, invoice);
  created.push(`factura ${id}`);
  createdCounts.invoices++;
}

const appointments = [
  ['01', 0, '09:30', 'Lucía Fernández', 'Visita de medición; llevar catálogo de azulejos'],
  ['02', 1, '08:30', 'Óscar Martín', 'Revisar acabado de pintura y proteger muebles'],
  ['03', 1, '12:00', 'Comunidad Calle Olivo', 'Inspeccionar filtración en cubierta; llevar escalera'],
  ['04', 2, '16:00', 'Nuria Sánchez', 'Comprobar hueco y sentido de apertura del armario'],
  ['05', 3, '10:15', 'David Romero', 'Revisión del cuadro eléctrico'],
  ['06', 5, '17:30', 'Clínica Alameda', 'Reparación de puerta de consulta'],
  ['07', 7, '11:00', 'Rafael Torres', 'Comprobar presión y conexiones del termo'],
  ['08', 10, '09:00', 'Marta Gil', 'Segunda medición de cocina']
];

for (const [suffix, days, time, clientName, notes] of appointments) {
  const id = `PVTEST-${tag}-A${suffix}`;
  if (getAppointment(companyId, id)) continue;
  saveAppointment(companyId, {
    id, date: dateAt(days), time, clientName,
    clientPhone: '600000099', clientAddress: `Obra de prueba ${suffix}, ${company.city || 'Madrid'}`,
    title: `Visita de prueba — ${clientName}`, notes, timezone: 'Europe/Madrid', status: 'CONFIRMED'
  });
  created.push(`cita ${id}`);
  createdCounts.appointments++;
}

const existingMaterials = db.prepare('SELECT notes FROM shopping_items WHERE company_id = ?').all(companyId)
  .some(row => String(row.notes || '').includes(`[PVTEST ${tag}]`));
if (!existingMaterials) {
  const insertedMaterials = addShoppingItems(companyId, [
    { description: 'Azulejo porcelánico gris 60×60', qty: 18, unit: 'm²', clientName: 'Lucía Fernández', notes: `[PVTEST ${tag}] Comprar antes de la visita` },
    { description: 'Cemento cola flexible C2TE', qty: 6, unit: 'sacos', clientName: 'Lucía Fernández', notes: `[PVTEST ${tag}]` },
    { description: 'Pintura plástica blanca mate', qty: 4, unit: 'botes', clientName: 'Óscar Martín', notes: `[PVTEST ${tag}]` },
    { description: 'Rodillo antigota 22 cm', qty: 3, unit: 'ud', clientName: 'Óscar Martín', notes: `[PVTEST ${tag}]` },
    { description: 'Cable libre de halógenos 2,5 mm²', qty: 40, unit: 'm', clientName: 'David Romero', notes: `[PVTEST ${tag}]` },
    { description: 'Tubo multicapa 20 mm', qty: 12, unit: 'm', clientName: 'Rafael Torres', notes: `[PVTEST ${tag}]` },
    { description: 'Bisagras cierre amortiguado', qty: 8, unit: 'ud', clientName: 'Nuria Sánchez', notes: `[PVTEST ${tag}]` },
    { description: 'Sellador de silicona transparente', qty: 2, unit: 'cartuchos', clientName: 'Clínica Alameda', notes: `[PVTEST ${tag}]` }
  ]);
  createdCounts.materials = insertedMaterials.length;
  if (insertedMaterials.length) created.push(`${insertedMaterials.length} materiales para la lista de compra`);
}

console.log(`Datos manuales preparados para la empresa existente (${company.name || 'sin nombre'}).`);
console.log(`Creados: ${created.length ? created.join('; ') : 'ninguno; el conjunto de hoy ya estaba cargado.'}`);
console.log(`Añadidos en esta ejecución: ${createdCounts.budgets} presupuestos, ${createdCounts.invoices} facturas, ${createdCounts.appointments} citas y ${createdCounts.materials} materiales.`);
console.log('Las citas de mañana se usan para probar el recordatorio de víspera (19:30) y el resumen matinal (07:30, hora de Madrid).');
