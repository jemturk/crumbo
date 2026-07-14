const { AndroidConfig } = require('expo/config-plugins');

// react-native-callkeep's own native Android library manifest (and the
// @config-plugins/react-native-callkeep Expo plugin) unconditionally declare these
// permissions, regardless of whether CallKeep is running in self-managed mode. They're
// only needed for non-self-managed (real Telecom PhoneAccount) integration.
//
// Crumbo runs CallKeep self-managed (see src/services/callkeep.ts, options.android.selfManaged)
// and needs READ_CALL_LOG instead. We use withBlockedPermissions rather than a plain
// array filter because react-native-callkeep's own AAR manifest
// (node_modules/react-native-callkeep/android/src/main/AndroidManifest.xml) re-declares
// these permissions, and Android's Gradle manifest merger re-adds anything a merged
// library manifest declares unless the app's own manifest marks it `tools:node="remove"`.
const BLOCKED_PERMISSIONS = [
  'android.permission.CALL_PHONE',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_PHONE_NUMBERS',
];

module.exports = function withCallkeepSelfManagedPermissions(config) {
  config = AndroidConfig.Permissions.withPermissions(config, ['android.permission.READ_CALL_LOG']);
  config = AndroidConfig.Permissions.withBlockedPermissions(config, BLOCKED_PERMISSIONS);
  return config;
};
