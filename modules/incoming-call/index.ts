import { requireOptionalNativeModule } from 'expo-modules-core';

export interface ShowFullScreenIncomingCallParams {
  callUUID: string;
  callerName: string;
  isVideo: boolean;
  friendId: string;
  roomName: string;
}

/** Payload for onAnswerFromNotification / onDeclineFromNotification — see IncomingCallActionReceiver.kt. */
export interface NotificationCallActionEvent {
  callUUID: string;
  friendId: string;
  roomName: string;
  isVideo: boolean;
  callerName: string;
}

interface IncomingCallNativeModuleEvents {
  /** Fired the instant Answer is tapped on the notification — resolves before the app even opens. */
  onAnswerFromNotification(event: NotificationCallActionEvent): void;
  /** Fired the instant Decline is tapped on the notification — resolves before the app even opens. */
  onDeclineFromNotification(event: NotificationCallActionEvent): void;
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
   * Resets the showWhenLocked/turnScreenOn flags that showFullScreenIncomingCall's lock-screen
   * bypass sets — those only ever get set to true, never back to false, so without this call
   * the app keeps floating over the lock screen for a while after a call ends. Call once a
   * call has torn down.
   */
  clearLockScreenFlags(): void;

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

  addListener<EventName extends keyof IncomingCallNativeModuleEvents>(
    eventName: EventName,
    listener: IncomingCallNativeModuleEvents[EventName]
  ): { remove(): void };
}

// Android-only module: requireOptionalNativeModule returns null (instead of throwing)
// on iOS/web, so importing this file is safe everywhere.
export default requireOptionalNativeModule<IncomingCallNativeModule>('IncomingCall');
