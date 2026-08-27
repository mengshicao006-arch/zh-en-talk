const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DOWNLOAD_URLS = [
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
];

function runWhere() {
  return new Promise((resolve) => {
    const child = spawn('where', ['cloudflared'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.on('close', (code) => {
      const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(code === 0 && first && fs.existsSync(first) ? first : '');
    });
    child.on('error', () => resolve(''));
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    const get = (current, hops = 0) => {
      const lib = current.startsWith('https:') ? https : http;
      const req = lib.get(current, { headers: { 'User-Agent': 'zh-en-talk' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 8) {
          res.resume();
          get(res.headers.location, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(tmp, () => {});
          reject(new Error(`下载 cloudflared 失败（${res.statusCode}）`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });
      });
      req.setTimeout(60000, () => {
        req.destroy(new Error('下载超时'));
      });
      req.on('error', (err) => {
        file.close();
        fs.unlink(tmp, () => {});
        reject(err);
      });
    };
    get(url);
  });
}

async function ensureCloudflared(userDataDir) {
  const fromPath = await runWhere();
  if (fromPath) return fromPath;
  const local = path.join(userDataDir, 'cloudflared.exe');
  if (fs.existsSync(local) && fs.statSync(local).size > 1024 * 1024) return local;
  fs.mkdirSync(userDataDir, { recursive: true });
  let lastError = null;
  for (const url of DOWNLOAD_URLS) {
    try {
      await downloadFile(url, local);
      if (fs.existsSync(local) && fs.statSync(local).size > 1024 * 1024) return local;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('下载 cloudflared 失败');
}

function parseTunnelUrl(text) {
  const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0].replace(/\/$/, '') : '';
}

function parseMetricsAddr(text) {
  const match = String(text || '').match(/metrics[^\n]*127\.0\.0\.1:(\d+)/i)
    || String(text || '').match(/127\.0\.0\.1:(\d+)\/metrics/i);
  return match ? `127.0.0.1:${match[1]}` : '';
}

function startCloudflareTunnel(bin, localOrigin, onEvent) {
  let child = null;
  let stopped = false;
  let pollTimer = null;
  let restartTimer = null;

  const spawnOnce = () => {
    if (stopped) return;
    clearInterval(pollTimer);
    let announced = false;
    let seenUrl = '';
    let metricsAddr = '';
    let readyHits = 0;

    const announce = (url) => {
      if (!url || announced || stopped) return;
      announced = true;
      onEvent({ type: 'url', url });
    };

    child = spawn(bin, [
      'tunnel',
      '--url', localOrigin,
      '--no-autoupdate',
      '--protocol', 'http2',
      '--metrics', '127.0.0.1:0',
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const handle = (chunk) => {
      const text = chunk.toString();
      if (/ERR|error|failed|metrics|trycloudflare/i.test(text)) {
        console.log('[cloudflared]', text.trim().slice(0, 300));
      }
      metricsAddr = metricsAddr || parseMetricsAddr(text);
      seenUrl = seenUrl || parseTunnelUrl(text);
      if (/Registered tunnel connection/i.test(text) && seenUrl) announce(seenUrl);
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    child.on('error', (err) => {
      if (!stopped) onEvent({ type: 'error', message: err.message });
    });
    child.on('close', (code) => {
      clearInterval(pollTimer);
      if (stopped) return;
      onEvent({ type: 'error', message: `外网通道断开（${code ?? '未知'}），正在重连…` });
      restartTimer = setTimeout(spawnOnce, 2500);
    });

    pollTimer = setInterval(() => {
      if (announced || stopped) {
        clearInterval(pollTimer);
        return;
      }
      if (!metricsAddr) return;
      const req = http.get(`http://${metricsAddr}/ready`, { timeout: 1500 }, (readyRes) => {
        const ok = readyRes.statusCode === 200;
        readyRes.resume();
        if (!ok) {
          readyHits = 0;
          return;
        }
        readyHits += 1;
        if (readyHits < 2) return;
        if (seenUrl) {
          announce(seenUrl);
          return;
        }
        const info = http.get(`http://${metricsAddr}/quicktunnel`, { timeout: 1500 }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            try {
              const host = JSON.parse(body).hostname;
              if (host) announce(`https://${host}`);
            } catch {
              // keep waiting
            }
          });
        });
        info.on('error', () => {});
      });
      req.on('error', () => { readyHits = 0; });
    }, 1000);
  };

  spawnOnce();

  return {
    stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearTimeout(restartTimer);
      try { child?.kill(); } catch { /* already gone */ }
    },
  };
}

module.exports = { ensureCloudflared, startCloudflareTunnel };
