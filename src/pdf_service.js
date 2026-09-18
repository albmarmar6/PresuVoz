import PDFDocument from 'pdfkit';

/**
 * Genera un Buffer con el PDF formal del presupuesto
 * @param {object} budget - Objeto presupuesto procesado por PresuVozEngine
 * @returns {Promise<Buffer>}
 */
export function generateBudgetPDF(budget) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Presupuesto ${budget.id || 'PresuVoz'}`,
          Author: budget.company?.name || 'PresuVoz',
          Subject: 'Presupuesto formal de obra'
        }
      });

      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const primaryColor = '#059669'; // Emerald 600
      const darkColor = '#0f172a';    // Slate 900
      const grayColor = '#64748b';    // Slate 500
      const borderColor = '#e2e8f0';  // Slate 200

      // 1. Barra superior decorativa
      doc.rect(0, 0, 595.28, 8).fill(primaryColor);

      // 2. Cabecera (Empresa vs Datos del documento)
      doc.fontSize(16).fillColor(darkColor).font('Helvetica-Bold')
        .text(budget.company?.name || 'PresuVoz Reformas S.L.', 40, 30);

      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`CIF: ${budget.company?.cif || 'B-41987654'}`, 40, 50)
        .text(budget.company?.address || 'Pol. Ind. El Pino, Nave 4 - Sevilla', 40, 62)
        .text('Tel: 601 02 23 67 | presupuestos@presuvoz.app', 40, 74);

      // Caja resumen de presupuesto (derecha)
      const docType = budget.isDraft ? 'BORRADOR TÉCNICO' : 'PRESUPUESTO';
      doc.roundedRect(380, 25, 175, 65, 4).strokeColor(borderColor).stroke();
      doc.fontSize(8).fillColor(primaryColor).font('Helvetica-Bold')
        .text(docType, 390, 33);
      doc.fontSize(12).fillColor(darkColor).font('Helvetica-Bold')
        .text(budget.id || 'PV-2026-001', 390, 45);
      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`Fecha: ${new Date().toLocaleDateString('es-ES')}`, 390, 62)
        .text(`Validez: ${budget.terms?.validityDays || 15} días`, 390, 74);

      // 3. Bloque Cliente y Ubicación
      const clientY = 105;
      doc.roundedRect(40, clientY, 515, 55, 4).fillColor('#f8fafc').fillAndStroke('#f8fafc', borderColor);

      doc.fontSize(8).fillColor(primaryColor).font('Helvetica-Bold')
        .text('DATOS DEL CLIENTE Y UBICACIÓN DE OBRA', 50, clientY + 8);

      doc.fontSize(9).fillColor(darkColor).font('Helvetica-Bold')
        .text(`Cliente: ${budget.client?.name || 'Cliente Particular'}`, 50, clientY + 22);

      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`Dirección de obra: ${budget.client?.address || 'Ubicación según visita'}`, 50, clientY + 36);

      // 4. Tabla de Partidas
      let tableY = 175;
      doc.rect(40, tableY, 515, 20).fill(darkColor);

      doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
        .text('#', 48, tableY + 6, { width: 20 })
        .text('DESCRIPCIÓN DE LOS TRABAJOS', 75, tableY + 6, { width: 285 })
        .text('CANT.', 365, tableY + 6, { width: 50, align: 'right' })
        .text('PRECIO UD.', 420, tableY + 6, { width: 60, align: 'right' })
        .text('TOTAL', 485, tableY + 6, { width: 60, align: 'right' });

      tableY += 20;

      (budget.items || []).forEach((item, index) => {
        const isPending = item.isPricePending || item.total === 0;
        const totalText = isPending ? 'A valorar' : `${item.total.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
        const unitPriceText = isPending ? '-' : `${item.unitPrice.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
        const qtyText = `${item.qty} ${item.unit || 'pa'}`;

        // Fondo alterno suave
        if (index % 2 === 1) {
          doc.rect(40, tableY, 515, 24).fill('#f8fafc');
        }

        doc.fontSize(8).fillColor(grayColor).font('Helvetica')
          .text(String(index + 1), 48, tableY + 6, { width: 20 });

        doc.fontSize(8).fillColor(darkColor).font('Helvetica')
          .text(item.description, 75, tableY + 6, { width: 285 });

        doc.fontSize(8).fillColor(grayColor).font('Helvetica')
          .text(qtyText, 365, tableY + 6, { width: 50, align: 'right' });

        doc.fontSize(8).fillColor(grayColor).font('Helvetica')
          .text(unitPriceText, 420, tableY + 6, { width: 60, align: 'right' });

        doc.fontSize(8).fillColor(isPending ? '#b45309' : darkColor).font(isPending ? 'Helvetica-Oblique' : 'Helvetica-Bold')
          .text(totalText, 485, tableY + 6, { width: 60, align: 'right' });

        // Línea inferior de fila
        doc.moveTo(40, tableY + 24).lineTo(555, tableY + 24).strokeColor('#f1f5f9').stroke();
        tableY += 24;
      });

      // 5. Totales y Fiscalidad (abajo a la derecha)
      tableY += 15;
      const fin = budget.financials || {};
      const totalsX = 350;

      doc.fontSize(8).fillColor(grayColor).font('Helvetica');

      if (fin.discountAmount > 0) {
        doc.text('Subtotal:', totalsX, tableY)
          .text(`${fin.subtotal.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
        tableY += 14;

        doc.text(`Descuento (${fin.discountPercentage}%):`, totalsX, tableY)
          .text(`-${fin.discountAmount.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
        tableY += 14;
      }

      doc.text('Base Imponible:', totalsX, tableY)
        .text(`${(fin.taxableBase || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
      tableY += 14;

      doc.text(`IVA (${fin.taxRatePercentage || 10}%):`, totalsX, tableY)
        .text(`${(fin.taxAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
      tableY += 16;

      // Cuadro de Total Final
      doc.rect(totalsX - 10, tableY - 4, 215, 26).fill(primaryColor);
      doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
        .text('TOTAL PRESUPUESTO:', totalsX, tableY + 4)
        .text(`${(fin.totalAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 475, tableY + 4, { width: 70, align: 'right' });

      // 6. Condiciones de Pago (abajo a la izquierda)
      const termsY = tableY - 40;
      doc.fontSize(8).fillColor(darkColor).font('Helvetica-Bold')
        .text('CONDICIONES GENERALES Y FORMA DE PAGO:', 40, termsY);

      doc.fontSize(7.5).fillColor(grayColor).font('Helvetica')
        .text(`• Anticipo: ${fin.advancePercentage || 30}% a la aceptación del presupuesto (${(fin.advanceAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €).`, 40, termsY + 12)
        .text(`• Resto: ${100 - (fin.advancePercentage || 30)}% a la finalización y recepción de los trabajos.`, 40, termsY + 22)
        .text('• Precios válidos durante 15 días desde la fecha de emisión.', 40, termsY + 32)
        .text('• Trabajos con garantía de 2 años según legislación vigente.', 40, termsY + 42);

      // 7. Firmas
      const signY = 700;
      doc.rect(40, signY, 240, 70).strokeColor(borderColor).stroke();
      doc.fontSize(7.5).fillColor(grayColor).font('Helvetica')
        .text('POR LA EMPRESA INSTALADORA', 50, signY + 8)
        .text('Firma y Sello:', 50, signY + 55);

      doc.rect(315, signY, 240, 70).strokeColor(borderColor).stroke();
      doc.fontSize(7.5).fillColor(grayColor).font('Helvetica')
        .text('CONFORME DEL CLIENTE', 325, signY + 8)
        .text('Firma y DNI: ____________________ Fecha: ___/___/2026', 325, signY + 55);

      // Pie de página
      doc.fontSize(7).fillColor('#94a3b8').font('Helvetica')
        .text('Documento emitido electrónicamente por PresuVoz AI. Válido a efectos contractuales una vez firmado por ambas partes.', 40, 790, { align: 'center', width: 515 });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Genera un Buffer con el PDF legal formal de una Factura de Obra
 * @param {object} invoice - Objeto factura generado a partir de un presupuesto
 * @returns {Promise<Buffer>}
 */
export function generateInvoicePDF(invoice) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Factura ${invoice.id || 'FAC-2026'}`,
          Author: invoice.company?.name || 'PresuVoz',
          Subject: 'Factura oficial de obras y reformas'
        }
      });

      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const primaryColor = '#1e40af'; // Blue 800 (distintivo fiscal formal)
      const darkColor    = '#0f172a'; // Slate 900
      const grayColor    = '#64748b'; // Slate 500
      const borderColor  = '#cbd5e1'; // Slate 300

      // 1. Barra superior decorativa azul
      doc.rect(0, 0, 595.28, 8).fill(primaryColor);

      // 2. Cabecera (Datos fiscales del emisor)
      doc.fontSize(16).fillColor(darkColor).font('Helvetica-Bold')
        .text(invoice.company?.name || 'PresuVoz Reformas S.L.', 40, 30);

      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`NIF/CIF: ${invoice.company?.cif || 'B-41987654'}`, 40, 50)
        .text(invoice.company?.address || 'Pol. Ind. El Pino, Nave 4 - Sevilla', 40, 62)
        .text('Tel: 601 02 23 67 | facturas@presuvoz.app', 40, 74);

      // Caja resumen de factura (derecha)
      doc.roundedRect(360, 25, 195, 75, 4).strokeColor(borderColor).stroke();
      doc.fontSize(8).fillColor(primaryColor).font('Helvetica-Bold')
        .text('FACTURA ORDINARIA', 370, 33);
      doc.fontSize(13).fillColor(darkColor).font('Helvetica-Bold')
        .text(invoice.id || 'FAC-2026-0001', 370, 46);
      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`Fecha emisión: ${invoice.issueDate || new Date().toLocaleDateString('es-ES')}`, 370, 63)
        .text(`Fecha operación: ${invoice.operationDate || new Date().toLocaleDateString('es-ES')}`, 370, 74)
        .text(`Ref. Presupuesto: ${invoice.budgetId || 'Obra directa'}`, 370, 85);

      // 3. Bloque Cliente (Datos del destinatario)
      const clientY = 112;
      doc.roundedRect(40, clientY, 515, 58, 4).fillColor('#f8fafc').fillAndStroke('#f8fafc', borderColor);

      doc.fontSize(8).fillColor(primaryColor).font('Helvetica-Bold')
        .text('DATOS FISCALES DEL DESTINATARIO (CLIENTE)', 50, clientY + 8);

      doc.fontSize(9).fillColor(darkColor).font('Helvetica-Bold')
        .text(`Cliente: ${invoice.client?.name || 'Cliente Particular'}`, 50, clientY + 22);

      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`NIF/DNI: ${invoice.client?.nif || 'Consignado en contrato particular'}`, 50, clientY + 35)
        .text(`Dirección: ${invoice.client?.address || 'Ubicación de obra'}`, 50, clientY + 47);

      // 4. Tabla de Partidas ejecutadas
      let tableY = 182;
      doc.rect(40, tableY, 515, 20).fill(primaryColor);

      doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
        .text('#', 48, tableY + 6, { width: 20 })
        .text('CONCEPTO / TRABAJOS EJECUTADOS', 75, tableY + 6, { width: 285 })
        .text('CANT.', 365, tableY + 6, { width: 50, align: 'right' })
        .text('PRECIO UD.', 420, tableY + 6, { width: 60, align: 'right' })
        .text('IMPORTE', 485, tableY + 6, { width: 60, align: 'right' });

      tableY += 20;

      (invoice.items || []).forEach((item, index) => {
        const totalText = `${(item.total || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
        const unitPriceText = `${(item.unitPrice || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
        const qtyText = `${item.qty || 1} ${item.unit || 'pa'}`;

        if (index % 2 === 1) {
          doc.rect(40, tableY, 515, 24).fill('#f8fafc');
        }

        doc.fontSize(8).fillColor(grayColor).font('Helvetica')
          .text(String(index + 1), 48, tableY + 6, { width: 20 });

        doc.fontSize(8).fillColor(darkColor).font('Helvetica')
          .text(item.description, 75, tableY + 6, { width: 285 });

        doc.fontSize(8).fillColor(grayColor).font('Helvetica')
          .text(qtyText, 365, tableY + 6, { width: 50, align: 'right' })
          .text(unitPriceText, 420, tableY + 6, { width: 60, align: 'right' });

        doc.fontSize(8).fillColor(darkColor).font('Helvetica-Bold')
          .text(totalText, 485, tableY + 6, { width: 60, align: 'right' });

        doc.moveTo(40, tableY + 24).lineTo(555, tableY + 24).strokeColor('#e2e8f0').stroke();
        tableY += 24;
      });

      // 5. Totales y Liquidación Fiscal
      tableY += 15;
      const fin = invoice.financials || {};
      const totalsX = 350;

      doc.fontSize(8).fillColor(grayColor).font('Helvetica');

      if ((fin.discountAmount || 0) > 0) {
        doc.text('Subtotal trabajos:', totalsX, tableY)
          .text(`${(fin.subtotal || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
        tableY += 14;

        doc.text(`Descuento comercial (${fin.discountPercentage}%):`, totalsX, tableY)
          .text(`-${(fin.discountAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
        tableY += 14;
      }

      doc.text('Base Imponible:', totalsX, tableY)
        .text(`${(fin.taxableBase || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
      tableY += 14;

      doc.text(`IVA (${fin.taxRatePercentage || 10}%):`, totalsX, tableY)
        .text(`${(fin.taxAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
      tableY += 16;

      // Cuadro de Total Factura
      doc.rect(totalsX - 10, tableY - 4, 215, 24).fill(primaryColor);
      doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
        .text('TOTAL FACTURA:', totalsX, tableY + 4)
        .text(`${(fin.totalAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 475, tableY + 4, { width: 70, align: 'right' });
      tableY += 28;

      // Desglose de anticipo y saldo pendiente
      const advance = fin.advanceAmount || 0;
      const remaining = fin.remainingAmount !== undefined ? fin.remainingAmount : Math.max(0, (fin.totalAmount || 0) - advance);

      if (advance > 0) {
        doc.fontSize(8).fillColor(grayColor).font('Helvetica')
          .text(`Anticipo percibido a cuenta:`, totalsX, tableY)
          .text(`-${advance.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 485, tableY, { width: 60, align: 'right' });
        tableY += 14;

        doc.rect(totalsX - 10, tableY - 3, 215, 22).fill('#f1f5f9');
        doc.fontSize(8.5).fillColor(darkColor).font('Helvetica-Bold')
          .text('TOTAL PENDIENTE DE PAGO:', totalsX, tableY + 3)
          .text(`${remaining.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 475, tableY + 3, { width: 70, align: 'right' });
      }

      // 6. Datos Bancarios para la liquidación (abajo a la izquierda)
      const bankY = tableY - (advance > 0 ? 55 : 40);
      doc.roundedRect(40, bankY, 285, 80, 4).fillColor('#f8fafc').fillAndStroke('#f8fafc', borderColor);

      doc.fontSize(8).fillColor(primaryColor).font('Helvetica-Bold')
        .text('DATOS BANCARIOS PARA EL PAGO:', 50, bankY + 8);

      doc.fontSize(7.5).fillColor(darkColor).font('Helvetica')
        .text(`• Titular: ${invoice.company?.name || 'PresuVoz Reformas S.L.'}`, 50, bankY + 22)
        .text(`• Entidad: Banco Santander | Tipo: Transferencia`, 50, bankY + 33)
        .text(`• IBAN: ES91 2100 0418 4502 0005 1332`, 50, bankY + 44)
        .text(`• Concepto: Pago ${invoice.id || 'Factura'}`, 50, bankY + 55)
        .text(`• O pago inmediato por Bizum al 601 02 23 67`, 50, bankY + 66);

      // 7. Pie de página legal según RD 1619/2012
      doc.fontSize(6.5).fillColor('#94a3b8').font('Helvetica')
        .text('Factura emitida conforme al Real Decreto 1619/2012 (Reglamento de Facturación en España). Garantía de 2 años en mano de obra según Ley de Ordenación de la Edificación (LOE).', 40, 785, { align: 'center', width: 515 });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Genera un Buffer con el PDF formal de un Recibo Oficial de Pago / Justificante de Cobro
 * @param {object} receipt - Datos del recibo y conciliación de saldos
 * @returns {Promise<Buffer>}
 */
export function generateReceiptPDF(receipt) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Recibo ${receipt.id || 'REC-2026'}`,
          Author: receipt.company?.name || 'PresuVoz',
          Subject: 'Justificante de cobro y entrega a cuenta'
        }
      });

      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const primaryColor = '#0d9488'; // Teal 600 (confirmación formal de pago)
      const darkColor    = '#0f172a'; // Slate 900
      const grayColor    = '#64748b'; // Slate 500
      const borderColor  = '#cbd5e1'; // Slate 300
      const isSettled    = (receipt.remainingBalance || 0) <= 0;

      // 1. Barra superior decorativa verde azulada
      doc.rect(0, 0, 595.28, 8).fill(primaryColor);

      // 2. Cabecera (Datos fiscales del emisor / perceptor)
      doc.fontSize(16).fillColor(darkColor).font('Helvetica-Bold')
        .text(receipt.company?.name || 'PresuVoz Reformas S.L.', 40, 30);

      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`NIF/CIF: ${receipt.company?.cif || 'B-41987654'}`, 40, 50)
        .text(receipt.company?.address || 'Pol. Ind. El Pino, Nave 4 - Sevilla', 40, 62)
        .text('Tel: 601 02 23 67 | administracion@presuvoz.app', 40, 74);

      // Caja resumen del recibo (derecha)
      doc.roundedRect(360, 25, 195, 75, 4).strokeColor(borderColor).stroke();
      doc.fontSize(8).fillColor(primaryColor).font('Helvetica-Bold')
        .text('JUSTIFICANTE DE PAGO', 370, 33);
      doc.fontSize(13).fillColor(darkColor).font('Helvetica-Bold')
        .text(receipt.id || 'REC-2026-0001', 370, 46);
      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`Fecha cobro: ${receipt.date || new Date().toLocaleDateString('es-ES')}`, 370, 63)
        .text(`Método: ${receipt.method || 'Transferencia'}`, 370, 74)
        .text(`Ref: ${receipt.budgetId || 'Obra particular'}`, 370, 85);

      // 3. Bloque Cliente / Pagador
      const clientY = 112;
      doc.roundedRect(40, clientY, 515, 58, 4).fillColor('#f8fafc').fillAndStroke('#f8fafc', borderColor);

      doc.fontSize(8).fillColor(primaryColor).font('Helvetica-Bold')
        .text('DATOS DEL PAGADOR / CLIENTE', 50, clientY + 8);

      doc.fontSize(9).fillColor(darkColor).font('Helvetica-Bold')
        .text(`Recibí de: ${receipt.client?.name || 'Cliente Particular'}`, 50, clientY + 22);

      doc.fontSize(8).fillColor(grayColor).font('Helvetica')
        .text(`Ubicación de los trabajos: ${receipt.client?.address || 'Ubicación según visita'}`, 50, clientY + 36);

      // 4. Banner Destacado del Pago Realizado
      const bannerY = 185;
      doc.roundedRect(40, bannerY, 515, 80, 6).fillColor('#f0fdfa').fillAndStroke('#f0fdfa', primaryColor);

      doc.fontSize(9).fillColor(primaryColor).font('Helvetica-Bold')
        .text('IMPORTE RECIBIDO Y JUSTIFICADO:', 60, bannerY + 14);

      doc.fontSize(22).fillColor(darkColor).font('Helvetica-Bold')
        .text(`+${(receipt.amount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, 60, bannerY + 28);

      doc.fontSize(8.5).fillColor(grayColor).font('Helvetica')
        .text(`Concepto: ${receipt.concept || 'Entrega a cuenta para trabajos de reforma'}`, 60, bannerY + 56);

      // 5. Tabla de Conciliación de Saldos
      let tableY = 285;
      doc.fontSize(9).fillColor(darkColor).font('Helvetica-Bold')
        .text('ESTADO Y CONCILIACIÓN DE LA CUENTA', 40, tableY);

      tableY += 16;
      doc.rect(40, tableY, 515, 22).fill(darkColor);
      doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
        .text('CONCEPTO ECONÓMICO', 50, tableY + 7, { width: 320 })
        .text('IMPORTE', 430, tableY + 7, { width: 115, align: 'right' });

      tableY += 22;

      const rows = [
        { label: 'Importe Total Presupuestado de la Obra (IVA incl.):', value: `${(receipt.totalAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, bold: false, color: darkColor },
        { label: 'Total Abonado Anteriormente por el Cliente:', value: `${(receipt.previouslyPaid || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, bold: false, color: grayColor },
        { label: 'Importe Abonado en este Acto (este recibo):', value: `+${(receipt.amount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, bold: true, color: primaryColor },
        { label: 'Total Acumulado Satisfecho hasta la fecha:', value: `${(receipt.totalPaid || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`, bold: true, color: darkColor }
      ];

      rows.forEach((r, idx) => {
        if (idx % 2 === 1) doc.rect(40, tableY, 515, 24).fill('#f8fafc');
        doc.fontSize(8.5).fillColor(r.color).font(r.bold ? 'Helvetica-Bold' : 'Helvetica')
          .text(r.label, 50, tableY + 7, { width: 360 })
          .text(r.value, 430, tableY + 7, { width: 115, align: 'right' });
        doc.moveTo(40, tableY + 24).lineTo(555, tableY + 24).strokeColor('#e2e8f0').stroke();
        tableY += 24;
      });

      // Cuadro de Saldo Pendiente o Liquidación
      tableY += 15;
      const statusBoxColor = isSettled ? '#059669' : '#e0f2fe';
      const statusTextColor = isSettled ? '#ffffff' : '#0369a1';
      const statusBorderColor = isSettled ? '#047857' : '#bae6fd';

      doc.roundedRect(40, tableY, 515, 36, 4).fillColor(statusBoxColor).fillAndStroke(statusBoxColor, statusBorderColor);
      doc.fontSize(9.5).fillColor(statusTextColor).font('Helvetica-Bold')
        .text(isSettled ? '✅ OBRA TOTALMENTE LIQUIDADA Y PAGADA' : '⏳ PENDIENTE DE PAGO RESTANTE:', 55, tableY + 12);
      
      const remainingStr = `${(receipt.remainingBalance || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`;
      doc.fontSize(11).fillColor(statusTextColor).font('Helvetica-Bold')
        .text(isSettled ? '0,00 €' : remainingStr, 400, tableY + 11, { width: 145, align: 'right' });

      // 6. Sección de Firmas y Justificación
      const signY = 560;
      doc.roundedRect(40, signY, 240, 100, 4).strokeColor(borderColor).stroke();
      doc.fontSize(7.5).fillColor(grayColor).font('Helvetica')
        .text('POR LA EMPRESA PERCEPTORA', 50, signY + 10)
        .text('Firma y Sello (Recibí):', 50, signY + 25)
        .text(receipt.company?.name || 'PresuVoz Reformas S.L.', 50, signY + 80);

      doc.roundedRect(315, signY, 240, 100, 4).strokeColor(borderColor).stroke();
      doc.fontSize(7.5).fillColor(grayColor).font('Helvetica')
        .text('CONFORME DEL CLIENTE / PAGADOR', 325, signY + 10)
        .text('Firma:', 325, signY + 25)
        .text(receipt.client?.name || 'Cliente Particular', 325, signY + 80);

      // 7. Pie legal
      doc.fontSize(6.5).fillColor('#94a3b8').font('Helvetica')
        .text('Este documento constituye justificante liberatorio de pago por el importe consignado según los arts. 1.156 y concordantes del Código Civil. Cumple con la Ley 11/2021 de prevención y lucha contra el fraude fiscal.', 40, 785, { align: 'center', width: 515 });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
