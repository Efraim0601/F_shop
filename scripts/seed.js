// Données de démonstration : `npm run seed` (mot de passe de tous les comptes : demo123)
const path = require('node:path');
const { openDb } = require('../src/db');
const { hashPassword } = require('../src/auth');

const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'fshop.db'));

const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const user = (name, email, role, phone) => {
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (u) return u.id;
  return Number(db.prepare('INSERT INTO users (name, email, role, phone, password_hash) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, role, phone, hashPassword('demo123')).lastInsertRowid);
};

const maman = user('Maman Rose', 'rose@demo.cm', 'vendor', '+237690000001');
const nutri = user('Dr Ngo Biyong', 'nutri@demo.cm', 'nutritionist', '+237690000002');
const cuisine = user('Cuisine diététique CHU', 'cuisine@demo.cm', 'service', '+237690000003');
const client = user('Paul Client', 'client@demo.cm', 'client', '+237690000004');

if (!db.prepare('SELECT 1 FROM shops WHERE owner_id = ?').get(maman)) {
  const shop = Number(db.prepare(`INSERT INTO shops (owner_id, name, description, address, phone, lat, lng)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(maman, 'Chez Maman Rose', 'Cuisine camerounaise faite maison', 'Bastos, près de la pharmacie',
    '+237690000001', 3.8867, 11.5133).lastInsertRowid);
  const dish = (name, price, description) =>
    Number(db.prepare('INSERT INTO dishes (shop_id, name, price, description) VALUES (?, ?, ?, ?)').run(shop, name, price, description).lastInsertRowid);
  const ndole = dish('Ndolé + miondo', 1500, 'Ndolé aux crevettes');
  const eru = dish('Eru + water fufu', 1500, null);
  const poulet = dish('Poulet DG', 2500, 'Poulet, plantains mûrs, légumes');
  const add = db.prepare('INSERT INTO daily_menu_items (shop_id, dish_id, date, quantity) VALUES (?, ?, ?, ?)');
  add.run(shop, ndole, iso(0), 10);
  add.run(shop, poulet, iso(0), 5);
  add.run(shop, eru, iso(1), null);
  db.prepare('INSERT INTO daily_posts (shop_id, date, message) VALUES (?, ?, ?)')
    .run(shop, iso(0), 'Bonjour à tous ! Aujourd\'hui ndolé et poulet DG 🍗 Livraison dès 12h.');
}

db.prepare('INSERT OR IGNORE INTO nutrition_patients (nutritionist_id, patient_id, notes) VALUES (?, ?, ?)')
  .run(nutri, client, 'Diabète type 2 — objectif : réduire les sucres rapides');

if (!db.prepare('SELECT 1 FROM nutri_menus WHERE nutritionist_id = ?').get(nutri)) {
  db.prepare(`INSERT INTO nutri_menus (nutritionist_id, service_id, title, description, target, calories, price, date, capacity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nutri, cuisine, 'Menu équilibré diabétique',
    'Poisson braisé, légumes sautés, patate douce, fruit de saison', 'Diabète', 550, 2500, iso(1), 20);
}

console.log('Données de démo prêtes. Comptes (mot de passe demo123) : rose@demo.cm, nutri@demo.cm, cuisine@demo.cm, client@demo.cm');
