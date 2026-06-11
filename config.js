const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(__dirname, 'cache');
const LOG_DIR = path.join(__dirname, 'logs');

[DATA_DIR, CACHE_DIR, LOG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

module.exports = {
  PORTS: {
    CORE: 8671,
    WEB: 3671
  },
  PATHS: {
    DATA: DATA_DIR,
    CACHE: CACHE_DIR,
    LOG: LOG_DIR,
    DB: path.join(DATA_DIR, 'nft_system.db'),
    CHAIN_LOG: path.join(DATA_DIR, 'ownership_chain.log'),
    TX_LOG: path.join(LOG_DIR, 'transaction.log')
  },
  JWT: {
    SECRET: 'nft-trading-system-secret-key-2024',
    EXPIRES: '24h'
  },
  RATE_LIMIT: {
    BUY_WINDOW: 1000,
    BUY_MAX_PER_WINDOW: 3
  },
  LEVELS: [
    { level: 1, name: '新手藏家', minHoldings: 0, discount: 1.0 },
    { level: 2, name: '初级藏家', minHoldings: 3, discount: 0.98 },
    { level: 3, name: '中级藏家', minHoldings: 10, discount: 0.95 },
    { level: 4, name: '高级藏家', minHoldings: 30, discount: 0.92 },
    { level: 5, name: '资深藏家', minHoldings: 80, discount: 0.88 },
    { level: 6, name: '顶级藏家', minHoldings: 200, discount: 0.85 }
  ],
  ADMIN: {
    username: 'admin',
    password: 'admin123'
  }
};
