'use strict';
/**
 * 打包「刷小课」为可分享 zip
 * 输出:dist/刷小课-<version>.zip
 * 内含:extension/(解压即装) + server/ + tools/ + 启动脚本 + README
 *
 * 注意:根目录的 .bat 由 tools/build_bats.js 统一生成(GBK + CRLF),
 * 这里只按字节原样复制,绝不在打包过程中重新编码 —— 二次编码会损坏中文。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, '刷小课');
// --no-key:出「无内置 key」的分享版 —— 默认 key 清空,对方必须在控制台填自己的。
const NO_KEY = process.argv.includes('--no-key');

// ---- 清理并准备(只清本版暂存目录,别把 dist 里另一个版本的 zip 删掉)----
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

function copyDir(src, dst, excludes = []) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludes.includes(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d, excludes);
    else fs.copyFileSync(s, d);
  }
}

// server/shots 是运行时截图(答题留证),不进包:既让包体从 1.2MB 掉回 ~200KB,
// 也避免把用户页面截图带给别人。
// data.json 里是发送者自己的设置/历史解题记录/模型密钥,绝对不能带给别人;
// server.log 是运行日志,同样不进包。
const EXCLUDES = ['data.json', 'bat_defs.json', 'dist', 'node_modules', 'shots', 'logs', 'server.log'];

console.log(`打包 刷小课 v${VERSION}`);
copyDir(path.join(ROOT, 'extension'), path.join(STAGE, 'extension'), EXCLUDES);
console.log('  ✓ extension');
copyDir(path.join(ROOT, 'server'), path.join(STAGE, 'server'), EXCLUDES);
console.log('  ✓ server');
// tools/ 全是开发期的探针/打包脚本和 mock 页,发给别人只会造成困惑,不进分享包。

// ---- 无 key 版:清空 server.js 里硬编码的默认 key ----
if (NO_KEY) {
  const srvPath = path.join(STAGE, 'server', 'server.js');
  const srv = fs.readFileSync(srvPath, 'utf8');
  const patched = srv.replace(
    /(const UPSTREAM_KEY = process\.env\.UPSTREAM_KEY \|\| ')[^']*(';)/,
    '$1$2'
  );
  if (patched === srv) throw new Error('无 key 版替换失败:server.js 里没找到 UPSTREAM_KEY 默认值');
  fs.writeFileSync(srvPath, patched, 'utf8');
  console.log('  ✓ 已清空内置默认 key(对方需在控制台填自己的)');
}

// ---- 启动脚本:按字节原样复制(已是 GBK + CRLF)----
const BATS = ['install.bat', '启动.bat', '一键启动并加载扩展.bat', '停止.bat'];
for (const name of BATS) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) throw new Error(`缺少启动脚本:${name}(先跑 node tools/build_bats.js)`);
  fs.copyFileSync(src, path.join(STAGE, name));
}
console.log(`  ✓ 启动脚本 ${BATS.length} 个`);

// ---- Mac / Linux 启动脚本 ----
const sh = `#!/usr/bin/env bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js,请先安装:https://nodejs.org/"
  exit 1
fi
echo "控制台:http://127.0.0.1:3001/ui"
node server/server.js
`;
fs.writeFileSync(path.join(STAGE, '启动.sh'), sh, 'utf8');

// ---- README ----
// 有 key 版 / 无 key 版只差第四节这三行说明。
const SEC4_TITLE = NO_KEY ? '## 四、填自己的模型 key(首次必做)' : '## 四、接自己的真实模型(可选)';
const SEC4_HEAD = NO_KEY
  ? '本包**没有内置 key**(出包人没有把额度分享出来)。第一次用请按下表填一次你自己的真实模型 key,不填则只有演示答案:'
  : '**包里已经预置了一个可用的 DeepSeek key,解压就能用真实 AI**,不用配置。\n如果不想共用(或想换成自己的额度),在下表里换成你自己的即可:';
const readme = `# 刷小课 · 使用说明

本地运行的刷课做题助手。视频自动播放 / 倍速 / 跳节、自动做题、AI 对话,
全部在你自己的电脑上跑,**不经过任何第三方服务器**,可免费分享。

---

## 一、准备(只需一次)

1. 安装 Node.js(LTS 版):<https://nodejs.org/>
2. 把本压缩包解压到任意目录(建议路径不含中文和空格)

## 二、安装(只需一次)

双击 **\`install.bat\`**,它会:

- 启动本地后端
- 打开 Edge 扩展管理页
- 在窗口里告诉你最后 3 步怎么做

按提示操作即可:

1. 打开「开发人员模式」开关
2. 点「加载解压缩的扩展」
3. 选择本目录下的 \`extension\` 文件夹

**加载成功后扩展会一直留在 Edge 里**,关掉浏览器再打开也不用重新加载。

> 不想手动点?直接双击 **\`一键启动并加载扩展.bat\`**,
> 它会关掉 Edge 再带着扩展重新启动,完全不用操作扩展页。
> 缺点是每次都得用这个脚本开浏览器。

## 三、日常使用

- **启动**:双击 \`启动.bat\`(或 \`一键启动并加载扩展.bat\`)
- **关闭后端**:双击 \`停止.bat\`
- **控制台**:<http://127.0.0.1:3001/ui>,看状态 / 改设置 / 测试解题
- **侧边栏**:任意网页按 \`Ctrl+Shift+S\`,或点工具栏扩展图标

打开超星 / 学习通 / 智慧树 / U校园 的课程页,扩展会自动接管:
视频倍速静音自动播放、看完自动跳下一节、弹题自动关闭、题目自动识别。
这些站点进入后侧边栏会自动弹出。

> **想要「做完自动交卷 + 自动跳下一节」**:打开控制台,把「自动提交」开关打开
> (默认是关的,防止误交)。其余开关默认已开。

${SEC4_TITLE}

${SEC4_HEAD}

1. 打开控制台 → 「真实模型(可选)」
2. 填 **OpenAI 兼容**接口的地址、API Key、模型名
   - 例:DeepSeek、通义千问、Kimi、Moonshot、本地 Ollama
   - DeepSeek 填:\`https://api.deepseek.com/v1/chat/completions\` + 你的 key + \`deepseek-chat\`
3. 点「保存模型配置」,状态徽章变绿即生效

> 输入框改了不会丢:**切走标签页会自动保存**,右侧也会显示「已保存 + 时间」。
> 点 👁 可以看清自己填的 key。

配置只保存在本机 \`server/data.json\`,不会上传。
也可以用环境变量覆盖:\`UPSTREAM_URL\` / \`UPSTREAM_KEY\` / \`UPSTREAM_MODEL\`。

## 五、自检(排错用)

浏览器打开 <http://127.0.0.1:3001/mock/chaoxing>,
这是一个模拟超星题型的测试页。按 \`Ctrl+Shift+S\` 打开侧边栏,点「自动做题」:

- 选项被自动选中、填空被自动填入 → 链路正常
- 侧边栏显示「当前页未识别到题目」→ 扩展没加载到该页,检查扩展是否已启用

## 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| 双击 bat 一闪就退 | 用记事本打开确认没被改成 UTF-8;重新解压本包 |
| 控制台打不开 / 侧边栏提示后端未启动 | 先跑 \`启动.bat\`,确认端口 3001 没被占用 |
| 装了扩展但课程页没反应 | 刷新页面;确认扩展已启用;看控制台「运行日志」 |
| 填完 key 又变回默认 | 旧版控制台的 bug(输入框被 3 秒轮询冲掉),本版已修;确认解压的是本版,刷新控制台页面 |
| 解题返回的是演示答案 | 正常,没配模型。按第四节接入 |
| 侧边栏「自动做题」提示非目标站点 | 该页没有刷课脚本,只在四个目标站点生效;用自检页验证 |

## 文件说明

\`\`\`
extension/          浏览器扩展(加载这个目录)
  manifest.json     扩展清单
  sw2.js             后台:转发解题/对话/日志
  engine.js         刷课引擎:倍速、跳节、识别题目、写回答案
  pageSubmit.js     点「提交」并处理弹窗(跨 frame)
  brush*.js         各平台适配(超星 / 智慧树 / U校园)
  sidebar.js/.css   侧边栏对话框
server/             本地后端(Node,零依赖)
  server.js         接口 + 静态页
  index.html/app.js/style.css  可视化控制台
install.bat         一键安装
启动.bat            启动后端并打开控制台
一键启动并加载扩展.bat  关 Edge → 带扩展重启(全自动)
停止.bat            停止后端
\`\`\`

## 说明

- 本工具仅供个人学习交流,请遵守所在学校及各平台的使用规定。
- 所有数据(设置、解题记录、模型密钥)只保存在你自己电脑上。
`;
fs.writeFileSync(path.join(STAGE, 'README.md'), readme, 'utf8');

// ---- 打包 ----
const zipName = `刷小课-${VERSION}${NO_KEY ? '-无key' : ''}.zip`;
const zipPath = path.join(DIST, zipName);
try {
  execSync(
    `powershell.exe -NoProfile -Command "Compress-Archive -Path '${STAGE.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force"`,
    { stdio: 'inherit' }
  );
} catch (e) {
  console.error('打包失败:', e.message);
  process.exit(1);
}

const size = fs.statSync(zipPath).size;
const sha = require('crypto').createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex').toUpperCase();
console.log(`打包完成:${zipPath} (${(size / 1024).toFixed(1)} KB)`);
console.log(`  sha256=${sha}`);
