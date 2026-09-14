/**
 * PresuVoz Parser & Sanitizer
 * Módulo de procesamiento lingüístico, limpieza de ruido/muletillas
 * y normalización a partidas técnicas de construcción e instalaciones.
 */

export class PresuVozParser {
  /**
   * Diccionario de normalización técnica: mapea expresiones coloquiales de oficio
   * a redacciones formales de partidas de obra y edificación.
   */
  static TECHNICAL_DICTIONARY = [
    // Fontanería y Baño
    {
      regex: /(cambiar|quitar|tirar|demoler)\s*(la)?\s*bañera\s*(y|por|\+)\s*(poner|instalar|montar)?\s*(el)?\s*plato/i,
      formal: "Demolición de bañera existente, desescombro y colocación de plato de ducha de resina antideslizante con válvula"
    },
    {
      regex: /(cambiar|quitar|tirar|demoler)\s*(la)?\s*bañera/i,
      formal: "Demolición de bañera existente, desescombro y retirada a vertedero o punto limpio autorizado"
    },
    {
      regex: /(poner|instalar|montar|colocar)\s*(un)?\s*(el)?\s*plato\s*(de)?\s*(ducha)?/i,
      formal: "Suministro e instalación de plato de ducha de resina mineral antideslizante con válvula sifónica de gran caudal"
    },
    {
      regex: /(alicatar|azulejos?|revestimiento)\s*(de)?\s*(la)?\s*(zona)?\s*(de)?\s*(ducha|pared|baño)/i,
      formal: "Revestimiento y rejuntado de paramentos verticales mediante alicatado cerámico con mortero adhesivo impermeable"
    },
    {
      regex: /(mampara|cristal)\s*(fija?|corredera)?/i,
      formal: "Suministro y montaje de mampara de seguridad en vidrio templado (8 mm) con perfilería de aluminio y tratamiento antical"
    },
    {
      regex: /(grifer[ií]a|grifo|termost[aá]tic[ao])/i,
      formal: "Suministro e instalación de conjunto de grifería monomando / termostática con rociador y flexo"
    },
    {
      regex: /(mover|tomas?|tuber[ií]as?)\s*(de)?\s*(agua|fontaner[ií]a|desag[uü]e)/i,
      formal: "Adecuación de tomas de fontanería para agua fría/caliente y conexión de desagüe a bajante"
    },

    // Electricidad
    {
      regex: /(cambiar|poner|adecuar)?\s*(el)?\s*diferencial|magnetot[eé]rmico|cuadro\s*(el[eé]ctrico)?/i,
      formal: "Adecuación de cuadro general de mando y protección mediante suministro e instalación de interruptor diferencial 40A y magnetotérmicos"
    },
    {
      regex: /(l[ií]nea\s*(nueva|reforzada|independiente)?|cable)\s*(para\s*(el)?\s*horno|6\s*mm)/i,
      formal: "Instalación de línea eléctrica independiente reforzada (sección 6 mm²) bajo tubo corrugado ignífugo para horno y placa"
    },
    {
      regex: /(enchufes?|tomas?\s*de\s*corriente|mecanismos?)/i,
      formal: "Suministro y montaje de tomas de corriente tipo Schuko con toma de tierra y embellecedores de primera calidad"
    },

    // Climatización
    {
      regex: /(split|aire\s*acondicionado|clima)\s*([0-9]+\s*frigor[ií]as)?/i,
      formal: "Suministro e instalación de equipo de aire acondicionado tipo Split (unidad interior y exterior) con bomba de calor y alta eficiencia energética"
    },
    {
      regex: /(l[ií]nea\s*frigor[ií]fica|tubos?|soporte)/i,
      formal: "Tendido de línea frigorífica aislada, soportes exteriores con amortiguadores antivibratorios silentblock y línea de desagüe"
    },

    // Pintura y Acabados
    {
      regex: /(pintura|pintar|enlucir|alisar)/i,
      formal: "Preparación de paramentos, emplastecido y aplicación de pintura plástica lisa de alta cubrición en techos y paredes"
    },

    // Carpintería y Reformas
    {
      regex: /(armario\s*empotrado|fabricaci[oó]n\s*a\s*medida)/i,
      formal: "Fabricación a medida e instalación de armario empotrado con puertas correderas, acabado melamínico de alta resistencia y distribución interior a medida"
    },
    {
      regex: /(cepillar|ajustar|manivelas?|puertas?\s*de\s*paso)/i,
      formal: "Revisión, cepillado de holguras, ajuste perimetral y sustitución de manivelas en puertas de paso de madera"
    },
    {
      regex: /(suelo|tarima\s*flotante|laminado|ac5)/i,
      formal: "Suministro e instalación de suelo laminado de alta resistencia (AC5) con base aislante acústica y zócalos perimetrales"
    }
  ];

  /**
   * Lista negra de palabras coloquiales, muletillas y frases que NUNCA deben aparecer en el presupuesto
   */
  static JUNK_WORDS_PATTERNS = [
    /oye\s+(carlos|manolo|paco|socio|t[ií]o|compañero)?/gi,
    /qu[eé]\s+pasa\s+(t[ií]o|socio|paco)?/gi,
    /mira\s+(que|te\s+grabo)?/gi,
    /salgo\s+de\s+la\s+obra/gi,
    /vaya\s+tela/gi,
    /vengo\s+de\s+ver\s+al\s+cliente/gi,
    /casi\s+me\s+muerde\s+el\s+perro(\s+del\s+cliente)?/gi,
    /no\s+sea\s+rata/gi,
    /a\s+ver\s+si\s+no\s+nos\s+deja\s+tirados/gi,
    /que\s+no\s+tiene\s+un\s+duro/gi,
    /ap[uú]ntale?\s+(esto|ah[ií])?/gi,
    /m[aá]ndaselo\s+(r[aá]pido|ya)?/gi,
    /dile\s+que/gi,
    /bueno\s+a\s+ver/gi,
    /una\s+pasta/gi,
    /joder/gi,
    /hostia/gi
  ];

  /**
   * Diccionario numérico para convertir números escritos en letras a cifras reales
   */
  static SPANISH_NUMBERS = {
    "cero": 0, "un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5,
    "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "once": 11, "doce": 12,
    "trece": 13, "catorce": 14, "quince": 15, "dieciséis": 16, "diecisiete": 17, "dieciocho": 18,
    "diecinueve": 19, "veinte": 20, "veintiuno": 21, "veintidós": 22, "veintitrés": 23,
    "veinticuatro": 24, "veinticinco": 25, "treinta": 30, "cuarenta": 40, "cincuenta": 50,
    "sesenta": 60, "setenta": 70, "ochenta": 80, "noventa": 90, "cien": 100, "ciento": 100,
    "doscientos": 200, "trescientos": 300, "cuatrocientos": 400, "quinientos": 500,
    "seiscientos": 600, "setecientos": 700, "ochocientos": 800, "novecientos": 900,
    "mil": 1000
  };

  /**
   * Convierte expresiones numéricas coloquiales o en letras a número
   * Ejemplo: "mil doscientos" -> 1200, "400 pavos" -> 400
   */
  static parsePriceString(str) {
    if (!str) return 0;

    // Normalizar slang: "pavos", "euros", "eurillos"
    const cleaned = str.replace(/pavos|eurillos|euros|€/gi, "").trim();

    // Si ya es un número directo (ej: "400", "56.50", "1250")
    const directNum = parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
    if (!isNaN(directNum) && directNum > 0) {
      return directNum;
    }

    // Procesar números en palabras en español (ej: "mil doscientos", "ochenta y cinco")
    const words = cleaned.toLowerCase().split(/\s+/);
    let total = 0;
    let current = 0;

    for (const word of words) {
      if (word === "y") continue;
      if (this.SPANISH_NUMBERS[word] !== undefined) {
        const val = this.SPANISH_NUMBERS[word];
        if (val === 1000) {
          current = current === 0 ? 1000 : current * 1000;
          total += current;
          current = 0;
        } else {
          current += val;
        }
      }
    }
    total += current;
    return total > 0 ? total : 0;
  }

  /**
   * Extrae el nombre del cliente eliminando preposiciones y fórmulas de cortesía
   */
  static extractClientName(text) {
    // Busca: "Para [Don/Doña]? [Nombre Apellido]" delimitado por "en", "de", "con" o fin de línea
    const match = text.match(/(?:para|cliente:?)\s+(?:don|doña)?\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2})(?=\s+(?:en|con|de|del|para|que)\b|:|$)/i);
    if (match) {
      return match[1].trim();
    }
    return "Cliente Particular";
  }

  /**
   * Extrae la dirección o ubicación de la obra
   */
  static extractAddress(text) {
    // Busca: "en Calle/Avenida/Plaza/Paseo/Ctra... número..."
    const match = text.match(/en\s+((?:calle|avenida|avda\.?|plaza|paseo|camino|carretera)\s+[^,\.\n]+?(?:\d+|[a-záéíóúñ\s]+)?)/i);
    if (match) {
      let addr = match[1].replace(/\s+(hay\s+que|para|con|al|que|dile)\b.*/i, "").trim();
      return addr.replace(/[:,\.\-]+$/, "").trim();
    }
    return "Ubicación obra según visita técnica";
  }

  /**
   * Limpia una frase cruda eliminando muletillas e improperios
   */
  static cleanRawText(text) {
    let result = text;
    for (const pattern of this.JUNK_WORDS_PATTERNS) {
      result = result.replace(pattern, " ");
    }
    return result.replace(/\s+/g, " ").trim();
  }

  /**
   * Normaliza una descripción coloquial a su estándar técnico formal
   */
  static normalizeItemDescription(rawDesc) {
    const cleaned = this.cleanRawText(rawDesc);

    // Buscar en el diccionario técnico de gremios
    for (const entry of this.TECHNICAL_DICTIONARY) {
      if (entry.regex.test(cleaned)) {
        return entry.formal;
      }
    }

    // Si no está en el diccionario, capitalizar y limpiar
    if (cleaned.length > 5) {
      const firstChar = cleaned.charAt(0).toUpperCase();
      return firstChar + cleaned.slice(1);
    }
    return "Partida técnica de obra / instalación según especificaciones";
  }

  /**
   * Parsea un texto crudo completo de audio y extrae las partidas estructuradas
   */
  static parseTranscript(rawTranscript) {
    if (!rawTranscript || typeof rawTranscript !== "string") {
      return {
        isValid: false,
        errors: ["El audio o transcripción está vacío."],
        data: null
      };
    }

    const warnings = [];
    const clientName = this.extractClientName(rawTranscript);
    const clientAddress = this.extractAddress(rawTranscript);

    // Separar por líneas, guiones o conectores comunes ("hay que hacer:", "-", "y también")
    const lines = rawTranscript
      .split(/\n|(?:\s*-\s*)|\b(?:primero|segundo|tercero|luego|adem[aá]s|y\s+tambi[eé]n)\b/i)
      .map(l => l.trim())
      .filter(l => l.length > 8);

    const rawItems = [];

    // Regex de precio: dígitos o palabras numéricas españolas
    const priceRegex = /(?:por\s+|[:\s])?((?:\d+(?:[\.,]\d{1,2})?|\b(?:(?:mil|doscient[ao]s|trescient[ao]s|cuatrocient[ao]s|quinient[ao]s|seiscient[ao]s|setecient[ao]s|ochocient[ao]s|novecient[ao]s|cien|ciento|veinte|veinti[a-záéíóúñ]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|diez|once|doce|trece|catorce|quince|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\s*(?:y\s*)?)+))\s*(?:euros?|pavos|€)\b/i;

    for (const line of lines) {
      // Omitir líneas que son solo presentación, dirección o condiciones de pago
      if (/(^para\s+[A-Z]|calle|avenida|paseo|plaza|vivienda\s+habitual|validez|anticipo|cobramos\s+[0-9]+%|pague\s+el\s+[0-9]+%|dile\s+que\s+no\s+sea\s+rata)/i.test(line)) {
        continue;
      }

      const priceMatch = line.match(priceRegex);

      if (priceMatch) {
        const rawPriceStr = priceMatch[1].trim();
        const price = this.parsePriceString(rawPriceStr);
        
        // Extraer descripción quitando el precio y las muletillas
        let desc = line.replace(priceMatch[0], "").replace(/^[\s:\-,]+/, "").replace(/[\s\.\-,]+$/, "").trim();
        desc = this.cleanRawText(desc);

        // Detectar cantidad (ej: "4 enchufes", "5 puertas")
        let qty = 1;
        const qtyMatch = desc.match(/^([0-9]+)\s+/);
        if (qtyMatch) {
          qty = parseInt(qtyMatch[1], 10);
          desc = desc.replace(qtyMatch[0], "");
        }

        if (price > 0 && desc.length > 3) {
          const formalDesc = this.normalizeItemDescription(desc);
          rawItems.push({
            description: formalDesc,
            qty,
            unitPrice: qty > 1 ? Number((price / qty).toFixed(2)) : price,
            total: price,
            isPricePending: false
          });
        }
      } else {
        // La línea describe una partida de trabajo pero NO tenía precio (modo borrador / medición)
        if (/(cambiar|instalar|poner|alicatar|demolici[oó]n|reparar|revisi[oó]n|fabricaci[oó]n|suelo|tarima|tuber[ií]a|grifo|baño|cocina|cuadro|puerta|ventana|split|climatizaci[oó]n|pint(ar|ura)|tabique|rozas)/i.test(line)) {
          const cleanPending = this.cleanRawText(line);
          const formalDesc = this.normalizeItemDescription(cleanPending);
          rawItems.push({
            description: formalDesc,
            qty: 1,
            unitPrice: 0,
            total: 0,
            isPricePending: true
          });
          warnings.push(`Partida pendiente de valorar: "${formalDesc}" (no se mencionó precio en el audio).`);
        } else if (line.length > 15 && !/(hola|buenos\s+d[ií]as|adi[oó]s|un\s+saludo)/i.test(line)) {
          // Fragmento con texto que no se interpretó como partida ni como condición
          warnings.push(`Fragmento no procesado: "${line.slice(0, 45)}..."`);
        }
      }
    }

    // Si no se encontró ninguna partida (ni con precio ni sin precio)
    if (rawItems.length === 0) {
      return {
        isValid: false,
        isDraft: false,
        hasWarnings: true,
        warnings: ["No se detectó ninguna partida de trabajo o instalación en el audio."],
        assistantFeedback: "❌ No he podido generar el presupuesto porque no detecté ninguna partida de obra. Por favor, indícame qué trabajos hay que realizar (ejemplo: 'cambiar plato de ducha y mampara').",
        data: null
      };
    }

    const hasPricedItems = rawItems.some(it => it.total > 0);
    const isDraft = !hasPricedItems;

    let assistantFeedback = "";
    if (isDraft) {
      assistantFeedback = `📋 He registrado tu visita técnica con ${rawItems.length} partida(s) guardadas (Borrador de medición):\n` +
        rawItems.map((it, i) => `• ${i + 1}. ${it.description} — [Pendiente de valorar]`).join("\n") +
        `\n\n👉 Ya tienes el borrador listo. Cuando quieras poner los precios, solo responde por voz o texto (ejemplo: "Ponle 400 al plato y 150 a la mampara").`;
    } else if (warnings.length > 0) {
      const pricedCount = rawItems.filter(it => !it.isPricePending).length;
      assistantFeedback = `⚠️ He generado el presupuesto con ${pricedCount} partida(s) valorada(s), pero he detectado estos detalles para tu revisión:\n` +
        warnings.map(w => `• ${w}`).join("\n") +
        `\n\n👉 Puedes enviar el presupuesto tal cual o mandarme otro audio para rellenar lo que falta (ejemplo: "Ponle 250 al alicatado").`;
    } else {
      assistantFeedback = `✅ ¡Presupuesto generado con éxito y sin incidencias! Todas las partidas e importes están perfectamente cuadrados.`;
    }

    return {
      isValid: true,
      isDraft,
      hasWarnings: warnings.length > 0 || isDraft,
      warnings,
      assistantFeedback,
      data: {
        clientName,
        clientAddress,
        items: rawItems
      }
    };
  }

  /**
   * Actualiza el precio de una partida existente a partir de un mensaje corto de WhatsApp
   * Ejemplo: "Ponle 250 al alicatado" o "La partida 2 son 300 euros"
   */
  static applyConversationalUpdate(items, updateText) {
    if (!items || items.length === 0 || !updateText) {
      return { success: false, message: "No hay partidas disponibles para actualizar." };
    }

    const priceRegex = /(?:por\s+|[:\s])?((?:\d+(?:[\.,]\d{1,2})?|\b(?:(?:mil|doscient[ao]s|trescient[ao]s|cuatrocient[ao]s|quinient[ao]s|seiscient[ao]s|setecient[ao]s|ochocient[ao]s|novecient[ao]s|cien|ciento|veinte|veinti[a-záéíóúñ]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|diez|once|doce|trece|catorce|quince|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\s*(?:y\s*)?)+))\s*(?:euros?|pavos|€)?\b/i;
    const priceMatch = updateText.match(priceRegex);

    if (!priceMatch) {
      return { success: false, message: "No detecté ningún importe en tu mensaje. Por favor indica una cifra (ejemplo: 'Ponle 250 al alicatado')." };
    }

    const newPrice = this.parsePriceString(priceMatch[1].trim());
    if (newPrice <= 0) {
      return { success: false, message: "El importe especificado debe ser superior a cero." };
    }

    // 1. Buscar coincidencia por número de partida (ej: "partida 2", "la 1", "segunda")
    const indexMatch = updateText.match(/(?:partida|l[ií]nea|la|n[uú]mero)\s*([0-9]+)/i);
    if (indexMatch) {
      const idx = parseInt(indexMatch[1], 10) - 1;
      if (items[idx]) {
        items[idx].unitPrice = newPrice;
        items[idx].total = Number((newPrice * items[idx].qty).toFixed(2));
        items[idx].isPricePending = false;
        return {
          success: true,
          updatedItem: items[idx],
          message: `✅ Partida ${idx + 1} actualizada: "${items[idx].description}" ahora tiene un importe de ${items[idx].total.toFixed(2)} €.`
        };
      }
    }

    // 2. Buscar por coincidencia semántica de palabras clave
    const lowerText = updateText.toLowerCase();
    let targetItem = null;

    // Priorizar partidas que estaban pendientes de valorar
    const candidates = items.filter(it => it.isPricePending).concat(items.filter(it => !it.isPricePending));

    for (const item of candidates) {
      const descWords = item.description.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      for (const word of descWords) {
        if (lowerText.includes(word) || lowerText.includes(word.slice(0, -1))) {
          targetItem = item;
          break;
        }
      }
      if (targetItem) break;
    }

    // Si aún no se encontró y solo hay 1 partida pendiente, asignárselo a esa
    if (!targetItem) {
      const pending = items.filter(it => it.isPricePending);
      if (pending.length === 1) {
        targetItem = pending[0];
      }
    }

    if (targetItem) {
      targetItem.unitPrice = newPrice;
      targetItem.total = Number((newPrice * targetItem.qty).toFixed(2));
      targetItem.isPricePending = false;
      return {
        success: true,
        updatedItem: targetItem,
        message: `✅ Partida actualizada: "${targetItem.description}" asignada a ${targetItem.total.toFixed(2)} €.`
      };
    }

    return {
      success: false,
      message: `He detectado el importe de ${newPrice} €, pero no estoy seguro de a qué partida te refieres. Por favor indícamelo con más claridad (ejemplo: 'Ponle ${newPrice} a la mampara' o 'Partida 2: ${newPrice}€').`
    };
  }
}
