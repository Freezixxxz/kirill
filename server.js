require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const { db, initDB } = require('./db');
const { runTimers } = require('./timers');

const app = express();
const server = http.createServer(app);

// Socket.IO
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'), false);
  }
});

// Make upload available to routes
app.use((req, res, next) => {
  req.upload = upload;
  next();
});

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const listingRoutes = require('./routes/listings');
const orderRoutes = require('./routes/orders');
const chatRoutes = require('./routes/chats');
const disputeRoutes = require('./routes/disputes');
const { authMiddleware } = require('./middleware/auth');

app.use('/api/auth', authRoutes);

// Avatar upload endpoint
app.post('/api/auth/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const avatarUrl = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
  res.json({ avatar: avatarUrl });
});

app.use('/api/users', userRoutes);
app.use('/api/listings', listingRoutes);

// Listing images upload
app.post('/api/listings/:id/images', authMiddleware, upload.array('images', 6), (req, res) => {
  const listing = db.prepare(
    'SELECT * FROM listings WHERE id = ? AND seller_id = ?'
  ).get(req.params.id, req.user.id);
  if (!listing) return res.status(404).json({ error: 'Не найдено' });
  if (!req.files?.length) return res.status(400).json({ error: 'Нет файлов' });

  const stmt = db.prepare(
    'INSERT INTO listing_images (listing_id, filename, sort_order) VALUES (?, ?, ?)'
  );
  req.files.forEach((file, i) => stmt.run(listing.id, file.filename, i));
  res.json({ count: req.files.length });
});

app.use('/api/orders', orderRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/disputes', disputeRoutes);

// Transactions
app.get('/api/transactions', authMiddleware, (req, res) => {
  const txs = db.prepare(`
    SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.user.id);
  res.json(txs);
});

app.get('/api/transactions/all', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
  const txs = db.prepare(`
    SELECT t.*, u.name as user_name
    FROM transactions t JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC LIMIT 200
  `).all();
  res.json(txs);
});

// Stats
app.get('/api/stats/public', (req, res) => {
  const listings = db.prepare(
    "SELECT COUNT(*) as cnt FROM listings WHERE status = 'approved' AND sold = 0"
  ).get();
  const users = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  res.json({ listings: listings.cnt, users: users.cnt });
});

app.get('/api/stats/admin', authMiddleware, (req, res) => {
  if (!['admin', 'support'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  res.json({
    total_listings: db.prepare('SELECT COUNT(*) as c FROM listings').get().c,
    active: db.prepare("SELECT COUNT(*) as c FROM listings WHERE status='approved' AND sold=0").get().c,
    pending: db.prepare("SELECT COUNT(*) as c FROM listings WHERE status='pending'").get().c,
    sold: db.prepare('SELECT COUNT(*) as c FROM listings WHERE sold=1').get().c,
    users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    orders: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
    open_disputes: db.prepare("SELECT COUNT(*) as c FROM disputes WHERE status='open'").get().c,
    support_chats: db.prepare("SELECT COUNT(*) as c FROM chats WHERE type='support'").get().c
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message || 'Ошибка сервера' });
});

// ============ SOCKET.IO ============
const onlineUsers = new Set();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
    } catch (e) {}
  }
  next();
});

io.on('connection', (socket) => {
  if (socket.userId) {
    onlineUsers.add(socket.userId);
    socket.join(`user_${socket.userId}`);

    // Join all user's chats
    const chats = db.prepare(`
      SELECT chat_id FROM chat_participants WHERE user_id = ?
    `).all(socket.userId);
    chats.forEach(c => socket.join(`chat_${c.chat_id}`));
  }

  socket.on('join_chat', (chatId) => {
    socket.join(`chat_${chatId}`);
  });

  socket.on('typing', (chatId) => {
    socket.to(`chat_${chatId}`).emit('user_typing', {
      chatId, userId: socket.userId
    });
  });

  socket.on('disconnect', () => {
    if (socket.userId) onlineUsers.delete(socket.userId);
  });
});

// Online count endpoint
app.get('/api/online', (req, res) => {
  res.json({ count: onlineUsers.size + 1 }); // +1 для минимума
});

// ============ INIT ============
initDB();

// Run timers every minute
setInterval(() => runTimers(io), 60000);
runTimers(io); // Run once on start

// Create uploads dir
const fs = require('fs');
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   🎮 LeShop Backend Started!        ║
  ║   http://localhost:${PORT}              ║
  ║   Admin: ${process.env.ADMIN_EMAIL}     ║
  ╚══════════════════════════════════════╝
  `);
});