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
  listBudgets,
  listAppointments,
  findClientsByName,
  getWorkMemory,
  getMonthlyRevenue,
  listAppointmentsWeek,
  getDashboard,
  getCompany,
  saveCompany
} from './db_service.js';

import {
  getQuarterSummary,
  formatQuarterWhatsAppSummary
} from './fiscal_service.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR DE INTENCIONES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analiza el texto del mensaje y determina si puede resolverse determinísticamente.
 * @param {string} text - Mensaje del profesional
 * @returns {{ intent: string, params: object } | null}
 */
export function detectIntent(text) {
  if (!text || typeof text !== 'string') return null;
  const n = norm(text);

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

  // ── DEUDAS TOTALES ─────────────────────────────────────────────────────────
  // "quién me debe", "qué me deben", "deudas pendientes", "cobros pendientes"
  if (matches(n, [
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

  // ── DEUDA DE UN CLIENTE CONCRETO ──────────────────────────────────────────
  // "cuánto me debe Juan", "deuda de García", "qué me debe María"
  const debtClientMatch = n.match(
    /(?:cuanto\s+me\s+debe|que\s+me\s+debe|deuda\s+(?:de|del?)|debe\s+(?:el|la)?)\s+(\w[\w\s]{1,30}?)(?:\s*$|\?|,|\.)/ 
  );
  if (debtClientMatch && debtClientMatch[1]) {
    const clientName = debtClientMatch[1].trim();
    // Evitar falsos positivos con palabras clave como "dinero", "total", "todo"
    if (!/^(?:dinero|total|todo|algo|cobrar|pagar|euros?)$/.test(clientName)) {
      return { intent: 'DEBT_BY_CLIENT', params: { clientName } };
    }
  }

  // ── ESTADÍSTICAS MENSUALES ────────────────────────────────────────────────
  // "cuánto llevo este mes", "facturado en septiembre", "ingresos de julio"
  if (matches(n, [
    /cuanto\s+llevo\s+(?:este\s+mes|en\s+|facturado)/,
    /facturado\s+(?:en|este|el)/,
    /ingresos?\s+(?:de|del|este|en)/,
    /cuanto\s+he\s+(?:facturado|cobrado|ganado)/,
    /resumen\s+(?:de\s+)?(?:este|el)?\s*mes/,
    /estadisticas?\s+(?:de\s+)?(?:este|el)?\s*mes/,
    /cuanto\s+money\s+(?:tengo|llevo)/,
    /cuanto\s+he\s+hecho\s+(?:este\s+mes|en)/,
  ])) {
    const { month, year } = extractMonthYear(text);
    return { intent: 'MONTHLY_STATS', params: { month, year } };
  }

  // ── AGENDA SEMANAL ────────────────────────────────────────────────────────
  // "qué tengo esta semana", "visitas de esta semana", "próximas citas"
  if (matches(n, [
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
function formatAllDebts(unpaidInvoices) {
  if (!unpaidInvoices || unpaidInvoices.length === 0) {
    return '✅ *¡Todo al día!* No tienes facturas pendientes de cobro ahora mismo. 💪';
  }

  const totalDebt = unpaidInvoices.reduce((sum, inv) => {
    const invoiceData = inv.invoice;
    const total = inv.totalAmount || 0;
    const advance = invoiceData?.financials?.advanceAmount || 0;
    const remaining = invoiceData?.financials?.remainingAmount ?? Math.max(0, total - advance);
    return sum + remaining;
  }, 0);

  const lines = [
    `💸 *Cobros pendientes (${unpaidInvoices.length} factura${unpaidInvoices.length !== 1 ? 's' : ''})*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  for (const inv of unpaidInvoices) {
    const invoiceData = inv.invoice;
    const total = inv.totalAmount || 0;
    const advance = invoiceData?.financials?.advanceAmount || 0;
    const remaining = invoiceData?.financials?.remainingAmount ?? Math.max(0, total - advance);
    const daysLabel = inv.daysPending > 0 ? ` · _${inv.daysPending} días_` : '';
    lines.push(`👤 *${inv.clientName}* — pendiente: *${fmt(remaining)} €*${daysLabel}`);
    lines.push(`   📄 ${inv.id}`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`💰 *Total pendiente de cobrar: ${fmt(totalDebt)} €*`);
  lines.push('');
  lines.push('💡 _Di "factura Juan" para emitir, o "cobro 500 Juan" para registrar un pago._');

  return lines.join('\n');
}

/** Formatea la deuda de un cliente concreto */
function formatDebtByClient(clientName, unpaidInvoices, allMatches) {
  if (!allMatches || allMatches.length === 0) {
    return `✅ *${clientName}* no tiene ninguna factura pendiente contigo. ¡Todo cobrado!`;
  }

  const totalDebt = allMatches.reduce((sum, inv) => {
    const invoiceData = inv.invoice;
    const total = inv.totalAmount || 0;
    const advance = invoiceData?.financials?.advanceAmount || 0;
    const remaining = invoiceData?.financials?.remainingAmount ?? Math.max(0, total - advance);
    return sum + remaining;
  }, 0);

  const lines = [
    `💸 *Deuda de ${allMatches[0].clientName}*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  for (const inv of allMatches) {
    const invoiceData = inv.invoice;
    const total = inv.totalAmount || 0;
    const advance = invoiceData?.financials?.advanceAmount || 0;
    const remaining = invoiceData?.financials?.remainingAmount ?? Math.max(0, total - advance);
    lines.push(`📄 ${inv.id} · Total: ${fmt(total)} € · Anticipo: ${fmt(advance)} € · *Pendiente: ${fmt(remaining)} €*`);
    if (inv.daysPending > 0) lines.push(`   ⏱️ Lleva ${inv.daysPending} días sin pagar`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`💰 *Total que te debe: ${fmt(totalDebt)} €*`);

  return lines.join('\n');
}

/** Formatea estadísticas mensuales */
function formatMonthlyStats(stats, month, year) {
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const monthName = monthNames[month - 1] || `Mes ${month}`;

  if (!stats || stats.invoiceCount === 0) {
    return `📊 *${monthName} ${year}* — No tienes facturas emitidas este mes todavía.`;
  }

  const lines = [
    `📊 *Resumen de ${monthName} ${year}*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `📄 Facturas emitidas: *${stats.invoiceCount}*`,
    `💵 Total facturado: *${fmt(stats.totalInvoiced)} €*`,
    `✅ Total cobrado: *${fmt(stats.totalCollected)} €*`,
    `⏳ Pendiente de cobrar: *${fmt(stats.totalPending)} €*`,
  ];

  if (stats.budgetCount > 0) {
    lines.push(`📋 Presupuestos creados: *${stats.budgetCount}*`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');

  const pct = stats.totalInvoiced > 0
    ? Math.round((stats.totalCollected / stats.totalInvoiced) * 100)
    : 0;
  lines.push(`📈 Cobrado: *${pct}%* del total facturado`);

  return lines.join('\n');
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
      const statusEmoji = { 'PENDIENTE_ACEPTACION': '⏳', 'ACEPTADO': '✅', 'FIRMADO': '✍️', 'FINALIZADO': '🏁', 'ENVIADO': '📤' }[b.status] || '📋';
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
    const statusEmoji = { 'PENDIENTE_ACEPTACION': '⏳', 'ACEPTADO': '✅', 'FIRMADO': '✍️', 'FINALIZADO': '🏁', 'ENVIADO': '📤' }[m.status] || '📋';
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
    const statusEmoji = { 'PENDIENTE_ACEPTACION': '⏳', 'ACEPTADO': '✅', 'FIRMADO': '✍️', 'FINALIZADO': '🏁' }[m.status] || '📋';
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

  try {
    switch (intent) {

      case 'FISCAL_QUARTER_SUMMARY': {
        const { quarter, year } = params;
        return formatQuarterWhatsAppSummary(cleanPhone, year, quarter);
      }

      case 'SEND_TO_GESTORIA': {
        const { quarter, year } = params;
        const quarterData = getQuarterSummary(cleanPhone, year, quarter);
        const company = getCompany(cleanPhone);
        if (!company.gestoriaEmail) {
          return '⚠️ *No tienes configurado el correo de tu gestoría.*\n\nEscribe *"mi gestoría es correo@ejemplo.com"* para registrarlo y poder enviar los libros oficiales.';
        }
        return `🔒 *Confirmación de seguridad requerida (Nivel C):*\n\nVas a enviar por correo electrónico el paquete oficial de cierre de *${quarterData.period.label}* a tu gestoría en *${company.gestoriaEmail}* con los libros de IVA, IRPF, incidencias y PDF.\n\nPor favor, responde *"CONFIRMAR"* para proceder o *"CANCELAR"* para descartar.`;
      }

      case 'DASHBOARD': {
        const data = getDashboard(cleanPhone);
        return formatDashboard(data);
      }

      case 'ALL_DEBTS': {
        const unpaid = getUnpaidInvoices(cleanPhone);
        return formatAllDebts(unpaid);
      }

      case 'DEBT_BY_CLIENT': {
        const { clientName } = params;
        const allUnpaid = getUnpaidInvoices(cleanPhone);
        const qNorm = norm(clientName);
        const clientMatches = allUnpaid.filter(inv =>
          norm(inv.clientName).includes(qNorm) || qNorm.includes(norm(inv.clientName))
        );
        return formatDebtByClient(clientName, allUnpaid, clientMatches);
      }

      case 'MONTHLY_STATS': {
        const { month, year } = params;
        const stats = getMonthlyRevenue(cleanPhone, year, month);
        return formatMonthlyStats(stats, month, year);
      }

      case 'WEEKLY_AGENDA': {
        const apts = listAppointmentsWeek(cleanPhone);
        return formatWeeklyAgenda(apts);
      }

      case 'BUDGET_STATS': {
        const budgets = listBudgets(cleanPhone, 50);
        return formatBudgetStats(budgets);
      }

      case 'WORK_STATUS': {
        const { clientName } = params;
        const work = getWorkMemory(cleanPhone, clientName);
        if (!work) {
          // No encontrado → no resolver aquí, dejar que Gemini maneje o dar feedback claro
          const suggestions = findClientsByName(cleanPhone, clientName);
          if (suggestions.length > 0) {
            return formatClientLookup(clientName, suggestions);
          }
          return null; // Dejar pasar a Gemini por si hay más contexto
        }
        return formatWorkStatus(work);
      }

      case 'CLIENT_LOOKUP': {
        const { clientName } = params;
        const found = findClientsByName(cleanPhone, clientName);
        if (found.length === 0) return null; // Dejar pasar a Gemini — quizás el usuario quiere crear algo
        return formatClientLookup(clientName, found);
      }

      case 'SET_BIZUM': {
        const { bizum } = params;
        const updated = saveCompany(cleanPhone, { bizum });
        if (session) session.company = updated;
        return `✅ *¡Bizum actualizado con éxito!*\n\n📱 *Bizum configurado:* ${updated.bizum}\n\nTus clientes verán este número en las condiciones de pago de tus presupuestos y recibos.`;
      }

      case 'SET_IBAN': {
        const { iban } = params;
        const updated = saveCompany(cleanPhone, { iban });
        if (session) session.company = updated;
        return `✅ *¡IBAN bancario actualizado con éxito!*\n\n🏦 *IBAN configurado:* ${updated.iban}\n\nTus facturas y presupuestos oficiales incluirán esta cuenta bancaria.`;
      }

      case 'SHOW_COMPANY': {
        const comp = getCompany(cleanPhone);
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
          comp.gestoriaEmail ? `📊 *Gestoría:* ${comp.gestoriaEmail}` : '',
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
