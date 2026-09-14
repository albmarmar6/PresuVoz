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
      regex: /(cambiar|poner|adecuar|revisar)?\s*(el)?\s*(?:diferencial|magnetot[eé]rmico|cuadro\s*(?:el[eé]ctrico)?|soporte\s*el[eé]ctrico|instalaci[oó]n\s*el[eé]ctrica)/i,
      formal: "Adecuación de cuadro general de mando y protección e instalación eléctrica"
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
      regex: /(l[ií]nea\s*frigor[ií]fica|tubos?\s*frigor[ií]ficos|soporte\s*(?:exterior|silentblock|clima|para\s+split))/i,
      formal: "Tendido de línea frigorífica aislada, soportes exteriores con amortiguadores antivibratorios silentblock y línea de desagüe"
    },

    // Pintura y Acabados
    {
      regex: /(pintura|pintar|enlucir|alisar)/i,
      formal: "Preparación de paramentos, emplastecido y aplicación de pintura plástica lisa de alta cubrición en techos y paredes"
    },

    // Capítulos de Reforma Integral y Edificación
    {
      regex: /(?:demoliciones?\s+y\s+(?:de\s+)?escombros?|desescombro|demoliciones\s+generales)/i,
      formal: "Demolición de revestimientos, tabiquería interior y retirada de escombros a vertedero homologado"
    },
    {
      regex: /(?:albañiler[ií]a\s+general|distribuci[oó]n|enmaestrado|maestreado|regresi[oó]n|recrecido|falso\s*techo\s*de\s*pladur)/i,
      formal: "Albañilería general, redistribución de tabiquería, trasdosados de pladur y recrecido autonivelante de suelos"
    },
    {
      regex: /(?:fontaner[ií]a\s+y\s+saneamiento|saneamiento|multicapa|polietileno\s*reticulado|red\s*(?:completa)?\s*(?:de\s+agua)?)/i,
      formal: "Instalación integral de fontanería y saneamiento con red de tubería multicapa / polietileno reticulado y desagües"
    },
    {
      regex: /(?:electricidad\s+y\s+telecomunicaciones|telecomunicaciones|rbt|rebt)/i,
      formal: "Instalación eléctrica y telecomunicaciones según REBT con nuevo cuadro general de mando y protecciones"
    },
    {
      regex: /(?:alicatados?\s*y\s*solados?|alicatar\s*y\s*solar|porcel[aá]nico|grespe)/i,
      formal: "Suministro y colocación de alicatados y solados en gres porcelánico con adhesivo flexible C2TE y rejuntado"
    },

    // Demolición y Tabiquería / Reforma Integral
    {
      regex: /(quitar|tirar|demoler|derribar)\s*(las)?\s*(paredes?|tabiques?)|reforma\s*integral/i,
      formal: "Demolición y derribo de tabiquería interior en estancias señaladas, desescombro y transporte a vertedero homologado"
    },
    {
      regex: /(cambiar|poner|sustituir|renovar)?\s*(el)?\s*suelo\s*(del)?\s*(baño|cocina|piso)/i,
      formal: "Suministro e instalación de pavimento cerámico en cuarto de baño con mortero de agarre"
    },

    // Carpintería y Reformas
    {
      regex: /(ventanas?|reestructuraci[oó]n\s+de\s+(?:las\s+)?ventanas?|carpinter[ií]a\s+exterior|climalit|pvc|aluminio)/i,
      formal: "Suministro e instalación de carpintería exterior y ventanas con doble acristalamiento aislante"
    },
    {
      regex: /(remoquetar|moqueta|zarum|zaguan|entarimado)/i,
      formal: "Suministro y colocación de revestimiento textil continuo (moqueta de alto tránsito) o entarimado en estancia"
    },
    {
      regex: /(cambiar|poner|sustituir|renovar|solado|pavimento)?\s*(el)?\s*suelo(\s*(?:del?)?\s*(?:baño|cocina|piso|vivienda|casa))?/i,
      formal: "Suministro e instalación de pavimento cerámico y solado con mortero de agarre"
    },
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
    /hola\s+(buenas\s+tardes|buenos\s+d[ií]as|qu[eé]\s+tal)?/gi,
    /me\s+gustar[ií]a\s+presupuestar(\s+una\s+casa)?/gi,
    /eso\s+(lo\s+)?llevar[ií]a\s+(a|en|aún|aun|un)?\s*(total\s+de)?/gi,
    /(?:y\s+)?(?:eso|esto)\s+(?:ser[ií]a|es|va\s+a\s+ser)\s+todo/gi,
    /(?:y\s+)?ya\s+est[aá]/gi,
    /(?:y\s+)?nada\s+m[aá]s/gi,
    /(?:con\s+eso\s+(?:acabamos|terminamos|estar[ií]a))/gi,
    /(?:suministros?\s+(?:eh\s*)?te\s+voy\s+a\s+decir\s+lo\s+que\s+va\s+a\s+costar|suministros?\s+eh\b)/gi,
    /te\s+voy\s+a\s+decir\s+lo\s+que\s+va\s+a\s+costar/gi,
    /(?:eso\s+)?va\s+a\s+salir\s+por\s+(?:unos?\s+|uno\s+o\s+)?/gi,
    /(?:eso\s+)?va\s+a\s+costar\s+(?:unos?\s+|uno\s+o\s+)?/gi,
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
   * Índice geográfico de referencia: provincias, municipios y barrios destacados
   */
  static SPANISH_GEO_INDEX = {
    "Sevilla": {
      province: "Sevilla",
      aliases: ["sevilla"],
      municipalities: [
        "sevilla", "dos hermanas", "alcala de guadaira", "utrera", "mairena del aljarafe",
        "ecija", "la rinconada", "los palacios", "los palacios y villafranca", "coria del rio",
        "carmona", "moron de la frontera", "moron", "lebrija", "camas", "tomares",
        "mairena del alcor", "san juan de aznalfarache", "bormujos", "marchena", "arahal",
        "el viso del alcor", "lora del rio", "osuna", "castilleja de la cuesta",
        "las cabezas de san juan", "la algaba", "espartinas", "gines", "sanlucar la mayor",
        "pilas", "guillena", "brenes", "estepa", "puebla del rio", "bollullos de la mitacion",
        "cantillana", "torreblanca", "triana", "nervion", "macarena", "los remedios", "aljarafe"
      ]
    },
    "Madrid": {
      province: "Madrid",
      aliases: ["madrid"],
      municipalities: [
        "madrid", "mostoles", "alcala de henares", "fuenlabrada", "leganes", "getafe",
        "alcorcon", "torrejon de ardoz", "parla", "alcobendas", "las rozas",
        "san sebastian de los reyes", "rivas", "rivas-vaciamadrid", "pozuelo de alarcon", "pozuelo",
        "coslada", "valdemoro", "majadahonda", "collado villalba", "villalba", "aranjuez",
        "arganda del rey", "arganda", "boadilla del monte", "boadilla", "pinto", "colmenar viejo",
        "san fernando de henares", "tres cantos", "galapagar", "villaviciosa de odon"
      ]
    },
    "Barcelona": {
      province: "Barcelona",
      aliases: ["barcelona", "barna"],
      municipalities: [
        "barcelona", "hospitalet de llobregat", "hospitalet", "badalona", "terrassa", "tarrasa",
        "sabadell", "mataro", "santa coloma de gramenet", "sant cugat", "sant cugat del valles",
        "cornella de llobregat", "cornella", "sant boi de llobregat", "sant boi", "rubi",
        "manresa", "vilanova i la geltru", "viladecans", "castelldefels", "el prat de llobregat",
        "granollers", "cerdanyola del valles", "mollet del valles", "vic", "esplugues de llobregat",
        "gava", "sant feliu de llobregat", "igualada", "ripollet"
      ]
    },
    "Valencia": {
      province: "Valencia",
      aliases: ["valencia", "valencia"],
      municipalities: [
        "valencia", "torrent", "torrente", "gandia", "paterna", "sagunto",
        "alzira", "mislata", "burjassot", "ontinyent", "onteniente", "aldaia", "manises",
        "alaquas", "xativa", "jativa", "chirivella", "xirivella", "sueca", "catarroja",
        "algemesi", "paiporta", "oliva", "quart de poblet", "alboraya", "betera"
      ]
    },
    "Málaga": {
      province: "Málaga",
      aliases: ["malaga"],
      municipalities: [
        "malaga", "marbella", "mijas", "fuengirola", "velez-malaga", "torremolinos",
        "benalmadena", "estepona", "rincon de la victoria", "antequera", "alhaurin de la torre",
        "ronda", "cartama", "alhaurin el grande", "coin", "nerja", "manilva"
      ]
    },
    "Cantabria": {
      province: "Cantabria",
      aliases: ["cantabria", "santander"],
      municipalities: [
        "santander", "torrelavega", "torrelavella", "castro urdiales", "camargo", "pielagos",
        "el astillero", "laredo", "santona", "los corrales de buelna", "reinosa",
        "cabezon de la sal", "suances", "colindres", "reocin", "medio cudeyo"
      ]
    },
    "Alicante": {
      province: "Alicante",
      aliases: ["alicante", "alacant"],
      municipalities: [
        "alicante", "elche", "elx", "torrevieja", "orihuela", "benidorm", "alcoy", "alcoi",
        "elda", "san vicente del raspeig", "denia", "villena", "petrer", "santa pola",
        "villajoyosa", "javea", "xabia", "calpe", "crevillente", "el campello"
      ]
    },
    "Cádiz": {
      province: "Cádiz",
      aliases: ["cadiz"],
      municipalities: [
        "cadiz", "jerez de la frontera", "jerez", "algeciras", "san fernando",
        "el puerto de santa maria", "el puerto", "chiclana de la frontera", "chiclana",
        "sanlucar de barrameda", "la linea de la concepcion", "la linea", "puerto real",
        "arcos de la frontera", "san roque", "rota", "barbate", "conil de la frontera", "tarifa"
      ]
    },
    "Zaragoza": {
      province: "Zaragoza",
      aliases: ["zaragoza"],
      municipalities: [
        "zaragoza", "calatayud", "utebo", "ejea de los caballeros", "tarazona", "caspe",
        "cuarte de huerva", "la almunia de dona godina", "zuera"
      ]
    }
  };

  /**
   * Elimina tildes y diacríticos para comparaciones fonético-léxicas
   */
  static stripAccents(str) {
    if (!str) return "";
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  /**
   * Calcula la similitud relativa entre dos cadenas mediante distancia de Levenshtein (0 a 1)
   */
  static stringSimilarity(str1, str2) {
    const s1 = this.stripAccents(str1);
    const s2 = this.stripAccents(str2);
    if (s1 === s2) return 1.0;
    if (s1.includes(s2) || s2.includes(s1)) return 0.85;

    const m = s1.length, n = s2.length;
    if (m === 0 || n === 0) return 0;

    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    const maxLen = Math.max(m, n);
    return maxLen === 0 ? 1.0 : (1.0 - dp[m][n] / maxLen);
  }

  /**
   * Convierte expresiones numéricas coloquiales o en letras a número
   */
  static parsePriceString(str) {
    if (!str) return 0;
    const cleaned = str.replace(/pavos|eurillos|euros|€/gi, "").trim();
    const directNum = parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
    if (!isNaN(directNum) && directNum > 0) return directNum;

    const words = cleaned.toLowerCase().split(/\s+/);
    let total = 0, current = 0;
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
   * Extrae el importe de una frase soportando rangos de precios (Math.max en obra),
   * fallos fonéticos de transcripción de Whisper (ej. 4.205.000 -> 5.000) y formatos mixtos.
   */
  static extractPrice(str) {
    if (!str || typeof str !== "string") return 0;

    // 1. Whisper phonetic glitch: "4.205.000" (significa "4.200 a 5.000")
    const whisperGlitch = str.match(/\b([1-9])\.(\d{2,3})([1-9])\.000\b/);
    if (whisperGlitch) {
      const high = parseInt(whisperGlitch[3], 10) * 1000;
      return high;
    }

    // 2. Rango con separador: "4.500 a 6000", "8.000 a 11.000", "4.000 y 5.500", "5.500 7.500"
    const rangeMatch = str.match(/(?:(?:de|entre|unos?)\s+)?(\d+(?:[\.,]\d{3})*|\d+)\s*(?:a|y|-|hasta|\s+)\s*(\d+(?:[\.,]\d{3})*|\d+)\s*(?:euros?|pavos|€)?/i);
    if (rangeMatch) {
      const clean1 = parseFloat(rangeMatch[1].replace(/\./g, "").replace(",", "."));
      const clean2 = parseFloat(rangeMatch[2].replace(/\./g, "").replace(",", "."));
      if (!isNaN(clean1) && !isNaN(clean2) && clean1 > 0 && clean2 > 0) {
        return Math.max(clean1, clean2);
      }
    }

    // 3. Número con unidad monetaria ("por cuatrocientos pavos", "por 250 euros", "300 euros")
    const moneyMatch = str.match(/(?:(?:a|en|aún|aun|un)?\s*total\s+de\s+|por\s+|de\s+|costar\s+|salir\s+por\s+|[:\s])?((?:\d+(?:[\.,]\d{1,3})*|\b(?:(?:mil|doscient[ao]s|trescient[ao]s|cuatrocient[ao]s|quinient[ao]s|seiscient[ao]s|setecient[ao]s|ochocient[ao]s|novecient[ao]s|cien|ciento|veinte|veinti[a-záéíóúñ]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|diez|once|doce|trece|catorce|quince|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\s*(?:y\s*)?)+))\s*(?:euros?|pavos|€)\b/i);
    if (moneyMatch) {
      return this.parsePriceString(moneyMatch[1].trim());
    }

    return this.parsePriceString(str);
  }

  /**
   * Extrae descuentos dictados por el usuario (% o importe fijo)
   */
  static extractDiscount(text) {
    if (!text || typeof text !== "string") return null;

    const pctMatch = text.match(/(?:descuento|rebaja)\s+(?:del?\s+)?(\d{1,2}|diez|quince|veinte|veinticinco)\s*(?:%|por\s*ciento)?/i);
    if (pctMatch) {
      const numWords = { "diez": 10, "quince": 15, "veinte": 20, "veinticinco": 25 };
      const val = numWords[pctMatch[1].toLowerCase()] || parseInt(pctMatch[1], 10);
      if (!isNaN(val) && val > 0 && val <= 100) {
        return { type: "percentage", value: val };
      }
    }

    const fixedMatch = text.match(/(?:descuento|rebaja)\s+(?:de\s+)?(\d+(?:[\.,]\d{1,2})?)\s*(?:euros?|pavos|€)/i);
    if (fixedMatch) {
      const val = parseFloat(fixedMatch[1].replace(/\./g, "").replace(",", "."));
      if (!isNaN(val) && val > 0) {
        return { type: "fixed", value: val };
      }
    }

    return null;
  }

  /**
   * Extrae el nombre del cliente eliminando preposiciones y fórmulas de cortesía
   */
  static extractClientName(text) {
    const match = text.match(/(?:para|cliente:?)\s+(?:don|doña)?\s*((?:(?!en\b|de\b|del\b|la\b|el\b|calle\b|avenida\b)[a-záéíóúñ]+\s*){1,3})(?=\s+(?:en|con|de|del|para|que|la|el|donde|se|calle|avenida)\b|:|$)/i);
    if (match) {
      return match[1].trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
    }
    return "Cliente Particular";
  }

  /**
   * Extrae la dirección o ubicación de la obra (calles o localidades)
   */
  static extractAddress(text) {
    if (!text || typeof text !== "string") return "Ubicación obra según visita técnica";

    // 1. Calle / Avenida tradicional (con o sin provincia antes o después)
    let streetMatch = text.match(/(?:(?:en|de)\s+(?:la\s+)?)?((?:calle|avenida|avda\.?|plaza|paseo|camino|carretera)\s+[a-záéíóúñ0-9\s,\.\-ºª°/]+?)(?=\s+(?:hacer|cambiar|poner|instalar|quitar|tirar|demoler|derribar|remoquetar|reparar|reformar|alicatar|reestructuraci[oó]n|suministro|mampara|plato|bañera|suelo|tabique|con|para|hay|habr[ií]a|donde|que\s+va|y\s+vamos|y\s+hay|\d+\s*(?:euros?|pavos|€))\b|:|$)/i);
    if (streetMatch) {
      let rawStreet = streetMatch[1].trim().replace(/[:,\.\-]+$/, "");
      rawStreet = rawStreet.replace(/\s+numero\s+/i, " nº ").replace(/\s*,\s*/g, ", ");
      let formattedStreet = rawStreet.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

      // Detectar si se mencionó una provincia / ciudad en el texto (ej: "en sevilla en la calle...")
      const knownProvs = ["Sevilla", "Madrid", "Barcelona", "Valencia", "Málaga", "Cantabria", "Alicante", "Cádiz", "Zaragoza", "Córdoba", "Granada"];
      let detectedProv = "";
      for (const p of knownProvs) {
        if (new RegExp("\\b(?:en\\s+)?" + p + "\\b", "i").test(text)) {
          detectedProv = p;
          break;
        }
      }
      if (detectedProv && !formattedStreet.toLowerCase().includes(detectedProv.toLowerCase())) {
        return formattedStreet + ", " + detectedProv;
      }
      return formattedStreet;
    }

    // 2. Ciudad / Pueblo / Localidad (ej: "una casa en torrelavella en Sevilla", "en Marbella en Sevilla")
    let locMatch = text.match(/(?:(?:casa|piso|chalet|local|obra|reforma|trabajo)\s+en|para\s+[a-záéíóúñ\s]+?\s+en|\ben)\s+([a-záéíóúñ\s]+?\s+en\s+[a-záéíóúñ]+)(?=\s+(?:con|de|para|hay|habr[ií]a|donde)\b|:|$)/i);
    if (!locMatch) {
      locMatch = text.match(/(?:casa|piso|chalet|local|obra|reforma|trabajo)\s+en\s+([a-záéíóúñ\s]+?)(?=\s+(?:con|de|para|hay|habr[ií]a|donde)\b|:|$)/i);
    }
    if (locMatch) {
      let loc = locMatch[1].trim().replace(/\s+en\s+/i, ", ");
      return loc
        .split(/,\s*/)
        .map(part => part.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" "))
        .join(", ");
    }

    return "Ubicación obra según visita técnica";
  }

  /**
   * Valida la coherencia geográfica de una dirección (pueblo / municipio vs provincia)
   * Detecta si un pueblo pertenece a otra provincia o posibles erratas de transcripción.
   */
  static validateAddress(addressText) {
    if (!addressText || typeof addressText !== "string") {
      return { hasWarning: false };
    }

    const clean = addressText.trim();
    if (clean === "Ubicación obra según visita técnica") {
      return { hasWarning: false };
    }

    // Identificar partes: "Pueblo, Provincia" o "Pueblo en Provincia"
    const parts = clean.split(/,\s*|\s+en\s+/i).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      return { hasWarning: false };
    }

    const town = parts[0];
    const prov = parts[parts.length - 1];

    // Si la primera parte es una calle ordinaria (calle, avenida, etc.), no evaluarla como pueblo
    if (/^(?:calle|avenida|avda\.?|plaza|paseo|camino|carretera)\b/i.test(town)) {
      return { hasWarning: false };
    }

    const normTown = this.stripAccents(town);
    const normProv = this.stripAccents(prov);

    // Buscar la provincia indicada en el índice geográfico
    let targetProvKey = null;
    for (const [key, data] of Object.entries(this.SPANISH_GEO_INDEX)) {
      if (this.stripAccents(key) === normProv || data.aliases.some(a => this.stripAccents(a) === normProv)) {
        targetProvKey = key;
        break;
      }
    }

    if (!targetProvKey) {
      return { hasWarning: false };
    }

    const provData = this.SPANISH_GEO_INDEX[targetProvKey];
    const provMunis = provData.municipalities.map(m => this.stripAccents(m));

    // 1. ¿El municipio está en la provincia mencionada?
    if (provMunis.includes(normTown) || provMunis.some(m => normTown.includes(m) || m.includes(normTown))) {
      return { hasWarning: false };
    }

    // 2. Buscar si el municipio dictado pertenece en realidad a otra provincia
    let actualProv = null;
    let matchedName = null;

    for (const [otherKey, otherData] of Object.entries(this.SPANISH_GEO_INDEX)) {
      if (otherKey === targetProvKey) continue;
      for (const m of otherData.municipalities) {
        const normM = this.stripAccents(m);
        if (normM === normTown || this.stringSimilarity(normTown, normM) >= 0.75) {
          actualProv = otherData.province;
          matchedName = m.charAt(0).toUpperCase() + m.slice(1);
          break;
        }
      }
      if (actualProv) break;
    }

    // 3. Buscar sugerencia dentro de la provincia mencionada (por fonética o prefijo común)
    let suggestedInProv = null;
    let bestSim = 0;
    for (const m of provData.municipalities) {
      const normM = this.stripAccents(m);
      const sim = this.stringSimilarity(normTown, normM);
      const sharePrefix = normTown.length >= 4 && normM.startsWith(normTown.slice(0, 4));
      if (sim > bestSim && (sim >= 0.5 || sharePrefix)) {
        bestSim = sim;
        suggestedInProv = m.charAt(0).toUpperCase() + m.slice(1);
      }
    }

    // 4. Formular mensaje de advertencia y pregunta de confirmación
    let warningMessage = "";
    if (actualProv && actualProv.toLowerCase() !== targetProvKey.toLowerCase()) {
      if (suggestedInProv) {
        warningMessage = `📍 ¿Estás seguro de que "${clean}" es la dirección correcta? "${town}" no figura entre los municipios de ${targetProvKey} (${matchedName} pertenece a ${actualProv}, ¿o quizás quisiste decir ${suggestedInProv} en ${targetProvKey}?).`;
      } else {
        warningMessage = `📍 ¿Estás seguro de que "${clean}" es la dirección correcta? ${matchedName} pertenece a la provincia de ${actualProv}, no a ${targetProvKey}.`;
      }
    } else if (suggestedInProv) {
      warningMessage = `📍 ¿Estás seguro de que "${clean}" es la dirección correcta? No coincide con los municipios habituales de ${targetProvKey} (¿quizás te refieres a ${suggestedInProv}?).`;
    } else {
      warningMessage = `📍 ¿Estás seguro de que "${clean}" es la dirección correcta? No se ha podido verificar "${town}" como municipio o zona habitual de ${targetProvKey}.`;
    }

    return {
      hasWarning: true,
      warningMessage,
      town,
      province: targetProvKey,
      actualProv,
      suggestedInProv
    };
  }

  /**
   * Limpia una frase cruda eliminando muletillas e improperios
   */
  static cleanRawText(text) {
    if (!text || typeof text !== "string") return "";
    let result = text;
    for (const pattern of this.JUNK_WORDS_PATTERNS) {
      result = result.replace(pattern, " ");
    }
    // Eliminar coletillas de cierre coloquiales
    result = result.replace(/(?:y\s+)?(?:eso\s+ser[ií]a\s+todo|eso\s+es\s+todo|ya\s+est[aá]|nada\s+m[aá]s|y\s+ya\s+est[aá]|y\s+eso\s+ser[ií]a|eso\s+ser[ií]a)\s*$/i, "");
    result = result.replace(/\b(?:y\s+)?(?:eso|esto)\s+(?:ser[ií]a|es)\s+todo\b/gi, "");
    result = result.replace(/\b(?:y\s+)?ya\s+est[aá]\b/gi, "");
    result = result.replace(/\b(?:y\s+)?nada\s+m[aá]s\b/gi, "");
    result = result.replace(/\bque\s+est[aá]\s+bastante\s+bien.*$/gi, "");
    result = result.replace(/\bsinceramente\b/gi, "");
    result = result.replace(/\bun\s+corte\s+(?:un\s+corte\s+)?estimado\s+de\b/gi, "");
    return result.replace(/\s+/g, " ").trim();
  }

  /**
   * Normaliza una descripción coloquial a su estándar técnico formal
   */
  static normalizeItemDescription(rawDesc) {
    if (!rawDesc || typeof rawDesc !== "string") return "Partida técnica de obra / instalación según especificaciones";

    // Si ya es una descripción formal exacta del diccionario, respetarla
    for (const entry of this.TECHNICAL_DICTIONARY) {
      if (entry.formal === rawDesc.trim()) return entry.formal;
    }

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

    // Validación de coherencia geográfica en la dirección
    const addressValidation = this.validateAddress(clientAddress);
    if (addressValidation.hasWarning) {
      warnings.push(addressValidation.warningMessage);
    }

    // Normalizar patrones invertidos de gremios/capítulos: "X sería la cuarta partida" -> "luego la partida cuarta X"
    let normalized = rawTranscript.replace(/(\b(?:euros?|pavos|€|\.|\;|\,)\s+|^)([a-záéíóúñ\s]+?)\s+ser[ií]a\s+la\s+(primera|segunda|tercera|cuarta|quinta|sexta|cuarto|quinto|[0-9]+)\s+partida/gi, (match, prefix, trade, num) => {
      return `${prefix} luego la partida ${num} ${trade} `;
    });

    const numWords = "primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|quinta|quinto|sexta|sexto|uno|dos|tres|cuatro|cinco|seis|[0-9]+";
    const chapterMatchRegex = new RegExp(`\\bpartida\\s+(?:${numWords})\\b`, "i");
    const isChapterBased = chapterMatchRegex.test(normalized);

    const rawItems = [];

    if (isChapterBased) {
      // Audio estructurado por capítulos de gremios / partidas maestras
      const chapterSplitRegex = new RegExp(`\\b(?:y\s+)?(?:luego\s+)?(?:vamos\s+con\s+)?(?:por\s+[uú]ltimo\s+)?(?:la\s+)?partida\\s+(?:${numWords})\\b`, "gi");
      const parts = normalized.split(chapterSplitRegex).map(p => p.trim()).filter(p => p.length > 5);

      for (const part of parts) {
        // Omitir preámbulo inicial si no contiene conceptos de obra ni precio
        if (/^(?:oye|hola|buen(?:as|os)|te\s+voy\s+a\s+comentar)/i.test(part) && !/(?:euros?|pavos|€|\d{3,})/i.test(part)) {
          continue;
        }

        const price = this.extractPrice(part);

        // Limpiar justificaciones tipo "porque...", "ya que...", coletillas y estimaciones
        let desc = part.replace(/\b(?:porque|ya\s+que|puesto\s+que)\b.*$/i, "");
        desc = desc.replace(/\b(?:que\s+est[aá]\s+bastante\s+bien|sinceramente|y\s+ya\s+est[aá]|eso\s+ser[ií]a\s+todo)\b.*$/i, "");
        desc = desc.replace(/(?:un\s+corte\s+(?:un\s+corte\s+)?estimado\s+de\s+|eso\s+podr[ií]a\s+costar\s+|va\s+a\s+costar\s+|va\s+a\s+salir\s+por\s+).*/i, "");
        desc = desc.replace(/^(?:(?:y\s+)?(?:luego\s+)?(?:vamos\s+con\s+)?(?:por\s+[uú]ltimo\s+)?(?:la\s+)?partida\s*(?:primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|quinta|quinto|sexta|sexto|uno|dos|tres|cuatro|cinco|seis|[0-9]+)\s*[:\-]*)?/i, "");
        desc = desc.replace(/^(?:partida\s+eh\s+|ser[ií]a\s+|que\s+ser[ií]a\s+)/i, "");

        // Quitar menciones de precio que hayan quedado en el texto
        desc = desc.replace(/(?:(?:entre|unos?|de)\s+)?(?:\d+(?:[\.,]\d{3})*|\d+)\s*(?:a|y|-|hasta|\s+)\s*(?:\d+(?:[\.,]\d{3})*|\d+)\s*(?:euros?|pavos|€)?/gi, "");
        desc = desc.replace(/\b[1-9]\.\d{2,3}[1-9]\.000\s*(?:euros?|pavos|€)?/gi, "");
        desc = desc.replace(/\b\d+(?:[\.,]\d{1,3})*\s*(?:euros?|pavos|€)\b/gi, "");

        desc = this.cleanRawText(desc);

        // Detectar unidades
        let unit = 'pa'; // Por defecto partida alzada en capítulos
        let qty = 1;
        const m2Match = desc.match(/(\d+(?:[\.,]\d+)?)\s*(?:m2|m²|metros?\s*cuadrados?)\b/i);
        const mlMatch = desc.match(/(\d+(?:[\.,]\d+)?)\s*(?:ml|m\.l\.|metros?\s*lineales?)\b/i);
        const udMatch = desc.match(/(\d+)\s*(?:ud|uds|unidades?|piezas?|puntos?)\b/i);

        if (m2Match) {
          qty = parseFloat(m2Match[1].replace(',', '.'));
          unit = 'm²';
          desc = desc.replace(m2Match[0], "").trim();
        } else if (mlMatch) {
          qty = parseFloat(mlMatch[1].replace(',', '.'));
          unit = 'ml';
          desc = desc.replace(mlMatch[0], "").trim();
        } else if (udMatch) {
          qty = parseInt(udMatch[1], 10);
          unit = 'ud';
          desc = desc.replace(udMatch[0], "").trim();
        }

        if (desc.length > 3) {
          const formalDesc = this.normalizeItemDescription(desc);
          rawItems.push({
            description: formalDesc,
            qty,
            unit,
            unitPrice: qty > 1 ? Number((price / qty).toFixed(2)) : price,
            total: price,
            isPricePending: price === 0
          });
        }
      }
    } else {
      // Separar por saltos de línea, guiones, conectores verbales o transiciones de partida
      const segRegex = /(?:\n|\.|\;|\s*-\s*|\b(?:y\s+)?(?:habr[ií]a\s+que|hay\s+que|tambi[eé]n\s+(?:habr[ií]a\s+que|hay\s+que|habr[ií]a|vamos\s+a|quiero|poner|cambiar|instalar|hacer)|y\s+tambi[eé]n|y\s+adem[aá]s|adem[aá]s\s+(?:de\s+eso|de\s+esto)?|luego|despu[eé]s|por\s+otro\s+lado|con\s+un[ao]?)\b|(?<=(?:euros?|pavos|€))\s+(?=(?:demoler|derribar|quitar|tirar|cambiar|poner|instalar|remoquetar|hacer|alicatar|mampara|plato|bañera|suelo)\b)|(?<=(?:ventanas?|tabiques?|paredes?|cocina|baño|sal[oó]n|habitaci[oó]n))\s+(?=(?:cambiar|poner|instalar|remoquetar|alicatar|demoler|derribar|hacer)\b))/i;

      const lines = normalized
        .split(segRegex)
        .map(l => l.trim())
        .filter(l => l.length > 3);

      const priceRegex = /(?:(?:a|en|aún|aun|un)?\s*total\s+de\s+|por\s+|de\s+|[:\s])?((?:\d+(?:[\.,]\d{1,2})?|\b(?:(?:mil|doscient[ao]s|trescient[ao]s|cuatrocient[ao]s|quinient[ao]s|seiscient[ao]s|setecient[ao]s|ochocient[ao]s|novecient[ao]s|cien|ciento|veinte|veinti[a-záéíóúñ]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|diez|once|doce|trece|catorce|quince|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\s*(?:y\s*)?)+))\s*(?:euros?|pavos|€)\b/i;

      for (const line of lines) {
        const priceMatch = line.match(priceRegex);

        // Omitir líneas que son solo presentación, dirección, ubicación o condiciones de pago
        if (/(^para\s+[A-Z]|calle|avenida|paseo|plaza|vivienda\s+habitual|validez|anticipo|cobramos\s+[0-9]+%|pague\s+el\s+[0-9]+%|dile\s+que\s+no\s+sea\s+rata|hola|buen(?:as?|os?)\s+(?:tardes|d[ií]as)|me\s+gustar[ií]a\s+presupuestar|(?:casa|piso|chalet|local|obra)\s+en)/i.test(line) && !priceMatch && !/(?:cambiar|instalar|poner|alicatar|demolici|suelo|baño|cocina|mampara|tabique|grifo|puerta|ventana|split|pint)/i.test(line)) {
          continue;
        }

        if (priceMatch) {
          const rawPriceStr = priceMatch[1].trim();
          const price = this.parsePriceString(rawPriceStr);
          
          // Extraer descripción quitando el precio y las muletillas
          let desc = line.replace(priceMatch[0], "").replace(/^[\s:\-,]+/, "").replace(/[\s\.\-,]+$/, "").trim();
          desc = desc.replace(/\b(?:porque|ya\s+que|puesto\s+que)\b.*$/i, "");
          desc = this.cleanRawText(desc);

          let unit = 'pa';
          let qty = 1;

          const m2Match = desc.match(/(\d+(?:[\.,]\d+)?)\s*(?:m2|m²|metros?\s*cuadrados?)\b/i);
          const mlMatch = desc.match(/(\d+(?:[\.,]\d+)?)\s*(?:ml|m\.l\.|metros?\s*lineales?)\b/i);
          const udMatch = desc.match(/(\d+)\s*(?:ud|uds|unidades?|piezas?|puntos?)\b/i);

          if (m2Match) {
            qty = parseFloat(m2Match[1].replace(',', '.'));
            unit = 'm²';
            desc = desc.replace(m2Match[0], "").trim();
          } else if (mlMatch) {
            qty = parseFloat(mlMatch[1].replace(',', '.'));
            unit = 'ml';
            desc = desc.replace(mlMatch[0], "").trim();
          } else if (udMatch) {
            qty = parseInt(udMatch[1], 10);
            unit = 'ud';
            desc = desc.replace(udMatch[0], "").trim();
          } else {
            const qtyMatch = desc.match(/^([0-9]+)\s+/);
            if (qtyMatch) {
              qty = parseInt(qtyMatch[1], 10);
              unit = 'ud';
              desc = desc.replace(qtyMatch[0], "");
            }
          }

          if (price > 0 && desc.length > 3) {
            const formalDesc = this.normalizeItemDescription(desc);
            rawItems.push({
              description: formalDesc,
              qty,
              unit,
              unitPrice: qty > 1 ? Number((price / qty).toFixed(2)) : price,
              total: price,
              isPricePending: false
            });
          }
        } else {
          // La línea describe una partida de trabajo pero NO tenía precio (modo borrador / medición)
          if (/(cambiar|instalar|poner|alicatar|demolici[oó]n|reparar|revisi[oó]n|fabricaci[oó]n|suelo|tarima|tuber[ií]a|grifo|baño|cocina|cuadro|puerta|ventana|split|climatizaci[oó]n|pint(ar|ura)|tabique|rozas)/i.test(line)) {
            let cleanPending = line.replace(/\b(?:porque|ya\s+que|puesto\s+que)\b.*$/i, "");
            cleanPending = this.cleanRawText(cleanPending);
            const formalDesc = this.normalizeItemDescription(cleanPending);
            rawItems.push({
              description: formalDesc,
              qty: 1,
              unit: 'pa',
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
        `\n\n👉 Puedes enviar el presupuesto tal cual o mandarme otro audio para rellenar lo que falta (ejemplo: "Ponle 250 al alicatado" o "Es en Torreblanca").`;
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
   * Procesa cualquier respuesta conversacional de WhatsApp:
   * - Corrección de dirección ("Es en Torreblanca", "La dirección es Torreblanca")
   * - Confirmación de dirección ("Sí, es correcta", "La dirección está bien")
   * - Asignación/actualización de precio ("Ponle 180 euros al suelo", "partida 1 son 300")
   */
  static applyConversationalReply(budget, replyText) {
    if (!budget || !replyText) {
      return { success: false, message: "Mensaje o presupuesto no válido." };
    }

    const trimmed = replyText.trim();
    const lower = trimmed.toLowerCase();

    // 1. Confirmación de dirección existente ("sí, es correcta", "es correcta", "la dirección está bien")
    if (/^(?:s[ií],?\s*)?(?:es\s*correct[ao]|est[aá]\s*bien|la\s+direcci[oó]n\s+es\s+correcta|es\s+v[aá]lida)$/i.test(trimmed) ||
        /(?:la\s+direcci[oó]n\s+(?:es\s+correcta|est[aá]\s+bien)|s[ií]\s+es\s+en)/i.test(trimmed)) {
      if (budget.warnings) {
        budget.warnings = budget.warnings.filter(w => !w.includes("dirección correcta") && !w.includes("📍"));
      }
      budget.hasWarnings = (budget.warnings && budget.warnings.length > 0) || (budget.items && budget.items.some(it => it.isPricePending));
      const confirmedAddr = (budget.client && budget.client.address) ? budget.client.address : "especificada";
      return {
        success: true,
        type: "ADDRESS_CONFIRMED",
        budget,
        message: `👍 Perfecto, confirmada la dirección "${confirmedAddr}". He verificado los datos del presupuesto.`
      };
    }

    // 2. Corrección de dirección ("Es en Torreblanca", "Es Torreblanca", "La dirección es Torreblanca, Sevilla")
    const addrPrefixMatch = trimmed.match(/^(?:es\s+en|es\s+para|la\s+direcci[oó]n\s+es|la\s+calle\s+es|direcci[oó]n:?|cambia\s+(?:la\s+)?direcci[oó]n\s+a)\s+([a-záéíóúñ0-9\s,\.\-]+)$/i);
    const isDirectTownCorrection = !addrPrefixMatch && !/(?:euros?|pavos|€|\d+)/i.test(trimmed) && trimmed.split(/\s+/).length <= 4 && /(?:torreblanca|cantabria|alcorcon|sevilla|madrid|barcelona|malaga|valencia)/i.test(lower);

    if (addrPrefixMatch || isDirectTownCorrection) {
      let newPlace = addrPrefixMatch ? addrPrefixMatch[1].trim() : trimmed;
      
      // Si el usuario dijo "Torreblanca" y antes teníamos "Torrelavella, Sevilla", preservar la provincia si no se especificó
      if (!newPlace.includes(",") && budget.client && budget.client.address && budget.client.address.includes(",")) {
        const oldProv = budget.client.address.split(/,\s*/).pop().trim();
        newPlace = `${newPlace.charAt(0).toUpperCase() + newPlace.slice(1)}, ${oldProv}`;
      } else {
        newPlace = newPlace.charAt(0).toUpperCase() + newPlace.slice(1);
      }

      if (budget.client) {
        budget.client.address = newPlace;
      }
      if (budget.warnings) {
        budget.warnings = budget.warnings.filter(w => !w.includes("dirección correcta") && !w.includes("📍"));
      }
      budget.hasWarnings = (budget.warnings && budget.warnings.length > 0) || (budget.items && budget.items.some(it => it.isPricePending));

      return {
        success: true,
        type: "ADDRESS_UPDATED",
        budget,
        message: `✅ Dirección actualizada a "${newPlace}". He corregido la ficha del presupuesto.`
      };
    }

    // 3. Procesamiento multi-partida (soporta audios completos con múltiples partidas y precios, o comandos breves)
    const segRegex = /(?:(?<=(?:euros?|pavos|€|\d+))\s+(?=(?:cambiar|poner|instalar|remoquetar|hacer|alicatar|pintar|demoler|quitar|adecuar|suministro)\b)|\b(?:y\s+hay\s+que|hay\s+que|habr[ií]a\s+que|tambi[eé]n\s+(?:hay\s+que|habr[ií]a\s+que|poner|cambiar)|y\s+tambi[eé]n|y\s+adem[aá]s|adem[aá]s|luego|despu[eé]s)\b)/i;

    const clauses = trimmed.split(segRegex).map(c => c.trim()).filter(c => c.length > 5);

    // Si es un comando simple de un solo precio ("Ponle 250 al alicatado", "partida 2 son 300"), usar applyConversationalUpdate
    if (clauses.length <= 1 && /(?:partida\s+[0-9]|ponle\s+[0-9]+|la\s+[0-9]+\s+son)/i.test(trimmed)) {
      return this.applyConversationalUpdate(budget.items, trimmed);
    }

    const itemsToProcess = clauses.length > 0 ? clauses : [trimmed];
    const updatesLog = [];

    const priceRegex = /(?:(?:va\s+a\s+salir\s+por|va\s+a\s+costar|por|de)\s+(?:unos?\s+|uno\s+o\s+)?|[:\s])?((?:\d+(?:[\.,]\d{1,2})?|\b(?:(?:mil|doscient[ao]s|trescient[ao]s|cuatrocient[ao]s|quinient[ao]s|seiscient[ao]s|setecient[ao]s|ochocient[ao]s|novecient[ao]s|cien|ciento|veinte|veinti[a-záéíóúñ]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|diez|once|doce|trece|catorce|quince|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\s*(?:y\s*)?)+))\s*(?:euros?|pavos|€)?\b/i;

    for (const clause of itemsToProcess) {
      const priceMatch = clause.match(priceRegex);
      let price = 0;
      let rawDesc = clause;

      if (priceMatch) {
        price = this.parsePriceString(priceMatch[1].trim());
        rawDesc = clause.replace(priceMatch[0], "").trim();
      }

      const cleanDesc = this.cleanRawText(rawDesc);
      if (cleanDesc.length < 3) continue;

      // Buscar si coincide con alguna partida existente
      const candidates = budget.items.filter(it => it.isPricePending).concat(budget.items.filter(it => !it.isPricePending));
      const stopWords = ["hacer", "cambiar", "poner", "instalar", "unos", "costar", "decir", "salir", "suministros", "partida", "linea", "numero", "zarum", "todo", "seria"];
      const descWords = cleanDesc.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.includes(w));

      let matchedItem = null;
      for (const item of candidates) {
        const itemWords = item.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        for (const w of descWords) {
          if (itemWords.some(iw => iw.includes(w) || w.includes(iw))) {
            matchedItem = item;
            break;
          }
        }
        if (matchedItem) break;
      }

      // Si solo hay 1 partida pendiente en todo el presupuesto y hay precio, emparejarla
      if (!matchedItem && budget.items.filter(it => it.isPricePending).length === 1 && price > 0 && itemsToProcess.length === 1) {
        matchedItem = budget.items.find(it => it.isPricePending);
      }

      if (matchedItem) {
        if (price > 0) {
          matchedItem.unitPrice = price;
          matchedItem.total = Number((price * matchedItem.qty).toFixed(2));
          matchedItem.isPricePending = false;
          updatesLog.push(`• Partida ${matchedItem.id} (${matchedItem.description.slice(0, 32)}...): asignado ${matchedItem.total.toFixed(2)} €.`);
        }
      } else {
        // Es una NUEVA partida no presente en el presupuesto
        if (price > 0 || /(cambiar|instalar|poner|alicatar|demolici|suelo|moqueta|remoquetar|tarima|tuber|grifo|baño|cocina|cuadro|puerta|ventana|split|pint)/i.test(cleanDesc)) {
          const formalDesc = this.normalizeItemDescription(cleanDesc);
          const newItem = {
            id: budget.items.length + 1,
            description: formalDesc,
            qty: 1,
            unit: 'pa',
            unitPrice: price,
            total: price,
            isPricePending: price === 0
          };
          budget.items.push(newItem);
          if (price > 0) {
            updatesLog.push(`• Nueva partida añadida: "${formalDesc.slice(0, 35)}..." (${price.toFixed(2)} €).`);
          } else {
            updatesLog.push(`• Nueva partida añadida: "${formalDesc.slice(0, 35)}..." [Pendiente de valorar].`);
            if (budget.warnings) budget.warnings.push(`Partida pendiente de valorar: "${formalDesc}".`);
          }
        }
      }
    }

    if (updatesLog.length === 0) {
      return this.applyConversationalUpdate(budget.items, trimmed);
    }

    return {
      success: true,
      type: "ITEMS_UPDATED",
      budget,
      message: `✅ He actualizado tu presupuesto con las indicaciones del audio:\n` + updatesLog.join("\n")
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
