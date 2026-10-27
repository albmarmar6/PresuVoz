/**
 * PresuVoz — Calculadora Técnica Multigremio de Cubicaje, Materiales y Mermas
 *
 * Calcula las cantidades exactas de material principal, % de merma profesional
 * (desperdicio por cortes, roturas, solapes o cocas) y materiales auxiliares
 * para todos los oficios y procesos de construcción en una vivienda:
 *
 *  1. Alicatados, Solados, Azulejos, Gres, Porcelánico y Gresite (tiling)
 *  2. Pintura, Alisados, Esmaltes, Fachadas y Microcemento (painting / microcement)
 *  3. Rodapiés, Zócalos, Molduras y Cornisas (skirting)
 *  4. Suelos Laminados, Tarima Flotante, Vinílico SPC, Parquet y Deck Exterior (flooring)
 *  5. Pladur / Cartón Yeso: Tabiques, Trasdosados y Falsos Techos (drywall_pladur)
 *  6. Fábrica de Ladrillo, Termoarcilla y Bloque de Hormigón (brickwork)
 *  7. Soleras, Recrecidos de Mortero, Autonivelante y Hormigón Armado (concrete_screed)
 *  8. Enfoscados, Guarnecidos de Yeso, Perlita y Monocapa (plaster_render)
 *  9. Fontanería (AF/ACS), Saneamiento PVC y Suelo Radiante (plumbing / underfloor_heating)
 * 10. Electricidad (REBT ITC-BT-25), Tubo Corrugado, Mecanismos e Iluminación (electrical)
 * 11. Climatización (Splits / Frigorías / Línea Frigorífica) y Radiadores (hvac)
 * 12. Impermeabilización (Tela Asfáltica, EPDM, Poliuretano), SATE y Tejados (waterproofing / sates / roofing)
 * 13. Carpintería (Ventanas, Puertas), Papel Pintado, Césped Artificial y Escombros (windows_doors / wallpaper / artificial_grass / demolition)
 *
 * REGLA DE ORO DE PRIORIDAD DE DATOS:
 *  - SIEMPRE mandan al 100% las medidas, alturas, distancias, rendimientos y mermas
 *    indicadas por el autónomo.
 *  - Los valores técnicos estándar (CTE / REBT / RITE / CYPE) solo se aplican como
 *    respaldo para los parámetros secundarios que el profesional no haya mencionado,
 *    y se detallan explícitamente en el desglose para que pueda ajustarlos al instante.
 */

function norm(str = '') {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fmtNum(n, maxDecimals = 2) {
  const val = Number(n) || 0;
  if (Number.isInteger(val)) return String(val);
  return val.toLocaleString('es-ES', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals
  });
}

function parseSpanishNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim().replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const WORD_NUMBERS = {
  un: 1, uno: 1, una: 1,
  dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, quince: 15, veinte: 20
};

function parseWordOrDigit(val) {
  if (val === null || val === undefined) return null;
  const clean = norm(val);
  if (WORD_NUMBERS[clean] !== undefined) return WORD_NUMBERS[clean];
  return parseSpanishNumber(clean);
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR DETERMINÍSTICO Y EXTRACTOR DE PARÁMETROS DESDE TEXTO / VOZ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detecta si un mensaje del autónomo es una consulta de cálculo de materiales / cubicaje
 * o un recálculo sobre el cálculo anterior ("ponle un 15% de merma", "con el techo a 2,80").
 *
 * @param {string} text - Mensaje del profesional
 * @param {object} [sessionContext] - { lastMaterialCalculation }
 * @returns {object|null} Parámetros extraídos o null si no es cálculo de materiales
 */
export function detectMaterialCalculationIntent(text = '', sessionContext = {}) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  const n = norm(raw);

  // Guardias de exclusión: si es un presupuesto con precios en euros, factura, cobro, cita o gasto
  const hasEuroPrices = /\b\d+(?:[.,]\d+)?\s*(?:€|euros?|pavos?)\b/i.test(raw);
  const isFinancialOrAdmin = /\b(?:factura|facturar|recibo|cobro|cobrar|me\s+ha\s+pagado|pagado|deuda|me\s+debe|trimestre|gestoria|cita\s+con|visita\s+con|agendar|nuevo\s+presupuesto|presupuesto\s+nuevo|cancela\s+el\s+presupuesto|marca\s+como\s+comprado|ya\s+compre|vaciar\s+lista)\b/i.test(n);

  if (hasEuroPrices || isFinancialOrAdmin) {
    return null;
  }

  // ¿Pide guardar el último cálculo directamente en la lista de la compra?
  if (sessionContext?.lastMaterialCalculation) {
    const isSaveToShopping = /\b(?:anadelo|añadelo|anadelos|añadelos|guardalo|guardalos|apuntalo|apuntalos|metelo|metelos|pasalo|pasalos)\b.*\b(?:lista\s+de\s+(?:la\s+)?compra|compras|materiales)\b/i.test(n)
      || /^(?:si\s*,?\s*)?(?:anadelo|añadelo|guardalo|apuntalo)(?:\s+a\s+la\s+lista(?:\s+de\s+la\s+compra)?)?(?:\s+(?:de|para)\s+(.+))?$/i.test(n);
    if (isSaveToShopping) {
      const clientMatch = raw.match(/\b(?:de\s+la\s+obra\s+de|para\s+la\s+obra\s+de|para|de)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ\s]{2,40})$/i);
      let clientName = clientMatch ? clientMatch[1].trim() : null;
      if (clientName && /^(?:la\s+compra|compras|mi\s+lista|almacen)$/i.test(norm(clientName))) {
        clientName = null;
      }
      return {
        isSaveLastCalculationToShopping: true,
        clientName: clientName || sessionContext.lastMaterialCalculation.clientName || null
      };
    }

    // ¿Pide incluir el último cálculo dentro del propio documento de presupuesto?
    const isAddToBudget = /\b(?:anadelo|añadelo|anadelos|añadelos|ponlo|ponlos|metelo|metelos|incluyelo|incluyelos|agregalo)\b.*\b(?:en\s+el\s+presupuesto|al\s+presupuesto)\b/i.test(n);
    if (isAddToBudget) {
      const clientMatch = raw.match(/\b(?:de\s+la\s+obra\s+de|del\s+presupuesto\s+de|para|de)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ0-9-\s]{2,40})$/i);
      let targetQuery = clientMatch ? clientMatch[1].trim() : null;
      if (targetQuery && /^(?:el\s+presupuesto|presupuesto|mi\s+presupuesto)$/i.test(norm(targetQuery))) {
        targetQuery = null;
      }
      return {
        isAddLastCalculationToBudget: true,
        targetQuery: targetQuery || sessionContext.lastMaterialCalculation.clientName || null
      };
    }

    // ¿Es un ajuste / recálculo sobre el cálculo recién hecho?
    // Ej: "recálculamelo con un 15% de merma", "y si el techo está a 2,80m?", "ponle 3 manos", "la subida de la ducha es a 1,25m y lavabo a 0,70m"
    const isFollowUpAdjustment = /^(?:y\s+si|recalcula(?:melo|lo)?|calculamelo\s+con|ponle|cambia(?:lo)?\s+a|con\s+(?:un|una|el|la|los|las)?|pero\s+con|que\s+la\s+subida|si\s+la\s+subida|si\s+el\s+techo|con\s+\d+)\b/i.test(n)
      || (/\b(?:merma|desperdicio|manos|capas|subida|bajada|techo|azulejo\s+de|formato\s+de|paso\s+de|distancia)\b/i.test(n) && raw.split(/\s+/).length <= 22);

    if (isFollowUpAdjustment) {
      const overrides = extractMaterialParameters(raw);
      const meaningfulKeys = Object.keys(overrides).filter(k => k !== 'rawText');
      if (meaningfulKeys.length > 0) {
        return {
          isRecalculation: true,
          tradeType: overrides.tradeType || sessionContext.lastMaterialCalculation.tradeType,
          params: {
            ...sessionContext.lastMaterialCalculation.params,
            ...overrides
          }
        };
      }
    }
  }

  // ¿Pide calcular los materiales de un presupuesto existente o activo?
  // Ej: "calcúlame los materiales del presupuesto de María", "cuánto material necesito para el presupuesto de Juan", "calcular materiales de este presupuesto"
  const isCalcFromBudget = /\b(?:calcula(?:me|r)?|sacame|dime|cubicaje\s+de|cubicar)\b.*\b(?:material(?:es)?|cubicaje|cantidades)\b.*\b(?:presupuesto|obra)\b/i.test(n)
    || /\b(?:cuanto\s+material|que\s+materiales)\s+necesito\s+para\s+(?:el\s+presupuesto|la\s+obra)\b/i.test(n)
    || /\b(?:materiales|cubicaje)\s+del\s+presupuesto\b/i.test(n);

  if (isCalcFromBudget) {
    const targetMatch = raw.match(/\b(?:presupuesto|obra)\s+(?:de\s+|del\s+|para\s+)?([a-záéíóúñA-ZÁÉÍÓÚÑ0-9-\s]{2,40}?)(?:\s+y\s+.*|\s*[?.!]*)$/i)
      || raw.match(/\b(PRE\d{4}-\d{3,4})\b/i);
    let targetQuery = targetMatch ? targetMatch[1].trim() : null;
    if (targetQuery && /^(?:este|esta|actual|activo|ultimo|el\s+ultimo|mi\s+cliente)$/i.test(norm(targetQuery))) {
      targetQuery = null;
    }
    const includeInBudgetPdf = /\b(?:pon(?:lo|los)?|metelo|incluye(?:lo)?|anade(?:lo)?|añade(?:lo)?)\s+(?:en\s+el|al)\s+presupuesto\b/i.test(n);
    return {
      isCalculateFromBudget: true,
      targetQuery,
      includeInBudgetPdf
    };
  }

  // Detectar intención explícita de cálculo de materiales / cubicaje
  const hasCalcTrigger = /\b(?:calcula(?:me|r)?|cubicaje|cubicar|cuant[oa]s?\s+(?:azulejos?|baldosas?|piezas?|cajas?|botes?|litros?|kilos?|kg|sacos?|placas?|ladrillos?|bloques?|tiras?|rodapies?|zocalos?|metros?|tubos?|tuberias?|cables?|rollos?|focos?|downlights?|elementos?|radiadores?|tejas?|contenedores?|sacas?|material(?:es)?|pintura|temple|esmalte|barniz|lasur)|cuanto\s+(?:material|temple|esmalte|barniz|lasur|hormigon|mortero|yeso|perlita|monocapa|cemento|pladur|cable|tubo|rodapie|aislamiento|cesped)|que\s+cantidad\s+de|necesito\s+para\s+(?:alicatar|solar|pintar|esmaltar|barnizar|lacar|poner|colocar|instalar|hacer|levantar|impermeabilizar|aislar|demoler|picar))\b/i.test(n);

  if (!hasCalcTrigger) {
    return null;
  }

  const extracted = extractMaterialParameters(raw);
  if (!extracted.tradeType) {
    return null;
  }

  return {
    isRecalculation: false,
    tradeType: extracted.tradeType,
    params: extracted
  };
}

/**
 * Extrae todos los parámetros técnicos expresados por el autónomo en lenguaje natural.
 * Respeta al 100% cualquier medida, cota, rendimiento o merma mencionada.
 */
export function extractMaterialParameters(rawText = '') {
  const text = String(rawText || '').trim();
  const n = norm(text);
  const params = { rawText: text };

  // 1. Detectar gremio / tipo de proceso constructivo
  if (/\b(?:suelo\s+radiante)\b/i.test(n)) {
    params.tradeType = 'underfloor_heating';
  } else if (/\b(?:microcemento)\b/i.test(n)) {
    params.tradeType = 'microcement';
  } else if (/\b(?:papel\s+pintado|empapelar)\b/i.test(n)) {
    params.tradeType = 'wallpaper';
  } else if (/\b(?:cesped\s+artificial)\b/i.test(n)) {
    params.tradeType = 'artificial_grass';
  } else if (/\b(?:escombro|escombros|demoler|demolicion|picar|contenedor(?:es)?|big\s*bag|sacas?\s+de\s+escombro)\b/i.test(n)) {
    params.tradeType = 'demolition';
  } else if (/\b(?:rodapie|rodapies|zocalo|zocalos|moldura|molduras|cornisa)\b/i.test(n) && !/\b(?:tarima|laminado|parquet)\b/i.test(n)) {
    params.tradeType = 'skirting';
  } else if (/\b(?:tarima|suelo\s+laminado|laminado|parquet|vinilico|spc|deck)\b/i.test(n)) {
    params.tradeType = 'flooring';
  } else if (/\b(?:escalera|peldanos?|huellas?|contrahuellas?|tabicas?)\b/i.test(n)) {
    params.tradeType = 'stairs';
  } else if (/\b(?:azulejo|azulejos|alicatar|alicatado|baldosa|baldosas|solado|solar|gres|porcelanico|gresite)\b/i.test(n)) {
    params.tradeType = 'tiling';
  } else if (/\b(?:pintura|pintar|botes?\s+de\s+pintura|manos?\s+de\s+pintura|esmalte|esmaltar|lacar|laca|temple|gotele|barniz|barnizar|lasur|silicato|acrilica|vinilica|latex|antihumedad|antimoho|epoxi)\b/i.test(n)) {
    params.tradeType = 'painting';
  } else if (/\b(?:pladur|carton\s+yeso|trasdosado|falso\s+techo|techo\s+registrable|montantes?|canales?)\b/i.test(n)) {
    params.tradeType = 'drywall_pladur';
  } else if (/\b(?:ladrillo|ladrillos|tabique\s+de\s+ladrillo|macheton|rasilla|gero|caravista|termoarcilla|bloque\s+de\s+hormigon|bloques\s+de\s+hormigon)\b/i.test(n)) {
    params.tradeType = 'brickwork';
  } else if (/\b(?:enfoscado|enfoscar|guarnecido|enlucido|enlucir|yeso|perlita|monocapa)\b/i.test(n)) {
    params.tradeType = 'plaster_render';
  } else if (/\b(?:hormigon|solera|recrecido|autonivelante|mortero|mallazo)\b/i.test(n)) {
    params.tradeType = 'concrete_screed';
  } else if (/\b(?:fontaneria|tuberia|tuberias|multicapa|pex|ppr|desague|desagues|saneamiento|inodoro|lavabo|ducha|fregadero|bide|colector)\b/i.test(n)) {
    params.tradeType = 'plumbing';
  } else if (/\b(?:electricidad|electrico|electrica|cable|cables|tubo\s+corrugado|corrugado|enchufe|enchufes|conmutador|interruptor|puntos?\s+de\s+luz|focos?|downlights?|cuadro\s+electrico)\b/i.test(n)) {
    params.tradeType = 'electrical';
  } else if (/\b(?:aire\s+acondicionado|climatizacion|split|splits|frigorias|linea\s+frigorifica|radiador|radiadores|calefaccion)\b/i.test(n)) {
    params.tradeType = 'hvac';
  } else if (/\b(?:tejado|teja|tejas|cubierta|cumbrera|caballete)\b/i.test(n)) {
    params.tradeType = 'roofing';
  } else if (/\b(?:impermeabilizar|impermeabilizacion|tela\s+asfaltica|epdm|membrana\s+de\s+poliuretano|caucho\s+impermeabilizante|sate|aislamiento|lana\s+de\s+roca|xps|copopren)\b/i.test(n)) {
    params.tradeType = 'waterproofing_insulation';
  } else if (/\b(?:ventana|ventanas|puerta\s+de\s+paso|puertas\s+de\s+paso|premarco|tapajuntas|espuma\s+de\s+poliuretano)\b/i.test(n)) {
    params.tradeType = 'windows_doors';
  }

  // 2. Extraer superficie en m² (ej: "20 m2", "20 metros cuadrados", "de 20m²")
  const areaMatch = n.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|m²|metros?\s+cuadrados?)\b/);
  if (areaMatch) {
    params.areaM2 = parseSpanishNumber(areaMatch[1]);
  }

  // 3. Extraer metros lineales si habla de rodapié, muro, tubería, zanja, valla (ej: "35 metros lineales", "35 ml", "24 metros de rodapié")
  const mlMatch = n.match(/(\d+(?:[.,]\d+)?)\s*(?:ml|m\.l\.|metros?\s+lineales?)\b/)
    || (params.tradeType === 'skirting' && n.match(/(\d+(?:[.,]\d+)?)\s*metros?\b(?!\s*cuadrados?)/));
  if (mlMatch) {
    params.linearMeters = parseSpanishNumber(mlMatch[1]);
  }

  // 4. Extraer formato de pieza en cm o mm (ej: "15x15 cm", "15 por 15", "60x120", "30 x 60 cm", "azulejo de 20x60")
  const formatMatch = n.match(/(?:azulejos?|baldosas?|piezas?|formato|placas?|ladrillos?|bloques?|tejas?)?\s*(?:de\s+)?(\d+(?:[.,]\d+)?)\s*(?:cm|mm|m)?\s*(?:x|×|por)\s*(\d+(?:[.,]\d+)?)\s*(cm|mm|m)?\b/);
  if (formatMatch) {
    let w = parseSpanishNumber(formatMatch[1]);
    let l = parseSpanishNumber(formatMatch[2]);
    const unit = formatMatch[3] || '';

    // Distinguir si el "AxB" es la medida de la habitación (ej: "cocina de 4x5 metros") o la pieza ("azulejo de 15x15 cm")
    const beforeFormat = n.slice(Math.max(0, formatMatch.index - 35), formatMatch.index);
    const isRoomDim = /\b(?:cocina|bano|habitacion|salon|dormitorio|estancia|pared|muro|tabique|techo|solera|fachada|terraza|patio)\s+(?:de\s+)?$/.test(beforeFormat)
      && (unit === 'm' || (w <= 12 && l <= 15 && unit !== 'cm' && unit !== 'mm'));

    if (isRoomDim) {
      params.roomLengthM = w;
      params.roomWidthM = l;
      if (!params.areaM2) {
        params.areaM2 = round2(w * l);
      }
    } else if (w && l) {
      if (unit === 'mm') {
        w = w / 10;
        l = l / 10;
      } else if (unit === 'm' || (w < 4 && l < 4 && (String(formatMatch[1]).includes(',') || String(formatMatch[1]).includes('.')))) {
        w = w * 100;
        l = l * 100;
      }
      params.pieceWidthCm = w;
      params.pieceLengthCm = l;
    }
  }

  // Si hay un segundo "AxB" en la frase (ej: "cocina de 4x5 m con azulejo de 15x15 cm")
  const allDimMatches = [...n.matchAll(/(\d+(?:[.,]\d+)?)\s*(cm|mm|m)?\s*(?:x|×|por)\s*(\d+(?:[.,]\d+)?)\s*(cm|mm|m)?/g)];
  if (allDimMatches.length >= 2) {
    for (const m of allDimMatches) {
      const v1 = parseSpanishNumber(m[1]);
      const v2 = parseSpanishNumber(m[3]);
      const u = m[4] || m[2] || '';
      if (u === 'cm' || (v1 >= 10 && v2 >= 10 && v1 <= 240 && v2 <= 240)) {
        params.pieceWidthCm = v1;
        params.pieceLengthCm = v2;
      } else if (u === 'm' || (v1 <= 15 && v2 <= 15)) {
        params.roomLengthM = v1;
        params.roomWidthM = v2;
        if (!params.areaM2) params.areaM2 = round2(v1 * v2);
      }
    }
  }

  // 4b. Extraer expresiones del tipo "5 metros de largo por 2,60 de alto/ancho"
  const largoAnchoMatch = n.match(/(\d+(?:[.,]\d+)?)\s*(?:m|metros?)?\s+de\s+(?:largo|ancho)\s+por\s+(\d+(?:[.,]\d+)?)\s*(?:m|metros?)?\s+de\s+(alto|ancho|largo)/i);
  if (largoAnchoMatch) {
    const d1 = parseSpanishNumber(largoAnchoMatch[1]);
    const d2 = parseSpanishNumber(largoAnchoMatch[2]);
    const kind2 = largoAnchoMatch[3];
    if (d1 && d2) {
      if (kind2 === 'alto') {
        params.linearMeters = d1;
        params.ceilingHeightM = d2;
      } else {
        params.roomLengthM = d1;
        params.roomWidthM = d2;
      }
      if (!params.areaM2) {
        params.areaM2 = round2(d1 * d2);
      }
    }
  }

  // 4c. Parámetros de Escalera (peldaños, huellas, tabicas, ancho de escalera, altura a salvar)
  if (params.tradeType === 'stairs') {
    const stepsMatch = n.match(/(\d+)\s*(?:peldanos?|escalones?|huellas?)\b/);
    if (stepsMatch) {
      params.stepsCount = parseInt(stepsMatch[1], 10);
    }
    const stairWidthMatch = n.match(/ancho\s+(?:de\s+(?:escalera\s+)?)?(?:de\s+)?(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)\b/);
    if (stairWidthMatch) {
      let sw = parseSpanishNumber(stairWidthMatch[1]);
      if (stairWidthMatch[2] === 'cm' || sw > 5) sw = sw / 100;
      params.stairWidthM = sw;
    }
  }

  // 5. Extraer % de merma / desperdicio explícito (ej: "15% de merma", "con un 12% de desperdicio", "merma del 8%")
  const wasteMatch = n.match(/(?:merma|desperdicio|margen|holgura|extra)\s+(?:de(?:l)?\s+)?(\d+(?:[.,]\d+)?)\s*%/)
    || n.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de\s+)?(?:merma|desperdicio|margen|holgura|cortes|roturas)/);
  if (wasteMatch) {
    params.wastePct = parseSpanishNumber(wasteMatch[1]);
  } else if (/\b(?:espiga|diagonal|rombo| Cartab[oó]n)\b/i.test(n)) {
    params.placementPattern = 'espiga / diagonal';
    params.wastePct = 15;
  } else if (/\b(?:trabado|matajunta|tercio)\b/i.test(n)) {
    params.placementPattern = 'trabado / matajunta';
    params.wastePct = 12;
  }

  // 6. Extraer altura de techo o pared (ej: "techo a 2,80 m", "altura de 2,60 metros", "alto de 2,70")
  const heightMatch = n.match(/(?:techo\s+(?:a|de)|altura\s+(?:de\s+techo\s+)?(?:a|de)?|alto\s+(?:de)?)\s*(\d+(?:[.,]\d+)?)\s*(?:m|metros?)?\b/);
  if (heightMatch) {
    params.ceilingHeightM = parseSpanishNumber(heightMatch[1]);
  }

  // 7. Parámetros de Pintura: subtipo de pintura, nº de manos, rendimiento (m²/L), tamaño de bote
  if (params.tradeType === 'painting') {
    if (/\b(?:temple\s+picado|gotele|gota)\b/i.test(n)) {
      params.paintSubtype = 'temple_picado';
    } else if (/\btemple\b/i.test(n)) {
      params.paintSubtype = 'temple_liso';
    } else if (/\b(?:esmalte\s+sintetico|sintetico)\b/i.test(n)) {
      params.paintSubtype = 'esmalte_sintetico';
    } else if (/\b(?:esmalte|esmaltar|laca|lacar)\b/i.test(n)) {
      params.paintSubtype = 'esmalte_agua';
    } else if (/\b(?:barniz|barnizar|lasur)\b/i.test(n)) {
      params.paintSubtype = 'barniz_lasur';
    } else if (/\b(?:epoxi|poliuretano\s+suelo|pintura\s+de\s+suelo)\b/i.test(n)) {
      params.paintSubtype = 'epoxi_suelos';
    } else if (/\b(?:silicato|mineral)\b/i.test(n)) {
      params.paintSubtype = 'silicato';
    } else if (/\b(?:a\s+la\s+cal|cal\s+aerea)\b/i.test(n)) {
      params.paintSubtype = 'cal';
    } else if (/\b(?:ecologica|ecologico|vegana|sin\s+cov|zero\s+voc|natural)\b/i.test(n)) {
      params.paintSubtype = 'ecologica';
    } else if (/\b(?:antihumedad|antimoho|anticondensacion|antimanchas)\b/i.test(n)) {
      params.paintSubtype = 'antihumedad';
    } else if (/\b(?:revestimiento\s+petreo|revestimiento\s+elastico|fachada|fachadas)\b/i.test(n)) {
      params.paintSubtype = 'fachadas_revestimiento';
    } else if (/\bvinilica|vinilico\b/i.test(n)) {
      params.paintSubtype = 'vinilica';
    } else if (/\bacrilica|acrilico\b/i.test(n)) {
      params.paintSubtype = 'acrilica';
    } else if (/\blatex\b/i.test(n)) {
      params.paintSubtype = 'latex';
    } else {
      params.paintSubtype = 'plastica';
    }
  }
  const coatsMatch = n.match(/(\d+|un|una|dos|tres|cuatro)\s*(?:manos?|capas?)\b/);
  if (coatsMatch) {
    params.coats = parseWordOrDigit(coatsMatch[1]);
  }
  const yieldMatch = n.match(/(?:rinde|rendimiento\s+(?:de)?|cubre)\s*(\d+(?:[.,]\d+)?)\s*(?:m2|m²|metros?)\s*(?:por\s+|\/\s*)?(?:litro|l)\b/)
    || n.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|m²)\s*\/\s*l\b/);
  if (yieldMatch) {
    params.yieldM2PerLiter = parseSpanishNumber(yieldMatch[1]);
  }
  const bucketMatch = n.match(/botes?\s+de\s+(\d+(?:[.,]\d+)?)\s*(?:l|litros?)\b/);
  if (bucketMatch) {
    params.bucketSizeLiters = parseSpanishNumber(bucketMatch[1]);
  }

  // 8. Parámetros de Azulejo / Solado / Tarima: ancho de junta (mm), m² por caja, largo de tira de rodapié
  const jointMatch = n.match(/junta\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*(?:mm|milimetros?)\b/);
  if (jointMatch) {
    params.jointWidthMm = parseSpanishNumber(jointMatch[1]);
  }
  const boxMatch = n.match(/cajas?\s+de\s+(\d+(?:[.,]\d+)?)\s*(?:m2|m²|metros?)\b/);
  if (boxMatch) {
    params.boxAreaM2 = parseSpanishNumber(boxMatch[1]);
  }
  const stripMatch = n.match(/(?:tiras?|piezas?|barras?|listones?)\s+de\s+(\d+(?:[.,]\d+)?)\s*(?:m|metros?|cm)\b/);
  if (stripMatch) {
    let val = parseSpanishNumber(stripMatch[1]);
    if (val > 20) val = val / 100; // si puso 240 cm -> 2.40 m
    params.stripLengthM = val;
  }
  const doorsMatch = n.match(/(\d+|una|dos|tres|cuatro|cinco|seis|siete|ocho)\s*puertas?\b/);
  if (doorsMatch) {
    params.doorsCount = parseWordOrDigit(doorsMatch[1]);
  }
  const windowsMatch = n.match(/(\d+|una|dos|tres|cuatro|cinco|seis|siete|ocho)\s*ventanas?\b/);
  if (windowsMatch) {
    params.windowsCount = parseWordOrDigit(windowsMatch[1]);
  }

  // 9. Parámetros de Pladur: tipo (tabique, trasdosado, falso techo), doble placa, distancia montantes
  if (params.tradeType === 'drywall_pladur') {
    if (/\b(?:falso\s+techo|techo)\b/i.test(n)) {
      params.pladurSystem = /\bregistrable\b/i.test(n) ? 'techo_registrable' : 'techo_continuo';
    } else if (/\btrasdosado\b/i.test(n)) {
      params.pladurSystem = 'trasdosado';
    } else {
      params.pladurSystem = 'tabique';
    }
    if (/\bdoble\s+placa\b/i.test(n)) {
      params.doubleBoard = true;
    }
    const studSpacingMatch = n.match(/(?:montantes?\s+(?:cada|a)|cada)\s*(40|60)\s*(?:cm)?\b/);
    if (studSpacingMatch) {
      params.studSpacingCm = parseInt(studSpacingMatch[1], 10);
    }
  }

  // 10. Parámetros de Ladrillo / Mortero / Hormigón: tipo de ladrillo, espesor en cm/mm
  if (params.tradeType === 'brickwork') {
    if (/\b(?:hueco\s+sencillo|lhs)\b/i.test(n)) params.brickType = 'hueco_sencillo';
    else if (/\b(?:rasilla|bardo)\b/i.test(n)) params.brickType = 'rasilla';
    else if (/\b(?:perforado|gero|caravista)\b/i.test(n)) params.brickType = 'perforado';
    else if (/\b(?:termoarcilla)\b/i.test(n)) params.brickType = 'termoarcilla';
    else if (/\b(?:gran\s+formato|tabicon)\b/i.test(n)) params.brickType = 'gran_formato';
    else if (/\b(?:bloque\s+de\s+hormigon|bloques)\b/i.test(n)) params.brickType = 'bloque_hormigon';
    else params.brickType = 'hueco_doble';
  }

  const thicknessCmMatch = n.match(/(?:espesor|grosor|capa|recrecido|solera)\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*cm\b/)
    || n.match(/(\d+(?:[.,]\d+)?)\s*cm\s+de\s+(?:espesor|grosor|hormigon|mortero|recrecido|solera)\b/);
  if (thicknessCmMatch) {
    params.thicknessCm = parseSpanishNumber(thicknessCmMatch[1]);
  }
  const thicknessMmMatch = n.match(/(?:espesor|grosor|capa|autonivelante)\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*mm\b/)
    || n.match(/(\d+(?:[.,]\d+)?)\s*mm\s+de\s+(?:espesor|grosor|autonivelante)\b/);
  if (thicknessMmMatch) {
    params.thicknessCm = parseSpanishNumber(thicknessMmMatch[1]) / 10;
  }

  // 11. Parámetros de Fontanería: distancias, cotas de subida/bajada personalizadas, aparatos
  const distGeneralMatch = n.match(/(?:a\s+)?(\d+(?:[.,]\d+)?)\s*(?:m|metros?)\s+de\s+(?:la\s+)?(?:general|bajante|entrada|colector|montante|toma\s+principal)/i)
    || n.match(/(?:general|bajante|entrada|colector)\s+(?:esta\s+)?a\s+(\d+(?:[.,]\d+)?)\s*(?:m|metros?)/i)
    || n.match(/distancia\s+(?:media\s+)?(?:de\s+)?(\d+(?:[.,]\d+)?)\s*(?:m|metros?)/i);
  if (distGeneralMatch) {
    params.pipeDistanceM = parseSpanishNumber(distGeneralMatch[1]);
  }

  // Cotas verticales personalizadas del fontanero (¡Prioridad absoluta!)
  const riserLavaboMatch = n.match(/(?:subida|bajada|altura|toma)\s+(?:de(?:l)?\s+)?lavabo\s+(?:es\s+a|es\s+de|esta\s+a|a|de)?\s*(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)?/i)
    || n.match(/lavabo\s+(?:es\s+a|esta\s+a|a)\s+(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)\b/i);
  if (riserLavaboMatch) {
    let v = parseSpanishNumber(riserLavaboMatch[1]);
    if (riserLavaboMatch[2] === 'cm' || v > 5) v = v / 100;
    params.riserLavaboM = v;
  }

  const riserDuchaMatch = n.match(/(?:subida|bajada|altura|toma|griferia)\s+(?:de\s+(?:la\s+)?)?ducha\s+(?:es\s+a|es\s+de|esta\s+a|a|de)?\s*(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)?/i)
    || n.match(/ducha\s+(?:es\s+a|esta\s+a|a)\s+(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)\b/i);
  if (riserDuchaMatch) {
    let v = parseSpanishNumber(riserDuchaMatch[1]);
    if (riserDuchaMatch[2] === 'cm' || v > 5) v = v / 100;
    params.riserDuchaM = v;
  }

  const riserInodoroMatch = n.match(/(?:subida|bajada|altura|toma)\s+(?:de(?:l)?\s+)?(?:inodoro|wc|water)\s+(?:es\s+a|es\s+de|esta\s+a|a|de)?\s*(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)?/i)
    || n.match(/(?:inodoro|wc)\s+(?:es\s+a|esta\s+a|a)\s+(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)\b/i);
  if (riserInodoroMatch) {
    let v = parseSpanishNumber(riserInodoroMatch[1]);
    if (riserInodoroMatch[2] === 'cm' || v > 5) v = v / 100;
    params.riserInodoroM = v;
  }

  const riserFregaderoMatch = n.match(/(?:subida|bajada|altura|toma)\s+(?:de(?:l)?\s+)?fregadero\s+(?:es\s+a|es\s+de|esta\s+a|a|de)?\s*(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)?/i)
    || n.match(/fregadero\s+(?:es\s+a|esta\s+a|a)\s+(\d+(?:[.,]\d+)?)\s*(cm|m|metros?)\b/i);
  if (riserFregaderoMatch) {
    let v = parseSpanishNumber(riserFregaderoMatch[1]);
    if (riserFregaderoMatch[2] === 'cm' || v > 5) v = v / 100;
    params.riserFregaderoM = v;
  }

  // Aparatos sanitarios mencionados
  if (/\blavabos?\b/i.test(n)) {
    const m = n.match(/(\d+|un|uno|dos|tres|cuatro)\s+lavabos?\b/);
    params.lavaboCount = m ? parseWordOrDigit(m[1]) : 1;
  }
  if (/\b(?:inodoros?|wc|water|tazas?)\b/i.test(n)) {
    const m = n.match(/(\d+|un|uno|dos|tres|cuatro)\s+(?:inodoros?|wc|water|tazas?)\b/);
    params.inodoroCount = m ? parseWordOrDigit(m[1]) : 1;
  }
  if (/\b(?:duchas?|platos?\s+de\s+ducha|baneras?)\b/i.test(n)) {
    const m = n.match(/(\d+|un|una|dos|tres|cuatro)\s+(?:duchas?|platos?\s+de\s+ducha|baneras?)\b/);
    params.duchaCount = m ? parseWordOrDigit(m[1]) : 1;
  }
  if (/\bbides?\b/i.test(n)) {
    const m = n.match(/(\d+|un|uno|dos|tres)\s+bides?\b/);
    params.bideCount = m ? parseWordOrDigit(m[1]) : 1;
  }
  if (/\bfregaderos?\b/i.test(n)) {
    const m = n.match(/(\d+|un|uno|dos)\s+fregaderos?\b/);
    params.fregaderoCount = m ? parseWordOrDigit(m[1]) : 1;
  }
  if (/\blavadoras?\b/i.test(n)) {
    params.lavadoraCount = 1;
  }
  if (/\blavavajillas\b/i.test(n)) {
    params.lavavajillasCount = 1;
  }
  if (/\b(?:termo|caldera|calentador)\b/i.test(n)) {
    params.termoCount = 1;
  }

  // Suelo radiante: paso entre tubos
  const pitchMatch = n.match(/paso\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*cm\b/)
    || n.match(/cada\s+(\d+(?:[.,]\d+)?)\s*cm\b/);
  if (pitchMatch && params.tradeType === 'underfloor_heating') {
    params.pipePitchCm = parseSpanishNumber(pitchMatch[1]);
  }

  // 12. Parámetros de Electricidad: enchufes, puntos de luz, interruptores, conmutadores, distancia a caja/cuadro
  const socketsMatch = n.match(/(\d+|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|quince|veinte)\s*(?:enchufes?|tomas?\s+de\s+corriente|schukos?)\b/);
  if (socketsMatch) {
    params.socketsCount = parseWordOrDigit(socketsMatch[1]);
  }
  const lightsMatch = n.match(/(\d+|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|diez|doce)\s*(?:puntos?\s+de\s+luz|focos?|downlights?|lamparas?)\b/);
  if (lightsMatch) {
    params.lightsCount = parseWordOrDigit(lightsMatch[1]);
  }
  const switchesMatch = n.match(/(\d+|un|uno|dos|tres|cuatro|cinco|seis)\s*(?:interruptores?|conmutadores?|cruzamientos?|mecanismos?)\b/);
  if (switchesMatch) {
    params.switchesCount = parseWordOrDigit(switchesMatch[1]);
  }
  const distBoxMatch = n.match(/(?:a\s+)?(\d+(?:[.,]\d+)?)\s*(?:m|metros?)\s+de\s+(?:la\s+)?(?:caja(?:\s+de\s+registro)?|cuadro(?:\s+electrico)?)/i)
    || n.match(/(?:caja|cuadro)\s+(?:esta\s+)?a\s+(\d+(?:[.,]\d+)?)\s*(?:m|metros?)/i);
  if (distBoxMatch) {
    params.boxDistanceM = parseSpanishNumber(distBoxMatch[1]);
  }

  // 13. Parámetros de Climatización / Radiadores
  if (params.tradeType === 'hvac') {
    if (/\bradiador(?:es)?\b/i.test(n)) {
      params.hvacSubtype = 'radiators';
    } else {
      params.hvacSubtype = 'split';
    }
    const lineMatch = n.match(/(\d+(?:[.,]\d+)?)\s*(?:m|metros?)\s+de\s+(?:linea|tuberia|cobre|distancia)/i)
      || n.match(/a\s+(\d+(?:[.,]\d+)?)\s*(?:m|metros?)\s+(?:de(?:l)?\s+)?(?:compresor|unidad\s+exterior|maquina\s+exterior)/i);
    if (lineMatch) {
      params.refrigerantLineM = parseSpanishNumber(lineMatch[1]);
    }
    const fgPerM2Match = n.match(/(\d+)\s*frigorias\s*(?:por\s+|\/\s*)(?:m2|m²|metro)/i);
    if (fgPerM2Match) {
      params.frigoriasPerM2 = parseInt(fgPerM2Match[1], 10);
    }
  }

  // 14. Cliente opcional si dice "para la obra de Juan" o "para María"
  const clientMatch = text.match(/\b(?:para\s+la\s+obra\s+de|en\s+la\s+obra\s+de|del?\s+cliente)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){0,2})/i);
  if (clientMatch) {
    params.clientName = clientMatch[1].trim();
  }

  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// MOTORES DE CÁLCULO MATEMÁTICO POR OFICIO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1. ALICATADOS, SOLADOS, AZULEJOS, GRES Y PORCELÁNICO
 */
function calculateTiling(params = {}) {
  const areaNet = Number(params.areaM2) || 20;
  const pieceW = Number(params.pieceWidthCm) || 30;
  const pieceL = Number(params.pieceLengthCm) || 60;
  const wastePct = params.wastePct !== undefined && params.wastePct !== null ? Number(params.wastePct) : 10;
  const jointMm = Number(params.jointWidthMm) || 2;
  const thicknessMm = Number(params.tileThicknessMm) || 9;
  const boxAreaM2 = Number(params.boxAreaM2) || 1.44;

  const pieceAreaM2 = (pieceW / 100) * (pieceL / 100);
  const netPieces = Math.ceil(areaNet / pieceAreaM2);
  const totalAreaWithWaste = round2(areaNet * (1 + wastePct / 100));
  const totalPiecesWithWaste = Math.ceil(totalAreaWithWaste / pieceAreaM2);
  const boxesNeeded = Math.ceil(totalAreaWithWaste / boxAreaM2);

  // Cemento cola: simple encolado (4 kg/m²) si pieza < 900 cm²; doble encolado (6 kg/m²) si >= 900 cm² (ej. 30x30 o superior)
  const pieceAreaCm2 = pieceW * pieceL;
  const isDoubleGluing = params.adhesiveKgPerM2 ? false : pieceAreaCm2 >= 900;
  const adhesiveRateKgM2 = Number(params.adhesiveKgPerM2) || (isDoubleGluing ? 6 : 4);
  const totalAdhesiveKg = Math.ceil(totalAreaWithWaste * adhesiveRateKgM2);
  const adhesiveBags25Kg = Math.ceil(totalAdhesiveKg / 25);

  // Mortero de juntas (borada/lechada): fórmula técnica ((L+W)/(L*W)) * espesor * junta * 1.6
  const lMm = pieceL * 10;
  const wMm = pieceW * 10;
  const groutRateKgM2 = round2(((lMm + wMm) / (lMm * wMm)) * thicknessMm * jointMm * 1.6 * 1.10);
  const totalGroutKg = round1(Math.max(1.5, totalAreaWithWaste * groutRateKgM2));
  const groutBags5Kg = Math.ceil(totalGroutKg / 5);

  // Crucetas / calzos de nivelación (~4 por baldosa)
  const levelingClips = Math.ceil((netPieces * 4) / 100) * 100;

  const shoppingItems = [
    {
      description: `Azulejo / Baldosa ${pieceW}x${pieceL} cm (${totalPiecesWithWaste} piezas / ~${boxesNeeded} cajas de ${fmtNum(boxAreaM2)} m²)`,
      qty: totalAreaWithWaste,
      unit: 'm²'
    },
    {
      description: `Sacos de 25 kg de cemento cola C2TE (${totalAdhesiveKg} kg totales)`,
      qty: adhesiveBags25Kg,
      unit: 'ud'
    },
    {
      description: `Sacos de 5 kg de mortero de juntas / borada (${fmtNum(totalGroutKg, 1)} kg totales, junta ${jointMm} mm)`,
      qty: groutBags5Kg,
      unit: 'ud'
    },
    {
      description: `Crucetas / calzos de nivelación (${levelingClips} uds)`,
      qty: Math.ceil(levelingClips / 200),
      unit: 'ud'
    }
  ];

  const assumptions = [
    `Superficie base: *${fmtNum(areaNet)} m²*`,
    `Formato de pieza: *${fmtNum(pieceW)} × ${fmtNum(pieceL)} cm* (${fmtNum(pieceAreaM2, 4)} m²/pieza)`,
    `Merma aplicada por cortes y roturas: *+${fmtNum(wastePct)}%*${params.placementPattern ? ` (${params.placementPattern})` : ' (colocación estándar)'}`,
    `Rendimiento cemento cola: *${fmtNum(adhesiveRateKgM2)} kg/m²* (${isDoubleGluing ? 'doble encolado recomendado por formato' : 'encolado simple'})`,
    `Junta de colocación: *${fmtNum(jointMm)} mm* (espesor pieza ${thicknessMm} mm)`
  ];

  return {
    title: '📐 *CÁLCULO DE MATERIALES — ALICATADO / SOLADO*',
    tradeType: 'tiling',
    summaryLines: [
      `🔹 *Superficie neta:* ${fmtNum(areaNet)} m² (${netPieces} piezas exactas)`,
      `🔹 *Total a comprar (+${fmtNum(wastePct)}% merma):* *${fmtNum(totalAreaWithWaste)} m²* → *${totalPiecesWithWaste} azulejos/piezas* (aprox. *${boxesNeeded} cajas* de ${fmtNum(boxAreaM2)} m²)`,
      `   _(Incluye *${totalPiecesWithWaste - netPieces} piezas extra* de margen para recortes, ingletes y posibles roturas)_`
    ],
    auxLines: [
      `🧱 *Cemento cola (Adhesivo C2TE):* *${adhesiveBags25Kg} sacos de 25 kg* (${totalAdhesiveKg} kg en total)`,
      `🪣 *Mortero de juntas / Borada:* *${groutBags5Kg} bolsa(s) de 5 kg* (${fmtNum(totalGroutKg, 1)} kg para junta de ${fmtNum(jointMm)} mm)`,
      `➕ *Crucetas / Calzos nivelación:* *${levelingClips} uds* (${Math.ceil(levelingClips / 200)} bolsas de 200 uds)`
    ],
    assumptions,
    shoppingItems
  };
}

/**
 * 2. PINTURA DE PAREDES, TECHOS, FACHADAS, TEMPLE, ESMALTES Y BARNICES
 * Reconoce todos los tipos de pintura de vivienda con sus rendimientos técnicos reales,
 * formatos de envase comerciales e imprimaciones específicas.
 */
const PAINT_SPECS_CATALOG = {
  plastica: {
    label: 'Pintura plástica mate/satinada lavable',
    defaultYieldM2PerL: 10,
    defaultCoats: 2,
    primerLabel: 'Imprimación / Fijador sellador acrílico al agua',
    primerYieldM2PerL: 11,
    containerType: 'buckets_15_4'
  },
  latex: {
    label: 'Pintura al látex (alta resistencia y lavabilidad)',
    defaultYieldM2PerL: 10,
    defaultCoats: 2,
    primerLabel: 'Fijador sellador al agua para látex',
    primerYieldM2PerL: 11,
    containerType: 'buckets_15_4'
  },
  acrilica: {
    label: 'Pintura 100% acrílica (alta impermeabilidad y cubrición)',
    defaultYieldM2PerL: 9.5,
    defaultCoats: 2,
    primerLabel: 'Fijador acrílico penetrante al agua',
    primerYieldM2PerL: 10,
    containerType: 'buckets_15_4'
  },
  vinilica: {
    label: 'Pintura vinílica sedosa (alta extensibilidad y lavabilidad)',
    defaultYieldM2PerL: 11.5,
    defaultCoats: 2,
    primerLabel: 'Imprimación fijadora universal al agua',
    primerYieldM2PerL: 12,
    containerType: 'buckets_15_4'
  },
  ecologica: {
    label: 'Pintura ecológica / natural sin COV (0% disolventes)',
    defaultYieldM2PerL: 10.5,
    defaultCoats: 2,
    primerLabel: 'Imprimación ecológica transpirable 0% COV',
    primerYieldM2PerL: 11,
    containerType: 'buckets_15_4'
  },
  silicato: {
    label: 'Pintura mineral al silicato (transpirable pétrea)',
    defaultYieldM2PerL: 7.5,
    defaultCoats: 2,
    primerLabel: 'Fijador mineral al silicato de potasio',
    primerYieldM2PerL: 8,
    containerType: 'buckets_15_4'
  },
  cal: {
    label: 'Pintura mineral a la cal (transpirable y fungicida natural)',
    defaultYieldM2PerL: 7.5,
    defaultCoats: 2,
    primerLabel: 'Imprimación mineral fijadora para cal',
    primerYieldM2PerL: 8,
    containerType: 'buckets_15_4'
  },
  antihumedad: {
    label: 'Pintura técnica antihumedad / antimoho / anticondensación',
    defaultYieldM2PerL: 8,
    defaultCoats: 2,
    primerLabel: 'Limpiador fungicida + fijador bloqueador de manchas',
    primerYieldM2PerL: 10,
    containerType: 'buckets_15_4'
  },
  fachadas_revestimiento: {
    label: 'Revestimiento pétreo / elástico impermeabilizante de fachadas',
    defaultYieldM2PerL: 5.5,
    defaultCoats: 2,
    primerLabel: 'Fijador sellador de fachadas al siloxano/acrílico',
    primerYieldM2PerL: 9,
    containerType: 'buckets_15_4'
  },
  esmalte_agua: {
    label: 'Esmalte acrílico al agua / Laca de poliuretano',
    defaultYieldM2PerL: 12,
    defaultCoats: 2,
    primerLabel: 'Imprimación multiadherente todoterreno al agua',
    primerYieldM2PerL: 12,
    containerType: 'cans_4_075'
  },
  esmalte_sintetico: {
    label: 'Esmalte sintético al disolvente (madera / metal)',
    defaultYieldM2PerL: 13,
    defaultCoats: 2,
    primerLabel: 'Imprimación antioxidante / selladora sintética + aguarrás',
    primerYieldM2PerL: 12,
    containerType: 'cans_4_075'
  },
  barniz_lasur: {
    label: 'Barniz / Lasur protector a poro abierto para madera',
    defaultYieldM2PerL: 13,
    defaultCoats: 2,
    primerLabel: 'Fondo protector insecticida/fungicida para madera',
    primerYieldM2PerL: 12,
    containerType: 'cans_4_075'
  },
  epoxi_suelos: {
    label: 'Pintura Epoxi / Poliuretano bicomponente de alta resistencia',
    defaultYieldM2PerL: 7.5,
    defaultCoats: 2,
    primerLabel: 'Imprimación epoxi bicomponente de adherencia',
    primerYieldM2PerL: 8,
    containerType: 'buckets_15_4'
  },
  temple_liso: {
    label: 'Pintura al temple liso (en pasta/polvo)',
    defaultKgPerM2Coat: 0.40,
    defaultCoats: 2,
    bagWeightKg: 25,
    containerType: 'temple_bags'
  },
  temple_picado: {
    label: 'Pasta al temple para picado / gotelé',
    defaultKgPerM2Coat: 1.10,
    defaultCoats: 1,
    bagWeightKg: 25,
    containerType: 'temple_bags'
  }
};

function calculatePainting(params = {}) {
  let areaM2 = Number(params.areaM2) || 0;
  let areaNote = 'superficie directa de paramentos';

  if (!areaM2 && params.roomLengthM && params.roomWidthM) {
    const h = Number(params.ceilingHeightM) || 2.50;
    const walls = 2 * (Number(params.roomLengthM) + Number(params.roomWidthM)) * h;
    const ceiling = Number(params.roomLengthM) * Number(params.roomWidthM);
    areaM2 = round2(walls + ceiling);
    areaNote = `paredes + techo (${params.roomLengthM}×${params.roomWidthM} m, altura ${fmtNum(h)} m)`;
  } else if (!areaM2) {
    areaM2 = 60;
  }

  const subtypeKey = params.paintSubtype || 'plastica';
  const spec = PAINT_SPECS_CATALOG[subtypeKey] || PAINT_SPECS_CATALOG.plastica;
  const coats = Number(params.coats) || spec.defaultCoats || 2;
  const wastePct = params.wastePct !== undefined && params.wastePct !== null ? Number(params.wastePct) : 5;
  const totalSurfaceCoatsM2 = round2(areaM2 * coats);
  const tapeRolls = Math.max(1, Math.ceil(areaM2 / 35));

  // Caso especial: Temple (se comercializa y dosifica en kg — sacos de 25 kg)
  if (spec.containerType === 'temple_bags') {
    const kgPerM2Coat = params.yieldM2PerLiter ? round2(1 / Number(params.yieldM2PerLiter)) : spec.defaultKgPerM2Coat;
    const netKg = round1(totalSurfaceCoatsM2 * kgPerM2Coat);
    const totalKgWithWaste = Math.ceil(netKg * (1 + wastePct / 100));
    const bagSizeKg = Number(params.bucketSizeLiters) || spec.bagWeightKg || 25;
    const bagsNeeded = Math.ceil(totalKgWithWaste / bagSizeKg);

    return {
      title: `🎨 *CÁLCULO DE MATERIALES — ${spec.label.toUpperCase()}*`,
      tradeType: 'painting',
      summaryLines: [
        `🔹 *Tipo de pintura:* *${spec.label}*`,
        `🔹 *Superficie a cubrir:* ${fmtNum(areaM2)} m² (${areaNote}) × *${coats} mano(s)* = *${fmtNum(totalSurfaceCoatsM2)} m²*`,
        `🔹 *Cantidad neta:* ${fmtNum(netKg)} kg (a razón de ~${fmtNum(kgPerM2Coat)} kg/m² por mano)`,
        `🔹 *Total con merma (+${fmtNum(wastePct)}%):* *${totalKgWithWaste} kg*`,
        `🛍️ *Compra recomendada:* *${bagsNeeded} saco(s)/bolsa(s) de ${bagSizeKg} kg* (${bagsNeeded * bagSizeKg} kg totales)`
      ],
      auxLines: [
        `🧻 *Cinta de carrocero (50 m) y plástico cubretodo:* *${tapeRolls} rollo(s)* + 1 bobina protectora`
      ],
      assumptions: [
        `Tipo de acabado: *${spec.label}*`,
        `Superficie: *${fmtNum(areaM2)} m²* (${coats} mano/s)`,
        `Consumo técnico aplicado: *${fmtNum(kgPerM2Coat)} kg/m² por mano*`,
        `Merma aplicada: *+${fmtNum(wastePct)}%*`
      ],
      shoppingItems: [
        { description: `Sacos de ${bagSizeKg} kg de ${spec.label} (${totalKgWithWaste} kg totales)`, qty: bagsNeeded, unit: 'ud' },
        { description: 'Rollo de cinta de carrocero 48 mm × 50 m', qty: tapeRolls, unit: 'ud' }
      ]
    };
  }

  // Resto de pinturas líquidas (plástica, látex, acrílica, vinílica, ecológica, silicato, cal, esmalte, barniz, epoxi...)
  const yieldM2PerL = Number(params.yieldM2PerLiter) || spec.defaultYieldM2PerL || 10;
  const netLiters = round2(totalSurfaceCoatsM2 / yieldM2PerL);
  const totalLitersWithWaste = round1(Math.ceil(netLiters * (1 + wastePct / 100) * 2) / 2);

  // Cálculo de botes comerciales según el tipo de pintura
  let bucketsDescription = '';
  const shoppingPaintItems = [];
  if (params.bucketSizeLiters) {
    const bSize = Number(params.bucketSizeLiters);
    const numBuckets = Math.ceil(totalLitersWithWaste / bSize);
    bucketsDescription = `*${numBuckets} bote(s) de ${fmtNum(bSize)} L* (${fmtNum(numBuckets * bSize)} L totales)`;
    shoppingPaintItems.push({
      description: `Bote de ${spec.label} de ${fmtNum(bSize)} L (${coats} manos)`,
      qty: numBuckets,
      unit: 'ud'
    });
  } else if (spec.containerType === 'cans_4_075') {
    // Esmaltes, lacas y barnices: envases comerciales estándar de 4 L y 750 ml (0,75 L)
    let rem = totalLitersWithWaste;
    const b4 = Math.floor(rem / 4);
    rem = round2(rem - b4 * 4);
    let cans075 = Math.ceil(rem / 0.75);
    let b4Final = b4;
    if (cans075 * 0.75 >= 3.5) {
      b4Final += 1;
      cans075 = 0;
    }
    const parts = [];
    if (b4Final > 0) {
      parts.push(`*${b4Final} bote(s) de 4 L*`);
      shoppingPaintItems.push({ description: `Bote de 4 L de ${spec.label}`, qty: b4Final, unit: 'ud' });
    }
    if (cans075 > 0) {
      parts.push(`*${cans075} bote(s) de 750 ml*`);
      shoppingPaintItems.push({ description: `Bote de 750 ml de ${spec.label}`, qty: cans075, unit: 'ud' });
    }
    const totalCommL = round2(b4Final * 4 + cans075 * 0.75);
    bucketsDescription = `${parts.join(' + ')} (${fmtNum(totalCommL)} L en total comercial)`;
  } else {
    // Combinación comercial óptima en formatos estándar españoles de 15 L y 4 L
    let rem = totalLitersWithWaste;
    const b15 = Math.floor(rem / 15);
    rem = rem - b15 * 15;
    let b4 = Math.ceil(rem / 4);
    let b15Final = b15;
    if (b4 * 4 >= 15) {
      b15Final += 1;
      b4 = 0;
    }
    const parts = [];
    if (b15Final > 0) {
      parts.push(`*${b15Final} bote(s) de 15 L*`);
      shoppingPaintItems.push({ description: `Bote de 15 L de ${spec.label}`, qty: b15Final, unit: 'ud' });
    }
    if (b4 > 0) {
      parts.push(`*${b4} bote(s) de 4 L*`);
      shoppingPaintItems.push({ description: `Bote de 4 L de ${spec.label}`, qty: b4, unit: 'ud' });
    }
    const totalCommercialL = b15Final * 15 + b4 * 4;
    bucketsDescription = `${parts.join(' + ')} (${totalCommercialL} L en total comercial)`;
  }

  // Imprimación fijadora específica (1 mano previa)
  const primerYield = spec.primerYieldM2PerL || 11;
  const primerLiters = Math.ceil((areaM2 / primerYield) * 1.05);

  const shoppingItems = [
    ...shoppingPaintItems,
    {
      description: `${spec.primerLabel} (${primerLiters} L)`,
      qty: primerLiters,
      unit: 'ud'
    },
    {
      description: 'Rollo de cinta de carrocero 48 mm × 50 m',
      qty: tapeRolls,
      unit: 'ud'
    }
  ];

  return {
    title: '🎨 *CÁLCULO DE MATERIALES — PINTURA*',
    tradeType: 'painting',
    summaryLines: [
      `🔹 *Tipo de pintura:* *${spec.label}*`,
      `🔹 *Superficie a pintar:* ${fmtNum(areaM2)} m² (${areaNote}) × *${coats} manos* = *${fmtNum(totalSurfaceCoatsM2)} m²* de aplicación`,
      `🔹 *Pintura neta:* ${fmtNum(netLiters)} litros (a rendimiento de ${fmtNum(yieldM2PerL)} m²/L por mano)`,
      `🔹 *Total con merma (+${fmtNum(wastePct)}% rodillo/cubeta):* *${fmtNum(totalLitersWithWaste)} litros*`,
      `🪣 *Compra recomendada:* ${bucketsDescription}`
    ],
    auxLines: [
      `🧴 *${spec.primerLabel} (1 mano previa):* *${primerLiters} L*`,
      `🧻 *Cinta de carrocero (50 m) y cubretodo:* *${tapeRolls} rollo(s)* + 1 bobina de papel/plástico protector`
    ],
    assumptions: [
      `Tipo: *${spec.label}*`,
      `Superficie: *${fmtNum(areaM2)} m²*`,
      `Número de manos: *${coats} manos*`,
      `Rendimiento aplicado: *${fmtNum(yieldM2PerL)} m²/litro por mano* ${params.yieldM2PerLiter ? '_(dato tuyo)_' : '_(estándar técnico de este tipo de pintura)_'}`,
      `Merma en cubeta/rodillo: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 2b. MICROCEMENTO
 */
function calculateMicrocement(params = {}) {
  const areaNet = Number(params.areaM2) || 20;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 10;
  const areaWithWaste = round2(areaNet * (1 + wastePct / 100));

  const meshM2 = round1(areaNet * 1.12);
  const primerL = round1(areaWithWaste * 0.15);
  const baseKg = Math.ceil(areaWithWaste * 2.0); // 2 manos de Microbase (~1 kg/m² por mano)
  const finishKg = Math.ceil(areaWithWaste * 1.0); // 2 manos de Microfino/Microdeck (~0.5 kg/m² por mano)
  const resinL = round1((baseKg + finishKg) * 0.30);
  const sealerL = round1(areaWithWaste * 0.15); // 2 manos de poliuretano bicomponente

  const shoppingItems = [
    { description: `Microcemento Base preparación (2 manos, ${baseKg} kg)`, qty: Math.ceil(baseKg / 20), unit: 'ud' },
    { description: `Microcemento Acabado Microdeck/Microfino (2 manos, ${finishKg} kg)`, qty: Math.ceil(finishKg / 20), unit: 'ud' },
    { description: `Malla de fibra de vidrio para microcemento`, qty: meshM2, unit: 'm²' },
    { description: `Resina acrílica de amasado (${fmtNum(resinL)} L)`, qty: Math.ceil(resinL / 5), unit: 'ud' },
    { description: `Barniz sellador poliuretano bicomponente (${fmtNum(sealerL)} L)`, qty: Math.ceil(sealerL), unit: 'ud' }
  ];

  return {
    title: '✨ *CÁLCULO DE MATERIALES — MICROCEMENTO*',
    tradeType: 'microcement',
    summaryLines: [
      `🔹 *Superficie neta:* ${fmtNum(areaNet)} m² (+${fmtNum(wastePct)}% merma = *${fmtNum(areaWithWaste)} m²*)`,
      `🔹 *Microcemento Base (2 manos):* *${baseKg} kg* (${Math.ceil(baseKg / 20)} cubos de 20 kg)`,
      `🔹 *Microcemento Acabado (2 manos):* *${finishKg} kg* (${Math.ceil(finishKg / 20)} cubos de 20 kg)`
    ],
    auxLines: [
      `🕸️ *Malla de fibra de vidrio (+12% solape):* *${fmtNum(meshM2)} m²*`,
      `🧴 *Imprimación promotora de adherencia:* *${fmtNum(primerL)} L*`,
      `🧪 *Resina de amasado:* *${fmtNum(resinL)} L*`,
      `🛡️ *Sellador poliuretano bicomponente (2 manos):* *${fmtNum(sealerL)} L*`
    ],
    assumptions: [
      `Superficie: *${fmtNum(areaNet)} m²*`,
      `Merma: *+${fmtNum(wastePct)}%*`,
      `Rendimientos: Base 2 kg/m² (2 manos), Acabado 1 kg/m² (2 manos)`
    ],
    shoppingItems
  };
}

/**
 * 3. RODAPIÉS, ZÓCALOS, MOLDURAS Y CORNISAS
 */
function calculateSkirting(params = {}) {
  let netLinearM = Number(params.linearMeters) || 0;
  const doorsCount = params.doorsCount !== undefined ? Number(params.doorsCount) : 1;
  const doorWidthM = Number(params.doorWidthM) || 0.82;
  const stripLengthM = Number(params.stripLengthM) || 2.40;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 10;

  let originNote = 'metros lineales directos';
  if (!netLinearM) {
    if (params.roomLengthM && params.roomWidthM) {
      const perim = 2 * (Number(params.roomLengthM) + Number(params.roomWidthM));
      netLinearM = round2(Math.max(1, perim - doorsCount * doorWidthM));
      originNote = `perímetro de ${params.roomLengthM}×${params.roomWidthM} m descontando ${doorsCount} puerta(s)`;
    } else if (params.areaM2) {
      const estPerim = 4 * Math.sqrt(Number(params.areaM2));
      netLinearM = round2(Math.max(1, estPerim - doorsCount * doorWidthM));
      originNote = `perímetro estimado para ${params.areaM2} m² descontando ${doorsCount} puerta(s)`;
    } else {
      netLinearM = 20;
    }
  }

  const totalLinearWithWaste = round2(netLinearM * (1 + wastePct / 100));
  const stripsCount = Math.ceil(totalLinearWithWaste / stripLengthM);
  const totalPurchasedMeters = round2(stripsCount * stripLengthM);
  const adhesiveCartridges = Math.max(1, Math.ceil(totalLinearWithWaste / 12));
  const acrylicSealantCartridges = Math.max(1, Math.ceil(totalLinearWithWaste / 15));

  const shoppingItems = [
    {
      description: `Rodapié / Zócalo en tiras de ${fmtNum(stripLengthM)} m (${fmtNum(totalPurchasedMeters)} ml totales)`,
      qty: stripsCount,
      unit: 'ud'
    },
    {
      description: 'Cartucho de adhesivo de montaje / polímero MS (290 ml)',
      qty: adhesiveCartridges,
      unit: 'ud'
    },
    {
      description: 'Cartucho de masilla acrílica blanca para sellado de junta superior',
      qty: acrylicSealantCartridges,
      unit: 'ud'
    }
  ];

  return {
    title: '📏 *CÁLCULO DE MATERIALES — RODAPIÉS / ZÓCALOS*',
    tradeType: 'skirting',
    summaryLines: [
      `🔹 *Metros lineales netos:* ${fmtNum(netLinearM)} ml (${originNote})`,
      `🔹 *Total con merma (+${fmtNum(wastePct)}% por cortes a inglete):* *${fmtNum(totalLinearWithWaste)} ml*`,
      `🪵 *Tiras a comprar (de ${fmtNum(stripLengthM)} m/tira):* *${stripsCount} tiras* (${fmtNum(totalPurchasedMeters)} ml en total)`
    ],
    auxLines: [
      `🧴 *Adhesivo de montaje / polímero:* *${adhesiveCartridges} cartucho(s)* (1 cada ~12 ml)`,
      `🖌️ *Masilla acrílica para sellado superior:* *${acrylicSealantCartridges} cartucho(s)*`
    ],
    assumptions: [
      `Longitud neta: *${fmtNum(netLinearM)} ml*`,
      `Largo de cada tira: *${fmtNum(stripLengthM)} m*`,
      `Merma por ingletes y despuntes: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 4. SUELOS LAMINADOS, TARIMA FLOTANTE, PARQUET, VINÍLICO SPC Y DECK EXTERIOR
 */
function calculateFlooring(params = {}) {
  const areaNet = Number(params.areaM2) || 25;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 10;
  const boxAreaM2 = Number(params.boxAreaM2) || 2.10;
  const doorsCount = params.doorsCount !== undefined ? Number(params.doorsCount) : Math.max(1, Math.round(areaNet / 18));
  const stripLengthM = Number(params.stripLengthM) || 2.40;

  const totalFloorM2 = round2(areaNet * (1 + wastePct / 100));
  const boxesNeeded = Math.ceil(totalFloorM2 / boxAreaM2);

  // Manta aislante acústica (+5% por solapes)
  const underlaymentM2 = round1(areaNet * 1.05);
  const underlaymentRolls15M2 = Math.ceil(underlaymentM2 / 15);

  // Perímetro estimado para rodapié
  const perimNet = params.linearMeters
    ? Number(params.linearMeters)
    : round1(Math.max(4, 4 * Math.sqrt(areaNet) * 1.1 - doorsCount * 0.82));
  const skirtingWithWasteM = round1(perimNet * 1.10);
  const skirtingStrips = Math.ceil(skirtingWithWasteM / stripLengthM);

  const shoppingItems = [
    {
      description: `Suelo laminado / Tarima (${boxesNeeded} cajas de ${fmtNum(boxAreaM2)} m²)`,
      qty: totalFloorM2,
      unit: 'm²'
    },
    {
      description: `Manta aislante acústica / base foam (${fmtNum(underlaymentM2)} m² / ${underlaymentRolls15M2} rollos de 15 m²)`,
      qty: underlaymentM2,
      unit: 'm²'
    },
    {
      description: `Tiras de rodapié a juego de ${fmtNum(stripLengthM)} m (${fmtNum(skirtingWithWasteM)} ml)`,
      qty: skirtingStrips,
      unit: 'ud'
    },
    {
      description: 'Perfil de transición / dilatación para puerta (0,90 m)',
      qty: doorsCount,
      unit: 'ud'
    }
  ];

  return {
    title: '🪵 *CÁLCULO DE MATERIALES — TARIMA / SUELO LAMINADO*',
    tradeType: 'flooring',
    summaryLines: [
      `🔹 *Superficie neta:* ${fmtNum(areaNet)} m²`,
      `🔹 *Total suelo con merma (+${fmtNum(wastePct)}%):* *${fmtNum(totalFloorM2)} m²* → *${boxesNeeded} cajas* (de ${fmtNum(boxAreaM2)} m²/caja)`
    ],
    auxLines: [
      `🛡️ *Manta aislante / base acústica (+5% solape):* *${fmtNum(underlaymentM2)} m²* (${underlaymentRolls15M2} rollos de 15 m²)`,
      `📏 *Rodapié perimetral (+10% merma):* *${fmtNum(skirtingWithWasteM)} ml* → *${skirtingStrips} tiras* de ${fmtNum(stripLengthM)} m`,
      `🚪 *Perfiles de transición / paso de puerta:* *${doorsCount} uds*`
    ],
    assumptions: [
      `Superficie neta: *${fmtNum(areaNet)} m²*`,
      `Merma de lama por cortes: *+${fmtNum(wastePct)}%*`,
      `Rendimiento por caja: *${fmtNum(boxAreaM2)} m²/caja*`,
      `Puertas descontadas / perfiles: *${doorsCount} puerta(s)*`
    ],
    shoppingItems
  };
}

/**
 * 5. PLADUR / CARTÓN YESO (TABIQUES, TRASDOSADOS Y FALSOS TECHOS)
 */
function calculateDrywallPladur(params = {}) {
  const areaNet = Number(params.areaM2) || 20;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 10;
  const system = params.pladurSystem || 'tabique'; // 'tabique' | 'trasdosado' | 'techo_continuo' | 'techo_registrable'
  const doubleBoard = Boolean(params.doubleBoard);
  const studSpacingCm = Number(params.studSpacingCm) || 60;

  // Caso especial: Falso techo registrable (placas 60x60 cm = 0,36 m²)
  if (system === 'techo_registrable') {
    const tileW = params.pieceWidthCm ? Number(params.pieceWidthCm) / 100 : 0.60;
    const tileL = params.pieceLengthCm ? Number(params.pieceLengthCm) / 100 : 0.60;
    const tileArea = round2(tileW * tileL);
    const totalAreaWithWaste = round2(areaNet * (1 + wastePct / 100));
    const tilesCount = Math.ceil(totalAreaWithWaste / tileArea);
    const primaryProfilesM = Math.ceil(areaNet * 0.85 * 1.08);
    const secondaryProfilesM = Math.ceil(areaNet * 2.55 * 1.08);
    const anglePerimeterM = Math.ceil(4 * Math.sqrt(areaNet) * 1.15);
    const hangersCount = Math.ceil(areaNet * 0.75);

    return {
      title: '🧱 *CÁLCULO DE MATERIALES — FALSO TECHO REGISTRABLE*',
      tradeType: 'drywall_pladur',
      summaryLines: [
        `🔹 *Superficie de techo:* ${fmtNum(areaNet)} m²`,
        `🔹 *Placas registrables (${fmtNum(tileW * 100)}×${fmtNum(tileL * 100)} cm, +${fmtNum(wastePct)}% merma):* *${tilesCount} placas* (${fmtNum(totalAreaWithWaste)} m²)`
      ],
      auxLines: [
        `📏 *Perfilería T-24 (perfiles primarios):* *${primaryProfilesM} ml*`,
        `📏 *Perfiles secundarios T-24 (1200 y 600 mm):* *${secondaryProfilesM} ml*`,
        `📐 *Perfil angular perimetral L:* *${anglePerimeterM} ml*`,
        `🔩 *Varillas roscadas + cuelgues regulables:* *${hangersCount} juegos*`
      ],
      assumptions: [
        `Superficie: *${fmtNum(areaNet)} m²*`,
        `Modulación: *${fmtNum(tileW * 100)} × ${fmtNum(tileL * 100)} cm*`,
        `Merma aplicada: *+${fmtNum(wastePct)}%*`
      ],
      shoppingItems: [
        { description: `Placas de techo registrable ${fmtNum(tileW * 100)}×${fmtNum(tileL * 100)} cm`, qty: tilesCount, unit: 'ud' },
        { description: 'Perfilería T-24 (primarios + secundarios)', qty: primaryProfilesM + secondaryProfilesM, unit: 'ml' },
        { description: 'Perfil angular perimetral techo registrable', qty: anglePerimeterM, unit: 'ml' },
        { description: 'Juegos de varilla + pieza de cuelgue', qty: hangersCount, unit: 'ud' }
      ]
    };
  }

  // Dimensiones de placa (por defecto 1,20 x 2,50 m = 3,00 m²)
  const boardW = params.pieceWidthCm ? Number(params.pieceWidthCm) / 100 : 1.20;
  const boardL = params.pieceLengthCm ? Number(params.pieceLengthCm) / 100 : 2.50;
  const boardAreaM2 = round2(boardW * boardL);

  const faces = system === 'tabique' ? 2 : 1;
  const layersPerFace = doubleBoard ? 2 : 1;
  const totalBoardMultiplier = faces * layersPerFace;

  const totalBoardM2WithWaste = round2(areaNet * totalBoardMultiplier * (1 + wastePct / 100));
  const boardsCount = Math.ceil(totalBoardM2WithWaste / boardAreaM2);

  // Perfilería:
  // Canales (U de 3 m): ~0.75 ml por m² de tabique/trasdosado
  const channelsMeters = round1(areaNet * 0.75 * (1 + wastePct / 100));
  const channelsBars3M = Math.ceil(channelsMeters / 3);

  // Montantes (C de 2.60-3.00 m): cada 60 cm -> ~2.1 ml/m²; cada 40 cm -> ~2.8 ml/m²
  const studFactor = studSpacingCm === 40 ? 2.8 : 2.1;
  const studsMeters = round1(areaNet * studFactor * (1 + wastePct / 100));
  const studsBars = Math.ceil(studsMeters / 2.8);

  // Lana de roca (1 capa interior + 5% merma)
  const insulationM2 = round1(areaNet * 1.05);

  // Pasta de juntas (~0.5 kg/m² por cara de placa) y cinta de juntas (~1.5 ml/m² por cara)
  const jointPasteKg = Math.ceil(areaNet * faces * 0.55 * (1 + wastePct / 100));
  const jointTapeMeters = Math.ceil(areaNet * faces * 1.5 * (1 + wastePct / 100));
  const screwsPM = Math.ceil(areaNet * totalBoardMultiplier * 16);

  const systemLabel = system === 'tabique'
    ? `Tabique divisorio (2 caras${doubleBoard ? ', doble placa' : ', placa simple'})`
    : (system === 'trasdosado'
      ? `Trasdosado autoportante (1 cara${doubleBoard ? ', doble placa' : ', placa simple'})`
      : 'Falso techo continuo de Pladur');

  const shoppingItems = [
    {
      description: `Placas de Pladur ${fmtNum(boardW)}×${fmtNum(boardL)} m (${fmtNum(totalBoardM2WithWaste)} m²)`,
      qty: boardsCount,
      unit: 'ud'
    },
    {
      description: `Perfiles Montantes verticales (${fmtNum(studsMeters)} ml, modulación cada ${studSpacingCm} cm)`,
      qty: studsBars,
      unit: 'ud'
    },
    {
      description: `Perfiles Canales horizontales de 3 m (${fmtNum(channelsMeters)} ml)`,
      qty: channelsBars3M,
      unit: 'ud'
    },
    {
      description: 'Aislamiento interior de lana mineral / lana de roca',
      qty: insulationM2,
      unit: 'm²'
    },
    {
      description: `Pasta de juntas Pladur (${jointPasteKg} kg) + ${jointTapeMeters} ml de cinta de juntas`,
      qty: jointPasteKg,
      unit: 'ud'
    },
    {
      description: `Cajas de 1.000 tornillos fosfatados PM 3,5×25 mm (${screwsPM} uds necesarias)`,
      qty: Math.max(1, Math.ceil(screwsPM / 1000)),
      unit: 'ud'
    }
  ];

  return {
    title: '🧱 *CÁLCULO DE MATERIALES — PLADUR / CARTÓN YESO*',
    tradeType: 'drywall_pladur',
    summaryLines: [
      `🔹 *Sistema:* ${systemLabel} sobre *${fmtNum(areaNet)} m²*`,
      `🔹 *Placas de Pladur (${fmtNum(boardW)}×${fmtNum(boardL)} m = ${fmtNum(boardAreaM2)} m²/placa, +${fmtNum(wastePct)}% merma):* *${boardsCount} placas* (${fmtNum(totalBoardM2WithWaste)} m² totales)`
    ],
    auxLines: [
      `🔩 *Montantes (cada ${studSpacingCm} cm):* *${studsBars} perfiles* (${fmtNum(studsMeters)} ml)`,
      `📏 *Canales perimetrales (barras de 3 m):* *${channelsBars3M} perfiles* (${fmtNum(channelsMeters)} ml)`,
      `🧶 *Lana de roca / aislamiento interior (+5%):* *${fmtNum(insulationM2)} m²*`,
      `🪣 *Pasta y cinta de juntas:* *${jointPasteKg} kg de pasta* + *${jointTapeMeters} ml de cinta*`,
      `🪛 *Tornillería placa-metal:* *~${screwsPM} tornillos*`
    ],
    assumptions: [
      `Superficie del paramento/techo: *${fmtNum(areaNet)} m²*`,
      `Tipo: *${systemLabel}*`,
      `Formato de placa: *${fmtNum(boardW)} × ${fmtNum(boardL)} m*`,
      `Separación de montantes: *cada ${studSpacingCm} cm*`,
      `Merma aplicada: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 6. FÁBRICA DE LADRILLO, TERMOARCILLA Y BLOQUE DE HORMIGÓN
 */
function calculateBrickwork(params = {}) {
  const areaNet = Number(params.areaM2) || 15;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 7;
  const brickType = params.brickType || 'hueco_doble';

  const specs = {
    hueco_sencillo: { label: 'Ladrillo Hueco Sencillo (24×11,5×4 cm)', udsPerM2: 32, mortarKgPerM2: 18 },
    hueco_doble: { label: 'Ladrillo Hueco Doble / Machetón (24×11,5×7/9 cm)', udsPerM2: 25, mortarKgPerM2: 24 },
    rasilla: { label: 'Rasilla cerámica (24×11,5×3 cm)', udsPerM2: 33, mortarKgPerM2: 15 },
    perforado: { label: 'Ladrillo Perforado / Gero / Caravista (24×11,5×7 cm)', udsPerM2: 38, mortarKgPerM2: 34 },
    gran_formato: { label: 'Ladrillo Gran Formato / Tabicón (50×20×7 cm)', udsPerM2: 9.5, mortarKgPerM2: 12 },
    termoarcilla: { label: 'Bloque cerámico Termoarcilla (30×19×14 cm)', udsPerM2: 16, mortarKgPerM2: 28 },
    bloque_hormigon: { label: 'Bloque de Hormigón (40×20×20 cm)', udsPerM2: 12.5, mortarKgPerM2: 22 }
  };

  let spec = specs[brickType] || specs.hueco_doble;

  // Si el albañil dio las dimensiones exactas del ladrillo/bloque (ej: "ladrillo de 33x16 cm")
  if (params.pieceWidthCm && params.pieceLengthCm) {
    const lM = (Math.max(params.pieceWidthCm, params.pieceLengthCm) + 1.2) / 100; // +1.2 cm de junta
    const hM = (Math.min(params.pieceWidthCm, params.pieceLengthCm) + 1.2) / 100;
    const customUds = round1(1 / (lM * hM));
    spec = {
      label: `Pieza / Ladrillo de ${params.pieceWidthCm}×${params.pieceLengthCm} cm`,
      udsPerM2: customUds,
      mortarKgPerM2: 22
    };
  }

  const netBricks = Math.ceil(areaNet * spec.udsPerM2);
  const totalBricksWithWaste = Math.ceil(netBricks * (1 + wastePct / 100));
  const totalMortarKg = Math.ceil(areaNet * spec.mortarKgPerM2 * (1 + wastePct / 100));
  const mortarBags25Kg = Math.ceil(totalMortarKg / 25);

  const shoppingItems = [
    {
      description: `${spec.label} (incluye +${fmtNum(wastePct)}% merma)`,
      qty: totalBricksWithWaste,
      unit: 'ud'
    },
    {
      description: `Sacos de 25 kg de mortero seco M-5 / M-7,5 (${totalMortarKg} kg totales)`,
      qty: mortarBags25Kg,
      unit: 'ud'
    }
  ];

  return {
    title: '🧱 *CÁLCULO DE MATERIALES — FÁBRICA DE LADRILLO / BLOQUE*',
    tradeType: 'brickwork',
    summaryLines: [
      `🔹 *Superficie del muro/tabique:* ${fmtNum(areaNet)} m²`,
      `🔹 *Tipo de pieza:* ${spec.label} (~${fmtNum(spec.udsPerM2)} uds/m²)`,
      `🔹 *Piezas netas:* ${netBricks} uds`,
      `🔹 *Total a pedir (+${fmtNum(wastePct)}% merma por cortes/roturas):* *${totalBricksWithWaste} unidades*`
    ],
    auxLines: [
      `🪣 *Mortero de albañilería M-5:* *${mortarBags25Kg} sacos de 25 kg* (${totalMortarKg} kg en total)`
    ],
    assumptions: [
      `Superficie: *${fmtNum(areaNet)} m²*`,
      `Formato: *${spec.label}*`,
      `Merma por roturas y cortes: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 7. SOLERAS, RECRECIDOS DE MORTERO, AUTONIVELANTE Y HORMIGÓN
 */
function calculateConcreteScreed(params = {}) {
  const areaNet = Number(params.areaM2) || 20;
  const isSelfLeveling = /autonivelante/i.test(params.rawText || '');
  const isConcrete = /hormigon|solera|mallazo/i.test(params.rawText || '') && !isSelfLeveling;
  const thicknessCm = Number(params.thicknessCm) || (isSelfLeveling ? 1.0 : (isConcrete ? 10 : 5));
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 8;

  const volumeNetM3 = round2(areaNet * (thicknessCm / 100));
  const volumeTotalM3 = round2(volumeNetM3 * (1 + wastePct / 100));

  if (isConcrete) {
    // Dosificación por m³ de hormigón HA-25 hecho en obra: ~300 kg cemento (12 sacos de 25 kg), 0.45 m³ arena, 0.80 m³ grava
    const cementBags25Kg = Math.ceil(volumeTotalM3 * 12);
    const sandM3 = round2(volumeTotalM3 * 0.45);
    const gravelM3 = round2(volumeTotalM3 * 0.80);
    const meshM2 = round1(areaNet * 1.15); // +15% por solapes de mallazo

    const shoppingItems = [
      { description: `Hormigón HA-25 (${fmtNum(volumeTotalM3)} m³) o ${cementBags25Kg} sacos cemento 25 kg`, qty: volumeTotalM3, unit: 'm³' },
      { description: `Mallazo electrosoldado 15×15×6 mm (+15% solape)`, qty: meshM2, unit: 'm²' },
      { description: `Arena de río (${fmtNum(sandM3)} m³) y grava (${fmtNum(gravelM3)} m³)`, qty: round2(sandM3 + gravelM3), unit: 'm³' }
    ];

    return {
      title: '🏗️ *CÁLCULO DE MATERIALES — SOLERA / HORMIGÓN*',
      tradeType: 'concrete_screed',
      summaryLines: [
        `🔹 *Superficie y espesor:* ${fmtNum(areaNet)} m² × ${fmtNum(thicknessCm)} cm de espesor`,
        `🔹 *Volumen neto:* ${fmtNum(volumeNetM3)} m³`,
        `🔹 *Volumen total a pedir (+${fmtNum(wastePct)}% irregularidades del terreno):* *${fmtNum(volumeTotalM3)} m³ de hormigón*`
      ],
      auxLines: [
        `🧱 *Si se amasa en obra:* *${cementBags25Kg} sacos de cemento (25 kg)* + *${fmtNum(sandM3)} m³ de arena* + *${fmtNum(gravelM3)} m³ de grava*`,
        `🕸️ *Mallazo electrosoldado (+15% por solapes):* *${fmtNum(meshM2)} m²* (${Math.ceil(meshM2 / 13.2)} paños de 6×2,20 m)`,
        `🛡️ *Lámina de polietileno (barrera antihumedad):* *${fmtNum(round1(areaNet * 1.10))} m²*`
      ],
      assumptions: [
        `Superficie: *${fmtNum(areaNet)} m²*`,
        `Espesor medio: *${fmtNum(thicknessCm)} cm*`,
        `Merma por asentamiento e irregularidades: *+${fmtNum(wastePct)}%*`
      ],
      shoppingItems
    };
  }

  // Recrecido de mortero o mortero autonivelante (~18 kg por m² y cm de espesor)
  const rateKgPerM2Cm = isSelfLeveling ? 18 : 19;
  const totalMortarKg = Math.ceil(areaNet * thicknessCm * rateKgPerM2Cm * (1 + wastePct / 100));
  const bags25Kg = Math.ceil(totalMortarKg / 25);
  const perimeterBandM = Math.ceil(4 * Math.sqrt(areaNet) * 1.15);

  const shoppingItems = [
    {
      description: `Sacos de 25 kg de ${isSelfLeveling ? 'mortero autonivelante' : 'mortero de recrecido'} (${totalMortarKg} kg totales)`,
      qty: bags25Kg,
      unit: 'ud'
    },
    {
      description: 'Banda perimetral acústica/dilatación para recrecido',
      qty: perimeterBandM,
      unit: 'ml'
    }
  ];

  return {
    title: `🪣 *CÁLCULO DE MATERIALES — ${isSelfLeveling ? 'MORTERO AUTONIVELANTE' : 'RECRECIDO DE MORTERO'}*`,
    tradeType: 'concrete_screed',
    summaryLines: [
      `🔹 *Superficie y espesor:* ${fmtNum(areaNet)} m² × ${fmtNum(thicknessCm)} cm (${fmtNum(thicknessCm * 10)} mm)`,
      `🔹 *Peso total necesario (+${fmtNum(wastePct)}% merma):* *${totalMortarKg} kg*`,
      `🛍️ *Sacos de 25 kg a comprar:* *${bags25Kg} sacos*`
    ],
    auxLines: [
      `📏 *Banda perimetral de dilatación:* *${perimeterBandM} ml*`
    ],
    assumptions: [
      `Superficie: *${fmtNum(areaNet)} m²*`,
      `Espesor: *${fmtNum(thicknessCm)} cm*`,
      `Consumo técnico: *${rateKgPerM2Cm} kg/m² por cm de espesor*`,
      `Merma aplicada: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 8. ENFOSCADOS, GUARNECIDOS DE YESO, PERLITA Y MONOCAPA
 */
function calculatePlasterRender(params = {}) {
  const areaNet = Number(params.areaM2) || 25;
  const isGypsum = /yeso|perlita|guarnecido|enlucido/i.test(params.rawText || '');
  const thicknessCm = Number(params.thicknessCm) || (isGypsum ? 1.2 : 1.5);
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 8;

  // Rendimiento: yeso/perlita ~11 kg/m² por cm; mortero enfoscado/monocapa ~18 kg/m² por cm
  const rateKgPerM2Cm = isGypsum ? 11 : 18;
  const bagWeightKg = isGypsum ? 20 : 25;
  const totalKg = Math.ceil(areaNet * thicknessCm * rateKgPerM2Cm * (1 + wastePct / 100));
  const totalBags = Math.ceil(totalKg / bagWeightKg);
  const guidesCount = Math.max(4, Math.ceil(areaNet / 3));

  const materialName = isGypsum ? 'Yeso / Perlita de guarnecido y enlucido' : 'Mortero de enfoscado / Monocapa';

  const shoppingItems = [
    {
      description: `Sacos de ${bagWeightKg} kg de ${materialName} (${totalKg} kg totales)`,
      qty: totalBags,
      unit: 'ud'
    },
    {
      description: 'Guardavivos / junquillos de maestreado (perfiles de 2,50 m)',
      qty: guidesCount,
      unit: 'ud'
    }
  ];

  return {
    title: `🧱 *CÁLCULO DE MATERIALES — ${isGypsum ? 'YESO / PERLITA' : 'ENFOSCADO / MONOCAPA'}*`,
    tradeType: 'plaster_render',
    summaryLines: [
      `🔹 *Superficie y espesor medio:* ${fmtNum(areaNet)} m² × ${fmtNum(thicknessCm)} cm`,
      `🔹 *Cantidad total (+${fmtNum(wastePct)}% merma):* *${totalKg} kg*`,
      `🛍️ *Sacos a comprar (de ${bagWeightKg} kg):* *${totalBags} sacos*`
    ],
    auxLines: [
      `📏 *Junquillos / Maestras y guardavivos:* *~${guidesCount} perfiles* de 2,50 m`
    ],
    assumptions: [
      `Superficie: *${fmtNum(areaNet)} m²*`,
      `Espesor medio: *${fmtNum(thicknessCm)} cm*`,
      `Rendimiento: *${rateKgPerM2Cm} kg/m² por cm de espesor*`,
      `Merma: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 9. FONTANERÍA, SANEAMIENTO (PVC) Y SUELO RADIANTE
 * Prioridad absoluta a las cotas verticales y distancias indicadas por el fontanero.
 */
function calculatePlumbing(params = {}) {
  // Si dio metros lineales directos de tubería
  if (params.linearMeters && !params.lavaboCount && !params.duchaCount && !params.inodoroCount && !params.fregaderoCount) {
    const netM = Number(params.linearMeters);
    const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 15;
    const totalM = round1(netM * (1 + wastePct / 100));
    const elbows = Math.max(4, Math.ceil(totalM / 2.5));
    const tees = Math.max(2, Math.ceil(totalM / 5));

    return {
      title: '🚰 *CÁLCULO DE MATERIALES — FONTANERÍA*',
      tradeType: 'plumbing',
      summaryLines: [
        `🔹 *Longitud base indicada:* ${fmtNum(netM)} ml`,
        `🔹 *Total tubería con margen (+${fmtNum(wastePct)}% por curvas y despuntes):* *${fmtNum(totalM)} ml*`
      ],
      auxLines: [
        `🔩 *Accesorios estimados:* *${elbows} codos 90°*, *${tees} tes* y *${Math.ceil(totalM)} ml de coquilla aislante*`
      ],
      assumptions: [
        `Longitud indicada por el profesional: *${fmtNum(netM)} ml*`,
        `Margen de seguridad: *+${fmtNum(wastePct)}%*`
      ],
      shoppingItems: [
        { description: 'Tubería multicapa / PEX Ø16-20 mm', qty: totalM, unit: 'ml' },
        { description: 'Coquilla aislante térmica para tubería', qty: Math.ceil(totalM), unit: 'ml' },
        { description: 'Codos 90° de prensar/roscar', qty: elbows, unit: 'ud' },
        { description: 'Tes de derivación', qty: tees, unit: 'ud' }
      ]
    };
  }

  // Determinar aparatos (si no especificó aparatos, deducir si habla de cocina o baño completo estándar)
  const isKitchen = /cocina|fregadero|lavavajillas/i.test(params.rawText || '') && !/bano|ducha|inodoro/i.test(params.rawText || '');
  const lavabos = params.lavaboCount !== undefined ? Number(params.lavaboCount) : (isKitchen ? 0 : 1);
  const inodoros = params.inodoroCount !== undefined ? Number(params.inodoroCount) : (isKitchen ? 0 : 1);
  const duchas = params.duchaCount !== undefined ? Number(params.duchaCount) : (isKitchen ? 0 : 1);
  const bides = params.bideCount !== undefined ? Number(params.bideCount) : 0;
  const fregaderos = params.fregaderoCount !== undefined ? Number(params.fregaderoCount) : (isKitchen ? 1 : 0);
  const lavadoras = params.lavadoraCount !== undefined ? Number(params.lavadoraCount) : (isKitchen ? 1 : 0);
  const lavavajillas = params.lavavajillasCount !== undefined ? Number(params.lavavajillasCount) : (isKitchen ? 1 : 0);

  // Cotas verticales y distancias: ¡MANDAN AL 100% LAS QUE DIGA EL AUTÓNOMO!
  const ceilingH = Number(params.ceilingHeightM) || 2.50;
  const distGeneral = Number(params.pipeDistanceM) || (params.areaM2 ? round1(Math.sqrt(Number(params.areaM2)) * 1.4) : 3.5);
  const riserLavabo = Number(params.riserLavaboM) || 0.60;
  const riserDucha = Number(params.riserDuchaM) || 1.10;
  const riserInodoro = Number(params.riserInodoroM) || 0.25;
  const riserFregadero = Number(params.riserFregaderoM) || 0.60;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 15;

  // Cálculo de tramos de Agua Fría (AF) y Agua Caliente Sanitaria (ACS)
  // Si el trazado va por falso techo, cada bajada baja (ceilingH - cota_toma); si va por suelo/pared sube (cota_toma) + tramo horizontal
  let afNetM = 0;
  let acsNetM = 0;

  if (lavabos > 0) {
    afNetM += lavabos * (distGeneral + riserLavabo);
    acsNetM += lavabos * (distGeneral + riserLavabo);
  }
  if (duchas > 0) {
    afNetM += duchas * (distGeneral + riserDucha);
    acsNetM += duchas * (distGeneral + riserDucha);
  }
  if (inodoros > 0) {
    afNetM += inodoros * (distGeneral + riserInodoro); // Inodoro solo lleva Agua Fría
  }
  if (bides > 0) {
    afNetM += bides * (distGeneral + riserInodoro);
    acsNetM += bides * (distGeneral + riserInodoro);
  }
  if (fregaderos > 0) {
    afNetM += fregaderos * (distGeneral + riserFregadero);
    acsNetM += fregaderos * (distGeneral + riserFregadero);
  }
  if (lavadoras > 0) {
    afNetM += lavadoras * (distGeneral + riserFregadero);
  }
  if (lavavajillas > 0) {
    afNetM += lavavajillas * (distGeneral + riserFregadero);
  }

  const afTotalM = Math.ceil(afNetM * (1 + wastePct / 100));
  const acsTotalM = Math.ceil(acsNetM * (1 + wastePct / 100));
  const totalPipeM = afTotalM + acsTotalM;

  // Valvulería y accesorios
  const angleValves = (lavabos * 2) + (bides * 2) + (fregaderos * 2) + (inodoros * 1) + lavadoras + lavavajillas;
  const wallPlates = (lavabos * 2) + (duchas * 2) + (bides * 2) + (fregaderos * 2) + (inodoros * 1) + lavadoras + lavavajillas;
  const cutValves = acsTotalM > 0 ? 2 : 1; // 1 llave de corte general AF + 1 ACS
  const elbows = Math.max(6, wallPlates * 2);
  const tees = Math.max(2, (lavabos + duchas + inodoros + bides + fregaderos + lavadoras + lavavajillas) * 2 - 2);

  // Desagües PVC
  const pvc40M = Math.ceil(((lavabos + duchas + bides + fregaderos + lavadoras + lavavajillas) * (distGeneral * 0.75)) * 1.15);
  const pvc110M = inodoros > 0 ? Math.max(2, Math.ceil(inodoros * 2.0)) : 0;

  const shoppingItems = [
    { description: `Tubería multicapa / PEX Ø16-20 mm (${afTotalM} m Agua Fría + ${acsTotalM} m ACS)`, qty: totalPipeM, unit: 'ml' },
    { description: 'Coquilla aislante térmica para tubería', qty: totalPipeM, unit: 'ml' },
    { description: 'Codos hembra con placa mural (tomas de agua)', qty: wallPlates, unit: 'ud' },
    { description: 'Llaves de escuadra 1/2"×3/8" cromadas', qty: angleValves, unit: 'ud' },
    { description: 'Llaves de corte de esfera empotrar', qty: cutValves, unit: 'ud' },
    { description: `Codos 90° (${elbows} uds) y Tes (${tees} uds) multicapa`, qty: elbows + tees, unit: 'ud' }
  ];

  if (pvc40M > 0) {
    shoppingItems.push({ description: 'Tubería PVC evacuación Ø40 mm para desagües', qty: pvc40M, unit: 'ml' });
  }
  if (inodoros > 0) {
    shoppingItems.push({ description: 'Bote sifónico PVC + manguetón inodoro Ø110 mm', qty: inodoros, unit: 'ud' });
  }

  const assumptions = [
    `Distancia media por toma a entrada/colector: *${fmtNum(distGeneral)} m* ${params.pipeDistanceM ? '_(dato tuyo)_' : '_(estándar; dime otra si varía)_'}`,
    ...(lavabos > 0 ? [`Cota toma lavabo: *${fmtNum(riserLavabo)} m* ${params.riserLavaboM ? '_(dato tuyo)_' : '_(estándar)_'}`] : []),
    ...(duchas > 0 ? [`Cota grifería ducha: *${fmtNum(riserDucha)} m* ${params.riserDuchaM ? '_(dato tuyo)_' : '_(estándar)_'}`] : []),
    ...(inodoros > 0 ? [`Cota toma inodoro: *${fmtNum(riserInodoro)} m* ${params.riserInodoroM ? '_(dato tuyo)_' : '_(estándar)_'}`] : []),
    ...(fregaderos > 0 ? [`Cota toma fregadero: *${fmtNum(riserFregadero)} m* ${params.riserFregaderoM ? '_(dato tuyo)_' : '_(estándar)_'}`] : []),
    `Margen por curvas y despuntes: *+${fmtNum(wastePct)}%*`
  ];

  return {
    title: '🚰 *CÁLCULO DE MATERIALES — FONTANERÍA Y DESAGÜES*',
    tradeType: 'plumbing',
    summaryLines: [
      `🔹 *Tubería Agua Fría (AF):* *${afTotalM} ml* (${fmtNum(afNetM, 1)} m netos + ${fmtNum(wastePct)}% margen)`,
      `🔹 *Tubería Agua Caliente (ACS):* *${acsTotalM} ml* (${fmtNum(acsNetM, 1)} m netos + ${fmtNum(wastePct)}% margen)`,
      `🔹 *Total tubería Multicapa / PEX + coquilla aislante:* *${totalPipeM} ml*`
    ],
    auxLines: [
      `🔩 *Tomas murales (codos con placa):* *${wallPlates} uds*`,
      `🚰 *Llaves de escuadra:* *${angleValves} uds* | *Llaves de corte general:* *${cutValves} uds*`,
      `🔧 *Codos 90° y Tes:* *~${elbows} codos* y *~${tees} tes*`,
      `🕳️ *Red de desagües PVC:* *${pvc40M} ml de PVC Ø40 mm*${pvc110M > 0 ? ` + *${pvc110M} ml PVC Ø110 mm* + *${inodoros} bote sifónico y manguetón*` : ''}`
    ],
    assumptions,
    shoppingItems
  };
}

/**
 * 9b. SUELO RADIANTE
 */
function calculateUnderfloorHeating(params = {}) {
  const areaNet = Number(params.areaM2) || 50;
  const pitchCm = Number(params.pipePitchCm) || 15;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 10;

  const pitchM = pitchCm / 100;
  const netPipeM = round1(areaNet / pitchM);
  const totalPipeM = Math.ceil(round2(netPipeM * (1 + wastePct / 100)));
  const circuitsCount = Math.max(1, Math.ceil(totalPipeM / 85)); // máx recomendado ~85-90 m por circuito
  const panelsM2 = round1(areaNet * 1.05);
  const perimeterBandM = Math.ceil(4 * Math.sqrt(areaNet) * 1.25);

  const shoppingItems = [
    { description: `Tubería suelo radiante PEX-a / Multicapa Ø16 mm (paso ${pitchCm} cm)`, qty: totalPipeM, unit: 'ml' },
    { description: `Panel aislante de tetones para suelo radiante`, qty: panelsM2, unit: 'm²' },
    { description: `Colector de suelo radiante completo de ${circuitsCount} circuitos/vías`, qty: 1, unit: 'ud' },
    { description: 'Banda perimetral con faldón para suelo radiante', qty: perimeterBandM, unit: 'ml' }
  ];

  return {
    title: '🔥 *CÁLCULO DE MATERIALES — SUELO RADIANTE*',
    tradeType: 'underfloor_heating',
    summaryLines: [
      `🔹 *Superficie útil:* ${fmtNum(areaNet)} m² con paso entre tubos de *${fmtNum(pitchCm)} cm*`,
      `🔹 *Tubería Ø16 mm necesaria (+${fmtNum(wastePct)}% curvas y conexiones a colector):* *${totalPipeM} ml*`,
      `🔹 *Circuitos recomendados (máx. 85 m/circuito):* *${circuitsCount} circuitos*`
    ],
    auxLines: [
      `🟨 *Panel aislante de tetones (+5% merma):* *${fmtNum(panelsM2)} m²*`,
      `🎛️ *Colector de distribución:* *1 colector de ${circuitsCount} vías* con caudalímetros`,
      `📏 *Banda perimetral:* *${perimeterBandM} ml*`
    ],
    assumptions: [
      `Superficie útil: *${fmtNum(areaNet)} m²*`,
      `Paso de tubería: *cada ${fmtNum(pitchCm)} cm* (${fmtNum(1 / pitchM, 1)} ml/m²)`,
      `Holgura hacia colector: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 10. ELECTRICIDAD, MECANISMOS, TUBO CORRUGADO E ILUMINACIÓN (REBT ITC-BT-25)
 * Prioridad absoluta a los puntos, distancias y alturas dados por el electricista.
 */
function calculateElectrical(params = {}) {
  const areaM2 = Number(params.areaM2) || 15;
  const ceilingH = Number(params.ceilingHeightM) || 2.50;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 18; // +18% cocas en cajas y curvas

  // Dotación de mecanismos: usa exactamente lo que diga el electricista o estima por REBT ITC-BT-25
  const sockets = params.socketsCount !== undefined
    ? Number(params.socketsCount)
    : Math.max(3, Math.ceil(areaM2 / 4));
  const lights = params.lightsCount !== undefined
    ? Number(params.lightsCount)
    : Math.max(1, Math.ceil(areaM2 / 10));
  const switches = params.switchesCount !== undefined
    ? Number(params.switchesCount)
    : Math.max(1, Math.min(3, lights + 1));

  // Distancia media desde caja de registro a cada punto
  const distBoxM = Number(params.boxDistanceM) || round1(Math.max(3.5, Math.sqrt(areaM2) * 1.3));

  // Alumbrado (Sección 1,5 mm²): Fase + Neutro + Tierra + Vueltas de lámpara/conmutada
  const lightConduitNetM = (lights + switches) * (distBoxM + (ceilingH - 1.10));
  const cable15TotalM = Math.ceil(lightConduitNetM * 3.2 * (1 + wastePct / 100));

  // Tomas de corriente uso general (Sección 2,5 mm²): Fase + Neutro + Tierra (3 hilos)
  const powerConduitNetM = sockets * (distBoxM + (ceilingH - 0.30) * 0.6);
  const cable25TotalM = Math.ceil(powerConduitNetM * 3.0 * (1 + wastePct / 100));

  const conduitM20TotalM = Math.ceil((lightConduitNetM + powerConduitNetM) * 1.10);
  const universalBoxes = sockets + switches;
  const junctionBoxes = Math.max(1, Math.ceil((sockets + lights) / 8));

  const shoppingItems = [
    { description: `Cable H07Z1-K libre de halógenos 2,5 mm² (Fase, Neutro y Tierra — ${Math.ceil(cable25TotalM / 3)} m de cada hilo)`, qty: cable25TotalM, unit: 'ml' },
    { description: `Cable H07Z1-K libre de halógenos 1,5 mm² (Alumbrado — Fase, Neutro, Tierra y vueltas)`, qty: cable15TotalM, unit: 'ml' },
    { description: 'Tubo corrugado ignífugo M20 (Ø20 mm)', qty: conduitM20TotalM, unit: 'ml' },
    { description: 'Cajas universales de empotrar para mecanismos', qty: universalBoxes, unit: 'ud' },
    { description: 'Caja de registro / derivación empotrar 100×160 mm con regletas', qty: junctionBoxes, unit: 'ud' }
  ];

  return {
    title: '⚡ *CÁLCULO DE MATERIALES — ELECTRICIDAD E ILUMINACIÓN*',
    tradeType: 'electrical',
    summaryLines: [
      `🔹 *Dotación calculada:* *${sockets} enchufes*, *${lights} punto(s) de luz* y *${switches} interruptor(es)/conmutador(es)*`,
      `🔹 *Cable 2,5 mm² (Fuerza/Enchufes):* *${cable25TotalM} ml totales* (~${Math.ceil(cable25TotalM / 3)} m Fase + ${Math.ceil(cable25TotalM / 3)} m Neutro + ${Math.ceil(cable25TotalM / 3)} m Tierra)`,
      `🔹 *Cable 1,5 mm² (Alumbrado):* *${cable15TotalM} ml totales* (incluye vueltas de lámpara/conmutadas)`,
      `🔹 *Tubo corrugado M20:* *${conduitM20TotalM} ml*`
    ],
    auxLines: [
      `📦 *Cajas universales de mecanismo:* *${universalBoxes} uds*`,
      `🧰 *Cajas de registro/derivación + clemas Wago:* *${junctionBoxes} caja(s)*`
    ],
    assumptions: [
      `Distancia media a caja de registro: *${fmtNum(distBoxM)} m* ${params.boxDistanceM ? '_(dato tuyo)_' : '_(estándar)_'}`,
      `Altura de techo: *${fmtNum(ceilingH)} m* ${params.ceilingHeightM ? '_(dato tuyo)_' : '_(estándar)_'}`,
      `Margen para cocas y conexiones: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 11. CLIMATIZACIÓN (SPLITS / CONDUCTOS) Y RADIADORES DE CALEFACCIÓN
 */
function calculateHvac(params = {}) {
  const areaM2 = Number(params.areaM2) || 20;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 15;

  if (params.hvacSubtype === 'radiators') {
    // Radiadores de aluminio: ~95 kcal/h por m²; 1 elemento de 60 cm rinde ~125 kcal/h
    const kcalNeeded = Math.ceil(areaM2 * 95);
    const elementsNeeded = Math.max(4, Math.ceil(kcalNeeded / 125));
    const pipeDist = Number(params.pipeDistanceM) || Number(params.refrigerantLineM) || 5;
    const totalPipeBituboM = Math.ceil(pipeDist * 2 * (1 + wastePct / 100));

    return {
      title: '🌡️ *CÁLCULO DE MATERIALES — RADIADORES DE CALEFACCIÓN*',
      tradeType: 'hvac',
      summaryLines: [
        `🔹 *Estancia de ${fmtNum(areaM2)} m²:* demanda térmica aproximada de *${kcalNeeded} kcal/h*`,
        `🔹 *Tamaño de radiador de aluminio recomendado:* *${elementsNeeded} elementos* (de 60 cm de altura entre ejes)`
      ],
      auxLines: [
        `🚰 *Tubería multicapa/cobre Ø16 mm (ida y retorno +${fmtNum(wastePct)}%):* *${totalPipeBituboM} ml*`,
        `🔧 *Kit de accesorios:* 1 llave termostática + 1 detentor + 1 purgador + 2 soportes + 4 reducciones`
      ],
      assumptions: [
        `Superficie: *${fmtNum(areaM2)} m²*`,
        `Emisión térmica por elemento: *125 kcal/h*`,
        `Distancia al colector/circuito: *${fmtNum(pipeDist)} m*`
      ],
      shoppingItems: [
        { description: `Radiador de aluminio de ${elementsNeeded} elementos + kit de tapones y soportes`, qty: elementsNeeded, unit: 'ud' },
        { description: 'Kit llave monotubo/bitubo termostática + detentor + purgador', qty: 1, unit: 'ud' },
        { description: 'Tubería multicapa calefacción Ø16 mm con coquilla', qty: totalPipeBituboM, unit: 'ml' }
      ]
    };
  }

  // Split de Aire Acondicionado
  const fgPerM2 = Number(params.frigoriasPerM2) || 110;
  const frigoriasNeeded = Math.ceil((areaM2 * fgPerM2) / 100) * 100;
  const kwNeeded = round1(frigoriasNeeded / 860);
  const lineDistM = Number(params.refrigerantLineM) || Number(params.pipeDistanceM) || 4;
  const totalCopperLineM = round1(lineDistM * (1 + wastePct / 100));
  const pipesSpec = frigoriasNeeded <= 3500 ? '1/4" y 3/8"' : '1/4" y 1/2"';
  const trunkingBars2M = Math.ceil(lineDistM / 2);

  const shoppingItems = [
    { description: `Línea frigorífica bitubo de cobre aislado (${pipesSpec})`, qty: totalCopperLineM, unit: 'ml' },
    { description: 'Manguera eléctrica interconexión 5×1,5 mm² + tubo desagüe Ø16 mm', qty: Math.ceil(totalCopperLineM + 1), unit: 'ml' },
    { description: 'Canaleta de PVC 60×60 mm en tiras de 2 m', qty: trunkingBars2M, unit: 'ud' },
    { description: 'Juego de soportes unidad exterior + 4 silentblocks antivibratorios', qty: 1, unit: 'ud' }
  ];

  return {
    title: '❄️ *CÁLCULO DE MATERIALES — CLIMATIZACIÓN (SPLIT)*',
    tradeType: 'hvac',
    summaryLines: [
      `🔹 *Estancia de ${fmtNum(areaM2)} m²:* necesita *~${frigoriasNeeded} frigorías/h* (*${fmtNum(kwNeeded)} kW* térmicos)`,
      `🔹 *Línea frigorífica de cobre aislado (${pipesSpec}):* *${fmtNum(totalCopperLineM)} ml* (${fmtNum(lineDistM)} m distancia + ${fmtNum(wastePct)}% margen)`
    ],
    auxLines: [
      `🔌 *Manguera eléctrica interconexión (5×1,5 mm²) y desagüe condensados:* *${Math.ceil(totalCopperLineM + 1)} ml*`,
      `📏 *Canaleta blanca 60×60 mm:* *${trunkingBars2M} tira(s)* de 2 m`,
      `🔩 *Soportes:* 1 juego de escuadras + 4 silentblocks de caucho`
    ],
    assumptions: [
      `Superficie: *${fmtNum(areaM2)} m²* (${fgPerM2} frigorías/m²)`,
      `Distancia entre split y compresor: *${fmtNum(lineDistM)} m* ${params.refrigerantLineM ? '_(dato tuyo)_' : '_(estándar)_'}`,
      `Margen en tubería frigorífica: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems
  };
}

/**
 * 12. IMPERMEABILIZACIÓN, AISLAMIENTO SATE Y CUBIERTAS DE TEJA
 */
function calculateWaterproofingInsulation(params = {}) {
  const areaNet = Number(params.areaM2) || 25;
  const isSate = /\bsate\b|aislamiento|lana\s+de\s+roca|xps|copopren/i.test(params.rawText || '');

  if (isSate) {
    const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 7;
    const panelsM2 = round1(areaNet * (1 + wastePct / 100));
    const mortarKg = Math.ceil(areaNet * 8 * 1.08);
    const mortarBags25Kg = Math.ceil(mortarKg / 25);
    const meshM2 = round1(areaNet * 1.12);
    const anchorsCount = Math.ceil(areaNet * 6);

    return {
      title: '🛡️ *CÁLCULO DE MATERIALES — AISLAMIENTO TÉRMICO / SATE*',
      tradeType: 'waterproofing_insulation',
      summaryLines: [
        `🔹 *Superficie neta:* ${fmtNum(areaNet)} m²`,
        `🔹 *Paneles aislantes (+${fmtNum(wastePct)}% merma):* *${fmtNum(panelsM2)} m²*`
      ],
      auxLines: [
        `🧱 *Mortero adhesivo y regularizador SATE (8 kg/m²):* *${mortarBags25Kg} sacos de 25 kg* (${mortarKg} kg)`,
        `🕸️ *Malla de fibra de vidrio 160 g/m² (+12% solape):* *${fmtNum(meshM2)} m²*`,
        `🔩 *Espigas / Tacos de fijación mecánica (6 uds/m²):* *${anchorsCount} uds*`
      ],
      assumptions: [
        `Superficie: *${fmtNum(areaNet)} m²*`,
        `Merma en placas aislantes: *+${fmtNum(wastePct)}%*`,
        `Solape en malla de fibra: *+12%*`
      ],
      shoppingItems: [
        { description: 'Paneles de aislamiento térmico/acústico (EPS / XPS / Lana de roca)', qty: panelsM2, unit: 'm²' },
        { description: `Sacos de 25 kg de mortero termoaislante SATE (${mortarKg} kg)`, qty: mortarBags25Kg, unit: 'ud' },
        { description: 'Malla de fibra de vidrio antialcalina', qty: meshM2, unit: 'm²' },
        { description: 'Espigas mecánicas de fijación de aislamiento', qty: anchorsCount, unit: 'ud' }
      ]
    };
  }

  // Impermeabilización de terraza / cubierta (Tela asfáltica o Membrana líquida de poliuretano)
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 15; // +15% por solapes y subidas de mimbel
  const totalAreaWithOverlaps = round1(areaNet * (1 + wastePct / 100));
  const rollsAsphalt10M2 = Math.ceil(totalAreaWithOverlaps / 10);
  const liquidMembraneKg = Math.ceil(totalAreaWithOverlaps * 1.8); // 1,8 kg/m² en 2-3 manos
  const buckets25Kg = Math.ceil(liquidMembraneKg / 25);
  const primerKg = Math.ceil(areaNet * 0.3);

  return {
    title: '☔ *CÁLCULO DE MATERIALES — IMPERMEABILIZACIÓN*',
    tradeType: 'waterproofing_insulation',
    summaryLines: [
      `🔹 *Superficie en planta:* ${fmtNum(areaNet)} m²`,
      `🔹 *Superficie total con solapes y entregas en rodapié/mimbel (+${fmtNum(wastePct)}%):* *${fmtNum(totalAreaWithOverlaps)} m²*`
    ],
    auxLines: [
      `📜 *Opción A (Tela asfáltica / Lámina):* *${rollsAsphalt10M2} rollos de 10 m²* + *${primerKg} kg de imprimación asfáltica*`,
      `🪣 *Opción B (Membrana líquida poliuretano/caucho + malla):* *${buckets25Kg} bote(s) de 25 kg* (${liquidMembraneKg} kg a 1,8 kg/m²) + *${fmtNum(totalAreaWithOverlaps)} m² de velo/malla de refuerzo*`
    ],
    assumptions: [
      `Superficie neta: *${fmtNum(areaNet)} m²*`,
      `Suplemento por solapes (10 cm) y subidas perimetrales: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems: [
      { description: `Lámina impermeabilizante / Membrana (${fmtNum(totalAreaWithOverlaps)} m² con solapes)`, qty: totalAreaWithOverlaps, unit: 'm²' },
      { description: `Imprimación fijadora impermeabilización (${primerKg} kg)`, qty: primerKg, unit: 'ud' }
    ]
  };
}

/**
 * 12b. TEJADOS Y CUBIERTAS DE TEJA
 */
function calculateRoofing(params = {}) {
  const areaNet = Number(params.areaM2) || 40;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 8;
  const isCurved = /curva|arabe/i.test(params.rawText || '');
  const tilesPerM2 = isCurved ? 27 : 11; // Teja árabe ~27 uds/m²; Teja mixta/plana ~11 uds/m²

  const netTiles = Math.ceil(areaNet * tilesPerM2);
  const totalTilesWithWaste = Math.ceil(netTiles * (1 + wastePct / 100));
  const breathableFilmM2 = round1(areaNet * 1.15); // +15% solapes
  const battensLinearM = Math.ceil(areaNet * 3.1 * 1.08);
  const ridgePieces = Math.ceil(Math.sqrt(areaNet) * 3);

  return {
    title: '🏠 *CÁLCULO DE MATERIALES — TEJADO / CUBIERTA DE TEJA*',
    tradeType: 'roofing',
    summaryLines: [
      `🔹 *Superficie del faldón:* ${fmtNum(areaNet)} m² (${isCurved ? 'Teja curva/árabe ~27 uds/m²' : 'Teja mixta/plana ~11 uds/m²'})`,
      `🔹 *Tejas netas:* ${netTiles} uds`,
      `🔹 *Total tejas a pedir (+${fmtNum(wastePct)}% merma por cortes/roturas):* *${totalTilesWithWaste} tejas*`
    ],
    auxLines: [
      `🛡️ *Lámina impermeable transpirable bajo teja (+15% solape):* *${fmtNum(breathableFilmM2)} m²*`,
      `🪵 *Rastreles para teja:* *${battensLinearM} ml*`,
      `⛰️ *Caballetes de cumbrera estimados:* *~${ridgePieces} piezas*`
    ],
    assumptions: [
      `Superficie de cubierta: *${fmtNum(areaNet)} m²*`,
      `Rendimiento: *${tilesPerM2} tejas/m²*`,
      `Merma aplicada: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems: [
      { description: `${isCurved ? 'Teja curva / árabe' : 'Teja cerámica mixta / plana'} (+${fmtNum(wastePct)}% merma)`, qty: totalTilesWithWaste, unit: 'ud' },
      { description: 'Lámina impermeable transpirable bajo teja', qty: breathableFilmM2, unit: 'm²' },
      { description: 'Rastrel para cubierta de teja', qty: battensLinearM, unit: 'ml' },
      { description: 'Caballetes / piezas de cumbrera', qty: ridgePieces, unit: 'ud' }
    ]
  };
}

/**
 * 13a. CARPINTERÍA: PUERTAS Y VENTANAS
 */
function calculateWindowsDoors(params = {}) {
  const doors = Number(params.doorsCount) || 0;
  const windows = Number(params.windowsCount) || (doors === 0 ? 4 : 0);

  const items = [];
  const summaryLines = [];
  const auxLines = [];

  if (windows > 0) {
    const wPerim = 4.8; // perímetro medio ventana 1.20x1.20 m
    const totalPerim = round1(windows * wPerim);
    const foamCans = Math.max(1, Math.ceil(totalPerim / 9));
    const siliconeCartridges = Math.max(1, Math.ceil(totalPerim / 10));
    const turboScrews = windows * 8;

    summaryLines.push(`🔹 *Ventanas a instalar:* *${windows} ventana(s)* (~${fmtNum(totalPerim)} ml de junta perimetral)`);
    auxLines.push(`🧴 *Espuma de poliuretano (750 ml):* *${foamCans} bote(s)*`);
    auxLines.push(`💧 *Silicona neutra / Polímero MS sellado exterior-interior:* *${siliconeCartridges} cartucho(s)*`);
    auxLines.push(`🔩 *Tornillos de fijación directa (turbos 7,5×112 mm):* *${turboScrews} uds*`);

    items.push(
      { description: 'Bote de espuma de poliuretano 750 ml', qty: foamCans, unit: 'ud' },
      { description: 'Cartucho de silicona neutra / polímero MS', qty: siliconeCartridges, unit: 'ud' },
      { description: 'Tornillos marco ventana (turbos)', qty: turboScrews, unit: 'ud' }
    );
  }

  if (doors > 0) {
    const tapajuntasStrips = Math.ceil(doors * 5 * 1.10); // 5 tiras de 2,20 m por puerta (ambas caras) + 10%
    const foamCans = Math.max(1, Math.ceil(doors / 2.5));
    const adhesiveCartridges = Math.max(1, Math.ceil(doors / 3));

    summaryLines.push(`🔹 *Puertas de paso a instalar:* *${doors} puerta(s)*`);
    auxLines.push(`🪵 *Tiras de tapajuntas / jambas (5 por puerta + 10%):* *${tapajuntasStrips} tiras*`);
    auxLines.push(`🧴 *Espuma de poliuretano fijación de cercos:* *${foamCans} bote(s)*`);
    auxLines.push(`🔧 *Adhesivo de montaje para tapajuntas + puntas sin cabeza:* *${adhesiveCartridges} cartucho(s)*`);

    items.push(
      { description: 'Puerta de paso en block con herrajes y manivela', qty: doors, unit: 'ud' },
      { description: 'Tiras de tapajuntas / jambas de 2,20 m', qty: tapajuntasStrips, unit: 'ud' },
      { description: 'Bote de espuma de poliuretano para cercos', qty: foamCans, unit: 'ud' }
    );
  }

  return {
    title: '🪟 *CÁLCULO DE MATERIALES — VENTANAS Y PUERTAS*',
    tradeType: 'windows_doors',
    summaryLines,
    auxLines,
    assumptions: [
      ...(windows > 0 ? [`Ventanas: *${windows} uds*`] : []),
      ...(doors > 0 ? [`Puertas de paso: *${doors} uds* (5 tiras de tapajuntas por puerta)`] : [])
    ],
    shoppingItems: items
  };
}

/**
 * 13b. PAPEL PINTADO
 */
function calculateWallpaper(params = {}) {
  const heightM = Number(params.ceilingHeightM) || 2.50;
  const widthM = Number(params.roomWidthM) || Number(params.linearMeters) || (params.areaM2 ? round2(Number(params.areaM2) / heightM) : 4.0);
  const rollWidthM = 0.53;
  const rollLengthM = 10.05;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 10;

  const stripsNeeded = Math.ceil(widthM / rollWidthM);
  const stripHeightWithMargin = heightM + 0.15; // +15 cm por case/recorte superior e inferior
  const stripsPerRoll = Math.max(1, Math.floor(rollLengthM / stripHeightWithMargin));
  const rollsNeeded = Math.ceil((stripsNeeded / stripsPerRoll) * (1 + (wastePct - 5) / 100));
  const gluePacks = Math.max(1, Math.ceil(rollsNeeded / 5));

  return {
    title: '🖼️ *CÁLCULO DE MATERIALES — PAPEL PINTADO*',
    tradeType: 'wallpaper',
    summaryLines: [
      `🔹 *Paredes a cubrir:* ${fmtNum(widthM)} m de ancho total × ${fmtNum(heightM)} m de alto (${fmtNum(round2(widthM * heightM))} m²)`,
      `🔹 *Tiras verticales de 53 cm necesarias:* ${stripsNeeded} tiras (salen ${stripsPerRoll} tiras completas por cada rollo de 10 m)`,
      `🧻 *Rollos estándar (0,53 × 10,05 m) a comprar:* *${rollsNeeded} rollos*`
    ],
    auxLines: [
      `🪣 *Cola para papel pintado:* *${gluePacks} paquete(s)/bote(s)*`
    ],
    assumptions: [
      `Ancho total de pared: *${fmtNum(widthM)} m*`,
      `Altura de techo: *${fmtNum(heightM)} m* (+15 cm de margen de corte por tira)`,
      `Formato de rollo: *0,53 × 10,05 m*`
    ],
    shoppingItems: [
      { description: 'Rollos de papel pintado (0,53 × 10,05 m)', qty: rollsNeeded, unit: 'ud' },
      { description: 'Cola adhesiva para papel pintado', qty: gluePacks, unit: 'ud' }
    ]
  };
}

/**
 * 13c. CÉSPED ARTIFICIAL
 */
function calculateArtificialGrass(params = {}) {
  const areaNet = Number(params.areaM2) || 30;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 8;
  const totalGrassM2 = round1(areaNet * (1 + wastePct / 100));
  const geotextileM2 = round1(areaNet * 1.10);
  const jointTapeM = Math.ceil(areaNet * 0.6);
  const glueKg = Math.ceil(jointTapeM * 0.35);
  const staplesCount = Math.ceil(areaNet * 2.5);
  const silicaSandBags25Kg = Math.ceil((areaNet * 5) / 25);

  return {
    title: '🌿 *CÁLCULO DE MATERIALES — CÉSPED ARTIFICIAL*',
    tradeType: 'artificial_grass',
    summaryLines: [
      `🔹 *Superficie del jardín/terraza:* ${fmtNum(areaNet)} m²`,
      `🔹 *Césped artificial a comprar (+${fmtNum(wastePct)}% merma por recortes):* *${fmtNum(totalGrassM2)} m²*`
    ],
    auxLines: [
      `🕸️ *Malla geotextil antihierbas (+10% solape):* *${fmtNum(geotextileM2)} m²*`,
      `📏 *Banda de unión:* *${jointTapeM} ml* + *${glueKg} kg de cola de poliuretano*`,
      `📌 *Grapas de fijación:* *${staplesCount} uds*`,
      `🏖️ *Arena de sílice (opcional, 5 kg/m²):* *${silicaSandBags25Kg} sacos de 25 kg*`
    ],
    assumptions: [
      `Superficie neta: *${fmtNum(areaNet)} m²*`,
      `Merma por recortes y orientación de pelo: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems: [
      { description: 'Césped artificial (con merma incluida)', qty: totalGrassM2, unit: 'm²' },
      { description: 'Malla geotextil antihierbas', qty: geotextileM2, unit: 'm²' },
      { description: 'Banda de unión + adhesivo poliuretano', qty: jointTapeM, unit: 'ml' },
      { description: 'Sacos de 25 kg de arena de sílice', qty: silicaSandBags25Kg, unit: 'ud' }
    ]
  };
}

/**
 * 13d. ESCALERAS (PELDAÑOS, HUELLAS, TABICAS Y ZANQUÍN)
 */
function calculateStairs(params = {}) {
  const totalRiseM = Number(params.ceilingHeightM) || 2.80;
  // Ley de Blondel: 2 tabicas + 1 huella = 64 cm (tabica estándar ~17.5 cm, huella ~29 cm)
  const stepsCount = Number(params.stepsCount) || Math.round(totalRiseM / 0.175);
  const stairWidthM = Number(params.stairWidthM) || 1.00;
  const wastePct = params.wastePct !== undefined ? Number(params.wastePct) : 10;

  const treadDepthM = 0.30; // huella 30 cm
  const riserHeightM = round2(totalRiseM / stepsCount); // contrahuella/tabica
  const totalTreads = Math.ceil(stepsCount * (1 + wastePct / 100));
  const totalRisers = Math.ceil(stepsCount * (1 + wastePct / 100));
  const totalSurfaceM2 = round2(stepsCount * stairWidthM * (treadDepthM + riserHeightM) * (1 + wastePct / 100));
  const adhesiveBags25Kg = Math.max(1, Math.ceil((totalSurfaceM2 * 6) / 25));
  const zanquinesCount = stepsCount * 2;

  return {
    title: '🪜 *CÁLCULO DE MATERIALES — ESCALERA (PELDAÑOS)*',
    tradeType: 'stairs',
    summaryLines: [
      `🔹 *Tramo de escalera:* *${stepsCount} peldaños* de ${fmtNum(stairWidthM)} m de ancho (contrahuella media de ${fmtNum(riserHeightM * 100, 1)} cm y huella de 30 cm)`,
      `🔹 *Huellas a pedir (+${fmtNum(wastePct)}% merma):* *${totalTreads} piezas* de ${fmtNum(stairWidthM * 100)}×30 cm`,
      `🔹 *Tabicas / Contrahuellas (+${fmtNum(wastePct)}% merma):* *${totalRisers} piezas* de ${fmtNum(stairWidthM * 100)}×${fmtNum(riserHeightM * 100, 1)} cm`
    ],
    auxLines: [
      `📐 *Zanquines / Rodapié de escalera:* *${zanquinesCount} piezas*`,
      `🧱 *Cemento cola C2TE / Adhesivo:* *${adhesiveBags25Kg} saco(s) de 25 kg*`
    ],
    assumptions: [
      `Número de peldaños: *${stepsCount} peldaños*`,
      `Ancho de peldaño: *${fmtNum(stairWidthM)} m*`,
      `Merma por cortes: *+${fmtNum(wastePct)}%*`
    ],
    shoppingItems: [
      { description: `Huellas de peldaño (${fmtNum(stairWidthM * 100)}×30 cm)`, qty: totalTreads, unit: 'ud' },
      { description: `Tabicas / Contrahuellas (${fmtNum(stairWidthM * 100)}×${fmtNum(riserHeightM * 100, 1)} cm)`, qty: totalRisers, unit: 'ud' },
      { description: 'Zanquines laterales de escalera', qty: zanquinesCount, unit: 'ud' },
      { description: 'Saco de 25 kg de cemento cola C2TE', qty: adhesiveBags25Kg, unit: 'ud' }
    ]
  };
}

/**
 * 13e. DEMOLICIÓN, ESCOMBROS, SACAS BIG-BAG Y CONTENEDORES
 */
function calculateDemolition(params = {}) {
  const areaM2 = Number(params.areaM2) || 20;
  const thicknessCm = Number(params.thicknessCm) || 8; // 8 cm tabique/solado medio
  const swellFactor = 1.45; // +45% coeficiente de esponjamiento del escombro al romperse

  const solidVolumeM3 = round2(areaM2 * (thicknessCm / 100));
  const looseVolumeM3 = round2(solidVolumeM3 * swellFactor);
  const weightTons = round2(solidVolumeM3 * 1.4);

  const smallBags25L = Math.ceil((looseVolumeM3 * 1000) / 25);
  const bigBags1M3 = Math.ceil(looseVolumeM3);
  const containers5M3 = Math.max(1, Math.ceil(looseVolumeM3 / 5));

  return {
    title: '🔨 *CÁLCULO DE ESCOMBROS Y CONTENEDORES — DEMOLICIÓN*',
    tradeType: 'demolition',
    summaryLines: [
      `🔹 *Superficie y espesor a demoler/picar:* ${fmtNum(areaM2)} m² × ${fmtNum(thicknessCm)} cm`,
      `🔹 *Volumen macizo:* ${fmtNum(solidVolumeM3)} m³ → *Volumen real esponjado (+45% al picar):* *${fmtNum(looseVolumeM3)} m³*`,
      `⚖️ *Peso estimado:* *~${fmtNum(weightTons)} toneladas*`
    ],
    auxLines: [
      `🛍️ *En sacos de escombro de 25 L:* *~${smallBags25L} sacos*`,
      `📦 *En sacas Big-Bag de 1 m³:* *${bigBags1M3} saca(s) Big-Bag*`,
      `🚛 *En contenedores de obra (de 5 m³):* *${containers5M3} contenedor(es)*`
    ],
    assumptions: [
      `Superficie: *${fmtNum(areaM2)} m²*`,
      `Espesor medio picado/tabique: *${fmtNum(thicknessCm)} cm*`,
      `Coeficiente de esponjamiento estándar: *+45% (×1,45)*`
    ],
    shoppingItems: [
      { description: `Sacas Big-Bag de 1 m³ para escombro (${fmtNum(looseVolumeM3)} m³ esponjados)`, qty: bigBags1M3, unit: 'ud' },
      { description: 'Sacos de rafia reforzados de 25 L para escombro', qty: smallBags25L, unit: 'ud' }
    ]
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTADOR PRINCIPAL Y FORMATEADOR PARA WHATSAPP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta el cálculo técnico de materiales y mermas para cualquier oficio
 * y devuelve tanto el objeto estructurado como el mensaje formateado para WhatsApp.
 *
 * @param {object} input - { tradeType, params, rawText, customCalculatedItems }
 * @returns {object} { title, tradeType, params, summaryLines, auxLines, assumptions, shoppingItems, whatsappText }
 */
export function calculateConstructionMaterials(input = {}) {
  const rawParams = { ...(input.params || input), rawText: input.rawText || input.params?.rawText || '' };
  const tradeType = input.tradeType || rawParams.tradeType || 'tiling';

  let result;
  switch (tradeType) {
    case 'tiling':
      result = calculateTiling(rawParams);
      break;
    case 'painting':
      result = calculatePainting(rawParams);
      break;
    case 'microcement':
      result = calculateMicrocement(rawParams);
      break;
    case 'skirting':
      result = calculateSkirting(rawParams);
      break;
    case 'flooring':
      result = calculateFlooring(rawParams);
      break;
    case 'drywall_pladur':
      result = calculateDrywallPladur(rawParams);
      break;
    case 'brickwork':
      result = calculateBrickwork(rawParams);
      break;
    case 'concrete_screed':
      result = calculateConcreteScreed(rawParams);
      break;
    case 'plaster_render':
      result = calculatePlasterRender(rawParams);
      break;
    case 'plumbing':
      result = calculatePlumbing(rawParams);
      break;
    case 'underfloor_heating':
      result = calculateUnderfloorHeating(rawParams);
      break;
    case 'electrical':
      result = calculateElectrical(rawParams);
      break;
    case 'hvac':
      result = calculateHvac(rawParams);
      break;
    case 'waterproofing_insulation':
      result = calculateWaterproofingInsulation(rawParams);
      break;
    case 'roofing':
      result = calculateRoofing(rawParams);
      break;
    case 'windows_doors':
      result = calculateWindowsDoors(rawParams);
      break;
    case 'wallpaper':
      result = calculateWallpaper(rawParams);
      break;
    case 'artificial_grass':
      result = calculateArtificialGrass(rawParams);
      break;
    case 'stairs':
      result = calculateStairs(rawParams);
      break;
    case 'demolition':
      result = calculateDemolition(rawParams);
      break;
    default: {
      // Fallback universal si Gemini envía customCalculatedItems para cualquier otro proceso especial
      if (Array.isArray(input.customCalculatedItems) && input.customCalculatedItems.length > 0) {
        result = {
          title: `📐 *CÁLCULO TÉCNICO DE MATERIALES Y MERMAS*`,
          tradeType: 'custom',
          summaryLines: input.customCalculatedItems.map(
            it => `🔹 *${it.description}:* *${fmtNum(it.qty)} ${it.unit || 'ud'}*${it.note ? ` _(${it.note})_` : ''}`
          ),
          auxLines: [],
          assumptions: input.assumptions || ['Cálculo adaptado a las medidas indicadas por el profesional.'],
          shoppingItems: input.customCalculatedItems.map(it => ({
            description: it.description,
            qty: Number(it.qty) || 1,
            unit: it.unit || 'ud'
          }))
        };
      } else {
        result = calculateTiling(rawParams);
      }
      break;
    }
  }

  result.params = rawParams;
  result.clientName = rawParams.clientName || input.clientName || null;
  result.whatsappText = formatMaterialCalculationForWhatsApp(result);
  return result;
}

/**
 * Formatea el resultado del cálculo de materiales para enviarlo por WhatsApp.
 */
export function formatMaterialCalculationForWhatsApp(calcResult) {
  const lines = [
    calcResult.title,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  if (calcResult.clientName) {
    lines.push(`👤 *Obra / Cliente:* ${calcResult.clientName}\n`);
  }

  for (const sLine of (calcResult.summaryLines || [])) {
    lines.push(sLine);
  }

  if (calcResult.auxLines && calcResult.auxLines.length > 0) {
    lines.push('');
    lines.push('🧰 *Materiales complementarios necesarios:*');
    for (const aLine of calcResult.auxLines) {
      lines.push(aLine);
    }
  }

  if (calcResult.assumptions && calcResult.assumptions.length > 0) {
    lines.push('');
    lines.push('📏 *Datos aplicados en el cálculo:*');
    for (const asLine of calcResult.assumptions) {
      lines.push(`  • ${asLine}`);
    }
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 _Si alguna medida, altura o % de merma varía en tu obra, dímelo (ej: «ponle un 15% de merma» o «la subida es a 1,25 m») y te lo recalculo al instante._');
  lines.push('🛒 _Di *«añádelo a la lista de la compra»* para guardarlo en compras, o *«añádelo al presupuesto»* para incluir estas cantidades en el PDF del presupuesto._');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// INTEGRACIÓN DIRECTA CON PRESUPUESTOS (CÁLCULO DE OBRA COMPLETA Y PDF)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detecta si dentro de un mensaje o audio de creación/edición de presupuesto
 * el autónomo pide además calcular los materiales o incluir las cantidades en el PDF del presupuesto.
 *
 * @param {string} text
 * @returns {{ sendCalculationInChat: boolean, includeInBudgetPdf: boolean } | null}
 */
export function detectInlineBudgetMaterialRequest(text = '') {
  if (!text || typeof text !== 'string') return null;
  const n = norm(text);

  const includeInBudgetPdf = /\b(?:pon(?:lo|me|er)?\s+en\s+el\s+presupuesto|incluye?(?:lo|me)?\s+en\s+el\s+presupuesto|anad(?:e|elo|ir)\s+al\s+presupuesto|que\s+salga\s+en\s+el\s+presupuesto|mete(?:lo)?\s+en\s+el\s+presupuesto)\s+(?:tambien\s+)?(?:cuant[oa]s?\s+(?:azulejos?|baldosas?|botes?|litros?|sacos?|placas?|ladrillos?|tiras?|rodapies?|metros?|material(?:es)?)|los\s+materiales|el\s+material|la\s+cantidad\s+de\s+material|el\s+cubicaje)/i.test(n)
    || /\b(?:cuant[oa]s?\s+(?:azulejos?|baldosas?|botes?|sacos?|placas?|ladrillos?|tiras?|material(?:es)?)\s+(?:tiene\s+que\s+comprar|necesita|entran|hacen\s+falta).*?\b(?:en\s+el\s+presupuesto|dentro\s+del\s+presupuesto))\b/i.test(n);

  const sendCalculationInChat = includeInBudgetPdf
    || /\b(?:y\s+)?(?:calcula(?:me|r)?|sacame|dime|hazme\s+el\s+calculo\s+de)\s+(?:tambien\s+)?(?:los\s+materiales|el\s+material|el\s+cubicaje|cuant[oa]s?\s+(?:azulejos?|baldosas?|botes?|litros?|sacos?|placas?|ladrillos?|tiras?|rodapies?|metros?|material(?:es)?))\b/i.test(n);

  if (!includeInBudgetPdf && !sendCalculationInChat) {
    return null;
  }

  return {
    sendCalculationInChat: true,
    includeInBudgetPdf
  };
}

/**
 * Construye una línea resumen técnica y compacta de los materiales calculados
 * lista para insertarse en la descripción de una partida del PDF del presupuesto.
 */
export function buildCompactMaterialNote(calcResult) {
  if (!calcResult || !Array.isArray(calcResult.shoppingItems) || calcResult.shoppingItems.length === 0) {
    return '';
  }
  const parts = calcResult.shoppingItems.slice(0, 4).map(it => {
    const cleanDesc = String(it.description || '').replace(/\s+/g, ' ').trim();
    if (it.unit === 'ud' && /\b(?:sacos?|botes?|bolsas?|cajas?|placas?|rollos?|tiras?|cartuchos?)\b/i.test(cleanDesc)) {
      return `${fmtNum(it.qty)} × ${cleanDesc}`;
    }
    return `${fmtNum(it.qty)} ${it.unit || 'ud'} de ${cleanDesc}`;
  });
  return `📐 Materiales estimados (merma incl.): ${parts.join(' + ')}`;
}

/**
 * Analiza todas las partidas de un presupuesto, calcula los materiales y mermas
 * de cada partida reconocible y opcionalmente enriquece las descripciones del presupuesto.
 *
 * @param {object} budget - Objeto de presupuesto con items[]
 * @param {object} [options] - { enrichDescriptions: boolean }
 * @returns {object|null} Resultado agregado o null si ninguna partida tiene cálculo de materiales aplicable
 */
export function calculateMaterialsForBudget(budget, options = {}) {
  if (!budget || !Array.isArray(budget.items) || budget.items.length === 0) {
    return null;
  }

  const itemCalculations = [];
  const allShoppingItems = [];

  for (let i = 0; i < budget.items.length; i++) {
    const item = budget.items[i];
    const combinedText = `${item.sourcePhrase || ''} ${item.description || ''}`.trim();
    if (!combinedText) continue;

    const extracted = extractMaterialParameters(combinedText);
    const unitNorm = norm(item.unit || '');
    const qtyNum = Number(item.qty) || 0;

    if (qtyNum > 0) {
      if ((unitNorm === 'm2' || unitNorm === 'm²') && !extracted.areaM2) {
        extracted.areaM2 = qtyNum;
      } else if ((unitNorm === 'ml' || unitNorm === 'm') && !extracted.linearMeters) {
        extracted.linearMeters = qtyNum;
      } else if (unitNorm === 'ud' && extracted.tradeType === 'windows_doors') {
        if (/puerta/i.test(combinedText) && !extracted.doorsCount) extracted.doorsCount = qtyNum;
        if (/ventana/i.test(combinedText) && !extracted.windowsCount) extracted.windowsCount = qtyNum;
      }
    }

    if (!extracted.tradeType) continue;

    const calcResult = calculateConstructionMaterials({
      tradeType: extracted.tradeType,
      params: extracted,
      rawText: combinedText,
      clientName: budget.client?.name || null
    });

    const compactSummary = buildCompactMaterialNote(calcResult);

    if (options.enrichDescriptions && compactSummary) {
      const currentDesc = String(item.description || '');
      if (!currentDesc.includes('📐 Materiales estimados')) {
        item.description = `${currentDesc}\n   [${compactSummary}]`;
      }
    }

    itemCalculations.push({
      itemIndex: i,
      itemDescription: item.description,
      calcResult,
      compactSummary
    });

    for (const sItem of (calcResult.shoppingItems || [])) {
      allShoppingItems.push({
        ...sItem,
        clientName: budget.client?.name || null,
        budgetId: budget.id || null
      });
    }
  }

  if (itemCalculations.length === 0) {
    return null;
  }

  const clientName = budget.client?.name || 'Cliente';
  const lines = [
    `📐 *CUBICAJE Y MATERIALES DEL PRESUPUESTO ${budget.id || ''}*`.trim(),
    `👤 *Cliente:* ${clientName}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  itemCalculations.forEach((ic, idx) => {
    const cleanTitle = ic.calcResult.title.replace(/^[^\wÁÉÍÓÚÑáéíóúñ]*\*/, '*').replace(/CÁLCULO DE MATERIALES — /g, '');
    lines.push(`\n*${idx + 1}.* ${cleanTitle}`);
    for (const sLine of (ic.calcResult.summaryLines || [])) {
      lines.push(`   ${sLine}`);
    }
    for (const aLine of (ic.calcResult.auxLines || [])) {
      lines.push(`   ${aLine}`);
    }
  });

  lines.push('\n━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('🛒 _Di *«añádelo a la lista de la compra»* para guardar todos estos materiales en las compras de esta obra._');
  if (!options.enrichDescriptions) {
    lines.push('📄 _Di *«añádelo al presupuesto»* si quieres que estas cantidades de material aparezcan escritas dentro del PDF del presupuesto._');
  }

  const singleOrFirst = itemCalculations[0].calcResult;

  return {
    isBudgetMaterialCalculation: true,
    budgetId: budget.id || null,
    clientName: budget.client?.name || null,
    tradeType: singleOrFirst.tradeType,
    params: singleOrFirst.params,
    itemCalculations,
    shoppingItems: allShoppingItems,
    whatsappText: lines.join('\n')
  };
}

/**
 * Inyecta un cálculo de materiales (individual o de presupuesto completo)
 * dentro de las descripciones de las partidas de un presupuesto para que aparezca en el PDF.
 */
export function applyMaterialCalculationToBudget(budget, calcResult) {
  if (!budget || !Array.isArray(budget.items) || !calcResult) {
    return { updated: false, noteAdded: '' };
  }

  if (calcResult.isBudgetMaterialCalculation && Array.isArray(calcResult.itemCalculations)) {
    const notes = [];
    for (const ic of calcResult.itemCalculations) {
      const targetItem = budget.items[ic.itemIndex];
      const note = ic.compactSummary || buildCompactMaterialNote(ic.calcResult);
      if (targetItem && note && !String(targetItem.description || '').includes('📐 Materiales estimados')) {
        targetItem.description = `${targetItem.description}\n   [${note}]`;
        notes.push(note);
      }
    }
    return { updated: notes.length > 0, noteAdded: notes.join(' | ') };
  }

  const note = buildCompactMaterialNote(calcResult);
  if (!note) return { updated: false, noteAdded: '' };

  // Buscar la partida cuyo oficio coincida con calcResult.tradeType
  let matchedItem = null;
  for (const item of budget.items) {
    const ext = extractMaterialParameters(`${item.sourcePhrase || ''} ${item.description || ''}`);
    if (ext.tradeType === calcResult.tradeType) {
      matchedItem = item;
      break;
    }
  }
  if (!matchedItem && budget.items.length > 0) {
    matchedItem = budget.items[budget.items.length - 1];
  }

  if (matchedItem) {
    const currentDesc = String(matchedItem.description || '');
    // Si ya tenía una nota previa de materiales estimados, reemplazarla (p.ej. tras un recálculo con nueva merma)
    if (currentDesc.includes('[📐 Materiales estimados')) {
      matchedItem.description = currentDesc.replace(/\[📐 Materiales estimados[^\]]*\]/, `[${note}]`);
    } else {
      matchedItem.description = `${currentDesc}\n   [${note}]`;
    }
    return { updated: true, noteAdded: note, matchedItem };
  }

  return { updated: false, noteAdded: '' };
}
