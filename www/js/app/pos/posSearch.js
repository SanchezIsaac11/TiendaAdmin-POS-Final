/**
 * SUBMÓDULO POS: BÚSQUEDA Y ESCANEO DE PRODUCTOS (posSearch.js)
 * Autocompletado predictivo, navegación por flechas, coincidencia con catálogo y búsqueda rápida
 */

function initPosSearch() {
  const escapeHtml = window.escapeHtml || function(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  const cartBarcodeInput = document.getElementById('cartBarcodeInput');

  // =========================================================================
  // AUTOCOMPLETADO PREDICTIVO: ESCANEO Y BÚSQUEDA AL ESCRIBIR UNA LETRA
  // =========================================================================
  function setupAutocomplete(inputElement, dropdownElement) {
    if (!inputElement || !dropdownElement) return;

    let selectedIndex = -1;
    let currentMatches = [];

    function closeDropdown() {
      dropdownElement.style.display = 'none';
      dropdownElement.innerHTML = '';
      selectedIndex = -1;
      currentMatches = [];
    }

    function renderMatches(matches) {
      currentMatches = matches;
      selectedIndex = -1;

      if (matches.length === 0) {
        dropdownElement.innerHTML = `
          <div class="suggestion-empty">
            No se encontraron productos coincidentes
          </div>
        `;
        dropdownElement.style.display = 'block';
        return;
      }

      dropdownElement.innerHTML = matches.map((item, idx) => {
        const isBulk = (item.saleType === 'bulk' || item.sale_type === 'bulk');
        const unitLbl = item.unitLabel || item.unit_label || (isBulk ? 'kg' : 'uds');
        const stockNum = parseFloat(item.stock) || 0;
        let stockClass = '';
        if (stockNum <= 0) stockClass = 'out';
        else if (stockNum <= 5) stockClass = 'low';

        return `
          <div class="suggestion-item" data-idx="${idx}">
            <div class="suggestion-info">
              <div class="suggestion-icon">
                ${getProductIconSvg(item.iconType || item.icon_type)}
              </div>
              <div class="suggestion-texts">
                <div class="suggestion-name">${escapeHtml(item.name || '')}</div>
                <div class="suggestion-meta">
                  <span>${escapeHtml(item.category || '')}</span>
                  <span>• ${escapeHtml(item.barcode || '')}</span>
                </div>
              </div>
            </div>
            <div class="suggestion-price-stock">
              <div class="suggestion-price">$${parseFloat(item.price || item.unit_price || item.unitPrice || 0).toFixed(2)}${isBulk ? '/kg' : ''}</div>
              <div class="suggestion-stock ${stockClass}">
                ${stockNum <= 0 ? 'Agotado' : `${isBulk ? Number(stockNum.toFixed(3)) : stockNum} ${unitLbl}`}
              </div>
            </div>
          </div>
        `;
      }).join('');

      dropdownElement.style.display = 'block';
    }

    function highlightSelected() {
      const items = dropdownElement.querySelectorAll('.suggestion-item');
      items.forEach((el, idx) => {
        if (idx === selectedIndex) {
          el.classList.add('selected');
          el.scrollIntoView({ block: 'nearest' });
        } else {
          el.classList.remove('selected');
        }
      });
    }

    inputElement.addEventListener('input', () => {
      const query = inputElement.value.trim().toLowerCase();
      if (!query) {
        closeDropdown();
        return;
      }

      const allProducts = (inventoryList && inventoryList.length > 0) ? inventoryList : (dataService.getInventoryProducts() || []);
      const matches = allProducts.filter(p => {
        const name = (p.name || '').toLowerCase();
        const code = (p.barcode || '').toLowerCase();
        const sku = (p.sku || '').toLowerCase();
        const cat = (p.category || '').toLowerCase();
        return name.includes(query) || code.includes(query) || sku.includes(query) || cat.includes(query);
      }).sort((a, b) => {
        const aName = (a.name || '').toLowerCase();
        const bName = (b.name || '').toLowerCase();
        const aStarts = aName.startsWith(query) ? 1 : 0;
        const bStarts = bName.startsWith(query) ? 1 : 0;
        return bStarts - aStarts;
      }).slice(0, 8);

      renderMatches(matches);
    });

    inputElement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = inputElement.value.trim();
        if (val) {
          // Si el usuario navegó activamente con las flechas en el menú desplegable, usar esa sugerencia
          if (selectedIndex >= 0 && currentMatches[selectedIndex]) {
            addProductToCart(currentMatches[selectedIndex]);
          } else {
            // Si viene de un escáner USB o tecleó el código directo, buscar de forma exacta
            handleProductScan(val);
          }
          inputElement.value = '';
          closeDropdown();
        }
        return;
      }

      if (dropdownElement.style.display === 'block' && currentMatches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedIndex = (selectedIndex + 1) % currentMatches.length;
          highlightSelected();
          return;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIndex = (selectedIndex - 1 + currentMatches.length) % currentMatches.length;
          highlightSelected();
          return;
        } else if (e.key === 'Escape') {
          closeDropdown();
          return;
        }
      }
    });

    dropdownElement.addEventListener('click', (e) => {
      const itemEl = e.target.closest('.suggestion-item');
      if (itemEl) {
        const idx = parseInt(itemEl.dataset.idx, 10);
        const product = currentMatches[idx];
        if (product) {
          addProductToCart(product);
          inputElement.value = '';
          closeDropdown();
          inputElement.focus();
        }
      }
    });

    document.addEventListener('click', (e) => {
      if (!inputElement.contains(e.target) && !dropdownElement.contains(e.target)) {
        closeDropdown();
      }
    });
  }

  const scanSuggestionsDropdown = document.getElementById('scanSuggestionsDropdown');
  setupAutocomplete(cartBarcodeInput, scanSuggestionsDropdown);

  const btnScannerAdd = document.getElementById('btnScannerAdd');
  if (btnScannerAdd && cartBarcodeInput) {
    btnScannerAdd.addEventListener('click', (e) => {
      e.preventDefault();
      const val = cartBarcodeInput.value.trim();
      if (val) {
        handleProductScan(val);
        cartBarcodeInput.value = '';
        if (scanSuggestionsDropdown) scanSuggestionsDropdown.style.display = 'none';
      } else {
        cartBarcodeInput.focus();
      }
    });
  }


  // Exponer setupAutocomplete en window
  window.setupAutocomplete = setupAutocomplete;
}

window.initPosSearch = initPosSearch;
