/**
 * PresuVoz — Migración 014: Messages Company ID & Tenant Isolation
 * 
 * Versión: 14
 * Fecha: 2026-09-30
 * 
 * Contrato:
 * 1. Establece la identidad canónica multi-tenant para `messages`:
 *    - Añade columna `company_id TEXT REFERENCES companies(id) ON DELETE RESTRICT`.
 *      Permite NULL para mensajes no autenticados o con status = 'REJECTED'.
 *      ON DELETE RESTRICT previene la eliminación accidental del historial de mensajes al borrar una empresa.
 *    - Conserva `id TEXT PRIMARY KEY` intacto.
 *    - Conserva `whatsapp_message_id TEXT UNIQUE` para deduplicación global incondicional.
 *    - Conserva `business_id TEXT`, `chat_id TEXT`, `sender_phone TEXT`, `content TEXT`, `timestamp TEXT`, `status TEXT`.
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_messages_company_status` (company_id, status)
 *        `idx_messages_company_time` (company_id, timestamp)
 *        `idx_messages_chat_status` (chat_id, status)
 *        `idx_messages_wam_id` (whatsapp_message_id)
 * 2. Backfill determinista de `messages`:
 *    - Resuelve `business_id` y `sender_phone` contra:
 *      1. UUID directo en `companies(id)`.
 *      2. `companies.phone` exacto o normalizado.
 *      3. `companies.phone_contact` (ej. LIDs de WhatsApp como 82987509096647).
 *      4. `channel_identities.channel_identifier`.
 *    - Si un mensaje con status 'REJECTED' no tiene empresa asociada, se conserva legítimamente con `company_id = NULL`.
 *    - Si un mensaje activo/procesado no puede asociarse inequívocamente a una empresa: ABORTA INMEDIATAMENTE (fail-closed).
 *    - Si múltiples empresas distintas coinciden (ambigüedad): ABORTA INMEDIATAMENTE (fail-closed).
 *    - Valida que el recuento final de filas coincida exactamente con el recuento original.
 * 3. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 14,
  name: '014_messages_company_id',
  up: (db) => {
    // 1. Comprobar si la tabla ya existe
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get();

    if (!tableExists) {
      // Base de datos nueva: crear directamente con el esquema canónico
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          whatsapp_message_id TEXT UNIQUE,
          company_id TEXT,
          business_id TEXT,
          chat_id TEXT,
          sender_phone TEXT,
          content TEXT,
          timestamp TEXT,
          status TEXT,
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_company_status ON messages(company_id, status);
        CREATE INDEX IF NOT EXISTS idx_messages_company_time ON messages(company_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_chat_status ON messages(chat_id, status);
        CREATE INDEX IF NOT EXISTS idx_messages_wam_id ON messages(whatsapp_message_id);
      `);
      return;
    }

    const cols = db.prepare('PRAGMA table_info("messages")').all();
    const companyIdCol = cols.find(c => c.name === 'company_id');
    if (companyIdCol) {
      // Ya migrada
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_company_status ON messages(company_id, status);
        CREATE INDEX IF NOT EXISTS idx_messages_company_time ON messages(company_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_chat_status ON messages(chat_id, status);
        CREATE INDEX IF NOT EXISTS idx_messages_wam_id ON messages(whatsapp_message_id);
      `);
      return;
    }

    // 2. Obtener todas las filas existentes
    const rows = db.prepare('SELECT * FROM messages').all();

    // 3. Crear tabla temporal messages_new
    db.exec(`
      CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        whatsapp_message_id TEXT UNIQUE,
        company_id TEXT,
        business_id TEXT,
        chat_id TEXT,
        sender_phone TEXT,
        content TEXT,
        timestamp TEXT,
        status TEXT,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);

    // Helper determinista para resolver la empresa propietaria del mensaje
    const findCompaniesForMessage = (row) => {
      const clean = (val) => String(val || '').replace(/\D/g, '');
      const rawBiz = String(row.business_id || '').trim();
      const cleanBiz = clean(rawBiz);
      const rawSender = String(row.sender_phone || '').trim();
      const cleanSender = clean(rawSender);

      const matchedCompanyIds = new Set();

      // 0. Si ya viniera un company_id UUID en la fila
      if (row.company_id && typeof row.company_id === 'string' && row.company_id.includes('-')) {
        const byId = db.prepare('SELECT id FROM companies WHERE id = ?').get(row.company_id);
        if (byId) matchedCompanyIds.add(byId.id);
      }

      // 0b. Si business_id es un UUID directo
      if (rawBiz.length === 36 && rawBiz.includes('-')) {
        const byId = db.prepare('SELECT id FROM companies WHERE id = ?').get(rawBiz);
        if (byId) matchedCompanyIds.add(byId.id);
      }

      // 1. Búsqueda por phone en companies
      if (cleanBiz) {
        const byPhone = db.prepare(`
          SELECT id FROM companies 
          WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
        `).all(rawBiz, cleanBiz);
        byPhone.forEach(c => matchedCompanyIds.add(c.id));
      }

      // 2. Búsqueda por phone_contact en companies (ej. LIDs de WhatsApp)
      if (cleanBiz) {
        const byPhoneContact = db.prepare(`
          SELECT id FROM companies 
          WHERE phone_contact = ? OR REPLACE(REPLACE(REPLACE(phone_contact, ' ', ''), '-', ''), '+', '') = ?
        `).all(rawBiz, cleanBiz);
        byPhoneContact.forEach(c => matchedCompanyIds.add(c.id));
      }

      // 3. Búsqueda por sender_phone si difiere de business_id
      if (cleanSender && cleanSender !== cleanBiz) {
        const bySender = db.prepare(`
          SELECT id FROM companies 
          WHERE phone = ? OR phone_contact = ?
        `).all(cleanSender, cleanSender);
        bySender.forEach(c => matchedCompanyIds.add(c.id));
      }

      // 4. Búsqueda en channel_identities (canal de comunicación activo o histórico)
      const hasChannelIdentities = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_identities'").get();
      if (hasChannelIdentities) {
        if (cleanBiz) {
          const byChannel = db.prepare('SELECT company_id as id FROM channel_identities WHERE channel_identifier = ?').all(cleanBiz);
          byChannel.forEach(c => matchedCompanyIds.add(c.id));
        }
        if (cleanSender && cleanSender !== cleanBiz) {
          const byChannelSender = db.prepare('SELECT company_id as id FROM channel_identities WHERE channel_identifier = ?').all(cleanSender);
          byChannelSender.forEach(c => matchedCompanyIds.add(c.id));
        }
      }

      return Array.from(matchedCompanyIds);
    };

    const insertStmt = db.prepare(`
      INSERT INTO messages_new (
        id, whatsapp_message_id, company_id, business_id,
        chat_id, sender_phone, content, timestamp, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of rows) {
      let resolvedCompanyId = null;

      const matches = findCompaniesForMessage(row);

      if (matches.length > 1) {
        throw new Error(
          `❌ [Migración 014] Ambigüedad crítica: Múltiples empresas coinciden para el mensaje '${row.id}' (business_id='${row.business_id}', sender_phone='${row.sender_phone}').`
        );
      } else if (matches.length === 1) {
        resolvedCompanyId = matches[0];
      } else {
        // Ninguna empresa coincide
        if (row.status === 'REJECTED') {
          // Mensaje no autenticado rechazado legítimamente
          resolvedCompanyId = null;
        } else {
          // Mensaje huérfano con estado activo
          throw new Error(
            `❌ [Migración 014] Fallo crítico de integridad: Mensaje '${row.id}' con business_id '${row.business_id}' huérfano. No existe empresa asociada en companies (fail-closed).`
          );
        }
      }

      insertStmt.run(
        row.id,
        row.whatsapp_message_id,
        resolvedCompanyId,
        row.business_id,
        row.chat_id,
        row.sender_phone,
        row.content,
        row.timestamp,
        row.status
      );
    }

    // 4. Validación de recuento exacto de filas
    const countNew = db.prepare('SELECT COUNT(*) as count FROM messages_new').get().count;
    if (countNew !== rows.length) {
      throw new Error(
        `❌ [Migración 014] Discrepancia en recuento de filas tras migración de messages: original=${rows.length}, nuevo=${countNew}. Abortando.`
      );
    }

    // 5. Reemplazar tabla atómicamente y crear índices
    db.exec(`
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;

      CREATE INDEX IF NOT EXISTS idx_messages_company_status ON messages(company_id, status);
      CREATE INDEX IF NOT EXISTS idx_messages_company_time ON messages(company_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_status ON messages(chat_id, status);
      CREATE INDEX IF NOT EXISTS idx_messages_wam_id ON messages(whatsapp_message_id);
    `);
  }
};
