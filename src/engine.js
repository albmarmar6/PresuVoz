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
      "piso particular",
      "baño",
      "cocina",
      "cambio de bañera",
      "plato de ducha",
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

    // Si no se proporcionaron partidas pre-estructuradas, parsear la transcripción cruda
    if (!itemsToProcess || !Array.isArray(itemsToProcess) || itemsToProcess.length === 0) {
      const parseResult = PresuVozParser.parseTranscript(rawText);

      if (!parseResult.isValid) {
        return {
          success: false,
          errors: parseResult.errors,
          budget: null
        };
      }

      itemsToProcess = parseResult.data.items;
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

      return {
        id: index + 1,
        description: cleanDesc,
        qty,
        unitPrice,
        total
      };
    });

    subtotal = Number(subtotal.toFixed(2));
    const taxAmount = Number((subtotal * taxRate).toFixed(2));
    const totalAmount = Number((subtotal + taxAmount).toFixed(2));
    const advanceAmount = Number(((totalAmount * terms.advancePercentage) / 100).toFixed(2));

    const budgetId = `PRE-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const issueDate = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const budget = {
      id: budgetId,
      issueDate,
      company: this.company,
      client: {
        name: clientName || "Cliente Particular",
        address: clientAddress || "Ubicación obra según visita",
        phone: rawInput.clientPhone || "No especificado",
        email: rawInput.clientEmail || null
      },
      items,
      financials: {
        subtotal,
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
      status: "PENDIENTE_FIRMA",
      signUrl: `https://presuvoz.app/f/${Math.random().toString(36).substring(2, 9)}`
    };

    // Objeto compatible con desestructuración directa y chequeo de éxito
    return Object.assign(budget, {
      success: true,
      errors: [],
      budget
    });
  }
}
