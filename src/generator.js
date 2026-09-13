/**
 * PresuVoz Document & PDF Generator
 * Genera el documento visual del presupuesto con soporte para firma táctil en el móvil (Diseño v2)
 */

export class PresuVozGenerator {
  /**
   * Genera el HTML completo del presupuesto listo para imprimir o firmar en móvil
   * @param {object} budget - Objeto procesado por PresuVozEngine
   * @returns {string} HTML renderizable
   */
  static generateHTML(budget) {
    const itemsRows = budget.items.map(item => `
          <tr>
            <td class="py-4 pr-6">
              <p class="text-sm font-medium text-slate-800">${item.description}</p>
            </td>
            <td class="text-right py-4 pl-6 text-slate-500 align-top">${item.qty}</td>
            <td class="text-right py-4 pl-6 text-slate-500 align-top whitespace-nowrap">${item.unitPrice.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</td>
            <td class="text-right py-4 pl-6 font-semibold text-slate-800 align-top whitespace-nowrap">${item.total.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</td>
          </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Presupuesto ${budget.id} — ${budget.company.name}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { font-family: 'Inter', sans-serif; }

    @media print {
      .no-print { display: none !important; }
      body { background: white !important; }
      .print-shadow { box-shadow: none !important; }
    }

    canvas { touch-action: none; cursor: crosshair; }

    .sig-line {
      border-bottom: 1.5px solid #d1d5db;
      min-height: 64px;
    }
  </style>
</head>
<body class="bg-slate-100 min-h-screen py-8 px-4">

  <!-- Toolbar -->
  <div class="no-print max-w-3xl mx-auto mb-4 flex items-center justify-between">
    <div class="flex items-center gap-2">
      <div class="w-6 h-6 rounded-md bg-emerald-500 flex items-center justify-center">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      </div>
      <span class="text-xs font-semibold text-slate-600">PresuVoz</span>
      <span class="text-slate-400 text-xs">/</span>
      <span class="text-xs text-slate-500">Presupuesto #${budget.id}</span>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="window.print()" class="text-xs font-medium text-slate-500 hover:text-slate-800 bg-white border border-slate-200 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Imprimir
      </button>
      <span id="statusPill" class="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg">Pendiente de firma</span>
    </div>
  </div>

  <!-- Document -->
  <div class="max-w-3xl mx-auto bg-white rounded-2xl shadow-lg border border-slate-200/80 overflow-hidden print-shadow">

    <!-- Company Header -->
    <div class="p-8 border-b border-slate-100">
      <div class="flex justify-between items-start gap-6">
        <div>
          <!-- Logo placeholder / brand mark -->
          <div class="flex items-center gap-3 mb-3">
            <div class="w-10 h-10 rounded-xl flex items-center justify-center font-black text-white text-sm" style="background-color: ${budget.company.brandColor || '#1e40af'};">
              ${budget.company.logoText}
            </div>
            <div>
              <h1 class="text-base font-bold text-slate-900 leading-tight">${budget.company.name}</h1>
              <p class="text-xs text-slate-500">CIF: ${budget.company.cif}</p>
            </div>
          </div>
          <div class="text-xs text-slate-400 space-y-0.5 mt-4">
            <p>${budget.company.address}</p>
            <p>${budget.company.phone} &nbsp;&middot;&nbsp; ${budget.company.email}</p>
          </div>
        </div>

        <div class="text-right shrink-0">
          <p class="text-[10px] uppercase font-semibold text-slate-400 tracking-widest mb-1">Presupuesto</p>
          <p class="text-lg font-bold text-slate-900">#${budget.id}</p>
          <p class="text-xs text-slate-400 mt-1">Emitido el ${budget.issueDate}</p>
          <p class="text-xs text-slate-400">Válido hasta: ${budget.terms.validityDays} días</p>
        </div>
      </div>
    </div>

    <!-- Client and work info -->
    <div class="px-8 py-5 bg-slate-50 border-b border-slate-100">
      <div class="grid grid-cols-2 gap-8">
        <div>
          <p class="text-[10px] uppercase font-semibold text-slate-400 tracking-widest mb-2">Datos del cliente</p>
          <p class="text-sm font-semibold text-slate-800">${budget.client.name}</p>
          <p class="text-xs text-slate-500 mt-0.5">${budget.client.address}</p>
          <p class="text-xs text-slate-500">${budget.client.phone}</p>
          <p class="text-xs text-slate-500">${budget.client.email || 'correo@cliente.com'}</p>
        </div>
        <div>
          <p class="text-[10px] uppercase font-semibold text-slate-400 tracking-widest mb-2">Condiciones</p>
          <div class="space-y-1 text-xs text-slate-600">
            <div class="flex justify-between">
              <span class="text-slate-400">Validez de la oferta</span>
              <span class="font-medium text-slate-700">${budget.terms.validityDays} días naturales</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">Anticipo a la firma</span>
              <span class="font-medium text-slate-700">${budget.financials.advancePercentage}% — ${budget.financials.advanceAmount.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-400">Tipo de IVA</span>
              <span class="font-medium text-slate-700">${budget.financials.taxRatePercentage}% — ${budget.financials.taxRatePercentage === 10 ? 'Vivienda habitual' : 'Régimen general'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Line items -->
    <div class="px-8 py-6">
      <table class="w-full text-xs">
        <thead>
          <tr class="border-b border-slate-200">
            <th class="text-left text-[10px] uppercase font-semibold text-slate-400 tracking-widest pb-3 w-full">Descripción</th>
            <th class="text-right text-[10px] uppercase font-semibold text-slate-400 tracking-widest pb-3 whitespace-nowrap pl-6">Cant.</th>
            <th class="text-right text-[10px] uppercase font-semibold text-slate-400 tracking-widest pb-3 whitespace-nowrap pl-6">Precio unit.</th>
            <th class="text-right text-[10px] uppercase font-semibold text-slate-400 tracking-widest pb-3 whitespace-nowrap pl-6">Total</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          ${itemsRows}
        </tbody>
      </table>
    </div>

    <!-- Totals -->
    <div class="px-8 pb-6 flex justify-end">
      <div class="w-64 space-y-2">
        <div class="flex justify-between text-xs">
          <span class="text-slate-400">Base imponible</span>
          <span class="font-medium text-slate-700">${budget.financials.subtotal.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
        </div>
        <div class="flex justify-between text-xs">
          <span class="text-slate-400">IVA (${budget.financials.taxRatePercentage}%)</span>
          <span class="font-medium text-slate-700">${budget.financials.taxAmount.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
        </div>
        <div class="flex justify-between text-sm font-bold text-slate-900 pt-3 border-t border-slate-200">
          <span>Total</span>
          <span style="color: ${budget.company.brandColor || '#1e40af'};">${budget.financials.totalAmount.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
        </div>
      </div>
    </div>

    <!-- Payment terms -->
    <div class="px-8 py-4 bg-slate-50 border-t border-slate-100 text-xs text-slate-500 leading-relaxed">
      <p><span class="font-semibold text-slate-600">Forma de pago:</span> ${budget.terms.conditions}</p>
    </div>

    <!-- Dual signature section -->
    <div class="px-8 py-8 border-t border-slate-200">
      <p class="text-[10px] uppercase font-semibold text-slate-400 tracking-widest mb-6">Aceptación y firma</p>

      <div class="grid grid-cols-2 gap-8">

        <!-- Company signature (pre-stamped) -->
        <div>
          <p class="text-xs font-semibold text-slate-700 mb-1">Por la empresa emisora</p>
          <p class="text-xs text-slate-400 mb-4">${budget.company.name}</p>

          <div class="sig-line flex items-end pb-2 mb-2">
            <div class="border border-dashed border-slate-300 rounded-lg p-3 w-full text-center">
              <p class="text-[9px] uppercase tracking-widest font-bold text-slate-400">Sello y firma digital</p>
              <p class="text-xs font-bold text-slate-700 mt-1">${budget.company.name}</p>
              <p class="text-[10px] text-slate-400">CIF: ${budget.company.cif}</p>
              <div class="mt-1.5 inline-flex items-center gap-1 text-emerald-600">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                <span class="text-[9px] font-bold uppercase tracking-wider">Emitido y sellado</span>
              </div>
            </div>
          </div>

          <p class="text-[10px] text-slate-400">${budget.company.professionalSigner}</p>
          <p class="text-[10px] text-slate-400">${budget.issueDate}</p>
        </div>

        <!-- Client signature (interactive) -->
        <div>
          <div class="flex items-start justify-between mb-1">
            <div>
              <p class="text-xs font-semibold text-slate-700">Por el cliente</p>
              <p class="text-xs text-slate-400 mb-4">${budget.client.name}</p>
            </div>
            <button type="button" onclick="clearPad()" class="text-[10px] text-slate-400 hover:text-slate-600 underline transition-colors no-print cursor-pointer">Borrar</button>
          </div>

          <div class="relative border border-slate-200 rounded-lg overflow-hidden bg-slate-50 mb-2">
            <canvas id="signatureCanvas" height="80" style="width: 100%; height: 80px; display: block;"></canvas>
            <div id="signPlaceholder" class="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p class="text-[11px] text-slate-400 select-none">Firma aquí con el ratón o el dedo</p>
            </div>
          </div>

          <div id="signSuccessBox" class="hidden mb-3 p-2 bg-emerald-50 border border-emerald-200 rounded-lg">
            <div class="flex items-center gap-1.5 text-emerald-700 text-[11px] font-semibold">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
              Contrato aceptado y sellado
            </div>
            <p id="signTimestamp" class="text-[10px] text-emerald-600 mt-0.5"></p>
          </div>

          <button type="button" onclick="confirmSign()" id="signBtn" class="no-print w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-2.5 rounded-lg text-xs transition-colors cursor-pointer">
            Confirmar y firmar presupuesto
          </button>
        </div>

      </div>
    </div>

    <!-- Legal footer -->
    <div class="px-8 py-5 bg-slate-50 border-t border-slate-100">
      <p class="text-[10px] text-slate-400 leading-relaxed">
        Al formalizar la firma, ambas partes aceptan las condiciones de este contrato de arrendamiento de obra conforme al Código Civil español (art. 1.542 y ss.). La firma electrónica tiene plena validez jurídica bajo el Reglamento Europeo eIDAS (Reg. UE 910/2014). Se remitirá copia certificada sellada con hash verificable a <span class="text-slate-500">${budget.company.email}</span> y a <span class="text-slate-500">${budget.client.email || 'correo@cliente.com'}</span>. En cumplimiento del RGPD, los datos del presente documento se tratan exclusivamente con la finalidad de ejecución de este contrato.
      </p>
      <div class="mt-3 flex items-center gap-4 text-[10px] text-slate-400">
        <span>Generado por PresuVoz · presuvoz.app</span>
        <span class="text-slate-300">&middot;</span>
        <span>Ref. firma: <span class="font-mono">${budget.signUrl}</span></span>
      </div>
    </div>

  </div>

  <!-- Spacer -->
  <div class="h-12"></div>

  <script>
    const canvas = document.getElementById('signatureCanvas');
    const placeholder = document.getElementById('signPlaceholder');
    const ctx = canvas.getContext('2d');
    let isDrawing = false;
    let hasDrawn = false;

    function initCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = 80 * dpr;
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1e293b';
    }

    function getPos(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      isDrawing = true;
      hasDrawn = true;
      if (placeholder) placeholder.style.display = 'none';
      ctx.beginPath();
      const p = getPos(e);
      ctx.moveTo(p.x, p.y);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!isDrawing) return;
      e.preventDefault();
      const p = getPos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });

    const stopDraw = (e) => {
      if (!isDrawing) return;
      isDrawing = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch(err) {}
    };
    canvas.addEventListener('pointerup', stopDraw);
    canvas.addEventListener('pointercancel', stopDraw);

    function clearPad() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasDrawn = false;
      placeholder.style.display = 'flex';
      document.getElementById('signSuccessBox').classList.add('hidden');
      const btn = document.getElementById('signBtn');
      btn.textContent = 'Confirmar y firmar presupuesto';
      btn.disabled = false;
      btn.className = 'no-print w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-2.5 rounded-lg text-xs transition-colors cursor-pointer';
      document.getElementById('statusPill').textContent = 'Pendiente de firma';
      document.getElementById('statusPill').className = 'text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg';
    }

    function confirmSign() {
      if (!hasDrawn) {
        alert('Por favor, dibuja tu firma en el recuadro antes de continuar.');
        return;
      }
      const now = new Date();
      const ts = now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
                 ' a las ' + now.toLocaleTimeString('es-ES');

      document.getElementById('signTimestamp').textContent = 'Sellado el ' + ts + ' · IP verificada';
      document.getElementById('signSuccessBox').classList.remove('hidden');

      const btn = document.getElementById('signBtn');
      btn.textContent = 'Firmado';
      btn.disabled = true;
      btn.className = 'no-print w-full bg-slate-200 text-slate-400 font-semibold py-2.5 rounded-lg text-xs cursor-not-allowed';

      const pill = document.getElementById('statusPill');
      pill.textContent = 'Firmado digitalmente';
      pill.className = 'text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg';
    }

    window.addEventListener('load', initCanvas);
    window.addEventListener('resize', initCanvas);
    setTimeout(initCanvas, 150);
  </script>

</body>
</html>`;
  }
}
