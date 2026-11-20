/**
 * ==============================================================================
 * SUPABASE CLIENT & POS DATA LAYER (NEXUS RETAIL POS - MULTI-CAJA C1 Y C2)
 * ==============================================================================
 * Arquitectura híbrida anti-fallos y anti-race conditions:
 * 1. Servidor Local Maestro (SQLite WAL): Ambas cajas (C1 y C2) envían sus ventas y
 *    turnos a `/api/pos/...`, garantizando serialización atómica (BEGIN IMMEDIATE)
 *    y cero latencia de red en LAN.
 * 2. Nube Supabase (PostgreSQL): Respaldo en la nube programado cada 15 min (Plan Free)
 *    e inmediato al corte de caja, más fallback directo si el servidor local no responde.
 * ==============================================================================
 */

// Utilidades seguras de almacenamiento local
function safeGetStorage(key) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(key);
    }
  } catch (e) {}
  return null;
}

function safeSetStorage(key, val) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, val);
    }
  } catch (e) {}
}

// Catálogo base de referencia (utilizado como fallback mientras carga la red inicial)
const INITIAL_INVENTORY = [
  { id: 1, barcode: '7501820511234', sku: '7501820511234', name: 'Leche Lala Entera 1L', category: 'Lácteos y Cremería', cost: 22.50, price: 29.50, stock: 34, iconType: 'milk' },
  { id: 2, barcode: '750185538472', sku: '750185538472', name: 'Coca-Cola Original 600ml', category: 'Bebidas y Refrescos', cost: 14.00, price: 19.00, stock: 42, iconType: 'soda' },
  { id: 3, barcode: '750103912089', sku: '750103912089', name: 'Aceite Nutrioli 850ml', category: 'Abarrotes y Granos', cost: 36.00, price: 45.00, stock: 4, iconType: 'general' },
  { id: 4, barcode: '750188881235', sku: '750188881235', name: 'Huevo Blanco San Juan 1kg', category: 'Abarrotes y Granos', cost: 42.00, price: 52.00, stock: 15, iconType: 'egg' },
  { id: 5, barcode: '750954123456', sku: '750954123456', name: 'Pan Bimbo Blanco 680g', category: 'Panadería', cost: 28.00, price: 38.00, stock: 0, iconType: 'bread' },
  { id: 6, barcode: '750321654789', sku: '750321654789', name: 'Manzana Roja 1kg', category: 'Frutas y Verduras', cost: 25.00, price: 35.00, stock: 50, iconType: 'general' },
  { id: 7, barcode: '750741852963', sku: '750741852963', name: 'Arroz Morelos 1kg', category: 'Abarrotes y Granos', cost: 18.00, price: 26.00, stock: 3, iconType: 'general' },
  { id: 8, barcode: '750369258147', sku: '750369258147', name: 'Frijol Pinto 1kg', category: 'Abarrotes y Granos', cost: 22.00, price: 32.00, stock: 27, iconType: 'general' },
  { id: 9, barcode: '750147258369', sku: '750147258369', name: 'Sabritas Original 45g', category: 'Botanas', cost: 10.00, price: 15.00, stock: 60, iconType: 'general' },
  { id: 10, barcode: '750258369147', sku: '750258369147', name: 'Jabón Zote 200g', category: 'Limpieza e Higiene', cost: 8.00, price: 12.00, stock: 5, iconType: 'general' },
  { id: 11, barcode: '750369147258', sku: '750369147258', name: 'Papel Higiénico Suavel 4 rollos', category: 'Limpieza e Higiene', cost: 20.00, price: 32.00, stock: 18, iconType: 'general' },
  { id: 12, barcode: '750456789321', sku: '750456789321', name: 'Agua Ciel 1.5L', category: 'Bebidas y Refrescos', cost: 12.00, price: 16.00, stock: 33, iconType: 'general' }
];

const INITIAL_SALES_HISTORY = [];

let supabaseClientInstance = null;
let isSupabaseConnected = false;
let isBackendConnected = false;

// Cliente de Supabase
function initSupabaseClient() {
  if (supabaseClientInstance) return supabaseClientInstance;

  const config = (typeof window !== 'undefined' && typeof window.getAppConfig === 'function') 
    ? window.getAppConfig() 
    : {
        supabaseUrl: (typeof window !== 'undefined' && window.ENV_CONFIG && window.ENV_CONFIG.SUPABASE_URL) || safeGetStorage('POS_SUPABASE_URL') || '',
        supabaseAnonKey: (typeof window !== 'undefined' && window.ENV_CONFIG && window.ENV_CONFIG.SUPABASE_ANON_KEY) || safeGetStorage('POS_SUPABASE_ANON_KEY') || ''
      };

  let url = config.supabaseUrl || '';
  if (url.endsWith('/rest/v1')) url = url.replace('/rest/v1', '');
  if (url.endsWith('/rest/v1/')) url = url.replace('/rest/v1/', '');
  if (url.endsWith('/')) url = url.slice(0, -1);

  const key = config.supabaseAnonKey;

  if (url && key && url.includes('supabase.co')) {
    try {
      const createFn = (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function')
        ? window.supabase.createClient
        : (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function' ? supabase.createClient : null);

      if (createFn) {
        supabaseClientInstance = createFn(url, key);
        isSupabaseConnected = true;
        updateSyncIndicator(true);
        return supabaseClientInstance;
      }
    } catch (e) {
      console.warn('No se pudo inicializar cliente Supabase:', e);
    }
  }

  isSupabaseConnected = false;
  return null;
}

function updateSyncIndicator(online) {
  if (typeof document === 'undefined') return;
  const statusDot = document.querySelector('.dot-sync-green');
  const statusText = document.querySelector('.sync-status-text');
  if (statusText) {
    statusText.textContent = online ? 'En Línea' : 'Modo Local';
  }
  if (statusDot) {
    statusDot.style.backgroundColor = online ? '#10b981' : '#f59e0b';
  }
}

// Helper para llamadas al Backend Local Maestro
async function localApi(endpoint, options = {}) {
  try {
    const basePath = (typeof window !== 'undefined' && window.BACKEND_API_URL) 
      ? window.BACKEND_API_URL 
      : (typeof window !== 'undefined' && (window.location.protocol === 'file:' || (window.location.port !== '3000' && window.location.hostname === 'localhost')))
        ? 'http://localhost:3000'
        : '';
    const url = `${basePath}/api/pos${endpoint}`;
    const opts = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };
    const res = await fetch(url, opts);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      isBackendConnected = true;
      return { ok: res.ok, status: res.status, data };
    }
    isBackendConnected = true;
    return { ok: res.ok, status: res.status, data: null };
  } catch (err) {
    isBackendConnected = false;
    return { ok: false, status: 0, error: err.message, networkError: true };
  }
}
if (typeof window !== 'undefined') window.localApi = localApi;

// Inicialización de cliente Supabase
initSupabaseClient();

const PosDataService = {
  getClient() {
    if (!supabaseClientInstance) initSupabaseClient();
    return supabaseClientInstance;
  },

  isConnected() {
    return isBackendConnected || (isSupabaseConnected && !!this.getClient());
  },

  /**
   * Obtiene la lista de cajeros registrados (Local Maestro primero, fallback Supabase)
   */
  async fetchCashiers() {
    // 1. Intentar Backend Local Maestro
    const local = await localApi('/cashiers');
    if (local.ok && local.data && Array.isArray(local.data.cashiers)) {
      return local.data.cashiers.map(u => ({
        id: u.id,
        username: u.username,
        fullName: u.full_name || u.fullName,
        pin: u.pin || null
      }));
    }

    // 2. Fallback Supabase
    const client = this.getClient();
    if (client) {
      try {
        const { data, error } = await client
          .from('users')
          .select('id, username, full_name, role, pin, is_active')
          .eq('role', 'cajero')
          .eq('is_active', true)
          .order('full_name');

        if (!error && Array.isArray(data)) {
          return data.map(u => ({
            id: u.id,
            username: u.username,
            fullName: u.full_name,
            pin: u.pin || null
          }));
        }
      } catch (err) {
        console.warn('Error consultando cajeros de Supabase:', err);
      }
    }
    return [];
  },

  /**
   * Registra un nuevo cajero en el sistema
   */
  async registerCashierRemote(cashier) {
    // 1. Intentar Backend Local Maestro
    const local = await localApi('/cashiers', {
      method: 'POST',
      body: JSON.stringify({
        username: cashier.username,
        full_name: cashier.fullName || cashier.full_name,
        role: 'cajero',
        pin: cashier.pin || null
      })
    });
    if (local.ok && local.data && local.data.cashier) {
      return { success: true, user: local.data.cashier };
    }
    if (local.data && local.data.error && !local.networkError) {
      return { success: false, error: local.data.error };
    }

    // 2. Fallback Supabase
    const client = this.getClient();
    if (client) {
      try {
        const { data, error } = await client
          .from('users')
          .insert({
            username: cashier.username,
            full_name: cashier.fullName,
            role: 'cajero',
            pin: cashier.pin || null,
            is_active: true
          })
          .select();

        if (!error && data && data[0]) {
          return { success: true, user: data[0] };
        }
        if (error) {
          console.warn('Error insertando cajero en Supabase:', error.message);
          return { success: false, error: error.message };
        }
      } catch (err) {
        console.warn('Fallo de red al registrar cajero en Supabase:', err);
        return { success: false, error: err.message };
      }
    }
    return { success: true, offline: true };
  },

  /**
   * Consulta el catálogo de productos (Local Maestro primero, fallback Supabase)
   */
  async fetchProducts() {
    // 1. Intentar Backend Local Maestro
    const local = await localApi('/products');
    if (local.ok && local.data && Array.isArray(local.data.products)) {
      const formatted = local.data.products.map(p => ({
        id: p.id,
        barcode: p.barcode,
        sku: p.sku || p.barcode,
        name: p.name,
        displayName: p.display_name || p.displayName || p.name,
        category: p.category || 'General',
        cost: parseFloat(p.cost || 0),
        price: parseFloat(p.price || 0),
        stock: parseFloat(p.stock || 0),
        saleType: p.sale_type === 'bulk' || p.saleType === 'bulk' ? 'bulk' : 'unit',
        sale_type: p.sale_type === 'bulk' || p.saleType === 'bulk' ? 'bulk' : 'unit',
        unitLabel: p.unit_label || p.unitLabel || (p.sale_type === 'bulk' || p.saleType === 'bulk' ? 'kg' : 'uds'),
        iconType: p.icon_type || p.iconType || 'bread',
        promoRule: p.promo_rule || p.promoRule || null
      }));

      safeSetStorage('pos_inventory_products', JSON.stringify(formatted));
      updateSyncIndicator(true);
      return formatted;
    }

    // 2. Fallback Supabase
    const client = this.getClient();
    if (client) {
      try {
        const { data, error } = await client
          .from('products')
          .select('*')
          .eq('is_active', true)
          .order('name');

        if (!error && Array.isArray(data) && data.length > 0) {
          const formatted = data.map(p => ({
            id: p.id,
            barcode: p.barcode,
            sku: p.sku || p.barcode,
            name: p.name,
            displayName: p.display_name || p.name,
            category: p.category,
            cost: parseFloat(p.cost || 0),
            price: parseFloat(p.price || 0),
            stock: parseInt(p.stock, 10) || 0,
            iconType: p.icon_type || 'bread',
            promoRule: p.promo_rule || null
          }));

          safeSetStorage('pos_inventory_products', JSON.stringify(formatted));
          isSupabaseConnected = true;
          updateSyncIndicator(true);
          return formatted;
        }
      } catch (err) {
        console.warn('Error consultando productos de Supabase:', err);
      }
    }

    return this.getInventoryProducts();
  },

  getInventoryProducts() {
    const stored = safeGetStorage('pos_inventory_products');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch (e) {}
    }
    return JSON.parse(JSON.stringify(INITIAL_INVENTORY));
  },

  /**
   * Consulta el estado del turno para la terminal indicada (C1 o C2)
   */
  async getTerminalShift(terminalCode) {
    const code = terminalCode || (typeof window !== 'undefined' && typeof window.getActiveTerminal === 'function' ? window.getActiveTerminal().code : 'C1');

    // 1. Intentar Backend Local Maestro
    const local = await localApi(`/shift/${code}`);
    if (local.ok && local.data) {
      updateSyncIndicator(true);
      safeSetStorage(`pos_shift_${code}`, JSON.stringify(local.data));
      return local.data;
    }

    // 2. Fallback Supabase RPC
    const client = this.getClient();
    if (client) {
      try {
        const { data, error } = await client.rpc('get_terminal_shift', {
          p_terminal_code: code
        });

        if (!error && data) {
          isSupabaseConnected = true;
          updateSyncIndicator(true);
          safeSetStorage(`pos_shift_${code}`, JSON.stringify(data));
          return data;
        }
        if (error) {
          console.warn('Error RPC get_terminal_shift:', error.message);
        }
      } catch (err) {
        console.warn('Fallo de red al consultar turno de terminal:', err);
        isSupabaseConnected = false;
        updateSyncIndicator(false);
      }
    }

    // 3. Fallback de caché local si la red falla
    const cached = safeGetStorage(`pos_shift_${code}`);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }

    return { is_open: false, terminal_code: code, error: 'Sin conexión con el servidor' };
  },

  /**
   * Abre un nuevo turno en la terminal
   */
  async openTerminalShift(terminalCode, terminalName, cashierName, initialFund = 1000.00) {
    // 1. Intentar Backend Local Maestro
    const local = await localApi('/shift/open', {
      method: 'POST',
      body: JSON.stringify({
        terminal_code: terminalCode,
        initial_fund: parseFloat(initialFund) || 1000.00,
        cashier_name: cashierName || 'Cajero'
      })
    });
    if (local.ok && local.data && local.data.ok) {
      safeSetStorage(`pos_shift_${terminalCode}`, JSON.stringify({ is_open: true, shift: local.data.shift }));
      return local.data;
    }
    if (local.data && local.data.error && !local.networkError) {
      return { ok: false, error: local.data.error, errorCode: local.data.errorCode };
    }

    // 2. Fallback Supabase
    const client = this.getClient();
    if (!client) {
      return { ok: false, error: 'No hay conexión con el servidor para abrir el turno.' };
    }

    try {
      const { data, error } = await client.rpc('open_terminal_shift', {
        p_terminal_code: terminalCode,
        p_terminal_name: terminalName,
        p_cashier_name: cashierName || 'Cajero',
        p_initial_fund: parseFloat(initialFund) || 1000.00
      });

      if (error) return { ok: false, error: error.message };
      if (data && data.ok) {
        safeSetStorage(`pos_shift_${terminalCode}`, JSON.stringify({ is_open: true, shift: data.shift }));
        return data;
      }
      return data || { ok: false, error: 'Respuesta inválida al abrir turno' };
    } catch (err) {
      return { ok: false, error: 'Error de red al abrir turno: ' + err.message };
    }
  },

  /**
   * Cierra el turno activo y guarda permanentemente el corte de caja
   */
  async closeTerminalShift(terminalCode, countedCash, notes = null, cashInflows = 0, cashOutflows = 0, supplierPayouts = 0) {
    // 1. Intentar Backend Local Maestro (dispara respaldo en la nube en background)
    const local = await localApi('/shift/close', {
      method: 'POST',
      body: JSON.stringify({
        terminal_code: terminalCode,
        counted_cash: parseFloat(countedCash) || 0,
        notes: notes
      })
    });
    if (local.ok && local.data && local.data.ok) {
      safeSetStorage(`pos_shift_${terminalCode}`, JSON.stringify({ is_open: false, last_shift: local.data.shift }));
      return local.data;
    }
    if (local.data && local.data.error && !local.networkError) {
      return { ok: false, error: local.data.error, errorCode: local.data.errorCode };
    }

    // 2. Fallback Supabase
    const client = this.getClient();
    if (!client) {
      return { ok: false, error: 'No hay conexión para cerrar el turno y guardar el corte.' };
    }

    try {
      const { data, error } = await client.rpc('close_terminal_shift', {
        p_terminal_code: terminalCode,
        p_counted_cash: parseFloat(countedCash) || 0,
        p_notes: notes,
        p_cash_inflows: parseFloat(cashInflows) || 0,
        p_cash_outflows: parseFloat(cashOutflows) || 0,
        p_supplier_payouts: parseFloat(supplierPayouts) || 0
      });

      if (error) return { ok: false, error: error.message };
      if (data && data.ok) {
        safeSetStorage(`pos_shift_${terminalCode}`, JSON.stringify({ is_open: false, last_shift: data.shift }));
        return data;
      }
      return data || { ok: false, error: 'Respuesta inválida al cerrar turno' };
    } catch (err) {
      return { ok: false, error: 'Error de red al cerrar turno: ' + err.message };
    }
  },

  /**
   * Registra una venta de forma atómica:
   * Valida turno abierto, bloquea filas de producto para evitar sobreventas concurrentes,
   * valida existencias, descuenta inventario y asocia la venta al turno.
   * CERO RACE CONDITIONS garantizado por transacción SQLite WAL BEGIN IMMEDIATE en backend local.
   */
  async registerSale(salePayload, items = []) {
    const terminalInfo = (typeof window !== 'undefined' && typeof window.getActiveTerminal === 'function') 
      ? window.getActiveTerminal() 
      : { code: 'C1', name: 'Caja 1' };
    const terminalCode = salePayload.terminal_code || terminalInfo.code || 'C1';
    const terminalName = salePayload.terminal_name || terminalInfo.name || 'Caja 1';

    // Sanitizar ítems para asegurar que sólo IDs reales de la BD se envíen como numéricos
    const formattedItems = (items || []).map(it => {
      let validDbId = null;
      if (typeof it.id === 'number' && Number.isInteger(it.id) && it.id > 0 && it.id < 1000000000) {
        validDbId = it.id;
      } else if (typeof it.id === 'string' && /^\d+$/.test(it.id)) {
        const parsed = parseInt(it.id, 10);
        if (parsed > 0 && parsed < 1000000000) validDbId = parsed;
      }

      const cleanBarcode = (it.barcode || it.sku || '').toString().trim();
      const cleanSku = (it.sku || it.barcode || '').toString().trim();
      const cleanName = (it.name || it.displayName || 'Artículo').toString().trim();

      return {
        id: validDbId,
        barcode: cleanBarcode,
        sku: cleanSku,
        name: cleanName,
        unitPrice: parseFloat(it.unitPrice || it.price || 0),
        quantity: parseFloat(it.quantity) || 1,
        discount: parseFloat(it.discount || 0),
        subtotal: parseFloat(it.subtotal || ((it.unitPrice || it.price || 0) * (it.quantity || 1))),
        is_service: !!(it.is_service || it.isService),
        promo_applied: it.promoRule ? JSON.stringify(it.promoRule) : null
      };
    });

    const fullPayload = {
      folio: salePayload.folio,
      terminal_code: terminalCode,
      terminal_name: terminalName,
      cashier_name: salePayload.cashier_name || 'Cajero',
      subtotal: parseFloat(salePayload.subtotal || salePayload.total_net || 0),
      discount: parseFloat(salePayload.discount || 0),
      total_net: parseFloat(salePayload.total_net || 0),
      payment_method: salePayload.payment_method || 'cash',
      cash_received: salePayload.cash_received != null ? parseFloat(salePayload.cash_received) : null,
      cash_change: salePayload.cash_change != null ? parseFloat(salePayload.cash_change) : null,
      cash_amount: salePayload.cash_amount != null ? parseFloat(salePayload.cash_amount) : 0,
      card_amount: salePayload.card_amount != null ? parseFloat(salePayload.card_amount) : 0,
      transfer_amount: salePayload.transfer_amount != null ? parseFloat(salePayload.transfer_amount) : 0,
      items: formattedItems
    };

    // 1. RUTA PRINCIPAL: Backend Local Maestro (Transacciones atómicas WAL sin race conditions)
    const local = await localApi('/sale', {
      method: 'POST',
      body: JSON.stringify(fullPayload)
    });

    if (local.ok && local.data && local.data.success) {
      await this.fetchProducts();
      return { success: true, result: local.data.result, duplicate: false };
    }

    // Rechazo explícito de la base de datos (stock insuficiente, caja cerrada, folio duplicado, etc.)
    if (local.data && !local.networkError) {
      return {
        success: false,
        error: local.data.error || 'Venta rechazada por el servidor.',
        errorCode: local.data.errorCode || 'SALE_ERROR',
        duplicate: local.data.errorCode === 'DUPLICATE_FOLIO' || local.data.result?.duplicate === true
      };
    }

    // 2. FALLBACK SUPABASE (Solo si el servidor local no está disponible)
    const client = this.getClient();
    if (client) {
      try {
        const { data, error } = await client.rpc('register_sale_atomic', {
          p_folio: fullPayload.folio,
          p_terminal_code: fullPayload.terminal_code,
          p_terminal_name: fullPayload.terminal_name,
          p_cashier_name: fullPayload.cashier_name,
          p_subtotal: fullPayload.subtotal,
          p_discount: fullPayload.discount,
          p_total_net: fullPayload.total_net,
          p_payment_method: fullPayload.payment_method,
          p_cash_received: fullPayload.cash_received,
          p_cash_change: fullPayload.cash_change,
          p_cash_amount: fullPayload.cash_amount,
          p_card_amount: fullPayload.card_amount,
          p_transfer_amount: fullPayload.transfer_amount,
          p_items: formattedItems
        });

        if (!error && data && data.ok) {
          await this.fetchProducts();
          return { success: true, result: data, duplicate: !!data.duplicate };
        }
      } catch (err) {
        console.warn('Fallo RPC Supabase:', err.message);
      }
    }

    // 3. FALLBACK LOCAL OFFLINE SEGURO:
    // Nunca detener una venta en caja; guardar localmente y descontar stock
    try {
      const offlineSaleId = Date.now();
      const currentHistory = this.getSalesHistory();
      const offlineEntry = {
        id: offlineSaleId,
        folio: fullPayload.folio,
        date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' hrs',
        created_at: new Date().toISOString(),
        cajaCode: fullPayload.terminal_code,
        cajaName: fullPayload.terminal_name,
        cashier: fullPayload.cashier_name,
        itemsCount: fullPayload.items.length,
        items: fullPayload.items,
        paymentMethod: fullPayload.payment_method,
        cashAmount: fullPayload.cash_amount,
        cardAmount: fullPayload.card_amount,
        transferAmount: fullPayload.transfer_amount,
        cashReceived: fullPayload.cash_received,
        cashChange: fullPayload.cash_change,
        total: fullPayload.total_net,
        status: 'completed'
      };
      currentHistory.unshift(offlineEntry);
      safeSetStorage('pos_sales_history', JSON.stringify(currentHistory));

      const currentProds = this.getInventoryProducts();
      fullPayload.items.forEach(it => {
        const p = currentProds.find(cp => cp.barcode === it.barcode || cp.id === it.id);
        if (p && p.stock !== undefined) {
          p.stock = Math.max(0, p.stock - (it.quantity || 1));
        }
      });
      safeSetStorage('pos_inventory_products', JSON.stringify(currentProds));

      return {
        success: true,
        result: {
          ok: true,
          sale_id: offlineSaleId,
          folio: fullPayload.folio,
          total_net: fullPayload.total_net,
          subtotal: fullPayload.subtotal,
          discount: fullPayload.discount,
          cash_change: fullPayload.cash_change
        },
        duplicate: false,
        offline: true
      };
    } catch (fallbackErr) {
      console.error('Error en fallback local:', fallbackErr);
      return {
        success: false,
        error: 'No se pudo registrar la venta ni almacenar el respaldo local: ' + (fallbackErr.message || fallbackErr),
        errorCode: 'STORAGE_FAILED'
      };
    }
  },

  /**
   * Consulta el historial de ventas
   */
  async fetchSales(limit = 100, terminalCode = null) {
    // 1. Intentar Backend Local Maestro
    const q = `/sales?limit=${limit}${terminalCode && terminalCode !== 'all' ? `&terminal=${terminalCode}` : ''}`;
    const local = await localApi(q);
    if (local.ok && local.data && Array.isArray(local.data.sales)) {
      const formatted = local.data.sales.map(s => {
        const safeDateStr = (s.created_at || '').replace(' ', 'T');
        const dt = new Date(safeDateStr);
        const pad = (n) => String(n).padStart(2, '0');
        const timeStr = !isNaN(dt.getTime()) ? `${pad(dt.getHours())}:${pad(dt.getMinutes())} hrs` : '--:--';
        const itemsList = Array.isArray(s.items) ? s.items : [];
        const itemsSummaryText = `${s.total_pieces || itemsList.length} producto${(s.total_pieces || itemsList.length) === 1 ? '' : 's'}`;
        const itemsDetailText = itemsList.map(it => `${it.product_name || it.name} x${it.quantity}`).join(', ');

        return {
          id: s.id,
          folio: s.folio,
          date: timeStr,
          created_at: s.created_at,
          cajaCode: s.terminal_code || 'C1',
          cajaName: s.terminal_name || (s.terminal_code === 'C2' ? 'Caja 2' : 'Caja 1'),
          cashier: s.cashier_name || 'Cajero',
          itemsCount: s.total_pieces || itemsList.length,
          itemsSummary: itemsSummaryText,
          itemsDetail: itemsDetailText,
          items: itemsList.map(it => ({
            name: it.product_name || it.name,
            quantity: it.quantity,
            unitPrice: parseFloat(it.unit_price || it.unitPrice || 0),
            total: parseFloat(it.subtotal || 0)
          })),
          paymentMethod: s.payment_method,
          cashAmount: parseFloat(s.cash_amount || 0),
          cardAmount: parseFloat(s.card_amount || 0),
          transferAmount: parseFloat(s.transfer_amount || 0),
          total: parseFloat(s.total_net || 0),
          status: s.status || 'completed'
        };
      });

      const existingLocal = this.getSalesHistory();
      const map = new Map();
      formatted.forEach(f => { if (f && f.folio) map.set(f.folio, f); });
      existingLocal.forEach(loc => {
        if (loc && loc.folio && !map.has(loc.folio)) {
          map.set(loc.folio, loc);
        }
      });
      const combined = Array.from(map.values()).sort((a, b) => {
        const tA = new Date((a.created_at || '').replace(' ', 'T')).getTime() || 0;
        const tB = new Date((b.created_at || '').replace(' ', 'T')).getTime() || 0;
        return tB - tA;
      });
      safeSetStorage('pos_sales_history', JSON.stringify(combined));
      return combined;
    }

    // 2. Fallback Supabase
    const client = this.getClient();
    if (client) {
      try {
        let query = client
          .from('sales')
          .select('*, sale_items(*)')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (terminalCode && terminalCode !== 'all') {
          query = query.eq('terminal_code', terminalCode);
        }

        const { data, error } = await query;
        if (!error && Array.isArray(data)) {
          const formatted = data.map(s => {
            const safeDateStr = (s.created_at || '').replace(' ', 'T');
            const dt = new Date(safeDateStr);
            const pad = (n) => String(n).padStart(2, '0');
            const timeStr = !isNaN(dt.getTime()) ? `${pad(dt.getHours())}:${pad(dt.getMinutes())} hrs` : '--:--';
            const itemsList = Array.isArray(s.sale_items) ? s.sale_items : [];
            const itemsSummaryText = `${s.total_pieces || itemsList.length} producto${(s.total_pieces || itemsList.length) === 1 ? '' : 's'}`;
            const itemsDetailText = itemsList.map(it => `${it.product_name} x${it.quantity}`).join(', ');

            return {
              id: s.id,
              folio: s.folio,
              date: timeStr,
              created_at: s.created_at,
              cajaCode: s.terminal_code || 'C1',
              cajaName: s.terminal_name || (s.terminal_code === 'C2' ? 'Caja 2' : 'Caja 1'),
              cashier: s.cashier_name || 'Cajero',
              itemsCount: s.total_pieces || itemsList.length,
              itemsSummary: itemsSummaryText,
              itemsDetail: itemsDetailText,
              items: itemsList.map(it => ({
                name: it.product_name,
                quantity: it.quantity,
                unitPrice: parseFloat(it.unit_price || 0),
                total: parseFloat(it.subtotal || 0)
              })),
              paymentMethod: s.payment_method,
              cashAmount: parseFloat(s.cash_amount || 0),
              cardAmount: parseFloat(s.card_amount || 0),
              transferAmount: parseFloat(s.transfer_amount || 0),
              total: parseFloat(s.total_net || 0),
              status: s.status || 'completed'
            };
          });

          const existingLocal = this.getSalesHistory();
          const map = new Map();
          formatted.forEach(f => { if (f && f.folio) map.set(f.folio, f); });
          existingLocal.forEach(loc => {
            if (loc && loc.folio && !map.has(loc.folio)) {
              map.set(loc.folio, loc);
            }
          });
          const combined = Array.from(map.values()).sort((a, b) => {
            const tA = new Date((a.created_at || '').replace(' ', 'T')).getTime() || 0;
            const tB = new Date((b.created_at || '').replace(' ', 'T')).getTime() || 0;
            return tB - tA;
          });
          safeSetStorage('pos_sales_history', JSON.stringify(combined));
          return combined;
        }
      } catch (err) {
        console.warn('Error al consultar ventas de Supabase:', err);
      }
    }

    return this.getSalesHistory();
  },

  getSalesHistory() {
    const stored = safeGetStorage('pos_sales_history');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {}
    }
    return [];
  },

  localApi,

  /**
   * ==============================================================================
   * MOVIMIENTOS ECONÓMICOS (INGRESOS Y EGRESOS)
   * Responsabilidad extraída y modularizada en: www/js/cashMovements/cashMovementsClient.js
   * ==============================================================================
   */
  async fetchCashMovements(terminalCode = null) {
    const mod = (typeof CashMovementsClient !== 'undefined') ? CashMovementsClient : (typeof require !== 'undefined' ? require('./cashMovements/cashMovementsClient') : null);
    if (mod) return mod.fetchCashMovements(terminalCode, this);
    return [];
  },

  async saveCashMovement(movementPayload) {
    const mod = (typeof CashMovementsClient !== 'undefined') ? CashMovementsClient : (typeof require !== 'undefined' ? require('./cashMovements/cashMovementsClient') : null);
    if (mod) return mod.saveCashMovement(movementPayload, this);
    return { ok: false, error: 'Módulo de movimientos no disponible' };
  },

  async deleteCashMovement(id) {
    const mod = (typeof CashMovementsClient !== 'undefined') ? CashMovementsClient : (typeof require !== 'undefined' ? require('./cashMovements/cashMovementsClient') : null);
    if (mod) return mod.deleteCashMovement(id, this);
    return { ok: false, error: 'Módulo de movimientos no disponible' };
  },

  async registerCashMovement(terminalCode, movementType, amount, concept = '') {
    const mod = (typeof CashMovementsClient !== 'undefined') ? CashMovementsClient : (typeof require !== 'undefined' ? require('./cashMovements/cashMovementsClient') : null);
    if (mod) return mod.registerCashMovement(terminalCode, movementType, amount, concept, this);
    return { ok: false, error: 'Módulo de movimientos no disponible' };
  },

  /**
   * Consulta cortes de caja históricos para reportes
   */
  async fetchReports(startDate, endDate, terminalCode = 'all') {
    // 1. Intentar Backend Local Maestro
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (terminalCode) params.set('terminal', terminalCode);
    const local = await localApi(`/reports?${params.toString()}`);
    if (local.ok && local.data && local.data.ok) {
      return local.data;
    }

    // 2. Fallback Supabase
    const client = this.getClient();
    if (!client) {
      return { ok: false, error: 'Sin conexión para consultar reportes.' };
    }

    try {
      let query = client.from('cash_cuts').select('*');

      if (startDate) {
        const startIso = (startDate.includes('T')) ? startDate : `${startDate}T00:00:00.000Z`;
        query = query.gte('opened_at', startIso);
      }
      if (endDate) {
        const endIso = (endDate.includes('T')) ? endDate : `${endDate}T23:59:59.999Z`;
        query = query.lte('opened_at', endIso);
      }
      if (terminalCode && terminalCode !== 'all') {
        query = query.eq('terminal_code', terminalCode);
      }

      query = query.order('opened_at', { ascending: false });

      const { data, error } = await query;
      if (error) return { ok: false, error: error.message };

      const cuts = Array.isArray(data) ? data : [];
      let totalSalesCount = 0, totalSalesAmount = 0, totalCashSales = 0, totalCardSales = 0,
          totalTransferSales = 0, totalMixedSales = 0, totalInflows = 0, totalOutflows = 0,
          totalSupplier = 0, totalInitialFunds = 0, totalCountedCash = 0, totalExpectedCash = 0,
          totalDifference = 0;

      cuts.forEach(c => {
        totalSalesCount += parseInt(c.total_sales_count || 0, 10);
        totalSalesAmount += parseFloat(c.total_sales_amount || 0);
        totalCashSales += parseFloat(c.cash_sales || 0);
        totalCardSales += parseFloat(c.card_sales || 0);
        totalTransferSales += parseFloat(c.transfer_sales || c.qr_sales || 0);
        totalMixedSales += parseFloat(c.mixed_sales || 0);
        totalInflows += parseFloat(c.cash_inflows || 0);
        totalOutflows += parseFloat(c.cash_outflows || 0);
        totalSupplier += parseFloat(c.supplier_payouts || 0);
        totalInitialFunds += parseFloat(c.initial_fund || 0);
        totalCountedCash += parseFloat(c.counted_cash || 0);
        totalExpectedCash += parseFloat(c.expected_cash || 0);
        totalDifference += parseFloat(c.difference || 0);
      });

      return {
        ok: true,
        cuts,
        totals: {
          cutsCount: cuts.length,
          totalSalesCount,
          totalSalesAmount,
          totalCashSales,
          totalCardSales,
          totalTransferSales,
          totalMixedSales,
          totalInflows,
          totalOutflows,
          totalSupplier,
          totalInitialFunds,
          totalCountedCash,
          totalExpectedCash,
          totalDifference
        }
      };
    } catch (err) {
      return { ok: false, error: 'Error al consultar reportes: ' + err.message };
    }
  },

  /**
   * Guarda o actualiza un producto en el catálogo
   */
  async saveProduct(product) {
    // 1. Intentar Backend Local Maestro
    const local = await localApi('/product', {
      method: 'POST',
      body: JSON.stringify(product)
    });
    if (local.ok && local.data && local.data.ok) {
      await this.fetchProducts();
      return local.data.product || product;
    }

    // 2. Fallback Supabase
    const client = this.getClient();
    if (client) {
      try {
        const payload = {
          barcode: product.barcode,
          sku: product.sku || product.barcode,
          name: product.name,
          display_name: product.displayName || product.name,
          category: product.category || 'General',
          cost: parseFloat(product.cost || 0),
          price: parseFloat(product.price || 0),
          stock: parseInt(product.stock, 10) || 0,
          is_active: true
        };

        if (product.id && !isNaN(product.id)) payload.id = Number(product.id);

        const { data, error } = await client
          .from('products')
          .upsert(payload, { onConflict: 'barcode' })
          .select()
          .single();

        if (!error && data) {
          product.id = data.id;
          await this.fetchProducts();
          return product;
        }
      } catch (e) {
        console.warn('Error guardando producto en Supabase:', e);
      }
    }

    // Fallback local
    const prods = this.getInventoryProducts().filter(p => p.barcode !== product.barcode);
    prods.unshift(product);
    safeSetStorage('pos_inventory_products', JSON.stringify(prods));
    return product;
  },

  /**
   * Desactiva un producto del catálogo
   */
  async deleteProduct(productId) {
    // 1. Backend local
    await localApi('/delete-product', {
      method: 'POST',
      body: JSON.stringify({ id: productId })
    });

    // 2. Supabase fallback
    const client = this.getClient();
    if (client) {
      try {
        await client.from('products').update({ is_active: false }).eq('id', productId);
      } catch (e) {}
    }
    const products = this.getInventoryProducts().filter(p => p.id !== productId);
    safeSetStorage('pos_inventory_products', JSON.stringify(products));
  },

  saveInventoryProducts(products) {
    safeSetStorage('pos_inventory_products', JSON.stringify(products));
    return products;
  },

  /**
   * Busca producto por código de barras o SKU
   */
  async findProductByBarcode(code) {
    if (!code) return null;
    const cleanCode = code.trim().toLowerCase();

    // Buscar en inventario cargado primero
    const invList = this.getInventoryProducts();
    const invMatch = invList.find(p => 
      (p.barcode && p.barcode.toLowerCase() === cleanCode) || 
      (p.sku && p.sku.toLowerCase() === cleanCode) || 
      (p.name && p.name.toLowerCase() === cleanCode)
    );

    if (invMatch) {
      return {
        id: invMatch.id,
        sku: invMatch.barcode || invMatch.sku,
        barcode: invMatch.barcode,
        name: invMatch.name,
        displayName: invMatch.name,
        unitPrice: parseFloat(invMatch.price),
        category: invMatch.category,
        stock: invMatch.stock,
        iconType: invMatch.iconType || 'bread',
        promoRule: invMatch.promoRule || null
      };
    }

    // Consultar Supabase si no está en memoria
    const client = this.getClient();
    if (client) {
      try {
        let { data, error } = await client
          .from('products')
          .select('*')
          .eq('is_active', true)
          .or(`barcode.eq.${cleanCode},sku.eq.${cleanCode}`)
          .maybeSingle();

        if (!data) {
          const { data: nameMatch } = await client
            .from('products')
            .select('*')
            .eq('is_active', true)
            .ilike('name', `%${cleanCode}%`)
            .limit(1)
            .maybeSingle();
          data = nameMatch;
        }

        if (!error && data) {
          return {
            id: data.id,
            sku: data.sku || data.barcode,
            barcode: data.barcode,
            name: data.name,
            displayName: data.display_name || data.name,
            unitPrice: parseFloat(data.price),
            category: data.category,
            stock: data.stock,
            iconType: data.icon_type || 'bread',
            promoRule: data.promo_rule || null
          };
        }
      } catch (err) {}
    }

    // Catálogo nacional mexicano de referencia
    if (typeof window !== 'undefined' && Array.isArray(window.MEXICO_BARCODES)) {
      const mb = window.MEXICO_BARCODES.find(p => 
        (p.barcode && p.barcode.toLowerCase() === cleanCode) || 
        (p.name && p.name.toLowerCase() === cleanCode)
      );
      if (mb) {
        return {
          id: 'mb_' + mb.barcode,
          sku: mb.barcode,
          barcode: mb.barcode,
          name: mb.name,
          displayName: mb.name,
          unitPrice: parseFloat(mb.price),
          category: mb.category,
          stock: 50,
          iconType: 'bread',
          promoRule: null
        };
      }
    }

    return null;
  },

  /**
   * Búsqueda predictiva de productos en tiempo real
   */
  async searchProducts(term) {
    if (!term || !term.trim()) return [];
    const cleanTerm = term.trim().toLowerCase();
    const matches = [];

    const localList = this.getInventoryProducts() || [];
    localList.forEach(item => {
      const bcode = String(item.barcode || '').toLowerCase();
      const sku = String(item.sku || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      const cat = String(item.category || '').toLowerCase();

      if (bcode.includes(cleanTerm) || sku.includes(cleanTerm) || name.includes(cleanTerm) || cat.includes(cleanTerm)) {
        if (!matches.some(m => m.id === item.id || m.barcode === item.barcode)) {
          matches.push({
            id: item.id,
            barcode: item.barcode,
            sku: item.sku || item.barcode,
            name: item.name,
            displayName: item.displayName || item.name,
            price: parseFloat(item.price || 0),
            unitPrice: parseFloat(item.price || 0),
            category: item.category || 'General',
            stock: parseFloat(item.stock || 0),
            saleType: item.saleType || item.sale_type || 'unit',
            unitLabel: item.unitLabel || item.unit_label || 'uds',
            iconType: item.iconType || 'bread',
            promoRule: item.promoRule || null
          });
        }
      }
    });

    matches.sort((a, b) => {
      const aName = (a.name || '').toLowerCase();
      const bName = (b.name || '').toLowerCase();
      const aStarts = aName.startsWith(cleanTerm);
      const bStarts = bName.startsWith(cleanTerm);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return aName.localeCompare(bName);
    });

    return matches.slice(0, 8);
  },

  /**
   * Cancelación de venta y restitución de existencias
   */
  async cancelSale(ticketFolio, adminName = 'Administrador') {
    // 1. Backend local
    const local = await localApi('/cancel-sale', {
      method: 'POST',
      body: JSON.stringify({ folio: ticketFolio, reason: 'Cancelación autorizada en punto de venta' })
    });
    if (local.ok && local.data && local.data.ok) {
      await this.fetchProducts();
      return { ok: true, status: 'cancelled' };
    }
    if (local.data && local.data.error && !local.networkError) {
      return { ok: false, error: local.data.error };
    }

    // 2. Supabase
    const client = this.getClient();
    if (client) {
      try {
        const { error } = await client
          .from('sales')
          .update({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            cancelled_by: adminName,
            cancellation_reason: 'Cancelación autorizada en punto de venta'
          })
          .eq('folio', ticketFolio);

        if (!error) {
          await this.fetchProducts();
          return { ok: true };
        }
      } catch (err) {
        console.warn('Error cancelando venta en Supabase:', err);
      }
    }
    return { ok: false, error: 'No se pudo cancelar la venta.' };
  },

  saveSalesHistory(history) {
    safeSetStorage('pos_sales_history', JSON.stringify(history));
    return history;
  },

  // ---------------------------------------------------------------------------
  // RECEPCIÓN DE MERCANCÍA (CÓDIGOS PADRE, CFDI FACTURAS Y MERMAS)
  // ---------------------------------------------------------------------------
  async getPackages() {
    const local = await localApi('/packages');
    if (local.ok && local.data && Array.isArray(local.data.packages)) {
      return local.data.packages;
    }
    const client = this.getClient();
    if (client) {
      try {
        const { data, error } = await client
          .from('product_packages')
          .select('barcode, product_id, units, description')
          .order('created_at', { ascending: false });
        if (!error && Array.isArray(data)) return data;
      } catch (e) {}
    }
    return [];
  },

  async savePackage(pkg) {
    const local = await localApi('/package', {
      method: 'POST',
      body: JSON.stringify(pkg)
    });
    if (local.ok && local.data && local.data.ok) return { ok: true };
    if (local.data && local.data.error && !local.networkError) {
      return { ok: false, error: local.data.error };
    }
    const client = this.getClient();
    if (client) {
      try {
        const { error } = await client.from('product_packages').upsert({
          barcode: String(pkg.barcode).trim(),
          product_id: Number(pkg.product_id),
          units: parseInt(pkg.units, 10) || 1,
          description: pkg.description || null
        }, { onConflict: 'barcode' });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: 'Sin conexión' };
  },

  async deletePackage(barcode) {
    const local = await localApi(`/package/${encodeURIComponent(barcode)}`, {
      method: 'DELETE'
    });
    if (local.ok) return { ok: true };
    const client = this.getClient();
    if (client) {
      try {
        await client.from('product_packages').delete().eq('barcode', barcode);
        return { ok: true };
      } catch (e) {}
    }
    return { ok: false };
  },

  async lookupReceivingCode(code) {
    const local = await localApi(`/receiving/lookup/${encodeURIComponent(code)}`);
    if (local.ok && local.data) return local.data;
    return null;
  },

  async receiveStock(code, quantity, unitCost, source) {
    const local = await localApi('/receiving/stock', {
      method: 'POST',
      body: JSON.stringify({ code, quantity, unitCost, source })
    });
    if (local.ok && local.data) {
      await this.fetchProducts();
      return local.data;
    }
    return { ok: false, error: local.data?.error || 'Error al registrar entrada de stock' };
  },

  async isInvoiceReceived(uuid) {
    if (!uuid) return false;
    const local = await localApi(`/receiving/invoice/${encodeURIComponent(uuid)}`);
    if (local.ok && local.data) return !!local.data.received;
    const client = this.getClient();
    if (client) {
      try {
        const { data } = await client.from('supplier_invoices').select('uuid').eq('uuid', uuid).maybeSingle();
        return !!data;
      } catch (e) {}
    }
    return false;
  },

  async markInvoiceReceived(invoice) {
    if (!invoice.uuid) return;
    const client = this.getClient();
    if (client) {
      try {
        await client.from('supplier_invoices').insert([{
          uuid: invoice.uuid,
          supplier_name: invoice.supplierName,
          supplier_rfc: invoice.supplierRfc,
          folio: invoice.folio,
          total: invoice.total,
          pieces_added: invoice.piecesAdded
        }]);
      } catch (e) {}
    }
  },

  async registerShrinkage(productId, quantity, reason) {
    const local = await localApi('/shrinkage', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity, reason })
    });
    if (local.ok && local.data) {
      await this.fetchProducts();
      return local.data;
    }
    return { ok: false, error: local.data?.error || 'Error registrando merma' };
  },

  async getShrinkageHistory(limit = 100) {
    const local = await localApi(`/shrinkage?limit=${limit}`);
    if (local.ok && local.data && Array.isArray(local.data.shrinkage)) {
      return local.data.shrinkage;
    }
    return [];
  },

  async fetchShrinkage(limit = 100) {
    const local = await localApi(`/shrinkage?limit=${limit}`);
    if (local.ok && local.data && Array.isArray(local.data.shrinkage)) {
      safeSetStorage('pos_shrinkage_history', JSON.stringify(local.data.shrinkage));
      return local.data.shrinkage;
    }
    return this.getShrinkageHistory();
  },

  // ---------------------------------------------------------------------------
  // RESPALDO EN LA NUBE Y MONITOREO
  // ---------------------------------------------------------------------------
  async getBackupStatus() {
    const local = await localApi('/backup-status');
    if (local.ok && local.data) return local.data;
    return null;
  },

  async triggerCloudBackup() {
    const local = await localApi('/backup-cloud', { method: 'POST' });
    if (local.ok && local.data) return local.data;
    return { ok: false, error: local.data?.error || 'Error disparando respaldo' };
  },

  // ---------------------------------------------------------------------------
  // SINCRONIZACIÓN REACTIVA ENTRE TERMINALES (CAJA 1 Y CAJA 2)
  // ---------------------------------------------------------------------------
  startVersionPolling(callback, intervalMs = 3000) {
    let lastVersion = null;
    let failedCount = 0;
    let wasDisconnected = false;
    setInterval(async () => {
      // Si el backend local no responde, espaciar reintentos a 15s para no saturar la consola
      if (failedCount >= 2 && (Date.now() % 15000 > intervalMs)) {
        return;
      }
      try {
        const res = await localApi('/version');
        if (res.ok && res.data && res.data.version) {
          failedCount = 0;
          const reconnected = wasDisconnected;
          wasDisconnected = false;
          if (lastVersion === null || reconnected || lastVersion !== res.data.version) {
            lastVersion = res.data.version;
            if (typeof callback === 'function') callback(res.data.version);
          }
        } else {
          failedCount++;
          wasDisconnected = true;
        }
      } catch (e) {
        failedCount++;
        wasDisconnected = true;
      }
    }, intervalMs);
  },

  /**
   * Suscripción en tiempo real de Supabase como fallback
   */
  subscribeToProducts(onChange) {
    const client = this.getClient();
    if (!client || typeof client.channel !== 'function') return null;
    try {
      return client
        .channel('products-live-channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
          if (typeof onChange === 'function') onChange();
        })
        .subscribe();
    } catch (e) {
      return null;
    }
  },

  subscribeToShifts(onChange) {
    const client = this.getClient();
    if (!client || typeof client.channel !== 'function') return null;
    try {
      return client
        .channel('cash-cuts-channel')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_cuts' }, () => {
          if (typeof onChange === 'function') onChange();
        })
        .subscribe();
    } catch (e) {
      return null;
    }
  }
};

if (typeof window !== 'undefined') {
  window.PosDataService = PosDataService;
  window.INITIAL_INVENTORY = INITIAL_INVENTORY;
  window.INITIAL_SALES_HISTORY = INITIAL_SALES_HISTORY;
  window.initSupabaseClient = initSupabaseClient;

  // Iniciar sondeo LAN de versión para actualizar inventario si Caja 1 o Caja 2 venden
  PosDataService.startVersionPolling(() => {
    if (typeof window.refreshInventoryFromSupabase === 'function') {
      window.refreshInventoryFromSupabase();
    }
    if (typeof window.refreshSalesFromSupabase === 'function') {
      window.refreshSalesFromSupabase();
    }
    if (typeof window.checkShiftState === 'function') {
      window.checkShiftState();
    }
  }, 4000);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PosDataService;
}
