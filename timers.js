const { db } = require('./db');

const AUTO_CONFIRM_DAYS = parseInt(process.env.AUTO_CONFIRM_DAYS) || 7;
const FROZEN_DAYS = parseInt(process.env.FROZEN_DAYS) || 2;

function runTimers(io) {
  // 1. Auto-confirm orders after 7 days
  const expiredOrders = db.prepare(`
    SELECT * FROM orders
    WHERE status = 'active' AND disputed = 0
    AND datetime(created_at, '+${AUTO_CONFIRM_DAYS} days') <= datetime('now')
  `).all();

  expiredOrders.forEach(order => {
    const releaseAt = new Date(Date.now() + FROZEN_DAYS * 86400000).toISOString();

    db.prepare("UPDATE orders SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(order.id);

    db.prepare(`
      INSERT INTO frozen_entries (user_id, order_id, amount, release_at)
      VALUES (?, ?, ?, ?)
    `).run(order.seller_id, order.id, order.seller_amount, releaseAt);

    db.prepare(`
      INSERT INTO transactions (user_id, amount, description) VALUES (?, 0, ?)
    `).run(order.seller_id, `Авто-заморозка ${order.seller_amount}₽ (#${order.id})`);

    if (order.chat_id) {
      db.prepare(`
        INSERT INTO messages (chat_id, from_id, text, is_system)
        VALUES (?, 0, '⏰ Автоподтверждение (7 дней). Средства заморожены.', 1)
      `).run(order.chat_id);

      if (io) io.to(`chat_${order.chat_id}`).emit('order_auto_confirmed');
    }

    console.log(`⏰ Auto-confirmed order #${order.id}`);
  });

  // 2. Release frozen funds after 2 days
  const releasable = db.prepare(`
    SELECT * FROM frozen_entries
    WHERE released = 0 AND datetime(release_at) <= datetime('now')
  `).all();

  releasable.forEach(entry => {
    db.prepare('UPDATE frozen_entries SET released = 1 WHERE id = ?').run(entry.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?')
      .run(entry.amount, entry.user_id);

    db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?")
      .run(entry.order_id);

    db.prepare(`
      INSERT INTO transactions (user_id, amount, description) VALUES (?, ?, ?)
    `).run(entry.user_id, entry.amount, `Разморозка ${entry.amount}₽ (#${entry.order_id})`);

    console.log(`❄️→💰 Released ${entry.amount}₽ for user #${entry.user_id}`);
  });

  // 3. Update frozen balances
  db.prepare(`
    UPDATE users SET frozen_balance = (
      SELECT COALESCE(SUM(amount), 0) FROM frozen_entries
      WHERE frozen_entries.user_id = users.id AND released = 0
    )
  `).run();
}

module.exports = { runTimers };