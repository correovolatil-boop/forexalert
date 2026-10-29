import BackgroundService from 'react-native-background-actions';
import { fmt } from './core';

const base = {
  taskName: 'AlarmasForex',
  taskIcon: { name: 'notification_icon', type: 'drawable' },
  color: '#10B981',
  foregroundServiceType: ['dataSync'],
};
const hhmm = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const line = (a) => `${a.pair} ${a.condition === 'above' ? '▲' : '▼'} ${fmt(a.pair, a.price)}`;

// Título: nº de alarmas activas y cuántas han saltado. Cuerpo: las que saltaron primero (⏰), luego el resto.
export function describe(alarms) {
  const active = alarms.filter((a) => a.enabled);
  const fired = active.filter((a) => a.fired);
  const n = active.length;
  const taskTitle = `${n} ${n === 1 ? 'alarma activa' : 'alarmas activas'}`
    + (fired.length ? ` · ${fired.length} ${fired.length === 1 ? 'saltó' : 'saltaron'}` : '');
  const taskDesc = [
    ...fired.map((a) => `⏰ ${line(a)} · saltó${a.firedAt ? ' ' + hhmm(a.firedAt) : ''}`),
    ...active.filter((a) => !a.fired).map((a) => `• ${line(a)}`),
  ].join('\n');
  return { taskTitle, taskDesc };
}

// El servicio solo mantiene vivo el proceso con el móvil bloqueado; el sondeo de precios lo hace App.js
const keepAlive = () => new Promise(() => {});

async function run(alarms) {
  if (!alarms.some((a) => a.enabled)) {
    if (BackgroundService.isRunning()) await BackgroundService.stop();
    return;
  }
  const d = describe(alarms);
  if (BackgroundService.isRunning()) await BackgroundService.updateNotification(d);
  else await BackgroundService.start(keepAlive, { ...base, ...d });
}
// Cola: evita arrancar el servicio dos veces si las alarmas cambian seguidas
let chain = Promise.resolve();
export const syncService = (alarms) => (chain = chain.then(() => run(alarms)).catch(() => {}));
