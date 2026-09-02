/* ChartCanvas app.js —— 前端绘图逻辑 */
"use strict";

/* ============================ 全局状态 ============================ */
const S = {
  schema: null,        // 后端字段描述
  file: "",
  cols: [],            // 原始列列表
  seriesNames: [],     // 后端按 series 拆分得到的组名
  queryCache: null,    // {colData: {col:[...]}, groups, colTypes}
  curType: "bar",
  filters: {},         // {col: [values]}
};

/* 数值聚合函数集（前端实现，输入数组输出单值） */
const AGG = {
  sum: a => a.reduce((s, v) => s + (isFinite(v) ? v : 0), 0),
  mean: a => { const f = a.filter(isFinite); return f.length ? f.reduce((s, v) => s + v, 0) / f.length : null; },
  median: a => { const f = a.filter(isFinite).sort((x, y) => x - y); if (!f.length) return null; const m = f.length >> 1; return f.length % 2 ? f[m] : (f[m - 1] + f[m]) / 2; },
  max: a => { const f = a.filter(isFinite); return f.length ? Math.max(...f) : null; },
  min: a => { const f = a.filter(isFinite); return f.length ? Math.min(...f) : null; },
  count: a => a.length,
  nunique: a => new Set(a).size,
};

const THEMES = {
  Plotly: null, Ocean: "Ocean", Viridis: "Viridis", Dark2: "Dark2",
  Pastel: "Pastel", Bold: "Bold", Set1: "Set1",
};

/* ============================ 工具 ============================ */
const $ = id => document.getElementById(id);
const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
function toast(msg, err) { const t = $("toast"); t.textContent = msg; t.classList.toggle("err", !!err); t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2600); }
function debounce(fn, ms = 160) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ============================ 界面构建 ============================ */
const CHART_TYPES = [
  ["bar", "柱状图", "▤"], ["line", "折线图", "╱"], ["area", "面积图", "◠"],
  ["scatter", "散点气泡", "◍"], ["pie", "饼图环图", "◔"], ["histogram", "直方图", "▮▮"],
  ["box", "箱线图", "▭"], ["heatmap", "热力图", "▦"], ["radar", "雷达图", "✺"],
  ["pareto", "帕累托", "▂▄▆█"], ["summary", "统计概要", "Σ"],
];

function buildTypeGrid() {
  const g = $("chartTypes");
  g.innerHTML = "";
  for (const [id, label, ico] of CHART_TYPES) {
    const d = document.createElement("div");
    d.className = "ctype" + (id === S.curType ? " active" : "");
    d.innerHTML = `<span class="ico">${ico}</span>${label}`;
    d.onclick = () => { S.curType = id; document.querySelectorAll(".ctype").forEach(e => e.classList.remove("active")); d.classList.add("active"); initExtControls(); buildPlot(); };
    g.appendChild(d);
  }
}

function fillAgg() {
  $("selAgg").innerHTML = Object.keys(AGG).map(a =>
    `<option value="${a}">${a === "nunique" ? "去重计数" : a}</option>`).join("");
  $("selAgg").value = "sum";
}

/* ============================ 打开数据 ============================ */
async function loadDemo() {
  toast("正在加载示例数据…");
  try {
    const r = await pywebview.api.load_demo();
    if (!r || !r.ok) { toast((r && r.error) || "示例加载失败", true); return; }
    applySchema(r);
    toast(`已加载示例：${r.rows} 行`);
    if (window.location.hash === "#auto" && window.__selftest) {
      setTimeout(() => window.__selftest(), 500);
    }
  } catch (e) { toast("加载失败：" + e, true); }
}

async function openFile() {
  toast("正在读取文件…");
  try {
    const r = await pywebview.api.choose_and_load();
    if (!r || !r.ok) { toast((r && r.error) || "已取消", !r || !r.cancel); return; }
    applySchema(r);
  } catch (e) { toast("读取失败：" + e, true); }
}

function applySchema(r) {
  S.schema = r; S.cols = r.columns; S.file = r.file;
  $("fileInfo").textContent = `📄 ${r.file}　共 ${r.rows} 行 × ${r.cols} 列`;
  const catCols = r.columns.filter(c => c.dtype === "category" || c.dtype === "datetime");
  const numCols = r.columns.filter(c => c.dtype === "numeric");
  // X
  let xo = `<option value="__row__">（行号）</option>`;
  catCols.forEach(c => xo += `<option value="${esc(c.name)}">${esc(c.name)}</option>`);
  numCols.forEach(c => xo += `<option value="${esc(c.name)}">${esc(c.name)}</option>`);
  $("selX").innerHTML = xo;
  // Y
  $("selY").innerHTML = numCols.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("")
    + catCols.map(c => `<option value="${esc(c.name)}">${esc(c.name)}（计数）</option>`).join("");
  // series
  $("selSeries").innerHTML = `<option value="">— 无 —</option>`
    + catCols.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
  // 默认选择
  if (catCols[0]) $("selX").value = catCols[0].name;
  if (numCols[0]) $("selY").value = numCols[0].name;
  if (catCols[1]) $("selSeries").value = catCols[1].name;
  renderSchemaBox();
  rebuildFilters();
  buildPlot();
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

function renderSchemaBox() {
  const box = $("schemaBox");
  box.className = "small";
  box.style.maxHeight = "150px"; box.style.overflow = "auto";
  const rows = S.schema.rows;
  box.innerHTML = S.cols.map(c =>
    `<div style="padding:1.5px 0;border-bottom:1px dashed #eef" title="类型:${c.dtype}"><b>${esc(c.name)}</b><br><span class="muted">${c.dtype === "numeric" ? "数值" : c.dtype === "datetime" ? "时间" : "分类"} · 缺失 ${Math.max(0, rows - c.nonnull)} · 类 ${c.nunique >= 0 ? c.nunique : "—"}</span></div>`
  ).join("");
}

/* ============================ 数据筛选 ============================ */
let FILTER_POOL = {}; // col -> 值候选

async function rebuildFilters() {
  const box = $("filterBox");
  box.innerHTML = `<div class="muted small">加载可筛选项…</div>`;
  const catCols = S.cols.filter(c => c.dtype === "category");
  if (!catCols.length) { box.innerHTML = `<div class="muted small">无分类列可筛选</div>`; return; }
  try {
    const r = await pywebview.api.categories(JSON.stringify({ cols: catCols.map(c => c.name), top: 800 }));
    if (r && r.ok) FILTER_POOL = r.values;
  } catch (e) { FILTER_POOL = {}; }
  S.filters = {};
  box.innerHTML = "";
  catCols.forEach(c => {
    const opts = FILTER_POOL[c.name] || [];
    const dv = document.createElement("div"); dv.className = "fitem";
    dv.innerHTML = `<div class="fhead"><b>${esc(c.name)}</b>
      <button class="small ghost" data-clear="${esc(c.name)}" title="清除">✕</button></div>
      <select multiple size="${Math.min(4, opts.length || 2)}">`;
    const sel = dv.querySelector("select");
    opts.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); });
    sel.onchange = () => {
      S.filters[c.name] = [...sel.selectedOptions].map(o => o.value);
      debouncedBuild();
    };
    dv.querySelector("[data-clear]").onclick = () => { sel.selectedIndex = -1; sel.dispatchEvent(new Event("change")); };
    box.appendChild(dv);
  });
  if (!box.children.length) box.innerHTML = `<div class="muted small">无分类列</div>`;
}
const debouncedBuild = debounce(() => buildPlot(), 180);

/* ============================ 查询数据 ============================ */
async function fetchData(extraCols = []) {
  const xCol = xVal();
  const seriesCol = seriesVal();
  const yCols = yVals();
  const base = [xCol, ...yCols, seriesCol].filter(Boolean).concat(extraCols).filter((v, i, a) => a.indexOf(v) === i);
  const cols = base.filter(c => S.cols.some(cc => cc.name === c));
  const req = { cols, series: seriesCol || "", filters: collectFilters(), limit: 300000 };
  const r = await pywebview.api.query(JSON.stringify(req));
  if (!r || !r.ok) { toast((r && r.error) || "查询失败", true); return null; }
  // 汇总出每组每列数组
  const groups = r.series.map(g => ({ name: g.name, data: g.data }));
  return { groups, colTypes: r.colTypes };
}

function xVal() { const v = $("selX").value; return v === "__row__" ? null : v; }
function yVals() { return [...$("selY").selectedOptions].map(o => o.value); }
function seriesVal() { return $("selSeries").value || null; }
function aggVal() { return $("selAgg").value; }

function collectFilters() {
  return S.filters;
}

/* ============================ 读取实时样式 ============================ */
function cfg() {
  return {
    title: $("inTitle").value,
    w: +$("inW").value || 900, h: +$("inH").value || 520,
    font: $("selFont").value, fontSize: +$("inFontSize").value || 13,
    theme: THEMES[$("selTheme").value], bg: $("selBg").value,
    // 细节选项（每类不同）
    ext: collectExt(),
  };
}
function collectExt() {
  const out = {};
  document.querySelectorAll("#detailOpts [data-cfg]").forEach(el => {
    out[el.dataset.cfg] = el.type === "checkbox" ? el.checked : el.value;
  });
  return out;
}

/* ============================ 图表构建入口 ============================ */
async function buildPlot() {
  const type = S.curType;
  if (!S.schema) { showHint(); return; }
  const data = await fetchData();
  if (!data) return;
  const c = cfg();
  try {
    const gd = $("plot");
    if (type === "summary") {
      const sdata = await fetchData();
      const fig = sdata ? buildSummary(sdata, c) : null;
      if (fig && fig.table) { renderSummaryTable(fig.table); return; }
      toast("缺少配置：请选择 Y 数值字段", true); return;
    }
    const fig = buildFig(type, data, c);
    if (!fig) { toast("缺少配置：请选择 X/Y 字段", true); return; }
    $("plotHint").style.display = "none";
    gd.style.display = "block";
    const layout = makeLayout(type, c);
    const config = { responsive: true, displaylogo: false, toImageButtonOptions: { format: "png", width: c.w, height: c.h } };
    await Plotly.react(gd, fig.data, layout, config);
    try { pywebview.api && pywebview.api.log("PLOT_OK " + type); } catch (e) {}
  } catch (e) { console.error(e); toast("绘图失败：" + e, true); }
}

function renderSummaryTable(rows) {
  if (!rows.length) { toast("无数据", true); return; }
  $("plotHint").style.display = "none";
  const gd = $("plot");
  gd.style.display = "block";
  const c = cfg();
  const head = ["分组", "字段", "样本n", "总和", "均值", "中位数", "标准差", "最小", "最大"];
  const body = rows.map(r => [r.grp, r.col, r.count, fmtNum(r.sum, 0), fmtNum(r.mean, 2), fmtNum(r.median, 2), fmtNum(r.sd, 2), fmtNum(r.min, 2), fmtNum(r.max, 2)]);
  const table = `<div style="padding:18px"><div style="font-size:${c.fontSize + 4}px;font-weight:600;margin-bottom:10px;color:#1d2a44">${esc(c.title || "统计概要")}</div>
    <div style="max-height:${c.h - 70}px;overflow:auto;border:1px solid #dfe4ef;border-radius:8px">
    <table style="border-collapse:collapse;width:100%;font-size:${c.fontSize}px"><thead>
    <tr>${head.map(h => `<th style="position:sticky;top:0;background:#1d2a44;color:#fff;padding:7px 10px;text-align:right;border:1px solid #33415e;font-weight:500">${h}</th>`).join("")}</tr></thead><tbody>
    ${body.map(r => `<tr>${r.map((v, i) => `<td style="padding:5px 10px;text-align:${i < 2 ? "left" : "right"};border:1px solid #eef;${i === 0 ? "font-weight:600" : ""}">${i < 2 ? esc(v) : v}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div></div>`;
  gd.innerHTML = table;
}

/* ============================ 数据整形：分类→聚合 ============================ */
/*
  输入 groups=[{name, data:{x:[], y:[]}}]
  输出 xcats（并集有序）+ 每个 trace 的 {name, x, y}
*/
function pivotXY(groups, yColIndex, extraSplit) {
  // 构造 trace 集合：[{key, group, series, xBuckets, acc}]
  const traces = [];
  const catOrder = [];
  const seen = new Set();
  for (const g of groups) {
    const xarr = g.data.x === undefined ? null : g.data.x;
    const yarr = g.data.y;
    const vals = g.data.__vals__ ? g.data.__vals__ : yarr;
    const bmap = {};
    const order = [];
    for (let i = 0; i < (xarr ? xarr.length : 1); i++) {
      const key = xarr === null ? "__single__" : String(xarr[i]);
      if (!(key in bmap)) { bmap[key] = []; order.push(key); }
      const v = num(yarr[i]);
      if (v !== null) bmap[key].push(v);
      if (!seen.has(key)) { seen.add(key); catOrder.push(key); }
    }
    traces.push({ key: g.name, order, bmap });
  }
  return { traces, catOrder };
}

/* 数值列提取时按不同 y 列聚合 */
/* ============================ 具体图构建 ============================ */
function buildFig(type, data, c) {
  switch (type) {
    case "bar": case "line": case "area": return buildXY(type, data, c);
    case "pareto": return buildPareto(data, c);
    case "scatter": return buildScatter(data, c);
    case "pie": return buildPie(data, c);
    case "histogram": return buildHistogram(data, c);
    case "box": return buildBox(data, c);
    case "heatmap": return buildHeatmap(data, c);
    case "radar": return buildRadar(data, c);
    case "summary": return buildSummary(data, c);
    default: return null;
  }
}

/* ---- XY 类（bar/line/area 支持多 Y、系列、堆叠） ---- */
function buildXY(type, data, c) {
  const yc = yVals();
  if (!yc.length) return null;
  const xc = xVal();
  const xKeys = new Map(); // label -> index
  const xOrder = [];
  // 每 trace：按 (seriesGroup, ycol) 划分；聚合 x
  const traceMap = new Map(); // key-> {xidx:{arr:[]}}
  for (const g of data.groups) {
    const gname = g.name;
    for (const y of yc) {
      if (!g.data[y]) continue;
      const tkey = gname ? `${y} · ${gname}` : y;
      if (!traceMap.has(tkey)) traceMap.set(tkey, { name: tkey, xidx: new Map() });
      const t = traceMap.get(tkey);
      for (let i = 0; i < (g.data[xc] || g.data[y] || []).length; i++) {
        let xl = xc ? String(g.data[xc][i]) : "行" + (i + 1);
        if (!xKeys.has(xl)) { xKeys.set(xl, xOrder.length); xOrder.push(xl); }
        const xi = xKeys.get(xl);
        if (!t.xidx.has(xi)) t.xidx.set(xi, []);
        const v = num(g.data[y][i]); if (v !== null) t.xidx.get(xi).push(v);
      }
    }
  }
  const aggfn = AGG[aggVal()] || AGG.sum;
  const traces = [];
  for (const t of traceMap.values()) {
    const xs = [], ys = [];
    for (let xi = 0; xi < xOrder.length; xi++) {
      const arr = t.xidx.get(xi);
      xs.push(xOrder[xi]);
      ys.push(arr ? aggfn(arr) : null);
    }
    traces.push({ name: t.name, x: xs, y: ys });
  }
  const multiGroup = data.groups.length > 1;
  const stack = !!(c.ext && c.ext.stacked) && (type === "bar" || type === "area");
  const horiz = !!(c.ext && c.ext.horizontal) && type === "bar";
  const ext = c.ext || {};
  const catLabel = ext.catlabel || "类别", valLabel = ext.vallabel || "值";
  return {
    data: traces.map((tr, i) => {
      const catX = tr.x, catY = tr.y;
      let xv = catX, yv = catY;
      const base = {
        type: type === "area" ? "scatter" : type,
        name: tr.name,
        hovertemplate: `%{fullData.name}<br>${catLabel}: %{x}<br>${valLabel}: %{y}<extra></extra>`,
      };
      if (horiz) { xv = catY; yv = catX; }
      base.x = xv; base.y = yv;
      if (horiz) base.orientation = "h";
      if (type === "line" || type === "area") {
        base.mode = "lines" + (ext.showmarkers ? "+markers" : "");
        if (type === "area") base.fill = "tozeroy";
        if (stack) base.stackgroup = "one";
        base.line = { width: ext.linewidth ? +ext.linewidth : 2, shape: ext.linecurved ? "spline" : "linear" };
      }
      if (type === "bar") {
        base.marker = { opacity: ext.opacity ? +ext.opacity : 1, line: { width: ext.barline ? +ext.barline : 0 } };
        if (ext.textshow) {
          base.text = tr.y.map(v => v === null ? "" : fmtNum(v, ext.decimals));
          base.textposition = "outside"; base.cliponaxis = false;
          base.insidetextanchor = "end";
        }
        if (stack) { base.marker.line.width = 1; }
      }
      if (stack && type === "area") { /* stacked area handled via stackgroup */ }
      return base;
    }),
    traces,
    stack, horiz, multiGroup,
  };
}

function makeLayout(type, c) {
  const ext = c.ext || {};
  const fontColor = c.bg === "dark" ? "#dfe6f2" : "#26303f";
  const gridColor = c.bg === "dark" ? "#2c3547" : "#e6ebf4";
  const axisColor = c.bg === "dark" ? "#4a5672" : "#bcc6d8";
  const paperBg = c.bg === "dark" ? "#141922" : "#ffffff";
  const plotBg = c.bg === "dark" ? "#1b2230" : (c.bg === "light" ? "#f4f7fc" : "#ffffff");

  // 轴标题（bar 横向时类别在 y、数值在 x）
  const horiz = type === "bar" && ext.horizontal;
  const xlabel = horiz ? (ext.ylab || "") : (ext.xlab || "");
  const ylabel = horiz ? (ext.xlab || "") : (ext.ylab || "");
  const xaxis = {
    title: xlabel ? { text: xlabel } : undefined,
    gridcolor: gridColor, linecolor: axisColor, zerolinecolor: axisColor,
    tickangle: (horiz ? 0 : (ext.xtick ? +ext.xtick : 0)),
    tickfont: { color: fontColor },
    titlefont: { color: fontColor },
  };
  const yaxis = {
    title: ylabel ? { text: ylabel } : undefined,
    gridcolor: gridColor, linecolor: axisColor, zerolinecolor: axisColor,
    tickfont: { color: fontColor }, titlefont: { color: fontColor },
  };
  if (ext.logx) xaxis.type = "log";
  if (ext.logy) yaxis.type = "log";
  if (ext.zeroliney === false) yaxis.zeroline = false;

  const layout = {
    width: c.w, height: c.h,
    font: { family: c.font, size: c.fontSize, color: fontColor },
    paper_bgcolor: paperBg, plot_bgcolor: plotBg,
    title: { text: c.title || "", x: 0.02, xanchor: "left", font: { size: c.fontSize + 6, color: fontColor } },
    xaxis, yaxis,
    hovermode: "closest",
    margin: { l: ext.marginl != null ? +ext.marginl : 70, r: ext.marginr != null ? +ext.marginr : 40, t: 46, b: ext.marginb != null ? +ext.marginb : 60 },
  };
  if (type === "bar") {
    layout.barmode = ext.stacked ? "stack" : "group";
    layout.bargap = 0.2; layout.bargroupgap = 0.05;
  }
  if (type === "box") layout.boxmode = ext.stacked ? "overlay" : "group";
  // 图例
  layout.showlegend = !(type === "heatmap" || type === "histogram" || type === "summary");
  layout.legend = { orientation: ext.legendh ? "h" : "v", font: { color: fontColor }, bgcolor: "rgba(0,0,0,0)" };
  if (ext.legendh) layout.legend = { ...layout.legend, y: -0.15, x: 0 };
  return layout;
}

/* ---- Pareto ---- */
function buildPareto(data, c) {
  const xc = xVal(); const yc = yVals()[0];
  if (!yc || !xc) return null;
  const m = new Map(); const order = [];
  for (const g of data.groups) for (let i = 0; i < (g.data[xc] || []).length; i++) {
    const k = String(g.data[xc][i]); const v = num(g.data[yc][i]);
    if (v === null) continue;
    if (!m.has(k)) { m.set(k, 0); order.push(k); }
    m.set(k, m.get(k) + v);
  }
  let entries = order.map(k => [k, m.get(k)]).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0) || 1;
  let cum = 0;
  const xs = entries.map(e => e[0]); const vals = entries.map(e => e[1]);
  const pct = vals.map(v => { cum += v; return +(cum / total * 100).toFixed(1); });
  return {
    data: [
      { type: "bar", x: xs, y: vals, name: "数值", marker: { color: "#3d6ef7" }, hovertemplate: "%{x}: %{y}<extra></extra>" },
      { type: "scatter", mode: "lines+markers", x: xs, y: pct, name: "累计占比(%)", yaxis: "y2", line: { color: "#e74c3c", width: 2 }, marker: { color: "#e74c3c" } },
    ],
  };
}

/* ---- Scatter / bubble ---- */
function buildScatter(data, c) {
  const xc = xVal(); const yc = yVals();
  const vx = yc[0]; const vy = yc[1];
  if (!vx) return null;
  const ext = c.ext || {};
  const sizeIdx = 2;
  const sizeCol = yVals()[2];
  const traces = [];
  for (const g of data.groups) {
    const X = xc ? g.data[xc].map(num) : g.data[vx];
    const Y = g.data[vy] ? g.data[vy].map(num) : g.data[vx];
    const colorArr = ext.colorshow ? g.data[sizeCol] : null;
    const tr = {
      type: "scatter", mode: "markers",
      x: xc ? X : g.data[vx].map(num), y: Y,
      name: g.name || yc[0],
      marker: { size: colorArr ? colorArr.map(v => 6 + (num(v) || 0)) : (sizeIdx < yc.length ? 9 : 9), opacity: ext.opacity ? +ext.opacity : .85 },
      text: colorArr || null,
    };
    if (sizeIdx < yc.length && !colorArr) tr.marker.size = g.data[yc[sizeIdx]].map(v => 6 + (num(v) || 0) / (ext.bubscale ? +ext.bubscale : 1) * 6);
    traces.push(tr);
  }
  return { data: traces };
}

/* ---- Pie ---- */
function buildPie(data, c) {
  const xc = xVal(); const yc = yVals()[0];
  if (!xc) return null;
  const aggfn = AGG[aggVal()] || AGG.sum;
  const seriesGroups = data.groups;
  const m = new Map(); const order = [];
  for (const g of seriesGroups) {
    const arr = g.data[yc] || g.data[xc];
    const sub = new Map(); const subOrder = [];
    for (let i = 0; i < (g.data[xc] || []).length; i++) {
      const k = String(g.data[xc][i]); const v = num(g.data[yc][i]);
      if (!sub.has(k)) { sub.set(k, []); subOrder.push(k); }
      if (v !== null) sub.get(k).push(v);
    }
    for (const k of subOrder) {
      const key = g.name ? `${k}·${g.name}` : k;
      if (!m.has(key)) { m.set(key, []); order.push(key); }
      if (yc) sub.get(k).forEach(v => m.get(key).push(v));
    }
  }
  const labels = order.filter(k => (m.get(k) || []).length || !yc);
  const values = order.map(k => { const a = m.get(k) || []; return yc ? aggfn(a) : a.length; });
  const ext = c.ext || {};
  const donut = ext.donut ? +ext.donut : 0;
  return {
    data: [{
      type: "pie", labels, values,
      hole: donut / 100,
      sort: false,
      textinfo: ext.textinfo || "percent+label",
      hovertemplate: "%{label}: %{value} (%{percent})<extra></extra>",
      marker: { line: { color: "#fff", width: 1.5 } },
    }],
  };
}

/* ---- Histogram ---- */
function buildHistogram(data, c) {
  const numCol = (yVals().map(y => data.groups[0] && data.groups[0].data[y]).find(() => true) !== undefined) ? yVals()[0] : xVal();
  const values = [];
  for (const g of data.groups) {
    const arr = g.data[numCol] || [];
    arr.forEach(v => { const n = num(v); if (n !== null) values.push(n); });
  }
  if (!values.length) return null;
  const ext = c.ext || {};
  const bins = +ext.bins || 20;
  return {
    data: [{
      type: "histogram", x: values, nbinsx: bins,
      marker: { color: "#3d6ef7", opacity: ext.opacity ? +ext.opacity : .9 },
      name: "频数",
      cumulative: { enabled: ext.cumulative ? true : false },
    }],
  };
}

/* ---- Box ---- */
function buildBox(data, c) {
  const xc = xVal(); const yc = yVals()[0];
  if (!yc) return null;
  const ext = c.ext || {};
  const traces = [];
  for (const g of data.groups) {
    const tr = { type: "box", name: g.name || yc, boxpoints: ext.showall ? "all" : "outliers", orientation: ext.horizontal ? "h" : "v" };
    if (xc && g.data[xc]) tr.x = g.data[xc].map(String);
    if (g.data[yc]) tr.y = g.data[yc].map(num);
    if (ext.horizontal && xc) { tr.y = g.data[xc].map(String); tr.x = g.data[yc].map(num); }
    traces.push(tr);
  }
  return { data: traces };
}

/* ---- Heatmap ---- */
function buildHeatmap(data, c) {
  // 需要 x 分类 + series 分类 + y 数值
  const xc = xVal(); const yc = yVals()[0];
  if (!xc || !seriesVal()) return null;
  const aggfn = AGG[aggVal()] || AGG.sum;
  const rowNames = data.groups.map(g => g.name);
  const colOrder = []; const colSet = new Set();
  for (const g of data.groups) for (let i = 0; i < (g.data[xc] || []).length; i++) {
    const k = String(g.data[xc][i]); if (!colSet.has(k)) { colSet.add(k); colOrder.push(k); }
  }
  const z = rowNames.map(gname => {
    const g = data.groups.find(x => x.name === gname);
    const row = [];
    for (const col of colOrder) {
      const arr = [];
      for (let i = 0; i < (g.data[xc] || []).length; i++) {
        if (String(g.data[xc][i]) === col) { const v = num(g.data[yc] && g.data[yc][i]); if (v !== null) arr.push(v); }
      }
      row.push(yc ? aggfn(arr) : arr.length);
    }
    return row;
  });
  const ext = c.ext || {};
  return {
    data: [{
      type: "heatmap", x: colOrder, y: rowNames, z,
      colorscale: ext.colorscale || "Viridis",
      text: z.map(r => r.map(v => v === null ? "" : fmtNum(v, 0))),
      texttemplate: "%{text}", textfont: { size: 10 },
      colorbar: { title: ext.cbarlabel || "" },
    }],
  };
}

/* ---- Radar ---- */
function buildRadar(data, c) {
  const yc = yVals(); const ext = c.ext || {};
  // 每 group = 一雷达层；若每组只有一个聚合点(无X)，无意义 -> 需要 X 作为变量
  const xc = xVal();
  const traces = [];
  const buildCat = (g) => {
    if (xc) {
      const m = new Map(); const order = [];
      for (let i = 0; i < (g.data[xc] || []).length; i++) {
        const k = String(g.data[xc][i]); if (!m.has(k)) { m.set(k, []); order.push(k); }
        const v = num(g.data[yc[0]] && g.data[yc[0]][i]); if (v !== null) m.get(k).push(v);
      }
      return order.map(k => [k, (AGG[aggVal()] || AGG.sum)(m.get(k))]);
    }
    // 无X：直接返回单点
    const one = num(g.data[yc[0]] && g.data[yc[0]][0]);
    return [["值", one]];
  };
  let maxTraces = 6;
  data.groups.slice(0, maxTraces).forEach((g, gi) => {
    const cat = buildCat(g);
    const theta = cat.map(c => c[0]); const r = cat.map(c => c[1]);
    traces.push({
      type: "scatterpolar", mode: "lines+markers",
      r, theta, name: g.name || (yc[0] + (gi ? "" : "")),
      fill: ext.fill ? "toself" : "none",
    });
  });
  // 若仅一组且无X，展示各 y 列
  if (traces.length === 0) return null;
  return { data: traces };
}

/* ---- Summary 表 ---- */
function buildSummary(data, c) {
  const numCols = yVals().filter(y => data.groups[0] && data.groups[0].data[y] !== undefined);
  const rows = [];
  for (const g of data.groups) {
    for (const y of numCols) {
      const arr = (g.data[y] || []).map(num).filter(isFinite);
      if (!arr.length) continue;
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      const sorted = [...arr].sort((a, b) => a - b);
      const med = sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      const sd = arr.length > 1 ? Math.sqrt(arr.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (arr.length - 1)) : 0;
      rows.push({ grp: g.name || "全部", col: y, count: arr.length, sum: arr.reduce((s, v) => s + v, 0), mean, median: med, sd, min: Math.min(...arr), max: Math.max(...arr) });
    }
  }
  // 表格数据以 scatter 无痕方式返回；用 html table 更直观 -> 直接以图表空 + 走 summary render
  return { data: [{}], table: rows };
}

/* ============================ 工具数值格式化 ============================ */
function fmtNum(v, dec) {
  if (v === null || v === undefined) return "";
  dec = dec == null ? 1 : +dec;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(dec) + "M";
  return Number(v).toLocaleString("en-US", { maximumFractionDigits: dec });
}

/* ============================ 容器布局/重建 ============================ */
function showHint() { $("plotHint").style.display = ""; $("plot").style.display = "none"; }

/* ============================ 初始化 ============================ */
function initExtControls() {
  const box = $("detailOpts");
  const type = S.curType;
  const defs = {
    bar: [
      ["stacked", "堆叠", "checkbox", false], ["horizontal", "横向", "checkbox", false],
      ["textshow", "显示数值", "checkbox", true], ["decimals", "小数位", "number", 0],
      ["catlabel", "类别名", "text", "类别"], ["vallabel", "值名", "text", "值"],
      ["opacity", "柱透明度", "range", 1], ["xtick", "X标签旋转", "number", 0],
      ["xlab", "X轴标题", "text", ""], ["ylab", "Y轴标题", "text", ""],
      ["legendh", "图例横排", "checkbox", false], ["logy", "Y对数轴", "checkbox", false],
    ],
    line: [
      ["showmarkers", "显示数据点", "checkbox", false], ["linecurved", "平滑曲线", "checkbox", false],
      ["linewidth", "线宽", "number", 2], ["logy", "Y对数轴", "checkbox", false],
      ["xlab", "X轴标题", "text", ""], ["ylab", "Y轴标题", "text", ""],
      ["legendh", "图例横排", "checkbox", false],
    ],
    area: [
      ["stacked", "堆叠", "checkbox", true], ["showmarkers", "显示数据点", "checkbox", false],
      ["linewidth", "线宽", "number", 2],
      ["xlab", "X轴标题", "text", ""], ["ylab", "Y轴标题", "text", ""],
    ],
    scatter: [
      ["opacity", "点透明度", "range", 0.85], ["bubscale", "气泡放大", "number", 1],
      ["xlab", "X轴标题", "text", ""], ["ylab", "Y轴标题", "text", ""],
    ],
    pie: [
      ["donut", "空心环(%)", "number", 0],
      ["textinfo", "标注", "select", "percent+label", ["percent+label", "percent", "label", "value", "percent+value"]],
    ],
    histogram: [
      ["bins", "分箱数", "number", 20], ["cumulative", "累计分布", "checkbox", false],
      ["opacity", "柱透明度", "range", 0.9],
    ],
    box: [
      ["showall", "显示全部点", "checkbox", false], ["horizontal", "横向", "checkbox", false],
    ],
    heatmap: [
      ["colorscale", "色带", "select", "Viridis", ["Viridis", "Blues", "RdBu", "Portland", "Electric", "Hot", "Cividis"]],
      ["cbarlabel", "色条名", "text", "值"],
    ],
    radar: [["fill", "填充", "checkbox", true]],
    pareto: [],
    summary: [],
    default: [],
  };
  const list = defs[type] || defs.default;
  box.innerHTML = "";
  list.forEach(([key, label, kind, def, opts]) => {
    let ctrl;
    if (kind === "checkbox") ctrl = `<input type="checkbox" data-cfg="${key}" ${def ? "checked" : ""}>`;
    else if (kind === "select") ctrl = `<select data-cfg="${key}">${(opts || []).map(o => `<option>${o}</option>`).join("")}</select>`;
    else if (kind === "number") ctrl = `<input type="number" data-cfg="${key}" value="${def}">`;
    else if (kind === "range") ctrl = `<input type="range" data-cfg="${key}" min="0" max="1" step="0.05" value="${def}">`;
    else ctrl = `<input type="text" data-cfg="${key}" value="${def}">`;
    box.insertAdjacentHTML("beforeend",
      kind === "checkbox"
        ? `<label class="opt-check">${ctrl} ${label}</label>`
        : `<div class="field"><label>${label}</label>${ctrl}</div>`);
  });
  box.querySelectorAll("input,select").forEach(el => el.addEventListener("change", debounce(buildPlot)));
}

function bindEvents() {
  $("btnOpen").onclick = openFile;
  $("btnDemo").onclick = loadDemo;
  $("btnReset").onclick = () => { $("inTitle").value = ""; };
  ["selX", "selY", "selSeries", "selAgg"].forEach(id => $(id).addEventListener("change", debounce(buildPlot)));
  ["inTitle", "inW", "inH", "selFont", "selBg", "selTheme"].forEach(id => {
    const el = $(id); el.addEventListener("input", debounce(buildPlot)); el.addEventListener("change", debounce(buildPlot));
  });
  $("inFontSize").addEventListener("input", debounce(buildPlot));
  $("btnPng").onclick = () => exportImg("png");
  $("btnSvg").onclick = () => exportImg("svg");
}

function exportImg(fmt) {
  const gd = $("plot");
  if (!S.schema) { toast("先加载数据", true); return; }
  const c = cfg();
  Plotly.downloadImage(gd, { format: fmt, filename: "chartcanvas_" + Date.now(), width: c.w, height: c.h, scale: 2 });
  toast("已导出 ." + fmt);
}

window.addEventListener("resize", debounce(() => {
  if (S.schema && $("plot").style.display !== "none") Plotly.Plots.resize($("plot"));
}, 200));

/* wait for pywebview */
function waitApi(cb, tries = 0) {
  if (window.pywebview && window.pywebview.api) return cb();
  if (tries > 60) return;
  setTimeout(() => waitApi(cb, tries + 1), 100);
}

function fwdErr(msg, src, line) {
  try { if (window.pywebview && window.pywebview.api) pywebview.api.log("ERR " + msg + " @ " + src + ":" + line); } catch (e) {}
}

document.addEventListener("DOMContentLoaded", () => {
  window.addEventListener("error", e => fwdErr(e.message, e.filename, e.lineno));
  window.addEventListener("unhandledrejection", e => fwdErr("PROMISE " + e.reason));
  fillAgg();
  buildTypeGrid();
  bindEvents();
  initExtControls();
  waitApi(() => {
    try { pywebview.api.version().then(v => console.log("backend", v)); } catch (e) {}
    // 自动载入示例（URL #auto 模式，验证用）
    if (window.location.hash === "#auto") { setTimeout(loadDemo, 300); window.__selftest = selftestAll; }
  });
});

/* ---- 各图类型自动化自检（开发/验证用，通过 __selftest() 触发） ---- */
async function selftestAll() {
  const log = m => { try { pywebview.api && pywebview.api.log(m); } catch (e) {} };
  log("SELFTEST_BEGIN");
  const catCols = S.cols.filter(c => c.dtype === "category").map(c => c.name);
  const numCols = S.cols.filter(c => c.dtype === "numeric").map(c => c.name);
  const xCat = catCols[0]; const xNum = numCols[0]; const y2 = numCols[1] || numCols[0];
  const ser = catCols[1] || catCols[0];
  const xSel = $("selX"), ySel = $("selY"), serSel = $("selSeries");
  const opts = [...ySel.options];
  const setY = (arr) => { opts.forEach(o => { o.selected = arr.includes(o.value); }); };
  const run = async (type) => {
    S.curType = type; initExtControls();
    try { await buildPlot(); log("SELFTEST " + type + ":OK"); }
    catch (e) { log("SELFTEST " + type + ":FAIL " + e); }
  };
  const pickType = id => { const b = [...document.querySelectorAll(".ctype")].find(e => e.textContent.includes(typeName(id))); if (b) b.classList.add("active"); };
  pickType("bar");

  // 逐类设置并测试
  xSel.value = xCat; serSel.value = ""; setY([xNum]); await run("bar");
  xSel.value = xCat; serSel.value = ser; setY([xNum, y2]); await run("line");
  xSel.value = xCat; serSel.value = ser; setY([xNum]); await run("area");
  xSel.value = xCat; serSel.value = ""; setY([xNum]); await run("pie");
  xSel.value = xCat; serSel.value = ""; setY([xNum]); await run("pareto");
  xSel.value = xNum; serSel.value = ""; setY([xNum]); await run("histogram");
  xSel.value = "";     serSel.value = ser; setY([xNum, y2]); await run("scatter");
  xSel.value = xCat; serSel.value = ""; setY([xNum]); await run("box");
  xSel.value = xCat; serSel.value = ser; setY([xNum]); await run("heatmap");
  xSel.value = xCat; serSel.value = ""; setY([xNum]); await run("radar");
  xSel.value = xCat; serSel.value = ""; setY([xNum]); await run("summary");
  log("SELFTEST_DONE");
}
function typeName(id) { const m = CHART_TYPES.find(x => x[0] === id); return m ? m[1] : id; }
