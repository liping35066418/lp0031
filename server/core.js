const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const CONFIG = require('../config');
const { initDB } = require('./db');
const {
  register, login, adminLogin, authMiddleware, adminMiddleware,
  getUser, getHoldingRankings, getLevelConfig, recordTransaction
} = require('./user');
const {
  createCollection, importCollectionsBatch, reviewCollection,
  listCollections, getCollectionDetail, buyPrimary, cancelOrder, logAdminAction
} = require('./collection');
const {
  createListing, cancelListing, listListings, buySecondary,
  createGift, claimGift, getUserCollections, getUserOrders,
  getTransactionLog, adminTakeDownListing, adminApproveListing,
  adminGetRiskListings, adminGetUserList, adminFreezeUser
} = require('./trade');
const { getOwnershipHistory, generateTokenId } = require('./ownership');

initDB();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[CORE:${CONFIG.PORTS.CORE}] ${req.method} ${req.url}`);
  next();
});

app.get('/', (req, res) => {
  res.json({ code: 0, data: { service: 'NFT Core Service', port: CONFIG.PORTS.CORE, status: 'online', time: Date.now() } });
});

app.post('/api/user/register', (req, res) => {
  const { username, password, nickname } = req.body;
  if (!username || !password) return res.json({ code: 400, message: '缺少参数' });
  res.json(register(username, password, nickname));
});

app.post('/api/user/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ code: 400, message: '缺少参数' });
  res.json(login(username, password));
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  res.json(adminLogin(username, password));
});

app.get('/api/user/info', authMiddleware, (req, res) => {
  const user = getUser(req.user.id);
  res.json({ code: 0, data: user });
});

app.post('/api/user/recharge', authMiddleware, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.json({ code: 400, message: '金额非法' });
  const { getDB } = require('./db');
  const db = getDB();
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.id);
  db.prepare('UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?')
    .run(amount, Date.now(), req.user.id);
  recordTransaction(req.user.id, 'RECHARGE', '用户充值', amount, user.balance, user.balance + amount);
  res.json({ code: 0, data: { balance: user.balance + amount } });
});

app.get('/api/rank/holdings', (req, res) => {
  res.json({ code: 0, data: getHoldingRankings(req.query.limit || 20) });
});

app.get('/api/levels', (req, res) => {
  res.json({ code: 0, data: getLevelConfig() });
});

app.get('/api/collections', (req, res) => {
  res.json(listCollections({
    status: req.query.status !== undefined ? parseInt(req.query.status) : 1,
    category: req.query.category,
    keyword: req.query.keyword,
    page: parseInt(req.query.page || 1),
    pageSize: parseInt(req.query.pageSize || 20),
    sort: req.query.sort
  }));
});

app.get('/api/collections/:id', (req, res) => {
  res.json(getCollectionDetail(req.params.id));
});

app.get('/api/collections/token/:tokenId/history', (req, res) => {
  res.json({ code: 0, data: getOwnershipHistory(req.params.tokenId, 100) });
});

app.post('/api/collections', authMiddleware, (req, res) => {
  res.json(createCollection(req.body, req.user.id));
});

app.post('/api/collections/import', authMiddleware, (req, res) => {
  const { list } = req.body;
  if (!Array.isArray(list) || list.length === 0) return res.json({ code: 400, message: '数据为空' });
  if (list.length > 500) return res.json({ code: 400, message: '单次最多500条' });
  res.json(importCollectionsBatch(list, req.user.id));
});

app.post('/api/collections/buy', authMiddleware, (req, res) => {
  const { collection_id, quantity } = req.body;
  res.json(buyPrimary(req.user.id, collection_id, quantity || 1));
});

app.post('/api/orders/cancel', authMiddleware, (req, res) => {
  res.json(cancelOrder(req.body.order_no, req.user.id));
});

app.get('/api/orders', authMiddleware, (req, res) => {
  res.json(getUserOrders(req.user.id, {
    status: req.query.status,
    type: req.query.type,
    page: parseInt(req.query.page || 1),
    pageSize: parseInt(req.query.pageSize || 20)
  }));
});

app.get('/api/listings', (req, res) => {
  res.json(listListings({
    status: req.query.status || 'ACTIVE',
    keyword: req.query.keyword,
    minPrice: req.query.minPrice ? parseFloat(req.query.minPrice) : undefined,
    maxPrice: req.query.maxPrice ? parseFloat(req.query.maxPrice) : undefined,
    sort: req.query.sort,
    page: parseInt(req.query.page || 1),
    pageSize: parseInt(req.query.pageSize || 20)
  }));
});

app.post('/api/listings', authMiddleware, (req, res) => {
  const { token_id, price, expire_hours } = req.body;
  if (!token_id || !price) return res.json({ code: 400, message: '缺少参数' });
  res.json(createListing(req.user.id, token_id, parseFloat(price), expire_hours || 72));
});

app.post('/api/listings/cancel', authMiddleware, (req, res) => {
  res.json(cancelListing(req.user.id, req.body.id));
});

app.post('/api/listings/buy', authMiddleware, (req, res) => {
  res.json(buySecondary(req.user.id, req.body.listing_id));
});

app.get('/api/my/collections', authMiddleware, (req, res) => {
  res.json(getUserCollections(req.user.id, {
    status: req.query.status !== undefined ? parseInt(req.query.status) : undefined,
    page: parseInt(req.query.page || 1),
    pageSize: parseInt(req.query.pageSize || 20)
  }));
});

app.get('/api/my/transactions', authMiddleware, (req, res) => {
  res.json(getTransactionLog(req.user.id, parseInt(req.query.page || 1), parseInt(req.query.pageSize || 50)));
});

app.post('/api/gifts', authMiddleware, (req, res) => {
  const { to_username, token_id, message } = req.body;
  res.json(createGift(req.user.id, to_username, token_id, message));
});

app.post('/api/gifts/claim', authMiddleware, (req, res) => {
  res.json(claimGift(req.user.id, req.body.gift_no));
});

app.get('/api/gifts/received', authMiddleware, (req, res) => {
  const { getDB } = require('./db');
  const db = getDB();
  const list = db.prepare(`SELECT g.*, u1.nickname as from_nickname, u2.nickname as to_nickname, c.name as collection_name, c.image_url
    FROM gifts g 
    LEFT JOIN users u1 ON g.from_user_id = u1.id
    LEFT JOIN users u2 ON g.to_user_id = u2.id
    LEFT JOIN collections c ON g.token_id = c.token_id
    WHERE g.to_user_id = ? ORDER BY g.created_at DESC LIMIT 100`).all(req.user.id);
  res.json({ code: 0, data: list });
});

app.post('/api/admin/collections/review', adminMiddleware, (req, res) => {
  const { id, approved, reason } = req.body;
  res.json(reviewCollection(id, approved, reason));
});

app.get('/api/admin/collections/pending', adminMiddleware, (req, res) => {
  res.json(listCollections({ status: 0, page: 1, pageSize: 100 }));
});

app.get('/api/admin/listings/risk', adminMiddleware, (req, res) => {
  res.json(adminGetRiskListings());
});

app.post('/api/admin/listings/takedown', adminMiddleware, (req, res) => {
  res.json(adminTakeDownListing(req.body.id, req.body.reason));
});

app.post('/api/admin/listings/approve', adminMiddleware, (req, res) => {
  res.json(adminApproveListing(req.body.id));
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  res.json(adminGetUserList(req.query.keyword, parseInt(req.query.page || 1), parseInt(req.query.pageSize || 20)));
});

app.post('/api/admin/users/freeze', adminMiddleware, (req, res) => {
  res.json(adminFreezeUser(req.body.id, req.body.freeze));
});

app.get('/api/admin/statistics', adminMiddleware, (req, res) => {
  const { getDB } = require('./db');
  const db = getDB();
  const stats = {
    total_users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    total_collections: db.prepare('SELECT COUNT(*) as c FROM collections').get().c,
    total_orders: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
    total_volume: db.prepare('SELECT COALESCE(SUM(total_amount),0) as c FROM orders WHERE status IN (\'PAID\',\'COMPLETED\')').get().c,
    pending_collections: db.prepare('SELECT COUNT(*) as c FROM collections WHERE status = 0').get().c,
    risk_listings: db.prepare('SELECT COUNT(*) as c FROM listings WHERE risk_flag = 1 OR status = \'PENDING_REVIEW\'').get().c,
    total_chain_records: db.prepare('SELECT COUNT(*) as c FROM ownership_chain').get().c
  };
  res.json({ code: 0, data: stats });
});

app.get('/api/admin/logs', adminMiddleware, (req, res) => {
  const { getDB } = require('./db');
  const db = getDB();
  const list = db.prepare('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 200').all();
  res.json({ code: 0, data: list });
});

app.use((err, req, res, next) => {
  console.error('API错误:', err);
  res.status(500).json({ code: 500, message: '服务器内部错误: ' + err.message });
});

app.listen(CONFIG.PORTS.CORE, () => {
  console.log(`🚀 NFT 核心服务已启动: http://localhost:${CONFIG.PORTS.CORE}`);
});

module.exports = app;
