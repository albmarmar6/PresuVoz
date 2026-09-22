/**
 * PresuVoz — Secretary & Permission Engine
 * Módulo de Secretario Digital Proactivo y Control de Permisos Multinivel (A, B y C).
 */

import {
  listAppointments,
  getUnpaidInvoices,
  getBudgetsPendingFollowUp,
  getCompany,
  listShoppingItems
} from './db_service.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Matriz de Niveles de Permiso
// ─────────────────────────────────────────────────────────────────────────────

export const PERMISSION_LEVELS = {
  A: {
    id: 'A',
    name: 'Automático',
    description: 'Acciones de lectura, notas internas y borradores (ejecución sin confirmación)'
  },
  B: {
    id: 'B',
    name: 'Confirmación Simple',
    description: 'Redacción de propuestas para clientes (para copiar y pegar), exportaciones y compras'
  },
  C: {
    id: 'C',
    name: 'Confirmación Fuerte',
    description: 'Cancelaciones, modificaciones de facturas emitidas y acciones financieras'
  }
};

/**
 * Clasifica cualquier acción en su respectivo nivel de permiso
 * @param {string} actionType
 * @returns {'A' | 'B' | 'C'}
 */
export function classifyActionPermission(actionType) {
  switch (actionType) {
    // Nivel A — Puede hacerlo automáticamente
    case 'query_info':
    case 'list_budgets':
    case 'show_company':
    case 'list_appointments':
    case 'query_balance':
    case 'create_note':
    case 'draft_budget':
    case 'daily_briefing':
    case 'add_shopping_items':
    case 'list_shopping_items':
    case 'mark_shopping_items':
    case 'query_work_status':
    case 'update_work_task':
    case 'update_work_dates':
    case 'rename_client':
    case 'disambiguate_client':
      return 'A';

    // Nivel B — Pedir confirmación simple
    case 'send_client_reminder':
    case 'send_budget':
    case 'send_invoice':
    case 'send_signing_link':
    case 'schedule_appointment':
    case 'export_quarter_email':
    case 'clear_shopping_list':
    case 'finalize_work_project':
      return 'B';

    // Nivel C — Confirmación fuerte
    case 'cancel_appointment':
    case 'modify_invoice':
    case 'register_payment_manual':
    case 'delete_data':
    case 'refund':
    case 'financial_action':
      return 'C';

    default:
      return 'B';
  }
}

/**
 * Crea un objeto estandarizado de acción pendiente con caducidad
 */
export function createProposedAction(level, type, data = {}, promptText = '') {
  return {
    id: `act_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    level, // 'B' o 'C'
    type,
    data,
    promptText,
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000 // 15 minutos
  };
}

/**
 * Evalúa si el texto del usuario aprueba, rechaza o ignora una acción pendiente
 * @param {object} pendingAction
 * @param {string} userText
 * @returns {{ status: 'APPROVED' | 'REJECTED' | 'NEED_STRONG_CONFIRMATION' | 'IGNORED' }}
 */
export function evaluateConfirmationResponse(pendingAction, userText = '') {
  if (!pendingAction || !userText) return { status: 'IGNORED' };

  const raw = userText.trim().toLowerCase();

  // Comprobar si ha expirado
  if (Date.now() > pendingAction.expiresAt) {
    return { status: 'IGNORED' };
  }

  // Rechazo universal para cualquier nivel
  if (/^(?:no|cancelar?|descarta|espera|d[eé]jalo|parar|ahora\s+no|olv[ií]dalo)$/i.test(raw)) {
    return { status: 'REJECTED' };
  }

  if (pendingAction.level === 'B') {
    // Aprobación simple Nivel B
    if (/^(?:s[ií]|adelante|confirmo|confirmar|m[aá]ndalo|m[aá]ndaselo|hazlo|ok|vale|procede|dale|claro|por\s+favor|env[ií]alo|s[ií]\s+por\s+favor)$/i.test(raw)) {
      return { status: 'APPROVED' };
    }
    return { status: 'IGNORED' };
  }

  if (pendingAction.level === 'C') {
    // Confirmación fuerte Nivel C: requiere palabras explícitas
    if (/^(?:confirmar|confirmo|s[ií],?\s*confirmar|s[ií],?\s*cancelar|s[ií],?\s*eliminar|s[ií],?\s*modificar|proceder|confirmado)$/i.test(raw)) {
      return { status: 'APPROVED' };
    }
    // Si da una respuesta débil como "sí" o "ok", exigimos confirmación explícita para evitar accidentes
    if (/^(?:s[ií]|ok|vale|dale|adelante|hazlo)$/i.test(raw)) {
      return { status: 'NEED_STRONG_CONFIRMATION' };
    }
    return { status: 'IGNORED' };
  }

  return { status: 'IGNORED' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Generador del Briefing Matinal y Recordatorios
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera el Briefing Matinal Diario con formato de secretario digital
 * @param {string} phone
 * @returns {string} Mensaje formateado para WhatsApp
 */
export function generateDailyBriefing(phone) {
  const company = getCompany(phone);
  let greetingTarget = '';
  if (company.name && company.isConfigured) {
    const firstWord = company.name.split(' ')[0].trim();
    if (!/^(?:reformas|construcc|instalac|carpinter|pintur|fontaner|electri|servicios|multiservicios|sl|s\.l\.)$/i.test(firstWord)) {
      greetingTarget = `, ${firstWord}`;
    } else {
      greetingTarget = ` (${company.name})`;
    }
  }

  // 1. Citas del día
  const todayAppointments = listAppointments(phone, 'today');

  // 2. Facturas pendientes de cobro
  const unpaidInvoices = getUnpaidInvoices(phone);
  const totalUnpaid = unpaidInvoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);

  // 3. Presupuestos sin respuesta (>= 2 días)
  const pendingBudgets = getBudgetsPendingFollowUp(phone);
  const coldBudgets = pendingBudgets.filter(b => b.daysWaiting >= 2);

  const lines = [
    `☀️ *Buenos días${greetingTarget}.*`,
    '',
    '📋 *Hoy tienes en tu agenda:*'
  ];

  if (todayAppointments.length > 0) {
    todayAppointments.forEach(app => {
      const client = app.clientName || 'Cliente';
      const notes = app.notes || 'Visita técnica';
      lines.push(`🕒 *${app.time}* — ${notes} — *${client}*`);
    });
  } else {
    lines.push('ℹ️ _No tienes visitas técnicas programadas para hoy._');
  }

  lines.push('');

  // Bloque de facturas pendientes
  if (unpaidInvoices.length > 0) {
    const formattedTotal = totalUnpaid.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const countLabel = unpaidInvoices.length === 1 ? '1 factura pendiente' : `${unpaidInvoices.length} facturas pendientes`;
    lines.push(`💰 Tienes *${countLabel} de cobro*, por un total de *${formattedTotal} €*.`);
  } else {
    lines.push('✅ Al día: _Todas tus facturas emitidas están cobradas._');
  }

  // Bloque de presupuestos en espera
  if (coldBudgets.length > 0) {
    const mostUrgent = coldBudgets[0];
    const client = mostUrgent.clientName.split(' ')[0];
    lines.push(`⚠️ El presupuesto de *${client}* lleva *${mostUrgent.daysWaiting} días* sin respuesta.`);
  }

  // Bloque de materiales pendientes de compra
  const pendingShopping = listShoppingItems(phone, 'pending');
  if (pendingShopping.length > 0) {
    lines.push('');
    lines.push(`🛒 *Materiales pendientes de compra (${pendingShopping.length}):*`);
    pendingShopping.slice(0, 5).forEach(item => {
      const qtyUnit = item.qty && item.unit ? `${item.qty} ${item.unit} ` : '';
      const clientTag = item.clientName ? ` _(Obra: ${item.clientName})_` : '';
      lines.push(`   • ${qtyUnit}${item.description}${clientTag}`);
    });
    if (pendingShopping.length > 5) {
      lines.push(`   • _...y ${pendingShopping.length - 5} materiales más (di "lista de la compra")_`);
    }
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('¿Quieres que haga algo por ti?');

  return lines.join('\n');
}

/**
 * Genera el recordatorio de visitas de la víspera (para el día siguiente)
 * @param {string} phone
 * @returns {string|null}
 */
export function generateEveningReminder(phone) {
  const tomorrowApps = listAppointments(phone, 'tomorrow');
  if (!tomorrowApps || tomorrowApps.length === 0) return null;

  const lines = [
    '📋 *RECORDATORIO PARA MAÑANA:*',
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Tienes *${tomorrowApps.length} visita${tomorrowApps.length === 1 ? '' : 's'} técnica${tomorrowApps.length === 1 ? '' : 's'} programada${tomorrowApps.length === 1 ? '' : 's'}*:`
  ];

  tomorrowApps.forEach((app, idx) => {
    lines.push(`\n${idx + 1}️⃣ *${app.time} h* · ${app.clientName}`);
    if (app.clientAddress) lines.push(`   📍 ${app.clientAddress}`);
    if (app.notes) lines.push(`   📝 ${app.notes}`);
  });

  lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 _Te recordaré tu hoja de ruta completa mañana a las 08:00 AM._');

  return lines.join('\n');
}

function formatEurAmount(n) {
  const num = Number(n || 0);
  const parts = num.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${parts.join(',')} €`;
}

/**
 * Genera la propuesta de recordatorio o seguimiento comercial para presupuestos fríos
 * @param {object} budgetFollowUpItem
 * @returns {{ promptMessage: string, clientMessage: string, directWaUrl: string|null }}
 */
export function buildBudgetFollowUpProposal(budgetFollowUpItem) {
  const b = budgetFollowUpItem;
  const clientFirstName = b.clientName.split(' ')[0];
  const formattedTotal = formatEurAmount(b.totalAmount);

  const isOld = b.daysWaiting >= 5;
  const promptMessage = isOld
    ? `⚠️ *${b.clientName}* todavía no ha respondido al presupuesto de *${formattedTotal}* (${b.daysWaiting} días en espera).\n\n¿Quieres que te redacte un mensaje de seguimiento para que solo tengas que copiárselo y pegárselo?`
    : `📋 El presupuesto de *${b.clientName}* por *${formattedTotal}* todavía no ha sido aceptado (${b.daysWaiting} días).\n\n¿Quieres que te prepare un recordatorio redactado para enviárselo?`;

  const clientMessage = `Hola ${clientFirstName}, ¿qué tal? Te escribo para consultar si pudiste revisar el presupuesto que te enviamos para la obra (${formattedTotal}). Si tienes cualquier duda sobre las partidas o quieres que ajustemos algo, dímelo y lo vemos sin compromiso. ¡Un saludo!`;

  let directWaUrl = null;
  if (b.clientPhone) {
    const clean = String(b.clientPhone).replace(/\D/g, '');
    const intlPhone = clean.startsWith('34') ? clean : (clean.length === 9 ? `34${clean}` : clean);
    if (intlPhone.length >= 9) {
      directWaUrl = `https://wa.me/${intlPhone}?text=${encodeURIComponent(clientMessage)}`;
    }
  }

  return {
    promptMessage,
    clientMessage,
    directWaUrl
  };
}

/**
 * Genera la propuesta de cobro para facturas impagadas
 * @param {object} unpaidInvoiceItem
 * @param {object} company
 * @returns {{ promptMessage: string, clientMessage: string, directWaUrl: string|null }}
 */
export function buildInvoiceFollowUpProposal(unpaidInvoiceItem, company = {}) {
  const inv = unpaidInvoiceItem;
  const clientFirstName = inv.clientName.split(' ')[0];
  const formattedTotal = formatEurAmount(inv.totalAmount);

  const promptMessage = `💰 La factura *${inv.id}* de *${inv.clientName}* (${formattedTotal}) lleva *${inv.daysPending} días* pendiente de pago.\n\n¿Quieres que te prepare un mensaje de cortesía redactado para que solo tengas que copiárselo y pegárselo?`;

  const bankInfo = company.iban ? ` a la cuenta ${company.iban}` : (company.bizum ? ` por Bizum al ${company.bizum}` : '');
  const clientMessage = `Hola ${clientFirstName}, ¿qué tal? Te escribo porque queda pendiente el pago de ${formattedTotal} correspondiente a la factura ${inv.id}${bankInfo}. Cuando puedas, ¿me confirmas cuándo podrás realizar la transferencia? Muchas gracias.`;

  let directWaUrl = null;
  if (inv.clientPhone) {
    const clean = String(inv.clientPhone).replace(/\D/g, '');
    const intlPhone = clean.startsWith('34') ? clean : (clean.length === 9 ? `34${clean}` : clean);
    if (intlPhone.length >= 9) {
      directWaUrl = `https://wa.me/${intlPhone}?text=${encodeURIComponent(clientMessage)}`;
    }
  }

  return {
    promptMessage,
    clientMessage,
    directWaUrl
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Desambiguación de Clientes Homónimos y Avisos Preventivos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera el mensaje interactivo para desambiguar cuando hay varios clientes con el mismo nombre.
 */
export function formatDisambiguationPrompt(clientQuery, candidates) {
  const lines = [
    `🔍 *He encontrado ${candidates.length} clientes/obras para "${clientQuery}":*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  candidates.forEach((c, idx) => {
    const numEmoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][idx] || `${idx + 1}️⃣`;
    const totalStr = (Number(c.totalAmount) || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    lines.push(`${numEmoji} *${c.clientName}*`);
    lines.push(`   📍 ${c.clientAddress}`);
    lines.push(`   📁 Presupuesto: *${c.id}* · Importe: *${totalStr}*`);
  });

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('👉 *¿A cuál de los dos te refieres?*');
  lines.push(`Responde con el número (*1* o *${candidates.length}*) o el nombre de la calle.`);
  lines.push('');
  lines.push(`💡 _Consejo: Puedes añadirle un distintivo diciendo: "Renombrar el 1 a ${candidates[0]?.clientName || clientQuery} (Centro)"._`);

  return lines.join('\n');
}

/**
 * Genera la advertencia preventiva cuando se dicta un nuevo presupuesto para un cliente cuyo nombre ya existe.
 */
export function formatDuplicateClientWarning(clientName, newAddress, existingCandidates) {
  const lines = [
    `⚠️ *¡AVISO IMPORTANTE: Cliente con el mismo nombre detectado!*`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `Has creado una nueva obra para *${clientName}* en *${newAddress || 'nueva ubicación'}*, pero ya existen clientes con ese nombre en tu base de datos:`,
    ''
  ];

  existingCandidates.slice(0, 3).forEach((c) => {
    lines.push(`• Obra anterior: *${c.id}* — ${c.clientAddress} (${c.clientName})`);
  });

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 *Para evitar confusiones en pedidos, facturas y Modo Obra:*');
  lines.push(`¿Deseas añadirle un distintivo a esta nueva obra? (Ejemplo: *"Renombrar a ${clientName} (${newAddress ? newAddress.split(',')[0].trim() : 'Nueva Obra'})"*).`);

  return lines.join('\n');
}
