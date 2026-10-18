/**
 * PresuVoz Core Engine
 * Procesa transcripciones de voz de profesionales y genera presupuestos estructurados
 * con cálculo impositivo conforme a la normativa fiscal española (IVA 10% vs 21%).
 */

import { PresuVozParser } from './parser.js';
import { randomBytes } from 'node:crypto';

export class PresuVozEngine {
  constructor(companyConfig = {}) {
    this.company = {
      name: companyConfig.name || "Carpintería y Reformas Manolo S.L.",
      cif: companyConfig.cif || "B-12345678",
      phone: companyConfig.phone || "600 11 22 33",
      email: companyConfig.email || "presupuestos@carpinteriamanolo.es",
      address: companyConfig.address || "Polígono Industrial Nave 14, Sevilla",
      defaultTaxRate: companyConfig.defaultTaxRate,
      defaultAdvance: companyConfig.defaultAdvance,
      quoteValidityDays: companyConfig.quoteValidityDays,
      paymentTerms: companyConfig.paymentTerms,
      logoText: companyConfig.logoText || "CM",
      brandColor: companyConfig.brandColor || "#9a3412", // Color madera cálido
      professionalSigner: companyConfig.professionalSigner || "Manuel Gómez (Administrador)",
      signatureImage: companyConfig.signatureImage || null // Sello/firma digitalizada
    };
  }

  /**
   * Usa un tipo mencionado explícitamente o el tipo configurado para la empresa.
   * No infiere el IVA reducido por mencionar una estancia o una vivienda.
   * @param {string} text - Transcripción del audio
   * @returns {number} 0.10 (reducido para vivienda habitual) o 0.21 (general)
   */
  detectTaxRate(text, fallbackRate = 0.21) {
    const lower = String(text || '').toLowerCase();
    if (/\b(?:iva\s+)?exent[oa]s?\b|\biva\s+(?:del?\s*|al?\s*)?0\s*%/.test(lower)) return 0;
    const explicit = lower.match(/\biva\s+(?:general\s+)?(?:(?:de|del|al?)\s+)?(4|5|10|21)\s*%/);
    if (explicit) return Number(explicit[1]) / 100;
    return fallbackRate;
  }

  /**
   * Extrae la retención de IRPF dictada por el usuario o toma el configurado para la empresa.
   * @param {string} text - Transcripción del audio o mensaje
   * @param {number} fallbackRate - Tipo de IRPF por defecto (ej: 0 o de la empresa)
   * @returns {number} Porcentaje de retención (ej: 15 para 15%, 7 para 7%, 0 si no aplica)
   */
  detectIrpfRate(text, fallbackRate = 0) {
    const lower = String(text || '').toLowerCase();
    if (/\b(?:sin\s+irpf|sin\s+retenci[oó]n|irpf\s+(?:del?\s*|al?\s*)?0\s*%)\b/.test(lower)) return 0;
    const explicit = lower.match(/\b(?:retenci[oó]n\s+(?:del?\s+)?(?:irpf\s+)?|irpf\s+)(?:(?:de|del|al?)\s+)?(\d{1,2}|siete|quince|diecinueve)\s*%/i);
    if (explicit) {
      const wordMap = { 'siete': 7, 'quince': 15, 'diecinueve': 19 };
      const val = wordMap[explicit[1].toLowerCase()] || parseInt(explicit[1], 10);
      if (Number.isFinite(val) && val >= 0 && val <= 100) return val;
    }
    return fallbackRate;
  }

  /**
   * Extrae condiciones de pago y validez desde el audio o aplica estándares profesionales
   * @param {string} text 
   * @returns {object}
   */
  extractTerms(text, company = {}) {
    const lower = text.toLowerCase();
    let configuredAdvance = company.defaultAdvance ?? company.default_advance;
    if ((configuredAdvance === undefined || configuredAdvance === null) && (company.paymentTerms || company.payment_terms)) {
      const termsStr = String(company.paymentTerms || company.payment_terms);
      const m = termsStr.match(/(\d{1,2})\s*%\s*(?:al\s*empezar|al\s*inicio|de\s*adelanto|de\s*anticipo|por\s*adelantado)/i);
      if (m) configuredAdvance = parseInt(m[1], 10);
    }
    const parsedAdvance = Number(configuredAdvance ?? 30);
    let advancePercentage = Number.isFinite(parsedAdvance) && parsedAdvance >= 0 && parsedAdvance <= 100
      ? parsedAdvance
      : 30;
    const configuredValidity = Number(company.quoteValidityDays ?? company.quote_validity_days ?? 15);
    let validityDays = Number.isInteger(configuredValidity) && configuredValidity > 0 && configuredValidity <= 365
      ? configuredValidity
      : 15;

    // Detectar porcentaje con dígitos ("30%") o con palabras ("cuarenta por ciento")
    const advanceDigitMatch = lower.match(/(\d{1,2})\s*(?:%|por\s*ciento)\s*(?:por\s*adelantado|a\s*la\s*firma|al\s*inicio|de\s*anticipo)/);
    if (advanceDigitMatch) {
      advancePercentage = parseInt(advanceDigitMatch[1], 10);
    } else {
      const advanceWordMatch = lower.match(/(veinte|veinticinco|treinta|cuarenta|cincuenta)\s*por\s*ciento\s*(?:por\s*adelantado|a\s*la\s*firma|al\s*inicio|de\s*anticipo)/);
      if (advanceWordMatch) {
        const map = { "veinte": 20, "veinticinco": 25, "treinta": 30, "cuarenta": 40, "cincuenta": 50 };
        if (map[advanceWordMatch[1]]) advancePercentage = map[advanceWordMatch[1]];
      }
    }

    const validityMatch = lower.match(/(\d{1,2}|diez|quince|veinte|treinta)\s*d[ií]as/);
    if (validityMatch) {
      const map = { "diez": 10, "quince": 15, "veinte": 20, "treinta": 30 };
      validityDays = map[validityMatch[1]] || parseInt(validityMatch[1], 10) || 15;
    }

    return {
      advancePercentage,
      validityDays,
      textConditions: company.paymentTerms || `${advancePercentage}% al aceptar el presupuesto para reserva de fechas y acopio de materiales. ${100 - advancePercentage}% a la finalización de los trabajos.`
    };
  }

  /**
   * Procesa una transcripción cruda o un caso semi-estructurado, sanitiza
   * las partidas y calcula el desglose financiero exacto.
   * @param {object|string} input - Objeto de entrada o string directo de transcripción
   * @returns {object} Resultado con { success, budget, errors }
   */
  process(input) {
    const rawInput = typeof input === "string" ? { rawTranscript: input } : (input || {});
    const rawText = rawInput.rawTranscript || "";
    let clientName = rawInput.clientName;
    let clientAddress = rawInput.clientAddress;
    let itemsToProcess = rawInput.items;

    let warnings = [];
    let assistantFeedback = "✅ ¡Presupuesto generado con éxito y sin incidencias!";

    // Si no se proporcionaron partidas pre-estructuradas, parsear la transcripción cruda
    if (!itemsToProcess || !Array.isArray(itemsToProcess) || itemsToProcess.length === 0) {
      const parseResult = PresuVozParser.parseTranscript(rawText);

      if (!parseResult.isValid) {
        return {
          success: false,
          hasWarnings: true,
          errors: parseResult.warnings,
          warnings: parseResult.warnings,
          assistantFeedback: parseResult.assistantFeedback,
          budget: null
        };
      }

      itemsToProcess = parseResult.data.items;
      warnings = parseResult.warnings || [];
      assistantFeedback = parseResult.assistantFeedback;
      if (!clientName) clientName = parseResult.data.clientName;
      if (!clientAddress) clientAddress = parseResult.data.clientAddress;
    }

    const configuredTaxRate = rawInput.company?.defaultTaxRate ?? this.company.defaultTaxRate ?? 21;
    let taxRate = rawInput.taxRate !== undefined
      ? Number(rawInput.taxRate)
      : this.detectTaxRate(rawText, Number(configuredTaxRate) / 100);
    if (taxRate > 1) taxRate /= 100;
    if (!Number.isFinite(taxRate) || ![0, 0.04, 0.05, 0.1, 0.21].includes(taxRate)) {
      return { success: false, budget: null, errors: ['Tipo de IVA no válido.'], warnings: [], assistantFeedback: 'No he podido calcular el presupuesto porque el tipo de IVA no es válido.' };
    }
    const terms = this.extractTerms(rawText, rawInput.company || this.company);
    if (rawInput.paymentTerms?.advancePercentage !== undefined && rawInput.paymentTerms?.advancePercentage !== null) {
      const advancePercentage = Number(rawInput.paymentTerms.advancePercentage);
      if (!Number.isFinite(advancePercentage) || advancePercentage < 0 || advancePercentage > 100) {
        return { success: false, budget: null, errors: ['Porcentaje de anticipo no válido.'], warnings: [], assistantFeedback: 'Revisa el porcentaje de anticipo indicado.' };
      }
      terms.advancePercentage = advancePercentage;
      terms.textConditions = `${advancePercentage}% al aceptar. ${100 - advancePercentage}% al finalizar.`;
    }
    if (rawInput.paymentTerms?.validityDays !== undefined && rawInput.paymentTerms?.validityDays !== null) {
      const validityDays = Number(rawInput.paymentTerms.validityDays);
      if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 365) {
        return { success: false, budget: null, errors: ['Plazo de validez no válido.'], warnings: [], assistantFeedback: 'Revisa el plazo de validez indicado.' };
      }
      terms.validityDays = validityDays;
    }

    // Calcular y sanitizar estrictamente cada partida
    let subtotal = 0;
    if (!Array.isArray(itemsToProcess) || itemsToProcess.length === 0) {
      return { success: false, budget: null, errors: ['El presupuesto debe incluir al menos una partida.'], warnings: [], assistantFeedback: 'No he encontrado partidas para incluir en el presupuesto.' };
    }
    const invalidItemIndex = itemsToProcess.findIndex(item => {
      if (!item || typeof item !== 'object') return true;
      const qty = Number(item?.qty ?? 1);
      const unitPrice = Number(item?.price !== undefined ? item.price : (item?.unitPrice ?? 0));
      return !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(qty * unitPrice);
    });
    if (invalidItemIndex !== -1) {
      return { success: false, budget: null, errors: [`Datos no válidos en la partida ${invalidItemIndex + 1}.`], warnings: [], assistantFeedback: 'Revisa las cantidades y precios del presupuesto.' };
    }
    const items = itemsToProcess.map((item, index) => {
      const qty = item.qty ?? 1;
      const unitPrice = item.price !== undefined ? item.price : (item.unitPrice ?? 0);
      const numericQty = Number(qty);
      const numericUnitPrice = Number(unitPrice);
      const total = Number((numericQty * numericUnitPrice).toFixed(2));
      subtotal += total;

      // Sanitización contra palabras sueltas o muletillas
      // La transcripción literal usada como degradación segura ya fue revisada
      // contra el alcance del audio: no debe pasar por el diccionario de oficios,
      // que podría reemplazarla por una partida de otro gremio.
      const cleanDesc = item.preserveDescription === true
        ? String(item.description || "").trim().replace(/\s+/g, " ")
        : PresuVozParser.normalizeItemDescription(item.description || "");

      const isPricePending = item.isPricePending !== undefined ? item.isPricePending : (total === 0);

      return {
        id: index + 1,
        description: cleanDesc,
        qty: numericQty,
        unit: item.unit || 'pa',
        unitPrice: numericUnitPrice,
        total,
        isPricePending
      };
    });

    // Detección o asignación de descuento comercial
    const discountInfo = rawInput.discount || PresuVozParser.extractDiscount(rawText);
    let discountPercentage = 0;
    let discountAmount = 0;

    if (discountInfo) {
      if (discountInfo.type === 'percentage') {
        discountPercentage = discountInfo.value;
        if (!Number.isFinite(discountPercentage) || discountPercentage < 0 || discountPercentage > 100) {
          return { success: false, budget: null, errors: ['El porcentaje de descuento debe estar entre 0 y 100.'], warnings: [], assistantFeedback: 'Revisa el porcentaje de descuento indicado.' };
        }
        discountAmount = Number(((subtotal * discountPercentage) / 100).toFixed(2));
      } else if (discountInfo.type === 'fixed') {
        discountAmount = discountInfo.value;
        if (!Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > subtotal) {
          return { success: false, budget: null, errors: ['El descuento no puede superar el subtotal.'], warnings: [], assistantFeedback: 'Revisa el importe del descuento indicado.' };
        }
        discountPercentage = subtotal > 0 ? Number(((discountAmount / subtotal) * 100).toFixed(1)) : 0;
      }
    }

    subtotal = Number(subtotal.toFixed(2));
    const taxableBase = Number((subtotal - discountAmount).toFixed(2));
    const taxAmount = Number((taxableBase * taxRate).toFixed(2));

    // Retención de IRPF: dictada expresamente en audio/texto o configurada en la empresa
    const configuredIrpf = rawInput.company?.irpfRate ?? this.company?.irpfRate ?? 0;
    const irpfRate = rawInput.irpfRate !== undefined
      ? Number(rawInput.irpfRate)
      : this.detectIrpfRate(rawText, Number(configuredIrpf));
    const irpfAmount = irpfRate > 0 ? Number(((taxableBase * irpfRate) / 100).toFixed(2)) : 0;

    const totalAmount = Number((taxableBase + taxAmount - irpfAmount).toFixed(2));
    const advanceAmount = Number(((totalAmount * terms.advancePercentage) / 100).toFixed(2));

    const budgetId = `PRE-${new Date().getFullYear()}-${randomBytes(8).toString('hex').toUpperCase()}`;
    const issueDate = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const isDraft = items.every(it => it.total === 0);

    const budget = {
      id: budgetId,
      issueDate,
      company: rawInput.company || this.company,
      client: {
        name: clientName || "Cliente Particular",
        address: clientAddress || "Ubicación obra según visita",
        phone: rawInput.clientPhone || "No especificado",
        email: rawInput.clientEmail || null
      },
      items,
      financials: {
        subtotal,
        discountPercentage,
        discountAmount,
        taxableBase,
        taxRatePercentage: Math.round(taxRate * 100),
        taxAmount,
        irpfRatePercentage: irpfRate,
        irpfAmount,
        totalAmount,
        advancePercentage: terms.advancePercentage,
        advanceAmount,
        remainingAmount: Number((totalAmount - advanceAmount).toFixed(2))
      },
      terms: {
        validityDays: terms.validityDays,
        conditions: rawInput.customConditions || terms.textConditions
      },
      payments: [],
      paymentSummary: {
        totalPaid: 0,
        remainingBalance: totalAmount,
        status: 'PENDIENTE'
      },
      isDraft,
      status: isDraft ? "BORRADOR_MEDICION" : "PENDIENTE_FIRMA",
      hasWarnings: warnings.length > 0 || isDraft,
      warnings,
      assistantFeedback
    };

    // Objeto compatible con desestructuración directa y chequeo de éxito (sin referencia circular)
    return {
      ...budget,
      success: true,
      isDraft,
      hasWarnings: warnings.length > 0 || isDraft,
      warnings,
      assistantFeedback,
      errors: [],
      budget
    };
  }

  /**
  /**
   * Actualiza interactivamente el presupuesto mediante un mensaje conversacional de WhatsApp:
   * Permite corregir o confirmar direcciones ("Es en Torreblanca", "Sí, es correcta")
   * o asignar precios a partidas pendientes ("Ponle 250 al alicatado").
   * @param {object} budget - Objeto de presupuesto existente
   * @param {string} updateText - Mensaje de actualización
   * @returns {object} { success, budget, assistantMessage }
   */
  updateBudget(budget, updateText) {
    if (!budget || !budget.items) {
      return { success: false, message: "Presupuesto no válido." };
    }

    if (['ACEPTADO', 'FIRMADO', 'PAGADO', 'PAGADA'].includes(String(budget.status || '').toUpperCase()) ||
        Number(budget.paymentSummary?.totalPaid || 0) > 0 ||
        (budget.payments || []).length > 0 || (budget.advanceInvoices || []).length > 0) {
      return { success: false, budget, assistantMessage: 'Este presupuesto ya tiene aceptación o movimientos de pago. No lo modificaré; crea una nueva versión para conservar el historial.' };
    }

    budget = structuredClone(budget);

    const replyRes = PresuVozParser.applyConversationalReply(budget, updateText);
    if (!replyRes.success) {
      return {
        success: false,
        budget,
        assistantMessage: replyRes.message
      };
    }

    // Si fue una actualización o confirmación de dirección
    if (replyRes.type === "ADDRESS_UPDATED" || replyRes.type === "ADDRESS_CONFIRMED") {
      budget.assistantFeedback = replyRes.message;
      return {
        success: true,
        budget,
        assistantMessage: replyRes.message
      };
    }

    // Si fue una actualización de partida / importe, recalcular finanzas
    const taxRate = (budget.financials.taxRatePercentage ?? 21) / 100;
    const advancePct = budget.financials.advancePercentage ?? 30;

    let subtotal = 0;
    budget.items.forEach(item => {
      subtotal += item.total || 0;
    });

    subtotal = Number(subtotal.toFixed(2));

    let discountAmount = 0;
    const discountPct = budget.financials.discountPercentage || 0;
    if (discountPct > 0) {
      discountAmount = Number(((subtotal * discountPct) / 100).toFixed(2));
    } else if (budget.financials.discountAmount > 0) {
      discountAmount = budget.financials.discountAmount;
    }

    if (!Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > subtotal) {
      return { success: false, budget, assistantMessage: 'El importe actualizado dejaría un descuento superior al subtotal. No he guardado el cambio; revisa el descuento.' };
    }

    const taxableBase = Number((subtotal - discountAmount).toFixed(2));
    const taxAmount = Number((taxableBase * taxRate).toFixed(2));
    const totalAmount = Number((taxableBase + taxAmount).toFixed(2));
    const advanceAmount = Number(((totalAmount * advancePct) / 100).toFixed(2));

    budget.financials.subtotal = subtotal;
    budget.financials.discountAmount = discountAmount;
    budget.financials.taxableBase = taxableBase;
    budget.financials.taxAmount = taxAmount;
    budget.financials.totalAmount = totalAmount;
    budget.financials.advanceAmount = advanceAmount;
    budget.financials.remainingAmount = Number((totalAmount - advanceAmount).toFixed(2));
    budget.paymentSummary = {
      ...(budget.paymentSummary || {}),
      totalPaid: 0,
      remainingBalance: totalAmount,
      status: totalAmount === 0 ? 'PAGADO' : 'PENDIENTE'
    };

    const pendingCount = budget.items.filter(it => it.isPricePending).length;
    if (pendingCount === 0 && budget.warnings) {
      budget.warnings = budget.warnings.filter(w => !w.includes("pendiente de valorar"));
    }
    budget.hasWarnings = pendingCount > 0 || (budget.warnings && budget.warnings.length > 0);
    budget.isDraft = budget.items.every(it => it.total === 0);
    budget.status = budget.isDraft ? "BORRADOR_MEDICION" : "PENDIENTE_FIRMA";

    let finalMsg = replyRes.message;
    if (pendingCount === 0) {
      finalMsg += `\n\n🎉 ¡Todas las partidas están ahora completadas y valoradas! Total del presupuesto: ${budget.financials.totalAmount.toFixed(2)} € (IVA ${budget.financials.taxRatePercentage}% incl.). Ya puedes enviar el documento para firmar.`;
    } else {
      finalMsg += `\n\nQuedan ${pendingCount} partida(s) pendiente(s) de valorar. Total acumulado actual: ${budget.financials.totalAmount.toFixed(2)} €.`;
    }

    budget.assistantFeedback = finalMsg;

    return {
      success: true,
      budget,
      assistantMessage: finalMsg
    };
  }

  /**
   * Alias de compatibilidad hacia atrás
   */
  updateBudgetPrice(budget, updateText) {
    return this.updateBudget(budget, updateText);
  }

  /**
   * Genera una Factura Legal de Anticipo con devengo y desglose de IVA (Art. 75.Dos Ley 37/1992)
   * @param {object} budget - Presupuesto origen
   * @param {object} paymentData - { amount, method, concept, date }
   * @param {object} [options] - Opciones adicionales
   * @returns {object} Objeto factura de anticipo
   */
  createAdvanceInvoice(budget, paymentData = {}, options = {}) {
    if (!budget) {
      throw new Error('No se puede generar factura de anticipo sin un presupuesto de referencia.');
    }

    const rawAmount = Number(paymentData.amount);
    if (isNaN(rawAmount) || rawAmount <= 0) {
      throw new Error('El importe del anticipo debe ser un número positivo.');
    }

    const year = new Date().getFullYear();
    const invoiceCounter = options.invoiceNumber || 1;
    const comp = options.company || budget.company || {};
    let invoiceId = options.id;
    if (!invoiceId) {
      if (comp.invoiceSeries) {
        const cleanSeries = comp.invoiceSeries.trim();
        const prefix = cleanSeries.endsWith('-') || cleanSeries.endsWith('/') ? cleanSeries : `${cleanSeries}-`;
        invoiceId = `${prefix}${String(invoiceCounter).padStart(3, '0')}`;
      } else {
        invoiceId = `FAC-${year}-${String(invoiceCounter).padStart(4, '0')}`;
      }
    }
    const today = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });


    const taxRate = (budget.financials?.taxRatePercentage ?? 21) / 100;
    const irpfRate = Number(options.irpfRate !== undefined ? options.irpfRate : (budget.financials?.irpfRatePercentage !== undefined ? budget.financials.irpfRatePercentage : (comp.irpfRate || 0)));

    const isTaxBase = Boolean(paymentData.isTaxBase ?? options.isTaxBase);
    let taxableBase, taxAmount, irpfAmount, totalAmount;

    if (isTaxBase) {
      taxableBase = Number(rawAmount.toFixed(2));
      taxAmount = Number((taxableBase * taxRate).toFixed(2));
      irpfAmount = irpfRate > 0 ? Number((taxableBase * (irpfRate / 100)).toFixed(2)) : 0;
      totalAmount = Number((taxableBase + taxAmount - irpfAmount).toFixed(2));
    } else {
      taxableBase = Number((rawAmount / (1 + taxRate - (irpfRate / 100))).toFixed(2));
      taxAmount = Number((taxableBase * taxRate).toFixed(2));
      irpfAmount = irpfRate > 0 ? Number((taxableBase * (irpfRate / 100)).toFixed(2)) : 0;
      totalAmount = Number((taxableBase + taxAmount - irpfAmount).toFixed(2));
    }

    const invoiceType = (options.type || paymentData.type || 'ANTICIPO').toUpperCase();
    const isHito = invoiceType === 'HITO';

    const priorInvoices = options.priorInvoices || budget.advanceInvoices || [];
    const priorOfType = priorInvoices.filter(inv => (inv.type || 'ANTICIPO').toUpperCase() === invoiceType);
    const seq = options.seq || (isHito ? priorOfType.length + 1 : 1);

    const addressPart = budget.client?.address ? ` en ${budget.client.address}` : '';
    const itemDesc = options.concept || paymentData.concept || (isHito
      ? `Certificación / Hito de obra: Entrega a cuenta por avance de trabajos en ${budget.id || ''}${addressPart}`
      : `Entrega a cuenta / Anticipo por aceptación de presupuesto ${budget.id || ''}${addressPart}`);

    const invoiceNaming = formatInvoiceNaming(invoiceType, budget.id || 'PRE-2026', seq);

    const legalNote = isHito
      ? 'Factura de certificación / hito de obra emitida conforme al Art. 75.Dos de la Ley 37/1992 del IVA y RD 1619/2012.'
      : 'Factura de anticipo emitida conforme al Art. 75.Dos de la Ley 37/1992 del IVA y RD 1619/2012.';

    const advanceInvoice = {
      id: invoiceId,
      displayNumber: invoiceNaming,
      naming: invoiceNaming,
      type: invoiceType,
      budgetId: budget.id || 'PRE-2026',
      issueDate: today,
      operationDate: paymentData.date || today,
      company: {
        ...this.company,
        ...(budget.company || {}),
        ...(options.company || {})
      },
      client: {
        name: options.clientName || budget.client?.name || 'Cliente Particular',
        address: options.clientAddress || budget.client?.address || 'Ubicación según visita',
        nif: options.clientNif || budget.client?.nif || 'Consignado en contrato',
        phone: options.clientPhone || budget.client?.phone || null,
        email: options.clientEmail || budget.client?.email || null
      },
      items: [
        {
          id: 'item-ant-1',
          description: itemDesc,
          qty: 1,
          unit: 'pa',
          unitPrice: taxableBase,
          total: taxableBase
        }
      ],
      financials: {
        subtotal: taxableBase,
        discountPercentage: 0,
        discountAmount: 0,
        taxableBase,
        taxRatePercentage: budget.financials?.taxRatePercentage ?? 21,
        taxAmount,
        irpfRatePercentage: irpfRate,
        irpfAmount,
        totalAmount,
        advanceAmount: 0,
        remainingAmount: 0
      },
      status: 'PAGADA',
      paymentMethod: paymentData.method || 'Transferencia bancaria / Bizum',
      legalNote
    };

    if (!budget.advanceInvoices) budget.advanceInvoices = [];
    budget.advanceInvoices.push(advanceInvoice);

    return advanceInvoice;
  }

  /**
   * Genera una Factura Rectificativa legal conforme al Art. 15 del Real Decreto 1619/2012
   * y Art. 80 de la Ley 37/1992 del IVA.
   *
   * @param {object} originalInvoice - Factura original emitida a rectificar
   * @param {object} [options] - Opciones de rectificación:
   *   - reason: Causa o motivo legal de la rectificación (obligatorio por RD 1619/2012)
   *   - amount: Importe a rectificar (si se omite, anulación/abono total)
   *   - isTaxBase: Si el importe especificado corresponde a la base imponible
   *   - isFullRefund: Forzar anulación total
   *   - items: Partidas rectificadas específicas
   *   - seq: Secuencial de la factura rectificativa
   *   - id: ID personalizado
   * @returns {object} Factura rectificativa formal
   */
  createRectificationInvoice(originalInvoice, options = {}) {
    if (!originalInvoice) {
      throw new Error('No se puede generar factura rectificativa sin una factura original de referencia.');
    }

    const year = new Date().getFullYear();
    const origFin = originalInvoice.financials || {};
    const origTotal = Number(origFin.totalAmount ?? originalInvoice.total_amount ?? originalInvoice.totalAmount ?? 0);
    const origBase = Number(origFin.taxableBase ?? originalInvoice.taxBase ?? 0);
    const origTax = Number(origFin.taxAmount ?? originalInvoice.taxAmount ?? 0);
    const origTaxRate = Number(origFin.taxRatePercentage ?? originalInvoice.taxRate ?? (originalInvoice.tax_rate ?? 21));
    const origIrpfRate = Number(origFin.irpfRatePercentage ?? originalInvoice.irpfRate ?? 0);
    const taxRate = origTaxRate / 100;
    const irpfRate = origIrpfRate / 100;

    const today = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const seq = options.seq || 1;
    const budgetId = originalInvoice.budgetId || originalInvoice.budget_id || 'PRE-2026';
    const invoiceNaming = formatInvoiceNaming('RECTIFICATIVA', budgetId, seq);

    const isPartial = options.amount !== undefined && options.amount !== null && !options.isFullRefund;
    const rawReason = options.reason || 'Corrección de importes y conceptos conforme al Art. 15 del RD 1619/2012';

    let taxableBase, taxAmount, irpfAmount, totalAmount;

    if (!isPartial) {
      // Rectificación / Abono total de la factura original (valores negativos que anulan fiscalmente la factura previa)
      taxableBase = -Math.abs(Number(origBase.toFixed(2)));
      taxAmount = -Math.abs(Number(origTax.toFixed(2)));
      irpfAmount = origFin.irpfAmount ? -Math.abs(Number(Number(origFin.irpfAmount).toFixed(2))) : 0;
      totalAmount = -Math.abs(Number(origTotal.toFixed(2)));
    } else {
      // Rectificación parcial por importe específico
      const inputAmount = Number(options.amount);
      const isTaxBase = Boolean(options.isTaxBase);
      if (isTaxBase) {
        taxableBase = -Math.abs(Number(inputAmount.toFixed(2)));
        taxAmount = Number((taxableBase * taxRate).toFixed(2));
        irpfAmount = irpfRate > 0 ? Number((taxableBase * irpfRate).toFixed(2)) : 0;
        totalAmount = Number((taxableBase + taxAmount - irpfAmount).toFixed(2));
      } else {
        const grossAmount = Math.abs(inputAmount);
        const baseCalc = grossAmount / (1 + taxRate - irpfRate);
        taxableBase = -Number(baseCalc.toFixed(2));
        taxAmount = Number((taxableBase * taxRate).toFixed(2));
        irpfAmount = irpfRate > 0 ? Number((taxableBase * irpfRate).toFixed(2)) : 0;
        totalAmount = -Number(grossAmount.toFixed(2));
      }
    }

    const origDisplayNum = originalInvoice.displayNumber || originalInvoice.naming || originalInvoice.invoiceNumber || originalInvoice.visibleNumber || originalInvoice.id;
    const origDate = originalInvoice.issueDate || originalInvoice.createdAt || today;

    const items = options.items || [
      {
        id: 'item-rect-1',
        description: `Rectificación de Factura nº ${origDisplayNum} de fecha ${origDate} (Motivo: ${rawReason})`,
        qty: 1,
        unit: 'pa',
        unitPrice: taxableBase,
        total: taxableBase
      }
    ];

    const legalNote = `Factura rectificativa emitida conforme al artículo 15 del Real Decreto 1619/2012 y artículo 80 de la Ley 37/1992 del IVA. Rectifica a la factura original nº ${origDisplayNum} de fecha ${origDate}. Causa: ${rawReason}.`;

    const invoiceId = options.id || `INV-REC-${originalInvoice.id}-${String(seq).padStart(3, '0')}`;

    return {
      id: invoiceId,
      displayNumber: invoiceNaming,
      naming: invoiceNaming,
      type: 'RECTIFICATIVA',
      invoiceType: 'RECTIFICATIVA',
      series: 'R',
      budgetId,
      rectifiesInvoiceId: originalInvoice.id,
      rectifies_invoice_id: originalInvoice.id,
      rectifiedInvoiceNumber: origDisplayNum,
      rectifiedInvoiceDate: origDate,
      rectificationReason: rawReason,
      isRectification: true,
      issueDate: today,
      operationDate: today,
      company: {
        ...this.company,
        ...(originalInvoice.company || {}),
        ...(options.company || {})
      },
      client: {
        ...(originalInvoice.client || {}),
        ...(options.client || {})
      },
      items,
      financials: {
        subtotal: taxableBase,
        discountPercentage: 0,
        discountAmount: 0,
        taxableBase,
        taxRatePercentage: origTaxRate,
        taxAmount,
        irpfRatePercentage: origIrpfRate,
        irpfAmount,
        totalAmount,
        advanceAmount: 0,
        remainingAmount: 0
      },
      status: 'EMITIDA',
      paymentMethod: originalInvoice.paymentMethod || 'Transferencia bancaria / Bizum',
      legalNote
    };
  }

  /**
   * Convierte un presupuesto en una Factura legal formal (con deducción de anticipos previos si existen)
   * @param {object} budget - Objeto presupuesto original
   * @param {object} [options] - Opciones adicionales (clientNif, operationDate, etc.)
   * @returns {object} Objeto factura formal
   */
  convertToInvoice(budget, options = {}) {
    if (!budget || !budget.items) {
      throw new Error('No se puede generar factura sin un presupuesto base válido.');
    }

    const year = new Date().getFullYear();
    const invoiceCounter = options.invoiceNumber || 1;
    const comp = options.company || budget.company || this.company || {};
    let invoiceId = options.id;
    if (!invoiceId) {
      if (comp.invoiceSeries) {
        const cleanSeries = comp.invoiceSeries.trim();
        const prefix = cleanSeries.endsWith('-') || cleanSeries.endsWith('/') ? cleanSeries : `${cleanSeries}-`;
        invoiceId = `${prefix}${String(invoiceCounter).padStart(3, '0')}`;
      } else {
        invoiceId = `FAC-${year}-${String(invoiceCounter).padStart(4, '0')}`;
      }
    }

    const today = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const operationDate = options.operationDate || today;

    const invoiceType = options.type || 'FINAL';
    const rawItems = options.items && options.items.length > 0 ? options.items : budget.items;
    const items = rawItems.map(item => ({
      id: item.id || `item-${Math.random().toString(36).substring(2, 7)}`,
      description: item.description,
      qty: item.qty || 1,
      unit: item.unit || 'pa',
      unitPrice: item.unitPrice || 0,
      total: item.total || 0
    }));

    const fin = budget.financials || {};
    const isPartialItems = Boolean(options.items && options.items.length > 0 && options.items.length !== budget.items.length);

    let itemsSubtotal = 0;
    let itemsDiscountAmount = 0;
    let itemsTaxableBase = 0;
    let itemsTaxAmount = 0;
    let irpfAmount = 0;
    let adjustedTotalAmount = 0;

    const discountRate = (fin.discountPercentage || 0) / 100;
    const taxRate = (fin.taxRatePercentage ?? 21) / 100;
    const irpfRate = Number(options.irpfRate !== undefined ? options.irpfRate : (budget.financials?.irpfRatePercentage !== undefined ? budget.financials.irpfRatePercentage : (comp.irpfRate || 0)));

    if (isPartialItems) {
      itemsSubtotal = items.reduce((sum, it) => sum + (Number(it.total) || 0), 0);
      itemsDiscountAmount = Number((itemsSubtotal * discountRate).toFixed(2));
      itemsTaxableBase = Number((itemsSubtotal - itemsDiscountAmount).toFixed(2));
      itemsTaxAmount = Number((itemsTaxableBase * taxRate).toFixed(2));
      irpfAmount = irpfRate > 0 ? Number((itemsTaxableBase * (irpfRate / 100)).toFixed(2)) : 0;
      adjustedTotalAmount = Number((itemsTaxableBase + itemsTaxAmount - irpfAmount).toFixed(2));
    } else {
      itemsSubtotal = fin.subtotal || items.reduce((sum, it) => sum + (Number(it.total) || 0), 0);
      itemsDiscountAmount = fin.discountAmount || Number((itemsSubtotal * discountRate).toFixed(2));
      itemsTaxableBase = fin.taxableBase || Number((itemsSubtotal - itemsDiscountAmount).toFixed(2));
      itemsTaxAmount = fin.taxAmount || Number((itemsTaxableBase * taxRate).toFixed(2));
      const rawTotal = fin.totalAmount !== undefined && fin.irpfAmount !== undefined
        ? Number((itemsTaxableBase + itemsTaxAmount).toFixed(2))
        : (fin.totalAmount || (itemsTaxableBase + itemsTaxAmount));
      irpfAmount = irpfRate > 0 ? Number((itemsTaxableBase * (irpfRate / 100)).toFixed(2)) : 0;
      adjustedTotalAmount = Number((rawTotal - irpfAmount).toFixed(2));
    }

    // Verificar si existen facturas de anticipo emitidas formalmente (se deducen en factura FINAL u ordinaria)
    const advanceInvoices = (invoiceType === 'FINAL' || invoiceType === 'ORDINARIA') ? (options.advanceInvoices || budget.advanceInvoices || []) : [];
    let advanceTaxableBase = 0;
    let advanceTaxAmount = 0;
    let advanceTotalAmount = 0;

    const advanceDeductions = advanceInvoices.map(adv => {
      const b = adv.financials?.taxableBase || 0;
      const t = adv.financials?.taxAmount || 0;
      const tot = adv.financials?.totalAmount || 0;
      advanceTaxableBase += b;
      advanceTaxAmount += t;
      advanceTotalAmount += tot;
      return {
        id: adv.id,
        date: adv.issueDate || adv.operationDate,
        taxableBase: b,
        taxAmount: t,
        total: tot,
        description: (adv.type === 'HITO' || String(adv.naming || '').includes('Hito'))
          ? `Deducción por hito / certificación facturada según Factura nº ${adv.naming || adv.id} de fecha ${adv.issueDate || adv.operationDate}`
          : `Deducción por anticipo percibido según Factura nº ${adv.naming || adv.id} de fecha ${adv.issueDate || adv.operationDate}`
      };
    });

    const advanceAmount = Number(advanceTotalAmount.toFixed(2));
    const remainingAmount = Number(Math.max(0, adjustedTotalAmount - advanceAmount).toFixed(2));

    const isSettlement = Boolean(advanceDeductions.length > 0);
    const invoiceNaming = formatInvoiceNaming(isSettlement ? 'FINAL' : invoiceType, budget.id, options.seq || 1);

    const invoice = {
      id: invoiceId,
      displayNumber: invoiceNaming,
      naming: invoiceNaming,
      type: invoiceType,
      phaseName: options.phaseName || undefined,
      budgetId: budget.id,
      issueDate: today,
      operationDate,
      company: {
        ...this.company,
        ...(budget.company || {}),
        ...(options.company || {})
      },
      client: {
        name: options.clientName || budget.client?.name || 'Cliente Particular',
        address: options.clientAddress || budget.client?.address || 'Ubicación según visita',
        nif: options.clientNif || budget.client?.nif || 'Consignado en contrato',
        phone: options.clientPhone || budget.client?.phone || null,
        email: options.clientEmail || budget.client?.email || null
      },
      items,
      advanceDeductions: advanceDeductions.length > 0 ? advanceDeductions : undefined,
      financials: {
        subtotal: itemsSubtotal,
        discountPercentage: fin.discountPercentage || 0,
        discountAmount: itemsDiscountAmount,
        taxableBase: itemsTaxableBase,
        taxRatePercentage: fin.taxRatePercentage ?? 21,
        taxAmount: itemsTaxAmount,
        irpfRatePercentage: irpfRate,
        irpfAmount,
        totalAmount: adjustedTotalAmount,
        advanceTaxableBase: Number(advanceTaxableBase.toFixed(2)),
        advanceTaxAmount: Number(advanceTaxAmount.toFixed(2)),
        advanceAmount,
        remainingAmount
      },
      status: remainingAmount === 0 ? 'PAGADA' : 'PENDIENTE_PAGO',
      paymentMethod: options.paymentMethod || 'Transferencia bancaria / Bizum'
    };

    return invoice;
  }

  /**
   * Registra un pago/anticipo asociado a un presupuesto y actualiza sus saldos
   * @param {object} budget - Objeto presupuesto
   * @param {object} paymentData - { amount, method, concept, date, notes }
   * @returns {object} { receipt, budget }
   */
  registerPayment(budget, paymentData = {}) {
    if (!budget) {
      throw new Error('No se puede registrar un cobro sin un presupuesto de referencia.');
    }

    const amount = Number(paymentData.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('El importe del cobro debe ser un número positivo.');
    }

    if (!budget.payments) budget.payments = [];
    if (!budget.paymentSummary) {
      budget.paymentSummary = {
        totalPaid: 0,
        remainingBalance: budget.financials?.totalAmount || 0,
        status: 'PENDIENTE'
      };
    }

    const totalAmount = budget.financials?.totalAmount || 0;
    const paymentsSum = budget.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const previouslyPaid = Math.max(paymentsSum, budget.paymentSummary?.totalPaid || 0);
    const newTotalPaid = Number((previouslyPaid + amount).toFixed(2));
    const newRemaining = Number(Math.max(0, totalAmount - newTotalPaid).toFixed(2));

    let newStatus = 'PARCIAL';
    if (newRemaining === 0) {
      newStatus = 'LIQUIDADO';
    } else if (newTotalPaid === 0) {
      newStatus = 'PENDIENTE';
    }

    const year = new Date().getFullYear();
    let receiptId = paymentData.id;
    if (!receiptId) {
      do {
        receiptId = `REC-${year}-${String(Math.floor(100000 + Math.random() * 900000))}`;
      } while (budget.payments.some(p => p.id === receiptId));
    }
    const dateStr = paymentData.date || new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });

    let receiptType = paymentData.type;
    if (!receiptType) {
      if (newRemaining === 0) {
        receiptType = 'FINAL';
      } else if (previouslyPaid === 0 || (paymentData.concept && paymentData.concept.toLowerCase().includes('anticipo'))) {
        receiptType = 'ANTICIPO';
      } else {
        receiptType = 'HITO';
      }
    }

    let seq = 1;
    if (receiptType === 'HITO' || receiptType === 'FASE' || receiptType === 'PARCIAL') {
      const priorHitos = (budget.payments || []).filter(p => {
        const t = (p.type || '').toUpperCase();
        return t === 'HITO' || t === 'FASE' || t === 'PARCIAL';
      });
      seq = priorHitos.length + 1;
    }

    const receiptNaming = formatReceiptNaming(receiptType, budget.id, seq);

    const receipt = {
      id: receiptId,
      displayNumber: receiptNaming,
      naming: receiptNaming,
      type: receiptType,
      budgetId: budget.id || 'PRE-2026',
      date: dateStr,
      amount,
      method: paymentData.method || 'Bizum',
      concept: paymentData.concept || (previouslyPaid === 0 ? 'Anticipo para acopio de materiales' : 'Entrega a cuenta de trabajos'),
      previouslyPaid,
      totalPaid: newTotalPaid,
      totalAmount,
      remainingBalance: newRemaining,
      status: newStatus,
      client: budget.client || {},
      company: budget.company || this.company
    };

    budget.payments.push({
      id: receiptId,
      displayNumber: receiptNaming,
      naming: receiptNaming,
      type: receiptType,
      amount,
      method: receipt.method,
      concept: receipt.concept,
      date: dateStr
    });

    budget.paymentSummary = {
      totalPaid: newTotalPaid,
      remainingBalance: newRemaining,
      status: newStatus
    };

    if (newRemaining <= 0) {
      budget.status = 'FINALIZADO';
    }

    return { receipt, budget };
  }

  /**
   * Obtiene un resumen claro del estado de pagos y deuda de un presupuesto
   * @param {object} budget
   * @returns {object}
   */
  getPaymentSummary(budget) {
    if (!budget) return null;
    const totalAmount = budget.financials?.totalAmount || 0;
    const payments = budget.payments || [];
    const totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const remainingBalance = Number(Math.max(0, totalAmount - totalPaid).toFixed(2));

    let status = 'PENDIENTE';
    if (remainingBalance === 0 && totalAmount > 0) status = 'LIQUIDADO';
    else if (totalPaid > 0) status = 'PARCIAL';

    return {
      budgetId: budget.id,
      clientName: budget.client?.name || 'Cliente Particular',
      totalAmount,
      totalPaid,
      remainingBalance,
      status,
      paymentsCount: payments.length,
      payments
    };
  }
}

export function getBudgetClientNumber(budgetId) {
  if (!budgetId) return '1';
  const m = String(budgetId).match(/(\d+)$/);
  if (m) {
    const parsed = parseInt(m[1], 10);
    return isNaN(parsed) ? m[1] : String(parsed);
  }
  const m2 = String(budgetId).match(/(\d+)/g);
  if (m2 && m2.length > 0) {
    const last = m2[m2.length - 1];
    const parsed = parseInt(last, 10);
    return isNaN(parsed) ? last : String(parsed);
  }
  return '1';
}

export function getBudgetYear(budgetId) {
  if (!budgetId) return new Date().getFullYear();
  const m = String(budgetId).match(/(?:PRE)?(20\d\d)/i);
  return m ? m[1] : new Date().getFullYear();
}

export function formatInvoiceNaming(type, budgetId, seq = 1) {
  const year = getBudgetYear(budgetId);
  const clientNum = getBudgetClientNumber(budgetId);
  const seqStr = String(seq || 1).padStart(3, '0');

  let typeWord = 'Final';
  const upper = String(type || '').toUpperCase();
  if (upper === 'ANTICIPO') {
    typeWord = 'Anticipo';
  } else if (upper === 'FASE' || upper === 'HITO') {
    typeWord = 'Hito';
  } else if (upper === 'RECTIFICATIVA') {
    typeWord = 'Rectificativa';
  } else if (upper === 'FINAL') {
    typeWord = 'Final';
  }

  return `Factura_${typeWord}_${year}-${clientNum}-${seqStr}`;
}

export function formatReceiptNaming(type, budgetId, seq = 1) {
  const year = getBudgetYear(budgetId);
  const clientNum = getBudgetClientNumber(budgetId);
  const seqStr = String(seq || 1).padStart(3, '0');

  let typeWord = 'Final';
  const upper = String(type || '').toUpperCase();
  if (upper === 'ANTICIPO') {
    typeWord = 'Anticipo';
  } else if (upper === 'FASE' || upper === 'HITO' || upper === 'PARCIAL') {
    typeWord = 'Hito';
  } else if (upper === 'FINAL' || upper === 'LIQUIDADO') {
    typeWord = 'Final';
  }

  return `Recibo_${typeWord}_${year}-${clientNum}-${seqStr}`;
}
