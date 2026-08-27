const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf8');
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...headers,
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function downsampleFloat32(input, fromRate, toRate) {
  if (!fromRate || Math.abs(fromRate - toRate) < 1) return input;
  const outLength = Math.max(1, Math.round(input.length * (toRate / fromRate)));
  const out = new Float32Array(outLength);
  const ratio = (input.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function toPhonePcm16(samples, sampleRate) {
  let floats;
  if (samples instanceof Float32Array) floats = samples;
  else if (Buffer.isBuffer(samples)) {
    floats = new Float32Array(samples.buffer, samples.byteOffset, Math.floor(samples.byteLength / 4));
  } else {
    floats = new Float32Array(samples || []);
  }
  const targetRate = 16000;
  const down = downsampleFloat32(floats, sampleRate || 24000, targetRate);
  const pcm = Buffer.alloc(down.length * 2);
  for (let i = 0; i < down.length; i += 1) {
    const s = Math.max(-1, Math.min(1, down[i]));
    pcm.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), i * 2);
  }
  return { pcm, sampleRate: targetRate };
}

function sendPhoneAudio(res, result, extraHeaders = {}) {
  const packed = toPhonePcm16(result.samples, result.sampleRate);
  send(res, 200, packed.pcm, {
    'Content-Type': 'application/octet-stream',
    'X-Sample-Rate': String(packed.sampleRate),
    'X-Tts-Engine': String(result.engine || 'doubao-tts-2.0'),
    'X-Format': 'pcm16',
    ...extraHeaders,
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('内容太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stripTalkPath(pathname) {
  const match = String(pathname || '').match(/^\/t\/([^/]+)(\/.*)?$/);
  if (!match) return { pathToken: '', pathname: pathname || '/' };
  const rest = match[2] && match[2] !== '/' ? match[2] : '/';
  return { pathToken: match[1], pathname: rest };
}

function safeFile(staticDir, pathname) {
  const raw = decodeURIComponent(pathname.split('?')[0] || '/');
  const rel = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '');
  const full = path.normalize(path.join(staticDir, rel));
  const root = path.normalize(staticDir + path.sep);
  if (!full.startsWith(root)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return full;
}

function startPhoneServer({ host, port, staticDir, token, handlers }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const routed = stripTalkPath(url.pathname);
      const apiPath = url.pathname.startsWith('/api/') ? url.pathname : routed.pathname;
      if (apiPath.startsWith('/api/')) {
        const key = String(req.headers['x-talk-key'] || '');
        if (!token || key !== token) {
          send(res, 401, '链接无效，请用电脑上的二维码重新打开', {
            'Content-Type': 'text/plain; charset=utf-8',
          });
          return;
        }
        if (req.method === 'GET' && apiPath === '/api/status') {
          sendJson(res, 200, await handlers.status());
          return;
        }
        if (req.method === 'GET' && apiPath === '/api/voices') {
          sendJson(res, 200, await handlers.voices());
          return;
        }
        if (req.method === 'POST' && apiPath === '/api/translate') {
          const body = JSON.parse((await readBody(req, 32 * 1024)).toString('utf8') || '{}');
          const text = await handlers.translate(String(body.text || '').trim());
          sendJson(res, 200, { text });
          return;
        }
        if (req.method === 'POST' && apiPath === '/api/asr') {
          const pcm = await readBody(req, 2 * 1024 * 1024);
          const text = await handlers.transcribe(pcm);
          sendJson(res, 200, { text: String(text || '') });
          return;
        }
        if (req.method === 'POST' && apiPath === '/api/tts') {
          const body = JSON.parse((await readBody(req, 32 * 1024)).toString('utf8') || '{}');
          const result = await handlers.tts(String(body.text || ''), String(body.lang || 'en'));
          sendPhoneAudio(res, result);
          return;
        }
        if (req.method === 'POST' && apiPath === '/api/turn') {
          const pcm = await readBody(req, 2 * 1024 * 1024);
          const result = await handlers.turn(pcm);
          const phone = toPhonePcm16(result.samples, result.sampleRate);
          sendJson(res, 200, {
            sourceText: result.sourceText || '',
            translated: result.translated || '',
            sampleRate: phone.sampleRate,
            engine: result.engine || 'doubao-tts-2.0',
            format: 'pcm16',
            audio: phone.pcm.toString('base64'),
          });
          return;
        }
        if (req.method === 'POST' && apiPath === '/api/voice') {
          const body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8') || '{}');
          await handlers.setVoice(String(body.lang || ''), String(body.voice || ''));
          sendJson(res, 200, { ok: true });
          return;
        }
        send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      const file = safeFile(staticDir, routed.pathname);
      if (!file) {
        const fallback = routed.pathToken ? safeFile(staticDir, '/') : null;
        if (fallback) {
          send(res, 200, fs.readFileSync(fallback), { 'Content-Type': MIME['.html'] });
          return;
        }
        send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }
      const ext = path.extname(file).toLowerCase();
      send(res, 200, fs.readFileSync(file), {
        'Content-Type': MIME[ext] || 'application/octet-stream',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(res, 500, message, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        server,
        origin: `http://${host}:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startPhoneServer };
