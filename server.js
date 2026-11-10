'use strict';
/* ============================================================
 * 像素机甲对战 —— 游戏服务器（零依赖 Node.js）
 *   1. 静态文件服务（本目录）
 *   2. WebSocket 多人房间中继：ws(s)://host/?room=XXXX&id=YYYY
 *      同一房间消息互相转发（服务器附加 from=id 标识发送者）
 *      加入/离开时向房间广播 join/bye 通知
 *      房间人数上限 MAX（超员通知 full 后断开）
 *   3. 可选 HTTPS：
 *      - 已存在 cert.pem + key.pem → 自动启用 HTTPS（443 / HTTPS_PORT / PORT+443）
 *      - 或首次运行用 `node server.js --gen-cert` 生成自签证书（10 年有效期），
 *        解决浏览器 ERR_CLEARTEXT_NOT_PERMITTED（HTTPS 页面禁止嵌入 HTTP）
 * 运行：
 *   node server.js                           # 默认 HTTP 端口 8080
 *   node server.js --gen-cert                # 生成自签 cert.pem + key.pem 并启动（HTTPS）
 *   PORT=443 node server.js                  # 指定端口
 *   HTTPS_PORT=8443 node server.js           # 同时 HTTP+HTTPS 双端口
 * ============================================================ */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/* ---------- 自签证书生成（首次启用 HTTPS 时） ---------- */
function genSelfSignedCert(certPath, keyPath) {
  const { execSync } = require('child_process');
  try {
    // 10 年有效期自签；CN 覆盖 localhost + 常见主机名（浏览器会报"不安全"但可跳过，
    // 用于解决 HTTPS 页面的 ERR_CLEARTEXT_NOT_PERMITTED；公网部署请使用正规 CA/Let's Encrypt）
    execSync(
      "openssl req -x509 -newkey rsa:2048 -nodes -keyout " + keyPath +
      " -out " + certPath + " -days 3650 -sha256 " +
      "-subj '/C=CN/ST=Beijing/L=Beijing/O=MechaBattle/OU=Pixel/CN=localhost' " +
      "-addext 'subjectAltName=DNS:localhost,DNS:*.local,IP:127.0.0.1,IP:10.78.148.138'",
      { stdio: 'pipe' }
    );
    return true;
  } catch (e) {
    // openssl 不可用时，用 Node 内置 crypto 自签（RSA 2048 + X.509）
    try { return genCertNode(certPath, keyPath); } catch (e2) { return false; }
  }
}
function genCertNode(certPath, keyPath) {
  // 兼容 openssl 缺失场景（基于 crypto.createPrivateKey / createSign 手写 X.509 比较复杂，
  // 这里给出更友好的错误提示并尝试用 node-forge 式的回退；若均不可则提示用户手动生成）
  // 轻量回退：生成 RSA 私钥 + 让用户手工签发，或者直接失败并打印指引。
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pemPriv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pemPub  = publicKey.export({  type: 'spki',  format: 'pem' });
  fs.writeFileSync(keyPath, pemPriv);
  fs.writeFileSync(certPath,
    '-----BEGIN CERTIFICATE-----\n' +
    Buffer.from('SELF-SIGNED-PLACEHOLDER-' + Date.now()).toString('base64') + '\n' +
    '-----END CERTIFICATE-----\n');
  fs.appendFileSync(certPath, '\n# 注意：这是占位证书，浏览器会拒绝。请手动生成：\n' +
    '# openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -sha256 \\\n' +
    '#   -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1"\n');
  // 删除占位证书文件，启动时重新判定为没有证书 → HTTP 启动
  fs.unlinkSync(certPath);
  fs.unlinkSync(keyPath);
  return false;
}

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const MAX_PER_ROOM = 6;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------- 源码打包下载（手机浏览器可直接下载） ---------- */
const ZIP_FILES = [
  'index.html', 'style.css', 'game.js', 'server.js',
  'js/config.js', 'js/skills.js', 'js/input.js', 'js/net.js',
  'js/world.js', 'js/mecha.js', 'js/bot.js',
];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* 生成 ZIP（store 模式，不压缩；源码体积小，够用且实现无需依赖） */
function buildZip(entries) {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // 解压所需版本
    lh.writeUInt16LE(0x0800, 6);    // 文件名 UTF-8
    lh.writeUInt16LE(0, 8);         // 存储（不压缩）
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // 创建版本
    ch.writeUInt16LE(20, 6);        // 解压所需版本
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + e.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([locals[0] ? Buffer.concat(locals) : Buffer.alloc(0), centralBuf, eocd]);
}

function handleDownload(req, res) {
  const entries = [];
  for (const rel of ZIP_FILES) {
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) continue;
    try { entries.push({ name: 'mecha-battle/' + rel, data: fs.readFileSync(file) }); } catch (e) {}
  }
  if (!entries.length) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('打包失败'); return; }
  const zip = buildZip(entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': 'attachment; filename="mecha-battle.zip"',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  res.end(zip);
}

/* ---------- 静态文件（HTTP/HTTPS 共用） ---------- */
function staticHandler(req, res) {
  /* 源码打包下载：手机浏览器直接访问即可保存 */
  if (req.url.split('?')[0] === '/download/mecha-battle.zip') { handleDownload(req, res); return; }
  /* 房间 BGM 临时存放：上传 / 播放 / 删除（房间解散即删） */
  if (req.url.startsWith('/api/bgm')) { handleBgm(req, res); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ---------- 房间 BGM（本地文件上传，单局有效） ---------- */
const BGM_DIR = path.join(os.tmpdir(), 'mecha-bgm');
const BGM_MAX = 20 * 1024 * 1024;                 // 单文件上限 20MB
const BGM_EXT = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
                  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' };
try { fs.rmSync(BGM_DIR, { recursive: true, force: true }); } catch (e) {}   // 启动清空历史残留

const validRoom = (r) => /^[A-Z0-9]{4}$/.test(r || '');

/* 按魔数识别音频格式，拒绝 HTML/图片等伪装内容 */
function detectAudioExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return '.mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3';
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return '.ogg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' &&
      buf.slice(8, 12).toString('latin1') === 'WAVE') return '.wav';
  if (buf.slice(0, 4).toString('latin1') === 'fLaC') return '.flac';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return '.m4a';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return '.aac';
  return null;
}

/* 查找房间当前 BGM 文件 */
function findBgm(room) {
  for (const ext of Object.keys(BGM_EXT)) {
    const f = path.join(BGM_DIR, room + ext);
    try { if (fs.statSync(f).isFile()) return { file: f, ext }; } catch (e) {}
  }
  return null;
}

function clearBgm(room) {
  for (const ext of Object.keys(BGM_EXT)) {
    try { fs.unlinkSync(path.join(BGM_DIR, room + ext)); } catch (e) {}
  }
}

function handleBgm(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const room = (url.searchParams.get('room') || '').toUpperCase();
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (!validRoom(room)) { json(400, { ok: false, err: '房间码无效' }); return; }

  if (req.method === 'POST') {
    /* 只允许上传到存在中的房间，避免被当成任意文件存储 */
    if (!rooms.has(room)) { json(404, { ok: false, err: '房间不存在' }); return; }
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BGM_MAX) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) { json(413, { ok: false, err: '文件超过 20MB' }); return; }
      if (!size) { json(400, { ok: false, err: '文件为空' }); return; }
      const buf = Buffer.concat(chunks);
      const ext = detectAudioExt(buf);
      if (!ext) { json(415, { ok: false, err: '不是支持的音频文件（mp3/ogg/wav/m4a/aac/flac）' }); return; }
      clearBgm(room);
      try { fs.mkdirSync(BGM_DIR, { recursive: true }); } catch (e) {}
      try { fs.writeFileSync(path.join(BGM_DIR, room + ext), buf); }
      catch (e) { json(500, { ok: false, err: '保存失败' }); return; }
      console.log('[bgm] 上传', room, ext, Math.round(size / 1024) + 'KB');
      json(200, { ok: true, url: '/api/bgm?room=' + room + '&t=' + Date.now() });
    });
    req.on('error', () => { try { json(500, { ok: false, err: '上传中断' }); } catch (e) {} });
    return;
  }

  if (req.method === 'DELETE') {
    clearBgm(room);
    console.log('[bgm] 清除', room);
    json(200, { ok: true });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { json(405, { ok: false, err: '方法不支持' }); return; }

  const found = findBgm(room);
  if (!found) { json(404, { ok: false, err: '该房间没有 BGM' }); return; }
  let stat;
  try { stat = fs.statSync(found.file); } catch (e) { json(404, { ok: false, err: '读取失败' }); return; }
  const type = BGM_EXT[found.ext];
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };

  /* Range 支持：浏览器循环播放/拖动进度需要 206 */
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }
    res.writeHead(206, Object.assign({}, head, {
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
    }));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(found.file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, Object.assign({}, head, { 'Content-Length': stat.size }));
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(found.file).pipe(res);
}
const server = http.createServer(staticHandler);

/* ---------- WebSocket 实现（RFC6455 最小集，HTTP/HTTPS 升级共用） ---------- */
const rooms = new Map();   // room -> Set<conn>

function frame(str) {
  const p = Buffer.from(str);
  let header;
  if (p.length < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = p.length; }
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(p.length, 2); }
  return Buffer.concat([header, p]);
}

function upgradeToWs(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  const room = url.searchParams.get('room') || '';
  const key = req.headers['sec-websocket-key'];
  if (!key || !room) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  let set = rooms.get(room);
  if (!set) { set = new Set(); rooms.set(room, set); }

  /* 超员：通知后断开 */
  if (set.size >= MAX_PER_ROOM) {
    socket.write(frame(JSON.stringify({ t: 'full' })));
    setTimeout(() => { try { socket.destroy(); } catch (e) {} }, 200);
    return;
  }

  const conn = { socket, room, id: url.searchParams.get('id') || ('g' + Math.random().toString(36).slice(2, 7)), buf: Buffer.alloc(0), alive: true };
  set.add(conn);
  console.log('[ws] 加入房间', room, 'id=' + conn.id, '当前人数', set.size);

  /* 广播加入通知 */
  broadcast(conn, { t: 'join', from: conn.id });

  socket.on('data', (chunk) => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    for (;;) {
      const r = tryParse(conn);
      if (r === undefined) break;          // 数据不完整
      if (r === null) continue;            // 已消费但无需处理（ping/close 等）
      /* 保活回执：房间里只有自己时也必须收到消息，否则客户端 10s 判超时断线 */
      if (r.t === 'ping') sendTo(conn, { t: 'pong' });
      relay(conn, r);                      // 文本消息 → 转发给房间其他人（附加 from）
    }
  });
  const cleanup = () => {
    if (!set.has(conn)) return;
    set.delete(conn);
    if (!set.size) {
      rooms.delete(room);
      clearBgm(room);   /* 房间解散：删除该房间的临时 BGM 文件 */
    }
    console.log('[ws] 离开房间', room, 'id=' + conn.id, '剩余', set.size);
    broadcast(conn, { t: 'bye', from: conn.id });
    try { socket.destroy(); } catch (e) {}
  };
  /* 断开检测：升级后的 socket 在部分 Node 版本只触发 end 不触发 close，三个都挂上（cleanup 幂等） */
  socket.on('end', cleanup);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/* 解析一帧；undefined=需要更多数据，null=忽略帧，对象=JSON 消息 */
function tryParse(conn) {
  const b = conn.buf;
  if (b.length < 2) return undefined;
  const op = b[0] & 0x0f;
  const masked = !!(b[1] & 0x80);
  let len = b[1] & 0x7f, off = 2;
  if (len === 126) { if (b.length < 4) return undefined; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return undefined; len = Number(b.readBigUInt64BE(2)); off = 10; }
  let mask = null;
  if (masked) { if (b.length < off + 4) return undefined; mask = b.subarray(off, off + 4); off += 4; }
  if (b.length < off + len) return undefined;
  let payload = b.subarray(off, off + len);
  if (mask) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  conn.buf = b.subarray(off + len);
  if (op === 8) { try { conn.socket.end(); } catch (e) {} return null; }
  if (op === 9) {  // ping → pong
    if (payload.length < 126) {
      const h = Buffer.alloc(2); h[0] = 0x8a; h[1] = payload.length;
      conn.socket.write(Buffer.concat([h, payload]));
    }
    return null;
  }
  if (op === 1) {
    try { return JSON.parse(payload.toString()); } catch (e) { return null; }
  }
  return null;
}

/* 转发给房间内除发送者外的所有人，附加发送者 id */
function relay(from, msg) {
  msg.from = from.id;
  broadcast(from, msg);
}

/* 直接回给单个连接（保活回执用） */
function sendTo(conn, msg) {
  let text;
  try { text = JSON.stringify(msg); } catch (e) { return; }
  try { conn.socket.write(frame(text)); } catch (e) {}
}

function broadcast(from, msg) {
  const set = rooms.get(from.room);
  if (!set) return;
  let text;
  try { text = JSON.stringify(msg); } catch (e) { return; }
  if (text.length > 65535) return;
  const buf = frame(text);
  for (const c of set) {
    if (c !== from) { try { c.socket.write(buf); } catch (e) {} }
  }
}

/* ---------- 启动（HTTP + 可选 HTTPS） ---------- */
const certPath = path.join(ROOT, 'cert.pem');
const keyPath  = path.join(ROOT, 'key.pem');
let opts = null;
if (process.argv.includes('--gen-cert')) {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    const ok = genSelfSignedCert(certPath, keyPath);
    if (ok) console.log('[https] 自签证书已生成: cert.pem + key.pem（浏览器首次访问会提示不安全，选择继续即可）');
    else console.warn('[https] openssl 不可用，回退 HTTP 启动');
  }
}
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try { opts = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }; }
  catch (e) { opts = null; console.warn('[https] 读取证书失败，回退 HTTP:', e.message); }
}

const wsUpgrade = (req, socket) => upgradeToWs(req, socket);   // 统一的 WebSocket 升级处理

/* HTTP 服务器（静态 + WebSocket 升级） */
server.on('upgrade', (req, socket) => wsUpgrade(req, socket));
server.on('error', onServerError);
server.listen(PORT, '0.0.0.0', () => printListenInfo('http', PORT));

/* HTTPS 服务器：cert 存在时启用（双端口并行，或覆盖单端口） */
if (opts) {
  const httpsPort = parseInt(process.env.HTTPS_PORT, 10) ||
                    (parseInt(process.env.PORT, 10) ? null : 443) ||
                    (parseInt(PORT, 10) + 443);
  const srv = https.createServer(opts, staticHandler);
  srv.on('upgrade', (req, socket) => wsUpgrade(req, socket));
  srv.on('error', onServerError);
  srv.listen(httpsPort, '0.0.0.0', () => printListenInfo('https', httpsPort));
}

function onServerError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + err.port + ' 已被占用，请换端口启动：PORT=9000 node server.js');
    process.exit(1);
  } else {
    console.error('服务器监听失败:', err.message);
    process.exit(1);
  }
}

function printListenInfo(scheme, port) {
  const s = scheme + '://localhost:' + port;
  if (scheme === 'http')  console.log('像素机甲对战服务器已启动: ' + s);
  else console.log('[https] 加密通道已启用: ' + s + '（解决 ERR_CLEARTEXT_NOT_PERMITTED）');
  const nets = os.networkInterfaces();
  const lans = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) lans.push(net.address);
    }
  }
  if (lans.length) {
    for (const ip of lans) console.log('局域网 ' + scheme.toUpperCase() + ' 地址: ' + scheme + '://' + ip + ':' + port);
    if (scheme === 'http') {
      console.log('公网部署：把本服务部署到云主机/公网服务器后，任意设备通过域名/IP 访问即可互联网联机');
      console.log('  · 推荐配 Nginx/Caddy 反代 + Let\'s Encrypt 正规 HTTPS 证书，避免浏览器警告');
      console.log('  · 快速体验：加 --gen-cert 启用自签 HTTPS（首次访问浏览器点"继续访问"）');
    }
  } else {
    console.log('未检测到局域网 IP（仅本机可访问）');
  }
}
