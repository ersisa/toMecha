'use strict';
/* ================= 网络层（多人对战） =================
 * 传输优先级：WebSocket 中继服务器（真网络）→ BroadcastChannel（同浏览器多标签兜底）
 * 统一 Link 接口：send(obj) / onMessage / onClose / close()
 * 消息格式：{ t:类型, from:发送者id, ... }（ws 由服务器附加 from；bc 自带 from 广播）
 *
 * 协议：
 *   hello   {t,from}          新玩家加入（host 维护名单）
 *   lobby   {t,from,players}  host 广播大厅名单（[{id,name}]，第一个是 host）
 *   start   {t,from,seed,players} host 开始对战（seed 用于各端生成同一张随机地图）
 *   inp     {t,from,l,r,b,j,a} 客户端 → host 输入
 *   snap    {t,from,m,w,ko}   host → 所有人 快照
 *   ev      {t,from,k,...}    reset / end（winner）
 *   bye     {t,from}          玩家离开（bc 模式由本端发送；ws 模式由服务器发）
 */

function bcLink(room, myId) {
  const ch = new BroadcastChannel('mecha-' + room);
  const link = {
    kind: 'bc', onMessage: null, onClose: null,
    send(o) { try { ch.postMessage({ ...o, from: myId }); } catch (e) {} },
    close() {
      try { ch.postMessage({ t: 'bye', from: myId }); } catch (e) {}
      try { ch.close(); } catch (e) {}
    },
  };
  ch.onmessage = (e) => {
    const m = e.data;
    if (!m || m.from === myId) return;      // 忽略自己
    if (link.onMessage) link.onMessage(m);
  };
  return link;
}

/* 构建 WebSocket URL（反向代理兼容）：
 * - 保留页面 URL 上已有的查询参数（如反向代理的端口路由参数 _port=xxxx）
 * - 以页面路径的目录为基准（支持子路径部署，如 https://host/game/）
 * - https 页面自动用 wss */
function buildWsUrl(room, myId) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const dir = location.pathname.replace(/[^/]*$/, '');
  const params = new URLSearchParams(location.search);
  params.set('room', room);
  params.set('id', myId);
  return proto + '//' + location.host + dir + '?' + params.toString();
}

function wsLink(room, myId) {
  return new Promise((resolve) => {
    let ws, done = false;
    const fallback = () => {
      if (done) return;
      done = true;
      try { if (ws) ws.close(); } catch (e) {}
      resolve(bcLink(room, myId));
    };
    try {
      ws = new WebSocket(buildWsUrl(room, myId));
    } catch (e) { return fallback(); }
    const timer = setTimeout(fallback, 1600);
    ws.onopen = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const link = {
        kind: 'ws', onMessage: null, onClose: null,
        send(o) { try { ws.send(JSON.stringify({ ...o, from: myId })); } catch (e) {} },
        close() { try { ws.close(); } catch (e) {} },
      };
      ws.onmessage = (e) => {
        let m = null;
        try { m = JSON.parse(e.data); } catch (err) {}
        if (m && link.onMessage) link.onMessage(m);
      };
      ws.onclose = () => { if (link.onClose) link.onClose(); };
      ws.onerror = () => { if (link.onClose) link.onClose(); };
      resolve(link);
    };
    ws.onerror = () => fallback();
    ws.onclose = () => fallback();
  });
}

async function connectNet(room, myId) {
  try { return await wsLink(room, myId); }
  catch (e) { return bcLink(room, myId); }
}
