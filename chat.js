// ============================================================
// 闲聊窗口：跟桌宠聊天（右键桌宠 / 托盘 →「和噜噜聊天…」）
// 和搜题链路完全分开：不截图、不弹遮罩。消息发出去走 chat-message / chat-voice，
// 回复走 chat-delta（流式增量）+ chat-reply（最终结果），对应后端 backend/main.py 的 chat_reply。
// ============================================================
const listEl = document.getElementById('list');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const micBtn = document.getElementById('mic');
const clearBtn = document.getElementById('clear');
const gearBtn = document.getElementById('gear');
const closeBtn = document.getElementById('close');
const suggestEl = document.getElementById('suggest');
const voiceErrorEl = document.getElementById('voice-error');
const voiceErrorText = document.getElementById('voice-error-text');
const voiceErrorSettings = document.getElementById('voice-error-settings');

// 一上来能点的快捷话题（和后端闲聊人设「只聊日常」的范围对齐）
const SUGGESTIONS = ['今天天气怎么样？', '我心情有点糟', '讲个冷笑话', '你平时都在干嘛？'];
// 噜噜是水豚（卡皮巴拉）：主打情绪稳定、慢悠悠，语气词用「咕」「噜」「哼唧」（别用别家动物的拟声）
const GREETINGS = [
  '嗨，我是噜噜～今天想聊点什么？',
  '我在这儿呢，随便说点啥都行～',
  '咕～刚晒了会儿太阳，聊两句放松下呗'
];
const REPLY_TIMEOUT_MS = 60000;   // 后端一直没回音时的兜底：别让界面永远卡在"正在想"
const VOICE_MAX_MS = 60000;       // 最长录 60 秒，防止忘了点停止
const VOICE_MIN_BYTES = 800;      // 小于它视为没录到声音

let streamingEl = null;   // 正在流式输出的那条气泡
let thinkingEl = null;    // "正在想…"占位气泡
let busy = false;         // 等回复期间不许再发，避免消息乱序
let replyTimer = null;

// 清理模型偶尔漏出来的 Markdown 排版符号（和遮罩层那张卡片同一套规则；
// 闲聊不会有公式，所以不做 LaTeX 转换，免得把正常文字改坏）
function stripMarkdown(text) {
  let s = text || '';
  s = s.replace(/^[ ]{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
  s = s.replace(/`/g, '');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/^(\s*)[-•]\s+/gm, '$1');
  return s;
}

function scrollToBottom(force) {
  // 流式输出时用户可能正在往上翻旧记录：只有快到底部（或强制）才跟着滚
  const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
  if (force || nearBottom) listEl.scrollTop = listEl.scrollHeight;
}

// 加一条消息气泡。role: 'me'（用户，绿色靠右）| 'pet'（噜噜，白色靠左）
function addBubble(role, text) {
  const row = document.createElement('div');
  row.className = 'row ' + (role === 'me' ? 'me' : 'pet');
  if (role !== 'me') {
    const av = document.createElement('img');
    av.className = 'av';
    av.src = 'assets/pet.png';
    av.alt = '噜噜';
    av.draggable = false;
    row.appendChild(av);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + (role === 'me' ? 'bubble-me' : 'bubble-pet');
  bubble.textContent = role === 'me' ? text : stripMarkdown(text);
  row.appendChild(bubble);
  if (role !== 'me') {
    // 复制按钮：悬停才显示（见 chat.html 里 .copy 的规则）
    const copy = document.createElement('span');
    copy.className = 'copy';
    copy.textContent = '复制';
    copy.addEventListener('click', () => {
      window.chatAPI.copyText(bubble.textContent);
      copy.textContent = '已复制 ✓';
      setTimeout(() => { copy.textContent = '复制'; }, 1500);
    });
    row.appendChild(copy);
  }
  listEl.appendChild(row);
  hideSuggestions();   // 聊起来就把快捷话题收掉，别一直占着地方
  scrollToBottom(true);
  return bubble;
}

function showSuggestions() {
  suggestEl.innerHTML = '';
  for (const text of SUGGESTIONS) {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', () => submit(text));
    suggestEl.appendChild(b);
  }
  suggestEl.classList.remove('hidden');
}

function hideSuggestions() {
  suggestEl.classList.add('hidden');
}

function addThinking() {
  removeThinking();
  thinkingEl = addBubble('pet', '正在想');
  thinkingEl.classList.add('thinking');
}

function removeThinking() {
  if (thinkingEl && thinkingEl.parentNode) thinkingEl.parentNode.remove();
  thinkingEl = null;
}

// 等回复期间：发送键置灰、🎤 也先别按（避免两轮请求交叉）
function setBusy(on) {
  busy = !!on;
  sendBtn.disabled = busy;
  micBtn.classList.toggle('busy', busy);
  clearTimeout(replyTimer);
  replyTimer = null;
  if (busy) {
    replyTimer = setTimeout(() => {
      setBusy(false);
      removeThinking();
      addBubble('pet', '等了好久都没回音…要不再说一句试试？');
    }, REPLY_TIMEOUT_MS);
  }
}

function showVoiceError(text) {
  voiceErrorText.textContent = text || '语音识别失败了，稍后再试';
  voiceErrorEl.classList.add('visible');
}

function hideVoiceError() {
  voiceErrorEl.classList.remove('visible');
}

// 发一句话（聊天里唯一的入口：输入框、快捷话题、语音识别结果都走它）
function submit(text) {
  const q = (text || '').trim();
  if (!q || busy) return;
  hideVoiceError();
  addBubble('me', q);
  inputEl.value = '';
  autoGrow();
  setBusy(true);
  addThinking();
  window.chatAPI.send(q);
}

// ---------- 输入框：回车发送、Shift+回车换行、随内容长高 ----------
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(96, inputEl.scrollHeight) + 'px';
}

inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit(inputEl.value);
  }
});
sendBtn.addEventListener('click', () => submit(inputEl.value));
micBtn.addEventListener('click', () => {
  if (voiceState === 'recording') stopVoice();
  else if (voiceState === 'idle') startVoice();
});
clearBtn.addEventListener('click', () => {
  if (busy) return;   // 正在等回复就别清，免得历史被清空了回复又落进来
  window.chatAPI.reset();
});
gearBtn.addEventListener('click', () => window.chatAPI.openSettings());
closeBtn.addEventListener('click', () => window.chatAPI.close());
voiceErrorSettings.addEventListener('click', () => window.chatAPI.openSettings());
window.addEventListener('resize', () => scrollToBottom(true));

// ---------- 语音聊天：录音 → 主进程 → 后端 ASR → 识别到的话当成用户发言 ----------
let mediaStream = null;
let audioRecorder = null;
let audioChunks = [];
let recordedDataUrl = null;      // 停止录音后暂存，等转码完再发
let voiceState = 'idle';         // idle | recording | busy
let voiceStopTimer = null;

function releaseMedia() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  audioRecorder = null;
}

function setMicUI(recording) {
  micBtn.classList.toggle('recording', recording);
  if (!recording) micBtn.classList.remove('busy');
}

async function startVoice() {
  if (voiceState !== 'idle' || busy) return;
  hideVoiceError();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showVoiceError('这个环境用不了麦克风录音');
    return;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (e) {
    showVoiceError('无法访问麦克风：' + (e.message || e.name || e));
    return;
  }
  voiceState = 'recording';
  audioChunks = [];
  audioRecorder = new MediaRecorder(mediaStream);
  audioRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  audioRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: audioRecorder.mimeType || 'audio/webm' });
    releaseMedia();
    if (blob.size < VOICE_MIN_BYTES) {   // 太短视为误触，直接复位
      voiceState = 'idle';
      return;
    }
    blobToWavDataUrl(blob).then((dataUrl) => {
      recordedDataUrl = dataUrl;
      voiceState = 'idle';
      setBusy(true);
      addThinking();
      window.chatAPI.sendVoice(recordedDataUrl);
      recordedDataUrl = null;
    }).catch((e) => {
      voiceState = 'idle';
      showVoiceError('录音处理失败：' + e);
    });
  };
  audioRecorder.start();
  setMicUI(true);
  // 超时自动停止并识别，别一直录着
  clearTimeout(voiceStopTimer);
  voiceStopTimer = setTimeout(stopVoice, VOICE_MAX_MS);
}

function stopVoice() {
  if (voiceState !== 'recording' || !audioRecorder) return;
  clearTimeout(voiceStopTimer);
  voiceStopTimer = null;
  setMicUI(false);
  try {
    audioRecorder.stop();
  } catch (e) {
    releaseMedia();
    voiceState = 'idle';
  }
}

// 收到识别结果：成功时它这句话就是用户的发言（回复随后流式到），失败时内联提示
window.chatAPI.onTranscript((payload) => {
  if (!payload) return;
  if (payload.error) {
    setBusy(false);
    removeThinking();
    showVoiceError([payload.error, payload.hint].filter(Boolean).join('\n'));
    return;
  }
  if (payload.text) addBubble('me', payload.text);
});

// 流式增量：第一条增量把"正在想…"换成正经气泡，往后一直追加
window.chatAPI.onDelta((payload) => {
  if (!payload) return;
  removeThinking();
  if (!streamingEl) streamingEl = addBubble('pet', '');
  streamingEl.classList.add('streaming');
  streamingEl.textContent += stripMarkdown(payload.text || '');
  scrollToBottom(false);
});

// 最终结果：把流式气泡定稿（后端送来的整段是清理过的，比拼接的增量干净）
window.chatAPI.onReply((payload) => {
  setBusy(false);
  removeThinking();
  const text = (payload && payload.text) || '';
  const failed = !!(payload && payload.error);
  let bubble;
  if (streamingEl) {
    streamingEl.classList.remove('streaming');
    streamingEl.textContent = stripMarkdown(text) || '（我没听清，再说一遍？）';
    bubble = streamingEl;
    streamingEl = null;
  } else {
    bubble = addBubble('pet', text || '（我没听清，再说一遍？）');
  }
  if (failed) {
    bubble.classList.add('failed');
    showVoiceError([text, payload.hint].filter(Boolean).join('\n'));
  }
  scrollToBottom(false);
});

// 后端没连上这类"发都发不出去"的情况
window.chatAPI.onError((payload) => {
  setBusy(false);
  removeThinking();
  addBubble('pet', (payload && payload.text) || '我这边好像出问题了…');
});

// 清空话题（主进程把历史清掉后回一条招呼语）
window.chatAPI.onReset((payload) => {
  listEl.innerHTML = '';
  streamingEl = null;
  thinkingEl = null;
  setBusy(false);
  hideVoiceError();
  if (payload && payload.text) addBubble('pet', payload.text);
  showSuggestions();
  inputEl.focus();
});

// ---------- 打开窗口：把主进程存的历史铺回来（关掉再打开还能接着上文聊） ----------
window.chatAPI.getHistory().then((history) => {
  const items = Array.isArray(history) ? history : [];
  for (const m of items) {
    if (!m || !m.content) continue;
    addBubble(m.role === 'user' ? 'me' : 'pet', m.content);
  }
  hideSuggestions();
  if (!items.length) {
    // 全新对话：先打个招呼 + 给几个能直接点的开场白
    addBubble('pet', GREETINGS[Math.floor(Math.random() * GREETINGS.length)]);
    showSuggestions();
  }
  scrollToBottom(true);
  inputEl.focus();
}).catch(() => {
  hideSuggestions();
  inputEl.focus();
});

autoGrow();
