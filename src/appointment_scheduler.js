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

import { db, getCompany, recordAuditLog } from './db_service.js';

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
    const cleanPhone = rawVal.replace(/\D/g, '');
    for (const [activeJid, sess] of userSessions.entries()) {
      if (activeJid.includes('@g.us') || activeJid.includes('@broadcast') || activeJid.includes('@newsletter')) continue;
      if (sess?.companyId && sess.companyId === rawVal) {
        return activeJid;
      }
      const sessPhone = String(sess?.phone || '').replace(/\D/g, '');
      if (sessPhone && (sessPhone === cleanPhone || sessPhone === rawVal)) {
        return activeJid;
      }
    }
  }
  const clean = String(companyIdOrPhone || '').replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

/**
 * Job 1: Recordatorio del día anterior (Víspera)
 */
export async function runEveningBeforeReminderJob(sock, userSessions = new Map(), botSentMessageIds = new Set()) {
  if (!sock) return;
  const { tomorrowStr, hour, minute, nowIso } = getNowInTimezone('Europe/Madrid');

  // Solo ejecuta en la ventana de las 19:30 a 19:35 (o cuando se invoque)
  if (hour !== 19 || minute < 30 || minute > 35) return;

  // Busca todas las visitas de mañana que no hayan recibido el recordatorio previo
  const stmt = db.prepare(`
    SELECT * FROM appointments
    WHERE date = ?
      AND status = 'CONFIRMED'
      AND reminder_day_sent_at IS NULL
    ORDER BY COALESCE(company_id, company_phone) ASC, time ASC
  `);

  const rows = stmt.all(tomorrowStr);
  if (rows.length === 0) return;

  // Agrupar por profesional/empresa
  const byCompany = new Map();
  for (const r of rows) {
    const key = r.company_id || r.company_phone;
    if (!byCompany.has(key)) byCompany.set(key, { companyId: r.company_id, phone: r.company_phone, appointments: [] });
    byCompany.get(key).appointments.push(r);
  }

  for (const [key, { companyId, phone, appointments }] of byCompany.entries()) {
    try {
      const targetJid = resolveSchedulerTargetJid(companyId || phone, userSessions);
      const dateParts = tomorrowStr.split('-');
      const formattedDate = dateParts.length === 3 ? `${dateParts[2]}/${dateParts[1]}` : tomorrowStr;

      const lines = [
        '📅 *VISITAS DE MAÑANA*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Mañana (${formattedDate}) tienes *${appointments.length} visita${appointments.length === 1 ? '' : 's'}* en tu agenda:\n`
      ];

      appointments.forEach((app, idx) => {
        lines.push(`${idx + 1}️⃣ *${app.time} h* — ${app.client_name}`);
        if (app.client_address) lines.push(`   📍 ${app.client_address}`);
        if (app.notes) lines.push(`   📝 ${app.notes}`);
        lines.push('');
      });

      lines.push('💡 _Si necesitas cambiar o retrasar alguna, dímelo ahora y la actualizo._');

      const sent = await sock.sendMessage(targetJid, { text: lines.join('\n').trim() });
      if (sent?.status === 'BLOCKED') {
        console.warn(`🛡️ [Scheduler] Envío bloqueado por cortafuegos para ${phone || companyId}. No se actualizará SQLite.`);
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

      console.log(`📨 [Scheduler] Recordatorio de víspera enviado a ${phone || companyId} para ${appointments.length} visitas.`);
    } catch (err) {
      console.error(`❌ [Scheduler] Error enviando recordatorio víspera a ${phone || companyId}:`, err.message);
    }
  }
}

/**
 * Job 2: Recordatorio de la mañana (Resumen del día)
 */
export async function runMorningReminderJob(sock, userSessions = new Map(), botSentMessageIds = new Set()) {
  if (!sock) return;
  const { dateStr, hour, minute, nowIso } = getNowInTimezone('Europe/Madrid');

  // Solo ejecuta en la ventana de las 07:30 a 07:35
  if (hour !== 7 || minute < 30 || minute > 35) return;

  const stmt = db.prepare(`
    SELECT * FROM appointments
    WHERE date = ?
      AND status = 'CONFIRMED'
      AND reminder_morning_sent_at IS NULL
    ORDER BY COALESCE(company_id, company_phone) ASC, time ASC
  `);

  const rows = stmt.all(dateStr);
  if (rows.length === 0) return;

  const byCompany = new Map();
  for (const r of rows) {
    const key = r.company_id || r.company_phone;
    if (!byCompany.has(key)) byCompany.set(key, { companyId: r.company_id, phone: r.company_phone, appointments: [] });
    byCompany.get(key).appointments.push(r);
  }

  for (const [key, { companyId, phone, appointments }] of byCompany.entries()) {
    try {
      const targetJid = resolveSchedulerTargetJid(companyId || phone, userSessions);
      const company = getCompany(companyId || phone);
      const greetingName = company.ownerName || company.name ? ` ${company.ownerName || company.name}` : '';

      const lines = [
        `☀️ *Buenos días${greetingName}.*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Hoy tienes *${appointments.length} visita${appointments.length === 1 ? '' : 's'} programada${appointments.length === 1 ? '' : 's'}*:\n`
      ];

      appointments.forEach((app, idx) => {
        lines.push(`${idx + 1}️⃣ *${app.time} h* — ${app.client_name}`);
        if (app.client_address) lines.push(`   📍 ${app.client_address}`);
        if (app.notes) lines.push(`   📝 ${app.notes}`);
        lines.push('');
      });

      lines.push('💡 _Si surge cualquier imprevisto durante el día, solo avísame._');

      const sent = await sock.sendMessage(targetJid, { text: lines.join('\n').trim() });
      if (sent?.status === 'BLOCKED') {
        console.warn(`🛡️ [Scheduler] Envío matinal bloqueado por cortafuegos para ${phone || companyId}.`);
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

      console.log(`☀️ [Scheduler] Recordatorio matinal enviado a ${phone || companyId} para ${appointments.length} visitas.`);
    } catch (err) {
      console.error(`❌ [Scheduler] Error enviando recordatorio matinal a ${phone || companyId}:`, err.message);
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
export async function runEndOfDayReviewJob(sock, userSessions = new Map(), botSentMessageIds = new Set()) {
  if (!sock) return;
  const { dateStr, hour, minute, nowIso } = getNowInTimezone('Europe/Madrid');

  // Ventana de ejecución habitual a partir de las 20:30
  if (hour < 20 || (hour === 20 && minute < 30)) return;

  const stmt = db.prepare(`
    SELECT * FROM appointments
    WHERE date = ?
      AND status = 'CONFIRMED'
      AND end_of_day_review_sent_at IS NULL
    ORDER BY COALESCE(company_id, company_phone) ASC, time ASC
  `);

  const rows = stmt.all(dateStr);
  if (rows.length === 0) return;

  const byCompany = new Map();
  for (const r of rows) {
    const key = r.company_id || r.company_phone;
    if (!byCompany.has(key)) byCompany.set(key, { companyId: r.company_id, phone: r.company_phone, appointments: [] });
    byCompany.get(key).appointments.push(r);
  }

  for (const [key, { companyId, phone, appointments }] of byCompany.entries()) {
    try {
      const targetJid = resolveSchedulerTargetJid(companyId || phone, userSessions);
      
      const lines = [
        '👋 *Antes de terminar la jornada:*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Hoy tenías programadas estas *${appointments.length} visitas*:\n`
      ];

      appointments.forEach((app, idx) => {
        lines.push(`${idx + 1}️⃣ *${app.time} h* — ${app.client_name}${app.client_address ? ` (${app.client_address})` : ''}`);
      });

      lines.push('');
      lines.push('¿Han quedado todas realizadas?');
      lines.push('');
      lines.push('Puedes decirme:');
      lines.push('• *"Todas hechas"*');
      if (appointments.length > 1) {
        lines.push(`• *"${appointments[0].client_name} sí, las demás no"*`);
        lines.push(`• *"Pásame la de ${appointments[0].client_name} al jueves a las 18"*`);
      } else {
        lines.push('• *"Sí, hecha"* o *"No pude, pásala al jueves a las 17"*');
      }

      const sent = await sock.sendMessage(targetJid, { text: lines.join('\n').trim() });
      if (sent?.status === 'BLOCKED') {
        console.warn(`🛡️ [Scheduler] Revisión de fin de jornada bloqueada por cortafuegos para ${phone || companyId}.`);
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
          appointments: appointments.map(a => ({ id: a.id, clientName: a.client_name, time: a.time }))
        };
      }

      console.log(`📋 [Scheduler] Revisión de fin de jornada enviada a ${phone || companyId} para ${appointments.length} visitas.`);
    } catch (err) {
      console.error(`❌ [Scheduler] Error en revisión de fin de jornada para ${phone || companyId}:`, err.message);
    }
  }
}

/**
 * Inicializador del Scheduler en segundo plano.
 * Corre cada 60 segundos ejecutando los 3 jobs con total idempotencia.
 */
export function initAppointmentScheduler(sock, userSessions = new Map(), botSentMessageIds = new Set()) {
  console.log('⏰ [Scheduler] Motor de visitas y recordatorios inicializado (Europe/Madrid).');

  const intervalId = setInterval(async () => {
    try {
      await runMorningReminderJob(sock, userSessions, botSentMessageIds);
      await runEveningBeforeReminderJob(sock, userSessions, botSentMessageIds);
      await runEndOfDayReviewJob(sock, userSessions, botSentMessageIds);
    } catch (err) {
      console.error('❌ [Scheduler] Error en ciclo de reloj:', err.message);
    }
  }, 60000);

  return intervalId;
}
