/**
 * MÓDULO: INVENTARIO (inventory.js)
 * Catálogo de productos, stock, ajustes por merma, compras, etiquetas y sincronización
 */

const inventoryFilter = {
  search: '',
  category: 'all',
  status: 'all'
};

function initInventory() {
  // =========================================================================
  // 3. ELEMENTOS DOM (INVENTARIO)
  // =========================================================================
  const invSearchInput = document.getElementById('invSearchInput');
  const invCategorySelect = document.getElementById('invCategorySelect');
  const inventoryTableBody = document.getElementById('inventoryTableBody');
  const inventoryEmptyState = document.getElementById('inventoryEmptyState');
  const statusTabs = document.querySelectorAll('.status-tab');

  const btnExportInventory = document.getElementById('btnExportInventory');
  const btnAjusteMerma = document.getElementById('btnAjusteMerma');
  const btnEntradaCompra = document.getElementById('btnEntradaCompra');
  const btnNuevoProducto = document.getElementById('btnNuevoProducto');

  // Modales de Inventario
  const modalProductForm = document.getElementById('modalProductForm');
  const btnCloseProductForm = document.getElementById('btnCloseProductForm');
  const btnCancelProductForm = document.getElementById('btnCancelProductForm');
  const productForm = document.getElementById('productForm');
  const productFormTitle = document.getElementById('productFormTitle');
  const btnGenBarcode = document.getElementById('btnGenBarcode');

  const modalEntryForm = document.getElementById('modalEntryForm');
  const btnCloseEntryForm = document.getElementById('btnCloseEntryForm');
  const btnCancelEntryForm = document.getElementById('btnCancelEntryForm');
  const entryForm = document.getElementById('entryForm');
  const entryProdSelect = document.getElementById('entryProdSelect');

  const modalShrinkageForm = document.getElementById('modalShrinkageForm');
  const btnCloseShrinkageForm = document.getElementById('btnCloseShrinkageForm');
  const btnCancelShrinkageForm = document.getElementById('btnCancelShrinkageForm');
  const shrinkageForm = document.getElementById('shrinkageForm');
  const shrinkageProdSelect = document.getElementById('shrinkageProdSelect');


  // =========================================================================
  // 6. CONTROLADOR DE INVENTARIO
  // =========================================================================
  function updateInventoryCounts() {
    const totalAll = inventoryList.length;
    const totalOptimal = inventoryList.filter(p => p.stock > 5).length;
    const totalLow = inventoryList.filter(p => p.stock > 0 && p.stock <= 5).length;
    const totalOut = inventoryList.filter(p => p.stock <= 0).length;

    const countAllEl = document.getElementById('countAll');
    const countOptimalEl = document.getElementById('countOptimal');
    const countLowEl = document.getElementById('countLow');
    const countOutEl = document.getElementById('countOut');

    if (countAllEl) countAllEl.textContent = totalAll;
    if (countOptimalEl) countOptimalEl.textContent = totalOptimal;
    if (countLowEl) countLowEl.textContent = totalLow;
    if (countOutEl) countOutEl.textContent = totalOut;
  }

  function renderInventory() {
    if (!inventoryList || inventoryList.length === 0) {
      inventoryList = dataService.getInventoryProducts();
    }
    updateInventoryCounts();
    if (!inventoryTableBody) return;

    inventoryTableBody.innerHTML = '';

    const filtered = inventoryList.filter(item => {
      // Filtro de búsqueda
      if (inventoryFilter.search) {
        const q = inventoryFilter.search.toLowerCase();
        const matchName = (item.name || '').toLowerCase().includes(q);
        const matchBarcode = (item.barcode || '').toLowerCase().includes(q);
        const matchCategory = (item.category || '').toLowerCase().includes(q);
        if (!matchName && !matchBarcode && !matchCategory) return false;
      }

      // Filtro de categoría
      if (inventoryFilter.category !== 'all' && item.category !== inventoryFilter.category) {
        return false;
      }

      // Filtro de estado
      if (inventoryFilter.status === 'optimal' && item.stock <= 5) return false;
      if (inventoryFilter.status === 'low' && (item.stock <= 0 || item.stock > 5)) return false;
      if (inventoryFilter.status === 'out' && item.stock > 0) return false;

      return true;
    });

    if (filtered.length === 0) {
      if (inventoryEmptyState) inventoryEmptyState.style.display = 'flex';
    } else {
      if (inventoryEmptyState) inventoryEmptyState.style.display = 'none';
    }

    filtered.forEach(item => {
      const tr = document.createElement('tr');

      let statusBadge = '';
      if (item.stock <= 0) {
        statusBadge = `<span class="badge-status badge-status-out"><span class="dot-status"></span>Agotado</span>`;
      } else if (item.stock <= 5) {
        statusBadge = `<span class="badge-status badge-status-low"><span class="dot-status"></span>Stock Bajo</span>`;
      } else {
        statusBadge = `<span class="badge-status badge-status-optimal"><span class="dot-status"></span>Óptimo</span>`;
      }

      tr.innerHTML = `
        <td>
          <div class="cell-barcode">
            <svg class="barcode-mini-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 5v14M7 5v14M11 5v14M15 5v14M17 5v14M21 5v14"></path>
            </svg>
            <span>${item.barcode}</span>
          </div>
        </td>
        <td>
          <div class="cell-product-info">
            <span class="product-name">${item.name}</span>
            <span class="product-category">${item.category}</span>
          </div>
        </td>
        <td>
          <span class="cell-cost">$${parseFloat(item.cost).toFixed(2)}</span>
        </td>
        <td>
          <span class="cell-price">$${parseFloat(item.price).toFixed(2)}</span>
        </td>
        <td>
          <span class="cell-stock"><strong>${item.stock}</strong> <span class="stock-unit">uds</span></span>
        </td>
        <td style="text-align: center;">
          ${statusBadge}
        </td>
        <td>
          <div class="cell-actions">
            <button type="button" class="btn-inv-action btn-edit-product" data-id="${item.id}" title="Editar producto">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"></path>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
              </svg>
            </button>
            <button type="button" class="btn-inv-action btn-delete-product" data-id="${item.id}" title="Eliminar producto">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </td>
      `;

      inventoryTableBody.appendChild(tr);
    });
  }

  window.renderInventory = renderInventory;

  // Filtros de búsqueda en inventario
  if (invSearchInput) {
    invSearchInput.addEventListener('input', (e) => {
      inventoryFilter.search = e.target.value.trim();
      renderInventory();
    });

    invSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = invSearchInput.value.trim();
        if (val) {
          e.preventDefault();
          handleInventoryBarcodeScan(val);
          invSearchInput.value = '';
          inventoryFilter.search = '';
          renderInventory();
        }
      }
    });
  }

  if (invCategorySelect) {
    invCategorySelect.addEventListener('change', (e) => {
      inventoryFilter.category = e.target.value;
      renderInventory();
    });
  }

  statusTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      statusTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      inventoryFilter.status = tab.dataset.status;
      renderInventory();
    });
  });

  if (inventoryTableBody) {
    inventoryTableBody.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.btn-edit-product');
      const deleteBtn = e.target.closest('.btn-delete-product');

      if (editBtn) {
        const id = parseInt(editBtn.dataset.id, 10);
        const item = inventoryList.find(p => p.id === id);
        if (item) openEditProductModal(item);
      } else if (deleteBtn) {
        const id = parseInt(deleteBtn.dataset.id, 10);
        const item = inventoryList.find(p => p.id === id);
        if (item && confirm(`¿Deseas eliminar "${item.name}" del inventario?`)) {
          inventoryList = inventoryList.filter(p => p.id !== id);
          dataService.saveInventoryProducts(inventoryList);
          if (dataService.deleteProduct) dataService.deleteProduct(id);
          renderInventory();
          showModal('Producto Eliminado', `El producto "${item.name}" fue retirado del inventario y de Supabase.`);
        }
      }
    });
  }

  // =========================================================================
  // 7. MODALES Y FORMULARIOS DE INVENTARIO
  // =========================================================================

  if (btnNuevoProducto) {
    btnNuevoProducto.addEventListener('click', () => {
      productFormTitle.textContent = 'Nuevo Producto';
      productForm.reset();
      document.getElementById('prodFormId').value = '';
      modalProductForm.style.display = 'flex';
      document.getElementById('prodFormBarcode').focus();
    });
  }

  if (btnGenBarcode) {
    btnGenBarcode.addEventListener('click', () => {
      const randomDigits = Math.floor(100000000 + Math.random() * 900000000);
      document.getElementById('prodFormBarcode').value = `750${randomDigits}`;
    });
  }

  function openEditProductModal(item) {
    productFormTitle.textContent = 'Editar Producto';
    document.getElementById('prodFormId').value = item.id;
    document.getElementById('prodFormBarcode').value = item.barcode;
    document.getElementById('prodFormName').value = item.name;
    document.getElementById('prodFormCategory').value = item.category;
    document.getElementById('prodFormCost').value = item.cost;
    document.getElementById('prodFormPrice').value = item.price;
    document.getElementById('prodFormStock').value = item.stock;

    modalProductForm.style.display = 'flex';
  }

  function isInventoryViewActive() {
    const invContainer = document.getElementById('inventoryViewContainer');
    if (invContainer && invContainer.style.display !== 'none') return true;
    if (state && state.currentView === 'inventory') return true;
    if (window.currentActiveView === 'inventory') return true;
    return false;
  }

  async function handleInventoryBarcodeScan(code, initialData = null) {
    if (!code || !String(code).trim()) return;
    const clean = String(code).trim();
    const cleanNoZeros = clean.replace(/^0+/, '');

    // 1. Si ya existe en el inventario local, abrir de inmediato para editar / subir stock
    let item = inventoryList.find(p => {
      const b = (p.barcode || '').trim();
      const s = (p.sku || '').trim();
      return b === clean || s === clean || (b && b.replace(/^0+/, '') === cleanNoZeros);
    });

    if (item) {
      openEditProductModal(item);
      if (typeof playPosScanBeep === 'function') playPosScanBeep();
      setTimeout(() => {
        const stockInput = document.getElementById('prodFormStock');
        if (stockInput) {
          stockInput.focus();
          stockInput.select();
        }
      }, 50);
      return;
    }

    // 2. Si no está en inventario, ABRIR EL RECUADRO LUEGO LUEGO (de inmediato en 0ms)
    productFormTitle.textContent = 'Nuevo Producto';
    productForm.reset();
    document.getElementById('prodFormId').value = '';
    const barcodeInput = document.getElementById('prodFormBarcode');
    if (barcodeInput) barcodeInput.value = clean;
    document.getElementById('prodFormStock').value = (initialData && initialData.quantity) ? initialData.quantity : 1;

    // Mostrar modal inmediatamente
    modalProductForm.style.display = 'flex';
    if (typeof playPosScanBeep === 'function') playPosScanBeep();

    // Ver si viene información del escaneo móvil o catálogo instantáneo local (0ms)
    if (initialData) {
      if (initialData.name) document.getElementById('prodFormName').value = initialData.name;
      if (initialData.category) document.getElementById('prodFormCategory').value = initialData.category;
      if (initialData.cost) document.getElementById('prodFormCost').value = initialData.cost;
      if (initialData.price) document.getElementById('prodFormPrice').value = initialData.price;
    }

    let instantMatch = (typeof window.lookupMexicoBarcode === 'function') ? window.lookupMexicoBarcode(clean) : null;
    if (instantMatch && (!initialData || !initialData.name)) {
      document.getElementById('prodFormName').value = instantMatch.name || '';
      if (instantMatch.category) document.getElementById('prodFormCategory').value = instantMatch.category;
      if (instantMatch.suggestedCost) document.getElementById('prodFormCost').value = instantMatch.suggestedCost;
      if (instantMatch.suggestedPrice) document.getElementById('prodFormPrice').value = instantMatch.suggestedPrice;
    }

    // Consultar en segundo plano la API de Open Food Facts y el backend para obtener el nombre exacto
    (async () => {
      let foundName = (initialData && initialData.name) || (instantMatch ? instantMatch.name : '');
      let foundCat = (initialData && initialData.category) || (instantMatch ? instantMatch.category : 'Abarrotes');
      let foundPrice = (initialData && initialData.price) || (instantMatch ? instantMatch.suggestedPrice : '');
      let foundCost = (initialData && initialData.cost) || (instantMatch ? instantMatch.suggestedCost : '');

      const apiBase = (window.location.protocol === 'file:') ? 'http://localhost:3000' : '';

      // A. Consultar backend
      try {
        const res = await fetch(`${apiBase}/api/producto/${encodeURIComponent(clean)}`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.product && data.product.nombre) {
            foundName = data.product.nombre;
            if (data.product.categoria) foundCat = data.product.categoria;
            if (data.product.precio_costo) foundCost = data.product.precio_costo;
            if (data.product.precio_venta) foundPrice = data.product.precio_venta;
          }
        }
      } catch (e) {}

      // B. Si aún no tiene nombre, consultar Open Food Facts directo (idéntico al escáner móvil)
      if (!foundName && navigator.onLine) {
        try {
          const res = await fetch(
            `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json?fields=product_name,product_name_es,generic_name,generic_name_es,brands,brand_owner,quantity,categories`
          );
          if (res.ok) {
            const data = await res.json();
            if (data && data.status === 1 && data.product) {
              const p = data.product;
              const base = (p.product_name_es || p.product_name || p.generic_name_es || p.generic_name || '').trim();
              const brand = (p.brands || p.brand_owner || '').split(',')[0].trim();
              const qty = String(p.quantity || '').trim();
              let name = base;
              if (brand && !name.toLowerCase().includes(brand.toLowerCase().split(' ')[0])) name = `${brand} ${name}`.trim();
              if (qty && !name.toLowerCase().includes(qty.toLowerCase())) name = `${name} ${qty}`.trim();
              foundName = name;
              if (p.categories) {
                const cLower = p.categories.toLowerCase();
                if (cLower.includes('beverage') || cLower.includes('bebida') || cLower.includes('refresco')) foundCat = 'Bebidas y Refrescos';
                else if (cLower.includes('dairy') || cLower.includes('lácteo') || cLower.includes('leche')) foundCat = 'Lácteos y Cremería';
                else if (cLower.includes('snack') || cLower.includes('botana') || cLower.includes('papas')) foundCat = 'Botanas';
                else if (cLower.includes('bread') || cLower.includes('pan')) foundCat = 'Panadería';
                else if (cLower.includes('clean') || cLower.includes('limpieza') || cLower.includes('jabón')) foundCat = 'Limpieza e Higiene';
                else foundCat = 'Abarrotes y Granos';
              }
            }
          }
        } catch (e) {}
      }

      // Si el modal sigue abierto para este mismo código de barras, actualizar campos silenciosamente
      const barcodeInputEl = document.getElementById('prodFormBarcode');
      const currentCodeInInput = barcodeInputEl ? barcodeInputEl.value.trim() : '';
      if (currentCodeInInput === clean || currentCodeInInput.replace(/^0+/, '') === cleanNoZeros) {
        if (foundName) {
          const nameEl = document.getElementById('prodFormName');
          if (nameEl) nameEl.value = foundName;
          const catEl = document.getElementById('prodFormCategory');
          if (catEl) catEl.value = foundCat || 'Abarrotes';
          if (foundCost) {
            const costEl = document.getElementById('prodFormCost');
            if (costEl) costEl.value = foundCost;
          }
          if (foundPrice) {
            const priceEl = document.getElementById('prodFormPrice');
            if (priceEl) priceEl.value = foundPrice;
          }

          const stockEl = document.getElementById('prodFormStock');
          if (stockEl) {
            stockEl.focus();
            stockEl.select();
          }
        } else if (!instantMatch && (!initialData || !initialData.name)) {
          const nameEl = document.getElementById('prodFormName');
          if (nameEl) nameEl.focus();
        }
      }
    })();
  }

  // Consulta silenciosa al escribir o presionar Enter en código de barras en el formulario
  const prodFormBarcodeEl = document.getElementById('prodFormBarcode');
  if (prodFormBarcodeEl) {
    prodFormBarcodeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const code = prodFormBarcodeEl.value.trim();
        if (code) handleInventoryBarcodeScan(code);
      }
    });

    prodFormBarcodeEl.addEventListener('blur', async () => {
      const code = prodFormBarcodeEl.value.trim();
      const nameInput = document.getElementById('prodFormName');
      if (code && nameInput && !nameInput.value.trim()) {
        try {
          const res = await fetch(`/api/producto/${encodeURIComponent(code)}`);
          if (res.ok) {
            const data = await res.json();
            if (data && data.product && data.product.nombre) {
              nameInput.value = data.product.nombre;
              if (data.product.categoria) document.getElementById('prodFormCategory').value = data.product.categoria;
              if (data.product.precio_costo) document.getElementById('prodFormCost').value = data.product.precio_costo;
              if (data.product.precio_venta) document.getElementById('prodFormPrice').value = data.product.precio_venta;
              const stockEl = document.getElementById('prodFormStock');
              if (stockEl && (!stockEl.value || stockEl.value === '0')) {
                stockEl.value = 1;
              }
            }
          }
        } catch (e) {}
      }
    });
  }

  if (productForm) {
    productForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const idStr = document.getElementById('prodFormId').value;
      const barcode = document.getElementById('prodFormBarcode').value.trim();
      const name = document.getElementById('prodFormName').value.trim();
      const category = document.getElementById('prodFormCategory').value;
      const cost = parseFloat(document.getElementById('prodFormCost').value) || 0;
      const price = parseFloat(document.getElementById('prodFormPrice').value) || 0;
      const stock = parseInt(document.getElementById('prodFormStock').value, 10) || 0;

      if (!barcode || !name) {
        alert('Por favor ingresa un código de barras y un nombre válido.');
        return;
      }

      let savedItem = null;
      if (idStr) {
        const id = parseInt(idStr, 10);
        const item = inventoryList.find(p => p.id === id);
        if (item) {
          item.barcode = barcode;
          item.name = name;
          item.category = category;
          item.cost = cost;
          item.price = price;
          item.stock = stock;
          savedItem = item;
        }
      } else {
        const newId = inventoryList.length > 0 ? Math.max(...inventoryList.map(p => p.id)) + 1 : 1;
        savedItem = {
          id: newId,
          barcode,
          name,
          category,
          cost,
          price,
          stock
        };
        inventoryList.unshift(savedItem);
      }

      dataService.saveInventoryProducts(inventoryList);
      if (savedItem && dataService.saveProduct) {
        dataService.saveProduct(savedItem);
      }
      renderInventory();
      modalProductForm.style.display = 'none';
      showModal('Operación Exitosa', `Producto "${name}" guardado correctamente en Supabase e inventario.`);
    });
  }

  if (btnCloseProductForm) btnCloseProductForm.addEventListener('click', () => modalProductForm.style.display = 'none');
  if (btnCancelProductForm) btnCancelProductForm.addEventListener('click', () => modalProductForm.style.display = 'none');

  function populateProductSelect(selectElement) {
    selectElement.innerHTML = '';
    inventoryList.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = `${item.name} (${item.barcode}) - Stock: ${item.stock} uds`;
      selectElement.appendChild(opt);
    });
  }

  if (btnEntradaCompra) {
    btnEntradaCompra.addEventListener('click', () => {
      populateProductSelect(entryProdSelect);
      entryForm.reset();
      modalEntryForm.style.display = 'flex';
    });
  }

  if (entryForm) {
    entryForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const prodId = parseInt(entryProdSelect.value, 10);
      const qty = parseInt(document.getElementById('entryQuantity').value, 10) || 0;
      const unitCost = parseFloat(document.getElementById('entryUnitCost').value);

      const product = inventoryList.find(p => p.id === prodId);
      if (product && qty > 0) {
        product.stock += qty;
        if (!isNaN(unitCost) && unitCost > 0) {
          product.cost = unitCost;
        }
        dataService.saveInventoryProducts(inventoryList);
        if (dataService.registerStockEntry) {
          dataService.registerStockEntry(prodId, qty, unitCost);
        }
        renderInventory();
        modalEntryForm.style.display = 'none';
        showModal('Entrada Registrada', `Se ingresaron ${qty} unidades a "${product.name}". Guardado en Kardex y Supabase. Nuevo stock: ${product.stock} uds.`);
      }
    });
  }

  if (btnCloseEntryForm) btnCloseEntryForm.addEventListener('click', () => modalEntryForm.style.display = 'none');
  if (btnCancelEntryForm) btnCancelEntryForm.addEventListener('click', () => modalEntryForm.style.display = 'none');

  function openShrinkageModal() {
    populateProductSelect(shrinkageProdSelect);
    shrinkageForm.reset();
    modalShrinkageForm.style.display = 'flex';
  }

  window.openShrinkageModal = openShrinkageModal;

  if (btnAjusteMerma) {
    btnAjusteMerma.addEventListener('click', openShrinkageModal);
  }

  if (shrinkageForm) {
    shrinkageForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const prodId = parseInt(shrinkageProdSelect.value, 10);
      const qty = parseInt(document.getElementById('shrinkageQuantity').value, 10) || 0;
      const type = document.getElementById('shrinkageType').value;

      const product = inventoryList.find(p => p.id === prodId);
      if (product && qty > 0) {
        product.stock = Math.max(0, product.stock - qty);
        dataService.saveInventoryProducts(inventoryList);
        if (dataService.registerShrinkage) {
          dataService.registerShrinkage(prodId, qty, type);
        }
        renderInventory();
        renderShrinkageTable();
        modalShrinkageForm.style.display = 'none';
        showModal('Ajuste Aplicado', `Se descontaron ${qty} unidades por [${type}] en "${product.name}". Registrado en Kardex y Supabase. Stock restante: ${product.stock} uds.`);
      }
    });
  }

  if (btnCloseShrinkageForm) btnCloseShrinkageForm.addEventListener('click', () => modalShrinkageForm.style.display = 'none');
  if (btnCancelShrinkageForm) btnCancelShrinkageForm.addEventListener('click', () => modalShrinkageForm.style.display = 'none');

  if (btnExportInventory) {
    btnExportInventory.addEventListener('click', () => {
      if (inventoryList.length === 0) {
        showModal('Inventario Vacío', 'No hay productos disponibles para exportar.');
        return;
      }

      const headers = ['Código de Barras', 'Producto', 'Categoría', 'Costo', 'Precio Venta', 'Stock Total', 'Estado'];
      const rows = inventoryList.map(p => {
        const status = p.stock <= 0 ? 'Agotado' : (p.stock <= 5 ? 'Stock Bajo' : 'Óptimo');
        return [
          p.barcode || '',
          p.name || '',
          p.category || 'Abarrotes',
          { value: Number(p.cost) || 0, currency: true },
          { value: Number(p.price) || 0, currency: true },
          Number(p.stock) || 0,
          status
        ];
      });

      if (typeof window.exportToExcel === 'function') {
        window.exportToExcel({
          filename: `inventario_${new Date().toISOString().slice(0, 10)}`,
          sheetName: 'Inventario',
          headers,
          rows
        });
      }
    });
  }

  [modalProductForm, modalEntryForm, modalShrinkageForm].forEach(modal => {
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
      });
    }
  });


  // =========================================================================
  // CONTROLADOR DE MERMAS: TABLA VISUALIZADORA Y FILTROS
  // =========================================================================
  function renderShrinkageTable() {
    const tableBody = document.getElementById('shrinkageTableBody');
    const emptyState = document.getElementById('shrinkageEmptyState');
    const filterSelect = document.getElementById('shrinkageFilterReason');
    const kpiLoss = document.getElementById('kpiShrinkageLoss');
    const kpiPieces = document.getElementById('kpiShrinkagePieces');
    const kpiCount = document.getElementById('kpiShrinkageCount');

    if (!tableBody) return;

    const history = (dataService && typeof dataService.getShrinkageHistory === 'function')
      ? dataService.getShrinkageHistory()
      : [];

    let totalLoss = 0;
    let totalPieces = 0;
    history.forEach(item => {
      const qty = Number(item.qty) || 0;
      const cost = Number(item.cost || item.unitCost || 0);
      totalLoss += (qty * cost);
      totalPieces += qty;
    });

    if (kpiLoss) kpiLoss.textContent = `${totalLoss.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (kpiPieces) kpiPieces.textContent = `${totalPieces} pzas`;
    if (kpiCount) kpiCount.textContent = `${history.length} incidentes`;

    const filterReason = filterSelect ? filterSelect.value : 'all';
    const filtered = filterReason === 'all'
      ? history
      : history.filter(item => {
          const rLower = (item.reason || '').toLowerCase();
          if (filterReason === 'expired') return rLower.includes('expir') || rLower.includes('cadu');
          if (filterReason === 'damaged') return rLower.includes('damag') || rLower.includes('dañ') || rLower.includes('rot');
          if (filterReason === 'theft') return rLower.includes('theft') || rLower.includes('fal') || rLower.includes('rob');
          if (filterReason === 'adjustment') return rLower.includes('adjust') || rLower.includes('ajus');
          return item.reason === filterReason;
        });

    tableBody.innerHTML = '';

    if (filtered.length === 0) {
      if (emptyState) emptyState.style.display = 'block';
      return;
    }
    if (emptyState) emptyState.style.display = 'none';

    filtered.forEach(item => {
      const tr = document.createElement('tr');
      const qty = Number(item.qty) || 0;
      const cost = Number(item.cost || item.unitCost || 0);
      const loss = qty * cost;

      let badgeClass = 'badge-reason-adj';
      let badgeText = 'Ajuste';
      const rLower = (item.reason || '').toLowerCase();
      if (rLower.includes('expir') || rLower.includes('cadu')) {
        badgeClass = 'badge-reason-expired';
        badgeText = 'Caducado';
      } else if (rLower.includes('damag') || rLower.includes('dañ') || rLower.includes('rot')) {
        badgeClass = 'badge-reason-damaged';
        badgeText = 'Dañado';
      } else if (rLower.includes('theft') || rLower.includes('fal') || rLower.includes('rob')) {
        badgeClass = 'badge-reason-theft';
        badgeText = 'Faltante';
      } else {
        badgeText = 'Ajuste';
      }

      tr.innerHTML = `
        <td style="font-size: 12.5px; color: #475569;">${item.date || 'Reciente'}</td>
        <td style="font-family: monospace; font-size: 12px; color: #64748b;">${item.barcode || 'N/A'}</td>
        <td style="font-weight: 600; color: #0f172a;">${item.productName || item.product || 'Producto'}</td>
        <td><span class="badge-reason ${badgeClass}">${badgeText}</span></td>
        <td><span class="qty-shrinkage-pill">-${qty} pzas</span></td>
        <td style="color: #475569;">${cost.toFixed(2)}</td>
        <td class="loss-total-cell">-${loss.toFixed(2)}</td>
        <td style="font-size: 12px; color: #64748b;">${item.cashier || 'Elena R.'}</td>
      `;
      tableBody.appendChild(tr);
    });
  }
  window.renderShrinkageTable = renderShrinkageTable;

  // Listeners de controles de merma
  const shrinkageFilterReason = document.getElementById('shrinkageFilterReason');
  if (shrinkageFilterReason) {
    shrinkageFilterReason.addEventListener('change', renderShrinkageTable);
  }
  const btnShrinkageAddNew = document.getElementById('btnShrinkageAddNew');
  if (btnShrinkageAddNew) {
    btnShrinkageAddNew.addEventListener('click', openShrinkageModal);
  }

  // =========================================================================
  // SUBNAV TABS DE INVENTARIO (CATÁLOGO vs MERMAS)
  // =========================================================================
  const tabInvCatalog = document.getElementById('tabInvCatalog');
  const tabInvShrinkage = document.getElementById('tabInvShrinkage');
  const invCatalogSection = document.getElementById('invCatalogSection');
  const invShrinkageSection = document.getElementById('invShrinkageSection');

  if (tabInvCatalog && tabInvShrinkage) {
    tabInvCatalog.addEventListener('click', () => {
      tabInvCatalog.classList.add('active');
      tabInvShrinkage.classList.remove('active');
      if (invCatalogSection) invCatalogSection.style.display = 'block';
      if (invShrinkageSection) invShrinkageSection.style.display = 'none';
    });

    tabInvShrinkage.addEventListener('click', () => {
      tabInvShrinkage.classList.add('active');
      tabInvCatalog.classList.remove('active');
      if (invCatalogSection) invCatalogSection.style.display = 'none';
      if (invShrinkageSection) invShrinkageSection.style.display = 'flex';
      renderShrinkageTable();
    });
  }

  // =========================================================================
  // MENÚ DE ACCIONES DE INVENTARIO (SOLO EXPORTAR EXCEL)
  // =========================================================================
  const btnInvDropdown = document.getElementById('btnInvDropdown');
  const invDropdownMenu = document.getElementById('invDropdownMenu');

  if (btnInvDropdown && invDropdownMenu) {
    btnInvDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = invDropdownMenu.style.display === 'block';
      invDropdownMenu.style.display = isVisible ? 'none' : 'block';
    });

    document.addEventListener('click', (e) => {
      if (!invDropdownMenu.contains(e.target) && e.target !== btnInvDropdown) {
        invDropdownMenu.style.display = 'none';
      }
    });

    document.getElementById('btnMenuExport')?.addEventListener('click', () => {
      invDropdownMenu.style.display = 'none';
      document.getElementById('btnExportInventory')?.click();
    });
  }


  function handleMobileInventoryAdd(scan) {
    const code = String(scan.barcode).trim();
    const qty = parseInt(scan.quantity, 10) || 1;
    const name = scan.name || `Producto ${code}`;
    const price = parseFloat(scan.price) || 20.00;
    const cost = parseFloat(scan.cost) || 15.00;
    const cat = scan.category || 'Abarrotes';

    let found = inventoryList.find(p => p.barcode === code || p.sku === code);
    if (found) {
      found.stock = (parseInt(found.stock, 10) || 0) + qty;
      if (price > 0) found.price = price;
      if (cost > 0) found.cost = cost;
    } else {
      found = {
        id: Date.now(),
        barcode: code,
        sku: code,
        name: name,
        displayName: name,
        category: cat,
        cost: cost,
        price: price,
        stock: qty,
        iconType: 'bread'
      };
      inventoryList.unshift(found);
    }

    if (dataService && typeof dataService.saveProduct === 'function') {
      dataService.saveProduct(found);
    }
    if (dataService && typeof dataService.saveInventoryProducts === 'function') {
      dataService.saveInventoryProducts(inventoryList);
    }

    if (typeof renderInventory === 'function') {
      renderInventory();
    }

    playPosScanBeep();
    showPosToast(`Inventario Actualizado: +${qty} pzas de ${name}`);
  }

  // Escuchar escaneos enviados en tiempo real desde el lector móvil por LAN Wi-Fi

  // Exponer funciones en window
  window.updateInventoryCounts = updateInventoryCounts;
  window.renderInventory = renderInventory;
  window.openEditProductModal = openEditProductModal;
  window.isInventoryViewActive = isInventoryViewActive;
  window.handleInventoryBarcodeScan = handleInventoryBarcodeScan;
  window.openShrinkageModal = openShrinkageModal;
  window.renderShrinkageTable = renderShrinkageTable;
  window.handleMobileInventoryAdd = handleMobileInventoryAdd;
}

window.initInventory = initInventory;
