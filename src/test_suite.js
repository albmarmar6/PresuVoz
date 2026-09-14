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
// RESUMEN FINAL
// -----------------------------------------------------------------------------
console.log("==========================================================");
if (passedCount === totalCount) {
  console.log(`✅ RESULTADO: ${passedCount}/${totalCount} PRUEBAS SUPERADAS CON ÉXITO.`);
  console.log("🛡️  El motor es 100% conversacional, tolerante a fallos y soporta borradores.");
} else {
  console.error(`❌ RESULTADO: ${passedCount}/${totalCount} pruebas superadas.`);
}
console.log("==========================================================");
