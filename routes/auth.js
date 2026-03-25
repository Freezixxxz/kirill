const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Register
router.post('/register', (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  }
  if (name.length < 2 || name.length > 30) {
    return res.status(400).json({ error: 'Никнейм 2-30 символов' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(400).json({ error: 'Email уже занят' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (name, email, password) VALUES (?, ?, ?)
  `).run(name, email.toLowerCase(), hash);

  const userId = result.lastInsertRowid;

  // Create support chat
  const chatResult = db.prepare(`
    INSERT INTO chats (type, user_id) VALUES ('support', ?)
  `).run(userId);
  const chatId = chatResult.lastInsertRowid;

  db.prepare(`
    INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)
  `).run(chatId, userId);

  db.prepare(`
    INSERT INTO messages (chat_id, from_id, text, is_system)
    VALUES (?, 0, '👋 Здравствуйте! Чем можем помочь?', 1)
  `).run(chatId);

  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });

  res.json({
    token,
    user: sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId))
  });
});

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

  res.json({ token, user: sanitizeUser(user) });
});

// Get current user
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // Calculate frozen balance
  const frozen = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM frozen_entries WHERE user_id = ? AND released = 0
  `).get(req.user.id);

  const u = sanitizeUser(user);
  u.frozen_balance = frozen.total;
  res.json(u);
});

// Update password
router.put('/password', authMiddleware, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ success: true });
});

// Update sound settings
router.put('/settings', authMiddleware, (req, res) => {
  const { sound_enabled } = req.body;
  db.prepare('UPDATE users SET sound_enabled = ? WHERE id = ?')
    .run(sound_enabled ? 1 : 0, req.user.id);
  res.json({ success: true });
});

// Upload avatar
router.post('/avatar', authMiddleware, (req, res) => {
  // Handled by multer in server.js
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const avatarUrl = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
  res.json({ avatar: avatarUrl });
});

function sanitizeUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

module.exports = router;
module.exports.sanitizeUser = sanitizeUser;