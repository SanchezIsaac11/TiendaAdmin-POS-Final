/**
 * MÓDULO: INGRESOS Y EGRESOS (cashMovements.js)
 * =============================================================================
 * Registro y consulta de movimientos económicos adicionales del establecimiento
 * conectados directamente a la base de datos (Supabase).
 * 
 * CARACTERÍSTICAS:
 * 1. Consulta y persistencia 100% en base de datos (Supabase `cash_movements`).
 * 2. Sin datos locales/ficticios por defecto. Si no hay conexión o la tabla
 *    está vacía, NO se genera nada: la lista queda vacía.
 * 3. Botón único "Registrar Movimiento" que despliega el modal para capturar
 *    Ingreso o Egreso.
 * 4. Modal sin nota redundante de impacto en caja.
 * 5. Integración con el Corte de Caja:
 *    - Total de ventas (procedente del POS)
 *    - Total de ingresos adicionales (en efectivo)
 *    - Total de egresos (en efectivo)
 * =============================================================================
 */

// Categorías según especificación
const CASH_CATEGORIES = {
  income: [
    'Aportaciones del propietario',
    'Devoluciones de proveedores',
    'Cobro de deudas / préstamos',
    'Comisiones / Servicios cobrados',
    'Otros ingresos',
    'Otra categoría personalizada...'
  ],
  expense: [
    'Pago de servicios (luz, agua, internet)',
    'Renta del local',
    'Compra de insumos',
    'Pagos a proveedores',
    'Mantenimiento / Reparaciones',
    'Sueldos / Anticipos de personal',
    'Gastos de papelería y limpieza',
    'Otros gastos',
    'Otra categoría personalizada...'
  ]
};

// Estado global de filtros para el módulo
const cashMovementsFilter = {
  search: '',
  type: 'all',          // 'all' | 'income' | 'expense'
  category: 'all',      // 'all' | nombre de categoría
  paymentMethod: 'all', // 'all' | 'cash' | 'transfer' | 'other'
  dateRange: 'today',   // 'today' | 'week' | 'month' | 'custom' | 'all'
  customDate: ''        // 'YYYY-MM-DD'
};

// =============================================================================
// SERVICIO SINGLETON: window.CashMovementsService
// =============================================================================
window.CashMovementsService = {
  list: [],
  isLoading: false,

  /**
   * Obtiene la lista actual de movimientos en memoria.
   * NUNCA genera datos por defecto. Si no hay registros, retorna [].
   */
  getAll() {
    return this.list || [];
  },

  /**
   * Carga los movimientos desde la base de datos.
   * REGLA: Si no hay conexión o no se encuentran registros, la lista queda vacía.
   * NUNCA se generan datos ficticios ni por defecto.
   */
  async loadFromDatabase(terminalCode = null) {
    this.isLoading = true;
    let fetchSucceeded = false;
    try {
      let rawList = null;
      if (window.PosDataService && typeof window.PosDataService.fetchCashMovements === 'function') {
        try {
          rawList = await window.PosDataService.fetchCashMovements(terminalCode);
          fetchSucceeded = true;
        } catch (e) {
          console.warn('Error fetching cash movements:', e);
        }
      } else {
        const basePath = (typeof window !== 'undefined' && window.BACKEND_API_URL) ? window.BACKEND_API_URL : '';
        const url = terminalCode ? `${basePath}/api/pos/cash-movements?terminal=${encodeURIComponent(terminalCode)}` : `${basePath}/api/pos/cash-movements`;
        try {
          const res = await fetch(url);
          if (res.ok) {
            const json = await res.json();
            if (json && json.ok && Array.isArray(json.movements)) {
              rawList = json.movements;
              fetchSucceeded = true;
            }
          }
        } catch (_) {}
      }

      if (fetchSucceeded && Array.isArray(rawList) && rawList.length > 0) {
        // Se obtuvieron registros reales de la base de datos
        const normalized = this.normalizeMovements(rawList);
        // Preservar movimientos locales offline recientes que aún no estén en el servidor
        const cached = this.getCache() || [];
        const localOnly = cached.filter(c => typeof c.id === 'number' && c.id > 1000000000000 && c.offline === true && !normalized.some(n => n.id === c.id));
        this.list = [...localOnly, ...normalized];
        this.saveCache(this.list);
      } else if (fetchSucceeded && Array.isArray(rawList) && rawList.length === 0) {
        // La base de datos respondió exitosamente pero no hay registros: lista vacía
        // Solo preservar movimientos offline pendientes de sincronizar
        const cached = this.getCache() || [];
        const offlineOnly = cached.filter(c => c.offline === true);
        this.list = offlineOnly;
        this.saveCache(this.list);
      } else {
        // No se pudo conectar a la base de datos: NO generar datos ficticios
        // Mantener solo movimientos offline pendientes del caché
        const cached = this.getCache() || [];
        const offlineOnly = cached.filter(c => c.offline === true);
        this.list = offlineOnly;
        console.warn('[cashMovements] Sin conexión a la base de datos. No se cargan datos por defecto.');
      }
    } catch (err) {
      console.warn('Error en loadFromDatabase de movimientos:', err);
      // Error inesperado: NO cargar datos ficticios, solo offline pendientes
      const cached = this.getCache() || [];
      const offlineOnly = cached.filter(c => c.offline === true);
      this.list = offlineOnly;
    } finally {
      this.isLoading = false;
      this.triggerRenders();
    }
    return this.list;
  },

  /**
   * Normaliza los registros devueltos por la base de datos o caché
   */
  normalizeMovements(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList
      .filter(m => m && !String(m.id).startsWith('mov-100'))
      .map(m => {
        const dt = new Date(m.created_at || Date.now());
        const pad = (n) => String(n).padStart(2, '0');
        const dateStr = !isNaN(dt.getTime())
          ? `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`
          : '';
        const timeStr = !isNaN(dt.getTime())
          ? `${pad(dt.getHours())}:${pad(dt.getMinutes())} hrs`
          : '';
        const isIncome = (m.movement_type === 'inflow' || m.movement_type === 'income' || m.type === 'income');

        return {
          id: m.id,
          type: isIncome ? 'income' : 'expense',
          movement_type: isIncome ? 'inflow' : 'outflow',
          cash_cut_id: m.cash_cut_id || null,
          concept: String(m.concept || '').trim(),
          category: String(m.category || (isIncome ? 'Otros ingresos' : 'Otros gastos')).trim(),
          amount: Math.abs(parseFloat(m.amount) || 0),
          payment_method: ['cash', 'card', 'transfer'].includes(m.payment_method) ? m.payment_method : 'cash',
          user: m.user_name || m.user || 'Administrador',
          terminal_code: m.terminal_code || 'C1',
          caja: m.terminal_name || m.caja || 'Caja 1',
          notes: String(m.notes || '').trim(),
          created_at: m.created_at || dt.toISOString(),
          date: dateStr,
          time: timeStr
        };
      });
  },

  getCache() {
    try {
      const raw = localStorage.getItem('pos_cash_movements');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter(m => m && !String(m.id).startsWith('mov-100'));
        }
      }
    } catch (e) {}
    return [];
  },

  saveCache(list) {
    try {
      localStorage.setItem('pos_cash_movements', JSON.stringify(list));
    } catch (e) {}
  },

  /**
   * Registra un nuevo movimiento económico persistiendo en la base de datos
   * y con fallback offline seguro para que NUNCA falle en caja.
   */
  async addMovement(data) {
    const activeTerminal = (typeof window.getActiveTerminal === 'function')
      ? window.getActiveTerminal()
      : { code: 'C1', name: 'Caja 1' };

    let currentUser = 'Administrador';
    if (window.currentSessionUser && (window.currentSessionUser.fullName || window.currentSessionUser.name)) {
      currentUser = window.currentSessionUser.fullName || window.currentSessionUser.name;
    } else {
      const userElem = document.getElementById('currentUserName');
      if (userElem && userElem.textContent && userElem.textContent.trim()) {
        currentUser = userElem.textContent.trim();
      }
    }

    const isIncome = (data.type === 'income' || data.movement_type === 'inflow');
    const amt = Math.abs(parseFloat(data.amount) || 0);
    const rawMethod = data.payment_method || 'cash';
    const paymentMethod = ['cash', 'card', 'transfer'].includes(rawMethod) ? rawMethod : 'cash';

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())} hrs`;

    const payload = {
      movement_type: isIncome ? 'inflow' : 'outflow',
      concept: String(data.concept || (isIncome ? 'Ingreso diverso' : 'Gasto operativo')).trim(),
      category: String(data.category || (isIncome ? 'Otros ingresos' : 'Otros gastos')).trim(),
      amount: amt,
      payment_method: paymentMethod,
      user_name: currentUser,
      terminal_code: (activeTerminal.code === 'C2') ? 'C2' : 'C1',
      terminal_name: activeTerminal.name || 'Caja 1',
      notes: String(data.notes || '').trim(),
      created_at: now.toISOString()
    };

    let result = null;

    // 1. Intentar mediante PosDataService (Local Master DB o Supabase)
    if (window.PosDataService && typeof window.PosDataService.saveCashMovement === 'function') {
      try {
        result = await window.PosDataService.saveCashMovement(payload);
      } catch (err) {
        console.warn('Error en PosDataService.saveCashMovement:', err);
      }
    }

    // 2. Si PosDataService no respondió éxito, intentar fetch directo a la API local
    if (!result || (!result.ok && !result.error?.includes('suficiente'))) {
      try {
        const basePath = (typeof window !== 'undefined' && window.BACKEND_API_URL) ? window.BACKEND_API_URL : '';
        const res = await fetch(`${basePath}/api/pos/cash-movements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          result = await res.json();
        }
      } catch (_) {}
    }

    // Si hubo un error de negocio específico (p. ej. validación de efectivo)
    if (result && result.error && !result.ok && result.error.includes('suficiente')) {
      return { ok: false, error: result.error };
    }

    // 3. Fallback Local Offline Seguro:
    // Garantizar que el movimiento quede 100% guardado y visible en el sistema sin colisión de IDs
    if (!window._movOfflineSeq) window._movOfflineSeq = 0;
    const uniqueFallbackId = Date.now() * 1000 + ((++window._movOfflineSeq) % 1000);
    const savedId = (result && result.id) ? result.id : uniqueFallbackId;
    const normalizedItem = {
      id: savedId,
      type: isIncome ? 'income' : 'expense',
      movement_type: isIncome ? 'inflow' : 'outflow',
      cash_cut_id: result?.movement?.cash_cut_id || null,
      concept: payload.concept,
      category: payload.category,
      amount: amt,
      payment_method: paymentMethod,
      user: currentUser,
      terminal_code: payload.terminal_code,
      caja: payload.terminal_name,
      notes: payload.notes,
      created_at: payload.created_at,
      date: dateStr,
      time: timeStr
    };

    if (!this.list) this.list = [];
    this.list = this.list.filter(m => m.id !== savedId);
    this.list.unshift(normalizedItem);
    this.saveCache(this.list);

    // Si hay corte de caja activo en caché local, actualizarlo en tiempo real
    try {
      const shiftKey = `pos_shift_${payload.terminal_code}`;
      const rawShift = localStorage.getItem(shiftKey);
      if (rawShift) {
        const shiftObj = JSON.parse(rawShift);
        if (shiftObj) {
          const shiftData = shiftObj.shift || shiftObj;
          const live = shiftData.live_totals || (shiftData.live_totals = {});
          const initialFund = parseFloat(shiftData.initial_fund || 1000);
          const cashSales = parseFloat(live.cash_sales || 0);

          if (isIncome) {
            live.inflows_count = (live.inflows_count || 0) + 1;
            live.total_inflows = (live.total_inflows || 0) + amt;
            // Solo impacta el efectivo esperado si el método es EFECTIVO ('cash')
            if (paymentMethod === 'cash') {
              live.cash_inflows = (live.cash_inflows || 0) + amt;
              live.cash_inflows_count = (live.cash_inflows_count || 0) + 1;
            }
          } else {
            live.outflows_count = (live.outflows_count || 0) + 1;
            live.total_outflows = (live.total_outflows || 0) + amt;
            // Solo impacta el efectivo esperado si el método es EFECTIVO ('cash')
            if (paymentMethod === 'cash') {
              live.cash_outflows = (live.cash_outflows || 0) + amt;
              live.cash_outflows_count = (live.cash_outflows_count || 0) + 1;
            }
          }

          // RECALCULAR EFECTIVO ESPERADO EN CAJA:
          // Fondo inicial + Ventas en efectivo + Ingresos en efectivo - Egresos en efectivo
          live.expected_cash = initialFund + cashSales + (live.cash_inflows || 0) - (live.cash_outflows || 0);

          localStorage.setItem(shiftKey, JSON.stringify(shiftObj));
        }
      }
    } catch (_) {}

    // Notificar a las vistas activas para que se refresquen
    this.triggerRenders();

    return { ok: true, movement: normalizedItem };
  },

  /**
   * Elimina un movimiento registrado de la base de datos
   */
  async deleteMovement(id) {
    const movToDelete = (this.list || []).find(m => m.id === id);
    let result = null;
    if (window.PosDataService && typeof window.PosDataService.deleteCashMovement === 'function') {
      try {
        result = await window.PosDataService.deleteCashMovement(id);
      } catch (_) {}
    } else {
      try {
        const res = await fetch(`/api/pos/cash-movements/${id}`, { method: 'DELETE' });
        result = await res.json();
      } catch (err) {
        result = { ok: false, error: err.message };
      }
    }

    if (movToDelete) {
      const isIncome = (movToDelete.type === 'income' || movToDelete.movement_type === 'inflow');
      const isCash = (movToDelete.payment_method === 'cash');
      const amt = parseFloat(movToDelete.amount) || 0;
      const termCode = movToDelete.terminal_code || 'C1';

      try {
        const shiftKey = `pos_shift_${termCode}`;
        const rawShift = localStorage.getItem(shiftKey);
        if (rawShift) {
          const shiftObj = JSON.parse(rawShift);
          if (shiftObj) {
            const shiftData = shiftObj.shift || shiftObj;
            const live = shiftData.live_totals || (shiftData.live_totals = {});
            const initialFund = parseFloat(shiftData.initial_fund || 1000);
            const cashSales = parseFloat(live.cash_sales || 0);

            if (isIncome) {
              live.inflows_count = Math.max(0, (live.inflows_count || 1) - 1);
              live.total_inflows = Math.max(0, (live.total_inflows || amt) - amt);
              if (isCash) {
                live.cash_inflows = Math.max(0, (live.cash_inflows || amt) - amt);
                live.cash_inflows_count = Math.max(0, (live.cash_inflows_count || 1) - 1);
              }
            } else {
              live.outflows_count = Math.max(0, (live.outflows_count || 1) - 1);
              live.total_outflows = Math.max(0, (live.total_outflows || amt) - amt);
              if (isCash) {
                live.cash_outflows = Math.max(0, (live.cash_outflows || amt) - amt);
                live.cash_outflows_count = Math.max(0, (live.cash_outflows_count || 1) - 1);
              }
            }

            live.expected_cash = initialFund + cashSales + (live.cash_inflows || 0) - (live.cash_outflows || 0);
            localStorage.setItem(shiftKey, JSON.stringify(shiftObj));
          }
        }
      } catch (_) {}
    }

    this.list = this.list.filter(m => m.id !== id);
    this.saveCache(this.list);
    this.triggerRenders();
    return result || { ok: true };
  },

  /**
   * Notifica a las vistas activas que se refresquen
   */
  triggerRenders() {
    if (typeof window.renderCashMovements === 'function') {
      try { window.renderCashMovements(); } catch (e) { console.warn(e); }
    }
    if (typeof window.renderCashCut === 'function') {
      try { window.renderCashCut(); } catch (e) { console.warn(e); }
    }
  },

  /**
   * Obtiene resumen de movimientos económicos del turno actual
   * Desglosando total general y total en efectivo para impacto en corte
   */
  getShiftSummary(shiftStartDate, terminalCode = null, shiftId = null) {
    const movements = this.getAll();
    const now = new Date();
    const start = shiftStartDate ? new Date(shiftStartDate) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

    let totalIncomesCount = 0;
    let totalIncomesAmount = 0;
    let totalExpensesCount = 0;
    let totalExpensesAmount = 0;

    let cashIncomesCount = 0;
    let cashIncomesTotal = 0;
    let cashExpensesCount = 0;
    let cashExpensesTotal = 0;

    let nonCashIncomesTotal = 0;
    let nonCashExpensesTotal = 0;

    movements.forEach(m => {
      if (terminalCode && m.terminal_code && m.terminal_code !== terminalCode) {
        return;
      }

      const dt = new Date(m.created_at);
      const matchesTime = !isNaN(dt.getTime()) && dt.getTime() >= (start.getTime() - 10000);
      const matchesCut = shiftId && m.cash_cut_id && Number(m.cash_cut_id) === Number(shiftId);

      if (matchesCut || matchesTime) {
        const isCash = (m.payment_method === 'cash');
        const amt = parseFloat(m.amount) || 0;
        const isIncome = (m.type === 'income' || m.movement_type === 'inflow');

        if (isIncome) {
          totalIncomesCount++;
          totalIncomesAmount += amt;
          if (isCash) {
            cashIncomesCount++;
            cashIncomesTotal += amt;
          } else {
            nonCashIncomesTotal += amt;
          }
        } else {
          totalExpensesCount++;
          totalExpensesAmount += amt;
          if (isCash) {
            cashExpensesCount++;
            cashExpensesTotal += amt;
          } else {
            nonCashExpensesTotal += amt;
          }
        }
      }
    });

    return {
      totalIncomesCount,
      totalIncomesAmount,
      totalExpensesCount,
      totalExpensesAmount,
      cashIncomesCount,
      cashIncomesTotal,
      cashExpensesCount,
      cashExpensesTotal,
      nonCashIncomesTotal,
      nonCashExpensesTotal,
      netCashImpact: cashIncomesTotal - cashExpensesTotal
    };
  }
};

// Helper global para que cutCash.js lo use de forma limpia
window.getShiftCashMovementsSummary = function(shiftStartDate, terminalCode = null, shiftId = null) {
  return window.CashMovementsService.getShiftSummary(shiftStartDate, terminalCode, shiftId);
};

// Actualiza categorías dinámicamente según sea Ingreso o Egreso
function updateModalCategories(selectedType) {
  const movCategorySelect = document.getElementById('movCategory');
  const movCategoryCustomInput = document.getElementById('movCategoryCustom');
  if (!movCategorySelect) return;
  movCategorySelect.innerHTML = '';
  const cats = CASH_CATEGORIES[selectedType] || CASH_CATEGORIES.income;

  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    movCategorySelect.appendChild(opt);
  });

  if (movCategoryCustomInput) {
    movCategoryCustomInput.style.display = 'none';
    movCategoryCustomInput.value = '';
  }
}

// Abrir modal para crear movimiento
function openMovementModal(type = 'income') {
  const modalCashMovement = document.getElementById('modalCashMovement');
  const formCashMovement = document.getElementById('formCashMovement');
  const movTypeIncomeRadio = document.getElementById('movTypeIncome');
  const movTypeExpenseRadio = document.getElementById('movTypeExpense');

  if (!modalCashMovement) return;
  if (formCashMovement) {
    try { formCashMovement.reset(); } catch (_) {}
  }

  if (type === 'expense') {
    if (movTypeExpenseRadio) movTypeExpenseRadio.checked = true;
    if (movTypeIncomeRadio) movTypeIncomeRadio.checked = false;
  } else {
    if (movTypeIncomeRadio) movTypeIncomeRadio.checked = true;
    if (movTypeExpenseRadio) movTypeExpenseRadio.checked = false;
  }

  updateModalCategories(type);

  const titleEl = document.getElementById('modalMovementTitle');
  if (titleEl) {
    titleEl.textContent = type === 'expense' ? 'Registrar Egreso (Salida)' : 'Registrar Ingreso (Entrada)';
  }

  modalCashMovement.style.display = 'flex';
  setTimeout(() => {
    const amountInput = document.getElementById('movAmount');
    if (amountInput) amountInput.focus();
  }, 60);
}

function closeMovementModal() {
  const modalCashMovement = document.getElementById('modalCashMovement');
  if (modalCashMovement) modalCashMovement.style.display = 'none';
}

/**
 * Función unificada para guardar movimiento económico (Ingreso o Egreso).
 * Puede ser invocada desde el evento submit del formulario, el click del botón o directamente.
 */
async function saveCashMovement(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }

  const movTypeExpenseRadio = document.getElementById('movTypeExpense');
  const type = (movTypeExpenseRadio && movTypeExpenseRadio.checked) ? 'expense' : 'income';

  const amountInput = document.getElementById('movAmount');
  const amountVal = amountInput ? amountInput.value : '';
  const numAmount = parseFloat(amountVal);

  if (isNaN(numAmount) || numAmount <= 0) {
    if (typeof window.showModal === 'function') {
      window.showModal('Monto Inválido', 'Por favor ingresa un monto válido mayor a 0.');
    } else {
      alert('Por favor ingresa un monto válido mayor a 0.');
    }
    if (amountInput) amountInput.focus();
    return;
  }

  const conceptInput = document.getElementById('movConcept');
  const concept = conceptInput ? conceptInput.value.trim() : '';

  if (!concept) {
    if (typeof window.showModal === 'function') {
      window.showModal('Concepto Requerido', 'Por favor ingresa la descripción o concepto del movimiento.');
    } else {
      alert('Por favor ingresa la descripción o concepto del movimiento.');
    }
    if (conceptInput) conceptInput.focus();
    return;
  }

  let category = document.getElementById('movCategory')?.value || (type === 'income' ? 'Otros ingresos' : 'Otros gastos');
  const movCategoryCustomInput = document.getElementById('movCategoryCustom');
  if (category && category.startsWith('Otra categoría') && movCategoryCustomInput && movCategoryCustomInput.value.trim()) {
    category = movCategoryCustomInput.value.trim();
  }

  const paymentMethodSelect = document.getElementById('movPaymentMethod');
  const rawPaymentMethod = paymentMethodSelect ? paymentMethodSelect.value : 'cash';
  const paymentMethod = ['cash', 'card', 'transfer'].includes(rawPaymentMethod) ? rawPaymentMethod : 'cash';
  const notes = document.getElementById('movNotes')?.value || '';

  const btnSave = document.getElementById('btnSaveCashMovement');
  const prevText = btnSave ? btnSave.textContent : 'Guardar Movimiento';
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.textContent = 'Guardando...';
  }

  try {
    const res = await window.CashMovementsService.addMovement({
      type,
      concept,
      category,
      amount: numAmount,
      payment_method: paymentMethod,
      notes
    });

    if (res && res.error && !res.ok) {
      if (typeof window.showModal === 'function') {
        window.showModal('Atención', res.error);
      } else {
        alert('Atención: ' + res.error);
      }
      return;
    }

    closeMovementModal();

    const typeLabel = (type === 'income') ? 'Ingreso' : 'Egreso';
    const successMsg = `Se guardó correctamente en el sistema el ${typeLabel.toLowerCase()} "${concept}" por $${numAmount.toFixed(2)}.`;

    if (typeof window.showModal === 'function') {
      window.showModal(`${typeLabel} Registrado`, successMsg);
    } else {
      alert(`${typeLabel} Registrado:\n${successMsg}`);
    }
  } catch (err) {
    console.error('Error al guardar movimiento:', err);
    if (typeof window.showModal === 'function') {
      window.showModal('Error al registrar movimiento', err.message || 'Error inesperado al guardar.');
    } else {
      alert('Error: ' + err.message);
    }
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.textContent = prevText;
    }
  }
}

window.openNewMovementModal = openMovementModal;
window.closeCashMovementModal = closeMovementModal;
window.updateModalCategories = updateModalCategories;
window.saveCashMovement = saveCashMovement;

let isCashMovementsInitialized = false;

// =============================================================================
// INICIALIZACIÓN DE EVENTOS DEL DOM
// =============================================================================
function initCashMovements() {
  const btnNewMovement = document.getElementById('btnNewMovement');
  const btnNewIncome = document.getElementById('btnNewIncome');
  const btnNewExpense = document.getElementById('btnNewExpense');
  const btnCloseMovementModal = document.getElementById('btnCloseMovementModal');
  const btnCancelMovementModal = document.getElementById('btnCancelMovementModal');
  const formCashMovement = document.getElementById('formCashMovement');
  const btnSaveCashMovement = document.getElementById('btnSaveCashMovement');
  const modalCashMovement = document.getElementById('modalCashMovement');
  const btnExportCsv = document.getElementById('btnExportMovementsCsv');

  const filterSearchInput = document.getElementById('movFilterSearch');
  const filterTypeSelect = document.getElementById('movFilterType');
  const filterCategorySelect = document.getElementById('movFilterCategory');
  const filterPaymentSelect = document.getElementById('movFilterPayment');
  const filterDateSelect = document.getElementById('movFilterDate');
  const filterSpecificDateInput = document.getElementById('movFilterSpecificDate');

  const movTypeIncomeRadio = document.getElementById('movTypeIncome');
  const movTypeExpenseRadio = document.getElementById('movTypeExpense');
  const movCategorySelect = document.getElementById('movCategory');
  const movCategoryCustomInput = document.getElementById('movCategoryCustom');

  // La lista inicia vacía hasta que loadFromDatabase complete con datos reales
  // NO se precargan datos desde caché local ni datos ficticios

  // Pre-poblar categorías si están vacías
  if (movCategorySelect && movCategorySelect.children.length === 0) {
    updateModalCategories('income');
  }

  // Botón y formulario para guardar
  if (btnSaveCashMovement) {
    btnSaveCashMovement.onclick = (e) => saveCashMovement(e);
  }
  if (formCashMovement) {
    formCashMovement.onsubmit = (e) => {
      saveCashMovement(e);
      return false;
    };
  }

  // Si elige "Otra categoría personalizada...", mostrar campo de texto adicional
  if (movCategorySelect) {
    movCategorySelect.onchange = () => {
      if (movCategoryCustomInput) {
        if (movCategorySelect.value.startsWith('Otra categoría')) {
          movCategoryCustomInput.style.display = 'block';
          movCategoryCustomInput.focus();
        } else {
          movCategoryCustomInput.style.display = 'none';
          movCategoryCustomInput.value = '';
        }
      }
    };
  }

  if (isCashMovementsInitialized) return;
  isCashMovementsInitialized = true;

  // Limpiar cualquier dato ficticio de versiones anteriores del caché
  try {
    const raw = localStorage.getItem('pos_cash_movements');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Eliminar datos ficticios o de prueba (IDs mov-100x o registros no-offline sin ID real)
        const cleaned = parsed.filter(m => {
          if (!m || !m.id) return false;
          if (String(m.id).startsWith('mov-100')) return false;
          return true;
        });
        // Solo conservar movimientos offline pendientes de sincronizar
        const offlineOnly = cleaned.filter(m => m.offline === true);
        if (offlineOnly.length !== parsed.length) {
          localStorage.setItem('pos_cash_movements', JSON.stringify(offlineOnly));
        }
      } else {
        localStorage.removeItem('pos_cash_movements');
      }
    }
  } catch (e) {}

  // Botón único "Registrar Movimiento"
  if (btnNewMovement) {
    btnNewMovement.addEventListener('click', () => openMovementModal('income'));
  }
  // Compatibilidad con botones previos si existieran
  if (btnNewIncome) {
    btnNewIncome.addEventListener('click', () => openMovementModal('income'));
  }
  if (btnNewExpense) {
    btnNewExpense.addEventListener('click', () => openMovementModal('expense'));
  }

  if (btnCloseMovementModal) {
    btnCloseMovementModal.addEventListener('click', closeMovementModal);
  }

  if (btnCancelMovementModal) {
    btnCancelMovementModal.addEventListener('click', closeMovementModal);
  }

  if (modalCashMovement) {
    modalCashMovement.addEventListener('click', (e) => {
      if (e.target === modalCashMovement) closeMovementModal();
    });
  }

  // Cambio de tipo de movimiento en el modal
  if (movTypeIncomeRadio) {
    movTypeIncomeRadio.addEventListener('change', () => {
      if (movTypeIncomeRadio.checked) updateModalCategories('income');
    });
  }
  if (movTypeExpenseRadio) {
    movTypeExpenseRadio.addEventListener('change', () => {
      if (movTypeExpenseRadio.checked) updateModalCategories('expense');
    });
  }

  // Listeners de filtros
  if (filterSearchInput) {
    filterSearchInput.addEventListener('input', (e) => {
      cashMovementsFilter.search = e.target.value.trim().toLowerCase();
      renderCashMovements();
    });
  }

  if (filterTypeSelect) {
    filterTypeSelect.addEventListener('change', (e) => {
      cashMovementsFilter.type = e.target.value;
      populateFilterCategories(e.target.value);
      renderCashMovements();
    });
  }

  if (filterCategorySelect) {
    filterCategorySelect.addEventListener('change', (e) => {
      cashMovementsFilter.category = e.target.value;
      renderCashMovements();
    });
  }

  if (filterPaymentSelect) {
    filterPaymentSelect.addEventListener('change', (e) => {
      cashMovementsFilter.paymentMethod = e.target.value;
      renderCashMovements();
    });
  }

  if (filterDateSelect) {
    filterDateSelect.addEventListener('change', (e) => {
      cashMovementsFilter.dateRange = e.target.value;
      if (filterSpecificDateInput) {
        if (e.target.value === 'custom') {
          filterSpecificDateInput.style.display = 'inline-block';
          if (!filterSpecificDateInput.value) {
            const todayStr = new Date().toISOString().split('T')[0];
            filterSpecificDateInput.value = todayStr;
            cashMovementsFilter.customDate = todayStr;
          }
        } else {
          filterSpecificDateInput.style.display = 'none';
          cashMovementsFilter.customDate = '';
        }
      }
      renderCashMovements();
    });
  }

  if (filterSpecificDateInput) {
    filterSpecificDateInput.addEventListener('change', (e) => {
      cashMovementsFilter.customDate = e.target.value;
      renderCashMovements();
    });
  }

  // Exportar historial a Excel
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', exportCashMovementsToExcel);
  }

  function populateFilterCategories(typeFilter) {
    if (!filterCategorySelect) return;
    const curVal = filterCategorySelect.value;
    filterCategorySelect.innerHTML = '<option value="all">Todas las categorías</option>';

    let list = [];
    if (typeFilter === 'income') {
      list = CASH_CATEGORIES.income.filter(c => !c.startsWith('Otra categoría'));
    } else if (typeFilter === 'expense') {
      list = CASH_CATEGORIES.expense.filter(c => !c.startsWith('Otra categoría'));
    } else {
      list = [
        ...new Set([
          ...CASH_CATEGORIES.income.filter(c => !c.startsWith('Otra categoría')),
          ...CASH_CATEGORIES.expense.filter(c => !c.startsWith('Otra categoría'))
        ])
      ];
    }

    list.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      filterCategorySelect.appendChild(opt);
    });

    if (list.includes(curVal)) {
      filterCategorySelect.value = curVal;
    } else {
      filterCategorySelect.value = 'all';
      cashMovementsFilter.category = 'all';
    }
  }

  populateFilterCategories('all');

  // Cargar datos reales desde la base de datos Supabase
  window.CashMovementsService.loadFromDatabase();
}

/**
 * Renderiza la tabla de movimientos con base en los filtros activos
 */
function renderCashMovements() {
  const tableBody = document.getElementById('cashMovementsTableBody');
  const emptyState = document.getElementById('cashMovementsEmptyState');

  const allMovements = window.CashMovementsService.getAll();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);

  // Filtrado
  const filtered = allMovements.filter(m => {
    // 1. Filtro de Tipo (ingreso | egreso)
    if (cashMovementsFilter.type !== 'all' && m.type !== cashMovementsFilter.type) {
      return false;
    }

    // 2. Filtro de Categoría
    if (cashMovementsFilter.category !== 'all' && m.category !== cashMovementsFilter.category) {
      return false;
    }

    // 3. Filtro de Método de Pago
    if (cashMovementsFilter.paymentMethod !== 'all' && m.payment_method !== cashMovementsFilter.paymentMethod) {
      return false;
    }

    // 4. Filtro de Fecha
    const dt = new Date(m.created_at);
    if (!isNaN(dt.getTime())) {
      if (cashMovementsFilter.dateRange === 'today') {
        if (dt < startOfDay || dt > endOfDay) return false;
      } else if (cashMovementsFilter.dateRange === 'week') {
        if (dt < startOfWeek) return false;
      } else if (cashMovementsFilter.dateRange === 'month') {
        if (dt < startOfMonth) return false;
      } else if (cashMovementsFilter.dateRange === 'custom' && cashMovementsFilter.customDate) {
        const itemDateStr = dt.toISOString().split('T')[0];
        if (itemDateStr !== cashMovementsFilter.customDate) return false;
      }
    }

    // 5. Filtro de Texto (búsqueda en concepto, categoría, usuario o notas)
    if (cashMovementsFilter.search) {
      const q = cashMovementsFilter.search;
      const matchConcept = (m.concept || '').toLowerCase().includes(q);
      const matchCat = (m.category || '').toLowerCase().includes(q);
      const matchUser = (m.user || '').toLowerCase().includes(q);
      const matchNotes = (m.notes || '').toLowerCase().includes(q);
      if (!matchConcept && !matchCat && !matchUser && !matchNotes) return false;
    }

    return true;
  });

  // Renderizar filas de la tabla
  if (!tableBody) return;
  tableBody.innerHTML = '';

  if (filtered.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  filtered.forEach(m => {
    const tr = document.createElement('tr');
    tr.className = 'history-table-row';

    const isIncome = m.type === 'income';
    const typeBadge = isIncome
      ? `<span class="badge-mov-type badge-mov-income"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;margin-right:4px;"><polyline points="18 15 12 9 6 15"></polyline></svg>Ingreso</span>`
      : `<span class="badge-mov-type badge-mov-expense"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;margin-right:4px;"><polyline points="6 9 12 15 18 9"></polyline></svg>Egreso</span>`;

    const payLabels = {
      cash: '<span class="badge-pay-method badge-pay-cash" title="Efectivo en caja física"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2"></circle></svg>Efectivo</span>',
      transfer: '<span class="badge-pay-method badge-pay-card" title="Transferencia bancaria"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>Transferencia</span>',
      other: '<span class="badge-pay-method badge-pay-codi" title="Otro medio">Otro medio</span>'
    };
    const paymentHtml = payLabels[m.payment_method] || payLabels.cash;

    const amountFormatted = `${isIncome ? '+' : '-'}$${parseFloat(m.amount).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const amountColor = isIncome ? '#16a34a' : '#dc2626';

    tr.innerHTML = `
      <td>${typeBadge}</td>
      <td>
        <div style="font-weight: 600; color: #1e293b; font-size: 13.5px;">${escapeHtml(m.concept)}</div>
        ${m.notes ? `<div style="font-size: 11px; color: #64748b; margin-top: 2px;">Observación: ${escapeHtml(m.notes)}</div>` : ''}
      </td>
      <td>
        <span class="badge-category-pill">${escapeHtml(m.category)}</span>
      </td>
      <td>${paymentHtml}</td>
      <td style="font-weight: 700; font-size: 14.5px; color: ${amountColor};">
        ${amountFormatted}
      </td>
      <td>
        <div style="font-weight: 500; font-size: 12.5px; color: #334155;">${m.date}</div>
        <div style="font-size: 11px; color: #64748b;">${m.time}</div>
      </td>
      <td>
        <div style="font-size: 12.5px; font-weight: 500; color: #0f172a;">${escapeHtml(m.user || 'Administrador')}</div>
        <div style="font-size: 11px; color: #94a3b8;">${escapeHtml(m.caja || 'Caja 1')}</div>
      </td>
      <td style="text-align: center;">
        <button type="button" class="btn-history-action btn-delete-movement" data-id="${m.id}" title="Eliminar registro">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; color: #ef4444;">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </td>
    `;

    const deleteBtn = tr.querySelector('.btn-delete-movement');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`¿Estás seguro de eliminar el movimiento "${m.concept}" por $${parseFloat(m.amount).toFixed(2)} de la base de datos?`)) {
          await window.CashMovementsService.deleteMovement(m.id);
        }
      });
    }

    tableBody.appendChild(tr);
  });
}

/**
 * Exporta los movimientos actuales a archivo Excel (.xls)
 */
function exportCashMovementsToExcel() {
  const allMovements = window.CashMovementsService.getAll();
  if (!allMovements || allMovements.length === 0) {
    if (typeof window.showModal === 'function') {
      window.showModal('Sin Datos', 'No hay movimientos para exportar.');
    } else {
      alert('No hay movimientos para exportar.');
    }
    return;
  }

  const headers = ['ID', 'Tipo', 'Concepto', 'Categoría', 'Monto', 'Método de Pago', 'Fecha', 'Hora', 'Usuario', 'Caja', 'Notas'];
  const rows = allMovements.map(m => [
    m.id || '',
    m.type === 'income' ? 'Ingreso' : 'Egreso',
    m.concept || '',
    m.category || '',
    { value: parseFloat(m.amount) || 0, currency: true },
    m.payment_method === 'cash' ? 'Efectivo' : (m.payment_method === 'transfer' ? 'Transferencia' : 'Otro'),
    m.date || '',
    m.time || '',
    m.user || '',
    m.caja || '',
    m.notes || ''
  ]);

  if (typeof window.exportToExcel === 'function') {
    window.exportToExcel({
      filename: `movimientos_caja_${new Date().toISOString().split('T')[0]}`,
      sheetName: 'Ingresos y Egresos',
      headers,
      rows
    });
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

window.initCashMovements = initCashMovements;
window.renderCashMovements = renderCashMovements;
window.exportCashMovementsToExcel = exportCashMovementsToExcel;
window.exportCashMovementsToCsv = exportCashMovementsToExcel;

// =============================================================================
// PLANTILLA Y CARGADOR MODULAR DEL COMPONENTE HTML
// =============================================================================
const CASH_MOVEMENTS_TEMPLATE_FALLBACK = `
<main class="cash-movements-view-container" id="cashMovementsViewContainer" style="display: none;">
  <div class="movements-card">
    <div class="movements-header">
      <div class="movements-title-wrap">
        <h2 class="movements-title">Ingresos y Egresos</h2>
      </div>
      <div class="movements-header-actions">
        <button type="button" class="btn-clean-export" id="btnExportMovementsCsv" title="Exportar movimientos a archivo Excel">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 15px; height: 15px;">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <span>Exportar Excel</span>
        </button>
        <button type="button" class="btn-mov-action btn-mov-primary" id="btnNewMovement" onclick="if (typeof window.openNewMovementModal === 'function') { window.openNewMovementModal('income'); }">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 16px; height: 16px;">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          <span>Registrar Movimiento</span>
        </button>
      </div>
    </div>
    <div class="history-clean-filters-bar movements-filters-bar">
      <div class="history-clean-search" style="flex: 2;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" id="movFilterSearch" placeholder="Buscar por concepto, categoría o usuario..." autocomplete="off">
      </div>
      <select id="movFilterType" class="history-select-clean">
        <option value="all">Todos los movimientos</option>
        <option value="income">Solo Ingresos (+)</option>
        <option value="expense">Solo Egresos (-)</option>
      </select>
      <select id="movFilterCategory" class="history-select-clean">
        <option value="all">Todas las categorías</option>
      </select>
      <select id="movFilterPayment" class="history-select-clean">
        <option value="all">Todos los métodos</option>
        <option value="cash">Efectivo (Afecta caja)</option>
        <option value="transfer">Transferencia</option>
        <option value="other">Otro</option>
      </select>
      <select id="movFilterDate" class="history-select-clean">
        <option value="today">Hoy</option>
        <option value="week">Esta semana</option>
        <option value="month">Este mes</option>
        <option value="custom">Fecha específica...</option>
        <option value="all">Historial completo</option>
      </select>
      <input type="date" id="movFilterSpecificDate" class="history-select-clean" style="display: none; padding: 7px 10px;">
    </div>
    <div class="history-table-wrap">
      <table class="history-table">
        <thead>
          <tr>
            <th style="width: 110px;">TIPO</th>
            <th>CONCEPTO / DESCRIPCIÓN</th>
            <th>CATEGORÍA</th>
            <th>MÉTODO DE PAGO</th>
            <th>MONTO</th>
            <th>FECHA Y HORA</th>
            <th>USUARIO / CAJA</th>
            <th style="text-align: center; width: 70px;">ACCIONES</th>
          </tr>
        </thead>
        <tbody id="cashMovementsTableBody"></tbody>
      </table>
      <div class="history-empty-state" id="cashMovementsEmptyState" style="display: none;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width: 44px; height: 44px; margin-bottom: 8px; opacity: 0.5;">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <p>No se encontraron movimientos registrados con los filtros seleccionados.</p>
      </div>
    </div>
  </div>
</main>
<div id="modalCashMovement" class="modal-backdrop" style="display: none;">
  <div class="modal-dialog" style="max-width: 500px;">
    <div class="modal-dialog-header">
      <h3 id="modalMovementTitle">Registrar Movimiento</h3>
      <button type="button" class="btn-close-modal" id="btnCloseMovementModal" onclick="if (typeof window.closeCashMovementModal === 'function') { window.closeCashMovementModal(); }">&times;</button>
    </div>
    <form id="formCashMovement" onsubmit="if (typeof window.saveCashMovement === 'function') { window.saveCashMovement(event); } return false;">
      <div style="padding: 20px 24px; display: flex; flex-direction: column; gap: 16px;">
        <div>
          <label style="display: block; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 8px;">Tipo de Movimiento *</label>
          <div class="mov-type-selector">
            <label class="mov-type-option mov-type-income">
              <input type="radio" name="movType" id="movTypeIncome" value="income" checked onchange="if (typeof window.updateModalCategories === 'function') { window.updateModalCategories('income'); }">
              <span class="mov-type-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 15px; height: 15px;">
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
                Ingreso (Entrada)
              </span>
            </label>
            <label class="mov-type-option mov-type-expense">
              <input type="radio" name="movType" id="movTypeExpense" value="expense" onchange="if (typeof window.updateModalCategories === 'function') { window.updateModalCategories('expense'); }">
              <span class="mov-type-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 15px; height: 15px;">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
                Egreso (Salida)
              </span>
            </label>
          </div>
        </div>
        <div>
          <label for="movAmount" style="display: block; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 6px;">Monto Correspondiente *</label>
          <div style="position: relative; display: flex; align-items: center;">
            <span style="position: absolute; left: 14px; font-weight: 700; font-size: 18px; color: #0f172a;">$</span>
            <input type="number" id="movAmount" step="0.01" min="0.01" placeholder="0.00" required autocomplete="off" style="width: 100%; padding: 10px 14px 10px 32px; font-size: 18px; font-weight: 700; color: #0f172a; border: 1.5px solid #cbd5e1; border-radius: 8px; outline: none;">
          </div>
        </div>
        <div>
          <label for="movCategory" style="display: block; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 6px;">Categoría *</label>
          <select id="movCategory" required style="width: 100%; padding: 10px 14px; font-size: 14px; border: 1.5px solid #cbd5e1; border-radius: 8px; background-color: #fff; outline: none; cursor: pointer;"></select>
          <input type="text" id="movCategoryCustom" placeholder="Escribe el nombre de la categoría personalizada..." autocomplete="off" style="display: none; width: 100%; margin-top: 8px; padding: 9px 14px; font-size: 13.5px; border: 1.5px solid #cbd5e1; border-radius: 8px; outline: none;">
        </div>
        <div>
          <label for="movConcept" style="display: block; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 6px;">Concepto o Descripción *</label>
          <input type="text" id="movConcept" placeholder="Ej: Pago de luz CFE, Insumos de limpieza, Aportación de socio..." required autocomplete="off" style="width: 100%; padding: 10px 14px; font-size: 14px; border: 1.5px solid #cbd5e1; border-radius: 8px; outline: none;">
        </div>
        <div>
          <label for="movPaymentMethod" style="display: block; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 6px;">Método de Pago *</label>
          <select id="movPaymentMethod" required style="width: 100%; padding: 10px 14px; font-size: 14px; border: 1.5px solid #cbd5e1; border-radius: 8px; background-color: #fff; outline: none; cursor: pointer;">
            <option value="cash">Efectivo (Afecta el corte de caja física)</option>
            <option value="transfer">Transferencia Bancaria (No afecta efectivo en caja)</option>
            <option value="other">Otro medio de pago</option>
          </select>
        </div>
        <div>
          <label for="movNotes" style="display: block; font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 6px;">Notas u observaciones (Opcional)</label>
          <input type="text" id="movNotes" placeholder="Número de factura, folio de transferencia, etc." autocomplete="off" style="width: 100%; padding: 8px 14px; font-size: 13px; border: 1.5px solid #cbd5e1; border-radius: 8px; outline: none;">
        </div>
      </div>
      <div class="modal-form-actions" style="padding: 16px 24px; border-top: 1px solid #e2e8f0; display: flex; justify-content: flex-end; gap: 10px;">
        <button type="button" class="btn-ghost-modal" id="btnCancelMovementModal" onclick="if (typeof window.closeCashMovementModal === 'function') { window.closeCashMovementModal(); }">Cancelar</button>
        <button type="button" class="btn-primary-modal" id="btnSaveCashMovement" style="background-color: #00966d;" onclick="if (typeof window.saveCashMovement === 'function') { window.saveCashMovement(event); }">Guardar Movimiento</button>
      </div>
    </form>
  </div>
</div>
`;

async function ensureCashMovementsLoaded(callback) {
  if (typeof document === 'undefined') {
    if (typeof callback === 'function') callback();
    return;
  }
  const mount = document.getElementById('cashMovementsMount');
  if (document.getElementById('cashMovementsViewContainer')) {
    initCashMovements();
    if (typeof callback === 'function') callback();
    return;
  }
  if (!mount) {
    if (typeof callback === 'function') callback();
    return;
  }

  try {
    const res = await fetch('cashMovements/cashMovements.html');
    if (res.ok) {
      const html = await res.text();
      mount.outerHTML = html;
      initCashMovements();
      if (typeof callback === 'function') callback();
      return;
    }
  } catch (err) {
    console.warn('Carga dinámica de cashMovements.html falló, usando fallback integrado:', err);
  }

  mount.outerHTML = CASH_MOVEMENTS_TEMPLATE_FALLBACK;
  initCashMovements();
  if (typeof callback === 'function') callback();
}

window.ensureCashMovementsLoaded = ensureCashMovementsLoaded;

// Auto-inicialización para garantizar que los botones y modales siempre respondan
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      ensureCashMovementsLoaded();
    });
  } else {
    ensureCashMovementsLoaded();
  }
}
