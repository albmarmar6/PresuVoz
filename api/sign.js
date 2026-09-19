/**
 * PresuVoz — api/sign.js
 * Endpoint Vercel: recibe el presupuesto + firmas → sella el PDF → envía email al cliente
 */

import PDFDocument from 'pdfkit';
import { Resend }  from 'resend';

// ─── Generar PDF con firmas estampadas ──────────────────────────────────────
function generateSignedPDF(budget, signaturePro, signatureClient, signedAt) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40,
        info: { Title: `Contrato ${budget.id || 'PresuVoz'}`, Author: budget.company?.name || 'PresuVoz', Subject: 'Contrato de obra firmado' }
      });

      const bufs = [];
      doc.on('data', c => bufs.push(c));
      doc.on('end',  ()  => resolve(Buffer.concat(bufs)));
      doc.on('error', e  => reject(e));

      const primary = '#059669';
      const dark    = '#0f172a';
      const gray    = '#64748b';
      const border  = '#e2e8f0';

      // Barra superior
      doc.rect(0, 0, 595.28, 8).fill(primary);

      // Cabecera empresa
      doc.fontSize(16).fillColor(dark).font('Helvetica-Bold')
        .text(budget.company?.name || 'PresuVoz Reformas S.L.', 40, 30);
      doc.fontSize(8).fillColor(gray).font('Helvetica')
        .text(`CIF: ${budget.company?.cif || 'B-41987654'}`, 40, 50)
        .text(budget.company?.address || 'Pol. Ind. El Pino, Nave 4 - Sevilla', 40, 62)
        .text('Tel: 601 02 23 67 | presupuestos@presuvoz.app', 40, 74);

      // Caja documento — estado CONTRATO ACEPTADO
      doc.roundedRect(350, 25, 205, 65, 4).strokeColor(border).stroke();
      doc.fontSize(7).fillColor(primary).font('Helvetica-Bold')
        .text('CONTRATO DE OBRA ACEPTADO', 360, 33);
      doc.fontSize(12).fillColor(dark).font('Helvetica-Bold')
        .text(budget.id || 'PV-2026-001', 360, 45);
      doc.fontSize(7).fillColor(gray).font('Helvetica')
        .text(`Fecha: ${new Date().toLocaleDateString('es-ES')}`, 360, 62)
        .text(`Firmado: ${new Date(signedAt).toLocaleString('es-ES')}`, 360, 73);

      // Bloque cliente
      const clientY = 105;
      doc.roundedRect(40, clientY, 515, 55, 4).fillColor('#f8fafc').fillAndStroke('#f8fafc', border);
      doc.fontSize(8).fillColor(primary).font('Helvetica-Bold')
        .text('DATOS DEL CLIENTE Y UBICACIÓN DE OBRA', 50, clientY + 8);
      doc.fontSize(9).fillColor(dark).font('Helvetica-Bold')
        .text(`Cliente: ${budget.client?.name || 'Cliente Particular'}`, 50, clientY + 22);
      doc.fontSize(8).fillColor(gray).font('Helvetica')
        .text(`Dirección de obra: ${budget.client?.address || 'Ubicación según visita'}`, 50, clientY + 36);

      // Tabla de partidas
      let tableY = 175;
      doc.rect(40, tableY, 515, 20).fill(dark);
      doc.fontSize(8).fillColor('#fff').font('Helvetica-Bold')
        .text('#', 48, tableY + 6, { width: 20 })
        .text('DESCRIPCIÓN DE LOS TRABAJOS', 75, tableY + 6, { width: 285 })
        .text('CANT.', 365, tableY + 6, { width: 50, align: 'right' })
        .text('PRECIO UD.', 420, tableY + 6, { width: 60, align: 'right' })
        .text('TOTAL', 485, tableY + 6, { width: 60, align: 'right' });
      tableY += 20;

      (budget.items || []).forEach((item, idx) => {
        const pending    = item.isPricePending || item.total === 0;
        const totalText  = pending ? 'A valorar' : `${(item.total||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`;
        const priceText  = pending ? '-'          : `${(item.unitPrice||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`;
        if (idx % 2 === 1) doc.rect(40, tableY, 515, 24).fill('#f8fafc');
        doc.fontSize(8).fillColor(gray).font('Helvetica').text(String(idx+1), 48, tableY+6, {width:20});
        doc.fontSize(8).fillColor(dark).font('Helvetica').text(item.description, 75, tableY+6, {width:285});
        doc.fontSize(8).fillColor(gray).font('Helvetica')
          .text(`${item.qty||1} ${item.unit||'pa'}`, 365, tableY+6, {width:50,align:'right'})
          .text(priceText, 420, tableY+6, {width:60,align:'right'});
        doc.fontSize(8).fillColor(pending?'#b45309':dark).font(pending?'Helvetica-Oblique':'Helvetica-Bold')
          .text(totalText, 485, tableY+6, {width:60,align:'right'});
        doc.moveTo(40,tableY+24).lineTo(555,tableY+24).strokeColor('#f1f5f9').stroke();
        tableY += 24;
      });

      // Totales
      tableY += 15;
      const fin = budget.financials || {};
      const totalsX = 350;
      doc.fontSize(8).fillColor(gray).font('Helvetica');
      if ((fin.discountAmount||0) > 0) {
        doc.text('Subtotal:', totalsX, tableY).text(`${(fin.subtotal||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 485, tableY, {width:60,align:'right'}); tableY+=14;
        doc.text(`Descuento (${fin.discountPercentage}%):`, totalsX, tableY).text(`-${(fin.discountAmount||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 485, tableY, {width:60,align:'right'}); tableY+=14;
      }
      doc.text('Base Imponible:', totalsX, tableY).text(`${(fin.taxableBase||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 485, tableY, {width:60,align:'right'}); tableY+=14;
      doc.text(`IVA (${fin.taxRatePercentage||10}%):`, totalsX, tableY).text(`${(fin.taxAmount||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 485, tableY, {width:60,align:'right'}); tableY+=16;
      doc.rect(totalsX-10, tableY-4, 215, 26).fill(primary);
      doc.fontSize(9).fillColor('#fff').font('Helvetica-Bold')
        .text('TOTAL PRESUPUESTO:', totalsX, tableY+4)
        .text(`${(fin.totalAmount||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €`, 475, tableY+4, {width:70,align:'right'});

      // Condiciones de pago
      const termsY = tableY - 40;
      doc.fontSize(8).fillColor(dark).font('Helvetica-Bold').text('CONDICIONES GENERALES Y FORMA DE PAGO:', 40, termsY);
      doc.fontSize(7.5).fillColor(gray).font('Helvetica')
        .text(`• Anticipo: ${fin.advancePercentage||30}% a la aceptación (${(fin.advanceAmount||0).toLocaleString('es-ES',{minimumFractionDigits:2})} €).`, 40, termsY+12)
        .text(`• Resto: ${100-(fin.advancePercentage||30)}% a la finalización y recepción de los trabajos.`, 40, termsY+22)
        .text('• Precios válidos durante 15 días desde la fecha de emisión.', 40, termsY+32)
        .text('• Trabajos con garantía de 2 años según legislación vigente.', 40, termsY+42);

      // ── Cajas de firma ──────────────────────────────────────────────────────
      const signY = 700;

      // Firma profesional
      doc.rect(40, signY, 240, 70).strokeColor(border).stroke();
      doc.fontSize(7.5).fillColor(gray).font('Helvetica')
        .text('POR LA EMPRESA INSTALADORA', 50, signY + 8)
        .text('Firma y Sello:', 50, signY + 55);

      // Firma cliente
      doc.rect(315, signY, 240, 70).strokeColor(border).stroke();
      doc.fontSize(7.5).fillColor(gray).font('Helvetica')
        .text('CONFORME DEL CLIENTE', 325, signY + 8);

      // Estampar las imágenes de firma si se pasan como base64
      const embedSignature = (b64, x, y, w, h) => {
        if (!b64 || !b64.startsWith('data:image')) return false;
        const mimeMatch = b64.match(/data:(image\/\w+);base64,/);
        if (!mimeMatch) return false;
        const imgBuf = Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imgBuf, x, y, { fit: [w, h], align: 'center', valign: 'center' });
        return true;
      };

      const hasProSig = embedSignature(signaturePro, 50, signY + 18, 210, 35);
      if (!hasProSig) {
        doc.fontSize(7).fillColor(primary).font('Helvetica-Bold')
          .text('EMITIDO Y CERTIFICADO TELEMÁTICAMENTE', 50, signY + 22, { width: 220, align: 'center' });
        doc.fontSize(6.5).fillColor(gray).font('Helvetica')
          .text(`Por ${budget.company?.name || 'la empresa instaladora'}`, 50, signY + 34, { width: 220, align: 'center' });
        doc.fontSize(6).fillColor('#94a3b8').font('Helvetica')
          .text(`CIF: ${budget.company?.cif || ''} · Validez legal eIDAS`, 50, signY + 45, { width: 220, align: 'center' });
      }

      const hasClientSig = embedSignature(signatureClient, 325, signY + 18, 210, 35);
      if (!hasClientSig) {
        doc.fontSize(7).fillColor(primary).font('Helvetica-Bold')
          .text('CONFORME REGISTRADO TELEMÁTICAMENTE', 325, signY + 25, { width: 220, align: 'center' });
      }

      // Pie legal con timestamp de firma
      const signedDate = new Date(signedAt).toLocaleString('es-ES');
      doc.fontSize(6.5).fillColor('#94a3b8').font('Helvetica')
        .text(`Firmado electrónicamente el ${signedDate} | Ref: ${budget.id || 'PV'} | Validez según Reglamento UE eIDAS 910/2014 y Ley 6/2020 de España`, 40, 785, {align:'center',width:515});

      doc.end();
    } catch(e) { reject(e); }
  });
}

// ─── Control de firmas únicas (Persistencia remota) ───────────────────────────
const KEYVALUE_APP = 'presuvoz2026';
const inMemorySigned = new Map();

async function checkSignedRemote(budgetId) {
  if (!budgetId) return null;
  const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
  if (inMemorySigned.has(cleanId)) {
    return inMemorySigned.get(cleanId);
  }
  try {
    const key = `signed_${cleanId}`;
    const url = `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${KEYVALUE_APP}/${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const raw = await res.json();
    if (!raw || typeof raw !== 'string') return null;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    inMemorySigned.set(cleanId, parsed);
    return parsed;
  } catch (e) {
    return null;
  }
}

async function markSignedRemote(budgetId, info) {
  if (!budgetId) return;
  const cleanId = String(budgetId).trim().replace(/\s+/g, '_');
  const record = {
    signed: true,
    budgetId: cleanId,
    signedAt: info.signedAt || new Date().toISOString(),
    clientEmail: info.clientEmail || '',
    clientName: info.clientName || ''
  };
  inMemorySigned.set(cleanId, record);
  try {
    const key = `signed_${cleanId}`;
    const raw = JSON.stringify(record);
    const b64 = Buffer.from(raw).toString('base64url');
    const url = `https://keyvalue.immanuel.co/api/KeyVal/UpdateValue/${KEYVALUE_APP}/${encodeURIComponent(key)}/${b64}`;
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch (e) {
    console.error('Error guardando firma remota:', e);
  }
}

// ─── Handler principal ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Endpoint de comprobación: GET /api/sign?id=PRE-2026-XXXX
  if (req.method === 'GET') {
    const budgetId = req.query.id || req.query.check;
    if (!budgetId) {
      return res.status(400).json({ ok: false, error: 'Falta parámetro id o check.' });
    }
    const check = await checkSignedRemote(budgetId);
    return res.status(200).json({
      ok: true,
      budgetId,
      alreadySigned: Boolean(check),
      details: check || null
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  }

  const { budget, signaturePro, signatureClient, clientEmail } = req.body || {};

  if (!budget || !clientEmail || (!signaturePro && !signatureClient)) {
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios: presupuesto, email o la firma de aceptación.' });
  }

  const budgetId = budget.id || 'PRE-2026';

  // Verificar si ya fue firmado previamente
  const alreadySigned = await checkSignedRemote(budgetId);
  if (alreadySigned) {
    return res.status(409).json({
      ok: false,
      alreadySigned: true,
      error: 'Este presupuesto ya ha sido firmado y aceptado previamente. No se admiten firmas duplicadas.',
      details: alreadySigned
    });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: 'Servicio de email no configurado en el servidor (falta RESEND_API_KEY).' });
  }

  const resend = new Resend(apiKey);

  try {
    const signedAt  = new Date().toISOString();
    const pdfBuffer = await generateSignedPDF(budget, signaturePro, signatureClient, signedAt);
    const pdfBase64 = pdfBuffer.toString('base64');
    const budgetId  = budget.id || 'PRE-2026';
    const companyName = budget.company?.name || 'PresuVoz Reformas';
    const clientName  = budget.client?.name  || 'Cliente';
    const total = (budget.financials?.totalAmount || 0).toLocaleString('es-ES', { minimumFractionDigits: 2 });

    const recipients = [clientEmail];
    if (budget.company?.email && budget.company.email.includes('@') && !recipients.includes(budget.company.email)) {
      recipients.push(budget.company.email);
    }

    // Registrar siempre como firmado y formalizado en la nube (el contrato es legal e irrevocable)
    await markSignedRemote(budgetId, { budgetId, clientEmail, signedAt, clientName });

    const emailHtml = `
      <!DOCTYPE html>
      <html lang="es">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
      <body style="margin:0;padding:0;background:#f0fdf4;font-family:Arial,sans-serif;">
        <div style="max-width:560px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <div style="background:#059669;padding:28px 32px;">
            <div style="font-size:22px;font-weight:700;color:white;margin-bottom:4px;">✅ Presupuesto Aceptado</div>
            <div style="font-size:14px;color:#d1fae5;">${budgetId} · ${companyName}</div>
          </div>
          <div style="padding:28px 32px;">
            <p style="color:#374151;font-size:15px;margin:0 0 16px;">Estimado/a <strong>${clientName}</strong>,</p>
            <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 20px;">
              A continuación encontrarás el presupuesto de obra <strong>${budgetId}</strong> firmado por ambas partes. 
              Queda adjunto el documento PDF sellado con validez contractual plena.
            </p>
            <div style="background:#f0fdf4;border:1px solid #d1fae5;border-radius:12px;padding:20px;margin:0 0 24px;">
              <div style="font-size:13px;color:#374151;margin-bottom:8px;"><strong>📄 Resumen del contrato:</strong></div>
              <div style="font-size:13px;color:#6b7280;">Referencia: <strong style="color:#111827;">${budgetId}</strong></div>
              <div style="font-size:13px;color:#6b7280;margin-top:4px;">Importe total: <strong style="color:#059669;font-size:16px;">${total} €</strong></div>
              <div style="font-size:13px;color:#6b7280;margin-top:4px;">Empresa: ${companyName}</div>
            </div>
            <p style="color:#9ca3af;font-size:12px;line-height:1.5;border-top:1px solid #f3f4f6;padding-top:16px;margin:0;">
              ⚖️ Este documento tiene validez contractual plena según el Reglamento Europeo eIDAS 910/2014 y la Ley 6/2020 de servicios electrónicos de confianza de España.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    let emailSentId = null;

    try {
      let emailResult = await resend.emails.send({
        from: 'PresuVoz <onboarding@resend.dev>',
        to:   [clientEmail],
        subject: `Presupuesto Firmado ${budgetId} — ${companyName}`,
        html: emailHtml,
        attachments: [
          {
            filename: `Contrato_${budgetId}.pdf`,
            content:  pdfBase64
          }
        ]
      });

      // Manejar restricción de cuenta de pruebas de Resend (solo permite enviar al email verificado del propietario)
      if (emailResult.error && String(emailResult.error.message).includes('only send testing emails to your own email address')) {
        console.warn('⚠️ Resend en modo pruebas: redirigiendo copia al email verificado del propietario...');
        emailResult = await resend.emails.send({
          from: 'PresuVoz <onboarding@resend.dev>',
          to:   ['albertomartinmartin201@gmail.com'],
          subject: `[Prueba Cliente: ${clientEmail}] Presupuesto Firmado ${budgetId} — ${companyName}`,
          html: `
            <div style="background:#fef3c7;border:1px solid #f59e0b;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px;color:#92400e;">
              🔔 <strong>Modo pruebas de Resend:</strong> El cliente introdujo el email <code>${clientEmail}</code>. Al usar la clave de pruebas de Resend (onboarding), la copia se remite a tu bandeja para que verifiques el contrato adjunto.
            </div>
          ` + emailHtml,
          attachments: [
            {
              filename: `Contrato_${budgetId}.pdf`,
              content:  pdfBase64
            }
          ]
        });
      }

      if (emailResult?.data?.id) {
        emailSentId = emailResult.data.id;
      }
    } catch (mailErr) {
      console.warn('⚠️ No se pudo remitir email por Resend:', mailErr.message);
    }

    return res.status(200).json({ ok: true, emailId: emailSentId, budgetId, signedAt });

  } catch (err) {
    console.error('sign.js error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Error interno al generar el contrato.' });
  }
}
