const express = require('express');
const path = require('path');
const cors = require('cors');
const CONFIG = require('../config');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.listen(CONFIG.PORTS.WEB, () => {
  console.log(`🌐 前端服务已启动: http://localhost:${CONFIG.PORTS.WEB}`);
  console.log(`📊 后台管理: http://localhost:${CONFIG.PORTS.WEB}/admin`);
  console.log(`⚙️  核心API:  http://localhost:${CONFIG.PORTS.CORE}`);
});

module.exports = app;
