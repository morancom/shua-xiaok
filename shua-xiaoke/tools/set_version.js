'use strict';
// 同步版本号:manifest.json + server/server.js 的 health version
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const ver = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(ver || '')) {
  console.error('用法: node tools/set_version.js 1.5.2');
  process.exit(1);
}

const mf = path.join(root, 'extension', 'manifest.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.version = ver;
fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');

const sf = path.join(root, 'server', 'server.js');
let s = fs.readFileSync(sf, 'utf8');
s = s.replace(/version: '\d+\.\d+\.\d+'/, "version: '" + ver + "'");
fs.writeFileSync(sf, s);

console.log('  manifest.version =', JSON.parse(fs.readFileSync(mf, 'utf8')).version);
const got = (fs.readFileSync(sf, 'utf8').match(/version: '(\d+\.\d+\.\d+)'/) || [])[1];
console.log('  server version    =', got);
