import AsyncStorage from '@react-native-async-storage/async-storage';

export const PAIRS = [
  'AUD/USD', 'EUR/GBP', 'EUR/JPY', 'EUR/USD', 'GBP/JPY',
  'GBP/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY',
];
export const SOURCES = [
  { id: 'icm', name: 'IC Markets (Raw Spread ECN Simulation)' },
  { id: 'erapi', name: 'ExchangeRate-API' },
  { id: 'frank', name: 'Frankfurter API' },
  { id: 'av', name: 'Alpha Vantage REST API' },
];
export const DEFAULT_SETTINGS = { source: 'icm', apiKey: '', refresh: 5, tone: 0 };

const isJpy = (p) => p.endsWith('/JPY');
export const digits = (p) => (isJpy(p) ? 3 : 5);
// [macro, micro] según los decimales del par
export const steps = (p) => (isJpy(p) ? [1, 0.01] : [0.01, 0.0001]);
export const fmt = (p, v) => Number(v).toFixed(digits(p));

// ---------- almacenamiento local ----------
const K_ALARMS = 'alarms.v1';
const K_SETTINGS = 'settings.v1';
export async function loadAlarms() {
  try { return JSON.parse((await AsyncStorage.getItem(K_ALARMS)) || '[]'); } catch { return []; }
}
export const saveAlarms = (a) => AsyncStorage.setItem(K_ALARMS, JSON.stringify(a));
export async function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse((await AsyncStorage.getItem(K_SETTINGS)) || '{}') };
  } catch { return DEFAULT_SETTINGS; }
}
export const saveSettings = (s) => AsyncStorage.setItem(K_SETTINGS, JSON.stringify(s));

// ---------- precios ----------
async function usdRates(source) {
  const url = source === 'frank'
    ? 'https://api.frankfurter.dev/v1/latest?base=USD'
    : 'https://open.er-api.com/v6/latest/USD';
  const j = await (await fetch(url)).json();
  const rates = { USD: 1, ...j.rates };
  if (!rates.EUR) throw new Error('Respuesta sin tasas');
  return rates;
}
const cross = (rates, pair) => {
  const [a, b] = pair.split('/');
  return rates[b] / rates[a];
};

// Simulación ECN: precio real de referencia (Frankfurter, cacheado 60 s) + micro-movimiento por tick
const SEED = { USD: 1, AUD: 1.53, CAD: 1.37, CHF: 0.88, EUR: 0.92, GBP: 0.78, JPY: 150, NZD: 1.66 };
let ref = { rates: SEED, t: 0 };
const drift = {};
async function simulated(pairs) {
  if (Date.now() - ref.t > 60000) {
    try { ref = { rates: await usdRates('frank'), t: Date.now() }; }
    catch { ref = { ...ref, t: Date.now() }; }
  }
  const out = {};
  for (const p of pairs) {
    const d = Math.max(-0.0003, Math.min(0.0003, (drift[p] || 0) + (Math.random() - 0.5) * 0.00004));
    drift[p] = d;
    out[p] = cross(ref.rates, p) * (1 + d);
  }
  return out;
}

async function alphaVantage(pairs, key) {
  if (!key) throw new Error('Falta la API Key de Alpha Vantage');
  const out = {};
  for (const p of pairs) {
    const [a, b] = p.split('/');
    const j = await (await fetch(
      `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${a}&to_currency=${b}&apikey=${key}`
    )).json();
    const v = parseFloat(j?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate']);
    if (v) out[p] = v;
  }
  return out;
}

/** Devuelve { 'EUR/USD': 1.0853, ... }. Si la fuente falla devuelve {} (se conservan los precios previos). */
export async function getPrices(settings, pairs) {
  if (!pairs.length) return {};
  try {
    switch (settings.source) {
      case 'erapi':
      case 'frank': {
        const rates = await usdRates(settings.source);
        return Object.fromEntries(pairs.map((p) => [p, cross(rates, p)]));
      }
      case 'av': return await alphaVantage(pairs, settings.apiKey);
      default: return await simulated(pairs);
    }
  } catch { return {}; }
}

/** Marca como `fired` las alarmas activas cuya condición se cumple. */
export function checkAlarms(alarms, prices) {
  const fired = [];
  const next = alarms.map((a) => {
    const px = prices[a.pair];
    if (!a.enabled || a.fired || px == null) return a;
    const hit = a.condition === 'above' ? px >= a.price : px <= a.price;
    if (!hit) return a;
    const f = { ...a, fired: true };
    fired.push(f);
    return f;
  });
  return { alarms: next, fired };
}
