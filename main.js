const { app, BrowserWindow, desktopCapturer, screen, ipcMain, globalShortcut, Menu, Tray, nativeImage, clipboard, dialog, shell } = require('electron');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let petWindow, overlayWindow, bubbleWindow, chatWindow, tray = null;
let bubbleHideTimer = null;   // 气泡自动收起计时
let ws;
let wsReady = false;
let reconnectDelay = 1000;
let WS_URL = 'ws://localhost:8000/ws'; // 端口可在 backend/.env 里用 DESK_PET_PORT 改（见下方 backendPort()）
let escRegistered = false;
// 框选模式状态：点噜噜时暂存整屏截图，回车后按选区裁剪发给后端
let lastCapture = null;        // { image: dataURL(物理像素), scaleFactor }
let selectionPending = false;  // 已发出选区分析请求，等待结果
// 当前问答会话：记住截图/选区/补充描述/对话历史，供"继续追问"带上上下文
let session = null;            // { image, region, displaySize, note, history: [{role, content}] }
// ============ 闲聊（右键桌宠 →「和噜噜聊天」） ============
// 和搜题是两条独立链路：闲聊不带截图、不弹遮罩，只有一个"陪聊"窗口。
// 历史只放在内存里（关掉聊天窗口再打开还接着聊，桌宠退出就清空），
// 所以不存在把聊天内容写进磁盘的隐私问题。
let chatHistory = [];          // [{ role: 'user'|'assistant', content }]
const CHAT_HISTORY_MAX = 20;   // 一上一下算两条：20 条 = 最近 10 轮，够闲聊又不烧 token
let chatPending = false;       // 已发出闲聊请求、在等回复（等回复期间不许再发，避免消息乱序）
// ============ 语音唤醒（"噜噜，这个题怎么做" → 自动截屏弹出框选） ============
let wakeVoiceQuestion = '';    // 唤醒语音里说的问题（去掉唤醒词后的部分），框选确认时作为补充描述
let voiceWakeEnabled = true;   // 托盘可开关；框选/分析期间自动暂停，避免录到自己的提示音
// 语音识别故障处理：余额不足/Key 无效这种"修不好就一直报错"的问题，
// 暂停唤醒监听并弹一次带解决入口的提示，别每说一句话就报一次
let asrBlocked = null;         // { code, hint } 最近一次硬伤，配置更新后清除
let asrPromptShown = false;    // 同一种硬伤只弹一次提示框
let asrPauseTimer = null;      // 限流/网络这类临时故障的自动恢复计时
const FATAL_ASR_CODES = ['insufficient_balance', 'auth', 'no_key', 'no_config'];
// ws 消息处理器在模块顶层，真正的触发函数定义在 whenReady 闭包里（依赖 captureScreen），
// 启动时把引用挂到这里桥接作用域
let triggerVoiceSelection = null;

// 窗口尺寸（.pet-test.js 会读这两个常量做校验，改尺寸记得同步改 CSS 里的定位数值）
// 桌宠窗口：保持原来的 200x200 不动——窗口里的透明区域会吃掉桌面点击，窗口放大
// 会让"点不动"的区域也一起变大；气泡已经改到独立的窗口里显示（见 bubble.html）
const PET_WINDOW_SIZE = { width: 200, height: 200 };
// 气泡窗口：够宽够高放下一句话（气泡最宽 440px、最高约 6 行，见 bubble.html）
const BUBBLE_WINDOW_SIZE = { width: 460, height: 150 };
const PET_IMG_HEIGHT = 130;          // pet.html 里 #pet-img 的高度（气泡要摆在它头顶上方）
const BUBBLE_ABOVE_PET_PX = 9;       // 气泡窗口底边比宠物头顶高多少（详见 positionBubbleWindow）
const BUBBLE_AUTO_HIDE_MS = 8000;    // 气泡自动收起时间（原来在 pet.js 里）

// 听音灵敏度系数（误唤醒自愈）：平时是 1。遮罩被语音唤醒弹出来、又立刻被关掉且没真去框选，
// 基本可以断定这次是它自己听岔了（外放视频/键盘声被当成"喊噜噜"），就把系数往上抬一点，
// 说话要更响才会起录音。托盘里重新打开语音唤醒会复位。
let wakeBump = 1;
const WAKE_BUMP_FACTOR = 1.35;
const WAKE_BUMP_MAX = 3;
const WAKE_FALSE_TRIGGER_MS = 3000;  // 遮罩弹出后多久内被关掉算"误唤醒"
let overlayShownAt = 0;              // 遮罩这次弹出的时间戳
let overlayFromWake = false;         // 这次遮罩是不是语音唤醒弹出来的
let overlayConfirmed = false;        // 这次用户真的框选分析了吗
// 最近一段唤醒录音的电平信息（桌宠端录完随音频一起发过来，见 pet.js 的 clipInfo）：
// 用来判断"这次到底有没有人在说话"，没人在说话就别冒泡打扰
let lastWakeClip = null;             // { peak, ms, thresholdBefore, thresholdAfter, learned, noiseFloor }
let lastSelfTestInfo = null;         // 自检那次录音的电平信息（弹窗里要显示）
let lastWakeMissAt = 0;              // 上次"像在喊它但没匹配上"的提示时间（限流用）
const WAKE_LOUD_RATIO = 3;           // 峰值 ≥ 阈值×该系数才算"确实有人在说话"
const WAKE_MISS_HINT_GAP_MS = 60000; // 同类提示最短间隔，别一句一句地冒泡

// ============ 语音唤醒日志（落盘） ============
// 双击 启动桌宠.bat 启动时没有终端窗口，[wake] 日志就没人看得见了；
// 排查"喊他没反应"全靠这个文件：右键桌宠 / 托盘 →「查看语音唤醒日志」直接打开
const WAKE_LOG_PATH = path.join(app.getPath('userData'), 'wake.log');
const WAKE_LOG_MAX_BYTES = 1024 * 1024;   // 超过 1MB 就在启动时清一次，别无限长

function appendWakeLog(line) {
  try {
    fs.mkdirSync(path.dirname(WAKE_LOG_PATH), { recursive: true });
    fs.appendFileSync(WAKE_LOG_PATH, `${new Date().toLocaleString()}  ${line}\n`, 'utf8');
  } catch (e) { /* 写不了就算了，别影响桌宠本身 */ }
}

function resetWakeLogIfHuge() {
  try {
    if (fs.statSync(WAKE_LOG_PATH).size > WAKE_LOG_MAX_BYTES) fs.writeFileSync(WAKE_LOG_PATH, '', 'utf8');
  } catch (e) { /* 文件还不存在 */ }
}

function openWakeLog() {
  if (!fs.existsSync(WAKE_LOG_PATH)) {
    showPetBubble('还没有唤醒日志：说明它还没听到过说话');
    return;
  }
  shell.openPath(WAKE_LOG_PATH);
}

// "噜噜，这个题怎么做" → "这个题怎么做"；唤醒词后面的逗号/句号/客气话一起去掉
function stripWakeWord(q) {
  let t = (q || '').trim();
  // 只去掉开头的唤醒词（常见同音写法）及其后的标点/客气话，不能动"这个题"这种正文
  t = t.replace(/^[噜露卢撸路陆卤]{2}[，,、.!！。?？\s]*(帮我看看|帮我看下|帮我看一下|帮我|请问|请|你看)?/, '');
  return t.trim();
}

// ============ 语音识别故障处理 ============
// 气泡文本上限：气泡最宽 440px（约 33 字/行）、最高 6 行，落在窗口里才算"显示得全"，
// 所以超长文案统一在这里截断，不再靠窗口去裁
const BUBBLE_MAX_CHARS = 80;

function clipBubbleText(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > BUBBLE_MAX_CHARS ? t.slice(0, BUBBLE_MAX_CHARS) + '…' : t;
}

// 桌宠气泡：所有气泡（主进程的 + pet.js 里的）都从这儿发，统一截断，
// 并且显示在独立的"气泡窗口"里——以前气泡画在 200px 宽的桌宠小窗里，
// 宠物头顶只剩 52px，一行半以上的文案会被窗口上边缘裁掉（就是"气泡显示不全"）
function showPetBubble(text) {
  const msg = clipBubbleText(text);
  if (!msg) return;
  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    // 气泡窗口还没建好（只有启动最初那一瞬间可能）：记一条日志就够，
    // 别再转给桌宠页面——那边收到后会回发 IPC，容易变成来回打转
    console.log(`气泡窗口未就绪，这条提示先丢弃：${msg}`);
    return;
  }
  positionBubbleWindow();
  bubbleWindow.webContents.send('show-bubble', msg);
  // showInactive：只显示、不抢焦点；这个窗口整体点击穿透，不会挡住桌面点击
  bubbleWindow.showInactive();
  clearTimeout(bubbleHideTimer);
  bubbleHideTimer = setTimeout(() => {
    bubbleHideTimer = null;
    if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.hide();
  }, BUBBLE_AUTO_HIDE_MS);
}

// 通知桌宠"现在要不要听"，并把听音灵敏度系数一起带过去（误唤醒自愈会调大它）
function notifyWakeListen(enabled) {
  notifyPet('wake-listen', !!enabled, wakeBump);
}

// 暂停唤醒监听：识别坏了还一直录，只会每句话报一次错、白耗麦克风
function pauseWakeForAsr(reason, resumeAfterMs) {
  clearTimeout(asrPauseTimer);
  asrPauseTimer = null;
  notifyWakeListen(false);
  if (resumeAfterMs) {
    asrPauseTimer = setTimeout(() => {
      asrPauseTimer = null;
      if (wakeShouldListen()) notifyWakeListen(true);
    }, resumeAfterMs);
  }
  // 走 printWakeLog：这样"为什么暂停了"也会落在日志文件里（双击 .bat 起的没有终端）
  printWakeLog(`语音识别故障（${reason}），已暂停唤醒监听${resumeAfterMs ? `，${Math.round(resumeAfterMs / 1000)} 秒后自动恢复` : ''}`);
}

// 语音识别报错分流：余额不足/Key 无效这类"不修好就一直失败"的硬伤 →
// 停下唤醒并弹一次带解决入口的提示；限流/网络抖动 → 停 30 秒自动恢复
function handleVoiceError(payload, opts = {}) {
  const code = payload.errorCode || 'api_error';
  const hint = payload.hint || '';
  if (FATAL_ASR_CODES.includes(code)) {
    asrBlocked = { code, hint };
    pauseWakeForAsr(code);
    showPetBubble('语音识别不能用啦，唤醒已暂停 😥');
    // 遮罩可见时页面里已经有内联提示（带「打开 API 设置」），自检时也由结果弹窗说明，
    // 这两种情况都别再弹一次框打断用户
    if (!asrPromptShown && !opts.skipPrompt && !isOverlayVisible()) {
      asrPromptShown = true;
      promptAsrFix(payload);
    }
    return;
  }
  asrBlocked = null;
  if (code === 'no_speech') {
    // 录到的是杂音/没人声：不是配置问题，别弹框，也别停太久——提醒一句就继续听
    pauseWakeForAsr(code, 5000);
    // 只有"确实有人在说话"（电平明显高过阈值）才冒泡：键盘、风声这类擦边的安静重听就好，
    // 不然阈值调低之后会一句话一句地打扰人
    if (opts.loud !== false) showPetBubble(hint || '没听清，再说一次吧～');
    return;
  }
  pauseWakeForAsr(code, 30000);
  showPetBubble(hint || '语音识别暂时不可用，稍后自动重试');
}

function isOverlayVisible() {
  return !!(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
}

// 闲聊窗口是否开着：它也占用麦克风（🎤 语音聊天），所以要参与"现在该不该听唤醒词"的判断
function isChatVisible() {
  return !!(chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible());
}

// 现在该不该开着语音唤醒监听：托盘开关没关 + 语音识别没坏 + 没有挡住麦克风的窗口。
// 少了最后一条会出现两个渲染进程同时开麦克风：在聊天窗口里说话会顺手把框选遮罩弹出来。
function wakeShouldListen() {
  return voiceWakeEnabled && !asrBlocked && !isOverlayVisible() && !isChatVisible();
}

// 弹一次"打开 API 设置"的提示：点一下就能去换服务商，不用再翻右键菜单找
function promptAsrFix(payload) {
  const detail = [payload.error, payload.hint].filter(Boolean).join('\n\n');
  const owner = petWindow && !petWindow.isDestroyed() ? petWindow : null;
  dialog.showMessageBox(owner, {
    type: 'warning',
    title: '语音识别不可用',
    message: '语音识别失败，已暂停"噜噜"语音唤醒',
    detail: detail || '请到「API 设置」检查语音识别服务商和 API Key',
    buttons: ['打开 API 设置', '知道了'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }).then((r) => {
    if (r.response === 0) openSettingsWindow();
  }).catch(() => { /* 窗口已关闭就忽略 */ });
}

// 配置更新后清掉故障态：换了 Key/服务商，唤醒可以重新试
function clearAsrBlock() {
  asrBlocked = null;
  asrPromptShown = false;
  clearTimeout(asrPauseTimer);
  asrPauseTimer = null;
  // 遮罩开着/聊天窗口开着的时候不能恢复监听（会录到自己的提示音/两个进程抢麦克风），
  // 等它们关了自然会恢复（hideOverlay / 聊天窗口 closed 里会再发一次）
  if (wakeShouldListen()) notifyWakeListen(true);
}

// ============ API 配置（持久化到 backend/.env，可热更新到后端） ============
const ENV_PATH = path.join(__dirname, 'backend', '.env');

function readEnvFile() {
  const map = {};
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const idx = t.indexOf('=');
      map[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* 文件不存在时返回空表 */ }
  return map;
}

function writeEnvFile(map) {
  const lines = Object.entries(map).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join('\r\n') + '\r\n', 'utf8');
}

function getApiConfig() {
  const env = readEnvFile();
  return {
    provider: env.DESK_PET_PROVIDER || 'glm',
    apiKey: env.DESK_PET_API_KEY || '',
    apiUrl: env.DESK_PET_API_URL || '',
    model: env.DESK_PET_MODEL || '',
    // 闲聊（右键 → 和噜噜聊天）：模型可选，城市用来查天气
    chatModel: env.DESK_PET_CHAT_MODEL || '',
    city: env.DESK_PET_CITY || '',
    // 语音识别（留空 = 跟随主服务商）
    asrProvider: env.DESK_PET_ASR_PROVIDER || '',
    asrKey: env.DESK_PET_ASR_API_KEY || '',
    asrUrl: env.DESK_PET_ASR_API_URL || '',
    asrModel: env.DESK_PET_ASR_MODEL || ''
  };
}

function saveApiConfig(cfg) {
  const env = readEnvFile();
  env.DESK_PET_PROVIDER = cfg.provider || 'glm';
  if (cfg.apiKey) env.DESK_PET_API_KEY = cfg.apiKey; else delete env.DESK_PET_API_KEY;
  if (cfg.apiUrl) env.DESK_PET_API_URL = cfg.apiUrl; else delete env.DESK_PET_API_URL;
  if (cfg.model) env.DESK_PET_MODEL = cfg.model; else delete env.DESK_PET_MODEL;
  // 闲聊：模型与所在城市（城市是天气查询用的，改完下一次闲聊就生效，不用重启后端）
  if (cfg.chatModel) env.DESK_PET_CHAT_MODEL = cfg.chatModel; else delete env.DESK_PET_CHAT_MODEL;
  if (cfg.city) env.DESK_PET_CITY = cfg.city; else delete env.DESK_PET_CITY;
  // 语音识别单独一份（glm-asr 收费，没余额会报 429/1113，可切到免费的硅基流动）
  if (cfg.asrProvider) env.DESK_PET_ASR_PROVIDER = cfg.asrProvider; else delete env.DESK_PET_ASR_PROVIDER;
  if (cfg.asrKey) env.DESK_PET_ASR_API_KEY = cfg.asrKey; else delete env.DESK_PET_ASR_API_KEY;
  if (cfg.asrUrl) env.DESK_PET_ASR_API_URL = cfg.asrUrl; else delete env.DESK_PET_ASR_API_URL;
  if (cfg.asrModel) env.DESK_PET_ASR_MODEL = cfg.asrModel; else delete env.DESK_PET_ASR_MODEL;
  writeEnvFile(env);
  // 热更新到正在运行的后端，保存后无需重启
  sendToBackend({
    type: 'config',
    payload: {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      model: cfg.model,
      chatModel: cfg.chatModel || '',
      city: cfg.city || '',
      asrProvider: cfg.asrProvider || '',
      asrApiKey: cfg.asrKey || '',
      asrApiUrl: cfg.asrUrl || '',
      asrModel: cfg.asrModel || ''
    }
  });
  // 配置动了就清掉语音识别的故障态，唤醒重新开始试
  clearAsrBlock();
  showPetBubble('API 配置已保存，立即生效～');
  return true;
}


function connectWebSocket() {
  // 每次连接都按当前配置算地址：改了 backend/.env 的 DESK_PET_PORT 后重连即生效
  WS_URL = `ws://localhost:${backendPort()}/ws`;
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('已连接到 Python 后端');
    wsReady = true;
    reconnectDelay = 1000;
    notifyPet('backend-status', true);
  });

  ws.on('close', () => {
    if (!wsReady) return;
    wsReady = false;
    notifyPet('backend-status', false);
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.log('WebSocket 连接失败（Python 后端可能还没启动）:', err.message);
    wsReady = false;
    scheduleReconnect();
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'guidance-delta' && msg.payload && selectionPending) {
        // 流式增量：转发给遮罩层实时追加显示（selectionPending 在最终结果时才复位）
        overlayWindow.webContents.send('show-result-delta', msg.payload);
      } else if (msg.type === 'guidance' && msg.payload && selectionPending) {
        selectionPending = false;
        // 把 AI 回答记入会话历史，供继续追问时组装上下文
        if (session && msg.payload.text) {
          session.history.push({ role: 'assistant', content: msg.payload.text });
        }
        overlayWindow.webContents.send('show-result', msg.payload);
        registerEscape();
        // 聊天卡片基本不自动消失（10 分钟仅作安全兜底），由用户 Esc/✕ 主动关闭；
        // 此前 60 秒经常读一半就被藏掉，不合理
        scheduleOverlayHide(600000);
      } else if (msg.type === 'chat-delta' && msg.payload) {
        // 闲聊流式增量：只发给聊天窗口（搜题链路只认 guidance-delta，两边不串台）
        sendToChat('chat-delta', msg.payload);
      } else if (msg.type === 'chat-reply' && msg.payload) {
        chatPending = false;
        const replyText = String(msg.payload.text || '');
        // 失败的回答（带 error）不进历史：下次闲聊别把它当成噜噜说过的话
        if (replyText && !msg.payload.error) {
          chatHistory.push({ role: 'assistant', content: replyText });
          trimChatHistory();
        }
        sendToChat('chat-reply', msg.payload);
      } else if (msg.type === 'error' && msg.payload) {
        // 后端回的通用错误。最常见的一种：跑着的后端还是旧版本（没有闲聊接口），
        // 它会回"未知消息类型: chat"——以前这条没人接，聊天窗口会一直卡在"正在想"。
        // 这里把它转给聊天窗口，并点明要重新编译后端。
        const why = String(msg.payload.text || '后端出错了');
        console.log(`后端返回错误: ${why}`);
        if (chatPending) {
          chatPending = false;
          sendToChat('chat-error', {
            text: `后端好像不认闲聊请求（${why}）。\n如果刚更新过代码，双击 build-backend.bat 重新编译后端再启动～`
          });
        }
      } else if (msg.type === 'voice-transcript' && msg.payload) {
        // 语音识别结果：转发给发起录音的页面；语音提问时也记入会话历史
        const isSelfTest = wakeSelfTestPending;
        if (isSelfTest) wakeSelfTestPending = false;
        // 聊天窗口的语音闲聊：结果只在聊天窗口里处理（成功 = 一条用户发言，失败 = 内联提示），
        // 不走下面那套"暂停唤醒 + 弹系统对话框"——用户只是在聊天，别被弹窗打断
        const fromChat = msg.payload.scope === 'chat';
        if (fromChat) {
          chatPending = false;
          if (msg.payload.error) {
            printWakeLog(`聊天语音识别失败[${msg.payload.errorCode || 'api_error'}]：`
              + String(msg.payload.hint || msg.payload.error || '').replace(/\s+/g, ' ').slice(0, 120));
          } else if (msg.payload.text) {
            // 识别成功：这句话就是用户的发言，记进闲聊历史（后端随后会推 chat-delta / chat-reply）
            chatHistory.push({ role: 'user', content: msg.payload.text });
            trimChatHistory();
          }
          sendToChat('chat-transcript', msg.payload);
        }
        const clip = msg.payload.scope === 'wake' ? lastWakeClip : null;
        // 这段录音"像不像有人在说话"：电平明显高过阈值才算，用来决定要不要冒泡
        const loud = !clip || !clip.thresholdBefore
          ? true
          : clip.peak >= clip.thresholdBefore * WAKE_LOUD_RATIO;
        if (msg.payload.error && !fromChat) {
          // 识别失败：分流处理（硬伤暂停唤醒 + 一次可操作提示；临时故障稍后自动恢复）
          // 连"这次录音多大声"一起记下来：一眼能分清"没人在说话"和"说话太小声"还是"识别服务出问题"
          const why = String(msg.payload.hint || msg.payload.error || '').replace(/\s+/g, ' ').slice(0, 120);
          printWakeLog(`识别失败[${msg.payload.errorCode || 'api_error'}]：${why}`
            + (clip ? `（这段录音峰值 ${clip.peak.toFixed(4)} / 阈值 ${clip.thresholdBefore.toFixed(4)}）` : ''));
          handleVoiceError(msg.payload, { skipPrompt: isSelfTest, loud });
        } else if (msg.payload.scope === 'wake' && msg.payload.text) {
          // 唤醒模式下的识别结果都打进日志：能立刻看出是"没听到"还是"听到的字不对"
          const hit = msg.payload.wakeResult === 'hit';
          printWakeLog(`识别到「${msg.payload.text}」→ ${hit ? '含唤醒词' : '没有唤醒词，忽略'}`);
          // 听着就是在喊它（含"噜/露/鹿…"这种同音字）却没匹配上唤醒词：多半是识别成了
          // 唤醒词表里没有的同音组合（比如"卢鲁"）——冒个泡让人一眼看出该往表里加什么
          if (!hit && containsWakeWordLike(msg.payload.text)) noteWakeMiss(msg.payload.text);
        }
        if (isSelfTest) showSelfTestResult(msg.payload);
        if (!fromChat && overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
          overlayWindow.webContents.send('voice-transcript', msg.payload);
        }
        if (!fromChat && msg.payload.text && session) {
          session.history.push({ role: 'user', content: msg.payload.text });
        }
      } else if (msg.type === 'wake-triggered' && msg.payload) {
        // 语音唤醒命中（"噜噜，这个题怎么做"）：截屏 → 弹出框选遮罩，
        // 用户说的话作为补充描述预填，框选确认后直接带着分析
        if (petWindow && !petWindow.isDestroyed()) {
          petWindow.webContents.send('wake-triggered', msg.payload);
        }
        // 让用户看得见"它以为听到了什么"——万一是误唤醒，一眼就知道是什么触发的。
        // 现在气泡放得下更多字（窗口 460 宽），截断从 8 字放宽到 16 字，看得更清楚
        const heard = String(msg.payload.question || '').trim();
        const short = heard ? `「${heard.slice(0, 16)}${heard.length > 16 ? '…' : ''}」` : '';
        printWakeLog(`唤醒命中，开始截屏框选${short ? '（听到 ' + short + '）' : ''}`);
        if (heard) showPetBubble(`听到「${heard.slice(0, 16)}${heard.length > 16 ? '…' : ''}」`);
        wakeVoiceQuestion = stripWakeWord(heard);
        if (triggerVoiceSelection) triggerVoiceSelection();
      } else if (msg.type === 'guidance' && msg.payload) {
        // 非框选流程的分析结果（旧模式兼容）：气泡 + 绿框
        if (msg.payload.highlight) {
          overlayWindow.webContents.send('show-highlight', msg.payload);
          registerEscape();
          scheduleOverlayHide();
        }
        if (msg.payload.text) {
          // 走 showPetBubble：过长的分析文本会被截断，不会把气泡撑出窗口
          showPetBubble(msg.payload.text);
        }
      }
    } catch (e) {
      console.error('消息解析失败:', e);
    }
  });
}

function scheduleReconnect() {
  setTimeout(() => {
    console.log('尝试重新连接后端…');
    connectWebSocket();
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }, reconnectDelay);
}

function sendToBackend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// 追问/语音提问时随消息带上的会话上下文（原截图、选区、历史对话）
function sessionPayload() {
  if (!session) return {};
  return {
    question: '',
    history: session.history,
    image: session.image,
    region: session.region,
    displaySize: session.displaySize,
    originalNote: session.note
  };
}

// 语音输入需要麦克风：file:// 页面不触发系统权限弹窗，主进程直接放行
// 注意：Electron 20+ 权限处理器挂在 session 上而非 webContents 上
app.commandLine.appendSwitch('enable-features', 'AutoplayIgnoreWebAudio');
app.whenReady().then(() => {
  const { session } = require('electron');
  const allow = ['microphone', 'media'];
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allow.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    return allow.includes(permission);
  });
});

// 给桌宠页面发消息。注意一定要按传入的 channel 发：这里以前写死了 'backend-status'，
// 于是 pauseWakeForAsr / hideOverlay / 托盘开关 发的 'wake-listen' 全都没到桌宠页面
// （pet.js 监听的是 'wake-listen'），麦克风在框选期间也一直在监听——
// 表现出来就是"没人叫它，它自己又冒泡、又把遮罩弹出来"。
// extra 用来捎带听音灵敏度系数（见 notifyWakeListen）。
function notifyPet(channel, data, extra) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send(channel, data, extra);
  }
}

// 疑似误唤醒：把听音灵敏度往下调一档（主进程算系数，桌宠下次校准阈值时生效）
function noteFalseWake() {
  wakeBump = Math.min(WAKE_BUMP_MAX, wakeBump * WAKE_BUMP_FACTOR);
  console.log(`[wake] 疑似误唤醒（遮罩弹出后立刻被关掉、也没框选）：听音灵敏度系数 ×${wakeBump.toFixed(2)}`);
  showPetBubble('这次好像是我听岔了，已经把听音灵敏度调低一点～');
}

function hideOverlay() {
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
    unregisterEscape();
  }
  // 语音唤醒弹出来的遮罩，如果几乎立刻就被关掉、也没真去框选分析，基本可以断定是它听岔了
  // （外放视频/旁边有人说话被当成"喊噜噜"）：自动把灵敏度调低，别一次次打扰人
  if (overlayFromWake && !overlayConfirmed && overlayShownAt &&
      Date.now() - overlayShownAt < WAKE_FALSE_TRIGGER_MS) {
    noteFalseWake();
  }
  overlayFromWake = false;
  overlayShownAt = 0;
  overlayConfirmed = false;
  // 遮罩一隐藏就复位等待状态：如果上一次请求丢了响应（如后端重启），
  // selectionPending 卡在 true 会让后续所有截图请求被静默丢弃
  if (selectionPending) {
    selectionPending = false;
    console.log('遮罩隐藏时复位了未完成的等待状态');
  }
  session = null;
  // 遮罩关了，恢复语音唤醒监听。注意要按真实状态发：
  // ① 托盘里关掉唤醒后不能因为关遮罩又被打开；② 语音识别有硬伤（余额不足等）时保持暂停，
  //    否则一说话又是一次失败请求；③ 聊天窗口还开着的话继续暂停（那边在用麦克风）
  notifyWakeListen(wakeShouldListen());
}

let overlayHideTimer = null;

function scheduleOverlayHide(delay = 30000) {
  clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(hideOverlay, delay);
}

// 遮罩上持续操作时（如拖动绿框），不断续期自动隐藏计时
// 注意：包一层箭头函数，避免 IPC event 对象被当成 delay 参数传进去
ipcMain.on('overlay-activity', () => scheduleOverlayHide());

function registerEscape() {
  if (escRegistered) return;
  escRegistered = true;
  globalShortcut.register('Escape', hideOverlay);
}

function unregisterEscape() {
  if (!escRegistered) return;
  escRegistered = false;
  globalShortcut.unregister('Escape');
}

// 桌宠页面的 [wake] 日志有两条路都会打到终端：渲染进程的 console（下面 console-message 转发）
// 和 IPC 上报（wake-status）。两条路都留着更稳（万一某条路断了还能看见），
// 但同一句话会被打印两次，看起来像"监听启动了两遍"，这里把紧挨着的重复行吃掉。
let lastWakeLog = { text: '', at: 0 };

function printWakeLog(text) {
  const now = Date.now();
  if (text === lastWakeLog.text && now - lastWakeLog.at < 300) return;
  lastWakeLog = { text, at: now };
  console.log('[wake] ' + text);
  appendWakeLog(text);   // 同时落盘：启动桌宠.bat 起的没有终端，只能翻日志文件
}

function createPetWindow() {
  // 尺寸见 PET_WINDOW_SIZE：气泡要能整个显示在宠物头顶上，所以窗口比宠物大得多
  petWindow = new BrowserWindow({
    width: PET_WINDOW_SIZE.width,
    height: PET_WINDOW_SIZE.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  // 把桌宠页面的 [wake] 日志转到终端：渲染进程的 console 默认不显示在 npm start 里，
  // 而排查"喊他没反应"必须能看到它到底有没有听到、识别成什么字
  petWindow.webContents.on('console-message', (e, level, message) => {
    const lvl = level && typeof level === 'object' ? level.level : level;
    const msg = level && typeof level === 'object' ? level.message : message;
    if (typeof msg === 'string' && msg.includes('[wake]')) printWakeLog(msg.replace(/^\[wake\]\s*/, ''));
    if (/error/i.test(String(lvl || '')) && typeof msg === 'string' && !msg.includes('[wake]')) {
      console.log('桌宠页面报错:', msg);
    }
  });
  petWindow.loadFile('pet.html');
  petWindow.setAlwaysOnTop(true, 'screen-saver');
}

// 气泡窗口：只负责显示一句话。位置跟着宠物走，整个窗口点击穿透（不接收鼠标事件），
// 所以既不会挡住桌面点击，也不用依赖 Electron 的 forward 鼠标转发（实测那套很挑时机，
// 时机不对会让窗口变成"点不动"，气泡这边完全不需要它）
function createBubbleWindow() {
  bubbleWindow = new BrowserWindow({
    width: BUBBLE_WINDOW_SIZE.width,
    height: BUBBLE_WINDOW_SIZE.height,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,   // 永不抢焦点：冒个气泡不该打断用户正在做的事
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  bubbleWindow.setAlwaysOnTop(true, 'screen-saver'); // 和桌宠同层级，别被压到下面
  bubbleWindow.setIgnoreMouseEvents(true);
  bubbleWindow.loadFile('bubble.html');
  // 页面里报错能在终端看到（不然只能靠 DevTools）
  bubbleWindow.webContents.on('console-message', (e, level, message) => {
    const lvl = level && typeof level === 'object' ? level.level : level;
    const msg = level && typeof level === 'object' ? level.message : message;
    if (lvl === 'error') console.log(`[气泡窗口] ${msg}`);
  });
}

// 把气泡窗口摆到宠物头顶正上方：
//   气泡贴窗口底边（bubble.html 里 body 有 8px 下内边距留给小尾巴），
//   所以"窗口底边比宠物头顶高 9px"= 气泡底边离宠物头顶 17px、尾巴尖离头顶 10px
function positionBubbleWindow() {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  if (!petWindow || petWindow.isDestroyed()) return;
  const p = petWindow.getBounds();
  const petTop = p.y + p.height - PET_IMG_HEIGHT;   // 宠物贴着小窗底边，头顶在这儿
  const petCenterX = Math.round(p.x + p.width / 2);
  let x = Math.round(petCenterX - BUBBLE_WINDOW_SIZE.width / 2);
  const y = Math.round(petTop - BUBBLE_WINDOW_SIZE.height - BUBBLE_ABOVE_PET_PX);
  // 宠物贴着屏幕左右边缘时把窗口往回收，免得气泡被屏幕边缘裁掉（尾巴会略微偏一点）
  const d = screen.getDisplayNearestPoint({ x: petCenterX, y: petTop }).bounds;
  x = Math.min(Math.max(x, d.x), Math.max(d.x, d.x + d.width - BUBBLE_WINDOW_SIZE.width));
  bubbleWindow.setBounds({ x, y, width: BUBBLE_WINDOW_SIZE.width, height: BUBBLE_WINDOW_SIZE.height });
}

function createOverlayWindow() {
  // 用整个显示器的 boundingRect 对齐（而不是 workArea），
  // 与整屏截图坐标系一致，避免任务栏占位导致框选裁剪偏移
  const b = screen.getPrimaryDisplay().bounds;
  overlayWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  overlayWindow.loadFile('overlay.html');
  // 必须带 forward: true，穿透时鼠标移动事件才会转发给页面，
  // 页面才能检测到"鼠标在绿框上"并接管鼠标实现拖动
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
}

function createTray() {
  // 兜底托盘图标（16x16 纯色方块），避免缺少图标文件时崩溃
  const icon = nativeImage.createFromBuffer(
    Buffer.from([89, 50, 68, 66]), // 占位，真实图标见 assets/tray.png
    { width: 1, height: 1 }
  );
  tray = new Tray(icon);
  tray.setToolTip('Desk Pet');
  const menu = Menu.buildFromTemplate([
    { label: '截图问一问', click: () => petWindow.webContents.send('trigger-screenshot') },
    { label: '和噜噜聊天…', click: openChatWindow },
    { label: '语音唤醒自检…', click: startWakeSelfTest },
    { label: '查看语音唤醒日志', click: openWakeLog },
    { label: '语音唤醒"噜噜"', type: 'checkbox', checked: voiceWakeEnabled, click: (item) => setVoiceWake(item.checked) },
    { label: '投喂橘子 🍊', click: () => petWindow.webContents.send('feed-pet') },
    { label: 'API 设置…', click: openSettingsWindow },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: ['.']
        });
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => petWindow.show());
}

// 语音唤醒开关（托盘/设置页通用）：关闭时通知桌宠停掉麦克风监听
function setVoiceWake(enabled) {
  voiceWakeEnabled = !!enabled;
  if (voiceWakeEnabled) {
    // 重新打开唤醒时顺手清掉语音识别的故障态，让用户改完配置能直接重试
    asrBlocked = null;
    asrPromptShown = false;
    clearTimeout(asrPauseTimer);
    asrPauseTimer = null;
    // 也把"误唤醒自愈"调的灵敏度复位：重新打开唤醒 = 回到默认灵敏度
    wakeBump = 1;
  }
  notifyWakeListen(wakeShouldListen());
  showPetBubble(voiceWakeEnabled ? '语音唤醒已开启，喊"噜噜"就能提问啦～' : '语音唤醒已关闭');
}

// ============ 语音唤醒自检 ============
// 让桌宠强制开一次监听，用户说一句话，这里把原始识别结果/报错原样展示出来：
// 「没听到」→ 麦克风或阈值问题；「听到xx但没唤醒词」→ 同音字问题；「识别失败」→ ASR 配置问题
let wakeSelfTestPending = false;

function startWakeSelfTest() {
  if (!petWindow || petWindow.isDestroyed()) return;
  wakeSelfTestPending = true;
  petWindow.show();
  petWindow.webContents.send('wake-self-test');
  console.log('[wake] 已发起语音唤醒自检，请对着电脑说一句「噜噜，这个题怎么做」');
}

function showSelfTestResult(payload) {
  const owner = petWindow && !petWindow.isDestroyed() ? petWindow : null;
  const hasError = !!payload.error;
  const heard = (payload.text || '').trim();
  // 这段录音的电平（pet.js 随音频一起报上来的）：直接回答"喊他没反应"最常见的两种原因
  // ——声音没到触发线，还是识别出来的字不对
  const lv = lastSelfTestInfo;
  let levelLine = '';
  if (lv) {
    levelLine = `\n\n麦克风电平：这句最高 ${lv.peak.toFixed(4)}，录音前触发阈值 ${lv.thresholdBefore.toFixed(4)}`;
    if (lv.learned) {
      levelLine += `\n已按这句把触发阈值校准为 ${lv.thresholdAfter.toFixed(4)}：再喊一次「噜噜」应该就能唤醒`;
    } else if (lv.peak < lv.thresholdBefore) {
      levelLine += '\n⚠️ 说话电平低于触发阈值：麦克风增益太低或离得太远，'
        + '把系统麦克风音量调高后重新自检一次（说满 1 秒以上才会用来校准）';
    } else {
      levelLine += '\n✅ 电平够触发，阈值保持不动';
    }
  }
  const detail = hasError
    ? [payload.error, payload.hint].filter(Boolean).join('\n\n') + levelLine
    : (heard
      ? `识别到的文字：\n「${heard}」\n` + (containsWakeWordLike(heard)
        ? '✅ 含唤醒词，正常应该已经触发框选了'
        : '⚠️ 里面没有「噜噜」：换个说法（说慢一点、靠近麦克风）再试，或把这句话原样发我看看') + levelLine
      : '识别结果为空：麦克风可能没录到声音，检查系统的输入设备与音量' + levelLine);
  dialog.showMessageBox(owner, {
    type: hasError ? 'warning' : 'info',
    title: '语音唤醒自检结果',
    message: hasError ? '语音识别失败' : (heard ? '它听到了这句话' : '没听清'),
    detail,
    buttons: ['打开 API 设置', '知道了'],
    defaultId: hasError ? 0 : 1,
    cancelId: 1,
    noLink: true
  }).then((r) => {
    if (r.response === 0) openSettingsWindow();
  }).catch(() => { /* 忽略 */ });
}

// 自检结果里的粗判（和后端 WAKE_WORDS 保持一致，只看有没有"噜/露/鹿…"这类同音字）
function containsWakeWordLike(text) {
  return /[噜露卢撸路陆卤鲁鹿录碌]{2}|lulu|lvlu/.test((text || '').toLowerCase());
}

// 明明听着像在喊它、却没匹配上唤醒词（识别成了"卢鲁""噜鲁"这种没收录的同音组合）：
// 冒个泡 + 落日志，一眼就知道该往 backend 的 WAKE_WORDS 里加什么词。
// 限流 60 秒，免得说一句提醒一次。
function noteWakeMiss(text) {
  printWakeLog(`听到「${text}」像在喊唤醒词，但没匹配上（同音字没收录？）`);
  const now = Date.now();
  if (now - lastWakeMissAt < WAKE_MISS_HINT_GAP_MS) return;
  lastWakeMissAt = now;
  showPetBubble(`听到「${String(text).slice(0, 12)}」了，但这不算唤醒词～`);
}

// ============ API 设置窗口 ============
let settingsWindow = null;

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 780,   // 多了「噜噜的闲聊」（城市 + 闲聊模型）一栏，窗口要够高
    resizable: false,
    title: 'API 设置',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ============ 闲聊窗口（右键桌宠 / 托盘 →「和噜噜聊天…」） ============
// 一个独立的"陪聊"窗口：气泡列表 + 输入框 + 🎤 语音，和搜题链路完全分开
// （不带截图、不弹遮罩、回答不走 guidance）。窗口位置跟着桌宠走，就像在跟它说话。
const CHAT_WINDOW_SIZE = { width: 380, height: 540 };

function chatWindowBounds() {
  const { width, height } = CHAT_WINDOW_SIZE;
  const p = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
  if (!p) {
    const d = screen.getPrimaryDisplay().workArea;
    return { x: d.x + d.width - width - 24, y: d.y + d.height - height - 24, width, height };
  }
  const d = screen.getDisplayNearestPoint({ x: p.x, y: p.y }).workArea;
  // 默认摆在桌宠右边；右边放不下就摆左边，再夹回屏幕内
  let x = p.x + p.width + 8;
  if (x + width > d.x + d.width) x = p.x - width - 8;
  x = Math.min(Math.max(x, d.x), Math.max(d.x, d.x + d.width - width));
  // 竖着让窗口底边和桌宠底边对齐：视线不用来回跳
  let y = p.y + p.height - height;
  y = Math.min(Math.max(y, d.y), Math.max(d.y, d.y + d.height - height));
  return { x: Math.round(x), y: Math.round(y), width, height };
}

function openChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.show();
    chatWindow.focus();
    return;
  }
  const b = chatWindowBounds();
  chatWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 320,
    minHeight: 420,
    frame: false,                 // 标题栏自己画（和桌宠一个风格，见 chat.html）
    backgroundColor: '#f2f6f4',
    title: '和噜噜聊天',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  chatWindow.loadFile('chat.html');
  chatWindow.on('closed', () => {
    chatWindow = null;
    // 聊天窗口关了：如果本来还在聊语音，顺手把状态复位，别让下一条回复发进已经没了的窗口
    chatPending = false;
    // 麦克风让回给语音唤醒（托盘关过唤醒 / 识别故障时 wakeShouldListen 仍会返回 false）
    notifyWakeListen(wakeShouldListen());
  });
  chatWindow.webContents.on('console-message', (e, level, message) => {
    const lvl = level && typeof level === 'object' ? level.level : level;
    const msg = level && typeof level === 'object' ? level.message : message;
    if (lvl === 'error') console.log(`[聊天窗口] ${msg}`);
  });
  // 聊天时暂停语音唤醒：否则两个渲染进程同时开麦克风，聊着聊着遮罩会突然弹出来
  notifyWakeListen(false);
}

function sendToChat(channel, payload) {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send(channel, payload);
}

// 历史只留最近 CHAT_HISTORY_MAX 条，并且必须以"用户说的话"开头：
// 截断之后第一条是 assistant 的话，模型容易接不上上下文
function trimChatHistory() {
  if (chatHistory.length > CHAT_HISTORY_MAX) {
    chatHistory = chatHistory.slice(-CHAT_HISTORY_MAX);
  }
  while (chatHistory.length && chatHistory[0].role !== 'user') chatHistory.shift();
}

// 闲聊请求的公共部分：这一轮的文字 + 历史 + 城市（天气要用，见 backend 的 _city_from_payload）
function chatPayload(text) {
  return { text, history: chatHistory, city: readEnvFile().DESK_PET_CITY || '' };
}

function sendChatMessage(text) {
  const q = typeof text === 'string' ? text.trim() : '';
  if (!q || chatPending) return;
  // 先发（此时的 history 不含这一句），再把这一句记进历史
  const sent = sendToBackend({ type: 'chat', payload: chatPayload(q) });
  if (!sent) {
    sendToChat('chat-error', { text: '我还没连上后端呢…先在终端跑一下 npm run backend 再聊？' });
    return;
  }
  chatPending = true;
  chatHistory.push({ role: 'user', content: q });
  trimChatHistory();
}

function sendChatVoice(audio) {
  if (chatPending) return;
  // 语音闲聊：识别出的话由后端直接接上回复（mode=chat），省一次来回
  const sent = sendToBackend({ type: 'voice', payload: { audio, mode: 'chat', ...chatPayload('') } });
  if (!sent) {
    sendToChat('chat-error', { text: '我还没连上后端呢…等一下再试？' });
    return;
  }
  chatPending = true;
}

// 清空话题：历史一清、窗口里也清（另外给个招呼语，别留一屏空白）
function resetChat() {
  chatHistory = [];
  chatPending = false;
  sendToChat('chat-reset-done', { text: '话题清空啦，想聊点什么？' });
}

app.whenReady().then(() => {
  createPetWindow();
  createBubbleWindow();
  createOverlayWindow();
  createTray();
  ensureBackendRunning();
  connectWebSocket();

  // 启动时把当前语音识别配置和排查入口打出来，省得靠猜：
  // 一眼能看出是"跟随主服务商走收费的 glm-asr"还是"已经切到免费的硅基流动"
  resetWakeLogIfHuge();
  appendWakeLog('===== 桌宠启动 =====');
  const envCfg = readEnvFile();
  const asrProvider = envCfg.DESK_PET_ASR_PROVIDER || envCfg.DESK_PET_PROVIDER || 'glm';
  const asrKey = envCfg.DESK_PET_ASR_API_KEY || envCfg.DESK_PET_API_KEY;
  console.log(`[wake] 语音识别: provider=${asrProvider}, model=${envCfg.DESK_PET_ASR_MODEL || '(默认)'}, key=${asrKey ? '已设置' : '未设置'}`);
  console.log(`[wake] 后端地址: ${WS_URL}（可在 backend/.env 里用 DESK_PET_PORT 改端口）`);
  const exePath = backendExecutable();
  console.log(exePath
    ? `[wake] 后端模式: 打包版 ${path.basename(exePath)}（不需要 Python）`
    : '[wake] 后端模式: 源码模式（需要 Python 与 pip install -r requirements.txt）');
  console.log('[wake] 喊「噜噜」没反应时：右键桌宠 →「语音唤醒自检…」，自检弹窗会显示');
  console.log('[wake]   ① 它到底听到了什么字  ② 你说话的电平够不够触发（并顺手把阈值按这句校准）');
  console.log(`[wake] 完整日志也会写到: ${WAKE_LOG_PATH}（右键桌宠 / 托盘 →「查看语音唤醒日志」）`);

  // 用户点击桌宠 → 截图存起来 → 弹出框选遮罩
  ipcMain.handle('pet-clicked', async () => {
    const ok = await startSelectionFlow(false);
    if (!ok) return false;
    wakeVoiceQuestion = ''; // 手动点击时清掉可能残留的语音问题
    return true;
  });

  // 统一入口：截屏 → 弹出框选遮罩；唤醒触发时把语音问题带进遮罩层。
  // fromWake 用来区分"这次遮罩是喊醒它弹的"还是"用户自己点的"——
  // 前者如果被立刻关掉，就当成一次误唤醒去调低听音灵敏度（见 hideOverlay）
  async function startSelectionFlow(fromWake) {
    const captured = await captureScreen();
    if (!captured) {
      showPetBubble('截图失败了，再试一次吧');
      return false;
    }
    lastCapture = captured;
    overlayFromWake = !!fromWake;
    showSelectionOverlay();
    if (wakeVoiceQuestion) {
      overlayWindow.webContents.send('voice-question-prefill', { text: wakeVoiceQuestion });
      wakeVoiceQuestion = '';
    }
    return true;
  }

  function startVoiceTriggeredSelection() {
    if (!voiceWakeEnabled) { wakeVoiceQuestion = ''; return; }
    startSelectionFlow(true).catch((e) => {
      console.error('语音唤醒触发框选失败:', e);
      wakeVoiceQuestion = '';
    });
  }
  triggerVoiceSelection = startVoiceTriggeredSelection; // 桥接给顶层 ws 处理器

  async function captureScreen() {
    // 关键：必须按"逻辑尺寸 × DPI 缩放系数"请求截图，否则高分屏拿到的是空图片。
    // 多显示器：cursor 位置决定截图哪块屏（desktopCapturer 的 screen 顺序与 screen.getAllDisplays 一致）
    const cursor = screen.getCursorScreenPoint();
    const displays = screen.getAllDisplays();
    const display = displays.find(d =>
      cursor.x >= d.workArea.x && cursor.x < d.workArea.x + d.workArea.width &&
      cursor.y >= d.workArea.y && cursor.y < d.workArea.y + d.workArea.height
    ) || screen.getPrimaryDisplay();
    // desktopCapturer 返回的 screen source 顺序与 getAllDisplays() 一致，按索引取对应屏幕
    const displayIndex = displays.indexOf(display);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor)
      }
    });
    if (!sources || !sources[0]) return null;
    const source = sources[displayIndex] || sources[0];
    return {
      image: source.thumbnail.toDataURL(),
      scaleFactor: display.scaleFactor,
      displayBounds: display.bounds,
      displayId: display.id
    };
  }

  function showSelectionOverlay() {
    // 多显示器：遮罩移到鼠标所在的屏幕，截图截的也是同一块屏
    const cursor = screen.getCursorScreenPoint();
    const displays = screen.getAllDisplays();
    const display = displays.find(d =>
      cursor.x >= d.bounds.x && cursor.x < d.bounds.x + d.bounds.width &&
      cursor.y >= d.bounds.y && cursor.y < d.bounds.y + d.bounds.height
    ) || screen.getPrimaryDisplay();
    const b = display.bounds;
    overlayWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    overlayWindow.webContents.send('show-highlight', {});
    overlayWindow.show();
    overlayWindow.focus();
    registerEscape();
    scheduleOverlayHide();
    // 记下"这次遮罩什么时候弹的、用户有没有真去框选"，hideOverlay 里靠它判断误唤醒
    overlayShownAt = Date.now();
    overlayConfirmed = false;
    // 框选期间暂停语音唤醒监听，避免录音里混进遮罩提示音/系统声。
    // 这条消息以前发错了通道（永远发到 'backend-status'），所以麦克风一直在听，
    // 框选过程中还会被自己听到的声音再次"唤醒"——现在改成真的发到 'wake-listen'
    notifyWakeListen(false);
  }

  // 用户在遮罩上按回车（可先补充描述）→ 把框选区域和描述发给后端分析
  ipcMain.on('confirm-selection', (event, rect, note) => {
    if (!lastCapture || selectionPending) return;
    // 分析期间停掉自动隐藏，等结果或超时再收尾，否则遮罩会中途消失
    clearTimeout(overlayHideTimer);
    const sf = lastCapture.scaleFactor;
    // 框选坐标是遮罩窗口内的逻辑像素，加显示器原点偏移得到屏幕全局坐标，
    // 再乘 DPI 缩放系数转成截图（物理像素）里的坐标
    const origin = lastCapture.displayBounds || { x: 0, y: 0 };
    const phys = {
      x: Math.max(0, Math.round((rect.x + origin.x) * sf)),
      y: Math.max(0, Math.round((rect.y + origin.y) * sf)),
      w: Math.round(rect.w * sf),
      h: Math.round(rect.h * sf)
    };
    const userNote = typeof note === 'string' ? note.trim() : '';
    // 建立新会话：记住本次截图、选区、补充描述，追问时一并发给后端
    session = {
      image: lastCapture.image,
      region: phys,
      displaySize: {
        width: Math.round(rect.w * sf),
        height: Math.round(rect.h * sf)
      },
      note: userNote,
      history: []
    };
    selectionPending = true;
    overlayConfirmed = true; // 用户真的框选+回车分析了，这次遮罩不算误唤醒
    const sent = sendToBackend({
      type: 'screenshot',
      payload: {
        image: lastCapture.image,
        region: phys,
        displaySize: session.displaySize,
        note: userNote
      }
    });
    // 后端没连上时立刻反馈，别让遮罩傻等 30 秒超时
    if (!sent) {
      selectionPending = false;
      session = null;
      overlayWindow.webContents.send('show-result', {
        text: '后端未连接：请先在终端运行 npm run backend 再试'
      });
    }
  });

  // 用户在聊天卡片里继续追问：带上原截图、选区和对话历史发给后端
  ipcMain.on('followup-question', (event, question) => {
    if (!session || selectionPending) return;
    const q = typeof question === 'string' ? question.trim() : '';
    if (!q) return;
    clearTimeout(overlayHideTimer);
    selectionPending = true;
    const sent = sendToBackend({
      type: 'followup',
      payload: {
        question: q,
        history: session.history,
        image: session.image,
        region: session.region,
        displaySize: session.displaySize,
        originalNote: session.note
      }
    });
    if (sent) {
      session.history.push({ role: 'user', content: q });
    } else {
      selectionPending = false;
      overlayWindow.webContents.send('show-result', {
        text: '后端未连接：请先在终端运行 npm run backend 再试'
      });
    }
  });

  // 语音输入：渲染进程录好音（dataURL），转发给后端识别
  // mode=transcribe 仅转文字回填输入框；mode=ask 转文字后直接按追问流程分析
  ipcMain.on('voice-transcribe', (event, audio) => {
    sendToBackend({ type: 'voice', payload: { audio, mode: 'transcribe' } });
  });
  ipcMain.on('voice-question', (event, audio) => {
    if (!session) return;
    sendToBackend({ type: 'voice', payload: { audio, mode: 'ask', ...sessionPayload() } });
  });

  // 语音唤醒：桌宠端持续监听麦克风，说"噜噜…"后录音交给后端检测唤醒词，
  // 命中后由 ws.on('message') 里的 wake-triggered 分支自动截屏弹出框选
  ipcMain.on('wake-listen-audio', (event, audio, meta) => {
    if (!voiceWakeEnabled) return;
    lastWakeClip = meta || null;
    sendToBackend({ type: 'voice', payload: { audio, mode: 'wake' } });
  });

  // 语音唤醒自检：桌宠端强制录一句，这里按普通转写送给后端，结果弹窗原样展示
  // （不受唤醒开关/故障暂停影响：正是为了在"没反应"时能看到真实原因）
  ipcMain.on('wake-self-test-audio', (event, audio, meta) => {
    lastSelfTestInfo = meta || null;
    if (!sendToBackend({ type: 'voice', payload: { audio, mode: 'transcribe' } })) {
      wakeSelfTestPending = false;
      console.log('[wake] 自检失败：后端未连接，请先 npm run backend');
      showPetBubble('后端没连上，自检发不出去 😥');
    }
  });

  // 桌宠页面的 [wake] 日志（音量、阈值、听的什么字）转到终端
  ipcMain.on('wake-status', (event, text) => printWakeLog(String(text)));

  ipcMain.handle('get-voice-wake-enabled', () => voiceWakeEnabled);

  // 结果文字复制（file:// 页面里 navigator.clipboard 不可靠，走主进程最稳）
  ipcMain.on('copy-text', (event, text) => {
    if (typeof text === 'string' && text) clipboard.writeText(text);
  });

  // 遮罩层里的"打开 API 设置"链接（语音识别报错时引导用户去改配置）
  ipcMain.on('open-settings', () => openSettingsWindow());

  // ============ 闲聊窗口（chat.html） ============
  // 窗口自己发起的动作：发消息、语音、清空话题、关闭窗口、进来时拉一次历史
  ipcMain.on('open-chat', () => openChatWindow());
  ipcMain.handle('get-chat-history', () => chatHistory);
  ipcMain.on('chat-message', (event, text) => sendChatMessage(text));
  ipcMain.on('chat-voice', (event, audio) => sendChatVoice(audio));
  ipcMain.on('chat-reset', () => resetChat());
  ipcMain.on('close-chat-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

  // 输入框聚焦时临时停用全局 Esc，避免打字时按 Esc 把整个遮罩关掉
  ipcMain.on('set-escape-enabled', (event, enabled) => {
    if (enabled) registerEscape(); else unregisterEscape();
  });

  // 处理点击穿透开关
  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.setIgnoreMouseEvents(ignore, options);
  });

  // 桌宠页面自己冒的气泡（悬停小动作、睡觉、唤醒自检…）也走同一条路，
  // 统一在气泡窗口里显示 + 统一截断
  ipcMain.on('show-pet-bubble', (event, text) => showPetBubble(text));

  // 处理窗口拖动
  ipcMain.on('move-window', (event, x, y) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.setPosition(Math.round(x), Math.round(y));
    // 气泡显示中就把它一起挪过去，别让气泡跟不上宠物（气泡窗口是独立的窗口）
    if (win === petWindow && bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
      positionBubbleWindow();
    }
  });

  // 隐藏高亮遮罩
  ipcMain.on('hide-overlay', () => {
    selectionPending = false;
    hideOverlay();
  });

  // 右键菜单
  ipcMain.on('show-context-menu', () => {
    Menu.buildFromTemplate([
      { label: '截图问一问', click: () => petWindow.webContents.send('trigger-screenshot') },
      { label: '和噜噜聊天…', click: openChatWindow },
      { label: '语音唤醒自检…', click: startWakeSelfTest },
      { label: '查看语音唤醒日志', click: openWakeLog },
      { label: '语音唤醒"噜噜"', type: 'checkbox', checked: voiceWakeEnabled, click: (item) => setVoiceWake(item.checked) },
      { label: '投喂橘子 🍊', click: () => petWindow.webContents.send('feed-pet') },
      { label: 'API 设置…', click: openSettingsWindow },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]).popup();
  });

  // ============ API 配置读写 ============
  ipcMain.handle('get-api-config', () => getApiConfig());
  ipcMain.handle('save-api-config', (event, cfg) => saveApiConfig(cfg || {}));
  ipcMain.on('close-settings-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });
});

// ============ 后端自动拉起（开机自启场景下无需手动 npm run backend） ============
let backendProc = null;

// 后端端口：默认 8000。端口被别的程序占用时，可以在 backend/.env 里加 DESK_PET_PORT=8011
// （前端读这个值连 WebSocket，后端启动时读同一个值监听，改一处即可）
function backendPort() {
  return Number(process.env.DESK_PET_PORT) || Number(readEnvFile().DESK_PET_PORT) || 8000;
}

// Python 解释器候选：Windows 上一般叫 python，装了官方版也有 py 启动器；
// macOS/Linux 上往往只有 python3。可用 DESK_PET_PYTHON 指定绝对路径。
function pythonCandidates() {
  if (process.env.DESK_PET_PYTHON) return [process.env.DESK_PET_PYTHON];
  return process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
}

// 打包好的后端可执行文件（build-backend.bat 用 PyInstaller 生成）：有它就完全不需要 Python。
// 放在 backend/ 或 backend/dist/ 下都认，文件名固定 deskpet-backend(.exe)
function backendExecutable() {
  const custom = process.env.DESK_PET_BACKEND_EXE;
  if (custom && fs.existsSync(custom)) return custom;
  const names = process.platform === 'win32' ? ['deskpet-backend.exe'] : ['deskpet-backend'];
  for (const dir of [path.join(__dirname, 'backend'), path.join(__dirname, 'backend', 'dist')]) {
    for (const name of names) {
      const exe = path.join(dir, name);
      if (fs.existsSync(exe)) return exe;
    }
  }
  return '';
}

// 依次尝试候选命令：进程能活下来就算成功（命令不存在或起来就退，都换下一个）
// attempts: [{ cmd, args }]，例如打包版 [{ cmd: '...deskpet-backend.exe', args: [] }]、
// 源码模式 [{ cmd: 'python', args: ['-u', 'backend/main.py'] }, { cmd: 'py', ... }]
function spawnBackend(attempts, cwd, onFail, label) {
  if (!attempts.length) {
    onFail();
    return;
  }
  const [{ cmd, args }, ...rest] = attempts;
  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd,
      // 把后端日志转发到终端（npm start 里能看到 [后端] 开头的输出）
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true
    });
  } catch (e) {
    spawnBackend(rest, cwd, onFail, label); // 极端情况下 spawn 直接抛错
    return;
  }
  proc.unref();
  if (proc.stdout) proc.stdout.on('data', (d) => process.stdout.write(`[后端] ${d}`));
  if (proc.stderr) proc.stderr.on('data', (d) => process.stdout.write(`[后端] ${d}`));
  let alive = false;
  proc.on('error', (e) => {
    // 命令不存在（ENOENT）：静默试下一个，别让未处理的 error 事件把主进程搞崩
    console.log(`后端启动失败（${cmd} 不可用：${e.message}），换下一个试试`);
    spawnBackend(rest, cwd, onFail, label);
  });
  proc.once('exit', (code) => {
    backendProc = null;
    if (alive) {
      console.log(`后端进程退出（code=${code}）`);
      return;
    }
    // 起来就挂：多半是依赖没装好或端口被别的程序占用了
    console.log(`后端用 ${cmd} 启动后立刻退出（code=${code}），换下一个试试`);
    spawnBackend(rest, cwd, onFail, label);
  });
  // 撑过 3 秒就认为起来了（uvicorn 开始监听）
  setTimeout(() => {
    alive = true;
    if (backendProc === proc) console.log(`已拉起后端（${label}）：${cmd} ${args.join(' ')}`.trim());
  }, 3000);
  backendProc = proc;
}

function ensureBackendRunning() {
  // 端口已有后端在监听就不重复拉起
  const net = require('net');
  const port = backendPort();
  const probe = net.connect({ port, host: '127.0.0.1' });
  probe.once('connect', () => { probe.destroy(); });
  probe.once('error', () => {
    const backendDir = path.join(__dirname, 'backend');
    const onFail = () => {
      console.log('没能自动启动后端：请安装 Python（勾选 Add to PATH）并执行 '
        + 'pip install -r requirements.txt，或手动运行 npm run backend');
      // 渲染进程可能还没加载完，隔一会儿再冒泡提示
      setTimeout(() => showPetBubble('后端起不来 😥 看看终端里的提示'), 3000);
    };

    // 优先用打包好的 exe（build-backend.bat 产出）：别人拿到手不需要装 Python
    const exe = backendExecutable();
    if (exe) {
      console.log(`端口 ${port} 空闲，启动打包好的后端：${path.basename(exe)}`);
      spawnBackend([{ cmd: exe, args: [] }], path.dirname(exe), onFail, '打包版');
      return;
    }

    const script = path.join(backendDir, 'main.py');
    if (!fs.existsSync(script)) {
      console.log('找不到后端（backend/main.py 或打包好的 deskpet-backend.exe）');
      onFail();
      return;
    }
    console.log(`端口 ${port} 空闲，用 Python 启动后端（源码模式）…`);
    // -u 不缓冲输出，配合日志转发才能实时看到后端日志
    spawnBackend(
      pythonCandidates().map((py) => ({ cmd: py, args: ['-u', script] })),
      backendDir, onFail, '源码模式'
    );
  });
}

// 干净地结束后端进程：
// PyInstaller onefile 的 exe 是「bootloader + 真正的进程」两层，直接 kill 只杀掉 bootloader，
// 真正的服务会残留下来占着端口（还会锁住 exe 文件导致下次无法重新编译）。
// Windows 用 taskkill /T 杀整棵进程树；Unix 上 detached 起的是独立进程组，用负号杀整组。
function killBackend() {
  const proc = backendProc;
  backendProc = null;
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      require('child_process').execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch (e) {
    try { proc.kill(); } catch (e2) { /* 已经退出了 */ }
  }
}

app.on('before-quit', () => {
  unregisterEscape();
  globalShortcut.unregisterAll();
  if (ws) ws.close();
  if (tray) tray.destroy();
  killBackend();
});

// macOS 惯例：点击 Dock 重新显示
app.on('activate', () => {
  if (petWindow) petWindow.show();
});
