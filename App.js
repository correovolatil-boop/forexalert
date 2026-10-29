import './src/bg';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, Pressable, ScrollView, Modal, TextInput, Switch, Alert,
  AppState, StatusBar as RNStatusBar, StyleSheet,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Audio } from 'expo-av';
import {
  PAIRS, SOURCES, DEFAULT_SETTINGS, fmt, steps, loadAlarms, saveAlarms,
  loadSettings, saveSettings, getPrices, checkAlarms,
} from './src/core';
import { setupBackground, notifyFired } from './src/bg';

const TONES = [
  { name: 'Sirena', src: require('./assets/sirena.wav') },
  { name: 'Pulso', src: require('./assets/pulso.wav') },
  { name: 'Campana', src: require('./assets/campana.wav') },
];

const C = {
  bg: '#0D1520', card: '#142033', line: '#243650', text: '#E6EDF5', muted: '#7F93AB',
  spot: '#10B981', above: '#F59E0B', below: '#60A5FA', danger: '#EF4444',
};

// ---------- sonido en bucle ----------
function useLoopSound() {
  const ref = useRef(null);
  const stop = useCallback(async () => {
    const s = ref.current;
    ref.current = null;
    if (s) { try { await s.stopAsync(); await s.unloadAsync(); } catch {} }
  }, []);
  const play = useCallback(async (idx) => {
    await stop();
    try {
      await Audio.setAudioModeAsync({ staysActiveInBackground: true, shouldDuckAndroid: false });
      const { sound } = await Audio.Sound.createAsync(TONES[idx]?.src ?? TONES[0].src,
        { isLooping: true, shouldPlay: true, volume: 1 });
      ref.current = sound;
    } catch {}
  }, [stop]);
  return { play, stop };
}

// ---------- App ----------
export default function App() {
  const [alarms, setAlarms] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [prices, setPrices] = useState({});
  const [editing, setEditing] = useState(null); // null | {} (nueva) | alarma
  const [showSettings, setShowSettings] = useState(false);
  const [ready, setReady] = useState(false);
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

  const tick = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const pairs = [...new Set(alarmsRef.current.map((a) => a.pair))];
      const p = await getPrices(settingsRef.current, pairs);
      if (!Object.keys(p).length) return;
      setPrices((prev) => ({ ...prev, ...p }));
      const { alarms: next, fired } = checkAlarms(alarmsRef.current, p);
      if (fired.length) {
        commit(next);
        if (AppState.currentState !== 'active') notifyFired(fired);
      }
    } finally { busy.current = false; }
  }, [commit]);

  useEffect(() => {
    if (!ready) return undefined;
    tick();
    const id = setInterval(tick, settings.refresh * 1000);
    return () => clearInterval(id);
  }, [ready, settings.refresh, settings.source, settings.apiKey, alarms.length, tick]);

  // Al volver a primer plano: la tarea de fondo pudo haber disparado alarmas
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (st) => {
      if (st !== 'active') return;
      const a = await loadAlarms();
      alarmsRef.current = a; setAlarms(a);
      tick();
    });
    return () => sub.remove();
  }, [tick]);

  // Alarma sonando = activada y disparada, hasta que el usuario la apague
  const ringing = alarms.filter((a) => a.enabled && a.fired);
  const isRinging = ringing.length > 0;
  useEffect(() => {
    if (isRinging) ring.play(settingsRef.current.tone); else ring.stop();
  }, [isRinging, ring]);

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
     { text: 'Eliminar', style: 'destructive', onPress: () => commit(alarmsRef.current.filter((x) => x.id !== a.id)) }],
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

      {ready && alarms.length === 0 ? (
        <View style={s.welcome}>
          <Text style={s.welcomeTitle}>Aún no tienes alarmas</Text>
          <Text style={s.welcomeText}>Crea una y el par aparecerá aquí con su precio en vivo. Sonará hasta que la apagues.</Text>
          <Pressable style={s.cta} onPress={() => setEditing({})}><Text style={s.ctaTxt}>+ Crear Alarma</Text></Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
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
                  <Pressable onPress={() => remove(it.a)} hitSlop={10} style={{ paddingLeft: 14 }}>
                    <Text style={{ fontSize: 22 }}>🗑</Text>
                  </Pressable>
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
      )}

      {alarms.length > 0 && (
        <Pressable style={s.fab} onPress={() => setEditing({})}><Text style={s.fabTxt}>+</Text></Pressable>
      )}

      <AlarmModal alarm={editing} prices={prices} settings={settings} onSave={saveAlarm} onClose={() => setEditing(null)} />
      <SettingsModal visible={showSettings} settings={settings} onChange={changeSettings} onClose={() => setShowSettings(false)} />

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
function AlarmModal({ alarm, prices, settings, onSave, onClose }) {
  const [pair, setPair] = useState('EUR/USD');
  const [cond, setCond] = useState('above');
  const [text, setText] = useState('');
  useEffect(() => {
    if (!alarm) return;
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
  return (
    <Modal visible={alarm !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={s.sheetTitle}>{alarm?.id ? 'Editar alarma' : 'Crear alarma'}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
            {PAIRS.map((p) => (
              <Chip key={p} text={p} on={p === pair} onPress={() => setPair(p)} />
            ))}
          </ScrollView>
          <View style={s.seg}>
            {[['above', 'POR ENCIMA', C.above], ['below', 'POR DEBAJO', C.below]].map(([k, t, col]) => (
              <Pressable key={k} onPress={() => setCond(k)}
                style={[s.segBtn, cond === k && { backgroundColor: col }]}>
                <Text style={{ fontWeight: '700', color: cond === k ? '#0D1520' : C.muted }}>{t}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            value={text} onChangeText={setText} keyboardType="decimal-pad" placeholder={fmt(pair, 0)}
            placeholderTextColor={C.line} style={[s.input, s.num]} selectTextOnFocus
          />
          <View style={s.adjRow}>
            {adj.map(([d, sg]) => (
              <Pressable key={d} style={s.adjBtn} onPress={() => adjust(d)}>
                <Text style={s.adjTxt}>{sg}{label(Math.abs(d))}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable style={s.spotBtn} onPress={useSpot}>
            <Text style={{ color: C.spot, fontWeight: '700' }}>● Spot Actual{prices[pair] != null ? `  ${fmt(pair, prices[pair])}` : ''}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
            <Pressable style={[s.btn, { backgroundColor: C.line }]} onPress={onClose}><Text style={s.btnTxt}>Cancelar</Text></Pressable>
            <Pressable style={[s.btn, { backgroundColor: C.spot }]} onPress={save}>
              <Text style={[s.btnTxt, { color: '#06281d' }]}>{alarm?.id ? 'Guardar cambios' : 'Crear alarma'}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ---------- modal configuración ----------
function SettingsModal({ visible, settings, onChange, onClose }) {
  const test = useLoopSound();
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (!visible) { test.stop(); setTesting(false); } }, [visible, test]);
  const toggleTest = async () => {
    if (testing) { await test.stop(); setTesting(false); } else { await test.play(settings.tone); setTesting(true); }
  };
  const setTone = async (i) => {
    onChange({ tone: i });
    if (testing) await test.play(i);
  };
  const setRefresh = (v) => onChange({ refresh: Math.max(1, Math.min(60, v)) });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={s.sheetTitle}>Ajustes</Text>

          <Text style={s.section}>Fuente de datos</Text>
          {SOURCES.map((src) => (
            <Pressable key={src.id} style={s.radio} onPress={() => onChange({ source: src.id })}>
              <View style={[s.dot, settings.source === src.id && { backgroundColor: C.spot, borderColor: C.spot }]} />
              <Text style={{ color: C.text, flex: 1 }}>{src.name}{src.id === 'icm' ? ' (por defecto)' : ''}</Text>
            </Pressable>
          ))}
          {settings.source === 'av' && (
            <TextInput value={settings.apiKey} onChangeText={(t) => onChange({ apiKey: t.trim() })}
              placeholder="API Key de Alpha Vantage" placeholderTextColor={C.muted}
              autoCapitalize="none" autoCorrect={false} style={s.keyInput} />
          )}

          <Text style={s.section}>Intervalo de refresco</Text>
          <View style={s.stepper}>
            <Pressable style={s.adjBtn} onPress={() => setRefresh(settings.refresh - 1)}><Text style={s.adjTxt}>−</Text></Pressable>
            <Text style={s.refresh}>{settings.refresh} s</Text>
            <Pressable style={s.adjBtn} onPress={() => setRefresh(settings.refresh + 1)}><Text style={s.adjTxt}>+</Text></Pressable>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {[1, 5, 10, 30, 60].map((v) => (
              <Chip key={v} text={`${v} s`} on={settings.refresh === v} onPress={() => setRefresh(v)} />
            ))}
          </View>

          <Text style={s.section}>Tono de alarma</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {TONES.map((t, i) => <Chip key={t.name} text={t.name} on={settings.tone === i} onPress={() => setTone(i)} />)}
          </View>
          <Pressable style={[s.btn, { backgroundColor: C.line, marginTop: 10 }]} onPress={toggleTest}>
            <Text style={s.btnTxt}>{testing ? '■ Detener prueba' : '▶ Probar sonido'}</Text>
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
  sheetTitle: { color: C.text, fontSize: 20, fontWeight: '800', marginBottom: 14 },
  chip: { borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8 },
  seg: { flexDirection: 'row', backgroundColor: C.bg, borderRadius: 12, padding: 4, marginBottom: 14 },
  segBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 9 },
  input: { color: C.text, fontSize: 34, fontWeight: '700', textAlign: 'center', backgroundColor: C.bg, borderRadius: 12, paddingVertical: 14, marginBottom: 12 },
  adjRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  adjBtn: { flex: 1, backgroundColor: C.line, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  adjTxt: { color: C.text, fontWeight: '700', fontSize: 15 },
  spotBtn: { borderWidth: 1, borderColor: C.spot, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginBottom: 12 },
  btn: { flex: 1, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  btnTxt: { color: C.text, fontWeight: '800', fontSize: 16 },
  section: { color: C.muted, fontSize: 14, fontWeight: '700', marginTop: 16, marginBottom: 8 },
  radio: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.muted, marginRight: 12 },
  keyInput: { color: C.text, backgroundColor: C.bg, borderRadius: 10, padding: 12, marginTop: 6 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  refresh: { color: C.text, fontSize: 22, fontWeight: '800', minWidth: 70, textAlign: 'center' },
  ringing: { flex: 1, backgroundColor: C.danger, justifyContent: 'center', alignItems: 'center', padding: 28 },
  ringTitle: { color: '#fff', fontSize: 40, fontWeight: '900', marginBottom: 20 },
  ringLine: { color: '#fff', fontSize: 26, fontWeight: '700', marginBottom: 8, fontVariant: ['tabular-nums'] },
  ringBtn: { backgroundColor: '#fff', borderRadius: 16, paddingVertical: 20, paddingHorizontal: 40, marginTop: 36 },
  ringBtnTxt: { color: C.danger, fontSize: 22, fontWeight: '900' },
});
