# 刷小课 · 记忆交接(截至 1.8.5,2026-10-25)

> 给下一个对话框用:先读这一份,再动手。项目路径 D:\answertole\shua-xiaoke,工作目录 D:\answertole。

## 0. 一句话现状
视频/文档任务点已跑通;作业页自动做题在**真实超星页还没验证通过**(最后卡在「后台脚本是旧的」+「双实例抢答」),1.8.5 刚把这些都改了,等真机验证。

## 1. 环境与常用命令
- 扩展(未打包,Edge 加载解压):`extension\`,service_worker = `sw2.js`
- 后端:零依赖 Node `server\server.js`,端口 **3001**;控制台 `/ui`;`/api/health`、`/api/state`(logs / solves / cxlogs)、`/api/solve`、`/api/settings`、`/api/shot`
- 当前版本 **1.8.5**,包 `dist\刷小课-1.8.5.zip`(179.5 KB)
- 起后端:`Start-Process node server\server.js -WorkingDirectory D:\answertole\shua-xiaoke -WindowStyle Hidden`
- 改版本:`node tools\set_version.js 1.8.6`(同时改 `extension\manifest.json` 的 version 和 `server\server.js` 里的 version 串)
- 打包:`node tools\package.js`;CHANGELOG 用 pwsh 写(顶部插入新节),**不要**用 node 模板字符串写含反引号的 markdown
- 探针(都会开临时 profile + CDP):`node tools\probe_work.js`(作业 18/18)、`node tools\probe_course.js`(视频 13/13)、`node tools\probe_doc.js`(文档 PASS)
- 跑探针前先杀残留:`Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match '_edge-course|_edge-work' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`

## 2. 用户红线(别违反)
- 必须用他**日常那个 Edge 和默认配置**,不要开临时 profile 去干活;临时 profile 只给探针用
- **不要反复 taskkill /f**,会丢超星登录态
- 讲中文;视觉证据 > 口头描述
- 最终形态:点一下就能用、能打包发朋友

## 3. 视频 / 文档任务点(1.6.x ~ 1.7.2,已验证)
- 「多视频来回跳」三个根因:①`endedOf` 用 src 去 query 比较,而一节课 3 个视频 src 去 query 后完全相同 → 去重表串味;②`all_frames` 让每个 iframe 各自 `localTick` 抢播放权;③`document.hidden=1` 时超星自己 pause,被记成「外部暂停」并触发熔断
- 修法:`pickVideoTask` 锁住正在播的 + 按「iframe 中心离视口中心最近」排序;tick 的 playing 守卫处理「已完成但还在播」;`endedAt` 用完整 src;stall 分支走 `tryPlay`;子帧让出 —— 顶层每 tick 写 DOM 属性 `data-sxk-top-tick`,`shouldDriveSelf()` 读它(15 秒新鲜度),跨源拿不到就自救
- `taskFinished(t)` 改成**以播放器为准**:`dur>0` 且(`ended` 或 `cur>=dur-1` 或 `cur/dur>=0.995`)才算完成;`dur=0`(元数据没加载)绝不算完成
- **熔断机制已整套删除**:`stop()` 只记日志;tick 里没有 stopped 闸门;`tryPlay` 不再因重试次数停止;加载时清掉历史 `sxk_cx_cooldown_until`
- 文档型任务点:`isDocTask` / `driveDoc` / `scrollDocOnce`;拖动方式 = **一次 `scrollTop = scrollHeight` 直接到底**(用户明确要求不要一帧一帧滚),补发 `scroll`+`wheel` 事件;找不到滚动容器时用 `elementFromPoint` 补发滚轮 + PageDown
- 文档完成判定:**只认「我们先拖到底之后 1.2 秒才出现的 `.ans-job-finished`」**——超星会给没看的文档任务点**预挂**完成类,认了就会秒跳节(踩过);45 秒等不到标记就从头再拖一遍

## 4. 侧边栏 / 作业自动做题(1.8.0 ~ 1.8.5)
- 控制台设置搬到侧边栏 `.sxk-settings`,实时双向:`SET_SETTINGS` → `/api/settings` → `broadcastSettings()` → 页面 `SETTINGS_CHANGED`;侧边栏每 3 秒回读一次
- 作业自动做题:`engine.watchAutoAnswer(tag)` 每 6 秒一轮 + 启动 2 秒跑一次;`looksLikeWorkPage()` 判定(`/work|exam|quiz/`、`doHomeWorkNew|workId=|examId=|selectWorkQuestion`、或页面出现 `.TiMu/.questionLi/.Zy_TItle/.examPaper_question`);`answerPass(tag)` 逐题解 → 逐题写回
- **1.8.3 的重大修正**:超星整页外层容器 `.fanyaMarking` 也带 `.TiMu` 类 → 以前把「整页」当成「1 道题」(选项 60 个)。修法:`qContainers` 只留**最内层**(凡包含另一个题目容器的节点一律丢弃);`optsIn` 只认 `li / label / 内部带 input 或 img` 的元素(排除 `i.num_option` 这种字母标)
- 图:题干图 + 选项图一起发,带 `【图片对照】图1=题干;图2=选项A…`,免得模型猜;图片获取三条通道(页面 fetch 带 cookie → 扩展 SW `FETCH_IMG` 带 host 权限绕 CORS → 后端下载)
- 截图搜题(`CAPTURE_RECT`,sw2 里用 OffscreenCanvas 裁剪):**截图前先把标签页/窗口抬到最前、等 260ms**;截完算平均亮度,**<110 判「截图不可信」**(窗口被挡时会截到别的程序的深色界面)
- 粘贴图片:sidebar 监听 `paste`,取 clipboardData 里的 `image/*` → dataURL → `SOLVE {images}`;发完立刻清掉「已粘贴 1 张图片」
- 服务端 `solveQuestion`:支持 `images`(dataURL 或 http 远程图,限 4 张/3MB);`ANSWER_RULES` 约定——选择题只回字母、填空只回答案、不确定时也要给最可能的答案
- **1.8.5(刚做,未真机验证)**:
  - 截图只在「整题是图」或「选项一个字都没有」时才做;普通文字题不截
  - 同一题最多试 **2 次**,试满放弃并记日志;每道题前复查 `settings.autoAnswer`,关掉立刻停手
  - `chrome.storage` 做 60 秒占位 `sxk_claim`:顶层和 iframe 两个实例不再同时解同一题(这就是「先选 D 又改成 C」的根因)
  - 选择题点完读不到选中状态 → 返回失败(有限重试),不再假装成功
  - `tools\probe_work.js` **18/18**:6 题全识别、全作答、答案 6/6 正确、截图搜题正常、粘贴图片正常

## 5. 卡住的地方 / 下一步
最后一份真机日志(1.8.4,12:07 前后)显示三件事:
1. 每道题都 `shot-fail ... unknown type=CAPTURE_RECT keys=type,rect,dpr bgv=1.8.4` —— 这是 **sw2.js 落到 default 分支**,说明 Edge 跑的是**旧的后台脚本**(未打包扩展的 SW 缓存)。解决:把扩展**关闭再启用**(不是点刷新),再 F5。1.8.5 已让普通题不再走截图,但 SW 旧代码还会影响别的 case。
2. 同一道题 1 秒内出现**两条 solve**(同题干同答案)——双实例抢答,1.8.5 用 claim 修了
3. `04:08:49` 有一次 startup v1.8.4;之后 `settings.autoAnswer=false`(用户把自动做题关了),所以不再解题 —— 用 `GET /api/state` 看 settings 就能确认

**下一步要验证的**:1.8.5 在真实作业页逐题作答;看日志这四条:
- `work-dom` 的「识题 N 道」(他那个作业是 20 道)
- `没选上(第 N 次)`
- `试满 2 次仍没选上`
- `另一个实例正在做,跳过`

**待定功能**:`autoSubmit`(做完自动提交)还没实现,用户没拍板;播放倍速用户用 2x。

## 6. 踩坑清单(省下一个对话框两小时)
- **残留 Edge 进程会骗你**:探针 profile 没退干净,新探针会连到旧进程、加载旧扩展代码,表现为「改了不生效」。跑探针前先杀匹配 `_edge-course|_edge-work` 的 msedge(只杀这些,别动用户的)
- 跨 frame 的状态**不能放 window 属性**(每个 frame 独立隔离世界),要用 DOM 属性(`documentElement.setAttribute`)
- mock 页模板字符串里 JS 不能出现反引号和 `${`
- 超星会给未完成的视频/文档任务点**预挂** `.ans-job-finished`,完成判定必须「自证」
- `chrome.tabs.captureVisibleTab` 在窗口被遮挡时会截到屏幕上别的程序 → 抬窗口 + 亮度校验
- 用户真实的作业页会被反爬墙(`antispiderShowVerify.ac` / `passport2.chaoxing.com`)挡成登录页,这种页面没有题目可提取,先让他手动过验证

## 7. 关键文件
- `extension\cx.js` 超星课程页驱动(视频/文档/跳节),约 1200 行
- `extension\engine.js` 共享引擎(识题/解题/写回/设置同步)
- `extension\sw2.js` service worker(消息路由:SOLVE / SET_SETTINGS / CAPTURE_RECT / FETCH_IMG / CAPTURE_TAB …)
- `extension\sidebar.js` / `sidebar.css` 侧边栏(设置、截图搜题、粘图、对话)
- `extension\brush.js` 超星内容脚本入口(调 `SXK.startSettingsSync()` + `SXK.watchAutoAnswer('chaoxing')`)
- `server\server.js` 后端 + mock 页(`/mock/chaoxing`、`/mock/course`、`/mock/workimg`、`/mock/doc`)
- `tools\probe_work.js` / `probe_course.js` / `probe_doc.js` 自检探针
