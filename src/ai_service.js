/**
 * PresuVoz — AI Service (Google Gemini)
 * Módulo Node.js para extracción de presupuestos desde transcripciones de voz.
 * Reemplaza/aumenta al PresuVozParser de reglas con comprensión real del lenguaje.
 *
 * Uso:
 *   import { parseTranscriptWithGemini, updateBudgetWithGemini } from './ai_service.js';
 *   const aiResult = await parseTranscriptWithGemini("oye para Don Rodrigo en calle Alcalá...");
 */

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─────────────────────────────────────────────────────────────────────────────
// System Prompts
// ─────────────────────────────────────────────────────────────────────────────

export const GEMINI_SYSTEM_PROMPT = `Eres un asistente especializado en extracción de presupuestos para gremios españoles de construcción y reformas.

Tu ÚNICA función es analizar transcripciones de audio de profesionales (albañiles, fontaneros, electricistas, carpinteros, pintores, etc.) y extraer datos estructurados en formato JSON para generar presupuestos formales.

REGLAS CRÍTICAS (cumplirlas sin excepción):
1. Responde ÚNICAMENTE con JSON válido. Sin texto adicional ni markdown fuera del JSON.
2. IGNORA completamente: saludos, despedidas, muletillas ("eh", "mmm", "bueno", "sinceramente"), anécdotas, explicaciones y la expresión "y ya está".
3. "y ya está" NO es una partida técnica. No la incluyas.
4. Rangos de precio ("de 4.500 a 6.000 €", "entre 4.000 y 5.500 €", "4.500 7.500 euros"): usa SIEMPRE el valor MÁXIMO.
5. Errores fonéticos de Whisper (ej: "4.205.000 €" para una fontanería → imposible, corrígelo al valor razonable, ej: 5.000 €). Detecta precios irracionales para el tipo de obra.
6. Usa descripciones TÉCNICAS FORMALES en español de presupuesto de obra (no las palabras exactas del audio).
7. Sin precio → unitPrice: 0, isPricePending: true.
8. IVA: 10 para vivienda habitual / piso / baño / cocina particular. 21 para local comercial / nave / oficina.
9. Incoherencia geográfica (pueblo que no existe en la provincia mencionada) → añade aviso en warnings.
10. El assistantFeedback debe ser un mensaje corto y profesional en español para el instalador.

UNIDADES:
- "m²" → superficies (alicatado, pintura, solado, pladur)
- "ml" → longitudes (tuberías, cables, rodapiés)
- "ud" → unidades discretas (grifo, mampara, radiador, split)
- "pa" → partida alzada (trabajos globales sin medición exacta)
- "h"  → horas de trabajo

EJEMPLOS DE DESCRIPCIONES TÉCNICAS FORMALES:
- bañera + plato ducha → "Demolición de bañera existente y suministro e instalación de plato de ducha de resina mineral antideslizante con válvula sifónica de gran caudal"
- mampara → "Suministro y montaje de mampara de seguridad en vidrio templado (8 mm) con perfilería de aluminio anodizado y tratamiento antical"
- demoliciones/escombro → "Demolición de revestimientos y tabiquería interior, picado de azulejos, retirada de carpintería, desescombro y transporte a vertedero homologado"
- albañilería/pladur/maestreado → "Albañilería general: construcción de tabiquería, trasdosados y falso techo de pladur, enmaestrado y regresado de paramentos"
- fontanería/multicapa → "Instalación integral de fontanería y saneamiento con red completa en tubería multicapa o polietileno reticulado"
- electricidad/REBT/RBT → "Instalación eléctrica según REBT: cuadro general de mando y protección, circuitos, mecanismos y tomas de corriente"
- alicatados/gresporcelánico → "Suministro y colocación de alicatados y solados en gres porcelánico de primera calidad con adhesivo C2TE y rejuntado"
- pintura → "Preparación de paramentos, emplastecido y aplicación de pintura plástica lisa de alta cubrición en techos y paredes"
- carpintería/puertas → "Revisión, ajuste y sustitución de carpintería interior: puertas de paso, marcos y manivelas"
- reforma integral → "Reforma integral de vivienda: demolición, distribución, instalaciones, acabados y carpintería"

FORMATO DE RESPUESTA (JSON estricto, sin texto adicional):
{
  "clientName": "Nombre del cliente o null",
  "clientAddress": "Dirección completa o null",
  "items": [
    {
      "description": "Descripción técnica formal",
      "qty": 1,
      "unit": "pa",
      "unitPrice": 0,
      "isPricePending": false
    }
  ],
  "discount": null,
  "taxRate": 10,
  "paymentTerms": { "advancePercentage": 30, "validityDays": 15 },
  "warnings": [],
  "isDraftMode": false,
  "assistantFeedback": "Mensaje breve en español para el instalador confirmando el presupuesto o pidiendo información"
}`;

export const GEMINI_UPDATE_PROMPT = `Eres un asistente de actualización de presupuestos de obra en España. Se te da el estado ACTUAL del presupuesto (JSON) y el nuevo mensaje del profesional.

Tu tarea: interpretar el mensaje y devolver el presupuesto COMPLETO actualizado en JSON.

ACCIONES POSIBLES:
- "Ponle X euros a [partida]" / "[Partida] cuesta X euros" → actualiza unitPrice de esa partida, isPricePending: false
- Nuevas partidas de obra → agrégalas al array items
- "Quita [partida]" → elimínala del array
- Corrección de dirección / nombre → actualiza clientAddress / clientName
- "Descuento del X%" o "rebaja de X euros" → establece discount
- Las partidas NO mencionadas en el mensaje deben permanecer EXACTAMENTE iguales

Aplica las mismas reglas: descripciones técnicas formales, precios máximos en rangos, ignorar muletillas.

Responde SOLO con JSON válido con el presupuesto completo actualizado en el mismo formato.`;

// ─────────────────────────────────────────────────────────────────────────────
// Core API call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Llama a la API de Gemini con un prompt y un system instruction.
 * @param {string} userPrompt
 * @param {string} systemInstruction
 * @param {string} apiKey  - Clave de API de Google (AI Studio)
 * @returns {Promise<object>} JSON parseado de la respuesta
 */
export async function callGeminiAPI(userPrompt, systemInstruction, apiKey) {
  if (!apiKey) throw new Error('API key de Gemini no configurada');

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 2048
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) throw new Error('Respuesta vacía de Gemini');
  return JSON.parse(jsonText);
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrae datos de presupuesto desde una transcripción de audio.
 * @param {string} rawTranscript - Texto crudo del audio
 * @param {string} apiKey
 * @returns {Promise<object>} Datos estructurados del presupuesto
 */
export async function parseTranscriptWithGemini(rawTranscript, apiKey) {
  return callGeminiAPI(rawTranscript, GEMINI_SYSTEM_PROMPT, apiKey);
}

/**
 * Actualiza un presupuesto existente con un nuevo mensaje conversacional.
 * @param {object} currentBudget - Presupuesto actual (schema de PresuVozEngine)
 * @param {string} userMessage   - Nuevo mensaje del instalador
 * @param {string} apiKey
 * @returns {Promise<object>} Presupuesto actualizado
 */
export async function updateBudgetWithGemini(currentBudget, userMessage, apiKey) {
  const currentState = {
    clientName: currentBudget.client?.name || null,
    clientAddress: currentBudget.client?.address || null,
    items: (currentBudget.items || []).map(i => ({
      id: i.id,
      description: i.description,
      qty: i.qty,
      unit: i.unit,
      unitPrice: i.unitPrice,
      isPricePending: i.isPricePending
    })),
    taxRate: currentBudget.financials?.taxRatePercentage || 10,
    discount: currentBudget.financials?.discountPercentage > 0
      ? { type: 'percentage', value: currentBudget.financials.discountPercentage }
      : null
  };

  const prompt = `PRESUPUESTO ACTUAL:\n${JSON.stringify(currentState, null, 2)}\n\nNUEVO MENSAJE DEL PROFESIONAL:\n${userMessage}`;
  const result = await callGeminiAPI(prompt, GEMINI_UPDATE_PROMPT, apiKey);

  // Preservar datos del cliente si Gemini no los actualiza
  if (!result.clientName) result.clientName = currentState.clientName;
  if (!result.clientAddress) result.clientAddress = currentState.clientAddress;

  return result;
}
