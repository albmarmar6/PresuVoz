/**
 * PresuVoz — Migración Canónica 016: Sequential Atomic Multi-Tenant Invoice Numbering
 * 
 * Versión: 16
 * 
 * OBJETIVOS:
 * 1. invoice_sequences:
 *    - Tabla de secuencias atómicas por empresa, serie y año.
 *    - PRIMARY KEY (company_id, series, year)
 *    - FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
 *    - Cero MAX() + 1 en tiempo de ejecución.
 * 
 * 2. invoices:
 *    - Reconstrucción preservando id TEXT PRIMARY KEY como identificador interno estable.
 *    - Incorporación de columnas estructuradas obligatorias:
 *        series TEXT NOT NULL
 *        year INTEGER NOT NULL
 *        invoice_number INTEGER NOT NULL
 *    - Restricción de unicidad multi-tenant:
 *        UNIQUE(company_id, series, year, invoice_number)
 * 
 * 3. Mapeo determinista de las 6 facturas históricas:
 *    - 1. FAC-2026-0108 -> (817ca602..., 'FAC', 2026, 108)
 *    - 2. FAC-DEMO-001  -> (817ca602..., 'FAC-DEMO', 2026, 1)
 *    - 3. INV-2026-001  -> (d5ac9e65..., 'F', 2026, 1)
 *    - 4. INV-2026-R01  -> (d5ac9e65..., 'R', 2026, 1)
 *    - 5. INV-2026-ADV01-> (d5ac9e65..., 'F', 2026, 2)
 *    - 6. INV-EMP-B-1   -> (bc23b732..., 'FB', 2026, 1)
 * 
 * 4. Siembra (seed) de invoice_sequences derivado de las facturas históricas:
 *    - Derivación estricta desde invoices y validación contra los 5 valores auditados.
 * 
 * 5. Fail-Closed & Transaccional:
 *    - Ejecución atómica en BEGIN IMMEDIATE ... COMMIT.
 *    - Si ocurre cualquier discrepancia, error de FK o integridad: ROLLBACK completo.
 *    - Forward-only: No down() destructivo.
 */

export function executeCanonicalMigration016(db, options = {}) {
  // Comprobar si ya fue aplicada
  const appliedCheck = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 16 OR name = '016_sequential_invoice_numbering'").get();
  if (appliedCheck) {
    console.log('ℹ️ [MIGRACIÓN 016] Ya está aplicada en esta base de datos. Omitiendo.');
    return { applied: false, alreadyApplied: true };
  }

  // Comprobar pre-condición: Migración 15 debe estar aplicada
  const v15Check = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 15").get();
  if (!v15Check) {
    throw new Error('🛑 [MIGRACIÓN 016] Precondición violada: La migración 015 no está aplicada.');
  }

  // Capturar estado previo de PRAGMA foreign_keys
  const fkState = db.prepare('PRAGMA foreign_keys').get();
  const originalFk = fkState ? Object.values(fkState)[0] === 1 : true;

  console.log('🚀 [MIGRACIÓN 016] Iniciando Migración Canónica 016: Numeración Secuencial...');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE;');

  try {
    // 1. Crear tabla invoice_sequences si no existe
    console.log('1. Creando tabla invoice_sequences...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS invoice_sequences (
        company_id TEXT NOT NULL,
        series TEXT NOT NULL,
        year INTEGER NOT NULL,
        current_number INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (company_id, series, year),
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_invoice_sequences_lookup 
        ON invoice_sequences(company_id, series, year);
    `);

    // 2. Extraer y mapear facturas existentes
    console.log('2. Extrayendo facturas existentes de invoices...');
    const invRows = db.prepare('SELECT * FROM invoices ORDER BY created_at ASC').all();
    const countBefore = invRows.length;

    // Tabla de mapeo conocido y canónico de facturas históricas auditadas
    const CANONICAL_HISTORICAL_MAP = {
      'FAC-2026-0108': { series: 'FAC', year: 2026, invoice_number: 108 },
      'FAC-DEMO-001':  { series: 'FAC-DEMO', year: 2026, invoice_number: 1 },
      'INV-2026-001':  { series: 'F', year: 2026, invoice_number: 1 },
      'INV-2026-R01':  { series: 'R', year: 2026, invoice_number: 1 },
      'INV-2026-ADV01':{ series: 'F', year: 2026, invoice_number: 2 },
      'INV-EMP-B-1':   { series: 'FB', year: 2026, invoice_number: 1 }
    };

    const mappedInvoices = [];

    for (const r of invRows) {
      let mapped = null;

      // A) Si es una de las 6 facturas históricas conocidas
      if (CANONICAL_HISTORICAL_MAP[r.id]) {
        mapped = { ...CANONICAL_HISTORICAL_MAP[r.id] };
      } else {
        // B) Si es otra factura (ej. pruebas de rehearsal adicionales)
        let parsed = {};
        try { parsed = JSON.parse(r.data_json || '{}'); } catch {}

        const parsedSeries = r.series || parsed.series || (parsed.invoice_number ? parsed.invoice_number.split('-')[0] : null);
        const parsedYear = r.year || parsed.year || (r.created_at ? new Date(r.created_at).getFullYear() : 2026);
        let parsedNum = r.invoice_number || parsed.invoice_number_int || parsed.number;

        if (!parsedNum && parsed.invoice_number) {
          const match = parsed.invoice_number.match(/\d+$/);
          if (match) parsedNum = parseInt(match[0], 10);
        }
        if (!parsedNum && r.id) {
          const match = r.id.match(/\d+$/);
          if (match) parsedNum = parseInt(match[0], 10);
        }

        if (parsedSeries && parsedYear && parsedNum) {
          mapped = {
            series: String(parsedSeries).replace(/-$/, ''),
            year: Number(parsedYear),
            invoice_number: Number(parsedNum)
          };
        }
      }

      if (!mapped) {
        throw new Error(`🛑 [MIGRACIÓN 016] Factura ambigua o no mapeable inequívocamente: ${r.id} (company_id: ${r.company_id}). Abortando.`);
      }

      mappedInvoices.push({
        ...r,
        series: mapped.series,
        year: mapped.year,
        invoice_number: mapped.invoice_number
      });
    }

    // 3. Crear nueva tabla invoices_v16
    console.log('3. Creando tabla temporal invoices_v16...');
    db.exec(`
      CREATE TABLE invoices_v16 (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        budget_id TEXT,
        client_name TEXT,
        total_amount REAL,
        status TEXT,
        data_json TEXT,
        created_at TEXT,
        rectifies_invoice_id TEXT,
        fiscal_period TEXT,
        verifactu_hash TEXT,
        series TEXT NOT NULL,
        year INTEGER NOT NULL,
        invoice_number INTEGER NOT NULL,
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT
      );
    `);

    // 4. Insertar filas mapeadas en invoices_v16
    console.log(`4. Insertando ${mappedInvoices.length} facturas mapeadas en invoices_v16...`);
    const insertStmt = db.prepare(`
      INSERT INTO invoices_v16 (
        id, company_id, budget_id, client_name, total_amount, status,
        data_json, created_at, rectifies_invoice_id, fiscal_period,
        verifactu_hash, series, year, invoice_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const inv of mappedInvoices) {
      insertStmt.run(
        inv.id,
        inv.company_id,
        inv.budget_id,
        inv.client_name,
        inv.total_amount,
        inv.status,
        inv.data_json,
        inv.created_at,
        inv.rectifies_invoice_id,
        inv.fiscal_period,
        inv.verifactu_hash,
        inv.series,
        inv.year,
        inv.invoice_number
      );
    }

    // 5. Validaciones de conteo y fidelidad bit-a-bit de campos originales
    console.log('5. Validando integridad de datos pre y post inserción...');
    const countAfter = db.prepare('SELECT COUNT(*) as cnt FROM invoices_v16').get().cnt;
    if (countBefore !== countAfter) {
      throw new Error(`🛑 [MIGRACIÓN 016] Discrepancia de conteo en invoices: Antes=${countBefore}, Después=${countAfter}`);
    }

    for (const orig of invRows) {
      const migrated = db.prepare('SELECT * FROM invoices_v16 WHERE id = ?').get(orig.id);
      if (!migrated) {
        throw new Error(`🛑 [MIGRACIÓN 016] Factura no encontrada tras inserción: ${orig.id}`);
      }
      if (migrated.company_id !== orig.company_id) throw new Error(`Discrepancia company_id en ${orig.id}`);
      if (migrated.total_amount !== orig.total_amount) throw new Error(`Discrepancia total_amount en ${orig.id}`);
      if (migrated.status !== orig.status) throw new Error(`Discrepancia status en ${orig.id}`);
      if (migrated.data_json !== orig.data_json) throw new Error(`Discrepancia data_json en ${orig.id}`);
      if (migrated.rectifies_invoice_id !== orig.rectifies_invoice_id) throw new Error(`Discrepancia rectifies_invoice_id en ${orig.id}`);
      if (migrated.fiscal_period !== orig.fiscal_period) throw new Error(`Discrepancia fiscal_period en ${orig.id}`);
      if (migrated.verifactu_hash !== orig.verifactu_hash) throw new Error(`Discrepancia verifactu_hash en ${orig.id}`);
    }

    // 6. Sustituir tabla invoices y recrear índices canónicos
    console.log('6. Sustituyendo tabla invoices y creando índices estructurados...');
    db.exec(`
      DROP TABLE invoices;
      ALTER TABLE invoices_v16 RENAME TO invoices;

      CREATE UNIQUE INDEX idx_invoices_sequence 
        ON invoices(company_id, series, year, invoice_number);

      CREATE INDEX idx_invoices_company_id 
        ON invoices(company_id);

      CREATE INDEX idx_invoices_company_id_created 
        ON invoices(company_id, created_at);

      CREATE INDEX idx_invoices_company_id_id 
        ON invoices(company_id, id);
    `);

    // 7. Sembrar invoice_sequences derivado de las facturas migradas
    console.log('7. Sembrando invoice_sequences a partir del dataset...');
    const seqDerivations = db.prepare(`
      SELECT company_id, series, year, MAX(invoice_number) as max_num
      FROM invoices
      GROUP BY company_id, series, year
    `).all();

    const insertSeqStmt = db.prepare(`
      INSERT INTO invoice_sequences (company_id, series, year, current_number, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(company_id, series, year) DO UPDATE SET
        current_number = excluded.current_number,
        updated_at = excluded.updated_at
    `);

    const nowIso = new Date().toISOString();
    for (const seq of seqDerivations) {
      insertSeqStmt.run(seq.company_id, seq.series, seq.year, seq.max_num, nowIso);
    }

    // Si el dataset es exactamente el baseline de 6 facturas, verificar valores esperados
    if (countBefore === 6) {
      const EXPECTED_SEEDS = [
        { company_id: '817ca602-6ae4-4fe3-9b06-293e52b8df60', series: 'FAC', year: 2026, current_number: 108 },
        { company_id: '817ca602-6ae4-4fe3-9b06-293e52b8df60', series: 'FAC-DEMO', year: 2026, current_number: 1 },
        { company_id: 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e', series: 'F', year: 2026, current_number: 2 },
        { company_id: 'd5ac9e65-a13f-46c2-9080-8bbbedc9203e', series: 'R', year: 2026, current_number: 1 },
        { company_id: 'bc23b732-50cc-414e-8a50-1eeba2a25e34', series: 'FB', year: 2026, current_number: 1 }
      ];

      for (const exp of EXPECTED_SEEDS) {
        const actual = db.prepare(`
          SELECT current_number FROM invoice_sequences 
          WHERE company_id = ? AND series = ? AND year = ?
        `).get(exp.company_id, exp.series, exp.year);

        if (!actual || actual.current_number !== exp.current_number) {
          throw new Error(`🛑 [MIGRACIÓN 016] Discrepancia en seed de secuencias para (${exp.series}, ${exp.year}): Esperado ${exp.current_number}, Obtenido ${actual?.current_number}`);
        }
      }
    }

    // 8. Validaciones finales estrictas de claves foráneas e integridad SQLite
    console.log('8. Validando claves foráneas e integridad...');
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (fkViolations.length > 0) {
      throw new Error(`🛑 [MIGRACIÓN 016] Violaciones de clave foránea detectadas: ${JSON.stringify(fkViolations)}`);
    }

    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (!integrity || integrity.length === 0 || integrity[0].integrity_check !== 'ok') {
      throw new Error(`🛑 [MIGRACIÓN 016] Fallo en integrity_check: ${JSON.stringify(integrity)}`);
    }

    // 9. Registrar versión 16 en schema_migrations
    db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (16, ?, ?)')
      .run('016_sequential_invoice_numbering', nowIso);

    db.exec('COMMIT;');
    console.log('✅ [MIGRACIÓN 016] Migración 016 completada con éxito.');
    return { applied: true, version: 16 };
  } catch (err) {
    console.error('❌ [MIGRACIÓN 016] ERROR durante la ejecución:', err.message);
    try {
      db.exec('ROLLBACK;');
      console.log('🔄 [MIGRACIÓN 016] Transacción revertida (ROLLBACK). Base de datos intacta.');
    } catch (rbErr) {
      console.error('⚠️ [MIGRACIÓN 016] Error al revertir:', rbErr.message);
    }
    throw err;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${originalFk ? 'ON' : 'OFF'};`);
  }
}

export const migration = {
  version: 16,
  name: '016_sequential_invoice_numbering',
  standaloneTransaction: true,
  up: (db, options = {}) => executeCanonicalMigration016(db, options)
};
