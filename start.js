const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 启动数字藏品交易系统...');
console.log('========================================');

const core = spawn('node', [path.join(__dirname, 'server/core.js')], {
  stdio: 'inherit',
  env: process.env
});

const web = spawn('node', [path.join(__dirname, 'server/web.js')], {
  stdio: 'inherit',
  env: process.env
});

core.on('error', (err) => {
  console.error('核心服务启动失败:', err);
});

web.on('error', (err) => {
  console.error('前端服务启动失败:', err);
});

process.on('SIGINT', () => {
  console.log('\n⏹️  正在关闭服务...');
  core.kill();
  web.kill();
  process.exit(0);
});

setTimeout(() => {
  console.log('\n========================================');
  console.log('✅ 系统启动完成！');
  console.log('📱 用户页面:   http://localhost:3671');
  console.log('🛡️  管理后台:  http://localhost:3671/admin');
  console.log('⚙️  核心API:   http://localhost:8671');
  console.log('----------------------------------------');
  console.log('👤 默认用户:  自行注册（赠送¥10,000体验金）');
  console.log('🔑 管理员:    admin / admin123');
  console.log('========================================\n');
}, 2000);
