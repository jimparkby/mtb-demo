// Реальный курс прямо из браузера. Сначала — Dzengi (резидент ПВТ, пара сразу в рублях
// BTC/BYN и ETH/BYN): середина между ценой покупки и продажи. Если он недоступен — мировые
// биржи (USD/USDT) × официальный курс НБРБ. Все эти API отдают CORS, сервер не нужен.
// Площадки опрашиваются по очереди; при недоступности всех — последний известный курс,
// а если его нет — зашитая оценка.

export const FALLBACK = { BTC: 200850, ETH: 8206, usd: 3.0113 };
const TTL_MS = 5_000;
const TIMEOUT_MS = 4_000;
const USD_TTL_MS = 3_600_000;
const TICKS_MS = 3_600_000; // график — за последний час

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const mid = (bid, ask) => (Number(bid) + Number(ask)) / 2;
const round2 = (n) => Math.round(n * 100) / 100;

// [название, получение { BTC, ETH }, валюта цены]
export const EXCHANGES = [
  ['Dzengi', async () => {
    const [btc, eth] = await Promise.all(['BTC/BYN', 'ETH/BYN'].map((s) =>
      getJson(`https://api-adapter.dzengi.com/api/v2/ticker/24hr?symbol=${encodeURIComponent(s)}`)));
    return { BTC: mid(btc.bidPrice, btc.askPrice), ETH: mid(eth.bidPrice, eth.askPrice) };
  }, 'BYN'],
  ['OKX', async () => {
    const [btc, eth] = await Promise.all(['BTC-USDT', 'ETH-USDT'].map((id) =>
      getJson(`https://www.okx.com/api/v5/market/ticker?instId=${id}`)));
    return { BTC: Number(btc.data?.[0]?.last), ETH: Number(eth.data?.[0]?.last) };
  }],
  ['Kraken', async () => {
    const r = await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD');
    return { BTC: Number(r.result?.XXBTZUSD?.c?.[0]), ETH: Number(r.result?.XETHZUSD?.c?.[0]) };
  }],
  ['Coinbase', async () => {
    const [btc, eth] = await Promise.all(['BTC-USD', 'ETH-USD'].map((id) =>
      getJson(`https://api.exchange.coinbase.com/products/${id}/ticker`)));
    return { BTC: Number(btc.price), ETH: Number(eth.price) };
  }],
  ['CoinGecko', async () => {
    const r = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd');
    return { BTC: r.bitcoin?.usd, ETH: r.ethereum?.usd };
  }],
];

export async function fetchCrypto(exchanges = EXCHANGES) {
  const errors = [];
  for (const [name, get, currency = 'USD'] of exchanges) {
    try {
      const p = await get();
      if (p.BTC > 0 && p.ETH > 0) return { ...p, exchange: name, currency };
      errors.push(`${name}: unexpected payload`);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

let usdCache = null;
async function fetchUsd() {
  if (usdCache && Date.now() - usdCache.at < USD_TTL_MS) return usdCache.usd;
  try {
    const usd = (await getJson('https://api.nbrb.by/exrates/rates/USD?parammode=2'))?.Cur_OfficialRate;
    if (!(usd > 0)) throw new Error('unexpected NBRB payload');
    usdCache = { usd, at: Date.now() };
    return usd;
  } catch (err) {
    if (usdCache) return usdCache.usd; // вчерашний официальный курс лучше, чем никакого
    throw err;
  }
}

export async function fetchLive() {
  const [crypto, usd] = await Promise.allSettled([fetchCrypto(), fetchUsd()]);
  if (crypto.status === 'rejected') throw crypto.reason;
  const p = crypto.value, base = { exchange: p.exchange, currency: p.currency };
  // Рублёвой паре НБРБ не нужен, курс доллара — только для справки
  if (p.currency === 'BYN') return { BTC: round2(p.BTC), ETH: round2(p.ETH), usd: usd.value ?? 0, ...base };
  if (usd.status === 'rejected') throw usd.reason;
  return { BTC: round2(p.BTC * usd.value), ETH: round2(p.ETH * usd.value), usd: usd.value, ...base };
}

// storage — { get(key), set(key, value) } с JSON-значениями; курс и тики переживают перезагрузку
export function createRates({ fetcher = fetchLive, now = () => Date.now(), storage = null } = {}) {
  let last = storage?.get('rate') ?? null, failedAt = -Infinity, pending = null;
  const ticks = (storage?.get('ticks') ?? []).filter((t) => Date.parse(t.t) > now() - TICKS_MS);

  const cached = () => last ?? { ...FALLBACK, SAFE: 1, source: 'fallback', fetchedAt: null };

  async function refresh() {
    try {
      const r = await fetcher();
      const at = new Date(now()).toISOString();
      last = { BTC: r.BTC, ETH: r.ETH, SAFE: 1, usd: r.usd, source: 'live', exchange: r.exchange, currency: r.currency, fetchedAt: at };
      ticks.push({ t: at, BTC: r.BTC, ETH: r.ETH });
      while (ticks.length > 2 && Date.parse(ticks[0].t) < now() - TICKS_MS) ticks.shift();
      storage?.set('rate', last);
      storage?.set('ticks', ticks);
      return last;
    } catch (err) {
      console.warn('[rates] live rate unavailable:', err.message);
      failedAt = now();
      return { ...cached(), stale: true };
    }
  }

  // Свежий курс (не старше TTL). Параллельные запросы делят одно обращение к API.
  async function current({ force = false } = {}) {
    const c = cached();
    const age = c.fetchedAt && c.source === 'live' ? now() - Date.parse(c.fetchedAt) : Infinity;
    if (!force && age < TTL_MS) return c;
    if (!force && now() - failedAt < TTL_MS) return { ...c, stale: true }; // не долбим упавшие API
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  }

  return { current, cached, ticks: () => ticks.slice() };
}
