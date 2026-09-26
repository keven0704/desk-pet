// ============================================================
// 共享的音频处理工具：把 MediaRecorder 录出的 WebM/MP4 音频
// 转成 16kHz 单声道 PCM WAV dataURL，供后端 ASR 接口识别。
// overlay.js（语音输入）和 pet.js（语音唤醒）共用。
// ============================================================

// WebM/MP4 录音 → 16kHz 单声道 PCM WAV（后端 ASR 接口兼容性最好）
//
// 顺便把电平归一化：笔记本自带的麦克风阵列增益低，说话录出来峰值只有 0.01~0.02，
// 识别接口常常回"no audio segment found"（它自己听不出人声）——表现就是"喊了没反应"
// 或"识别成一堆乱七八糟的字"。这里只放大（不缩小），最多 8 倍，避免把纯底噪也吹响。
const ASR_NORMALIZE_TARGET = 0.5;
const ASR_NORMALIZE_MAX_GAIN = 8;

function normalizePeak(samples, target, maxGain) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return 1;
  const gain = Math.min(maxGain, target / peak);
  if (gain <= 1) return 1;          // 本来就够响（甚至削顶）：不动它
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return gain;
}

async function blobToWavDataUrl(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuf);
    // 先按原采样率取声道均值，再线性插值重采样到 16kHz
    const chCount = decoded.numberOfChannels;
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < chCount; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < decoded.length; i++) mono[i] += data[i] / chCount;
    }
    const targetRate = 16000;
    const ratio = decoded.sampleRate / targetRate;
    const outLen = Math.max(1, Math.floor(decoded.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, decoded.length - 1);
      out[i] = mono[i0] + (mono[i1] - mono[i0]) * (pos - i0);
    }
    normalizePeak(out, ASR_NORMALIZE_TARGET, ASR_NORMALIZE_MAX_GAIN);
    return encodeWav(out, targetRate);
  } finally {
    ctx.close();
  }
}

// 写 WAV 文件头 + 16bit PCM 数据，返回 dataURL
function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true);              // 块对齐
  view.setUint16(34, 16, true);             // 位深
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:audio/wav;base64,' + btoa(bin);
}
