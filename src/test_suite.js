import { PresuVozEngine } from './engine.js';
import { PresuVozParser } from './parser.js';

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
console.log("==========================================================");
if (passedCount === totalCount) {
  console.log(`✅ RESULTADO: ${passedCount}/${totalCount} PRUEBAS SUPERADAS CON ÉXITO.`);
  console.log("🛡️  El motor es 100% conversacional, tolerante a fallos y soporta borradores.");
} else {
  console.error(`❌ RESULTADO: ${passedCount}/${totalCount} pruebas superadas.`);
}
console.log("==========================================================");
