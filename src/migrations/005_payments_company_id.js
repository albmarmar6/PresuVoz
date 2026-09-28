/**
 * PresuVoz — Migración 005: Payments Company ID & Payment Allocations
 * 
 * Versión: 5
 * Fecha: 2026-09-28
 * 
 * Contrato:
 * 1. Establece `company_id` como identificador canónico de tenant para `payments`:
 *    - Añade columna `company_id` con FOREIGN KEY a `companies(id)`.
 *    - Crea índices de rendimiento tenant-scoped:
 *        `idx_payments_company_id`
 *        `idx_payments_company_id_id`
 *        `idx_payments_company_id_created`
 * 2. Crea la tabla canónica `payment_allocations` para desacoplar el movimiento de dinero
 *    de su aplicación a facturas:
 *        `id TEXT PRIMARY KEY`
 *        `payment_id TEXT REFERENCES payments(id)`
 *        `invoice_id TEXT REFERENCES invoices(id)`
 *        `company_id TEXT REFERENCES companies(id)`
 *        `amount REAL NOT NULL`
 *        `allocated_at TEXT NOT NULL`
 *        `created_at TEXT NOT NULL`
 *        `updated_at TEXT NOT NULL`
 *    - Crea índices de tenant isolation y búsqueda en `payment_allocations`.
 * 3. Backfill determinista de `payments`:
 *    - Prioridad 1: Si el pago referencia una factura existente -> hereda `invoice.company_id`.
 *    - Prioridad 2: Si el pago referencia un presupuesto existente -> hereda `budget.company_id`.
 *    - Prioridad 3: Si solo tiene `company_phone` -> resuelve `companies.phone -> companies.id`.
 *    - Aborta inmediatamente si detecta huérfanos o contradicciones de tenant.
 * 4. Reconstrucción determinista de allocations históricas:
 *    - Exclusivamente cuando `payment.budget_id` coincida de forma unívoca con una factura existente
 *      del mismo tenant (`invoice.company_id == payment.company_id`).
 *    - En ningún caso inventa allocations para pagos asociados a presupuestos o sin factura.
 * 5. Arquitectura Forward-Only:
 *    - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

import crypto from 'node:crypto';

export const migration = {
  version: 5,
  name: '005_payments_company_id',
  up: (db) => {
    // 1. Asegurar columna company_id en payments
    const paymentCols = db.prepare('PRAGMA table_info("payments")').all();
    const hasCompanyId = paymentCols.some(c => c.name === 'company_id');

    if (!hasCompanyId) {
      db.exec('ALTER TABLE payments ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE CASCADE;');
    }

    // 2. Índices de rendimiento y aislamiento para payments
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_payments_company_id ON payments(company_id);
      CREATE INDEX IF NOT EXISTS idx_payments_company_id_id ON payments(company_id, id);
      CREATE INDEX IF NOT EXISTS idx_payments_company_id_created ON payments(company_id, created_at DESC);
    `);

    // 3. Crear tabla payment_allocations
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_allocations (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        invoice_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        amount REAL NOT NULL,
        allocated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_allocations_company_id ON payment_allocations(company_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_payment_id ON payment_allocations(payment_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_invoice_id ON payment_allocations(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_company_payment ON payment_allocations(company_id, payment_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_company_invoice ON payment_allocations(company_id, invoice_id);
    `);

    // 4. Backfill determinista de payments existentes
    const allPayments = db.prepare(`
      SELECT id, budget_id, company_phone, company_id, amount, data_json, created_at 
      FROM payments
    `).all();

    const updatePaymentStmt = db.prepare('UPDATE payments SET company_id = ?, data_json = ? WHERE id = ?');
    const now = new Date().toISOString();

    for (const p of allPayments) {
      let targetCompanyId = p.company_id;
      const rawTargetId = p.budget_id ? String(p.budget_id).trim() : '';

      // Determinar tenant según orden de precedencia estricto
      if (rawTargetId) {
        // Prioridad 1: ¿Coincide con una factura existente?
        const linkedInvoice = db.prepare('SELECT id, company_id, company_phone FROM invoices WHERE id = ?').get(rawTargetId);
        if (linkedInvoice) {
          if (!linkedInvoice.company_id) {
            throw new Error(`❌ [Migración 005] Factura '${linkedInvoice.id}' referenciada por pago '${p.id}' no tiene company_id.`);
          }
          // Verificar coherencia con company_phone del pago si existe
          if (p.company_phone) {
            const cleanPhone = String(p.company_phone).replace(/\D/g, '');
            const compByPhone = db.prepare(`
              SELECT id FROM companies 
              WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
              LIMIT 1
            `).get(p.company_phone, cleanPhone);

            if (compByPhone && compByPhone.id !== linkedInvoice.company_id) {
              throw new Error(
                `❌ [Migración 005] Contradicción crítica: El pago '${p.id}' tiene teléfono '${p.company_phone}' (empresa ${compByPhone.id}) pero su factura referenciada '${linkedInvoice.id}' pertenece a empresa ${linkedInvoice.company_id}. ABORTANDO.`
              );
            }
          }
          targetCompanyId = linkedInvoice.company_id;
        } else {
          // Prioridad 2: ¿Coincide con un presupuesto existente?
          const linkedBudget = db.prepare('SELECT id, company_id, company_phone FROM budgets WHERE id = ?').get(rawTargetId);
          if (linkedBudget) {
            if (!linkedBudget.company_id) {
              throw new Error(`❌ [Migración 005] Presupuesto '${linkedBudget.id}' referenciado por pago '${p.id}' no tiene company_id.`);
            }
            if (p.company_phone) {
              const cleanPhone = String(p.company_phone).replace(/\D/g, '');
              const compByPhone = db.prepare(`
                SELECT id FROM companies 
                WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
                LIMIT 1
              `).get(p.company_phone, cleanPhone);

              if (compByPhone && compByPhone.id !== linkedBudget.company_id) {
                throw new Error(
                  `❌ [Migración 005] Contradicción crítica: El pago '${p.id}' tiene teléfono '${p.company_phone}' (empresa ${compByPhone.id}) pero su presupuesto referenciado '${linkedBudget.id}' pertenece a empresa ${linkedBudget.company_id}. ABORTANDO.`
                );
              }
            }
            targetCompanyId = linkedBudget.company_id;
          }
        }
      }

      // Prioridad 3: Si aún no se determinó por factura o presupuesto, resolver por company_phone
      if (!targetCompanyId) {
        if (!p.company_phone || String(p.company_phone).trim() === '') {
          throw new Error(`❌ [Migración 005] Pago huérfano '${p.id}' sin referencia a factura/presupuesto ni teléfono de empresa.`);
        }
        const cleanPhone = String(p.company_phone).replace(/\D/g, '');
        const compByPhone = db.prepare(`
          SELECT id FROM companies 
          WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
          LIMIT 1
        `).get(p.company_phone, cleanPhone);

        if (!compByPhone || !compByPhone.id) {
          throw new Error(`❌ [Migración 005] Pago huérfano '${p.id}' con teléfono '${p.company_phone}' no registrado en 'companies'.`);
        }
        targetCompanyId = compByPhone.id;
      }

      // Sincronizar data_json
      let dataJson = p.data_json;
      try {
        if (dataJson) {
          const parsed = JSON.parse(dataJson);
          if (parsed.companyId !== targetCompanyId) {
            parsed.companyId = targetCompanyId;
            dataJson = JSON.stringify(parsed);
          }
        }
      } catch (e) {}

      updatePaymentStmt.run(targetCompanyId, dataJson, p.id);

      // 5. Reconstrucción determinista de allocations históricas
      // Solo si el pago referencia directamente a una factura existente del mismo tenant
      if (rawTargetId) {
        const linkedInvoice = db.prepare('SELECT id, company_id FROM invoices WHERE id = ?').get(rawTargetId);
        if (linkedInvoice && linkedInvoice.company_id === targetCompanyId) {
          const existingAlloc = db.prepare(
            'SELECT id FROM payment_allocations WHERE payment_id = ? AND invoice_id = ?'
          ).get(p.id, linkedInvoice.id);

          if (!existingAlloc) {
            const allocId = `ALLOC-${p.id}`;
            const allocDate = p.created_at || now;
            db.prepare(`
              INSERT INTO payment_allocations (id, payment_id, invoice_id, company_id, amount, allocated_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(allocId, p.id, linkedInvoice.id, targetCompanyId, Number(p.amount || 0), allocDate, now, now);
          }
        }
      }
    }

    // 6. Validación de consistencia final
    const unmigratedCount = db.prepare("SELECT count(*) as count FROM payments WHERE company_id IS NULL OR company_id = ''").get().count;
    if (unmigratedCount > 0) {
      throw new Error(`❌ [Migración 005] Inconsistencia: Quedan ${unmigratedCount} pagos sin company_id asignado.`);
    }

    // Validar invariante de allocations: allocation.company_id == payment.company_id
    const badAllocPayment = db.prepare(`
      SELECT a.id FROM payment_allocations a
      JOIN payments p ON a.payment_id = p.id
      WHERE a.company_id != p.company_id
    `).all();
    if (badAllocPayment.length > 0) {
      throw new Error(`❌ [Migración 005] Violación de invariante: Existen allocations cuyo company_id no coincide con el payment vinculado.`);
    }

    // Validar invariante de allocations: allocation.company_id == invoice.company_id
    const badAllocInvoice = db.prepare(`
      SELECT a.id FROM payment_allocations a
      JOIN invoices i ON a.invoice_id = i.id
      WHERE a.company_id != i.company_id
    `).all();
    if (badAllocInvoice.length > 0) {
      throw new Error(`❌ [Migración 005] Violación de invariante: Existen allocations cuyo company_id no coincide con la invoice vinculada.`);
    }
  }
};
