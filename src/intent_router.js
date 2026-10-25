/**
 * PresuVoz — Intent Router (Motor de Intenciones Determinístico)
 *
 * Intercepta mensajes de texto ANTES de llamar a Gemini y resuelve directamente
 * con la base de datos todo lo que NO requiere comprensión semántica compleja.
 *
 * Regla de oro:
 *   ✅ Usa SQLite → Consultas, listas, sumas, estadísticas, búsquedas por nombre
 *   🤖 Usa Gemini → Crear presupuestos, interpretar audios, redactar mensajes,
 *                   peticiones ambiguas o abiertas
 *
 * Formato de retorno de detectIntent():
 *   { intent: 'NOMBRE_INTENCION', params: { ... } }  → intención detectada
 *   null                                               → no hay intención clara → pasar a Gemini
 */

import {
  getUnpaidInvoices,
  getPendingWorksDebt,
  listBudgets,
  listAppointments,
  findClientsByName,
  getWorkMemory,
  getMonthlyRevenue,
  getPeriodRevenue,
  listAppointmentsWeek,
  getDashboard,
  getCompany,
  getCompanyById,
  saveCompany,
  getProjectBillingSummary,
  updateBudgetStatus,
  getBudget
} from './db_service.js';

import {
  getQuarterSummary,
  formatQuarterWhatsAppSummary,
  isGestoriaEnabled
} from './fiscal_service.js';

import {
  formatDisambiguationPrompt
} from './secretary_service.js';

// ─────────────────────────────────────────────────────────────────────────────
// UTILIDADES INTERNAS
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza texto eliminando tildes, signos y espacios extra */
function norm(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!]/g, '')
    .trim();
}

/** Verifica si el texto contiene alguno de los patrones proporcionados */
function matches(text, patterns) {
  const n = norm(text);
  return patterns.some(p => {
    if (p instanceof RegExp) return p.test(n);
    return n.includes(norm(p));
  });
}

/** Extrae el primer nombre de persona mencionado tras un indicador de cliente */
function extractClientName(text) {
  const n = norm(text);

  // Patrones: "cuánto me debe Juan", "deuda de García", "cómo va Juan", "la obra de María"
  const patterns = [
    /(?:debe|deben|adeuda)\s+(?:el|la|los)?\s*(\w[\w\s]{1,30}?)(?:\s*$|\?|,|\.)/,
    /(?:deuda\s+de|obra\s+de|presupuesto\s+de|trabajo\s+de|cliente|para|sobre)\s+(\w[\w\s]{1,30}?)(?:\s*$|\?|,|\.)/,
    /(?:como\s+va|que\s+pasa\s+con|estado\s+de|ficha\s+de)\s+(?:la\s+obra\s+de\s+)?(\w[\w\s]{1,30}?)(?:\s*$|\?|,|\.)/,
    /(?:buscar?|ver|mostrar|consultar)\s+(?:a\s+|al\s+|el\s+|la\s+)?(\w[\w\s]{1,30}?)(?:\s*$|\?|,|\.)/,
  ];

  for (const pattern of patterns) {
    const m = n.match(pattern);
    if (m && m[1]) {
      return m[1].trim().replace(/\s+/g, ' ');
    }
  }

  // Fallback: extraer la última palabra "importante" del texto
  const words = text.trim().split(/\s+/);
  if (words.length >= 2) {
    const lastWords = words.slice(-2).join(' ');
    if (lastWords.length > 2) return lastWords;
  }
  return null;
}

/**
 * Extrae de forma limpia el nombre del cliente en consultas coloquiales de deuda (HIGH-02).
 * Elimina adverbios temporales ("todavía", "aún", "ahora"), artículos, preposiciones y coletillas de obra.
 * @param {string} text - Texto del mensaje del usuario
 * @param {string[]} knownNames - Lista opcional de nombres conocidos en el tenant para match exacto
 * @returns {string|null} - Nombre limpio del cliente o null si no se refiere a un cliente concreto
 */
export function extractDebtClient(text, knownNames = []) {
  if (!text || typeof text !== 'string') return null;
  const n = norm(text);

  // Descartar si el mensaje es una acción o registro de cobro/pago (no es consulta de deuda)
  if (/\b(?:ha\s+(?:hecho|pagado|ingresado|transferido)|pago\s+de|pago\s+del|primer\s+pago|cobro\s+de|transferencia\s+de)\b/i.test(n)) {
    return null;
  }

  // Descartar si el mensaje solicita ver, pasar o descargar documentos (facturas, recibos, pdf)
  if (/\b(?:facturas?|recibos?|pdf|documento)\b/i.test(n) && /\b(?:mandame|pasame|muestrame|ensename|ver|descargar|dame|enviar|enseña|muestra|pasa|manda)\b/i.test(n)) {
    return null;
  }
  if (/^(?:las\s+|la\s+|los\s+|el\s+)?(?:facturas?|recibos?)\s+(?:de\s+|del\s+)/i.test(n)) {
    return null;
  }

  // Descartar si el mensaje es una modificación, creación o edición de presupuestos o partidas
  if (/\b(?:cambiar|cambia|modificar|modifica|anadir|añadir|anade|añade|quitar|quita|borrar|borra|eliminar|elimina|poner|pon|partida|partidas|precio|presupuesto|nueva\s+obra|nuevo\s+presupuesto)\b/i.test(n)) {
    return null;
  }

  // Exigir intención explícita de consulta de deuda o saldo
  const hasDebtIntent = /\b(?:debe|deben|adeuda|deuda|saldo|deber|queda\s+por\s+(?:pagar|cobrar)|falta\s+por\s+(?:pagar|cobrar)|quien\s+falta|cuanto\s+(?:dinero\s+)?(?:me\s+)?queda)\b/i.test(n)
    || /cuanto\s+(?:todavia\s+|aun\s+|ahora\s+)?me\s+debe/i.test(n)
    || /lo\s+de\s+/i.test(n);

  if (!hasDebtIntent) {
    return null;
  }

  // 1. Coincidencia prioritaria con nombres conocidos del tenant (de mayor a menor longitud)
  if (knownNames && knownNames.length > 0) {
    const sortedKnown = [...knownNames].sort((a, b) => b.length - a.length);
    for (const kn of sortedKnown) {
      const knNorm = norm(kn);
      if (knNorm.length < 2) continue;
      const re = new RegExp('\\b' + knNorm.replace(/\s+/g, '\\s+') + '\\b', 'i');
      if (re.test(n)) {
        return kn;
      }
    }
  }

  // 2. Descartar consultas de deuda puramente globales (estas van a ALL_DEBTS) siempre que no especifiquen cliente
  if (/(?:quien\s+me\s+debe|que\s+me\s+deben|total\s+(?:de\s+)?deudas|deudas?\s+pendientes|cobros?\s+pendientes|pasta)$/i.test(n)
    || /^(?:quien\s+(?:me\s+)?(?:queda|falta)\s+por\s+(?:pagar|cobrar)|a\s+quien\s+(?:le\s+)?(?:queda|falta)\s+por\s+(?:pagar|cobrar)|quien\s+falta\s+por\s+(?:pagar|cobrar)|quien\s+queda\s+por\s+(?:pagar|cobrar)|quienes\s+(?:me\s+)?(?:deben|quedan|faltan)|cuanto\s+(?:dinero\s+)?(?:me\s+)?deben\s+en\s+total|cuanto\s+(?:dinero\s+)?(?:me\s+)?queda\s+por\s+cobrar\s*)$/i.test(n)) {
    return null;
  }

  // 3. Patrones sintácticos para consultas de deuda hacia clientes
  const leadPatterns = [
    /(?:cuanto\s+(?:todavia\s+|aun\s+|ahora\s+)?me\s+debe|que\s+(?:todavia\s+|aun\s+|ahora\s+)?me\s+debe|dime\s+(?:lo\s+que\s+)?(?:todavia\s+|aun\s+|ahora\s+)?(?:me\s+)?debe|deuda\s+de|saldo\s+de)\s+(.+)/i,
    /(?:cuanto\s+(?:dinero\s+)?(?:le|me|nos)?\s*queda\s+por\s+(?:pagar|cobrar)(?:\s+(?:de\s+la\s+reforma\s+de|de\s+la\s+obra\s+de|de|a|en))?)\s+(.+)/i,
    /(?:cuanto\s+falta\s+por\s+(?:cobrarle|pagar)(?:\s+(?:de|a|en))?)\s+(.+)/i,
    /^(?!dime\b|sabes\b|mira\b|oye\b|cuanto\b|que\b|quien\b)(.+?)\s+(?:todavia|aun|ahora)?\s*me\s+debe(?:n)?/i,
    /lo\s+de\s+(.+)/i
  ];

  let rawSubject = null;
  for (const p of leadPatterns) {
    const m = n.match(p);
    if (m && m[1]) {
      rawSubject = m[1].trim();
      break;
    }
  }

  if (!rawSubject) return null;

  // 4. Limpieza de adverbios iniciales, artículos, tratamientos y preposiciones
  let cleaned = rawSubject
    .replace(/^(?:todavia|aun|ahora|actualmente|por\s+ahora)\s+/i, '')
    .replace(/^(?:a\s+|el\s+|la\s+|don\s+|dona\s+|cliente\s+|el\s+cliente\s+|la\s+reforma\s+de\s+|la\s+obra\s+de\s+|el\s+trabajo\s+de\s+|el\s+piso\s+de\s+|de\s+la\s+reforma\s+de\s+|de\s+la\s+obra\s+de\s+|de\s+)/i, '')
    .replace(/^(?:todavia|aun|ahora)\s+/i, '')
    .trim();

  // 5. Limpieza de coletillas de obra circunstanciales (ej. 'de la cocina', 'del baño', 'de la obra')
  cleaned = cleaned
    .replace(/\s+(?:de\s+la\s+|del?\s+|en\s+la\s+|en\s+el\s+|para\s+la\s+)(?:cocina|obra|piso|reforma|bano|casa|vivienda|local|chalet|centro|triana|sevilla|edificio)(?:\s+[\w\s]+)?$/i, '')
    .replace(/\s+(?:todavia|aun|ahora)\s+me\s+debe.*$/i, '')
    .replace(/\s+(?:500|1000|\d+).*$/i, '')
    .replace(/\s*(?:no|verdad|cierto)\s*$/i, '')
    .trim();

  // 6. Filtro de palabras no-nombre y falsos positivos
  const nonNames = [
    'todavia', 'aun', 'ahora', 'dinero', 'total', 'todo', 'algo', 'nada', 'cobrar', 'pagar',
    'euros', 'euro', 'de la cocina', 'la cocina', 'el piso', 'la obra', 'reforma',
    'el de la cocina', 'el cliente', 'el cliente de la obra', 'cliente', 'obra', 'cocina', 'piso',
    'cuanto dinero', 'cuanto', 'quien', 'pasta'
  ];
  if (!cleaned || nonNames.includes(cleaned) || cleaned.length < 2) {
    return null;
  }

  // Devolver el nombre limpio con mayúscula inicial
  return cleaned.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Extrae mes y año de un texto en español */
function extractMonthYear(text) {
  const n = norm(text);
  const now = new Date();

  const monthNames = {
    'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
    'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
    'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
  };

  // Detectar "este mes" o "mes actual"
  if (/este\s+mes|mes\s+actual|mes\s+en\s+curso/.test(n)) {
    return { month: now.getMonth() + 1, year: now.getFullYear() };
  }

  // Detectar "el mes pasado" o "mes anterior"
  if (/mes\s+pasado|mes\s+anterior|ultimo\s+mes/.test(n)) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { month: d.getMonth() + 1, year: d.getFullYear() };
  }

  // Detectar mes por nombre: "septiembre", "en octubre", "de marzo"
  for (const [name, num] of Object.entries(monthNames)) {
    if (n.includes(name)) {
      const yearMatch = text.match(/\b(202\d)\b/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : now.getFullYear();
      return { month: num, year };
    }
  }

  // Default: mes actual
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

/** Extrae trimestre y año de un texto en español */
function extractQuarterYear(text) {
  const n = norm(text);
  const now = new Date();
  let year = now.getFullYear();
  const yearMatch = text.match(/\b(202\d)\b/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  let quarter = null;
  if (/primer\s+trimestre|1t\b|1\s*º?\s*trimestre/i.test(n)) quarter = 1;
  else if (/segundo\s+trimestre|2t\b|2\s*º?\s*trimestre/i.test(n)) quarter = 2;
  else if (/tercer\s+trimestre|3t\b|3\s*º?\s*trimestre/i.test(n)) quarter = 3;
  else if (/cuarto\s+trimestre|4t\b|4\s*º?\s*trimestre/i.test(n)) quarter = 4;

  return { quarter, year };
}

/** Extrae el periodo y tipo de consulta financiera (cobros o facturación) */
export function extractPeriodParams(text) {
  const n = norm(text);
  const now = new Date();
  let year = now.getFullYear();
  const yearMatch = text.match(/\b(202\d)\b/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
  }

  let queryType = 'collected'; // Por defecto cuánto ha cobrado
  if (/\b(?:facturado|facturacion|facture|facturas\s+emitidas)\b/i.test(n) && !/\b(?:cobrado|ingresado|ganado|cobros?)\b/i.test(n)) {
    queryType = 'invoiced';
  } else if (/\b(?:facturado|facturacion)\b/i.test(n) && /\b(?:cobrado|cobros?)\b/i.test(n)) {
    queryType = 'all';
  }

  // 1. Hoy
  if (/\b(?:hoy|en\s+el\s+dia|de\s+hoy)\b/i.test(n) && !/\b(?:mes|trimestre|cuatrimestre|semana|ano|año)\b/i.test(n)) {
    return { period: 'today', queryType, year, month: now.getMonth() + 1 };
  }

  // 2. Semana
  if (/\b(?:esta\s+semana|de\s+la\s+semana|en\s+la\s+semana|semana\s+actual)\b/i.test(n)) {
    return { period: 'week', queryType, year, month: now.getMonth() + 1 };
  }

  // 3. Cuatrimestre
  if (/\b(?:cuatrimestre|4\s*meses|cuatrimestral)\b/i.test(n)) {
    let fourMonth = null;
    if (/primer\s+cuatrimestre|1c\b|1\s*º?\s*cuatrimestre|primer\s+cuatrimestral/i.test(n)) fourMonth = 1;
    else if (/segundo\s+cuatrimestre|2c\b|2\s*º?\s*cuatrimestre|segundo\s+cuatrimestral/i.test(n)) fourMonth = 2;
    else if (/tercer\s+cuatrimestre|3c\b|3\s*º?\s*cuatrimestre|tercer\s+cuatrimestral/i.test(n)) fourMonth = 3;
    else {
      fourMonth = Math.floor(now.getMonth() / 4) + 1;
    }
    return { period: 'four_month', fourMonth, queryType, year };
  }

  // 4. Trimestre
  if (/\b(?:trimestre|q[1-4]|trimestral)\b/i.test(n)) {
    let quarter = null;
    if (/primer\s+trimestre|1t\b|1\s*º?\s*trimestre|q1\b/i.test(n)) quarter = 1;
    else if (/segundo\s+trimestre|2t\b|2\s*º?\s*trimestre|q2\b/i.test(n)) quarter = 2;
    else if (/tercer\s+trimestre|3t\b|3\s*º?\s*trimestre|q3\b/i.test(n)) quarter = 3;
    else if (/cuarto\s+trimestre|4t\b|4\s*º?\s*trimestre|q4\b/i.test(n)) quarter = 4;
    else {
      quarter = Math.floor(now.getMonth() / 3) + 1;
    }
    return { period: 'quarter', quarter, queryType, year };
  }

  // 5. Año
  if (/\b(?:este\s+a[ñn]o|a[ñn]o\s+actual|del\s+a[ñn]o|en\s+el\s+a[ñn]o)\b/i.test(n) && !/\b(?:mes|trimestre|cuatrimestre|semana)\b/i.test(n)) {
    return { period: 'year', queryType, year };
  }

  // 6. Mes (default)
  const my = extractMonthYear(text);
  return { period: 'month', month: my.month, year: my.year, queryType };
}

/**
 * Extrae el identificador o nombre del cliente cuando el profesional pide cancelar,
 * anular o dar por perdido un presupuesto.
 * Filtra citas y facturas para evitar falsos positivos con otros comandos de cancelación.
 */
export function extractCancelBudgetTarget(text) {
  if (!text || typeof text !== 'string') return null;
  const n = norm(text);

  // No interceptar cancelaciones de citas ni facturas
  if (/\b(?:cita|citas|visita|visitas|factura|facturas)\b/i.test(n)) return null;

  const patterns = [
    // "cancela el presupuesto PRE2026-001", "cancela el presupuesto de María", "cancela el de Juan", "anular presupuesto de Carlos", "anula el de María"
    /(?:cancela|cancelar|anula|anular|dar?\s+de\s+baja)\s+(?:el\s+)?(?:presupuesto\s+)?(?:de\s+|del\s+)?([a-z0-9áéíóúñÁÉÍÓÚÑ.\s-]+)/i,
    // "marca como perdido el de María", "marcar como cancelado el presupuesto de Juan", "da por perdido el de Carlos"
    /(?:marca|marcar|da|dar|darle)\s+(?:por\s+)?(?:como\s+)?(?:perdido|cancelado|rechazado)\s+(?:el\s+)?(?:presupuesto\s+)?(?:de\s+|del\s+)?([a-z0-9áéíóúñÁÉÍÓÚÑ.\s-]+)/i,
    // "el cliente ha rechazado el presupuesto de María", "ha rechazado el presupuesto de Juan", "rechazado el presupuesto de Carlos"
    /(?:(?:el\s+)?cliente\s+ha\s+rechazado|ha\s+rechazado|rechaza(?:do)?)\s+(?:el\s+)?(?:presupuesto\s+)?(?:de\s+|del\s+)?([a-z0-9áéíóúñÁÉÍÓÚÑ.\s-]+)/i,
    // "no se va a hacer el de María", "no se va a hacer el presupuesto de Carlos", "no lo va a hacer María"
    /(?:no\s+se\s+va\s+a\s+hacer|no\s+lo\s+va\s+a\s+hacer|no\s+hacemos)\s+(?:el\s+)?(?:presupuesto\s+)?(?:de\s+|del\s+)?([a-z0-9áéíóúñÁÉÍÓÚÑ.\s-]+)/i
  ];

  for (const p of patterns) {
    const m = n.match(p);
    if (m && m[1]) {
      let target = m[1].trim().replace(/[¿?¡!.]/g, '');
      target = target.replace(/\b(?:por\s+favor|gracias|ya|ahora|definitivamente|al\s+final)\b/gi, '').trim();
      target = target.replace(/^(?:el|la|los|las|de|del)\s+/i, '').trim();
      if (target.length >= 1) return target;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR DE INTENCIONES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analiza el texto del mensaje y determina si puede resolverse determinísticamente.
 * @param {string} text - Mensaje del profesional
 * @returns {{ intent: string, params: object } | null}
 */
export function detectIntent(text, context = {}) {
  if (!text || typeof text !== 'string') return null;
  const n = norm(text);

  // ── CANCELAR O DAR POR PERDIDO UN PRESUPUESTO ─────────────────────────────
  // "cancela el presupuesto de María", "marca como perdido el de María", "anula el presupuesto de Carlos"
  const cancelTarget = extractCancelBudgetTarget(text);
  if (cancelTarget) {
    return { intent: 'CANCEL_BUDGET', params: { targetQuery: cancelTarget } };
  }

  // ── CIERRE FISCAL / GESTORÍA / RESUMEN TRIMESTRAL ──────────────────────────
  // "prepárame lo de la gestoría", "¿cómo llevo el trimestre?", "¿cuánto IVA llevo?", "resumen trimestre"
  if (matches(n, [
    /preparame\s+(?:lo\s+de\s+)?la\s+gestoria/,
    /lo\s+de\s+la\s+gestoria/,
    /papeles\s+(?:para|de)\s+la\s+gestoria/,
    /como\s+(?:llevo|va)\s+el\s+trimestre/,
    /resumen\s+(?:del?\s+)?trimestre/,
    /cierre\s+(?:del?\s+)?trimestre/,
    /cuanto\s+iva\s+llevo/,
    /cuanto\s+iva\s+tengo\s+que\s+pagar/,
    /liquidacion\s+(?:de\s+)?iva/,
    /libros?\s+(?:de\s+)?(?:iva|facturas?|registro)/,
    /modelo\s+303/,
    /modelo\s+130/,
    /saca(?:me)?\s+el\s+trimestre/,
    /exportar\s+trimestre/,
    /informe\s+(?:de\s+)?cierre/
  ])) {
    const { quarter, year } = extractQuarterYear(text);
    return { intent: 'FISCAL_QUARTER_SUMMARY', params: { quarter, year } };
  }

  // ── ENVIAR A LA GESTORÍA POR CORREO (Acción Protegida Nivel C) ─────────────
  // "enviar a mi gestoría", "mándaselo a mi gestor", "enviar papeles a mi gestoría"
  if (matches(n, [
    /enviar?\s+(?:lo\s+)?a\s+(?:mi\s+)?gestor(?:ia)?/,
    /mandar?\s+(?:lo\s+)?a\s+(?:mi\s+)?gestor(?:ia)?/,
    /enviaselo\s+a\s+(?:mi\s+)?gestor(?:ia)?/,
    /mandaselo\s+a\s+(?:mi\s+)?gestor(?:ia)?/,
    /mandale\s+(?:los\s+papeles|el\s+trimestre|las\s+facturas)\s+a\s+(?:mi\s+)?gestor(?:ia)?/,
    /enviar\s+trimestre\s+a\s+(?:mi\s+)?gestor(?:ia)?/
  ])) {
    const { quarter, year } = extractQuarterYear(text);
    return { intent: 'SEND_TO_GESTORIA', params: { quarter, year } };
  }

  // ── DASHBOARD / RESUMEN GLOBAL ────────────────────────────────────────────
  // "resumen", "estado", "qué tal va todo", "dashboard", "cómo estoy"
  if (/^(?:resumen|estado|dashboard|situacion|como\s+estoy|que\s+tal\s+va\s+todo|como\s+va\s+todo|como\s+voy|panel)$/.test(n)) {
    return { intent: 'DASHBOARD', params: {} };
  }

  // ── FACTURACIÓN PENDIENTE (PENDIENTE DE FACTURAR) ──────────────────────────
  // "cuánto queda por facturar", "cuánto me queda por facturar de la reforma de Laura"
  if (matches(n, [
    /cuanto\s+(?:dinero\s+)?(?:me\s+)?(?:queda|falta)\s+por\s+facturar/,
    /pendiente\s+de\s+facturar/,
    /que\s+(?:me\s+)?(?:queda|falta)\s+por\s+facturar/,
    /falta\s+por\s+facturar/
  ])) {
    const invClient = extractDebtClient(text.replace(/facturar/gi, 'cobrar'), context?.knownNames || []);
    return { intent: 'PENDING_TO_INVOICE', params: { clientName: invClient } };
  }

  // ── DEUDA DE UN CLIENTE CONCRETO (HIGH-02) ───────────────────────────────
  // Extrae limpiamente el cliente sin adverbios ni coletillas de obra
  const debtClient = extractDebtClient(text, context?.knownNames || []);
  if (debtClient) {
    let addressHint = null;
    const normText = norm(text);
    const normClient = norm(debtClient);
    const idx = normText.indexOf(normClient);
    if (idx !== -1) {
      const remainder = normText.substring(idx + normClient.length).replace(/[?¿!¡.]/g, '').trim();
      // Si tras el nombre hay una especificación de dirección/obra (ej: "el de la calle rapuncel", "obra segun visita", "de la calle mayor")
      if (remainder.length > 2 && !/^(?:todavia|aun|ahora|por\s+favor)\b/i.test(remainder)) {
        addressHint = remainder;
      }
    }
    return { intent: 'DEBT_BY_CLIENT', params: { clientName: debtClient, addressHint } };
  }

  // ── DEUDAS TOTALES ─────────────────────────────────────────────────────────
  // "quién me debe", "qué me deben", "deudas pendientes", "cobros pendientes", "quién me queda por pagar"
  if (matches(n, [
    /quien\s+(?:me\s+)?(?:queda|falta)\s+por\s+(?:pagar|cobrar)/,
    /a\s+quien\s+(?:le\s+)?(?:queda|falta)\s+por\s+(?:pagar|cobrar)/,
    /quien\s+falta\s+por\s+(?:pagar|cobrar)/,
    /quien\s+queda\s+por\s+(?:pagar|cobrar)/,
    /quienes\s+(?:me\s+)?(?:deben|quedan|faltan)/,
    /quien\s+me\s+debe/,
    /que\s+me\s+deben/,
    /deudas?\s+pendientes?/,
    /cobros?\s+pendientes?/,
    /cuanto\s+me\s+deben\s+en\s+total/,
    /total\s+(?:de\s+)?deudas?/,
    /pendiente\s+de\s+cobro/,
    /lo\s+que\s+me\s+deben/,
    /tengo\s+(?:algo\s+)?pendiente\s+de\s+cobrar/,
    /facturas?\s+sin\s+cobrar/,
    /facturas?\s+pendientes?\s+de\s+(?:pago|cobro)/,
  ])) {
    return { intent: 'ALL_DEBTS', params: {} };
  }

  // ── ESTADÍSTICAS Y COBROS POR PERIODO (MES, TRIMESTRE, CUATRIMESTRE, SEMANA, HOY, AÑO) ──
  // "cuánto he cobrado este mes", "cuánto he facturado este trimestre", "cobros de esta semana", etc.
  if (matches(n, [
    /cuanto\s+he\s+(?:facturado|cobrado|ganado|ingresado)/,
    /cuanto\s+llevo\s+(?:este\s+mes|esta\s+semana|este\s+trimestre|este\s+cuatrimestre|facturado|cobrado|ingresado)/,
    /cuanto\s+(?:he\s+)?hecho\s+(?:este\s+mes|esta\s+semana|este\s+trimestre|este\s+cuatrimestre|en)/,
    /facturado\s+(?:en|este|el|esta)/,
    /cobrado\s+(?:en|este|el|esta|hoy)/,
    /total\s+(?:cobrado|facturado)/,
    /ingresos?\s+(?:de|del|este|esta|en)/,
    /cobros?\s+(?:de|del|este|esta|en|hoy)/,
    /resumen\s+(?:de\s+)?(?:este|el|esta)?\s*(?:mes|trimestre|cuatrimestre|semana)/,
    /estadisticas?\s+(?:de\s+)?(?:este|el|esta)?\s*(?:mes|trimestre|cuatrimestre|semana)/,
    /cuanto\s+money\s+(?:tengo|llevo)/,
  ])) {
    const params = extractPeriodParams(text);
    if (params.period === 'month') {
      return { intent: 'MONTHLY_STATS', params: { ...params, month: params.month, year: params.year } };
    }
    if (params.period === 'quarter') {
      return { intent: 'QUARTER_STATS', params };
    }
    if (params.period === 'four_month') {
      return { intent: 'FOUR_MONTH_STATS', params };
    }
    if (params.period === 'week') {
      return { intent: 'WEEKLY_REVENUE', params };
    }
    if (params.period === 'today') {
      return { intent: 'DAILY_REVENUE', params };
    }
    if (params.period === 'year') {
      return { intent: 'YEARLY_STATS', params };
    }
    return { intent: 'REVENUE_STATS', params };
  }

  // ── AGENDA SEMANAL ────────────────────────────────────────────────────────
  // "qué tengo esta semana", "visitas de esta semana", "próximas citas"
  if (!/\b(?:agend(?:ar|ame|á|anos|ale|a\b)|apunt(?:ar|ame|á|anos|ale|a\b)|anot(?:ar|ame|á|anos|ale|a\b)|guard(?:ar|ame|á|anos|ale|a\b)|program(?:ar|ame|á|anos|ale|a\b)|cancel(?:ar|a|ame)|anul(?:ar|a|ame)|borr(?:ar|a|ame)|elimin(?:ar|a|ame)|reagend(?:ar|a|ame)|pospon(?:er|ga)|mov(?:er|ed)|pas(?:ar|a|ame)|cambi(?:ar|a|ame))\b/i.test(n) && matches(n, [
    /(?:esta|la)\s+semana/,
    /proximas?\s+(?:citas|visitas)/,
    /semana\s+que\s+viene/,
    /citas?\s+(?:de\s+)?(?:esta\s+semana|la\s+semana)/,
    /visitas?\s+(?:de\s+)?(?:esta\s+semana|la\s+semana)/,
    /que\s+tengo\s+pendiente\s+(?:de\s+visitar|de\s+ver)/,
  ])) {
    return { intent: 'WEEKLY_AGENDA', params: {} };
  }

  // ── CONTEO / ESTADÍSTICAS DE PRESUPUESTOS ─────────────────────────────────
  // "cuántos presupuestos tengo", "cuántos presupuestos sin firmar"
  if (matches(n, [
    /cuantos\s+presupuestos/,
    /presupuestos\s+(?:tengo|hay|sin\s+firmar|pendientes?|aceptados?|firmados?)/,
    /cuantas?\s+obras?\s+(?:tengo|hay|activas?|en\s+curso)/,
    /numero\s+de\s+presupuestos/,
  ])) {
    return { intent: 'BUDGET_STATS', params: {} };
  }

  // ── ESTADO DE OBRA POR CLIENTE (lenguaje natural) ─────────────────────────
  // "cómo va la obra de Juan", "qué tal va García", "estado de la obra de María"
  const workStatusMatch = n.match(
    /(?:como\s+(?:va|esta|vamos|van)\s+(?:la\s+)?(?:obra\s+)?(?:de\s+|con\s+)?|que\s+tal\s+(?:va|esta)\s+(?:la\s+)?(?:obra\s+)?(?:de\s+)?|estado\s+(?:de\s+la\s+obra\s+de|del?\s+trabajo\s+de\s+)?)\s*(\w[\w\s]{1,30}?)(?:\s*$|\?|,|\.)/
  );
  if (workStatusMatch && workStatusMatch[1]) {
    const clientName = workStatusMatch[1].trim();
    if (!/^(?:todo|todo\s+bien|bien|mal|regular|algo)$/.test(clientName)) {
      return { intent: 'WORK_STATUS', params: { clientName } };
    }
  }

  // ── BÚSQUEDA DE CLIENTE / OBRA ────────────────────────────────────────────
  // "el presupuesto de María", "la obra de García", "buscar Juan"
  const clientLookupMatch = n.match(
    /^(?:(?:el|la|los)\s+)?(?:presupuesto|obra|trabajo|cliente|factura)\s+(?:de\s+|del\s+|para\s+)?(\w[\w\s]{1,30}?)(?:\s*$|\?|,|\.)/
  );
  if (clientLookupMatch && clientLookupMatch[1]) {
    const clientName = clientLookupMatch[1].trim();
    if (clientName.length > 1 && !/^(?:nuevo|anterior|ultimo|primero|mas\s+reciente)$/.test(clientName)) {
      return { intent: 'CLIENT_LOOKUP', params: { clientName } };
    }
  }

  // ── CONFIGURACIÓN / DATOS DE EMPRESA / BIZUM / IBAN ────────────────────────
  // "mi bizum es 612345678", "pon de bizum 612345678", "bizum 612345678", "cambia el bizum a 612345678"
  const bizumMatch = n.match(/(?:(?:mi|el)\s+)?bizum\s*(?:es|de|al|a)?\s*[:\s]*(\+?34\s*)?([67]\d{8})/);
  if (bizumMatch && bizumMatch[2]) {
    return { intent: 'SET_BIZUM', params: { bizum: bizumMatch[2] } };
  }

  // "mi iban es ES...", "pon de iban ES...", "iban ES..."
  const ibanMatch = text.match(/\b(ES\d{2}[ \d]{20,28})\b/i);
  if (ibanMatch && ibanMatch[1] && (n.includes('iban') || n.includes('cuenta'))) {
    return { intent: 'SET_IBAN', params: { iban: ibanMatch[1].replace(/\s+/g, '').toUpperCase() } };
  }

  // "mis datos", "ver mi empresa", "ver configuracion", "mi perfil", "datos de la empresa"
  if (matches(n, [
    /^(?:mis\s+datos|mi\s+empresa|ver\s+mi\s+empresa|ver\s+mis\s+datos|mi\s+perfil|ver\s+perfil|ver\s+configuracion|configuracion)$/,
    /datos\s+de\s+(?:mi\s+)?empresa/,
    /como\s+estan?\s+mis\s+datos/
  ])) {
    return { intent: 'SHOW_COMPANY', params: {} };
  }

  // "buscar Juan", "encontrar García"
  const searchMatch = n.match(/^(?:buscar?|encontrar?|ver|mostrar)\s+(?:a\s+)?(\w[\w\s]{1,30}?)(?:\s*$|\?|,|\.)$/);
  if (searchMatch && searchMatch[1]) {
    return { intent: 'CLIENT_LOOKUP', params: { clientName: searchMatch[1].trim() } };
  }

  // No se detectó ninguna intención determinística → pasar a Gemini
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATEADORES DE RESPUESTA
// ─────────────────────────────────────────────────────────────────────────────

function fmt(num) {
  return Number(num || 0).toFixed(2).replace('.', ',');
}

function formatDate(isoDateStr) {
  if (!isoDateStr) return '—';
  try {
    // Si es formato YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoDateStr)) {
      const [y, m, d] = isoDateStr.split('-');
      return `${d}/${m}/${y}`;
    }
    return new Date(isoDateStr).toLocaleDateString('es-ES');
  } catch { return isoDateStr; }
}

function formatDayName(isoDateStr) {
  if (!isoDateStr) return '';
  try {
    const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const d = new Date(isoDateStr + 'T00:00:00');
    return days[d.getDay()];
  } catch { return ''; }
}

/** Formatea la lista de deudas pendientes para WhatsApp */
export function formatAllDebts(unpaidInvoices = [], pendingWorks = []) {
  const hasInvoices = unpaidInvoices && unpaidInvoices.length > 0;
  const hasWorks = pendingWorks && pendingWorks.length > 0;

  if (!hasInvoices && !hasWorks) {
    return '✅ *¡Todo al día!* No tienes facturas ni obras con saldo pendiente de cobro ahora mismo. 💪';
  }

  let totalDebt = 0;
  const countLabel = hasInvoices && hasWorks
    ? `${unpaidInvoices.length} factura${unpaidInvoices.length !== 1 ? 's' : ''} y ${pendingWorks.length} obra${pendingWorks.length !== 1 ? 's' : ''}`
    : (hasInvoices ? `${unpaidInvoices.length} factura${unpaidInvoices.length !== 1 ? 's' : ''}` : `${pendingWorks.length} obra${pendingWorks.length !== 1 ? 's' : ''}`);

  const lines = [
    `💸 *Cobros pendientes (${countLabel})*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  if (hasInvoices) {
    for (const inv of unpaidInvoices) {
      const invoiceData = inv.invoice;
      const total = inv.totalAmount || 0;
      const advance = invoiceData?.financials?.advanceAmount || 0;
      const remaining = invoiceData?.financials?.remainingAmount ?? Math.max(0, total - advance);
      totalDebt += remaining;
      const daysLabel = inv.daysPending > 0 ? ` · _${inv.daysPending} días_` : '';
      lines.push(`📄 *${inv.clientName}* — Factura *${inv.id}*: *${fmt(remaining)} €* pendientes${daysLabel}`);
    }
  }

  if (hasWorks) {
    for (const w of pendingWorks) {
      if (hasInvoices && unpaidInvoices.some(inv => inv.budgetId === w.budgetId)) continue;
      totalDebt += w.remainingBalance;
      lines.push(`🏗️ *${w.clientName}* — Presupuesto *${w.budgetId}*: *${fmt(w.remainingBalance)} €* pendientes (Total: ${fmt(w.totalAmount)} € · Cobrado: ${fmt(w.totalPaid)} €)`);
    }
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`💰 *Total pendiente de cobrar: ${fmt(totalDebt)} €*`);
  lines.push('');
  lines.push('💡 _Di "factura Juan" para emitir, o "cobro 500 Juan" para registrar un pago._');

  return lines.join('\n');
}

/** Formatea la deuda de un cliente concreto */
export function formatDebtByClient(clientName, unpaidInvoices = [], resolvedCandidate = null, work = null) {
  const hasInvoices = unpaidInvoices && unpaidInvoices.length > 0;
  const hasWorkDebt = work && work.remainingBalance > 0;

  if (!hasInvoices && !hasWorkDebt) {
    return `✅ *${clientName}* está al corriente de pago. No tiene facturas ni presupuestos con saldo pendiente.`;
  }

  const lines = [
    `💸 *Deuda de ${clientName}*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  if (resolvedCandidate?.clientAddress && resolvedCandidate.clientAddress !== 'Sin dirección registrada') {
    lines.push(`📍 *Ubicación:* ${resolvedCandidate.clientAddress}`);
  }

  let totalDebt = 0;

  if (hasInvoices) {
    for (const inv of unpaidInvoices) {
      const invoiceData = inv.invoice;
      const total = inv.totalAmount || 0;
      const advance = invoiceData?.financials?.advanceAmount || 0;
      const remaining = invoiceData?.financials?.remainingAmount ?? Math.max(0, total - advance);
      totalDebt += remaining;
      lines.push(`📄 Factura *${inv.id}* · Total: ${fmt(total)} € · Anticipo: ${fmt(advance)} € · *Pendiente: ${fmt(remaining)} €*`);
      if (inv.daysPending > 0) lines.push(`   ⏱️ Lleva ${inv.daysPending} días sin pagar`);
    }
  }

  if (hasWorkDebt && (!hasInvoices || work.budgetId !== unpaidInvoices[0]?.budgetId)) {
    totalDebt += work.remainingBalance;
    lines.push(`📋 Presupuesto *${work.budgetId}* · Total obra: ${fmt(work.totalAmount)} € · Cobrado: ${fmt(work.totalPaid)} € · *Pendiente: ${fmt(work.remainingBalance)} €*`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`💰 *Total que te debe: ${fmt(totalDebt)} €*`);
  lines.push('');
  lines.push(`💡 _Di "cobro [importe] ${clientName}" para registrar un pago, o "factura ${clientName}" para emitir._`);

  return lines.join('\n');
}

/** Formatea estadísticas de cobros y facturación para cualquier periodo */
export function formatPeriodRevenue(stats, options = {}) {
  const queryType = options.queryType || stats?.queryType || 'collected';
  const label = stats?.periodLabel || 'el periodo';

  const lines = [];

  if (queryType === 'invoiced') {
    lines.push(`📊 *FACTURACIÓN Y COBROS — ${label.toUpperCase()}*`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`📄 Total facturado: *${fmt(stats?.totalInvoiced || 0)} €* (${stats?.invoiceCount || 0} factura${(stats?.invoiceCount || 0) !== 1 ? 's' : ''})`);
    lines.push(`💵 Total cobrado: *${fmt(stats?.totalCollected || 0)} €* (${stats?.paymentCount || 0} cobro${(stats?.paymentCount || 0) !== 1 ? 's' : ''})`);
    if ((stats?.totalPending || 0) > 0) {
      lines.push(`⏳ Pendiente de cobrar: *${fmt(stats.totalPending)} €*`);
    }
  } else {
    // queryType === 'collected' o default
    lines.push(`💰 *TOTAL COBRADO — ${label.toUpperCase()}*`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`💵 Total cobrado: *${fmt(stats?.totalCollected || 0)} €* (${stats?.paymentCount || 0} cobro${(stats?.paymentCount || 0) !== 1 ? 's recibido' : ' recibido'}${(stats?.paymentCount || 0) !== 1 ? 's' : ''})`);
    lines.push(`📄 Total facturado: *${fmt(stats?.totalInvoiced || 0)} €* (${stats?.invoiceCount || 0} factura${(stats?.invoiceCount || 0) !== 1 ? 's' : ''})`);
    if ((stats?.totalPending || 0) > 0) {
      lines.push(`⏳ Pendiente de cobrar: *${fmt(stats.totalPending)} €*`);
    }
  }

  // Desglose de cobros si hay cobros registrados
  if (stats?.paymentsList && stats.paymentsList.length > 0) {
    lines.push('');
    lines.push(`🧾 *Detalle de cobros recibidos (${stats.paymentsList.length}):*`);
    const maxShow = 10;
    const toShow = stats.paymentsList.slice(0, maxShow);
    for (const p of toShow) {
      const parts = [`• *${fmt(p.amount)} €* · ${p.clientName}`];
      const details = [];
      if (p.method) details.push(p.method);
      if (p.concept && p.concept !== 'Pago recibido' && p.concept !== 'Liquidación final del saldo pendiente') {
        details.push(p.concept);
      }
      if (p.budgetId) details.push(p.budgetId);
      if (details.length > 0) {
        parts.push(` (${details.join(' · ')})`);
      }
      lines.push(parts.join(''));
    }
    if (stats.paymentsList.length > maxShow) {
      lines.push(`_... y ${stats.paymentsList.length - maxShow} cobros más._`);
    }
  } else if (!stats?.totalCollected || stats.totalCollected === 0) {
    lines.push('');
    lines.push('ℹ️ _No tienes ningún cobro registrado en este periodo._');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  if ((stats?.totalInvoiced || 0) > 0 && (stats?.totalCollected || 0) > 0) {
    const pct = Math.round((stats.totalCollected / stats.totalInvoiced) * 100);
    lines.push(`📈 Cobrado: *${pct}%* del total facturado`);
  }

  return lines.join('\n');
}

/** Formatea estadísticas mensuales (retrocompatibilidad) */
function formatMonthlyStats(stats, month, year, options = {}) {
  if (stats && stats.periodLabel) {
    return formatPeriodRevenue(stats, options);
  }
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const monthName = monthNames[month - 1] || `Mes ${month}`;

  return formatPeriodRevenue({
    ...stats,
    periodLabel: `${monthName} ${year}`,
    paymentsList: stats?.paymentsList || []
  }, options);
}

/** Formatea agenda semanal */
function formatWeeklyAgenda(appointments) {
  if (!appointments || appointments.length === 0) {
    return '📅 *Esta semana* no tienes citas ni visitas programadas.\n\n💡 _Di "cita con Juan el martes a las 10" para añadir una._';
  }

  const lines = [
    `📅 *Agenda — próximos 7 días (${appointments.length} cita${appointments.length !== 1 ? 's' : ''})*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  for (const apt of appointments) {
    const dayName = formatDayName(apt.date);
    const dateStr = formatDate(apt.date);
    lines.push(`📍 *${apt.clientName}* — ${dayName ? dayName + ', ' : ''}${dateStr} a las ${apt.time}`);
    if (apt.clientAddress) lines.push(`   🏠 ${apt.clientAddress}`);
    if (apt.notes && apt.notes !== 'Visita técnica y toma de medidas') {
      lines.push(`   📝 ${apt.notes}`);
    }
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 _Di "cancelar cita Juan" para anular, o "agenda mañana" para ver solo mañana._');

  return lines.join('\n');
}

/** Formatea estadísticas de presupuestos */
function formatBudgetStats(budgets) {
  if (!budgets || budgets.length === 0) {
    return '📋 No tienes ningún presupuesto registrado todavía.\n\n💡 _Mándame un audio describiendo la obra y el cliente para crear el primero._';
  }

  const total = budgets.length;
  const pending = budgets.filter(b => ['PENDIENTE_ACEPTACION', 'ENVIADO'].includes(b.status)).length;
  const accepted = budgets.filter(b => ['ACEPTADO', 'FIRMADO'].length > 0 && ['ACEPTADO', 'FIRMADO'].includes(b.status)).length;
  const finished = budgets.filter(b => b.status === 'FINALIZADO').length;
  const drafts = budgets.filter(b => b.isDraft).length;

  const lines = [
    `📋 *Resumen de presupuestos*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📄 Total: *${total}*`,
    `⏳ Pendientes de firma: *${pending}*`,
    `✅ Aceptados/Firmados: *${accepted}*`,
    `🏁 Finalizados: *${finished}*`,
    drafts > 0 ? `📝 Borradores: *${drafts}*` : null,
  ].filter(Boolean);

  // Top 3 más recientes
  const recent = budgets.slice(0, 3);
  if (recent.length > 0) {
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🕐 *Más recientes:*');
    for (const b of recent) {
      const statusEmoji = { 'PENDIENTE_ACEPTACION': '⏳', 'ACEPTADO': '✅', 'FIRMADO': '✍️', 'FINALIZADO': '🏁', 'ENVIADO': '📤', 'CANCELADO': '❌', 'PERDIDO': '❌' }[b.status] || '📋';
      const total = b.financials?.totalAmount || 0;
      lines.push(`${statusEmoji} *${b.client?.name || 'Cliente'}* · ${fmt(total)} € · ${b.id}`);
    }
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 _Di "mis presupuestos" para verlos todos, o "presupuestos pendientes" para los sin firmar._');

  return lines.join('\n');
}

/** Formatea el estado de una obra */
function formatWorkStatus(work) {
  if (!work) return null;

  const pctPaid = work.totalAmount > 0
    ? Math.round((work.totalPaid / work.totalAmount) * 100)
    : 0;

  const lines = [
    `🏗️ *Obra de ${work.clientName}*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📍 ${work.clientAddress || 'Dirección no registrada'}`,
    '',
    `💰 *Estado económico*`,
    `   Total obra: *${fmt(work.totalAmount)} €*`,
    `   Cobrado: *${fmt(work.totalPaid)} €* (${pctPaid}%)`,
    `   Pendiente: *${fmt(work.remainingBalance)} €*`,
  ];

  if (work.startDate || work.estimatedEndDate) {
    lines.push('');
    lines.push('📅 *Plazos*');
    if (work.startDate) lines.push(`   Inicio: ${formatDate(work.startDate)}`);
    if (work.estimatedEndDate) lines.push(`   Fin estimado: ${formatDate(work.estimatedEndDate)}`);
  }

  const tasksDone = work.tasks?.done?.length || 0;
  const tasksPending = work.tasks?.pending?.length || 0;
  const totalTasks = tasksDone + tasksPending;

  if (totalTasks > 0) {
    lines.push('');
    lines.push(`✅ *Tareas: ${tasksDone}/${totalTasks} completadas*`);
    if (tasksPending > 0) {
      lines.push('📌 *Pendientes:*');
      work.tasks.pending.slice(0, 4).forEach(t => lines.push(`   • ${t.description}`));
      if (tasksPending > 4) lines.push(`   _...y ${tasksPending - 4} más_`);
    }
  }

  const matPending = work.materials?.pending?.length || 0;
  if (matPending > 0) {
    lines.push('');
    lines.push(`🛒 *Materiales pendientes de comprar: ${matPending}*`);
    work.materials.pending.slice(0, 3).forEach(m => {
      lines.push(`   • ${m.qty > 1 ? m.qty + ' ' : ''}${m.description}`);
    });
    if (matPending > 3) lines.push(`   _...y ${matPending - 3} más_`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`📄 Referencia: ${work.budgetId}`);

  return lines.join('\n');
}

/** Formatea resultado de búsqueda de cliente */
function formatClientLookup(clientName, matches) {
  if (!matches || matches.length === 0) {
    return `🔍 No encontré ningún presupuesto u obra para *"${clientName}"*.\n\n💡 _Prueba con otro nombre o di "mis presupuestos" para verlos todos._`;
  }

  if (matches.length === 1) {
    const m = matches[0];
    const statusEmoji = { 'PENDIENTE_ACEPTACION': '⏳', 'ACEPTADO': '✅', 'FIRMADO': '✍️', 'FINALIZADO': '🏁', 'ENVIADO': '📤', 'CANCELADO': '❌', 'PERDIDO': '❌' }[m.status] || '📋';
    const lines = [
      `${statusEmoji} *${m.clientName}*`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      `📍 ${m.clientAddress || 'Sin dirección'}`,
      `💰 Importe: *${fmt(m.totalAmount)} €*`,
      `📄 Referencia: ${m.id}`,
      `📌 Estado: ${m.status?.replace(/_/g, ' ') || 'Sin estado'}`,
      `📅 ${formatDate(m.createdAt?.split('T')[0] || m.createdAt)}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━',
      '💡 _Di "modo obra ' + m.clientName + '" para ver el estado completo, o "factura ' + m.clientName + '" para facturar._'
    ];
    return lines.join('\n');
  }

  // Múltiples coincidencias
  const lines = [
    `🔍 *Encontré ${matches.length} coincidencias para "${clientName}":*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];
  matches.slice(0, 5).forEach((m, i) => {
    const statusEmoji = { 'PENDIENTE_ACEPTACION': '⏳', 'ACEPTADO': '✅', 'FIRMADO': '✍️', 'FINALIZADO': '🏁', 'CANCELADO': '❌', 'PERDIDO': '❌' }[m.status] || '📋';
    lines.push(`*${i + 1}.* ${statusEmoji} *${m.clientName}* · ${fmt(m.totalAmount)} € · ${m.id}`);
    lines.push(`    📍 ${m.clientAddress || 'Sin dirección'}`);
  });
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 _Di el número o el nombre exacto para ver los detalles._');

  return lines.join('\n');
}

/** Formatea el dashboard global */
function formatDashboard(data) {
  const now = new Date();
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const monthName = monthNames[now.getMonth()];

  const lines = [
    `📊 *Dashboard de PresuVoz*`,
    `_${now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}_`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
  ];

  // Hoy en la agenda
  if (data.todayAppointments && data.todayAppointments.length > 0) {
    lines.push(`📅 *Hoy tienes ${data.todayAppointments.length} cita${data.todayAppointments.length > 1 ? 's' : ''}:*`);
    data.todayAppointments.forEach(a => {
      lines.push(`   • ${a.clientName} a las ${a.time}${a.clientAddress ? ' — ' + a.clientAddress : ''}`);
    });
  } else {
    lines.push('📅 Hoy sin citas programadas');
  }

  // Deudas
  if (data.totalDebt > 0) {
    lines.push(`💸 Pendiente de cobrar: *${fmt(data.totalDebt)} €* (${data.debtCount} factura${data.debtCount > 1 ? 's' : ''})`);
  } else {
    lines.push('💸 Cobros: ✅ Todo al día');
  }

  // Presupuestos pendientes de firma
  if (data.pendingBudgets > 0) {
    lines.push(`⏳ Presupuestos sin firma: *${data.pendingBudgets}*`);
  }

  // Mes actual
  if (data.monthlyStats && data.monthlyStats.invoiceCount > 0) {
    lines.push('');
    lines.push(`📈 *${monthName}:* ${fmt(data.monthlyStats.totalInvoiced)} € facturados · ${fmt(data.monthlyStats.totalCollected)} € cobrados`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 _Di "resumen mes", "quién me debe" o "agenda" para más detalles._');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLVEDOR DE INTENCIONES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta la intención detectada consultando la base de datos y devuelve la respuesta formateada.
 * @param {{ intent: string, params: object }} intentResult
 * @param {string} phone - Teléfono de la empresa (limpio, solo dígitos)
 * @param {object} session - Sesión en memoria del profesional
 * @returns {Promise<string|null>} - Texto para enviar por WhatsApp, o null si no pudo resolver
 */
export async function resolveIntent(intentResult, phone, session) {
  const { intent, params } = intentResult;
  const cleanPhone = String(phone).replace(/\D/g, '');
  const tenantContext = session?.authContext || (session?.companyId ? { companyId: session.companyId, phone: cleanPhone } : cleanPhone);

  try {
    switch (intent) {

      case 'CANCEL_BUDGET': {
        const { targetQuery } = params;
        if (!targetQuery) {
          return '⚠️ *No entendí qué presupuesto deseas cancelar.*\n\nIndica el nombre del cliente o la referencia de la obra (ej: *"cancela el presupuesto de María"* o *"marca como perdido el PRE2026-001"*).';
        }

        // 1. Comprobar si coincide con un ID de presupuesto exacto (ej: PRE2026-001 o PRE-...)
        let resolvedBudget = null;
        try {
          const direct = getBudget(tenantContext, targetQuery.toUpperCase());
          if (direct) resolvedBudget = direct;
        } catch (_) {}

        // 2. Si no es por ID exacto, buscar por nombre de cliente o dirección en BD
        if (!resolvedBudget) {
          const candidates = findClientsByName(tenantContext, targetQuery);
          if (candidates.length === 1) {
            resolvedBudget = getBudget(tenantContext, candidates[0].id) || candidates[0];
          } else if (candidates.length > 1) {
            // Filtrar solo los que NO estén ya cancelados si hay varios
            const nonFinalized = candidates.filter(c => c.status !== 'CANCELADO' && c.status !== 'PERDIDO');
            if (nonFinalized.length === 1) {
              resolvedBudget = getBudget(tenantContext, nonFinalized[0].id) || nonFinalized[0];
            } else {
              const lines = [
                `⚠️ *Encontré varios presupuestos para "${targetQuery}":*`,
                '━━━━━━━━━━━━━━━━━━━━━━━━━'
              ];
              const listToUse = nonFinalized.length > 0 ? nonFinalized : candidates;
              listToUse.slice(0, 5).forEach((c, idx) => {
                lines.push(`*${idx + 1}.* *${c.clientName}* (${fmt(c.totalAmount)} €) — Referencia: ${c.id}`);
              });
              lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
              lines.push('💡 _Dime el número exacto de presupuesto que deseas cancelar (ej: "cancela ' + listToUse[0].id + '")._');
              return lines.join('\n');
            }
          }
        }

        // 3. Si aún no se resolvió, buscar en sesión RAM
        if (!resolvedBudget && session?.budgets) {
          for (const [id, b] of session.budgets.entries()) {
            const bName = norm(b.client?.name || '');
            const qNorm = norm(targetQuery);
            if (bName.includes(qNorm) || id.toLowerCase() === qNorm) {
              resolvedBudget = b;
              break;
            }
          }
        }

        if (!resolvedBudget) {
          return `🔍 No encontré ningún presupuesto activo para *"${targetQuery}"*.\n\n💡 _Di "mis presupuestos" para ver la lista de obras o indica el número exacto (ej: "cancela PRE2026-001")._`;
        }

        // 4. Actualizar estado a CANCELADO en SQLite y sesión
        updateBudgetStatus(tenantContext, resolvedBudget.id, 'CANCELADO');

        if (session?.budgets?.has(resolvedBudget.id)) {
          const inSess = session.budgets.get(resolvedBudget.id);
          inSess.status = 'CANCELADO';
        }

        const clientName = resolvedBudget.client?.name || resolvedBudget.clientName || 'Cliente';
        const total = resolvedBudget.financials?.totalAmount || resolvedBudget.totalAmount || 0;

        return [
          `❌ *Presupuesto ${resolvedBudget.id} marcado como cancelado*`,
          '━━━━━━━━━━━━━━━━━━━━━━━━━',
          `👤 *Cliente:* ${clientName}`,
          total > 0 ? `💰 *Importe:* *${fmt(total)} €*` : null,
          '',
          `📌 _Ya no aparecerá en tus presupuestos pendientes de firma ni recibirás avisos de seguimiento para esta obra._`
        ].filter(Boolean).join('\n');
      }

      case 'FISCAL_QUARTER_SUMMARY': {
        if (!isGestoriaEnabled()) {
          return 'ℹ️ *Cierre fiscal no disponible*\n\nEl módulo de cierre fiscal oficial está desactivado en esta versión.\n\n💡 _Para consultar tus cobros o facturas, puedes pedir por ejemplo: *«cuánto he facturado este mes»* o *«ver facturas»*._';
        }
        const { quarter, year } = params;
        return formatQuarterWhatsAppSummary(tenantContext, year, quarter);
      }

      case 'SEND_TO_GESTORIA': {
        if (!isGestoriaEnabled()) {
          return 'ℹ️ *Módulo de Gestoría no disponible*\n\nEl servicio de envío a gestorías está desactivado en esta versión.';
        }
        const { quarter, year } = params;
        const quarterData = getQuarterSummary(tenantContext, year, quarter);
        const company = session?.companyId ? getCompanyById(session.companyId) : getCompany(cleanPhone);
        if (!company?.gestoriaEmail) {
          return '⚠️ *No tienes configurado el correo de tu gestoría.*\n\nEscribe *"mi gestoría es correo@ejemplo.com"* para registrarlo y poder enviar los libros oficiales.';
        }
        return `🔒 *Confirmación de seguridad requerida (Nivel C):*\n\nVas a enviar por correo electrónico el paquete oficial de cierre de *${quarterData.period.label}* a tu gestoría en *${company.gestoriaEmail}* con los libros de IVA, IRPF, incidencias y PDF.\n\nPor favor, responde *"CONFIRMAR"* para proceder o *"CANCELAR"* para descartar.`;
      }

      case 'DASHBOARD': {
        const data = getDashboard(tenantContext);
        return formatDashboard(data);
      }

      case 'PENDING_TO_INVOICE': {
        const { clientName } = params;
        const candidates = clientName ? findClientsByName(tenantContext, clientName) : [];
        if (candidates.length === 1) {
          const summary = getProjectBillingSummary(tenantContext, candidates[0].id);
          if (!summary) {
            return `🔍 No se encontraron datos de facturación para *"${clientName}"*.`;
          }
          const formatEur = (n) => `${Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
          return [
            `📑 *ESTADO DE FACTURACIÓN — ${summary.clientName.toUpperCase()}*`,
            '━━━━━━━━━━━━━━━━━━━━━━━━━',
            `💰 *Presupuesto acordado:* *${formatEur(summary.budgetTotal)}*`,
            `🧾 *Total facturado hasta la fecha:* *${formatEur(summary.workInvoiced)}* (${summary.invoices.length} ${summary.invoices.length === 1 ? 'factura emitida' : 'facturas emitidas'})` + (summary.advanceInvoiced > 0 ? ` [Anticipos: ${formatEur(summary.advanceInvoiced)}]` : ''),
            `⏳ *Importe pendiente de facturar:* *${formatEur(summary.pendingToInvoice)}*`,
            '━━━━━━━━━━━━━━━━━━━━━━━━━',
            `💵 *Cobros recibidos:* ${formatEur(summary.totalPaid)}`,
            `📌 *Saldo pendiente de cobro:* *${formatEur(summary.pendingToCollect)}*`,
            '',
            summary.pendingToInvoice > 0
              ? '💡 _Puedes emitir la factura de una fase diciendo: "Factura la fase de [concepto]" o la factura final diciendo: "Prepárame la factura final"._'
              : '✅ _Toda la obra ha sido completamente facturada._'
          ].join('\n');
        } else if (candidates.length > 1) {
          return formatDisambiguationPrompt(clientName, candidates, 'query_balance');
        } else if (clientName) {
          return `🔍 No encontré ningún presupuesto registrado para *"${clientName}"*.`;
        } else {
          // Listado general de obras con facturación pendiente
          const allBudgets = listBudgets(tenantContext, 50).filter(b => b.status === 'ACEPTADO' || b.status === 'FIRMADO');
          const pendingList = allBudgets.map(b => getProjectBillingSummary(tenantContext, b.id)).filter(s => s && s.pendingToInvoice > 0.01);
          if (pendingList.length === 0) {
            return '✅ *No tienes importes pendientes de facturar en tus obras aceptadas.*';
          }
          const formatEur = (n) => `${Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
          const lines = [
            '📑 *OBRAS CON FACTURACIÓN PENDIENTE:*',
            '━━━━━━━━━━━━━━━━━━━━━━━━━'
          ];
          for (const p of pendingList) {
            lines.push(`• *${p.clientName}*: Pendiente de facturar: *${formatEur(p.pendingToInvoice)}* (Presupuesto: ${formatEur(p.budgetTotal)})`);
          }
          return lines.join('\n');
        }
      }

      case 'ALL_DEBTS': {
        const unpaid = getUnpaidInvoices(tenantContext);
        const pendingWorks = getPendingWorksDebt(tenantContext);
        return formatAllDebts(unpaid, pendingWorks);
      }

      case 'DEBT_BY_CLIENT': {
        const { clientName, addressHint } = params;
        let candidates = findClientsByName(tenantContext, clientName);

        // Si hay homónimos y se especificó una pista de dirección o ubicación (ej: "el de la calle Rapuncel", "el de obra según visita")
        if (candidates && candidates.length > 1 && addressHint) {
          const normHint = norm(addressHint);
          const filtered = candidates.filter(c => {
            const cAddr = norm(c.clientAddress || c.address || '');
            if (cAddr && (cAddr.includes(normHint) || normHint.includes(cAddr))) return true;
            if ((normHint.includes('obra segun visita') || normHint.includes('sin direccion') || normHint.includes('visita')) &&
                (!cAddr || cAddr.includes('sin direccion') || cAddr.includes('obra segun visita'))) {
              return true;
            }
            const hintTokens = normHint.split(/[\s,.-]+/).filter(w => w.length > 2 && !['el', 'la', 'los', 'las', 'de', 'del', 'en', 'calle', 'avenida', 'avda', 'obra', 'segun'].includes(w));
            if (hintTokens.length > 0 && hintTokens.some(tok => cAddr.includes(tok))) {
              return true;
            }
            return false;
          });
          if (filtered.length > 0) {
            candidates = filtered;
          }
        }

        // Si hay homónimos (más de 1 candidato), activar desambiguación interactiva con desglose de deudas (HIGH-01)
        if (candidates && candidates.length > 1) {
          for (const c of candidates) {
            const work = getWorkMemory(tenantContext, c.id);
            c.totalPaid = work?.totalPaid || 0;
            c.remainingBalance = work?.remainingBalance ?? Math.max(0, (c.totalAmount || 0) - c.totalPaid);
          }
          if (session) {
            session.pendingDisambiguation = {
              actionType: 'query_balance',
              clientQuery: clientName,
              candidates,
              originalPayload: { clientName }
            };
          }
          return formatDisambiguationPrompt(clientName, candidates, 'query_balance');
        }

        const allUnpaid = getUnpaidInvoices(tenantContext);
        const qNorm = norm(clientName);
        const clientMatches = allUnpaid.filter(inv =>
          norm(inv.clientName).includes(qNorm) || qNorm.includes(norm(inv.clientName))
        );

        // Si no existe ningún presupuesto/cliente ni factura impagada (HIGH-02: nunca decir falsamente "todo cobrado")
        if ((!candidates || candidates.length === 0) && clientMatches.length === 0) {
          return `🔍 No encontré ningún cliente ni presupuesto para *"${clientName}"*.\n\n💡 _Verifica el nombre o di "mis presupuestos" para ver la lista de obras registradas._`;
        }

        const resolvedCandidate = candidates && candidates.length === 1 ? candidates[0] : null;
        const effectiveName = resolvedCandidate ? resolvedCandidate.clientName : (clientMatches[0]?.clientName || clientName);
        const work = getWorkMemory(tenantContext, resolvedCandidate?.id || clientName);

        return formatDebtByClient(effectiveName, clientMatches, resolvedCandidate, work);
      }

      case 'MONTHLY_STATS':
      case 'QUARTER_STATS':
      case 'FOUR_MONTH_STATS':
      case 'WEEKLY_REVENUE':
      case 'DAILY_REVENUE':
      case 'YEARLY_STATS':
      case 'REVENUE_STATS': {
        const stats = getPeriodRevenue(tenantContext, params);
        return formatPeriodRevenue(stats, params);
      }

      case 'WEEKLY_AGENDA': {
        const apts = listAppointmentsWeek(tenantContext);
        return formatWeeklyAgenda(apts);
      }

      case 'BUDGET_STATS': {
        const budgets = listBudgets(tenantContext, 50);
        return formatBudgetStats(budgets);
      }

      case 'WORK_STATUS': {
        const { clientName } = params;
        const work = getWorkMemory(tenantContext, clientName);
        if (!work) {
          // No encontrado → no resolver aquí, dejar que Gemini maneje o dar feedback claro
          const suggestions = findClientsByName(tenantContext, clientName);
          if (suggestions.length > 0) {
            return formatClientLookup(clientName, suggestions);
          }
          return null; // Dejar pasar a Gemini por si hay más contexto
        }
        return formatWorkStatus(work);
      }

      case 'CLIENT_LOOKUP': {
        const { clientName } = params;
        const found = findClientsByName(tenantContext, clientName);
        if (found.length === 0) return null; // Dejar pasar a Gemini — quizás el usuario quiere crear algo
        return formatClientLookup(clientName, found);
      }

      case 'SET_BIZUM': {
        const { bizum } = params;
        const updated = saveCompany(tenantContext, { bizum });
        if (session) session.company = updated;
        return `✅ *¡Bizum actualizado con éxito!*\n\n📱 *Bizum configurado:* ${updated.bizum}\n\nTus clientes verán este número en las condiciones de pago de tus presupuestos y recibos.`;
      }

      case 'SET_IBAN': {
        const { iban } = params;
        const updated = saveCompany(tenantContext, { iban });
        if (session) session.company = updated;
        return `✅ *¡IBAN bancario actualizado con éxito!*\n\n🏦 *IBAN configurado:* ${updated.iban}\n\nTus facturas y presupuestos oficiales incluirán esta cuenta bancaria.`;
      }

      case 'SHOW_COMPANY': {
        const comp = getCompany(tenantContext);
        return [
          '🏢 *DATOS DE TU EMPRESA / PERFIL:*',
          '━━━━━━━━━━━━━━━━━━━━━━━━━',
          `🛠️ *Oficio / Especialidad:* ${comp.trade || 'No indicado'}`,
          `📛 *Empresa:* ${comp.name || 'No indicado'}`,
          `🆔 *CIF:* ${comp.cif || 'No indicado'}`,
          `📍 *Dirección:* ${comp.address || 'No indicada'}`,
          `🏦 *IBAN:* ${comp.iban || 'No configurado'}`,
          `📱 *Bizum:* ${comp.bizum || 'No configurado'}`,
          `📞 *Teléfono:* ${comp.phone || 'No indicado'}`,
          `✉️ *Email:* ${comp.email || 'No indicado'}`,
          comp.gestoriaEmail && isGestoriaEnabled() ? `📊 *Gestoría:* ${comp.gestoriaEmail}` : '',
          '━━━━━━━━━━━━━━━━━━━━━━━━━',
          '💡 _Puedes cambiar cualquier dato diciendo por ejemplo: "mi Bizum es 611223344" o "cambia mi IBAN a ES21..."_'
        ].filter(Boolean).join('\n');
      }

      default:
        return null;
    }
  } catch (err) {
    console.error(`[IntentRouter] Error resolviendo intención ${intent}:`, err.message);
    return null; // En caso de error, dejar pasar a Gemini
  }
}
