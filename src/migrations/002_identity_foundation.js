/**
 * PresuVoz — Migración 002: Identity Foundation (Company ID, Channel Identities, Users, Memberships)
 * 
 * Versión: 2
 * Fecha: 2026-09-27
 * 
 * Contrato:
 * Establece la nueva capa canónica de identidad multi-canal de PresuVoz:
 * - Añade `id` (UUID canónico estable) a la tabla `companies`.
 * - Crea `channel_identities` (vínculo único canal -> empresa).
 * - Crea `users` (base estructural de usuarios/propietarios).
 * - Crea `memberships` (roles y permisos de usuarios en empresas).
 * - Migra de forma determinista e idempotente todas las empresas existentes sin pérdida de datos.
 * 
 * Arquitectura Forward-Only:
 * - Idempotente y aditiva (sin DROP ni eliminación de datos legados).
 */

import crypto from 'node:crypto';

export const migration = {
  version: 2,
  name: '002_identity_foundation',
  up: (db) => {
    // 1. Asegurar columna id en companies
    const compCols = db.prepare('PRAGMA table_info("companies")').all();
    if (!compCols.some(c => c.name === 'id')) {
      db.exec('ALTER TABLE companies ADD COLUMN id TEXT;');
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_id ON companies(id);');

    // 2. Crear tabla channel_identities
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_identities (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_identifier TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        CONSTRAINT uq_channel_identity UNIQUE (channel, channel_identifier)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_identities_lookup ON channel_identities(channel, channel_identifier, is_active);
      CREATE INDEX IF NOT EXISTS idx_channel_identities_company ON channel_identities(company_id);
    `);

    // 3. Crear tabla users
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        phone TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    `);

    // 4. Crear tabla memberships
    db.exec(`
      CREATE TABLE IF NOT EXISTS memberships (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'OWNER',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        CONSTRAINT uq_user_company UNIQUE (user_id, company_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_company_user ON memberships(company_id, user_id);
    `);

    // 5. Migración e inicialización determinista de empresas existentes
    const existingCompanies = db.prepare('SELECT * FROM companies').all();
    const now = new Date().toISOString();

    for (const comp of existingCompanies) {
      const cleanPhone = String(comp.phone).replace(/\D/g, '');
      let companyId = comp.id;

      // Asignar company_id UUID si aún no lo tiene
      if (!companyId) {
        companyId = crypto.randomUUID();
        db.prepare('UPDATE companies SET id = ? WHERE phone = ?').run(companyId, comp.phone);
      }

      // Asegurar channel_identity para WhatsApp
      if (cleanPhone) {
        const existingChannel = db.prepare(
          'SELECT id FROM channel_identities WHERE channel = ? AND channel_identifier = ?'
        ).get('whatsapp', cleanPhone);

        if (!existingChannel) {
          db.prepare(`
            INSERT INTO channel_identities (id, company_id, channel, channel_identifier, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)
          `).run(crypto.randomUUID(), companyId, 'whatsapp', cleanPhone, now, now);
        }

        // Asegurar user para el propietario
        let user = db.prepare('SELECT id FROM users WHERE phone = ?').get(cleanPhone);
        let userId = user ? user.id : null;
        if (!userId) {
          userId = crypto.randomUUID();
          const userName = comp.owner_name || comp.name || 'Propietario';
          db.prepare(`
            INSERT INTO users (id, name, email, phone, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
          `).run(userId, userName, comp.email || null, cleanPhone, now, now);
        }

        // Asegurar membership con rol OWNER
        const existingMembership = db.prepare(
          'SELECT id FROM memberships WHERE user_id = ? AND company_id = ?'
        ).get(userId, companyId);

        if (!existingMembership) {
          db.prepare(`
            INSERT INTO memberships (id, user_id, company_id, role, status, created_at, updated_at)
            VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?, ?)
          `).run(crypto.randomUUID(), userId, companyId, now, now);
        }
      }
    }
  }
};
