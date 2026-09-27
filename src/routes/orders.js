const express = require('express');
const { requireAuth } = require('../auth');
const { tx } = require('../db');
const { AVAILABLE_SQL } = require('./shops');
const { fail, toNum, toInt, checkDate, wrap } = require('../util');

// Transitions autorisées pour la vendeuse
const VENDOR_STATUSES = ['confirmed', 'preparing', 'delivering', 'done', 'cancelled'];

module.exports = (db) => {
  const r = express.Router();

  const itemsOf = db.prepare('SELECT dish_id, name, quantity, unit_price FROM order_items WHERE order_id = ?');
  const withItems = (orders) => orders.map((o) => ({ ...o, items: itemsOf.all(o.id) }));

  r.post('/orders', requireAuth(), wrap((req, res) => {
    const b = req.body;
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(b.shop_id);
    if (!shop) fail(404, 'Point de vente introuvable');
    const date = checkDate(b.date);
    const mode = b.mode === 'delivery' ? 'delivery' : 'pickup';
    const lat = toNum(b.lat);
    const lng = toNum(b.lng);
    if (mode === 'delivery') {
      if (!shop.delivery) fail(400, "Ce point de vente ne livre pas");
      if ((lat === null || lng === null) && !b.address) fail(400, 'Localisation ou adresse requise pour la livraison');
    }
    const wanted = (Array.isArray(b.items) ? b.items : [])
      .map((i) => ({ dish_id: toInt(i.dish_id), quantity: toInt(i.quantity) }))
      .filter((i) => i.quantity > 0);
    if (!wanted.length) fail(400, 'Votre commande est vide');

    const order = tx(db, () => {
      const available = new Map(db.prepare(AVAILABLE_SQL).all(shop.id, date).map((d) => [d.id, d]));
      let total = 0;
      for (const w of wanted) {
        const d = available.get(w.dish_id);
        if (!d) fail(400, `Un plat n'est pas disponible le ${date}`);
        if (d.remaining !== null && w.quantity > d.remaining) {
          fail(409, `Plus assez de « ${d.name} » (reste ${Math.max(d.remaining, 0)})`);
        }
        total += d.price * w.quantity;
      }
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO orders (client_id, shop_id, date, mode, lat, lng, address, phone, note, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        req.user.id, shop.id, date, mode, lat, lng, b.address || null,
        b.phone || req.user.phone || null, b.note || null, total,
      );
      const ins = db.prepare('INSERT INTO order_items (order_id, dish_id, name, quantity, unit_price) VALUES (?, ?, ?, ?, ?)');
      for (const w of wanted) {
        const d = available.get(w.dish_id);
        ins.run(lastInsertRowid, d.id, d.name, w.quantity, d.price);
      }
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(lastInsertRowid);
    });
    res.status(201).json(withItems([order])[0]);
  }));

  r.get('/orders/mine', requireAuth(), (req, res) => {
    const rows = db.prepare(`SELECT o.*, s.name AS shop_name, s.phone AS shop_phone, s.lat AS shop_lat, s.lng AS shop_lng
      FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.client_id = ? ORDER BY o.created_at DESC, o.id DESC`).all(req.user.id);
    res.json(withItems(rows));
  });

  // Commandes reçues par la vendeuse (toutes ses boutiques), filtrables par date / statut
  r.get('/orders/received', requireAuth('vendor'), wrap((req, res) => {
    const where = ['s.owner_id = ?'];
    const params = [req.user.id];
    if (req.query.date) { where.push('o.date = ?'); params.push(checkDate(req.query.date)); }
    if (req.query.status) { where.push('o.status = ?'); params.push(req.query.status); }
    if (req.query.shop_id) { where.push('o.shop_id = ?'); params.push(req.query.shop_id); }
    const rows = db.prepare(`SELECT o.*, s.name AS shop_name, u.name AS client_name, u.phone AS client_phone
      FROM orders o JOIN shops s ON s.id = o.shop_id JOIN users u ON u.id = o.client_id
      WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC, o.id DESC`).all(...params);
    res.json(withItems(rows));
  }));

  r.patch('/orders/:id/status', requireAuth(), wrap((req, res) => {
    const o = db.prepare(`SELECT o.*, s.owner_id FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?`)
      .get(req.params.id);
    if (!o) fail(404, 'Commande introuvable');
    const { status } = req.body;
    if (o.owner_id === req.user.id) {
      if (!VENDOR_STATUSES.includes(status)) fail(400, 'Statut invalide');
    } else if (o.client_id === req.user.id) {
      if (status !== 'cancelled' || o.status !== 'pending') fail(400, 'Vous pouvez annuler seulement une commande en attente');
    } else {
      fail(403, 'Accès refusé');
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, o.id);
    res.json(withItems([db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id)])[0]);
  }));

  return r;
};
