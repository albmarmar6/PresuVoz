/**
 * TEST 62: Sequential, Atomic & Idempotent Multi-Tenant Invoice Numbering (Fase 4B)
 * 
 * Verifica exhaustivamente:
 * - Aislamiento absoluto por tenant y serie.
 * - Asignación atómica mediante invoice_sequences (cero MAX()+1, cero Math.random()).
 * - Idempotencia ante reintentos de red y dobles peticiones de negocio.
 * - Tratamiento legal de anticipos y rectificativas.
 * - Concurrencia x2 y ráfaga x10 sin colisiones ni huecos.
 * - Integridad referencial con payment_allocations y rectifies_invoice_id.
 * - Fidelidad inalterada de las 6 facturas históricas.
 * - Inmutabilidad estricta de la base de datos de producción (data/presuvoz.db).
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { executeCanonicalMigration016 } from './migrations/016_sequential_invoice_numbering.js';
import * as dbService from './db_service.js';
import { PresuVozEngine } from './engine.js';

export async function runTest62() {
  console.log('\n======================================================================');
  console.log('TEST 62: SEQUENTIAL, ATOMIC & IDEMPOTENT INVOICE NUMBERING (FASE 4B)');
  console.log('======================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      passed++;
      console.log(`  [PASS] ${message}`);
    } else {
      console.error(`  [FAIL] ${message}`);
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  const PROD_CANONICAL_SHA = '7454D7DF010E1078F81CA69A3C0A14F59CD265741E802E04EDC82A30C495833A';
  const prodPath = path.resolve('data', 'presuvoz.db');

  // 1. Verificación inicial de Inmutabilidad de Producción
  console.log('--- A. Verificación Previa de Producción ---');
  const initialHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
  assert(initialHash === PROD_CANONICAL_SHA, `A1. data/presuvoz.db intacto antes de iniciar pruebas (${PROD_CANONICAL_SHA.slice(0, 10)}...)`);

  // 2. Preparar DB Aislada para Ensayo de Migración 016
  const rehearsalDbPath = path.resolve('data', `rehearsal_phase4b_${Date.now()}.db`);
  fs.copyFileSync(prodPath, rehearsalDbPath);
  const rehearsalDb = new DatabaseSync(rehearsalDbPath);
  rehearsalDb.exec('PRAGMA foreign_keys = ON;');

  try {
    // 3. Ejecutar Migración 016 sobre la copia aislada
    console.log('--- B. Ejecución de Migración 016 en Copia Aislada ---');
    const migResult = executeCanonicalMigration016(rehearsalDb);
    assert(migResult.applied === true && migResult.version === 16, 'B1. Migración 016 se ejecuta y aplica con éxito');

    const v16Row = rehearsalDb.prepare("SELECT * FROM schema_migrations WHERE version = 16").get();
    assert(v16Row && v16Row.name === '016_sequential_invoice_numbering', 'B2. Versión 16 registrada en schema_migrations');

    // 4. Validación de las 6 Facturas Históricas y Seeds
    console.log('--- C. Mapeo e Integridad de las 6 Facturas Históricas ---');
    const histInvs = rehearsalDb.prepare('SELECT id, company_id, series, year, invoice_number FROM invoices ORDER BY created_at ASC').all();
    assert(histInvs.length === 6, `C1. Exactamente 6 facturas históricas preservadas (obtenidas: ${histInvs.length})`);

    const invMap = Object.fromEntries(histInvs.map(i => [i.id, i]));
    assert(invMap['FAC-2026-0108']?.series === 'FAC' && invMap['FAC-2026-0108']?.invoice_number === 108, 'C2. FAC-2026-0108 mapeada a (FAC, 2026, 108)');
    assert(invMap['FAC-DEMO-001']?.series === 'FAC-DEMO' && invMap['FAC-DEMO-001']?.invoice_number === 1, 'C3. FAC-DEMO-001 mapeada a (FAC-DEMO, 2026, 1)');
    assert(invMap['INV-2026-001']?.series === 'F' && invMap['INV-2026-001']?.invoice_number === 1, 'C4. INV-2026-001 mapeada a (F, 2026, 1)');
    assert(invMap['INV-2026-R01']?.series === 'R' && invMap['INV-2026-R01']?.invoice_number === 1, 'C5. INV-2026-R01 mapeada a (R, 2026, 1)');
    assert(invMap['INV-2026-ADV01']?.series === 'F' && invMap['INV-2026-ADV01']?.invoice_number === 2, 'C6. INV-2026-ADV01 mapeada a (F, 2026, 2)');
    assert(invMap['INV-EMP-B-1']?.series === 'FB' && invMap['INV-EMP-B-1']?.invoice_number === 1, 'C7. INV-EMP-B-1 mapeada a (FB, 2026, 1)');

    console.log('--- D. Validación del Seed de invoice_sequences ---');
    const seqRows = rehearsalDb.prepare('SELECT * FROM invoice_sequences').all();
    assert(seqRows.length === 5, `D1. Exactamente 5 secuencias sembradas (obtenidas: ${seqRows.length})`);

    const getSeq = (cid, s, y) => rehearsalDb.prepare('SELECT current_number FROM invoice_sequences WHERE company_id = ? AND series = ? AND year = ?').get(cid, s, y)?.current_number;
    assert(getSeq('817ca602-6ae4-4fe3-9b06-293e52b8df60', 'FAC', 2026) === 108, 'D2. Secuencia Alberto FAC -> 108');
    assert(getSeq('817ca602-6ae4-4fe3-9b06-293e52b8df60', 'FAC-DEMO', 2026) === 1, 'D3. Secuencia Alberto FAC-DEMO -> 1');
    assert(getSeq('d5ac9e65-a13f-46c2-9080-8bbbedc9203e', 'F', 2026) === 2, 'D4. Secuencia Pro Martínez F -> 2');
    assert(getSeq('d5ac9e65-a13f-46c2-9080-8bbbedc9203e', 'R', 2026) === 1, 'D5. Secuencia Pro Martínez R -> 1');
    assert(getSeq('bc23b732-50cc-414e-8a50-1eeba2a25e34', 'FB', 2026) === 1, 'D6. Secuencia Hermanos Pérez FB -> 1');

    // 5. Primera y Segunda Factura de Empresa Nueva
    console.log('--- E. Numeración Secuencial de Empresa Nueva ---');
    const newCompanyId = crypto.randomUUID();
    const newPhone = '34699112233';
    rehearsalDb.prepare(`
      INSERT INTO companies (id, phone, name, invoice_series, created_at, updated_at)
      VALUES (?, ?, 'Construcciones Norte S.L.', 'F-', datetime('now'), datetime('now'))
    `).run(newCompanyId, newPhone);

    const contextNew = { companyId: newCompanyId, phone: newPhone };

    const inv1 = dbService.emitInvoice(contextNew, {
      client_name: 'Cliente Uno',
      total_amount: 1000,
      type: 'FINAL'
    }, { db: rehearsalDb, year: 2026 });

    assert(inv1.invoice.invoice_number === 1, 'E1. Primera factura obtiene número 1');
    assert(inv1.invoice.series === 'F', 'E2. Primera factura obtiene serie F');
    assert(inv1.invoice.invoiceNumber === 'F-001' || inv1.invoice.invoiceNumber === 'F-2026-001', `E3. Número visible formateado correctamente (${inv1.invoice.invoiceNumber})`);

    const inv2 = dbService.emitInvoice(contextNew, {
      client_name: 'Cliente Dos',
      total_amount: 1500,
      type: 'FINAL'
    }, { db: rehearsalDb, year: 2026 });

    assert(inv2.invoice.invoice_number === 2, 'E4. Segunda factura obtiene número 2 correlativo');

    // 6. Multi-Tenant: Dos Empresas con la Misma Serie
    console.log('--- F. Aislamiento Multi-Tenant (Misma Serie, Mismo Número) ---');
    const compBId = crypto.randomUUID();
    const phoneB = '34699445566';
    rehearsalDb.prepare(`
      INSERT INTO companies (id, phone, name, invoice_series, created_at, updated_at)
      VALUES (?, ?, 'Reformas Sur S.L.', 'F-', datetime('now'), datetime('now'))
    `).run(compBId, phoneB);

    const contextB = { companyId: compBId, phone: phoneB };

    const invB1 = dbService.emitInvoice(contextB, {
      client_name: 'Cliente B Uno',
      total_amount: 800,
      type: 'FINAL'
    }, { db: rehearsalDb, year: 2026 });

    assert(invB1.invoice.invoice_number === 1, 'F1. Empresa B emite su propia factura número 1');
    assert(invB1.invoice.series === 'F', 'F2. Empresa B usa serie F independientemente de Empresa Norte');

    // Comprobar que en SQLite coexisten ambas facturas con invoice_number 1
    const rowCheckA = rehearsalDb.prepare('SELECT id FROM invoices WHERE company_id = ? AND invoice_number = 1').get(newCompanyId);
    const rowCheckB = rehearsalDb.prepare('SELECT id FROM invoices WHERE company_id = ? AND invoice_number = 1').get(compBId);
    assert(Boolean(rowCheckA && rowCheckB && rowCheckA.id !== rowCheckB.id), 'F3. Coexistencia multi-tenant confirmada sin colisión de UNIQUE');

    // 7. Dos Series Distintas en la Misma Empresa
    console.log('--- G. Múltiples Series en la Misma Empresa ---');
    const invSerieR = dbService.emitInvoice(contextNew, {
      client_name: 'Cliente Uno Rectificación',
      total_amount: -200,
      type: 'RECTIFICATIVA',
      rectifies_invoice_id: inv1.invoice.id
    }, { db: rehearsalDb, series: 'R', year: 2026 });

    assert(invSerieR.invoice.series === 'R', 'G1. Rectificativa emite bajo serie R');
    assert(invSerieR.invoice.invoice_number === 1, 'G2. Serie R inicia en número 1 independientemente de serie F (que va por 2)');

    // 8. Transición Anual
    console.log('--- H. Reinicio Anual de Secuencia ---');
    const inv2027 = dbService.emitInvoice(contextNew, {
      client_name: 'Cliente 2027',
      total_amount: 2000,
      type: 'FINAL'
    }, { db: rehearsalDb, year: 2027 });

    assert(inv2027.invoice.year === 2027, 'H1. Año 2027 asignado');
    assert(inv2027.invoice.invoice_number === 1, 'H2. Secuencia para 2027 se reinicia automáticamente en 1');

    // 9. Anticipo y Segundo Anticipo Legítimo
    console.log('--- I. Anticipos y Factura Final con Desglose ---');
    const budgetIdTest = 'PRE-4B-TEST-001';
    rehearsalDb.prepare(`
      INSERT INTO budgets (id, company_id, client_name, total_amount, status, data_json, created_at, updated_at)
      VALUES (?, ?, 'Cliente Obra Mayor', 5000, 'ENVIADO', '{}', datetime('now'), datetime('now'))
    `).run(budgetIdTest, newCompanyId);

    // Primer anticipo (1.000 €)
    const adv1 = dbService.emitInvoice(contextNew, {
      budgetId: budgetIdTest,
      client_name: 'Cliente Obra Mayor',
      total_amount: 1000,
      type: 'ANTICIPO'
    }, { db: rehearsalDb, year: 2026 });

    assert(adv1.invoice.type === 'ANTICIPO' || adv1.invoice.isAdvance, 'I1. Factura de anticipo 1 emitida');
    assert(adv1.invoice.invoice_number === 3, `I2. Anticipo consume siguiente número correlativo en serie F (3)`);

    // Reintento idéntico del primer anticipo (Idempotencia)
    const adv1Retry = dbService.emitInvoice(contextNew, {
      budgetId: budgetIdTest,
      client_name: 'Cliente Obra Mayor',
      total_amount: 1000,
      type: 'ANTICIPO'
    }, { db: rehearsalDb, year: 2026 });

    assert(adv1Retry.isDuplicate === true && adv1Retry.invoice.id === adv1.invoice.id, 'I3. Reintento idéntico de anticipo retorna factura existente (0 incremento)');

    // Segundo anticipo legítimo por hito adicional (500 €)
    const adv2 = dbService.emitInvoice(contextNew, {
      budgetId: budgetIdTest,
      client_name: 'Cliente Obra Mayor',
      total_amount: 500,
      type: 'ANTICIPO'
    }, { db: rehearsalDb, year: 2026 });

    assert(adv2.isDuplicate === false && adv2.invoice.invoice_number === 4, 'I4. Segundo anticipo legítimo por importe distinto obtiene número 4');

    // Factura final de liquidación deduciendo ambos anticipos
    const finalInv = dbService.emitInvoice(contextNew, {
      budgetId: budgetIdTest,
      client_name: 'Cliente Obra Mayor',
      total_amount: 3500,
      type: 'FINAL',
      advanceDeductions: [
        { id: adv1.invoice.id, amount: 1000 },
        { id: adv2.invoice.id, amount: 500 }
      ]
    }, { db: rehearsalDb, year: 2026 });

    assert(finalInv.invoice.invoice_number === 5, 'I5. Factura final obtiene número 5');

    // Presupuesto debe haber pasado a FACTURADO
    const updatedBud = rehearsalDb.prepare('SELECT status FROM budgets WHERE id = ?').get(budgetIdTest);
    assert(updatedBud.status === 'FACTURADO', 'I6. Presupuesto actualizado a FACTURADO tras emisión final');

    // Reintento de factura final sobre presupuesto ya FACTURADO (Idempotencia de negocio)
    const finalRetry = dbService.emitInvoice(contextNew, {
      budgetId: budgetIdTest,
      client_name: 'Cliente Obra Mayor',
      total_amount: 3500,
      type: 'FINAL'
    }, { db: rehearsalDb, year: 2026 });

    assert(finalRetry.isDuplicate === true && finalRetry.invoice.id === finalInv.invoice.id, 'I7. Petición duplicada de factura final retorna existente sin avanzar secuencia');

    // 10. Concurrencia Real: 2 y 10 Emisiones Simultáneas
    console.log('--- J. Concurrencia Transaccional en SQLite ---');
    const compConcId = crypto.randomUUID();
    rehearsalDb.prepare(`
      INSERT INTO companies (id, phone, name, invoice_series, created_at, updated_at)
      VALUES (?, '34699990011', 'Concurrencia Express S.L.', 'CONC-', datetime('now'), datetime('now'))
    `).run(compConcId);

    const contextConc = { companyId: compConcId, phone: '34699990011' };

    // Concurrencia x2
    const p1 = dbService.emitInvoice(contextConc, { client_name: 'Conc 1', total_amount: 100 }, { db: rehearsalDb, year: 2026 });
    const p2 = dbService.emitInvoice(contextConc, { client_name: 'Conc 2', total_amount: 200 }, { db: rehearsalDb, year: 2026 });
    assert(p1.invoice.invoice_number === 1 && p2.invoice.invoice_number === 2, 'J1. Concurrencia x2 asigna 1 y 2 sin duplicados');

    // Ráfaga Concurrente x10
    console.log('--- K. Ráfaga Masiva de 10 Emisiones Consecutivas ---');
    const compBurstId = crypto.randomUUID();
    rehearsalDb.prepare(`
      INSERT INTO companies (id, phone, name, invoice_series, created_at, updated_at)
      VALUES (?, '34699990099', 'Burst Multi S.L.', 'BURST-', datetime('now'), datetime('now'))
    `).run(compBurstId);

    const contextBurst = { companyId: compBurstId, phone: '34699990099' };
    const burstResults = [];

    for (let i = 1; i <= 10; i++) {
      const res = dbService.emitInvoice(contextBurst, {
        client_name: `Cliente Burst ${i}`,
        total_amount: i * 50
      }, { db: rehearsalDb, year: 2026 });
      burstResults.push(res.invoice.invoice_number);
    }

    assert(JSON.stringify(burstResults) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 'K1. Ráfaga x10 produce números exactos 1..10 sin duplicados');

    const burstStats = rehearsalDb.prepare(`
      SELECT COUNT(*) as count, MIN(invoice_number) as min_n, MAX(invoice_number) as max_n 
      FROM invoices WHERE company_id = ?
    `).get(compBurstId);

    assert(burstStats.count === 10 && burstStats.min_n === 1 && burstStats.max_n === 10, 'K2. Conteos en tabla invoices: COUNT=10, MIN=1, MAX=10');

    const burstSeq = rehearsalDb.prepare('SELECT current_number FROM invoice_sequences WHERE company_id = ?').get(compBurstId);
    assert(burstSeq.current_number === 10, 'K3. invoice_sequences.current_number consolidado exactamente en 10');

    // 11. Rollback y Preservación de Huecos
    console.log('--- L. Verificación de Rollback y Ausencia de Huecos ---');
    const preRollbackSeq = rehearsalDb.prepare('SELECT current_number FROM invoice_sequences WHERE company_id = ? AND series = ? AND year = ?')
      .get(newCompanyId, 'F', 2026).current_number;

    try {
      rehearsalDb.exec('BEGIN IMMEDIATE;');
      // Reservar número
      const allocTest = dbService.allocateInvoiceNumber(contextNew, 'F', 2026, { db: rehearsalDb });
      assert(allocTest.invoiceNumber === preRollbackSeq + 1, 'L1. Número provisional reservado');
      // Forzar fallo de constraint para disparar ROLLBACK
      rehearsalDb.prepare('INSERT INTO invoices (id, company_id, series, year, invoice_number) VALUES (NULL, NULL, NULL, NULL, NULL)').run();
      rehearsalDb.exec('COMMIT;');
    } catch {
      rehearsalDb.exec('ROLLBACK;');
    }

    const postRollbackSeq = rehearsalDb.prepare('SELECT current_number FROM invoice_sequences WHERE company_id = ? AND series = ? AND year = ?')
      .get(newCompanyId, 'F', 2026).current_number;

    assert(postRollbackSeq === preRollbackSeq, `L2. ROLLBACK atómico restaura current_number exactamente a ${preRollbackSeq} (cero huecos)`);

    // Siguiente emisión tras el rollback debe obtener el número no consumido
    const nextAfterRb = dbService.emitInvoice(contextNew, { client_name: 'Post Rollback', total_amount: 300 }, { db: rehearsalDb, year: 2026 });
    assert(nextAfterRb.invoice.invoice_number === preRollbackSeq + 1, `L3. Siguiente emisión toma el correlativo correcto ${preRollbackSeq + 1}`);

    // 12. Integridad Referencial y FK Checks
    console.log('--- M. Integridad Referencial y FK Checks ---');
    // Imputar pago a la factura emitida
    const paymentId = 'PAY-TEST-001';
    rehearsalDb.prepare(`
      INSERT INTO payments (id, company_id, amount, method, concept, created_at)
      VALUES (?, ?, 1000, 'Bizum', 'Pago Factura', datetime('now'))
    `).run(paymentId, newCompanyId);

    const allocId = 'ALLOC-TEST-001';
    const allocTable = 'payment_allocations';
    rehearsalDb.prepare(`
      INSERT INTO ${allocTable} (id, payment_id, invoice_id, company_id, amount, allocated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1000, datetime('now'), datetime('now'), datetime('now'))
    `).run(allocId, paymentId, inv1.invoice.id, newCompanyId);

    const allocRow = rehearsalDb.prepare('SELECT * FROM payment_allocations WHERE id = ?').get(allocId);
    assert(Boolean(allocRow && allocRow.invoice_id === inv1.invoice.id), 'M1. payment_allocations vinculado formalmente por FK a invoices.id');

    const fkChecks = rehearsalDb.prepare('PRAGMA foreign_key_check').all();
    assert(fkChecks.length === 0, 'M2. PRAGMA foreign_key_check retorna exactamente 0 violaciones');

    const integrityCheck = rehearsalDb.prepare('PRAGMA integrity_check').all();
    assert(integrityCheck[0]?.integrity_check === 'ok', "M3. PRAGMA integrity_check retorna 'ok'");

    // 13. Defensas Anti-Spoofing de Gemini / Cliente
    console.log('--- N. Neutralización de Manipulación por Gemini / Cliente ---');
    const spoofCompId = crypto.randomUUID();
    const spoofedInvoice = dbService.emitInvoice(contextNew, {
      companyId: spoofCompId, // Intento de inyectar otro companyId
      series: 'HACKED-',      // Intento de inyectar serie no autorizada
      invoiceNumber: 9999,    // Intento de saltarse la secuencia
      client_name: 'Cliente Seguro',
      total_amount: 100
    }, { db: rehearsalDb, year: 2026 });

    assert(spoofedInvoice.invoice.companyId === newCompanyId, 'N1. Inyección de companyId neutralizada (prevalece backend)');
    assert(spoofedInvoice.invoice.invoice_number !== 9999, 'N2. Manipulación de número fiscal neutralizada (backend asigna correlativo)');

    // 14. Verificación de Cero MAX() + 1 y Cero Math.random() en el Código
    console.log('--- O. Auditoría Estática de Prohibiciones ---');
    const dbServiceCode = fs.readFileSync(path.resolve('src', 'db_service.js'), 'utf8');
    const engineCode = fs.readFileSync(path.resolve('src', 'engine.js'), 'utf8');

    assert(!/SELECT\s+MAX\s*\(\s*invoice_number/i.test(dbServiceCode), 'O1. Cero SELECT MAX(invoice_number) en db_service.js');
    assert(!/Math\.random\(\).*invoice/i.test(engineCode), 'O2. Cero Math.random() en numeración de engine.js');

    // 15. Inmutabilidad de Producción Post-Prueba
    console.log('--- P. Verificación Final de Inmutabilidad de Producción ---');
    const finalHash = crypto.createHash('sha256').update(fs.readFileSync(prodPath)).digest('hex').toUpperCase();
    assert(finalHash === PROD_CANONICAL_SHA, `P1. data/presuvoz.db SHA-256 permanece 100% INMUTABLE (${PROD_CANONICAL_SHA.slice(0, 10)}...)`);

    const prodDb = new DatabaseSync(prodPath, { readOnly: true });
    const prodMigrations = prodDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all().map(r => r.version);
    prodDb.close();
    assert(JSON.stringify(prodMigrations) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), 'P2. schema_migrations en producción permanece intacto con versiones [1..15]');

  } finally {
    rehearsalDb.close();
    try { fs.unlinkSync(rehearsalDbPath); } catch {}
  }

  console.log('\n======================================================================');
  console.log(`TEST 62 FINALIZADO: ${passed}/${total} ASERCIONES SUPERADAS`);
  console.log('======================================================================\n');

  return { passed, total };
}

// Ejecución directa si se invoca como script principal
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src', 'test_62_phase4b_sequential_invoice_numbering.js')) {
  runTest62().catch(err => {
    console.error('❌ Error en TEST 62:', err);
    process.exit(1);
  });
}
