const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

let server;
let base;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fshop-'));

before(async () => {
  const app = createApp({ dbFile: ':memory:', uploadDir: tmp });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: form || (body && JSON.stringify(body)) });
  return { status: res.status, data: await res.json() };
}

const register = async (role, email) =>
  (await call('POST', '/auth/register', { body: { name: email.split('@')[0], email, password: 'secret123', role, phone: '690000000' } })).data;

const TODAY = '2026-09-27';
const TOMORROW = '2026-09-28';

test('parcours vendeuse / client : menu du jour, commande avec localisation, stock', async () => {
  const maman = await register('vendor', 'maman@test.cm');
  const client = await register('client', 'client@test.cm');

  const shop = (await call('POST', '/shops', { token: maman.token, body: { name: 'Chez Maman', lat: 3.848, lng: 11.502 } })).data;

  const form = new FormData();
  form.append('name', 'Ndolé');
  form.append('price', '1500');
  form.append('image', new Blob([Buffer.from('fakepng')], { type: 'image/png' }), 'ndole.png');
  const ndole = (await call('POST', `/shops/${shop.id}/dishes`, { token: maman.token, form })).data;
  assert.match(ndole.image, /^\/uploads\//);
  const eru = (await call('POST', `/shops/${shop.id}/dishes`, { token: maman.token, body: { name: 'Eru', price: 1000 } })).data;

  // Seul le ndolé est dispo aujourd'hui (2 portions), l'eru demain
  await call('PUT', `/shops/${shop.id}/daily/${TODAY}`, { token: maman.token, body: { items: [{ dish_id: ndole.id, quantity: 2 }] } });
  await call('PUT', `/shops/${shop.id}/daily/${TOMORROW}`, { token: maman.token, body: { items: [{ dish_id: eru.id }] } });

  const menu = (await call('GET', `/shops/${shop.id}/menu?date=${TODAY}`)).data;
  assert.deepEqual(menu.items.map((i) => i.name), ['Ndolé']);

  const near = (await call('GET', `/shops?lat=3.85&lng=11.5&date=${TODAY}`)).data;
  assert.equal(near[0].id, shop.id);
  assert.ok(near[0].distance_km < 1);

  // Plat non disponible ce jour-là
  let r = await call('POST', '/orders', { token: client.token, body: { shop_id: shop.id, date: TODAY, mode: 'pickup', items: [{ dish_id: eru.id, quantity: 1 }] } });
  assert.equal(r.status, 400);

  // Livraison sans localisation refusée
  r = await call('POST', '/orders', { token: client.token, body: { shop_id: shop.id, date: TODAY, mode: 'delivery', items: [{ dish_id: ndole.id, quantity: 1 }] } });
  assert.equal(r.status, 400);

  r = await call('POST', '/orders', {
    token: client.token,
    body: { shop_id: shop.id, date: TODAY, mode: 'delivery', lat: 3.86, lng: 11.51, items: [{ dish_id: ndole.id, quantity: 2 }] },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.total, 3000);
  const orderId = r.data.id;

  // Stock épuisé
  r = await call('POST', '/orders', { token: client.token, body: { shop_id: shop.id, date: TODAY, items: [{ dish_id: ndole.id, quantity: 1 }] } });
  assert.equal(r.status, 409);

  const received = (await call('GET', `/orders/received?date=${TODAY}`, { token: maman.token })).data;
  assert.equal(received.length, 1);
  assert.equal(received[0].lat, 3.86);
  assert.equal(received[0].client_name, 'client');

  // Le client ne peut pas confirmer, la vendeuse oui
  assert.equal((await call('PATCH', `/orders/${orderId}/status`, { token: client.token, body: { status: 'done' } })).status, 400);
  assert.equal((await call('PATCH', `/orders/${orderId}/status`, { token: maman.token, body: { status: 'confirmed' } })).data.status, 'confirmed');

  // Un autre client n'accède pas aux commandes de la vendeuse
  assert.equal((await call('GET', '/orders/received', { token: client.token })).status, 403);
});

test('parcours nutritionniste : patients, plan, rappels, menus sur réservation', async () => {
  const nutri = await register('nutritionist', 'nutri@test.cm');
  const service = await register('service', 'cuisine@test.cm');
  const patient = await register('client', 'patient@test.cm');
  const other = await register('client', 'autre@test.cm');

  assert.equal((await call('POST', '/nutrition/patients', { token: nutri.token, body: { email: 'patient@test.cm' } })).status, 201);

  const plan = (await call('POST', '/nutrition/plans', {
    token: nutri.token,
    body: {
      patient_id: patient.user.id,
      title: 'Plan diabète',
      create_reminders: true,
      items: [
        { meal: 'Petit-déjeuner', time: '07:30', description: 'Bouillie de mil sans sucre' },
        { meal: 'Déjeuner', time: '13:00', day_of_week: 1, description: 'Poisson braisé + légumes' },
      ],
    },
  })).data;
  assert.equal(plan.items.length, 2);

  // Plan non accessible pour un patient non suivi
  assert.equal((await call('POST', '/nutrition/plans', { token: nutri.token, body: { patient_id: other.user.id, title: 'x' } })).status, 403);

  const myPlans = (await call('GET', '/nutrition/plans', { token: patient.token })).data;
  assert.equal(myPlans[0].title, 'Plan diabète');

  let reminders = (await call('GET', '/reminders', { token: patient.token })).data;
  assert.equal(reminders.length, 2);
  assert.equal(reminders.find((x) => x.time === '13:00').days, '1');

  // Le patient ajuste lui-même un rappel
  const updated = (await call('PATCH', `/reminders/${reminders[0].id}`, { token: patient.token, body: { time: '08:00', days: '12345' } })).data;
  assert.equal(updated.time, '08:00');
  assert.equal((await call('PATCH', `/reminders/${reminders[0].id}`, { token: other.token, body: { active: false } })).status, 403);

  // Menus du nutritionniste préparés par un service, sur réservation
  const menu = (await call('POST', '/nutri-menus', {
    token: nutri.token,
    body: { title: 'Menu hyposodé', date: TOMORROW, capacity: 3, price: 2500, service_id: service.user.id, target: 'Hypertension' },
  })).data;
  assert.equal(menu.remaining, 3);

  const list = (await call('GET', `/nutri-menus?date=${TOMORROW}`)).data;
  assert.equal(list.length, 1);

  const resa = await call('POST', `/nutri-menus/${menu.id}/reservations`, { token: other.token, body: { quantity: 2 } });
  assert.equal(resa.status, 201);
  assert.equal((await call('POST', `/nutri-menus/${menu.id}/reservations`, { token: patient.token, body: { quantity: 2 } })).status, 409);

  const toPrepare = (await call('GET', '/reservations/received', { token: service.token })).data;
  assert.equal(toPrepare.length, 1);
  assert.equal((await call('PATCH', `/reservations/${resa.data.id}/status`, { token: service.token, body: { status: 'ready' } })).data.status, 'ready');

  // Consultation demandée par le patient + messagerie
  const consult = (await call('POST', '/consultations', {
    token: patient.token,
    body: { nutritionist_id: nutri.user.id, scheduled_at: '2026-10-01T10:00', reason: 'Suivi glycémie' },
  })).data;
  assert.equal(consult.status, 'requested');
  const sched = (await call('PATCH', `/consultations/${consult.id}`, { token: nutri.token, body: { status: 'scheduled', link: 'https://meet.jit.si/abc' } })).data;
  assert.equal(sched.status, 'scheduled');

  await call('POST', `/messages/${nutri.user.id}`, { token: patient.token, body: { body: 'Bonjour docteur' } });
  const msgs = (await call('GET', `/messages/${patient.user.id}`, { token: nutri.token })).data;
  assert.equal(msgs[0].body, 'Bonjour docteur');
  assert.equal((await call('POST', `/messages/${nutri.user.id}`, { token: service.token, body: { body: 'spam' } })).status, 403);
});
