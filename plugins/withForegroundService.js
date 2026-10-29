// react-native-background-actions en Android 14+:
//  1) el servicio de primer plano debe declarar su tipo en el manifiesto
//  2) la librería usa ServiceCompat.startForeground(.., tipo), que exige androidx.core >= 1.12
const { withAndroidManifest, withProjectBuildGradle, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

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
  // 3) la notificación fija de la librería solo muestra una línea: la pasamos a texto expandible
  config = withDangerousMod(config, ['android', (c) => {
    const f = path.join(c.modRequest.projectRoot,
      'node_modules/react-native-background-actions/android/src/main/java/com/asterinet/react/bgactions/RNBackgroundActionsTask.java');
    let src = fs.readFileSync(f, 'utf8');
    if (!src.includes('BigTextStyle')) {
      const needle = '.setContentText(taskDesc)';
      if (!src.includes(needle)) throw new Error('withForegroundService: no se encontró setContentText en RNBackgroundActionsTask.java');
      src = src.replace(needle, needle + '\n                .setStyle(new NotificationCompat.BigTextStyle().bigText(taskDesc))');
      fs.writeFileSync(f, src);
    }
    return c;
  }]);
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
