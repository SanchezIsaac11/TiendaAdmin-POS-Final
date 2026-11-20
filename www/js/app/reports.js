/**
 * MÓDULO: REPORTES DE CORTES HISTÓRICOS (reports.js)
 * Consulta de cortes de caja de varios días desde Supabase con filtros por fecha y caja.
 */

function initReports() {
  const repFilterStartDate = document.getElementById('repFilterStartDate');
  const repFilterEndDate = document.getElementById('repFilterEndDate');
  const repFilterTerminal = document.getElementById('repFilterTerminal');
  const btnExportReportsExcel = document.getElementById('btnExportReportsExcel');
  const reportsTableBody = document.getElementById('reportsTableBody');
  const reportsEmptyState = document.getElementById('reportsEmptyState');
  const reportsTableWrapper = document.getElementById('reportsTableWrapper');
  const presetBtns = document.querySelectorAll('.btn-rep-preset');
  let lastLoadedCuts = [];

  // Inicializar fechas por defecto (últimos 7 días)
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const formatIsoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (repFilterEndDate && !repFilterEndDate.value) {
    repFilterEndDate.value = formatIsoDate(today);
  }
  if (repFilterStartDate && !repFilterStartDate.value) {
    repFilterStartDate.value = formatIsoDate(sevenDaysAgo);
  }

  function setActivePreset(activeBtn) {
    presetBtns.forEach(b => b.classList.toggle('active', b === activeBtn));
  }

  // Presets rápidos (1 clic)
  const btnPresetToday = document.getElementById('btnPresetToday');
  const btnPreset7Days = document.getElementById('btnPreset7Days');
  const btnPresetMonth = document.getElementById('btnPresetMonth');

  if (btnPresetToday) {
    btnPresetToday.addEventListener('click', () => {
      if (repFilterStartDate) repFilterStartDate.value = formatIsoDate(today);
      if (repFilterEndDate) repFilterEndDate.value = formatIsoDate(today);
      setActivePreset(btnPresetToday);
      loadReportsData();
    });
  }

  if (btnPreset7Days) {
    btnPreset7Days.addEventListener('click', () => {
      if (repFilterStartDate) repFilterStartDate.value = formatIsoDate(sevenDaysAgo);
      if (repFilterEndDate) repFilterEndDate.value = formatIsoDate(today);
      setActivePreset(btnPreset7Days);
      loadReportsData();
    });
  }

  if (btnPresetMonth) {
    btnPresetMonth.addEventListener('click', () => {
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      if (repFilterStartDate) repFilterStartDate.value = formatIsoDate(firstDay);
      if (repFilterEndDate) repFilterEndDate.value = formatIsoDate(today);
      setActivePreset(btnPresetMonth);
      loadReportsData();
    });
  }

  // Recargar automáticamente al cambiar cualquier filtro (sin botón extra)
  [repFilterStartDate, repFilterEndDate, repFilterTerminal].forEach(el => {
    if (el) {
      el.addEventListener('change', () => {
        if (el !== repFilterTerminal) setActivePreset(null);
        loadReportsData();
      });
    }
  });

  if (btnExportReportsExcel) {
    btnExportReportsExcel.addEventListener('click', () => {
      if (!lastLoadedCuts || lastLoadedCuts.length === 0) {
        showModal('Sin Datos', 'No hay cortes en el periodo seleccionado para exportar.');
        return;
      }
      const headers = ['Caja', 'Cajero', 'Apertura', 'Cierre', 'Ventas', 'Total Vendido', 'Efectivo', 'Tarjeta', 'Transferencia', 'Efectivo Contado', 'Estado'];
      const rows = lastLoadedCuts.map(c => [
        c.terminal_name || c.terminal_code || 'Caja 1',
        c.cashier_name || 'Cajero',
        c.opened_at ? new Date(c.opened_at).toLocaleString('es-MX') : '',
        c.closed_at ? new Date(c.closed_at).toLocaleString('es-MX') : 'Abierto',
        Number(c.total_sales_count) || 0,
        { value: parseFloat(c.total_sales_amount) || 0, currency: true },
        { value: parseFloat(c.cash_sales) || 0, currency: true },
        { value: parseFloat(c.card_sales) || 0, currency: true },
        { value: parseFloat(c.transfer_sales || c.qr_sales) || 0, currency: true },
        { value: parseFloat(c.counted_cash) || 0, currency: true },
        c.status === 'open' ? 'Abierto' : 'Cerrado'
      ]);
      if (typeof window.exportToExcel === 'function') {
        const s = repFilterStartDate?.value || 'reporte';
        const e = repFilterEndDate?.value || '';
        window.exportToExcel({
          filename: `reporte_caja_${s}${e ? '_a_' + e : ''}`,
          sheetName: 'Reportes de Caja',
          headers,
          rows
        });
      }
    });
  }

  async function loadReportsData() {
    const startDate = repFilterStartDate ? repFilterStartDate.value : null;
    const endDate = repFilterEndDate ? repFilterEndDate.value : null;
    const terminal = repFilterTerminal ? repFilterTerminal.value : 'all';

    const res = await window.PosDataService.fetchReports(startDate, endDate, terminal);

    if (!res || !res.ok) {
      lastLoadedCuts = [];
      if (reportsEmptyState) {
        reportsEmptyState.style.display = 'block';
        reportsEmptyState.innerHTML = `
          <div style="padding: 40px 20px; text-align: center; color: #ef4444;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 48px; height: 48px; margin-bottom: 12px;">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <div style="font-weight: 600; font-size: 15px;">Error al consultar reportes</div>
            <div style="font-size: 13px; color: #64748b; margin-top: 4px;">${res?.error || 'Revisa la conexión con Supabase.'}</div>
          </div>
        `;
      }
      if (reportsTableWrapper) reportsTableWrapper.style.display = 'none';
      return;
    }

    const { cuts, totals } = res;
    lastLoadedCuts = cuts || [];

    // Actualizar KPI Cards esenciales (4 tarjetas claras)
    const kpiRepTotalSales = document.getElementById('kpiRepTotalSales');
    const kpiRepTicketsCount = document.getElementById('kpiRepTicketsCount');
    const kpiRepCashSales = document.getElementById('kpiRepCashSales');
    const kpiRepElectronicSales = document.getElementById('kpiRepElectronicSales');
    const kpiRepCutsCount = document.getElementById('kpiRepCutsCount');
    const kpiRepCountedCash = document.getElementById('kpiRepCountedCash');

    if (kpiRepTotalSales) kpiRepTotalSales.textContent = `$${totals.totalSalesAmount.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (kpiRepTicketsCount) kpiRepTicketsCount.textContent = `${totals.totalSalesCount} ventas`;
    if (kpiRepCashSales) kpiRepCashSales.textContent = `$${totals.totalCashSales.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const electronicTotal = (totals.totalCardSales || 0) + (totals.totalTransferSales || 0) + (totals.totalMixedSales || 0);
    if (kpiRepElectronicSales) kpiRepElectronicSales.textContent = `$${electronicTotal.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (kpiRepCutsCount) kpiRepCutsCount.textContent = `${totals.cutsCount} corte${totals.cutsCount === 1 ? '' : 's'}`;
    if (kpiRepCountedCash) kpiRepCountedCash.textContent = `$${totals.totalCountedCash.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // Renderizar tabla limpia (6 columnas)
    if (!cuts || cuts.length === 0) {
      if (reportsEmptyState) {
        reportsEmptyState.style.display = 'block';
        reportsEmptyState.innerHTML = `
          <div style="padding: 40px 20px; text-align: center; color: #94a3b8;">
            <div style="font-weight: 600; color: #64748b; font-size: 15px;">No hay cortes en estas fechas</div>
            <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">Prueba seleccionando "Hoy", "7 días" o "Este mes".</div>
          </div>
        `;
      }
      if (reportsTableWrapper) reportsTableWrapper.style.display = 'none';
      if (reportsTableBody) reportsTableBody.innerHTML = '';
      return;
    }

    if (reportsEmptyState) reportsEmptyState.style.display = 'none';
    if (reportsTableWrapper) reportsTableWrapper.style.display = 'block';
    if (!reportsTableBody) return;

    reportsTableBody.innerHTML = cuts.map(c => {
      const openDate = c.opened_at ? new Date(c.opened_at) : null;
      const closeDate = c.closed_at ? new Date(c.closed_at) : null;

      const formatDt = (d) => {
        if (!d || isNaN(d.getTime())) return '--:--';
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}h`;
      };

      const terminalBadgeClass = c.terminal_code === 'C2' ? 'badge-caja-c2' : 'badge-caja-c1';
      const statusBadge = c.status === 'open'
        ? `<span style="background:#ecfdf5; color:#065f46; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700;">Abierto</span>`
        : `<span style="background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:700;">Cerrado</span>`;

      const totAmount = parseFloat(c.total_sales_amount || 0).toFixed(2);
      const counted = parseFloat(c.counted_cash || 0).toFixed(2);
      const cash = parseFloat(c.cash_sales || 0).toFixed(2);

      return `
        <tr class="report-cut-row" data-cut-id="${c.id}">
          <td style="font-size: 12.5px; color: #334155;">
            <div style="font-weight: 600;">${formatDt(openDate)}</div>
            <div style="font-size: 11px; color: #64748b;">Cierre: ${closeDate ? formatDt(closeDate) : 'Abierto'}</div>
          </td>
          <td>
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="pill-caja ${terminalBadgeClass}" style="font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 6px;">
                ${c.terminal_name || c.terminal_code}
              </span>
              <span style="font-size: 12.5px; font-weight: 600; color: #334155;">${c.cashier_name || 'Cajero'}</span>
            </div>
          </td>
          <td style="text-align: center; font-weight: 600;">${c.total_sales_count || 0}</td>
          <td style="text-align: right;">
            <div style="font-weight: 700; color: #0f172a; font-size: 14px;">$${totAmount}</div>
            <div style="font-size: 11px; color: #64748b;">Efectivo: $${cash}</div>
          </td>
          <td style="text-align: right; font-weight: 700; color: #0f172a;">$${counted}</td>
          <td style="text-align: center; white-space: nowrap;">
            ${statusBadge}
            <button type="button" class="btn-rep-detail" onclick="window.viewCutDetail(${c.id})" style="background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer; margin-left:6px; font-weight:600;">
              Ver
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  window.loadReportsData = loadReportsData;

  // Modal para ver detalle completo de un corte específico
  window.viewCutDetail = async function(cutId) {
    const client = window.PosDataService.getClient();
    if (!client) return;

    try {
      const { data: cut, error } = await client.from('cash_cuts').select('*').eq('id', cutId).single();
      if (error || !cut) {
        showModal('Error', 'No se pudo obtener el detalle del corte.');
        return;
      }

      const openStr = cut.opened_at ? new Date(cut.opened_at).toLocaleString('es-MX') : '-';
      const closeStr = cut.closed_at ? new Date(cut.closed_at).toLocaleString('es-MX') : 'Turno en curso';

      showModal(
        `Detalle de Corte #Corte-${cut.id}`,
        `========================================\n` +
        `           TIENDA ABARROTES NEXUS\n` +
        `         DETALLE DE CORTE HISTÓRICO\n` +
        `========================================\n` +
        `Caja: ${cut.terminal_name} (${cut.terminal_code})\n` +
        `Cajero: ${cut.cashier_name}\n` +
        `Estado: ${cut.status.toUpperCase()}\n` +
        `Apertura: ${openStr}\n` +
        `Cierre:   ${closeStr}\n` +
        `----------------------------------------\n` +
        `Fondo Inicial:          $${parseFloat(cut.initial_fund || 0).toFixed(2)}\n` +
        `Ventas Totales (${cut.total_sales_count}):     $${parseFloat(cut.total_sales_amount || 0).toFixed(2)}\n` +
        `  - Efectivo:           $${parseFloat(cut.cash_sales || 0).toFixed(2)}\n` +
        `  - Tarjeta:            $${parseFloat(cut.card_sales || 0).toFixed(2)}\n` +
        `  - Transferencia/QR:   $${parseFloat(cut.transfer_sales || cut.qr_sales || 0).toFixed(2)}\n` +
        `  - Pagos Mixtos:       $${parseFloat(cut.mixed_sales || 0).toFixed(2)}\n` +
        `----------------------------------------\n` +
        `Entradas extraordinarias: +$${parseFloat(cut.cash_inflows || 0).toFixed(2)}\n` +
        `Salidas extraordinarias:  -$${parseFloat(cut.cash_outflows || 0).toFixed(2)}\n` +
        `Pagos a proveedores:      -$${parseFloat(cut.supplier_payouts || 0).toFixed(2)}\n` +
        `----------------------------------------\n` +
        `Efectivo Esperado:      $${parseFloat(cut.expected_cash || 0).toFixed(2)}\n` +
        `Efectivo Contado:       $${parseFloat(cut.counted_cash || 0).toFixed(2)}\n` +
        `Diferencia:             $${parseFloat(cut.difference || 0).toFixed(2)}\n` +
        `Notas: ${cut.notes || 'Sin notas registradas'}\n` +
        `========================================`
      );
    } catch (e) {
      console.warn('Error mostrando detalle corte:', e);
    }
  };
}

window.initReports = initReports;
