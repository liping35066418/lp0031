const jwt = require('jsonwebtoken');
const md5 = require('md5');
const CONFIG = require('../config');
const { getDB } = require('./db');
const { generateTxHash } = require('./ownership');

function hashPassword(pwd) {
  return md5(pwd + '_NFT_SALT_2024');
}

function generateToken(user) {
  return jwt.sign({
    id: user.id,
    username: user.username,
    level: user.level
  }, CONFIG.JWT.SECRET, { expiresIn: CONFIG.JWT.EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, CONFIG.JWT.SECRET);
  } catch (e) {
    return null;
  }
}

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ code: 401, message: '未登录或登录已过期' });
  req.user = decoded;
  next();
}

function adminMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ code: 401, message: '未登录' });
  try {
    const decoded = jwt.verify(token, CONFIG.JWT.SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ code: 403, message: '需要管理员权限' });
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ code: 401, message: '登录已过期' });
  }
}

function register(username, password, nickname) {
  const db = getDB();
  const now = Date.now();
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return { code: 400, message: '用户名已存在' };
  }
  const info = db.prepare(`INSERT INTO users 
    (username, password, nickname, balance, level, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(username, hashPassword(password), nickname || username, 10000, 1, now, now);
  
  const user = { id: info.lastInsertRowid, username, nickname: nickname || username, level: 1, balance: 10000 };
  recordTransaction(user.id, 'REGISTER_BONUS', '系统赠送', 10000, 0, 10000);
  
  return { code: 0, data: { user, token: generateToken(user) } };
}

function login(username, password) {
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND status = 1').get(username);
  if (!user || user.password !== hashPassword(password)) {
    return { code: 400, message: '用户名或密码错误' };
  }
  db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(Date.now(), user.id);
  const token = generateToken(user);
  return { code: 0, data: { user: sanitizeUser(user), token } };
}

function adminLogin(username, password) {
  if (username !== CONFIG.ADMIN.username || password !== CONFIG.ADMIN.password) {
    return { code: 400, message: '管理员账号或密码错误' };
  }
  const token = jwt.sign({ isAdmin: true, username }, CONFIG.JWT.SECRET, { expiresIn: CONFIG.JWT.EXPIRES });
  return { code: 0, data: { token, username } };
}

function sanitizeUser(user) {
  const { password, ...rest } = user;
  return rest;
}

function getUser(userId) {
  const db = getDB();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return user ? sanitizeUser(user) : null;
}

function updateUserLevel(userId) {
  const db = getDB();
  const user = db.prepare('SELECT total_holdings FROM users WHERE id = ?').get(userId);
  if (!user) return;
  let level = 1;
  for (const lv of CONFIG.LEVELS) {
    if (user.total_holdings >= lv.minHoldings) level = lv.level;
  }
  db.prepare('UPDATE users SET level = ?, updated_at = ? WHERE id = ?').run(level, Date.now(), userId);
  return level;
}

function recordTransaction(userId, txType, detail, amount, before, after) {
  const db = getDB();
  const now = Date.now();
  db.prepare(`INSERT INTO transactions_log 
    (tx_no, user_id, tx_type, amount, balance_before, balance_after, status, detail, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(generateTxHash('TX'), userId, txType, amount, before, after, 'SUCCESS', detail, now);
}

function getHoldingRankings(limit = 20) {
  const db = getDB();
  return db.prepare(`SELECT u.id, u.nickname, u.username, u.level, u.total_holdings, u.total_spent
    FROM users u WHERE u.status = 1 ORDER BY u.total_holdings DESC, u.total_spent DESC LIMIT ?`)
    .all(limit);
}

function getLevelConfig() {
  return CONFIG.LEVELS;
}

function getLevelDiscount(level) {
  const lv = CONFIG.LEVELS.find(l => l.level === level) || CONFIG.LEVELS[0];
  return lv.discount;
}

module.exports = {
  register, login, adminLogin, authMiddleware, adminMiddleware,
  getUser, updateUserLevel, recordTransaction, getHoldingRankings,
  getLevelConfig, getLevelDiscount, verifyToken, hashPassword
};
