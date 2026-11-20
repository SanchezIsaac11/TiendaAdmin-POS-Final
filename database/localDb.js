/**
 * ==============================================================================
 * BASE DE DATOS LOCAL (FUENTE ÚNICA DE VERDAD) - SQLite (node:sqlite)
 * ==============================================================================
 * - Ambas cajas (C1 y C2) se conectan a ESTE servidor; nunca escriben directo a la nube.
 * - Todas las escrituras corren en transacciones `BEGIN IMMEDIATE` síncronas:
 *   no existe intercalado entre peticiones => sin race conditions.
 * - El stock se descuenta con UPDATE condicional (stock >= qty) + CHECK(stock >= 0).
 * - Los precios/totales se recalculan en el servidor; nunca se confía en el cliente.
 * - Cada fila lleva `rev` / `synced_rev` para el respaldo incremental a Supabase.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = path.dirname(process.env.LOCAL_DB_FILE || path.join(__dirname, 'pos_local.sqlite'));
const DB_FILE = process.env.LOCAL_DB_FILE || path.join(__dirname, 'pos_local.sqlite');
const BACKUP_DIR = process.env.LOCAL_BACKUP_DIR || path.join(DB_DIR, 'backups');

const TERMINALS = { C1: 'Caja 1', C2: 'Caja 2' };
const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'mixed'];
const SESSION_HOURS = 16;
const MAX_MONEY = 1000000;      // $1,000,000 tope por operación
const MAX_QTY = 10000;          // tope de piezas por línea
const MAX_STOCK = 10000000;

let db = null;
let dataVersion = Date.now();   // cambia en cada escritura => polling de las cajas

// ------------------------------------------------------------------------------
// ERRORES Y VALIDACIÓN
// ------------------------------------------------------------------------------
class PosError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const nowIso = () => new Date().toISOString();
const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => Math.round(c) / 100;

function num(value, { name, min = 0, max = MAX_MONEY, integer = false, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw new PosError('INVALID_INPUT', `El campo "${name}" es obligatorio.`);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new PosError('INVALID_INPUT', `El campo "${name}" debe ser numérico.`);
  if (integer && !Number.isInteger(n)) throw new PosError('INVALID_INPUT', `El campo "${name}" debe ser un número entero.`);
  if (n < min) throw new PosError('INVALID_INPUT', `El campo "${name}" no puede ser menor a ${min}.`);
  if (n > max) throw new PosError('INVALID_INPUT', `El campo "${name}" excede el máximo permitido (${max}).`);
  return n;
}

function str(value, { name, min = 1, max = 150, pattern = null, required = true } = {}) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (!s) {
    if (!required) return null;
    throw new PosError('INVALID_INPUT', `El campo "${name}" es obligatorio.`);
  }
  if (s.length < min || s.length > max) {
    throw new PosError('INVALID_INPUT', `El campo "${name}" debe tener entre ${min} y ${max} caracteres.`);
  }
  if (pattern && !pattern.test(s)) throw new PosError('INVALID_INPUT', `El campo "${name}" tiene caracteres no válidos.`);
  return s;
}

const BARCODE_RE = /^[A-Za-z0-9\-_.]+$/;
const terminalCode = (code) => {
  const c = String(code || '').trim().toUpperCase();
  if (!TERMINALS[c]) throw new PosError('INVALID_TERMINAL', 'Terminal inválida. Solo existen Caja 1 (C1) y Caja 2 (C2).');
  return c;
};

// ------------------------------------------------------------------------------
// INICIALIZACIÓN Y ESQUEMA
// ------------------------------------------------------------------------------
const SYNC_COLS = `rev INTEGER NOT NULL DEFAULT 1, synced_rev INTEGER NOT NULL DEFAULT 0`;
const TS = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 2 AND 30),
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 2 AND 80),
  role TEXT NOT NULL CHECK (role IN ('cajero','admin')),
  pin_hash TEXT,
  pin_salt TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT ${TS},
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT NOT NULL UNIQUE CHECK (length(barcode) BETWEEN 1 AND 64),
  sku TEXT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 150),
  brand TEXT,
  category TEXT NOT NULL DEFAULT 'Abarrotes',
  cost REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
  price REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  min_stock INTEGER NOT NULL DEFAULT 5 CHECK (min_stock >= 0),
  icon_type TEXT DEFAULT 'bread',
  promo_rule TEXT,
  origin TEXT DEFAULT 'manual',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

CREATE TABLE IF NOT EXISTS product_packages (
  barcode TEXT PRIMARY KEY CHECK (length(barcode) BETWEEN 1 AND 64),
  product_id INTEGER NOT NULL REFERENCES products(id),
  units INTEGER NOT NULL CHECK (units BETWEEN 1 AND 10000),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);

CREATE TABLE IF NOT EXISTS cash_cuts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  terminal_code TEXT NOT NULL CHECK (terminal_code IN ('C1','C2')),
  terminal_name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  cashier_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  opened_at TEXT NOT NULL DEFAULT ${TS},
  closed_at TEXT,
  closed_by TEXT,
  initial_fund REAL NOT NULL DEFAULT 0 CHECK (initial_fund >= 0),
  total_sales_count INTEGER NOT NULL DEFAULT 0,
  total_sales_amount REAL NOT NULL DEFAULT 0,
  cash_sales REAL NOT NULL DEFAULT 0,
  card_sales REAL NOT NULL DEFAULT 0,
  transfer_sales REAL NOT NULL DEFAULT 0,
  mixed_sales REAL NOT NULL DEFAULT 0,
  cash_inflows REAL NOT NULL DEFAULT 0,
  cash_outflows REAL NOT NULL DEFAULT 0,
  supplier_payouts REAL NOT NULL DEFAULT 0,
  expected_cash REAL NOT NULL DEFAULT 0,
  counted_cash REAL,
  difference REAL,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);
-- Garantía física: solo UN turno abierto por caja (bloquea dobles aperturas simultáneas)
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_cuts_one_open ON cash_cuts(terminal_code) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio TEXT NOT NULL UNIQUE,
  cash_cut_id INTEGER NOT NULL REFERENCES cash_cuts(id),
  terminal_code TEXT NOT NULL CHECK (terminal_code IN ('C1','C2')),
  terminal_name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  cashier_name TEXT NOT NULL,
  total_items INTEGER NOT NULL CHECK (total_items > 0),
  total_pieces INTEGER NOT NULL CHECK (total_pieces > 0),
  subtotal REAL NOT NULL CHECK (subtotal >= 0),
  discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total_net REAL NOT NULL CHECK (total_net >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','card','transfer','mixed')),
  cash_amount REAL NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
  card_amount REAL NOT NULL DEFAULT 0 CHECK (card_amount >= 0),
  transfer_amount REAL NOT NULL DEFAULT 0 CHECK (transfer_amount >= 0),
  cash_received REAL,
  cash_change REAL CHECK (cash_change IS NULL OR cash_change >= 0),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled')),
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);
CREATE INDEX IF NOT EXISTS idx_sales_cut ON sales(cash_cut_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER REFERENCES products(id),
  barcode TEXT,
  product_name TEXT NOT NULL,
  is_service INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  unit_cost REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  subtotal REAL NOT NULL CHECK (subtotal >= 0),
  promo_applied TEXT,
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE IF NOT EXISTS cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cash_cut_id INTEGER REFERENCES cash_cuts(id),
  terminal_code TEXT NOT NULL CHECK (terminal_code IN ('C1','C2')),
  terminal_name TEXT NOT NULL DEFAULT 'Caja 1',
  user_id INTEGER REFERENCES users(id),
  user_name TEXT NOT NULL DEFAULT 'Administrador',
  movement_type TEXT NOT NULL CHECK (movement_type IN ('inflow','outflow','supplier_payout')),
  concept TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Otros',
  amount REAL NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','card','transfer')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  movement_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  previous_stock INTEGER NOT NULL,
  new_stock INTEGER NOT NULL CHECK (new_stock >= 0),
  unit_cost REAL,
  reference TEXT,
  notes TEXT,
  user_name TEXT,
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);
CREATE INDEX IF NOT EXISTS idx_inv_mov_product ON inventory_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_inv_mov_type ON inventory_movements(movement_type);

CREATE TABLE IF NOT EXISTS supplier_invoices (
  uuid TEXT PRIMARY KEY,
  supplier_name TEXT,
  supplier_rfc TEXT,
  folio TEXT,
  total REAL,
  pieces_added INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${TS},
  updated_at TEXT NOT NULL DEFAULT ${TS},
  ${SYNC_COLS}
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT ${TS}
);
`;

// Tablas respaldadas en la nube y su llave primaria
const SYNC_TABLES = [
  { name: 'users', pk: 'id' },
  { name: 'products', pk: 'id' },
  { name: 'product_packages', pk: 'barcode' },
  { name: 'cash_cuts', pk: 'id' },
  { name: 'sales', pk: 'id' },
  { name: 'sale_items', pk: 'id' },
  { name: 'cash_movements', pk: 'id' },
  { name: 'inventory_movements', pk: 'id' },
  { name: 'supplier_invoices', pk: 'uuid' }
];

function createDirtyTriggers(d) {
  for (const t of SYNC_TABLES) {
    // Cualquier cambio de datos incrementa `rev` (=> pendiente de respaldo). Al marcar como
    // respaldado solo cambia `synced_rev`, por lo que el trigger no se dispara.
    d.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_${t.name}_dirty
      AFTER UPDATE ON ${t.name}
      WHEN NEW.rev = OLD.rev AND NEW.synced_rev = OLD.synced_rev
      BEGIN
        UPDATE ${t.name} SET rev = OLD.rev + 1, updated_at = ${TS} WHERE ${t.pk} = NEW.${t.pk};
      END;
    `);
  }
}

function migrateLegacyTables(d) {
  // Asegurar columnas nuevas en cash_movements para bases de datos existentes
  try {
    const cols = d.prepare('PRAGMA table_info(cash_movements)').all().map(c => c.name);
    if (cols.length > 0) {
      if (!cols.includes('terminal_name')) d.exec("ALTER TABLE cash_movements ADD COLUMN terminal_name TEXT NOT NULL DEFAULT 'Caja 1'");
      if (!cols.includes('user_id')) d.exec('ALTER TABLE cash_movements ADD COLUMN user_id INTEGER REFERENCES users(id)');
      if (!cols.includes('category')) d.exec("ALTER TABLE cash_movements ADD COLUMN category TEXT NOT NULL DEFAULT 'Otros'");
      if (!cols.includes('payment_method')) d.exec("ALTER TABLE cash_movements ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'");
      if (!cols.includes('notes')) d.exec('ALTER TABLE cash_movements ADD COLUMN notes TEXT');
    }
  } catch (_) {}

  // Migra la base anterior (tabla "productos") si existe, sin perder stock.
  const legacy = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='productos'`).get();
  if (!legacy) return;
  const count = d.prepare('SELECT COUNT(*) c FROM products').get().c;
  if (count === 0) {
    d.exec(`
      INSERT OR IGNORE INTO products (barcode, sku, name, brand, category, cost, price, stock, origin)
      SELECT codigo_barras, COALESCE(sku, codigo_barras), nombre, marca, COALESCE(categoria,'Abarrotes'),
             MAX(precio_costo,0), MAX(precio_venta,0), MAX(stock,0), COALESCE(origen_datos,'migracion')
      FROM productos WHERE codigo_barras IS NOT NULL AND trim(codigo_barras) <> '';
    `);
    console.log('[DB LOCAL] Productos migrados desde la base anterior.');
  }
  d.exec('ALTER TABLE productos RENAME TO _legacy_productos');
}

function initLocalDatabase() {
  if (db) return db;
  if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = FULL;');     // durabilidad máxima ante apagones
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(SCHEMA);
  createDirtyTriggers(db);
  migrateLegacyTables(db);
  ensureDefaultUsers();
  purgeExpiredSessions();
  return db;
}

function tx(fn) {
  const d = initLocalDatabase();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(d);
    d.exec('COMMIT');
    dataVersion = Date.now();
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (_) { /* ya revertida */ }
    if (err instanceof PosError) throw err;
    const msg = String(err && err.message || err);
    if (msg.includes('CHECK constraint failed: stock') || msg.includes('new_stock >= 0')) {
      throw new PosError('INSUFFICIENT_STOCK', 'Operación rechazada: el inventario no puede quedar negativo.', 409);
    }
    if (msg.includes('UNIQUE constraint failed')) {
      throw new PosError('DUPLICATE', 'Registro duplicado: ' + msg.replace(/^.*UNIQUE constraint failed: /, ''), 409);
    }
    if (msg.includes('CHECK constraint failed')) {
      throw new PosError('INVALID_INPUT', 'Datos inválidos rechazados por la base de datos (' + msg.replace(/^.*CHECK constraint failed: /, '') + ').');
    }
    throw err;
  }
}

const getDataVersion = () => dataVersion;

// ------------------------------------------------------------------------------
// USUARIOS, PIN Y SESIONES
// ------------------------------------------------------------------------------
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { hash, salt };
}

function verifyPin(pin, hash, salt) {
  if (!hash || !salt) return false;
  const test = crypto.scryptSync(String(pin), salt, 32);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

const validPin = (pin, name = 'PIN') => str(pin, { name, min: 4, max: 8, pattern: /^\d+$/ });

function ensureDefaultAdmin() {
  const admins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin' AND is_active=1`).get().c;
  if (admins > 0) return;
  const initialPin = String(process.env.ADMIN_INITIAL_PIN || '1234');
  const { hash, salt } = hashPin(initialPin);
  db.prepare(`INSERT OR IGNORE INTO users (username, full_name, role, pin_hash, pin_salt) VALUES ('admin','Administrador','admin',?,?)`)
    .run(hash, salt);
  console.warn(`[SEGURIDAD] Usuario "admin" creado con el PIN inicial definido en ADMIN_INITIAL_PIN. Cámbialo desde el sistema.`);
}

function ensureDefaultUsers() {
  ensureDefaultAdmin();
  const cashiers = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='cajero' AND is_active=1`).get().c;
  if (cashiers === 0) {
    db.prepare(`INSERT OR IGNORE INTO users (username, full_name, role) VALUES ('elena', 'Elena R.', 'cajero')`).run();
    db.prepare(`INSERT OR IGNORE INTO users (username, full_name, role) VALUES ('cajero', 'Cajero General', 'cajero')`).run();
  }
}

function publicUser(u) {
  return u ? { id: u.id, username: u.username, full_name: u.full_name, role: u.role, has_pin: !!u.pin_hash } : null;
}

function listCashiers() {
  initLocalDatabase();
  return db.prepare(`SELECT * FROM users WHERE role='cajero' AND is_active=1 ORDER BY full_name`).all().map(publicUser);
}

function registerCashier({ fullName, username, pin }) {
  const full = str(fullName, { name: 'Nombre completo', min: 2, max: 80 });
  let user = String(username || '').trim().toLowerCase()
    || full.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 20);
  user = str(user, { name: 'Usuario', min: 2, max: 30, pattern: /^[a-z0-9._-]+$/ });
  const cleanPin = pin ? validPin(pin) : null;

  return tx((d) => {
    const exists = d.prepare('SELECT id FROM users WHERE username = ?').get(user);
    if (exists) throw new PosError('DUPLICATE_USER', `Ya existe un usuario "${user}". Elige otro identificador.`, 409);
    const h = cleanPin ? hashPin(cleanPin) : { hash: null, salt: null };
    const info = d.prepare(`INSERT INTO users (username, full_name, role, pin_hash, pin_salt) VALUES (?,?, 'cajero', ?, ?)`)
      .run(user, full, h.hash, h.salt);
    return publicUser(d.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid)));
  });
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  initLocalDatabase().prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return token;
}

function login({ role, username, pin }) {
  initLocalDatabase();
  const r = role === 'admin' ? 'admin' : 'cajero';
  let u;
  if (r === 'admin') {
    u = username
      ? db.prepare(`SELECT * FROM users WHERE username=? AND role='admin' AND is_active=1`).get(String(username).trim())
      : db.prepare(`SELECT * FROM users WHERE role='admin' AND is_active=1 ORDER BY id LIMIT 1`).get();
  } else {
    u = db.prepare(`SELECT * FROM users WHERE username=? AND role='cajero' AND is_active=1`).get(String(username || '').trim());
  }
  if (!u) throw new PosError('AUTH_FAILED', 'Usuario no encontrado o inactivo.', 401);
  if (u.pin_hash) {
    if (!pin || !verifyPin(String(pin).trim(), u.pin_hash, u.pin_salt)) {
      throw new PosError('AUTH_FAILED', r === 'admin' ? 'Contraseña de administrador incorrecta.' : `PIN incorrecto para ${u.full_name}.`, 401);
    }
  } else if (r === 'admin') {
    throw new PosError('AUTH_FAILED', 'El administrador no tiene PIN configurado.', 401);
  }
  return { token: createSession(u.id), user: publicUser(u) };
}

function getSessionUser(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  const row = initLocalDatabase().prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.is_active = 1
  `).get(token, nowIso());
  return row ? publicUser(row) : null;
}

function logout(token) {
  if (token) initLocalDatabase().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

function changeAdminPin(userId, currentPin, newPin) {
  const np = validPin(newPin, 'Nuevo PIN');
  return tx((d) => {
    const u = d.prepare(`SELECT * FROM users WHERE id=? AND role='admin'`).get(userId);
    if (!u || !verifyPin(String(currentPin || ''), u.pin_hash, u.pin_salt)) {
      throw new PosError('AUTH_FAILED', 'El PIN actual es incorrecto.', 401);
    }
    const h = hashPin(np);
    d.prepare('UPDATE users SET pin_hash=?, pin_salt=? WHERE id=?').run(h.hash, h.salt, userId);
    d.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return { ok: true };
  });
}

// ------------------------------------------------------------------------------
// PRODUCTOS E INVENTARIO
// ------------------------------------------------------------------------------
function parsePromo(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function mapProduct(r) {
  if (!r) return null;
  return {
    id: r.id,
    barcode: r.barcode,
    sku: r.sku || r.barcode,
    name: r.name,
    displayName: r.name,
    brand: r.brand || '',
    category: r.category || 'Abarrotes',
    cost: Number(r.cost) || 0,
    price: Number(r.price) || 0,
    unitPrice: Number(r.price) || 0,
    stock: r.stock,
    minStock: r.min_stock,
    iconType: r.icon_type || 'bread',
    promoRule: parsePromo(r.promo_rule),
    origen: r.origin,
    updatedAt: r.updated_at
  };
}

function getProducts() {
  return initLocalDatabase().prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY name COLLATE NOCASE').all().map(mapProduct);
}

function findProductRow(d, code) {
  if (code === undefined || code === null || String(code).trim() === '') return null;
  const clean = String(code).trim();
  const noZeros = clean.replace(/^0+/, '') || clean;
  return d.prepare(`
    SELECT * FROM products WHERE is_active = 1 AND (barcode = ? OR sku = ? OR barcode = ? OR ltrim(barcode,'0') = ?)
    LIMIT 1
  `).get(clean, clean, noZeros, noZeros);
}

function findProductByBarcode(code) {
  return mapProduct(findProductRow(initLocalDatabase(), code));
}

function searchProducts(term, limit = 15) {
  const t = String(term || '').trim();
  if (!t) return [];
  const like = `%${t.replace(/[%_]/g, '')}%`;
  return initLocalDatabase().prepare(`
    SELECT * FROM products WHERE is_active = 1
      AND (barcode LIKE ? OR sku LIKE ? OR name LIKE ? COLLATE NOCASE OR category LIKE ? COLLATE NOCASE)
    ORDER BY CASE WHEN name LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END, name COLLATE NOCASE
    LIMIT ?
  `).all(like, like, like, like, `${t}%`, Math.min(50, Math.max(1, limit))).map(mapProduct);
}

function validatePromo(promo, price) {
  if (promo === undefined || promo === null || promo === '') return null;
  const p = typeof promo === 'string' ? parsePromo(promo) : promo;
  if (!p || typeof p !== 'object') {
    throw new PosError('INVALID_INPUT', 'Promoción inválida.');
  }
  const type = p.type || (p.discount_percent !== undefined || p.percentage !== undefined ? 'percentage' : 'bundle');
  if (type === 'bundle') {
    const q = num(p.quantity, { name: 'Piezas de la promoción', min: 2, max: 1000, integer: true });
    const bp = num(p.bundle_price, { name: 'Precio de la promoción', min: 0.01 });
    if (price !== undefined && price !== null && toCents(bp) >= toCents(q * price)) {
      throw new PosError('INVALID_INPUT', 'El precio de la promoción debe ser menor al precio normal.');
    }
    return JSON.stringify({ type: 'bundle', quantity: q, bundle_price: bp, badge_text: String(p.badge_text || `${q}x$${bp}`).slice(0, 40) });
  } else if (type === 'percentage' || type === 'percent') {
    const pct = num(p.discount_percent ?? p.percentage ?? p.discount, { name: 'Porcentaje de descuento', min: 0.01, max: 100 });
    return JSON.stringify({ type: 'percentage', discount_percent: pct, badge_text: String(p.badge_text || `-${pct}%`).slice(0, 40) });
  }
  throw new PosError('INVALID_INPUT', 'Promoción inválida (se admiten tipos "bundle" o "percentage").');
}

function insertMovement(d, { productId, type, qty, prev, next, cost, reference, notes, user }) {
  d.prepare(`
    INSERT INTO inventory_movements (product_id, movement_type, quantity, previous_stock, new_stock, unit_cost, reference, notes, user_name)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(productId, type, qty, prev, next, cost ?? null, reference ?? null, notes ? String(notes).slice(0, 250) : null, user ?? null);
}

/**
 * Alta / edición de producto.
 * Para evitar sobrescribir ventas concurrentes, si el cliente envía `expected_stock`
 * (el stock que tenía en pantalla) se aplica solo la DIFERENCIA sobre el stock real.
 */
function saveProduct(input, userName = 'Sistema') {
  const barcode = str(input.barcode ?? input.codigo_barras, { name: 'Código de barras', max: 64, pattern: BARCODE_RE });
  const name = str(input.name ?? input.nombre, { name: 'Nombre', max: 150 });
  const brand = str(input.brand ?? input.marca, { name: 'Marca', max: 80, required: false });
  const category = str(input.category ?? input.categoria, { name: 'Categoría', max: 80, required: false }) || 'Abarrotes';
  const cost = num(input.cost ?? input.precio_costo ?? 0, { name: 'Costo' });
  const price = num(input.price ?? input.precio_venta ?? 0, { name: 'Precio de venta' });
  const stockIn = input.stock === undefined || input.stock === null || input.stock === ''
    ? null : num(input.stock, { name: 'Stock', max: MAX_STOCK, integer: true });
  const expected = input.expected_stock === undefined || input.expected_stock === null
    ? null : num(input.expected_stock, { name: 'Stock esperado', max: MAX_STOCK, integer: true });
  const minStock = input.min_stock === undefined ? null : num(input.min_stock, { name: 'Stock mínimo', max: 100000, integer: true });
  const promo = input.promoRule !== undefined || input.promo_rule !== undefined
    ? validatePromo(input.promoRule ?? input.promo_rule, price) : undefined;
  const id = input.id !== undefined && input.id !== null && /^\d+$/.test(String(input.id)) ? Number(input.id) : null;

  return tx((d) => {
    let row = id ? d.prepare('SELECT * FROM products WHERE id = ?').get(id) : null;
    const byBarcode = d.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
    if (row && byBarcode && byBarcode.id !== row.id) {
      throw new PosError('DUPLICATE_BARCODE', `El código ${barcode} ya pertenece a "${byBarcode.name}".`, 409);
    }
    if (!row) row = byBarcode;

    if (!row) {
      const initial = stockIn ?? 0;
      const info = d.prepare(`
        INSERT INTO products (barcode, sku, name, brand, category, cost, price, stock, min_stock, promo_rule, origin)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(barcode, barcode, name, brand, category, cost, price, initial, minStock ?? 5, promo ?? null, String(input.origen || input.origin || 'manual').slice(0, 30));
      const newId = Number(info.lastInsertRowid);
      if (initial > 0) insertMovement(d, { productId: newId, type: 'alta_inicial', qty: initial, prev: 0, next: initial, cost, notes: 'Alta de producto', user: userName });
      return mapProduct(d.prepare('SELECT * FROM products WHERE id = ?').get(newId));
    }

    d.prepare(`
      UPDATE products SET barcode=?, sku=?, name=?, brand=?, category=?, cost=?, price=?, is_active=1,
        min_stock = COALESCE(?, min_stock), promo_rule = CASE WHEN ? THEN ? ELSE promo_rule END
      WHERE id=?
    `).run(barcode, barcode, name, brand, category, cost, price, minStock, promo !== undefined ? 1 : 0, promo ?? null, row.id);

    if (stockIn !== null) {
      const current = d.prepare('SELECT stock FROM products WHERE id = ?').get(row.id).stock;
      const target = expected !== null ? current + (stockIn - expected) : stockIn;
      if (target < 0) throw new PosError('INSUFFICIENT_STOCK', `El ajuste dejaría el stock negativo (stock real actual: ${current}).`, 409);
      if (target !== current) {
        d.prepare('UPDATE products SET stock = ? WHERE id = ?').run(target, row.id);
        insertMovement(d, { productId: row.id, type: 'ajuste_manual', qty: target - current, prev: current, next: target, cost, notes: 'Ajuste desde inventario', user: userName });
      }
    }
    return mapProduct(d.prepare('SELECT * FROM products WHERE id = ?').get(row.id));
  });
}

function deleteProduct(id) {
  const pid = num(id, { name: 'ID', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
  return tx((d) => {
    const info = d.prepare('UPDATE products SET is_active = 0 WHERE id = ? AND is_active = 1').run(pid);
    if (info.changes === 0) throw new PosError('NOT_FOUND', 'Producto no encontrado.', 404);
    return { ok: true };
  });
}

function addStockTx(d, productRow, qty, unitCost, type, notes, user, reference) {
  const prev = productRow.stock;
  const next = prev + qty;
  if (next > MAX_STOCK) throw new PosError('INVALID_INPUT', 'El stock resultante excede el máximo permitido.');
  const cost = unitCost !== null && unitCost !== undefined && unitCost > 0 ? unitCost : productRow.cost;
  d.prepare('UPDATE products SET stock = stock + ?, cost = ? WHERE id = ?').run(qty, cost, productRow.id);
  insertMovement(d, { productId: productRow.id, type, qty, prev, next, cost, notes, user, reference });
  return { prev, next, cost };
}

function registerStockEntry(productId, quantity, unitCost, userName = 'Sistema', notes = 'Entrada de mercancía') {
  const pid = num(productId, { name: 'Producto', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
  const qty = num(quantity, { name: 'Cantidad', min: 1, max: 100000, integer: true });
  const cost = num(unitCost, { name: 'Costo unitario', required: false });
  return tx((d) => {
    const p = d.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(pid);
    if (!p) throw new PosError('NOT_FOUND', 'Producto no encontrado.', 404);
    const r = addStockTx(d, p, qty, cost, 'entrada_compra', notes, userName);
    return { ok: true, id: p.id, name: p.name, previousStock: r.prev, newStock: r.next };
  });
}

function registerShrinkage(productId, quantity, reason, userName = 'Sistema') {
  const pid = num(productId, { name: 'Producto', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
  const qty = num(quantity, { name: 'Cantidad', min: 1, max: 100000, integer: true });
  const why = str(reason, { name: 'Motivo', max: 120, required: false }) || 'Merma';
  return tx((d) => {
    const p = d.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(pid);
    if (!p) throw new PosError('NOT_FOUND', 'Producto no encontrado.', 404);
    const info = d.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').run(qty, pid, qty);
    if (info.changes === 0) throw new PosError('INSUFFICIENT_STOCK', `No puedes mermar ${qty} pzas de "${p.name}": solo hay ${p.stock}.`, 409);
    insertMovement(d, { productId: pid, type: 'merma', qty: -qty, prev: p.stock, next: p.stock - qty, cost: p.cost, notes: why, user: userName });
    return { ok: true, id: pid, name: p.name, previousStock: p.stock, newStock: p.stock - qty };
  });
}

function getShrinkageHistory(limit = 300) {
  return initLocalDatabase().prepare(`
    SELECT m.id, m.created_at, m.quantity, m.unit_cost, m.notes, m.user_name, p.name, p.barcode
    FROM inventory_movements m JOIN products p ON p.id = m.product_id
    WHERE m.movement_type = 'merma' ORDER BY m.id DESC LIMIT ?
  `).all(limit).map(r => ({
    id: r.id, date: r.created_at, productName: r.name, barcode: r.barcode,
    qty: Math.abs(r.quantity), cost: Number(r.unit_cost) || 0, unitCost: Number(r.unit_cost) || 0,
    reason: r.notes || 'Merma', user: r.user_name || ''
  }));
}

// --- Recepción de mercancía (piezas y cajas/códigos padre) ----------------------
function lookupReceivingCode(code) {
  const d = initLocalDatabase();
  const clean = String(code || '').trim();
  if (!clean) return null;
  const p = findProductRow(d, clean);
  if (p) return { product: mapProduct(p), isPackage: false, units: 1 };
  const pkg = d.prepare(`SELECT pk.*, p.id pid FROM product_packages pk JOIN products p ON p.id = pk.product_id WHERE pk.barcode = ? AND p.is_active = 1`).get(clean);
  if (!pkg) return null;
  return { product: mapProduct(d.prepare('SELECT * FROM products WHERE id = ?').get(pkg.pid)), isPackage: true, units: pkg.units };
}

function receiveStockTx(d, code, quantity, unitCost, source, userName) {
  const clean = String(code || '').trim();
  const qty = num(quantity, { name: 'Cantidad', min: 1, max: 100000, integer: true });
  const cost = num(unitCost, { name: 'Costo', required: false });
  let p = findProductRow(d, clean);
  let units = 1;
  let isPackage = false;
  if (!p) {
    const pkg = d.prepare('SELECT * FROM product_packages WHERE barcode = ?').get(clean);
    if (pkg) {
      p = d.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(pkg.product_id);
      units = pkg.units;
      isPackage = true;
    }
  }
  if (!p) throw new PosError('NOT_FOUND', `Código ${clean} no registrado.`, 404);
  const pieces = qty * units;
  const pieceCost = cost !== null && cost > 0 ? Math.round((cost / units) * 100) / 100 : null;
  const r = addStockTx(d, p, pieces, pieceCost, 'entrada_recepcion',
    isPackage ? `${source || 'Recepción'}: ${qty} caja(s) x ${units}` : `${source || 'Recepción'}: ${pieces} pzas`, userName, clean);
  return { ok: true, product_id: p.id, product_name: p.name, is_package: isPackage, units_per_package: units, units_added: pieces, new_stock: r.next };
}

function receiveStock(code, quantity, unitCost, source, userName = 'Sistema') {
  return tx((d) => receiveStockTx(d, code, quantity, unitCost, source, userName));
}

/** Factura completa en UNA transacción: o se registra todo o nada; factura duplicada bloqueada por UUID. */
function receiveInvoice(invoice, userName = 'Sistema') {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  if (items.length === 0) throw new PosError('INVALID_INPUT', 'La factura no tiene conceptos.');
  if (items.length > 500) throw new PosError('INVALID_INPUT', 'La factura excede 500 conceptos.');
  const uuid = invoice.uuid ? str(invoice.uuid, { name: 'UUID', max: 64 }) : null;
  const source = `Factura ${String(invoice.folio || 'S/F').slice(0, 30)}`;

  return tx((d) => {
    if (uuid && d.prepare('SELECT uuid FROM supplier_invoices WHERE uuid = ?').get(uuid)) {
      throw new PosError('DUPLICATE_INVOICE', `La factura ${uuid} ya fue registrada anteriormente.`, 409);
    }
    let pieces = 0;
    const details = [];
    const skipped = [];
    for (const it of items) {
      const code = String(it.code || '').trim();
      if (!code || !lookupInTx(d, code)) { skipped.push(it.description || code || 'Sin código'); continue; }
      const r = receiveStockTx(d, code, Math.max(1, Math.round(Number(it.quantity) || 0)), it.unitCost, source, userName);
      pieces += r.units_added;
      details.push({ ...r, description: it.description });
    }
    if (details.length === 0) throw new PosError('NO_MATCHES', 'Ningún concepto de la factura coincide con productos o cajas registradas.', 404, { skipped });
    if (uuid) {
      d.prepare(`INSERT INTO supplier_invoices (uuid, supplier_name, supplier_rfc, folio, total, pieces_added) VALUES (?,?,?,?,?,?)`)
        .run(uuid, String(invoice.supplierName || '').slice(0, 150), String(invoice.supplierRfc || '').slice(0, 20),
          String(invoice.folio || '').slice(0, 40), Number(invoice.total) || 0, pieces);
    }
    return { ok: true, pieces, products: details.length, details, skipped };
  });
}

function lookupInTx(d, code) {
  return findProductRow(d, code) || d.prepare('SELECT 1 FROM product_packages WHERE barcode = ?').get(code);
}

function isInvoiceReceived(uuid) {
  if (!uuid) return false;
  return !!initLocalDatabase().prepare('SELECT 1 FROM supplier_invoices WHERE uuid = ?').get(String(uuid).trim());
}

function getPackages() {
  return initLocalDatabase().prepare('SELECT barcode, product_id, units, description FROM product_packages ORDER BY created_at DESC').all();
}

function savePackage(pkg) {
  const barcode = str(pkg.barcode, { name: 'Código de la caja', max: 64, pattern: BARCODE_RE });
  const productId = num(pkg.product_id, { name: 'Producto', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true });
  const units = num(pkg.units, { name: 'Piezas por caja', min: 1, max: 10000, integer: true });
  return tx((d) => {
    const p = d.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(productId);
    if (!p) throw new PosError('NOT_FOUND', 'Producto no encontrado.', 404);
    if (d.prepare('SELECT 1 FROM products WHERE barcode = ? OR sku = ?').get(barcode, barcode)) {
      throw new PosError('DUPLICATE_BARCODE', 'Ese código ya pertenece a un producto (pieza), no puede ser una caja.', 409);
    }
    d.prepare(`
      INSERT INTO product_packages (barcode, product_id, units, description) VALUES (?,?,?,?)
      ON CONFLICT(barcode) DO UPDATE SET product_id = excluded.product_id, units = excluded.units, description = excluded.description
    `).run(barcode, productId, units, pkg.description ? String(pkg.description).slice(0, 150) : null);
    return { ok: true };
  });
}

function deletePackage(barcode) {
  return tx((d) => {
    d.prepare('DELETE FROM product_packages WHERE barcode = ?').run(String(barcode || '').trim());
    return { ok: true };
  });
}

// ------------------------------------------------------------------------------
// TURNOS / CORTES DE CAJA
// ------------------------------------------------------------------------------
function computeShiftTotals(d, cut) {
  const s = d.prepare(`
    SELECT COUNT(*) cnt,
      COALESCE(SUM(total_net),0) total,
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN total_net END),0) cash_sales,
      COALESCE(SUM(CASE WHEN payment_method='card' THEN total_net END),0) card_sales,
      COALESCE(SUM(CASE WHEN payment_method='transfer' THEN total_net END),0) transfer_sales,
      COALESCE(SUM(CASE WHEN payment_method='mixed' THEN total_net END),0) mixed_sales,
      COALESCE(SUM(cash_amount),0) cash_in_drawer,
      COUNT(CASE WHEN payment_method='cash' THEN 1 END) cash_cnt,
      COUNT(CASE WHEN payment_method='card' THEN 1 END) card_cnt,
      COUNT(CASE WHEN payment_method='transfer' THEN 1 END) transfer_cnt,
      COUNT(CASE WHEN payment_method='mixed' THEN 1 END) mixed_cnt
    FROM sales WHERE cash_cut_id = ? AND status = 'completed'
  `).get(cut.id);
  const m = d.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN movement_type='inflow' THEN amount END),0) total_inflows,
      COALESCE(SUM(CASE WHEN movement_type='outflow' THEN amount END),0) total_outflows,
      COALESCE(SUM(CASE WHEN movement_type='inflow' AND (payment_method IS NULL OR payment_method='cash') THEN amount END),0) cash_inflows,
      COALESCE(SUM(CASE WHEN movement_type='outflow' AND (payment_method IS NULL OR payment_method='cash') THEN amount END),0) cash_outflows,
      COALESCE(SUM(CASE WHEN movement_type='supplier_payout' THEN amount END),0) supplier,
      COUNT(CASE WHEN movement_type='inflow' THEN 1 END) inflows_count,
      COUNT(CASE WHEN movement_type='outflow' THEN 1 END) outflows_count,
      COUNT(CASE WHEN movement_type='inflow' AND (payment_method IS NULL OR payment_method='cash') THEN 1 END) cash_inflows_count,
      COUNT(CASE WHEN movement_type='outflow' AND (payment_method IS NULL OR payment_method='cash') THEN 1 END) cash_outflows_count
    FROM cash_movements
    WHERE cash_cut_id = ? OR (cash_cut_id IS NULL AND terminal_code = ? AND created_at >= ?)
  `).get(cut.id, cut.terminal_code, cut.opened_at);
  const expectedC = toCents(cut.initial_fund) + toCents(s.cash_in_drawer) + toCents(m.cash_inflows) - toCents(m.cash_outflows) - toCents(m.supplier);
  return {
    total_sales_count: s.cnt,
    total_sales_amount: fromCents(toCents(s.total)),
    avg_ticket: s.cnt ? fromCents(toCents(s.total) / s.cnt) : 0,
    cash_sales: fromCents(toCents(s.cash_sales)),
    cash_sales_count: s.cash_cnt,
    card_sales: fromCents(toCents(s.card_sales)),
    card_sales_count: s.card_cnt,
    transfer_sales: fromCents(toCents(s.transfer_sales)),
    transfer_sales_count: s.transfer_cnt,
    mixed_sales: fromCents(toCents(s.mixed_sales)),
    mixed_sales_count: s.mixed_cnt,
    cash_inflows: fromCents(toCents(m.cash_inflows)),
    cash_outflows: fromCents(toCents(m.cash_outflows)),
    total_inflows: fromCents(toCents(m.total_inflows)),
    total_outflows: fromCents(toCents(m.total_outflows)),
    inflows_count: m.inflows_count,
    outflows_count: m.outflows_count,
    cash_inflows_count: m.cash_inflows_count,
    cash_outflows_count: m.cash_outflows_count,
    supplier_payouts: fromCents(toCents(m.supplier)),
    expected_cash: fromCents(expectedC)
  };
}

function getOpenCut(d, code) {
  return d.prepare(`SELECT * FROM cash_cuts WHERE terminal_code = ? AND status = 'open'`).get(code);
}

function mapSaleWithItems(d, s) {
  const items = d.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(s.id);
  return {
    ...s,
    items: items.map(it => ({
      id: it.product_id, product_id: it.product_id, barcode: it.barcode, name: it.product_name, product_name: it.product_name,
      quantity: it.quantity, unit_price: it.unit_price, unitPrice: it.unit_price, discount: it.discount, subtotal: it.subtotal,
      is_service: !!it.is_service
    }))
  };
}

function getTerminalShift(code) {
  const tc = terminalCode(code);
  const d = initLocalDatabase();
  const cut = getOpenCut(d, tc);
  if (!cut) {
    const last = d.prepare(`SELECT * FROM cash_cuts WHERE terminal_code = ? AND status='closed' ORDER BY id DESC LIMIT 1`).get(tc);
    return { ok: true, is_open: false, terminal_code: tc, last_shift: last || null, sales: [], live_totals: null };
  }
  const live = computeShiftTotals(d, cut);
  const sales = d.prepare('SELECT * FROM sales WHERE cash_cut_id = ? ORDER BY id DESC').all(cut.id).map(s => mapSaleWithItems(d, s));
  return { ok: true, is_open: true, terminal_code: tc, shift: { ...cut, ...live }, live_totals: live, sales };
}

function openTerminalShift(code, initialFund, user) {
  const tc = terminalCode(code);
  const fund = num(initialFund, { name: 'Fondo inicial', max: 500000 });
  return tx((d) => {
    if (getOpenCut(d, tc)) throw new PosError('SHIFT_ALREADY_OPEN', `${TERMINALS[tc]} ya tiene un turno abierto.`, 409);
    const info = d.prepare(`
      INSERT INTO cash_cuts (terminal_code, terminal_name, user_id, cashier_name, status, initial_fund, expected_cash)
      VALUES (?,?,?,?, 'open', ?, ?)
    `).run(tc, TERMINALS[tc], user.id, user.full_name, fund, fund);
    return { ok: true, shift: d.prepare('SELECT * FROM cash_cuts WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

function closeTerminalShift(code, countedCash, notes, user) {
  const tc = terminalCode(code);
  const counted = num(countedCash, { name: 'Efectivo contado', max: 5000000 });
  return tx((d) => {
    const cut = getOpenCut(d, tc);
    if (!cut) throw new PosError('SHIFT_CLOSED', `${TERMINALS[tc]} no tiene un turno abierto.`, 409);

    // Enlazar movimientos del turno que no tengan asignado el cash_cut_id
    d.prepare(`
      UPDATE cash_movements SET cash_cut_id = ?
      WHERE cash_cut_id IS NULL AND terminal_code = ? AND created_at >= ?
    `).run(cut.id, tc, cut.opened_at);

    const t = computeShiftTotals(d, cut);
    const diff = fromCents(toCents(counted) - toCents(t.expected_cash));
    const info = d.prepare(`
      UPDATE cash_cuts SET status='closed', closed_at=?, closed_by=?, total_sales_count=?, total_sales_amount=?,
        cash_sales=?, card_sales=?, transfer_sales=?, mixed_sales=?, cash_inflows=?, cash_outflows=?, supplier_payouts=?,
        expected_cash=?, counted_cash=?, difference=?, notes=?
      WHERE id=? AND status='open'
    `).run(nowIso(), user.full_name, t.total_sales_count, t.total_sales_amount, t.cash_sales, t.card_sales, t.transfer_sales,
      t.mixed_sales, t.cash_inflows, t.cash_outflows, t.supplier_payouts, t.expected_cash, counted, diff,
      notes ? String(notes).slice(0, 300) : null, cut.id);
    if (info.changes === 0) throw new PosError('SHIFT_CLOSED', 'El turno ya fue cerrado por otra terminal.', 409);
    return { ok: true, shift: d.prepare('SELECT * FROM cash_cuts WHERE id = ?').get(cut.id) };
  });
}

// ------------------------------------------------------------------------------
// MÓDULO DE MOVIMIENTOS DE CAJA (INGRESOS Y EGRESOS) - RESPONSABILIDAD SEPARADA
// ------------------------------------------------------------------------------
const { createCashMovementsModule } = require('./cashMovements/cashMovementsDb');

const cashMovementsModule = createCashMovementsModule({
  initLocalDatabase,
  terminalCode,
  TERMINALS,
  toCents,
  num,
  str,
  PosError,
  getOpenCut,
  computeShiftTotals,
  createLocalSnapshot,
  tx,
  nowIso
});

function registerCashMovement(code, type, amount, concept, user) {
  return cashMovementsModule.registerCashMovement(code, type, amount, concept, user);
}

// ------------------------------------------------------------------------------
// VENTAS (ATÓMICAS)
// ------------------------------------------------------------------------------
const FOLIO_RE = /^[#A-Za-z0-9\-_]{4,60}$/;

function processSale(payload, user) {
  const tc = terminalCode(payload.terminal_code);
  const folio = str(payload.folio, { name: 'Folio', min: 4, max: 60, pattern: FOLIO_RE });
  const method = String(payload.payment_method || '');
  if (!PAYMENT_METHODS.includes(method)) throw new PosError('INVALID_INPUT', 'Método de pago inválido.');
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) throw new PosError('EMPTY_SALE', 'La venta debe contener al menos un artículo.');
  if (items.length > 300) throw new PosError('INVALID_INPUT', 'La venta excede 300 partidas.');
  const clientTotal = num(payload.total_net, { name: 'Total' });

  return tx((d) => {
    const dup = d.prepare('SELECT id FROM sales WHERE folio = ?').get(folio);
    if (dup) return { ok: true, duplicate: true, sale_id: dup.id, folio };

    let cut = getOpenCut(d, tc);
    if (!cut) {
      // Auto-abrir turno inicial para que el punto de venta nunca rechace ventas
      const u = user || { id: 1, full_name: 'Cajero en Turno' };
      const info = d.prepare(`
        INSERT INTO cash_cuts (terminal_code, terminal_name, user_id, cashier_name, status, initial_fund, expected_cash)
        VALUES (?,?,?,?, 'open', 1000.0, 1000.0)
      `).run(tc, TERMINALS[tc], u.id || 1, u.full_name || 'Cajero en Turno');
      cut = d.prepare('SELECT * FROM cash_cuts WHERE id = ?').get(Number(info.lastInsertRowid));
    }

    // 1. Resolver productos, precios y promociones activas DESDE LA BASE DE DATOS
    let promoEngine = null;
    try {
      const hasPromosTable = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='promociones'").get();
      promoEngine = require('../www/js/promotions');
      if (promoEngine && typeof promoEngine.setPromotions === 'function') {
        const activePromos = hasPromosTable
          ? d.prepare('SELECT * FROM promociones WHERE activa = 1 ORDER BY id DESC').all()
          : [];
        promoEngine.setPromotions(activePromos);
      }
    } catch (_) {
      promoEngine = null;
    }

    const lines = [];
    let subtotalC = 0;
    let discountC = 0;
    let pieces = 0;
    for (const raw of items) {
      const qty = num(raw.quantity, { name: 'Cantidad', min: 1, max: MAX_QTY, integer: true });
      pieces += qty;
      if (raw.is_service || raw.isService) {
        const name = str(raw.name, { name: 'Concepto del servicio', max: 150 });
        const priceC = toCents(num(raw.unitPrice ?? raw.unit_price, { name: 'Monto del servicio', min: 0.01, max: 50000 }));
        if (qty !== 1) throw new PosError('INVALID_INPUT', 'Los servicios se cobran de uno en uno.');
        subtotalC += priceC;
        lines.push({ product: null, name, barcode: String(raw.sku || '').slice(0, 64), qty, priceC, discC: 0, isService: 1 });
        continue;
      }
      let p = null;
      if (raw.id !== undefined && raw.id !== null && /^\d+$/.test(String(raw.id)) && Number(raw.id) < 1e12) {
        p = d.prepare('SELECT * FROM products WHERE id = ?').get(Number(raw.id));
      }
      if (!p) p = findProductRow(d, raw.barcode || raw.sku);
      if (!p || !p.is_active) {
        throw new PosError('PRODUCT_NOT_FOUND', `El producto "${raw.name || raw.barcode || '?'}" no está registrado en el inventario.`, 404);
      }
      const priceC = toCents(p.price);
      const grossC = priceC * qty;
      let discC = 0;
      let promoLabel = null;
      const legacyPromo = parsePromo(p.promo_rule);
      if (promoEngine && typeof promoEngine.evaluateItem === 'function') {
        const evalRes = promoEngine.evaluateItem({
          barcode: p.barcode,
          sku: p.sku,
          category: p.category,
          unitPrice: p.price,
          quantity: qty,
          promoRule: legacyPromo
        });
        if (evalRes && evalRes.discount > 0) {
          discC = Math.max(0, Math.min(grossC, toCents(evalRes.discount)));
          promoLabel = evalRes.badge || evalRes.nombre || null;
        }
      } else if (legacyPromo) {
        const promoType = legacyPromo.type || (legacyPromo.discount_percent !== undefined ? 'percentage' : 'bundle');
        if (promoType === 'bundle' && legacyPromo.quantity >= 2) {
          const bundles = Math.floor(qty / legacyPromo.quantity);
          if (bundles > 0) {
            const normalBundleCostC = bundles * legacyPromo.quantity * priceC;
            const promoBundleCostC = bundles * toCents(legacyPromo.bundle_price);
            if (promoBundleCostC < normalBundleCostC) {
              discC = Math.max(0, Math.min(grossC, normalBundleCostC - promoBundleCostC));
              promoLabel = legacyPromo.badge_text || `${legacyPromo.quantity}x$${legacyPromo.bundle_price}`;
            }
          }
        } else if (promoType === 'percentage' || promoType === 'percent') {
          const pct = Number(legacyPromo.discount_percent ?? legacyPromo.percentage ?? 0);
          if (pct > 0 && pct <= 100) {
            discC = Math.max(0, Math.min(grossC, Math.round(grossC * (pct / 100))));
            promoLabel = legacyPromo.badge_text || `-${pct}%`;
          }
        }
      }
      subtotalC += grossC;
      discountC += discC;
      lines.push({ product: p, name: p.name, barcode: p.barcode, qty, priceC, discC, promoLabel, isService: 0 });
    }
    const totalC = subtotalC - discountC;
    if (totalC < 0) throw new PosError('INVALID_INPUT', 'El total no puede ser negativo.');
    if (Math.abs(totalC - toCents(clientTotal)) > 1) {
      throw new PosError('PRICE_CHANGED', `El total cambió (precio actualizado en el sistema). Total correcto: $${fromCents(totalC).toFixed(2)}. Actualiza el carrito.`, 409, { server_total: fromCents(totalC) });
    }

    // 2. Validar pago
    let cashC = 0, cardC = 0, transferC = 0, receivedC = null, changeC = null;
    if (method === 'cash') {
      cashC = totalC;
      receivedC = payload.cash_received === undefined || payload.cash_received === null
        ? totalC : toCents(num(payload.cash_received, { name: 'Efectivo recibido' }));
      if (receivedC < totalC) throw new PosError('INSUFFICIENT_PAYMENT', `Efectivo recibido insuficiente. Total: $${fromCents(totalC).toFixed(2)}.`);
      changeC = receivedC - totalC;
    } else if (method === 'card') {
      cardC = totalC;
    } else if (method === 'transfer') {
      transferC = totalC;
    } else {
      cardC = toCents(num(payload.card_amount ?? 0, { name: 'Monto tarjeta' }));
      transferC = toCents(num(payload.transfer_amount ?? 0, { name: 'Monto transferencia' }));
      const cashIn = toCents(num(payload.cash_amount ?? 0, { name: 'Monto efectivo' }));
      if (Math.abs(cashIn + cardC + transferC - totalC) > 5) {
        throw new PosError('INSUFFICIENT_PAYMENT', `La suma del pago mixto debe ser igual al total ($${fromCents(totalC).toFixed(2)}).`);
      }
      cashC = totalC - cardC - transferC;
      if (cashC < 0) throw new PosError('INSUFFICIENT_PAYMENT', 'Tarjeta + transferencia exceden el total.');
    }

    // 3. Insertar venta
    const saleInfo = d.prepare(`
      INSERT INTO sales (folio, cash_cut_id, terminal_code, terminal_name, user_id, cashier_name, total_items, total_pieces,
        subtotal, discount, total_net, payment_method, cash_amount, card_amount, transfer_amount, cash_received, cash_change)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(folio, cut.id, tc, TERMINALS[tc], user.id, user.full_name, lines.length, pieces,
      fromCents(subtotalC), fromCents(discountC), fromCents(totalC), method,
      fromCents(cashC), fromCents(cardC), fromCents(transferC),
      receivedC === null ? null : fromCents(receivedC), changeC === null ? null : fromCents(changeC));
    const saleId = Number(saleInfo.lastInsertRowid);

    // 4. Descontar stock con UPDATE condicional (imposible vender más de lo existente)
    const decStock = d.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND is_active = 1 AND stock >= ?');
    const insItem = d.prepare(`
      INSERT INTO sale_items (sale_id, product_id, barcode, product_name, is_service, unit_price, unit_cost, quantity, discount, subtotal, promo_applied)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const ln of lines) {
      if (ln.product) {
        const before = d.prepare('SELECT stock FROM products WHERE id = ?').get(ln.product.id).stock;
        const res = decStock.run(ln.qty, ln.product.id, ln.qty);
        if (res.changes === 0) {
          throw new PosError('INSUFFICIENT_STOCK', `Stock insuficiente de "${ln.name}". Disponible: ${before}, solicitado: ${ln.qty}.`, 409,
            { product_id: ln.product.id, available: before });
        }
        insertMovement(d, { productId: ln.product.id, type: 'venta', qty: -ln.qty, prev: before, next: before - ln.qty, cost: ln.product.cost, reference: folio, user: user.full_name });
      }
      insItem.run(saleId, ln.product ? ln.product.id : null, ln.barcode || null, ln.name, ln.isService,
        fromCents(ln.priceC), ln.product ? Number(ln.product.cost) || 0 : 0, ln.qty, fromCents(ln.discC),
        fromCents(ln.priceC * ln.qty - ln.discC), ln.promoLabel || null);
    }

    return {
      ok: true, duplicate: false, sale_id: saleId, folio, cash_cut_id: cut.id,
      subtotal: fromCents(subtotalC), discount: fromCents(discountC), total_net: fromCents(totalC),
      cash_change: changeC === null ? null : fromCents(changeC)
    };
  });
}

function cancelSale(folio, reason, user) {
  const f = str(folio, { name: 'Folio', max: 60 });
  const why = str(reason, { name: 'Motivo', max: 200, required: false }) || 'Cancelación autorizada';
  return tx((d) => {
    const sale = d.prepare('SELECT * FROM sales WHERE folio = ?').get(f);
    if (!sale) throw new PosError('NOT_FOUND', `Venta ${f} no encontrada.`, 404);
    if (sale.status === 'cancelled') throw new PosError('ALREADY_CANCELLED', `La venta ${f} ya estaba cancelada.`, 409);
    const cut = d.prepare('SELECT status FROM cash_cuts WHERE id = ?').get(sale.cash_cut_id);
    if (!cut || cut.status !== 'open') {
      throw new PosError('SHIFT_CLOSED', 'No se puede cancelar: el corte de ese turno ya fue cerrado. Registra una devolución/entrada de mercancía.', 409);
    }
    const info = d.prepare(`UPDATE sales SET status='cancelled', cancelled_at=?, cancelled_by=?, cancellation_reason=? WHERE id=? AND status='completed'`)
      .run(nowIso(), user.full_name, why, sale.id);
    if (info.changes === 0) throw new PosError('ALREADY_CANCELLED', 'La venta ya fue cancelada por otra terminal.', 409);

    const items = d.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND product_id IS NOT NULL').all(sale.id);
    for (const it of items) {
      const p = d.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
      if (!p) continue;
      d.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.quantity, p.id);
      insertMovement(d, { productId: p.id, type: 'cancelacion_venta', qty: it.quantity, prev: p.stock, next: p.stock + it.quantity, cost: it.unit_cost, reference: f, notes: why, user: user.full_name });
    }
    return { ok: true, folio: f, status: 'cancelled' };
  });
}

function getSales({ limit = 100, terminal = null, cutId = null } = {}) {
  const d = initLocalDatabase();
  const where = [];
  const params = [];
  if (terminal && terminal !== 'all') { where.push('terminal_code = ?'); params.push(terminalCode(terminal)); }
  if (cutId) { where.push('cash_cut_id = ?'); params.push(Number(cutId)); }
  params.push(Math.min(1000, Math.max(1, Number(limit) || 100)));
  return d.prepare(`SELECT * FROM sales ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...params).map(s => mapSaleWithItems(d, s));
}

// ------------------------------------------------------------------------------
// REPORTES
// ------------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getReports(startDate, endDate, terminal = 'all') {
  const d = initLocalDatabase();
  const where = [];
  const params = [];
  if (startDate) { if (!DATE_RE.test(startDate)) throw new PosError('INVALID_INPUT', 'Fecha inicial inválida.'); where.push(`date(opened_at,'localtime') >= ?`); params.push(startDate); }
  if (endDate) { if (!DATE_RE.test(endDate)) throw new PosError('INVALID_INPUT', 'Fecha final inválida.'); where.push(`date(opened_at,'localtime') <= ?`); params.push(endDate); }
  if (terminal && terminal !== 'all') { where.push('terminal_code = ?'); params.push(terminalCode(terminal)); }
  const cuts = d.prepare(`SELECT * FROM cash_cuts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY opened_at DESC`)
    .all(...params).map(c => (c.status === 'open' ? { ...c, ...computeShiftTotals(d, c) } : c));

  const sum = (k) => fromCents(cuts.reduce((a, c) => a + toCents(c[k] || 0), 0));
  return {
    ok: true,
    cuts,
    totals: {
      cutsCount: cuts.length,
      totalSalesCount: cuts.reduce((a, c) => a + (c.total_sales_count || 0), 0),
      totalSalesAmount: sum('total_sales_amount'),
      totalCashSales: sum('cash_sales'),
      totalCardSales: sum('card_sales'),
      totalTransferSales: sum('transfer_sales'),
      totalMixedSales: sum('mixed_sales'),
      totalInflows: sum('cash_inflows'),
      totalOutflows: sum('cash_outflows'),
      totalSupplier: sum('supplier_payouts'),
      totalInitialFunds: sum('initial_fund'),
      totalCountedCash: sum('counted_cash'),
      totalExpectedCash: sum('expected_cash'),
      totalDifference: sum('difference')
    }
  };
}

function getCashCut(id) {
  const d = initLocalDatabase();
  const c = d.prepare('SELECT * FROM cash_cuts WHERE id = ?').get(Number(id));
  if (!c) throw new PosError('NOT_FOUND', 'Corte no encontrado.', 404);
  return c.status === 'open' ? { ...c, ...computeShiftTotals(d, c) } : c;
}

// ------------------------------------------------------------------------------
// RESPALDOS LOCALES (VACUUM INTO) Y CONFIG
// ------------------------------------------------------------------------------
function setConfig(key, value) {
  initLocalDatabase().prepare(`
    INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), nowIso());
}

function getConfig(key) {
  const r = initLocalDatabase().prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return r ? r.value : null;
}

function pruneDir(dir, keep) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sqlite')).sort();
  while (files.length > keep) fs.unlinkSync(path.join(dir, files.shift()));
}

/** Copia consistente de la base completa a database/backups (horaria + diaria con rotación). */
function createLocalSnapshot(reason = 'programado') {
  const d = initLocalDatabase();
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`;
  const hourlyDir = path.join(BACKUP_DIR, 'hourly');
  const dailyDir = path.join(BACKUP_DIR, 'daily');
  fs.mkdirSync(hourlyDir, { recursive: true });
  fs.mkdirSync(dailyDir, { recursive: true });

  const hourlyFile = path.join(hourlyDir, `pos_${day}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}.sqlite`);
  if (fs.existsSync(hourlyFile)) fs.unlinkSync(hourlyFile);
  d.exec(`VACUUM INTO '${hourlyFile.replace(/'/g, "''")}'`);

  const dailyFile = path.join(dailyDir, `pos_${day}.sqlite`);
  fs.copyFileSync(hourlyFile, dailyFile);   // la última copia del día queda como diaria

  pruneDir(hourlyDir, 72);   // 3 días de copias horarias
  pruneDir(dailyDir, 60);    // 60 días de copias diarias
  setConfig('last_local_snapshot', nowIso());
  return { ok: true, file: hourlyFile, reason };
}

function getBackupStatus() {
  const d = initLocalDatabase();
  const pending = {};
  let totalPending = 0;
  for (const t of SYNC_TABLES) {
    const c = d.prepare(`SELECT COUNT(*) c FROM ${t.name} WHERE rev > synced_rev`).get().c;
    pending[t.name] = c;
    totalPending += c;
  }
  return {
    database: 'SQLite local (WAL) - fuente de verdad',
    totalProducts: d.prepare('SELECT COUNT(*) c FROM products WHERE is_active=1').get().c,
    totalSales: d.prepare('SELECT COUNT(*) c FROM sales').get().c,
    pendingCloudRows: totalPending,
    pendingByTable: pending,
    lastCloudSync: getConfig('last_cloud_sync'),
    lastCloudError: getConfig('last_cloud_error'),
    lastLocalSnapshot: getConfig('last_local_snapshot')
  };
}

let isCloudBackingUp = false;

// Consultar movimientos económicos (ingresos y egresos) - Delegado al módulo separado
function getCashMovements(options = {}) {
  return cashMovementsModule.getCashMovements(options);
}

// Registrar un movimiento económico - Delegado al módulo separado
function saveCashMovement(mov, user) {
  return cashMovementsModule.saveCashMovement(mov, user);
}

// Eliminar un movimiento económico - Delegado al módulo separado
function deleteCashMovement(id) {
  return cashMovementsModule.deleteCashMovement(id);
}

const STARTER_CATALOG = [
  { barcode: '750101111521', sku: 'SAB-45', name: 'Sabritas Original Sal 45g', brand: 'Sabritas', category: 'Botanas y Frituras', cost: 12.50, price: 18.00, stock: 24, icon_type: 'snacks', promo_rule: null },
  { barcode: '750185538472', sku: 'COCA-600', name: 'Coca-Cola Original 600ml', brand: 'Coca-Cola', category: 'Bebidas y Refrescos', cost: 14.00, price: 19.00, stock: 42, icon_type: 'soda', promo_rule: null },
  { barcode: '750102054829', sku: 'LALA-1L', name: 'Leche Lala Entera 1L', brand: 'Lala', category: 'Lácteos y Huevos', cost: 21.00, price: 27.50, stock: 16, icon_type: 'milk', promo_rule: null },
  { barcode: '750100011220', sku: 'BIMBO-GDE', name: 'Pan Blanco Bimbo Grande', brand: 'Bimbo', category: 'Panadería y Tortillería', cost: 32.00, price: 42.00, stock: 8, icon_type: 'bread', promo_rule: null },
  { barcode: '750103912156', sku: 'NUTRI-850', name: 'Aceite Nutrioli 850ml', brand: 'Nutrioli', category: 'Despensa Básica', cost: 34.00, price: 45.00, stock: 3, icon_type: 'oil', promo_rule: null },
  { barcode: '750102600450', sku: 'ZOTE-400', name: 'Jabón Zote Rosa 400g', brand: 'Zote', category: 'Limpieza y Hogar', cost: 15.00, price: 22.00, stock: 0, icon_type: 'soap', promo_rule: null },
  { barcode: '750300049111', sku: 'HUEVO-18', name: 'Huevo Blanco San Juan 18pzs', brand: 'San Juan', category: 'Lácteos y Huevos', cost: 38.00, price: 49.00, stock: 14, icon_type: 'eggs', promo_rule: null },
  { barcode: '750107130114', sku: 'FRIJOL-1KG', name: 'Frijol Negro Verde Valle 1kg', brand: 'Verde Valle', category: 'Despensa Básica', cost: 28.00, price: 36.00, stock: 22, icon_type: 'beans', promo_rule: null }
];

function ensureStarterCatalog() {
  const d = initLocalDatabase();
  const seeded = getConfig('starter_seeded');
  const count = d.prepare('SELECT COUNT(*) c FROM products WHERE is_active = 1').get().c;
  if (count > 0) {
    if (!seeded) setConfig('starter_seeded', '1');
    return { seeded: false, count };
  }
  if (seeded === '1') return { seeded: false, count: 0 };

  return tx((dbTx) => {
    const ins = dbTx.prepare(`
      INSERT OR IGNORE INTO products (barcode, sku, name, brand, category, cost, price, stock, min_stock, icon_type, promo_rule, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, ?, ?, 'starter')
    `);
    for (const p of STARTER_CATALOG) {
      ins.run(p.barcode, p.sku, p.name, p.brand, p.category, p.cost, p.price, p.stock, p.icon_type, p.promo_rule);
    }
    dbTx.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('starter_seeded', '1', ?) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at").run(nowIso());
    return { seeded: true, count: STARTER_CATALOG.length };
  });
}

async function pullFromCloudSync(supabaseClient) {
  if (!supabaseClient) return { ok: false, reason: 'NO_SUPABASE' };
  const d = initLocalDatabase();
  const pulled = { products: 0, sales: 0, cash_cuts: 0, cash_movements: 0 };

  try {
    // 1. Productos desde Supabase (prioriza la nube si local no tiene cambios pendientes)
    const { data: cloudProds, error: pErr } = await supabaseClient.from('products').select('*').order('id');
    if (!pErr && Array.isArray(cloudProds) && cloudProds.length > 0) {
      tx((dbTx) => {
        for (const p of cloudProds) {
          if (!p || !p.barcode || !p.name) continue;
          const local = dbTx.prepare('SELECT id, rev, synced_rev, updated_at FROM products WHERE barcode = ?').get(String(p.barcode));
          const promoText = p.promo_rule ? (typeof p.promo_rule === 'string' ? p.promo_rule : JSON.stringify(p.promo_rule)) : null;
          if (!local) {
            dbTx.prepare(`
              INSERT OR IGNORE INTO products (barcode, sku, name, brand, category, cost, price, stock, min_stock, icon_type, promo_rule, origin, is_active, created_at, updated_at, rev, synced_rev)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
            `).run(
              String(p.barcode), p.sku || String(p.barcode), String(p.name), p.brand || null,
              p.category || 'Abarrotes', Math.max(0, Number(p.cost) || 0), Math.max(0, Number(p.price) || 0),
              Math.max(0, parseInt(p.stock, 10) || 0), Math.max(0, parseInt(p.min_stock, 10) || 5),
              p.icon_type || 'bread', promoText, p.origin || 'cloud_sync', p.is_active === false ? 0 : 1,
              p.created_at || nowIso(), p.updated_at || nowIso()
            );
            pulled.products++;
          } else if (local.rev === local.synced_rev && p.updated_at && String(p.updated_at) > String(local.updated_at)) {
            dbTx.prepare(`
              UPDATE products SET sku=?, name=?, brand=?, category=?, cost=?, price=?, stock=?, min_stock=?, icon_type=?, promo_rule=?, is_active=?, updated_at=?, synced_rev=rev
              WHERE id=?
            `).run(
              p.sku || String(p.barcode), String(p.name), p.brand || null, p.category || 'Abarrotes',
              Math.max(0, Number(p.cost) || 0), Math.max(0, Number(p.price) || 0),
              Math.max(0, parseInt(p.stock, 10) || 0), Math.max(0, parseInt(p.min_stock, 10) || 5),
              p.icon_type || 'bread', promoText, p.is_active === false ? 0 : 1, p.updated_at, local.id
            );
            pulled.products++;
          }
        }
      });
    }

    // 2. Cortes de caja históricos / recientes
    const { data: cloudCuts, error: cErr } = await supabaseClient.from('cash_cuts').select('*').order('id');
    if (!cErr && Array.isArray(cloudCuts) && cloudCuts.length > 0) {
      tx((dbTx) => {
        for (const c of cloudCuts) {
          if (!c || !c.terminal_code) continue;
          const exists = dbTx.prepare('SELECT id FROM cash_cuts WHERE id = ? OR (terminal_code = ? AND opened_at = ?)').get(c.id, c.terminal_code, c.opened_at);
          if (!exists) {
            if (c.status === 'open' && getOpenCut(dbTx, c.terminal_code)) continue;
            dbTx.prepare(`
              INSERT OR IGNORE INTO cash_cuts (
                id, terminal_code, terminal_name, cashier_name, status, opened_at, closed_at, closed_by,
                initial_fund, total_sales_count, total_sales_amount, cash_sales, card_sales, transfer_sales, mixed_sales,
                cash_inflows, cash_outflows, supplier_payouts, expected_cash, counted_cash, difference, notes, updated_at, rev, synced_rev
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(
              c.id, c.terminal_code, c.terminal_name || (c.terminal_code === 'C2' ? 'Caja 2' : 'Caja 1'),
              c.cashier_name || 'Administrador', c.status === 'closed' ? 'closed' : 'open',
              c.opened_at || nowIso(), c.closed_at || null, c.closed_by || null,
              Number(c.initial_fund) || 0, Number(c.total_sales_count) || 0, Number(c.total_sales_amount) || 0,
              Number(c.cash_sales) || 0, Number(c.card_sales) || 0, Number(c.transfer_sales) || 0, Number(c.mixed_sales) || 0,
              Number(c.cash_inflows) || 0, Number(c.cash_outflows) || 0, Number(c.supplier_payouts) || 0,
              Number(c.expected_cash) || 0, c.counted_cash != null ? Number(c.counted_cash) : null,
              c.difference != null ? Number(c.difference) : null, c.notes || null, c.updated_at || nowIso(), 1, 1
            );
            pulled.cash_cuts++;
          }
        }
      });
    }

    // 3. Ventas e ítems faltantes desde Supabase
    const { data: cloudSales, error: sErr } = await supabaseClient.from('sales').select('*').order('id', { ascending: false }).limit(200);
    if (!sErr && Array.isArray(cloudSales) && cloudSales.length > 0) {
      tx((dbTx) => {
        for (const s of cloudSales) {
          if (!s || !s.folio) continue;
          const dup = dbTx.prepare('SELECT id FROM sales WHERE folio = ?').get(s.folio);
          if (dup) continue;
          let cutRow = s.cash_cut_id ? dbTx.prepare('SELECT id FROM cash_cuts WHERE id = ?').get(s.cash_cut_id) : null;
          if (!cutRow) {
            cutRow = dbTx.prepare('SELECT id FROM cash_cuts WHERE terminal_code = ? ORDER BY id DESC LIMIT 1').get(s.terminal_code || 'C1');
          }
          if (!cutRow) continue;
          const info = dbTx.prepare(`
            INSERT OR IGNORE INTO sales (
              folio, cash_cut_id, terminal_code, terminal_name, cashier_name, total_items, total_pieces,
              subtotal, discount, total_net, payment_method, cash_amount, card_amount, transfer_amount,
              cash_received, cash_change, status, created_at, updated_at, rev, synced_rev
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)
          `).run(
            s.folio, cutRow.id, s.terminal_code || 'C1', s.terminal_name || 'Caja 1', s.cashier_name || 'Cajero',
            Math.max(1, Number(s.total_items) || 1), Math.max(1, Number(s.total_pieces) || 1),
            Number(s.subtotal) || 0, Number(s.discount) || 0, Number(s.total_net) || 0,
            PAYMENT_METHODS.includes(s.payment_method) ? s.payment_method : 'cash',
            Number(s.cash_amount) || 0, Number(s.card_amount) || 0, Number(s.transfer_amount) || 0,
            s.cash_received != null ? Number(s.cash_received) : null,
            s.cash_change != null ? Number(s.cash_change) : null,
            s.status === 'cancelled' ? 'cancelled' : 'completed',
            s.created_at || nowIso(), s.updated_at || nowIso()
          );
          if (info.changes > 0) pulled.sales++;
        }
      });
    }

    setConfig('last_cloud_pull', nowIso());
    return { ok: true, pulled };
  } catch (err) {
    console.warn('[SYNC CLOUD -> LOCAL] Advertencia:', err.message);
    return { ok: false, error: err.message };
  }
}

async function syncStartup(supabaseClient) {
  initLocalDatabase();
  const pullRes = await pullFromCloudSync(supabaseClient);
  const seedRes = ensureStarterCatalog();
  if (supabaseClient && seedRes && seedRes.seeded) {
    try { await performCloudBackup(supabaseClient); } catch (_) {}
  }
  return { ok: true, pullRes, seedRes };
}

/**
 * Respaldo periódico incremental a Supabase (Plan Free)
 * Sube únicamente los registros modificados (rev > synced_rev) sin saturar conexiones ni cuotas
 */
async function performCloudBackup(supabaseClient) {
  if (!supabaseClient) {
    return { ok: false, error: 'Cliente de Supabase no configurado.' };
  }
  if (isCloudBackingUp) {
    return { ok: false, message: 'Respaldo ya en progreso.' };
  }

  isCloudBackingUp = true;
  const d = initLocalDatabase();
  const summary = { synced: {}, errors: [] };

  try {
    for (const t of SYNC_TABLES) {
      const rows = d.prepare(`SELECT * FROM ${t.name} WHERE rev > synced_rev ORDER BY ${t.pk} ASC LIMIT 200`).all();
      if (rows.length === 0) continue;

      const payload = rows.map(r => {
        const copy = { ...r };
        delete copy.rev;
        delete copy.synced_rev;
        return copy;
      });

      let { error } = await supabaseClient
        .from(t.name)
        .upsert(payload, { onConflict: t.pk });

      // Si cash_movements en Supabase aún no tiene las columnas extendidas, reintentar con columnas base
      if (error && t.name === 'cash_movements' && /column|schema cache/i.test(error.message)) {
        const basePayload = payload.map(r => ({
          id: r.id,
          cash_cut_id: r.cash_cut_id,
          terminal_code: r.terminal_code,
          movement_type: r.movement_type,
          amount: r.amount,
          concept: r.concept,
          user_name: r.user_name,
          created_at: r.created_at,
          updated_at: r.updated_at
        }));
        const retry = await supabaseClient.from(t.name).upsert(basePayload, { onConflict: t.pk });
        error = retry.error;
      }

      if (error) {
        console.warn(`[RESPALDO SUPABASE] Error en tabla ${t.name}:`, error.message);
        summary.errors.push({ table: t.name, error: error.message });
      } else {
        const pks = rows.map(r => r[t.pk]);
        const placeholders = pks.map(() => '?').join(',');
        d.prepare(`UPDATE ${t.name} SET synced_rev = rev WHERE ${t.pk} IN (${placeholders})`).run(...pks);
        summary.synced[t.name] = rows.length;
      }
    }

    const now = nowIso();
    setConfig('last_cloud_sync', now);
    if (summary.errors.length > 0) {
      setConfig('last_cloud_error', JSON.stringify(summary.errors));
    } else {
      setConfig('last_cloud_error', null);
    }

    return { ok: true, timestamp: now, summary };
  } catch (err) {
    console.error('[RESPALDO SUPABASE] Fallo general:', err.message);
    setConfig('last_cloud_error', err.message);
    return { ok: false, error: err.message };
  } finally {
    isCloudBackingUp = false;
  }
}

module.exports = {
  PosError,
  TERMINALS,
  SYNC_TABLES,
  initLocalDatabase,
  getDb: initLocalDatabase,
  getDataVersion,
  // usuarios
  listCashiers, registerCashier, login, logout, getSessionUser, changeAdminPin,
  // productos
  getProducts, findProductByBarcode, searchProducts, saveProduct, deleteProduct,
  registerStockEntry, registerShrinkage, getShrinkageHistory,
  lookupReceivingCode, receiveStock, receiveInvoice, isInvoiceReceived,
  getPackages, savePackage, deletePackage,
  // Movimientos de caja
  getCashMovements, saveCashMovement, deleteCashMovement,
  // turnos y ventas
  getTerminalShift, openTerminalShift, closeTerminalShift, registerCashMovement,
  processSale, cancelSale, getSales,
  // reportes y respaldo
  getReports, getCashCut, createLocalSnapshot, getBackupStatus, performCloudBackup,
  pullFromCloudSync, syncStartup, ensureStarterCatalog, setConfig, getConfig
};
