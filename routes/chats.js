const express = require('express');
const { db } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// Get my chats
router.get('/', authMiddleware, (req, res) => {
  const { filter } = req.query; // all, orders, sales, support

  let chats = db.prepare(`
    SELECT c.*, cp.muted
    FROM chats c
    JOIN chat_participants cp ON cp.chat_id = c.id AND cp.user_id = ?
    ORDER BY c.created_at DESC
  `).all(req.user.id);

  if (filter === 'orders') {
    const buyerOrders = db.prepare(
      'SELECT chat_id FROM orders WHERE buyer_id = ?'
    ).all(req.user.id).map(o => o.chat_id);
    chats = chats.filter(c => buyerOrders.includes(c.id));
  } else if (filter === 'sales') {
    const sellerOrders = db.prepare(
      'SELECT chat_id FROM orders WHERE seller_id = ?'
    ).all(req.user.id).map(o => o.chat_id);
    chats = chats.filter(c => sellerOrders.includes(c.id));
  } else if (filter === 'support') {
    chats = chats.filter(c => c.type === 'support');
  }

  // Enrich with last message, other user, unread count, order info
  const result = chats.map(chat => {
    const lastMsg = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(chat.id);

    const unread = db.prepare(`
      SELECT COUNT(*) as cnt FROM messages
      WHERE chat_id = ? AND from_id != ? AND from_id != 0 AND read = 0
    `).get(chat.id, req.user.id);

    const participants = db.prepare(`
      SELECT u.id, u.name, u.avatar FROM chat_participants cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.chat_id = ?
    `).all(chat.id);

    const other = participants.find(p => p.id !== req.user.id);
    const order = chat.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(chat.order_id) : null;

    return {
      ...chat,
      last_message: lastMsg,
      unread: unread.cnt,
      other_user: other,
      participants,
      order
    };
  });

  // Sort by last message time
  result.sort((a, b) => {
    const ta = a.last_message ? new Date(a.last_message.created_at).getTime() : 0;
    const tb = b.last_message ? new Date(b.last_message.created_at).getTime() : 0;
    return tb - ta;
  });

  res.json(result);
});

// Get chat messages
router.get('/:id/messages', authMiddleware, (req, res) => {
  // Verify participant
  const participant = db.prepare(
    'SELECT * FROM chat_participants WHERE chat_id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);

  // Allow support/admin to view support chats
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  const isStaff = ['admin', 'support'].includes(req.user.role) && chat?.type === 'support';

  if (!participant && !isStaff) {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  // Mark as read
  db.prepare(`
    UPDATE messages SET read = 1
    WHERE chat_id = ? AND from_id != ? AND read = 0
  `).run(req.params.id, req.user.id);

  const messages = db.prepare(`
    SELECT m.*, u.name as sender_name, u.avatar as sender_avatar
    FROM messages m
    LEFT JOIN users u ON u.id = m.from_id
    WHERE m.chat_id = ?
    ORDER BY m.created_at ASC
  `).all(req.params.id);

  const order = chat?.order_id
    ? db.prepare('SELECT * FROM orders WHERE id = ?').get(chat.order_id)
    : null;

  res.json({ messages, chat, order });
});

// Send message
router.post('/:id/messages', authMiddleware, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Пустое сообщение' });

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });

  // Determine sender ID (support staff sends as system=0, from_id=user.id)
  const isStaff = ['admin', 'support'].includes(req.user.role) && chat.type === 'support';
  const fromId = isStaff ? 0 : req.user.id;
  const isSystem = isStaff ? 0 : 0; // Staff messages are not system, but from_id=0

  // Join chat if staff and not participant
  if (isStaff) {
    const exists = db.prepare(
      'SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?'
    ).get(chat.id, req.user.id);
    if (!exists) {
      db.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)')
        .run(chat.id, req.user.id);
    }
  }

  const result = db.prepare(`
    INSERT INTO messages (chat_id, from_id, text, is_system) VALUES (?, ?, ?, ?)
  `).run(chat.id, fromId, text.trim(), isSystem);

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);

  // Emit via socket
  const io = req.app.get('io');
  if (io) {
    io.to(`chat_${chat.id}`).emit('new_message', {
      ...message,
      sender_name: isStaff ? 'Поддержка' : req.user.name
    });
  }

  res.json(message);
});

// Toggle mute
router.put('/:id/mute', authMiddleware, (req, res) => {
  const { muted } = req.body;
  db.prepare(`
    UPDATE chat_participants SET muted = ? WHERE chat_id = ? AND user_id = ?
  `).run(muted ? 1 : 0, req.params.id, req.user.id);
  res.json({ muted: !!muted });
});

// Support chats list (support/admin)
router.get('/support/list', authMiddleware, requireRole('admin', 'support'), (req, res) => {
  const chats = db.prepare(`
    SELECT c.*, u.name as user_name, u.avatar as user_avatar
    FROM chats c
    JOIN users u ON u.id = c.user_id
    WHERE c.type = 'support'
    ORDER BY c.created_at DESC
  `).all();

  const result = chats.map(chat => {
    const lastMsg = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(chat.id);
    return { ...chat, last_message: lastMsg };
  });

  res.json(result);
});

// Join support chat (support/admin)
router.post('/support/:chatId/join', authMiddleware, requireRole('admin', 'support'), (req, res) => {
  const chatId = parseInt(req.params.chatId);
  const exists = db.prepare(
    'SELECT 1 FROM chat_participants WHERE chat_id = ? AND user_id = ?'
  ).get(chatId, req.user.id);

  if (!exists) {
    db.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)')
      .run(chatId, req.user.id);
  }

  res.json({ success: true });
});

module.exports = router;