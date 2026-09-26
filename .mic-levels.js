// 麦克风电平体检：量一下"默认输入设备在各种 getUserMedia 约束下到底收到多少声音"。
// 用途：排查"喊「噜噜」没反应"——如果说话这几秒的 RMS 只有 0.00x，
// 说明麦克风增益太低/被静音，pet.js 的 VAD 阈值（下限 0.006）根本没被踩到。
// 跑法：对着电脑说一句话（读数会实时打在终端里）
//   npm run test:mic                （默认每组约束量 6 秒）
//   set MIC_LEVELS_MS=10000 && npm run test:mic
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('enable-features', 'AutoplayIgnoreWebAudio');
const MS = Number(process.env.MIC_LEVELS_MS) || 6000;

ipcMain.handle('get-voice-wake-enabled', () => false); // 别让 pet.js 抢麦克风

app.whenReady().then(async () => {
  const { session } = require('electron');
  const allow = ['microphone', 'media'];
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(allow.includes(p)));
  session.defaultSession.setPermissionCheckHandler((wc, p) => allow.includes(p));

  // 必须是 file:// 页面：data: URL 是非安全上下文，navigator.mediaDevices 直接是 undefined
  const tmpHtml = path.join(require('os').tmpdir(), 'mic-levels.html');
  require('fs').writeFileSync(tmpHtml, '<!DOCTYPE html><html><body>mic levels</body></html>', 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  await win.loadFile(tmpHtml);

  console.log(`\n>>> 接下来 ${MS / 1000} 秒 x 3 组约束，请对着麦克风正常说一句话 <<<\n`);

  const out = await win.webContents.executeJavaScript(`(async () => {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const inputs = devs.filter(d => d.kind === 'audioinput').map(d => d.label || '(未授权前无名)');
    const CASES = [
      { label: 'pet.js 的写法（echo+ns 开）', c: { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } } },
      { label: '全部关掉（原声）', c: { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } } },
      { label: '默认 {audio:true}', c: { audio: true } }
    ];
    const res = [];
    for (const one of CASES) {
      const r = { label: one.label };
      try {
        const stream = await navigator.mediaDevices.getUserMedia(one.c);
        const track = stream.getAudioTracks()[0];
        r.settings = track && track.getSettings ? track.getSettings() : null;
        const ctx = new AudioContext();
        await ctx.resume();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        const pcm = new Float32Array(an.fftSize);
        const vals = [];
        let zero = 0;
        for (let i = 0; i < ${MS} / 100; i++) {
          an.getFloatTimeDomainData(pcm);
          let sum = 0;
          for (let k = 0; k < pcm.length; k++) sum += pcm[k] * pcm[k];
          const rms = Math.sqrt(sum / pcm.length);
          if (rms === 0) zero++;
          vals.push(rms);
          await new Promise(r => setTimeout(r, 100));
        }
        r.ctxState = ctx.state;
        r.min = Math.min(...vals).toFixed(5);
        r.max = Math.max(...vals).toFixed(5);
        r.avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(5);
        r.zeroFrames = zero + '/' + vals.length;
        r.nonZeroAvg = (vals.filter(v => v > 0).reduce((a, b) => a + b, 0) / Math.max(1, vals.filter(v => v > 0).length)).toFixed(5);
        stream.getTracks().forEach(t => t.stop());
        ctx.close();
      } catch (e) {
        r.error = String(e && e.name) + ': ' + String(e && e.message);
      }
      res.push(r);
    }
    return { inputs, res };
  })()`);

  console.log('输入设备: ' + JSON.stringify(out.inputs));
  for (const r of out.res) console.log(JSON.stringify(r));
  app.exit(0);
}).catch((e) => { console.error('测试异常:', e); app.exit(1); });
