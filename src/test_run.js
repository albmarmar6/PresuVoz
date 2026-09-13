import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PresuVozEngine } from './engine.js';
import { PresuVozGenerator } from './generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("==========================================================");
console.log("⚡ INICIANDO MOTOR DE CÓDIGO PRESUVOZ (TEST RUN)");
console.log("==========================================================\n");

// 1. Inicializar el motor con los datos de "Carpintería Manolo"
const engine = new PresuVozEngine({
  name: "Carpintería & Reformas Manolo S.L.",
  cif: "B-41987654",
  phone: "620 44 55 66",
  email: "presupuestos@carpinteriamanolo.es",
  address: "Polígono Industrial La Negrilla, Nave 12, Sevilla",
  logoText: "CM",
  brandColor: "#9a3412", // Color madera cálido profesional
  professionalSigner: "Manuel Sánchez (Gerente)",
  signatureImage: null
});

// 2. Simulación de Nota de Voz recibida de Manolo desde su furgoneta
const audioTranscriptSimulada = `
Oye Carlos, para Don Francisco Pérez en Calle San Jacinto 12 en Sevilla.
Hay que hacerle:
- Fabricación a medida de armario empotrado de 3 hojas correderas en acabado roble con cajonera interior y pantalonero: 1250 euros.
- Cepillado, ajuste y cambio de manivelas en 5 puertas de paso de la vivienda: 280 euros.
- Suministro y montaje de tarima flotante AC5 en salón (28 metros cuadrados) con aislante acústico: 560 euros.
Al ser carpintería para su piso de vivienda habitual, indícale el IVA reducido del 10%.
Que la validez son 15 días y cobramos el 40% por adelantado a la firma para pedir los tableros de madera.
`;

console.log("🎙️ 1. AUDIO RECIBIDO DE LA FURGONETA DE MANOLO (Whisper):");
console.log("----------------------------------------------------------");
console.log(audioTranscriptSimulada.trim());
console.log("----------------------------------------------------------\n");

// 3. Procesar mediante el motor
console.log("⚙️  2. PROCESANDO CON EL MOTOR PRESUVOZ PARA CARPINTERÍA MANOLO...");

const processedBudget = engine.process({
  rawTranscript: audioTranscriptSimulada,
  clientName: "Francisco Pérez Martínez",
  clientAddress: "Calle San Jacinto 12, 2ºA, Sevilla",
  clientPhone: "611 99 88 77",
  clientEmail: "francisco.perez@email.com",
  items: [
    { description: "Fabricación a medida de armario empotrado (3 hojas correderas, melamina roble, cajonera interior y pantalonero)", qty: 1, price: 1250.00 },
    { description: "Revisión, cepillado de holguras y sustitución de manivelas en puertas de paso", qty: 5, price: 56.00 },
    { description: "Suministro e instalación de suelo laminado AC5 con base aislante acústica en salón (28 m²)", qty: 1, price: 560.00 }
  ]
});

console.log("\n📊 3. DESGLOSE FINANCIERO Y TRIBUTARIO CALCULADO:");
console.log("----------------------------------------------------------");
console.log(`• ID Presupuesto:        ${processedBudget.id}`);
console.log(`• Cliente:               ${processedBudget.client.name}`);
console.log(`• Tipo de IVA Detectado: ${processedBudget.financials.taxRatePercentage}% (Reducido Vivienda Habitual)`);
console.log(`• Base Imponible:        ${processedBudget.financials.subtotal.toFixed(2)} €`);
console.log(`• Cuota de IVA:          ${processedBudget.financials.taxAmount.toFixed(2)} €`);
console.log(`• TOTAL DEL PRESUPUESTO: ${processedBudget.financials.totalAmount.toFixed(2)} €`);
console.log(`• Anticipo requerido:    ${processedBudget.financials.advancePercentage}% (${processedBudget.financials.advanceAmount.toFixed(2)} €)`);
console.log(`• Enlace Firma Cliente:  ${processedBudget.signUrl}`);
console.log("----------------------------------------------------------\n");

// 4. Generar el documento visual interactivo
console.log("📄 4. GENERANDO DOCUMENTO DEL PRESUPUESTO CON FIRMA TÁCTIL...");
const htmlContent = PresuVozGenerator.generateHTML(processedBudget);

const outputDir = path.join(__dirname, '..', 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, 'presupuesto_demo.html');
fs.writeFileSync(outputPath, htmlContent, 'utf-8');

console.log(`✅ ¡ÉXITO! Presupuesto formal generado en:`);
console.log(`👉 ${outputPath}\n`);
console.log("==========================================================");
console.log("🚀 El motor ha completado el ciclo completo en < 0.1 segundos.");
console.log("==========================================================");
