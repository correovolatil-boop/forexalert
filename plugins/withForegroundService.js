// Ajustes nativos para que la alarma sea prioritaria (se aplican en `expo prebuild`, de forma idempotente):
//  1) servicio de primer plano con tipo declarado (Android 14+) y androidx.core >= 1.12 (lo exige la librería)
//  2) notificación fija expandible + notificación de ALARMA aparte: prioritaria, silenciosa (el sonido lo pone la
//     app en bucle) y a pantalla completa para que salga sobre la pantalla de bloqueo
//  3) el audio de la app sale por el canal de ALARMA (volumen de alarma, respeta «No molestar» para alarmas)
//  4) MainActivity visible con el móvil bloqueado y que enciende la pantalla
const { withAndroidManifest, withProjectBuildGradle, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';
const MARK = '// alarmas-forex: androidx.core reciente';
const BG = 'node_modules/react-native-background-actions/android/src/main/java/com/asterinet/react/bgactions/';
const EXO = 'node_modules/expo-av/android/src/main/java/expo/modules/av/player/SimpleExoPlayerData.java';

const ALARM_METHOD = `
    public static final int ALARM_NOTIFICATION_ID = 92902;
    private static final String ALARM_CHANNEL_ID = "ALARM_FIRED_CHANNEL";

    // Titulo que empieza por \\u23F0 = alarma disparada: notificacion aparte, prioritaria y a pantalla completa
    public static void syncAlarmNotification(@NonNull Context context, @NonNull final BackgroundTaskOptions bgOptions) {
        final NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        final String title = bgOptions.getTaskTitle();
        if (!title.startsWith("\\u23F0")) {
            nm.cancel(ALARM_NOTIFICATION_ID);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            final NotificationChannel ch = new NotificationChannel(ALARM_CHANNEL_ID, "Alarma disparada", NotificationManager.IMPORTANCE_HIGH);
            ch.setSound(null, null);
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[]{0, 600, 300, 600});
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }
        final Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) {
            return;
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        final PendingIntent pi = PendingIntent.getActivity(context, 1, launch, flags);
        final String desc = bgOptions.getTaskDesc();
        final Notification n = new NotificationCompat.Builder(context, ALARM_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(desc)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(desc))
                .setSmallIcon(bgOptions.getIconInt())
                .setColor(bgOptions.getColor())
                .setContentIntent(pi)
                .setFullScreenIntent(pi, true)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
        nm.notify(ALARM_NOTIFICATION_ID, n);
    }
`;

// Cada paso: [marca que indica que ya está aplicado, texto a buscar, texto nuevo]
function patchFile(root, rel, steps) {
  const f = path.join(root, rel);
  let src = fs.readFileSync(f, 'utf8');
  for (const [marker, needle, replacement] of steps) {
    if (src.includes(marker)) continue;
    if (src.split(needle).length !== 2) {
      throw new Error(`withForegroundService: no se pudo parchear ${rel} (no se encontró de forma única: ${needle.trim().slice(0, 60)})`);
    }
    src = src.replace(needle, () => replacement);
  }
  fs.writeFileSync(f, src);
}

module.exports = (config) => {
  config = withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application[0];
    app.service = app.service || [];
    let svc = app.service.find((x) => x.$['android:name'] === NAME);
    if (!svc) { svc = { $: { 'android:name': NAME } }; app.service.push(svc); }
    svc.$['android:foregroundServiceType'] = 'dataSync';
    const main = (app.activity || []).find((a) => /MainActivity$/.test(a.$['android:name']));
    if (main) {
      main.$['android:showWhenLocked'] = 'true';
      main.$['android:turnScreenOn'] = 'true';
    }
    return c;
  });

  config = withDangerousMod(config, ['android', (c) => {
    const root = c.modRequest.projectRoot;
    patchFile(root, BG + 'RNBackgroundActionsTask.java', [
      ['BigTextStyle().bigText(taskDesc)', '.setContentText(taskDesc)',
        '.setContentText(taskDesc)\n                .setStyle(new NotificationCompat.BigTextStyle().bigText(taskDesc))'],
      ['syncAlarmNotification', 'public static final int SERVICE_NOTIFICATION_ID = 92901;',
        'public static final int SERVICE_NOTIFICATION_ID = 92901;\n' + ALARM_METHOD],
    ]);
    patchFile(root, BG + 'BackgroundActionsModule.java', [
      ['syncAlarmNotification',
        'notificationManager.notify(RNBackgroundActionsTask.SERVICE_NOTIFICATION_ID, notification);',
        'notificationManager.notify(RNBackgroundActionsTask.SERVICE_NOTIFICATION_ID, notification);\n            RNBackgroundActionsTask.syncAlarmNotification(reactContext, bgOptions);'],
      ['ALARM_NOTIFICATION_ID', 'public void stop(@NonNull final Promise promise) {',
        'public void stop(@NonNull final Promise promise) {\n        ((NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(RNBackgroundActionsTask.ALARM_NOTIFICATION_ID);'],
    ]);
    patchFile(root, EXO, [
      ['USAGE_ALARM', '    mSimpleExoPlayer.addListener(this);',
        '    mSimpleExoPlayer.setAudioAttributes(new com.google.android.exoplayer2.audio.AudioAttributes.Builder().setUsage(C.USAGE_ALARM).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), false);\n    mSimpleExoPlayer.addListener(this);'],
    ]);
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
