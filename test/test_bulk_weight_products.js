/**
 * TEST SUITE: PRODUCTOS SUELTOS / A GRANEL POR KILOGRAMO (kg)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `pos_test_bulk_${Date.now()}.sqlite`);
process.env.LOCAL_DB_FILE = tmpDb;
process.env.LOCAL_BACKUP_DIR = path.join(os.tmpdir(), `pos_test_bulk_backups_${Date.now()}`);

const localDb = require('../database/localDb');
const promotionsDb = require('../database/promotions');
const PosPromotions = require('../www/js/promotions');

console.log('================================================================');
console.log('TEST SUITE: PRODUCTOS SUELTOS / A GRANEL (VENTA POR KG)');
console.log('================================================================');

try {
  localDb.initLocalDatabase();
  const user = { id: 1, full_name: 'Admin Test' };
  localDb.openTerminalShift('C1', 1000, user);

  // 1. Registrar producto por kilo y producto normal por pieza
  const manzana = localDb.saveProduct({
    barcode: '750999000111',
    name: 'Manzana Roja',
    category: 'Frutas y Verduras',
    sale_type: 'bulk',
    cost: 30,
    price: 45.00,
    stock: 10.5
  }, user.full_name);

  assert.strictEqual(manzana.saleType, 'bulk', 'Debe guardarse como producto a granel');
  assert.strictEqual(manzana.unitLabel, 'kg', 'Unidad debe ser kg');
  assert.strictEqual(manzana.price, 45, 'Precio por kilo configurado en $45.00');
  assert.strictEqual(manzana.stock, 10.5, 'Stock inicial fraccionario debe conservarse en 10.5 kg');

  const refresco = localDb.saveProduct({
    barcode: '750999000222',
    name: 'Refresco 600ml',
    category: 'Bebidas y Refrescos',
    sale_type: 'unit',
    cost: 12,
    price: 18,
    stock: 10
  }, user.full_name);

  assert.strictEqual(refresco.saleType, 'unit');
  assert.strictEqual(refresco.unitLabel, 'uds');

  console.log('✓ 1. Alta de producto a granel por kg (stock decimal y precio/kg) verificada.');

  // 2. Validar rechazo decimal en producto por pieza y aceptación en producto por kg
  assert.throws(() => {
    localDb.processSale({
      terminal_code: 'C1',
      folio: '#TK-BULK-ERR-1',
      payment_method: 'cash',
      total_net: 27,
      cash_received: 50,
      items: [{ id: refresco.id, barcode: refresco.barcode, name: refresco.name, quantity: 1.5, unitPrice: 18 }]
    }, user);
  }, /entero/, 'Producto normal debe seguir rechazando cantidades fraccionarias');

  // Venta de 0.75 kg de Manzana a $45/kg = $33.75
  const saleBulk = localDb.processSale({
    terminal_code: 'C1',
    folio: '#TK-BULK-OK-1',
    payment_method: 'cash',
    total_net: 33.75,
    cash_received: 50,
    items: [{ id: manzana.id, barcode: manzana.barcode, name: manzana.name, quantity: 0.75, unitPrice: 45 }]
  }, user);

  assert(saleBulk.ok && saleBulk.total_net === 33.75, 'Debe cobrar exactamente $33.75 por 0.75 kg');
  const afterSale = localDb.findProductByBarcode(manzana.barcode);
  assert.strictEqual(afterSale.stock, 9.75, 'Stock restante debe ser exactamente 9.75 kg (10.5 - 0.75)');

  console.log('✓ 2. Venta por peso fraccionario (0.75 kg) y cálculo exacto verificados.');

  // 3. Promoción de porcentaje sobre producto a granel
  promotionsDb.createPromotion({
    nombre: '10% en Frutas y Verduras',
    tipo: 'percent',
    alcance: 'categoria',
    alcance_valor: 'Frutas y Verduras',
    cantidad: 1,
    porcentaje: 10,
    activa: true
  });
  PosPromotions.setPromotions(promotionsDb.listPromotions({ soloActivas: true }));

  const promoEval = PosPromotions.evaluateCart([{
    barcode: manzana.barcode,
    category: manzana.category,
    saleType: 'bulk',
    unitPrice: 45,
    quantity: 0.5 // $22.50 - 10% ($2.25) = $20.25
  }]);
  assert.strictEqual(promoEval.totalDiscount, 2.25, 'Promoción % debe funcionar con cantidades decimales');

  // Confirmar también 10% con qty=0.4 (menor a 1kg): si cantidad mínima=1, no aplica; con 1.2kg sí aplica
  const promoEval2 = PosPromotions.evaluateCart([{
    barcode: manzana.barcode,
    category: manzana.category,
    saleType: 'bulk',
    unitPrice: 45,
    quantity: 1.2 // $54.00 - 10% = $5.40 descuento, $48.60 neto
  }]);
  assert.strictEqual(promoEval2.totalDiscount, 5.4, 'Promoción % desde 1kg debe aplicar en 1.2kg');

  const salePromo = localDb.processSale({
    terminal_code: 'C1',
    folio: '#TK-BULK-PROMO-1',
    payment_method: 'cash',
    total_net: 48.60,
    cash_received: 50,
    items: [{ id: manzana.id, barcode: manzana.barcode, name: manzana.name, quantity: 1.2, unitPrice: 45 }]
  }, user);
  assert(salePromo.ok && salePromo.total_net === 48.60 && salePromo.discount === 5.4);

  console.log('✓ 3. Promociones sobre productos por peso verificadas en frontend y backend.');

  // 4. Entrada, merma y cancelación fraccionaria
  const entry = localDb.registerStockEntry(manzana.id, 2.25, 32, user.full_name);
  assert.strictEqual(entry.newStock, 10.8, '9.75 - 1.2 = 8.55; + 2.25 = 10.8 kg');

  const shrink = localDb.registerShrinkage(manzana.id, 0.3, 'caducado', user.full_name);
  assert.strictEqual(shrink.newStock, 10.5, '10.8 - 0.3 = 10.5 kg exactos');

  localDb.cancelSale('#TK-BULK-OK-1', 'Devolución cliente', user);
  const restored = localDb.findProductByBarcode(manzana.barcode);
  assert.strictEqual(restored.stock, 11.25, 'Cancelación debe restituir los 0.75 kg exactos');

  console.log('✓ 4. Entradas, mermas y cancelación fraccionaria (kg) verificadas.');
  console.log('\n================================================================');
  console.log('RESULTADO: TODAS LAS PRUEBAS DE VENTA A GRANEL PASARON (100%)');
  console.log('================================================================');
} finally {
  try { localDb.closeLocalDatabase(); } catch (_) {}
  [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`].forEach((f) => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  });
}
