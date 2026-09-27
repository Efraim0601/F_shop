const express = require('express');
const { requireAuth } = require('../auth');
const { tx } = require('../db');
const { fail, toNum, toInt, requireFields, checkDate, distanceKm, wrap, fileUrl } = require('../util');

// Quantité restante d'un plat pour un jour (NULL = illimité)
const AVAILABLE_SQL = `
  SELECT d.id, d.name, d.description, d.price, d.image, m.quantity,
    CASE WHEN m.quantity IS NULL THEN NULL ELSE m.quantity - COALESCE((
      SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.dish_id = d.id AND o.date = m.date AND o.status != 'cancelled'), 0) END AS remaining
  FROM daily_menu_items m JOIN dishes d ON d.id = m.dish_id
  WHERE m.shop_id = ? AND m.date = ? AND d.archived = 0
  ORDER BY d.name`;

module.exports = (db, upload) => {
  const r = express.Router();

  const ownShop = (req) => {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) fail(404, 'Point de vente introuvable');
    if (shop.owner_id !== req.user.id) fail(403, "Ce point de vente ne vous appartient pas");
    return shop;
  };

  const withDistance = (rows, lat, lng) => {
    if (lat === null || lng === null) return rows;
    return rows
      .map((s) => ({ ...s, distance_km: s.lat == null ? null : +distanceKm(lat, lng, s.lat, s.lng).toFixed(2) }))
      .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
  };

  // ---------- Public ----------

  // Liste des points de vente, triés par distance si lat/lng fournis
  r.get('/shops', wrap((req, res) => {
    const date = req.query.date ? checkDate(req.query.date) : null;
    const rows = db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM daily_menu_items m WHERE m.shop_id = s.id AND m.date = ?) AS dishes_count
      FROM shops s ORDER BY s.name`).all(date);
    let list = withDistance(rows, toNum(req.query.lat), toNum(req.query.lng));
    const radius = toNum(req.query.radius_km);
    if (radius !== null) list = list.filter((s) => s.distance_km !== null && s.distance_km <= radius);
    res.json(list);
  }));

  // Tous les plats disponibles pour un jour, tous points de vente confondus
  r.get('/menus', wrap((req, res) => {
    const date = checkDate(req.query.date);
    const shops = withDistance(db.prepare('SELECT * FROM shops').all(), toNum(req.query.lat), toNum(req.query.lng));
    const stmt = db.prepare(AVAILABLE_SQL);
    const posts = db.prepare('SELECT * FROM daily_posts WHERE shop_id = ? AND date = ? ORDER BY created_at DESC');
    res.json(
      shops
        .map((s) => ({ shop: s, items: stmt.all(s.id, date), posts: posts.all(s.id, date) }))
        .filter((x) => x.items.length || x.posts.length),
    );
  }));

  r.get('/shops/mine', requireAuth('vendor'), (req, res) => {
    res.json(db.prepare('SELECT * FROM shops WHERE owner_id = ? ORDER BY id').all(req.user.id));
  });

  r.get('/shops/:id', wrap((req, res) => {
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) fail(404, 'Point de vente introuvable');
    res.json(shop);
  }));

  // Menu d'un point de vente pour un jour
  r.get('/shops/:id/menu', wrap((req, res) => {
    const date = checkDate(req.query.date);
    const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
    if (!shop) fail(404, 'Point de vente introuvable');
    res.json({
      shop,
      date,
      items: db.prepare(AVAILABLE_SQL).all(shop.id, date),
      posts: db.prepare('SELECT * FROM daily_posts WHERE shop_id = ? AND date = ? ORDER BY created_at DESC').all(shop.id, date),
    });
  }));

  // ---------- Vendeuse ----------

  const shopFields = (b) => [
    b.name.trim(), b.description || null, b.address || null, b.phone || null,
    toNum(b.lat), toNum(b.lng), b.delivery === false || b.delivery === '0' ? 0 : 1,
  ];

  r.post('/shops', requireAuth('vendor'), wrap((req, res) => {
    requireFields(req.body, ['name']);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO shops (name, description, address, phone, lat, lng, delivery, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...shopFields(req.body), req.user.id);
    res.status(201).json(db.prepare('SELECT * FROM shops WHERE id = ?').get(lastInsertRowid));
  }));

  r.put('/shops/:id', requireAuth('vendor'), wrap((req, res) => {
    const shop = ownShop(req);
    requireFields(req.body, ['name']);
    db.prepare(`UPDATE shops SET name = ?, description = ?, address = ?, phone = ?, lat = ?, lng = ?, delivery = ?
      WHERE id = ?`).run(...shopFields(req.body), shop.id);
    res.json(db.prepare('SELECT * FROM shops WHERE id = ?').get(shop.id));
  }));

  // Catalogue de plats
  r.get('/shops/:id/dishes', requireAuth('vendor'), wrap((req, res) => {
    const shop = ownShop(req);
    res.json(db.prepare('SELECT * FROM dishes WHERE shop_id = ? AND archived = 0 ORDER BY name').all(shop.id));
  }));

  r.post('/shops/:id/dishes', requireAuth('vendor'), upload.single('image'), wrap((req, res) => {
    const shop = ownShop(req);
    requireFields(req.body, ['name']);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO dishes (shop_id, name, description, price, image) VALUES (?, ?, ?, ?, ?)')
      .run(shop.id, req.body.name.trim(), req.body.description || null, toInt(req.body.price) ?? 0, fileUrl(req.file));
    res.status(201).json(db.prepare('SELECT * FROM dishes WHERE id = ?').get(lastInsertRowid));
  }));

  const ownDish = (req) => {
    const dish = db.prepare(`SELECT d.* FROM dishes d JOIN shops s ON s.id = d.shop_id
      WHERE d.id = ? AND s.owner_id = ?`).get(req.params.dishId, req.user.id);
    if (!dish) fail(404, 'Plat introuvable');
    return dish;
  };

  r.put('/dishes/:dishId', requireAuth('vendor'), upload.single('image'), wrap((req, res) => {
    const dish = ownDish(req);
    const b = req.body;
    db.prepare('UPDATE dishes SET name = ?, description = ?, price = ?, image = ? WHERE id = ?').run(
      (b.name || dish.name).trim(),
      b.description ?? dish.description,
      toInt(b.price) ?? dish.price,
      fileUrl(req.file) || dish.image,
      dish.id,
    );
    res.json(db.prepare('SELECT * FROM dishes WHERE id = ?').get(dish.id));
  }));

  // Archivage (on garde l'historique des commandes)
  r.delete('/dishes/:dishId', requireAuth('vendor'), wrap((req, res) => {
    const dish = ownDish(req);
    db.prepare('UPDATE dishes SET archived = 1 WHERE id = ?').run(dish.id);
    res.json({ ok: true });
  }));

  // Sélection des plats disponibles pour un jour
  r.get('/shops/:id/daily/:date', requireAuth('vendor'), wrap((req, res) => {
    const shop = ownShop(req);
    const date = checkDate(req.params.date);
    res.json(db.prepare(AVAILABLE_SQL).all(shop.id, date));
  }));

  r.put('/shops/:id/daily/:date', requireAuth('vendor'), wrap((req, res) => {
    const shop = ownShop(req);
    const date = checkDate(req.params.date);
    const items = Array.isArray(req.body.items) ? req.body.items : fail(400, 'Liste "items" attendue');
    const dishOk = db.prepare('SELECT 1 FROM dishes WHERE id = ? AND shop_id = ? AND archived = 0');
    tx(db, () => {
      db.prepare('DELETE FROM daily_menu_items WHERE shop_id = ? AND date = ?').run(shop.id, date);
      const ins = db.prepare('INSERT INTO daily_menu_items (shop_id, dish_id, date, quantity) VALUES (?, ?, ?, ?)');
      for (const it of items) {
        if (!dishOk.get(it.dish_id, shop.id)) fail(400, `Plat ${it.dish_id} inconnu`);
        const q = toInt(it.quantity);
        ins.run(shop.id, it.dish_id, date, q !== null && q >= 0 ? q : null);
      }
    });
    res.json(db.prepare(AVAILABLE_SQL).all(shop.id, date));
  }));

  // Publication du jour avec capture d'écran
  r.post('/shops/:id/posts', requireAuth('vendor'), upload.single('image'), wrap((req, res) => {
    const shop = ownShop(req);
    const date = checkDate(req.body.date);
    if (!req.body.message && !req.file) fail(400, 'Ajoutez un message ou une image');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO daily_posts (shop_id, date, message, image) VALUES (?, ?, ?, ?)')
      .run(shop.id, date, req.body.message || null, fileUrl(req.file));
    res.status(201).json(db.prepare('SELECT * FROM daily_posts WHERE id = ?').get(lastInsertRowid));
  }));

  r.delete('/posts/:postId', requireAuth('vendor'), wrap((req, res) => {
    const post = db.prepare(`SELECT p.id FROM daily_posts p JOIN shops s ON s.id = p.shop_id
      WHERE p.id = ? AND s.owner_id = ?`).get(req.params.postId, req.user.id);
    if (!post) fail(404, 'Publication introuvable');
    db.prepare('DELETE FROM daily_posts WHERE id = ?').run(post.id);
    res.json({ ok: true });
  }));

  return r;
};

module.exports.AVAILABLE_SQL = AVAILABLE_SQL;
