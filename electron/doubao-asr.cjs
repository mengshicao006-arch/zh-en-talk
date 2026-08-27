const { randomUUID } = require('crypto');
const zlib = require('zlib');
const WebSocket = require('ws');

const WS_URLS = [
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream',
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
];
const RESOURCE_IDS = [
  'volc.seedasr.sauc.duration',
  'volc.seedasr.sauc.concurrent',
  'volc.bigasr.sauc.duration',
  'volc.bigasr.sauc.concurrent',
];

function buildHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    (0x01 << 4) | 0x01,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
}

function buildFrame(header, payload) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

function parseFrame(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length < 8) return { error: '识别返回数据太短' };
  const headerSize = (buf[0] & 0x0f) * 4;
  const messageType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const serialization = buf[2] >> 4;
  const compression = buf[2] & 0x0f;
  let offset = headerSize;
  if (flags & 0x01) offset += 4;

  const readPayload = (start) => {
    if (start + 4 > buf.length) return Buffer.alloc(0);
    const size = buf.readUInt32BE(start);
    return buf.subarray(start + 4, Math.min(buf.length, start + 4 + size));
  };

  if (messageType === 0x0f) {
    const code = buf.readUInt32BE(offset);
    offset += 4;
    let payload = readPayload(offset);
    if (compression === 1 && payload.length) {
      try {
        payload = zlib.gunzipSync(payload);
      } catch {
        // keep raw
      }
    }
    const text = payload.toString('utf8');
    return { error: `豆包识别失败（${code}）：${text.slice(0, 240)}` };
  }

  let payload = readPayload(offset);
  if (compression === 1 && payload.length) {
    try {
      payload = zlib.gunzipSync(payload);
    } catch {
      payload = readPayload(headerSize);
      if (compression === 1 && payload.length) payload = zlib.gunzipSync(payload);
    }
  }
  if (serialization !== 1) {
    return { text: '', definite: false, last: Boolean(flags & 0x02 || flags & 0x03) };
  }
  const msg = JSON.parse(payload.toString('utf8'));
  const body = msg.payload_msg && typeof msg.payload_msg === 'object' ? msg.payload_msg : msg;
  const code = body.code ?? msg.code;
  if (code && code !== 0 && code !== 1000 && code !== 20000000 && code !== 1013) {
    return { error: `豆包识别失败（${code}）：${JSON.stringify(body).slice(0, 240)}` };
  }
  return { ...extractResult(body), last: Boolean(flags & 0x02 || flags & 0x03) };
}

function extractResult(msg) {
  const result = msg?.result;
  let text = '';
  let definite = false;
  if (typeof result === 'string') {
    text = result.trim();
    definite = !!msg?.definite;
  } else if (Array.isArray(result) && result.length) {
    text = result.map((item) => (typeof item === 'string' ? item : item?.text || '')).join('').trim();
    definite = result.some((item) => item?.definite === true);
  } else if (result && typeof result === 'object') {
    const utterances = result.utterances;
    if (Array.isArray(utterances) && utterances.length) {
      const last = utterances[utterances.length - 1];
      text = String(result.text || last.text || '').trim();
      definite = last.definite === true || result.definite === true;
    } else {
      text = String(result.text || '').trim();
      definite = result.definite === true;
    }
  } else {
    text = String(msg?.text || '').trim();
    definite = !!msg?.definite;
  }
  return { text, definite };
}

function authHeaders(apiKey, resourceId, requestId) {
  return {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Connect-Id': requestId,
    'X-Api-Sequence': '-1',
  };
}

function handshakeError(status) {
  if (status === 401) {
    return new Error('豆包语音鉴权失败（401）。请使用豆包语音控制台的 API Key，不要用方舟 ark- Key。');
  }
  if (status === 403) {
    return new Error('豆包语音没有权限（403）。请在控制台开通「豆包流式语音识别模型 2.0」，并把这个 API Key 授权给该服务。');
  }
  return new Error(`豆包语音连接失败（${status}）`);
}

function transcribeWithResource(pcmBuffer, apiKey, resourceId, wsUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastText = '';
    let timer = null;
    const ws = new WebSocket(wsUrl, {
      headers: authHeaders(apiKey, resourceId, randomUUID()),
    });

    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(text || '');
    };

    timer = setTimeout(() => finish(null, lastText), 15000);

    const bumpTimer = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(null, lastText), ms);
    };

    let ready = false;
    const sendAudio = () => {
      const chunkSize = 3200;
      const pcm = Buffer.from(pcmBuffer);
      if (!pcm.length) {
        finish(new Error('没有采集到声音'));
        return;
      }
      for (let offset = 0; offset < pcm.length; offset += chunkSize) {
        const slice = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length));
        const last = offset + chunkSize >= pcm.length;
        const gzipAudio = zlib.gzipSync(slice);
        const flags = last ? 0x02 : 0x00;
        ws.send(buildFrame(buildHeader(0x02, flags, 0x00, 0x01), gzipAudio));
      }
      bumpTimer(12000);
    };

    ws.on('message', (data) => {
      try {
        const parsed = parseFrame(data);
        if (parsed.error) {
          finish(new Error(parsed.error));
          return;
        }
        if (parsed.text) lastText = parsed.text;
        if (!ready) {
          ready = true;
          sendAudio();
          return;
        }
        if (lastText && (parsed.definite || parsed.last)) finish(null, lastText);
      } catch (err) {
        finish(err);
      }
    });
    ws.on('unexpected-response', (_req, res) => finish(handshakeError(res.statusCode)));
    ws.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const status = Number((/Unexpected server response: (\d+)/.exec(msg) || [])[1]);
      if (status) {
        finish(handshakeError(status));
        return;
      }
      finish(err);
    });
    ws.on('close', () => {
      if (!settled) finish(null, lastText);
    });
    ws.on('open', () => {
      try {
        const config = {
          user: { uid: 'zh-en-talk' },
          audio: {
            format: 'pcm',
            codec: 'raw',
            rate: 16000,
            bits: 16,
            channel: 1,
          },
          request: {
            model_name: 'bigmodel',
            enable_itn: true,
            enable_punc: true,
            enable_ddc: true,
          },
        };
        const gzipJson = zlib.gzipSync(Buffer.from(JSON.stringify(config)));
        ws.send(buildFrame(buildHeader(0x01, 0x00, 0x01, 0x01), gzipJson));
      } catch (err) {
        finish(err);
      }
    });
  });
}

async function transcribePcm16(pcmBuffer, apiKey) {
  if (!apiKey) throw new Error('缺少豆包语音 API Key');
  let lastError = null;
  for (const wsUrl of WS_URLS) {
    for (const resourceId of RESOURCE_IDS) {
      try {
        return await transcribeWithResource(pcmBuffer, apiKey, resourceId, wsUrl);
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/403|401|grant|未开通|resource|鉴权|没有权限|连接失败/i.test(msg)) throw err;
      }
    }
  }
  throw lastError || new Error('豆包语音识别失败');
}

module.exports = { transcribePcm16 };
