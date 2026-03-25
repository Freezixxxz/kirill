const express = require('express');
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { getFinalPrice } = require('./listings');

const router = express.Router();

const COMMISSION = parseFloat(process.env.COMMISSION) || 0.10;
const AUTO_CONFIRM_DAYS = parseInt(process.env.AUTO_CONFIRM_DAYS) || 7;
const FROZEN_DAYS = parseInt(process.env.FROZEN_DAYS) || 2;

// Buy listing (direct purchase, no cart)
router.post('/buy/:listingId', authMiddleware, (req, res) => {
  const listing = db.prepare(
    "SELECT * FROM listings WHERE id = ? AND status = 'approved' AND sold = 0"
  ).get(req.params.listingId);

  if (!listing) return res.status(404).json({ error: 'Не найдено или продано' });
  if (listing.seller_id === req.user.id) {
    return res.status(400).json({ error: 'Нельзя купить свой аккаунт' });
  }

  const fp = getFinalPrice(listing);
  if (req.user.balance < fp) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  const commission = Math.round(fp * COMMISSION);
  const sellerAmount = fp - commission;

  // Deduct buyer balance
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?')
    .run(fp, req.user.id);

  // Mark as sold
  db.prepare('UPDATE listings SET sold = 1 WHERE id = ?').run(listing.id);

  // Create order
  const orderResult = db.prepare(`
    INSERT INTO orders (listing_id, buyer_id, seller_id, amount, commission, seller_amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(listing.id, req.user.id, listing.seller_id, fp, commission, sellerAmount);
  const orderId = orderResult.lastInsertRowid;

  // Create chat
  const chatResult = db.prepare(`
    INSERT INTO chats (type, order_id) VALUES ('order', ?)
  `).run(orderId);
  const chatId = chatResult.lastInsertRowid;

  // Add participants
  db.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)')
    .run(chatId, req.user.id);
  db.prepare('INSERT INTO chat_participants (chat_id, user_id) VALUES (?, ?)')
    .run(chatId, listing.seller_id);

  // Link chat to order
  db.prepare('UPDATE orders SET chat_id = ? WHERE id = ?').run(chatId, orderId);

  // System message
  db.prepare(`
    INSERT INTO messages (chat_id, from_id, text, is_system)
    VALUES (?, 0, ?, 1)
  `).run(chatId, `📦 Заказ #${orderId} оплачен!\n💰 ${fp.toLocaleString()}₽\n\nПродавец, отправьте данные аккаунта.\nПокупатель, после проверки нажмите «Подтвердить» (авто через ${AUTO_CONFIRM_DAYS} дн.)`);

  // Transaction
  db.prepare(`
    INSERT INTO transactions (user_id, amount, description) VALUES (?, ?, ?)
  `).run(req.user.id, -fp, 'Покупка: ' + listing.title);

  // Emit via socket
  const io = req.app.get('io');
  if (io) {
    io.to(`user_${listing.seller_id}`).emit('new_order', { orderId, chatId });
    io.to(`user_${req.user.id}`).emit('order_created', { orderId, chatId });
  }

  res.json({ orderId, chatId });
});

// Confirm order (buyer)
router.post('/:id/confirm', authMiddleware, (req, res) => {
  const order = db.prepare(
    "SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND status = 'active'"
  ).get(req.params.id, req.user.id);

  if (!order) return res.status(404).json({ error: 'Заказ не найден' });

  processConfirmation(order, false, req.app.get('io'));
  res.json({ success: true });
});

// Get my purchases
router.get('/my/purchases', authMiddleware, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, l.title, l.game, l.server
    FROM orders o
    JOIN listings l ON l.id = o.listing_id
    WHERE o.buyer_id = ?
    ORDER BY o.created_at DESC
  `).all(req.user.id);
  res.json(orders);
});

// Get my sales
router.get('/my/sales', authMiddleware, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, l.title, l.game
    FROM orders o
    JOIN listings l ON l.id = o.listing_id
    WHERE o.seller_id = ?
    ORDER BY o.created_at DESC
  `).all(req.user.id);
  res.json(orders);
});

function processConfirmation(order, auto, io) {
  const frozenDays = parseInt(process.env.FROZEN_DAYS) || 2;
  const releaseAt = new Date(Date.now() + frozenDays * 86400000).toISOString();

  db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(order.id);

  // Add frozen entry for seller
  db.prepare(`
    INSERT INTO frozen_entries (user_id, order_id, amount, release_at)
    VALUES (?, ?, ?, ?)
  `).run(order.seller_id, order.id, order.seller_amount, releaseAt);

  // Update seller frozen balance
  const frozen = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM frozen_entries WHERE user_id = ? AND released = 0
  `).get(order.seller_id);

  db.prepare('UPDATE users SET frozen_balance = ? WHERE id = ?')
    .run(frozen.total, order.seller_id);

  // Transaction log
  db.prepare(`
    INSERT INTO transactions (user_id, amount, description) VALUES (?, 0, ?)
  `).run(order.seller_id, `Заморожено ${order.seller_amount}₽ (заказ #${order.id})`);

  // Chat message
  if (order.chat_id) {
    const msg = auto
      ? '⏰ Автоподтверждение (7 дней)'
      : `✅ Покупатель подтвердил. Средства заморожены на ${frozenDays} дн.`;
    db.prepare(`
      INSERT INTO messages (chat_id, from_id, text, is_system) VALUES (?, 0, ?, 1)
    `).run(order.chat_id, msg);

    if (io) {
      io.to(`chat_${order.chat_id}`).emit('new_message', {
        chatId: order.chat_id, text: msg, is_system: true
      });
    }
  }
}

module.exports = router;
module.exports.processConfirmation = processConfirmation;