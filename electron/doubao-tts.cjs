const { randomUUID } = require('crypto');

const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const RESOURCE_ID = 'seed-tts-2.0';
const SAMPLE_RATE = 24000;
const ZH_VOICE = 'zh_female_vv_uranus_bigtts';
const EN_VOICE = 'en_male_tim_uranus_bigtts';

const ZH_VOICES = [
  { id: 'zh_female_vv_uranus_bigtts', name: 'vivi 2.0' },
  { id: 'zh_female_xiaohe_uranus_bigtts', name: '小何 2.0' },
  { id: 'zh_male_m191_uranus_bigtts', name: '云舟 2.0' },
  { id: 'zh_male_taocheng_uranus_bigtts', name: '小夫 2.0' },
  { id: 'zh_male_liufei_uranus_bigtts', name: '刘飞 2.0' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声 2.0' },
  { id: 'zh_female_cancan_uranus_bigtts', name: '知性灿灿 2.0' },
  { id: 'zh_female_sajiaoxuemei_uranus_bigtts', name: '撒娇学妹 2.0' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', name: '甜美小源 2.0' },
  { id: 'zh_female_tianmeitaozi_uranus_bigtts', name: '甜美桃子 2.0' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', name: '爽快思思 2.0' },
  { id: 'zh_female_peiqi_uranus_bigtts', name: '佩奇猪 2.0' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', name: '邻家女孩 2.0' },
  { id: 'zh_male_shaonianzixin_uranus_bigtts', name: '少年梓辛 2.0' },
  { id: 'zh_male_sunwukong_uranus_bigtts', name: '猴哥 2.0' },
  { id: 'zh_female_yingyujiaoxue_uranus_bigtts', name: 'Tina老师 2.0' },
  { id: 'zh_female_kefunvsheng_uranus_bigtts', name: '暖阳女声 2.0' },
  { id: 'zh_female_xiaoxue_uranus_bigtts', name: '儿童绘本 2.0' },
  { id: 'zh_male_dayi_uranus_bigtts', name: '大壹 2.0' },
  { id: 'zh_female_mizai_uranus_bigtts', name: '黑猫侦探社咪仔 2.0' },
  { id: 'zh_female_jitangnv_uranus_bigtts', name: '鸡汤女 2.0' },
  { id: 'zh_female_meilinvyou_uranus_bigtts', name: '魅力女友 2.0' },
  { id: 'zh_female_liuchangnv_uranus_bigtts', name: '流畅女声 2.0' },
  { id: 'zh_male_ruyayichen_uranus_bigtts', name: '儒雅逸辰 2.0' },
  { id: 'zh_female_wenroumama_uranus_bigtts', name: '温柔妈妈 2.0' },
  { id: 'zh_male_jieshuoxiaoming_uranus_bigtts', name: '解说小明 2.0' },
  { id: 'zh_female_tvbnv_uranus_bigtts', name: 'TVB女声 2.0' },
  { id: 'zh_male_yizhipiannan_uranus_bigtts', name: '译制片男 2.0' },
  { id: 'zh_female_qiaopinv_uranus_bigtts', name: '俏皮女声 2.0' },
  { id: 'zh_female_zhishuaiyingzi_uranus_bigtts', name: '直率英子 2.0' },
  { id: 'zh_male_linjiananhai_uranus_bigtts', name: '邻家男孩 2.0' },
  { id: 'zh_male_silang_uranus_bigtts', name: '四郎 2.0' },
  { id: 'zh_male_ruyaqingnian_uranus_bigtts', name: '儒雅青年 2.0' },
  { id: 'zh_male_qingcang_uranus_bigtts', name: '擎苍 2.0' },
  { id: 'zh_male_xionger_uranus_bigtts', name: '熊二 2.0' },
  { id: 'zh_female_yingtaowanzi_uranus_bigtts', name: '樱桃丸子 2.0' },
  { id: 'zh_male_wennuanahu_uranus_bigtts', name: '温暖阿虎 2.0' },
  { id: 'zh_male_naiqimengwa_uranus_bigtts', name: '奶气萌娃 2.0' },
  { id: 'zh_female_pupu_uranus_bigtts', name: '噗噗 2.0' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', name: '高冷御姐 2.0' },
  { id: 'zh_male_aojiaobazong_uranus_bigtts', name: '傲娇霸总 2.0' },
  { id: 'zh_male_lanyinmianbao_uranus_bigtts', name: '懒音绵宝 2.0' },
  { id: 'zh_female_mengyatou_uranus_bigtts', name: '萌丫头 2.0' },
];

const EN_VOICES = [
  { id: 'en_male_tim_uranus_bigtts', name: 'Tim' },
  { id: 'en_female_dacey_uranus_bigtts', name: 'Dacey' },
  { id: 'en_female_stokie_uranus_bigtts', name: 'Stokie' },
  { id: 'zh_female_yingyujiaoxue_uranus_bigtts', name: 'Tina老师 2.0' },
];

function pcm16ToFloat32(buffer) {
  const view = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  const samples = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) samples[i] = view[i] / 32768;
  return samples;
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function looksLikeVoiceId(value) {
  return /(_uranus_|_bigtts|^zh_|^en_)/i.test(String(value || ''));
}

function pickSpeaker(lang, text, voices) {
  const chinese = String(lang || '').toLowerCase().startsWith('zh') || /[\u4e00-\u9fff]/.test(String(text || ''));
  const preferred = chinese ? voices?.zh : voices?.en;
  if (looksLikeVoiceId(preferred)) return preferred.trim();
  return chinese ? ZH_VOICE : EN_VOICE;
}

function parseNdjsonAudio(raw) {
  const chunks = [];
  const lines = String(raw || '').split(/\r?\n/);
  let lastError = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const header = parsed.header && typeof parsed.header === 'object' ? parsed.header : parsed;
    const code = header.code ?? parsed.code;
    if (code === 20000000) break;
    if (code && code !== 0) {
      lastError = friendlyTtsError(0, JSON.stringify(parsed));
      continue;
    }
    if (parsed.data) chunks.push(Buffer.from(parsed.data, 'base64'));
  }
  if (!chunks.length) throw new Error(lastError || '豆包语音合成没有返回音频');
  return Buffer.concat(chunks);
}

function friendlyTtsError(status, body) {
  const text = String(body || '');
  if (status === 401 || /Invalid X-Api-Key|grant not found/i.test(text)) {
    return '豆包语音合成鉴权失败。请填写语音控制台里「豆包语音合成模型 2.0」的 API Key。';
  }
  if (status === 403 || /45000030|not granted/i.test(text)) {
    return '豆包语音合成 2.0 没有权限。请在语音控制台开通「豆包语音合成模型 2.0」，并把 API Key 授权给该服务。';
  }
  const msg = text.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
  return `豆包语音合成失败（${status}）${msg ? `：${msg}` : ''}`;
}

function authHeaderSets(auth) {
  const apiKey = String(auth.apiKey || '').trim();
  const accessKey = String(auth.accessKey || '').trim();
  const appId = String(auth.appId || '').trim();
  const sets = [];
  if (accessKey && !looksLikeUuid(accessKey) && !looksLikeVoiceId(accessKey) && !/^ark-/i.test(accessKey)) {
    if (appId) {
      sets.push({ 'X-Api-App-Id': appId, 'X-Api-Access-Key': accessKey });
      sets.push({ 'X-Api-App-Key': appId, 'X-Api-Access-Key': accessKey });
    }
    sets.push({ 'X-Api-Access-Key': accessKey });
  }
  if (apiKey && looksLikeUuid(apiKey)) {
    sets.push({ 'X-Api-Key': apiKey });
  }
  if (!sets.length && apiKey && !/^ark-/i.test(apiKey)) {
    sets.push({ 'X-Api-Key': apiKey });
  }
  return sets;
}

async function postUnidirectional(auth, payload) {
  let lastStatus = 0;
  let lastBody = '';
  for (const extra of authHeaderSets(auth)) {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Request-Id': randomUUID(),
        'X-Api-Resource-Id': RESOURCE_ID,
        ...extra,
      },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    lastStatus = res.status;
    lastBody = raw;
    if (res.ok) return raw;
    if (res.status !== 401 && res.status !== 403) break;
  }
  throw new Error(friendlyTtsError(lastStatus, lastBody));
}

async function synthesizeDoubao(text, auth, voices, lang) {
  const input = String(text || '').trim();
  if (!input) throw new Error('没有要朗读的文本');
  if (!auth?.apiKey && !auth?.accessKey) throw new Error('请先保存豆包语音合成 2.0 Access Token');
  const speaker = pickSpeaker(lang, input, voices);
  const chinese = String(lang || '').toLowerCase().startsWith('zh') || /[\u4e00-\u9fff]/.test(input);
  const raw = await postUnidirectional(auth, {
    user: { uid: 'zh-en-talk' },
    req_params: {
      text: input,
      speaker,
      audio_params: {
        format: 'pcm',
        sample_rate: SAMPLE_RATE,
      },
      additions: JSON.stringify({
        explicit_language: chinese ? 'zh-cn' : 'en',
      }),
    },
  });
  const pcm = parseNdjsonAudio(raw);
  return {
    engine: 'doubao-tts-2.0',
    speaker,
    sampleRate: SAMPLE_RATE,
    samples: pcm16ToFloat32(pcm),
  };
}

module.exports = {
  synthesizeDoubao,
  looksLikeUuid,
  looksLikeVoiceId,
  ZH_VOICE,
  EN_VOICE,
  ZH_VOICES,
  EN_VOICES,
};
