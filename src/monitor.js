// Monitor de alarmas: vive en el runtime de JS, NO en un componente de React.
// Así sigue comprobando precios, sonando y avisando aunque cierres la pantalla de la app
// (el servicio en primer plano mantiene vivo el proceso).
import {
  DEFAULT_SETTINGS, loadAlarms, saveAlarms, loadSettings, saveSettings, loadLog, saveLog, getPrices, checkAlarms, feed,
} from './core';
import { syncService } from './service';
import { createLoopSound, toneOf } from './sound';
import { setupBackground } from './bg';

export const state = {
  alarms: [], settings: DEFAULT_SETTINGS, prices: {}, status: { at: 0, error: null }, ready: false, soundError: null, log: [],
};
export const snapshot = () => ({ ...state });

const listeners = new Set();
const emit = () => listeners.forEach((f) => f());
export const subscribe = (f) => { listeners.add(f); return () => listeners.delete(f); };

// Registro de actividad (últimos 80 eventos, persistido) para diagnosticar fallos con el móvil bloqueado
const hms = (t = Date.now()) => { const d = new Date(t); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'); };
let logTimer = null;
export function log(msg) {
  state.log = [`${hms()} ${msg}`, ...state.log].slice(0, 80);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => saveLog(state.log), 1500);
  emit();
}
let lastTickAt = 0;
let lastErr = null;

const ring = createLoopSound();
let ringing = false;
let started = false;
let busy = false;
let timer = null;

// Suena mientras haya alguna alarma activada y disparada, hasta que el usuario la apague
function applyRinging() {
  const want = state.alarms.some((a) => a.enabled && a.fired);
  if (want === ringing) return;
  ringing = want;
  if (want) {
    ring.play(toneOf(state.settings))
      .then((how) => log(`sonido: reproduciendo (${how})`))
      .catch((e) => { state.soundError = String(e?.message || e); log(`sonido: ERROR ${state.soundError}`); });
  } else { ring.stop(); log('sonido: parado'); }
}

export function setAlarms(next) {
  state.alarms = next;
  saveAlarms(next);
  applyRinging();
  syncService(next, log); // notificación fija (y prioritaria si ha saltado alguna)
  emit();
}

// all=false: solo los pares con alarmas activas (ahorra cuota de la API)
export async function tick(all = false) {
  if (busy) return;
  busy = true;
  try {
    const gap = Date.now() - lastTickAt;
    if (!all && lastTickAt && gap > state.settings.refresh * 3000 + 30000) {
      log(`hueco de ${Math.round(gap / 60000)} min sin consultas (¿móvil suspendido?)`);
    }
    lastTickAt = Date.now();
    const pool = state.alarms.filter((a) => all || (a.enabled && !a.fired));
    const pairs = [...new Set(pool.map((a) => a.pair))];
    const p = await getPrices(state.settings, pairs);
    state.status = { at: feed.at, error: feed.error };
    if (feed.error !== lastErr) { log(feed.error ? `fuente: ERROR ${feed.error}` : 'fuente: OK'); lastErr = feed.error; }
    if (Object.keys(p).length) {
      state.prices = { ...state.prices, ...p };
      const { alarms, fired } = checkAlarms(state.alarms, p);
      if (fired.length) { fired.forEach((a) => log(`SALTA ${a.pair} ${a.condition === 'above' ? '≥' : '≤'} ${a.price} (precio ${p[a.pair]})`)); setAlarms(alarms); return; }
    }
    emit();
  } finally { busy = false; }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try { await tick(); } finally { schedule(); }
  }, state.settings.refresh * 1000);
}

export async function init() {
  if (started) return;
  started = true;
  globalThis.__alarmasMonitor = true; // la tarea periódica de fondo se aparta mientras el monitor está vivo
  const [a0, s, l] = await Promise.all([loadAlarms(), loadSettings(), loadLog()]);
  const a = a0.filter((x) => !x.test); // una alarma de prueba que quedó a medias no debe sobrevivir
  state.alarms = a; state.settings = s; state.log = l; state.ready = true;
  if (a.length !== a0.length) saveAlarms(a);
  log(`monitor iniciado (${a.length} alarmas, refresco ${s.refresh} s)`);
  applyRinging();
  syncService(a, log);
  emit();
  setupBackground();
  await tick(true);
  schedule();
}

export function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveSettings(state.settings);
  if ('refresh' in patch || 'source' in patch) schedule();
  if ('source' in patch) tick(true);
  emit();
}

export function dismiss() {
  log('alarma apagada por el usuario');
  setAlarms(state.alarms.filter((a) => !a.test).map((a) => (a.fired ? { ...a, fired: false, enabled: false } : a)));
}

// Dispara una alarma de prueba pasados `sec` segundos, por el mismo camino que una real
export function testAlarm(sec = 15) {
  const due = Date.now() + sec * 1000;
  log(`prueba: alarma de prueba a las ${hms(due)}`);
  setTimeout(() => {
    log(`prueba: disparando (retraso ${Date.now() - due} ms)`);
    setAlarms([...state.alarms, {
      id: `test-${Date.now()}`, pair: 'EUR/USD', condition: 'above', price: 1, enabled: true, fired: true, firedAt: Date.now(), test: true,
    }]);
  }, sec * 1000);
}
export function clearSoundError() { state.soundError = null; }
