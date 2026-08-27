const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { transcribePcm16 } = require('./doubao-asr.cjs');
const { synthesizeDoubao, looksLikeUuid, looksLikeVoiceId, ZH_VOICE, EN_VOICE, ZH_VOICES, EN_VOICES } = require('./doubao-tts.cjs');
const { startPhoneServer } = require('./phone-server.cjs');
const { ensureCloudflared, startCloudflareTunnel } = require('./cloudflare-tunnel.cjs');
let doubaoTtsBlocked = '';
let phoneShare = { message: '正在开通外网地址…若两分钟还没有二维码，请把代理里的 cloudflared.exe 设为直连后重启。' };
let phoneTunnel = null;
let phoneServer = null;

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadDotEnv();

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

function getApiKey() {
  const cfg = readConfig();
  const apiKey = String(cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (apiKey.startsWith('ark-')) return String(process.env.DEEPSEEK_API_KEY || '').trim();
  return apiKey;
}

function getDoubaoKey() {
  const cfg = readConfig();
  const doubao = String(cfg.doubaoKey || process.env.DOUBAO_ASR_KEY || '').trim();
  if (doubao) return doubao;
  const apiKey = String(cfg.apiKey || '').trim();
  return apiKey.startsWith('ark-') ? apiKey : '';
}

function getDoubaoTtsKey() {
  const cfg = readConfig();
  return String(cfg.doubaoTtsKey || process.env.DOUBAO_TTS_KEY || '').trim();
}

function getDoubaoAppId() {
  const cfg = readConfig();
  return String(cfg.doubaoAppId || process.env.DOUBAO_APP_ID || '').trim();
}

function getDoubaoSpeaker() {
  const cfg = readConfig();
  return String(cfg.doubaoSpeaker || process.env.DOUBAO_SPEAKER || '').trim();
}

function getTtsVoices() {
  const cfg = readConfig();
  const zh = String(cfg.doubaoZhVoice || '').trim();
  const en = String(cfg.doubaoEnVoice || '').trim();
  return {
    zh: looksLikeVoiceId(zh) ? zh : ZH_VOICE,
    en: looksLikeVoiceId(en) ? en : EN_VOICE,
  };
}

function getDoubaoTtsAuth() {
  const ttsKey = getDoubaoTtsKey();
  const asrKey = getDoubaoKey();
  const usableTts = ttsKey && !/^ark-/i.test(ttsKey) ? ttsKey : '';
  const uuidKey = looksLikeUuid(usableTts) ? usableTts : asrKey;
  const accessKey = usableTts && !looksLikeUuid(usableTts) && !looksLikeVoiceId(usableTts) ? usableTts : '';
  return {
    apiKey: uuidKey,
    accessKey,
    appId: getDoubaoAppId(),
  };
}

function hasDoubaoTtsAuth() {
  const auth = getDoubaoTtsAuth();
  return Boolean(auth.apiKey || auth.accessKey);
}

function packTtsResult(result, engine) {
  const samples = result.samples instanceof Float32Array
    ? result.samples
    : new Float32Array(result.samples || []);
  return {
    engine: engine || result.engine || 'doubao-tts-2.0',
    sampleRate: result.sampleRate || 24000,
    samples: samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
  };
}

function emitTtsStatus(text) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tts:status', text);
  }
}

function emitPhoneInfo() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('phone:info', phoneShare);
  }
}

async function startPhoneAccess() {
  const token = crypto.randomBytes(9).toString('base64url');
  phoneShare = { message: '正在开通外网地址…若两分钟还没有二维码，请把代理里的 cloudflared.exe 设为直连后重启。' };
  emitPhoneInfo();
  try {
    phoneServer = null;
    let lastErr = null;
    for (const port of [8787, 8788, 8789]) {
      try {
        phoneServer = await startPhoneServer({
          host: '127.0.0.1',
          port,
          staticDir: path.join(__dirname, '../src'),
          token,
          handlers: {
            status: async () => ({
              hasDeepSeek: Boolean(getApiKey()),
              hasAsr: Boolean(getDoubaoKey()),
              hasTts: hasDoubaoTtsAuth(),
              ttsStatus: currentTtsStatus(),
            }),
            voices: async () => ({
              selected: getTtsVoices(),
              zh: ZH_VOICES,
              en: EN_VOICES,
            }),
            translate: async (text) => translateWithDeepSeek(text),
            transcribe: async (pcm) => {
              const key = getDoubaoKey();
              if (!key) throw new Error('请先填写豆包语音 API Key');
              return transcribePcm16(Buffer.from(pcm), key);
            },
            tts: async (text, lang) => {
              if (!hasDoubaoTtsAuth()) throw new Error('请先保存豆包语音合成 2.0 Access Token');
              const result = await synthesizeDoubao(text, getDoubaoTtsAuth(), getTtsVoices(), lang);
              doubaoTtsBlocked = '';
              return packTtsResult(result, 'doubao-tts-2.0');
            },
            turn: async (pcm) => {
              const key = getDoubaoKey();
              if (!key) throw new Error('请先填写豆包语音 API Key');
              const sourceText = String(await transcribePcm16(Buffer.from(pcm), key) || '').trim();
              if (!sourceText) {
                return { sourceText: '', translated: '', sampleRate: 16000, samples: new Float32Array(), engine: 'doubao-tts-2.0' };
              }
              const translated = await translateWithDeepSeek(sourceText);
              if (!translated || !hasDoubaoTtsAuth()) {
                return { sourceText, translated: translated || '', sampleRate: 16000, samples: new Float32Array(), engine: 'doubao-tts-2.0' };
              }
              const voiceLang = /[\u4e00-\u9fff]/.test(translated) ? 'zh' : 'en';
              try {
                const result = await synthesizeDoubao(translated, getDoubaoTtsAuth(), getTtsVoices(), voiceLang);
                doubaoTtsBlocked = '';
                return { sourceText, translated, ...packTtsResult(result, 'doubao-tts-2.0') };
              } catch {
                return { sourceText, translated, sampleRate: 16000, samples: new Float32Array(), engine: 'doubao-tts-2.0' };
              }
            },
            setVoice: async (lang, voice) => {
              const id = String(voice || '').trim();
              if (String(lang || '').startsWith('zh')) writeConfig({ doubaoZhVoice: id || ZH_VOICE });
              else writeConfig({ doubaoEnVoice: id || EN_VOICE });
            },
          },
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err && err.code !== 'EADDRINUSE') break;
      }
    }
    if (!phoneServer) throw lastErr || new Error('手机服务启动失败');
  } catch (err) {
    phoneShare = { message: `手机服务启动失败：${err instanceof Error ? err.message : String(err)}` };
    emitPhoneInfo();
    return;
  }

  phoneShare = { message: '正在下载/启动外网通道…若两分钟还没有二维码，请把代理里的 cloudflared.exe 设为直连后重启。' };
  emitPhoneInfo();
  try {
    const bin = await ensureCloudflared(app.getPath('userData'));
    const waitTimer = setTimeout(() => {
      if (!phoneShare.url) {
        phoneShare = { message: '外网通道超时。请检查网络后重启软件。' };
        emitPhoneInfo();
      }
    }, 120000);
    phoneTunnel = startCloudflareTunnel(bin, phoneServer.origin, (event) => {
      if (event.type === 'url') {
        clearTimeout(waitTimer);
        phoneShare = { url: `${event.url}/t/${token}` };
        console.log('[phone] 手机地址已就绪');
      } else {
        phoneShare = { message: event.message || '外网通道失败' };
      }
      emitPhoneInfo();
    });
  } catch (err) {
    phoneShare = { message: `外网通道失败：${err instanceof Error ? err.message : String(err)}。电脑需能访问 GitHub。` };
    emitPhoneInfo();
  }
}

async function stopPhoneAccess() {
  try { phoneTunnel?.stop(); } catch { /* ignore */ }
  phoneTunnel = null;
  const closer = phoneServer?.close;
  phoneServer = null;
  if (closer) await closer();
}

function currentTtsStatus() {
  if (doubaoTtsBlocked) return doubaoTtsBlocked;
  if (hasDoubaoTtsAuth()) return '豆包语音合成模型 2.0 已接入';
  return '未配置豆包语音合成，将使用系统朗读';
}

const SYSTEM_PROMPT = `你是中英口语同传，像面对面说话那样翻译。
规则：
- 中文译成自然英文口语，英文译成自然中文口语
- 问句保持问句，语气跟着原文（轻松就轻松，着急就短）
- 能用口语就用口语，不要书面腔
- 只输出译文本身，不要解释、拼音、引号、括号、语言标签
- 不要补充原文没有的意思`;

async function translateWithDeepSeek(text) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('请先填写 DeepSeek API Key');

  const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek 请求失败（${response.status}）：${raw.slice(0, 240)}`);
  }
  const data = JSON.parse(raw);
  const content = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!content) throw new Error('DeepSeek 没有返回译文');
  return content.replace(/^["「『]|["」』]$/g, '').trim();
}

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

function createWindow() {
  const win = new BrowserWindow({
    width: 420,
    height: 860,
    minWidth: 360,
    minHeight: 640,
    backgroundColor: '#111111',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const session = win.webContents.session;
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(['media', 'microphone', 'audioCapture', 'speaker-selection'].includes(permission));
  });
  session.setPermissionCheckHandler((_contents, permission) => {
    return ['media', 'microphone', 'audioCapture', 'speaker-selection'].includes(permission);
  });
  session.setDevicePermissionHandler((details) => {
    return details.deviceType === 'audio' || details.mediaType === 'audio';
  });

  const devUrl = 'http://127.0.0.1:5174';
  const tryLoad = async (attempt = 0) => {
    try {
      await win.loadURL(devUrl);
    } catch {
      if (attempt < 40) {
        setTimeout(() => tryLoad(attempt + 1), 250);
      } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'));
      }
    }
  };
  tryLoad();
  win.webContents.on('did-finish-load', () => {
    const text = currentTtsStatus();
    if (text) win.webContents.send('tts:status', text);
    win.webContents.send('phone:info', phoneShare);
  });
}

app.whenReady().then(() => {
  ipcMain.handle('config:get-key', () => getApiKey());
  ipcMain.handle('config:set-key', (_event, apiKey) => {
    writeConfig({ apiKey: String(apiKey || '').trim() });
    return true;
  });
  ipcMain.handle('config:get-doubao', () => getDoubaoKey());
  ipcMain.handle('config:set-doubao', (_event, apiKey) => {
    doubaoTtsBlocked = '';
    writeConfig({ doubaoKey: String(apiKey || '').trim() });
    return true;
  });
  ipcMain.handle('config:get-speaker', () => getDoubaoSpeaker());
  ipcMain.handle('config:set-speaker', (_event, speaker) => {
    doubaoTtsBlocked = '';
    writeConfig({ doubaoSpeaker: String(speaker || '').trim() || '小狗' });
    emitTtsStatus(currentTtsStatus());
    return true;
  });
  ipcMain.handle('config:get-tts-key', () => getDoubaoTtsKey());
  ipcMain.handle('config:get-tts-voices', () => ({
    selected: getTtsVoices(),
    zh: ZH_VOICES,
    en: EN_VOICES,
  }));
  ipcMain.handle('config:set-tts-voice', (_event, lang, voice) => {
    doubaoTtsBlocked = '';
    const id = String(voice || '').trim();
    if (String(lang || '').startsWith('zh')) writeConfig({ doubaoZhVoice: id || ZH_VOICE });
    else writeConfig({ doubaoEnVoice: id || EN_VOICE });
    emitTtsStatus(currentTtsStatus());
    return true;
  });
  ipcMain.handle('config:set-tts-key', (_event, apiKey) => {
    doubaoTtsBlocked = '';
    const value = String(apiKey || '').trim();
    if (looksLikeVoiceId(value)) {
      writeConfig({ doubaoSpeaker: value });
    } else {
      writeConfig({ doubaoTtsKey: value });
    }
    emitTtsStatus(currentTtsStatus());
    return true;
  });
  ipcMain.handle('translate', async (_event, text) => translateWithDeepSeek(String(text || '').trim()));
  ipcMain.handle('asr:transcribe', async (_event, pcm) => {
    const key = getDoubaoKey();
    if (!key) throw new Error('请先填写豆包语音 API Key');
    const buffer = Buffer.from(pcm);
    return transcribePcm16(buffer, key);
  });
  ipcMain.handle('tts:ready', () => hasDoubaoTtsAuth());
  ipcMain.handle('tts:status', () => currentTtsStatus());
  ipcMain.handle('tts:generate', async (_event, text, lang) => {
    const input = String(text || '');
    const voiceLang = String(lang || 'en');
    if (!hasDoubaoTtsAuth()) throw new Error('请先保存豆包语音合成 2.0 Access Token');
    try {
      const result = await synthesizeDoubao(input, getDoubaoTtsAuth(), getTtsVoices(), voiceLang);
      doubaoTtsBlocked = '';
      emitTtsStatus(`豆包语音合成 2.0 朗读中（${result.speaker}）`);
      return packTtsResult(result, 'doubao-tts-2.0');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[doubao-tts]', message);
      doubaoTtsBlocked = message;
      emitTtsStatus(message);
      throw err;
    }
  });
  ipcMain.handle('phone:info', () => phoneShare);
  ipcMain.handle('app:relaunch', async () => {
    await stopPhoneAccess();
    for (const win of BrowserWindow.getAllWindows()) win.reload();
    startPhoneAccess();
    return true;
  });
  ipcMain.handle('app:quit', () => {
    app.quit();
    return true;
  });

  createWindow();
  startPhoneAccess();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopPhoneAccess();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopPhoneAccess();
});
