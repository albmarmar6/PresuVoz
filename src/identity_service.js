/**
 * PresuVoz — Identity Service & Centralized Identity Resolver
 * 
 * Responsabilidad Única:
 * Gestionar la resolución de identidad, autenticación multi-canal y pertenencias (tenancy).
 * 
 * Flujo Arquitectónico:
 * WhatsApp / JID / Canal
 *        ↓
 * channel_identities
 *        ↓
 * authenticated context
 *        ↓
 * company_id
 *        ↓
 * Servicios y Repositorios
 * 
 * Regla de Oro de Seguridad:
 * `company_id` NUNCA puede venir del modelo de IA ni de texto libre del usuario.
 * Se resuelve de forma exclusiva a través de este servicio desde una identidad verificada.
 */

import crypto from 'node:crypto';
import { db } from './db_service.js';

export const ROLES = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  EMPLOYEE: 'EMPLOYEE',
  GESTORIA: 'GESTORIA',
  READ_ONLY: 'READ_ONLY'
};

const ROLE_PERMISSIONS = {
  [ROLES.OWNER]: ['*'],
  [ROLES.ADMIN]: ['read', 'write', 'admin', 'billing', 'fiscal'],
  [ROLES.EMPLOYEE]: ['read', 'write'],
  [ROLES.GESTORIA]: ['read_fiscal', 'export_fiscal'],
  [ROLES.READ_ONLY]: ['read']
};

/**
 * Normaliza el identificador del canal según su tipología.
 * @param {string} channel
 * @param {string} identifier
 * @returns {string}
 */
export function normalizeChannelIdentifier(channel, identifier) {
  if (!identifier) return '';
  const str = String(identifier).trim();
  if (channel.toLowerCase() === 'whatsapp') {
    // Para WhatsApp, extraer dígitos limpios (ej: '34600112233')
    return str.replace(/\D/g, '');
  }
  return str.toLowerCase();
}

/**
 * Resuelve el contexto autenticado para una identidad de canal dada.
 * Es la ÚNICA autoridad del sistema para mapear un canal a una empresa (tenant).
 * 
 * @param {string} channel Canal de comunicación ('whatsapp', etc.)
 * @param {string} channelIdentifier Identificador en dicho canal (ej: número de teléfono)
 * @returns {AuthenticatedContext | null}
 */
export function resolveAuthenticatedContext(channel, channelIdentifier) {
  if (!channel || !channelIdentifier) return null;

  const normalizedChannel = String(channel).trim().toLowerCase();
  const cleanIdentifier = normalizeChannelIdentifier(normalizedChannel, channelIdentifier);

  if (!cleanIdentifier) return null;

  // 1. Consultar channel_identities (excluye identidades inactivas)
  const identityStmt = db.prepare(`
    SELECT id, company_id, channel, channel_identifier, is_active
    FROM channel_identities
    WHERE channel = ? AND channel_identifier = ? AND is_active = 1
  `);
  const identity = identityStmt.get(normalizedChannel, cleanIdentifier);

  if (!identity) {
    return null; // Canal no registrado o inactivo
  }

  // 2. Obtener datos de la empresa vinculada
  const companyStmt = db.prepare('SELECT * FROM companies WHERE id = ?');
  const companyRow = companyStmt.get(identity.company_id);

  if (!companyRow) {
    return null; // Inconsistencia referencial
  }

  // 3. Obtener usuario y membresía activa para la empresa
  const membershipStmt = db.prepare(`
    SELECT m.id as membership_id, m.user_id, m.role, m.status as membership_status,
           u.name as user_name, u.email as user_email, u.phone as user_phone, u.status as user_status
    FROM memberships m
    JOIN users u ON m.user_id = u.id
    WHERE m.company_id = ? AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
    ORDER BY CASE m.role WHEN 'OWNER' THEN 1 WHEN 'ADMIN' THEN 2 ELSE 3 END ASC
    LIMIT 1
  `);
  const memberRow = membershipStmt.get(identity.company_id);

  const role = memberRow?.role || ROLES.OWNER;
  const permissions = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[ROLES.READ_ONLY];

  // 4. Construir objeto Authenticated Context inmutable
  const context = {
    authenticated: true,
    companyId: identity.company_id,
    userId: memberRow?.user_id || null,
    userName: memberRow?.user_name || companyRow.owner_name || companyRow.name || 'Usuario',
    channel: identity.channel,
    channelIdentifier: identity.channel_identifier,
    channelIdentityId: identity.id,
    role,
    permissions,
    company: {
      id: companyRow.id,
      companyId: companyRow.id,
      phone: companyRow.phone,
      name: companyRow.name,
      fiscalName: companyRow.fiscal_name || companyRow.name,
      cif: companyRow.cif,
      trade: companyRow.trade,
      address: companyRow.address,
      city: companyRow.city,
      email: companyRow.email,
      isConfigured: Boolean(companyRow.name && companyRow.cif && !companyRow.onboarding_step)
    },

    /**
     * Barrera de Seguridad Cross-Tenant:
     * Lanza error si se intenta operar sobre un companyId distinto al autenticado.
     */
    assertTenantAccess(targetCompanyId) {
      if (!targetCompanyId) return;
      if (targetCompanyId !== identity.company_id) {
        throw new Error(
          `🛑 [SEGURIDAD CROSS-TENANT] Violación de aislamiento: Contexto de empresa '${identity.company_id}' intentó acceder a recursos de '${targetCompanyId}'.`
        );
      }
    }
  };

  return Object.freeze(context);
}

/**
 * Registra una nueva identidad de canal para una empresa existente.
 * Garantiza unicidad para evitar que un mismo identificador apunte a dos empresas.
 */
export function registerChannelIdentity(companyId, channel, channelIdentifier) {
  if (!companyId || !channel || !channelIdentifier) {
    throw new Error('Faltan parámetros obligatorios para registrar la identidad de canal.');
  }

  const normalizedChannel = String(channel).trim().toLowerCase();
  const cleanIdentifier = normalizeChannelIdentifier(normalizedChannel, channelIdentifier);

  // Verificar que la empresa exista
  const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
  if (!company) {
    throw new Error(`Empresa no encontrada con id: ${companyId}`);
  }

  // Verificar que el identificador no esté ya asignado a otra empresa
  const existing = db.prepare(
    'SELECT id, company_id FROM channel_identities WHERE channel = ? AND channel_identifier = ?'
  ).get(normalizedChannel, cleanIdentifier);

  if (existing) {
    if (existing.company_id === companyId) {
      // Ya pertenece a esta empresa, asegurar que esté activa
      db.prepare('UPDATE channel_identities SET is_active = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), existing.id);
      return existing.id;
    }
    throw new Error(
      `El identificador '${cleanIdentifier}' en canal '${normalizedChannel}' ya está vinculado a otra empresa.`
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO channel_identities (id, company_id, channel, channel_identifier, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(id, companyId, normalizedChannel, cleanIdentifier, now, now);

  return id;
}

/**
 * Desactiva una identidad de canal (impedirá futuras autenticaciones).
 */
export function deactivateChannelIdentity(channel, channelIdentifier) {
  const normalizedChannel = String(channel).trim().toLowerCase();
  const cleanIdentifier = normalizeChannelIdentifier(normalizedChannel, channelIdentifier);
  const now = new Date().toISOString();

  const res = db.prepare(`
    UPDATE channel_identities SET is_active = 0, updated_at = ?
    WHERE channel = ? AND channel_identifier = ?
  `).run(now, normalizedChannel, cleanIdentifier);

  return res.changes > 0;
}

/**
 * Reactiva una identidad de canal previamente desactivada.
 */
export function reactivateChannelIdentity(channel, channelIdentifier) {
  const normalizedChannel = String(channel).trim().toLowerCase();
  const cleanIdentifier = normalizeChannelIdentifier(normalizedChannel, channelIdentifier);
  const now = new Date().toISOString();

  const res = db.prepare(`
    UPDATE channel_identities SET is_active = 1, updated_at = ?
    WHERE channel = ? AND channel_identifier = ?
  `).run(now, normalizedChannel, cleanIdentifier);

  return res.changes > 0;
}

/**
 * Lista todas las identidades de canal asociadas a una empresa.
 */
export function listChannelIdentities(companyId) {
  return db.prepare(`
    SELECT id, company_id, channel, channel_identifier, is_active, created_at, updated_at
    FROM channel_identities
    WHERE company_id = ?
    ORDER BY created_at ASC
  `).all(companyId);
}

/**
 * Crea una empresa nueva con su identidad de canal, usuario y membresía en una sola transacción atómica.
 */
export function createCompanyWithIdentity({
  phone,
  name = null,
  fiscalName = null,
  cif = null,
  ownerName = null,
  trade = 'Reformas y Construcción',
  email = null
}) {
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone) throw new Error('El teléfono es obligatorio para registrar la empresa.');

  const companyId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const channelIdentityId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.exec('BEGIN;');
  try {
    // 1. Insertar en companies
    db.prepare(`
      INSERT INTO companies (
        id, phone, name, fiscal_name, owner_name, cif, trade, email, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(companyId, cleanPhone, name, fiscalName || name, ownerName, cif, trade, email, now, now);

    // 2. Insertar en users
    db.prepare(`
      INSERT INTO users (id, name, email, phone, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(userId, ownerName || name || 'Propietario', email, cleanPhone, now, now);

    // 3. Insertar en memberships (OWNER)
    db.prepare(`
      INSERT INTO memberships (id, user_id, company_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?, ?)
    `).run(membershipId, userId, companyId, now, now);

    // 4. Insertar en channel_identities (WhatsApp)
    db.prepare(`
      INSERT INTO channel_identities (id, company_id, channel, channel_identifier, is_active, created_at, updated_at)
      VALUES (?, ?, 'whatsapp', ?, 1, ?, ?)
    `).run(channelIdentityId, companyId, cleanPhone, now, now);

    db.exec('COMMIT;');

    return {
      companyId,
      userId,
      membershipId,
      channelIdentityId,
      phone: cleanPhone
    };
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (rb) {}
    throw err;
  }
}

/**
 * Blindaje contra inyección de company_id por parte de la IA o usuario.
 * Garantiza que ninguna propiedad externa suplante la autoridad del contexto autenticado.
 */
export function sanitizeTenantPayload(payload, authenticatedContext) {
  if (!authenticatedContext || !authenticatedContext.companyId) {
    throw new Error('🛑 Contexto autenticado inválido al sanitizar payload.');
  }

  if (!payload || typeof payload !== 'object') {
    return { companyId: authenticatedContext.companyId };
  }

  // Detectar y neutralizar intentos de manipulación del company_id
  const copy = { ...payload };
  if (copy.company_id && copy.company_id !== authenticatedContext.companyId) {
    console.warn(`⚠️ [DEFENSA ACTIVA] Intento de inyección de company_id detectado: '${copy.company_id}' ignorado. Se fuerza '${authenticatedContext.companyId}'.`);
  }
  if (copy.companyId && copy.companyId !== authenticatedContext.companyId) {
    console.warn(`⚠️ [DEFENSA ACTIVA] Intento de inyección de companyId detectado: '${copy.companyId}' ignorado. Se fuerza '${authenticatedContext.companyId}'.`);
  }

  copy.company_id = authenticatedContext.companyId;
  copy.companyId = authenticatedContext.companyId;

  return copy;
}
