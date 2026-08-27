function phoneKey() {
  const pathMatch = String(location.pathname || '').match(/^\/t\/([^/]+)/);
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  return pathMatch?.[1] || query.get('k') || hash.get('k') || sessionStorage.getItem('zh-en-k') || '';
}

function rememberKey() {
  const key = phoneKey();
  if (key) sessionStorage.setItem('zh-en-k', key);
  return key;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), 'X-Talk-Key': rememberKey() };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) throw new Error('链接无效，请用电脑上的二维码重新打开');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.slice(0, 240) || `请求失败（${res.status}）`);
  }
  return res;
}

function createHttpTalk() {
  let cached = null;
  async function status() {
    const res = await api('/api/status');
    cached = await res.json();
    return cached;
  }

  return {
    getApiKey: async () => ((await status()).hasDeepSeek ? 'saved' : ''),
    setApiKey: async () => {
      throw new Error('请在电脑上保存 DeepSeek API Key');
    },
    getDoubaoKey: async () => ((await status()).hasAsr ? 'saved' : ''),
    setDoubaoKey: async () => {},
    getDoubaoSpeaker: async () => '',
    setDoubaoSpeaker: async () => {},
    getDoubaoTtsKey: async () => '',
    setDoubaoTtsKey: async () => {
      throw new Error('请在电脑上保存语音合成 Access Token');
    },
    getTtsVoices: async () => (await api('/api/voices')).json(),
    setTtsVoice: async (lang, voice) => {
      await api('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, voice }),
      });
    },
    translate: async (text) => {
      const res = await api('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      return String(data.text || '');
    },
    transcribe: async (pcm) => {
      const res = await api('/api/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm,
      });
      const data = await res.json();
      return String(data.text || '');
    },
    turn: async (pcm) => {
      const res = await api('/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm,
      });
      const data = await res.json();
      const binary = data.audio ? Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0)) : new Uint8Array();
      return {
        sourceText: String(data.sourceText || ''),
        translated: String(data.translated || ''),
        engine: data.engine || 'doubao-tts-2.0',
        sampleRate: Number(data.sampleRate || 16000),
        format: data.format || 'pcm16',
        samples: binary.buffer,
      };
    },
    warmup: () => status(),
    ttsReady: async () => Boolean((await status()).hasTts),
    ttsStatus: async () => (await status()).ttsStatus || '',
    tts: async (text, lang) => {
      const res = await api('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang }),
      });
      return {
        engine: res.headers.get('X-Tts-Engine') || 'doubao-tts-2.0',
        sampleRate: Number(res.headers.get('X-Sample-Rate') || 16000),
        format: res.headers.get('X-Format') || 'pcm16',
        samples: await res.arrayBuffer(),
      };
    },
    onTtsStatus: () => {},
    getPhoneShare: async () => null,
    onPhoneShare: () => {},
    relaunch: async () => {},
    quit: async () => {},
  };
}

export function createTalk() {
  const electronTalk = window.__ZH_EN_ELECTRON__ ? window.talk : null;
  if (electronTalk && typeof electronTalk.getApiKey === 'function') return electronTalk;
  return createHttpTalk();
}

export function isElectronApp() {
  return Boolean(window.__ZH_EN_ELECTRON__);
}
