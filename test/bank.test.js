import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBank } from '../public/bank.js';
import { createRates, fetchCrypto } from '../public/rates.js';

const memoryStorage = () => {
  const m = new Map();
  return { get: (k) => structuredClone(m.get(k) ?? null), set: (k, v) => m.set(k, structuredClone(v)), m };
};
function setup() {
  const storage = memoryStorage();
  const rates = createRates({ fetcher: async () => ({ BTC: 250000, ETH: 10000, usd: 3.2, exchange: 'Test', currency: 'BYN' }) });
  return { storage, bank: createBank({ storage, rates }) };
}

test('first visit seeds Ivan’s week priced at the live rate', async () => {
  const { bank } = setup();
  const s = await bank.state();
  assert.equal(s.user.name, 'Иван К.');
  assert.equal(s.rates.source, 'live');
  assert.ok(s.totals.invested > 0);
  assert.ok(Math.abs(s.totals.profitPct - 2.4) < 0.1, `profit ${s.totals.profitPct}`);
  // зарплата 1450,00 + перевод 25,00 минус неделя покупок вместе со сдачей
  const spent = s.feed.filter((f) => f.type === 'payment').reduce((a, f) => a - f.amount, 0);
  assert.equal(s.account.balance, 145000 + 2500 - spent);
  assert.equal(s.feed[0].title, 'PEREVOD BSB');
});

test('payment charges purchase plus change and batch-buys at threshold', async () => {
  const { bank } = setup();
  const before = await bank.updateSettings({ round_step: 100, multiplier: 1, asset: 'ETH', threshold: 1000 });
  const r1 = await bank.payment({ merchant: 'Кофе', amount: '6,40' });
  assert.equal(r1.payment.roundup, 60);
  assert.equal(r1.state.account.balance, before.account.balance - 700);
  assert.equal(r1.state.feed[0].amount, -700);

  await bank.updateSettings({ round_step: 1000 });
  const need = 1000 - r1.state.piggy;
  const r2 = await bank.payment({ merchant: 'Такси', amountKop: 100000 - need });
  assert.equal(r2.payment.roundup, need);
  assert.equal(r2.purchase.asset, 'ETH');
  assert.equal(r2.purchase.amount, 1000);
  assert.equal(r2.purchase.qty, 0.001);
  assert.equal(r2.state.piggy, 0);
  assert.equal(r2.state.holdings.find((h) => h.asset === 'ETH').cost, 1000);
});

test('top-ups, buy now, limits and validation', async () => {
  const { bank } = setup();
  const s = await bank.updateSettings({ threshold: 5000 });
  const top = await bank.topUp({ amount: '50' });
  assert.equal(top.state.account.balance, s.account.balance + 5000);
  assert.equal(top.state.feed[0].type, 'topup');
  await assert.rejects(bank.topUp({ amount: '0' }), /пополнения/);
  await assert.rejects(bank.topUp({ amount: '20000' }), /10 000/);
  await assert.rejects(bank.payment({ amount: '99999' }), /Недостаточно средств/);
  await assert.rejects(bank.payment({ amount: 'abc' }), /сумму/);
  await assert.rejects(bank.updateSettings({ round_step: 300 }), /round_step/);
  await assert.rejects(bank.updateGoal({ name: '', target: 100 }), /цели/);
  assert.equal((await bank.updateGoal({ name: 'Велосипед', target: 150000 })).goal.name, 'Велосипед');

  await bank.payment({ amount: '1,10' });
  const r = await bank.buyNow();
  assert.equal(r.state.piggy, 0);
  await assert.rejects(bank.buyNow(), /пуста/);
});

test('data survives a reload and reset restores the demo', async () => {
  const { storage, bank } = setup();
  const first = await bank.state();
  await bank.payment({ merchant: 'Кофе', amount: '6,40' });
  const rates = createRates({ fetcher: async () => ({ BTC: 250000, ETH: 10000, usd: 3.2 }) });
  const again = createBank({ storage, rates });
  const s = await again.state();
  assert.equal(s.piggy, first.piggy + 60);
  const reset = await again.reset();
  assert.equal(reset.piggy, first.piggy);
  assert.equal(reset.account.balance, first.account.balance);
});

test('falls through to the next exchange when one is unavailable', async () => {
  const r = await fetchCrypto([
    ['Down', async () => { throw new Error('HTTP 451'); }],
    ['Broken', async () => ({ BTC: NaN, ETH: 1 })],
    ['Up', async () => ({ BTC: 80000, ETH: 2400 })],
  ]);
  assert.deepEqual(r, { BTC: 80000, ETH: 2400, exchange: 'Up', currency: 'USD' });
  await assert.rejects(fetchCrypto([['Down', async () => { throw new Error('x'); }]]), /Down: x/);
});

test('failed refresh falls back to the last known rate without hammering the API', async () => {
  let calls = 0, fail = false, t = Date.parse('2026-10-18T10:00:00Z');
  const rates = createRates({ now: () => t,
    fetcher: async () => { calls++; if (fail) throw new Error('down'); return { BTC: 1, ETH: 2, usd: 3, exchange: 'X' }; } });
  await rates.current();
  fail = true; t += 10_000;
  const r = await rates.current();
  assert.equal(r.stale, true);
  assert.equal(r.BTC, 1);
  const n = calls; t += 1_000;
  assert.equal((await rates.current()).stale, true);
  assert.equal(calls, n);
  t += 5_000;
  await rates.current();
  assert.equal(calls, n + 1);
});
