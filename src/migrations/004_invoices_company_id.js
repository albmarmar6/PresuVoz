/**
 * PresuVoz — Migración 004: Invoices Company ID & Tenant Scoping
 * 
 * Versión: 4
 * Fecha: 2026-09-27
 * 
 * Contrato:
 * Establece `company_id` como identificador canónico del tenant para `invoices`:
 * - Añade columna `company_id` a `invoices` con FOREIGN KEY a `companies(id)`.
 * - Crea índices `idx_invoices_company_id`, `idx_invoices_company_id_id`, `idx_invoices_company_id_created`.
 * - Backfill determinista:
 *     A) Si la factura tiene `budget_id` asociado: hereda determinísticamente `budget.company_id`.
 *     B) Si la factura no tiene `budget_id`: resuelve `invoices.company_phone` -> `companies.phone` -> `companies.id`.
 * - Valida la invariante estricta: `invoices.company_id == budgets.company_id` para toda factura con presupuesto.
 * - Si detecta inconsistencias entre `company_phone` de la factura y del presupuesto, o si encuentra facturas
 *   huérfanas sin empresa verificable: ABORTA inmediatamente la migración.
 * - Preserva `company_phone` para dual-write y compatibilidad transitoria.
 * 
 * Arquitectura Forward-Only:
 * - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 4,
  name: '004_invoices_company_id',
  up: (db) => {
    // 1. Asegurar columna company_id en invoices
    const invoiceCols = db.prepare('PRAGMA table_info("invoices")').all();
    const hasCompanyId = invoiceCols.some(c => c.name === 'company_id');

    if (!hasCompanyId) {
      db.exec('ALTER TABLE invoices ADD COLUMN company_id TEXT REFERENCES companies(id);');
    }

    // 2. Índices de rendimiento y aislamiento para tenant scoping
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_invoices_company_id ON invoices(company_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_company_id_id ON invoices(company_id, id);
      CREATE INDEX IF NOT EXISTS idx_invoices_company_id_created ON invoices(company_id, created_at DESC);
    `);

    // 3. Backfill determinista de facturas existentes
    const allInvoices = db.prepare(`
      SELECT id, budget_id, company_phone, company_id, data_json 
      FROM invoices
    `).all();

    const updateStmt = db.prepare('UPDATE invoices SET company_id = ?, data_json = ? WHERE id = ?');

    for (const inv of allInvoices) {
      let targetCompanyId = inv.company_id;
      const hasBudgetId = inv.budget_id && String(inv.budget_id).trim() !== '';

      if (hasBudgetId) {
        const cleanBudgetId = String(inv.budget_id).trim();
        const budget = db.prepare('SELECT id, company_id, company_phone FROM budgets WHERE id = ?').get(cleanBudgetId);

        if (budget) {
          if (!budget.company_id) {
            throw new Error(
              `❌ [Migración 004] Inconsistencia en presupuesto asociado: El presupuesto '${budget.id}' referenciado por la factura '${inv.id}' no tiene 'company_id' poblado.`
            );
          }

          // Validar que si la factura tiene company_phone, no contradiga la empresa del presupuesto
          if (inv.company_phone) {
            const cleanInvPhone = String(inv.company_phone).replace(/\D/g, '');
            const companyOfPhone = db.prepare(`
              SELECT id FROM companies 
              WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
              LIMIT 1
            `).get(inv.company_phone, cleanInvPhone);

            if (companyOfPhone && companyOfPhone.id !== budget.company_id) {
              throw new Error(
                `❌ [Migración 004] Contradicción crítica de tenant: La factura '${inv.id}' tiene company_phone '${inv.company_phone}' (perteneciente a empresa '${companyOfPhone.id}'), pero su presupuesto vinculado '${budget.id}' pertenece a la empresa '${budget.company_id}'. ABORTANDO para proteger la integridad.`
              );
            }
          }

          targetCompanyId = budget.company_id;
        } else {
          // Factura con budget_id inexistente en budgets
          // Tratar según el modelo actual: intentar resolver por company_phone de la factura sin inventar datos
          if (inv.company_phone) {
            const cleanInvPhone = String(inv.company_phone).replace(/\D/g, '');
            const company = db.prepare(`
              SELECT id FROM companies 
              WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
              LIMIT 1
            `).get(inv.company_phone, cleanInvPhone);

            if (!company || !company.id) {
              throw new Error(
                `❌ [Migración 004] Factura '${inv.id}' tiene budget_id inexistente '${cleanBudgetId}' y company_phone '${inv.company_phone}' no registrado en companies. No se puede determinar tenant inequívocamente.`
              );
            }
            targetCompanyId = company.id;
          } else {
            throw new Error(
              `❌ [Migración 004] Factura '${inv.id}' tiene budget_id inexistente '${cleanBudgetId}' y carece de company_phone. Imposible determinar tenant.`
            );
          }
        }
      } else {
        // Factura sin budget_id: resolver obligatoriamente mediante company_phone
        if (!inv.company_phone || String(inv.company_phone).trim() === '') {
          throw new Error(
            `❌ [Migración 004] Factura huérfana '${inv.id}' sin presupuesto ni company_phone. Imposible determinar tenant canónico.`
          );
        }

        const cleanPhone = String(inv.company_phone).replace(/\D/g, '');
        const company = db.prepare(`
          SELECT id FROM companies 
          WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
          LIMIT 1
        `).get(inv.company_phone, cleanPhone);

        if (!company || !company.id) {
          throw new Error(
            `❌ [Migración 004] Factura huérfana '${inv.id}' con teléfono '${inv.company_phone}' sin empresa registrada en 'companies'.`
          );
        }

        targetCompanyId = company.id;
      }

      // Sincronizar companyId en data_json si es parseable
      let dataJson = inv.data_json;
      try {
        if (dataJson) {
          const parsed = JSON.parse(dataJson);
          if (parsed.companyId !== targetCompanyId) {
            parsed.companyId = targetCompanyId;
            dataJson = JSON.stringify(parsed);
          }
        }
      } catch (e) {
        // Preservar data_json intacto si no es JSON válido
      }

      updateStmt.run(targetCompanyId, dataJson, inv.id);
    }

    // 4. Validación estricta de la invariante: invoice.company_id == budget.company_id
    const mismatched = db.prepare(`
      SELECT i.id as invoice_id, i.company_id as invoice_company_id, i.budget_id, b.company_id as budget_company_id
      FROM invoices i
      JOIN budgets b ON i.budget_id = b.id
      WHERE i.budget_id IS NOT NULL AND i.budget_id != '' AND i.company_id != b.company_id
    `).all();

    if (mismatched.length > 0) {
      const details = mismatched.map(m => `[Factura: ${m.invoice_id} (${m.invoice_company_id}) !== Budget: ${m.budget_id} (${m.budget_company_id})]`).join(', ');
      throw new Error(
        `❌ [Migración 004] Violación de invariante: Existen facturas cuyo company_id no coincide con el del presupuesto vinculado: ${details}`
      );
    }

    // 5. Validación de ausencia de registros sin company_id
    const unmigratedCount = db.prepare(`
      SELECT count(*) as count 
      FROM invoices 
      WHERE company_id IS NULL OR company_id = ''
    `).get().count;

    if (unmigratedCount > 0) {
      throw new Error(
        `❌ [Migración 004] Inconsistencia: Quedan ${unmigratedCount} facturas sin company_id asignado.`
      );
    }
  }
};
