const express = require('express');
const { db } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

// Create dispute
router.post('/', authMiddleware, (req, res) => {
  const { order_id, reason } = req.body;

  if (!reason?.trim()) {
    return res.status(400).json({ error: 'Опишите проблему' });
  }

  const order = db.prepare(
    "SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND status = 'active'"
  ).get(order_id, req.user.id);

  if (!order) return res.status(404).json({ error: 'Заказ не найден' });

  db.prepare('UPDATE orders SET disputed = 1 WHERE id = ?').run(order.id);

  const result = db.prepare(`
    INSERT INTO disputes (order_id, buyer_id, seller_id, reason)
    VALUES (?, ?, ?, ?)
  `).run(order.id, order.buyer_id, order.seller_id, reason.trim());

  // Chat message
  if (order.chat_id) {
    db.prepare(`
      INSERT INTO messages (chat_id, from_id, text, is_system)
      VALUES (?, 0, '⚠️ Покупатель сообщил о проблеме. Обращение передано в поддержку.', 1)
    `).run(order.chat_id);
  }

  res.json({ id: result.lastInsertRowid });
});

// Get disputes (support/admin)
router.get('/', authMiddleware, requireRole('admin', 'support'), (req, res) => {
  const disputes = db.prepare(`
    SELECT d.*,
      b.name as buyer_name, s.name as seller_name,
      l.title as listing_title,
      o.chat_id, o.amount
    FROM disputes d
    JOIN users b ON b.id = d.buyer_id
    JOIN users s ON s.id = d.seller_id
    JOIN orders o ON o.id = d.order_id
    JOIN listings l ON l.id = o.listing_id
    ORDER BY d.created_at DESC
  `).all();
  res.json(disputes);
});

// Resolve dispute (support/admin)
router.post('/:id/resolve', authMiddleware, requireRole('admin', 'support'), (req, res) => {
  const { resolution } = req.body; // 'buyer' or 'seller'

  if (!['buyer', 'seller'].includes(resolution)) {
    return res.status(400).json({ error: 'Невалидное решение' });
  }

  const dispute = db.prepare(
    "SELECT * FROM disputes WHERE id = ? AND status = 'open'"
  ).get(req.params.id);

  if (!dispute) return res.status(404).json({ error: 'Спор не найден' });

  db.prepare(`
    UPDATE disputes SET status = 'resolved', resolution = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(resolution, dispute.id);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(dispute.order_id);

  if (resolution === 'buyer' && order) {
    // Refund buyer
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
      .run(order.amount, order.buyer_id);

    db.prepare(`
      INSERT INTO transactions (user_id, amount, description) VALUES (?, ?, ?)
    `).run(order.buyer_id, order.amount, 'Возврат заказ #' + order.id);

    db.prepare("UPDATE orders SET status = 'refunded', disputed = 0 WHERE id = ?")
      .run(order.id);

    if (order.chat_id) {
      db.prepare(`
        INSERT INTO messages (chat_id, from_id, text, is_system)
        VALUES (?, 0, '💰 Спор решён в пользу покупателя. Средства возвращены.', 1)
      `).run(order.chat_id);
    }
  } else if (resolution === 'seller' && order) {
    db.prepare('UPDATE orders SET disputed = 0 WHERE id = ?').run(order.id);

    if (order.chat_id) {
      db.prepare(`
        INSERT INTO messages (chat_id, from_id, text, is_system)
        VALUES (?, 0, '✅ Спор решён в пользу продавца.', 1)
      `).run(order.chat_id);
    }
  }

  const io = req.app.get('io');
  if (io && order?.chat_id) {
    io.to(`chat_${order.chat_id}`).emit('dispute_resolved', { resolution });
  }

  res.json({ success: true });
});

module.exports = router;