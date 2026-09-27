/* F-Shop — interface web (JS natif, sans framework) */
'use strict';

// ================= Utilitaires =================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${Number(n || 0).toLocaleString('fr-FR')} FCFA`;
const DAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

function isoDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const fmtDate = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDateTime = (s) => new Date(s.replace(' ', 'T')).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

const STATUS = {
  pending: 'En attente', confirmed: 'Confirmée', preparing: 'En préparation', delivering: 'En livraison',
  done: 'Terminée', cancelled: 'Annulée', ready: 'Prête', requested: 'Demandée', scheduled: 'Planifiée',
};
const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS[s] || s)}</span>`;

const mapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
const directionsLink = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'reminder' ? 15000 : 4000);
}

// ================= API =================

const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  cart: null, // { shop, date, items: { dishId: {dish, qty} } }
  pos: null,  // { lat, lng }
};

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (state.token) opts.headers.authorization = `Bearer ${state.token}`;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) logout(false);
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// Exécute une action et affiche l'erreur éventuelle
async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return undefined;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setSession({ token, user }) {
  state.token = token;
  state.user = user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}

function logout(callApi = true) {
  if (callApi && state.token) api('POST', '/auth/logout').catch(() => {});
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.hash = '#/';
  render();
}

// ================= Géolocalisation & cartes =================

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Géolocalisation non disponible'));
    navigator.geolocation.getCurrentPosition(
      (p) => { state.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; resolve(state.pos); },
      () => reject(new Error('Impossible de récupérer votre position (autorisez la localisation)')),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

const DEFAULT_CENTER = [3.848, 11.502]; // Yaoundé

function makeMap(el, center, zoom = 13) {
  if (!window.L) {
    el.innerHTML = '<p class="muted">Carte indisponible (hors ligne)</p>';
    el.style.height = 'auto';
    return null;
  }
  const map = L.map(el).setView(center || DEFAULT_CENTER, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  setTimeout(() => map.invalidateSize(), 50);
  return map;
}

// Carte avec un marqueur déplaçable ; onChange({lat,lng})
function pickerMap(el, initial, onChange) {
  const map = makeMap(el, initial ? [initial.lat, initial.lng] : null, initial ? 16 : 12);
  if (!map) return null;
  let marker = null;
  const place = (latlng) => {
    if (marker) marker.setLatLng(latlng);
    else {
      marker = L.marker(latlng, { draggable: true }).addTo(map);
      marker.on('dragend', () => onChange(marker.getLatLng()));
    }
    onChange(latlng);
  };
  if (initial) place(initial);
  map.on('click', (e) => place(e.latlng));
  return { map, place: (p) => { place(p); map.setView([p.lat, p.lng], 16); } };
}

// ================= Modale =================

function openModal(html, onMount) {
  $('#modal-body').innerHTML = html;
  const dlg = $('#modal');
  if (!dlg.open) dlg.showModal();
  $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', closeModal));
  onMount?.($('#modal-body'));
}
function closeModal() { $('#modal').close(); }
$('#modal')?.addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function zoomImage(src) {
  openModal(`<img src="${esc(src)}" style="max-width:100%"><div class="row" style="margin-top:8px"><button data-close>Fermer</button></div>`);
}

// ================= Routage =================

const NAV = {
  guest: [['#/', 'Accueil'], ['#/menus', 'Menus du jour'], ['#/carte', 'Carte'], ['#/nutrition', 'Menus nutritionniste', 'nutri']],
  client: [['#/menus', 'Menus du jour'], ['#/carte', 'Carte'], ['#/nutrition', 'Menus nutritionniste', 'nutri'],
    ['#/suivi', 'Mon suivi santé', 'nutri'], ['#/commandes', 'Mes commandes']],
  vendor: [['#/boutique', 'Mon point de vente'], ['#/plats', 'Mes plats'], ['#/jour', 'Menu du jour'], ['#/recues', 'Commandes']],
  nutritionist: [['#/patients', 'Patients', 'nutri'], ['#/consultations', 'Consultations', 'nutri'],
    ['#/menus-nutri', 'Mes menus', 'nutri'], ['#/reservations', 'Réservations', 'nutri']],
  service: [['#/reservations', 'Réservations à préparer', 'nutri']],
};

const ROUTES = {
  '/': viewHome,
  '/login': viewLogin,
  '/inscription': viewRegister,
  '/menus': viewMenus,
  '/carte': viewMap,
  '/boutique-client': viewShopPublic,
  '/nutrition': viewNutriMenus,
  '/suivi': viewPatientSpace,
  '/commandes': viewMyOrders,
  '/boutique': viewMyShop,
  '/plats': viewDishes,
  '/jour': viewDaily,
  '/recues': viewReceived,
  '/patients': viewPatients,
  '/consultations': viewConsultations,
  '/menus-nutri': viewMyNutriMenus,
  '/reservations': viewReservations,
};

function parseHash() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { path, params: new URLSearchParams(qs) };
}

let refreshTimer = null;

async function render() {
  clearInterval(refreshTimer);
  const { path, params } = parseHash();
  const role = state.user?.role || 'guest';
  if (path === '/' && state.user) {
    location.hash = NAV[role][0][0];
    return;
  }
  $('#nav').innerHTML = NAV[role]
    .map(([href, label, cls]) => `<a href="${href}" class="${cls || ''} ${href === `#${path}` ? 'active' : ''}">${label}</a>`)
    .join('');
  $('#userbox').innerHTML = state.user
    ? `<span>${esc(state.user.name)}</span><button id="logout">Déconnexion</button>`
    : '<a class="btn" href="#/login">Connexion</a><a class="btn primary" href="#/inscription">Créer un compte</a>';
  $('#logout')?.addEventListener('click', () => logout());
  const view = ROUTES[path] || viewHome;
  const app = $('#app');
  app.innerHTML = '<p class="muted">Chargement…</p>';
  try {
    await view(app, params);
  } catch (e) {
    app.innerHTML = `<div class="card"><p>${esc(e.message)}</p></div>`;
  }
}

window.addEventListener('hashchange', render);

function needRole(app, ...roles) {
  if (!state.user) {
    app.innerHTML = `<div class="card"><p>Connectez-vous pour accéder à cette page.</p>
      <a class="btn primary" href="#/login">Connexion</a> <a class="btn" href="#/inscription">Créer un compte</a></div>`;
    return false;
  }
  if (roles.length && !roles.includes(state.user.role)) {
    app.innerHTML = '<div class="card"><p>Cette page n\'est pas disponible pour votre profil.</p></div>';
    return false;
  }
  return true;
}

// ================= Accueil & comptes =================

function viewHome(app) {
  app.innerHTML = `
    <section class="hero">
      <h1>Les bons plats près de chez vous, sans se perdre dans WhatsApp</h1>
      <p class="muted">Consultez les menus du jour et de demain, commandez en un clic avec votre position, ou suivez un régime avec votre nutritionniste.</p>
      <div class="row" style="justify-content:center">
        <a class="btn primary" href="#/menus">Voir les menus du jour</a>
        <a class="btn" href="#/carte">Points de vente proches</a>
      </div>
      <div class="grid">
        <div class="card"><h3>👩🏾‍🍳 Vendeuses</h3><p class="muted">Créez vos plats une fois, choisissez chaque jour ceux qui sont disponibles, publiez votre capture de menu et recevez toutes les commandes au même endroit, avec la localisation du client.</p></div>
        <div class="card"><h3>🧑🏾‍⚕️ Nutritionnistes</h3><p class="muted">Suivez vos patients à distance, créez des plans alimentaires personnalisés avec rappels, et proposez des menus préparés par des services spécialisés sur réservation.</p></div>
        <div class="card"><h3>🙋🏾 Clients</h3><p class="muted">Trouvez le point de vente le plus proche, consultez ses menus, rendez-vous-y grâce à la carte ou faites-vous livrer.</p></div>
      </div>
    </section>`;
}

function viewLogin(app) {
  app.innerHTML = `
    <div class="card"><h1>Connexion</h1>
      <form class="stack" id="f">
        <label>Email<input name="email" type="email" required autocomplete="email"></label>
        <label>Mot de passe<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary">Se connecter</button>
        <p class="muted">Pas encore de compte ? <a href="#/inscription">Inscrivez-vous</a></p>
      </form></div>`;
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await attempt(() => api('POST', '/auth/login', formData(e.target)));
    if (r) { setSession(r); location.hash = '#/'; render(); startReminders(); }
  });
}

function viewRegister(app) {
  app.innerHTML = `
    <div class="card"><h1>Créer un compte</h1>
      <form class="stack" id="f">
        <label>Je suis…
          <select name="role">
            <option value="client">Client / patient</option>
            <option value="vendor">Vendeuse / restauratrice</option>
            <option value="nutritionist">Nutritionniste</option>
            <option value="service">Service spécialisé (cuisine diététique)</option>
          </select></label>
        <label>Nom complet<input name="name" required></label>
        <label>Téléphone (WhatsApp)<input name="phone" type="tel"></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Mot de passe (6 caractères min.)<input name="password" type="password" minlength="6" required></label>
        <button class="primary">Créer mon compte</button>
      </form></div>`;
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await attempt(() => api('POST', '/auth/register', formData(e.target)), 'Bienvenue !');
    if (r) { setSession(r); location.hash = '#/'; render(); startReminders(); }
  });
}

// ================= Client : menus, carte, commande =================

function daySwitch(date) {
  const today = isoDate(0);
  const tomorrow = isoDate(1);
  return `<div class="seg">
      <button data-date="${today}" class="${date === today ? 'on' : ''}">Aujourd'hui</button>
      <button data-date="${tomorrow}" class="${date === tomorrow ? 'on' : ''}">Demain</button>
    </div>`;
}

function dishRow(d, shop, date, orderable = true) {
  const soldOut = d.remaining !== null && d.remaining <= 0;
  const inCart = state.cart?.shop.id === shop.id && state.cart.date === date ? state.cart.items[d.id]?.qty || 0 : 0;
  return `<div class="dish">
      ${d.image ? `<img class="thumb zoom" src="${esc(d.image)}" alt="">` : '<div class="thumb"></div>'}
      <div style="flex:1">
        <div class="row spread"><strong>${esc(d.name)}</strong><span class="price">${money(d.price)}</span></div>
        ${d.description ? `<div class="muted">${esc(d.description)}</div>` : ''}
        <div class="row spread" style="margin-top:4px">
          <span class="muted">${d.remaining === null ? '' : soldOut ? 'Épuisé' : `Reste ${d.remaining}`}</span>
          ${orderable && !soldOut ? `<span class="qty" data-dish="${d.id}" data-shop="${shop.id}">
            <button data-d="-1">−</button><b>${inCart}</b><button data-d="1">+</button></span>` : ''}
        </div>
      </div>
    </div>`;
}

function postBlock(p) {
  return `<div class="post card" style="background:var(--bg)">
      ${p.message ? `<div style="white-space:pre-wrap">${esc(p.message)}</div>` : ''}
      ${p.image ? `<img class="zoom" src="${esc(p.image)}" alt="Menu du jour">` : ''}
    </div>`;
}

function shopCard(block, date) {
  const { shop, items, posts } = block;
  return `<div class="card">
      <div class="row spread">
        <div><h3><a href="#/boutique-client?id=${shop.id}&date=${date}">${esc(shop.name)}</a></h3>
          <div class="muted">${esc(shop.address || '')} ${shop.distance_km != null ? `· 📍 ${shop.distance_km} km` : ''}
            ${shop.delivery ? '· 🛵 Livraison' : '· Sur place / à emporter'}</div></div>
        ${shop.lat != null ? `<a class="btn" target="_blank" rel="noopener" href="${directionsLink(shop.lat, shop.lng)}">🧭 Itinéraire</a>` : ''}
      </div>
      ${posts.map(postBlock).join('')}
      ${items.map((d) => dishRow(d, shop, date)).join('') || '<p class="muted">Pas de plat listé, voir la publication.</p>'}
    </div>`;
}

// Branche les boutons +/−, zoom image et barre panier
function wireOrdering(root, shopsById, date, rerender) {
  $$('.zoom', root).forEach((img) => img.addEventListener('click', () => zoomImage(img.src)));
  $$('.qty', root).forEach((q) => q.addEventListener('click', (e) => {
    const delta = Number(e.target.dataset.d);
    if (!delta) return;
    if (!state.user) { toast('Connectez-vous pour commander', 'error'); location.hash = '#/login'; return; }
    const { shop, items } = shopsById[q.dataset.shop];
    if (state.cart && (state.cart.shop.id !== shop.id || state.cart.date !== date)) {
      if (!confirm('Votre panier contient des plats d\'un autre point de vente ou d\'un autre jour. Le vider ?')) return;
      state.cart = null;
    }
    state.cart ||= { shop, date, items: {} };
    const dish = items.find((d) => d.id === Number(q.dataset.dish));
    const cur = state.cart.items[dish.id]?.qty || 0;
    const next = Math.max(0, Math.min(cur + delta, dish.remaining ?? 99));
    if (next) state.cart.items[dish.id] = { dish, qty: next };
    else delete state.cart.items[dish.id];
    if (!Object.keys(state.cart.items).length) state.cart = null;
    rerender();
  }));
  renderCartBar(root);
}

function cartTotal() {
  return Object.values(state.cart?.items || {}).reduce((s, i) => s + i.qty * i.dish.price, 0);
}

function renderCartBar(root) {
  $('#cartbar')?.remove();
  if (!state.cart) return;
  const n = Object.values(state.cart.items).reduce((s, i) => s + i.qty, 0);
  const bar = document.createElement('div');
  bar.id = 'cartbar';
  bar.innerHTML = `<span>🛒 ${n} plat(s) · ${esc(state.cart.shop.name)} · <b>${money(cartTotal())}</b></span><button>Commander</button>`;
  bar.querySelector('button').addEventListener('click', checkout);
  root.append(bar);
}

function checkout() {
  const { shop, date, items } = state.cart;
  const loc = { lat: null, lng: null };
  openModal(`
    <h2>Valider ma commande</h2>
    <p class="muted">${esc(shop.name)} — ${fmtDate(date)}</p>
    <table>${Object.values(items).map((i) => `<tr><td>${i.qty} × ${esc(i.dish.name)}</td><td>${money(i.qty * i.dish.price)}</td></tr>`).join('')}
      <tr><th>Total</th><th>${money(cartTotal())}</th></tr></table>
    <form class="stack" id="co">
      <label>Mode
        <select name="mode">
          ${shop.delivery ? '<option value="delivery">🛵 Livraison</option>' : ''}
          <option value="pickup">🏃 Je passe récupérer / manger sur place</option>
        </select></label>
      <div id="delivery-box" class="stack">
        <div class="row"><button type="button" id="geo">📍 Utiliser ma position actuelle</button>
          <span class="muted" id="geo-status">ou touchez la carte pour placer le point de livraison</span></div>
        <div id="co-map" class="map small"></div>
        <label>Précisions d'adresse (quartier, repère…)<input name="address"></label>
      </div>
      <label>Téléphone<input name="phone" type="tel" value="${esc(state.user.phone || '')}"></label>
      <label>Note pour la vendeuse<textarea name="note" rows="2"></textarea></label>
      <div class="row"><button class="primary">Confirmer la commande</button><button type="button" data-close>Annuler</button></div>
    </form>`, (root) => {
    const status = $('#geo-status', root);
    const setLoc = (p) => {
      loc.lat = p.lat; loc.lng = p.lng;
      status.textContent = `Position : ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    };
    const picker = pickerMap($('#co-map', root), state.pos, setLoc);
    $('#geo', root).addEventListener('click', async () => {
      status.textContent = 'Localisation en cours…';
      const p = await attempt(getPosition);
      if (p) (picker ? picker.place(p) : setLoc(p));
    });
    const modeSel = $('[name=mode]', root);
    const sync = () => { $('#delivery-box', root).hidden = modeSel.value !== 'delivery'; picker?.map.invalidateSize(); };
    modeSel.addEventListener('change', sync);
    sync();
    $('#co', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        ...formData(e.target), ...loc, shop_id: shop.id, date,
        items: Object.values(items).map((i) => ({ dish_id: i.dish.id, quantity: i.qty })),
      };
      const order = await attempt(() => api('POST', '/orders', body), 'Commande envoyée ! La vendeuse va la confirmer.');
      if (order) { state.cart = null; closeModal(); location.hash = '#/commandes'; }
    });
  });
}

async function viewMenus(app, params) {
  const date = params.get('date') || isoDate(0);
  const pos = state.pos;
  const q = pos ? `&lat=${pos.lat}&lng=${pos.lng}` : '';
  const blocks = await api('GET', `/menus?date=${date}${q}`);
  const shopsById = Object.fromEntries(blocks.map((b) => [b.shop.id, b]));
  app.innerHTML = `
    <div class="row spread"><h1>Menus du ${fmtDate(date)}</h1>
      <div class="row">${daySwitch(date)}<button id="near">📍 Trier par proximité</button></div></div>
    ${blocks.map((b) => shopCard(b, date)).join('') || '<div class="card"><p class="muted">Aucun menu publié pour ce jour.</p></div>'}`;
  $$('.seg button', app).forEach((b) => b.addEventListener('click', () => { location.hash = `#/menus?date=${b.dataset.date}`; }));
  $('#near', app).addEventListener('click', async () => { if (await attempt(getPosition)) render(); });
  wireOrdering(app, shopsById, date, () => viewMenus(app, params));
}

async function viewShopPublic(app, params) {
  const date = params.get('date') || isoDate(0);
  const id = params.get('id');
  const data = await api('GET', `/shops/${id}/menu?date=${date}`);
  const block = { shop: data.shop, items: data.items, posts: data.posts };
  app.innerHTML = `
    <div class="row spread"><h1>${esc(data.shop.name)}</h1>${daySwitch(date)}</div>
    <div class="card"><p>${esc(data.shop.description || '')}</p>
      <p class="muted">${esc(data.shop.address || '')} ${data.shop.phone ? `· ☎️ <a href="tel:${esc(data.shop.phone)}">${esc(data.shop.phone)}</a>` : ''}</p>
      ${data.shop.lat != null ? `<div id="shop-map" class="map small"></div>
        <p><a class="btn" target="_blank" rel="noopener" href="${directionsLink(data.shop.lat, data.shop.lng)}">🧭 M'y rendre</a></p>` : ''}
    </div>
    <h2>Menu du ${fmtDate(date)}</h2>
    ${shopCard(block, date)}`;
  if (data.shop.lat != null) {
    const map = makeMap($('#shop-map'), [data.shop.lat, data.shop.lng], 15);
    if (map) L.marker([data.shop.lat, data.shop.lng]).addTo(map).bindPopup(esc(data.shop.name)).openPopup();
  }
  $$('.seg button', app).forEach((b) => b.addEventListener('click', () => { location.hash = `#/boutique-client?id=${id}&date=${b.dataset.date}`; }));
  wireOrdering(app, { [data.shop.id]: block }, date, () => viewShopPublic(app, params));
}

async function viewMap(app) {
  app.innerHTML = `
    <div class="row spread"><h1>Points de vente autour de moi</h1><button id="me">📍 Me localiser</button></div>
    <div id="big-map" class="map" style="height:60vh"></div>
    <div id="list" class="grid" style="margin-top:12px"></div>`;
  const map = makeMap($('#big-map'), state.pos ? [state.pos.lat, state.pos.lng] : null, 13);
  const today = isoDate(0);
  const load = async () => {
    const q = state.pos ? `&lat=${state.pos.lat}&lng=${state.pos.lng}` : '';
    const shops = await api('GET', `/shops?date=${today}${q}`);
    $('#list').innerHTML = shops.map((s) => `<div class="card">
        <h3><a href="#/boutique-client?id=${s.id}">${esc(s.name)}</a></h3>
        <div class="muted">${esc(s.address || '')}${s.distance_km != null ? ` · ${s.distance_km} km` : ''}</div>
        <div class="muted">${s.dishes_count} plat(s) aujourd'hui</div>
        ${s.lat != null ? `<a target="_blank" rel="noopener" href="${directionsLink(s.lat, s.lng)}">🧭 Itinéraire</a>` : ''}
      </div>`).join('') || '<p class="muted">Aucun point de vente.</p>';
    if (!map) return;
    const pts = [];
    shops.filter((s) => s.lat != null).forEach((s) => {
      pts.push([s.lat, s.lng]);
      L.marker([s.lat, s.lng]).addTo(map).bindPopup(`<b>${esc(s.name)}</b><br>${s.dishes_count} plat(s) aujourd'hui<br>
        <a href="#/boutique-client?id=${s.id}">Voir le menu</a> · <a target="_blank" href="${directionsLink(s.lat, s.lng)}">Itinéraire</a>`);
    });
    if (state.pos) {
      L.circleMarker([state.pos.lat, state.pos.lng], { radius: 8, color: '#1565c0' }).addTo(map).bindPopup('Vous êtes ici');
      map.setView([state.pos.lat, state.pos.lng], 14);
    } else if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  };
  $('#me').addEventListener('click', async () => { if (await attempt(getPosition)) render(); });
  await load();
}

async function viewMyOrders(app) {
  if (!needRole(app)) return;
  const [orders, resas] = await Promise.all([api('GET', '/orders/mine'), api('GET', '/reservations/mine')]);
  app.innerHTML = `
    <h1>Mes commandes</h1>
    ${orders.map((o) => `<div class="card">
        <div class="row spread"><strong>#${o.id} · ${esc(o.shop_name)}</strong>${badge(o.status)}</div>
        <div class="muted">${fmtDate(o.date)} · ${o.mode === 'delivery' ? '🛵 Livraison' : '🏃 Retrait'}
          ${o.shop_phone ? `· ☎️ <a href="tel:${esc(o.shop_phone)}">${esc(o.shop_phone)}</a>` : ''}</div>
        <div>${o.items.map((i) => `${i.quantity} × ${esc(i.name)}`).join(', ')} — <b>${money(o.total)}</b></div>
        <div class="row" style="margin-top:6px">
          ${o.status === 'pending' ? `<button class="danger" data-cancel="${o.id}">Annuler</button>` : ''}
          ${o.mode === 'pickup' && o.shop_lat != null ? `<a class="btn" target="_blank" href="${directionsLink(o.shop_lat, o.shop_lng)}">🧭 M'y rendre</a>` : ''}
        </div>
      </div>`).join('') || '<p class="muted">Aucune commande pour l\'instant.</p>'}
    <h2>Mes réservations de menus diététiques</h2>
    ${resas.map((r) => `<div class="card"><div class="row spread"><strong>${esc(r.title)}</strong>${badge(r.status)}</div>
        <div class="muted">${fmtDate(r.date)} · ${r.quantity} portion(s) · ${money(r.price * r.quantity)}</div>
        ${r.status === 'pending' ? `<button class="danger" data-cancel-resa="${r.id}">Annuler</button>` : ''}</div>`).join('')
      || '<p class="muted">Aucune réservation.</p>'}`;
  $$('[data-cancel]', app).forEach((b) => b.addEventListener('click', async () => {
    if (await attempt(() => api('PATCH', `/orders/${b.dataset.cancel}/status`, { status: 'cancelled' }), 'Commande annulée')) render();
  }));
  $$('[data-cancel-resa]', app).forEach((b) => b.addEventListener('click', async () => {
    if (await attempt(() => api('PATCH', `/reservations/${b.dataset.cancelResa}/status`, { status: 'cancelled' }), 'Réservation annulée')) render();
  }));
}

// ================= Menus du nutritionniste (onglet spécial) =================

async function viewNutriMenus(app) {
  const menus = await api('GET', `/nutri-menus?from=${isoDate(0)}`);
  app.innerHTML = `
    <h1>🥗 Menus proposés par les nutritionnistes</h1>
    <p class="muted">Menus équilibrés conçus par des nutritionnistes et préparés par des services spécialisés. Sur réservation uniquement.</p>
    <div class="grid">${menus.map((m) => `<div class="card">
        ${m.image ? `<img class="post zoom" src="${esc(m.image)}" style="width:100%;max-height:180px;object-fit:cover;border-radius:8px">` : ''}
        <h3>${esc(m.title)}</h3>
        <div class="muted">${fmtDate(m.date)}${m.target ? ` · 🎯 ${esc(m.target)}` : ''}${m.calories ? ` · ${m.calories} kcal` : ''}</div>
        <p>${esc(m.description || '')}</p>
        <div class="muted">Par ${esc(m.nutritionist_name)}${m.service_name ? ` · préparé par ${esc(m.service_name)}` : ''}</div>
        <div class="row spread" style="margin-top:8px"><span class="price">${money(m.price)}</span>
          ${m.remaining !== null && m.remaining <= 0 ? '<span class="badge cancelled">Complet</span>'
            : `<button class="nutri" data-resa="${m.id}">Réserver${m.remaining !== null ? ` (${m.remaining} places)` : ''}</button>`}</div>
      </div>`).join('') || '<p class="muted">Aucun menu à venir.</p>'}</div>`;
  $$('.zoom', app).forEach((img) => img.addEventListener('click', () => zoomImage(img.src)));
  $$('[data-resa]', app).forEach((b) => b.addEventListener('click', () => {
    if (!state.user) { location.hash = '#/login'; return; }
    reserveModal(menus.find((m) => m.id === Number(b.dataset.resa)));
  }));
}

function reserveModal(menu) {
  const loc = { lat: null, lng: null };
  openModal(`
    <h2>Réserver « ${esc(menu.title)} »</h2>
    <p class="muted">${fmtDate(menu.date)} · ${money(menu.price)} / portion</p>
    <form class="stack" id="rf">
      <label>Nombre de portions<input name="quantity" type="number" min="1" value="1"></label>
      <label>Mode<select name="mode"><option value="pickup">Retrait</option><option value="delivery">Livraison</option></select></label>
      <div id="rbox" class="stack" hidden>
        <button type="button" id="rgeo">📍 Utiliser ma position</button>
        <div id="rmap" class="map small"></div>
        <label>Adresse / repère<input name="address"></label>
      </div>
      <label>Note (allergies, contraintes…)<textarea name="note" rows="2"></textarea></label>
      <div class="row"><button class="nutri">Réserver</button><button type="button" data-close>Annuler</button></div>
    </form>`, (root) => {
    let picker = null;
    const setLoc = (p) => { loc.lat = p.lat; loc.lng = p.lng; $('#rgeo', root).textContent = '📍 Position enregistrée'; };
    const sel = $('[name=mode]', root);
    sel.addEventListener('change', () => {
      $('#rbox', root).hidden = sel.value !== 'delivery';
      if (!picker && sel.value === 'delivery') picker = pickerMap($('#rmap', root), state.pos, setLoc);
      picker?.map.invalidateSize();
    });
    $('#rgeo', root).addEventListener('click', async () => { const p = await attempt(getPosition); if (p) (picker ? picker.place(p) : setLoc(p)); });
    $('#rf', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const ok = await attempt(() => api('POST', `/nutri-menus/${menu.id}/reservations`, { ...formData(e.target), ...loc }), 'Réservation enregistrée');
      if (ok) { closeModal(); render(); }
    });
  });
}

// ================= Espace patient (plan, rappels, consultations, messages) =================

function daysPicker(value = '0123456') {
  return `<div class="days">${DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" ${value.includes(String(i)) ? 'checked' : ''}>${d}</label>`).join('')}</div>`;
}
const readDays = (root) => $$('.days input:checked', root).map((i) => i.value).join('');

function planHtml(p) {
  const byDay = (d) => (d === null ? 'Tous les jours' : DAYS[d]);
  return `<div class="card">
      <div class="row spread"><h3>${esc(p.title)}</h3><span class="muted">${p.start_date ? `du ${esc(p.start_date)}` : ''} ${p.end_date ? `au ${esc(p.end_date)}` : ''}</span></div>
      ${p.notes ? `<p>${esc(p.notes)}</p>` : ''}
      <table><tr><th>Jour</th><th>Repas</th><th>Heure</th><th>Contenu</th></tr>
        ${p.items.map((i) => `<tr><td>${byDay(i.day_of_week)}</td><td>${esc(i.meal)}</td><td>${esc(i.time || '')}</td><td>${esc(i.description)}</td></tr>`).join('')}
      </table>
      ${p.nutritionist_name ? `<p class="muted">Proposé par ${esc(p.nutritionist_name)}</p>` : ''}
    </div>`;
}

// Liste de rappels éditable (patient ou nutritionniste)
async function remindersSection(el, patientId) {
  const q = patientId ? `?patient_id=${patientId}` : '';
  const list = await api('GET', `/reminders${q}`);
  el.innerHTML = `
    ${list.map((r) => `<div class="card" data-id="${r.id}">
        <div class="row">
          <input class="r-time" type="time" value="${esc(r.time)}" style="width:auto">
          <input class="r-label" value="${esc(r.label)}" style="flex:1;min-width:160px">
          <label style="display:inline-flex;gap:4px;align-items:center"><input class="r-active" type="checkbox" style="width:auto" ${r.active ? 'checked' : ''}> actif</label>
        </div>
        ${daysPicker(r.days)}
        <div class="row spread"><span class="muted">Créé par ${esc(r.created_by_name)}</span>
          <span><button class="r-save">Enregistrer</button> <button class="danger r-del">Supprimer</button></span></div>
      </div>`).join('') || '<p class="muted">Aucun rappel.</p>'}
    <form class="card stack" id="r-new"><h3>Nouveau rappel</h3>
      <div class="inline"><input name="time" type="time" required><input name="label" placeholder="Ex. Collation : 1 fruit" required></div>
      ${daysPicker()}
      <button class="nutri">Ajouter</button></form>`;
  const reload = () => remindersSection(el, patientId);
  $$('[data-id]', el).forEach((card) => {
    const id = card.dataset.id;
    $('.r-save', card).addEventListener('click', async () => {
      const body = { time: $('.r-time', card).value, label: $('.r-label', card).value, active: $('.r-active', card).checked, days: readDays(card) };
      if (await attempt(() => api('PATCH', `/reminders/${id}`, body), 'Rappel mis à jour')) { reload(); startReminders(); }
    });
    $('.r-del', card).addEventListener('click', async () => {
      if (confirm('Supprimer ce rappel ?') && await attempt(() => api('DELETE', `/reminders/${id}`))) reload();
    });
  });
  $('#r-new', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { ...formData(e.target), days: readDays(e.target), patient_id: patientId };
    if (await attempt(() => api('POST', '/reminders', body), 'Rappel ajouté')) { reload(); startReminders(); }
  });
}

// Fil de discussion avec un autre utilisateur
async function chatSection(el, otherId) {
  const msgs = await api('GET', `/messages/${otherId}`);
  el.innerHTML = `<div class="chat">${msgs.map((m) => `<div class="msg ${m.sender_id === state.user.id ? 'me' : ''}">${esc(m.body)}
      <div class="muted" style="font-size:.75rem">${fmtDateTime(m.created_at + 'Z')}</div></div>`).join('') || '<p class="muted">Aucun message.</p>'}</div>
    <form class="inline" style="margin-top:6px"><input name="body" placeholder="Votre message…" required><button class="nutri" style="flex:none">Envoyer</button></form>`;
  const chat = $('.chat', el);
  chat.scrollTop = chat.scrollHeight;
  $('form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('POST', `/messages/${otherId}`, formData(e.target)))) chatSection(el, otherId);
  });
}

async function viewPatientSpace(app) {
  if (!needRole(app, 'client')) return;
  const [plans, nutris, allNutris, consults] = await Promise.all([
    api('GET', '/nutrition/plans'), api('GET', '/nutrition/my-nutritionists'), api('GET', '/nutritionists'), api('GET', '/consultations'),
  ]);
  const notifOk = 'Notification' in window && Notification.permission === 'granted';
  app.innerHTML = `
    <h1>🩺 Mon suivi santé</h1>
    <h2>Mes plans alimentaires</h2>
    ${plans.map(planHtml).join('') || '<p class="muted">Aucun plan pour le moment. Demandez une consultation à un nutritionniste.</p>'}
    <h2>Mes rappels de repas</h2>
    ${notifOk ? '' : '<p><button id="notif">🔔 Activer les notifications</button> <span class="muted">(laissez cette page ouverte pour recevoir les rappels)</span></p>'}
    <div id="reminders"></div>
    <h2>Consultations à distance</h2>
    ${consults.map((c) => `<div class="card"><div class="row spread"><strong>${esc(c.nutritionist_name)} · ${fmtDateTime(c.scheduled_at)}</strong>${badge(c.status)}</div>
        <div class="muted">${esc({ video: '🎥 Vidéo', phone: '📞 Téléphone', chat: '💬 Messagerie', in_person: '🏥 Présentiel' }[c.mode])} ${c.reason ? `· ${esc(c.reason)}` : ''}</div>
        ${c.link ? `<a class="btn nutri" target="_blank" rel="noopener" href="${esc(c.link)}">Rejoindre la consultation</a>` : ''}
        ${c.report ? `<p><b>Compte rendu :</b> ${esc(c.report)}</p>` : ''}
        ${['requested', 'scheduled'].includes(c.status) ? `<button class="danger" data-cc="${c.id}">Annuler</button>` : ''}</div>`).join('')}
    <form class="card stack" id="cf"><h3>Demander une consultation</h3>
      <label>Nutritionniste<select name="nutritionist_id" required>${allNutris.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')}</select></label>
      <div class="inline"><label>Date et heure souhaitées<input name="scheduled_at" type="datetime-local" required></label>
        <label>Mode<select name="mode"><option value="video">Vidéo</option><option value="phone">Téléphone</option><option value="chat">Messagerie</option><option value="in_person">Présentiel</option></select></label></div>
      <label>Motif<textarea name="reason" rows="2"></textarea></label>
      <button class="nutri" ${allNutris.length ? '' : 'disabled'}>Envoyer la demande</button></form>
    <h2>Messages</h2>
    ${nutris.map((n) => `<div class="card"><h3>${esc(n.name)}</h3><div data-chat="${n.id}"></div></div>`).join('') || '<p class="muted">Aucun nutritionniste ne vous suit encore.</p>'}`;
  $('#notif')?.addEventListener('click', async () => { await Notification.requestPermission(); render(); });
  remindersSection($('#reminders'), null);
  $$('[data-chat]', app).forEach((el) => chatSection(el, el.dataset.chat));
  $$('[data-cc]', app).forEach((b) => b.addEventListener('click', async () => {
    if (await attempt(() => api('PATCH', `/consultations/${b.dataset.cc}`, { status: 'cancelled' }))) render();
  }));
  $('#cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('POST', '/consultations', formData(e.target)), 'Demande envoyée')) render();
  });
}

// Déclenchement des rappels côté navigateur (vérification chaque minute)
let reminderTimer = null;
async function startReminders() {
  clearInterval(reminderTimer);
  if (state.user?.role !== 'client') return;
  let list = [];
  const refresh = async () => { list = await api('GET', '/reminders').catch(() => list); };
  await refresh();
  const tick = () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    list.filter((r) => r.active && r.time === hhmm && r.days.includes(String(now.getDay()))).forEach((r) => {
      const key = `rem-${r.id}-${isoDate(0)}-${hhmm}`;
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
      toast(`⏰ ${r.label}`, 'reminder');
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Rappel repas', { body: r.label });
    });
  };
  let n = 0;
  reminderTimer = setInterval(() => { if (++n % 10 === 0) refresh(); tick(); }, 30000);
  tick();
}

// ================= Vendeuse =================

async function myShops() {
  return api('GET', '/shops/mine');
}

function shopSelector(shops, current) {
  if (shops.length < 2) return '';
  return `<select id="shop-sel" style="width:auto">${shops.map((s) => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
}

function currentShop(shops) {
  const saved = Number(localStorage.getItem('shop'));
  return shops.find((s) => s.id === saved) || shops[0];
}

function wireShopSel(app) {
  $('#shop-sel', app)?.addEventListener('change', (e) => { localStorage.setItem('shop', e.target.value); render(); });
}

function noShop(app) {
  app.innerHTML = '<div class="card"><p>Créez d\'abord votre point de vente.</p><a class="btn primary" href="#/boutique">Créer mon point de vente</a></div>';
}

async function viewMyShop(app, params) {
  if (!needRole(app, 'vendor')) return;
  const shops = await myShops();
  const shop = params.get('new') ? null : currentShop(shops);
  const loc = { lat: shop?.lat ?? null, lng: shop?.lng ?? null };
  app.innerHTML = `
    <div class="row spread"><h1>${shop ? 'Mon point de vente' : 'Nouveau point de vente'}</h1>
      <div class="row">${shopSelector(shops, shop?.id)} ${shop ? '<a class="btn" href="#/boutique?new=1">+ Autre point de vente</a>' : ''}</div></div>
    <form class="card stack" id="sf" style="max-width:none">
      <label>Nom<input name="name" required value="${esc(shop?.name)}"></label>
      <label>Description<textarea name="description" rows="2">${esc(shop?.description)}</textarea></label>
      <div class="inline"><label>Adresse / quartier<input name="address" value="${esc(shop?.address)}"></label>
        <label>Téléphone<input name="phone" value="${esc(shop?.phone)}"></label></div>
      <label><input type="checkbox" name="delivery" style="width:auto" ${!shop || shop.delivery ? 'checked' : ''}> Je propose la livraison</label>
      <div class="row"><button type="button" id="geo">📍 Utiliser ma position</button><span class="muted" id="st">Touchez la carte pour placer votre point de vente</span></div>
      <div id="smap" class="map"></div>
      <button class="primary">Enregistrer</button>
    </form>`;
  wireShopSel(app);
  const st = $('#st');
  const setLoc = (p) => { loc.lat = p.lat; loc.lng = p.lng; st.textContent = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`; };
  const picker = pickerMap($('#smap'), loc.lat != null ? loc : null, setLoc);
  $('#geo').addEventListener('click', async () => { const p = await attempt(getPosition); if (p) (picker ? picker.place(p) : setLoc(p)); });
  $('#sf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { ...formData(e.target), ...loc, delivery: e.target.delivery.checked };
    const saved = await attempt(() => (shop ? api('PUT', `/shops/${shop.id}`, body) : api('POST', '/shops', body)), 'Point de vente enregistré');
    if (saved) { localStorage.setItem('shop', saved.id); location.hash = '#/plats'; }
  });
}

async function viewDishes(app) {
  if (!needRole(app, 'vendor')) return;
  const shops = await myShops();
  if (!shops.length) return noShop(app);
  const shop = currentShop(shops);
  const dishes = await api('GET', `/shops/${shop.id}/dishes`);
  app.innerHTML = `
    <div class="row spread"><h1>Mes plats</h1>${shopSelector(shops, shop.id)}</div>
    <p class="muted">Créez vos plats une seule fois, puis choisissez chaque jour ceux qui sont disponibles dans « Menu du jour ».</p>
    <form class="card stack" id="df" style="max-width:none"><h3>Ajouter un plat</h3>
      <div class="inline"><label>Nom<input name="name" required placeholder="Ex. Ndolé + plantain"></label>
        <label>Prix (FCFA)<input name="price" type="number" min="0" step="50"></label></div>
      <label>Description<input name="description"></label>
      <label>Photo<input name="image" type="file" accept="image/*"></label>
      <button class="primary">Ajouter</button></form>
    <div class="grid">${dishes.map((d) => `<div class="card">
        ${d.image ? `<img src="${esc(d.image)}" style="width:100%;height:140px;object-fit:cover;border-radius:8px">` : ''}
        <div class="row spread"><strong>${esc(d.name)}</strong><span class="price">${money(d.price)}</span></div>
        <div class="muted">${esc(d.description || '')}</div>
        <div class="row" style="margin-top:6px"><button data-edit="${d.id}">Modifier</button><button class="danger" data-del="${d.id}">Retirer</button></div>
      </div>`).join('')}</div>`;
  wireShopSel(app);
  $('#df').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('POST', `/shops/${shop.id}/dishes`, new FormData(e.target)), 'Plat ajouté')) render();
  });
  $$('[data-del]', app).forEach((b) => b.addEventListener('click', async () => {
    if (confirm('Retirer ce plat du catalogue ?') && await attempt(() => api('DELETE', `/dishes/${b.dataset.del}`))) render();
  }));
  $$('[data-edit]', app).forEach((b) => b.addEventListener('click', () => {
    const d = dishes.find((x) => x.id === Number(b.dataset.edit));
    openModal(`<h2>Modifier le plat</h2><form class="stack" id="ef">
        <label>Nom<input name="name" required value="${esc(d.name)}"></label>
        <label>Prix<input name="price" type="number" value="${d.price}"></label>
        <label>Description<input name="description" value="${esc(d.description)}"></label>
        <label>Nouvelle photo<input name="image" type="file" accept="image/*"></label>
        <div class="row"><button class="primary">Enregistrer</button><button type="button" data-close>Annuler</button></div></form>`, (root) => {
      $('#ef', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        if (await attempt(() => api('PUT', `/dishes/${d.id}`, new FormData(e.target)), 'Plat modifié')) { closeModal(); render(); }
      });
    });
  }));
}

async function viewDaily(app, params) {
  if (!needRole(app, 'vendor')) return;
  const shops = await myShops();
  if (!shops.length) return noShop(app);
  const shop = currentShop(shops);
  const date = params.get('date') || isoDate(0);
  const [dishes, selected, menu] = await Promise.all([
    api('GET', `/shops/${shop.id}/dishes`), api('GET', `/shops/${shop.id}/daily/${date}`), api('GET', `/shops/${shop.id}/menu?date=${date}`),
  ]);
  const sel = new Map(selected.map((s) => [s.id, s]));
  app.innerHTML = `
    <div class="row spread"><h1>Menu du ${fmtDate(date)}</h1>
      <div class="row">${shopSelector(shops, shop.id)}${daySwitch(date)}<input type="date" id="dp" value="${date}" style="width:auto"></div></div>
    <div class="card"><h3>Plats disponibles ce jour</h3>
      <p class="muted">Cochez les plats du jour. Indiquez le nombre de portions pour arrêter les commandes automatiquement quand tout est vendu (vide = illimité).</p>
      ${dishes.length ? `<table><tr><th></th><th>Plat</th><th>Prix</th><th>Portions</th><th>Reste</th></tr>
        ${dishes.map((d) => `<tr><td><input type="checkbox" data-dish="${d.id}" style="width:auto" ${sel.has(d.id) ? 'checked' : ''}></td>
          <td>${esc(d.name)}</td><td>${money(d.price)}</td>
          <td><input type="number" min="0" data-qty="${d.id}" value="${sel.get(d.id)?.quantity ?? ''}" style="width:90px"></td>
          <td>${sel.has(d.id) ? (sel.get(d.id).remaining ?? '∞') : ''}</td></tr>`).join('')}
      </table>
      <div class="row" style="margin-top:8px"><button class="primary" id="save">Publier la sélection</button>
        <button id="copy">Reprendre le menu de la veille</button></div>`
        : '<p>Aucun plat. <a href="#/plats">Ajoutez vos plats</a>.</p>'}
    </div>
    <div class="card"><h3>Publication du jour (message / capture d'écran)</h3>
      <form class="stack" id="pf" style="max-width:none">
        <textarea name="message" rows="3" placeholder="Ex. Aujourd'hui : poulet DG, eru… Livraison à partir de 12h !"></textarea>
        <input type="file" name="image" accept="image/*">
        <button class="primary">Publier</button></form>
      ${menu.posts.map((p) => `<div>${postBlock(p)}<button class="danger" data-delpost="${p.id}">Supprimer</button></div>`).join('')}
    </div>
    <p><a class="btn" href="#/boutique-client?id=${shop.id}&date=${date}">👁️ Voir comme un client</a></p>`;
  wireShopSel(app);
  const go = (d) => { location.hash = `#/jour?date=${d}`; };
  $$('.seg button', app).forEach((b) => b.addEventListener('click', () => go(b.dataset.date)));
  $('#dp').addEventListener('change', (e) => go(e.target.value));
  $$('.zoom', app).forEach((img) => img.addEventListener('click', () => zoomImage(img.src)));
  const saveItems = (items) => api('PUT', `/shops/${shop.id}/daily/${date}`, { items });
  $('#save')?.addEventListener('click', async () => {
    const items = $$('[data-dish]:checked', app).map((c) => ({ dish_id: Number(c.dataset.dish), quantity: $(`[data-qty="${c.dataset.dish}"]`, app).value }));
    if (await attempt(() => saveItems(items), 'Menu du jour publié')) render();
  });
  $('#copy')?.addEventListener('click', async () => {
    const prev = new Date(`${date}T12:00:00`);
    prev.setDate(prev.getDate() - 1);
    const prevIso = prev.toISOString().slice(0, 10);
    const items = (await api('GET', `/shops/${shop.id}/daily/${prevIso}`)).map((d) => ({ dish_id: d.id, quantity: d.quantity }));
    if (!items.length) return toast('Aucun menu la veille', 'error');
    if (await attempt(() => saveItems(items), 'Menu de la veille repris')) render();
  });
  $('#pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    fd.append('date', date);
    if (await attempt(() => api('POST', `/shops/${shop.id}/posts`, fd), 'Publication ajoutée')) render();
  });
  $$('[data-delpost]', app).forEach((b) => b.addEventListener('click', async () => {
    if (await attempt(() => api('DELETE', `/posts/${b.dataset.delpost}`))) render();
  }));
}

async function viewReceived(app, params) {
  if (!needRole(app, 'vendor')) return;
  const date = params.get('date') ?? isoDate(0);
  const status = params.get('status') || '';
  const q = new URLSearchParams();
  if (date) q.set('date', date);
  if (status) q.set('status', status);
  const orders = await api('GET', `/orders/received?${q}`);
  const active = orders.filter((o) => o.status !== 'cancelled');
  const totals = {};
  active.forEach((o) => o.items.forEach((i) => { totals[i.name] = (totals[i.name] || 0) + i.quantity; }));
  const NEXT = { pending: ['confirmed', 'Confirmer'], confirmed: ['preparing', 'En préparation'], preparing: ['delivering', 'En livraison / prête'], delivering: ['done', 'Terminée'] };
  app.innerHTML = `
    <div class="row spread"><h1>Commandes reçues</h1>
      <div class="row"><input type="date" id="fd" value="${esc(date)}" style="width:auto">
        <select id="fs" style="width:auto"><option value="">Tous statuts</option>
          ${Object.keys(NEXT).concat('done', 'cancelled').map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}</select>
        <button id="all">Toutes dates</button></div></div>
    <div class="card"><b>${active.length} commande(s)</b> · ${money(active.reduce((s, o) => s + o.total, 0))}
      <div class="muted">${Object.entries(totals).map(([n, q2]) => `${q2} × ${esc(n)}`).join(' · ')}</div></div>
    ${active.some((o) => o.lat != null) ? '<div id="omap" class="map small"></div>' : ''}
    ${orders.map((o) => `<div class="card">
        <div class="row spread"><strong>#${o.id} · ${esc(o.client_name)}</strong>${badge(o.status)}</div>
        <div class="muted">${fmtDate(o.date)} · reçue le ${fmtDateTime(o.created_at + 'Z')} · ${esc(o.shop_name)}</div>
        <div>${o.items.map((i) => `${i.quantity} × ${esc(i.name)}`).join(', ')} — <b>${money(o.total)}</b></div>
        <div>${o.mode === 'delivery' ? '🛵 <b>Livraison</b>' : '🏃 Retrait / sur place'}
          ${o.address ? ` · ${esc(o.address)}` : ''}
          ${o.lat != null ? ` · <a target="_blank" rel="noopener" href="${mapsLink(o.lat, o.lng)}">📍 Voir la position</a> · <a target="_blank" rel="noopener" href="${directionsLink(o.lat, o.lng)}">🧭 Itinéraire</a>` : ''}</div>
        ${o.phone || o.client_phone ? `<div>☎️ <a href="tel:${esc(o.phone || o.client_phone)}">${esc(o.phone || o.client_phone)}</a>
          · <a target="_blank" rel="noopener" href="https://wa.me/${esc(String(o.phone || o.client_phone).replace(/\D/g, ''))}">WhatsApp</a></div>` : ''}
        ${o.note ? `<div class="muted">📝 ${esc(o.note)}</div>` : ''}
        <div class="row" style="margin-top:6px">
          ${NEXT[o.status] ? `<button class="primary" data-st="${NEXT[o.status][0]}" data-id="${o.id}">${NEXT[o.status][1]}</button>` : ''}
          ${!['done', 'cancelled'].includes(o.status) ? `<button class="danger" data-st="cancelled" data-id="${o.id}">Annuler</button>` : ''}
        </div></div>`).join('') || '<p class="muted">Aucune commande.</p>'}`;
  const nav = (d, s) => { location.hash = `#/recues?date=${d}&status=${s}`; };
  $('#fd').addEventListener('change', (e) => nav(e.target.value, status));
  $('#fs').addEventListener('change', (e) => nav(date, e.target.value));
  $('#all').addEventListener('click', () => nav('', status));
  $$('[data-st]', app).forEach((b) => b.addEventListener('click', async () => {
    if (await attempt(() => api('PATCH', `/orders/${b.dataset.id}/status`, { status: b.dataset.st }))) render();
  }));
  const omap = $('#omap');
  if (omap) {
    const pts = active.filter((o) => o.lat != null);
    const map = makeMap(omap, [pts[0].lat, pts[0].lng]);
    if (map) {
      pts.forEach((o) => L.marker([o.lat, o.lng]).addTo(map).bindPopup(`#${o.id} ${esc(o.client_name)}`));
      map.fitBounds(pts.map((o) => [o.lat, o.lng]), { padding: [30, 30], maxZoom: 15 });
    }
  }
  // Rafraîchissement automatique pour voir les nouvelles commandes
  const known = orders.length;
  refreshTimer = setInterval(async () => {
    const fresh = await api('GET', `/orders/received?${q}`).catch(() => null);
    if (fresh && fresh.length !== known) { toast('🔔 Nouvelle commande !'); render(); }
  }, 30000);
}

// ================= Nutritionniste =================

async function viewPatients(app, params) {
  if (!needRole(app, 'nutritionist')) return;
  const patients = await api('GET', '/nutrition/patients');
  const pid = Number(params.get('id')) || null;
  const p = patients.find((x) => x.id === pid);
  app.innerHTML = `
    <h1>Mes patients</h1>
    <div class="row" style="align-items:flex-start">
      <div style="flex:1;min-width:240px">
        <form class="card stack" id="af"><h3>Ajouter un patient</h3>
          <input name="email" type="email" placeholder="Email du compte du patient" required>
          <button class="nutri">Ajouter</button></form>
        ${patients.map((x) => `<a class="card" style="display:block;text-decoration:none;color:inherit;${x.id === pid ? 'border-color:var(--nutri)' : ''}" href="#/patients?id=${x.id}">
            <strong>${esc(x.name)}</strong><div class="muted">${esc(x.phone || x.email)}</div></a>`).join('')}
      </div>
      <div style="flex:3;min-width:300px" id="detail">${p ? '' : '<p class="muted">Sélectionnez un patient.</p>'}</div>
    </div>`;
  $('#af').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await attempt(() => api('POST', '/nutrition/patients', formData(e.target)), 'Patient ajouté');
    if (r) location.hash = `#/patients?id=${r.id}`;
  });
  if (p) await patientDetail($('#detail'), p);
}

async function patientDetail(el, p) {
  const plans = await api('GET', `/nutrition/plans?patient_id=${p.id}`);
  el.innerHTML = `
    <div class="card"><div class="row spread"><h2 style="margin:0">${esc(p.name)}</h2>
      <span class="muted">${esc(p.email)} ${p.phone ? `· <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ''}</span></div>
      <label>Notes de suivi (privées)<textarea id="pnotes" rows="3">${esc(p.notes)}</textarea></label>
      <div class="row"><button id="savenotes">Enregistrer les notes</button>
        <a class="btn" href="#/consultations?patient=${p.id}">Planifier une consultation</a>
        <button class="danger" id="unlink">Retirer du suivi</button></div></div>
    <h2>Plans alimentaires</h2>
    ${plans.map((pl) => `${planHtml(pl)}<button class="danger" data-delplan="${pl.id}">Supprimer ce plan</button>`).join('') || '<p class="muted">Aucun plan.</p>'}
    <form class="card stack" id="plf" style="max-width:none"><h3>Nouveau plan personnalisé</h3>
      <label>Titre<input name="title" required placeholder="Ex. Rééquilibrage — diabète type 2"></label>
      <div class="inline"><label>Début<input name="start_date" type="date"></label><label>Fin<input name="end_date" type="date"></label></div>
      <label>Recommandations générales<textarea name="notes" rows="2"></textarea></label>
      <table id="items"><tr><th>Jour</th><th>Repas</th><th>Heure</th><th>Contenu</th><th></th></tr></table>
      <button type="button" id="additem">+ Ajouter un repas</button>
      <label><input type="checkbox" name="create_reminders" checked style="width:auto"> Créer les rappels de prise de repas pour le patient</label>
      <button class="nutri">Enregistrer le plan</button></form>
    <h2>Rappels du patient</h2><div id="prem"></div>
    <h2>Messages</h2><div class="card" id="pchat"></div>`;
  const addItem = (meal = '', time = '') => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><select class="i-day"><option value="">Tous les jours</option>${DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select></td>
      <td><input class="i-meal" value="${meal}" placeholder="Déjeuner"></td><td><input class="i-time" type="time" value="${time}"></td>
      <td><input class="i-desc" placeholder="Ex. Poisson braisé + légumes vapeur"></td><td><button type="button" class="danger">✕</button></td>`;
    tr.querySelector('button').addEventListener('click', () => tr.remove());
    $('#items', el).append(tr);
  };
  addItem('Petit-déjeuner', '07:00');
  addItem('Déjeuner', '13:00');
  addItem('Dîner', '19:30');
  $('#additem', el).addEventListener('click', () => addItem());
  $('#plf', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = $$('#items tr', el).slice(1)
      .map((tr) => ({ day_of_week: $('.i-day', tr).value, meal: $('.i-meal', tr).value.trim(), time: $('.i-time', tr).value, description: $('.i-desc', tr).value.trim() }))
      .filter((i) => i.meal && i.description);
    const body = { ...formData(e.target), create_reminders: e.target.create_reminders.checked, patient_id: p.id, items };
    if (await attempt(() => api('POST', '/nutrition/plans', body), 'Plan enregistré')) render();
  });
  $('#savenotes', el).addEventListener('click', () => attempt(() => api('PUT', `/nutrition/patients/${p.id}`, { notes: $('#pnotes', el).value }), 'Notes enregistrées'));
  $('#unlink', el).addEventListener('click', async () => {
    if (confirm('Retirer ce patient de votre suivi ?') && await attempt(() => api('DELETE', `/nutrition/patients/${p.id}`))) location.hash = '#/patients';
  });
  $$('[data-delplan]', el).forEach((b) => b.addEventListener('click', async () => {
    if (confirm('Supprimer ce plan ?') && await attempt(() => api('DELETE', `/nutrition/plans/${b.dataset.delplan}`))) render();
  }));
  remindersSection($('#prem', el), p.id);
  chatSection($('#pchat', el), p.id);
}

async function viewConsultations(app, params) {
  if (!needRole(app, 'nutritionist')) return;
  const [list, patients] = await Promise.all([api('GET', '/consultations'), api('GET', '/nutrition/patients')]);
  const pre = Number(params.get('patient'));
  app.innerHTML = `
    <h1>Consultations</h1>
    <form class="card stack" id="cf" style="max-width:none"><h3>Planifier une consultation</h3>
      <div class="inline"><label>Patient<select name="patient_id" required>${patients.map((p) => `<option value="${p.id}" ${p.id === pre ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label>Date et heure<input name="scheduled_at" type="datetime-local" required></label>
        <label>Mode<select name="mode"><option value="video">Vidéo</option><option value="phone">Téléphone</option><option value="chat">Messagerie</option><option value="in_person">Présentiel</option></select></label></div>
      <label>Lien de visioconférence<input name="link" placeholder="Laissez vide pour générer un lien Jitsi"></label>
      <label>Motif<input name="reason"></label>
      <button class="nutri" ${patients.length ? '' : 'disabled'}>Planifier</button></form>
    ${list.map((c) => `<div class="card" data-c="${c.id}">
        <div class="row spread"><strong>${esc(c.patient_name)} · ${fmtDateTime(c.scheduled_at)}</strong>${badge(c.status)}</div>
        <div class="muted">${esc(c.mode)} ${c.reason ? `· ${esc(c.reason)}` : ''} ${c.patient_phone ? `· ☎️ ${esc(c.patient_phone)}` : ''}</div>
        <div class="inline"><input class="c-when" type="datetime-local" value="${esc(c.scheduled_at.slice(0, 16))}"><input class="c-link" placeholder="Lien visio" value="${esc(c.link)}"></div>
        <textarea class="c-report" rows="2" placeholder="Compte rendu">${esc(c.report)}</textarea>
        <div class="row">${c.link ? `<a class="btn nutri" target="_blank" rel="noopener" href="${esc(c.link)}">Rejoindre</a>` : ''}
          <button data-s="scheduled">Confirmer / enregistrer</button><button data-s="done">Terminée</button><button class="danger" data-s="cancelled">Annuler</button></div>
      </div>`).join('') || '<p class="muted">Aucune consultation.</p>'}`;
  $('#cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = formData(e.target);
    if (!body.link && body.mode === 'video') body.link = `https://meet.jit.si/fshop-${Math.random().toString(36).slice(2, 10)}`;
    if (await attempt(() => api('POST', '/consultations', body), 'Consultation planifiée')) render();
  });
  $$('[data-c]', app).forEach((card) => $$('[data-s]', card).forEach((b) => b.addEventListener('click', async () => {
    let link = $('.c-link', card).value;
    if (!link && b.dataset.s === 'scheduled') link = `https://meet.jit.si/fshop-${Math.random().toString(36).slice(2, 10)}`;
    const body = { status: b.dataset.s, scheduled_at: $('.c-when', card).value, link, report: $('.c-report', card).value };
    if (await attempt(() => api('PATCH', `/consultations/${card.dataset.c}`, body), 'Consultation mise à jour')) render();
  })));
}

async function viewMyNutriMenus(app) {
  if (!needRole(app, 'nutritionist')) return;
  const [menus, services] = await Promise.all([api('GET', '/nutri-menus?mine=1'), api('GET', '/services')]);
  app.innerHTML = `
    <h1>Mes menus diététiques</h1>
    <p class="muted">Ces menus apparaissent dans l'onglet « Menus nutritionniste » des clients, qui peuvent les réserver. Le service spécialisé choisi reçoit les réservations à préparer.</p>
    <form class="card stack" id="mf" style="max-width:none"><h3>Proposer un menu</h3>
      <div class="inline"><label>Titre<input name="title" required placeholder="Ex. Menu hyposodé"></label><label>Date de service<input name="date" type="date" required value="${isoDate(1)}"></label></div>
      <label>Composition / description<textarea name="description" rows="2"></textarea></label>
      <div class="inline"><label>Public cible<input name="target" placeholder="Diabète, hypertension…"></label>
        <label>Calories<input name="calories" type="number"></label>
        <label>Prix (FCFA)<input name="price" type="number" min="0"></label>
        <label>Places<input name="capacity" type="number" min="1" placeholder="Illimité"></label></div>
      <label>Service qui prépare<select name="service_id"><option value="">— Aucun —</option>${services.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>Photo<input type="file" name="image" accept="image/*"></label>
      <button class="nutri">Publier</button></form>
    <div class="grid">${menus.map((m) => `<div class="card"><h3>${esc(m.title)}</h3>
        <div class="muted">${fmtDate(m.date)} · ${money(m.price)} · ${m.remaining === null ? 'illimité' : `${m.remaining}/${m.capacity} places`}</div>
        <div class="muted">${m.service_name ? `Préparé par ${esc(m.service_name)}` : 'Aucun service assigné'}</div>
        <button class="danger" data-del="${m.id}">Supprimer</button></div>`).join('')}</div>`;
  $('#mf').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await attempt(() => api('POST', '/nutri-menus', new FormData(e.target)), 'Menu publié')) render();
  });
  $$('[data-del]', app).forEach((b) => b.addEventListener('click', async () => {
    if (confirm('Supprimer ce menu et ses réservations ?') && await attempt(() => api('DELETE', `/nutri-menus/${b.dataset.del}`))) render();
  }));
}

async function viewReservations(app) {
  if (!needRole(app, 'nutritionist', 'service')) return;
  const list = await api('GET', '/reservations/received');
  const NEXT = { pending: ['confirmed', 'Confirmer'], confirmed: ['ready', 'Prête'], ready: ['done', 'Remise / livrée'] };
  app.innerHTML = `
    <h1>${state.user.role === 'service' ? 'Réservations à préparer' : 'Réservations de mes menus'}</h1>
    ${list.map((r) => `<div class="card">
        <div class="row spread"><strong>${esc(r.title)} — ${r.quantity} portion(s)</strong>${badge(r.status)}</div>
        <div class="muted">${fmtDate(r.date)} · ${esc(r.client_name)} ${r.client_phone ? `· ☎️ <a href="tel:${esc(r.client_phone)}">${esc(r.client_phone)}</a>` : ''}</div>
        <div>${r.mode === 'delivery' ? '🛵 Livraison' : '🏃 Retrait'} ${r.address ? `· ${esc(r.address)}` : ''}
          ${r.lat != null ? `· <a target="_blank" rel="noopener" href="${mapsLink(r.lat, r.lng)}">📍 Position</a>` : ''}</div>
        ${r.note ? `<div class="muted">📝 ${esc(r.note)}</div>` : ''}
        <div class="row">${NEXT[r.status] ? `<button class="nutri" data-id="${r.id}" data-st="${NEXT[r.status][0]}">${NEXT[r.status][1]}</button>` : ''}
          ${!['done', 'cancelled'].includes(r.status) ? `<button class="danger" data-id="${r.id}" data-st="cancelled">Annuler</button>` : ''}</div>
      </div>`).join('') || '<p class="muted">Aucune réservation.</p>'}`;
  $$('[data-st]', app).forEach((b) => b.addEventListener('click', async () => {
    if (await attempt(() => api('PATCH', `/reservations/${b.dataset.id}/status`, { status: b.dataset.st }))) render();
  }));
}

// ================= Démarrage =================

render();
startReminders();
