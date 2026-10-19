/**
 * PresuVoz — Appointment Autonomous Scheduler
 * 
 * Gestiona de forma 100% autónoma, idempotente y basada en SQLite:
 * 1. Recordatorio de la víspera (Día anterior — 19:30 Europe/Madrid).
 * 2. Recordatorio matinal (Mañana del día — 07:30 Europe/Madrid).
 * 3. Revisión de fin de jornada (Confirmación de visitas realizadas — 20:30 Europe/Madrid).
 * 
 * Idempotencia: Los jobs nunca envían mensajes duplicados porque comprueban
 * las marcas temporales en SQLite (reminder_day_sent_at, reminder_morning_sent_at, end_of_day_review_sent_at).
 * Independencia: No depende de sesiones en RAM; consulta directamente la base de datos de empresas y visitas.
 */

import { db, getCompany, recordAuditLog, getBudgetsNearExpiration, recordBudgetExpirationReminder } from './db_service.js';
import { formatListIndex } from './secretary_service.js';

function getNowInTimezone(tz = 'Europe/Madrid') {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }); // HH:MM
  const [hour, minute] = timeStr.split(':').map(Number);
  
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: tz });

  return { dateStr, timeStr, hour, minute, tomorrowStr, nowIso: now.toISOString() };
}

function resolveSchedulerTargetJid(companyIdOrPhone, userSessions) {
  if (userSessions && typeof userSessions.entries === 'function') {
    const rawVal = String(companyIdOrPhone || '').trim();
    for (const [activeJid, sess] of userSessions.entries()) {
      if (activeJid.includes('@g.us') || activeJid.includes('@broadcast') || activeJid.includes('@newsletter')) continue;
      if (sess?.companyId && sess.companyId === rawVal) {
        return activeJid;
      }
    }
  }
  if (companyIdOrPhone && String(companyIdOrPhone).includes('-')) {
    try {
      const chan = db.prepare("SELECT channel_identifier FROM channel_identities WHERE company_id = ? AND channel = 'whatsapp' AND is_active = 1 ORDER BY created_at DESC LIMIT 1").get(companyIdOrPhone);
      if (chan?.channel_identifier) {
        const clean = String(chan.channel_identifier).replace(/\D/g, '');
        return `${clean}@s.whatsapp.net`;
      }
    } catch (_) {}
    const row = db.prepare('SELECT phone FROM companies WHERE id = ?').get(companyIdOrPhone);
    if (row?.phone) {
      const clean = String(row.phone).replace(/\D/g, '');
      return `${clean}@s.whatsapp.net`;
    }
  }
  const clean = String(companyIdOrPhone || '').replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

/**
 * Job 1: Recordatorio del día anterior (Víspera)
 */
export async function runEveningBeforeReminderJob(sock, userSessions = new Map(), botSentMessageIds = new Set(), options = {}) {
  if (!sock) return;
  const { tomorrowStr, hour, minute, nowIso } = getNowInTimezone('Europe/Madrid');

  // Solo ejecuta en la ventana de las 19:30 a 19:35 (salvo que se pase ignoreTimeWindow para reconciliación o testing)
  if (!options?.ignoreTimeWindow) {
    if (hour !== 19 || minute < 30 || minute > 35) return;
  }

  // Busca todas las visitas de mañana que no hayan recibido el recordatorio previo
  const stmt = db.prepare(`
    SELECT * FROM appointments
    WHERE date = ?
      AND status = 'CONFIRMED'
      AND reminder_day_sent_at IS NULL
    ORDER BY company_id ASC, time ASC
  `);

  const rows = stmt.all(tomorrowStr);
  if (rows.length === 0) return;

  // Agrupar por profesional/empresa
  const byCompany = new Map();
  for (const r of rows) {
    const key = r.company_id;
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, { companyId: r.company_id, appointments: [] });
    byCompany.get(key).appointments.push(r);
  }

  for (const [companyId, { appointments }] of byCompany.entries()) {
    try {
      const targetJid = resolveSchedulerTargetJid(companyId, userSessions);
      const dateParts = tomorrowStr.split('-');
      const formattedDate = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}` : tomorrowStr;

      const lines = [
        '📅 *VISITAS DE MAÑANA*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Mañana (${formattedDate}) tienes *${appointments.length} visita${appointments.length === 1 ? '' : 's'}* en tu agenda:\n`
      ];

      appointments.forEach((app, idx) => {
        lines.push(`${formatListIndex(idx + 1)} *${app.time} h* — ${app.client_name}`);
        if (app.client_address) lines.push(`   📍 ${app.client_address}`);
        if (app.notes) lines.push(`   📝 ${app.notes}`);
        lines.push('');
      });

      lines.push('💡 _Si necesitas cambiar o retrasar alguna, dímelo ahora y la actualizo._');

      const sent = await sock.sendMessage(targetJid, { text: lines.join('\n').trim() });
      if (sent?.status === 'BLOCKED') {
        console.warn(`🛡️ [Scheduler] Envío bloqueado por cortafuegos para ${targetJid || companyId}. No se actualizará SQLite.`);
        continue;
      }
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);

      // Marcar como enviado en SQLite para garantizar idempotencia
      const aptIds = appointments.map(a => a.id);
      const placeholders = aptIds.map(() => '?').join(',');
      db.prepare(`
        UPDATE appointments
        SET reminder_day_sent_at = ?, updated_at = ?
        WHERE id IN (${placeholders})
      `).run(nowIso, nowIso, ...aptIds);

      console.log(`📨 [Scheduler] Recordatorio de víspera enviado a ${targetJid || companyId} para ${appointments.length} visitas.`);
    } catch (err) {
      console.error(`❌ [Scheduler] Error enviando recordatorio víspera a ${targetJid || companyId}:`, err.message);
    }
  }
}

/**
 * Job 2: Recordatorio de la mañana (Resumen del día)
 */
export async function runMorningReminderJob(sock, userSessions = new Map(), botSentMessageIds = new Set(), options = {}) {
  if (!sock) return;
  const { dateStr, hour, minute, nowIso } = getNowInTimezone('Europe/Madrid');

  // Solo ejecuta en la ventana de las 07:30 a 07:35 (salvo ignoreTimeWindow)
  if (!options?.ignoreTimeWindow) {
    if (hour !== 7 || minute < 30 || minute > 35) return;
  }

  const stmt = db.prepare(`
    SELECT * FROM appointments
    WHERE date = ?
      AND status = 'CONFIRMED'
      AND reminder_morning_sent_at IS NULL
    ORDER BY company_id ASC, time ASC
  `);

  const rows = stmt.all(dateStr);
  if (rows.length === 0) return;

  const byCompany = new Map();
  for (const r of rows) {
    const key = r.company_id;
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, { companyId: r.company_id, appointments: [] });
    byCompany.get(key).appointments.push(r);
  }

  for (const [companyId, { appointments }] of byCompany.entries()) {
    try {
      const targetJid = resolveSchedulerTargetJid(companyId, userSessions);
      const company = getCompany(companyId);
      const greetingName = company.ownerName || company.name ? ` ${company.ownerName || company.name}` : '';

      const lines = [
        `☀️ *Buenos días${greetingName}.*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Hoy tienes *${appointments.length} visita${appointments.length === 1 ? '' : 's'} programada${appointments.length === 1 ? '' : 's'}*:\n`
      ];

      appointments.forEach((app, idx) => {
        lines.push(`${formatListIndex(idx + 1)} *${app.time} h* — ${app.client_name}`);
        if (app.client_address) lines.push(`   📍 ${app.client_address}`);
        if (app.notes) lines.push(`   📝 ${app.notes}`);
        lines.push('');
      });

      lines.push('💡 _Si surge cualquier imprevisto durante el día, solo avísame._');

      const sent = await sock.sendMessage(targetJid, { text: lines.join('\n').trim() });
      if (sent?.status === 'BLOCKED') {
        console.warn(`🛡️ [Scheduler] Envío matinal bloqueado por cortafuegos para ${targetJid || companyId}.`);
        continue;
      }
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);

      const aptIds = appointments.map(a => a.id);
      const placeholders = aptIds.map(() => '?').join(',');
      db.prepare(`
        UPDATE appointments
        SET reminder_morning_sent_at = ?, updated_at = ?
        WHERE id IN (${placeholders})
      `).run(nowIso, nowIso, ...aptIds);

      console.log(`☀️ [Scheduler] Recordatorio matinal enviado a ${targetJid || companyId} para ${appointments.length} visitas.`);
    } catch (err) {
      console.error(`❌ [Scheduler] Error enviando recordatorio matinal a ${targetJid || companyId}:`, err.message);
    }
  }
}

/**
 * Job 3: Revisión de fin de jornada (Confirmación de visitas realizadas)
 * 
 * Regla de Oro: El paso del tiempo NO determina el resultado.
 * Si la hora ya pasó, no se marcan automáticamente como COMPLETED.
 * Se pide confirmación humana al profesional para que diga qué pasó.
 */
export async function runEndOfDayReviewJob(sock, userSessions = new Map(), botSentMessageIds = new Set(), options = {}) {
  if (!sock) return;
  const { dateStr, hour, minute, nowIso } = getNowInTimezone('Europe/Madrid');

  // Ventana de ejecución habitual a partir de las 20:30 (salvo ignoreTimeWindow)
  if (!options?.ignoreTimeWindow) {
    if (hour < 20 || (hour === 20 && minute < 30)) return;
  }

  const stmt = db.prepare(`
    SELECT * FROM appointments
    WHERE date <= ?
      AND status = 'CONFIRMED'
      AND end_of_day_review_sent_at IS NULL
    ORDER BY company_id ASC, date ASC, time ASC
  `);

  const rows = stmt.all(dateStr);
  if (rows.length === 0) return;

  const byCompany = new Map();
  for (const r of rows) {
    const key = r.company_id;
    if (!key) continue;
    if (!byCompany.has(key)) byCompany.set(key, { companyId: r.company_id, appointments: [] });
    byCompany.get(key).appointments.push(r);
  }

  for (const [companyId, { appointments }] of byCompany.entries()) {
    try {
      const targetJid = resolveSchedulerTargetJid(companyId, userSessions);
      const hasPastDays = appointments.some(a => a.date < dateStr);
      
      const lines = [
        hasPastDays ? '👋 *Recordatorio de visitas pasadas:*' : '👋 *Antes de terminar la jornada:*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        hasPastDays
          ? `Tienes estas *${appointments.length} visitas* que ya han pasado sin confirmar el resultado:\n`
          : `Hoy tenías programadas estas *${appointments.length} visitas*:\n`
      ];

      appointments.forEach((app, idx) => {
        const dateParts = (app.date || '').split('-');
        const formattedDate = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}` : app.date;
        const datePrefix = app.date !== dateStr ? `(${formattedDate}) ` : '';
        lines.push(`${formatListIndex(idx + 1)} *${datePrefix}${app.time} h* — ${app.client_name}${app.client_address ? ` (${app.client_address})` : ''}`);
      });

      lines.push('');
      lines.push('¿Llegaste a realizarlas o necesitas cambiarlas?');
      lines.push('');
      lines.push('Puedes decirme:');
      lines.push('• *"Todas hechas"* o *"Visita de ' + (appointments[0]?.client_name || 'cliente') + ' hecha"*');
      lines.push('• *"Pásala a mañana a las 11"* (para reagendar)');
      lines.push('• *"Cancela la visita de ' + (appointments[0]?.client_name || 'cliente') + '"* (para anularla)');

      const sent = await sock.sendMessage(targetJid, { text: lines.join('\n').trim() });
      if (sent?.status === 'BLOCKED') {
        console.warn(`🛡️ [Scheduler] Revisión de fin de jornada bloqueada por cortafuegos para ${targetJid || companyId}.`);
        continue;
      }
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);

      // Marcar en BD needs_outcome_confirmation = 1 y end_of_day_review_sent_at
      const aptIds = appointments.map(a => a.id);
      const placeholders = aptIds.map(() => '?').join(',');
      db.prepare(`
        UPDATE appointments
        SET needs_outcome_confirmation = 1,
            end_of_day_review_sent_at = ?,
            updated_at = ?
        WHERE id IN (${placeholders})
      `).run(nowIso, nowIso, ...aptIds);

      // Registrar estado en la sesión para contexto inmediato conversacional
      if (userSessions.has(targetJid)) {
        const session = userSessions.get(targetJid);
        session.pendingDayReview = {
          date: dateStr,
          appointments: appointments.map(a => ({
            id: a.id,
            clientName: a.client_name,
            clientAddress: a.client_address,
            date: a.date,
            time: a.time
          }))
        };
      }

      console.log(`📋 [Scheduler] Revisión de fin de jornada enviada a ${targetJid || companyId} para ${appointments.length} visitas.`);
    } catch (err) {
      console.error(`❌ [Scheduler] Error en revisión de fin de jornada para ${targetJid || companyId}:`, err.message);
    }
  }
}

/**
 * Job 4: Avisos de vencimiento de presupuestos pendientes de firma.
 * 
 * Reglas de negocio:
 * 1. Día anterior al vencimiento (Día N-1 de N):
 *    Se envía un recordatorio EXCLUSIVAMENTE al autónomo avisándole de que el presupuesto vence mañana y sigue sin firmar.
 *    REGLA DE SEGURIDAD ESTRICTA: NUNCA se envía ningún mensaje al cliente final.
 * 2. Día justo de vencimiento (Día N de N):
 *    Se envía al autónomo el aviso de que ha alcanzado el límite de validez fijado en el onboarding:
 *    «⏳ El presupuesto de "${clientName}" ha alcanzado hoy el límite de ${validityDays} días. Sigue sin firmar. Puedes llamarla para cerrar la obra o decirme "marca como perdido el de ${clientName}" si ha decidido no hacerlo.»
 * 
 * Idempotencia: Los jobs registran `soonSentAt` y `expiredSentAt` en SQLite (data_json), garantizando que no se duplican.
 */
export async function runBudgetExpirationReminderJob(sock, userSessions = new Map(), botSentMessageIds = new Set(), options = {}) {
  if (!sock) return;
  const { hour, minute } = getNowInTimezone('Europe/Madrid');

  // Ventana matinal recomendada entre 08:30 y 14:00 (salvo ignoreTimeWindow)
  if (!options?.ignoreTimeWindow) {
    if (hour < 8 || (hour === 8 && minute < 30) || hour >= 14) return;
  }

  // Obtener empresas con presupuestos no aceptados ni cancelados
  let companyRows = [];
  try {
    companyRows = db.prepare(`
      SELECT DISTINCT company_id 
      FROM budgets 
      WHERE company_id IS NOT NULL 
        AND status NOT IN ('ACEPTADO', 'FIRMADO', 'FINALIZADO', 'CANCELADO', 'PERDIDO')
    `).all();
  } catch (err) {
    console.error('❌ [Scheduler] Error consultando empresas para vencimientos:', err.message);
    return;
  }

  if (!companyRows || companyRows.length === 0) return;

  for (const { company_id } of companyRows) {
    if (!company_id) continue;
    try {
      const nearExpiring = getBudgetsNearExpiration(company_id);
      if (!nearExpiring || nearExpiring.length === 0) continue;

      const targetJid = resolveSchedulerTargetJid(company_id, userSessions);

      for (const item of nearExpiring) {
        if (item.isExpired) {
          // Día N (alcanzado o superado el límite de validez)
          const callPronoun = (
            item.clientName.toLowerCase().endsWith('a') ||
            item.clientName.toLowerCase().includes('maría') ||
            item.clientName.toLowerCase().includes('maria') ||
            item.clientName.toLowerCase().includes('laura') ||
            item.clientName.toLowerCase().includes('carmen')
          ) ? 'llamarla' : 'llamarle';

          const msgText = `⏳ El presupuesto de "${item.clientName}" ha alcanzado hoy el límite de ${item.validityDays} días. Sigue sin firmar. Puedes ${callPronoun} para cerrar la obra o decirme "marca como perdido el de ${item.clientName}" si ha decidido no hacerlo.`;

          const sent = await sock.sendMessage(targetJid, { text: msgText });
          if (sent?.status === 'BLOCKED') {
            console.warn(`🛡️ [Scheduler] Aviso de vencimiento bloqueado por cortafuegos para ${targetJid}.`);
            continue;
          }
          if (sent?.key?.id) botSentMessageIds.add(sent.key.id);

          recordBudgetExpirationReminder(company_id, item.id, 'EXPIRED');
          console.log(`⏳ [Scheduler] Aviso de vencimiento de presupuesto ${item.id} (${item.clientName}) enviado al autónomo ${targetJid}`);
        } else if (item.isSoonToExpire) {
          // Día N-1 (1 día antes del vencimiento) — EXCLUSIVAMENTE para el autónomo
          const msgText = `⏳ *Recordatorio de presupuesto pendiente de firma*\nEl presupuesto de *${item.clientName}* (${item.id}) vence mañana (ha alcanzado ${item.daysWaiting} de ${item.validityDays} días de validez) y sigue pendiente de firma.\n\n💡 _No se ha enviado ningún mensaje al cliente._`;

          const sent = await sock.sendMessage(targetJid, { text: msgText });
          if (sent?.status === 'BLOCKED') {
            console.warn(`🛡️ [Scheduler] Recordatorio de víspera de vencimiento bloqueado por cortafuegos para ${targetJid}.`);
            continue;
          }
          if (sent?.key?.id) botSentMessageIds.add(sent.key.id);

          recordBudgetExpirationReminder(company_id, item.id, 'SOON');
          console.log(`⏳ [Scheduler] Recordatorio víspera de vencimiento ${item.id} (${item.clientName}) enviado al autónomo ${targetJid}`);
        }
      }
    } catch (compErr) {
      console.error(`❌ [Scheduler] Error procesando vencimientos para empresa ${company_id}:`, compErr.message);
    }
  }
}

/**
 * Reconciliación en arranque tras reinicio del servicio (DEF-06):
 * Comprueba visitas confirmadas no notificadas que se encuentren dentro de
 * ventanas razonables del mismo día y las notifica sin duplicar mensajes
 * gracias a las marcas en SQLite.
 */
export async function reconcilePendingSchedulerJobs(sock, userSessions = new Map(), botSentMessageIds = new Set(), options = {}) {
  if (!sock) return { reconciled: false, reason: 'NO_SOCKET' };
  const { hour, minute } = getNowInTimezone('Europe/Madrid');
  const results = { morning: false, evening: false, endOfDay: false, budgetExpiration: false };

  // 1. Recordatorio matinal: ventana válida si el bot arranca entre las 07:30 y las 14:00
  if (options.ignoreTimeWindow || ((hour > 7 || (hour === 7 && minute >= 30)) && hour < 14)) {
    await runMorningReminderJob(sock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    results.morning = true;
  }

  // 2. Recordatorio víspera: ventana válida si el bot arranca entre las 19:30 y las 23:59
  if (options.ignoreTimeWindow || (hour > 19 || (hour === 19 && minute >= 30))) {
    await runEveningBeforeReminderJob(sock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    results.evening = true;
  }

  // 3. Revisión de fin de jornada: ventana válida si el bot arranca entre las 20:30 y las 23:59
  if (options.ignoreTimeWindow || (hour > 20 || (hour === 20 && minute >= 30))) {
    await runEndOfDayReviewJob(sock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    results.endOfDay = true;
  }

  // 4. Vencimiento de presupuestos: ventana matinal/diurna (entre las 08:30 y las 14:00)
  if (options.ignoreTimeWindow || ((hour > 8 || (hour === 8 && minute >= 30)) && hour < 14)) {
    await runBudgetExpirationReminderJob(sock, userSessions, botSentMessageIds, { ignoreTimeWindow: true });
    results.budgetExpiration = true;
  }

  return { reconciled: true, results };
}

/**
 * Inicializador del Scheduler en segundo plano.
 * Corre cada 60 segundos ejecutando los 4 jobs con total idempotencia.
 * En arranque, reconcilia automáticamente citas y vencimientos pendientes dentro de ventanas válidas (DEF-06).
 */
export function initAppointmentScheduler(sock, userSessions = new Map(), botSentMessageIds = new Set(), options = {}) {
  console.log('⏰ [Scheduler] Motor de visitas y recordatorios inicializado (Europe/Madrid).');

  // Reconciliación en arranque: procesar recordatorios pendientes si estamos en ventana válida
  if (!options?.skipStartupReconciliation) {
    reconcilePendingSchedulerJobs(sock, userSessions, botSentMessageIds, options)
      .catch(err => console.error('❌ [Scheduler] Error en reconciliación de arranque:', err.message));
  }

  const intervalId = setInterval(async () => {
    try {
      await runMorningReminderJob(sock, userSessions, botSentMessageIds);
      await runEveningBeforeReminderJob(sock, userSessions, botSentMessageIds);
      await runEndOfDayReviewJob(sock, userSessions, botSentMessageIds);
      await runBudgetExpirationReminderJob(sock, userSessions, botSentMessageIds);
    } catch (err) {
      console.error('❌ [Scheduler] Error en ciclo de reloj:', err.message);
    }
  }, 60000);

  return intervalId;
}
