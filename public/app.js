const API = `http://localhost:8671`;

const Store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
  getToken() { return localStorage.getItem('token'); },
  setToken(t) { localStorage.setItem('token', t); },
  clear() { localStorage.clear(); },
  getUser() { return this.get('user'); },
  setUser(u) { this.set('user', u); }
};

async function api(method, path, data) {
  const headers = { 'Content-Type': 'application/json' };
  const token = Store.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (data) {
    if (method === 'GET') path += '?' + new URLSearchParams(data).toString();
    else opts.body = JSON.stringify(data);
  }
  const res = await fetch(API + path, opts);
  const result = await res.json();
  if (result.code === 401 && path !== '/api/user/login') {
    Store.clear();
    location.reload();
  }
  return result;
}

function toast(msg, type = 'info') {
  const container = document.querySelector('.toast-container') || (() => {
    const d = document.createElement('div');
    d.className = 'toast-container';
    document.body.appendChild(d);
    return d;
  })();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function showModal(id) { document.getElementById(id)?.classList.add('active'); }
function hideModal(id) { document.getElementById(id)?.classList.remove('active'); }
function closeAllModals() { document.querySelectorAll('.modal-mask.active').forEach(m => m.classList.remove('active')); }

function fmtMoney(v) { return '¥' + (Number(v) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function fmtCountdown(ms) {
  if (ms <= 0) return { done: true };
  const s = Math.floor(ms / 1000);
  return {
    done: false,
    d: Math.floor(s / 86400),
    h: String(Math.floor(s % 86400 / 3600)).padStart(2, '0'),
    m: String(Math.floor(s % 3600 / 60)).padStart(2, '0'),
    sec: String(s % 60).padStart(2, '0')
  };
}
function nftEmoji(seed) {
  const list = ['🎨','💎','🏆','🌸','🌊','🔥','🌟','🦄','🐉','👑','🌈','🎭','🗿','🏺','⚱️','🔮','📿','🖼️','💠','🎴'];
  let h = 0; for (const c of seed || 'x') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}
function statusBadge(status) {
  const map = {
    'ACTIVE': ['sale', '发售中'], 'COMPLETED': ['success', '已完成'], 'PAID': ['success', '已支付'],
    'PENDING': ['warning', '待处理'], 'PENDING_REVIEW': ['warning', '审核中'],
    'CANCELLED': ['danger', '已取消'], 'CLAIMED': ['success', '已领取'],
    'SOLD': ['success', '已售出'], 'TAKEDOWN': ['danger', '已下架'], 'GENESIS': ['info','创世']
  };
  const s = map[status] || ['muted', status];
  return `<span class="badge badge-${s[0]}">${s[1]}</span>`;
}
function typeBadge(type) {
  const map = {
    'MINT': ['info','铸造'], 'PRIMARY_SALE': ['success','发售'],
    'SECONDARY_TRADE': ['warning','二手'], 'GIFT': ['info','转赠'],
    'PRIMARY_BUY': ['success','首发购买'], 'SECONDARY_BUY': ['warning','二手购买']
  };
  const s = map[type] || ['muted', type];
  return `<span class="badge badge-${s[0]}">${s[1]}</span>`;
}
