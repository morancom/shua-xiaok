'use strict';
/**
 * 打开 Edge「开发者模式」(extensions.ui.developer_mode = true)
 * 用法:node tools/enable_devmode.js
 * 说明:Edge 关闭时才能改;改完重启 Edge 生效。
 */
const fs = require('fs');
const path = require('path');

const prefPath = path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft',
  'Edge',
  'User Data',
  'Default',
  'Preferences'
);

if (!fs.existsSync(prefPath)) {
  console.error('找不到 Preferences:', prefPath);
  process.exit(1);
}

const raw = fs.readFileSync(prefPath, 'utf8');
const j = JSON.parse(raw);
j.extensions = j.extensions || {};
j.extensions.ui = j.extensions.ui || {};
console.log('  修改前 developer_mode =', j.extensions.ui.developer_mode);
j.extensions.ui.developer_mode = true;
fs.writeFileSync(prefPath, JSON.stringify(j), 'utf8');
console.log('  修改后 developer_mode = true');
console.log('  文件大小 =', Math.round(fs.statSync(prefPath).size / 1024), 'KB');
