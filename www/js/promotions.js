/**
 * ==============================================================================
 * MÓDULO DE PROMOCIONES (Frontend)
 * ==============================================================================
 * Contiene dos partes:
 *   1) MOTOR: calcula el descuento de cada partida del carrito según las
 *      promociones vigentes (se usa desde calculateTotals / renderCart de app.js).
 *   2) INTERFAZ: apartado "Promociones" del menú (lista, filtros, alta/edición).
 *
 * Reglas del motor:
 *   - Solo aplica promociones activas, dentro de su fecha, día y horario.
 *   - Por cada partida se aplica ÚNICAMENTE la mejor promoción (no se acumulan).
 *   - Mantiene compatibilidad con el campo antiguo `promoRule` (tipo bundle).
 * ==============================================================================
 */
(function (root) {
  'use strict';

  var DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var CACHE_KEY = 'pos_promociones';

  // ----------------------------------------------------------------------------
  // UTILIDADES
  // ----------------------------------------------------------------------------
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function money(n) { return '$' + round2(n).toFixed(2); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function cleanCode(c) { return String(c == null ? '' : c).trim().replace(/^0+/, ''); }
  function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function todayStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtDate(s) { var p = String(s || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : s; }
  function toMinutes(hhmm) { var p = String(hhmm).split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }

  // ----------------------------------------------------------------------------
  // ESTADO
  // ----------------------------------------------------------------------------
  var state = {
    promos: [],          // todas las promociones (el motor filtra por vigencia)
    products: [],        // catálogo para selects y categorías
    categoryByCode: null // mapa código -> categoría (respaldo del carrito)
  };

  function apiBase() {
    if (root.BACKEND_API_URL) return String(root.BACKEND_API_URL).replace(/\/$/, '');
    if (root.location && (
      root.location.protocol === 'file:' ||
      root.location.protocol === 'capacitor-electron:' ||
      (root.location.hostname === 'localhost' && root.location.port !== '3000')
    )) {
      return 'http://localhost:3000';
    }
    return '';
  }

  function readCache() {
    try {
      var raw = root.localStorage && root.localStorage.getItem(CACHE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function writeCache(list) {
    try { if (root.localStorage) root.localStorage.setItem(CACHE_KEY, JSON.stringify(list)); } catch (e) {}
  }

  // ----------------------------------------------------------------------------
  // MOTOR: VIGENCIA, ALCANCE Y DESCUENTO
  // ----------------------------------------------------------------------------

  /** inactiva | vencida | programada | fuera_de_horario | vigente */
  function estado(promo, now) {
    now = now || new Date();
    if (!promo.activa) return 'inactiva';
    var hoy = todayStr(now);
    if (promo.fecha_fin && hoy > promo.fecha_fin) return 'vencida';
    if (promo.fecha_inicio && hoy < promo.fecha_inicio) return 'programada';

    if (promo.dias_semana) {
      var dias = String(promo.dias_semana).split(',').map(function (x) { return parseInt(x, 10); });
      if (dias.indexOf(now.getDay()) === -1) return 'fuera_de_horario';
    }
    if (promo.hora_inicio && promo.hora_fin) {
      var mins = now.getHours() * 60 + now.getMinutes();
      var ini = toMinutes(promo.hora_inicio);
      var fin = toMinutes(promo.hora_fin);
      var dentro = ini <= fin ? (mins >= ini && mins <= fin) : (mins >= ini || mins <= fin);
      if (!dentro) return 'fuera_de_horario';
    }
    return 'vigente';
  }

  function categoryOf(item) {
    if (item.category) return item.category;
    if (!state.categoryByCode) {
      state.categoryByCode = {};
      try {
        var raw = root.localStorage && root.localStorage.getItem('pos_inventory_products');
        var arr = raw ? JSON.parse(raw) : [];
        (arr || []).forEach(function (p) {
          if (p && p.barcode) state.categoryByCode[cleanCode(p.barcode)] = p.category || '';
        });
      } catch (e) {}
      state.products.forEach(function (p) {
        if (p && p.barcode) state.categoryByCode[cleanCode(p.barcode)] = p.category || '';
      });
    }
    return state.categoryByCode[cleanCode(item.barcode || item.sku)] || '';
  }

  function matchesScope(promo, item) {
    if (promo.alcance === 'todo') return true;
    if (promo.alcance === 'producto') {
      var target = cleanCode(promo.alcance_valor);
      return !!target && (cleanCode(item.barcode) === target || cleanCode(item.sku) === target);
    }
    if (promo.alcance === 'categoria') {
      return norm(categoryOf(item)) === norm(promo.alcance_valor);
    }
    return false;
  }

  /** Descuento en pesos de una promoción sobre una partida (precio unitario x cantidad). */
  function computeDiscount(promo, unitPrice, qty) {
    var p = parseFloat(unitPrice) || 0;
    var q = parseFloat(qty) || 0;
    if (p <= 0 || q <= 0) return 0;
    var n = parseInt(promo.cantidad, 10) || 1;
    var d = 0;

    switch (promo.tipo) {
      case 'bundle': {
        var paquetes = Math.floor(q / n);
        d = paquetes * (n * p - (parseFloat(promo.precio) || 0));
        break;
      }
      case 'nxm': {
        var m = parseInt(promo.cantidad_paga, 10) || 0;
        d = Math.floor(q / n) * (n - m) * p;
        break;
      }
      case 'percent':
        if (n <= 1 || q >= n) d = q * p * ((parseFloat(promo.porcentaje) || 0) / 100);
        break;
      case 'monto':
        if (n <= 1 || q >= n) d = q * Math.min(parseFloat(promo.precio) || 0, p);
        break;
      case 'volume': {
        var pm = parseFloat(promo.precio) || 0;
        if ((n <= 1 || q >= n) && pm > 0 && pm < p) d = q * (p - pm);
        break;
      }
      default:
        d = 0;
    }
    d = Math.min(d, q * p);
    return d > 0 ? round2(d) : 0;
  }

  /**
   * Mejor promoción para una partida del carrito.
   * Devuelve { discount, promoId, nombre, badge } o null si no hay descuento.
   */
  function evaluateItem(item, now) {
    if (!item || item.isService || item.is_service) return null;
    var unit = parseFloat(item.unitPrice != null ? item.unitPrice : item.price) || 0;
    var qty = parseFloat(item.quantity) || 0;
    var best = null;

    state.promos.forEach(function (promo) {
      if (estado(promo, now) !== 'vigente') return;
      if (!matchesScope(promo, item)) return;
      var d = computeDiscount(promo, unit, qty);
      if (d > 0 && (!best || d > best.discount)) {
        best = { discount: d, promoId: promo.id, nombre: promo.nombre, badge: promo.nombre + ' (-' + money(d) + ')' };
      }
    });

    // Compatibilidad con la regla antigua guardada en el producto (promoRule: bundle o percentage)
    var legacy = item.promoRule;
    if (typeof legacy === 'string' && legacy.trim().charAt(0) === '{') {
      try { legacy = JSON.parse(legacy); } catch (e) { legacy = null; }
    }
    if (legacy && typeof legacy === 'object') {
      var lType = legacy.type || (legacy.discount_percent != null || legacy.percentage != null ? 'percentage' : (legacy.bundle_price != null ? 'bundle' : null));
      if (lType === 'bundle' && legacy.quantity > 1) {
        var ld = computeDiscount(
          { tipo: 'bundle', cantidad: legacy.quantity, precio: legacy.bundle_price }, unit, qty
        );
        if (ld > 0 && (!best || ld > best.discount)) {
          best = {
            discount: ld, promoId: 'legacy', nombre: 'Promo ' + legacy.quantity + 'x' + money(legacy.bundle_price),
            badge: legacy.badge_text || ('Promo ' + legacy.quantity + ' por ' + money(legacy.bundle_price) + ' (-' + money(ld) + ')')
          };
        }
      } else if (lType === 'percentage' || lType === 'percent') {
        var pct = parseFloat(legacy.discount_percent != null ? legacy.discount_percent : legacy.percentage) || 0;
        var pd = computeDiscount({ tipo: 'percent', cantidad: 1, porcentaje: pct }, unit, qty);
        if (pd > 0 && (!best || pd > best.discount)) {
          best = {
            discount: pd, promoId: 'legacy', nombre: '-' + pct + '%',
            badge: legacy.badge_text || ('-' + pct + '%')
          };
        }
      }
    }
    return best;
  }

  /** Evalúa todo el carrito: { perItem: [resultado|null], totalDiscount } */
  function evaluateCart(cart, now) {
    var total = 0;
    var perItem = (cart || []).map(function (item) {
      var r = evaluateItem(item, now);
      if (r) total += r.discount;
      return r;
    });
    return { perItem: perItem, totalDiscount: round2(total) };
  }

  /** Texto corto de la regla, para la lista y la vista previa. */
  function describe(promo) {
    var n = parseInt(promo.cantidad, 10) || 1;
    var desde = n > 1 ? ' desde ' + n + ' pzas' : '';
    switch (promo.tipo) {
      case 'bundle': return 'Lleva ' + n + ' por ' + money(promo.precio);
      case 'nxm': return n + 'x' + promo.cantidad_paga + ' (lleva ' + n + ', paga ' + promo.cantidad_paga + ')';
      case 'percent': return promo.porcentaje + '% de descuento' + desde;
      case 'monto': return money(promo.precio) + ' menos por pieza' + desde;
      case 'volume': return 'Mayoreo: desde ' + n + ' pzas a ' + money(promo.precio) + ' c/u';
      default: return promo.tipo;
    }
  }

  function describeVigencia(promo) {
    var parts = [];
    if (promo.fecha_inicio && promo.fecha_fin) parts.push('Del ' + fmtDate(promo.fecha_inicio) + ' al ' + fmtDate(promo.fecha_fin));
    else if (promo.fecha_inicio) parts.push('Desde el ' + fmtDate(promo.fecha_inicio));
    else if (promo.fecha_fin) parts.push('Hasta el ' + fmtDate(promo.fecha_fin));
    if (promo.dias_semana) {
      parts.push(String(promo.dias_semana).split(',').map(function (d) { return DIAS[parseInt(d, 10)]; }).join(', '));
    }
    if (promo.hora_inicio && promo.hora_fin) parts.push(promo.hora_inicio + ' – ' + promo.hora_fin);
    return parts.length ? parts.join(' · ') : 'Siempre';
  }

  // ----------------------------------------------------------------------------
  // CARGA DE DATOS
  // ----------------------------------------------------------------------------
  function setPromotions(list) {
    state.promos = Array.isArray(list) ? list : [];
    state.categoryByCode = null;
  }

  function notifyChange() {
    try {
      if (root.dispatchEvent && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent('promotions:changed'));
      }
    } catch (e) {}
  }

  /** Descarga las promociones del servidor local (con respaldo en caché). */
  function load() {
    if (typeof root.fetch !== 'function') return Promise.resolve(state.promos);
    return root.fetch(apiBase() + '/api/promociones')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok && Array.isArray(data.promotions)) {
          setPromotions(data.promotions);
          writeCache(state.promos);
          notifyChange();
        }
        return state.promos;
      })
      .catch(function () { return state.promos; });
  }

  function loadCatalog() {
    if (typeof root.fetch !== 'function') return Promise.resolve(state.products);
    return root.fetch(apiBase() + '/api/pos/products')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok && Array.isArray(data.products)) {
          state.products = data.products;
          state.categoryByCode = null;
        }
        return state.products;
      })
      .catch(function () { return state.products; });
  }

  // Arranque: usa lo último guardado mientras llega la respuesta del servidor
  setPromotions(readCache());

  var api = {
    estado: estado,
    computeDiscount: computeDiscount,
    evaluateItem: evaluateItem,
    evaluateCart: evaluateCart,
    describe: describe,
    describeVigencia: describeVigencia,
    setPromotions: setPromotions,
    getAll: function () { return state.promos.slice(); },
    load: load
  };

  // ----------------------------------------------------------------------------
  // INTERFAZ DEL APARTADO "PROMOCIONES"
  // ----------------------------------------------------------------------------
  function initUi() {
    var doc = root.document;
    var view = doc.getElementById('promotionsViewContainer');
    if (!view) return;

    var $ = function (id) { return doc.getElementById(id); };
    var ui = { filter: 'todas', search: '' };

    var tbody = $('promoTableBody');
    var emptyBox = $('promoEmpty');
    var modal = $('modalPromoForm');
    var form = $('promoForm');
    var errBox = $('promoFormError');

    var ESTADOS = {
      vigente: { txt: 'Vigente', cls: 'promo-st-live' },
      fuera_de_horario: { txt: 'Fuera de horario', cls: 'promo-st-off-hours' },
      programada: { txt: 'Programada', cls: 'promo-st-scheduled' },
      vencida: { txt: 'Vencida', cls: 'promo-st-expired' },
      inactiva: { txt: 'Inactiva', cls: 'promo-st-inactive' }
    };

    function productName(code) {
      var t = cleanCode(code);
      var p = state.products.filter(function (x) { return cleanCode(x.barcode) === t; })[0];
      return p ? p.name : code;
    }

    function scopeText(p) {
      if (p.alcance === 'todo') return 'Toda la tienda';
      if (p.alcance === 'categoria') return 'Categoría: ' + esc(p.alcance_valor);
      return esc(productName(p.alcance_valor));
    }

    // ---- LISTA -------------------------------------------------------------
    function matchesFilter(p) {
      var st = estado(p);
      if (ui.filter === 'vigentes' && st !== 'vigente' && st !== 'fuera_de_horario') return false;
      if (ui.filter === 'programadas' && st !== 'programada') return false;
      if (ui.filter === 'vencidas' && st !== 'vencida') return false;
      if (ui.filter === 'inactivas' && st !== 'inactiva') return false;
      if (ui.search) {
        var hay = norm(p.nombre + ' ' + describe(p) + ' ' + p.alcance_valor + ' ' + productName(p.alcance_valor));
        if (hay.indexOf(norm(ui.search)) === -1) return false;
      }
      return true;
    }

    function drawKpis() {
      var c = { activas: 0, vigentes: 0, programadas: 0, vencidas: 0 };
      state.promos.forEach(function (p) {
        var st = estado(p);
        if (p.activa) c.activas++;
        if (st === 'vigente') c.vigentes++;
        if (st === 'programada') c.programadas++;
        if (st === 'vencida') c.vencidas++;
      });
      if ($('promoKpiActive')) $('promoKpiActive').textContent = c.activas;
      if ($('promoKpiLive')) $('promoKpiLive').textContent = c.vigentes;
      if ($('promoKpiScheduled')) $('promoKpiScheduled').textContent = c.programadas;
      if ($('promoKpiExpired')) $('promoKpiExpired').textContent = c.vencidas;
    }

    function draw() {
      drawKpis();
      var order = { vigente: 0, fuera_de_horario: 1, programada: 2, inactiva: 3, vencida: 4 };
      var rows = state.promos.filter(matchesFilter).sort(function (a, b) {
        return (order[estado(a)] - order[estado(b)]) || (b.id - a.id);
      });

      tbody.innerHTML = rows.map(function (p) {
        var st = ESTADOS[estado(p)];
        return '<tr data-id="' + p.id + '">' +
          '<td><div class="promo-name">' + esc(p.nombre) + '</div>' +
            '<div class="promo-sub">' + esc(describe(p)) + '</div></td>' +
          '<td>' + scopeText(p) + '</td>' +
          '<td class="promo-vig">' + esc(describeVigencia(p)) + '</td>' +
          '<td><span class="promo-status ' + st.cls + '">' + st.txt + '</span></td>' +
          '<td class="promo-actions-cell"><div class="promo-actions">' +
            '<label class="promo-switch" title="' + (p.activa ? 'Desactivar' : 'Activar') + '">' +
              '<input type="checkbox" data-action="toggle" data-id="' + p.id + '"' + (p.activa ? ' checked' : '') + '>' +
              '<span class="promo-slider"></span></label>' +
            '<button type="button" class="promo-icon-btn" data-action="edit" data-id="' + p.id + '" title="Editar">✎</button>' +
            '<button type="button" class="promo-icon-btn promo-danger" data-action="delete" data-id="' + p.id + '" title="Eliminar">🗑</button>' +
          '</div></td></tr>';
      }).join('');

      emptyBox.style.display = rows.length ? 'none' : 'block';
      emptyBox.textContent = state.promos.length
        ? 'No hay promociones con ese filtro.'
        : 'Aún no hay promociones. Crea la primera con "+ Nueva promoción".';
    }

    function refresh() {
      draw();
      return Promise.all([load(), loadCatalog()]).then(draw);
    }

    // ---- API ---------------------------------------------------------------
    function request(method, url, body) {
      return root.fetch(apiBase() + url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || !data.ok) throw new Error(data.error || 'Error del servidor');
          return data;
        });
      });
    }

    function toast(msg) {
      if (typeof root.showPosToast === 'function') root.showPosToast(msg);
      else root.alert(msg);
    }

    // ---- FORMULARIO --------------------------------------------------------
    function fillSelects() {
      var prodSel = $('promoFormProducto');
      var catSel = $('promoFormCategoria');
      var prevProd = prodSel.value;
      var prevCat = catSel.value;

      var prods = state.products.slice().sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), 'es');
      });
      prodSel.innerHTML = '<option value="">Selecciona un producto…</option>' + prods.map(function (p) {
        return '<option value="' + esc(p.barcode) + '">' + esc(p.name) + ' — ' + money(p.price) + '</option>';
      }).join('');

      var cats = {};
      ['Lácteos y Cremería', 'Bebidas y Refrescos', 'Abarrotes y Granos', 'Panadería',
        'Frutas y Verduras', 'Botanas', 'Limpieza e Higiene', 'Otros'].forEach(function (c) { cats[c] = true; });
      state.products.forEach(function (p) { if (p.category) cats[p.category] = true; });
      catSel.innerHTML = '<option value="">Selecciona una categoría…</option>' + Object.keys(cats).sort().map(function (c) {
        return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
      }).join('');

      prodSel.value = prevProd;
      catSel.value = prevCat;
    }

    function updateFormFields() {
      var tipo = $('promoFormTipo').value;
      var alcance = $('promoFormAlcance').value;

      $('promoGrpProducto').style.display = alcance === 'producto' ? '' : 'none';
      $('promoGrpCategoria').style.display = alcance === 'categoria' ? '' : 'none';

      $('promoGrpCantidad').style.display = '';
      $('promoGrpPaga').style.display = tipo === 'nxm' ? '' : 'none';
      $('promoGrpPrecio').style.display = (tipo === 'bundle' || tipo === 'monto' || tipo === 'volume') ? '' : 'none';
      $('promoGrpPorcentaje').style.display = tipo === 'percent' ? '' : 'none';

      var lblCant = { bundle: 'Piezas del paquete', nxm: 'Lleva (piezas)', percent: 'Desde (piezas)', monto: 'Desde (piezas)', volume: 'Desde (piezas)' };
      var lblPrecio = { bundle: 'Precio del paquete ($)', monto: 'Descuento por pieza ($)', volume: 'Precio por pieza ($)' };
      $('promoLblCantidad').textContent = lblCant[tipo] || 'Piezas';
      $('promoLblPrecio').textContent = lblPrecio[tipo] || 'Precio ($)';
      updatePreview();
    }

    function readForm() {
      var dias = Array.prototype.slice.call(form.querySelectorAll('.promo-day:checked'))
        .map(function (c) { return c.value; });
      var alcance = $('promoFormAlcance').value;
      return {
        nombre: $('promoFormNombre').value,
        tipo: $('promoFormTipo').value,
        alcance: alcance,
        alcance_valor: alcance === 'producto' ? $('promoFormProducto').value
          : (alcance === 'categoria' ? $('promoFormCategoria').value : ''),
        cantidad: $('promoFormCantidad').value,
        cantidad_paga: $('promoFormPaga').value,
        precio: $('promoFormPrecio').value,
        porcentaje: $('promoFormPorcentaje').value,
        fecha_inicio: $('promoFormFechaInicio').value,
        fecha_fin: $('promoFormFechaFin').value,
        dias_semana: dias,
        hora_inicio: $('promoFormHoraInicio').value,
        hora_fin: $('promoFormHoraFin').value,
        activa: $('promoFormActiva').checked
      };
    }

    function updatePreview() {
      var box = $('promoFormPreview');
      if (!box) return;
      var data = readForm();
      var prodPrice = 20;
      var sample = 'un producto de ' + money(prodPrice);
      if (data.alcance === 'producto' && data.alcance_valor) {
        var t = cleanCode(data.alcance_valor);
        var p = state.products.filter(function (x) { return cleanCode(x.barcode) === t; })[0];
        if (p && p.price > 0) { prodPrice = p.price; sample = p.name + ' (' + money(p.price) + ' c/u)'; }
      }
      var n = parseInt(data.cantidad, 10) || 1;
      var qty = Math.max(n, 1);
      var promo = {
        tipo: data.tipo, cantidad: n, cantidad_paga: parseInt(data.cantidad_paga, 10) || 0,
        precio: parseFloat(data.precio) || 0, porcentaje: parseFloat(data.porcentaje) || 0
      };
      var d = computeDiscount(promo, prodPrice, qty);
      if (d > 0) {
        box.textContent = 'Ejemplo con ' + sample + ': ' + qty + ' pzas = ' + money(qty * prodPrice - d) +
          ' en lugar de ' + money(qty * prodPrice) + ' (ahorra ' + money(d) + ').';
        box.className = 'promo-preview promo-preview-ok';
      } else {
        box.textContent = 'Completa los datos para ver un ejemplo del descuento.';
        box.className = 'promo-preview';
      }
    }

    function showError(msg) {
      errBox.textContent = msg || '';
      errBox.style.display = msg ? 'block' : 'none';
    }

    function openForm(promo) {
      form.reset();
      showError('');
      fillSelects();
      form.querySelectorAll('.promo-day').forEach(function (c) { c.checked = false; });
      $('promoFormId').value = promo ? promo.id : '';
      $('promoFormTitle').textContent = promo ? 'Editar promoción' : 'Nueva promoción';
      $('btnSavePromoForm').textContent = promo ? 'Guardar cambios' : 'Crear promoción';

      if (promo) {
        $('promoFormNombre').value = promo.nombre;
        $('promoFormTipo').value = promo.tipo;
        $('promoFormAlcance').value = promo.alcance;
        if (promo.alcance === 'producto') $('promoFormProducto').value = promo.alcance_valor;
        if (promo.alcance === 'categoria') $('promoFormCategoria').value = promo.alcance_valor;
        $('promoFormCantidad').value = promo.cantidad;
        $('promoFormPaga').value = promo.cantidad_paga || '';
        $('promoFormPrecio').value = promo.precio || '';
        $('promoFormPorcentaje').value = promo.porcentaje || '';
        $('promoFormFechaInicio').value = promo.fecha_inicio || '';
        $('promoFormFechaFin').value = promo.fecha_fin || '';
        $('promoFormHoraInicio').value = promo.hora_inicio || '';
        $('promoFormHoraFin').value = promo.hora_fin || '';
        $('promoFormActiva').checked = !!promo.activa;
        String(promo.dias_semana || '').split(',').forEach(function (d) {
          var cb = form.querySelector('.promo-day[value="' + d + '"]');
          if (cb) cb.checked = true;
        });
        // Si el producto ya no está en el catálogo, se conserva su código en la lista
        if (promo.alcance === 'producto' && $('promoFormProducto').value !== promo.alcance_valor) {
          var opt = doc.createElement('option');
          opt.value = promo.alcance_valor;
          opt.textContent = promo.alcance_valor;
          $('promoFormProducto').appendChild(opt);
          $('promoFormProducto').value = promo.alcance_valor;
        }
      } else {
        $('promoFormTipo').value = 'bundle';
        $('promoFormAlcance').value = 'producto';
        $('promoFormCantidad').value = 2;
        $('promoFormActiva').checked = true;
      }
      updateFormFields();
      modal.style.display = 'flex';
      $('promoFormNombre').focus();
    }

    function closeForm() { modal.style.display = 'none'; }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      showError('');
      var id = $('promoFormId').value;
      var body = readForm();
      var btn = $('btnSavePromoForm');
      btn.disabled = true;
      request(id ? 'PUT' : 'POST', id ? '/api/promociones/' + id : '/api/promociones', body)
        .then(function () { closeForm(); toast(id ? 'Promoción actualizada' : 'Promoción creada'); return refresh(); })
        .catch(function (err) {
          showError(err instanceof TypeError ? 'No se pudo conectar con el servidor del POS.' : err.message);
        })
        .then(function () { btn.disabled = false; });
    });

    form.addEventListener('input', updatePreview);
    form.addEventListener('change', updatePreview);
    $('promoFormTipo').addEventListener('change', updateFormFields);
    $('promoFormAlcance').addEventListener('change', updateFormFields);
    $('btnClosePromoForm').addEventListener('click', closeForm);
    $('btnCancelPromoForm').addEventListener('click', closeForm);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeForm(); });
    $('btnNuevaPromo').addEventListener('click', function () { openForm(null); });

    // ---- ACCIONES DE LA TABLA ---------------------------------------------
    function findPromo(id) {
      return state.promos.filter(function (p) { return String(p.id) === String(id); })[0];
    }

    tbody.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var action = el.getAttribute('data-action');
      var id = el.getAttribute('data-id');
      var promo = findPromo(id);
      if (!promo) return;

      if (action === 'edit') {
        openForm(promo);
      } else if (action === 'delete') {
        if (root.confirm('¿Eliminar la promoción "' + promo.nombre + '"? Esta acción no se puede deshacer.')) {
          request('DELETE', '/api/promociones/' + id)
            .then(function () { toast('Promoción eliminada'); return refresh(); })
            .catch(function (err) { root.alert(err.message); });
        }
      }
    });

    tbody.addEventListener('change', function (e) {
      var el = e.target;
      if (el.getAttribute('data-action') !== 'toggle') return;
      request('PATCH', '/api/promociones/' + el.getAttribute('data-id') + '/activa', { activa: el.checked })
        .then(refresh)
        .catch(function (err) { root.alert(err.message); refresh(); });
    });

    view.querySelectorAll('.promo-filter-pill').forEach(function (pill) {
      pill.addEventListener('click', function () {
        ui.filter = pill.getAttribute('data-filter');
        view.querySelectorAll('.promo-filter-pill').forEach(function (p) { p.classList.toggle('active', p === pill); });
        draw();
      });
    });

    $('promoSearchInput').addEventListener('input', function (e) { ui.search = e.target.value; draw(); });

    // Punto de entrada que llama app.js al abrir la vista
    root.renderPromotions = function () {
      ui.search = '';
      $('promoSearchInput').value = '';
      refresh();
      $('promoSearchInput').focus();
    };
  }

  // ----------------------------------------------------------------------------
  // ARRANQUE (solo en navegador)
  // ----------------------------------------------------------------------------
  if (typeof root.document !== 'undefined') {
    root.PosPromotions = api;
    var start = function () {
      initUi();
      load();
      // Refresca cada 5 min (por si otra caja cambia promociones o cambia el horario)
      root.setInterval(load, 5 * 60 * 1000);
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : globalThis);
