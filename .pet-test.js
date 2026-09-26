// 桌宠回归测试（Electron）：加载**真实页面**验三件事——
// ① 气泡要完整显示在气泡窗口里（以前气泡画在 200x200 的桌宠小窗里，宠物头顶只剩 52px，
//    两行以上的文案会被窗口上边缘裁掉 = "气泡显示不全"）
// ② 桌宠窗口里宠物的位置/尺寸没跑偏，而且气泡确实不再画在那个小窗里
// ③ 唤醒 VAD 的两道闸（连续几拍过阈值、峰值够响）、说话电平自学习（阈值校准）
//    和误唤醒自愈系数的算法
// 运行：npm run test:pet
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`);
  if (!ok) failed++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 窗口尺寸以 main.js 里的常量为准（单一来源，改尺寸只改那一处）
function mainConstants() {
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const pet = src.match(/const PET_WINDOW_SIZE = \{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/);
  const bub = src.match(/const BUBBLE_WINDOW_SIZE = \{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/);
  const img = src.match(/const PET_IMG_HEIGHT = (\d+)/);
  if (!pet || !bub || !img) throw new Error('main.js 里少了窗口尺寸常量，测试要跟着改');
  return {
    pet: { width: Number(pet[1]), height: Number(pet[2]) },
    bubble: { width: Number(bub[1]), height: Number(bub[2]) },
    imgHeight: Number(img[1])
  };
}

const PRELOAD = path.join(__dirname, 'preload.js');

// 桌宠页面启动时会问主进程要唤醒开关，这里固定回 false（测试不去碰麦克风）。
// 顺便数一下调用次数/加载次数：唤醒监听只能启动一次，不然麦克风会被两套 VAD 同时监听
let wakeEnabledCalls = 0;
let pageLoads = 0;
ipcMain.handle('get-voice-wake-enabled', () => { wakeEnabledCalls++; return false; });

app.whenReady().then(async () => {
  const c = mainConstants();

  // ---- ① 气泡窗口：几条真实文案（含主进程 80 字截断上限那条）都要完整落在窗口里 ----
  const bubbleWin = new BrowserWindow({
    width: c.bubble.width,
    height: c.bubble.height,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { preload: PRELOAD }
  });
  await bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));
  await wait(300);

  const texts = [
    '听到「噜噜，这个题怎么做？」',
    '好困呀…先眯一会儿 💤',
    '这次好像是我听岔了，已经把听音灵敏度调低一点～',
    // 80 字 = main.js 里 BUBBLE_MAX_CHARS 的上限，最长就按它来
    '请你先框出题目里不认识的单词，我会把语法点和翻译一句一句讲给你听，看不懂的地方再继续追问，我们慢慢来。'.slice(0, 80)
  ];
  for (const text of texts) {
    const r = await bubbleWin.webContents.executeJavaScript(`(() => {
      bubble.textContent = ${JSON.stringify(text)};
      const b = document.getElementById('bubble').getBoundingClientRect();
      return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, w: b.width, h: b.height,
               winW: innerWidth, winH: innerHeight };
    })()`);
    const tag = `${text.slice(0, 6)}…`;
    check(`气泡完整落在气泡窗口里（${tag}）`,
      r.x >= -0.5 && r.y >= -0.5 && r.right <= r.winW + 0.5 && r.bottom <= r.winH + 0.5,
      `气泡 x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.w)} h=${Math.round(r.h)}，窗口 ${r.winW}x${r.winH}`);
    check(`气泡贴着窗口底边（下面留出小尾巴的位置，${tag}）`,
      Math.abs(r.winH - r.bottom - 8) <= 1.5, `气泡底 ${Math.round(r.bottom)} / 窗口高 ${r.winH}`);
  }

  // ---- ② 桌宠窗口：宠物位置、尺寸，以及"气泡确实搬走了" ----
  const petWin = new BrowserWindow({
    width: c.pet.width,
    height: c.pet.height,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { preload: PRELOAD }
  });
  petWin.webContents.on('did-finish-load', () => { pageLoads++; });
  await petWin.loadFile(path.join(__dirname, 'pet.html'));
  await wait(300);

  check('pet.html 只加载一次、唤醒监听只启动一次',
    pageLoads === 1 && wakeEnabledCalls === 1,
    `加载 ${pageLoads} 次 / 索取唤醒开关 ${wakeEnabledCalls} 次`);

  const pet = await petWin.webContents.executeJavaScript(`(() => {
    const p = document.getElementById('pet-img').getBoundingClientRect();
    return { top: p.top, bottom: p.bottom, left: p.left, right: p.right, height: p.height,
             winW: innerWidth, winH: innerHeight,
             hasBubble: !!document.getElementById('bubble') };
  })()`);
  check('宠物水平居中', Math.abs((pet.left + pet.right) / 2 - pet.winW / 2) <= 1.5,
    `宠物中心 ${Math.round((pet.left + pet.right) / 2)} / 窗口中心 ${Math.round(pet.winW / 2)}`);
  check('宠物贴着窗口底边且高度 = PET_IMG_HEIGHT',
    Math.abs(pet.winH - pet.bottom) <= 0.5 && Math.abs(pet.height - c.imgHeight) <= 0.5,
    `宠物高 ${Math.round(pet.height)}（期望 ${c.imgHeight}）、离底边 ${Math.round(pet.winH - pet.bottom)}px`);
  check('气泡不再画在桌宠小窗里（那段空间根本放不下一句话）', !pet.hasBubble);

  // ---- ③ 唤醒 VAD 判定 + 误唤醒自愈 ----
  const vad = await petWin.webContents.executeJavaScript(`(() => {
    const t = wakeThreshold;
    return {
      quiet: wakeThresholdFor(0.001),   // 安静房间 → 取下限
      noisy: wakeThresholdFor(0.008),   // 有点吵 → 底噪×3
      loud: wakeThresholdFor(0.02),     // 底噪×3 会超过上限 → 卡在 0.05
      normal: acceptWakeClip(1200, t * 2),    // 正常喊一句
      short: acceptWakeClip(400, t * 2),      // 太短（键盘/关门）
      weak: acceptWakeClip(1200, t * 1.1)     // 只是勉强擦过阈值（外放视频/空调）
    };
  })()`);
  check('安静环境取阈值下限 0.006（笔记本麦克风阵列说话只有 0.006~0.008，0.015 喊不动）',
    Math.abs(vad.quiet - 0.006) < 1e-9, `实得 ${vad.quiet}`);
  check('有点吵时阈值 = 底噪×3', Math.abs(vad.noisy - 0.024) < 1e-9, `实得 ${vad.noisy}`);
  check('非常吵时阈值卡在上限 0.05', Math.abs(vad.loud - 0.05) < 1e-9, `实得 ${vad.loud}`);
  check('正常喊一句能送去识别', vad.normal.ok, vad.normal.why);
  check('太短的录音当杂音丢掉', !vad.short.ok, vad.short.why);
  check('勉强擦过阈值的背景音丢掉（不冒泡、不弹框）', !vad.weak.ok, vad.weak.why);

  // 说话电平自学习：低增益麦克风上"喊不动"就靠它（自检/被丢掉的真实录音会调这个）
  const learn = await petWin.webContents.executeJavaScript(`(() => {
    const before = wakeThresholdFor(0.001);
    const ok = learnWakeThreshold(0.008, 1500, '测试');
    const after = wakeThresholdFor(0.001);
    const up = learnWakeThreshold(0.02, 1500, '测试：更响的样本不该把阈值抬回去');
    const quiet = learnWakeThreshold(0.0005, 1500, '测试：跟底噪一样小，不该学');
    const shortClip = learnWakeThreshold(0.05, 300, '测试：太短，不该学');
    // 说完判定：校准后阈值 0.0028 时，说话轻/响两段的停录线
    const stopQuiet = wakeStopThresholdFor(0.008);
    const stopLoud = wakeStopThresholdFor(0.04);
    return { before, ok, after, up, quiet, shortClip, learned: wakeLearnedThreshold, stopQuiet, stopLoud };
  })()`);
  check('学习前安静环境阈值 0.006', Math.abs(learn.before - 0.006) < 1e-9, `实得 ${learn.before}`);
  check('学到说话电平（0.008×0.35=0.0028）后阈值降下来', learn.ok && Math.abs(learn.after - 0.0028) < 1e-9,
    `实得 ${learn.after}`);
  check('只肯往下调：更响的样本不会把阈值抬回去', learn.up === false && Math.abs(learn.learned - 0.0028) < 1e-9,
    `learned=${learn.learned}`);
  check('比底噪还小的、太短的录音都不拿来学习', learn.quiet === false && learn.shortClip === false);
  check('说完判定跟峰值走：说话轻的那段 0.002（阈值 0.0028×0.5=0.0014 不是瓶颈）',
    Math.abs(learn.stopQuiet - 0.002) < 1e-9, `实得 ${learn.stopQuiet}`);
  check('说完判定不会低到录进底噪：说得响的那段要等到 0.01',
    Math.abs(learn.stopLoud - 0.01) < 1e-9, `实得 ${learn.stopLoud}`);

  // ④ 送去识别前的电平归一化（voice-utils.js）：笔记本麦克风说话只有 0.01~0.02，
  //    不放大就被识别接口当成"没有人声"（no audio segment found）
  const norm = await petWin.webContents.executeJavaScript(`(() => {
    const quiet = new Float32Array(1000);
    for (let i = 0; i < quiet.length; i++) quiet[i] = 0.01 * Math.sin(i / 5);
    const gQuiet = normalizePeak(quiet, ASR_NORMALIZE_TARGET, ASR_NORMALIZE_MAX_GAIN);
    const loud = new Float32Array(1000);
    for (let i = 0; i < loud.length; i++) loud[i] = 0.8 * Math.sin(i / 5);
    const gLoud = normalizePeak(loud, ASR_NORMALIZE_TARGET, ASR_NORMALIZE_MAX_GAIN);
    const silent = new Float32Array(1000);
    const gSilent = normalizePeak(silent, ASR_NORMALIZE_TARGET, ASR_NORMALIZE_MAX_GAIN);
    const mid = new Float32Array(1000);
    for (let i = 0; i < mid.length; i++) mid[i] = 0.1 * Math.sin(i / 5);
    const gMid = normalizePeak(mid, ASR_NORMALIZE_TARGET, ASR_NORMALIZE_MAX_GAIN);
    let peakMid = 0;
    for (let i = 0; i < mid.length; i++) peakMid = Math.max(peakMid, Math.abs(mid[i]));
    return { gQuiet, gLoud, gSilent, gMid, peakMid, peakQuiet: quiet.reduce((m, v) => Math.max(m, Math.abs(v)), 0) };
  })()`);
  check('说话电平很低时最多放大 8 倍（封顶，别把底噪也吹起来）',
    Math.abs(norm.gQuiet - 8) < 1e-9 && Math.abs(norm.peakQuiet - 0.08) < 1e-6,
    `gain=${norm.gQuiet}, 峰值=${norm.peakQuiet}`);
  check('本来就够响的录音不动它（只放大不缩小）', norm.gLoud === 1);
  check('纯静音不加增益（免得把噪声识别成词）', norm.gSilent === 1);
  check('中等电平放大到接近目标峰值 0.5',
    Math.abs(norm.gMid - 5) < 0.01 && Math.abs(norm.peakMid - 0.5) < 0.001,
    `gain=${norm.gMid}, 峰值=${norm.peakMid}`);

  // 误唤醒自愈：主进程送来灵敏度系数 → 桌宠抬高校准出来的阈值
  petWin.webContents.send('wake-listen', false, 2);
  await wait(150);
  const bumped = await petWin.webContents.executeJavaScript(
    '({ bump: wakeThresholdBump, threshold: wakeThresholdFor(0.001) })');
  check('收到主进程的灵敏度系数（wake-listen 通道真的通了）', bumped.bump === 2, `实得 ${bumped.bump}`);
  check('系数生效：阈值 0.0028 → 0.0056',
    Math.abs(bumped.threshold - 0.0056) < 1e-9, `实得 ${bumped.threshold}`);

  console.log(failed ? `\n有 ${failed} 项没通过` : '\n全部通过 ✓');
  app.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('测试异常:', e);
  app.exit(1);
});
