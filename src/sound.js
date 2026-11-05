import { NativeModules } from 'react-native';
import { Audio, InterruptionModeAndroid } from 'expo-av';

// Tono de alarma del sistema (el que tengas configurado en Android)
export const DEFAULT_TONE = 'content://settings/system/alarm_alert';
export const toneOf = (st) => (typeof st.tone === 'string' && st.tone ? st.tone : DEFAULT_TONE);

const N = NativeModules.RNBackgroundActions;

// Reproductor en bucle. Primero el reproductor NATIVO de alarma (suena con la app en segundo plano o el móvil
// bloqueado); si no está o falla, expo-av (solo con la app delante). Devuelve cuál ha sonado; si nada suena, lanza el error.
export function createLoopSound() {
  let sound = null;
  let native = false;
  let seq = 0;
  async function stop() {
    seq += 1;
    if (native) { native = false; try { await N.stopAlarmSound(); } catch {} }
    const s = sound;
    sound = null;
    if (s) { try { await s.stopAsync(); await s.unloadAsync(); } catch {} }
  }
  async function play(uri) {
    await stop();
    const mine = seq;
    const uris = [...new Set([uri, DEFAULT_TONE])];
    let lastError;
    if (N?.startAlarmSound) {
      for (const u of uris) {
        try {
          await N.startAlarmSound(u);
          if (seq !== mine) { await N.stopAlarmSound(); return 'cancelado'; } // se pidió parar mientras cargaba
          native = true;
          return 'nativo';
        } catch (e) { lastError = e; }
      }
    }
    try {
      await Audio.setAudioModeAsync({
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      });
    } catch {}
    for (const u of uris) {
      try {
        const { sound: snd } = await Audio.Sound.createAsync({ uri: u }, { isLooping: true, shouldPlay: true, volume: 1 });
        if (seq !== mine) { await snd.unloadAsync(); return 'cancelado'; }
        sound = snd;
        return 'expo-av';
      } catch (e) { lastError = e; }
    }
    throw lastError;
  }
  return { play, stop };
}
