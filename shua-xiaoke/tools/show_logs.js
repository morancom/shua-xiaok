'use strict';
/** 看后端最近的日志,判断扩展是否真的在页面里跑起来了 */
(async () => {
  const j = await fetch('http://127.0.0.1:3001/api/state').then((r) => r.json());
  const logs = (j.logs || []).slice(-25);
  console.log(`日志总条数 = ${(j.logs || []).length},最近 ${logs.length} 条:`);
  for (const l of logs) {
    const t = l.time || l.at || '';
    console.log(`  [${t}] ${(l.site || l.tag || '')} ${l.task || ''} ${l.status || l.message || ''}`.trim());
  }
  const brush = (j.logs || []).filter((l) => /loaded|chaoxing|zhs|welearn|selftest/.test(JSON.stringify(l)));
  console.log(`\n与刷课脚本相关的条数 = ${brush.length}`);
  for (const b of brush.slice(-12)) console.log('  ', JSON.stringify(b));
})();
