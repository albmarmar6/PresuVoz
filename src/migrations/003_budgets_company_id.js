/**
 * PresuVoz — Migración 003: Budgets Company ID & Tenant Isolation
 * 
 * Versión: 3
 * Fecha: 2026-09-27
 * 
 * Contrato:
 * Establece `company_id` como identificador canónico del tenant para `budgets`:
 * - Añade columna `company_id` a `budgets` con FOREIGN KEY a `companies(id)`.
 * - Crea índice `idx_budgets_company_id` para búsquedas eficientes por tenant.
 * - Crea índice `idx_budgets_company_id_updated` para ordenación temporal por tenant.
 * - Backfill determinista: `budgets.company_phone` -> `companies.phone` -> `companies.id`.
 * - Valida integridad referencial: detiene con error si detecta huérfanos o inconsistencias.
 * - Preserva `company_phone` para compatibilidad de lectura/escritura legada (dual read/write).
 * 
 * Arquitectura Forward-Only:
 * - Idempotente, aditiva y estrictamente hacia adelante (sin rollback).
 */

export const migration = {
  version: 3,
  name: '003_budgets_company_id',
  up: (db) => {
    // 1. Asegurar columna company_id en budgets
    const budgetCols = db.prepare('PRAGMA table_info("budgets")').all();
    const hasCompanyId = budgetCols.some(c => c.name === 'company_id');

    if (!hasCompanyId) {
      db.exec('ALTER TABLE budgets ADD COLUMN company_id TEXT REFERENCES companies(id);');
    }

    // 2. Índices de rendimiento para tenant isolation
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_budgets_company_id ON budgets(company_id);
      CREATE INDEX IF NOT EXISTS idx_budgets_company_id_updated ON budgets(company_id, updated_at DESC);
    `);

    // 3. Backfill determinista de presupuestos existentes
    const unmigratedBudgets = db.prepare(`
      SELECT id, company_phone, company_id, data_json 
      FROM budgets 
      WHERE company_id IS NULL AND company_phone IS NOT NULL AND company_phone != ''
    `).all();

    const orphanBudgets = [];
    const updateStmt = db.prepare('UPDATE budgets SET company_id = ?, data_json = ? WHERE id = ?');

    for (const b of unmigratedBudgets) {
      const cleanPhone = String(b.company_phone).replace(/\D/g, '');
      
      // Buscar la empresa por teléfono exacto o por teléfono limpio
      const company = db.prepare(`
        SELECT id FROM companies 
        WHERE phone = ? OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', '') = ?
        LIMIT 1
      `).get(b.company_phone, cleanPhone);

      if (!company || !company.id) {
        orphanBudgets.push({ budgetId: b.id, companyPhone: b.company_phone });
        continue;
      }

      // Actualizar data_json para que también contenga companyId
      let dataJson = b.data_json;
      try {
        if (dataJson) {
          const parsed = JSON.parse(dataJson);
          if (!parsed.companyId) {
            parsed.companyId = company.id;
            dataJson = JSON.stringify(parsed);
          }
        }
      } catch (e) {
        // Preservar data_json original si hay error de parseo
      }

      updateStmt.run(company.id, dataJson, b.id);
    }

    // 4. Auditoría estricta de inconsistencias / huérfanos
    if (orphanBudgets.length > 0) {
      const details = orphanBudgets.map(o => `[Budget: ${o.budgetId}, Phone: ${o.companyPhone}]`).join(', ');
      throw new Error(
        `❌ [Migración 003] Fallo crítico de integridad en backfill: Existen ${orphanBudgets.length} presupuestos huérfanos sin empresa correspondiente en 'companies': ${details}. No se inventan datos.`
      );
    }

    // 5. Verificación final de consistencia
    const pendingCount = db.prepare(`
      SELECT count(*) as count 
      FROM budgets 
      WHERE company_id IS NULL AND company_phone IS NOT NULL AND company_phone != ''
    `).get().count;

    if (pendingCount > 0) {
      throw new Error(`❌ [Migración 003] Inconsistencia: Quedan ${pendingCount} presupuestos con company_phone pero sin company_id asignado.`);
    }
  }
};
