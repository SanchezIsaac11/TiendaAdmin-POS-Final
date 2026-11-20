/**
 * ==============================================================================
 * API REST DE PROMOCIONES  ->  /api/promociones
 * ==============================================================================
 *   GET    /api/promociones              Lista (agrega ?activas=1 para solo activas)
 *   GET    /api/promociones/:id          Detalle
 *   POST   /api/promociones              Crear
 *   PUT    /api/promociones/:id          Editar (acepta cambios parciales)
 *   PATCH  /api/promociones/:id/activa   Activar / desactivar  { "activa": true }
 *   DELETE /api/promociones/:id          Eliminar
 * ==============================================================================
 */

const express = require('express');
const promotions = require('../database/promotions');

const router = express.Router();

function sendError(res, err) {
  const status = err.status || 400;
  if (status >= 500) console.error('[PROMOCIONES]', err);
  res.status(status).json({ ok: false, error: err.message });
}

router.get('/', (req, res) => {
  try {
    const soloActivas = ['1', 'true'].includes(String(req.query.activas || ''));
    const list = promotions.listPromotions({ soloActivas });
    res.json({ ok: true, count: list.length, promotions: list });
  } catch (err) {
    sendError(res, Object.assign(err, { status: 500 }));
  }
});

router.get('/:id', (req, res) => {
  try {
    const promo = promotions.getPromotion(req.params.id);
    if (!promo) return res.status(404).json({ ok: false, error: 'Promoción no encontrada.' });
    res.json({ ok: true, promotion: promo });
  } catch (err) {
    sendError(res, Object.assign(err, { status: 500 }));
  }
});

router.post('/', (req, res) => {
  try {
    const promo = promotions.createPromotion(req.body || {});
    console.log(`[PROMOCIONES] Creada #${promo.id}: ${promo.nombre}`);
    res.status(201).json({ ok: true, promotion: promo });
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:id', (req, res) => {
  try {
    const promo = promotions.updatePromotion(req.params.id, req.body || {});
    res.json({ ok: true, promotion: promo });
  } catch (err) {
    sendError(res, err);
  }
});

router.patch('/:id/activa', (req, res) => {
  try {
    const body = req.body || {};
    const activa = body.activa === true || body.activa === 1 || body.activa === '1' || body.activa === 'true';
    const promo = promotions.setPromotionActive(req.params.id, activa);
    res.json({ ok: true, promotion: promo });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = promotions.deletePromotion(req.params.id);
    console.log(`[PROMOCIONES] Eliminada #${result.id}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
