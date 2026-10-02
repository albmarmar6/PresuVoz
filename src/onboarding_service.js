import { getCompany, saveCompany, completeSecureOnboarding, DEFAULT_COMPANY } from './db_service.js';

export { completeSecureOnboarding };

export const ONBOARDING_STEPS = [
  'OWNER_AND_COMPANY',
  'TRADE',
  'CITY',
  'WORKING_HOURS',
  'PAYMENT_TERMS',
  'ADVANCE',
  'QUOTE_VALIDITY',
  'ENTITY_TYPE',
  'FISCAL_NAME',
  'CIF_NIF',
  'FISCAL_ADDRESS',
  'TAX_RATE',
  'IRPF_RATE',
  'INVOICE_SERIES',
  'BANK_ACCOUNT'
];

export function getStepQuestion(step, data = {}) {
  switch (step) {
    case 'OWNER_AND_COMPANY':
      return [
        '👉 *¿Cómo te llamas y cómo se llama tu empresa o negocio?*',
        '',
        '_(Por ejemplo: «Me llamo Carlos y mi empresa es Reformas Carlos» o «Alberto, Instalaciones Sur»)_'
      ].join('\n');
    case 'TRADE':
      return [
        '👉 *¿A qué oficio o gremio te dedicas principalmente?*',
        '',
        '_(Por ejemplo: Electricidad, fontanería, albañilería, reformas integrales, carpintería, pintura, climatización...)_'
      ].join('\n');
    case 'CITY':
      return [
        '👉 *¿Por qué ciudad o zona sueles moverte habitualmente para los trabajos y obras?*',
        '',
        '_(Por ejemplo: Sevilla y alrededores, Madrid capital, Valencia y provincia...)_'
      ].join('\n');
    case 'WORKING_HOURS':
      return [
        '👉 *¿Cuál es tu horario habitual de trabajo o atención?*',
        '',
        '_(Por ejemplo: De lunes a viernes de 8:00 a 18:00, o de 7:30 a 15:30... O pon «luego» si prefieres)_'
      ].join('\n');
    case 'PAYMENT_TERMS':
      return [
        '👉 *¿Cómo sueles cobrar habitualmente a tus clientes?*',
        '1️⃣ Al terminar',
        '2️⃣ Por adelantado',
        '3️⃣ 50% al empezar y 50% al acabar',
        '4️⃣ Por hitos o fases de obra',
        '5️⃣ Otro (escríbeme cómo lo haces tú o pon «luego»)'
      ].join('\n');
    case 'ADVANCE':
      return [
        '👉 *¿Sueles pedir algún anticipo al confirmar la obra o para compra de materiales? ¿De qué porcentaje suele ser?*',
        '',
        '_(Por ejemplo: 30%, 40%, 50%, o escribe «ninguno» o «luego»)_'
      ].join('\n');
    case 'QUOTE_VALIDITY':
      return [
        '👉 *¿Cuánto tiempo suelen ser válidos tus presupuestos antes de que caduquen?*',
        '1️⃣ 7 días',
        '2️⃣ 15 días',
        '3️⃣ 30 días',
        '4️⃣ Otro (indícame los días que quieras)'
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
        '_(DNI/NIE con letra si eres autónomo, o CIF empezando por letra si es empresa, ej: 12345678Z o B-12345678. O escribe «luego» si prefieres)_'
      ].join('\n');
    case 'FISCAL_ADDRESS':
      return [
        '👉 *¿Cuál es tu dirección fiscal completa?*',
        '',
        '_(Calle, número, código postal y localidad. O pon «luego» si prefieres)_'
      ].join('\n');
    case 'TAX_RATE':
      return [
        '👉 *¿Qué porcentaje de IVA sueles aplicar habitualmente en tus presupuestos?*',
        '1️⃣ 21% (General)',
        '2️⃣ 10% (Reducido de reformas)',
        '3️⃣ Exento (0%)',
        '4️⃣ Otro'
      ].join('\n');
    case 'IRPF_RATE':
      return [
        '👉 *¿Utilizas algún porcentaje de IRPF en tus facturas?*',
        '',
        '_(Por ejemplo: 15% general de profesional, 7% si eres nuevo autónomo, o escribe «no» / «0%» si facturas a particulares o como sociedad)_'
      ].join('\n');
    case 'INVOICE_SERIES':
      return [
        '👉 *¿Qué numeración o serie quieres utilizar para tus facturas?*',
        '',
        '_(Por ejemplo: 2026-001, 2026-002... o F26-001, FRA-001... Si no pones nada usaremos «2026-001»)_'
      ].join('\n');
    case 'BANK_ACCOUNT':
      return [
        '👉 *¿Tienes una cuenta bancaria (IBAN) o Bizum que quieras mostrar en las facturas y presupuestos para que te paguen?*',
        '',
        '_(Puedes pasarme el IBAN, el número para Bizum, o escribir «luego» si prefieres añadirlo más adelante)_'
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
    '👋 *¡Hola! Qué alegría saludarte.* Vamos a dejar tu asistente inteligente configurado en un periquete, como charlando tranquilamente entre colegas con un café ☕.',
    '',
    'Para empezar con lo básico:',
    '👉 *¿Cómo te llamas y cómo se llama tu empresa o negocio?*',
    '',
    '_(Por ejemplo: «Me llamo Carlos y mi empresa es Reformas Carlos» o «Alberto, Instalaciones Sur»)_'
  ].join('\n');
}

export function normalizeTrade(text) {
  const raw = String(text || '').trim().toLowerCase();
  let normalizedTrade = 'Reformas y Construcción';
  let defaultTax = 10;

  if (/electri/i.test(raw)) {
    normalizedTrade = 'Electricidad y Telecomunicaciones';
    defaultTax = 21;
  } else if (/fontan|plomer/i.test(raw)) {
    normalizedTrade = 'Fontanería y Saneamiento';
    defaultTax = 21;
  } else if (/albañil|obra|construc|reforma/i.test(raw)) {
    normalizedTrade = 'Albañilería y Reformas';
    defaultTax = 10;
  } else if (/carpinter/i.test(raw)) {
    normalizedTrade = 'Carpintería y Madera';
    defaultTax = 21;
  } else if (/clima|aire|calefac/i.test(raw)) {
    normalizedTrade = 'Climatización y Calefacción';
    defaultTax = 21;
  } else if (/pint/i.test(raw)) {
    normalizedTrade = 'Pintura y Revestimientos';
    defaultTax = 21;
  } else if (/cerraj/i.test(raw)) {
    normalizedTrade = 'Cerrajería y C. Metálica';
    defaultTax = 21;
  } else if (raw.length > 2) {
    normalizedTrade = raw.charAt(0).toUpperCase() + raw.slice(1);
    defaultTax = 21;
  }

  return { trade: normalizedTrade, defaultTax };
}

export function formatCompanySummary(comp) {
  return [
    '🎉 *¡Enhorabuena, amigo! Ya lo tenemos todo configurado.* 🚀',
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    `👤 *Profesional:* ${comp.ownerName || 'No indicado'}`,
    `🏢 *Empresa / Negocio:* ${comp.name || 'No indicado'}`,
    `🛠️ *Oficio / Especialidad:* ${comp.trade || 'No indicado'}`,
    `📍 *Zona de trabajo:* ${comp.city || 'No indicada'}`,
    `⏰ *Horario habitual:* ${comp.workingHours || 'No indicado'}`,
    `💶 *Forma de cobro:* ${comp.paymentTerms || 'No especificada'}`,
    `🤝 *Anticipo habitual:* ${comp.defaultAdvance !== null && comp.defaultAdvance !== undefined ? comp.defaultAdvance + '%' : 'No configurado'}`,
    `⏳ *Validez de presupuestos:* ${comp.quoteValidityDays ? comp.quoteValidityDays + ' días' : 'No indicada'}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    '📑 *Datos Fiscales para Facturas y Presupuestos:*',
    `• *Tipo:* ${comp.entityType === 'empresa' ? 'Empresa / Sociedad' : (comp.entityType === 'autonomo' ? 'Autónomo' : 'No indicado')}`,
    `• *Razón Social:* ${comp.fiscalName || comp.name || 'No indicada'}`,
    `• *NIF/CIF:* ${comp.cif || 'No indicado'}`,
    `• *Dirección:* ${comp.address || 'No indicada'}`,
    `• *IVA por defecto:* ${comp.defaultTaxRate !== null && comp.defaultTaxRate !== undefined ? comp.defaultTaxRate + '%' : 'No indicado'}`,
    `• *IRPF:* ${comp.irpfRate ? comp.irpfRate + '%' : '0% (No aplica / Sin retención)'}`,
    `• *Serie facturas:* ${comp.invoiceSeries || 'No configurada'}`,
    `• *IBAN:* ${comp.iban ? comp.iban : 'No configurado'}`,
    `• *Bizum:* ${comp.bizum ? comp.bizum : 'No configurado'}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━',
    '💪 *¡A partir de ahora la IA trabaja contigo codo con codo!*',
    '🎙️ Puedes dictarme una obra en una nota de voz o escribir *"presupuesto para María de una reforma de baño"* y te lo preparo en segundos con tus datos oficiales.'
  ].join('\n');
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
      message: '🛑 *Asistente de registro pausado.* Podrás completarlo cuando quieras escribiendo *"empezar"* o *"configurar de nuevo"*.'
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
        '👋 ¡Hola de nuevo! Seguimos justo donde lo dejamos con la configuración:',
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
      let owner = '';
      let company = '';

      const matchBoth = input.match(/(?:(?:me llamo|soy)\s+)?([^,;\n]+?)(?:,|\s+y\s+|\s+con\s+)(?:mi empresa es|la empresa se llama|empresa|negocio)\s+([^,;\n]+)/i);
      const matchInverted = input.match(/(?:(?:la\s+)?empresa|negocio)\s+([^,;\n]+?)(?:,|\s+y\s+)(?:me llamo|soy)\s+([^,;\n]+)/i);

      if (matchBoth) {
        owner = matchBoth[1].trim();
        company = matchBoth[2].trim();
      } else if (matchInverted) {
        company = matchInverted[1].trim();
        owner = matchInverted[2].trim();
      } else if (input.includes(',')) {
        const parts = input.split(',');
        owner = parts[0].trim();
        company = parts.slice(1).join(',').trim();
      } else {
        owner = input.replace(/^(?:me llamo|soy)\s+/i, '').trim();
        company = owner.includes(' ') ? `${owner}` : `${owner} Reformas`;
      }

      data.ownerName = owner;
      data.companyName = company;

      saveCompany(phone, {
        ownerName: owner,
        name: company,
        fiscalName: company,
        onboardingStep: 'TRADE',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `¡Qué buen nombre, *${owner}*! Menudo equipazo vamos a hacer juntos 💪`,
          '',
          'Cuéntame:',
          '👉 *¿A qué oficio o gremio te dedicas principalmente?*',
          '',
          '_(Por ejemplo: Electricidad, fontanería, albañilería, reformas integrales, carpintería, pintura, climatización...)_'
        ].join('\n')
      };
    }

    // 2. Oficio o gremio
    case 'TRADE': {
      const { trade, defaultTax } = normalizeTrade(input);
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
          `¡Oído cocina! *${trade}* a tope 🛠️`,
          `_(He configurado automáticamente el IVA habitual para este gremio al ${defaultTax}%, que podrás cambiar cuando quieras)._`,
          '',
          'Siguiente pregunta:',
          '👉 *¿Por qué ciudad o zona sueles moverte habitualmente para los trabajos y obras?*',
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
        onboardingStep: 'WORKING_HOURS',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          city ? `¡Perfecto! Buena zona para currar 📍` : `¡De acuerdo! Dejamos la zona de trabajo pendiente de indicar 📍`,
          '',
          '👉 *¿Cuál es tu horario habitual de trabajo o atención?*',
          '',
          '_(Por ejemplo: De lunes a viernes de 8:00 a 18:00, o de 7:30 a 15:30... O pon «luego» si prefieres)_'
        ].join('\n')
      };
    }

    // 4. Horario habitual
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
          hours ? '¡Anotado! El descanso también es sagrado ⏱️' : '¡Sin problema! Añadiremos el horario más adelante ⏱️',
          '',
          'Una pregunta clave para que tus presupuestos salgan con las condiciones perfectas:',
          '👉 *¿Cómo sueles cobrar habitualmente a tus clientes?*',
          '1️⃣ Al terminar',
          '2️⃣ Por adelantado',
          '3️⃣ 50% al empezar y 50% al acabar',
          '4️⃣ Por hitos o fases de obra',
          '5️⃣ Otro (escríbeme cómo lo haces tú o pon «luego»)'
        ].join('\n')
      };
    }

    // 5. Forma de cobro
    case 'PAYMENT_TERMS': {
      let terms = null;
      if (!isSkip) {
        if (/^1\b|terminar|finalizar|acabar/i.test(input) && !/50/i.test(input)) {
          terms = '100% al terminar el trabajo';
        } else if (/^2\b|adelantad|anticipad/i.test(input)) {
          terms = '100% por adelantado';
        } else if (/^3\b|50|mitad/i.test(input)) {
          terms = '50% al empezar y 50% al acabar';
        } else if (/^4\b|hito|fase|certifica/i.test(input)) {
          terms = 'Por hitos y certificaciones según avance de obra';
        } else if (input.length > 2) {
          terms = input;
        }
      }
      data.paymentTerms = terms;

      saveCompany(phone, {
        paymentTerms: terms,
        onboardingStep: 'ADVANCE',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          terms ? `¡Fenomenal! Dejar las cosas claras desde el principio evita disgustos 💶` : `¡De acuerdo! Dejamos las condiciones de cobro para más adelante 💶`,
          '',
          '👉 *¿Sueles pedir algún anticipo al confirmar la obra o para compra de materiales? ¿De qué porcentaje suele ser?*',
          '',
          '_(Por ejemplo: 30%, 40%, 50%, o escribe «ninguno» o «luego»)_'
        ].join('\n')
      };
    }

    // 6. Anticipo habitual
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
          `¡Tomo nota! Anticipo establecido al *${advance}%* 🤝`,
          '',
          'Con cómo cambian los precios de los materiales hoy en día:',
          '👉 *¿Cuánto tiempo suelen ser válidos tus presupuestos antes de que caduquen?*',
          '1️⃣ 7 días',
          '2️⃣ 15 días',
          '3️⃣ 30 días',
          '4️⃣ Otro (indícame los días que quieras)'
        ].join('\n')
      };
    }

    // 7. Validez de presupuestos
    case 'QUOTE_VALIDITY': {
      let days = 15;
      if (/^1\b|7\s*d[ií]as?/i.test(input)) {
        days = 7;
      } else if (/^2\b|15\s*d[ií]as?/i.test(input)) {
        days = 15;
      } else if (/^3\b|30\s*d[ií]as?|un\s+mes/i.test(input)) {
        days = 30;
      } else {
        const dMatch = input.match(/(\d+)/);
        if (dMatch) days = parseInt(dMatch[1], 10);
      }
      data.quoteValidityDays = days;

      saveCompany(phone, {
        quoteValidityDays: days,
        onboardingStep: 'ENTITY_TYPE',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          `¡Estupendo! Validez fijada en *${days} días* ⏳`,
          '',
          '━━━━━━━━━━━━━━━━━━━━━━━━━',
          '📑 *¡Vamos ahora a la parte fiscal y de facturación!*',
          'Esto es para que tus presupuestos oficiales, contratos con firma y facturas en PDF salgan 100% legales y profesionales.',
          '',
          '👉 *¿Eres autónomo o tienes una empresa (S.L., C.B., Sociedad Civil...)?*'
        ].join('\n')
      };
    }

    // 8. Tipo de entidad (autónomo o empresa)
    case 'ENTITY_TYPE': {
      let entityType = 'autonomo';
      if (/empresa|s\.?l|sociedad|c\.?b|cooperativa/i.test(input)) {
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
          `¡Perfecto, registrado como *${entityType === 'autonomo' ? 'Autónomo' : 'Empresa'}*! 📋`,
          '',
          '👉 *¿Cuál es tu nombre fiscal o razón social oficial para las facturas?*',
          '',
          `_(Si eres autónomo suele ser tu nombre y apellidos; si es sociedad, la razón social completa como figura en Hacienda)_`
        ].join('\n')
      };
    }

    // 9. Nombre fiscal
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
          fiscalName ? `¡Oído cocina, *${fiscalName}*! 📛` : `¡De acuerdo! Dejamos el nombre fiscal para más adelante 📛`,
          '',
          '👉 *¿Cuál es tu NIF o CIF?*',
          '',
          '_(DNI/NIE con letra si eres autónomo, o CIF empezando por letra si es empresa, ej: 12345678Z o B-12345678. O escribe «luego» si prefieres)_'
        ].join('\n')
      };
    }

    // 10. CIF / NIF
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
          cif ? `¡NIF/CIF guardado: *${cif}*! 🆔` : `¡Entendido! Dejamos el NIF/CIF pendiente para cuando lo tengas a mano 🆔`,
          '',
          '👉 *¿Cuál es tu dirección fiscal completa?*',
          '',
          '_(Calle, número, código postal y población para la cabecera de tus documentos oficiales. O escribe «luego» si prefieres)_'
        ].join('\n')
      };
    }

    // 11. Dirección fiscal
    case 'FISCAL_ADDRESS': {
      const address = isSkip ? null : input;
      data.address = address;

      saveCompany(phone, {
        address,
        onboardingStep: 'TAX_RATE',
        onboardingDataJson: JSON.stringify(data)
      });

      return {
        handled: true,
        message: [
          address ? `¡Dirección registrada! 🏠` : `¡De acuerdo! Añadiremos la dirección fiscal más adelante 🏠`,
          '',
          '👉 *¿Qué porcentaje de IVA aplicas normalmente a tus trabajos?*',
          '',
          '_(Por ejemplo: 10% para obras y reformas en vivienda habitual, 21% general, o 0% si estás exento)_'
        ].join('\n')
      };
    }

    // 12. IVA habitual
    case 'TAX_RATE': {
      let tax = 10;
      const numMatch = input.match(/(\d+)/);
      if (numMatch) {
        tax = parseInt(numMatch[1], 10);
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
          `¡IVA fijado al *${tax}%*! 📊`,
          '',
          '👉 *¿Utilizas algún porcentaje de IRPF en tus facturas?*',
          '',
          '_(Por ejemplo: 15% general de profesional, 7% si eres nuevo autónomo, o escribe «no» / «0%» si facturas a particulares o como sociedad)_'
        ].join('\n')
      };
    }

    // 13. IRPF
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
          `¡Tomo nota! Retención de IRPF: *${irpf > 0 ? irpf + '%' : '0% (sin IRPF)'}* 💼`,
          '',
          '👉 *¿Qué numeración o serie quieres utilizar para tus facturas?*',
          '',
          '_(Por ejemplo: 2026-001, 2026-002... o F26-001, FRA-001... Si no pones nada usaremos «2026-001»)_'
        ].join('\n')
      };
    }

    // 14. Serie de facturas
    case 'INVOICE_SERIES': {
      let series = '2026-';
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
          `¡Serie de facturación guardada como *${series}*! 🔢`,
          '',
          'Y ya por último, amigo mío para cerrar el círculo:',
          '👉 *¿Tienes una cuenta bancaria (IBAN) o Bizum que quieras mostrar en las facturas y presupuestos para que te paguen?*',
          '',
          '_(Puedes pasarme el IBAN, el número para Bizum, o escribir «luego» si prefieres añadirlo más adelante)_'
        ].join('\n')
      };
    }

    // 15. Cuenta bancaria / Bizum
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
        quoteValidityDays: data.quoteValidityDays || 15,
        entityType: data.entityType || 'autonomo',
        irpfRate: data.irpfRate || 0,
        invoiceSeries: data.invoiceSeries || '2026-',
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
