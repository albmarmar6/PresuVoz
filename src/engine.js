/**
 * PresuVoz Core Engine
 * Procesa transcripciones de voz de profesionales y genera presupuestos estructurados
 * con cálculo impositivo conforme a la normativa fiscal española (IVA 10% vs 21%).
 */

import { PresuVozParser } from './parser.js';

export class PresuVozEngine {
  constructor(companyConfig = {}) {
    this.company = {
      name: companyConfig.name || "Carpintería y Reformas Manolo S.L.",
      cif: companyConfig.cif || "B-12345678",
      phone: companyConfig.phone || "600 11 22 33",
      email: companyConfig.email || "presupuestos@carpinteriamanolo.es",
      address: companyConfig.address || "Polígono Industrial Nave 14, Sevilla",
      logoText: companyConfig.logoText || "CM",
      brandColor: companyConfig.brandColor || "#9a3412", // Color madera cálido
      professionalSigner: companyConfig.professionalSigner || "Manuel Gómez (Administrador)",
      signatureImage: companyConfig.signatureImage || null // Sello/firma digitalizada
    };
  }

  /**
   * Determina automáticamente el tipo de IVA aplicable según el texto del audio
   * @param {string} text - Transcripción del audio
   * @returns {number} 0.10 (reducido para vivienda habitual) o 0.21 (general)
   */
  detectTaxRate(text) {
    const lower = text.toLowerCase();
    const reducedKeywords = [
      "reforma de vivienda",
      "vivienda habitual",
      "vivienda",
      "la casa",
      "una casa",
      "casa particular",
      "piso particular",
      "piso",
      "baño",
      "cocina",
      "cambio de bañera",
      "plato de ducha",
      "mampara",
      "iva reducido",
      "iva del 10"
    ];

    for (const kw of reducedKeywords) {
      if (lower.includes(kw)) {
        return 0.10; // IVA Reducido 10% (Art. 91 Uno 2.10º Ley del IVA)
      }
    }
    return 0.21; // IVA General 21%
  }

  /**
   * Extrae condiciones de pago y validez desde el audio o aplica estándares profesionales
   * @param {string} text 
   * @returns {object}
   */
  extractTerms(text) {
    const lower = text.toLowerCase();
    let advancePercentage = 30; // 30% estándar para acopio de materiales
    let validityDays = 15;

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
      textConditions: `${advancePercentage}% al aceptar el presupuesto para reserva de fechas y acopio de materiales. ${100 - advancePercentage}% a la finalización de los trabajos.`
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

    const taxRate = rawInput.taxRate !== undefined ? rawInput.taxRate : this.detectTaxRate(rawText);
    const terms = this.extractTerms(rawText);

    // Calcular y sanitizar estrictamente cada partida
    let subtotal = 0;
    const items = itemsToProcess.map((item, index) => {
      const qty = item.qty || 1;
      const unitPrice = item.price !== undefined ? item.price : (item.unitPrice || 0);
      const total = Number((qty * unitPrice).toFixed(2));
      subtotal += total;

      // Sanitización contra palabras sueltas o muletillas
      const cleanDesc = PresuVozParser.normalizeItemDescription(item.description || "");

      const isPricePending = item.isPricePending !== undefined ? item.isPricePending : (total === 0);

      return {
        id: index + 1,
        description: cleanDesc,
        qty,
        unit: item.unit || 'pa',
        unitPrice,
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
        discountAmount = Number(((subtotal * discountPercentage) / 100).toFixed(2));
      } else if (discountInfo.type === 'fixed') {
        discountAmount = discountInfo.value;
        discountPercentage = subtotal > 0 ? Number(((discountAmount / subtotal) * 100).toFixed(1)) : 0;
      }
    }

    subtotal = Number(subtotal.toFixed(2));
    const taxableBase = Number((subtotal - discountAmount).toFixed(2));
    const taxAmount = Number((taxableBase * taxRate).toFixed(2));
    const totalAmount = Number((taxableBase + taxAmount).toFixed(2));
    const advanceAmount = Number(((totalAmount * terms.advancePercentage) / 100).toFixed(2));

    const budgetId = `PRE-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
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
      signUrl: `https://presuvoz.app/f/${Math.random().toString(36).substring(2, 9)}`,
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
    const taxRate = (budget.financials.taxRatePercentage || 21) / 100;
    const advancePct = budget.financials.advancePercentage || 30;

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
    const invoiceCounter = options.invoiceNumber || Math.floor(100 + Math.random() * 900);
    const invoiceId = `FAC-${year}-${String(invoiceCounter).padStart(4, '0')}`;
    const today = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const taxRate = (budget.financials?.taxRatePercentage || 10) / 100;
    const taxableBase = Number((rawAmount / (1 + taxRate)).toFixed(2));
    const taxAmount = Number((rawAmount - taxableBase).toFixed(2));
    const totalAmount = Number((taxableBase + taxAmount).toFixed(2));

    const addressPart = budget.client?.address ? ` en ${budget.client.address}` : '';
    const itemDesc = options.concept || `Entrega a cuenta / Anticipo por aceptación de presupuesto ${budget.id || ''}${addressPart}`;

    const advanceInvoice = {
      id: invoiceId,
      type: 'ANTICIPO',
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
        taxRatePercentage: budget.financials?.taxRatePercentage || 10,
        taxAmount,
        totalAmount,
        advanceAmount: 0,
        remainingAmount: 0
      },
      status: 'PAGADA',
      paymentMethod: paymentData.method || 'Transferencia bancaria / Bizum',
      legalNote: 'Factura de anticipo emitida conforme al Art. 75.Dos de la Ley 37/1992 del IVA y RD 1619/2012.'
    };

    if (!budget.advanceInvoices) budget.advanceInvoices = [];
    budget.advanceInvoices.push(advanceInvoice);

    return advanceInvoice;
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
    const invoiceCounter = options.invoiceNumber || (Math.floor(100 + Math.random() * 900));
    const invoiceId = `FAC-${year}-${String(invoiceCounter).padStart(4, '0')}`;

    const today = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const operationDate = options.operationDate || today;

    const fin = budget.financials || {};
    const totalAmount = fin.totalAmount || 0;
    const paidSoFar = budget.paymentSummary?.totalPaid || 0;

    // Verificar si existen facturas de anticipo emitidas formalmente
    const advanceInvoices = options.advanceInvoices || budget.advanceInvoices || [];
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
        description: `Deducción por anticipo percibido según Factura nº ${adv.id} de fecha ${adv.issueDate || adv.operationDate}`
      };
    });

    // Si no hay facturas de anticipo explícitas pero sí hay cobros registrados, usar el importe cobrado
    const advanceAmount = advanceTotalAmount > 0 
      ? Number(advanceTotalAmount.toFixed(2))
      : (options.advanceAmount !== undefined ? options.advanceAmount : (paidSoFar > 0 ? paidSoFar : (fin.advanceAmount || 0)));

    const remainingAmount = Number(Math.max(0, totalAmount - advanceAmount).toFixed(2));

    const invoice = {
      id: invoiceId,
      type: 'FINAL',
      budgetId: budget.id || 'PRE-2026',
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
      items: budget.items.map(item => ({
        id: item.id,
        description: item.description,
        qty: item.qty || 1,
        unit: item.unit || 'pa',
        unitPrice: item.unitPrice || 0,
        total: item.total || 0
      })),
      advanceDeductions: advanceDeductions.length > 0 ? advanceDeductions : undefined,
      financials: {
        subtotal: fin.subtotal || 0,
        discountPercentage: fin.discountPercentage || 0,
        discountAmount: fin.discountAmount || 0,
        taxableBase: fin.taxableBase || 0,
        taxRatePercentage: fin.taxRatePercentage || 10,
        taxAmount: fin.taxAmount || 0,
        totalAmount,
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
    const previouslyPaid = budget.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const newTotalPaid = Number((previouslyPaid + amount).toFixed(2));
    const newRemaining = Number(Math.max(0, totalAmount - newTotalPaid).toFixed(2));

    let newStatus = 'PARCIAL';
    if (newRemaining === 0) {
      newStatus = 'LIQUIDADO';
    } else if (newTotalPaid === 0) {
      newStatus = 'PENDIENTE';
    }

    const year = new Date().getFullYear();
    const receiptId = `REC-${year}-${String(Math.floor(100 + Math.random() * 900))}`;
    const dateStr = paymentData.date || new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });

    const receipt = {
      id: receiptId,
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
