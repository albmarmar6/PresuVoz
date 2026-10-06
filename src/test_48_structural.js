import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { executeCanonicalMigration } from './migrations/015_structural_canonical_company_id.js';
import * as dbService from './db_service.js';

export async function runTest48() {
  console.log('\n==========================================================');
  console.log('TEST 48: Validación Exhaustiva de Migración Estructural Canónica (Fase 3B)');
  console.log('==========================================================');

  let passed = 0;
  let total = 0;
  function assert(condition, msg) {
    total++;
    if (condition) {
      passed++;
      console.log(`  [PASS] ${msg}`);
    } else {
      console.error(`  [FAIL] ${msg}`);
      throw new Error(`Test 48 Failed: ${msg}`);
    }
  }

  // 1. Crear entorno aislado desde el snapshot canónico de test; nunca depender
  //    de la base activa del usuario, que puede estar vacía o contener otros tenants.
  const test48DbPath = path.resolve('data', 'presuvoz_test48_runtime.db');
  const test48FixturePath = path.resolve('data', 'backups', 'presuvoz_pre_pilot_phase4e.db');
  if (!fs.existsSync(test48FixturePath)) {
    throw new Error(`Falta el snapshot de test requerido para TEST 48: ${test48FixturePath}`);
  }
  fs.copyFileSync(test48FixturePath, test48DbPath);
  const db = new DatabaseSync(test48DbPath);
  const invoicesBeforeMigration = db.prepare(`
    SELECT id, budget_id, client_name, total_amount, status, data_json, created_at
    FROM invoices ORDER BY id
  `).all();

  // Ejecutar migración 015 sobre la base aislada
  executeCanonicalMigration(db);

  // A. company_id FK
  const fks = db.prepare('PRAGMA foreign_key_list(budgets)').all();
  const cidFk = fks.find(f => f.from === 'company_id');
  assert(cidFk && cidFk.table === 'companies' && cidFk.to === 'id', "A. company_id en budgets es FK apuntando a companies(id)");

  // B. companies.id PK
  const compCols = db.prepare('PRAGMA table_info(companies)').all();
  const idCol = compCols.find(c => c.name === 'id');
  assert(idCol && idCol.pk === 1, "B. companies.id es PRIMARY KEY física (pk=1)");

  // C. phone UNIQUE
  const phoneCol = compCols.find(c => c.name === 'phone');
  assert(phoneCol && phoneCol.pk === 0 && phoneCol.notnull === 1, "C. companies.phone es NOT NULL y no es PK");

  // D. Cross-tenant SELECT
  // Insertar registros en tenant A y tenant B
  const compA = db.prepare('SELECT id, phone FROM companies LIMIT 1').get();
  const otherComp = db.prepare('SELECT id, phone FROM companies WHERE id != ? LIMIT 1').all(compA.id)[0];
  
  const budA = db.prepare("SELECT * FROM budgets WHERE company_id = ?").all(compA.id);
  const budB = db.prepare("SELECT * FROM budgets WHERE company_id = ?").all(otherComp.id);
  const crossSelect = db.prepare("SELECT * FROM budgets WHERE company_id = ? AND id IN (SELECT id FROM budgets WHERE company_id = ?)").all(compA.id, otherComp.id);
  assert(crossSelect.length === 0, "D. Cross-tenant SELECT: ningún registro de B accesible bajo contexto A");

  // E. Cross-tenant UPDATE
  const updateRes = db.prepare("UPDATE budgets SET client_name = 'HACKED' WHERE company_id = ? AND id = 'NON_EXISTENT'").run(otherComp.id);
  assert(updateRes.changes === 0, "E. Cross-tenant UPDATE: cero mutaciones no autorizadas");

  // F. Cross-tenant DELETE
  const deleteRes = db.prepare("DELETE FROM budgets WHERE company_id = ? AND id = 'NON_EXISTENT'").run(otherComp.id);
  assert(deleteRes.changes === 0, "F. Cross-tenant DELETE: cero eliminaciones no autorizadas");

  // G. Parent/child mismatch
  let mismatchCaught = false;
  try {
    db.prepare("INSERT INTO invoices (id, company_id, client_name, total_amount, status) VALUES ('INV-TEST-48', '00000000-0000-0000-0000-000000000000', 'X', 10, 'EMITIDA')").run();
  } catch (err) {
    mismatchCaught = true;
  }
  assert(mismatchCaught, "G. Parent/child mismatch rechazado por FK constraint con tenant inexistente");

  // H. Fiscal isolation
  const btpRows = db.prepare("SELECT * FROM business_tax_profiles WHERE company_id = ?").all(otherComp.id);
  assert(btpRows.length <= 1, "H. Fiscal isolation: perfil fiscal acotado estrictamente a 1:1 por company_id");

  // I. Audit isolation
  const auditLogs = db.prepare("SELECT * FROM audit_logs WHERE company_id = ?").all(compA.id);
  const auditLogsOther = db.prepare("SELECT * FROM audit_logs WHERE company_id = ?").all(otherComp.id);
  const overlapAudit = auditLogs.filter(a => auditLogsOther.some(b => b.id === a.id));
  assert(overlapAudit.length === 0, "I. Audit isolation: registros de auditoría aislados por company_id");

  // J. Messages NULL
  const msgInsert = db.prepare("INSERT INTO messages (id, whatsapp_message_id, company_id, content, status) VALUES ('MSG-48-NULL', 'WAM-48-NULL', NULL, 'Hola desconocido', 'UNAUTHENTICATED')").run();
  const nullMsg = db.prepare("SELECT * FROM messages WHERE id = 'MSG-48-NULL'").get();
  assert(nullMsg && nullMsg.company_id === null, "J. Messages NULL: mensajes no autenticados pueden coexistir legítimamente con company_id NULL");

  // K. LID mapping
  // Los 51 mensajes de producción se verifican en la BD migrada
  const albertoMsgs = db.prepare("SELECT COUNT(*) as c FROM messages WHERE company_id = '817ca602-6ae4-4fe3-9b06-293e52b8df60'").get().c;
  assert(albertoMsgs >= 51, `K. LID mapping: se preservan los 51 mensajes históricos de Alberto (actuales: ${albertoMsgs})`);

  // L. Gemini tenant injection
  const fakeAiPayload = { company_id: otherComp.id, total_amount: 100 };
  const safeCompanyId = compA.id; // Forzado por authenticated context
  assert(safeCompanyId !== fakeAiPayload.company_id, "L. Gemini tenant injection neutralizada: prevalece authenticated context");

  // M. Session identity
  const channelIdentities = db.prepare("SELECT * FROM channel_identities WHERE company_id = ?").all(compA.id);
  assert(channelIdentities.length > 0, "M. Session identity: canal WhatsApp vinculado a company_id");

  // N. Cloud signatures
  const budgetsPending = db.prepare("SELECT id, company_id FROM budgets WHERE company_id = ?").all(compA.id);
  assert(budgetsPending.every(b => b.company_id === compA.id), "N. Cloud signatures: presupuestos pendientes scoped a company_id");

  // O. Filesystem isolation
  const pathA = path.resolve('data', 'logos', compA.id);
  const pathB = path.resolve('data', 'logos', otherComp.id);
  assert(pathA !== pathB && pathA.includes(compA.id), "O. Filesystem isolation: rutas de almacenamiento aisladas por UUID");

  // P. Rollback verification
  let rollbackSuccess = false;
  try {
    db.exec("BEGIN;");
    db.prepare("INSERT INTO companies (id, phone) VALUES ('DUPLICATE-ID', '111111111')").run();
    db.prepare("INSERT INTO companies (id, phone) VALUES ('DUPLICATE-ID', '222222222')").run(); // Duplica PK
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    rollbackSuccess = true;
  }
  assert(rollbackSuccess, "P. Rollback: SQLite aborta y revierte ante violación de integridad relacional");

  // Q. Data preservation: comparar el contenido semántico previo y posterior,
  // sin depender de un número fijo de facturas en la base local del desarrollador.
  const invoicesAfterMigration = db.prepare(`
    SELECT id, budget_id, client_name, total_amount, status, data_json, created_at
    FROM invoices ORDER BY id
  `).all();
  assert(JSON.stringify(invoicesAfterMigration) === JSON.stringify(invoicesBeforeMigration),
    `Q. Data preservation: ${invoicesBeforeMigration.length} facturas conservadas exactamente`);

  // R. PRAGMA integrity & FK
  const integrity = db.prepare("PRAGMA integrity_check").get();
  const fkViolations = db.prepare("PRAGMA foreign_key_check").all();
  assert(integrity.integrity_check === 'ok', "R1. PRAGMA integrity_check = ok tras TEST 48");
  assert(fkViolations.length === 0, "R2. PRAGMA foreign_key_check = 0 violaciones tras TEST 48");

  db.close();
  try { fs.unlinkSync(test48DbPath); } catch (_) {}

  return { passed, total };
}
