/**
 * ==============================================================================
 * BACKEND EXPRESS - PARSEO DE CFDI XML Y SINCRONIZACIÓN DE STOCK
 * ==============================================================================
 * Recibe facturas electrónicas mexicanas en formato XML (CFDI 3.3 y 4.0),
 * extrae conceptos con 'xml2js', resuelve códigos padre de empaque (cajas)
 * y actualiza el stock y los costos en tiempo real en Supabase (y local).
 * ==============================================================================
 */

const express = require('express');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const { testConnection } = require('./database/db');
const localDb = require('./database/localDb');
const inventoryController = require('./controllers/inventoryController');
const createCashMovementsRouter = require('./routes/cashMovements/cashMovementsRoutes');

// Cargar variables de entorno desde .env si existe
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
} catch (e) {}

// Inicializar la base de datos local (Master Transaccional WAL)
localDb.initLocalDatabase();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Supabase (Respaldo en la nube - cargado desde .env)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

let supabase = null;
try {
  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log(`[SUPABASE] Cliente inicializado para respaldo en: ${SUPABASE_URL}`);
  }
} catch (e) {
  console.warn('⚠️ No se pudo inicializar Supabase en backend:', e.message);
}

// Sincronización inicial bidireccional (Supabase -> SQLite local y catálogo base si está vacío)
localDb.syncStartup(supabase).then((r) => {
  console.log('[DB SYNC INICIAL]', JSON.stringify(r));
}).catch((err) => {
  console.warn('[DB SYNC INICIAL] Advertencia:', err.message);
});

// Middlewares
app.use(express.json({ limit: '15mb' }));
app.use(express.text({ type: ['text/xml', 'application/xml'], limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Servir frontend estático desde www (sin interceptar index.html en raíz)
app.use(express.static(path.join(__dirname, 'www'), { index: false }));

// CORS para pruebas locales y Electron (capacitor-electron://localhost)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Función auxiliar para extraer atributo sin importar mayúsculas/minúsculas
function getAttr(obj, name) {
  if (!obj || !obj['$']) return '';
  const dollar = obj['$'];
  if (dollar[name] !== undefined) return dollar[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(dollar)) {
    if (k.toLowerCase() === lower) return dollar[k];
  }
  return '';
}

// Búsqueda de nodo recursiva insensible a prefijos de namespace (cfdi:, tfd:, etc.)
function findNode(obj, localName) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of Object.keys(obj)) {
    const cleanKey = key.includes(':') ? key.split(':')[1] : key;
    if (cleanKey.toLowerCase() === localName.toLowerCase()) {
      return obj[key];
    }
    if (typeof obj[key] === 'object') {
      const nested = findNode(obj[key], localName);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * ENDPOINT: POST /api/cfdi
 * Recibe el XML del CFDI y procesa la entrada masiva de inventario
 */
app.post(['/api/cfdi', '/api/cfdi/parse'], async (req, res) => {
  try {
    let xmlContent = '';
    if (typeof req.body === 'string') {
      xmlContent = req.body;
    } else if (req.body && typeof req.body.xml === 'string') {
      xmlContent = req.body.xml;
    } else {
      return res.status(400).json({ ok: false, error: 'No se envió contenido XML en la petición.' });
    }

    if (!xmlContent || !xmlContent.trim()) {
      return res.status(400).json({ ok: false, error: 'El archivo XML está vacío.' });
    }

    // 1. Parseo con xml2js
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false });
    const parsed = await parser.parseStringPromise(xmlContent);

    // 2. Extraer Comprobante, Emisor, Timbre
    const compKey = Object.keys(parsed).find(k => k.toLowerCase().includes('comprobante'));
    if (!compKey) {
      return res.status(400).json({ ok: false, error: 'El archivo XML no corresponde a un Comprobante CFDI válido.' });
    }
    const comprobante = parsed[compKey];
    const emisor = findNode(comprobante, 'Emisor') || {};
    const timbre = findNode(comprobante, 'TimbreFiscalDigital') || {};

    const uuid = getAttr(timbre, 'UUID');
    const serie = getAttr(comprobante, 'Serie');
    const folioNumber = getAttr(comprobante, 'Folio');
    const folio = [serie, folioNumber].filter(Boolean).join('-') || folioNumber || 'S/F';
    const total = parseFloat(getAttr(comprobante, 'Total')) || 0;
    const supplierName = getAttr(emisor, 'Nombre') || 'Proveedor Desconocido';
    const supplierRfc = getAttr(emisor, 'Rfc') || '';

    // 3. Validar si la factura ya fue procesada antes
    if (uuid && supabase) {
      try {
        const { data: existing } = await supabase
          .from('supplier_invoices')
          .select('uuid, folio, created_at')
          .eq('uuid', uuid)
          .maybeSingle();

        if (existing) {
          return res.status(200).json({
            ok: false,
            alreadyProcessed: true,
            error: `Esta factura (UUID: ${uuid}, Folio: ${existing.folio}) ya fue registrada previamente.`
          });
        }
      } catch (err) {}
    }

    // 4. Extraer lista de conceptos
    const conceptosNode = findNode(comprobante, 'Conceptos');
    if (!conceptosNode) {
      return res.status(400).json({ ok: false, error: 'La factura no contiene el nodo de conceptos.' });
    }

    let conceptoList = findNode(conceptosNode, 'Concepto');
    if (!Array.isArray(conceptoList)) {
      conceptoList = conceptoList ? [conceptoList] : [];
    }

    const items = conceptoList.map(c => ({
      code: getAttr(c, 'NoIdentificacion').trim(),
      description: getAttr(c, 'Descripcion').trim(),
      quantity: Math.max(1, Math.round(parseFloat(getAttr(c, 'Cantidad')) || 0)),
      unitCost: parseFloat(getAttr(c, 'ValorUnitario')) || 0,
      importAmount: parseFloat(getAttr(c, 'Importe')) || 0
    }));

    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: 'No se encontraron conceptos dentro de la factura.' });
    }

    // 5. Cargar catálogo de productos y códigos de empaque (cajas)
    let dbProducts = [];
    let dbPackages = [];

    if (supabase) {
      try {
        const [prodRes, pkgRes] = await Promise.all([
          supabase.from('products').select('*'),
          supabase.from('product_packages').select('*')
        ]);
        if (prodRes.data) dbProducts = prodRes.data;
        if (pkgRes.data) dbPackages = pkgRes.data;
      } catch (e) {
        console.warn('Error leyendo catálogo de Supabase:', e.message);
      }
    }

    // Si Supabase no responde, leer del catálogo de respaldo
    if (dbProducts.length === 0) {
      dbProducts = [
        { id: 1, barcode: '7501820511234', name: 'Leche Lala Entera 1L', cost: 22.50, stock: 34 },
        { id: 2, barcode: '750185538472', name: 'Coca-Cola Original 600ml', cost: 14.00, stock: 42 },
        { id: 3, barcode: '750103912089', name: 'Aceite Nutrioli 850ml', cost: 36.00, stock: 4 },
        { id: 4, barcode: '750188881235', name: 'Huevo Blanco San Juan 1kg', cost: 42.00, stock: 15 },
        { id: 5, barcode: '750954123456', name: 'Pan Bimbo Blanco 680g', cost: 28.00, stock: 0 },
        { id: 12, barcode: '750456789321', name: 'Agua Ciel 1.5L', cost: 12.00, stock: 33 }
      ];
      dbPackages = [
        { barcode: '17501820511231', product_id: 1, units: 12, description: 'Caja Leche Lala Entera 1L (12 pzas)' },
        { barcode: '17501855384729', product_id: 2, units: 24, description: 'Caja Coca-Cola 600ml (24 pzas)' }
      ];
    }

    // 6. Cruzar conceptos de la factura con la base de datos
    let totalPiecesAdded = 0;
    const processedDetails = [];
    const notFound = [];

    for (const item of items) {
      let matchedProduct = null;
      let unitsPerItem = 1;
      let isPackage = false;

      // Paso A: ¿Es un código de pieza directo?
      matchedProduct = dbProducts.find(p => 
        (p.barcode && p.barcode.toLowerCase() === item.code.toLowerCase()) ||
        (p.sku && p.sku.toLowerCase() === item.code.toLowerCase())
      );

      // Paso B: ¿Es un código padre de caja / empaque?
      if (!matchedProduct) {
        const pkgMatch = dbPackages.find(b => b.barcode && b.barcode.toLowerCase() === item.code.toLowerCase());
        if (pkgMatch) {
          matchedProduct = dbProducts.find(p => Number(p.id) === Number(pkgMatch.product_id));
          if (matchedProduct) {
            unitsPerItem = parseInt(pkgMatch.units, 10) || 1;
            isPackage = true;
          }
        }
      }

      // Paso C: Coincidencia por nombre aproximado
      if (!matchedProduct && item.description) {
        const descClean = item.description.toLowerCase();
        matchedProduct = dbProducts.find(p => {
          const nameClean = (p.name || '').toLowerCase();
          return descClean.includes(nameClean) || nameClean.includes(descClean);
        });
      }

      if (!matchedProduct) {
        notFound.push({ code: item.code, description: item.description });
        continue;
      }

      // Calcular unidades a sumar y costo unitario real de mostrador
      const piecesToAdd = item.quantity * unitsPerItem;
      const unitCostPiece = isPackage 
        ? Math.round((item.unitCost / unitsPerItem) * 100) / 100 
        : item.unitCost;

      const previousStock = parseInt(matchedProduct.stock, 10) || 0;
      const newStock = previousStock + piecesToAdd;

      // Actualizar en memoria
      matchedProduct.stock = newStock;
      if (unitCostPiece > 0) matchedProduct.cost = unitCostPiece;
      totalPiecesAdded += piecesToAdd;

      // Actualizar en Supabase
      if (supabase) {
        try {
          await supabase
            .from('products')
            .update({ stock: newStock, cost: unitCostPiece })
            .eq('id', matchedProduct.id);

          await supabase.from('inventory_movements').insert([{
            product_id: matchedProduct.id,
            movement_type: 'purchase_entry',
            quantity: piecesToAdd,
            previous_stock: previousStock,
            new_stock: newStock,
            unit_cost: unitCostPiece,
            notes: isPackage
              ? `Entrada CFDI Factura ${folio}: ${item.quantity} caja(s) de ${unitsPerItem} pzas (${item.description})`
              : `Entrada CFDI Factura ${folio}: ${piecesToAdd} pzas (${item.description})`,
            created_by: `CFDI - ${supplierName}`.slice(0, 95)
          }]);
        } catch (err) {
          console.warn(`Error actualizando producto ${matchedProduct.id} en Supabase:`, err.message);
        }
      }

      processedDetails.push({
        code: item.code,
        description: item.description,
        productName: matchedProduct.name,
        isPackage,
        boxes: isPackage ? item.quantity : 0,
        unitsPerBox: isPackage ? unitsPerItem : 1,
        unitsAdded: piecesToAdd,
        unitCost: unitCostPiece,
        newStock
      });
    }

    // 7. Registrar factura en supplier_invoices
    if (supabase && uuid) {
      try {
        await supabase.from('supplier_invoices').insert([{
          uuid,
          supplier_name: supplierName,
          supplier_rfc: supplierRfc,
          folio,
          total,
          pieces_added: totalPiecesAdded
        }]);
      } catch (err) {}
    }

    console.log(`✅ [CFDI Parse] Factura ${folio} de "${supplierName}" procesada: +${totalPiecesAdded} piezas en ${processedDetails.length} productos.`);

    return res.status(200).json({
      ok: true,
      uuid,
      folio,
      supplier: supplierName,
      rfc: supplierRfc,
      total,
      piecesAdded: totalPiecesAdded,
      productsUpdated: processedDetails.length,
      unmatchedCount: notFound.length,
      details: processedDetails,
      unmatched: notFound
    });

  } catch (error) {
    console.error('Error procesando factura CFDI en backend:', error);
    return res.status(500).json({ ok: false, error: 'Error interno al procesar el archivo XML: ' + error.message });
  }
});

// ==============================================================================
// RUTAS: MÓDULO DE RECEPCIÓN DE INVENTARIO (MySQL + Open Food Facts API + LAN)
// ==============================================================================

// Cola en memoria de escaneos recibidos desde el celular hacia el POS
let pendingPosScans = [];

// Enviar escaneo desde el lector móvil hacia el Punto de Venta
app.post('/api/pos/scan', (req, res) => {
  const { barcode, mode = 'sale', quantity = 1, metadata = {} } = req.body || {};
  if (!barcode) {
    return res.status(400).json({ ok: false, error: 'Código de barras requerido' });
  }

  const scanEvent = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
    barcode: String(barcode).trim(),
    mode,
    quantity: parseInt(quantity, 10) || 1,
    metadata,
    timestamp: new Date().toISOString()
  };

  pendingPosScans.push(scanEvent);
  if (pendingPosScans.length > 50) pendingPosScans.shift();

  console.log(`[LAN SCAN] Código recibido desde móvil: ${scanEvent.barcode} (Modo: ${mode}, Cant: ${scanEvent.quantity})`);
  res.json({ ok: true, message: 'Código enviado al POS con éxito', scan: scanEvent });
});

// Consumir escaneos pendientes para el Punto de Venta
app.get('/api/pos/scans', (req, res) => {
  const scans = [...pendingPosScans];
  pendingPosScans = [];
  res.json({ ok: true, count: scans.length, scans });
});

// Ping de conectividad LAN para la app móvil
app.get('/api/pos/ping', (req, res) => {
  res.json({ ok: true, pos: 'online', service: 'POS Retail Server', timestamp: new Date().toISOString() });
});

// Rutas para el Punto de Venta Desktop
app.get(['/pos', '/pos.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'pos.html'));
});

// Rutas para el escáner / lector móvil
app.get(['/scanner', '/lector', '/recepcion'], (req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// Raíz inteligente: si es móvil va al lector de códigos, si es PC va al POS
app.get('/', (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  if (isMobile) {
    res.sendFile(path.join(__dirname, 'www', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'www', 'pos.html'));
  }
});

// Búsqueda: MySQL -> Open Food Facts -> Cola Offline
app.get('/api/producto/:codigo', inventoryController.buscarProducto);

// Guardar nuevo producto o actualizar desde tabla editable / celular
app.post(['/api/producto', '/api/pos/add-inventory'], (req, res, next) => {
  const barcode = req.body.codigo_barras || req.body.barcode;
  const name = req.body.nombre || req.body.name;
  const category = req.body.categoria || req.body.category || 'Abarrotes';
  const price = parseFloat(req.body.precio || req.body.precio_venta || req.body.price || 0);
  const cost = parseFloat(req.body.costo || req.body.precio_costo || req.body.cost || 0);
  const qty = parseInt(req.body.cantidad || req.body.cantidad_entrante || req.body.quantity || 1, 10);

  if (barcode) {
    const invEvent = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      mode: 'inventory_add',
      barcode: String(barcode).trim(),
      name: name || `Producto ${barcode}`,
      category,
      price,
      cost,
      quantity: qty,
      timestamp: new Date().toISOString()
    };
    pendingPosScans.push(invEvent);
    console.log(`[LAN INVENTARIO] Notificado al POS: ${invEvent.name} (+${qty} pzas)`);
  }
  next();
}, inventoryController.guardarProducto);

// Entrada rápida de stock para producto existente
app.post('/api/producto/sumar-stock', inventoryController.sumarStock);

// Cola de códigos guardados en modo offline
app.get('/api/cola-pendientes', inventoryController.obtenerColaPendientes);

// Endpoint de prueba de salud
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'online', service: 'TiendaAdmin Backend' });
});

// Configuración pública para el cliente web
app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_KEY,
    storeName: 'TIENDA ABARROTES NEXUS',
    backupIntervalMinutes: parseInt(process.env.BACKUP_INTERVAL_MINUTES || '15', 10)
  });
});

// ==============================================================================
// RUTAS POS LOCAL MASTER (ALTA VELOCIDAD Y CERO RACE CONDITIONS PARA C1 Y C2)
// ==============================================================================

// Helper para extraer usuario de la sesión o payload
function resolveRequestUser(req) {
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (token) {
    const sessionUser = localDb.getSessionUser(token);
    if (sessionUser) return sessionUser;
  }
  const body = req.body || {};
  return {
    id: body.user_id || 1,
    full_name: body.cashier_name || body.user_name || 'Cajero en Turno',
    role: body.role || 'cajero'
  };
}

// 1. Obtener productos del catálogo local maestro
app.get('/api/pos/products', (req, res) => {
  try {
    const products = localDb.getProducts();
    res.json({ ok: true, count: products.length, products });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. Guardar o actualizar producto en local maestro
app.post(['/api/pos/product', '/api/pos/save-product'], (req, res) => {
  try {
    const user = resolveRequestUser(req);
    const saved = localDb.saveProduct(req.body, user.full_name);
    res.json({ ok: true, product: saved });
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 3. Eliminar producto
app.post('/api/pos/delete-product', (req, res) => {
  try {
    const { id } = req.body || {};
    localDb.deleteProduct(id);
    res.json({ ok: true });
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 4. Procesar venta atómica en SQLite (SIN RACE CONDITIONS, VALIDA STOCK Y LIMITES)
app.post('/api/pos/sale', (req, res) => {
  try {
    const user = resolveRequestUser(req);
    const payload = req.body || {};
    const items = payload.items || payload.cart || [];
    
    const result = localDb.processSale({
      ...payload,
      items
    }, user);

    res.json({ success: true, ok: true, result });
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    console.warn(`[VENTA RECHAZADA] ${err.code || 'ERROR'}: ${err.message}`);
    res.status(status).json({
      success: false,
      ok: false,
      error: err.message,
      errorCode: err.code || 'SALE_ERROR',
      extra: err.extra || {}
    });
  }
});

// 5. Cancelar venta y restituir existencias
app.post('/api/pos/cancel-sale', (req, res) => {
  try {
    const user = resolveRequestUser(req);
    const { folio, reason } = req.body || {};
    const result = localDb.cancelSale(folio, reason, user);
    res.json(result);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 6. Historial de ventas
app.get('/api/pos/sales', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const terminal = req.query.terminal || null;
    const sales = localDb.getSales({ limit, terminal });
    res.json({ ok: true, count: sales.length, sales });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 7. Estado del turno por caja (C1 o C2)
app.get('/api/pos/shift/:code', (req, res) => {
  try {
    const shift = localDb.getTerminalShift(req.params.code);
    res.json(shift);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// 8. Abrir nuevo turno
app.post('/api/pos/shift/open', (req, res) => {
  try {
    const user = resolveRequestUser(req);
    const { terminal_code, initial_fund } = req.body || {};
    const result = localDb.openTerminalShift(terminal_code, initial_fund, user);
    res.json(result);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 9. Cerrar turno (Corte de caja) + RESPALDO INMEDIATO A SUPABASE
app.post('/api/pos/shift/close', async (req, res) => {
  try {
    const user = resolveRequestUser(req);
    const { terminal_code, counted_cash, notes } = req.body || {};
    const result = localDb.closeTerminalShift(terminal_code, counted_cash, notes, user);
    
    // Disparar respaldo inmediato en la nube para asegurar el corte cerrado
    if (supabase) {
      localDb.performCloudBackup(supabase).catch(err => {
        console.warn('[BACKUP CORTE] Respaldo diferido tras corte:', err.message);
      });
    }

    res.json(result);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 10. Movimientos de Caja delegados a routes/cashMovements/cashMovementsRoutes.js

// 11. Lista de cajeros registrados
app.get('/api/pos/cashiers', (req, res) => {
  try {
    const cashiers = localDb.listCashiers();
    res.json({ ok: true, cashiers });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 12. Registrar nuevo cajero
app.post('/api/pos/cashiers', (req, res) => {
  try {
    const registered = localDb.registerCashier(req.body);
    res.json({ ok: true, cashier: registered });
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 13. Login con validación de roles y PIN
app.post('/api/pos/login', (req, res) => {
  try {
    const auth = localDb.login(req.body);
    res.json({ ok: true, ...auth });
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 401;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 14. Reportes históricos de cortes
app.get('/api/pos/reports', (req, res) => {
  try {
    const { startDate, endDate, terminal } = req.query;
    const reports = localDb.getReports(startDate, endDate, terminal);
    res.json(reports);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// 15. Estado del respaldo en la nube
app.get('/api/pos/backup-status', (req, res) => {
  try {
    const status = localDb.getBackupStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 16. Ejecutar respaldo en la nube bajo demanda
app.post('/api/pos/backup-cloud', async (req, res) => {
  try {
    const result = await localDb.performCloudBackup(supabase);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 17. Lista de empaques y códigos padre (cajas)
app.get('/api/pos/packages', (req, res) => {
  try {
    const packages = localDb.getPackages();
    res.json({ ok: true, packages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 18. Guardar o actualizar empaque (caja)
app.post('/api/pos/package', (req, res) => {
  try {
    const result = localDb.savePackage(req.body);
    res.json(result);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 19. Eliminar empaque (caja)
app.delete('/api/pos/package/:barcode', (req, res) => {
  try {
    const result = localDb.deletePackage(req.params.barcode);
    res.json(result);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 20. Búsqueda de código para recepción (pieza o caja padre)
app.get('/api/pos/receiving/lookup/:code', (req, res) => {
  try {
    const match = localDb.lookupReceivingCode(req.params.code);
    if (!match) return res.status(404).json({ ok: false, error: 'Código no encontrado.' });
    res.json({ ok: true, ...match });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 21. Entrada de mercancía por recepción (piezas o cajas)
app.post('/api/pos/receiving/stock', (req, res) => {
  try {
    const user = resolveRequestUser(req);
    const { code, quantity, unit_cost, unitCost, source } = req.body || {};
    const result = localDb.receiveStock(code, quantity, unit_cost ?? unitCost, source, user.full_name);
    res.json(result);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 22. Recepción de factura CFDI completa
app.post('/api/pos/receiving/invoice', (req, res) => {
  try {
    const user = resolveRequestUser(req);
    const result = localDb.receiveInvoice(req.body, user.full_name);
    res.json(result);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code, extra: err.extra });
  }
});

// 23. Verificar si UUID de factura ya fue recibida
app.get('/api/pos/receiving/invoice/:uuid', (req, res) => {
  try {
    const received = localDb.isInvoiceReceived(req.params.uuid);
    res.json({ ok: true, received });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 24. Registro de mermas
app.post('/api/pos/shrinkage', (req, res) => {
  try {
    const user = resolveRequestUser(req);
    const { product_id, productId, quantity, reason } = req.body || {};
    const result = localDb.registerShrinkage(product_id ?? productId, quantity, reason, user.full_name);
    res.json(result);
  } catch (err) {
    const status = err instanceof localDb.PosError ? err.status : 500;
    res.status(status).json({ ok: false, error: err.message, errorCode: err.code });
  }
});

// 25. Historial de mermas
app.get('/api/pos/shrinkage', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const list = localDb.getShrinkageHistory(limit);
    res.json({ ok: true, shrinkage: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 26. Versión de datos para sincronización reactiva en tiempo real (C1 y C2)
app.get('/api/pos/version', (req, res) => {
  res.json({ ok: true, version: localDb.getDataVersion() });
});

// 27. Módulo de Movimientos de Caja (Ingresos y Egresos) - Responsabilidad separada
app.use('/api/pos', createCashMovementsRouter({ localDb, supabase, resolveRequestUser }));

// 27B. Módulo de Promociones
app.use('/api/promociones', require('./routes/promotions'));

// 28. Impresión directa de ticket térmico desde navegador hacia impresora POS-58 en Windows
app.post('/api/pos/print-ticket', async (req, res) => {
  try {
    const candidates = [
      path.join(__dirname, 'electron/modules/printer.js'),
      path.join(__dirname, '../electron/modules/printer.js'),
      path.join(__dirname, '../../modules/printer.js')
    ];
    const printerPath = candidates.find(p => fs.existsSync(p));
    if (!printerPath) {
      return res.status(404).json({ ok: false, error: 'Módulo de impresora no disponible.' });
    }
    const { printTicketDirectWindows } = require(printerPath);
    const result = await printTicketDirectWindows(req.body || {});
    if (result && result.ok) {
      return res.json(result);
    }
    return res.status(404).json(result || { ok: false, reason: 'NO_THERMAL_PRINTER' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 29. Sincronización bidireccional completa bajo demanda (Nube <-> SQLite local)
app.post('/api/pos/sync-cloud', async (req, res) => {
  try {
    const pull = await localDb.pullFromCloudSync(supabase);
    const seed = localDb.ensureStarterCatalog();
    const push = supabase ? await localDb.performCloudBackup(supabase) : { ok: false };
    res.json({ ok: true, pull, seed, push });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==============================================================================
// TAREAS AUTOMÁTICAS: RESPALDO PERIÓDICO A SUPABASE (PLAN FREE: CADA 15 MIN)
// ==============================================================================
const BACKUP_INTERVAL_MIN = Math.max(5, parseInt(process.env.BACKUP_INTERVAL_MINUTES || '15', 10));
console.log(`[RESPALDO PROGRAMADO] Intervalo activo: cada ${BACKUP_INTERVAL_MIN} minutos hacia Supabase.`);

setInterval(async () => {
  try {
    if (supabase) {
      console.log(`[RESPALDO CLOUD] Ejecutando sincronización incremental hacia Supabase...`);
      const res = await localDb.performCloudBackup(supabase);
      if (res && res.ok) {
        console.log(`[RESPALDO CLOUD] Respaldo exitoso a las ${res.timestamp}`);
      }
    }
  } catch (cronErr) {
    console.warn('[RESPALDO CLOUD] Advertencia en ciclo periódico:', cronErr.message);
  }
}, BACKUP_INTERVAL_MIN * 60 * 1000);

// Respaldo instantáneo local seguro (Snapshot SQLite) cada hora
setInterval(() => {
  try {
    localDb.createLocalSnapshot('ciclo_horario');
  } catch (e) {
    console.warn('[SNAPSHOT LOCAL] Error creando snapshot:', e.message);
  }
}, 60 * 60 * 1000);

// Helper para obtener IPs locales LAN (Wi-Fi / Ethernet)
function getLanIps() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Filtrar sólo IPv4 que no sean loopback (127.0.0.1)
      if (net.family === 'IPv4' && !net.internal) {
        results.push({ interface: name, ip: net.address });
      }
    }
  }
  return results;
}

// Iniciar servidor en 0.0.0.0 para acceso inalámbrico desde la LAN (celular)
app.listen(PORT, '0.0.0.0', async () => {
  console.log('================================================================');
  console.log(`TIENDAADMIN - SERVIDOR INICIADO EN EL PUERTO ${PORT}`);
  console.log('================================================================');
  console.log(`PC Local:        http://localhost:${PORT}`);
  console.log(`PC Recepción:    http://localhost:${PORT}/recepcion`);
  
  const lanIps = getLanIps();
  if (lanIps.length > 0) {
    console.log('----------------------------------------------------------------');
    console.log('ESCÁNER INALÁMBRICO DESDE CELULAR (Misma red Wi-Fi):');
    lanIps.forEach(net => {
      console.log(`  -> [${net.interface}] http://${net.ip}:${PORT}/recepcion`);
    });
    console.log('----------------------------------------------------------------');
  } else {
    console.log(`Celular (LAN):   http://<IP-DE-TU-PC>:${PORT}/recepcion`);
  }

  console.log(`API Producto:    GET  /api/producto/:codigo`);
  console.log(`API Guardar:     POST /api/producto`);
  console.log(`API CFDI Fact.:  POST /api/cfdi`);
  console.log('================================================================');

  // Probar conexión a MySQL
  await testConnection();
});

