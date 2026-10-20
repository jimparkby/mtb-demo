// Демо-банк в браузере: счёт карты, оплаты с округлением, копилка и пакетные покупки.
// Данные каждого посетителя лежат у него в localStorage — у каждого своя копия демо Ивана.
// Все суммы — в копейках (целые), курсы — BYN за 1 единицу актива.
import {
  ASSETS, STEPS, MULTIPLIERS, THRESHOLDS,
  roundUp, quantity, positionValue, shouldBuy, forecastMonths, parseAmount,
} from './engine.js';

export const MAX_TOPUP = 1_000_000; // 10 000 BYN за раз
const KEY = 'data';
const VERSION = 1;

// storage — { get(key), set(key, value) } с JSON-значениями; rates — из rates.js
export function createBank({ storage, rates, now = () => Date.now() }) {
  const nowIso = () => new Date(now()).toISOString();
  let d = storage.get(KEY);
  if (d?.v !== VERSION) d = null;
  const save = () => storage.set(KEY, d);
  const nextId = () => ++d.seq;

  const piggyOf = () => d.payments.filter((p) => p.purchase_id == null).reduce((s, p) => s + p.roundup, 0);

  // Вся копилка покупается одной операцией по текущему курсу («бумажный» брокер)
  function buyPiggy(rate, at) {
    const amount = piggyOf();
    if (amount <= 0) return null;
    const asset = d.settings.asset;
    const r = asset === 'SAFE' ? 1 : rate[asset];
    const purchase = { id: nextId(), asset, amount, rate: r, qty: quantity(amount, asset, r),
      rate_source: rate.exchange ?? rate.source, status: 'filled', created_at: at };
    d.purchases.push(purchase);
    d.payments.forEach((p) => { if (p.purchase_id == null) p.purchase_id = purchase.id; });
    return purchase;
  }

  // Оплата картой: с карты списывается покупка и сдача, сдача — в копилку; при пороге — покупка
  function pay({ merchant, amount }, rate, at = nowIso()) {
    const { rounded, roundup } = roundUp(amount, d.settings.round_step, d.settings.multiplier);
    if (d.user.balance < amount + roundup) throw new Error('Недостаточно средств на карте');
    d.user.balance -= amount + roundup;
    const payment = { id: nextId(), merchant, amount, rounded, roundup, multiplier: d.settings.multiplier, purchase_id: null, created_at: at };
    d.payments.push(payment);
    const purchase = shouldBuy(piggyOf(), d.settings.threshold) ? buyPiggy(rate, at) : null;
    return { payment, purchase };
  }

  function topUp({ title, amount }, at = nowIso()) {
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_TOPUP) throw new Error('Сумма пополнения — от 0,01 до 10 000 BYN');
    const topup = { id: nextId(), title, amount, created_at: at };
    d.topups.push(topup);
    d.user.balance += amount;
    return topup;
  }

  // Демо-данные: зарплата, три прошлые пакетные покупки и неделя покупок Ивана.
  // Прошлые покупки считаются от текущего курса (на 2,4% ниже), чтобы доходность была правдоподобной.
  function fillDemo(rate) {
    d = { v: VERSION, seq: 0,
      user: { name: 'Иван К.', card_last4: '4821', balance: 0 },
      settings: { round_step: 100, multiplier: 1, asset: 'BTC', threshold: 2000 },
      goal: { name: 'Ноутбук', target: 200000 },
      payments: [], purchases: [], topups: [] };
    const day = 86_400_000, start = now() - 10 * day;
    const past = { ...rate, BTC: rate.BTC / 1.024, ETH: rate.ETH / 1.024, source: 'seed', exchange: 'seed' };
    topUp({ title: 'Зарплата', amount: 145000 }, new Date(start).toISOString());
    for (let i = 0; i < 3; i++) {
      const at = new Date(start + i * day).toISOString();
      d.purchases.push({ id: nextId(), asset: 'BTC', amount: 2000, rate: past.BTC, qty: quantity(2000, 'BTC', past.BTC), rate_source: 'seed', status: 'filled', created_at: at });
    }
    const week = [['Продукты', 4730], ['Кофе', 640], ['Такси', 1280], ['Шаурма', 990], ['Фастфуд', 1475], ['Продукты', 3215],
      ['Кофе', 640], ['Онлайн-заказ', 8915], ['Такси', 1640], ['Кофе', 720], ['Продукты', 2860], ['Фастфуд', 1185]];
    week.forEach(([merchant, amount], i) => pay({ merchant, amount }, past, new Date(start + 3 * day + i * day / 2).toISOString()));
    topUp({ title: 'PEREVOD BSB', amount: 2500 }, new Date(now() - 3_600_000).toISOString());
    save();
  }

  function state(rate, { historyLimit = 20 } = {}) {
    const { user, settings, goal } = d;
    const piggy = piggyOf();
    const holdings = Object.keys(ASSETS).map((asset) => {
      const own = d.purchases.filter((p) => p.asset === asset && p.status === 'filled');
      const qty = own.reduce((s, p) => s + p.qty, 0), cost = own.reduce((s, p) => s + p.amount, 0);
      return { asset, ...ASSETS[asset], qty, cost, buys: own.length, rate: rate[asset], value: positionValue(asset, qty, cost, rate[asset]) };
    });
    const invested = holdings.reduce((s, h) => s + h.cost, 0);
    const value = holdings.reduce((s, h) => s + h.value, 0);
    const avg = d.payments.length ? d.payments.reduce((s, p) => s + p.roundup, 0) / d.payments.length : 0;
    const saved = invested + piggy;
    const desc = (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id;
    const payments = [...d.payments].sort(desc).slice(0, historyLimit);
    const history = [
      ...payments.map((p) => ({ type: 'round', ...p })),
      ...[...d.purchases].sort(desc).slice(0, historyLimit).map((p) => ({ type: 'buy', ...p })),
    ].sort(desc).slice(0, historyLimit);
    // Лента операций по карте: оплаты (вместе со сдачей) и пополнения
    const feed = [
      ...payments.map((p) => ({ type: 'payment', id: p.id, title: p.merchant, amount: -(p.amount + p.roundup), roundup: p.roundup, created_at: p.created_at })),
      ...d.topups.map((t) => ({ type: 'topup', ...t })),
    ].sort(desc).slice(0, historyLimit);

    return {
      user: { name: user.name, card_last4: user.card_last4, is_demo: true },
      account: { balance: user.balance, currency: 'BYN', product: 'Prime Line BYN', last4: user.card_last4 },
      feed,
      settings: { ...settings },
      piggy,
      totals: { invested, value, profitPct: invested ? (value - invested) / invested * 100 : 0 },
      holdings,
      goal: { ...goal, saved, pct: Math.min(100, saved / goal.target * 100), forecastMonths: forecastMonths(saved, goal.target, avg) },
      stats: { roundups: d.payments.length, avgRoundup: Math.round(avg) },
      history,
      rates: rate,
      options: { assets: ASSETS, steps: STEPS, multipliers: MULTIPLIERS, thresholds: THRESHOLDS },
    };
  }

  // Каждая операция берёт свежий курс, при первом входе создаёт демо
  async function run(fn) {
    const rate = await rates.current();
    if (!d) fillDemo(rate);
    const out = fn(rate) ?? {};
    save();
    return { ...out, state: state(rate) };
  }

  const amountOf = (body) => Number.isInteger(body.amountKop) ? body.amountKop : parseAmount(body.amount);

  return {
    state: async () => (await run(() => {})).state,

    payment: (body) => run((rate) => {
      const amount = amountOf(body);
      if (!amount) throw new Error('Введите сумму покупки, например 6,40');
      const merchant = String(body.merchant ?? 'Покупка').trim().slice(0, 40) || 'Покупка';
      return pay({ merchant, amount }, rate);
    }),

    topUp: (body) => run(() => {
      const amount = amountOf(body);
      if (!amount) throw new Error('Введите сумму пополнения, например 50');
      const title = String(body.title ?? 'Пополнение').trim().slice(0, 40) || 'Пополнение';
      return { topup: topUp({ title, amount }) };
    }),

    buyNow: () => run((rate) => {
      const purchase = buyPiggy(rate, nowIso());
      if (!purchase) throw new Error('Копилка пуста');
      return { purchase };
    }),

    updateSettings: async (patch) => (await run(() => {
      const next = { ...d.settings };
      for (const k of ['round_step', 'multiplier', 'asset', 'threshold']) if (patch[k] != null) next[k] = patch[k];
      if (!STEPS.includes(next.round_step)) throw new Error('round_step must be one of ' + STEPS);
      if (!MULTIPLIERS.includes(next.multiplier)) throw new Error('multiplier must be one of ' + MULTIPLIERS);
      if (!(next.asset in ASSETS)) throw new Error('asset must be one of ' + Object.keys(ASSETS));
      if (!THRESHOLDS.includes(next.threshold)) throw new Error('threshold must be one of ' + THRESHOLDS);
      d.settings = next;
    })).state,

    updateGoal: async ({ name, target }) => (await run(() => {
      const n = String(name ?? '').trim().slice(0, 24);
      if (!n) throw new Error('Укажите название цели');
      if (!Number.isInteger(target) || target <= 0 || target > 1_000_000_000) throw new Error('Некорректная сумма цели');
      d.goal = { name: n, target };
    })).state,

    reset: async () => (await run((rate) => fillDemo(rate))).state,
  };
}
