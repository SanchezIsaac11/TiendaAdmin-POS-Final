/**
 * ==============================================================================
 * MÓDULO DE PROMOCIONES - CAPA DE DATOS (SQLite local, misma BD que el POS)
 * ==============================================================================
 * Guarda las reglas promocionales en la tabla `promociones` de pos_local.sqlite.
 * Tipos soportados:
 *   bundle  -> "Lleva N por $X"          (ej. Coca-Cola 3 por $45)
 *   nxm     -> "Lleva N y paga M"        (ej. 2x1, 3x2)
 *   percent -> "% de descuento"          (opcional: desde N piezas)
 *   monto   -> "$ menos por pieza"       (opcional: desde N piezas)
 *   volume  -> "Mayoreo: desde N pzas a $X c/u"
 * Alcance: un producto (código de barras), una categoría o toda la tienda.
 * Vigencia: fechas, días de la semana y horario (todo opcional).
 * ==============================================================================
 */

const localDb = require('./localDb');

const TIPOS = ['bundle', 'nxm', 'percent', 'monto', 'volume'];
const ALCANCES = ['producto', 'categoria', 'todo'];

let tableReady = false;

/** Devuelve la conexión SQLite y se asegura de que la tabla exista. */
function getDb() {
  const d = localDb.initLocalDatabase();
  if (!tableReady) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS promociones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        alcance TEXT NOT NULL DEFAULT 'producto',
        alcance_valor TEXT DEFAULT '',
        cantidad INTEGER NOT NULL DEFAULT 1,
        cantidad_paga INTEGER NOT NULL DEFAULT 0,
        precio REAL NOT NULL DEFAULT 0.00,
        porcentaje REAL NOT NULL DEFAULT 0.00,
        fecha_inicio TEXT DEFAULT '',
        fecha_fin TEXT DEFAULT '',
        dias_semana TEXT DEFAULT '',
        hora_inicio TEXT DEFAULT '',
        hora_fin TEXT DEFAULT '',
        activa INTEGER NOT NULL DEFAULT 1,
        fecha_creacion TEXT DEFAULT (datetime('now', 'localtime')),
        fecha_actualizacion TEXT DEFAULT (datetime('now', 'localtime'))
      );
    `);
    d.exec('CREATE INDEX IF NOT EXISTS idx_promociones_activa ON promociones(activa);');
    tableReady = true;
  }
  return d;
}

// ------------------------------------------------------------------------------
// VALIDACIÓN Y NORMALIZACIÓN
// ------------------------------------------------------------------------------

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function num(v, def = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function int(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/**
 * Valida el cuerpo recibido y lo convierte al formato de la tabla.
 * Lanza Error con mensaje en español si algo no es válido.
 */
function normalizePromotion(input = {}) {
  const nombre = String(input.nombre || '').trim();
  if (!nombre) throw new Error('El nombre de la promoción es obligatorio.');
  if (nombre.length > 80) throw new Error('El nombre no puede pasar de 80 caracteres.');

  const tipo = String(input.tipo || '').trim();
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de promoción no válido.');

  const alcance = String(input.alcance || 'producto').trim();
  if (!ALCANCES.includes(alcance)) throw new Error('Alcance de promoción no válido.');

  let alcanceValor = String(input.alcance_valor || '').trim();
  if (alcance === 'todo') alcanceValor = '';
  if (alcance !== 'todo' && !alcanceValor) {
    throw new Error(alcance === 'producto'
      ? 'Selecciona el producto al que aplica la promoción.'
      : 'Selecciona la categoría a la que aplica la promoción.');
  }

  let cantidad = int(input.cantidad, 1);
  let cantidadPaga = int(input.cantidad_paga, 0);
  let precio = Math.round(num(input.precio) * 100) / 100;
  let porcentaje = Math.round(num(input.porcentaje) * 100) / 100;

  switch (tipo) {
    case 'bundle':
      if (cantidad < 2) throw new Error('La promoción por paquete requiere al menos 2 piezas.');
      if (precio <= 0) throw new Error('Indica el precio del paquete.');
      cantidadPaga = 0; porcentaje = 0;
      break;
    case 'nxm':
      if (cantidad < 2) throw new Error('"Lleva N" debe ser de al menos 2 piezas.');
      if (cantidadPaga < 1 || cantidadPaga >= cantidad) {
        throw new Error('"Paga M" debe ser mayor a 0 y menor que las piezas que se llevan.');
      }
      precio = 0; porcentaje = 0;
      break;
    case 'percent':
      if (porcentaje <= 0 || porcentaje > 100) throw new Error('El porcentaje debe estar entre 0 y 100.');
      if (cantidad < 1) cantidad = 1;
      cantidadPaga = 0; precio = 0;
      break;
    case 'monto':
      if (precio <= 0) throw new Error('Indica cuántos pesos se descuentan por pieza.');
      if (cantidad < 1) cantidad = 1;
      cantidadPaga = 0; porcentaje = 0;
      break;
    case 'volume':
      if (cantidad < 2) throw new Error('El mayoreo requiere al menos 2 piezas.');
      if (precio <= 0) throw new Error('Indica el precio por pieza de mayoreo.');
      cantidadPaga = 0; porcentaje = 0;
      break;
  }

  const fechaInicio = String(input.fecha_inicio || '').trim();
  const fechaFin = String(input.fecha_fin || '').trim();
  if (fechaInicio && !RE_FECHA.test(fechaInicio)) throw new Error('Fecha de inicio no válida.');
  if (fechaFin && !RE_FECHA.test(fechaFin)) throw new Error('Fecha de fin no válida.');
  if (fechaInicio && fechaFin && fechaFin < fechaInicio) {
    throw new Error('La fecha de fin no puede ser anterior a la de inicio.');
  }

  const horaInicio = String(input.hora_inicio || '').trim();
  const horaFin = String(input.hora_fin || '').trim();
  if ((horaInicio && !RE_HORA.test(horaInicio)) || (horaFin && !RE_HORA.test(horaFin))) {
    throw new Error('Horario no válido (usa formato HH:MM).');
  }
  if (Boolean(horaInicio) !== Boolean(horaFin)) {
    throw new Error('Indica la hora de inicio y la de fin, o deja ambas vacías.');
  }

  // dias_semana: lista de 0-6 (0 = domingo). Acepta arreglo o texto "1,2,3".
  const diasRaw = Array.isArray(input.dias_semana)
    ? input.dias_semana
    : String(input.dias_semana || '').split(',');
  const dias = [...new Set(
    diasRaw.map(x => parseInt(String(x).trim(), 10)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
  )].sort((a, b) => a - b);

  const activa = (input.activa === undefined || input.activa === null)
    ? 1
    : ((input.activa === true || input.activa === 1 || input.activa === '1' || input.activa === 'true') ? 1 : 0);

  return {
    nombre,
    tipo,
    alcance,
    alcance_valor: alcanceValor,
    cantidad,
    cantidad_paga: cantidadPaga,
    precio,
    porcentaje,
    fecha_inicio: fechaInicio,
    fecha_fin: fechaFin,
    dias_semana: dias.join(','),
    hora_inicio: horaInicio,
    hora_fin: horaFin,
    activa
  };
}

function mapRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    nombre: r.nombre,
    tipo: r.tipo,
    alcance: r.alcance,
    alcance_valor: r.alcance_valor || '',
    cantidad: r.cantidad,
    cantidad_paga: r.cantidad_paga,
    precio: r.precio,
    porcentaje: r.porcentaje,
    fecha_inicio: r.fecha_inicio || '',
    fecha_fin: r.fecha_fin || '',
    dias_semana: r.dias_semana || '',
    hora_inicio: r.hora_inicio || '',
    hora_fin: r.hora_fin || '',
    activa: r.activa === 1,
    fecha_creacion: r.fecha_creacion,
    fecha_actualizacion: r.fecha_actualizacion
  };
}

// ------------------------------------------------------------------------------
// CRUD
// ------------------------------------------------------------------------------

function listPromotions({ soloActivas = false } = {}) {
  const d = getDb();
  const sql = soloActivas
    ? 'SELECT * FROM promociones WHERE activa = 1 ORDER BY id DESC'
    : 'SELECT * FROM promociones ORDER BY activa DESC, id DESC';
  return d.prepare(sql).all().map(mapRow);
}

function getPromotion(id) {
  const d = getDb();
  return mapRow(d.prepare('SELECT * FROM promociones WHERE id = ?').get(int(id)));
}

function createPromotion(input) {
  const d = getDb();
  const p = normalizePromotion(input);
  const info = d.prepare(`
    INSERT INTO promociones
      (nombre, tipo, alcance, alcance_valor, cantidad, cantidad_paga, precio, porcentaje,
       fecha_inicio, fecha_fin, dias_semana, hora_inicio, hora_fin, activa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.nombre, p.tipo, p.alcance, p.alcance_valor, p.cantidad, p.cantidad_paga, p.precio, p.porcentaje,
    p.fecha_inicio, p.fecha_fin, p.dias_semana, p.hora_inicio, p.hora_fin, p.activa
  );
  return getPromotion(Number(info.lastInsertRowid));
}

function updatePromotion(id, input) {
  const d = getDb();
  const existing = getPromotion(id);
  if (!existing) throw Object.assign(new Error('Promoción no encontrada.'), { status: 404 });

  // Permite ediciones parciales: lo no enviado conserva su valor actual.
  const p = normalizePromotion({ ...existing, ...input });
  d.prepare(`
    UPDATE promociones SET
      nombre = ?, tipo = ?, alcance = ?, alcance_valor = ?, cantidad = ?, cantidad_paga = ?,
      precio = ?, porcentaje = ?, fecha_inicio = ?, fecha_fin = ?, dias_semana = ?,
      hora_inicio = ?, hora_fin = ?, activa = ?,
      fecha_actualizacion = (datetime('now', 'localtime'))
    WHERE id = ?
  `).run(
    p.nombre, p.tipo, p.alcance, p.alcance_valor, p.cantidad, p.cantidad_paga,
    p.precio, p.porcentaje, p.fecha_inicio, p.fecha_fin, p.dias_semana,
    p.hora_inicio, p.hora_fin, p.activa, existing.id
  );
  return getPromotion(existing.id);
}

function setPromotionActive(id, activa) {
  const d = getDb();
  const existing = getPromotion(id);
  if (!existing) throw Object.assign(new Error('Promoción no encontrada.'), { status: 404 });
  d.prepare(`
    UPDATE promociones SET activa = ?, fecha_actualizacion = (datetime('now', 'localtime')) WHERE id = ?
  `).run(activa ? 1 : 0, existing.id);
  return getPromotion(existing.id);
}

function deletePromotion(id) {
  const d = getDb();
  const existing = getPromotion(id);
  if (!existing) throw Object.assign(new Error('Promoción no encontrada.'), { status: 404 });
  d.prepare('DELETE FROM promociones WHERE id = ?').run(existing.id);
  return { id: existing.id, deleted: true };
}

module.exports = {
  TIPOS,
  ALCANCES,
  normalizePromotion,
  listPromotions,
  getPromotion,
  createPromotion,
  updatePromotion,
  setPromotionActive,
  deletePromotion
};
