const providerSelect = document.getElementById('provider');
const apiKeyInput = document.getElementById('api-key');
const apiUrlInput = document.getElementById('api-url');
const modelInput = document.getElementById('model');
const urlField = document.getElementById('url-field');
const keyHint = document.getElementById('key-hint');
const msgEl = document.getElementById('msg');
// 语音识别（ASR）单独一份配置
const asrProviderSelect = document.getElementById('asr-provider');
const asrKeyInput = document.getElementById('asr-key');
const asrUrlInput = document.getElementById('asr-url');
const asrModelInput = document.getElementById('asr-model');
const asrUrlField = document.getElementById('asr-url-field');
const asrHint = document.getElementById('asr-hint');
// 闲聊（右键 → 和噜噜聊天）
const chatModelInput = document.getElementById('chat-model');
const chatHint = document.getElementById('chat-hint');
const cityInput = document.getElementById('city');

const PROVIDER_DEFAULTS = {
  glm: { model: 'glm-4v-flash', hint: '在 https://open.bigmodel.cn 注册后获取，glm-4v-flash 免费' },
  openai: { model: 'gpt-4o-mini', hint: '在 https://platform.openai.com/api-keys 获取' },
  siliconflow: { model: 'Qwen/Qwen2.5-VL-32B-Instruct', hint: '在 https://cloud.siliconflow.cn 获取，部分视觉模型免费' },
  custom: { model: '', hint: '自定义服务商的 Key' }
};

// 闲聊用哪家的哪个模型：纯文本模型比视觉模型更适合陪聊，也便宜/免费
const CHAT_DEFAULTS = {
  glm: { model: 'glm-4-flash', hint: '闲聊默认用智谱 glm-4-flash（免费）' },
  openai: { model: 'gpt-4o-mini', hint: '闲聊默认用 gpt-4o-mini' },
  siliconflow: { model: 'Qwen/Qwen2.5-7B-Instruct', hint: '闲聊默认用 Qwen/Qwen2.5-7B-Instruct（有免费额度）' },
  custom: { model: '', hint: '留空则闲聊也跟上门的模型走' }
};

function applyChatDefaults() {
  const def = CHAT_DEFAULTS[providerSelect.value] || CHAT_DEFAULTS.glm;
  chatModelInput.placeholder = def.model || '默认模型名';
  chatHint.textContent = def.hint;
}

// 语音识别的各家默认模型 + 提示（glm-asr 要余额，没余额会报 429/1113，所以推荐免费的 SenseVoice）
const ASR_DEFAULTS = {
  '': {
    model: '',
    hint: '跟随主服务商：智谱会走收费的 glm-asr，账户没余额时语音会报「余额不足」，建议单独指定一个'
  },
  siliconflow: {
    model: 'FunAudioLLM/SenseVoiceSmall',
    hint: 'SenseVoiceSmall 免费；在 https://cloud.siliconflow.cn 拿 Key 填到下面（可复用同一账号）'
  },
  glm: { model: 'glm-asr', hint: '智谱 glm-asr 按量计费，余额不足会返回 429/1113' },
  openai: { model: 'whisper-1', hint: 'OpenAI whisper-1 按量计费' },
  custom: { model: '', hint: '填写 OpenAI 兼容的 audio/transcriptions 接口地址和模型名' }
};

function applyAsrDefaults() {
  const def = ASR_DEFAULTS[asrProviderSelect.value] || ASR_DEFAULTS[''];
  asrModelInput.placeholder = def.model || '默认模型名';
  asrHint.textContent = def.hint;
  asrUrlField.classList.toggle('hidden', asrProviderSelect.value !== 'custom');
}

// 服务商切换：自定义才显示接口地址输入框，其他给出默认模型占位
providerSelect.addEventListener('change', () => {
  urlField.classList.toggle('hidden', providerSelect.value !== 'custom');
  const def = PROVIDER_DEFAULTS[providerSelect.value];
  modelInput.placeholder = def && def.model ? def.model : '默认模型名';
  applyChatDefaults();   // 闲聊模型也跟着换服务商的默认值
});

asrProviderSelect.addEventListener('change', applyAsrDefaults);

// 加载当前配置
window.petAPI.getApiConfig().then((cfg) => {
  providerSelect.value = cfg.provider || 'glm';
  apiKeyInput.value = cfg.apiKey || '';
  apiUrlInput.value = cfg.apiUrl || '';
  modelInput.value = cfg.model || '';
  urlField.classList.toggle('hidden', providerSelect.value !== 'custom');
  if (cfg.apiKey) keyHint.textContent = '已保存有效 Key，可覆盖输入新的';
  // 闲聊：模型与所在城市（城市用来查天气）
  chatModelInput.value = cfg.chatModel || '';
  cityInput.value = cfg.city || '';
  applyChatDefaults();
  asrProviderSelect.value = cfg.asrProvider || '';
  asrKeyInput.value = cfg.asrKey || '';
  asrUrlInput.value = cfg.asrUrl || '';
  asrModelInput.value = cfg.asrModel || '';
  applyAsrDefaults();
});

// 保存
document.getElementById('save-btn').addEventListener('click', async () => {
  const cfg = {
    provider: providerSelect.value,
    apiKey: apiKeyInput.value.trim(),
    apiUrl: apiUrlInput.value.trim(),
    model: modelInput.value.trim(),
    chatModel: chatModelInput.value.trim(),
    city: cityInput.value.trim(),
    asrProvider: asrProviderSelect.value,
    asrKey: asrKeyInput.value.trim(),
    asrUrl: asrUrlInput.value.trim(),
    asrModel: asrModelInput.value.trim()
  };
  if (cfg.provider === 'custom' && !cfg.apiUrl) {
    showMsg('自定义服务商需要填写接口地址', true);
    return;
  }
  if (cfg.asrProvider === 'custom' && !cfg.asrUrl) {
    showMsg('自定义语音识别需要填写接口地址', true);
    return;
  }
  const ok = await window.petAPI.saveApiConfig(cfg);
  if (ok) {
    showMsg('已保存 ✓');
    setTimeout(() => window.petAPI.closeSettingsWindow(), 800);
  } else {
    showMsg('保存失败', true);
  }
});

document.getElementById('cancel-btn').addEventListener('click', () => {
  window.petAPI.closeSettingsWindow();
});

function showMsg(text, isError) {
  msgEl.textContent = text;
  msgEl.style.color = isError ? '#d94a4a' : '#2a9d4a';
}
