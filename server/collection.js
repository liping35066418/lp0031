const NodeCache = require('node-cache');
const { getDB } = require('./db');
const { generateTokenId, generateTxHash, recordOwnership, verifyTokenId } = require('./ownership');
const { getUser, updateUserLevel, recordTransaction, getLevelDiscount } = require('./user');
const CONFIG = require('../config');

const buyCache = new NodeCache({ stdTTL: 60, checkperiod: 10 });
const rateLimitMap = new Map();

function isRateLimited(userId) {
  const now = Date.now();
  const window = CONFIG.RATE_LIMIT.BUY_WINDOW;
  const key = `${userId}_${Math.floor(now / window)}`;
  const count = (rateLimitMap.get(key) || 0) + 1;
  rateLimitMap.set(key, count);
  return count > CONFIG.RATE_LIMIT.BUY_MAX_PER_WINDOW;
}

function createCollection(data, creatorId) {
  const db = getDB();
  const now = Date.now();
  const tokenId = data.token_id || generateTokenId({ name: data.name, time: now });
  
  if (verifyTokenId(tokenId)) {
    return { code: 400, message: '藏品标识冲突，请重试' };
  }
  
  const info = db.prepare(`INSERT INTO collections 
    (token_id, name, description, image_url, metadata, creator_id, category, 
     status, total_supply, original_price, start_sale_time, end_sale_time, per_user_limit,
     created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      tokenId, data.name, data.description || '', data.image_url || '',
      JSON.stringify(data.metadata || {}), creatorId, data.category || 'default',
      data.status !== undefined ? data.status : 0, data.total_supply || 1,
      data.original_price || 0, data.start_sale_time || now, data.end_sale_time || 0,
      data.per_user_limit || 1, now, now
    );
  
  recordOwnership({
    token_id: tokenId,
    from_address: 'SYSTEM',
    to_address: `CREATOR_${creatorId}`,
    to_user_id: creatorId,
    ownership_type: 'MINT',
    price: 0,
    remark: `藏品铸造: ${data.name}`
  });
  
  return { code: 0, data: { id: info.lastInsertRowid, token_id: tokenId } };
}

function importCollectionsBatch(list, creatorId) {
  const results = [];
  for (const item of list) {
    const r = createCollection(item, creatorId);
    results.push({ ...r, name: item.name });
  }
  return { code: 0, data: { total: list.length, results } };
}

function reviewCollection(id, approved, reason) {
  const db = getDB();
  const status = approved ? 1 : 2;
  db.prepare('UPDATE collections SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
  logAdminAction(1, 'REVIEW_COLLECTION', 'COLLECTION', String(id), `审核结果: ${approved ? '通过' : '拒绝'}, 原因: ${reason || ''}`);
  return { code: 0 };
}

function logAdminAction(adminId, action, targetType, targetId, detail) {
  const db = getDB();
  db.prepare('INSERT INTO admin_logs (admin_id, action, target_type, target_id, detail, created_at) VALUES (?,?,?,?,?,?)')
    .run(adminId, action, targetType, targetId, detail || '', Date.now());
}

function listCollections(params = {}) {
  const db = getDB();
  const { status, category, keyword, page = 1, pageSize = 20, sort = 'new' } = params;
  
  let sql = 'SELECT * FROM collections WHERE 1=1';
  const args = [];
  
  if (status !== undefined) { sql += ' AND status = ?'; args.push(status); }
  if (category) { sql += ' AND category = ?'; args.push(category); }
  if (keyword) { sql += ' AND (name LIKE ? OR description LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`); }
  
  const orderMap = { new: 'created_at DESC', price_asc: 'original_price ASC', price_desc: 'original_price DESC', hot: 'sold_count DESC' };
  sql += ` ORDER BY ${orderMap[sort] || orderMap.new}`;
  
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...args).c;
  sql += ` LIMIT ? OFFSET ?`;
  args.push(pageSize, (page - 1) * pageSize);
  
  const list = db.prepare(sql).all(...args);
  return { code: 0, data: { list, total, page, pageSize } };
}

function getCollectionDetail(idOrToken) {
  const db = getDB();
  const isToken = typeof idOrToken === 'string' && idOrToken.startsWith('NFT');
  const sql = isToken 
    ? 'SELECT * FROM collections WHERE token_id = ?'
    : 'SELECT * FROM collections WHERE id = ?';
  const collection = db.prepare(sql).get(idOrToken);
  if (!collection) return { code: 404, message: '藏品不存在' };
  
  if (collection.metadata) {
    try { collection.metadata = JSON.parse(collection.metadata); } catch (e) {}
  }
  
  return { code: 0, data: collection };
}

function getSaleStatus(collection) {
  const now = Date.now();
  if (collection.status !== 1) return { onSale: false, reason: '藏品未上架' };
  if (collection.start_sale_time > now) return { onSale: false, reason: '尚未开售', countdown: collection.start_sale_time - now };
  if (collection.end_sale_time && collection.end_sale_time < now) return { onSale: false, reason: '已结束销售' };
  if (collection.sold_count >= collection.total_supply) return { onSale: false, reason: '已售罄' };
  return { onSale: true };
}

function buyPrimary(userId, collectionId, quantity = 1) {
  const db = getDB();
  
  if (isRateLimited(userId)) {
    return { code: 429, message: '操作过于频繁，请稍后再试' };
  }
  
  const idempotentKey = `${userId}_${collectionId}_${Date.now().toString().slice(0, -3)}`;
  if (buyCache.get(idempotentKey)) {
    return { code: 409, message: '请勿重复下单' };
  }
  
  const user = getUser(userId);
  if (!user) return { code: 401, message: '用户不存在' };
  if (user.status !== 1) return { code: 403, message: '账号受限' };
  
  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId);
  if (!collection) return { code: 404, message: '藏品不存在' };
  
  const saleStatus = getSaleStatus(collection);
  if (!saleStatus.onSale) return { code: 400, message: saleStatus.reason };
  
  if (quantity < 1 || quantity > 5) return { code: 400, message: '单次购买数量非法' };
  
  const userBought = db.prepare(`SELECT COALESCE(SUM(quantity),0) as c FROM orders 
    WHERE user_id = ? AND collection_id = ? AND status IN ('PAID','COMPLETED')`)
    .get(userId, collectionId).c;
  
  if (userBought + quantity > collection.per_user_limit) {
    return { code: 400, message: `超过限购数量(每人限${collection.per_user_limit}份)` };
  }
  
  if (collection.sold_count + quantity > collection.total_supply) {
    return { code: 400, message: '库存不足' };
  }
  
  const discount = getLevelDiscount(user.level);
  const unitPrice = collection.original_price * discount;
  const totalAmount = Math.round(unitPrice * quantity * 100) / 100;
  
  if (user.balance < totalAmount) {
    return { code: 400, message: '余额不足' };
  }
  
  const riskResult = runRiskCheck(userId, collection, quantity, totalAmount, 'PRIMARY');
  if (riskResult.block) {
    return { code: 403, message: `风控拦截: ${riskResult.reason}` };
  }
  
  const tx = db.transaction(() => {
    const orderNo = generateTxHash('OD');
    const now = Date.now();
    
    db.prepare(`INSERT INTO orders 
      (order_no, user_id, collection_id, token_id, order_type, price, quantity, total_amount, 
       status, risk_checked, expire_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNo, userId, collectionId, collection.token_id, 'PRIMARY_SALE',
           unitPrice, quantity, totalAmount, riskResult.review ? 'PENDING_REVIEW' : 'PAID',
           riskResult.pass ? 1 : 0, now + 1800000, now, now);
    
    db.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ?, updated_at = ? WHERE id = ?')
      .run(totalAmount, totalAmount, now, userId);
    
    const newSold = collection.sold_count + quantity;
    db.prepare('UPDATE collections SET sold_count = ?, listed_count = listed_count + ?, updated_at = ? WHERE id = ?')
      .run(newSold, quantity, now, collectionId);
    
    for (let i = 0; i < quantity; i++) {
      db.prepare(`INSERT INTO user_collections 
        (user_id, token_id, collection_id, acquire_type, acquire_price, acquire_time, status, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(userId, collection.token_id, collectionId, 'PRIMARY_BUY', unitPrice, now, 1, now);
    }
    
    db.prepare('UPDATE users SET total_holdings = total_holdings + ?, updated_at = ? WHERE id = ?')
      .run(quantity, now, userId);
    
    recordOwnership({
      token_id: collection.token_id,
      from_address: `COLLECTION_${collectionId}`,
      to_address: `USER_${userId}`,
      to_user_id: userId,
      ownership_type: 'PRIMARY_SALE',
      price: unitPrice,
      remark: `发售购买 x${quantity}`
    });
    
    recordTransaction(userId, 'BUY_PRIMARY', `购买藏品:${collection.name} x${quantity}`, 
      -totalAmount, user.balance, user.balance - totalAmount);
    
    return { order_no: orderNo, total_amount: totalAmount };
  });
  
  buyCache.set(idempotentKey, true, 10);
  
  try {
    const result = tx();
    updateUserLevel(userId);
    return { code: 0, data: result };
  } catch (e) {
    console.error('购买异常回滚:', e);
    return { code: 500, message: '系统异常，订单已回滚' };
  }
}

function runRiskCheck(userId, collection, quantity, amount, type) {
  const db = getDB();
  const now = Date.now();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  
  if (!user) return { block: true, reason: '用户不存在' };
  if (user.risk_score >= 80) return { block: true, reason: '风险评分过高' };
  
  const recentOrders = db.prepare(`SELECT COUNT(*) as c FROM orders 
    WHERE user_id = ? AND created_at > ?`).get(userId, now - 60000).c;
  if (recentOrders >= 10) return { block: true, pass: false, reason: '高频交易触发风控' };
  
  if (!collection || !collection.start_sale_time) return { pass: true };
  const registeredAgo = now - (user.created_at || now);
  if (registeredAgo < 86400000 && amount > 5000) {
    return { block: false, review: true, pass: true, reason: '新用户大额交易待审核' };
  }
  
  return { pass: true };
}

function cancelOrder(orderNo, userId) {
  const db = getDB();
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo);
  if (!order) return { code: 404, message: '订单不存在' };
  if (order.user_id !== userId) return { code: 403, message: '无权操作' };
  if (!['PENDING', 'PENDING_REVIEW'].includes(order.status)) return { code: 400, message: '订单状态不可取消' };
  
  const tx = db.transaction(() => {
    const now = Date.now();
    db.prepare('UPDATE orders SET status = ?, fail_reason = ?, updated_at = ? WHERE order_no = ?')
      .run('CANCELLED', '用户取消', now, orderNo);
    
    if (order.status === 'PENDING_REVIEW' && order.total_amount > 0) {
      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
      db.prepare('UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?')
        .run(order.total_amount, now, userId);
      recordTransaction(userId, 'REFUND', `订单取消退款:${orderNo}`, 
        order.total_amount, user.balance, user.balance + order.total_amount);
    }
  });
  
  try { tx(); return { code: 0 }; } 
  catch (e) { return { code: 500, message: '取消失败' }; }
}

module.exports = {
  createCollection, importCollectionsBatch, reviewCollection,
  listCollections, getCollectionDetail, buyPrimary, cancelOrder,
  getSaleStatus, logAdminAction, runRiskCheck
};
