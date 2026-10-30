import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import { loadAlarms, saveAlarms, loadSettings, getPrices, checkAlarms, fmt } from './core';

export const TASK = 'alarm-check';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function notifyFired(fired) {
  for (const a of fired) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `⏰ ${a.pair}`,
        body: `Precio ${a.condition === 'above' ? 'por encima de' : 'por debajo de'} ${fmt(a.pair, a.price)}`,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
      },
      trigger: { channelId: 'alarm' },
    });
  }
}

TaskManager.defineTask(TASK, async () => {
  // Si el monitor está vivo en este mismo runtime, él ya vigila: no duplicar consultas ni escrituras
  if (globalThis.__alarmasMonitor) return BackgroundFetch.BackgroundFetchResult.NoData;
  try {
    const [alarms, settings] = await Promise.all([loadAlarms(), loadSettings()]);
    const pending = alarms.filter((a) => a.enabled && !a.fired);
    if (!pending.length) return BackgroundFetch.BackgroundFetchResult.NoData;
    const prices = await getPrices(settings, [...new Set(pending.map((a) => a.pair))]);
    const { alarms: next, fired } = checkAlarms(alarms, prices);
    if (!fired.length) return BackgroundFetch.BackgroundFetchResult.NoData;
    await saveAlarms(next);
    await notifyFired(fired);
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function setupBackground() {
  try {
    await Notifications.setNotificationChannelAsync('alarm', {
      name: 'Alarmas de precio',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 600, 300, 600],
    });
    await Notifications.requestPermissionsAsync();
    await BackgroundFetch.registerTaskAsync(TASK, {
      minimumInterval: 15 * 60, // mínimo que permite Android
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch {}
}
