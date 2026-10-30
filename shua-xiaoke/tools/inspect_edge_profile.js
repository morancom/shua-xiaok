'use strict';
/** 读取真实 Edge 配置里与本项目相关的扩展登记信息 */
const fs = require('fs');

const ud = 'C:\\Users\\l8107\\AppData\\Local\\Microsoft\\Edge\\User Data';
for (const f of ['Secure Preferences', 'Preferences']) {
  const p = `${ud}\\Default\\${f}`;
  if (!fs.existsSync(p)) { console.log(`[${f}] 不存在`); continue; }
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.log(`[${f}] 解析失败: ${e.message}`); continue; }
  const settings = j?.extensions?.settings || {};
  const hits = Object.entries(settings).filter(([, v]) => JSON.stringify(v || {}).includes('shua-xiaoke'));
  console.log(`\n=== ${f} ===`);
  console.log(`  扩展条目总数 = ${Object.keys(settings).length},命中本项目 = ${hits.length}`);
  for (const [id, v] of hits) {
    console.log(`  ID: ${id}`);
    console.log(`    path      = ${v.path}`);
    console.log(`    location  = ${v.location}  (4=已解压, 1=外部, 5=组件, 10=策略)`);
    console.log(`    state     = ${v.state}     (1=启用, 0=禁用)`);
    console.log(`    from_webstore = ${v.from_webstore}`);
    console.log(`    manifest.version = ${(v.manifest || {}).version}`);
    console.log(`    manifest.name    = ${(v.manifest || {}).name}`);
    if (v.disable_reasons) console.log(`    disable_reasons = ${JSON.stringify(v.disable_reasons)}`);
  }
  // 顺带看 protection/blocklist 里是否被禁
  const prot = j?.protection || {};
  if (JSON.stringify(prot).includes('shua-xiaoke')) console.log('  [注意] protection 段里出现了本项目');
}
