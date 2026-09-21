import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { syncPendingSignaturesFromCloud } from './db_service.js';

const DB_PATH = path.resolve('data', 'presuvoz.db');
const PORT = process.env.DB_VIEWER_PORT || 3333;

function getDbData() {
  if (!fs.existsSync(DB_PATH)) {
    return { error: 'No se encontró la base de datos en ' + DB_PATH };
  }

  const db = new DatabaseSync(DB_PATH);

  const companies = db.prepare('SELECT * FROM companies ORDER BY updated_at DESC').all();
  const budgets = db.prepare('SELECT id, company_phone, client_name, client_address, client_phone, total_amount, status, created_at, updated_at, data_json FROM budgets ORDER BY updated_at DESC').all();
  const invoices = db.prepare('SELECT id, budget_id, company_phone, client_name, total_amount, status, created_at, data_json FROM invoices ORDER BY created_at DESC').all();
  const payments = db.prepare('SELECT id, budget_id, company_phone, amount, method, concept, created_at, data_json FROM payments ORDER BY created_at DESC').all();
  const appointments = db.prepare('SELECT id, company_phone, client_name, client_phone, client_address, date, time, notes, status, created_at, updated_at FROM appointments ORDER BY date DESC, time DESC').all();

  return {
    companies,
    budgets: budgets.map(b => {
      let parsed = null;
      try { parsed = JSON.parse(b.data_json); } catch(e) {}
      return { ...b, parsedData: parsed };
    }),
    invoices: invoices.map(i => {
      let parsed = null;
      try { parsed = JSON.parse(i.data_json); } catch(e) {}
      return { ...i, parsedData: parsed };
    }),
    payments: payments.map(p => {
      let parsed = null;
      try { parsed = JSON.parse(p.data_json); } catch(e) {}
      return { ...p, parsedData: parsed };
    }),
    appointments
  };
}

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Visor de Base de Datos — PresuVoz</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap");
    * { font-family: 'Inter', sans-serif; }
    code, pre { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">
  <!-- Cabecera -->
  <header class="bg-slate-800/80 backdrop-blur border-b border-slate-700 sticky top-0 z-20 px-6 py-4 flex flex-wrap items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-xl">🗄️</div>
      <div>
        <h1 class="text-lg font-bold text-white flex items-center gap-2">
          PresuVoz — Base de Datos SQLite
          <span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">En Vivo</span>
        </h1>
        <p class="text-xs text-slate-400 font-mono">data/presuvoz.db</p>
      </div>
    </div>
    <div class="flex items-center gap-3">
      <label class="flex items-center gap-2 text-xs text-slate-300 bg-slate-950/60 px-3 py-2 rounded-lg border border-slate-700 cursor-pointer select-none">
        <input type="checkbox" id="autoRefresh" checked class="rounded border-slate-700 text-emerald-500 focus:ring-0">
        <span>Auto-actualizar (3s)</span>
      </label>
      <button onclick="fetchData()" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center gap-2 transition-all">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>
        Refrescar ahora
      </button>
    </div>
  </header>

  <!-- Pestañas de Navegación -->
  <div class="max-w-7xl mx-auto px-6 pt-6">
    <div class="flex flex-wrap gap-2 border-b border-slate-800 pb-3">
      <button onclick="setTab('budgets')" id="tabBtn-budgets" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-all bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
        📋 Presupuestos (<span id="count-budgets">0</span>)
      </button>
      <button onclick="setTab('invoices')" id="tabBtn-invoices" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-all text-slate-400 hover:text-white hover:bg-slate-800">
        🧾 Facturas (<span id="count-invoices">0</span>)
      </button>
      <button onclick="setTab('payments')" id="tabBtn-payments" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-all text-slate-400 hover:text-white hover:bg-slate-800">
        💰 Cobros y Anticipos (<span id="count-payments">0</span>)
      </button>
      <button onclick="setTab('appointments')" id="tabBtn-appointments" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-all text-slate-400 hover:text-white hover:bg-slate-800">
        📅 Citas y Visitas (<span id="count-appointments">0</span>)
      </button>
      <button onclick="setTab('companies')" id="tabBtn-companies" class="tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-all text-slate-400 hover:text-white hover:bg-slate-800">
        🏢 Empresas (<span id="count-companies">0</span>)
      </button>
    </div>
  </div>

  <!-- Contenido Principal -->
  <main class="max-w-7xl mx-auto px-6 py-6">
    <div id="content" class="space-y-4">
      <div class="text-center py-12 text-slate-500">Cargando datos de SQLite...</div>
    </div>
  </main>

  <script>
    let currentTab = 'budgets';
    let dbData = null;

    function setTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.className = 'tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-all text-slate-400 hover:text-white hover:bg-slate-800';
      });
      const activeBtn = document.getElementById('tabBtn-' + tab);
      if (activeBtn) {
        activeBtn.className = 'tab-btn px-4 py-2 rounded-lg text-sm font-medium transition-all bg-emerald-500/10 text-emerald-400 border border-emerald-500/30';
      }
      render();
    }

    async function fetchData() {
      try {
        const res = await fetch('/api/data');
        dbData = await res.json();
        
        document.getElementById('count-budgets').textContent = dbData.budgets?.length || 0;
        document.getElementById('count-invoices').textContent = dbData.invoices?.length || 0;
        document.getElementById('count-payments').textContent = dbData.payments?.length || 0;
        document.getElementById('count-appointments').textContent = dbData.appointments?.length || 0;
        document.getElementById('count-companies').textContent = dbData.companies?.length || 0;

        render();
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl">Error conectando con el servidor de base de datos: ' + e.message + '</div>';
      }
    }

    function renderBadge(status) {
      if (!status) return '<span class="px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-400 font-mono">-</span>';
      const s = String(status).toUpperCase();
      if (s === 'ACEPTADO' || s === 'PAGADA' || s === 'LIQUIDADO' || s === 'CONFIRMADA') {
        return '<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">🟢 ' + status + '</span>';
      }
      if (s.includes('PENDIENTE')) {
        return '<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">⏳ ' + status + '</span>';
      }
      if (s === 'CANCELADA') {
        return '<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/30">❌ ' + status + '</span>';
      }
      return '<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/30">🔵 ' + status + '</span>';
    }

    function formatEur(n) {
      return Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
    }

    function render() {
      const container = document.getElementById('content');
      if (!dbData) return;

      if (currentTab === 'budgets') {
        const items = dbData.budgets || [];
        if (items.length === 0) {
          container.innerHTML = '<div class="text-center py-12 text-slate-500">No hay presupuestos registrados en la base de datos todavía.</div>';
          return;
        }

        let html = '<div class="overflow-x-auto rounded-xl border border-slate-800"><table class="w-full text-left text-xs">';
        html += '<thead class="bg-slate-950 text-slate-400 font-mono uppercase text-[11px] border-b border-slate-800"><tr>';
        html += '<th class="p-3.5">ID Documento</th><th class="p-3.5">Cliente y Dirección</th><th class="p-3.5">Teléfono Instalador</th><th class="p-3.5">Importe Total</th><th class="p-3.5">Estado</th><th class="p-3.5">Partidas</th><th class="p-3.5">Última Actualización</th>';
        html += '</tr></thead><tbody class="divide-y divide-slate-800 bg-slate-900/60">';

        items.forEach(b => {
          const partCount = b.parsedData?.items?.length || 0;
          const paid = b.parsedData?.paymentSummary?.totalPaid || 0;
          const remaining = b.parsedData?.paymentSummary?.remainingBalance !== undefined ? b.parsedData.paymentSummary.remainingBalance : b.total_amount;
          
          html += '<tr class="hover:bg-slate-800/50 transition-colors">';
          html += '<td class="p-3.5 font-bold font-mono text-emerald-400">' + b.id + '</td>';
          html += '<td class="p-3.5"><div class="font-semibold text-white">' + (b.client_name || 'Cliente') + '</div><div class="text-slate-400 text-[11px]">' + (b.client_address || '-') + '</div></td>';
          html += '<td class="p-3.5 font-mono text-slate-300">' + b.company_phone + '</td>';
          html += '<td class="p-3.5"><div class="font-bold text-white text-sm">' + formatEur(b.total_amount) + '</div>' + (paid > 0 ? '<div class="text-[11px] text-emerald-400">Cobrado: ' + formatEur(paid) + '</div><div class="text-[11px] text-amber-400">Restante: ' + formatEur(remaining) + '</div>' : '') + '</td>';
          html += '<td class="p-3.5">' + renderBadge(b.status) + '</td>';
          html += '<td class="p-3.5"><span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[11px]">' + partCount + ' partidas</span></td>';
          html += '<td class="p-3.5 font-mono text-slate-400 text-[11px]">' + (b.updated_at ? new Date(b.updated_at).toLocaleString('es-ES') : '-') + '</td>';
          html += '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
      }

      else if (currentTab === 'invoices') {
        const items = dbData.invoices || [];
        if (items.length === 0) {
          container.innerHTML = '<div class="text-center py-12 text-slate-500">No hay facturas emitidas todavía en SQLite.</div>';
          return;
        }

        let html = '<div class="overflow-x-auto rounded-xl border border-slate-800"><table class="w-full text-left text-xs">';
        html += '<thead class="bg-slate-950 text-slate-400 font-mono uppercase text-[11px] border-b border-slate-800"><tr>';
        html += '<th class="p-3.5">Nº Factura</th><th class="p-3.5">Presupuesto Origen</th><th class="p-3.5">Cliente</th><th class="p-3.5">Importe Total</th><th class="p-3.5">Estado</th><th class="p-3.5">Fecha Emisión</th>';
        html += '</tr></thead><tbody class="divide-y divide-slate-800 bg-slate-900/60">';

        items.forEach(inv => {
          html += '<tr class="hover:bg-slate-800/50 transition-colors">';
          html += '<td class="p-3.5 font-bold font-mono text-blue-400 text-sm">' + inv.id + '</td>';
          html += '<td class="p-3.5 font-mono text-slate-400">' + (inv.budget_id || '-') + '</td>';
          html += '<td class="p-3.5 font-semibold text-white">' + (inv.client_name || 'Cliente') + '</td>';
          html += '<td class="p-3.5 font-bold text-white text-sm">' + formatEur(inv.total_amount) + '</td>';
          html += '<td class="p-3.5">' + renderBadge(inv.status) + '</td>';
          html += '<td class="p-3.5 font-mono text-slate-400 text-[11px]">' + (inv.created_at ? new Date(inv.created_at).toLocaleString('es-ES') : '-') + '</td>';
          html += '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
      }

      else if (currentTab === 'payments') {
        const items = dbData.payments || [];
        if (items.length === 0) {
          container.innerHTML = '<div class="text-center py-12 text-slate-500">No hay cobros ni anticipos registrados todavía.</div>';
          return;
        }

        let html = '<div class="overflow-x-auto rounded-xl border border-slate-800"><table class="w-full text-left text-xs">';
        html += '<thead class="bg-slate-950 text-slate-400 font-mono uppercase text-[11px] border-b border-slate-800"><tr>';
        html += '<th class="p-3.5">Ref. Recibo</th><th class="p-3.5">Obra / Presupuesto</th><th class="p-3.5">Importe Cobrado</th><th class="p-3.5">Método de Pago</th><th class="p-3.5">Concepto</th><th class="p-3.5">Fecha Cobro</th>';
        html += '</tr></thead><tbody class="divide-y divide-slate-800 bg-slate-900/60">';

        items.forEach(p => {
          html += '<tr class="hover:bg-slate-800/50 transition-colors">';
          html += '<td class="p-3.5 font-bold font-mono text-emerald-400">' + p.id + '</td>';
          html += '<td class="p-3.5 font-mono text-slate-400">' + (p.budget_id || '-') + '</td>';
          html += '<td class="p-3.5 font-bold text-emerald-400 text-sm">+' + formatEur(p.amount) + '</td>';
          html += '<td class="p-3.5"><span class="px-2 py-0.5 rounded bg-slate-800 font-medium text-slate-200 border border-slate-700">' + (p.method || 'Bizum') + '</span></td>';
          html += '<td class="p-3.5 text-slate-300">' + (p.concept || 'Entrega a cuenta') + '</td>';
          html += '<td class="p-3.5 font-mono text-slate-400 text-[11px]">' + (p.created_at ? new Date(p.created_at).toLocaleString('es-ES') : '-') + '</td>';
          html += '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
      }

      else if (currentTab === 'appointments') {
        const items = dbData.appointments || [];
        if (items.length === 0) {
          container.innerHTML = '<div class="text-center py-12 text-slate-500">No hay citas ni visitas técnicas programadas.</div>';
          return;
        }

        let html = '<div class="overflow-x-auto rounded-xl border border-slate-800"><table class="w-full text-left text-xs">';
        html += '<thead class="bg-slate-950 text-slate-400 font-mono uppercase text-[11px] border-b border-slate-800"><tr>';
        html += '<th class="p-3.5">ID Cita</th><th class="p-3.5">Fecha y Hora</th><th class="p-3.5">Cliente</th><th class="p-3.5">Dirección / Visita</th><th class="p-3.5">Motivo / Trabajos</th><th class="p-3.5">Estado</th>';
        html += '</tr></thead><tbody class="divide-y divide-slate-800 bg-slate-900/60">';

        items.forEach(a => {
          html += '<tr class="hover:bg-slate-800/50 transition-colors">';
          html += '<td class="p-3.5 font-bold font-mono text-cyan-400">' + a.id + '</td>';
          html += '<td class="p-3.5 font-mono font-bold text-white">' + a.date + ' ' + a.time + ' h</td>';
          html += '<td class="p-3.5 font-semibold text-white">' + a.client_name + (a.client_phone ? '<div class="text-[11px] text-slate-400 font-mono">📞 ' + a.client_phone + '</div>' : '') + '</td>';
          html += '<td class="p-3.5 text-slate-300">' + (a.client_address || 'Por concretar') + '</td>';
          html += '<td class="p-3.5 text-slate-300">' + (a.notes || '-') + '</td>';
          html += '<td class="p-3.5">' + renderBadge(a.status) + '</td>';
          html += '</tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;
      }

      else if (currentTab === 'companies') {
        const items = dbData.companies || [];
        if (items.length === 0) {
          container.innerHTML = '<div class="text-center py-12 text-slate-500">No hay fichas de empresa configuradas.</div>';
          return;
        }

        let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">';
        items.forEach(c => {
          const tradeBadge = c.trade ? '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30">🛠️ ' + c.trade + '</span>' : '';
          html += '<div class="flex items-start justify-between"><div><h3 class="font-bold text-white text-base">' + (c.name || 'Empresa') + '</h3><div class="mt-1">' + tradeBadge + '</div></div><span class="font-mono text-xs px-2 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-700">CIF: ' + (c.cif || '-') + '</span></div>';
          html += '<div class="text-xs space-y-1 text-slate-300">';
          html += '<div>📱 <b>Teléfono bot:</b> <span class="font-mono">' + c.phone + '</span></div>';
          html += '<div>🛠️ <b>Especialidad:</b> <span class="text-emerald-400 font-semibold">' + (c.trade || 'Reformas y Construcción') + '</span></div>';
          html += '<div>📍 <b>Dirección:</b> ' + (c.address || '-') + '</div>';
          html += '<div>🏦 <b>IBAN:</b> <span class="font-mono">' + (c.iban || '-') + '</span></div>';
          html += '<div>📲 <b>Bizum:</b> <span class="font-mono">' + (c.bizum || '-') + '</span></div>';
          html += '<div>📧 <b>Email:</b> ' + (c.email || '-') + '</div>';
          html += '<div>📊 <b>Gestoría:</b> ' + (c.gestoria_email ? '<span class="text-emerald-400 font-mono">' + c.gestoria_email + '</span>' : '<span class="text-slate-500">No configurado</span>') + '</div>';
          html += '</div>';
          html += '<div class="pt-2 border-t border-slate-700/60 text-[11px] font-mono text-slate-500">Registrado: ' + (c.created_at ? new Date(c.created_at).toLocaleString('es-ES') : '-') + '</div>';
          html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
      }
    }

    // Polling automático cada 3 segundos
    setInterval(() => {
      if (document.getElementById('autoRefresh').checked) {
        fetchData();
      }
    }, 3000);

    fetchData();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/data') {
    try {
      await syncPendingSignaturesFromCloud();
      const data = getDbData();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML_TEMPLATE);
});

server.listen(PORT, () => {
  console.log('\n======================================================');
  console.log('🗄️  Visor de Base de Datos SQLite PresuVoz Activo');
  console.log(`🌐  Abre en tu navegador: http://localhost:${PORT}`);
  console.log('⚡  Auto-actualización en vivo activa (verás entrar datos en tiempo real)');
  console.log('======================================================\n');
});
