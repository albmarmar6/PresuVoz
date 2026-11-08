import { getCompany, saveCompany, completeSecureOnboarding, DEFAULT_COMPANY } from './db_service.js';

export { completeSecureOnboarding };

export const ONBOARDING_STEPS = [
  'OWNER_AND_COMPANY',
  'TRADE',
  'CITY',
  'FISCAL_ADDRESS',
  'PAYMENT_TERMS',
  'QUOTE_VALIDITY'
];

export function getStepQuestion(step, data = {}) {
  switch (step) {
    case 'OWNER_AND_COMPANY':
      return [
        '👉 *¿Cómo te llamas y cómo se llama tu empresa o negocio?*',
        '',
        '_(Por ejemplo: «Me llamo Carlos y mi empresa es Reformas Carlos» o «Alberto, Instalaciones Sur». Si lo deseas, puedes añadir también tu NIF/CIF o indicarlo más adelante)_'
      ].join('\n');
    case 'TRADE':
      return [
        '👉 *¿A qué oficio, gremio o especialidades te dedicas?*',
        '',
        '_(Por ejemplo: Albañilería, fontanería, electricidad, reformas integrales, pintura, carpintería, climatización... Puedes indicar uno o varios oficios)_'
      ].join('\n');
    case 'CITY':
      return [
        '👉 *¿En qué ciudad o zona realizas habitualmente tus trabajos y obras?*',
        '',
        '_(Por ejemplo: Sevilla y alrededores, Madrid capital, Valencia y provincia...)_'
      ].join('\n');
    case 'FISCAL_ADDRESS':
      return [
        '👉 *¿Cuál es tu dirección fiscal completa para que aparezca en tus facturas y presupuestos?*',
        '',
        '_(Calle, número, código postal y localidad. O escribe «luego» si prefieres añadirla más adelante)_'
      ].join('\n');
    case 'PAYMENT_TERMS':
      return [
        '👉 *¿Cómo sueles cobrar habitualmente a tus clientes?*',
        '1️⃣ 30% de anticipo al inicio y resto al finalizar (Recomendado)',
        '2️⃣ 50% al inicio y 50% al finalizar',
        '3️⃣ 100% al finalizar',
        '4️⃣ Por hitos o fases de obra',
        '5️⃣ Forma personalizada (ej: «70% al inicio y 30% al final», «40/60»... o escribe «luego»)'
      ].join('\n');
    case 'QUOTE_VALIDITY':
      return [
        '👉 *¿Cuál es el plazo de validez habitual de tus presupuestos?*',
        '1️⃣ 30 días (1 mes)',
        '2️⃣ 60 días (2 meses)',
        '3️⃣ 90 días (3 meses)',
        '4️⃣ Otro plazo (indica los días, ej: «15 días», «45 días», «180 días»)'
      ].join('\n');
    case 'WORKING_HOURS':
      return [
        '👉 *¿Cuál es tu horario habitual de trabajo o atención?*',
        '',
        '_(Por ejemplo: De lunes a viernes de 8:00 a 18:00... O escribe «luego» si prefieres)_'
      ].join('\n');
    case 'ADVANCE':
      return [
        '👉 *¿Sueles solicitar algún anticipo al confirmar la obra o para compra de materiales? ¿De qué porcentaje?*',
        '',
        '_(Por ejemplo: 30%, 40%, 50%, o escribe «ninguno» o «luego»)_'
      ].join('\n');
    case 'ENTITY_TYPE':
      return '👉 *¿Eres autónomo o tienes una empresa (S.L., C.B., Sociedad Civil...)?*';
    case 'FISCAL_NAME':
      return [
        '👉 *¿Cuál es tu nombre fiscal o razón social oficial para las facturas?*',
        '',
        '_(Si eres autónomo suele ser tu nombre y apellidos; si es sociedad, la razón social completa como figura en Hacienda)_'
      ].join('\n');
    case 'CIF_NIF':
      return [
        '👉 *¿Cuál es tu NIF o CIF?*',
        '',
        '_(DNI/NIE con letra si eres autónomo, o CIF empezando por letra si es empresa. O escribe «luego» si prefieres)_'
      ].join('\n');
    case 'TAX_RATE':
      return [
        '👉 *¿Qué porcentaje de IVA sueles aplicar habitualmente en tus presupuestos?*',
        '1️⃣ 10% (Reducido de reformas)',
        '2️⃣ 21% (General)',
        '3️⃣ Exento (0%)',
        '4️⃣ Otro'
      ].join('\n');
    case 'IRPF_RATE':
      return [
        '👉 *¿Utilizas algún porcentaje de retención de IRPF en tus facturas?*',
        '',
        '_(Por ejemplo: 15% general de profesional, 7% nuevo autónomo, o escribe «no» / «0%» si facturas a particulares o como sociedad)_'
      ].join('\n');
    case 'INVOICE_SERIES':
      return [
        '👉 *¿Qué numeración o serie deseas utilizar para tus facturas?*',
        '',
        '_(Por ejemplo: 2026-001... Si no indicas otra, se asignará «2026-001»)_'
      ].join('\n');
    case 'BANK_ACCOUNT':
      return [
        '👉 *¿Deseas incluir una cuenta bancaria (IBAN) o Bizum en tus facturas y presupuestos?*',
        '',
        '_(Puedes indicar el IBAN, el número para Bizum, o escribir «luego» para añadirlo más adelante)_'
      ].join('\n');
    default:
      return '';
  }
}

export function getOnboardingState(phone) {
  const company = getCompany(phone);
  let step = company.onboardingStep || null;
  let data = {};
  if (company.onboardingDataJson) {
    try {
      data = JSON.parse(company.onboardingDataJson);
    } catch (e) {
      data = {};
    }
  }
  return { step, data, isConfigured: company.isConfigured, company };
}

export function startOnboarding(phone) {
  const initialData = {};
  saveCompany(phone, {
    onboardingStep: ONBOARDING_STEPS[0],
    onboardingDataJson: JSON.stringify(initialData)
  });

  return [
    '👋 *Bienvenido a PresuVoz.* Vamos a configurar los datos de tu perfil profesional en unos breves pasos para generar tus presupuestos y facturas.',
    '',
    'Para empezar:',
    '👉 *¿Cómo te llamas y cómo se llama tu empresa o negocio?*',
    '',
    '_(Por ejemplo: «Me llamo Carlos y mi empresa es Reformas Carlos» o «Alberto, Instalaciones Sur». Si lo deseas, puedes añadir también tu NIF/CIF o indicarlo más adelante)_'
  ].join('\n');
}

export function normalizeTrade(text) {
  const raw = String(text || '').trim().toLowerCase();
  const catalog = [
    { key: 'electricidad', regex: /electri|telecomunica/i, full: 'Electricidad y Telecomunicaciones', short: 'Electricidad', tax: 21 },
    { key: 'fontaneria', regex: /fontan|plomer|saneamiento/i, full: 'Fontanería y Saneamiento', short: 'Fontanería', tax: 21 },
    { key: 'albanileria', regex: /alba[ñn]il/i, full: 'Albañilería y Reformas', short: 'Albañilería', tax: 10 },
    { key: 'reformas', regex: /\b(?:reformas?(?:\s+integrales)?|construcci[oó]n|obras?)\b/i, full: 'Albañilería y Reformas', short: /integral/i.test(raw) ? 'Reformas Integrales' : 'Reformas', tax: 10 },
    { key: 'carpinteria', regex: /carpinter|madera/i, full: 'Carpintería y Madera', short: 'Carpintería', tax: 21 },
    { key: 'climatizacion', regex: /clima|aire\s*acondicionado|calefac/i, full: 'Climatización y Calefacción', short: 'Climatización', tax: 21 },
    { key: 'pintura', regex: /pint/i, full: 'Pintura y Revestimientos', short: 'Pintura', tax: 21 },
    { key: 'cerrajeria', regex: /cerraj|met[aá]lic/i, full: 'Cerrajería y C. Metálica', short: 'Cerrajería', tax: 21 },
    { key: 'pladur', regex: /pladur|yeso|escayola|tabiquer[ií]a/i, full: 'Pladur y Falsos Techos', short: 'Pladur', tax: 10 },
    { key: 'solados', regex: /solad|alicatad|azulej|paviment|tarima|parquet/i, full: 'Solados, Alicatados y Pavimentos', short: 'Solados y Alicatados', tax: 10 },
    { key: 'impermeabilizacion', regex: /impermeabiliz|tejad|cubierta/i, full: 'Cubiertas e Impermeabilizaciones', short: 'Impermeabilización y Cubiertas', tax: 10 }
  ];

  const matched = [];
  for (const entry of catalog) {
    const m = raw.match(entry.regex);
    if (m) {
      matched.push({ ...entry, index: m.index ?? 0 });
    }
  }

  if (matched.length === 1) {
    return { trade: matched[0].full, defaultTax: matched[0].tax };
  }

  if (matched.length > 1) {
    matched.sort((a, b) => a.index - b.index);
    const isOnlyAlbanileriaAndGenericReformas =
      matched.length === 2 &&
      matched.some(m => m.key === 'albanileria') &&
      matched.some(m => m.key === 'reformas') &&
      !/integral/i.test(raw);

    if (isOnlyAlbanileriaAndGenericReformas) {
      return { trade: 'Albañilería y Reformas', defaultTax: 10 };
    }

    const shorts = [...new Set(matched.map(m => m.short))];
    const combined = shorts.length === 1
      ? matched[0].full
      : (shorts.length === 2
          ? `${shorts[0]} y ${shorts[1]}`
          : `${shorts.slice(0, -1).join(', ')} y ${shorts[shorts.length - 1]}`);
    const defaultTax = matched.some(m => m.tax === 10) ? 10 : 21;
    return { trade: combined, defaultTax };
  }

  if (raw.length > 2) {
    return {
      trade: raw.charAt(0).toUpperCase() + raw.slice(1),
      defaultTax: 21
    };
  }

  return { trade: 'Reformas y Construcción', defaultTax: 10 };
}

export function formatCompanySummary(comp) {
  return [
    '✅ *¡Enhorabuena! Tu perfil profesional ya está configurado.*',
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `👤 *Profesional:* ${comp.ownerName || 'No indicado'}`,
    `🏢 *Empresa / Negocio:* ${comp.name || 'No indicado'}`,
    `🛠️ *Oficio / Especialidad:* ${comp.trade || 'No indicado'}`,
    `📍 *Zona de trabajo:* ${comp.city || 'No indicada'}`,
    `🏠 *Dirección fiscal:* ${comp.address || 'Pendiente (puedes añadirla diciendo «Mi dirección es...»)'}`,
    `💶 *Forma de cobro:* ${comp.paymentTerms || 'No especificada'}`,
    `🤝 *Anticipo habitual:* ${comp.defaultAdvance !== null && comp.defaultAdvance !== undefined ? comp.defaultAdvance + '%' : 'No configurado'}`,
    `⏳ *Validez de presupuestos:* ${comp.quoteValidityDays ? comp.quoteValidityDays + ' días' : '30 días'}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    '📑 *Datos Fiscales para Facturas y Presupuestos:*',
    `• *Tipo:* ${comp.entityType === 'empresa' ? 'Empresa / Sociedad' : 'Autónomo'}`,
    `• *Razón Social:* ${comp.fiscalName || comp.name || 'No indicada'}`,
    `• *NIF/CIF:* ${comp.cif || 'No indicado'}`,
    `• *IVA por defecto:* ${comp.defaultTaxRate !== null && comp.defaultTaxRate !== undefined ? comp.defaultTaxRate + '%' : '10%'}`,
    `• *IRPF:* ${comp.irpfRate ? comp.irpfRate + '%' : '0% (No aplica / Sin retención)'}`,
    `• *Serie facturas:* ${comp.invoiceSeries || '2026-001'}`,
    `• *IBAN:* ${comp.iban ? comp.iban : 'No configurado'}`,
    `• *Bizum:* ${comp.bizum ? comp.bizum : 'No configurado'}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🤖 *Tu asistente PresuVoz ya está operativo.*',
    '🎙️ A partir de ahora puedes enviar una nota de voz o escribir un mensaje de texto (por ejemplo: *"presupuesto para María de una reforma de baño"*) y generaremos el presupuesto en PDF con tus datos oficiales.'
  ].join('\n');
}

export function cleanBusinessName(str) {
  if (!str) return '';
  let s = str.trim();
  s = s.replace(/^["'«»]+|["'«»]+$/g, '').trim();
  s = s.replace(/\s+(?:y\s+somos\b|y\s+hacemos\b|y\s+nos\s+dedicamos\b|dedicada\s+a\b|especialistas\s+en\b|hacemos\b).*$/i, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  return s;
}

export function cleanPersonName(str) {
  if (!str) return '';
  let s = str.trim();
  s = s.replace(/^(?:me\s+llamo|soy|mi\s+nombre\s+es)\s+/i, '').trim();
  s = s.replace(/[.,;:]+$/, '').trim();
  return s;
}

export function extractOwnerAndCompany(input) {
  if (!input || typeof input !== 'string') return { owner: '', company: '', cif: null, entityType: 'autonomo' };
  let raw = input.trim();

  let cif = null;
  let entityType = 'autonomo';

  // Extraer CIF/NIF si el usuario lo incluye directamente (ej: "NIF 12345678Z" o "B12345678")
  const cifMatch = raw.match(/\b([ABCDEFGHJKLMNPQRSUVW][0-9]{7}[0-9A-J]|[0-9]{8}[TRWAGMYFPDXBNJZSQVHLCKE]|[XYZ][0-9]{7}[TRWAGMYFPDXBNJZSQVHLCKE])\b/i);
  if (cifMatch) {
    cif = cifMatch[1].toUpperCase();
    if (/^[ABCDEFGHJKLMNPQRSUVW]/i.test(cif)) {
      entityType = 'empresa';
    } else {
      entityType = 'autonomo';
    }
    raw = raw.replace(new RegExp('(?:,\\s*)?(?:con\\s+)?(?:nif|cif|dni)?[\\s:]*' + cifMatch[1] + '\\b', 'gi'), '').trim();
    raw = raw.replace(/[,\s]+$/, '').trim();
  }

  if (/\b(?:s\.?l\.?|s\.?a\.?|s\.?l\.?u\.?|sociedad|c\.?b\.?|cooperativa)\b/i.test(raw)) {
    entityType = 'empresa';
  }

  // Patrón conector para empresa/negocio
  const companyPattern = /(?:mi\s+negocio\s+se\s+llama|mi\s+empresa\s+se\s+llama|el\s+negocio\s+se\s+llama|la\s+empresa\s+se\s+llama|tengo\s+un(?:a)?\s+(?:empresa|negocio)\s+que\s+se\s+llama|mi\s+empresa\s+es|mi\s+negocio\s+es|la\s+empresa\s+es|el\s+negocio\s+es|nombre\s+del\s+negocio\s*:?|nombre\s+de\s+la\s+empresa\s*:?|se\s+llama|empresa\s*:?|negocio\s*:?)/i;

  // 1. Caso: Persona antes del conector de empresa (ej: 'Antonio García y mi negocio se llama Reformas García')
  const splitMatch = raw.match(new RegExp('^(.*?)(?:,|\\s+y\\s+|\\s+con\\s+)\\s*' + companyPattern.source + '\\s+(.+)$', 'i'));
  if (splitMatch) {
    const owner = cleanPersonName(splitMatch[1]);
    const company = cleanBusinessName(splitMatch[2]);
    return { owner: owner || company, company, cif, entityType };
  }

  // 2. Caso: Empresa antes de la persona (invertido: 'Mi empresa se llama Reformas García y soy Antonio García')
  const invertedMatch = raw.match(new RegExp('^' + companyPattern.source + '\\s+(.*?)(?:,|\\s+y\\s+)(?:me\\s+llamo|soy|mi\\s+nombre\\s+es)\\s+(.+)$', 'i'));
  if (invertedMatch) {
    const company = cleanBusinessName(invertedMatch[1]);
    const owner = cleanPersonName(invertedMatch[2]);
    return { owner: owner || company, company, cif, entityType };
  }

  // 3. Caso: Solo empresa con prefijo explícito (ej: 'Mi negocio se llama Reformas García', 'Se llama Reformas García')
  const directCompanyMatch = raw.match(new RegExp('^' + companyPattern.source + '\\s+(.+)$', 'i'));
  if (directCompanyMatch) {
    const company = cleanBusinessName(directCompanyMatch[1]);
    return { owner: company, company, cif, entityType };
  }

  // 4. Caso: Formato con coma 'Nombre, Empresa' (ej: 'Alberto, Instalaciones Sur')
  if (raw.includes(',')) {
    const parts = raw.split(',');
    const owner = cleanPersonName(parts[0]);
    const company = cleanBusinessName(parts.slice(1).join(','));
    if (owner && company) {
      return { owner, company, cif, entityType };
    }
  }

  // 5. Caso simple sin conector de empresa (ej: 'Reformas García' o 'Antonio García')
  const cleaned = cleanPersonName(raw);
  const isTradeName = /\b(?:reformas?|instalaciones|pinturas?|construcciones|servicios|fontaner[ií]a|electricidad|clima|multiservicios|obras?|talleres?)\b/i.test(cleaned);
  if (isTradeName) {
    return { owner: cleaned, company: cleaned, cif, entityType };
  }

  return {
    owner: cleaned,
    company: cleaned.includes(' ') ? cleaned : cleaned + ' Reformas',
    cif,
    entityType
  };
}

export function processOnboardingStep(phone, rawInput, options = {}) {
  const input = String(rawInput || '').trim();
  const state = getOnboardingState(phone);

  if (!state.step) {
    return {
      handled: false,
      message: null
    };
  }

  // Cancelar o salir del asistente
  if (/^(?:cancelar|salir|cancelar onboarding)$/i.test(input)) {
    saveCompany(phone, {
      onboardingStep: null,
      onboardingDataJson: null
    });
    return {
      handled: true,
      message: '🛑 *Asistente de configuración pausado.* Podrás retomarlo cuando quieras escribiendo *"empezar"* o *"configurar perfil"*.'
    };
  }

  // Reiniciar
  if (/^(?:reiniciar|empezar de nuevo|volver a empezar)$/i.test(input)) {
    const welcomeMsg = startOnboarding(phone);
    return {
      handled: true,
      message: welcomeMsg
    };
  }

  // Detección de saludo repetido durante el onboarding (mantiene el estado y re-pregunta sin reiniciar ni crear empresas duplicadas)
  const isRepeatedGreeting = /^(?:hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|hey|qu[eé]\s+tal)$/i.test(input);
  if (isRepeatedGreeting) {
    const currentStep = state.step;
    const data = state.data || {};
    return {
      handled: true,
      message: [
        '👋 Continuamos con la configuración de tu perfil profesional:',
        '',
        getStepQuestion(currentStep, data)
      ].join('\n')
    };
  }

  const isSkip = /^(?:saltar|omitir|luego|m[aá]s tarde|paso|no tengo|ningun[ao]|ninguno|no)$/i.test(input);
  const currentStep = state.step;
  const data = state.data || {};

  switch (currentStep) {
    // 1. Nombre propio y nombre de la empresa
    case 'OWNER_AND_COMPANY': {
      const { owner, company, cif, entityType } = extractOwnerAndCompany(input);

      data.ownerName = owner;
      data.companyName = company;
      data.fiscalName = company || owner;
      if (cif) data.cif = cif;
      data.entityType = entityType;

      saveCompany(phone, {
        ownerName: owner,
        name: company,
        fiscalName: company || owner,
        cif: cif || null,
        entityType,
        onboardingStep: 'TRADE',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `✅ Perfecto, *${owner}*. Datos iniciales registrados correctamente.`,
          '',
          '👉 *¿A qué oficio, gremio o especialidades te dedicas?*',
          '',
          '_(Por ejemplo: Albañilería, fontanería, electricidad, reformas integrales, pintura, carpintería, climatización... Puedes indicar uno o varios oficios)_'
        ].join('\n')
      };
    }

    // 2. Oficio o gremio
    case 'TRADE': {
      const { trade } = normalizeTrade(input);
      const defaultTax = 10;
      data.trade = trade;
      data.defaultTaxRate = defaultTax;

      saveCompany(phone, {
        trade,
        defaultTaxRate: defaultTax,
        onboardingStep: 'CITY',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `✅ *Oficio registrado:* *${trade}* 🛠️`,
          `_(Se ha configurado el IVA habitual al 10%, que podrás modificar o especificar en cualquier presupuesto)._`,
          '',
          'Siguiente paso:',
          '👉 *¿En qué ciudad o zona realizas habitualmente tus trabajos y obras?*',
          '',
          '_(Por ejemplo: Sevilla y alrededores, Madrid capital, Valencia y provincia...)_'
        ].join('\n')
      };
    }

    // 3. Ciudad o zona
    case 'CITY': {
      const city = isSkip ? null : input;
      data.city = city;

      saveCompany(phone, {
        city,
        onboardingStep: 'FISCAL_ADDRESS',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          city ? `✅ *Zona de trabajo registrada:* *${city}* 📍` : `De acuerdo, dejamos la zona de trabajo pendiente de indicar 📍`,
          '',
          '👉 *¿Cuál es tu dirección fiscal completa para que aparezca en tus facturas y presupuestos?*',
          '',
          '_(Calle, número, código postal y localidad. O escribe «luego» si prefieres añadirla más adelante)_'
        ].join('\n')
      };
    }

    // 4. Dirección fiscal
    case 'FISCAL_ADDRESS': {
      const address = isSkip ? null : input;
      data.address = address;

      saveCompany(phone, {
        address,
        onboardingStep: 'PAYMENT_TERMS',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          address ? `✅ *Dirección fiscal registrada correctamente.* 🏠` : `De acuerdo, añadiremos la dirección fiscal más adelante 🏠`,
          '',
          'A continuación, configuremos las condiciones de pago habituales para tus presupuestos:',
          '👉 *¿Cómo sueles cobrar habitualmente a tus clientes?*',
          '1️⃣ 30% de anticipo al inicio y resto al finalizar (Recomendado)',
          '2️⃣ 50% al inicio y 50% al finalizar',
          '3️⃣ 100% al finalizar',
          '4️⃣ Por hitos o fases de obra',
          '5️⃣ Forma personalizada (ej: «70% al inicio y 30% al final», «40/60»... o escribe «luego»)'
        ].join('\n')
      };
    }

    // 5. Forma de cobro y anticipo integrado
    case 'PAYMENT_TERMS': {
      let terms = null;
      let advance = 0;
      if (!isSkip) {
        const wordMap = {
          diez: 10, quince: 15, veinte: 20, veinticinco: 25, treinta: 30,
          cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90
        };
        const startPctBefore = input.match(/(\d{1,3})\s*%?\s*(?:de\s+)?(?:anticipo|adelanto|se[ñn]al|al\s+inicio|al\s+empezar|al\s+comenzar|al\s+aceptar|al\s+principio|inicial)\b/i);
        const startPctAfter = input.match(/\b(?:anticipo|adelanto|se[ñn]al|al\s+inicio|al\s+empezar|al\s+comenzar|al\s+aceptar|al\s+principio|inicial)\s*(?:de(?:l)?\s*)?(\d{1,3})\s*%?/i);
        const slashPair = input.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
        const twoPcts = [...input.matchAll(/(\d{1,3})\s*%/g)].map(m => parseInt(m[1], 10));
        const pctMatch = input.match(/(\d{1,3})\s*%/);
        const pureNum = input.match(/\b(\d{1,2})\b/);
        const advanceWordMatch = input.match(/\b(diez|quince|veinte|veinticinco|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)\b/i);

        if (/^(?:1|opci[oó]n\s*1)$/i.test(input)) {
          terms = '30% de anticipo y 70% al terminar';
          advance = 30;
        } else if (/^(?:2|opci[oó]n\s*2)$/i.test(input) || /\bmitad\b/i.test(input)) {
          terms = '50% al empezar y 50% al acabar';
          advance = 50;
        } else if (/^(?:3|opci[oó]n\s*3)$/i.test(input) || (/100\s*%?\s*(?:al\s+)?(?:terminar|final|finalizar|acabar)/i.test(input)) || (/terminar|finalizar|acabar/i.test(input) && !/\d/.test(input))) {
          terms = '100% al terminar el trabajo';
          advance = 0;
        } else if (/^(?:4|opci[oó]n\s*4)$/i.test(input) || (/hito|certifica|fases?\s+de\s+obra/i.test(input) && !/\d+%/i.test(input))) {
          terms = 'Por hitos y certificaciones según avance de obra';
          advance = 0;
        } else if (startPctBefore || startPctAfter) {
          const parsedAdv = parseInt((startPctBefore || startPctAfter)[1], 10);
          if (parsedAdv > 0 && parsedAdv < 100) {
            advance = parsedAdv;
            terms = parsedAdv === 50
              ? '50% al empezar y 50% al acabar'
              : `${parsedAdv}% de anticipo y ${100 - parsedAdv}% al terminar`;
          } else if (parsedAdv === 100) {
            advance = 100;
            terms = '100% por adelantado al inicio';
          }
        } else if (slashPair && (parseInt(slashPair[1], 10) + parseInt(slashPair[2], 10) === 100)) {
          advance = parseInt(slashPair[1], 10);
          terms = advance === 50
            ? '50% al empezar y 50% al acabar'
            : `${advance}% de anticipo y ${100 - advance}% al terminar`;
        } else if (twoPcts.length === 2 && (twoPcts[0] + twoPcts[1] === 100)) {
          advance = twoPcts[0];
          terms = advance === 50
            ? '50% al empezar y 50% al acabar'
            : `${advance}% de anticipo y ${100 - advance}% al terminar`;
        } else if (pctMatch) {
          advance = parseInt(pctMatch[1], 10);
          terms = input.length > 4 ? input : `${advance}% de anticipo y ${100 - advance}% al terminar`;
        } else if (advanceWordMatch && wordMap[advanceWordMatch[1].toLowerCase()]) {
          advance = wordMap[advanceWordMatch[1].toLowerCase()];
          terms = `${advance}% de anticipo y ${100 - advance}% al terminar`;
        } else if (pureNum && Number(pureNum[1]) > 0 && Number(pureNum[1]) <= 100 && /anticipo|adelanto|empezar|inicio|se[ñn]al/i.test(input)) {
          advance = parseInt(pureNum[1], 10);
          terms = `${advance}% de anticipo y ${100 - advance}% al terminar`;
        } else if (input.length > 2) {
          terms = input;
          advance = 0;
        }
      }
      data.paymentTerms = terms;
      data.defaultAdvance = advance;

      saveCompany(phone, {
        paymentTerms: terms,
        defaultAdvance: advance,
        onboardingStep: 'QUOTE_VALIDITY',
        onboardingDataJson: JSON.stringify(data)
      });

      const advanceMsg = advance > 0 ? ` (anticipo fijado al *${advance}%*)` : '';

      return {
        handled: true,
        message: [
          terms ? `✅ *Condiciones de cobro registradas:* *${terms}*${advanceMsg} 💶` : `De acuerdo, dejamos las condiciones de cobro para más adelante 💶`,
          '',
          'Por último:',
          '👉 *¿Cuál es el plazo de validez habitual de tus presupuestos?*',
          '1️⃣ 30 días (1 mes)',
          '2️⃣ 60 días (2 meses)',
          '3️⃣ 90 días (3 meses)',
          '4️⃣ Otro plazo (indica los días, ej: «15 días», «45 días», «180 días»)'
        ].join('\n')
      };
    }

    // 6. Validez de presupuestos (Paso Final que completa el onboarding)
    case 'QUOTE_VALIDITY': {
      let days = 30;
      const explicitDays = input.match(/^\s*(\d{1,4})\s*d[ií]as?(?=\s|$)/i);
      const option = input.normalize('NFKC').replace(/[\uFE0F\u20E3]/gu, '').trim().toLowerCase();

      // Una duración escrita explícitamente siempre tiene prioridad sobre el número de opción.
      if (explicitDays) {
        days = Number(explicitDays[1]);
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
          return {
            handled: true,
            message: 'Indica una validez entre *1 y 3650 días* (por ejemplo, *15 días*, *30 días* o *60 días*).'
          };
        }
      } else if (/^(?:treinta\s*d[ií]as|un mes|1 mes)$/i.test(option)) {
        days = 30;
      } else if (/^(?:sesenta\s*d[ií]as|dos meses|2 meses)$/i.test(option)) {
        days = 60;
      } else if (/^(?:noventa\s*d[ií]as|tres meses|3 meses)$/i.test(option)) {
        days = 90;
      } else if (/^(?:seis meses|6 meses)$/i.test(option)) {
        days = 180;
      } else if (/^(?:4|opci[oó]n\s*4|otro|otra)$/i.test(option)) {
        return {
          handled: true,
          message: '¿Cuántos días deseas configurar exactamente? Escríbelo, por ejemplo, como *15 días*, *45 días* o *180 días*.'
        };
      } else if (/^(?:1|opci[oó]n\s*1)$/i.test(option)) {
        days = 30;
      } else if (/^(?:2|opci[oó]n\s*2)$/i.test(option)) {
        days = 60;
      } else if (/^(?:3|opci[oó]n\s*3)$/i.test(option)) {
        days = 90;
      } else if (/^(?:saltar|omitir|luego|m[aá]s tarde|paso|no)$/i.test(option)) {
        days = 30;
      } else {
        return {
          handled: true,
          message: 'No he podido identificar el plazo de validez. Selecciona *1* (30 días), *2* (60 días), *3* (90 días) o escribe los días directamente, por ejemplo *45 días*.'
        };
      }
      data.quoteValidityDays = days;

      // Finalizar Onboarding de forma atómica y segura (transacción BEGIN IMMEDIATE)
      const updated = completeSecureOnboarding(phone, {
        ...data,
        name: data.companyName || data.ownerName || null,
        fiscalName: data.fiscalName || data.companyName || data.ownerName || null,
        ownerName: data.ownerName || null,
        cif: data.cif || null,
        trade: data.trade || null,
        address: data.address || null,
        city: data.city || null,
        workingHours: data.workingHours || null,
        paymentTerms: data.paymentTerms || null,
        quoteValidityDays: days,
        entityType: data.entityType || 'autonomo',
        irpfRate: data.irpfRate || 0,
        invoiceSeries: data.invoiceSeries || '2026-001',
        defaultTaxRate: data.defaultTaxRate !== null && data.defaultTaxRate !== undefined ? data.defaultTaxRate : 10,
        defaultAdvance: data.defaultAdvance !== null && data.defaultAdvance !== undefined ? data.defaultAdvance : null,
        iban: data.iban || null,
        bizum: data.bizum || null
      }, options);

      const summaryText = formatCompanySummary(updated);
      return {
        handled: true,
        completed: true,
        company: updated,
        message: summaryText
      };
    }

    // ─── PASOS LEGACY (Soporte hacia atrás / compatibilidad) ───────────────────
    case 'WORKING_HOURS': {
      const hours = isSkip ? null : input;
      data.workingHours = hours;

      saveCompany(phone, {
        workingHours: hours,
        onboardingStep: 'PAYMENT_TERMS',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          hours ? '✅ *Horario registrado.* ⏱️' : 'De acuerdo, añadiremos el horario más adelante ⏱️',
          '',
          getStepQuestion('PAYMENT_TERMS', data)
        ].join('\n')
      };
    }

    case 'ADVANCE': {
      let advance = null;
      const numMatch = input.match(/(\d+)\s*%/);
      const pureNum = input.match(/\b(\d{1,2})\b/);

      if (/ningun|cero|nada|no\b/i.test(input)) {
        advance = 0;
      } else if (!isSkip) {
        if (numMatch) {
          advance = parseInt(numMatch[1], 10);
        } else if (pureNum) {
          advance = parseInt(pureNum[1], 10);
        }
      }
      data.defaultAdvance = advance;

      saveCompany(phone, {
        defaultAdvance: advance,
        onboardingStep: 'QUOTE_VALIDITY',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `✅ Anticipo establecido al *${advance}%* 🤝`,
          '',
          getStepQuestion('QUOTE_VALIDITY', data)
        ].join('\n')
      };
    }

    case 'ENTITY_TYPE': {
      let entityType = 'autonomo';
      if (/empresa|s\.l|sociedad|c\.b|cooperativa/i.test(input)) {
        entityType = 'empresa';
      }
      data.entityType = entityType;

      saveCompany(phone, {
        entityType,
        onboardingStep: 'FISCAL_NAME',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `✅ Registrado como *${entityType === 'autonomo' ? 'Autónomo' : 'Empresa'}*. 📋`,
          '',
          getStepQuestion('FISCAL_NAME', data)
        ].join('\n')
      };
    }

    case 'FISCAL_NAME': {
      const fiscalName = isSkip ? (data.companyName || data.ownerName || null) : input;
      data.fiscalName = fiscalName;

      saveCompany(phone, {
        fiscalName,
        onboardingStep: 'CIF_NIF',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          fiscalName ? `✅ *Razón social registrada:* *${fiscalName}* 📛` : `De acuerdo, dejamos el nombre fiscal para más adelante 📛`,
          '',
          getStepQuestion('CIF_NIF', data)
        ].join('\n')
      };
    }

    case 'CIF_NIF': {
      let cif = null;
      if (!isSkip) {
        const cifMatch = input.match(/\b([ABCDEFGHJKLMNPQRSUVW][0-9]{7}[0-9A-J]|[0-9]{8}[TRWAGMYFPDXBNJZSQVHLCKE]|[XYZ][0-9]{7}[TRWAGMYFPDXBNJZSQVHLCKE])\b/i);
        if (cifMatch) {
          cif = cifMatch[1].toUpperCase();
        } else if (input.length >= 8 && input.length <= 12 && !/luego|saltar|omitir|no/i.test(input)) {
          cif = input.replace(/[\s-]/g, '').toUpperCase();
        }
      }
      data.cif = cif;

      saveCompany(phone, {
        cif,
        onboardingStep: 'FISCAL_ADDRESS',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          cif ? `✅ *NIF/CIF registrado:* *${cif}* 🆔` : `De acuerdo, dejamos el NIF/CIF pendiente 🆔`,
          '',
          getStepQuestion('FISCAL_ADDRESS', data)
        ].join('\n')
      };
    }

    case 'TAX_RATE': {
      const numMatch = input.match(/(?:^|\D)(0|4|5|10|21)\s*%?(?:\D|$)/);
      const tax = /exent[oa]|sin\s+iva/i.test(input)
        ? 0
        : (numMatch ? Number(numMatch[1]) : (/general|normal/i.test(input) ? 21 : null));
      if (tax === null || ![0, 4, 5, 10, 21].includes(tax)) {
        return {
          handled: true,
          message: 'No he reconocido ese tipo. Indica 21%, 10%, 5%, 4% o exento (0%) para guardar el IVA habitual.'
        };
      }
      data.defaultTaxRate = tax;

      saveCompany(phone, {
        defaultTaxRate: tax,
        onboardingStep: 'IRPF_RATE',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `✅ *IVA habitual configurado al ${tax}%.* 📊`,
          '',
          getStepQuestion('IRPF_RATE', data)
        ].join('\n')
      };
    }

    case 'IRPF_RATE': {
      let irpf = 0;
      if (/no\b|cero|nada|ningun/i.test(input)) {
        irpf = 0;
      } else {
        const numMatch = input.match(/(\d+)/);
        if (numMatch) irpf = parseInt(numMatch[1], 10);
      }
      data.irpfRate = irpf;

      saveCompany(phone, {
        irpfRate: irpf,
        onboardingStep: 'INVOICE_SERIES',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `✅ *Retención de IRPF:* *${irpf > 0 ? irpf + '%' : '0% (sin IRPF)'}* 💼`,
          '',
          getStepQuestion('INVOICE_SERIES', data)
        ].join('\n')
      };
    }

    case 'INVOICE_SERIES': {
      let series = '2026-001';
      if (!isSkip && input.length >= 2) {
        series = input;
      }
      data.invoiceSeries = series;

      saveCompany(phone, {
        invoiceSeries: series,
        onboardingStep: 'BANK_ACCOUNT',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `✅ *Serie de facturación registrada:* *${series}* 🔢`,
          '',
          getStepQuestion('BANK_ACCOUNT', data)
        ].join('\n')
      };
    }

    case 'BANK_ACCOUNT': {
      let iban = null;
      let bizum = null;

      if (!isSkip) {
        const ibanMatch = input.match(/\b(ES\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/i);
        if (ibanMatch) {
          iban = ibanMatch[1].replace(/[\s-]/g, '').replace(/(.{4})/g, '$1 ').trim();
        }

        const bizumMatch = input.match(/(?:bizum|m[oó]vil|tel[eé]fono)?[:\s]*([67]\d{8})\b/i);
        if (bizumMatch) {
          bizum = bizumMatch[1];
        }
      }

      data.iban = iban || null;
      data.bizum = bizum || null;

      const updated = completeSecureOnboarding(phone, {
        ...data,
        name: data.companyName || data.ownerName || null,
        fiscalName: data.fiscalName || data.companyName || data.ownerName || null,
        ownerName: data.ownerName || null,
        cif: data.cif || null,
        trade: data.trade || null,
        address: data.address || null,
        city: data.city || null,
        workingHours: data.workingHours || null,
        paymentTerms: data.paymentTerms || null,
        quoteValidityDays: data.quoteValidityDays || 30,
        entityType: data.entityType || 'autonomo',
        irpfRate: data.irpfRate || 0,
        invoiceSeries: data.invoiceSeries || '2026-001',
        defaultTaxRate: data.defaultTaxRate !== null && data.defaultTaxRate !== undefined ? data.defaultTaxRate : 10,
        defaultAdvance: data.defaultAdvance !== null && data.defaultAdvance !== undefined ? data.defaultAdvance : null,
        iban: iban || null,
        bizum: bizum || null
      }, options);

      const summaryText = formatCompanySummary(updated);
      return {
        handled: true,
        completed: true,
        company: updated,
        message: summaryText
      };
    }

    default:
      return { handled: false, message: null };
  }
}
