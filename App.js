import './src/bg';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, Pressable, ScrollView, Modal, TextInput, Switch, Alert, RefreshControl,
  AppState, StatusBar as RNStatusBar, StyleSheet,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio, InterruptionModeAndroid } from 'expo-av';
import * as IntentLauncher from 'expo-intent-launcher';
import {
  PAIRS, SOURCES, DEFAULT_SETTINGS, fmt, steps, loadAlarms, saveAlarms,
  loadSettings, saveSettings, getPrices, checkAlarms, customPrice, feed,
} from './src/core';
import { setupBackground, notifyFired } from './src/bg';
import { syncService } from './src/service';

// Tono de alarma del sistema (el que tengas configurado en Android)
const DEFAULT_TONE = 'content://settings/system/alarm_alert';
const toneOf = (st) => (typeof st.tone === 'string' && st.tone ? st.tone : DEFAULT_TONE);
const fmtInt = (v) => (v >= 60 && v % 60 === 0 ? `${v / 60} m` : `${v} s`);

const C = {
  bg: '#0D1520', card: '#142033', line: '#243650', text: '#E6EDF5', muted: '#7F93AB',
  spot: '#10B981', above: '#F59E0B', below: '#60A5FA', danger: '#EF4444',
};

// ---------- sonido en bucle ----------
function useLoopSound() {
  const ref = useRef(null);
  const seq = useRef(0);
  const stop = useCallback(async () => {
    seq.current += 1;
    const snd = ref.current;
    ref.current = null;
    if (snd) { try { await snd.stopAsync(); await snd.unloadAsync(); } catch {} }
  }, []);
  // Reproduce `uri` en bucle; si falla prueba el tono del sistema por defecto. Lanza error si nada suena.
  const play = useCallback(async (uri) => {
    await stop();
    const mine = seq.current;
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
        const { sound } = await Audio.Sound.createAsync({ uri: u }, { isLooping: true, shouldPlay: true, volume: 1 });
        if (seq.current !== mine) { await sound.unloadAsync(); return; } // se pidió parar mientras cargaba
        ref.current = sound;
        return;
      } catch (e) { lastError = e; }
    }
    throw lastError;
  }, [stop]);
  // objeto estable: si cambiase en cada render, el efecto de la alarma reiniciaría el sonido continuamente
  return useMemo(() => ({ play, stop }), [play, stop]);
}

// ---------- App ----------
export default function App() {
  const [alarms, setAlarms] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [prices, setPrices] = useState({});
  const [editing, setEditing] = useState(null); // null | {} (nueva) | alarma
  const [showSettings, setShowSettings] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState({ at: 0, error: null });
  const alarmsRef = useRef([]);
  const settingsRef = useRef(DEFAULT_SETTINGS);
  const busy = useRef(false);
  const ring = useLoopSound();

  const commit = useCallback((next) => {
    alarmsRef.current = next; setAlarms(next); saveAlarms(next);
  }, []);
  const changeSettings = useCallback((patch) => {
    const s = { ...settingsRef.current, ...patch };
    settingsRef.current = s; setSettings(s); saveSettings(s);
  }, []);

  useEffect(() => {
    (async () => {
      const [a, s] = await Promise.all([loadAlarms(), loadSettings()]);
      alarmsRef.current = a; settingsRef.current = s;
      setAlarms(a); setSettings(s); setReady(true);
      setupBackground();
    })();
  }, []);

  const tick = useCallback(async (all = false) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const pool = alarmsRef.current.filter((a) => all || (a.enabled && !a.fired));
      const pairs = [...new Set(pool.map((a) => a.pair))];
      const p = await getPrices(settingsRef.current, pairs);
      setStatus({ at: feed.at, error: feed.error });
      if (!Object.keys(p).length) return;
      setPrices((prev) => ({ ...prev, ...p }));
      const { alarms: next, fired } = checkAlarms(alarmsRef.current, p);
      if (fired.length) {
        commit(next);
        if (AppState.currentState !== 'active') notifyFired(fired);
      }
    } finally { busy.current = false; }
  }, [commit]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => { setRefreshing(true); await tick(true); setRefreshing(false); };

  useEffect(() => {
    if (!ready) return undefined;
    tick(true);
    const id = setInterval(() => tick(), settings.refresh * 1000);
    return () => clearInterval(id);
  }, [ready, settings.refresh, settings.source, settings.apiKey, alarms.length, tick]);

  // Al volver a primer plano: la tarea de fondo pudo haber disparado alarmas
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (st) => {
      if (st !== 'active') return;
      const a = await loadAlarms();
      alarmsRef.current = a; setAlarms(a);
      tick(true);
    });
    return () => sub.remove();
  }, [tick]);

  // Alarma sonando = activada y disparada, hasta que el usuario la apague
  const ringing = alarms.filter((a) => a.enabled && a.fired);
  const isRinging = ringing.length > 0;
  useEffect(() => {
    if (isRinging) {
      ring.play(toneOf(settingsRef.current))
        .catch((e) => Alert.alert('No se pudo reproducir el sonido', String(e?.message || e)));
    } else ring.stop();
  }, [isRinging, ring]);

  useEffect(() => { if (ready) syncService(alarms); }, [ready, alarms]);

  const dismiss = () => commit(alarmsRef.current.map((a) => (a.fired ? { ...a, fired: false, enabled: false } : a)));

  const saveAlarm = (data) => {
    setEditing(null);
    const cur = alarmsRef.current;
    const a = { ...data, enabled: true, fired: false };
    commit(data.id ? cur.map((x) => (x.id === data.id ? a : x)) : [...cur, { ...a, id: String(Date.now()) }]);
  };
  const toggle = (id) => commit(alarmsRef.current.map((a) => (a.id === id ? { ...a, enabled: !a.enabled, fired: false } : a)));
  const remove = (a) => Alert.alert(
    'Eliminar alarma',
    `¿Seguro que quieres eliminar la alarma de ${a.pair} ${a.condition === 'above' ? 'por encima de' : 'por debajo de'} ${fmt(a.pair, a.price)}? Esta acción no se puede deshacer.`,
    [{ text: 'Cancelar', style: 'cancel' },
     { text: 'Eliminar', style: 'destructive', onPress: () => { commit(alarmsRef.current.filter((x) => x.id !== a.id)); setEditing(null); } }],
  );

  const groups = useMemo(() => [...new Set(alarms.map((a) => a.pair))].sort().map((pair) => {
    const items = alarms.filter((a) => a.pair === pair).sort((x, y) => y.price - x.price)
      .map((a) => ({ type: 'alarm', a }));
    const spot = prices[pair];
    if (spot != null) {
      let i = items.findIndex((it) => it.a.price < spot);
      if (i < 0) i = items.length;
      items.splice(i, 0, { type: 'spot', price: spot });
    }
    return { pair, items };
  }), [alarms, prices]);

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <View style={s.header}>
        <Text style={s.title}>Alarmas</Text>
        <Pressable onPress={() => setShowSettings(true)} hitSlop={10}><Text style={s.link}>Ajustes</Text></Pressable>
      </View>
      {alarms.length > 0 && (
        <Text numberOfLines={2} style={[s.status, status.error && { color: C.danger }]}>
          {status.error ? `⚠ ${status.error}` : status.at ? `● Actualizado ${new Date(status.at).toLocaleTimeString()}` : 'Conectando…'}
        </Text>
      )}

      {ready && alarms.length === 0 ? (
        <View style={s.welcome}>
          <Text style={s.welcomeTitle}>Aún no tienes alarmas</Text>
          <Text style={s.welcomeText}>Crea una y el par aparecerá aquí con su precio en vivo. Sonará hasta que la apagues.</Text>
          <Pressable style={s.cta} onPress={() => setEditing({})}><Text style={s.ctaTxt}>+ Crear Alarma</Text></Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh}
            colors={[C.spot]} progressBackgroundColor={C.card} />}>
          {groups.map(({ pair, items }) => (
            <View key={pair} style={s.card}>
              <Text style={s.pair}>{pair}</Text>
              {items.map((it) => it.type === 'spot' ? (
                <View key="spot" style={s.spotRow}>
                  <Text style={s.spotTxt}>● Spot Actual</Text>
                  <Text style={[s.spotTxt, s.num]}>{fmt(pair, it.price)}</Text>
                </View>
              ) : (
                <Pressable key={it.a.id} onPress={() => setEditing(it.a)}
                  style={[s.row, it.a.enabled && it.a.fired && { borderColor: C.danger }, !it.a.enabled && { opacity: 0.5 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: it.a.condition === 'above' ? C.above : C.below, fontSize: 13 }}>
                      {it.a.condition === 'above' ? '▲ Por encima' : '▼ Por debajo'}
                    </Text>
                    <Text style={[s.price, s.num]}>{fmt(pair, it.a.price)}</Text>
                  </View>
                  <Switch value={it.a.enabled} onValueChange={() => toggle(it.a.id)}
                    trackColor={{ true: C.spot, false: C.line }} thumbColor="#fff" />
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      )}

      {alarms.length > 0 && (
        <Pressable style={s.fab} onPress={() => setEditing({})}><Text style={s.fabTxt}>+</Text></Pressable>
      )}

      <AlarmModal alarm={editing} prices={prices} settings={settings} onSave={saveAlarm} onDelete={remove} onClose={() => setEditing(null)} />
      <SettingsModal visible={showSettings} settings={settings}
        activePairs={new Set(alarms.filter((a) => a.enabled && !a.fired).map((a) => a.pair)).size} onChange={changeSettings} onClose={() => setShowSettings(false)} />

      <Modal visible={isRinging} animationType="fade" onRequestClose={() => {}}>
        <View style={s.ringing}>
          <Text style={s.ringTitle}>Alarma</Text>
          {ringing.map((a) => (
            <Text key={a.id} style={s.ringLine}>
              {a.pair} {a.condition === 'above' ? '≥' : '≤'} {fmt(a.pair, a.price)}
            </Text>
          ))}
          <Pressable style={s.ringBtn} onPress={dismiss}><Text style={s.ringBtnTxt}>Apagar alarma</Text></Pressable>
        </View>
      </Modal>
    </View>
  );
}

// ---------- modal crear / editar ----------
function AlarmModal({ alarm, prices, settings, onSave, onDelete, onClose }) {
  const inputRef = useRef(null);
  const [pair, setPair] = useState('EUR/USD');
  const [cond, setCond] = useState('above');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!alarm) return;
    setOpen(false);
    setPair(alarm.pair || 'EUR/USD');
    setCond(alarm.condition || 'above');
    setText(alarm.price != null ? fmt(alarm.pair, alarm.price) : '');
  }, [alarm]);

  const num = parseFloat(text.replace(',', '.'));
  const [macro, micro] = steps(pair);
  const label = (v) => (v >= 1 ? v.toFixed(2) : String(v));
  const adjust = (d) => {
    const base = Number.isFinite(num) ? num : (prices[pair] ?? 0);
    setText(fmt(pair, Math.max(0, base + d)));
  };
  const useSpot = async () => {
    let p = prices[pair];
    if (p == null) p = (await getPrices(settings, [pair]))[pair];
    if (p != null) setText(fmt(pair, p));
    else Alert.alert('Sin precio', 'No se pudo obtener el precio actual de ' + pair + '.');
  };
  const save = () => {
    if (!(num > 0)) return Alert.alert('Precio no válido', 'Introduce un precio objetivo mayor que 0.');
    onSave({ id: alarm.id, pair, condition: cond, price: num });
  };

  const adj = [[-macro, '-'], [-micro, '-'], [micro, '+'], [macro, '+']];
  const renderAdj = ([d, sg]) => (
    <Pressable key={d} style={s.adjBtn} onPress={() => adjust(d)}>
      <Text style={s.adjTxt} numberOfLines={1} adjustsFontSizeToFit>{sg}{label(Math.abs(d))}</Text>
    </Pressable>
  );
  return (
    <Modal visible={alarm !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        <ScrollView keyboardShouldPersistTaps="handled" style={s.sheetScroll}>
          <Text style={s.sheetTitle}>{alarm?.id ? 'Editar alarma' : 'Crear alarma'}</Text>
          <Pressable style={s.select} onPress={() => setOpen((o) => !o)}>
            <Text style={s.selectTxt}>{pair}</Text>
            <Text style={{ color: C.muted, fontSize: 16 }}>{open ? '▴' : '▾'}</Text>
          </Pressable>
          {open && (
            <View style={s.options}>
              {PAIRS.map((p) => (
                <Pressable key={p} style={[s.option, p === pair && { backgroundColor: C.line }]}
                  onPress={() => { setPair(p); setOpen(false); }}>
                  <Text style={{ color: C.text, fontSize: 16, fontWeight: p === pair ? '800' : '500' }}>{p}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <View style={s.seg}>
            {[['above', 'POR ENCIMA', C.above], ['below', 'POR DEBAJO', C.below]].map(([k, t, col]) => (
              <Pressable key={k} onPress={() => setCond(k)}
                style={[s.segBtn, cond === k && { backgroundColor: col }]}>
                <Text style={{ fontWeight: '700', color: cond === k ? '#0D1520' : C.muted }}>{t}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            ref={inputRef}
            value={text} onChangeText={setText} keyboardType="decimal-pad" placeholder={fmt(pair, 0)}
            placeholderTextColor={C.line} style={[s.input, s.num]}
            onFocus={() => setTimeout(() => inputRef.current?.setSelection(text.length, text.length), 50)}
          />
          <View style={s.adjRow}>
            {adj.slice(0, 2).map(renderAdj)}
            <Pressable style={s.spotBtn} onPress={useSpot}>
              <Text style={s.spotLbl} numberOfLines={1} adjustsFontSizeToFit>● Spot Actual</Text>
              {prices[pair] != null && <Text style={s.spotPx}>{fmt(pair, prices[pair])}</Text>}
            </Pressable>
            {adj.slice(2).map(renderAdj)}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            {alarm?.id && (
              <Pressable style={[s.btn, s.delBtn]} onPress={() => onDelete(alarm)}><Text style={s.delTxt}>Eliminar</Text></Pressable>
            )}
            <Pressable style={[s.btn, { backgroundColor: C.line }]} onPress={onClose}><Text style={s.btnTxt}>Cancelar</Text></Pressable>
            <Pressable style={[s.btn, { backgroundColor: C.spot }]} onPress={save}>
              <Text style={[s.btnTxt, { color: '#06281d' }]}>Guardar</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ---------- modal configuración ----------
function SettingsModal({ visible, settings, activePairs, onChange, onClose }) {
  const limited = settings.source === 'twelve' || /twelvedata\.com/i.test(settings.customUrl || '');
  const perMin = (activePairs * 60) / settings.refresh;
  const perDay = Math.round((activePairs * 86400) / settings.refresh);
  const over = perDay > 800 || perMin > 8;
  const batteryExempt = async () => {
    try {
      await IntentLauncher.startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
        { data: 'package:com.fer.alarmasforex' });
    } catch {
      try { await IntentLauncher.startActivityAsync('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS'); }
      catch (e) { Alert.alert('No se pudo abrir el ajuste', String(e?.message || e)); }
    }
  };
  const test = useLoopSound();
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (!visible) { test.stop(); setTesting(false); } }, [visible, test]);
  const toggleTest = async () => {
    if (testing) { await test.stop(); setTesting(false); return; }
    try { await test.play(toneOf(settings)); setTesting(true); }
    catch (e) { Alert.alert('No se pudo reproducir el sonido', String(e?.message || e)); }
  };
  const pickTone = async () => {
    if (testing) { await test.stop(); setTesting(false); }
    try {
      const r = await IntentLauncher.startActivityAsync('android.intent.action.RINGTONE_PICKER', {
        extra: {
          'android.intent.extra.ringtone.TYPE': 4, // alarmas
          'android.intent.extra.ringtone.SHOW_DEFAULT': true,
          'android.intent.extra.ringtone.SHOW_SILENT': false,
          'android.intent.extra.ringtone.TITLE': 'Tono de alarma',
        },
      });
      const uri = r?.extra?.['android.intent.extra.ringtone.PICKED_URI'];
      if (typeof uri === 'string' && uri) onChange({ tone: uri });
    } catch (e) { Alert.alert('No se pudo abrir el selector de tonos', String(e?.message || e)); }
  };
  const testSource = async () => {
    try {
      const v = await customPrice(settings, 'EUR/USD');
      Alert.alert('Fuente correcta', `EUR/USD = ${fmt('EUR/USD', v)}`);
    } catch (e) { Alert.alert('La fuente no responde bien', String(e?.message || e)); }
  };
  const setRefresh = (v) => onChange({ refresh: Math.max(1, Math.min(300, v)) });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        <ScrollView keyboardShouldPersistTaps="handled" style={s.sheetScroll}>
          <Text style={s.sheetTitle}>Ajustes</Text>

          <Text style={s.section}>Fuente de datos</Text>
          {SOURCES.map((src) => (
            <Pressable key={src.id} style={s.radio} onPress={() => onChange({ source: src.id })}>
              <View style={[s.dot, settings.source === src.id && { backgroundColor: C.spot, borderColor: C.spot }]} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.text }}>{src.name}</Text>
                <Text style={s.note}>{src.note}</Text>
              </View>
            </Pressable>
          ))}
          {settings.source === 'twelve' && (
            <TextInput value={settings.apiKey} onChangeText={(t) => onChange({ apiKey: t.trim() })}
              placeholder="API Key de Twelve Data" placeholderTextColor={C.muted}
              autoCapitalize="none" autoCorrect={false} style={s.keyInput} />
          )}
          {settings.source === 'custom' && (
            <View>
              <Text style={s.note}>URL (https). Marcadores: {'{SYMBOL}'} = EUR/USD, {'{PAIR}'} = EURUSD, {'{BASE}'} = EUR, {'{QUOTE}'} = USD</Text>
              <TextInput value={settings.customUrl} onChangeText={(t) => onChange({ customUrl: t })} multiline
                placeholder="https://api.twelvedata.com/price?symbol={SYMBOL}&apikey=TU_CLAVE" placeholderTextColor={C.muted}
                autoCapitalize="none" autoCorrect={false} style={s.keyInput} />
              <Text style={[s.note, { marginTop: 10 }]}>Ruta del precio en el JSON (vacío si la respuesta es solo el número)</Text>
              <TextInput value={settings.customPath} onChangeText={(t) => onChange({ customPath: t })}
                placeholder="price   ·   prices[0].closeoutAsk" placeholderTextColor={C.muted}
                autoCapitalize="none" autoCorrect={false} style={s.keyInput} />
              <Text style={[s.note, { marginTop: 10 }]}>Cabeceras opcionales, una por línea</Text>
              <TextInput value={settings.customHeaders} onChangeText={(t) => onChange({ customHeaders: t })} multiline
                placeholder="Authorization: Bearer TU_TOKEN" placeholderTextColor={C.muted}
                autoCapitalize="none" autoCorrect={false} style={s.keyInput} />
            </View>
          )}
          <Pressable style={[s.btn, { backgroundColor: C.line, marginTop: 10 }]} onPress={testSource}>
            <Text style={s.btnTxt}>Probar fuente (EUR/USD)</Text>
          </Pressable>
          {limited && (
            <Text style={[s.note, { marginTop: 8, color: over ? C.danger : C.muted }]}>
              Con {activePairs} par{activePairs === 1 ? '' : 'es'} vigilado{activePairs === 1 ? '' : 's'} y refresco de {fmtInt(settings.refresh)}: ≈{perDay} consultas/día y {perMin.toFixed(1)}/min (límite gratis: 800/día y 8/min).
              {over ? ' Te quedarás sin cuota: sube el intervalo.' : ''}
            </Text>
          )}

          <Text style={s.section}>Intervalo de refresco</Text>
          <View style={s.stepper}>
            <Pressable style={s.adjBtn} onPress={() => setRefresh(settings.refresh - 1)}><Text style={s.adjTxt}>−</Text></Pressable>
            <Text style={s.refresh}>{fmtInt(settings.refresh)}</Text>
            <Pressable style={s.adjBtn} onPress={() => setRefresh(settings.refresh + 1)}><Text style={s.adjTxt}>+</Text></Pressable>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {[1, 5, 10, 30, 60, 300].map((v) => (
              <Chip key={v} text={fmtInt(v)} on={settings.refresh === v} onPress={() => setRefresh(v)} />
            ))}
          </View>

          <Text style={s.section}>Tono de alarma</Text>
          <Text style={{ color: C.text, marginBottom: 10 }}>
            {toneOf(settings) === DEFAULT_TONE ? 'Alarma predeterminada del sistema' : 'Tono elegido del sistema'}
          </Text>
          <Pressable style={[s.btn, { backgroundColor: C.line }]} onPress={pickTone}>
            <Text style={s.btnTxt}>Elegir tono del sistema</Text>
          </Pressable>
          <Pressable style={[s.btn, { backgroundColor: C.line, marginTop: 10 }]} onPress={toggleTest}>
            <Text style={s.btnTxt}>{testing ? '■ Detener prueba' : '▶ Probar sonido'}</Text>
          </Pressable>

          <Text style={s.section}>Segundo plano</Text>
          <Text style={s.note}>Mientras haya alarmas activas la app mantiene una notificación fija para seguir vigilando con el móvil bloqueado. Quita también la optimización de batería. Tras reiniciar el móvil, abre la app una vez.</Text>
          <Pressable style={[s.btn, { backgroundColor: C.line, marginTop: 10 }]} onPress={batteryExempt}>
            <Text style={s.btnTxt}>Quitar optimización de batería</Text>
          </Pressable>

          <Pressable style={[s.btn, { backgroundColor: C.spot, marginTop: 18 }]} onPress={onClose}>
            <Text style={[s.btnTxt, { color: '#06281d' }]}>Cerrar</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const Chip = ({ text, on, onPress }) => (
  <Pressable onPress={onPress} style={[s.chip, on && { backgroundColor: C.text, borderColor: C.text }]}>
    <Text style={{ color: on ? C.bg : C.text, fontWeight: '600' }}>{text}</Text>
  </Pressable>
);

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: RNStatusBar.currentHeight || 0 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 },
  title: { color: C.text, fontSize: 26, fontWeight: '800' },
  link: { color: C.muted, fontSize: 16 },
  num: { fontVariant: ['tabular-nums'] },
  welcome: { flex: 1, justifyContent: 'center', padding: 32 },
  welcomeTitle: { color: C.text, fontSize: 24, fontWeight: '800', marginBottom: 10 },
  welcomeText: { color: C.muted, fontSize: 16, lineHeight: 23, marginBottom: 28 },
  cta: { backgroundColor: C.spot, borderRadius: 14, paddingVertical: 18, alignItems: 'center' },
  ctaTxt: { color: '#06281d', fontSize: 18, fontWeight: '800' },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 14, marginBottom: 14 },
  pair: { color: C.text, fontSize: 18, fontWeight: '800', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: C.line, marginVertical: 4 },
  price: { color: C.text, fontSize: 24, fontWeight: '700' },
  spotRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, paddingHorizontal: 12, marginVertical: 4, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.spot, backgroundColor: '#10B98114' },
  spotTxt: { color: C.spot, fontWeight: '700', fontSize: 14 },
  fab: { position: 'absolute', right: 20, bottom: 32, width: 62, height: 62, borderRadius: 31, backgroundColor: C.spot, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  fabTxt: { color: '#06281d', fontSize: 34, marginTop: -2, fontWeight: '600' },
  backdrop: { flex: 1, backgroundColor: '#000A' },
  sheet: { backgroundColor: C.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, maxHeight: '88%' },
  sheetScroll: { flexShrink: 1 },
  delBtn: { borderWidth: 1, borderColor: C.danger },
  delTxt: { color: C.danger, fontWeight: '800', fontSize: 16 },
  status: { color: C.muted, fontSize: 12, paddingHorizontal: 20, marginTop: -6, marginBottom: 6 },
  sheetTitle: { color: C.text, fontSize: 20, fontWeight: '800', marginBottom: 14 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8 },
  seg: { flexDirection: 'row', backgroundColor: C.bg, borderRadius: 12, padding: 4, marginBottom: 14 },
  segBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 9 },
  input: { color: C.text, fontSize: 34, fontWeight: '700', textAlign: 'center', backgroundColor: C.bg, borderRadius: 12, paddingVertical: 14, marginBottom: 12 },
  adjRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  adjBtn: { flex: 1, backgroundColor: C.line, borderRadius: 10, paddingVertical: 13, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'center' },
  adjTxt: { color: C.text, fontWeight: '700', fontSize: 15 },
  spotBtn: { flex: 1.8, borderWidth: 1, borderColor: C.spot, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 2, alignItems: 'center', justifyContent: 'center' },
  spotLbl: { color: C.spot, fontWeight: '700', fontSize: 13 },
  spotPx: { color: C.spot, fontSize: 11 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  btnTxt: { color: C.text, fontWeight: '800', fontSize: 16 },
  section: { color: C.muted, fontSize: 14, fontWeight: '700', marginTop: 16, marginBottom: 8 },
  radio: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.muted, marginRight: 12 },
  note: { color: C.muted, fontSize: 12, marginTop: 2 },
  select: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.bg, borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 14 },
  selectTxt: { color: C.text, fontSize: 20, fontWeight: '800' },
  options: { backgroundColor: C.bg, borderRadius: 12, borderWidth: 1, borderColor: C.line, marginTop: -6, marginBottom: 14, overflow: 'hidden' },
  option: { paddingVertical: 13, paddingHorizontal: 16 },
  keyInput: { color: C.text, backgroundColor: C.bg, borderRadius: 10, padding: 12, marginTop: 6 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  refresh: { color: C.text, fontSize: 22, fontWeight: '800', minWidth: 70, textAlign: 'center' },
  ringing: { flex: 1, backgroundColor: C.danger, justifyContent: 'center', alignItems: 'center', padding: 28 },
  ringTitle: { color: '#fff', fontSize: 40, fontWeight: '900', marginBottom: 20 },
  ringLine: { color: '#fff', fontSize: 26, fontWeight: '700', marginBottom: 8, fontVariant: ['tabular-nums'] },
  ringBtn: { backgroundColor: '#fff', borderRadius: 16, paddingVertical: 20, paddingHorizontal: 40, marginTop: 36 },
  ringBtnTxt: { color: C.danger, fontSize: 22, fontWeight: '900' },
});
