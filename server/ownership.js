const crypto = require('crypto');
const fs = require('fs');
const CONFIG = require('../config');
const { getDB } = require('./db');

function generateTokenId(metadata = {}) {
  const raw = `${Date.now()}_${JSON.stringify(metadata)}_${Math.random()}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return `NFT${hash.substring(0, 8).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;
}

function generateTxHash(prefix = 'TX') {
  const raw = `${prefix}_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
  return `${prefix}${crypto.createHash('sha256').update(raw).digest('hex').substring(0, 24).toUpperCase()}`;
}

function verifyTokenId(tokenId, metadata = {}) {
  if (!tokenId || typeof tokenId !== 'string') return false;
  if (!/^NFT[A-Z0-9]{8,}$/.test(tokenId)) return false;
  const db = getDB();
  const exists = db.prepare('SELECT id FROM collections WHERE token_id = ?').get(tokenId);
  return !!exists;
}

function bindMetadata(tokenId, metadata) {
  const db = getDB();
  const metadataStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  const hash = crypto.createHash('sha256').update(tokenId + metadataStr).digest('hex');
  const result = db.prepare('UPDATE collections SET metadata = ?, metadata_hash = ? WHERE token_id = ?')
    .run(metadataStr, hash, tokenId);
  return result.changes > 0;
}

function writeChainLog(entry) {
  const line = `[${new Date(entry.timestamp).toISOString()}] HASH:${entry.tx_hash} | PREV:${entry.prev_hash || 'GENESIS'} | TOKEN:${entry.token_id} | FROM:${entry.from_address || 'SYSTEM'} -> TO:${entry.to_address} | TYPE:${entry.ownership_type} | PRICE:${entry.price || 0}\n`;
  fs.appendFileSync(CONFIG.PATHS.CHAIN_LOG, line);
}

function recordOwnership(data) {
  const db = getDB();
  const now = Date.now();
  
  const lastRecord = db.prepare('SELECT tx_hash, block_height FROM ownership_chain WHERE token_id = ? ORDER BY id DESC LIMIT 1')
    .get(data.token_id);
  
  const txHash = data.tx_hash || generateTxHash('CH');
  const blockHeight = (lastRecord?.block_height || 0) + 1;
  const prevHash = lastRecord?.tx_hash || 'GENESIS_' + data.token_id;
  
  const stmt = db.prepare(`INSERT INTO ownership_chain 
    (token_id, tx_hash, from_address, to_address, from_user_id, to_user_id, 
     ownership_type, price, prev_hash, block_height, timestamp, remark, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  
  const info = stmt.run(
    data.token_id, txHash, data.from_address, data.to_address,
    data.from_user_id, data.to_user_id, data.ownership_type,
    data.price || 0, prevHash, blockHeight, now, data.remark || '', now
  );
  
  writeChainLog({
    tx_hash: txHash,
    prev_hash: prevHash,
    token_id: data.token_id,
    from_address: data.from_address,
    to_address: data.to_address,
    ownership_type: data.ownership_type,
    price: data.price || 0,
    timestamp: now
  });
  
  return { id: info.lastInsertRowid, tx_hash: txHash, block_height: blockHeight, prev_hash: prevHash };
}

function getOwnershipHistory(tokenId, limit = 100) {
  const db = getDB();
  return db.prepare('SELECT * FROM ownership_chain WHERE token_id = ? ORDER BY block_height DESC LIMIT ?')
    .all(tokenId, limit);
}

function verifyOwnership(tokenId, userId) {
  const db = getDB();
  const ownership = db.prepare(`SELECT uc.* FROM user_collections uc 
    WHERE uc.token_id = ? AND uc.user_id = ? AND uc.status = 1 LIMIT 1`)
    .get(tokenId, userId);
  
  if (!ownership) return false;
  
  const lastChain = db.prepare('SELECT to_user_id FROM ownership_chain WHERE token_id = ? ORDER BY block_height DESC LIMIT 1')
    .get(tokenId);
  
  return lastChain && lastChain.to_user_id === userId;
}

module.exports = {
  generateTokenId,
  generateTxHash,
  verifyTokenId,
  bindMetadata,
  recordOwnership,
  getOwnershipHistory,
  verifyOwnership
};
