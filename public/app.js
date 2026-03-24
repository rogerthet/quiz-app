/**
 * app.js — 共享 WebSocket 管理器
 * 每个页面引入此文件，通过 QuizApp 对象进行通信
 */

const QuizApp = (() => {
  // WebSocket 地址：HTTP 用 ws://，HTTPS 用 wss://（Railway 需要 wss）
  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

  let ws = null;
  const handlers = [];

  /* ── 工具 ── */
  function toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), duration);
  }

  /* ── 连接 ── */
  function connect(onOpen) {
    if (ws && ws.readyState === WebSocket.OPEN) { onOpen && onOpen(); return; }

    ws = new WebSocket(WS_URL);

    ws.onopen = () => { onOpen && onOpen(); };

    ws.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      handlers.forEach(h => {
        if (h.type === data.type || h.type === '*') h.cb(data);
      });
    };

    ws.onclose = () => { ws = null; };

    ws.onerror = () => {
      ws = null;
      toast('网络连接失败，请刷新重试');
    };
  }

  /* ── 重连（页面加载时调用） ── */
  function reconnect(role, onSuccess) {
    connect(() => {
      if (role === 'player') {
        const name = sessionStorage.getItem('playerName');
        if (!name) { location.href = '/'; return; }
        on('join_success', (d) => { sessionStorage.setItem('playerId', d.playerId); onSuccess && onSuccess(d); }, true);
        on('error', (d) => { toast(d.message); location.href = '/'; }, true);
        send({ type: 'join_player', name });
      } else if (role === 'admin') {
        const pw = sessionStorage.getItem('adminPassword');
        if (!pw) { location.href = '/'; return; }
        on('admin_joined', (d) => { onSuccess && onSuccess(d); }, true);
        on('error', (d) => { toast(d.message); location.href = '/'; }, true);
        send({ type: 'join_admin', password: pw });
      }
    });
  }

  /* ── 发送 ── */
  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    } else {
      toast('未连接服务器');
    }
  }

  /* ── 注册消息处理器 ── */
  function on(type, cb, once = false) {
    const entry = {
      type, cb: once ? (d) => { cb(d); off(entry.cb); } : cb
    };
    entry.cb = once ? (d) => { cb(d); handlers.splice(handlers.indexOf(entry), 1); } : cb;
    handlers.push(entry);
  }

  /* ── 移除处理器 ── */
  function off(cb) {
    const idx = handlers.findIndex(h => h.cb === cb);
    if (idx !== -1) handlers.splice(idx, 1);
  }

  /* ── 关闭 ── */
  function close() {
    if (ws) { ws.close(); ws = null; }
    handlers.length = 0;
  }

  return { connect, reconnect, send, on, off, close, toast };
})();
