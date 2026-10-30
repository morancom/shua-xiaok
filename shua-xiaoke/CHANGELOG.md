## 1.8.17 (当前版本)
- 新增**智慧树学习页**适配(studyvideoh5 / studyh5 / studywenda)。此前 manifest 只匹配 `onlineweb.zhihuishu.com`(课程列表页),真正播放课程的学习页 `studyvideoh5.zhihuishu.com/stuStudy` **完全没有刷课脚本**,侧边栏虽在、却不刷课。
- `extension\brush-zhs5.js`(新):递归扫「自己 + 同源 iframe(最多两层)」的 `<video>` → 静音 + 倍速(读控制台设置)+ 自动播放;每 15 秒一条进度心跳(`adv`/`STUCK` 区分真播与卡住);只点**无害按钮**(继续学习/我知道了/关闭/下一集…),且必须处在「像弹层」的祖先里才点,绝不碰提交/交卷/删除;视频播完(`ended` 或 `currentTime >= duration-1.5` 且 `duration>30`)自动点「下一集/下一节/下一章/下一课」,一分钟一次防连点。
- 播放器在**跨域 iframe** 里时:子帧播完用 `postMessage({type:'SXK_ZHS_NEXT'})` 请顶层点下一集,顶层校验来源域名(只认 `*.zhihuishu.com` 与本地测试 host),避免任意站点触发点击。
- 首版自带一次性结构诊断 `zhs5-dom`:打印 docs/videos 明细(video 的 id/class/src/dur/cur/paused/rate + 往上 4 层祖先)、候选按钮文案与选择器(弹层内的标 `@ovl`)、可见弹层选择器、页面文本前 240 字 —— 用来对齐智慧树真实 DOM 再迭代。
- 修一个隐蔽 bug:`settings` 是 `engine.js` 里 IIFE 的闭包私有变量,新脚本直接引用会抛 `ReferenceError` 并被 `try{}` 吞掉(外部表现:不静音、不倍速、不播放)→ 改为走 `SXK.getSettings()`。
- 回归(DSH 内置 Chromium):`tools\mock-zhs5.html` PASS(muted / 2x / 正在播 / 关掉弹题 / 点下一集);`tools\mock-zhs5-xframe.html` PASS(跨域 iframe 播完 → 顶层收到请求并点下一集);`tools\mock-old-work.html` PASS(`pageSubmit` 旧功能未受影响)。
- 包:`dist\刷小课-1.8.17.zip` 148,657B、`dist\刷小课-1.8.17-无key.zip` 148,617B。

## 1.8.16 (当前版本)
- 修控制台「填完 API Key 切出去再回来又变回默认值」:控制台每 3 秒轮询 `/api/state` 重画页面,`render()` 无条件把三个上游输入框写回服务端里的旧值 ⇒ 正在输入/刚粘贴的 key 每 3 秒被冲掉,根本没机会保存(用户现象:填完 key 切出去复制个网址,回来又是默认值)。
- 现在有「脏值保护」:输入框聚焦中或有未保存改动时,轮询不再覆盖;`input` 事件标记未保存并显示黄色提示;切标签页 / 切窗口 / 关页面(`visibilitychange` / `blur` / `pagehide`)自动把改动 `POST /api/settings`(`keepalive`);新增「👁 显示/隐藏密钥」和「已保存 + 时间 · 当前:真实模型/演示模式」提示。
- 倍速滑块同样加了「拖动中不被轮询打断」的保护。
- 另出**无 key 版** `dist\刷小课-1.8.16-无key.zip`(144,616B):`node tools\package.js --no-key` 会把 `server.js` 里硬编码的默认 key 清空(`UPSTREAM_KEY || ''`),README 第四节改成「填自己的模型 key(首次必做)」;对方不填就只有演示答案,不再消耗出包人的额度。已验证该包在 3012 端口独立启动:`/api/health` 返回 `upstream:false`、`/api/state` 的 `upstreamKey` 长度 0、`/ui` 200。
- 打包:`tools\package.js` 不再带 `tools/`、`server.log`、`data.json`、`shots/`;`dist\刷小课-1.8.16.zip` **141KB / 32 条目**(1.8.15 是 223KB),README 补「包内已预置可用 key,解压即用」「切走自动保存」两条。
- 验证:`/ui` 输入 `sk-probe-…` → 等 5 秒(轮询 1.7 轮)值仍在 → 触发 `blur` 后 `server\data.json` 已落盘 → 刷新页面输入框仍是新值(修前必然回到默认 key)。

## 1.8.15
- 修「目录已打勾但播放器没播过 ⇒ 永远不往后刷」死锁:`taskFinished()` 以播放器为准(`duration=0` 一律未完成),而 tick 的「目录当前节已完成」分支被视频安全网拦下后仍 `return` → 既不播也不跳。
- 现在 `catalogCurrentCompleted()` 让「目录打勾」作为服务端进度权威(整节任务点算完成);被拦下时继续往下驱动视频;新增 `skipPastCompleted()` 一次跨过连续已完成的节;`cx-jump` 日志去抖(15 秒一条,100 秒 92 条 → 7 条)。
- 验证:`tools\mock-video-done.html` PASS、`?skip=1` SKIP-PASS、`?nocat=1` 不跳(证明解锁的是目录勾而不是拆掉安全网)。

## 1.8.14
- 修「自动提交在真机不触发」:`watchAutoSubmit` / `watchQuizIdle` 带 `window.top !== window` 门槛,而真机的题目和「提交」在深层 iframe ⇒ 只在顶层跑等于没跑。
- 现在任何 frame 都能提交;`claimSubmit(href)` 用 `chrome.storage.local` 的 `sxk_submit` 做 90 秒占位防重复;子帧用 `SXK_JUMP_REQUEST` → 后台 → 顶层 `SXK_JUMP_NEXT` 代跳。
- 兜底时钟从 `lastAnswerAt` 改成「已答数量多久没变化」(12 秒):答题器每 6 秒空转不再喂饱它,真机图片题答不出来也能兜底。
- 验证:`tools\mock-frame-submit.html` answered/idle 双 PASS;旧 5 个 mock 全部回归 PASS。

## 1.8.13
- 提交按钮与确认框的真实 DOM:`a.btnSubmit.workBtnIndex`(a 锚点,不是 button)+ `div.Alertcon2#confirmWin`;旧 `pageSubmit()` 只认 `.maskDiv/.layui-layer/.dialog`,因此点不掉确认框。
- 抽出共享 `extension\pageSubmit.js`(sw2 用 `importScripts` 引入,删掉内联副本):先按硬选择器找提交按钮,再按文字兜底;扫 self/top/parent/同源 iframe 找确认框(`dialogFrame`);`why/near` 字段可直接看出失败原因。
- `looksLikeWorkPage()` 加 `extractQuestions()` 兜底(嵌套 iframe 也认);`optsIn` 支持从 radio/checkbox 反推选项行(纯图片选项题不再被误判「没作答」)。

## 1.8.12 (历史)
- 修「10 秒兜底在真机不触发」:1.8.11 把 `answerBusy` 当作门槛,但真实页面一次 `SOLVE` 请求可能挂住很久,`answerBusy` 一直是 true,兜底永远等不到。
- 现在 `watchQuizIdle` 不再被整个答题批次挡住,只看「最后一次真正开始处理题目」的时间;每道题开始处理时刷新 `lastAnswerAt`,连续 10 秒没有新题开始就直接兜底。
- 长请求/挂住的 `SOLVE` 不会再让下一节永久卡死;提交和下一节仍走 `jumpNextOnce` 8 秒去重。
- 启动时新增 `quiz-idle:监控启动 autoAnswer=... autoSubmit=... autoJump=...`,刷新后日志里能直接确认是否新脚本。
- 验证:`tools\mock-idle-hung.html`(SOLVE 永不返回)19 秒后 PASS,日志 `已 12 秒无新作答` → `chaoxing-jump:clicked`,`nextClicks=1`。

## 1.8.11
- 加「题目做完 10 秒兜底」:识别到题目后,连续 10 秒没有新的作答动作(不要求每道题都有答案,允许空题),就认为本轮做完了。
- 兜底时如果「自动提交」开着,先强制提交一次(允许空题),提交触发后 3 秒再点「下一节」;没开自动提交则直接点「下一节」。
- 兜底只在作业/章节测验页、`autoAnswer` 开着、且当前没有答题任务在跑时触发;考试页跳过。
- 提交和兜底都走 `jumpNextOnce`,8 秒内同一页只点一次下一节,避免连跳两节。
- 验证:mock 页面 1 道已答 + 1 道空题,10 秒后 PASS:`quiz-idle` → 强制提交 → `chaoxing-jump clicked` → `nextClicks=1`。

## 1.8.10
- 修「章节测验/作业页明明有下一节却不跳」:真机 1.1.6 章节测验2 的 `#prevNextFocusNext`(以及「上一节」)在 `#iframe` 里面,顶层 `document.querySelector` 永远找不到。现在 `jumpNext` 和 `chaoxingJumpNext` 都会遍历顶层 + `#iframe` + 内层 iframe,并按可见文字「下一节」兜底。
- 自动提交成功后自动推进:`autoSubmit` 成功且「自动跳节」开着时,延迟 3 秒再点一次下一节,覆盖「提交后停在原地」的情况;日志写 `提交后已点下一节` / `提交后没找到下一节按钮`。
- 修「提交」按钮识别:真实按钮是 `button.btnSubmit.workBtnIndex`(文字「提交」),已在 iframe 内由 `allFrames` 主世界脚本命中。

## 1.8.9
- 落实「自动提交」:侧边栏/控制台的 `autoSubmit` 开关现在真正生效。只在作业/章节测验页(考试页跳过)且 `autoAnswer` 也开着时工作;必须先识别出所有题都已作答,提交前 4 秒再复核一次,避免漏题就交。
- 提交按钮由后台在主世界执行查找:按文字匹配「提交/提交作业/交卷/提交答案」,排除暂存/保存/取消,取页面最靠下的最终提交;点击前临时把 `window.confirm` 覆盖为 `true`,避免原生确认框把页面卡住;点击后再尝试点自定义弹窗里的「确定/确认」。
- 提交日志写入后端 `auto-submit` 任务:会记录「还有 N 题没作答,先不提交」「全部 N 题已作答,准备提交」「已触发提交」或失败原因。
- 默认仍 `autoSubmit=false`,避免误交。

## 1.8.8
- 修「PDF 文档任务永远不跳」:真机 PDF 阅读器的内容在它自己的 viewer 里,插件把外层滚到 100% 后超星也可能一直不落 `.ans-job-finished`、目录也不打勾(实测已等 16 分钟)。现在文档滚到底 10 秒仍没有完成标记,就按「已读」推进下一节,不再把整门课卡死。
- 顶层再加一道同样的 10 秒兜底,防止 `docJumped` 只存在于某个 iframe 的 content script 里、顶层拿不到。

## 1.8.7
- 学习页跳节:顶层直接看左侧目录 `icon_Completed`,当前节已打勾就推进下一节;不再依赖 iframe 里的 taskFinished 去发现目录完成(cx.js 在 iframe 里拿不到目录,这是新版卡住的主因)。
- 修「填空题写不进去」:超星旧版 doHomeWorkNew 的填空/简答是 UEditor(隐藏 textarea + `ueditor_N` iframe),只改 textarea.value 不会更新编辑器正文。现在优先向 iframe body 插入文本并同步隐藏域,同时兼容普通 input/textarea/contenteditable。
- 写入普通输入框改用原型 value setter + InputEvent/change/keyup,避免被 Vue 等框架回滚。
- 填空题已写入的题不再重复作答(按 iframe/textarea/contenteditable 是否有内容判断),防止把已填答案覆盖。
- 模型把题干/分析当答案返回时(如「题目要求...」「这看起来是乱码...」)丢弃,不写进输入框。
- 选择题/图片题截图在题目容器被裁切时回退到整页可见区域,至少让模型看到真实字形。

## 1.8.6 (当前版本)
- 修「学习页不能继续下一节」:新版 studentstudy 的 `#prevNextFocusNext` 实际是切换任务标签(PPT/教材/视频),旧代码只看 `location.href` 是否变化,切标签被误判空跳,两次后停止。现在按 `#dct1/#dct2/#dct3` 的 active class 逐个推进任务标签;最后一个标签完成后再点左侧目录下一节。
- 目录跳节加固:真机上合成 click 可能不触发平台的 `getTeacherAjax`;目录点击 3 秒后地址仍未变化时,读取目录项 `onclick` 里的 chapterId,直接改 studentstudy URL 跳转。
- 文档任务完成判定识别左侧目录的 `span.icon_Completed` / 「已完成」:真机 PDF 播放/滚动完后 iframe 里不一定出现 `.ans-job-finished`,旧逻辑会干等 100 多秒;现在目录已标完成就直接推进。
- 诊断日志增加「任务标签」「当前/下一目录」「目录 DOM」「目录完成」,便于真机排错。
- 自动做题适配新版 mooc2 作业页:选项是 `.stem_answer .answerBg`(不是 input+label),按 `/mooc-ans/mooc2/work/dowork` 路径识别,点击选项行后回读 `.num_option`/`.num_option_dx` 的 `check_answer`/`check_answer_dx` 与 hidden `answer<qid>`;题干不再混入选项文字,选项图不再被误当题干图。

## 1.8.5 (当前版本)
- 「控制台一直出现截图搜题」:以前只要选项文字短(判断题的对/错)就每题都去截屏,现在只有「整题就是一张图」或「选项里一个字都没有」才截;普通文字题一律不截。
- 「后台一直在解题停不下来」:同一道题最多试 2 次,试满就记录并放弃,不再 6 秒一轮无限重试;自动做题每道题前都复查开关,侧边栏/控制台一关立刻停手。
- 「选了 D 又改成 C」:顶层内容脚本和 iframe 里的内容脚本会同时看到同一道题、各自解一遍。现在用 chrome.storage 做 60 秒占位,同一道题只允许一个实例作答。
- 「点完不知道有没有选上」:选择题点完读不到选中状态就不再假装成功,改为有限重试并写日志(以前会锁成已完成但页面上其实没选)。

## 1.8.4 (当前版本)
- 修「截图搜题拿到别的程序的界面」:窗口被遮住时 captureVisibleTab 会截到屏幕那块区域(实测拿到深色背景的另一程序画面,亮度 40 左右),模型看着这种图只能瞎猜。现在截图前先把标签页/窗口抬到最前,等 260ms 再抓;抓完算平均亮度,低于 110 直接判「截图不可信」并回退到取选项图片 URL。
- mock 作业页改成跟超星真实结构一致(外层容器也挂 .TiMu 的嵌套结构),这样「只识别到 1 道题」这类回归能被自检抓到,不会再在真机上才发现。

# 刷小课 · 更新日志

## 1.8.3 (当前版本)

**只答第一题的真凶找到了:整份作业被当成 1 道题;选项图也终于送进模型**

### 1. 只答第一题(核心)
- 真机日志:`work-dom 识题 1 道 | hit=21 | #0 cls=fanyaMarking TiMu ... opts=60 imgs=33`。
- 超星作业页整页 wrapper `#fanyaMarking` **也带 `.TiMu`**,它把 20 道题全包住;旧逻辑「去掉被包含的节点」正好把 20 道真题过滤掉、只留下 wrapper → 整份作业 = 1 道题,于是只回一个字母,套在第 1 题的选项上,后面 19 题永远不动。
- 改成取「最内层」容器:凡是包含其它题目容器的节点一律丢弃,再要求容器里有单选/复选/填空/选项列表。识别数从 1 → 20。

### 2. 选项图丢失(答案瞎猜的根因)
- `[class*="option"]` 会把 `<i class="num_option">A.</i>` 这种字母标记也算成选项 → 选项元素变成「只有字母没有图」的 i,`imgs=0`。
- 现在只认 `li/label` 或内部带 input/img 的元素;重新识别后选项图、题干图都能拿到。
- 图片转 dataURL 加了后台兜底:`FETCH_IMG` 走扩展 fetch(host 权限绕开 CORS),页面内 fetch 失败也能拿到图;都失败才把 URL 交给后端,并记 `img-fail`。
- 发图时带「图片对照」:图1=题干、图2=选项A……模型不用再猜哪张图对应哪一项。
- 单题最多 6 张图(题干 2 + 选项 4),后端上限 4 → 6。

### 3. 不再把选好的答案改掉
- 同一道题按**元素身份**只答一次;
- 每轮开跑前先检查该题有没有已选中的 input,有就跳过(刷新回填的也不会被改);
- 点完会验证是否真的选中(`stuck`),没选中再点一次 li;日志里会标 `/没选上`。
- 一题一题来(间隔 700ms),20 题约 2 分钟答完。

### 4. 自检
- `tools/probe_work.js` 18/18:新增「复刻超星 wrapper 结构的 6 题作业页」——6 题全识别、6 题全作答、6/6 答案正确、图片选项题(三张图里挑二次函数)选对 B。
- `tools/probe_course.js` 13/13:视频链路未受影响。

## 1.8.2 (当前版本)

**按钮区重排、答题不再「选了又取消」、粘贴图片实测可用、提示不残留**

### 1. 侧边栏只留一个「自动做题」
- 删掉了 `.sxk-actions` 里那个「✓ 自动做题」(和清空对话/控制台/诊断日志同一层的那个),现在只有设置区那一行开关和悬浮球上的入口。
- 剩下四个按钮排成 2×2 网格(清空对话 / 控制台 / 诊断日志 / 截图搜题),等宽等高,截图搜题单独高亮。

### 2. 「选了 C 又被取消」的真因
- 以前按「题干+选项文字」去重,超星的题干文字会随选中态变化(序号、勾选标记),指纹一变就当成新题再做一次 → 第二次答成别的字母,把 C 取消掉,还可能落进填空分支把答案打进输入框。
- 现在按**元素身份**(WeakSet)去重:同一道题只答一次,答完就记在元素上。
- 点选项改成点「用户真的会点的位置」(label / a / li),再确认 radio.checked,不再直接点隐藏的 input。
- 新增护栏:只要这题有选项元素,就**绝不走填空分支**,杜绝「选择题答案被写进输入框」。

### 3. 截图搜题的权限提示
- 现在会先检查 `chrome.permissions.contains({origins:['<all_urls>']})`;没拿到就直接返回:「扩展还没拿到『在所有网站上读取数据』的权限。请到 edge://extensions 把『刷小课』关掉再打开(不是只点刷新),弹权限提示时点允许。」
- 这正是他那边「依旧报错」的原因:host 权限只在**重新启用扩展**时才重新申请,只点刷新不会。

### 4. 粘贴图片 → AI
- 实测链路:粘贴 → 缩略图 → Enter → 后台 → /api/chat(带 images)→ 视觉模型。自检图里写 4726,AI 回的正是 4726。
- 发送后状态栏立刻清空(以前「已粘贴 1 张图,Enter 发送」会一直挂着)。

### 5. 自检
probe_work.js 14/14:选择题/填空自动作答、侧边栏 4 行开关、2x 实时、图片选项页 3 题、题干是图片的题、截图搜题不报错、粘贴图缩略图、AI 读出 4726。

## 1.8.1 (当前版本)

**作业页能真答题了:图片题干、图片选项、截图报错、粘贴截图、答案格式**

用户反馈:作业页依旧不答题、截图功能报错、侧边栏输入框不能粘贴截图、希望 AI 只给答案。

### 1. 截图报错的真因
日志里抓到的是浏览器的原话:`Either the '<all_urls>' or 'activeTab' permission is required`。
`chrome.tabs.captureVisibleTab` 在 MV3 里必须有 `activeTab`(用户点扩展图标那一刻才给)或 `host_permissions` 里有 `<all_urls>`。
manifest 的 host_permissions 原来只有 127.0.0.1:3001,所以一直失败。
现在补上 `<all_urls>`;并且截图失败时会把浏览器的原始错误原样显示出来(以前只有一句「截图失败」)。

### 2. 题干/选项是图片也能做
- 题干提取重写(stemOf):按 `.Zy_TItle / .questionTxt / .mark_name / [class*=stem]` 逐个取候选,再扣掉选项文字,挑「最像题干」的那段。
- 整题只有图片时,文字只剩 A B C D,标记为 `imgOnly`,照样送模型。
- 图片在页面内用 `fetch(credentials:'include')` 转 dataURL(超星的图在本域,后端抓会 403),转不了才把 URL 交给后端。
- 实测:新 mock 页第 3 题「题干只有一张图」,自动选中 A(模型从图上读出了题目)。

### 3. 侧边栏输入框支持 Ctrl+V 粘贴截图
- 粘贴的图会出现在输入框上方(带 × 可删),回车连图一起发。
- 截图失败时会直接提示「改用 Ctrl+V 粘图,效果一样」。

### 4. AI 只给答案的格式约定
- 解题(/api/solve):系统提示改成硬性约定 —— 选择题只回选项字母(单选 B,多选 ACD),判断题回 对/错,填空题只回内容(多空用 | 分隔),不要「答案:」前缀、不要解释。
- 服务端再加一道 normalizeAnswerResult:模型若回了整句(如「正确答案是 B」或把选项内容抄回来),会被收敛成字母。
- 对话(/api/chat):同样约定,但只在「用户发的是题目/题目截图」时生效,闲聊不受影响。

### 5. 作业页 DOM 一次性体检
- 每个作业页第一次自动做题时,把识别到的题目容器 + outerHTML 片段写进诊断日志(`work-dom` 行),以后真实页提取不准时,看这一行就知道选择器差在哪。

### 6. 自检
- probe_work.js 12/12:选择题自动选、填空自动填、侧边栏 4 行开关、点 2x 后端立刻变、后端改 1x 侧边栏同步、图片选项页 3 题全选中、题干是图片的题也答了、截图搜题不报错。
- probe_course.js 13/13 视频回归未受影响。

## 1.8.0

**作业页不再一片安静、设置搬到侧边栏、截图与图片题都能做了**

用户反馈三件事:①控制台里的刷课开关挪到侧边栏并且要实时;②停在作业界面但插件不自动做题;③侧边栏不能提交截图,所以截图搜题无效;另外超星选择题的选项常常是图片。

### 1. 侧边栏内置「刷课设置」,与控制台共用一份数据
- 面板里新增「刷课设置」区:自动播放 / 自动跳节 / 自动做题 三个开关 + 倍速 1x / 1.5x / 2x。
- 改完立刻 POST /api/settings,再由 background 广播 SETTINGS_CHANGED 给所有标签页 → 课程页当场生效,不用刷新。
- 反向也实时:面板开着时每 3 秒回读后端,控制台改了这边跟着变;内容脚本每 6 秒兜底回读一次。
- 新增 background 消息:SET_SETTINGS、CAPTURE_TAB。

### 2. 作业/测验页「打开就自动做题」
- 根因:以前只注册了 AUTO_ANSWER 监听,必须有人点侧边栏按钮才会动,作业页打开后什么都不会发生。
- 现在 engine.js 新增 watchAutoAnswer(tag):looksLikeWorkPage() 命中(/work|/exam|/quiz、doHomeWorkNew、顶层或 #iframe 里出现 .TiMu/.questionLi/.Zy_TItle)就每 6 秒跑一轮 answerPass()。
- 同一道题只做一次(题干+选项指纹去重),不会反复重解烧 token。

### 3. 截图搜题真的能用了
- 侧边栏新增「截图搜题」:截图前先把面板临时隐藏 → chrome.tabs.captureVisibleTab 抓当前可见画面 → 走 /api/solve 交给视觉模型识别题干与选项再作答,答案直接出现在对话气泡里。
- 顺带确认上游 deepseek-flash 支持图片输入(实测把写着 A/B 的截图读成 "AB",1.3 秒返回)。

### 4. 选项是图片的选择题
- extractQuestions 现在记录每个选项元素本身和字母(没有文字时按位置补 A/B/C),并把题干图/选项图的 URL 一起带上。
- applyAnswer 优先用这份选项表点击,所以「选项只有一张图」也能选中。
- 跨域图片(cdn 上的)在页面里 canvas 取不到,统一交给后端下载再转 base64 送模型。
- 后端 /api/solve 支持 images 数组:dataURL 直接用,http(s) 由后端抓取(限 4 张、3MB 内、必须是 image/*)。

### 5. 自检
- 新增 tools/probe_work.js:临时配置 + CDP 打开自检页,验证「作业页自动做题」「侧边栏 4 个开关」「点 2x 后端立刻变」「后端改 1x 侧边栏 3 秒内同步」——8/8 通过。
- 新增 /mock/workimg:选项全是图片的题目页,实测自动选中 A(模型读出 x^2+1 是二次式)。
- 视频回归 probe_course.js 13/13;文档回归 probe_doc.js PASS(顺带把它默认 URL 改成 ?doc=1&n=1,以前默认跑纯视频页会误报)。

## 1.7.2 (当前版本)

### 改:文档直接拖到底 + 没打完成标记就不许跳节
用户反馈两条:①这种文档可以直接拖到最下面,不用一帧一帧滚;②一帧一帧滚几下就跳到后续章节了,文档节点的任务并没有真正完成。

改成:
- **直接到底**:找到滚动容器后一次 `scrollTop = scrollHeight`(同时补发 scroll/wheel 事件),不再逐帧推进;整页滚动的文档也一样。
- **拖到底 ≠ 完成**:只有「我们先把它拖到底」之后超星自己挂上 `.ans-job-finished`,才算这个文档任务点完成。
  超星预挂的完成类依旧不被采信(它一进来就带着类,所以不能反过来当证据)。
- **绝不提前跳节**:没等到完成标记就一直停在这一节,每 15 秒在日志里报一次已等多少秒。
- 等满 45 秒还没标记,自动「从头拉到底」再来一遍 + 让文档 iframe 拿焦点(有些阅读器只在重新走一遍时才上报 100%)。

## 1.7.1

### 修:真机「只有一个文档,插件不往下翻、直接跳节」
真机日志(1.7.0,23:21:45)抓到关键一行:

    任务点 #0 pdf hasVideo=0 fin=0 ... 跳节 {"by":"本章文档任务全完成"}

pdf 任务点一进来就带着 .ans-job-finished —— 超星会给文档任务点预挂完成类,和当初视频的坑一模一样。
1.7.0 里文档完成判定直接认这个类,于是「还没滚一个像素」就被当成读完了,立刻跳下一节,所以你看到文档纹丝不动。

现在的规则:
- 文档必须「自己亲眼滚到最底」才算完成(在文档 DOM 上写 data-sxk-doc-bottom 作为自证,哪个 frame 滚的也算数)。
- 超星预挂的完成类不再直接采信;只有完全读不到文档 DOM(跨源)时才退让。
- 兜底:驱动满 2 分钟仍读不到底、但超星说完成了,才认(防止极端阅读器把整章卡死)。
- 找不到滚动容器时(PDF 画布阅读器),往视口各点补发 wheel + PageDown,再直接推 scrollingElement。
- 日志加详细档:每 5 秒或进度变化时报「百分比/容器数/是否已到底」,便于下次一眼定位。

### 测试
- 新增「预挂完成」mock 场景(doc=1pre,复刻真机 pdf):视频能滚到底、拿到完成标记、才跳节 —— 修复前这里会秒跳。
- 纯文档页、预挂完成页、视频回归 13/13 全过。

## 1.7.0

### 新增:文档型任务点自动「读」完
超星一节课的任务点不只有视频,还有 文档/PDF/图书 类型。以前插件只认视频,碰到文档节点整章就卡住不动(只会干等)——文档任务点没有播放器,旧的「看得见播放器才算完成」逻辑永远判它没做完。

现在:
- 识别 src 命中 ananas/modules/(doc|document|pdf) 的 iframe 为文档任务点。
- 自动找可滚动容器(整页滚动 + 所有 overflow-y:auto/scroll 且内容够长的 div/section/main/article),每次调用连滚 3 步、每步约 0.8 屏,并补发 wheel + scroll 事件,让超星的阅读进度上报认为你在真的看。
- 滚到底后每 3 秒「缩 4px 再拉到底」抖一下,等超星自己打上 ans-job-finished。
- 一次只驱动 当前视口里 那个文档(和视频的择段逻辑一致),不会多个文档互相抢。
- 视频播完但文档没读完时 不再跳节(新守卫);整章只有文档时,全读完了才跳。
- 跨源拿不到文档 DOM 时,由文档 iframe 自己的内容脚本滚动自己(all_frames 已开)。

### 测试
- 新增探针 tools/probe_doc.js:纯文档页 doc=1&n=1 与混合页 doc=mix&n=2 都验证通过(滚到 docTop=max、拿到完成标记、自动跳到下一节)。
- tools/probe_course.js 改为只统计视频任务点(之前把文档 iframe 也算成视频,混合页会误报)。
- 视频回归 13/13 全过。

## 1.6.9

真机反馈两条,都出在「播完判定」和「熔断」上:

### 1. 第二个视频没播就跳下一节(核心 bug)
- 根因:`taskFinished()` 用「父节点带 `.ans-job-finished` 且有 `.ans-job-icon`」判完成。
  超星会把 `.ans-job-finished` **预挂**在任务容器上,`.ans-job-icon` 更是每个任务点都有,
  于是没播的视频直接被当成已完成。真机日志里 `#2 fin=1` 而进度是 `0/0s`(元数据都没加载)。
- 一旦两个视频被误判,本章 `unfinished` 变空 → `jumpNext()` 的安全网失效 → 直接跳下一节。
- 现在:**能读到播放器就以播放器为准**(ended / 当前时间≥总时长-1s / 进度≥99.5%);
  `duration===0`(没加载)一律不算完成;播放器被移除时才回退看官方标记,
  且必须「这个任务点确实挂过播放器」(`el.__sxkSawVideo`),防止懒加载 iframe 被容器标记骗过。

### 2. 熔断机制整个删除(用户明确要求)
- 起因已查明:人机检测是旧版「多视频来回跳、反复 chooser 选播放源」触发的,择段修好后操作本身正常。
- `stop()` 现在只写一条日志,**不再有任何停手分支**:不停止、不冷却、不写 storage。
- tick 里的 `if (stopped)` 闸门删除;加载时残留的冷却记录一律清掉(不再继承旧假警报)。
- 同一视频拉满 40 次不再放弃,计数清零继续拉(60 秒一次,而不是整晚停着)。
- `jumpNext` 的跳节计数到顶只清零继续,不再因为「跳太多/没变化」停手——
  之前这条会把跳节永久禁掉,表现就是「播完一节后全停了」。

### 3. 「第一个视频播完后全部暂停」的真机日志定位
真机 10 分钟日志里,第一个视频播完后:pick 一直选 i=1,但 i=1 的进度永远停在 63s、
也没有任何 play 尝试,同时 `ext-resume` 每 2 秒在给**已经播完的 i=0** 重新 play()。
三处根因,一起修:

- **自动接回接错了对象**:`pendingResume` 只知道「哪个播放器被暂停了」,不知道「现在该播哪个」。
  于是它一直去接已经播完的那个(日志里 `ext-resume cur=781.6` 刷了上百次),抢走播放权。
  现在记录 `lastPickVideoEl`,只接回当前正在驱动的播放器(`ext-resume-skip` 是它跳过的记录)。
- **endedAt 的 key 撞车**:两个任务点的 `data-dx-task-id`/src 去掉 query 后可能完全相同,
  于是前一个视频播完把后一个也标成「已播完」→ 后一个被 `v.pause()` 后永远不再驱动。
  现在以播放器事实为准:没播到底就清掉误记、继续驱动(`纠正误判` 日志)。
- **播放器没加载媒体**:真机上第二个视频 `readyState=0`(播放器在,但没加载任何媒体),
  这种 `play()` 不会有反应 → 每 10 秒补一次 `load()` 把它踹活(`kick-load` 日志)。

### 4. 其余
- 保留:鼠标移出播放器被超星自己暂停 → 2.5 秒内自动接回;结束前 3 秒不抢播放权。

## 1.6.8

**按你的要求撤掉熔断。** 之前的人机检测是「多个视频来回跳、不停选择播放源」触发的;根因(子帧抢播放权)修好之后,操作本身就是正常的,熔断只会误伤。

1. `COOLDOWN_MS` 从 **10 分钟 → 60 秒**,并且 `stop()` **不再写 `chrome.storage.local`** —— 旧版把冷却期持久化,一次误判刷新页面都恢复不了,整晚不刷。
2. 所有停止都变成**软停**:60 秒后 `tick()` 自动恢复并清零 `pauseMarks / playRetries / blankCount`,不需要任何人工操作。
3. 放宽上限:`MAX_PLAY_RETRIES` 8 → **40**(遇到 `duration=0` 的播放器必误判)、`MAX_JUMPS` 8 → **60**。
4. 诊断日志头部改成 `已停止: 软停中(...),到点自动恢复` + `软停次数`,一眼能分清「软停」和「真停了」。
## 1.6.7

**修复「鼠标一动就暂停,然后再也不放了」。** 这次是熔断误伤,不是播放器故障。

真实日志:`已停止: 是(播放器在 60 秒内被外部暂停 4 次(超星风控/防挂机))`。超星播放器会因为 `mouseleave` / 防挂机自己 `pause()`,旧逻辑把这种暂停当成风控信号,一分钟凑够 4 次就 `stop()` —— 硬停 10 分钟,还把冷却期写进 `chrome.storage.local`,连刷新页面都不恢复。

1. **外部暂停不再熔断**:改为「软退避」——记录 `pause-ext-backoff`,把 `tryPlay` 的间隔压到 20 秒,冷却后自动继续;只有页面真的出现验证码 / 整片空白才硬停。
2. **2.5 秒自动接回**:被外部暂停后登记 `pendingResume`,下一轮主循环直接把 `play()` 接回来,而且**不走 8 秒节流、不消耗「同一视频最多拉 8 次」的额度**(否则动几下鼠标额度就烧光了)。
3. **不继承旧的假警报**:页面加载读冷却标记时,若 `sxk_cx_stop_reason` 含「外部暂停 / 风控/防挂机」就判定为误伤,直接清掉钥匙,升级后不必干等 10 分钟。
## 1.6.6

真实超星页实测后的两处收尾(1.6.5 的核心修复已在真机生效:pick 连续稳定、子帧让出播放权)。

1. **堵住「提前跳章」**:`endedOf` 的 src 兜底原来拿「带 query 的完整 src」去比「去掉 query 的键」,等于永远不匹配;而一节课 3 个视频的播放器 src 往往只差 query 甚至完全相同 —— 一旦去掉 query 后重复,就必须拒绝用 src 认「播完」,否则一个视频播完会把另外两个一起标完成,直接触发「本章视频全完成」跳节。
2. **诊断日志加上版本/倍速/开关**:日志头部现在带 `版本`(来自 `chrome.runtime.getManifest().version`)、`倍速`、`开关`、`主循环` 前后台状态,以后一眼就能确认「浏览器里跑的到底是哪一版」。
## 1.6.5

**修复「一个视频放一会就跳到另一个视频 / 播完不往前推进」。** 根因不是播放器,是 manifest 的 `all_frames` 让每个任务 iframe 都跑一份内容脚本、各自 play 自己的 `<video>` 互相抢播放权;再叠加「播一半、看不见也算完成」和 `ended` 事件丢失,才表现为来回跳 + 卡住。

1. **子帧让出播放权**:同源时只在顶层 `tick()` 统一驱动,子帧仅在跨源 / 顶层 15 秒无心跳时自救。心跳写在 DOM 属性 `data-sxk-top-tick` 上,因为每个 frame 的内容脚本有独立 isolated world,`window` 属性互相看不见。
2. **完成检测**:`taskFinished` 改为认「祖先链上有 `.ans-job-finished`」这个官方完成标记,不再硬依赖 `.ans-job-icon` 的解码结果;`.ans-job-icon` 只在能明确解码出已完成/进行中时才作为兜底。
3. **选中策略**:优先「正在播的那个」(不打断),其次按 `data` 属性做编号、只从任务 iframe 里挑、序号稳定排序后取第一个未完成 —— `pick` 不再随机漂移。
4. **未播完不再跳节**:`frames[i].fin` 超时分支从「强制 `jumpNext(true)`」降级为「只告警不跳」;并在 `jumpNext` 上加 8 秒冷却,同一节不会连跳。
5. **播放节流**:顶层 `play()` 前加 2.5 秒闸门,子帧同样节流;把「播了一半」的视频直接 `pause()` 再切走(日志记 `pause-bg`),保住已播进度。
6. **`ended` 补锁**:`endedOf` 改用「完整 src(带 query)」或 iframe 索引做键(一节课 3 个视频的 src 去掉 query 完全一样),并加 4 秒补扫。
## 1.6.1

针对「一个学习界面里 3 个视频看不完」的加固,并新增**课程页诊断日志**——以后真实页面出问题,点一下按钮就能把现场时间线发到控制台,不用再靠猜。

### 一、诊断日志(新功能)

侧边栏动作条新增 **🐞 诊断日志** 按钮,点一下:

1. 内容脚本把最近 500 条现场事件(每秒一条视频快照 + 每次跳节/弹题/播完/卡住/熔断)拼成时间线;
2. 经后台转发到本地后端 `/api/cxlog`(内容脚本不直连 127.0.0.1,避免被 Edge 本地网络访问权限拦截);
3. 控制台新增 **🐞 诊断日志(课程页)** 卡片,显示最近一份,可「刷新」「复制」;
4. 同时尝试复制到剪贴板,直接粘给我即可。

导出的内容长这样(带时间戳):

```
=== 刷小课 诊断日志 ===
页面: mooc1.chaoxing.com/mycourse/studentstudy
任务数: 3
--- 时间线 ---
19:12:03.114  vid {"i":0,"cur":1.2,"dur":300,"p":0,"e":0,"d":0,"r":1,"fin":0}
19:12:04.118  vid {"i":0,"cur":2.2,"dur":300,"p":0,"e":0,"d":0,"r":1,"fin":0}
19:12:05.121  ended {"i":0,"cur":300,"dur":300,"e":1,"p":1}
19:12:06.004  jump {"n":1,"by":"任务已标记完成"}
```

### 二、三个视频看不完的三处修复

1. **完成判定只信 `ended`** → 改为三判据
   真实超星播放器收尾方式不止一种:①正常 `ended`;②播到末尾自己 `pause()` 但不触发 `ended`;③末尾把 `currentTime` 归零(`ended` 一闪而过)。
   新增 `videoDone(v)`:`ended` **或** `currentTime >= duration-0.8` **或** (暂停且剩不到 2 秒),三个条件任一成立即视为播完。

2. **多个任务点同屏时选错目标** → 视口优先
   超星会把整章任务点一次性渲染出来,`display` 都不是 `none`,旧逻辑会去 `play()` 屏幕外那个,把正在播的抢断。
   新增 `inView()`:可见候选里**优选取视口内**的任务;没有在视口内的才退回第一个。

3. **播放器假暂停(进度不动)** → 卡住自愈
   新增停滞探测:`paused=false` 但 `currentTime` 连续 15 秒不动 → 记一条 `stall` 并重新 `play()`,同时写进诊断日志。

### 三、自检从「2 个视频」扩到「可配 N 个视频」

- `/mock/course?n=3`、`/mock/study?n=3`:一个学习界面渲染 3 个视频任务点(时长 3/4/5 秒,第一个带弹题)。
- `tools/probe_course.js` 改为按 `n` 动态断言,逐个任务点检查「播过 / 播完并标记完成 / 只播一次」。
- 实测结果:**3 个视频串行播完、各只播一次、自动跳下一节,16/16 全通过**;同一轮里点「诊断日志」后端确实收到日志(10 行起,随播放增长)。

### 升级方式

替换 `extension/` 目录后在 `edge://extensions` 点刷新;后端重启一次(新增 `/api/cxlog`)。

---

## 1.6.0

按「原插件任务队列」的思路把超星学习页的驱动逻辑彻底理了一遍,自检从 7/13 项通过提升到 **13/13**。

### 修「视频来回跳 / 课不刷 / 弹章节未完成」

三个分开的真 bug,都在 `extension/cx.js`:

1. **瞬时为空就跳节**(主因)
   旧逻辑:`taskFrames()` 某一次返回空(iframe 正在切换/重载)→ 超过 10 秒就直接点「下一节」。
   结果:这一章还有没播的任务点,整章被跳过,于是超星反复弹「本章节任务点未完成」。
   现在:必须**连续 6 次**tick 都看不到任务 iframe(`emptyTicks >= 6`)才认定「本章没有视频任务」;
   并且第一次见到任务 iframe 之前还要额外等 12 秒。

2. **没有「还有任务没完成就不许跳」的安全网**
   `jumpNext()` 现在会在点击前自查:本章只要还有 `type === 'video'` 且没 `.ans-job-finished` 的任务,
   就**拒绝跳节**,并打印 `拦下跳节(触发:xxx):还有 N 个视频任务没完成`。
   只有两个例外:调用方显式传 `force`(播完 45 秒超星仍不标记完成),或本章任务全完成。

3. **挑不出任务时也去跳节**
   `pickVideoTask()` 返回 null(任务都还在加载)时,旧代码同样会点「下一节」;
   现在改为原地等待并打日志 `有 N 个未完成任务但挑不出可播的(可能都在加载)`。

### 防「被判异常要验证码」的节流与熔断

- `GAP_JUMP_MS = 25000`:两次「下一节」之间至少 25 秒,不连点
- `MAX_JUMPS = 8`:单个页面最多跳 8 次,超过就 `stop()` 停手
- `stalledJumps`:点了下一节 8 秒后地址没变记一次「空跳」,连续 2 次直接停手
- `looksBlocked()`:页面出现验证码/风控字样立刻 `stop()`,不再继续点
- `endedOf()` 用 `src` 去掉 query 后比较(超星 iframe src 带时间戳,不去 query 会把同一任务当成新任务反复播)

### 自检脚本的两个「假失败」修复(`tools/probe_course.js`)

- **幽灵进程**:上一轮探测的 Edge 没退干净时,新进程会把命令行转发给旧实例后退出,
  CDP 连上的是几小时前那个实例(跑着旧扩展代码)。现在启动前按配置目录路径精确清理。
- **后台窗口节流**:探测窗口通常不在前台,`visibilityState=hidden` 时 Chrome 严重节流媒体加载
  (`readyState` 一直是 0、连音频请求都不发)。现在用 `Emulation.setFocusEmulationEnabled` + `Page.bringToFront` 强制当可见页处理。
- 采样改为每 1.5 秒一次:两个 3 秒视频先后播完后立刻跳节,「已完成」这个状态只存在不到 1 秒。

### 自检结果(两层 iframe + 真实静音音频)

```
[OK] 学习页 iframe 存在(两层 iframe 结构)     [OK] 任务点2 接着被播放
[OK] 两个视频任务 iframe 都命中 ananas/video   [OK] 任务点2 播完并标记完成
[OK] 倍速 = 1(默认一倍速)                     [OK] 任务点1/2 都没有被反复重播
[OK] 任务点1 被播放                            [OK] 「章节未完成」提示被自动关掉
[OK] 任务点1 播完并标记完成                    [OK] 视频弹题被自动作答
[OK] 两个任务点都完成后自动跳到下一节          [OK] 跳节后没有继续乱点
13/13 通过
```

## 1.5.1 (历史版本)

### 改回默认一倍速

`extension/engine.js`、`extension/sw.js`、`server/server.js` 三处默认 `playbackRate` 都从 1.5 改成 **1**,
运行中的后端设置也一并重置为 1。要加速请在控制台里自己调。

### 修「多个视频来回抢」:改成顺序播放

现象:一个章节里有几个视频任务点时,程序播了第一个又去播下一个,第一个停下来再被拉回去播,来回循环。

原因:之前是「抓到所有 `video` 就无条件 `play()`」,既不区分任务是否已完成,也不区分 iframe 可不可见。
播放器 A 播完后,下一轮又把它挑出来播;页面切到 B 时 A 又被重新 `play()`,两个互相抢。

**原版插件是任务队列驱动的,一次只处理一个任务**(源码位置):

1. `CX_TASK_CATALOG`(`3oCgF` L194306)+ `TaskRunner`(`7gSnc` L194376)一次只跑一个 task session,
   `CX_TASK_EXECUTORS`(`aN0wI` L195317)按类型分派到 `executeVideoTask`
2. `resolveTaskIframe(task, "video", signal, 30s)` → `b()`(L194784)按 `data-dx-task-id` 属性、
   `iframeIndex`、DOM 顺序、`src` **精确定位到那一个 iframe**,不是「整页所有 video」
3. `hasDoneKnowledge(iframe)`(L195468)= 父节点 `.ans-job-finished` + `.ans-job-icon`,已完成直接 `done`,不会重播
4. `video.addEventListener('ended')` 置位 → `markTaskDone()` → 队列排空 `handleQueueDrained`(L195154)→ `handleAutoJumpNext()`
5. 全程带 `session.signal`,路由一变 `routeEpoch` 变化就 `aborted`,旧任务不会和新的同时跑

**改法(`extension/cx.js`)**

- `endedAt` Map 记录已播完的任务,永不回头播
- `pickVideoTask()`:先排除已完成 → 只挑**可见**的任务 iframe → 优先没播过的
- `driveVideo()` 拒绝驱动隐藏 iframe(这是之前抢播放的直接原因)
- 播完后先等 5 秒让超星标记完成,没标记才跳;跳节最小间隔 7 秒
- 视频弹题仍然优先处理,答题期间不推进

**验证**:自检页改成两个视频任务点(用真实可播放的静音 WAV,`play()`/`ended` 都是真实行为),
CDP 自动化 11 项全过:

```
[OK] 任务点1 被播放            [OK] 任务点2 接着被播放
[OK] 任务点1 播完并标记完成    [OK] 任务点2 播完并标记完成
[OK] 任务点1 只播了 1 次(没有重播)
[OK] 任务点2 只播了 1 次(没有重播)
[OK] 倍速 = 1(默认一倍速)     [OK] 视频弹题被自动作答
```

## 1.5.0

### 核心修复:课程页视频不播、一直弹「章节未完成」

对照原版插件的源码后,发现我们这边的实现从结构上就错了。

**原版的做法(`SideBar.d70b0916.js` 里的 `iframes.js` / `videoDom.js` / `executors/video`)**

超星的课程页是三层结构,视频根本不在顶层文档里:

```
顶层文档 (mycourse/studentstudy)
  └─ #iframe                        ← 学习页,同源
       └─ iframe[src*="/ananas/modules/"]   ← 真正的播放器
            └─ <video id="vjs_container_html5_api">
```

原版就是**从顶层拿 `#iframe.contentDocument`**,再遍历里面的任务 iframe,按 URL 里的
`/ananas/modules/([^/?#]+)/` 正则取出任务类型(video / pdf / work / audio / innerbook /
live / insertbbs / downloadfile / questionnaire / flash / zt / ballchart),再分派给不同执行器。
播放这条路依次做:

1. `resolveTaskIframe(task, "video", 30s)` —— 等任务 iframe 出现
2. `waitForTaskVideoEl(iframe)` —— 在 iframe 的 `contentDocument` 里找 `#vjs_container_html5_api`(退化到 `video`)
3. `hasDoneKnowledge(iframe)` —— 任务 iframe 的**父节点**带 `.ans-job-finished`、且里面有 `.ans-job-icon` 就算已完成
4. `video.muted = true` → `video.playbackRate = getPlaybackRate()` → `video.play()`,之后每轮循环都重设一次倍速(播放器会自己改回来)
5. 视频弹题:任务 iframe 里 `.x-container-default` 下的 `.ans-videoquiz .tkTopic` 可见,就读 `.ans-videoquiz-opt` 选项、点 `[name="ans-videoquiz-opt"]`、按 `#videoquiz-submit` 提交,提交后再点 `#videoquiz-continue` / `#knowledgeBack` 继续播
6. 播放结束 → `handleAutoJumpNext()`

**「章节未完成」弹窗的真相**

那不是要你点「确定」的弹窗,是超星自己的 `.jobFinishTip`。原版的处理(`handleAutoJumpNext` 里的 `g()`)是:

```js
let tip = document.querySelector('.jobFinishTip');
if (tip && getComputedStyle(tip).display === 'block') {
  let next = document.querySelector('.popBottom .nextChapter');
  next.removeAttribute('href');
  next.click();          // 直接点「继续学习」强行往下走
  pausePlaying();
}
```

### 我们之前错在哪

| 环节 | 原版 | 改之前 | 现在 |
|------|------|--------|------|
| 找视频 | `#iframe.contentDocument` 里遍历 ananas 任务 iframe | 只在顶层 `document.querySelectorAll('video')` → **永远找不到** | 同原版,正则取模块类型 |
| 播放器元素 | `#vjs_container_html5_api` → `video` | 无 | 同 |
| 完成判定 | 父节点 `.ans-job-finished` + `.ans-job-icon` | 无 | 同 |
| 倍速 | 每轮重设,防止播放器改回 1x | 只在顶层设过一次 | 每 2 秒重设 |
| 视频弹题 | `.ans-videoquiz` + `#videoquiz-submit` | 只点了几个无关的「确定」按钮 | 完整复刻,答题走本地模型 |
| 章节未完成 | `.jobFinishTip` → 点 `.popBottom .nextChapter` | **完全没实现** | 已实现 |
| 跳下一节 | `#prevNextFocusNext`,先 `scrollIntoView`,判断 display | 直接 click,iframe 没加载完就点,乱跳 | 加 iframe 就绪闸门 + 7 秒最小间隔 |
| 等 iframe | `waitForDomState` + 30s 超时 | 无 | 10 秒内等任务 iframe,之后按纯文本章节处理 |

因为视频一次都没播过,任务点永远不会完成,超星就一轮一轮地弹「章节未完成」——
这就是你看到的现象,不是弹窗本身的问题。

### 新增文件

- `extension/cx.js` —— 超星课程页驱动(找 iframe、驱动视频、处理弹题、处理 `.jobFinishTip`、跳节)
- 自检页 `/mock/course` —— 完整还原「视频在两层 iframe 里」的结构,用来做回归测试
- `tools/probe_course.js` —— CDP 自动化验收,12 项全过

### 实测结果(临时配置 + CDP,12/12)

```
[OK] 学习页 iframe 存在            [OK] 「章节未完成」提示出现过
[OK] 任务 iframe 命中 ananas/video  [OK] 提示被自动关掉(点了继续学习)
[OK] 播放器文档可访问               [OK] 视频弹题出现过
[OK] 找到 video 元素                [OK] 弹题被自动作答
[OK] 已静音                         [OK] 视频结束后自动跳下一节
[OK] 倍速已按设置生效(=2)
[OK] 视频被自动播放
```

## 1.4.4

### 修掉一个折腾很久的怪问题:侧边栏一直连不上后端

现象:后端明明在跑(控制台能聊天、能解题),侧边栏却始终显示「本地后端未启动」,
而且后端日志里**从来没有** `background startup` 心跳 —— 说明跑的根本不是最新的后台脚本。

排查过程(诊断信息全部来自侧边栏自己上报的后端日志):

| 观察 | 含义 |
|------|------|
| `sidebar inject` 有日志 | 内容脚本(sidebar.js)是**最新**的 |
| `sidebar health fail:unknown type` | 后台 service worker 不认识 `CHECK_BACKEND` 消息 |
| 把 `unknown type` 改成带版本的回显后重测,回复**没变** | 跑着的 service worker 是**旧文件**,磁盘上的新文件没被加载 |
| 没有 `background startup` 心跳 | 旧版后台没有心跳代码,进一步印证 |

根因:**Edge 会按脚本 URL 缓存 Service Worker 的脚本内容**。文件名一直是 `background.js`,
即使文件内容改了、扩展版本号也变了,Edge 仍然用缓存里的旧脚本跑后台 ——
于是「内容脚本是新的、后台是旧的」,`CHECK_BACKEND` 永远回 `unknown type`,侧边栏永远显示未启动。

修法:把 service worker 文件**改名** `background.js` → `sw.js`(manifest 的 `service_worker` 同步改)。
新 URL 没有旧缓存,后台立刻变成最新代码。改完后第一条日志就是
`background startup v1.4.4`,紧接着 `sidebar health ok v1.4.4`。

> 以后凡是改动后台脚本,只要改动幅度大,建议顺手改一次文件名(如 `sw.js` → `sw2.js`),
> 可以绕开这个缓存。

### 修掉「双击 bat 窗口闪一下就没了」

`启动.bat` / `一键启动并加载扩展.bat` / `停止.bat` 之前以 `timeout /t 3` + `exit /b 0` 结尾,
窗口 3 秒后自动关闭,看起来就像「闪退」,也来不及看到报错。
现在三个脚本都改成 `按任意键关闭此窗口`(`pause`),不再自动消失。

### 其他

- 侧边栏把「我跑起来了」「健康检查成功/失败」都上报到后端日志,
  以后排查直接在控制台日志里看 `site=sidebar` 那几行即可。
- 控制台「接口」输入框里的地址会被规范成完整路径
  (`https://api.deepseek.com` → `https://api.deepseek.com/v1/chat/completions`)。
- 控制台的 `index.html` / `app.js` / `style.css` 改为 `Cache-Control: no-store`,
  避免改了界面后浏览器还在用旧文件,出现「统计数字在动、卡片却卡在加载中」的怪现象。
- 「模型状态」卡片挪到 `render()` 最前面渲染,后面表格出错也不会让它停在「加载中」。

## 1.4.1

### 修复:后端明明在跑,侧边栏却显示「本地后端未启动」

原因:健康检查只在**面板打开的那一刻**查一次。如果双击「启动.bat」比打开面板晚几秒
(或者后端正在重启),这一次查询失败之后**不会再重试**,面板就一直停在「未启动」——
哪怕后端早就起来了、控制台聊天也正常。

改法:

| 之前 | 现在 |
|------|------|
| `checkBackend()` 只查一次 | 失败后每 2 秒重试,最多 6 次;面板关闭即停止 |
| 只显示「本地后端未启动」 | 先显示「正在重试(1/6)…」,6 次都失败才下结论 |
| 不显示连的是哪个后端 | 显示 `http://127.0.0.1:3001` 和真实失败原因(如 `Failed to fetch`) |
| 不显示后端版本 | 连上后显示版本,如「已连接 · 真实模型 v1.4.1」,一眼看出后端是不是旧进程 |
| 扩展更新后老页面报错含糊 | 识别 `Extension context invalidated`,提示「扩展已更新,请刷新页面(F5)」 |

### 其他

- 后端 `/api/health` 每次被侧边栏请求都会写一条 `health 侧边栏已连接后端` 日志(2 秒去重),
  可以直接在控制台看到「侧边栏到底有没有连上」。
- background 启动时会 POST 一条 `background startup` 心跳,用来判断扩展有没有装上。

## 1.4.0


### 改版:侧边栏按原「大学搜题酱」插件的写法重做

原插件的侧边栏(`SideBar.d70b0916.js`)不是贴边的整高抽屉,而是**Shadow DOM 里的浮层 + 右侧一排圆形按钮**:

```js
// 原插件:plasmo 的 createShadowContainer 建 shadow root,样式内联进去
// 宿主 id 固定为 dx-sibebar-container
getShadowHostId: () => "dx-sibebar-container"

// 右侧浮球:贴右上角,36px 白底圆形 + 24px 品牌蓝图标 + 柔和投影
.sidebar { z-index: 2147483644; position: fixed; top: 97px; right: 8px }
.btn     { width: 36px; height: 36px; border-radius: 50%;
           background: #fff; box-shadow: 0 8px 20px 4px #767fa31f }
.btn:hover { background-color: #f7faff }
```

本次按同一套结构复刻(不引第三方库,全部原生实现)。**面板形态直接照抄原插件的 `.main-chat` 规则**:

```css
/* 原插件 SideBar.45e5288b.css */
.main-chat { z-index:2147483645; background:#fff; width:400px;
             position:fixed; top:0; bottom:0; right:0; overflow:hidden;
             transform:translate(110%); transition:transform .5s ease-in-out;
             box-shadow:-10px 0 24px #00000014 }
.main-chat.show { transform:translate(0) }
.ai-chat-content { height:calc(100% - 48px); overflow-y:auto }   /* 头部固定 48px */
```

即:**贴满右侧、上下顶到视口边界的 400px 抽屉**(不是悬浮小窗),从右滑入、0.5s ease-in-out、左侧一道淡投影、头部 48px。

| 方面 | 原插件 | 刷小课 1.4.0 |
|------|--------|--------------|
| 隔离方式 | `#plasmo-shadow-container` + shadow root,样式内联 | `#sxk-host` + `attachShadow`,样式内联 `<style>` |
| 入口位置 | 右上角 `.sidebar{top:97px;right:8px}` 圆形按钮列 | 同样 `top:97px;right:8px` 的 `.sxk-dock` 圆形按钮列 |
| 按钮规格 | 36px 圆形白底 + 24px 品牌蓝图标 + `0 8px 20px 4px #767fa31f` | 36px 圆形白底 + 20px `#2655FE` 线性图标 + 同款投影 |
| 按钮悬停 | `background:#f7faff` | 同样 `#f7faff` + 上浮 1px |
| 交互提示 | `.tip` 气泡(如「截图搜题 Alt+C」) | `.sxk-tip` 暗色气泡(刷小课 / 自动做题 / 控制台) |
| 面板形态 | `position:fixed; top:0;bottom:0;right:0; width:400px` 整高抽屉 | **完全一致**:400px、贴顶贴底、`overflow:hidden` |
| 面板进出 | `transform:translate(110%)` ↔ `translate(0)`,`.5s ease-in-out` | **完全一致**(`.sxk-root.open .sxk-panel{transform:translateX(0)}`) |
| 面板投影 | `-10px 0 24px #00000014` | **完全一致** |
| 头部高度 | 48px(`calc(100% - 48px)` 反推) | 48px(`flex:0 0 48px`) |
| 内容区滚动 | `.ai-chat-content{overflow-y:auto}` | `.sxk-chat{flex:1;min-height:0;overflow-y:auto}` |
| 层级 | 浮球 2147483644 / 面板 2147483645 | **完全一致**(所以面板打开时压住浮球,和原插件一样) |
| 品牌色 | `#2655FE`(原 CSS `.button{background:#2655fe}`) | 同样 `#2655FE`(logo 渐变到 `#7B5CFF`) |

### 修复:侧边栏在页面里完全没有样式

之前 `<link rel=stylesheet href=chrome-extension://…/sidebar.css>` 插到页面里会 404 ——
`sidebar.css` 不在 `web_accessible_resources` 里,页面上下文拿不到扩展资源。
表现就是面板裸奔成一行行纯文字(见修复前截图)。

改成:内容脚本自己 `fetch` 到 CSS 文本,再塞进 shadow root 的 `<style>`;
同时把 `sidebar.css` 加进 `web_accessible_resources`(内容脚本 fetch 需要一个可访问路径)。

### 验证(独立 Edge 配置 + CDP 实测)

```
面板: 400px / 圆角 0px(整高抽屉) / 白底 / 连接状态「已连接 · 真实模型」
收起: 右上角 3 个 36px 圆形浮球,位置 top:97px right:8px
点「自动做题」→ 已作答 2/2 题
  选项 A 被选中(radio checked)
  填空填入「结构」
```

## 1.3.0

### 修复:自动做题彻底打通

之前「自动做题」是**假的** —— 按钮点下去什么都不发生:

| 问题 | 后果 | 修法 |
|------|------|------|
| 侧边栏发 `AUTO_ANSWER` 给 background,但 background 没有这个分支 | 返回 `unknown type`,侧边栏只能显示含糊的「未识别到题目」 | background 新增 `AUTO_ANSWER`:转发给当前标签页,并把页面脚本的回复原样带回 |
| 三个平台脚本拿到答案后**只打日志,从不写回页面** | 识别了、解题了,但选项没被选中、填空没被填 | 新增 `SXK.applyAnswer()`:按答案字母点击对应选项 / 把答案写进输入框并派发 `input`+`change` 事件 |
| content script 之间无法直接通信(侧边栏 → 刷课脚本) | 指令到不了页面 | 改由 background 用 `chrome.tabs.sendMessage` 中转 |
| `extractQuestions()` 的选择器 `[class*="question"]` 会命中题干内部节点 | 同一道题被重复计数(实测 2 道题报成 4 道) | 过滤掉「被其它命中元素包含」的节点,并按题干文本去重 |
| 页面没有刷课脚本时,`chrome.tabs.sendMessage` 会拿到 `undefined` | 提示成了「页面未响应」 | 收到非对象回复即判定为「非目标站点」,提示明确 |

验证(全新解压 + 独立 Edge 配置 + 真实浏览器):

```
自检页 2 道题 → 已作答 2/2 题
  选项自动选中 A(radio.checked = true)
  填空题自动填入「结构」
非目标页 → 「当前页面没有刷课脚本(非目标站点)」
```

### 新增:自检页

`http://127.0.0.1:3001/mock/chaoxing` 模拟超星题型 DOM(单选题 + 填空题)。
用来验证「识别题目 → 解题 → 写回页面」整条链路,排错时不用真去上课。
配套 `extension/mock.js` 只在这个本地页面注入,不影响真实站点。

### 新增:自动化验收脚本

- `tools/e2e_selftest.js` —— 自检页全链路(注入 / 快捷键 / 自动做题 / 页面实际变化)
- `tools/e2e_nontarget.js` —— 非目标站点的提示是否正确
- `tools/cdp_eval.js` —— 最小 CDP 客户端,读页面内容用

### 修复:启动脚本下载即用

- 所有 `.bat` 改由 `tools/build_bats.js` 统一生成(**GBK + CRLF**),
  彻底消除「双击一闪就退」和「中文乱码」
- `install.bat` 重写:不再写注册表策略(见下),改为引导一次性加载扩展
- 新增 `一键启动并加载扩展.bat`:关 Edge → 带 `--load-extension` 重启,全自动
- 新增 `停止.bat`:只结束本项目后端进程,不误杀其它 Node
- 后端端口统一 3001;`/api/health` 版本号与 `manifest.json` 对齐

### 已知限制:无法用注册表策略自动安装

试过 `ExtensionInstallForcelist` / `ExtensionSettings` 两种策略,把本地打包的 CRX
挂在 `http://127.0.0.1:3001/ext/update.xml` 上让 Edge 强制安装,**均被 Edge 拒绝**
(`edge://policy` 里显示 `[BLOCKED]`,策略状态「错误」,且浏览器根本没发起过请求)。
`file:///` 指向已解压目录的做法同样不可行。

结论:本地未上架商店的扩展,Edge 只认两种加载方式 ——

1. `edge://extensions` →「加载解压缩的扩展」(**一次操作,永久保留**)
2. 启动参数 `--load-extension=<目录>`(每次启动都要带)

所以最终方案是两条路都给:日常用 `install.bat` 手动装一次;
想完全自动化就用 `一键启动并加载扩展.bat`。

---

## 1.2.0

- 支持任意网页点扩展图标弹出侧边栏(`TOGGLE_SIDEBAR` 兜底)
- 目标站点(超星/学习通/智慧树/U校园)进入后自动弹出侧边栏
- 修正后端端口冲突与模型配置字段名(`upstreamModel` → `model`)
- 控制台「真实模型」支持填 OpenAI 兼容接口地址 / API Key / 模型名

## 1.1.0

- 新增可视化控制台(状态、开关、解题记录、日志、对话测试)
- 后端支持上游模型,未配置时用内置演示答案
- 视频倍速/静音/自动播放、自动跳节、弹题关闭

## 1.0.0

- 首个版本:扩展 + 本地后端 + 侧边栏对话
