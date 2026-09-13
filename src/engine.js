/**
 * PresuVoz Core Engine
 * Procesa transcripciones de voz de profesionales y genera presupuestos estructurados
 * con cálculo impositivo conforme a la normativa fiscal española (IVA 10% vs 21%).
 */

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

    const advanceMatch = lower.match(/(\d{1,2})\s*%\s*(por adelantado|a la firma|al inicio|de anticipo)/);
    if (advanceMatch) {
      advancePercentage = parseInt(advanceMatch[1], 10);
    }

    const validityMatch = lower.match(/(\d{1,2})\s*d[ií]as/);
    if (validityMatch) {
      validityDays = parseInt(validityMatch[1], 10);
    }

    return {
      advancePercentage,
      validityDays,
      textConditions: `${advancePercentage}% al aceptar el presupuesto para reserva de fechas y acopio de materiales. ${100 - advancePercentage}% a la finalización de los trabajos.`
    };
  }

  /**
   * Procesa un caso estructurado o semi-estructurado y calcula el desglose financiero exacto
   * @param {object} input 
   * @returns {object} Presupuesto completo listo para visualización y firma
   */
  process(input) {
    const rawText = input.rawTranscript || "";
    const taxRate = input.taxRate !== undefined ? input.taxRate : this.detectTaxRate(rawText);
    const terms = this.extractTerms(rawText);

    // Calcular partidas
    let subtotal = 0;
    const items = (input.items || []).map((item, index) => {
      const qty = item.qty || 1;
      const unitPrice = item.price || 0;
      const total = Number((qty * unitPrice).toFixed(2));
      subtotal += total;

      return {
        id: index + 1,
        description: item.description || "Partida de obra/instalación",
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

    return {
      id: budgetId,
      issueDate,
      company: this.company,
      client: {
        name: input.clientName || "Cliente Particular",
        address: input.clientAddress || "Ubicación obra según visita",
        phone: input.clientPhone || "No especificado"
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
        conditions: input.customConditions || terms.textConditions
      },
      status: "PENDIENTE_FIRMA",
      signUrl: `https://presuvoz.app/f/${Math.random().toString(36).substring(2, 9)}`
    };
  }
}
