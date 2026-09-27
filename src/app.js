const express = require('express');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { openDb } = require('./db');
const { loadUser } = require('./auth');

const ROOT = path.join(__dirname, '..');

function createApp({
  dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'fshop.db'),
  uploadDir = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'),
} = {}) {
  const db = openDb(dbFile);
  fs.mkdirSync(uploadDir, { recursive: true });

  // Images (plats, captures d'écran des menus) : 5 Mo max
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(loadUser(db));

  const api = express.Router();
  api.use('/auth', require('./routes/auth')(db));
  api.use(require('./routes/shops')(db, upload));
  api.use(require('./routes/orders')(db));
  api.use(require('./routes/nutrition')(db, upload));
  api.use((_req, res) => res.status(404).json({ error: 'Route inconnue' }));
  app.use('/api', api);

  app.use('/uploads', express.static(uploadDir));
  app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist')));
  app.use(express.static(path.join(ROOT, 'public')));

  // Gestion centralisée des erreurs
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erreur serveur' : err.message });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
