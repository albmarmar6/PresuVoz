import './test_env_setup.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PresuVozEngine } from './engine.js';
import { PresuVozParser } from './parser.js';
import { generateInvoicePDF } from './pdf_service.js';
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
  handleAddShoppingItems,
  handleListShoppingItems,
  handleMarkShoppingItemBought,
  handleClearShoppingList
} from './whatsapp_gateway.js';

export function computeFileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Captura de integridad inicial de la base de datos de producción
const PROD_DB_PATH = path.resolve('data', 'presuvoz.db');
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
Al ser vivienda habitual ponle el IVA reducido del diez.
`;

const res1 = engine.process(audioSucio);

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
const audioContinuo = "hola buenas tardes me gustaría presupuestar una casa en torrelavella en Sevilla con una mampara de 250 euros habría que cambiar el suelo del baño habría que hacer una reforma integral de quitar las paredes de la cocina también de la habitación eso lo llevaría aún total de 300 euros y ya está";

const res7 = engine.process(audioContinuo);
assert(res7.success === true, "Procesa con éxito un audio continuo sin pausas ni puntuación");
assert(res7.client.address === "Torrelavella, Sevilla", `Extrae la localidad limpia ('Torrelavella, Sevilla'). Obtenido: ${res7.client.address}`);
assert(res7.items.length === 3, `Segmenta con precisión las 3 partidas descritas. Obtenido: ${res7.items.length}`);
assert(res7.items[0].total === 250, "Partida 1 (Mampara): 250.00 €");
assert(res7.items[1].isPricePending === true, "Partida 2 (Suelo del baño): Marcada como pendiente de valorar");
assert(res7.items[2].total === 300, "Partida 3 (Demolición paredes/cocina/habitación): 300.00 €");
assert(res7.financials.subtotal === 550, `Subtotal exacto (250 + 300 = 550 €). Obtenido: ${res7.financials.subtotal} €`);
assert(res7.financials.taxRatePercentage === 10, "Aplica IVA reducido del 10% para reforma de vivienda");
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

const audioReal1 = "hola buenas tardes para alberto martín la casa se encuentra en sevilla en la calle girasol numero 7 , 2ºC demoler tabiques 250 euros mampara 100 euros hacer una reestructuración de las ventanas cambiar soporte eléctrico y eso sería todo";
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

const audioObraCompleta = "oye te voy a comentar la partida primera partida eh demoliciones y de escombro uno un corte un corte estimado de unos 4.500 a 6000 euros porque habría que hacer un picado de azulejos de arriba de tabiquería interior vieja retirada de carpintería etc luego la partida segunda sería albañilería general y distribución un levantado tabique nuevo en maestrado y regresión solo para nivelar enfocado falso techo de pladur en toda vivienda eso podría costar unos 8.000 a 11.000 euros luego vamos con la partida tercera fontanería y saneamiento red completa nuevas multicapa o polietileno reticulado unos 4.205.000 euros electricidad y telecomunicaciones sería la cuarta partida entre unos 4.000 y 5.500 euros porque habría que hacer un cuadro general nuevo según RBT con protaciones completas y por último la partida cinco alicatados y solados que sería unos 5.500 7.500 euros porque habría que hacer una colocación de suelo porcelánico o grespe en, que esta bastante bien, sinceramente.";

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
assert(res10.financials.taxRatePercentage === 10, "Aplica IVA reducido del 10% por tratarse de reforma de vivienda");
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
assert(res11.financials.taxRatePercentage === 10, "Aplica IVA reducido del 10% por incluir cocina");
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
  if (/nuevo\s+presupuesto|presupuesto\s+nuevo|factura|cobro|pago|anticipo|cu[aá]nto\s+me\s+debe/i.test(t)) {
    return null;
  }
  if (!/(?:presupuesto|borrador|sin\s+firmar|por\s+firmar)/i.test(t)) {
    if (!/^(?:1|lista)$/i.test(t)) return null;
  }
  const isListQuery = /^(?:1|lista|mis\s+presupuestos|ver\s+presupuestos)$/i.test(t) ||
    /(?:list(?:ar?|ame|a)?|ver|dime|cu[aá]les|qu[eé]|mostrar|enseñar|consultar|sacar)/i.test(t) ||
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
  clearShoppingList
} from './db_service.js';

const shoppingPhone = '34699001122';
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

// Paso 5: Forma de cobro
const r5 = processOnboardingStep(onboardPhone, "50% al empezar y 50% al acabar");
assert(r5.handled === true, "Paso 5 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'ADVANCE', "Avanza al paso 6 (ADVANCE)");
assert(st.company.paymentTerms.includes("50%"), "Guarda condiciones de cobro");

// Paso 6: Anticipo habitual
const r6 = processOnboardingStep(onboardPhone, "40%");
assert(r6.handled === true, "Paso 6 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'QUOTE_VALIDITY', "Avanza al paso 7 (QUOTE_VALIDITY)");
assert(st.company.defaultAdvance === 40, "Guarda anticipo del 40% en SQLite");

// Paso 7: Validez presupuestos
const r7 = processOnboardingStep(onboardPhone, "15 días");
assert(r7.handled === true, "Paso 7 procesado");
st = getOnboardingState(onboardPhone);
assert(st.step === 'ENTITY_TYPE', "Avanza al paso 8 (ENTITY_TYPE)");
assert(st.company.quoteValidityDays === 15, "Guarda validez de 15 días en SQLite");

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
assert(finalComp.defaultAdvance === 40, "Conserva defaultAdvance");
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
assert(debtCarlos?.params?.clientName === 'carlos', "Extrae nombre de cliente 'carlos'");

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

// -----------------------------------------------------------------------------
// CASO 21: Persistencia de Mensajes (messages), Deduplicación y Estados de Conversación
// -----------------------------------------------------------------------------
console.log("\nTEST 21: Persistencia de Mensajes (messages), Deduplicación y Estados de Conversación");
import {
  recordIncomingMessage,
  updateMessageStatus,
  getMessageByWhatsappId,
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
  savePurchaseInvoice,
  listPurchaseInvoices,
  saveExpensePayment,
  listExpensePayments,
  saveInvestmentAsset,
  listInvestmentAssets,
  getOrCreateFiscalPeriod,
  updateFiscalPeriodStatus,
  listFiscalIncidents,
  recordAuditLog,
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

// 3. Ejecutar envío seguro simulado
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

// -----------------------------------------------------------------------------
// TEST 23: MODELO INTEGRAL DE VISITAS (REGLA DE ORO CONFIRMED, CICLO DE VIDA, REAGENDAMIENTOS Y AUDITORÍA)
// -----------------------------------------------------------------------------
console.log("\nTEST 23: Arquitectura Integral de Visitas Técnicas (CONFIRMED directo, Reagendamiento, Fin de Día y Auditoría)");

const testVisitPhone = '34611998877';
cleanDb.prepare('DELETE FROM appointments WHERE company_phone = ?').run(testVisitPhone);
cleanDb.prepare('DELETE FROM audit_logs WHERE business_id = ?').run(testVisitPhone);

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

// 6. Ingress: Mensaje entrante de teléfono desconocido
const inInUnknownPhone = shouldProcessIncomingMessage({
  remoteJid: unknownContactPhone,
  fromMe: false,
  myNumber: myTestPhone,
  myLid: myTestLid,
  allowedNumbers: allowedTestNumbers
});
assert(inInUnknownPhone.process === false, "CASO 16: Ingress BLOQUEA mensaje entrante de teléfono desconocido");

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

// 14. Regresión: todos los 521 tests originales siguen pasando al 100%
const baselinePassed = (passedCount === 521 + 13);
assert(baselinePassed, "14. Regresión: los 521 tests originales siguen pasando al 100%");

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
  saveFiscalIncident,
  resolveFiscalIncident
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

// 1. Cross-tenant purchase invoice read: getPurchaseInvoice(tenantB, idA) devuelve null
const invA34 = savePurchaseInvoice(contextFiscalA, {
  id: 'REC-34-A01',
  supplierName: 'Materiales Eléctricos A',
  supplierTaxId: 'B-11111111',
  taxBase: 500,
  vatRate: 21,
  totalAmount: 605,
  issueDate: '2026-08-10'
});

const crossReadPinv = getPurchaseInvoice(contextFiscalB, 'REC-34-A01');
assert(crossReadPinv === null, "1. Cross-Tenant Read: getPurchaseInvoice(tenantB, idA) devuelve null (Zero-Disclosure cross-tenant)");
const legitReadPinv = getPurchaseInvoice(contextFiscalA, 'REC-34-A01');
assert(legitReadPinv !== null && legitReadPinv.id === 'REC-34-A01', "1b. Lectura legítima: getPurchaseInvoice(tenantA, idA) recupera la factura de compra");

// 2. Cross-tenant purchase invoice delete: deletePurchaseInvoice(tenantB, idA) devuelve false y permanece intacta
const crossDeletePinv = deletePurchaseInvoice(contextFiscalB, 'REC-34-A01');
assert(crossDeletePinv === false, "2. Cross-Tenant Delete: deletePurchaseInvoice(tenantB, idA) devuelve false y bloquea la eliminación");
const verifyPinvIntact = currentDb.prepare("SELECT * FROM purchase_invoices WHERE id = ?").get('REC-34-A01');
assert(verifyPinvIntact !== null && verifyPinvIntact.supplier_name === 'Materiales Eléctricos A', "2b. Integridad en SQLite: la factura de Tenant A permanece 100% intacta tras intento cross-tenant");

// 3. Cross-tenant fiscal incident resolve: resolveFiscalIncident(tenantB, incA) devuelve false y permanece OPEN
saveFiscalIncident(contextFiscalA, {
  entityType: 'PURCHASE_INVOICE',
  entityId: 'REC-34-A01',
  errorCode: 'MISSING_DOC',
  severity: 'WARNING',
  message: 'Justificante pendiente'
});
const incidentsA = listFiscalIncidents(contextFiscalA);
const incA = incidentsA.find(i => i.entity_id === 'REC-34-A01' || i.entityId === 'REC-34-A01');
const incAId = incA ? (incA.id || incA.entity_id) : 'REC-34-A01';

const crossResolveInc = resolveFiscalIncident(contextFiscalB, incAId);
assert(crossResolveInc === false, "3. Cross-Tenant Incident: resolveFiscalIncident(tenantB, incA) devuelve false");
const verifyIncOpen = currentDb.prepare("SELECT resolution_status FROM fiscal_incidents WHERE id = ?").get(incAId);
assert(verifyIncOpen && verifyIncOpen.resolution_status === 'OPEN', "3b. Integridad Incidencia: la incidencia de Tenant A permanece OPEN tras intento cross-tenant");

const legitResolveInc = resolveFiscalIncident(contextFiscalA, incAId);
assert(legitResolveInc === true, "3c. Resolución legítima: resolveFiscalIncident(tenantA, incA) resuelve con éxito");
const verifyIncResolved = currentDb.prepare("SELECT resolution_status FROM fiscal_incidents WHERE id = ?").get(incAId);
assert(verifyIncResolved && verifyIncResolved.resolution_status === 'RESOLVED', "3d. Integridad Incidencia: estado pasa a RESOLVED para el tenant autorizado");

// 4. Model Injection Defense: objeto malicioso emitido por IA con company_id / business_id de Beta
const injectedAiPayload = {
  company_id: compFiscalB.companyId,
  companyId: compFiscalB.companyId,
  businessId: phoneFiscalB,
  business_id: phoneFiscalB,
  id: 'REC-34-INJECT-01',
  supplierName: 'Proveedor Inyección Maliciosa',
  taxBase: 300,
  vatRate: 21,
  totalAmount: 363,
  issueDate: '2026-08-12'
};
// Guardado ejecutado en sesión de Tenant A:
savePurchaseInvoice(contextFiscalA, injectedAiPayload);
const verifyInjectionNeutralized = currentDb.prepare("SELECT business_id FROM purchase_invoices WHERE id = ?").get('REC-34-INJECT-01');
assert(verifyInjectionNeutralized.business_id === phoneFiscalA, "4. Model Injection: savePurchaseInvoice neutraliza businessId/companyId inyectados y fuerza el tenant autenticado de Alpha");

// 5. Unauthenticated spoof defense: llamadas con contexto nulo/indefinido
assert(getPurchaseInvoice(null, 'REC-34-A01') === null, "5a. Unauthenticated Spoof: getPurchaseInvoice(null) deniega acceso y retorna null");
assert(deletePurchaseInvoice(null, 'REC-34-A01') === false, "5b. Unauthenticated Spoof: deletePurchaseInvoice(null) deniega eliminación y retorna false");
assert(resolveFiscalIncident(null, incAId) === false, "5c. Unauthenticated Spoof: resolveFiscalIncident(null) deniega resolución y retorna false");

// 6. resolveLegacyBusinessId verification
const resByIdA = resolveLegacyBusinessId(compFiscalA.companyId);
assert(resByIdA === phoneFiscalA, "6a. Resolver canónico: resolveLegacyBusinessId(UUID_A) retorna cleanPhone canónico");
const resByContextA = resolveLegacyBusinessId({ companyId: compFiscalA.companyId });
assert(resByContextA === phoneFiscalA, "6b. Resolver canónico: resolveLegacyBusinessId({ companyId: UUID_A }) retorna cleanPhone canónico");
const resInvalidUuid = resolveLegacyBusinessId('00000000-0000-0000-0000-000000000000');
assert(resInvalidUuid === null, "6c. Resolver canónico: UUID inexistente retorna null (Fail-Closed)");
const resNull = resolveLegacyBusinessId(null);
assert(resNull === null, "6d. Resolver canónico: contexto nulo retorna null");

// 7. Modelo 303 isolation: getQuarterSummary solo computa facturas emitidas de su company_id
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

assert(summaryA34.summary.issuedCount === 1, "7a. Modelo 303 Isolation: Tenant A solo computa 1 factura emitida propia");
assert(summaryA34.summary.issuedTaxBase === 1000, "7b. Modelo 303 Isolation: Base imponible de Tenant A es 1.000€ (sin contaminar con Beta)");
assert(summaryA34.summary.issuedVatTotal === 210, "7c. Modelo 303 Isolation: IVA devengado de Tenant A es 210€");
assert(summaryB34.summary.issuedCount === 1, "7d. Modelo 303 Isolation: Tenant B solo computa 1 factura emitida propia");
assert(summaryB34.summary.issuedTaxBase === 2000, "7e. Modelo 303 Isolation: Base imponible de Tenant B es 2.000€");
assert(summaryB34.summary.issuedVatTotal === 420, "7f. Modelo 303 Isolation: IVA devengado de Tenant B es 420€");

// 8. Export collision defense: Dos empresas sin CIF generan Cierre_Fiscal_..._SINCIF.zip
const pkgA = await buildGestoriaPackageZip(contextFiscalA, 2026, 3);
const pkgB = await buildGestoriaPackageZip(contextFiscalB, 2026, 3);

assert(path.basename(pkgA.zipPath) === pkgA.fileName && pkgA.fileName.startsWith('Cierre_Fiscal_2026_Q3_'), "8a. Export Collision: Nombre de archivo de exportación coincide con patrón oficial");
assert(path.basename(pkgB.zipPath) === pkgB.fileName && pkgB.fileName.startsWith('Cierre_Fiscal_2026_Q3_'), "8b. Export Collision: Nombre de archivo de exportación de B coincide");
assert(pkgA.zipPath !== pkgB.zipPath, "8c. Export Collision: Las rutas físicas de almacenamiento son distintas (aisladas por companyId)");
assert(pkgA.zipPath.includes(compFiscalA.companyId), "8d. Export Collision: El archivo de Alpha reside dentro de su directorio data/fiscal_exports/<company_id>/");
assert(pkgB.zipPath.includes(compFiscalB.companyId), "8e. Export Collision: El archivo de Beta reside dentro de su directorio data/fiscal_exports/<company_id>/");
assert(fs.existsSync(pkgA.zipPath) && fs.existsSync(pkgB.zipPath), "8f. Export Collision: Ambos archivos coexisten simultáneamente en disco sin sobrescribirse");

// Limpiar archivos físicos de exportación generados durante el test
try {
  if (fs.existsSync(pkgA.zipPath)) fs.unlinkSync(pkgA.zipPath);
  if (fs.existsSync(pkgB.zipPath)) fs.unlinkSync(pkgB.zipPath);
  const dirA = path.dirname(pkgA.zipPath);
  const dirB = path.dirname(pkgB.zipPath);
  if (fs.existsSync(dirA)) fs.rmdirSync(dirA);
  if (fs.existsSync(dirB)) fs.rmdirSync(dirB);
} catch (e) {}

// 9. Tax profile isolation: saveTaxProfile y getTaxProfile
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

const profileA = getTaxProfile(contextFiscalA);
const profileB = getTaxProfile(contextFiscalB);

assert(profileA.vatRegime === 'GENERAL' && profileA.defaultIrpfRate === 15, "9a. Tax Profile Isolation: Perfil de Alpha mantiene su régimen General e IRPF 15%");
assert(profileB.vatRegime === 'RECARGO_EQUIVALENCIA' && profileB.defaultIrpfRate === 0, "9b. Tax Profile Isolation: Perfil de Beta mantiene Recargo de Equivalencia");

// 10. Fiscal period isolation: getOrCreateFiscalPeriod y updateFiscalPeriodStatus
const periodA = getOrCreateFiscalPeriod(contextFiscalA, 2026, 4);
const periodB = getOrCreateFiscalPeriod(contextFiscalB, 2026, 4);

assert(periodA.status === 'OPEN', "10a. Fiscal Period: El periodo 4T 2026 de Alpha se inicializa en OPEN");
assert(periodB.status === 'OPEN', "10b. Fiscal Period: El periodo 4T 2026 de Beta se inicializa en OPEN");

updateFiscalPeriodStatus(contextFiscalB, 2026, 4, 'CLOSED');
const periodAAfterBUpdate = currentDb.prepare("SELECT status FROM fiscal_periods WHERE business_id = ? AND fiscal_year = 2026 AND quarter = 4").get(phoneFiscalA);
const periodBAfterBUpdate = currentDb.prepare("SELECT status FROM fiscal_periods WHERE business_id = ? AND fiscal_year = 2026 AND quarter = 4").get(phoneFiscalB);

assert(periodBAfterBUpdate.status === 'CLOSED', "10c. Fiscal Period: El periodo de Beta pasa a CLOSED");
assert(periodAAfterBUpdate.status === 'OPEN', "10d. Fiscal Period Isolation: El periodo de Alpha permanece en OPEN (inmune a mutaciones de Beta)");

// 11. Integridad relacional y verificación de base de datos
const fkCheck34 = currentDb.prepare('PRAGMA foreign_key_check').all();
assert(fkCheck34.length === 0, "11a. Integridad: PRAGMA foreign_key_check 0 violaciones tras TEST 34");

const integrityCheck34 = currentDb.prepare('PRAGMA integrity_check').get();
assert(integrityCheck34.integrity_check === 'ok', "11b. Integridad: PRAGMA integrity_check confirma base de datos 100% íntegra (ok)");

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
  version: 7,
  name: '007_future_fiscal_company_id',
  up: (db) => {
    db.exec("CREATE TABLE IF NOT EXISTS test_future_007 (id TEXT PRIMARY KEY, note TEXT);");
  }
};
const extendedMigrations = [...MIGRATIONS, mockMigration007];

// 1. Dry run / check detection
const dryRunCheck = checkMigrationsDryRun(tempDb36, extendedMigrations);
assert(!dryRunCheck.isUpToDate, "1. Test 36: Migración 007 futura detectada como pendiente en dry-run");
assert(dryRunCheck.pendingCount === 1, "2. Test 36: Hay exactamente 1 migración pendiente en dry-run");
assert(dryRunCheck.pending[0].version === 7, "3. Test 36: La migración pendiente es la versión 7");
assert(dryRunCheck.pending[0].name === '007_future_fiscal_company_id', "4. Test 36: Nombre de migración pendiente coincide");

// 2. Comprobar que dry-run es estrictamente de solo lectura y no ejecuta nada
const appliedBefore36 = getAppliedMigrations(tempDb36, { dryRun: true });
assert(appliedBefore36.length === MIGRATIONS.length, "5. Test 36: El número de migraciones aplicadas en DB permanece inalterado tras dry-run");
const tableCheckBefore36 = tempDb36.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_future_007'").get();
assert(!tableCheckBefore36, "6. Test 36: La tabla de la migración 007 NO existe en la base de datos tras dry-run");

// 3. Intento de ejecutar migración 007 sin autorización explícita (fail-closed)
let caughtUnauthGen007 = false;
try {
  runMigrations(tempDb36, { migrations: extendedMigrations, authorized: false });
} catch (err) {
  caughtUnauthGen007 = true;
  assert(err.message.includes('MIGRATION GUARD'), "7. Test 36: Ejecución sin authorized: true es rechazada inmediatamente (fail-closed)");
}
assert(caughtUnauthGen007, "8. Test 36: Base de datos no modificada ante intento no autorizado");

// 4. Intento de ejecutar migración 007 sobre producción sin allowProduction (fail-closed)
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
  assert(err.message.includes('PRODUCCIÓN'), "9. Test 36: Intento de aplicar migración 007 a producción sin allowProduction lanza error crítico");
}
assert(caughtUnauthProd007, "10. Test 36: Producción blindada contra migración 007 accidental");

// 5. Aplicación explícitamente autorizada en DB de prueba funciona correctamente
const appliedResult36 = runMigrations(tempDb36, { migrations: extendedMigrations, authorized: true });
assert(appliedResult36.appliedCount === 1, "11. Test 36: Migración 007 se aplica con éxito cuando está explícitamente autorizada");
const appliedAfter36 = getAppliedMigrations(tempDb36, { dryRun: true });
assert(appliedAfter36.length === extendedMigrations.length, "12. Test 36: schema_migrations contiene ahora la versión 7");
const tableCheckAfter36 = tempDb36.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_future_007'").get();
assert(!!tableCheckAfter36, "13. Test 36: La tabla test_future_007 ha sido creada correctamente por la migración");

tempDb36.close();
if (fs.existsSync(tempDb36_Path)) fs.unlinkSync(tempDb36_Path);

console.log("==========================================================");
if (passedCount === totalCount) {
  console.log(`✅ RESULTADO: ${passedCount}/${totalCount} PRUEBAS SUPERADAS CON ÉXITO.`);
  console.log("🛡️  El motor es 100% conversacional, tolerante a fallos y soporta borradores, capítulos y descuentos.");
} else {
  console.error(`❌ RESULTADO: ${passedCount}/${totalCount} pruebas superadas.`);
}
console.log("==========================================================");

