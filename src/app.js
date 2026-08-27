import { createTalk, isElectronApp } from './talk-client.js';

const talk = createTalk();
const isPhone = !isElectronApp();
const talkBtn = document.getElementById('talk-btn');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const setupEl = document.getElementById('setup');
const keyInput = document.getElementById('api-key');
const saveKeyBtn = document.getElementById('save-key');
const micSelect = document.getElementById('mic');
const speakerSelect = document.getElementById('speaker');
const cloneSpeakerInput = document.getElementById('clone-speaker');
const saveCloneBtn = document.getElementById('save-clone');
const zhVoiceSelect = document.getElementById('zh-voice');
const enVoiceSelect = document.getElementById('en-voice');
const meterBar = document.getElementById('meter-bar');
const phoneShareEl = document.getElementById('phone-share');
const phoneUrlEl = document.getElementById('phone-url');
const phoneQrEl = document.getElementById('phone-qr');
const copyPhoneUrlBtn = document.getElementById('copy-phone-url');
const subtitleEl = document.getElementById('subtitle');
const restartAppBtn = document.getElementById('restart-app');
const quitAppBtn = document.getElementById('quit-app');

if (isPhone) {
  document.body.classList.add('is-phone');
  subtitleEl.textContent = '插上耳机后点开始。说中文读英文，说英文读中文。请保持这个页面打开。';
}

let listening = false;
let speaking = false;
let processing = false;
let audioContext = null;
let mediaStream = null;
let processor = null;
let sourceNode = null;
let gainNode = null;
let speechChunks = [];
let speakingNow = false;
let silenceMs = 0;
let lastProcessAt = 0;
let lastSpokenText = '';
let pendingQueue = [];
let bargeInMs = 0;
let speakGeneration = 0;
let speakInterrupted = false;
let silentMs = 0;
let peakLevel = 0;
let playbackContext = null;
let currentSource = null;

const SAMPLE_RATE = 16000;
const SILENCE_MS = isPhone ? 600 : 1400;
const MIN_SPEECH_MS = 280;
const MAX_SPEECH_S = 12;
const SPEECH_LEVEL = 0.0018;
const BARGE_IN_LEVEL = 0.02;
const BARGE_IN_MS = 220;
const ECHO_PAUSE_MS = isPhone ? 120 : 280;
const MIC_KEY = 'zh-en-mic';
const SPEAKER_KEY = 'zh-en-speaker';
const HEADSET_RE = /headset|headphone|earphone|earbud|airpods|buds|蓝牙|耳機|耳机|usb|dongle/i;
const AVOID_RE = /stereo mix|立体声混音|virtual|cable|loopback|what u hear/i;

function setStatus(text) {
  statusEl.textContent = text;
}

function setMeter(level) {
  const pct = Math.min(100, Math.round(level * 2800));
  meterBar.style.width = `${pct}%`;
}

function deviceScore(device) {
  const name = device.label || '';
  if (AVOID_RE.test(name)) return -20;
  if (/hands-free|handsfree|communications|通讯/i.test(name)) return -8;
  if (HEADSET_RE.test(name)) return 20;
  if (/bluetooth|bth/i.test(name)) return 8;
  return 0;
}

function pickPreferred(devices, savedId) {
  const saved = devices.find((d) => d.deviceId === savedId);
  if (saved && deviceScore(saved) >= 0) return savedId;
  const ranked = [...devices].sort((a, b) => deviceScore(b) - deviceScore(a));
  return ranked[0]?.deviceId || '';
}

function fillSelect(select, devices, selectedId) {
  select.innerHTML = '';
  if (!devices.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '未检测到设备';
    select.appendChild(opt);
    return;
  }
  for (const device of devices) {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent = device.label || '未命名设备';
    select.appendChild(opt);
  }
  select.value = selectedId && devices.some((d) => d.deviceId === selectedId)
    ? selectedId
    : devices[0].deviceId;
}

async function refreshDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((track) => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId);
  const currentMicLabel = micSelect.selectedOptions[0]?.textContent || '';
  let micId = pickPreferred(inputs, localStorage.getItem(MIC_KEY));
  if (deviceScore({ label: currentMicLabel }) < 20) {
    const headset = inputs.find((d) => deviceScore(d) >= 20);
    if (headset) micId = headset.deviceId;
  }
  fillSelect(micSelect, inputs, micId);
  fillSelect(speakerSelect, outputs, pickPreferred(outputs, localStorage.getItem(SPEAKER_KEY)));
  if (micSelect.value) localStorage.setItem(MIC_KEY, micSelect.value);
  if (speakerSelect.value) localStorage.setItem(SPEAKER_KEY, speakerSelect.value);
}

async function applySpeaker() {
  const sinkId = speakerSelect.value;
  const contexts = [audioContext, playbackContext].filter(Boolean);
  for (const ctx of contexts) {
    if (!sinkId || !ctx.setSinkId) continue;
    try {
      await ctx.setSinkId(sinkId);
    } catch {
      // 部分设备不支持单独指定输出
    }
  }
}

function currentMicName() {
  return micSelect.selectedOptions[0]?.textContent || '麦克风';
}

function listeningHint() {
  if (isPhone) return '请对着耳机说话。说完稍停就翻译。';
  return `请说话（${currentMicName()} · 豆包）。说完稍停就翻译。`;
}

function friendlyError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/声音复刻/.test(msg)) return msg;
  if (/403|没有权限/i.test(msg)) {
    return '豆包语音没有权限。请在控制台开通「豆包流式语音识别模型 2.0」，并把这个 API Key 授权给该服务。';
  }
  if (/401|鉴权失败/i.test(msg)) {
    return '豆包语音鉴权失败。请使用豆包语音控制台的 API Key，不要用方舟 ark- Key。';
  }
  if (/没有豆包|缺少豆包/i.test(msg)) {
    return '没有豆包语音 Key。请到豆包语音控制台创建 API Key，不要用方舟 ark- Key。';
  }
  if (/Failed to fetch|NetworkError|Load failed|ECONN|ENOTFOUND|Unexpected server response/i.test(msg)) {
    return '豆包语音连接失败，请检查网络后点开始重试';
  }
  if (/NotAllowed|Permission/i.test(msg)) return '请允许使用麦克风';
  if (/NotFound/i.test(msg)) return '没有找到麦克风';
  return msg;
}

function addBubble(role, title, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.innerHTML = `<span class="meta">${title}</span>${escapeHtml(text)}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function looksChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function similarText(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.includes(x)) return true;
  if (y.length >= 4 && x.includes(y)) return true;
  return false;
}

function isJunkTranscript(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^[\s\p{P}\p{S}]+$/u.test(t)) return true;
  if (/^(\[.*\]|\(.*\)|♪+)$/.test(t)) return true;
  if (/^(thank you( for watching)?|thanks( for watching| for listening)?|thanks|thank you|bye( bye)?|bye-bye|you|okay|ok|hmm+|uh+|ah+|the end|subtitle(s)?|music|applause|silence|blank audio|字幕(by.*)?|谢谢(大家|观看|收看)?|請?(不吝)?訂閱|再见)[\s.。!！]*$/i.test(t)) {
    return true;
  }
  const compact = t.replace(/[\s\p{P}]+/gu, '');
  if (!compact) return true;
  if (!looksChinese(t) && compact.length < 2) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pcm16ToFloat32(buffer) {
  const view = new Int16Array(buffer);
  const samples = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) samples[i] = view[i] / 32768;
  return samples;
}

function decodeTtsSamples(raw, format) {
  if (format === 'pcm16') return pcm16ToFloat32(raw);
  if (raw instanceof Float32Array) return raw;
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return new Float32Array(raw);
  return new Float32Array(raw || []);
}

async function transcribeSpeech(samples) {
  const doubaoKey = await talk.getDoubaoKey();
  if (!doubaoKey) throw new Error('没有豆包语音 Key');
  return String((await talk.transcribe(floatToPcm16(samples))) || '').trim();
}

function floatToPcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

function resampleTo16k(input, fromRate) {
  if (!fromRate || Math.abs(fromRate - SAMPLE_RATE) < 1) return input;
  const outLength = Math.max(1, Math.round(input.length * (SAMPLE_RATE / fromRate)));
  const out = new Float32Array(outLength);
  const ratio = (input.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function concatFloat32(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function waitForVoices() {
  const voices = speechSynthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 800);
  });
}

async function ensurePlaybackContext() {
  if (!playbackContext || playbackContext.state === 'closed') {
    playbackContext = new AudioContext();
  }
  if (playbackContext.state === 'suspended') await playbackContext.resume();
  await applySpeaker();
  return playbackContext;
}

function pickVoice(lang) {
  const prefix = lang.slice(0, 2).toLowerCase();
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(prefix));
  const prefer = prefix === 'zh'
    ? /ting|meijia|sinji|sin-ji|yushu|limu|huihui|xiaoxiao|xiaoyi|yunxi|yunyang|yaoyao|kangkang|tingting/i
    : /samantha|nicky|aaron|aria|jenny|guy|zira|david|mark|steffan/i;
  return voices.find((v) => prefer.test(v.name)) || voices.find((v) => v.localService) || voices[0] || null;
}

function speakWindows(text, lang, generation) {
  return new Promise((resolve) => {
    if (generation !== speakGeneration) {
      resolve('interrupted');
      return;
    }
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang;
    const voice = pickVoice(lang);
    if (voice) utter.voice = voice;
    utter.rate = 1.08;
    const finish = (reason) => {
      if (generation !== speakGeneration) resolve('interrupted');
      else resolve(reason);
    };
    utter.onend = () => finish('end');
    utter.onerror = () => finish('error');
    speechSynthesis.speak(utter);
  });
}

async function playPcm(samples, sampleRate, generation) {
  const ctx = await ensurePlaybackContext();
  if (generation !== speakGeneration) return 'interrupted';
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  return new Promise((resolve) => {
    if (generation !== speakGeneration) {
      resolve('interrupted');
      return;
    }
    const source = ctx.createBufferSource();
    currentSource = source;
    source.buffer = buffer;
    source.connect(ctx.destination);
    const finish = (reason) => {
      if (currentSource === source) currentSource = null;
      if (generation !== speakGeneration) resolve('interrupted');
      else resolve(reason);
    };
    source.onended = () => finish('end');
    try {
      source.start();
    } catch {
      finish('error');
    }
  });
}

async function speak(text, lang) {
  const generation = ++speakGeneration;
  speakInterrupted = false;
  try {
    if (await talk.ttsReady()) {
      const result = await talk.tts(text, lang);
      if (generation !== speakGeneration) return 'interrupted';
      const samples = decodeTtsSamples(result?.samples, result?.format);
      if (!samples.length) throw new Error('empty');
      if (result?.engine && !String(result.engine).includes('doubao')) {
        setStatus('声音合成 2.0 还没开通，当前不是豆包朗读');
      }
      return await playPcm(samples, result.sampleRate || 24000, generation);
    }
  } catch {
    if (generation !== speakGeneration) return 'interrupted';
  }
  await waitForVoices();
  return speakWindows(text, lang, generation);
}

function interruptSpeech() {
  speakInterrupted = true;
  speakGeneration += 1;
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // already stopped
    }
    currentSource = null;
  }
  speechSynthesis.cancel();
}

async function processUtterance(samples) {
  if (samples.length < SAMPLE_RATE * (MIN_SPEECH_MS / 1000)) return;
  if (processing) return;
  processing = true;
  speakingNow = false;
  try {
    let sourceText = '';
    let translated = '';
    let readyAudio = null;

    if (isPhone && typeof talk.turn === 'function') {
      setStatus('识别翻译中…');
      const result = await talk.turn(floatToPcm16(samples));
      if (!listening) return;
      sourceText = String(result?.sourceText || '').trim();
      translated = String(result?.translated || '').trim();
      const audio = decodeTtsSamples(result?.samples, result?.format || 'pcm16');
      if (audio.length) {
        readyAudio = { samples: audio, sampleRate: result.sampleRate || SAMPLE_RATE };
      }
    } else {
      setStatus('豆包识别中…');
      sourceText = await transcribeSpeech(samples);
    }

    if (!listening) return;
    if (!sourceText || isJunkTranscript(sourceText)) {
      setStatus(sourceText ? listeningHint() : '没听清，请再说一次');
      return;
    }
    if (similarText(sourceText, lastSpokenText)) {
      setStatus(listeningHint());
      return;
    }

    addBubble('user', looksChinese(sourceText) ? '我 · 中文' : '我 · English', sourceText);
    if (!translated) {
      setStatus('DeepSeek 翻译中…');
      translated = await talk.translate(sourceText);
    }
    if (!listening) return;
    if (!translated || similarText(translated, sourceText)) {
      setStatus(listeningHint());
      return;
    }
    const sourceIsZh = looksChinese(sourceText);
    const outIsZh = looksChinese(translated);
    if (sourceIsZh === outIsZh) {
      setStatus(listeningHint());
      return;
    }

    lastSpokenText = translated;
    const outLang = outIsZh ? 'zh-CN' : 'en-US';
    addBubble('bot', outIsZh ? '译文 · 中文' : '译文 · English', translated);

    speaking = true;
    bargeInMs = 0;
    setStatus('正在朗读…再说就可以打断');
    let speakResult;
    if (readyAudio) {
      const generation = ++speakGeneration;
      speakInterrupted = false;
      await ensurePlaybackContext();
      speakResult = await playPcm(readyAudio.samples, readyAudio.sampleRate, generation);
    } else {
      speakResult = await speak(translated, outLang);
    }
    speaking = false;
    if (!listening) return;
    if (speakResult === 'interrupted' || speakInterrupted) {
      speakingNow = true;
      silenceMs = 0;
      setStatus('正在听…');
      return;
    }
    speechChunks = [];
    speakingNow = false;
    await sleep(ECHO_PAUSE_MS);
  } finally {
    speaking = false;
    processing = false;
    if (listening && pendingQueue.length) {
      const next = pendingQueue.shift();
      processUtterance(next).catch((err) => setStatus(friendlyError(err)));
    } else if (listening && !speakingNow) {
      setStatus(listeningHint());
    }
  }
}

function flushSpeech() {
  if (!speechChunks.length) return;
  const samples = concatFloat32(speechChunks);
  speechChunks = [];
  speakingNow = false;
  silenceMs = 0;
  const now = Date.now();
  if (now - lastProcessAt < 250) return;
  lastProcessAt = now;
  if (processing) {
    pendingQueue.push(samples);
    if (pendingQueue.length > 2) pendingQueue.shift();
    return;
  }
  processUtterance(samples).catch((err) => {
    setStatus(friendlyError(err));
  });
}

function onAudioFrame(frame, inputRate) {
  if (!listening) {
    setMeter(0);
    return;
  }
  const pcm = resampleTo16k(frame, inputRate);
  const level = rms(pcm);
  setMeter(level);
  peakLevel = Math.max(peakLevel, level);
  const frameMs = (pcm.length / SAMPLE_RATE) * 1000;

  if (speaking) {
    if (level > BARGE_IN_LEVEL) {
      bargeInMs += frameMs;
      if (bargeInMs >= BARGE_IN_MS) {
        interruptSpeech();
        speaking = false;
        speakingNow = true;
        silenceMs = 0;
        speechChunks = [pcm];
        bargeInMs = 0;
        setStatus('正在听…');
      }
    } else {
      bargeInMs = 0;
    }
    return;
  }

  if (level > SPEECH_LEVEL) {
    speakingNow = true;
    silenceMs = 0;
    silentMs = 0;
    speechChunks.push(pcm);
    if (!processing) setStatus('正在听…');
  } else if (speakingNow) {
    silenceMs += frameMs;
    speechChunks.push(pcm);
    if (silenceMs >= SILENCE_MS) flushSpeech();
  } else if (!processing && peakLevel < 0.0008) {
    silentMs += frameMs;
    if (silentMs > 2500) {
      silentMs = 0;
      setStatus('麦克风几乎没声音，请换上面的麦克风后再说');
    }
  }

  const used = speechChunks.reduce((n, c) => n + c.length, 0);
  if (used > SAMPLE_RATE * MAX_SPEECH_S) flushSpeech();
}

let wakeLock = null;

async function keepScreenOn() {
  if (!navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // iOS 旧版本或不允许时忽略
  }
}

async function startListening() {
  const doubaoKey = await talk.getDoubaoKey();
  if (!doubaoKey) {
    setStatus(isPhone
      ? '电脑还没保存豆包语音 Key，请先在电脑上配好再打开这个页面。'
      : '没有豆包语音 Key。方舟 ark- Key 不能用于识别，请到豆包语音控制台创建 API Key。');
    return;
  }
  setStatus('正在打开麦克风…');
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: SAMPLE_RATE,
  };
  try {
    if (!isPhone && micSelect.value) audio.deviceId = { exact: micSelect.value };
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch {
    delete audio.deviceId;
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio });
  }
  await keepScreenOn();
  if (isPhone) {
    await ensurePlaybackContext();
    if (typeof talk.warmup === 'function') talk.warmup().catch(() => {});
  }
  audioContext = new AudioContext();
  await audioContext.resume();
  await applySpeaker();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  gainNode = audioContext.createGain();
  gainNode.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    onAudioFrame(new Float32Array(input), audioContext.sampleRate);
  };
  sourceNode.connect(processor);
  processor.connect(gainNode);
  gainNode.connect(audioContext.destination);
  listening = true;
  silentMs = 0;
  peakLevel = 0;
  talkBtn.textContent = '停止';
  talkBtn.classList.add('listening');
  setStatus(listeningHint());
}

function stopListening() {
  listening = false;
  speakingNow = false;
  processing = false;
  pendingQueue = [];
  bargeInMs = 0;
  interruptSpeech();
  speechChunks = [];
  processor?.disconnect();
  sourceNode?.disconnect();
  gainNode?.disconnect();
  mediaStream?.getTracks().forEach((t) => t.stop());
  audioContext?.close();
  processor = null;
  sourceNode = null;
  gainNode = null;
  mediaStream = null;
  audioContext = null;
  speechSynthesis.cancel();
  talkBtn.textContent = '开始说话';
  talkBtn.classList.remove('listening');
  setMeter(0);
  setStatus('已停止');
}

async function refreshKeyState() {
  const key = await talk.getApiKey();
  if (key) {
    keyInput.value = key;
    setupEl.classList.add('hidden');
    talkBtn.disabled = false;
    setStatus('点开始说话');
  } else {
    setupEl.classList.remove('hidden');
    talkBtn.disabled = true;
    setStatus('请先填写 DeepSeek API Key');
  }
}

function fillVoiceSelect(select, voices, selected) {
  select.innerHTML = '';
  for (const voice of voices || []) {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.name;
    select.appendChild(option);
  }
  if (selected) select.value = selected;
}

async function loadTtsVoices() {
  const data = await talk.getTtsVoices();
  fillVoiceSelect(zhVoiceSelect, data.zh, data.selected?.zh);
  fillVoiceSelect(enVoiceSelect, data.en, data.selected?.en);
}

async function saveCloneKey() {
  const value = cloneSpeakerInput.value.trim();
  if (!value) {
    setStatus('语音合成 Key 不能为空');
    return;
  }
  await talk.setDoubaoTtsKey(value);
  const status = await talk.ttsStatus();
  setStatus(status || '复刻 Key 已保存');
}

cloneSpeakerInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveCloneKey().catch((err) => setStatus(friendlyError(err)));
  }
});

saveCloneBtn.addEventListener('click', () => {
  saveCloneKey().catch((err) => setStatus(friendlyError(err)));
});

zhVoiceSelect.addEventListener('change', async () => {
  await talk.setTtsVoice('zh', zhVoiceSelect.value);
  setStatus(`中文音色：${zhVoiceSelect.selectedOptions[0]?.textContent || zhVoiceSelect.value}`);
});

enVoiceSelect.addEventListener('change', async () => {
  await talk.setTtsVoice('en', enVoiceSelect.value);
  setStatus(`英文音色：${enVoiceSelect.selectedOptions[0]?.textContent || enVoiceSelect.value}`);
});

saveKeyBtn.addEventListener('click', async () => {
  const value = keyInput.value.trim();
  if (!value) {
    setStatus('API Key 不能为空');
    return;
  }
  await talk.setApiKey(value);
  await refreshKeyState();
});

micSelect.addEventListener('change', async () => {
  localStorage.setItem(MIC_KEY, micSelect.value);
  if (!listening) return;
  stopListening();
  try {
    await startListening();
  } catch (err) {
    setStatus(friendlyError(err));
  }
});

speakerSelect.addEventListener('change', async () => {
  localStorage.setItem(SPEAKER_KEY, speakerSelect.value);
  await ensurePlaybackContext();
  await applySpeaker();
});

navigator.mediaDevices.addEventListener('devicechange', () => {
  refreshDevices().catch(() => {});
});

talkBtn.addEventListener('click', async () => {
  if (listening) {
    stopListening();
    return;
  }
  talkBtn.disabled = true;
  try {
    ensurePlaybackContext().catch(() => {});
    if (!isPhone) await refreshDevices();
    await startListening();
  } catch (err) {
    setStatus(friendlyError(err));
  } finally {
    talkBtn.disabled = false;
  }
});

function bindAppActions() {
  if (isPhone) return;
  restartAppBtn?.addEventListener('click', () => {
    setStatus('正在重启…');
    talk.relaunch().catch((err) => setStatus(friendlyError(err)));
  });
  quitAppBtn?.addEventListener('click', () => {
    talk.quit().catch((err) => setStatus(friendlyError(err)));
  });
}

function bindPhoneShare() {
  if (isPhone || !talk.getPhoneShare) return;
  phoneShareEl.classList.remove('hidden');
  const apply = (info) => {
    if (!info) return;
    if (info.url) {
      phoneUrlEl.textContent = info.url;
      phoneQrEl.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(info.url)}`;
      phoneQrEl.hidden = false;
    } else {
      phoneUrlEl.textContent = info.message || '正在开通外网地址…';
      phoneQrEl.removeAttribute('src');
      phoneQrEl.hidden = true;
    }
  };
  talk.onPhoneShare(apply);
  talk.getPhoneShare().then(apply).catch(() => {});
  copyPhoneUrlBtn.addEventListener('click', async () => {
    const url = phoneUrlEl.textContent.trim();
    if (!/^https?:/i.test(url)) {
      setStatus('外网地址还没好');
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setStatus('链接已复制，发给 iPhone 用 Safari 打开');
    } catch {
      setStatus('复制失败，请长按上面的链接手动复制');
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listening) keepScreenOn();
  if (isPhone && listening && document.visibilityState === 'hidden') {
    setStatus('页面被切走会暂停，请回到 Safari 这个标签');
  }
});

refreshKeyState()
  .then(() => (isPhone ? Promise.resolve() : refreshDevices()))
  .then(() => ensurePlaybackContext())
  .then(async () => {
    bindAppActions();
    bindPhoneShare();
    if (!isPhone) {
      const cloneKey = await talk.getDoubaoTtsKey();
      if (cloneKey && !cloneKey.startsWith('ark-')) cloneSpeakerInput.value = cloneKey;
    }
    await loadTtsVoices();
    talk.onTtsStatus((text) => {
      if (!listening || processing || speaking) setStatus(text);
    });
    const status = await talk.ttsStatus();
    if (status && !listening && !processing) setStatus(status);
    if (isPhone && !(await talk.getApiKey())) {
      setStatus('电脑还没保存 DeepSeek Key，请先在电脑上配好。');
      talkBtn.disabled = true;
    }
  })
  .catch((err) => {
    setStatus(friendlyError(err));
  });
