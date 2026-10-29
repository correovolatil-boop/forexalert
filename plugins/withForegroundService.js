// react-native-background-actions en Android 14+:
//  1) el servicio de primer plano debe declarar su tipo en el manifiesto
//  2) la librería usa ServiceCompat.startForeground(.., tipo), que exige androidx.core >= 1.12
const { withAndroidManifest, withProjectBuildGradle } = require('expo/config-plugins');

const NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';
const MARK = '// alarmas-forex: androidx.core reciente';

module.exports = (config) => {
  config = withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application[0];
    app.service = app.service || [];
    let svc = app.service.find((x) => x.$['android:name'] === NAME);
    if (!svc) { svc = { $: { 'android:name': NAME } }; app.service.push(svc); }
    svc.$['android:foregroundServiceType'] = 'dataSync';
    return c;
  });
  return withProjectBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes(MARK)) {
      c.modResults.contents += `
${MARK}
allprojects {
  configurations.all {
    resolutionStrategy.force 'androidx.core:core:1.13.1'
  }
}
`;
    }
    return c;
  });
};
