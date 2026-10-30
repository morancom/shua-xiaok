'use strict';
/**
 * 生成所有 .bat 启动脚本。
 * 原因:cmd.exe 要求 CRLF 换行 + GBK 编码,直接手写很容易出现
 * 「双击一闪就退」(裸 LF)或「中文乱码 / 命令被吃掉」(UTF-8 编码)的问题。
 * 所有 bat 都从这里生成,保证换行与编码一致。
 *
 * 用法:node tools/build_bats.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 以 GBK + CRLF 写文件 */
function writeBat(name, lines) {
  const text = lines.join('\r\n') + '\r\n';
  const gbk = encodeGBK(text);
  fs.writeFileSync(path.join(ROOT, name), gbk);
  console.log(`  写入 ${name}  (${gbk.length} 字节, GBK + CRLF)`);
}

// --- 极简 GBK 编码器:覆盖这些脚本里用到的全部字符 ---
const GBK_TABLE = (() => {
  // 运行时用 Node 的 ICU 反查:遍历 GBK 双字节空间建立 unicode → gbk 映射
  const table = new Map();
  const dec = new TextDecoder('gbk');
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      const bytes = Uint8Array.from([hi, lo]);
      const ch = dec.decode(bytes);
      if (ch && ch.length === 1 && ch !== '\ufffd' && !table.has(ch)) table.set(ch, bytes);
    }
  }
  return table;
})();

function encodeGBK(text) {
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { out.push(code); continue; }
    const b = GBK_TABLE.get(ch);
    if (b) { out.push(b[0], b[1]); continue; }
    out.push(0x3f); // '?'
  }
  return Buffer.from(out);
}

// ---------------- 脚本内容 ----------------

const HEADER = (title) => [
  '@echo off',
  'chcp 936 >nul',
  `title ${title}`,
  'color 0B',
  'setlocal enabledelayedexpansion',
];

const CHECK_NODE = [
  'rem ---------- 检查 Node.js ----------',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo.',
  '  echo   [X] 没有找到 Node.js',
  '  echo       请先安装 LTS 版本: https://nodejs.org/',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  'for /f "delims=" %%v in (\'node -v\') do echo   [OK] Node.js %%v',
];

const SET_ROOT = [
  'rem ---------- 定位项目目录 ----------',
  'set "ROOT=%~dp0"',
  'if not exist "%ROOT%extension\\manifest.json" (',
  '  echo   [X] 没有找到 extension\\manifest.json,请确认解压完整。',
  '  pause',
  '  exit /b 1',
  ')',
  'if not exist "%ROOT%server\\server.js" (',
  '  echo   [X] 没有找到 server\\server.js,请确认解压完整。',
  '  pause',
  '  exit /b 1',
  ')',
];

const START_BACKEND = [
  'rem ---------- 启动本地后端 ----------',
  'set "PORT=3001"',
  'netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>nul',
  'if not errorlevel 1 (',
  '  echo   [OK] 后端已在运行  ^(端口 %PORT%^)',
  '  goto :backend_ready',
  ')',
  'echo   [*] 启动本地后端 ...',
  'start "刷小课后端" /min cmd /c node "%ROOT%server\\server.js"',
  '',
  'rem 等后端真正可用(最多 12 秒),不要盲等 3 秒就宣布成功',
  'set "WAITN=0"',
  ':wait_backend',
  'timeout /t 1 /nobreak >nul',
  'set /a WAITN+=1',
  'powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%PORT%/api/health).StatusCode|Out-Null;exit 0}catch{exit 1}" >nul 2>nul',
  'if not errorlevel 1 goto :backend_ok',
  'if %WAITN% lss 12 goto :wait_backend',
  '',
  'rem 12 秒还没起来 —— 把 server.log 的最后几行打出来,方便定位',
  'echo.',
  'echo   [X] 后端没有启动成功',
  'if exist "%ROOT%server\\server.log" (',
  '  echo   ---------- server\\server.log ^(最近 8 行^) ----------',
  '  powershell -NoProfile -Command "Get-Content -Tail 8 -Path \'%ROOT%server\\server.log\'" 2>nul',
  '  echo   ----------------------------------------------------',
  ')',
  'echo   常见原因:端口 %PORT% 被别的程序占用,或 Node.js 版本过低。',
  'echo.',
  'pause',
  'exit /b 1',
  '',
  ':backend_ok',
  'echo   [OK] 后端已启动  ^(http://127.0.0.1:%PORT%^)',
  ':backend_ready',
];

const WRITE_INSTALL_BAT = [
  ...HEADER('刷小课 - 一键安装'),
  'echo.',
  'echo   ==========================================',
  'echo     刷小课  -  本地刷课做题助手   一键安装',
  'echo   ==========================================',
  'echo.',
  ...CHECK_NODE,
  ...SET_ROOT,
  ...START_BACKEND,
  '',
  'rem ---------- 打开扩展管理页,引导一次性加载 ----------',
  'echo.',
  'echo   [*] 打开 Edge 扩展管理页 ...',
  'start "" "msedge.exe" "edge://extensions/"',
  'timeout /t 3 /nobreak >nul',
  'start "" "http://127.0.0.1:3001/ui"',
  '',
  'echo.',
  'echo   ==========================================',
  'echo    最后一步:在打开的扩展页里加载本扩展',
  'echo   ==========================================',
  'echo.',
  'echo    1. 打开右下角(或左上角)的「开发人员模式」开关',
  'echo    2. 点「加载解压缩的扩展」',
  'echo    3. 选择下面这个文件夹:',
  'echo       %ROOT%extension',
  'echo.',
  'echo    加载成功后,扩展会一直留在 Edge 里,',
  'echo    关掉浏览器再打开也不用重新加载。',
  'echo.',
  'echo   ------------------------------------------',
  'echo    用起来:',
  'echo      侧边栏快捷键   Ctrl+Shift+S',
  'echo      后端控制台     http://127.0.0.1:3001/ui',
  'echo      打开控制台     点扩展图标',
  'echo    超星 / 学习通 / 智慧树 / U校园 会自动弹出侧边栏',
  'echo   ------------------------------------------',
  'echo.',
  'echo  接真实模型:控制台 -^> 真实模型,填接口地址与 API Key。',
  'echo  不填也能跑,用内置演示答案。',
  'echo.',
  'echo  接下来会自动打开扩展页,请按上面 3 步操作。',
  'echo.',
  'pause',
  'exit /b 0',
];

const WRITE_START_BAT = [
  ...HEADER('刷小课 - 启动'),
  'echo.',
  'echo   ==========================================',
  'echo     刷小课  -  启动本地后端与控制台',
  'echo   ==========================================',
  'echo.',
  ...CHECK_NODE,
  ...SET_ROOT,
  ...START_BACKEND,
  'echo.',
  'echo   [*] 打开控制台 ...',
  'start "" "http://127.0.0.1:3001/ui"',
  'echo.',
  'echo   [OK] 已就绪',
  'echo        控制台  http://127.0.0.1:3001/ui',
  'echo        侧边栏  Ctrl+Shift+S',
  'echo.',
  'echo   这个窗口可以关掉,后端已在后台运行。',
  'echo   按任意键关闭此窗口 ...',
  'pause >nul',
  'exit /b 0',
];

const WRITE_AUTO_BAT = [
  ...HEADER('刷小课 - 一键启动(自动加载扩展)'),
  'echo.',
  'echo   ==========================================',
  'echo     刷小课  -  自动加载扩展并启动',
  'echo   ==========================================',
  'echo.',
  'echo   本方式会先关闭 Edge,再带着扩展重新启动。',
  'echo   若只想打开浏览器后再点扩展图标,请用「启动.bat」。',
  'echo.',
  ...CHECK_NODE,
  ...SET_ROOT,
  ...START_BACKEND,
  '',
  'rem ---------- 重启 Edge 并加载扩展 ----------',
  'echo.',
  'echo   [*] 先正常关闭 Edge(会保留标签页,下次自动恢复)...',
  'taskkill /im msedge.exe >nul 2>nul',
  'timeout /t 3 /nobreak >nul',
  'tasklist /fi "imagename eq msedge.exe" 2>nul | find /i "msedge.exe" >nul',
  'if not errorlevel 1 (',
  '  echo   [*] 仍在运行,强制关闭 ...',
  '  taskkill /im msedge.exe /f >nul 2>nul',
  '  timeout /t 2 /nobreak >nul',
  ')',
  'echo   [*] 带扩展启动 Edge(自动恢复上次标签页)...',
  'set "EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
  'if not exist "%EDGE%" set "EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
  'if not exist "%EDGE%" set "EDGE=msedge.exe"',
  'start "" "%EDGE%" --no-first-run --restore-last-session --load-extension="%ROOT%extension" "http://127.0.0.1:3001/ui"',
  'echo.',
  'echo   [OK] 已就绪',
  'echo        侧边栏  Ctrl+Shift+S  (打开目标网站会自动弹出)',
  'echo        控制台  http://127.0.0.1:3001/ui',
  'echo.',
  'echo   窗口不会自动关闭,方便你确认没有报错。',
  'echo   按任意键关闭此窗口 ...',
  'pause >nul',
  'exit /b 0',
];

const WRITE_STOP_BAT = [
  ...HEADER('刷小课 - 停止'),
  'echo.',
  'echo   [*] 停止本地后端 ...',
  'set "N=0"',
  'for /f "delims=" %%p in (\'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" ^| Where-Object { $_.CommandLine -like \'*server.js*\' } ^| ForEach-Object { $_.ProcessId }"\') do (',
  '  taskkill /pid %%p /f >nul 2>nul',
  '  set /a N+=1',
  ')',
  'if "!N!"=="0" (',
  '  echo   [OK] 没有正在运行的后端',
  ') else (',
  '  echo   [OK] 已停止 !N! 个后端进程',
  ')',
  'echo.',
  'echo   如需彻底移除扩展:打开 edge://extensions 点「移除」。',
  'echo.',
  'echo   按任意键关闭此窗口 ...',
  'pause >nul',
  'exit /b 0',
];

console.log('生成启动脚本:');
writeBat('install.bat', WRITE_INSTALL_BAT);
writeBat('启动.bat', WRITE_START_BAT);
writeBat('一键启动并加载扩展.bat', WRITE_AUTO_BAT);
writeBat('停止.bat', WRITE_STOP_BAT);
console.log('完成。');
