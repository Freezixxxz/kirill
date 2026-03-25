const express = require('express');
const { db } = require('../db');
const { authMiddleware, optionalAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Premium pricing
function getPremiumPrice(price) {
  if (price <= 500) return { premium: 19, boost: 10 };
  if (price <= 1000) return { premium: 34, boost: 17 };
  if (price <= 2500) return { premium: 49, boost: 25 };
  if (price <= 5000) return { premium: 79, boost: 40 };
  return { premium: 129, boost: 65 };
}

function getFinalPrice(listing) {
  return Math.round(listing.price * (1 - (listing.discount || 0) / 100));
}

// Get listings (public)
router.get('/', optionalAuth, (req, res) => {
  const { game, access, server, price_from, price_to, sort } = req.query;

  let where = "status = 'approved' AND sold = 0";
  const params = [];

  if (game && game !== 'all') {
    where += ' AND game = ?';
    params.push(game);
  }
  if (access && access !== 'all') {
    where += ' AND access_type = ?';
    params.push(access);
  }
  if (server && server !== 'all') {
    where += ' AND server = ?';
    params.push(server);
  }

  let orderBy = 'created_at DESC';
  if (sort === 'asc') orderBy = 'price ASC';
  else if (sort === 'desc') orderBy = 'price DESC';

  // Premium always first
  orderBy = `CASE WHEN promo = 'premium' THEN 0 ELSE 1 END, ${orderBy}`;

  const listings = db.prepare(`
    SELECT l.*, u.name as seller_name, u.avatar as seller_avatar
    FROM listings l
    JOIN users u ON u.id = l.seller_id
    WHERE ${where}
    ORDER BY ${orderBy}
  `).all(...params);

  // Add images
  const stmtImages = db.prepare(
    'SELECT filename FROM listing_images WHERE listing_id = ? ORDER BY sort_order'
  );

  const result = listings.map(l => {
    const images = stmtImages.all(l.id).map(i => `/uploads/${i.filename}`);
    const fp = getFinalPrice(l);

    // Price filter
    if (price_from && fp < parseInt(price_from)) return null;
    if (price_to && fp > parseInt(price_to)) return null;

    return { ...l, images, final_price: fp };
  }).filter(Boolean);

  res.json(result);
});

// Get single listing
router.get('/:id', optionalAuth, (req, res) => {
  const listing = db.prepare(`
    SELECT l.*, u.name as seller_name, u.avatar as seller_avatar
    FROM listings l
    JOIN users u ON u.id = l.seller_id
    WHERE l.id = ?
  `).get(req.params.id);

  if (!listing) return res.status(404).json({ error: 'Не найдено' });

  const images = db.prepare(
    'SELECT filename FROM listing_images WHERE listing_id = ? ORDER BY sort_order'
  ).all(listing.id).map(i => `/uploads/${i.filename}`);

  // Increment views
  db.prepare('UPDATE listings SET views = views + 1 WHERE id = ?').run(listing.id);

  res.json({ ...listing, images, final_price: getFinalPrice(listing) });
});

// Create listing
router.post('/', authMiddleware, (req, res) => {
  const { game, server, access_type, title, battles, winrate, tier10,
          premiums, description, price, promo } = req.body;

  if (!title || !price || price < 1) {
    return res.status(400).json({ error: 'Название и цена обязательны' });
  }

  let fee = 0;
  if (promo === 'premium') {
    fee = getPremiumPrice(price).premium;
    if (req.user.balance < fee) {
      return res.status(400).json({ error: 'Недостаточно средств' });
    }
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?')
      .run(fee, req.user.id);
    db.prepare(`
      INSERT INTO transactions (user_id, amount, description)
      VALUES (?, ?, ?)
    `).run(req.user.id, -fee, 'Премиум: ' + title);
  }

  const result = db.prepare(`
    INSERT INTO listings (seller_id, game, server, access_type, title,
      battles, winrate, tier10, premiums, description, price, promo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, game || 'wot', server || 'RU', access_type || 'full',
    title, battles || 0, winrate || 0, tier10 || 0, premiums || 0,
    description || '', price, promo || 'free'
  );

  res.json({ id: result.lastInsertRowid, fee });
});

// Upload listing images
router.post('/:id/images', authMiddleware, (req, res) => {
  const listing = db.prepare(
    'SELECT * FROM listings WHERE id = ? AND seller_id = ?'
  ).get(req.params.id, req.user.id);

  if (!listing) return res.status(404).json({ error: 'Не найдено' });

  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'Нет файлов' });
  }

  const stmt = db.prepare(`
    INSERT INTO listing_images (listing_id, filename, sort_order) VALUES (?, ?, ?)
  `);

  req.files.forEach((file, i) => {
    stmt.run(listing.id, file.filename, i);
  });

  res.json({ count: req.files.length });
});

// Update discount (from profile)
router.put('/:id/discount', authMiddleware, (req, res) => {
  const { discount } = req.body;
  const listing = db.prepare(
    "SELECT * FROM listings WHERE id = ? AND seller_id = ? AND status = 'approved' AND sold = 0"
  ).get(req.params.id, req.user.id);

  if (!listing) return res.status(404).json({ error: 'Не найдено' });

  const d = Math.max(0, Math.min(90, parseInt(discount) || 0));
  db.prepare('UPDATE listings SET discount = ? WHERE id = ?').run(d, listing.id);
  res.json({ discount: d });
});

// Boost / upgrade to premium
router.post('/:id/boost', authMiddleware, (req, res) => {
  const { type } = req.body; // 'upgrade' or 'reboost'

  const listing = db.prepare(
    "SELECT * FROM listings WHERE id = ? AND seller_id = ? AND status = 'approved' AND sold = 0"
  ).get(req.params.id, req.user.id);

  if (!listing) return res.status(404).json({ error: 'Не найдено' });

  const pp = getPremiumPrice(listing.price);
  const cost = type === 'upgrade' ? pp.premium : pp.boost;

  if (req.user.balance < cost) {
    return res.status(400).json({ error: 'Недостаточно средств' });
  }

  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?')
    .run(cost, req.user.id);

  if (type === 'upgrade') {
    db.prepare("UPDATE listings SET promo = 'premium', created_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(listing.id);
  } else {
    db.prepare('UPDATE listings SET created_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(listing.id);
  }

  db.prepare(`
    INSERT INTO transactions (user_id, amount, description) VALUES (?, ?, ?)
  `).run(req.user.id, -cost, (type === 'upgrade' ? 'Премиум' : 'Поднятие') + ': ' + listing.title);

  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  res.json({ success: true, balance: user.balance });
});

// Get my listings
router.get('/my/active', authMiddleware, (req, res) => {
  const listings = db.prepare(`
    SELECT * FROM listings WHERE seller_id = ? AND sold = 0 ORDER BY created_at DESC
  `).all(req.user.id);
  res.json(listings.map(l => ({ ...l, final_price: getFinalPrice(l) })));
});

router.get('/my/sold', authMiddleware, (req, res) => {
  const listings = db.prepare(`
    SELECT l.*, o.id as order_id, o.status as order_status, o.chat_id
    FROM listings l
    LEFT JOIN orders o ON o.listing_id = l.id
    WHERE l.seller_id = ? AND l.sold = 1
    ORDER BY l.created_at DESC
  `).all(req.user.id);
  res.json(listings);
});

// Moderate (support/admin)
router.put('/:id/moderate', authMiddleware, requireRole('admin', 'support'), (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Невалидный статус' });
  }
  db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// Get pending (support/admin)
router.get('/admin/pending', authMiddleware, requireRole('admin', 'support'), (req, res) => {
  const listings = db.prepare(`
    SELECT l.*, u.name as seller_name
    FROM listings l JOIN users u ON u.id = l.seller_id
    WHERE l.status = 'pending'
    ORDER BY l.created_at DESC
  `).all();
  res.json(listings);
});

// Get all (admin)
router.get('/admin/all', authMiddleware, requireRole('admin'), (req, res) => {
  const listings = db.prepare(`
    SELECT l.*, u.name as seller_name
    FROM listings l JOIN users u ON u.id = l.seller_id
    ORDER BY l.created_at DESC
  `).all();
  res.json(listings.map(l => ({ ...l, final_price: getFinalPrice(l) })));
});

module.exports = router;
module.exports.getFinalPrice = getFinalPrice;