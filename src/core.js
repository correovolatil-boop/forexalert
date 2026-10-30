import AsyncStorage from '@react-native-async-storage/async-storage';

export const PAIRS = [
  'AUD/USD', 'EUR/GBP', 'EUR/JPY', 'EUR/USD', 'GBP/JPY',
  'GBP/USD', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'USD/JPY',
];
export const SOURCES = [
  { id: 'twelve', name: 'Twelve Data', note: 'Forex en tiempo real. Plan gratis: 800 consultas/día y 8 por minuto (twelvedata.com)' },
  { id: 'custom', name: 'Fuente personalizada (URL propia)', note: 'Cualquier API con JSON; la configuras abajo' },
];
export const DEFAULT_SETTINGS = {
  source: 'twelve', apiKey: '', refresh: 60, tone: null,
  customUrl: '', customPath: '', customHeaders: '',
};

const isJpy = (p) => p.endsWith('/JPY');
export const digits = (p) => (isJpy(p) ? 3 : 5);
// [macro, micro]: antepenúltimo y penúltimo decimal del par (el último no se modifica)
export const steps = (p) => { const d = digits(p); return [Number(`1e-${d - 2}`), Number(`1e-${d - 1}`)]; };
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
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse((await AsyncStorage.getItem(K_SETTINGS)) || '{}') };
    // fuentes retiradas (simulada, BCE diario, ExchangeRate-API, Alpha Vantage) -> Twelve Data
    if (!SOURCES.some((x) => x.id === s.source)) s.source = 'twelve';
    s.refresh = Math.max(5, Math.min(600, Number(s.refresh) || 60));
    return s;
  } catch { return DEFAULT_SETTINGS; }
}
export const saveSettings = (s) => AsyncStorage.setItem(K_SETTINGS, JSON.stringify(s));

// ---------- precios ----------
// Estado de la última consulta (lo muestra la pantalla principal)
export const feed = { at: 0, error: null };

// Twelve Data es una URL personalizada ya montada
const resolve = (s) => (s.source === 'twelve'
  ? {
    customUrl: `https://api.twelvedata.com/price?symbol={SYMBOL}&apikey=${encodeURIComponent((s.apiKey || '').trim())}`,
    customPath: 'price',
    customHeaders: '',
  }
  : s);

// URL con marcadores {BASE} {QUOTE} {PAIR} {SYMBOL}, ruta JSON y cabeceras opcionales
export async function customPrice(settings, pair) {
  if (settings.source === 'twelve' && !(settings.apiKey || '').trim()) {
    throw new Error('Falta la API Key de Twelve Data (Ajustes)');
  }
  const c = resolve(settings);
  const [base, quote] = pair.split('/');
  const fill = (t) => t.split('{BASE}').join(base).split('{QUOTE}').join(quote)
    .split('{PAIR}').join(base + quote).split('{SYMBOL}').join(`${base}/${quote}`);
  const url = fill((c.customUrl || '').trim());
  if (!/^https:\/\//i.test(url)) throw new Error('La URL debe empezar por https://');
  const headers = {};
  for (const line of (c.customHeaders || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = fill(line.slice(i + 1).trim());
  }
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  const path = (c.customPath || '').trim();
  let v;
  if (!path) v = parseFloat(text);
  else {
    let o = JSON.parse(text);
    for (const k of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) o = o?.[k];
    v = parseFloat(o);
  }
  if (!(v > 0)) throw new Error('Sin precio en la respuesta: ' + text.slice(0, 120));
  return v;
}

/** Devuelve { 'EUR/USD': 1.0853, ... } con los pares que respondieron y anota el estado en `feed`. */
export async function getPrices(settings, pairs) {
  if (!pairs.length) return {};
  const out = {};
  let error = null;
  await Promise.all(pairs.map(async (p) => {
    try { out[p] = await customPrice(settings, p); }
    catch (e) { error = error || String(e?.message || e); }
  }));
  feed.error = error;
  if (Object.keys(out).length) feed.at = Date.now();
  return out;
}

/** Marca como `fired` las alarmas activas cuya condición se cumple. */
export function checkAlarms(alarms, prices) {
  const fired = [];
  const next = alarms.map((a) => {
    const px = prices[a.pair];
    if (!a.enabled || a.fired || px == null) return a;
    const hit = a.condition === 'above' ? px >= a.price : px <= a.price;
    if (!hit) return a;
    const f = { ...a, fired: true, firedAt: Date.now() };
    fired.push(f);
    return f;
  });
  return { alarms: next, fired };
}
