// Android 14+: el servicio de primer plano de react-native-background-actions debe declarar su tipo.
const { withAndroidManifest } = require('expo/config-plugins');

const NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

module.exports = (config) => withAndroidManifest(config, (c) => {
  const app = c.modResults.manifest.application[0];
  app.service = app.service || [];
  let svc = app.service.find((x) => x.$['android:name'] === NAME);
  if (!svc) { svc = { $: { 'android:name': NAME } }; app.service.push(svc); }
  svc.$['android:foregroundServiceType'] = 'dataSync';
  return c;
});
