import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { PresuVozEngine } from './engine.js';
import { PresuVozGenerator } from './generator.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const engine = new PresuVozEngine({
  name: "Carpintería y Reformas Manolo S.L.",
  cif: "B-41987654",
  phone: "620 44 55 66",
  email: "presupuestos@carpinteriamanolo.es",
  address: "Polígono Industrial La Negrilla, Nave 12, Sevilla",
  logoText: "CM",
  brandColor: "#9a3412",
  professionalSigner: "Manuel Sánchez (Gerente)"
});

let currentBudget = null;

console.clear();
console.log("==================================================================");
console.log("🟢 SIMULADOR INTERACTIVO DE ASISTENTE WHATSAPP — PRESUVOZ");
console.log("==================================================================");
console.log("Ponte en la piel del instalador hablando desde su furgoneta.");
console.log("Puedes dictar con muletillas, 'pavos', quejas, o dejar precios pendientes.\n");

console.log("💡 EJEMPLOS QUE PUEDES PROBAR:");
console.log("1. Completo: 'Para Don Carlos en Calle Mayor 10: plato de ducha 400 pavos y mampara 200. IVA 10% y 30% de anticipo'");
console.log("2. Con olvido: 'Para Pedro en Calle Real 4: cambiar plato por 450 euros y alicatado que no sé el precio'");
console.log("3. Borrador sin precio: 'Para María en Avenida Paz: cambiar ventana y rozas de enchufes en cocina'\n");

function promptUser() {
  const promptText = currentBudget
    ? "\n💬 Escribe un mensaje para actualizar (ej: 'Ponle 200 al alicatado') o 'nuevo' / 'salir':\n> "
    : "\n🎙️ Dicta o escribe el audio que enviarías a WhatsApp (o 'salir'):\n> ";

  rl.question(promptText, (input) => {
    const trimmed = input.trim();

    if (!trimmed || trimmed.toLowerCase() === 'salir') {
      console.log("\n👋 ¡Hasta luego! Simulador cerrado.");
      rl.close();
      return;
    }

    if (trimmed.toLowerCase() === 'nuevo') {
      currentBudget = null;
      console.log("\n🔄 Nuevo presupuesto iniciado.");
      promptUser();
      return;
    }

    // Si ya tenemos un presupuesto abierto, intentar actualizarlo
    if (currentBudget) {
      console.log("\n⚙️  Procesando actualización conversacional...");
      const updateResult = engine.updateBudgetPrice(currentBudget, trimmed);

      console.log("\n📱 MENSAJE DEL ASISTENTE POR WHATSAPP:");
      console.log("------------------------------------------------------------------");
      console.log(updateResult.assistantMessage);
      console.log("------------------------------------------------------------------");

      if (updateResult.success) {
        currentBudget = updateResult.budget;
        saveAndOpenBudget(currentBudget);
      }
      promptUser();
      return;
    }

    // Procesar nuevo audio desde cero
    console.log("\n⚙️  El motor está analizando tu audio, limpiando muletillas y calculando impuestos...");
    const result = engine.process(trimmed);

    console.log("\n📱 MENSAJE DEL ASISTENTE POR WHATSAPP:");
    console.log("------------------------------------------------------------------");
    console.log(result.assistantFeedback);
    console.log("------------------------------------------------------------------");

    if (result.success && result.budget) {
      currentBudget = result.budget;
      saveAndOpenBudget(currentBudget);
    }

    promptUser();
  });
}

function saveAndOpenBudget(budget) {
  const html = PresuVozGenerator.generateHTML(budget);
  const outPath = path.resolve('output', 'presupuesto_interactivo.html');
  
  if (!fs.existsSync('output')) {
    fs.mkdirSync('output', { recursive: true });
  }

  fs.writeFileSync(outPath, html, 'utf-8');

  console.log(`\n📄 Documento actualizado en tiempo real:`);
  console.log(`👉 ${outPath}`);
  console.log(`🌐 Abriendo vista previa en tu navegador...`);

  // Abrir en el navegador en Windows
  exec(`start "" "${outPath}"`, (err) => {
    if (err) {
      console.log(`(Abre manualmente el archivo en tu navegador: file:///${outPath.replace(/\\/g, '/')})`);
    }
  });
}

promptUser();
