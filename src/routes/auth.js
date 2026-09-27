const express = require('express');
const { hashPassword, verifyPassword, createSession, publicUser, requireAuth } = require('../auth');
const { fail, requireFields, wrap } = require('../util');

const ROLES = ['vendor', 'nutritionist', 'service', 'client'];

module.exports = (db) => {
  const r = express.Router();

  r.post('/register', wrap((req, res) => {
    requireFields(req.body, ['name', 'email', 'password', 'role']);
    const { name, phone, password, role } = req.body;
    const email = String(req.body.email).trim().toLowerCase();
    if (!ROLES.includes(role)) fail(400, 'Profil inconnu');
    if (String(password).length < 6) fail(400, 'Mot de passe trop court (6 caractères minimum)');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'Cet email est déjà utilisé');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (name, phone, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), phone || null, email, hashPassword(password), role);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ token: createSession(db, user.id), user: publicUser(user) });
  }));

  r.post('/login', wrap((req, res) => {
    requireFields(req.body, ['email', 'password']);
    const email = String(req.body.email).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(req.body.password, user.password_hash)) fail(401, 'Identifiants incorrects');
    res.json({ token: createSession(db, user.id), user: publicUser(user) });
  }));

  r.post('/logout', requireAuth(), (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth(), (req, res) => res.json({ user: req.user }));

  return r;
};
