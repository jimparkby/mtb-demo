// Клиент демо Moby × KOPI: все расчёты и данные — на сервере (/api), здесь только отображение.
const PRESETS = [['Кофе', 640], ['Шаурма', 990], ['Такси', 1280], ['Продукты', 4730], ['Онлайн-заказ', 8915], ['Фастфуд', 1475]];
const TOPUPS = [2000, 5000, 10000, 50000];
const $ = (id) => document.getElementById(id);

let S = null;
let ticks = []; // курс за последний час: { t, BTC, ETH }
let prev = null; // прошлое состояние — чтобы подсветить, что выросло, а что упало

// Небольшие настройки посетителя: токен гостя, скрытый баланс, прочитанные уведомления
const store = {
  get(k) { try { return localStorage.getItem('moby.' + k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem('moby.' + k); else localStorage.setItem('moby.' + k, v); } catch { /* приватный режим */ } },
};

// Гостевая сессия: у каждого посетителя своя копия демо. Без токена сервер отвечает общим демо.
let token = store.get('token');
function setToken(t) { token = t; store.set('token', t); }

async function api(method, path, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith('/api/auth/')) {
    setToken(null); // гостевая сессия истекла — молча берём новую
    setTimeout(() => reload(), 0);
  }
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

const fmt = (k) => (k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (k) => Math.round(k / 100).toLocaleString('ru-RU');
const fmtQty = (q, a) => a === 'SAFE' ? fmt(q * 100) : q.toLocaleString('ru-RU', { maximumFractionDigits: a === 'BTC' ? 6 : 5 });
const fmtPct = (p) => (p >= 0 ? '+' : '') + p.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
const fmtSigned = (k) => (k >= 0 ? '+' : '−') + fmt(Math.abs(k));
const fmtWhen = (iso) => {
  const d = new Date(iso), today = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + time;
};
const assetLabel = (a) => a === 'SAFE' ? 'BYN' : a;
const icon = (name) => '<svg><use href="#i-' + name + '"/></svg>';

function toast(title, text) {
  const box = $('toasts');
  const el = document.createElement('div'); el.className = 'toast';
  el.innerHTML = '<span class="ti">' + icon('m') + '</span><div><b></b><span></span></div>';
  el.querySelector('b').textContent = title; el.querySelector(':scope > div > span').textContent = text;
  box.prepend(el);
  while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3600);
}
function toastPurchase(p) {
  toast('KOPI: куплено ' + (p.asset === 'SAFE' ? 'в консервативный' : p.asset) + ' на ' + fmt(p.amount) + ' BYN',
    p.asset === 'SAFE' ? 'Деньги работают на цель'
      : fmtQty(p.qty, p.asset) + ' ' + p.asset + ' по курсу ' + Math.round(p.rate).toLocaleString('ru-RU') + ' BYN');
}

// Подсвечивает элемент зелёным или красным, если число изменилось с прошлого рендера
function flash(el, now, before) {
  if (before == null || now === before) return;
  el.classList.remove('flash-up', 'flash-down'); void el.offsetWidth;
  el.classList.add(now > before ? 'flash-up' : 'flash-down');
}

function addTick(r) {
  if (r.source !== 'live' || !r.fetchedAt) return;
  if (ticks.length && ticks[ticks.length - 1].t >= r.fetchedAt) return;
  ticks.push({ t: r.fetchedAt, BTC: r.BTC, ETH: r.ETH });
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  while (ticks.length > 2 && ticks[0].t < hourAgo) ticks.shift();
}

// ---------- Главная ----------

let masked = store.get('masked') === '1';
function renderHome() {
  const { user, account, feed, totals, piggy } = S;
  $('userName').textContent = user.name;
  $('accProduct').textContent = account.product;
  $('accPan').textContent = '5*' + account.last4;
  const bal = $('balance');
  bal.textContent = masked ? '••••• BYN' : fmt(account.balance).replace(/\s/g, ' ') + ' BYN';
  bal.classList.toggle('masked', masked);
  if (prev && !masked) flash(bal, account.balance, prev.balance);
  $('eyeBtn').innerHTML = icon(masked ? 'eye' : 'eye-off');
  $('eyeBtn').setAttribute('aria-label', masked ? 'Показать баланс' : 'Скрыть баланс');

  const last = feed[0], op = $('lastOp');
  if (last) {
    op.querySelector('.op-ic').className = 'op-ic' + (last.type === 'topup' ? '' : ' out');
    op.querySelector('.op-ic svg use').setAttribute('href', last.type === 'topup' ? '#i-in' : '#i-wallet');
    op.querySelector('b').textContent = last.title;
    const v = op.querySelector('.op-v');
    v.textContent = fmtSigned(last.amount);
    v.classList.toggle('plus', last.amount > 0);
  }

  $('bannerKopi').textContent = totals.value || piggy
    ? 'В портфеле ' + fmt(totals.value) + ' BYN · в копилке ' + fmt(piggy) + ' BYN'
    : 'Инвестиции со сдачи с каждой покупки';
  $('bannerLive').hidden = S.rates.source !== 'live';
  $('accKopi').textContent = masked ? '••••• BYN' : fmt(totals.value + piggy) + ' BYN';
  const d = $('accKopiD');
  d.textContent = totals.invested ? fmtPct(totals.profitPct) : '';
  d.className = 'acc-d num ' + (totals.profitPct >= 0 ? 'up' : 'down');
  if (prev && !masked && prev.invested === totals.invested) flash($('accKopi'), totals.value, prev.value);
  $('prodKopi').textContent = 'Портфель ' + fmt(totals.value) + ' BYN, ' + S.stats.roundups + ' округлений';
}
$('eyeBtn').onclick = () => { masked = !masked; store.set('masked', masked ? '1' : null); renderHome(); };

// Лента операций по карте: оплата списывает покупку и сдачу, сдача видна отдельно
function renderOps(box, items) {
  box.innerHTML = '';
  if (!items.length) { box.innerHTML = '<p class="note">Пока пусто</p>'; return; }
  items.forEach((f) => {
    const r = document.createElement('div'); r.className = 'o';
    r.innerHTML = '<div class="ic ' + (f.type === 'topup' ? 'in' : 'out') + '">' + icon(f.type === 'topup' ? 'in' : 'wallet') + '</div><div class="t"><div></div><div class="s num"></div></div><div class="v num"></div>';
    r.querySelector('.t div').textContent = f.title;
    r.querySelector('.s').textContent = (f.type === 'topup' ? 'Зачисление' : 'Оплата картой') + ' · ' + fmtWhen(f.created_at);
    const v = r.querySelector('.v');
    v.textContent = fmtSigned(f.amount) + ' BYN';
    v.classList.toggle('plus', f.amount > 0);
    if (f.roundup > 0) { const s = document.createElement('small'); s.textContent = 'из них ' + fmt(f.roundup) + ' в KOPI'; v.appendChild(s); }
    box.appendChild(r);
  });
}

// Уведомления — последние операции; «прочитано» запоминается до времени последней операции
function renderNotices() {
  const seen = store.get('seen') ?? '';
  const unread = S.feed.filter((f) => f.created_at > seen).length;
  ['noticeBadge', 'noticeBadge2', 'noticeBadge3'].forEach((id) => {
    $(id).textContent = Math.min(unread, 9);
    $(id).classList.toggle('zero', !unread);
  });
  if (!$('notices').hidden) renderOps($('noticeList'), S.feed.slice(0, 12));
}

// ---------- KOPI ----------

// Сколько стоил бы текущий портфель по каждому тику курса — так видно, как меняется капитал
function renderSpark() {
  const svg = $('spark');
  const fixed = S.holdings.filter((h) => h.asset === 'SAFE').reduce((s, h) => s + h.value, 0);
  const crypto = S.holdings.filter((h) => h.asset !== 'SAFE' && h.qty > 0);
  const pts = ticks.map((t) => fixed + crypto.reduce((s, h) => s + Math.round(h.qty * t[h.asset] * 100), 0));
  if (pts.length < 2 || !crypto.length) {
    svg.toggleAttribute('hidden', true); // у SVG нет свойства hidden, только атрибут
    $('sparkFrom').textContent = crypto.length ? 'График появится через пару обновлений курса' : '';
    $('sparkDelta').textContent = '';
    return;
  }
  svg.toggleAttribute('hidden', false);
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const W = 300, H = 64, pad = 4;
  const xy = pts.map((v, i) => [i / (pts.length - 1) * W, pad + (1 - (v - min) / span) * (H - 2 * pad)]);
  const line = xy.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
  svg.querySelector('.line').setAttribute('d', line);
  svg.querySelector('.area').setAttribute('d', line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z');
  const d = pts[pts.length - 1] - pts[0];
  svg.classList.toggle('down', d < 0);
  $('sparkFrom').textContent = 'С ' + new Date(ticks[0].t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('sparkDelta').textContent = fmtSigned(d) + ' BYN (' + fmtPct(pts[0] ? d / pts[0] * 100 : 0) + ')';
}

function renderKopi() {
  const { totals, settings, goal, piggy, holdings, history, stats, rates } = S;
  const A = S.options.assets[settings.asset];

  $('totalValue').innerHTML = fmt(totals.value) + ' <small>BYN</small>';
  if (prev && prev.invested === totals.invested) flash($('totalValue'), totals.value, prev.value);
  const lb = $('liveBadge');
  lb.hidden = rates.source !== 'live';
  lb.classList.toggle('stale', !!rates.stale);
  $('liveSrc').textContent = (rates.stale ? 'Нет связи · ' : 'Live · ') + (rates.exchange || 'биржа');
  renderSpark();
  $('investedLine').textContent = 'Вложено ' + fmt(totals.invested) + ' BYN';
  $('deltaLine').textContent = fmtPct(totals.profitPct);
  $('deltaLine').className = 'delta num ' + (totals.profitPct >= 0 ? 'up' : 'down');

  $('assetNow').textContent = 'Вкладываем в ' + A.code;
  $('piggy').textContent = fmt(piggy) + ' BYN';
  $('piggyOf').textContent = 'покупка на ' + fmt(settings.threshold);
  $('piggyBar').style.width = Math.min(100, piggy / settings.threshold * 100) + '%';
  const bn = $('buyNow');
  bn.textContent = 'Купить ' + A.code + (piggy > 0 ? ' на ' + fmt(piggy) : '');
  bn.disabled = piggy <= 0;

  $('goalName').textContent = goal.name;
  $('goalOf').textContent = fmtInt(goal.saved) + ' из ' + fmtInt(goal.target) + ' BYN';
  $('goalPct').textContent = goal.pct.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
  $('goalBar').style.width = goal.pct + '%';
  $('goalHint').textContent = goal.saved >= goal.target ? 'Цель достигнута.'
    : goal.forecastMonths ? 'При 60 покупках в месяц цель будет достигнута примерно через ' + goal.forecastMonths + ' мес.'
    : 'Сделайте первую покупку, чтобы увидеть прогноз.';

  const as = $('assets'); as.innerHTML = '';
  holdings.forEach((h) => {
    if (!h.cost && h.asset !== settings.asset) return;
    const row = document.createElement('div'); row.className = 'asset';
    row.innerHTML = '<div class="coin ' + h.asset + '">' + assetLabel(h.asset) + '</div><div><b></b><div class="sub num"></div></div><div class="r"><b class="num"></b><div class="sub num"></div></div>';
    row.querySelectorAll('b')[0].textContent = h.name;
    row.querySelectorAll('.sub')[0].textContent = h.asset === 'SAFE' ? 'без изменения курса'
      : fmtQty(h.qty, h.asset) + ' ' + h.asset + ' · курс ' + Math.round(h.rate).toLocaleString('ru-RU') + ' BYN';
    row.querySelectorAll('b')[1].textContent = fmt(h.value) + ' BYN';
    if (h.asset !== 'SAFE') {
      flash(row.querySelectorAll('.sub')[0], h.rate, prev?.rates[h.asset]);
      if (prev?.qty[h.asset] === h.qty) flash(row.querySelectorAll('b')[1], h.value, prev.values[h.asset]);
    }
    const s2 = row.querySelectorAll('.sub')[1];
    const dd = h.cost ? (h.value - h.cost) / h.cost * 100 : 0;
    s2.textContent = h.cost ? fmtPct(dd) : 'пока пусто';
    s2.style.color = h.cost ? (dd >= 0 ? 'var(--good)' : 'var(--bad)') : '';
    as.appendChild(row);
  });

  const hl = $('hist'); hl.innerHTML = '';
  history.slice(0, 12).forEach((h) => {
    const r = document.createElement('div'); r.className = 'h';
    if (h.type === 'round') {
      r.innerHTML = '<div class="ic">↑</div><div class="t"><div></div><div class="s num"></div></div><div class="v num"></div>';
      r.querySelector('.t div').textContent = h.merchant;
      r.querySelector('.s').textContent = fmt(h.amount) + ' → ' + fmt(h.rounded) + ' BYN · ' + fmtWhen(h.created_at);
      r.querySelector('.v').textContent = '+' + fmt(h.roundup);
    } else {
      r.innerHTML = '<div class="ic buy"></div><div class="t"><div></div><div class="s num"></div></div><div class="v num" style="color:var(--blue-2)"></div>';
      r.querySelector('.ic').textContent = h.asset === 'BTC' ? '₿' : (h.asset === 'ETH' ? 'Ξ' : 'Br');
      r.querySelector('.t div').textContent = 'Покупка ' + (h.asset === 'SAFE' ? 'консервативного' : h.asset);
      r.querySelector('.s').textContent = (h.asset === 'SAFE' ? 'пакетом' : fmtQty(h.qty, h.asset) + ' ' + h.asset) + ' · ' + fmtWhen(h.created_at);
      r.querySelector('.v').textContent = fmt(h.amount) + ' BYN';
    }
    hl.appendChild(r);
  });
  $('histCount').textContent = stats.roundups + ' округлений';
}

function rateText(rates) {
  return rates.source === 'live'
    ? 'Курс реальный: ' + (rates.currency === 'BYN'
        ? 'BTC/BYN и ETH/BYN на ' + rates.exchange + ' (резидент ПВТ), середина между покупкой и продажей'
        : 'спот ' + (rates.exchange || 'биржи') + ' × официальный курс НБРБ (' + rates.usd.toLocaleString('ru-RU') + ' BYN за $1)')
      + ', обновляется каждые 5 секунд, последний раз в ' + new Date(rates.fetchedAt).toLocaleTimeString('ru-RU') + (rates.stale ? ' — сейчас биржи недоступны' : '') + '.'
    : 'Курс API недоступен, используется оценка на октябрь 2026.';
}

function renderRates() {
  const { rates } = S;
  const live = $('ratesLive');
  live.innerHTML = rates.source === 'live' ? '<i></i>' : '';
  live.append(rates.source === 'live' ? (rates.stale ? 'Нет связи · ' : 'Live · ') + (rates.exchange || 'биржа') : 'Оценка');
  live.classList.toggle('stale', !!rates.stale);
  const rows = [['BTC', 'Bitcoin', rates.BTC], ['ETH', 'Ethereum', rates.ETH]];
  if (rates.usd > 0) rows.push(['USD', 'Доллар США, НБРБ', rates.usd]);
  const box = $('ratesList'); box.innerHTML = '';
  rows.forEach(([code, name, v]) => {
    const r = document.createElement('div'); r.className = 'asset';
    r.innerHTML = '<div class="coin ' + code + '">' + (code === 'USD' ? '$' : code) + '</div><div><b></b><div class="sub"></div></div><div class="r"><b class="num"></b></div>';
    r.querySelector('b').textContent = name;
    r.querySelector('.sub').textContent = code + '/BYN';
    const b = r.querySelectorAll('b')[1];
    b.textContent = v.toLocaleString('ru-RU', { minimumFractionDigits: code === 'USD' ? 4 : 2, maximumFractionDigits: code === 'USD' ? 4 : 2 });
    if (code !== 'USD') flash(b, v, prev?.rates[code]);
    box.appendChild(r);
  });
  $('ratesNote').textContent = rateText(rates);
}

function render() {
  addTick(S.rates);
  renderHome();
  renderKopi();
  renderNotices();
  if (!$('feed').hidden) renderOps($('feedList'), S.feed);
  if (!$('rates').hidden) renderRates();
  const { user, settings, account } = S;
  $('cardPan').textContent = '5••• •••• •••• ' + account.last4;
  $('cardHolder').textContent = user.name;
  $('cardBal').textContent = 'Доступно ' + fmt(account.balance) + ' BYN';
  $('cardRule').textContent = 'KOPI: округление до ' + fmtInt(settings.round_step) + ' BYN' + (settings.multiplier > 1 ? ' ×' + settings.multiplier : '');
  $('rateNote').textContent = 'Демо: оплаты и остаток на карте эмулируются, деньги не списываются. ' + rateText(S.rates)
    + ' Покупка криптовалюты в продукте — через биржу-резидента ПВТ.';
  renderSettings();
  prev = {
    invested: S.totals.invested, value: S.totals.value, balance: account.balance, rates: { ...S.rates },
    qty: Object.fromEntries(S.holdings.map((h) => [h.asset, h.qty])),
    values: Object.fromEntries(S.holdings.map((h) => [h.asset, h.value])),
  };
}

// ---------- Настройки копилки ----------

async function patchSettings(patch) {
  try { S = await api('PATCH', '/api/settings', patch); render(); }
  catch (e) { toast('Не удалось сохранить', e.message); }
}

function chipGroup(id, items, current, onPick) {
  const box = $(id); box.innerHTML = '';
  items.forEach(([val, label]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(val === current));
    b.onclick = () => onPick(val);
    box.appendChild(b);
  });
}
function renderSettings() {
  const { settings, options, goal } = S;
  chipGroup('steps', options.steps.map((v) => [v, fmtInt(v) + ' BYN']), settings.round_step, (v) => patchSettings({ round_step: v }));
  chipGroup('mults', options.multipliers.map((v) => [v, '×' + v]), settings.multiplier, (v) => patchSettings({ multiplier: v }));
  chipGroup('thresholds', options.thresholds.map((v) => [v, fmtInt(v) + ' BYN']), settings.threshold, (v) => patchSettings({ threshold: v }));
  const ao = $('assetOpts'); ao.innerHTML = '';
  Object.entries(options.assets).forEach(([a, info]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt';
    b.setAttribute('aria-pressed', String(settings.asset === a));
    b.innerHTML = '<div class="coin ' + a + '">' + assetLabel(a) + '</div><div><b></b><span></span></div>';
    b.querySelector('b').textContent = info.name; b.querySelector('span').textContent = info.desc;
    b.onclick = () => patchSettings({ asset: a });
    ao.appendChild(b);
  });
  const gn = $('goalNameInput'), ga = $('goalAmountInput');
  if (document.activeElement !== gn) gn.value = goal.name;
  if (document.activeElement !== ga) ga.value = Math.round(goal.target / 100);
}

// Цель: сохраняем с небольшой задержкой, пока пользователь печатает
let goalTimer;
function saveGoal() {
  clearTimeout(goalTimer);
  goalTimer = setTimeout(async () => {
    const name = $('goalNameInput').value.trim();
    const n = parseInt($('goalAmountInput').value.replace(/\D/g, ''), 10);
    if (!name || !(n > 0)) return;
    try { S = await api('PUT', '/api/goal', { name, target: n * 100 }); render(); }
    catch (e) { toast('Цель не сохранена', e.message); }
  }, 400);
}
$('goalNameInput').addEventListener('input', saveGoal);
$('goalAmountInput').addEventListener('input', saveGoal);

let resetArmed = false;
$('resetBtn').onclick = async (e) => {
  if (!resetArmed) { resetArmed = true; e.target.textContent = 'Нажмите ещё раз, чтобы сбросить'; setTimeout(() => { resetArmed = false; e.target.textContent = 'Начать демо заново'; }, 3000); return; }
  resetArmed = false; e.target.textContent = 'Начать демо заново';
  try { S = await api('POST', '/api/reset'); store.set('seen', null); render(); toast('Демо сброшено', 'Снова неделя покупок Ивана'); }
  catch (err) { toast('Не удалось сбросить', err.message); }
};

$('buyNow').onclick = async () => {
  try { const r = await api('POST', '/api/purchases'); S = r.state; render(); toastPurchase(r.purchase); }
  catch (e) { toast('Покупка не прошла', e.message); }
};

// ---------- Оплата и пополнение ----------

PRESETS.forEach(([n, a]) => {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
  b.textContent = n + ' ' + fmt(a);
  b.onclick = () => { $('amountInput').value = fmt(a); pay(n); };
  $('presets').appendChild(b);
});

let busy = false;
async function pay(merchant) {
  if (busy) return;
  const err = $('payError'), btn = $('payBtn');
  busy = true; btn.disabled = true; err.textContent = '';
  try {
    const r = await api('POST', '/api/payments', { merchant, amount: $('amountInput').value });
    S = r.state; render();
    const { payment: p, purchase } = r;
    const rc = $('receipt'); rc.innerHTML = '';
    const rows = [['Покупка · ' + p.merchant, fmt(p.amount) + ' BYN'], ['Округлено до', fmt(p.rounded) + ' BYN']];
    if (p.multiplier > 1) rows.push(['Множитель', '×' + p.multiplier]);
    rows.push(['Списано с карты', fmt(p.amount + p.roundup) + ' BYN']);
    rows.forEach(([l, v]) => { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = '<span></span><b></b>'; d.children[0].textContent = l; d.children[1].textContent = v; rc.appendChild(d); });
    const t = document.createElement('div'); t.className = 'row total'; t.innerHTML = '<span>В копилку KOPI</span><b></b>';
    t.querySelector('b').textContent = '+' + fmt(p.roundup) + ' BYN'; rc.appendChild(t);
    if (purchase) {
      const d = document.createElement('div'); d.className = 'note';
      d.textContent = 'Копилка набрала ' + fmt(purchase.amount) + ' BYN: куплено ' + (purchase.asset === 'SAFE' ? 'консервативного инструмента' : fmtQty(purchase.qty, purchase.asset) + ' ' + purchase.asset) + ' одним пакетом.';
      rc.appendChild(d);
    }
    rc.hidden = false; rc.style.animation = 'none'; void rc.offsetWidth; rc.style.animation = '';
    toast('Оплата ' + fmt(p.amount) + ' BYN · ' + p.merchant, p.roundup > 0 ? 'В копилку KOPI +' + fmt(p.roundup) + ' BYN. Всего в копилке ' + fmt(S.piggy) + ' BYN' : 'Сумма уже круглая, сдачи нет');
    if (purchase) setTimeout(() => toastPurchase(purchase), 700);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    busy = false; btn.disabled = false;
  }
}
$('payBtn').onclick = () => pay('Покупка');
$('amountInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') pay('Покупка'); });

TOPUPS.forEach((a) => {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
  b.textContent = '+' + fmtInt(a) + ' BYN';
  b.onclick = () => { $('topInput').value = fmtInt(a); };
  $('topPresets').appendChild(b);
});
async function topUp() {
  if (busy) return;
  const err = $('topError'), btn = $('topBtn');
  busy = true; btn.disabled = true; err.textContent = '';
  try {
    const r = await api('POST', '/api/topups', { title: 'Пополнение с карты другого банка', amount: $('topInput').value });
    S = r.state; render();
    closeSheet();
    toast('Зачисление ' + fmt(r.topup.amount) + ' BYN', 'Доступно ' + fmt(S.account.balance) + ' BYN');
  } catch (e) {
    err.textContent = e.message;
  } finally {
    busy = false; btn.disabled = false;
  }
}
$('topBtn').onclick = topUp;
$('topInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') topUp(); });

// ---------- Чат: простой бот, отвечает по данным копилки ----------

const QUICK = ['Сколько в копилке?', 'Как работает округление?', 'Какой курс BTC?', 'Мой баланс'];
function botReply(text) {
  const q = text.toLowerCase();
  if (!S) return 'Секунду, загружаю данные…';
  if (/копилк|сдач|накоп/.test(q)) return 'В копилке ' + fmt(S.piggy) + ' BYN. Покупка ' + S.options.assets[S.settings.asset].code + ' пройдёт, когда наберётся ' + fmt(S.settings.threshold) + ' BYN. В портфеле ' + fmt(S.totals.value) + ' BYN (' + fmtPct(S.totals.profitPct) + ').';
  if (/округл|как работ|kopi|копи/.test(q)) return 'Каждая оплата картой округляется вверх до ' + fmtInt(S.settings.round_step) + ' BYN' + (S.settings.multiplier > 1 ? ' и умножается на ' + S.settings.multiplier : '') + '. Разница уходит в копилку KOPI и одним пакетом покупает BTC, ETH или консервативный инструмент. Например, кофе за 6,40 → 7,00, в копилку 0,60.';
  if (/курс|btc|eth|биткоин|эфир/.test(q)) return 'BTC: ' + Math.round(S.rates.BTC).toLocaleString('ru-RU') + ' BYN, ETH: ' + Math.round(S.rates.ETH).toLocaleString('ru-RU') + ' BYN' + (S.rates.exchange ? ' (' + S.rates.exchange + ')' : '') + '.';
  if (/баланс|остат|деньг/.test(q)) return 'На карте ' + S.account.product + ' доступно ' + fmt(S.account.balance) + ' BYN.';
  if (/цел/.test(q)) return 'Цель «' + S.goal.name + '»: ' + fmtInt(S.goal.saved) + ' из ' + fmtInt(S.goal.target) + ' BYN.' + (S.goal.forecastMonths ? ' Примерно ' + S.goal.forecastMonths + ' мес. до цели.' : '');
  if (/привет|здравств|добр/.test(q)) return 'Здравствуйте, ' + S.user.name.split(' ')[0] + '! Спросите про копилку, курс или баланс.';
  return 'Это демо-чат: я отвечаю про копилку KOPI, округление, курс BTC/ETH, баланс и цель.';
}
function addMsg(text, who) {
  $('chatEmpty').hidden = true;
  const m = document.createElement('div'); m.className = 'msg ' + who;
  if (who === 'bot') { const b = document.createElement('b'); b.textContent = 'Moby · помощник'; m.appendChild(b); }
  m.append(text);
  $('msgs').appendChild(m);
  m.scrollIntoView({ block: 'end', behavior: 'smooth' });
}
function ask(text) {
  if (!text.trim()) return;
  addMsg(text, 'me');
  setTimeout(() => addMsg(botReply(text), 'bot'), 450);
}
QUICK.forEach((t) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.onclick = () => ask(t); $('quick').appendChild(b); });
$('composer').onsubmit = (e) => { e.preventDefault(); ask($('msgInput').value); $('msgInput').value = ''; };

// ---------- Навигация: вкладки дока, подэкраны поверх, шторки снизу ----------

const TABS = ['home', 'products', 'chat', 'more'];
const stack = [];
function showTab(id) {
  TABS.forEach((t) => $(t).hidden = t !== id);
  document.querySelectorAll('.dock button').forEach((b) => b.toggleAttribute('aria-current', b.dataset.tab === id));
  document.querySelector('.dock [aria-current]')?.setAttribute('aria-current', 'page');
  while (stack.length) $(stack.pop()).hidden = true;
  window.scrollTo({ top: 0 });
}
function openSub(id) {
  closeSheet();
  if (stack.at(-1) === id) return;
  const i = stack.indexOf(id);
  if (i >= 0) stack.splice(i).forEach((s) => $(s).hidden = true);
  stack.push(id);
  $(id).hidden = false; $(id).scrollTop = 0;
  if (!S) return;
  if (id === 'feed') renderOps($('feedList'), S.feed);
  if (id === 'rates') renderRates();
  if (id === 'notices') { renderOps($('noticeList'), S.feed.slice(0, 12)); store.set('seen', S.feed[0]?.created_at ?? null); renderNotices(); }
}
function closeSub() { const id = stack.pop(); if (id) $(id).hidden = true; }
let sheet = null;
function openSheet(id) {
  closeSheet();
  sheet = id; $(id).hidden = false; $('scrim').hidden = false;
  if (id === 'pay') { $('receipt').hidden = true; $('payError').textContent = ''; }
  if (id === 'topup') $('topError').textContent = '';
}
function closeSheet() { if (!sheet) return; $(sheet).hidden = true; $('scrim').hidden = true; sheet = null; }
$('scrim').onclick = closeSheet;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (sheet) closeSheet(); else closeSub(); } });

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tab],[data-open],[data-sheet],[data-close],[data-soon]');
  if (!el) return;
  if (el.dataset.tab) showTab(el.dataset.tab);
  else if (el.dataset.open) openSub(el.dataset.open);
  else if (el.dataset.sheet) openSheet(el.dataset.sheet);
  else if (el.hasAttribute('data-close')) closeSub();
  else if (el.dataset.soon) toast(el.dataset.soon, 'В демо этот раздел не подключён — попробуйте копилку KOPI');
});

// Точки под каруселью продуктов
const car = $('carousel');
car.addEventListener('scroll', () => {
  const i = Math.round(car.scrollLeft / car.clientWidth);
  [...$('dots').children].forEach((d, j) => d.classList.toggle('on', i === j));
}, { passive: true });

// Прямые ссылки для QR: #kopi, #pay, #products, #chat, #more
const hash = location.hash.slice(1);
if (TABS.includes(hash)) showTab(hash);
else if (hash === 'pay' || hash === 'topup') openSheet(hash);
else if (['kopi', 'kopiSettings', 'rates', 'feed'].includes(hash)) openSub(hash);

// ---------- Загрузка и живое обновление ----------

// Каждый посетитель получает свою копию демо, чтобы зал по QR не мешал друг другу.
// Если сервер не выдал гостя — показываем общее демо.
async function ensureSession() {
  if (token) return;
  try { setToken((await api('POST', '/api/auth/guest')).token); } catch { /* общее демо без токена */ }
}

async function reload() {
  prev = null;
  await ensureSession();
  S = await api('GET', '/api/state');
  // При первом входе непрочитанными считаются 4 последние операции
  if (store.get('seen') == null && S.feed[4]) store.set('seen', S.feed[4].created_at);
  render();
}

try {
  ticks = (await api('GET', '/api/ticks').catch(() => ({ ticks: [] }))).ticks ?? [];
  await reload();
}
catch (e) { toast('Сервер недоступен', e.message); }

// Курс и стоимость портфеля обновляются сами, пока вкладка открыта
const REFRESH_MS = 5_000;
async function refresh() {
  if (document.hidden || busy) return;
  try { S = await api('GET', '/api/state'); render(); } catch { /* следующая попытка через REFRESH_MS */ }
}
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', refresh);
