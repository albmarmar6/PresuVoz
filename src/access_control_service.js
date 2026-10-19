/**
 * PresuVoz — Access Control & Authorization Service
 * 
 * Responsabilidad Única:
 * Gestionar la autorización explícita de números de WhatsApp antes de producción.
 * Implementa el principio de "Denegación por Defecto" (Default-Deny) para garantizar que
 * ningún número desconocido pueda iniciar onboarding, consumir tokens de IA ni operar el bot.
 * 
 * Reglas Arquitectónicas:
 * 1. Default-Deny: Cualquier número no autorizado queda bloqueado en el ingress gatekeeper.
 * 2. Administradores de Plataforma: Lista explícita (ADMIN_PHONE_NUMBERS) separada de tenants.
 * 3. Normalización E.164: Formato internacional consistente (+34..., 0034..., 9 dígitos locales).
 * 4. Modelo de Datos Existente: Reutiliza `users` y `channel_identities` sin tablas duplicadas.
 * 5. No Destructivo: Revocar desactiva accesos (`is_active = 0`, `status = 'REVOKED'`) sin borrar
 *    facturas, presupuestos ni histórico contable.
 * 6. Trazabilidad: Registra autorizaciones, revocaciones y bloqueos sin exponer secretos.
 */

import crypto from 'node:crypto';
import { db } from './db_service.js';
import { resolveAuthenticatedContext, deactivateChannelIdentity, reactivateChannelIdentity } from './identity_service.js';

/**
 * Normaliza un número de teléfono a formato internacional E.164 y dígitos puros.
 * Soporta formatos: +34 600 11 22 33, 0034600112233, 600112233 (España por defecto), +44 7911 123456, etc.
 * 
 * @param {string} rawPhone
 * @param {string} [defaultCountryCode='34']
 * @returns {{ e164: string, digits: string, isValid: boolean }}
 */
export function normalizeToE164(rawPhone, defaultCountryCode = '34') {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return { e164: '', digits: '', isValid: false };
  }

  let cleaned = rawPhone.trim().replace(/[\s\-\(\)\.]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  const hasPlus = cleaned.startsWith('+');
  const digitsOnly = cleaned.replace(/\D/g, '');

  if (digitsOnly.length < 7 || digitsOnly.length > 15) {
    return { e164: '', digits: '', isValid: false };
  }

  let canonicalDigits = digitsOnly;
  if (!hasPlus) {
    // Si tiene 9 dígitos y empieza por 6, 7, 8 o 9 (España típico), anteponer código país
    if (digitsOnly.length === 9 && /^[6789]/.test(digitsOnly)) {
      canonicalDigits = defaultCountryCode + digitsOnly;
    }
  }

  const e164 = `+${canonicalDigits}`;
  return {
    e164,
    digits: canonicalDigits,
    isValid: canonicalDigits.length >= 7 && canonicalDigits.length <= 15
  };
}

/**
 * Obtiene la lista de administradores de la plataforma desde variables de entorno.
 * @returns {Set<string>} Conjunto de dígitos normalizados de administradores
 */
export function getPlatformAdmins() {
  const envAdmins = process.env.ADMIN_PHONE_NUMBERS || '';
  const list = envAdmins.split(',').map(s => normalizeToE164(s).digits).filter(Boolean);
  return new Set(list);
}

/**
 * Verifica si un número de teléfono corresponde a un administrador de la plataforma.
 * @param {string} phone
 * @returns {boolean}
 */
export function isPlatformAdmin(phone) {
  if (!phone) return false;
  const norm = normalizeToE164(phone);
  if (!norm.isValid) return false;
  const admins = getPlatformAdmins();
  return admins.has(norm.digits);
}

/**
 * Consulta el estado de autorización de un número de teléfono.
 * Determina si el remitente está autorizado para entrar al bot (onboarding o tenant activo).
 * 
 * @param {string} phone
 * @param {object} [options]
 * @param {import('node:sqlite').DatabaseSync} [options.targetDb]
 * @param {string[]} [options.allowedNumbers]
 * @returns {{ authorized: boolean, reason: string, status?: string, companyId?: string }}
 */
export function isPhoneNumberAuthorized(phone, options = {}) {
  const targetDb = options.targetDb || db;
  const norm = normalizeToE164(phone);
  if (!norm.isValid) {
    return { authorized: false, reason: 'INVALID_PHONE_FORMAT' };
  }

  const cleanDigits = norm.digits;

  // 1. Administrador de la plataforma
  if (isPlatformAdmin(cleanDigits)) {
    return { authorized: true, reason: 'PLATFORM_ADMIN', status: 'ADMIN' };
  }

  // 2. Comprobar si está explícitamente revocado en `users`
  try {
    const userRow = targetDb.prepare('SELECT id, status FROM users WHERE phone = ?').get(cleanDigits);
    if (userRow && userRow.status === 'REVOKED') {
      return { authorized: false, reason: 'REVOKED_USER', status: 'REVOKED' };
    }
  } catch (e) {}

  // 3. Comprobar si es un tenant ya registrado y activo en `channel_identities`
  try {
    const authContext = resolveAuthenticatedContext('whatsapp', cleanDigits);
    if (authContext && authContext.companyId) {
      return { authorized: true, reason: 'AUTHENTICATED_TENANT', status: 'ACTIVE_TENANT', companyId: authContext.companyId };
    }
  } catch (e) {}

  // 4. Comprobar si está explícitamente pre-autorizado en `users` (status = 'AUTHORIZED')
  try {
    const userRow = targetDb.prepare('SELECT id, status FROM users WHERE phone = ?').get(cleanDigits);
    if (userRow && userRow.status === 'AUTHORIZED') {
      return { authorized: true, reason: 'PRE_AUTHORIZED_ONBOARDING', status: 'AUTHORIZED' };
    }
  } catch (e) {}

  // 5. Lista blanca de testers en ALLOWED_NUMBERS (si está configurada)
  const allowed = options.allowedNumbers || (process.env.ALLOWED_NUMBERS || '').split(',').map(s => s.trim().replace(/\D/g, '')).filter(Boolean);
  if (allowed.some(num => num && cleanDigits === String(num).replace(/\D/g, ''))) {
    return { authorized: true, reason: 'ALLOWED_EXTERNAL_TESTER', status: 'TESTER' };
  }

  return { authorized: false, reason: 'UNAUTHORIZED_SENDER', status: 'UNKNOWN' };
}

/**
 * Autoriza un número de teléfono para iniciar el onboarding.
 * Reutiliza la tabla `users` estableciendo `status = 'AUTHORIZED'`.
 * No crea empresas prematuramente ni da acceso a ninguna empresa existente.
 * 
 * @param {string} phone Número a autorizar
 * @param {string} adminPhone Teléfono del administrador que ejecuta la acción
 * @param {object} [options]
 * @param {import('node:sqlite').DatabaseSync} [options.targetDb]
 * @returns {{ success: boolean, phone: string, digits: string, status: string, message: string }}
 */
export function authorizePhoneNumber(phone, adminPhone, options = {}) {
  const targetDb = options.targetDb || db;
  const norm = normalizeToE164(phone);
  if (!norm.isValid) {
    return {
      success: false,
      phone: String(phone),
      digits: '',
      status: 'INVALID',
      message: `El número '${phone}' no tiene un formato internacional válido (ej: +34600112233).`
    };
  }

  const cleanDigits = norm.digits;
  const now = new Date().toISOString();
  const authorizer = adminPhone ? normalizeToE164(adminPhone).e164 : 'SYSTEM_ADMIN';

  // Verificar si ya existe en users
  const existingUser = targetDb.prepare('SELECT id, name, status FROM users WHERE phone = ?').get(cleanDigits);

  if (existingUser) {
    if (existingUser.status === 'AUTHORIZED') {
      return {
        success: true,
        phone: norm.e164,
        digits: cleanDigits,
        status: 'AUTHORIZED',
        alreadyAuthorized: true,
        message: `El número ${norm.e164} ya estaba previamente autorizado para onboarding.`
      };
    }

    if (existingUser.status === 'ACTIVE') {
      // Reactivar canal si estuviera inactivo
      try { reactivateChannelIdentity('whatsapp', cleanDigits); } catch (e) {}
      return {
        success: true,
        phone: norm.e164,
        digits: cleanDigits,
        status: 'ACTIVE',
        alreadyAuthorized: true,
        message: `El número ${norm.e164} pertenece a una empresa ya activa en la plataforma.`
      };
    }

    // Si estaba revocado, reactivarlo
    targetDb.prepare(`
      UPDATE users SET status = 'AUTHORIZED', updated_at = ? WHERE id = ?
    `).run(now, existingUser.id);

    try { reactivateChannelIdentity('whatsapp', cleanDigits); } catch (e) {}

    console.log(`🔑 [AccessControl] Número ${norm.e164} reactivado/autorizado por ${authorizer}`);
    return {
      success: true,
      phone: norm.e164,
      digits: cleanDigits,
      status: 'AUTHORIZED',
      message: `Número ${norm.e164} reactivado con éxito para iniciar onboarding.`
    };
  }

  // Insertar nuevo usuario con status 'AUTHORIZED' (sin empresa)
  const newUserId = crypto.randomUUID();
  targetDb.prepare(`
    INSERT INTO users (id, name, email, phone, status, created_at, updated_at)
    VALUES (?, 'Usuario Invitado', ?, ?, 'AUTHORIZED', ?, ?)
  `).run(newUserId, `auth_by:${authorizer}`, cleanDigits, now, now);

  console.log(`🔑 [AccessControl] Número ${norm.e164} pre-autorizado por ${authorizer} (user_id: ${newUserId})`);

  return {
    success: true,
    phone: norm.e164,
    digits: cleanDigits,
    status: 'AUTHORIZED',
    message: `Número ${norm.e164} autorizado correctamente. Ya puede iniciar el asistente de registro en WhatsApp.`
  };
}

/**
 * Revoca la autorización de un número de teléfono.
 * Desactiva el acceso en `users` y `channel_identities` sin borrar presupuestos ni facturas.
 * 
 * @param {string} phone Número a revocar
 * @param {string} adminPhone Teléfono del administrador que ejecuta la acción
 * @param {object} [options]
 * @param {import('node:sqlite').DatabaseSync} [options.targetDb]
 * @returns {{ success: boolean, phone: string, digits: string, status: string, message: string }}
 */
export function revokePhoneNumber(phone, adminPhone, options = {}) {
  const targetDb = options.targetDb || db;
  const norm = normalizeToE164(phone);
  if (!norm.isValid) {
    return {
      success: false,
      phone: String(phone),
      digits: '',
      status: 'INVALID',
      message: `El número '${phone}' no tiene un formato válido.`
    };
  }

  const cleanDigits = norm.digits;
  const now = new Date().toISOString();
  const authorizer = adminPhone ? normalizeToE164(adminPhone).e164 : 'SYSTEM_ADMIN';

  // 1. Marcar usuario como REVOKED en users si existe
  const existingUser = targetDb.prepare('SELECT id, status FROM users WHERE phone = ?').get(cleanDigits);
  if (existingUser) {
    targetDb.prepare(`
      UPDATE users SET status = 'REVOKED', updated_at = ? WHERE id = ?
    `).run(now, existingUser.id);
  } else {
    // Si no existía en users, registrarlo directamente como REVOKED para bloqueo persistente
    const newId = crypto.randomUUID();
    targetDb.prepare(`
      INSERT INTO users (id, name, email, phone, status, created_at, updated_at)
      VALUES (?, 'Bloqueado', ?, ?, 'REVOKED', ?, ?)
    `).run(newId, `revoked_by:${authorizer}`, cleanDigits, now, now);
  }

  // 2. Desactivar canal en channel_identities (is_active = 0)
  try {
    deactivateChannelIdentity('whatsapp', cleanDigits);
  } catch (e) {}

  console.warn(`🛑 [AccessControl] Acceso REVOCADO para el número ${norm.e164} por ${authorizer}`);

  return {
    success: true,
    phone: norm.e164,
    digits: cleanDigits,
    status: 'REVOKED',
    message: `Acceso revocado para ${norm.e164}. Todas las operaciones quedan bloqueadas de inmediato. Sus datos históricos permanecen intactos.`
  };
}

/**
 * Consulta la lista de números autorizados y su estado actual.
 * @param {object} [options]
 * @param {import('node:sqlite').DatabaseSync} [options.targetDb]
 * @returns {Array<{ phone: string, e164: string, status: string, name: string, hasCompany: boolean, companyName: string|null, createdAt: string }>}
 */
export function listAuthorizedPhoneNumbers(options = {}) {
  const targetDb = options.targetDb || db;
  const rows = targetDb.prepare(`
    SELECT u.id, u.name, u.phone, u.status, u.created_at,
           ci.company_id, ci.is_active as channel_active,
           c.name as company_name
    FROM users u
    LEFT JOIN channel_identities ci ON ci.channel = 'whatsapp' AND ci.channel_identifier = u.phone
    LEFT JOIN companies c ON ci.company_id = c.id
    ORDER BY u.created_at DESC
  `).all();

  return rows.map(r => {
    const norm = normalizeToE164(r.phone);
    return {
      phone: r.phone,
      e164: norm.e164,
      status: r.status,
      name: r.name || 'Sin nombre',
      hasCompany: Boolean(r.company_id && r.channel_active === 1),
      companyName: r.company_name || null,
      createdAt: r.created_at
    };
  });
}

/**
 * Analizador determinístico de comandos administrativos de control de acceso.
 * Solo reconoce comandos inequívocos. NUNCA pasa por Gemini.
 * 
 * @param {string} text
 * @returns {{ isCommand: boolean, action: 'AUTHORIZE'|'REVOKE'|'LIST'|null, targetPhone?: string, error?: string }}
 */
export function parseAdminCommand(text) {
  if (!text || typeof text !== 'string') {
    return { isCommand: false, action: null };
  }

  const raw = text.trim();

  // 1. Listar autorizados
  if (/^(?:!|\/)?(?:autorizados|listar\s+autorizados|ver\s+autorizados)$/i.test(raw)) {
    return { isCommand: true, action: 'LIST' };
  }

  // 2. Autorizar número
  const authMatch = raw.match(/^(?:!|\/)?autorizar(?:\s+(.+))?$/i);
  if (authMatch) {
    const candidate = (authMatch[1] || '').trim();
    if (!candidate) {
      return {
        isCommand: true,
        action: 'AUTHORIZE',
        error: 'Indica el número a autorizar (ej: !autorizar +34600112233).'
      };
    }
    const norm = normalizeToE164(candidate);
    if (!norm.isValid) {
      return {
        isCommand: true,
        action: 'AUTHORIZE',
        error: `Formato de número no válido: '${candidate}'. Usa formato internacional (ej: +34600112233).`
      };
    }
    return { isCommand: true, action: 'AUTHORIZE', targetPhone: norm.e164, digits: norm.digits };
  }

  // 3. Revocar número
  const revokeMatch = raw.match(/^(?:!|\/)?revocar(?:\s+(.+))?$/i);
  if (revokeMatch) {
    const candidate = (revokeMatch[1] || '').trim();
    if (!candidate) {
      return {
        isCommand: true,
        action: 'REVOKE',
        error: 'Indica el número a revocar (ej: !revocar +34600112233).'
      };
    }
    const norm = normalizeToE164(candidate);
    if (!norm.isValid) {
      return {
        isCommand: true,
        action: 'REVOKE',
        error: `Formato de número no válido: '${candidate}'. Usa formato internacional (ej: +34600112233).`
      };
    }
    return { isCommand: true, action: 'REVOKE', targetPhone: norm.e164, digits: norm.digits };
  }

  return { isCommand: false, action: null };
}
