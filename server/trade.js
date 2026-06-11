const { getDB } = require('./db');
const { generateTxHash, recordOwnership, verifyOwnership, getOwnershipHistory } = require('./ownership');
const { getUser, updateUserLevel, recordTransaction, getLevelDiscount } = require('./user');
const { logAdminAction, runRiskCheck } = require('./collection');

function createListing(userId, tokenId, price, expireHours = 72) {
  const db = getDB();
  const now = Date.now();
  
  if (!verifyOwnership(tokenId, userId)) {
    return { code: 403, message: '您不拥有该藏品的权属' };
  }
  
  const existingActive = db.prepare(`SELECT l.id FROM listings l 
    WHERE l.token_id = ? AND l.status = 'ACTIVE' AND l.seller_id = ?`)
    .get(tokenId, userId);
  if (existingActive) return { code: 400, message: '该藏品已有在挂单中' };
  
  const collection = db.prepare('SELECT original_price FROM collections WHERE token_id = ?').get(tokenId);
  const originalPrice = collection?.original_price || price;
  const priceRatio = price / originalPrice;
  
  let riskFlag = 0, riskReason = '';
  if (priceRatio < 0.5) { riskFlag = 1; riskReason = '价格低于原始价50%'; }
  if (priceRatio > 5) { riskFlag = 1; riskReason = '价格高于原始价500%'; }
  
  const userCollection = db.prepare(`SELECT id FROM user_collections 
    WHERE token_id = ? AND user_id = ? AND status = 1 LIMIT 1`)
    .get(tokenId, userId);
  
  const listingNo = generateTxHash('LS');
  const info = db.prepare(`INSERT INTO listings 
    (listing_no, seller_id, token_id, user_collection_id, price, status, 
     risk_flag, risk_reason, created_at, updated_at, expire_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(listingNo, userId, tokenId, userCollection?.id, price,
         riskFlag ? 'PENDING_REVIEW' : 'ACTIVE', riskFlag, riskReason,
         now, now, now + expireHours * 3600 * 1000);
  
  db.prepare('UPDATE user_collections SET status = 2 WHERE id = ?').run(userCollection.id);
  
  return { code: 0, data: { id: info.lastInsertRowid, listing_no: listingNo, risk_flag: riskFlag } };
}

function cancelListing(userId, listingId) {
  const db = getDB();
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!listing) return { code: 404, message: '挂单不存在' };
  if (listing.seller_id !== userId) return { code: 403, message: '无权操作' };
  if (!['ACTIVE', 'PENDING_REVIEW'].includes(listing.status)) return { code: 400, message: '当前状态不可取消' };
  
  const tx = db.transaction(() => {
    const now = Date.now();
    db.prepare('UPDATE listings SET status = ?, updated_at = ? WHERE id = ?')
      .run('CANCELLED', now, listingId);
    if (listing.user_collection_id) {
      db.prepare('UPDATE user_collections SET status = 1 WHERE id = ?').run(listing.user_collection_id);
    }
  });
  
  try { tx(); return { code: 0 }; }
  catch (e) { return { code: 500, message: '取消失败' }; }
}

function listListings(params = {}) {
  const db = getDB();
  const { status = 'ACTIVE', keyword, minPrice, maxPrice, sort = 'new', page = 1, pageSize = 20 } = params;
  
  let sql = `SELECT l.*, c.name as collection_name, c.image_url, c.category,
             u.nickname as seller_nickname, u.level as seller_level
             FROM listings l 
             LEFT JOIN collections c ON l.token_id = c.token_id
             LEFT JOIN users u ON l.seller_id = u.id
             WHERE l.risk_flag = 0`;
  const args = [];
  
  if (status) { sql += ' AND l.status = ?'; args.push(status); }
  if (keyword) { sql += ' AND (c.name LIKE ?)'; args.push(`%${keyword}%`); }
  if (minPrice) { sql += ' AND l.price >= ?'; args.push(minPrice); }
  if (maxPrice) { sql += ' AND l.price <= ?'; args.push(maxPrice); }
  
  const orderMap = { new: 'l.created_at DESC', price_asc: 'l.price ASC', price_desc: 'l.price DESC' };
  sql += ` ORDER BY ${orderMap[sort] || orderMap.new}`;
  
  const total = db.prepare(sql.replace(/SELECT [\s\S]*? FROM/, 'SELECT COUNT(*) as c FROM')).get(...args).c;
  sql += ` LIMIT ? OFFSET ?`;
  args.push(pageSize, (page - 1) * pageSize);
  
  return { code: 0, data: { list: db.prepare(sql).all(...args), total, page, pageSize } };
}

function buySecondary(userId, listingId) {
  const db = getDB();
  const now = Date.now();
  
  const user = getUser(userId);
  if (!user) return { code: 401, message: '用户不存在' };
  
  const listing = db.prepare(`SELECT l.*, c.token_id, c.name, c.original_price 
    FROM listings l LEFT JOIN collections c ON l.token_id = c.token_id WHERE l.id = ?`)
    .get(listingId);
  
  if (!listing) return { code: 404, message: '挂单不存在' };
  if (listing.status !== 'ACTIVE') return { code: 400, message: '挂单当前不可购买' };
  if (listing.seller_id === userId) return { code: 400, message: '不能购买自己的挂单' };
  if (listing.expire_at < now) return { code: 400, message: '挂单已过期' };
  
  const discount = getLevelDiscount(user.level);
  const finalPrice = Math.round(listing.price * discount * 100) / 100;
  
  if (user.balance < finalPrice) return { code: 400, message: '余额不足' };
  
  const fakeCollection = { original_price: listing.original_price, start_sale_time: now };
  const risk = runRiskCheck(userId, fakeCollection, 1, finalPrice, 'SECONDARY');
  if (risk.block) return { code: 403, message: `风控拦截: ${risk.reason}` };
  
  const seller = db.prepare('SELECT * FROM users WHERE id = ?').get(listing.seller_id);
  if (!seller) return { code: 500, message: '卖家账户异常' };
  
  const tx = db.transaction(() => {
    const orderNo = generateTxHash('OD');
    
    db.prepare(`INSERT INTO orders 
      (order_no, user_id, token_id, order_type, price, quantity, total_amount, 
       status, risk_checked, expire_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNo, userId, listing.token_id, 'SECONDARY_SALE', finalPrice, 1,
           finalPrice, risk.review ? 'PENDING_REVIEW' : 'PAID',
           risk.pass ? 1 : 0, now + 1800000, now, now);
    
    db.prepare('UPDATE listings SET status = ?, updated_at = ? WHERE id = ?')
      .run('SOLD', now, listingId);
    
    db.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ?, total_holdings = total_holdings + 1, updated_at = ? WHERE id = ?')
      .run(finalPrice, finalPrice, now, userId);
    
    const sellerIncome = Math.round(listing.price * 0.98 * 100) / 100;
    db.prepare('UPDATE users SET balance = balance + ?, total_holdings = total_holdings - 1, updated_at = ? WHERE id = ?')
      .run(sellerIncome, now, listing.seller_id);
    
    db.prepare('UPDATE user_collections SET status = 0 WHERE id = ?').run(listing.user_collection_id);
    
    db.prepare(`INSERT INTO user_collections 
      (user_id, token_id, acquire_type, acquire_price, acquire_time, status, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(userId, listing.token_id, 'SECONDARY_BUY', finalPrice, now, 1, now);
    
    recordOwnership({
      token_id: listing.token_id,
      from_address: `USER_${listing.seller_id}`,
      to_address: `USER_${userId}`,
      from_user_id: listing.seller_id,
      to_user_id: userId,
      ownership_type: 'SECONDARY_TRADE',
      price: finalPrice,
      remark: `二手交易 挂单号:${listing.listing_no}`
    });
    
    recordTransaction(userId, 'BUY_SECONDARY', `购买挂单:${listing.listing_no}`, 
      -finalPrice, user.balance, user.balance - finalPrice);
    recordTransaction(listing.seller_id, 'SELL_SECONDARY', `出售挂单:${listing.listing_no}`, 
      sellerIncome, seller.balance, seller.balance + sellerIncome);
    
    return { order_no: orderNo, final_price: finalPrice, seller_income: sellerIncome };
  });
  
  try {
    const result = tx();
    updateUserLevel(userId);
    updateUserLevel(listing.seller_id);
    return { code: 0, data: result };
  } catch (e) {
    console.error('二次交易异常:', e);
    return { code: 500, message: '交易失败，已回滚' };
  }
}

function createGift(fromUserId, toUsername, tokenId, message = '') {
  const db = getDB();
  const now = Date.now();
  
  if (!verifyOwnership(tokenId, fromUserId)) {
    return { code: 403, message: '您不拥有该藏品' };
  }
  
  const toUser = db.prepare('SELECT * FROM users WHERE username = ?').get(toUsername);
  if (!toUser) return { code: 404, message: '接收方用户不存在' };
  if (toUser.id === fromUserId) return { code: 400, message: '不能转赠给自己' };
  
  const userCollection = db.prepare(`SELECT id FROM user_collections 
    WHERE token_id = ? AND user_id = ? AND status = 1 LIMIT 1`)
    .get(tokenId, fromUserId);
  
  const giftNo = generateTxHash('GF');
  const info = db.prepare(`INSERT INTO gifts 
    (gift_no, from_user_id, to_user_id, token_id, status, message, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(giftNo, fromUserId, toUser.id, tokenId, 'PENDING', message, now);
  
  db.prepare('UPDATE user_collections SET status = 3 WHERE id = ?').run(userCollection.id);
  
  return { code: 0, data: { id: info.lastInsertRowid, gift_no: giftNo } };
}

function claimGift(userId, giftNo) {
  const db = getDB();
  const now = Date.now();
  
  const gift = db.prepare('SELECT * FROM gifts WHERE gift_no = ?').get(giftNo);
  if (!gift) return { code: 404, message: '转赠记录不存在' };
  if (gift.to_user_id !== userId) return { code: 403, message: '无权领取该转赠' };
  if (gift.status !== 'PENDING') return { code: 400, message: '转赠状态不可领取' };
  
  const tx = db.transaction(() => {
    db.prepare('UPDATE gifts SET status = ?, claimed_at = ? WHERE gift_no = ?')
      .run('CLAIMED', now, giftNo);
    
    db.prepare(`UPDATE user_collections SET status = 0 
      WHERE token_id = ? AND user_id = ? AND status = 3`)
      .run(gift.token_id, gift.from_user_id);
    
    db.prepare(`INSERT INTO user_collections 
      (user_id, token_id, acquire_type, acquire_price, acquire_time, status, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(userId, gift.token_id, 'GIFT', 0, now, 1, now);
    
    db.prepare('UPDATE users SET total_holdings = total_holdings + 1, updated_at = ? WHERE id = ?')
      .run(now, userId);
    db.prepare('UPDATE users SET total_holdings = total_holdings - 1, updated_at = ? WHERE id = ?')
      .run(now, gift.from_user_id);
    
    recordOwnership({
      token_id: gift.token_id,
      from_address: `USER_${gift.from_user_id}`,
      to_address: `USER_${userId}`,
      from_user_id: gift.from_user_id,
      to_user_id: userId,
      ownership_type: 'GIFT',
      price: 0,
      remark: `转赠:${gift.message || '无留言'}`
    });
  });
  
  try {
    tx();
    updateUserLevel(userId);
    updateUserLevel(gift.from_user_id);
    return { code: 0 };
  } catch (e) {
    return { code: 500, message: '领取失败' };
  }
}

function getUserCollections(userId, params = {}) {
  const db = getDB();
  const { status, page = 1, pageSize = 20 } = params;
  
  let sql = `SELECT uc.*, c.name, c.image_url, c.category, c.original_price, c.token_id as tkn
    FROM user_collections uc 
    LEFT JOIN collections c ON uc.collection_id = c.id OR uc.token_id = c.token_id
    WHERE uc.user_id = ?`;
  const args = [userId];
  
  if (status !== undefined) { sql += ' AND uc.status = ?'; args.push(status); }
  sql += ' ORDER BY uc.acquire_time DESC';
  
  const total = db.prepare(sql.replace(/SELECT [\s\S]*? FROM/, 'SELECT COUNT(*) as c FROM')).get(...args).c;
  sql += ` LIMIT ? OFFSET ?`;
  args.push(pageSize, (page - 1) * pageSize);
  
  return { code: 0, data: { list: db.prepare(sql).all(...args), total, page, pageSize } };
}

function getUserOrders(userId, params = {}) {
  const db = getDB();
  const { status, type, page = 1, pageSize = 20 } = params;
  
  let sql = `SELECT o.*, c.name as collection_name, c.image_url 
    FROM orders o LEFT JOIN collections c ON o.collection_id = c.id
    WHERE o.user_id = ?`;
  const args = [userId];
  
  if (status) { sql += ' AND o.status = ?'; args.push(status); }
  if (type) { sql += ' AND o.order_type = ?'; args.push(type); }
  sql += ' ORDER BY o.created_at DESC';
  
  const total = db.prepare(sql.replace(/SELECT [\s\S]*? FROM/, 'SELECT COUNT(*) as c FROM')).get(...args).c;
  sql += ` LIMIT ? OFFSET ?`;
  args.push(pageSize, (page - 1) * pageSize);
  
  return { code: 0, data: { list: db.prepare(sql).all(...args), total, page, pageSize } };
}

function getTransactionLog(userId, page = 1, pageSize = 50) {
  const db = getDB();
  const sql = 'SELECT * FROM transactions_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?';
  return { code: 0, data: db.prepare(sql).all(userId, pageSize, (page - 1) * pageSize) };
}

function adminTakeDownListing(listingId, reason) {
  const db = getDB();
  const now = Date.now();
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
  if (!listing) return { code: 404, message: '挂单不存在' };
  
  const tx = db.transaction(() => {
    db.prepare('UPDATE listings SET status = ?, risk_flag = 1, risk_reason = ?, updated_at = ? WHERE id = ?')
      .run('TAKEDOWN', reason || '违规下架', now, listingId);
    if (listing.user_collection_id) {
      db.prepare('UPDATE user_collections SET status = 1 WHERE id = ?').run(listing.user_collection_id);
    }
    logAdminAction(1, 'TAKEDOWN_LISTING', 'LISTING', String(listingId), reason || '违规下架');
  });
  
  try { tx(); return { code: 0 }; }
  catch (e) { return { code: 500, message: '操作失败' }; }
}

function adminApproveListing(listingId) {
  const db = getDB();
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND status = ?').get(listingId, 'PENDING_REVIEW');
  if (!listing) return { code: 404, message: '无待审核挂单' };
  db.prepare('UPDATE listings SET status = ?, risk_flag = 0, updated_at = ? WHERE id = ?')
    .run('ACTIVE', Date.now(), listingId);
  logAdminAction(1, 'APPROVE_LISTING', 'LISTING', String(listingId), '审核通过');
  return { code: 0 };
}

function adminGetRiskListings() {
  const db = getDB();
  const list = db.prepare(`SELECT l.*, c.name as collection_name, u.nickname as seller_name
    FROM listings l 
    LEFT JOIN collections c ON l.token_id = c.token_id
    LEFT JOIN users u ON l.seller_id = u.id
    WHERE l.risk_flag = 1 OR l.status = 'PENDING_REVIEW'
    ORDER BY l.created_at DESC`).all();
  return { code: 0, data: list };
}

function adminGetUserList(keyword = '', page = 1, pageSize = 20) {
  const db = getDB();
  let sql = 'SELECT * FROM users WHERE 1=1';
  const args = [];
  if (keyword) { sql += ' AND (username LIKE ? OR nickname LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`); }
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...args).c;
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  args.push(pageSize, (page - 1) * pageSize);
  return { code: 0, data: { list: db.prepare(sql).all(...args), total, page, pageSize } };
}

function adminFreezeUser(userId, freeze) {
  const db = getDB();
  db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
    .run(freeze ? 0 : 1, Date.now(), userId);
  logAdminAction(1, freeze ? 'FREEZE_USER' : 'UNFREEZE_USER', 'USER', String(userId), '');
  return { code: 0 };
}

module.exports = {
  createListing, cancelListing, listListings, buySecondary,
  createGift, claimGift, getUserCollections, getUserOrders,
  getTransactionLog, adminTakeDownListing, adminApproveListing,
  adminGetRiskListings, adminGetUserList, adminFreezeUser
};
