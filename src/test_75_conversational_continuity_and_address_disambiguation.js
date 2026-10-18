import assert from 'assert';
import { db, saveBudget, findClientsByName, getBudget, ensureCompanyTenant } from './db_service.js';
import { detectIntent, resolveIntent } from './intent_router.js';
import { resolveDisambiguationChoice } from './whatsapp_gateway.js';

console.log('==========================================================');
console.log('TEST 75: CONVERSATIONAL CONTINUITY & ADDRESS DISAMBIGUATION');
console.log('==========================================================');

const tenantPhone = '34600757575';
const tenantContext = ensureCompanyTenant(tenantPhone);

// Setup: Guardar 3 homónimos de Manolito Fernández en DB
db.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext.companyId);

const b1 = {
  id: 'PRE-T75-014',
  companyId: tenantContext.companyId,
  client: { name: 'Manolito Fernández', address: 'Ubicación obra según visita', phone: '600111222' },
  financials: { totalAmount: 1500, taxableBase: 1239.67, taxAmount: 260.33 },
  status: 'ACEPTADO',
  createdAt: '2026-10-14T09:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z'
};

const b2 = {
  id: 'PRE-T75-013',
  companyId: tenantContext.companyId,
  client: { name: 'Manolito Fernández', address: 'Calle Rapuncel 14', phone: '600111333' },
  financials: { totalAmount: 2000, taxableBase: 1652.89, taxAmount: 347.11 },
  status: 'ACEPTADO',
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:00.000Z'
};

const b3 = {
  id: 'PRE-T75-012',
  companyId: tenantContext.companyId,
  client: { name: 'Manolito Fernández', address: 'Calle Mayor 8', phone: '600111444' },
  financials: { totalAmount: 1000, taxableBase: 826.45, taxAmount: 173.55 },
  status: 'FINALIZADO',
  createdAt: '2026-10-14T11:00:00.000Z',
  updatedAt: '2026-10-14T11:00:00.000Z'
};

saveBudget(tenantContext, b1);
saveBudget(tenantContext, b2);
saveBudget(tenantContext, b3);

// 1. findClientsByName busca con precisión cuando la consulta contiene Nombre + Dirección
const foundRapuncel = findClientsByName(tenantContext, 'Manolito Fernández el de la calle Rapuncel');
assert.strictEqual(foundRapuncel.length, 1, 'findClientsByName con "Manolito Fernández el de la calle Rapuncel" devuelve exactamente 1 obra');
assert.strictEqual(foundRapuncel[0].id, 'PRE-T75-013', 'Identifica PRE-T75-013 para Calle Rapuncel');

const foundMayor = findClientsByName(tenantContext, 'Manolito Fernández Calle Mayor');
assert.strictEqual(foundMayor.length, 1, 'findClientsByName con "Manolito Fernández Calle Mayor" devuelve exactamente 1 obra');
assert.strictEqual(foundMayor[0].id, 'PRE-T75-012', 'Identifica PRE-T75-012 para Calle Mayor');

const foundAll = findClientsByName(tenantContext, 'Manolito Fernández');
assert.strictEqual(foundAll.length, 3, 'findClientsByName solo con el nombre devuelve los 3 homónimos');

// 2. detectIntent y resolveIntent resuelven directamente sin desambiguación si se incluye la calle
const detectedWithStreet = detectIntent('Ahora dime cuanto me debe manolito fernandez  el de la calle rapuncel', { knownNames: ['Manolito Fernández'] });
assert.strictEqual(detectedWithStreet?.intent, 'DEBT_BY_CLIENT', 'detectIntent reconoce DEBT_BY_CLIENT');
assert.strictEqual(detectedWithStreet?.params?.clientName, 'Manolito Fernández', 'Extrae clientName limpio');
assert(detectedWithStreet?.params?.addressHint.includes('rapuncel'), 'Extrae addressHint con "rapuncel"');

const mockSession = {
  companyId: tenantContext.companyId,
  budgets: new Map([[b1.id, b1], [b2.id, b2], [b3.id, b3]]),
  pendingDisambiguation: null
};

const replyWithStreet = await resolveIntent(detectedWithStreet, tenantPhone, mockSession);
assert(!replyWithStreet.includes('He encontrado 3 clientes/obras'), 'NO dispara menú de desambiguación cuando se indica la calle');
assert(replyWithStreet.includes('PRE-T75-013'), 'Muestra directamente el estado de PRE-T75-013');
assert(replyWithStreet.includes('Calle Rapuncel'), 'Muestra la dirección correcta Calle Rapuncel');
assert(mockSession.pendingDisambiguation === null, 'No deja pendingDisambiguation colgado');

// 3. detectIntent y resolveIntent para "obra según visita"
const detectedVisita = detectIntent('cuanto me debe manolito fernandez el de obra segun visita', { knownNames: ['Manolito Fernández'] });
const replyVisita = await resolveIntent(detectedVisita, tenantPhone, mockSession);
assert(!replyVisita.includes('He encontrado 3 clientes/obras'), 'NO dispara desambiguación para "el de obra según visita"');
assert(replyVisita.includes('PRE-T75-014'), 'Muestra directamente el estado de PRE-T75-014');

// 4. resolveDisambiguationChoice reconoce opciones de dirección y "obra según visita"
const candidates = [
  { id: 'PRE2026-014', clientName: 'Manolito Fernández', clientAddress: 'Ubicación obra según visita' },
  { id: 'PRE2026-013', clientName: 'Manolito Fernández', clientAddress: 'Calle Rapuncel 14' },
  { id: 'PRE2026-012', clientName: 'Manolito Fernández', clientAddress: 'Calle Mayor 8' }
];

const c1 = resolveDisambiguationChoice('El de obra según visita', candidates);
assert.strictEqual(c1?.id, 'PRE2026-014', 'resolveDisambiguationChoice resuelve "El de obra según visita" al candidato 1');

const c2 = resolveDisambiguationChoice('el de rapuncel', candidates);
assert.strictEqual(c2?.id, 'PRE2026-013', 'resolveDisambiguationChoice resuelve "el de rapuncel" al candidato 2');

const c3 = resolveDisambiguationChoice('el tercero', candidates);
assert.strictEqual(c3?.id, 'PRE2026-012', 'resolveDisambiguationChoice resuelve "el tercero" al candidato 3');

// 5. Continuidad de Hilo Conversacional (Disambiguation Drift Prevention)
// Simulamos el flujo exacto de la captura:
// Paso 1: Usuario pregunta "¿Cuánto me debe Manolito Fernández?"
const sessionFlow = {
  companyId: tenantContext.companyId,
  phone: tenantPhone,
  budgets: new Map([[b1.id, b1], [b2.id, b2], [b3.id, b3]]),
  pendingDisambiguation: null,
  lastDisambiguation: null,
  activeBudgetId: null
};

const initialIntent = detectIntent('¿Cuánto me debe Manolito Fernández?', { knownNames: ['Manolito Fernández'] });
const initialReply = await resolveIntent(initialIntent, tenantPhone, sessionFlow);
assert(initialReply.includes('He encontrado 3 clientes/obras'), 'Paso 1: Muestra los 3 homónimos');
assert(sessionFlow.pendingDisambiguation !== null, 'Paso 1: Activa pendingDisambiguation');

// Paso 2: Usuario responde "El segundo"
const choice1 = resolveDisambiguationChoice('El segundo', sessionFlow.pendingDisambiguation.candidates);
assert.strictEqual(choice1.id, b2.id, 'Paso 2: Resuelve "El segundo" a b2 (Rapuncel)');
sessionFlow.lastDisambiguation = {
  ...sessionFlow.pendingDisambiguation,
  selectedCandidate: choice1,
  resolvedAt: Date.now()
};
sessionFlow.pendingDisambiguation = null;
sessionFlow.activeBudgetId = choice1.id;

// Paso 3: Usuario pregunta a continuación "El de obra según visita"
const followUpText = 'El de obra según visita';
const isMutation = /\b(?:cambiar?|cambia|modificar?|modifica|anadir?|añadir?|anade|añade|quitar?|quita|borrar?|borra|eliminar?|elimina|nuevo\s+presupuesto|nueva\s+obra|partida|precio|hacer\s+presupuesto)\b/i.test(followUpText);
assert(!isMutation, 'Paso 3: "El de obra según visita" NO es detectado como mutación de presupuesto');

const followUpCandidate = resolveDisambiguationChoice(followUpText, sessionFlow.lastDisambiguation.candidates);
assert.strictEqual(followUpCandidate.id, b1.id, 'Paso 3: Seguimiento conversacional resuelve directamente a b1 (obra según visita)');

// Paso 4: Mensaje con mutación explícita no se confunde con seguimiento
const mutationText = 'De la obra de Manolito quiero cambiar el precio de Demolición a 500€';
const isRealMutation = /\b(?:cambiar?|cambia|modificar?|modifica|anadir?|añadir?|anade|añade|quitar?|quita|borrar?|borra|eliminar?|elimina|nuevo\s+presupuesto|nueva\s+obra|partida|precio|hacer\s+presupuesto)\b/i.test(mutationText);
assert(isRealMutation, 'Paso 4: Modificación de partida detectada como mutación, no hijackeada por lastDisambiguation');

console.log('✅ TEST 75 superado con éxito.');
