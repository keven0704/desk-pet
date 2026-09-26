const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  onClick: () => ipcRenderer.invoke('pet-clicked'),
  setIgnoreMouseEvents: (ignore, options) => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, options);
  },
  onShowBubble: (callback) => ipcRenderer.on('show-bubble', (event, text) => callback(text)),
  // 桌宠页面自己冒的气泡：交给主进程在"气泡窗口"里显示（那里放得下完整一句话）
  showBubble: (text) => ipcRenderer.send('show-pet-bubble', text),
  onBackendStatus: (callback) => ipcRenderer.on('backend-status', (event, ok) => callback(ok)),
  onTriggerScreenshot: (callback) => ipcRenderer.on('trigger-screenshot', () => callback()),
  onFeedPet: (callback) => ipcRenderer.on('feed-pet', () => callback()),
  moveWindow: (x, y) => ipcRenderer.send('move-window', x, y),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  saveApiConfig: (cfg) => ipcRenderer.invoke('save-api-config', cfg),
  closeSettingsWindow: () => ipcRenderer.send('close-settings-window'),
  // 语音唤醒：桌宠端录音识别请求 / 唤醒命中回调 / 主进程暂停恢复监听
  // meta = 这段录音的电平信息（峰值/阈值），主进程用它决定要不要冒泡提示、怎么看日志
  wakeListen: (audio, meta) => ipcRenderer.send('wake-listen-audio', audio, meta),
  onWakeTriggered: (callback) => ipcRenderer.on('wake-triggered', (event, payload) => callback(payload)),
  // 唤醒监听开关：enabled=现在要不要听；bump=听音灵敏度系数（误唤醒自愈会调大它）
  onWakeListenControl: (callback) => ipcRenderer.on('wake-listen', (event, enabled, bump) => callback(enabled, bump)),
  getVoiceWakeEnabled: () => ipcRenderer.invoke('get-voice-wake-enabled'),
  // 语音唤醒自检 + 状态回报（日志会打到 npm start 的终端里）
  onWakeSelfTest: (callback) => ipcRenderer.on('wake-self-test', () => callback()),
  wakeSelfTestAudio: (audio, meta) => ipcRenderer.send('wake-self-test-audio', audio, meta),
  reportWakeStatus: (text) => ipcRenderer.send('wake-status', text)
});

contextBridge.exposeInMainWorld('overlayAPI', {
  onShowHighlight: (callback) => ipcRenderer.on('show-highlight', (event, data) => callback(data)),
  onShowResult: (callback) => ipcRenderer.on('show-result', (event, payload) => callback(payload)),
  onShowResultDelta: (callback) => ipcRenderer.on('show-result-delta', (event, payload) => callback(payload)),
  confirmSelection: (rect, note) => ipcRenderer.send('confirm-selection', rect, note),
  followupQuestion: (question) => ipcRenderer.send('followup-question', question),
  copyText: (text) => ipcRenderer.send('copy-text', text),
  voiceTranscribe: (audio) => ipcRenderer.send('voice-transcribe', audio),
  voiceQuestion: (audio) => ipcRenderer.send('voice-question', audio),
  onVoiceTranscript: (callback) => ipcRenderer.on('voice-transcript', (event, payload) => callback(payload)),
  onVoiceQuestionPrefill: (callback) => ipcRenderer.on('voice-question-prefill', (event, payload) => callback(payload)),
  openSettings: () => ipcRenderer.send('open-settings'),
  setEscapeEnabled: (enabled) => ipcRenderer.send('set-escape-enabled', enabled),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  setIgnoreMouseEvents: (ignore, options) => {
    ipcRenderer.send('set-ignore-mouse-events', ignore, options);
  },
  notifyActivity: () => ipcRenderer.send('overlay-activity')
});

// 闲聊窗口（chat.html）：和搜题链路完全分开的一套接口——
// 文字/语音发出去走 chat-message / chat-voice，回复走 chat-delta（流式）+ chat-reply（最终）
contextBridge.exposeInMainWorld('chatAPI', {
  send: (text) => ipcRenderer.send('chat-message', text),
  sendVoice: (audio) => ipcRenderer.send('chat-voice', audio),
  reset: () => ipcRenderer.send('chat-reset'),
  close: () => ipcRenderer.send('close-chat-window'),
  openSettings: () => ipcRenderer.send('open-settings'),
  copyText: (text) => ipcRenderer.send('copy-text', text),
  // 打开窗口时拉一次历史：关掉再打开还能接着上文聊
  getHistory: () => ipcRenderer.invoke('get-chat-history'),
  onDelta: (callback) => ipcRenderer.on('chat-delta', (event, payload) => callback(payload)),
  onReply: (callback) => ipcRenderer.on('chat-reply', (event, payload) => callback(payload)),
  // 语音闲聊识别出的那句话（成功时带 text，失败时带 error/hint）
  onTranscript: (callback) => ipcRenderer.on('chat-transcript', (event, payload) => callback(payload)),
  onError: (callback) => ipcRenderer.on('chat-error', (event, payload) => callback(payload)),
  onReset: (callback) => ipcRenderer.on('chat-reset-done', (event, payload) => callback(payload))
});
