class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  return n === null ? null : Math.trunc(n);
}

function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') {
      fail(400, `Champ requis : ${f}`);
    }
  }
}

function checkDate(d) {
  if (!DATE_RE.test(d || '')) fail(400, 'Date invalide (format AAAA-MM-JJ)');
  return d;
}

function checkTime(t) {
  if (!TIME_RE.test(t || '')) fail(400, 'Heure invalide (format HH:MM)');
  return t;
}

// Distance en km entre deux points GPS (formule de haversine)
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Enveloppe les handlers pour renvoyer proprement les erreurs
const wrap = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) {
    next(e);
  }
};

const fileUrl = (file) => (file ? `/uploads/${file.filename}` : null);

module.exports = { HttpError, fail, toNum, toInt, requireFields, checkDate, checkTime, distanceKm, wrap, fileUrl };
