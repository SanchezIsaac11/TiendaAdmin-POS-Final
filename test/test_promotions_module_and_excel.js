/**
 * TEST DE INTEGRACIÓN: MÓDULO DE PROMOCIONES + EXCEL + SIMPLIFICACIÓN UI
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `pos_test_promos_${Date.now()}.sqlite`);
process.env.LOCAL_DB_FILE = tmpDb;
process.env.LOCAL_BACKUP_DIR = path.join(os.tmpdir(), `pos_test_backups_${Date.now()}`);

const localDb = require('../database/localDb');
const promotionsDb = require('../database/promotions');
const PosPromotions = require('../www/js/promotions');
const { buildSpreadsheetMl, exportToExcel } = require('../www/js/app/excelExport');

console.log('================================================================');
console.log('TEST SUITE: MÓDULO DE PROMOCIONES, EXCEL Y VALIDACIÓN UI');
console.log('================================================================');

try {
  // 1. CRUD de promociones en SQLite
  const db = localDb.initLocalDatabase();
  const prod = localDb.saveProduct({
    barcode: '7501055300075',
    name: 'Coca-Cola Original 600ml',
    category: 'Bebidas y Refrescos',
    cost: 12,
    price: 18,
    stock: 50
  });

  const pBundle = promotionsDb.createPromotion({
    nombre: 'Coca 3 x $45',
    tipo: 'bundle',
    alcance: 'producto',
    alcance_valor: prod.barcode,
    cantidad: 3,
    precio: 45,
    activa: true
  });
  assert(pBundle.id > 0, 'Debe crear promoción bundle');

  const pCatPercent = promotionsDb.createPromotion({
    nombre: '10% en Bebidas desde 6 pzas',
    tipo: 'percent',
    alcance: 'categoria',
    alcance_valor: 'Bebidas y Refrescos',
    cantidad: 6,
    porcentaje: 10,
    activa: true
  });
  assert(pCatPercent.tipo === 'percent', 'Debe crear promoción por categoría');

  // Toggle active
  const toggled = promotionsDb.setPromotionActive(pCatPercent.id, false);
  assert.strictEqual(toggled.activa, false, 'Debe desactivar promoción');
  promotionsDb.setPromotionActive(pCatPercent.id, true);

  console.log('✓ 1. CRUD completo de promociones en SQLite verificado.');

  // 2. Consistencia Frontend (PosPromotions) vs Backend (processSale)
  const activeList = promotionsDb.listPromotions({ soloActivas: true });
  PosPromotions.setPromotions(activeList);

  const eval3 = PosPromotions.evaluateCart([{
    barcode: prod.barcode,
    category: prod.category,
    unitPrice: 18,
    quantity: 3
  }]);
  assert.strictEqual(eval3.totalDiscount, 9, '3 x $45 vs $54 normal debe descontar $9');

  // Verificar cobro en localDb.processSale usando exactamente ese descuento
  const openShift = localDb.openTerminalShift('C1', 1000, { id: 1, full_name: 'Admin Test' });
  const sale = localDb.processSale({
    terminal_code: 'C1',
    folio: '#TK-PROMO-TEST-1',
    payment_method: 'cash',
    total_net: 45,
    cash_received: 50,
    items: [{ id: prod.id, barcode: prod.barcode, name: prod.name, quantity: 3, unitPrice: 18 }]
  }, { id: 1, full_name: 'Admin Test' });

  assert(sale.ok && sale.total_net === 45 && sale.discount === 9, 'Backend debe calcular y guardar exactamente $9 de descuento y $45 neto');

  // Prueba de seguridad: promo bundle más cara que el precio normal no cobra de más
  const pBadBundle = promotionsDb.createPromotion({
    nombre: 'Bundle caro',
    tipo: 'bundle',
    alcance: 'producto',
    alcance_valor: prod.barcode,
    cantidad: 2,
    precio: 50, // 2 x $18 = $36 normal < $50
    activa: true
  });
  PosPromotions.setPromotions(promotionsDb.listPromotions({ soloActivas: true }));
  const eval2 = PosPromotions.evaluateItem({ barcode: prod.barcode, unitPrice: 18, quantity: 2 });
  assert.strictEqual(eval2, null, 'Nunca debe aplicar descuento negativo ni encarecer el carrito');
  promotionsDb.deletePromotion(pBadBundle.id);

  console.log('✓ 2. Motor de promociones 100% consistente entre frontend y backend.');

  // 3. Exportador Excel SpreadsheetML (.xls)
  const xml = buildSpreadsheetMl({
    sheetName: 'Ventas/Diarias:Prueba',
    headers: ['Producto', 'Cantidad', 'Total'],
    rows: [['Leche & Pan <Frescos>', 2, { value: 45.5, currency: true }]]
  });
  assert(xml.includes('xmlns="urn:schemas-microsoft-com:office:spreadsheet"'), 'Debe generar encabezado Excel SpreadsheetML');
  assert(xml.includes('Leche &amp; Pan &lt;Frescos&gt;'), 'Debe escapar XML en celdas');
  assert(xml.includes('<Data ss:Type="Number">45.5</Data>'), 'Debe tipar montos como número');
  const exp = exportToExcel({ filename: 'reporte_ventas.csv', headers: ['A'], rows: [['B']] });
  assert.strictEqual(exp.filename, 'reporte_ventas.xls', 'Debe usar extensión .xls en lugar de .csv');

  console.log('✓ 3. Helper de exportación a Excel (.xls) validado.');

  // 4. Verificaciones de UI en HTML/JS
  const rootDir = path.join(__dirname, '..');
  const posHtml = fs.readFileSync(path.join(rootDir, 'www/pos.html'), 'utf8');
  const cashMovHtml = fs.readFileSync(path.join(rootDir, 'www/cashMovements/cashMovements.html'), 'utf8');
  const cashMovJs = fs.readFileSync(path.join(rootDir, 'www/js/app/cashMovements.js'), 'utf8');

  assert(posHtml.includes('id="promotionsViewContainer"'), 'pos.html debe incluir la vista de Promociones');
  assert(posHtml.includes('id="navPromotionsBtn"'), 'Sidebar debe incluir botón Promociones');
  assert(!posHtml.includes('Registro de transacciones en tiempo real'), 'Debe eliminarse subtítulo de Historial de Ventas');
  assert(!posHtml.includes('Turno en curso'), 'Debe eliminarse "Turno en curso" en Corte de Caja');
  assert(!posHtml.includes('class="th-h-folio"'), 'Debe eliminarse columna FOLIO en tabla de Historial de Ventas');
  assert(!posHtml.includes('class="btn-bill"'), 'Calculadora de efectivo debe estar simplificada sin botones de billetes');
  assert(posHtml.includes('id="historyDateInput"'), 'Historial debe tener selector de fecha para habilitar Excel');
  assert(!cashMovHtml.includes('Registro y control de entradas y salidas de dinero adicionales a las ventas'), 'Subtítulo debe haberse eliminado de cashMovements.html');
  assert(!cashMovHtml.includes('Exportar CSV'), 'cashMovements.html debe usar Excel en lugar de CSV');
  assert(!cashMovJs.includes('Registro y control de entradas y salidas de dinero adicionales a las ventas'), 'Fallback en cashMovements.js tampoco debe tener el subtítulo');
  assert(!cashMovJs.includes('<span>Exportar CSV</span>'), 'Fallback en cashMovements.js debe usar Exportar Excel');

  console.log('✓ 4. Verificaciones de simplificación UI y limpieza completadas.');
  console.log('\n================================================================');
  console.log('RESULTADO: TODAS LAS PRUEBAS DE PROMOCIONES, EXCEL Y UI PASARON (100%)');
  console.log('================================================================');
} finally {
  try { localDb.closeLocalDatabase(); } catch (_) {}
  [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`].forEach((f) => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  });
}
