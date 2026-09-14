'use strict';

// ---------- Configuración ----------
const CATS_GASTO = ['Supermercado', 'Comidas afuera', 'Transporte', 'Alquiler y servicios', 'Salud', 'Suscripciones', 'Ropa', 'Ocio', 'Ahorro', 'Otros'];
const CATS_INGRESO = ['Sueldo', 'Ingreso extra', 'Otros ingresos'];
const CFG = window.MI_BOLSILLO_CONFIG || {};
const HAS_DB = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const money = n => fmt.format(Math.round(n));
function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' M';
  if (a >= 1e3) return '$' + Math.round(n / 1e3).toLocaleString('es-CO') + ' mil';
  return '$' + Math.round(n);
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
const thisMonth = () => todayISO().slice(0, 7);
function shiftMonth(key, delta) {
  let [y, m] = key.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad(m)}`;
}
function monthName(key, style = 'long') {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('es-CO', style === 'long' ? { month: 'long', year: 'numeric' } : { month: 'short' });
}
const longDate = iso => new Date(iso + 'T12:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function parseAmount(str) {
  // Acepta "150.000", "150000", "150 000" o "1500,50"
  const clean = String(str).trim().replace(/\s|\$/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(clean);
  return Number.isFinite(n) ? n : NaN;
}
// Minúsculas y sin tildes, para que "energia" encuentre "Energía"
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------- Estado ----------
const emptyState = () => ({ movimientos: [], presupuestos: {}, presupuestosEjemplo: false });
let state = emptyState();
let viewMonth = thisMonth();
let formTipo = 'gasto';
let editingId = null;
let filterCat = '';
let highlightCat = null;

// ---------- Copia en el celular y cola de cambios por subir ----------
let client = null;
let userId = null;
let outbox = [];
let flushing = false;
let syncError = false;

const cacheKey = () => `mb-cache-${userId || 'prueba'}`;
const outboxKey = () => `mb-outbox-${userId}`;
function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* almacenamiento lleno o bloqueado */ }
}
function loadUserData() {
  state = { ...emptyState(), ...readJSON(cacheKey(), {}) };
  outbox = userId ? readJSON(outboxKey(), []) : [];
}
const saveCache = () => writeJSON(cacheKey(), state);
const saveOutbox = () => { if (userId) writeJSON(outboxKey(), outbox); };

// Cada cambio se ve al instante y se sube a la nube cuando hay señal
function commit(op) {
  applyLocal(op);
  saveCache();
  render();
  if (userId) { outbox.push(op); saveOutbox(); flush(); }
}

function applyLocal(op) {
  switch (op.type) {
    case 'upsert':
      for (const m of op.rows) {
        const i = state.movimientos.findIndex(x => x.id === m.id);
        if (i >= 0) state.movimientos[i] = m; else state.movimientos.push(m);
      }
      break;
    case 'delete':
      state.movimientos = state.movimientos.filter(x => x.id !== op.id);
      break;
    case 'caps':
      state.presupuestos = op.topes;
      state.presupuestosEjemplo = !!op.ejemplo;
      break;
    case 'clearSample':
      state.movimientos = state.movimientos.filter(m => !m.ejemplo);
      if (op.resetCaps) { state.presupuestos = {}; state.presupuestosEjemplo = false; }
      break;
    case 'replaceAll':
      state = { movimientos: op.rows, presupuestos: op.topes, presupuestosEjemplo: false };
      break;
  }
}

async function runOp(op) {
  const check = ({ error }) => { if (error) throw error; };
  const now = new Date().toISOString();
  const toRow = m => ({
    id: m.id, user_id: userId, tipo: m.tipo, monto: Math.round(m.monto), categoria: m.categoria,
    fecha: m.fecha, nota: m.nota || '', ejemplo: !!m.ejemplo, actualizado: now,
  });
  const upsertRows = async rows => {
    for (let i = 0; i < rows.length; i += 500) check(await client.from('movimientos').upsert(rows.slice(i, i + 500).map(toRow)));
  };
  const caps = (topes, ejemplo) => client.from('presupuestos').upsert({ user_id: userId, topes, ejemplo, actualizado: now });

  switch (op.type) {
    case 'upsert': await upsertRows(op.rows); break;
    case 'delete': check(await client.from('movimientos').delete().eq('id', op.id)); break;
    case 'caps': check(await caps(op.topes, !!op.ejemplo)); break;
    case 'clearSample':
      check(await client.from('movimientos').delete().eq('ejemplo', true));
      if (op.resetCaps) check(await caps({}, false));
      break;
    case 'replaceAll':
      check(await client.from('movimientos').delete().eq('user_id', userId));
      await upsertRows(op.rows);
      check(await caps(op.topes, false));
      break;
  }
}

// Descarga todo de la nube; si mientras tanto llegó un cambio nuevo, no pisa nada
async function pull() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from('movimientos')
      .select('id,tipo,monto,categoria,fecha,nota,ejemplo')
      .order('fecha').order('id').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const { data: caps, error } = await client.from('presupuestos').select('topes,ejemplo').maybeSingle();
  if (error) throw error;
  if (outbox.length) return false;
  state = {
    movimientos: rows.map(r => ({ ...r, monto: Number(r.monto), nota: r.nota || '' })),
    presupuestos: (caps && caps.topes) || {},
    presupuestosEjemplo: !!(caps && caps.ejemplo),
  };
  saveCache();
  render();
  return true;
}

async function flush() {
  if (!client || !userId || flushing || !navigator.onLine) { updateSync(); return; }
  flushing = true;
  syncError = false;
  updateSync();
  try {
    let done = false;
    while (!done) {
      while (outbox.length) {
        await runOp(outbox[0]);
        outbox.shift();
        saveOutbox();
      }
      done = await pull();
    }
  } catch (e) {
    console.warn('No se pudo sincronizar', e);
    syncError = true;
  }
  flushing = false;
  updateSync();
}

function updateSync() {
  const el = $('sync');
  let kind, text;
  if (!HAS_DB) { kind = 'local'; text = 'Modo prueba: sin base de datos'; }
  else if (!navigator.onLine || !client) { kind = 'local'; text = outbox.length ? `Sin conexión · ${outbox.length} por subir` : 'Sin conexión · guardado en el celular'; }
  else if (flushing) { kind = 'loading'; text = 'Sincronizando…'; }
  else if (syncError) { kind = 'error'; text = 'No se pudo sincronizar · tocar para reintentar'; }
  else { kind = 'cloud'; text = 'Sincronizado'; }
  el.dataset.state = kind;
  el.textContent = text;
}

// ---------- Cálculos ----------
const inMonth = key => state.movimientos.filter(m => m.fecha.slice(0, 7) === key);
function totals(key) {
  let ingresos = 0, gastos = 0;
  for (const m of inMonth(key)) m.tipo === 'ingreso' ? ingresos += m.monto : gastos += m.monto;
  return { ingresos, gastos, queda: ingresos - gastos };
}
function byCategory(key) {
  const map = {};
  for (const m of inMonth(key)) if (m.tipo === 'gasto') map[m.categoria] = (map[m.categoria] || 0) + m.monto;
  const total = Object.values(map).reduce((a, b) => a + b, 0);
  return Object.entries(map)
    .map(([cat, monto]) => ({ cat, monto, pct: total ? monto / total * 100 : 0 }))
    .sort((a, b) => b.monto - a.monto);
}
function previousAverage(key) {
  // Promedio de gasto de los 6 meses anteriores; solo cuenta los meses que tienen movimientos cargados
  const months = [];
  for (let i = 1; i <= 6; i++) {
    const mk = shiftMonth(key, -i);
    if (inMonth(mk).length) months.push(totals(mk).gastos);
  }
  if (!months.length) return null;
  return { avg: months.reduce((a, b) => a + b, 0) / months.length, count: months.length };
}

// Una sola familia de color: mismo tono, distinta luminosidad
const shade = (i, n) => `hsl(205 ${62 - i * 2}% ${n <= 1 ? 62 : 74 - (i * 44 / (n - 1))}%)`;

// ---------- Render ----------
function render() {
  if ($('appView').hidden) return;
  const label = monthName(viewMonth).replace(' de ', ' ');
  $('monthLabel').textContent = label.charAt(0).toUpperCase() + label.slice(1);
  renderKpis();
  renderDonut();
  renderBars();
  renderList();
  // No redibujar los topes mientras se está escribiendo uno
  if (!document.activeElement || !document.activeElement.matches('[data-cap]')) renderBudgets();
  $('sampleNote').hidden = !(state.movimientos.some(m => m.ejemplo) || state.presupuestosEjemplo);
  $('emptyNote').hidden = state.movimientos.length > 0;
  if (!$('searchResults').hidden) renderSearch();
}

function renderKpis() {
  const t = totals(viewMonth);
  const movs = inMonth(viewMonth);
  $('kIngresos').textContent = money(t.ingresos);
  $('kGastos').textContent = money(t.gastos);
  const q = $('kQueda');
  q.textContent = money(t.queda);
  q.classList.toggle('neg', t.queda < 0);
  const nIn = movs.filter(m => m.tipo === 'ingreso').length;
  const nOut = movs.length - nIn;
  $('kIngresosSub').textContent = `${nIn} ${nIn === 1 ? 'movimiento' : 'movimientos'}`;
  $('kGastosSub').textContent = `${nOut} ${nOut === 1 ? 'movimiento' : 'movimientos'}`;
  $('kQuedaSub').textContent = t.ingresos ? `${Math.round(t.queda / t.ingresos * 100)}% de lo que entró` : 'sin ingresos cargados';

  const box = $('compare');
  const prev = previousAverage(viewMonth);
  if (!prev || prev.avg === 0) {
    box.innerHTML = `<div class="txt">Todavía no hay meses anteriores cargados para comparar.</div>`;
    return;
  }
  const diff = (t.gastos - prev.avg) / prev.avg * 100;
  const up = diff > 0;
  const partial = viewMonth === thisMonth();
  const base = prev.count === 6 ? 'los 6 meses anteriores' : `los ${prev.count} ${prev.count === 1 ? 'mes anterior' : 'meses anteriores'} con datos`;
  box.innerHTML = `
    <div class="big num ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(diff).toLocaleString('es-CO', { maximumFractionDigits: 1 })}%</div>
    <div class="txt">Vienes gastando <b>${up ? 'más' : 'menos'}</b> que el promedio de ${base}
      (<b class="num">${money(prev.avg)}</b>).${partial ? `<br>Ojo: el mes va por el día ${Number(todayISO().slice(8))}.` : ''}</div>`;
}

function renderDonut() {
  const el = $('donut');
  const data = byCategory(viewMonth);
  const total = data.reduce((a, b) => a + b.monto, 0);
  if (!total) { el.innerHTML = `<div class="empty">No hay gastos cargados en este mes.</div>`; return; }

  const r = 78, c = 2 * Math.PI * r, gap = data.length > 1 ? 2 : 0;
  let offset = 0;
  const segs = data.map((d, i) => {
    const len = d.monto / total * c;
    const seg = `<circle class="donut-seg" data-cat="${esc(d.cat)}" cx="100" cy="100" r="${r}" fill="none"
      stroke="${shade(i, data.length)}" stroke-width="30"
      stroke-dasharray="${Math.max(len - gap, 0.5)} ${c}" stroke-dashoffset="${-offset}"
      opacity="${highlightCat && highlightCat !== d.cat ? 0.35 : 1}"><title>${esc(d.cat)}: ${money(d.monto)}</title></circle>`;
    offset += len;
    return seg;
  }).join('');

  el.innerHTML = `
    <div class="donut-wrap">
      <svg viewBox="0 0 200 200" role="img" aria-label="Gastos por categoría">
        <g transform="rotate(-90 100 100)">${segs}</g>
        <text x="100" y="94" text-anchor="middle" fill="#8a92a3" font-size="11">Total gastos</text>
        <text x="100" y="116" text-anchor="middle" fill="#e8eaef" font-size="21" font-weight="650">${compact(total)}</text>
      </svg>
      <ul class="legend">
        ${data.map((d, i) => `
          <li data-cat="${esc(d.cat)}" class="${highlightCat === d.cat ? 'hl' : ''}">
            <span class="sw" style="background:${shade(i, data.length)}"></span>
            <span>${esc(d.cat)}</span>
            <span class="pct num">${d.pct.toLocaleString('es-CO', { maximumFractionDigits: 1 })}%</span>
            <span class="amt num">${money(d.monto)}</span>
          </li>`).join('')}
      </ul>
    </div>`;

  el.querySelectorAll('[data-cat]').forEach(node => {
    node.addEventListener('mouseenter', () => { highlightCat = node.dataset.cat; renderDonut(); });
    node.addEventListener('mouseleave', () => { highlightCat = null; renderDonut(); });
  });
}

function renderBars() {
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(shiftMonth(viewMonth, -i));
  const vals = months.map(k => totals(k).gastos);
  const prev = previousAverage(viewMonth);
  const max = Math.max(...vals, prev ? prev.avg : 0, 1) * 1.15;

  const W = 600, H = 250, top = 24, bottom = 34, left = 8, right = 8;
  const chartH = H - top - bottom;
  const slot = (W - left - right) / months.length;
  const bw = Math.min(58, slot * 0.56);
  const y = v => top + chartH - (v / max) * chartH;

  const bars = months.map((k, i) => {
    const x = left + slot * i + (slot - bw) / 2;
    const v = vals[i];
    const cur = k === viewMonth;
    const h = Math.max(top + chartH - y(v), v ? 2 : 0);
    const mes = monthName(k, 'short').replace('.', '');
    return `
      <rect x="${x}" y="${top + chartH - h}" width="${bw}" height="${h}" rx="5" fill="${cur ? 'hsl(205 70% 62%)' : 'hsl(205 35% 32%)'}"><title>${monthName(k)}: ${money(v)}</title></rect>
      <text x="${x + bw / 2}" y="${top + chartH - h - 7}" text-anchor="middle" font-size="12" fill="${cur ? '#e8eaef' : '#8a92a3'}" font-weight="${cur ? 600 : 400}">${v ? compact(v) : '—'}</text>
      <text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle" font-size="12" fill="${cur ? '#e8eaef' : '#8a92a3'}">${mes.charAt(0).toUpperCase() + mes.slice(1)}</text>`;
  }).join('');

  let avgLine = '';
  if (prev) {
    const ay = y(prev.avg);
    avgLine = `
      <line x1="${left}" x2="${W - right}" y1="${ay}" y2="${ay}" stroke="#8a92a3" stroke-dasharray="4 5" stroke-width="1"/>
      <line x1="${W - right - 150}" x2="${W - right - 126}" y1="8" y2="8" stroke="#8a92a3" stroke-dasharray="4 5" stroke-width="1"/>
      <text x="${W - right}" y="12" text-anchor="end" font-size="11" fill="#8a92a3">promedio ${compact(prev.avg)}</text>`;
  }

  $('barChart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gasto de los últimos 6 meses">
      <line x1="${left}" x2="${W - right}" y1="${top + chartH}" y2="${top + chartH}" stroke="#262b36"/>
      ${bars}${avgLine}
    </svg>`;
  $('barsNote').textContent = prev ? 'La línea punteada es el promedio de gasto de los 6 meses anteriores al mes que estás viendo.' : '';
}

function renderList() {
  const movs = inMonth(viewMonth);
  const sel = $('filterCat');
  const present = [...new Set(movs.map(m => m.categoria))];
  const ordered = [...CATS_GASTO, ...CATS_INGRESO].filter(c => present.includes(c))
    .concat(present.filter(c => !CATS_GASTO.includes(c) && !CATS_INGRESO.includes(c)));
  if (filterCat && !present.includes(filterCat)) filterCat = '';
  sel.innerHTML = `<option value="">Todas las categorías</option>` +
    ordered.map(c => `<option ${c === filterCat ? 'selected' : ''}>${esc(c)}</option>`).join('');

  const shown = movs
    .filter(m => !filterCat || m.categoria === filterCat)
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || (a.tipo === 'ingreso' ? -1 : 1));

  const ul = $('moves');
  if (!shown.length) {
    ul.innerHTML = `<li style="display:block" class="empty">No hay movimientos${filterCat ? ' en esta categoría' : ' en este mes'}.</li>`;
  } else {
    ul.innerHTML = shown.map(m => {
      const wd = new Date(m.fecha + 'T12:00').toLocaleDateString('es-CO', { weekday: 'short' }).replace('.', '');
      return `
      <li class="${m.id === editingId ? 'editing' : ''}" data-row="${esc(m.id)}">
        <div class="date"><b>${m.fecha.slice(8)}</b>${wd}</div>
        <div style="min-width:0">
          <div class="cat">${esc(m.categoria)}</div>
          ${m.nota ? `<div class="note" title="${esc(m.nota)}">${esc(m.nota)}</div>` : ''}
        </div>
        <div class="amount num ${m.tipo === 'ingreso' ? 'in' : ''}">${m.tipo === 'ingreso' ? '+' : '−'}${money(m.monto)}</div>
        <div class="acts">
          <button class="btn ghost small" data-edit="${esc(m.id)}">Editar</button>
          <button class="btn ghost small" data-del="${esc(m.id)}">Borrar</button>
        </div>
      </li>`;
    }).join('');
  }

  const g = shown.filter(m => m.tipo === 'gasto').reduce((a, b) => a + b.monto, 0);
  const i = shown.filter(m => m.tipo === 'ingreso').reduce((a, b) => a + b.monto, 0);
  $('listTotal').innerHTML =
    `<span>${shown.length} ${shown.length === 1 ? 'movimiento' : 'movimientos'}</span>
     <span>${i ? `Ingresos ${money(i)} · ` : ''}Gastos ${money(g)}</span>`;
}

function renderBudgets() {
  const spent = Object.fromEntries(byCategory(viewMonth).map(d => [d.cat, d.monto]));
  $('budgets').innerHTML = CATS_GASTO.map((cat, idx) => {
    const cap = state.presupuestos[cat] || 0;
    const s = spent[cat] || 0;
    const pct = cap ? s / cap * 100 : 0;
    const cls = !cap ? '' : pct > 100 ? 'over' : pct >= 80 ? 'warn' : '';
    let info;
    if (!cap) info = `<span>Llevas ${money(s)}</span><span>Sin tope</span>`;
    else if (pct > 100) info = `<span>${money(s)} de ${money(cap)}</span><span class="over">Te pasaste ${money(s - cap)}</span>`;
    else info = `<span>${money(s)} de ${money(cap)}</span><span class="${cls}">${Math.round(pct)}% · quedan ${money(cap - s)}</span>`;
    return `
      <div class="budget">
        <div class="b-top">
          <span class="b-name">${esc(cat)}</span>
          <label class="b-cap" for="cap${idx}">Tope
            <input id="cap${idx}" class="num" inputmode="numeric" data-cap="${esc(cat)}" value="${cap ? cap.toLocaleString('es-CO') : ''}" placeholder="sin tope">
          </label>
        </div>
        <div class="track"><div class="fill ${cls}" style="width:${cap ? Math.min(pct, 100) : 0}%"></div></div>
        <div class="b-info num">${info}</div>
      </div>`;
  }).join('');
}

// ---------- Buscador ----------
const searchInput = $('searchInput');

function searchMovs(q) {
  const terms = norm(q).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return state.movimientos.filter(m => {
    const [y, mo, d] = m.fecha.split('-');
    const haystack = norm([
      m.nota, m.categoria, m.tipo, longDate(m.fecha), monthName(m.fecha.slice(0, 7)),
      `${d}/${mo}/${y}`, m.fecha, Math.round(m.monto), Math.round(m.monto).toLocaleString('es-CO'),
    ].join(' '));
    return terms.every(t => haystack.includes(t));
  }).sort((a, b) => b.fecha.localeCompare(a.fecha));
}

// Resalta lo buscado dentro de un texto, ignorando tildes y mayúsculas
function highlight(text, q) {
  const terms = norm(q).trim().split(/\s+/).filter(t => t.length > 1);
  const src = String(text);
  const n = norm(src);
  if (!terms.length || n.length !== src.length) return esc(src);
  const marks = new Array(src.length).fill(false);
  for (const t of terms) {
    for (let i = n.indexOf(t); i !== -1; i = n.indexOf(t, i + 1)) marks.fill(true, i, i + t.length);
  }
  let out = '', open = false;
  for (let i = 0; i < src.length; i++) {
    if (marks[i] !== open) { out += marks[i] ? '<mark>' : '</mark>'; open = marks[i]; }
    out += esc(src[i]);
  }
  return out + (open ? '</mark>' : '');
}

function renderSearch() {
  const q = searchInput.value;
  const box = $('searchResults');
  $('searchClear').hidden = !q;
  if (!q.trim()) { box.hidden = true; return; }
  const found = searchMovs(q);
  box.hidden = false;
  if (!found.length) {
    box.innerHTML = `<div class="sr-empty">No encontré movimientos con «${esc(q.trim())}».</div>`;
    return;
  }
  const gastos = found.filter(m => m.tipo === 'gasto').reduce((a, b) => a + b.monto, 0);
  const ingresos = found.filter(m => m.tipo === 'ingreso').reduce((a, b) => a + b.monto, 0);
  const shown = found.slice(0, 60);
  box.innerHTML = `
    <div class="sr-head num">
      <span>${found.length} ${found.length === 1 ? 'resultado' : 'resultados'}${found.length > shown.length ? ` · mostrando ${shown.length}` : ''}</span>
      <span>${ingresos ? `+${money(ingresos)} · ` : ''}${gastos ? `−${money(gastos)}` : ''}</span>
    </div>
    <ul class="sr-list">
      ${shown.map(m => `
        <li><button type="button" class="sr-item" data-go="${esc(m.id)}">
          <span class="sr-title">${highlight(m.nota || m.categoria, q)}</span>
          <span class="sr-amount num ${m.tipo === 'ingreso' ? 'in' : ''}">${m.tipo === 'ingreso' ? '+' : '−'}${money(m.monto)}</span>
          <span class="sr-meta">
            <span class="chip">${highlight(m.categoria, q)}</span>
            <span>${longDate(m.fecha)}</span>
            <span>${m.tipo === 'ingreso' ? 'Ingreso' : 'Gasto'}</span>
          </span>
        </button></li>`).join('')}
    </ul>`;
}

function closeSearch() { $('searchResults').hidden = true; }

searchInput.addEventListener('input', renderSearch);
searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) renderSearch(); });
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { searchInput.value = ''; renderSearch(); searchInput.blur(); }
  if (e.key === 'Enter') { const first = $('searchResults').querySelector('[data-go]'); if (first) first.click(); }
});
$('searchClear').addEventListener('click', () => { searchInput.value = ''; renderSearch(); searchInput.focus(); });
$('searchResults').addEventListener('click', e => {
  const item = e.target.closest('[data-go]');
  if (!item) return;
  const m = state.movimientos.find(x => x.id === item.dataset.go);
  if (!m) return;
  closeSearch();
  searchInput.blur();
  // Lleva al mes del movimiento y lo abre para editar (por ejemplo, cambiarle la categoría)
  goMonth(m.fecha.slice(0, 7));
  startEdit(m.id);
  const row = $('moves').querySelector(`[data-row="${CSS.escape(m.id)}"]`);
  if (row) row.classList.add('flash');
});
document.addEventListener('click', e => { if (!$('search').contains(e.target)) closeSearch(); });

// ---------- Confirmación y avisos ----------
function ask(text, yesLabel = 'Sí') {
  const modal = $('modal');
  $('modalText').textContent = text;
  const yes = $('modalYes'), no = $('modalNo');
  yes.textContent = yesLabel;
  modal.hidden = false;
  no.focus();
  return new Promise(resolve => {
    const done = v => {
      modal.hidden = true;
      yes.onclick = no.onclick = modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = e => { if (e.key === 'Escape') done(false); };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    modal.onclick = e => { if (e.target === modal) done(false); };
    document.addEventListener('keydown', onKey);
  });
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- Formulario ----------
const form = $('moveForm');
const fMonto = $('fMonto');
const fCategoria = $('fCategoria');
const fFecha = $('fFecha');
const fNota = $('fNota');
const formError = $('formError');

function setTipo(tipo, keepCat) {
  formTipo = tipo;
  document.querySelectorAll('.type-toggle button').forEach(b => b.classList.toggle('on', b.dataset.tipo === tipo));
  const cats = tipo === 'gasto' ? CATS_GASTO : CATS_INGRESO;
  const prevCat = fCategoria.value;
  fCategoria.innerHTML = cats.map(c => `<option>${esc(c)}</option>`).join('');
  if (keepCat && cats.includes(keepCat)) fCategoria.value = keepCat;
  else if (cats.includes(prevCat)) fCategoria.value = prevCat;
}

function resetForm() {
  editingId = null;
  form.reset();
  setTipo(formTipo);
  fFecha.value = viewMonth === thisMonth() ? todayISO() : `${viewMonth}-01`;
  $('formTitle').textContent = 'Nuevo movimiento';
  $('submitBtn').textContent = 'Agregar';
  $('cancelEdit').hidden = true;
  $('editingNote').hidden = true;
  formError.textContent = '';
}

function startEdit(id) {
  const m = state.movimientos.find(x => x.id === id);
  if (!m) return;
  editingId = id;
  setTipo(m.tipo, m.categoria);
  fMonto.value = m.monto.toLocaleString('es-CO');
  fFecha.value = m.fecha;
  fNota.value = m.nota || '';
  $('formTitle').textContent = 'Editar movimiento';
  $('submitBtn').textContent = 'Guardar cambios';
  $('cancelEdit').hidden = false;
  $('editingNote').hidden = false;
  formError.textContent = '';
  renderList();
  form.closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.querySelectorAll('.type-toggle button').forEach(b => b.addEventListener('click', () => setTipo(b.dataset.tipo)));

// Formato de miles mientras se escribe
fMonto.addEventListener('input', () => {
  const digits = fMonto.value.replace(/[^\d]/g, '');
  fMonto.value = digits ? Number(digits).toLocaleString('es-CO') : '';
});

form.addEventListener('submit', e => {
  e.preventDefault();
  const monto = parseAmount(fMonto.value);
  if (!(monto > 0)) { formError.textContent = 'Pon un monto mayor que cero.'; fMonto.focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fFecha.value)) { formError.textContent = 'Elige una fecha.'; fFecha.focus(); return; }

  const wasEditing = !!editingId;
  const mov = { id: editingId || uid(), tipo: formTipo, monto: Math.round(monto), categoria: fCategoria.value, fecha: fFecha.value, nota: fNota.value.trim() };
  const mk = mov.fecha.slice(0, 7);
  commit({ type: 'upsert', rows: [mov] });
  if (mk !== viewMonth) { goMonth(mk); toast(`Guardado en ${monthName(mk)}`); }
  else { resetForm(); render(); toast(wasEditing ? 'Movimiento actualizado' : 'Movimiento agregado'); }
});

$('cancelEdit').addEventListener('click', () => { resetForm(); renderList(); });

$('moves').addEventListener('click', async e => {
  const edit = e.target.closest('[data-edit]');
  const del = e.target.closest('[data-del]');
  if (edit) startEdit(edit.dataset.edit);
  if (del) {
    const m = state.movimientos.find(x => x.id === del.dataset.del);
    if (!m) return;
    if (!await ask(`¿Borrar ${m.nota || m.categoria} de ${money(m.monto)} del ${m.fecha.slice(8)}/${m.fecha.slice(5, 7)}?`, 'Borrar')) return;
    if (editingId === m.id) resetForm();
    commit({ type: 'delete', id: m.id });
    toast('Movimiento borrado');
  }
});

$('filterCat').addEventListener('change', e => { filterCat = e.target.value; renderList(); });

$('budgets').addEventListener('change', e => {
  const input = e.target.closest('[data-cap]');
  if (!input) return;
  const v = input.value.trim() === '' ? 0 : parseAmount(input.value);
  if (!(v >= 0)) { renderBudgets(); return; }
  const topes = { ...state.presupuestos };
  if (v) topes[input.dataset.cap] = Math.round(v); else delete topes[input.dataset.cap];
  input.blur();
  commit({ type: 'caps', topes, ejemplo: false });
});
$('budgets').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[data-cap]')) e.target.blur();
});

// ---------- Navegación de meses ----------
function goMonth(key) {
  viewMonth = key;
  filterCat = '';
  resetForm();
  render();
}
$('prevMonth').addEventListener('click', () => goMonth(shiftMonth(viewMonth, -1)));
$('nextMonth').addEventListener('click', () => goMonth(shiftMonth(viewMonth, 1)));
$('todayMonth').addEventListener('click', () => goMonth(thisMonth()));

// ---------- Datos de ejemplo ----------
function buildSample() {
  const now = thisMonth();
  const rows = [];
  const add = (fecha, tipo, categoria, monto, nota = '') => rows.push({ id: 'ej-' + uid(), tipo, categoria, monto, fecha, nota, ejemplo: true });
  const today = Number(todayISO().slice(8));
  const d = day => `${now}-${pad(Math.min(day, today))}`;
  add(d(1), 'ingreso', 'Sueldo', 3200000, 'Sueldo del mes');
  add(d(1), 'gasto', 'Alquiler y servicios', 900000, 'Arriendo');
  add(d(2), 'gasto', 'Suscripciones', 38900, 'Streaming');
  add(d(3), 'gasto', 'Supermercado', 185400, 'Mercado grande');
  add(d(4), 'gasto', 'Transporte', 60000, 'Pasajes de la semana');
  add(d(5), 'gasto', 'Comidas afuera', 42000, 'Almuerzo');
  add(d(6), 'gasto', 'Salud', 95000, 'Farmacia');
  add(d(7), 'gasto', 'Alquiler y servicios', 142300, 'Energía');
  add(d(8), 'gasto', 'Ropa', 129900, 'Zapatos');
  add(d(8), 'gasto', 'Ocio', 55000, 'Cine');
  add(d(9), 'gasto', 'Supermercado', 96700);
  add(d(10), 'ingreso', 'Ingreso extra', 350000, 'Trabajo extra');
  add(d(10), 'gasto', 'Ahorro', 300000, 'Apartado del mes');
  add(d(11), 'gasto', 'Comidas afuera', 28500);
  add(d(11), 'gasto', 'Transporte', 45000);
  add(d(12), 'gasto', 'Alquiler y servicios', 68000, 'Agua');
  add(d(12), 'gasto', 'Suscripciones', 16900, 'Música');
  add(d(13), 'gasto', 'Otros', 35000, 'Regalo');
  add(d(13), 'gasto', 'Supermercado', 74200);
  add(d(14), 'gasto', 'Ocio', 40000);

  [0.97, 1.06, 0.91, 1.02, 0.88, 1.10].forEach((f, i) => {
    const mk = shiftMonth(now, -(i + 1));
    const md = day => `${mk}-${pad(day)}`;
    const v = n => Math.round(n * f / 100) * 100;
    add(md(1), 'ingreso', 'Sueldo', 3200000, 'Sueldo del mes');
    add(md(1), 'gasto', 'Alquiler y servicios', 900000, 'Arriendo');
    add(md(7), 'gasto', 'Alquiler y servicios', v(215000), 'Servicios');
    add(md(3), 'gasto', 'Supermercado', v(190000));
    add(md(16), 'gasto', 'Supermercado', v(170000));
    add(md(9), 'gasto', 'Transporte', v(130000));
    add(md(12), 'gasto', 'Comidas afuera', v(110000));
    add(md(2), 'gasto', 'Suscripciones', 55800);
    add(md(10), 'gasto', 'Ahorro', 300000, 'Apartado del mes');
    add(md(20), 'gasto', 'Ocio', v(90000));
    if (i % 2 === 0) add(md(18), 'gasto', 'Salud', v(70000));
    if (i % 3 === 1) add(md(22), 'gasto', 'Ropa', v(160000));
    add(md(25), 'gasto', 'Otros', v(40000));
  });

  const topes = {
    'Supermercado': 450000, 'Comidas afuera': 150000, 'Transporte': 150000,
    'Alquiler y servicios': 1150000, 'Salud': 120000, 'Suscripciones': 60000,
    'Ropa': 120000, 'Ocio': 100000, 'Ahorro': 300000, 'Otros': 80000,
  };
  return { rows, topes };
}

$('loadSample').addEventListener('click', () => {
  const { rows, topes } = buildSample();
  commit({ type: 'upsert', rows });
  if (!Object.keys(state.presupuestos).length) commit({ type: 'caps', topes, ejemplo: true });
  toast('Datos de ejemplo cargados');
});

$('clearSample').addEventListener('click', async () => {
  if (!await ask('¿Borrar todos los datos de ejemplo?\nLo que agregaste o editaste tú se queda.', 'Borrar ejemplo')) return;
  commit({ type: 'clearSample', resetCaps: state.presupuestosEjemplo });
  toast('Datos de ejemplo borrados');
});

// ---------- Exportar e importar ----------
$('exportBtn').addEventListener('click', async () => {
  const movimientos = state.movimientos.slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
  const data = JSON.stringify({ version: 1, exportado: new Date().toISOString(), movimientos, presupuestos: state.presupuestos }, null, 2);
  const filename = `mi-bolsillo-${todayISO()}.json`;
  const file = new File([data], filename, { type: 'application/json' });
  // En el celular abre el menú de compartir (Guardar en Archivos, WhatsApp, correo…)
  if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: filename }); } catch (e) { /* cancelado */ }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Archivo exportado');
});

const importFile = $('importFile');
$('importBtn').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('Ese archivo no es un JSON válido.'); return; }
  if (!data || !Array.isArray(data.movimientos)) { toast('El archivo no tiene una lista de movimientos.'); return; }
  const rows = data.movimientos.map(m => ({
    id: String(m.id || uid()),
    tipo: m.tipo === 'ingreso' ? 'ingreso' : 'gasto',
    monto: Math.round(Number(m.monto)),
    categoria: String(m.categoria || 'Otros'),
    fecha: String(m.fecha || ''),
    nota: m.nota ? String(m.nota).slice(0, 140) : '',
    ...(m.ejemplo ? { ejemplo: true } : {}),
  })).filter(m => m.monto > 0 && /^\d{4}-\d{2}-\d{2}$/.test(m.fecha));
  const skipped = data.movimientos.length - rows.length;
  if (!await ask(`Se van a cargar ${rows.length} movimientos${skipped ? ` (${skipped} inválidos se omiten)` : ''}.\nEsto reemplaza todo lo que hay ahora.`, 'Reemplazar')) return;
  const topes = {};
  for (const [k, v] of Object.entries(data.presupuestos || {})) if (Number(v) > 0) topes[k] = Math.round(Number(v));
  commit({ type: 'replaceAll', rows, topes });
  resetForm();
  toast('Datos importados');
});

// ---------- Cuenta ----------
let authMode = 'login';

function showAuth(message, ok) {
  $('appView').hidden = true;
  $('authView').hidden = false;
  document.body.classList.remove('loading');
  setAuthMessage(message || '', ok);
}
function showApp() {
  $('authView').hidden = true;
  $('appView').hidden = false;
  document.body.classList.remove('loading');
  $('logoutBtn').hidden = !HAS_DB;
  resetForm();
  render();
  updateSync();
}
function setAuthMessage(text, ok) {
  const el = $('authMsg');
  el.textContent = text;
  el.classList.toggle('ok', !!ok);
}
function authError(e) {
  const m = norm(e && e.message);
  if (m.includes('signup') && m.includes('not allowed')) return 'Los registros nuevos están cerrados en esta app.';
  if (m.includes('invalid login')) return 'Correo o contraseña incorrectos.';
  if (m.includes('not confirmed')) return 'Falta confirmar el correo: busca el mensaje de Supabase y toca el enlace.';
  if (m.includes('already registered')) return 'Ese correo ya tiene cuenta. Toca «Ya tengo cuenta» y entra.';
  if (m.includes('password')) return 'La contraseña debe tener al menos 6 caracteres.';
  if (m.includes('fetch') || m.includes('network')) return 'Sin conexión. Revisa tu señal e inténtalo otra vez.';
  return 'No se pudo: ' + (e && e.message);
}

$('authToggle').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'signup' : 'login';
  $('authSubmit').textContent = authMode === 'login' ? 'Entrar' : 'Crear cuenta';
  $('authToggle').textContent = authMode === 'login' ? '¿Primera vez? Crear cuenta' : 'Ya tengo cuenta';
  $('authPassword').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  setAuthMessage('');
});

$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!client) { setAuthMessage('Necesitas conexión para entrar la primera vez.'); return; }
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  const btn = $('authSubmit');
  btn.disabled = true;
  setAuthMessage('');
  try {
    if (authMode === 'login') {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) setAuthMessage(authError(error));
    } else {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) setAuthMessage(authError(error));
      else if (!data.session) setAuthMessage('Listo. Te llegó un correo para confirmar la cuenta: ábrelo, confirma y vuelve aquí a entrar.', true);
    }
  } catch (err) {
    setAuthMessage(authError(err));
  } finally {
    btn.disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  const pending = outbox.length ? `\nHay ${outbox.length} cambios sin subir: se suben la próxima vez que entres.` : '';
  if (!await ask('¿Cerrar sesión en este dispositivo?' + pending, 'Salir')) return;
  if (client) await client.auth.signOut({ scope: 'local' }).catch(() => {});
  signedOut();
});

$('sync').addEventListener('click', () => { if (syncError) flush(); });

function signedIn(user) {
  if (user.id === userId) return;
  userId = user.id;
  writeJSON('mb-last-user', { id: user.id });
  loadUserData();
  showApp();
  flush();
}
function signedOut() {
  userId = null;
  state = emptyState();
  showAuth();
}

// ---------- Arranque ----------
window.addEventListener('online', flush);
window.addEventListener('offline', updateSync);
// Al volver a la app trae lo que se haya anotado desde otro dispositivo
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });

async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  setTipo('gasto');

  if (!HAS_DB) { loadUserData(); showApp(); return; }

  if (window.supabase && window.supabase.createClient) {
    client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { if (userId) signedOut(); }
      else if (session) signedIn(session.user);
    });
    const { data } = await client.auth.getSession();
    if (data.session) signedIn(data.session.user);
    else if (!userId) showAuth();
    return;
  }

  // Sin señal y sin la librería guardada: se sigue con lo último que había en el celular
  const last = readJSON('mb-last-user', null);
  if (last) { userId = last.id; loadUserData(); showApp(); }
  else showAuth('Necesitas conexión para entrar la primera vez.');
}

boot();
