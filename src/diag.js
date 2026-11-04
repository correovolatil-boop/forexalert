import { NativeModules } from 'react-native';

// Estado del sistema que decide si la alarma puede sonar/mostrarse (lo expone el módulo nativo parcheado)
const N = NativeModules.RNBackgroundActions;
export const getDiag = () => (N?.getAlarmDiagnostics ? N.getAlarmDiagnostics() : Promise.resolve(null));
// what: 'fullscreen' | 'battery' | 'channel' | 'app'
export const openSetting = (what) => (N?.openAlarmSettings ? N.openAlarmSettings(what) : Promise.resolve());
