/* ===== cfmon 前端：无框架、无构建，只做轮询 + 渲染 ===== */

const REFRESH_MS = 5000;

const RANGES = [
  { label: '1 小时', seconds: 3600 },
  { label: '6 小时', seconds: 21600 },
  { label: '24 小时', seconds: 86400 },
];

const state = {
  servers: [],
  series: {},
  range: 3600,
  timer: 0,
  busy: false,
  failing: false,
  detailId: null,
  offlineAfter: 90,
  lastHistory: 0,
  authed: false,
  publicView: true,
  denied: false,
  query: '',
  theme: 'light',
  dragging: false,
  dragEndAt: 0,
  needsSetup: false,
};

const $ = (sel, root = document) => root.querySelector(sel);

const el = {
  login: $('#login'),
  loginForm: $('#login-form'),
  loginPassword: $('#login-password'),
  loginSubmit: $('#login-submit'),
  loginBack: $('#login-back'),
  loginErr: $('#login-err'),
  setup: $('#setup'),
  setupForm: $('#setup-form'),
  setupPassword: $('#setup-password'),
  setupPassword2: $('#setup-password2'),
  setupSubmit: $('#setup-submit'),
  setupErr: $('#setup-err'),
  app: $('#app'),
  grid: $('#grid'),
  empty: $('#empty'),
  needLogin: $('#need-login'),
  statClock: $('#stat-clock'),
  statOnline: $('#stat-online'),
  statRegion: $('#stat-region'),
  statTraffic: $('#stat-traffic'),
  statNet: $('#stat-net'),
  countLine: $('#count-line'),
  search: $('#search'),
  btnTheme: $('#btn-theme'),
  pulse: $('#pulse'),
  detail: $('#detail'),
  detailBody: $('#detail-body'),
  addModal: $('#add-modal'),
  addTitle: $('#add-title'),
  addForm: $('#add-form'),
  addName: $('#add-name'),
  addRegion: $('#add-region'),
  addNote: $('#add-note'),
  addResult: $('#add-result'),
  addSubmit: $('#add-submit'),
  addActions: $('#add-actions'),
  settingsModal: $('#settings-modal'),
  setTgToken: $('#set-tg-token'),
  setTgChat: $('#set-tg-chat'),
  setCpuOn: $('#set-cpu-on'),
  setCpuPct: $('#set-cpu-pct'),
  setCpuMin: $('#set-cpu-min'),
  setMemOn: $('#set-mem-on'),
  setMemPct: $('#set-mem-pct'),
  setMemMin: $('#set-mem-min'),
  setNetOn: $('#set-net-on'),
  setNetMbps: $('#set-net-mbps'),
  setNetMin: $('#set-net-min'),
  setOfflineOn: $('#set-offline-on'),
  setOfflineMin: $('#set-offline-min'),
  setCooldown: $('#set-cooldown'),
  setBillingDays: $('#set-billing-days'),
  toast: $('#toast'),
};

const cards = new Map();
let dragId = null;

/* ------------------------------------------------------------------ 小工具 */

const esc = (str) =>
  String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

const numOf = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  const x = v / Math.pow(1024, i);
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

const fmtRate = (n) => `${fmtBytes(n)}/s`;

function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

function fmtDuration(seconds) {
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分`;
  return `${sec}秒`;
}

function fmtAgo(ts) {
  if (!ts) return '从未上报';
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (diff < 10) return '刚刚';
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function hhmm(ts, withDate) {
  const d = new Date(Number(ts) * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  if (!withDate) return `${hh}:${mi}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mi}`;
}

const level = (pct) => (pct >= 88 ? 'bad' : pct >= 70 ? 'warn' : 'ok');

function niceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * exp;
}

function toast(message, isBad = false) {
  el.toast.textContent = message;
  el.toast.className = `toast${isBad ? ' bad' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
}

/* ---------------------------------------------------------------- 请求封装 */

async function request(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return data;
}

async function api(path, opts) {
  // 不在这里弹登录框：页面默认永远是状态视图，
  // 只有用户主动点写操作、且确实没权限时才提示登录
  return request(path, opts);
}

/* -------------------------------------------------------------- 登录 / 进入 */

function applyMode() {
  document.body.classList.toggle('guest', !state.authed);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  if (el.btnTheme) el.btnTheme.textContent = state.theme === 'dark' ? '☀' : '🌙';
}

function showLogin() {
  stopPolling();
  el.login.classList.remove('hidden');
  el.loginBack.classList.toggle('hidden', !state.publicView);
  el.loginPassword.value = '';
  el.loginErr.textContent = '';
  setTimeout(() => el.loginPassword.focus(), 60);
}

async function enterPanel() {
  el.login.classList.add('hidden');
  el.app.classList.remove('hidden');
  applyMode();
  startPolling();
  await refresh(true);
}

el.loginBack.addEventListener('click', async () => {
  if (state.publicView) {
    await enterPanel();
  } else {
    window.location.reload();
  }
});

/* 首次部署：设置管理密码 */
function showSetup() {
  stopPolling();
  el.app.classList.add('hidden');
  el.setup.classList.remove('hidden');
  el.setupErr.textContent = '';
  setTimeout(() => el.setupPassword.focus(), 60);
}

el.setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = el.setupPassword.value;
  if (password.length < 6) {
    el.setupErr.textContent = '密码至少 6 位';
    return;
  }
  if (password !== el.setupPassword2.value) {
    el.setupErr.textContent = '两次输入不一致';
    return;
  }
  el.setupSubmit.disabled = true;
  try {
    await request('/api/setup', { method: 'POST', body: { password } });
    state.authed = true;
    state.needsSetup = false;
    el.setup.classList.add('hidden');
    el.setupPassword.value = '';
    el.setupPassword2.value = '';
    await enterPanel();
    toast('密码已设置，欢迎使用');
  } catch (error) {
    el.setupErr.textContent = error.message || '设置失败';
  } finally {
    el.setupSubmit.disabled = false;
  }
});

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = el.loginPassword.value;
  if (!password) return;
  el.loginSubmit.disabled = true;
  el.loginErr.textContent = '';
  try {
    await request('/api/login', { method: 'POST', body: { password } });
    state.authed = true;
    await enterPanel();
  } catch (error) {
    el.loginErr.textContent = error.message || '登录失败';
    el.loginPassword.select();
  } finally {
    el.loginSubmit.disabled = false;
  }
});

/* -------------------------------------------------------------------- 轮询 */

function startPolling() {
  stopPolling();
  state.timer = setInterval(refresh, REFRESH_MS);
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = 0;
}

function setPulse(kind) {
  el.pulse.className = `pulse${kind === 'err' ? ' err' : kind === 'stale' ? ' stale' : ''}`;
  el.pulse.title = kind === 'err' ? '连接失败，重试中' : '自动刷新中';
}

async function refresh(forceHistory = false) {
  if (state.busy || document.hidden) return;
  state.busy = true;
  try {
    // 历史曲线不需要跟状态一样每 5 秒拉一次：采样本身就是 60 秒一次，
    // 长区间更是几分钟才需要重画，这样能把 D1 读取量压下来。
    const every = state.range <= 21600 ? 60000 : 300000;
    const needHistory = forceHistory || !state.lastHistory || Date.now() - state.lastHistory >= every;

    const [list, history] = await Promise.all([
      api('/api/servers'),
      needHistory ? api(`/api/history?seconds=${state.range}`).catch(() => null) : Promise.resolve(null),
    ]);

    state.servers = list.servers || [];
    state.offlineAfter = list.offline_after || 90;
    if (history) {
      state.series = history.series || {};
      state.lastHistory = Date.now();
    }
    state.denied = false;
    state.failing = false;
    setPulse('ok');
    render();
  } catch (error) {
    if (error.status === 401) {
      // 没有游客权限：停在状态视图，显示「需要登录」，不弹窗
      state.authed = false;
      state.denied = true;
      state.servers = [];
      state.series = {};
      applyMode();
      render();
      return;
    }
    setPulse('err');
    if (!state.failing) {
      state.failing = true;
      toast('与面板的连接中断，正在重试…', true);
    }
  } finally {
    state.busy = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.timer) refresh();
});

/* -------------------------------------------------------------------- 渲染 */

function render() {
  el.needLogin.classList.toggle('hidden', !state.denied);
  el.empty.classList.toggle('hidden', state.denied || state.servers.length > 0);
  renderStats();
  syncCards();
  if (state.detailId) renderDetail();
}

function renderStats() {
  const total = state.servers.length;
  const online = state.servers.filter((s) => s.online);
  const rx = online.reduce((sum, s) => sum + numOf(s.stats.net && s.stats.net.rx_rate), 0);
  const tx = online.reduce((sum, s) => sum + numOf(s.stats.net && s.stats.net.tx_rate), 0);
  const rxTotal = state.servers.reduce((sum, s) => sum + numOf(s.stats.net && s.stats.net.rx_total), 0);
  const txTotal = state.servers.reduce((sum, s) => sum + numOf(s.stats.net && s.stats.net.tx_total), 0);
  const regions = new Set(state.servers.map((s) => String(s.region || '').trim()).filter(Boolean));

  el.statOnline.textContent = `${online.length} / ${total}`;
  el.statRegion.textContent = regions.size ? String(regions.size) : '—';
  el.statTraffic.textContent = total ? `↑ ${fmtBytes(txTotal)} ↓ ${fmtBytes(rxTotal)}` : '—';
  el.statNet.textContent = online.length ? `↑ ${fmtRate(tx)} ↓ ${fmtRate(rx)}` : '—';
  el.countLine.textContent = state.denied
    ? ''
    : `共 ${total} 个服务器，${online.length} 个在线${state.authed && total > 1 ? ' · 拖动卡片可排序' : ''}`;
}

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  el.statClock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const setText = (node, field, value) => {
  const n = node.querySelector(`[data-f="${field}"]`);
  if (n) n.textContent = value;
};

/** 内存 / 磁盘这种「百分比 + 进度条 + 明细」的整组 */
function setGroup(node, key, pct, text, sub, visible) {
  const group = node.querySelector(`[data-row="${key}"]`);
  if (!group) return;
  group.classList.toggle('zero', !visible);
  if (!visible) return;
  const bar = group.querySelector(`[data-f="${key}.bar"]`);
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  if (bar) {
    bar.style.width = `${Math.max(v, 1.2)}%`;
    bar.className = `lv-${level(v)}`;
  }
  setText(node, `${key}.val`, text);
  setText(node, `${key}.sub`, sub);
}

const shortOs = (server, on) => {
  const raw = String(server.os || '');
  if (!raw) return on ? '—' : '等待首次上报';
  const short = raw.replace(/\s*GNU\/Linux.*/i, '').replace(/\s*\(.*\)\s*$/, '').trim() || raw;
  return [short, server.arch].filter(Boolean).join(' / ').slice(0, 30);
};

function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d} 天 ${h} 时 ${m} 分 ${ss} 秒`;
  if (h > 0) return `${h} 时 ${m} 分 ${ss} 秒`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}

/** 卡片标题下面的价格 / 到期徽章（游客拿不到这些字段，自然为空） */
function cardTags(server) {
  const parts = [];
  const price = Number(server.price) || 0;
  if (price > 0) {
    const cycle = Number(server.renew_cycle) || 30;
    const unit = cycle >= 365 ? '年' : cycle >= 90 ? '季' : '月';
    parts.push(`<span class="tag-price">$${price}/${unit}</span>`);
  }
  if (Number(server.expires_at) > 0) {
    const days = Math.ceil((Number(server.expires_at) - Date.now() / 1000) / 86400);
    if (days < 0) {
      parts.push(`<span class="tag-exp over">已过期 ${-days} 天</span>`);
    } else if (days <= 30) {
      parts.push(`<span class="tag-exp">余 ${days} 天</span>`);
    } else if (server.auto_renew) {
      parts.push('<span class="tag-exp long">长期</span>');
    } else {
      parts.push(`<span class="tag-note">${fmtDay(server.expires_at)} 到期</span>`);
    }
  }
  if (server.note) parts.push(`<span class="tag-note">${esc(server.note)}</span>`);
  return parts.join('');
}

function buildCard(server) {
  const node = document.createElement('article');
  node.className = 'card';
  node.dataset.id = server.id;
  node.innerHTML = `
    <div class="card-head">
      <span class="region" data-f="region"></span>
      <h2 data-f="name"></h2>
      <span class="pill" data-f="pill">在线</span>
    </div>
    <div class="card-tags" data-f="tags"></div>
    <div class="rows">
      <div class="row"><span class="k">OS</span><span class="v" data-f="os">—</span></div>
      <div class="row"><span class="k">CPU</span><span class="v" data-f="cpu">—</span></div>
      <div class="row-group" data-row="mem">
        <div class="row"><span class="k">内存</span><span class="v" data-f="mem.val">—</span></div>
        <div class="bar"><s data-f="mem.bar"></s></div>
        <div class="sub" data-f="mem.sub">—</div>
      </div>
      <div class="row-group" data-row="disk">
        <div class="row"><span class="k">磁盘</span><span class="v" data-f="disk.val">—</span></div>
        <div class="bar"><s data-f="disk.bar"></s></div>
        <div class="sub" data-f="disk.sub">—</div>
      </div>
      <div class="row"><span class="k">总流量</span><span class="v" data-f="traffic">—</span></div>
      <div class="row"><span class="k">网络</span><span class="v" data-f="net">—</span></div>
      <div class="row"><span class="k">运行时间</span><span class="v" data-f="uptime">—</span></div>
    </div>`;

  // 拖动排序（只有登录后才有意义，游客的卡片不可拖）
  node.addEventListener('dragstart', (event) => {
    if (!state.authed || state.query) {
      event.preventDefault();
      return;
    }
    dragId = node.dataset.id;
    state.dragging = true;
    node.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', dragId);
      } catch {
        /* 某些浏览器会拒绝 */
      }
    }
  });
  node.addEventListener('dragend', () => {
    node.classList.remove('dragging');
    state.dragging = false;
    state.dragEndAt = Date.now();
    dragId = null;
  });

  return node;
}

function updateCard(node, server) {
  const stats = server.stats || {};
  const on = !!server.online;
  const mem = stats.mem || {};
  const disk = stats.disk || {};
  const net = stats.net || {};

  node.classList.toggle('offline', !on);
  node.draggable = state.authed;
  setText(node, 'region', String(server.region || ''));
  setText(node, 'name', server.name || '未命名');

  const pill = node.querySelector('[data-f="pill"]');
  if (pill) {
    pill.textContent = on ? '在线' : '离线';
    pill.className = `pill${on ? '' : ' off'}`;
  }

  const tags = node.querySelector('[data-f="tags"]');
  if (tags) {
    const html = cardTags(server);
    tags.innerHTML = html;
    tags.classList.toggle('hidden', !html);
  }

  setText(node, 'os', shortOs(server, on));
  setText(node, 'cpu', on ? fmtPct(stats.cpu) : '—');
  setGroup(
    node,
    'mem',
    on ? mem.pct : 0,
    on ? fmtPct(mem.pct) : '—',
    on ? `(${fmtBytes(mem.used)} / ${fmtBytes(mem.total)})` : '(—)',
    true,
  );
  setGroup(
    node,
    'disk',
    on ? disk.pct : 0,
    on ? fmtPct(disk.pct) : '—',
    on ? `(${fmtBytes(disk.used)} / ${fmtBytes(disk.total)})` : '(—)',
    true,
  );
  setText(node, 'traffic', on ? `↑ ${fmtBytes(net.tx_total)} ↓ ${fmtBytes(net.rx_total)}` : '—');
  setText(node, 'net', on ? `↑ ${fmtRate(net.tx_rate)} ↓ ${fmtRate(net.rx_rate)}` : '—');
  setText(node, 'uptime', on ? fmtUptime(stats.uptime) : `离线 · ${fmtAgo(server.last_seen)}`);
}

function syncCards() {
  const q = String(state.query || '').trim().toLowerCase();
  const visible = q
    ? state.servers.filter((s) =>
        [s.name, s.region, s.note, s.os, s.arch, s.hostname]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : state.servers;

  const seen = new Set();
  let index = 0;
  for (const server of visible) {
    seen.add(server.id);
    let node = cards.get(server.id);
    if (!node) {
      node = buildCard(server);
      cards.set(server.id, node);
    }
    updateCard(node, server);
    // 拖动过程中不要重排，否则会打断用户的操作
    if (!state.dragging && el.grid.children[index] !== node) {
      el.grid.insertBefore(node, el.grid.children[index] || null);
    }
    index += 1;
  }
  for (const [id, node] of cards) {
    if (!seen.has(id)) {
      node.remove();
      cards.delete(id);
    }
  }
}

/* -------------------------------------------------------------------- 图表 */

let chartUid = 0;

function chartCard(title, seriesList, opts = {}) {
  const { fixedMax = null, current = '', axisFmt = (v) => fmtPct(v) } = opts;
  const w = 560;
  const h = 84;
  const uid = (chartUid += 1);

  const allValues = seriesList.flatMap((s) => s.points.map((p) => p.v));
  const max = fixedMax != null ? fixedMax : niceMax(allValues.length ? Math.max(...allValues) : 0);

  const firstTs = seriesList[0] && seriesList[0].points.length ? seriesList[0].points[0].t : 0;
  const lastTs = seriesList[0] && seriesList[0].points.length
    ? seriesList[0].points[seriesList[0].points.length - 1].t
    : 0;
  const withDate = state.range > 86400;

  const gridColor = state.theme === 'dark' ? '#1d242e' : '#eef0f4';
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<line x1="0" y1="${(h - f * h).toFixed(1)}" x2="${w}" y2="${(h - f * h).toFixed(1)}" stroke="${gridColor}" stroke-width="1" vector-effect="non-scaling-stroke"/>`)
    .join('');

  const paths = seriesList
    .map((s, si) => {
      if (s.points.length < 2) return '';
      const d = s.points
        .map((p, i) => {
          const x = (i / (s.points.length - 1)) * w;
          const y = h - (Math.max(0, Math.min(p.v, max)) / (max || 1)) * h;
          return `${i ? 'L' : 'M'}${x.toFixed(1)},${Math.max(0.5, Math.min(h - 0.5, y)).toFixed(1)}`;
        })
        .join('');
      return `<path d="${d}L${w},${h}L0,${h}Z" fill="url(#cg${uid}-${si})" opacity=".75"/>
              <path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join('');

  const defs = seriesList
    .map((s, si) => `<linearGradient id="cg${uid}-${si}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${s.color}" stop-opacity=".26"/>
        <stop offset="1" stop-color="${s.color}" stop-opacity="0"/>
      </linearGradient>`)
    .join('');

  const empty = allValues.length < 2
    ? `<text x="${w / 2}" y="${h / 2 + 4}" fill="${state.theme === 'dark' ? '#5b6a80' : '#9aa3af'}" font-size="12" text-anchor="middle">暂无历史数据</text>`
    : '';

  return `<div class="chart">
    <div class="chart-head"><span>${esc(title)}</span><b>${current}</b></div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>${defs}</defs>${grid}${paths}${empty}
    </svg>
    <div class="chart-foot">
      <span>${firstTs ? hhmm(firstTs, withDate) : '—'}</span>
      <span>峰值 ${axisFmt(max)}</span>
      <span>${lastTs ? hhmm(lastTs, withDate) : '—'}</span>
    </div>
  </div>`;
}

/* -------------------------------------------------------------------- 详情 */

function openDetail(id) {
  state.detailId = id;
  el.detail.classList.remove('hidden');
  renderDetail();
}

function closeDetail() {
  state.detailId = null;
  el.detail.classList.add('hidden');
}

const kv = (label, value) => `<div><span>${esc(label)}</span><b title="${esc(value)}">${esc(value)}</b></div>`;

const fmtDay = (ts) => (ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : '—');

function billBlock(server) {
  const cycle = Number(server.renew_cycle) || 30;
  const opts = [[30, '月付'], [90, '季付'], [365, '年付']];
  if (!opts.some(([d]) => d === cycle)) opts.push([cycle, `${cycle} 天`]);
  return `
    <div class="bill admin-only">
      <div class="bill-head">地区与计费</div>
      <div class="bill-row">
        <label>地区<input type="text" data-bill="region" maxlength="16" placeholder="🇭🇰" value="${esc(server.region || '')}"></label>
        <label>到期日<input type="date" data-bill="expires_at" value="${fmtDay(server.expires_at) === '—' ? '' : fmtDay(server.expires_at)}"></label>
        <label>周期<select data-bill="renew_cycle">
          ${opts.map(([d, label]) => `<option value="${d}" ${d === cycle ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label>
        <label class="chk"><input type="checkbox" data-bill="auto_renew" ${server.auto_renew ? 'checked' : ''}> 循环计费</label>
        <label>价格<input type="number" step="0.01" min="0" data-bill="price" value="${Number(server.price) || 0}"></label>
        <button class="btn" data-act="save-bill">保存</button>
      </div>
      <p class="hint">开启「循环计费」后，到期日会自动往后顺延并推送一条续费通知；关闭则在到期前按设置的天数提醒。</p>
    </div>`;
}

function renderDetail() {
  const server = state.servers.find((s) => s.id === state.detailId);
  if (!server) {
    closeDetail();
    return;
  }

  // 正在输入时不要重绘，否则会打断编辑（每 5 秒刷新一次）
  const active = document.activeElement;
  if (active && el.detailBody.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;

  const stats = server.stats || {};
  const rows = state.series[server.id] || [];
  const on = !!server.online;
  const net = stats.net || {};
  const keepScroll = el.detailBody.scrollTop;

  const last = (idx) => (rows.length ? rows[rows.length - 1][idx] : 0);
  const cpuNow = on ? fmtPct(stats.cpu) : '离线';
  const netNow = on ? `↓${fmtRate(net.rx_rate)} ↑${fmtRate(net.tx_rate)}` : '离线';

  const tabs = RANGES.map(
    (r) => `<button data-range="${r.seconds}" class="${r.seconds === state.range ? 'on' : ''}">${r.label}</button>`,
  ).join('');

  el.detailBody.innerHTML = `
    <div class="detail-head">
      <span class="dot${on ? ' on' : ''}"></span>
      <div>
        <h2>${esc(server.name)}</h2>
        <div class="host">${esc(server.hostname || '未知主机名')} · ${on ? '在线' : `离线（最后上报 ${fmtAgo(server.last_seen)}）`}</div>
      </div>
      <button class="icon" data-close title="关闭">✕</button>
    </div>

    <div class="kv">
      ${kv('系统', server.os || '—')}
      ${kv('内核', server.kernel || '—')}
      ${kv('架构', server.arch || '—')}
      ${kv('CPU', server.cpu_model ? `${server.cpu_model} × ${server.cpu_cores}` : '—')}
      ${kv('运行时长', on ? fmtDuration(stats.uptime) : '—')}
      ${kv('进程 / 连接', `${stats.procs || 0} / ${stats.tcp || 0}`)}
      ${kv('内存', `${fmtBytes(stats.mem && stats.mem.used)} / ${fmtBytes(stats.mem && stats.mem.total)}`)}
      ${kv('磁盘', `${fmtBytes(stats.disk && stats.disk.used)} / ${fmtBytes(stats.disk && stats.disk.total)}`)}
      ${kv('累计流量', `↓${fmtBytes(net.rx_total)} ↑${fmtBytes(net.tx_total)}`)}
      ${kv('agent', server.agent || '—')}
      ${server.expires_at ? kv('到期', `${fmtDay(server.expires_at)}${server.auto_renew ? ' · 循环计费' : ''}`) : ''}
    </div>

    ${state.authed ? billBlock(server) : ''}

    <div class="tabs">${tabs}</div>

    <div class="charts">
      ${chartCard('CPU 使用率', [{ color: '#4c8dff', points: rows.map((r) => ({ t: r[0], v: r[1] })) }], {
        fixedMax: 100,
        current: cpuNow,
      })}
      ${chartCard('内存使用率', [{ color: '#34d399', points: rows.map((r) => ({ t: r[0], v: r[2] })) }], {
        fixedMax: 100,
        current: on ? fmtPct(stats.mem && stats.mem.pct) : '离线',
      })}
      ${chartCard('磁盘使用率', [{ color: '#fbbf24', points: rows.map((r) => ({ t: r[0], v: r[4] })) }], {
        fixedMax: 100,
        current: on ? fmtPct(stats.disk && stats.disk.pct) : '离线',
      })}
      ${chartCard(
        '网络速率',
        [
          { color: '#38bdf8', points: rows.map((r) => ({ t: r[0], v: r[5] })) },
          { color: '#a78bfa', points: rows.map((r) => ({ t: r[0], v: r[6] })) },
        ],
        { current: netNow, axisFmt: (v) => fmtRate(v) },
      )}
    </div>

    <div class="detail-foot admin-only">
      <button class="btn ghost danger" data-act="delete">删除</button>
      <button class="btn ghost" data-act="rotate">重置密钥</button>
      <button class="btn" data-act="rename">重命名</button>
    </div>`;

  el.detailBody.scrollTop = keepScroll;
}

/* ---------------------------------------------------------- 添加 / 管理动作 */

function openAddModal() {
  if (!state.authed) {
    showLogin();
    return;
  }
  el.addTitle.textContent = '添加服务器';
  el.addForm.classList.remove('hidden');
  el.addResult.classList.add('hidden');
  el.addResult.innerHTML = '';
  el.addSubmit.classList.remove('hidden');
  el.addSubmit.disabled = false;
  el.addName.value = '';
  el.addNote.value = '';
  if (el.addRegion) el.addRegion.value = '';
  el.addName.disabled = false;
  el.addNote.disabled = false;
  if (el.addRegion) el.addRegion.disabled = false;
  el.addActions.querySelector('[data-close]').textContent = '取消';
  el.addModal.classList.remove('hidden');
  setTimeout(() => el.addName.focus(), 60);
}

function showInstall(server) {
  const base = location.origin;
  const command = `curl -fsSL ${base}/agent/install.sh | sudo sh -s -- --url ${base} --token ${server.token} --interval 30`;
  el.addTitle.textContent = `已就绪：${server.name}`;
  el.addForm.classList.add('hidden');
  el.addSubmit.classList.add('hidden');
  el.addActions.querySelector('[data-close]').textContent = '完成';
  el.addResult.classList.remove('hidden');
  el.addResult.innerHTML = `
    <div class="install">
      <h3>1. 在服务器上以 root 执行</h3>
      <div class="code"><span class="code-text">${esc(command)}</span><button class="copy">复制</button></div>
      <h3>2. 密钥（只显示这一次）</h3>
      <div class="code"><span class="code-text token">${esc(server.token)}</span><button class="copy">复制</button></div>
      <p class="hint">脚本会安装 <code>/usr/local/bin/cfmon-agent</code> 并注册 systemd 服务 <code>cfmon-agent</code>；
      查看日志：<code>journalctl -u cfmon-agent -f</code></p>
    </div>`;
}

async function submitCreate() {
  const name = el.addName.value.trim();
  if (!name) {
    el.addName.focus();
    toast('请填写名称', true);
    return;
  }
  el.addSubmit.disabled = true;
  try {
    const created = await api('/api/servers', {
      method: 'POST',
      body: {
        name,
        note: el.addNote.value.trim(),
        region: el.addRegion ? el.addRegion.value.trim() : '',
      },
    });
    showInstall(created);
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    toast(error.message, true);
  } finally {
    el.addSubmit.disabled = false;
  }
}

async function renameServer(server) {
  const name = window.prompt('新的名称', server.name);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === server.name) return;
  try {
    await api(`/api/servers/${server.id}`, { method: 'PATCH', body: { name: trimmed } });
    toast('已重命名');
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    toast(error.message, true);
  }
}

async function rotateToken(server) {
  if (!window.confirm(`重置「${server.name}」的密钥？旧密钥会立刻失效，需要重新在服务器上执行安装命令。`)) return;
  try {
    const data = await api(`/api/servers/${server.id}/token`, { method: 'POST' });
    el.addModal.classList.remove('hidden');
    showInstall({ name: server.name, token: data.token });
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    toast(error.message, true);
  }
}

async function deleteServer(server) {
  if (!window.confirm(`删除「${server.name}」？历史数据会一并删除，且不可恢复。`)) return;
  try {
    await api(`/api/servers/${server.id}`, { method: 'DELETE' });
    toast('已删除');
    closeDetail();
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    toast(error.message, true);
  }
}

/* -------------------------------------------------------------- 通知设置 */

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function openSettings() {
  if (!state.authed) {
    showLogin();
    return;
  }
  el.settingsModal.classList.remove('hidden');
  loadSettings();
}

async function loadSettings() {
  try {
    const cfg = await api('/api/settings');
    el.setTgToken.value = cfg.tg_token || '';
    el.setTgToken.placeholder = cfg.tg_token_set ? '已设置（留空表示不修改）' : '123456789:AA...';
    el.setTgChat.value = cfg.tg_chat || '';
    el.setCpuOn.checked = !!cfg.cpu_enabled;
    el.setCpuPct.value = cfg.cpu_pct;
    el.setCpuMin.value = cfg.cpu_minutes;
    el.setMemOn.checked = !!cfg.mem_enabled;
    el.setMemPct.value = cfg.mem_pct;
    el.setMemMin.value = cfg.mem_minutes;
    el.setNetOn.checked = !!cfg.net_enabled;
    el.setNetMbps.value = cfg.net_mbps;
    el.setNetMin.value = cfg.net_minutes;
    el.setOfflineOn.checked = !!cfg.offline_enabled;
    el.setOfflineMin.value = cfg.offline_minutes;
    el.setCooldown.value = cfg.cooldown_minutes;
    el.setBillingDays.value = cfg.billing_days;
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    toast(error.message, true);
  }
}

async function saveSettings(silent) {
  const body = {
    tg_token: el.setTgToken.value.trim(),
    tg_chat: el.setTgChat.value.trim(),
    cpu_enabled: el.setCpuOn.checked,
    cpu_pct: numOr(el.setCpuPct.value, 85),
    cpu_minutes: numOr(el.setCpuMin.value, 10),
    mem_enabled: el.setMemOn.checked,
    mem_pct: numOr(el.setMemPct.value, 90),
    mem_minutes: numOr(el.setMemMin.value, 10),
    net_enabled: el.setNetOn.checked,
    net_mbps: numOr(el.setNetMbps.value, 20),
    net_minutes: numOr(el.setNetMin.value, 10),
    offline_enabled: el.setOfflineOn.checked,
    offline_minutes: numOr(el.setOfflineMin.value, 5),
    cooldown_minutes: numOr(el.setCooldown.value, 60),
    billing_days: el.setBillingDays.value.trim(),
  };
  try {
    await api('/api/settings', { method: 'PUT', body });
    if (!silent) toast('已保存');
    return true;
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return false;
    }
    toast(error.message, true);
    return false;
  }
}

async function testTelegram() {
  const saved = await saveSettings(true);
  if (!saved) return;
  try {
    await api('/api/settings/test', { method: 'POST' });
    toast('测试消息已发送，去 Telegram 看看');
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    toast(`发送失败：${error.message}`, true);
  }
}

async function saveBilling(server) {
  const pick = (name) => el.detailBody.querySelector(`[data-bill="${name}"]`);
  const exp = pick('expires_at');
  const cycle = pick('renew_cycle');
  const auto = pick('auto_renew');
  const price = pick('price');
  const region = pick('region');
  if (!exp || !cycle || !auto || !price) return;

  try {
    await api(`/api/servers/${server.id}`, {
      method: 'PATCH',
      body: {
        expires_at: exp.value || '',
        renew_cycle: numOr(cycle.value, 30),
        auto_renew: auto.checked ? 1 : 0,
        price: numOr(price.value, 0),
        region: region ? region.value.trim() : '',
      },
    });
    toast('已保存');
    await refresh(true);
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    toast(error.message, true);
  }
}

/* -------------------------------------------------------------------- 事件 */

/* -------------------------------------------------------------- 拖动排序 */

async function persistOrder() {
  const ids = Array.from(el.grid.querySelectorAll('.card')).map((n) => n.dataset.id);
  if (!ids.length) return;

  // 先按新顺序更新本地状态，避免下一轮轮询把卡片跳回旧位置
  const rank = new Map(ids.map((id, i) => [id, i]));
  state.servers.sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));

  try {
    await api('/api/servers/reorder', { method: 'POST', body: { ids } });
    toast('顺序已保存');
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    toast(error.message, true);
  }
}

el.grid.addEventListener('click', (event) => {
  if (Date.now() - state.dragEndAt < 250) return; // 刚拖完，别当成点击
  const node = event.target.closest('.card');
  if (node) openDetail(node.dataset.id);
});

el.grid.addEventListener('dragover', (event) => {
  if (!dragId || !state.authed) return;
  event.preventDefault();
  const target = event.target.closest('.card');
  if (!target || target.dataset.id === dragId) return;
  const dragged = cards.get(dragId);
  if (!dragged || dragged === target) return;

  // 落在目标卡片左半边就插到它前面，右半边插到它后面
  const rect = target.getBoundingClientRect();
  const before = event.clientX < rect.left + rect.width / 2;
  el.grid.insertBefore(dragged, before ? target : target.nextSibling);
});

el.grid.addEventListener('drop', async (event) => {
  if (!dragId) return;
  event.preventDefault();
  await persistOrder();
});

el.detailBody.addEventListener('click', (event) => {
  const rangeBtn = event.target.closest('[data-range]');
  if (rangeBtn) {
    state.range = Number(rangeBtn.dataset.range);
    refresh(true);
    return;
  }
  const action = event.target.closest('[data-act]');
  if (!action) return;
  const server = state.servers.find((s) => s.id === state.detailId);
  if (!server) return;
  if (action.dataset.act === 'rename') renameServer(server);
  if (action.dataset.act === 'rotate') rotateToken(server);
  if (action.dataset.act === 'delete') deleteServer(server);
  if (action.dataset.act === 'save-bill') saveBilling(server);
});

document.addEventListener('click', async (event) => {
  const closer = event.target.closest('[data-close]');
  if (closer) {
    const modal = closer.closest('.modal');
    if (modal) modal.classList.add('hidden');
    if (modal === el.detail) state.detailId = null;
    return;
  }
  const copyBtn = event.target.closest('.copy');
  if (copyBtn) {
    const holder = copyBtn.parentElement.querySelector('.code-text');
    const text = holder ? holder.textContent : '';
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
    } catch {
      toast('复制失败，请手动选中复制', true);
    }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!el.detail.classList.contains('hidden')) closeDetail();
  el.addModal.classList.add('hidden');
  el.settingsModal.classList.add('hidden');
});

$('#btn-add').addEventListener('click', openAddModal);
$('#btn-login').addEventListener('click', showLogin);
$('#btn-login2').addEventListener('click', showLogin);
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-set-save').addEventListener('click', () => saveSettings(false));
$('#btn-tg-test').addEventListener('click', testTelegram);
el.btnTheme.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('cfmon-theme', state.theme);
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  applyTheme();
  render();
});
el.search.addEventListener('input', () => {
  state.query = el.search.value;
  syncCards();
  renderStats();
});
el.addSubmit.addEventListener('click', submitCreate);
el.addName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitCreate();
});
$('#btn-logout').addEventListener('click', async () => {
  try {
    await request('/api/logout', { method: 'POST' });
  } catch {
    /* 忽略 */
  }
  state.authed = false;
  applyMode();
  showLogin();
  toast('已退出登录');
});

/* -------------------------------------------------------------------- 启动 */

(async function boot() {
  try {
    const me = await request('/api/me');
    state.authed = !!me.authed;
    state.publicView = me.public !== false;
    state.needsSetup = !!me.needsSetup;
  } catch {
    // 接口异常时按游客处理，至少让页面能打开
    state.authed = false;
    state.publicView = true;
    state.needsSetup = false;
  }
  applyMode();
  try {
    state.theme = localStorage.getItem('cfmon-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    state.theme = 'light';
  }
  applyTheme();
  tickClock();
  setInterval(tickClock, 1000);

  if (state.needsSetup) {
    showSetup();
    return;
  }
  // 默认永远先显示状态视图；登录框只在用户点「登录」时出现
  await enterPanel();
})();
