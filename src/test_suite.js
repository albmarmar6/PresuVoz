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
// CASO 4: Guardarraíl de Seguridad — Audio incompleto donde falta el precio
// -----------------------------------------------------------------------------
console.log("TEST 4: Detección de errores y seguridad cuando falta el precio");
const audioIncompleto = `
Para Pedro en Calle Mayor:
- Quiero cambiar la bañera por plato de ducha pero no sé cuánto cobrarle todavía.
- Alicatar la pared del baño.
`;

const res4 = engine.process(audioIncompleto);
assert(res4.success === false, "El motor RECHAZA generar un presupuesto si faltan importes");
assert(res4.errors.length > 0, "Devuelve la lista de errores para avisar al profesional");
console.log(`  Mensaje de alerta emitido: "${res4.errors[0]}"`);
console.log("");

// -----------------------------------------------------------------------------
// RESUMEN FINAL
// -----------------------------------------------------------------------------
console.log("==========================================================");
if (passedCount === totalCount) {
  console.log(`✅ RESULTADO: ${passedCount}/${totalCount} PRUEBAS SUPERADAS CON ÉXITO.`);
  console.log("🛡️  El motor está 100% blindado contra palabras coloquiales y errores.");
} else {
  console.error(`❌ RESULTADO: ${passedCount}/${totalCount} pruebas superadas.`);
}
console.log("==========================================================");
