const fs = require('fs');
const path = require('path');

// --- Patch 1: Gradle foojay-resolver-convention version ---
const gradleFile = path.join(__dirname, '../node_modules/@react-native/gradle-plugin/settings.gradle.kts');

if (fs.existsSync(gradleFile)) {
  let content = fs.readFileSync(gradleFile, 'utf8');
  const regex = /id\("org\.gradle\.toolchains\.foojay-resolver-convention"\)\.version\("[^"]+"\)/;
  if (regex.test(content)) {
    content = content.replace(regex, 'id("org.gradle.toolchains.foojay-resolver-convention").version("1.0.0")');
    fs.writeFileSync(gradleFile, content, 'utf8');
    console.log('[patch] Gradle foojay-resolver-convention → 1.0.0');
  } else {
    console.log('[patch] Gradle foojay-resolver-convention: already patched or not found');
  }
} else {
  console.log('[patch] Gradle settings file not found, skipping');
}

// --- Patch 2: react-native-callkeep duplicate @ReactMethod crash ---
// React Native's TurboModule interop rejects modules that export two JS methods
// with the same name. RNCallKeepModule has overloaded displayIncomingCall and
// startCall each with @ReactMethod on multiple signatures. We keep only the
// most-parameterised overload annotated, and remove @ReactMethod from the
// shorter ones so they remain usable as internal Java helpers.
const callkeepModule = path.join(
  __dirname,
  '../node_modules/react-native-callkeep/android/src/main/java/io/wazo/callkeep/RNCallKeepModule.java'
);

if (fs.existsSync(callkeepModule)) {
  let src = fs.readFileSync(callkeepModule, 'utf8');
  let patched = false;

  // Remove @ReactMethod from: displayIncomingCall(String, String, String)
  const displayShort = '@ReactMethod\n    public void displayIncomingCall(String uuid, String number, String callerName) {';
  if (src.includes(displayShort)) {
    src = src.replace(displayShort, 'public void displayIncomingCall(String uuid, String number, String callerName) {');
    patched = true;
  }

  // Remove @ReactMethod from: startCall(String, String, String)
  const startShort = '@ReactMethod\n    public void startCall(String uuid, String number, String callerName) {';
  if (src.includes(startShort)) {
    src = src.replace(startShort, 'public void startCall(String uuid, String number, String callerName) {');
    patched = true;
  }

  if (patched) {
    fs.writeFileSync(callkeepModule, src, 'utf8');
    console.log('[patch] RNCallKeepModule: removed duplicate @ReactMethod annotations');
  } else {
    console.log('[patch] RNCallKeepModule: already patched or pattern not found');
  }
} else {
  console.log('[patch] RNCallKeepModule.java not found, skipping');
}

// --- Patch 3: Self-managed mode must also request READ_PHONE_NUMBERS ---
// On Android 30+, VoiceConnectionService.createConnection() calls
// telecomManager.getPhoneAccount() which requires READ_PHONE_NUMBERS.
// In self-managed mode, CallKeep only requests RECORD_AUDIO, so
// hasPermissions() fails and calls are silently dropped. If the call
// somehow reaches VoiceConnectionService anyway, it crashes with
// SecurityException. Fix: add READ_PHONE_NUMBERS to the self-managed
// permissions array.
if (fs.existsSync(callkeepModule)) {
  let src = fs.readFileSync(callkeepModule, 'utf8');
  const selfManagedPerms = 'permissions = new String[]{ Manifest.permission.RECORD_AUDIO };';
  const fixedPerms = 'permissions = new String[]{ Manifest.permission.RECORD_AUDIO, Manifest.permission.READ_PHONE_NUMBERS };';
  if (src.includes(selfManagedPerms)) {
    src = src.replace(selfManagedPerms, fixedPerms);
    fs.writeFileSync(callkeepModule, src, 'utf8');
    console.log('[patch] RNCallKeepModule: added READ_PHONE_NUMBERS to self-managed permissions');
  } else {
    console.log('[patch] RNCallKeepModule self-managed perms: already patched or not found');
  }
}

// --- Patch 4: Wrap getPhoneAccount() in try/catch in VoiceConnectionService ---
// Even if the permission is requested, the user may deny it. The native
// VoiceConnectionService calls telecomManager.getPhoneAccount() without any
// error handling, causing a fatal SecurityException crash. We wrap it so the
// app gracefully degrades instead of crashing.
const voiceConnService = path.join(
  __dirname,
  '../node_modules/react-native-callkeep/android/src/main/java/io/wazo/callkeep/VoiceConnectionService.java'
);

if (fs.existsSync(voiceConnService)) {
  let src = fs.readFileSync(voiceConnService, 'utf8');

  const crashingBlock = `if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Context context = getApplicationContext();
            TelecomManager telecomManager = (TelecomManager) context.getSystemService(context.TELECOM_SERVICE);
            PhoneAccount phoneAccount = telecomManager.getPhoneAccount(request.getAccountHandle());

            //If the phone account is self managed, then this connection must also be self managed.
            if((phoneAccount.getCapabilities() & PhoneAccount.CAPABILITY_SELF_MANAGED) == PhoneAccount.CAPABILITY_SELF_MANAGED) {
                Log.d(TAG, "[VoiceConnectionService] PhoneAccount is SELF_MANAGED, so connection will be too");
                connection.setConnectionProperties(Connection.PROPERTY_SELF_MANAGED);
            }
            else {
                Log.d(TAG, "[VoiceConnectionService] PhoneAccount is not SELF_MANAGED, so connection won't be either");
            }
        }`;

  const safeBlock = `if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                Context context = getApplicationContext();
                TelecomManager telecomManager = (TelecomManager) context.getSystemService(context.TELECOM_SERVICE);
                PhoneAccount phoneAccount = telecomManager.getPhoneAccount(request.getAccountHandle());

                //If the phone account is self managed, then this connection must also be self managed.
                if(phoneAccount != null && (phoneAccount.getCapabilities() & PhoneAccount.CAPABILITY_SELF_MANAGED) == PhoneAccount.CAPABILITY_SELF_MANAGED) {
                    Log.d(TAG, "[VoiceConnectionService] PhoneAccount is SELF_MANAGED, so connection will be too");
                    connection.setConnectionProperties(Connection.PROPERTY_SELF_MANAGED);
                }
                else {
                    Log.d(TAG, "[VoiceConnectionService] PhoneAccount is not SELF_MANAGED, so connection won't be either");
                }
            } catch (SecurityException e) {
                Log.w(TAG, "[VoiceConnectionService] SecurityException getting phone account, assuming SELF_MANAGED: " + e.getMessage());
                connection.setConnectionProperties(Connection.PROPERTY_SELF_MANAGED);
            }
        }`;

  if (src.includes(crashingBlock)) {
    src = src.replace(crashingBlock, safeBlock);
    fs.writeFileSync(voiceConnService, src, 'utf8');
    console.log('[patch] VoiceConnectionService: wrapped getPhoneAccount() in try/catch');
  } else {
    console.log('[patch] VoiceConnectionService: already patched or pattern not found');
  }
} else {
  console.log('[patch] VoiceConnectionService.java not found, skipping');
}

// --- Patch 5: Hold a wake lock while running the background remote-notification task ---
// executeTask() calls task.execute(bundle, null) with no wake lock and no protection
// against the process being suspended mid-flight. Verified on-device via adb logcat: a
// killed/backgrounded incoming-call push wakes the process just long enough to start
// ("ActivityManager: sync unfroze <pid> com.jemturk.crumbo for 3", followed by a large
// Choreographer frame-skip — real work happening) but the JS engine never finishes
// bootstrapping before the OS re-freezes the process, so callkeep.ts's background task
// handler (and displayIncomingCall) never runs — no ring, no banner, nothing. A
// PARTIAL_WAKE_LOCK held for the duration of task execution (with its own timeout as a
// safety net, so a crash/exception in the JS task can't leak it) fixes this the same way
// the now-deprecated WakefulBroadcastReceiver did for this exact scenario.
const bgTaskConsumer = path.join(
  __dirname,
  '../node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/notifications/background/BackgroundRemoteNotificationTaskConsumer.kt'
);

if (fs.existsSync(bgTaskConsumer)) {
  let src = fs.readFileSync(bgTaskConsumer, 'utf8');

  const originalImport = 'import android.os.Bundle';
  const patchedImport = 'import android.os.Bundle\nimport android.os.PowerManager';

  const originalExecuteTask = `  fun executeTask(bundle: Bundle) {
    requireNotNull(task) { "executeTask called but no task is registered" }.execute(bundle, null)
  }`;

  const patchedExecuteTask = `  fun executeTask(bundle: Bundle) {
    val task = requireNotNull(task) { "executeTask called but no task is registered" }

    val powerManager = getContext()?.getSystemService(Context.POWER_SERVICE) as? PowerManager
    val wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "crumbo:BackgroundRemoteNotificationTask")
    wakeLock?.acquire(20000L)

    fun releaseWakeLock() {
      if (wakeLock?.isHeld == true) {
        try {
          wakeLock.release()
        } catch (e: Exception) {
          // Already released by its own 20s timeout — nothing more to do.
        }
      }
    }

    try {
      task.execute(bundle, null) { releaseWakeLock() }
    } catch (e: Exception) {
      releaseWakeLock()
      throw e
    }
  }`;

  if (src.includes(originalExecuteTask)) {
    src = src.replace(originalImport, patchedImport);
    src = src.replace(originalExecuteTask, patchedExecuteTask);
    fs.writeFileSync(bgTaskConsumer, src, 'utf8');
    console.log('[patch] BackgroundRemoteNotificationTaskConsumer: added wake lock around executeTask()');
  } else {
    console.log('[patch] BackgroundRemoteNotificationTaskConsumer: already patched or pattern not found');
  }
} else {
  console.log('[patch] BackgroundRemoteNotificationTaskConsumer.kt not found, skipping');
}

