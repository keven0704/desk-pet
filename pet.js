const petImg = document.getElementById('pet-img');

// 气泡不画在这个小窗里：窗口只有 200x200，宠物头顶只剩 52px，两行以上的文案会被
// 窗口上边缘裁掉（"气泡显示不全"）。统一交给主进程显示在独立的"气泡窗口"里
// （bubble.html，够宽够高，而且整个窗口点击穿透，不会挡住桌面点击）
function showBubble(text) {
  window.petAPI.showBubble(text);
}

// === 摸摸头互动：悬停随机做小动作 + 冒情绪粒子 ===
const fxLayer = document.getElementById('fx-layer');
const HOVER_ACTIONS = [
  { cls: 'hop',    fx: ['✨', '💫'], msg: ['好痒好痒！', '嘿嘿～'] },
  { cls: 'roll',   fx: ['🌈', '😄'], msg: ['翻滚吧噜噜！', '嘿嘿嘿～'] },
  { cls: 'tilt',   fx: ['❓', '😊'], msg: ['怎么啦？', '在叫我吗？'] },
  { cls: 'squish', fx: ['❤️', '💕'], msg: ['好舒服～', '再摸摸！', '咕噜咕噜～'] },
  { cls: 'shake',  fx: ['⭐', '✨'], msg: ['抖一抖精神！', '哼唧！'] }
];
const IDLE_ACTIONS = [
  { cls: 'idle-hop' }, { cls: 'idle-look' }
];
let actionPlaying = false;
let lastHoverAction = -1;

function playAction(action, particles) {
  if (actionPlaying || isDragging) return;
  actionPlaying = true;
  petImg.classList.add(action.cls);
  if (particles) spawnFx(particles);
  // 偶尔冒一句气泡
  if (action.msg && Math.random() < 0.35) {
    const m = action.msg[Math.floor(Math.random() * action.msg.length)];
    setTimeout(() => showBubble(m), 300);
  }
  const total = (particles && action.msg) ? 900 : 700;
  setTimeout(() => {
    petImg.classList.remove(action.cls);
    actionPlaying = false;
  }, total);
}

function spawnFx(emojis) {
  for (let i = 0; i < 3; i++) {
    const fx = document.createElement('span');
    fx.className = 'fx';
    fx.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    fx.style.left = (20 + Math.random() * 60) + '%';
    fx.style.top = '20%';
    fx.style.animationDelay = (i * 0.12) + 's';
    fxLayer.appendChild(fx);
    fx.addEventListener('animationend', () => fx.remove());
  }
}

petImg.addEventListener('mouseenter', () => {
  window.petAPI.setIgnoreMouseEvents(false);
  if (isSleeping) {
    showBubble('💤 呼…呼…');
    return;
  }
  startHoverActions();
});

petImg.addEventListener('mouseleave', () => {
  stopHoverActions();
});

// 悬停期间持续做动作：mouseenter 只触发一次，所以用定时器补发
const HOVER_INTERVAL_MS = 4000;
let hoverTimer = null;

function pickAndPlay() {
  // 随机挑一个动作，避免连续重复同一个
  let idx;
  do { idx = Math.floor(Math.random() * HOVER_ACTIONS.length); }
  while (idx === lastHoverAction && HOVER_ACTIONS.length > 1);
  lastHoverAction = idx;
  playAction(HOVER_ACTIONS[idx], true);
}

function startHoverActions() {
  if (hoverTimer) return;
  pickAndPlay(); // 放上去立刻给个反应
  hoverTimer = setInterval(() => {
    if (isDragging || actionPlaying || !petImg.matches(':hover')) {
      // 鼠标其实已经不在图上了（可能停在气泡上），停掉省资源
      if (!petImg.matches(':hover')) stopHoverActions();
      return;
    }
    pickAndPlay();
  }, HOVER_INTERVAL_MS);
}

function stopHoverActions() {
  clearInterval(hoverTimer);
  hoverTimer = null;
}

// 发呆时自己也会偶尔做小动作
setInterval(() => {
  if (isSleeping || actionPlaying || isDragging || petImg.matches(':hover')) return;
  if (Math.random() < 0.35) playAction(IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)]);
}, 25000);

// === 点击穿透 ===
let isDragging = false;
let dragStarted = false;

petImg.addEventListener('mouseleave', () => {
  if (!isDragging) {
    window.petAPI.setIgnoreMouseEvents(true, { forward: true });
  }
});

// === 截图 ===
const DRAG_THRESHOLD_PX = 6;
const dragOffset = { x: 0, y: 0 };
let mouseDownPos = null;

function takeScreenshot() {
  wakeUp();
  showBubble('让我看看…');
  petImg.classList.add('clicking');
  setTimeout(() => petImg.classList.remove('clicking'), 500);
  window.petAPI.onClick().then((ok) => {
    if (ok === false) showBubble('后端没有连接上哦，请先启动 Python 后端');
  });
}

// === 右键菜单 ===
petImg.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.petAPI.showContextMenu();
});

window.petAPI.onTriggerScreenshot(takeScreenshot);

// === 拖动 vs 点击 ===
petImg.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  wakeUp();
  isDragging = true;
  dragStarted = false;
  mouseDownPos = { x: e.screenX, y: e.screenY };
  dragOffset.x = e.screenX - window.screenX;
  dragOffset.y = e.screenY - window.screenY;
  window.petAPI.setIgnoreMouseEvents(false);
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  if (!dragStarted) {
    if (mouseDownPos &&
        Math.abs(e.screenX - mouseDownPos.x) < DRAG_THRESHOLD_PX &&
        Math.abs(e.screenY - mouseDownPos.y) < DRAG_THRESHOLD_PX) {
      return;
    }
    dragStarted = true;
    petImg.classList.add('dragging');
  }
  window.petAPI.moveWindow(e.screenX - dragOffset.x, e.screenY - dragOffset.y);
});

document.addEventListener('mouseup', (e) => {
  if (!isDragging) return;
  const wasDrag = dragStarted;
  isDragging = false;
  dragStarted = false;
  mouseDownPos = null;
  petImg.classList.remove('dragging');
  wakeUp(); // 拖完重新计睡觉时间，别一放下就睡着
  if (!wasDrag) takeScreenshot();
});

// === 接收主进程消息 ===
// 气泡不再由桌宠页面渲染（见上面的 showBubble）：主进程直接显示在独立的气泡窗口里，
// 所以这里不订阅 'show-bubble'，免得"发过来又发回去"来回打转。

// === 睡觉状态：长时间没人理会就打瞌睡 ===
const IDLE_SLEEP_MS = 120000; // 2 分钟无互动进入睡眠
let sleepTimer = null;
let isSleeping = false;

function armSleepTimer() {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(fallAsleep, IDLE_SLEEP_MS);
}

function fallAsleep() {
  if (isSleeping || isDragging) { armSleepTimer(); return; }
  isSleeping = true;
  stopHoverActions();
  // 清掉可能残留的动作类，避免和睡觉动画叠加
  petImg.classList.remove('hop', 'roll', 'tilt', 'squish', 'shake', 'idle-hop', 'idle-look', 'clicking');
  petImg.classList.add('sleeping');
  showBubble('好困呀…先眯一会儿 💤');
}

function wakeUp() {
  armSleepTimer(); // 任何互动都重置睡眠计时
  if (!isSleeping) return;
  isSleeping = false;
  petImg.classList.remove('sleeping');
}

// === 投喂：托盘/右键菜单「投喂橘子」 ===
const FEED_FX = ['🍊', '🍊', '✨', '💛'];
window.petAPI.onFeedPet(() => {
  wakeUp();
  playAction({ cls: 'hop', msg: ['嗷呜！橘子！', '酸酸甜甜～'] }, FEED_FX);
  setTimeout(() => showBubble('咕～橘子好好吃！'), 900);
});

// 启动时开始计睡觉时间
armSleepTimer();

// ============================================================
// 语音唤醒：对着桌宠说"噜噜，这个题怎么做"→
// 本地 VAD 检测说话起止 → 录音转 WAV 交后端识别唤醒词 →
// 命中后主进程自动截屏并弹出框选遮罩，说的话作为补充描述预填。
// 框选/结果期间主进程会发 wake-listen=false 暂停监听，关掉后恢复。
// ============================================================
let wakeStream = null;
let wakeAudioCtx = null;
let wakeRecorder = null;
let wakeChunks = [];
let wakeVadTimer = null;
let wakeState = 'idle';      // idle | listening | processing
let wakeEnabled = true;
let wakeSpeechStarted = false;
let wakeSilenceMs = 0;
let wakeSpeechStartTs = 0;
let wakeMicFailNotified = false;
let wakeSelfTestArmed = false;   // 自检模式：下一句录音不走唤醒判断，直接回报识别结果
let wakePeakRms = 0;
let wakeAnalyser = null;         // 自检时也要量电平，所以从 startWakeListener 里提到模块作用域
let wakePcm = null;

// 触发阈值不写死：固定 0.05 在安静/增益低的麦克风上永远触发不了，"喊他没反应"多半是这个。
// 启动监听时先量 1 秒环境底噪，按底噪自适应（见 calibrateWakeThreshold），
// 说话电平还会被"学会"（见 learnWakeThreshold）。
// 反过来说，阈值太灵敏/被瞬间噪音顶上去，就会出现"没叫它、它自己反应"，
// 所以下面还有两道闸：① 连续几拍都过阈值才算有人说话；② 整段峰值够响才送去识别。
const WAKE_RMS_MAX = 0.05;         // 自适应阈值上限（环境比较吵时）
// 阈值下限：原来是 0.015，实测（.mic-levels.js）笔记本麦克风阵列（Intel 智音，数字静音、
// 底噪读数 0.0000）上正常说话的电平只有 0.006~0.008，0.015 这条线永远踩不到 ——
// 表现就是"喊他没反应"。宁可偏灵敏：真听岔了还有峰值闸、唤醒词匹配，以及误唤醒自愈兜着。
const WAKE_RMS_MIN = 0.006;
const WAKE_NOISE_FACTOR = 3;       // 阈值 = 环境底噪 × 该系数（越大越不容易被背景音带起）
const WAKE_RMS_CEIL = 0.12;        // 误唤醒自愈抬高系数后的硬上限，再高就"喊了也没反应"了
const WAKE_STOP_RATIO = 0.5;       // 低于「阈值×该系数」视为说完
// 「说完」还要同时低于「本段峰值×该系数」：低增益麦克风上说话峰值本来就不高，
// 只按阈值判断的话房间底噪一直压不下去，会一路录到 10 秒上限（用户就觉得"喊了没反应"）
const WAKE_STOP_PEAK_RATIO = 0.25;
const WAKE_STOP_FLOOR = 0.0015;    // 停录判定的绝对下限（原来写死 0.004，比新阈值还高，会一直录满）
const WAKE_TICK_MS = 100;          // VAD 检测间隔
const WAKE_HOLD_TICKS = 3;         // 连续 3 拍（约 300ms）都过阈值才算"有人在说话"
const WAKE_PEAK_RATIO = 1.5;       // 整段录音峰值要到「阈值×该系数」才送识别，否则当背景噪音
const WAKE_SILENCE_MS = 1400;      // 安静多久视为说完一句话
const WAKE_MIN_SPEECH_MS = 900;    // 短于它视为杂音直接丢（"噜噜，这个题怎么做"通常 >1 秒）
const WAKE_MAX_MS = 10000;         // 单句最长录 10 秒
const WAKE_COOLDOWN_MS = 2500;     // 一轮结束后的冷却，防止刚弹遮罩又录到自己
const WAKE_RESUME_DELAY_MS = 800;  // 遮罩关掉后缓一下再开始听，别被残留声音马上触发
const WAKE_SELF_TEST_MS = 4500;    // 自检录音固定 4.5 秒（不依赖 VAD，触发不了也能测）
// 说话电平自学习（阈值校准）：自检录到的说话峰值 × 0.35 当阈值。
// 低增益麦克风上"喊不动"是主要矛盾，所以这个校准只往下调；
// 万一因此变太灵敏（误唤醒），主进程的误唤醒自愈会把系数再乘上去
const WAKE_LEARN_RATIO = 0.35;
const WAKE_LEARN_MIN = 0.002;      // 学到的阈值下限，再低就只剩底噪了
let wakeThreshold = 0.02;
let wakeThresholdBump = 1;         // 听音灵敏度系数：主进程判到"疑似误唤醒"会调大它（见 onWakeListenControl）
let wakeHoldTicks = 0;             // 连续过阈值的拍数（配额见 WAKE_HOLD_TICKS）
let wakeNoiseFloor = 0;            // 校准出来的环境底噪（判断"这段录音是不是比底噪响得多"要用）
let wakeLearnedThreshold = 0;      // 0 = 还没学到，完全按底噪自适应
let wakeLastLearnAt = 0;           // 上次自动校准的时间（防抖：别被连续噪音一路压下去）

// 唤醒相关日志：控制台 + 通过 IPC 转给主进程，npm start 的终端里能直接看到，
// 排查"喊他没反应"就靠它（有没有听到、电平多少、识别成什么字）
function wakeLog(msg) {
  console.log('[wake] ' + msg);
  try { window.petAPI.reportWakeStatus(String(msg)); } catch (e) { /* 主进程没起来就算了 */ }
}

function pcmRms(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 触发阈值 = clamp(环境底噪 × 系数, [MIN, MAX]) × 听音灵敏度系数（误唤醒自愈调大它），
// 最后再夹一道硬上限。学到过"你说话有多大声"就按它往下校准（只降不升）。
// 抽成纯函数，.pet-test.js 可以直接跑它验算法。
function wakeThresholdFor(noise) {
  const base = Math.min(WAKE_RMS_MAX, Math.max(WAKE_RMS_MIN, noise * WAKE_NOISE_FACTOR));
  const tuned = wakeLearnedThreshold > 0 ? Math.min(base, wakeLearnedThreshold) : base;
  return Math.min(WAKE_RMS_CEIL, tuned * wakeThresholdBump);
}

// 从一段"确定是人说话"的录音里学出触发阈值（峰值 × WAKE_LEARN_RATIO）。
// 只往下调：安静房间的底噪读数是 0（麦克风阵列有噪声门），底噪自适应根本算不出
// "人说话多大声"，只能靠真实录一段来学。学到的值照样会乘上误唤醒自愈的系数。
function learnWakeThreshold(peak, ms, why) {
  if (ms < WAKE_MIN_SPEECH_MS) return false;   // 太短，说明不了说话有多大声
  if (peak < WAKE_LEARN_MIN) return false;     // 小得跟底噪一样，不值得学
  const learned = Math.min(WAKE_RMS_MAX, Math.max(WAKE_LEARN_MIN, peak * WAKE_LEARN_RATIO));
  if (wakeLearnedThreshold > 0 && learned >= wakeLearnedThreshold) return false; // 只会越学越松
  wakeLearnedThreshold = learned;
  wakeThreshold = wakeThresholdFor(wakeNoiseFloor);
  wakeLog(`按说话电平校准触发阈值：峰值 ${peak.toFixed(4)} × ${WAKE_LEARN_RATIO}`
    + ` → 触发阈值 ${wakeThreshold.toFixed(4)}（${why}）`);
  return true;
}

// 这段录音够不够格当"有人在喊我"送去识别：
// 太短的丢掉；只是勉强擦过阈值的背景音（外放视频、空调、隔壁说话）也丢掉。
// 纯函数（只读 wakeThreshold 这类个位数状态），.pet-test.js 可以直接调它验。
function acceptWakeClip(ms, peak) {
  const need = wakeThreshold * WAKE_PEAK_RATIO;
  if (ms < WAKE_MIN_SPEECH_MS) {
    return { ok: false, why: `太短（${ms}ms < ${WAKE_MIN_SPEECH_MS}ms），当杂音` };
  }
  if (peak < need) {
    return { ok: false, why: `不够响（峰值 ${peak.toFixed(3)} < 阈值×${WAKE_PEAK_RATIO}=${need.toFixed(3)}），当背景噪音` };
  }
  return { ok: true, why: `时长 ${ms}ms / 峰值 ${peak.toFixed(3)}` };
}

// "说完"的判定线：要同时低于「阈值×比例」和「本段峰值×比例」，但绝不低于绝对下限。
// 抽成纯函数方便 .pet-test.js 验：这条线定高了（原来的写死 0.004）就会一路录到 10 秒上限，
// 用户等半天没反应；定低了会把说完之后的房间噪声也录进去。
function wakeStopThresholdFor(peak) {
  return Math.max(WAKE_STOP_FLOOR, wakeThreshold * WAKE_STOP_RATIO, peak * WAKE_STOP_PEAK_RATIO);
}

// 量环境底噪，自适应出触发阈值（中位数×系数，夹在 [MIN, MAX]）
async function calibrateWakeThreshold(analyser, pcm) {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    analyser.getFloatTimeDomainData(pcm);
    samples.push(pcmRms(pcm));
    await sleep(100);
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length / 2)] || 0;
  wakeNoiseFloor = noise;
  wakeThreshold = wakeThresholdFor(noise);
  wakeLog(`麦克风就绪：环境底噪 ${noise.toFixed(4)} → 触发阈值 ${wakeThreshold.toFixed(4)}`
    + (wakeLearnedThreshold > 0 ? `（按说话电平校准过 ${wakeLearnedThreshold.toFixed(4)}）` : '')
    + (wakeThresholdBump > 1 ? `（含误唤醒自愈系数 ×${wakeThresholdBump.toFixed(2)}）` : ''));
  if (noise < 0.001) {
    // 数字静音（麦克风阵列自带噪声门）是常态：底噪自适应算不出说话多大声，
    // 只能靠真实说话录音来校准（见 learnWakeThreshold），这里先说明一句省得看不懂日志
    wakeLog('环境底噪几乎为 0（麦克风有噪声门）：阈值先用下限，喊一句后会自动按说话电平校准');
  }
}

function stopWakeRecorder() {
  if (wakeRecorder) {
    try { wakeRecorder.stop(); } catch (e) { /* 忽略 */ }
    wakeRecorder = null;
  }
}

function releaseWakeMedia() {
  if (wakePrerollTimer) {
    clearTimeout(wakePrerollTimer);
    wakePrerollTimer = null;
  }
  if (wakeStream) {
    wakeStream.getTracks().forEach(t => t.stop());
    wakeStream = null;
  }
  if (wakeAudioCtx) {
    try { wakeAudioCtx.close(); } catch (e) { /* 忽略 */ }
    wakeAudioCtx = null;
  }
  if (wakeVadTimer) {
    clearInterval(wakeVadTimer);
    wakeVadTimer = null;
  }
}

// ============ 预录缓冲（唤醒词起头不被切） ============
// VAD 要连续几拍都过阈值才认定"有人在说话"，等认定了再开录音，前面那 200~300ms
// 就被吃掉了——"噜噜"的第一个字经常正好落在里面，识别出来只剩一个"噜"，
// 后端按"成对的同音词"判定唤醒词，于是整句被忽略，表现就是"喊他没反应 / 听岔了"。
//
// 做法：监听期间就让 MediaRecorder 一直录（200ms 一片）当预录，触发时把这段拼到前面。
// 注意：WebM 的头部只在第一片里，实测"首片 + 中间丢几片"就 decodeAudioData 失败
// （Chrome/Electron 的 WebM 解码要求数据连续），所以不能只保留末尾几片，
// 而是每 1.5 秒重启一次录音器：片段从头到尾连续、内存只有几十 KB，
// 预录长度也正好是"最多 1.5 秒"——够包住说话起头，又不会把喊之前的话一起送进去。
const WAKE_PREROLL_ROTATE_MS = 1500;
const WAKE_CHUNK_MS = 200;
let wakePreroll = [];        // [{ t, data }] 本轮录音器的全部切片（从它的 WebM 头开始）
let wakeClipStartTs = 0;     // 本段录音真正的起点（含预录）
let wakeRecentRms = [];      // [{ t, rms }] 最近一秒多的电平，用来算含起头的峰值
let wakeRecorderMime = 'audio/webm';
let wakeSessionId = 0;       // 会话号：上一轮录音器的迟到事件不能影响新一轮
let wakePrerollTimer = null; // 预录录音器的轮换计时

function pushRecentRms(rms) {
  const now = Date.now();
  wakeRecentRms.push({ t: now, rms });
  const cut = now - WAKE_PREROLL_ROTATE_MS - 200;   // 多留一拍，够算预录窗口里的峰值
  while (wakeRecentRms.length && wakeRecentRms[0].t < cut) wakeRecentRms.shift();
}

// 监听期间常驻录音器：切片进预录缓冲，触发后继续录（同一条流，拼起来能解码）
function startWakePrerollRecorder() {
  if (!wakeStream) return;
  const mySession = ++wakeSessionId;
  wakePreroll = [];
  wakeChunks = [];
  wakeRecentRms = [];
  try {
    wakeRecorder = new MediaRecorder(wakeStream);
  } catch (e) {
    wakeLog('启动录音失败：' + e);
    return;
  }
  wakeRecorderMime = wakeRecorder.mimeType || 'audio/webm';
  wakeRecorder.ondataavailable = (ev) => {
    if (mySession !== wakeSessionId) return;          // 上一轮的迟到事件
    if (!ev.data || ev.data.size <= 0) return;
    if (wakeSpeechStarted) {
      wakeChunks.push(ev.data);
      return;
    }
    wakePreroll.push({ t: Date.now(), data: ev.data });
  };
  wakeRecorder.onstop = () => {
    if (mySession !== wakeSessionId) return;
    if (!wakeSpeechStarted) {
      // 只是轮换/暂停监听时停的，没有要识别的片段
      wakePreroll = [];
      wakeChunks = [];
      return;
    }
    wakeSpeechStarted = false;
    onWakeClipReady(Date.now(), wakeRecorderMime);
  };
  wakeRecorder.start(WAKE_CHUNK_MS);
  schedulePrerollRotate();
}

// 定期重启预录录音器：既限制内存，又保证"预录片段"始终是从 WebM 头开始的连续数据
function schedulePrerollRotate(delay = WAKE_PREROLL_ROTATE_MS) {
  clearTimeout(wakePrerollTimer);
  wakePrerollTimer = setTimeout(() => {
    wakePrerollTimer = null;
    if (wakeState !== 'listening' || !wakeStream) return;      // 不在监听就没必要轮换
    if (wakeSpeechStarted || wakeHoldTicks > 0) {              // 正在录 / 马上要起录：不能在说话起头处切一刀
      // 只延后一小会儿再试：用整段间隔去延后的话，预录会越攒越长，
      // 最后拼进去的"喊之前的声音"太多，唤醒词就不在句子开头了
      schedulePrerollRotate(200);
      return;
    }
    stopWakeRecorder();      // 旧录音器的 onstop 因为换过 session 会直接返回，不会误发
    startWakePrerollRecorder();
  }, WAKE_PREROLL_ROTATE_MS);
}

function enterWakeCooldown() {
  wakeState = 'processing';
  wakeSpeechStarted = false;
  releaseWakeMedia();
  setTimeout(() => {
    wakeState = 'idle';
    startWakeListener();
  }, WAKE_COOLDOWN_MS);
}

async function startWakeListener(force) {
  if ((!wakeEnabled && !force) || wakeState !== 'idle') return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    wakeLog('当前环境不支持麦克风录音');
    return;
  }
  try {
    wakeStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (e) {
    // 麦克风不可用：提示一次，之后每 30 秒静默重试（可能只是暂时被占用）
    wakeLog(`麦克风不可用（${e.name || e.message}）`);
    if (!wakeMicFailNotified) {
      wakeMicFailNotified = true;
      showBubble('麦克风被占用啦，语音唤醒暂时不可用 😥');
      setTimeout(() => { wakeMicFailNotified = false; }, 30000);
    }
    if (!force) setTimeout(startWakeListener, 30000); // 自检模式由用户手动重试，不反复弹提示
    return;
  }
  wakeState = 'listening';

  // 用 AnalyserNode 实时算音量（RMS），检测"开始说话 / 说完"；
  // MediaRecorder 由 startWakePrerollRecorder 常驻打开（200ms 切片当预录），
  // 免得起录时把"噜"字那 200~300ms 吃掉
  wakeAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = wakeAudioCtx.createMediaStreamSource(wakeStream);
  const analyser = wakeAudioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const pcm = new Float32Array(analyser.fftSize);
  wakeAnalyser = analyser; // 自检的强制录音也用这个量电平
  wakePcm = pcm;

  await calibrateWakeThreshold(analyser, pcm);
  // 校准耗时 1 秒，期间可能被"遮罩弹出/关闭唤醒"叫停，这里要重新确认状态
  if (wakeState !== 'listening' || !wakeAudioCtx || !wakeStream) return;

  // 常驻录音器（每 1.5 秒轮换一次，见 startWakePrerollRecorder）：
  // VAD 认定"有人在说话"要花 200~300ms，那几百毫秒里正好是"噜"字起头
  startWakePrerollRecorder();

  wakeVadTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(pcm);
    const rms = pcmRms(pcm);

    if (!wakeSpeechStarted) {
      // 第一道闸：连续 WAKE_HOLD_TICKS 拍都过阈值才算"有人在说话"——
      // 键盘、关门、风扇这种"一下就没"的噪音数不满，也就不会起录音
      pushRecentRms(rms);
      if (rms >= wakeThreshold) wakeHoldTicks++;
      else wakeHoldTicks = 0;
      if (wakeHoldTicks >= WAKE_HOLD_TICKS) {
        wakeHoldTicks = 0;
        // 有人开始说话：开始计时（录音器是常驻的，预录缓冲里已经有前面那 1 秒）
        wakeSpeechStarted = true;
        wakeSilenceMs = 0;
        wakeSpeechStartTs = Date.now();
        wakeChunks = [];
        // 本段录音的起点 = 预录缓冲里最早的一片（那一片就是它自己 WebM 流的开头）；
        // 峰值也把预录窗口算进来——"噜"字起头那一下就在这里，
        // 漏了就只剩一个"噜"，凑不成唤醒词
        wakeClipStartTs = wakePreroll.length ? wakePreroll[0].t : Date.now();
        const keepFrom = Date.now() - WAKE_PREROLL_ROTATE_MS - 200;
        const onsetPeak = wakeRecentRms.filter((s) => s.t >= keepFrom).reduce((m, s) => Math.max(m, s.rms), 0);
        wakePeakRms = Math.max(rms, onsetPeak);
        wakeLog(`连续 ${WAKE_HOLD_TICKS} 拍都在阈值以上（电平 ${rms.toFixed(3)} ≥ 阈值 ${wakeThreshold.toFixed(3)}），`
          + `开始录音（含 ${wakeSpeechStartTs - wakeClipStartTs}ms 预录，唤醒词起头不会被切）`);
      }
      return;
    }

    // 录音中：检测说完（连续安静）或超时
    if (rms > wakePeakRms) wakePeakRms = rms;
    // 每拍现算"说完"的线：既要明显低于触发阈值，也要明显低于这一段里最响的那一下，
    // 这样说话轻的用户说完就能停，不会死等到 10 秒上限才发识别
    const stopThreshold = wakeStopThresholdFor(wakePeakRms);
    if (rms < stopThreshold) {
      wakeSilenceMs += WAKE_TICK_MS;
    } else {
      wakeSilenceMs = 0;
    }
    if (wakeSilenceMs >= WAKE_SILENCE_MS || Date.now() - wakeClipStartTs >= WAKE_MAX_MS) {
      stopWakeRecorder(); // onstop → onWakeClipReady 里负责转码发送 + 冷却重启
    }
  }, WAKE_TICK_MS);
}

// 录音结束：拼预录 + 正式录音 → 过两道闸 → 转 WAV 交后端识别（或自检）
function onWakeClipReady(endedAt, mime) {
  const chunks = wakePreroll.map((c) => c.data).concat(wakeChunks);
  const startedAt = wakeClipStartTs || endedAt;
  wakePreroll = [];
  wakeChunks = [];
  wakeClipStartTs = 0;
  if (!chunks.length) return;
  const ms = Math.max(1, endedAt - startedAt);
  const blob = new Blob(chunks, { type: mime || 'audio/webm' });
  // 第二道闸：太短、或者峰值只是勉强擦过阈值的（外放视频/隔壁说话），
  // 都不送识别——不送识别就绝不会"没喊它也被唤醒"
  const verdict = acceptWakeClip(ms, wakePeakRms);
  const tooShort = !verdict.ok || blob.size < 800;
  // 自检模式：哪怕它不够格也送出去，好让用户看到识别结果/报错
  if (tooShort && !wakeSelfTestArmed) {
    wakeLog(`丢弃这段录音（${ms}ms / ${blob.size} 字节 / 峰值 ${wakePeakRms.toFixed(3)}，`
      + `阈值 ${wakeThreshold.toFixed(3)}）：`
      + (blob.size < 800 ? `转码数据太少（${blob.size} 字节）` : verdict.why));
    // 够长、又明显比环境底噪响（真有人在说话）却没过峰值闸：说明阈值定高了，
    // 趁这次真实录音把阈值往下校准（30 秒最多调一次，免得被连续噪音一路压下去）
    if (ms >= WAKE_MIN_SPEECH_MS && wakePeakRms >= Math.max(wakeNoiseFloor * 3, wakeThreshold)
        && Date.now() - wakeLastLearnAt > 30000) {
      wakeLastLearnAt = Date.now();
      learnWakeThreshold(wakePeakRms, ms, '这句话被当成不够响丢掉了');
    }
    enterWakeCooldown();
    return;
  }
  const selfTest = wakeSelfTestArmed;
  wakeSelfTestArmed = false;
  // 自检是"用户主动说的一句话"，最可靠的说话电平样本：拿它校准触发阈值，
  // 之后再喊「噜噜」就能踩到阈值（自检弹窗里会显示校准前后的数字）
  const thresholdBefore = wakeThreshold;
  let learned = false;
  if (selfTest) {
    learned = learnWakeThreshold(wakePeakRms, ms, '语音唤醒自检');
  }
  const clipInfo = {
    peak: wakePeakRms, ms,
    thresholdBefore, thresholdAfter: wakeThreshold, learned,
    noiseFloor: wakeNoiseFloor
  };
  wakeLog(`录音结束：${ms}ms / ${blob.size} 字节（峰值电平 ${wakePeakRms.toFixed(3)}），${selfTest ? '自检模式，直接送识别' : '送识别判断唤醒词'}`);
  blobToWavDataUrl(blob).then((dataUrl) => {
    if (selfTest) window.petAPI.wakeSelfTestAudio(dataUrl, clipInfo);
    else window.petAPI.wakeListen(dataUrl, clipInfo);
  }).catch((e) => {
    wakeLog('音频转码失败：' + e); // 原来这里静默吞掉了，出问题完全看不出来
  });
  // 识别请求已发出，等冷却后重新开始下一轮监听
  if (selfTest) {
    wakeState = 'idle';
    wakeSpeechStarted = false;
    releaseWakeMedia();
    if (wakeEnabled) setTimeout(startWakeListener, WAKE_COOLDOWN_MS);
  } else {
    enterWakeCooldown();
  }
}

// 语音唤醒自检：强制开一次监听，再说一句就能看到"它到底听到了什么/报了什么错"
async function armWakeSelfTest() {
  wakeUp();
  wakeSelfTestArmed = true;
  showBubble('自检中：说一句「噜噜，这个题怎么做」');
  wakeLog('====== 语音唤醒自检开始 ======');
  if (wakeState === 'idle') await startWakeListener(true);
  if (wakeState !== 'listening') {
    wakeSelfTestArmed = false;
    wakeLog('自检中止：麦克风没起来（检查系统麦克风权限/是否被其它程序占用）');
    showBubble('麦克风没打开，自检中止了 😥');
    return;
  }
  if (wakeSpeechStarted) {
    wakeLog('VAD 已经检测到你在说话，这句就按自检处理');
    return;
  }
  // 主动录固定 4.5 秒：万一 VAD 阈值偏高没触发，自检也能给出结果（否则会一直干等）
  runSelfTestRecording();
}

function runSelfTestRecording() {
  if (!wakeStream || !wakeAnalyser || !wakePcm) return;
  wakeSelfTestArmed = false;
  // 常驻的预录录音器先停掉，别和自检录音打架（它的 onstop 会因为没在录音直接返回）
  stopWakeRecorder();
  if (wakePrerollTimer) { clearTimeout(wakePrerollTimer); wakePrerollTimer = null; }
  if (wakeVadTimer) { clearInterval(wakeVadTimer); wakeVadTimer = null; } // 停掉 VAD，别两个录音打架
  wakeSpeechStarted = false;
  const chunks = [];
  let peak = 0;
  const startedAt = Date.now();
  let rec;
  try {
    rec = new MediaRecorder(wakeStream);
  } catch (e) {
    wakeLog('自检录音启动失败：' + e);
    return;
  }
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
  const meter = setInterval(() => {
    wakeAnalyser.getFloatTimeDomainData(wakePcm);
    const r = pcmRms(wakePcm);
    if (r > peak) peak = r;
  }, 100);
  rec.onstop = () => {
    clearInterval(meter);
    const ms = Date.now() - startedAt;
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    wakeLog(`自检录音 ${ms}ms / ${blob.size} 字节，峰值电平 ${peak.toFixed(3)}（触发阈值 ${wakeThreshold.toFixed(3)}）`);
    // 这条日志直接回答"喊他没反应"最常见的原因：声音根本没到触发线
    if (peak < wakeThreshold) {
      wakeLog(`⚠️ 说话这几秒电平(${peak.toFixed(3)})始终低于触发阈值(${wakeThreshold.toFixed(3)})：`
        + '麦克风增益太低或被静音，请在系统声音设置里调高麦克风音量');
    }
    // 自检是"用户主动说的一句话"，拿它校准触发阈值：低增益麦克风上这一步是能不能唤醒的关键
    const thresholdBefore = wakeThreshold;
    const learned = learnWakeThreshold(peak, ms, '语音唤醒自检');
    if (!learned) {
      wakeLog(`这段录音没能用来校准阈值（时长 ${ms}ms / 峰值 ${peak.toFixed(3)} 不够格），`
        + '再自检一次、靠近麦克风说一句「噜噜，这个题怎么做」试试');
    }
    const clipInfo = {
      peak, ms, thresholdBefore, thresholdAfter: wakeThreshold, learned, noiseFloor: wakeNoiseFloor
    };
    blobToWavDataUrl(blob).then((dataUrl) => {
      window.petAPI.wakeSelfTestAudio(dataUrl, clipInfo);
    }).catch((e) => wakeLog('音频转码失败：' + e));
    wakeState = 'idle';
    releaseWakeMedia();
    if (wakeEnabled) setTimeout(startWakeListener, WAKE_COOLDOWN_MS);
  };
  rec.start();
  wakeLog(`开始自检录音（${WAKE_SELF_TEST_MS / 1000} 秒），请说「噜噜，这个题怎么做」`);
  showBubble('正在听，说一句「噜噜，这个题怎么做」');
  setTimeout(() => { try { rec.stop(); } catch (e) { /* 已停 */ } }, WAKE_SELF_TEST_MS);
}

window.petAPI.onWakeSelfTest(() => { armWakeSelfTest(); });

// 主进程开关（托盘勾选 / 遮罩弹出暂停、关闭恢复）。
// 注意：以前主进程发的消息错到了别的通道，这里从来收不到，麦克风会一直听着——
// 表现就是"没人叫它，它自己又冒泡、又把遮罩弹出来"，现在通道修好了。
window.petAPI.onWakeListenControl((enabled, bump) => {
  wakeEnabled = !!enabled;
  // 主进程发现"疑似误唤醒"会把灵敏度系数调大，下次校准阈值按新系数算
  if (typeof bump === 'number' && bump > 0 && bump !== wakeThresholdBump) {
    wakeThresholdBump = bump;
    wakeLog(`听音灵敏度系数更新为 ×${bump.toFixed(2)}（疑似误唤醒，自动调低灵敏度）`);
  }
  if (!wakeEnabled) {
    // 立刻掐掉录音和监听，别在遮罩弹出后还录着
    stopWakeRecorder();
    releaseWakeMedia();
    wakeState = 'idle';
    wakeSpeechStarted = false;
    wakeLog('唤醒监听已暂停（遮罩弹出 / 识别故障 / 托盘关闭）');
  } else {
    wakeLog('唤醒监听已恢复');
    // 缓一下再开始听：遮罩刚关掉时外面的声音容易把下一轮立刻触发起来
    setTimeout(() => {
      if (wakeEnabled && wakeState === 'idle') startWakeListener();
    }, WAKE_RESUME_DELAY_MS);
  }
});

// 唤醒命中：桌宠给个反应（截屏和弹遮罩由主进程完成）
window.petAPI.onWakeTriggered(() => {
  wakeLog('唤醒命中，开始截屏框选');
  wakeUp();
  showBubble('听到啦！框出你想问的地方吧 🐾');
  playAction({ cls: 'hop' });
});

// 初始状态从主进程拿（托盘可能已关掉唤醒）
window.petAPI.getVoiceWakeEnabled().then((enabled) => {
  wakeEnabled = !!enabled;
  wakeLog(`启动监听：唤醒开关=${wakeEnabled ? '开' : '关'}`);
  startWakeListener();
});

