/**
 * ==============================================================================
 * SUBMÓDULO POS: MÉTODOS DE PAGO, COBRO Y COMPROBANTE DE VENTA (posPayments.js)
 * ==============================================================================
 * - Soporta Efectivo, Tarjeta, Transferencia y Pago Mixto.
 * - Validación y cálculo de cambio en tiempo real.
 * - Procesa cobro de forma atómica y confiable.
 * - Pantalla de éxito con ANIMACIÓN DE PALOMITA VERDE y ÚNICO BOTÓN DE IMPRIMIR TICKET.
 * ==============================================================================
 */

function initPosPayments() {
  const cashCalculator = document.getElementById('cashCalculator');
  const mixedCalculator = document.getElementById('mixedCalculator');
  const cashReceivedInput = document.getElementById('cashReceivedInput');
  const changeAmount = document.getElementById('changeAmount');
  const btnCheckout = document.getElementById('btnCheckout');

  function updateCashChange() {
    if (!cashReceivedInput || !changeAmount) return;
    const totals = typeof calculateTotals === 'function' ? calculateTotals() : { totalNet: 0 };
    const received = parseFloat(cashReceivedInput.value) || 0;
    const change = Math.max(0, received - totals.totalNet);
    changeAmount.textContent = `$${change.toFixed(2)}`;
  }

  const paymentButtons = document.querySelectorAll('.payment-btn');
  paymentButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      paymentButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedPaymentMethod = btn.dataset.method;

      if (state.selectedPaymentMethod === 'cash') {
        if (cashCalculator) cashCalculator.style.display = 'block';
        if (mixedCalculator) mixedCalculator.style.display = 'none';
      } else if (state.selectedPaymentMethod === 'mixed') {
        if (cashCalculator) cashCalculator.style.display = 'none';
        if (mixedCalculator) {
          mixedCalculator.style.display = 'block';
          const totals = typeof calculateTotals === 'function' ? calculateTotals() : { totalNet: 0 };
          const mixedCash = document.getElementById('mixedCashInput');
          const mixedCard = document.getElementById('mixedCardInput');
          const mixedTransfer = document.getElementById('mixedTransferInput');
          if (mixedCash && (!mixedCash.value || parseFloat(mixedCash.value) === 0)) {
            mixedCash.value = (totals.totalNet / 2).toFixed(2);
          }
          if (mixedCard && (!mixedCard.value || parseFloat(mixedCard.value) === 0)) {
            mixedCard.value = (totals.totalNet - (parseFloat(mixedCash?.value) || 0)).toFixed(2);
          }
          if (mixedTransfer && !mixedTransfer.value) mixedTransfer.value = '0.00';
          updateMixedTotalCheck();
        }
      } else {
        if (cashCalculator) cashCalculator.style.display = 'none';
        if (mixedCalculator) mixedCalculator.style.display = 'none';
      }
    });
  });

  // Cálculo para pagos mixtos
  function updateMixedTotalCheck() {
    const totals = typeof calculateTotals === 'function' ? calculateTotals() : { totalNet: 0 };
    const mixedCash = parseFloat(document.getElementById('mixedCashInput')?.value || 0);
    const mixedCard = parseFloat(document.getElementById('mixedCardInput')?.value || 0);
    const mixedTransfer = parseFloat(document.getElementById('mixedTransferInput')?.value || 0);
    const sum = mixedCash + mixedCard + mixedTransfer;
    const diff = totals.totalNet - sum;

    const mixedStatus = document.getElementById('mixedStatusMsg');
    if (mixedStatus) {
      if (Math.abs(diff) < 0.01) {
        mixedStatus.textContent = `✓ Montos coinciden exactamente ($${sum.toFixed(2)})`;
        mixedStatus.style.color = '#10b981';
      } else if (diff > 0) {
        mixedStatus.textContent = `Faltan $${diff.toFixed(2)} por cubrir (Total: $${totals.totalNet.toFixed(2)})`;
        mixedStatus.style.color = '#ef4444';
      } else {
        mixedStatus.textContent = `Excedente de $${Math.abs(diff).toFixed(2)} (Total: $${totals.totalNet.toFixed(2)})`;
        mixedStatus.style.color = '#f59e0b';
      }
    }
  }

  const mixedInputs = ['mixedCashInput', 'mixedCardInput', 'mixedTransferInput'];
  mixedInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateMixedTotalCheck);
  });

  if (cashReceivedInput) {
    cashReceivedInput.addEventListener('input', updateCashChange);
  }

  // Asegurar que la calculadora compacta de efectivo se muestre si Efectivo está activo al iniciar
  if (cashCalculator && (!state.selectedPaymentMethod || state.selectedPaymentMethod === 'cash')) {
    cashCalculator.style.display = 'block';
  }

  // ---------------------------------------------------------------------------
  // EJECUCIÓN SEGURA Y FLUIDA DE COBRO
  // ---------------------------------------------------------------------------
  let isCheckoutInProgress = false;

  async function triggerCheckout() {
    if (isCheckoutInProgress) return;

    const totals = typeof calculateTotals === 'function' ? calculateTotals() : { totalPieces: 0, totalNet: 0 };
    if (!state.cart || state.cart.length === 0 || totals.totalPieces === 0) {
      showModal('Cuenta Vacía', 'Agrega productos a la cuenta antes de cobrar.');
      return;
    }

    const terminalInfo = (typeof window !== 'undefined' && typeof window.getActiveTerminal === 'function')
      ? window.getActiveTerminal()
      : { code: 'C1', name: 'Caja 1' };
    const cashierUser = window.currentSessionUser || (typeof safeGetStorage === 'function' ? JSON.parse(safeGetStorage('pos_current_session_user') || 'null') : null);
    const cashierName = cashierUser ? (cashierUser.name || cashierUser.fullName || 'Cajero') : 'Cajero';
    const cashierRole = cashierUser ? (cashierUser.role || '') : '';

    // Métodos de pago
    let cashAmount = 0;
    let cardAmount = 0;
    let transferAmount = 0;
    let cashReceived = null;
    let cashChange = null;

    if (state.selectedPaymentMethod === 'cash') {
      cashAmount = totals.totalNet;
      const rawReceived = cashReceivedInput ? parseFloat(cashReceivedInput.value) : NaN;
      cashReceived = (!isNaN(rawReceived) && rawReceived > 0) ? rawReceived : totals.totalNet;
      cashChange = Math.max(0, cashReceived - totals.totalNet);
      if (cashReceived < totals.totalNet) {
        showModal('Efectivo Insuficiente', `El efectivo ingresado ($${cashReceived.toFixed(2)}) es menor al total ($${totals.totalNet.toFixed(2)}).`);
        return;
      }
    } else if (state.selectedPaymentMethod === 'card') {
      cardAmount = totals.totalNet;
    } else if (state.selectedPaymentMethod === 'transfer') {
      transferAmount = totals.totalNet;
    } else if (state.selectedPaymentMethod === 'mixed') {
      const mixedCash = parseFloat(document.getElementById('mixedCashInput')?.value || 0);
      const mixedCard = parseFloat(document.getElementById('mixedCardInput')?.value || 0);
      const mixedTransfer = parseFloat(document.getElementById('mixedTransferInput')?.value || 0);
      const sum = mixedCash + mixedCard + mixedTransfer;

      if (Math.abs(sum - totals.totalNet) > 0.05) {
        showModal('Pago Mixto Incompleto', `La suma de los métodos ($${sum.toFixed(2)}) debe coincidir con el total neto ($${totals.totalNet.toFixed(2)}).`);
        return;
      }
      cashAmount = mixedCash;
      cardAmount = mixedCard;
      transferAmount = mixedTransfer;
    }

    // Generar folio único
    const nextFolioStr = (typeof window.generateUniqueFolio === 'function')
      ? window.generateUniqueFolio(terminalInfo.code)
      : `#TK-${terminalInfo.code}-${Date.now()}`;
    state.folio = nextFolioStr;

    const salePayload = {
      folio: nextFolioStr,
      terminal_code: terminalInfo.code,
      terminal_name: terminalInfo.name,
      cashier_name: cashierName,
      total_items: totals.totalProducts,
      total_pieces: totals.totalPieces,
      subtotal: totals.subtotalAccumulated,
      discount: totals.totalDiscount,
      total_net: totals.totalNet,
      payment_method: state.selectedPaymentMethod,
      cash_received: cashReceived,
      cash_change: cashChange,
      cash_amount: cashAmount,
      card_amount: cardAmount,
      transfer_amount: transferAmount,
      created_at: new Date().toISOString()
    };

    isCheckoutInProgress = true;
    const checkoutText = document.getElementById('checkoutBtnLabel');
    if (checkoutText) checkoutText.textContent = 'Cobrando...';
    if (btnCheckout) btnCheckout.disabled = true;

    // Registrar venta (Master SQLite local primero, con fallback automático)
    let res = null;
    try {
      res = await window.PosDataService.registerSale(salePayload, state.cart);
    } catch (checkoutErr) {
      console.error('[COBRO ERROR]:', checkoutErr);
      res = {
        success: false,
        error: 'Error inesperado durante el cobro: ' + (checkoutErr.message || checkoutErr),
        errorCode: 'CHECKOUT_EXCEPTION'
      };
    }

    isCheckoutInProgress = false;
    if (btnCheckout) btnCheckout.disabled = false;

    // VALIDACIÓN ESTRICTA DE ERRORES: Si falló el guardado, NUNCA continuar a Venta Exitosa
    if (!res || res.success === false) {
      if (checkoutText) checkoutText.textContent = `Cobrar $${totals.totalNet.toFixed(2)}`;

      const errCode = res?.errorCode || 'SALE_ERROR';
      const errMsg = res?.error || 'Ocurrió un error desconocido al registrar la venta.';

      if (errCode === 'INSUFFICIENT_STOCK') {
        showModal('Inventario Insuficiente', `${errMsg}\n\nSe ha actualizado el inventario.`);
        if (typeof window.refreshInventoryFromSupabase === 'function') window.refreshInventoryFromSupabase();
      } else if (errCode === 'SHIFT_CLOSED' || errCode === 'NO_ACTIVE_SHIFT') {
        showModal('Turno Cerrado', `${errMsg}\n\nPor favor abre un turno antes de cobrar.`);
      } else if (errCode === 'DUPLICATE_FOLIO') {
        showModal('Folio Duplicado', `${errMsg}\n\nGenerando un nuevo folio para reintentar.`);
        state.folio = (typeof window.generateUniqueFolio === 'function')
          ? window.generateUniqueFolio(terminalInfo.code)
          : `#TK-${terminalInfo.code}-${Date.now()}`;
      } else if (errCode === 'PRICE_CHANGED') {
        showModal('Cambio de Precio', `${errMsg}\n\nLos precios del catálogo han cambiado.`);
        if (typeof window.refreshInventoryFromSupabase === 'function') window.refreshInventoryFromSupabase();
      } else if (errCode === 'INSUFFICIENT_PAYMENT') {
        showModal('Pago Insuficiente', `${errMsg}`);
      } else if (errCode === 'INVALID_INPUT') {
        showModal('Datos Inválidos', `${errMsg}`);
      } else if (errCode === 'STORAGE_FAILED') {
        showModal('Error de Almacenamiento', `No se pudo registrar la venta ni guardarla localmente:\n\n${errMsg}`);
      } else {
        showModal('Error al Registrar Venta', `No se pudo procesar la venta.\n\nDetalle: ${errMsg}`);
      }
      return;
    }

    if (checkoutText) checkoutText.textContent = `Cobrar $0.00`;

    // VENTA EXITOSA
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())} hrs`;
    const cartSnapshot = state.cart.map(c => ({
      name: c.name || c.displayName || 'Artículo',
      quantity: c.quantity || 1,
      unitPrice: c.unitPrice || c.price || 0,
      total: (c.unitPrice || c.price || 0) * (c.quantity || 1)
    }));
    const receivedVal = state.selectedPaymentMethod === 'cash' ? (parseFloat(cashReceivedInput?.value) || totals.totalNet) : totals.totalNet;
    const changeVal = state.selectedPaymentMethod === 'cash' ? Math.max(0, receivedVal - totals.totalNet) : 0;
    const itemsDetailStr = cartSnapshot.map(it => `${it.name} x${it.quantity}`).join(', ');

    const newHistoryEntry = {
      id: res?.result?.sale_id || Date.now(),
      folio: nextFolioStr,
      date: timeStr,
      created_at: now.toISOString(),
      cajaCode: terminalInfo.code,
      cajaName: terminalInfo.name,
      cashier: cashierName,
      role: cashierRole,
      itemsCount: totals.totalPieces,
      itemsSummary: `${totals.totalPieces} producto${totals.totalPieces > 1 ? 's' : ''}`,
      itemsDetail: itemsDetailStr,
      items: cartSnapshot,
      paymentMethod: state.selectedPaymentMethod,
      amountReceived: receivedVal,
      change: changeVal,
      cashAmount,
      cardAmount,
      transferAmount,
      cashReceived,
      cashChange,
      total: totals.totalNet,
      status: 'completed'
    };

    window.PosApp = window.PosApp || {};
    let existingHistory = [];
    if (Array.isArray(window.PosApp.salesHistoryList) && window.PosApp.salesHistoryList.length > 0) {
      existingHistory = [...window.PosApp.salesHistoryList];
    } else if (window.PosDataService && typeof window.PosDataService.getSalesHistory === 'function') {
      existingHistory = window.PosDataService.getSalesHistory() || [];
    }
    const withoutDup = existingHistory.filter(h => h.folio !== newHistoryEntry.folio);
    withoutDup.unshift(newHistoryEntry);
    window.PosApp.salesHistoryList = withoutDup;
    window.salesHistoryList = withoutDup;
    if (window.PosDataService && typeof window.PosDataService.saveSalesHistory === 'function') {
      window.PosDataService.saveSalesHistory(withoutDup);
    }

    // Limpiar carrito para la siguiente venta
    state.cart = [];
    if (typeof renderCart === 'function') renderCart();
    if (typeof window.renderSalesHistory === 'function') window.renderSalesHistory();
    if (typeof window.renderCashCut === 'function') window.renderCashCut();

    // Resetear campos de efectivo
    if (cashReceivedInput) cashReceivedInput.value = '';
    if (changeAmount) changeAmount.textContent = '$0.00';

    // Generar nuevo folio fresco
    state.folio = (typeof window.generateUniqueFolio === 'function')
      ? window.generateUniqueFolio(terminalInfo.code)
      : `#TK-${terminalInfo.code}-${Date.now()}`;

    // MOSTRAR LA PANTALLA DE ÉXITO CON PALOMITA VERDE Y BOTÓN DE IMPRIMIR TICKET
    showSaleSuccessModal(newHistoryEntry);
  }

  // ---------------------------------------------------------------------------
  // MODAL DE ÉXITO: PALOMITA VERDE ANIMADA + BOTÓN ÚNICO "IMPRIMIR TICKET"
  // ---------------------------------------------------------------------------
  function showSaleSuccessModal(ticket) {
    const modal = document.getElementById('modalSaleSuccess');
    if (!modal) {
      // Fallback si no existe el elemento en el DOM
      printTicketDirectly(ticket);
      return;
    }

    const totalEl = document.getElementById('saleSuccessTotalText');
    const folioEl = document.getElementById('saleSuccessFolioText');
    const paymentEl = document.getElementById('saleSuccessPaymentText');
    const btnPrint = document.getElementById('btnSaleSuccessPrintTicket');
    const btnClose = document.getElementById('btnCloseSaleSuccess');

    if (totalEl) totalEl.textContent = `$${parseFloat(ticket.total || 0).toFixed(2)}`;
    if (folioEl) folioEl.textContent = `Ticket ${ticket.folio || ''}`;

    const methodNames = {
      cash: 'Pago en Efectivo',
      card: 'Pago con Tarjeta Bancaria',
      transfer: 'Pago con Transferencia',
      mixed: 'Pago Mixto'
    };
    if (paymentEl) {
      let desc = methodNames[ticket.paymentMethod] || 'Pago en Efectivo';
      if (ticket.cashChange && ticket.cashChange > 0) {
        desc += ` • Cambio: $${parseFloat(ticket.cashChange).toFixed(2)}`;
      }
      paymentEl.textContent = desc;
    }

    modal.style.display = 'flex';

    // Manejador del botón único de imprimir
    const handlePrintClick = () => {
      printTicketDirectly(ticket);
      modal.style.display = 'none';
      cleanup();
    };

    const handleClose = () => {
      modal.style.display = 'none';
      cleanup();
    };

    const handleKeydown = (e) => {
      if (modal.style.display === 'flex') {
        if (e.key === 'Enter') {
          e.preventDefault();
          handlePrintClick();
        } else if (e.key === 'Escape') {
          handleClose();
        }
      }
    };

    function cleanup() {
      if (btnPrint) btnPrint.removeEventListener('click', handlePrintClick);
      if (btnClose) btnClose.removeEventListener('click', handleClose);
      window.removeEventListener('keydown', handleKeydown);
    }

    if (btnPrint) {
      btnPrint.onclick = handlePrintClick;
    }
    if (btnClose) {
      btnClose.onclick = handleClose;
    }

    modal.onclick = (e) => {
      if (e.target === modal) handleClose();
    };

    window.addEventListener('keydown', handleKeydown);
  }

  // ---------------------------------------------------------------------------
  // IMPRESIÓN DIRECTA DE TICKET TÉRMICO (Separada en www/js/app/printTicket.js)
  // ---------------------------------------------------------------------------
  function printTicketDirectly(ticket) {
    if (typeof window.printTicket === 'function') {
      return window.printTicket(ticket);
    }
    console.warn('[posPayments] window.printTicket no disponible.');
  }

  // Enlazar click del botón de cobrar
  if (btnCheckout) {
    btnCheckout.disabled = false;
    btnCheckout.classList.remove('btn-checkout-disabled');
    btnCheckout.onclick = triggerCheckout;
  }

  window.triggerCheckout = triggerCheckout;
  window.updateCashChange = updateCashChange;
  window.showSaleSuccessModal = showSaleSuccessModal;
  window.printTicketDirectly = printTicketDirectly;
}

window.initPosPayments = initPosPayments;
