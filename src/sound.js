import { Audio, InterruptionModeAndroid } from 'expo-av';

// Tono de alarma del sistema (el que tengas configurado en Android)
export const DEFAULT_TONE = 'content://settings/system/alarm_alert';
export const toneOf = (st) => (typeof st.tone === 'string' && st.tone ? st.tone : DEFAULT_TONE);

// Reproductor en bucle. Si `uri` falla prueba el tono por defecto; si nada suena, lanza el error.
export function createLoopSound() {
  let sound = null;
  let seq = 0;
  async function stop() {
    seq += 1;
    const s = sound;
    sound = null;
    if (s) { try { await s.stopAsync(); await s.unloadAsync(); } catch {} }
  }
  async function play(uri) {
    await stop();
    const mine = seq;
    try {
      await Audio.setAudioModeAsync({
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      });
    } catch {}
    let lastError;
    for (const u of [...new Set([uri, DEFAULT_TONE])]) {
      try {
        const { sound: snd } = await Audio.Sound.createAsync({ uri: u }, { isLooping: true, shouldPlay: true, volume: 1 });
        if (seq !== mine) { await snd.unloadAsync(); return; } // se pidió parar mientras cargaba
        sound = snd;
        return;
      } catch (e) { lastError = e; }
    }
    throw lastError;
  }
  return { play, stop };
}
