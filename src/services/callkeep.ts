import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Alert, AppState, Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import IncomingCall from '../../modules/incoming-call';
import { CallSignalPayload, parseCallSignalText, sendCallSignal } from './callSignaling';
import { StorageService } from './storage';

const BACKGROUND_NOTIFICATION_TASK = 'CRUMBO_CALLKEEP_BACKGROUND_NOTIFICATION_TASK';

const options = {
  ios: {
    appName: 'Crumbo',
  },
  android: {
    alertTitle: 'Permissions required',
    alertDescription: 'This application needs to access your phone accounts to make calls.',
    cancelButton: 'Cancel',
    okButton: 'OK',
    imageName: 'ic_launcher',
    additionalPermissions: [],
    selfManaged: true,
  },
};

/**
 * Info needed to build the self-managed incoming-call notification, keyed by callUUID.
 * The `showIncomingCallUi` event CallKeep fires in self-managed mode only carries
 * {handle, callUUID, name} (see react-native-callkeep README), so anything else the
 * notification needs is stashed here by displayIncomingCall() and read back when the
 * event fires.
 */
interface PendingCallInfo {
  friendId?: string;
  roomName?: string;
  isVideo: boolean;
  callerName: string;
}

const getNotificationData = (notification: any) => {
  const body = notification?.request?.content?.body;
  const title = notification?.request?.content?.title;
  const data = notification?.request?.content?.data || {};
  return { body, title, data };
};

const getCallSignalPayload = (notification: any): CallSignalPayload | null => {
  const { data } = getNotificationData(notification);
  if (!data) return null;

  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseCallSignalText(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return null;
  }

  if (typeof data === 'object' && data !== null) {
    return parseCallSignalText(data);
  }

  return null;
};

const dismissNotificationIfCallSignal = async (notification: any) => {
  const identifier = notification?.request?.identifier;
  if (!identifier) return;

  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch (err) {
    console.warn('[CallKeep] Failed to dismiss call signal notification:', err);
  }
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const payload = getCallSignalPayload(notification);
    const isCallSignal = !!payload;
    if (isCallSignal) {
      await dismissNotificationIfCallSignal(notification);
    }

    return {
      shouldShowAlert: !isCallSignal,
      shouldPlaySound: !isCallSignal,
      shouldShowBadge: !isCallSignal,
      shouldShowBanner: !isCallSignal,
      shouldShowList: !isCallSignal,
      shouldSetBadge: !isCallSignal,
    };
  },
});

class CallKeepManager {
  public initialized = false;
  private onAnswerCallback: (() => void) | null = null;
  private onRejectCallback: ((isUserInitiated?: boolean) => void) | null = null;
  private pendingCallInfo = new Map<string, PendingCallInfo>();
  private reliabilityPromptShown = false;

  constructor() {
    this.registerCallKeepListeners();
    this.registerNotificationListeners();
  }

  async setup() {
    if (Platform.OS !== 'android') return;
    if (this.initialized) return;

    try {
      await RNCallKeep.setup(options);
      RNCallKeep.setAvailable(true);
      this.initialized = true;
      console.log('[CallKeep] Setup successfully initialized');

      await Notifications.setNotificationCategoryAsync('incoming-call', [
        {
          identifier: 'answer',
          buttonTitle: 'ANSWER',
          options: { opensAppToForeground: true },
        },
        {
          identifier: 'decline',
          buttonTitle: 'DECLINE',
          options: { opensAppToForeground: false },
        },
      ]);

      await Notifications.setNotificationChannelAsync('calling', {
        name: 'Incoming Calls',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 500, 500],
        lightColor: '#FFC93C',
        showBadge: true,
        enableVibrate: true,
      });

      RNCallKeep.endAllCalls();
      await this.registerBackgroundTask();
      const isConnectionAvailable = await RNCallKeep.isConnectionServiceAvailable();
      console.log('[CallKeep] Android ConnectionService available:', isConnectionAvailable);
    } catch (err) {
      console.error('[CallKeep] Setup error:', err);
    }
  }

  async registerBackgroundTask() {
    if (Platform.OS !== 'android') return;
    try {
      await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
      console.log('[CallKeep] Background notification task registered');
    } catch (err) {
      console.error('[CallKeep] Failed to register background task:', err);
    }
  }

  registerCallbacks(onAnswer: () => void, onReject: (isUserInitiated?: boolean) => void) {
    this.onAnswerCallback = onAnswer;
    this.onRejectCallback = onReject;
  }

  clearCallbacks() {
    this.onAnswerCallback = null;
    this.onRejectCallback = null;
  }

  async displayIncomingCall(
    uuid: string,
    handle: string,
    name: string,
    friendId?: string,
    roomName?: string,
    isVideo?: boolean
  ) {
    console.log('[CRUMBO_DIAG] displayIncomingCall ENTER uuid=', uuid);
    if (Platform.OS !== 'android') return;
    await this.setup();
    console.log('[CRUMBO_DIAG] displayIncomingCall setup() done, initialized=', this.initialized);

    // Self-managed mode's displayIncomingCall doesn't show anything on its own — it just
    // registers the call with Telecom and fires `showIncomingCallUi`, which we handle
    // below by presenting our own notification. Stash the details that event won't carry.
    this.pendingCallInfo.set(uuid, { friendId, roomName, isVideo: !!isVideo, callerName: name });

    try {
      console.log(`[CallKeep] Displaying incoming call: ${uuid} for ${name}`);
      RNCallKeep.displayIncomingCall(uuid, handle, name, 'number', !!isVideo);
    } catch (err) {
      console.error('[CallKeep] Failed to display incoming call:', err);
    }
  }

  async startCall(uuid: string, handle: string, name: string, isVideo = false) {
    if (Platform.OS !== 'android') return;
    await this.setup();

    try {
      console.log(`[CallKeep] Starting outgoing call: ${uuid} to ${name}`);
      RNCallKeep.startCall(uuid, handle, name, 'number', !!isVideo);
    } catch (err) {
      console.error('[CallKeep] Failed to start outgoing call:', err);
    }
  }

  answerCall(uuid: string) {
    if (Platform.OS !== 'android') return;
    try {
      console.log(`[CallKeep] Answering call: ${uuid}`);
      // The CallStyle notification rings insistently until cancelled — answering must silence it.
      IncomingCall?.dismiss(uuid);
      RNCallKeep.answerIncomingCall(uuid);
    } catch (err) {
      console.error('[CallKeep] Failed to answer call:', err);
    }
  }

  endCall(uuid: string) {
    this.pendingCallInfo.delete(uuid);
    if (Platform.OS !== 'android') return;
    try {
      console.log(`[CallKeep] Ending call: ${uuid}`);
      // The CallStyle notification is posted with setOngoing(true) (so it can't be swiped away
      // mid-ring) — Android's NotificationManager.cancelAll(), which is all
      // dismissAllNotificationsAsync() below does, explicitly skips ongoing notifications. So
      // when the caller hangs up before this side answers, that call never actually silenced
      // the still-ringing notification, and it kept ringing until the 45s AlarmManager backstop
      // (or the user) dismissed it. Targeted dismiss-by-id (matching answerCall() above) isn't
      // subject to that exclusion.
      IncomingCall?.dismiss(uuid);
      RNCallKeep.endCall(uuid);
      RNCallKeep.endAllCalls();
      Notifications.dismissAllNotificationsAsync().catch(() => {});
    } catch (err) {
      console.error('[CallKeep] Failed to end call:', err);
    }
  }

  private registerCallKeepListeners() {
    if (Platform.OS !== 'android') return;

    RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
      console.log(`[CallKeep] User answered call from system UI: ${callUUID}`);
      this.onAnswerCallback?.();
    });

    RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
      console.log(`[CallKeep] User ended/rejected call from system UI: ${callUUID}`);
      this.onRejectCallback?.(false);
    });

    // Self-managed only: fired after displayIncomingCall registers the call with Telecom.
    // Unlike non-self-managed mode, nothing is shown automatically — we're required to
    // present our own incoming-call UI here, or Android may start deprioritizing this
    // app's high-priority notifications.
    //
    // This uses the local IncomingCall native module (modules/incoming-call) rather than
    // expo-notifications' scheduleNotificationAsync: expo-notifications has no equivalent of
    // Android's setFullScreenIntent (verified against its Android source — grepped the whole
    // package, no fullScreenIntent/CallStyle support anywhere), so a plain scheduled
    // notification can only ever look like a normal banner. The native module bypasses the
    // lock screen and launches straight into the existing ringing UI, with working
    // Answer/Decline actions on the banner itself.
    RNCallKeep.addEventListener('showIncomingCallUi', ({ callUUID }) => {
      console.log(`[CallKeep] showIncomingCallUi fired for ${callUUID}`);

      // Foregrounded app = the in-app ringing modal (use-call.ts) is already taking over
      // (vibration only, no sound). Posting the CallStyle notification too would still be a
      // confusing double call-UI — WhatsApp likewise shows no notification when you're in the app.
      if (AppState.currentState === 'active') {
        console.log('[CallKeep] App is foregrounded — in-app call UI handles this, skipping notification.');
        return;
      }

      const info = this.pendingCallInfo.get(callUUID);
      const callerName = info?.callerName || 'Crumbo Friend';

      try {
        IncomingCall?.showFullScreenIncomingCall({
          callUUID,
          callerName,
          isVideo: !!info?.isVideo,
          friendId: info?.friendId || '',
          roomName: info?.roomName || '',
        });
      } catch (err) {
        console.error('[CallKeep] Failed to show self-managed incoming call UI:', err);
      }
    });
  }

  /**
   * Whether the native CallStyle incoming-call notification for this call is currently
   * displayed. Used by use-call.ts to decide who owns the ring: when the notification is
   * showing, its channel plays the (looping) ringtone and the in-app ringer must stay
   * silent. Backed by the system notification manager, so it survives process restarts.
   */
  isCallNotificationShowing(callUUID: string): boolean {
    if (Platform.OS !== 'android') return false;
    try {
      return !!IncomingCall?.isShowing(callUUID);
    } catch {
      return false;
    }
  }

  private canUseFullScreenIntent(): boolean {
    if (Platform.OS !== 'android') return true;
    try {
      return IncomingCall?.canUseFullScreenIntent() ?? true;
    } catch {
      return true;
    }
  }

  private openFullScreenIntentSettings() {
    if (Platform.OS !== 'android') return;
    try {
      IncomingCall?.openFullScreenIntentSettings();
    } catch (err) {
      console.error('[CallKeep] Failed to open full-screen intent settings:', err);
    }
  }

  private isIgnoringBatteryOptimizations(): boolean {
    if (Platform.OS !== 'android') return true;
    try {
      return IncomingCall?.isIgnoringBatteryOptimizations() ?? true;
    } catch {
      return true;
    }
  }

  private requestIgnoreBatteryOptimizations() {
    if (Platform.OS !== 'android') return;
    try {
      IncomingCall?.requestIgnoreBatteryOptimizations();
    } catch (err) {
      console.error('[CallKeep] Failed to request battery optimization exemption:', err);
    }
  }

  /**
   * Nudges the user, once per app launch, toward the two OS settings that make incoming calls
   * reliable: the full-screen-intent lock-screen bypass (can be silently revoked on Android
   * 14+) and battery-optimization exemption (OEM background restrictions can otherwise kill
   * this app's process before a call push ever reaches it — see callkeep.ts's background
   * task). Both settings screens are fire-and-forget (no result callback), so this is a
   * best-effort nudge, not a guarantee.
   */
  promptForReliableCallsIfNeeded() {
    if (Platform.OS !== 'android' || this.reliabilityPromptShown) return;

    const needsFullScreen = !this.canUseFullScreenIntent();
    const needsBatteryExemption = !this.isIgnoringBatteryOptimizations();
    if (!needsFullScreen && !needsBatteryExemption) return;

    this.reliabilityPromptShown = true;
    Alert.alert(
      'Get Reliable Call Alerts',
      'To make sure you never miss a call, Crumbo needs a couple of permissions from your phone settings.',
      [
        { text: 'Not Now', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => {
            if (needsBatteryExemption) this.requestIgnoreBatteryOptimizations();
            // The full-screen-intent settings screen doesn't return a result we can await, so
            // stagger it after the battery dialog rather than layering two system UIs at once.
            if (needsFullScreen) {
              setTimeout(() => this.openFullScreenIntentSettings(), needsBatteryExemption ? 1500 : 0);
            }
          },
        },
      ]
    );
  }

  /**
   * Push-driven call signals never carry the receiver's local friendId (it's a per-device id,
   * not something the sender/server knows) — only sender_code, which every signal does carry.
   * Resolve it here from the friend list so callers (the notification-tap handler and the
   * background task) don't have to duplicate the lookup.
   */
  async resolveFriendId(friendId: string | undefined, senderCode: string | undefined): Promise<string | undefined> {
    if (friendId) return friendId;
    if (!senderCode) return undefined;
    try {
      const { StorageService } = require('./storage');
      const friends = await StorageService.getFriends();
      const friend = friends.find((f: any) => f.cookieCode === senderCode);
      return friend?.id;
    } catch (err) {
      console.error('[CallKeep] Failed to resolve friendId from sender code:', err);
      return undefined;
    }
  }

  private registerNotificationListeners() {
    Notifications.addNotificationResponseReceivedListener(async (response) => {
      const { actionIdentifier, notification } = response;
      const payload = getCallSignalPayload(notification);
      const { data } = getNotificationData(notification);

      const callUUID = data?.callUUID ?? payload?.callUUID;
      const isVideo = payload?.isVideo;
      const roomName = payload?.roomName;
      const friendId = data?.friendId;
      const friendName = payload?.friendName ?? payload?.callerName;
      const senderCode = data?.sender_code || data?.senderCode || data?.sender?.code || data?.sender?.sender_code;

      const resolvedFriendId = await this.resolveFriendId(friendId, senderCode);

      const isDefaultTap = actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER || actionIdentifier === 'default';

      if (actionIdentifier === 'answer') {
        if (callUUID) {
          RNCallKeep.answerIncomingCall(callUUID as string);
        }
        if (this.onAnswerCallback) {
          this.onAnswerCallback();
        } else if (resolvedFriendId) {
          const { router } = require('expo-router');
          router.push({
            pathname: `/chat/${resolvedFriendId}`,
            params: {
              incomingCall: 'true',
              acceptCallImmediately: 'true',
              callType: isVideo ? 'video' : 'audio',
              roomName,
              callUUID,
              friendName,
            },
          });
        }
      } else if (actionIdentifier === 'decline') {
        if (callUUID) {
          this.endCall(callUUID as string);
        }
        if (this.onRejectCallback) {
          this.onRejectCallback(true);
        } else if (resolvedFriendId) {
          // Background decline (app was not in a call screen): signal the caller and log it.
          const { StorageService } = require('./storage');
          const profile = await StorageService.getKidProfile();
          if (profile && senderCode) {
            await sendCallSignal({
              type: 'DECLINE_CALL',
              callUUID: (callUUID as string) || Math.random().toString(36).substring(2, 15),
              senderCode: profile.cookieCode,
              senderName: profile.name,
              receiverCode: senderCode,
              roomName,
              isVideo,
            });
          }
          const callLogText = isVideo ? '[CALL_LOG:MISSED_VIDEO]' : '[CALL_LOG:MISSED_AUDIO]';
          await StorageService.sendCallLogMessage(resolvedFriendId, callLogText);
        }
      } else if (isDefaultTap) {
        if (resolvedFriendId) {
          const { router } = require('expo-router');
          router.push({
            pathname: `/chat/${resolvedFriendId}`,
            params: {
              incomingCall: 'true',
              callType: isVideo ? 'video' : 'audio',
              roomName,
              callUUID,
              friendName,
            },
          });
        }
      }
    });
  }
}

export const callKeepManager = new CallKeepManager();

// TEMPORARY diagnostic: confirms this module (and therefore defineTask below) actually
// evaluates in whatever JS context is running, including a headless background bootstrap.
// Remove alongside the other CRUMBO_DIAG logging once the no-ring bug is found and fixed.
console.log('[CRUMBO_DIAG] callkeep.ts module evaluated, registering background task');

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  console.log('[CRUMBO_DIAG] background task INVOKED, data=', JSON.stringify(data), 'error=', error);

  if (error) {
    console.error('[CallKeep Background Task] error:', error);
    return;
  }

  // This task's payload arrives in one of two incompatible shapes depending on whether the
  // app process was still alive when the FCM push arrived (verified against expo-notifications'
  // Android source — FirebaseMessagingDelegate.kt / BackgroundRemoteNotificationTaskConsumer.kt):
  //  - process killed: the cold-start JobService path wraps a fully serialized Notification
  //    under `notification` (request.content.data holds our fields) — getCallSignalPayload
  //    below reads that.
  //  - process alive (backgrounded, not killed): FirebaseMessagingDelegate.onMessageReceived
  //    fires directly and forwards the raw RemoteMessage bundle instead — `notification` is
  //    always null there (this push is deliberately data-only, see notify-call/index.ts) and
  //    our fields are flat on `data` itself.
  // Without the `data` fallback, every backgrounded-but-not-killed receiver silently dropped
  // incoming call pushes (this was the root cause of the "no sound, no banner" reports).
  const raw = data as any;
  const notification = raw?.notification;
  const payload = notification ? getCallSignalPayload(notification) : parseCallSignalText(raw?.data);
  console.log('[CRUMBO_DIAG] background task parsed payload=', JSON.stringify(payload));
  if (!payload) return;

  if (notification) {
    await dismissNotificationIfCallSignal(notification);
  }

  if (payload.type === 'START_AUDIO_CALL' || payload.type === 'START_VIDEO_CALL') {
    const callUUID = payload.callUUID || Math.random().toString(36).substring(2, 15);
    const isVideo = !!payload.isVideo;
    // Push signals never carry friendId (it's a per-device id the sender/server don't know) —
    // resolve it from sender_code so the notification's deep link routes to the right chat.
    const resolvedFriendId = await callKeepManager.resolveFriendId(payload.friendId, payload.senderCode);

    // A parent's lock blocks the call before it ever rings, even when this device's JS process
    // was fully killed and only woken by this push — see bug #3 in BUGS.md. Reads the locally
    // cached profile since a live server round-trip isn't worth the latency/reliability risk in
    // a background push handler; use-call.ts's own foreground check (and the chat screens'
    // periodic re-sync) cover the case where that cache is stale.
    const profile = await StorageService.getKidProfile();
    const isLocked = profile && (isVideo ? profile.videoCallingDisabled : profile.callingDisabled);
    if (isLocked && payload.senderCode) {
      sendCallSignal({
        type: 'DECLINE_CALL',
        callUUID,
        senderCode: profile!.cookieCode,
        senderName: profile!.name,
        receiverCode: payload.senderCode,
        roomName: payload.roomName,
        isVideo,
      }).catch((e) => console.error('[CallKeep Background Task] Failed to auto-decline locked call:', e));
      if (resolvedFriendId) {
        const logText = isVideo ? `[CALL_LOG:MISSED_VIDEO:INCOMING:${callUUID}]` : `[CALL_LOG:MISSED_AUDIO:INCOMING:${callUUID}]`;
        StorageService.sendCallLogMessage(resolvedFriendId, logText).catch((e) =>
          console.error('[CallKeep Background Task] Failed to log locked call:', e)
        );
      }
      return;
    }

    await callKeepManager.displayIncomingCall(
      callUUID,
      payload.callerName ?? payload.friendName ?? 'Crumbo Friend',
      payload.callerName ?? payload.friendName ?? 'Crumbo Friend',
      resolvedFriendId,
      payload.roomName,
      payload.isVideo,
    );
    return;
  }

  if (payload.type === 'DECLINE_CALL' || payload.type === 'END_CALL' || payload.type === 'CANCEL_CALL') {
    try {
      const RNCallKeepLocal = require('react-native-callkeep').default;
      RNCallKeepLocal.endAllCalls();
    } catch (err) {
      console.error('[CallKeep Background Task] Failed to end all calls:', err);
    }
    // The CallStyle notification rings insistently until cancelled — when the caller hangs
    // up while this app is killed/backgrounded, this is what silences it.
    await Notifications.dismissAllNotificationsAsync().catch(() => {});
  }
});

if (Platform.OS === 'android') {
  Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK).catch(err => {
    console.error('[CallKeep] Failed to register background task:', err);
  });
}
