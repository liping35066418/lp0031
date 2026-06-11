const Database = require('better-sqlite3');
const CONFIG = require('../config');
const fs = require('fs');
const path = require('path');

let db = null;

function initDB() {
  if (db) return db;
  db = new Database(CONFIG.PATHS.DB);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables();
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nickname TEXT,
      phone TEXT,
      balance REAL DEFAULT 0,
      level INTEGER DEFAULT 1,
      total_spent REAL DEFAULT 0,
      total_holdings INTEGER DEFAULT 0,
      risk_score INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      metadata TEXT,
      creator_id INTEGER,
      category TEXT,
      status INTEGER DEFAULT 0,
      total_supply INTEGER DEFAULT 1,
      sold_count INTEGER DEFAULT 0,
      listed_count INTEGER DEFAULT 0,
      original_price REAL,
      start_sale_time INTEGER,
      end_sale_time INTEGER,
      per_user_limit INTEGER DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ownership_chain (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      tx_hash TEXT UNIQUE NOT NULL,
      from_address TEXT,
      to_address TEXT NOT NULL,
      from_user_id INTEGER,
      to_user_id INTEGER,
      ownership_type TEXT,
      price REAL DEFAULT 0,
      prev_hash TEXT,
      block_height INTEGER,
      timestamp INTEGER,
      remark TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      collection_id INTEGER,
      acquire_type TEXT,
      acquire_price REAL,
      acquire_time INTEGER,
      status INTEGER DEFAULT 1,
      created_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (collection_id) REFERENCES collections(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      collection_id INTEGER,
      token_id TEXT,
      order_type TEXT,
      price REAL,
      quantity INTEGER DEFAULT 1,
      total_amount REAL,
      status TEXT DEFAULT 'PENDING',
      payment_method TEXT,
      risk_checked INTEGER DEFAULT 0,
      fail_reason TEXT,
      expire_at INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (collection_id) REFERENCES collections(id)
    );

    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_no TEXT UNIQUE NOT NULL,
      seller_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      user_collection_id INTEGER,
      price REAL NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      risk_flag INTEGER DEFAULT 0,
      risk_reason TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      expire_at INTEGER,
      FOREIGN KEY (seller_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS gifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gift_no TEXT UNIQUE NOT NULL,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      token_id TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      message TEXT,
      created_at INTEGER,
      claimed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS transactions_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_no TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      related_id TEXT,
      tx_type TEXT,
      amount REAL,
      balance_before REAL,
      balance_after REAL,
      status TEXT,
      detail TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      action TEXT,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS risk_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_code TEXT UNIQUE,
      rule_name TEXT,
      description TEXT,
      enabled INTEGER DEFAULT 1,
      threshold TEXT,
      action TEXT,
      created_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_token_id ON collections(token_id);
    CREATE INDEX IF NOT EXISTS idx_oc_token ON ownership_chain(token_id);
    CREATE INDEX IF NOT EXISTS idx_uc_user ON user_collections(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_listings_token ON listings(token_id);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  `);

  const riskCount = db.prepare('SELECT COUNT(*) as c FROM risk_rules').get();
  if (riskCount.c === 0) {
    const rules = [
      { rule_code: 'R001', rule_name: '单次限购', description: '单用户限购数量检查', threshold: 'per_user_limit', action: 'REJECT' },
      { rule_code: 'R002', rule_name: '高频交易', description: '用户短时间内下单次数过多', threshold: '10/m', action: 'FLAG' },
      { rule_code: 'R003', rule_name: '异常低价', description: '挂单价格低于市场价50%', threshold: '0.5', action: 'REVIEW' },
      { rule_code: 'R004', rule_name: '异常高价', description: '挂单价格高于市场价500%', threshold: '5.0', action: 'REVIEW' },
      { rule_code: 'R005', rule_name: '新用户风控', description: '注册24小时内用户大额交易审核', threshold: '86400', action: 'REVIEW' }
    ];
    const stmt = db.prepare('INSERT INTO risk_rules (rule_code, rule_name, description, threshold, action, created_at) VALUES (?,?,?,?,?,?)');
    const now = Date.now();
    rules.forEach(r => stmt.run(r.rule_code, r.rule_name, r.description, r.threshold, r.action, now));
  }
}

function getDB() {
  if (!db) initDB();
  return db;
}

module.exports = { initDB, getDB };
