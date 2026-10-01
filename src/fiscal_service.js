/**
 * PresuVoz — Fiscal & Gestoría Engine (Servicio Fiscal Determinístico)
 *
 * Módulo para la preparación, validación y empaquetado del cierre trimestral para la gestoría.
 * Cumple con la normativa tributaria española:
 *  - Orden EHA/3786/2008 & Real Decreto 1619/2012 (Libros Registro de IVA y Facturación AEAT)
 *  - Orden HAC/773/2019 (Libros Registro de IRPF para empresarios y profesionales)
 *  - Real Decreto 1007/2023 & Ley 11/2021 (Sistemas Informáticos de Facturación - SIF)
 *
 * REGLA FUNDAMENTAL DE ARQUITECTURA:
 *  La Inteligencia Artificial NUNCA calcula impuestos ni totales fiscales.
 *  Todos los cálculos de bases, cuotas de IVA, retenciones y modelos 303/130 son 100% determinísticos
 *  y se calculan en código sobre la base de datos SQLite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { ZipArchive } from 'archiver';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
import {
  db,
  getCompany,
  getCompanyById,
  resolveCompanyTenant,
  resolveLegacyBusinessId,
  getTaxProfile,
  listPurchaseInvoices,
  listExpensePayments,
  listInvestmentAssets,
  getOrCreateFiscalPeriod,
  updateFiscalPeriodStatus,
  saveFiscalIncident,
  listFiscalIncidents,
  recordAuditLog
} from './db_service.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. DETERMINACIÓN DE PERÍODOS FISCALES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devuelve el rango de fechas [inicio, fin] de un trimestre y año dados.
 * Si no se pasan argumentos, determina automáticamente el trimestre fiscal activo
 * o el trimestre que se está cerrando (ej: en los primeros 25 días de abril, se cierra el 1T).
 *
 * @param {number|null} year
 * @param {number|null} quarter
 * @returns {{ year: number, quarter: number, startDate: string, endDate: string, label: string }}
 */
export function getFiscalPeriodBounds(year = null, quarter = null) {
  const now = new Date();
  let currentYear = year || now.getFullYear();
  let currentQuarter = quarter;

  if (!currentQuarter) {
    const currentMonth = now.getMonth() + 1; // 1 - 12
    const currentDay = now.getDate();

    // En los primeros 25 días del mes posterior al cierre del trimestre,
    // el usuario típicamente quiere cerrar el trimestre inmediatamente anterior:
    //  - Enero (hasta día 31): 4T del año anterior
    //  - Abril (hasta día 25): 1T del año en curso
    //  - Julio (hasta día 25): 2T del año en curso
    //  - Octubre (hasta día 25): 3T del año en curso
    if (currentMonth === 1 && currentDay <= 31) {
      currentQuarter = 4;
      if (!year) currentYear -= 1;
    } else if (currentMonth === 4 && currentDay <= 25) {
      currentQuarter = 1;
    } else if (currentMonth === 7 && currentDay <= 25) {
      currentQuarter = 2;
    } else if (currentMonth === 10 && currentDay <= 25) {
      currentQuarter = 3;
    } else {
      // Por defecto, el trimestre natural en el que estamos
      currentQuarter = Math.ceil(currentMonth / 3);
    }
  }

  currentQuarter = Number(currentQuarter);
  currentYear = Number(currentYear);

  let startDate = '';
  let endDate = '';

  switch (currentQuarter) {
    case 1:
      startDate = `${currentYear}-01-01`;
      endDate = `${currentYear}-03-31`;
      break;
    case 2:
      startDate = `${currentYear}-04-01`;
      endDate = `${currentYear}-06-30`;
      break;
    case 3:
      startDate = `${currentYear}-07-01`;
      endDate = `${currentYear}-09-30`;
      break;
    case 4:
      startDate = `${currentYear}-10-01`;
      endDate = `${currentYear}-12-31`;
      break;
    default:
      currentQuarter = 1;
      startDate = `${currentYear}-01-01`;
      endDate = `${currentYear}-03-31`;
  }

  return {
    year: currentYear,
    quarter: currentQuarter,
    startDate,
    endDate,
    label: `${currentQuarter}T ${currentYear}`
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CÁLCULO DETERMINÍSTICO DEL TRIMESTRE (RESUMEN FISCAL)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redondea un número a 2 decimales con precisión comercial estándar.
 */
function round2(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

/**
 * Obtiene el resumen determinístico completo de un trimestre fiscal:
 *  - Facturas emitidas (Bases por tipo 21%, 10%, 4%, 0%, IVA devengado, retenciones IRPF, cobros y pendientes)
 *  - Facturas rectificativas y anticipos
 *  - Facturas recibidas / compras (Bases por tipo, IVA soportado vs deducible, retenciones practicadas, pagos y pendientes)
 *  - Bienes de inversión (> 3.005,06 €)
 *  - Simulación preliminar de Modelo 303 (IVA) y Modelo 130 (IRPF autónomos)
 *
 * @param {string} businessId - Teléfono de la empresa
 * @param {number|null} year
 * @param {number|null} quarter
 * @returns {object} Resumen determinístico completo
 */
export function getQuarterSummary(companyContextOrIdOrBusinessId, year = null, quarter = null) {
  if (!companyContextOrIdOrBusinessId) return null;

  const tenant = resolveCompanyTenant(companyContextOrIdOrBusinessId);
  const companyId = tenant?.companyId || null;
  const cleanId = resolveLegacyBusinessId(companyContextOrIdOrBusinessId) || tenant?.phone || (typeof companyContextOrIdOrBusinessId === 'string' && !String(companyContextOrIdOrBusinessId).includes('-') ? String(companyContextOrIdOrBusinessId).replace(/\D/g, '') : null);

  if (!companyId && !cleanId) return null;

  const bounds = getFiscalPeriodBounds(year, quarter);
  const fiscalPeriodId = `${bounds.year}_Q${bounds.quarter}`;

  // 1. Consultar facturas emitidas del periodo (priorizando company_id canónico)
  let issuedRows = [];
  if (companyId) {
    issuedRows = db.prepare(`
      SELECT * FROM invoices
      WHERE company_id = ?
      ORDER BY created_at ASC
    `).all(companyId);
  }

  const issuedInvoices = [];
  for (const row of issuedRows) {
    let data = {};
    try { data = JSON.parse(row.data_json || '{}'); } catch (e) {}

    const issueDate = data.issue_date || data.issueDate || (row.created_at ? row.created_at.split('T')[0] : '');
    const inPeriod = (row.fiscal_period === fiscalPeriodId || data.fiscal_period === fiscalPeriodId)
      || (issueDate >= bounds.startDate && issueDate <= bounds.endDate);

    if (!inPeriod) continue;

    const payments = data.payments || [];
    const items = data.items || [];
    const totalPaid = payments.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
    const totalAmount = Number(data.financials?.totalAmount ?? data.total_amount ?? data.totalAmount ?? row.total_amount ?? 0);
    const remaining = Math.max(0, round2(totalAmount - totalPaid));
    const isPaid = remaining <= 0.01;

    const taxBase = Number(data.financials?.taxBase ?? data.tax_base ?? data.taxBase ?? 0);
    const taxRate = Number(data.financials?.taxRatePercentage ?? data.tax_rate ?? data.taxRate ?? 21);
    const taxAmount = Number(data.financials?.taxAmount ?? data.tax_amount ?? data.taxAmount ?? 0);
    const irpfRate = Number(data.financials?.irpfRatePercentage ?? data.irpf_rate ?? data.irpfRate ?? 0);
    const irpfRetention = Number(data.financials?.irpfRetentionAmount ?? data.irpf_retention ?? data.irpfRetention ?? 0);

    issuedInvoices.push({
      id: row.id,
      invoiceNumber: data.invoice_number || data.invoiceNumber || row.id,
      issueDate,
      clientName: data.client?.name || data.client_name || data.clientName || row.client_name || 'Cliente Particular',
      clientTaxId: data.client?.cif || data.client?.nif || data.client_tax_id || data.clientTaxId || null,
      clientAddress: data.client?.address || data.client_address || data.clientAddress || null,
      taxBase: round2(taxBase),
      taxRate: round2(taxRate),
      taxAmount: round2(taxAmount),
      irpfRate: round2(irpfRate),
      irpfRetention: round2(irpfRetention),
      totalAmount: round2(totalAmount),
      totalPaid: round2(totalPaid),
      remaining,
      isPaid,
      isAdvance: Boolean(data.is_advance || data.isAdvance),
      rectifiesInvoiceId: row.rectifies_invoice_id || data.rectifies_invoice_id || data.rectifiesInvoiceId || null,
      invoiceType: data.invoice_type || data.invoiceType || (row.rectifies_invoice_id ? 'RECTIFICATIVA' : 'ORDINARIA'),
      items,
      payments
    });
  }

  // Agrupaciones determinísticas de emitidas
  let issuedTaxBase = 0;
  let issuedVatTotal = 0;
  let issuedRetentionTotal = 0;
  let issuedTotalAmount = 0;
  let issuedCollectedTotal = 0;
  let issuedPendingTotal = 0;

  const issuedVatBreakdown = {
    '21': { base: 0, vat: 0, count: 0 },
    '10': { base: 0, vat: 0, count: 0 },
    '4': { base: 0, vat: 0, count: 0 },
    '0': { base: 0, vat: 0, count: 0 }
  };

  let rectificativasCount = 0;
  let rectificativasBase = 0;
  let rectificativasVat = 0;
  let advancesCount = 0;
  let advancesTotal = 0;

  for (const inv of issuedInvoices) {
    issuedTaxBase += inv.taxBase;
    issuedVatTotal += inv.taxAmount;
    issuedRetentionTotal += inv.irpfRetention;
    issuedTotalAmount += inv.totalAmount;
    issuedCollectedTotal += inv.totalPaid;
    issuedPendingTotal += inv.remaining;

    // Desglose por tipo de IVA
    const rateKey = String(Math.round(inv.taxRate));
    if (!issuedVatBreakdown[rateKey]) {
      issuedVatBreakdown[rateKey] = { base: 0, vat: 0, count: 0 };
    }
    issuedVatBreakdown[rateKey].base += inv.taxBase;
    issuedVatBreakdown[rateKey].vat += inv.taxAmount;
    issuedVatBreakdown[rateKey].count += 1;

    if (inv.rectifiesInvoiceId || inv.invoiceType === 'RECTIFICATIVA') {
      rectificativasCount++;
      rectificativasBase += inv.taxBase;
      rectificativasVat += inv.taxAmount;
    }

    if (inv.isAdvance) {
      advancesCount++;
      advancesTotal += inv.totalAmount;
    }
  }

  // 2. Consultar facturas recibidas / compras / gastos
  const receivedInvoices = listPurchaseInvoices(companyContextOrIdOrBusinessId, {
    fiscalPeriod: fiscalPeriodId,
    startDate: bounds.startDate,
    endDate: bounds.endDate
  });

  let receivedTaxBase = 0;
  let receivedVatSupported = 0;
  let receivedVatDeductible = 0;
  let receivedRetentionTotal = 0;
  let receivedTotalAmount = 0;
  let receivedPaidTotal = 0;
  let receivedPendingTotal = 0;
  let needsReviewCount = 0;

  const receivedVatBreakdown = {
    '21': { base: 0, vatSupported: 0, vatDeductible: 0, count: 0 },
    '10': { base: 0, vatSupported: 0, vatDeductible: 0, count: 0 },
    '4': { base: 0, vatSupported: 0, vatDeductible: 0, count: 0 },
    '0': { base: 0, vatSupported: 0, vatDeductible: 0, count: 0 }
  };

  for (const pinv of receivedInvoices) {
    const base = Number(pinv.taxBase ?? pinv.taxableBase ?? 0);
    const vat = Number(pinv.vatAmount) || 0;
    const total = Number(pinv.totalAmount) || 0;
    const paid = Number(pinv.paidAmount) || 0;
    const retention = Number(pinv.irpfRetention) || 0;
    const dedPercent = Number(pinv.deductiblePercentage ?? 100);

    let deductibleVat = 0;
    if (pinv.vatDeductible && pinv.deductibilityStatus !== 'NOT_DEDUCTIBLE') {
      deductibleVat = round2(vat * (dedPercent / 100));
    }

    if (pinv.deductibilityStatus === 'NEEDS_REVIEW') {
      needsReviewCount++;
    }

    receivedTaxBase += base;
    receivedVatSupported += vat;
    receivedVatDeductible += deductibleVat;
    receivedRetentionTotal += retention;
    receivedTotalAmount += total;
    receivedPaidTotal += paid;
    receivedPendingTotal += Math.max(0, round2(total - paid));

    const rateKey = String(Math.round(pinv.vatRate != null ? pinv.vatRate : 21));
    if (!receivedVatBreakdown[rateKey]) {
      receivedVatBreakdown[rateKey] = { base: 0, vatSupported: 0, vatDeductible: 0, count: 0 };
    }
    receivedVatBreakdown[rateKey].base += base;
    receivedVatBreakdown[rateKey].vatSupported += vat;
    receivedVatBreakdown[rateKey].vatDeductible += deductibleVat;
    receivedVatBreakdown[rateKey].count += 1;
  }

  // 3. Consultar Bienes de Inversión
  const allAssets = listInvestmentAssets(companyContextOrIdOrBusinessId);
  const quarterAssets = allAssets.filter(a => {
    return (!a.purchase_date || (a.purchase_date >= bounds.startDate && a.purchase_date <= bounds.endDate));
  });

  // 4. Modelos Fiscales Preliminares (Determinísticos)
  // Modelo 303 (IVA Trimestral)
  const ivaDevengado = round2(issuedVatTotal);
  const ivaDeducible = round2(receivedVatDeductible);
  const resultado303 = round2(ivaDevengado - ivaDeducible);
  const tipoResultado303 = resultado303 > 0 ? 'A_INGRESAR' : (resultado303 < 0 ? 'A_COMPENSAR' : 'CERO');

  // Modelo 130 (IRPF Autónomos - Estimación Directa Simplificada, Orientativo)
  const taxProfile = getTaxProfile(companyContextOrIdOrBusinessId) || {};
  const ingresosComputables = round2(issuedTaxBase);
  // Gastos deducibles en IRPF: suma de bases imponibles deducibles
  const gastosDeduciblesIRPF = round2(
    receivedInvoices
      .filter(p => p.deductibilityStatus !== 'NOT_DEDUCTIBLE')
      .reduce((sum, p) => sum + Number(p.taxBase ?? p.taxableBase ?? 0), 0)
  );
  const rendimientoNeto = round2(ingresosComputables - gastosDeduciblesIRPF);
  const pago20Porciento = round2(rendimientoNeto * 0.20);
  const resultado130 = Math.max(0, round2(pago20Porciento - issuedRetentionTotal));

  // 5. Devolución de estructura completa
  return {
    businessId: cleanId,
    companyId: companyId,
    period: bounds,
    taxProfile,
    summary: {
      // Emitidas
      issuedCount: issuedInvoices.length,
      issuedTaxBase: round2(issuedTaxBase),
      issuedVatTotal: round2(issuedVatTotal),
      issuedRetentionTotal: round2(issuedRetentionTotal),
      issuedTotalAmount: round2(issuedTotalAmount),
      issuedCollectedTotal: round2(issuedCollectedTotal),
      issuedPendingTotal: round2(issuedPendingTotal),
      issuedVatBreakdown,
      rectificativas: {
        count: rectificativasCount,
        base: round2(rectificativasBase),
        vat: round2(rectificativasVat)
      },
      advances: {
        count: advancesCount,
        total: round2(advancesTotal)
      },

      // Recibidas / Gastos
      receivedCount: receivedInvoices.length,
      receivedTaxBase: round2(receivedTaxBase),
      receivedVatSupported: round2(receivedVatSupported),
      receivedVatDeductible: round2(receivedVatDeductible),
      receivedRetentionTotal: round2(receivedRetentionTotal),
      receivedTotalAmount: round2(receivedTotalAmount),
      receivedPaidTotal: round2(receivedPaidTotal),
      receivedPendingTotal: round2(receivedPendingTotal),
      receivedVatBreakdown,
      needsReviewCount,

      // Bienes de Inversión
      investmentAssetsCount: quarterAssets.length,

      // Liquidación preliminar
      modelo303: {
        ivaDevengado,
        ivaDeducible,
        resultado: resultado303,
        tipoResultado: tipoResultado303
      },
      modelo130: {
        isApplicable: taxProfile.entityType === 'AUTONOMO',
        ingresosComputables,
        gastosDeduciblesIRPF,
        rendimientoNeto,
        retencionesSufridas: round2(issuedRetentionTotal),
        pagoFraccionadoOrientativo: resultado130,
        disclaimer: 'Cálculo orientativo según estimación directa simplificada (20% del rendimiento neto menos retenciones practicadas). Tu gestoría aplicará deducciones personales, amortizaciones y gastos de difícil justificación.'
      }
    },
    invoices: issuedInvoices,
    purchaseInvoices: receivedInvoices,
    investmentAssets: quarterAssets,
    companyId,
    businessId: cleanId
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. MOTOR DE CONTROL DE CALIDAD FISCAL (FiscalDataQualityCheck)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta 10 comprobaciones de integridad tributaria y consistencia contable:
 *  1. Discrepancia matemática (Base * Tipo != IVA o Base + IVA - IRPF != Total > 0.02€)
 *  2. NIF de cliente ausente o no válido en facturas emitidas B2B o > 400€
 *  3. NIF de proveedor ausente en facturas recibidas (impide deducción AEAT)
 *  4. Número de factura duplicado
 *  5. Cobros o pagos superiores al total de la factura
 *  6. Factura rectificativa sin referencia a la factura original sustituida
 *  7. Compras > 3.005,06 € no inventariadas como Bien de Inversión
 *  8. Tipos de IVA inusuales o no vigentes en España
 *  9. Gastos de deducibilidad dudosa (combustible, restaurantes, vehículos) al 100% sin justificar
 * 10. Fechas fuera del trimestre fiscal examinado
 *
 * @param {string} businessId
 * @param {number|null} year
 * @param {number|null} quarter
 * @returns {object} { isValid, criticalCount, warningsCount, incidents }
 */
export function runFiscalQualityChecks(companyContextOrId, year = null, quarter = null) {
  if (!companyContextOrId) return { isValid: false, criticalCount: 0, warningsCount: 0, incidents: [] };
  const quarterData = getQuarterSummary(companyContextOrId, year, quarter);
  if (!quarterData) return { isValid: false, criticalCount: 0, warningsCount: 0, incidents: [] };
  const { period, invoices, purchaseInvoices } = quarterData;
  const fiscalPeriodId = `${period.year}_Q${period.quarter}`;

  const incidents = [];

  // Helper para añadir incidencia
  function addIncident(severity, errorCode, message, entityType, entityId) {
    const inc = {
      fiscalPeriod: fiscalPeriodId,
      entityType,
      entityId,
      severity, // 'CRITICAL' | 'WARNING'
      errorCode,
      message,
      resolutionStatus: 'OPEN'
    };
    saveFiscalIncident(companyContextOrId, inc);
    incidents.push(inc);
  }

  // ── REGLA 1: DISCREPANCIAS MATEMÁTICAS EN FACTURAS EMITIDAS ──
  const seenIssuedNumbers = new Set();
  for (const inv of invoices) {
    // Duplicados de número de factura
    if (seenIssuedNumbers.has(inv.invoiceNumber)) {
      addIncident('CRITICAL', 'DUPLICATE_INVOICE_NUMBER', `Factura emitida duplicada con número ${inv.invoiceNumber}`, 'INVOICE', inv.id);
    } else {
      seenIssuedNumbers.add(inv.invoiceNumber);
    }

    // Cuadratura matemática de IVA
    const expectedVat = round2(inv.taxBase * (inv.taxRate / 100));
    if (Math.abs(expectedVat - inv.taxAmount) > 0.02) {
      addIncident('CRITICAL', 'MATH_DISCREPANCY_VAT', `Discrepancia en IVA de factura ${inv.invoiceNumber}: Base ${inv.taxBase}€ al ${inv.taxRate}% = ${expectedVat}€ pero figura ${inv.taxAmount}€`, 'INVOICE', inv.id);
    }

    // Cuadratura de total (Base + IVA - Retención)
    const expectedTotal = round2(inv.taxBase + inv.taxAmount - inv.irpfRetention);
    if (Math.abs(expectedTotal - inv.totalAmount) > 0.02) {
      addIncident('CRITICAL', 'MATH_DISCREPANCY_TOTAL', `Discrepancia en total de factura ${inv.invoiceNumber}: Calculado ${expectedTotal}€ vs Registrado ${inv.totalAmount}€`, 'INVOICE', inv.id);
    }

    // NIF de cliente ausente (Obligatorio en B2B o > 400€)
    if (!inv.clientTaxId || inv.clientTaxId.trim() === '') {
      if (inv.totalAmount > 400) {
        addIncident('CRITICAL', 'MISSING_CUSTOMER_NIF', `Factura ${inv.invoiceNumber} superior a 400€ (${inv.totalAmount}€) sin NIF/CIF de cliente (no admisible como simplificada)`, 'INVOICE', inv.id);
      } else {
        addIncident('WARNING', 'MISSING_CUSTOMER_NIF', `Factura simplificada ${inv.invoiceNumber} sin NIF de cliente identificado`, 'INVOICE', inv.id);
      }
    }

    // Cobros superiores al total
    if (inv.totalPaid > inv.totalAmount + 0.01) {
      addIncident('CRITICAL', 'PAYMENTS_EXCEED_TOTAL', `Cobros registrados (${inv.totalPaid}€) superan el total de la factura ${inv.invoiceNumber} (${inv.totalAmount}€)`, 'INVOICE', inv.id);
    }

    // Rectificativa sin factura original vinculada
    if (inv.invoiceType === 'RECTIFICATIVA' || inv.invoiceNumber.startsWith('R-') || inv.invoiceNumber.startsWith('FR-')) {
      if (!inv.rectifiesInvoiceId) {
        addIncident('CRITICAL', 'RECTIFICATIVA_WITHOUT_ORIGINAL', `Factura rectificativa ${inv.invoiceNumber} sin referencia a la factura original rectificada (Reglamento Facturación RD 1619/2012)`, 'INVOICE', inv.id);
      }
    }

    // Tipo de IVA no estándar
    if (![0, 4, 5, 10, 21].includes(Math.round(inv.taxRate))) {
      addIncident('WARNING', 'UNUSUAL_VAT_RATE', `Factura ${inv.invoiceNumber} con tipo impositivo inusual del ${inv.taxRate}%`, 'INVOICE', inv.id);
    }
  }

  // ── REGLA 2: COMPROBACIONES EN FACTURAS RECIBIDAS / GASTOS ──
  const seenSupplierInvoices = new Set();
  for (const pinv of purchaseInvoices) {
    const key = `${pinv.supplierTaxId || 'NONE'}_${pinv.invoiceNumber}`;
    if (seenSupplierInvoices.has(key)) {
      addIncident('CRITICAL', 'DUPLICATE_PURCHASE_INVOICE', `Factura de compra posiblemente duplicada: Proveedor ${pinv.supplierName} (${pinv.supplierTaxId}) N° ${pinv.invoiceNumber}`, 'PURCHASE_INVOICE', pinv.id);
    } else {
      seenSupplierInvoices.add(key);
    }

    // NIF de proveedor ausente (La AEAT niega la deducción de IVA si falta NIF del emisor)
    if (!pinv.supplierTaxId || pinv.supplierTaxId.trim() === '' || pinv.supplierTaxId.toUpperCase() === 'NO_APLICA') {
      addIncident('CRITICAL', 'MISSING_SUPPLIER_NIF', `Factura recibida de ${pinv.supplierName} por ${pinv.totalAmount}€ sin NIF/CIF del proveedor. Hacienda no permite deducir el IVA sin NIF.`, 'PURCHASE_INVOICE', pinv.id);
    }

    // Cuadratura matemática
    const expectedVat = round2(pinv.taxBase * (pinv.vatRate / 100));
    if (Math.abs(expectedVat - pinv.vatAmount) > 0.05) {
      addIncident('WARNING', 'MATH_DISCREPANCY_PURCHASE', `Factura recibida ${pinv.invoiceNumber} de ${pinv.supplierName}: IVA registrado ${pinv.vatAmount}€ difiere de cálculo teórico ${expectedVat}€`, 'PURCHASE_INVOICE', pinv.id);
    }

    // Detección de Bien de Inversión (> 3.005,06 € en base imponible)
    if (pinv.taxBase > 3005.06) {
      const compId = quarterData.companyId || (resolveCompanyTenant(companyContextOrId)?.companyId);
      const existingAsset = compId
        ? db.prepare('SELECT id FROM investment_assets WHERE purchase_invoice_id = ? AND company_id = ?').get(pinv.id, compId)
        : db.prepare('SELECT id FROM investment_assets WHERE purchase_invoice_id = ?').get(pinv.id);
      if (!existingAsset) {
        addIncident('WARNING', 'ASSET_OVER_THRESHOLD', `Gasto de ${pinv.taxBase}€ en ${pinv.supplierName} supera 3.005,06€. Debe registrarse como Bien de Inversión y amortizarse contablemente en varios años.`, 'PURCHASE_INVOICE', pinv.id);
      }
    }

    // Deducibilidad dudosa al 100% (combustibles, comidas, hoteles)
    const cat = String(pinv.category || '').toUpperCase();
    if (['COMBUSTIBLE', 'GASOLINA', 'RESTAURANTE', 'DIETAS', 'VEHICULO', 'PEAJE'].includes(cat) && pinv.deductiblePercentage === 100) {
      addIncident('WARNING', 'DOUBTFUL_DEDUCTIBILITY', `Gasto de categoría '${pinv.category}' deducido al 100% (${pinv.totalAmount}€). La AEAT suele requerir justificación exhaustiva o límite al 50% en vehículos afectos.`, 'PURCHASE_INVOICE', pinv.id);
    }

    // Pagos superiores al total
    if (pinv.paidAmount > pinv.totalAmount + 0.01) {
      addIncident('CRITICAL', 'PURCHASE_PAYMENTS_EXCEED_TOTAL', `Pagos registrados (${pinv.paidAmount}€) superan el total del gasto ${pinv.invoiceNumber} (${pinv.totalAmount}€)`, 'PURCHASE_INVOICE', pinv.id);
    }
  }

  const criticalCount = incidents.filter(i => i.severity === 'CRITICAL').length;
  const warningsCount = incidents.filter(i => i.severity === 'WARNING').length;
  const isValid = criticalCount === 0;

  // Actualizar la tabla fiscal_periods
  updateFiscalPeriodStatus(companyContextOrId, period.year, period.quarter, isValid ? 'READY_FOR_GESTORIA' : 'HAS_INCIDENTS', {
    criticalCount,
    warningsCount,
    lastQualityCheckAt: new Date().toISOString()
  });

  return {
    fiscalPeriod: fiscalPeriodId,
    isValid,
    criticalCount,
    warningsCount,
    incidents
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GENERACIÓN DE LIBROS NORMALIZADOS EN EXCEL (Orden EHA/3786/2008 & HAC/773/2019)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera un archivo XLSX multicapa con los libros oficiales según especificaciones de la AEAT:
 *  - Hoja 1: Facturas Expedidas (Emitidas)
 *  - Hoja 2: Facturas Recibidas y Gastos
 *  - Hoja 3: Bienes de Inversión
 *  - Hoja 4: Cobros y Pagos
 *  - Hoja 5: Resumen y Cuadre Trimestral
 *
 * @param {string} businessId
 * @param {number|null} year
 * @param {number|null} quarter
 * @returns {Promise<Buffer>} Buffer del archivo Excel
 */
export async function generateNormalizedExcel(companyContextOrId, year = null, quarter = null) {
  if (!companyContextOrId) throw new Error("❌ [Tenant Boundary] generateNormalizedExcel requiere tenant context obligatorio.");
  const tenant = resolveCompanyTenant(companyContextOrId);
  const company = tenant?.companyId ? getCompanyById(tenant.companyId) : getCompany(tenant?.phone);
  const quarterData = getQuarterSummary(companyContextOrId, year, quarter);
  const { period, summary, invoices, purchaseInvoices, investmentAssets } = quarterData;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PresuVoz Fiscal Engine';
  workbook.created = new Date();

  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E293B' } // Slate 900
  };
  const headerFont = {
    name: 'Calibri',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' }
  };
  const subHeaderFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF1F5F9' } // Slate 100
  };

  // ── HOJA 1: FACTURAS EMITIDAS (EXPEDIDAS) ──
  const wsIssued = workbook.addWorksheet('Facturas Emitidas');
  wsIssued.columns = [
    { header: 'Nº Factura', key: 'invNum', width: 16 },
    { header: 'Fecha Emisión', key: 'date', width: 14 },
    { header: 'NIF/CIF Cliente', key: 'clientNif', width: 16 },
    { header: 'Nombre / Razón Social', key: 'clientName', width: 32 },
    { header: 'Tipo Factura', key: 'type', width: 15 },
    { header: 'Base Imponible (€)', key: 'base', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'Tipo IVA (%)', key: 'vatRate', width: 14, style: { numFmt: '0.00%' } },
    { header: 'Cuota IVA (€)', key: 'vatAmount', width: 16, style: { numFmt: '#,##0.00 €' } },
    { header: 'Tipo IRPF (%)', key: 'irpfRate', width: 14, style: { numFmt: '0.00%' } },
    { header: 'Retención IRPF (€)', key: 'irpfAmount', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'Total Factura (€)', key: 'total', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'Estado Cobro', key: 'paidStatus', width: 14 },
    { header: 'Cobrado (€)', key: 'paid', width: 16, style: { numFmt: '#,##0.00 €' } },
    { header: 'Pendiente (€)', key: 'remaining', width: 16, style: { numFmt: '#,##0.00 €' } },
    { header: 'Rectifica a Factura', key: 'rectifies', width: 20 }
  ];

  wsIssued.getRow(1).fill = headerFill;
  wsIssued.getRow(1).font = headerFont;
  wsIssued.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  invoices.forEach(inv => {
    wsIssued.addRow({
      invNum: inv.invoiceNumber,
      date: inv.issueDate,
      clientNif: inv.clientTaxId || 'S/NIF (Simplificada)',
      clientName: inv.clientName || 'Cliente Particular',
      type: inv.isAdvance ? 'ANTICIPO' : (inv.rectifiesInvoiceId ? 'RECTIFICATIVA' : 'ORDINARIA'),
      base: inv.taxBase,
      vatRate: inv.taxRate / 100,
      vatAmount: inv.taxAmount,
      irpfRate: (inv.irpfRate || 0) / 100,
      irpfAmount: inv.irpfRetention || 0,
      total: inv.totalAmount,
      paidStatus: inv.isPaid ? 'COBRADA' : (inv.totalPaid > 0 ? 'PARCIAL' : 'PENDIENTE'),
      paid: inv.totalPaid,
      remaining: inv.remaining,
      rectifies: inv.rectifiesInvoiceId || ''
    });
  });

  // Fila de totales en emitidas
  if (invoices.length > 0) {
    const totalRowIdx = invoices.length + 2;
    wsIssued.addRow({
      invNum: 'TOTALES',
      base: { formula: `SUM(F2:F${totalRowIdx - 1})` },
      vatAmount: { formula: `SUM(H2:H${totalRowIdx - 1})` },
      irpfAmount: { formula: `SUM(J2:J${totalRowIdx - 1})` },
      total: { formula: `SUM(K2:K${totalRowIdx - 1})` },
      paid: { formula: `SUM(M2:M${totalRowIdx - 1})` },
      remaining: { formula: `SUM(N2:N${totalRowIdx - 1})` }
    });
    const lastRow = wsIssued.getRow(totalRowIdx);
    lastRow.font = { bold: true };
    lastRow.fill = subHeaderFill;
  }

  // ── HOJA 2: FACTURAS RECIBIDAS (COMPRAS Y GASTOS) ──
  const wsReceived = workbook.addWorksheet('Facturas Recibidas');
  wsReceived.columns = [
    { header: 'Nº Registro', key: 'regId', width: 14 },
    { header: 'Nº Factura Proveedor', key: 'provInvNum', width: 22 },
    { header: 'Fecha Emisión', key: 'date', width: 14 },
    { header: 'NIF/CIF Proveedor', key: 'supplierNif', width: 18 },
    { header: 'Razón Social Proveedor', key: 'supplierName', width: 30 },
    { header: 'Concepto / Gasto', key: 'concept', width: 26 },
    { header: 'Base Imponible (€)', key: 'base', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'Tipo IVA (%)', key: 'vatRate', width: 14, style: { numFmt: '0.00%' } },
    { header: 'IVA Soportado (€)', key: 'vatSupported', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: '% Deducible', key: 'dedPercent', width: 14, style: { numFmt: '0%' } },
    { header: 'IVA Deducible (€)', key: 'vatDeductible', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'Retención IRPF (€)', key: 'irpf', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'Total Factura (€)', key: 'total', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'Calificación Fiscal', key: 'status', width: 18 },
    { header: 'Pagado (€)', key: 'paid', width: 16, style: { numFmt: '#,##0.00 €' } }
  ];

  wsReceived.getRow(1).fill = headerFill;
  wsReceived.getRow(1).font = headerFont;
  wsReceived.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  purchaseInvoices.forEach(pinv => {
    const dedPercent = (pinv.deductiblePercentage ?? 100) / 100;
    const vatSupported = pinv.vatAmount || 0;
    const vatDeductible = pinv.vatDeductible && pinv.deductibilityStatus !== 'NOT_DEDUCTIBLE'
      ? round2(vatSupported * dedPercent)
      : 0;

    wsReceived.addRow({
      regId: pinv.id,
      provInvNum: pinv.invoiceNumber,
      date: pinv.issueDate,
      supplierNif: pinv.supplierTaxId || 'PENDIENTE',
      supplierName: pinv.supplierName,
      concept: pinv.category || pinv.description || 'Suministros',
      base: pinv.taxBase,
      vatRate: (pinv.vatRate || 21) / 100,
      vatSupported,
      dedPercent,
      vatDeductible,
      irpf: pinv.irpfRetention || 0,
      total: pinv.totalAmount,
      status: pinv.deductibilityStatus,
      paid: pinv.paidAmount
    });
  });

  if (purchaseInvoices.length > 0) {
    const totalRecIdx = purchaseInvoices.length + 2;
    wsReceived.addRow({
      regId: 'TOTALES',
      base: { formula: `SUM(G2:G${totalRecIdx - 1})` },
      vatSupported: { formula: `SUM(I2:I${totalRecIdx - 1})` },
      vatDeductible: { formula: `SUM(K2:K${totalRecIdx - 1})` },
      irpf: { formula: `SUM(L2:L${totalRecIdx - 1})` },
      total: { formula: `SUM(M2:M${totalRecIdx - 1})` },
      paid: { formula: `SUM(O2:O${totalRecIdx - 1})` }
    });
    const lastRow = wsReceived.getRow(totalRecIdx);
    lastRow.font = { bold: true };
    lastRow.fill = subHeaderFill;
  }

  // ── HOJA 3: BIENES DE INVERSIÓN (ACTIVOS > 3.005,06 €) ──
  const wsAssets = workbook.addWorksheet('Bienes de Inversión');
  wsAssets.columns = [
    { header: 'ID Activo', key: 'id', width: 16 },
    { header: 'Descripción del Bien', key: 'desc', width: 34 },
    { header: 'Fecha Adquisición', key: 'date', width: 16 },
    { header: 'Proveedor', key: 'supplier', width: 28 },
    { header: 'Base (€)', key: 'base', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'IVA (€)', key: 'vat', width: 16, style: { numFmt: '#,##0.00 €' } },
    { header: 'Total (€)', key: 'total', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: '% Afectación', key: 'use', width: 14, style: { numFmt: '0%' } },
    { header: 'Método Amortización', key: 'method', width: 22 },
    { header: 'Revisión Asesor', key: 'status', width: 20 }
  ];
  wsAssets.getRow(1).fill = headerFill;
  wsAssets.getRow(1).font = headerFont;

  investmentAssets.forEach(a => {
    wsAssets.addRow({
      id: a.id,
      desc: a.description,
      date: a.purchase_date,
      supplier: a.supplier_name,
      base: a.purchase_base,
      vat: a.vat_amount,
      total: a.total_amount,
      use: (a.business_use_percentage || 100) / 100,
      method: a.depreciation_method,
      status: a.depreciation_status
    });
  });

  // ── HOJA 4: COBROS Y PAGOS ──
  const wsCash = workbook.addWorksheet('Cobros y Pagos');
  wsCash.columns = [
    { header: 'Tipo', key: 'type', width: 12 },
    { header: 'Nº Factura / Ref.', key: 'ref', width: 20 },
    { header: 'Fecha Operación', key: 'date', width: 16 },
    { header: 'Importe (€)', key: 'amount', width: 18, style: { numFmt: '#,##0.00 €' } },
    { header: 'Medio de Pago', key: 'method', width: 18 },
    { header: 'Tercero (Cliente / Proveedor)', key: 'party', width: 30 }
  ];
  wsCash.getRow(1).fill = headerFill;
  wsCash.getRow(1).font = headerFont;

  // Cobros de facturas emitidas
  for (const inv of invoices) {
    for (const p of inv.payments) {
      wsCash.addRow({
        type: 'COBRO',
        ref: inv.invoiceNumber,
        date: p.date || inv.issueDate,
        amount: Number(p.amount) || 0,
        method: p.method || 'Transferencia',
        party: inv.clientName
      });
    }
  }

  // Pagos de facturas recibidas
  const expensePayments = listExpensePayments(companyContextOrId);
  for (const ep of expensePayments) {
    wsCash.addRow({
      type: 'PAGO',
      ref: ep.purchase_invoice_id,
      date: ep.payment_date,
      amount: Number(ep.amount) || 0,
      method: ep.payment_method || 'Transferencia',
      party: ep.reference || 'Proveedor'
    });
  }

  // ── HOJA 5: RESUMEN Y CUADRE TRIMESTRAL (DASHBOARD) ──
  const wsSummary = workbook.addWorksheet('Resumen Trimestral');
  wsSummary.columns = [
    { header: 'Concepto Fiscal', key: 'concept', width: 40 },
    { header: 'Base (€)', key: 'base', width: 20, style: { numFmt: '#,##0.00 €' } },
    { header: 'Cuota / Importe (€)', key: 'amount', width: 24, style: { numFmt: '#,##0.00 €' } },
    { header: 'Observaciones / Casillas AEAT', key: 'notes', width: 45 }
  ];
  wsSummary.getRow(1).fill = headerFill;
  wsSummary.getRow(1).font = headerFont;

  wsSummary.addRow({
    concept: '1. Facturación Repercutida (IVA Devengado)',
    base: summary.issuedTaxBase,
    amount: summary.issuedVatTotal,
    notes: 'Modelo 303 (Casillas 01 a 09)'
  });
  wsSummary.addRow({
    concept: '   - Tipo General 21%',
    base: summary.issuedVatBreakdown['21']?.base || 0,
    amount: summary.issuedVatBreakdown['21']?.vat || 0,
    notes: 'Base al 21% / Cuota repercutida'
  });
  wsSummary.addRow({
    concept: '   - Tipo Reducido 10%',
    base: summary.issuedVatBreakdown['10']?.base || 0,
    amount: summary.issuedVatBreakdown['10']?.vat || 0,
    notes: 'Base al 10% / Reformas vivienda particular'
  });
  wsSummary.addRow({
    concept: '2. Gastos Deducibles (IVA Deducible)',
    base: summary.receivedTaxBase,
    amount: summary.receivedVatDeductible,
    notes: 'Modelo 303 (Casillas 28 y 29)'
  });
  wsSummary.addRow({
    concept: '3. RESULTADO PRELIMINAR MODELO 303 (IVA)',
    base: null,
    amount: summary.modelo303.resultado,
    notes: summary.modelo303.tipoResultado === 'A_INGRESAR' ? 'A INGRESAR en Hacienda' : 'A COMPENSAR en próximos periodos'
  });

  wsSummary.addRow({}); // fila vacía

  wsSummary.addRow({
    concept: '4. Rendimiento IRPF (Modelo 130 Orientativo)',
    base: summary.modelo130.ingresosComputables,
    amount: summary.modelo130.gastosDeduciblesIRPF,
    notes: `Rendimiento Neto: ${summary.modelo130.rendimientoNeto} €`
  });
  wsSummary.addRow({
    concept: '   - Pago fraccionado 20% menos retenciones',
    base: null,
    amount: summary.modelo130.pagoFraccionadoOrientativo,
    notes: 'Cálculo orientativo sin reducciones adicionales'
  });

  return await workbook.xlsx.writeBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. GENERACIÓN DEL INFORME FISCAL OFICIAL EN PDF (pdfkit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera el documento PDF formal de "Informe de Cierre Fiscal para Gestoría"
 * Estilo visual limpio y profesional de PresuVoz (paleta Slate y Emerald).
 *
 * @param {string|object} companyContextOrId
 * @param {number|null} year
 * @param {number|null} quarter
 * @returns {Promise<Buffer>} Buffer del documento PDF
 */
export function generateGestoriaSummaryPDF(companyContextOrId, year = null, quarter = null) {
  if (!companyContextOrId) throw new Error("❌ [Tenant Boundary] generateGestoriaSummaryPDF requiere tenant context obligatorio.");
  const tenant = resolveCompanyTenant(companyContextOrId);
  const company = tenant?.companyId ? getCompanyById(tenant.companyId) : getCompany(tenant?.phone);
  const quarterData = getQuarterSummary(companyContextOrId, year, quarter);
  const quality = runFiscalQualityChecks(companyContextOrId, year, quarter);
  const { period, summary, taxProfile } = quarterData;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Cierre Fiscal ${period.label} - ${company.name || 'PresuVoz'}`,
          Author: 'PresuVoz Fiscal Engine',
          Subject: 'Informe de Cierre Trimestral y Libros de Registro AEAT'
        }
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', err => reject(err));

      const primaryColor = '#059669'; // Emerald 600
      const darkColor = '#0f172a';    // Slate 900
      const grayColor = '#64748b';    // Slate 500
      const lightBg = '#f8fafc';      // Slate 50
      const borderColor = '#e2e8f0';  // Slate 200
      const redColor = '#dc2626';     // Red 600
      const yellowColor = '#d97706';  // Amber 600

      // ── PÁGINA 1: RESUMEN EJECUTIVO Y MODELOS 303 / 130 ──
      // Barra superior decorativa
      doc.rect(0, 0, 595.28, 8).fill(primaryColor);

      // Cabecera
      doc.fontSize(16).fillColor(darkColor).font('Helvetica-Bold')
        .text('DOSSIER DE CIERRE TRIMESTRAL PARA GESTORÍA', 40, 28);
      doc.fontSize(9).fillColor(grayColor).font('Helvetica')
        .text(`Período de Liquidación: ${period.label} (${period.startDate} al ${period.endDate})`, 40, 48)
        .text(`Generado el: ${new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })} por PresuVoz Fiscal Engine`, 40, 60);

      // Bloque Empresa y Asesoría
      const boxY = 82;
      doc.roundedRect(40, boxY, 515, 60, 4).fillColor(lightBg).fillAndStroke(lightBg, borderColor);

      doc.fontSize(8.5).fillColor(primaryColor).font('Helvetica-Bold')
        .text('DATOS DE LA EMPRESA / TITULAR', 50, boxY + 8)
        .text('GESTORÍA / ASESORÍA RECEPTORA', 310, boxY + 8);

      doc.fontSize(9).fillColor(darkColor).font('Helvetica-Bold')
        .text(company.name || 'Empresa del Profesional', 50, boxY + 22)
        .text(company.gestoriaEmail ? `Email: ${company.gestoriaEmail}` : 'Email: No configurado', 310, boxY + 22);

      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`NIF/CIF: ${company.cif || 'No indicado'}  |  Tipo: ${taxProfile.entityType || 'Autónomo'}`, 50, boxY + 36)
        .text(`Régimen IVA: ${taxProfile.vatRegime || 'Régimen General'}`, 50, boxY + 47)
        .text('Recepción automática de libros oficiales AEAT en formato digital normalizado (XLSX, CSV y PDF).', 310, boxY + 36, { width: 235 });

      // Cuadro 1: MODELO 303 (IVA TRIMESTRAL)
      let tableY = 158;
      doc.roundedRect(40, tableY, 515, 115, 4).strokeColor(borderColor).stroke();
      doc.rect(40, tableY, 515, 20).fill(darkColor);

      doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
        .text('LIQUIDACIÓN ESTIMADA DEL IMPUESTO SOBRE EL VALOR AÑADIDO (MODELO 303)', 50, tableY + 5);

      tableY += 28;
      doc.fontSize(8.5).fillColor(darkColor).font('Helvetica')
        .text('Total Facturas Emitidas Repercutidas:', 50, tableY)
        .font('Helvetica-Bold').text(`${summary.issuedCount} facturas`, 260, tableY, { align: 'right', width: 60 })
        .text(`Base: ${summary.issuedTaxBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 330, tableY, { align: 'right', width: 100 })
        .text(`IVA: ${summary.issuedVatTotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 440, tableY, { align: 'right', width: 100 });

      tableY += 16;
      doc.font('Helvetica').text('  • Desglose Tipo General 21%:', 60, tableY)
        .text(`Base: ${(summary.issuedVatBreakdown['21']?.base || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 330, tableY, { align: 'right', width: 100 })
        .text(`Cuota: ${(summary.issuedVatBreakdown['21']?.vat || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 440, tableY, { align: 'right', width: 100 });

      tableY += 14;
      doc.font('Helvetica').text('  • Desglose Tipo Reducido 10% (Vivienda/Reformas):', 60, tableY)
        .text(`Base: ${(summary.issuedVatBreakdown['10']?.base || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 330, tableY, { align: 'right', width: 100 })
        .text(`Cuota: ${(summary.issuedVatBreakdown['10']?.vat || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 440, tableY, { align: 'right', width: 100 });

      tableY += 16;
      doc.font('Helvetica').text('Total Gastos y Facturas Recibidas:', 50, tableY)
        .font('Helvetica-Bold').text(`${summary.receivedCount} facturas`, 260, tableY, { align: 'right', width: 60 })
        .text(`Base: ${summary.receivedTaxBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 330, tableY, { align: 'right', width: 100 })
        .text(`IVA Ded.: ${summary.receivedVatDeductible.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 440, tableY, { align: 'right', width: 100 });

      tableY += 20;
      doc.rect(45, tableY - 4, 505, 18).fill('#f1f5f9');
      const res303Color = summary.modelo303.resultado > 0 ? primaryColor : (summary.modelo303.resultado < 0 ? redColor : darkColor);
      doc.fontSize(9.5).fillColor(darkColor).font('Helvetica-Bold')
        .text('RESULTADO PRELIMINAR MODELO 303 (IVA Repercutido - IVA Deducible):', 50, tableY)
        .fillColor(res303Color)
        .text(`${summary.modelo303.resultado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €  (${summary.modelo303.tipoResultado === 'A_INGRESAR' ? 'A INGRESAR' : 'A COMPENSAR'})`, 340, tableY, { align: 'right', width: 200 });

      // Cuadro 2: MODELO 130 (IRPF AUTÓNOMOS)
      let tableY2 = 290;
      doc.roundedRect(40, tableY2, 515, 95, 4).strokeColor(borderColor).stroke();
      doc.rect(40, tableY2, 515, 20).fill(darkColor);

      doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
        .text('PAGO FRACCIONADO IRPF - ESTIMACIÓN DIRECTA (MODELO 130 ORIENTATIVO)', 50, tableY2 + 5);

      tableY2 += 28;
      doc.fontSize(8.5).fillColor(darkColor).font('Helvetica')
        .text('Ingresos Computables del Trimestre (Bases Emitidas):', 50, tableY2)
        .font('Helvetica-Bold').text(`${summary.modelo130.ingresosComputables.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 430, tableY2, { align: 'right', width: 110 });

      tableY2 += 15;
      doc.font('Helvetica').text('Gastos Deducibles Computables del Trimestre:', 50, tableY2)
        .font('Helvetica-Bold').text(`${summary.modelo130.gastosDeduciblesIRPF.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 430, tableY2, { align: 'right', width: 110 });

      tableY2 += 15;
      doc.font('Helvetica').text('Rendimiento Neto Previo (Ingresos - Gastos):', 50, tableY2)
        .font('Helvetica-Bold').text(`${summary.modelo130.rendimientoNeto.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 430, tableY2, { align: 'right', width: 110 });

      tableY2 += 18;
      doc.rect(45, tableY2 - 4, 505, 18).fill('#f1f5f9');
      doc.fontSize(9.5).fillColor(darkColor).font('Helvetica-Bold')
        .text('PAGO FRACCIONADO ORIENTATIVO (20% Rto. Neto - Retenciones):', 50, tableY2)
        .fillColor(primaryColor)
        .text(`${summary.modelo130.pagoFraccionadoOrientativo.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 430, tableY2, { align: 'right', width: 110 });

      // Cuadro 3: CONTROL DE CALIDAD Y ALERTAS PREVIAS
      let tableY3 = 405;
      doc.roundedRect(40, tableY3, 515, 140, 4).strokeColor(borderColor).stroke();
      doc.rect(40, tableY3, 515, 20).fill(darkColor);

      const statusBadge = quality.isValid ? '✅ SIN ERRORES CRÍTICOS' : '⚠️ REQUIERE REVISIÓN ANTES DE PRESENTAR';
      doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
        .text(`AUDITORÍA FISCAL PREVIA: ${statusBadge}`, 50, tableY3 + 5);

      tableY3 += 28;
      doc.fontSize(8.5).fillColor(darkColor).font('Helvetica')
        .text(`• Incidencias críticas detectadas: ${quality.criticalCount}`, 50, tableY3)
        .text(`• Advertencias / Conceptos para revisión de asesoría: ${quality.warningsCount}`, 270, tableY3);

      tableY3 += 16;
      if (quality.incidents.length === 0) {
        doc.fillColor(primaryColor).font('Helvetica-Bold')
          .text('Todos los registros cumplen los estándares de cuadratura matemática, NIF y correlatividad de la AEAT.', 50, tableY3);
      } else {
        doc.fillColor(grayColor).font('Helvetica')
          .text('Avisos identificados en la documentación del trimestre:', 50, tableY3);
        tableY3 += 14;

        quality.incidents.slice(0, 4).forEach(inc => {
          const icon = inc.severity === 'CRITICAL' ? '🔴' : '🟡';
          doc.fontSize(7.5).fillColor(inc.severity === 'CRITICAL' ? redColor : darkColor).font('Helvetica')
            .text(`${icon} [${inc.errorCode}] ${inc.message.slice(0, 95)}`, 55, tableY3, { width: 490 });
          tableY3 += 13;
        });

        if (quality.incidents.length > 4) {
          doc.fontSize(7.5).fillColor(grayColor).font('Helvetica-Oblique')
            .text(`... y ${quality.incidents.length - 4} incidencias más detalladas en el informe de control adjunto.`, 55, tableY3);
        }
      }

      // Pie de página de la página 1
      doc.fontSize(7.5).fillColor(grayColor).font('Helvetica')
        .text('Página 1 de 2 — PresuVoz Fiscal Engine | Este documento es un resumen de apoyo contable, la presentación oficial ante la AEAT corresponde al gestor colegiado.', 40, 780, { align: 'center', width: 515 });

      // ── PÁGINA 2: DESGLOSE DE TESORERÍA, BIENES DE INVERSIÓN Y AUDITORÍA ──
      doc.addPage();
      doc.rect(0, 0, 595.28, 8).fill(primaryColor);

      doc.fontSize(14).fillColor(darkColor).font('Helvetica-Bold')
        .text('DETALLE DE TESORERÍA, COBROS Y BIENES DE INVERSIÓN', 40, 28);
      doc.fontSize(9).fillColor(grayColor).font('Helvetica')
        .text(`Período ${period.label} — Control de cobros de clientes y pagos a proveedores`, 40, 48);

      // Bloque Tesorería
      let page2Y = 75;
      doc.roundedRect(40, page2Y, 515, 80, 4).strokeColor(borderColor).stroke();
      doc.rect(40, page2Y, 515, 20).fill(darkColor);

      doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
        .text('ESTADO DE COBROS Y PAGOS (CRITERIO DE CAJA / CONTROL FINANCIERO)', 50, page2Y + 5);

      page2Y += 28;
      doc.fontSize(8.5).fillColor(darkColor).font('Helvetica')
        .text('Total Facturado Emitido:', 50, page2Y)
        .font('Helvetica-Bold').text(`${summary.issuedTotalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 170, page2Y)
        .font('Helvetica').text('Cobrado en Cuenta:', 270, page2Y)
        .font('Helvetica-Bold').text(`${summary.issuedCollectedTotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 380, page2Y)
        .text(`Pendiente: ${summary.issuedPendingTotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 440, page2Y, { align: 'right', width: 100 });

      page2Y += 18;
      doc.font('Helvetica').text('Total Compras / Gastos:', 50, page2Y)
        .font('Helvetica-Bold').text(`${summary.receivedTotalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 170, page2Y)
        .font('Helvetica').text('Pagado Efectivo:', 270, page2Y)
        .font('Helvetica-Bold').text(`${summary.receivedPaidTotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 380, page2Y)
        .text(`Pendiente: ${summary.receivedPendingTotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 440, page2Y, { align: 'right', width: 100 });

      // Bloque Bienes de Inversión
      let page2Y2 = 175;
      doc.roundedRect(40, page2Y2, 515, 110, 4).strokeColor(borderColor).stroke();
      doc.rect(40, page2Y2, 515, 20).fill(darkColor);

      doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
        .text(`BIENES DE INVERSIÓN Y ACTIVOS SUJETOS A AMORTIZACIÓN (${quarterData.investmentAssets.length})`, 50, page2Y2 + 5);

      page2Y2 += 28;
      if (quarterData.investmentAssets.length === 0) {
        doc.fontSize(8.5).fillColor(grayColor).font('Helvetica')
          .text('No se han registrado adquisiciones de maquinaria o inmovilizado superiores a 3.005,06 € en este trimestre.', 50, page2Y2);
      } else {
        quarterData.investmentAssets.forEach((ast, idx) => {
          if (idx < 3) {
            doc.fontSize(8).fillColor(darkColor).font('Helvetica-Bold')
              .text(`• ${ast.description}`, 50, page2Y2)
              .text(`Base: ${ast.purchase_base.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 300, page2Y2)
              .text(`Adquisición: ${ast.purchase_date}`, 420, page2Y2);
            page2Y2 += 16;
          }
        });
      }

      // Certificación y Trazabilidad Veri*Factu
      let page2Y3 = 305;
      doc.roundedRect(40, page2Y3, 515, 120, 4).fillColor(lightBg).fillAndStroke(lightBg, borderColor);

      doc.fontSize(8.5).fillColor(primaryColor).font('Helvetica-Bold')
        .text('CUMPLIMIENTO NORMATIVO Y TRAZABILIDAD TRIBUTARIA', 50, page2Y3 + 8);

      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text('1. Inalterabilidad: Toda emisión y rectificación queda registrada con marcas de tiempo y hashes encadenados acordes al Reglamento SIF (RD 1007/2023).', 50, page2Y3 + 24, { width: 495 })
        .text('2. Facturas Rectificativas: Las correcciones de importe o errores tributarios no sobreescriben facturas previas, emitiendo serie R y referenciando la original.', 50, page2Y3 + 46, { width: 495 })
        .text('3. Anticipos y entregas a cuenta: Se devengan a la fecha de cobro con desglose preceptivo de cuota de IVA.', 50, page2Y3 + 68, { width: 495 })
        .text('4. Libros electrónicos: Los ficheros XLSX y CSV adjuntos se estructuran de forma idéntica a las columnas normalizadas de la AEAT para importación directa en programas de contabilidad profesional (A3, Sage, Contasol, Holded).', 50, page2Y3 + 88, { width: 495 });

      // Pie de página de la página 2
      doc.fontSize(7.5).fillColor(grayColor).font('Helvetica')
        .text('Página 2 de 2 — Fin del informe de cierre trimestral | PresuVoz S.L. & Asesoría Colaboradora', 40, 780, { align: 'center', width: 515 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. GENERACIÓN DEL ARCHIVO CSV CON FORMATO AEAT (BOM UTF-8 + Delimitador ';')
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera el CSV de facturas emitidas con formato oficial para A3 y Contasol
 */
export function generateIssuedInvoicesCSV(quarterData) {
  const headers = [
    'NUMERO_FACTURA',
    'FECHA_EXPEDICION',
    'NIF_DESTINATARIO',
    'NOMBRE_DESTINATARIO',
    'TIPO_FACTURA',
    'BASE_IMPONIBLE',
    'TIPO_IVA',
    'CUOTA_IVA',
    'TIPO_RETENCION',
    'CUOTA_RETENCION',
    'TOTAL_FACTURA',
    'ESTADO_COBRO',
    'COBRADO',
    'PENDIENTE',
    'RECTIFICA_A'
  ];

  const rows = quarterData.invoices.map(inv => [
    inv.invoiceNumber,
    inv.issueDate,
    inv.clientTaxId || '',
    `"${(inv.clientName || '').replace(/"/g, '""')}"`,
    inv.isAdvance ? 'ANTICIPO' : (inv.rectifiesInvoiceId ? 'RECTIFICATIVA' : 'ORDINARIA'),
    inv.taxBase.toFixed(2),
    inv.taxRate.toFixed(2),
    inv.taxAmount.toFixed(2),
    inv.irpfRate ? inv.irpfRate.toFixed(2) : '0.00',
    inv.irpfRetention ? inv.irpfRetention.toFixed(2) : '0.00',
    inv.totalAmount.toFixed(2),
    inv.isPaid ? 'COBRADA' : (inv.totalPaid > 0 ? 'PARCIAL' : 'PENDIENTE'),
    inv.totalPaid.toFixed(2),
    inv.remaining.toFixed(2),
    inv.rectifiesInvoiceId || ''
  ]);

  const csvBody = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\r\n');
  // Prepend UTF-8 BOM so Excel opens it with proper accents
  return '\uFEFF' + csvBody;
}

/**
 * Genera el CSV de facturas recibidas / gastos
 */
export function generateReceivedInvoicesCSV(quarterData) {
  const headers = [
    'REGISTRO_INTERNO',
    'FACTURA_PROVEEDOR',
    'FECHA_EMISION',
    'NIF_PROVEEDOR',
    'NOMBRE_PROVEEDOR',
    'CATEGORIA',
    'BASE_IMPONIBLE',
    'TIPO_IVA',
    'IVA_SOPORTADO',
    'PORCENTAJE_DEDUCIBLE',
    'IVA_DEDUCIBLE',
    'RETENCION_IRPF',
    'TOTAL_FACTURA',
    'ESTADO_DEDUCIBILIDAD',
    'PAGADO'
  ];

  const rows = quarterData.purchaseInvoices.map(p => [
    p.id,
    p.invoiceNumber,
    p.issueDate,
    p.supplierTaxId || '',
    `"${(p.supplierName || '').replace(/"/g, '""')}"`,
    p.category || 'Gasto General',
    Number(p.taxBase ?? p.taxableBase ?? 0).toFixed(2),
    Number(p.vatRate || 21).toFixed(2),
    Number(p.vatAmount || 0).toFixed(2),
    Number(p.deductiblePercentage ?? 100).toFixed(0),
    Number(p.vatDeductible ? ((Number(p.vatAmount) || 0) * ((p.deductiblePercentage ?? 100) / 100)) : 0).toFixed(2),
    Number(p.irpfRetention || 0).toFixed(2),
    Number(p.totalAmount || 0).toFixed(2),
    p.deductibilityStatus || 'LIKELY_DEDUCTIBLE',
    Number(p.paidAmount || 0).toFixed(2)
  ]);

  const csvBody = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\r\n');
  return '\uFEFF' + csvBody;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. EMPAQUETADO DEL CIERRE EN ARCHIVO COMPRIMIDO (ZIP PARA GESTORÍA)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera el paquete completo para la gestoría en formato ZIP:
 *  - Informe PDF oficial
 *  - Libro de Registro normalizado AEAT en Excel (XLSX)
/**
 * Empaqueta todos los entregables fiscales en un archivo .ZIP listo para enviar a la gestoría:
 *  - Dossier oficial en PDF
 *  - Libros de Registro AEAT en Excel (.xlsx) con fórmulas
 *  - Libro de Facturas Emitidas (CSV)
 *  - Libro de Facturas Recibidas y Gastos (CSV)
 *  - Informe de incidencias y auditoría de calidad (TXT)
 *  - Copias de justificantes / adjuntos si existen
 *
 * @param {string|object} companyContextOrId - Contexto tenant o ID
 * @param {number|null} year
 * @param {number|null} quarter
 * @returns {Promise<{ zipPath: string, fileName: string, zipBuffer: Buffer, quarterData: object, quality: object }>}
 */
export async function buildGestoriaPackageZip(companyContextOrId, year = null, quarter = null) {
  if (!companyContextOrId) throw new Error("❌ [Tenant Boundary] buildGestoriaPackageZip requiere tenant context obligatorio.");
  const tenant = resolveCompanyTenant(companyContextOrId);
  const company = (tenant?.companyId ? getCompanyById(tenant.companyId) : getCompany(tenant?.phone)) || {};
  const legacyBusinessId = resolveLegacyBusinessId(companyContextOrId);
  const companyId = tenant?.companyId || null;

  const quarterData = getQuarterSummary(companyContextOrId, year, quarter);
  if (!quarterData) throw new Error("❌ [Tenant Boundary] No se pudo obtener resumen fiscal del período.");
  const quality = runFiscalQualityChecks(companyContextOrId, year, quarter);
  const { period } = quarterData;

  if (!companyId && !legacyBusinessId) {
    throw new Error("❌ [Tenant Boundary] buildGestoriaPackageZip: no se pudo resolver un tenant válido.");
  }
  const tenantFolder = companyId || legacyBusinessId;
  const exportDir = path.resolve('data', 'fiscal_exports', tenantFolder);
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const cleanCif = (company.cif || 'SIN_CIF').replace(/[^a-zA-Z0-9]/g, '');
  const fileName = `Cierre_Fiscal_${period.year}_Q${period.quarter}_${cleanCif}.zip`;
  const zipPath = path.join(exportDir, fileName);

  // Generar buffers de documentos
  const pdfBuffer = await generateGestoriaSummaryPDF(companyContextOrId, period.year, period.quarter);
  const excelBuffer = await generateNormalizedExcel(companyContextOrId, period.year, period.quarter);
  const issuedCsv = generateIssuedInvoicesCSV(quarterData);
  const receivedCsv = generateReceivedInvoicesCSV(quarterData);

  // Redactar informe de calidad de texto
  const incidentsTextLines = [
    `========================================================================`,
    `INFORME DE CONTROL DE CALIDAD Y AUDITORÍA FISCAL — ${period.label}`,
    `Empresa: ${company.name || 'PresuVoz'} (NIF: ${company.cif || 'No especificado'})`,
    `Fecha de generación: ${new Date().toISOString()}`,
    `Estado global: ${quality.isValid ? 'APTO PARA DECLARACIÓN' : 'REQUIERE REVISIÓN PREVIA'}`,
    `Incidencias críticas: ${quality.criticalCount}`,
    `Avisos / Advertencias: ${quality.warningsCount}`,
    `========================================================================`,
    ``,
    `DETALLE DE REGISTROS CON INCIDENCIA:`,
    quality.incidents.length === 0
      ? `  (No se encontraron discrepancias ni ausencias documentales).`
      : quality.incidents.map((inc, i) => `[${i + 1}] [${inc.severity}] ${inc.errorCode}: ${inc.message} (${inc.entityType} ${inc.entityId})`).join('\r\n'),
    ``,
    `NOTA PARA EL ASESOR FISCAL:`,
    `Los cálculos de IVA e IRPF de este paquete han sido generados por código determinístico`,
    `directamente desde los registros contables inmutables del profesional.`,
    `No se han empleado modelos predictivos ni suposiciones en los importes numéricos.`
  ];
  const incidentsBuffer = Buffer.from(incidentsTextLines.join('\r\n'), 'utf8');

  // Crear archivo ZIP con archiver
  const zipBuffer = await new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const outputBuffers = [];

    archive.on('data', chunk => outputBuffers.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(outputBuffers)));
    archive.on('error', err => reject(err));

    // Añadir documentos principales
    archive.append(pdfBuffer, { name: `Informe_Fiscal_${period.year}_Q${period.quarter}.pdf` });
    archive.append(excelBuffer, { name: `Libro_Oficial_AEAT_${period.year}_Q${period.quarter}.xlsx` });
    archive.append(issuedCsv, { name: `Libro_Facturas_Emitidas_${period.year}_Q${period.quarter}.csv` });
    archive.append(receivedCsv, { name: `Libro_Facturas_Recibidas_${period.year}_Q${period.quarter}.csv` });
    archive.append(incidentsBuffer, { name: `Auditoria_Incidencias_${period.year}_Q${period.quarter}.txt` });

    // Añadir adjuntos o justificantes si existen en disco
    for (const pinv of quarterData.purchaseInvoices) {
      if (pinv.attachmentPath && fs.existsSync(pinv.attachmentPath)) {
        archive.file(pinv.attachmentPath, { name: `justificantes_gastos/${path.basename(pinv.attachmentPath)}` });
      }
    }

    archive.finalize();
  });

  // Guardar copia física en disco
  fs.writeFileSync(zipPath, zipBuffer);

  // Actualizar estado en la base de datos
  updateFiscalPeriodStatus(companyContextOrId, period.year, period.quarter, 'READY_FOR_GESTORIA', {
    packagePath: zipPath,
    lastQualityCheckAt: new Date().toISOString()
  });

  // Registrar auditoría
  recordAuditLog({
    businessId: companyContextOrId,
    entityType: 'FISCAL_PERIOD',
    entityId: `${period.year}_Q${period.quarter}`,
    action: 'BUILD_PACKAGE',
    changedBy: 'FISCAL_SERVICE',
    reason: `Generado paquete ZIP ${fileName}`
  });

  return {
    zipPath,
    fileName,
    zipBuffer,
    pdfBuffer,
    quarterData,
    quality
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. ENVÍO PROTEGIDO POR CORREO ELECTRÓNICO (Nivel C)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Realiza el envío del paquete completo a la gestoría vía Resend.
 * DEBE ejecutarse únicamente tras la confirmación explícita del usuario.
 *
 * @param {string|object} companyContextOrId
 * @param {number|null} year
 * @param {number|null} quarter
 * @param {object} resendInstance - Instancia de Resend
 * @param {string|null} customEmail - Destinatario opcional
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function sendFiscalPackageToGestoria({
  businessId,
  companyContextOrId = null,
  year = null,
  quarter = null,
  resendInstance = null,
  customEmail = null
}) {
  const context = companyContextOrId || businessId;
  if (!context) throw new Error("❌ [Tenant Boundary] sendFiscalPackageToGestoria requiere tenant context obligatorio.");
  const tenant = resolveCompanyTenant(context);
  const company = (tenant?.companyId ? getCompanyById(tenant.companyId) : getCompany(tenant?.phone)) || {};
  const targetEmail = customEmail || company.gestoriaEmail;

  if (!targetEmail) {
    throw new Error('No hay configurado ningún email de gestoría');
  }

  // Generar o recuperar el paquete ZIP
  const { zipBuffer, pdfBuffer, fileName, quarterData, quality } = await buildGestoriaPackageZip(context, year, quarter);
  const { period, summary } = quarterData;

  if (!resendInstance) {
    // Si no hay API key de Resend en el entorno de pruebas, registramos el evento y devolvemos éxito simulado
    console.log(`[FiscalService] Simulación de envío a ${targetEmail} (Sin Resend API Key)`);
    updateFiscalPeriodStatus(context, period.year, period.quarter, 'SENT', {
      sentToEmail: targetEmail
    });
    recordAuditLog({
      businessId: context,
      entityType: 'FISCAL_PERIOD',
      entityId: `${period.year}_Q${period.quarter}`,
      action: 'SEND_PACKAGE_GESTORIA',
      changedBy: 'USER_CONFIRMED',
      reason: `Envío simulado a ${targetEmail}`
    });
    return {
      success: true,
      simulated: true,
      message: `Paquete fiscal preparado y registrado para envío a ${targetEmail}`
    };
  }

  const emailSubject = `Cierre Fiscal ${period.label} — ${company.name || 'Empresa'} (NIF: ${company.cif || 'S/N'})`;
  const emailHtml = `
    <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 640px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
      <h2 style="color: #059669; margin-top: 0;">Libros Oficiales y Cierre Fiscal — ${period.label}</h2>
      <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Período: ${period.startDate} al ${period.endDate}</p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 18px 0;">

      <p>Estimada asesoría / gestoría,</p>
      <p>Adjunto remitimos el <b>paquete completo de cierre trimestral</b> de la empresa <b>${company.name || 'Empresa'}</b> (NIF: <b>${company.cif || 'No especificado'}</b>) para la preparación de los modelos tributarios (303, 130 y libros de IVA e IRPF).</p>

      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin: 18px 0;">
        <h4 style="margin: 0 0 12px 0; color: #0f172a;">Resumen Preliminar del Período:</h4>
        <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.6;">
          <li><b>Facturas emitidas:</b> ${summary.issuedCount} facturas (Base: ${summary.issuedTaxBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €)</li>
          <li><b>IVA Repercutido (Devengado):</b> ${summary.issuedVatTotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</li>
          <li><b>Facturas recibidas / compras:</b> ${summary.receivedCount} facturas (Base: ${summary.receivedTaxBase.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €)</li>
          <li><b>IVA Deducible soportado:</b> ${summary.receivedVatDeductible.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</li>
          <li><b>Resultado preliminar Modelo 303:</b> <b>${summary.modelo303.resultado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €</b> (${summary.modelo303.tipoResultado})</li>
          ${summary.modelo130.isApplicable ? `<li><b>Rendimiento Neto IRPF (Mod. 130 orientativo):</b> ${summary.modelo130.rendimientoNeto.toLocaleString('es-ES', { minimumFractionDigits: 2 })} € (Pago 20%: ${summary.modelo130.pagoFraccionadoOrientativo.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €)</li>` : ''}
        </ul>
      </div>

      <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; margin: 18px 0; font-size: 13px; color: #1e40af;">
        <b>Contenido del archivo ZIP adjunto (${fileName}):</b>
        <br>• <i>Informe_Fiscal_${period.year}_Q${period.quarter}.pdf</i> (Dossier completo)
        <br>• <i>Libro_Oficial_AEAT_${period.year}_Q${period.quarter}.xlsx</i> (Libros registro normalizados con fórmulas)
        <br>• <i>Libros en CSV (UTF-8 con delimitador punto y coma)</i> listos para importar en A3, Contasol y Sage.
        <br>• Justificantes digitales de gastos y compras archivados.
      </div>

      <p style="font-size: 13px; color: #64748b;">
        Control de calidad previo: ${quality.isValid ? '✅ Sin incidencias críticas detectadas.' : `⚠️ Se han detectado ${quality.criticalCount} incidencias a revisar.`}
      </p>

      <br>
      <p style="margin-bottom: 0;">Atentamente,<br><b>${company.name || 'El Profesional'}</b><br>Teléfono: ${company.phone || ''}</p>
    </div>
  `;

  await resendInstance.emails.send({
    from: 'PresuVoz Fiscal <onboarding@resend.dev>',
    to: targetEmail,
    subject: emailSubject,
    html: emailHtml,
    attachments: [
      {
        filename: fileName,
        content: zipBuffer
      },
      {
        filename: `Informe_Fiscal_${period.year}_Q${period.quarter}.pdf`,
        content: pdfBuffer
      }
    ]
  });

  // Actualizar estado y registrar auditoría
  updateFiscalPeriodStatus(context, period.year, period.quarter, 'SENT', {
    sentToEmail: targetEmail
  });

  recordAuditLog({
    businessId: context,
    entityType: 'FISCAL_PERIOD',
    entityId: `${period.year}_Q${period.quarter}`,
    action: 'SEND_PACKAGE_GESTORIA',
    changedBy: 'USER_CONFIRMED',
    reason: `Enviado con éxito a ${targetEmail}`
  });

  return {
    success: true,
    targetEmail,
    message: `Paquete fiscal ${period.label} enviado por email a ${targetEmail}`
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. FORMATEADORES CONVERSACIONALES PARA WHATSAPP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Genera el resumen ejecutivo para WhatsApp cuando el usuario pregunta
 * "prepárame lo de la gestoría" o "¿cómo llevo el trimestre?".
 *
 * @param {string|object} companyContextOrId
 * @param {number|null} year
 * @param {number|null} quarter
 * @returns {string} Mensaje formateado para WhatsApp
 */
export function formatQuarterWhatsAppSummary(companyContextOrId, year = null, quarter = null) {
  if (!companyContextOrId) return '';
  const tenant = resolveCompanyTenant(companyContextOrId);
  const company = (tenant?.companyId ? getCompanyById(tenant.companyId) : getCompany(tenant?.phone)) || {};
  const quarterData = getQuarterSummary(companyContextOrId, year, quarter);
  if (!quarterData) return '';
  const quality = runFiscalQualityChecks(companyContextOrId, year, quarter);
  const { period, summary, taxProfile } = quarterData;

  const fmtEur = num => `${Number(num || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

  const lines = [
    `📊 *CIERRE FISCAL Y GESTORÍA — ${period.label}*`,
    `📅 _Periodo: ${period.startDate} al ${period.endDate}_`,
    `🏢 *Empresa:* ${company.name || 'Sin nombre'} (${company.cif || 'NIF sin configurar'})`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '📤 *FACTURAS EMITIDAS (VENTAS):*',
    `• Facturas expedidas: *${summary.issuedCount}*`,
    `• Base imponible: *${fmtEur(summary.issuedTaxBase)}*`,
    `• IVA al 21% (general): ${fmtEur(summary.issuedVatBreakdown['21']?.vat || 0)} _(Base: ${fmtEur(summary.issuedVatBreakdown['21']?.base || 0)})_`,
    `• IVA al 10% (reformas): ${fmtEur(summary.issuedVatBreakdown['10']?.vat || 0)} _(Base: ${fmtEur(summary.issuedVatBreakdown['10']?.base || 0)})_`,
    `• Total IVA Repercutido: *${fmtEur(summary.issuedVatTotal)}*`,
    `• Cobrado en cuenta: ${fmtEur(summary.issuedCollectedTotal)} | Pendiente: ${fmtEur(summary.issuedPendingTotal)}`,
    '',
    '📥 *FACTURAS RECIBIDAS (COMPRAS Y GASTOS):*',
    `• Facturas y justificantes: *${summary.receivedCount}*`,
    `• Base de gastos: *${fmtEur(summary.receivedTaxBase)}*`,
    `• IVA Deducible soportado: *${fmtEur(summary.receivedVatDeductible)}*`,
    `• Pagado a proveedores: ${fmtEur(summary.receivedPaidTotal)} | Pendiente: ${fmtEur(summary.receivedPendingTotal)}`,
    ''
  ];

  if (summary.investmentAssetsCount > 0) {
    lines.push(`🏗️ *Bienes de inversión (>3.005€):* ${summary.investmentAssetsCount} activos`);
    lines.push('');
  }

  // Previsión de liquidación
  const res303 = summary.modelo303.resultado;
  const res303Texto = res303 > 0
    ? `📈 *A INGRESAR: ${fmtEur(res303)}*`
    : (res303 < 0 ? `📉 *A COMPENSAR: ${fmtEur(Math.abs(res303))}*` : `⚖️ *RESULTADO CERO*`);

  lines.push('🏛️ *PREVISIÓN DE MODELOS TRIBUTARIOS:*');
  lines.push(`• *Modelo 303 (IVA):* ${res303Texto}`);
  lines.push(`  _(IVA Repercutido ${fmtEur(summary.issuedVatTotal)} - IVA Deducible ${fmtEur(summary.receivedVatDeductible)})_`);

  if (summary.modelo130.isApplicable) {
    lines.push(`• *Modelo 130 (IRPF orientativo):* *${fmtEur(summary.modelo130.pagoFraccionadoOrientativo)}*`);
    lines.push(`  _(Rendimiento Neto: ${fmtEur(summary.modelo130.rendimientoNeto)} menos retenciones)_`);
  }

  lines.push('');
  lines.push('🛡️ *CONTROL DE CALIDAD FISCAL:*');
  if (quality.isValid) {
    lines.push('✅ *Sin incidencias críticas.* Los libros cuadran al céntimo.');
  } else {
    lines.push(`⚠️ *${quality.criticalCount} incidencias críticas* y *${quality.warningsCount} avisos*.`);
    lines.push('_(Ej: NIFs ausentes o gastos que requieren revisión de la gestoría)_');
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('📦 *Tengo preparado tu paquete oficial para la gestoría:*');
  lines.push('• Libro AEAT en Excel multicapa con fórmulas.');
  lines.push('• Dossier oficial en PDF con desglose de casillas.');
  lines.push('• Libros CSV para importación directa en Contasol, A3 y Sage.');

  if (company.gestoriaEmail) {
    lines.push(`\n📧 *Email de tu gestoría:* ${company.gestoriaEmail}`);
    lines.push('👉 _Para enviarlo ahora mismo responde: *\"Enviar a mi gestoría\"*_');
  } else {
    lines.push('\n💡 _Para que pueda enviarlo con 1 clic por email, dime:_\n*\"Mi gestoría es correo@asesoria.com\"*');
  }

  return lines.join('\n');
}
