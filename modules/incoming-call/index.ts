import { requireOptionalNativeModule } from 'expo-modules-core';

export interface ShowFullScreenIncomingCallParams {
  callUUID: string;
  callerName: string;
  isVideo: boolean;
  friendId: string;
  roomName: string;
}

interface IncomingCallNativeModule {
  /**
   * Posts a native CallStyle notification with `setFullScreenIntent` — Android's dedicated
   * incoming-call template (caller identity + full-width Answer/Decline buttons), ringing
   * with the device ringtone on a looping basis, bypassing the lock screen and launching
   * straight into the app's existing ringing UI. The same mechanism WhatsApp/Signal use.
   */
  showFullScreenIncomingCall(params: ShowFullScreenIncomingCallParams): void;

  /** Cancels the notification previously posted for this callUUID, if still showing. */
  dismiss(callUUID: string): void;

  /**
   * Whether the incoming-call notification for this callUUID is currently displayed.
   * Queries the system notification manager, so it stays correct across process restarts.
   */
  isShowing(callUUID: string): boolean;

  /**
   * Whether the OS currently grants this app permission to bypass the lock screen with
   * showFullScreenIncomingCall. Always true below Android 14, where the manifest declaration
   * alone is sufficient; on 14+ the user (or the system) can silently revoke it.
   */
  canUseFullScreenIntent(): boolean;

  /** Opens the OS settings screen to grant the above. No-op below Android 14. */
  openFullScreenIntentSettings(): void;

  /** Whether this app is exempt from Doze/App Standby battery optimization. */
  isIgnoringBatteryOptimizations(): boolean;

  /** Shows the native system dialog to request the exemption above. */
  requestIgnoreBatteryOptimizations(): void;
}

// Android-only module: requireOptionalNativeModule returns null (instead of throwing)
// on iOS/web, so importing this file is safe everywhere.
export default requireOptionalNativeModule<IncomingCallNativeModule>('IncomingCall');
