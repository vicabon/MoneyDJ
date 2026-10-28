'use strict';

/* ============================================================
 * 股價三源交叉比對
 *  - 美股：CNBC、鉅亨網 cnyes、FinMind（選配 Yahoo，需自備 CORS proxy）
 *  - 台股：臺灣證交所 TWSE、鉅亨網 cnyes、FinMind
 * 所有來源都在瀏覽器端直接呼叫（皆回傳 Access-Control-Allow-Origin: *），
 * 因此可直接放在 GitHub Pages 上使用。
 *
 * 價格空間：
 *   raw = 未還原分割的實際成交價；adj = 分割調整後價格（不含股息）
 *   raw = adj × factor(date)，factor 為該日之後所有分割比例的乘積
 *   比對在 raw 空間進行；走勢圖使用 adj。
 * ============================================================ */

const $ = (s) => document.querySelector(s);
const MAX_SYMBOLS = 8;
const DAY = 86400000;

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTW = (sym) => /^\d{4,6}[A-Z]?$/.test(sym);
const ymd = (d) => d.toISOString().slice(0, 10);
const toUnix = (dateStr) => Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000);
const num = (v) => {
  if (v === null || v === undefined) return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const roundTo = (v, dec) => {
  const p = 10 ** dec;
  return Math.round((v + Math.sign(v) * Number.EPSILON * Math.abs(v)) * p) / p;
};
const fmt = (v, dec) => (Number.isFinite(v) ? v.toFixed(dec) : '—');

async function fetchJSON(url, { timeout = 25000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('逾時');
    if (e instanceof TypeError) throw new Error('連線失敗或被 CORS 擋下');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// 將 bars 陣列限定在 [start, end] 並依日期排序、去重
function clip(bars, start, end) {
  const m = new Map();
  for (const b of bars) {
    if (b.date >= start && b.date <= end && Number.isFinite(b.c)) m.set(b.date, b);
  }
  return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ---------- 快取（已結束月份的 TWSE 資料不會再變動） ----------
const cache = {
  get(k) {
    try { return JSON.parse(localStorage.getItem('px:' + k)); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem('px:' + k, JSON.stringify(v)); } catch { /* 空間不足就算了 */ }
  },
};

/* ============================================================
 * 資料來源
 * 每個來源：{ id, name, kind: 'raw'|'adj', fetch(sym, start, end, ctx) => bars[] }
 * bar = { date:'YYYY-MM-DD', o, h, l, c }
 * ============================================================ */

const CNBC = {
  id: 'cnbc', name: 'CNBC', kind: 'raw',
  url(sym, start, end, mode) {
    const s = start.replace(/-/g, '');
    const e = ymd(new Date(Date.parse(end) + DAY)).replace(/-/g, ''); // 結束日為不含
    return `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/1D/${s}000000/${e}000000/${mode}/EST5EDT.json`;
  },
  parse(j) {
    const bars = j?.barData?.priceBars;
    if (!Array.isArray(bars)) throw new Error('回應格式不符');
    return bars.map((b) => ({
      date: `${b.tradeTime.slice(0, 4)}-${b.tradeTime.slice(4, 6)}-${b.tradeTime.slice(6, 8)}`,
      o: num(b.open), h: num(b.high), l: num(b.low), c: num(b.close),
    }));
  },
  async fetch(sym, start, end) {
    return clip(this.parse(await fetchJSON(this.url(sym, start, end, 'unadjusted'))), start, end);
  },
};

const CNYES = {
  id: 'cnyes', name: '鉅亨網', kind: 'raw',
  async fetch(sym, start, end) {
    // 美股要用 :STOCK；:ETF 格式在部分期間會把 QQQ/QLD/TQQQ 的資料混在一起回傳
    const symbol = isTW(sym) ? `TWS:${sym}:STOCK` : `USS:${sym}:STOCK`;
    // cnyes 單次回傳筆數有上限，分段（每段約 2 年）抓取；注意 from=較新、to=較舊
    const out = [];
    let segEnd = toUnix(end) + 86399;
    const stop = toUnix(start);
    while (segEnd >= stop) {
      const segStart = Math.max(stop, segEnd - 730 * 86400);
      const j = await fetchJSON(
        `https://ws.api.cnyes.com/ws/api/v1/charting/history?resolution=D&symbol=${encodeURIComponent(symbol)}&from=${segEnd}&to=${segStart}`);
      const d = j?.data;
      if (!d || !Array.isArray(d.t)) throw new Error('回應格式不符');
      // 防呆：同一日期出現多筆代表資料混入了別檔標的
      if (new Set(d.t).size !== d.t.length) throw new Error('回傳資料異常（日期重複）');
      for (let i = 0; i < d.t.length; i++) {
        out.push({ date: ymd(new Date(d.t[i] * 1000)), o: num(d.o[i]), h: num(d.h[i]), l: num(d.l[i]), c: num(d.c[i]) });
      }
      segEnd = segStart - 1;
    }
    return clip(out, start, end);
  },
};

const FINMIND = {
  id: 'finmind', name: 'FinMind', kind: 'raw', // 台股為原始價；美股為分割調整價（於 fetch 中設定 kind）
  base: 'https://api.finmindtrade.com/api/v4/data',
  q(params, ctx) {
    const p = new URLSearchParams(params);
    if (ctx?.token) p.set('token', ctx.token);
    return `${this.base}?${p}`;
  },
  async fetch(sym, start, end, ctx) {
    const tw = isTW(sym);
    const j = await fetchJSON(this.q({
      dataset: tw ? 'TaiwanStockPrice' : 'USStockPrice', data_id: sym, start_date: start, end_date: end,
    }, ctx));
    if (j.status !== 200 || !Array.isArray(j.data)) throw new Error(j.msg || '回應格式不符');
    return clip(j.data.map((r) => tw
      ? { date: r.date, o: num(r.open), h: num(r.max), l: num(r.min), c: num(r.close) }
      : { date: r.date, o: num(r.Open), h: num(r.High), l: num(r.Low), c: num(r.Close) }), start, end);
  },
  kindFor: (sym) => (isTW(sym) ? 'raw' : 'adj'),
};

// TWSE 證交所：一次一個月，且有頻率限制 → 全域排隊 + 快取已結束的月份
let twseLast = 0;
const TWSE = {
  id: 'twse', name: '證交所', kind: 'raw',
  async month(sym, yyyymm) {
    const key = `twse:${sym}:${yyyymm}`;
    const now = new Date();
    const curYM = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const hit = cache.get(key);
    if (hit) return hit;
    // 證交所約每 5 秒 3 次的頻率限制，超過會被暫時封鎖（回 307），因此放慢並重試
    let j;
    for (let attempt = 0; ; attempt++) {
      const wait = twseLast + 2100 - Date.now();
      if (wait > 0) await sleep(wait);
      twseLast = Date.now();
      try {
        j = await fetchJSON(
          `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${yyyymm}01&stockNo=${encodeURIComponent(sym)}&response=json`);
        break;
      } catch (e) {
        if (attempt >= 3) throw new Error(`${yyyymm.slice(0, 4)}/${yyyymm.slice(4)} ${e.message}（可能觸發證交所流量限制，請稍後再試）`);
        twseLast = Date.now() + 5000 * (attempt + 1);
      }
    }
    let rows = [];
    if (j.stat === 'OK' && Array.isArray(j.data)) {
      const f = j.fields || [];
      const ix = (name, d) => (f.indexOf(name) >= 0 ? f.indexOf(name) : d);
      const [iD, iO, iH, iL, iC] = [ix('日期', 0), ix('開盤價', 3), ix('最高價', 4), ix('最低價', 5), ix('收盤價', 6)];
      rows = j.data.map((r) => {
        const [y, m, d] = String(r[iD]).trim().split('/');
        return {
          date: `${+y + 1911}-${m}-${d}`,
          o: num(r[iO]), h: num(r[iH]), l: num(r[iL]), c: num(r[iC]),
        };
      }).filter((b) => Number.isFinite(b.c));
    } else if (!/沒有符合/.test(j.stat || '')) {
      throw new Error(j.stat || '回應格式不符');
    }
    if (yyyymm < curYM) cache.set(key, rows);
    return rows;
  },
  async fetch(sym, start, end, ctx) {
    const months = [];
    let y = +start.slice(0, 4), m = +start.slice(5, 7);
    const ey = +end.slice(0, 4), em = +end.slice(5, 7);
    while (y < ey || (y === ey && m <= em)) {
      months.push(`${y}${String(m).padStart(2, '0')}`);
      if (++m > 12) { m = 1; y++; }
    }
    const out = [];
    for (let i = 0; i < months.length; i++) {
      ctx?.progress?.(`${sym} 證交所 ${i + 1}/${months.length} 月`);
      out.push(...(await this.month(sym, months[i])));
    }
    return clip(out, start, end);
  },
};

// Yahoo（選配）：Yahoo 未開放 CORS，需使用者自備 proxy。close 為分割調整價。
const YAHOO = {
  id: 'yahoo', name: 'Yahoo', kind: 'adj',
  async fetch(sym, start, end, ctx) {
    const tries = isTW(sym) ? [`${sym}.TW`, `${sym}.TWO`] : [sym];
    for (const ys of tries) {
      const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}` +
        `?period1=${toUnix(start)}&period2=${toUnix(end) + 86400}&interval=1d&events=split`;
      const url = ctx.yProxy.includes('{url}')
        ? ctx.yProxy.replace('{url}', encodeURIComponent(target))
        : ctx.yProxy + encodeURIComponent(target);
      const j = await fetchJSON(url);
      const r = j?.chart?.result?.[0];
      if (!r?.timestamp) continue;
      const q = r.indicators.quote[0];
      const off = r.meta?.gmtoffset || 0;
      return clip(r.timestamp.map((t, i) => ({
        date: ymd(new Date((t + off) * 1000)), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i],
      })).filter((b) => b.c != null), start, end);
    }
    throw new Error('查無資料');
  },
};

/* ============================================================
 * 分割比例
 * ============================================================ */

// 把比例吸附到「簡單分數」（如 4、22、1/10、3/2），避免把真正的報價差異吸收掉
function snapRatio(r) {
  if (!Number.isFinite(r) || r <= 0) return null;
  if (Math.abs(r - 1) < 0.01) return 1;
  for (const [x, inv] of [[r, false], [1 / r, true]]) {
    for (let q = 1; q <= 5; q++) {
      const p = Math.round(x * q);
      if (p > 0 && Math.abs(x - p / q) / x < 0.006) return inv ? q / p : p / q;
    }
  }
  return null;
}

let twSplitsPromise = null;
function loadTwSplits(ctx) {
  if (!twSplitsPromise) {
    twSplitsPromise = fetchJSON(FINMIND.q({ dataset: 'TaiwanStockSplitPrice', start_date: '2000-01-01' }, ctx))
      .then((j) => {
        if (j.status !== 200 || !Array.isArray(j.data)) throw new Error(j.msg || '格式不符');
        return j.data;
      })
      .catch((e) => { twSplitsPromise = null; throw e; });
  }
  return twSplitsPromise;
}

// 由「分割事件清單」建立 factor(date)
function factorFromEvents(events) {
  // events: [{date, ratio}]，ratio = 分割前價 / 分割後價
  const ev = events.filter((e) => e.ratio && e.ratio !== 1).sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    events: ev,
    at(date) {
      let f = 1;
      for (const e of ev) if (date < e.date) f *= e.ratio;
      return f;
    },
  };
}

// 美股：原始價（CNBC/cnyes）相鄰兩日的變動，除以調整價（FinMind）同兩日的變動；
// 若結果為簡單分數且 ≠ 1，代表當天發生分割。只看「事件」，不逐日套用，比對才不會循環論證。
function eventsFromPair(rawBars, adjBars) {
  const adj = new Map(adjBars.map((b) => [b.date, b.c]));
  const events = [];
  for (let i = 1; i < rawBars.length; i++) {
    const a0 = adj.get(rawBars[i - 1].date), a1 = adj.get(rawBars[i].date);
    if (!a0 || !a1) continue;
    const r = (rawBars[i - 1].c / rawBars[i].c) / (a0 / a1);
    if (r > 1.25 || r < 0.8) {
      const s = snapRatio(r);
      if (s && s !== 1) events.push({ date: rawBars[i].date, ratio: s });
    }
  }
  return events;
}

// 備援：從原始價的跳空偵測分割（相鄰兩日收盤比為簡單分數且變動 ≥ 1.8 倍）
function eventsFromJumps(rawBars) {
  const events = [];
  for (let i = 1; i < rawBars.length; i++) {
    const r = rawBars[i - 1].c / rawBars[i].c;
    if (r >= 1.8 || r <= 1 / 1.8) {
      const s = snapRatio(r) || snapRatio(Math.round(r * 10) / 10);
      if (s && s !== 1) events.push({ date: rawBars[i].date, ratio: s });
    }
  }
  return events;
}

/* ============================================================
 * 抓取 + 比對
 * ============================================================ */

function sourcesFor(sym, ctx) {
  const list = isTW(sym) ? [TWSE, CNYES, FINMIND] : [CNBC, CNYES, FINMIND];
  if (ctx.yProxy) list.push(YAHOO);
  return list;
}

async function loadSymbol(sym, start, end, ctx) {
  const tw = isTW(sym);
  const srcs = sourcesFor(sym, ctx);
  const results = await Promise.all(srcs.map(async (s) => {
    try {
      const bars = await s.fetch(sym, start, end, ctx);
      return { id: s.id, name: s.name, kind: s.kindFor ? s.kindFor(sym) : s.kind, bars, err: bars.length ? null : '查無資料' };
    } catch (e) {
      return { id: s.id, name: s.name, kind: s.kindFor ? s.kindFor(sym) : s.kind, bars: [], err: e.message };
    }
  }));

  // ---- 分割比例 ----
  let split = null, splitNote = '';
  const rawRef = results.find((r) => r.kind === 'raw' && r.bars.length);
  if (tw) {
    try {
      const all = await loadTwSplits(ctx);
      split = factorFromEvents(all.filter((e) => e.stock_id === sym)
        .map((e) => ({ date: e.date, ratio: snapRatio(e.before_price / e.after_price) })));
      splitNote = 'FinMind 分割資料';
    } catch { /* 走備援 */ }
  } else {
    const adj = results.find((r) => r.kind === 'adj' && r.bars.length);
    if (adj && rawRef) {
      split = factorFromEvents(eventsFromPair(rawRef.bars, adj.bars));
      splitNote = `${rawRef.name} 原始價 vs ${adj.name} 調整價`;
    }
  }
  if (!split && rawRef) {
    split = factorFromEvents(eventsFromJumps(rawRef.bars));
    splitNote = '依價格跳空推估';
  }
  if (!split) split = factorFromEvents([]);

  return { sym, tw, results, split, splitNote };
}

// 每日收盤價比對：
//   same = 所有來源完全相同
//   avg  = 3 個以上來源有差異，但都在平均值 ±tol% 以內 → 採用平均值
//   warn = 差異超過 ±tol%，或只有 2 個來源且不相同 → 警示
//   miss = 有來源缺漏，但現有來源相同（或只剩 1 個來源）
function compare(data, opt) {
  const { results, split } = data;
  const live = results.filter((r) => r.bars.length);
  const maps = live.map((r) => new Map(r.bars.map((b) => [b.date, b.c])));
  const dates = [...new Set(live.flatMap((r) => r.bars.map((b) => b.date)))].sort();
  const unit = 0.5 * 10 ** -opt.decimals;
  const tol = opt.tolPct / 100;

  const rows = dates.map((date) => {
    const f = split.at(date);
    const vals = live.map((r, i) => {
      const c = maps[i].get(date);
      if (!Number.isFinite(c)) return null;
      const conv = r.kind === 'adj' && f !== 1;
      return { v: roundTo(r.kind === 'adj' ? c * f : c, opt.decimals), conv };
    });
    const present = vals.filter(Boolean);
    const nums = present.map((x) => x.v);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const sorted = [...nums].sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[sorted.length >> 1]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    // 由調整價換算回原始價的數值，會放大來源本身的四捨五入誤差，「完全相同」的判定因此自動放寬
    const eqAllow = (present.some((x) => x.conv) ? unit * f : 0) + 1e-9;
    const spread = Math.max(...nums) - Math.min(...nums);
    const devPct = Math.max(...nums.map((v) => Math.abs(v / mean - 1))) * 100;
    const row = { date, factor: f, vals, devPct, outliers: new Set() };

    if (spread <= eqAllow) {
      row.status = present.length < live.length ? 'miss' : 'same';
      row.price = nums[0];
    } else if (present.length >= 3 && devPct <= opt.tolPct + 1e-9) {
      row.status = 'avg';
      row.price = mean;
    } else {
      row.status = 'warn';
      row.price = median; // 警示日走勢圖暫用中位數
      if (present.length >= 3) {
        vals.forEach((x, i) => {
          if (x && Math.abs(x.v / median - 1) > tol) row.outliers.add(live[i].name);
        });
      }
    }
    return row;
  });

  // 走勢圖用：分割調整後的採用收盤價
  const series = rows.map((r) => ({ date: r.date, adj: r.price / r.factor }))
    .filter((p) => Number.isFinite(p.adj));

  const count = (s) => rows.filter((r) => r.status === s).length;
  const bySource = Object.fromEntries(live.map((r) => [r.name, rows.filter((x) => x.outliers.has(r.name)).length]));
  return {
    ...data, live, rows, series, bySource,
    same: count('same'), avg: count('avg'), warn: count('warn'), miss: count('miss'),
  };
}

/* ============================================================
 * UI
 * ============================================================ */

// zoom = { from, to }：目前走勢圖顯示的日期區段（null = 全部）
// markers：使用者設定的縱軸觀察線（日期，已排序）
const state = { analyses: [], chart: null, mode: 'pct', hidden: new Set(), zoom: null, drag: null, markers: [] };
const MAX_MARKERS = 8;
const markerName = (i) => String.fromCharCode(65 + i); // A, B, C…

// 某標的在指定日期的收盤：取該日或之前最近的交易日（該日前無資料則取之後第一筆）
function pointAt(a, date) {
  const ser = a.series;
  let lo = 0, hi = ser.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ser[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) ans = ser.length ? 0 : -1;
  if (ans < 0) return null;
  const p = ser[ans];
  const row = a.rows.find((r) => r.date === p.date);
  return { date: p.date, adj: p.adj, close: row ? row.price : p.adj };
}

function setMarkers(list) {
  state.markers = [...new Set(list)].sort().slice(0, MAX_MARKERS);
  const url = new URL(location.href);
  if (state.markers.length) url.searchParams.set('m', state.markers.join(','));
  else url.searchParams.delete('m');
  history.replaceState(null, '', url);
  if (state.analyses.length) { renderChart(); renderMarkers(); }
}

function toggleMarker(date) {
  if (state.markers.includes(date)) return setMarkers(state.markers.filter((d) => d !== date));
  if (state.markers.length >= MAX_MARKERS) return setStatus(`觀察線最多 ${MAX_MARKERS} 條`, true);
  setMarkers([...state.markers, date]);
}

// 某標的在目前縮放區段內的資料
function visibleSeries(a) {
  const z = state.zoom;
  return z ? a.series.filter((p) => p.date >= z.from && p.date <= z.to) : a.series;
}

function setStatus(msg, isErr) {
  const el = $('#status');
  el.textContent = '';
  const span = document.createElement('span');
  if (isErr) span.className = 'err';
  span.textContent = msg;
  el.appendChild(span);
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

function cssVar(name) {
  return getComputedStyle($('.viz-root')).getPropertyValue(name).trim();
}
// 顏色跟著「標的在輸入清單中的位置」，不因篩選而改變
const colorOf = (idx) => cssVar(`--s${(idx % MAX_SYMBOLS) + 1}`);

function badge(a) {
  if (a.live.length < 2) return el('span', { class: 'badge bad', text: '來源不足，無法比對' });
  if (a.warn) return el('span', { class: 'badge bad', text: ` ${a.warn} 天警示` });
  if (a.miss) return el('span', { class: 'badge warn', text: ` 無警示，但有 ${a.miss} 天來源缺漏` });
  if (a.live.length < 3) return el('span', { class: 'badge warn', text: ` 僅 ${a.live.length} 個來源` });
  return el('span', { class: 'badge ok', text: a.avg ? ` 無警示（${a.avg} 天取平均）` : ` ${a.live.length} 個來源完全相同` });
}

function renderSummary() {
  const t = el('table');
  t.append(el('thead', {}, el('tr', {},
    el('th', { text: '標的' }), el('th', { text: '交易日' }), el('th', { text: '完全相同' }),
    el('th', { text: `±${opts().tolPct}% 內取平均` }), el('th', { text: '警示' }), el('th', { text: '缺漏' }),
    el('th', { text: '疑似錯誤來源（天）' }), el('th', { text: '各來源筆數' }),
    el('th', { text: '分割' }), el('th', { text: '結果' }))));
  const tb = el('tbody');
  for (const a of state.analyses) {
    const srcCell = el('td', { class: 'txt' });
    a.results.forEach((r, i) => {
      if (i) srcCell.append(' · ');
      srcCell.append(`${r.name}${r.kind === 'adj' ? '(調整價)' : ''}: `);
      srcCell.append(r.err ? el('span', { class: 'badge bad', text: ` ${r.err}` }) : `${r.bars.length}`);
    });
    const sp = a.split.events.length
      ? a.split.events.map((e) => `${e.date} 1拆${+e.ratio.toFixed(3)}`).join('、') + `（${a.splitNote}）`
      : `無（${a.splitNote || '—'}）`;
    tb.append(el('tr', {},
      el('td', {}, el('strong', { text: a.sym })),
      el('td', { text: a.rows.length }), el('td', { text: a.same }), el('td', { text: a.avg }),
      el('td', { text: a.warn }), el('td', { text: a.miss }),
      el('td', { class: 'txt', text: Object.entries(a.bySource).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || '—' }),
      srcCell, el('td', { class: 'txt', text: sp }), el('td', {}, badge(a))));
  }
  t.append(tb);
  $('#summary').replaceChildren(t);
  $('#summaryCard').hidden = false;
}

function renderLegend() {
  const box = $('#legend');
  box.replaceChildren();
  state.analyses.forEach((a, idx) => {
    const ser = visibleSeries(a);
    if (!ser.length) return;
    const first = ser[0].adj, last = ser[ser.length - 1].adj;
    const ret = (last / first - 1) * 100;
    const b = el('button', { type: 'button', 'aria-pressed': String(!state.hidden.has(a.sym)) },
      el('span', { class: 'key', style: `background:${colorOf(idx)}` }),
      el('span', { text: a.sym }),
      el('span', { class: 'ret', text: `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%` }));
    if (state.hidden.has(a.sym)) b.classList.add('off');
    b.addEventListener('click', () => {
      state.hidden.has(a.sym) ? state.hidden.delete(a.sym) : state.hidden.add(a.sym);
      renderChart();
    });
    box.append(b);
  });
}

const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const act = chart.tooltip?.getActiveElements?.();
    if (!act?.length || state.drag) return;
    const x = act[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar('--axis');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.restore();
  },
};

// 縱軸觀察線：實線 + 頂端標籤（A、B、C…）
const markerLines = {
  id: 'markerLines',
  afterDatasetsDraw(chart) {
    if (!state.markers.length) return;
    const labels = chart.data.labels;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    const ink = cssVar('--text-secondary'), surf = cssVar('--surface-1');
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    state.markers.forEach((d, i) => {
      if (!labels.length || d < labels[0] || d > labels[labels.length - 1]) return;
      let idx = labels.findIndex((l) => l >= d);
      if (labels[idx] > d && idx > 0) idx -= 1; // 非交易日 → 前一個交易日
      const x = chart.scales.x.getPixelForValue(idx);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      const name = markerName(i);
      ctx.fillStyle = ink;
      ctx.beginPath(); ctx.roundRect(x - 9, top - 18, 18, 16, 4); ctx.fill();
      ctx.fillStyle = surf;
      ctx.fillText(name, x, top - 10);
    });
    ctx.restore();
  },
};

// 拖曳選取區段時畫出半透明的選取框
const dragBox = {
  id: 'dragBox',
  // 拖曳中不處理 Chart.js 自己的 hover 事件
  beforeEvent: () => (state.drag ? false : undefined),
  afterDraw(chart) {
    const d = state.drag;
    if (!d || Math.abs(d.x1 - d.x0) < 2) return;
    const { top, bottom, left, right } = chart.chartArea;
    const x0 = Math.max(left, Math.min(d.x0, d.x1)), x1 = Math.min(right, Math.max(d.x0, d.x1));
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = cssVar('--accent');
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x0, top, x1 - x0, bottom - top);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, top + 0.5, x1 - x0 - 1, bottom - top - 1);
    ctx.restore();
  },
};

// 滑鼠 / 觸控左右拖曳：選取區段放大；雙擊或「重設縮放」還原
function initChartZoom() {
  const cv = $('#chart');
  const idxAt = (x) => {
    const c = state.chart;
    const { left, right } = c.chartArea;
    return Math.round(c.scales.x.getValueForPixel(Math.max(left, Math.min(right, x))));
  };
  const px = (e) => e.clientX - cv.getBoundingClientRect().left;
  cv.addEventListener('pointerdown', (e) => {
    const c = state.chart;
    if (!c || e.button !== 0) return;
    const x = px(e);
    if (x < c.chartArea.left || x > c.chartArea.right) return;
    state.drag = { x0: x, x1: x };
    cv.setPointerCapture(e.pointerId);
    c.setActiveElements([]); // 拖曳時隱藏提示框與 hover 點
    c.tooltip.setActiveElements([], { x: 0, y: 0 });
  });
  cv.addEventListener('pointermove', (e) => {
    if (!state.drag) return;
    state.drag.x1 = px(e);
    state.chart.draw();
  });
  const finish = (e) => {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (e.type === 'pointerup' && Math.abs(d.x1 - d.x0) < 4) {
      // 單擊（沒有拖曳）：在該日新增觀察線；點在既有觀察線附近則移除
      const c = state.chart, labels = c.data.labels;
      const near = state.markers.find((m) => {
        const i = labels.findIndex((l) => l >= m);
        return i >= 0 && Math.abs(c.scales.x.getPixelForValue(i) - d.x0) <= 6;
      });
      toggleMarker(near || labels[idxAt(d.x0)]);
      return;
    }
    if (e.type === 'pointerup' && Math.abs(d.x1 - d.x0) >= 8) {
      const labels = state.chart.data.labels;
      const [i0, i1] = [idxAt(d.x0), idxAt(d.x1)].sort((a, b) => a - b);
      if (i1 > i0) {
        state.zoom = { from: labels[i0], to: labels[i1] };
        renderChart();
        return;
      }
    }
    state.chart.draw();
  };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);
  $('#zoomReset').addEventListener('click', resetZoom);
}

function resetZoom() {
  if (!state.zoom) return;
  state.zoom = null;
  renderChart();
}

function renderChart() {
  renderLegend();
  const vis = state.analyses.map((a, idx) => ({ a, idx, ser: visibleSeries(a) })).filter(({ ser }) => ser.length);
  const labels = [...new Set(vis.flatMap(({ ser }) => ser.map((p) => p.date)))].sort();
  const pct = state.mode === 'pct';
  const log = $('#logScale').checked;

  const datasets = vis.map(({ a, idx, ser }) => {
    const m = new Map(ser.map((p) => [p.date, p.adj]));
    // 累積報酬以「目前顯示區段」的第一天為基準，放大後各標的從 0% 重新起算
    const base = ser[0].adj;
    return {
      label: a.sym,
      data: labels.map((d) => {
        const v = m.get(d);
        if (v === undefined) return null;
        // 對數座標下的報酬率以「100 × 成長倍數」繪製，標籤再換回 %
        return pct ? (log ? 100 * (v / base) : (v / base - 1) * 100) : v;
      }),
      borderColor: colorOf(idx),
      backgroundColor: colorOf(idx),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: cssVar('--surface-1'),
      spanGaps: true,
      tension: 0,
      hidden: state.hidden.has(a.sym),
    };
  });

  const ink2 = cssVar('--text-secondary'), muted = cssVar('--muted'), grid = cssVar('--grid');
  const yFmt = (v) => (pct ? `${(log ? v - 100 : v).toFixed(Math.abs(log ? v - 100 : v) < 10 ? 1 : 0)}%` : (+v).toLocaleString());

  if (state.chart) state.chart.destroy();
  state.chart = new Chart($('#chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      animation: false,
      maintainAspectRatio: false,
      layout: { padding: { top: state.markers.length ? 22 : 0 } },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { display: false },
          border: { color: cssVar('--axis') },
          ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        },
        y: {
          type: log ? 'logarithmic' : 'linear',
          grid: { color: grid },
          border: { display: false },
          ticks: { color: muted, callback: yFmt, maxTicksLimit: 8 },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--surface-1'),
          borderColor: cssVar('--axis'),
          borderWidth: 1,
          titleColor: ink2,
          bodyColor: cssVar('--text-primary'),
          padding: 10,
          boxWidth: 12, boxHeight: 2, usePointStyle: false,
          filter: () => !state.drag,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            label: (c) => `${yFmt(c.parsed.y)}  ${c.dataset.label}`,
            labelColor: (c) => ({ borderColor: c.dataset.borderColor, backgroundColor: c.dataset.borderColor }),
          },
        },
      },
    },
    plugins: [crosshair, markerLines, dragBox],
  });
  const z = state.zoom;
  $('#zoomInfo').textContent = z ? `顯示 ${z.from} ~ ${z.to}　·　拖曳可再放大、單擊加觀察線` : '在圖上左右拖曳可放大區段；單擊可加入縱軸觀察線（再點一次移除）';
  $('#zoomReset').hidden = !z;
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  $('#chartCard').hidden = false;
}

// 觀察線比較表：各標的在每條觀察線的收盤價與自開始日的累計報酬，以及相鄰觀察線之間、最後一條到區間末的漲跌幅
function renderMarkers() {
  const box = $('#markerTable');
  const ms = state.markers;
  $('#markerClear').hidden = !ms.length;
  if (!ms.length) {
    box.replaceChildren(el('p', { class: 'note', text: '尚未設定觀察線。在走勢圖上單擊，或用上方日期欄位加入；可設定多條來比較不同時間區段。' }));
    return;
  }
  const t = el('table');
  const h1 = el('tr', {}, el('th', { text: '標的', rowspan: 2 }));
  const h2 = el('tr');
  ms.forEach((d, i) => {
    const rm = el('button', { type: 'button', class: 'chip-x', title: '移除', 'aria-label': `移除觀察線 ${markerName(i)}` }, '×');
    rm.addEventListener('click', () => setMarkers(ms.filter((x) => x !== d)));
    h1.append(el('th', { class: 'mk' }, el('span', { class: 'mk-name', text: markerName(i) }), ` ${d} `, rm));
    h1.lastChild.setAttribute('colspan', 2);
    h2.append(el('th', { text: '收盤價（分割調整）' }), el('th', { text: '自開始日累計報酬' }));
  });
  const spans = ms.map((d, i) => (i < ms.length - 1 ? [i, i + 1] : null)).filter(Boolean);
  spans.forEach(([i, j]) => {
    h1.append(el('th', { text: `${markerName(i)} → ${markerName(j)}` }));
    h2.append(el('th', { text: '漲跌幅' }));
  });
  if (ms.length > 1) {
    h1.append(el('th', { text: `${markerName(0)} → ${markerName(ms.length - 1)}` }));
    h2.append(el('th', { text: '漲跌幅' }));
  }
  h1.append(el('th', { text: `${markerName(ms.length - 1)} → 區間末` }));
  h2.append(el('th', { text: '漲跌幅' }));
  t.append(el('thead', {}, h1, h2));
  const baseNote = el('p', { class: 'note', text: `累計報酬 = 觀察線當日收盤 ÷ 開始日（${state.startDate}）起第一個交易日的收盤 − 1，皆以分割調整後價格計算。` });

  const pctCell = (p0, p1) => {
    if (!p0 || !p1) return el('td', { text: '—' });
    const v = (p1.adj / p0.adj - 1) * 100;
    return el('td', { class: v >= 0 ? 'up' : 'down', text: `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` });
  };
  const dec = +$('#decimals').value;
  const tb = el('tbody');
  state.analyses.forEach((a, idx) => {
    if (!a.series.length) return;
    const pts = ms.map((d) => pointAt(a, d));
    // 累計報酬的基準固定為查詢「開始日」起的第一個交易日（不受走勢圖放大影響）
    const base = a.series[0];
    const tr = el('tr', {}, el('td', {},
      el('span', { class: 'key', style: `background:${colorOf(idx)}` }), ' ', el('strong', { text: a.sym })));
    pts.forEach((p, i) => {
      // 用分割調整後價格，跨分割日的觀察線才能直接比較
      const td = el('td', { text: p ? fmt(p.adj, dec) : '—' });
      const tips = [];
      if (p && p.date !== ms[i]) tips.push(`${ms[i]} 非交易日，採用 ${p.date}`);
      if (p && Math.abs(p.close - p.adj) > 1e-9) tips.push(`當日實際成交收盤 ${fmt(p.close, dec)}`);
      if (tips.length) td.title = tips.join('；');
      tr.append(td, pctCell(base, p));
    });
    spans.forEach(([i, j]) => tr.append(pctCell(pts[i], pts[j])));
    if (ms.length > 1) tr.append(pctCell(pts[0], pts[ms.length - 1]));
    const last = a.series[a.series.length - 1];
    tr.append(pctCell(pts[ms.length - 1], last));
    tb.append(tr);
  });
  t.append(tb);
  box.replaceChildren(t, baseNote);
}

const STATUS = {
  same: ['ok', '完全相同'],
  avg: ['ok', '取平均'],
  miss: ['warn', '來源缺漏'],
  warn: ['bad', '警示'],
};

function renderDetail() {
  const sel = $('#detailSym');
  const a = state.analyses.find((x) => x.sym === sel.value) || state.analyses[0];
  if (!a) return;
  const dec = +$('#decimals').value;
  const only = $('#onlyDiff').checked;
  const t = el('table');
  const head = el('tr', {}, el('th', { text: '日期' }), el('th', { text: '狀態' }), el('th', { text: '採用收盤價' }));
  for (const r of a.live) head.append(el('th', { text: r.name }));
  head.append(el('th', { text: '最大偏離' }), el('th', { text: '疑似錯誤' }));
  t.append(el('thead', {}, head));
  const tb = el('tbody');
  const rows = only ? a.rows.filter((r) => r.status === 'warn' || r.status === 'miss') : a.rows;
  for (const r of rows.slice().reverse()) {
    const [cls, label] = STATUS[r.status];
    const tr = el('tr', { class: r.status === 'warn' ? 'bad' : r.status === 'miss' ? 'miss' : '' });
    tr.append(el('td', { text: r.date }));
    tr.append(el('td', {}, el('span', { class: `badge ${cls}`, text: ` ${label}` })));
    tr.append(el('td', {}, el('strong', { text: fmt(r.price, dec + (r.status === 'avg' ? 2 : 0)) })));
    r.vals.forEach((x) => {
      const td = el('td', { text: x ? fmt(x.v, dec) + (x.conv ? '*' : '') : '—' });
      if (x?.conv) td.title = `由分割調整價 × ${+r.factor.toFixed(4)} 換算`;
      if (r.status === 'warn') td.classList.add('diffcell');
      tr.append(td);
    });
    tr.append(el('td', { text: r.devPct ? `${r.devPct.toFixed(3)}%` : '0' }));
    tr.append(el('td', { class: 'txt', text: [...r.outliers].join('、') }));
    tb.append(tr);
  }
  if (!rows.length) {
    tb.append(el('tr', {}, el('td', { class: 'txt', colspan: 5 + a.live.length,
      text: only ? `沒有警示或缺漏：每天的收盤價都完全相同，或差異在 ±${opts().tolPct}% 內已取平均。` : '無資料' })));
  }
  t.append(tb);
  $('#detail').replaceWith(t);
  t.id = 'detail';
  $('#detailCard').hidden = false;
}

function downloadCSV() {
  const a = state.analyses.find((x) => x.sym === $('#detailSym').value);
  if (!a) return;
  const head = ['date', 'status', 'close', 'close_split_adjusted', ...a.live.map((r) => `close_${r.id}`), 'max_dev_pct', 'outliers'];
  const lines = [head.join(',')];
  for (const r of a.rows) {
    lines.push([r.date, r.status, roundTo(r.price, 6), roundTo(r.price / r.factor, 6),
      ...r.vals.map((x) => (x ? x.v : '')), roundTo(r.devPct, 4), [...r.outliers].join('|')].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' });
  const link = el('a', { href: URL.createObjectURL(blob), download: `${a.sym}_${$('#start').value}_${$('#end').value}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function opts() {
  return {
    decimals: Math.max(0, Math.min(6, +$('#decimals').value || 0)),
    tolPct: Math.max(0, +$('#tolPct').value || 0),
  };
}

function recompare() {
  if (!state.raw) return;
  state.analyses = state.raw.map((d) => compare(d, opts()));
  renderSummary(); renderChart(); renderMarkers(); renderDetail();
}

async function run() {
  const syms = [...new Set($('#symbols').value.toUpperCase().split(/[\s,，、]+/).filter(Boolean))];
  const start = $('#start').value, end = $('#end').value;
  if (!syms.length) return setStatus('請輸入至少一個標的', true);
  if (syms.length > MAX_SYMBOLS) return setStatus(`最多 ${MAX_SYMBOLS} 個標的`, true);
  if (!start || !end || start > end) return setStatus('日期區間不正確', true);

  const url = new URL(location.href);
  url.searchParams.set('s', syms.join(','));
  url.searchParams.set('from', start);
  url.searchParams.set('to', end);
  if (state.markers.length) url.searchParams.set('m', state.markers.join(','));
  history.replaceState(null, '', url);

  const ctx = {
    token: $('#fmToken').value.trim(),
    yProxy: $('#yProxy').value.trim(),
    progress: (m) => setStatus(`抓取中… ${m}`),
  };
  localStorage.setItem('px:settings', JSON.stringify({ token: ctx.token, yProxy: ctx.yProxy }));

  $('#run').disabled = true;
  $('.chart-wrap').classList.add('loading');
  try {
    const raw = [];
    for (const s of syms) {
      setStatus(`抓取中… ${s}（${raw.length + 1}/${syms.length}）`);
      raw.push(await loadSymbol(s, start, end, ctx));
    }
    state.raw = raw;
    state.startDate = start;
    state.zoom = null;
    const sel = $('#detailSym');
    const prev = sel.value;
    sel.replaceChildren(...syms.map((s) => el('option', { value: s, text: s })));
    if (syms.includes(prev)) sel.value = prev;
    recompare();
    const errs = raw.flatMap((d) => d.results.filter((r) => r.err).map((r) => `${d.sym} / ${r.name}：${r.err}`));
    setStatus(`完成（${start} ~ ${end}）。` + (errs.length ? `\n部分來源失敗：\n${errs.join('\n')}` : ''), false);
  } catch (e) {
    setStatus('發生錯誤：' + e.message, true);
  } finally {
    $('#run').disabled = false;
    $('.chart-wrap').classList.remove('loading');
  }
}

function preset(p) {
  const end = new Date();
  const s = new Date(end);
  const map = { '1M': [0, 1], '3M': [0, 3], '6M': [0, 6], '1Y': [1, 0], '3Y': [3, 0], '5Y': [5, 0] };
  if (p === 'YTD') s.setMonth(0, 1);
  else { s.setFullYear(s.getFullYear() - map[p][0]); s.setMonth(s.getMonth() - map[p][1]); }
  $('#start').value = ymd(s);
  $('#end').value = ymd(end);
}

function init() {
  const q = new URLSearchParams(location.search);
  if (q.get('s')) $('#symbols').value = q.get('s');
  preset('1Y');
  if (q.get('from')) $('#start').value = q.get('from');
  if (q.get('to')) $('#end').value = q.get('to');
  if (q.get('m')) state.markers = q.get('m').split(',').filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, MAX_MARKERS);
  try {
    const st = JSON.parse(localStorage.getItem('px:settings')) || {};
    if (st.token) $('#fmToken').value = st.token;
    if (st.yProxy) $('#yProxy').value = st.yProxy;
  } catch { /* ignore */ }

  const theme = localStorage.getItem('px:theme');
  if (theme) document.documentElement.dataset.theme = theme;
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    localStorage.setItem('px:theme', document.documentElement.dataset.theme);
    if (state.analyses.length) renderChart();
  });

  document.querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => preset(b.dataset.p)));
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode; renderChart();
  }));
  $('#logScale').addEventListener('change', renderChart);
  initChartZoom();
  $('#markerAdd').addEventListener('click', () => {
    const d = $('#markerDate').value;
    if (d) toggleMarker(d);
  });
  $('#markerClear').addEventListener('click', () => setMarkers([]));
  $('#run').addEventListener('click', run);
  $('#symbols').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $('#detailSym').addEventListener('change', renderDetail);
  $('#onlyDiff').addEventListener('change', renderDetail);
  $('#csvBtn').addEventListener('click', downloadCSV);
  ['#decimals', '#tolPct'].forEach((s) => $(s).addEventListener('change', recompare));

  if (q.get('s')) run();
}

init();
