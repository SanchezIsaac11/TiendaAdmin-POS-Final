/**
 * SUBMÓDULO POS: CONTROLADOR PRINCIPAL DEL PUNTO DE VENTA (pos.js)
 * Carrito de compras, cálculo de subtotales e impuestos, atajos de teclado, lector USB y ventas suspendidas
 */

// Estado del POS compartido
const state = {
  folio: (typeof window.generateUniqueFolio === 'function') 
    ? window.generateUniqueFolio(window.getActiveTerminal?.().code || 'C1') 
    : `#TK-C1-${Date.now().toString().slice(-6)}`,
  selectedPaymentMethod: 'cash',
  currentView: window.currentActiveView || 'pos',
  cart: [],
  ticketNote: ''
};

// Exponer state en window para acceso compartido
window.posState = state;
window.state = state;

window.setAppStateView = (v) => {
  state.currentView = v;
};

function initPos() {
  // =========================================================================
  // 2. ELEMENTOS DOM (POS & VISTA GENERAL)
  // =========================================================================
  const posViewContainer = document.getElementById('posViewContainer');
  const inventoryViewContainer = document.getElementById('inventoryViewContainer');
  const navPosBtn = document.getElementById('navPosBtn');
  const navInventoryBtn = document.getElementById('navInventoryBtn');

  const cartItemsList = document.getElementById('cartItemsList');
  const itemsSummary = document.getElementById('itemsSummary');
  const summarySubtotal = document.getElementById('summarySubtotal');
  const summaryDiscounts = document.getElementById('summaryDiscounts');
  const summaryTax = document.getElementById('summaryTax');
  const summaryTotalNet = document.getElementById('summaryTotalNet');
  const checkoutBtnLabel = document.getElementById('checkoutBtnLabel');
  const btnCheckout = document.getElementById('btnCheckout');
  const globalSearchInput = document.getElementById('globalSearchInput');
  const cartBarcodeInput = document.getElementById('cartBarcodeInput');
  const liveClock = document.getElementById('liveClock');
  const btnClearList = document.getElementById('btnClearList');
  const btnSuspend = document.getElementById('btnSuspend');
  const btnAddNote = document.getElementById('btnAddNote');
  const appModal = document.getElementById('appModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const cashCalculator = document.getElementById('cashCalculator');
  const cashReceivedInput = document.getElementById('cashReceivedInput');
  const changeAmount = document.getElementById('changeAmount');


  // =========================================================================
  // 8. LÓGICA DE VENTA ACTUAL (PUNTO DE VENTA)
  // =========================================================================

  function getProductIconSvg(iconType) {
    switch (iconType) {
      case 'milk':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M8 2h8v3H8z"></path>
          <path d="M7 5l-1 4h12l-1-4"></path>
          <rect x="6" y="9" width="12" height="13" rx="2"></rect>
          <line x1="10" y1="13" x2="14" y2="13"></line>
        </svg>`;
      case 'egg':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2C8 2 6 8 6 13a6 6 0 0 0 12 0c0-5-2-11-6-11z"></path>
        </svg>`;
      case 'soda':
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="7" y="4" width="10" height="17" rx="3"></rect>
          <ellipse cx="12" cy="4" rx="5" ry="1.5"></ellipse>
          <path d="M10 8h4"></path>
          <path d="M10 12h4"></path>
        </svg>`;
      case 'bread':
      default:
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 11V8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v3"></path>
          <rect x="3" y="11" width="18" height="9" rx="3"></rect>
          <line x1="8" y1="15" x2="8.01" y2="15"></line>
          <line x1="12" y1="15" x2="12.01" y2="15"></line>
          <line x1="16" y1="15" x2="16.01" y2="15"></line>
        </svg>`;
    }
  }

  const escapeHtml = window.escapeHtml || function(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  function evaluateCartItemPromo(item) {
    if (window.PosPromotions && typeof window.PosPromotions.evaluateItem === 'function') {
      return window.PosPromotions.evaluateItem(item);
    }
    let rule = item.promoRule;
    if (typeof rule === 'string' && rule.trim().startsWith('{')) {
      try { rule = JSON.parse(rule); } catch (e) { rule = null; }
    }
    if (!rule || item.isService) return null;
    const rawSubtotal = (item.unitPrice || 0) * (item.quantity || 1);
    const pType = rule.type || (rule.discount_percent != null || rule.percentage != null ? 'percentage' : (rule.bundle_price != null ? 'bundle' : null));
    if (pType === 'bundle' && rule.quantity >= 2 && rule.bundle_price != null) {
      const bundles = Math.floor(item.quantity / rule.quantity);
      if (bundles > 0) {
        const discount = (bundles * rule.quantity * item.unitPrice) - (bundles * rule.bundle_price);
        if (discount > 0) {
          return { discount, badge: rule.badge_text || `${rule.quantity}x$${rule.bundle_price}` };
        }
      }
    } else if (pType === 'percentage' || pType === 'percent') {
      const pct = parseFloat(rule.discount_percent ?? rule.percentage ?? 0);
      if (pct > 0 && pct <= 100) {
        return { discount: (rawSubtotal * pct) / 100, badge: rule.badge_text || `-${pct}%` };
      }
    }
    return null;
  }

  function calculateTotals() {
    let subtotalAccumulated = 0;
    let totalDiscount = 0;
    let totalPieces = 0;

    state.cart.forEach(item => {
      totalPieces += item.quantity;
      const rawItemSubtotal = item.unitPrice * item.quantity;
      subtotalAccumulated += rawItemSubtotal;

      const evalPromo = evaluateCartItemPromo(item);
      if (evalPromo && evalPromo.discount > 0) {
        totalDiscount += evalPromo.discount;
      }
    });

    const totalNet = Math.max(0, subtotalAccumulated - totalDiscount);
    const taxIncluded = totalNet - (totalNet / 1.16);

    return {
      subtotalAccumulated,
      totalDiscount,
      taxIncluded,
      totalNet,
      totalProducts: state.cart.length,
      totalPieces
    };
  }

  function renderCart() {
    if (!cartItemsList) return;

    cartItemsList.innerHTML = '';
    const totals = calculateTotals();

    if (state.cart.length === 0) {
      cartItemsList.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 16px; color: #94a3b8; text-align: center;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 44px; height: 44px; margin-bottom: 12px; opacity: 0.5;">
            <circle cx="9" cy="21" r="1"></circle>
            <circle cx="20" cy="21" r="1"></circle>
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
          </svg>
          <div style="font-weight: 600; color: #64748b; font-size: 14px;">Carrito vacío</div>
          <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">Escanea o escribe un código para iniciar la venta</div>
        </div>
      `;
    }

    state.cart.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'cart-item-row';

      if (item.unitPrice == null && item.price != null) item.unitPrice = item.price;
      const rawSubtotal = (item.unitPrice || 0) * (item.quantity || 1);
      const evalPromo = evaluateCartItemPromo(item);
      const hasPromoApplied = !!(evalPromo && evalPromo.discount > 0);
      const promoBadgeText = hasPromoApplied ? (evalPromo.badge || evalPromo.nombre || 'Promo') : '';
      const finalItemSubtotal = hasPromoApplied ? Math.max(0, rawSubtotal - evalPromo.discount) : rawSubtotal;

      const safeTitle = escapeHtml(item.name || '');
      const safeDisplay = escapeHtml(item.displayName || item.name || '');
      const safeBadge = escapeHtml(promoBadgeText);

      row.innerHTML = `
        <div class="item-icon-box">
          ${getProductIconSvg(item.iconType)}
        </div>
        <div class="item-details">
          <div class="item-title" title="${safeTitle}">${safeDisplay}</div>
          <div class="item-subtitle-row">
            <span class="item-meta">$${item.unitPrice.toFixed(2)} c/u</span>
            ${hasPromoApplied ? `
              <span class="promo-badge">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                </svg>
                ${safeBadge}
              </span>
            ` : ''}
          </div>
        </div>

        <div class="item-quantity-control">
          <button type="button" class="btn-qty btn-decrease" data-index="${index}">–</button>
          <span class="qty-number">${item.quantity}</span>
          <button type="button" class="btn-qty btn-increase" data-index="${index}">+</button>
        </div>

        <div class="item-price-col">
          <div class="price-subtotal ${hasPromoApplied ? 'promo-color' : ''}">
            $${finalItemSubtotal.toFixed(2)}
          </div>
          ${hasPromoApplied ? `<div class="price-original">$${rawSubtotal.toFixed(2)}</div>` : ''}
        </div>

        <button type="button" class="btn-remove-item" data-index="${index}" title="Eliminar producto">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      `;

      cartItemsList.appendChild(row);
    });

    if (itemsSummary) {
      itemsSummary.textContent = `${totals.totalProducts} productos • ${totals.totalPieces} piezas`;
    }
    if (state.ticketNote) {
      const noteRow = document.createElement('div');
      noteRow.style.cssText = 'padding: 8px 12px; background: #eff6ff; border: 1px dashed #93c5fd; border-radius: 8px; font-size: 12px; color: #1e40af; display: flex; align-items: center; justify-content: space-between; margin-top: 8px; margin-bottom: 8px;';
      noteRow.innerHTML = `<span><strong>Nota:</strong> ${escapeHtml(state.ticketNote)}</span><button type="button" style="background:none;border:none;color:#ef4444;font-size:16px;cursor:pointer;" title="Eliminar nota">&times;</button>`;
      noteRow.querySelector('button').addEventListener('click', () => {
        state.ticketNote = '';
        renderCart();
      });
      cartItemsList.appendChild(noteRow);
    }
    if (summarySubtotal) {
      summarySubtotal.textContent = `$${totals.subtotalAccumulated.toFixed(2)}`;
    }
    const discountsRow = document.getElementById('summaryDiscountsRow');
    if (summaryDiscounts) {
      summaryDiscounts.textContent = `-${totals.totalDiscount > 0 ? '$' + totals.totalDiscount.toFixed(2) : '$0.00'}`;
      if (discountsRow) {
        discountsRow.style.display = totals.totalDiscount > 0 ? 'flex' : 'none';
      }
    }
    if (summaryTax) {
      summaryTax.textContent = `$${totals.taxIncluded.toFixed(2)}`;
    }
    if (summaryTotalNet) {
      summaryTotalNet.textContent = `$${totals.totalNet.toFixed(2)}`;
    }
    if (checkoutBtnLabel) {
      checkoutBtnLabel.textContent = `Cobrar $${totals.totalNet.toFixed(2)}`;
    }

    updateCashChange();
  }


  // =========================================================================
  // MODAL: EDITAR CANTIDAD DE PRODUCTO EN EL CARRITO
  // =========================================================================
  let cartEditItemIndex = -1;
  const modalCartItemQty = document.getElementById('modalCartItemQty');
  const cartQtyModalTitle = document.getElementById('cartQtyModalTitle');
  const cartQtyProductName = document.getElementById('cartQtyProductName');
  const cartQtyProductPrice = document.getElementById('cartQtyProductPrice');
  const inputCartItemQty = document.getElementById('inputCartItemQty');
  const btnCartQtyMinus = document.getElementById('btnCartQtyMinus');
  const btnCartQtyPlus = document.getElementById('btnCartQtyPlus');
  const btnConfirmCartQty = document.getElementById('btnConfirmCartQty');
  const btnCancelCartQty = document.getElementById('btnCancelCartQty');
  const btnCloseCartQty = document.getElementById('btnCloseCartQty');

  function openCartQuantityModal(index) {
    if (index == null || index < 0 || index >= state.cart.length) return;
    cartEditItemIndex = index;
    const item = state.cart[index];
    if (!item) return;

    if (cartQtyProductName) cartQtyProductName.textContent = item.displayName || item.name;
    if (cartQtyProductPrice) {
      const price = parseFloat(item.unitPrice != null ? item.unitPrice : item.price) || 0;
      cartQtyProductPrice.textContent = `$${price.toFixed(2)} c/u`;
    }
    if (inputCartItemQty) {
      inputCartItemQty.value = item.quantity || 1;
    }

    if (modalCartItemQty) {
      modalCartItemQty.style.display = 'flex';
      setTimeout(() => {
        if (inputCartItemQty) {
          inputCartItemQty.focus();
          inputCartItemQty.select();
        }
      }, 50);
    }
  }

  function closeCartQuantityModal() {
    if (modalCartItemQty) modalCartItemQty.style.display = 'none';
    cartEditItemIndex = -1;
  }

  function applyCartQuantityModal() {
    if (cartEditItemIndex < 0 || cartEditItemIndex >= state.cart.length) {
      closeCartQuantityModal();
      return;
    }
    const val = parseInt(inputCartItemQty.value, 10);
    if (isNaN(val) || val <= 0) {
      state.cart.splice(cartEditItemIndex, 1);
    } else {
      state.cart[cartEditItemIndex].quantity = val;
    }
    closeCartQuantityModal();
    renderCart();
  }

  if (btnCartQtyMinus) {
    btnCartQtyMinus.addEventListener('click', () => {
      const cur = parseInt(inputCartItemQty.value, 10) || 1;
      if (cur > 1) inputCartItemQty.value = cur - 1;
    });
  }

  if (btnCartQtyPlus) {
    btnCartQtyPlus.addEventListener('click', () => {
      const cur = parseInt(inputCartItemQty.value, 10) || 1;
      inputCartItemQty.value = cur + 1;
    });
  }

  document.querySelectorAll('.btn-qty-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt(btn.dataset.val, 10);
      if (v && inputCartItemQty) {
        inputCartItemQty.value = v;
        inputCartItemQty.focus();
      }
    });
  });

  if (inputCartItemQty) {
    inputCartItemQty.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCartQuantityModal();
      } else if (e.key === 'Escape') {
        closeCartQuantityModal();
      }
    });
  }

  if (btnConfirmCartQty) btnConfirmCartQty.addEventListener('click', applyCartQuantityModal);
  if (btnCancelCartQty) btnCancelCartQty.addEventListener('click', closeCartQuantityModal);
  if (btnCloseCartQty) btnCloseCartQty.addEventListener('click', closeCartQuantityModal);
  if (modalCartItemQty) {
    modalCartItemQty.addEventListener('click', (e) => {
      if (e.target === modalCartItemQty) closeCartQuantityModal();
    });
  }

  if (cartItemsList) {
    cartItemsList.addEventListener('click', (e) => {
      const decBtn = e.target.closest('.btn-decrease');
      const incBtn = e.target.closest('.btn-increase');
      const remBtn = e.target.closest('.btn-remove-item');

      if (decBtn) {
        e.stopPropagation();
        const idx = parseInt(decBtn.dataset.index, 10);
        if (state.cart[idx] && state.cart[idx].quantity > 1) {
          state.cart[idx].quantity -= 1;
        } else {
          state.cart.splice(idx, 1);
        }
        renderCart();
      } else if (incBtn) {
        e.stopPropagation();
        const idx = parseInt(incBtn.dataset.index, 10);
        if (state.cart[idx]) {
          state.cart[idx].quantity += 1;
        }
        renderCart();
      } else if (remBtn) {
        e.stopPropagation();
        const idx = parseInt(remBtn.dataset.index, 10);
        state.cart.splice(idx, 1);
        renderCart();
      } else {
        // Al picarle al item en el carrito o a la cantidad, sale el recuadro para editar la cantidad
        const row = e.target.closest('.cart-item-row');
        if (row) {
          const allRows = Array.from(cartItemsList.querySelectorAll('.cart-item-row'));
          const idx = allRows.indexOf(row);
          if (idx !== -1) {
            openCartQuantityModal(idx);
          }
        }
      }
    });
  }

  function addProductToCart(product, quantity = 1) {
    if (!product) return;

    // 1. APERTURA DE CAJA: La caja debe estar abierta para empezar a vender
    if (window.currentShift && !window.currentShift.is_open) {
      if (typeof window.openNewShiftModal === 'function') {
        window.openNewShiftModal();
      }
      return;
    }

    const qty = parseInt(quantity, 10) || 1;

    // Normalización de identificadores para no duplicar items
    const pId = (product.id != null) ? String(product.id).trim() : '';
    const pBarcode = (product.barcode != null) ? String(product.barcode).trim() : '';
    const pBarcodeClean = pBarcode ? pBarcode.replace(/^0+/, '') : '';
    const pSku = (product.sku != null) ? String(product.sku).trim() : '';
    const pName = (product.name || '').trim().toLowerCase();

    const existing = state.cart.find(item => {
      const iId = (item.id != null) ? String(item.id).trim() : '';
      const iBarcode = (item.barcode != null) ? String(item.barcode).trim() : '';
      const iBarcodeClean = iBarcode ? iBarcode.replace(/^0+/, '') : '';
      const iSku = (item.sku != null) ? String(item.sku).trim() : '';
      const iName = (item.name || '').trim().toLowerCase();

      // 1. Coincidencia por código de barras exacto o sin ceros
      if (pBarcode && iBarcode && (pBarcode === iBarcode || pBarcodeClean === iBarcodeClean)) return true;
      // 2. Coincidencia por SKU
      if (pSku && iSku && pSku === iSku) return true;
      // 3. Coincidencia por ID de base de datos
      if (pId && iId && pId === iId) return true;
      // 4. Coincidencia por nombre exacto
      if (pName && iName && pName === iName) return true;

      return false;
    });

    if (existing) {
      existing.quantity += qty;
    } else {
      let rule = product.promoRule || product.promo_rule || null;
      if (typeof rule === 'string' && rule.trim().startsWith('{')) {
        try { rule = JSON.parse(rule); } catch (e) { rule = null; }
      }
      state.cart.push({
        id: product.id || Date.now(),
        sku: product.sku || product.barcode || '',
        barcode: product.barcode || '',
        name: product.name,
        displayName: product.displayName || product.display_name || product.name,
        unitPrice: parseFloat(product.price || product.unitPrice || product.unit_price || 0),
        quantity: qty,
        iconType: product.iconType || product.icon_type || 'bread',
        promoRule: rule
      });
    }
    renderCart();
    if (cartItemsList) cartItemsList.scrollTop = cartItemsList.scrollHeight;
  }

  async function handleProductScan(code, quantity = 1) {
    if (!code || !String(code).trim()) return;
    const clean = String(code).trim();
    const cleanNoZeros = clean.replace(/^0+/, '');

    // 1. Buscar en inventario cargado
    let product = inventoryList.find(p => {
      const b = (p.barcode || '').trim();
      const s = (p.sku || '').trim();
      return b === clean || s === clean || (b && b.replace(/^0+/, '') === cleanNoZeros);
    });

    // 2. Si no, buscar en Supabase
    if (!product && dataService && typeof dataService.findProductByBarcode === 'function') {
      try {
        product = await dataService.findProductByBarcode(clean);
      } catch (e) {}
    }

    // 3. Si no, buscar en el mega catálogo de México
    if (!product && typeof window.lookupMexicoBarcode === 'function') {
      const match = window.lookupMexicoBarcode(clean);
      if (match) {
        const existingByName = inventoryList.find(p => p.name && p.name.trim().toLowerCase() === match.name.trim().toLowerCase());
        if (existingByName) {
          existingByName.barcode = clean;
          product = existingByName;
        } else {
          product = {
            id: Date.now(),
            barcode: clean,
            sku: clean,
            name: match.name,
            displayName: match.name,
            category: match.category || 'Abarrotes',
            price: match.suggestedPrice || 20.00,
            cost: match.suggestedCost || 15.00,
            stock: 50,
            iconType: 'bread'
          };
          inventoryList.unshift(product);
          if (typeof renderInventory === 'function') renderInventory();
        }
      }
    }

    if (product) {
      addProductToCart(product, quantity);
      if (typeof playPosScanBeep === 'function') playPosScanBeep();
      if (typeof showPosToast === 'function') showPosToast(`Agregado: ${product.name}`);
    } else {
      showModal('Producto no encontrado', `No se encontró ningún artículo con código o nombre: "${code}".`);
    }
  }


  // =========================================================================
  // 9. ATAJOS DE TECLADO GLOBALES (F1, F2, ESPACIO) Y ESCÁNER USB
  // =========================================================================
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault();
      window.switchView('inventory');
    }

    if (e.key === 'F2') {
      e.preventDefault();
      window.switchView('pos');
      if (cartBarcodeInput) cartBarcodeInput.focus();
    }

    if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
      if (state.currentView === 'pos') {
        e.preventDefault();
        triggerCheckout();
      }
    }
  });

  // Captura global de lecturas de escáner de código de barras USB
  let globalScanBuffer = '';
  let globalScanLastTime = 0;
  let globalScanStartTime = 0;

  window.addEventListener('keydown', (e) => {
    // Si un modal de confirmación o edición de cantidad está abierto, no interceptar
    const modalActive = [modalCartItemQty, appModal, modalQuickService].some(m => m && m.style.display === 'flex');
    if (modalActive) return;

    const activeEl = document.activeElement;
    const isProductForm = activeEl && activeEl.closest && (activeEl.closest('#productForm') || activeEl.closest('#modalProductForm'));
    if (isProductForm) return;

    const now = Date.now();
    const timeDiff = now - globalScanLastTime;
    globalScanLastTime = now;

    if (e.key === 'Enter') {
      // Si el buffer tiene al menos 3 caracteres y llegó a velocidad rápida de escáner
      const isFastScan = globalScanBuffer.length >= 3 && (timeDiff < 180 || (now - globalScanStartTime) < 1600);
      if (isFastScan) {
        const scanned = globalScanBuffer.trim();
        globalScanBuffer = '';

        if (scanned) {
          e.preventDefault();
          e.stopPropagation();

          if (isInventoryViewActive()) {
            const invSearch = document.getElementById('invSearchInput');
            if (invSearch) invSearch.value = '';
            if (typeof inventoryFilter !== 'undefined') inventoryFilter.search = '';
            if (typeof renderInventory === 'function') renderInventory();

            handleInventoryBarcodeScan(scanned);
          } else {
            handleProductScan(scanned);
            if (cartBarcodeInput) {
              cartBarcodeInput.value = '';
              if (scanSuggestionsDropdown) scanSuggestionsDropdown.style.display = 'none';
            }
          }
          return;
        }
      }
      globalScanBuffer = '';
      return;
    }

    // Ignorar teclas que no son caracteres imprimibles
    if (e.key.length !== 1) return;

    // Si el tiempo entre pulsaciones es mayor a 120ms, es un humano escribiendo; reiniciar buffer
    if (timeDiff > 120) {
      globalScanBuffer = e.key;
      globalScanStartTime = now;
    } else {
      globalScanBuffer += e.key;
    }
  }, true);

  // Métodos de pago

  if (btnClearList) {
    btnClearList.addEventListener('click', () => {
      if (state.cart.length === 0) return;
      if (confirm('¿Deseas limpiar todos los productos de la venta actual?')) {
        state.cart = [];
        renderCart();
      }
    });
  }

  if (btnSuspend) {
    btnSuspend.addEventListener('click', () => {
      suspendCurrentSale();
    });
  }

  if (btnAddNote) {
    btnAddNote.addEventListener('click', () => {
      const currentNote = state.ticketNote || '';
      const note = prompt('Ingresa nota especial para este ticket (ej. "Cliente frecuente", "Para llevar"):', currentNote);
      if (note !== null) {
        state.ticketNote = note.trim();
        renderCart();
        if (state.ticketNote) {
          showModal('Nota Aplicada', `Nota guardada en el ticket: "${state.ticketNote}"`);
        }
      }
    });
  }

  // Control del botón desplegable único de Servicios

  // =========================================================================
  // SISTEMA DE VENTAS SUSPENDIDAS (EN ESPERA)
  // =========================================================================
  let suspendedSales = [];
  try {
    const saved = localStorage.getItem('pos_suspended_sales');
    if (saved) suspendedSales = JSON.parse(saved);
  } catch (e) {}

  function updateSuspendedBadge() {
    const btn = document.getElementById('btnSuspendedSales');
    const countEl = document.getElementById('suspendedCount');
    if (!btn) return;
    if (suspendedSales.length > 0) {
      btn.style.display = 'inline-flex';
      if (countEl) countEl.textContent = suspendedSales.length;
    } else {
      btn.style.display = 'none';
    }
  }

  function suspendCurrentSale() {
    if (!state.cart || state.cart.length === 0) {
      showModal('Ticket Vacío', 'No hay productos en la venta actual para suspender.');
      return;
    }

    const total = state.cart.reduce((sum, item) => sum + ((item.unitPrice || item.price || 0) * (item.quantity || 1)), 0);
    const count = state.cart.reduce((sum, item) => sum + (item.quantity || 1), 0);

    const record = {
      id: 'susp_' + Date.now(),
      folio: state.folio,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      itemsCount: count,
      cart: JSON.parse(JSON.stringify(state.cart)),
      note: state.ticketNote || '',
      total: total
    };

    suspendedSales.push(record);
    try {
      localStorage.setItem('pos_suspended_sales', JSON.stringify(suspendedSales));
    } catch (e) {}

    state.cart = [];
    const termCode = (typeof window.getActiveTerminal === 'function') ? window.getActiveTerminal().code : 'C1';
    state.folio = (typeof window.generateUniqueFolio === 'function') ? window.generateUniqueFolio(termCode) : `#TK-${termCode}-${Date.now().toString().slice(-6)}`;
    state.ticketNote = '';
    renderCart();
    updateSuspendedBadge();
    showModal('Ticket en Espera', `El ticket ${record.folio} con ${count} artículos (${total.toFixed(2)}) quedó suspendido. Listo para atender al siguiente cliente.`);
  }

  function openSuspendedModal() {
    if (suspendedSales.length === 0) return;
    if (suspendedSales.length === 1) {
      resumeSuspendedSale(0);
      return;
    }

    const modal = document.getElementById('modalSuspendedSales');
    const listEl = document.getElementById('suspendedSalesList');
    if (!modal || !listEl) return;

    listEl.innerHTML = '';
    suspendedSales.forEach((s, idx) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;';
      div.innerHTML = `
        <div>
          <div style="font-weight:700;color:#0f172a;font-size:14px;">${escapeHtml(s.folio)} · <span style="color:#2563eb;">$${s.total.toFixed(2)}</span></div>
          <div style="font-size:12px;color:#64748b;">${escapeHtml(s.time)} · ${s.itemsCount} piezas ${s.note ? '• ' + escapeHtml(s.note) : ''}</div>
        </div>
        <button type="button" class="btn-inv btn-inv-primary" style="padding:6px 14px;font-size:12.5px;" data-idx="${idx}">Reanudar</button>
      `;
      div.querySelector('button').addEventListener('click', () => {
        resumeSuspendedSale(idx);
        modal.style.display = 'none';
      });
      listEl.appendChild(div);
    });

    modal.style.display = 'flex';
  }

  function resumeSuspendedSale(idx) {
    if (idx < 0 || idx >= suspendedSales.length) return;
    const item = suspendedSales.splice(idx, 1)[0];
    try {
      localStorage.setItem('pos_suspended_sales', JSON.stringify(suspendedSales));
    } catch (e) {}

    state.cart = item.cart || [];
    state.folio = item.folio || state.folio;
    state.ticketNote = item.note || '';
    renderCart();
    updateSuspendedBadge();
    showModal('Ticket Reanudado', `Ticket ${item.folio} cargado al mostrador con ${state.cart.length} productos listos para cobrar.`);
  }

  document.getElementById('btnSuspendedSales')?.addEventListener('click', openSuspendedModal);
  document.getElementById('btnCloseSuspendedModal')?.addEventListener('click', () => {
    const modal = document.getElementById('modalSuspendedSales');
    if (modal) modal.style.display = 'none';
  });


  // Bip de confirmación en la PC
  let posAudioCtx = null;
  function playPosScanBeep() {
    try {
      if (!posAudioCtx) posAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (posAudioCtx.state === 'suspended') posAudioCtx.resume();
      const osc = posAudioCtx.createOscillator();
      const gain = posAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1750, posAudioCtx.currentTime);
      gain.gain.setValueAtTime(0.2, posAudioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, posAudioCtx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(posAudioCtx.destination);
      osc.start();
      osc.stop(posAudioCtx.currentTime + 0.08);
    } catch (e) {}
  }

  // Notificación flotante en pantalla de la PC
  function showPosToast(message) {
    let toast = document.getElementById('posScanToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'posScanToast';
      toast.style.position = 'fixed';
      toast.style.bottom = '24px';
      toast.style.right = '24px';
      toast.style.background = '#0f172a';
      toast.style.color = '#ffffff';
      toast.style.padding = '14px 20px';
      toast.style.borderRadius = '10px';
      toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
      toast.style.fontSize = '14px';
      toast.style.fontWeight = '700';
      toast.style.zIndex = '999999';
      toast.style.border = '1px solid #334155';
      toast.style.transition = 'all 0.25s ease';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.display = 'block';
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => { toast.style.display = 'none'; }, 300);
    }, 3200);
  }

  // Procesar escaneo de cobro recibido del celular
  async function handleMobileScanToPos(scan) {
    const code = String(scan.barcode).trim();
    const qty = parseInt(scan.quantity, 10) || 1;
    const meta = scan.metadata || {};

    // Desbloquear pantalla de inicio si aún estaba visible
    const loginScreen = document.getElementById('loginScreen');
    if (loginScreen && !loginScreen.classList.contains('hidden') && loginScreen.style.display !== 'none') {
      loginScreen.classList.add('hidden');
      loginScreen.style.display = 'none';
    }

    // 1. Buscar en inventario local cargado
    let product = inventoryList.find(p => p.barcode === code || p.sku === code);

    // 2. Si no, buscar en Supabase
    if (!product && dataService && typeof dataService.findProductByBarcode === 'function') {
      try {
        product = await dataService.findProductByBarcode(code);
      } catch (e) {}
    }

    // 3. Si no, buscar en catálogo nacional de México
    if (!product && typeof window.lookupMexicoBarcode === 'function') {
      const match = window.lookupMexicoBarcode(code);
      if (match) {
        product = {
          id: Date.now(),
          barcode: code,
          sku: code,
          name: match.name,
          displayName: match.name,
          category: match.category || 'Abarrotes',
          price: match.suggestedPrice || 20.00,
          cost: match.suggestedCost || 15.00,
          stock: 50,
          iconType: 'bread'
        };
        inventoryList.unshift(product);
        if (typeof renderInventory === 'function') renderInventory();
      }
    }

    // 4. Si aún no, crear con los metadatos enviados desde el móvil
    if (!product) {
      product = {
        id: Date.now(),
        barcode: code,
        sku: code,
        name: meta.name || `Producto ${code}`,
        displayName: meta.name || `Producto ${code}`,
        category: 'Abarrotes',
        price: parseFloat(meta.price) || 20.00,
        cost: 15.00,
        stock: 50,
        iconType: 'bread'
      };
      inventoryList.unshift(product);
      if (typeof renderInventory === 'function') renderInventory();
    }

    // Agregar al carrito del POS
    addProductToCart(product, qty);
    playPosScanBeep();

    if (state.currentView !== 'pos') {
      window.switchView('pos');
    }

    showPosToast(`Móvil: ${product.name} (+${qty})`);
  }

  // Procesar actualización de inventario recibida del celular

  // =========================================================================
  // CONTROL DE ESTADO DE TURNO, BLOQUEO DE VENTAS Y SELECCIÓN DE CAJA
  // =========================================================================

  async function checkShiftState() {
    const terminalInfo = typeof window.getActiveTerminal === 'function' ? window.getActiveTerminal() : { code: 'C1', name: 'Caja 1' };
    
    // Actualizar insignias de terminal
    const headerCajaBadge = document.getElementById('headerCajaBadge');
    if (headerCajaBadge) headerCajaBadge.textContent = terminalInfo.name;
    const cutCajaName = document.getElementById('cutCajaName');
    if (cutCajaName) cutCajaName.textContent = terminalInfo.name;

    let shiftData = null;
    if (window.PosDataService && typeof window.PosDataService.getTerminalShift === 'function') {
      shiftData = await window.PosDataService.getTerminalShift(terminalInfo.code);
    }

    window.currentShift = shiftData;

    const btnCheckoutEl = document.getElementById('btnCheckout');
    const shiftNameFooter = document.querySelector('.settlement-footer .shift-name');
    let shiftClosedBanner = document.getElementById('shiftClosedBanner');

    if (shiftData && shiftData.is_open) {
      // TURNO EN CURSO
      if (shiftClosedBanner) shiftClosedBanner.style.display = 'none';
      if (btnCheckoutEl) {
        btnCheckoutEl.classList.remove('btn-checkout-disabled');
        btnCheckoutEl.removeAttribute('disabled');
        btnCheckoutEl.title = 'Completar venta actual';
      }
      if (shiftNameFooter) {
        shiftNameFooter.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;margin-right:6px;"></span>${terminalInfo.name} • Turno Abierto`;
      }
    } else {
      // TURNO CERRADO: Permitir cobro fluido (auto-apertura de turno al cobrar)
      if (shiftClosedBanner) shiftClosedBanner.style.display = 'none';
      if (shiftNameFooter) {
        shiftNameFooter.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;margin-right:6px;"></span>${terminalInfo.name} • Listo para Cobrar`;
      }
    }

    if (btnCheckoutEl) {
      btnCheckoutEl.classList.remove('btn-checkout-disabled');
      btnCheckoutEl.removeAttribute('disabled');
      btnCheckoutEl.title = 'Completar venta actual';
    }

    return shiftData;
  }

  window.checkShiftState = checkShiftState;

  // Apertura de turno
  window.openNewShiftModal = function() {
    const modal = document.getElementById('modalOpenShift');
    const terminalInfo = typeof window.getActiveTerminal === 'function' ? window.getActiveTerminal() : { code: 'C1', name: 'Caja 1' };
    if (modal) {
      const openShiftCajaName = document.getElementById('openShiftCajaName');
      const openShiftFundInput = document.getElementById('openShiftFundInput');
      if (openShiftCajaName) openShiftCajaName.textContent = `${terminalInfo.name} (${terminalInfo.code})`;
      if (openShiftFundInput) openShiftFundInput.value = '1000.00';
      modal.style.display = 'flex';
    } else {
      const fund = prompt(`Abrir turno en ${terminalInfo.name}\nIngrese el fondo inicial en efectivo:`, '1000.00');
      if (fund != null) {
        window.confirmOpenShift(parseFloat(fund) || 1000.00);
      }
    }
  };

  window.confirmOpenShift = async function(fund) {
    const terminalInfo = typeof window.getActiveTerminal === 'function' ? window.getActiveTerminal() : { code: 'C1', name: 'Caja 1' };
    const cashierName = (window.currentSessionUser && window.currentSessionUser.name) || 'Elena R.';
    const initialFund = parseFloat(fund) || 1000.00;

    const res = await window.PosDataService.openTerminalShift(
      terminalInfo.code,
      terminalInfo.name,
      cashierName,
      initialFund
    );

    const modal = document.getElementById('modalOpenShift');
    if (modal) modal.style.display = 'none';

    if (!res || !res.ok) {
      showModal('Error al abrir turno', res?.error || 'No se pudo abrir el turno.');
      return;
    }

    // Sincronizar todas las pantallas tras abrir nuevo turno (inicia con 0 ventas y $0.00)
    if (typeof window.syncAllPosScreens === 'function') {
      await window.syncAllPosScreens();
    } else {
      await checkShiftState();
      if (typeof renderCashCut === 'function') renderCashCut();
    }

    showModal(
      'Turno Abierto con Éxito',
      `Se ha creado un nuevo turno en Supabase para ${terminalInfo.name}.\n\n` +
      `• Fondo inicial: $${initialFund.toFixed(2)}\n` +
      `• Cajero: ${cashierName}\n\n` +
      `Las ventas en esta caja han sido desbloqueadas.`
    );
  };

  // Selector de terminal (Caja 1 o Caja 2)
  const headerCajaBadge = document.getElementById('headerCajaBadge');
  if (headerCajaBadge) {
    headerCajaBadge.style.cursor = 'pointer';
    headerCajaBadge.title = 'Click para cambiar entre Caja 1 y Caja 2';
    headerCajaBadge.addEventListener('click', () => {
      const current = typeof window.getActiveTerminal === 'function' ? window.getActiveTerminal() : { code: 'C1' };
      const nextCode = current.code === 'C1' ? 'C2' : 'C1';
      const nextName = nextCode === 'C2' ? 'Caja 2' : 'Caja 1';

      if (confirm(`¿Cambiar este equipo a "${nextName}" (${nextCode})?\n\nAmbas cajas comparten inventario pero gestionan sus propios turnos y cortes de caja en Supabase.`)) {
        window.setActiveTerminal(nextCode);
        checkShiftState();
        if (typeof renderCashCut === 'function') renderCashCut();
        if (typeof refreshSalesFromSupabase === 'function') refreshSalesFromSupabase();
        showModal('Terminal Activa Actualizada', `Este dispositivo está configurado ahora como ${nextName} (${nextCode}).`);
      }
    });
  }

  // Verificar turno al inicio
  checkShiftState();

  function initLanScannerListener() {
    let isFetching = false;
    // Solo consultar escáner LAN si estamos en entorno Node local
    if (window.location.protocol === 'file:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      const apiBase = '';
      setInterval(async () => {
        if (isFetching) return;
        isFetching = true;
        try {
          const res = await fetch(`${apiBase}/api/pos/scans`);
          if (res.ok) {
            const data = await res.json();
            if (data.ok && Array.isArray(data.scans) && data.scans.length > 0) {
              for (const item of data.scans) {
                const isInv = isInventoryViewActive();
                if (isInv) {
                  handleInventoryBarcodeScan(item.barcode, item);
                } else if (item.mode === 'inventory_add') {
                  handleMobileInventoryAdd(item);
                } else {
                  await handleMobileScanToPos(item);
                }
              }
            }
          }
        } catch (err) {
        } finally {
          isFetching = false;
        }
      }, 1500);
    }
  }
  initLanScannerListener();

  // Exponer funciones principales del POS en window
  window.getProductIconSvg = getProductIconSvg;
  window.calculateTotals = calculateTotals;
  window.renderCart = renderCart;
  window.openCartQuantityModal = openCartQuantityModal;
  window.closeCartQuantityModal = closeCartQuantityModal;
  window.applyCartQuantityModal = applyCartQuantityModal;
  window.addProductToCart = addProductToCart;
  window.handleProductScan = handleProductScan;
  window.playPosScanBeep = playPosScanBeep;
  window.showPosToast = showPosToast;
  window.updateSuspendedBadge = updateSuspendedBadge;
  window.suspendCurrentSale = suspendCurrentSale;
  window.openSuspendedModal = openSuspendedModal;
  window.resumeSuspendedSale = resumeSuspendedSale;

  window.addEventListener('promotions:changed', () => {
    if (typeof renderCart === 'function') renderCart();
  });
}

window.initPos = initPos;
