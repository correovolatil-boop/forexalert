// Monitor de alarmas: vive en el runtime de JS, NO en un componente de React.
// Así sigue comprobando precios, sonando y avisando aunque cierres la pantalla de la app
// (el servicio en primer plano mantiene vivo el proceso).
import {
  DEFAULT_SETTINGS, loadAlarms, saveAlarms, loadSettings, saveSettings, getPrices, checkAlarms, feed,
} from './core';
import { syncService } from './service';
import { createLoopSound, toneOf } from './sound';
import { setupBackground } from './bg';

export const state = {
  alarms: [], settings: DEFAULT_SETTINGS, prices: {}, status: { at: 0, error: null }, ready: false, soundError: null,
};
export const snapshot = () => ({ ...state });

const listeners = new Set();
const emit = () => listeners.forEach((f) => f());
export const subscribe = (f) => { listeners.add(f); return () => listeners.delete(f); };

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
    ring.play(toneOf(state.settings)).catch((e) => { state.soundError = String(e?.message || e); emit(); });
  } else ring.stop();
}

export function setAlarms(next) {
  state.alarms = next;
  saveAlarms(next);
  applyRinging();
  syncService(next); // notificación fija (y prioritaria si ha saltado alguna)
  emit();
}

// all=false: solo los pares con alarmas activas (ahorra cuota de la API)
export async function tick(all = false) {
  if (busy) return;
  busy = true;
  try {
    const pool = state.alarms.filter((a) => all || (a.enabled && !a.fired));
    const pairs = [...new Set(pool.map((a) => a.pair))];
    const p = await getPrices(state.settings, pairs);
    state.status = { at: feed.at, error: feed.error };
    if (Object.keys(p).length) {
      state.prices = { ...state.prices, ...p };
      const { alarms, fired } = checkAlarms(state.alarms, p);
      if (fired.length) { setAlarms(alarms); return; }
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
  const [a, s] = await Promise.all([loadAlarms(), loadSettings()]);
  state.alarms = a; state.settings = s; state.ready = true;
  applyRinging();
  syncService(a);
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
  setAlarms(state.alarms.map((a) => (a.fired ? { ...a, fired: false, enabled: false } : a)));
}
export function clearSoundError() { state.soundError = null; }
