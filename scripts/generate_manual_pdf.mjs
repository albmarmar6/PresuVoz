import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const ROOT_DIR = 'C:/Users/alber/Desktop/PresuVoz';
const LOGO_PATH = path.join(ROOT_DIR, 'presuvoz_logo_oficial.jpg');
const OUTPUT_PATHS = [
  'C:/Users/alber/Desktop/Manual_Uso_PresuVoz.pdf',
  path.join(ROOT_DIR, 'Manual_Uso_PresuVoz.pdf'),
  'C:/Users/alber/.gemini/antigravity/brain/19814725-5f2b-441c-961a-31cab0f75ff1/Manual_Uso_PresuVoz.pdf'
];

const COLORS = {
  navy: '#0F172A',
  navyLight: '#1E293B',
  emerald: '#059669',
  emeraldDark: '#047857',
  emeraldBg: '#ECFDF5',
  emeraldBorder: '#A7F3D0',
  blue: '#2563EB',
  blueBg: '#EFF6FF',
  blueBorder: '#BFDBFE',
  amber: '#D97706',
  amberBg: '#FFFBEB',
  amberBorder: '#FDE68A',
  slateDark: '#334155',
  slateMuted: '#64748B',
  border: '#E2E8F0',
  cardBg: '#F8FAFC',
  white: '#FFFFFF'
};

function createManualPDF(outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 48, bottom: 48, left: 42, right: 42 },
      bufferPages: true,
      info: {
        Title: 'Manual Oficial de Uso - PresuVoz',
        Author: 'PresuVoz (presuvoz.com)',
        Subject: 'Guía práctica de comandos de voz y texto en WhatsApp para profesionales de reformas y gremios'
      }
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const marginL = 42;
    const marginR = 42;
    const contentWidth = pageWidth - marginL - marginR;

    function ensureSpace(neededHeight) {
      if (doc.y + neededHeight > pageHeight - 56) {
        doc.addPage();
        drawRunningHeader();
      }
    }

    function drawRunningHeader() {
      const y = 20;
      doc.save();
      doc.rect(0, 0, pageWidth, 36).fill(COLORS.navy);
      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(9.5)
        .text('PRESUVOZ  |  MANUAL OFICIAL DE USO PARA EL PROFESIONAL', marginL, y - 4, { width: contentWidth * 0.7, lineBreak: false });
      doc.fillColor('#34D399').font('Helvetica-Bold').fontSize(9)
        .text('presuvoz.com', marginL, y - 4, { width: contentWidth, align: 'right', lineBreak: false });
      doc.restore();
      doc.y = 50;
    }

    // ─── PORTADA / ENCABEZADO PRINCIPAL (PÁGINA 1) ─────────────────────────
    doc.rect(0, 0, pageWidth, 146).fill(COLORS.navy);
    doc.rect(0, 142, pageWidth, 4).fill(COLORS.emerald);

    if (fs.existsSync(LOGO_PATH)) {
      try {
        doc.save();
        doc.roundedRect(marginL, 25, 76, 76, 12).fill(COLORS.white);
        doc.image(LOGO_PATH, marginL + 4, 29, { width: 68, height: 68 });
        doc.restore();
      } catch (_) {}
    }

    const headerTextX = marginL + 92;
    const headerTextW = contentWidth - 92;

    doc.fillColor('#34D399').font('Helvetica-Bold').fontSize(10)
      .text('GUÍA PRÁCTICA DE VOZ Y TEXTO EN WHATSAPP', headerTextX, 26, { width: headerTextW });
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(22)
      .text('Manual Oficial de Uso de PresuVoz', headerTextX, 42, { width: headerTextW });
    doc.fillColor('#CBD5E1').font('Helvetica').fontSize(10.2)
      .text(
        'Aprende cómo hablarle a tu asistente en WhatsApp para crear presupuestos, emitir facturas, agendar visitas, controlar tu lista de la compra y calcular materiales sin errores.',
        headerTextX,
        72,
        { width: headerTextW, lineGap: 2 }
      );

    // Etiquetas rápidas en portada
    const pills = ['Audio o Texto Natural', 'Deslizar para Responder', '21 Gremios', '100% en tu WhatsApp'];
    let pillX = headerTextX;
    for (const pill of pills) {
      const pw = doc.font('Helvetica-Bold').fontSize(8.5).widthOfString(pill) + 16;
      doc.roundedRect(pillX, 113, pw, 18, 9).fill('#1E293B');
      doc.fillColor('#6EE7B7').font('Helvetica-Bold').fontSize(8.5).text(pill, pillX + 8, 117.5, { lineBreak: false });
      pillX += pw + 8;
    }

    doc.y = 160;

    // ─── REGLA DE ORO + DESLIZAR PARA RESPONDER ─────────────────────────────
    function drawHighlightBox(title, body, examples, theme = 'emerald') {
      const bg = theme === 'emerald' ? COLORS.emeraldBg : theme === 'blue' ? COLORS.blueBg : COLORS.amberBg;
      const border = theme === 'emerald' ? COLORS.emeraldBorder : theme === 'blue' ? COLORS.blueBorder : COLORS.amberBorder;
      const accent = theme === 'emerald' ? COLORS.emeraldDark : theme === 'blue' ? COLORS.blue : COLORS.amber;

      const textW = contentWidth - 28;
      doc.font('Helvetica').fontSize(9.3);
      const bodyH = doc.heightOfString(body, { width: textW, lineGap: 1.5 });

      let exH = 0;
      const exHeights = [];
      if (examples && examples.length) {
        exH += 6;
        for (const ex of examples) {
          doc.font('Helvetica-Oblique').fontSize(8.9);
          const h = doc.heightOfString(`• ${ex}`, { width: textW, lineGap: 1.2 });
          exHeights.push(h);
          exH += h + 4;
        }
      }
      const boxH = 28 + bodyH + exH + 10;

      ensureSpace(boxH + 8);
      const startY = doc.y;

      doc.save();
      doc.roundedRect(marginL, startY, contentWidth, boxH, 7).fillAndStroke(bg, border);
      doc.rect(marginL, startY, 4.5, boxH).fill(accent);

      doc.fillColor(accent).font('Helvetica-Bold').fontSize(10.5)
        .text(title, marginL + 14, startY + 9, { width: textW });

      doc.fillColor(COLORS.navy).font('Helvetica').fontSize(9.3)
        .text(body, marginL + 14, startY + 24, { width: textW, lineGap: 1.5 });

      let curY = startY + 28 + bodyH;
      if (examples && examples.length) {
        for (let i = 0; i < examples.length; i++) {
          doc.fillColor(accent).font('Helvetica-Bold').fontSize(8.9)
            .text('• ', marginL + 14, curY, { continued: true })
            .fillColor(COLORS.slateDark).font('Helvetica-Oblique')
            .text(examples[i], { width: textW - 10, lineGap: 1.2 });
          curY += exHeights[i] + 4;
        }
      }
      doc.restore();
      doc.y = startY + boxH + 9;
    }

    drawHighlightBox(
      'REGLA DE ORO 1: Habla con naturalidad (por nota de voz o por texto)',
      'Todo lo que puedes hacer en PresuVoz funciona exactamente igual mandando un audio que escribiendo un mensaje. No necesitas comandos robóticos, pero usar las expresiones de esta guía garantiza que el bot te entienda a la primera al 100%.',
      [
        'Si vas conduciendo o en mitad de la obra, manda un audio. Si estás con el cliente delante, escribe dos palabras.'
      ],
      'emerald'
    );

    drawHighlightBox(
      'REGLA DE ORO 2: El truco de "Deslizar un mensaje hacia la derecha" (Responder / Citar)',
      'En WhatsApp puedes deslizar hacia la derecha CUALQUIER mensaje antiguo que te haya enviado el bot (un presupuesto, una factura, un cálculo de materiales, una cita o tu lista de la compra) para darle una orden directa sobre él sin repetir los datos:',
      [
        'Deslizas un cálculo de pladur antiguo -> dices: "Añádelo a la lista de la compra de Carlos" o "Recalcúlalo con un 15% de merma".',
        'Deslizas un presupuesto de hace una semana -> dices: "Sube la pintura a 950 €" o "Hazle factura del 30% de anticipo".',
        'Deslizas el recordatorio de tus visitas de hoy -> dices: "La primera ya está hecha y la segunda pásala a mañana a las 10".'
      ],
      'blue'
    );

    // ─── HELPER PARA SECCIONES DE FUNCIONALIDADES ──────────────────────────
    function drawSectionHeader(num, title, subtitle) {
      ensureSpace(145);
      const startY = doc.y + 3;
      doc.save();
      doc.roundedRect(marginL, startY, contentWidth, 36, 6).fill(COLORS.navyLight);
      doc.roundedRect(marginL + 8, startY + 6, 25, 24, 5).fill(COLORS.emerald);
      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(11.5)
        .text(String(num), marginL + 8, startY + 12, { width: 25, align: 'center', lineBreak: false });

      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(12)
        .text(title, marginL + 40, startY + 6, { width: contentWidth - 50, lineBreak: false });
      doc.fillColor('#94A3B8').font('Helvetica').fontSize(8.6)
        .text(subtitle, marginL + 40, startY + 21, { width: contentWidth - 50, lineBreak: false });
      doc.restore();
      doc.y = startY + 43;
    }

    function drawActionBlock(actionTitle, description, phrases, tip = null) {
      const innerW = contentWidth - 24;
      const phraseW = contentWidth - 36;

      doc.font('Helvetica').fontSize(9.1);
      const descH = description ? doc.heightOfString(description, { width: innerW, lineGap: 1.3 }) + 4 : 0;

      let phrasesH = 0;
      const phraseHeights = [];
      for (const p of phrases) {
        doc.font('Helvetica-Oblique').fontSize(9.1);
        const h = doc.heightOfString(`-> "${p}"`, { width: phraseW, lineGap: 1.2 });
        phraseHeights.push(h);
        phrasesH += h + 3.5;
      }

      doc.font('Helvetica').fontSize(8.5);
      const tipH = tip ? doc.heightOfString(`Consejo: ${tip}`, { width: innerW, lineGap: 1.2 }) + 8 : 0;
      const totalH = 23 + descH + phrasesH + tipH + 7;

      ensureSpace(totalH + 6);
      const startY = doc.y;

      doc.save();
      doc.roundedRect(marginL, startY, contentWidth, totalH, 6).fillAndStroke(COLORS.cardBg, COLORS.border);
      doc.rect(marginL, startY, 3.5, totalH).fill(COLORS.emerald);

      doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(10)
        .text(actionTitle, marginL + 12, startY + 7.5, { width: innerW });

      let curY = startY + 22;
      if (description) {
        doc.fillColor(COLORS.slateDark).font('Helvetica').fontSize(9.1)
          .text(description, marginL + 12, curY, { width: innerW, lineGap: 1.3 });
        curY += descH;
      }

      for (let i = 0; i < phrases.length; i++) {
        doc.fillColor(COLORS.emeraldDark).font('Helvetica-Bold').fontSize(9.1)
          .text('-> ', marginL + 12, curY, { continued: true })
          .fillColor(COLORS.navy).font('Helvetica-Oblique')
          .text(`"${phrases[i]}"`, { width: phraseW, lineGap: 1.2 });
        curY += phraseHeights[i] + 3.5;
      }

      if (tip) {
        curY += 2;
        doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(8.5)
          .text('Consejo: ', marginL + 12, curY, { continued: true })
          .fillColor(COLORS.slateMuted).font('Helvetica')
          .text(tip, { width: innerW, lineGap: 1.2 });
      }

      doc.restore();
      doc.y = startY + totalH + 6;
    }

    // ─── SECCIÓN 1: PRESUPUESTOS ───────────────────────────────────────────
    drawSectionHeader(
      1,
      'Creación y Gestión de Presupuestos',
      'Crea presupuestos nuevos, modifícalos al vuelo, aplica descuentos y envíalos con enlace de firma digital.'
    );

    drawActionBlock(
      '1.1. Crear un presupuesto nuevo desde cero',
      'Para empezar un presupuesto nuevo y no mezclar datos con el cliente anterior, empieza tu audio o texto diciendo "Presupuesto nuevo" o "Nueva obra", seguido del cliente y las partidas.',
      [
        'Presupuesto nuevo para Carlos Martínez en Calle Alcalá 45: demolición de baño 450 €, alicatado 22 metros a 35 € el metro y fontanería completa 900 €.',
        'Nueva obra para María López: pintar piso de 80 metros por 1.200 € y alisar paredes del salón por 650 €.',
        'Presupuesto nuevo para Juan: colocar 3 puertas de roble, pero todavía no sé el precio.'
      ],
      'Si aún no sabes el precio de una partida, dilo tal cual ("sin precio" o "pendiente de valorar"). PresuVoz creará un Borrador para que pongas el precio más tarde.'
    );

    drawActionBlock(
      '1.2. Modificar un presupuesto (añadir, quitar o cambiar precios)',
      'Puedes modificar el presupuesto que acabas de crear o cualquiera antiguo nombrando al cliente, diciendo su código (PRE-2026-XXXX) o deslizando su mensaje.',
      [
        'En el presupuesto de Carlos Martínez cambia el precio de la fontanería a 1.050 €.',
        'Añade al presupuesto de María López una partida de retirar rodapié por 180 €.',
        'Quita la partida de alisar paredes del presupuesto de María.',
        'Perdón, eran 1.350 € (si te equivocaste en el último precio dictado, lo corrige al instante).'
      ]
    );

    drawActionBlock(
      '1.3. Descuentos, IVA y Retención de IRPF',
      'Ajusta los impuestos (21% general o 10% reforma vivienda) y aplica descuentos en porcentaje o en euros fijos.',
      [
        'Aplícale un 10% de descuento al presupuesto de Carlos.',
        'Hazle un descuento de 150 € al presupuesto de María.',
        'Pon el IVA al 10% en el presupuesto de Carlos.',
        'Aplica un 7% de retención de IRPF al presupuesto.'
      ]
    );

    drawActionBlock(
      '1.4. Ver presupuestos, Enlace de Firma Digital y Estados',
      'Consulta cualquier presupuesto guardado, saca el enlace para que el cliente firme con el dedo desde su móvil o cambia su estado.',
      [
        'Enséñame el presupuesto de Carlos Martínez  /  Muéstrame el PRE-2026-004.',
        'Mis presupuestos  /  ¿Qué presupuestos tengo pendientes de firma?  /  Presupuestos aceptados.',
        'Pásame el enlace de firma de Carlos Martínez.',
        'El presupuesto de Carlos ya está aceptado  /  Cancela el presupuesto de Pedro.'
      ],
      'PresuVoz vigila tus presupuestos enviados y te avisa automáticamente antes de que caduquen (a los 15 días) para que no pierdas el trabajo.'
    );

    // ─── SECCIÓN 2: FACTURACIÓN OFICIAL ────────────────────────────────────
    drawSectionHeader(
      2,
      'Facturación Oficial (Anticipos, Hitos, Fases y Final)',
      'Genera facturas legales en PDF vinculadas al presupuesto sin volver a teclear ni un solo dato.'
    );

    drawActionBlock(
      '2.1. Factura de Anticipo o Entrega a cuenta',
      'Pídela antes de empezar la obra por un importe fijo en euros o por un porcentaje del presupuesto.',
      [
        'Haz una factura de anticipo de 1.500 € a Carlos Martínez.',
        'Factura el 30% de anticipo del presupuesto de María López.'
      ]
    );

    drawActionBlock(
      '2.2. Factura por Hito o Certificación parcial',
      'Ideal para cobrar a mitad de obra según el avance acordado con el cliente.',
      [
        'Haz una factura de hito de 2.000 € para Carlos Martínez en concepto de avance de obra.',
        'Factura un segundo pago de 1.200 € a María López.'
      ]
    );

    drawActionBlock(
      '2.3. Factura de una Fase o Partida concreta del presupuesto',
      'Factura exactamente una partida específica del presupuesto (ej. la demolición o la fontanería).',
      [
        'Factura la partida de demolición de Carlos Martínez.',
        'Haz factura de la fase de fontanería de la obra de Juan.'
      ]
    );

    drawActionBlock(
      '2.4. Factura Final (Liquidación) y Factura Rectificativa',
      'Al pedir la factura final, PresuVoz descuenta automáticamente todos los anticipos e hitos que ya hayas facturado antes.',
      [
        'Haz la factura final de Carlos Martínez  /  Liquidar obra de Carlos.',
        'Haz una factura rectificativa de 250 € a Carlos Martínez por ajuste de medición.',
        '¿Qué obras tengo pendientes de facturar?  /  Facturas pendientes de cobro.'
      ]
    );

    // ─── SECCIÓN 3: COBROS Y DEUDAS ────────────────────────────────────────
    drawSectionHeader(
      3,
      'Control de Cobros, Recibos y Quién te Debe Dinero',
      'Registra los pagos que te van haciendo y consulta al instante el saldo pendiente de cada cliente.'
    );

    drawActionBlock(
      '3.1. Registrar un cobro y generar Recibo PDF',
      'Cada vez que un cliente te paga, díselo al bot indicando el método (Bizum, transferencia o efectivo). Te generará un justificante en PDF.',
      [
        'Carlos Martínez me ha pagado 1.500 € por transferencia.',
        'Apunta un cobro de 600 € de María López por Bizum.',
        'Juan ya me ha pagado todo lo que me debía en efectivo.'
      ]
    );

    drawActionBlock(
      '3.2. Consultar deudas e ingresos del mes',
      'Pregunta en cualquier momento quién tiene pagos pendientes o cuánto llevas cobrado.',
      [
        '¿Quién me debe dinero?  /  ¿Cuánto me debe Carlos Martínez?',
        '¿Cuánto he cobrado este mes?  /  ¿Cuánto he facturado este año?'
      ]
    );

    // ─── SECCIÓN 4: AGENDA DE VISITAS ──────────────────────────────────────
    drawSectionHeader(
      4,
      'Agenda de Visitas Técnicas y Recordatorios Automáticos',
      'Organiza tus visitas para medir obras con enlaces directos a Google Maps y avisos automáticos.'
    );

    drawActionBlock(
      '4.1. Agendar una o varias visitas de golpe',
      'Puedes apuntar una cita suelta o dictar todas las visitas de la semana en un solo audio.',
      [
        'Apunta visita mañana a las 11:00 con Antonio en Calle Betis 18 para ver un baño.',
        'Agenda para el jueves: a las 9:30 con Laura en Avenida de la Paz 12, y a las 12:00 con Roberto en Calle Sol 4.'
      ],
      'Si agendas una cita que coincide en hora con otra, PresuVoz te avisará del solapamiento en el acto.'
    );

    drawActionBlock(
      '4.2. Consultar, modificar, cancelar o marcar visitas como hechas',
      'Pide tu agenda para abrir la dirección en Google Maps con un toque, mueve citas o márcalas como completadas.',
      [
        '¿Qué visitas tengo hoy?  /  ¿Qué citas tengo mañana?  /  Visitas de esta semana.',
        'Pasa la visita de Antonio al viernes a las 17:00.',
        'Cancela la cita de Laura.',
        'La visita de Antonio ya está hecha  /  Las dos primeras visitas hechas y la de Roberto pásala a mañana a las 10.'
      ],
      'PresuVoz te envía 3 recordatorios automáticos: la víspera a las 19:30, por la mañana a las 07:30 y al final de la tarde para preguntarte si pudiste completar las visitas del día.'
    );

    // ─── SECCIÓN 5: LISTA DE LA COMPRA ─────────────────────────────────────
    drawSectionHeader(
      5,
      'Lista de la Compra por Obra y Almacén',
      'Apunta materiales, consulta tu lista, edita cantidades, borra artículos sueltos o táchalos al comprarlos.'
    );

    drawActionBlock(
      '5.1. Apuntar materiales (para un cliente, varios clientes o almacén)',
      'Puedes dictar materiales para una obra concreta, para varios clientes en el mismo audio o sin cliente (almacén general).',
      [
        'Apunta en la lista de la compra para Carlos: 6 sacos de cemento cola y 3 botes de pintura blanca.',
        'Para la obra de Alberto apunta 10 placas de pladur, y para María apunta 2 cajas de azulejo blanco.',
        'Apunta 3 botes de pintura: uno amarillo, uno azul y otro rojo (los separa en 3 líneas independientes para tacharlos por separado).'
      ]
    );

    drawActionBlock(
      '5.2. Consultar qué o cuántos materiales tienes que comprar',
      'Pregunta por toda tu lista de la compra o filtra solo por la obra de un cliente.',
      [
        '¿Qué materiales tengo que comprar?  /  ¿Cuántos materiales tengo que comprar?',
        'Lista de la compra  /  ¿Qué tengo que comprar para Carlos?',
        '¿Qué materiales he comprado ya? (muestra el historial de materiales ya tachados).'
      ]
    );

    drawActionBlock(
      '5.3. Editar o cambiar la cantidad de un material de la lista',
      'Si necesitas más o menos cantidad de un artículo que ya tenías apuntado, edítalo directamente:',
      [
        'Cambia los 3 botes de pintura de la lista a 5.',
        'En la lista de la compra de Carlos pon 8 placas de pladur en vez de 4.',
        'Modifica el cemento cola a 10 sacos en la lista de la compra.'
      ]
    );

    drawActionBlock(
      '5.4. Borrar un material suelto, tachar como comprado o vaciar la lista',
      'Diferencia entre quitar un artículo que ya no vas a comprar, tachar uno que acabas de comprar en el almacén, o vaciar toda la lista.',
      [
        'Quita el cemento cola de la lista de la compra  /  Borra los 3 botes de pintura de la lista de Carlos (lo elimina).',
        'Ya he comprado el cemento cola de Carlos  /  Tacha el bote de pintura azul (lo marca como comprado).',
        'Vacía la lista de la compra (borra toda la lista tras pedirte confirmación).'
      ]
    );

    // ─── SECCIÓN 6: CALCULADORA TÉCNICA DE MATERIALES ──────────────────────
    drawSectionHeader(
      6,
      'Calculadora Técnica de Materiales y Mermas (21 Gremios)',
      'Calcula al instante las cantidades exactas de material y merma para cualquier trabajo de obra.'
    );

    drawActionBlock(
      '6.1. Cómo pedir un cálculo de materiales',
      'Indica SIEMPRE el tipo de trabajo/material y las medidas (m2, metros lineales o ancho x alto). Cubre 21 gremios: pladur (tabiques, trasdosados, techos), azulejos/alicatado, pintura, ladrillo, solera/hormigón, mortero, autonivelante, impermeabilización, tarima, rodapié, aislamiento, electricidad, fontanería, suelo radiante, climatización, carpintería, fachada SATE, tejados, piscinas, demolición/escombros y jardinería.',
      [
        '¿Cuántas placas de pladur necesito para un tabique de 4 metros de largo por 2,60 de alto con doble placa?',
        '¿Cuántos azulejos de 30x60 necesito para alicatar un baño de 18 m2?',
        '¿Cuántos litros de pintura necesito para pintar un piso de 90 m2 dando 2 manos?',
        'Calcúlame el material para una solera de hormigón de 40 m2 con 10 cm de espesor.'
      ]
    );

    drawActionBlock(
      '6.2. Recalcular y pasar el resultado a la Lista de la Compra o al Presupuesto',
      'Una vez que el bot te da el desglose técnico (o deslizando ese mensaje hacia la derecha), puedes pedirle:',
      [
        'Recalcúlamelo con un 15% de merma  /  Calcúlalo dando 3 manos.',
        'Añádelo a la lista de la compra de Carlos  /  Pásalo a mi lista de la compra.',
        'Mételo en el presupuesto de Carlos.'
      ]
    );

    // ─── SECCIÓN 7: MODO OBRA Y CONFIGURACIÓN ──────────────────────────────
    drawSectionHeader(
      7,
      'Modo Obra, Datos de Empresa y Secretario Diario',
      'Controla qué tareas faltan en cada reforma y personaliza los datos oficiales de tus PDFs.'
    );

    drawActionBlock(
      '7.1. Modo Obra: seguimiento de tareas, fases y plazos',
      'Consulta en un vistazo el estado completo de una reforma (partidas hechas, materiales pendientes, cobros y plazos).',
      [
        '¿Cómo va la obra de Carlos?  /  ¿Qué nos falta en la obra de Carlos?',
        'Ya hemos terminado la demolición de Carlos  /  Marca la fontanería de Carlos como hecha.',
        'La obra de Carlos empieza el 10 de noviembre y termina el 28 de noviembre.'
      ]
    );

    drawActionBlock(
      '7.2. Configurar tu Empresa y pedir el Resumen del Día',
      'Puedes actualizar tus datos fiscales, cuenta bancaria o Bizum en cualquier momento, o enviar una imagen con tu logotipo.',
      [
        'Mis datos de empresa  /  Pon mi teléfono de Bizum al 600 123 456  /  Cambia mi IBAN a ES91...',
        'Resumen del día  /  Secretario (te muestra tu agenda de hoy, cobros pendientes y presupuestos por firmar).'
      ]
    );

    // ─── SECCIÓN 8: DICCIONARIO RÁPIDO DE JERGA (TABLA VISUAL) ─────────────
    ensureSpace(190);
    drawSectionHeader(
      8,
      'Guía Rápida para No Confundir al Bot (Casos Frecuentes)',
      'Cómo diferenciar frases parecidas para que PresuVoz haga siempre exactamente lo que quieres.'
    );

    const comparisons = [
      {
        intent: 'Ver tu Lista de la Compra actual',
        say: '"¿Cuántos materiales tengo que comprar?" o "¿Qué tengo que comprar?" (sin medidas de obra)',
        avoid: 'No le pongas m2 ni medidas si solo quieres ver tu lista de la compra.'
      },
      {
        intent: 'Calcular materiales para un trabajo',
        say: '"¿Cuántas placas de pladur necesito para 20 m2?" o "Calcúlame azulejos para 15 m2"',
        avoid: 'Dile siempre el material/trabajo (pladur, pintura, azulejo...) y los metros.'
      },
      {
        intent: 'Quitar 1 artículo vs. Tacharlo',
        say: '"Quita el cemento de la lista" (lo borra)  |  "Ya compré el cemento" (lo tacha como comprado)',
        avoid: 'No digas "Vacía la lista" si solo quieres borrar un material suelto.'
      },
      {
        intent: 'Empezar presupuesto de otro cliente',
        say: '"Presupuesto nuevo para [Nombre Cliente]..."',
        avoid: 'Si no dices "Presupuesto nuevo", pensará que sigues editando el último presupuesto.'
      }
    ];

    for (const row of comparisons) {
      const rightColW = contentWidth - 188;
      doc.font('Helvetica-Bold').fontSize(8.8);
      const sayH = doc.heightOfString(`Di así: ${row.say}`, { width: rightColW, lineGap: 1.2 });
      doc.font('Helvetica').fontSize(8.4);
      const avoidH = doc.heightOfString(`Nota: ${row.avoid}`, { width: rightColW, lineGap: 1.2 });
      const rowH = Math.max(36, 12 + sayH + avoidH + 6);

      ensureSpace(rowH + 6);
      const y = doc.y;
      doc.save();
      doc.roundedRect(marginL, y, contentWidth, rowH, 5).fillAndStroke('#F1F5F9', COLORS.border);
      doc.fillColor(COLORS.emeraldDark).font('Helvetica-Bold').fontSize(9.2)
        .text(row.intent, marginL + 10, y + 8, { width: 162 });
      doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(8.8)
        .text(`Di así: ${row.say}`, marginL + 178, y + 7, { width: rightColW, lineGap: 1.2 });
      doc.fillColor(COLORS.slateMuted).font('Helvetica').fontSize(8.4)
        .text(`Nota: ${row.avoid}`, marginL + 178, y + 9 + sayH, { width: rightColW, lineGap: 1.2 });
      doc.restore();
      doc.y = y + rowH + 5;
    }

    // ─── NUMERACIÓN DE PÁGINAS Y PIE DE PÁGINA (SIN AUTO-PAGINACIÓN) ───────
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const prevBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const footerY = pageHeight - 28;
      doc.save();
      doc.moveTo(marginL, footerY - 6).lineTo(pageWidth - marginR, footerY - 6).strokeColor(COLORS.border).lineWidth(0.7).stroke();
      doc.fillColor(COLORS.slateMuted).font('Helvetica').fontSize(8.5)
        .text('PresuVoz — Tu oficina técnica en WhatsApp  |  Soporte y demos en presuvoz.com', marginL, footerY, {
          width: contentWidth * 0.75,
          lineBreak: false
        });
      doc.fillColor(COLORS.navy).font('Helvetica-Bold').fontSize(8.5)
        .text(`Página ${i + 1} de ${range.count}`, marginL, footerY, {
          width: contentWidth,
          align: 'right',
          lineBreak: false
        });
      doc.restore();
      doc.page.margins.bottom = prevBottom;
    }

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

for (const out of OUTPUT_PATHS) {
  await createManualPDF(out);
  console.log(`✅ Manual PDF generado en: ${out}`);
}
