const express = require('express');
const { requireAuth } = require('../auth');
const { tx } = require('../db');
const { fail, toNum, toInt, requireFields, checkDate, checkTime, wrap, fileUrl } = require('../util');

const USER_COLS = 'u.id, u.name, u.email, u.phone, u.role';

module.exports = (db, upload) => {
  const r = express.Router();

  const isLinked = (nutritionistId, patientId) =>
    !!db.prepare('SELECT 1 FROM nutrition_patients WHERE nutritionist_id = ? AND patient_id = ?').get(nutritionistId, patientId);

  const link = (nutritionistId, patientId) =>
    db.prepare('INSERT OR IGNORE INTO nutrition_patients (nutritionist_id, patient_id) VALUES (?, ?)').run(nutritionistId, patientId);

  // Le nutritionniste doit suivre le patient ; le patient ne peut agir que sur lui-même
  const resolvePatient = (req, patientId) => {
    if (req.user.role === 'nutritionist') {
      const id = toInt(patientId);
      if (!id || !isLinked(req.user.id, id)) fail(403, "Ce patient n'est pas dans votre suivi");
      return id;
    }
    return req.user.id;
  };

  // ---------- Annuaire ----------

  r.get('/nutritionists', (_req, res) => {
    res.json(db.prepare(`SELECT ${USER_COLS} FROM users u WHERE role = 'nutritionist' ORDER BY name`).all());
  });

  r.get('/services', requireAuth('nutritionist'), (_req, res) => {
    res.json(db.prepare(`SELECT ${USER_COLS} FROM users u WHERE role = 'service' ORDER BY name`).all());
  });

  // ---------- Suivi des patients ----------

  r.get('/nutrition/patients', requireAuth('nutritionist'), (req, res) => {
    res.json(db.prepare(`SELECT ${USER_COLS}, np.notes, np.created_at AS since FROM nutrition_patients np
      JOIN users u ON u.id = np.patient_id WHERE np.nutritionist_id = ? ORDER BY u.name`).all(req.user.id));
  });

  r.post('/nutrition/patients', requireAuth('nutritionist'), wrap((req, res) => {
    requireFields(req.body, ['email']);
    const p = db.prepare("SELECT * FROM users WHERE email = ? AND role = 'client'")
      .get(String(req.body.email).trim().toLowerCase());
    if (!p) fail(404, "Aucun patient avec cet email (il doit d'abord créer un compte client)");
    link(req.user.id, p.id);
    db.prepare('UPDATE nutrition_patients SET notes = ? WHERE nutritionist_id = ? AND patient_id = ?')
      .run(req.body.notes || null, req.user.id, p.id);
    res.status(201).json({ id: p.id, name: p.name, email: p.email, phone: p.phone });
  }));

  r.put('/nutrition/patients/:id', requireAuth('nutritionist'), wrap((req, res) => {
    const id = resolvePatient(req, req.params.id);
    db.prepare('UPDATE nutrition_patients SET notes = ? WHERE nutritionist_id = ? AND patient_id = ?')
      .run(req.body.notes || null, req.user.id, id);
    res.json({ ok: true });
  }));

  r.delete('/nutrition/patients/:id', requireAuth('nutritionist'), (req, res) => {
    db.prepare('DELETE FROM nutrition_patients WHERE nutritionist_id = ? AND patient_id = ?').run(req.user.id, req.params.id);
    res.json({ ok: true });
  });

  r.get('/nutrition/my-nutritionists', requireAuth(), (req, res) => {
    res.json(db.prepare(`SELECT ${USER_COLS} FROM nutrition_patients np JOIN users u ON u.id = np.nutritionist_id
      WHERE np.patient_id = ? ORDER BY u.name`).all(req.user.id));
  });

  // ---------- Plans alimentaires personnalisés ----------

  const planItems = db.prepare('SELECT * FROM meal_plan_items WHERE plan_id = ? ORDER BY day_of_week, time, id');
  const withPlanItems = (plans) => plans.map((p) => ({ ...p, items: planItems.all(p.id) }));

  r.get('/nutrition/plans', requireAuth('nutritionist', 'client'), wrap((req, res) => {
    const rows = req.user.role === 'nutritionist'
      ? db.prepare(`SELECT p.*, u.name AS patient_name FROM meal_plans p JOIN users u ON u.id = p.patient_id
          WHERE p.nutritionist_id = ? AND p.patient_id = ? ORDER BY p.created_at DESC, p.id DESC`)
        .all(req.user.id, resolvePatient(req, req.query.patient_id))
      : db.prepare(`SELECT p.*, u.name AS nutritionist_name FROM meal_plans p JOIN users u ON u.id = p.nutritionist_id
          WHERE p.patient_id = ? ORDER BY p.created_at DESC, p.id DESC`).all(req.user.id);
    res.json(withPlanItems(rows));
  }));

  r.post('/nutrition/plans', requireAuth('nutritionist'), wrap((req, res) => {
    const b = req.body;
    requireFields(b, ['patient_id', 'title']);
    const patientId = resolvePatient(req, b.patient_id);
    const items = Array.isArray(b.items) ? b.items : [];
    for (const it of items) {
      if (!it.meal || !it.description) fail(400, 'Chaque repas doit avoir un nom et une description');
      if (it.time) checkTime(it.time);
    }
    const plan = tx(db, () => {
      const { lastInsertRowid: planId } = db.prepare(`INSERT INTO meal_plans
        (nutritionist_id, patient_id, title, notes, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)`).run(
        req.user.id, patientId, b.title, b.notes || null,
        b.start_date ? checkDate(b.start_date) : null, b.end_date ? checkDate(b.end_date) : null,
      );
      const ins = db.prepare('INSERT INTO meal_plan_items (plan_id, day_of_week, meal, time, description) VALUES (?, ?, ?, ?, ?)');
      const rem = db.prepare('INSERT INTO reminders (patient_id, created_by, label, time, days) VALUES (?, ?, ?, ?, ?)');
      for (const it of items) {
        const dow = toInt(it.day_of_week);
        const day = dow !== null && dow >= 0 && dow <= 6 ? dow : null;
        ins.run(planId, day, it.meal, it.time || null, it.description);
        // Crée automatiquement les rappels de prise de repas
        if (b.create_reminders && it.time) {
          rem.run(patientId, req.user.id, `${it.meal} : ${it.description}`, it.time, day === null ? '0123456' : String(day));
        }
      }
      return db.prepare('SELECT * FROM meal_plans WHERE id = ?').get(planId);
    });
    res.status(201).json(withPlanItems([plan])[0]);
  }));

  r.delete('/nutrition/plans/:id', requireAuth('nutritionist'), (req, res) => {
    db.prepare('DELETE FROM meal_plans WHERE id = ? AND nutritionist_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // ---------- Rappels de repas (configurables par le patient ou le nutritionniste) ----------

  const normDays = (d) => {
    const s = [...new Set(String(d ?? '0123456').split(''))].filter((c) => /[0-6]/.test(c)).sort().join('');
    return s || fail(400, 'Choisissez au moins un jour');
  };

  const ownReminder = (req) => {
    const rem = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id);
    if (!rem) fail(404, 'Rappel introuvable');
    if (rem.patient_id !== req.user.id && !(req.user.role === 'nutritionist' && isLinked(req.user.id, rem.patient_id))) {
      fail(403, 'Accès refusé');
    }
    return rem;
  };

  r.get('/reminders', requireAuth('nutritionist', 'client'), wrap((req, res) => {
    const id = resolvePatient(req, req.query.patient_id);
    res.json(db.prepare(`SELECT r.*, u.name AS created_by_name FROM reminders r JOIN users u ON u.id = r.created_by
      WHERE r.patient_id = ? ORDER BY r.time`).all(id));
  }));

  r.post('/reminders', requireAuth('nutritionist', 'client'), wrap((req, res) => {
    requireFields(req.body, ['label', 'time']);
    const id = resolvePatient(req, req.body.patient_id);
    const { lastInsertRowid } = db.prepare('INSERT INTO reminders (patient_id, created_by, label, time, days) VALUES (?, ?, ?, ?, ?)')
      .run(id, req.user.id, req.body.label, checkTime(req.body.time), normDays(req.body.days));
    res.status(201).json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(lastInsertRowid));
  }));

  r.patch('/reminders/:id', requireAuth('nutritionist', 'client'), wrap((req, res) => {
    const rem = ownReminder(req);
    const b = req.body;
    db.prepare('UPDATE reminders SET label = ?, time = ?, days = ?, active = ? WHERE id = ?').run(
      b.label ?? rem.label,
      b.time !== undefined ? checkTime(b.time) : rem.time,
      b.days !== undefined ? normDays(b.days) : rem.days,
      b.active !== undefined ? (b.active ? 1 : 0) : rem.active,
      rem.id,
    );
    res.json(db.prepare('SELECT * FROM reminders WHERE id = ?').get(rem.id));
  }));

  r.delete('/reminders/:id', requireAuth('nutritionist', 'client'), wrap((req, res) => {
    const rem = ownReminder(req);
    db.prepare('DELETE FROM reminders WHERE id = ?').run(rem.id);
    res.json({ ok: true });
  }));

  // ---------- Consultations à distance ----------

  r.get('/consultations', requireAuth('nutritionist', 'client'), (req, res) => {
    const col = req.user.role === 'nutritionist' ? 'nutritionist_id' : 'patient_id';
    res.json(db.prepare(`SELECT c.*, n.name AS nutritionist_name, p.name AS patient_name, p.phone AS patient_phone
      FROM consultations c JOIN users n ON n.id = c.nutritionist_id JOIN users p ON p.id = c.patient_id
      WHERE c.${col} = ? ORDER BY c.scheduled_at DESC`).all(req.user.id));
  });

  r.post('/consultations', requireAuth('nutritionist', 'client'), wrap((req, res) => {
    const b = req.body;
    requireFields(b, ['scheduled_at']);
    const modes = ['video', 'phone', 'chat', 'in_person'];
    const mode = modes.includes(b.mode) ? b.mode : 'video';
    let nutritionistId;
    let patientId;
    let status;
    if (req.user.role === 'nutritionist') {
      nutritionistId = req.user.id;
      patientId = resolvePatient(req, b.patient_id);
      status = 'scheduled';
    } else {
      const n = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'nutritionist'").get(b.nutritionist_id);
      if (!n) fail(404, 'Nutritionniste introuvable');
      nutritionistId = n.id;
      patientId = req.user.id;
      status = 'requested';
      link(nutritionistId, patientId); // une demande de consultation ajoute le patient au suivi
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO consultations
      (nutritionist_id, patient_id, scheduled_at, mode, link, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(nutritionistId, patientId, b.scheduled_at, mode, b.link || null, b.reason || null, status);
    res.status(201).json(db.prepare('SELECT * FROM consultations WHERE id = ?').get(lastInsertRowid));
  }));

  r.patch('/consultations/:id', requireAuth('nutritionist', 'client'), wrap((req, res) => {
    const c = db.prepare('SELECT * FROM consultations WHERE id = ?').get(req.params.id);
    if (!c || (c.nutritionist_id !== req.user.id && c.patient_id !== req.user.id)) fail(404, 'Consultation introuvable');
    const b = req.body;
    if (req.user.role === 'client') {
      if (b.status !== 'cancelled') fail(400, 'Le patient peut seulement annuler');
      db.prepare("UPDATE consultations SET status = 'cancelled' WHERE id = ?").run(c.id);
    } else {
      const statuses = ['requested', 'scheduled', 'done', 'cancelled'];
      if (b.status !== undefined && !statuses.includes(b.status)) fail(400, 'Statut invalide');
      db.prepare('UPDATE consultations SET scheduled_at = ?, link = ?, report = ?, status = ? WHERE id = ?').run(
        b.scheduled_at ?? c.scheduled_at, b.link ?? c.link, b.report ?? c.report, b.status ?? c.status, c.id,
      );
    }
    res.json(db.prepare('SELECT * FROM consultations WHERE id = ?').get(c.id));
  }));

  // ---------- Messagerie patient / nutritionniste ----------

  const canTalk = (a, b) => isLinked(a, b) || isLinked(b, a);

  r.get('/messages/:userId', requireAuth(), wrap((req, res) => {
    const other = toInt(req.params.userId);
    if (!canTalk(req.user.id, other)) fail(403, 'Conversation non autorisée');
    res.json(db.prepare(`SELECT * FROM messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      ORDER BY created_at, id`).all(req.user.id, other, other, req.user.id));
  }));

  r.post('/messages/:userId', requireAuth(), wrap((req, res) => {
    const other = toInt(req.params.userId);
    requireFields(req.body, ['body']);
    if (!canTalk(req.user.id, other)) fail(403, 'Conversation non autorisée');
    const { lastInsertRowid } = db.prepare('INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)')
      .run(req.user.id, other, req.body.body);
    res.status(201).json(db.prepare('SELECT * FROM messages WHERE id = ?').get(lastInsertRowid));
  }));

  // ---------- Menus du nutritionniste (sur réservation) ----------

  const NUTRI_MENU_SQL = `SELECT m.*, n.name AS nutritionist_name, s.name AS service_name, s.phone AS service_phone,
      CASE WHEN m.capacity IS NULL THEN NULL ELSE m.capacity - COALESCE((SELECT SUM(quantity) FROM reservations r
        WHERE r.nutri_menu_id = m.id AND r.status != 'cancelled'), 0) END AS remaining
    FROM nutri_menus m JOIN users n ON n.id = m.nutritionist_id LEFT JOIN users s ON s.id = m.service_id`;

  r.get('/nutri-menus', wrap((req, res) => {
    const where = [];
    const params = [];
    if (req.query.date) { where.push('m.date = ?'); params.push(checkDate(req.query.date)); }
    if (req.query.from) { where.push('m.date >= ?'); params.push(checkDate(req.query.from)); }
    if (req.query.mine && req.user?.role === 'nutritionist') { where.push('m.nutritionist_id = ?'); params.push(req.user.id); }
    const sql = `${NUTRI_MENU_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.date, m.title`;
    res.json(db.prepare(sql).all(...params));
  }));

  r.post('/nutri-menus', requireAuth('nutritionist'), upload.single('image'), wrap((req, res) => {
    const b = req.body;
    requireFields(b, ['title', 'date']);
    const serviceId = toInt(b.service_id);
    if (serviceId && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'service'").get(serviceId)) {
      fail(400, 'Service spécialisé inconnu');
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO nutri_menus
      (nutritionist_id, service_id, title, description, target, calories, price, date, capacity, image)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      req.user.id, serviceId || null, b.title, b.description || null, b.target || null,
      toInt(b.calories), toInt(b.price) ?? 0, checkDate(b.date), toInt(b.capacity), fileUrl(req.file),
    );
    res.status(201).json(db.prepare(`${NUTRI_MENU_SQL} WHERE m.id = ?`).get(lastInsertRowid));
  }));

  r.delete('/nutri-menus/:id', requireAuth('nutritionist'), (req, res) => {
    db.prepare('DELETE FROM nutri_menus WHERE id = ? AND nutritionist_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  r.post('/nutri-menus/:id/reservations', requireAuth(), wrap((req, res) => {
    const b = req.body;
    const qty = toInt(b.quantity) ?? 1;
    if (qty < 1) fail(400, 'Quantité invalide');
    const mode = b.mode === 'delivery' ? 'delivery' : 'pickup';
    const lat = toNum(b.lat);
    const lng = toNum(b.lng);
    if (mode === 'delivery' && (lat === null || lng === null) && !b.address) {
      fail(400, 'Localisation ou adresse requise pour la livraison');
    }
    const resa = tx(db, () => {
      const m = db.prepare(`${NUTRI_MENU_SQL} WHERE m.id = ?`).get(req.params.id);
      if (!m) fail(404, 'Menu introuvable');
      if (m.remaining !== null && qty > m.remaining) fail(409, `Plus assez de places (reste ${Math.max(m.remaining, 0)})`);
      const { lastInsertRowid } = db.prepare(`INSERT INTO reservations
        (nutri_menu_id, client_id, quantity, mode, lat, lng, address, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(m.id, req.user.id, qty, mode, lat, lng, b.address || null, b.note || null);
      return db.prepare('SELECT * FROM reservations WHERE id = ?').get(lastInsertRowid);
    });
    res.status(201).json(resa);
  }));

  const RESA_SQL = `SELECT r.*, m.title, m.date, m.price, m.nutritionist_id, m.service_id,
      u.name AS client_name, u.phone AS client_phone
    FROM reservations r JOIN nutri_menus m ON m.id = r.nutri_menu_id JOIN users u ON u.id = r.client_id`;

  r.get('/reservations/mine', requireAuth(), (req, res) => {
    res.json(db.prepare(`${RESA_SQL} WHERE r.client_id = ? ORDER BY m.date DESC, r.id DESC`).all(req.user.id));
  });

  // Réservations à préparer (service spécialisé) ou à suivre (nutritionniste)
  r.get('/reservations/received', requireAuth('nutritionist', 'service'), (req, res) => {
    const col = req.user.role === 'service' ? 'm.service_id' : 'm.nutritionist_id';
    res.json(db.prepare(`${RESA_SQL} WHERE ${col} = ? ORDER BY m.date, r.id`).all(req.user.id));
  });

  r.patch('/reservations/:id/status', requireAuth(), wrap((req, res) => {
    const resa = db.prepare(`${RESA_SQL} WHERE r.id = ?`).get(req.params.id);
    if (!resa) fail(404, 'Réservation introuvable');
    const { status } = req.body;
    const staff = resa.nutritionist_id === req.user.id || resa.service_id === req.user.id;
    if (staff) {
      if (!['confirmed', 'ready', 'done', 'cancelled'].includes(status)) fail(400, 'Statut invalide');
    } else if (resa.client_id === req.user.id) {
      if (status !== 'cancelled' || resa.status !== 'pending') fail(400, 'Vous pouvez annuler seulement une réservation en attente');
    } else {
      fail(403, 'Accès refusé');
    }
    db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, resa.id);
    res.json(db.prepare(`${RESA_SQL} WHERE r.id = ?`).get(resa.id));
  }));

  return r;
};
