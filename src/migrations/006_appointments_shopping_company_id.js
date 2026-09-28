/**
 * PresuVoz — Migración 006: Appointments & Shopping Items Company ID
 * 
 * Versión: 6
 * Fecha: 2026-09-28
 * 
 * Contrato:
 * 1. Establece `company_id` como identificador canónico de tenant para `appointments`:
 *    - Añade columna `company_id` con FOREIGN KEY a `companies(id) ON DELETE CASCADE`.
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_appointments_company_id`
 *        `idx_appointments_company_id_id`
 *        `idx_appointments_company_date`
 *        `idx_appointments_company_status`
 * 2. Establece `company_id` como identificador canónico de tenant para `shopping_items`:
 *    - Añade columna `company_id` con FOREIGN KEY a `companies(id) ON DELETE CASCADE`.
 *    - Crea índices de rendimiento y aislamiento:
 *        `idx_shopping_items_company_id`
 *        `idx_shopping_items_company_id_id`
 *        `idx_shopping_items_company_status`
 * 3. Backfill determinista de `appointments`:
 *    - Resuelve `appointments.company_phone -> companies.phone -> companies.id`.
 *    - Aborta inmediatamente si detecta huérfanos o teléfonos no registrados.
 * 4. Backfill determinista de `shopping_items`:
 *    - Prioridad 1: Si tiene `budget_id`, resuelve contra `budgets.id -> budgets.company_id`.
 *      Valida que si existe `company_phone`, coincida unívocamente con el tenant del presupuesto.
 *      Aborta inmediatamente si hay discrepancia de tenant o si el presupuesto no existe / no tiene company_id.
 *    - Prioridad 2: Si no tiene `budget_id`, resuelve `company_phone -> companies.phone -> companies.id`.
 *    - Aborta si no puede resolver el tenant unívocamente.
 * 5. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 6,
  name: '006_appointments_shopping_company_id',
  up: (db) => {
    // ── 1. Columnas company_id en appointments y shopping_items ───────────
    const appointmentCols = db.prepare('PRAGMA table_info("appointments")').all();
    const hasAptCompanyId = appointmentCols.some(c => c.name === 'company_id');
    if (!hasAptCompanyId) {
      db.exec('ALTER TABLE appointments ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;');
    }

    const shoppingCols = db.prepare('PRAGMA table_info("shopping_items")').all();
    const hasShopCompanyId = shoppingCols.some(c => c.name === 'company_id');
    if (!hasShopCompanyId) {
      db.exec('ALTER TABLE shopping_items ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;');
    }

    // ── 2. Índices de rendimiento y aislamiento tenant-scoped ─────────────
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_appointments_company_id ON appointments(company_id);
      CREATE INDEX IF NOT EXISTS idx_appointments_company_id_id ON appointments(company_id, id);
      CREATE INDEX IF NOT EXISTS idx_appointments_company_date ON appointments(company_id, date, time);
      CREATE INDEX IF NOT EXISTS idx_appointments_company_status ON appointments(company_id, status);

      CREATE INDEX IF NOT EXISTS idx_shopping_items_company_id ON shopping_items(company_id);
      CREATE INDEX IF NOT EXISTS idx_shopping_items_company_id_id ON shopping_items(company_id, id);
      CREATE INDEX IF NOT EXISTS idx_shopping_items_company_status ON shopping_items(company_id, status);
    `);

    // Helper para buscar empresa por teléfono exacto o limpio
    const findCompanyByPhone = (rawPhone) => {
      if (!rawPhone) return null;
      const clean = String(rawPhone).replace(/\D/g, '');
      return db.prepare(`
        SELECT id FROM companies 
        WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
        LIMIT 1
      `).get(rawPhone, clean);
    };

    // ── 3. Backfill determinista de appointments ──────────────────────────
    const unmigratedAppointments = db.prepare(`
      SELECT id, company_phone, company_id
      FROM appointments
      WHERE company_id IS NULL
    `).all();

    const updateAptStmt = db.prepare('UPDATE appointments SET company_id = ? WHERE id = ?');

    for (const apt of unmigratedAppointments) {
      if (!apt.company_phone) {
        throw new Error(`❌ [Migración 006] Cita '${apt.id}' no tiene company_phone ni company_id.`);
      }

      const comp = findCompanyByPhone(apt.company_phone);
      if (!comp || !comp.id) {
        throw new Error(
          `❌ [Migración 006] Fallo crítico de integridad: Cita '${apt.id}' huérfana. No existe empresa asociada al teléfono '${apt.company_phone}'.`
        );
      }

      updateAptStmt.run(comp.id, apt.id);
    }

    // ── 4. Backfill determinista de shopping_items ────────────────────────
    const unmigratedShopping = db.prepare(`
      SELECT id, budget_id, company_phone, company_id
      FROM shopping_items
      WHERE company_id IS NULL
    `).all();

    const updateShopStmt = db.prepare('UPDATE shopping_items SET company_id = ? WHERE id = ?');

    for (const item of unmigratedShopping) {
      let resolvedCompanyId = null;

      if (item.budget_id) {
        // Prioridad 1: Resolver por budget_id
        const linkedBudget = db.prepare('SELECT id, company_id, company_phone FROM budgets WHERE id = ?').get(item.budget_id);
        if (!linkedBudget) {
          throw new Error(
            `❌ [Migración 006] Fallo crítico: Artículo de compra '${item.id}' referencia un presupuesto inexistente '${item.budget_id}'.`
          );
        }
        if (!linkedBudget.company_id) {
          throw new Error(
            `❌ [Migración 006] Presupuesto '${linkedBudget.id}' referenciado por artículo '${item.id}' no tiene company_id.`
          );
        }

        // Si además tiene company_phone, verificar que no haya contradicción
        if (item.company_phone) {
          const compFromPhone = findCompanyByPhone(item.company_phone);
          if (compFromPhone && compFromPhone.id !== linkedBudget.company_id) {
            throw new Error(
              `❌ [Migración 006] Mismatch de tenant: Artículo de compra '${item.id}' tiene company_phone '${item.company_phone}' (${compFromPhone.id}) pero su presupuesto '${item.budget_id}' pertenece a ${linkedBudget.company_id}.`
            );
          }
        }

        resolvedCompanyId = linkedBudget.company_id;
      } else if (item.company_phone) {
        // Prioridad 2: Resolver por company_phone
        const comp = findCompanyByPhone(item.company_phone);
        if (!comp || !comp.id) {
          throw new Error(
            `❌ [Migración 006] Fallo crítico de integridad: Artículo de compra '${item.id}' huérfano. No existe empresa asociada al teléfono '${item.company_phone}'.`
          );
        }
        resolvedCompanyId = comp.id;
      } else {
        throw new Error(
          `❌ [Migración 006] Fallo crítico: Artículo de compra '${item.id}' no tiene budget_id ni company_phone.`
        );
      }

      updateShopStmt.run(resolvedCompanyId, item.id);
    }

    // ── 5. Verificación final de consistencia ─────────────────────────────
    const pendingApts = db.prepare('SELECT count(*) as c FROM appointments WHERE company_id IS NULL').get().c;
    if (pendingApts > 0) {
      throw new Error(`❌ [Migración 006] Inconsistencia: Quedan ${pendingApts} citas sin company_id asignado.`);
    }

    const pendingShop = db.prepare('SELECT count(*) as c FROM shopping_items WHERE company_id IS NULL').get().c;
    if (pendingShop > 0) {
      throw new Error(`❌ [Migración 006] Inconsistencia: Quedan ${pendingShop} artículos de compra sin company_id asignado.`);
    }
  }
};
