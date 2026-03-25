const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sanitizeUser } = require('./auth');

const router = express.Router();

// Get all users (admin)
router.get('/', authMiddleware, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json(users.map(sanitizeUser));
});

// Update user (admin)
router.put('/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const { name, email, role } = req.body;
  const userId = parseInt(req.params.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Не найден' });

  const updates = [];
  const values = [];

  if (name) { updates.push('name = ?'); values.push(name); }
  if (email) { updates.push('email = ?'); values.push(email.toLowerCase()); }
  if (role && ['user', 'support', 'admin'].includes(role)) {
    updates.push('role = ?'); values.push(role);
  }

  if (updates.length) {
    values.push(userId);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  res.json(sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)));
});

// Set role (admin)
router.put('/:id/role', authMiddleware, requireRole('admin'), (req, res) => {
  const { role } = req.body;
  const userId = parseInt(req.params.id);

  if (!['user', 'support', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Невалидная роль' });
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  res.json({ success: true });
});

// Top up balance
router.post('/topup', authMiddleware, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 10) {
    return res.status(400).json({ error: 'Минимум 10₽' });
  }

  let bonus = 0;
  if (amount >= 10000) bonus = 2500;
  else if (amount >= 5000) bonus = 1000;
  else if (amount >= 2000) bonus = 300;
  else if (amount >= 1000) bonus = 100;
  else if (amount >= 500) bonus = 25;

  const total = amount + bonus;

  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
    .run(total, req.user.id);

  db.prepare(`
    INSERT INTO transactions (user_id, amount, description)
    VALUES (?, ?, ?)
  `).run(req.user.id, total, 'Пополнение' + (bonus > 0 ? ` (+${bonus} бонус)` : ''));

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ balance: user.balance, bonus });
});

// Get user stats
router.get('/stats', authMiddleware, (req, res) => {
  const listings = db.prepare(
    'SELECT COUNT(*) as cnt FROM listings WHERE seller_id = ? AND sold = 0'
  ).get(req.user.id);

  const sold = db.prepare(
    'SELECT COUNT(*) as cnt FROM listings WHERE seller_id = ? AND sold = 1'
  ).get(req.user.id);

  const frozen = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM frozen_entries WHERE user_id = ? AND released = 0
  `).get(req.user.id);

  res.json({
    listings: listings.cnt,
    sold: sold.cnt,
    frozen_balance: frozen.total
  });
});

module.exports = router;