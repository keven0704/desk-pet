// 闲聊窗口回归测试（Electron）：加载**真实页面** chat.html，验四件事——
// ① 打开窗口时能把主进程存的历史铺回来（关掉再打开还能接着上文聊），全新对话则给招呼语 + 快捷话题
// ② 流式回复：chat-delta 增量显示（带打字光标）→ chat-reply 定稿（Markdown 符号被清掉）
// ③ 各种失败路径都能在窗口里说清楚：chat-error（后端没连上）、chat-transcript 带 error（语音识别）
// ④ 交互与接线：快捷话题 / 回车发送 → chat-message；清空话题；preload 与 main.js 的通道真的都存在
// 运行：npm run test:chat
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PRELOAD = path.join(__dirname, 'preload.js');

// 页面启动时会 invoke('get-chat-history')，这里按用例给它不同的历史
let historyForTest = [];
let sentMessages = [];
ipcMain.handle('get-chat-history', () => historyForTest);
ipcMain.on('chat-message', (event, text) => { sentMessages.push(text); });

// ---------- 静态接线检查（不用起整个桌宠就能发现"通道漏了/菜单没加"） ----------
function staticChecks() {
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const size = mainSrc.match(/const CHAT_WINDOW_SIZE = \{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/);
  check('main.js 里有 CHAT_WINDOW_SIZE 常量', !!size, size ? `${size[1]}x${size[2]}` : '没找到');

  for (const ch of ["'open-chat'", "'chat-message'", "'chat-voice'", "'chat-reset'", "'close-chat-window'", "'get-chat-history'"]) {
    check(`main.js 注册了 ${ch}`, mainSrc.includes(ch));
  }
  for (const part of ["'chat-delta'", "'chat-reply'", "'chat-transcript'"]) {
    check(`main.js 转发了 ${part}`, mainSrc.includes(part));
  }
  // 后端还是旧版（没有闲聊接口）时会回"未知消息类型: chat"：这条必须有人接，
  // 否则聊天窗口会一直卡在"正在想"，用户完全不知道发生了什么
  check('main.js 处理后端通用 error（旧版后端能给出重建提示）',
    mainSrc.includes("msg.type === 'error'") && mainSrc.includes('build-backend.bat'));
  const menuCount = (mainSrc.match(/label: '和噜噜聊天…'/g) || []).length;
  check('右键菜单和托盘里都有「和噜噜聊天…」', menuCount === 2, `菜单项 ${menuCount} 个`);
  for (const api of ['chatAPI', 'send:', 'sendVoice:', 'getHistory:', 'onDelta:', 'onReply:', 'onTranscript:', 'onError:', 'onReset:']) {
    check(`preload.js 暴露了 ${api}`, preloadSrc.includes(api));
  }
  // 聊天时不能再开着语音唤醒监听：两个渲染进程同时开麦克风会把框选遮罩弹出来
  check('main.js 用 wakeShouldListen() 统一判断唤醒开关',
    mainSrc.includes('function wakeShouldListen') && mainSrc.includes('!isChatVisible()'));

  // 噜噜是水豚（卡皮巴拉），不是猫：界面文案里别留"猫味"
  const uiFiles = ['chat.html', 'chat.js', 'pet.js'];
  const uiSrc = uiFiles.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const catHits = uiSrc.match(/猫|喵/g) || [];
  check('聊天/桌宠界面文案里没有"猫味"（噜噜是水豚）', catHits.length === 0, catHits.join(''));
  check('聊天窗口自称水豚', fs.readFileSync(path.join(__dirname, 'chat.html'), 'utf8').includes('水豚'));
  check('招呼语用「咕」（水豚语气，不是喵）',
    fs.readFileSync(path.join(__dirname, 'chat.js'), 'utf8').includes('咕～'));
}

const SNAPSHOT = `(() => {
  const rows = [...document.querySelectorAll('#list .row')];
  return {
    count: rows.length,
    roles: rows.map(r => r.classList.contains('me') ? 'me' : 'pet'),
    texts: rows.map(r => (r.querySelector('.bubble') || { textContent: '' }).textContent),
    streaming: rows.map(r => !!r.querySelector('.bubble.streaming')),
    thinking: rows.map(r => !!r.querySelector('.bubble.thinking')),
    failed: rows.map(r => !!r.querySelector('.bubble.failed')),
    suggestHidden: document.getElementById('suggest').classList.contains('hidden'),
    suggestCount: document.querySelectorAll('#suggest button').length,
    voiceErrorVisible: document.getElementById('voice-error').classList.contains('visible'),
    voiceErrorText: document.getElementById('voice-error-text').textContent,
    inputValue: document.getElementById('input').value,
    sendDisabled: document.getElementById('send').disabled
  };
})()`;

app.whenReady().then(async () => {
  staticChecks();

  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const size = src.match(/const CHAT_WINDOW_SIZE = \{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/);
  const chatWin = new BrowserWindow({
    width: Number(size[1]),
    height: Number(size[2]),
    show: false,
    frame: false,
    webPreferences: { preload: PRELOAD }
  });
  const snap = () => chatWin.webContents.executeJavaScript(SNAPSHOT);

  // ---- ① 全新对话：招呼语 + 快捷话题 ----
  historyForTest = [];
  await chatWin.loadFile(path.join(__dirname, 'chat.html'));
  await wait(400);
  let s = await snap();
  check('全新对话显示招呼语气泡', s.count === 1 && s.roles[0] === 'pet' && s.texts[0].length > 0, s.texts[0]);
  check('全新对话给出快捷话题按钮', s.suggestCount === 4 && !s.suggestHidden, `按钮 ${s.suggestCount} 个`);

  // ---- ② 历史铺回来（关掉窗口再打开接着聊） ----
  historyForTest = [
    { role: 'user', content: '今天好累啊' },
    { role: 'assistant', content: '辛苦啦～要不要聊点轻松的？' }
  ];
  await chatWin.webContents.reload();
  await wait(400);
  s = await snap();
  check('历史按顺序铺回来（我 → 噜噜）', s.count === 2 && s.roles[0] === 'me' && s.roles[1] === 'pet',
    JSON.stringify(s.roles));
  check('历史内容原样显示', s.texts[0] === '今天好累啊' && s.texts[1].indexOf('辛苦啦') === 0, JSON.stringify(s.texts));
  check('有历史时收掉快捷话题', s.suggestHidden && s.suggestCount === 0);

  // ---- ③ 流式回复：chat-delta 累加 → chat-reply 定稿 ----
  chatWin.webContents.send('chat-delta', { text: '今天' });
  chatWin.webContents.send('chat-delta', { text: '不错呀' });
  await wait(200);
  s = await snap();
  check('流式增量拼成一条气泡并带打字光标',
    s.count === 3 && s.streaming[2] && s.texts[2] === '今天不错呀', JSON.stringify(s.texts));

  chatWin.webContents.send('chat-reply', { text: '**今天不错呀**，适合摸鱼～' });
  await wait(200);
  s = await snap();
  check('最终结果替换流式内容并去掉 Markdown 符号',
    s.count === 3 && !s.streaming[2] && s.texts[2] === '今天不错呀，适合摸鱼～', s.texts[2]);
  check('回复到了就恢复发送', s.sendDisabled === false);

  // ---- ④ 失败路径 ----
  chatWin.webContents.send('chat-error', { text: '我还没连上后端呢…' });
  await wait(150);
  s = await snap();
  check('后端没连上时在窗口里说明', s.count === 4 && s.texts[3].includes('还没连上后端'), s.texts[3]);

  chatWin.webContents.send('chat-transcript', { error: '语音识别失败：余额不足', hint: '换成免费的硅基流动', scope: 'chat' });
  await wait(150);
  s = await snap();
  check('语音识别失败时内联提示（含解决办法）',
    s.voiceErrorVisible && s.voiceErrorText.includes('余额不足') && s.voiceErrorText.includes('硅基流动'),
    s.voiceErrorText);
  check('识别失败不再留下"正在想"占位', s.thinking.every((v) => !v));

  // 语音识别成功：识别出的那句话就是用户的发言
  chatWin.webContents.send('chat-transcript', { text: '帮我讲讲今天的天气', scope: 'chat' });
  await wait(150);
  s = await snap();
  check('语音识别到的话显示成我的发言',
    s.count === 5 && s.roles[4] === 'me' && s.texts[4] === '帮我讲讲今天的天气', JSON.stringify(s.roles));

  chatWin.webContents.send('chat-reply', { text: '哎呀，我这会儿有点卡壳：连接失败', error: 'connect failed',
    hint: '到「API 设置」看看服务商和 Key 对不对' });
  await wait(150);
  s = await snap();
  check('模型报错时气泡标红并给出设置入口',
    s.failed[5] === true && s.voiceErrorVisible && s.voiceErrorText.includes('API 设置'),
    JSON.stringify(s.texts[5]));
  check('报错气泡也去掉了思考占位', s.count === 6 && s.thinking.every((v) => !v), `共 ${s.count} 条`);

  // ---- ⑤ 交互与接线：快捷话题 / 回车发送 / 清空话题 ----
  historyForTest = [];
  sentMessages = [];
  await chatWin.webContents.reload();
  await wait(400);

  const chipText = await chatWin.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('#suggest button'); const t = b.textContent; b.click(); return t; })()`);
  await wait(200);
  s = await snap();
  check('点快捷话题就发出去（走 chat-message）', sentMessages[0] === chipText, JSON.stringify(sentMessages));
  check('发完立刻显示我的发言 + "正在想"占位',
    s.count === 3 && s.roles[1] === 'me' && s.texts[1] === chipText && s.thinking[2] === true,
    JSON.stringify(s.texts));
  check('等回复期间发送键置灰', s.sendDisabled === true);

  chatWin.webContents.send('chat-reply', { text: '今天晴，适合出去走走～' });
  await wait(200);
  s = await snap();
  check('回复到了：思考占位被替换成正常气泡',
    s.count === 3 && s.thinking.every((v) => !v) && s.texts[2].indexOf('今天晴') === 0, JSON.stringify(s.texts));
  check('回复后恢复发送', s.sendDisabled === false);

  // 输入框里打字 + 回车发送（Shift+回车不发送）
  await chatWin.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('input');
    el.value = '晚上吃啥好';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    return true;
  })()`);
  await wait(100);
  check('Shift+回车不发送（留给换行）', sentMessages.length === 1, JSON.stringify(sentMessages));

  await chatWin.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await wait(200);
  s = await snap();
  check('回车发送并把输入框清空',
    sentMessages[1] === '晚上吃啥好' && s.count === 5 && s.texts[3] === '晚上吃啥好' && s.inputValue === '',
    JSON.stringify(sentMessages) + ' / ' + JSON.stringify(s.texts));

  // 清空话题（主进程清完历史后回一条招呼语）
  chatWin.webContents.send('chat-reply', { text: '吃火锅呀～' });
  await wait(150);
  chatWin.webContents.send('chat-reset-done', { text: '话题清空啦，想聊点什么？' });
  await wait(150);
  s = await snap();
  check('清空话题后只剩招呼语 + 快捷话题',
    s.count === 1 && s.roles[0] === 'pet' && s.texts[0] === '话题清空啦，想聊点什么？'
      && !s.suggestHidden && s.suggestCount === 4,
    JSON.stringify(s.texts));
  check('清空后我的输入不残留、也不在等回复',
    (await chatWin.webContents.executeJavaScript("document.getElementById('input').value")) === ''
      && s.sendDisabled === false);

  console.log(failed ? `\n有 ${failed} 项没通过` : '\n全部通过 ✓');
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('测试异常:', e);
  app.exit(1);
});
