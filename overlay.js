// ============================================================
// 框选遮罩：点噜噜后出现，拖动/缩放绿框
// 回车后可在输入框补充对问题的描述，再回车开始分析；
// AI 输出显示为 DOM 聊天卡片：文字可选中复制、可继续追问
// ============================================================
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

// ---------- DOM：补充描述输入框 & 聊天卡片 ----------
const noteBox = document.getElementById('note-box');
const noteInput = document.getElementById('note-input');
const chatCard = document.getElementById('chat');
const chatHeader = document.getElementById('chat-header');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send');
const chatCloseBtn = document.getElementById('chat-close');
const chatMicBtn = document.getElementById('chat-mic');
const noteMicBtn = document.getElementById('note-mic');
const noteMicStatus = document.getElementById('note-mic-status');
const noteError = document.getElementById('note-error');
const noteErrorText = document.getElementById('note-error-text');
const noteErrorSettings = document.getElementById('note-error-settings');

// ============================================================
// 语音输入：getUserMedia 录音 → MediaRecorder 采 webm，
// 停止后转 16kHz 单声道 WAV，经主进程发给后端 ASR 接口识别。
// ============================================================
let voiceState = 'idle';           // idle | recording | busy
let voiceTarget = null;            // 'chat' | 'note'：本次录音服务于哪个输入框
let mediaStream = null;
let audioRecorder = null;
let audioChunks = [];
let recordedDataUrl = null;        // 停止录音后暂存，等 dataavailable 写完再发送
let voiceStopTimer = null;
const VOICE_MAX_MS = 60000;        // 最长录 60 秒，防止忘了点停止
const VOICE_MIN_BYTES = 800;       // 小于该字节数视为没录到声音

function setVoiceUI(recording, target) {
  const btn = target === 'chat' ? chatMicBtn : noteMicBtn;
  chatMicBtn.classList.toggle('recording', recording && voiceTarget === 'chat');
  noteMicBtn.classList.toggle('recording', recording && voiceTarget === 'note');
  noteMicStatus.classList.toggle('visible', recording && voiceTarget === 'note');
  if (!recording) {
    chatMicBtn.classList.remove('busy');
    noteMicBtn.classList.remove('busy');
  }
}

// ---------- 语音识别失败的提示 ----------
// 以前是 alert()，系统模态框会挡住遮罩、还得手动点确定；改成卡片/输入框里的内联提示，
// 顺带给一个直达「API 设置」的入口，用户点一下就换服务商或 Key（常见于余额不足 429）
let noteErrorTimer = null;

function showNoteError(text) {
  noteErrorText.textContent = text;
  noteError.classList.add('visible');
  clearTimeout(noteErrorTimer);
  noteErrorTimer = setTimeout(hideNoteError, 20000);
}

function hideNoteError() {
  clearTimeout(noteErrorTimer);
  noteErrorTimer = null;
  noteError.classList.remove('visible');
}

noteErrorSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  window.overlayAPI.openSettings();
});

// 聊天卡片里的错误消息（追问录音失败时用）
function addVoiceErrorMessage(payload) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.appendChild(document.createTextNode(payload.error || '语音识别失败'));
  if (payload.hint) div.appendChild(document.createTextNode('\n' + payload.hint));
  const link = document.createElement('span');
  link.className = 'link';
  link.textContent = ' 打开 API 设置 ›';
  link.addEventListener('click', () => window.overlayAPI.openSettings());
  div.appendChild(link);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  layoutChat();
}

async function startVoice(target) {
  if (voiceState !== 'idle') return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('当前环境不支持麦克风录音');
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (e) {
    alert('无法访问麦克风：' + (e.message || e.name || e));
    return;
  }
  voiceState = 'recording';
  voiceTarget = target;
  audioChunks = [];
  audioRecorder = new MediaRecorder(mediaStream);
  audioRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  audioRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: audioRecorder.mimeType || 'audio/webm' });
    releaseMedia();
    if (blob.size < VOICE_MIN_BYTES) {  // 太短视为误触
      finishVoice();
      return;
    }
    blobToWavDataUrl(blob).then((dataUrl) => {
      recordedDataUrl = dataUrl;
      sendRecordedVoice();
    }).catch((e) => {
      alert('录音处理失败：' + e);
      finishVoice();
    });
  };
  audioRecorder.start();
  setVoiceUI(true, target);
  if (target === 'chat') window.overlayAPI.notifyActivity();
  // 超时自动停止并识别
  clearTimeout(voiceStopTimer);
  voiceStopTimer = setTimeout(stopVoice, VOICE_MAX_MS);
}

// 丢弃录音并复位状态（遮罩/卡片关闭时调用，避免悬挂的媒体流和定时器）
function cancelVoice() {
  clearTimeout(voiceStopTimer);
  voiceStopTimer = null;
  if (audioRecorder && voiceState === 'recording') {
    try { audioRecorder.onstop = null; } catch (e) { /* 忽略 */ }
    try { audioRecorder.stop(); } catch (e) { /* 忽略 */ }
  }
  audioRecorder = null;
  audioChunks = [];
  recordedDataUrl = null;
  releaseMedia();
  voiceState = 'idle';
  voiceTarget = null;
  setVoiceUI(false, 'chat');
}

function stopVoice() {
  if (voiceState !== 'recording' || !audioRecorder) return;
  clearTimeout(voiceStopTimer);
  voiceState = 'busy';  // 等识别结果期间按钮置灰，防止重复点击
  setVoiceUI(false, voiceTarget);
  (voiceTarget === 'chat' ? chatMicBtn : noteMicBtn).classList.add('busy');
  try { audioRecorder.stop(); } catch (e) { releaseMedia(); finishVoice(); }
}


function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const HANDLE = 10;      // 边缘可抓取宽度
const CORNER = 16;      // 角部可抓取宽度
const MIN_SIZE = 40;    // 框最小尺寸
const HANDLE_H = 26;    // 顶部提示条高度

// rect: { x, y, w, h } 逻辑像素
let rect = null;
let mode = 'select';    // 'select' 框选中 | 'note' 补充描述 | 'analyzing' 分析中 | 'result' 显示结果
let drag = null;        // { type: 'move'|'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w', startRect, sx, sy }
let selecting = false;  // 正在用鼠标新画一个框
let lastIgnore = null;
let pendingRect = null; // 回车时记录的框，进入分析/结果后仍需在画布上描出

// ---------- 穿透控制 ----------
function applyIgnore(ignore, forward) {
  if (lastIgnore === ignore) return;
  lastIgnore = ignore;
  window.overlayAPI.setIgnoreMouseEvents(ignore, forward ? { forward: true } : undefined);
}

// ---------- 结果模式：卡片定位 & 穿透判断 ----------
// 结果模式下：卡片本身可交互，卡片以外全部穿透，用户可以照常操作屏幕
let chatDragged = false;   // 用户手动拖过卡片后就不再自动定位，避免跳动
let chatDragging = null;   // { offX, offY } 正在拖动标题栏时的相对偏移

function layoutChat() {
  if (mode !== 'result' || !pendingRect) return;
  if (chatDragged) return; // 尊重用户拖放的位置
  const { x, y, w, h } = pendingRect;
  // 默认放框下方，放不下放上方
  let top = y + h + 10;
  if (top + chatCard.offsetHeight > window.innerHeight - 10) {
    top = Math.max(10, y - chatCard.offsetHeight - 10);
  }
  let left = x + w / 2 - chatCard.offsetWidth / 2;
  left = Math.min(Math.max(10, left), window.innerWidth - chatCard.offsetWidth - 10);
  top = Math.max(10, top);
  chatCard.style.left = left + 'px';
  chatCard.style.top = top + 'px';
}

function applyResultHitTest(e) {
  if (mode !== 'result') return;
  const r = chatCard.getBoundingClientRect();
  const overCard = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (overCard) {
    document.body.style.cursor = 'default';
    applyIgnore(false);
  } else {
    applyIgnore(true, true);
  }
}

// ---------- 绘制 ----------
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!rect && mode !== 'result') {
    // 引导：等待框选
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = '16px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('按住鼠标左键，拖出一个框来提问', canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('松开鼠标完成框选  ·  回车补充描述并提问  ·  Esc 取消', canvas.width / 2, canvas.height / 2 + 18);
    requestAnimationFrame(draw);
    return;
  }

  const box = mode === 'result' ? pendingRect : rect;
  const { x, y, w, h } = box;
  const t = Date.now() / 600;
  const pulse = Math.sin(t) * 1.5;

  if (mode !== 'result') {
    // 半透明遮罩 + 挖空
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }

  // 边框
  ctx.shadowColor = 'rgba(0, 255, 136, 0.9)';
  ctx.shadowBlur = 12 + pulse * 3;
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = mode === 'analyzing' ? 2 : 3;
  ctx.strokeRect(x, y, w, h);
  ctx.shadowBlur = 0;

  if (mode === 'select') {
    // 尺寸标签
    ctx.fillStyle = '#00ff88';
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(w)} × ${Math.round(h)}`, x, y > 30 ? y - 8 : y + h + 14);

    // 顶部提示条
    const ty = y > HANDLE_H + 8 ? y - HANDLE_H - 4 : y + h + 4;
    ctx.fillStyle = 'rgba(0, 255, 136, 0.92)';
    roundRect(x, ty, Math.max(w, 210), HANDLE_H, 6);
    ctx.fill();
    ctx.fillStyle = '#00331f';
    ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tip = drag ? '松开完成调整' : '拖动调整 · 回车提问 · Esc 取消';
    ctx.fillText(tip, x + Math.max(w, 210) / 2, ty + HANDLE_H / 2 + 1);
    ctx.textBaseline = 'alphabetic';

    // 8 个缩放把手
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    for (const [hx, hy] of handlePoints()) {
      ctx.fillRect(hx - 4, hy - 4, 8, 8);
      ctx.strokeRect(hx - 4, hy - 4, 8, 8);
    }
  }

  if (mode === 'analyzing') {
    ctx.fillStyle = '#00ff88';
    ctx.font = '14px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    const dots = '.'.repeat(1 + Math.floor(Date.now() / 400) % 3);
    ctx.fillText('AI 分析中' + dots, x + w / 2, y > 40 ? y - 16 : y + h + 24);
  }

  requestAnimationFrame(draw);
}

function handlePoints() {
  const { x, y, w, h } = rect;
  return [
    [x, y], [x + w / 2, y], [x + w, y],
    [x, y + h / 2], [x + w, y + h / 2],
    [x, y + h], [x + w / 2, y + h], [x + w, y + h]
  ];
}

function roundRect(px, py, pw, ph, r) {
  ctx.beginPath();
  ctx.moveTo(px + r, py);
  ctx.arcTo(px + pw, py, px + pw, py + ph, r);
  ctx.arcTo(px + pw, py + ph, px, py + ph, r);
  ctx.arcTo(px, py + ph, px, py, r);
  ctx.arcTo(px, py, px + pw, py, r);
  ctx.closePath();
}

// ---------- 模式切换 ----------
function enterNoteMode() {
  mode = 'note';
  pendingRect = { ...rect };
  hideNoteError(); // 上一轮残留的识别报错别带进新一轮
  // 语音唤醒触发时，说的那句话自动填进补充描述（"噜噜，这个题怎么做"→只留问题部分）
  if (voicePrefillText) {
    noteInput.value = voicePrefillText;
    voicePrefillText = '';
  }
  // 输入框放在框下方，放不下放上方
  const { x, y, w, h } = pendingRect;
  let top = y + h + 10;
  if (top + noteBox.offsetHeight > window.innerHeight - 10) {
    top = Math.max(10, y - noteBox.offsetHeight - 10);
  }
  let left = x + w / 2 - noteBox.offsetWidth / 2;
  left = Math.min(Math.max(10, left), window.innerWidth - noteBox.offsetWidth - 10);
  noteBox.style.left = left + 'px';
  noteBox.style.top = Math.max(10, top) + 'px';
  noteBox.classList.remove('hidden');
  noteInput.focus();
  // 输入框需要键盘，临时停用全局 Esc，避免打字时误关遮罩
  window.overlayAPI.setEscapeEnabled(false);
}

function leaveNoteMode() {
  noteBox.classList.add('hidden');
  noteInput.value = '';
  hideNoteError();
  window.overlayAPI.setEscapeEnabled(true);
}

function enterResultMode() {
  mode = 'result';
  leaveNoteMode();
  chatCard.classList.remove('hidden');
  chatDragged = false; // 新一轮回答恢复自动定位
  layoutChat();
}

function resetToSelect() {
  mode = 'select';
  pendingRect = null;
  cancelVoice(); // 录音途中关掉卡片/遮罩：丢弃录音，避免悬挂的媒体流
  leaveNoteMode();
  chatCard.classList.add('hidden');
  chatDragged = false;
  chatDragging = null;
  chatMessages.innerHTML = '';
  chatInput.value = '';
  chatSendBtn.disabled = false;
  streamingMsg = null;
  pendingFollowupUI = null;
  rect = null;
  applyIgnore(false);
}

// ---------- 补充描述输入框：回车发送，Shift+回车换行 ----------
let analysisTimeout = null;

noteInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  window.overlayAPI.notifyActivity(); // 打字期间不断续期，别让遮罩带着输入内容消失
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (mode !== 'note' || !rect) return;
    const note = noteInput.value.trim();
    leaveNoteMode();
    mode = 'analyzing';
    streamingMsg = null; // 新分析从空开始
    // rect 是逻辑像素；裁剪物理像素坐标的换算在主进程做
    window.overlayAPI.confirmSelection(rect, note);
    // 超时兜底：后端没响应时提示，避免永远卡在"分析中"
    clearTimeout(analysisTimeout);
    analysisTimeout = setTimeout(() => {
      if (mode === 'analyzing') resetToSelect();
    }, 60000);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    leaveNoteMode();
    mode = 'select';
  }
});
noteInput.addEventListener('blur', () => {
  // 仅在补充描述模式下失焦才重新聚焦，其他模式不抢焦点
  if (mode === 'note') setTimeout(() => noteInput.focus(), 0);
});

// ---------- 聊天卡片：追问发送 / 复制 ----------
let pendingFollowupUI = null;
let streamingMsg = null; // 流式输出进行中的那条 AI 消息 DOM

// LaTeX 公式 → 普通人能读的纯文本（\frac{1}{2} → (1/2)、\ln → ln、\left( → (）
function latexToText(s) {
  let t = s || '';
  t = t.replace(/\\(ln|log|sin|cos|tan|arcsin|arccos|arctan|lim|exp|min|max)\b/g, '$1');
  for (let i = 0; i < 8; i++) {
    const next = t.replace(/\\[dt]?frac\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g,
      (m, a, b) => {
        a = a.trim(); b = b.trim();
        const aw = /^[A-Za-z0-9_^√±∞π ]+$/.test(a) ? a : '(' + a + ')';
        const bw = /^[A-Za-z0-9_^√±∞π ]+$/.test(b) ? b : '(' + b + ')';
        return aw + '/' + bw;
      });
    if (next === t) break;
    t = next;
  }
  t = t.replace(/\\sqrt\[[^\]]*\]\s*\{([^{}]*)\}/g, '√($1)');
  t = t.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
  t = t.replace(/\\left\|/g, '|').replace(/\\right\|/g, '|');
  t = t.replace(/\\left\(/g, '(').replace(/\\right\)/g, ')');
  t = t.replace(/\\left\[/g, '[').replace(/\\right\]/g, ']');
  t = t.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '');
  t = t.replace(/\\cdot/g, '×').replace(/\\times/g, '×');
  t = t.replace(/\\pm/g, '±').replace(/\\leq/g, '≤').replace(/\\geq/g, '≥');
  t = t.replace(/\\neq/g, '≠').replace(/\\infty/g, '∞').replace(/\\pi/g, 'π');
  t = t.replace(/\\alpha/g, 'α').replace(/\\beta/g, 'β').replace(/\\theta/g, 'θ');
  t = t.replace(/\\Delta/g, 'Δ').replace(/\\sum/g, 'Σ').replace(/\\int/g, '∫');
  t = t.replace(/\^\{([^{}]*)\}/g, '^($1)');
  t = t.replace(/_\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\[\(\)\[\]]/g, '');
  t = t.replace(/\\(?:text|mathrm|mathbf|mathit)\s*\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\[a-zA-Z]+/g, '');
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t;
}

// 清理 AI 文本里偶尔残留的 Markdown 排版符号（加粗、标题、行内代码、链接），
// 聊天卡片是纯文本展示，这些符号用户读起来很别扭
function stripMarkdown(text) {
  let s = text || '';
  if (s.includes('\\')) s = latexToText(s);              // LaTeX 公式 → 纯文本算式
  s = s.replace(/^[ ]{0,3}#{1,6}\s+/gm, '');          // 行首标题 #
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');            // 加粗 **x**
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2'); // 斜体 *x*
  s = s.replace(/`/g, '');                            // 行内代码 `
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');      // 链接 [x](url)
  s = s.replace(/^(\s*)[-•]\s+/gm, '$1');             // 无序列表横线
  s = s.split('**').join('');                         // 残留的孤立 **
  return s;
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'ai');
  div.textContent = role === 'ai' ? stripMarkdown(text) : text;
  if (role === 'ai') {
    const cleanText = stripMarkdown(text);
    // 复制按钮：整段回答一键进剪贴板；正文本身也可直接拖选复制
    const tools = document.createElement('div');
    tools.className = 'ai-tools';
    const btn = document.createElement('span');
    btn.className = 'copy-btn';
    btn.textContent = '复制';
    btn.addEventListener('click', () => {
      window.overlayAPI.copyText(cleanText);
      btn.textContent = '已复制 ✓';
      setTimeout(() => { btn.textContent = '复制'; }, 1500);
    });
    tools.appendChild(btn);
    const wrap = document.createElement('div');
    wrap.appendChild(tools);
    wrap.appendChild(div);
    chatMessages.appendChild(wrap);
  } else {
    chatMessages.appendChild(div);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
  layoutChat();
  return div;
}

function addThinking() {
  const div = document.createElement('div');
  div.className = 'msg thinking';
  div.textContent = 'AI 正在思考…';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  layoutChat();
  return div;
}

function sendFollowup() {
  const q = chatInput.value.trim();
  if (!q || chatSendBtn.disabled || mode !== 'result') return;
  addMessage('user', q);
  chatInput.value = '';
  const thinking = addThinking();
  chatSendBtn.disabled = true;
  streamingMsg = null;
  pendingFollowupUI = { thinking };
  window.overlayAPI.followupQuestion(q);
  window.overlayAPI.notifyActivity(); // 续期自动隐藏
}

chatSendBtn.addEventListener('click', sendFollowup);

function releaseMedia() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  audioRecorder = null;
}

function finishVoice() {
  clearTimeout(voiceStopTimer);
  voiceState = 'idle';
  voiceTarget = null;
  recordedDataUrl = null;
  setVoiceUI(false, 'chat');
}

function sendRecordedVoice() {
  if (!recordedDataUrl) return;
  const audio = recordedDataUrl;
  recordedDataUrl = null;
  if (voiceTarget === 'chat') {
    window.overlayAPI.voiceQuestion(audio);   // 语音追问：识别后直接分析
  } else {
    window.overlayAPI.voiceTranscribe(audio); // 语音补充描述：仅回填文字
  }
}

// 收到识别结果：chat 场景由后端直接推 guidance（走正常追问流式回复），
// 这里只处理 note 场景——把识别文字回填进补充描述输入框；失败则内联提示 + 直达 API 设置
window.overlayAPI.onVoiceTranscript((payload) => {
  const wasNote = voiceTarget === 'note';
  finishVoice();
  if (payload && payload.error) {
    // 语音唤醒场景失败时遮罩通常还没弹出来，主进程会用桌宠气泡 + 提示框告知，
    // 这里只在用户看得见的地方（补充描述框 / 聊天卡片）显示
    if (wasNote || mode === 'note') {
      showNoteError(payload.hint ? `${payload.error}\n${payload.hint}` : payload.error);
    } else if (mode === 'result') {
      addVoiceErrorMessage(payload);
    }
    return;
  }
  if (wasNote && payload && payload.text) {
    noteInput.value = noteInput.value
      ? noteInput.value + ' ' + payload.text
      : payload.text;
    noteInput.focus();
    hideNoteError();
  }
});

// 语音唤醒触发："噜噜，这个题怎么做"→ 主进程截屏弹出遮罩后，
// 把去掉唤醒词的问题存起来，等用户框完回车进补充描述时自动填入
let voicePrefillText = '';
window.overlayAPI.onVoiceQuestionPrefill((payload) => {
  voicePrefillText = (payload && payload.text) || '';
});

// blobToWavDataUrl / encodeWav 已抽到共享的 voice-utils.js

chatMicBtn.addEventListener('click', () => {
  if (voiceState === 'recording' && voiceTarget === 'chat') stopVoice();
  else if (voiceState === 'idle') startVoice('chat');
});
noteMicBtn.addEventListener('click', () => {
  if (voiceState === 'recording' && voiceTarget === 'note') stopVoice();
  else if (voiceState === 'idle') startVoice('note');
});

chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  window.overlayAPI.notifyActivity(); // 打字期间不断续期
  if (e.key === 'Enter') {
    e.preventDefault();
    sendFollowup();
  }
});
chatInput.addEventListener('focus', () => window.overlayAPI.setEscapeEnabled(false));
chatInput.addEventListener('blur', () => window.overlayAPI.setEscapeEnabled(true));

chatCard.addEventListener('mousedown', (e) => {
  // 点击卡片内部时确保鼠标被接管（不被穿透），才能选中文字
  applyIgnore(false);
  e.stopPropagation();
});
chatCard.addEventListener('wheel', () => {
  // 滚动卡片时续期自动隐藏；内部滚动交给浏览器默认行为
  window.overlayAPI.notifyActivity();
}, { passive: true });

chatCloseBtn.addEventListener('click', () => resetToSelect());

// ---------- 拖动聊天卡片（按住标题栏） ----------
chatHeader.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target === chatCloseBtn) return; // 关闭按钮不触发拖动
  const cardRect = chatCard.getBoundingClientRect();
  chatDragging = { offX: e.clientX - cardRect.left, offY: e.clientY - cardRect.top };
  e.preventDefault();
  e.stopPropagation();
  window.overlayAPI.notifyActivity();
});

document.addEventListener('mousemove', (e) => {
  if (!chatDragging) return;
  const w = chatCard.offsetWidth, h = chatCard.offsetHeight;
  let left = e.clientX - chatDragging.offX;
  let top = e.clientY - chatDragging.offY;
  // 允许拖到屏幕任意位置，但至少留 40px 在屏幕内，别整个拖丢
  left = Math.min(Math.max(-w + 40, left), window.innerWidth - 40);
  top = Math.min(Math.max(0, top), window.innerHeight - 40);
  chatCard.style.left = left + 'px';
  chatCard.style.top = top + 'px';
  chatDragged = true;
  window.overlayAPI.notifyActivity();
});

document.addEventListener('mouseup', () => {
  chatDragging = null;
});

// ---------- 鼠标交互（仅框选/补充描述模式） ----------
document.addEventListener('mousemove', (e) => {
  if (mode === 'result') {
    applyResultHitTest(e);
    return;
  }
  if (mode === 'note' || mode === 'analyzing') return;

  if (selecting) {
    rect = {
      x: Math.min(drag.sx, e.clientX),
      y: Math.min(drag.sy, e.clientY),
      w: Math.abs(e.clientX - drag.sx),
      h: Math.abs(e.clientY - drag.sy)
    };
    // 画框也是持续操作，必须续期自动隐藏，否则 15 秒后遮罩会中途消失
    window.overlayAPI.notifyActivity();
    return;
  }

  if (drag) {
    applyResize(e.clientX, e.clientY);
    window.overlayAPI.notifyActivity();
    return;
  }

  // 悬停时更新光标样式
  const hot = rect ? nearRect(e.clientX, e.clientY) : null;
  document.body.style.cursor = hot ? CURSORS[hot] : 'crosshair';
});

function applyResize(cx, cy) {
  const o = drag.startRect;
  const type = drag.type;
  let { x, y, w, h } = o;
  const dx = cx - drag.sx;
  const dy = cy - drag.sy;

  if (type === 'move') {
    rect = { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h };
    return;
  }
  if (type.includes('w')) { x = o.x + dx; }
  if (type.includes('e')) { w = o.w + dx; }
  if (type.includes('n')) { y = o.y + dy; }
  if (type.includes('s')) { h = o.h + dy; }
  // 最小尺寸约束
  if (w < MIN_SIZE) { if (type.includes('w')) x = o.x + o.w - MIN_SIZE; w = MIN_SIZE; }
  if (h < MIN_SIZE) { if (type.includes('n')) y = o.y + o.h - MIN_SIZE; h = MIN_SIZE; }
  rect = { x, y, w, h };
}

const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  w: 'ew-resize', e: 'ew-resize',
  move: 'move'
};

function nearRect(px, py) {
  if (!rect) return null;
  const { x, y, w, h } = rect;
  const L = x, T = y, R = x + w, B = y + h;
  const inW = px >= L - CORNER && px <= R + CORNER;
  // 角
  if (inW && py >= T - CORNER && py <= T + CORNER && px <= L + CORNER) return 'nw';
  if (inW && py >= T - CORNER && py <= T + CORNER && px >= R - CORNER) return 'ne';
  if (inW && py >= B - CORNER && py <= B + CORNER && px >= R - CORNER) return 'se';
  if (inW && py >= B - CORNER && py <= B + CORNER && px <= L + CORNER) return 'sw';
  // 边
  if (inW && py >= T - HANDLE && py <= T + HANDLE) return 'n';
  if (inW && py >= B - HANDLE && py <= B + HANDLE) return 's';
  if (px >= L - HANDLE && px <= L + HANDLE && py >= T && py <= B) return 'w';
  if (px >= R - HANDLE && px <= R + HANDLE && py >= T && py <= B) return 'e';
  // 内部整体移动
  if (px > L && px < R && py > T && py < B) return 'move';
  return null;
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (mode === 'result' || mode === 'note' || mode === 'analyzing') return;
  window.overlayAPI.setIgnoreMouseEvents(false);
  lastIgnore = false;

  // 点框外空白处 → 重新画一个框
  const type = rect ? nearRect(e.clientX, e.clientY) : null;
  if (!type) {
    selecting = true;
    drag = { type: 'select', sx: e.clientX, sy: e.clientY };
    return;
  }

  drag = { type, startRect: { ...rect }, sx: e.clientX, sy: e.clientY };
});

document.addEventListener('mouseup', (e) => {
  if (selecting) {
    selecting = false;
    if (!rect || rect.w < 10 || rect.h < 10) rect = null; // 太小视为误触
  }
  drag = null;
});

// ---------- 键盘（框选模式）：回车进入补充描述，Esc 取消 ----------
window.addEventListener('keydown', (e) => {
  if (mode === 'note' || mode === 'result') return; // 输入框/卡片自己处理键盘
  if (e.key === 'Enter' && rect && rect.w > 10 && mode !== 'analyzing') {
    e.preventDefault();
    enterNoteMode();
  }
  if (e.key === 'Escape') {
    clearTimeout(analysisTimeout);
    if (mode === 'analyzing') {
      mode = 'select'; // 只取消等待
    } else {
      window.overlayAPI.hideOverlay();
    }
  }
});

// ---------- 收到分析结果 ----------
// 流式增量：首个增量把"AI 正在思考…"占位变成流式消息，后续增量追加文字
window.overlayAPI.onShowResultDelta((payload) => {
  clearTimeout(analysisTimeout);
  if (mode !== 'result') enterResultMode();
  if (!streamingMsg) streamingMsg = addMessage('ai', '');
  streamingMsg.classList.add('streaming');
  // 增量逐段清理：跨增量的 ** 加粗等符号由最终结果的兜底替换保证干净
  streamingMsg.textContent += stripMarkdown(payload.text || '');
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

window.overlayAPI.onShowResult((payload) => {
  clearTimeout(analysisTimeout);
  if (mode !== 'result') enterResultMode();
  // 清掉"AI 正在思考…"占位
  if (pendingFollowupUI && pendingFollowupUI.thinking && pendingFollowupUI.thinking.parentNode) {
    pendingFollowupUI.thinking.parentNode.remove();
  }
  pendingFollowupUI = null;
  chatSendBtn.disabled = false;
  // 流式刚输出完同一段内容时，把光标去掉即可，不要重复添加
  if (streamingMsg) {
    streamingMsg.classList.remove('streaming');
    if (payload.text && streamingMsg.textContent !== stripMarkdown(payload.text)) {
      streamingMsg.textContent = stripMarkdown(payload.text);
    }
    streamingMsg = null;
  } else {
    const text = payload.text || '（AI 没有返回内容）';
    addMessage('ai', text);
  }
  window.overlayAPI.notifyActivity();
});

// ---------- 显示/重置选区 ----------
window.overlayAPI.onShowHighlight((data) => {
  resetToSelect();
  // 关键：框选是模态交互，必须接管鼠标（不能穿透），
  // 否则点击会穿过遮罩打到下层窗口，框选无法开始
  window.overlayAPI.setIgnoreMouseEvents(false);
  lastIgnore = false;
});

draw(); // 启动

