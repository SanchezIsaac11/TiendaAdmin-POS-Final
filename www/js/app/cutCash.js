/**
 * MÓDULO: CORTE DE CAJA (cutCash.js)
 * Arqueo de efectivo, desglose por método de pago, apertura y cierre de turno en Supabase
 */

function initCutCash() {
  const btnCerrarTurno = document.getElementById('btnCerrarTurno');
  const btnCutPreview = document.getElementById('btnCutPreview');
  const inputEfectivoContado = document.getElementById('inputEfectivoContado');

  const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const formatShortDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const formatTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())} hrs`;
  const formatLongDate = (d) => `${pad2(d.getDate())} de ${MONTHS_ES[d.getMonth()]} de ${d.getFullYear()}`;

  async function renderCashCut() {
    const terminalInfo = typeof window.getActiveTerminal === 'function' ? window.getActiveTerminal() : { code: 'C1', name: 'Caja 1' };
    const cutCajaName = document.getElementById('cutCajaName');
    if (cutCajaName) cutCajaName.textContent = terminalInfo.name;

    const dateLabel = document.getElementById('cutCurrentDateLabel');
    if (dateLabel) dateLabel.textContent = formatLongDate(new Date());

    let shiftData = null;
    if (window.PosDataService && typeof window.PosDataService.getTerminalShift === 'function') {
      shiftData = await window.PosDataService.getTerminalShift(terminalInfo.code);
    }

    const initialFundLabel = document.getElementById('cutInitialFund');

    if (shiftData && shiftData.is_open && shiftData.shift) {
      const shift = shiftData.shift;
      const start = new Date(shift.opened_at);

      if (initialFundLabel) initialFundLabel.textContent = `$${parseFloat(shift.initial_fund || 1000).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      const live = shiftData.live_totals || {};
      const totalSalesCount = live.total_sales_count || 0;
      const totalSalesAmount = parseFloat(live.total_sales_amount || 0);
      const amountCash = parseFloat(live.cash_sales || 0);
      const amountCard = parseFloat(live.card_sales || 0);
      const amountTransfer = parseFloat(live.transfer_sales || 0);
      const amountMixed = parseFloat(live.mixed_sales || 0);
      const expectedCash = parseFloat(live.expected_cash || (parseFloat(shift.initial_fund || 1000) + amountCash));

      // Resumen de ventas
      const cutTotalSalesHeader = document.getElementById('cutTotalSalesHeader');
      const cutTotalVentasCount = document.getElementById('cutTotalVentasCount');
      if (cutTotalSalesHeader) cutTotalSalesHeader.textContent = `$${totalSalesAmount.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (cutTotalVentasCount) cutTotalVentasCount.textContent = `· ${totalSalesCount} venta${totalSalesCount === 1 ? '' : 's'}`;

      // Por método de pago
      const elAmountCash = document.getElementById('cutAmountCash');
      if (elAmountCash) elAmountCash.textContent = `$${amountCash.toFixed(2)}`;

      const elAmountCard = document.getElementById('cutAmountCard');
      if (elAmountCard) elAmountCard.textContent = `$${amountCard.toFixed(2)}`;

      const elAmountTransfer = document.getElementById('cutAmountTransfer');
      if (elAmountTransfer) elAmountTransfer.textContent = `$${amountTransfer.toFixed(2)}`;

      const elAmountMixed = document.getElementById('cutAmountMixed');
      if (elAmountMixed) elAmountMixed.textContent = `$${amountMixed.toFixed(2)}`;

      // Conteo de operaciones por método
      const elCountCash = document.getElementById('cutCountCash');
      if (elCountCash) elCountCash.textContent = live.cash_sales_count || (amountCash > 0 ? '—' : '0');
      const elCountCard = document.getElementById('cutCountCard');
      if (elCountCard) elCountCard.textContent = live.card_sales_count || (amountCard > 0 ? '—' : '0');
      const elCountTransfer = document.getElementById('cutCountTransfer');
      if (elCountTransfer) elCountTransfer.textContent = live.transfer_sales_count || (amountTransfer > 0 ? '—' : '0');
      const elCountMixed = document.getElementById('cutCountMixed');
      if (elCountMixed) elCountMixed.textContent = live.mixed_sales_count || (amountMixed > 0 ? '—' : '0');

      // Pie de tabla
      const elFootCount = document.getElementById('cutFootTotalCount');
      const elFootAmount = document.getElementById('cutFootTotalAmount');
      if (elFootCount) elFootCount.textContent = totalSalesCount;
      if (elFootAmount) elFootAmount.textContent = `$${totalSalesAmount.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      // Consultar movimientos económicos adicionales del turno actual
      const movSummary = (typeof window.getShiftCashMovementsSummary === 'function')
        ? window.getShiftCashMovementsSummary(start, terminalInfo.code, shift.id)
        : { cashIncomesCount: 0, cashIncomesTotal: 0, cashExpensesCount: 0, cashExpensesTotal: 0, totalIncomesCount: 0, totalIncomesAmount: 0, totalExpensesCount: 0, totalExpensesAmount: 0 };

      // Total de ingresos y egresos del turno (en la tarjeta de Movimientos de caja)
      const inCount = Math.max(live.inflows_count || 0, movSummary.totalIncomesCount || 0);
      const inTotal = Math.max(parseFloat(live.total_inflows || 0), movSummary.totalIncomesAmount || 0);
      const elMoveEntriesAmount = document.getElementById('cutMoveEntriesAmount');
      const elMoveEntriesCount = document.getElementById('cutMoveEntriesCount');
      if (elMoveEntriesCount) elMoveEntriesCount.textContent = inCount;
      if (elMoveEntriesAmount) elMoveEntriesAmount.textContent = `+ $${inTotal.toFixed(2)}`;

      const outCount = Math.max(live.outflows_count || 0, movSummary.totalExpensesCount || 0);
      const outTotal = Math.max(parseFloat(live.total_outflows || 0), movSummary.totalExpensesAmount || 0);
      const elMoveExitsAmount = document.getElementById('cutMoveExitsAmount');
      const elMoveExitsCount = document.getElementById('cutMoveExitsCount');
      if (elMoveExitsCount) elMoveExitsCount.textContent = outCount;
      if (elMoveExitsAmount) elMoveExitsAmount.textContent = `- $${outTotal.toFixed(2)}`;

      // Conteo de efectivo esperado:
      // Fondo inicial + Ventas en efectivo + Ingresos en efectivo - Egresos en efectivo
      // REGLA: Solo los movimientos cuyo método de pago es 'cash' (efectivo) afectan el efectivo esperado.
      const initialFundVal = parseFloat(shift.initial_fund || 1000);
      const cashInflowsVal = Math.max(parseFloat(live.cash_inflows || 0), movSummary.cashIncomesTotal || 0);
      const cashOutflowsVal = Math.max(parseFloat(live.cash_outflows || 0), movSummary.cashExpensesTotal || 0);
      const expectedCashFinal = initialFundVal + amountCash + cashInflowsVal - cashOutflowsVal;

      const elExpectedCash = document.getElementById('cutExpectedCash');
      if (elExpectedCash) elExpectedCash.textContent = `$${expectedCashFinal.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      if (inputEfectivoContado) {
        if (!inputEfectivoContado.value || inputEfectivoContado.value === '1,000.00' || inputEfectivoContado.value === '0.00' || inputEfectivoContado.value === expectedCash.toFixed(2)) {
          inputEfectivoContado.value = expectedCashFinal.toFixed(2);
        }
      }

      if (btnCerrarTurno) {
        btnCerrarTurno.disabled = false;
        btnCerrarTurno.style.opacity = '1';
        btnCerrarTurno.style.cursor = 'pointer';
        const span = btnCerrarTurno.querySelector('span');
        if (span) span.textContent = 'Cerrar turno y generar corte';
      }
    } else {
      const last = (shiftData && shiftData.last_shift) || {};
      if (initialFundLabel) initialFundLabel.textContent = `$${parseFloat(last.initial_fund || 1000).toFixed(2)}`;

      const cutTotalSalesHeader = document.getElementById('cutTotalSalesHeader');
      const cutTotalVentasCount = document.getElementById('cutTotalVentasCount');
      if (cutTotalSalesHeader) cutTotalSalesHeader.textContent = `$${parseFloat(last.total_sales_amount || 0).toFixed(2)}`;
      if (cutTotalVentasCount) cutTotalVentasCount.textContent = `· ${last.total_sales_count || 0} ventas (último corte)`;

      const elExpectedCash = document.getElementById('cutExpectedCash');
      if (elExpectedCash) elExpectedCash.textContent = `$${parseFloat(last.expected_cash || 1000).toFixed(2)}`;

      if (btnCerrarTurno) {
        btnCerrarTurno.disabled = true;
        btnCerrarTurno.style.opacity = '0.5';
        btnCerrarTurno.style.cursor = 'not-allowed';
        const span = btnCerrarTurno.querySelector('span');
        if (span) span.textContent = 'Corte ya realizado';
      }
    }
  }

  window.renderCashCut = renderCashCut;

  // Botón Cerrar Turno
  if (btnCerrarTurno) {
    btnCerrarTurno.addEventListener('click', async () => {
      const terminalInfo = typeof window.getActiveTerminal === 'function' ? window.getActiveTerminal() : { code: 'C1', name: 'Caja 1' };
      const contadoStr = inputEfectivoContado ? inputEfectivoContado.value.replace(/,/g, '').trim() : '0';
      const contadoVal = parseFloat(contadoStr) || 0;

      // Obtener resumen de movimientos en efectivo para el cierre
      const shiftDataCurrent = await window.PosDataService.getTerminalShift(terminalInfo.code);
      const shiftCurrent = (shiftDataCurrent && shiftDataCurrent.shift) || {};
      const startCurrent = shiftCurrent.opened_at ? new Date(shiftCurrent.opened_at) : new Date();
      const movSummaryCurrent = (typeof window.getShiftCashMovementsSummary === 'function')
        ? window.getShiftCashMovementsSummary(startCurrent, terminalInfo.code, shiftCurrent.id)
        : { cashIncomesTotal: 0, cashExpensesTotal: 0 };
      const liveCurrent = (shiftDataCurrent && shiftDataCurrent.live_totals) || {};
      const finalCashInflows = Math.max(parseFloat(liveCurrent.cash_inflows || 0), movSummaryCurrent.cashIncomesTotal || 0);
      const finalCashOutflows = Math.max(parseFloat(liveCurrent.cash_outflows || 0), movSummaryCurrent.cashExpensesTotal || 0);

      btnCerrarTurno.disabled = true;
      const originalText = btnCerrarTurno.querySelector('span')?.textContent;
      if (btnCerrarTurno.querySelector('span')) btnCerrarTurno.querySelector('span').textContent = 'Guardando corte en Supabase...';

      const res = await window.PosDataService.closeTerminalShift(
        terminalInfo.code,
        contadoVal,
        `Cierre de turno realizado desde ${terminalInfo.name}`,
        finalCashInflows,
        finalCashOutflows
      );

      btnCerrarTurno.disabled = false;
      if (btnCerrarTurno.querySelector('span')) btnCerrarTurno.querySelector('span').textContent = originalText;

      if (!res || !res.ok) {
        showModal('Error al cerrar turno', res?.error || 'No se pudo guardar el corte en Supabase.');
        return;
      }

      const closed = res.shift || {};
      const totVentas = parseFloat(closed.total_sales_amount || 0).toFixed(2);
      const totCant = closed.total_sales_count || 0;
      const efecEsp = parseFloat(closed.expected_cash || 0).toFixed(2);
      const efecCont = parseFloat(closed.counted_cash || 0).toFixed(2);
      const efecIn = parseFloat(closed.cash_inflows || 0).toFixed(2);
      const efecOut = parseFloat(closed.cash_outflows || 0).toFixed(2);

      // Notificar cambio de turno y sincronizar pantallas inmediatamente
      if (typeof window.syncAllPosScreens === 'function') {
        await window.syncAllPosScreens();
      } else {
        if (typeof window.checkShiftState === 'function') {
          await window.checkShiftState();
        }
        renderCashCut();
      }

      showModal(
        'Turno Cerrado con Éxito',
        `El corte de ${terminalInfo.name} ha sido guardado PERMANENTEMENTE en el sistema.\n\n` +
        `• Caja: ${terminalInfo.name} (${terminalInfo.code})\n` +
        `• Ventas totales: $${totVentas} (${totCant} ventas)\n` +
        `  - Efectivo: $${parseFloat(closed.cash_sales || 0).toFixed(2)}\n` +
        `  - Tarjeta: $${parseFloat(closed.card_sales || 0).toFixed(2)}\n` +
        `  - Transferencia/QR: $${parseFloat(closed.transfer_sales || 0).toFixed(2)}\n` +
        `  - Mixto: $${parseFloat(closed.mixed_sales || 0).toFixed(2)}\n` +
        `• Ingresos en efectivo: + $${efecIn}\n` +
        `• Egresos en efectivo: - $${efecOut}\n` +
        `• Efectivo esperado: $${efecEsp}\n` +
        `• Efectivo contado: $${efecCont}\n\n` +
        `IMPORTANTE: Las ventas en ${terminalInfo.name} quedan BLOQUEADAS hasta abrir un nuevo turno.`
      );
    });
  }

  // Vista Previa de Corte
  if (btnCutPreview) {
    btnCutPreview.addEventListener('click', async () => {
      const terminalInfo = typeof window.getActiveTerminal === 'function' ? window.getActiveTerminal() : { code: 'C1', name: 'Caja 1' };
      const shiftData = await window.PosDataService.getTerminalShift(terminalInfo.code);
      const now = new Date();

      if (!shiftData || !shiftData.is_open) {
        showModal('Sin Turno Abierto', `La ${terminalInfo.name} no tiene un turno en curso para previsualizar.`);
        return;
      }

      const shift = shiftData.shift || {};
      const live = shiftData.live_totals || {};
      const contadoStr = inputEfectivoContado ? inputEfectivoContado.value : '0.00';

      const movSummary = (typeof window.getShiftCashMovementsSummary === 'function')
        ? window.getShiftCashMovementsSummary(new Date(shift.opened_at), terminalInfo.code, shift.id)
        : { cashIncomesTotal: 0, cashExpensesTotal: 0, totalIncomesAmount: 0, totalExpensesAmount: 0, totalIncomesCount: 0, totalExpensesCount: 0 };

      const initialFundVal = parseFloat(shift.initial_fund || 1000);
      const cashInflowsVal = Math.max(parseFloat(live.cash_inflows || 0), movSummary.cashIncomesTotal || 0);
      const cashOutflowsVal = Math.max(parseFloat(live.cash_outflows || 0), movSummary.cashExpensesTotal || 0);
      const totalInflowsVal = Math.max(parseFloat(live.total_inflows || 0), movSummary.totalIncomesAmount || 0);
      const totalOutflowsVal = Math.max(parseFloat(live.total_outflows || 0), movSummary.totalExpensesAmount || 0);
      const inCount = Math.max(live.inflows_count || 0, movSummary.totalIncomesCount || 0);
      const outCount = Math.max(live.outflows_count || 0, movSummary.totalExpensesCount || 0);

      const cashSalesVal = parseFloat(live.cash_sales || 0);
      const expCash = initialFundVal + cashSalesVal + cashInflowsVal - cashOutflowsVal;

      showModal(
        'Vista Previa: Corte de Caja',
        `========================================\n` +
        `         CORTE DE CAJA - TIENDA\n` +
        `========================================\n` +
        `Caja: ${terminalInfo.name} (${terminalInfo.code})\n` +
        `Fecha: ${formatShortDate(now)} ${formatTime(now)}\n` +
        `----------------------------------------\n` +
        `Fondo inicial:        $${initialFundVal.toFixed(2)}\n` +
        `Ventas Totales (${live.total_sales_count || 0}):   $${parseFloat(live.total_sales_amount || 0).toFixed(2)}\n` +
        `  - Efectivo:         $${cashSalesVal.toFixed(2)}\n` +
        `  - Tarjeta:          $${parseFloat(live.card_sales || 0).toFixed(2)}\n` +
        `  - Transferencia:    $${parseFloat(live.transfer_sales || 0).toFixed(2)}\n` +
        `  - Mixto:            $${parseFloat(live.mixed_sales || 0).toFixed(2)}\n` +
        `----------------------------------------\n` +
        `Ingresos (${inCount}):        + $${totalInflowsVal.toFixed(2)}\n` +
        `Egresos (${outCount}):         - $${totalOutflowsVal.toFixed(2)}\n` +
        `----------------------------------------\n` +
        `Efectivo esperado:    $${expCash.toFixed(2)}\n` +
        `Efectivo contado:     $${contadoStr}\n` +
        `========================================`
      );
    });
  }

  window.renderCashCut = renderCashCut;
}

window.initCutCash = initCutCash;
