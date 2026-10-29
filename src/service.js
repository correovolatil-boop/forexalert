import BackgroundService from 'react-native-background-actions';

const options = (n) => ({
  taskName: 'AlarmasForex',
  taskTitle: 'Alarmas Forex activas',
  taskDesc: `Vigilando ${n} alarma${n === 1 ? '' : 's'}`,
  taskIcon: { name: 'notification_icon', type: 'drawable' },
  color: '#10B981',
  foregroundServiceType: ['dataSync'],
});
// El servicio solo mantiene vivo el proceso con el móvil bloqueado; el sondeo de precios lo hace App.js
const keepAlive = () => new Promise(() => {});

export async function syncService(n) {
  if (n > 0 && !BackgroundService.isRunning()) await BackgroundService.start(keepAlive, options(n));
  else if (n > 0) await BackgroundService.updateNotification({ taskDesc: options(n).taskDesc });
  else if (BackgroundService.isRunning()) await BackgroundService.stop();
}
