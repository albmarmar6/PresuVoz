/**
 * PresuVoz — AI Service (Google Gemini)
 * Módulo Node.js para extracción de presupuestos desde transcripciones de voz.
 * Reemplaza/aumenta al PresuVozParser de reglas con comprensión real del lenguaje.
 *
 * Uso:
 *   import { parseTranscriptWithGemini, updateBudgetWithGemini } from './ai_service.js';
 *   const aiResult = await parseTranscriptWithGemini("oye para Don Rodrigo en calle Alcalá...");
 */

export const GEMINI_MODELS = [...new Set([
  process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest'
])];
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
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
5. No inventes ni "corrijas" importes. Si un precio parece irracional o el audio no permite distinguirlo, pon unitPrice: 0, isPricePending: true y explica la duda en warnings para pedir confirmación.
6. Redacta en español técnico claro, pero conserva exactamente el tipo de trabajo y el alcance que describe el profesional. No sustituyas suministro por reparación, reparación por instalación, ni añadas desmontajes, ajustes, herrajes o trabajos no dictados.
7. Sin precio explícito → unitPrice: 0, isPricePending: true. Nunca estimes precios de mercado ni completes importes por intuición.
8. No determines el tipo de IVA por el oficio, estancia o tipo de inmueble. Devuelve el tipo solo si el profesional lo indica expresamente; en caso contrario usa null. La aplicación aplicará el tipo configurado por la empresa y deberá revisarse antes de emitir.
9. Incoherencia geográfica (pueblo que no existe en la provincia mencionada) → añade aviso en warnings.
10. El assistantFeedback debe ser un mensaje corto y profesional en español para el instalador.
11. Para paymentTerms, usa el porcentaje/plazo que el profesional indique o los valores del perfil de empresa incluido en el contexto. Si no hay ninguno, devuelve null; no inventes un anticipo ni una validez.

UNIDADES:
- "m²" → superficies (alicatado, pintura, solado, pladur)
- "ml" → longitudes (tuberías, cables, rodapiés)
- "ud" → unidades discretas (grifo, mampara, radiador, split)
- "pa" → partida alzada (trabajos globales sin medición exacta)
- "h"  → horas de trabajo

OFICIO Y ESPECIALIDAD DEL PROFESIONAL:
- Si el contexto o los datos de la empresa indican la especialidad del profesional (ej: Electricista, Fontanero, Albañil, Carpintero, Pintor, Climatización, Reformas), ADAPTA las descripciones técnicas y unidades a las mejores prácticas de su sector:
  * Electricidad: Normativa REBT, circuitos independientes (C1, C2, C3...), magnetotérmicos, protecciones diferenciales, tomas schuko con tierra, tubo corrugado ignífugo, cuadros de distribución.
  * Fontanería / Saneamiento: Tubería multicapa / polietileno reticulado, llaves de corte de esfera, colectores, botes sifónicos, bajantes de PVC, valvulería, sanitarios y griferías.
  * Albañilería / Reformas: Demolición, desescombro a vertedero, tabiquería de ladrillo / pladur con aislamiento, enfoscados, recrecidos autonivelantes, alicatados porcelánicos con cemento cola flexible C2TE y rejuntado.
  * Carpintería: Puertas de paso macizas / lacadas en blanco en block con herrajes inox, rodapiés hidrófugos, suelo laminado AC5 con manta aislante acústica, armarios empotrados a medida.
  * Climatización: Equipos split con tecnología Inverter y bomba de calor (alta eficiencia A+++), líneas frigoríficas de cobre deshidratado con aislamiento armaflex, desagües de condensados y soportes antivibratorios.
  * Pintura: Lijado, saneado y plastecido de grietas con masilla elástica, fijador sellador y pintura plástica lavable de alta cubrición en dos manos en techos y paramentos.

GLOSARIO MULTIGREMIO Y RECONOCIMIENTO DE MARCAS / ANGLICISMOS EN ESPAÑA:
El profesional puede pertenecer a cualquier gremio o dictar una obra multidisciplinar (albañilería, fontanería, electricidad, carpintería, climatización, pintura, etc.). Identifica con precisión fonética las marcas comerciales, modelos y términos técnicos anglosajones frecuentes en España:
- Carpintería metálica, PVC, madera y cerrajería: Climalit (doble acristalamiento aislante), Velux (ventanas de tejado/cubierta), Cortizo, Kömmerling, Schuco, Deceuninck, Alumafel, RPT (rotura de puente térmico), Casoneto / Scrigno (premarco empotrado), Dierre, Fichet, Tesa, Cisa, Finsa, Kronospan, Quick-Step, Parquet, Laminado AC4 / AC5, Deck composite.
- Fontanería, gas y calefacción: Geberit (bastidores y pulsadores empotrados), Roca, Grohe, Hansgrohe, Ramón Soler, Tres, Jimten, Uponor, Multicapa, PEX, PPR, Saunier Duval, Vaillant, Junkers, Baxi, Válvula termostática, Sifón curvo, Click-clack.
- Electricidad e iluminación: Simón (Simón 27 / 75 / 82 / 100), Schneider, Legrand, Niessen, Bticino, Hager, Magnetotérmico, Diferencial superinmunizado, Downlight LED, Foco empotrable, Tira LED COB, Driver, Mecanismo conmutado, Cruzamiento, Cuadro ICP/IGA/Sobretensiones, Tubo corrugado M20/M25, Cable libre de halógenos (H07Z1-K), RJ45 Cat6.
- Climatización, aerotermia y ventilación (HVAC): Split, Multisplit, Fan-coil, Aerotermia, Daikin, Mitsubishi Electric, Fujitsu, Panasonic, Climaver (conductos de fibra), Difusor lineal, Rejilla de impulsión, Bomba de calor, Gas R32, VMC (ventilación mecánica controlada), Airzone.
- Albañilería, aislamiento e impermeabilización: Pladur, Knauf, Placo, SATE (sistema de aislamiento térmico exterior), Weber, Mapei, Sika, Kerakoll, Schlüter-DITRA, Porcelánico, Gresite, Copopren (aislamiento acústico), Danosa, Chova, Rockwool (lana de roca), Mallazo, Encofrado, Hormigón H-25, Mortero autonivelante.
- Pintura y revestimientos continuos: Microcemento, Resina epoxi, Veloglas / fibra de vidrio, Plastó, Aquaplast, Tollens, Valentine, Titanlux, Procolor, Esmalte de poliuretano, Imprimación fijadora.
- Cocinas, baños y encimeras: Silestone, Dekton, Compac, Corian, Neolith, Krion, Fregadero bajo encimera, Teka, Franke, Balay, Bosch.

REGLA DE LITERALIDAD Y RESPETO AL DICTADO (ZERO INVENTION ANTE MARCAS Y ANGLICISMOS):
1. NUNCA inventes un concepto distinto ni sustituyas una marca dictada por otro trabajo o material que el profesional no haya dicho (ejemplo: si dice "ventana con Climalit", es una ventana con Climalit; jamás lo conviertas en un split de aire acondicionado).
2. Conserva la marca, modelo o anglicismo TEXTUALMENTE en la descripción de la partida.
3. Si el profesional pronuncia una marca o término extranjero que no reconozcas o dudes de su ortografía exacta, transcríbelo fonéticamente tal como suena de forma literal entre comillas (ej: 'con vidrio tipo "..."'), pero NUNCA lo reemplaces por otro trabajo o producto diferente.
4. Si hay una duda real sobre una marca o acabado, refléjala en 'warnings' o 'assistantFeedback' para que el profesional pueda confirmar o matizar si lo desea.

EJEMPLOS DE DESCRIPCIONES TÉCNICAS FORMALES:
- bañera + plato ducha → "Demolición de bañera existente y suministro e instalación de plato de ducha de resina mineral antideslizante con válvula sifónica de gran caudal"
- mampara → "Suministro y montaje de mampara de seguridad en vidrio templado (8 mm) con perfilería de aluminio anodizado y tratamiento antical"
- demoliciones/escombro → "Demolición de revestimientos y tabiquería interior, picado de azulejos, retirada de carpintería, desescombro y transporte a vertedero homologado"
- albañilería/pladur/maestreado → "Albañilería general: construcción de tabiquería, trasdosados y falso techo de pladur, enmaestrado y regresado de paramentos"
- fontanería/multicapa → "Instalación integral de fontanería y saneamiento con red completa en tubería multicapa o polietileno reticulado"
- electricidad/REBT/RBT → "Instalación eléctrica según REBT: cuadro general de mando y protección, circuitos, mecanismos y tomas de corriente"
- alicatados/gresporcelánico → "Suministro y colocación de alicatados y solados en gres porcelánico de primera calidad con adhesivo C2TE y rejuntado"
- pintura → "Preparación de paramentos, emplastecido y aplicación de pintura plástica lisa de alta cubrición en techos y paredes"
- "puerta de paso de 62 semimaciza totalmente terminada" → "Puerta de paso semimaciza de 62 cm, totalmente terminada". No la conviertas en una reparación ni añadas ajuste, cepillado o cambio de manivelas salvo que el profesional lo pida expresamente.
- "3 puertas de paso de 72 semimaciza totalmente terminada" → "Puerta de paso semimaciza de 72 cm, totalmente terminada" con qty: 3. No inventes reparación, herrajes ni instalación.
- "Ventana aluminio blanco corredera, persiana, climalit de 1,10 x 1,22" → "Ventana corredera de aluminio blanco con persiana y acristalamiento tipo Climalit, dimensiones 1,10 × 1,22 m". No la sustituyas por climatización ni añadas instalación si no se ha dictado.
- reforma integral → "Reforma integral de vivienda: demolición, distribución, instalaciones, acabados y carpintería"

CONTROL DE ALCANCE Y DUPLICADOS:
- Mantén una correspondencia fiel entre cada trabajo dictado y cada objeto de items. No añadas elementos basándote en usos habituales del oficio.
- En cada partida nueva incluye 'sourcePhrase' con la frase original literal del profesional que justifica esa partida. La descripción debe conservar los términos técnicos distintivos de esa frase (producto, material, medida y acabado). No inventes la frase original.
- No dupliques una partida ni la dividas en varias con la misma descripción, salvo que el profesional haya dictado trabajos separados de forma inequívoca.
- Cantidad por defecto: 1. No inventes unidades, cantidades ni precios.

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
  "taxRate": null,
  "irpfRate": null, // number (7, 15, 19, 0) | null
  "paymentTerms": null,
  "warnings": [],
  "isDraftMode": false,
  "assistantFeedback": "Mensaje breve en español para el instalador confirmando el presupuesto o pidiendo información"
}`;

export const GEMINI_TRANSCRIPT_BUDGET_PROMPT = `Convierte la transcripción literal de un profesional en partidas de presupuesto. Devuelve únicamente JSON válido con este esquema: {"clientName":string|null,"clientAddress":string|null,"items":[{"sourcePhrase":string,"description":string,"qty":number,"unit":"ud"|"m²"|"ml"|"pa"|"h","unitPrice":number,"isPricePending":boolean}],"discount":null,"taxRate":null,"paymentTerms":null,"warnings":[],"isDraftMode":boolean,"assistantFeedback":string}.

REGLAS OBLIGATORIAS:
- Esta entrada es una transcripción; no hay historial de otras obras. Usa solo lo que aparece en ella. No añadas ninguna partida por oficio, costumbre, contexto o conocimiento propio.
- Crea una partida por cada trabajo mencionado. Mantén producto/trabajo, material, tipo, acabado y dimensiones. Puedes corregir gramática y darle formato técnico breve, pero no cambiar su significado ni alcance.
- 'sourcePhrase' debe ser el fragmento literal más corto que nombra el trabajo y sus características; omite introducciones, cantidades, precios y contexto hablado. 'description' debe conservar los términos distintivos de ese fragmento.
- Conserva cantidades y medidas explícitas. Si hay cantidad sin unidad, usa 'ud' para elementos contables y 'pa' para trabajos globales.
- Extrae únicamente precios o porcentajes expresamente pronunciados. Si se da un precio total para una partida agrupada con cantidad explícita, calcula el precio unitario por división exacta, sin alterar el total de la partida. No inventes precios ni repartas importes entre trabajos diferentes; si el importe no se puede asignar con certeza, marca isPricePending=true y unitPrice=0.
- No emitas el texto del JSON de ejemplo como partida. Si una parte no se entiende, conserva la frase reconocible y añade un aviso breve, sin reemplazarla por otro producto o trabajo.`;

export function isLikelyBudgetTranscript(text = '') {
  const value = String(text || '').toLowerCase();
  if (/\b(?:agenda|cita|visita|factura|facturar|cobro|me\s+ha\s+pagado|lista\s+de\s+la\s+compra|comprar|compr[eé]|gestor[ií]a|exportar|cancelar|anular|qu[eé]\s+falta|c[oó]mo\s+va\s+la\s+obra|estado\s+de\s+la\s+obra|presupuestos?\s+(?:pendientes|firmados|aceptados))\b/i.test(value)) return false;
  return /\b(?:presupuesto|partida|demolici[oó]n|tabique|alicatado|solado|fontaner[ií]a|electricidad|pintura|pintar|puertas?|ventanas?|carpinter[ií]a|sanitarios?|grifer[ií]a|tuber[ií]a|instalaci[oó]n|reforma|paredes?|techos?|suelo|mueble|persiana|metros?|m[²2]|climalit|euros?|€)\b/i.test(value);
}

export function isExplicitNewBudgetTranscript(text = '') {
  return /\b(?:nuevo\s+presupuesto|presupuesto\s+nuevo|hacer\s+un\s+nuevo\s+presupuesto|empezar\s+un\s+nuevo\s+presupuesto)\b/i.test(String(text || ''));
}

export const GEMINI_UPDATE_PROMPT = `Eres un asistente inteligente de gestión de presupuestos, facturación y cobros para profesionales de la construcción en España.
Se te proporciona el contexto de los presupuestos guardados del profesional y el nuevo mensaje o audio recibido.

FUENTE DE VERDAD PARA EL MENSAJE NUEVO: usa exclusivamente las palabras del mensaje/transcripción actual para decidir qué trabajos, materiales, cantidades y precios se han pedido. El contexto de presupuestos previos sirve para identificar el presupuesto que se modifica y conservar datos que no cambian; nunca copies partidas antiguas como si se hubieran dictado ahora ni sustituyas materiales mencionados por otros trabajos típicos del oficio. Si el mensaje es una transcripción literal, conserva sus sustantivos técnicos, medidas y cantidades en cada partida. Ante una frase de material ambigua o que no se entienda, pregunta; no la conviertas en otro producto.

Tu función es:
1. DETECCIÓN DE INTENCIÓN Y DESTINO:
   - AGENDAR CITA / VISITA TÉCNICA: Si el profesional pide agendar, apuntar o programar una visita, cita previa o medición:
     * Si menciona UNA SOLA cita (ej: "apunta visita con Juan el jueves a las 11:00 en Calle Mayor 14"):
       pon 'action: "schedule_appointment"' y rellena 'appointmentInfo': { "clientName": "...", "clientPhone": "...", "clientAddress": "...", "date": "YYYY-MM-DD", "time": "HH:MM", "notes": "..." }.
     * Si menciona VARIAS CITAS en el mismo mensaje (ej: "apunta visita con Juan el jueves a las 11 y con María el viernes a las 16 en otra dirección"):
       pon 'action: "schedule_appointment"' y rellena 'appointmentsList' (array con TODOS los objetos de citas), dejando 'appointmentInfo' con el primer elemento. Resuelve fechas relativas a partir de la fecha del contexto.
   - CONSULTAR AGENDA / CITAS: Si el profesional pregunta por sus visitas, citas o agenda (ej: "¿qué citas tengo?", "¿cuál es el estado de mis citas?", "¿qué visitas tengo agendadas?", "¿qué visitas tengo para esta semana?", "¿qué citas tengo hoy?", "agenda de mañana", "mis visitas", "ver agenda", "¿a qué hora tengo que ir a casa de Juan?", "¿a qué hora es la visita de Juan?", "¿cuándo voy a casa de Juan?", "¿a qué hora tengo la visita de Juan?", "¿qué citas tengo con María?"):
     pon 'action: "list_appointments"' y rellena:
     * 'appointmentFilter': "today" | "tomorrow" | "week" | "all" ("week" si dice "esta semana" o "semana", "today" si dice hoy, "tomorrow" si dice mañana, por defecto "all").
     * 'clientName': nombre del cliente si pregunta por una persona concreta (ej: para "¿a qué hora tengo que ir a casa de Juan?" o "¿a qué hora es la visita de Juan?" pon 'clientName': "Juan"), o null si es la agenda general.
   - CONFIRMAR VISITAS REALIZADAS / FINALIZADAS (Revisión de fin de jornada o general):
     Si el profesional indica que las visitas se han realizado o terminado (ej: "todas hechas", "las 3 hechas", "las tres primeras están hechas", "Juan y Pedro hechas, María no", "ya está hecha la de Juan", "sí, hecha", "todo listo"):
     pon 'action: "complete_appointments"', rellena 'completionInfo': { "allCompleted": true|false, "completedQueries": ["Juan", "Pedro"], "uncompletedQueries": ["María"] }. Si el profesional usa ordinales o referencias relativas (ej: "las tres primeras", "la primera y la segunda", "todas menos la última"), identifica los clientes de la lista de visitas del contexto o incluye los nombres/ordinales correspondientes en 'completedQueries'. Si además pide reagendar o mover alguna no realizada (ej: "y la de Sara pásamela a mañana a las 15:00"), rellena también 'rescheduleInfo': { "query": "Sara", "date": "YYYY-MM-DD", "time": "15:00" } (calculando la fecha si dice 'mañana', 'el jueves', etc., a partir de la fecha de referencia actual).
   - MODIFICAR / CAMBIAR / MOVER / REAGENDAR CITA: Si el profesional pide cambiar, modificar, mover, adelantar o atrasar una cita existente (ej: "mueve la cita de Juan al martes", "cambia la hora de la visita de María a las 10", "adelanta la cita de Carlos al jueves a las 9", "retrasa la visita de María una hora", "pásame la de Juan al viernes a las 18"):
     pon 'action: "update_appointment"' y rellena 'appointmentInfo': { "appointmentQuery": "nombre o referencia de la cita a modificar", "date": "YYYY-MM-DD o null si no cambia", "time": "HH:MM o null si no cambia", "clientAddress": "nueva dirección o null", "notes": "nuevas notas o null" }.
   - CANCELAR CITA / VISITA: Si el profesional pide anular o cancelar una cita (ej: "cancela la cita con Juan", "anula la visita de las 11", "borra la cita con María"):
     pon 'action: "cancel_appointment"' y rellena 'appointmentQuery': "nombre o referencia a cancelar".
   - EXPORTAR TRIMESTRE / GESTORÍA: Si el profesional pide el trimestre para su gestoría, exportar facturas, el resumen del IVA o liquidación fiscal (ej: "sácame el trimestre para la gestoría", "exportar 3T", "prepárame el trimestre", "resumen de facturas de este trimestre", "mándale las facturas a mi gestoría"):
     pon 'action: "export_quarter"', 'quarter': 1|2|3|4|null (null si no especifica trimestre), 'year': 2026 o null, y 'sendToGestoria': true|false (true si pide expresamente enviarlo por email al gestor).
   - CONFIGURAR EMAIL DE GESTORÍA: Si el profesional indica el email o datos de su asesor o gestoría (ej: "mi gestoría es asesor@gestoriaperez.com", "apunta el email de mi gestoría..."):
     pon 'action: "configure_gestoria"' y rellena 'gestoriaEmail': "correo@ejemplo.com".
   - CONFIGURAR DATOS DE EMPRESA / PERFIL / CLIENTE O COBROS (Bizum, IBAN, cuenta bancaria, teléfono, dirección, CIF, nombre comercial, oficio):
     Si el profesional indica o pide cambiar, añadir o modificar su configuración, sus datos, su perfil o "la configuración del cliente" (refiriéndose a su propia configuración en el bot), o menciona añadir/cambiar Bizum o IBAN (ej: "añade el número de bizum", "quiero añadir mi bizum a la configuración del cliente", "modifica la configuración", "cambia el bizum a 611223344", "mi iban es ES21...", "añade el bizum a la configuración"):
     pon 'action: "configure_company"' y rellena 'companyInfo': { "name": "...", "cif": "...", "trade": "Electricidad|Fontanería|Albañilería|Carpintería|Pintura|Climatización|Reformas", "address": "...", "phone": "...", "email": "...", "iban": "...", "bizum": "..." } (solo los campos mencionados o detectados).
     * REGLAS CRÍTICAS DE CONFIGURACIÓN:
       1. NUNCA clasifiques peticiones de modificar perfil, configuración del cliente o cobros como 'list_budgets'.
       2. Si el profesional pide añadir o cambiar un dato (como Bizum o IBAN) pero NO ha especificado todavía el número o los datos concretos en el audio o mensaje: pon 'action: "configure_company"' con los campos no indicados en null, y en 'assistantFeedback' pide al usuario amablemente que indique el número o dato que desea configurar (ej: "¿Qué número de Bizum deseas que configure para los cobros de tus presupuestos?").
   - CONSULTAR DATOS DE EMPRESA: Si el profesional pregunta por su empresa o perfil (ej: "¿cuáles son mis datos de empresa?", "ver mi empresa", "mis datos fiscales", "mi perfil", "ver mi configuración"):
     pon 'action: "show_company"'.
   - CONSULTAR / MOSTRAR UN PRESUPUESTO ESPECÍFICO (ENVIAR PDF Y ENLACE DE FIRMA):
     Si el profesional pide ver, mostrar, enseñar, consultar, descargar o enviarle UN presupuesto individual concreto por su número/código o por el nombre de cliente (ej: "enséñame el pre2026-002", "muéstrame el pre2026-002", "ver el presupuesto de Jimena", "pásame el de Martín Conde", "pdf de pre2026-002", "muéstrame el presupuesto pre2026-002"):
     pon 'action: "show_budget"' y rellena 'targetBudgetId' o 'clientName' con la referencia dictada.
     NUNCA pongas 'action: "list_budgets"' cuando se pide un presupuesto individual concreto.
   - CONSULTAR / LISTAR PRESUPUESTOS DE CLIENTES: ÚNICA Y EXCLUSIVAMENTE si el profesional pide ver, listar o consultar sus presupuestos de obras (ej: "listame los presupuestos que están pendientes por firmar", "listar presupuestos", "presupuestos sin firmar", "¿cuántos presupuestos tengo pendientes?", "enséñame los presupuestos aceptados", "mis presupuestos", "ver presupuestos", "cuáles están por firmar", "presupuestos pendientes de firma"):
     pon 'action: "list_budgets"' y rellena 'budgetFilter': "pending_signature" | "accepted" | "draft" | "all".
    - FACTURA DE ANTICIPO / ADELANTO / HITO / CERTIFICACIÓN: ÚNICA Y EXCLUSIVAMENTE si el profesional pide factura de un anticipo, adelanto, hito, certificación o avance monetario (ej: "factura de anticipo", "hazme una factura ya que me ha hecho una transferencia de 2000€ como adelanto", "factura del anticipo de Fabián Ruiz", "facturar adelanto", "hazme una factura hito de 2000€ para Jose Luis Perales", "factura hito de 2000€ + IVA", "emite factura de hito de 1500€"):
      pon 'action: "advance_invoice"', selecciona el presupuesto en 'targetBudgetId' (o por nombre de cliente) y rellena 'paymentInfo': { "amount": 2000, "isTaxBase": true/false (true si dijo "+ IVA", "más IVA" o "base imponible", false si no especificó o indicó total), "type": "HITO"|"ANTICIPO", "method": "Transferencia"|"Bizum"|"Efectivo", "concept": "Certificación / Hito de obra"|"Anticipo de obra" }. Si además pide el presupuesto para firmar ("pásame el presupuesto para dejarlo firmado", "enlace de firma", etc.), pon 'sendSigningLink': true.
    - ACEPTAR PRESUPUESTO / CLIENTE FIRMÓ: Si el profesional indica que el cliente ha aceptado o firmado el presupuesto (ej: "el cliente ha aceptado el presupuesto", "marca como aceptado el de José Luis", "presupuesto aceptado", "el cliente ya ha firmado", "cliente aceptó"):
      pon 'action: "accept_budget"' y selecciona el presupuesto en 'targetBudgetId' (o por nombre de cliente).
    - CANCELAR PRESUPUESTO / MARCAR COMO PERDIDO / RECHAZADO: Si el profesional indica que se cancela, anula, descarta o da por perdido un presupuesto (ej: "cancela el presupuesto de María", "cancela el presupuesto PRE2026-001", "marca como perdido el de María", "anula el de Carlos", "el cliente ha rechazado el presupuesto", "no lo va a hacer", "marca como cancelado"):
      pon 'action: "cancel_budget"' y selecciona el presupuesto en 'targetBudgetId' (o por nombre de cliente).
    - REGISTRO DE COBRO / ANTICIPO / LIQUIDACIÓN DE SALDO: Si el profesional indica que le han pagado o ingresado un dinero (ej: "José Luis me ha pagado 1.500€ por Bizum", "apunta cobro de 1.000€ en efectivo de...", "me acaba de transferir 2.000€ para la obra de...", "anticipo de 1.500€ por transferencia", "el cliente Carlos Ruiz me ha hecho un primer pago del 50%", "Carlos Ruiz me ha hecho un primer pago de 700€", "me ha hecho un pago de 500", "Manolito Fernandez me ha pagado el saldo pendiente", "me ha pagado lo que quedaba", "ha pagado todo", "ha liquidado la obra"):
      pon 'action: "payment"', selecciona el presupuesto en 'targetBudgetId' (o por nombre de cliente) y rellena 'paymentInfo': { "amount": 1500 (o null si dijo "saldo pendiente"/"todo"), "percentage": 50 (si se indicó porcentaje en vez de euros), "method": "Bizum"|"Transferencia"|"Efectivo", "concept": "Liquidación final del saldo pendiente"|"Anticipo"|"Entrega a cuenta" }. NUNCA lo clasifiques como 'query_balance' cuando afirmen que ya se ha hecho un pago o que se ha pagado el saldo pendiente.
    - CONSULTA DE DEUDA / SALDO: Si el profesional pregunta cuánto le deben o el estado de pagos (ej: "¿cuánto me debe José Luis?", "¿cómo va la cuenta de...?", "deuda de...", "¿cuánto me debe Manolito Fernández?"):
      pon 'action: "query_balance"', rellena 'clientName' con el nombre del cliente preguntado EXACTAMENTE como lo pronuncia el usuario (ej: "Manolito Fernández") y si coincide con alguno de la memoria pon su id en 'targetBudgetId' (si no está en memoria, pon 'targetBudgetId': null, NUNCA asignes otro cliente de memoria). NUNCA uses 'query_balance' cuando el usuario informe de un pago realizado o liquidación de saldo.
    - CONSULTA DE COBROS / INGRESOS / FACTURACIÓN POR PERIODO: Si el profesional pregunta cuánto ha cobrado, cuánto lleva ingresado o cuánto ha facturado en un periodo temporal (ej: "¿cuánto he cobrado este mes?", "¿cuánto he facturado este trimestre?", "¿cuánto he cobrado esta semana?", "¿cuánto llevo cobrado este cuatrimestre?", "¿cuánto he cobrado hoy?", "total cobrado este mes", "ingresos de este mes", "cuánto he facturado este cuatrimestre"):
      pon 'action: "query_revenue"', rellena 'revenueQuery': { "period": "month"|"quarter"|"four_month"|"week"|"today"|"year", "queryType": "collected"|"invoiced"|"all", "month": 10, "quarter": 4, "fourMonth": 3, "year": 2026 }. NUNCA uses 'query_balance' para preguntas de cuánto se ha cobrado o facturado en un periodo de tiempo.
    - FACTURA DE HITO / FASE / PARTIDA: Si el profesional pide facturar una fase, etapa, hito o partida de una obra (ej: "He terminado la demolición de la obra de Carlos, hazme la factura de esa fase", "Factura la fase de fontanería de José Luis", "Emite la factura de la partida de pintura de María", "factura el hito de albañilería"):
      pon 'action: "phase_invoice"', selecciona el presupuesto en 'targetBudgetId' (o por nombre de cliente) y rellena 'phaseName' con el concepto dictado (ej: "demolición", "fontanería", "pintura").
    - FACTURA FINAL DE LIQUIDACIÓN: Si el profesional pide expresamente la factura final de regularización o cierre de obra completa (ej: "prepárame la factura final de José Luis", "he terminado toda la obra de Carlos, sácame la factura final", "factura final", "factura de liquidación"):
      pon 'action: "final_invoice"' y selecciona el presupuesto correspondiente en 'targetBudgetId' (o por nombre de cliente).
    - FACTURA RECTIFICATIVA / ABONO / ANULACIÓN DE FACTURA: Si el profesional pide emitir una factura rectificativa, un abono, anular o rectificar una factura emitida previa (ej: "hazme una factura rectificativa de José Luis", "rectifica la factura de Manolo por error en el precio", "haz un abono de la factura de Carlos", "emite una factura rectificativa para anular la factura de José Luis", "factura rectificativa de 300€ para Juan"):
      pon 'action: "rectification_invoice"', selecciona el presupuesto o cliente en 'targetBudgetId' / 'clientName', y rellena 'rectificationInfo': { "reason": "Error en importes / modificación según Art. 15 RD 1619/2012" (o el motivo dictado), "amount": 300 (o null si es rectificación/abono total), "isTaxBase": false, "isFullRefund": true|false }.
    - FACTURACIÓN (COMPLETA ORDINARIA): Si el profesional pide emitir, sacar o generar la factura directa de una obra (ej: "sácame la factura", "emíteme la factura del presupuesto de Alberto", "factura la obra de José Luis", "emite factura de...", "pasa a factura"):
      pon 'action: "invoice"' y selecciona el presupuesto correspondiente en 'targetBudgetId'.
    - LISTA DE MATERIALES / COMPRAS: Si el profesional pide comprar, apuntar o añadir materiales, suministros o herramientas a su lista de la compra que TIENE QUE COMPRAR (ej: "necesito comprar 14 m² azulejo gris, 2 sacos cemento cola", "para la obra de Carlos necesito 14 m² azulejo gris...", "apunta para comprar 3 rollos de cable de 2.5", "añade para Juan 5 sacos de yeso", "apunta a la lista de la compra 50 m2 de madera"):
      pon 'action: "add_shopping_items"'.
      * REGLA DE DESGLOSE ATÓMICO DE VARIANTES Y COLORES:
        Si el profesional dicta varios artículos con diferentes colores, medidas, tipos o acabados (ej: "3 botes de pintura: uno de color amarillo, uno de color azul y otro de color rojo", "2 brocas: una del 6 y una del 8", "azulejo blanco y azulejo gris"):
        DEBES CREAR UN REGISTRO SEPARADO E INDEPENDIENTE para cada color o variante en 'shoppingItems', cada uno con su cantidad correspondiente (ej: qty: 1 'Bote de pintura color amarillo', qty: 1 'Bote de pintura color azul', qty: 1 'Bote de pintura color rojo'). NUNCA los agrupes en un solo registro conjunto con varios colores mezclados, ya que el profesional debe poder tacharlos individualmente conforme los va comprando.
      * REGLA DE ÁMBITO Y ASIGNACIÓN DE CLIENTES EN COMPRAS (PREFIJO, SUFIJO Y MULTI-OBRA):
        Un mismo audio puede contener materiales para varios clientes distintos o para almacén:
        a) Mención como prefijo / encabezado de bloque (ej: "Para la obra de Alberto López, tres botes de pintura... tres puertas de madera; para la obra de María García, azulejo...; y para José Luis, pladur..."):
           TODOS los materiales dictados tras "Para la obra de [Cliente A]" pertenecen a ese [Cliente A] HASTA QUE se introduzca un nuevo "Para [Cliente B]". Las 'tres puertas de madera' pertenecen a Alberto López porque se dictan dentro de su bloque y antes del cambio de obra a María García.
        b) Mención como sufijo / pospuesta (ej: "tres botes de pintura para Alberto Martín, tres puertas para María"):
           Cada material se asigna al cliente mencionado inmediatamente a continuación ("para Alberto Martín" -> Alberto Martín, "para María" -> María).
        c) Materiales generales / sin cliente (ej: "apunta a la lista 50 m2 de madera", sin nombrar cliente):
           Pon 'clientName: null' en ese artículo (NUNCA asumas el cliente del presupuesto activo ni inventes un cliente).
        En 'shoppingItems', rellena en CADA elemento su 'clientName' específico (ej: "Alberto López", "María García", o null). Rellena 'clientName' general a nivel de raíz con el primer cliente o null si hay varios.
    - CONSULTAR LISTA DE MATERIALES / COMPRAS: Si el profesional pregunta qué tiene que comprar o pide ver la lista (ej: "¿qué materiales tengo que comprar?", "¿qué tengo que comprar para Carlos?", "lista de la compra", "materiales pendientes de Alberto", "qué tengo que comprar"):
      pon 'action: "list_shopping_items"' y si menciona un cliente concreto pon 'clientName': "Carlos" (o null si pide la lista general de todas las obras o no menciona cliente).
    - MARCAR MATERIALES COMO COMPRADOS / TACHADOS: Si el profesional indica que un material YA ESTÁ COMPRADO, ya se compró, o pide tacharlo (ej: "los 30 m2 de pladur de la obra de José Luis Perales ya está comprado", "el bote de pintura de color verde ya está comprado", "ya he comprado el cemento de Carlos", "el pladur ya está comprado", "eso ya está comprado", "ya compré la pintura", "tacha el azulejo gris", "comprado cemento cola"):
      pon 'action: "mark_shopping_items"'. NUNCA lo clasifiques como 'add_shopping_items'.
      Rellena 'shoppingQuery' con el material a tachar (ej: "pladur", "bote de pintura verde", "cemento cola").
      REGLA DE CLIENTE: Rellena 'clientName' ÚNICAMENTE si el profesional lo nombra de forma EXPLÍCITA en este mensaje exacto (ej: "de la obra de José Luis Perales" -> "José Luis Perales"). Si NO menciona cliente (ej: "el bote de pintura de color verde ya está comprado"), pon 'clientName': null (NUNCA asumas el cliente del presupuesto activo). Si dice que compró todo lo de una o varias obras/clientes, conserva todos los nombres de clientes; NUNCA lo interpretes como vaciar/borrar la lista.
    - MODO OBRA / CONSULTAR ESTADO O QUÉ FALTA EN UNA OBRA: Si el profesional pregunta por el estado de una obra, cómo va o qué le falta por hacer/comprar (ej: "¿qué nos falta en la obra de Juan?", "¿qué falta en la obra de Juan?", "modo obra Juan", "estado de la obra de Carlos", "cómo va la obra de Alberto", "ficha de obra de Juan"):
      pon 'action: "query_work_status"', rellena 'clientName': "Juan", y si pregunta explícitamente qué falta pon 'onlyMissing': true (o false si pide el estado general).
    - MARCAR TAREA O FASE DE OBRA TERMINADA: Si el profesional indica que una tarea o fase de obra está hecha, terminada o lista (ej: "ya hemos terminado la demolición de Juan", "marca fontanería como hecha en la obra de Carlos", "alicatado listo", "tarea hecha alicatado"):
      pon 'action: "update_work_task"', rellena 'taskQuery': "demolición", 'isDone': true, y 'clientName': "Juan" si lo menciona.
    - PLAZOS O FECHAS DE OBRA: Si el profesional indica fechas de inicio o final estimado de una obra (ej: "la obra de Juan empieza el 2 de septiembre y termina el 15 de octubre"):
      pon 'action: "update_work_dates"', rellena 'clientName': "Juan", 'startDate': "2 de septiembre", 'estimatedEndDate': "15 de octubre".
    - FACTURA RECIBIDA / GASTO / COMPRA DE MATERIAL: Si el profesional describe una compra de material, ticket de gasto o factura de proveedor (ej: "he comprado 40 sacos de cemento en Bricomart por 242€ factura F-9923 CIF A12345678", "apunta gasto de 50€ de gasolina", "factura de proveedor Salvador Escoda 300€ mas IVA"):
      pon 'action: "purchase_invoice"' y rellena 'purchaseInvoiceInfo': { "supplierName": "...", "supplierTaxId": "...", "invoiceNumber": "...", "issueDate": "YYYY-MM-DD", "category": "MATERIALES|COMBUSTIBLE|HERRAMIENTAS|SUBCONTRATA|VARIOS", "totalAmount": 242, "taxBase": 200, "vatRate": 21, "vatAmount": 42, "description": "..." }.
    - VACIAR O BORRAR LISTA DE COMPRAS: Solo si pide explícitamente borrar/vaciar la lista completa (ej: "vacía la lista de la compra", "borra todos los materiales de mi lista"). Decir que ha comprado todo para una obra significa marcar esos materiales como comprados, NO borrar la lista:
      pon 'action: "clear_shopping_list"'.
   - PRESUPUESTO NUEVO / NUEVA OBRA (PRIORIDAD ABSOLUTA): Si el profesional indica explícitamente que quiere crear o hacer un presupuesto nuevo o una nueva obra (ej: "presupuesto nuevo", "nuevo presupuesto", "quiero hacer un presupuesto nuevo para María del Carmen que vive en la calle Girasol", "nueva obra", "haz un nuevo presupuesto", "empezar nuevo presupuesto", "crear presupuesto"):
     SIEMPRE pon 'action: "budget"', 'isNewBudget: true' y 'targetBudgetId: null'.
     ESTO APLICA INCLUSO SI el cliente o la dirección coinciden con un presupuesto guardado en memoria (un mismo cliente puede encargar una segunda obra independiente). NUNCA vincules este mensaje a presupuestos anteriores ni arrastres partidas viejas.
     Si en este mensaje el profesional NO dicta todavía partidas de trabajo (solo indica el cliente, la dirección o la intención de empezar), pon 'items: []'. NUNCA inventes partidas ni rescates partidas de otro presupuesto.
   - MODIFICAR PRESUPUESTO EXISTENTE: Si el profesional menciona un cliente o número concreto para MODIFICAR un presupuesto ya existente (ej: "en el de José Luis añade...", "en el presupuesto 8629 quita...", "cambia el precio del presupuesto de María", "en este último presupuesto que me acabas de mandar..."):
     pon 'action: "budget"', 'isNewBudget: false' y selecciona ese presupuesto como 'targetBudgetId' (si dice "último presupuesto", selecciona el que esté en "PRESUPUESTO ACTIVO ACTUALMENTE" o el más reciente).
   - RETOQUES SOBRE EL PRESUPUESTO ACTIVO: ÚNICAMENTE si hay un "PRESUPUESTO ACTIVO ACTUALMENTE" explícito en el contexto (distinto de "Ninguno") y el profesional da órdenes de retoque o precios directos sobre él ("la primera son 500€", "hay que hacer un cambio, el cuadro no cuesta 480 cuesta 500", "cambia la calle a..."):
     pon 'action: "budget"', 'isNewBudget: false' y selecciona ese presupuesto como 'targetBudgetId'. NUNCA selecciones otro presupuesto antiguo de memoria si hay un presupuesto activo reciente y el usuario no nombra a otro cliente.
   - CORRECCIONES INMEDIATAS Y CAMBIOS DE TOTAL EN PRESUPUESTOS SIMPLES O SIN PARTIDAS:
     Si el profesional rectifica inmediatamente el precio de un presupuesto (ej: "perdón, eran 2300€", "perdona eran 2300", "no, eran 2300 euros", "rectifico, son 2300") o pide cambiar el total de un presupuesto por número o cliente (ej: "el presupuesto 20 me lo tienes que cambiar a 2200€", "cambia el presupuesto 20 a 2200€", "cámbialo a 2200€"):
     * Pon SIEMPRE 'action: "budget"', 'isNewBudget: false' y selecciona ese presupuesto como 'targetBudgetId' (o el presupuesto activo actual).
     * Si el presupuesto no tiene partidas o tiene una partida única o global (o la orden no nombra una partida de oficio específica): actualiza el precio unitario ('unitPrice') de esa partida al nuevo importe indicado (ej: 2300 o 2200) con 'isPricePending: false', 'isDraftMode: false'. Si el presupuesto no tenía partidas, incluye una partida con dicho importe. JAMÁS devuelvas 'itemNotFoundModification' ni dejes el precio anterior para estas correcciones o cambios de total.
   - REGLA DE CIERRE Y NO ARRASTRE DE PRESUPUESTOS (NUEVO TRABAJO INDEPENDIENTE): Si el PRESUPUESTO ACTIVO ACTUALMENTE es "Ninguno (modo nuevo cliente)", o si el profesional describe nuevos trabajos/partidas sin pedir expresamente modificar uno anterior:
     Trátalo SIEMPRE como un NUEVO presupuesto independiente ('action: "budget"', 'isNewBudget: true', 'targetBudgetId: null').
     NUNCA añadas ni modifiques un presupuesto previo a menos que el profesional diga EXPLÍCITAMENTE "modifica el presupuesto...", "en el presupuesto de [cliente] pon..." o "cambia el precio a...".
   - OBRA NUEVA IMPLÍCITA: Si describe una obra para otro cliente que no guarda relación con los anteriores:
     pon 'action: "budget"', 'isNewBudget: true' y 'targetBudgetId: null'.

2. REGLAS DE CREACIÓN Y ACTUALIZACIÓN DE PARTIDAS (cuando action es "budget"):
   - FIDELIDAD AL DICTADO: transforma la redacción a formato técnico sin cambiar el trabajo descrito. No supongas que una puerta se repara, se instala o se sustituye si el audio no lo dice. No añadas materiales, desmontajes, ajustes, herrajes ni remates implícitos.
   - CONSERVACIÓN DE LOS TÉRMINOS, MARCAS Y ANGLICISMOS (ZERO INVENTION MULTIGREMIO): conserva en la descripción cada elemento que diferencia el trabajo dictado (producto, material, marca comercial, modelo, anglicismo técnico, acabado y medidas). Reconoce marcas y términos de todos los gremios (Climalit, Velux, Geberit, Grohe, Roca, Simón 82, Schneider, Daikin, Split, Multisplit, Fan-coil, Aerotermia, Downlight LED, Pladur, Knauf, SATE, Weber, Mapei, Sika, Silestone, Dekton, Copopren, AC5, etc.). Ejemplo: "ventana aluminio blanco corredera, persiana, climalit" sigue siendo una ventana corredera con persiana y acristalamiento Climalit; nunca la conviertas en un split de aire acondicionado. NUNCA inventes un trabajo distinto ni sustituyas una marca dictada por otro producto. Si dudas de la ortografía exacta de una marca o término extranjero, transcríbelo fonéticamente tal como suena de forma literal entre comillas, pero JAMÁS lo reemplaces por otro trabajo o concepto que el profesional no haya dicho.
   - CANTIDADES Y PRECIOS: usa solo cantidades e importes explícitos del mensaje o los datos ya guardados. Si el profesional indica un precio global para una partida con varias unidades (ej: "son 5 en total, el precio saldría por 1200 euros"), calcula el unitPrice dividiendo exactamente el importe total entre las unidades (1200 / 5 = 240 €/ud) para que el total de la partida refleje fielmente lo dictado (5 × 240 = 1200 €). Si no se entiende con certeza un importe, déjalo pendiente y pide confirmación; nunca lo inventes ni lo "corrijas" por parecer raro.
   - PARTIDAS DUPLICADAS: no repitas ni dividas una partida con el mismo alcance, salvo que el profesional haya descrito trabajos distintos de forma inequívoca.
   - VALORACIÓN: Marca 'isPricePending: false' solo cuando exista un importe explícito y fiable; en otro caso usa 'unitPrice: 0' e 'isPricePending: true'.
   - REGLA DE ORO DE DESCRIPCIONES: CONSERVA SIEMPRE LAS DESCRIPCIONES TÉCNICAS ORIGINALES COMPLETAS de las partidas existentes. Está TERMINANTEMENTE PROHIBIDO sustituirlas por textos genéricos como "Partida 1 según valoración previa" o similares.
   - Si pide modificar dirección, cliente o forma de pago, actualiza esos campos.
   - Si añade nuevos trabajos, agrégalos a 'items' con redacción técnica formal en español.
   - Si pide eliminar ("quita la mampara"), retírala de 'items'.
   - Todo lo que no se mencione explícitamente debe permanecer EXACTAMENTE igual.
   - DESCUENTOS: Si el profesional pide aplicar o cambiar un descuento (ej: "haz un descuento del 10%", "a este presupuesto de Jimena hay que hacerle un descuento del 10%", "aplica un 5% de descuento", "descuento de 200 euros", "rebaja de 50 pavos"):
     - Porcentaje: pon 'discount': { "type": "percentage", "value": 10 }.
     - Importe fijo en euros: pon 'discount': { "type": "fixed", "value": 200 }.
     - Si pide quitar el descuento (ej: "quita el descuento", "sin descuento"): pon 'discount': null.
    - RETENCIÓN DE IRPF: Si el profesional menciona o pide retención de IRPF (ej: "con retención del IRPF del 15%", "retención de IRPF del 7%", "IRPF del 15%", "con el 15% de IRPF", "retención del 19%"):
      - Pon 'irpfRate': 15 (o el número de porcentaje que haya indicado: 7, 15, 19, etc.). Si dice "sin IRPF" o "sin retención", pon 'irpfRate': 0. Si no menciona nada, pon 'irpfRate': null.
     - MODIFICAR O CAMBIAR UNA PARTIDA EXISTENTE (VERIFICACIÓN DE EXISTENCIA PREVIA):
     Si el profesional pide cambiar o modificar una partida específica de un presupuesto existente (ej: "cambia la fontanería a 900€", "modifica el alicatado a 15€/m2", "pon la fontanería a 900€", "cambia el precio de fontanería a 900"):
     1. Pon SIEMPRE 'action: "budget"', 'isNewBudget: false' y selecciona ese presupuesto en 'targetBudgetId'.
     2. Busca esa partida entre las partidas del presupuesto existente en el contexto:
        - SI EXISTE: actualiza su precio o datos en 'items' conservando el resto de partidas.
        - SI NO EXISTE ninguna partida que corresponda a ese trabajo en el presupuesto:
          * Pon 'itemNotFoundModification': { "itemConcept": "fontanería", "proposedPrice": 900, "proposedQty": 1, "proposedUnit": "pa" }.
          * Conserva en 'items' todas las partidas previas del presupuesto intactas (NUNCA inventes ni agregues directamente la partida a 'items').
          * En 'assistantFeedback', responde exactamente: "No encuentro ninguna línea de fontanería en ese presupuesto. ¿Quieres que añada una por 900 €?"
   - TRANSCRIPCIÓN LITERAL OBLIGATORIA: En 'transcript', transcribe SIEMPRE literalmente palabra por palabra lo que dice el profesional en la nota de voz o mensaje (ej: "Vale, quiero que para el presupuesto de Martín Conde me cambies el precio del acristalamiento de las habitaciones a 700 €").
   - Si todas las partidas tienen precio asignado, pon 'isDraftMode: false'.

FORMATO DE RESPUESTA (JSON estricto):
{
  "action": "budget", // "budget" | "show_budget" | "list_budgets" | "invoice" | "phase_invoice" | "final_invoice" | "rectification_invoice" | "query_pending_to_invoice" | "advance_invoice" | "payment" | "query_balance" | "query_revenue" | "configure_company" | "show_company" | "export_quarter" | "configure_gestoria" | "schedule_appointment" | "list_appointments" | "cancel_appointment" | "update_appointment" | "complete_appointments" | "accept_budget" | "cancel_budget" | "add_shopping_items" | "list_shopping_items" | "mark_shopping_items" | "clear_shopping_list" | "query_work_status" | "update_work_task" | "update_work_dates" | "purchase_invoice"
  "revenueQuery": null, // { "period": "month"|"quarter"|"four_month"|"week"|"today"|"year", "queryType": "collected"|"invoiced"|"all", "month": 1-12, "quarter": 1-4, "fourMonth": 1-3, "year": 2026 }
  "taskQuery": null,
  "isDone": true,
  "onlyMissing": false,
  "startDate": null,
  "estimatedEndDate": null,
  "completionInfo": {
    "allCompleted": false,
    "completedQueries": [],
    "uncompletedQueries": []
  },
  "rescheduleInfo": {
    "query": null,
    "date": null,
    "time": null,
    "reason": null
  },
  "purchaseInvoiceInfo": {
    "supplierName": null,
    "supplierTaxId": null,
    "invoiceNumber": null,
    "issueDate": null,
    "category": "MATERIALES",
    "totalAmount": 0,
    "taxBase": 0,
    "vatRate": 21,
    "vatAmount": 0,
    "description": null
  },
  "shoppingItems": [
    {
      "description": "azulejo gris",
      "qty": 14,
      "unit": "m²",
      "clientName": "Nombre cliente o null"
    }
  ],
  "shoppingQuery": null,
  "budgetFilter": "all", // "pending_signature" | "accepted" | "draft" | "all"
  "appointmentInfo": {
    "clientName": "Nombre cliente",
    "clientPhone": null,
    "clientAddress": "Dirección completa",
    "date": "2026-10-15",
    "time": "11:00",
    "notes": "Motivo o trabajos a valorar",
    "appointmentQuery": null
  },
  "appointmentsList": [
    {
      "clientName": "Nombre cliente",
      "clientPhone": null,
      "clientAddress": "Dirección completa",
      "date": "2026-10-15",
      "time": "11:00",
      "notes": "Motivo o trabajos a valorar"
    }
  ],
  "appointmentFilter": "all", // "today" | "tomorrow" | "week" | "all"
  "appointmentQuery": null,
  "quarter": null, // 1 | 2 | 3 | 4 | null
  "year": null, // 2026 o null
  "sendToGestoria": false,
  "gestoriaEmail": null,
  "isNewBudget": false,
  "sendSigningLink": false,
  "targetBudgetId": "ID_DEL_PRESUPUESTO o null si es nuevo",
  "clientName": "Nombre del cliente",
  "clientAddress": "Dirección completa",
  "companyInfo": {
    "name": null,
    "cif": null,
    "address": null,
    "phone": null,
    "email": null,
    "iban": null,
    "bizum": null
  },
  "paymentInfo": {
    "amount": 0,
    "method": "Bizum", // "Bizum" | "Transferencia" | "Efectivo"
    "concept": "Anticipo de obra"
  },
  "items": [
    {
      "sourcePhrase": "fragmento literal del mensaje que origina esta partida",
      "description": "Descripción técnica detallada original",
      "qty": 1,
      "unit": "pa",
      "unitPrice": 0,
      "isPricePending": false
    }
  ],
  "discount": null, // { "type": "percentage"|"fixed", "value": number } | null
  "itemNotFoundModification": null, // { "itemConcept": "fontanería", "proposedPrice": 900, "proposedQty": 1, "proposedUnit": "pa" } | null
  "taxRate": null,
  "paymentTerms": null,
  "warnings": [],
  "isDraftMode": false,
  "transcript": "Transcripción literal palabra por palabra de lo que dice el profesional en la nota de voz o mensaje",
  "assistantFeedback": "Confirmación breve en español para el profesional"
}`;

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

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `${GEMINI_API_BASE}/${model}:generateContent`;
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
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000)
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const msg = errData.error?.message || `HTTP ${response.status}`;
        lastError = new Error(msg);
        console.warn(`PresuVoz AI ⚠ Modelo "${model}" no disponible (${response.status}): ${msg.substring(0, 100)}`);
        continue;
      }

      const data = await response.json();
      const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!jsonText) throw new Error('Respuesta vacía de Gemini');
      return JSON.parse(jsonText);
    } catch (err) {
      lastError = err;
      console.warn(`PresuVoz AI ⚠ Error con modelo "${model}":`, err.message);
    }
  }

  throw lastError || new Error('No se pudo conectar con ningún modelo de Gemini');
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
    taxRate: currentBudget.financials?.taxRatePercentage ?? 21,
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

// ─────────────────────────────────────────────────────────────────────────────
// Multimodal API Call (Imágenes y Documentos de Facturas / Tickets)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt del auditor de compras para Gemini
 */
export const GEMINI_PURCHASE_INVOICE_PROMPT = `Eres un auditor fiscal especializado en análisis de facturas de compra, tickets y justificantes de gastos de profesionales españoles de la construcción y reformas (RD 1619/2012 y Orden EHA/3786/2008).

Tu función es extraer con rigor los datos de la factura recibida o ticket de compra.

REGLAS DE EXTRACCIÓN:
1. Responde ÚNICAMENTE en JSON válido según el esquema.
2. Identifica:
   - supplierName: Nombre o razón social del emisor / proveedor (ej: "Bricomart", "Obramat", "Leroy Merlin", "Suministros Daganzo", "Repsol").
   - supplierTaxId: CIF/NIF del proveedor (ej: "A-28000000", "B-12345678"). Si es un ticket simplificado donde no figura el NIF, pon null.
   - invoiceNumber: Serie y número de factura o ticket (ej: "F-2026/89", "T-01-9982"). Si no hay número, pon null.
   - issueDate: Fecha en formato YYYY-MM-DD. Si no tiene año, asume el año en curso.
   - category: 'MATERIALES' | 'HERRAMIENTAS' | 'SUBCONTRATA' | 'COMBUSTIBLE' | 'VEHICULO' | 'SUMINISTROS' | 'ALQUILER' | 'SEGUROS' | 'RESTAURANTE' | 'VARIOS'.
   - taxBase: Base imponible sin IVA (número decimal).
   - vatRate: Tipo de IVA porcentual (21, 10, 4 o 0). Suministros generales al 21%.
   - vatAmount: Cuota de IVA (número decimal).
   - totalAmount: Total factura / ticket pagado (número decimal).
   - irpfRetention: Retención IRPF si la hubiera (subcontratas profesionales 15% o alquiler 19%). Si no hay, 0.
   - paymentMethod: 'Tarjeta' | 'Transferencia' | 'Efectivo' | 'Bizum' (lo que indique el ticket o 'Tarjeta' por defecto).
   - isInvestmentAsset: true si supera 3.005,06 € en base imponible o es maquinaria/activo duradero.
   - deductibilityHint: 'LIKELY_DEDUCTIBLE' (para compras directas de obra), 'NEEDS_REVIEW' (gasolina, vehículos, comidas o tickets sin CIF), 'NOT_DEDUCTIBLE'.
   - description: Breve resumen de los materiales o conceptos comprados.
   - assistantFeedback: Confirmación breve en español para el instalador.

ESQUEMA JSON:
{
  "supplierName": "Obramat",
  "supplierTaxId": "A81234567",
  "invoiceNumber": "F-2026-4412",
  "issueDate": "2026-09-15",
  "category": "MATERIALES",
  "taxBase": 100.00,
  "vatRate": 21,
  "vatAmount": 21.00,
  "irpfRetention": 0,
  "totalAmount": 121.00,
  "paymentMethod": "Tarjeta",
  "isInvestmentAsset": false,
  "deductibilityHint": "LIKELY_DEDUCTIBLE",
  "description": "4 sacos de mortero y tubería",
  "assistantFeedback": "Factura de Obramat registrada por 121,00 €"
}`;

/**
 * Llama a Gemini con soporte multimodal (imágenes de facturas o tickets).
 * @param {object} params
 * @param {Buffer|string} params.imageBuffer - Buffer de la imagen
 * @param {string} params.mimeType - 'image/jpeg', 'image/png', 'application/pdf'
 * @param {string} params.prompt - Texto opcional de acompañamiento
 * @param {string} params.systemInstruction - Instrucción de sistema
 * @param {string} params.apiKey
 * @returns {Promise<object>}
 */
export async function callGeminiMultimodal({
  imageBuffer,
  mimeType = 'image/jpeg',
  prompt = 'Analiza este documento y extrae los datos fiscales de la factura o ticket.',
  systemInstruction = GEMINI_PURCHASE_INVOICE_PROMPT,
  apiKey
}) {
  if (!apiKey) throw new Error('API key de Gemini no configurada');

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent`;
  const parts = [];

  if (imageBuffer) {
    const base64Data = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : imageBuffer;
    parts.push({
      inlineData: {
        data: base64Data,
        mimeType: mimeType || 'image/jpeg'
      }
    });
  }

  if (prompt) {
    parts.push({ text: prompt });
  }

  const body = {
    contents: [{ role: 'user', parts }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 2048
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) throw new Error('Respuesta vacía de Gemini Multimodal');
  return JSON.parse(jsonText);
}

/**
 * Extrae datos de factura recibida o gasto desde texto, audio o imagen de WhatsApp.
 * @param {string|{ buffer: Buffer, mimeType?: string, caption?: string }} input
 * @param {string} apiKey
 * @returns {Promise<object>}
 */
export async function parsePurchaseInvoiceWithGemini(input, apiKey) {
  if (typeof input === 'string') {
    return callGeminiAPI(
      `Analiza el siguiente texto de un profesional de obra y extrae los datos del gasto o factura recibida:\n\n"${input}"`,
      GEMINI_PURCHASE_INVOICE_PROMPT,
      apiKey
    );
  } else if (input && (input.buffer || input.imageBuffer)) {
    const buf = input.buffer || input.imageBuffer;
    const prompt = input.caption
      ? `Analiza este ticket o factura recibida. Comentario del profesional: "${input.caption}"`
      : 'Analiza este ticket o factura de compra y extrae todos los datos mercantiles y fiscales.';
    return callGeminiMultimodal({
      imageBuffer: buf,
      mimeType: input.mimeType || 'image/jpeg',
      prompt,
      systemInstruction: GEMINI_PURCHASE_INVOICE_PROMPT,
      apiKey
    });
  }
  throw new Error('Entrada no válida para parsePurchaseInvoiceWithGemini');
}

/**
 * Validador determinístico de backend para facturas recibidas (Anti-Alucinaciones).
 * Asegura cuadratura matemática estricta y asigna estado contable antes de insertar en SQLite.
 *
 * @param {object} raw - Datos crudos devueltos por Gemini
 * @param {string} businessId - Teléfono de la empresa
 * @param {string|null} attachmentPath - Ruta de la imagen guardada en disco
 * @returns {object} Factura normalizada lista para db_service.savePurchaseInvoice
 */
export function validateAndNormalizePurchaseInvoice(raw, businessId, attachmentPath = null) {
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

  let total = round2(raw.totalAmount);
  let rate = round2(raw.vatRate) || 21;
  let base = round2(raw.taxBase);
  let vat = round2(raw.vatAmount);
  let retention = round2(raw.irpfRetention);

  // Si se dispone del total pero no de la base ni IVA, se calcula determinísticamente
  if (total > 0 && base === 0 && vat === 0) {
    base = round2(total / (1 + rate / 100));
    vat = round2(total - base);
  } else if (base > 0 && vat === 0) {
    vat = round2(base * (rate / 100));
    if (total === 0) total = round2(base + vat - retention);
  }

  // Cuadratura matemática determinística (Base + IVA - Retención = Total)
  if (Math.abs(round2(base + vat - retention) - total) > 0.02) {
    vat = round2(total - base + retention);
  }

  const supplierTaxId = raw.supplierTaxId ? String(raw.supplierTaxId).trim().toUpperCase() : null;
  const isInvestment = base > 3005.06 || Boolean(raw.isInvestmentAsset);

  // Clasificación de deducibilidad
  let deductibilityStatus = raw.deductibilityHint || 'LIKELY_DEDUCTIBLE';
  const cat = String(raw.category || 'MATERIALES').toUpperCase();
  if (['COMBUSTIBLE', 'GASOLINA', 'RESTAURANTE', 'DIETAS', 'VEHICULO', 'PEAJE'].includes(cat) || !supplierTaxId) {
    deductibilityStatus = 'NEEDS_REVIEW';
  }

  return {
    businessId,
    supplierName: raw.supplierName || 'Proveedor',
    supplierTaxId,
    invoiceNumber: raw.invoiceNumber || `T-${Date.now().toString().slice(-6)}`,
    issueDate: raw.issueDate || new Date().toISOString().split('T')[0],
    category: cat,
    description: raw.description || 'Compra de suministros o materiales',
    taxBase: base,
    vatRate: rate,
    vatAmount: vat,
    irpfRetention: retention,
    totalAmount: total,
    vatDeductible: deductibilityStatus !== 'NOT_DEDUCTIBLE',
    deductiblePercentage: deductibilityStatus === 'NOT_DEDUCTIBLE' ? 0 : 100,
    deductibilityStatus,
    paidAmount: total, // Por defecto se asume pagado al momento de recibir el ticket
    isInvestmentAsset: isInvestment,
    attachmentPath: attachmentPath || null,
    assistantFeedback: raw.assistantFeedback
  };
}
