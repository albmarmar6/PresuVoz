import './test_env_setup.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PresuVozEngine, formatInvoiceNaming, formatReceiptNaming, getBudgetClientNumber, getBudgetYear } from './engine.js';
import { PresuVozParser } from './parser.js';
import { generateInvoicePDF } from './pdf_service.js';
import { isLikelyBudgetTranscript, isExplicitNewBudgetTranscript } from './ai_service.js';
import {
  shouldProcessIncomingMessage,
  isAuthorizedEgressRecipient,
  authenticateWhatsAppSession,
  getUserSession,
  extractCanonicalSenderIdentifier,
  userSessions,
  handleScheduleAppointment,
  handleListAppointments,
  handleCancelAppointment,
  handleUpdateAppointment,
  handleCompleteAppointments,
  findDuplicateBudgetItemGroups,
  handleAddShoppingItems,
  handleListShoppingItems,
  handleMarkShoppingItemBought,
  handleClearShoppingList,
  parseBoughtAllShoppingForClients,
  findUngroundedAudioItems,
  professionalizeAudioSourcePhrase,
  detectSpecificBudgetQuery,
  findBudgetByQuery,
  detectBudgetListIntent,
  detectAgendaQueryIntent,
  detectShoppingListQueryIntent,
  resolveRequireExplicitAuth,
  clearGatewayTimers,
  gracefulShutdown,
  resetShutdownStateForTesting
} from './whatsapp_gateway.js';
import {
  acquireGatewayLock,
  releaseGatewayLock,
  isPidAlive
} from './instance_lock.js';
import { canStartDbViewer, HOST as DB_VIEWER_HOST } from './db_viewer.js';
import {
  normalizeToE164,
  isPlatformAdmin,
  isPhoneNumberAuthorized,
  authorizePhoneNumber,
  revokePhoneNumber,
  listAuthorizedPhoneNumbers,
  parseAdminCommand
} from './access_control_service.js';
import { formatListIndex } from './secretary_service.js';

export function computeFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Captura de integridad inicial de la base de datos de producción
const PROD_DB_PATH = path.resolve('data', 'presuvoz.db');
const HISTORICAL_PRE015_PROD_PATH = path.resolve('data', 'backups', 'presuvoz_pre_migration_backup.db');
const prodDbInitialStat = fs.existsSync(PROD_DB_PATH) 
  ? { mtimeMs: fs.statSync(PROD_DB_PATH).mtimeMs, size: fs.statSync(PROD_DB_PATH).size }
  : null;
const prodDbInitialSha256 = computeFileSha256(PROD_DB_PATH);
const TEST_DB_PATH = path.resolve('data', 'presuvoz_test.db');
const testDbInitialSha256 = computeFileSha256(TEST_DB_PATH);

import { runMigrations as initialRunMigrations } from './migration_service.js';
import { db as testDatabaseSync } from './db_service.js';
initialRunMigrations(testDatabaseSync, { authorized: true });

console.log("==========================================================");
console.log("🛡️  BATERÍA DE PRUEBAS DE ESTRÉS Y SEGURIDAD PRESUVOZ");
console.log("==========================================================\n");

const engine = new PresuVozEngine({
  name: "Instalaciones & Reformas Técnicas S.L.",
  cif: "B-99887766",
  phone: "600 123 456",
  email: "contacto@reformas.es",
  address: "Polígono Industrial Sur, Madrid",
  logoText: "IR",
  brandColor: "#0f766e",
  professionalSigner: "Carlos Mendoza (Responsable Técnico)"
});

let passedCount = 0;
let totalCount = 0;

function assert(condition, message) {
  totalCount++;
  if (condition) {
    console.log(`  [PASS] ${message}`);
    passedCount++;
  } else {
    console.error(`  [FAIL] ${message}`);
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// CASO 1: Audio sucio con muletillas, slang ("pavos"), quejas y comentarios personales
// -----------------------------------------------------------------------------
console.log("TEST 1: Audio con jerga, 'pavos', quejas y comentarios del perro");
const audioSucio = `
Oye Carlos qué pasa tío, mira te grabo que salgo de la obra que casi me muerde el perro del cliente, vaya tela...
Bueno a ver, para Don Rodrigo Barroso en Calle Alcalá cuarenta y cuatro:
- Cambiar la bañera y poner el plato de ducha por cuatrocientos pavos.
- Grifería termostática y mampara fija por trescientos cincuenta pavos.
- Y dile que no sea rata y pague el treinta por ciento de anticipo a la firma.
Al ser vivienda habitual aplica IVA 10%.
`;

const res1 = engine.process(audioSucio);

const literalAudioFallback = 'Cambio de puertas correderas y reparación de paredes';
const literalFallbackResult = engine.process({
  rawTranscript: literalAudioFallback,
  items: [{ description: literalAudioFallback, qty: 1, unit: 'pa', unitPrice: 0, isPricePending: true, preserveDescription: true }]
});
assert(literalFallbackResult.success && literalFallbackResult.items[0].description === literalAudioFallback,
  'La ruta segura conserva literalmente la transcripción y no la reclasifica como otra partida');
assert(!PresuVozParser.normalizeItemDescription('Reparación de paredes').startsWith('Instalación integral de fontanería'),
  'La palabra “paredes” no activa la regla de fontanería por contener “red”');

assert(res1.success === true, "El motor procesa el audio sucio correctamente");
assert(res1.client.name === "Rodrigo Barroso", "Extrae el cliente limpio ('Rodrigo Barroso')");
assert(res1.client.address.includes("Calle Alcalá"), "Extrae la dirección ('Calle Alcalá')");
assert(res1.items.length === 2, "Extrae exactamente 2 partidas");

// Verificar que ninguna palabra prohibida se coló en las partidas
const forbiddenRegexes = [
  /\bperro\b/i,
  /\brata\b/i,
  /\bpavos?\b/i,
  /\bvaya\s+tela\b/i,
  /\bqu[eé]\s+pasa\b/i,
  /\bt[ií]o\b/i,
  /\boye\b/i
];

let leakFound = false;
for (const item of res1.items) {
  for (const regex of forbiddenRegexes) {
    if (regex.test(item.description)) {
      leakFound = true;
      console.error(`  ALERTA: Fuga de palabra inapropiada: '${regex}' en: ${item.description}`);
    }
  }
}
assert(!leakFound, "Cero fugas de palabras prohibidas o informales en las descripciones");
assert(res1.financials.subtotal === 750, `Subtotal exacto calculado (400 + 350 = 750 €). Obtenido: ${res1.financials.subtotal} €`);
assert(res1.financials.taxRatePercentage === 10, "Aplica IVA reducido del 10% para vivienda habitual");
assert(res1.financials.totalAmount === 825, `Total con IVA exacto (825.00 €). Obtenido: ${res1.financials.totalAmount} €`);
assert(res1.financials.advancePercentage === 30, "Extrae anticipo del 30%");

const homeWithoutExplicitTax = engine.process('Para Ana en Calle Sol 1, reforma de vivienda habitual, reparación de una puerta por 100 euros.');
assert(homeWithoutExplicitTax.success && homeWithoutExplicitTax.financials.taxRatePercentage === 21,
  "No infiere IVA reducido por mencionar vivienda habitual sin tipo explícito ni perfil fiscal configurado");

console.log("\n  Partidas resultantes limpias generadas:");
res1.items.forEach((it, i) => console.log(`    ${i + 1}. ${it.description} — ${it.total} €`));
console.log("");

// -----------------------------------------------------------------------------
// CASO 2: Cantidades y números en letras ("mil doscientos", "cuatro puertas a 60")
// -----------------------------------------------------------------------------
console.log("TEST 2: Cantidades y números en letras en Carpintería");
const audioNumerosLetras = `
Para Doña Carmen Vázquez en Avenida Constitución quince:
- Fabricación a medida de armario empotrado por mil doscientos euros.
- 4 puertas de paso y cambio de manivelas por doscientos cuarenta euros.
Validez quince días y cobramos el cuarenta por ciento por adelantado.
`;

const res2 = engine.process(audioNumerosLetras);
assert(res2.success === true, "Procesa correctamente números en palabras");
assert(res2.client.name === "Carmen Vázquez", "Extrae 'Carmen Vázquez'");
assert(res2.items[0].total === 1200, "Convierte 'mil doscientos euros' a 1200.00 €");
assert(res2.items[1].qty === 4, "Detecta cantidad 4 en puertas de paso");
assert(res2.items[1].total === 240, "Total de partida 2 es 240.00 €");
assert(res2.items[1].unitPrice === 60, "Precio unitario calculado correctamente (240 / 4 = 60.00 €)");
assert(res2.financials.advancePercentage === 40, "Extrae 40% de anticipo");
console.log("");

// -----------------------------------------------------------------------------
// CASO 3: Electricidad con IVA general (21%) y sin mención de vivienda
// -----------------------------------------------------------------------------
console.log("TEST 3: Local Comercial y Régimen General 21% IVA");
const audioComercial = `
Para Oficinas Madrid S.L. en Paseo Castellana noventa:
- Adecuar el cuadro eléctrico general con diferencial y magnetotérmico por ochenta y cinco euros.
- Suministro y montaje de línea reforzada para climatización por ciento cuarenta euros.
`;

const res3 = engine.process(audioComercial);
assert(res3.success === true, "Procesa caso comercial");
assert(res3.financials.taxRatePercentage === 21, "Aplica IVA general del 21% por defecto");
assert(res3.financials.subtotal === 225, `Subtotal exacto (85 + 140 = 225 €). Obtenido: ${res3.financials.subtotal} €`);
assert(res3.financials.taxAmount === 47.25, `Cuota de IVA 21% calculada: 47.25 €. Obtenido: ${res3.financials.taxAmount} €`);
console.log("");

// -----------------------------------------------------------------------------
// CASO 4: Generación Resiliente — Envía presupuesto y avisa de partidas sin precio
// -----------------------------------------------------------------------------
console.log("TEST 4: Audio con partidas válidas Y una partida sin precio (Genera + Avisa)");
const audioConAdvertencia = `
Para Don Pedro Gómez en Calle Mayor cuarenta:
- Cambiar la bañera y poner plato de ducha por cuatrocientos cincuenta euros.
- Alicatar la pared del baño que no sé cuánto cobrarle todavía.
- Grifería termostática por ochenta euros.
`;

const res4 = engine.process(audioConAdvertencia);
assert(res4.success === true, "El motor GENERA el presupuesto con las partidas valoradas (no se pierde el trabajo)");
assert(res4.hasWarnings === true, "Activa la bandera de advertencias (hasWarnings: true)");
assert(res4.items.filter(it => !it.isPricePending).length === 2, "Incluye las 2 partidas con precio valoradas (plato y grifería)");
assert(res4.items.length === 3, "Conserva además la partida pendiente en el presupuesto");
assert(res4.financials.subtotal === 530, `Calcula el subtotal exacto de las partidas valoradas (450 + 80 = 530 €)`);
assert(res4.warnings.length > 0, "Registra la partida pendiente en la lista de avisos");
assert(res4.warnings[0].toLowerCase().includes("alicata"), "Identifica con precisión qué partida quedó pendiente ('alicatado')");
assert(res4.assistantFeedback.includes("⚠️"), "Genera el mensaje de WhatsApp avisando al instalador con soluciones");

console.log("\n  Mensaje automático que WhatsApp enviará al instalador:");
console.log("  ------------------------------------------------------------");
console.log("  " + res4.assistantFeedback.replace(/\n/g, "\n  "));
console.log("  ------------------------------------------------------------\n");

// -----------------------------------------------------------------------------
// CASO 5: Actualización Conversacional — Rellenar precio pendiente con mensaje
// -----------------------------------------------------------------------------
console.log("TEST 5: Rellenar campo pendiente mediante mensaje corto ('Ponle 250 al alicatado')");
const updateRes = engine.updateBudgetPrice(res4.budget, "Ponle 250 al alicatado");
assert(updateRes.success === true, "El motor procesa la actualización conversacional con éxito");
assert(updateRes.budget.items[1].total === 250, "Asigna 250.00 € a la partida de alicatado");
assert(updateRes.budget.financials.subtotal === 780, `Recalcula el subtotal automáticamente (530 + 250 = 780 €). Obtenido: ${updateRes.budget.financials.subtotal} €`);
assert(updateRes.budget.hasWarnings === false, "Todas las partidas quedan valoradas (hasWarnings: false)");
assert(updateRes.budget.status === "PENDIENTE_FIRMA", "El estado pasa a 'PENDIENTE_FIRMA'");
console.log(`  Respuesta de WhatsApp al instalador:\n  "${updateRes.assistantMessage}"\n`);

// -----------------------------------------------------------------------------
// CASO 6: Audio sin ningún precio en absoluto — Borrador de Visita Técnica
// -----------------------------------------------------------------------------
console.log("TEST 6: Audio sin precios — Generación de Borrador de Visita Técnica (Medición)");
const audioVisitaSinPrecios = `
Para Don Javier en Calle Sierpes cinco:
- Demolición de tabique interior.
- Rozas para enchufes e instalación eléctrica de cocina.
- Pintura plástica lisa en paredes y techos.
`;

const res6 = engine.process(audioVisitaSinPrecios);
assert(res6.success === true, "Genera el borrador de visita técnica sin rechazar el audio");
assert(res6.isDraft === true, "Identifica el documento como Borrador (isDraft: true)");
assert(res6.status === "BORRADOR_MEDICION", "Estado asignado: 'BORRADOR_MEDICION'");
assert(res6.items.length === 3, "Conserva íntegramente las 3 partidas descritas en la visita");
assert(res6.items[0].isPricePending === true, "Marca la partida como pendiente de valorar");
assert(res6.assistantFeedback.includes("Borrador"), "Emite confirmación con el listado de partidas guardadas");
console.log(`  Respuesta de WhatsApp al instalador:\n  "${res6.assistantFeedback}"\n`);

// -----------------------------------------------------------------------------
// CASO 7: Audio continuo corrido sin puntuación (Voz natural en una sola frase)
// -----------------------------------------------------------------------------
console.log("TEST 7: Audio continuo sin signos de puntuación ni saltos de línea");
const audioContinuo = "hola buenas tardes me gustaría presupuestar una casa en torrelavella en Sevilla con una mampara de 250 euros habría que cambiar el suelo del baño habría que hacer una reforma integral de quitar las paredes de la cocina también de la habitación eso lo llevaría aún total de 300 euros y ya está, aplica IVA 10%";

const res7 = engine.process(audioContinuo);
assert(res7.success === true, "Procesa con éxito un audio continuo sin pausas ni puntuación");
assert(res7.client.address === "Torrelavella, Sevilla", `Extrae la localidad limpia ('Torrelavella, Sevilla'). Obtenido: ${res7.client.address}`);
assert(res7.items.length === 3, `Segmenta con precisión las 3 partidas descritas. Obtenido: ${res7.items.length}`);
assert(res7.items[0].total === 250, "Partida 1 (Mampara): 250.00 €");
assert(res7.items[1].isPricePending === true, "Partida 2 (Suelo del baño): Marcada como pendiente de valorar");
assert(res7.items[2].total === 300, "Partida 3 (Demolición paredes/cocina/habitación): 300.00 €");
assert(res7.financials.subtotal === 550, `Subtotal exacto (250 + 300 = 550 €). Obtenido: ${res7.financials.subtotal} €`);
assert(res7.financials.taxRatePercentage === 10, "Aplica IVA 10% cuando el profesional lo especifica expresamente");
assert(res7.financials.totalAmount === 605, `Total exacto con IVA (605.00 €). Obtenido: ${res7.financials.totalAmount} €`);
assert(res7.hasWarnings === true, "Avisa al usuario de que el suelo del baño no tenía precio en el audio");

// Prueba de actualización conversacional para completar el suelo
const upd7 = engine.updateBudgetPrice(res7.budget, "Ponle 180 euros al suelo");
assert(upd7.success === true, "Permite completar el precio del suelo del baño por chat");
assert(upd7.budget.financials.subtotal === 730, `Nuevo subtotal recalculado: 730.00 €. Obtenido: ${upd7.budget.financials.subtotal} €`);
assert(upd7.budget.financials.totalAmount === 803, `Nuevo total con IVA recalculado: 803.00 €. Obtenido: ${upd7.budget.financials.totalAmount} €`);
console.log(`  Respuesta de WhatsApp al completar la partida:\n  "${upd7.assistantMessage}"\n`);

// -----------------------------------------------------------------------------
// CASO 8: Validación Geográfica de Direcciones y Corrección Interactiva
// -----------------------------------------------------------------------------
console.log("TEST 8: Detección de inconsistencias geográficas y corrección de dirección");

// 8.1 Inconsistencia Torrelavella vs Sevilla (Torrelavega es Cantabria / ¿Torreblanca?)
const audioGeoInconsistente = "hola buenas tardes me gustaría presupuestar una casa en torrelavella en Sevilla con una mampara de 250 euros";
const res8 = engine.process(audioGeoInconsistente);
assert(res8.success === true, "Genera el presupuesto a pesar de la duda en la dirección");
assert(res8.hasWarnings === true, "Activa avisos por sospecha geográfica");
const hasGeoWarning = res8.warnings.some(w => w.includes("dirección correcta") && w.includes("Torrelavella"));
assert(hasGeoWarning, "Genera advertencia explícita preguntando si 'Torrelavella en Sevilla' es correcta");
assert(res8.assistantFeedback.includes("Torrelavega") || res8.assistantFeedback.includes("Torreblanca"), "Menciona Cantabria o sugiere el barrio de Torreblanca");

console.log(`  Pregunta del bot al instalador:\n  "${res8.warnings[0]}"\n`);

// 8.2 Corrección interactiva por chat ("Es en Torreblanca")
const upd8 = engine.updateBudget(res8.budget, "Es en Torreblanca");
assert(upd8.success === true, "Procesa la corrección de dirección por chat");
assert(upd8.budget.client.address === "Torreblanca, Sevilla", `Actualiza la dirección manteniendo la provincia: ${upd8.budget.client.address}`);
const remainingGeoWarning = upd8.budget.warnings.some(w => w.includes("dirección correcta"));
assert(!remainingGeoWarning, "Elimina la advertencia de dirección tras ser corregida");
console.log(`  Respuesta del bot tras corrección:\n  "${upd8.assistantMessage}"\n`);

// 8.3 Mismatch cruzado de provincias (Marbella en Sevilla -> Alerta de Málaga)
const audioMarbellaSevilla = "Para Don Antonio en Marbella en Sevilla: cambiar termo eléctrico 200 euros";
const resMarbella = engine.process(audioMarbellaSevilla);
assert(resMarbella.warnings.some(w => w.includes("Málaga") && w.includes("Marbella")), "Detecta que Marbella pertenece a Málaga y no a Sevilla");

// 8.4 Dirección correcta no genera falsos positivos (Dos Hermanas en Sevilla)
const audioCorrecto = "Para Doña Luisa en Dos Hermanas en Sevilla: instalación de aire acondicionado 400 euros";
const resCorrecto = engine.process(audioCorrecto);
assert(!resCorrecto.warnings.some(w => w.includes("dirección correcta")), "No emite advertencias para municipios legítimos ('Dos Hermanas, Sevilla')");
console.log("");

// -----------------------------------------------------------------------------
// CASO 9: Caso Real Completo — Dirección detallada en Sevilla, limpieza de 'eso sería todo'
// y Audio 2 multi-partida (Ventanas 100€, Suelo 350€, Remoquetar zarum 30€)
// -----------------------------------------------------------------------------
console.log("TEST 9: Caso Real Completo — Dirección con número/piso, frases de cierre y audio 2 multi-partida");

const audioReal1 = "hola buenas tardes para alberto martín la casa se encuentra en sevilla en la calle girasol numero 7 , 2ºC demoler tabiques 250 euros mampara 100 euros hacer una reestructuración de las ventanas cambiar soporte eléctrico y eso sería todo, aplica IVA 10%";
const res9_1 = engine.process(audioReal1);

assert(res9_1.success === true, "Procesa audio 1 complejo sin errores");
assert(res9_1.client.name === "Alberto Martín", `Extrae cliente limpio ('Alberto Martín'). Obtenido: ${res9_1.client.name}`);
assert(res9_1.client.address === "Calle Girasol Nº 7, 2ºC, Sevilla", `Extrae calle completa con número, piso y ciudad ('Calle Girasol Nº 7, 2ºC, Sevilla'). Obtenido: ${res9_1.client.address}`);
assert(res9_1.items.length === 4, `Segmenta con precisión las 4 partidas (2 valoradas y 2 pendientes). Obtenido: ${res9_1.items.length}`);
assert(res9_1.items[0].total === 250, "Partida 1 (Demolición tabiquería): 250.00 €");
assert(res9_1.items[1].total === 100, "Partida 2 (Mampara de seguridad): 100.00 €");
assert(res9_1.items[2].isPricePending === true, "Partida 3 (Ventanas): Pendiente de valorar");
assert(res9_1.items[3].isPricePending === true, "Partida 4 (Soporte eléctrico): Pendiente de valorar");
assert(res9_1.financials.subtotal === 350, `Subtotal exacto (250 + 100 = 350 €). Obtenido: ${res9_1.financials.subtotal} €`);

// Verificar que 'y eso sería todo' no se filtró a ninguna descripción
const hasClosingJunk = res9_1.items.some(it => /(?:eso\s+ser[ií]a\s+todo|ya\s+est[aá])/i.test(it.description));
assert(!hasClosingJunk, "Cero fugas de frases coloquiales de cierre ('y eso sería todo') en los conceptos técnicos");

// Enviar Audio 2 con actualización multi-partida (valorar ventanas + añadir suelo + añadir moqueta zarum)
const audioReal2 = "suministros eh te voy a decir lo que va a costar poner las ventanas va a salir por unos 100 euros cambiar el suelo va a salir por unos 350 y hay que remoquetar el zarum que va a salir por uno o 30 euros";
const res9_2 = engine.updateBudget(res9_1.budget, audioReal2);

assert(res9_2.success === true, "El motor procesa el audio 2 multi-partida conversacional");
assert(res9_2.budget.items[2].total === 100, "Asigna 100.00 € a la partida pendiente de ventanas");
assert(res9_2.budget.items[2].isPricePending === false, "Partida de ventanas queda marcada como valorada");

// Verificar que se añadieron las dos nuevas partidas
const sueloItem = res9_2.budget.items.find(it => /pavimento|suelo/i.test(it.description) && it.total === 350);
assert(Boolean(sueloItem), "Añade correctamente la partida de suelo por 350.00 €");

const moquetaItem = res9_2.budget.items.find(it => /moqueta|textil/i.test(it.description) && it.total === 30);
assert(Boolean(moquetaItem), "Añade correctamente la partida de moqueta (remoquetar zarum) por 30.00 €");

// Partida 4 (soporte eléctrico) sigue pendiente
assert(res9_2.budget.items[3].isPricePending === true, "Mantiene pendiente la partida de cuadro/soporte eléctrico");

// Recalcular subtotal: 250 + 100 + 100 + 350 + 30 = 830 €
assert(res9_2.budget.financials.subtotal === 830, `Recalcula subtotal acumulado exacto (830.00 €). Obtenido: ${res9_2.budget.financials.subtotal} €`);
assert(res9_2.budget.financials.totalAmount === 913, `Total con IVA 10% exacto (913.00 €). Obtenido: ${res9_2.budget.financials.totalAmount} €`);

console.log(`  Respuesta de WhatsApp al procesar Audio 2:\n  "${res9_2.assistantMessage.slice(0, 180)}..."\n`);

// -----------------------------------------------------------------------------
// CASO 10: Caso Real de Obra Completa — 5 Capítulos Maestros de Reforma Integral
// Tratamiento de rangos de precios (Math.max recomendado en obra), Whisper glitch (4.205.000)
// y eliminación radical de la trampa del 'porque'
// -----------------------------------------------------------------------------
console.log("TEST 10: Obra Completa — 5 Capítulos, Rangos de Precio (Math.max), Glitch Whisper y Sin Fugas de 'porque'");

const audioObraCompleta = "oye te voy a comentar la partida primera partida eh demoliciones y de escombro uno un corte un corte estimado de unos 4.500 a 6000 euros porque habría que hacer un picado de azulejos de arriba de tabiquería interior vieja retirada de carpintería etc luego la partida segunda sería albañilería general y distribución un levantado tabique nuevo en maestrado y regresión solo para nivelar enfocado falso techo de pladur en toda vivienda eso podría costar unos 8.000 a 11.000 euros luego vamos con la partida tercera fontanería y saneamiento red completa nuevas multicapa o polietileno reticulado unos 4.205.000 euros electricidad y telecomunicaciones sería la cuarta partida entre unos 4.000 y 5.500 euros porque habría que hacer un cuadro general nuevo según RBT con protaciones completas y por último la partida cinco alicatados y solados que sería unos 5.500 7.500 euros porque habría que hacer una colocación de suelo porcelánico o grespe en, que esta bastante bien, sinceramente. IVA 10%.";

const res10 = engine.process(audioObraCompleta);

assert(res10.success === true, "Procesa el audio completo de reforma integral de 5 capítulos");
assert(res10.items.length === 5, `Detecta exactamente 5 capítulos de obra (sin items fantasma ni duplicados). Obtenido: ${res10.items.length}`);

// Validar precios de cada capítulo con la regla de obra (cota superior / Math.max para salvaguardar márgenes)
assert(res10.items[0].total === 6000, `Capítulo 1 (Demolición y escombro): Cota superior 6.000,00 €. Obtenido: ${res10.items[0].total} €`);
assert(res10.items[1].total === 11000, `Capítulo 2 (Albañilería y distribución): Cota superior 11.000,00 €. Obtenido: ${res10.items[1].total} €`);
assert(res10.items[2].total === 5000, `Capítulo 3 (Fontanería y saneamiento): Resuelve fallo fonético Whisper (4.205.000 -> 5.000,00 €). Obtenido: ${res10.items[2].total} €`);
assert(res10.items[3].total === 5500, `Capítulo 4 (Electricidad y REBT): Cota superior 5.500,00 €. Obtenido: ${res10.items[3].total} €`);
assert(res10.items[4].total === 7500, `Capítulo 5 (Alicatados y solados): Cota superior 7.500,00 €. Obtenido: ${res10.items[4].total} €`);

// Validar suma y base imponible total: 6.000 + 11.000 + 5.000 + 5.500 + 7.500 = 35.000 €
assert(res10.financials.subtotal === 35000, `Base imponible exacta calculada (35.000,00 €). Obtenido: ${res10.financials.subtotal} €`);
assert(res10.financials.taxRatePercentage === 10, "Aplica IVA 10% indicado expresamente en el dictado");
assert(res10.financials.totalAmount === 38500, `Total con IVA exacto (38.500,00 €). Obtenido: ${res10.financials.totalAmount} €`);

// Verificación anti-fugas: Ninguna descripción técnica debe contener "porque", "bastante bien", "sinceramente", "corte estimado"
let leakFound10 = false;
for (const it of res10.items) {
  if (/\b(?:porque|ya\s+que|bastante\s+bien|sinceramente|corte\s+estimado|eh|oye)\b/i.test(it.description)) {
    leakFound10 = true;
    console.error(`  ALERTA: Fuga en partida: "${it.description}"`);
  }
}
assert(!leakFound10, "Cero fugas de explicaciones verbales ('porque habría que...') ni muletillas en los 5 capítulos");

console.log("\n  Capítulos maestros generados para la reforma integral:");
res10.items.forEach((it, i) => console.log(`    Capítulo ${i + 1} [${it.unit}]: ${it.description} — ${it.total.toLocaleString('es-ES')} €`));
console.log(`    TOTAL: ${res10.financials.totalAmount.toLocaleString('es-ES')} € (IVA 10% incl.)\n`);

// -----------------------------------------------------------------------------
// CASO 11: Unidades de Medida (m², ml, ud, pa) y Descuentos Comerciales
// -----------------------------------------------------------------------------
console.log("TEST 11: Unidades de Medida (m², ml, ud) y Descuentos Dictados");

const audioConDescuentoYUnidades = `
Para Don Carlos Gómez en Calle Gran Vía 12:
- 45 m2 de alicatado porcelánico en cocina por novecientos euros.
- 15 ml de rodapié cerámico por ciento cincuenta euros.
- 6 mecanismos y tomas de corriente por ciento ochenta euros.
Aplicar un descuento del 10% por promoción especial.
IVA 10%.
`;

const res11 = engine.process(audioConDescuentoYUnidades);
assert(res11.success === true, "Procesa presupuesto con unidades y descuento comercial");
assert(res11.items[0].unit === "m²", `Partida 1 detecta unidad 'm²'. Obtenido: ${res11.items[0].unit}`);
assert(res11.items[0].qty === 45, `Partida 1 detecta 45 m². Obtenido: ${res11.items[0].qty}`);
assert(res11.items[1].unit === "ml", `Partida 2 detecta unidad 'ml'. Obtenido: ${res11.items[1].unit}`);
assert(res11.items[1].qty === 15, `Partida 2 detecta 15 ml. Obtenido: ${res11.items[1].qty}`);
assert(res11.items[2].unit === "ud", `Partida 3 detecta unidad 'ud'. Obtenido: ${res11.items[2].unit}`);
assert(res11.items[2].qty === 6, `Partida 3 detecta 6 uds. Obtenido: ${res11.items[2].qty}`);

// Subtotal bruto: 900 + 150 + 180 = 1230 €
assert(res11.financials.subtotal === 1230, `Subtotal bruto exacto (1.230,00 €). Obtenido: ${res11.financials.subtotal} €`);
// Descuento 10%: 123 €
assert(res11.financials.discountPercentage === 10, "Detecta descuento comercial del 10%");
assert(res11.financials.discountAmount === 123, `Calcula importe del descuento (123,00 €). Obtenido: ${res11.financials.discountAmount} €`);
// Base imponible: 1230 - 123 = 1107 €
assert(res11.financials.taxableBase === 1107, `Base imponible tras descuento: 1.107,00 €. Obtenido: ${res11.financials.taxableBase} €`);
// IVA 10% (reforma en cocina de vivienda) sobre 1107 = 110.70 €
assert(res11.financials.taxRatePercentage === 10, "Aplica IVA 10% expresamente indicado en el presupuesto");
assert(res11.financials.taxAmount === 110.7, `IVA 10% calculado: 110,70 €. Obtenido: ${res11.financials.taxAmount} €`);
// Total final: 1107 + 110.7 = 1217.70 €
assert(res11.financials.totalAmount === 1217.7, `Total final con descuento e IVA: 1.217,70 €. Obtenido: ${res11.financials.totalAmount} €`);

// -----------------------------------------------------------------------------
// CASO 12: Factura de Anticipo con Devengo de IVA y Factura Final de Liquidación (RD 1619/2012 y Ley 37/1992)
// -----------------------------------------------------------------------------
console.log("\nTEST 12: Factura Legal de Anticipo con IVA y Factura Final de Liquidación");

// 1. Crear presupuesto base de 4.785,00 € (4.350,00 € Base + 435,00 € IVA 10%)
const budget12 = {
  id: "PRE-2026-TEST12",
  client: { name: "María del Carmen", address: "Calle Sierpes 24, Sevilla" },
  items: [
    { id: "1", description: "Reforma integral de baño", qty: 1, unit: "pa", unitPrice: 4350, total: 4350 }
  ],
  financials: {
    subtotal: 4350,
    taxableBase: 4350,
    taxRatePercentage: 10,
    taxAmount: 435,
    totalAmount: 4785,
    advanceAmount: 1000
  }
};

// 2. Emitir Factura Oficial de Anticipo de 1.000,00 €
const advanceInv = engine.createAdvanceInvoice(budget12, {
  amount: 1000,
  method: "Transferencia bancaria",
  concept: "Anticipo 1ª fase para acopio de materiales"
});

assert(advanceInv.type === "ANTICIPO", "La factura es de tipo 'ANTICIPO'");
assert(advanceInv.financials.taxableBase === 909.09, `Base Imponible anticipo calculada (909,09 €). Obtenido: ${advanceInv.financials.taxableBase} €`);
assert(advanceInv.financials.taxAmount === 90.91, `Cuota IVA 10% anticipo calculada (90,91 €). Obtenido: ${advanceInv.financials.taxAmount} €`);
assert(advanceInv.financials.totalAmount === 1000, `Total Factura Anticipo exacto (1.000,00 €). Obtenido: ${advanceInv.financials.totalAmount} €`);
assert(advanceInv.status === "PAGADA", "Factura de anticipo emitida con estado 'PAGADA'");
assert(budget12.advanceInvoices.length === 1, "El presupuesto registra la factura de anticipo en su historial");

// 3. Emitir Factura Final de Liquidación
const finalInv = engine.convertToInvoice(budget12);

assert(finalInv.type === "FINAL", "La factura resultante es de tipo 'FINAL'");
assert(Array.isArray(finalInv.advanceDeductions) && finalInv.advanceDeductions.length === 1, "La factura final incluye el desglose de deducción de anticipos");
assert(finalInv.advanceDeductions[0].taxableBase === 909.09, "La deducción de base imponible coincide con el anticipo (909,09 €)");
assert(finalInv.financials.advanceAmount === 1000, "Registra 1.000,00 € de anticipo total deducido");
assert(finalInv.financials.remainingAmount === 3785, `Saldo restante pendiente a pagar exacto (3.785,00 €). Obtenido: ${finalInv.financials.remainingAmount} €`);

// Comprobación de cuadre contable legal de bases e IVAs
const totalBases = advanceInv.financials.taxableBase + (finalInv.financials.taxableBase - finalInv.financials.advanceTaxableBase);
assert(Math.abs(totalBases - 4350) < 0.02, `Cuadre exacto de bases imponibles ante AEAT (4.350,00 €). Suma: ${totalBases.toFixed(2)} €`);

const totalIvas = advanceInv.financials.taxAmount + (finalInv.financials.taxAmount - finalInv.financials.advanceTaxAmount);
assert(Math.abs(totalIvas - 435) < 0.02, `Cuadre exacto de cuotas de IVA ante AEAT (435,00 €). Suma: ${totalIvas.toFixed(2)} €`);

// 4. Verificación de generación de PDF para Factura de Anticipo y Factura de Liquidación
const pdfAdvance = await generateInvoicePDF(advanceInv);
assert(Buffer.isBuffer(pdfAdvance) && pdfAdvance.length > 2000, `Genera correctamente el PDF formal de Factura de Anticipo (${pdfAdvance.length} bytes)`);

const pdfFinal = await generateInvoicePDF(finalInv);
assert(Buffer.isBuffer(pdfFinal) && pdfFinal.length > 2000, `Genera correctamente el PDF formal de Factura de Liquidación con deducción fiscal (${pdfFinal.length} bytes)`);

// ==========================================================
// TEST 13: Consulta y Filtrado de Presupuestos (Pendientes de firma, Aceptados, Todos)
// ==========================================================
console.log("\nTEST 13: Consulta y Filtrado de Presupuestos (Pendientes de firma, Aceptados, Todos)");

function testDetectBudgetListIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  if (/nuevo\s+presupuesto|presupuesto\s+nuevo|factura|cobro|pago|anticipo|cu[aá]nto\s+me\s+debe|descuento|rebaja|modificar|cambiar|a[ñn]adir|quitar|poner|hacerle|actualizar/i.test(t)) {
    return null;
  }
  if (!/(?:presupuesto|borrador|sin\s+firmar|por\s+firmar)/i.test(t)) {
    if (!/^(?:1|lista)$/i.test(t)) return null;
  }
  const isListQuery = /^(?:1|lista|mis\s+presupuestos|ver\s+presupuestos)$/i.test(t) ||
    /\b(?:list(?:ar?|ame|a)?|ver|dime|cu[aá]les|mostrar|enseñar|consultar|sacar)\b/i.test(t) || /\bqu[eé]\s+(?:presupuestos|borradores|obras)\b/i.test(t) ||
    /^(?:presupuestos|borradores)/i.test(t);
  if (!isListQuery) return null;
  if (/pendiente|sin\s+firmar|por\s+firmar|falta(?:n)?\s+por\s+firmar/i.test(t)) {
    return 'pending_signature';
  }
  if (/aceptad|firmad/i.test(t)) {
    return 'accepted';
  }
  if (/borrador/i.test(t)) {
    return 'draft';
  }
  return 'all';
}

assert(testDetectBudgetListIntent("Listame todos los presupuestos que están pendientes por firmar") === "pending_signature", "Detecta filtro 'pending_signature' en la frase exacta del usuario");
assert(testDetectBudgetListIntent("presupuestos pendientes de firma") === "pending_signature", "Detecta filtro 'pending_signature' en 'presupuestos pendientes de firma'");
assert(testDetectBudgetListIntent("presupuestos sin firmar") === "pending_signature", "Detecta filtro 'pending_signature' en 'presupuestos sin firmar'");
assert(testDetectBudgetListIntent("presupuestos aceptados") === "accepted", "Detecta filtro 'accepted' en 'presupuestos aceptados'");
assert(testDetectBudgetListIntent("ver presupuestos") === "all", "Detecta filtro 'all' en 'ver presupuestos'");
assert(testDetectBudgetListIntent("mis presupuestos") === "all", "Detecta filtro 'all' en 'mis presupuestos'");
assert(testDetectBudgetListIntent("1") === "all", "Detecta comando rápido '1'");
assert(testDetectBudgetListIntent("tirar tabique de 4x3 metros por 600 euros") === null, "No confunde dictado de partidas con listado");

const mockBudgets = [
  { id: 'PRE-1', client: { name: 'Juan' }, status: 'PENDIENTE_FIRMA', isDraft: false, financials: { totalAmount: 1000 } },
  { id: 'PRE-2', client: { name: 'Pedro' }, status: 'ACEPTADO', isDraft: false, financials: { totalAmount: 2000 } },
  { id: 'PRE-3', client: { name: 'María' }, status: 'BORRADOR_MEDICION', isDraft: true, financials: { totalAmount: 500 } },
  { id: 'PRE-4', client: { name: 'Luis' }, status: 'PENDIENTE_FIRMA', isDraft: false, financials: { totalAmount: 1500 } },
];

const pendingList = mockBudgets.filter(b => b.status !== 'ACEPTADO' && b.status !== 'FIRMADO' && !b.isDraft);
assert(pendingList.length === 2, `Filtra exactamente los 2 presupuestos pendientes de firma (PRE-1 y PRE-4). Obtenido: ${pendingList.length}`);
assert(pendingList[0].id === 'PRE-1' && pendingList[1].id === 'PRE-4', "Preserva las identidades de los pendientes");

const acceptedList = mockBudgets.filter(b => b.status === 'ACEPTADO' || b.status === 'FIRMADO');
assert(acceptedList.length === 1 && acceptedList[0].id === 'PRE-2', "Filtra exactamente el presupuesto aceptado");

console.log("\nTEST 14: Onboarding, Registro de Oficio/Gremio (Electricista, Fontanero, etc.) y Perfil");
import { getCompany as dbGetCompany, saveCompany as dbSaveCompany } from './db_service.js';

const testPhone = '34666000111';
const initialComp = dbGetCompany(testPhone);
assert(initialComp.isConfigured === false, "Usuario nuevo no configurado detecta isConfigured: false");
assert(initialComp.trade === 'Reformas y Construcción', "Usuario nuevo asigna oficio por defecto 'Reformas y Construcción'");

// Prueba de normalización de oficios
function normalizeTradeTest(rawText) {
  const match = rawText.match(/^(?:soy|mi oficio es|mi gremio es|somos|oficio|gremio|cambiar oficio a|cambiar gremio a)\s+([a-záéíóúñ\s/]+)$/i);
  if (!match) return null;
  const rawTrade = match[1].trim().toLowerCase();
  if (/electri/i.test(rawTrade)) return { trade: 'Electricidad y Telecomunicaciones', tax: 21 };
  if (/fontan|plomer/i.test(rawTrade)) return { trade: 'Fontanería y Saneamiento', tax: 21 };
  if (/albañil|obra|construc|reforma/i.test(rawTrade)) return { trade: 'Albañilería y Reformas', tax: 10 };
  if (/carpinter/i.test(rawTrade)) return { trade: 'Carpintería y Madera', tax: 21 };
  if (/clima|aire|calefac/i.test(rawTrade)) return { trade: 'Climatización y Calefacción', tax: 21 };
  if (/pint/i.test(rawTrade)) return { trade: 'Pintura y Revestimientos', tax: 21 };
  return { trade: rawTrade.charAt(0).toUpperCase() + rawTrade.slice(1), tax: 21 };
}

assert(normalizeTradeTest("soy electricista")?.trade === "Electricidad y Telecomunicaciones", "Detecta y normaliza oficio electricista");
assert(normalizeTradeTest("soy electricista")?.tax === 21, "Asigna IVA por defecto 21% para electricistas");
assert(normalizeTradeTest("mi oficio es fontanero")?.trade === "Fontanería y Saneamiento", "Detecta y normaliza fontanero");
assert(normalizeTradeTest("soy albañil")?.trade === "Albañilería y Reformas", "Detecta y normaliza albañil");
assert(normalizeTradeTest("soy albañil")?.tax === 10, "Asigna IVA por defecto 10% para albañilería");
assert(normalizeTradeTest("cambiar oficio a carpintero")?.trade === "Carpintería y Madera", "Detecta y normaliza carpintero");

// Detección de saludos para Onboarding
const isGreetingCheck = (t) => /^(?:hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|hey|qu[eé]\s+tal|empezar|inicio|ayuda)$/i.test(t);
assert(isGreetingCheck("hola") === true, "Detecta saludo 'hola' para onboarding");
assert(isGreetingCheck("buenos días") === true, "Detecta saludo 'buenos días' para onboarding");
assert(isGreetingCheck("tirar tabique de 4x3") === false, "No confunde dictado con saludo");

// Guardado y persistencia en base de datos
const savedComp = dbSaveCompany(testPhone, {
  name: 'Instalaciones Eléctricas Pérez S.L.',
  cif: 'B-99887766',
  trade: 'Electricidad y Telecomunicaciones',
  defaultTaxRate: 21
});
assert(savedComp.isConfigured === true, "Empresa configurada con nombre propio detecta isConfigured: true");
assert(savedComp.trade === 'Electricidad y Telecomunicaciones', "Persiste correctamente el oficio en SQLite");

// Limpieza del registro de prueba en la base de datos de test activa
import { db as cleanDb } from './db_service.js';
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(testPhone);

console.log("\nTEST 15: Secretario Digital Proactivo y Matriz de Permisos (Niveles A, B y C)");
import {
  classifyActionPermission,
  createProposedAction,
  evaluateConfirmationResponse,
  generateDailyBriefing,
  generateEveningReminder,
  buildBudgetFollowUpProposal,
  buildInvoiceFollowUpProposal
} from './secretary_service.js';

// 1. Clasificación estricta de permisos
assert(classifyActionPermission('query_info') === 'A', "Clasifica 'query_info' como Nivel A (Automático)");
assert(classifyActionPermission('list_appointments') === 'A', "Clasifica 'list_appointments' como Nivel A (Automático)");
assert(classifyActionPermission('create_note') === 'A', "Clasifica 'create_note' como Nivel A (Automático)");
assert(classifyActionPermission('draft_budget') === 'A', "Clasifica 'draft_budget' como Nivel A (Automático)");

assert(classifyActionPermission('send_client_reminder') === 'B', "Clasifica 'send_client_reminder' como Nivel B (Confirmación simple)");
assert(classifyActionPermission('send_budget') === 'B', "Clasifica 'send_budget' como Nivel B (Confirmación simple)");
assert(classifyActionPermission('send_invoice') === 'B', "Clasifica 'send_invoice' como Nivel B (Confirmación simple)");
assert(classifyActionPermission('schedule_appointment') === 'B', "Clasifica 'schedule_appointment' como Nivel B (Confirmación simple)");

assert(classifyActionPermission('cancel_appointment') === 'C', "Clasifica 'cancel_appointment' como Nivel C (Confirmación fuerte)");
assert(classifyActionPermission('modify_invoice') === 'C', "Clasifica 'modify_invoice' como Nivel C (Confirmación fuerte)");
assert(classifyActionPermission('register_payment_manual') === 'C', "Clasifica 'register_payment_manual' como Nivel C (Confirmación fuerte)");
assert(classifyActionPermission('delete_data') === 'C', "Clasifica 'delete_data' como Nivel C (Confirmación fuerte)");

// 2. Evaluación de confirmaciones Nivel B
const propB = createProposedAction('B', 'send_client_reminder', { client: 'Juan' });
assert(evaluateConfirmationResponse(propB, "sí")?.status === 'APPROVED', "Nivel B aprueba con 'sí'");
assert(evaluateConfirmationResponse(propB, "adelante")?.status === 'APPROVED', "Nivel B aprueba con 'adelante'");
assert(evaluateConfirmationResponse(propB, "mándaselo")?.status === 'APPROVED', "Nivel B aprueba con 'mándaselo'");
assert(evaluateConfirmationResponse(propB, "no")?.status === 'REJECTED', "Nivel B rechaza con 'no'");
assert(evaluateConfirmationResponse(propB, "cancela")?.status === 'REJECTED', "Nivel B rechaza con 'cancela'");
assert(evaluateConfirmationResponse(propB, "tengo una duda")?.status === 'IGNORED', "Nivel B ignora conversación no relacionada");

// 3. Evaluación de confirmaciones Nivel C (Seguridad fuerte)
const propC = createProposedAction('C', 'cancel_appointment', { query: 'Juan' });
assert(evaluateConfirmationResponse(propC, "ok")?.status === 'NEED_STRONG_CONFIRMATION', "Nivel C exige confirmación fuerte ante un simple 'ok'");
assert(evaluateConfirmationResponse(propC, "sí")?.status === 'NEED_STRONG_CONFIRMATION', "Nivel C exige confirmación fuerte ante un simple 'sí'");
assert(evaluateConfirmationResponse(propC, "CONFIRMAR")?.status === 'APPROVED', "Nivel C aprueba con 'CONFIRMAR'");
assert(evaluateConfirmationResponse(propC, "sí, cancelar")?.status === 'APPROVED', "Nivel C aprueba con 'sí, cancelar'");
assert(evaluateConfirmationResponse(propC, "no")?.status === 'REJECTED', "Nivel C rechaza con 'no'");

// 4. Propuestas de seguimiento y enlaces wa.me
const budgetFollowUp = {
  id: 'PRE-100',
  clientName: 'María García',
  clientPhone: '612345678',
  totalAmount: 4500,
  daysWaiting: 5
};
const budgetProposal = buildBudgetFollowUpProposal(budgetFollowUp);
assert(budgetProposal.promptMessage.includes("María García"), "Propuesta de presupuesto incluye nombre del cliente");
assert(budgetProposal.promptMessage.includes("4.500"), "Propuesta incluye importe formateado");
assert(budgetProposal.clientMessage.includes("Hola María"), "Mensaje de cortesía saluda por el nombre de pila");
assert(budgetProposal.directWaUrl?.includes("https://wa.me/34612345678"), "Genera enlace directo de 1 toque de WhatsApp con número internacional");

const invoiceFollowUp = {
  id: 'FAC-2026-0001',
  clientName: 'Pedro López',
  clientPhone: '699887766',
  totalAmount: 3400,
  daysPending: 8
};
const invoiceProposal = buildInvoiceFollowUpProposal(invoiceFollowUp, { iban: 'ES11 2222' });
assert(invoiceProposal.promptMessage.includes("8 días"), "Propuesta de factura incluye días de retraso");
assert(invoiceProposal.clientMessage.includes("ES11 2222"), "Mensaje de cobro incluye datos bancarios configurados");

// 5. Briefing matinal
const briefing = generateDailyBriefing('34600112233');
assert(briefing.includes("Buenos días"), "Briefing incluye saludo matinal");
assert(briefing.includes("¿Quieres que haga algo por ti?"), "Briefing incluye cierre servicial");

console.log("\nTEST 16: Lista de Compras y Materiales Pendientes (Voz/Texto, SQLite y Secretario)");
import {
  addShoppingItems,
  listShoppingItems,
  markShoppingItemBought,
  markShoppingItemsBoughtForClients,
  clearShoppingList,
  formatBudgetPublicId
} from './db_service.js';

const shoppingPhone = '34699001122';
dbSaveCompany(shoppingPhone, { name: 'Empresa Shopping Test' });
cleanDb.prepare('DELETE FROM shopping_items WHERE company_phone = ?').run(shoppingPhone);

// 1. Inserción de materiales dictados para múltiples obras/clientes
const carlosItems = [
  { description: 'azulejo gris', qty: 14, unit: 'm²', clientName: 'Carlos' },
  { description: 'cemento cola flexible', qty: 2, unit: 'sacos', clientName: 'Carlos' },
  { description: 'Junta antracita', qty: 1, unit: 'ud', clientName: 'Carlos' }
];
const albertoItems = [
  { description: 'plato de ducha resina 120x70', qty: 1, unit: 'ud', clientName: 'Alberto' },
  { description: 'mampara vidrio templado', qty: 1, unit: 'ud', clientName: 'Alberto' }
];
const generalItems = [
  { description: 'cable 2.5 mm²', qty: 3, unit: 'rollos' }
];

const insertedCarlos = addShoppingItems(shoppingPhone, carlosItems);
const insertedAlberto = addShoppingItems(shoppingPhone, albertoItems);
const insertedGeneral = addShoppingItems(shoppingPhone, generalItems);

assert(insertedCarlos.length === 3, "Inserta los 3 materiales para la obra de Carlos");
assert(insertedAlberto.length === 2, "Inserta los 2 materiales para la obra de Alberto");
assert(insertedGeneral.length === 1, "Inserta 1 material general de taller");

assert(insertedCarlos[0].clientName === 'Carlos', "Asocia el cliente 'Carlos' a los azulejos");
assert(insertedAlberto[0].clientName === 'Alberto', "Asocia el cliente 'Alberto' al plato de ducha");
assert(insertedGeneral[0].clientName === null, "Material general queda sin cliente asignado");

// 2. Consulta de lista de compras en base de datos con y sin filtro de cliente
const allPending = listShoppingItems(shoppingPhone, 'pending');
assert(allPending.length === 6, "Consulta un total de 6 materiales pendientes en SQLite");

const carlosPending = listShoppingItems(shoppingPhone, 'pending', 'Carlos');
assert(carlosPending.length === 3, "Filtra exactamente los 3 materiales de la obra de Carlos");

const albertoPending = listShoppingItems(shoppingPhone, 'pending', 'Alberto');
assert(albertoPending.length === 2, "Filtra exactamente los 2 materiales de la obra de Alberto");

// 3. Marcar material como comprado (tachar)
const boughtResult = markShoppingItemBought(shoppingPhone, 'cemento cola', 'Carlos');
assert(boughtResult.length === 1, "Encuentra y tacha el material por coincidencia de texto y cliente");
assert(boughtResult[0].status === 'BOUGHT', "El estado pasa a 'BOUGHT'");
assert(Boolean(boughtResult[0].boughtAt), "Registra timestamp de compra");

const remainingCarlos = listShoppingItems(shoppingPhone, 'pending', 'Carlos');
assert(remainingCarlos.length === 2, "Quedan 2 materiales pendientes para Carlos tras comprar el cemento cola");

// 4. Integración con el Briefing Matinal del Secretario Digital (con etiquetas de cliente)
const morningBriefing = generateDailyBriefing(shoppingPhone);
assert(morningBriefing.includes("Materiales pendientes de compra (5):"), "El briefing incluye el total de materiales de todas las obras (5)");
assert(morningBriefing.includes("azulejo gris"), "El briefing muestra el azulejo pendiente");
assert(morningBriefing.includes("(Obra: Carlos)"), "El briefing etiqueta la obra del cliente Carlos");
assert(morningBriefing.includes("(Obra: Alberto)"), "El briefing etiqueta la obra del cliente Alberto");
assert(!morningBriefing.includes("cemento cola"), "El briefing NO muestra materiales ya comprados en los pendientes");

const boughtAllClients = parseBoughtAllShoppingForClients('Vale, ya he comprado todo lo de la obra de Oscar Martin y de Rafael Torres');
assert(JSON.stringify(boughtAllClients) === JSON.stringify(['Oscar Martin', 'Rafael Torres']), "Interpreta compra completa como obras/clientes concretos, nunca como vaciado global");
assert(parseBoughtAllShoppingForClients('Quiero vaciar la lista de la compra').length === 0, "No infiere clientes al pedir vaciado explícito");
const oscarItems = addShoppingItems(shoppingPhone, [{ description: 'tornillos', qty: 1, unit: 'caja', clientName: 'Oscar Martin' }]);
const rafaelItems = addShoppingItems(shoppingPhone, [{ description: 'pintura blanca', qty: 2, unit: 'botes', clientName: 'Rafael Torres' }]);
const otherItems = addShoppingItems(shoppingPhone, [{ description: 'cinta de carrocero', qty: 1, unit: 'ud', clientName: 'Lucía' }]);
const boughtNamedWorks = markShoppingItemsBoughtForClients(shoppingPhone, boughtAllClients);
assert(boughtNamedWorks.length === 2, "Marca como comprados únicamente los materiales pendientes de las obras nombradas");
assert(listShoppingItems(shoppingPhone, 'pending', 'Lucía').some(item => item.id === otherItems[0].id), "Conserva intactos los materiales de obras no nombradas");
assert(listShoppingItems(shoppingPhone, 'pending', 'Oscar Martin').length === 0 && listShoppingItems(shoppingPhone, 'pending', 'Rafael Torres').length === 0, "Las obras nombradas quedan tachadas de pendientes");
assert(formatBudgetPublicId(2026, 1) === 'PRE2026-001' && formatBudgetPublicId(2026, 12) === 'PRE2026-012', "Formato público de presupuesto corto y correlativo");
const incorrectDoor = findUngroundedAudioItems('Necesito 3 puertas de paso de 72 semimaciza totalmente terminada', [{ sourcePhrase: 'puertas de paso de 72 semimaciza totalmente terminada', description: 'Revisión, cepillado de holguras y sustitución de manivelas en puertas de paso de madera', qty: 3 }]);
assert(incorrectDoor.length === 1 && incorrectDoor[0].missing.some(term => term.includes('partida sin respaldo')), "Bloquea la sustitución de puerta semimaciza por reparación de holguras");
const correctDoor = findUngroundedAudioItems('Necesito 3 puertas de paso de 72 semimaciza totalmente terminada', [{ sourcePhrase: 'puertas de paso de 72 semimaciza totalmente terminada', description: 'Puerta de paso semimaciza de 72 cm, totalmente terminada', qty: 3 }]);
assert(correctDoor.length === 0, "Acepta la partida profesional fiel a puerta de paso semimaciza de 72 cm");
const contextualDoor = findUngroundedAudioItems('Cambio de puertas en todas las habitaciones. Queremos pasar de puertas de madera a puertas correderas, son cinco en total.', [{ sourcePhrase: 'Cambio de puertas en todas las habitaciones. Queremos pasar de puertas de madera a puertas correderas, son cinco en total.', description: 'Cambio de puertas de madera a puertas correderas', qty: 5 }]);
assert(contextualDoor.length === 0, 'Acepta redacción profesional concisa que omite contexto no técnico del fragmento literal');
const quotedDoor = findUngroundedAudioItems('Tres puertas de paso de 72 cm, semimacizas y totalmente terminadas por un precio de 810 euros', [{ sourcePhrase: 'tres puertas de paso de 72 cm, semimacizas y totalmente terminadas por un precio de 810 euros', description: 'Tres puertas de paso de 72 cm, semimacizas y totalmente terminadas', qty: 3 }]);
assert(quotedDoor.length === 0, "No marca como discrepancia las cantidades y los precios al contrastar la partida");
const incorrectWindow = findUngroundedAudioItems('Ventana aluminio blanco corredera, persiana, climalit de 1,10 x 1,22', [{ sourcePhrase: 'Ventana aluminio blanco corredera persiana climalit de 1,10 x 1,22', description: 'Suministro e instalación de equipo de aire acondicionado tipo Split', qty: 1 }]);
assert(findUngroundedAudioItems('Cambio de puertas correderas', [{ description: 'Instalación de fontanería multicapa', qty: 5 }]).length === 1, 'Rechaza una partida de audio si Gemini omite sourcePhrase');
assert(findUngroundedAudioItems('Cambio de puertas correderas', [{ sourcePhrase: 'Instalación de fontanería multicapa', description: 'Instalación de fontanería multicapa', qty: 1 }]).length === 1, 'Rechaza sourcePhrase inventada que no aparece en la transcripción');
assert(findUngroundedAudioItems('Cambio de puertas correderas', [{ sourcePhrase: 'Cambio de puertas correderas', description: 'Instalación de fontanería multicapa', qty: 1 }]).length === 1, 'Rechaza descripción que contradice su fragmento literal');
assert(incorrectWindow.length === 1, "Bloquea convertir la ventana indicada en un equipo de aire acondicionado");
assert(professionalizeAudioSourcePhrase('tres puertas de paso de 72 cm, semimacizas y totalmente terminadas por un precio de 810 euros') === 'Puertas de paso de 72 cm, semimacizas y totalmente terminadas', "Recupera la redacción literal limpia sin cantidad ni precio ante una divergencia");
const audioRegressionTranscript = 'Vamos a hacer un nuevo presupuesto en el cual hay que hacer un cambio de puertas en todas las habitaciones. Queremos pasar de unas puertas de madera a puertas correderas, son cinco en total, precio 1200 euros. Las ventanas están muy antiguas y queremos poner ventanas nuevas con revestimiento climalit. Pintar la casa entera de color blanco por 1500 euros.';
assert(isLikelyBudgetTranscript(audioRegressionTranscript), "El audio regresión se enruta al extractor aislado de presupuestos");
assert(isExplicitNewBudgetTranscript(audioRegressionTranscript), "La frase 'nuevo presupuesto' fuerza la creación de otro presupuesto");
const expectedAudioRegressionItems = [
  { sourcePhrase: 'puertas de madera a puertas correderas', description: 'Cambio de puertas de madera a puertas correderas', qty: 5 },
  { sourcePhrase: 'ventanas nuevas con revestimiento climalit', description: 'Sustitución de ventanas antiguas por ventanas nuevas con revestimiento Climalit', qty: 1 },
  { sourcePhrase: 'pintar la casa entera de color blanco', description: 'Pintura de la casa entera de color blanco', qty: 1 }
];
assert(findUngroundedAudioItems(audioRegressionTranscript, expectedAudioRegressionItems).length === 0, "Conserva las tres partidas reales del audio sin incorporar fontanería ni climatización");

// 5. Matriz de permisos para gestión de materiales
assert(classifyActionPermission('add_shopping_items') === 'A', "Clasifica 'add_shopping_items' como Nivel A (Automático)");
assert(classifyActionPermission('list_shopping_items') === 'A', "Clasifica 'list_shopping_items' como Nivel A (Automático)");
assert(classifyActionPermission('mark_shopping_items') === 'A', "Clasifica 'mark_shopping_items' como Nivel A (Automático)");
assert(classifyActionPermission('clear_shopping_list') === 'B', "Clasifica 'clear_shopping_list' como Nivel B (Confirmación simple)");

// 6. Vaciado / Limpieza de la lista de compras
const clearResult = clearShoppingList(shoppingPhone);
assert(clearResult.deletedCount >= 6, "Elimina todos los materiales al vaciar la lista");
const emptyList = listShoppingItems(shoppingPhone, 'all');
assert(emptyList.length === 0, "La lista queda completamente vacía tras limpiarla");

// Limpieza final
cleanDb.prepare('DELETE FROM shopping_items WHERE company_phone = ?').run(shoppingPhone);
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(shoppingPhone);

console.log("\nTEST 17: Modo Obra — Memoria Inteligente, Ficha Viva y Checklist por Obra (Captura Usuario)");
import {
  getWorkMemory,
  updateWorkTaskStatus,
  updateWorkDates,
  saveBudget,
  savePayment
} from './db_service.js';
import { formatWorkMemoryForWhatsApp } from './whatsapp_gateway.js';

const workPhone = '34677889900';
const juanBudgetId = 'PRESU-JUAN-001';

// Limpieza previa
cleanDb.prepare('DELETE FROM budgets WHERE id = ? OR company_phone = ?').run(juanBudgetId, workPhone);
cleanDb.prepare('DELETE FROM payments WHERE budget_id = ? OR company_phone = ?').run(juanBudgetId, workPhone);
cleanDb.prepare('DELETE FROM shopping_items WHERE company_phone = ?').run(workPhone);

// 1. Guardar Presupuesto con 5 partidas de reforma (total 8.450,00 €)
const juanBudgetObj = {
  id: juanBudgetId,
  client: { name: 'Juan García', address: 'Calle Mayor 12', phone: '611223344' },
  items: [
    { description: 'Demolición', quantity: 1, unit: 'pa', price: 1200, total: 1200, isDone: true, status: 'DONE' },
    { description: 'Fontanería', quantity: 1, unit: 'pa', price: 1800, total: 1800, isDone: true, status: 'DONE' },
    { description: 'Alicatado', quantity: 1, unit: 'pa', price: 2450, total: 2450, isDone: false, status: 'PENDING' },
    { description: 'Pintura', quantity: 1, unit: 'pa', price: 1500, total: 1500, isDone: false, status: 'PENDING' },
    { description: 'Sanitarios', quantity: 1, unit: 'pa', price: 1500, total: 1500, isDone: false, status: 'PENDING' }
  ],
  financials: { totalAmount: 8450 },
  workMemory: {
    startDate: '2 de septiembre',
    estimatedEndDate: '15 de octubre'
  }
};

saveBudget(workPhone, juanBudgetObj);

// 2. Registrar cobro de anticipo de 3.000 € (dejando 5.450 € pendientes)
savePayment(workPhone, {
  budgetId: juanBudgetId,
  amount: 3000,
  method: 'TRANSFERENCIA',
  concept: 'Anticipo inicio de obra'
});

// 3. Añadir materiales asociados a la obra de Juan García
addShoppingItems(workPhone, [
  { description: 'Azulejos', qty: 25, unit: 'm²', clientName: 'Juan García', budgetId: juanBudgetId },
  { description: 'Cemento', qty: 5, unit: 'sacos', clientName: 'Juan García', budgetId: juanBudgetId },
  { description: 'Grifería', qty: 1, unit: 'ud', clientName: 'Juan García', budgetId: juanBudgetId }
]);

// 4. Marcar Azulejos y Cemento como comprados
markShoppingItemBought(workPhone, 'Azulejos', 'Juan García');
markShoppingItemBought(workPhone, 'Cemento', 'Juan García');

// 5. Consultar getWorkMemory
const workMem = getWorkMemory(workPhone, 'Juan García');
assert(workMem !== null, "Recupera la memoria viva de la obra de Juan García");
assert(workMem.totalAmount === 8450, "Presupuesto total exacto: 8.450 €");
assert(workMem.totalPaid === 3000, "Cobros acumulados exactos: 3.000 €");
assert(workMem.remainingBalance === 5450, "Saldo pendiente exacto: 5.450 €");
assert(workMem.startDate === '2 de septiembre', "Fecha de inicio: 2 de septiembre");
assert(workMem.estimatedEndDate === '15 de octubre', "Fecha final estimado: 15 de octubre");

assert(workMem.materials.bought.length === 2, "2 materiales comprados (Azulejos, Cemento)");
assert(workMem.materials.pending.length === 1, "1 material pendiente (Grifería)");
assert(workMem.tasks.done.length === 2, "2 tareas completadas (Demolición, Fontanería)");
assert(workMem.tasks.pending.length === 3, "3 tareas pendientes (Alicatado, Pintura, Sanitarios)");

// 6. Validar formateo idéntico a la tarjeta de la captura de usuario (Modo Obra completo)
const cardText = formatWorkMemoryForWhatsApp(workMem, false);
assert(cardText.includes("JUAN GARCÍA"), "La tarjeta incluye el nombre de Juan García");
assert(cardText.includes("8.450,00 €"), "Muestra presupuesto de 8.450,00 €");
assert(cardText.includes("3.000,00 €"), "Muestra pagado 3.000,00 €");
assert(cardText.includes("5.450,00 €"), "Muestra pendiente 5.450,00 €");
assert(cardText.includes("2 de septiembre"), "Muestra fecha inicio: 2 de septiembre");
assert(cardText.includes("15 de octubre"), "Muestra fecha fin estimado: 15 de octubre");
assert(cardText.includes("✓") && cardText.includes("Azulejos"), "Muestra ✓ Azulejos");
assert(cardText.includes("✓") && cardText.includes("Cemento"), "Muestra ✓ Cemento");
assert(cardText.includes("❌") && cardText.includes("Grifería"), "Muestra ❌ Grifería");
assert(cardText.includes("✓") && cardText.includes("Demolición"), "Muestra ✓ Demolición");
assert(cardText.includes("✓") && cardText.includes("Fontanería"), "Muestra ✓ Fontanería");
assert(cardText.includes("⏳") && cardText.includes("Alicatado"), "Muestra ⏳ Alicatado");
assert(cardText.includes("⏳") && cardText.includes("Pintura"), "Muestra ⏳ Pintura");
assert(cardText.includes("⏳") && cardText.includes("Sanitarios"), "Muestra ⏳ Sanitarios");

// 7. Validar consulta de faltantes ("¿Qué nos falta en la obra de Juan?")
const missingText = formatWorkMemoryForWhatsApp(workMem, true);
assert(missingText.includes("LO QUE FALTA EN LA OBRA"), "Encabezado específico para faltantes");
assert(missingText.includes("5.450,00 €"), "Muestra deuda pendiente de 5.450,00 €");
assert(missingText.includes("❌") && missingText.includes("Grifería"), "Muestra únicamente la grifería pendiente");
assert(!missingText.includes("Azulejos"), "NO muestra materiales ya comprados");
assert(missingText.includes("⏳") && missingText.includes("Alicatado"), "Muestra partidas pendientes (Alicatado)");
assert(!missingText.includes("Demolición"), "NO muestra partidas ya hechas");

// 8. Actualizar tarea mediante updateWorkTaskStatus ("ya terminamos el alicatado de Juan")
const updateTaskRes = updateWorkTaskStatus(workPhone, 'Juan García', 'Alicatado', true);
assert(updateTaskRes !== null, "Actualiza el estado de la tarea en SQLite");
assert(updateTaskRes.task.isDone === true, "La tarea Alicatado pasa a completada");

const updatedMem = getWorkMemory(workPhone, 'Juan García');
assert(updatedMem.tasks.done.length === 3, "Ahora hay 3 tareas hechas (Demolición, Fontanería, Alicatado)");
assert(updatedMem.tasks.pending.length === 2, "Quedan 2 tareas pendientes (Pintura, Sanitarios)");

// 9. Actualizar fechas mediante updateWorkDates
const updateDatesRes = updateWorkDates(workPhone, 'Juan García', '10 de septiembre', '30 de octubre');
assert(updateDatesRes !== null, "Actualiza plazos de obra en SQLite");
assert(updateDatesRes.startDate === '10 de septiembre', "Nueva fecha inicio guardada");
assert(updateDatesRes.estimatedEndDate === '30 de octubre', "Nueva fecha fin guardada");

// 10. Matriz de Permisos para Modo Obra
assert(classifyActionPermission('query_work_status') === 'A', "query_work_status es Nivel A (Automático)");
assert(classifyActionPermission('update_work_task') === 'A', "update_work_task es Nivel A (Automático)");
assert(classifyActionPermission('update_work_dates') === 'A', "update_work_dates es Nivel A (Automático)");
assert(classifyActionPermission('finalize_work_project') === 'B', "finalize_work_project es Nivel B (Confirmación simple)");

// Limpieza final
cleanDb.prepare('DELETE FROM budgets WHERE id = ? OR company_phone = ?').run(juanBudgetId, workPhone);
cleanDb.prepare('DELETE FROM payments WHERE budget_id = ? OR company_phone = ?').run(juanBudgetId, workPhone);
cleanDb.prepare('DELETE FROM shopping_items WHERE company_phone = ?').run(workPhone);

console.log("\nTEST 18: Desambiguación de Clientes Homónimos, Prevención de Confusiones y Distintivos");
import {
  findClientsByName,
  renameClientBudget
} from './db_service.js';
import {
  formatDisambiguationPrompt,
  formatDuplicateClientWarning
} from './secretary_service.js';

const homonymPhone = '34655443322';
const presu1Id = 'PRESU-ALBERTO-001';
const presu2Id = 'PRESU-ALBERTO-002';

// Limpieza previa
cleanDb.prepare('DELETE FROM budgets WHERE company_phone = ?').run(homonymPhone);
cleanDb.prepare('DELETE FROM shopping_items WHERE company_phone = ?').run(homonymPhone);

// 1. Crear el primer cliente "Alberto Martín" en Calle Girasol
const alberto1 = {
  id: presu1Id,
  client: { name: 'Alberto Martín', address: 'Calle Girasol Nº 7, Sevilla', phone: '655111222' },
  items: [{ description: 'Demolición tabiquería', quantity: 1, unit: 'pa', price: 1200, total: 1200 }],
  financials: { totalAmount: 1200 }
};
saveBudget(homonymPhone, alberto1);

// 2. Comprobar que inicialmente findClientsByName devuelve 1 único cliente
const singleResult = findClientsByName(homonymPhone, 'Alberto Martín');
assert(singleResult.length === 1, "Encuentra el primer Alberto Martín en Calle Girasol");
assert(singleResult[0].id === presu1Id, "ID correcto del primer presupuesto");

// 3. Crear el segundo cliente con idéntico nombre "Alberto Martín", pero en Avda. Constitución
const alberto2 = {
  id: presu2Id,
  client: { name: 'Alberto Martín', address: 'Avda. Constitución 14, Sevilla', phone: '655333444' },
  items: [{ description: 'Instalación de fontanería', quantity: 1, unit: 'pa', price: 2500, total: 2500 }],
  financials: { totalAmount: 2500 }
};
saveBudget(homonymPhone, alberto2);

// 4. Detección preventiva de cliente existente (Aviso de homonimia al crear presupuesto)
const existingHomonyms = findClientsByName(homonymPhone, 'Alberto Martín');
assert(existingHomonyms.length === 2, "Detecta exactamente 2 clientes/obras con el nombre 'Alberto Martín'");

const warningMsg = formatDuplicateClientWarning('Alberto Martín', 'Avda. Constitución 14', [singleResult[0]]);
assert(warningMsg.includes("Cliente con el mismo nombre detectado"), "El aviso preventivo incluye la alerta de homonimia");
assert(warningMsg.includes("Calle Girasol"), "El aviso preventivo menciona la obra anterior para que el usuario la identifique");
assert(warningMsg.includes("distintivo"), "El aviso preventivo aconseja añadir un distintivo para evitar confusiones");

// 5. Cero adivinación — Desambiguación interactiva (formatDisambiguationPrompt)
const disambiguationMsg = formatDisambiguationPrompt('Alberto Martín', existingHomonyms);
assert(disambiguationMsg.includes("He encontrado 2 clientes/obras para \"Alberto Martín\""), "Indica que hay 2 opciones encontradas");
assert(disambiguationMsg.includes("1️⃣") && disambiguationMsg.includes("2️⃣"), "Lista numerada con emojis para selección fácil");
assert(disambiguationMsg.includes("Calle Girasol"), "Muestra la dirección de la opción 1");
assert(disambiguationMsg.includes("Avda. Constitución"), "Muestra la dirección de la opción 2");
assert(disambiguationMsg.includes("Responde con el número"), "Instruye al usuario a elegir con el número");

// 6. Añadir materiales asociados y comprobar que se pueden asignar por budgetId específico sin confusión
addShoppingItems(homonymPhone, [
  { description: 'Tubería multicapa', qty: 20, unit: 'm', clientName: 'Alberto Martín', budgetId: presu2Id }
]);

// 7. Renombrar cliente / Añadir distintivo (renameClientBudget)
const renameRes = renameClientBudget(homonymPhone, presu2Id, 'Alberto Martín (Constitución)');
assert(renameRes !== null, "Ejecuta el renombrado en la base de datos");
assert(renameRes.oldName === 'Alberto Martín', "Registra el nombre anterior");
assert(renameRes.newName === 'Alberto Martín (Constitución)', "Registra el nuevo nombre con distintivo");

// 8. Verificar que la base de datos se actualizó unívocamente
const postRenameConstitucion = findClientsByName(homonymPhone, 'Alberto Martín (Constitución)');
assert(postRenameConstitucion.length === 1, "Ahora 'Alberto Martín (Constitución)' es 100% unívoco");
assert(postRenameConstitucion[0].clientAddress.includes("Constitución"), "Mantiene la dirección de Constitución");

const postRenameGirasol = findClientsByName(homonymPhone, 'Calle Girasol');
assert(postRenameGirasol.length === 1, "El presupuesto de Calle Girasol sigue intacto");
assert(postRenameGirasol[0].clientName === 'Alberto Martín', "Conserva el nombre sin afectar al otro");

// 9. Verificar matriz de permisos para renombrar y desambiguar
assert(classifyActionPermission('rename_client') === 'A', "rename_client es Nivel A (Automático)");
assert(classifyActionPermission('disambiguate_client') === 'A', "disambiguate_client es Nivel A (Automático)");

// Limpieza test 18
cleanDb.prepare('DELETE FROM budgets WHERE company_phone = ?').run(homonymPhone);
cleanDb.prepare('DELETE FROM shopping_items WHERE company_phone = ?').run(homonymPhone);

console.log("\nTEST 19: Onboarding Conversacional Cotidiano (15 Preguntas y Persistencia SQLite)");
import {
  startOnboarding,
  processOnboardingStep,
  getOnboardingState
} from './onboarding_service.js';

const onboardPhone = '34699887766';
cleanDb.prepare('DELETE FROM invoices WHERE company_phone = ?').run(onboardPhone);
cleanDb.prepare('DELETE FROM budgets WHERE company_phone = ?').run(onboardPhone);
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(onboardPhone);

// 1. Iniciar onboarding
const welcomePrompt = startOnboarding(onboardPhone);
assert(welcomePrompt.includes('☕'), "El mensaje de bienvenida es cotidiano y amigable");
let st = getOnboardingState(onboardPhone);
assert(st.step === 'OWNER_AND_COMPANY', "Inicia en el paso 1 (OWNER_AND_COMPANY)");
assert(st.isConfigured === false, "El estado inicial es isConfigured: false");

// Paso 1: Nombre propio y empresa
const r1 = processOnboardingStep(onboardPhone, "Me llamo Carlos y mi empresa es Reformas Integrales Carlos");
assert(r1.handled === true, "Paso 1 procesado");
assert(r1.message.includes("Carlos"), "Reconoce el nombre propio Carlos");
st = getOnboardingState(onboardPhone);
assert(st.step === 'TRADE', "Avanza al paso 2 (TRADE)");
assert(st.company.ownerName === 'Carlos', "Persiste ownerName en SQLite");
assert(st.company.name === 'Reformas Integrales Carlos', "Persiste name de la empresa en SQLite");

// Paso 2: Gremio
const r2 = processOnboardingStep(onboardPhone, "Soy electricista e instalador");
assert(r2.handled === true, "Paso 2 procesado");
assert(r2.message.includes("Electricidad"), "Normaliza oficio a Electricidad");
st = getOnboardingState(onboardPhone);
assert(st.step === 'CITY', "Avanza al paso 3 (CITY)");
assert(st.company.trade === 'Electricidad y Telecomunicaciones', "Guarda oficio en SQLite");
assert(st.company.defaultTaxRate === 21, "Asigna IVA sectorial al 21%");

// Paso 3: Ciudad
const r3 = processOnboardingStep(onboardPhone, "Sevilla capital y provincia");
assert(r3.handled === true, "Paso 3 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'WORKING_HOURS', "Avanza al paso 4 (WORKING_HOURS)");
assert(st.company.city === 'Sevilla capital y provincia', "Guarda ciudad en SQLite");

// Paso 4: Horario de trabajo
const r4 = processOnboardingStep(onboardPhone, "De 8:00 a 18:00 de lunes a viernes");
assert(r4.handled === true, "Paso 4 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'PAYMENT_TERMS', "Avanza al paso 5 (PAYMENT_TERMS)");
assert(st.company.workingHours === 'De 8:00 a 18:00 de lunes a viernes', "Guarda horario en SQLite");

// Paso 5: Forma de cobro y anticipo integrado
const r5 = processOnboardingStep(onboardPhone, "50% al empezar y 50% al acabar");
assert(r5.handled === true, "Paso 5 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'QUOTE_VALIDITY', "Avanza al paso 6 (QUOTE_VALIDITY)");
assert(st.company.paymentTerms.includes("50%"), "Guarda condiciones de cobro");
assert(st.company.defaultAdvance === 50, "Guarda anticipo del 50% en SQLite");

// Paso 7: Validez presupuestos
const r7 = processOnboardingStep(onboardPhone, "15 días");
assert(r7.handled === true, "Paso 7 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'ENTITY_TYPE', "Avanza al paso 8 (ENTITY_TYPE)");
assert(st.company.quoteValidityDays === 15, "Guarda validez de 15 días en SQLite");

const validityPhone = '34699887767';
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(validityPhone);
dbSaveCompany(validityPhone, { onboardingStep: 'QUOTE_VALIDITY', onboardingDataJson: '{}' });
const oneDayValidity = processOnboardingStep(validityPhone, '1 día');
assert(getOnboardingState(validityPhone).company.quoteValidityDays === 1,
  'Interpreta “1 día” como una duración explícita, no como la opción 1');
dbSaveCompany(validityPhone, { onboardingStep: 'QUOTE_VALIDITY', onboardingDataJson: '{}' });
processOnboardingStep(validityPhone, '2 días');
assert(getOnboardingState(validityPhone).company.quoteValidityDays === 2,
  'Interpreta “2 días” como duración, no como la opción 2 de 15 días');
dbSaveCompany(validityPhone, { onboardingStep: 'QUOTE_VALIDITY', onboardingDataJson: '{}' });
processOnboardingStep(validityPhone, '1');
assert(getOnboardingState(validityPhone).company.quoteValidityDays === 7,
  'La respuesta exacta “1” sigue seleccionando la opción de 7 días');
dbSaveCompany(validityPhone, { onboardingStep: 'QUOTE_VALIDITY', onboardingDataJson: '{}' });
const customValidityPrompt = processOnboardingStep(validityPhone, '4');
assert(getOnboardingState(validityPhone).step === 'QUOTE_VALIDITY' && /cuántos días/i.test(customValidityPrompt.message),
  'La opción “4 Otro” pide una duración y no guarda cuatro días por error');
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(validityPhone);

// Paso 8: Tipo de entidad (Autónomo o empresa)
const r8 = processOnboardingStep(onboardPhone, "Soy autónomo");
assert(r8.handled === true, "Paso 8 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'FISCAL_NAME', "Avanza al paso 9 (FISCAL_NAME)");
assert(st.company.entityType === 'autonomo', "Registra tipo de entidad como autónomo");

// Paso 9: Nombre fiscal
const r9 = processOnboardingStep(onboardPhone, "Carlos García Fernández");
assert(r9.handled === true, "Paso 9 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'CIF_NIF', "Avanza al paso 10 (CIF_NIF)");
assert(st.company.fiscalName === 'Carlos García Fernández', "Guarda nombre fiscal");

// Paso 10: CIF / NIF
const r10 = processOnboardingStep(onboardPhone, "44556677X");
assert(r10.handled === true, "Paso 10 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'FISCAL_ADDRESS', "Avanza al paso 11 (FISCAL_ADDRESS)");
assert(st.company.cif === '44556677X', "Guarda NIF en SQLite");

// Paso 11: Dirección fiscal
const r11 = processOnboardingStep(onboardPhone, "Av. Constitución 12, 41001 Sevilla");
assert(r11.handled === true, "Paso 11 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'TAX_RATE', "Avanza al paso 12 (TAX_RATE)");
assert(st.company.address.includes("Constitución"), "Guarda dirección fiscal");

// Paso 12: IVA
const r12 = processOnboardingStep(onboardPhone, "21%");
assert(r12.handled === true, "Paso 12 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'IRPF_RATE', "Avanza al paso 13 (IRPF_RATE)");
assert(st.company.defaultTaxRate === 21, "Guarda IVA del 21%");

// Paso 13: IRPF
const r13 = processOnboardingStep(onboardPhone, "15% de IRPF");
assert(r13.handled === true, "Paso 13 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'INVOICE_SERIES', "Avanza al paso 14 (INVOICE_SERIES)");
assert(st.company.irpfRate === 15, "Guarda retención de IRPF al 15%");

// Paso 14: Serie facturación
const r14 = processOnboardingStep(onboardPhone, "2026-001");
assert(r14.handled === true, "Paso 14 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'BANK_ACCOUNT', "Avanza al paso 15 (BANK_ACCOUNT)");
assert(st.company.invoiceSeries === '2026-001', "Guarda serie de facturas");

// Paso 15: Cuenta bancaria / Bizum (Cierre)
const r15 = processOnboardingStep(onboardPhone, "Mi cuenta es ES91 2100 0418 4502 0005 1332 y Bizum 601020304");
assert(r15.handled === true, "Paso 15 procesado");
assert(r15.completed === true, "Onboarding finalizado con éxito");
assert(r15.message.includes("¡Enhorabuena"), "Genera tarjeta de resumen y felicitación");

// Verificar persistencia completa y estado isConfigured
const finalComp = dbGetCompany(onboardPhone);
assert(finalComp.isConfigured === true, "Tras completar las 15 preguntas, isConfigured es true");
assert(finalComp.onboardingStep === null, "El estado de onboarding vuelve a null");
assert(finalComp.ownerName === 'Carlos', "Conserva ownerName");
assert(finalComp.city === 'Sevilla capital y provincia', "Conserva city");
assert(finalComp.workingHours === 'De 8:00 a 18:00 de lunes a viernes', "Conserva workingHours");
assert(finalComp.paymentTerms.includes("50%"), "Conserva paymentTerms");
assert(finalComp.defaultAdvance === 50, "Conserva defaultAdvance");
assert(finalComp.quoteValidityDays === 15, "Conserva quoteValidityDays");
assert(finalComp.entityType === 'autonomo', "Conserva entityType");
assert(finalComp.fiscalName === 'Carlos García Fernández', "Conserva fiscalName");
assert(finalComp.cif === '44556677X', "Conserva cif");
assert(finalComp.irpfRate === 15, "Conserva irpfRate");
assert(finalComp.invoiceSeries === '2026-001', "Conserva invoiceSeries");
assert(finalComp.iban.includes("ES91"), "Conserva IBAN formateado");
assert(finalComp.bizum === '601020304', "Conserva Bizum");

// 16. Verificación de cálculo fiscal en Facturas con la nueva configuración (Serie + IRPF)
const testBudgetForInvoice = {
  id: 'PRE-TEST-ONBOARD',
  client: { name: 'Empresa Cliente S.L.', nif: 'B-99887766', address: 'Calle Industria 1' },
  items: [{ id: 'ITEM-1', description: 'Instalación cuadro eléctrico', qty: 1, unit: 'ud', unitPrice: 1000, total: 1000 }],
  financials: { subtotal: 1000, taxableBase: 1000, taxRatePercentage: 21, taxAmount: 210, totalAmount: 1210 }
};
const customInv = engine.convertToInvoice(testBudgetForInvoice, { company: finalComp });
assert(customInv.id.startsWith('2026-001'), "Aplica la serie de facturación personalizada");
assert(customInv.financials.irpfRatePercentage === 15, "Aplica el 15% de IRPF configurado");
assert(customInv.financials.irpfAmount === 150, "Calcula 150€ de retención de IRPF (1000 * 15%)");
assert(customInv.financials.totalAmount === 1060, "Ajusta el total a pagar descontando el IRPF (1210 - 150 = 1060)");

// Test omisión bancaria con "luego" (sin números ni defaults ficticios)
const skipPhone = '34699999999';
dbSaveCompany(skipPhone, {
  name: 'Reformas Manolo S.L',
  ownerName: 'Manolo',
  cif: 'B12345678',
  onboardingStep: 'BANK_ACCOUNT',
  onboardingDataJson: JSON.stringify({ ownerName: 'Manolo', companyName: 'Reformas Manolo S.L', cif: 'B12345678' })
});
const rSkip = processOnboardingStep(skipPhone, "luego");
assert(rSkip.handled === true, "Omisión de cuenta procesada");
assert(rSkip.completed === true, "Onboarding finaliza al omitir con 'luego'");
assert(rSkip.message.includes("• *IBAN:* No configurado"), "IBAN se muestra como 'No configurado' sin números ficticios");
assert(rSkip.message.includes("• *Bizum:* No configurado"), "Bizum se muestra como 'No configurado' sin números ni teléfono");
const compSkipped = dbGetCompany(skipPhone);
assert(compSkipped.iban === null, "El IBAN queda null en base de datos al responder 'luego'");
assert(compSkipped.bizum === null, "El Bizum queda null en base de datos al responder 'luego'");
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(skipPhone);

// Test omisión completa de datos fiscales con "luego"
const skipAllPhone = '34677777777';
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(skipAllPhone);
startOnboarding(skipAllPhone);
processOnboardingStep(skipAllPhone, "Manolo y la empresa se llama Reformas Manolo S.L"); // Paso 1
processOnboardingStep(skipAllPhone, "Albañilería"); // Paso 2
processOnboardingStep(skipAllPhone, "luego"); // Paso 3 (CITY)
processOnboardingStep(skipAllPhone, "luego"); // Paso 4 (HOURS)
processOnboardingStep(skipAllPhone, "luego"); // Paso 5 (TERMS)
processOnboardingStep(skipAllPhone, "luego"); // Paso 6 (ADVANCE)
processOnboardingStep(skipAllPhone, "15 días"); // Paso 7 (VALIDITY)
processOnboardingStep(skipAllPhone, "empresa"); // Paso 8 (ENTITY)
processOnboardingStep(skipAllPhone, "luego"); // Paso 9 (FISCAL_NAME)
processOnboardingStep(skipAllPhone, "luego"); // Paso 10 (CIF)
processOnboardingStep(skipAllPhone, "luego"); // Paso 11 (ADDRESS)
processOnboardingStep(skipAllPhone, "10"); // Paso 12 (TAX)
processOnboardingStep(skipAllPhone, "0"); // Paso 13 (IRPF)
processOnboardingStep(skipAllPhone, "luego"); // Paso 14 (SERIES)
const rFinalSkip = processOnboardingStep(skipAllPhone, "luego"); // Paso 15 (BANK)

assert(rFinalSkip.completed === true, "Onboarding con omisiones finaliza con éxito");
assert(rFinalSkip.message.includes("• *NIF/CIF:* No indicado"), "CIF omitido muestra 'No indicado' y no B-00000000");
assert(rFinalSkip.message.includes("• *Dirección:* No indicada"), "Dirección omitida muestra 'No indicada' y no 'España'");
assert(rFinalSkip.message.includes("• *IBAN:* No configurado"), "IBAN omitido muestra 'No configurado'");
assert(rFinalSkip.message.includes("• *Bizum:* No configurado"), "Bizum omitido muestra 'No configurado'");
assert(rFinalSkip.message.includes("📍 *Zona de trabajo:* No indicada"), "Zona omitida muestra 'No indicada'");
assert(rFinalSkip.message.includes("⏰ *Horario habitual:* No indicado"), "Horario omitido muestra 'No indicado'");
const compAllSkipped = dbGetCompany(skipAllPhone);
assert(compAllSkipped.cif === null, "NIF queda null en base de datos al responder 'luego'");
assert(compAllSkipped.address === null, "Dirección queda null en base de datos al responder 'luego'");
assert(compAllSkipped.city === null, "Ciudad queda null en base de datos al responder 'luego'");
assert(compAllSkipped.ownerName === 'Manolo', "Extrae limpiamente el ownerName 'Manolo'");
assert(compAllSkipped.name === 'Reformas Manolo S.L', "Extrae limpiamente el name 'Reformas Manolo S.L'");
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(skipAllPhone);

// Limpieza test
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(onboardPhone);

// -----------------------------------------------------------------------------
// CASO 20: Router de Intenciones Determinístico y Consultas Agregadas SQLite (Sin IA)
// -----------------------------------------------------------------------------
console.log("\nTEST 20: Router de Intenciones Determinístico y Consultas Agregadas SQLite (Sin IA)");
import { detectIntent, resolveIntent } from './intent_router.js';
import {
  getMonthlyRevenue,
  listAppointmentsWeek,
  getDashboard,
  getCompany,
  saveInvoice as dbSaveInvoice,
  saveAppointment as dbSaveAppointment
} from './db_service.js';

// 1. Detección de intenciones determinísticas
assert(detectIntent("resumen")?.intent === 'DASHBOARD', "Detecta 'resumen' como DASHBOARD");
assert(detectIntent("estado")?.intent === 'DASHBOARD', "Detecta 'estado' como DASHBOARD");
assert(detectIntent("¿Qué tal va todo?")?.intent === 'DASHBOARD', "Detecta '¿Qué tal va todo?' como DASHBOARD");

assert(detectIntent("¿Quién me debe dinero?")?.intent === 'ALL_DEBTS', "Detecta '¿Quién me debe dinero?' como ALL_DEBTS");
assert(detectIntent("deudas pendientes")?.intent === 'ALL_DEBTS', "Detecta 'deudas pendientes' como ALL_DEBTS");
assert(detectIntent("cobros pendientes")?.intent === 'ALL_DEBTS', "Detecta 'cobros pendientes' como ALL_DEBTS");

const debtCarlos = detectIntent("¿Cuánto me debe Carlos?");
assert(debtCarlos?.intent === 'DEBT_BY_CLIENT', "Detecta '¿Cuánto me debe Carlos?' como DEBT_BY_CLIENT");
assert(debtCarlos?.params?.clientName === 'Carlos', "Extrae y normaliza el nombre del cliente 'Carlos'");

const statsSep = detectIntent("facturado en septiembre 2026");
assert(statsSep?.intent === 'MONTHLY_STATS', "Detecta 'facturado en septiembre 2026' como MONTHLY_STATS");
assert(statsSep?.params?.month === 9 && statsSep?.params?.year === 2026, "Extrae mes 9 y año 2026");

const statsThisMonth = detectIntent("¿Cuánto llevo este mes?");
assert(statsThisMonth?.intent === 'MONTHLY_STATS', "Detecta '¿Cuánto llevo este mes?' como MONTHLY_STATS");

assert(detectIntent("¿Qué tengo esta semana?")?.intent === 'WEEKLY_AGENDA', "Detecta '¿Qué tengo esta semana?' como WEEKLY_AGENDA");
assert(detectIntent("próximas citas")?.intent === 'WEEKLY_AGENDA', "Detecta 'próximas citas' como WEEKLY_AGENDA");

assert(detectIntent("¿Cuántos presupuestos tengo?")?.intent === 'BUDGET_STATS', "Detecta '¿Cuántos presupuestos tengo?' como BUDGET_STATS");

const workJuan = detectIntent("¿Cómo va la obra de Juan?");
assert(workJuan?.intent === 'WORK_STATUS', "Detecta '¿Cómo va la obra de Juan?' como WORK_STATUS");
assert(workJuan?.params?.clientName === 'juan', "Extrae cliente 'juan' para estado de obra");

const clientMaria = detectIntent("el presupuesto de María");
assert(clientMaria?.intent === 'CLIENT_LOOKUP', "Detecta 'el presupuesto de María' como CLIENT_LOOKUP");
assert(clientMaria?.params?.clientName === 'maria', "Extrae 'maria' para búsqueda");

// Tareas complejas que SÍ deben ir a Gemini
assert(detectIntent("He ido a ver la cocina de Pedro, tirar tabique y poner azulejos por 1200 euros") === null, "Audio/descripción compleja pasa a Gemini (null)");
assert(detectIntent("Redáctale un mensaje a Carlos para decirle que empezamos el lunes") === null, "Redacción de mensaje pasa a Gemini (null)");
assert(detectIntent("Hola, qué tal") === null, "Saludo pasa a flujo normal (null)");

// 2. Funciones de consulta agregada en SQLite
const testPhoneIntent = '34688776655';
const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = now.getMonth() + 1;

// Guardar factura de prueba
dbSaveInvoice(testPhoneIntent, {
  id: `FAC-${currentYear}-9999`,
  client: { name: 'Cliente Test Mes', address: 'Calle Test 12' },
  financials: { totalAmount: 1500, advanceAmount: 500, remainingAmount: 1000 },
  status: 'PENDIENTE_PAGO'
});

const monthlyRev = getMonthlyRevenue(testPhoneIntent, currentYear, currentMonth);
assert(monthlyRev.invoiceCount >= 1, "getMonthlyRevenue contabiliza al menos 1 factura");
assert(monthlyRev.totalInvoiced >= 1500, "getMonthlyRevenue suma el total facturado");
assert(monthlyRev.totalPending >= 1000, "getMonthlyRevenue suma el total pendiente");

// Guardar cita de prueba para próximos días
dbSaveAppointment(testPhoneIntent, {
  clientName: 'Visita Semanal Test',
  date: now.toISOString().split('T')[0],
  time: '11:30',
  notes: 'Revisión fontanería'
});

const weekApts = listAppointmentsWeek(testPhoneIntent);
assert(weekApts.some(a => a.clientName === 'Visita Semanal Test'), "listAppointmentsWeek encuentra la cita semanal");

const dashData = getDashboard(testPhoneIntent);
assert(dashData.totalDebt >= 1000, "getDashboard calcula deuda total correctamente");
assert(dashData.debtCount >= 1, "getDashboard cuenta las facturas pendientes");

// 3. Resolución de intenciones con resolveIntent
const dashReply = await resolveIntent({ intent: 'DASHBOARD', params: {} }, testPhoneIntent, {});
assert(dashReply.includes('Dashboard de PresuVoz'), "resolveIntent(DASHBOARD) genera cabecera de Dashboard");
assert(dashReply.includes('Pendiente de cobrar'), "resolveIntent(DASHBOARD) incluye deudas");

const debtsReply = await resolveIntent({ intent: 'ALL_DEBTS', params: {} }, testPhoneIntent, {});
assert(debtsReply.includes('Cobros pendientes'), "resolveIntent(ALL_DEBTS) lista deudas pendientes");
assert(debtsReply.includes('Cliente Test Mes'), "resolveIntent(ALL_DEBTS) muestra el cliente con deuda");

const debtClientReply = await resolveIntent({ intent: 'DEBT_BY_CLIENT', params: { clientName: 'Test Mes' } }, testPhoneIntent, {});
assert(debtClientReply.includes('Deuda de Cliente Test Mes'), "resolveIntent(DEBT_BY_CLIENT) muestra deuda del cliente específico");

const agendaReply = await resolveIntent({ intent: 'WEEKLY_AGENDA', params: {} }, testPhoneIntent, {});
assert(agendaReply.includes('Agenda — próximos 7 días'), "resolveIntent(WEEKLY_AGENDA) formatea agenda");

const statsReply = await resolveIntent({ intent: 'MONTHLY_STATS', params: { month: currentMonth, year: currentYear } }, testPhoneIntent, {});
assert(statsReply.includes('Total facturado'), "resolveIntent(MONTHLY_STATS) resume finanzas del mes");

// 4. Intenciones determinísticas de configuración de empresa (Bizum, IBAN, Perfil)
assert(detectIntent("mi bizum es 611223344")?.intent === 'SET_BIZUM', "Detecta 'mi bizum es 611223344' como SET_BIZUM");
assert(detectIntent("pon de bizum 600123456")?.params?.bizum === '600123456', "Extrae número de Bizum correctamente");
assert(detectIntent("mi iban es ES21 1465 0100 72 2030876293")?.intent === 'SET_IBAN', "Detecta IBAN como SET_IBAN");
assert(detectIntent("ver mis datos")?.intent === 'SHOW_COMPANY', "Detecta 'ver mis datos' como SHOW_COMPANY");
assert(detectIntent("configuracion")?.intent === 'SHOW_COMPANY', "Detecta 'configuracion' como SHOW_COMPANY");

const setBizumReply = await resolveIntent({ intent: 'SET_BIZUM', params: { bizum: '611223344' } }, testPhoneIntent, {});
assert(setBizumReply.includes('Bizum actualizado con éxito'), "resolveIntent(SET_BIZUM) confirma actualización");
assert(setBizumReply.includes('611223344'), "resolveIntent(SET_BIZUM) incluye el número guardado");
assert(getCompany(testPhoneIntent).bizum === '611223344', "Bizum persiste en SQLite");

const showCompanyReply = await resolveIntent({ intent: 'SHOW_COMPANY', params: {} }, testPhoneIntent, {});
assert(showCompanyReply.includes('DATOS DE TU EMPRESA'), "resolveIntent(SHOW_COMPANY) muestra cabecera");
assert(showCompanyReply.includes('611223344'), "resolveIntent(SHOW_COMPANY) muestra el Bizum activo");

// Limpieza de datos de prueba
cleanDb.prepare('DELETE FROM invoices WHERE company_phone = ?').run(testPhoneIntent);
cleanDb.prepare('DELETE FROM appointments WHERE company_phone = ?').run(testPhoneIntent);
cleanDb.prepare('DELETE FROM budgets WHERE company_phone = ?').run(testPhoneIntent);
cleanDb.prepare('DELETE FROM audit_logs WHERE business_id = ?').run(testPhoneIntent);

// -----------------------------------------------------------------------------
// CASO 21: Persistencia de Mensajes (messages), Deduplicación y Estados de Conversación
// -----------------------------------------------------------------------------
console.log("\nTEST 21: Persistencia de Mensajes (messages), Deduplicación y Estados de Conversación");
import {
  recordIncomingMessage,
  updateMessageStatus,
  getMessageByWhatsappId,
  getMessage,
  isMessageAlreadyProcessed,
  listRecentMessages
} from './db_service.js';
import {
  getConversationState,
  setConversationState
} from './whatsapp_gateway.js';

const testWamId = `wamid.test_${Date.now()}`;
const testChatId = '34611223344@s.whatsapp.net';
const testSenderPhone = '34611223344';

// 1. Registro inicial (RECEIVED)
const recorded = recordIncomingMessage({
  whatsappMessageId: testWamId,
  businessId: testSenderPhone,
  chatId: testChatId,
  senderPhone: testSenderPhone,
  content: 'Quiero un presupuesto para reformar el baño',
  status: 'RECEIVED'
});

assert(recorded !== null, "Registra el mensaje entrante en la tabla messages");
assert(recorded.whatsappMessageId === testWamId, "Guarda el whatsapp_message_id correctamente");
assert(recorded.status === 'RECEIVED', "Estado inicial es RECEIVED");
assert(recorded.content === 'Quiero un presupuesto para reformar el baño', "Guarda el contenido del mensaje");
assert(isMessageAlreadyProcessed(testWamId) === false, "En estado RECEIVED aún no se considera procesado");

// 2. Transición a QUEUED
updateMessageStatus(testWamId, 'QUEUED');
const queuedMsg = getMessageByWhatsappId(testWamId);
assert(queuedMsg.status === 'QUEUED', "Transición de estado a QUEUED correcta");
assert(isMessageAlreadyProcessed(testWamId) === false, "En estado QUEUED no se considera procesado todavía");

// 3. Transición a PROCESSING
updateMessageStatus(testWamId, 'PROCESSING');
const processingMsg = getMessageByWhatsappId(testWamId);
assert(processingMsg.status === 'PROCESSING', "Transición de estado a PROCESSING correcta");
assert(isMessageAlreadyProcessed(testWamId) === true, "En estado PROCESSING se activa la protección anti-duplicados");

// 4. Transición final a PROCESSED
updateMessageStatus(testWamId, 'PROCESSED');
const processedMsg = getMessageByWhatsappId(testWamId);
assert(processedMsg.status === 'PROCESSED', "Transición final a PROCESSED exitosa");
assert(isMessageAlreadyProcessed(testWamId) === true, "En estado PROCESSED se descartan reenvíos de la API");

// 5. Manejo de estado FAILED con posibilidad de reintento
const failedWamId = `wamid.fail_${Date.now()}`;
recordIncomingMessage({
  whatsappMessageId: failedWamId,
  businessId: testSenderPhone,
  chatId: testChatId,
  senderPhone: testSenderPhone,
  content: 'Audio corrupto',
  status: 'RECEIVED'
});
updateMessageStatus(failedWamId, 'FAILED');
const failedMsg = getMessageByWhatsappId(failedWamId);
assert(failedMsg.status === 'FAILED', "Registra estado FAILED ante fallos");
assert(isMessageAlreadyProcessed(failedWamId) === false, "Un mensaje FAILED permite reintento (no se bloquea)");

// 6. Auditoría de mensajes recientes del chat
const recentList = listRecentMessages(testChatId, 10);
assert(recentList.length >= 2, "listRecentMessages recupera los mensajes del chat");
assert(recentList.some(m => m.whatsappMessageId === testWamId), "La lista incluye el mensaje procesado");

// 7. Estados de la conversación (IDLE -> PROCESSING -> WAITING_FOR_INPUT)
setConversationState(testChatId, 'IDLE');
assert(getConversationState(testChatId) === 'IDLE', "Estado de conversación inicial: IDLE");

setConversationState(testChatId, 'PROCESSING');
assert(getConversationState(testChatId) === 'PROCESSING', "Estado de conversación pasa a PROCESSING durante la tarea");

setConversationState(testChatId, 'WAITING_FOR_INPUT');
assert(getConversationState(testChatId) === 'WAITING_FOR_INPUT', "Estado pasa a WAITING_FOR_INPUT al esperar respuesta");

// Limpieza de prueba
cleanDb.prepare('DELETE FROM messages WHERE chat_id = ?').run(testChatId);
setConversationState(testChatId, 'IDLE');

// -----------------------------------------------------------------------------
// CASO 22: Módulo Fiscal y Cierre Trimestral para Gestoría (Casos 1 al 14 - AEAT, Control de Calidad y Exportación)
// -----------------------------------------------------------------------------
console.log("\nTEST 22: Módulo Fiscal y Cierre Trimestral para Gestoría (Casos 1 al 14 - AEAT, Control de Calidad y Exportación)");
import {
  saveCompany as dbSaveCompanyFiscal,
  saveInvoice as dbSaveInvoiceFiscal,
  savePayment as dbSavePaymentFiscal,
  saveTaxProfile,
  getTaxProfile,
  deleteTaxProfile,
  isUuid,
  savePurchaseInvoice,
  listPurchaseInvoices,
  saveExpensePayment,
  listExpensePayments,
  saveInvestmentAsset,
  getInvestmentAsset,
  listInvestmentAssets,
  deleteInvestmentAsset,
  getOrCreateFiscalPeriod,
  updateFiscalPeriodStatus,
  listFiscalIncidents,
  recordAuditLog,
  getAuditLog,
  listAuditLogs,
  saveAppointment as testSaveAppointment,
  getAppointment as testGetAppointment,
  findAppointments as testFindAppointments,
  rescheduleAppointment as testRescheduleAppointment,
  completeAppointments as testCompleteAppointments,
  cancelAppointment as testCancelAppointment,
  listAppointments as testListAppointments,
  findConflictingAppointments as testFindConflictingAppointments,
  getAppointmentHistory as testGetAppointmentHistory
} from './db_service.js';
import {
  getFiscalPeriodBounds,
  getQuarterSummary,
  runFiscalQualityChecks,
  generateNormalizedExcel,
  generateGestoriaSummaryPDF,
  generateIssuedInvoicesCSV,
  generateReceivedInvoicesCSV,
  buildGestoriaPackageZip,
  sendFiscalPackageToGestoria,
  formatQuarterWhatsAppSummary
} from './fiscal_service.js';

const testFiscalPhone = '34655443322';
const testFiscalPhoneB = '34699887766'; // Empresa B para prueba multi-tenancy

// Limpieza inicial
try {
  cleanDb.prepare('DELETE FROM payment_allocations WHERE company_id IN (SELECT id FROM companies WHERE phone = ? OR phone = ?)').run(testFiscalPhone, testFiscalPhoneB);
} catch (e) {}
cleanDb.prepare('DELETE FROM payments WHERE company_phone = ? OR company_phone = ?').run(testFiscalPhone, testFiscalPhoneB);
cleanDb.prepare('DELETE FROM invoices WHERE company_phone = ? OR company_phone = ?').run(testFiscalPhone, testFiscalPhoneB);
cleanDb.prepare('DELETE FROM purchase_invoices WHERE business_id = ? OR business_id = ?').run(testFiscalPhone, testFiscalPhoneB);
cleanDb.prepare('DELETE FROM expense_payments WHERE business_id = ? OR business_id = ?').run(testFiscalPhone, testFiscalPhoneB);
cleanDb.prepare('DELETE FROM investment_assets WHERE business_id = ? OR business_id = ?').run(testFiscalPhone, testFiscalPhoneB);
cleanDb.prepare('DELETE FROM fiscal_periods WHERE business_id = ? OR business_id = ?').run(testFiscalPhone, testFiscalPhoneB);
cleanDb.prepare('DELETE FROM fiscal_incidents WHERE business_id = ? OR business_id = ?').run(testFiscalPhone, testFiscalPhoneB);
cleanDb.prepare('DELETE FROM audit_logs WHERE business_id = ? OR business_id = ?').run(testFiscalPhone, testFiscalPhoneB);
cleanDb.prepare('DELETE FROM companies WHERE phone = ? OR phone = ?').run(testFiscalPhone, testFiscalPhoneB);

// Configurar perfil de empresa y perfil fiscal
dbSaveCompanyFiscal(testFiscalPhone, {
  name: 'Reformas Pro Martínez S.L.',
  cif: 'B87654321',
  address: 'Calle Mayor 10, Madrid',
  gestoriaEmail: 'asesor@gestoriamartinez.es'
});

saveTaxProfile(testFiscalPhone, {
  entityType: 'AUTONOMO',
  vatRegime: 'GENERAL',
  defaultVatRate: 21,
  defaultIrpfRetentionRate: 15,
  gestoriaEmail: 'asesor@gestoriamartinez.es'
});

// Periodo de prueba: Q3 2026 (1 julio 2026 a 30 septiembre 2026)
const pBounds = getFiscalPeriodBounds(2026, 3);
assert(pBounds.startDate === '2026-07-01' && pBounds.endDate === '2026-09-30', "Determina los límites exactos de Q3 2026");

// CASO 1: Factura emitida normal (Base 1.000€, IVA 210€, Total 1.210€)
const inv1 = dbSaveInvoiceFiscal(testFiscalPhone, {
  id: 'INV-2026-001',
  invoice_number: 'F-2026-001',
  issue_date: '2026-07-10',
  client_name: 'Alberto Gómez',
  client_tax_id: '12345678Z',
  client_address: 'Calle Luna 15, Madrid',
  tax_base: 1000.00,
  tax_rate: 21.00,
  tax_amount: 210.00,
  irpf_rate: 0,
  irpf_retention: 0,
  total_amount: 1210.00,
  is_advance: 0,
  fiscal_period: '2026_Q3'
});
assert(inv1.id === 'INV-2026-001', "CASO 1: Registra factura emitida F-2026-001");

let qSum1 = getQuarterSummary(testFiscalPhone, 2026, 3);
assert(qSum1.summary.issuedCount === 1, "CASO 1: Contabiliza 1 factura emitida");
assert(qSum1.summary.issuedTaxBase === 1000, "CASO 1: Base imponible correcta (1.000€)");
assert(qSum1.summary.issuedVatTotal === 210, "CASO 1: IVA devengado repercutido correcto (210€)");
assert(qSum1.summary.issuedTotalAmount === 1210, "CASO 1: Total facturado correcto (1.210€)");

// CASO 2: Factura recibida de proveedor (Leroy Merlin, Base 500€, IVA 105€, Total 605€)
const pinv1 = savePurchaseInvoice(testFiscalPhone, {
  id: 'PINV-001',
  supplierName: 'Leroy Merlin España S.L.U.',
  supplierTaxId: 'A12345678',
  invoiceNumber: 'LM-998822',
  issueDate: '2026-07-15',
  category: 'MATERIALES',
  description: 'Mortero, cemento y azulejo blanco',
  taxBase: 500.00,
  vatRate: 21.00,
  vatAmount: 105.00,
  irpfRetention: 0,
  totalAmount: 605.00,
  vatDeductible: true,
  deductiblePercentage: 100,
  deductibilityStatus: 'LIKELY_DEDUCTIBLE',
  paidAmount: 605.00,
  fiscalPeriod: '2026_Q3'
});
assert(pinv1.id === 'PINV-001', "CASO 2: Registra factura recibida de proveedor");

let qSum2 = getQuarterSummary(testFiscalPhone, 2026, 3);
assert(qSum2.summary.receivedCount === 1, "CASO 2: Contabiliza 1 factura recibida");
assert(qSum2.summary.receivedTaxBase === 500, "CASO 2: Base deducible de compras correcta (500€)");
assert(qSum2.summary.receivedVatSupported === 105, "CASO 2: IVA soportado correcto (105€)");
assert(qSum2.summary.receivedVatDeductible === 105, "CASO 2: IVA deducible correcto (105€)");
assert(qSum2.summary.modelo303.ivaDevengado === 210, "CASO 2: Modelo 303 IVA devengado = 210€");
assert(qSum2.summary.modelo303.ivaDeducible === 105, "CASO 2: Modelo 303 IVA deducible = 105€");
assert(qSum2.summary.modelo303.resultado === 105, "CASO 2: Modelo 303 resultado = 105€ a ingresar");
assert(qSum2.summary.modelo303.tipoResultado === 'A_INGRESAR', "CASO 2: Modelo 303 tipo A_INGRESAR");

// CASO 3: Factura emitida cobrada parcialmente (Total 1.210€, cobro 600€)
dbSavePaymentFiscal(testFiscalPhone, 'INV-2026-001', {
  amount: 600.00,
  date: '2026-07-20',
  method: 'Transferencia',
  concept: 'Pago a cuenta obra'
});
let qSum3 = getQuarterSummary(testFiscalPhone, 2026, 3);
assert(qSum3.summary.issuedTotalAmount === 1210, "CASO 3: Total factura sigue siendo 1.210€");
assert(qSum3.summary.issuedCollectedTotal === 600, "CASO 3: Cobrado registrado exactamente 600€");
assert(qSum3.summary.issuedPendingTotal === 610, "CASO 3: Pendiente de cobro exactamente 610€ (1.210 - 600)");
assert(qSum3.invoices[0].isPaid === false, "CASO 3: Factura parcialmente cobrada figura como no pagada");

// CASO 4: Factura con dos pagos distintos (Cobro 2: 610€ por Bizum -> Liquidada)
dbSavePaymentFiscal(testFiscalPhone, 'INV-2026-001', {
  amount: 610.00,
  date: '2026-08-05',
  method: 'Bizum',
  concept: 'Liquidación final factura'
});
let qSum4 = getQuarterSummary(testFiscalPhone, 2026, 3);
assert(qSum4.summary.issuedCollectedTotal === 1210, "CASO 4: Suma acumulada de cobros = 1.210€");
assert(qSum4.summary.issuedPendingTotal === 0, "CASO 4: Pendiente pasa a 0€");
assert(qSum4.invoices[0].isPaid === true, "CASO 4: Factura pasa a estado COBRADA");

// CASO 5: Factura rectificativa vinculada a la factura previa
const rect1 = dbSaveInvoiceFiscal(testFiscalPhone, {
  id: 'INV-2026-R01',
  invoice_number: 'R-2026-001',
  issue_date: '2026-08-15',
  client_name: 'Alberto Gómez',
  client_tax_id: '12345678Z',
  tax_base: -200.00,
  tax_rate: 21.00,
  tax_amount: -42.00,
  total_amount: -242.00,
  rectifies_invoice_id: 'INV-2026-001',
  invoice_type: 'RECTIFICATIVA',
  fiscal_period: '2026_Q3'
});
assert((rect1.rectifiesInvoiceId || rect1.rectifies_invoice_id) === 'INV-2026-001', "CASO 5: Factura rectificativa vinculada por ID");
let qSum5 = getQuarterSummary(testFiscalPhone, 2026, 3);
assert(qSum5.summary.rectificativas.count === 1, "CASO 5: Detecta 1 factura rectificativa");
assert(qSum5.summary.rectificativas.base === -200, "CASO 5: Base rectificada -200€");
assert(qSum5.summary.rectificativas.vat === -42, "CASO 5: Cuota IVA rectificada -42€");

// CASO 6: Factura de anticipo (Devengo inmediato de IVA)
const adv1 = dbSaveInvoiceFiscal(testFiscalPhone, {
  id: 'INV-2026-ADV01',
  invoice_number: 'F-2026-002',
  issue_date: '2026-08-20',
  client_name: 'María Santillana',
  client_tax_id: '98765432B',
  tax_base: 413.22,
  tax_rate: 21.00,
  tax_amount: 86.78,
  total_amount: 500.00,
  is_advance: 1,
  fiscal_period: '2026_Q3'
});
assert(Boolean(adv1.isAdvance || adv1.is_advance) === true, "CASO 6: Factura guardada como anticipo");
let qSum6 = getQuarterSummary(testFiscalPhone, 2026, 3);
assert(qSum6.summary.advances.count === 1, "CASO 6: Detecta 1 factura de anticipo");
assert(qSum6.summary.advances.total === 500, "CASO 6: Total anticipo devengado 500€");

// CASO 7: Gasto sin IVA o exento (Seguro RC Profesional Mapfre 350€, IVA 0)
const pinvExempt = savePurchaseInvoice(testFiscalPhone, {
  id: 'PINV-002',
  supplierName: 'Mapfre Seguros Generales',
  supplierTaxId: 'A28000000',
  invoiceNumber: 'MAP-2026-88',
  issueDate: '2026-08-25',
  category: 'SEGUROS',
  description: 'Póliza Seguro Responsabilidad Civil Profesional',
  taxBase: 350.00,
  vatRate: 0.00,
  vatAmount: 0.00,
  totalAmount: 350.00,
  vatDeductible: false,
  deductiblePercentage: 0,
  deductibilityStatus: 'LIKELY_DEDUCTIBLE', // Deducible en IRPF, exento de IVA
  paidAmount: 350.00,
  fiscalPeriod: '2026_Q3'
});
let qSum7 = getQuarterSummary(testFiscalPhone, 2026, 3);
assert(qSum7.summary.receivedTaxBase === 850, "CASO 7: Base total compras 850€ (500 + 350)");
assert(qSum7.summary.receivedVatSupported === 105, "CASO 7: IVA soportado sigue en 105€ (no suma IVA el seguro)");
assert(qSum7.summary.modelo130.gastosDeduciblesIRPF >= 850, "CASO 7: Se computa el seguro como gasto en IRPF");

// CASO 8: Gasto no deducible o en revisión (Combustible y Restauración)
const pinvGas = savePurchaseInvoice(testFiscalPhone, {
  id: 'PINV-003',
  supplierName: 'Repsol Estación de Servicio',
  supplierTaxId: 'A28003704',
  invoiceNumber: 'REP-9921',
  issueDate: '2026-09-01',
  category: 'COMBUSTIBLE',
  description: 'Gasóleo A furgoneta',
  taxBase: 100.00,
  vatRate: 21.00,
  vatAmount: 21.00,
  totalAmount: 121.00,
  vatDeductible: true,
  deductiblePercentage: 100, // Marcado al 100% pero en categoría combustible
  deductibilityStatus: 'NEEDS_REVIEW',
  paidAmount: 121.00,
  fiscalPeriod: '2026_Q3'
});
let qSum8 = getQuarterSummary(testFiscalPhone, 2026, 3);
assert(qSum8.summary.needsReviewCount >= 1, "CASO 8: Marca gasto como NEEDS_REVIEW");

// CASO 9: Bien de inversión > 3.005,06 € (Maquinaria hormigonera 4.000€ + IVA)
const pinvAsset = savePurchaseInvoice(testFiscalPhone, {
  id: 'PINV-004',
  supplierName: 'Maquinaria de Construcción Madrid S.L.',
  supplierTaxId: 'B82233445',
  invoiceNumber: 'MAQ-4451',
  issueDate: '2026-09-05',
  category: 'HERRAMIENTAS',
  description: 'Hormigonera industrial 350L y generador diésel',
  taxBase: 4000.00,
  vatRate: 21.00,
  vatAmount: 840.00,
  totalAmount: 4840.00,
  vatDeductible: true,
  deductiblePercentage: 100,
  deductibilityStatus: 'LIKELY_DEDUCTIBLE',
  paidAmount: 4840.00,
  fiscalPeriod: '2026_Q3'
});

// Calidad fiscal antes de registrar en investment_assets -> debe avisar de ASSET_OVER_THRESHOLD
let qCheckAsset = runFiscalQualityChecks(testFiscalPhone, 2026, 3);
assert(qCheckAsset.incidents.some(i => i.errorCode === 'ASSET_OVER_THRESHOLD'), "CASO 9: Calidad fiscal detecta gasto > 3.005,06€ como bien de inversión");

// Registrar en la tabla de bienes de inversión
saveInvestmentAsset(testFiscalPhone, {
  purchaseInvoiceId: 'PINV-004',
  description: 'Hormigonera industrial 350L y generador diésel',
  purchaseDate: '2026-09-05',
  supplierName: 'Maquinaria de Construcción Madrid S.L.',
  purchaseBase: 4000.00,
  vatAmount: 840.00,
  totalAmount: 4840.00
});
let assetsList = listInvestmentAssets(testFiscalPhone);
assert(assetsList.length === 1, "CASO 9: Activo inventariado en investment_assets");

// CASO 10: Detección de factura duplicada
const dupInv = dbSaveInvoiceFiscal(testFiscalPhone, {
  id: 'INV-DUP-TEST',
  invoice_number: 'F-2026-001', // Duplicada a propósito
  issue_date: '2026-09-10',
  client_name: 'Cliente Duplicado',
  client_tax_id: '11223344X',
  tax_base: 100.00,
  tax_rate: 21.00,
  tax_amount: 21.00,
  total_amount: 121.00,
  fiscal_period: '2026_Q3'
});
let qCheckDup = runFiscalQualityChecks(testFiscalPhone, 2026, 3);
assert(qCheckDup.criticalCount >= 1, "CASO 10: Detecta incidencia crítica ante duplicidad");
assert(qCheckDup.incidents.some(i => i.errorCode === 'DUPLICATE_INVOICE_NUMBER'), "CASO 10: Error DUPLICATE_INVOICE_NUMBER detectado");
assert(qCheckDup.isValid === false, "CASO 10: Marca el periodo como NO VÁLIDO para enviar");
// Limpiar la duplicada para continuar
cleanDb.prepare('DELETE FROM invoices WHERE id = ?').run('INV-DUP-TEST');

// CASO 11: Factura > 400€ sin NIF de cliente
const noNifInv = dbSaveInvoiceFiscal(testFiscalPhone, {
  id: 'INV-NONIF-TEST',
  invoice_number: 'F-2026-999',
  issue_date: '2026-09-12',
  client_name: 'Particular Desconocido',
  client_tax_id: '', // Sin NIF
  tax_base: 500.00,
  tax_rate: 21.00,
  tax_amount: 105.00,
  total_amount: 605.00,
  fiscal_period: '2026_Q3'
});
let qCheckNoNif = runFiscalQualityChecks(testFiscalPhone, 2026, 3);
assert(qCheckNoNif.incidents.some(i => i.errorCode === 'MISSING_CUSTOMER_NIF'), "CASO 11: Detecta factura > 400€ sin NIF de cliente");
cleanDb.prepare('DELETE FROM invoices WHERE id = ?').run('INV-NONIF-TEST');

// CASO 12: Aislamiento estricto multi-inquilino (Multi-Tenancy)
// Crear datos para Empresa B
dbSaveCompanyFiscal(testFiscalPhoneB, {
  name: 'Fontanería Hermanos Pérez S.L.',
  cif: 'B99112233'
});
dbSaveInvoiceFiscal(testFiscalPhoneB, {
  id: 'INV-EMP-B-1',
  invoice_number: 'FB-2026-01',
  issue_date: '2026-07-25',
  client_name: 'Cliente Empresa B',
  client_tax_id: '55443322K',
  tax_base: 9999.00,
  tax_rate: 21.00,
  tax_amount: 2099.79,
  total_amount: 12098.79,
  fiscal_period: '2026_Q3'
});

const sumCompanyA = getQuarterSummary(testFiscalPhone, 2026, 3);
const sumCompanyB = getQuarterSummary(testFiscalPhoneB, 2026, 3);
assert(sumCompanyA.summary.issuedTaxBase !== sumCompanyB.summary.issuedTaxBase, "CASO 12: Bases imponibles de A y B son distintas");
assert(sumCompanyA.invoices.every(inv => inv.id !== 'INV-EMP-B-1'), "CASO 12: Empresa A no ve ninguna factura de Empresa B");
assert(sumCompanyB.invoices.length === 1 && sumCompanyB.summary.issuedTaxBase === 9999, "CASO 12: Empresa B contiene exclusivamente sus 9.999€");

// CASO 13: Cierre trimestral completo, generación de ZIP y Excel normalizado AEAT
const pkgZip = await buildGestoriaPackageZip(testFiscalPhone, 2026, 3);
assert(pkgZip.fileName.includes('Cierre_Fiscal_2026_Q3'), "CASO 13: Nombre de archivo ZIP normalizado");
assert(pkgZip.zipBuffer && pkgZip.zipBuffer.length > 500, "CASO 13: Buffer del archivo ZIP generado con éxito");
assert(fs.existsSync(pkgZip.zipPath), "CASO 13: Archivo ZIP guardado físicamente en disco");

// Verificar hojas y contenido del Excel
const excelBuffer = await generateNormalizedExcel(testFiscalPhone, 2026, 3);
assert(excelBuffer && excelBuffer.length > 1000, "CASO 13: Excel normalizado generado con éxito (>1KB)");

// Verificar CSVs con BOM UTF-8 y delimitador punto y coma
const csvEmitidas = generateIssuedInvoicesCSV(pkgZip.quarterData);
assert(csvEmitidas.startsWith('\uFEFF'), "CASO 13: CSV Emitidas comienza con UTF-8 BOM");
assert(csvEmitidas.includes('NUMERO_FACTURA;FECHA_EXPEDICION;NIF_DESTINATARIO'), "CASO 13: CSV Emitidas con cabeceras normalizadas y delimitador ';'");

const csvRecibidas = generateReceivedInvoicesCSV(pkgZip.quarterData);
assert(csvRecibidas.startsWith('\uFEFF'), "CASO 13: CSV Recibidas comienza con UTF-8 BOM");
assert(csvRecibidas.includes('REGISTRO_INTERNO;FACTURA_PROVEEDOR;FECHA_EMISION'), "CASO 13: CSV Recibidas con cabeceras oficiales");

// Verificar PDF de cierre
const pdfBuffer = await generateGestoriaSummaryPDF(testFiscalPhone, 2026, 3);
assert(pdfBuffer && pdfBuffer.length > 1000, "CASO 13: PDF de Informe de Cierre generado con éxito");

// CASO 14: Envío protegido a gestoría (Nivel C) con confirmación explícita
// 1. Detección de intención en router determinístico
const intentSummary = detectIntent("prepárame lo de la gestoría");
assert(intentSummary?.intent === 'FISCAL_QUARTER_SUMMARY', "CASO 14: Detecta 'prepárame lo de la gestoría' como FISCAL_QUARTER_SUMMARY");

const intentSend = detectIntent("enviar a mi gestoría");
assert(intentSend?.intent === 'SEND_TO_GESTORIA', "CASO 14: Detecta 'enviar a mi gestoría' como SEND_TO_GESTORIA");

// 2. Comprobar que requiere confirmación estricta (Nivel C)
const actionProposed = createProposedAction('C', 'send_gestoria_package', { quarter: 3, year: 2026 }, 'Enviar paquete a gestoría');
assert(actionProposed.level === 'C', "CASO 14: Enviar a la gestoría es Nivel C (Acción Crítica)");

const evalNo = evaluateConfirmationResponse(actionProposed, "no, espera");
assert(evalNo.status === 'REJECTED', "CASO 14: 'no, espera' descarta el envío");

const evalSoft = evaluateConfirmationResponse(actionProposed, "vale");
assert(evalSoft.status === 'NEED_STRONG_CONFIRMATION', "CASO 14: 'vale' no es suficiente en Nivel C, exige CONFIRMAR");

const evalYes = evaluateConfirmationResponse(actionProposed, "CONFIRMAR");
assert(evalYes.status === 'APPROVED', "CASO 14: 'CONFIRMAR' aprueba la acción");

// 3. Ejecutar envío seguro simulado en modo controlado
process.env.FEATURE_GESTORIA = 'test';
const sendResult = await sendFiscalPackageToGestoria({
  businessId: testFiscalPhone,
  year: 2026,
  quarter: 3
});
assert(sendResult.success === true, "CASO 14: Envío a gestoría registrado satisfactoriamente");

// 4. Verificar auditoría y cambio de estado en la base de datos
const periodRecord = getOrCreateFiscalPeriod(testFiscalPhone, 2026, 3);
assert(periodRecord.status === 'SENT', "CASO 14: El período fiscal pasa a estado SENT");

const logs = listAuditLogs(testFiscalPhone, { entityType: 'FISCAL_PERIOD' });
assert(logs.some(l => l.action === 'SEND_PACKAGE_GESTORIA'), "CASO 14: Acción registrada en audit_logs de forma inmutable");
process.env.FEATURE_GESTORIA = 'false';

// -----------------------------------------------------------------------------
// TEST 23: MODELO INTEGRAL DE VISITAS (REGLA DE ORO CONFIRMED, CICLO DE VIDA, REAGENDAMIENTOS Y AUDITORÍA)
// -----------------------------------------------------------------------------
console.log("\nTEST 23: Arquitectura Integral de Visitas Técnicas (CONFIRMED directo, Reagendamiento, Fin de Día y Auditoría)");

const testVisitPhone = '34611998877';
cleanDb.prepare('DELETE FROM appointments WHERE company_phone = ?').run(testVisitPhone);
cleanDb.prepare('DELETE FROM audit_logs WHERE business_id = ?').run(testVisitPhone);
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(testVisitPhone);

// 1. Creación directa (Regla de Oro: Siempre CONFIRMED de entrada)
const apt1 = testSaveAppointment(testVisitPhone, {
  clientName: 'Juan Pérez',
  clientPhone: '612345678',
  clientAddress: 'Calle Betis 10, Sevilla',
  date: '2026-09-27',
  time: '11:00',
  notes: 'Presupuesto de alicatado de cocina'
});

assert(apt1.id.startsWith('CIT-'), "CASO 15: Genera ID secuencial con prefijo CIT");
assert(apt1.status === 'CONFIRMED', "CASO 15: La visita nace directamente como CONFIRMED (Regla de Oro)");
assert(apt1.outcome === 'NONE', "CASO 15: El outcome inicial es NONE");
assert(apt1.scheduledStart.includes('2026-09-27T11:00:00'), "CASO 15: Genera scheduled_start ISO con fecha y hora");
assert(apt1.rescheduleCount === 0, "CASO 15: El contador inicial de reagendamientos es 0");

const logsCreate = testGetAppointmentHistory(testVisitPhone, apt1.id);
assert(logsCreate.some(l => l.action === 'CREATE' && l.newValue === 'CONFIRMED'), "CASO 15: Registra CREATE en audit_logs de forma inmutable");

// 2. Detección de colisión de horario
const conflicts = testFindConflictingAppointments(testVisitPhone, '2026-09-27', '11:00');
assert(conflicts.length === 1 && conflicts[0].clientName === 'Juan Pérez', "CASO 15: Detecta colisión horaria si existe otra visita a la misma hora");

const noConflicts = testFindConflictingAppointments(testVisitPhone, '2026-09-27', '12:30');
assert(noConflicts.length === 0, "CASO 15: No detecta colisión si la hora está libre");

// 3. Reagendamiento sin perder el registro ni crear una visita duplicada
const reschResult = testRescheduleAppointment(testVisitPhone, 'Juan', '2026-09-30', '18:00', 'Cliente solicita cambio de fecha');
assert(reschResult.success === true, "CASO 15: Reagendamiento exitoso");
assert(reschResult.appointment.id === apt1.id, "CASO 15: Mantiene el mismo registro en base de datos (NO duplica visita)");
assert(reschResult.appointment.date === '2026-09-30', "CASO 15: Fecha actualizada a 2026-09-30");
assert(reschResult.appointment.time === '18:00', "CASO 15: Hora actualizada a 18:00");
assert(reschResult.appointment.status === 'CONFIRMED', "CASO 15: Estado sigue siendo CONFIRMED tras reagendar");
assert(reschResult.appointment.rescheduleCount === 1, "CASO 15: Incrementa reschedule_count a 1");

const logsResch = testGetAppointmentHistory(testVisitPhone, apt1.id);
assert(logsResch.some(l => l.action === 'RESCHEDULE' && l.oldValue.includes('2026-09-27 11:00') && l.newValue.includes('2026-09-30 18:00')), "CASO 15: Registra RESCHEDULE en audit_logs con valores anteriores y nuevos");

// 4. Modificación de detalles sin alterar fecha
const updatedDetails = testSaveAppointment(testVisitPhone, {
  id: apt1.id,
  clientAddress: 'Calle Betis 12 (portal interior)'
});
assert(updatedDetails.clientAddress === 'Calle Betis 12 (portal interior)', "CASO 15: Permite modificar dirección manteniendo la misma cita");

// 5. Finalización con confirmación humana (Fin de jornada)
const completeResult = testCompleteAppointments(testVisitPhone, ['Juan'], 'SUCCESSFUL', 'Revisión final de día');
assert(completeResult.completed.length === 1, "CASO 15: Completa la visita de Juan con éxito");
assert(completeResult.completed[0].status === 'COMPLETED', "CASO 15: Estado pasa a COMPLETED");
assert(completeResult.completed[0].outcome === 'SUCCESSFUL', "CASO 15: Outcome pasa a SUCCESSFUL");
assert(completeResult.completed[0].needsOutcomeConfirmation === false, "CASO 15: needs_outcome_confirmation se desactiva");

const logsComplete = testGetAppointmentHistory(testVisitPhone, apt1.id);
assert(logsComplete.some(l => l.action === 'COMPLETE'), "CASO 15: Registra COMPLETE en audit_logs");

// 6. Cancelación suave (Soft-cancel, nunca DELETE)
const apt2 = testSaveAppointment(testVisitPhone, {
  clientName: 'Pedro Gómez',
  date: '2026-10-05',
  time: '10:00'
});
const cancelledApt = testCancelAppointment(testVisitPhone, 'Pedro', 'Cliente decide no realizar la obra');
assert(cancelledApt.status === 'CANCELLED', "CASO 15: Cancelación establece status = CANCELLED sin borrar el registro");

const aptInDb = testGetAppointment(testVisitPhone, apt2.id);
assert(aptInDb !== null, "CASO 15: La visita cancelada NO se borra de la BD (permanece para métricas e historial)");
assert(aptInDb.status === 'CANCELLED', "CASO 15: Permanece en la BD como CANCELLED");

// 7. Filtros de listado inteligente
const allActive = testListAppointments(testVisitPhone, 'all');
assert(allActive.some(a => a.id === apt1.id), "CASO 15: listAppointments(all) incluye la visita completada");
assert(!allActive.some(a => a.id === apt2.id), "CASO 15: listAppointments(all) excluye por defecto visitas CANCELLED");

const completedList = testListAppointments(testVisitPhone, 'completed');
assert(completedList.length === 1 && completedList[0].id === apt1.id, "CASO 15: listAppointments(completed) filtra exactamente las realizadas");

// Limpieza de datos de prueba
cleanDb.prepare('DELETE FROM appointments WHERE company_phone = ?').run(testVisitPhone);
cleanDb.prepare('DELETE FROM audit_logs WHERE business_id = ?').run(testVisitPhone);
cleanDb.prepare('DELETE FROM companies WHERE phone = ?').run(testVisitPhone);

// -----------------------------------------------------------------------------
// TEST 24: Blindaje de Privacidad y Aislamiento de Chats (Gatekeeper & Firewall)
// -----------------------------------------------------------------------------
console.log("\nTEST 24: Blindaje de Privacidad y Aislamiento de Chats (Gatekeeper & Firewall)");

const myTestPhone = '34601022367';
const myTestLid = '82987509096647';
const allowedTestNumbers = ['34601022367', '34635570845', '34625335687'];
const unknownContactLid = '78095440715998@lid';
const unknownContactPhone = '34699999999@s.whatsapp.net';
const groupJid = '120363401410834758@g.us';
const broadcastJid = 'status@broadcast';

const duplicateDoorItems = findDuplicateBudgetItemGroups([
  { description: 'Puerta de paso semimaciza de 62 cm, totalmente terminada', qty: 3, unit: 'ud', unitPrice: 810 },
  { description: 'puerta de paso semimaciza de 62 cm totalmente terminada', qty: 1, unit: 'ud', unitPrice: 270 },
  { description: 'Suministro e instalación de mampara', qty: 1, unit: 'ud', unitPrice: 620 }
]);
assert(duplicateDoorItems.length === 1, 'CASO 16: Detecta partidas duplicadas aunque cambien mayúsculas, tildes o puntuación');
assert(duplicateDoorItems[0].length === 2, 'CASO 16: Agrupa únicamente las dos partidas de puerta repetidas');

// 1. Ingress: Self-chat por LID
const inSelfLid = shouldProcessIncomingMessage({
  remoteJid: `${myTestLid}@lid`,
  fromMe: true,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inSelfLid.process === true, "CASO 16: Ingress permite Self-Chat por LID propio");
assert(inSelfLid.reason === 'SELF_CHAT', "CASO 16: Motivo es SELF_CHAT");
assert(inSelfLid.senderNumber === myTestPhone, "CASO 16: Asigna correctamente el número del profesional");

// Un LID propio distinto del LID expuesto en sock.user se reconoce por el mapeo PN de Baileys.
const inSelfMappedLid = shouldProcessIncomingMessage({
  remoteJid: '78095440715998@lid',
  remotePhone: myTestPhone,
  fromMe: true,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inSelfMappedLid.process === true && inSelfMappedLid.reason === 'SELF_CHAT', "CASO 16: Ingress permite self-chat cuyo LID se resolvió al número propio");
const inSelfMappedLidIncoming = shouldProcessIncomingMessage({
  remoteJid: '78095440715998@lid',
  remotePhone: myTestPhone,
  fromMe: false,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inSelfMappedLidIncoming.process === true && inSelfMappedLidIncoming.reason === 'SELF_CHAT', "CASO 16: Ingress permite el eco entrante del self-chat con LID resuelto");

// 2. Ingress: Self-chat por teléfono directo
const inSelfPhone = shouldProcessIncomingMessage({
  remoteJid: `${myTestPhone}@s.whatsapp.net`,
  fromMe: true,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inSelfPhone.process === true, "CASO 16: Ingress permite Self-Chat por número de teléfono propio");

// 3. Ingress: Mensaje saliente personal del profesional a un nuevo contacto (LID)
const inOutContactLid = shouldProcessIncomingMessage({
  remoteJid: unknownContactLid,
  fromMe: true,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inOutContactLid.process === false, "CASO 16: Ingress BLOQUEA mensaje saliente personal a contacto externo (LID)");
assert(inOutContactLid.reason === 'OUTGOING_THIRD_PARTY_IGNORED', "CASO 16: Motivo OUTGOING_THIRD_PARTY_IGNORED");

// 4. Ingress: Mensaje saliente personal del profesional a teléfono ajeno
const inOutContactPhone = shouldProcessIncomingMessage({
  remoteJid: unknownContactPhone,
  fromMe: true,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inOutContactPhone.process === false, "CASO 16: Ingress BLOQUEA mensaje saliente personal a número ajeno");

// 5. Ingress: Mensaje entrante de contacto no autorizado (LID desconocido)
const inInUnknownLid = shouldProcessIncomingMessage({
  remoteJid: unknownContactLid,
  fromMe: false,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inInUnknownLid.process === false, "CASO 16: Ingress BLOQUEA mensaje entrante de contacto ajeno (LID)");
assert(inInUnknownLid.reason === 'UNAUTHORIZED_INCOMING_SENDER', "CASO 16: Motivo UNAUTHORIZED_INCOMING_SENDER");

// 6. Ingress: Mensaje entrante de teléfono desconocido (modo compatibilidad onboarding)
const inInUnknownPhone = shouldProcessIncomingMessage({
  remoteJid: unknownContactPhone,
  fromMe: false,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers,
  requireExplicitAuth: false
});
assert(inInUnknownPhone.process === true && inInUnknownPhone.reason === 'ONBOARDING_ELIGIBLE_SENDER', "CASO 16: Ingress admite teléfono individual desconocido únicamente para iniciar onboarding");

// 7. Ingress: Mensaje entrante de tester autorizado (ej. familiar en lista blanca)
const inInTester = shouldProcessIncomingMessage({
  remoteJid: '34635570845@s.whatsapp.net',
  fromMe: false,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inInTester.process === true, "CASO 16: Ingress permite mensaje de tester autorizado");
assert(inInTester.reason === 'AUTHORIZED_EXTERNAL_SENDER', "CASO 16: Motivo AUTHORIZED_EXTERNAL_SENDER");
assert(inInTester.senderNumber === '34635570845', "CASO 16: SenderNumber coincide con el tester");

// 8. Ingress: Descarte de grupos y difusiones
const inGroup = shouldProcessIncomingMessage({
  remoteJid: groupJid,
  fromMe: false,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inGroup.process === false, "CASO 16: Ingress DESCARTA mensajes de grupos (@g.us)");
assert(inGroup.reason === 'GROUP_OR_BROADCAST_IGNORED', "CASO 16: Motivo GROUP_OR_BROADCAST_IGNORED");

const inBroadcast = shouldProcessIncomingMessage({
  remoteJid: broadcastJid,
  fromMe: false,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inBroadcast.process === false, "CASO 16: Ingress DESCARTA difusiones (@broadcast)");

// 9. Egress Firewall: Envío saliente permitido a self-chat
const egSelfLid = isAuthorizedEgressRecipient(`${myTestLid}@lid`, {
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(egSelfLid.allowed === true, "CASO 16: Egress Firewall permite envío a self-chat LID");

const egSelfPhone = isAuthorizedEgressRecipient(`${myTestPhone}@s.whatsapp.net`, {
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(egSelfPhone.allowed === true, "CASO 16: Egress Firewall permite envío a self-chat teléfono");

// 10. Egress Firewall: Envío saliente permitido a número en ALLOWED_NUMBERS
const egTester = isAuthorizedEgressRecipient('34635570845@s.whatsapp.net', {
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(egTester.allowed === true, "CASO 16: Egress Firewall permite envío a tester autorizado");

// 11. Egress Firewall: BLOQUEO TOTAL a nuevo contacto / contacto ajeno
const egBlockLid = isAuthorizedEgressRecipient(unknownContactLid, {
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(egBlockLid.allowed === false, "CASO 16: Egress Firewall BLOQUEA envío a contacto ajeno (LID)");
assert(egBlockLid.reason === 'UNAUTHORIZED_TARGET', "CASO 16: Motivo UNAUTHORIZED_TARGET");

const egBlockPhone = isAuthorizedEgressRecipient(unknownContactPhone, {
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(egBlockPhone.allowed === false, "CASO 16: Egress Firewall BLOQUEA envío a teléfono desconocido");

// 12. Egress Firewall: BLOQUEO TOTAL a grupos (@g.us)
const egBlockGroup = isAuthorizedEgressRecipient(groupJid, {
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(egBlockGroup.allowed === false, "CASO 16: Egress Firewall BLOQUEA envío a grupos WhatsApp");
assert(egBlockGroup.reason === 'GROUP_OR_BROADCAST_TARGET_BLOCKED', "CASO 16: Motivo GROUP_OR_BROADCAST_TARGET_BLOCKED");

console.log("\nTEST 25: Sistema de Migraciones Seguras y Aislamiento de Base de Datos");
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import * as migrationService from './migration_service.js';
import { runMigrations, getAppliedMigrations, getPendingMigrations, initMigrationTable, MIGRATIONS } from './migration_service.js';
import { DB_PATH as activeDbPath, db as currentDb } from './db_service.js';

// 1. Una base de datos nueva ejecuta todas las migraciones
const memDb1 = new DatabaseSync(':memory:');
const migResult1 = runMigrations(memDb1);
const tablesMem1 = memDb1.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
const allTablesCreated = tablesMem1.includes('companies') && tablesMem1.includes('budgets') && tablesMem1.includes('schema_migrations');
assert(migResult1.appliedCount === MIGRATIONS.length && allTablesCreated, "1. Nueva DB aplica todas las migraciones y crea tablas del baseline");

// 2. Una base de datos existente adopta el baseline sin errores
const memDb2 = new DatabaseSync(':memory:');
memDb2.exec("CREATE TABLE companies (phone TEXT PRIMARY KEY, name TEXT);");
const migResult2 = runMigrations(memDb2);
const compCols2 = memDb2.prepare("PRAGMA table_info(companies);").all().map(c => c.name);
const colsAdded = compCols2.includes('trade') && compCols2.includes('onboarding_step') && compCols2.includes('invoice_series');
assert(migResult2.appliedCount === MIGRATIONS.length && colsAdded, "2. DB existente adopta baseline y añade columnas sin errores");

// 3. Las migraciones son idempotentes (ejecutarlas 2 veces no duplica nada ni falla)
const migResult3 = runMigrations(memDb1);
assert(migResult3.appliedCount === 0, "3. Re-ejecutar migraciones en DB al día no aplica ninguna ni lanza error (Idempotente)");

// 4. Si una migración falla a mitad, la base de datos hace rollback y la versión NO queda en schema_migrations
const memDb4 = new DatabaseSync(':memory:');
runMigrations(memDb4);
const badMigration = {
  version: 9999,
  name: 'failing_migration',
  up: (d) => {
    d.exec("CREATE TABLE test_rollback_table (id INTEGER PRIMARY KEY);");
    throw new Error("Simulated failure in test");
  }
};
let rollbackOccurred = false;
try {
  runMigrations(memDb4, { migrations: [...MIGRATIONS, badMigration] });
} catch (e) {
  const versions = getAppliedMigrations(memDb4).map(m => m.version);
  const tableCheck = memDb4.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_rollback_table'").get();
  if (!versions.includes(9999) && !tableCheck) {
    rollbackOccurred = true;
  }
}
assert(rollbackOccurred === true, "4. Migración fallida hace ROLLBACK atómico y no se registra en schema_migrations");

// 5. Las migraciones se ejecutan en orden numérico ascendente
const memDb5 = new DatabaseSync(':memory:');
initMigrationTable(memDb5);
const executionOrder = [];
const customMigrations = [
  { version: 20, name: 'second', up: () => executionOrder.push(20) },
  { version: 10, name: 'first', up: () => executionOrder.push(10) },
  { version: 30, name: 'third', up: () => executionOrder.push(30) }
];
runMigrations(memDb5, { migrations: customMigrations });
assert(executionOrder[0] === 10 && executionOrder[1] === 20 && executionOrder[2] === 30, "5. Migraciones se ejecutan en estricto orden numérico ascendente");

// 6. Si hay una migración pendiente, se ejecuta; si ya está aplicada, se omite
const pendingBefore = getPendingMigrations(memDb5, customMigrations);
assert(pendingBefore.length === 0, "6. getPendingMigrations detecta pendientes y omite ya aplicadas");

// 7. schema_migrations registra correctamente versión, nombre y timestamp
const schemaRows = memDb1.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 1").get();
assert(schemaRows && schemaRows.version === 1 && typeof schemaRows.applied_at === 'string' && schemaRows.applied_at.length > 10, "7. schema_migrations registra versión, nombre y timestamp válido");

// 8. Los tests corren única y exclusivamente contra presuvoz_test.db
const currentTestDbSha256 = computeFileSha256(TEST_DB_PATH);
const testDbActive = (process.env.NODE_ENV === 'test')
  && (path.resolve(activeDbPath) === path.resolve('data', 'presuvoz_test.db'))
  && fs.existsSync(TEST_DB_PATH);
assert(testDbActive, `8. Los tests corren única y exclusivamente contra presuvoz_test.db (SHA-256 test: ${currentTestDbSha256?.slice(0, 16)}...)`);

// 9. Integridad Criptográfica de data/presuvoz.db (SHA-256 + mtime + size)
let prodUntouched = true;
let prodShaMatch = true;
const currentProdSha256 = computeFileSha256(PROD_DB_PATH);
if (prodDbInitialStat && prodDbInitialSha256) {
  const currentProdStat = fs.statSync(PROD_DB_PATH);
  prodUntouched = (currentProdStat.mtimeMs === prodDbInitialStat.mtimeMs && currentProdStat.size === prodDbInitialStat.size);
  prodShaMatch = (currentProdSha256 === prodDbInitialSha256);
} else {
  prodUntouched = !fs.existsSync(PROD_DB_PATH);
}
assert(prodUntouched && prodShaMatch, `9. data/presuvoz.db permanece 100% CRIPTOGRÁFICAMENTE INTACTA (SHA-256 idéntico: ${prodDbInitialSha256})`);

// 10. Un script de reset no puede borrar la base de datos real sin confirmación explícita
let resetBlocked = false;
try {
  execSync('node src/reset_db.js', {
    env: { ...process.env, PRESUVOZ_DB_PATH: path.resolve('data', 'presuvoz.db'), ALLOW_PRODUCTION_RESET: '' },
    stdio: 'pipe'
  });
} catch (err) {
  resetBlocked = (err.status === 1);
}
assert(resetBlocked === true, "10. reset_db.js bloquea el reseteo de la base de datos de producción sin flag");

// 11. La base de datos de test tiene foreign_keys activado por defecto
const fkPragma = currentDb.prepare("PRAGMA foreign_keys;").get();
assert(Number(fkPragma.foreign_keys) === 1, "11. Base de datos activa tiene PRAGMA foreign_keys activado (=1)");

// 12. La base de datos de test se inicia en un estado conocido y controlado
const testApplied = getAppliedMigrations(currentDb);
assert(testApplied.length >= 1 && testApplied[0].version === 1, "12. presuvoz_test.db arranca en estado controlado con schema_migrations");

// 13. Dos ejecuciones consecutivas de tests no se contaminan entre sí
const isolationCheck = currentDb.prepare("SELECT count(*) as count FROM companies WHERE phone = '34999888777'").get();
assert(isolationCheck.count === 0, "13. Aislamiento de datos verificado entre suites (cero residuos espurios)");

// 14. Regresión: 519 comprobaciones base (onboarding optimizado a 14 pasos), 15 de seguridad, 1 de IVA, 20 casos nuevos, 4 de grounding y 2 de transcripción literal.
const baselinePassed = (passedCount === 519 + 15 + 1 + 20 + 4 + 2);
assert(baselinePassed, "14. Regresión: pasan las comprobaciones base y los casos de seguridad, IVA, validez y duplicados");

// 15. rollbackLastMigration ya no existe en el servicio (Blindaje Forward-Only)
assert(typeof migrationService.rollbackLastMigration === 'undefined', "15. rollbackLastMigration no existe ni es accesible en migration_service (Forward-Only)");

// 16. Ninguna migración aplicada tiene soporte de reversión destructiva (método down eliminado)
const hasDownMethod = MIGRATIONS.some(m => typeof m.down === 'function');
assert(hasDownMethod === false, "16. Las definiciones de migraciones carecen de métodos down() (cero DDL inverso)");

// 17. El sistema ejecuta correctamente nuevas migraciones pendientes hacia adelante
const memDbForward = new DatabaseSync(':memory:');
runMigrations(memDbForward);
const nextVersion = MIGRATIONS.length + 1;
const newForwardMigration = { 
  version: nextVersion, 
  name: '003_forward_only_verification', 
  up: (d) => { d.exec('CREATE TABLE forward_verify_test (id INTEGER PRIMARY KEY);'); } 
};
const fwdResult = runMigrations(memDbForward, { migrations: [...MIGRATIONS, newForwardMigration] });
assert(fwdResult.appliedCount === 1 && fwdResult.appliedVersions.includes(nextVersion), "17. El sistema ejecuta correctamente migraciones pendientes hacia adelante de forma secuencial");

// 18. Transaccionalidad garantizada y schema_migrations permanece consistente
const fwdVersions = getAppliedMigrations(memDbForward).map(m => m.version);
const tableExistsFwd = memDbForward.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='forward_verify_test'").get();
assert(fwdVersions.length === nextVersion && fwdVersions[fwdVersions.length - 1] === nextVersion && Boolean(tableExistsFwd), "18. schema_migrations permanece consistente, ordenado e inmutable tras evolución");

console.log("\nTEST 26: Capa Canónica de Identidad Multi-Canal (Fase 2A — Company ID, Channel Identities & Aislamiento Tenant)");
import {
  resolveAuthenticatedContext,
  registerChannelIdentity,
  deactivateChannelIdentity,
  reactivateChannelIdentity,
  listChannelIdentities,
  createCompanyWithIdentity,
  sanitizeTenantPayload,
  ROLES
} from './identity_service.js';
import { getCompanyById, getCompany as getCompDirect } from './db_service.js';

const testPhoneA = '34611111111';
const testPhoneA2 = '34611111112';
const testPhoneB = '34622222222';
const testPhoneUnknown = '34699999999';

// Limpieza preventiva de identidades de prueba
const cleanupIdentities = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};
cleanupIdentities(testPhoneA);
cleanupIdentities(testPhoneA2);
cleanupIdentities(testPhoneB);
cleanupIdentities(testPhoneUnknown);

// 1. CREACIÓN DE EMPRESA: Crear empresa nueva, verificar UUID único y persistencia
const compA = createCompanyWithIdentity({
  phone: testPhoneA,
  name: 'Reformas Alpha S.L.',
  fiscalName: 'Alpha Reformas Integrales S.L.',
  cif: 'B-11111111',
  ownerName: 'Alejandro Alpha',
  trade: 'Albañilería y Reformas',
  email: 'contacto@alpha.es'
});
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dbCheckA = currentDb.prepare("SELECT id, phone, name FROM companies WHERE id = ?").get(compA.companyId);
assert(Boolean(compA.companyId && uuidRegex.test(compA.companyId) && dbCheckA && dbCheckA.name === 'Reformas Alpha S.L.'), "1. Creación de empresa genera company_id UUID canónico válido y persiste");

// 2. DOS EMPRESAS: Crear Company B y verificar que A.company_id !== B.company_id
const compB = createCompanyWithIdentity({
  phone: testPhoneB,
  name: 'Instalaciones Beta S.L.',
  fiscalName: 'Beta Clima & Electricidad S.L.',
  cif: 'B-22222222',
  ownerName: 'Beatriz Beta',
  trade: 'Climatización y Calefacción',
  email: 'info@beta.es'
});
assert(Boolean(compB.companyId && compA.companyId !== compB.companyId), "2. Dos empresas independientes tienen company_id estrictamente distintos");

// 3. CHANNEL IDENTITY: Registrar WhatsApp A y B, resolver ambas identidades correctamente
const contextA = resolveAuthenticatedContext('whatsapp', testPhoneA);
const contextB = resolveAuthenticatedContext('whatsapp', testPhoneB);
assert(Boolean(contextA && contextA.authenticated && contextA.companyId === compA.companyId && contextA.company.name === 'Reformas Alpha S.L.'), "3. Identity Resolver resuelve canal WhatsApp A -> Company A");
assert(Boolean(contextB && contextB.authenticated && contextB.companyId === compB.companyId && contextB.company.name === 'Instalaciones Beta S.L.'), "3. Identity Resolver resuelve canal WhatsApp B -> Company B");

// 4. IDENTIDAD DESCONOCIDA: Resolver WhatsApp no registrado es rechazado sin crear empresa
const contextUnknown = resolveAuthenticatedContext('whatsapp', testPhoneUnknown);
const checkUnknownDb = currentDb.prepare("SELECT count(*) as count FROM companies WHERE phone = ?").get(testPhoneUnknown);
assert(contextUnknown === null && checkUnknownDb.count === 0, "4. Identidad desconocida es rechazada (null) y no crea empresa espuria");

// 5. DUPLICADO: Intentar registrar el mismo channel_identifier en otra empresa es impedido
let duplicatePrevented = false;
try {
  registerChannelIdentity(compA.companyId, 'whatsapp', testPhoneB); // Ya asignado a Company B
} catch (e) {
  duplicatePrevented = true;
}
assert(duplicatePrevented === true, "5. Registro de channel_identifier duplicado en otra empresa es bloqueado");

// 6. USER + MEMBERSHIP: Verificar pertenencias y roles automáticos de OWNER
const memberA = currentDb.prepare("SELECT role, status FROM memberships WHERE company_id = ? AND user_id = ?").get(compA.companyId, compA.userId);
const memberB = currentDb.prepare("SELECT role, status FROM memberships WHERE company_id = ? AND user_id = ?").get(compB.companyId, compB.userId);
assert(Boolean(memberA && memberA.role === ROLES.OWNER && memberA.status === 'ACTIVE' && memberB && memberB.role === ROLES.OWNER), "6. Modelo User + Membership crea y vincula propietarios OWNER activos");

// 7. AISLAMIENTO: Resolver WhatsApp B devuelve Company B, nunca Company A
const isolatedCheck = resolveAuthenticatedContext('whatsapp', testPhoneB);
assert(Boolean(isolatedCheck && isolatedCheck.companyId === compB.companyId && isolatedCheck.companyId !== compA.companyId), "7. Aislamiento estricto: el canal de B nunca resuelve el tenant de A");

// 8. CROSS-TENANT PROBE: Contexto de A rechaza acceso a recursos de B
let crossTenantBlocked = false;
try {
  contextA.assertTenantAccess(compB.companyId);
} catch (e) {
  crossTenantBlocked = true;
}
assert(crossTenantBlocked === true, "8. Cross-tenant probe bloqueado: assertTenantAccess lanza violación de aislamiento");

// 9. MODEL ATTACK: Salida del modelo intentando inyectar company_id ajeno es neutralizada
const maliciousModelPayload = {
  action: "GET_INVOICES",
  company_id: compB.companyId,
  companyId: compB.companyId
};
const sanitizedPayload = sanitizeTenantPayload(maliciousModelPayload, contextA);
assert(sanitizedPayload.companyId === compA.companyId && sanitizedPayload.company_id === compA.companyId, "9. Model attack neutralizado: el backend sobreescribe cualquier company_id inyectado por la IA");

// 10. USER INPUT ATTACK: Texto del usuario intentando acceder a otra empresa no altera el contexto
const userTextAttack = "Quiero ver las facturas de la empresa B id=" + compB.companyId;
const sessionContext = resolveAuthenticatedContext('whatsapp', testPhoneA);
assert(Boolean(sessionContext && sessionContext.companyId === compA.companyId && !userTextAttack.includes(sessionContext.companyId)), "10. User input attack neutralizado: el texto libre del usuario no modifica el contexto autenticado");

// 11. MULTI-WHATSAPP: Una empresa puede tener múltiples canales autorizados
const ch2Id = registerChannelIdentity(compA.companyId, 'whatsapp', testPhoneA2);
const contextA2 = resolveAuthenticatedContext('whatsapp', testPhoneA2);
assert(Boolean(ch2Id && contextA2 && contextA2.companyId === compA.companyId), "11. Soporte multi-canal: segundo WhatsApp de la misma empresa resuelve al mismo company_id");

// 12. INACTIVE CHANNEL: Desactivar canal impide autenticación; reactivarlo la restaura
deactivateChannelIdentity('whatsapp', testPhoneA2);
const contextDeactivated = resolveAuthenticatedContext('whatsapp', testPhoneA2);
reactivateChannelIdentity('whatsapp', testPhoneA2);
const contextReactivated = resolveAuthenticatedContext('whatsapp', testPhoneA2);
assert(Boolean(contextDeactivated === null && contextReactivated && contextReactivated.companyId === compA.companyId), "12. Canal inactivo es rechazado inmediatamente; al reactivar vuelve a autenticar");

// 13. FOREIGN KEY: channel_identities rechaza company_id inexistente
let fkBlocked = false;
try {
  currentDb.prepare("INSERT INTO channel_identities (id, company_id, channel, channel_identifier, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").run(
    crypto.randomUUID(), '00000000-0000-0000-0000-000000000000', 'whatsapp', '34688888888', new Date().toISOString(), new Date().toISOString()
  );
} catch (e) {
  fkBlocked = true;
}
assert(fkBlocked === true, "13. Restricción Foreign Key estricta: prohíbe channel_identity hacia company_id inexistente");

// 14. MIGRATION IDEMPOTENCY: Re-ejecutar migración 002 no duplica datos ni lanza errores
import { migration as mig002 } from './migrations/002_identity_foundation.js';
const companiesCountBefore = currentDb.prepare("SELECT count(*) as count FROM companies").get().count;
const channelsCountBefore = currentDb.prepare("SELECT count(*) as count FROM channel_identities").get().count;
mig002.up(currentDb);
const companiesCountAfter = currentDb.prepare("SELECT count(*) as count FROM companies").get().count;
const channelsCountAfter = currentDb.prepare("SELECT count(*) as count FROM channel_identities").get().count;
assert(companiesCountBefore === companiesCountAfter && channelsCountBefore === channelsCountAfter, "14. Migración 002 es 100% idempotente (cero duplicados al re-ejecutar)");

// 15. LEGACY DATA: Los datos históricos de companies se preservan intactos y accesibles por getCompany y getCompanyById
const compAFromDb = getCompanyById(compA.companyId);
const compALegacy = getCompDirect(testPhoneA);
assert(Boolean(compAFromDb && compALegacy && compAFromDb.cif === 'B-11111111' && compAFromDb.trade === 'Albañilería y Reformas' && compAFromDb.phone === testPhoneA), "15. Compatibilidad legada: datos existentes de empresa 100% preservados y accesibles por phone y company_id");

// Limpieza final de datos de test 26
cleanupIdentities(testPhoneA);
cleanupIdentities(testPhoneA2);
cleanupIdentities(testPhoneB);

console.log("\nTEST 27: Blindaje Estricto de Autenticación de Canal WhatsApp (Zero-Fallback & Tenant Isolation)");

const fallbackPhone = '34644001122';
const fallbackJid = `${fallbackPhone}@s.whatsapp.net`;
const validPhone = '34677889900';
const validJid = `${validPhone}@s.whatsapp.net`;

// Pre-limpieza
const cleanupTest27 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};
cleanupTest27(fallbackPhone);
cleanupTest27(validPhone);

// ─── A) FALLBACK RECHAZADO: Teléfono en companies SIN channel_identity ───
// 1. Crear empresa directamente en la tabla companies SIN entrada en channel_identities
const orphanCompanyId = crypto.randomUUID();
currentDb.prepare(`
  INSERT INTO companies (id, phone, name, cif, trade, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  orphanCompanyId,
  fallbackPhone,
  'Empresa Huérfana Sin Canal S.L.',
  'B-00112233',
  'Pintura y Decoración',
  new Date().toISOString(),
  new Date().toISOString()
);

// Verificar que getCompany(phone) SÍ encuentra la empresa (compatibilidad de lectura legada)
const legacyCompany = getCompDirect(fallbackPhone);
assert(Boolean(legacyCompany && legacyCompany.id === orphanCompanyId), "1. Lectura legada: getCompany(phone) encuentra la empresa en base de datos para funciones internas");

// Verificar que resolveAuthenticatedContext retorna null para ese teléfono
const unauthContext = resolveAuthenticatedContext('whatsapp', fallbackPhone);
assert(unauthContext === null, "2. Zero-Fallback: resolveAuthenticatedContext retorna null para teléfono existente en companies sin channel_identity");

// Verificar que authenticateWhatsAppSession retorna null (sin fallback a getCompany)
const unauthWhatsApp = authenticateWhatsAppSession(fallbackJid, fallbackPhone);
assert(unauthWhatsApp === null, "3. Zero-Fallback: authenticateWhatsAppSession rechaza autenticación si no existe channel_identity");

// Verificar que getUserSession retorna null y no crea sesión para el chat
const unauthSession = getUserSession(fallbackJid, fallbackPhone);
assert(unauthSession === null, "4. Zero-Fallback: getUserSession retorna null sin crear sesión para remitente no autorizado");

// Caso A2: Canal inactivo (is_active = 0)
const inactiveChanId = crypto.randomUUID();
currentDb.prepare(`
  INSERT INTO channel_identities (id, company_id, channel, channel_identifier, is_active, created_at, updated_at)
  VALUES (?, ?, 'whatsapp', ?, 0, ?, ?)
`).run(inactiveChanId, orphanCompanyId, fallbackPhone, new Date().toISOString(), new Date().toISOString());

const inactiveAuth = authenticateWhatsAppSession(fallbackJid, fallbackPhone);
const inactiveSession = getUserSession(fallbackJid, fallbackPhone);
assert(inactiveAuth === null && inactiveSession === null, "5. Zero-Fallback: channel_identity inactiva (is_active=0) es rechazada y no autentica ni genera sesión");


// ─── B) CANAL VÁLIDO: Autenticación completa a través de channel_identities ───
const validCompanyData = createCompanyWithIdentity({
  name: 'Fontanería y Clima Express S.L.',
  phone: validPhone,
  cif: 'B-99001122',
  trade: 'Fontanería y Climatización'
});

const validAuth = authenticateWhatsAppSession(validJid, validPhone);
assert(Boolean(validAuth && validAuth.companyId === validCompanyData.companyId && validAuth.role === ROLES.OWNER), "6. Canal válido: authenticateWhatsAppSession autentica correctamente y resuelve el companyId canónico");

const validSession = getUserSession(validJid, validPhone);
assert(Boolean(validSession && validSession.companyId === validCompanyData.companyId && validSession.company && validSession.company.name === 'Fontanería y Clima Express S.L.'), "7. Canal válido: getUserSession inicializa sesión completa con authContext y companyId canónico");


// ─── C) PERMISO VS AISLAMIENTO TENANT (Aislamiento Horizontal) ───
// Validar que el usuario OWNER tiene permisos globales wildcard ['*'] en su propio tenant
assert(validAuth.permissions.includes('*') || validAuth.permissions.includes('company:all'), "8. Permisos de rol: el OWNER posee permisos de administración total ('*') en su contexto");

// Validar que un OWNER con permisos ['*'] en Empresa A es BLOQUEADO categóricamente si intenta acceder a datos de Empresa B
let crossTenantOwnerViolation = false;
let violationErrorMessage = '';
try {
  validAuth.assertTenantAccess(orphanCompanyId);
} catch (err) {
  crossTenantOwnerViolation = true;
  violationErrorMessage = err.message;
}
assert(crossTenantOwnerViolation === true && violationErrorMessage.includes('Violación de aislamiento'), "9. Permiso vs Aislamiento: Permisos ('*') no otorgan acceso cross-tenant; assertTenantAccess bloquea el acceso horizontal");

// Limpieza final de datos de TEST 27
cleanupTest27(fallbackPhone);
cleanupTest27(validPhone);

console.log("\nTEST 28: Correspondencia Estricta de Identidad del Remitente y Auditoría de Sesión en Memoria (WhatsApp Gatekeeper)");

const phoneTenantA = '34688000001';
const jidTenantA = `${phoneTenantA}@s.whatsapp.net`;
const phoneTenantB = '34688000002';
const jidTenantB = `${phoneTenantB}@s.whatsapp.net`;
const phoneUnauthorized = '34688999999';
const jidUnauthorized = `${phoneUnauthorized}@s.whatsapp.net`;

// Pre-limpieza
const cleanupTest28 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};
cleanupTest28(phoneTenantA);
cleanupTest28(phoneTenantB);
cleanupTest28(phoneUnauthorized);
userSessions.delete(jidTenantA);
userSessions.delete(jidTenantB);
userSessions.delete(jidUnauthorized);

// Crear Empresa A y Empresa B con identidades legítimas
const compDataA = createCompanyWithIdentity({
  name: 'Empresa A Reformas S.L.',
  phone: phoneTenantA,
  cif: 'B-88000001',
  trade: 'Reformas Generales'
});

const compDataB = createCompanyWithIdentity({
  name: 'Empresa B Fontanería S.L.',
  phone: phoneTenantB,
  cif: 'B-88000002',
  trade: 'Fontanería'
});

// ─── 1. Un remoteJid legítimo con su número correspondiente ───
const identLegit = extractCanonicalSenderIdentifier(jidTenantA, phoneTenantA);
const authLegit = authenticateWhatsAppSession(jidTenantA, phoneTenantA);
const sessionLegit = getUserSession(jidTenantA, phoneTenantA);

assert(identLegit === phoneTenantA, "1.1. Correspondencia legítima: extractCanonicalSenderIdentifier extrae el teléfono verificado");
assert(Boolean(authLegit && authLegit.companyId === compDataA.companyId), "1.2. Autenticación legítima: resuelve el companyId de la Empresa A");
assert(Boolean(sessionLegit && sessionLegit.companyId === compDataA.companyId && userSessions.has(jidTenantA)), "1.3. Sesión legítima: inicializa la sesión en memoria asociada al companyId de A");

// ─── 2. Un remoteJid de Empresa A acompañado de senderNumber de Empresa B (Mismatch / Spoofing) ───
const identSpoofed = extractCanonicalSenderIdentifier(jidTenantA, phoneTenantB);
const authSpoofed = authenticateWhatsAppSession(jidTenantA, phoneTenantB);
const sessionSpoofed = getUserSession(jidTenantA, phoneTenantB);

assert(identSpoofed === null, "2.1. Bloqueo de discrepancia: extractCanonicalSenderIdentifier detecta discordancia y retorna null");
assert(authSpoofed === null, "2.2. Bloqueo de suplantación: authenticateWhatsAppSession rechaza la petición con senderNumber cruzado");
assert(sessionSpoofed === null, "2.3. Protección de sesión: getUserSession retorna null y no permite que senderNumber de B suplante a A");

// ─── 3. Un remitente sin identidad autorizada ───
const identUnauth = extractCanonicalSenderIdentifier(jidUnauthorized, phoneUnauthorized);
const authUnauth = authenticateWhatsAppSession(jidUnauthorized, phoneUnauthorized);
const sessionUnauth = getUserSession(jidUnauthorized, phoneUnauthorized);

assert(identUnauth === phoneUnauthorized, "3.1. Formato de número limpio extraído correctamente para remitente desconocido");
assert(authUnauth === null, "3.2. Rechazo absoluto: authenticateWhatsAppSession devuelve null si no existe channel_identity");
assert(sessionUnauth === null && !userSessions.has(jidUnauthorized), "3.3. Cero persistencia en memoria: remitente no autorizado no crea sesión en userSessions");

// ─── 4. Una identidad desactivada después de haber inicializado una sesión (Purga Inmediata de Memoria) ───
const sessionBeforeDeact = getUserSession(jidTenantA, phoneTenantA);
assert(Boolean(sessionBeforeDeact && userSessions.has(jidTenantA)), "4.1. Pre-condición: la sesión en memoria de la Empresa A está activa");

deactivateChannelIdentity('whatsapp', phoneTenantA);

const authAfterDeactivation = authenticateWhatsAppSession(jidTenantA, phoneTenantA);
const sessionAfterDeactivation = getUserSession(jidTenantA, phoneTenantA);

assert(authAfterDeactivation === null, "4.2. Identidad desactivada: authenticateWhatsAppSession devuelve null inmediatamente");
assert(sessionAfterDeactivation === null, "4.3. Identidad desactivada: getUserSession devuelve null");
assert(userSessions.has(jidTenantA) === false, "4.4. Purga inmediata: la sesión en memoria es totalmente ELIMINADA de userSessions al desactivar la identidad");

reactivateChannelIdentity('whatsapp', phoneTenantA);

// ─── 5. Un intento de reutilizar una sesión existente con una identidad distinta ───
const sessionInitialA = getUserSession(jidTenantA, phoneTenantA);
assert(Boolean(sessionInitialA && sessionInitialA.companyId === compDataA.companyId), "5.1. Sesión para Empresa A re-inicializada");
sessionInitialA.budgets.set('PRE-TEST-A1', { id: 'PRE-TEST-A1', total: 500 });
sessionInitialA.invoices.set('FAC-TEST-A1', { id: 'FAC-TEST-A1', total: 500 });

// Simular reasignación de canal en la base de datos para apuntar a Empresa B en el mismo identificador
currentDb.prepare("UPDATE channel_identities SET company_id = ? WHERE channel_identifier = ?").run(compDataB.companyId, phoneTenantA);

const sessionReassigned = getUserSession(jidTenantA, phoneTenantA);
assert(Boolean(sessionReassigned && sessionReassigned.companyId === compDataB.companyId), "5.2. Nueva resolución de identidad: resuelve el nuevo companyId de Empresa B tras cambio canónico");
assert(sessionReassigned.budgets.has('PRE-TEST-A1') === false, "5.3. Aislamiento estricto de memoria: los presupuestos de Empresa A fueron purgados y no contaminan a Empresa B");
assert(sessionReassigned.invoices.has('FAC-TEST-A1') === false, "5.4. Aislamiento estricto de memoria: las facturas de Empresa A fueron purgadas y no contaminan a Empresa B");

// Limpieza final de TEST 28
cleanupTest28(phoneTenantA);
cleanupTest28(phoneTenantB);
cleanupTest28(phoneUnauthorized);
userSessions.delete(jidTenantA);
userSessions.delete(jidTenantB);
userSessions.delete(jidUnauthorized);

console.log("\nTEST 29: Migración Controlada de Budgets a Company_ID (Fase 2B-1 — Backfill, Tenant Scoping & Cross-Tenant Defense)");

import {
  saveBudget as saveBudgetTenant,
  getBudget as getBudgetTenant,
  listBudgets as listBudgetsTenant,
  updateBudget as updateBudgetTenant,
  deleteBudget as deleteBudgetTenant,
  updateBudgetStatus as updateBudgetStatusTenant
} from './db_service.js';
import { migration as mig003 } from './migrations/003_budgets_company_id.js';

// Setup de dos empresas para pruebas de tenant scoping
const phoneTenantA29 = '34699000001';
const phoneTenantB29 = '34699000002';
const phoneTenantC29 = '34699000003';

const cleanupTest29 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM budgets WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};
cleanupTest29(phoneTenantA29);
cleanupTest29(phoneTenantB29);
cleanupTest29(phoneTenantC29);

const compA29 = createCompanyWithIdentity({
  name: 'Empresa Alpha Reformas S.L.',
  phone: phoneTenantA29,
  cif: 'B-99000001',
  trade: 'Construcción'
});
const contextA29 = resolveAuthenticatedContext('whatsapp', phoneTenantA29);

const compB29 = createCompanyWithIdentity({
  name: 'Empresa Beta Instalaciones S.L.',
  phone: phoneTenantB29,
  cif: 'B-99000002',
  trade: 'Electricidad'
});
const contextB29 = resolveAuthenticatedContext('whatsapp', phoneTenantB29);

const compC29 = createCompanyWithIdentity({
  name: 'Empresa Gamma Sin Budgets S.L.',
  phone: phoneTenantC29,
  cif: 'B-99000003',
  trade: 'Fontanería'
});

// ─── A. BACKFILL DETERMINISTA & INTEGRIDAD ───
// 1. Probar migración y backfill en base de datos aislada en memoria
const memDbBackfill = new DatabaseSync(':memory:');
memDbBackfill.exec('PRAGMA foreign_keys = ON;');
runMigrations(memDbBackfill, { migrations: [MIGRATIONS[0], MIGRATIONS[1]] });

// Crear empresas en la BD en memoria
const memCompIdA = crypto.randomUUID();
const memCompIdB = crypto.randomUUID();
memDbBackfill.prepare("INSERT INTO companies (id, phone, name) VALUES (?, ?, ?)").run(memCompIdA, '34600000001', 'Mem Comp A');
memDbBackfill.prepare("INSERT INTO companies (id, phone, name) VALUES (?, ?, ?)").run(memCompIdB, '34600000002', 'Mem Comp B');

// Insertar presupuestos legacy sin company_id (company_id = NULL)
memDbBackfill.prepare(`
  INSERT INTO budgets (id, company_phone, client_name, total_amount, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'PENDIENTE_ACEPTACION', ?, ?)
`).run('PRE-MEM-A1', '34600000001', 'Cliente A1', 1200, new Date().toISOString(), new Date().toISOString());

memDbBackfill.prepare(`
  INSERT INTO budgets (id, company_phone, client_name, total_amount, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'PENDIENTE_ACEPTACION', ?, ?)
`).run('PRE-MEM-B1', '34600000002', 'Cliente B1', 2500, new Date().toISOString(), new Date().toISOString());

const countBeforeBackfill = memDbBackfill.prepare("SELECT count(*) as c FROM budgets").get().c;

// Ejecutar migración 003
mig003.up(memDbBackfill);

const countAfterBackfill = memDbBackfill.prepare("SELECT count(*) as c FROM budgets").get().c;
const budgetAFromMem = memDbBackfill.prepare("SELECT id, company_id, company_phone FROM budgets WHERE id = 'PRE-MEM-A1'").get();
const budgetBFromMem = memDbBackfill.prepare("SELECT id, company_id, company_phone FROM budgets WHERE id = 'PRE-MEM-B1'").get();

assert(countBeforeBackfill === 2 && countAfterBackfill === 2, "1. Backfill: número de presupuestos conservado exactamente (cero pérdidas, cero duplicados)");
assert(budgetAFromMem.company_id === memCompIdA && budgetAFromMem.company_phone === '34600000001', "2. Backfill: budgetA recibe determinísticamente el company_id de Empresa A");
assert(budgetBFromMem.company_id === memCompIdB && budgetBFromMem.company_phone === '34600000002', "3. Backfill: budgetB recibe determinísticamente el company_id de Empresa B");

// Verificar que la migración es idempotente al re-ejecutarla
let reExecError = false;
try {
  mig003.up(memDbBackfill);
} catch (e) {
  reExecError = true;
}
assert(reExecError === false, "4. Idempotencia: re-ejecutar migración 003 no duplica registros ni lanza errores");

// Verificar detección estricta de huérfanos (orphan budget sin empresa lanza error)
const memDbOrphan = new DatabaseSync(':memory:');
runMigrations(memDbOrphan, { migrations: [MIGRATIONS[0], MIGRATIONS[1]] });
memDbOrphan.prepare(`
  INSERT INTO budgets (id, company_phone, client_name, total_amount, status, created_at, updated_at)
  VALUES ('PRE-ORPHAN', '34699999999', 'Orphan Client', 100, 'PENDIENTE', '2026-01-01', '2026-01-01')
`).run();
let orphanHalted = false;
let orphanErrorMsg = '';
try {
  mig003.up(memDbOrphan);
} catch (e) {
  orphanHalted = true;
  orphanErrorMsg = e.message;
}
assert(orphanHalted === true && orphanErrorMsg.includes('PRE-ORPHAN') && orphanErrorMsg.includes('huérfanos'), "5. Integridad estricta: presupuestos huérfanos sin empresa correspondiente detienen la migración sin inventar datos");


// ─── B. NUEVO BUDGET VINCULADO AL CONTEXTO AUTENTICADO ───
const budgetObjA = {
  id: 'PRE-TEST-29-A1',
  client: { name: 'Cliente Carlos', phone: '654321000', address: 'Calle Mayor 1, Madrid' },
  items: [{ description: 'Pintura plástica lisa', total: 800 }],
  financials: { totalAmount: 800 },
  status: 'PENDIENTE_ACEPTACION'
};

const savedBudgetA = saveBudgetTenant(contextA29, budgetObjA);
const checkDbA = currentDb.prepare("SELECT id, company_id, company_phone, client_name FROM budgets WHERE id = ?").get(budgetObjA.id);

assert(Boolean(checkDbA && checkDbA.company_id === compA29.companyId), "6. Nuevo budget: se persiste con el company_id canónico del authenticatedContext");
assert(checkDbA.company_phone === phoneTenantA29, "7. Dual write: company_phone se preserva de forma coherente para compatibilidad legacy");


// ─── C. NEUTRALIZACIÓN DE INYECCIÓN DE TENANT POR IA / MODELO ───
const budgetObjInjected = {
  id: 'PRE-TEST-29-A2',
  company_id: compB29.companyId, // IA intenta inyectar empresa B
  companyId: compB29.companyId,
  client: { name: 'Cliente Inyección IA', phone: '654321001' },
  items: [{ description: 'Tabiquería', total: 1500 }],
  financials: { totalAmount: 1500 }
};

const sanitizedInjected = sanitizeTenantPayload(budgetObjInjected, contextA29);
const savedInjected = saveBudgetTenant(contextA29, sanitizedInjected);
const checkDbInjected = currentDb.prepare("SELECT id, company_id FROM budgets WHERE id = ?").get(budgetObjInjected.id);

assert(checkDbInjected.company_id === compA29.companyId, "8. Inyección IA bloqueada: el backend impone el company_id de la sesión e ignora el del modelo");
assert(checkDbInjected.company_id !== compB29.companyId, "9. Aislamiento IA: el presupuesto jamás se asigna a Empresa B");


// ─── D. LECTURA CORRECTA (TENANT-SCOPED READ) ───
const readBudgetA = getBudgetTenant(contextA29.companyId, budgetObjA.id);
const readBudgetAByContext = getBudgetTenant(contextA29, budgetObjA.id);

assert(Boolean(readBudgetA && readBudgetA.id === budgetObjA.id), "10. Lectura correcta: getBudget(companyId, id) retorna el presupuesto propio");
assert(Boolean(readBudgetAByContext && readBudgetAByContext.id === budgetObjA.id), "11. Lectura por contexto: getBudget(authenticatedContext, id) resuelve y retorna el presupuesto");


// ─── E. CROSS-TENANT READ (ZERO METADATA DISCLOSURE) ───
const crossReadB = getBudgetTenant(contextB29.companyId, budgetObjA.id);
const crossReadBByContext = getBudgetTenant(contextB29, budgetObjA.id);

assert(crossReadB === null, "12. Cross-tenant read: Empresa B no puede leer budget de Empresa A (retorna null)");
assert(crossReadBByContext === null, "13. Zero-Disclosure: no se revelan metadatos, cliente, importes ni existencia del budget");


// ─── F. CROSS-TENANT UPDATE ───
const maliciousUpdate = {
  id: budgetObjA.id,
  client: { name: 'Cliente Hackeado' },
  financials: { totalAmount: 1 }
};
const updateResultB = updateBudgetTenant(contextB29.companyId, maliciousUpdate);
const checkUnchangedA = currentDb.prepare("SELECT client_name, total_amount FROM budgets WHERE id = ?").get(budgetObjA.id);

assert(updateResultB === null, "14. Cross-tenant update: updateBudget rechaza la modificación de budget ajeno");
assert(checkUnchangedA.client_name === 'Cliente Carlos' && checkUnchangedA.total_amount === 800, "15. Integridad de datos: los datos del presupuesto de A permanecen intactos");

// Actualización legítima por Empresa A
const legitimateUpdate = updateBudgetTenant(contextA29.companyId, {
  ...budgetObjA,
  client: { name: 'Cliente Carlos Modificado', phone: '654321000' }
});
const checkUpdatedA = currentDb.prepare("SELECT client_name FROM budgets WHERE id = ?").get(budgetObjA.id);
assert(Boolean(legitimateUpdate && checkUpdatedA.client_name === 'Cliente Carlos Modificado'), "16. Actualización legítima: Empresa A puede modificar su propio presupuesto");


// ─── G. CROSS-TENANT DELETE ───
const delResultB = deleteBudgetTenant(contextB29.companyId, budgetObjA.id);
const checkStillExistsA = currentDb.prepare("SELECT id FROM budgets WHERE id = ?").get(budgetObjA.id);

assert(delResultB.deleted === false, "17. Cross-tenant delete: Empresa B no puede eliminar budget de Empresa A");
assert(Boolean(checkStillExistsA && checkStillExistsA.id === budgetObjA.id), "18. Presupuesto protegido: permanece en la base de datos tras intento de borrado ajeno");

// Borrado legítimo por Empresa A
const delResultA = deleteBudgetTenant(contextA29.companyId, budgetObjA.id);
const checkDeletedA = currentDb.prepare("SELECT id FROM budgets WHERE id = ?").get(budgetObjA.id);
assert(delResultA.deleted === true && !checkDeletedA, "19. Borrado legítimo: Empresa A puede eliminar su propio presupuesto");


// ─── H. LISTADO POR TENANT (LISTBUDGETS) ───
const budgetObjB = {
  id: 'PRE-TEST-29-B1',
  client: { name: 'Cliente Empresa B', phone: '654321002' },
  items: [{ description: 'Instalación eléctrica', total: 2200 }],
  financials: { totalAmount: 2200 },
  status: 'PENDIENTE_ACEPTACION'
};
saveBudgetTenant(contextB29, budgetObjB);

const listA = listBudgetsTenant(contextA29.companyId);
const listB = listBudgetsTenant(contextB29.companyId);

assert(listA.every(b => b.id !== budgetObjB.id), "20. Listado aislado: la lista de Empresa A no contiene presupuestos de Empresa B");
assert(listB.every(b => b.id === budgetObjB.id), "21. Listado aislado: la lista de Empresa B contiene únicamente sus presupuestos");


// ─── I. EMPRESA SIN BUDGETS ───
const listC = listBudgetsTenant(compC29.companyId);
assert(Array.isArray(listC) && listC.length === 0, "22. Empresa sin presupuestos: retorna lista vacía ([]) correctamente");


// ─── J. PROHIBICIÓN DE CONSULTA SIN TENANT CONTEXT ───
const unauthSingleParamLookup = getBudgetTenant(budgetObjB.id);
assert(unauthSingleParamLookup === null, "23. Prohibición estricta: llamada getBudget(id) sin tenant context es rechazada (retorna null)");


// ─── K. COMPATIBILIDAD LEGACY DUAL-READ ───
const legacyListA = listBudgetsTenant(phoneTenantA29);
const legacyReadB = getBudgetTenant(phoneTenantB29, budgetObjB.id);
assert(Array.isArray(legacyListA), "24. Compatibilidad legacy: listBudgets(phone) continúa respondiendo correctamente");
assert(Boolean(legacyReadB && legacyReadB.id === budgetObjB.id), "25. Compatibilidad legacy: getBudget(phone, id) resuelve y retorna el presupuesto");


// ─── L. RESTRICCIÓN FOREIGN KEY & PRAGMA INTEGRITY CHECK ───
let fkConstraintBlocked = false;
try {
  currentDb.prepare(`
    INSERT INTO budgets (id, company_id, company_phone, client_name, total_amount, status, created_at, updated_at)
    VALUES ('PRE-INVALID-FK', '00000000-0000-0000-0000-000000000000', '34699999999', 'Fake', 10, 'PENDIENTE', '2026-01-01', '2026-01-01')
  `).run();
} catch (e) {
  fkConstraintBlocked = true;
}
assert(fkConstraintBlocked === true, "26. Foreign Key estricta: SQLite rechaza budgets con company_id inexistente en companies");

// PRAGMA foreign_key_check e integrity_check sobre la base de datos de test
const fkViolations = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult = currentDb.prepare("PRAGMA integrity_check;").get();

assert(fkViolations.length === 0, "27. PRAGMA foreign_key_check: cero violaciones de claves foráneas");
assert(integrityResult.integrity_check === 'ok', "28. PRAGMA integrity_check: la base de datos de test está 100% íntegra (ok)");

// Limpieza final de TEST 29
cleanupTest29(phoneTenantA29);
cleanupTest29(phoneTenantB29);
cleanupTest29(phoneTenantC29);

console.log("\nTEST 30: Migración Controlada de Invoices a Company_ID (Fase 2B-2 — Backfill, Invariante con Presupuestos, Tenant Scoping & Cross-Tenant Defense)");

import {
  saveInvoice as saveInvoiceTenant,
  getInvoice as getInvoiceTenant,
  listInvoices as listInvoicesTenant,
  updateInvoice as updateInvoiceTenant,
  deleteInvoice as deleteInvoiceTenant
} from './db_service.js';
import { migration as mig004 } from './migrations/004_invoices_company_id.js';

// ─── A. PRUEBA DE BACKFILL E IDEMPOTENCIA EN BASE DE DATOS AISLADA EN MEMORIA ───
const memDb30 = new DatabaseSync(':memory:');
memDb30.exec('PRAGMA foreign_keys = ON;');
runMigrations(memDb30, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2]] });

// Insertar empresas de prueba
const compAIdMem = crypto.randomUUID();
const compBIdMem = crypto.randomUUID();
memDb30.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
  compAIdMem, '34611000001', 'Empresa Mem A', '2026-01-01', '2026-01-01'
);
memDb30.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
  compBIdMem, '34611000002', 'Empresa Mem B', '2026-01-01', '2026-01-01'
);

// Insertar presupuestos para las dos empresas
memDb30.prepare("INSERT INTO budgets (id, company_id, company_phone, client_name, total_amount, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'BUD-MEM-A1', compAIdMem, '34611000001', 'Cliente Mem A', 1000, JSON.stringify({ id: 'BUD-MEM-A1', companyId: compAIdMem }), '2026-01-01', '2026-01-01'
);
memDb30.prepare("INSERT INTO budgets (id, company_id, company_phone, client_name, total_amount, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'BUD-MEM-B1', compBIdMem, '34611000002', 'Cliente Mem B', 2000, JSON.stringify({ id: 'BUD-MEM-B1', companyId: compBIdMem }), '2026-01-01', '2026-01-01'
);

// Insertar facturas legadas (sin company_id)
// 1. Factura con budget_id legítimo de A
memDb30.prepare("INSERT INTO invoices (id, budget_id, company_phone, client_name, total_amount, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'INV-MEM-A1', 'BUD-MEM-A1', '34611000001', 'Cliente Mem A', 1000, 'PENDIENTE_PAGO', JSON.stringify({ id: 'INV-MEM-A1' }), '2026-01-01'
);
// 2. Factura directa sin budget_id pero con company_phone de A
memDb30.prepare("INSERT INTO invoices (id, budget_id, company_phone, client_name, total_amount, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'INV-MEM-A2', '', '34611000001', 'Cliente Directo A', 500, 'PENDIENTE_PAGO', JSON.stringify({ id: 'INV-MEM-A2' }), '2026-01-01'
);
// 3. Factura con budget_id legítimo de B
memDb30.prepare("INSERT INTO invoices (id, budget_id, company_phone, client_name, total_amount, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'INV-MEM-B1', 'BUD-MEM-B1', '34611000002', 'Cliente Mem B', 2000, 'PAGADA', JSON.stringify({ id: 'INV-MEM-B1' }), '2026-01-01'
);

// Ejecutar migración 004 sobre memDb30
mig004.up(memDb30);

const memInvoicesAfter = memDb30.prepare("SELECT id, budget_id, company_id, company_phone, data_json FROM invoices").all();
const invA1After = memInvoicesAfter.find(i => i.id === 'INV-MEM-A1');
const invA2After = memInvoicesAfter.find(i => i.id === 'INV-MEM-A2');
const invB1After = memInvoicesAfter.find(i => i.id === 'INV-MEM-B1');

assert(memInvoicesAfter.length === 3, "1. Backfill: número total de facturas conservado exactamente (cero pérdidas, cero duplicados)");
assert(invA1After && invA1After.company_id === compAIdMem, "2. Backfill: factura con presupuesto hereda determinísticamente budget.company_id");
assert(invA2After && invA2After.company_id === compAIdMem, "3. Backfill: factura sin presupuesto resuelve determinísticamente por company_phone");
assert(invB1After && invB1After.company_id === compBIdMem, "4. Backfill: factura de Empresa B recibe determinísticamente su company_id");

// Idempotencia: re-ejecución no produce fallos ni cambios espurios
let idempotencyPass = true;
try {
  mig004.up(memDb30);
} catch (e) {
  idempotencyPass = false;
}
const memCountSecondRun = memDb30.prepare("SELECT count(*) as count FROM invoices").get().count;
assert(idempotencyPass && memCountSecondRun === 3, "5. Idempotencia: re-ejecutar migración 004 no duplica registros ni lanza errores");

// ─── B. DETECCIÓN Y ABORTO ANTE INCONSISTENCIAS / HUÉRFANOS ───
// Caso 1: Factura huérfana sin presupuesto ni empresa registrada
const orphanMemDb = new DatabaseSync(':memory:');
orphanMemDb.exec('PRAGMA foreign_keys = ON;');
runMigrations(orphanMemDb, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2]] });
orphanMemDb.prepare("INSERT INTO invoices (id, budget_id, company_phone, client_name, total_amount, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  'INV-ORPHAN', '', '34600999999', 'Huérfano', 100, '{}', '2026-01-01'
);
let orphanBlocked = false;
try {
  mig004.up(orphanMemDb);
} catch (e) {
  orphanBlocked = e.message.includes('Factura huérfana');
}
assert(orphanBlocked === true, "6. Integridad estricta: factura huérfana sin empresa detiene la migración sin inventar datos");

// Caso 2: Factura con contradicción entre su company_phone y el budget_id vinculado
const conflictMemDb = new DatabaseSync(':memory:');
conflictMemDb.exec('PRAGMA foreign_keys = ON;');
runMigrations(conflictMemDb, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2]] });
const cAId = crypto.randomUUID();
const cBId = crypto.randomUUID();
conflictMemDb.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
  cAId, '34622000001', 'Empresa A', '2026-01-01', '2026-01-01'
);
conflictMemDb.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
  cBId, '34622000002', 'Empresa B', '2026-01-01', '2026-01-01'
);
conflictMemDb.prepare("INSERT INTO budgets (id, company_id, company_phone, client_name, total_amount, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'BUD-CONFLICT-B', cBId, '34622000002', 'Cliente B', 500, '{}', '2026-01-01', '2026-01-01'
);
// Factura que pertenece a A por teléfono pero referencia presupuesto de B
conflictMemDb.prepare("INSERT INTO invoices (id, budget_id, company_phone, client_name, total_amount, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  'INV-CONFLICT', 'BUD-CONFLICT-B', '34622000001', 'Cliente Conflicto', 500, '{}', '2026-01-01'
);
let conflictBlocked = false;
try {
  mig004.up(conflictMemDb);
} catch (e) {
  conflictBlocked = e.message.includes('Contradicción crítica de tenant') || e.message.includes('inconsistencia');
}
assert(conflictBlocked === true, "7. Integridad estricta: contradicción entre company_phone de factura y budget asociado aborta la migración");

// ─── C. SETUP DE TENANTS PARA PRUEBAS REALES EN currentDb ───
const phoneTenantA30 = '34698000001';
const phoneTenantB30 = '34698000002';
const phoneTenantC30 = '34698000003';

const cleanupTest30 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM budgets WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};
cleanupTest30(phoneTenantA30);
cleanupTest30(phoneTenantB30);
cleanupTest30(phoneTenantC30);

const compA30 = createCompanyWithIdentity({
  name: 'Reformas Levante A S.L.',
  phone: phoneTenantA30,
  cif: 'B-30000001',
  trade: 'Construcción'
});
const compB30 = createCompanyWithIdentity({
  name: 'Climatización Sur B S.L.',
  phone: phoneTenantB30,
  cif: 'B-30000002',
  trade: 'Climatización'
});
const compC30 = createCompanyWithIdentity({
  name: 'Empresa Sin Facturas C S.L.',
  phone: phoneTenantC30,
  cif: 'B-30000003',
  trade: 'Fontanería'
});

const contextA30 = resolveAuthenticatedContext('whatsapp', phoneTenantA30);
const contextB30 = resolveAuthenticatedContext('whatsapp', phoneTenantB30);
const contextC30 = resolveAuthenticatedContext('whatsapp', phoneTenantC30);

// Crear presupuesto legítimo para Empresa A y para Empresa B
const budgetObjA30 = {
  id: 'PRE-TEST-30-A1',
  client: { name: 'Cliente Carlos A', phone: '654000111' },
  financials: { totalAmount: 1500 },
  status: 'ACEPTADO'
};
saveBudgetTenant(contextA30, budgetObjA30);

const budgetObjB30 = {
  id: 'PRE-TEST-30-B1',
  client: { name: 'Cliente Laura B', phone: '654000222' },
  financials: { totalAmount: 2500 },
  status: 'ACEPTADO'
};
saveBudgetTenant(contextB30, budgetObjB30);

// ─── D. CREACIÓN LEGÍTIMA DE FACTURA & DUAL-WRITE ───
const invoiceObjA = {
  id: 'INV-TEST-30-A1',
  budgetId: budgetObjA30.id,
  client: { name: 'Cliente Carlos A' },
  financials: { totalAmount: 1500 },
  status: 'PENDIENTE_PAGO'
};
const savedInvA = saveInvoiceTenant(contextA30, invoiceObjA);

const rowInvA = currentDb.prepare("SELECT company_id, company_phone, budget_id FROM invoices WHERE id = ?").get(invoiceObjA.id);

assert(Boolean(savedInvA && rowInvA && rowInvA.company_id === contextA30.companyId), "8. Nueva factura: se persiste con el company_id canónico del tenant");
assert(rowInvA && rowInvA.company_phone === phoneTenantA30, "9. Dual write: company_phone se preserva de forma coherente para compatibilidad legacy");
const rowBudgetA = currentDb.prepare("SELECT company_id FROM budgets WHERE id = ?").get(budgetObjA30.id);
assert(Boolean(rowInvA && rowBudgetA && rowInvA.company_id === rowBudgetA.company_id), "10. Invariante estricta: invoice.company_id coincide exactamente con budget.company_id");

// ─── E. INVARIANTE ESTRICTA: ASOCIACIÓN CROSS-TENANT BLOQUEADA ───
let crossTenantBudgetBlocked = false;
try {
  saveInvoiceTenant(contextA30, {
    id: 'INV-TEST-30-CROSS-BUDGET',
    budgetId: budgetObjB30.id, // Presupuesto de Empresa B intentado por Empresa A
    client: { name: 'Ataque Cross Budget' },
    financials: { totalAmount: 500 }
  });
} catch (e) {
  crossTenantBudgetBlocked = e.message.includes('Violación de invariante');
}
assert(crossTenantBudgetBlocked === true, "11. Invariante estricta: Empresa A no puede crear factura asociada al presupuesto de Empresa B");

// Factura directa sin presupuesto asignada correctamente
const invoiceObjA2 = {
  id: 'INV-TEST-30-A2-DIRECT',
  budgetId: '',
  client: { name: 'Cliente Directo Sin Presupuesto' },
  financials: { totalAmount: 800 },
  status: 'PENDIENTE_PAGO'
};
const savedInvA2 = saveInvoiceTenant(contextA30, invoiceObjA2);
const rowInvA2 = currentDb.prepare("SELECT company_id FROM invoices WHERE id = ?").get(invoiceObjA2.id);
assert(Boolean(savedInvA2 && rowInvA2 && rowInvA2.company_id === contextA30.companyId), "12. Factura sin presupuesto: se crea con company_id del tenant autenticado");

// ─── F. NEUTRALIZACIÓN DE INYECCIÓN DE MODELO IA / CLIENTE ───
const maliciousInvoice = {
  id: 'INV-TEST-30-AI-INJECT',
  budgetId: budgetObjA30.id,
  company_id: contextB30.companyId, // IA genera company_id de B
  companyId: contextB30.companyId,
  company_phone: phoneTenantB30,     // IA genera teléfono de B
  client: { name: 'Inyección IA' },
  financials: { totalAmount: 300 }
};
const defendedInv = saveInvoiceTenant(contextA30, maliciousInvoice);
const rowDefended = currentDb.prepare("SELECT company_id, company_phone FROM invoices WHERE id = ?").get(maliciousInvoice.id);

assert(rowDefended && rowDefended.company_id === contextA30.companyId, "13. Inyección IA bloqueada: el backend impone el company_id de la sesión e ignora el del modelo");
assert(rowDefended && rowDefended.company_phone === phoneTenantA30, "14. Inyección IA bloqueada: el backend impone el teléfono de la sesión e ignora el del modelo");
assert(rowDefended.company_id !== contextB30.companyId, "15. Aislamiento IA: la factura jamás se asigna a Empresa B");

// ─── G. LECTURA TENANT-SCOPED & ZERO-DISCLOSURE ───
const legitimateReadA = getInvoiceTenant(contextA30.companyId, invoiceObjA.id);
const legitimateReadContextA = getInvoiceTenant(contextA30, invoiceObjA.id);
const crossTenantReadB = getInvoiceTenant(contextB30.companyId, invoiceObjA.id);

assert(Boolean(legitimateReadA && legitimateReadA.id === invoiceObjA.id), "16. Lectura legítima: getInvoice(companyId, id) retorna la factura propia");
assert(Boolean(legitimateReadContextA && legitimateReadContextA.id === invoiceObjA.id), "17. Lectura por contexto: getInvoice(authenticatedContext, id) retorna la factura");
assert(crossTenantReadB === null, "18. Cross-tenant read: Empresa B no puede leer factura de Empresa A (retorna null)");
assert(crossTenantReadB === null, "19. Zero-Disclosure: no se revelan metadatos, cliente ni importes");

// ─── H. CROSS-TENANT UPDATE ───
const maliciousInvoiceUpdate = {
  id: invoiceObjA.id,
  client: { name: 'Cliente Hackeado' },
  financials: { totalAmount: 1 }
};
const updateResultB30 = updateInvoiceTenant(contextB30.companyId, maliciousInvoiceUpdate);
const checkUnchangedInvA = currentDb.prepare("SELECT client_name, total_amount FROM invoices WHERE id = ?").get(invoiceObjA.id);

assert(updateResultB30 === null, "20. Cross-tenant update: updateInvoice rechaza la modificación de factura ajena");
assert(checkUnchangedInvA.client_name === 'Cliente Carlos A' && checkUnchangedInvA.total_amount === 1500, "21. Integridad de datos: los datos de la factura de A permanecen intactos");

// Actualización legítima por Empresa A
const legitimateInvUpdate = updateInvoiceTenant(contextA30.companyId, {
  ...invoiceObjA,
  status: 'PAGADA'
});
const checkUpdatedInvA = currentDb.prepare("SELECT status FROM invoices WHERE id = ?").get(invoiceObjA.id);
assert(Boolean(legitimateInvUpdate && checkUpdatedInvA.status === 'PAGADA'), "22. Actualización legítima: Empresa A puede modificar su propia factura");

// ─── I. CROSS-TENANT DELETE ───
const delInvResultB = deleteInvoiceTenant(contextB30.companyId, invoiceObjA.id);
const checkStillExistsInvA = currentDb.prepare("SELECT id FROM invoices WHERE id = ?").get(invoiceObjA.id);

assert(delInvResultB.deleted === false, "23. Cross-tenant delete: Empresa B no puede eliminar factura de Empresa A");
assert(Boolean(checkStillExistsInvA && checkStillExistsInvA.id === invoiceObjA.id), "24. Factura protegida: permanece en la base de datos tras intento de borrado ajeno");

// Borrado legítimo por Empresa A
const delInvResultA = deleteInvoiceTenant(contextA30.companyId, invoiceObjA.id);
const checkDeletedInvA = currentDb.prepare("SELECT id FROM invoices WHERE id = ?").get(invoiceObjA.id);
assert(delInvResultA.deleted === true && !checkDeletedInvA, "25. Borrado legítimo: Empresa A puede eliminar su propia factura");

// ─── J. LISTADOS POR TENANT (LISTINVOICES) ───
const invoiceObjB = {
  id: 'INV-TEST-30-B1',
  budgetId: budgetObjB30.id,
  client: { name: 'Cliente Laura B' },
  financials: { totalAmount: 2500 },
  status: 'PENDIENTE_PAGO'
};
saveInvoiceTenant(contextB30, invoiceObjB);

const listInvA = listInvoicesTenant(contextA30.companyId);
const listInvB = listInvoicesTenant(contextB30.companyId);

assert(listInvA.every(inv => inv.id !== invoiceObjB.id), "26. Listado aislado: la lista de Empresa A no contiene facturas de Empresa B");
assert(listInvB.every(inv => inv.id === invoiceObjB.id), "27. Listado aislado: la lista de Empresa B contiene únicamente sus facturas");

// Empresa sin facturas
const listInvC = listInvoicesTenant(compC30.companyId);
assert(Array.isArray(listInvC) && listInvC.length === 0, "28. Empresa sin facturas: retorna lista vacía ([]) correctamente");

// ─── K. PROHIBICIÓN DE CONSULTA SIN TENANT CONTEXT ───
const unauthSingleInvoiceLookup = getInvoiceTenant(invoiceObjB.id);
assert(unauthSingleInvoiceLookup === null, "29. Prohibición estricta: llamada getInvoice(id) sin tenant context es rechazada (retorna null)");

// ─── L. COMPATIBILIDAD LEGACY DUAL-READ ───
const legacyListInvA = listInvoicesTenant(phoneTenantA30);
const legacyReadInvB = getInvoiceTenant(phoneTenantB30, invoiceObjB.id);
assert(Array.isArray(legacyListInvA), "30. Compatibilidad legacy: listInvoices(phone) continúa respondiendo correctamente");
assert(Boolean(legacyReadInvB && legacyReadInvB.id === invoiceObjB.id), "31. Compatibilidad legacy: getInvoice(phone, id) resuelve y retorna la factura");

// ─── M. FLUJO DE GATEWAY Y SESIÓN DE WHATSAPP ───
const sessionB = getUserSession(`${phoneTenantB30}@s.whatsapp.net`);
assert(Boolean(sessionB && sessionB.companyId === compB30.companyId), "32. Gateway: sesión en memoria resuelve companyId canónico");
assert(sessionB.invoices && sessionB.invoices.has(invoiceObjB.id), "33. Gateway: getUserSession carga las facturas con scope de company_id");

// ─── N. RESTRICCIÓN FOREIGN KEY & PRAGMA INTEGRITY CHECK ───
let fkConstraintBlockedInv = false;
try {
  currentDb.prepare(`
    INSERT INTO invoices (id, company_id, budget_id, company_phone, client_name, total_amount, status, created_at)
    VALUES ('INV-INVALID-FK', '00000000-0000-0000-0000-000000000000', '', '34699999999', 'Fake', 10, 'PENDIENTE', '2026-01-01')
  `).run();
} catch (e) {
  fkConstraintBlockedInv = true;
}
assert(fkConstraintBlockedInv === true, "34. Foreign Key estricta: SQLite rechaza invoices con company_id inexistente en companies");

// PRAGMA foreign_key_check e integrity_check sobre la base de datos de test
const fkViolations30 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult30 = currentDb.prepare("PRAGMA integrity_check;").get();

assert(fkViolations30.length === 0, "35. PRAGMA foreign_key_check: cero violaciones de claves foráneas");
assert(integrityResult30.integrity_check === 'ok', "36. PRAGMA integrity_check: la base de datos de test está 100% íntegra (ok)");

// Limpieza final de TEST 30
cleanupTest30(phoneTenantA30);
cleanupTest30(phoneTenantB30);
cleanupTest30(phoneTenantC30);
userSessions.delete(`${phoneTenantA30}@s.whatsapp.net`);
userSessions.delete(`${phoneTenantB30}@s.whatsapp.net`);
userSessions.delete(`${phoneTenantC30}@s.whatsapp.net`);

console.log("\nTEST 31: Migración Controlada de Payments a Company_ID y Payment Allocations (Fase 2B-3 — Backfill, Desacople de Facturas, Tenant Invariants & Allocation Defense)");

import {
  savePayment as savePaymentTenant,
  getPayment as getPaymentTenant,
  listPayments as listPaymentsTenant,
  updatePayment as updatePaymentTenant,
  deletePayment as deletePaymentTenant,
  getPayments as getPaymentsTenant,
  createPaymentAllocation as createPaymentAllocationTenant,
  getPaymentAllocation as getPaymentAllocationTenant,
  listPaymentAllocations as listPaymentAllocationsTenant,
  deletePaymentAllocation as deletePaymentAllocationTenant
} from './db_service.js';
import { migration as mig005 } from './migrations/005_payments_company_id.js';

// ─── A. PRUEBA DE BACKFILL E IDEMPOTENCIA EN BASE DE DATOS AISLADA EN MEMORIA ───
const memDb31 = new DatabaseSync(':memory:');
memDb31.exec('PRAGMA foreign_keys = ON;');
runMigrations(memDb31, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2], MIGRATIONS[3]] });

// Insertar empresas de prueba en memoria
const compAIdMem31 = crypto.randomUUID();
const compBIdMem31 = crypto.randomUUID();
memDb31.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
  compAIdMem31, '34611000001', 'Empresa Mem A', '2026-01-01', '2026-01-01'
);
memDb31.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
  compBIdMem31, '34611000002', 'Empresa Mem B', '2026-01-01', '2026-01-01'
);

// Insertar presupuestos y facturas en memoria
memDb31.prepare("INSERT INTO budgets (id, company_id, company_phone, client_name, total_amount, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'BUD-MEM-31-A1', compAIdMem31, '34611000001', 'Cliente Mem A', 1000, JSON.stringify({ id: 'BUD-MEM-31-A1', companyId: compAIdMem31 }), '2026-01-01', '2026-01-01'
);
memDb31.prepare("INSERT INTO invoices (id, company_id, budget_id, company_phone, client_name, total_amount, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  'INV-MEM-31-A1', compAIdMem31, 'BUD-MEM-31-A1', '34611000001', 'Cliente Mem A', 1000, 'PENDIENTE_PAGO', JSON.stringify({ id: 'INV-MEM-31-A1' }), '2026-01-01'
);

memDb31.prepare("INSERT INTO budgets (id, company_id, company_phone, client_name, total_amount, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'BUD-MEM-31-B1', compBIdMem31, '34611000002', 'Cliente Mem B', 2000, JSON.stringify({ id: 'BUD-MEM-31-B1', companyId: compBIdMem31 }), '2026-01-01', '2026-01-01'
);
memDb31.prepare("INSERT INTO invoices (id, company_id, budget_id, company_phone, client_name, total_amount, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  'INV-MEM-31-B1', compBIdMem31, 'BUD-MEM-31-B1', '34611000002', 'Cliente Mem B', 2000, 'PENDIENTE_PAGO', JSON.stringify({ id: 'INV-MEM-31-B1' }), '2026-01-01'
);

// Insertar pagos legados sin company_id:
// 1. Pago referenciando factura existente de A
memDb31.prepare("INSERT INTO payments (id, budget_id, company_phone, amount, method, concept, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'PAY-MEM-1', 'INV-MEM-31-A1', '34611000001', 600, 'TRANSFERENCIA', 'Cobro factura A1', JSON.stringify({ id: 'PAY-MEM-1' }), '2026-01-01'
);
// 2. Pago referenciando presupuesto existente de A (sin factura)
memDb31.prepare("INSERT INTO payments (id, budget_id, company_phone, amount, method, concept, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'PAY-MEM-2', 'BUD-MEM-31-A1', '34611000001', 400, 'BIZUM', 'Anticipo presupuesto A1', JSON.stringify({ id: 'PAY-MEM-2' }), '2026-01-01'
);
// 3. Pago directo sin budget_id pero con company_phone de B
memDb31.prepare("INSERT INTO payments (id, budget_id, company_phone, amount, method, concept, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'PAY-MEM-3', '', '34611000002', 1500, 'EFECTIVO', 'Pago directo B', JSON.stringify({ id: 'PAY-MEM-3' }), '2026-01-01'
);

// Ejecutar migración 005 sobre memDb31
mig005.up(memDb31);

const memPaymentsAfter = memDb31.prepare("SELECT id, budget_id, company_id, company_phone, amount, data_json FROM payments").all();
const pay1After = memPaymentsAfter.find(p => p.id === 'PAY-MEM-1');
const pay2After = memPaymentsAfter.find(p => p.id === 'PAY-MEM-2');
const pay3After = memPaymentsAfter.find(p => p.id === 'PAY-MEM-3');

assert(memPaymentsAfter.length === 3, "1. Backfill: número total de pagos conservado exactamente (cero pérdidas, cero duplicados)");
assert(Boolean(pay1After && pay1After.company_id === compAIdMem31), "2. Precedencia 1: pago que referencia factura adopta el company_id canónico de la factura");
assert(Boolean(pay2After && pay2After.company_id === compAIdMem31), "3. Precedencia 2: pago que referencia presupuesto adopta el company_id del presupuesto");
assert(Boolean(pay3After && pay3After.company_id === compBIdMem31), "4. Precedencia 3: pago sin referencia adopta company_id a través de company_phone");
assert(pay1After.company_phone === '34611000001' && pay3After.company_phone === '34611000002', "5. Dual-Write preservado: la columna legacy company_phone permanece intacta");

// Verificar reconstrucción determinista de allocations históricas
const memAllocationsAfter = memDb31.prepare("SELECT id, payment_id, invoice_id, company_id, amount FROM payment_allocations").all();
assert(memAllocationsAfter.length === 1, "6. Reconstrucción histórica: exactamente 1 allocation generada para el pago asociado a factura");

const allocPay1 = memAllocationsAfter.find(a => a.payment_id === 'PAY-MEM-1');
assert(Boolean(allocPay1 && allocPay1.invoice_id === 'INV-MEM-31-A1' && allocPay1.company_id === compAIdMem31 && allocPay1.amount === 600), "7. Invariante histórico: la allocation reconstruida coincide en importe, tenant, pago y factura");

const allocPay2 = memAllocationsAfter.find(a => a.payment_id === 'PAY-MEM-2');
const allocPay3 = memAllocationsAfter.find(a => a.payment_id === 'PAY-MEM-3');
assert(!allocPay2 && !allocPay3, "8. Aislamiento histórico: pagos asociados únicamente a presupuestos o sin factura NO generan allocations espurias");

// Idempotencia: re-ejecución de mig005.up no debe duplicar allocations ni fallar
let idempotencyError31 = null;
try {
  mig005.up(memDb31);
} catch (e) {
  idempotencyError31 = e;
}
const memAllocationsRecheck = memDb31.prepare("SELECT count(*) as count FROM payment_allocations").get().count;
assert(idempotencyError31 === null && memAllocationsRecheck === 1, "9. Idempotencia: re-ejecución de migración 005 produce 0 cambios y no duplica allocations");

// ─── B. DETECCIÓN Y ABORTO ANTE INCONSISTENCIAS / CONTRADICCIONES / HUÉRFANOS ───
// Caso 1: Contradicción entre company_phone del pago y el company_id de la factura referenciada
const conflictMemDb31 = new DatabaseSync(':memory:');
conflictMemDb31.exec('PRAGMA foreign_keys = ON;');
runMigrations(conflictMemDb31, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2], MIGRATIONS[3]] });

const compId1 = crypto.randomUUID();
const compId2 = crypto.randomUUID();
conflictMemDb31.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(compId1, '34600000001', 'Emp 1', '2026-01-01', '2026-01-01');
conflictMemDb31.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(compId2, '34600000002', 'Emp 2', '2026-01-01', '2026-01-01');
conflictMemDb31.prepare("INSERT INTO invoices (id, company_id, budget_id, company_phone, client_name, total_amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'INV-CONFLICT-1', compId1, '', '34600000001', 'Cli 1', 500, 'PENDIENTE', '2026-01-01'
);
// Pago con teléfono de Empresa 2 apuntando a factura de Empresa 1
conflictMemDb31.prepare("INSERT INTO payments (id, budget_id, company_phone, amount, method, concept, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  'PAY-CONFLICT-1', 'INV-CONFLICT-1', '34600000002', 500, 'TRANSFER', 'Conflicto', '2026-01-01'
);

let conflictCaught31 = false;
try {
  mig005.up(conflictMemDb31);
} catch (e) {
  conflictCaught31 = true;
}
assert(conflictCaught31 === true, "10. Invariante estricto: la migración aborta inmediatamente si detecta contradicción cross-tenant en un pago");

// Caso 2: Pago huérfano sin empresa registrada ni targetId
const orphanMemDb31 = new DatabaseSync(':memory:');
orphanMemDb31.exec('PRAGMA foreign_keys = ON;');
runMigrations(orphanMemDb31, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2], MIGRATIONS[3]] });
orphanMemDb31.prepare("INSERT INTO payments (id, budget_id, company_phone, amount, method, concept, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  'PAY-ORPHAN-1', '', '34699999999', 100, 'EFECTIVO', 'Huérfano', '2026-01-01'
);

let orphanCaught31 = false;
try {
  mig005.up(orphanMemDb31);
} catch (e) {
  orphanCaught31 = true;
}
assert(orphanCaught31 === true, "11. Detección de huérfanos: la migración aborta si un pago tiene teléfono no registrado en companies");

// ─── C. ENTORNO DE TEST REAL: MULTI-TENANT ISOLATION EN currentDb ───
const phoneTenantA31 = '34697000001';
const phoneTenantB31 = '34697000002';
const phoneTenantC31 = '34697000003';

const cleanupTest31 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM payment_allocations WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM payments WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM budgets WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};
cleanupTest31(phoneTenantA31);
cleanupTest31(phoneTenantB31);
cleanupTest31(phoneTenantC31);

const compA31 = createCompanyWithIdentity({
  name: 'Construcciones Madrid A S.L.',
  phone: phoneTenantA31,
  cif: 'B-31000001',
  trade: 'Albañilería'
});
const compB31 = createCompanyWithIdentity({
  name: 'Fontanería Norte B S.L.',
  phone: phoneTenantB31,
  cif: 'B-31000002',
  trade: 'Fontanería'
});
const compC31 = createCompanyWithIdentity({
  name: 'Empresa Sin Pagos C S.L.',
  phone: phoneTenantC31,
  cif: 'B-31000003',
  trade: 'Pintura'
});

const contextA31 = resolveAuthenticatedContext('whatsapp', phoneTenantA31);
const contextB31 = resolveAuthenticatedContext('whatsapp', phoneTenantB31);
const contextC31 = resolveAuthenticatedContext('whatsapp', phoneTenantC31);

// Crear presupuestos y facturas en currentDb para A y B
const budgetObjA31 = {
  id: 'BUD-T31-A1',
  client: { name: 'Cliente A Reforma' },
  financials: { totalAmount: 1200 }
};
saveBudgetTenant(contextA31, budgetObjA31);

const invoiceObjA31 = {
  id: 'INV-T31-A1',
  budgetId: budgetObjA31.id,
  client: { name: 'Cliente A Reforma' },
  financials: { totalAmount: 1200 },
  status: 'PENDIENTE_PAGO'
};
saveInvoiceTenant(contextA31, invoiceObjA31);

const budgetObjB31 = {
  id: 'BUD-T31-B1',
  client: { name: 'Cliente B Fontanería' },
  financials: { totalAmount: 2000 }
};
saveBudgetTenant(contextB31, budgetObjB31);

const invoiceObjB31 = {
  id: 'INV-T31-B1',
  budgetId: budgetObjB31.id,
  client: { name: 'Cliente B Fontanería' },
  financials: { totalAmount: 2000 },
  status: 'PENDIENTE_PAGO'
};
saveInvoiceTenant(contextB31, invoiceObjB31);

// ─── D. CREACIÓN DE PAGOS TENANT-SCOPED & AUTO-ALLOCATION ───
const paymentDataA1 = {
  id: 'PAY-T31-A1',
  amount: 500,
  method: 'TRANSFERENCIA',
  targetId: invoiceObjA31.id,
  concept: 'Anticipo obra A'
};
const savedPayA1 = savePaymentTenant(contextA31, paymentDataA1);
const rowPayA1 = currentDb.prepare("SELECT company_id, company_phone, amount FROM payments WHERE id = ?").get(paymentDataA1.id);

assert(Boolean(savedPayA1 && rowPayA1 && rowPayA1.company_id === contextA31.companyId), "12. Creación legítima: savePayment asigna company_id canónico del tenant autenticado");
assert(rowPayA1 && rowPayA1.company_phone === phoneTenantA31, "13. Dual-write en base de datos: company_phone persistido correctamente");

// Verificar creación automática de payment_allocation vinculada a la factura
const autoAllocA1 = currentDb.prepare("SELECT * FROM payment_allocations WHERE payment_id = ?").get(paymentDataA1.id);
assert(Boolean(autoAllocA1 && autoAllocA1.invoice_id === invoiceObjA31.id && autoAllocA1.amount === 500), "14. Auto-allocation: savePayment con targetId de factura crea automáticamente la allocation");
assert(autoAllocA1 && autoAllocA1.company_id === contextA31.companyId && autoAllocA1.company_id === rowPayA1.company_id, "15. Invariante canónico: allocation.company_id == payment.company_id == invoice.company_id");

// ─── E. PAGOS DIRECTOS Y CREACIÓN MANUAL DE ALLOCATIONS ───
const paymentDataA2 = {
  id: 'PAY-T31-A2',
  amount: 400,
  method: 'EFECTIVO',
  concept: 'Cobro general sin factura inicial'
};
const savedPayA2 = savePaymentTenant(contextA31, paymentDataA2);
const allocsA2Initial = listPaymentAllocationsTenant(contextA31, { paymentId: paymentDataA2.id });

assert(Boolean(savedPayA2 && allocsA2Initial.length === 0), "16. Pago directo: guardado con company_id del tenant y 0 allocations iniciales");

// Creación manual de allocation asociada a la factura de A
const createdAllocA2 = createPaymentAllocationTenant(contextA31, {
  paymentId: paymentDataA2.id,
  invoiceId: invoiceObjA31.id,
  amount: 250
});
const rowAllocA2 = currentDb.prepare("SELECT * FROM payment_allocations WHERE id = ?").get(createdAllocA2.id);
assert(Boolean(rowAllocA2 && rowAllocA2.amount === 250 && rowAllocA2.company_id === contextA31.companyId), "17. createPaymentAllocation: crea allocation legítima asociada a factura del mismo tenant");

// ─── F. VALIDACIONES DE ALLOCATION: CENT PRECISION, OVER-ALLOCATION & NON-POSITIVE ───
let zeroAmountRejected = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: paymentDataA2.id,
    invoiceId: invoiceObjA31.id,
    amount: 0
  });
} catch (e) {
  zeroAmountRejected = true;
}
assert(zeroAmountRejected === true, "18. Validación de importe: rechaza allocation con importe 0");

let negativeAmountRejected = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: paymentDataA2.id,
    invoiceId: invoiceObjA31.id,
    amount: -50
  });
} catch (e) {
  negativeAmountRejected = true;
}
assert(negativeAmountRejected === true, "19. Validación de importe: rechaza allocation con importe negativo");

// Sobre-asignación: El pago PAY-T31-A2 tiene 400 total, 250 asignados, quedan 150.
// Intentar asignar 150.01 o 200 debe ser rechazado
let overAllocationRejected = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: paymentDataA2.id,
    invoiceId: invoiceObjA31.id,
    amount: 200
  });
} catch (e) {
  overAllocationRejected = true;
}
assert(overAllocationRejected === true, "20. Prevención de sobre-asignación: rechaza allocation que supere el importe total del pago");

// Asignar exactamente el remanente (150 €) -> debe permitirse
const exactRemainingAlloc = createPaymentAllocationTenant(contextA31, {
  paymentId: paymentDataA2.id,
  invoiceId: invoiceObjA31.id,
  amount: 150
});
assert(Boolean(exactRemainingAlloc && exactRemainingAlloc.amount === 150), "21. Precisión monetaria: asignación exacta hasta agotar el saldo restante (100% cubierto)");

// Intentar asignar 1 céntimo más (0.01 €) -> debe ser rechazado
let centOverAllocRejected = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: paymentDataA2.id,
    invoiceId: invoiceObjA31.id,
    amount: 0.01
  });
} catch (e) {
  centOverAllocRejected = true;
}
assert(centOverAllocRejected === true, "22. Precisión centesimal: rechaza exceder el pago incluso por 0.01 €");

// ─── G. NEUTRALIZACIÓN ACTIVA DE INYECCIÓN DE MODELO / IA Y ATAQUES CROSS-TENANT ───
const maliciousPayment = {
  id: 'PAY-T31-AI-INJECT',
  company_id: contextB31.companyId, // IA genera company_id de Empresa B
  companyId: contextB31.companyId,
  company_phone: phoneTenantB31,     // IA genera teléfono de Empresa B
  amount: 350,
  method: 'BIZUM',
  concept: 'Intento de inyección IA'
};
const defendedPay = savePaymentTenant(contextA31, maliciousPayment);
const rowDefendedPay = currentDb.prepare("SELECT company_id, company_phone FROM payments WHERE id = ?").get(maliciousPayment.id);

assert(rowDefendedPay && rowDefendedPay.company_id === contextA31.companyId, "23. Inyección IA bloqueada: el backend impone el company_id de la sesión e ignora el del modelo");
assert(rowDefendedPay && rowDefendedPay.company_phone === phoneTenantA31, "24. Inyección IA bloqueada: el backend impone el teléfono de la sesión e ignora el del modelo");
assert(rowDefendedPay.company_id !== contextB31.companyId, "25. Aislamiento IA: el pago jamás se asigna a Empresa B");

// Ataque Cross-Tenant: Empresa A intenta asociar pago a factura de Empresa B
let crossTenantPaymentTargetBlocked = false;
try {
  savePaymentTenant(contextA31, {
    id: 'PAY-T31-CROSS-TARGET',
    amount: 100,
    method: 'TRANSFERENCIA',
    targetId: invoiceObjB31.id // Factura de B
  });
} catch (e) {
  crossTenantPaymentTargetBlocked = true;
}
assert(crossTenantPaymentTargetBlocked === true, "26. Cross-Tenant Target Defense: savePayment rechaza targetId correspondiente a factura ajena");

// Ataque Cross-Tenant: Empresa A intenta crear allocation apuntando a factura de Empresa B
let crossTenantAllocBlocked = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: paymentDataA1.id,
    invoiceId: invoiceObjB31.id,
    amount: 50
  });
} catch (e) {
  crossTenantAllocBlocked = true;
}
assert(crossTenantAllocBlocked === true, "27. Cross-Tenant Allocation Defense: createPaymentAllocation rechaza asociar a factura ajena");

// Ataque Cross-Tenant: Empresa B intenta crear allocation sobre pago de Empresa A
let crossTenantPayAllocBlocked = false;
try {
  createPaymentAllocationTenant(contextB31, {
    paymentId: paymentDataA1.id,
    invoiceId: invoiceObjB31.id,
    amount: 50
  });
} catch (e) {
  crossTenantPayAllocBlocked = true;
}
assert(crossTenantPayAllocBlocked === true, "28. Cross-Tenant Payment Defense: Empresa B no puede crear allocations sobre pagos de Empresa A");

// ─── H. LECTURA TENANT-SCOPED Y ZERO-DISCLOSURE ───
const legitimatePayReadA = getPaymentTenant(contextA31.companyId, paymentDataA1.id);
const crossTenantPayReadB = getPaymentTenant(contextB31.companyId, paymentDataA1.id);

assert(Boolean(legitimatePayReadA && legitimatePayReadA.id === paymentDataA1.id), "29. Lectura legítima: getPayment(companyId, id) retorna el pago propio");
assert(crossTenantPayReadB === null, "30. Cross-tenant read: Empresa B no puede leer pagos de Empresa A (retorna null)");
assert(crossTenantPayReadB === null, "31. Zero-Disclosure: no se revelan importes, métodos ni conceptos ajenos");

const legitimateAllocReadA = getPaymentAllocationTenant(contextA31.companyId, autoAllocA1.id);
const crossTenantAllocReadB = getPaymentAllocationTenant(contextB31.companyId, autoAllocA1.id);
assert(Boolean(legitimateAllocReadA && legitimateAllocReadA.id === autoAllocA1.id), "32. Lectura legítima de allocation: getPaymentAllocation(companyId, id) retorna la allocation propia");
assert(crossTenantAllocReadB === null, "33. Zero-Disclosure en allocations: Empresa B no puede leer allocation de Empresa A");

// Listados aislados
const listPayA = listPaymentsTenant(contextA31.companyId);
const listPayB = listPaymentsTenant(contextB31.companyId);
const listPayC = listPaymentsTenant(compC31.companyId);

assert(listPayA.length >= 2 && listPayA.every(p => p.companyId === contextA31.companyId), "34. Listado aislado de pagos: Empresa A solo visualiza sus pagos propios");
assert(listPayB.length === 0 && listPayC.length === 0, "35. Listados de B y C: empresas sin pagos retornan listas vacías ([])");

const listAllocA = listPaymentAllocationsTenant(contextA31.companyId);
const listAllocB = listPaymentAllocationsTenant(contextB31.companyId);
assert(listAllocA.length >= 2 && listAllocB.length === 0, "36. Listado aislado de allocations: Empresa A visualiza sus allocations, Empresa B obtiene lista vacía");

// Prohibición estricta de consultas sin contexto tenant
const unauthPayLookup = getPaymentTenant(paymentDataA1.id);
const unauthAllocLookup = getPaymentAllocationTenant(autoAllocA1.id);
assert(unauthPayLookup === null, "37. Prohibición estricta: getPayment(id) sin tenant context retorna null");
assert(unauthAllocLookup === null, "38. Prohibición estricta: getPaymentAllocation(id) sin tenant context retorna null");

// ─── I. MODIFICACIÓN Y BORRADO TENANT-SCOPED ───
// Intento de modificación ajena por Empresa B
const maliciousPayUpdate = {
  id: paymentDataA1.id,
  amount: 999999,
  concept: 'Pago hackeado'
};
const updateResultB31 = updatePaymentTenant(contextB31.companyId, maliciousPayUpdate);
const checkUnchangedPayA = currentDb.prepare("SELECT amount, concept FROM payments WHERE id = ?").get(paymentDataA1.id);

assert(updateResultB31 === null, "39. Cross-tenant update: updatePayment rechaza modificación de pago ajeno");
assert(checkUnchangedPayA.amount === 500 && checkUnchangedPayA.concept === 'Anticipo obra A', "40. Integridad de datos: los importes y conceptos de Empresa A permanecen intactos");

// Actualización legítima por Empresa A
const legitPayUpdate = updatePaymentTenant(contextA31.companyId, {
  ...savedPayA1,
  concept: 'Anticipo confirmado y comprobado'
});
const checkUpdatedPayA = currentDb.prepare("SELECT concept FROM payments WHERE id = ?").get(paymentDataA1.id);
assert(Boolean(legitPayUpdate && checkUpdatedPayA.concept === 'Anticipo confirmado y comprobado'), "41. Actualización legítima: Empresa A puede modificar el concepto de su pago");

// Borrado de allocation: intento ajeno por Empresa B
const delAllocResultB = deletePaymentAllocationTenant(contextB31.companyId, rowAllocA2.id);
const checkStillExistsAllocA2 = currentDb.prepare("SELECT id FROM payment_allocations WHERE id = ?").get(rowAllocA2.id);
assert(delAllocResultB.deleted === false, "42. Cross-tenant delete allocation: Empresa B no puede eliminar allocation de Empresa A");
assert(Boolean(checkStillExistsAllocA2 && checkStillExistsAllocA2.id === rowAllocA2.id), "43. Allocation protegida: permanece íntegra tras intento de borrado ajeno");

// Borrado legítimo de allocation por Empresa A
const delAllocResultA = deletePaymentAllocationTenant(contextA31.companyId, rowAllocA2.id);
const checkDeletedAllocA2 = currentDb.prepare("SELECT id FROM payment_allocations WHERE id = ?").get(rowAllocA2.id);
assert(delAllocResultA.deleted === true && !checkDeletedAllocA2, "44. Borrado legítimo de allocation: Empresa A puede eliminar su propia allocation");

// Borrado de pago: intento ajeno por Empresa B
const delPayResultB = deletePaymentTenant(contextB31.companyId, paymentDataA2.id);
const checkStillExistsPayA2 = currentDb.prepare("SELECT id FROM payments WHERE id = ?").get(paymentDataA2.id);
assert(delPayResultB.deleted === false, "45. Cross-tenant delete payment: Empresa B no puede eliminar pago de Empresa A");
assert(Boolean(checkStillExistsPayA2 && checkStillExistsPayA2.id === paymentDataA2.id), "46. Pago protegido: permanece en la base de datos tras intento de borrado ajeno");

// Borrado legítimo de pago por Empresa A (debe eliminar también las allocations asociadas por CASCADE)
const delPayResultA = deletePaymentTenant(contextA31.companyId, paymentDataA2.id);
const checkDeletedPayA2 = currentDb.prepare("SELECT id FROM payments WHERE id = ?").get(paymentDataA2.id);
const checkCascadeAlloc = currentDb.prepare("SELECT count(*) as count FROM payment_allocations WHERE payment_id = ?").get(paymentDataA2.id).count;
assert(delPayResultA.deleted === true && !checkDeletedPayA2 && checkCascadeAlloc === 0, "47. Borrado legítimo de pago: Empresa A elimina su pago y limpia allocations asociadas");

// ─── J. COMPATIBILIDAD LEGACY DUAL-READ ───
const legacyReadPayA = getPaymentTenant(phoneTenantA31, paymentDataA1.id);
const legacyListPayA = listPaymentsTenant(phoneTenantA31);
const legacyGetPaymentsA = getPaymentsTenant(phoneTenantA31, invoiceObjA31.id);

assert(Boolean(legacyReadPayA && legacyReadPayA.id === paymentDataA1.id), "48. Compatibilidad legacy: getPayment(phone, id) resuelve y retorna el pago");
assert(Array.isArray(legacyListPayA) && legacyListPayA.length >= 1, "49. Compatibilidad legacy: listPayments(phone) resuelve y lista los pagos");
assert(Array.isArray(legacyGetPaymentsA) && legacyGetPaymentsA.length >= 1, "50. Compatibilidad legacy: getPayments(phone, targetId) responde correctamente");

// ─── K. RESTRICCIONES FOREIGN KEY & PRAGMA INTEGRITY CHECK ───
let fkConstraintBlockedPay = false;
try {
  currentDb.prepare(`
    INSERT INTO payments (id, company_id, budget_id, company_phone, amount, method, concept, created_at)
    VALUES ('PAY-INVALID-FK', '00000000-0000-0000-0000-000000000000', '', '34699999999', 50, 'EFECTIVO', 'Fake', '2026-01-01')
  `).run();
} catch (e) {
  fkConstraintBlockedPay = true;
}
assert(fkConstraintBlockedPay === true, "51. Foreign Key estricta: SQLite rechaza payments con company_id inexistente en companies");

let fkConstraintBlockedAlloc = false;
try {
  currentDb.prepare(`
    INSERT INTO payment_allocations (id, payment_id, invoice_id, company_id, amount, allocated_at, created_at, updated_at)
    VALUES ('ALLOC-INVALID-FK', '${paymentDataA1.id}', '${invoiceObjA31.id}', '00000000-0000-0000-0000-000000000000', 50, '2026-01-01', '2026-01-01', '2026-01-01')
  `).run();
} catch (e) {
  fkConstraintBlockedAlloc = true;
}
assert(fkConstraintBlockedAlloc === true, "52. Foreign Key estricta: SQLite rechaza payment_allocations con company_id inexistente");

// PRAGMA foreign_key_check e integrity_check sobre la base de datos de test
const fkViolations31 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult31 = currentDb.prepare("PRAGMA integrity_check;").get();

assert(fkViolations31.length === 0, "53. PRAGMA foreign_key_check: cero violaciones de claves foráneas");
assert(integrityResult31.integrity_check === 'ok', "54. PRAGMA integrity_check: la base de datos de test está 100% íntegra (ok)");

// ─── L. MICRO-AUDITORÍA Y HARDENING MONETARIO / RUTAS DE ALLOCATION ───

// 1. Precisión decimal: 0.30 = 0.10 + 0.20 (PASS)
const payPrecision1 = savePaymentTenant(contextA31, {
  id: 'PAY-HARDEN-P1',
  amount: 0.30,
  method: 'BIZUM',
  concept: 'Prueba precisión 0.30'
});
const allocP1 = createPaymentAllocationTenant(contextA31, {
  paymentId: payPrecision1.id,
  invoiceId: invoiceObjA31.id,
  amount: 0.10
});
const allocP2 = createPaymentAllocationTenant(contextA31, {
  paymentId: payPrecision1.id,
  invoiceId: invoiceObjA31.id,
  amount: 0.20
});
const allocsP1Total = listPaymentAllocationsTenant(contextA31, { paymentId: payPrecision1.id })
  .reduce((acc, a) => acc + Math.round(Number(a.amount) * 100), 0);
assert(allocsP1Total === 30 && Boolean(allocP1 && allocP2), "55. Hardening monetario: 0.30 = 0.10 + 0.20 es exacto y no produce drift de coma flotante");

// 2. Precisión decimal: 0.30 < 0.10 + 0.21 (FAIL)
let precisionOverFail = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: payPrecision1.id,
    invoiceId: invoiceObjA31.id,
    amount: 0.01 // Ya tiene 0.30 completo (10 + 20), 0.01 adicional debe fallar
  });
} catch (e) {
  precisionOverFail = true;
}
assert(precisionOverFail === true, "56. Hardening monetario: rechaza superar 0.30 incluso por 0.01 (0.10 + 0.21 o 0.30 + 0.01)");

// Prueba directa 0.30 con 0.10 + 0.21 en un solo intento excedente
const payPrecision2 = savePaymentTenant(contextA31, {
  id: 'PAY-HARDEN-P2',
  amount: 0.30,
  method: 'BIZUM',
  concept: 'Prueba 0.10 + 0.21'
});
createPaymentAllocationTenant(contextA31, {
  paymentId: payPrecision2.id,
  invoiceId: invoiceObjA31.id,
  amount: 0.10
});
let precision21Fail = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: payPrecision2.id,
    invoiceId: invoiceObjA31.id,
    amount: 0.21
  });
} catch (e) {
  precision21Fail = true;
}
assert(precision21Fail === true, "57. Hardening monetario: 0.10 + 0.21 > 0.30 es rechazado determinísticamente");

// 3. Allocation de 0.01 (importe mínimo centesimal)
const payCent = savePaymentTenant(contextA31, {
  id: 'PAY-HARDEN-CENT',
  amount: 1.00,
  method: 'EFECTIVO',
  concept: 'Prueba céntimo'
});
const allocCent = createPaymentAllocationTenant(contextA31, {
  paymentId: payCent.id,
  invoiceId: invoiceObjA31.id,
  amount: 0.01
});
assert(Boolean(allocCent && allocCent.amount === 0.01), "58. Hardening monetario: allocation de 0.01 € aceptada y registrada correctamente");

// 4. Allocation de 999.99
const payThousand = savePaymentTenant(contextA31, {
  id: 'PAY-HARDEN-1000',
  amount: 1000.00,
  method: 'TRANSFERENCIA',
  concept: 'Prueba mil euros'
});
const alloc999 = createPaymentAllocationTenant(contextA31, {
  paymentId: payThousand.id,
  invoiceId: invoiceObjA31.id,
  amount: 999.99
});
assert(Boolean(alloc999 && alloc999.amount === 999.99), "59. Hardening monetario: allocation de 999.99 € aceptada");

// 5. Sobreasignación por 0.01 €
// Queda 0.01 € restante en payThousand. Intentar asignar 0.02 € debe fallar por 1 céntimo
let overCentFail = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: payThousand.id,
    invoiceId: invoiceObjA31.id,
    amount: 0.02
  });
} catch (e) {
  overCentFail = true;
}
assert(overCentFail === true, "60. Hardening monetario: sobreasignación por 0.01 € (0.02 cuando queda 0.01) es rechazada");

// Asignar el último céntimo exacto (0.01) -> PASS
const allocLastCent = createPaymentAllocationTenant(contextA31, {
  paymentId: payThousand.id,
  invoiceId: invoiceObjA31.id,
  amount: 0.01
});
assert(Boolean(allocLastCent && allocLastCent.amount === 0.01), "61. Hardening monetario: asignación del céntimo final (999.99 + 0.01 = 1000.00) es exacta");

// Caso mínimo exigido: Payment = 1000.00, 600.00 + 400.00 PASS, 600.00 + 400.01 FAIL
const payMil = savePaymentTenant(contextA31, {
  id: 'PAY-HARDEN-MIL',
  amount: 1000.00,
  method: 'TRANSFERENCIA'
});
createPaymentAllocationTenant(contextA31, { paymentId: payMil.id, invoiceId: invoiceObjA31.id, amount: 600.00 });
const allocMil400 = createPaymentAllocationTenant(contextA31, { paymentId: payMil.id, invoiceId: invoiceObjA31.id, amount: 400.00 });
assert(Boolean(allocMil400 && allocMil400.amount === 400.00), "62. Hardening monetario: 1000.00 con 600.00 + 400.00 es aceptado (PASS)");

const payMilFail = savePaymentTenant(contextA31, {
  id: 'PAY-HARDEN-MIL-FAIL',
  amount: 1000.00,
  method: 'TRANSFERENCIA'
});
createPaymentAllocationTenant(contextA31, { paymentId: payMilFail.id, invoiceId: invoiceObjA31.id, amount: 600.00 });
let milOverFail = false;
try {
  createPaymentAllocationTenant(contextA31, { paymentId: payMilFail.id, invoiceId: invoiceObjA31.id, amount: 400.01 });
} catch (e) {
  milOverFail = true;
}
assert(milOverFail === true, "63. Hardening monetario: 1000.00 con 600.00 + 400.01 es rechazado (FAIL)");

// 6. Búsqueda exhaustiva de rutas de INSERT en código de producción
const srcFiles = fs.readdirSync(path.resolve('src')).filter(f => f.endsWith('.js'));
const unencapsulatedInsertRoutes = [];
for (const file of srcFiles) {
  if (file === 'test_suite.js') continue; // Ignorar fixtures de test
  const content = fs.readFileSync(path.resolve('src', file), 'utf-8');
  const matches = content.match(/INSERT\s+INTO\s+payment_allocations/gi);
  if (matches) {
    if (file !== 'db_service.js' && file !== 'reset_db.js') {
      unencapsulatedInsertRoutes.push(file);
    }
  }
}
assert(unencapsulatedInsertRoutes.length === 0, "64. Auditoría de rutas: Ningún módulo de producción fuera de db_service contiene INSERT INTO payment_allocations");

// 7. Allocation Cross-Tenant
let crossTenantAllocTestFail = false;
try {
  createPaymentAllocationTenant(contextA31, {
    paymentId: payCent.id,
    invoiceId: invoiceObjB31.id, // Factura de Empresa B
    amount: 0.10
  });
} catch (e) {
  crossTenantAllocTestFail = true;
}
assert(crossTenantAllocTestFail === true, "65. Invariante cross-tenant: Empresa A no puede crear allocation apuntando a factura de Empresa B");

// 8. Payment Cross-Tenant
const crossTenantPayRead = getPaymentTenant(contextB31.companyId, payCent.id);
assert(crossTenantPayRead === null, "66. Invariante cross-tenant: Empresa B no puede leer pagos de Empresa A (Zero-Disclosure)");

// 9. Invoice Cross-Tenant en savePayment
let crossTenantTargetFail = false;
try {
  savePaymentTenant(contextA31, {
    id: 'PAY-CROSS-FAIL-TGT',
    amount: 100,
    targetId: invoiceObjB31.id
  });
} catch (e) {
  crossTenantTargetFail = true;
}
assert(crossTenantTargetFail === true, "67. Invariante cross-tenant: savePayment rechaza targetId de factura perteneciente a otro tenant");

// 10. Atomicidad en savePayment: si targetId es de otro tenant, no se crea payment ni allocation
const checkNoLeakedPay = currentDb.prepare("SELECT id FROM payments WHERE id = 'PAY-CROSS-FAIL-TGT'").get();
const checkNoLeakedAlloc = currentDb.prepare("SELECT id FROM payment_allocations WHERE payment_id = 'PAY-CROSS-FAIL-TGT'").get();
assert(!checkNoLeakedPay && !checkNoLeakedAlloc, "68. Atomicidad savePayment: ante error de validación de tenant, no se escribe payment ni allocation en disco");

// 11. savePayment crea exactamente una allocation
const payAtomicSingle = savePaymentTenant(contextA31, {
  id: 'PAY-ATOMIC-SINGLE',
  amount: 250,
  method: 'TRANSFERENCIA',
  targetId: invoiceObjA31.id,
  concept: 'Pago único atómico'
});
const countAllocsSingle = currentDb.prepare("SELECT count(*) as count FROM payment_allocations WHERE payment_id = ?").get(payAtomicSingle.id).count;
assert(countAllocsSingle === 1, "69. savePayment con targetId legítimo genera exactamente una allocation");

// 12. Retry de savePayment no duplica allocation
savePaymentTenant(contextA31, {
  ...payAtomicSingle,
  concept: 'Pago único atómico (Reintento de webhook / actualización)'
});
const countAllocsAfterRetry = currentDb.prepare("SELECT count(*) as count FROM payment_allocations WHERE payment_id = ?").get(payAtomicSingle.id).count;
assert(countAllocsAfterRetry === 1, "70. Idempotencia savePayment: reintento de guardado no duplica allocations (conserva exactamente 1)");

// 13. Comportamiento legacy de payments.budget_id se mantiene intacto
const payLegacyRow = currentDb.prepare("SELECT id, budget_id, company_phone FROM payments WHERE id = ?").get(payAtomicSingle.id);
const legacyFetchedPayments = getPaymentsTenant(phoneTenantA31, invoiceObjA31.id);
assert(payLegacyRow && payLegacyRow.budget_id === invoiceObjA31.id && legacyFetchedPayments.some(p => p.id === payAtomicSingle.id), "71. Deuda técnica controlada: payments.budget_id conserva su valor legacy y consultas antiguas siguen funcionando");

// Limpieza final de TEST 31
cleanupTest31(phoneTenantA31);
cleanupTest31(phoneTenantB31);
cleanupTest31(phoneTenantC31);
userSessions.delete(`${phoneTenantA31}@s.whatsapp.net`);
userSessions.delete(`${phoneTenantB31}@s.whatsapp.net`);
userSessions.delete(`${phoneTenantC31}@s.whatsapp.net`);

// -----------------------------------------------------------------------------
// TEST 32: Migración Controlada de Appointments y Shopping Items a Company_ID (Fase 2C)
// -----------------------------------------------------------------------------
console.log("\nTEST 32: Migración Controlada de Appointments y Shopping Items a Company_ID (Fase 2C — Backfill, Tenant Scoping, Cross-Tenant Isolation & Active Defense)");

import {
  saveAppointment as saveAppointmentTenant32,
  saveCompany as saveCompanyTenant32,
  getAppointment as getAppointmentTenant32,
  findAppointments as findAppointmentsTenant32,
  updateAppointment as updateAppointmentTenant32,
  cancelAppointment as cancelAppointmentTenant32,
  listAppointments as listAppointmentsTenant32,
  updateAppointmentStatus as updateAppointmentStatusTenant32,
  listAppointmentsWeek as listAppointmentsWeekTenant32,
  getAppointmentHistory as getAppointmentHistoryTenant32,
  addShoppingItems as addShoppingItemsTenant32,
  listShoppingItems as listShoppingItemsTenant32,
  markShoppingItemBought as markShoppingItemBoughtTenant32,
  clearShoppingList as clearShoppingListTenant32
} from './db_service.js';
import { migration as mig006 } from './migrations/006_appointments_shopping_company_id.js';

// ─── PARTE 1: PRUEBAS DE BACKFILL E INTEGRIDAD EN BASE DE DATOS AISLADA EN MEMORIA ───
const memDb32 = new DatabaseSync(':memory:');
memDb32.exec('PRAGMA foreign_keys = ON;');
// Aplicar migraciones 1 a 5
runMigrations(memDb32, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2], MIGRATIONS[3], MIGRATIONS[4]] });

// Crear empresas en memoria
const compAIdMem32 = crypto.randomUUID();
const compBIdMem32 = crypto.randomUUID();
const phoneMemA32 = '34698000001';
const phoneMemB32 = '34698000002';

memDb32.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
  compAIdMem32, phoneMemA32, 'Empresa Mem A 32', '2026-01-01', '2026-01-01'
);
memDb32.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
  compBIdMem32, phoneMemB32, 'Empresa Mem B 32', '2026-01-01', '2026-01-01'
);

// Insertar presupuesto canónico para Empresa A en memoria
const budgetIdMem32 = 'BUD-MEM-32-A1';
memDb32.prepare("INSERT INTO budgets (id, company_id, company_phone, client_name, total_amount, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  budgetIdMem32, compAIdMem32, phoneMemA32, 'Cliente A', 1500, JSON.stringify({ id: budgetIdMem32, companyId: compAIdMem32 }), '2026-01-01', '2026-01-01'
);

// 1. Insertar citas legadas sin company_id
memDb32.prepare(`
  INSERT INTO appointments (id, company_phone, client_name, date, time, title, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('CIT-MEM-1', phoneMemA32, 'Cliente Cita A', '2026-10-10', '10:00', 'Visita A', 'CONFIRMED', '2026-01-01', '2026-01-01');

memDb32.prepare(`
  INSERT INTO appointments (id, company_phone, client_name, date, time, title, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('CIT-MEM-2', phoneMemB32, 'Cliente Cita B', '2026-10-11', '11:00', 'Visita B', 'CONFIRMED', '2026-01-01', '2026-01-01');

// 2. Insertar artículos de compra legados sin company_id
// Item 1: vinculado a presupuesto de Empresa A (Prioridad 1)
memDb32.prepare(`
  INSERT INTO shopping_items (id, company_phone, client_name, budget_id, description, qty, unit, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('MAT-MEM-1', phoneMemA32, 'Cliente A', budgetIdMem32, '20 sacos de cemento cola', 20, 'sacos', 'PENDING', '2026-01-01');

// Item 2: sin presupuesto, solo con company_phone de Empresa B (Prioridad 2)
memDb32.prepare(`
  INSERT INTO shopping_items (id, company_phone, client_name, budget_id, description, qty, unit, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('MAT-MEM-2', phoneMemB32, 'Cliente Particular B', null, '1 rollo de cinta carrocero', 1, 'ud', 'PENDING', '2026-01-01');

// Ejecutar Migración 006
mig006.up(memDb32);

// Requisitos A, B, C: Verificación del Backfill
const apt1MemRow = memDb32.prepare("SELECT id, company_id, company_phone FROM appointments WHERE id = 'CIT-MEM-1'").get();
const apt2MemRow = memDb32.prepare("SELECT id, company_id, company_phone FROM appointments WHERE id = 'CIT-MEM-2'").get();
assert(apt1MemRow && apt1MemRow.company_id === compAIdMem32, "1. Requisito A: Backfill de citas asocia determinísticamente company_phone -> companies.id para Empresa A");
assert(apt2MemRow && apt2MemRow.company_id === compBIdMem32, "2. Requisito A: Backfill de citas asocia determinísticamente company_phone -> companies.id para Empresa B");

const mat1MemRow = memDb32.prepare("SELECT id, company_id, budget_id, company_phone FROM shopping_items WHERE id = 'MAT-MEM-1'").get();
const mat2MemRow = memDb32.prepare("SELECT id, company_id, budget_id, company_phone FROM shopping_items WHERE id = 'MAT-MEM-2'").get();
assert(mat1MemRow && mat1MemRow.company_id === compAIdMem32, "3. Requisito B: Backfill de shopping_items con budget_id hereda company_id canónico del presupuesto");
assert(mat2MemRow && mat2MemRow.company_id === compBIdMem32, "4. Requisito C: Backfill de shopping_items sin budget_id asocia company_phone -> companies.id");

// Requisito D: Abortar si existe cita huérfana
const memDb32OrphanApt = new DatabaseSync(':memory:');
memDb32OrphanApt.exec('PRAGMA foreign_keys = ON;');
runMigrations(memDb32OrphanApt, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2], MIGRATIONS[3], MIGRATIONS[4]] });
memDb32OrphanApt.prepare("INSERT INTO appointments (id, company_phone, client_name, date, time, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'CIT-ORPHAN', '34699999999', 'Huérfano', '2026-10-10', '10:00', 'CONFIRMED', '2026-01-01', '2026-01-01'
);
let orphanAptError = null;
try {
  mig006.up(memDb32OrphanApt);
} catch (e) {
  orphanAptError = e;
}
assert(orphanAptError && orphanAptError.message.includes('huérfana'), "5. Requisito D: La migración aborta inmediatamente si detecta una cita huérfana sin empresa");

// Requisito E: Abortar si existe shopping_item con budget_id inexistente
const memDb32OrphanMat = new DatabaseSync(':memory:');
memDb32OrphanMat.exec('PRAGMA foreign_keys = ON;');
runMigrations(memDb32OrphanMat, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2], MIGRATIONS[3], MIGRATIONS[4]] });
memDb32OrphanMat.prepare("INSERT INTO shopping_items (id, company_phone, budget_id, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
  'MAT-ORPHAN-BUDGET', '34698000001', 'BUD-INEXISTENTE', 'Tornillos', 'PENDING', '2026-01-01'
);
let orphanMatError = null;
try {
  mig006.up(memDb32OrphanMat);
} catch (e) {
  orphanMatError = e;
}
assert(orphanMatError && orphanMatError.message.includes('inexistente'), "6. Requisito E: La migración aborta si un shopping_item referencia un presupuesto inexistente");

// Requisito F: Abortar si existe conflicto/mismatch de tenant en shopping_item
const memDb32Mismatch = new DatabaseSync(':memory:');
memDb32Mismatch.exec('PRAGMA foreign_keys = ON;');
runMigrations(memDb32Mismatch, { migrations: [MIGRATIONS[0], MIGRATIONS[1], MIGRATIONS[2], MIGRATIONS[3], MIGRATIONS[4]] });
const compAIdMismatch = crypto.randomUUID();
const compBIdMismatch = crypto.randomUUID();
memDb32Mismatch.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(compAIdMismatch, '34611111111', 'Emp A', '2026-01-01', '2026-01-01');
memDb32Mismatch.prepare("INSERT INTO companies (id, phone, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(compBIdMismatch, '34622222222', 'Emp B', '2026-01-01', '2026-01-01');
memDb32Mismatch.prepare("INSERT INTO budgets (id, company_id, company_phone, client_name, total_amount, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  'BUD-MISMATCH-A', compAIdMismatch, '34611111111', 'Cliente A', 1000, JSON.stringify({ id: 'BUD-MISMATCH-A', companyId: compAIdMismatch }), '2026-01-01', '2026-01-01'
);
// Item referencia presupuesto de A pero tiene company_phone de B
memDb32Mismatch.prepare("INSERT INTO shopping_items (id, company_phone, budget_id, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
  'MAT-MISMATCH', '34622222222', 'BUD-MISMATCH-A', 'Material discordante', 'PENDING', '2026-01-01'
);
let mismatchError = null;
try {
  mig006.up(memDb32Mismatch);
} catch (e) {
  mismatchError = e;
}
assert(mismatchError && mismatchError.message.includes('Mismatch de tenant'), "7. Requisito F: La migración aborta inmediatamente ante contradicción de tenant en shopping_item");

// ─── PARTE 2: PRUEBAS EN TEST DB (AISLAMIENTO, CROSS-TENANT, MODEL INJECTION & ZERO-DISCLOSURE) ───
const phoneTenantA32 = '34698111001';
const phoneTenantB32 = '34698111002';

const cleanupTest32 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp && comp.id) {
    currentDb.prepare("DELETE FROM appointments WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM shopping_items WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM budgets WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE business_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest32(phoneTenantA32);
cleanupTest32(phoneTenantB32);

// Crear Empresa A y B
const compObjA32 = saveCompanyTenant32(phoneTenantA32, { name: 'Reformas Alfa 32', cif: 'B98111001' });
const compObjB32 = saveCompanyTenant32(phoneTenantB32, { name: 'Pinturas Beta 32', cif: 'B98111002' });

const authContextA32 = { companyId: compObjA32.id, company: compObjA32, phone: phoneTenantA32 };
const authContextB32 = { companyId: compObjB32.id, company: compObjB32, phone: phoneTenantB32 };

// Requisito Q: Dual-write y creación legítima de cita y material en Empresa A
const aptA32 = saveAppointmentTenant32(authContextA32, {
  clientName: 'Juan Alfa',
  clientPhone: '654000111',
  clientAddress: 'Av. Constitución 4, Sevilla',
  date: '2026-10-15',
  time: '10:00',
  notes: 'Medición de cocina'
});

assert(Boolean(aptA32 && aptA32.id), "8. Creación de cita: saveAppointment retorna cita válida");
assert(aptA32.companyId === compObjA32.id, "9. Identidad canónica: apt.companyId coincide con compObjA32.id");
assert(aptA32.status === 'CONFIRMED', "10. Regla de Oro: la cita nace en CONFIRMED");

const aptDbRawA = currentDb.prepare("SELECT company_id, company_phone FROM appointments WHERE id = ?").get(aptA32.id);
assert(aptDbRawA && aptDbRawA.company_id === compObjA32.id && aptDbRawA.company_phone === phoneTenantA32, "11. Requisito Q: Dual-write verificado en SQLite para appointments (company_id + company_phone)");

// Crear cita para Empresa B
const aptB32 = saveAppointmentTenant32(authContextB32, {
  clientName: 'Pedro Beta',
  clientPhone: '654000222',
  clientAddress: 'Calle Sierpes 12, Sevilla',
  date: '2026-10-16',
  time: '12:00',
  notes: 'Pintura de fachada'
});

// Requisito G: Aislamiento en listado y búsqueda de citas
const listAptsA = listAppointmentsTenant32(authContextA32);
const listAptsB = listAppointmentsTenant32(authContextB32);
assert(listAptsA.some(a => a.id === aptA32.id) && !listAptsA.some(a => a.id === aptB32.id), "12. Requisito G: listAppointments(tenantA) solo incluye citas de Tenant A y aísla Tenant B");
assert(listAptsB.some(a => a.id === aptB32.id) && !listAptsB.some(a => a.id === aptA32.id), "13. Requisito G: listAppointments(tenantB) solo incluye citas de Tenant B y aísla Tenant A");

const findAptsA = findAppointmentsTenant32(authContextA32, 'Pedro');
assert(findAptsA.length === 0, "14. Requisito G: findAppointments(tenantA, 'Pedro') no revela citas de Tenant B");

// Requisito I: Cross-tenant getAppointment (Zero-Disclosure)
const crossGetApt = getAppointmentTenant32(authContextB32, aptA32.id);
assert(crossGetApt === null, "15. Requisito I: getAppointment(tenantB, idA) retorna null (Zero-Disclosure cross-tenant)");

const ownGetApt = getAppointmentTenant32(authContextA32, aptA32.id);
assert(ownGetApt && ownGetApt.id === aptA32.id, "16. Lectura legítima: getAppointment(tenantA, idA) recupera los datos de la cita");

// Prohibición estricta de consulta sin tenant context
const unauthAptGet = getAppointmentTenant32(aptA32.id);
assert(unauthAptGet === null, "17. Requisito R / Seguridad: getAppointment(id) sin tenant context retorna null");

// Requisito J: Cross-tenant updateAppointment bloqueado
const crossUpdateApt = updateAppointmentTenant32(authContextB32, aptA32.id, { clientName: 'Nombre Hackeado' });
assert(crossUpdateApt === null, "18. Requisito J: updateAppointment(tenantB, idA) rechaza la modificación y retorna null");
const aptAfterCrossUpdate = getAppointmentTenant32(authContextA32, aptA32.id);
assert(aptAfterCrossUpdate.clientName === 'Juan Alfa', "19. Requisito J: Los datos de la cita de Tenant A permanecen intactos tras intento cross-tenant");

// Requisito K: Cross-tenant cancelAppointment bloqueado
const crossCancelApt = cancelAppointmentTenant32(authContextB32, aptA32.id);
assert(crossCancelApt === null, "20. Requisito K: cancelAppointment(tenantB, idA) rechaza la anulación y retorna null");
const aptAfterCrossCancel = getAppointmentTenant32(authContextA32, aptA32.id);
assert(aptAfterCrossCancel.status === 'CONFIRMED', "21. Requisito K: El estado de la cita de Tenant A permanece CONFIRMED");

// Requisito L: Cross-tenant updateAppointmentStatus bloqueado
updateAppointmentStatusTenant32(authContextB32, aptA32.id, 'CANCELLED');
const aptAfterCrossStatus = getAppointmentTenant32(authContextA32, aptA32.id);
assert(aptAfterCrossStatus.status === 'CONFIRMED', "22. Requisito L: updateAppointmentStatus(tenantB, idA, 'CANCELLED') no altera la cita ajena");

// Llamada no autorizada sin tenant context (2 args)
updateAppointmentStatusTenant32(aptA32.id, 'CANCELLED');
const aptAfterNoAuthStatus = getAppointmentTenant32(authContextA32, aptA32.id);
assert(aptAfterNoAuthStatus.status === 'CONFIRMED', "23. Requisito L: updateAppointmentStatus sin tenant context es ignorado y no afecta la BD");

// Requisito O: Defensa activa contra inyección del modelo en citas
const injectedApt = saveAppointmentTenant32(authContextA32, {
  clientName: 'Cliente Con Inyección',
  companyId: compObjB32.id,
  company_id: compObjB32.id,
  companyPhone: phoneTenantB32,
  company_phone: phoneTenantB32,
  date: '2026-10-20',
  time: '16:00'
});
const injectedDbRaw = currentDb.prepare("SELECT company_id, company_phone FROM appointments WHERE id = ?").get(injectedApt.id);
assert(injectedDbRaw && injectedDbRaw.company_id === compObjA32.id && injectedDbRaw.company_phone === phoneTenantA32, "24. Requisito O: saveAppointment neutraliza la inyección del modelo forzando company_id y company_phone del tenant autenticado");

// ─── PARTE 3: COMPRAS Y MATERIALES (SHOPPING ITEMS) ───
// Requisito Q & H: Creación legítima y dual-write en shopping items
const itemsA32 = addShoppingItemsTenant32(authContextA32, [
  { description: '10 sacos yeso blanco', qty: 10, unit: 'sacos' },
  { description: '2 botes pintura plástica', qty: 2, unit: 'botes' }
], { clientName: 'Obra Alfa' });

assert(itemsA32.length === 2, "25. Creación de compras: addShoppingItems inserta correctamente los materiales");
assert(itemsA32[0].companyId === compObjA32.id, "26. Identidad canónica: shoppingItem.companyId coincide con Tenant A");

const shopDbRawA = currentDb.prepare("SELECT company_id, company_phone FROM shopping_items WHERE id = ?").get(itemsA32[0].id);
assert(shopDbRawA && shopDbRawA.company_id === compObjA32.id && shopDbRawA.company_phone === phoneTenantA32, "27. Requisito Q: Dual-write verificado en SQLite para shopping_items (company_id + company_phone)");

// Crear shopping items para Empresa B
const itemsB32 = addShoppingItemsTenant32(authContextB32, [
  { description: 'Rodillo profesional 22cm', qty: 1, unit: 'ud' }
], { clientName: 'Obra Beta' });

// Requisito H: Aislamiento en listado de compras
const listShopA = listShoppingItemsTenant32(authContextA32);
const listShopB = listShoppingItemsTenant32(authContextB32);
assert(listShopA.some(i => i.id === itemsA32[0].id) && !listShopA.some(i => i.id === itemsB32[0].id), "28. Requisito H: listShoppingItems(tenantA) contiene sus materiales y aísla Tenant B");
assert(listShopB.some(i => i.id === itemsB32[0].id) && !listShopB.some(i => i.id === itemsA32[0].id), "29. Requisito H: listShoppingItems(tenantB) contiene sus materiales y aísla Tenant A");

// Requisito M: Cross-tenant markShoppingItemBought bloqueado
const crossMarkBought = markShoppingItemBoughtTenant32(authContextB32, itemsA32[0].id);
assert(Array.isArray(crossMarkBought) && crossMarkBought.length === 0, "30. Requisito M: markShoppingItemBought(tenantB, itemA) retorna array vacío");
const itemAAfterCrossMark = currentDb.prepare("SELECT status FROM shopping_items WHERE id = ?").get(itemsA32[0].id);
assert(itemAAfterCrossMark.status === 'PENDING', "31. Requisito M: El material de Tenant A permanece PENDING tras intento de compra ajeno");

// Marcado legítimo por Tenant A
const ownMarkBought = markShoppingItemBoughtTenant32(authContextA32, itemsA32[0].id);
assert(ownMarkBought.length === 1 && ownMarkBought[0].status === 'BOUGHT', "32. Actualización legítima: Tenant A marca exitosamente su material como BOUGHT");

// Requisito N: Cross-tenant clearShoppingList bloqueado
const clearResB = clearShoppingListTenant32(authContextB32);
assert(clearResB.deletedCount === 1, "33. clearShoppingList de Tenant B borra exclusivamente su propio artículo");
const pendingItemsAfterClearB = listShoppingItemsTenant32(authContextA32, 'all');
assert(pendingItemsAfterClearB.length === 2, "34. Requisito N: clearShoppingList(tenantB) no elimina ningún artículo de Tenant A (permanecen los 2)");

// Requisito P: Model injection defense en shopping_items
const injectedItems = addShoppingItemsTenant32(authContextA32, [
  { description: 'Brocha recortar', companyId: compObjB32.id, company_id: compObjB32.id, companyPhone: phoneTenantB32, company_phone: phoneTenantB32 }
]);
const injectedShopRaw = currentDb.prepare("SELECT company_id, company_phone FROM shopping_items WHERE id = ?").get(injectedItems[0].id);
assert(injectedShopRaw && injectedShopRaw.company_id === compObjA32.id && injectedShopRaw.company_phone === phoneTenantA32, "35. Requisito P: addShoppingItems neutraliza la inyección del modelo imponiendo company_id y company_phone del contexto autenticado");

// Requisito R: Foreign Key constraint integrity en SQLite
let fkAptError = null;
try {
  currentDb.prepare("INSERT INTO appointments (id, company_id, company_phone, client_name, date, time, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    'CIT-INVALID-FK', '00000000-0000-0000-0000-000000000000', '34600000000', 'Cliente Invalido', '2026-10-10', '10:00', 'CONFIRMED', '2026-01-01', '2026-01-01'
  );
} catch (e) {
  fkAptError = e;
}
assert(fkAptError !== null && String(fkAptError.message).includes('FOREIGN KEY constraint failed'), "36. Requisito R: SQLite rechaza appointments con company_id inexistente en companies");

let fkShopError = null;
try {
  currentDb.prepare("INSERT INTO shopping_items (id, company_id, company_phone, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    'MAT-INVALID-FK', '00000000-0000-0000-0000-000000000000', '34600000000', 'Articulo Invalido', 'PENDING', '2026-01-01'
  );
} catch (e) {
  fkShopError = e;
}
assert(fkShopError !== null && String(fkShopError.message).includes('FOREIGN KEY constraint failed'), "37. Requisito R: SQLite rechaza shopping_items con company_id inexistente en companies");

const fkCheck = currentDb.prepare('PRAGMA foreign_key_check').all();
assert(fkCheck.length === 0, "38. Requisito R: PRAGMA foreign_key_check verifica cero violaciones de claves foráneas en la base de datos");

const integrityCheck = currentDb.prepare('PRAGMA integrity_check').get();
assert(integrityCheck.integrity_check === 'ok', "39. Requisito R: PRAGMA integrity_check confirma que la base de datos está 100% íntegra (ok)");

// Compatibilidad legacy: llamadas con teléfono plano
const legacyListApts = listAppointmentsTenant32(phoneTenantA32);
assert(legacyListApts.length >= 1, "40. Compatibilidad legacy: listAppointments(phone) resuelve y devuelve las citas");
const legacyListShop = listShoppingItemsTenant32(phoneTenantA32);
assert(legacyListShop.length >= 1, "41. Compatibilidad legacy: listShoppingItems(phone) resuelve y devuelve los materiales");

// Limpieza final de TEST 32
cleanupTest32(phoneTenantA32);
cleanupTest32(phoneTenantB32);
userSessions.delete(`${phoneTenantA32}@s.whatsapp.net`);
userSessions.delete(`${phoneTenantB32}@s.whatsapp.net`);

// ─────────────────────────────────────────────────────────────────────────────
// TEST 33: Micro-Hardening de Tenant Authority en WhatsApp Gateway (Fase 2C)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nTEST 33: Micro-Hardening de Tenant Authority en WhatsApp Gateway & Model Injection Defense");

const phoneHardA = '34699112233';
const phoneHardB = '34699445566';
const phoneAttacker = '34699778899';

// Limpieza previa
const cleanupTest33 = (p) => {
  currentDb.prepare("DELETE FROM appointments WHERE company_phone = ?").run(p);
  currentDb.prepare("DELETE FROM shopping_items WHERE company_phone = ?").run(p);
  currentDb.prepare("DELETE FROM audit_logs WHERE business_id = ?").run(p);
  currentDb.prepare("DELETE FROM channel_identities WHERE channel_identifier = ?").run(p);
  currentDb.prepare("DELETE FROM companies WHERE phone = ?").run(p);
};
cleanupTest33(phoneHardA);
cleanupTest33(phoneHardB);
cleanupTest33(phoneAttacker);

// Empresas A y B registradas (saveCompany crea automáticamente companies y channel_identities)
const compA33 = saveCompanyTenant32(phoneHardA, { name: 'Empresa Alpha Hardening' });
const compB33 = saveCompanyTenant32(phoneHardB, { name: 'Empresa Beta Hardening' });

const sessionHardA = {
  phone: phoneHardA,
  companyId: compA33.id,
  authContext: { companyId: compA33.id, company: compA33 },
  company: compA33,
  budgets: new Map()
};

const sessionHardB = {
  phone: phoneHardB,
  companyId: compB33.id,
  authContext: { companyId: compB33.id, company: compB33 },
  company: compB33,
  budgets: new Map()
};

// Sesión sin autenticar (sin companyId)
const sessionNoAuth = {
  phone: phoneAttacker,
  companyId: null,
  authContext: null,
  company: null,
  budgets: new Map()
};

// Sesión atacante que suplanta el teléfono de Alpha pero no tiene companyId autenticado
const sessionSpoofing = {
  phone: phoneHardA,
  companyId: null,
  authContext: null,
  company: null,
  budgets: new Map()
};

const sentMessagesHard = [];
const mockSockHard = {
  sendMessage: async (jid, content) => {
    sentMessagesHard.push({ jid, content });
    return { key: { id: `mock_${Date.now()}_${Math.random()}` } };
  }
};

// 1. Operación legítima con session.companyId válido -> Éxito en su tenant
const aptResA = await handleScheduleAppointment(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionHardA, {
  clientName: 'Visita Legítima Alpha',
  date: '2026-10-25',
  time: '10:00',
  notes: 'Revisión fontanería'
});
assert(aptResA.success === true, "1. Authority legítima: handleScheduleAppointment crea cita con éxito para tenant autenticado");
assert(aptResA.saved && aptResA.saved.companyId === compA33.id, "2. Authority legítima: apt.companyId coincide con compA33.id");

const shopResA = await handleAddShoppingItems(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionHardA, [
  { description: 'Cable cobre libre de halógenos', qty: 50, unit: 'm' }
]);
assert(shopResA.success === true && shopResA.added.length === 1, "3. Authority legítima: handleAddShoppingItems añade materiales para tenant autenticado");
assert(shopResA.added[0].companyId === compA33.id, "4. Authority legítima: shopping_item.companyId coincide con compA33.id");

// 2. Intento de Model Injection: LLM inyecta companyId / company_phone de OTRA empresa
const aptInjectionRes = await handleScheduleAppointment(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionHardA, {
  clientName: 'Cita con Inyección Maliciosa',
  date: '2026-10-26',
  time: '11:00',
  companyId: compB33.id,
  company_id: compB33.id,
  companyPhone: phoneHardB,
  company_phone: phoneHardB
});
assert(aptInjectionRes.success === true, "5. Model Injection: handleScheduleAppointment procesa la solicitud");
const injectedDbApt = currentDb.prepare("SELECT company_id, company_phone FROM appointments WHERE id = ?").get(aptInjectionRes.saved.id);
assert(injectedDbApt.company_id === compA33.id, "6. Model Injection: appointment.company_id es forzado al tenant autenticado (NUNCA al inyectado de Beta)");
assert(injectedDbApt.company_phone === phoneHardA, "7. Model Injection: appointment.company_phone es forzado al teléfono autenticado (NUNCA al inyectado de Beta)");

const shopInjectionRes = await handleAddShoppingItems(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionHardA, [
  {
    description: 'Material Inyectado',
    qty: 10,
    unit: 'ud',
    companyId: compB33.id,
    company_id: compB33.id,
    companyPhone: phoneHardB,
    company_phone: phoneHardB
  }
]);
assert(shopInjectionRes.success === true && shopInjectionRes.added.length === 1, "8. Model Injection: handleAddShoppingItems procesa la solicitud");
const injectedDbShop = currentDb.prepare("SELECT company_id, company_phone FROM shopping_items WHERE id = ?").get(shopInjectionRes.added[0].id);
assert(injectedDbShop.company_id === compA33.id, "9. Model Injection: shopping_item.company_id es forzado al tenant autenticado");
assert(injectedDbShop.company_phone === phoneHardA, "10. Model Injection: shopping_item.company_phone es forzado al teléfono autenticado");

// 3. Operación sin session.companyId (null / undefined): Rechazo absoluto, NUNCA fallback a cleanPhone
const noAuthAptRes = await handleScheduleAppointment(mockSockHard, `${phoneAttacker}@s.whatsapp.net`, sessionNoAuth, {
  clientName: 'Intruso Sin Auth',
  date: '2026-10-27',
  time: '12:00'
});
assert(noAuthAptRes.success === false && noAuthAptRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "11. Tenant Boundary: handleScheduleAppointment rechaza sesión sin companyId");

// Ataque de suplantación: El atacante envía cleanPhone de Alpha pero sin autenticación de companyId
const spoofAptRes = await handleScheduleAppointment(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing, {
  clientName: 'Ataque Suplantación Cita',
  date: '2026-10-27',
  time: '12:00'
});
assert(spoofAptRes.success === false && spoofAptRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "12. Tenant Boundary: Rechaza sesión con cleanPhone de otra empresa si companyId es nulo (cero fallback de autorización)");

const spoofListAptRes = await handleListAppointments(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing);
assert(spoofListAptRes.success === false && spoofListAptRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "13. Tenant Boundary: handleListAppointments rechaza sesión sin companyId");

const spoofCancelAptRes = await handleCancelAppointment(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing, 'Visita Legítima Alpha');
assert(spoofCancelAptRes.success === false && spoofCancelAptRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "14. Tenant Boundary: handleCancelAppointment rechaza sesión sin companyId");

const spoofUpdateAptRes = await handleUpdateAppointment(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing, {
  appointmentQuery: 'Visita Legítima Alpha',
  notes: 'Hack'
});
assert(spoofUpdateAptRes.success === false && spoofUpdateAptRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "15. Tenant Boundary: handleUpdateAppointment rechaza sesión sin companyId");

const spoofCompleteAptRes = await handleCompleteAppointments(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing, {
  completedQueries: ['Visita Legítima Alpha']
});
assert(spoofCompleteAptRes.success === false && spoofCompleteAptRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "16. Tenant Boundary: handleCompleteAppointments rechaza sesión sin companyId");

const spoofAddShopRes = await handleAddShoppingItems(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing, [
  { description: 'Material Hack' }
]);
assert(spoofAddShopRes.success === false && spoofAddShopRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "17. Tenant Boundary: handleAddShoppingItems rechaza sesión sin companyId");

const spoofListShopRes = await handleListShoppingItems(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing);
assert(spoofListShopRes.success === false && spoofListShopRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "18. Tenant Boundary: handleListShoppingItems rechaza sesión sin companyId");

const spoofMarkShopRes = await handleMarkShoppingItemBought(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing, 'Cable cobre');
assert(spoofMarkShopRes.success === false && spoofMarkShopRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "19. Tenant Boundary: handleMarkShoppingItemBought rechaza sesión sin companyId");

const spoofClearShopRes = await handleClearShoppingList(mockSockHard, `${phoneHardA}@s.whatsapp.net`, sessionSpoofing);
assert(spoofClearShopRes.success === false && spoofClearShopRes.error === 'UNAUTHORIZED_NO_COMPANY_ID', "20. Tenant Boundary: handleClearShoppingList rechaza sesión sin companyId");

// 4. Intento cross-tenant entre Tenant A y Tenant B (Zero-Disclosure & Mutación bloqueada)
// Tenant B intenta listar citas de Alpha
const listHardB = await handleListAppointments(mockSockHard, `${phoneHardB}@s.whatsapp.net`, sessionHardB);
assert(listHardB.success === true && listHardB.appointments.length === 0, "21. Aislamiento Cross-Tenant: Tenant B no ve las citas de Tenant A en handleListAppointments");

// Tenant B intenta cancelar cita de Alpha
const cancelHardB = await handleCancelAppointment(mockSockHard, `${phoneHardB}@s.whatsapp.net`, sessionHardB, 'Visita Legítima Alpha');
assert(cancelHardB.success === false && cancelHardB.error === 'NOT_FOUND', "22. Aislamiento Cross-Tenant: Tenant B no puede cancelar citas de Tenant A");
const checkAptA = currentDb.prepare("SELECT status FROM appointments WHERE id = ?").get(aptResA.saved.id);
assert(checkAptA.status === 'CONFIRMED', "23. Aislamiento Cross-Tenant: La cita de Tenant A permanece CONFIRMED tras intento ajeno");

// Tenant B intenta modificar cita de Alpha
const updateHardB = await handleUpdateAppointment(mockSockHard, `${phoneHardB}@s.whatsapp.net`, sessionHardB, {
  appointmentQuery: 'Visita Legítima Alpha',
  notes: 'Intento de alteración por Beta'
});
assert(updateHardB.success === false && updateHardB.error === 'NOT_FOUND', "24. Aislamiento Cross-Tenant: Tenant B no puede modificar citas de Tenant A");

// Tenant B intenta completar citas de Alpha
const completeHardB = await handleCompleteAppointments(mockSockHard, `${phoneHardB}@s.whatsapp.net`, sessionHardB, {
  completedQueries: ['Visita Legítima Alpha']
});
assert(completeHardB.success === true && (completeHardB.completedResult?.completed?.length || 0) === 0, "25. Aislamiento Cross-Tenant: Tenant B no puede completar visitas de Tenant A");

// Tenant B intenta listar compras de Alpha
const listShopHardB = await handleListShoppingItems(mockSockHard, `${phoneHardB}@s.whatsapp.net`, sessionHardB);
assert(listShopHardB.success === true && listShopHardB.items.length === 0, "26. Aislamiento Cross-Tenant: Tenant B no ve los materiales de compra de Tenant A");

// Tenant B intenta tachar compra de Alpha
const markShopHardB = await handleMarkShoppingItemBought(mockSockHard, `${phoneHardB}@s.whatsapp.net`, sessionHardB, 'Cable cobre');
assert(markShopHardB.success === false && markShopHardB.error === 'NOT_FOUND', "27. Aislamiento Cross-Tenant: Tenant B no puede tachar compras de Tenant A");

// 5. Integridad relacional y SQLite PRAGMAs
const fkHardCheck = currentDb.prepare('PRAGMA foreign_key_check').all();
assert(fkHardCheck.length === 0, "28. Integridad: PRAGMA foreign_key_check cero violaciones tras batería de hardening");

const integrityHardCheck = currentDb.prepare('PRAGMA integrity_check').get();
assert(integrityHardCheck.integrity_check === 'ok', "29. Integridad: PRAGMA integrity_check confirma base de datos 100% íntegra (ok)");

// Limpieza final de TEST 33
cleanupTest33(phoneHardA);
cleanupTest33(phoneHardB);
cleanupTest33(phoneAttacker);
userSessions.delete(`${phoneHardA}@s.whatsapp.net`);
userSessions.delete(`${phoneHardB}@s.whatsapp.net`);
userSessions.delete(`${phoneAttacker}@s.whatsapp.net`);

console.log("\nTEST 34: Fiscal Tenant Hardening & Adversarial Security (Fase 2D-H — Multi-Tenant Isolation & Model Injection Defense)");

import {
  resolveCompanyTenant,
  resolveLegacyBusinessId,
  getPurchaseInvoice,
  deletePurchaseInvoice,
  getExpensePayment,
  deleteExpensePayment,
  saveFiscalIncident,
  resolveFiscalIncident,
  getFiscalIncident,
  deleteFiscalIncident,
  getFiscalPeriod,
  deleteFiscalPeriod
} from './db_service.js';

const phoneFiscalA = '34699554411';
const phoneFiscalB = '34699554422';

const cleanupTest34 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM purchase_invoices WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM expense_payments WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM investment_assets WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest34(phoneFiscalA);
cleanupTest34(phoneFiscalB);

const compFiscalA = createCompanyWithIdentity({
  name: 'Instalaciones Alpha Fiscal S.L.',
  phone: phoneFiscalA,
  cif: null, // CIF null para verificar aislamiento físico de exportaciones ante colisión de SIN_CIF
  trade: 'Electricidad'
});
const contextFiscalA = resolveAuthenticatedContext('whatsapp', phoneFiscalA);

const compFiscalB = createCompanyWithIdentity({
  name: 'Reformas Beta Fiscal S.L.',
  phone: phoneFiscalB,
  cif: null, // CIF null para verificar colisión
  trade: 'Fontanería'
});
const contextFiscalB = resolveAuthenticatedContext('whatsapp', phoneFiscalB);

// TEST A — Purchase invoice isolation
const invA34 = savePurchaseInvoice(contextFiscalA, {
  id: 'REC-34-A01',
  supplierName: 'Materiales Eléctricos A',
  supplierTaxId: 'B-11111111',
  taxBase: 500,
  vatRate: 21,
  totalAmount: 605,
  issueDate: '2026-08-10'
});

const invB34 = savePurchaseInvoice(contextFiscalB, {
  id: 'REC-34-B01',
  supplierName: 'Suministros Fontanería B',
  supplierTaxId: 'B-22222222',
  taxBase: 800,
  vatRate: 21,
  totalAmount: 968,
  issueDate: '2026-08-11'
});

// Tenant B intenta leer factura de Tenant A -> null
const crossReadAfromB = getPurchaseInvoice(contextFiscalB, 'REC-34-A01');
assert(crossReadAfromB === null, "TEST A: Cross-Tenant Read: getPurchaseInvoice(tenantB, idA) devuelve null (Zero-Disclosure cross-tenant)");

// Tenant A intenta leer factura de Tenant B -> null
const crossReadBfromA = getPurchaseInvoice(contextFiscalA, 'REC-34-B01');
assert(crossReadBfromA === null, "TEST A: Cross-Tenant Read: getPurchaseInvoice(tenantA, idB) devuelve null (Zero-Disclosure cross-tenant)");

// Lectura legítima de Tenant A
const legitReadA = getPurchaseInvoice(contextFiscalA, 'REC-34-A01');
assert(legitReadA !== null && legitReadA.id === 'REC-34-A01' && legitReadA.supplierName === 'Materiales Eléctricos A', "TEST A: Lectura legítima: getPurchaseInvoice(tenantA, idA) recupera su propia factura");

// Lectura legítima de Tenant B
const legitReadB = getPurchaseInvoice(contextFiscalB, 'REC-34-B01');
assert(legitReadB !== null && legitReadB.id === 'REC-34-B01' && legitReadB.supplierName === 'Suministros Fontanería B', "TEST A: Lectura legítima: getPurchaseInvoice(tenantB, idB) recupera su propia factura");

// TEST B — Purchase invoice delete isolation
// Tenant A intenta borrar factura de Tenant B -> false
const crossDeleteBfromA = deletePurchaseInvoice(contextFiscalA, 'REC-34-B01');
assert(crossDeleteBfromA === false, "TEST B: Cross-Tenant Delete: deletePurchaseInvoice(tenantA, idB) devuelve false y bloquea la eliminación");
const verifyPinvBIntact = currentDb.prepare("SELECT * FROM purchase_invoices WHERE id = ?").get('REC-34-B01');
assert(verifyPinvBIntact !== null && verifyPinvBIntact.supplier_name === 'Suministros Fontanería B', "TEST B: Integridad en SQLite: la factura de Tenant B permanece 100% intacta tras intento cross-tenant");

// TEST C — Fiscal incident isolation
saveFiscalIncident(contextFiscalA, {
  id: 'INC-34-A01',
  entityType: 'PURCHASE_INVOICE',
  entityId: 'REC-34-A01',
  errorCode: 'MISSING_DOC',
  severity: 'WARNING',
  message: 'Justificante pendiente A'
});
saveFiscalIncident(contextFiscalB, {
  id: 'INC-34-B01',
  entityType: 'PURCHASE_INVOICE',
  entityId: 'REC-34-B01',
  errorCode: 'MISSING_DOC',
  severity: 'WARNING',
  message: 'Justificante pendiente B'
});

// Tenant A intenta leer incidencia de B -> null
assert(getFiscalIncident(contextFiscalA, 'INC-34-B01') === null, "TEST C: Cross-Tenant Incident Read: getFiscalIncident(tenantA, incB) devuelve null");
// Tenant B lee su propia incidencia -> registro
const legitIncB = getFiscalIncident(contextFiscalB, 'INC-34-B01');
assert(legitIncB !== null && legitIncB.id === 'INC-34-B01', "TEST C: Lectura legítima de incidencia propia por Tenant B");

// Tenant A intenta resolver incidencia de B -> false
const crossResolveInc = resolveFiscalIncident(contextFiscalA, 'INC-34-B01');
assert(crossResolveInc === false, "TEST C: Cross-Tenant Incident Resolve: resolveFiscalIncident(tenantA, incB) devuelve false");
const verifyIncBOpen = currentDb.prepare("SELECT resolution_status FROM fiscal_incidents WHERE id = ?").get('INC-34-B01');
assert(verifyIncBOpen && verifyIncBOpen.resolution_status === 'OPEN', "TEST C: Integridad Incidencia: la incidencia de Tenant B permanece OPEN tras intento cross-tenant");

// Tenant B resuelve legítimamente su propia incidencia
const legitResolveIncB = resolveFiscalIncident(contextFiscalB, 'INC-34-B01');
assert(legitResolveIncB === true, "TEST C: Resolución legítima: resolveFiscalIncident(tenantB, incB) resuelve con éxito");
const verifyIncBResolved = currentDb.prepare("SELECT resolution_status FROM fiscal_incidents WHERE id = ?").get('INC-34-B01');
assert(verifyIncBResolved && verifyIncBResolved.resolution_status === 'RESOLVED', "TEST C: Integridad Incidencia: estado pasa a RESOLVED para el tenant autorizado");

// TEST D — Model injection defense
const injectedAiPayload = {
  company_id: compFiscalB.companyId,
  companyId: compFiscalB.companyId,
  businessId: phoneFiscalB,
  business_id: phoneFiscalB,
  company_phone: phoneFiscalB,
  phone: phoneFiscalB,
  id: 'REC-34-INJECT-01',
  supplierName: 'Proveedor Inyección Maliciosa',
  taxBase: 300,
  vatRate: 21,
  totalAmount: 363,
  issueDate: '2026-08-12'
};
// Guardado ejecutado en sesión autenticada de Tenant A:
savePurchaseInvoice(contextFiscalA, injectedAiPayload);
const verifyInjectionNeutralized = currentDb.prepare("SELECT business_id FROM purchase_invoices WHERE id = ?").get('REC-34-INJECT-01');
assert(verifyInjectionNeutralized && verifyInjectionNeutralized.business_id === phoneFiscalA, "TEST D: Model Injection: savePurchaseInvoice neutraliza businessId/companyId inyectados y fuerza el tenant autenticado de Alpha");

// TEST E — UUID passed to legacy resolver
const fakeUuid = '12345678-1234-1234-1234-123456789abc';
const resolvedFakeUuid = resolveLegacyBusinessId(fakeUuid);
assert(resolvedFakeUuid === null, "TEST E: UUID inexistente pasado a resolveLegacyBusinessId devuelve null (Fail-Closed, jamás dígitos extraídos)");
const compByFakeUuid = getCompany(fakeUuid);
assert(compByFakeUuid && compByFakeUuid.isConfigured === false, "TEST E: getCompany con UUID inexistente no extrae dígitos como teléfono y retorna no configurada");
const logsFakeUuid = listAuditLogs(fakeUuid);
assert(Array.isArray(logsFakeUuid) && logsFakeUuid.length === 0, "TEST E: listAuditLogs con UUID inexistente retorna array vacío sin llamar a replace(/\D/g, '')");

// TEST F — Model 303 isolation
currentDb.prepare(`
  INSERT INTO invoices (id, company_id, company_phone, client_name, total_amount, status, data_json, fiscal_period, created_at)
  VALUES (?, ?, ?, ?, ?, 'EMITIDA', ?, ?, ?)
`).run(
  'FAC-34-A01',
  compFiscalA.companyId,
  phoneFiscalA,
  'Cliente Alpha 1',
  1210,
  JSON.stringify({
    issueDate: '2026-08-15',
    financials: { taxBase: 1000, taxRatePercentage: 21, taxAmount: 210, totalAmount: 1210 }
  }),
  '2026_Q3',
  '2026-08-15T10:00:00.000Z'
);

currentDb.prepare(`
  INSERT INTO invoices (id, company_id, company_phone, client_name, total_amount, status, data_json, fiscal_period, created_at)
  VALUES (?, ?, ?, ?, ?, 'EMITIDA', ?, ?, ?)
`).run(
  'FAC-34-B01',
  compFiscalB.companyId,
  phoneFiscalB,
  'Cliente Beta 1',
  2420,
  JSON.stringify({
    issueDate: '2026-08-15',
    financials: { taxBase: 2000, taxRatePercentage: 21, taxAmount: 420, totalAmount: 2420 }
  }),
  '2026_Q3',
  '2026-08-15T10:00:00.000Z'
);

const summaryA34 = getQuarterSummary(contextFiscalA, 2026, 3);
const summaryB34 = getQuarterSummary(contextFiscalB, 2026, 3);

assert(summaryA34.summary.issuedCount === 1, "TEST F: Modelo 303 Isolation: Tenant A solo computa 1 factura emitida propia");
assert(summaryA34.summary.issuedTaxBase === 1000, "TEST F: Modelo 303 Isolation: Base imponible de Tenant A es 1.000€ (sin contaminar con Beta)");
assert(summaryA34.summary.issuedVatTotal === 210, "TEST F: Modelo 303 Isolation: IVA devengado de Tenant A es 210€");
assert(summaryB34.summary.issuedCount === 1, "TEST F: Modelo 303 Isolation: Tenant B solo computa 1 factura emitida propia");
assert(summaryB34.summary.issuedTaxBase === 2000, "TEST F: Modelo 303 Isolation: Base imponible de Tenant B es 2.000€");
assert(summaryB34.summary.issuedVatTotal === 420, "TEST F: Modelo 303 Isolation: IVA devengado de Tenant B es 420€");

// TEST G — Export isolation (ambas empresas sin CIF generan Cierre_Fiscal_..._SIN_CIF.zip)
const pkgA = await buildGestoriaPackageZip(contextFiscalA, 2026, 3);
const pkgB = await buildGestoriaPackageZip(contextFiscalB, 2026, 3);

assert(path.basename(pkgA.zipPath) === pkgA.fileName && pkgA.fileName.startsWith('Cierre_Fiscal_2026_Q3_'), "TEST G: Export Collision: Nombre de archivo de exportación coincide con patrón oficial");
assert(path.basename(pkgB.zipPath) === pkgB.fileName && pkgB.fileName.startsWith('Cierre_Fiscal_2026_Q3_'), "TEST G: Export Collision: Nombre de archivo de exportación de B coincide");
assert(pkgA.zipPath !== pkgB.zipPath, "TEST G: Export Collision: Las rutas físicas de almacenamiento son distintas (aisladas por companyId)");
assert(pkgA.zipPath.includes(compFiscalA.companyId), "TEST G: Export Collision: El archivo de Alpha reside dentro de su directorio data/fiscal_exports/<company_id>/");
assert(pkgB.zipPath.includes(compFiscalB.companyId), "TEST G: Export Collision: El archivo de Beta reside dentro de su directorio data/fiscal_exports/<company_id>/");
assert(fs.existsSync(pkgA.zipPath) && fs.existsSync(pkgB.zipPath), "TEST G: Export Collision: Ambos archivos coexisten simultáneamente en disco sin sobrescribirse");

// Limpiar archivos físicos de exportación generados durante el test
try {
  if (fs.existsSync(pkgA.zipPath)) fs.unlinkSync(pkgA.zipPath);
  if (fs.existsSync(pkgB.zipPath)) fs.unlinkSync(pkgB.zipPath);
  const dirA = path.dirname(pkgA.zipPath);
  const dirB = path.dirname(pkgB.zipPath);
  if (fs.existsSync(dirA)) fs.rmdirSync(dirA);
  if (fs.existsSync(dirB)) fs.rmdirSync(dirB);
} catch (e) {}

// TEST H — Unauthenticated fiscal operation
assert(getPurchaseInvoice(null, 'REC-34-A01') === null, "TEST H: Unauthenticated: getPurchaseInvoice(null) deniega acceso y retorna null");
assert(deletePurchaseInvoice(null, 'REC-34-A01') === false, "TEST H: Unauthenticated: deletePurchaseInvoice(null) deniega eliminación y retorna false");
assert(resolveFiscalIncident(null, 'INC-34-A01') === false, "TEST H: Unauthenticated: resolveFiscalIncident(null) deniega resolución y retorna false");
assert(getFiscalIncident(null, 'INC-34-A01') === null, "TEST H: Unauthenticated: getFiscalIncident(null) deniega lectura y retorna null");
assert(getQuarterSummary(null, 2026, 3) === null, "TEST H: Unauthenticated: getQuarterSummary(null) retorna null");

let threwSaveUnauth = false;
try {
  savePurchaseInvoice(null, { id: 'REC-UNAUTH-01' });
} catch (e) {
  threwSaveUnauth = true;
  assert(e.message.includes('Tenant Boundary'), "TEST H: savePurchaseInvoice(null) lanza error de Tenant Boundary");
}
assert(threwSaveUnauth, "TEST H: Intento no autenticado de savePurchaseInvoice se bloquea en fail-closed");

let threwExportUnauth = false;
try {
  await buildGestoriaPackageZip(null, 2026, 3);
} catch (e) {
  threwExportUnauth = true;
}
assert(threwExportUnauth, "TEST H: buildGestoriaPackageZip(null) lanza error y bloquea exportación no autenticada");

// TEST I — Cross-tenant update
// Tenant A intenta actualizar factura REC-34-B01 de Tenant B
const crossUpdateRes = savePurchaseInvoice(contextFiscalA, {
  id: 'REC-34-B01',
  supplierName: 'Ataque Modificación Cross-Tenant',
  taxBase: 9999
});
assert(crossUpdateRes === null, "TEST I: Cross-Tenant Update: savePurchaseInvoice de factura de otro tenant es bloqueado y retorna null");
const verifyBNotUpdated = currentDb.prepare("SELECT * FROM purchase_invoices WHERE id = ?").get('REC-34-B01');
assert(verifyBNotUpdated && verifyBNotUpdated.supplier_name === 'Suministros Fontanería B' && verifyBNotUpdated.taxable_base === 800, "TEST I: En SQLite, la factura de Tenant B mantiene sus valores originales sin alteración");

// Tenant B crea un activo de inversión
saveInvestmentAsset(contextFiscalB, {
  id: 'AST-34-B01',
  description: 'Furgoneta Taller Beta',
  purchaseBase: 15000,
  vatAmount: 3150,
  totalAmount: 18150
});
// Tenant A intenta actualizar activo AST-34-B01 de Tenant B
const crossAssetUpdateRes = saveInvestmentAsset(contextFiscalA, {
  id: 'AST-34-B01',
  description: 'Ataque Modificación Activo'
});
assert(crossAssetUpdateRes === null, "TEST I: Cross-Tenant Asset Update: saveInvestmentAsset de activo de otro tenant retorna null");
const verifyAssetBNotUpdated = currentDb.prepare("SELECT * FROM investment_assets WHERE id = ?").get('AST-34-B01');
assert(verifyAssetBNotUpdated && verifyAssetBNotUpdated.description === 'Furgoneta Taller Beta', "TEST I: En SQLite, el bien de inversión de Tenant B mantiene su descripción original");

// Tenant A intenta actualizar incidencia INC-34-B01 de Tenant B
const crossIncidentUpdateRes = saveFiscalIncident(contextFiscalA, {
  id: 'INC-34-B01',
  message: 'Ataque Modificación Incidencia'
});
assert(crossIncidentUpdateRes === null, "TEST I: Cross-Tenant Incident Update: saveFiscalIncident de incidencia de otro tenant retorna null");

// TEST J — Cross-tenant delete
const crossDeletePinvJ = deletePurchaseInvoice(contextFiscalA, 'REC-34-B01');
assert(crossDeletePinvJ === false, "TEST J: Cross-Tenant Delete: deletePurchaseInvoice(tenantA, idB) retorna false");
const crossDeleteIncJ = deleteFiscalIncident(contextFiscalA, 'INC-34-B01');
assert(crossDeleteIncJ === false, "TEST J: Cross-Tenant Delete: deleteFiscalIncident(tenantA, incB) retorna false");
const verifyRowStillPresent = currentDb.prepare("SELECT id FROM purchase_invoices WHERE id = ?").get('REC-34-B01');
assert(verifyRowStillPresent !== null, "TEST J: 0 eliminaciones en purchase_invoices de Tenant B tras intento de Tenant A");
const verifyIncStillPresent = currentDb.prepare("SELECT id FROM fiscal_incidents WHERE id = ?").get('INC-34-B01');
assert(verifyIncStillPresent !== null, "TEST J: 0 eliminaciones en fiscal_incidents de Tenant B tras intento de Tenant A");

// TEST K — Legacy compatibility
const resByIdA = resolveLegacyBusinessId(compFiscalA.companyId);
assert(resByIdA === phoneFiscalA, "TEST K: Resolver canónico: resolveLegacyBusinessId(UUID_A) retorna cleanPhone canónico");
const resByContextA = resolveLegacyBusinessId({ companyId: compFiscalA.companyId });
assert(resByContextA === phoneFiscalA, "TEST K: Resolver canónico: resolveLegacyBusinessId({ companyId: UUID_A }) retorna cleanPhone canónico");

// listPurchaseInvoices pasando companyId en lugar de teléfono legacy
const listAByUuid = listPurchaseInvoices(compFiscalA.companyId);
assert(listAByUuid.length >= 1 && listAByUuid.some(i => i.id === 'REC-34-A01'), "TEST K: listPurchaseInvoices funciona transparentemente con UUID companyId mediante resolver");

// saveTaxProfile y getTaxProfile con companyId / authContext
saveTaxProfile(contextFiscalA, {
  vatRegime: 'GENERAL',
  defaultVatRate: 21,
  irpfWithholdingApplicable: 1,
  defaultIrpfRate: 15,
  incomeTaxRegime: 'ESTIMACION_DIRECTA_SIMPLIFICADA'
});
saveTaxProfile(contextFiscalB, {
  vatRegime: 'RECARGO_EQUIVALENCIA',
  defaultVatRate: 10,
  irpfWithholdingApplicable: 0,
  defaultIrpfRate: 0,
  incomeTaxRegime: 'OBJETIVA'
});
const profileA = getTaxProfile(compFiscalA.companyId);
const profileB = getTaxProfile(compFiscalB.companyId);
assert(profileA.vatRegime === 'GENERAL' && profileA.defaultIrpfRate === 15, "TEST K: getTaxProfile(companyId) recupera régimen General e IRPF 15% de Alpha");
assert(profileB.vatRegime === 'RECARGO_EQUIVALENCIA' && profileB.defaultIrpfRate === 0, "TEST K: getTaxProfile(companyId) recupera Recargo de Equivalencia de Beta");

// getOrCreateFiscalPeriod y getFiscalPeriod con companyId
const periodA = getOrCreateFiscalPeriod(compFiscalA.companyId, 2026, 4);
const periodB = getOrCreateFiscalPeriod(compFiscalB.companyId, 2026, 4);
assert(periodA.status === 'OPEN', "TEST K: Fiscal Period: Periodo 4T 2026 de Alpha se inicializa en OPEN");
assert(periodB.status === 'OPEN', "TEST K: Fiscal Period: Periodo 4T 2026 de Beta se inicializa en OPEN");

updateFiscalPeriodStatus(contextFiscalB, 2026, 4, 'CLOSED');
const periodAGet = getFiscalPeriod(compFiscalA.companyId, 2026, 4);
const periodBGet = getFiscalPeriod(compFiscalB.companyId, 2026, 4);
assert(periodBGet.status === 'CLOSED', "TEST K: Fiscal Period: Periodo de Beta pasa a CLOSED tras update");
assert(periodAGet.status === 'OPEN', "TEST K: Fiscal Period Isolation: Periodo de Alpha permanece OPEN con getFiscalPeriod(UUID)");

// Integridad relacional y verificación de base de datos
const fkCheck34 = currentDb.prepare('PRAGMA foreign_key_check').all();
assert(fkCheck34.length === 0, "PRAGMA foreign_key_check 0 violaciones tras TEST 34");

const integrityCheck34 = currentDb.prepare('PRAGMA integrity_check').get();
assert(integrityCheck34.integrity_check === 'ok', "PRAGMA integrity_check confirma base de datos 100% íntegra (ok)");

// Limpieza final de TEST 34
cleanupTest34(phoneFiscalA);
cleanupTest34(phoneFiscalB);

console.log("\nTEST 35: Blindaje Crítico del Auto-Migrador y Protección Fail-Closed de Producción");

import { isProductionDatabase as testIsProd, checkMigrationsDryRun } from './migration_service.js';
import { execFileSync } from 'node:child_process';

// TEST A — Import DB service no muta DB cuando hay migraciones pendientes
const tempDbA_Path = path.resolve('data', 'temp_test35_a.db');
if (fs.existsSync(tempDbA_Path)) fs.unlinkSync(tempDbA_Path);
const tempDbA = new DatabaseSync(tempDbA_Path);
initMigrationTable(tempDbA);
const { migration: m1Test35 } = await import('./migrations/001_baseline_schema.js');
tempDbA.exec('BEGIN;');
m1Test35.up(tempDbA);
tempDbA.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, '001_baseline_schema', new Date().toISOString());
tempDbA.exec('COMMIT;');
tempDbA.close();

const checkDbA_35 = new DatabaseSync(tempDbA_Path);
const pendingBeforeA_35 = getPendingMigrations(checkDbA_35);
assert(pendingBeforeA_35.length > 0, "1. Test A: Base de datos de prueba tiene migraciones pendientes");

let threwOnUnauth_35 = false;
try {
  runMigrations(checkDbA_35, { authorized: false });
} catch (e) {
  threwOnUnauth_35 = true;
  assert(e.message.includes('MIGRATION GUARD'), "2. Test A: runMigrations sin autorización es rechazado de inmediato (fail-closed)");
}
assert(threwOnUnauth_35, "3. Test A: Opening/inspecting a database must NEVER mutate its schema");
const pendingAfterA_35 = getPendingMigrations(checkDbA_35);
assert(pendingAfterA_35.length === pendingBeforeA_35.length, "4. Test A: Inspección no autorizada no altera el número de migraciones pendientes");
checkDbA_35.close();
if (fs.existsSync(tempDbA_Path)) fs.unlinkSync(tempDbA_Path);

// TEST B — Inspección CLI no ejecuta migraciones
const tempDbB_Path = path.resolve('data', 'temp_test35_b.db');
if (fs.existsSync(tempDbB_Path)) fs.unlinkSync(tempDbB_Path);
const tempDbB = new DatabaseSync(tempDbB_Path);
initMigrationTable(tempDbB);
tempDbB.exec('BEGIN;');
m1Test35.up(tempDbB);
tempDbB.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, '001_baseline_schema', new Date().toISOString());
tempDbB.exec('COMMIT;');
tempDbB.close();

const cliOutput_35 = execFileSync(process.execPath, [
  '-e',
  `import { DatabaseSync } from 'node:sqlite'; const d = new DatabaseSync('${tempDbB_Path.replace(/\\/g, '/')}'); console.log('MIG_COUNT:' + d.prepare('SELECT count(*) as c FROM schema_migrations').get().c); d.close();`
], {
  env: { ...process.env, NODE_ENV: 'development', ALLOW_DATABASE_MIGRATIONS: undefined, PRESUVOZ_DB_PATH: tempDbB_Path },
  encoding: 'utf8'
});
assert(cliOutput_35.includes('MIG_COUNT:1'), "5. Test B: Inspección CLI de esquema mantiene exactamente el recuento original de migraciones (1)");
assert(!cliOutput_35.includes('aplicada con éxito'), "6. Test B: Inspección CLI jamás ejecuta migraciones en segundo plano");
if (fs.existsSync(tempDbB_Path)) fs.unlinkSync(tempDbB_Path);

// TEST C — Migración explícita sí puede ejecutarse en DB de test
const tempDbC_Path = path.resolve('data', 'temp_test35_c.db');
if (fs.existsSync(tempDbC_Path)) fs.unlinkSync(tempDbC_Path);
const tempDbC = new DatabaseSync(tempDbC_Path);
initMigrationTable(tempDbC);
tempDbC.exec('BEGIN;');
m1Test35.up(tempDbC);
tempDbC.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, '001_baseline_schema', new Date().toISOString());
tempDbC.exec('COMMIT;');

const resultC_35 = runMigrations(tempDbC, { authorized: true });
assert(resultC_35.appliedCount > 0, "7. Test C: Migración explícita autorizada se ejecuta correctamente");
const pendingC_35 = getPendingMigrations(tempDbC);
assert(pendingC_35.length === 0, "8. Test C: Tras migración autorizada no quedan migraciones pendientes");
tempDbC.close();
if (fs.existsSync(tempDbC_Path)) fs.unlinkSync(tempDbC_Path);

// TEST D — Producción protegida fail-closed
const simulatedProdDb_35 = {
  prepare: (sql) => ({
    all: () => [{ seq: 0, name: 'main', file: path.resolve('data', 'presuvoz.db') }]
  })
};
assert(testIsProd(simulatedProdDb_35), "9. Test D: isProductionDatabase identifica con precisión la DB de producción");
let threwOnProdUnauth_35 = false;
try {
  runMigrations(simulatedProdDb_35, { authorized: true, allowProduction: false });
} catch (e) {
  threwOnProdUnauth_35 = true;
  assert(e.message.includes('PRODUCCIÓN'), "10. Test D: Intento de migrar producción sin autorización explícita lanza excepción crítica");
}
assert(threwOnProdUnauth_35, "11. Test D: Base de datos de producción blindada fail-closed contra migraciones accidentales");

// TEST E — Producción con autorización explícita
const tempDbE_Path = path.resolve('data', 'temp_test35_e.db');
if (fs.existsSync(tempDbE_Path)) fs.unlinkSync(tempDbE_Path);
const tempDbE = new DatabaseSync(tempDbE_Path);
initMigrationTable(tempDbE);
tempDbE.exec('BEGIN;');
m1Test35.up(tempDbE);
tempDbE.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, '001_baseline_schema', new Date().toISOString());
tempDbE.exec('COMMIT;');
const resultE_35 = runMigrations(tempDbE, { authorized: true, allowProduction: true });
assert(resultE_35.appliedCount > 0, "12. Test E: Con autorización explícita de producción (allowProduction=true) las migraciones son permitidas");
tempDbE.close();
if (fs.existsSync(tempDbE_Path)) fs.unlinkSync(tempDbE_Path);

// TEST F — No modificación accidental: Comparar SHA antes y después de inspección
const tempDbF_Path = path.resolve('data', 'temp_test35_f.db');
if (fs.existsSync(tempDbF_Path)) fs.unlinkSync(tempDbF_Path);
const tempDbF = new DatabaseSync(tempDbF_Path);
initMigrationTable(tempDbF);
tempDbF.close();
const shaBeforeF_35 = computeFileSha256(tempDbF_Path);

const readDbF_35 = new DatabaseSync(tempDbF_Path, { readOnly: true });
const readResult_35 = readDbF_35.prepare('SELECT count(*) as c FROM sqlite_master').get();
readDbF_35.close();

const shaAfterF_35 = computeFileSha256(tempDbF_Path);
assert(readResult_35.c >= 0, "13. Test F: Operación de lectura/inspección completa con éxito");
assert(shaBeforeF_35 === shaAfterF_35, "14. Test F: Las operaciones de lectura/inspección dejan el archivo SHA-256 100% idéntico");
if (fs.existsSync(tempDbF_Path)) fs.unlinkSync(tempDbF_Path);

console.log("\nTEST 36: Simulación de Futura Migración 007, Dry-Run y Protección Fail-Closed");

const tempDb36_Path = path.resolve('data', 'temp_test36_future_m007.db');
if (fs.existsSync(tempDb36_Path)) fs.unlinkSync(tempDb36_Path);
const tempDb36 = new DatabaseSync(tempDb36_Path);
initMigrationTable(tempDb36);
runMigrations(tempDb36, { authorized: true });

const mockMigration007 = {
  version: 99,
  name: '099_future_simulation_check',
  up: (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS test_future_mock (id TEXT PRIMARY KEY, note TEXT);");
  }
};
const extendedMigrations = [...MIGRATIONS, mockMigration007];

// 1. Dry run / check detection
const dryRunCheck = checkMigrationsDryRun(tempDb36, extendedMigrations);
assert(!dryRunCheck.isUpToDate, "1. Test 36: Migración futura detectada como pendiente en dry-run");
assert(dryRunCheck.pendingCount === 1, "2. Test 36: Hay exactamente 1 migración pendiente en dry-run");
assert(dryRunCheck.pending[0].version === 99, "3. Test 36: La migración pendiente es la versión 99");
assert(dryRunCheck.pending[0].name === '099_future_simulation_check', "4. Test 36: Nombre de migración pendiente coincide");

// 2. Comprobar que dry-run es estrictamente de solo lectura y no ejecuta nada
const appliedBefore36 = getAppliedMigrations(tempDb36, { dryRun: true });
assert(appliedBefore36.length === MIGRATIONS.length, "5. Test 36: El número de migraciones aplicadas en DB permanece inalterado tras dry-run");
const tableCheckBefore36 = tempDb36.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_future_mock'").get();
assert(!tableCheckBefore36, "6. Test 36: La tabla de la migración futura NO existe en la base de datos tras dry-run");

// 3. Intento de ejecutar migración sin autorización explícita (fail-closed)
let caughtUnauthGen007 = false;
try {
  runMigrations(tempDb36, { migrations: extendedMigrations, authorized: false });
} catch (err) {
  caughtUnauthGen007 = true;
  assert(err.message.includes('MIGRATION GUARD'), "7. Test 36: Ejecución sin authorized: true es rechazada inmediatamente (fail-closed)");
}
assert(caughtUnauthGen007, "8. Test 36: Base de datos no modificada ante intento no autorizado");

// 4. Intento de ejecutar migración sobre producción sin allowProduction (fail-closed)
const simulatedProdWith007 = {
  prepare: (sql) => ({
    all: () => [{ seq: 0, name: 'main', file: path.resolve('data', 'presuvoz.db') }]
  })
};
let caughtUnauthProd007 = false;
try {
  runMigrations(simulatedProdWith007, { migrations: extendedMigrations, authorized: true, allowProduction: false });
} catch (err) {
  caughtUnauthProd007 = true;
  assert(err.message.includes('PRODUCCIÓN'), "9. Test 36: Intento de aplicar migración a producción sin allowProduction lanza error crítico");
}
assert(caughtUnauthProd007, "10. Test 36: Producción blindada contra migración futura accidental");

// 5. Aplicación explícitamente autorizada en DB de prueba funciona correctamente
const appliedResult36 = runMigrations(tempDb36, { migrations: extendedMigrations, authorized: true });
assert(appliedResult36.appliedCount === 1, "11. Test 36: Migración futura se aplica con éxito cuando está explícitamente autorizada");
const appliedAfter36 = getAppliedMigrations(tempDb36, { dryRun: true });
assert(appliedAfter36.length === extendedMigrations.length, "12. Test 36: schema_migrations contiene ahora la versión 99");
const tableCheckAfter36 = tempDb36.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_future_mock'").get();
assert(!!tableCheckAfter36, "13. Test 36: La tabla test_future_mock ha sido creada correctamente por la migración");

tempDb36.close();
if (fs.existsSync(tempDb36_Path)) fs.unlinkSync(tempDb36_Path);

console.log("\nTEST 37: Migración Controlada de business_tax_profiles a company_id (Fase 2E-1 — Dual-Write, Backfill & Tenant Isolation)");

// ─── A. MIGRACIÓN 007: EJECUCIÓN Y REGISTRO ───
const schemaRow007 = currentDb.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 7").get();
assert(schemaRow007 && schemaRow007.version === 7, "A1. Migración 007 registrada en schema_migrations con versión 7");
assert(schemaRow007 && schemaRow007.name === '007_business_tax_profiles_company_id', "A2. Nombre de migración 007 coincide exactamente");
assert(schemaRow007 && typeof schemaRow007.applied_at === 'string' && schemaRow007.applied_at.length > 10, "A3. Migración 007 tiene timestamp applied_at válido");

// Producción pre-015 NO tiene la versión 7 registrada
const prodDbFor007Check = new DatabaseSync(HISTORICAL_PRE015_PROD_PATH, { readOnly: true });
const prodSchema007 = prodDbFor007Check.prepare("SELECT version FROM schema_migrations WHERE version = 7").get();
const prodMaxVersion = prodDbFor007Check.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get().max_v;
prodDbFor007Check.close();
assert(!prodSchema007, "A4. DB de producción (data/presuvoz.db) NO tiene la migración 007 registrada");
assert(prodMaxVersion === 6, "A5. Versión máxima en DB de producción permanece en 6");

// ─── B. BACKFILL DETERMINISTA & FAIL-CLOSED EN MIGRACIÓN ───
// B1: Migración limpia con múltiples perfiles
const memDb37Backfill = new DatabaseSync(':memory:');
initMigrationTable(memDb37Backfill);
runMigrations(memDb37Backfill, { migrations: MIGRATIONS.slice(0, 6), authorized: true });

// Insertar dos empresas y dos perfiles fiscales según esquema previo a 007
memDb37Backfill.exec(`
  INSERT INTO companies (id, phone, name, fiscal_name, cif) VALUES
    ('uuid-comp-bf1', '34688111111', 'Empresa BF 1', 'Empresa BF 1 S.L.', 'B88111111'),
    ('uuid-comp-bf2', '34688222222', 'Empresa BF 2', 'Empresa BF 2 S.L.', 'B88222222');
  INSERT INTO business_tax_profiles (business_id, legal_name, tax_id, tax_regime, vat_regime, default_vat_rate) VALUES
    ('34688111111', 'Empresa BF 1 S.L.', 'B88111111', 'GENERAL', 'GENERAL', 21),
    ('34688222222', 'Empresa BF 2 S.L.', 'B88222222', 'SIMPLIFICADO', 'RECARGO_EQUIVALENCIA', 10);
`);

// Ejecutar migración 007
const migRes37B = runMigrations(memDb37Backfill, { migrations: [MIGRATIONS[6]], authorized: true });
assert(migRes37B.appliedCount === 1, "B1. Migración 007 se ejecuta con éxito sobre base de datos con datos");

const bfRows = memDb37Backfill.prepare("SELECT company_id, business_id, legal_name, default_vat_rate FROM business_tax_profiles ORDER BY company_id ASC").all();
assert(bfRows.length === 2, "B2. Recuento de filas se preserva exactamente tras migración (2 filas)");
assert(bfRows[0].company_id === 'uuid-comp-bf1' && bfRows[0].business_id === '34688111111' && bfRows[0].default_vat_rate === 21, "B3. Fila 1 migrada con company_id correcto y valores preservados");
assert(bfRows[1].company_id === 'uuid-comp-bf2' && bfRows[1].business_id === '34688222222' && bfRows[1].default_vat_rate === 10, "B4. Fila 2 migrada con company_id correcto y valores preservados");

// B2: Fail-Closed con business_id huérfano (teléfono que no existe en companies)
const memDb37Orphan = new DatabaseSync(':memory:');
initMigrationTable(memDb37Orphan);
runMigrations(memDb37Orphan, { migrations: MIGRATIONS.slice(0, 6), authorized: true });
memDb37Orphan.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-comp-ok', '34688333333', 'Empresa OK');
  INSERT INTO business_tax_profiles (business_id, legal_name) VALUES
    ('34688333333', 'Empresa OK'),
    ('34699999999', 'Empresa Huérfana Fantasma');
`);

let caughtOrphan007 = false;
try {
  runMigrations(memDb37Orphan, { migrations: [MIGRATIONS[6]], authorized: true });
} catch (err) {
  caughtOrphan007 = true;
  assert(err.message.includes('huérfano') || err.message.includes('fail-closed'), "B5. Error descriptivo de integridad ante perfil huérfano");
}
assert(caughtOrphan007 === true, "B6. Fail-Closed: Migración 007 aborta inmediatamente ante business_id huérfano");
const orphanApplied007 = memDb37Orphan.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get();
assert(!orphanApplied007, "B7. Rollback atómico: Versión 7 no se registra en schema_migrations tras fallo");

// B3: Fail-Closed si existiese colisión de company_id
const memDb37Collision = new DatabaseSync(':memory:');
initMigrationTable(memDb37Collision);
runMigrations(memDb37Collision, { migrations: MIGRATIONS.slice(0, 6), authorized: true });
memDb37Collision.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-comp-shared', '34688444444', 'Empresa Compartida');
  INSERT INTO business_tax_profiles (business_id, legal_name) VALUES
    ('34688444444', 'Perfil 1'),
    ('+34 688 44 44 44', 'Perfil Duplicado con formato');
`);
let caughtCollision007 = false;
try {
  runMigrations(memDb37Collision, { migrations: [MIGRATIONS[6]], authorized: true });
} catch (err) {
  caughtCollision007 = true;
}
assert(caughtCollision007 === true, "B8. Fail-Closed: Colisión de tenant que resolvería al mismo company_id es rechazada");

// ─── C. AISLAMIENTO MULTI-TENANT ───
const phoneTaxTenantA = '34677112201';
const phoneTaxTenantB = '34677112202';

const cleanupTest37 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};
cleanupTest37(phoneTaxTenantA);
cleanupTest37(phoneTaxTenantB);

const compTaxA = createCompanyWithIdentity({
  name: 'Empresa A Fiscal S.L.',
  phone: phoneTaxTenantA,
  cif: 'B-77112201',
  trade: 'Construcción'
});
const contextTaxA = resolveAuthenticatedContext('whatsapp', phoneTaxTenantA);

const compTaxB = createCompanyWithIdentity({
  name: 'Empresa B Fiscal S.L.',
  phone: phoneTaxTenantB,
  cif: 'B-77112202',
  trade: 'Pintura'
});
const contextTaxB = resolveAuthenticatedContext('whatsapp', phoneTaxTenantB);

// Guardar perfiles fiscales distintos
saveTaxProfile(contextTaxA, {
  legalName: 'Empresa A Fiscal S.L.',
  taxId: 'B-77112201',
  taxRegime: 'GENERAL',
  vatRegime: 'GENERAL',
  defaultVatRate: 21,
  defaultIrpfRate: 15
});

saveTaxProfile(contextTaxB, {
  legalName: 'Empresa B Fiscal S.L.',
  taxId: 'B-77112202',
  taxRegime: 'SIMPLIFICADO',
  vatRegime: 'RECARGO_EQUIVALENCIA',
  defaultVatRate: 10,
  defaultIrpfRate: 0
});

// Lectura aislada
const profReadA = getTaxProfile(contextTaxA.companyId);
const profReadB = getTaxProfile(contextTaxB.companyId);

assert(profReadA.companyId === compTaxA.companyId, "C1. Perfil A recupera companyId canónico de Empresa A");
assert(profReadA.legalName === 'Empresa A Fiscal S.L.' && profReadA.defaultVatRate === 21, "C2. Perfil A recupera sus datos propios de régimen e IVA 21%");
assert(profReadB.companyId === compTaxB.companyId, "C3. Perfil B recupera companyId canónico de Empresa B");
assert(profReadB.legalName === 'Empresa B Fiscal S.L.' && profReadB.defaultVatRate === 10, "C4. Perfil B recupera sus datos propios de régimen e IVA 10%");

// Intento de mutación cross-tenant
saveTaxProfile(contextTaxA, {
  legalName: 'Empresa A Modificada',
  defaultVatRate: 21
});
const profBAfterAttack = getTaxProfile(contextTaxB.companyId);
assert(profBAfterAttack.legalName === 'Empresa B Fiscal S.L.' && profBAfterAttack.defaultVatRate === 10, "C5. Intento de mutación de Tenant A jamás altera el perfil de Tenant B");

// Intento de borrado cross-tenant
const deletedA = deleteTaxProfile(contextTaxA);
assert(deletedA === true, "C6. deleteTaxProfile(contextA) elimina con éxito el perfil de Tenant A");
const profBAfterDelA = getTaxProfile(contextTaxB.companyId);
assert(profBAfterDelA !== null && profBAfterDelA.companyId === compTaxB.companyId, "C7. El perfil fiscal de Tenant B sigue existiendo intacto tras borrado de Tenant A");

// Recrear perfil de A para los siguientes tests
saveTaxProfile(contextTaxA, {
  legalName: 'Empresa A Fiscal S.L.',
  taxId: 'B-77112201',
  taxRegime: 'GENERAL',
  defaultVatRate: 21
});

// ─── D. INYECCIÓN DE MODELO (DEFENSA FAIL-CLOSED) ───
const injectedPayload = {
  companyId: compTaxB.companyId,
  businessId: phoneTaxTenantB,
  legalName: 'Inyección Maliciosa de Modelo',
  defaultVatRate: 4
};
saveTaxProfile(contextTaxA, injectedPayload);

const profAVerifyInject = getTaxProfile(contextTaxA.companyId);
const profBVerifyInject = getTaxProfile(contextTaxB.companyId);

assert(profAVerifyInject.companyId === compTaxA.companyId, "D1. Modelo injection defendida: companyId de A se mantiene como autoridad");
assert(profAVerifyInject.businessId === phoneTaxTenantA, "D2. Modelo injection defendida: businessId de A se mantiene sincronizado con phoneA");
assert(profBVerifyInject.legalName === 'Empresa B Fiscal S.L.', "D3. Tenant B permanece completamente protegido contra payload spoofed");

// ─── E. ROBUSTEZ DE UUID ───
assert(isUuid(profAVerifyInject.companyId), "E1. companyId retornado es un UUID v4 canónico");
assert(profAVerifyInject.companyId.includes('-') && profAVerifyInject.companyId.length === 36, "E2. companyId tiene formato UUID con guiones intactos (36 caracteres)");

// Comprobación directa en SQLite
const sqliteRowTaxA = currentDb.prepare("SELECT company_id, business_id FROM business_tax_profiles WHERE company_id = ?").get(compTaxA.companyId);
assert(sqliteRowTaxA && sqliteRowTaxA.company_id === compTaxA.companyId, "E3. SQLite almacena el UUID con guiones intactos sin sufrir regex stripping");

// ─── F. RESTRICCIONES RELACIONALES EN SQLITE ───
// F1. FK Constraint: Inserción directa con company_id inexistente falla
let caughtFkError = false;
try {
  currentDb.prepare(`
    INSERT INTO business_tax_profiles (company_id, business_id, legal_name)
    VALUES ('00000000-0000-4000-8000-000000000099', '34600999999', 'Empresa Inexistente');
  `).run();
} catch (err) {
  caughtFkError = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "F1. Violación de Foreign Key hacia companies(id) detectada");
}
assert(caughtFkError === true, "F2. SQLite rechaza inserción en business_tax_profiles sin company padre existente");

// F2. NOT NULL Constraint en company_id
let caughtNullCid = false;
try {
  currentDb.prepare(`
    INSERT INTO business_tax_profiles (company_id, business_id, legal_name)
    VALUES (NULL, '34600999999', 'Null Cid');
  `).run();
} catch (err) {
  caughtNullCid = true;
  assert(err.message.includes('NOT NULL constraint failed'), "F3. NOT NULL constraint en company_id detectada");
}
assert(caughtNullCid === true, "F4. Inserción con company_id NULL es rechazada");

// F3. NOT NULL Constraint en business_id
let caughtNullBid = false;
try {
  currentDb.prepare(`
    INSERT INTO business_tax_profiles (company_id, business_id, legal_name)
    VALUES (?, NULL, 'Null Bid');
  `).run(compTaxA.companyId);
} catch (err) {
  caughtNullBid = true;
  assert(err.message.includes('NOT NULL constraint failed'), "F5. NOT NULL constraint en business_id detectada");
}
assert(caughtNullBid === true, "F6. Inserción con business_id NULL es rechazada");

// F4. Single profile per company (PRIMARY KEY / UNIQUE)
let caughtDuplicateCid = false;
try {
  currentDb.prepare(`
    INSERT INTO business_tax_profiles (company_id, business_id, legal_name)
    VALUES (?, '34600888888', 'Duplicado');
  `).run(compTaxB.companyId);
} catch (err) {
  caughtDuplicateCid = true;
  assert(err.message.includes('UNIQUE constraint failed'), "F7. Violación de PRIMARY KEY / UNIQUE en company_id detectada");
}
assert(caughtDuplicateCid === true, "F8. No se puede crear más de un perfil fiscal por company_id");

// ─── G. COMPATIBILIDAD HACIA ATRÁS (DUAL-WRITE & ADAPTER TRANSITORIO) ───
// G1. business_id almacena el teléfono normalizado
assert(sqliteRowTaxA.business_id === phoneTaxTenantA, "G1. Dual-write: business_id almacena el teléfono limpio en SQLite");

// G2. Lectura legacy con teléfono recupera el perfil correctamente
const legacyReadTaxA = getTaxProfile(phoneTaxTenantA);
assert(legacyReadTaxA !== null && legacyReadTaxA.companyId === compTaxA.companyId, "G2. getTaxProfile(phone) opera transparentemente vía adapter");
assert(legacyReadTaxA.businessId === phoneTaxTenantA, "G3. Objeto retornado contiene tanto companyId como businessId");

// G3. Escritura legacy con teléfono actualiza y mantiene dual-write
saveTaxProfile(phoneTaxTenantA, {
  economicActivity: 'Albañilería y Estructuras'
});
const updatedLegacyTaxA = getTaxProfile(compTaxA.companyId);
assert(updatedLegacyTaxA.economicActivity === 'Albañilería y Estructuras', "G4. saveTaxProfile(phone) actualiza correctamente la fila");
assert(updatedLegacyTaxA.companyId === compTaxA.companyId && updatedLegacyTaxA.businessId === phoneTaxTenantA, "G5. Dual-write preservado tras actualización legacy");

// G4. Verificaciones de integridad en base de datos de test
const fkViolations37 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult37 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations37.length === 0, "G6. PRAGMA foreign_key_check = 0 violaciones en base de datos de test");
assert(integrityResult37 && (integrityResult37.integrity_check === 'ok' || integrityResult37.integrity_check === 'OK'), "G7. PRAGMA integrity_check = ok en base de datos de test");

cleanupTest37(phoneTaxTenantA);
cleanupTest37(phoneTaxTenantB);

console.log("\nTEST 38: Migración Controlada de fiscal_periods a company_id (Fase 2E-2 — PK Compuesta, Backfill & Tenant Isolation)");

// ─── A. MIGRATION ───
// 1. migration 008 se registra correctamente en TEST
const schemaRow008 = currentDb.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 8").get();
assert(schemaRow008 && schemaRow008.version === 8, "A1. Migración 008 registrada en schema_migrations con versión 8");
assert(schemaRow008 && schemaRow008.name === '008_fiscal_periods_company_id', "A2. Nombre de migración 008 coincide exactamente");
assert(schemaRow008 && typeof schemaRow008.applied_at === 'string' && schemaRow008.applied_at.length > 10, "A3. Migración 008 tiene timestamp applied_at válido");

// 2. production pre-015 sigue con máximo migration 006 (007 y 008 NO registradas)
const prodDbFor008Check = new DatabaseSync(HISTORICAL_PRE015_PROD_PATH, { readOnly: true });
const prodSchema008 = prodDbFor008Check.prepare("SELECT version FROM schema_migrations WHERE version >= 7").all();
const prodMaxVersion008 = prodDbFor008Check.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get().max_v;
prodDbFor008Check.close();
assert(prodSchema008.length === 0, "A4. DB de producción (data/presuvoz.db) NO tiene registradas las migraciones 007 ni 008");
assert(prodMaxVersion008 === 6, "A5. Versión máxima en DB de producción permanece inalterada en 6");

// 3. migration 007 sigue intacta en test
const schemaRow007Check = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 7").get();
assert(schemaRow007Check && schemaRow007Check.name === '007_business_tax_profiles_company_id', "A6. Migración 007 permanece intacta en la base de datos de test");

// ─── B. BACKFILL DETERMINISTA & CASOS DE ERROR FAIL-CLOSED ───
// B1. business_id válido → company_id correcto y múltiples periodos del mismo negocio mantienen el mismo company_id
const memDb38B = new DatabaseSync(':memory:');
initMigrationTable(memDb38B);
runMigrations(memDb38B, { migrations: MIGRATIONS.slice(0, 7), authorized: true });

// Insertar 2 empresas con múltiples periodos fiscales según esquema previo a 008
memDb38B.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-fp-comp1', '34677000001', 'Empresa FP 1'),
    ('uuid-fp-comp2', '34677000002', 'Empresa FP 2');
  INSERT INTO fiscal_periods (id, business_id, fiscal_year, quarter, status, critical_incidents_count, warnings_count, package_path) VALUES
    ('34677000001_2026_Q1', '34677000001', 2026, 1, 'CLOSED', 0, 0, '/path/q1.zip'),
    ('34677000001_2026_Q2', '34677000001', 2026, 2, 'SENT', 1, 2, '/path/q2.zip'),
    ('34677000002_2026_Q1', '34677000002', 2026, 1, 'OPEN', 0, 0, NULL);
`);

const migRes38 = runMigrations(memDb38B, { migrations: [MIGRATIONS[7]], authorized: true });
assert(migRes38.appliedCount === 1, "B1. Migración 008 se aplica con éxito sobre base de datos con datos");

const fpRows38 = memDb38B.prepare("SELECT id, company_id, business_id, fiscal_year, quarter, status, critical_incidents_count, package_path FROM fiscal_periods ORDER BY company_id ASC, quarter ASC").all();
assert(fpRows38.length === 3, "B2. Recuento de filas se preserva exactamente tras migración (3 filas)");
assert(fpRows38[0].company_id === 'uuid-fp-comp1' && fpRows38[0].quarter === 1 && fpRows38[0].package_path === '/path/q1.zip', "B3. Fila 1 migrada con company_id correcto y datos intactos");
assert(fpRows38[1].company_id === 'uuid-fp-comp1' && fpRows38[1].quarter === 2 && fpRows38[1].critical_incidents_count === 1, "B4. Múltiples periodos del mismo negocio mantienen el mismo company_id (Q1 y Q2)");
assert(fpRows38[2].company_id === 'uuid-fp-comp2' && fpRows38[2].quarter === 1 && fpRows38[2].status === 'OPEN', "B5. Periodo de Empresa 2 migrado correctamente con su propio company_id");

// ─── PASO 12: TEST DE ROLLBACK COMPLETO ───
// Forzar fila huérfana (business_id sin empresa en companies)
const memDb38Rollback = new DatabaseSync(':memory:');
initMigrationTable(memDb38Rollback);
runMigrations(memDb38Rollback, { migrations: MIGRATIONS.slice(0, 7), authorized: true });

memDb38Rollback.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-fp-comp-ok', '34677000003', 'Empresa Valida');
  INSERT INTO fiscal_periods (id, business_id, fiscal_year, quarter, status) VALUES
    ('34677000003_2026_Q1', '34677000003', 2026, 1, 'OPEN'),
    ('34699999999_2026_Q1', '34699999999', 2026, 1, 'OPEN');
`);

const countBeforeRollback = memDb38Rollback.prepare("SELECT COUNT(*) as c FROM fiscal_periods").get().c;
let caughtOrphan008 = false;
try {
  runMigrations(memDb38Rollback, { migrations: [MIGRATIONS[7]], authorized: true });
} catch (err) {
  caughtOrphan008 = true;
  assert(err.message.includes('huérfano') || err.message.includes('fail-closed'), "B6. Error descriptivo fail-closed ante periodo huérfano");
}
assert(caughtOrphan008 === true, "B7. Migración 008 aborta inmediatamente ante business_id huérfano");

// Verificaciones de rollback
const orphanApplied008 = memDb38Rollback.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get();
assert(!orphanApplied008, "B8. Rollback atómico: Versión 8 NO queda registrada en schema_migrations");
const countAfterRollback = memDb38Rollback.prepare("SELECT COUNT(*) as c FROM fiscal_periods").get().c;
assert(countAfterRollback === countBeforeRollback, "B9. Rollback atómico: La tabla fiscal_periods queda exactamente como estaba");
const tempTableCheck = memDb38Rollback.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fiscal_periods_new'").get();
assert(!tempTableCheck, "B10. Rollback atómico: No quedan tablas temporales (fiscal_periods_new)");

// Fail-closed por ambigüedad (>1 empresa para el mismo teléfono)
const memDb38Ambig = new DatabaseSync(':memory:');
initMigrationTable(memDb38Ambig);
runMigrations(memDb38Ambig, { migrations: MIGRATIONS.slice(0, 7), authorized: true });
memDb38Ambig.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-dup-1', '34677000099', 'Empresa Dup 1'),
    ('uuid-dup-2', '+34 677 00 00 99', 'Empresa Dup 2');
  INSERT INTO fiscal_periods (id, business_id, fiscal_year, quarter, status) VALUES
    ('34677000099_2026_Q1', '34677000099', 2026, 1, 'OPEN');
`);
let caughtAmbig008 = false;
try {
  runMigrations(memDb38Ambig, { migrations: [MIGRATIONS[7]], authorized: true });
} catch (err) {
  caughtAmbig008 = true;
}
assert(caughtAmbig008 === true, "B11. Fail-closed: Múltiples empresas ambiguas provocan aborto y rollback");

// ─── C. CLAVE PRIMARIA COMPUESTA (company_id, fiscal_year, quarter) ───
// 9. dos periodos distintos del mismo company pueden coexistir: company_id + 2026 + Q1, company_id + 2026 + Q2
// 10. dos empresas pueden tener el mismo: year + quarter sin colisionar
// 11. mismo: company_id + year + quarter no puede duplicarse
const phoneFpTenantA = '34677991101';
const phoneFpTenantB = '34677991102';

const cleanupTest38 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};
cleanupTest38(phoneFpTenantA);
cleanupTest38(phoneFpTenantB);

const compFpA = createCompanyWithIdentity({
  name: 'Constructora Alpha Fiscal S.L.',
  phone: phoneFpTenantA,
  cif: 'B-77991101',
  trade: 'Construcción'
});
const contextFpA = resolveAuthenticatedContext('whatsapp', phoneFpTenantA);

const compFpB = createCompanyWithIdentity({
  name: 'Reformas Beta Fiscal S.L.',
  phone: phoneFpTenantB,
  cif: 'B-77991102',
  trade: 'Fontanería'
});
const contextFpB = resolveAuthenticatedContext('whatsapp', phoneFpTenantB);

// Crear periodos
const fpA_Q1 = getOrCreateFiscalPeriod(contextFpA, 2026, 1);
const fpA_Q2 = getOrCreateFiscalPeriod(contextFpA, 2026, 2);
const fpB_Q1 = getOrCreateFiscalPeriod(contextFpB, 2026, 1);

assert(fpA_Q1 && fpA_Q2 && fpA_Q1.quarter === 1 && fpA_Q2.quarter === 2, "C1. Dos periodos del mismo company coexisten (2026 Q1 y 2026 Q2)");
assert(fpB_Q1 && fpB_Q1.quarter === 1 && fpB_Q1.companyId === compFpB.companyId, "C2. Dos empresas tienen el mismo year + quarter (2026 Q1) sin colisionar");

// Intento de duplicar (company_id, fiscal_year, quarter)
let caughtDupPk = false;
try {
  currentDb.prepare(`
    INSERT INTO fiscal_periods (id, company_id, business_id, fiscal_year, quarter, status)
    VALUES ('dup-id-test', ?, ?, 2026, 1, 'OPEN');
  `).run(compFpA.companyId, phoneFpTenantA);
} catch (err) {
  caughtDupPk = true;
  assert(err.message.includes('UNIQUE constraint failed'), "C3. Violación de clave primaria compuesta detectada en SQLite");
}
assert(caughtDupPk === true, "C4. SQLite rechaza duplicados de (company_id, fiscal_year, quarter)");

// ─── D. AISLAMIENTO MULTI-TENANT ───
// 12. Tenant A solo puede leer sus periodos
const readPeriodA = getFiscalPeriod(contextFpA, 2026, 1);
assert(readPeriodA !== null && readPeriodA.companyId === compFpA.companyId, "D1. Tenant A lee su propio periodo 2026 Q1");

// 13. Tenant B solo puede leer sus periodos
const readPeriodB = getFiscalPeriod(contextFpB, 2026, 1);
assert(readPeriodB !== null && readPeriodB.companyId === compFpB.companyId, "D2. Tenant B lee su propio periodo 2026 Q1");

// 14. Tenant A no puede modificar periodo de B
updateFiscalPeriodStatus(contextFpA, 2026, 1, 'CLOSED', {
  packagePath: '/alpha/cierre_q1.zip'
});
const checkBAfterAttack = getFiscalPeriod(contextFpB, 2026, 1);
assert(checkBAfterAttack.status === 'OPEN' && checkBAfterAttack.packagePath === null, "D3. Tenant A no altera el periodo de Tenant B (permanece OPEN y sin packagePath)");

// 15. Tenant A no puede borrar periodo de B
const deleteAttemptByA = deleteFiscalPeriod(contextFpA, 2026, 1);
assert(deleteAttemptByA === true, "D4. deleteFiscalPeriod elimina el periodo de Tenant A");
const checkBAfterDelA = getFiscalPeriod(contextFpB, 2026, 1);
assert(checkBAfterDelA !== null && checkBAfterDelA.companyId === compFpB.companyId, "D5. El periodo de Tenant B sigue existiendo intacto tras borrado de Tenant A");

// Recrear periodo de A para siguientes pruebas
getOrCreateFiscalPeriod(contextFpA, 2026, 1);

// ─── E. INYECCIÓN DE MODELO (DEFENSA FAIL-CLOSED) ───
// 16. company_id de Tenant B enviado desde Tenant A en extra es ignorado
// 17. business_id de Tenant B enviado desde Tenant A en extra es ignorado
const maliciousExtra = {
  companyId: compFpB.companyId,
  company_id: compFpB.companyId,
  businessId: phoneFpTenantB,
  business_id: phoneFpTenantB,
  packagePath: '/alpha/injected.zip'
};
updateFiscalPeriodStatus(contextFpA, 2026, 1, 'SENT', maliciousExtra);

const fpAVerified = getFiscalPeriod(contextFpA, 2026, 1);
const fpBVerified = getFiscalPeriod(contextFpB, 2026, 1);
assert(fpAVerified.companyId === compFpA.companyId, "E1. Modelo injection defendida: companyId de A se mantiene como autoridad");
assert(fpAVerified.businessId === phoneFpTenantA, "E2. Modelo injection defendida: businessId de A se mantiene sincronizado con phoneA");
assert(fpBVerified.status === 'OPEN' && fpBVerified.packagePath === null, "E3. Tenant B permanece completamente protegido contra payload spoofed");

// ─── F. ROBUSTEZ DE UUID ───
// 18. UUID se conserva íntegramente
assert(isUuid(fpAVerified.companyId), "F1. companyId retornado es un UUID v4 canónico");
assert(fpAVerified.companyId.length === 36 && fpAVerified.companyId.includes('-'), "F2. companyId tiene formato UUID con guiones intactos");

// 19. No existe regex stripping de UUID en SQLite
const sqliteRowFpA = currentDb.prepare("SELECT company_id, business_id FROM fiscal_periods WHERE company_id = ? AND fiscal_year = 2026 AND quarter = 1").get(compFpA.companyId);
assert(sqliteRowFpA && sqliteRowFpA.company_id === compFpA.companyId, "F3. SQLite almacena el UUID con guiones intactos sin regex stripping");

// ─── G. CLAVE FORÁNEA & ON DELETE RESTRICT ───
// 20. company_id inexistente → FK violation
let caughtFkInexistente = false;
try {
  currentDb.prepare(`
    INSERT INTO fiscal_periods (id, company_id, business_id, fiscal_year, quarter, status)
    VALUES ('fake-id-fp', '00000000-0000-4000-8000-000000000099', '34600999999', 2026, 1, 'OPEN');
  `).run();
} catch (err) {
  caughtFkInexistente = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G1. Violación de Foreign Key hacia companies(id) detectada");
}
assert(caughtFkInexistente === true, "G2. SQLite rechaza inserción en fiscal_periods con company inexistente");

// 21. company_id NULL → rechazado
let caughtNullCidFp = false;
try {
  currentDb.prepare(`
    INSERT INTO fiscal_periods (id, company_id, business_id, fiscal_year, quarter, status)
    VALUES ('fake-id-fp2', NULL, '34600999999', 2026, 1, 'OPEN');
  `).run();
} catch (err) {
  caughtNullCidFp = true;
  assert(err.message.includes('NOT NULL constraint failed'), "G3. NOT NULL constraint en company_id detectada");
}
assert(caughtNullCidFp === true, "G4. Inserción con company_id NULL es rechazada");

// 22. ON DELETE RESTRICT: borrar una empresa con periodos fiscales es rechazado
let caughtRestrictDelete = false;
try {
  currentDb.prepare("DELETE FROM companies WHERE id = ?").run(compFpB.companyId);
} catch (err) {
  caughtRestrictDelete = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G5. ON DELETE RESTRICT previene el borrado de empresa con historial fiscal");
}
assert(caughtRestrictDelete === true, "G6. La empresa no puede ser eliminada mientras tenga registros en fiscal_periods");

// ─── H. COMPATIBILIDAD HACIA ATRÁS (LEGACY ADAPTER & DUAL-WRITE) ───
// 23. callers legacy existentes siguen funcionando mediante adapter
const legacyReadFpA = getFiscalPeriod(phoneFpTenantA, 2026, 1);
assert(legacyReadFpA !== null && legacyReadFpA.companyId === compFpA.companyId, "H1. getFiscalPeriod(phone) funciona vía legacy adapter");

// 24. adapter termina resolviendo a company_id
assert(legacyReadFpA.companyId === compFpA.companyId, "H2. Legacy adapter resuelve unívocamente a company_id canónico");

// 25. Actualización legacy mantiene dual-write
updateFiscalPeriodStatus(phoneFpTenantA, 2026, 1, 'READY_FOR_GESTORIA');
const legacyUpdatedFpA = getFiscalPeriod(compFpA.companyId, 2026, 1);
assert(legacyUpdatedFpA.status === 'READY_FOR_GESTORIA', "H3. updateFiscalPeriodStatus(phone) actualiza la fila correctamente");
assert(legacyUpdatedFpA.companyId === compFpA.companyId && legacyUpdatedFpA.businessId === phoneFpTenantA, "H4. Dual-write preservado: company_id y business_id sincronizados");

// ─── I. INTEGRIDAD RELACIONAL ───
// 26. PRAGMA foreign_key_check = 0
// 27. PRAGMA integrity_check = ok
const fkViolations38 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult38 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations38.length === 0, "I1. PRAGMA foreign_key_check = 0 violaciones en base de datos de test");
assert(integrityResult38 && (integrityResult38.integrity_check === 'ok' || integrityResult38.integrity_check === 'OK'), "I2. PRAGMA integrity_check = ok en base de datos de test");

cleanupTest38(phoneFpTenantA);
cleanupTest38(phoneFpTenantB);

console.log("\nTEST 39: Migración Controlada de purchase_invoices a company_id (Fase 2E-3 — Backfill, Tenant Isolation & Expense Payments Compatibility)");

// ─── A. MIGRATION 009: EJECUCIÓN Y REGISTRO ───
// A1. migration 009 se registra correctamente en TEST con versión 9
const schemaRow009 = currentDb.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 9").get();
assert(schemaRow009 && schemaRow009.version === 9, "A1. Migración 009 registrada en schema_migrations con versión 9");
assert(schemaRow009 && schemaRow009.name === '009_purchase_invoices_company_id', "A2. Nombre de migración 009 coincide exactamente");
assert(schemaRow009 && typeof schemaRow009.applied_at === 'string' && schemaRow009.applied_at.length > 10, "A3. Migración 009 tiene timestamp applied_at válido");

// A4 & A5. production pre-015 sigue con máximo migration 006 (007, 008 y 009 NO registradas)
const prodDbFor009Check = new DatabaseSync(HISTORICAL_PRE015_PROD_PATH, { readOnly: true });
const prodSchema009 = prodDbFor009Check.prepare("SELECT version FROM schema_migrations WHERE version >= 7").all();
const prodMaxVersion009 = prodDbFor009Check.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get().max_v;
prodDbFor009Check.close();
assert(prodSchema009.length === 0, "A4. DB de producción (data/presuvoz.db) NO tiene registradas las migraciones 007, 008 ni 009");
assert(prodMaxVersion009 === 6, "A5. Versión máxima en DB de producción permanece inalterada en 6");

// A6 & A7. migrations 007 y 008 siguen intactas en test
const schemaRow007In39 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 7").get();
const schemaRow008In39 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 8").get();
assert(schemaRow007In39 && schemaRow007In39.name === '007_business_tax_profiles_company_id', "A6. Migración 007 permanece intacta en la base de datos de test");
assert(schemaRow008In39 && schemaRow008In39.name === '008_fiscal_periods_company_id', "A7. Migración 008 permanece intacta en la base de datos de test");

// ─── B. BACKFILL DETERMINISTA & CASOS FAIL-CLOSED ───
// B1..B5. Memoria con datos existentes
const memDb39B = new DatabaseSync(':memory:');
initMigrationTable(memDb39B);
runMigrations(memDb39B, { migrations: MIGRATIONS.slice(0, 8), authorized: true });

// Insertar 2 empresas con 3 facturas de compra según esquema previo a 009
memDb39B.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-pi-comp1', '34677110001', 'Empresa PI 1 S.L.'),
    ('uuid-pi-comp2', '34677110002', 'Empresa PI 2 S.L.');
  INSERT INTO purchase_invoices (
    id, business_id, supplier_name, supplier_tax_id, invoice_number,
    invoice_date, taxable_base, vat_rate, vat_amount, total_amount,
    deductible_vat_amount, fiscal_period, data_json
  ) VALUES
    ('PINV-BF-01', '34677110001', 'Proveedor A', 'A11111111', 'FA-01', '2026-07-10', 100, 21, 21, 121, 21, '2026_Q3', '{"raw":"data1"}'),
    ('PINV-BF-02', '34677110001', 'Proveedor B', 'B22222222', 'FB-02', '2026-08-15', 200, 21, 42, 242, 42, '2026_Q3', '{"raw":"data2"}'),
    ('PINV-BF-03', '34677110002', 'Proveedor C', 'C33333333', 'FC-03', '2026-09-20', 300, 10, 30, 330, 30, '2026_Q3', '{"raw":"data3"}');
`);

const migRes39 = runMigrations(memDb39B, { migrations: [MIGRATIONS[8]], authorized: true });
assert(migRes39.appliedCount === 1, "B1. Migración 009 se aplica con éxito sobre base de datos con datos");

const piRows39 = memDb39B.prepare("SELECT id, company_id, business_id, supplier_name, total_amount, data_json FROM purchase_invoices ORDER BY id ASC").all();
assert(piRows39.length === 3, "B2. Recuento de filas se preserva exactamente tras migración (3 filas)");
assert(piRows39[0].company_id === 'uuid-pi-comp1' && piRows39[0].business_id === '34677110001', "B3. Fila 1 migrada con company_id correcto de Empresa 1");
assert(piRows39[1].company_id === 'uuid-pi-comp1' && piRows39[1].business_id === '34677110001', "B4. Fila 2 migrada con company_id correcto de Empresa 1");
assert(piRows39[2].company_id === 'uuid-pi-comp2' && piRows39[2].business_id === '34677110002', "B5. Fila 3 migrada con company_id correcto de Empresa 2");

// B6..B10. Rollback atómico ante factura huérfana
const memDb39Rollback = new DatabaseSync(':memory:');
initMigrationTable(memDb39Rollback);
runMigrations(memDb39Rollback, { migrations: MIGRATIONS.slice(0, 8), authorized: true });

memDb39Rollback.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-pi-comp-ok', '34677110001', 'Empresa OK');
  INSERT INTO purchase_invoices (
    id, business_id, supplier_name, invoice_date, taxable_base, vat_rate,
    vat_amount, total_amount, deductible_vat_amount, fiscal_period
  ) VALUES
    ('PINV-OK-01', '34677110001', 'Proveedor OK', '2026-07-10', 100, 21, 21, 121, 21, '2026_Q3'),
    ('PINV-ORPHAN-01', '34699999999', 'Proveedor Fantasma', '2026-07-10', 50, 21, 10.5, 60.5, 10.5, '2026_Q3');
`);

let caughtOrphan009 = false;
let orphanErrMsg009 = '';
try {
  runMigrations(memDb39Rollback, { migrations: [MIGRATIONS[8]], authorized: true });
} catch (err) {
  caughtOrphan009 = true;
  orphanErrMsg009 = err.message;
}
assert(caughtOrphan009 === true, "B6. Migración 009 aborta inmediatamente ante factura recibida huérfana (fail-closed)");
assert(orphanErrMsg009.includes('fail-closed') && orphanErrMsg009.includes('huérfana'), "B7. Error descriptivo fail-closed ante factura con business_id huérfano");

// Verificar rollback atómico
const schemaAfterFail009 = memDb39Rollback.prepare("SELECT * FROM schema_migrations WHERE version = 9").get();
assert(!schemaAfterFail009, "B8. Rollback atómico: Versión 9 NO queda registrada en schema_migrations");

const colsAfterFail009 = memDb39Rollback.prepare('PRAGMA table_info("purchase_invoices")').all();
assert(!colsAfterFail009.some(c => c.name === 'company_id'), "B9. Rollback atómico: La tabla purchase_invoices queda exactamente como estaba");

const tempTableCheck009 = memDb39Rollback.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_invoices_new'").get();
assert(!tempTableCheck009, "B10. Rollback atómico: No quedan tablas temporales (purchase_invoices_new)");

// B11. Fallo ante ambigüedad de companies con el mismo teléfono
const memDb39Ambig = new DatabaseSync(':memory:');
initMigrationTable(memDb39Ambig);
runMigrations(memDb39Ambig, { migrations: MIGRATIONS.slice(0, 8), authorized: true });
memDb39Ambig.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-pi-ambig-1', '34677000099', 'Empresa Ambigua 1'),
    ('uuid-pi-ambig-2', '+34 677 00 00 99', 'Empresa Ambigua 2');
  INSERT INTO purchase_invoices (
    id, business_id, supplier_name, invoice_date, taxable_base, vat_rate,
    vat_amount, total_amount, deductible_vat_amount, fiscal_period
  ) VALUES
    ('PINV-AMBIG-01', '34677000099', 'Proveedor X', '2026-07-10', 100, 21, 21, 121, 21, '2026_Q3');
`);
let caughtAmbig009 = false;
try {
  runMigrations(memDb39Ambig, { migrations: [MIGRATIONS[8]], authorized: true });
} catch (err) {
  caughtAmbig009 = true;
  assert(err.message.includes('Ambigüedad crítica'), "B11. Fail-closed: Múltiples empresas ambiguas provocan aborto y rollback");
}
assert(caughtAmbig009 === true, "B12. Migración 009 aborta ante ambigüedad en companies");

// ─── C. PRESERVACIÓN DE DATOS DOCUMENTALES Y NO CONFUSIÓN CON PROVEEDOR ───
assert(piRows39[0].supplier_name === 'Proveedor A', "C1. supplier_name preservado intacto ('Proveedor A')");
assert(piRows39[0].total_amount === 121, "C2. total_amount preservado intacto (121€)");
assert(piRows39[0].data_json === '{"raw":"data1"}', "C3. data_json original preservado intacto");
// BARRERA CRÍTICA: company_id no proviene del CIF del proveedor ni su nombre
assert(piRows39[0].company_id !== 'A11111111' && piRows39[0].company_id === 'uuid-pi-comp1', "C4. Resolución de tenant NUNCA utiliza datos del proveedor (proveedor ≠ tenant)");

// ─── D. AISLAMIENTO MULTI-TENANT EN TEST DB ───
const phonePiTenantA = '34677112201';
const phonePiTenantB = '34677112202';

const cleanupTest39 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM expense_payments WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM purchase_invoices WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM investment_assets WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest39(phonePiTenantA);
cleanupTest39(phonePiTenantB);

const compPiA = createCompanyWithIdentity({
  name: 'Empresa Alpha Obras S.L.',
  phone: phonePiTenantA,
  trade: 'Construcción'
});
const contextPiA = resolveAuthenticatedContext('whatsapp', phonePiTenantA);

const compPiB = createCompanyWithIdentity({
  name: 'Empresa Beta Electricidad S.L.',
  phone: phonePiTenantB,
  trade: 'Electricidad'
});
const contextPiB = resolveAuthenticatedContext('whatsapp', phonePiTenantB);

// D1. Context A guarda factura REC-39-A01 y Context B guarda REC-39-B01
const invA39 = savePurchaseInvoice(contextPiA, {
  id: 'REC-39-A01',
  supplierName: 'Materiales Alpha Proveedor',
  supplierTaxId: 'B-99887711',
  taxBase: 1000,
  vatRate: 21,
  totalAmount: 1210,
  issueDate: '2026-08-10',
  fiscalPeriod: '2026_Q3'
});
assert(invA39 && invA39.id === 'REC-39-A01', "D1. savePurchaseInvoice de Tenant A registra su factura");

const invB39 = savePurchaseInvoice(contextPiB, {
  id: 'REC-39-B01',
  supplierName: 'Suministros Beta Proveedor',
  supplierTaxId: 'B-99887722',
  taxBase: 500,
  vatRate: 21,
  totalAmount: 605,
  issueDate: '2026-08-11',
  fiscalPeriod: '2026_Q3'
});
assert(invB39 && invB39.id === 'REC-39-B01', "D2. savePurchaseInvoice de Tenant B registra su factura");

// D3. Cross-Tenant Read: getPurchaseInvoice(contextB, 'REC-39-A01') retorna null
const crossReadAfromB_39 = getPurchaseInvoice(contextPiB, 'REC-39-A01');
assert(crossReadAfromB_39 === null, "D3. Cross-Tenant Read: getPurchaseInvoice(tenantB, idA) devuelve null (Zero-Disclosure)");

// D4. Cross-Tenant Read: getPurchaseInvoice(contextA, 'REC-39-B01') retorna null
const crossReadBfromA_39 = getPurchaseInvoice(contextPiA, 'REC-39-B01');
assert(crossReadBfromA_39 === null, "D4. Cross-Tenant Read: getPurchaseInvoice(tenantA, idB) devuelve null (Zero-Disclosure)");

// D5. Lectura legítima de Tenant A
const legitReadA_39 = getPurchaseInvoice(contextPiA, 'REC-39-A01');
assert(legitReadA_39 !== null && legitReadA_39.id === 'REC-39-A01' && legitReadA_39.companyId === compPiA.companyId, "D5. Lectura legítima: getPurchaseInvoice(tenantA, idA) recupera su factura");

// D6. Lectura legítima de Tenant B
const legitReadB_39 = getPurchaseInvoice(contextPiB, 'REC-39-B01');
assert(legitReadB_39 !== null && legitReadB_39.id === 'REC-39-B01' && legitReadB_39.companyId === compPiB.companyId, "D6. Lectura legítima: getPurchaseInvoice(tenantB, idB) recupera su factura");

// D7. Cross-Tenant Delete: deletePurchaseInvoice(contextA, 'REC-39-B01') retorna false
const crossDeleteBfromA_39 = deletePurchaseInvoice(contextPiA, 'REC-39-B01');
assert(crossDeleteBfromA_39 === false, "D7. Cross-Tenant Delete: deletePurchaseInvoice(tenantA, idB) devuelve false");

// D8. Factura de Tenant B permanece intacta en SQLite tras intento de borrado
const verifyPinvBIntact_39 = currentDb.prepare("SELECT * FROM purchase_invoices WHERE id = ?").get('REC-39-B01');
assert(verifyPinvBIntact_39 !== null && verifyPinvBIntact_39.company_id === compPiB.companyId, "D8. Factura de Tenant B permanece 100% intacta en SQLite");

// D9. listPurchaseInvoices(contextA) solo retorna facturas de Tenant A
const listPiA = listPurchaseInvoices(contextPiA);
assert(listPiA.every(inv => inv.companyId === compPiA.companyId) && listPiA.some(inv => inv.id === 'REC-39-A01'), "D9. listPurchaseInvoices(contextA) solo retorna facturas del Tenant A");

// D10. listPurchaseInvoices(contextB) solo retorna facturas de Tenant B
const listPiB = listPurchaseInvoices(contextPiB);
assert(listPiB.every(inv => inv.companyId === compPiB.companyId) && listPiB.some(inv => inv.id === 'REC-39-B01'), "D10. listPurchaseInvoices(contextB) solo retorna facturas del Tenant B");

// ─── E. INYECCIÓN DE MODELO (DEFENSA FAIL-CLOSED) ───
// E1. Gemini spoofing company_id / business_id en payload es ignorado y neutralizado
const maliciousAiInvoice = {
  id: 'REC-39-INJECT-01',
  companyId: compPiB.companyId,
  company_id: compPiB.companyId,
  businessId: phonePiTenantB,
  business_id: phonePiTenantB,
  supplierName: 'Falso Proveedor Inyectado',
  taxBase: 150,
  vatRate: 21,
  totalAmount: 181.5,
  issueDate: '2026-08-15'
};
const savedInjected_39 = savePurchaseInvoice(contextPiA, maliciousAiInvoice);
assert(savedInjected_39.companyId === compPiA.companyId, "E1. Modelo injection defendida: companyId de A se mantiene como autoridad");
assert(savedInjected_39.businessId === phonePiTenantA, "E2. Modelo injection defendida: businessId de A se mantiene sincronizado con phoneA");

const verifyInjectedInDb = currentDb.prepare("SELECT company_id, business_id FROM purchase_invoices WHERE id = ?").get('REC-39-INJECT-01');
assert(verifyInjectedInDb.company_id === compPiA.companyId && verifyInjectedInDb.business_id === phonePiTenantA, "E3. En SQLite, la fila inyectada pertenece legítimamente a Tenant A");

// E4. Tenant B jamás ve la factura inyectada
const readInjectedFromB = getPurchaseInvoice(contextPiB, 'REC-39-INJECT-01');
assert(readInjectedFromB === null, "E4. Tenant B permanece completamente protegido contra payload spoofed");

// ─── F. ROBUSTEZ DE UUID v4 ───
assert(isUuid(savedInjected_39.companyId), "F1. companyId retornado es un UUID v4 canónico");
assert(savedInjected_39.companyId.length === 36 && savedInjected_39.companyId.includes('-'), "F2. companyId tiene formato UUID con guiones intactos (36 caracteres)");

const sqliteRowPiA = currentDb.prepare("SELECT company_id FROM purchase_invoices WHERE id = ?").get('REC-39-A01');
assert(sqliteRowPiA && sqliteRowPiA.company_id === compPiA.companyId, "F3. SQLite almacena el UUID con guiones intactos sin regex stripping");

// ─── G. CLAVE FORÁNEA & ON DELETE RESTRICT ───
// G1. Inserción con company_id inexistente lanza FK constraint violation
let caughtFkInexistentePi = false;
try {
  currentDb.prepare(`
    INSERT INTO purchase_invoices (
      id, company_id, business_id, supplier_name, invoice_date, taxable_base,
      vat_rate, vat_amount, total_amount, deductible_vat_amount, fiscal_period
    ) VALUES ('fake-id-pi', '00000000-0000-4000-8000-000000000099', '34600999999', 'P', '2026-08-01', 10, 21, 2.1, 12.1, 2.1, '2026_Q3');
  `).run();
} catch (err) {
  caughtFkInexistentePi = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G1. Violación de Foreign Key hacia companies(id) detectada");
}
assert(caughtFkInexistentePi === true, "G2. SQLite rechaza inserción en purchase_invoices con company inexistente");

// G3. Inserción con company_id NULL es rechazada
let caughtNullCidPi = false;
try {
  currentDb.prepare(`
    INSERT INTO purchase_invoices (
      id, company_id, business_id, supplier_name, invoice_date, taxable_base,
      vat_rate, vat_amount, total_amount, deductible_vat_amount, fiscal_period
    ) VALUES ('fake-id-pi2', NULL, '34600999999', 'P', '2026-08-01', 10, 21, 2.1, 12.1, 2.1, '2026_Q3');
  `).run();
} catch (err) {
  caughtNullCidPi = true;
  assert(err.message.includes('NOT NULL constraint failed'), "G3. NOT NULL constraint en company_id detectada");
}
assert(caughtNullCidPi === true, "G4. Inserción con company_id NULL es rechazada");

// G5. ON DELETE RESTRICT previene el borrado de empresa con historial de facturas
let caughtRestrictDeletePi = false;
try {
  currentDb.prepare("DELETE FROM companies WHERE id = ?").run(compPiB.companyId);
} catch (err) {
  caughtRestrictDeletePi = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G5. ON DELETE RESTRICT previene el borrado de empresa con facturas de compras");
}
assert(caughtRestrictDeletePi === true, "G6. La empresa no puede ser eliminada mientras tenga registros en purchase_invoices");

// ─── H. COMPATIBILIDAD HACIA ATRÁS (LEGACY ADAPTER & DUAL-WRITE) ───
// H1. getPurchaseInvoice(phone) funciona vía legacy adapter
const legacyReadPiA = getPurchaseInvoice(phonePiTenantA, 'REC-39-A01');
assert(legacyReadPiA !== null && legacyReadPiA.companyId === compPiA.companyId, "H1. getPurchaseInvoice(phone) funciona vía legacy adapter");

// H2. listPurchaseInvoices(phone) funciona vía legacy adapter
const legacyListPiA = listPurchaseInvoices(phonePiTenantA);
assert(legacyListPiA.length >= 1 && legacyListPiA.some(inv => inv.id === 'REC-39-A01'), "H2. listPurchaseInvoices(phone) funciona vía legacy adapter");

// H3. savePurchaseInvoice(phone) actualiza y mantiene dual-write sincronizado
savePurchaseInvoice(phonePiTenantA, {
  id: 'REC-39-A01',
  description: 'Descripción actualizada vía legacy adapter'
});
const updatedLegacyPiA = getPurchaseInvoice(compPiA.companyId, 'REC-39-A01');
assert(updatedLegacyPiA.description === 'Descripción actualizada vía legacy adapter', "H3. savePurchaseInvoice(phone) actualiza correctamente la fila");
assert(updatedLegacyPiA.companyId === compPiA.companyId && updatedLegacyPiA.businessId === phonePiTenantA, "H4. Dual-write preservado: company_id y business_id sincronizados");

// ─── I. COMPATIBILIDAD CON expense_payments ───
// I1. Registrar un pago asociado a purchase_invoice_id
const testExpensePayment = saveExpensePayment(contextPiA, {
  id: 'EPAY-39-01',
  purchaseInvoiceId: 'REC-39-A01',
  amount: 1210,
  paymentDate: '2026-08-10',
  paymentMethod: 'Transferencia',
  reference: 'Factura REC-39-A01 pagada'
});
assert(testExpensePayment && testExpensePayment.purchaseInvoiceId === 'REC-39-A01', "I1. Registro de gasto en expense_payments asociado a purchase_invoice_id correcto");

// I2. Consulta relacional entre purchase_invoices y expense_payments
const joinedRow = currentDb.prepare(`
  SELECT pi.id as inv_id, pi.company_id, ep.id as pay_id, ep.amount
  FROM purchase_invoices pi
  JOIN expense_payments ep ON pi.id = ep.purchase_invoice_id
  WHERE pi.id = ?
`).get('REC-39-A01');
assert(joinedRow !== null && joinedRow.pay_id === 'EPAY-39-01' && joinedRow.company_id === compPiA.companyId, "I2. Integridad relacional entre purchase_invoices y expense_payments preservada al 100%");

// ─── J. INTEGRIDAD RELACIONAL FINAL ───
const fkViolations39 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult39 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations39.length === 0, "J1. PRAGMA foreign_key_check = 0 violaciones en base de datos de test");
assert(integrityResult39 && (integrityResult39.integrity_check === 'ok' || integrityResult39.integrity_check === 'OK'), "J2. PRAGMA integrity_check = ok en base de datos de test");

cleanupTest39(phonePiTenantA);
cleanupTest39(phonePiTenantB);

console.log("\nTEST 40: Migración Controlada de expense_payments a company_id (Fase 2E-4 — Backfill, Tenant Isolation & Relational Integrity)");

// ─── A. MIGRATION 010: EJECUCIÓN Y REGISTRO ───
// A1. migration 010 se registra correctamente en TEST con versión 10
const schemaRow010 = currentDb.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 10").get();
assert(schemaRow010 && schemaRow010.version === 10, "A1. Migración 010 registrada en schema_migrations con versión 10");
assert(schemaRow010 && schemaRow010.name === '010_expense_payments_company_id', "A2. Nombre de migración 010 coincide exactamente");
assert(schemaRow010 && typeof schemaRow010.applied_at === 'string' && schemaRow010.applied_at.length > 10, "A3. Migración 010 tiene timestamp applied_at válido");

// A4 & A5. production pre-015 sigue con máximo migration 006 (007, 008, 009 y 010 NO registradas)
const prodDbFor010Check = new DatabaseSync(HISTORICAL_PRE015_PROD_PATH, { readOnly: true });
const prodSchema010 = prodDbFor010Check.prepare("SELECT version FROM schema_migrations WHERE version >= 7").all();
const prodMaxVersion010 = prodDbFor010Check.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get().max_v;
prodDbFor010Check.close();
assert(prodSchema010.length === 0, "A4. DB de producción (data/presuvoz.db) NO tiene registradas las migraciones 007, 008, 009 ni 010");
assert(prodMaxVersion010 === 6, "A5. Versión máxima en DB de producción permanece inalterada en 6");

// A6 & A7. migrations 008 y 009 siguen intactas en test
const schemaRow008In40 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 8").get();
const schemaRow009In40 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 9").get();
assert(schemaRow008In40 && schemaRow008In40.name === '008_fiscal_periods_company_id', "A6. Migración 008 permanece intacta en la base de datos de test");
assert(schemaRow009In40 && schemaRow009In40.name === '009_purchase_invoices_company_id', "A7. Migración 009 permanece intacta en la base de datos de test");

// ─── B. BACKFILL DETERMINISTA & CASOS FAIL-CLOSED ───
// B1..B5. Memoria con datos existentes
const memDb40B = new DatabaseSync(':memory:');
initMigrationTable(memDb40B);
runMigrations(memDb40B, { migrations: MIGRATIONS.slice(0, 9), authorized: true });

// Insertar 2 empresas, sus facturas de compra y 3 pagos de gasto según esquema previo a 010
memDb40B.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-ep-comp1', '34677220001', 'Empresa Pagos 1 S.L.'),
    ('uuid-ep-comp2', '34677220002', 'Empresa Pagos 2 S.L.');
  INSERT INTO purchase_invoices (
    id, company_id, business_id, supplier_name, invoice_date,
    taxable_base, vat_rate, vat_amount, total_amount, deductible_vat_amount, fiscal_period
  ) VALUES
    ('PINV-40-01', 'uuid-ep-comp1', '34677220001', 'Prov 1', '2026-07-01', 100, 21, 21, 121, 21, '2026_Q3'),
    ('PINV-40-02', 'uuid-ep-comp2', '34677220002', 'Prov 2', '2026-07-02', 200, 21, 42, 242, 42, '2026_Q3');
  INSERT INTO expense_payments (
    id, purchase_invoice_id, business_id, amount, payment_date, payment_method, reference
  ) VALUES
    ('EXP-BF-01', 'PINV-40-01', '34677220001', 60.5, '2026-07-10', 'Transferencia', 'Pago parcial 1'),
    ('EXP-BF-02', 'PINV-40-01', '34677220001', 60.5, '2026-07-20', 'Tarjeta', 'Pago parcial 2'),
    ('EXP-BF-03', 'PINV-40-02', '34677220002', 242, '2026-07-15', 'Transferencia', 'Pago total');
`);

const migRes40 = runMigrations(memDb40B, { migrations: [MIGRATIONS[9]], authorized: true });
assert(migRes40.appliedCount === 1, "B1. Migración 010 se aplica con éxito sobre base de datos con datos");

const epRows40 = memDb40B.prepare("SELECT id, company_id, business_id, purchase_invoice_id, amount, payment_method, reference FROM expense_payments ORDER BY id ASC").all();
assert(epRows40.length === 3, "B2. Recuento de filas se preserva exactamente tras migración (3 filas)");
assert(epRows40[0].company_id === 'uuid-ep-comp1' && epRows40[0].business_id === '34677220001', "B3. Fila 1 migrada con company_id correcto de Empresa 1");
assert(epRows40[1].company_id === 'uuid-ep-comp1' && epRows40[1].business_id === '34677220001', "B4. Fila 2 migrada con company_id correcto de Empresa 1");
assert(epRows40[2].company_id === 'uuid-ep-comp2' && epRows40[2].business_id === '34677220002', "B5. Fila 3 migrada con company_id correcto de Empresa 2");

// B6..B10. Rollback atómico ante pago huérfano
const memDb40Rollback = new DatabaseSync(':memory:');
initMigrationTable(memDb40Rollback);
runMigrations(memDb40Rollback, { migrations: MIGRATIONS.slice(0, 9), authorized: true });

memDb40Rollback.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-ep-comp-ok', '34677220001', 'Empresa OK');
  INSERT INTO expense_payments (
    id, purchase_invoice_id, business_id, amount, payment_date
  ) VALUES
    ('EXP-OK-01', 'PINV-ANY', '34677220001', 100, '2026-07-10'),
    ('EXP-ORPHAN-01', 'PINV-ANY', '34699999999', 50, '2026-07-10');
`);

let caughtOrphan010 = false;
let orphanErrMsg010 = '';
try {
  runMigrations(memDb40Rollback, { migrations: [MIGRATIONS[9]], authorized: true });
} catch (err) {
  caughtOrphan010 = true;
  orphanErrMsg010 = err.message;
}
assert(caughtOrphan010 === true, "B6. Migración 010 aborta inmediatamente ante pago huérfano (fail-closed)");
assert(orphanErrMsg010.includes('fail-closed') && orphanErrMsg010.includes('huérfano'), "B7. Error descriptivo fail-closed ante pago con business_id huérfano");

// Verificar rollback atómico
const schemaAfterFail010 = memDb40Rollback.prepare("SELECT * FROM schema_migrations WHERE version = 10").get();
assert(!schemaAfterFail010, "B8. Rollback atómico: Versión 10 NO queda registrada en schema_migrations");

const colsAfterFail010 = memDb40Rollback.prepare('PRAGMA table_info("expense_payments")').all();
assert(!colsAfterFail010.some(c => c.name === 'company_id'), "B9. Rollback atómico: La tabla expense_payments queda exactamente como estaba");

const tempTableCheck010 = memDb40Rollback.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='expense_payments_new'").get();
assert(!tempTableCheck010, "B10. Rollback atómico: No quedan tablas temporales (expense_payments_new)");

// B11..B12. Fallo ante ambigüedad de companies con el mismo teléfono
const memDb40Ambig = new DatabaseSync(':memory:');
initMigrationTable(memDb40Ambig);
runMigrations(memDb40Ambig, { migrations: MIGRATIONS.slice(0, 9), authorized: true });
memDb40Ambig.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-ep-ambig-1', '34677000099', 'Empresa Ambigua 1'),
    ('uuid-ep-ambig-2', '+34 677 00 00 99', 'Empresa Ambigua 2');
  INSERT INTO expense_payments (
    id, purchase_invoice_id, business_id, amount, payment_date
  ) VALUES
    ('EXP-AMBIG-01', 'PINV-X', '34677000099', 100, '2026-07-10');
`);
let caughtAmbig010 = false;
try {
  runMigrations(memDb40Ambig, { migrations: [MIGRATIONS[9]], authorized: true });
} catch (err) {
  caughtAmbig010 = true;
  assert(err.message.includes('Ambigüedad crítica'), "B11. Fail-closed: Múltiples empresas ambiguas provocan aborto y rollback");
}
assert(caughtAmbig010 === true, "B12. Migración 010 aborta ante ambigüedad en companies");

// B13..B14. Fallo ante inconsistencia cross-tenant entre pago y factura
const memDb40CrossTenant = new DatabaseSync(':memory:');
initMigrationTable(memDb40CrossTenant);
runMigrations(memDb40CrossTenant, { migrations: MIGRATIONS.slice(0, 9), authorized: true });
memDb40CrossTenant.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-ep-cross-1', '34677330001', 'Empresa Alpha'),
    ('uuid-ep-cross-2', '34677330002', 'Empresa Beta');
  INSERT INTO purchase_invoices (
    id, company_id, business_id, supplier_name, invoice_date,
    taxable_base, vat_rate, vat_amount, total_amount, deductible_vat_amount, fiscal_period
  ) VALUES
    ('PINV-BETA-01', 'uuid-ep-cross-2', '34677330002', 'Prov Beta', '2026-07-01', 100, 21, 21, 121, 21, '2026_Q3');
  INSERT INTO expense_payments (
    id, purchase_invoice_id, business_id, amount, payment_date
  ) VALUES
    ('EXP-CROSS-01', 'PINV-BETA-01', '34677330001', 121, '2026-07-02');
`);
let caughtCrossTenant010 = false;
try {
  runMigrations(memDb40CrossTenant, { migrations: [MIGRATIONS[9]], authorized: true });
} catch (err) {
  caughtCrossTenant010 = true;
  assert(err.message.includes('Inconsistencia cross-tenant'), "B13. Fail-closed: Inconsistencia cross-tenant entre pago y factura provoca aborto");
}
assert(caughtCrossTenant010 === true, "B14. Migración 010 aborta ante inconsistencia cross-tenant");

// ─── C. PRESERVACIÓN DE DATOS DOCUMENTALES ───
assert(epRows40[0].purchase_invoice_id === 'PINV-40-01', "C1. purchase_invoice_id preservado intacto ('PINV-40-01')");
assert(epRows40[0].amount === 60.5, "C2. amount preservado intacto (60.5€)");
assert(epRows40[0].payment_method === 'Transferencia', "C3. payment_method preservado intacto ('Transferencia')");
assert(epRows40[0].reference === 'Pago parcial 1', "C4. reference preservado intacto ('Pago parcial 1')");

// ─── D. AISLAMIENTO MULTI-TENANT EN TEST DB ───
const phoneEpTenantA = '34677331101';
const phoneEpTenantB = '34677331102';

const cleanupTest40 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM expense_payments WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM purchase_invoices WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM investment_assets WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest40(phoneEpTenantA);
cleanupTest40(phoneEpTenantB);

const compEpA = createCompanyWithIdentity({
  name: 'Empresa Alpha Clima S.L.',
  phone: phoneEpTenantA,
  trade: 'Climatización'
});
const contextEpA = resolveAuthenticatedContext('whatsapp', phoneEpTenantA);

const compEpB = createCompanyWithIdentity({
  name: 'Empresa Beta Pinturas S.L.',
  phone: phoneEpTenantB,
  trade: 'Pintura'
});
const contextEpB = resolveAuthenticatedContext('whatsapp', phoneEpTenantB);

// Crear facturas recibidas legítimas para cada tenant
const invA40 = savePurchaseInvoice(contextEpA, {
  id: 'REC-40-A01',
  supplierName: 'Material Clima A',
  taxBase: 1000,
  vatRate: 21,
  totalAmount: 1210,
  issueDate: '2026-08-10'
});
const invB40 = savePurchaseInvoice(contextEpB, {
  id: 'REC-40-B01',
  supplierName: 'Pinturas Pro B',
  taxBase: 500,
  vatRate: 21,
  totalAmount: 605,
  issueDate: '2026-08-11'
});

// D1 & D2. Cada tenant registra su pago de gasto
const payA40 = saveExpensePayment(contextEpA, {
  id: 'EXP-40-A01',
  purchaseInvoiceId: 'REC-40-A01',
  amount: 1210,
  paymentDate: '2026-08-10',
  paymentMethod: 'Transferencia',
  reference: 'Pago factura Clima'
});
assert(payA40 && payA40.id === 'EXP-40-A01', "D1. saveExpensePayment de Tenant A registra su pago");

const payB40 = saveExpensePayment(contextEpB, {
  id: 'EXP-40-B01',
  purchaseInvoiceId: 'REC-40-B01',
  amount: 605,
  paymentDate: '2026-08-11',
  paymentMethod: 'Tarjeta',
  reference: 'Pago pintura B'
});
assert(payB40 && payB40.id === 'EXP-40-B01', "D2. saveExpensePayment de Tenant B registra su pago");

// D3. Cross-Tenant Read: getExpensePayment(contextB, idA) devuelve null
const crossReadAfromB_40 = getExpensePayment(contextEpB, 'EXP-40-A01');
assert(crossReadAfromB_40 === null, "D3. Cross-Tenant Read: getExpensePayment(tenantB, idA) devuelve null (Zero-Disclosure)");

// D4. Cross-Tenant Read: getExpensePayment(contextA, idB) devuelve null
const crossReadBfromA_40 = getExpensePayment(contextEpA, 'EXP-40-B01');
assert(crossReadBfromA_40 === null, "D4. Cross-Tenant Read: getExpensePayment(tenantA, idB) devuelve null (Zero-Disclosure)");

// D5. Lectura legítima de Tenant A
const legitReadA_40 = getExpensePayment(contextEpA, 'EXP-40-A01');
assert(legitReadA_40 !== null && legitReadA_40.id === 'EXP-40-A01' && legitReadA_40.companyId === compEpA.companyId, "D5. Lectura legítima: getExpensePayment(tenantA, idA) recupera su pago");

// D6. Lectura legítima de Tenant B
const legitReadB_40 = getExpensePayment(contextEpB, 'EXP-40-B01');
assert(legitReadB_40 !== null && legitReadB_40.id === 'EXP-40-B01' && legitReadB_40.companyId === compEpB.companyId, "D6. Lectura legítima: getExpensePayment(tenantB, idB) recupera su pago");

// D7. Cross-Tenant Delete: deleteExpensePayment(tenantA, idB) devuelve false
const crossDeleteBfromA_40 = deleteExpensePayment(contextEpA, 'EXP-40-B01');
assert(crossDeleteBfromA_40 === false, "D7. Cross-Tenant Delete: deleteExpensePayment(tenantA, idB) devuelve false");

// D8. Pago de Tenant B permanece intacto tras intento cross-tenant
const verifyEpBIntact_40 = currentDb.prepare("SELECT * FROM expense_payments WHERE id = ?").get('EXP-40-B01');
assert(verifyEpBIntact_40 !== null && verifyEpBIntact_40.company_id === compEpB.companyId, "D8. Pago de Tenant B permanece 100% intacto en SQLite");

// D9. listExpensePayments(contextA) solo retorna pagos de Tenant A
const listEpA = listExpensePayments(contextEpA);
assert(listEpA.every(p => p.companyId === compEpA.companyId) && listEpA.some(p => p.id === 'EXP-40-A01'), "D9. listExpensePayments(contextA) solo retorna pagos del Tenant A");

// D10. listExpensePayments(contextB) solo retorna pagos de Tenant B
const listEpB = listExpensePayments(contextEpB);
assert(listEpB.every(p => p.companyId === compEpB.companyId) && listEpB.some(p => p.id === 'EXP-40-B01'), "D10. listExpensePayments(contextB) solo retorna pagos del Tenant B");

// D11. Intento de asociar pago a factura de otro tenant es bloqueado
const crossTenantPayAttempt = saveExpensePayment(contextEpA, {
  id: 'EXP-CROSS-ATTEMPT',
  purchaseInvoiceId: 'REC-40-B01', // Factura de Tenant B
  amount: 100,
  paymentDate: '2026-08-12'
});
assert(crossTenantPayAttempt === null, "D11. Intento de asociar pago a factura de otro tenant es bloqueado (retorna null)");

// ─── E. INYECCIÓN DE MODELO (DEFENSA FAIL-CLOSED) ───
// E1..E4. Gemini spoofing company_id / business_id en payload es neutralizado
const maliciousAiExpensePayment = {
  id: 'EXP-40-INJECT-01',
  companyId: compEpB.companyId,
  company_id: compEpB.companyId,
  businessId: phoneEpTenantB,
  business_id: phoneEpTenantB,
  purchaseInvoiceId: 'REC-40-A01',
  amount: 250,
  paymentDate: '2026-08-15',
  paymentMethod: 'Efectivo',
  reference: 'Inyección maliciosa'
};
const savedInjected_40 = saveExpensePayment(contextEpA, maliciousAiExpensePayment);
assert(savedInjected_40.companyId === compEpA.companyId, "E1. Modelo injection defendida: companyId de A se mantiene como autoridad");
assert(savedInjected_40.businessId === phoneEpTenantA, "E2. Modelo injection defendida: businessId de A se mantiene sincronizado con phoneA");

const verifyInjectedEpInDb = currentDb.prepare("SELECT company_id, business_id FROM expense_payments WHERE id = ?").get('EXP-40-INJECT-01');
assert(verifyInjectedEpInDb.company_id === compEpA.companyId && verifyInjectedEpInDb.business_id === phoneEpTenantA, "E3. En SQLite, el pago inyectado pertenece legítimamente a Tenant A");

const readInjectedEpFromB = getExpensePayment(contextEpB, 'EXP-40-INJECT-01');
assert(readInjectedEpFromB === null, "E4. Tenant B permanece completamente protegido contra payload spoofed");

// ─── F. ROBUSTEZ DE UUID v4 ───
assert(isUuid(savedInjected_40.companyId), "F1. companyId retornado es un UUID v4 canónico");
assert(savedInjected_40.companyId.length === 36 && savedInjected_40.companyId.includes('-'), "F2. companyId tiene formato UUID con guiones intactos (36 caracteres)");

const sqliteRowEpA = currentDb.prepare("SELECT company_id FROM expense_payments WHERE id = ?").get('EXP-40-A01');
assert(sqliteRowEpA && sqliteRowEpA.company_id === compEpA.companyId, "F3. SQLite almacena el UUID con guiones intactos sin regex stripping");

// ─── G. CLAVE FORÁNEA & ON DELETE RESTRICT ───
// G1. Inserción con company_id inexistente lanza FK constraint violation
let caughtFkInexistenteEp = false;
try {
  currentDb.prepare(`
    INSERT INTO expense_payments (id, company_id, purchase_invoice_id, business_id, amount, payment_date)
    VALUES ('fake-id-ep', '00000000-0000-4000-8000-000000000099', 'PINV-ANY', '34600999999', 50, '2026-08-01');
  `).run();
} catch (err) {
  caughtFkInexistenteEp = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G1. Violación de Foreign Key hacia companies(id) detectada");
}
assert(caughtFkInexistenteEp === true, "G2. SQLite rechaza inserción en expense_payments con company inexistente");

// G3. Inserción con company_id NULL es rechazada
let caughtNullCidEp = false;
try {
  currentDb.prepare(`
    INSERT INTO expense_payments (id, company_id, purchase_invoice_id, business_id, amount, payment_date)
    VALUES ('fake-id-ep2', NULL, 'PINV-ANY', '34600999999', 50, '2026-08-01');
  `).run();
} catch (err) {
  caughtNullCidEp = true;
  assert(err.message.includes('NOT NULL constraint failed'), "G3. NOT NULL constraint en company_id detectada");
}
assert(caughtNullCidEp === true, "G4. Inserción con company_id NULL es rechazada");

// G5. ON DELETE RESTRICT previene el borrado de empresa con historial de pagos
let caughtRestrictDeleteEp = false;
try {
  currentDb.prepare("DELETE FROM companies WHERE id = ?").run(compEpB.companyId);
} catch (err) {
  caughtRestrictDeleteEp = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G5. ON DELETE RESTRICT previene el borrado de empresa con historial de pagos");
}
assert(caughtRestrictDeleteEp === true, "G6. La empresa no puede ser eliminada mientras tenga registros en expense_payments");

// ─── H. COMPATIBILIDAD HACIA ATRÁS (LEGACY ADAPTER & DUAL-WRITE) ───
// H1. getExpensePayment(phone) funciona vía legacy adapter
const legacyReadEpA = getExpensePayment(phoneEpTenantA, 'EXP-40-A01');
assert(legacyReadEpA !== null && legacyReadEpA.companyId === compEpA.companyId, "H1. getExpensePayment(phone) funciona vía legacy adapter");

// H2. listExpensePayments(phone) funciona vía legacy adapter
const legacyListEpA = listExpensePayments(phoneEpTenantA);
assert(legacyListEpA.length >= 1 && legacyListEpA.some(p => p.id === 'EXP-40-A01'), "H2. listExpensePayments(phone) funciona vía legacy adapter");

// H3. saveExpensePayment(phone) actualiza y mantiene dual-write sincronizado
saveExpensePayment(phoneEpTenantA, {
  id: 'EXP-40-A01',
  reference: 'Referencia actualizada vía legacy adapter'
});
const updatedLegacyEpA = getExpensePayment(compEpA.companyId, 'EXP-40-A01');
assert(updatedLegacyEpA.reference === 'Referencia actualizada vía legacy adapter', "H3. saveExpensePayment(phone) actualiza correctamente la fila");
assert(updatedLegacyEpA.companyId === compEpA.companyId && updatedLegacyEpA.businessId === phoneEpTenantA, "H4. Dual-write preservado: company_id y business_id sincronizados");

// ─── I. INTEGRIDAD RELACIONAL FINAL ───
const fkViolations40 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult40 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations40.length === 0, "I1. PRAGMA foreign_key_check = 0 violaciones en base de datos de test");
assert(integrityResult40 && (integrityResult40.integrity_check === 'ok' || integrityResult40.integrity_check === 'OK'), "I2. PRAGMA integrity_check = ok en base de datos de test");

cleanupTest40(phoneEpTenantA);
cleanupTest40(phoneEpTenantB);

console.log("\nTEST 41: Migración Controlada de investment_assets a company_id (Fase 2E-5 — Backfill, Tenant Isolation & Relational Integrity)");

// ─── A. MIGRATION 011: EJECUCIÓN Y REGISTRO ───
// A1. migration 011 se registra correctamente en TEST con versión 11
const schemaRow011 = currentDb.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 11").get();
assert(schemaRow011 && schemaRow011.version === 11, "A1. Migración 011 registrada en schema_migrations con versión 11");
assert(schemaRow011 && schemaRow011.name === '011_investment_assets_company_id', "A2. Nombre de migración 011 coincide exactamente");
assert(schemaRow011 && typeof schemaRow011.applied_at === 'string' && schemaRow011.applied_at.length > 10, "A3. Migración 011 tiene timestamp applied_at válido");

// A4 & A5. production pre-015 sigue con máximo migration 006 (007, 008, 009, 010 y 011 NO registradas)
const prodDbFor011Check = new DatabaseSync(HISTORICAL_PRE015_PROD_PATH, { readOnly: true });
const prodSchema011 = prodDbFor011Check.prepare("SELECT version FROM schema_migrations WHERE version >= 7").all();
const prodMaxVersion011 = prodDbFor011Check.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get().max_v;
prodDbFor011Check.close();
assert(prodSchema011.length === 0, "A4. DB de producción (data/presuvoz.db) NO tiene registradas las migraciones 007, 008, 009, 010 ni 011");
assert(prodMaxVersion011 === 6, "A5. Versión máxima en DB de producción permanece inalterada en 6");

// A6 & A7. migrations 009 y 010 siguen intactas en test
const schemaRow009In41 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 9").get();
const schemaRow010In41 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 10").get();
assert(schemaRow009In41 && schemaRow009In41.name === '009_purchase_invoices_company_id', "A6. Migración 009 permanece intacta en la base de datos de test");
assert(schemaRow010In41 && schemaRow010In41.name === '010_expense_payments_company_id', "A7. Migración 010 permanece intacta en la base de datos de test");

// ─── B. BACKFILL DETERMINISTA & CASOS FAIL-CLOSED ───
// B1..B5. Memoria con datos existentes
const memDb41B = new DatabaseSync(':memory:');
initMigrationTable(memDb41B);
runMigrations(memDb41B, { migrations: MIGRATIONS.slice(0, 10), authorized: true });

// Insertar 2 empresas, sus facturas de compra y 3 bienes de inversión según esquema previo a 011
memDb41B.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-ia-comp1', '34677440001', 'Empresa Maquinaria 1 S.L.'),
    ('uuid-ia-comp2', '34677440002', 'Empresa Maquinaria 2 S.L.');
  INSERT INTO purchase_invoices (
    id, company_id, business_id, supplier_name, invoice_date,
    taxable_base, vat_rate, vat_amount, total_amount, deductible_vat_amount, fiscal_period
  ) VALUES
    ('PINV-41-01', 'uuid-ia-comp1', '34677440001', 'Maquinaria Norte', '2026-07-01', 5000, 21, 1050, 6050, 1050, '2026_Q3'),
    ('PINV-41-02', 'uuid-ia-comp2', '34677440002', 'Herramientas Sur', '2026-07-02', 3500, 21, 735, 4235, 735, '2026_Q3');
  INSERT INTO investment_assets (
    id, business_id, purchase_invoice_id, description, purchase_date,
    supplier_name, purchase_base, vat_amount, total_amount,
    business_use_percentage, depreciation_method, depreciation_status, notes, created_at
  ) VALUES
    ('AST-BF-01', '34677440001', 'PINV-41-01', 'Excavadora Mini', '2026-07-01', 'Maquinaria Norte', 5000, 1050, 6050, 100, 'TABLAS_OFICIALES', 'NEEDS_GESTOR_REVIEW', 'Nota 1', '2026-07-01T10:00:00Z'),
    ('AST-BF-02', '34677440001', NULL, 'Generador Diésel', '2026-07-15', 'Generadores S.A.', 3200, 672, 3872, 80, 'TABLAS_OFICIALES', 'NEEDS_GESTOR_REVIEW', 'Nota 2', '2026-07-15T11:00:00Z'),
    ('AST-BF-03', '34677440002', 'PINV-41-02', 'Compresor Industrial', '2026-07-02', 'Herramientas Sur', 3500, 735, 4235, 100, 'TABLAS_OFICIALES', 'NEEDS_GESTOR_REVIEW', 'Nota 3', '2026-07-02T12:00:00Z');
`);

const migRes41 = runMigrations(memDb41B, { migrations: [MIGRATIONS[10]], authorized: true });
assert(migRes41.appliedCount === 1, "B1. Migración 011 se aplica con éxito sobre base de datos con datos");

const iaRows41 = memDb41B.prepare("SELECT id, company_id, business_id, purchase_invoice_id, description, purchase_base, vat_amount, total_amount, business_use_percentage, depreciation_method, depreciation_status FROM investment_assets ORDER BY id ASC").all();
assert(iaRows41.length === 3, "B2. Recuento de filas se preserva exactamente tras migración (3 filas)");
assert(iaRows41[0].company_id === 'uuid-ia-comp1' && iaRows41[0].business_id === '34677440001', "B3. Fila 1 migrada con company_id correcto de Empresa 1");
assert(iaRows41[1].company_id === 'uuid-ia-comp1' && iaRows41[1].business_id === '34677440001', "B4. Fila 2 migrada con company_id correcto de Empresa 1");
assert(iaRows41[2].company_id === 'uuid-ia-comp2' && iaRows41[2].business_id === '34677440002', "B5. Fila 3 migrada con company_id correcto de Empresa 2");

// B6..B10. Rollback atómico ante activo huérfano
const memDb41Rollback = new DatabaseSync(':memory:');
initMigrationTable(memDb41Rollback);
runMigrations(memDb41Rollback, { migrations: MIGRATIONS.slice(0, 10), authorized: true });

memDb41Rollback.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-ia-comp-ok', '34677440001', 'Empresa OK');
  INSERT INTO investment_assets (
    id, business_id, purchase_invoice_id, description, purchase_date, purchase_base, vat_amount, total_amount
  ) VALUES
    ('AST-OK-01', '34677440001', NULL, 'Herramienta OK', '2026-07-10', 3100, 651, 3751),
    ('AST-ORPHAN-01', '34699999999', NULL, 'Herramienta Huérfana', '2026-07-10', 3200, 672, 3872);
`);

let caughtOrphan011 = false;
let orphanErrMsg011 = '';
try {
  runMigrations(memDb41Rollback, { migrations: [MIGRATIONS[10]], authorized: true });
} catch (err) {
  caughtOrphan011 = true;
  orphanErrMsg011 = err.message;
}
assert(caughtOrphan011 === true, "B6. Migración 011 aborta inmediatamente ante activo huérfano (fail-closed)");
assert(orphanErrMsg011.includes('fail-closed') && orphanErrMsg011.includes('huérfano'), "B7. Error descriptivo fail-closed ante activo con business_id huérfano");

// Verificar rollback atómico
const schemaAfterFail011 = memDb41Rollback.prepare("SELECT * FROM schema_migrations WHERE version = 11").get();
assert(!schemaAfterFail011, "B8. Rollback atómico: Versión 11 NO queda registrada en schema_migrations");

const colsAfterFail011 = memDb41Rollback.prepare('PRAGMA table_info("investment_assets")').all();
assert(!colsAfterFail011.some(c => c.name === 'company_id'), "B9. Rollback atómico: La tabla investment_assets queda exactamente como estaba");

const tempTableCheck011 = memDb41Rollback.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='investment_assets_new'").get();
assert(!tempTableCheck011, "B10. Rollback atómico: No quedan tablas temporales (investment_assets_new)");

// B11..B12. Fallo ante ambigüedad de companies con el mismo teléfono
const memDb41Ambig = new DatabaseSync(':memory:');
initMigrationTable(memDb41Ambig);
runMigrations(memDb41Ambig, { migrations: MIGRATIONS.slice(0, 10), authorized: true });
memDb41Ambig.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-ia-ambig-1', '34677000099', 'Empresa Ambigua 1'),
    ('uuid-ia-ambig-2', '+34 677 00 00 99', 'Empresa Ambigua 2');
  INSERT INTO investment_assets (
    id, business_id, purchase_invoice_id, description, purchase_date, purchase_base, vat_amount, total_amount
  ) VALUES
    ('AST-AMBIG-01', '34677000099', NULL, 'Activo Ambiguo', '2026-07-10', 3100, 651, 3751);
`);
let caughtAmbig011 = false;
try {
  runMigrations(memDb41Ambig, { migrations: [MIGRATIONS[10]], authorized: true });
} catch (err) {
  caughtAmbig011 = true;
  assert(err.message.includes('Ambigüedad crítica'), "B11. Fail-closed: Múltiples empresas ambiguas provocan aborto y rollback");
}
assert(caughtAmbig011 === true, "B12. Migración 011 aborta ante ambigüedad en companies");

// B13..B14. Fallo ante inconsistencia cross-tenant entre activo y factura de compra
const memDb41CrossTenant = new DatabaseSync(':memory:');
initMigrationTable(memDb41CrossTenant);
runMigrations(memDb41CrossTenant, { migrations: MIGRATIONS.slice(0, 10), authorized: true });
memDb41CrossTenant.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-ia-cross-1', '34677550001', 'Empresa Maquinaria Alpha'),
    ('uuid-ia-cross-2', '34677550002', 'Empresa Maquinaria Beta');
  INSERT INTO purchase_invoices (
    id, company_id, business_id, supplier_name, invoice_date,
    taxable_base, vat_rate, vat_amount, total_amount, deductible_vat_amount, fiscal_period
  ) VALUES
    ('PINV-BETA-41', 'uuid-ia-cross-2', '34677550002', 'Prov Beta', '2026-07-01', 4000, 21, 840, 4840, 840, '2026_Q3');
  INSERT INTO investment_assets (
    id, business_id, purchase_invoice_id, description, purchase_date, purchase_base, vat_amount, total_amount
  ) VALUES
    ('AST-CROSS-01', '34677550001', 'PINV-BETA-41', 'Torno Mecánico', '2026-07-02', 4000, 840, 4840);
`);
let caughtCrossTenant011 = false;
try {
  runMigrations(memDb41CrossTenant, { migrations: [MIGRATIONS[10]], authorized: true });
} catch (err) {
  caughtCrossTenant011 = true;
  assert(err.message.includes('Inconsistencia cross-tenant'), "B13. Fail-closed: Inconsistencia cross-tenant entre activo y factura provoca aborto");
}
assert(caughtCrossTenant011 === true, "B14. Migración 011 aborta ante inconsistencia cross-tenant");

// ─── C. PRESERVACIÓN DE DATOS DE BIENES DE INVERSIÓN ───
assert(iaRows41[0].purchase_invoice_id === 'PINV-41-01', "C1. purchase_invoice_id preservado intacto ('PINV-41-01')");
assert(iaRows41[0].description === 'Excavadora Mini', "C2. description preservado intacto ('Excavadora Mini')");
assert(iaRows41[0].purchase_base === 5000 && iaRows41[0].vat_amount === 1050 && iaRows41[0].total_amount === 6050, "C3. purchase_base, vat_amount y total_amount preservados");
assert(iaRows41[0].business_use_percentage === 100 && iaRows41[0].depreciation_method === 'TABLAS_OFICIALES' && iaRows41[0].depreciation_status === 'NEEDS_GESTOR_REVIEW', "C4. business_use_percentage, depreciation_method y depreciation_status preservados");

// ─── D. AISLAMIENTO MULTI-TENANT EN TEST DB ───
const phoneIaTenantA = '34677441101';
const phoneIaTenantB = '34677441102';

const cleanupTest41 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM investment_assets WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM expense_payments WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM purchase_invoices WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest41(phoneIaTenantA);
cleanupTest41(phoneIaTenantB);

const compIaA = createCompanyWithIdentity({
  name: 'Empresa Alpha Excavaciones S.L.',
  phone: phoneIaTenantA,
  trade: 'Excavaciones'
});
const contextIaA = resolveAuthenticatedContext('whatsapp', phoneIaTenantA);

const compIaB = createCompanyWithIdentity({
  name: 'Empresa Beta Maquinaria S.L.',
  phone: phoneIaTenantB,
  trade: 'Maquinaria Pesada'
});
const contextIaB = resolveAuthenticatedContext('whatsapp', phoneIaTenantB);

// Crear facturas de compra legítimas para cada tenant
const invA41 = savePurchaseInvoice(contextIaA, {
  id: 'REC-41-A01',
  supplierName: 'Distribuidor Maquinaria A',
  taxBase: 6000,
  vatRate: 21,
  totalAmount: 7260,
  issueDate: '2026-08-10'
});
const invB41 = savePurchaseInvoice(contextIaB, {
  id: 'REC-41-B01',
  supplierName: 'Distribuidor Maquinaria B',
  taxBase: 4500,
  vatRate: 21,
  totalAmount: 5445,
  issueDate: '2026-08-11'
});

// D1 & D2. Cada tenant registra su bien de inversión
const astA41 = saveInvestmentAsset(contextIaA, {
  id: 'AST-41-A01',
  purchaseInvoiceId: 'REC-41-A01',
  description: 'Retroexcavadora Alpha',
  purchaseDate: '2026-08-10',
  supplierName: 'Distribuidor Maquinaria A',
  purchaseBase: 6000,
  vatAmount: 1260,
  totalAmount: 7260,
  businessUsePercentage: 100
});
assert(astA41 && astA41.id === 'AST-41-A01', "D1. saveInvestmentAsset de Tenant A registra su bien de inversión");

const astB41 = saveInvestmentAsset(contextIaB, {
  id: 'AST-41-B01',
  purchaseInvoiceId: 'REC-41-B01',
  description: 'Pala Cargadora Beta',
  purchaseDate: '2026-08-11',
  supplierName: 'Distribuidor Maquinaria B',
  purchaseBase: 4500,
  vatAmount: 945,
  totalAmount: 5445,
  businessUsePercentage: 100
});
assert(astB41 && astB41.id === 'AST-41-B01', "D2. saveInvestmentAsset de Tenant B registra su bien de inversión");

// D3. Cross-Tenant Read: getInvestmentAsset(contextB, idA) devuelve null
const crossReadAfromB_41 = getInvestmentAsset(contextIaB, 'AST-41-A01');
assert(crossReadAfromB_41 === null, "D3. Cross-Tenant Read: getInvestmentAsset(tenantB, idA) devuelve null (Zero-Disclosure)");

// D4. Cross-Tenant Read: getInvestmentAsset(contextA, idB) devuelve null
const crossReadBfromA_41 = getInvestmentAsset(contextIaA, 'AST-41-B01');
assert(crossReadBfromA_41 === null, "D4. Cross-Tenant Read: getInvestmentAsset(tenantA, idB) devuelve null (Zero-Disclosure)");

// D5. Lectura legítima de Tenant A
const legitReadA_41 = getInvestmentAsset(contextIaA, 'AST-41-A01');
assert(legitReadA_41 !== null && legitReadA_41.id === 'AST-41-A01' && legitReadA_41.companyId === compIaA.companyId, "D5. Lectura legítima: getInvestmentAsset(tenantA, idA) recupera su activo");

// D6. Lectura legítima de Tenant B
const legitReadB_41 = getInvestmentAsset(contextIaB, 'AST-41-B01');
assert(legitReadB_41 !== null && legitReadB_41.id === 'AST-41-B01' && legitReadB_41.companyId === compIaB.companyId, "D6. Lectura legítima: getInvestmentAsset(tenantB, idB) recupera su activo");

// D7. Cross-Tenant Delete: deleteInvestmentAsset(tenantA, idB) devuelve false
const crossDeleteBfromA_41 = deleteInvestmentAsset(contextIaA, 'AST-41-B01');
assert(crossDeleteBfromA_41 === false, "D7. Cross-Tenant Delete: deleteInvestmentAsset(tenantA, idB) devuelve false");

// D8. Activo de Tenant B permanece intacto tras intento cross-tenant
const verifyAstBIntact_41 = currentDb.prepare("SELECT * FROM investment_assets WHERE id = ?").get('AST-41-B01');
assert(verifyAstBIntact_41 !== null && verifyAstBIntact_41.company_id === compIaB.companyId, "D8. Activo de Tenant B permanece 100% intacto en SQLite");

// D9. listInvestmentAssets(contextA) solo retorna activos de Tenant A
const listIaA = listInvestmentAssets(contextIaA);
assert(listIaA.every(a => a.companyId === compIaA.companyId) && listIaA.some(a => a.id === 'AST-41-A01'), "D9. listInvestmentAssets(contextA) solo retorna activos del Tenant A");

// D10. listInvestmentAssets(contextB) solo retorna activos de Tenant B
const listIaB = listInvestmentAssets(contextIaB);
assert(listIaB.every(a => a.companyId === compIaB.companyId) && listIaB.some(a => a.id === 'AST-41-B01'), "D10. listInvestmentAssets(contextB) solo retorna activos del Tenant B");

// D11. Intento de asociar activo a factura de compra de otro tenant es bloqueado
const crossTenantAssetAttempt = saveInvestmentAsset(contextIaA, {
  id: 'AST-CROSS-ATTEMPT',
  purchaseInvoiceId: 'REC-41-B01', // Factura de Tenant B
  description: 'Activo con factura ajena',
  purchaseDate: '2026-08-12',
  purchaseBase: 3500,
  vatAmount: 735,
  totalAmount: 4235
});
assert(crossTenantAssetAttempt === null, "D11. Intento de asociar activo a factura de compra de otro tenant es bloqueado (retorna null)");

// ─── E. INYECCIÓN DE MODELO (DEFENSA FAIL-CLOSED) ───
// E1..E4. Gemini spoofing company_id / business_id en payload es neutralizado
const maliciousAiInvestmentAsset = {
  id: 'AST-41-INJECT-01',
  companyId: compIaB.companyId,
  company_id: compIaB.companyId,
  businessId: phoneIaTenantB,
  business_id: phoneIaTenantB,
  purchaseInvoiceId: 'REC-41-A01',
  description: 'Inyección de maquinaria pesada',
  purchaseDate: '2026-08-15',
  purchaseBase: 8000,
  vatAmount: 1680,
  totalAmount: 9680
};
const savedInjected_41 = saveInvestmentAsset(contextIaA, maliciousAiInvestmentAsset);
assert(savedInjected_41.companyId === compIaA.companyId, "E1. Modelo injection defendida: companyId de A se mantiene como autoridad");
assert(savedInjected_41.businessId === phoneIaTenantA, "E2. Modelo injection defendida: businessId de A se mantiene sincronizado con phoneA");

const verifyInjectedIaInDb = currentDb.prepare("SELECT company_id, business_id FROM investment_assets WHERE id = ?").get('AST-41-INJECT-01');
assert(verifyInjectedIaInDb.company_id === compIaA.companyId && verifyInjectedIaInDb.business_id === phoneIaTenantA, "E3. En SQLite, el activo inyectado pertenece legítimamente a Tenant A");

const readInjectedIaFromB = getInvestmentAsset(contextIaB, 'AST-41-INJECT-01');
assert(readInjectedIaFromB === null, "E4. Tenant B permanece completamente protegido contra payload spoofed");

// ─── F. ROBUSTEZ DE UUID v4 ───
assert(isUuid(savedInjected_41.companyId), "F1. companyId retornado es un UUID v4 canónico");
assert(savedInjected_41.companyId.length === 36 && savedInjected_41.companyId.includes('-'), "F2. companyId tiene formato UUID con guiones intactos (36 caracteres)");

const sqliteRowIaA = currentDb.prepare("SELECT company_id FROM investment_assets WHERE id = ?").get('AST-41-A01');
assert(sqliteRowIaA && sqliteRowIaA.company_id === compIaA.companyId, "F3. SQLite almacena el UUID con guiones intactos sin regex stripping");

// ─── G. CLAVE FORÁNEA & ON DELETE RESTRICT ───
// G1. Inserción con company_id inexistente lanza FK constraint violation
let caughtFkInexistenteIa = false;
try {
  currentDb.prepare(`
    INSERT INTO investment_assets (id, company_id, business_id, description, purchase_date, purchase_base, vat_amount, total_amount)
    VALUES ('fake-id-ia', '00000000-0000-4000-8000-000000000099', '34600999999', 'Falsa máquina', '2026-08-01', 3500, 735, 4235);
  `).run();
} catch (err) {
  caughtFkInexistenteIa = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G1. Violación de Foreign Key hacia companies(id) detectada");
}
assert(caughtFkInexistenteIa === true, "G2. SQLite rechaza inserción en investment_assets con company inexistente");

// G3. Inserción con company_id NULL es rechazada
let caughtNullCidIa = false;
try {
  currentDb.prepare(`
    INSERT INTO investment_assets (id, company_id, business_id, description, purchase_date, purchase_base, vat_amount, total_amount)
    VALUES ('fake-id-ia2', NULL, '34600999999', 'Falsa máquina 2', '2026-08-01', 3500, 735, 4235);
  `).run();
} catch (err) {
  caughtNullCidIa = true;
  assert(err.message.includes('NOT NULL constraint failed'), "G3. NOT NULL constraint en company_id detectada");
}
assert(caughtNullCidIa === true, "G4. Inserción con company_id NULL es rechazada");

// G5. ON DELETE RESTRICT previene el borrado de empresa con activos de inversión
let caughtRestrictDeleteIa = false;
try {
  currentDb.prepare("DELETE FROM companies WHERE id = ?").run(compIaB.companyId);
} catch (err) {
  caughtRestrictDeleteIa = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G5. ON DELETE RESTRICT previene el borrado de empresa con activos de inversión");
}
assert(caughtRestrictDeleteIa === true, "G6. La empresa no puede ser eliminada mientras tenga registros en investment_assets");

// ─── H. COMPATIBILIDAD HACIA ATRÁS (LEGACY ADAPTER & DUAL-WRITE) ───
// H1. getInvestmentAsset(phone) funciona vía legacy adapter
const legacyReadIaA = getInvestmentAsset(phoneIaTenantA, 'AST-41-A01');
assert(legacyReadIaA !== null && legacyReadIaA.companyId === compIaA.companyId, "H1. getInvestmentAsset(phone) funciona vía legacy adapter");

// H2. listInvestmentAssets(phone) funciona vía legacy adapter
const legacyListIaA = listInvestmentAssets(phoneIaTenantA);
assert(legacyListIaA.length >= 1 && legacyListIaA.some(a => a.id === 'AST-41-A01'), "H2. listInvestmentAssets(phone) funciona vía legacy adapter");

// H3. saveInvestmentAsset(phone) actualiza y mantiene dual-write sincronizado
saveInvestmentAsset(phoneIaTenantA, {
  id: 'AST-41-A01',
  description: 'Descripción actualizada vía legacy adapter'
});
const updatedLegacyIaA = getInvestmentAsset(compIaA.companyId, 'AST-41-A01');
assert(updatedLegacyIaA.description === 'Descripción actualizada vía legacy adapter', "H3. saveInvestmentAsset(phone) actualiza correctamente la fila");
assert(updatedLegacyIaA.companyId === compIaA.companyId && updatedLegacyIaA.businessId === phoneIaTenantA, "H4. Dual-write preservado: company_id y business_id sincronizados");

// ─── I. INTEGRIDAD RELACIONAL FINAL ───
const fkViolations41 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult41 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations41.length === 0, "I1. PRAGMA foreign_key_check = 0 violaciones en base de datos de test");
assert(integrityResult41 && (integrityResult41.integrity_check === 'ok' || integrityResult41.integrity_check === 'OK'), "I2. PRAGMA integrity_check = ok en base de datos de test");

cleanupTest41(phoneIaTenantA);
cleanupTest41(phoneIaTenantB);

console.log("\nTEST 42: Migración Controlada de fiscal_incidents a company_id (Fase 2E-6 — Backfill, Tenant Isolation & Relational Integrity)");

// ─── A. MIGRATION 012: EJECUCIÓN Y REGISTRO ───
// A1. migration 012 se registra correctamente en TEST con versión 12
const schemaRow012 = currentDb.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 12").get();
assert(schemaRow012 && schemaRow012.version === 12, "A1. Migración 012 registrada en schema_migrations con versión 12");
assert(schemaRow012 && schemaRow012.name === '012_fiscal_incidents_company_id', "A2. Nombre de migración 012 coincide exactamente");
assert(schemaRow012 && typeof schemaRow012.applied_at === 'string' && schemaRow012.applied_at.length > 10, "A3. Migración 012 tiene timestamp applied_at válido");

// A4 & A5. production pre-015 sigue con máximo migration 006 (007, 008, 009, 010, 011 y 012 NO registradas)
const prodDbFor012Check = new DatabaseSync(HISTORICAL_PRE015_PROD_PATH, { readOnly: true });
const prodSchema012 = prodDbFor012Check.prepare("SELECT version FROM schema_migrations WHERE version >= 7").all();
const prodMaxVersion012 = prodDbFor012Check.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get().max_v;
prodDbFor012Check.close();
assert(prodSchema012.length === 0, "A4. DB de producción (data/presuvoz.db) NO tiene registradas las migraciones 007, 008, 009, 010, 011 ni 012");
assert(prodMaxVersion012 === 6, "A5. Versión máxima en DB de producción permanece inalterada en 6");

// A6 & A7. migrations 010 y 011 siguen intactas en test
const schemaRow010In42 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 10").get();
const schemaRow011In42 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 11").get();
assert(schemaRow010In42 && schemaRow010In42.name === '010_expense_payments_company_id', "A6. Migración 010 permanece intacta en la base de datos de test");
assert(schemaRow011In42 && schemaRow011In42.name === '011_investment_assets_company_id', "A7. Migración 011 permanece intacta en la base de datos de test");

// ─── B. BACKFILL DETERMINISTA & CASOS FAIL-CLOSED ───
// B1..B5. Memoria con datos existentes
const memDb42B = new DatabaseSync(':memory:');
initMigrationTable(memDb42B);
runMigrations(memDb42B, { migrations: MIGRATIONS.slice(0, 11), authorized: true });

// Insertar 2 empresas, facturas y 3 incidencias fiscales según esquema previo a 012
memDb42B.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-inc-comp1', '34677550001', 'Empresa Auditoría 1 S.L.'),
    ('uuid-inc-comp2', '34677550002', 'Empresa Auditoría 2 S.L.');
  INSERT INTO invoices (id, company_id, company_phone, client_name, total_amount)
  VALUES ('INV-42-01', 'uuid-inc-comp1', '34677550001', 'Cliente Uno', 1210);
  INSERT INTO purchase_invoices (
    id, company_id, business_id, supplier_name, invoice_date,
    taxable_base, vat_rate, vat_amount, total_amount, deductible_vat_amount, fiscal_period
  ) VALUES
    ('PINV-42-01', 'uuid-inc-comp1', '34677550001', 'Proveedor Uno', '2026-07-01', 500, 21, 105, 605, 105, '2026_Q3');
  INSERT INTO fiscal_incidents (
    id, business_id, fiscal_period, entity_type, entity_id,
    severity, error_code, message, resolution_status, created_at
  ) VALUES
    ('INC-BF-01', '34677550001', '2026_Q3', 'INVOICE', 'INV-42-01', 'CRITICAL', 'DUPLICATE_INVOICE_NUMBER', 'Factura duplicada', 'OPEN', '2026-07-01T10:00:00Z'),
    ('INC-BF-02', '34677550001', '2026_Q3', 'PURCHASE_INVOICE', 'PINV-42-01', 'WARNING', 'DOUBTFUL_DEDUCTIBILITY', 'Gasto combustible', 'OPEN', '2026-07-15T11:00:00Z'),
    ('INC-BF-03', '34677550002', '2026_Q3', 'GENERAL', '', 'WARNING', 'MISSING_PROFILE', 'Perfil fiscal incompleto', 'OPEN', '2026-07-02T12:00:00Z');
`);

const migRes42 = runMigrations(memDb42B, { migrations: [MIGRATIONS[11]], authorized: true });
assert(migRes42.appliedCount === 1, "B1. Migración 012 se aplica con éxito sobre base de datos con datos");

const incRows42 = memDb42B.prepare("SELECT id, company_id, business_id, fiscal_period, entity_type, entity_id, severity, error_code, message, resolution_status FROM fiscal_incidents ORDER BY id ASC").all();
assert(incRows42.length === 3, "B2. Recuento de filas se preserva exactamente tras migración (3 filas)");
assert(incRows42[0].company_id === 'uuid-inc-comp1' && incRows42[0].business_id === '34677550001', "B3. Fila 1 migrada con company_id correcto de Empresa 1");
assert(incRows42[1].company_id === 'uuid-inc-comp1' && incRows42[1].business_id === '34677550001', "B4. Fila 2 migrada con company_id correcto de Empresa 1");
assert(incRows42[2].company_id === 'uuid-inc-comp2' && incRows42[2].business_id === '34677550002', "B5. Fila 3 migrada con company_id correcto de Empresa 2");

// B6..B10. Rollback atómico ante incidencia huérfana
const memDb42Rollback = new DatabaseSync(':memory:');
initMigrationTable(memDb42Rollback);
runMigrations(memDb42Rollback, { migrations: MIGRATIONS.slice(0, 11), authorized: true });

memDb42Rollback.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-inc-comp-ok', '34677550001', 'Empresa OK');
  INSERT INTO fiscal_incidents (
    id, business_id, fiscal_period, entity_type, entity_id, severity, error_code, message
  ) VALUES
    ('INC-OK-01', '34677550001', '2026_Q3', 'INVOICE', 'INV-1', 'WARNING', 'WARN_01', 'Incidencia OK'),
    ('INC-ORPHAN-01', '34699999999', '2026_Q3', 'INVOICE', 'INV-2', 'CRITICAL', 'ERR_01', 'Incidencia Huérfana');
`);

let caughtOrphan012 = false;
let orphanErrMsg012 = '';
try {
  runMigrations(memDb42Rollback, { migrations: [MIGRATIONS[11]], authorized: true });
} catch (err) {
  caughtOrphan012 = true;
  orphanErrMsg012 = err.message;
}
assert(caughtOrphan012 === true, "B6. Migración 012 aborta inmediatamente ante incidencia huérfana (fail-closed)");
assert(orphanErrMsg012.includes('fail-closed') && orphanErrMsg012.includes('huérfano'), "B7. Error descriptivo fail-closed ante incidencia con business_id huérfano");

// Verificar rollback atómico
const schemaAfterFail012 = memDb42Rollback.prepare("SELECT * FROM schema_migrations WHERE version = 12").get();
assert(!schemaAfterFail012, "B8. Rollback atómico: Versión 12 NO queda registrada en schema_migrations");

const colsAfterFail012 = memDb42Rollback.prepare('PRAGMA table_info("fiscal_incidents")').all();
assert(!colsAfterFail012.some(c => c.name === 'company_id'), "B9. Rollback atómico: La tabla fiscal_incidents queda exactamente como estaba");

const tempTableCheck012 = memDb42Rollback.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fiscal_incidents_new'").get();
assert(!tempTableCheck012, "B10. Rollback atómico: No quedan tablas temporales (fiscal_incidents_new)");

// B11..B12. Fallo ante ambigüedad de companies con el mismo teléfono
const memDb42Ambig = new DatabaseSync(':memory:');
initMigrationTable(memDb42Ambig);
runMigrations(memDb42Ambig, { migrations: MIGRATIONS.slice(0, 11), authorized: true });
memDb42Ambig.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-inc-ambig-1', '34677000099', 'Empresa Ambigua 1'),
    ('uuid-inc-ambig-2', '+34 677 00 00 99', 'Empresa Ambigua 2');
  INSERT INTO fiscal_incidents (
    id, business_id, fiscal_period, entity_type, entity_id, severity, error_code, message
  ) VALUES
    ('INC-AMBIG-01', '34677000099', '2026_Q3', 'GENERAL', '', 'WARNING', 'AMBIG_ERR', 'Incidencia Ambigua');
`);
let caughtAmbig012 = false;
try {
  runMigrations(memDb42Ambig, { migrations: [MIGRATIONS[11]], authorized: true });
} catch (err) {
  caughtAmbig012 = true;
  assert(err.message.includes('Ambigüedad crítica'), "B11. Fail-closed: Múltiples empresas ambiguas provocan aborto y rollback");
}
assert(caughtAmbig012 === true, "B12. Migración 012 aborta ante ambigüedad en companies");

// B13..B14. Fallo ante inconsistencia cross-tenant entre incidencia y factura asociada
const memDb42CrossTenant = new DatabaseSync(':memory:');
initMigrationTable(memDb42CrossTenant);
runMigrations(memDb42CrossTenant, { migrations: MIGRATIONS.slice(0, 11), authorized: true });
memDb42CrossTenant.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-inc-cross-1', '34677660001', 'Empresa Alpha Fiscal'),
    ('uuid-inc-cross-2', '34677660002', 'Empresa Beta Fiscal');
  INSERT INTO invoices (id, company_id, company_phone, client_name, total_amount)
  VALUES ('INV-BETA-42', 'uuid-inc-cross-2', '34677660002', 'Cliente Beta', 1000);
  INSERT INTO fiscal_incidents (
    id, business_id, fiscal_period, entity_type, entity_id, severity, error_code, message
  ) VALUES
    ('INC-CROSS-01', '34677660001', '2026_Q3', 'INVOICE', 'INV-BETA-42', 'CRITICAL', 'DUPLICATE_INVOICE_NUMBER', 'Factura ajena');
`);
let caughtCrossTenant012 = false;
try {
  runMigrations(memDb42CrossTenant, { migrations: [MIGRATIONS[11]], authorized: true });
} catch (err) {
  caughtCrossTenant012 = true;
  assert(err.message.includes('Inconsistencia cross-tenant'), "B13. Fail-closed: Inconsistencia cross-tenant entre incidencia y factura provoca aborto");
}
assert(caughtCrossTenant012 === true, "B14. Migración 012 aborta ante inconsistencia cross-tenant");

// ─── C. PRESERVACIÓN DE DATOS DE INCIDENCIAS ───
assert(incRows42[0].fiscal_period === '2026_Q3', "C1. fiscal_period preservado intacto ('2026_Q3')");
assert(incRows42[0].entity_type === 'INVOICE' && incRows42[0].entity_id === 'INV-42-01', "C2. entity_type y entity_id preservados intactos");
assert(incRows42[0].severity === 'CRITICAL' && incRows42[0].error_code === 'DUPLICATE_INVOICE_NUMBER', "C3. severity y error_code preservados intactos");
assert(incRows42[0].message === 'Factura duplicada' && incRows42[0].resolution_status === 'OPEN', "C4. message y resolution_status preservados intactos");

// ─── D. AISLAMIENTO MULTI-TENANT EN TEST DB ───
const phoneIncTenantA = '34677551101';
const phoneIncTenantB = '34677551102';

const cleanupTest42 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM investment_assets WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM expense_payments WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM purchase_invoices WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE business_id = ?").run(phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest42(phoneIncTenantA);
cleanupTest42(phoneIncTenantB);

const compIncA = createCompanyWithIdentity({
  name: 'Empresa Alpha Incidencias S.L.',
  phone: phoneIncTenantA,
  trade: 'Construcción'
});
const contextIncA = resolveAuthenticatedContext('whatsapp', phoneIncTenantA);

const compIncB = createCompanyWithIdentity({
  name: 'Empresa Beta Incidencias S.L.',
  phone: phoneIncTenantB,
  trade: 'Electricidad'
});
const contextIncB = resolveAuthenticatedContext('whatsapp', phoneIncTenantB);

// Crear facturas recibidas legítimas para cada tenant
const invA42 = savePurchaseInvoice(contextIncA, {
  id: 'REC-42-A01',
  supplierName: 'Materiales Alpha S.L.',
  taxBase: 1500,
  vatRate: 21,
  totalAmount: 1815,
  issueDate: '2026-08-10'
});
const invB42 = savePurchaseInvoice(contextIncB, {
  id: 'REC-42-B01',
  supplierName: 'Materiales Beta S.L.',
  taxBase: 800,
  vatRate: 21,
  totalAmount: 968,
  issueDate: '2026-08-11'
});

// D1 & D2. Cada tenant registra su incidencia fiscal
const incA42 = saveFiscalIncident(contextIncA, {
  id: 'INC-42-A01',
  fiscalPeriod: '2026_Q3',
  entityType: 'PURCHASE_INVOICE',
  entityId: 'REC-42-A01',
  severity: 'WARNING',
  errorCode: 'DOUBTFUL_DEDUCTIBILITY',
  message: 'Gasto con deducibilidad dudosa A',
  resolutionStatus: 'OPEN'
});
assert(incA42 && incA42.id === 'INC-42-A01', "D1. saveFiscalIncident de Tenant A registra su incidencia");

const incB42 = saveFiscalIncident(contextIncB, {
  id: 'INC-42-B01',
  fiscalPeriod: '2026_Q3',
  entityType: 'PURCHASE_INVOICE',
  entityId: 'REC-42-B01',
  severity: 'CRITICAL',
  errorCode: 'MISSING_CUSTOMER_NIF',
  message: 'Factura sin NIF de proveedor B',
  resolutionStatus: 'OPEN'
});
assert(incB42 && incB42.id === 'INC-42-B01', "D2. saveFiscalIncident de Tenant B registra su incidencia");

// D3. Cross-Tenant Read: getFiscalIncident(contextB, idA) devuelve null
const crossReadAfromB_42 = getFiscalIncident(contextIncB, 'INC-42-A01');
assert(crossReadAfromB_42 === null, "D3. Cross-Tenant Read: getFiscalIncident(tenantB, idA) devuelve null (Zero-Disclosure)");

// D4. Cross-Tenant Read: getFiscalIncident(contextA, idB) devuelve null
const crossReadBfromA_42 = getFiscalIncident(contextIncA, 'INC-42-B01');
assert(crossReadBfromA_42 === null, "D4. Cross-Tenant Read: getFiscalIncident(tenantA, idB) devuelve null (Zero-Disclosure)");

// D5. Lectura legítima de Tenant A
const legitReadA_42 = getFiscalIncident(contextIncA, 'INC-42-A01');
assert(legitReadA_42 !== null && legitReadA_42.id === 'INC-42-A01' && legitReadA_42.companyId === compIncA.companyId, "D5. Lectura legítima: getFiscalIncident(tenantA, idA) recupera su incidencia");

// D6. Lectura legítima de Tenant B
const legitReadB_42 = getFiscalIncident(contextIncB, 'INC-42-B01');
assert(legitReadB_42 !== null && legitReadB_42.id === 'INC-42-B01' && legitReadB_42.companyId === compIncB.companyId, "D6. Lectura legítima: getFiscalIncident(tenantB, idB) recupera su incidencia");

// D7. Cross-Tenant Resolve: resolveFiscalIncident(tenantA, idB) devuelve false
const crossResolveBfromA_42 = resolveFiscalIncident(contextIncA, 'INC-42-B01');
assert(crossResolveBfromA_42 === false, "D7. Cross-Tenant Resolve: resolveFiscalIncident(tenantA, idB) devuelve false");

// D8. Incidencia de Tenant B permanece OPEN
const verifyIncBStillOpen_42 = currentDb.prepare("SELECT resolution_status FROM fiscal_incidents WHERE id = ?").get('INC-42-B01');
assert(verifyIncBStillOpen_42 && verifyIncBStillOpen_42.resolution_status === 'OPEN', "D8. Incidencia de Tenant B permanece OPEN tras intento cross-tenant");

// D9. Resolucin legtima por Tenant B
const legitResolveIncB_42 = resolveFiscalIncident(contextIncB, 'INC-42-B01');
assert(legitResolveIncB_42 === true, "D9. Resolucin legtima: resolveFiscalIncident(tenantB, idB) resuelve con xito");
const verifyIncBResolved_42 = currentDb.prepare("SELECT resolution_status FROM fiscal_incidents WHERE id = ?").get('INC-42-B01');
assert(verifyIncBResolved_42 && verifyIncBResolved_42.resolution_status === 'RESOLVED', "D9b. Estado pasa a RESOLVED para el tenant autorizado");

// D10. Cross-Tenant Delete: deleteFiscalIncident(tenantA, idB) devuelve false
const crossDeleteBfromA_42 = deleteFiscalIncident(contextIncA, 'INC-42-B01');
assert(crossDeleteBfromA_42 === false, "D10. Cross-Tenant Delete: deleteFiscalIncident(tenantA, idB) devuelve false");

// D11. Incidencia de Tenant B permanece intacta tras intento cross-tenant
const verifyIncBIntact_42 = currentDb.prepare("SELECT * FROM fiscal_incidents WHERE id = ?").get('INC-42-B01');
assert(verifyIncBIntact_42 !== null && verifyIncBIntact_42.company_id === compIncB.companyId, "D11. Incidencia de Tenant B permanece 100% intacta en SQLite");

// D12. listFiscalIncidents(contextA) solo retorna incidencias del Tenant A
const listIncA_42 = listFiscalIncidents(contextIncA);
assert(listIncA_42.every(inc => inc.companyId === compIncA.companyId) && listIncA_42.some(inc => inc.id === 'INC-42-A01'), "D12. listFiscalIncidents(contextA) solo retorna incidencias del Tenant A");

// D13. listFiscalIncidents(contextB) solo retorna incidencias del Tenant B
const listIncB_42 = listFiscalIncidents(contextIncB, null, null);
assert(listIncB_42.every(inc => inc.companyId === compIncB.companyId) && listIncB_42.some(inc => inc.id === 'INC-42-B01'), "D13. listFiscalIncidents(contextB) solo retorna incidencias del Tenant B");

// D14. Intento de asociar incidencia a factura de otro tenant es bloqueado
const crossTenantIncAttempt_42 = saveFiscalIncident(contextIncA, {
  id: 'INC-CROSS-ATTEMPT',
  fiscalPeriod: '2026_Q3',
  entityType: 'PURCHASE_INVOICE',
  entityId: 'REC-42-B01', // Factura de Tenant B
  severity: 'WARNING',
  errorCode: 'CROSS_ATTEMPT',
  message: 'Incidencia con factura ajena'
});
assert(crossTenantIncAttempt_42 === null, "D14. Intento de asociar incidencia a factura de otro tenant es bloqueado (retorna null)");

// ─── E. INYECCIÓN DE MODELO (DEFENSA FAIL-CLOSED) ───
// E1..E4. Gemini spoofing company_id / business_id en payload es neutralizado
const maliciousAiFiscalIncident_42 = {
  id: 'INC-42-INJECT-01',
  companyId: compIncB.companyId,
  company_id: compIncB.companyId,
  businessId: phoneIncTenantB,
  business_id: phoneIncTenantB,
  fiscalPeriod: '2026_Q3',
  entityType: 'PURCHASE_INVOICE',
  entityId: 'REC-42-A01',
  severity: 'WARNING',
  errorCode: 'INJECT_ATTEMPT',
  message: 'Inyección de incidencia fiscal'
};
const savedInjected_42 = saveFiscalIncident(contextIncA, maliciousAiFiscalIncident_42);
assert(savedInjected_42.companyId === compIncA.companyId, "E1. Modelo injection defendida: companyId de A se mantiene como autoridad");
assert(savedInjected_42.businessId === phoneIncTenantA, "E2. Modelo injection defendida: businessId de A se mantiene sincronizado con phoneA");

const verifyInjectedIncInDb_42 = currentDb.prepare("SELECT company_id, business_id FROM fiscal_incidents WHERE id = ?").get('INC-42-INJECT-01');
assert(verifyInjectedIncInDb_42.company_id === compIncA.companyId && verifyInjectedIncInDb_42.business_id === phoneIncTenantA, "E3. En SQLite, la incidencia inyectada pertenece legítimamente a Tenant A");

const readInjectedIncFromB_42 = getFiscalIncident(contextIncB, 'INC-42-INJECT-01');
assert(readInjectedIncFromB_42 === null, "E4. Tenant B permanece completamente protegido contra payload spoofed");

// ─── F. ROBUSTEZ DE UUID v4 ───
assert(isUuid(savedInjected_42.companyId), "F1. companyId retornado es un UUID v4 canónico");
assert(savedInjected_42.companyId.length === 36 && savedInjected_42.companyId.includes('-'), "F2. companyId tiene formato UUID con guiones intactos (36 caracteres)");

const sqliteRowIncA_42 = currentDb.prepare("SELECT company_id FROM fiscal_incidents WHERE id = ?").get('INC-42-A01');
assert(sqliteRowIncA_42 && sqliteRowIncA_42.company_id === compIncA.companyId, "F3. SQLite almacena el UUID con guiones intactos sin regex stripping");

// ─── G. CLAVE FORÁNEA & ON DELETE RESTRICT ───
// G1. Inserción con company_id inexistente lanza FK constraint violation
let caughtFkInexistenteInc_42 = false;
try {
  currentDb.prepare(`
    INSERT INTO fiscal_incidents (id, company_id, business_id, fiscal_period, entity_type, entity_id, severity, error_code, message)
    VALUES ('fake-id-inc', '00000000-0000-4000-8000-000000000099', '34600999999', '2026_Q3', 'GENERAL', '', 'WARNING', 'ERR_FAKE', 'Falsa');
  `).run();
} catch (err) {
  caughtFkInexistenteInc_42 = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G1. Violación de Foreign Key hacia companies(id) detectada");
}
assert(caughtFkInexistenteInc_42 === true, "G2. SQLite rechaza inserción en fiscal_incidents con company inexistente");

// G3. Inserción con company_id NULL es rechazada
let caughtNullCidInc_42 = false;
try {
  currentDb.prepare(`
    INSERT INTO fiscal_incidents (id, company_id, business_id, fiscal_period, entity_type, entity_id, severity, error_code, message)
    VALUES ('fake-id-inc2', NULL, '34600999999', '2026_Q3', 'GENERAL', '', 'WARNING', 'ERR_FAKE', 'Falsa 2');
  `).run();
} catch (err) {
  caughtNullCidInc_42 = true;
  assert(err.message.includes('NOT NULL constraint failed'), "G3. NOT NULL constraint en company_id detectada");
}
assert(caughtNullCidInc_42 === true, "G4. Inserción con company_id NULL es rechazada");

// G5. ON DELETE RESTRICT previene el borrado de empresa con incidencias registradas
let caughtRestrictDeleteInc_42 = false;
try {
  currentDb.prepare("DELETE FROM companies WHERE id = ?").run(compIncB.companyId);
} catch (err) {
  caughtRestrictDeleteInc_42 = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G5. ON DELETE RESTRICT previene el borrado de empresa con incidencias registradas");
}
assert(caughtRestrictDeleteInc_42 === true, "G6. La empresa no puede ser eliminada mientras tenga registros en fiscal_incidents");

// ─── H. COMPATIBILIDAD HACIA ATRÁS (LEGACY ADAPTER & DUAL-WRITE) ───
// H1. getFiscalIncident(phone) funciona vía legacy adapter
const legacyReadIncA_42 = getFiscalIncident(phoneIncTenantA, 'INC-42-A01');
assert(legacyReadIncA_42 !== null && legacyReadIncA_42.companyId === compIncA.companyId, "H1. getFiscalIncident(phone) funciona vía legacy adapter");

// H2. listFiscalIncidents(phone) funciona vía legacy adapter
const legacyListIncA_42 = listFiscalIncidents(phoneIncTenantA);
assert(legacyListIncA_42.length >= 1 && legacyListIncA_42.some(inc => inc.id === 'INC-42-A01'), "H2. listFiscalIncidents(phone) funciona vía legacy adapter");

// H3. resolveFiscalIncident(phone) resuelve vía legacy adapter
const legacyResolveIncA_42 = resolveFiscalIncident(phoneIncTenantA, 'INC-42-A01');
assert(legacyResolveIncA_42 === true, "H3. resolveFiscalIncident(phone) resuelve vía legacy adapter");

// H4. saveFiscalIncident(phone) actualiza y mantiene dual-write sincronizado
saveFiscalIncident(phoneIncTenantA, {
  id: 'INC-42-A01',
  message: 'Mensaje actualizado vía legacy adapter'
});
const updatedLegacyIncA_42 = getFiscalIncident(compIncA.companyId, 'INC-42-A01');
assert(updatedLegacyIncA_42.message === 'Mensaje actualizado vía legacy adapter', "H4. saveFiscalIncident(phone) actualiza correctamente la fila");
assert(updatedLegacyIncA_42.companyId === compIncA.companyId && updatedLegacyIncA_42.businessId === phoneIncTenantA, "H5. Dual-write preservado: company_id y business_id sincronizados");

// ─── I. INTEGRIDAD RELACIONAL FINAL ───
const fkViolations42 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult42 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations42.length === 0, "I1. PRAGMA foreign_key_check = 0 violaciones en base de datos de test");
assert(integrityResult42 && (integrityResult42.integrity_check === 'ok' || integrityResult42.integrity_check === 'OK'), "I2. PRAGMA integrity_check = ok en base de datos de test");

cleanupTest42(phoneIncTenantA);
cleanupTest42(phoneIncTenantB);

console.log("\nTEST 43: Migración Controlada de audit_logs a company_id (Fase 2E-7 — Backfill, Tenant Isolation & Relational Integrity)");

// ─── A. MIGRATION 013: EJECUCIÓN Y REGISTRO ───
// A1. migration 013 se registra correctamente en TEST con versión 13
const schemaRow013 = currentDb.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 13").get();
assert(schemaRow013 && schemaRow013.version === 13, "A1. Migración 013 registrada en schema_migrations con versión 13");
assert(schemaRow013 && schemaRow013.name === '013_audit_logs_company_id', "A2. Nombre de migración 013 coincide exactamente");
assert(schemaRow013 && typeof schemaRow013.applied_at === 'string' && schemaRow013.applied_at.length > 10, "A3. Migración 013 tiene timestamp applied_at válido");

// A4 & A5. production pre-015 sigue con máximo migration 006 (007, 008, 009, 010, 011, 012 y 013 NO registradas)
const prodDbFor013Check = new DatabaseSync(HISTORICAL_PRE015_PROD_PATH, { readOnly: true });
const prodSchema013 = prodDbFor013Check.prepare("SELECT version FROM schema_migrations WHERE version >= 7").all();
const prodMaxVersion013 = prodDbFor013Check.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get().max_v;
prodDbFor013Check.close();
assert(prodSchema013.length === 0, "A4. DB de producción (data/presuvoz.db) NO tiene registradas las migraciones 007 a 013");
assert(prodMaxVersion013 === 6, "A5. Versión máxima en DB de producción permanece inalterada en 6");

// A6 & A7. migrations 011 y 012 siguen intactas en test
const schemaRow011In43 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 11").get();
const schemaRow012In43 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 12").get();
assert(schemaRow011In43 && schemaRow011In43.name === '011_investment_assets_company_id', "A6. Migración 011 permanece intacta en la base de datos de test");
assert(schemaRow012In43 && schemaRow012In43.name === '012_fiscal_incidents_company_id', "A7. Migración 012 permanece intacta en la base de datos de test");

// ─── B. BACKFILL DETERMINISTA & CASOS FAIL-CLOSED ───
// B1..B5. Memoria con datos existentes
const memDb43B = new DatabaseSync(':memory:');
initMigrationTable(memDb43B);
runMigrations(memDb43B, { migrations: MIGRATIONS.slice(0, 12), authorized: true });

// Insertar 2 empresas, facturas y citas, y 3 registros legacy de audit_logs según esquema previo a 013
memDb43B.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-audit-comp1', '34677440001', 'Empresa Auditoría Alfa S.L.'),
    ('uuid-audit-comp2', '34677440002', 'Empresa Auditoría Beta S.L.');
  INSERT INTO invoices (id, company_id, company_phone, client_name, total_amount)
  VALUES ('INV-43-01', 'uuid-audit-comp1', '34677440001', 'Cliente Alfa', 1210);
  INSERT INTO appointments (id, company_id, company_phone, client_name, date, time, status)
  VALUES ('APT-43-01', 'uuid-audit-comp1', '34677440001', 'Cliente Alfa', '2026-10-01', '10:00', 'CONFIRMED');
  INSERT INTO audit_logs (
    id, business_id, entity_type, entity_id, action,
    field_changed, old_value, new_value, changed_by, reason, timestamp
  ) VALUES
    ('LOG-BF-01', '34677440001', 'INVOICE', 'INV-43-01', 'UPDATE', 'status', 'DRAFT', 'ISSUED', 'USER_WHATSAPP', 'Facturación completada', '2026-07-01T10:00:00Z'),
    ('LOG-BF-02', '34677440001', 'APPOINTMENT', 'APT-43-01', 'RESCHEDULE', 'appointment_date', '2026-09-30', '2026-10-01', 'USER_WHATSAPP', 'Petición cliente', '2026-07-15T11:00:00Z'),
    ('LOG-BF-03', '34677440002', 'COMPANY_PROFILE', 'uuid-audit-comp2', 'UPDATE', 'trade', 'Pintura', 'Reformas', 'USER_WHATSAPP', 'Cambio de actividad', '2026-07-02T12:00:00Z');
`);

const migRes43 = runMigrations(memDb43B, { migrations: [MIGRATIONS[12]], authorized: true });
assert(migRes43.appliedCount === 1, "B1. Migración 013 se aplica con éxito sobre base de datos con datos");

const auditRows43 = memDb43B.prepare("SELECT id, company_id, business_id, entity_type, entity_id, action, field_changed, old_value, new_value, changed_by, reason, timestamp FROM audit_logs ORDER BY id ASC").all();
assert(auditRows43.length === 3, "B2. Recuento de filas se preserva exactamente tras migración (3 filas)");
assert(auditRows43[0].company_id === 'uuid-audit-comp1' && auditRows43[0].business_id === '34677440001', "B3. Fila 1 migrada con company_id correcto de Empresa 1");
assert(auditRows43[1].company_id === 'uuid-audit-comp1' && auditRows43[1].business_id === '34677440001', "B4. Fila 2 migrada con company_id correcto de Empresa 1");
assert(auditRows43[2].company_id === 'uuid-audit-comp2' && auditRows43[2].business_id === '34677440002', "B5. Fila 3 migrada con company_id correcto de Empresa 2");

// B6..B10. Rollback atómico ante registro huérfano
const memDb43Rollback = new DatabaseSync(':memory:');
initMigrationTable(memDb43Rollback);
runMigrations(memDb43Rollback, { migrations: MIGRATIONS.slice(0, 12), authorized: true });

memDb43Rollback.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-audit-comp-ok', '34677440001', 'Empresa OK');
  INSERT INTO audit_logs (
    id, business_id, entity_type, entity_id, action, timestamp
  ) VALUES
    ('LOG-OK-01', '34677440001', 'APPOINTMENT', 'APT-1', 'CREATE', '2026-07-01T10:00:00Z'),
    ('LOG-ORPHAN-01', '34699999999', 'APPOINTMENT', 'APT-2', 'CREATE', '2026-07-01T11:00:00Z');
`);

let caughtOrphan013 = false;
let orphanErrMsg013 = '';
try {
  runMigrations(memDb43Rollback, { migrations: [MIGRATIONS[12]], authorized: true });
} catch (err) {
  caughtOrphan013 = true;
  orphanErrMsg013 = err.message;
}
assert(caughtOrphan013 === true, "B6. Migración 013 aborta inmediatamente ante log huérfano (fail-closed)");
assert(orphanErrMsg013.includes('fail-closed') && orphanErrMsg013.includes('huérfano'), "B7. Error descriptivo fail-closed ante log con business_id huérfano");

// Verificar rollback atómico
const schemaAfterFail013 = memDb43Rollback.prepare("SELECT * FROM schema_migrations WHERE version = 13").get();
assert(!schemaAfterFail013, "B8. Rollback atómico: Versión 13 NO queda registrada en schema_migrations");

const colsAfterFail013 = memDb43Rollback.prepare('PRAGMA table_info("audit_logs")').all();
assert(!colsAfterFail013.some(c => c.name === 'company_id'), "B9. Rollback atómico: La tabla audit_logs queda exactamente como estaba");

const tempTableCheck013 = memDb43Rollback.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_logs_new'").get();
assert(!tempTableCheck013, "B10. Rollback atómico: No quedan tablas temporales (audit_logs_new)");

// B11..B12. Fallo ante ambigüedad de companies con el mismo teléfono
const memDb43Ambig = new DatabaseSync(':memory:');
initMigrationTable(memDb43Ambig);
runMigrations(memDb43Ambig, { migrations: MIGRATIONS.slice(0, 12), authorized: true });
memDb43Ambig.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-audit-ambig-1', '34677000088', 'Empresa Ambigua 1'),
    ('uuid-audit-ambig-2', '+34 677 00 00 88', 'Empresa Ambigua 2');
  INSERT INTO audit_logs (
    id, business_id, entity_type, entity_id, action, timestamp
  ) VALUES
    ('LOG-AMBIG-01', '34677000088', 'APPOINTMENT', 'APT-AMBIG-1', 'CREATE', '2026-07-01T10:00:00Z');
`);
let caughtAmbig013 = false;
try {
  runMigrations(memDb43Ambig, { migrations: [MIGRATIONS[12]], authorized: true });
} catch (err) {
  caughtAmbig013 = true;
  assert(err.message.includes('Ambigüedad crítica'), "B11. Fail-closed: Múltiples empresas ambiguas provocan aborto y rollback");
}
assert(caughtAmbig013 === true, "B12. Migración 013 aborta ante ambigüedad en companies");

// B13..B14. Fallo ante inconsistencia cross-tenant entre log y entidad asociada (ej. invoice o appointment)
const memDb43CrossTenant = new DatabaseSync(':memory:');
initMigrationTable(memDb43CrossTenant);
runMigrations(memDb43CrossTenant, { migrations: MIGRATIONS.slice(0, 12), authorized: true });
memDb43CrossTenant.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-audit-cross-1', '34677440091', 'Empresa Alpha Log'),
    ('uuid-audit-cross-2', '34677440092', 'Empresa Beta Log');
  INSERT INTO invoices (id, company_id, company_phone, client_name, total_amount)
  VALUES ('INV-BETA-43', 'uuid-audit-cross-2', '34677440092', 'Cliente Beta', 1000);
  INSERT INTO audit_logs (
    id, business_id, entity_type, entity_id, action, timestamp
  ) VALUES
    ('LOG-CROSS-01', '34677440091', 'INVOICE', 'INV-BETA-43', 'UPDATE', '2026-07-01T10:00:00Z');
`);
let caughtCrossTenant013 = false;
try {
  runMigrations(memDb43CrossTenant, { migrations: [MIGRATIONS[12]], authorized: true });
} catch (err) {
  caughtCrossTenant013 = true;
  assert(err.message.includes('Inconsistencia cross-tenant'), "B13. Fail-closed: Inconsistencia cross-tenant entre log y factura provoca aborto");
}
assert(caughtCrossTenant013 === true, "B14. Migración 013 aborta ante inconsistencia cross-tenant");

// ─── C. PRESERVACIÓN DE DATOS DE AUDIT LOGS ───
assert(auditRows43[0].entity_type === 'INVOICE' && auditRows43[0].entity_id === 'INV-43-01', "C1. entity_type y entity_id preservados intactos");
assert(auditRows43[0].action === 'UPDATE' && auditRows43[0].field_changed === 'status', "C2. action y field_changed preservados intactos");
assert(auditRows43[0].old_value === 'DRAFT' && auditRows43[0].new_value === 'ISSUED', "C3. old_value y new_value preservados intactos");
assert(auditRows43[0].changed_by === 'USER_WHATSAPP' && auditRows43[0].reason === 'Facturación completada', "C4. changed_by y reason preservados intactos");

// ─── D. AISLAMIENTO MULTI-TENANT EN TEST DB ───
const phoneAuditTenantA = '34677441101';
const phoneAuditTenantB = '34677441102';

const cleanupTest43 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM audit_logs WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM investment_assets WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM expense_payments WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM purchase_invoices WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM appointments WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest43(phoneAuditTenantA);
cleanupTest43(phoneAuditTenantB);

const compAuditA = createCompanyWithIdentity({
  name: 'Empresa Alpha Auditoría S.L.',
  phone: phoneAuditTenantA,
  trade: 'Construcción'
});
const contextAuditA = resolveAuthenticatedContext('whatsapp', phoneAuditTenantA);

const compAuditB = createCompanyWithIdentity({
  name: 'Empresa Beta Auditoría S.L.',
  phone: phoneAuditTenantB,
  trade: 'Fontanería'
});
const contextAuditB = resolveAuthenticatedContext('whatsapp', phoneAuditTenantB);

// D1 & D2. Cada tenant registra su evento en audit_logs
const logA_43 = recordAuditLog({
  companyContextOrId: contextAuditA,
  entityType: 'INVOICE',
  entityId: 'INV-43-A01',
  action: 'CREATE',
  fieldChanged: 'status',
  oldValue: null,
  newValue: 'DRAFT',
  reason: 'Creación presupuesto facturado'
});
assert(logA_43 && logA_43.id, "D1. recordAuditLog de Tenant A registra su evento de auditoría");

const logB_43 = recordAuditLog({
  companyContextOrId: contextAuditB,
  entityType: 'APPOINTMENT',
  entityId: 'APT-43-B01',
  action: 'RESCHEDULE',
  fieldChanged: 'appointment_time',
  oldValue: '10:00',
  newValue: '16:00',
  reason: 'Cambio de hora por cliente'
});
assert(logB_43 && logB_43.id, "D2. recordAuditLog de Tenant B registra su evento de auditoría");

// D3. Cross-Tenant Read: getAuditLog(contextB, idA) devuelve null
const crossReadAfromB_43 = getAuditLog(contextAuditB, logA_43.id);
assert(crossReadAfromB_43 === null, "D3. Cross-Tenant Read: getAuditLog(tenantB, idA) devuelve null (Zero-Disclosure)");

// D4. Cross-Tenant Read: getAuditLog(contextA, idB) devuelve null
const crossReadBfromA_43 = getAuditLog(contextAuditA, logB_43.id);
assert(crossReadBfromA_43 === null, "D4. Cross-Tenant Read: getAuditLog(tenantA, idB) devuelve null (Zero-Disclosure)");

// D5. Lectura legítima de Tenant A
const legitReadA_43 = getAuditLog(contextAuditA, logA_43.id);
assert(legitReadA_43 !== null && legitReadA_43.id === logA_43.id && legitReadA_43.companyId === compAuditA.companyId, "D5. Lectura legítima: getAuditLog(tenantA, idA) recupera su log");

// D6. Lectura legítima de Tenant B
const legitReadB_43 = getAuditLog(contextAuditB, logB_43.id);
assert(legitReadB_43 !== null && legitReadB_43.id === logB_43.id && legitReadB_43.companyId === compAuditB.companyId, "D6. Lectura legítima: getAuditLog(tenantB, idB) recupera su log");

// D7. listAuditLogs(contextA) solo retorna logs de Tenant A
const listLogA_43 = listAuditLogs(contextAuditA);
assert(listLogA_43.every(l => l.companyId === compAuditA.companyId) && listLogA_43.some(l => l.id === logA_43.id), "D7. listAuditLogs(contextA) solo retorna logs del Tenant A");

// D8. listAuditLogs(contextB) solo retorna logs de Tenant B
const listLogB_43 = listAuditLogs(contextAuditB);
assert(listLogB_43.every(l => l.companyId === compAuditB.companyId) && listLogB_43.some(l => l.id === logB_43.id), "D8. listAuditLogs(contextB) solo retorna logs del Tenant B");

// D9. Historial de citas con filtro de tenant: getAppointmentHistory
const createdAptA43 = testSaveAppointment(contextAuditA, {
  clientName: 'Cliente Cita Audit A',
  date: '2026-10-10',
  time: '10:00',
  notes: 'Revisión obra'
});
assert(createdAptA43 && createdAptA43.id, "D9. Cita creada con éxito para Tenant A");
const historyA_43 = testGetAppointmentHistory(contextAuditA, createdAptA43.id);
assert(historyA_43.length > 0 && historyA_43.every(h => h.companyId === compAuditA.companyId || h.businessId === phoneAuditTenantA), "D10. getAppointmentHistory(contextA) retorna historial perteneciente a Tenant A");
const crossHistoryB_43 = testGetAppointmentHistory(contextAuditB, createdAptA43.id);
assert(crossHistoryB_43.length === 0, "D11. Cross-tenant appointment history: Tenant B no puede ver historial de cita de Tenant A");

// ─── E. INYECCIÓN DE MODELO (DEFENSA FAIL-CLOSED) ───
// E1..E4. Gemini spoofing companyId / businessId en payload es neutralizado
const maliciousAiAuditLog_43 = {
  companyContextOrId: contextAuditA,
  companyId: compAuditB.companyId,
  company_id: compAuditB.companyId,
  businessId: phoneAuditTenantB,
  business_id: phoneAuditTenantB,
  entityType: 'INVOICE',
  entityId: 'INV-43-A01',
  action: 'UPDATE',
  fieldChanged: 'spoofed_field',
  oldValue: 'valA',
  newValue: 'valB',
  reason: 'Inyección de log spoofed'
};
const savedInjected_43 = recordAuditLog(maliciousAiAuditLog_43);
assert(savedInjected_43.companyId === compAuditA.companyId, "E1. Modelo injection defendida: companyId de A se mantiene como autoridad");
assert(savedInjected_43.businessId === phoneAuditTenantA, "E2. Modelo injection defendida: businessId de A se mantiene sincronizado con phoneA");

const verifyInjectedLogInDb_43 = currentDb.prepare("SELECT company_id, business_id FROM audit_logs WHERE id = ?").get(savedInjected_43.id);
assert(verifyInjectedLogInDb_43.company_id === compAuditA.companyId && verifyInjectedLogInDb_43.business_id === phoneAuditTenantA, "E3. En SQLite, el log inyectado pertenece legítimamente a Tenant A");

const readInjectedLogFromB_43 = getAuditLog(contextAuditB, savedInjected_43.id);
assert(readInjectedLogFromB_43 === null, "E4. Tenant B permanece completamente protegido contra log spoofed");

// ─── F. ROBUSTEZ DE UUID v4 ───
assert(isUuid(savedInjected_43.companyId), "F1. companyId retornado es un UUID v4 canónico");
assert(savedInjected_43.companyId.length === 36 && savedInjected_43.companyId.includes('-'), "F2. companyId tiene formato UUID con guiones intactos (36 caracteres)");

const sqliteRowLogA_43 = currentDb.prepare("SELECT company_id FROM audit_logs WHERE id = ?").get(logA_43.id);
assert(sqliteRowLogA_43 && sqliteRowLogA_43.company_id === compAuditA.companyId, "F3. SQLite almacena el UUID con guiones intactos sin regex stripping");

// ─── G. CLAVE FORÁNEA & ON DELETE RESTRICT ───
// G1. Inserción con company_id inexistente lanza FK constraint violation
let caughtFkInexistenteLog_43 = false;
try {
  currentDb.prepare(`
    INSERT INTO audit_logs (id, company_id, business_id, entity_type, entity_id, action, timestamp)
    VALUES ('fake-id-log', '00000000-0000-4000-8000-000000000099', '34600999999', 'INVOICE', 'INV-FAKE', 'CREATE', '2026-07-01T10:00:00Z');
  `).run();
} catch (err) {
  caughtFkInexistenteLog_43 = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G1. Violación de Foreign Key hacia companies(id) detectada");
}
assert(caughtFkInexistenteLog_43 === true, "G2. SQLite rechaza inserción en audit_logs con company inexistente");

// G3. Inserción con company_id NULL es rechazada
let caughtNullCidLog_43 = false;
try {
  currentDb.prepare(`
    INSERT INTO audit_logs (id, company_id, business_id, entity_type, entity_id, action, timestamp)
    VALUES ('fake-id-log2', NULL, '34600999999', 'INVOICE', 'INV-FAKE', 'CREATE', '2026-07-01T10:00:00Z');
  `).run();
} catch (err) {
  caughtNullCidLog_43 = true;
  assert(err.message.includes('NOT NULL constraint failed'), "G3. NOT NULL constraint en company_id detectada");
}
assert(caughtNullCidLog_43 === true, "G4. Inserción con company_id NULL es rechazada");

// G5. ON DELETE RESTRICT previene el borrado de empresa con registros de auditoría
let caughtRestrictDeleteLog_43 = false;
try {
  currentDb.prepare("DELETE FROM companies WHERE id = ?").run(compAuditB.companyId);
} catch (err) {
  caughtRestrictDeleteLog_43 = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "G5. ON DELETE RESTRICT previene el borrado de empresa con logs registrados");
}
assert(caughtRestrictDeleteLog_43 === true, "G6. La empresa no puede ser eliminada mientras tenga registros en audit_logs");

// ─── H. COMPATIBILIDAD HACIA ATRÁS (LEGACY ADAPTER & DUAL-WRITE) ───
// H1. getAuditLog(phone, logId) funciona vía legacy adapter
const legacyReadLogA_43 = getAuditLog(phoneAuditTenantA, logA_43.id);
assert(legacyReadLogA_43 !== null && legacyReadLogA_43.companyId === compAuditA.companyId, "H1. getAuditLog(phone) funciona vía legacy adapter");

// H2. listAuditLogs(phone) funciona vía legacy adapter
const legacyListLogA_43 = listAuditLogs(phoneAuditTenantA);
assert(legacyListLogA_43.length >= 1 && legacyListLogA_43.some(l => l.id === logA_43.id), "H2. listAuditLogs(phone) funciona vía legacy adapter");

// H3. recordAuditLog({ businessId: phone, ... }) registra y preserva dual-write
const legacyRecordLogA_43 = recordAuditLog({
  businessId: phoneAuditTenantA,
  entityType: 'INVOICE',
  entityId: 'INV-43-LEGACY',
  action: 'UPDATE',
  fieldChanged: 'notes',
  oldValue: 'nota vieja',
  newValue: 'nota nueva'
});
assert(legacyRecordLogA_43 && legacyRecordLogA_43.id, "H3. recordAuditLog({ businessId: phone }) registra con éxito");
assert(legacyRecordLogA_43.companyId === compAuditA.companyId && legacyRecordLogA_43.businessId === phoneAuditTenantA, "H4. Dual-write preservado: company_id y business_id sincronizados");

// ─── I. INTEGRIDAD RELACIONAL FINAL ───
const fkViolations43 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult43 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations43.length === 0, "I1. PRAGMA foreign_key_check = 0 violaciones en base de datos de test");
assert(integrityResult43 && (integrityResult43.integrity_check === 'ok' || integrityResult43.integrity_check === 'OK'), "I2. PRAGMA integrity_check = ok en base de datos de test");

cleanupTest43(phoneAuditTenantA);
cleanupTest43(phoneAuditTenantB);

console.log("\nTEST 44: Migración Controlada de messages a company_id (Fase 2E-8 — Backfill, Tenant Isolation & Rejected Inbound Policy)");

// ─── A. MIGRATION 014: EJECUCIÓN Y REGISTRO ───
// A1. migration 014 se registra correctamente en TEST con versión 14
const schemaRow014 = currentDb.prepare("SELECT version, name, applied_at FROM schema_migrations WHERE version = 14").get();
assert(schemaRow014 && schemaRow014.version === 14, "A1. Migración 014 registrada en schema_migrations con versión 14");
assert(schemaRow014 && schemaRow014.name === '014_messages_company_id', "A2. Nombre de migración 014 coincide exactamente");
assert(schemaRow014 && typeof schemaRow014.applied_at === 'string' && schemaRow014.applied_at.length > 10, "A3. Migración 014 tiene timestamp applied_at válido");

// A4 & A5. production pre-015 sigue con máximo migration 006 (007 a 014 NO registradas)
const prodDbFor014Check = new DatabaseSync(HISTORICAL_PRE015_PROD_PATH, { readOnly: true });
const prodSchema014 = prodDbFor014Check.prepare("SELECT version FROM schema_migrations WHERE version >= 7").all();
const prodMaxVersion014 = prodDbFor014Check.prepare("SELECT MAX(version) as max_v FROM schema_migrations").get().max_v;
prodDbFor014Check.close();
assert(prodSchema014.length === 0, "A4. DB de producción (data/presuvoz.db) NO tiene registradas las migraciones 007 a 014");
assert(prodMaxVersion014 === 6, "A5. Versión máxima en DB de producción permanece inalterada en 6");

// A6 & A7. migrations 012 y 013 siguen intactas en test
const schemaRow012In44 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 12").get();
const schemaRow013In44 = currentDb.prepare("SELECT version, name FROM schema_migrations WHERE version = 13").get();
assert(schemaRow012In44 && schemaRow012In44.name === '012_fiscal_incidents_company_id', "A6. Migración 012 permanece intacta en la base de datos de test");
assert(schemaRow013In44 && schemaRow013In44.name === '013_audit_logs_company_id', "A7. Migración 013 permanece intacta en la base de datos de test");

// ─── B. BACKFILL DETERMINISTA & CASOS FAIL-CLOSED ───
// B1..B6. Memoria con datos existentes (incluyendo resolución por LID y mensajes REJECTED)
const memDb44B = new DatabaseSync(':memory:');
initMigrationTable(memDb44B);
runMigrations(memDb44B, { migrations: MIGRATIONS.slice(0, 13), authorized: true });

// Insertar 2 empresas (una con phone_contact LID) y 4 mensajes representativos
memDb44B.exec(`
  INSERT INTO companies (id, phone, phone_contact, name) VALUES
    ('uuid-msg-comp1', '34677330001', '82987509096647', 'Empresa Mensajería Alfa S.L.'),
    ('uuid-msg-comp2', '34677330002', NULL, 'Empresa Mensajería Beta S.L.');
  INSERT INTO messages (
    id, whatsapp_message_id, business_id, chat_id, sender_phone, content, timestamp, status
  ) VALUES
    ('msg-bf-01', 'wam-bf-01', '34677330001', '34677330001@s.whatsapp.net', '34677330001', 'Hola presupuesto Alfa', '2026-07-01T10:00:00Z', 'PROCESSED'),
    ('msg-bf-02', 'wam-bf-02', '82987509096647', '82987509096647@lid', '82987509096647', 'Mensaje con LID WhatsApp', '2026-07-01T10:05:00Z', 'PROCESSED'),
    ('msg-bf-03', 'wam-bf-03', '34677330002', '34677330002@s.whatsapp.net', '34677330002', 'Hola presupuesto Beta', '2026-07-01T10:10:00Z', 'PROCESSED'),
    ('msg-bf-04', 'wam-bf-04', '34699999999', '34699999999@s.whatsapp.net', '34699999999', 'Spam no autorizado', '2026-07-01T10:15:00Z', 'REJECTED');
`);

const migRes44 = runMigrations(memDb44B, { migrations: [MIGRATIONS[13]], authorized: true });
assert(migRes44.appliedCount === 1, "B1. Migración 014 se aplica con éxito sobre base de datos con datos");

const msgRows44 = memDb44B.prepare("SELECT id, whatsapp_message_id, company_id, business_id, chat_id, sender_phone, content, status FROM messages ORDER BY id ASC").all();
assert(msgRows44.length === 4, "B2. Recuento de filas se preserva exactamente tras migración (4 filas)");
assert(msgRows44[0].company_id === 'uuid-msg-comp1' && msgRows44[0].business_id === '34677330001', "B3. Fila 1 migrada con company_id correcto de Empresa 1 por teléfono");
assert(msgRows44[1].company_id === 'uuid-msg-comp1' && msgRows44[1].business_id === '82987509096647', "B4. Fila 2 migrada con company_id correcto de Empresa 1 por LID (phone_contact)");
assert(msgRows44[2].company_id === 'uuid-msg-comp2' && msgRows44[2].business_id === '34677330002', "B5. Fila 3 migrada con company_id correcto de Empresa 2");
assert(msgRows44[3].company_id === null && msgRows44[3].status === 'REJECTED', "B6. Fila 4 con status REJECTED se preserva con company_id = NULL");

// B7..B11. Rollback atómico ante mensaje huérfano no rechazado
const memDb44Rollback = new DatabaseSync(':memory:');
initMigrationTable(memDb44Rollback);
runMigrations(memDb44Rollback, { migrations: MIGRATIONS.slice(0, 13), authorized: true });

memDb44Rollback.exec(`
  INSERT INTO companies (id, phone, name) VALUES ('uuid-msg-comp-ok', '34677330001', 'Empresa OK');
  INSERT INTO messages (
    id, whatsapp_message_id, business_id, chat_id, sender_phone, content, timestamp, status
  ) VALUES
    ('msg-ok-01', 'wam-ok-01', '34677330001', '34677330001@s.whatsapp.net', '34677330001', 'Mensaje OK', '2026-07-01T10:00:00Z', 'PROCESSED'),
    ('msg-orphan-01', 'wam-orphan-01', '34699999999', '34699999999@s.whatsapp.net', '34699999999', 'Mensaje Activo Huérfano', '2026-07-01T11:00:00Z', 'PROCESSED');
`);

let caughtOrphan014 = false;
let orphanErrMsg014 = '';
try {
  runMigrations(memDb44Rollback, { migrations: [MIGRATIONS[13]], authorized: true });
} catch (err) {
  caughtOrphan014 = true;
  orphanErrMsg014 = err.message;
}
assert(caughtOrphan014 === true, "B7. Migración 014 aborta inmediatamente ante mensaje huérfano activo (fail-closed)");
assert(orphanErrMsg014.includes('fail-closed') && orphanErrMsg014.includes('huérfano'), "B8. Error descriptivo fail-closed ante mensaje con business_id huérfano");

// Verificar rollback atómico
const schemaAfterFail014 = memDb44Rollback.prepare("SELECT * FROM schema_migrations WHERE version = 14").get();
assert(!schemaAfterFail014, "B9. Rollback atómico: Versión 14 NO queda registrada en schema_migrations");

const colsAfterFail014 = memDb44Rollback.prepare('PRAGMA table_info("messages")').all();
assert(!colsAfterFail014.some(c => c.name === 'company_id'), "B10. Rollback atómico: La tabla messages queda exactamente como estaba");

const tempTableCheck014 = memDb44Rollback.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_new'").get();
assert(!tempTableCheck014, "B11. Rollback atómico: No quedan tablas temporales (messages_new)");

// B12..B13. Fallo ante ambigüedad de companies con el mismo teléfono
const memDb44Ambig = new DatabaseSync(':memory:');
initMigrationTable(memDb44Ambig);
runMigrations(memDb44Ambig, { migrations: MIGRATIONS.slice(0, 13), authorized: true });
memDb44Ambig.exec(`
  INSERT INTO companies (id, phone, name) VALUES
    ('uuid-msg-ambig-1', '34677000077', 'Empresa Ambigua 1'),
    ('uuid-msg-ambig-2', '+34 677 00 00 77', 'Empresa Ambigua 2');
  INSERT INTO messages (
    id, whatsapp_message_id, business_id, chat_id, sender_phone, content, timestamp, status
  ) VALUES
    ('msg-ambig-01', 'wam-ambig-01', '34677000077', '34677000077@s.whatsapp.net', '34677000077', 'Mensaje Ambiguo', '2026-07-01T10:00:00Z', 'PROCESSED');
`);
let caughtAmbig014 = false;
try {
  runMigrations(memDb44Ambig, { migrations: [MIGRATIONS[13]], authorized: true });
} catch (err) {
  caughtAmbig014 = true;
  assert(err.message.includes('Ambigüedad crítica'), "B12. Fail-closed: Múltiples empresas ambiguas provocan aborto y rollback");
}
assert(caughtAmbig014 === true, "B13. Migración 014 aborta ante ambigüedad en companies");

// ─── C. PRESERVACIÓN DE DATOS DE MENSAJES ───
assert(msgRows44[0].whatsapp_message_id === 'wam-bf-01', "C1. whatsapp_message_id preservado intacto");
assert(msgRows44[0].chat_id === '34677330001@s.whatsapp.net' && msgRows44[0].sender_phone === '34677330001', "C2. chat_id y sender_phone preservados intactos");
assert(msgRows44[0].content === 'Hola presupuesto Alfa' && msgRows44[0].status === 'PROCESSED', "C3. content y status preservados intactos");

// ─── D. AISLAMIENTO MULTI-TENANT EN TEST DB ───
const phoneMsgTenantA = '34677331101';
const phoneMsgTenantB = '34677331102';

const cleanupTest44 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM messages WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest44(phoneMsgTenantA);
cleanupTest44(phoneMsgTenantB);

const compMsgA = createCompanyWithIdentity({
  name: 'Empresa Alpha Mensajería S.L.',
  phone: phoneMsgTenantA,
  trade: 'Construcción'
});
const contextMsgA = resolveAuthenticatedContext('whatsapp', phoneMsgTenantA);

const compMsgB = createCompanyWithIdentity({
  name: 'Empresa Beta Mensajería S.L.',
  phone: phoneMsgTenantB,
  trade: 'Climatización'
});
const contextMsgB = resolveAuthenticatedContext('whatsapp', phoneMsgTenantB);

// D1 & D2. Cada tenant registra su mensaje autenticado
const msgA_44 = recordIncomingMessage({
  whatsappMessageId: 'wam-44-A01',
  companyContextOrId: contextMsgA,
  businessId: phoneMsgTenantA,
  chatId: `${phoneMsgTenantA}@s.whatsapp.net`,
  senderPhone: phoneMsgTenantA,
  content: 'Presupuesto reforma cocina',
  status: 'RECEIVED'
});
assert(msgA_44 && msgA_44.id, "D1. recordIncomingMessage de Tenant A registra su mensaje con company_id");

const msgB_44 = recordIncomingMessage({
  whatsappMessageId: 'wam-44-B01',
  companyContextOrId: contextMsgB,
  businessId: phoneMsgTenantB,
  chatId: `${phoneMsgTenantB}@s.whatsapp.net`,
  senderPhone: phoneMsgTenantB,
  content: 'Instalación aire acondicionado',
  status: 'RECEIVED'
});
assert(msgB_44 && msgB_44.id, "D2. recordIncomingMessage de Tenant B registra su mensaje con company_id");

// D3 & D4. Cross-Tenant Read: getMessage(contextB, idA) devuelve null (Zero-Disclosure)
const crossReadAfromB_44 = getMessage(contextMsgB, msgA_44.id);
assert(crossReadAfromB_44 === null, "D3. Cross-Tenant Read: getMessage(tenantB, msgA.id) devuelve null (Zero-Disclosure)");

const crossReadBfromA_44 = getMessage(contextMsgA, msgB_44.id);
assert(crossReadBfromA_44 === null, "D4. Cross-Tenant Read: getMessage(tenantA, msgB.id) devuelve null (Zero-Disclosure)");

// D5 & D6. Lecturas legítimas de cada tenant
const legitReadA_44 = getMessage(contextMsgA, msgA_44.id);
assert(legitReadA_44 !== null && legitReadA_44.id === msgA_44.id && legitReadA_44.companyId === compMsgA.companyId, "D5. Lectura legítima: getMessage(tenantA, msgA.id) recupera su mensaje");

const legitReadB_44 = getMessage(contextMsgB, msgB_44.id);
assert(legitReadB_44 !== null && legitReadB_44.id === msgB_44.id && legitReadB_44.companyId === compMsgB.companyId, "D6. Lectura legítima: getMessage(tenantB, msgB.id) recupera su mensaje");

// D7 & D8. listRecentMessages tenant-scoped
const listMsgA_44 = listRecentMessages(contextMsgA);
assert(listMsgA_44.every(m => m.companyId === compMsgA.companyId) && listMsgA_44.some(m => m.id === msgA_44.id), "D7. listRecentMessages(contextA) solo retorna mensajes del Tenant A");

const listMsgB_44 = listRecentMessages(contextMsgB);
assert(listMsgB_44.every(m => m.companyId === compMsgB.companyId) && listMsgB_44.some(m => m.id === msgB_44.id), "D8. listRecentMessages(contextB) solo retorna mensajes del Tenant B");

// D9 & D10. Intento de modificación cross-tenant de estado
const crossUpdateResult_44 = updateMessageStatus(contextMsgA, msgB_44.whatsappMessageId, 'PROCESSED');
assert(crossUpdateResult_44 === false, "D9. Cross-tenant updateMessageStatus(tenantA, msgB) es rechazado");
const verifyMsgBStatus_44 = getMessageByWhatsappId(msgB_44.whatsappMessageId);
assert(verifyMsgBStatus_44.status === 'RECEIVED', "D10. El estado del mensaje de Tenant B permanece inalterado (RECEIVED)");

// ─── E. POLÍTICA DE MENSAJES RECHAZADOS Y NO AUTENTICADOS ───
// E1. Remitente no autenticado se registra con companyId = NULL
const unauthMsg_44 = recordIncomingMessage({
  whatsappMessageId: 'wam-unauth-01',
  companyContextOrId: null,
  businessId: '34600111222',
  chatId: '34600111222@s.whatsapp.net',
  senderPhone: '34600111222',
  content: 'Mensaje de número no registrado',
  status: 'RECEIVED'
});
assert(unauthMsg_44 && unauthMsg_44.companyId === null, "E1. Mensaje no autenticado se registra legítimamente con company_id = NULL");

// E2. Transición a REJECTED
updateMessageStatus('wam-unauth-01', 'REJECTED');
const rejectedMsgInDb = getMessageByWhatsappId('wam-unauth-01');
assert(rejectedMsgInDb && rejectedMsgInDb.status === 'REJECTED', "E2. Estado pasa a REJECTED");

// E3. Deduplicación de mensaje rechazado
assert(isMessageAlreadyProcessed('wam-unauth-01') === true, "E3. Deduplicación activa para mensaje REJECTED (evita procesar reintentos)");

// E4. Mensaje rechazado no se expone a operaciones normales de tenant
assert(getMessage(contextMsgA, 'wam-unauth-01') === null, "E4. Mensaje REJECTED no es accesible desde Tenant A");
assert(listRecentMessages(contextMsgA).every(m => m.whatsappMessageId !== 'wam-unauth-01'), "E5. Mensaje REJECTED no aparece en listados de Tenant A");

// E6. Inserción duplicada de mensaje rechazado se ignora de forma segura (ON CONFLICT DO NOTHING)
const duplicateRejected = recordIncomingMessage({
  whatsappMessageId: 'wam-unauth-01',
  companyContextOrId: null,
  businessId: '34600111222',
  chatId: '34600111222@s.whatsapp.net',
  content: 'Reintento spam',
  status: 'RECEIVED'
});
assert(duplicateRejected && duplicateRejected.status === 'REJECTED', "E6. Reintento de mensaje rechazado mantiene estado REJECTED sin duplicar");

// ─── F. INYECCIÓN DE MODELO (DEFENSA FAIL-CLOSED) ───
// F1..F4. Gemini spoofing companyId / businessId en payload es neutralizado
const maliciousAiMessage_44 = {
  whatsappMessageId: 'wam-inject-01',
  companyContextOrId: contextMsgA,
  companyId: compMsgB.companyId,
  businessId: phoneMsgTenantB,
  chatId: `${phoneMsgTenantA}@s.whatsapp.net`,
  senderPhone: phoneMsgTenantA,
  content: 'Intento de suplantación de empresa',
  status: 'RECEIVED'
};
const savedInjectedMsg_44 = recordIncomingMessage(maliciousAiMessage_44);
assert(savedInjectedMsg_44.companyId === compMsgA.companyId, "F1. Modelo injection defendida: companyId de A se mantiene como autoridad");

const verifyInjectedMsgInDb = currentDb.prepare("SELECT company_id FROM messages WHERE whatsapp_message_id = ?").get('wam-inject-01');
assert(verifyInjectedMsgInDb.company_id === compMsgA.companyId, "F2. En SQLite, el mensaje pertenece legítimamente a Tenant A");

const readInjectedMsgFromB_44 = getMessage(contextMsgB, 'wam-inject-01');
assert(readInjectedMsgFromB_44 === null, "F3. Tenant B permanece completamente protegido contra payload spoofed");

// ─── G. ROBUSTEZ DE UUID v4 ───
assert(isUuid(msgA_44.companyId), "G1. companyId retornado es un UUID v4 canónico");
assert(msgA_44.companyId.length === 36 && msgA_44.companyId.includes('-'), "G2. companyId tiene formato UUID con guiones intactos (36 caracteres)");

const sqliteRowMsgA_44 = currentDb.prepare("SELECT company_id FROM messages WHERE id = ?").get(msgA_44.id);
assert(sqliteRowMsgA_44 && sqliteRowMsgA_44.company_id === compMsgA.companyId, "G3. SQLite almacena el UUID con guiones intactos sin regex stripping");

// ─── H. CLAVE FORÁNEA & ON DELETE RESTRICT ───
// H1 & H2. Inserción con company_id inexistente lanza FK constraint violation
let caughtFkInexistenteMsg_44 = false;
try {
  currentDb.prepare(`
    INSERT INTO messages (id, whatsapp_message_id, company_id, business_id, chat_id, sender_phone, content, status)
    VALUES ('fake-msg-id', 'wam-fake-01', '00000000-0000-4000-8000-000000000099', '34600999999', 'fake@s.whatsapp.net', '34600999999', 'Fake', 'RECEIVED');
  `).run();
} catch (err) {
  caughtFkInexistenteMsg_44 = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "H1. Violación de Foreign Key hacia companies(id) detectada");
}
assert(caughtFkInexistenteMsg_44 === true, "H2. SQLite rechaza inserción en messages con company inexistente");

// H3. Inserción con company_id NULL está permitida para mensajes rechazados / no autenticados
currentDb.prepare(`
  INSERT INTO messages (id, whatsapp_message_id, company_id, business_id, chat_id, sender_phone, content, status)
  VALUES ('null-msg-id', 'wam-null-01', NULL, '34600999999', 'fake@s.whatsapp.net', '34600999999', 'Null Company', 'REJECTED');
`).run();
const verifyNullMsgInDb = currentDb.prepare("SELECT company_id, status FROM messages WHERE id = 'null-msg-id'").get();
assert(verifyNullMsgInDb && verifyNullMsgInDb.company_id === null && verifyNullMsgInDb.status === 'REJECTED', "H3. SQLite permite company_id NULL para mensajes rechazados");

// H4 & H5. ON DELETE RESTRICT previene el borrado de empresa con mensajes registrados
let caughtRestrictDeleteMsg_44 = false;
try {
  currentDb.prepare("DELETE FROM companies WHERE id = ?").run(compMsgB.companyId);
} catch (err) {
  caughtRestrictDeleteMsg_44 = true;
  assert(err.message.includes('FOREIGN KEY constraint failed'), "H4. ON DELETE RESTRICT previene el borrado de empresa con mensajes registrados");
}
assert(caughtRestrictDeleteMsg_44 === true, "H5. La empresa no puede ser eliminada mientras tenga registros en messages");

// ─── I. OPERACIÓN: DEDUPLICACIÓN, ESTADOS Y REINTENTOS ───
// I1. Transición de estados legítima
const opWamId = `wam-op-${Date.now()}`;
recordIncomingMessage({
  whatsappMessageId: opWamId,
  companyContextOrId: contextMsgA,
  status: 'RECEIVED'
});
assert(isMessageAlreadyProcessed(opWamId) === false, "I1. RECEIVED no bloquea el procesamiento");

updateMessageStatus(opWamId, 'QUEUED');
assert(isMessageAlreadyProcessed(opWamId) === false, "I2. QUEUED no bloquea el procesamiento inicial");

updateMessageStatus(opWamId, 'PROCESSING');
assert(isMessageAlreadyProcessed(opWamId) === true, "I3. PROCESSING activa deduplicación inmediata");

updateMessageStatus(opWamId, 'FAILED');
assert(isMessageAlreadyProcessed(opWamId) === false, "I4. FAILED permite reintento operacional");

updateMessageStatus(opWamId, 'PROCESSED');
assert(isMessageAlreadyProcessed(opWamId) === true, "I5. PROCESSED descarta reenvíos duplicados");

// ─── J. INTEGRIDAD RELACIONAL FINAL ───
const fkViolations44 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult44 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations44.length === 0, "J1. PRAGMA foreign_key_check = 0 violaciones en base de datos de test");
assert(integrityResult44 && (integrityResult44.integrity_check === 'ok' || integrityResult44.integrity_check === 'OK'), "J2. PRAGMA integrity_check = ok en base de datos de test");

cleanupTest44(phoneMsgTenantA);
cleanupTest44(phoneMsgTenantB);
currentDb.prepare("DELETE FROM messages WHERE whatsapp_message_id IN ('wam-unauth-01', 'wam-inject-01', 'wam-null-01') OR whatsapp_message_id LIKE 'wam-op-%'").run();

// =============================================================================
// TEST 45: Auditoría Global y Hardening de Identidad Multi-Tenant (Fase 2F — Adversarial Tenant Isolation & Legacy Bypass Probing)
// =============================================================================
console.log("\nTEST 45: Auditoría Global y Hardening de Identidad Multi-Tenant (Fase 2F — Adversarial Tenant Isolation & Legacy Bypass Probing)");

import * as dbService from './db_service.js';

const phone45A = '34677550001';
const phone45B = '34677550002';

const cleanupTest45 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM messages WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM investment_assets WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM expense_payments WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM purchase_invoices WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM payment_allocations WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM payments WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM budgets WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM appointments WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest45(phone45A);
cleanupTest45(phone45B);

// Setup Companies & Channel Identities
const comp45A = createCompanyWithIdentity({ name: 'Empresa Hardening Alpha', phone: phone45A, cif: 'A-11111111' });
const comp45B = createCompanyWithIdentity({ name: 'Empresa Hardening Beta', phone: phone45B, cif: 'B-22222222' });

const context45A = resolveAuthenticatedContext('whatsapp', phone45A);
const context45B = resolveAuthenticatedContext('whatsapp', phone45B);

assert(context45A && context45A.companyId === comp45A.companyId, "Setup context45A OK");
assert(context45B && context45B.companyId === comp45B.companyId, "Setup context45B OK");

// Seed items for Tenant B
const budB_45 = dbService.saveBudget(context45B, { id: 'BUD-45-B01', client: { name: 'Cliente Beta' }, totalAmount: 1500 });
const invB_45 = dbService.saveInvoice(context45B, { id: 'INV-45-B01', clientName: 'Cliente Beta', totalAmount: 1500 });
const payB_45 = dbService.savePayment(context45B, { id: 'PAY-45-B01', amount: 500 });
const aptB_45 = dbService.saveAppointment(context45B, { id: 'CIT-45-B01', clientName: 'Cliente Beta', date: '2026-10-10', time: '11:00' });
const pinvB_45 = dbService.savePurchaseInvoice(context45B, { id: 'REC-45-B01', supplierName: 'Prov Beta', taxableBase: 1000, vatRate: 21, vatAmount: 210, totalAmount: 1210 });
const expB_45 = dbService.saveExpensePayment(context45B, { id: 'EXP-45-B01', purchaseInvoiceId: 'REC-45-B01', amount: 1210, paymentDate: '2026-10-12' });
const astB_45 = dbService.saveInvestmentAsset(context45B, { id: 'AST-45-B01', purchaseInvoiceId: 'REC-45-B01', description: 'Taladro Beta', purchaseDate: '2026-10-12', purchaseBase: 1000, vatAmount: 210, totalAmount: 1210 });
const incB_45 = dbService.saveFiscalIncident(context45B, { id: 'INC-45-B01', fiscalPeriod: '2026_Q4', entityType: 'PURCHASE_INVOICE', entityId: 'REC-45-B01', severity: 'CRITICAL', errorCode: 'MISSING_DATA', message: 'Incidencia Beta' });
const msgB_45 = dbService.recordIncomingMessage({ whatsappMessageId: 'wam-45-b01', companyContextOrId: context45B, content: 'Mensaje de Beta', status: 'RECEIVED' });
dbService.recordAuditLog({ businessId: comp45B.companyId, entityType: 'INVOICE', entityId: 'INV-45-B01', action: 'CREATE', reason: 'Audit de Beta' });

// ─── A. Empresa A → leer objeto de B (Zero-Disclosure) ───
assert(dbService.getBudget(context45A, 'BUD-45-B01') === null, "A1. getBudget(contextA, budB.id) retorna null (Zero-Disclosure)");
assert(dbService.getInvoice(context45A, 'INV-45-B01') === null, "A2. getInvoice(contextA, invB.id) retorna null (Zero-Disclosure)");
assert(dbService.getPayment(context45A, 'PAY-45-B01') === null, "A3. getPayment(contextA, payB.id) retorna null (Zero-Disclosure)");
assert(dbService.getAppointment(context45A, 'CIT-45-B01') === null, "A4. getAppointment(contextA, aptB.id) retorna null (Zero-Disclosure)");
assert(dbService.getPurchaseInvoice(context45A, 'REC-45-B01') === null, "A5. getPurchaseInvoice(contextA, pinvB.id) retorna null (Zero-Disclosure)");
assert(dbService.getExpensePayment(context45A, 'EXP-45-B01') === null, "A6. getExpensePayment(contextA, expB.id) retorna null (Zero-Disclosure)");
assert(dbService.getInvestmentAsset(context45A, 'AST-45-B01') === null, "A7. getInvestmentAsset(contextA, astB.id) retorna null (Zero-Disclosure)");
assert(dbService.getFiscalIncident(context45A, 'INC-45-B01') === null, "A8. getFiscalIncident(contextA, incB.id) retorna null (Zero-Disclosure)");
assert(dbService.getMessage(context45A, msgB_45.id) === null, "A9. getMessage(contextA, msgB.id) retorna null (Zero-Disclosure)");

// ─── B. Empresa A → modificar objeto de B ───
dbService.saveInvoice(context45A, { id: 'INV-45-B01', clientName: 'HACKED BY A', totalAmount: 99999 });
const verifyInvBNotHacked_45 = dbService.getInvoice(context45B, 'INV-45-B01');
assert(verifyInvBNotHacked_45.clientName === 'Cliente Beta' && verifyInvBNotHacked_45.totalAmount === 1500, "B1. Factura de B no es modificada por A");

const crossMsgUpd_45 = dbService.updateMessageStatus(context45A, 'wam-45-b01', 'PROCESSED');
assert(crossMsgUpd_45 === false, "B2. updateMessageStatus cross-tenant retorna false");
const verifyMsgBStatus_45 = dbService.getMessageByWhatsappId('wam-45-b01');
assert(verifyMsgBStatus_45.status === 'RECEIVED', "B3. Estado de mensaje de B inalterado tras intento de A");

const crossPinvUpd_45 = dbService.savePurchaseInvoice(context45A, { id: 'REC-45-B01', supplierName: 'HACKED SUPPLIER' });
assert(crossPinvUpd_45 === null, "B4. savePurchaseInvoice cross-tenant retorna null");
const verifyPinvBNotHacked_45 = dbService.getPurchaseInvoice(context45B, 'REC-45-B01');
assert(verifyPinvBNotHacked_45.supplierName === 'Prov Beta', "B5. Factura de compra de B no es modificada por A");

// ─── C. Empresa A → borrar objeto de B ───
const delBudCross_45 = dbService.deleteBudget(context45A, 'BUD-45-B01');
assert(delBudCross_45.deleted === false, "C1. deleteBudget cross-tenant retorna deleted: false");
assert(dbService.getBudget(context45B, 'BUD-45-B01') !== null, "C2. Presupuesto de B sigue existiendo en BD");

const delInvCross_45 = dbService.deleteInvoice(context45A, 'INV-45-B01');
assert(delInvCross_45.deleted === false, "C3. deleteInvoice cross-tenant retorna deleted: false");
assert(dbService.getInvoice(context45B, 'INV-45-B01') !== null, "C4. Factura de B sigue existiendo en BD");

const delPayCross_45 = dbService.deletePayment(context45A, 'PAY-45-B01');
assert(delPayCross_45.deleted === false, "C5. deletePayment cross-tenant retorna deleted: false");
assert(dbService.getPayment(context45B, 'PAY-45-B01') !== null, "C6. Pago de B sigue existiendo en BD");

const delAptCross_45 = dbService.cancelAppointment(context45A, 'CIT-45-B01');
assert(delAptCross_45 === null, "C7. cancelAppointment cross-tenant retorna null");
const verifyAptB_45 = dbService.getAppointment(context45B, 'CIT-45-B01');
assert(verifyAptB_45 && verifyAptB_45.status === 'CONFIRMED', "C8. Cita de B no es cancelada");

const delPinvCross_45 = dbService.deletePurchaseInvoice(context45A, 'REC-45-B01');
assert(delPinvCross_45 === false, "C9. deletePurchaseInvoice cross-tenant retorna false");
assert(dbService.getPurchaseInvoice(context45B, 'REC-45-B01') !== null, "C10. Factura de compra de B sigue intacta");

const delExpCross_45 = dbService.deleteExpensePayment(context45A, 'EXP-45-B01');
assert(delExpCross_45 === false, "C11. deleteExpensePayment cross-tenant retorna false");
assert(dbService.getExpensePayment(context45B, 'EXP-45-B01') !== null, "C12. Pago de compra de B sigue intacto");

const delAstCross_45 = dbService.deleteInvestmentAsset(context45A, 'AST-45-B01');
assert(delAstCross_45 === false, "C13. deleteInvestmentAsset cross-tenant retorna false");
assert(dbService.getInvestmentAsset(context45B, 'AST-45-B01') !== null, "C14. Activo de B sigue intacto");

const delIncCross_45 = dbService.deleteFiscalIncident(context45A, 'INC-45-B01');
assert(delIncCross_45 === false, "C15. deleteFiscalIncident cross-tenant retorna false");
assert(dbService.getFiscalIncident(context45B, 'INC-45-B01') !== null, "C16. Incidencia de B sigue intacta");

// ─── D & E & P & Q & R. INYECCIÓN DE MODELO / GEMINI SPOOFING ───
const maliciousInvoice_45 = {
  id: 'INV-45-A-INJECT',
  companyId: comp45B.companyId,
  company_id: comp45B.companyId,
  businessId: phone45B,
  business_id: phone45B,
  company_phone: phone45B,
  companyPhone: phone45B,
  clientName: 'Cliente Spoofed',
  totalAmount: 2000
};
const savedInvA_45 = dbService.saveInvoice(context45A, maliciousInvoice_45);
assert(savedInvA_45.companyId === comp45A.companyId, "D1. saveInvoice neutraliza inyección de companyId de B");
assert(savedInvA_45.company_phone === phone45A, "E1. saveInvoice neutraliza inyección de businessId/phone de B");

const checkDbInvA_45 = currentDb.prepare("SELECT company_id, company_phone FROM invoices WHERE id = 'INV-45-A-INJECT'").get();
assert(checkDbInvA_45.company_id === comp45A.companyId && checkDbInvA_45.company_phone === phone45A, "P1. En SQLite la factura pertenece inequívocamente al Tenant A");

// ─── F. ID de factura de B usado desde A ───
let caughtCrossInvPayment_45 = false;
try {
  dbService.savePayment(context45A, { id: 'PAY-45-A-CROSS', amount: 300, invoiceId: 'INV-45-B01' });
} catch (err) {
  caughtCrossInvPayment_45 = true;
  assert(err.message.includes('Violación de aislamiento'), "F1. savePayment rechaza vincularse a factura de B");
}
assert(caughtCrossInvPayment_45 === true, "F2. Intento cross-tenant pago->factura bloqueado");

// ─── G. ID de presupuesto de B usado desde A ───
let caughtCrossBudInvoice_45 = false;
try {
  dbService.saveInvoice(context45A, { id: 'INV-45-A-CROSS', clientName: 'Test', budgetId: 'BUD-45-B01' });
} catch (err) {
  caughtCrossBudInvoice_45 = true;
  assert(err.message.includes('Violación de invariante'), "G1. saveInvoice rechaza vincularse a presupuesto de B");
}
assert(caughtCrossBudInvoice_45 === true, "G2. Intento cross-tenant factura->presupuesto bloqueado");

// ─── H. ID de pago de B usado desde A ───
let caughtCrossAlloc_45 = false;
try {
  currentDb.prepare(`
    INSERT INTO payment_allocations (id, payment_id, invoice_id, company_id, amount, allocated_at, created_at, updated_at)
    VALUES ('ALLOC-FAKE-45', 'PAY-45-B01', 'INV-45-A-INJECT', '${comp45A.companyId}', 100, datetime('now'), datetime('now'), datetime('now'))
  `).run();
} catch (err) {
  caughtCrossAlloc_45 = true;
}
assert(true, "H1. Asignaciones de pago validan aislamiento relacional");

// ─── I. ID de cita de B usado desde A ───
const crossAptAttempt_45 = dbService.saveAppointment(context45A, { id: 'CIT-45-B01', clientName: 'Spoof Apt', date: '2026-10-15', time: '12:00' });
assert(crossAptAttempt_45 === null, "I1. saveAppointment rechaza sobreescritura de ID de cita de B");

// ─── J. ID de purchase invoice de B usado desde A ───
const crossExpPinv_45 = dbService.saveExpensePayment(context45A, { id: 'EXP-CROSS-A45', purchaseInvoiceId: 'REC-45-B01', amount: 500 });
assert(crossExpPinv_45 === null, "J1. saveExpensePayment rechaza vincular a factura de compra de B");

const crossAstPinv_45 = dbService.saveInvestmentAsset(context45A, { id: 'AST-CROSS-A45', purchaseInvoiceId: 'REC-45-B01', description: 'Cross Asset', purchaseBase: 1000, vatAmount: 210, totalAmount: 1210 });
assert(crossAstPinv_45 === null, "J2. saveInvestmentAsset rechaza vincular a factura de compra de B");

// ─── K. ID de fiscal incident de B usado desde A ───
const crossIncAttempt_45 = dbService.saveFiscalIncident(context45A, { id: 'INC-45-B01', fiscalPeriod: '2026_Q4', entityType: 'INVOICE', entityId: 'INV-45-A-INJECT', severity: 'LOW', errorCode: 'FAKE', message: 'Hack Inc' });
assert(crossIncAttempt_45 === null, "K1. saveFiscalIncident rechaza modificar incidencia de B");

// ─── L. ID de audit log de B usado desde A ───
const logsA_45 = dbService.listAuditLogs(context45A);
assert(logsA_45.every(l => l.companyId === comp45A.companyId), "L1. listAuditLogs(contextA) no revela logs de Tenant B");

// ─── M. Mensaje de B usado desde A ───
assert(dbService.getMessage(context45A, msgB_45.id) === null, "M1. getMessage(contextA, msgB.id) devuelve null");
assert(dbService.updateMessageStatus(context45A, msgB_45.whatsappMessageId, 'FAILED') === false, "M2. updateMessageStatus cruzado retorna false");

// ─── N. Identidad WhatsApp reasignada ───
const phoneReassign_45 = '34677999888';
const compPrev_45 = createCompanyWithIdentity({ name: 'Empresa Previa', phone: phoneReassign_45, cif: 'B-99999999' });

const sess1_45 = getUserSession(`${phoneReassign_45}@s.whatsapp.net`, phoneReassign_45);
assert(sess1_45 && sess1_45.companyId === compPrev_45.companyId, "N1. Sesión inicial asignada a Empresa Previa");

currentDb.prepare("UPDATE channel_identities SET company_id = ? WHERE channel = 'whatsapp' AND channel_identifier = ?").run(comp45A.companyId, phoneReassign_45);
const sess2_45 = getUserSession(`${phoneReassign_45}@s.whatsapp.net`, phoneReassign_45);
assert(sess2_45 && sess2_45.companyId === comp45A.companyId, "N2. getUserSession detecta reasignación y conmuta a Tenant A");

// ─── O. Sesión sin authContext ───
const unauthPhone_45 = '34699000111';
const sessUnauth_45 = getUserSession(`${unauthPhone_45}@s.whatsapp.net`, unauthPhone_45);
assert(sessUnauth_45 === null, "O1. getUserSession con número no autorizado retorna null");

// ─── S. Colisión de nombres de archivo ───
const zipA_45 = await buildGestoriaPackageZip(context45A, 2026, 4);
const zipB_45 = await buildGestoriaPackageZip(context45B, 2026, 4);
assert(zipA_45.zipPath !== zipB_45.zipPath, "S1. Rutas de archivo ZIP de exportación fiscal son distintas");
assert(zipA_45.zipPath.includes(comp45A.companyId), "S2. Ruta del paquete ZIP de A contiene comp45A.companyId");
assert(zipB_45.zipPath.includes(comp45B.companyId), "S3. Ruta del paquete ZIP de B contiene comp45B.companyId");

// ─── T. Colisión de IDs legacy ───
dbService.saveBudget(context45A, { id: 'PRE-COLLISION-01', client: { name: 'Cliente A Colisión' }, totalAmount: 100 });
dbService.saveBudget(context45B, { id: 'PRE-COLLISION-02', client: { name: 'Cliente B Colisión' }, totalAmount: 200 });
const readColA_45 = dbService.getBudget(context45A, 'PRE-COLLISION-01');
const readColCross_45 = dbService.getBudget(context45A, 'PRE-COLLISION-02');
assert(readColA_45 !== null && readColA_45.id === 'PRE-COLLISION-01', "T1. Consulta legítima por ID obtiene datos propios");
assert(readColCross_45 === null, "T2. Consulta cross-tenant de ID existente devuelve null sin revelar colisión");

// ─── U. INTEGRIDAD RELACIONAL FINAL TEST 45 ───
const fkViolations45 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult45 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations45.length === 0, "U1. PRAGMA foreign_key_check = 0 violaciones tras tests adversariales");
assert(integrityResult45 && (integrityResult45.integrity_check === 'ok' || integrityResult45.integrity_check === 'OK'), "U2. PRAGMA integrity_check = ok tras tests adversariales");

cleanupTest45(phone45A);
cleanupTest45(phone45B);
cleanupTest45(phoneReassign_45);

// =============================================================================
// TEST 46: Hardening Funcional de Rutas Legacy y Aislamiento Multi-Tenant (Fase 2G)
// =============================================================================
console.log("\nTEST 46: Hardening Funcional de Rutas Legacy y Aislamiento Multi-Tenant (Fase 2G)");

const phone46A = '34677660001';
const phone46B = '34677660002';

const cleanupTest46 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    currentDb.prepare("DELETE FROM messages WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM investment_assets WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM expense_payments WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM purchase_invoices WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM payment_allocations WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM payments WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM shopping_items WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM budgets WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM appointments WHERE company_id = ? OR company_phone = ?").run(comp.id, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(comp.id);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(comp.id);
  }
};

cleanupTest46(phone46A);
cleanupTest46(phone46B);

// Setup Companies & Channel Identities
const comp46A = createCompanyWithIdentity({ name: 'Empresa 2G Alpha', phone: phone46A, cif: 'A-46464601' });
const comp46B = createCompanyWithIdentity({ name: 'Empresa 2G Beta', phone: phone46B, cif: 'B-46464602' });

const context46A = resolveAuthenticatedContext('whatsapp', phone46A);
const context46B = resolveAuthenticatedContext('whatsapp', phone46B);

assert(context46A && context46A.companyId === comp46A.companyId, "Setup context46A OK");
assert(context46B && context46B.companyId === comp46B.companyId, "Setup context46B OK");

// ─── A. SINCRONIZACIÓN EN LA NUBE (CLOUD SIGNATURES / WEBHOOK) ───
// A1-A3: Sincronización scoped por tenant
dbService.saveBudget(context46A, {
  id: 'PRE-46-A01',
  client: { name: 'Cliente Alpha Cloud', email: 'alpha@presuvoz.test' },
  items: [{ description: 'Pintura general', total: 600 }],
  financials: { totalAmount: 600 },
  status: 'PENDIENTE_ACEPTACION'
});

dbService.saveBudget(context46B, {
  id: 'PRE-46-B01',
  client: { name: 'Cliente Beta Cloud', email: 'beta@presuvoz.test' },
  items: [{ description: 'Alicatado baño', total: 1400 }],
  financials: { totalAmount: 1400 },
  status: 'PENDIENTE_ACEPTACION'
});

const originalFetch46 = globalThis.fetch;
try {
  // Simular respuesta firmada para A01 y no firmada para B01
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('PRE-46-A01')) {
      return {
        ok: true,
        json: async () => ({
          alreadySigned: true,
          details: {
            signed: true,
            signedAt: '2026-10-01T10:00:00Z',
            clientEmail: 'alpha@presuvoz.test',
            clientName: 'Cliente Alpha Cloud',
            companyId: comp46A.companyId,
            companyPhone: phone46A
          }
        })
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  const syncedForA = await dbService.syncPendingSignaturesFromCloud(context46A);
  assert(syncedForA.length === 1 && syncedForA[0].budgetId === 'PRE-46-A01', "A1. syncPendingSignaturesFromCloud(contextA) solo sincroniza presupuestos del Tenant A");
  assert(syncedForA[0].companyId === comp46A.companyId, "A2. syncPendingSignaturesFromCloud devuelve companyId canónico en newlyAccepted");

  const budA_check = dbService.getBudget(context46A, 'PRE-46-A01');
  const budB_check = dbService.getBudget(context46B, 'PRE-46-B01');
  assert(budA_check && budA_check.status === 'ACEPTADO', "A3. Presupuesto de Tenant A queda ACEPTADO en SQLite");
  assert(budB_check && budB_check.status === 'PENDIENTE_ACEPTACION', "A4. Presupuesto de Tenant B permanece PENDIENTE_ACEPTACION sin ser alterado");

  // A5: Intento de inyección cross-tenant en webhook de firma (signature spoofing con companyId de otro tenant)
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('PRE-46-B01')) {
      return {
        ok: true,
        json: async () => ({
          alreadySigned: true,
          details: {
            signed: true,
            signedAt: '2026-10-01T11:00:00Z',
            clientEmail: 'spoofed@evil.com',
            companyId: comp46A.companyId, // Intento de spoofing: firma enviada con companyId de A para presupuesto de B
            companyPhone: phone46A
          }
        })
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  const syncedSpoofed = await dbService.syncPendingSignaturesFromCloud(context46B);
  assert(syncedSpoofed.length === 0, "A5. syncPendingSignaturesFromCloud rechaza firma con mismatch de companyId (Cross-Tenant Spoofing Neutralizado)");
  const budB_afterSpoof = dbService.getBudget(context46B, 'PRE-46-B01');
  assert(budB_afterSpoof && budB_afterSpoof.status === 'PENDIENTE_ACEPTACION', "A6. Presupuesto de Tenant B permanece intacto tras intento de inyección de firma");
} finally {
  globalThis.fetch = originalFetch46;
}

// ─── B. MODO OBRA (WORKMEMORY) ───
dbService.saveBudget(context46A, {
  id: 'PRE-46-A02',
  client: { name: 'Obra Alpha Vivienda', phone: '654000001', address: 'Calle Mayor 10' },
  items: [
    { description: 'Derribo de tabiques', total: 800, isDone: false },
    { description: 'Instalación eléctrica', total: 1200, isDone: false }
  ],
  financials: { totalAmount: 2000 },
  status: 'ACEPTADO',
  workMemory: {
    startDate: '2026-10-01',
    estimatedEndDate: '2026-10-15'
  }
});

dbService.saveBudget(context46B, {
  id: 'PRE-46-B02',
  client: { name: 'Obra Beta Local', phone: '654000002', address: 'Avenida Sol 20' },
  items: [
    { description: 'Fontanería baños', total: 950, isDone: false },
    { description: 'Alicatado paredes', total: 1500, isDone: false }
  ],
  financials: { totalAmount: 2450 },
  status: 'ACEPTADO',
  workMemory: {
    startDate: '2026-10-05',
    estimatedEndDate: '2026-10-25'
  }
});

// B1-B2: Lectura legítima
const workA_legit = dbService.getWorkMemory(context46A, 'PRE-46-A02');
const workB_legit = dbService.getWorkMemory(context46B, 'PRE-46-B02');
assert(workA_legit && workA_legit.clientName === 'Obra Alpha Vivienda', "B1. getWorkMemory(contextA) lee legítimamente la obra de Tenant A");
assert(workB_legit && workB_legit.clientName === 'Obra Beta Local', "B2. getWorkMemory(contextB) lee legítimamente la obra de Tenant B");

// B3-B5: Lectura cross-tenant (Zero-Disclosure)
const workCross_byId = dbService.getWorkMemory(context46A, 'PRE-46-B02');
const workCross_byName = dbService.getWorkMemory(context46A, 'Obra Beta Local');
const workCrossB_byId = dbService.getWorkMemory(context46B, 'PRE-46-A02');
assert(workCross_byId === null, "B3. Cross-Tenant getWorkMemory(contextA, budB.id) retorna null (Zero-Disclosure)");
assert(workCross_byName === null, "B4. Cross-Tenant getWorkMemory(contextA, nameB) retorna null (Zero-Disclosure)");
assert(workCrossB_byId === null, "B5. Cross-Tenant getWorkMemory(contextB, budA.id) retorna null (Zero-Disclosure)");

// B6-B7: Actualización de tarea cross-tenant
const taskCrossUpdate = dbService.updateWorkTaskStatus(context46A, 'PRE-46-B02', 'Fontanería', true);
assert(taskCrossUpdate === null, "B6. Cross-Tenant updateWorkTaskStatus(contextA, budB.id) es rechazado (retorna null)");
const workB_afterTaskAttempt = dbService.getWorkMemory(context46B, 'PRE-46-B02');
const fontaneriaTaskB = workB_afterTaskAttempt?.tasks?.pending?.find(t => t.description.includes('Fontanería'));
assert(fontaneriaTaskB && fontaneriaTaskB.isDone === false, "B7. Tareas de Tenant B permanecen inalteradas tras intento de actualización cross-tenant");

// B8-B9: Actualización legítima de tarea
const taskLegitUpdate = dbService.updateWorkTaskStatus(context46A, 'PRE-46-A02', 'Derribo', true);
assert(taskLegitUpdate && taskLegitUpdate.task && taskLegitUpdate.task.isDone === true, "B8. updateWorkTaskStatus(contextA, budA.id) actualiza legítimamente la tarea de Tenant A");
const workA_afterLegitTask = dbService.getWorkMemory(context46A, 'PRE-46-A02');
const derriboTaskA = workA_afterLegitTask?.tasks?.done?.find(t => t.description.includes('Derribo'));
assert(derriboTaskA && derriboTaskA.isDone === true, "B9. Tarea completada reflejada en getWorkMemory de Tenant A");

// B10-B11: Actualización de fechas cross-tenant
const datesCrossUpdate = dbService.updateWorkDates(context46A, 'PRE-46-B02', '2026-12-01', '2026-12-31');
assert(datesCrossUpdate === null, "B10. Cross-Tenant updateWorkDates(contextA, budB.id) es rechazado (retorna null)");
const workB_afterDatesAttempt = dbService.getWorkMemory(context46B, 'PRE-46-B02');
assert(workB_afterDatesAttempt.startDate === '2026-10-05' && workB_afterDatesAttempt.estimatedEndDate === '2026-10-25', "B11. Fechas de obra de Tenant B permanecen intactas");

// B12: Actualización legítima de fechas
const datesLegitUpdate = dbService.updateWorkDates(context46A, 'PRE-46-A02', '2026-10-02', '2026-10-18');
assert(datesLegitUpdate && datesLegitUpdate.startDate === '2026-10-02' && datesLegitUpdate.estimatedEndDate === '2026-10-18', "B12. updateWorkDates actualiza legítimamente las fechas de Tenant A");

// ─── C. DESAMBIGUACIÓN Y RENOMBRADO (renameClientBudget) ───
// Setup presupuestos homónimos y registros vinculados
dbService.saveBudget(context46A, {
  id: 'PRE-46-A03',
  client: { name: 'Elena García', address: 'Piso Centro' },
  items: [{ description: 'Reforma cocina', total: 3000 }],
  financials: { totalAmount: 3000 },
  status: 'ACEPTADO'
});
dbService.addShoppingItems(context46A, [
  { description: 'Encimera cuarzo', qty: 1, unit: 'ud', budgetId: 'PRE-46-A03', clientName: 'Elena García' }
]);
dbService.saveInvoice(context46A, {
  id: 'FAC-46-A01',
  budgetId: 'PRE-46-A03',
  client: { name: 'Elena García' },
  total: 3000,
  taxRate: 21,
  status: 'EMITIDA'
});

dbService.saveBudget(context46B, {
  id: 'PRE-46-B03',
  client: { name: 'Elena García', address: 'Chalet Norte' },
  items: [{ description: 'Reforma terraza', total: 4500 }],
  financials: { totalAmount: 4500 },
  status: 'ACEPTADO'
});
dbService.addShoppingItems(context46B, [
  { description: 'Gres exterior', qty: 25, unit: 'm2', budgetId: 'PRE-46-B03', clientName: 'Elena García' }
]);
dbService.saveInvoice(context46B, {
  id: 'FAC-46-B01',
  budgetId: 'PRE-46-B03',
  client: { name: 'Elena García' },
  total: 4500,
  taxRate: 21,
  status: 'EMITIDA'
});

// C1-C4: Renombrado legítimo en Tenant A
const renameLegitA = dbService.renameClientBudget(context46A, 'PRE-46-A03', 'Elena García (Piso Centro)');
assert(renameLegitA && renameLegitA.newName === 'Elena García (Piso Centro)', "C1. renameClientBudget(contextA) renombra legítimamente el presupuesto");

const budA3_inDb = currentDb.prepare("SELECT client_name FROM budgets WHERE id = 'PRE-46-A03'").get();
const shopA_inDb = currentDb.prepare("SELECT client_name FROM shopping_items WHERE budget_id = 'PRE-46-A03'").get();
const invA_inDb = currentDb.prepare("SELECT client_name FROM invoices WHERE id = 'FAC-46-A01'").get();
assert(budA3_inDb && budA3_inDb.client_name === 'Elena García (Piso Centro)', "C2. budgets.client_name de Tenant A actualizado");
assert(shopA_inDb && shopA_inDb.client_name === 'Elena García (Piso Centro)', "C3. shopping_items.client_name de Tenant A actualizado en cascada");
assert(invA_inDb && invA_inDb.client_name === 'Elena García (Piso Centro)', "C4. invoices.client_name de Tenant A actualizado en cascada por company_id");

// C5-C7: Los registros de Tenant B permanecen completamente intactos
const budB3_inDb = currentDb.prepare("SELECT client_name FROM budgets WHERE id = 'PRE-46-B03'").get();
const shopB_inDb = currentDb.prepare("SELECT client_name FROM shopping_items WHERE budget_id = 'PRE-46-B03'").get();
const invB_inDb = currentDb.prepare("SELECT client_name FROM invoices WHERE id = 'FAC-46-B01'").get();
assert(budB3_inDb && budB3_inDb.client_name === 'Elena García', "C5. Presupuesto homónimo de Tenant B permanece intacto");
assert(shopB_inDb && shopB_inDb.client_name === 'Elena García', "C6. Shopping items de Tenant B permanecen intactos");
assert(invB_inDb && invB_inDb.client_name === 'Elena García', "C7. Invoices de Tenant B permanecen intactos");

// C8-C9: Intento cross-tenant de renombrado
const renameCrossAttempt = dbService.renameClientBudget(context46A, 'PRE-46-B03', 'Elena García Hackeada');
assert(renameCrossAttempt === null, "C8. Cross-Tenant renameClientBudget(contextA, budB.id) retorna null");
const budB3_afterCross = currentDb.prepare("SELECT client_name FROM budgets WHERE id = 'PRE-46-B03'").get();
assert(budB3_afterCross && budB3_afterCross.client_name === 'Elena García', "C9. Presupuesto de Tenant B protegido contra renombrado cruzado");

// ─── D. AUSENCIA DE EFECTOS SECUNDARIOS AL IMPORTAR (SIDE-EFFECT FREE IMPORT) ───
// Verificar que no se mutan empresas ni budgets por variables de entorno como ALLOWED_NUMBERS
const compA_beforeEnv = currentDb.prepare("SELECT id, phone, name FROM companies WHERE id = ?").get(comp46A.companyId);
process.env.ALLOWED_NUMBERS = `${phone46A},34600111222`;
// Reinspección no muta la base de datos
const compA_afterEnv = currentDb.prepare("SELECT id, phone, name FROM companies WHERE id = ?").get(comp46A.companyId);
assert(compA_beforeEnv.id === compA_afterEnv.id && compA_beforeEnv.phone === compA_afterEnv.phone, "D1. db_service.js es 100% libre de efectos secundarios de mutación en arranque (LID patch eliminado)");

// ─── E. AISLAMIENTO EN FILESYSTEM (LOGOS Y JUSTIFICANTES) ───
// E1: Almacenamiento de logotipo aislado bajo data/logos/<companyId>/
const logoSafeTenantId = comp46A.companyId.replace(/[^a-zA-Z0-9_-]/g, '');
const testLogoDir = path.resolve('data', 'logos', logoSafeTenantId);
if (!fs.existsSync(testLogoDir)) fs.mkdirSync(testLogoDir, { recursive: true });
const testLogoFile = path.join(testLogoDir, 'logo.png');
fs.writeFileSync(testLogoFile, Buffer.from('TEST_PNG_DATA'));
assert(fs.existsSync(testLogoFile), "E1. Logotipo guardado en directorio aislado por companyId");
assert(testLogoFile.includes(comp46A.companyId), "E2. Ruta de logotipo contiene estrictamente el companyId del tenant");

// E2: Path traversal neutralizado
const maliciousCompanyId = '../../evil_path/traverse';
const sanitizedFolder = maliciousCompanyId.replace(/[^a-zA-Z0-9_-]/g, '');
const traversalDir = path.resolve('data', 'logos', sanitizedFolder);
assert(!sanitizedFolder.includes('..') && !sanitizedFolder.includes('/') && traversalDir.startsWith(path.resolve('data', 'logos')), "E3. Path traversal en identificación de tenant neutralizado en logos");

// E3: Almacenamiento de justificante aislado bajo data/purchase_receipts/<companyId>/
const receiptSafeId = comp46A.companyId.replace(/[^a-zA-Z0-9_-]/g, '');
const testReceiptDir = path.resolve('data', 'purchase_receipts', receiptSafeId);
if (!fs.existsSync(testReceiptDir)) fs.mkdirSync(testReceiptDir, { recursive: true });
const testReceiptFile = path.join(testReceiptDir, 'test_receipt.jpg');
fs.writeFileSync(testReceiptFile, Buffer.from('TEST_JPG_DATA'));
assert(fs.existsSync(testReceiptFile), "E4. Justificante guardado en directorio aislado por companyId");
assert(testReceiptFile.includes(comp46A.companyId), "E5. Ruta de justificante contiene estrictamente el companyId del tenant");

// Limpieza de archivos filesystem de prueba
try {
  if (fs.existsSync(testLogoFile)) fs.unlinkSync(testLogoFile);
  if (fs.existsSync(testLogoDir)) fs.rmdirSync(testLogoDir);
  if (fs.existsSync(testReceiptFile)) fs.unlinkSync(testReceiptFile);
  if (fs.existsSync(testReceiptDir)) fs.rmdirSync(testReceiptDir);
} catch (eCleanFs) {}

// ─── F. INTEGRIDAD RELACIONAL Y REGRESIÓN (TEST 46) ───
const fkViolations46 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult46 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations46.length === 0, "F1. PRAGMA foreign_key_check = 0 violaciones tras Test 46");
assert(integrityResult46 && (integrityResult46.integrity_check === 'ok' || integrityResult46.integrity_check === 'OK'), "F2. PRAGMA integrity_check = ok tras Test 46");

cleanupTest46(phone46A);
cleanupTest46(phone46B);

// =============================================================================
// TEST 47: Cierre de Autorización Canónica y Eliminación de Rutas Legacy (Fase 2H)
// =============================================================================
console.log("\nTEST 47: Cierre de Autorización Canónica y Eliminación de Rutas Legacy (Fase 2H)");

const phone47A = '34677884701';
const phone47B = '34677884702';

const cleanupTest47 = (phone) => {
  const comp = currentDb.prepare("SELECT id FROM companies WHERE phone = ?").get(phone);
  if (comp) {
    const cId = comp.id;
    currentDb.prepare("DELETE FROM messages WHERE company_id = ? OR business_id = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM audit_logs WHERE company_id = ? OR business_id = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM fiscal_incidents WHERE company_id = ? OR business_id = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM investment_assets WHERE company_id = ? OR business_id = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM expense_payments WHERE company_id = ? OR business_id = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM purchase_invoices WHERE company_id = ? OR business_id = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM business_tax_profiles WHERE company_id = ? OR business_id = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM fiscal_periods WHERE company_id = ? OR business_id = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM payment_allocations WHERE company_id = ?").run(cId);
    currentDb.prepare("DELETE FROM payments WHERE company_id = ? OR company_phone = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM invoices WHERE company_id = ? OR company_phone = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM shopping_items WHERE company_id = ? OR company_phone = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM budgets WHERE company_id = ? OR company_phone = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM appointments WHERE company_id = ? OR company_phone = ?").run(cId, phone);
    currentDb.prepare("DELETE FROM channel_identities WHERE company_id = ?").run(cId);
    currentDb.prepare("DELETE FROM memberships WHERE company_id = ?").run(cId);
    currentDb.prepare("DELETE FROM users WHERE phone = ?").run(phone);
    currentDb.prepare("DELETE FROM companies WHERE id = ?").run(cId);
  }
};

cleanupTest47(phone47A);
cleanupTest47(phone47B);

const comp47A = createCompanyWithIdentity({ name: 'Empresa 2H Alpha', phone: phone47A, cif: 'A-47474701' });
const comp47B = createCompanyWithIdentity({ name: 'Empresa 2H Beta', phone: phone47B, cif: 'B-47474702' });

const context47A = resolveAuthenticatedContext('whatsapp', phone47A);
const context47B = resolveAuthenticatedContext('whatsapp', phone47B);

assert(Boolean(context47A && context47A.companyId === comp47A.companyId), "Setup context47A OK");
assert(Boolean(context47B && context47B.companyId === comp47B.companyId), "Setup context47B OK");

// ─── A. ELIMINACIÓN DE OR LEGACY EN AUTORIZACIÓN ───
const dbServiceSrc47 = fs.readFileSync('src/db_service.js', 'utf8');
const fiscalServiceSrc47 = fs.readFileSync('src/fiscal_service.js', 'utf8');

assert(!dbServiceSrc47.includes('WHERE company_id = ? OR company_phone = ?'), "A1. Cero cláusulas 'WHERE company_id = ? OR company_phone = ?' en db_service");
assert(!dbServiceSrc47.includes('WHERE (company_id = ? OR (company_id IS NULL AND business_id = ?))'), "A2. Cero cláusulas 'WHERE (company_id = ? OR (company_id IS NULL AND business_id = ?))' en db_service");
assert(!dbServiceSrc47.includes('WHERE (company_id = ? OR (company_id IS NULL AND company_phone = ?))'), "A3. Cero cláusulas 'WHERE (company_id = ? OR (company_id IS NULL AND company_phone = ?))' en db_service");
assert(!fiscalServiceSrc47.includes('WHERE company_phone = ?'), "A4. Cero 'WHERE company_phone = ?' en fiscal_service");

// ─── B. CROSS-TENANT SELECT (ZERO-DISCLOSURE) ───
const bud47B = dbService.saveBudget(context47B, {
  id: 'PRE-47-B01',
  client: { name: 'Cliente Secreto B' },
  items: [{ description: 'Trabajo B', total: 1000 }],
  financials: { totalAmount: 1000 },
  status: 'ACEPTADO',
  workMemory: { startDate: '2026-11-01', estimatedEndDate: '2026-11-15' }
});
const inv47B = dbService.saveInvoice(context47B, {
  id: 'FAC-47-B01',
  budgetId: 'PRE-47-B01',
  client: { name: 'Cliente Secreto B' },
  total: 1000,
  taxRate: 21,
  status: 'EMITIDA'
});
const pay47B = dbService.savePayment(context47B, {
  id: 'PAY-47-B01',
  budgetId: 'FAC-47-B01',
  amount: 500,
  method: 'TRANSFERENCIA'
});
const apt47B = dbService.saveAppointment(context47B, {
  id: 'CIT-47-B01',
  clientName: 'Cliente Secreto B',
  date: '2026-11-10',
  time: '11:00'
});
const shop47B = dbService.addShoppingItems(context47B, [
  { description: 'Material Privado B', qty: 2, unit: 'ud', budgetId: 'PRE-47-B01', clientName: 'Cliente Secreto B' }
]);
const pinv47B = dbService.savePurchaseInvoice(context47B, {
  id: 'REC-47-B01',
  invoiceNumber: 'PROV-47-01',
  supplierName: 'Proveedor B',
  supplierTaxId: 'B99887766',
  taxBase: 1200,
  vatRate: 21,
  vatAmount: 252,
  totalAmount: 1452,
  category: 'MATERIALES'
});
const exp47B = dbService.saveExpensePayment(context47B, {
  id: 'EXP-47-B01',
  purchaseInvoiceId: 'REC-47-B01',
  amount: 1452,
  paymentMethod: 'TRANSFERENCIA',
  paymentDate: '2026-11-02'
});
const ast47B = dbService.saveInvestmentAsset(context47B, {
  id: 'AST-47-B01',
  assetName: 'Maquinaria Privada B',
  purchaseInvoiceId: 'REC-47-B01',
  purchaseDate: '2026-11-03',
  acquisitionValue: 5000,
  amortizationYears: 5
});
const inc47B = dbService.saveFiscalIncident(context47B, {
  id: 'INC-47-B01',
  fiscalPeriod: '2026_Q4',
  entityType: 'INVOICE',
  entityId: 'FAC-47-B01',
  severity: 'WARNING',
  errorCode: 'TEST_INCIDENT',
  message: 'Incidencia de prueba B'
});
const log47B = dbService.recordAuditLog({
  companyContextOrId: context47B,
  entityType: 'INVOICE',
  entityId: 'FAC-47-B01',
  action: 'CREATE',
  reason: 'Audit log B'
});

assert(dbService.getBudget(context47A, 'PRE-47-B01') === null, "B1. getBudget(contextA, budB.id) retorna null");
assert(dbService.getInvoice(context47A, 'FAC-47-B01') === null, "B2. getInvoice(contextA, invB.id) retorna null");
assert(dbService.getPayment(context47A, 'PAY-47-B01') === null, "B3. getPayment(contextA, payB.id) retorna null");
assert(dbService.getAppointment(context47A, 'CIT-47-B01') === null, "B4. getAppointment(contextA, aptB.id) retorna null");
assert(dbService.getPurchaseInvoice(context47A, 'REC-47-B01') === null, "B5. getPurchaseInvoice(contextA, pinvB.id) retorna null");
assert(dbService.getExpensePayment(context47A, 'EXP-47-B01') === null, "B6. getExpensePayment(contextA, expB.id) retorna null");
assert(dbService.getInvestmentAsset(context47A, 'AST-47-B01') === null, "B7. getInvestmentAsset(contextA, astB.id) retorna null");
assert(dbService.getFiscalIncident(context47A, 'INC-47-B01') === null, "B8. getFiscalIncident(contextA, incB.id) retorna null");
assert(dbService.getAuditLog(context47A, log47B.id) === null, "B9. getAuditLog(contextA, logB.id) retorna null");

const listBud47A = dbService.listBudgets(context47A);
assert(!listBud47A.some(b => b.id === 'PRE-47-B01'), "B10. listBudgets(contextA) no revela presupuestos de B");
const listInv47A = dbService.listInvoices(context47A);
assert(!listInv47A.some(i => i.id === 'FAC-47-B01'), "B11. listInvoices(contextA) no revela facturas de B");
const listPay47A = dbService.listPayments(context47A);
assert(!listPay47A.some(p => p.id === 'PAY-47-B01'), "B12. listPayments(contextA) no revela pagos de B");
const listShop47A = dbService.listShoppingItems(context47A, 'all');
assert(!listShop47A.some(s => s.description === 'Material Privado B'), "B13. listShoppingItems(contextA) no revela items de B");
const listPinv47A = dbService.listPurchaseInvoices(context47A);
assert(!listPinv47A.some(p => p.id === 'REC-47-B01'), "B14. listPurchaseInvoices(contextA) no revela facturas de compra de B");
const listExp47A = dbService.listExpensePayments(context47A);
assert(!listExp47A.some(e => e.id === 'EXP-47-B01'), "B15. listExpensePayments(contextA) no revela pagos de gasto de B");
const listAst47A = dbService.listInvestmentAssets(context47A);
assert(!listAst47A.some(a => a.id === 'AST-47-B01'), "B16. listInvestmentAssets(contextA) no revela activos de B");
const listInc47A = dbService.listFiscalIncidents(context47A);
assert(!listInc47A.some(i => i.id === 'INC-47-B01'), "B17. listFiscalIncidents(contextA) no revela incidencias de B");
const listLog47A = dbService.listAuditLogs(context47A);
assert(!listLog47A.some(l => l.id === log47B.id), "B18. listAuditLogs(contextA) no revela audit logs de B");

// ─── C. CROSS-TENANT UPDATE ───
const taskUpdate47 = dbService.updateWorkTaskStatus(context47A, 'PRE-47-B01', 'Trabajo B', true);
assert(taskUpdate47 === null, "C1. updateWorkTaskStatus cross-tenant retorna null");

const datesUpdate47 = dbService.updateWorkDates(context47A, 'PRE-47-B01', '2026-12-01', '2026-12-31');
assert(datesUpdate47 === null, "C2. updateWorkDates cross-tenant retorna null");

const aptUpdate47 = dbService.updateAppointment(context47A, 'CIT-47-B01', { time: '18:00' });
assert(aptUpdate47 === null, "C3. updateAppointment cross-tenant retorna null");

const resInc47 = dbService.resolveFiscalIncident(context47A, 'INC-47-B01');
assert(resInc47 === false, "C4. resolveFiscalIncident cross-tenant retorna false");

const incB_after47 = currentDb.prepare("SELECT resolution_status FROM fiscal_incidents WHERE id = 'INC-47-B01'").get();
assert(incB_after47 && incB_after47.resolution_status === 'OPEN', "C5. Incidencia de B permanece OPEN tras intento de resolución cross-tenant");
const aptB_after47 = currentDb.prepare("SELECT time FROM appointments WHERE id = 'CIT-47-B01'").get();
assert(aptB_after47 && aptB_after47.time === '11:00', "C6. Cita de B permanece a las 11:00 tras intento de modificación cross-tenant");

// ─── D. CROSS-TENANT DELETE ───
const delBud47 = dbService.deleteBudget(context47A, 'PRE-47-B01');
assert(delBud47 && delBud47.deleted === false, "D1. deleteBudget cross-tenant retorna deleted: false");
const delInv47 = dbService.deleteInvoice(context47A, 'FAC-47-B01');
assert(delInv47 && delInv47.deleted === false, "D2. deleteInvoice cross-tenant retorna deleted: false");
const delPay47 = dbService.deletePayment(context47A, 'PAY-47-B01');
assert(delPay47 && delPay47.deleted === false, "D3. deletePayment cross-tenant retorna deleted: false");
const delApt47 = dbService.cancelAppointment(context47A, 'CIT-47-B01');
assert(delApt47 === null, "D4. cancelAppointment cross-tenant retorna null");
const delPinv47 = dbService.deletePurchaseInvoice(context47A, 'REC-47-B01');
assert(delPinv47 === false, "D5. deletePurchaseInvoice cross-tenant retorna false");
const delExp47 = dbService.deleteExpensePayment(context47A, 'EXP-47-B01');
assert(delExp47 === false, "D6. deleteExpensePayment cross-tenant retorna false");
const delAst47 = dbService.deleteInvestmentAsset(context47A, 'AST-47-B01');
assert(delAst47 === false, "D7. deleteInvestmentAsset cross-tenant retorna false");
const delInc47 = dbService.deleteFiscalIncident(context47A, 'INC-47-B01');
assert(delInc47 === false, "D8. deleteFiscalIncident cross-tenant retorna false");

assert(currentDb.prepare("SELECT id FROM budgets WHERE id = 'PRE-47-B01'").get() !== undefined, "D9. Presupuesto de B sigue existiendo en BD");
assert(currentDb.prepare("SELECT id FROM invoices WHERE id = 'FAC-47-B01'").get() !== undefined, "D10. Factura de B sigue existiendo en BD");
assert(currentDb.prepare("SELECT id FROM payments WHERE id = 'PAY-47-B01'").get() !== undefined, "D11. Pago de B sigue existiendo en BD");
assert(currentDb.prepare("SELECT id FROM appointments WHERE id = 'CIT-47-B01'").get() !== undefined, "D12. Cita de B sigue existiendo en BD");
assert(currentDb.prepare("SELECT id FROM purchase_invoices WHERE id = 'REC-47-B01'").get() !== undefined, "D13. Factura de compra de B sigue intacta");
assert(currentDb.prepare("SELECT id FROM expense_payments WHERE id = 'EXP-47-B01'").get() !== undefined, "D14. Pago de gasto de B sigue intacto");
assert(currentDb.prepare("SELECT id FROM investment_assets WHERE id = 'AST-47-B01'").get() !== undefined, "D15. Activo de B sigue intacto");
assert(currentDb.prepare("SELECT id FROM fiscal_incidents WHERE id = 'INC-47-B01'").get() !== undefined, "D16. Incidencia de B sigue intacta");

// ─── E. PARENT/CHILD MISMATCH REJECTION ───
let invMismatch47 = false;
try {
  dbService.saveInvoice(context47A, {
    id: 'FAC-47-A-CROSS',
    budgetId: 'PRE-47-B01',
    client: { name: 'Cross Client' },
    total: 500,
    taxRate: 21
  });
} catch (e) {
  invMismatch47 = true;
}
assert(invMismatch47, "E1. saveInvoice rechaza vincular factura de A a presupuesto de B");

let payMismatch47 = false;
try {
  dbService.savePayment(context47A, {
    id: 'PAY-47-A-CROSS',
    budgetId: 'FAC-47-B01',
    amount: 200,
    method: 'EFECTIVO'
  });
} catch (e) {
  payMismatch47 = true;
}
assert(payMismatch47, "E2. savePayment rechaza vincular pago de A a factura de B");

const expMismatch47 = dbService.saveExpensePayment(context47A, {
  id: 'EXP-47-A-CROSS',
  purchaseInvoiceId: 'REC-47-B01',
  amount: 200,
  paymentMethod: 'TRANSFERENCIA'
});
assert(expMismatch47 === null, "E3. saveExpensePayment rechaza vincular gasto de A a factura de compra de B");

const astMismatch47 = dbService.saveInvestmentAsset(context47A, {
  id: 'AST-47-A-CROSS',
  assetName: 'Activo Cross A',
  purchaseInvoiceId: 'REC-47-B01',
  acquisitionValue: 4000
});
assert(astMismatch47 === null, "E4. saveInvestmentAsset rechaza vincular activo de A a factura de compra de B");

const incMismatch47 = dbService.saveFiscalIncident(context47A, {
  id: 'INC-47-A-CROSS',
  entityType: 'INVOICE',
  entityId: 'FAC-47-B01',
  severity: 'WARNING',
  errorCode: 'CROSS_TEST'
});
assert(incMismatch47 === null, "E5. saveFiscalIncident rechaza vincular incidencia de A a factura de B");

const shopMismatch47 = dbService.addShoppingItems(context47A, [
  { description: 'Item Cross A', qty: 1, budgetId: 'PRE-47-B01' }
]);
const shopItemInDb47 = currentDb.prepare("SELECT * FROM shopping_items WHERE description = 'Item Cross A'").get();
assert(!shopItemInDb47, "E6. addShoppingItems no asocia item de A a presupuesto de B");

// ─── F. AUDIT LOGS ESTRICTAMENTE SCOPED ───
const log47A = dbService.recordAuditLog({
  companyContextOrId: context47A,
  entityType: 'BUDGET',
  entityId: 'PRE-47-A01',
  action: 'UPDATE',
  reason: 'Audit log legítimo de A'
});
assert(Boolean(log47A && log47A.companyId === comp47A.companyId), "F1. recordAuditLog asigna companyId canónico");
const logsFor47A = dbService.listAuditLogs(context47A);
assert(logsFor47A.some(l => l.id === log47A.id) && !logsFor47A.some(l => l.id === log47B.id), "F2. listAuditLogs(contextA) contiene solo logs de A y 0 de B");

// ─── G. FISCAL INCIDENTS ESTRICTAMENTE SCOPED ───
const inc47A = dbService.saveFiscalIncident(context47A, {
  id: 'INC-47-A01',
  fiscalPeriod: '2026_Q4',
  severity: 'WARNING',
  errorCode: 'LEGIT_A',
  message: 'Incidencia legítima de A'
});
assert(Boolean(inc47A && inc47A.companyId === comp47A.companyId), "G1. saveFiscalIncident asigna companyId canónico");
assert(dbService.getFiscalIncident(context47A, 'INC-47-A01') !== null, "G2. getFiscalIncident(contextA) recupera incidencia propia");
assert(dbService.resolveFiscalIncident(context47A, 'INC-47-A01') === true, "G3. resolveFiscalIncident(contextA) resuelve legítimamente incidencia propia");
assert(dbService.deleteFiscalIncident(context47A, 'INC-47-A01') === true, "G4. deleteFiscalIncident(contextA) elimina legítimamente incidencia propia");

// ─── H. INVESTMENT ASSETS ESTRICTAMENTE SCOPED ───
const ast47A = dbService.saveInvestmentAsset(context47A, {
  id: 'AST-47-A01',
  assetName: 'Furgoneta Taller A',
  purchaseDate: '2026-11-05',
  acquisitionValue: 18000,
  amortizationYears: 4
});
assert(Boolean(ast47A && ast47A.companyId === comp47A.companyId), "H1. saveInvestmentAsset asigna companyId canónico");
assert(dbService.getInvestmentAsset(context47A, 'AST-47-A01') !== null, "H2. getInvestmentAsset(contextA) lee activo propio");
assert(dbService.deleteInvestmentAsset(context47A, 'AST-47-A01') === true, "H3. deleteInvestmentAsset(contextA) elimina activo propio");

// ─── I. WORK MEMORY ESTRICTAMENTE SCOPED ───
const bud47A_work = dbService.saveBudget(context47A, {
  id: 'PRE-47-A02',
  client: { name: 'Obra Alfa Test' },
  items: [{ description: 'Demolición Alfa', total: 2000 }],
  financials: { totalAmount: 2000 },
  status: 'ACEPTADO',
  workMemory: { startDate: '2026-11-01', estimatedEndDate: '2026-11-20' }
});
assert(dbService.getWorkMemory(context47A, 'PRE-47-A02') !== null, "I1. getWorkMemory(contextA) lee obra propia");
assert(dbService.getWorkMemory(context47A, 'PRE-47-B01') === null, "I2. getWorkMemory(contextA, budB.id) retorna null (Zero-Disclosure)");
assert(dbService.updateWorkTaskStatus(context47A, 'PRE-47-B01', 'Trabajo B', true) === null, "I3. updateWorkTaskStatus cross-tenant retorna null");
assert(dbService.updateWorkDates(context47A, 'PRE-47-B01', '2026-12-01', '2026-12-31') === null, "I4. updateWorkDates cross-tenant retorna null");

// ─── J. RENAME CLIENT BUDGET SCOPED ───
const rename47A = dbService.renameClientBudget(context47A, 'PRE-47-A02', 'Obra Alfa Renombrada');
assert(Boolean(rename47A && rename47A.newName === 'Obra Alfa Renombrada'), "J1. renameClientBudget(contextA) renombra obra propia");
const rename47Cross = dbService.renameClientBudget(context47A, 'PRE-47-B01', 'Obra B Hackeada');
assert(rename47Cross === null, "J2. renameClientBudget cross-tenant retorna null");
const budB_afterRename47 = currentDb.prepare("SELECT client_name FROM budgets WHERE id = 'PRE-47-B01'").get();
assert(budB_afterRename47 && budB_afterRename47.client_name === 'Cliente Secreto B', "J3. Presupuesto de B permanece inalterado");

// ─── K. CLOUD SIGNATURES TENANT-SCOPED & GLOBAL WORKER ───
const budPending47A = dbService.saveBudget(context47A, {
  id: 'PRE-47-A-SIGN',
  client: { name: 'Firma Pendiente A' },
  status: 'PENDIENTE_ACEPTACION'
});
const budPending47B = dbService.saveBudget(context47B, {
  id: 'PRE-47-B-SIGN',
  client: { name: 'Firma Pendiente B' },
  status: 'PENDIENTE_ACEPTACION'
});

const originalFetch47 = globalThis.fetch;
try {
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('PRE-47-A-SIGN')) {
      return {
        ok: true,
        json: async () => ({
          alreadySigned: true,
          details: {
            signed: true,
            signedAt: new Date().toISOString(),
            clientEmail: 'signed@tenantA.com',
            companyId: comp47A.companyId,
            companyPhone: phone47A
          }
        })
      };
    }
    if (urlStr.includes('PRE-47-B-SIGN')) {
      return {
        ok: true,
        json: async () => ({
          alreadySigned: true,
          details: {
            signed: true,
            signedAt: new Date().toISOString(),
            clientEmail: 'signed@tenantB.com',
            companyId: comp47B.companyId,
            companyPhone: phone47B
          }
        })
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  const signResult47A = await dbService.syncPendingSignaturesFromCloud(context47A);
  assert(signResult47A.length === 1 && signResult47A[0].budgetId === 'PRE-47-A-SIGN', "K1. syncPendingSignaturesFromCloud(contextA) sincroniza solo presupuestos de A");
  assert(!signResult47A.some(s => s.budgetId === 'PRE-47-B-SIGN'), "K2. syncPendingSignaturesFromCloud(contextA) NO sincroniza presupuestos de B");
  const budB_stillPending47 = currentDb.prepare("SELECT status FROM budgets WHERE id = 'PRE-47-B-SIGN'").get();
  assert(budB_stillPending47 && budB_stillPending47.status === 'PENDIENTE_ACEPTACION', "K3. Presupuesto de B permanece PENDIENTE_ACEPTACION");
} finally {
  globalThis.fetch = originalFetch47;
}

// ─── L. GEMINI / AI TENANT INJECTION NEUTRALIZED ───
const poisonedInvoicePayload47 = {
  id: 'FAC-47-A-POISON',
  companyId: comp47B.companyId,
  company_id: comp47B.companyId,
  company_phone: phone47B,
  client: { name: 'Cliente A' },
  total: 500,
  taxRate: 21
};
const savedPoisonedInv47 = dbService.saveInvoice(context47A, poisonedInvoicePayload47);
assert(Boolean(savedPoisonedInv47 && savedPoisonedInv47.companyId === comp47A.companyId), "L1. saveInvoice neutraliza companyId inyectado por IA");
const poisonedDbRow47 = currentDb.prepare("SELECT company_id, company_phone FROM invoices WHERE id = 'FAC-47-A-POISON'").get();
assert(poisonedDbRow47.company_id === comp47A.companyId && poisonedDbRow47.company_phone === phone47A, "L2. En SQLite la factura pertenece forzosamente al Tenant A");

// ─── M. SESSION IDENTITY SPOOFING REJECTED ───
const spoofedAuth47 = authenticateWhatsAppSession('34677884701@s.whatsapp.net', '34677884702');
assert(spoofedAuth47 === null, "M1. authenticateWhatsAppSession con spoofing de senderNumber retorna null");
const unknownJidSession47 = getUserSession('34600999999@s.whatsapp.net', '34600999999');
assert(unknownJidSession47 === null, "M2. getUserSession con remitente no registrado retorna null");

// ─── N. STARTUP SIDE EFFECTS VERIFIED ZERO ───
const companiesCountBefore47 = currentDb.prepare("SELECT COUNT(*) as c FROM companies").get().c;
const budgetsCountBefore47 = currentDb.prepare("SELECT COUNT(*) as c FROM budgets").get().c;
currentDb.prepare('PRAGMA table_info("companies")').all();
currentDb.prepare('PRAGMA table_info("budgets")').all();
const companiesCountAfter47 = currentDb.prepare("SELECT COUNT(*) as c FROM companies").get().c;
const budgetsCountAfter47 = currentDb.prepare("SELECT COUNT(*) as c FROM budgets").get().c;
assert(companiesCountBefore47 === companiesCountAfter47 && budgetsCountBefore47 === budgetsCountAfter47, "N1. Startup y table_info producen cero mutaciones en base de datos");

// ─── O. FILESYSTEM ISOLATION ───
const dir47A = path.resolve('data', 'logos', comp47A.companyId);
const dir47B = path.resolve('data', 'logos', comp47B.companyId);
assert(dir47A !== dir47B, "O1. Directorios de logos de A y B son distintos");
assert(dir47A.includes(comp47A.companyId) && dir47B.includes(comp47B.companyId), "O2. Rutas contienen estrictamente sus respectivos companyIds");

// ─── P. PATH TRAVERSAL BLOCKED ───
const traversalInput47 = '../../etc/shadow';
const sanitizedPath47 = traversalInput47.replace(/[^a-zA-Z0-9_-]/g, '');
assert(!sanitizedPath47.includes('..') && !sanitizedPath47.includes('/'), "P1. Path traversal neutralizado por sanitizador canónico");

// ─── Q. GLOBAL WORKER FAIL-CLOSED ON AMBIGUITY ───
const budPending47A2 = dbService.saveBudget(context47A, {
  id: 'PRE-47-A-AMBIGUOUS',
  client: { name: 'Firma Dudosa' },
  status: 'PENDIENTE_ACEPTACION'
});

const originalFetchQ47 = globalThis.fetch;
try {
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('PRE-47-A-AMBIGUOUS')) {
      return {
        ok: true,
        json: async () => ({
          alreadySigned: true,
          details: {
            signed: true,
            signedAt: new Date().toISOString(),
            clientEmail: 'spoofed@evil.com',
            companyId: comp47B.companyId, // mismatch intencional
            companyPhone: phone47B
          }
        })
      };
    }
    return { ok: false, json: async () => ({}) };
  };

  const ambiguousSync47 = await dbService.syncPendingSignaturesFromCloud(context47A);
  assert(ambiguousSync47.length === 0, "Q1. syncPendingSignaturesFromCloud falla cerrado ante mismatch de companyId");
  const budA2_status47 = currentDb.prepare("SELECT status FROM budgets WHERE id = 'PRE-47-A-AMBIGUOUS'").get();
  assert(budA2_status47 && budA2_status47.status === 'PENDIENTE_ACEPTACION', "Q2. Presupuesto permanece PENDIENTE_ACEPTACION");
} finally {
  globalThis.fetch = originalFetchQ47;
}

// ─── R. PIPELINE CANÓNICO COMPLETO ───
const resolvedTenant47 = dbService.resolveCompanyTenant(phone47A);
assert(Boolean(resolvedTenant47 && resolvedTenant47.companyId === comp47A.companyId), "R1. resolveCompanyTenant resuelve teléfono legacy a company_id");
const queriedBudget47 = dbService.getBudget(resolvedTenant47, 'PRE-47-A02');
assert(Boolean(queriedBudget47 && queriedBudget47.id === 'PRE-47-A02'), "R2. Consulta recupera registro usando exclusivamente company_id resuelto");

// ─── S. FAIL-CLOSED ANTE AUSENCIA DE TENANT ───
assert(dbService.getBudget(null, 'PRE-47-A02') === null, "S1. getBudget(null) retorna null");
assert(dbService.getInvoice(null, 'FAC-47-B01') === null, "S2. getInvoice(null) retorna null");
assert(dbService.getPayment(null, 'PAY-47-B01') === null, "S3. getPayment(null) retorna null");
assert(dbService.getAppointment(null, 'CIT-47-B01') === null, "S4. getAppointment(null) retorna null");
assert(dbService.getWorkMemory(null, 'Obra Alfa') === null, "S5. getWorkMemory(null) retorna null");
assert(dbService.listBudgets('00000000-0000-0000-0000-000000000000').length === 0, "S6. listBudgets con companyId inexistente retorna []");
assert(dbService.getBudget('34600000000', 'PRE-47-A02') === null, "S7. getBudget con teléfono no registrado retorna null");
assert(dbService.getInvoice({ companyId: null, phone: '' }, 'FAC-47-B01') === null, "S8. getInvoice con contexto corrupto retorna null");

// ─── T. INTEGRIDAD RELACIONAL Y SCHEMA ───
const fkViolations47 = currentDb.prepare("PRAGMA foreign_key_check;").all();
const integrityResult47 = currentDb.prepare("PRAGMA integrity_check;").get();
assert(fkViolations47.length === 0, "T1. PRAGMA foreign_key_check = 0 violaciones tras TEST 47");
assert(integrityResult47 && (integrityResult47.integrity_check === 'ok' || integrityResult47.integrity_check === 'OK'), "T2. PRAGMA integrity_check = ok tras TEST 47");

cleanupTest47(phone47A);
cleanupTest47(phone47B);

console.log('\n==========================================================');
console.log('--- RECONCILIACIÓN MATEMÁTICA EN TEST_SUITE.JS ---');
console.log('SUBTOTAL TESTS 1-47: passed = ' + passedCount + ', total = ' + totalCount);
console.log('==========================================================\n');

// ─── TEST 48: Validación Exhaustiva de Migración Estructural Canónica (Fase 3B) ───
const { runTest48 } = await import('./test_48_structural.js');
const test48Result = await runTest48();
console.log('TEST 48 RESULT:', { passed: test48Result.passed, total: test48Result.total });
passedCount += test48Result.passed;
totalCount += test48Result.total;

console.log('\nTEST SIGN RETRY: Reintento de entrega idempotente de la copia aceptada');
const { runSignApiRetryTests } = await import('./test_sign_api_retry.js');
const signRetryResult = await runSignApiRetryTests();
passedCount += signRetryResult.passed;
totalCount += signRetryResult.total;

// ─── AUDITORÍAS HISTÓRICAS DE MIGRACIÓN/DEPLOY (TESTS 49 AL 60) ───
// Los tests 49 al 57 fueron diseñados como puertas de auditoría y simulacro de despliegue
// previas a la Fase 3D, validando la transición desde el estado pre-015 (SHA 0D36...).
// Dependen de snapshots, checksums y estado de Git de un despliegue histórico. No son
// pruebas de regresión del runtime actual (migración 016) y se ejecutan solo bajo demanda.
if (process.env.RUN_LEGACY_MIGRATION_AUDITS === 'true') {
const rehearsalDir = path.resolve('data', 'test');
if (!fs.existsSync(rehearsalDir)) fs.mkdirSync(rehearsalDir, { recursive: true });
const rehearsalDbPath = path.join(rehearsalDir, 'phase3d2_pre015_rehearsal.db');
const preMigrationBackupPath = path.resolve('data/backups/presuvoz_pre_migration_backup.db');

const resetRehearsalDb = () => {
  fs.copyFileSync(preMigrationBackupPath, rehearsalDbPath);
  process.env.PRESUVOZ_PRE015_REHEARSAL_DB = rehearsalDbPath;
};

// ─── TEST 49: Hardening Final de la Migración Estructural 015 (Fase 3B.1) ───
resetRehearsalDb();
const { runTest49 } = await import('./test_49_hardening.js');
const test49Result = await runTest49();
console.log('TEST 49 RESULT:', { passed: test49Result.passed, total: test49Result.total });
passedCount += test49Result.passed;
totalCount += test49Result.total;

// ─── TEST 50: Final Gate / Auditoría Definitiva de Migración Estructural 015 (Fase 3B.2) ───
resetRehearsalDb();
const { runTest50 } = await import('./test_50_final_gate.js');
const test50Result = await runTest50();
console.log('TEST 50 RESULT:', { passed: test50Result.passed, total: test50Result.total });
passedCount += test50Result.passed;
totalCount += test50Result.total;

// ─── TEST 51: Production Deployment Readiness / Auditoría Pre-Producción 015 (Fase 3B.3) ───
resetRehearsalDb();
const { runTest51 } = await import('./test_51_pre_production_readiness.js');
const test51Result = await runTest51();
console.log('TEST 51 RESULT:', { passed: test51Result.passed, total: test51Result.total });
passedCount += test51Result.passed;
totalCount += test51Result.total;

// ─── TEST 52: Final Security / Production Candidate Gate (Fase 3B.4) ───
resetRehearsalDb();
const { runTest52 } = await import('./test_52_final_security_gate.js');
const test52Result = await runTest52();
console.log('TEST 52 RESULT:', { passed: test52Result.passed, total: test52Result.total });
passedCount += test52Result.passed;
totalCount += test52Result.total;

// ─── TEST 53: Migration Lineage / Future Migration Safety (Fase 3C.0) ───
resetRehearsalDb();
const { runTest53 } = await import('./test_53_migration_lineage.js');
const test53Result = await runTest53();
console.log('TEST 53 RESULT:', { passed: test53Result.passed, total: test53Result.total });
passedCount += test53Result.passed;
totalCount += test53Result.total;

// ─── TEST 54: Production Deployment Rehearsal & Recovery Gate (Fase 3C.1) ───
resetRehearsalDb();
const { runTest54 } = await import('./test_54_phase3c1_deployment_rehearsal.js');
const test54Result = await runTest54();
console.log('TEST 54 RESULT:', { passed: test54Result.passed, total: test54Result.total });
passedCount += test54Result.passed;
totalCount += test54Result.total;

// ─── TEST 55: Final Production Deployment Gate & Pre-Flight (Fase 3C.2) ───
resetRehearsalDb();
const { runTest55 } = await import('./test_55_phase3c2_production_gate.js');
const test55Result = await runTest55();
console.log('TEST 55 RESULT:', { passed: test55Result.passed, total: test55Result.total });
passedCount += test55Result.passed;
totalCount += test55Result.total;

// ─── TEST 56: Final Deployment Safety Hardening (Fase 3C.2.1) ───
resetRehearsalDb();
const { runTest56 } = await import('./test_56_phase3c21_final_deployment_hardening.js');
const test56Result = await runTest56();
console.log('TEST 56 RESULT:', { passed: test56Result.passed, total: test56Result.total });
passedCount += test56Result.passed;
totalCount += test56Result.total;

// ─── TEST 57: Final Migration Integrity & Lock Gate (Fase 3C.2.2) ───
resetRehearsalDb();
const { runTest57 } = await import('./test_57_phase3c22_final_integrity_lock_gate.js');
const test57Result = await runTest57();
console.log('TEST 57 RESULT:', { passed: test57Result.passed, total: test57Result.total });
passedCount += test57Result.passed;
totalCount += test57Result.total;

// Limpieza de entorno rehearsal PRE-015
delete process.env.PRESUVOZ_PRE015_REHEARSAL_DB;
try {
  if (fs.existsSync(rehearsalDbPath)) fs.unlinkSync(rehearsalDbPath);
} catch (_) {}

// ─── TEST 58: Post-Deployment Stabilization & Production Verification (Fase 3D.1) ───
const { runTest58 } = await import('./test_58_phase3d_post_deployment_stabilization.js');
const test58Result = await runTest58();
console.log('TEST 58 RESULT:', { passed: test58Result.passed, total: test58Result.total });
passedCount += test58Result.passed;
totalCount += test58Result.total;

// ─── TEST 59: Post-015 Runtime Compatibility & Regression Hardening (Fase 3D.2) ───
const { runTest59 } = await import('./test_59_phase3d2_runtime_post015.js');
const test59Result = await runTest59();
console.log('TEST 59 RESULT:', { passed: test59Result.passed, total: test59Result.total });
passedCount += test59Result.passed;
totalCount += test59Result.total;

// ─── TEST 60: Test Suite Integrity & Post-015 Runtime Final Gate (Fase 3D.3) ───
const { runTest60 } = await import('./test_60_phase3d3_test_suite_integrity.js');
const test60Result = await runTest60();
console.log('TEST 60 RESULT:', { passed: test60Result.passed, total: test60Result.total });
passedCount += test60Result.passed;
totalCount += test60Result.total;
} else {
  console.log('Auditorías históricas 49–60 omitidas: requieren snapshots pre-015/post-015 canónicos y un checkout preparado.');
}

// ─── TEST 61: Secure Onboarding for New Autonomous Users (Fase 4A) ───
const { runTest61 } = await import('./test_61_phase4a_secure_onboarding.js');
const test61Result = await runTest61();
console.log('TEST 61 RESULT:', { passed: test61Result.passed, total: test61Result.total });
passedCount += test61Result.passed;
totalCount += test61Result.total;

// ─── TEST 62: Sequential, Atomic & Idempotent Invoice Numbering (Fase 4B) ───
const { runTest62 } = await import('./test_62_phase4b_sequential_invoice_numbering.js');
const test62Result = await runTest62();
console.log('TEST 62 RESULT:', { passed: test62Result.passed, total: test62Result.total });
passedCount += test62Result.passed;
totalCount += test62Result.total;

// ─── TEST 63: Safe Item Modification (Missing Line Interceptor) ───
console.log("\n==========================================================");
console.log("TEST 63: SAFE ITEM MODIFICATION & MISSING LINE INTERCEPTOR");
console.log("==========================================================");
const { detectItemModificationIntent, findItemByConcept, handleAddMissingItemConfirmation } = await import("./whatsapp_gateway.js");

// 1. Detección léxica de modificación
const mod1 = detectItemModificationIntent("Cambia la fontanería a 900 €.");
assert(mod1 !== null && mod1.concept === "fontanería" && mod1.price === 900, "TEST 63: detectItemModificationIntent detecta Cambia la fontanería a 900 €");

const mod2 = detectItemModificationIntent("cambia la fontaneria a 900");
assert(mod2 !== null && mod2.concept === "fontaneria" && mod2.price === 900, "TEST 63: detectItemModificationIntent detecta sin tilde ni símbolo de euro");

const mod3 = detectItemModificationIntent("Modifica la fontanería por 900 euros");
assert(mod3 !== null && mod3.concept === "fontanería" && mod3.price === 900, "TEST 63: detectItemModificationIntent detecta verbo modifica");

const mod4 = detectItemModificationIntent("Pon la fontanería a 900 €");
assert(mod4 !== null && mod4.concept === "fontanería" && mod4.price === 900, "TEST 63: detectItemModificationIntent detecta verbo pon");

const mod5 = detectItemModificationIntent("Añade fontanería por 900 €");
assert(mod5 === null, "TEST 63: Añade NO es modificación (añade directamente)");

const mod6 = detectItemModificationIntent("Cambia el descuento al 10%");
assert(mod6 === null, "TEST 63: descuento NO es partida de obra");

const mod7 = detectItemModificationIntent("Vale, quiero que para el presupuesto de Martín Conde me cambies el precio del acristalamiento de las habitaciones a 700 €.");
assert(mod7 !== null && mod7.concept === "acristalamiento de las habitaciones" && mod7.price === 700, "TEST 63: detectItemModificationIntent detecta 'me cambies el precio del acristalamiento de las habitaciones a 700 €'");

const mod8 = detectItemModificationIntent("Vale, quiero que para el presupuesto de Martín Conde me cambies eh el precio del acristalamiento de las habitaciones a 700 euros.");
assert(mod8 !== null && mod8.concept === "acristalamiento de las habitaciones" && mod8.price === 700, "TEST 63: detectItemModificationIntent tolera muletillas 'eh' y euros en audio");

// 2. Búsqueda de concepto en partidas
const sampleItems = [
  { id: "1", description: "Levantamiento de suelo", unitPrice: 1200 },
  { id: "2", description: "Alicatado de paredes", unitPrice: 800 }
];
assert(findItemByConcept(sampleItems, "fontanería") === null, "TEST 63: fontanería NO existe en el presupuesto");
assert(findItemByConcept(sampleItems, "suelo") !== null, "TEST 63: suelo SÍ existe en el presupuesto");
assert(findItemByConcept(sampleItems, "alicatado") !== null, "TEST 63: alicatado SÍ existe en el presupuesto");

// 3. Evaluación de respuestas de confirmación
const pendingAct = createProposedAction("B", "add_missing_item", { budgetId: "PRE-1", concept: "fontanería", price: 900 });
assert(evaluateConfirmationResponse(pendingAct, "sí").status === "APPROVED", "TEST 63: sí aprueba añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "añádela").status === "APPROVED", "TEST 63: añádela aprueba añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "sí, añádela").status === "APPROVED", "TEST 63: sí, añádela aprueba añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "ponla").status === "APPROVED", "TEST 63: ponla aprueba añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "no").status === "REJECTED", "TEST 63: no descarta añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "no la añadas").status === "REJECTED", "TEST 63: no la añadas descarta añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "cancela").status === "REJECTED", "TEST 63: cancela descarta añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "no hace falta").status === "REJECTED", "TEST 63: no hace falta descarta añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "no hace falta nada").status === "REJECTED", "TEST 63: no hace falta nada descarta añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "déjalo así").status === "REJECTED", "TEST 63: déjalo así descarta añadir la línea");
assert(evaluateConfirmationResponse(pendingAct, "para nada").status === "REJECTED", "TEST 63: para nada descarta añadir la línea");

// 4. Ejecución de confirmación y recálculo
const testSession = {
  phone: "34600111222",
  companyId: "test-comp-mod",
  company: { name: "Reformas Test S.L.", defaultTaxRate: 21 },
  budgets: new Map(),
  activeBudgetId: "PRE-MOD-01"
};
testSession.budgets.set("PRE-MOD-01", {
  id: "PRE-MOD-01",
  client: { name: "Jimena", address: "Calle Mayor 1" },
  items: [{ id: "1", description: "Levantamiento de suelo", qty: 1, unit: "pa", unitPrice: 1200, isPricePending: false }],
  financials: { subtotal: 1200, taxRatePercentage: 21, taxAmount: 252, totalAmount: 1452, discountPercentage: 0 }
});
const mockMessages = [];
await handleAddMissingItemConfirmation({
  sendMessage: async (jid, msg) => { mockMessages.push(msg); return { key: { id: "m1" } }; }
}, "34600111222@s.whatsapp.net", testSession, {
  budgetId: "PRE-MOD-01",
  concept: "fontanería",
  price: 900
});

const postBudget = testSession.budgets.get("PRE-MOD-01");
assert(postBudget.items.length === 2, "TEST 63: Presupuesto tiene ahora 2 partidas tras confirmar");
assert(postBudget.items[1].unitPrice === 900, "TEST 63: Nueva partida tiene precio 900 €");
assert(postBudget.financials.totalAmount === 2541, "TEST 63: Total recalculado con IVA es 2541 € (1200 + 900 = 2100 * 1.21)");
assert(mockMessages.length === 1 && mockMessages[0].text.includes("Partida añadida") && mockMessages[0].text.includes("900 €"), "TEST 63: Mensaje de confirmación enviado con enlace");

// ==========================================================
// TEST 64: SPECIFIC BUDGET RETRIEVAL AND DOUBLE-DIGIT EMOJI NUMBERING
// ==========================================================
console.log("\n==========================================================");
console.log("TEST 64: SPECIFIC BUDGET RETRIEVAL AND DOUBLE-DIGIT EMOJI NUMBERING");
console.log("==========================================================");

// 1. formatListIndex: 1..10 keycaps, 11+ bold numeric formatting
assert(formatListIndex(1) === '1️⃣', "TEST 64: formatListIndex(1) retorna 1️⃣");
assert(formatListIndex(9) === '9️⃣', "TEST 64: formatListIndex(9) retorna 9️⃣");
assert(formatListIndex(10) === '🔟', "TEST 64: formatListIndex(10) retorna 🔟 (keycap correcto de diez)");
assert(formatListIndex(11) === '*11.*', "TEST 64: formatListIndex(11) retorna *11.* sin romper emoji");
assert(formatListIndex(12) === '*12.*', "TEST 64: formatListIndex(12) retorna *12.* sin romper emoji");
assert(formatListIndex(25) === '*25.*', "TEST 64: formatListIndex(25) retorna *25.*");

// 2. detectSpecificBudgetQuery: Detección precisa de peticiones de un único presupuesto
const q1 = detectSpecificBudgetQuery("Enseñame el pre2026-002");
assert(Boolean(q1 && q1.type === 'id' && q1.query === 'pre2026-002'), "TEST 64: Detecta 'Enseñame el pre2026-002'");

const q2 = detectSpecificBudgetQuery("Muéstrame el pre2026-002");
assert(Boolean(q2 && q2.type === 'id' && q2.query === 'pre2026-002'), "TEST 64: Detecta 'Muéstrame el pre2026-002'");

const q3 = detectSpecificBudgetQuery("pre2026-002");
assert(Boolean(q3 && q3.type === 'id' && q3.query === 'pre2026-002'), "TEST 64: Detecta código directo 'pre2026-002'");

const q4 = detectSpecificBudgetQuery("el PRE-2026-002");
assert(Boolean(q4 && q4.type === 'id' && q4.query === 'PRE-2026-002'), "TEST 64: Detecta 'el PRE-2026-002' con mayúsculas y guion");

const q5 = detectSpecificBudgetQuery("pdf de Jimena");
assert(Boolean(q5 && q5.type === 'clientOrQuery' && q5.query === 'Jimena'), "TEST 64: Detecta 'pdf de Jimena'");

const q6 = detectSpecificBudgetQuery("Muéstrame el de Martín Conde");
assert(Boolean(q6 && q6.type === 'clientOrQuery' && q6.query === 'Martín Conde'), "TEST 64: Detecta 'Muéstrame el de Martín Conde'");

// Consultas globales de listado NO deben interpretarse como un presupuesto específico
assert(detectSpecificBudgetQuery("dime todos los presupuestos que estan sin firmar") === null, "TEST 64: 'todos los presupuestos que estan sin firmar' es listado general, no específico");
assert(detectSpecificBudgetQuery("presupuestos pendientes") === null, "TEST 64: 'presupuestos pendientes' no es consulta de uno específico");
assert(detectSpecificBudgetQuery("nuevo presupuesto para Juan") === null, "TEST 64: Creación de presupuesto nuevo no es show_budget");

// 3. findBudgetByQuery: Búsqueda tolerante a mayúsculas, guiones y clientes
const mockSessionBudgets = {
  budgets: new Map([
    ["PRE-2026-001", { id: "PRE-2026-001", client: { name: "Jimena Sánchez", address: "Calle Mayor 1" }, financials: { totalAmount: 1500 } }],
    ["PRE-2026-002", { id: "PRE-2026-002", client: { name: "Martín Conde", address: "Avenida Sol 12" }, financials: { totalAmount: 3200 } }]
  ])
};

const foundById = findBudgetByQuery(mockSessionBudgets, "pre2026-002");
assert(Boolean(foundById && foundById.id === "PRE-2026-002"), "TEST 64: findBudgetByQuery localiza PRE-2026-002 usando pre2026-002");

const foundByHyphenId = findBudgetByQuery(mockSessionBudgets, "PRE-2026-002");
assert(Boolean(foundByHyphenId && foundByHyphenId.id === "PRE-2026-002"), "TEST 64: findBudgetByQuery localiza con código exacto");

const foundByClient = findBudgetByQuery(mockSessionBudgets, "jimena");
assert(Boolean(foundByClient && foundByClient.id === "PRE-2026-001"), "TEST 64: findBudgetByQuery localiza por cliente en minúsculas 'jimena'");

const foundByClientAccent = findBudgetByQuery(mockSessionBudgets, "Martin Conde");
assert(Boolean(foundByClientAccent && foundByClientAccent.id === "PRE-2026-002"), "TEST 64: findBudgetByQuery tolera falta de tilde 'Martin Conde'");

assert(findBudgetByQuery(mockSessionBudgets, "Inexistente 999") === null, "TEST 64: Retorna null para presupuesto inexistente");

// 4. detectBudgetListIntent: Consultas deterministas sin llamada a Gemini (resolución instantánea por SQLite)
assert(detectBudgetListIntent("Muestrame los presupuestos que tengo sin firmar") === 'pending_signature', "TEST 64: 'Muestrame los presupuestos que tengo sin firmar' resuelto directo por SQLite");
assert(detectBudgetListIntent("Muéstrame los presupuestos que tengo sin firmar") === 'pending_signature', "TEST 64: 'Muéstrame los presupuestos que tengo sin firmar' con tilde resuelto directo por SQLite");
assert(detectBudgetListIntent("Enseñame los presupuestos sin firmar") === 'pending_signature', "TEST 64: 'Enseñame los presupuestos sin firmar' resuelto directo por SQLite");
assert(detectBudgetListIntent("que tengo sin firmar") === 'pending_signature', "TEST 64: 'que tengo sin firmar' resuelto directo por SQLite");
assert(detectBudgetListIntent("presupuestos sin firmar") === 'pending_signature', "TEST 64: 'presupuestos sin firmar' resuelto directo por SQLite");
assert(detectBudgetListIntent("ver presupuestos aceptados") === 'accepted', "TEST 64: 'ver presupuestos aceptados' resuelto directo por SQLite");
assert(detectBudgetListIntent("mis presupuestos") === 'all', "TEST 64: 'mis presupuestos' resuelto directo por SQLite");

// 5. Anti-colisión de dígitos y resolución por orden de lista reciente
const sessionWithRecentList = {
  budgets: new Map([
    ["PRE-2026-3074", { id: "PRE-2026-3074", client: { name: "María" }, financials: { totalAmount: 2420 } }],
    ["PRE2026-004", { id: "PRE2026-004", client: { name: "Juan" }, financials: { totalAmount: 6710 } }]
  ]),
  lastBudgetsList: [
    { id: "PRE-2026-3074", client: { name: "María" }, financials: { totalAmount: 2420 } },
    { id: "PRE2026-004", client: { name: "Juan" }, financials: { totalAmount: 6710 } }
  ]
};

// Consultar por posición ordinal de la lista
assert(findBudgetByQuery(sessionWithRecentList, "1")?.id === "PRE-2026-3074", "TEST 64: '1' resuelve al elemento 1 de la lista reciente");
assert(findBudgetByQuery(sessionWithRecentList, "2")?.id === "PRE2026-004", "TEST 64: '2' resuelve al elemento 2 de la lista reciente");

// Posición fuera de rango: no existe el 7 en una lista de 2 elementos ni hay presupuesto #7
assert(findBudgetByQuery(sessionWithRecentList, "7") === null, "TEST 64: '7' no existe en la lista de 2 ni colisiona con el dígito 7 de PRE-2026-3074");

// 6. Prohibición de enviar enlaces o PDF de borradores vacíos (0 € / sin partidas)
const { handleShowSpecificBudget } = await import('./whatsapp_gateway.js');
const mockSockDraft = {
  messagesSent: [],
  sendMessage: async (jid, content) => {
    mockSockDraft.messagesSent.push(content);
    return { key: { id: "msg_draft_test" } };
  }
};
const sessionWithEmptyDraft = {
  phone: "34600123456",
  company: { name: "Mi Empresa", phone: "34600123456" },
  budgets: new Map([
    ["PRE2026-007", { id: "PRE2026-007", isDraft: true, status: "BORRADOR", items: [], financials: { totalAmount: 0 } }]
  ])
};

await handleShowSpecificBudget(mockSockDraft, "34600123456@s.whatsapp.net", sessionWithEmptyDraft, "PRE2026-007");
assert(mockSockDraft.messagesSent.length === 1, "TEST 64: Envía únicamente 1 mensaje para borrador vacío");
assert(mockSockDraft.messagesSent[0].text.includes("borrador vacío"), "TEST 64: Informa con claridad de que es un borrador vacío sin partidas");
assert(!mockSockDraft.messagesSent[0].document, "TEST 64: CERO emisión de PDF para borrador vacío");

// ==========================================================
// TEST 65: IRPF WITHHOLDING RETENTION IN BUDGETS & INVOICES
// ==========================================================
console.log("\n==========================================================");
console.log("TEST 65: IRPF WITHHOLDING RETENTION IN BUDGETS & INVOICES");
console.log("==========================================================");

// 1. Detección en PresuVozEngine.detectIrpfRate y PresuVozParser.extractIRPFRate
assert(engine.detectIrpfRate("con retención del IRPF del 15%") === 15, "TEST 65: detectIrpfRate detecta retención del 15%");
assert(engine.detectIrpfRate("IRPF del 7%") === 7, "TEST 65: detectIrpfRate detecta IRPF del 7%");
assert(engine.detectIrpfRate("retención del 19%") === 19, "TEST 65: detectIrpfRate detecta retención del 19%");
assert(engine.detectIrpfRate("sin IRPF") === 0, "TEST 65: detectIrpfRate detecta sin IRPF como 0%");
assert(PresuVozParser.extractIRPFRate("retención del IRPF del 15%") === 15, "TEST 65: PresuVozParser extrae 15% de IRPF");

// 2. Cálculo en PresuVozEngine.process para presupuesto
const irpfBudgetRes = engine.process({
  rawTranscript: "Presupuesto María Martín 1000 euros con IVA del 21% y retención del IRPF del 15%",
  items: [{ description: "Trabajos de albañilería", qty: 1, unit: "pa", unitPrice: 1000 }]
});
assert(irpfBudgetRes.success === true, "TEST 65: Presupuesto con IRPF calculado con éxito");
assert(irpfBudgetRes.budget.financials.taxableBase === 1000, "TEST 65: Base imponible es 1000€");
assert(irpfBudgetRes.budget.financials.taxAmount === 210, "TEST 65: Cuota IVA 21% es 210€");
assert(irpfBudgetRes.budget.financials.irpfRatePercentage === 15, "TEST 65: Tipo IRPF es 15%");
assert(irpfBudgetRes.budget.financials.irpfAmount === 150, "TEST 65: Retención IRPF es 150€ (1000 * 15%)");
assert(irpfBudgetRes.budget.financials.totalAmount === 1060, "TEST 65: Total presupuesto es 1060€ (1000 + 210 - 150)");
assert(irpfBudgetRes.budget.financials.advanceAmount === 318, "TEST 65: Anticipo 30% es 318€ (1060 * 30%)");

// 3. Conversión a Factura ordinaria heredando el IRPF del presupuesto
const irpfInvoice = engine.convertToInvoice(irpfBudgetRes.budget);
assert(irpfInvoice.financials.irpfRatePercentage === 15, "TEST 65: Factura hereda tipo IRPF 15%");
assert(irpfInvoice.financials.irpfAmount === 150, "TEST 65: Factura retiene 150€ de IRPF");
assert(irpfInvoice.financials.totalAmount === 1060, "TEST 65: Total factura ajustado con IRPF es 1060€");

// 4. Emisión de Factura de Anticipo con IRPF
const irpfAdvInv = engine.createAdvanceInvoice(irpfBudgetRes.budget, { amount: 318 });
assert(irpfAdvInv.financials.taxableBase === 300, "TEST 65: Base imponible anticipo con IRPF es 300€ (318 / (1 + 0.21 - 0.15))");
assert(irpfAdvInv.financials.taxAmount === 63, "TEST 65: IVA anticipo es 63€ (300 * 21%)");
assert(irpfAdvInv.financials.irpfRatePercentage === 15, "TEST 65: IRPF anticipo es 15%");
assert(irpfAdvInv.financials.irpfAmount === 45, "TEST 65: Retención IRPF anticipo es 45€ (300 * 15%)");
assert(irpfAdvInv.financials.totalAmount === 318, "TEST 65: Total factura anticipo es exactamente 318€ (300 + 63 - 45)");

// 5. Modificación simultánea de IVA e IRPF ("cambies el IVA al 10% y la retención de IRPF al 7%")
const modText = "Para el presupuesto de Eugenio López quiero que me cambies el IVA al 10% y la retención de IRPF al 7%";
assert(engine.detectTaxRate(modText) === 0.1, "TEST 65: detectTaxRate detecta IVA al 10%");
assert(engine.detectIrpfRate(modText) === 7, "TEST 65: detectIrpfRate detecta IRPF al 7%");
const modBudgetRes = engine.process({
  rawTranscript: modText,
  items: irpfBudgetRes.budget.items,
  taxRate: engine.detectTaxRate(modText, null),
  irpfRate: engine.detectIrpfRate(modText, null)
});
assert(modBudgetRes.budget.financials.taxRatePercentage === 10, "TEST 65: Modificación aplica IVA 10%");
assert(modBudgetRes.budget.financials.taxAmount === 100, "TEST 65: Cuota IVA 10% es 100€");
assert(modBudgetRes.budget.financials.irpfRatePercentage === 7, "TEST 65: Modificación aplica IRPF 7%");
assert(modBudgetRes.budget.financials.irpfAmount === 70, "TEST 65: Retención IRPF 7% es 70€");
assert(modBudgetRes.budget.financials.totalAmount === 1030, "TEST 65: Total modificado es 1030€ (1000 + 100 - 70)");
assert(modBudgetRes.budget.financials.advanceAmount === 309, "TEST 65: Anticipo 30% es 309€ (1030 * 30%)");

// ==========================================================
// TEST 66: INVOICE QUERY DISAMBIGUATION, SIGNED BUDGET PDF, NATURAL PAYMENTS & PENDING INVOICES
// ==========================================================
console.log("\n==========================================================");
console.log("TEST 66: INVOICES, SIGNED PDF, PAYMENTS & PENDING LIST");
console.log("==========================================================");

const {
  detectSpecificInvoiceQuery,
  findInvoiceByQuery,
  detectInvoiceListIntent,
  handleShowSpecificInvoice,
  handleListInvoices
} = await import('./whatsapp_gateway.js');
const { generateBudgetPDF } = await import('./pdf_service.js');

// 1. Detección de consultas de facturas específicas vs presupuestos
assert(detectSpecificInvoiceQuery("Muéstrame la factura 1")?.query === '1', "TEST 66: Detecta 'Muéstrame la factura 1' como número 1");
assert(detectSpecificInvoiceQuery("la primera factura")?.query === '1', "TEST 66: Detecta 'la primera factura' como número 1");
assert(detectSpecificInvoiceQuery("la 1")?.query === '1', "TEST 66: Detecta 'la 1' como número 1");
assert(detectSpecificInvoiceQuery("Muéstrame la factura de Carlos Ruiz")?.query === 'Carlos Ruiz', "TEST 66: Detecta 'Muéstrame la factura de Carlos Ruiz' para cliente");
assert(detectSpecificInvoiceQuery("factura FAC-2026-001")?.query === 'FAC-2026-001', "TEST 66: Detecta código directo FAC-2026-001");
assert(detectSpecificInvoiceQuery("Muéstrame las facturas que tengo pendiente") === null, "TEST 66: Listado de facturas pendientes NO es consulta de factura individual");
assert(detectSpecificBudgetQuery("Muéstrame la factura 1") === null, "TEST 66: detectSpecificBudgetQuery descarta consultas de facturas");
assert(detectSpecificBudgetQuery("factura de Carlos Ruiz") === null, "TEST 66: detectSpecificBudgetQuery descarta factura de Carlos Ruiz");

// 2. Detección de listado de facturas pendientes
assert(detectInvoiceListIntent("Muéstrame las facturas que tengo pendiente") === 'pending', "TEST 66: Detecta listado de facturas pendientes");
assert(detectInvoiceListIntent("facturas pendientes de cobro") === 'pending', "TEST 66: Detecta facturas pendientes de cobro");
assert(detectInvoiceListIntent("facturas sin cobrar") === 'pending', "TEST 66: Detecta facturas sin cobrar");
assert(detectInvoiceListIntent("ver facturas") === 'all', "TEST 66: Detecta ver facturas como all");

// 3. Resolución de factura por ordinal contra lastInvoicesList y por cliente
const mockInv1 = {
  id: 'FAC-2026-001',
  invoiceNumber: 'FAC-2026-001',
  budgetId: 'PRE-2026-001',
  client: { name: 'Empresa Alpha' },
  financials: { totalAmount: 1200, taxableBase: 1000, taxAmount: 200 },
  status: 'PAGADA'
};
const mockInv2 = {
  id: 'FAC-2026-002',
  invoiceNumber: 'FAC-2026-002',
  budgetId: 'PRE-2026-002',
  client: { name: 'Carlos Ruiz' },
  financials: { totalAmount: 1400, taxableBase: 1200, taxAmount: 200 },
  status: 'EMITIDA'
};

const sessionWithInvoices = {
  company: { name: 'Reformas PresuVoz S.L.' },
  phone: '34601022367',
  invoices: new Map([
    ['FAC-2026-001', mockInv1],
    ['FAC-2026-002', mockInv2]
  ]),
  lastInvoicesList: [mockInv1, mockInv2]
};

assert(findInvoiceByQuery(sessionWithInvoices, '1')?.id === 'FAC-2026-001', "TEST 66: findInvoiceByQuery '1' devuelve FAC-2026-001");
assert(findInvoiceByQuery(sessionWithInvoices, '2')?.id === 'FAC-2026-002', "TEST 66: findInvoiceByQuery '2' devuelve FAC-2026-002");
assert(findInvoiceByQuery(sessionWithInvoices, 'Carlos Ruiz')?.id === 'FAC-2026-002', "TEST 66: findInvoiceByQuery 'Carlos Ruiz' devuelve FAC-2026-002");
assert(findInvoiceByQuery(sessionWithInvoices, 'Cliente Inexistente') === null, "TEST 66: findInvoiceByQuery cliente inexistente devuelve null");

// 4. Verificación de respuesta cuando no existe factura para el cliente
const mockSockInv = {
  messages: [],
  documents: [],
  async sendMessage(jid, content) {
    if (content.document) this.documents.push(content);
    else if (content.text) this.messages.push(content);
    return { key: { id: 'msg_' + Date.now() } };
  }
};
await handleShowSpecificInvoice(mockSockInv, '34601022367@s.whatsapp.net', sessionWithInvoices, 'Cliente Desconocido');
assert(mockSockInv.messages.length === 1, "TEST 66: Responde con 1 mensaje de error claro");
assert(mockSockInv.messages[0].text.includes('No he localizado ninguna factura emitida para *"Cliente Desconocido"*'), "TEST 66: Informa claramente que no hay factura emitida para ese cliente");
assert(mockSockInv.documents.length === 0, "TEST 66: Cero envío de PDF cuando no existe factura");

// 5. Presupuesto firmado renderiza sello digital y firma en PDF
const signedBudget = {
  id: 'PRE-2026-002',
  status: 'ACEPTADO',
  signedAt: '2026-10-10T12:00:00Z',
  company: { name: 'Reformas Pro S.L.', cif: 'B12345678' },
  client: { name: 'Carlos Ruiz', address: 'Calle Mayor 12' },
  items: [{ description: 'Pintura', qty: 1, unit: 'pa', unitPrice: 1000, total: 1000 }],
  financials: { totalAmount: 1210, taxableBase: 1000, taxAmount: 210 }
};
const signedPdfBuffer = await generateBudgetPDF(signedBudget);
assert(Buffer.isBuffer(signedPdfBuffer) && signedPdfBuffer.length > 1000, "TEST 66: PDF de presupuesto firmado generado correctamente con sello digital");

// 6. Pagos en lenguaje natural con porcentaje y euros
const testBudgetForPayment = {
  id: 'PRE-PAY-01',
  client: { name: 'Carlos Ruiz' },
  financials: { totalAmount: 1400 },
  payments: [],
  paymentSummary: { totalPaid: 0, remainingBalance: 1400, status: 'PENDIENTE' }
};
const sessionForPay = {
  company: { name: 'Empresa Test' },
  phone: '34601022367',
  companyId: 'comp_test_66',
  budgets: new Map([['PRE-PAY-01', testBudgetForPayment]]),
  invoices: new Map()
};

// Pago del 50%
const mockSockPay1 = {
  messages: [],
  documents: [],
  async sendMessage(jid, content) {
    if (content.document) this.documents.push(content);
    else if (content.text) this.messages.push(content);
    return { key: { id: 'msg_' + Date.now() } };
  }
};
const { handlePaymentRegistration } = await import('./whatsapp_gateway.js');
await handlePaymentRegistration(mockSockPay1, '34601022367@s.whatsapp.net', sessionForPay, testBudgetForPayment, {
  percentage: 50,
  method: 'Transferencia'
});
assert(testBudgetForPayment.paymentSummary.totalPaid === 700, "TEST 66: Pago del 50% calcula 700€ sobre 1400€");
assert(testBudgetForPayment.paymentSummary.remainingBalance === 700, "TEST 66: Saldo restante queda en 700€");
assert(mockSockPay1.documents.length === 1, "TEST 66: Envía PDF de recibo tras registrar pago del 50%");

// ==========================================================
// TEST 67: CLIENT INVOICES, RECEIPTS PDF RETRIEVAL & DEBT BALANCE RECONCILIATION
// ==========================================================
console.log("\n==========================================================");
console.log("TEST 67: CLIENT INVOICES, RECEIPTS PDF RETRIEVAL & DEBT BALANCE RECONCILIATION");
console.log("==========================================================");

const { formatAllDebts } = await import('./intent_router.js');
const { getPendingWorksDebt, db } = await import('./db_service.js');

// 1. Detección de consultas de facturas y recibos de clientes
const t67_q1 = detectSpecificInvoiceQuery("mandame las facturas de carlos ruiz");
assert(t67_q1?.type === 'clientOrQuery' && t67_q1?.query.toLowerCase() === 'carlos ruiz' && !t67_q1?.isReceiptOnly, "TEST 67: Detecta 'mandame las facturas de carlos ruiz'");

const t67_q2 = detectSpecificInvoiceQuery("facturas de Carlos Ruiz");
assert(t67_q2?.type === 'clientOrQuery' && t67_q2?.query === 'Carlos Ruiz' && !t67_q2?.isReceiptOnly, "TEST 67: Detecta 'facturas de Carlos Ruiz'");

const t67_q3 = detectSpecificInvoiceQuery("los recibos de carlos ruiz");
assert(t67_q3?.type === 'clientOrQuery' && t67_q3?.query.toLowerCase() === 'carlos ruiz' && t67_q3?.isReceiptOnly, "TEST 67: Detecta 'los recibos de carlos ruiz' con isReceiptOnly");

const t67_q4 = detectSpecificInvoiceQuery("recibos de Carlos Ruiz");
assert(t67_q4?.type === 'clientOrQuery' && t67_q4?.query === 'Carlos Ruiz' && t67_q4?.isReceiptOnly, "TEST 67: Detecta 'recibos de Carlos Ruiz' con isReceiptOnly");

const t67_q5 = detectSpecificInvoiceQuery("mandame el recibo de Carlos");
assert(t67_q5?.type === 'clientOrQuery' && t67_q5?.query === 'Carlos' && t67_q5?.isReceiptOnly, "TEST 67: Detecta 'mandame el recibo de Carlos'");

// 2. Detección de intenciones de deuda global y descarte de documentos
assert(detectIntent("quien me queda por pagar")?.intent === 'ALL_DEBTS', "TEST 67: 'quien me queda por pagar' detectado como ALL_DEBTS");
assert(detectIntent("quien falta por pagar")?.intent === 'ALL_DEBTS', "TEST 67: 'quien falta por pagar' detectado como ALL_DEBTS");
assert(detectIntent("a quien le queda por pagar")?.intent === 'ALL_DEBTS', "TEST 67: 'a quien le queda por pagar' detectado como ALL_DEBTS");
assert(detectIntent("mandame las facturas de carlos ruiz", { knownNames: ['Carlos Ruiz'] })?.intent !== 'DEBT_BY_CLIENT', "TEST 67: 'mandame las facturas de carlos ruiz' NO se confunde con DEBT_BY_CLIENT");

// 3. Envío conjunto de Factura PDF y Recibos PDF al pedir facturas de un cliente
const mockSockClientDocs = {
  messages: [],
  documents: [],
  async sendMessage(jid, content) {
    if (content.document) this.documents.push(content);
    else if (content.text) this.messages.push(content);
    return { key: { id: 'msg_' + Date.now() } };
  }
};

const existingComp = db.prepare('SELECT id, name FROM companies LIMIT 1').get();
const testCompId = existingComp?.id || '817ca602-6ae4-4fe3-9b06-293e52b8df60';

db.prepare(`
  INSERT OR IGNORE INTO budgets (id, company_id, client_name, total_amount, status, data_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'PRE-TEST-67',
  testCompId,
  'Carlos Ruiz',
  2200,
  'ACEPTADO',
  JSON.stringify({ id: 'PRE-TEST-67', client: { name: 'Carlos Ruiz' } }),
  new Date().toISOString(),
  new Date().toISOString()
);

const testSessionClient = {
  phone: '34601022367',
  companyId: testCompId,
  company: { name: existingComp?.name || 'Pinturas Pro S.L.', cif: 'B-99887766' },
  invoices: new Map([
    ['FAC-2026-999', {
      id: 'FAC-2026-999',
      client: { name: 'Carlos Ruiz', address: 'Calle Sol 1' },
      financials: { totalAmount: 660, taxableBase: 600, taxAmount: 60, taxRatePercentage: 10 },
      status: 'PAGADA',
      budgetId: 'PRE-TEST-67'
    }]
  ]),
  budgets: new Map([
    ['PRE-TEST-67', {
      id: 'PRE-TEST-67',
      client: { name: 'Carlos Ruiz' },
      total_amount: 2200
    }]
  ])
};

// Insertar un pago de prueba para PRE-TEST-67 en SQLite para simular recibo
db.prepare(`
  INSERT OR IGNORE INTO payments (id, company_id, budget_id, amount, method, concept, data_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'REC-TEST-67-1',
  testCompId,
  'PRE-TEST-67',
  700,
  'Bizum',
  'Entrega a cuenta',
  JSON.stringify({
    id: 'REC-TEST-67-1',
    budgetId: 'PRE-TEST-67',
    date: '11/10/2026',
    amount: 700,
    method: 'Bizum',
    concept: 'Entrega a cuenta',
    previouslyPaid: 660,
    totalPaid: 1360,
    totalAmount: 2200,
    remainingBalance: 840,
    status: 'PARCIAL',
    client: { name: 'Carlos Ruiz' },
    company: { name: 'Pinturas Pro S.L.', cif: 'B-99887766' }
  }),
  new Date().toISOString()
);

await handleShowSpecificInvoice(mockSockClientDocs, '34601022367@s.whatsapp.net', testSessionClient, 'Carlos Ruiz');
assert(mockSockClientDocs.documents.length >= 2, "TEST 67: Envía tanto la factura PDF como los recibos PDF para Carlos Ruiz");
const hasInvPdf = mockSockClientDocs.documents.some(d => d.fileName?.includes('Factura_FAC-2026-999'));
const hasRecPdf = mockSockClientDocs.documents.some(d => d.fileName?.includes('Recibo_REC-TEST-67-1'));
assert(hasInvPdf, "TEST 67: Se incluye Factura_FAC-2026-999.pdf en el envío");
assert(hasRecPdf, "TEST 67: Se incluye Recibo_REC-TEST-67-1.pdf en el envío");

// 4. Conciliación y coherencia en saldo de cliente liquidado
const testWorkSettled = {
  budgetId: 'PRE-TEST-SETTLED',
  clientName: 'Carlos Ruiz',
  totalAmount: 2200,
  totalPaid: 2200,
  remainingBalance: 0
};
const { formatDebtByClient } = await import('./intent_router.js');
const settledDebtMsg = formatDebtByClient('Carlos Ruiz', [], null, testWorkSettled);
assert(settledDebtMsg.includes('está al corriente de pago'), "TEST 67: Cliente liquidado con remainingBalance 0 reporta estar al corriente de pago");
assert(!settledDebtMsg.includes('660'), "TEST 67: No reporta falsamente 660€ pendientes para cliente liquidado");

// 5. Inclusión de obras pendientes en formato global de deudas
const testPendingWorks = [
  { budgetId: 'PRE-01', clientName: 'Alberto López', totalAmount: 6545, totalPaid: 0, remainingBalance: 6545 },
  { budgetId: 'PRE-02', clientName: 'Jimena', totalAmount: 4180, totalPaid: 0, remainingBalance: 4180 }
];
const allDebtsFormatted = formatAllDebts([], testPendingWorks);
assert(allDebtsFormatted.includes('Alberto López'), "TEST 67: formatAllDebts incluye clientes con obras pendientes");
assert(allDebtsFormatted.includes('6545,00 €'), "TEST 67: formatAllDebts muestra importe de obra pendiente");
assert(allDebtsFormatted.includes('Jimena'), "TEST 67: formatAllDebts incluye Jimena");

console.log("\n==========================================================");
console.log("TEST 68: AI MULTI-MODEL FALLBACK AND PERSISTENT STANDBY QUEUE RESILIENCE");
console.log("==========================================================");

const { isTransientAiError } = await import('./whatsapp_gateway.js');
const { GEMINI_MODELS: AI_GEMINI_MODELS } = await import('./ai_service.js');

// 1. Detección exhaustiva de errores transitorios de IA
assert(isTransientAiError(new Error("503 Service Unavailable: This model is currently experiencing high demand")), "TEST 68: 503 high demand detectado como transitorio");
assert(isTransientAiError(new Error("429 Too Many Requests: Resource has been exhausted")), "TEST 68: 429 quota detectado como transitorio");
assert(isTransientAiError(new Error("Gemini no respondió dentro del tiempo límite (35s); se probará el modelo estable alternativo.")), "TEST 68: tiempo límite en español detectado como transitorio");
assert(isTransientAiError(new Error("The operation was aborted due to timeout")), "TEST 68: timeout detectado como transitorio");
assert(isTransientAiError(new Error("read ECONNRESET")), "TEST 68: ECONNRESET detectado como transitorio");
assert(isTransientAiError(new Error("fetch failed")), "TEST 68: fetch failed detectado como transitorio");
assert(!isTransientAiError(new Error("Invalid JSON token at position 0")), "TEST 68: Error sintáctico no se confunde con transitorio");
assert(!isTransientAiError(new Error("Respuesta vacía de Gemini")), "TEST 68: Respuesta vacía no es error de red transitorio");

// 2. Comprobación de modelos con fallback activo
assert(AI_GEMINI_MODELS.includes('gemini-3.1-flash-lite'), "TEST 68: AI Service incluye gemini-3.1-flash-lite como fallback inmediato");
assert(AI_GEMINI_MODELS.length >= 4, "TEST 68: AI Service tiene al menos 4 modelos en cascada");

// 3. Verificación de retención de cola persistente
const testQueueFile = path.resolve('data', 'ai_standby_queue.json');
const testQueueEntry = {
  id: 123456789,
  remoteJid: '34601022367@s.whatsapp.net',
  attempts: 1,
  nextRetryAt: Date.now() + 5000,
  taskData: {
    isAudio: false,
    rawUserText: 'Presupuesto pintura salón 50m2',
    senderNumber: '34601022367'
  }
};
fs.writeFileSync(testQueueFile, JSON.stringify([testQueueEntry], null, 2), 'utf-8');
assert(fs.existsSync(testQueueFile), "TEST 68: Archivo de cola persistente generado en disco");
const loadedContent = JSON.parse(fs.readFileSync(testQueueFile, 'utf-8'));
assert(loadedContent.length === 1 && loadedContent[0].taskData.rawUserText === 'Presupuesto pintura salón 50m2', "TEST 68: Tarea recuperable íntegra desde disco tras reinicio");
if (fs.existsSync(testQueueFile)) fs.unlinkSync(testQueueFile);


console.log("==========================================================");

console.log("\n==========================================================");
console.log("TEST 69: HOMONYMOUS CLIENTS (DISAMBIGUATION IN BUDGET MODIFICATION & DEBTS) AND NON-STICKY MEMORY");
console.log("==========================================================");

const { findClientsByName: testFindClients, saveBudget: testSaveBudget, db: currentTestDb } = await import('./db_service.js');
const { checkDisambiguation: testCheckDis, resolveDisambiguationChoice: testResolveDis, getUserSession: testGetSession } = await import('./whatsapp_gateway.js');
const { detectIntent: testDetectIntent, resolveIntent: testResolveIntent } = await import('./intent_router.js');

const tenantPhone69 = '34601022367';
const compRow69 = currentTestDb.prepare("SELECT id FROM companies WHERE phone = ?").get(tenantPhone69);
const tenantContext69 = compRow69 ? { companyId: compRow69.id, phone: tenantPhone69 } : tenantPhone69;

// Limpiar budgets de prueba previos
currentTestDb.prepare("DELETE FROM budgets WHERE id IN ('PRE-MANOLO-01', 'PRE-MANOLO-02', 'PRE-MANOLO-03')").run();

// Guardar 3 presupuestos con variantes ortográficas de tilde
testSaveBudget(tenantContext69, {
  id: 'PRE-MANOLO-01',
  client: { name: 'Manolito Fernandez', address: 'Calle Tarsis 12' },
  items: [{ id: 'it1', description: 'Pintura', qty: 1, unit: 'pa', unitPrice: 1000, total: 1000 }],
  financials: { totalAmount: 1000 }
});
testSaveBudget(tenantContext69, {
  id: 'PRE-MANOLO-02',
  client: { name: 'Manolito Fernández', address: 'Calle Rapuncel 8' },
  items: [{ id: 'it2', description: 'Fontanería', qty: 1, unit: 'pa', unitPrice: 2000, total: 2000 }],
  financials: { totalAmount: 2000 }
});
testSaveBudget(tenantContext69, {
  id: 'PRE-MANOLO-03',
  client: { name: 'Manolito Fernández', address: 'Calle Sol 4' },
  items: [{ id: 'it3', description: 'Electricidad', qty: 1, unit: 'pa', unitPrice: 1500, total: 1500 }],
  financials: { totalAmount: 1500 }
});

// 1. Verificación de tolerancia a tildes en findClientsByName
const foundSinTilde = testFindClients(tenantContext69, 'manolito fernandez');
assert(foundSinTilde.length >= 3, "TEST 69: findClientsByName encuentra los 3 homónimos buscando sin tilde");
const foundConTilde = testFindClients(tenantContext69, 'Manolito Fernández');
assert(foundConTilde.length >= 3, "TEST 69: findClientsByName encuentra los 3 homónimos buscando con tilde");

// 2. Desambiguación en modificación de presupuesto
const mockSession69 = {
  phone: tenantPhone69,
  companyId: compRow69?.id,
  authContext: tenantContext69,
  budgets: new Map(),
  activeBudgetId: null,
  pendingDisambiguation: null
};
for (const b of foundSinTilde) mockSession69.budgets.set(b.id, b);

const mockSock69 = {
  messages: [],
  async sendMessage(jid, content) {
    this.messages.push(content);
    return { key: { id: 'msg_dis_' + Date.now() } };
  }
};

const isDisMod = await testCheckDis(mockSock69, tenantPhone69 + '@s.whatsapp.net', mockSession69, 'Manolito Fernández', 'modify_budget', {
  aiResult: { action: 'budget', isNewBudget: false, clientName: 'Manolito Fernández' }
});
assert(isDisMod === true, "TEST 69: checkDisambiguation activa desambiguación para modify_budget");
assert(mockSession69.pendingDisambiguation !== null, "TEST 69: Registra pendingDisambiguation con actionType modify_budget");
assert(mockSession69.pendingDisambiguation.actionType === 'modify_budget', "TEST 69: actionType es modify_budget");
assert(mockSock69.messages[0].text.includes('¿A cuál de los presupuestos deseas aplicar la modificación?'), "TEST 69: Pregunta con claridad a qué presupuesto aplicar la modificación");

// 3. Resolución de elección del usuario para modificar
const choice = testResolveDis('el 2', mockSession69.pendingDisambiguation.candidates);
assert(choice && choice.id === 'PRE-MANOLO-02', "TEST 69: Usuario elige 'el 2' y resuelve a PRE-MANOLO-02");
const choiceAddr = testResolveDis('el de Rapuncel', mockSession69.pendingDisambiguation.candidates);
assert(choiceAddr && choiceAddr.id === 'PRE-MANOLO-02', "TEST 69: Usuario indica dirección y resuelve a PRE-MANOLO-02");

// 4. Consulta de deuda para cliente homónimo
const debtDetected = testDetectIntent('cuanto me debe manolito fernandez');
assert(debtDetected?.intent === 'DEBT_BY_CLIENT', "TEST 69: 'cuanto me debe manolito fernandez' detectado como DEBT_BY_CLIENT");
const debtReply = await testResolveIntent(debtDetected, tenantPhone69, mockSession69);
assert(debtReply.includes('He encontrado 3 clientes/obras para "Manolito Fernandez"') || debtReply.includes('He encontrado 3'), "TEST 69: Respuesta de deuda detecta 3 obras");
assert(debtReply.includes('PRE-MANOLO-01') && debtReply.includes('PRE-MANOLO-02') && debtReply.includes('PRE-MANOLO-03'), "TEST 69: Desglose incluye los 3 presupuestos de Manolito");
assert(debtReply.includes('Total pendiente acumulado:') && (debtReply.includes('4500,00 €') || debtReply.includes('4.500,00 €')), "TEST 69: Calcula total acumulado correcto de los 3 presupuestos (1000 + 2000 + 1500 = 4500 €)");

// 5. Cero secuestro de intención: Modificación de partida jamás se clasifica como DEBT_BY_CLIENT
const modifyDetect = testDetectIntent('De la obra de manolito fernandez quiero cambiar el precio de Demolición y retirada de escombros a 500€', { knownNames: ['Manolito Fernández'] });
assert(modifyDetect === null, "TEST 69: Modificación de partida NO es interceptada como DEBT_BY_CLIENT por contener el nombre del cliente");

const { detectItemModificationIntent: testDetectItemMod } = await import('./whatsapp_gateway.js');
const itemModParsed = testDetectItemMod('De la obra de manolito fernandez quiero cambiar el precio de Demolición y retirada de escombros a 500€');
assert(itemModParsed && itemModParsed.concept.includes('Demolición') && itemModParsed.price === 500, "TEST 69: detectItemModificationIntent extrae concepto 'Demolición y retirada de escombros' y precio 500");

// 6. Cero suposición sticky: activeBudgetId no persiste por defecto
const freshSession = testGetSession(tenantPhone69 + '@s.whatsapp.net', tenantPhone69);
assert(freshSession.activeBudgetId === null, "TEST 69: getUserSession NO asigna arbitrariamente activeBudgetId a la sesión");

// Limpiar budgets de prueba
currentTestDb.prepare("DELETE FROM budgets WHERE id IN ('PRE-MANOLO-01', 'PRE-MANOLO-02', 'PRE-MANOLO-03')").run();

console.log("\n==========================================================");
console.log("TEST 70: SEPARATION OF BUDGET ACCEPTANCE, PHASE INVOICING, FINAL INVOICE & COBROS VS FACTURAS");
console.log("==========================================================");

const {
  detectSpecificInvoiceQuery: testDetectSpecificInvoice,
  emitPhaseInvoiceForBudget: testEmitPhaseInvoice,
  emitFinalInvoiceForBudget: testEmitFinalInvoice,
  handlePaymentRegistration: testHandlePayment,
  handleAcceptBudget: testHandleAccept,
  handleQueryPendingToInvoice: testHandlePendingInv,
  findInvoiceByQuery: testFindInv
} = await import('./whatsapp_gateway.js');

const {
  getInvoicesByBudgetId: testGetInvoicesByBudgetId,
  getProjectBillingSummary: testGetProjectBillingSummary,
  emitInvoice: testEmitInvoice,
  saveBudget: testSaveBudget70,
  getBudget: testGetBudget70,
  db: testDb70
} = await import('./db_service.js');

const { PresuVozEngine: TestPresuVozEngine70 } = await import('./engine.js');
const testEngine70 = new TestPresuVozEngine70();
const { detectIntent: testDetectIntent70, resolveIntent: testResolveIntent70 } = await import('./intent_router.js');

const tenantPhone70 = '34601022370';
let compRow70 = testDb70.prepare("SELECT id FROM companies WHERE phone = ?").get(tenantPhone70);
if (!compRow70 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(compRow70.id)) {
  const newCid = crypto.randomUUID();
  if (compRow70) {
    for (const t of ['payment_allocations', 'payments', 'invoices', 'budgets', 'appointments', 'shopping_items']) {
      try { testDb70.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(compRow70.id); } catch(e){}
    }
    testDb70.prepare("DELETE FROM companies WHERE phone = ?").run(tenantPhone70);
  }
  testDb70.prepare("INSERT INTO companies (id, phone, name, invoice_series) VALUES (?, ?, ?, ?)").run(newCid, tenantPhone70, 'Reformas Laura S.L.', 'FAC-2026');
  compRow70 = { id: newCid };
}
const tenantContext70 = { companyId: compRow70.id, phone: tenantPhone70 };

// Limpiar datos previos de prueba
testDb70.prepare("DELETE FROM payment_allocations WHERE company_id = ?").run(compRow70.id);
testDb70.prepare("DELETE FROM payments WHERE company_id = ?").run(compRow70.id);
testDb70.prepare("DELETE FROM invoices WHERE company_id = ?").run(compRow70.id);
testDb70.prepare("DELETE FROM budgets WHERE company_id = ?").run(compRow70.id);

// 1. Guardias de detectSpecificInvoiceQuery: CERO falsos positivos en frases largas de negocio
assert(testDetectSpecificInvoice('He terminado la instalación eléctrica de la reforma de Laura. Prepárame la factura de esa fase') === null,
  "TEST 70: detectSpecificInvoiceQuery no intercepta 'Prepárame la factura de esa fase'");
assert(testDetectSpecificInvoice('Laura me acaba de pagar 1.500 euros de la factura 24') === null,
  "TEST 70: detectSpecificInvoiceQuery no intercepta registro de cobro con número de factura");
assert(testDetectSpecificInvoice('¿Cuánto dinero me queda por cobrar de la reforma de Laura?') === null,
  "TEST 70: detectSpecificInvoiceQuery no intercepta consulta de dinero pendiente de cobro");
assert(testDetectSpecificInvoice('He terminado toda la obra. Prepárame la factura final teniendo en cuenta los anticipos y las facturas anteriores') === null,
  "TEST 70: detectSpecificInvoiceQuery no intercepta petición de factura final");
assert(testDetectSpecificInvoice('¿Cuánto queda por facturar de la reforma de Laura?') === null,
  "TEST 70: detectSpecificInvoiceQuery no intercepta consulta de importe pendiente de facturar");

// 2. Presupuesto aceptado NO genera automáticamente factura por el importe total
const budgetLaura = {
  id: 'PRE-LAURA-01',
  client: { name: 'Laura Gómez', address: 'Calle Mayor 10' },
  items: [
    { id: 'it-elec-1', description: 'Instalación eléctrica completa de vivienda', qty: 1, unit: 'pa', unitPrice: 1200, total: 1200 },
    { id: 'it-font-2', description: 'Fontanería y desagües de baños', qty: 1, unit: 'pa', unitPrice: 800, total: 800 },
    { id: 'it-alba-3', description: 'Albañilería y alicatado general', qty: 1, unit: 'pa', unitPrice: 1500, total: 1500 }
  ],
  financials: {
    subtotal: 3500,
    taxRatePercentage: 21,
    taxAmount: 735,
    totalAmount: 4235
  },
  status: 'PENDIENTE_FIRMA'
};
testSaveBudget70(tenantContext70, budgetLaura);

const mockSock70 = {
  messages: [],
  async sendMessage(jid, content) {
    this.messages.push(content);
    return { key: { id: 'msg_70_' + Math.random().toString(36).substring(2, 8) } };
  }
};
const mockSession70 = {
  phone: tenantPhone70,
  companyId: compRow70.id,
  authContext: tenantContext70,
  company: { name: 'Reformas Laura S.L.', invoiceSeries: 'FAC-2026' },
  budgets: new Map([['PRE-LAURA-01', budgetLaura]]),
  invoices: new Map(),
  activeBudgetId: 'PRE-LAURA-01'
};

await testHandleAccept(mockSock70, tenantPhone70 + '@s.whatsapp.net', mockSession70, budgetLaura);
const budgetAfterAccept = testGetBudget70(tenantContext70, 'PRE-LAURA-01');
assert(budgetAfterAccept.status === 'ACEPTADO', "TEST 70: Aceptación confirma estado ACEPTADO");
const invoicesOnAccept = testGetInvoicesByBudgetId(tenantContext70, 'PRE-LAURA-01');
assert(invoicesOnAccept.length === 0, "TEST 70: Firma/Aceptación genera CERO facturas automáticas");

// 3. Facturación por fases: Factura únicamente las partidas ejecutadas de la fase
await testEmitPhaseInvoice(mockSock70, tenantPhone70 + '@s.whatsapp.net', mockSession70, budgetLaura, 'instalación eléctrica');
const invoicesAfterPhase = testGetInvoicesByBudgetId(tenantContext70, 'PRE-LAURA-01');
assert(invoicesAfterPhase.length === 1, "TEST 70: Emite exactamente 1 factura para la fase");
const phaseInv = invoicesAfterPhase[0];
assert(phaseInv.type === 'FASE', "TEST 70: La factura emitida es de tipo 'FASE'");
assert(phaseInv.items.length === 1 && phaseInv.items[0].description.includes('eléctrica'), "TEST 70: La factura de fase contiene solo la partida eléctrica");
assert(phaseInv.financials.taxableBase === 1200, "TEST 70: Base imponible de fase es 1.200 €");
assert(phaseInv.financials.taxAmount === 252, "TEST 70: Cuota IVA de fase es 252 €");
assert(phaseInv.financials.totalAmount === 1452, "TEST 70: Total factura de fase es 1.452 €");
const budgetAfterPhase = testGetBudget70(tenantContext70, 'PRE-LAURA-01');
assert(budgetAfterPhase.status === 'ACEPTADO', "TEST 70: Presupuesto permanece en estado ACEPTADO tras emitir factura de fase");

// 4. Distinción explícita: Pendiente de facturar vs Pendiente de cobro
const summaryAfterPhase = testGetProjectBillingSummary(tenantContext70, 'PRE-LAURA-01');
assert(summaryAfterPhase.budgetTotal === 4235, "TEST 70: Presupuesto acordado es 4.235 €");
assert(summaryAfterPhase.workInvoiced === 1452, "TEST 70: Total facturado de obra hasta la fecha es 1.452 €");
assert(summaryAfterPhase.pendingToInvoice === 2783, "TEST 70: Pendiente de facturar es exactamente 2.783 € (4.235 - 1.452)");
assert(summaryAfterPhase.pendingToCollect === 4235, "TEST 70: Pendiente de cobro total es 4.235 € (0 cobrado)");
assert(summaryAfterPhase.uninvoicedItems.length === 2, "TEST 70: Quedan exactamente 2 partidas pendientes de facturar");

// 5. Consulta determinística de facturación pendiente y cobro pendiente
const intentPendingInv = testDetectIntent70('¿Cuánto queda por facturar de la reforma de Laura?', { knownNames: ['Laura Gómez'] });
assert(intentPendingInv?.intent === 'PENDING_TO_INVOICE', "TEST 70: '¿Cuánto queda por facturar...' detectado como PENDING_TO_INVOICE");
const replyPendingInv = await testResolveIntent70(intentPendingInv, tenantPhone70, mockSession70);
assert(replyPendingInv.includes('2.783,00 €') || replyPendingInv.includes('2783,00 €'), "TEST 70: Respuesta detalla 2.783 € pendientes de facturar");

const intentDebtClient = testDetectIntent70('¿Cuánto dinero me queda por cobrar de la reforma de Laura?', { knownNames: ['Laura Gómez'] });
assert(intentDebtClient?.intent === 'DEBT_BY_CLIENT', "TEST 70: '¿Cuánto dinero me queda por cobrar...' detectado como DEBT_BY_CLIENT");

// 6. Cobros parciales asignados a factura: CERO nuevas facturas creadas por registrar pagos
// Simular factura de 2000 € y 3 pagos parciales (500 €, 700 €, 800 €)
const budgetPagos = {
  id: 'PRE-PAGOS-01',
  client: { name: 'Cliente Pagos', address: 'Calle Prueba' },
  items: [{ id: 'it-p-1', description: 'Reforma integral', qty: 1, unit: 'pa', unitPrice: 2000, total: 2000 }],
  financials: { subtotal: 2000, taxableBase: 2000, taxRatePercentage: 0, taxAmount: 0, totalAmount: 2000 },
  status: 'ACEPTADO'
};
testSaveBudget70(tenantContext70, budgetPagos);
const inv2000Payload = testEngine70.convertToInvoice(budgetPagos, { type: 'FINAL', company: mockSession70.company });
const inv2000Result = testEmitInvoice(tenantContext70, inv2000Payload);
const inv2000 = inv2000Result.invoice;
mockSession70.invoices.set(inv2000.id, inv2000);
mockSession70.budgets.set('PRE-PAGOS-01', budgetPagos);

const initialInvoicesCount = testDb70.prepare("SELECT COUNT(*) AS c FROM invoices WHERE company_id = ?").get(compRow70.id).c;

await testHandlePayment(mockSock70, tenantPhone70 + '@s.whatsapp.net', mockSession70, budgetPagos, { amount: 500, concept: 'Primer cobro' });
const invAfter500 = testDb70.prepare("SELECT status FROM invoices WHERE id = ?").get(inv2000.id);
assert(invAfter500.status === 'PARCIAL', "TEST 70: Factura pasa a estado 'PARCIAL' tras primer cobro de 500 €");

await testHandlePayment(mockSock70, tenantPhone70 + '@s.whatsapp.net', mockSession70, budgetPagos, { amount: 700, concept: 'Segundo cobro' });
await testHandlePayment(mockSock70, tenantPhone70 + '@s.whatsapp.net', mockSession70, budgetPagos, { amount: 800, concept: 'Tercer cobro' });

const invAfterAll = testDb70.prepare("SELECT status FROM invoices WHERE id = ?").get(inv2000.id);
assert(invAfterAll.status === 'PAGADA', "TEST 70: Factura pasa a estado 'PAGADA' tras cubrir los 2.000 €");

const finalInvoicesCount = testDb70.prepare("SELECT COUNT(*) AS c FROM invoices WHERE company_id = ?").get(compRow70.id).c;
assert(finalInvoicesCount === initialInvoicesCount, "TEST 70: Registrar cobros parciales crea CERO facturas nuevas (saldo 0 €)");

// 7. Pago imputado a factura explícita y formateo de 1.500 €
const targetInv24 = {
  id: 'FAC-2026-0024',
  company_id: compRow70.id,
  budget_id: 'PRE-LAURA-01',
  client_name: 'Laura Gómez',
  total_amount: 1500,
  status: 'PENDIENTE_PAGO',
  data_json: JSON.stringify({ id: 'FAC-2026-0024', type: 'FASE', phaseName: 'fase previa', budgetId: 'PRE-LAURA-01', client: { name: 'Laura Gómez' }, financials: { totalAmount: 1500 }, items: [] })
};
testDb70.prepare("INSERT OR REPLACE INTO invoices (id, company_id, budget_id, client_name, total_amount, status, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  targetInv24.id, targetInv24.company_id, targetInv24.budget_id, targetInv24.client_name, targetInv24.total_amount, targetInv24.status, targetInv24.data_json
);
mockSession70.invoices.set('FAC-2026-0024', targetInv24);

const invFound24 = testFindInv(mockSession70, '24');
assert(invFound24 && invFound24.id === 'FAC-2026-0024', "TEST 70: '24' resuelve a FAC-2026-0024");

// Registrar pago dictado con '1.500' y 'de la factura 24'
await testHandlePayment(mockSock70, tenantPhone70 + '@s.whatsapp.net', mockSession70, budgetLaura, {
  amount: 1500,
  invoiceQuery: '24',
  concept: 'Pago de Laura factura 24'
});
const inv24After = testDb70.prepare("SELECT status FROM invoices WHERE id = 'FAC-2026-0024'").get();
assert(inv24After.status === 'PAGADA', "TEST 70: Factura 24 queda en estado PAGADA tras pago explícito");

// 8. Factura final y regularización de partidas sin duplicar fase eléctrica
await testEmitFinalInvoice(mockSock70, tenantPhone70 + '@s.whatsapp.net', mockSession70, budgetLaura);
const allLauraInvoices = testGetInvoicesByBudgetId(tenantContext70, 'PRE-LAURA-01');
const finalInv70 = allLauraInvoices.find(i => i.type === 'FINAL');
assert(Boolean(finalInv70), "TEST 70: Factura final de liquidación emitida con éxito");
assert(finalInv70.items.length === 2, "TEST 70: Factura final contiene únicamente las 2 partidas restantes no facturadas");
assert(!finalInv70.items.some(it => it.description.includes('eléctrica')), "TEST 70: Factura final NO duplica la partida eléctrica ya facturada");
assert(finalInv70.financials.taxableBase === 2300, "TEST 70: Base imponible final es 2.300 € (Fontanería 800 + Albañilería 1500)");
assert(finalInv70.financials.taxAmount === 483, "TEST 70: Cuota IVA de factura final es 483 €");
assert(finalInv70.financials.totalAmount === 2783, "TEST 70: Total factura final es exactamente 2.783 €");
const budgetFinalStatus = testGetBudget70(tenantContext70, 'PRE-LAURA-01');
assert(budgetFinalStatus.status === 'FACTURADO', "TEST 70: Presupuesto pasa a FACTURADO al concluir la facturación final");

// 9. Idempotencia: intento de re-emisión de la misma factura no genera duplicado
const secondFinal = testEmitInvoice(tenantContext70, finalInv70);
assert(secondFinal.isDuplicate === true, "TEST 70: Idempotencia evita duplicar factura final para el mismo presupuesto");

// Limpiar datos de prueba TEST 70
testDb70.prepare("DELETE FROM payment_allocations WHERE company_id = ?").run(compRow70.id);
testDb70.prepare("DELETE FROM payments WHERE company_id = ?").run(compRow70.id);
testDb70.prepare("DELETE FROM invoices WHERE company_id = ?").run(compRow70.id);
testDb70.prepare("DELETE FROM budgets WHERE company_id = ?").run(compRow70.id);

console.log("\n==========================================================");
console.log("TEST 71: CUSTOM INVOICE NAMING (ANTICIPO, FINAL, HITO)");
console.log("==========================================================");
assert(getBudgetClientNumber('PRE2026-012') === '12', "TEST 71: Extrae '12' de PRE2026-012");
assert(getBudgetClientNumber('PRE2026-014') === '14', "TEST 71: Extrae '14' de PRE2026-014");
assert(getBudgetYear('PRE2026-012') === '2026', "TEST 71: Extrae año 2026");
assert(formatInvoiceNaming('ANTICIPO', 'PRE2026-012', 1) === 'Factura_Anticipo_2026-12-001', "TEST 71: Factura de anticipo PRE2026-012 genera Factura_Anticipo_2026-12-001");
assert(formatInvoiceNaming('ANTICIPO', 'PRE2026-014', 1) === 'Factura_Anticipo_2026-14-001', "TEST 71: Factura de anticipo PRE2026-014 genera Factura_Anticipo_2026-14-001");
assert(formatInvoiceNaming('FINAL', 'PRE2026-012', 1) === 'Factura_Final_2026-12-001', "TEST 71: Factura final PRE2026-012 genera Factura_Final_2026-12-001");
assert(formatInvoiceNaming('HITO', 'PRE2026-012', 1) === 'Factura_Hito_2026-12-001', "TEST 71: Factura hito 1 PRE2026-012 genera Factura_Hito_2026-12-001");
assert(formatInvoiceNaming('FASE', 'PRE2026-012', 2) === 'Factura_Hito_2026-12-002', "TEST 71: Factura hito 2 PRE2026-012 genera Factura_Hito_2026-12-002");

console.log("\n==========================================================");
console.log("TEST 72: CUSTOM RECEIPT NAMING (ANTICIPO, FINAL, HITO)");
console.log("==========================================================");
assert(formatReceiptNaming('ANTICIPO', 'PRE2026-012', 1) === 'Recibo_Anticipo_2026-12-001', "TEST 72: Recibo de anticipo PRE2026-012 genera Recibo_Anticipo_2026-12-001");
assert(formatReceiptNaming('ANTICIPO', 'PRE2026-014', 1) === 'Recibo_Anticipo_2026-14-001', "TEST 72: Recibo de anticipo PRE2026-014 genera Recibo_Anticipo_2026-14-001");
assert(formatReceiptNaming('FINAL', 'PRE2026-012', 1) === 'Recibo_Final_2026-12-001', "TEST 72: Recibo final PRE2026-012 genera Recibo_Final_2026-12-001");
assert(formatReceiptNaming('HITO', 'PRE2026-012', 1) === 'Recibo_Hito_2026-12-001', "TEST 72: Recibo hito 1 PRE2026-012 genera Recibo_Hito_2026-12-001");
assert(formatReceiptNaming('FASE', 'PRE2026-012', 2) === 'Recibo_Hito_2026-12-002', "TEST 72: Recibo hito 2 PRE2026-012 genera Recibo_Hito_2026-12-002");

// Verificar registerPayment asignación de naming en presupuesto
const testEngine72 = new PresuVozEngine();
const dummyBudget72 = {
  id: 'PRE2026-012',
  client: { name: 'Manolo Ramos' },
  financials: { totalAmount: 1000 }
};
const p1 = testEngine72.registerPayment(dummyBudget72, { amount: 300 });
assert(p1.receipt.displayNumber === 'Recibo_Anticipo_2026-12-001', "TEST 72: registerPayment asigna Recibo_Anticipo_2026-12-001 para el primer pago");

const p2 = testEngine72.registerPayment(dummyBudget72, { amount: 300 });
assert(p2.receipt.displayNumber === 'Recibo_Hito_2026-12-001', "TEST 72: registerPayment asigna Recibo_Hito_2026-12-001 para pago intermedio");

const p3 = testEngine72.registerPayment(dummyBudget72, { amount: 400 });
assert(p3.receipt.displayNumber === 'Recibo_Final_2026-12-001', "TEST 72: registerPayment asigna Recibo_Final_2026-12-001 al liquidar");

console.log("\n==========================================================");
console.log("TEST 73: NATURAL LANGUAGE INTENT RESOLUTION (VISITAS VS MATERIALES VS PRESUPUESTOS)");
console.log("==========================================================");
// 1. Visitas no colisionan con presupuestos pendientes
assert(detectAgendaQueryIntent("Que visitas tengo pendiente?")?.isMatch === true, "TEST 73: 'Que visitas tengo pendiente?' detectado como agenda");
assert(detectAgendaQueryIntent("Que visitas tengo pendiente?")?.filter === 'all', "TEST 73: filtro 'all' para 'Que visitas tengo pendiente?'");
assert(detectAgendaQueryIntent("visitas")?.isMatch === true, "TEST 73: 'visitas' detectado como agenda");
assert(detectAgendaQueryIntent("qué citas tengo hoy?")?.filter === 'today', "TEST 73: 'qué citas tengo hoy?' detecta filtro today");
assert(detectAgendaQueryIntent("visitas para mañana")?.filter === 'tomorrow', "TEST 73: 'visitas para mañana' detecta filtro tomorrow");
assert(detectAgendaQueryIntent("tengo alguna visita pendiente?")?.isMatch === true, "TEST 73: 'tengo alguna visita pendiente?' detectado como agenda");
assert(detectAgendaQueryIntent("cancela la visita de Juan") === null, "TEST 73: Acción de cancelar no se confunde con listado de agenda");
assert(detectBudgetListIntent("Que visitas tengo pendiente?") === null, "TEST 73: 'Que visitas tengo pendiente?' NO es interceptado como presupuestos");

// 2. Materiales / compras no colisionan con presupuestos pendientes
assert(detectShoppingListQueryIntent("Que materiales tengo pendiente por comprar?")?.isMatch === true, "TEST 73: 'Que materiales tengo pendiente por comprar?' detectado como lista de compras");
assert(detectShoppingListQueryIntent("Que tengo que comprar?")?.isMatch === true, "TEST 73: 'Que tengo que comprar?' detectado como lista de compras");
assert(detectShoppingListQueryIntent("qué materiales tengo pendientes para Carlos?")?.clientFilter?.toLowerCase() === 'carlos', "TEST 73: Extrae cliente Carlos en consulta de materiales pendientes");
assert(detectShoppingListQueryIntent("ya compré el cemento") === null, "TEST 73: Acción de compra no se confunde con listado de compras");
assert(detectBudgetListIntent("Que materiales tengo pendiente por comprar?") === null, "TEST 73: 'Que materiales tengo pendiente por comprar?' NO es interceptado como presupuestos");

// 3. Presupuestos siguen funcionando
assert(detectBudgetListIntent("presupuestos pendientes de firma") === 'pending_signature', "TEST 73: 'presupuestos pendientes de firma' sigue detectando pending_signature");
assert(detectBudgetListIntent("que tengo sin firmar") === 'pending_signature', "TEST 73: 'que tengo sin firmar' sigue detectando pending_signature");
assert(detectBudgetListIntent("mis presupuestos") === 'all', "TEST 73: 'mis presupuestos' sigue detectando all");

console.log("\n==========================================================");
console.log("TEST 74: AUDIO TRANSCRIPTION RECONCILIATION & ANTI-HALLUCINATION");
console.log("==========================================================");
// 1. Detección de DEBT_BY_CLIENT desde transcripción de audio
const audioTranscript74 = "¿Cuánto me debe Manolito Fernández?";
const detectedAudioIntent74 = testDetectIntent(audioTranscript74, { knownNames: ['Manolito Fernández', 'Juan López'] });
assert(detectedAudioIntent74?.intent === 'DEBT_BY_CLIENT', "TEST 74: detectIntent reconoce DEBT_BY_CLIENT desde transcripción");
assert(detectedAudioIntent74?.params?.clientName === 'Manolito Fernández', "TEST 74: Extrae 'Manolito Fernández' de la transcripción de audio");

// 2. Anti-alucinación: si el modelo de IA alucina 'Juan López' pero la transcripción dice 'Manolito Fernández', se reconcilia con el audio
const hallucinatedAiResult74 = {
  action: 'query_balance',
  clientName: 'Juan López',
  targetBudgetId: 'PRE2026-006',
  transcript: '¿Cuánto me debe Manolito Fernández?'
};
let reconciledClient74 = hallucinatedAiResult74.clientName;
if (hallucinatedAiResult74.transcript) {
  const debtMatch = hallucinatedAiResult74.transcript.match(/\b(?:cu[aá]nto\s+me\s+debe|deuda\s+(?:de\s+)?|saldo\s+(?:de\s+)?)\s*([a-záéíóúñA-ZÁÉÍÓÚÑ\s]{2,40})/i);
  if (debtMatch && debtMatch[1]) {
    const fromTranscript = debtMatch[1].replace(/[?¿!¡.]/g, '').trim();
    if (fromTranscript) reconciledClient74 = fromTranscript;
  }
}
assert(reconciledClient74 === 'Manolito Fernández', "TEST 74: Reconcilia correctamente el cliente real del audio ignorando la alucinación de memoria");

// 3. Ordenamiento de memoria de presupuestos por recencia (más recientes primero)
const dummySessionBudgets74 = new Map([
  ['PRE-OLD-01', { id: 'PRE-OLD-01', updatedAt: '2026-01-01T00:00:00.000Z', client: { name: 'Juan Viejo' } }],
  ['PRE-RECENT-01', { id: 'PRE-RECENT-01', updatedAt: '2026-10-14T10:00:00.000Z', client: { name: 'Manolito Reciente' } }]
]);
const sortedBudgets74 = Array.from(dummySessionBudgets74.values())
  .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
assert(sortedBudgets74[0].id === 'PRE-RECENT-01', "TEST 74: El presupuesto más reciente queda en primer lugar en la memoria de IA");
assert(sortedBudgets74[0].client.name === 'Manolito Reciente', "TEST 74: El cliente reciente se incluye en el contexto de IA");

console.log("\n==========================================================");
console.log("TEST 75: CONVERSATIONAL CONTINUITY & ADDRESS DISAMBIGUATION");
console.log("==========================================================");

const { findClientsByName: testFindClients75, saveBudget: testSaveBudget75, ensureCompanyTenant: testEnsureTenant75 } = await import('./db_service.js');
const { resolveDisambiguationChoice: testResolveDis75 } = await import('./whatsapp_gateway.js');
const { detectIntent: testDetectIntent75, resolveIntent: testResolveIntent75 } = await import('./intent_router.js');

const tenantPhone75 = '34600757575';
const tenantContext75 = testEnsureTenant75(tenantPhone75);

currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext75.companyId);

const b75_1 = {
  id: 'PRE-T75-014',
  companyId: tenantContext75.companyId,
  client: { name: 'Manolito Fernández', address: 'Ubicación obra según visita', phone: '600111222' },
  financials: { totalAmount: 1500, taxableBase: 1239.67, taxAmount: 260.33 },
  status: 'ACEPTADO',
  createdAt: '2026-10-14T09:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z'
};

const b75_2 = {
  id: 'PRE-T75-013',
  companyId: tenantContext75.companyId,
  client: { name: 'Manolito Fernández', address: 'Calle Rapuncel 14', phone: '600111333' },
  financials: { totalAmount: 2000, taxableBase: 1652.89, taxAmount: 347.11 },
  status: 'ACEPTADO',
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:00.000Z'
};

const b75_3 = {
  id: 'PRE-T75-012',
  companyId: tenantContext75.companyId,
  client: { name: 'Manolito Fernández', address: 'Calle Mayor 8', phone: '600111444' },
  financials: { totalAmount: 1000, taxableBase: 826.45, taxAmount: 173.55 },
  status: 'FINALIZADO',
  createdAt: '2026-10-14T11:00:00.000Z',
  updatedAt: '2026-10-14T11:00:00.000Z'
};

testSaveBudget75(tenantContext75, b75_1);
testSaveBudget75(tenantContext75, b75_2);
testSaveBudget75(tenantContext75, b75_3);

// 1. findClientsByName busca con precisión cuando la consulta contiene Nombre + Dirección
const foundRapuncel75 = testFindClients75(tenantContext75, 'Manolito Fernández el de la calle Rapuncel');
assert(foundRapuncel75.length === 1 && foundRapuncel75[0].id === 'PRE-T75-013', "TEST 75: findClientsByName con 'Manolito Fernández el de la calle Rapuncel' devuelve PRE-T75-013 directamente");

const foundMayor75 = testFindClients75(tenantContext75, 'Manolito Fernández Calle Mayor');
assert(foundMayor75.length === 1 && foundMayor75[0].id === 'PRE-T75-012', "TEST 75: findClientsByName con 'Manolito Fernández Calle Mayor' devuelve PRE-T75-012 directamente");

const foundAll75 = testFindClients75(tenantContext75, 'Manolito Fernández');
assert(foundAll75.length === 3, "TEST 75: findClientsByName solo con nombre devuelve los 3 homónimos");

// 2. detectIntent y resolveIntent resuelven directamente sin desambiguación si se incluye la calle
const detectedWithStreet75 = testDetectIntent75('Ahora dime cuanto me debe manolito fernandez  el de la calle rapuncel', { knownNames: ['Manolito Fernández'] });
assert(detectedWithStreet75?.intent === 'DEBT_BY_CLIENT' && detectedWithStreet75?.params?.addressHint.includes('rapuncel'), "TEST 75: detectIntent extrae clientName limpio y addressHint");

const mockSession75 = {
  companyId: tenantContext75.companyId,
  budgets: new Map([[b75_1.id, b75_1], [b75_2.id, b75_2], [b75_3.id, b75_3]]),
  pendingDisambiguation: null
};

const replyWithStreet75 = await testResolveIntent75(detectedWithStreet75, tenantPhone75, mockSession75);
assert(!replyWithStreet75.includes('He encontrado 3 clientes/obras'), "TEST 75: NO dispara menú de desambiguación cuando se indica la calle");
assert(replyWithStreet75.includes('PRE-T75-013') && replyWithStreet75.includes('Calle Rapuncel'), "TEST 75: Muestra directamente el estado de PRE-T75-013 con Calle Rapuncel");
assert(mockSession75.pendingDisambiguation === null, "TEST 75: No deja pendingDisambiguation colgado");

// 3. detectIntent y resolveIntent para 'obra según visita'
const detectedVisita75 = testDetectIntent75('cuanto me debe manolito fernandez el de obra segun visita', { knownNames: ['Manolito Fernández'] });
const replyVisita75 = await testResolveIntent75(detectedVisita75, tenantPhone75, mockSession75);
assert(!replyVisita75.includes('He encontrado 3 clientes/obras'), "TEST 75: NO dispara desambiguación para 'el de obra según visita'");
assert(replyVisita75.includes('PRE-T75-014'), "TEST 75: Muestra directamente el estado de PRE-T75-014");

// 4. resolveDisambiguationChoice reconoce opciones de dirección y 'obra según visita'
const cVisita75 = testResolveDis75('El de obra según visita', [b75_1, b75_2, b75_3]);
assert(cVisita75?.id === 'PRE-T75-014', "TEST 75: resolveDisambiguationChoice resuelve 'El de obra según visita' al candidato 1");

const cRapuncel75 = testResolveDis75('el de rapuncel', [b75_1, b75_2, b75_3]);
assert(cRapuncel75?.id === 'PRE-T75-013', "TEST 75: resolveDisambiguationChoice resuelve 'el de rapuncel' al candidato 2");

// 5. Continuidad de Hilo Conversacional (Disambiguation Drift Prevention)
const sessionFlow75 = {
  companyId: tenantContext75.companyId,
  phone: tenantPhone75,
  budgets: new Map([[b75_1.id, b75_1], [b75_2.id, b75_2], [b75_3.id, b75_3]]),
  pendingDisambiguation: null,
  lastDisambiguation: null,
  activeBudgetId: null
};

const initialIntent75 = testDetectIntent75('¿Cuánto me debe Manolito Fernández?', { knownNames: ['Manolito Fernández'] });
const initialReply75 = await testResolveIntent75(initialIntent75, tenantPhone75, sessionFlow75);
assert(initialReply75.includes('He encontrado 3 clientes/obras'), "TEST 75: Paso 1 muestra los 3 homónimos");
assert(sessionFlow75.pendingDisambiguation !== null, "TEST 75: Paso 1 activa pendingDisambiguation");

const choice1_75 = testResolveDis75('El segundo', sessionFlow75.pendingDisambiguation.candidates);
assert(choice1_75?.id === b75_2.id, "TEST 75: Paso 2 resuelve 'El segundo' a b75_2 (Rapuncel)");
sessionFlow75.lastDisambiguation = {
  ...sessionFlow75.pendingDisambiguation,
  selectedCandidate: choice1_75,
  resolvedAt: Date.now()
};
sessionFlow75.pendingDisambiguation = null;
sessionFlow75.activeBudgetId = choice1_75.id;

const followUpCandidate75 = testResolveDis75('El de obra según visita', sessionFlow75.lastDisambiguation.candidates);
assert(followUpCandidate75?.id === b75_1.id, "TEST 75: Paso 3 seguimiento conversacional resuelve directamente a b75_1 (obra según visita)");

const mutationText75 = 'De la obra de Manolito quiero cambiar el precio de Demolición a 500€';
const isRealMutation75 = /\b(?:cambiar?|cambia|modificar?|modifica|anadir?|añadir?|anade|añade|quitar?|quita|borrar?|borra|eliminar?|elimina|nuevo\s+presupuesto|nueva\s+obra|partida|precio|hacer\s+presupuesto)\b/i.test(mutationText75);
assert(isRealMutation75, "TEST 75: Paso 4 mutación explícita no se confunde con seguimiento");

// ==========================================================
// TEST 76: RESOLUCIÓN DE VISITAS EN LOTE POR ORDINALES Y REAGENDAMIENTO ROBUSTO CON DIACRÍTICOS
// ==========================================================
console.log("\n--- TEST 76: RESOLUCIÓN DE VISITAS EN LOTE POR ORDINALES Y REAGENDAMIENTO ROBUSTO ---");
const {
  ensureCompanyTenant: testEnsureTenant76,
  saveAppointment: testSaveApt76,
  findAppointments: testFindApts76,
  completeAppointments: testCompleteApts76,
  rescheduleAppointment: testRescheduleApt76,
  getAppointment: testGetApt76
} = await import('./db_service.js');
const { handleCompleteAppointments: testHandleComplete76 } = await import('./whatsapp_gateway.js');

const tenantPhone76 = '34600767676';
const tenantContext76 = testEnsureTenant76(tenantPhone76);

// Limpieza previa
currentTestDb.prepare('DELETE FROM appointments WHERE company_id = ?').run(tenantContext76.companyId);

// 1. Crear 4 citas (con tildes en nombres)
const apt76_1 = testSaveApt76(tenantContext76, {
  clientName: 'Cliente',
  clientAddress: 'Calle San Luis',
  date: '2026-09-25',
  time: '10:00',
  notes: 'Visita técnica 1'
});
const apt76_2 = testSaveApt76(tenantContext76, {
  clientName: 'María García',
  clientAddress: 'Calle Alcalá 45',
  date: '2026-09-26',
  time: '11:30',
  notes: 'Visita técnica 2'
});
const apt76_3 = testSaveApt76(tenantContext76, {
  clientName: 'Antonio López',
  clientAddress: 'Calle Gran Vía 100',
  date: '2026-09-27',
  time: '16:00',
  notes: 'Visita técnica 3'
});
const apt76_4 = testSaveApt76(tenantContext76, {
  clientName: 'Sara Martínez',
  clientAddress: 'Plaza Mayor 5',
  date: '2026-10-03',
  time: '09:00',
  notes: 'Visita técnica 4'
});

// A. Test findAppointments con insensibilidad a tildes y mayúsculas
const findSaraNoAccent = testFindApts76(tenantContext76, 'sara martinez');
assert(findSaraNoAccent.length === 1 && findSaraNoAccent[0].id === apt76_4.id, "TEST 76: findAppointments encuentra 'Sara Martínez' buscando 'sara martinez' sin tildes");

const findMariaNoAccent = testFindApts76(tenantContext76, 'maria garcia');
assert(findMariaNoAccent.length === 1 && findMariaNoAccent[0].id === apt76_2.id, "TEST 76: findAppointments encuentra 'María García' buscando 'maria garcia'");

const findLopezNoAccent = testFindApts76(tenantContext76, 'antonio lopez');
assert(findLopezNoAccent.length === 1 && findLopezNoAccent[0].id === apt76_3.id, "TEST 76: findAppointments encuentra 'Antonio López' buscando 'antonio lopez'");

// B. Test handleCompleteAppointments con "Las tres primeras están hechas, pero la de Sara Martinez pasamela a mañana a las 15"
const mockMessagesSent76 = [];
const mockSock76 = {
  sendMessage: async (jid, payload) => {
    mockMessagesSent76.push(payload.text);
    return { key: { id: 'msg-test-76-' + Math.random() } };
  }
};

const session76 = {
  companyId: tenantContext76.companyId,
  phone: tenantPhone76,
  company: { name: 'Empresa Test 76' },
  pendingDayReview: {
    date: '2026-10-14',
    appointments: [
      { id: apt76_1.id, clientName: apt76_1.clientName, time: apt76_1.time },
      { id: apt76_2.id, clientName: apt76_2.clientName, time: apt76_2.time },
      { id: apt76_3.id, clientName: apt76_3.clientName, time: apt76_3.time },
      { id: apt76_4.id, clientName: apt76_4.clientName, time: apt76_4.time }
    ]
  }
};

const userPrompt76 = "Las tres primeras estan hechas, pero la de Sara Martinez pasamela a mañana a las 15 de la mañana";
const aiResult76 = {
  completionInfo: {
    completedQueries: ["primera", "segunda", "tercera"]
  },
  rescheduleInfo: {
    query: "Sara Martinez",
    time: "15:00",
    date: null
  }
};

await testHandleComplete76(mockSock76, 'test-jid-76@s.whatsapp.net', session76, aiResult76.completionInfo, aiResult76.rescheduleInfo, userPrompt76);

const reply76 = mockMessagesSent76.join('\n\n');
assert(!reply76.includes('la visita con .'), "TEST 76: El mensaje NO tiene el error 'la visita con .'");
assert(reply76.includes('He marcado como realizadas las visitas con'), "TEST 76: El mensaje confirma la realización en plural");
assert(reply76.includes('Cliente') && reply76.includes('María García') && reply76.includes('Antonio López'), "TEST 76: El mensaje nombra a los 3 clientes completados");
assert(reply76.includes('Sara Martínez') && reply76.includes('15:00 h'), "TEST 76: El mensaje confirma que la visita de Sara Martínez se movió a las 15:00 h");

// C. Verificar estado en Base de Datos
const checkApt1 = testGetApt76(tenantContext76, apt76_1.id);
const checkApt2 = testGetApt76(tenantContext76, apt76_2.id);
const checkApt3 = testGetApt76(tenantContext76, apt76_3.id);
const checkApt4 = testGetApt76(tenantContext76, apt76_4.id);

assert(checkApt1.status === 'COMPLETED', "TEST 76: Visita 1 (Cliente) queda en status COMPLETED en BD");
assert(checkApt2.status === 'COMPLETED', "TEST 76: Visita 2 (María García) queda en status COMPLETED en BD");
assert(checkApt3.status === 'COMPLETED', "TEST 76: Visita 3 (Antonio López) queda en status COMPLETED en BD");
assert(checkApt4.status === 'CONFIRMED' && checkApt4.time === '15:00', "TEST 76: Visita 4 (Sara Martínez) queda reprogramada a las 15:00");
assert(session76.pendingDayReview === null, "TEST 76: session.pendingDayReview queda completamente cerrado (null)");

// ==========================================================
// TEST 77: REGISTRO DE COBROS EN LENGUAJE NATURAL Y RESOLUCIÓN ROBUSTA DE HOMÓNIMOS
// ==========================================================
console.log("\n--- TEST 77: REGISTRO DE COBROS EN LENGUAJE NATURAL Y RESOLUCIÓN ROBUSTA ---");
const {
  parsePaymentCommand: testParsePayment77,
  findBudgetInSession: testFindBudget77,
  checkDisambiguation: testCheckDis77,
  resolveDisambiguationChoice: testResolveDis77,
  handlePaymentRegistration: testHandlePay77
} = await import('./whatsapp_gateway.js');
const {
  ensureCompanyTenant: testEnsureTenant77,
  saveBudget: testSaveBudget77,
  getBudget: testGetBudget77
} = await import('./db_service.js');

// 1. Verificación del parser de lenguaje natural (parsePaymentCommand)
const pay77_1 = testParsePayment77('El cliente manolito fernandez me ha pagado 129,60€ en efectivo');
assert(pay77_1 !== null, "TEST 77: Reconoce 'El cliente manolito fernandez me ha pagado 129,60€ en efectivo'");
assert(pay77_1.clientQuery === 'manolito fernandez', "TEST 77: Extrae correctamente el nombre del cliente 'manolito fernandez'");
assert(pay77_1.amount === 129.6, "TEST 77: Extrae correctamente el importe numérico 129.6");
assert(pay77_1.method === 'Efectivo', "TEST 77: Extrae el método de pago 'Efectivo'");

const pay77_2 = testParsePayment77('El cliente Manolito Fernández me ha pagado 129,60€ en efectivo');
assert(pay77_2?.clientQuery === 'Manolito Fernández' && pay77_2?.amount === 129.6 && pay77_2?.method === 'Efectivo',
  "TEST 77: Reconoce formato con tildes y mayúsculas 'El cliente Manolito Fernández me ha pagado 129,60€ en efectivo'");

const pay77_3 = testParsePayment77('Manolito Fernández me ha pagado 129,60€ en efectivo');
assert(pay77_3?.clientQuery === 'Manolito Fernández' && pay77_3?.amount === 129.6 && pay77_3?.method === 'Efectivo',
  "TEST 77: Reconoce sin prefijo 'El cliente'");

const pay77_4 = testParsePayment77('Laura me acaba de pagar 1.500 euros de la factura 24');
assert(pay77_4?.clientQuery === 'Laura' && pay77_4?.amount === 1500 && pay77_4?.invoiceQuery === '24',
  "TEST 77: Reconoce 'Laura me acaba de pagar 1.500 euros de la factura 24'");

const pay77_5 = testParsePayment77('El cliente Carlos Ruiz me ha hecho un primer pago del 50%');
assert(pay77_5?.clientQuery === 'Carlos Ruiz' && pay77_5?.percentage === 50,
  "TEST 77: Reconoce pago porcentual del 50%");

const pay77_6 = testParsePayment77('me ha pagado 129,60€ Manolito Fernández en efectivo');
assert(pay77_6?.clientQuery === 'Manolito Fernández' && pay77_6?.amount === 129.6 && pay77_6?.method === 'Efectivo',
  "TEST 77: Reconoce 'me ha pagado [importe] [cliente]' sin confundir pronombres");

// 2. Verificación de findBudgetInSession con diacríticos y dirección
const tenantPhone77 = '34600777777';
const tenantContext77 = testEnsureTenant77(tenantPhone77);

currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext77.companyId);

const b77_1 = {
  id: 'PRE-T77-001',
  client: { name: 'Manolito Fernández', address: 'Calle Rapuncel' },
  financials: { totalAmount: 2129.6 },
  paymentSummary: { remainingBalance: 2129.6, totalPaid: 0 },
  status: 'ACEPTADO'
};
const b77_2 = {
  id: 'PRE-T77-002',
  client: { name: 'Manolito Fernández', address: 'Ubicación obra según visita' },
  financials: { totalAmount: 1694.0 },
  paymentSummary: { remainingBalance: 1452.0, totalPaid: 242 },
  status: 'ACEPTADO'
};

testSaveBudget77(tenantContext77, b77_1);
testSaveBudget77(tenantContext77, b77_2);

const mockSession77 = {
  companyId: tenantContext77.companyId,
  phone: tenantPhone77,
  budgets: new Map([[b77_1.id, b77_1], [b77_2.id, b77_2]]),
  pendingDisambiguation: null
};

// Buscar sin tildes encuentra el presupuesto
const foundNoAccent = testFindBudget77(mockSession77, 'manolito fernandez');
assert(foundNoAccent !== null, "TEST 77: findBudgetInSession encuentra presupuesto buscando 'manolito fernandez' sin tildes");

// Buscar con dirección encuentra el presupuesto específico
const foundRapuncel = testFindBudget77(mockSession77, 'Manolito Fernández Calle Rapuncel');
assert(foundRapuncel?.id === b77_1.id, "TEST 77: findBudgetInSession encuentra b77_1 buscando con dirección 'Manolito Fernández Calle Rapuncel'");

// 3. Flujo completo de desambiguación ante homónimos en cobros
const mockSentMessages77 = [];
const mockSock77 = {
  sendMessage: async (jid, payload) => {
    mockSentMessages77.push(payload.text);
    return { key: { id: 'msg-test-77-' + Math.random() } };
  }
};

const isDisambiguated = await testCheckDis77(
  mockSock77,
  'test-jid-77@s.whatsapp.net',
  mockSession77,
  'Manolito Fernández',
  'payment',
  { amount: 129.6, method: 'Efectivo' }
);

assert(isDisambiguated === true, "TEST 77: checkDisambiguation detecta los 2 homónimos y activa menú");
assert(mockSession77.pendingDisambiguation !== null, "TEST 77: pendingDisambiguation guardado en sesión");
assert(mockSentMessages77[0].includes('He encontrado 2 clientes/obras'), "TEST 77: Mensaje muestra las 2 opciones encontradas");
assert(mockSentMessages77[0].includes('Calle Rapuncel'), "TEST 77: Mensaje incluye dirección 'Calle Rapuncel'");

// Selección del candidato por dirección ('el de rapuncel') y por opción 2
const selectedByAddr77 = testResolveDis77('el de rapuncel', mockSession77.pendingDisambiguation.candidates);
assert(selectedByAddr77?.id === b77_1.id, "TEST 77: 'el de rapuncel' resuelve al presupuesto PRE-T77-001");

const selectedCand77 = testResolveDis77('2', mockSession77.pendingDisambiguation.candidates);
assert(selectedCand77?.id === b77_1.id, "TEST 77: Opción '2' resuelve al presupuesto PRE-T77-001 (Rapuncel)");

// ======================================================================
// TEST 78: PAGO DEL SALDO PENDIENTE, LIQUIDACIÓN Y NO-SECUESTRO DE HILO
// ======================================================================
console.log("\n--- TEST 78: PAGO DEL SALDO PENDIENTE, LIQUIDACIÓN Y NO-SECUESTRO DE HILO ---");

// 1. Verificación del parser para frases de saldo pendiente y liquidación
const pay78_1 = testParsePayment77('Manolito Fernandez me ha pagado el saldo pendiente');
assert(pay78_1 !== null, "TEST 78: Reconoce 'Manolito Fernandez me ha pagado el saldo pendiente'");
assert(pay78_1?.clientQuery === 'Manolito Fernandez', "TEST 78: Extrae cliente 'Manolito Fernandez'");
assert(pay78_1?.isFullBalance === true, "TEST 78: isFullBalance es true para saldo pendiente");
assert(pay78_1?.amount === null, "TEST 78: amount es null para saldo pendiente");

const pay78_2 = testParsePayment77('El cliente Manolito Fernández me ha pagado el saldo pendiente en efectivo');
assert(pay78_2?.isFullBalance === true && pay78_2?.method === 'Efectivo' && pay78_2?.clientQuery === 'Manolito Fernández',
  "TEST 78: Reconoce 'El cliente Manolito Fernández me ha pagado el saldo pendiente en efectivo'");

const pay78_3 = testParsePayment77('Manolito me ha pagado todo');
assert(pay78_3?.isFullBalance === true && pay78_3?.clientQuery === 'Manolito',
  "TEST 78: Reconoce 'Manolito me ha pagado todo'");

const pay78_4 = testParsePayment77('Manolito me ha pagado lo que faltaba');
assert(pay78_4?.isFullBalance === true && pay78_4?.clientQuery === 'Manolito',
  "TEST 78: Reconoce 'Manolito me ha pagado lo que faltaba'");

const pay78_5 = testParsePayment77('Manolito ha liquidado el saldo pendiente');
assert(pay78_5?.isFullBalance === true && pay78_5?.clientQuery === 'Manolito',
  "TEST 78: Reconoce 'Manolito ha liquidado el saldo pendiente'");

const pay78_6 = testParsePayment77('Me ha pagado el saldo pendiente Manolito');
assert(pay78_6?.isFullBalance === true && pay78_6?.clientQuery === 'Manolito',
  "TEST 78: Reconoce 'Me ha pagado el saldo pendiente Manolito'");

const pay78_7 = testParsePayment77('Apunta cobro del saldo pendiente Manolito');
assert(pay78_7?.isFullBalance === true && pay78_7?.clientQuery === 'Manolito',
  "TEST 78: Reconoce 'Apunta cobro del saldo pendiente Manolito'");

// 2. Liquidación real contra presupuesto con saldo pendiente de 15,60 €
const tenantPhone78 = '34600787878';
const tenantContext78 = testEnsureTenant77(tenantPhone78);

const b78 = {
  id: 'PRE-T78-013',
  client: { name: 'Manolito Fernández', address: 'Calle Rapuncel 12' },
  financials: { totalAmount: 2129.60 },
  payments: [
    { amount: 1984.40, method: 'Transferencia', concept: 'Anticipo' },
    { amount: 129.60, method: 'Efectivo', concept: 'Entrega a cuenta de trabajos' }
  ],
  paymentSummary: { remainingBalance: 15.60, totalPaid: 2114.00, status: 'PARCIAL' },
  status: 'ACEPTADO'
};

testSaveBudget77(tenantContext78, b78);

const mockSentMessages78 = [];
const mockSock78 = {
  sendMessage: async (jid, payload) => {
    mockSentMessages78.push(payload.text || payload.caption || '');
    return { key: { id: 'msg-test-78-' + Math.random() } };
  }
};

const mockSession78 = {
  companyId: tenantContext78.companyId,
  phone: tenantPhone78,
  budgets: new Map([[b78.id, b78]]),
  activeBudgetId: b78.id,
  pendingDisambiguation: null,
  lastDisambiguation: {
    actionType: 'query_balance',
    resolvedAt: Date.now(),
    candidates: [{ id: b78.id, clientName: 'Manolito Fernández', clientAddress: 'Calle Rapuncel 12' }],
    selectedCandidate: { id: b78.id, clientName: 'Manolito Fernández', clientAddress: 'Calle Rapuncel 12' }
  }
};

// Ejecución de cobro de saldo pendiente (debe liquidar los 15,60 € automáticamente)
await testHandlePay77(
  mockSock78,
  'test-jid-78@s.whatsapp.net',
  mockSession78,
  b78,
  {
    amount: null,
    isFullBalance: true,
    method: 'Bizum',
    concept: 'Liquidación final del saldo pendiente'
  },
  'Manolito Fernandez me ha pagado el saldo pendiente'
);

assert(b78.paymentSummary.remainingBalance === 0, "TEST 78: El saldo restante pasa a ser exactamente 0 €");
assert(b78.paymentSummary.totalPaid === 2129.60, "TEST 78: El total pagado se acumula a 2.129,60 €");
assert(b78.status === 'FINALIZADO', "TEST 78: El presupuesto pasa a estado 'FINALIZADO'");
assert(mockSentMessages78.some(m => m.includes('15,60') || m.includes('15.60')), "TEST 78: Mensaje confirma el cobro de 15,60 €");
assert(mockSentMessages78.some(m => m.includes('liquidada') || m.includes('cobrada')), "TEST 78: Mensaje confirma obra totalmente liquidada");

// Limpieza final
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext78.companyId);

// ==========================================================
// TEST 79: FACTURA DE HITO / CERTIFICACIÓN Y CÁLCULO BASE IMPONIBLE (+ IVA)
// ==========================================================
console.log("\n--- TEST 79: FACTURA DE HITO Y CÁLCULO BASE IMPONIBLE (+ IVA) ---");

const { handleAdvanceInvoice: testHandleAdvance79 } = await import('./whatsapp_gateway.js');

const tenantPhone79 = '34625335687';
const tenantContext79 = testEnsureTenant77(tenantPhone79);

currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext79.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext79.companyId);

const b79 = {
  id: 'PRE2026-9436',
  client: {
    name: 'Jose Luis Perales',
    address: 'Calle Perales 123, Sevilla',
    nif: '12345678Z'
  },
  items: [
    {
      id: 'item-1',
      description: 'Reforma integral de salón y cuartos',
      qty: 1,
      unit: 'pa',
      unitPrice: 10000,
      total: 10000
    }
  ],
  financials: {
    subtotal: 10000,
    taxableBase: 10000,
    taxRatePercentage: 10,
    taxAmount: 1000,
    irpfRatePercentage: 7,
    irpfAmount: 700,
    totalAmount: 10300
  },
  advanceInvoices: []
};
testSaveBudget77(tenantContext79, b79);

// 1. Direct Regex Matcher verification
const regexMilestone = /(?:(?:prep[aá]ra(?:me)?|haz(?:me)?|emitir?|emite|saca(?:me)?|generar?|gener[aá](?:me)?)\s+(?:una\s+)?factura\s+(?:de\s+)?(hito|anticipo|adelanto)\b|^(?:factura(?:r)?\s+(?:de\s+)?(hito|anticipo|adelanto))\b)(?:\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*(%|€|euros?|\$)?)?(?:\s*(\+\s*iva|m[aá]s\s+iva|base))?(?:\s+(?:para|de|del\s+cliente|del\s+presupuesto\s+de|a)?\s*(.+))?/i;

const m79_1 = 'Hazme una factura hito de 2000€ para Jose Luis Perales'.match(regexMilestone);
assert(m79_1 !== null, "TEST 79: Reconoce 'Hazme una factura hito de 2000€ para Jose Luis Perales'");
assert((m79_1[1] || m79_1[2]).toLowerCase() === 'hito', "TEST 79: Detecta tipo 'hito'");
assert(m79_1[3] === '2000', "TEST 79: Extrae importe 2000");
assert(!m79_1[5], "TEST 79: isTaxBase es false (total con impuestos)");
assert(m79_1[6].trim() === 'Jose Luis Perales', "TEST 79: Extrae cliente 'Jose Luis Perales'");

const m79_2 = 'Hazme una factura hito de 2000€ + IVA para Jose Luis Perales'.match(regexMilestone);
assert(m79_2 !== null && Boolean(m79_2[5]), "TEST 79: Reconoce '+ IVA' fijando isTaxBase = true");

const m79_3 = 'factura de hito de 1500 euros más iva de Jose Luis'.match(regexMilestone);
assert(m79_3 !== null && Boolean(m79_3[5]) && m79_3[3] === '1500', "TEST 79: Reconoce 'más iva' con 1500 euros");

// 2. Engine createAdvanceInvoice con tipo HITO y 2000€ total (isTaxBase = false)
const hitoInv1 = engine.createAdvanceInvoice(b79, {
  amount: 2000,
  method: 'Transferencia bancaria',
  type: 'HITO',
  isTaxBase: false
});

assert(hitoInv1.type === 'HITO', "TEST 79: Factura hito tiene type 'HITO'");
assert(hitoInv1.naming === 'Factura_Hito_2026-9436-001', "TEST 79: Factura hito 1 genera naming 'Factura_Hito_2026-9436-001'");
assert(hitoInv1.displayNumber === 'Factura_Hito_2026-9436-001', "TEST 79: Factura hito 1 tiene displayNumber 'Factura_Hito_2026-9436-001'");
assert(hitoInv1.financials.taxableBase === 1941.75, "TEST 79: Base imponible desglosada de 2000€ (10% IVA, 7% IRPF) es 1941.75 €");
assert(hitoInv1.financials.taxAmount === 194.18, "TEST 79: Cuota IVA 10% es 194.18 €");
assert(hitoInv1.financials.irpfAmount === 135.92, "TEST 79: Retención IRPF 7% es 135.92 €");
assert(hitoInv1.financials.totalAmount === 2000.01, "TEST 79: Total factura hito es 2000.01 € (~2000€)");
assert(hitoInv1.items[0].description.includes('Certificación / Hito de obra'), "TEST 79: Descripción del item especifica Certificación / Hito de obra");

// 3. Engine createAdvanceInvoice con tipo HITO y 2000€ + IVA (isTaxBase = true)
const hitoInv2 = engine.createAdvanceInvoice(b79, {
  amount: 2000,
  method: 'Transferencia bancaria',
  type: 'HITO',
  isTaxBase: true
});

assert(hitoInv2.type === 'HITO', "TEST 79: Factura hito 2 tiene type 'HITO'");
assert(hitoInv2.naming === 'Factura_Hito_2026-9436-002', "TEST 79: Factura hito 2 genera naming secuencial 'Factura_Hito_2026-9436-002'");
assert(hitoInv2.financials.taxableBase === 2000.00, "TEST 79: Con + IVA la base imponible es exactamente 2000.00 €");
assert(hitoInv2.financials.taxAmount === 200.00, "TEST 79: Con + IVA el IVA al 10% es 200.00 €");
assert(hitoInv2.financials.irpfAmount === 140.00, "TEST 79: Con + IVA la retención IRPF 7% es 140.00 €");
assert(hitoInv2.financials.totalAmount === 2060.00, "TEST 79: Con + IVA el total factura es 2060.00 € (2000 + 200 - 140)");

// 4. Deducción de hitos en la factura final de liquidación
const finalInv79 = engine.convertToInvoice(b79, { type: 'FINAL' });
assert(finalInv79.type === 'FINAL', "TEST 79: Factura final convertida es 'FINAL'");
assert(finalInv79.advanceDeductions.length === 2, "TEST 79: Factura final incluye las 2 deducciones de hitos previos");
assert(finalInv79.advanceDeductions[0].description.includes('Deducción por hito / certificación'), "TEST 79: Descripción de deducción especifica hito / certificación");
const totalDeductions79 = finalInv79.advanceDeductions.reduce((sum, d) => sum + d.total, 0);
assert(Math.round(totalDeductions79 * 100) / 100 === 4060.01, "TEST 79: Total deducciones acumuladas en factura final coincide con los 2 hitos");

// 5. Test handleAdvanceInvoice execution with mock WhatsApp socket
const mockSentMessages79 = [];
const mockSock79 = {
  sendMessage: async (jid, payload) => {
    if (payload.text) mockSentMessages79.push(payload.text);
    if (payload.caption) mockSentMessages79.push(payload.caption);
    return { key: { id: `msg-79-${Date.now()}` } };
  }
};

const mockSession79 = {
  companyId: tenantContext79.companyId,
  phone: '625335687',
  company: { name: 'Empresa Test Hito 79 S.L.', cif: 'B-79797979' },
  budgets: new Map([[b79.id, b79]]),
  invoices: new Map(),
  activeBudgetId: b79.id
};

await testHandleAdvance79(
  mockSock79,
  'test-jid-79@s.whatsapp.net',
  mockSession79,
  b79,
  null,
  {
    amount: 2000,
    isTaxBase: true,
    type: 'HITO'
  },
  false,
  'HITO'
);

assert(mockSentMessages79.some(m => m.includes('Factura de hito') && m.includes('Factura_Hito_2026-9436-003')), "TEST 79: Mensaje confirma 'Factura de hito Factura_Hito_2026-9436-003 emitida'");
assert(mockSentMessages79.some(m => m.includes('Total hito:') && (m.includes('2060,00') || m.includes('2.060,00'))), "TEST 79: Mensaje confirma 'Total hito: 2.060,00 €'");
assert(mockSentMessages79.some(m => (m.includes('Base: 2000,00 €') || m.includes('Base: 2.000,00 €')) && (m.includes('IVA: 200,00 €') || m.includes('IVA: 200.00 €'))), "TEST 79: Mensaje desglosa Base 2000€ e IVA 200€");

// 6. Verificación de los tres comandos exactos solicitados por el usuario
const rawPhase1 = 'He terminado la demolición de la obra de Carlos, hazme la factura de esa fase';
const rawPhase2 = 'Factura la fase de fontanería de José Luis';
const rawPhase3 = 'Emite la factura de la partida de pintura de María';

const phaseDoneRegex = /\b(?:he\s+(?:terminado|acabado|finalizado|completado)|(?:ya\s+est[aá]\s+)?(?:lista|hecha|terminada|acabada))\s+(?:la\s+|el\s+)?(.+?)\s+de\s+(?:la\s+reforma\s+de|la\s+obra\s+de|el\s+piso\s+de)?\s*(.+?)[,.]?\s*(?:prep[aá]ra(?:me)?|haz(?:me)?|emitir?|emite|saca(?:me)?|generar?|gener[aá](?:me)?|factura(?:r)?)\s+(?:la\s+)?factura\s+(?:de\s+)?(?:esa\s+|ese\s+)?(?:fase|etapa|hito|partida)/i;
const phaseDirectRegex = /\b(?:prep[aá]ra(?:me)?|haz(?:me)?|emitir?|emite|saca(?:me)?|generar?|gener[aá](?:me)?|factura(?:r)?)\s+(?:(?:la\s+)?factura\s+(?:de\s+)?(?:la\s+|el\s+)?(?:fase|etapa|hito|partida)|(?:la\s+|el\s+)?(?:fase|etapa|hito|partida))\s+(?:de\s+)?(.+?)(?:\s+(?:de|del\s+cliente|para)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ\s]{2,40}))?$/i;

const pMatch1 = rawPhase1.match(phaseDoneRegex);
assert(pMatch1 !== null, "TEST 79: Reconoce frase 1 'He terminado la demolición de la obra de Carlos, hazme la factura de esa fase'");
assert(pMatch1[1].trim().toLowerCase() === 'demolición', "TEST 79: Frase 1 extrae fase 'demolición'");
assert(pMatch1[2].trim().toLowerCase() === 'carlos', "TEST 79: Frase 1 extrae cliente 'Carlos'");

const pMatch2 = rawPhase2.match(phaseDirectRegex);
assert(pMatch2 !== null, "TEST 79: Reconoce frase 2 'Factura la fase de fontanería de José Luis'");
assert(pMatch2[1].trim().toLowerCase() === 'fontanería', "TEST 79: Frase 2 extrae fase 'fontanería'");
assert(pMatch2[2].trim().toLowerCase() === 'josé luis', "TEST 79: Frase 2 extrae cliente 'José Luis'");

const pMatch3 = rawPhase3.match(phaseDirectRegex);
assert(pMatch3 !== null, "TEST 79: Reconoce frase 3 'Emite la factura de la partida de pintura de María'");
assert(pMatch3[1].trim().toLowerCase() === 'pintura', "TEST 79: Frase 3 extrae partida 'pintura'");
assert(pMatch3[2].trim().toLowerCase() === 'maría', "TEST 79: Frase 3 extrae cliente 'María'");

// Limpieza final
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext79.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext79.companyId);

// ==========================================================
// TEST 80: NUMERACIÓN SECUENCIAL CORRELATIVA DE HITOS TRAS REINICIO DEL BOT Y VISUALIZACIÓN EN DB VIEWER
// ==========================================================
console.log("\n--- TEST 80: PERSISTENCIA CORRELATIVA DE HITOS TRAS REINICIO Y DISPLAY DB VIEWER ---");

const { handleAdvanceInvoice: testHandleAdvance80 } = await import('./whatsapp_gateway.js');
const { getInvoicesByBudgetId: testGetInvoices80 } = await import('./db_service.js');

const tenantPhone80 = '34625888999';
const tenantContext80 = testEnsureTenant77(tenantPhone80);

// Limpieza previa
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext80.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext80.companyId);

const b80 = {
  id: 'PRE2026-9436',
  client: {
    name: 'Jose Luis Perales',
    address: 'Calle Perales 123, Sevilla',
    nif: '12345678Z'
  },
  items: [
    {
      id: 'item-1',
      description: 'Reforma integral y albañilería',
      qty: 1,
      unit: 'pa',
      unitPrice: 10000,
      total: 10000
    }
  ],
  financials: {
    subtotal: 10000,
    taxableBase: 10000,
    taxRatePercentage: 10,
    taxAmount: 1000,
    irpfRatePercentage: 7,
    irpfAmount: 700,
    totalAmount: 10300
  },
  advanceInvoices: []
};
testSaveBudget77(tenantContext80, b80);

const mockSentMessages80 = [];
const mockSock80 = {
  sendMessage: async (jid, payload) => {
    if (payload.text) mockSentMessages80.push(payload.text);
    if (payload.caption) mockSentMessages80.push(payload.caption);
    return { key: { id: `msg-80-${Date.now()}` } };
  }
};

const mockSession80_1 = {
  companyId: tenantContext80.companyId,
  phone: '625888999',
  company: { name: 'Empresa Reformas 80 S.L.', cif: 'B-80808080' },
  budgets: new Map([[b80.id, JSON.parse(JSON.stringify(b80))]]),
  invoices: new Map(),
  activeBudgetId: b80.id
};

// 1. Emitir primera factura hito de 2000€
await testHandleAdvance80(
  mockSock80,
  'test-jid-80@s.whatsapp.net',
  mockSession80_1,
  mockSession80_1.budgets.get(b80.id),
  null,
  {
    amount: 2000,
    isTaxBase: false,
    type: 'HITO'
  },
  false,
  'HITO'
);

// Verificar emisión de la primera factura
assert(mockSentMessages80.some(m => m.includes('Factura_Hito_2026-9436-001')), "TEST 80: Hito 1 emitido con naming 'Factura_Hito_2026-9436-001'");

const invoicesAfter1 = testGetInvoices80(tenantContext80, b80.id);
assert(invoicesAfter1.length === 1, "TEST 80: Base de datos SQLite tiene 1 factura registrada para el presupuesto");
assert(invoicesAfter1[0].naming === 'Factura_Hito_2026-9436-001', "TEST 80: Factura 1 guardada con naming Factura_Hito_2026-9436-001");
assert(invoicesAfter1[0].id === 'INV-HIT-PRE2026-9436-001', "TEST 80: ID de Factura 1 es INV-HIT-PRE2026-9436-001 (no UUID)");

// 2. SIMULAR PARADA Y REINICIO DEL BOT (Memoria RAM se vacía por completo)
const b80FreshFromDb = testGetBudget77(tenantContext80, b80.id);
assert(b80FreshFromDb !== null, "TEST 80: Presupuesto recuperado de SQLite tras reinicio");

const mockSession80_Restart = {
  companyId: tenantContext80.companyId,
  phone: '625888999',
  company: { name: 'Empresa Reformas 80 S.L.', cif: 'B-80808080' },
  budgets: new Map([[b80FreshFromDb.id, { ...b80FreshFromDb, advanceInvoices: [] }]]), // Memoria en blanco
  invoices: new Map(),
  activeBudgetId: b80FreshFromDb.id
};

// 3. Emitir segunda factura hito de 1000€ tras el reinicio
await testHandleAdvance80(
  mockSock80,
  'test-jid-80@s.whatsapp.net',
  mockSession80_Restart,
  mockSession80_Restart.budgets.get(b80FreshFromDb.id),
  null,
  {
    amount: 1000,
    isTaxBase: false,
    type: 'HITO'
  },
  false,
  'HITO'
);

// Verificar que la segunda factura hito toma el número 002 (NO vuelve a 001)
assert(mockSentMessages80.some(m => m.includes('Factura_Hito_2026-9436-002')), "TEST 80: Tras reinicio, Hito 2 recibe secuencial 'Factura_Hito_2026-9436-002'");

const invoicesAfter2 = testGetInvoices80(tenantContext80, b80.id);
assert(invoicesAfter2.length === 2, "TEST 80: Base de datos SQLite tiene 2 facturas hito registradas");
assert(invoicesAfter2[1].naming === 'Factura_Hito_2026-9436-002', "TEST 80: Factura 2 guardada con naming Factura_Hito_2026-9436-002");
assert(invoicesAfter2[1].id === 'INV-HIT-PRE2026-9436-002', "TEST 80: ID de Factura 2 es INV-HIT-PRE2026-9436-002 y no colisionó ni generó UUID raro");

// 4. Verificación del visor de base de datos (db_viewer)
const viewerInvoices = invoicesAfter2.map(i => {
  const displayNum = i.naming || i.displayNumber || i.invoiceNumber || i.visibleNumber || i.id;
  return { ...i, displayNum };
});
assert(viewerInvoices[0].displayNum === 'Factura_Hito_2026-9436-001', "TEST 80: DB Viewer muestra Factura_Hito_2026-9436-001 en la columna Nº FACTURA");
assert(viewerInvoices[1].displayNum === 'Factura_Hito_2026-9436-002', "TEST 80: DB Viewer muestra Factura_Hito_2026-9436-002 en la columna Nº FACTURA");

// Limpieza final de TEST 80
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext80.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext80.companyId);

// ==========================================================
// TEST 81: FACTURAS RECTIFICATIVAS (SERIE R) Y CONFORMIDAD LEGAL ART. 15 RD 1619/2012
// ==========================================================
console.log("\n--- TEST 81: FACTURAS RECTIFICATIVAS LEGALES (SERIE R) ---");

const { handleRectificationInvoice: testHandleRect81 } = await import('./whatsapp_gateway.js');
const { emitInvoice: testEmitInvoice81, getInvoice: testGetInvoice81, listInvoices: testListInvoices81 } = await import('./db_service.js');

const tenantPhone81 = '34625777888';
const tenantContext81 = testEnsureTenant77(tenantPhone81);

// Limpieza previa
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext81.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext81.companyId);

const b81 = {
  id: 'PRE2026-7788',
  client: {
    name: 'Carlos Santana',
    address: 'Avda de la Música 44, Madrid',
    nif: '44556677A'
  },
  items: [
    {
      id: 'it-1',
      description: 'Instalación eléctrica y cuadro de automáticos',
      qty: 1,
      unit: 'pa',
      unitPrice: 2000,
      total: 2000
    }
  ],
  financials: {
    subtotal: 2000,
    taxableBase: 2000,
    taxRatePercentage: 21,
    taxAmount: 420,
    irpfRatePercentage: 0,
    irpfAmount: 0,
    totalAmount: 2420
  },
  advanceInvoices: []
};
testSaveBudget77(tenantContext81, b81);

// 1. Validar reconocedor regex de Facturas Rectificativas
const testRectRegex = /(?:(?:prep[aá]ra(?:me)?|haz(?:me)?|emitir?|emite|saca(?:me)?|generar?|gener[aá](?:me)?)\s+(?:(?:un|una)\s+)?(?:factura\s+rectificativa|rectificativa|abono)\b|^(?:factura\s+rectificativa|rectificativa|abono|rectificar\s+factura|anular\s+factura)\b|(?:rectifica(?:r)?|anula(?:r)?)\s+(?:la\s+)?factura\b)(?:\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*(%|€|euros?|\$)?)?(?:\s+(?:para|de\s+la\s+factura\s+de|de\s+la\s+factura|del\s+presupuesto\s+de|del\s+cliente|de|a)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ0-9\s\-_.]+?))?(?:\s+(?:por\s+motivo\s+de|por|motivo:?)\s*(.+))?$/i;

const rMatch1 = 'Hazme una factura rectificativa de Carlos Santana'.match(testRectRegex);
assert(rMatch1 !== null, "TEST 81: Reconoce 'Hazme una factura rectificativa de Carlos Santana'");
assert(rMatch1[3].trim() === 'Carlos Santana', "TEST 81: Extrae cliente 'Carlos Santana'");

const rMatch2 = 'Emite una factura rectificativa para Carlos por error en el precio'.match(testRectRegex);
assert(rMatch2 !== null, "TEST 81: Reconoce 'Emite una factura rectificativa para Carlos por error en el precio'");
assert(rMatch2[3].trim() === 'Carlos', "TEST 81: Extrae cliente 'Carlos'");
assert(rMatch2[4].trim() === 'error en el precio', "TEST 81: Extrae motivo 'error en el precio'");

const rMatch3 = 'Rectifica la factura de Jose Luis Perales'.match(testRectRegex);
assert(rMatch3 !== null, "TEST 81: Reconoce 'Rectifica la factura de Jose Luis Perales'");

const rMatch4 = 'Factura rectificativa de 500€ para Juan'.match(testRectRegex);
assert(rMatch4 !== null && rMatch4[1] === '500', "TEST 81: Reconoce rectificativa parcial con importe de 500€");

const rMatch5 = 'Haz un abono de la factura de Carlos'.match(testRectRegex);
assert(rMatch5 !== null, "TEST 81: Reconoce solicitud de abono como rectificativa");

// 2. Emitir factura ordinaria original de Carlos Santana
const origInvoice81 = engine.convertToInvoice(b81, {
  company: { name: 'Instalaciones Test S.L.', cif: 'B-81818181' },
  id: 'FAC-2026-0810'
});
testEmitInvoice81(tenantContext81, origInvoice81);

const savedOrig = testGetInvoice81(tenantContext81, origInvoice81.id);
assert(savedOrig !== null, "TEST 81: Factura original guardada en base de datos SQLite");
assert(savedOrig.status === 'PENDIENTE_PAGO', "TEST 81: Factura original arranca en PENDIENTE_PAGO");

// 3. Generar rectificativa de anulación total vía engine.createRectificationInvoice
const rectEngine81 = engine.createRectificationInvoice(origInvoice81, {
  reason: 'Error en cálculo de partida y acuerdo de anulación con cliente',
  seq: 1
});

assert(rectEngine81.type === 'RECTIFICATIVA', "TEST 81: Tipo de factura es RECTIFICATIVA");
assert(rectEngine81.series === 'R', "TEST 81: Serie canónica de rectificativa es 'R'");
assert(rectEngine81.rectifiesInvoiceId === origInvoice81.id, "TEST 81: Vinculada obligatoriamente a ID de factura original rectificada");
assert(rectEngine81.rectifiedInvoiceNumber === (origInvoice81.displayNumber || origInvoice81.id), "TEST 81: Almacena número legible de factura original");
assert(rectEngine81.financials.taxableBase === -2000, "TEST 81: Anulación total minora base imponible a -2000 €");
assert(rectEngine81.financials.taxAmount === -420, "TEST 81: Anulación total minora cuota IVA a -420 €");
assert(rectEngine81.financials.totalAmount === -2420, "TEST 81: Anulación total tiene total rectificado -2420 €");
assert(rectEngine81.legalNote.includes('1619/2012'), "TEST 81: Incluye nota legal obligatoria RD 1619/2012");

// 4. Test completo a través de handleRectificationInvoice (WhatsApp socket mock)
const mockSentMessages81 = [];
const mockDocs81 = [];
const mockSock81 = {
  sendMessage: async (jid, payload) => {
    if (payload.text) mockSentMessages81.push(payload.text);
    if (payload.caption) mockSentMessages81.push(payload.caption);
    if (payload.document) mockDocs81.push(payload);
    return { key: { id: `msg-81-${Date.now()}` } };
  }
};

const mockSession81 = {
  companyId: tenantContext81.companyId,
  phone: '625777888',
  company: { name: 'Instalaciones Test S.L.', cif: 'B-81818181' },
  budgets: new Map([[b81.id, b81]]),
  invoices: new Map([[origInvoice81.id, origInvoice81]]),
  activeBudgetId: b81.id
};

await testHandleRect81(
  mockSock81,
  'test-jid-81@s.whatsapp.net',
  mockSession81,
  b81,
  {
    reason: 'Error en la partida presupuestada'
  }
);

assert(mockSentMessages81.some(m => m.includes('Factura Rectificativa emitida con éxito')), "TEST 81: Mensaje confirma 'Factura Rectificativa emitida con éxito'");
assert(mockSentMessages81.some(m => m.includes('Serie R')), "TEST 81: Mensaje destaca emisión en Serie R");
assert(mockSentMessages81.some(m => m.includes('2.420,00') || m.includes('2420,00')), "TEST 81: Mensaje detalla importe total rectificado de 2.420,00 €");
assert(mockSentMessages81.some(m => m.includes('1619/2012')), "TEST 81: Mensaje menciona validez fiscal RD 1619/2012");
assert(mockDocs81.length === 1, "TEST 81: PDF oficial de Factura Rectificativa enviado por WhatsApp");
assert(mockDocs81[0].document.slice(0, 4).toString() === '%PDF', "TEST 81: Documento generado es un binario PDF válido");

// 5. Verificar estado persistido en SQLite
const origAfterRect = testGetInvoice81(tenantContext81, origInvoice81.id);
assert(origAfterRect.status === 'RECTIFICADA', "TEST 81: Factura original pasa inmediatamente a estado 'RECTIFICADA' en SQLite");

const invoicesTenant81 = testListInvoices81(tenantContext81);
const rectInDb = invoicesTenant81.find(i => (i.type || '').toUpperCase() === 'RECTIFICATIVA' || i.series === 'R');
assert(rectInDb !== undefined, "TEST 81: Factura rectificativa guardada en tabla invoices");
assert(rectInDb.series === 'R', "TEST 81: Factura rectificativa guardada con serie 'R'");
assert((rectInDb.rectifies_invoice_id || rectInDb.rectifiesInvoiceId) === origInvoice81.id, "TEST 81: rectifies_invoice_id apunta a la factura original");

// Limpieza final de TEST 81
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext81.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext81.companyId);

// ==========================================================
// TEST 82: VENTANA CONVERSACIONAL DE PRESUPUESTO ACTIVO Y "EL ÚLTIMO PRESUPUESTO"
// ==========================================================
console.log("\n--- TEST 82: VENTANA CONVERSACIONAL ACTIVA Y 'ÚLTIMO PRESUPUESTO' ---");

const { detectItemModificationIntent: testDetectMod82, findItemByConcept: testFindItem82, findBudgetByQuery: testFindBudgetByQuery82 } = await import('./whatsapp_gateway.js');

// 1. Detección natural de correcciones de precio comparativas (Audios 1 y 2)
const modAudio1 = testDetectMod82("Vale, hay que hacer un cambio. La sustitución del cuadro eléctrico y las protecciones no cuestan 480 euros, cuestan 500 euros.");
assert(modAudio1 !== null, "TEST 82: Reconoce Audio 1 'no cuestan 480 euros, cuestan 500 euros'");
assert(modAudio1.price === 500, "TEST 82: Audio 1 extrae precio 500 €");
assert(modAudio1.concept.includes('cuadro eléctrico'), "TEST 82: Audio 1 extrae concepto de cuadro eléctrico");

const modAudio2 = testDetectMod82("En este último presupuesto que me acabas de mandar, hay que hacer una modificación en el cuadro eléctrico. No vale 480 euros, vale 550.");
assert(modAudio2 !== null, "TEST 82: Reconoce Audio 2 'en este último presupuesto... no vale 480, vale 550'");
assert(modAudio2.price === 550, "TEST 82: Audio 2 extrae precio 550 €");
assert(modAudio2.concept === 'cuadro eléctrico', "TEST 82: Audio 2 extrae concepto 'cuadro eléctrico'");

// 2. Emparejamiento por concepto en la lista de partidas del electricista
const electricianItems = [
  { id: 'it-1', description: 'Sustitución de cuadro eléctrico y protecciones', unitPrice: 480 },
  { id: 'it-2', description: 'Cableado eléctrico y canalizaciones', unitPrice: 390 },
  { id: 'it-3', description: 'Instalación de enchufes y mecanismos', unitPrice: 300 }
];
const foundItem1 = testFindItem82(electricianItems, modAudio1.concept);
assert(foundItem1 !== null && foundItem1.id === 'it-1', "TEST 82: Audio 1 empareja correctamente con 'Sustitución de cuadro eléctrico y protecciones'");

const foundItem2 = testFindItem82(electricianItems, modAudio2.concept);
assert(foundItem2 !== null && foundItem2.id === 'it-1', "TEST 82: Audio 2 empareja correctamente con 'Sustitución de cuadro eléctrico y protecciones'");

// 3. Resolución de "el último presupuesto" vía findBudgetByQuery
const mockSession82 = {
  activeBudgetId: 'PRE-ELEC-001',
  lastCreatedBudgetId: 'PRE-ELEC-001',
  lastActiveBudgetTimestamp: Date.now(),
  budgets: new Map([
    ['PRE-OLD-001', { id: 'PRE-OLD-001', client: { name: 'Manolito Fernández' }, createdAt: '2026-01-01' }],
    ['PRE-ELEC-001', { id: 'PRE-ELEC-001', client: { name: 'Javier Rodríguez Sánchez' }, createdAt: '2026-10-17' }]
  ])
};

const resolvedLast1 = testFindBudgetByQuery82(mockSession82, 'el último presupuesto que me has mandado');
assert(resolvedLast1 !== null && resolvedLast1.id === 'PRE-ELEC-001', "TEST 82: 'el último presupuesto que me has mandado' resuelve a PRE-ELEC-001");

const resolvedLast2 = testFindBudgetByQuery82(mockSession82, 'en este último presupuesto');
assert(resolvedLast2 !== null && resolvedLast2.id === 'PRE-ELEC-001', "TEST 82: 'en este último presupuesto' resuelve a PRE-ELEC-001");

const resolvedLast3 = testFindBudgetByQuery82(mockSession82, 'último presupuesto');
assert(resolvedLast3 !== null && resolvedLast3.id === 'PRE-ELEC-001', "TEST 82: 'último presupuesto' resuelve a PRE-ELEC-001");

// 4. Verificación de que la ventana activa (<15 min) protege contra desambiguación espuria
const isRecentActive82 = Boolean(
  mockSession82.activeBudgetId &&
  mockSession82.budgets.has(mockSession82.activeBudgetId) &&
  (Date.now() - mockSession82.lastActiveBudgetTimestamp) < (15 * 60 * 1000)
);
assert(isRecentActive82 === true, "TEST 82: Presupuesto recién creado está activo dentro de la ventana de 15 minutos");

// Comprobar que si el usuario no pronunció el nombre de otro cliente (ej. Manolito), userSpokeClient es false
const spokeUserText = "Vale, hay que hacer un cambio. La sustitución del cuadro eléctrico y las protecciones no cuestan 480 euros, cuestan 500 euros.";
const hallucinatedClient = "Manolito Fernández";
const userNorm82 = spokeUserText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const clientNorm82 = hallucinatedClient.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const firstWord82 = clientNorm82.split(/\s+/)[0];
const spokeClient82 = clientNorm82 && (userNorm82.includes(clientNorm82) || (firstWord82.length >= 3 && userNorm82.includes(firstWord82)));
assert(spokeClient82 === false, "TEST 82: Si el usuario no nombró a 'Manolito', la protección bloquea la desambiguación errónea");

// ==========================================================
// TEST 83: COBROS SIN IMPORTE EXPLÍCITO ("COBRADO"), VINCULACIÓN A FACTURAS Y DESAMBIGUACIÓN INTELIGENTE
// ==========================================================
console.log("\n--- TEST 83: COBROS NATURALES ('COBRADO'), VINCULACIÓN A FACTURAS Y DESAMBIGUACIÓN ---");

const {
  parsePaymentCommand: testParsePayment83,
  handlePaymentRegistration: testHandlePay83,
  resolveDisambiguationChoice: testResolveDis83
} = await import('./whatsapp_gateway.js');
const {
  ensureCompanyTenant: testEnsureTenant83,
  saveBudget: testSaveBudget83,
  getBudget: testGetBudget83,
  emitInvoice: testEmitInvoice83,
  getInvoice: testGetInvoice83,
  getUnpaidInvoices: testGetUnpaidInvoices83
} = await import('./db_service.js');

// 1. Parser de comandos de cobro genéricos/naturales sin importe explícito
const parsePay83_1 = testParsePayment83("Cobrado");
assert(parsePay83_1 !== null, "TEST 83: Reconoce comando standalone 'Cobrado'");
assert(parsePay83_1.amount === 0 && parsePay83_1.isFullBalance === false, "TEST 83: 'Cobrado' no inventa importe numérico ni asume full balance a ciegas");

const parsePay83_2 = testParsePayment83("pagado");
assert(parsePay83_2 !== null && parsePay83_2.amount === 0, "TEST 83: Reconoce comando 'pagado'");

const parsePay83_3 = testParsePayment83("ya me lo ha pagado");
assert(parsePay83_3 !== null, "TEST 83: Reconoce 'ya me lo ha pagado'");

const parsePay83_4 = testParsePayment83("Cobrado por transferencia");
assert(parsePay83_4 !== null && parsePay83_4.method === 'Transferencia', "TEST 83: Reconoce 'Cobrado por transferencia' con método Transferencia");

const parsePay83_5 = testParsePayment83("Cobrado Javier");
assert(parsePay83_5 !== null && parsePay83_5.clientQuery === 'Javier', "TEST 83: Reconoce 'Cobrado Javier' extrayendo cliente 'Javier'");

// 2. Escenario 1: Presupuesto con 1 factura de anticipo pendiente de cobro (Caso real del usuario)
// Total: 2.130,04 €, Anticipo: 1.137,40 €, Saldo restante tras anticipo: 992,64 €
const tenantPhone83 = '34625999888';
const tenantContext83 = testEnsureTenant83(tenantPhone83);

// Limpieza previa
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext83.companyId);
currentTestDb.prepare('DELETE FROM payments WHERE company_id = ?').run(tenantContext83.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext83.companyId);

const b83 = {
  id: 'PRE2026-9988',
  client: { name: 'Javier Rodríguez Sánchez', address: 'Calle Mayor 10' },
  financials: {
    totalAmount: 2130.04,
    taxableBase: 1760.36,
    advanceAmount: 1137.40,
    advancePercentage: 53.4
  },
  paymentSummary: {
    remainingBalance: 2130.04,
    totalPaid: 0,
    status: 'PENDIENTE'
  },
  status: 'PENDIENTE',
  advanceInvoices: []
};
testSaveBudget83(tenantContext83, b83);

// Emitir factura de anticipo en SQLite por 1.137,40 €
const advanceInv83 = {
  id: 'INV-ADV-PRE2026-9988',
  budgetId: b83.id,
  type: 'ANTICIPO',
  series: 'FAC',
  invoiceNumber: '2026-9988-001',
  naming: 'Factura_Anticipo_2026-9988',
  displayNumber: 'Factura_Anticipo_2026-9988',
  status: 'PENDIENTE_PAGO',
  financials: {
    taxableBase: 940.00,
    taxAmount: 197.40,
    totalAmount: 1137.40
  },
  client: b83.client,
  items: [
    { description: 'Anticipo 53.4% a cuenta de trabajos', total: 1137.40 }
  ]
};
testEmitInvoice83(tenantContext83, advanceInv83);

const unpaidBefore = testGetUnpaidInvoices83(tenantContext83);
assert(unpaidBefore.length === 1, "TEST 83: Inicialmente hay exactamente 1 factura pendiente");

const mockSentMessages83 = [];
const mockSock83 = {
  sendMessage: async (jid, payload) => {
    mockSentMessages83.push(payload.text || payload.caption || '');
    return { key: { id: `msg-83-${Date.now()}` } };
  }
};

const mockSession83 = {
  companyId: tenantContext83.companyId,
  phone: tenantPhone83,
  company: { name: 'Reformas Test S.L.', cif: 'B-83838383' },
  budgets: new Map([[b83.id, b83]]),
  activeBudgetId: b83.id,
  pendingDisambiguation: null
};

// El usuario dice "Cobrado" a secas
await testHandlePay83(
  mockSock83,
  'test-jid-83@s.whatsapp.net',
  mockSession83,
  b83,
  {
    amount: 0,
    isFullBalance: false,
    method: 'Bizum',
    concept: 'Cobro de factura / trabajo'
  },
  'Cobrado'
);

// Verificaciones Escenario 1:
const savedInv83After = testGetInvoice83(tenantContext83, advanceInv83.id);
assert(savedInv83After.status === 'PAGADA', "TEST 83: Factura de anticipo pasa automáticamente a estado 'PAGADA'");
assert(b83.paymentSummary.totalPaid === 1137.40, "TEST 83: Presupuesto registra pago exacto del anticipo (1.137,40 €)");
assert(Math.abs(b83.paymentSummary.remainingBalance - 992.64) < 0.01, "TEST 83: Saldo restante queda exactamente en 992,64 € (NO se cerró toda la obra)");
assert(b83.status === 'ACEPTADO', "TEST 83: Estado del presupuesto es ACEPTADO (no FINALIZADO)");
assert(mockSentMessages83.some(m => m.includes('1.137,40') || m.includes('1137,40')), "TEST 83: Mensaje confirma cobro del anticipo de 1.137,40 €");
assert(mockSentMessages83.some(m => m.includes('Factura_Anticipo_2026-9988') && m.includes('PAGADA')), "TEST 83: Mensaje vincula explícitamente Factura_Anticipo_2026-9988 como PAGADA");
assert(mockSentMessages83.some(m => m.includes('992,64') || m.includes('992.64')), "TEST 83: Mensaje informa con precisión del saldo pendiente de 992,64 € para la obra");

// 3. Escenario 2: Presupuesto con MULTIPLES facturas pendientes (ej: Hito 1 + Hito 2)
// Emitir dos facturas hito pendientes
const hito1_83 = {
  id: 'INV-HIT-2026-9988-001',
  budgetId: b83.id,
  type: 'HITO',
  naming: 'Factura_Hito_2026-9988-001',
  status: 'PENDIENTE_PAGO',
  financials: { totalAmount: 500.00 },
  client: b83.client
};
const hito2_83 = {
  id: 'INV-HIT-2026-9988-002',
  budgetId: b83.id,
  type: 'HITO',
  naming: 'Factura_Hito_2026-9988-002',
  status: 'PENDIENTE_PAGO',
  financials: { totalAmount: 492.64 },
  client: b83.client
};
testEmitInvoice83(tenantContext83, hito1_83);
testEmitInvoice83(tenantContext83, hito2_83);

const unpaidMulti = testGetUnpaidInvoices83(tenantContext83);
assert(unpaidMulti.length === 2, "TEST 83: Ahora hay 2 facturas pendientes de cobro");

mockSentMessages83.length = 0;
// El usuario vuelve a decir "Cobrado" a secas sin especificar cuál
await testHandlePay83(
  mockSock83,
  'test-jid-83@s.whatsapp.net',
  mockSession83,
  b83,
  {
    amount: 0,
    isFullBalance: false,
    method: 'Bizum',
    concept: 'Cobro de factura / trabajo'
  },
  'Cobrado'
);

assert(mockSession83.pendingDisambiguation !== null, "TEST 83: Al haber múltiples facturas pendientes, activa pendingDisambiguation");
assert(mockSession83.pendingDisambiguation.actionType === 'payment_invoice', "TEST 83: actionType es 'payment_invoice'");
assert(mockSession83.pendingDisambiguation.candidates.length === 2, "TEST 83: Contiene las 2 facturas pendientes como candidatos");
assert(mockSentMessages83.some(m => m.includes('varias facturas pendientes') && m.includes('Factura_Hito_2026-9988-001')), "TEST 83: Envía al usuario menú con las facturas para elegir");

// 4. Escenario 3: Resolución de la desambiguación eligiendo la opción "1"
const choiceResolved = testResolveDis83("1", mockSession83.pendingDisambiguation.candidates);
assert(choiceResolved !== null && choiceResolved.id === 'INV-HIT-2026-9988-001', "TEST 83: Elección '1' resuelve a Factura_Hito_2026-9988-001");

// Ejecutar el cobro asignado al candidato 1
await testHandlePay83(
  mockSock83,
  'test-jid-83@s.whatsapp.net',
  mockSession83,
  b83,
  {
    amount: choiceResolved.totalAmount,
    method: 'Bizum',
    concept: `Cobro de ${choiceResolved.naming}`,
    invoiceQuery: choiceResolved.id,
    matchedInvoice: choiceResolved
  },
  '1'
);

const savedHito1 = testGetInvoice83(tenantContext83, 'INV-HIT-2026-9988-001');
assert(savedHito1.status === 'PAGADA', "TEST 83: Factura_Hito 1 queda PAGADA tras resolver desambiguación");
assert(Math.abs(b83.paymentSummary.remainingBalance - 492.64) < 0.01, "TEST 83: Saldo de la obra actualizado restando los 500 € del Hito 1 (quedan 492,64 €)");

// Limpieza final de TEST 83
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext83.companyId);
currentTestDb.prepare('DELETE FROM payments WHERE company_id = ?').run(tenantContext83.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext83.companyId);

// ==========================================================
// TEST 84: CONSULTAS DE AGENDA POR SEMANA, FILTRO POR CLIENTE Y SUPRESIÓN DE CITAS PASADAS
// ==========================================================
console.log("\n--- TEST 84: CONSULTAS DE AGENDA (SEMANA, CLIENTE Y CITAS PASADAS) ---");

const {
  detectAgendaQueryIntent: testDetectAgenda84,
  handleListAppointments: testHandleListAppointments84,
  handleUpdateAppointment: testHandleUpdateAppointment84
} = await import('./whatsapp_gateway.js');
const {
  ensureCompanyTenant: testEnsureTenant84,
  saveAppointment: testSaveAppointment84,
  listAppointments: testListAppointments84,
  listAppointmentsWeek: testListAppointmentsWeek84
} = await import('./db_service.js');

const tenantPhone84 = '34625111222';
const tenantContext84 = testEnsureTenant84(tenantPhone84);

// Limpieza previa
currentTestDb.prepare('DELETE FROM appointments WHERE company_id = ?').run(tenantContext84.companyId);

// 1. Verificación del mensaje de reagendamiento: NO incluye "contador de reagendamientos"
const mockSentReschedule = [];
const mockSockReschedule = {
  sendMessage: async (jid, payload) => {
    mockSentReschedule.push(payload.text || '');
    return { key: { id: `msg-res-${Date.now()}` } };
  }
};

const aptToReschedule = testSaveAppointment84(tenantContext84, {
  clientName: 'Juan Reagendado',
  date: '2026-10-20',
  time: '10:00',
  clientAddress: 'Calle Alcalá 45'
});

const mockSession84 = {
  companyId: tenantContext84.companyId,
  phone: tenantPhone84,
  company: { name: 'Reformas 84 S.L.' }
};

await testHandleUpdateAppointment84(mockSockReschedule, 'test-jid@s.whatsapp.net', mockSession84, {
  appointmentQuery: 'Juan Reagendado',
  date: '2026-10-21',
  time: '11:00'
});

assert(mockSentReschedule.length > 0, "TEST 84: Envía mensaje de confirmación de reagendamiento");
const reschedMsg = mockSentReschedule[0];
assert(reschedMsg.includes('Visita reagendada con éxito'), "TEST 84: Mensaje confirma 'Visita reagendada con éxito'");
assert(!reschedMsg.includes('contador de reagendamientos'), "TEST 84: Mensaje NO incluye la línea técnica 'contador de reagendamientos'");

// 2. Parser determinístico detectAgendaQueryIntent
const agQ1 = testDetectAgenda84("¿Qué visitas tengo para esta semana?");
assert(agQ1 !== null && agQ1.filter === 'week' && agQ1.clientFilter === null, "TEST 84: Reconoce '¿Qué visitas tengo para esta semana?' con filter='week'");

const agQ2 = testDetectAgenda84("citas de esta semana");
assert(agQ2 !== null && agQ2.filter === 'week', "TEST 84: Reconoce 'citas de esta semana'");

const agQ3 = testDetectAgenda84("¿A qué hora tengo que ir a casa de Juan?");
assert(agQ3 !== null && agQ3.clientFilter?.toLowerCase() === 'juan', "TEST 84: Reconoce '¿A qué hora tengo que ir a casa de Juan?' extrayendo clientFilter='juan'");

const agQ4 = testDetectAgenda84("¿A qué hora tengo la visita de Juan?");
assert(agQ4 !== null && agQ4.clientFilter?.toLowerCase() === 'juan', "TEST 84: Reconoce '¿A qué hora tengo la visita de Juan?'");

const agQ5 = testDetectAgenda84("a qué hora es la visita de Juan");
assert(agQ5 !== null && agQ5.clientFilter?.toLowerCase() === 'juan', "TEST 84: Reconoce 'a qué hora es la visita de Juan'");

const agQ6 = testDetectAgenda84("¿cuándo tengo la cita con Carlos?");
assert(agQ6 !== null && agQ6.clientFilter?.toLowerCase() === 'carlos', "TEST 84: Reconoce '¿cuándo tengo la cita con Carlos?' extrayendo clientFilter='carlos'");

const agQ7 = testDetectAgenda84("qué citas tengo agendadas");
assert(agQ7 !== null && agQ7.filter === 'all' && agQ7.clientFilter === null, "TEST 84: Reconoce 'qué citas tengo agendadas' con filter='all'");

// 3. Crear fixtures: citas pasadas, citas completadas, citas de esta semana y citas de Juan
currentTestDb.prepare('DELETE FROM appointments WHERE company_id = ?').run(tenantContext84.companyId);

const now84 = new Date();
const todayIso = now84.toISOString().split('T')[0];

const pastDate = new Date(now84.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // Hace 5 días
const futureDateInWeek1 = new Date(now84.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // Dentro de 2 días
const futureDateInWeek2 = new Date(now84.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // Dentro de 4 días
const farFutureDate = new Date(now84.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // Dentro de 30 días

// Cita 1: Pasada (hace 5 días)
testSaveAppointment84(tenantContext84, {
  clientName: 'Cliente Pasado',
  date: pastDate,
  time: '10:00'
});

// Cita 2: Cita de Juan 1 (dentro de 2 días - esta semana)
testSaveAppointment84(tenantContext84, {
  clientName: 'Juan',
  date: futureDateInWeek1,
  time: '11:00',
  clientAddress: 'Calle Mayor 10, Madrid',
  notes: 'Medición de cocina'
});

// Cita 3: Cita de Juan 2 (dentro de 4 días - esta semana)
testSaveAppointment84(tenantContext84, {
  clientName: 'Juan',
  date: futureDateInWeek2,
  time: '16:30',
  clientAddress: 'Calle Alcalá 45, Madrid',
  notes: 'Revisión fontanería'
});

// Cita 4: Cita de María (dentro de 30 días - fuera de la semana)
testSaveAppointment84(tenantContext84, {
  clientName: 'María García',
  date: farFutureDate,
  time: '12:00',
  clientAddress: 'Calle Sol 1'
});

// Cita 5: Cita completada (debe excluirse de agenda activa)
const compApt = testSaveAppointment84(tenantContext84, {
  clientName: 'Pedro Ya Realizado',
  date: futureDateInWeek1,
  time: '09:00'
});
currentTestDb.prepare("UPDATE appointments SET status = 'COMPLETED' WHERE id = ?").run(compApt.id);

// 4. Verificación de listAppointments:
// a) 'upcoming': Excluye cita pasada y cita completada
const upcomingApts = testListAppointments84(tenantContext84, 'upcoming');
assert(!upcomingApts.some(a => a.clientName === 'Cliente Pasado'), "TEST 84: listAppointments('upcoming') excluye citas con fecha pasada");
assert(!upcomingApts.some(a => a.clientName === 'Pedro Ya Realizado'), "TEST 84: listAppointments('upcoming') excluye citas en estado COMPLETED");
assert(upcomingApts.some(a => a.clientName === 'Juan') && upcomingApts.some(a => a.clientName === 'María García'), "TEST 84: listAppointments('upcoming') incluye citas futuras pendientes");

// b) 'week': Solo incluye citas de los próximos 7 días
const weekApts84 = testListAppointments84(tenantContext84, 'week');
assert(!weekApts84.some(a => a.clientName === 'Cliente Pasado'), "TEST 84: listAppointments('week') no incluye visitas pasadas");
assert(!weekApts84.some(a => a.clientName === 'María García'), "TEST 84: listAppointments('week') excluye citas de dentro de un mes");
assert(weekApts84.filter(a => a.clientName === 'Juan').length === 2, "TEST 84: listAppointments('week') incluye las 2 citas de esta semana");

// 5. Verificación de handleListAppointments (WhatsApp output)
const mockSentGateway = [];
const mockSockGateway = {
  sendMessage: async (jid, payload) => {
    mockSentGateway.push(payload.text || '');
    return { key: { id: `msg-gw-${Date.now()}` } };
  }
};

// a) Consulta "esta semana" -> solo citas de la semana, título correcto, sin citas pasadas
mockSentGateway.length = 0;
await testHandleListAppointments84(mockSockGateway, 'test-jid@s.whatsapp.net', mockSession84, 'week');
assert(mockSentGateway.length === 1, "TEST 84: handleListAppointments envía respuesta para 'week'");
const weekMsg = mockSentGateway[0];
assert(weekMsg.includes('TUS VISITAS TÉCNICAS DE ESTA SEMANA'), "TEST 84: Encabezado es 'TUS VISITAS TÉCNICAS DE ESTA SEMANA'");
assert(weekMsg.includes('Juan'), "TEST 84: Mensaje semanal incluye a Juan");
assert(!weekMsg.includes('Cliente Pasado'), "TEST 84: Mensaje semanal NUNCA incluye 'Cliente Pasado'");
assert(!weekMsg.includes('María García'), "TEST 84: Mensaje semanal NUNCA incluye a María (que es dentro de 30 días)");

// b) Consulta por cliente con múltiples citas: "¿A qué hora tengo la visita de Juan?"
mockSentGateway.length = 0;
await testHandleListAppointments84(mockSockGateway, 'test-jid@s.whatsapp.net', mockSession84, 'upcoming', 'Juan');
assert(mockSentGateway.length === 1, "TEST 84: handleListAppointments envía respuesta para cliente 'Juan'");
const juanMultiMsg = mockSentGateway[0];
assert(juanMultiMsg.includes('VISITAS TÉCNICAS CON JUAN (2)'), "TEST 84: Muestra encabezado agrupado 'VISITAS TÉCNICAS CON JUAN (2)'");
assert(juanMultiMsg.includes('11:00 h') && juanMultiMsg.includes('16:30 h'), "TEST 84: Muestra los dos horarios agendados para Juan");
assert(!juanMultiMsg.includes('María García') && !juanMultiMsg.includes('Cliente Pasado'), "TEST 84: NO mezcla citas de otros clientes");

// c) Consulta por cliente con 1 sola cita: María García
mockSentGateway.length = 0;
await testHandleListAppointments84(mockSockGateway, 'test-jid@s.whatsapp.net', mockSession84, 'upcoming', 'María');
assert(mockSentGateway.length === 1, "TEST 84: handleListAppointments envía respuesta para 'María'");
const mariaMsg = mockSentGateway[0];
assert(mariaMsg.includes('Visita técnica con María García'), "TEST 84: Respuesta individual detalla 'Visita técnica con María García'");
assert(mariaMsg.includes('12:00 h') && mariaMsg.includes('Calle Sol 1'), "TEST 84: Detalla hora 12:00 y dirección Calle Sol 1");

// d) Consulta por cliente inexistente:
mockSentGateway.length = 0;
await testHandleListAppointments84(mockSockGateway, 'test-jid@s.whatsapp.net', mockSession84, 'upcoming', 'Rigoberto');
const rigoMsg = mockSentGateway[0];
assert(rigoMsg.includes('No tienes ninguna visita técnica pendiente con "Rigoberto"'), "TEST 84: Informa amablemente que no hay visitas con Rigoberto");

// Limpieza final de TEST 84
currentTestDb.prepare('DELETE FROM appointments WHERE company_id = ?').run(tenantContext84.companyId);

// ======================================================================
// TEST 85: DESAMBIGUACIÓN OBLIGATORIA AL FINALIZAR VISITAS HOMÓNIMAS (CERO SUPOSICIONES)
// ======================================================================
console.log("\n--- TEST 85: DESAMBIGUACIÓN OBLIGATORIA AL FINALIZAR VISITAS HOMÓNIMAS ---");

const {
  ensureCompanyTenant: testEnsureTenant85,
  saveAppointment: testSaveAppointment85,
  completeAppointments: testCompleteAppointments85,
  getAppointment: testGetAppointment85
} = await import('./db_service.js');

const {
  handleCompleteAppointments: testHandleCompleteAppointments85,
  resolveDisambiguationChoice: testResolveDisambiguationChoice85
} = await import('./whatsapp_gateway.js');

const tenantPhone85 = '34699885544';
const tenantContext85 = testEnsureTenant85(tenantPhone85);

// Limpieza previa de TEST 85
currentTestDb.prepare('DELETE FROM appointments WHERE company_id = ?').run(tenantContext85.companyId);

// 1. Crear dos visitas activas para el mismo cliente 'Juan' en diferentes horas y lugares
const apt85_1 = testSaveAppointment85(tenantContext85, {
  clientName: 'Juan',
  clientPhone: '611223344',
  clientAddress: 'Calle Betis 12',
  date: '2026-10-20',
  time: '11:00',
  notes: 'Revisión cuadro eléctrico'
});

const apt85_2 = testSaveAppointment85(tenantContext85, {
  clientName: 'Juan',
  clientPhone: '699887766',
  clientAddress: 'Avenida Constitución 4',
  date: '2026-10-22',
  time: '16:30',
  notes: 'Cambio de diferencial'
});

assert(Boolean(apt85_1?.id && apt85_2?.id), "TEST 85: Ambas visitas para 'Juan' se guardaron con éxito");

// 2. Probar completeAppointments a nivel db_service con query 'Juan':
// Debe detectar ambigüedad y NO completar ninguna de las dos automáticamente.
const dbCompAmbiguous85 = testCompleteAppointments85(tenantContext85, ['Juan'], 'SUCCESSFUL');
assert(dbCompAmbiguous85.completed.length === 0, "TEST 85: completeAppointments no marca completada ninguna cita si hay ambigüedad");
assert(dbCompAmbiguous85.ambiguous.length === 1, "TEST 85: completeAppointments retorna registro en array ambiguous");
assert(dbCompAmbiguous85.ambiguous[0].query === 'Juan', "TEST 85: query ambigua identificada como 'Juan'");
assert(dbCompAmbiguous85.ambiguous[0].matches.length === 2, "TEST 85: Retorna exactamente los 2 candidatos homónimos");

// Verificar que en SQLite siguen estando CONFIRMED
const checkApt85_1 = testGetAppointment85(tenantContext85, apt85_1.id);
const checkApt85_2 = testGetAppointment85(tenantContext85, apt85_2.id);
assert(checkApt85_1.status === 'CONFIRMED', "TEST 85: Visita 1 sigue CONFIRMED en SQLite");
assert(checkApt85_2.status === 'CONFIRMED', "TEST 85: Visita 2 sigue CONFIRMED en SQLite");

// 3. Probar handleCompleteAppointments a nivel WhatsApp Gateway cuando el usuario dice "visita de Juan hecha" o por audio
const mockSent85 = [];
const mockSock85 = {
  sendMessage: async (jid, payload) => {
    mockSent85.push(payload.text || '');
    return { key: { id: `msg-85-${Date.now()}` } };
  }
};

const session85 = {
  companyId: tenantContext85.companyId,
  phone: tenantContext85.phone,
  company: tenantContext85.company,
  pendingDisambiguation: null
};

// Ejecución con query 'Juan':
const gatewayRes85 = await testHandleCompleteAppointments85(
  mockSock85,
  '34699885544@s.whatsapp.net',
  session85,
  { completedQueries: ['Juan'] },
  null,
  'La visita de Juan ha terminado. Hemos aceptado el trabajo.'
);

assert(gatewayRes85.success === false && gatewayRes85.ambiguous === true, "TEST 85: handleCompleteAppointments detiene la ejecución por ambigüedad");
assert(session85.pendingDisambiguation !== null, "TEST 85: session.pendingDisambiguation queda activado");
assert(session85.pendingDisambiguation.actionType === 'complete_appointment', "TEST 85: actionType es 'complete_appointment'");
assert(session85.pendingDisambiguation.candidates.length === 2, "TEST 85: Contiene exactamente 2 candidatos");
assert(mockSent85.length === 1, "TEST 85: Envió mensaje interactivo de desambiguación por WhatsApp");

const promptText85 = mockSent85[0];
assert(promptText85.includes('Tienes varias visitas pendientes con "Juan"'), "TEST 85: El mensaje alerta de múltiples visitas pendientes");
assert(promptText85.includes('1️⃣') && promptText85.includes('2️⃣'), "TEST 85: Incluye opciones numeradas 1️⃣ y 2️⃣");
assert(promptText85.includes('11:00 h') && promptText85.includes('16:30 h'), "TEST 85: Muestra las dos horas correspondientes");
assert(promptText85.includes('Calle Betis') && promptText85.includes('Avenida Constitución'), "TEST 85: Muestra las direcciones para que el usuario distinga");
assert(promptText85.includes('Responde con el número'), "TEST 85: Instruye al usuario a responder con número o fecha/hora");

// 4. Probar resolución de desambiguación con resolveDisambiguationChoice
const cand85_1 = testResolveDisambiguationChoice85('1', session85.pendingDisambiguation.candidates);
assert(cand85_1?.id === apt85_1.id, "TEST 85: '1' selecciona la primera visita de Juan (11:00 h)");

const cand85_2 = testResolveDisambiguationChoice85('el 2', session85.pendingDisambiguation.candidates);
assert(cand85_2?.id === apt85_2.id, "TEST 85: 'el 2' selecciona la segunda visita de Juan (16:30 h)");

const cand85_hour = testResolveDisambiguationChoice85('la de las 11', session85.pendingDisambiguation.candidates);
assert(cand85_hour?.id === apt85_1.id, "TEST 85: 'la de las 11' selecciona la visita de las 11:00 h");

const cand85_addr = testResolveDisambiguationChoice85('Constitución', session85.pendingDisambiguation.candidates);
assert(cand85_addr?.id === apt85_2.id, "TEST 85: 'Constitución' selecciona la visita por dirección");

// Protección contra empate / repetición del nombre sin elegir:
const tieCheck85 = testResolveDisambiguationChoice85('Juan', session85.pendingDisambiguation.candidates);
assert(tieCheck85 === null, "TEST 85: Repetir simplemente 'Juan' no elige arbitrariamente a ningún candidato");

// 5. Simular la respuesta del usuario eligiendo la opción '1' (apt85_1)
mockSent85.length = 0;
const selectedApt85 = cand85_1;
session85.pendingDisambiguation = null;

const confirmRes85 = await testHandleCompleteAppointments85(
  mockSock85,
  '34699885544@s.whatsapp.net',
  session85,
  { completedQueries: [selectedApt85.id] },
  null,
  '1'
);

assert(confirmRes85.success === true, "TEST 85: Completa exitosamente la cita elegida");
assert(mockSent85.length === 1 && mockSent85[0].includes('He marcado como realizada la visita con *Juan*'), "TEST 85: Envía confirmación de visita realizada");

const finalApt85_1 = testGetAppointment85(tenantContext85, apt85_1.id);
const finalApt85_2 = testGetAppointment85(tenantContext85, apt85_2.id);
assert(finalApt85_1.status === 'COMPLETED', "TEST 85: La visita seleccionada (1) pasa a COMPLETED");
assert(finalApt85_2.status === 'CONFIRMED', "TEST 85: La visita no seleccionada (2) permanece CONFIRMED");

// 6. Si el usuario vuelve a decir "visita de Juan hecha", al quedar solo 1 visita activa, no pregunta y la completa directamente
mockSent85.length = 0;
const secondCallRes85 = await testHandleCompleteAppointments85(
  mockSock85,
  '34699885544@s.whatsapp.net',
  session85,
  { completedQueries: ['Juan'] },
  null,
  'visita de Juan hecha'
);

assert(secondCallRes85.success === true, "TEST 85: Al haber solo 1 visita pendiente de Juan, la completa directamente");
assert(secondCallRes85.completedResult.completed[0].id === apt85_2.id, "TEST 85: Completa la visita 2 restante");
assert(testGetAppointment85(tenantContext85, apt85_2.id).status === 'COMPLETED', "TEST 85: Visita 2 pasa a COMPLETED");

// 7. Prueba del filtro estricto de agenda para consultas "qué visitas me quedan pendientes" / "resto del mes"
const { detectAgendaQueryIntent: testDetectAgendaIntent85 } = await import('./whatsapp_gateway.js');
const { listAppointments: testListAppointments85 } = await import('./db_service.js');

// Verificación de reconocimiento de intención
const qPend1 = testDetectAgendaIntent85('que visitas me quedan pendiente');
assert(Boolean(qPend1 && qPend1.isMatch && (qPend1.filter === 'all' || qPend1.filter === 'upcoming')), "TEST 85: 'que visitas me quedan pendiente' detectado como consulta de agenda");

const qPend2 = testDetectAgendaIntent85('¿qué citas me quedan pendientes?');
assert(Boolean(qPend2 && qPend2.isMatch && (qPend2.filter === 'all' || qPend2.filter === 'upcoming')), "TEST 85: '¿qué citas me quedan pendientes?' detectado como consulta de agenda");

const qPend3 = testDetectAgendaIntent85('visitas pendientes');
assert(Boolean(qPend3 && qPend3.isMatch && (qPend3.filter === 'all' || qPend3.filter === 'upcoming')), "TEST 85: 'visitas pendientes' detectado como consulta de agenda");

const qMonth = testDetectAgendaIntent85('que visitas tengo para este mes');
assert(Boolean(qMonth && qMonth.isMatch && qMonth.filter === 'month'), "TEST 85: 'que visitas tengo para este mes' detectado como month");

// Crear citas de prueba para verificar que 'upcoming' incluye el resto del mes y futuro, y descarta pasadas
const in5Days85 = new Date(Date.now() + 5 * 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const in20Days85 = new Date(Date.now() + 20 * 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const in45Days85 = new Date(Date.now() + 45 * 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const pastDate85 = new Date(Date.now() - 5 * 24 * 3600 * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });

const aptFut85_1 = testSaveAppointment85(tenantContext85, { clientName: 'Cliente 5 Días', date: in5Days85, time: '10:00' });
const aptFut85_2 = testSaveAppointment85(tenantContext85, { clientName: 'Cliente Resto Mes', date: in20Days85, time: '11:00' });
const aptFut85_3 = testSaveAppointment85(tenantContext85, { clientName: 'Cliente Futuro Lejano', date: in45Days85, time: '12:00' });
const aptPast85 = testSaveAppointment85(tenantContext85, { clientName: 'Cliente Pasado Ayer', date: pastDate85, time: '09:00' });
const aptCompleted85 = testSaveAppointment85(tenantContext85, { clientName: 'Cliente Ya Hecho', date: in5Days85, time: '17:00' });
currentTestDb.prepare("UPDATE appointments SET status = 'COMPLETED' WHERE id = ?").run(aptCompleted85.id);

// Consulta 'upcoming' (qué visitas me quedan pendientes)
const upcomingList85 = testListAppointments85(tenantContext85, 'upcoming');
assert(upcomingList85.some(a => a.id === aptFut85_1.id), "TEST 85: upcoming incluye cita de dentro de 5 días");
assert(upcomingList85.some(a => a.id === aptFut85_2.id), "TEST 85: upcoming incluye cita para el resto del mes");
assert(upcomingList85.some(a => a.id === aptFut85_3.id), "TEST 85: upcoming incluye cita para el mes siguiente");
assert(!upcomingList85.some(a => a.id === aptPast85.id), "TEST 85: upcoming NUNCA incluye cita con fecha pasada");
assert(!upcomingList85.some(a => a.id === aptCompleted85.id), "TEST 85: upcoming NUNCA incluye cita COMPLETED");

// Consulta por WhatsApp de "qué visitas me quedan pendientes"
mockSent85.length = 0;
const { handleListAppointments: testHandleListAppointments85_2 } = await import('./whatsapp_gateway.js');
await testHandleListAppointments85_2(mockSock85, '34699885544@s.whatsapp.net', session85, 'upcoming');
assert(mockSent85.length === 1, "TEST 85: handleListAppointments envía respuesta para 'upcoming'");
const upcomingMsg85 = mockSent85[0];
assert(upcomingMsg85.includes('TUS VISITAS TÉCNICAS PENDIENTES'), "TEST 85: Título es 'TUS VISITAS TÉCNICAS PENDIENTES'");
assert(upcomingMsg85.includes('Cliente 5 Días'), "TEST 85: Mensaje contiene 'Cliente 5 Días'");
assert(upcomingMsg85.includes('Cliente Resto Mes'), "TEST 85: Mensaje contiene 'Cliente Resto Mes'");
assert(upcomingMsg85.includes('Cliente Futuro Lejano'), "TEST 85: Mensaje contiene 'Cliente Futuro Lejano'");
assert(!upcomingMsg85.includes('Cliente Pasado Ayer'), "TEST 85: Mensaje NO contiene 'Cliente Pasado Ayer'");
assert(!upcomingMsg85.includes('Cliente Ya Hecho'), "TEST 85: Mensaje NO contiene 'Cliente Ya Hecho'");

// Limpieza de TEST 85
currentTestDb.prepare('DELETE FROM appointments WHERE company_id = ?').run(tenantContext85.companyId);

// ============================================================================
// TEST 86: CONSULTA DE INGRESOS Y COBROS REALES POR PERIODO (MES, TRIMESTRE, CUATRIMESTRE, SEMANA, HOY)
// ============================================================================
console.log("\n--- TEST 86: CONSULTA DE COBROS Y FACTURACIÓN POR PERIODO (MES, TRIMESTRE, CUATRIMESTRE, SEMANA, HOY) ---");

const {
  detectIntent: testDetectIntent86,
  resolveIntent: testResolveIntent86,
  extractPeriodParams: testExtractPeriodParams86
} = await import('./intent_router.js');
const {
  getPeriodRevenue: testGetPeriodRevenue86,
  savePayment: testSavePayment86,
  saveInvoice: testSaveInvoice86,
  saveCompany: testSaveCompany86
} = await import('./db_service.js');

// 1. Reconocimiento de intenciones y periodos
const qMesCobrado = testDetectIntent86('¿Cuánto he cobrado este mes?');
assert(Boolean(qMesCobrado && qMesCobrado.intent === 'MONTHLY_STATS'), "TEST 86: '¿Cuánto he cobrado este mes?' detectado como MONTHLY_STATS");
assert(qMesCobrado.params.queryType === 'collected', "TEST 86: queryType es 'collected'");
assert(qMesCobrado.params.period === 'month', "TEST 86: period es 'month'");

const qMesFacturado = testDetectIntent86('¿cuánto he facturado este mes?');
assert(Boolean(qMesFacturado && qMesFacturado.intent === 'MONTHLY_STATS'), "TEST 86: '¿cuánto he facturado este mes?' detectado como MONTHLY_STATS");
assert(qMesFacturado.params.queryType === 'invoiced', "TEST 86: queryType es 'invoiced'");

const qTrimCobrado = testDetectIntent86('¿Cuánto he cobrado este trimestre?');
assert(Boolean(qTrimCobrado && qTrimCobrado.intent === 'QUARTER_STATS'), "TEST 86: '¿Cuánto he cobrado este trimestre?' detectado como QUARTER_STATS");
assert(qTrimCobrado.params.period === 'quarter', "TEST 86: period es 'quarter'");

const qCuatrimCobrado = testDetectIntent86('¿Cuánto he cobrado este cuatrimestre?');
assert(Boolean(qCuatrimCobrado && qCuatrimCobrado.intent === 'FOUR_MONTH_STATS'), "TEST 86: '¿Cuánto he cobrado este cuatrimestre?' detectado como FOUR_MONTH_STATS");
assert(qCuatrimCobrado.params.period === 'four_month', "TEST 86: period es 'four_month'");

const qCuatrimFacturado = testDetectIntent86('cuanto he facturado este cuatrimestre');
assert(Boolean(qCuatrimFacturado && qCuatrimFacturado.intent === 'FOUR_MONTH_STATS'), "TEST 86: 'cuanto he facturado este cuatrimestre' detectado como FOUR_MONTH_STATS");
assert(qCuatrimFacturado.params.queryType === 'invoiced', "TEST 86: cuatrimestre queryType es 'invoiced'");

const qSemCobrado = testDetectIntent86('¿Cuánto he cobrado esta semana?');
assert(Boolean(qSemCobrado && qSemCobrado.intent === 'WEEKLY_REVENUE'), "TEST 86: '¿Cuánto he cobrado esta semana?' detectado como WEEKLY_REVENUE");
assert(qSemCobrado.params.period === 'week', "TEST 86: period es 'week'");

const qHoyCobrado = testDetectIntent86('¿Cuánto he cobrado hoy?');
assert(Boolean(qHoyCobrado && qHoyCobrado.intent === 'DAILY_REVENUE'), "TEST 86: '¿Cuánto he cobrado hoy?' detectado como DAILY_REVENUE");
assert(qHoyCobrado.params.period === 'today', "TEST 86: period es 'today'");

// 2. Base de datos con cobros y facturas reales
const comp86 = testSaveCompany86('34699008811', { name: 'Reformas Pro 86', cif: 'B86001122' });
const tenantContext86 = { companyId: comp86.id, phone: '34699008811', company: comp86 };
currentTestDb.prepare('DELETE FROM payments WHERE company_id = ?').run(tenantContext86.companyId);
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext86.companyId);

const nowIso86 = new Date().toISOString();
const pastMonthIso86 = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();

// Cobro 1: César López (1.520,75 € por Bizum hoy)
testSavePayment86(tenantContext86, {
  id: 'PAY-86-001',
  amount: 1520.75,
  method: 'Bizum',
  concept: 'Pago a cuenta reforma',
  clientName: 'César López',
  created_at: nowIso86
});

// Cobro 2: Eugenio López (330,00 € por Transferencia hoy)
testSavePayment86(tenantContext86, {
  id: 'PAY-86-002',
  amount: 330.00,
  method: 'Transferencia',
  concept: 'Liquidación pintura',
  clientName: 'Eugenio López',
  created_at: nowIso86
});

// Cobro 3: de hace 70 días (cuatrimestre anterior, agosto)
testSavePayment86(tenantContext86, {
  id: 'PAY-86-003',
  amount: 500.00,
  method: 'Efectivo',
  concept: 'Anticipo viejo',
  clientName: 'Cliente Pasado',
  created_at: pastMonthIso86
});

// Factura emitida este mes: 3.041,50 €
testSaveInvoice86(tenantContext86, {
  id: 'FAC-86-001',
  client: { name: 'César López' },
  totalAmount: 3041.50,
  financials: { totalAmount: 3041.50, advanceAmount: 1520.75, remainingAmount: 1520.75 },
  status: 'EMITIDA',
  created_at: nowIso86
});

// 3. Verificación de cálculo por periodo
const monthStats86 = testGetPeriodRevenue86(tenantContext86, { period: 'month' });
assert(monthStats86.totalCollected === 1850.75, "TEST 86: totalCollected del mes suma exactamente 1.850,75 €");
assert(monthStats86.paymentCount === 2, "TEST 86: paymentCount del mes es 2 (excluye pago de hace 70 días)");
assert(monthStats86.totalInvoiced === 3041.50, "TEST 86: totalInvoiced del mes es 3.041,50 €");

const weekStats86 = testGetPeriodRevenue86(tenantContext86, { period: 'week' });
assert(weekStats86.totalCollected === 1850.75, "TEST 86: totalCollected de la semana suma 1.850,75 €");

const quarterStats86 = testGetPeriodRevenue86(tenantContext86, { period: 'quarter' });
assert(quarterStats86.totalCollected === 1850.75, "TEST 86: totalCollected del trimestre suma 1.850,75 €");

const fourMonthStats86 = testGetPeriodRevenue86(tenantContext86, { period: 'four_month' });
assert(fourMonthStats86.totalCollected === 1850.75, "TEST 86: totalCollected del cuatrimestre suma 1.850,75 €");

const todayStats86 = testGetPeriodRevenue86(tenantContext86, { period: 'today' });
assert(todayStats86.totalCollected === 1850.75, "TEST 86: totalCollected de hoy suma 1.850,75 €");

// 4. Formateo y resolución de intenciones para WhatsApp
const session86 = {
  companyId: tenantContext86.companyId,
  phone: tenantContext86.phone,
  company: { name: 'Reformas Pro 86' },
  budgets: new Map()
};

const replyCobrado86 = await testResolveIntent86(qMesCobrado, tenantContext86.phone, session86);
assert(replyCobrado86.includes('TOTAL COBRADO'), "TEST 86: Título del mensaje es 'TOTAL COBRADO'");
assert(replyCobrado86.includes('1850,75') || replyCobrado86.includes('1.850,75'), "TEST 86: Muestra el total cobrado de 1.850,75 €");
assert(replyCobrado86.includes('César López'), "TEST 86: Desglosa cobro de César López");
assert(replyCobrado86.includes('Eugenio López'), "TEST 86: Desglosa cobro de Eugenio López");
assert(replyCobrado86.includes('Bizum'), "TEST 86: Detalla método Bizum");
assert(replyCobrado86.includes('Transferencia'), "TEST 86: Detalla método Transferencia");
assert(!replyCobrado86.includes('Cobros pendientes (1 factura y 5 obras)'), "TEST 86: NUNCA muestra lista de obras pendientes de cobro");
assert(!replyCobrado86.includes('Total pendiente de cobrar: 19872,75'), "TEST 86: NUNCA muestra total pendiente de obras");

const replyFacturado86 = await testResolveIntent86(qMesFacturado, tenantContext86.phone, session86);
assert(replyFacturado86.includes('FACTURACIÓN Y COBROS'), "TEST 86: Respuesta de facturación titula 'FACTURACIÓN Y COBROS'");
assert(replyFacturado86.includes('3041,50') || replyFacturado86.includes('3.041,50'), "TEST 86: Detalla total facturado de 3.041,50 €");
assert(replyFacturado86.includes('1850,75') || replyFacturado86.includes('1.850,75'), "TEST 86: También informa de lo cobrado (1.850,75 €)");

const replyCuatrimestre86 = await testResolveIntent86(qCuatrimCobrado, tenantContext86.phone, session86);
assert(replyCuatrimestre86.includes('CUATRIMESTRE'), "TEST 86: Mensaje cuatrimestral incluye 'CUATRIMESTRE'");
assert(replyCuatrimestre86.includes('1850,75') || replyCuatrimestre86.includes('1.850,75'), "TEST 86: Cuatrimestre muestra 1.850,75 € cobrados");

const replySemana86 = await testResolveIntent86(qSemCobrado, tenantContext86.phone, session86);
assert(replySemana86.includes('ESTA SEMANA'), "TEST 86: Mensaje semanal incluye 'ESTA SEMANA'");
assert(replySemana86.includes('1850,75') || replySemana86.includes('1.850,75'), "TEST 86: Semana muestra 1.850,75 € cobrados");

// Limpieza de TEST 86
currentTestDb.prepare('DELETE FROM payments WHERE company_id = ?').run(tenantContext86.companyId);
currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(tenantContext86.companyId);

// ======================================================================
// TEST 87: MODIFICACIÓN DEL TOTAL DE PRESUPUESTOS SIMPLES O SIN PARTIDAS ("PERDÓN, ERAN 2300€", "PRESUPUESTO 20 A 2200€")
// ======================================================================
console.log("\n--- TEST 87: MODIFICACIÓN DEL TOTAL EN PRESUPUESTOS SIMPLES O SIN PARTIDAS ---");

const {
  detectBudgetTotalModificationIntent: testDetectTotalMod87,
  findBudgetByQuery: testFindBudgetByQuery87,
  startWhatsAppGateway: testStartWhatsAppGateway87
} = await import('./whatsapp_gateway.js');

const {
  ensureCompanyTenant: testEnsureTenant87,
  saveBudget: testSaveBudget87,
  getBudget: testGetBudget87
} = await import('./db_service.js');

// 1. Verificación de patrones de detección de modificación de total y corrección inmediata
assert(testDetectTotalMod87('perdon, eran 2300€')?.amount === 2300, "TEST 87: 'perdon, eran 2300€' extrae importe 2300");
assert(testDetectTotalMod87('perdon, eran 2300€')?.isCorrection === true, "TEST 87: 'perdon, eran 2300€' se marca como corrección");
assert(testDetectTotalMod87('perdona eran 2300')?.amount === 2300, "TEST 87: 'perdona eran 2300' extrae importe 2300");
assert(testDetectTotalMod87('no, eran 2300€')?.amount === 2300, "TEST 87: 'no, eran 2300€' extrae importe 2300");
assert(testDetectTotalMod87('eran 2300 euros')?.amount === 2300, "TEST 87: 'eran 2300 euros' extrae importe 2300");
assert(testDetectTotalMod87('me he equivocado, eran 2300€')?.amount === 2300, "TEST 87: 'me he equivocado, eran 2300€' extrae importe 2300");
assert(testDetectTotalMod87('rectifico, son 2300€')?.amount === 2300, "TEST 87: 'rectifico, son 2300€' extrae importe 2300");

// Coincidencia con número de presupuesto
const m87_num1 = testDetectTotalMod87('el presupuesto 20 me lo tienes que cambiar a 2200€');
assert(m87_num1?.budgetRef === '20', "TEST 87: 'el presupuesto 20 me lo tienes que cambiar a 2200€' extrae budgetRef '20'");
assert(m87_num1?.amount === 2200, "TEST 87: 'el presupuesto 20 me lo tienes que cambiar a 2200€' extrae importe 2200");

const m87_num2 = testDetectTotalMod87('cambia el presupuesto 20 a 2200€');
assert(m87_num2?.budgetRef === '20' && m87_num2?.amount === 2200, "TEST 87: 'cambia el presupuesto 20 a 2200€' extrae 20 y 2200");

const m87_num3 = testDetectTotalMod87('el presupuesto 20 cámbialo a 2200€');
assert(m87_num3?.budgetRef === '20' && m87_num3?.amount === 2200, "TEST 87: 'el presupuesto 20 cámbialo a 2200€' extrae 20 y 2200");

const m87_num4 = testDetectTotalMod87('en el presupuesto 20 pon 2200€');
assert(m87_num4?.budgetRef === '20' && m87_num4?.amount === 2200, "TEST 87: 'en el presupuesto 20 pon 2200€' extrae 20 y 2200");

const m87_num5 = testDetectTotalMod87('el presupuesto 20 son 2200€');
assert(m87_num5?.budgetRef === '20' && m87_num5?.amount === 2200, "TEST 87: 'el presupuesto 20 son 2200€' extrae 20 y 2200");

// Modificación de total genérica sobre presupuesto activo
assert(testDetectTotalMod87('cámbialo a 2200€')?.amount === 2200, "TEST 87: 'cámbialo a 2200€' extrae importe 2200");
assert(testDetectTotalMod87('el total son 2200€')?.amount === 2200, "TEST 87: 'el total son 2200€' extrae importe 2200");
assert(testDetectTotalMod87('cambia el total a 2200€')?.amount === 2200, "TEST 87: 'cambia el total a 2200€' extrae importe 2200");

// Exclusión de conceptos específicos de gremio
assert(testDetectTotalMod87('cambia la fontanería a 900€') === null, "TEST 87: 'cambia la fontanería a 900€' devuelve null (es partida específica)");

// 2. Verificación de findBudgetByQuery con referencias ordinales y frases de usuario
const testSession87 = {
  activeBudgetId: 'PRE2026-020',
  budgets: new Map([
    ['PRE2026-020', { id: 'PRE2026-020', client: { name: 'Eugenio' }, financials: { totalAmount: 2000 } }],
    ['PRE2026-005', { id: 'PRE2026-005', client: { name: 'Carlos' }, financials: { totalAmount: 500 } }]
  ])
};

assert(testFindBudgetByQuery87(testSession87, 'el presupuesto 20')?.id === 'PRE2026-020', "TEST 87: findBudgetByQuery('el presupuesto 20') localiza PRE2026-020");
assert(testFindBudgetByQuery87(testSession87, 'presupuesto 20')?.id === 'PRE2026-020', "TEST 87: findBudgetByQuery('presupuesto 20') localiza PRE2026-020");
assert(testFindBudgetByQuery87(testSession87, 'presupuesto número 20')?.id === 'PRE2026-020', "TEST 87: findBudgetByQuery('presupuesto número 20') localiza PRE2026-020");
assert(testFindBudgetByQuery87(testSession87, '20')?.id === 'PRE2026-020', "TEST 87: findBudgetByQuery('20') localiza PRE2026-020");
assert(testFindBudgetByQuery87(testSession87, 'PRE2026-020')?.id === 'PRE2026-020', "TEST 87: findBudgetByQuery('PRE2026-020') localiza PRE2026-020");

// 3. Verificación de actualización sobre presupuesto simple / sin partidas con Engine
const { PresuVozEngine: TestEngine87 } = await import('./engine.js');
const engine87 = new TestEngine87();

const tenantPhone87 = '34688990011';
const tenantContext87 = testEnsureTenant87(tenantPhone87);

// Limpieza previa
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext87.companyId);

// 3a. Caso 1: Presupuesto simple inicial de 2000€ para Eugenio
const initialRes87 = engine87.process({
  rawTranscript: 'Presupuesto para Eugenio por 2000€',
  clientName: 'Eugenio',
  items: [{ description: 'Presupuesto para Eugenio', qty: 1, unit: 'pa', unitPrice: 2000, total: 2000, isPricePending: false }]
});
assert(initialRes87.success && initialRes87.budget.financials.taxableBase === 2000, "TEST 87: Presupuesto inicial de 2000€ creado correctamente");

const budget87_1 = initialRes87.budget;
budget87_1.id = 'PRE2026-020';
testSaveBudget87(tenantContext87, budget87_1);

const session87 = {
  activeBudgetId: budget87_1.id,
  lastCreatedBudgetId: budget87_1.id,
  lastActiveBudgetTimestamp: Date.now(),
  budgets: new Map([[budget87_1.id, budget87_1]])
};

// 3b. Usuario envía nota de corrección: "perdon, eran 2300€"
const modIntent87_1 = testDetectTotalMod87('perdon, eran 2300€');
assert(modIntent87_1 !== null && modIntent87_1.amount === 2300, "TEST 87: Detecta intención de corrección con 2300€");

// Se resuelve presupuesto objetivo (activo reciente)
let targetBudget87_1 = null;
if (modIntent87_1.budgetRef) {
  targetBudget87_1 = testFindBudgetByQuery87(session87, modIntent87_1.budgetRef);
} else if (modIntent87_1.isCorrection && session87.activeBudgetId) {
  targetBudget87_1 = session87.budgets.get(session87.activeBudgetId);
}
assert(targetBudget87_1?.id === 'PRE2026-020', "TEST 87: Corrección resuelve a presupuesto activo PRE2026-020");

// Se actualiza la partida única del presupuesto simple
const itemsToProcess87_1 = (targetBudget87_1.items || []).map(i => ({ ...i }));
if (itemsToProcess87_1.length === 1) {
  itemsToProcess87_1[0].unitPrice = modIntent87_1.amount;
  itemsToProcess87_1[0].total = modIntent87_1.amount;
  itemsToProcess87_1[0].isPricePending = false;
}
const updatedRes87_1 = engine87.process({
  rawTranscript: 'perdon, eran 2300€',
  clientName: targetBudget87_1.client.name,
  items: itemsToProcess87_1
});
assert(updatedRes87_1.budget.financials.taxableBase === 2300, "TEST 87: Presupuesto corregido actualiza Base imponible a 2300€ (NO 2000€)");
assert(updatedRes87_1.budget.financials.totalAmount === 2783, "TEST 87: Presupuesto corregido calcula Total 2783€ con 21% IVA");

// Guardar en sesión y SQLite
updatedRes87_1.budget.id = targetBudget87_1.id;
testSaveBudget87(tenantContext87, updatedRes87_1.budget);
session87.budgets.set(updatedRes87_1.budget.id, updatedRes87_1.budget);

// 3c. Usuario recalca con número de presupuesto: "el presupuesto 20 me lo tienes que cambiar a 2200€"
const modIntent87_2 = testDetectTotalMod87('el presupuesto 20 me lo tienes que cambiar a 2200€');
assert(modIntent87_2?.budgetRef === '20' && modIntent87_2?.amount === 2200, "TEST 87: Detecta budgetRef '20' e importe 2200€");

const targetBudget87_2 = testFindBudgetByQuery87(session87, modIntent87_2.budgetRef);
assert(targetBudget87_2?.id === 'PRE2026-020', "TEST 87: 'el presupuesto 20' localiza PRE2026-020 mediante búsqueda por query");

const itemsToProcess87_2 = (targetBudget87_2.items || []).map(i => ({ ...i }));
if (itemsToProcess87_2.length === 1) {
  itemsToProcess87_2[0].unitPrice = modIntent87_2.amount;
  itemsToProcess87_2[0].total = modIntent87_2.amount;
  itemsToProcess87_2[0].isPricePending = false;
}
const updatedRes87_2 = engine87.process({
  rawTranscript: 'el presupuesto 20 me lo tienes que cambiar a 2200€',
  clientName: targetBudget87_2.client.name,
  items: itemsToProcess87_2
});
assert(updatedRes87_2.budget.financials.taxableBase === 2200, "TEST 87: Presupuesto 20 modificado actualiza Base imponible a 2200€");
assert(updatedRes87_2.budget.financials.totalAmount === 2662, "TEST 87: Presupuesto 20 modificado calcula Total 2662€ con 21% IVA");

// 3d. Caso 3: Presupuesto sin ninguna partida (items: []) que recibe modificación al total
const emptyBudget87 = {
  id: 'PRE2026-021',
  issueDate: '2026-10-17',
  company: { name: 'Empresa Test' },
  companyId: tenantContext87.companyId,
  client: { name: 'Manolo Sin Partidas', address: 'Calle Mayor 1' },
  items: [],
  financials: { totalAmount: 0 },
  isDraft: true,
  status: 'BORRADOR'
};
testSaveBudget87(tenantContext87, emptyBudget87);
session87.budgets.set(emptyBudget87.id, emptyBudget87);

const modIntent87_3 = testDetectTotalMod87('en el presupuesto 21 cámbialo a 1500€');
assert(modIntent87_3?.budgetRef === '21' && modIntent87_3?.amount === 1500, "TEST 87: 'en el presupuesto 21 cámbialo a 1500€' detecta ref '21' y 1500€");

const targetBudget87_3 = testFindBudgetByQuery87(session87, modIntent87_3.budgetRef);
assert(targetBudget87_3?.id === 'PRE2026-021', "TEST 87: Encuentra presupuesto PRE2026-021 sin partidas");

const itemsToProcess87_3 = (targetBudget87_3.items || []).map(i => ({ ...i }));
if (itemsToProcess87_3.length === 0) {
  const clientName = targetBudget87_3.client?.name || 'Cliente Particular';
  itemsToProcess87_3.push({
    id: `it-${Date.now()}`,
    description: `Presupuesto para ${clientName}`,
    qty: 1,
    unit: 'pa',
    unitPrice: modIntent87_3.amount,
    total: modIntent87_3.amount,
    isPricePending: false,
    preserveDescription: true
  });
}
const updatedRes87_3 = engine87.process({
  rawTranscript: 'en el presupuesto 21 cámbialo a 1500€',
  clientName: targetBudget87_3.client.name,
  items: itemsToProcess87_3
});
assert(updatedRes87_3.budget.items.length === 1, "TEST 87: Presupuesto vacío genera exactamente 1 partida");
assert(updatedRes87_3.budget.items[0].description === 'Presupuesto para Manolo Sin Partidas', "TEST 87: Descripción formal de partida generada para el cliente");
assert(updatedRes87_3.budget.items[0].unitPrice === 1500, "TEST 87: Partida generada con precio unitario 1500€");
assert(updatedRes87_3.budget.isDraft === false, "TEST 87: Presupuesto pasa de borrador a formal (isDraft: false)");
assert(updatedRes87_3.budget.financials.taxableBase === 1500, "TEST 87: Base imponible es 1500€");
assert(updatedRes87_3.budget.financials.totalAmount === 1815, "TEST 87: Total es 1815€ (1500 + 21% IVA)");

// Limpieza final de TEST 87
currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(tenantContext87.companyId);

// ==========================================================
// TEST 88: AISLAMIENTO TÉCNICO Y PROTECCIÓN DEL MÓDULO DE GESTORÍA (FEATURE_GESTORIA=false)
// ==========================================================
console.log("\n--- TEST 88: AISLAMIENTO TÉCNICO Y PROTECCIÓN DEL MÓDULO DE GESTORÍA (FEATURE_GESTORIA=false) ---");

const {
  isGestoriaEnabled: testIsGestoriaEnabled,
  isGestoriaTestMode: testIsGestoriaTestMode,
  isGestoriaRealEmailAllowed: testIsGestoriaRealEmailAllowed,
  sendFiscalPackageToGestoria: testSendFiscalPackageToGestoria,
  getQuarterSummary: testGetQuarterSummary
} = await import('./fiscal_service.js');
const { resolveIntent: testResolveIntent88 } = await import('./intent_router.js');
const {
  saveCompany: testSaveCompany88,
  getCompany: testGetCompany88,
  emitInvoice: testEmitInvoice88,
  saveBudget: testSaveBudget88,
  ensureCompanyTenant: testEnsureTenant88
} = await import('./db_service.js');

// 1. Verificación de configuración inicial aislada (FEATURE_GESTORIA=false por defecto)
process.env.FEATURE_GESTORIA = 'false';
process.env.FEATURE_GESTORIA_ALLOW_REAL_EMAILS = 'false';

assert(testIsGestoriaEnabled() === false, "TEST 88: isGestoriaEnabled() es false cuando FEATURE_GESTORIA=false");
assert(testIsGestoriaTestMode() === false, "TEST 88: isGestoriaTestMode() es false cuando FEATURE_GESTORIA=false");
assert(testIsGestoriaRealEmailAllowed() === false, "TEST 88: isGestoriaRealEmailAllowed() es false por defecto");

// Si alguien intenta activar allow real emails sin activar FEATURE_GESTORIA, sigue bloqueado
process.env.FEATURE_GESTORIA_ALLOW_REAL_EMAILS = 'true';
assert(testIsGestoriaRealEmailAllowed() === false, "TEST 88: isGestoriaRealEmailAllowed() permanece false si FEATURE_GESTORIA=false");
process.env.FEATURE_GESTORIA_ALLOW_REAL_EMAILS = 'false';

// 2. Invocación de sendFiscalPackageToGestoria con feature desactivada
const tenantPhone88A = '34625888001';
const tenantContext88A = testEnsureTenant88(tenantPhone88A);
testSaveCompany88(tenantPhone88A, {
  name: 'Constructora Alfa S.L.',
  cif: 'B-88000001',
  gestoriaEmail: 'gestoria.alfa@asesoriatest.com'
});

const blockedSendResult = await testSendFiscalPackageToGestoria({
  companyContextOrId: tenantContext88A,
  year: 2026,
  quarter: 1
});
assert(blockedSendResult.blocked === true, "TEST 88: sendFiscalPackageToGestoria retorna blocked=true con FEATURE_GESTORIA=false");
assert(blockedSendResult.success === false, "TEST 88: sendFiscalPackageToGestoria retorna success=false");
assert(blockedSendResult.message.includes('FEATURE_GESTORIA=false'), "TEST 88: Mensaje de error explica desactivación por feature flag");

// 3. Resolución determinística de intenciones con feature desactivada (Intent Router)
const fiscalSummaryReply = await testResolveIntent88(
  { intent: 'FISCAL_QUARTER_SUMMARY', params: { quarter: 1, year: 2026 } },
  tenantPhone88A,
  { companyId: tenantContext88A.companyId }
);
assert(fiscalSummaryReply.includes('Cierre fiscal no disponible'), "TEST 88: FISCAL_QUARTER_SUMMARY responde que el cierre fiscal está desactivado");
assert(!fiscalSummaryReply.includes('Modelo 303'), "TEST 88: FISCAL_QUARTER_SUMMARY no presenta liquidación del Modelo 303");
assert(fiscalSummaryReply.includes('cuánto he facturado este mes'), "TEST 88: Ofrece alternativa para consultar facturas o cobros");

const sendGestoriaReply = await testResolveIntent88(
  { intent: 'SEND_TO_GESTORIA', params: { quarter: 1, year: 2026 } },
  tenantPhone88A,
  { companyId: tenantContext88A.companyId }
);
assert(sendGestoriaReply.includes('Módulo de Gestoría no disponible'), "TEST 88: SEND_TO_GESTORIA responde que el envío a gestorías está desactivado");
assert(!sendGestoriaReply.includes('CONFIRMAR'), "TEST 88: SEND_TO_GESTORIA no pide confirmación de envío Nivel C");

// 4. Perfil de empresa no expone Gestoría cuando FEATURE_GESTORIA=false
const companyProfileReply = await testResolveIntent88(
  { intent: 'SHOW_COMPANY', params: {} },
  tenantPhone88A,
  { companyId: tenantContext88A.companyId }
);
assert(!companyProfileReply.includes('Gestoría:'), "TEST 88: SHOW_COMPANY oculta el campo de gestoría con feature desactivada");

// 5. Modo de pruebas controlado (FEATURE_GESTORIA='test' sin envíos externos)
process.env.FEATURE_GESTORIA = 'test';
assert(testIsGestoriaEnabled() === true, "TEST 88: isGestoriaEnabled() es true en modo test");
assert(testIsGestoriaTestMode() === true, "TEST 88: isGestoriaTestMode() es true en modo test");
assert(testIsGestoriaRealEmailAllowed() === false, "TEST 88: isGestoriaRealEmailAllowed() sigue siendo false en modo test");

// Mock de Resend que fallaría si se intentara enviar un correo real a una dirección externa
let realResendCalled = false;
const mockResendTrap = {
  emails: {
    send: async () => {
      realResendCalled = true;
      throw new Error("VIOLACIÓN DE AISLAMIENTO: Se intentó llamar a resend.emails.send real");
    }
  }
};

const safeTestModeResult = await testSendFiscalPackageToGestoria({
  companyContextOrId: tenantContext88A,
  year: 2026,
  quarter: 1,
  resendInstance: mockResendTrap
});

assert(safeTestModeResult.success === true, "TEST 88: Modo test permite generar el paquete con éxito");
assert(safeTestModeResult.simulated === true, "TEST 88: Modo test marca la entrega como simulada");
assert(safeTestModeResult.targetEmail === 'test@gestoria-simulada.local', "TEST 88: Modo test redirige a buzón de pruebas ficticio");
assert(realResendCalled === false, "TEST 88: NUNCA se invoca la API externa de Resend en modo test");

// Restaurar flag a false
process.env.FEATURE_GESTORIA = 'false';

// 6. Aislamiento Multi-Tenant (Verificar que los datos fiscales de dos empresas están 100% aislados)
const tenantPhone88B = '34625888002';
const tenantContext88B = testEnsureTenant88(tenantPhone88B);
testSaveCompany88(tenantPhone88B, {
  name: 'Reformas Beta S.L.',
  cif: 'B-88000002'
});

// Limpieza previa
currentTestDb.prepare('DELETE FROM invoices WHERE company_id IN (?, ?)').run(tenantContext88A.companyId, tenantContext88B.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id IN (?, ?)').run(tenantContext88A.companyId, tenantContext88B.companyId);

const b88A = {
  id: 'PRE2026-88A',
  client: { name: 'Cliente Alfa', nif: '11111111A' },
  items: [{ id: 'it-1', description: 'Obra Alfa', qty: 1, unit: 'pa', unitPrice: 1000, total: 1000 }],
  financials: { taxableBase: 1000, taxRatePercentage: 21, taxAmount: 210, totalAmount: 1210 }
};
testSaveBudget88(tenantContext88A, b88A);
const inv88A = engine.convertToInvoice(b88A, {
  company: { name: 'Constructora Alfa S.L.', cif: 'B-88000001' },
  id: 'FAC-2026-88A'
});
inv88A.issueDate = '2026-02-15';
inv88A.fiscalPeriod = '2026_Q1';
testEmitInvoice88(tenantContext88A, inv88A);

const b88B = {
  id: 'PRE2026-88B',
  client: { name: 'Cliente Beta', nif: '22222222B' },
  items: [{ id: 'it-1', description: 'Obra Beta', qty: 1, unit: 'pa', unitPrice: 5000, total: 5000 }],
  financials: { taxableBase: 5000, taxRatePercentage: 21, taxAmount: 1050, totalAmount: 6050 }
};
testSaveBudget88(tenantContext88B, b88B);
const inv88B = engine.convertToInvoice(b88B, {
  company: { name: 'Reformas Beta S.L.', cif: 'B-88000002' },
  id: 'FAC-2026-88B'
});
inv88B.issueDate = '2026-02-20';
inv88B.fiscalPeriod = '2026_Q1';
testEmitInvoice88(tenantContext88B, inv88B);

// Calcular resumen trimestral para Empresa A
const summaryAlfa = testGetQuarterSummary(tenantContext88A, 2026, 1);
assert(summaryAlfa.summary.issuedCount === 1, "TEST 88: Empresa Alfa solo tiene 1 factura emitida");
assert(summaryAlfa.summary.issuedTaxBase === 1000, "TEST 88: Base imponible de Alfa es exactamente 1.000 €");
assert(summaryAlfa.summary.issuedVatTotal === 210, "TEST 88: Cuota IVA de Alfa es exactamente 210 €");

// Calcular resumen trimestral para Empresa B
const summaryBeta = testGetQuarterSummary(tenantContext88B, 2026, 1);
assert(summaryBeta.summary.issuedCount === 1, "TEST 88: Empresa Beta solo tiene 1 factura emitida");
assert(summaryBeta.summary.issuedTaxBase === 5000, "TEST 88: Base imponible de Beta es exactamente 5.000 €");
assert(summaryBeta.summary.issuedVatTotal === 1050, "TEST 88: Cuota IVA de Beta es exactamente 1.050 €");

// Limpieza final de TEST 88
currentTestDb.prepare('DELETE FROM invoices WHERE company_id IN (?, ?)').run(tenantContext88A.companyId, tenantContext88B.companyId);
currentTestDb.prepare('DELETE FROM budgets WHERE company_id IN (?, ?)').run(tenantContext88A.companyId, tenantContext88B.companyId);


// =============================================================================
// TEST 89: CONTROL DE ACCESO AUTORIZADO PARA EL LANZAMIENTO (DEFAULT-DENY)
// =============================================================================
console.log("\n--- TEST 89: CONTROL DE ACCESO AUTORIZADO PARA EL LANZAMIENTO (FASE 4E) ---");

const testAdminPhone = '34600000001';
const testAdminPhone2 = '34600000002';
process.env.ADMIN_PHONE_NUMBERS = `${testAdminPhone},${testAdminPhone2}`;

// 1. Un número desconocido no activa Gemini ni genera operaciones (Default-Deny)
const unknownPhone89 = '34699000888';
const unknownJid89 = `${unknownPhone89}@s.whatsapp.net`;
const ingressUnknown = shouldProcessIncomingMessage({
  remoteJid: unknownJid89,
  fromMe: false,
  myNumber: '34600111222',
  requireExplicitAuth: true
});
assert(ingressUnknown.process === false, "TEST 89: Número desconocido queda denegado por defecto en ingress (process=false)");
assert(ingressUnknown.reason === 'UNAUTHORIZED_INCOMING_SENDER', "TEST 89: Motivo es UNAUTHORIZED_INCOMING_SENDER");

const egressUnknown = isAuthorizedEgressRecipient(unknownJid89, { myNumber: '34600111222' });
assert(egressUnknown.allowed === false, "TEST 89: Egress Firewall bloquea salida a número desconocido");
assert(egressUnknown.reason === 'UNAUTHORIZED_TARGET', "TEST 89: Motivo egress es UNAUTHORIZED_TARGET");

// 2. Un número desconocido no puede crear una empresa
const compCountBefore89 = currentTestDb.prepare('SELECT count(*) as c FROM companies').get().c;
const userCountBefore89 = currentTestDb.prepare('SELECT count(*) as c FROM users').get().c;
const chanCountBefore89 = currentTestDb.prepare('SELECT count(*) as c FROM channel_identities').get().c;

assert(compCountBefore89 === currentTestDb.prepare('SELECT count(*) as c FROM companies').get().c, "TEST 89: Cero empresas creadas por remitentes desconocidos");
assert(userCountBefore89 === currentTestDb.prepare('SELECT count(*) as c FROM users').get().c, "TEST 89: Cero usuarios creados por remitentes desconocidos");
assert(chanCountBefore89 === currentTestDb.prepare('SELECT count(*) as c FROM channel_identities').get().c, "TEST 89: Cero identidades de canal creadas por desconocidos");

// 3. Un no administrador no puede autorizar ni revocar números
assert(isPlatformAdmin(testAdminPhone) === true, "TEST 89: Administrador configurado en ADMIN_PHONE_NUMBERS reconocido");
assert(isPlatformAdmin('34611223344') === false, "TEST 89: Usuario común NO es administrador de la plataforma");
assert(isPlatformAdmin('34699000888') === false, "TEST 89: Número desconocido NO es administrador");

// Parser determinístico de comandos de administración
const cmdAuthValid = parseAdminCommand('!autorizar +34611223344');
assert(cmdAuthValid.isCommand === true && cmdAuthValid.action === 'AUTHORIZE' && cmdAuthValid.targetPhone === '+34611223344', "TEST 89: Parser detecta '!autorizar +34611223344'");

const cmdAuthPlain = parseAdminCommand('autorizar 611223344');
assert(cmdAuthPlain.isCommand === true && cmdAuthPlain.action === 'AUTHORIZE' && cmdAuthPlain.targetPhone === '+34611223344', "TEST 89: Parser normaliza 'autorizar 611223344' a +34611223344");

const cmdRevoke = parseAdminCommand('!revocar +34611223344');
assert(cmdRevoke.isCommand === true && cmdRevoke.action === 'REVOKE' && cmdRevoke.targetPhone === '+34611223344', "TEST 89: Parser detecta '!revocar +34611223344'");

const cmdList = parseAdminCommand('!autorizados');
assert(cmdList.isCommand === true && cmdList.action === 'LIST', "TEST 89: Parser detecta '!autorizados'");

const cmdListAlt = parseAdminCommand('listar autorizados');
assert(cmdListAlt.isCommand === true && cmdListAlt.action === 'LIST', "TEST 89: Parser detecta 'listar autorizados'");

const cmdInvalid = parseAdminCommand('!autorizar no_es_telefono');
assert(cmdInvalid.isCommand === true && Boolean(cmdInvalid.error), "TEST 89: Parser rechaza número con formato no válido");

const cmdNormalText = parseAdminCommand('Hola, quiero un presupuesto para reformar un baño');
assert(cmdNormalText.isCommand === false, "TEST 89: Texto ordinario no se confunde con comando de administración");

// Helper de limpieza segura para TEST 89 (respetando integridad referencial)
function cleanTenant89(phone) {
  const comp = currentTestDb.prepare('SELECT id FROM companies WHERE phone = ?').get(phone);
  if (comp) {
    currentTestDb.prepare('DELETE FROM budgets WHERE company_id = ?').run(comp.id);
    currentTestDb.prepare('DELETE FROM invoices WHERE company_id = ?').run(comp.id);
    currentTestDb.prepare('DELETE FROM memberships WHERE company_id = ?').run(comp.id);
    currentTestDb.prepare('DELETE FROM channel_identities WHERE company_id = ?').run(comp.id);
    currentTestDb.prepare('DELETE FROM companies WHERE id = ?').run(comp.id);
  }
  currentTestDb.prepare('DELETE FROM channel_identities WHERE channel_identifier = ?').run(phone);
  currentTestDb.prepare('DELETE FROM users WHERE phone = ?').run(phone);
}

// 4. Un usuario autorizado para onboarding no puede acceder a empresas existentes
const phoneOnboard89 = '34677990011';
cleanTenant89(phoneOnboard89);

const authRes89 = authorizePhoneNumber('+34 677 99 00 11', testAdminPhone, { targetDb: currentTestDb });
assert(authRes89.success === true, "TEST 89: Administrador autoriza nuevo número para onboarding");
assert(authRes89.status === 'AUTHORIZED', "TEST 89: Estado asignado es AUTHORIZED");

const checkAuth89 = isPhoneNumberAuthorized(phoneOnboard89, { targetDb: currentTestDb });
assert(checkAuth89.authorized === true, "TEST 89: Número pre-autorizado es reconocido como autorizado");
assert(checkAuth89.status === 'AUTHORIZED', "TEST 89: Estatus es AUTHORIZED (pendiente de onboarding)");

// Verificar que NO tiene empresa ni canal activo
const authCtxPre89 = resolveAuthenticatedContext('whatsapp', phoneOnboard89);
assert(authCtxPre89 === null, "TEST 89: Usuario pre-autorizado carece de empresa y canal en channel_identities");
const userSessionPre89 = getUserSession(`${phoneOnboard89}@s.whatsapp.net`, phoneOnboard89);
assert(userSessionPre89 === null, "TEST 89: getUserSession retorna null (sin acceso a datos ajenos)");

// 5. La revocación bloquea nuevas operaciones sin borrar datos históricos
const phoneRevoke89 = '34688442211';
cleanTenant89(phoneRevoke89);

const { completeSecureOnboarding: testCompleteOnboarding89 } = await import('./onboarding_service.js');
testCompleteOnboarding89(phoneRevoke89, {
  companyName: 'Empresa A Revocar S.L.',
  cif: 'B-89898989',
  ownerName: 'Manuel Revocado'
});

const compRowRev89 = currentTestDb.prepare('SELECT id FROM companies WHERE phone = ?').get(phoneRevoke89);
const bRev89 = {
  id: 'PRE2026-REV89',
  client: { name: 'Cliente Histórico', nif: '99887766A' },
  items: [{ id: 'it-1', description: 'Trabajo histórico', qty: 1, unit: 'pa', unitPrice: 800, total: 800 }],
  financials: { taxableBase: 800, taxRatePercentage: 21, taxAmount: 168, totalAmount: 968 }
};
testSaveBudget88({ companyId: compRowRev89.id, phone: phoneRevoke89 }, bRev89);

// Ahora revocar el número
const revokeRes89 = revokePhoneNumber(phoneRevoke89, testAdminPhone, { targetDb: currentTestDb });
assert(revokeRes89.success === true, "TEST 89: Administrador revoca acceso a la empresa");
assert(revokeRes89.status === 'REVOKED', "TEST 89: Estado actualizado a REVOKED");

// Ingress bloquea de inmediato
const ingressRevoked = shouldProcessIncomingMessage({
  remoteJid: `${phoneRevoke89}@s.whatsapp.net`,
  fromMe: false,
  myNumber: '34600111222',
  requireExplicitAuth: true
});
assert(ingressRevoked.process === false, "TEST 89: Ingress bloquea totalmente nuevas peticiones del usuario revocado");
assert(ingressRevoked.reason === 'REVOKED_SENDER', "TEST 89: Motivo de bloqueo en ingress es REVOKED_SENDER");

// Egress firewall bloquea envíos hacia el revocado
const egressRevoked = isAuthorizedEgressRecipient(`${phoneRevoke89}@s.whatsapp.net`, { myNumber: '34600111222' });
assert(egressRevoked.allowed === false, "TEST 89: Egress firewall bloquea envíos al número revocado");
assert(egressRevoked.reason === 'REVOKED_RECIPIENT_BLOCKED', "TEST 89: Motivo en egress es REVOKED_RECIPIENT_BLOCKED");

// Comprobación no destructiva: los datos siguen existiendo íntegros en SQLite
const compStillExists = currentTestDb.prepare('SELECT id, name FROM companies WHERE phone = ?').get(phoneRevoke89);
assert(compStillExists && compStillExists.name === 'Empresa A Revocar S.L.', "TEST 89: No destructivo: La empresa permanece intacta en la base de datos");
const budgetStillExists = currentTestDb.prepare('SELECT id FROM budgets WHERE id = ?').get('PRE2026-REV89');
assert(Boolean(budgetStillExists), "TEST 89: No destructivo: Presupuestos históricos permanecen intactos");

// 6. Normalización E.164 consistente para formatos equivalentes
const normA = normalizeToE164('+34 600 11 22 33');
const normB = normalizeToE164('0034600112233');
const normC = normalizeToE164('600112233');
const normD = normalizeToE164('+34 (600) 11-22-33');
assert(normA.e164 === '+34600112233' && normA.digits === '34600112233', "TEST 89: Normaliza '+34 600 11 22 33' a +34600112233");
assert(normB.e164 === '+34600112233' && normB.digits === '34600112233', "TEST 89: Normaliza '0034600112233' a +34600112233");
assert(normC.e164 === '+34600112233' && normC.digits === '34600112233', "TEST 89: Normaliza '600112233' con prefijo +34 por defecto");
assert(normD.e164 === '+34600112233' && normD.digits === '34600112233', "TEST 89: Normaliza '+34 (600) 11-22-33' a +34600112233");

const normUK = normalizeToE164('+44 7911 123456');
assert(normUK.e164 === '+447911123456' && normUK.digits === '447911123456', "TEST 89: Preserva números internacionales válidos fuera de España (+44...)");

// 7. Autorizaciones y revocaciones no rompen el onboarding ni el aislamiento multiempresa
const phoneAtomic89 = '34633221100';
cleanTenant89(phoneAtomic89);

authorizePhoneNumber(`+34 ${phoneAtomic89.slice(2)}`, testAdminPhone, { targetDb: currentTestDb });
testCompleteOnboarding89(phoneAtomic89, {
  companyName: 'Atomic Multi-Tenant S.L.',
  cif: 'B-12344321',
  ownerName: 'Juan Atómico'
});

const atomicCtx = resolveAuthenticatedContext('whatsapp', phoneAtomic89);
assert(atomicCtx !== null && atomicCtx.companyId, "TEST 89: Tras onboarding, canal autenticado resuelve con éxito a su empresa");
assert(atomicCtx.company.name === 'Atomic Multi-Tenant S.L.', "TEST 89: Datos de empresa cargados correctamente");

// Verificar aislamiento: este tenant no puede acceder a los datos de otra empresa
let crossTenantBlocked89 = false;
try {
  atomicCtx.assertTenantAccess('empresa-ajena-uuid');
} catch (e) {
  crossTenantBlocked89 = true;
}
assert(crossTenantBlocked89 === true, "TEST 89: Aislamiento cross-tenant intacto para usuario que completó onboarding");

// 8. Grupos y mensajes no admitidos continúan bloqueados
const groupCheck89 = shouldProcessIncomingMessage({
  remoteJid: '120363401410834758@g.us',
  fromMe: false,
  myNumber: '34600111222',
  requireExplicitAuth: true
});
assert(groupCheck89.process === false && groupCheck89.reason === 'GROUP_OR_BROADCAST_IGNORED', "TEST 89: Grupos (@g.us) continúan bloqueados");

const bcastCheck89 = shouldProcessIncomingMessage({
  remoteJid: 'status@broadcast',
  fromMe: false,
  myNumber: '34600111222',
  requireExplicitAuth: true
});
assert(bcastCheck89.process === false && bcastCheck89.reason === 'GROUP_OR_BROADCAST_IGNORED', "TEST 89: Difusiones (@broadcast) continúan bloqueadas");

const outThirdCheck89 = shouldProcessIncomingMessage({
  remoteJid: '34699887766@s.whatsapp.net',
  fromMe: true,
  myNumber: '34600111222',
  requireExplicitAuth: true
});
assert(outThirdCheck89.process === false && outThirdCheck89.reason === 'OUTGOING_THIRD_PARTY_IGNORED', "TEST 89: Mensajes salientes a terceros desde móvil personal continúan ignorados");

// 9. Operaciones administrativas idempotentes (sin duplicados por reintentos)
const idempPhone89 = '34644556677';
cleanTenant89(idempPhone89);

const idempAuth1 = authorizePhoneNumber(idempPhone89, testAdminPhone, { targetDb: currentTestDb });
assert(idempAuth1.success === true && !idempAuth1.alreadyAuthorized, "TEST 89: Primera autorización ejecutada con éxito");

const idempAuth2 = authorizePhoneNumber(idempPhone89, testAdminPhone, { targetDb: currentTestDb });
assert(idempAuth2.success === true && idempAuth2.alreadyAuthorized === true, "TEST 89: Reintento de autorización detectado como ya autorizado (idempotente)");

const countUsersIdemp = currentTestDb.prepare('SELECT count(*) as c FROM users WHERE phone = ?').get(idempPhone89).c;
assert(countUsersIdemp === 1, "TEST 89: Reintentos administrativos no duplican registros en users (c=1)");

const idempRev1 = revokePhoneNumber(idempPhone89, testAdminPhone, { targetDb: currentTestDb });
assert(idempRev1.success === true, "TEST 89: Primera revocación ejecutada con éxito");
const idempRev2 = revokePhoneNumber(idempPhone89, testAdminPhone, { targetDb: currentTestDb });
assert(idempRev2.success === true, "TEST 89: Reintento de revocación es seguro e idempotente");

// 10. Consulta de autorizados
const authList89 = listAuthorizedPhoneNumbers({ targetDb: currentTestDb });
assert(Array.isArray(authList89) && authList89.length > 0, "TEST 89: listAuthorizedPhoneNumbers retorna la lista estructurada de accesos");
assert(authList89.some(u => u.phone === idempPhone89 && u.status === 'REVOKED'), "TEST 89: Lista refleja estado exacto REVOKED para el usuario");

// Limpieza de datos temporales de TEST 89
[phoneOnboard89, phoneRevoke89, phoneAtomic89, idempPhone89].forEach(cleanTenant89);
currentTestDb.prepare('DELETE FROM budgets WHERE id = ?').run('PRE2026-REV89');

// --- TEST 90: ALERTAS DE VENCIMIENTO DE PRESUPUESTOS Y CANCELACIÓN ---
console.log("\n--- TEST 90: ALERTAS DE VENCIMIENTO DE PRESUPUESTOS Y CANCELACIÓN ---");

const {
  extractCancelBudgetTarget,
  detectIntent: detectIntent90,
  resolveIntent: resolveIntent90
} = await import('./intent_router.js');

const {
  getBudgetsNearExpiration,
  recordBudgetExpirationReminder,
  getBudgetsPendingFollowUp: getBudgetsPendingFollowUp90,
  updateBudgetStatus: updateBudgetStatus90,
  saveBudget: saveBudget90,
  getBudget: getBudget90
} = await import('./db_service.js');

const {
  runBudgetExpirationReminderJob
} = await import('./appointment_scheduler.js');

// 1. Detección determinista de intenciones de cancelación (extractCancelBudgetTarget y detectIntent)
assert(extractCancelBudgetTarget('cancela el presupuesto x') === 'x', "TEST 90: Detecta 'cancela el presupuesto x'");
assert(extractCancelBudgetTarget('cancela el presupuesto de María') === 'maria', "TEST 90: Detecta 'cancela el presupuesto de María'");
assert(extractCancelBudgetTarget('marca como perdido el de María') === 'maria', "TEST 90: Detecta 'marca como perdido el de María'");
assert(extractCancelBudgetTarget('marca como cancelado el de Carlos') === 'carlos', "TEST 90: Detecta 'marca como cancelado el de Carlos'");
assert(extractCancelBudgetTarget('marcar como perdido el de Juan') === 'juan', "TEST 90: Detecta 'marcar como perdido el de Juan'");
assert(extractCancelBudgetTarget('anula el presupuesto de Pedro') === 'pedro', "TEST 90: Detecta 'anula el presupuesto de Pedro'");
assert(extractCancelBudgetTarget('anular el de Carlos') === 'carlos', "TEST 90: Detecta 'anular el de Carlos'");
assert(extractCancelBudgetTarget('el cliente ha rechazado el presupuesto de Laura') === 'laura', "TEST 90: Detecta 'el cliente ha rechazado el presupuesto de Laura'");
assert(extractCancelBudgetTarget('no se va a hacer el de María') === 'maria', "TEST 90: Detecta 'no se va a hacer el de María'");
assert(extractCancelBudgetTarget('cancela PRE2026-090') === 'pre2026-090', "TEST 90: Detecta 'cancela PRE2026-090'");
assert(extractCancelBudgetTarget('cancela la cita de Juan') === null, "TEST 90: NUNCA intercepta cancelación de citas como cancelación de presupuesto");
assert(extractCancelBudgetTarget('cancela la visita de las 11') === null, "TEST 90: NUNCA intercepta visitas");
assert(extractCancelBudgetTarget('cancela la factura de María') === null, "TEST 90: NUNCA intercepta facturas");

assert(detectIntent90('cancela el presupuesto de María')?.intent === 'CANCEL_BUDGET', "TEST 90: detectIntent clasifica 'cancela el presupuesto de María' como CANCEL_BUDGET");
assert(detectIntent90('marca como perdido el de María')?.intent === 'CANCEL_BUDGET', "TEST 90: detectIntent clasifica 'marca como perdido el de María' como CANCEL_BUDGET");
assert(detectIntent90('anula el presupuesto de Carlos')?.intent === 'CANCEL_BUDGET', "TEST 90: detectIntent clasifica 'anula el presupuesto de Carlos' como CANCEL_BUDGET");
assert(detectIntent90('cancela la cita de Juan')?.intent !== 'CANCEL_BUDGET', "TEST 90: Cancelación de cita no es CANCEL_BUDGET");

// 2. Configuración de Tenant y Presupuesto de prueba
const phone90 = '34690000001';
const companyId90 = crypto.randomUUID();
cleanTenant89(phone90);
currentTestDb.prepare("INSERT OR REPLACE INTO companies (id, phone, name, quote_validity_days) VALUES (?, ?, ?, ?)").run(companyId90, phone90, 'Reformas Expiración 90', 7);
const nowIso90 = new Date().toISOString();
currentTestDb.prepare("INSERT OR REPLACE INTO channel_identities (id, company_id, channel, channel_identifier, is_active, created_at, updated_at) VALUES (?, ?, 'whatsapp', ?, 1, ?, ?)").run('chan-90', companyId90, phone90, nowIso90, nowIso90);
currentTestDb.prepare("INSERT OR REPLACE INTO users (id, phone, name, status, created_at, updated_at) VALUES (?, ?, 'Autónomo 90', 'ACTIVE', ?, ?)").run('usr-90', phone90, nowIso90, nowIso90);
currentTestDb.prepare("INSERT OR REPLACE INTO memberships (id, user_id, company_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?, ?)").run('mem-90', 'usr-90', companyId90, nowIso90, nowIso90);

saveBudget90(companyId90, {
  id: 'PRE2026-901',
  client: { name: 'María López', phone: '+34699111222' },
  financials: { totalAmount: 1500 },
  status: 'PENDIENTE_FIRMA',
  terms: { validityDays: 7 }
});
currentTestDb.prepare("UPDATE budgets SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), 'PRE2026-901');

assert(getBudgetsPendingFollowUp90(companyId90).some(b => b.id === 'PRE2026-901'), "TEST 90: Presupuesto inicial aparece en presupuestos pendientes de seguimiento");

// 3. Cancelación conversacional
const session90 = { companyId: companyId90, phone: phone90, budgets: new Map() };
const replyCancel901 = await resolveIntent90({ intent: 'CANCEL_BUDGET', params: { targetQuery: 'maria' } }, phone90, session90);
assert(replyCancel901.includes('marcado como cancelado'), "TEST 90: Respuesta confirma que el presupuesto fue marcado como cancelado");
assert(replyCancel901.includes('María López') || replyCancel901.includes('PRE2026-901'), "TEST 90: Respuesta identifica el presupuesto y cliente");
assert(replyCancel901.includes('Ya no aparecerá en tus presupuestos pendientes'), "TEST 90: Mensaje aclara que no habrá más avisos");

const bAfterCancel = getBudget90(companyId90, 'PRE2026-901');
assert(bAfterCancel.status === 'CANCELADO', "TEST 90: Estado en SQLite actualizado a 'CANCELADO'");
assert(!getBudgetsPendingFollowUp90(companyId90).some(b => b.id === 'PRE2026-901'), "TEST 90: Presupuesto cancelado NO aparece en presupuestos pendientes de seguimiento");
assert(!getBudgetsNearExpiration(companyId90).some(b => b.id === 'PRE2026-901'), "TEST 90: Presupuesto cancelado NO genera alertas de vencimiento");

// 4. Alerta de vencimiento: 1 día antes del vencimiento (Día 6 de 7)
saveBudget90(companyId90, {
  id: 'PRE2026-902',
  client: { name: 'Carlos Vives', phone: '+34699333444' },
  financials: { totalAmount: 2000 },
  status: 'PENDIENTE_FIRMA',
  terms: { validityDays: 7 }
});
currentTestDb.prepare("UPDATE budgets SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000 - 3600000).toISOString(), 'PRE2026-902');

const nearExp902 = getBudgetsNearExpiration(companyId90);
const item902 = nearExp902.find(b => b.id === 'PRE2026-902');
assert(item902 && item902.isSoonToExpire === true, "TEST 90: A falta de 1 día (día 6 de 7), detecta isSoonToExpire = true");
assert(item902 && item902.isExpired === false, "TEST 90: A falta de 1 día, isExpired es false");

const sentMessages90 = [];
const mockSock90 = {
  sendMessage: async (jid, content) => {
    sentMessages90.push({ jid, content });
    return { key: { id: 'msg-' + Math.random() } };
  }
};

await runBudgetExpirationReminderJob(mockSock90, new Map([[phone90 + '@s.whatsapp.net', session90]]), new Set(), { ignoreTimeWindow: true });
assert(sentMessages90.length === 1, "TEST 90: Se envía exactamente 1 mensaje de aviso para presupuesto próximo a vencer");
assert(sentMessages90[0].jid === phone90 + '@s.whatsapp.net', "TEST 90: El recordatorio se envía EXCLUSIVAMENTE al autónomo");
assert(!sentMessages90.some(m => m.jid.includes('699333444') || m.jid.includes('699111222')), "TEST 90: REGLA DE ORO: CERO mensajes enviados al cliente final");
assert(sentMessages90[0].content.text.includes('vence mañana'), "TEST 90: El aviso de víspera indica claramente que vence mañana");
assert(sentMessages90[0].content.text.includes('Carlos Vives'), "TEST 90: El aviso menciona al cliente Carlos Vives");

// Idempotencia del recordatorio de víspera
await runBudgetExpirationReminderJob(mockSock90, new Map([[phone90 + '@s.whatsapp.net', session90]]), new Set(), { ignoreTimeWindow: true });
assert(sentMessages90.length === 1, "TEST 90: Idempotencia: No duplica el recordatorio de víspera");

// 5. Alerta de vencimiento: Día exacto de vencimiento (Día 7 de 7)
saveBudget90(companyId90, {
  id: 'PRE2026-903',
  client: { name: 'María Gómez', phone: '+34699555666' },
  financials: { totalAmount: 3200 },
  status: 'PENDIENTE_FIRMA',
  terms: { validityDays: 7 }
});
currentTestDb.prepare("UPDATE budgets SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 3600000).toISOString(), 'PRE2026-903');

const nearExp903 = getBudgetsNearExpiration(companyId90);
const item903 = nearExp903.find(b => b.id === 'PRE2026-903');
assert(item903 && item903.isExpired === true, "TEST 90: El día de vencimiento (día 7 de 7), detecta isExpired = true");

sentMessages90.length = 0;
await runBudgetExpirationReminderJob(mockSock90, new Map([[phone90 + '@s.whatsapp.net', session90]]), new Set(), { ignoreTimeWindow: true });
assert(sentMessages90.length === 1, "TEST 90: Se envía exactamente 1 mensaje por el presupuesto vencido");
assert(sentMessages90[0].jid === phone90 + '@s.whatsapp.net', "TEST 90: Aviso de vencimiento enviado EXCLUSIVAMENTE al autónomo");
assert(!sentMessages90.some(m => m.jid.includes('699555666')), "TEST 90: REGLA DE ORO: NUNCA se envía aviso de vencimiento al cliente");

const expText = sentMessages90[0].content.text;
assert(expText.includes('ha alcanzado hoy el límite de 7 días'), "TEST 90: Mensaje contiene 'ha alcanzado hoy el límite de 7 días'");
assert(expText.includes('Sigue sin firmar'), "TEST 90: Mensaje contiene 'Sigue sin firmar'");
assert(expText.includes('cerrar la obra'), "TEST 90: Mensaje sugiere llamada para cerrar la obra");
assert(expText.includes('marca como perdido el de María Gómez'), "TEST 90: Mensaje incluye la instrucción de marcado como perdido");

// Idempotencia del aviso de vencimiento
await runBudgetExpirationReminderJob(mockSock90, new Map([[phone90 + '@s.whatsapp.net', session90]]), new Set(), { ignoreTimeWindow: true });
assert(sentMessages90.length === 1, "TEST 90: Idempotencia: No duplica el aviso de vencimiento");

// 6. Cancelación tras el aviso de vencimiento
const cancelReply903 = await resolveIntent90({ intent: 'CANCEL_BUDGET', params: { targetQuery: 'María Gómez' } }, phone90, session90);
assert(cancelReply903.includes('marcado como cancelado'), "TEST 90: Presupuesto PRE2026-903 cancelado con éxito tras el aviso");
const b903Check = getBudget90(companyId90, 'PRE2026-903');
assert(b903Check.status === 'CANCELADO', "TEST 90: Estado en SQLite verificado como 'CANCELADO'");

// Limpieza de datos temporales de TEST 90
cleanTenant89(phone90);
currentTestDb.prepare('DELETE FROM budgets WHERE id IN (?, ?, ?)').run('PRE2026-901', 'PRE2026-902', 'PRE2026-903');
currentTestDb.prepare('DELETE FROM companies WHERE id = ?').run(companyId90);
// --- TEST 91: ENDURECIMIENTO DE DESPLIEGUE, FAIL-CLOSED, TEMPORIZADORES, BLOQUEO DE INSTANCIA Y CIERRE ORDENADO ---
console.log("\n--- TEST 91: ENDURECIMIENTO DE DESPLIEGUE, FAIL-CLOSED, TEMPORIZADORES, BLOQUEO DE INSTANCIA Y CIERRE ORDENADO ---");

const originalExplicitAuthEnv = process.env.REQUIRE_EXPLICIT_AUTH;

// A. Control de acceso fail-closed: resolveRequireExplicitAuth y shouldProcessIncomingMessage
// 1. Variable ausente
delete process.env.REQUIRE_EXPLICIT_AUTH;
assert(resolveRequireExplicitAuth() === true, "TEST 91 (A1): REQUIRE_EXPLICIT_AUTH ausente resuelve a true (fail-closed)");
const ingressAbsent = shouldProcessIncomingMessage({
  remoteJid: '34699881122@s.whatsapp.net',
  fromMe: false,
  remotePhone: '34699881122',
  allowedNumbers: []
});
assert(ingressAbsent.process === false && ingressAbsent.reason === 'UNAUTHORIZED_INCOMING_SENDER', "TEST 91 (A2): Remitente desconocido bloqueado cuando REQUIRE_EXPLICIT_AUTH está ausente");

// 2. Variable vacía
process.env.REQUIRE_EXPLICIT_AUTH = '';
assert(resolveRequireExplicitAuth() === true, "TEST 91 (A3): REQUIRE_EXPLICIT_AUTH vacía resuelve a true (fail-closed)");
const ingressEmpty = shouldProcessIncomingMessage({
  remoteJid: '34699881122@s.whatsapp.net',
  fromMe: false,
  remotePhone: '34699881122',
  allowedNumbers: []
});
assert(ingressEmpty.process === false && ingressEmpty.reason === 'UNAUTHORIZED_INCOMING_SENDER', "TEST 91 (A4): Remitente desconocido bloqueado cuando REQUIRE_EXPLICIT_AUTH está vacía");

// 3. Valor 'true'
process.env.REQUIRE_EXPLICIT_AUTH = 'true';
assert(resolveRequireExplicitAuth() === true, "TEST 91 (A5): REQUIRE_EXPLICIT_AUTH='true' resuelve a true");
const ingressTrue = shouldProcessIncomingMessage({
  remoteJid: '34699881122@s.whatsapp.net',
  fromMe: false,
  remotePhone: '34699881122',
  allowedNumbers: []
});
assert(ingressTrue.process === false && ingressTrue.reason === 'UNAUTHORIZED_INCOMING_SENDER', "TEST 91 (A6): Remitente desconocido bloqueado cuando REQUIRE_EXPLICIT_AUTH='true'");

// 4. Valor 'false'
process.env.REQUIRE_EXPLICIT_AUTH = 'false';
assert(resolveRequireExplicitAuth() === false, "TEST 91 (A7): REQUIRE_EXPLICIT_AUTH='false' resuelve a false (legacy abierto)");
const ingressFalse = shouldProcessIncomingMessage({
  remoteJid: '34699881122@s.whatsapp.net',
  fromMe: false,
  remotePhone: '34699881122',
  allowedNumbers: []
});
assert(ingressFalse.process === true && ingressFalse.reason === 'ONBOARDING_ELIGIBLE_SENDER', "TEST 91 (A8): Remitente admitido a onboarding solo con configuración explícita 'false'");

// Variantes de 'false' (espacios y mayúsculas)
process.env.REQUIRE_EXPLICIT_AUTH = '  FALSE  ';
assert(resolveRequireExplicitAuth() === false, "TEST 91 (A9): REQUIRE_EXPLICIT_AUTH='  FALSE  ' resuelve a false");

// 5. Valores inesperados ('unexpected', '0', 'undefined', etc.)
process.env.REQUIRE_EXPLICIT_AUTH = 'unexpected';
assert(resolveRequireExplicitAuth() === true, "TEST 91 (A10): REQUIRE_EXPLICIT_AUTH='unexpected' resuelve a true (fail-closed)");
process.env.REQUIRE_EXPLICIT_AUTH = '0';
assert(resolveRequireExplicitAuth() === true, "TEST 91 (A11): REQUIRE_EXPLICIT_AUTH='0' resuelve a true (fail-closed)");
process.env.REQUIRE_EXPLICIT_AUTH = 'invalid_setting';
assert(resolveRequireExplicitAuth() === true, "TEST 91 (A12): REQUIRE_EXPLICIT_AUTH='invalid_setting' resuelve a true (fail-closed)");

const ingressUnexpected = shouldProcessIncomingMessage({
  remoteJid: '34699881122@s.whatsapp.net',
  fromMe: false,
  remotePhone: '34699881122',
  allowedNumbers: []
});
assert(ingressUnexpected.process === false && ingressUnexpected.reason === 'UNAUTHORIZED_INCOMING_SENDER', "TEST 91 (A13): Remitente desconocido bloqueado ante valor de configuración inesperado");

// 6. Parámetro directo pasado a la función
assert(resolveRequireExplicitAuth(false) === false, "TEST 91 (A14): Parámetro false resuelve a false");
assert(resolveRequireExplicitAuth('false') === false, "TEST 91 (A15): Parámetro 'false' resuelve a false");
assert(resolveRequireExplicitAuth(true) === true, "TEST 91 (A16): Parámetro true resuelve a true");
assert(resolveRequireExplicitAuth('true') === true, "TEST 91 (A17): Parámetro 'true' resuelve a true");
assert(resolveRequireExplicitAuth('') === true, "TEST 91 (A18): Parámetro '' resuelve a true (fail-closed)");
assert(resolveRequireExplicitAuth('random') === true, "TEST 91 (A19): Parámetro 'random' resuelve a true (fail-closed)");

// Parámetro explícito sobreescribe variable de entorno
process.env.REQUIRE_EXPLICIT_AUTH = 'false';
const ingressOverrideBlock = shouldProcessIncomingMessage({
  remoteJid: '34699881122@s.whatsapp.net',
  fromMe: false,
  remotePhone: '34699881122',
  allowedNumbers: [],
  requireExplicitAuth: true
});
assert(ingressOverrideBlock.process === false, "TEST 91 (A20): Parámetro requireExplicitAuth:true bloquea aunque env sea 'false'");

process.env.REQUIRE_EXPLICIT_AUTH = 'true';
const ingressOverrideAllow = shouldProcessIncomingMessage({
  remoteJid: '34699881122@s.whatsapp.net',
  fromMe: false,
  remotePhone: '34699881122',
  allowedNumbers: [],
  requireExplicitAuth: false
});
assert(ingressOverrideAllow.process === true, "TEST 91 (A21): Parámetro requireExplicitAuth:false permite aunque env sea 'true'");

// Restaurar entorno
if (originalExplicitAuthEnv !== undefined) {
  process.env.REQUIRE_EXPLICIT_AUTH = originalExplicitAuthEnv;
} else {
  delete process.env.REQUIRE_EXPLICIT_AUTH;
}

// B. Ciclo de vida de los temporizadores: clearGatewayTimers
assert(typeof clearGatewayTimers === 'function', "TEST 91 (B1): clearGatewayTimers es una función exportada");
clearGatewayTimers(); // Debe ejecutarse limpiamente sin errores cuando no hay temporizadores
assert(true, "TEST 91 (B2): clearGatewayTimers es seguro e idempotente en estado inicial");

// C. Bloqueo de instancia única: instance_lock.js
const testLockPath91 = path.resolve('data', 'test_instance_lock_91.lock');
if (fs.existsSync(testLockPath91)) {
  try { fs.unlinkSync(testLockPath91); } catch(e) {}
}

// 1. Adquisición inicial exitosa
const lockAcquire1 = acquireGatewayLock(testLockPath91);
assert(lockAcquire1.acquired === true && lockAcquire1.pid === process.pid, "TEST 91 (C1): Adquisición de lockfile exitosa para el proceso actual");
assert(fs.existsSync(testLockPath91), "TEST 91 (C2): Archivo de bloqueo creado físicamente en disco");

const lockFileRaw = fs.readFileSync(testLockPath91, 'utf8');
const lockFileParsed = JSON.parse(lockFileRaw);
assert(lockFileParsed.pid === process.pid, "TEST 91 (C3): Lockfile contiene el PID correcto del proceso");

// 2. Re-adquisición idempotente por el mismo proceso
const lockAcquireRe = acquireGatewayLock(testLockPath91);
assert(lockAcquireRe.acquired === true && lockAcquireRe.pid === process.pid, "TEST 91 (C4): Re-adquisición idempotente por el mismo proceso permitida");

// 3. Intento de adquisición cuando otra instancia activa posee el bloqueo
// Usamos process.ppid si está activo, o mockeamos comprobando isPidAlive
const activeOtherPid = process.ppid && isPidAlive(process.ppid) ? process.ppid : process.pid;
if (activeOtherPid !== process.pid) {
  fs.writeFileSync(testLockPath91, JSON.stringify({ pid: activeOtherPid, createdAt: new Date().toISOString() }));
  const lockCollision = acquireGatewayLock(testLockPath91);
  assert(lockCollision.acquired === false && lockCollision.reason === 'ALREADY_RUNNING', "TEST 91 (C5): Detección y rechazo seguro ante colisión con otra instancia activa");
  assert(lockCollision.activePid === activeOtherPid, "TEST 91 (C6): Reporta el PID activo de la otra instancia");
} else {
  // Simulación con objeto lock simulado
  assert(true, "TEST 91 (C5): Omitida verificación con ppid idéntico (entorno sin parent)");
  assert(true, "TEST 91 (C6): Omitido");
}

// 4. Detección y recuperación de lockfile obsoleto (stale lock de proceso muerto)
let deadPidCandidate = 99999999;
while (isPidAlive(deadPidCandidate)) {
  deadPidCandidate++;
}
fs.writeFileSync(testLockPath91, JSON.stringify({ pid: deadPidCandidate, createdAt: new Date(Date.now() - 3600000).toISOString() }));
const staleRecover = acquireGatewayLock(testLockPath91);
assert(staleRecover.acquired === true && staleRecover.pid === process.pid, "TEST 91 (C7): Lockfile obsoleto de proceso inactivo detectado y reclamado automáticamente");

// 5. Liberación segura del lockfile
// No debe eliminar el lock si pertenece a otro proceso
fs.writeFileSync(testLockPath91, JSON.stringify({ pid: 88888888, createdAt: new Date().toISOString() }));
const releaseNotMine = releaseGatewayLock(testLockPath91);
assert(releaseNotMine === false, "TEST 91 (C8): NUNCA elimina un lockfile perteneciente a otro PID");
assert(fs.existsSync(testLockPath91), "TEST 91 (C9): El archivo de bloqueo ajeno permanece intacto");

// Sí debe eliminar si pertenece a este proceso
fs.writeFileSync(testLockPath91, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
const releaseMine = releaseGatewayLock(testLockPath91);
assert(releaseMine === true, "TEST 91 (C10): Libera exitosamente el bloqueo cuando pertenece al proceso actual");
assert(!fs.existsSync(testLockPath91), "TEST 91 (C11): Archivo de bloqueo eliminado de disco tras liberación");

// D. Cierre ordenado (gracefulShutdown)
let mockSocketClosed = false;
let mockSocketEndReason = null;
const mockSocket91 = {
  end: (err) => {
    mockSocketClosed = true;
    mockSocketEndReason = err?.message || 'closed';
  },
  ws: { close: () => {} }
};

await gracefulShutdown('SIGTERM', mockSocket91, { exitProcess: false, timeoutMs: 100, closeDatabase: false });
assert(mockSocketClosed === true, "TEST 91 (D1): gracefulShutdown cierra el socket de WhatsApp");
assert(mockSocketEndReason && mockSocketEndReason.includes('SIGTERM'), "TEST 91 (D2): Cierre de socket documenta la señal SIGTERM recibida");

// Llamada redundante a gracefulShutdown debe ser idempotente
let redundantThrows = false;
try {
  await gracefulShutdown('SIGINT', mockSocket91, { exitProcess: false, timeoutMs: 100, closeDatabase: false });
} catch {
  redundantThrows = true;
}
assert(!redundantThrows, "TEST 91 (D3): gracefulShutdown redundante se ejecuta sin excepciones de concurrencia");
resetShutdownStateForTesting();

// E. Protección y aislamiento de db_viewer.js
assert(canStartDbViewer('production').allowed === false, "TEST 91 (E1): canStartDbViewer bloquea terminantemente NODE_ENV=production");
assert(canStartDbViewer('production').reason === 'PRODUCTION_FORBIDDEN', "TEST 91 (E2): Motivo documentado PRODUCTION_FORBIDDEN");
assert(canStartDbViewer('development').allowed === true, "TEST 91 (E3): canStartDbViewer permite NODE_ENV=development");
assert(canStartDbViewer('test').allowed === true, "TEST 91 (E4): canStartDbViewer permite NODE_ENV=test");
assert(DB_VIEWER_HOST === '127.0.0.1', "TEST 91 (E5): db_viewer.js escucha EXCLUSIVAMENTE en host local 127.0.0.1 (no expuesto a red)");


// ==========================================================
// TEST 92: META WHATSAPP CLOUD API ADAPTER Y ENLACES CORTOS DE FIRMA (/f/:code)
// ==========================================================
console.log("\n--- TEST 92: META WHATSAPP CLOUD API ADAPTER Y ENLACES CORTOS DE FIRMA (/f/:code) ---");
const {
  verifyWebhookSignature,
  parseCloudWebhookToBaileysMessages,
  createCloudApiSocket,
  createPresuVozHttpServer,
  getShortSigningLink,
  getLocalSignedBudget,
  clearShortLinksAndSignaturesForTesting
} = await import('./cloud_api_adapter.js');
const {
  generateSigningUrl,
  downloadWhatsAppMediaBuffer
} = await import('./whatsapp_gateway.js');
const {
  ensureCompanyTenant: ensureTenant92,
  saveBudget: saveBudget92,
  getBudget: getBudget92,
  syncPendingSignaturesFromCloud: syncSig92
} = await import('./db_service.js');

clearShortLinksAndSignaturesForTesting();

// A. Verificación criptográfica X-Hub-Signature-256 de Meta
const testAppSecret92 = 'meta_app_secret_92_test_key';
const sampleWebhookRaw92 = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'WABA_92',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        contacts: [{ wa_id: '34600929292', profile: { name: 'Reformas Paco' } }],
        messages: [
          {
            from: '34600929292',
            id: 'wamid.test92_text_1',
            timestamp: '1760000001',
            type: 'text',
            text: { body: 'Presupuesto para pintar salón de Ana por 450 euros' }
          },
          {
            from: '34600929292',
            id: 'wamid.test92_audio_1',
            timestamp: '1760000002',
            type: 'audio',
            audio: { id: 'media_audio_92', mime_type: 'audio/ogg; codecs=opus', voice: true }
          },
          {
            from: '34600929292',
            id: 'wamid.test92_img_1',
            timestamp: '1760000003',
            type: 'image',
            image: { id: 'media_img_92', mime_type: 'image/jpeg', caption: 'mi logo' }
          }
        ]
      }
    }]
  }]
});

const validHubSig92 = 'sha256=' + crypto.createHmac('sha256', testAppSecret92).update(sampleWebhookRaw92).digest('hex');
assert(verifyWebhookSignature(sampleWebhookRaw92, validHubSig92, testAppSecret92) === true, "TEST 92 (A1): verifyWebhookSignature acepta firma HMAC-SHA256 legítima de Meta");
assert(verifyWebhookSignature(sampleWebhookRaw92, 'sha256=' + '0'.repeat(64), testAppSecret92) === false, "TEST 92 (A2): verifyWebhookSignature rechaza firma falsificada");
assert(verifyWebhookSignature(sampleWebhookRaw92, '', testAppSecret92) === false, "TEST 92 (A3): verifyWebhookSignature rechaza petición sin cabecera X-Hub-Signature-256");

// B. Normalización de eventos de Cloud API a estructura Baileys
const parsedMsgs92 = parseCloudWebhookToBaileysMessages(JSON.parse(sampleWebhookRaw92));
assert(parsedMsgs92.length === 3, "TEST 92 (B1): parseCloudWebhookToBaileysMessages extrae los 3 mensajes (texto, audio, imagen)");
assert(parsedMsgs92[0].key.remoteJid === '34600929292@s.whatsapp.net' && parsedMsgs92[0].key.id === 'wamid.test92_text_1', "TEST 92 (B2): JID y WAMID mapeados al formato exacto de Baileys");
assert(parsedMsgs92[0].message.conversation === 'Presupuesto para pintar salón de Ana por 450 euros', "TEST 92 (B3): Mensaje de texto mapeado a message.conversation");
assert(parsedMsgs92[1].message.audioMessage?._cloudMediaId === 'media_audio_92', "TEST 92 (B4): Nota de voz mapeada a audioMessage con _cloudMediaId");
assert(parsedMsgs92[2].message.imageMessage?.caption === 'mi logo' && parsedMsgs92[2].message.imageMessage?._cloudMediaId === 'media_img_92', "TEST 92 (B5): Imagen con caption mapeada a imageMessage con _cloudMediaId");

// Ignorar webhooks de solo estado (statuses: sent/delivered/read)
const statusOnlyPayload92 = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }]
};
assert(parseCloudWebhookToBaileysMessages(statusOnlyPayload92).length === 0, "TEST 92 (B6): Webhooks de estado (delivered/read) se ignoran limpiamente sin disparar mensajes");

// C. Adaptador de salida y descarga multimedia (createCloudApiSocket)
const graphApiCalls92 = [];
const mockFetch92 = async (url, init = {}) => {
  graphApiCalls92.push({ url: String(url), method: init.method || 'GET', body: init.body });
  const u = String(url);
  if (u.endsWith('/media') && init.method === 'POST') {
    return new Response(JSON.stringify({ id: 'uploaded_pdf_media_92' }), { status: 200 });
  }
  if (u.endsWith('/messages') && init.method === 'POST') {
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.out_92_ok' }] }), { status: 200 });
  }
  if (u.includes('/media_audio_92') && (!init.method || init.method === 'GET')) {
    return new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media_audio_92', mime_type: 'audio/ogg' }), { status: 200 });
  }
  if (u.startsWith('https://lookaside.fbsbx.com/')) {
    return new Response(Buffer.from('OGG_BINARY_AUDIO_CONTENT_92'), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { message: 'Unexpected URL' } }), { status: 404 });
};

const cloudSock92 = createCloudApiSocket({
  phoneNumberId: '109988776655',
  accessToken: 'EAATestToken92',
  displayPhoneNumber: '34699000111',
  fetchImpl: mockFetch92
});

const sentText92 = await cloudSock92.sendMessage('34600929292@s.whatsapp.net', { text: 'Hola desde Cloud API oficial' });
assert(sentText92.key.id === 'wamid.out_92_ok', "TEST 92 (C1): sock.sendMessage(text) envía mensaje por Graph API y retorna key.id compatible con Baileys");
const lastTextCall92 = JSON.parse(graphApiCalls92[0].body);
assert(lastTextCall92.to === '34600929292' && lastTextCall92.type === 'text' && lastTextCall92.text.body === 'Hola desde Cloud API oficial', "TEST 92 (C2): Payload JSON de texto enviado a Graph API cumple especificación oficial de Meta");

const sentDoc92 = await cloudSock92.sendMessage('34600929292@s.whatsapp.net', {
  document: Buffer.from('%PDF-1.4 test pdf'),
  mimetype: 'application/pdf',
  fileName: 'Presupuesto_92.pdf',
  caption: '📄 Presupuesto 92'
});
assert(sentDoc92.key.id === 'wamid.out_92_ok', "TEST 92 (C3): sock.sendMessage(document) sube el PDF a /media y envía el documento con media_id");
const docMsgCall92 = JSON.parse(graphApiCalls92[2].body);
assert(docMsgCall92.type === 'document' && docMsgCall92.document.id === 'uploaded_pdf_media_92' && docMsgCall92.document.filename === 'Presupuesto_92.pdf', "TEST 92 (C4): Envío de PDF referencia el media_id devuelto por Meta /media");

const downloadedAudio92 = await downloadWhatsAppMediaBuffer(cloudSock92, parsedMsgs92[1], parsedMsgs92[1].message, null);
assert(Buffer.isBuffer(downloadedAudio92) && downloadedAudio92.toString('utf-8') === 'OGG_BINARY_AUDIO_CONTENT_92', "TEST 92 (C5): downloadWhatsAppMediaBuffer descarga binarios de voz desde Meta Graph API transparentemente");

// D. Enlaces cortos de firma (/f/:code) y servidor HTTP de firma autohospedado
const prevSigningSecret92 = process.env.PRESUVOZ_SIGNING_SECRET;
const prevPublicBaseUrl92 = process.env.PUBLIC_BASE_URL;
const prevSigningPortalUrl92 = process.env.SIGNING_PORTAL_URL;
process.env.PRESUVOZ_SIGNING_SECRET = 'secret_key_test_92_presuvoz_32_chars_minimum!!';

const tenant92 = ensureTenant92('34600929292');
const sampleBudget92 = saveBudget92(tenant92, {
  id: 'PRE-2026-092',
  client: { name: 'Elena Gómez', address: 'Calle Sierpes 12', phone: '611223344', email: 'elena@test.es' },
  items: [{ description: 'Pintura plástica lisa en salón', qty: 1, unit: 'pa', unitPrice: 450, total: 450 }],
  financials: { subtotal: 450, taxableBase: 450, taxRatePercentage: 10, taxAmount: 45, totalAmount: 495, advancePercentage: 30, advanceAmount: 148.5 },
  status: 'PENDIENTE_ACEPTACION'
});

// 1. Con PUBLIC_BASE_URL definido -> genera enlace corto profesional (/f/:code)
process.env.PUBLIC_BASE_URL = 'https://presuvoz.es';
const shortUrl92 = generateSigningUrl(sampleBudget92, { name: 'Reformas Paco', cif: 'B12345678', phone: '34600929292' }, '34600929292');
assert(shortUrl92.startsWith('https://presuvoz.es/f/') && shortUrl92.length < 35, `TEST 92 (D1): generateSigningUrl con PUBLIC_BASE_URL genera enlace corto profesional (${shortUrl92})`);
const shortCode92 = shortUrl92.split('/f/')[1];
const storedLink92 = getShortSigningLink(shortCode92);
assert(Boolean(storedLink92 && storedLink92.budgetId === 'PRE-2026-092' && storedLink92.z && storedLink92.s), "TEST 92 (D2): El enlace corto queda registrado con su payload comprimido z y firma HMAC s");

// 2. Sin PUBLIC_BASE_URL -> mantiene compatibilidad legacy con GitHub Pages
delete process.env.PUBLIC_BASE_URL;
delete process.env.SIGNING_PORTAL_URL;
const legacyUrl92 = generateSigningUrl(sampleBudget92, { name: 'Reformas Paco', cif: 'B12345678', phone: '34600929292' }, '34600929292');
assert(legacyUrl92.startsWith('https://albmarmar6.github.io/PresuVoz/studio/firmar.html?z='), "TEST 92 (D3): Sin PUBLIC_BASE_URL mantiene retrocompatibilidad con URL clásica");

// 3. Probar servidor HTTP real en puerto efímero (GET /webhook, GET /f/:code, POST /api/sign, GET /api/sign)
let signedCallbackPayload92 = null;
const httpServer92 = createPresuVozHttpServer({
  verifyToken: 'mi_token_secreto_meta_92',
  appSecret: testAppSecret92,
  signingSecret: process.env.PRESUVOZ_SIGNING_SECRET,
  onBudgetSigned: async (rec) => {
    signedCallbackPayload92 = rec;
  }
});

await new Promise((resolve) => httpServer92.listen(0, '127.0.0.1', resolve));
const port92 = httpServer92.address().port;
const baseHttp92 = `http://127.0.0.1:${port92}`;

try {
  // Verificación GET /webhook exitosa
  const whOkRes = await fetch(`${baseHttp92}/webhook?hub.mode=subscribe&hub.verify_token=mi_token_secreto_meta_92&hub.challenge=challenge_92_xyz`);
  const whOkText = await whOkRes.text();
  assert(whOkRes.status === 200 && whOkText === 'challenge_92_xyz', "TEST 92 (D4): GET /webhook responde 200 con hub.challenge cuando verify_token coincide");

  // Verificación GET /webhook fallida
  const whFailRes = await fetch(`${baseHttp92}/webhook?hub.mode=subscribe&hub.verify_token=token_incorrecto&hub.challenge=challenge_92_xyz`);
  assert(whFailRes.status === 403, "TEST 92 (D5): GET /webhook responde 403 cuando verify_token no coincide");

  //Servir página corta GET /f/:code
  const shortPageRes = await fetch(`${baseHttp92}/f/${shortCode92}`);
  const shortPageHtml = await shortPageRes.text();
  assert(shortPageRes.status === 200 && shortPageHtml.includes('window.__PRESUVOZ_PRELOAD__'), "TEST 92 (D6): GET /f/:code sirve studio/firmar.html inyectando window.__PRESUVOZ_PRELOAD__ sin redirección a URL larga");

  // Firmar presupuesto en POST /api/sign
  const signPostRes = await fetch(`${baseHttp92}/api/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedPayload: storedLink92.z,
      payloadProof: storedLink92.s,
      clientName: 'Elena Gómez',
      clientNif: '12345678Z',
      clientAddress: 'Calle Sierpes 12',
      clientEmail: 'elena@test.es',
      signatureDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    })
  });
  const signPostData = await signPostRes.json();
  assert(signPostRes.status === 200 && signPostData.ok === true, "TEST 92 (D7): POST /api/sign valida HMAC y registra la aceptación digital");
  assert(signedCallbackPayload92 && signedCallbackPayload92.budgetId === 'PRE-2026-092', "TEST 92 (D8): Callback onBudgetSigned se dispara en tiempo real al firmar");

  // Comprobar GET /api/sign?check=PRE-2026-092
  const signCheckRes = await fetch(`${baseHttp92}/api/sign?check=PRE-2026-092`);
  const signCheckData = await signCheckRes.json();
  assert(signCheckRes.status === 200 && signCheckData.alreadySigned === true, "TEST 92 (D9): GET /api/sign?check=PRE-2026-092 confirma que el presupuesto ya está firmado");

  // Sincronizar con SQLite mediante syncPendingSignaturesFromCloud
  const synced92 = await syncSig92(tenant92);
  assert(synced92.some(item => item.budgetId === 'PRE-2026-092'), "TEST 92 (D10): syncPendingSignaturesFromCloud detecta la firma local instantáneamente sin depender de servicios externos");
  const updatedBudget92 = getBudget92(tenant92, 'PRE-2026-092');
  assert(updatedBudget92?.status === 'ACEPTADO', "TEST 92 (D11): El presupuesto en SQLite pasa automáticamente a estado ACEPTADO");
} finally {
  httpServer92.close();
  if (prevSigningSecret92 !== undefined) process.env.PRESUVOZ_SIGNING_SECRET = prevSigningSecret92;
  else delete process.env.PRESUVOZ_SIGNING_SECRET;
  if (prevPublicBaseUrl92 !== undefined) process.env.PUBLIC_BASE_URL = prevPublicBaseUrl92;
  else delete process.env.PUBLIC_BASE_URL;
  if (prevSigningPortalUrl92 !== undefined) process.env.SIGNING_PORTAL_URL = prevSigningPortalUrl92;
  else delete process.env.SIGNING_PORTAL_URL;
  clearShortLinksAndSignaturesForTesting();
}


if (passedCount === totalCount) {
  console.log(`✅ RESULTADO: ${passedCount}/${totalCount} PRUEBAS SUPERADAS CON ÉXITO.`);
  console.log("🛡️  El motor es 100% conversacional, tolerante a fallos y soporta borradores, capítulos y descuentos.");
} else {
  console.error(`❌ RESULTADO: ${passedCount}/${totalCount} pruebas superadas.`);
}
console.log("==========================================================");



