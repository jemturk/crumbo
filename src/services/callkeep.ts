import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Alert, AppState, Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';
import IncomingCall, { ChatMode } from '../../modules/incoming-call';
import { CallSignalPayload, parseCallSignalText, sendCallSignal } from './callSignaling';
import { KidProfile, StorageService } from './storage';

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
  chatMode: ChatMode;
}

type ActiveIdentity =
  | { mode: 'kid'; profile: KidProfile }
  | { mode: 'adult'; myCode: string }
  | { mode: 'none' };

/**
 * Which identity (kid or parent) is active on this device — mirrors _layout.tsx's own
 * kid-vs-parent check. The background task and the notification-response listener both need
 * this: a kid's contacts are resolved via the local Friend list (see resolveFriendId below), but
 * a parent's are addressed directly by raw cookie code, with a different route
 * (/parent/chat/[code] vs /chat/[friendId]) and message-logging call (sendParentMessage vs
 * sendCallLogMessage) on top.
 */
async function resolveActiveIdentity(): Promise<ActiveIdentity> {
  const profile = await StorageService.getKidProfile();
  if (profile) return { mode: 'kid', profile };
  const parentActive = await StorageService.isParentActiveOnDevice();
  if (parentActive) {
    const myCode = await StorageService.getMyParentCode();
    if (myCode) return { mode: 'adult', myCode };
  }
  return { mode: 'none' };
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

/**
 * Shared by notifyMissedCallForeground below and the background task's own missed-call branch
 * (the caller-hangs-up-before-45s-timeout case) — `targetId` is a kid friendId or an adult's
 * raw cookie code (same duality as chatMode everywhere else).
 */
async function postMissedCallNotification(callerName: string, isVideo: boolean, chatMode: ChatMode, targetId: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: isVideo ? 'Missed video call' : 'Missed voice call',
        body: callerName,
        data: { kind: 'missed_call', chatMode, targetId },
      },
      trigger: null,
    });
  } catch (e) {
    console.error('[CallKeep] Failed to post missed-call notification:', e);
  }
}

/**
 * Foreground-only counterpart to the native missed-call notification posted directly by
 * IncomingCallActionReceiver.kt's ring-timeout branch. That native path only ever runs when
 * showIncomingCallUi skipped posting the ringing notification because the app was NOT active —
 * i.e. it never fires while foregrounded — so this is the one case it can't cover, and the two
 * can never double-post for the same missed call.
 */
export async function notifyMissedCallForeground(callerName: string, isVideo: boolean, chatMode: ChatMode, targetId: string): Promise<void> {
  if (AppState.currentState !== 'active') return;
  await postMissedCallNotification(callerName, isVideo, chatMode, targetId);
}

/**
 * Writes the [CALL_LOG:MISSED_*:INCOMING:...] entry and posts a missed-call notification for a
 * call that arrived and was still ringing (native notification not yet answered/declined) when
 * a terminal signal (typically END_CALL — a caller hanging up their own still-ringing outgoing
 * call sends plain END_CALL, same as ending a connected one) arrived for it. Only called once
 * IncomingCall.isShowing(callUUID) has confirmed this device never resolved the call itself —
 * that check also means this is naturally never reached on the caller's own device (that native
 * notification only ever exists for an incoming call).
 */
async function logMissedIncomingCall(payload: CallSignalPayload): Promise<void> {
  if (!payload.callUUID) return;
  const identity = await resolveActiveIdentity();
  if (identity.mode === 'none') return;

  const targetId = identity.mode === 'kid'
    ? await callKeepManager.resolveFriendId(payload.friendId, payload.senderCode)
    : payload.senderCode;
  if (!targetId) return;

  const isVideo = !!payload.isVideo;
  const callerName = payload.callerName ?? payload.friendName ?? 'Crumbo Friend';
  const logText = isVideo ? `[CALL_LOG:MISSED_VIDEO:INCOMING:${payload.callUUID}]` : `[CALL_LOG:MISSED_AUDIO:INCOMING:${payload.callUUID}]`;

  if (identity.mode === 'kid') {
    await StorageService.sendCallLogMessage(targetId, logText);
  } else {
    await StorageService.sendParentMessage(identity.myCode, targetId, logText);
  }
  await postMissedCallNotification(callerName, isVideo, identity.mode, targetId);
}

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
    isVideo?: boolean,
    chatMode: ChatMode = 'kid'
  ) {
    if (Platform.OS !== 'android') return;
    await this.setup();

    // Self-managed mode's displayIncomingCall doesn't show anything on its own — it just
    // registers the call with Telecom and fires `showIncomingCallUi`, which we handle
    // below by presenting our own notification. Stash the details that event won't carry.
    this.pendingCallInfo.set(uuid, { friendId, roomName, isVideo: !!isVideo, callerName: name, chatMode });

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
          chatMode: info?.chatMode || 'kid',
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
   * Logs the two OS permission states that decide whether an incoming call actually takes over
   * the screen or just silently rings/vibrates in the background: full-screen-intent (gates
   * IncomingCallModule's setFullScreenIntent — see its own comment) and battery-optimization
   * exemption (OEM background restrictions can kill this app's process before the push ever
   * arrives). Called right before displayIncomingCall so a logcat pull on a device that reported
   * "just vibrated" can be matched against the actual permission state at that moment, instead of
   * guessing from whatever the settings screens show *now*.
   */
  logCallReliabilityDiagnostics(callUUID: string) {
    if (Platform.OS !== 'android') return;
    console.log(
      `[CallKeep] Reliability check for ${callUUID} — fullScreenIntent: ${this.canUseFullScreenIntent()}, batteryOptimizationExempt: ${this.isIgnoringBatteryOptimizations()}`
    );
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
      const { data } = getNotificationData(notification);
      const isDefaultTap = actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER || actionIdentifier === 'default';

      // A tap on the (separate, non-ringing) missed-call notification — see
      // use-call.ts's missCall() foreground path, which is the only thing that ever posts one
      // through expo-notifications (the killed/backgrounded path posts it natively in Kotlin,
      // bypassing this listener entirely). Distinct payload shape from a call signal, checked
      // first so it can't fall through into the call-response handling below.
      if (isDefaultTap && data?.kind === 'missed_call') {
        const { router } = require('expo-router');
        const path = data.chatMode === 'adult'
          ? `/parent/chat/${encodeURIComponent(data.targetId as string)}`
          : `/chat/${data.targetId}`;
        router.push({ pathname: path });
        return;
      }

      // A tap on a regular chat message push — see send_push_notification()'s `data` field
      // (supabase/migrations/20260805000001_add_chat_message_push_routing.sql). Without this,
      // tapping the notification just launched the app to whatever screen it last had open,
      // since there was nothing here to route on. senderCode is the OTHER party's cookie code
      // regardless of which side received the push, same duality as chatMode everywhere else.
      if (isDefaultTap && data?.kind === 'chat_message' && data?.senderCode) {
        const { router } = require('expo-router');
        const identity = await resolveActiveIdentity();
        if (identity.mode === 'adult') {
          router.push({ pathname: `/parent/chat/${encodeURIComponent(data.senderCode as string)}` });
        } else if (identity.mode === 'kid') {
          const friendId = await this.resolveFriendId(undefined, data.senderCode as string);
          if (friendId) router.push({ pathname: `/chat/${friendId}` });
        }
        return;
      }

      const payload = getCallSignalPayload(notification);
      const callUUID = data?.callUUID ?? payload?.callUUID;
      const isVideo = payload?.isVideo;
      const roomName = payload?.roomName;
      const friendId = data?.friendId;
      const friendName = payload?.friendName ?? payload?.callerName;
      const senderCode = data?.sender_code || data?.senderCode || data?.sender?.code || data?.sender?.sender_code;

      const identity = await resolveActiveIdentity();
      const targetId = identity.mode === 'kid' ? await this.resolveFriendId(friendId, senderCode) : senderCode;
      const routePath = (id: string) =>
        identity.mode === 'adult' ? `/parent/chat/${encodeURIComponent(id)}` : `/chat/${id}`;

      if (actionIdentifier === 'answer') {
        if (callUUID) {
          RNCallKeep.answerIncomingCall(callUUID as string);
        }
        if (this.onAnswerCallback) {
          this.onAnswerCallback();
        } else if (targetId) {
          const { router } = require('expo-router');
          router.push({
            pathname: routePath(targetId),
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
        } else if (targetId && senderCode) {
          // Background decline (app was not in a call screen): signal the caller and log it.
          const callLogText = isVideo ? '[CALL_LOG:MISSED_VIDEO]' : '[CALL_LOG:MISSED_AUDIO]';
          const declineUUID = (callUUID as string) || Math.random().toString(36).substring(2, 15);
          if (identity.mode === 'kid') {
            await sendCallSignal({
              type: 'DECLINE_CALL',
              callUUID: declineUUID,
              senderCode: identity.profile.cookieCode,
              senderName: identity.profile.name,
              receiverCode: senderCode,
              roomName,
              isVideo,
            });
            await StorageService.sendCallLogMessage(targetId, callLogText);
          } else if (identity.mode === 'adult') {
            const myCode = identity.myCode;
            const myName = (await StorageService.getParentName()) || myCode.replace('PARENT:', '');
            await sendCallSignal({
              type: 'DECLINE_CALL',
              callUUID: declineUUID,
              senderCode: myCode,
              senderName: myName,
              receiverCode: senderCode,
              roomName,
              isVideo,
            });
            await StorageService.sendParentMessage(myCode, senderCode, callLogText);
          }
        }
      } else if (isDefaultTap) {
        if (targetId) {
          const { router } = require('expo-router');
          router.push({
            pathname: routePath(targetId),
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

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
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
  if (!payload) return;

  if (notification) {
    await dismissNotificationIfCallSignal(notification);
  }

  if (payload.type === 'START_AUDIO_CALL' || payload.type === 'START_VIDEO_CALL') {
    const callUUID = payload.callUUID || Math.random().toString(36).substring(2, 15);
    const isVideo = !!payload.isVideo;

    const identity = await resolveActiveIdentity();
    if (identity.mode === 'none') return; // nobody active on this device — nothing to ring for

    // Push signals never carry a local friendId (it's a per-device id the sender/server don't
    // know) — a kid resolves it from sender_code via the local Friend list; a parent addresses
    // contacts directly by raw cookie code, same as subscribeToParentCallSignals.
    const targetId = identity.mode === 'kid'
      ? await callKeepManager.resolveFriendId(payload.friendId, payload.senderCode)
      : payload.senderCode;

    // A parent's lock blocks the call before it ever rings, even when this device's JS process
    // was fully killed and only woken by this push — see bug #3 in BUGS.md. Reads the locally
    // cached profile since a live server round-trip isn't worth the latency/reliability risk in
    // a background push handler; use-call.ts's own foreground check (and the chat screens'
    // periodic re-sync) cover the case where that cache is stale. Adults are never locked, so
    // this whole branch is naturally skipped in adult mode.
    const isLocked = identity.mode === 'kid' && (isVideo ? identity.profile.videoCallingDisabled : identity.profile.callingDisabled);
    if (isLocked && payload.senderCode) {
      const profile = (identity as { mode: 'kid'; profile: KidProfile }).profile;
      sendCallSignal({
        type: 'DECLINE_CALL',
        callUUID,
        senderCode: profile.cookieCode,
        senderName: profile.name,
        receiverCode: payload.senderCode,
        roomName: payload.roomName,
        isVideo,
      }).catch((e) => console.error('[CallKeep Background Task] Failed to auto-decline locked call:', e));
      if (targetId) {
        const logText = isVideo ? `[CALL_LOG:MISSED_VIDEO:INCOMING:${callUUID}]` : `[CALL_LOG:MISSED_AUDIO:INCOMING:${callUUID}]`;
        StorageService.sendCallLogMessage(targetId, logText).catch((e) =>
          console.error('[CallKeep Background Task] Failed to log locked call:', e)
        );
      }
      return;
    }

    callKeepManager.logCallReliabilityDiagnostics(callUUID);
    await callKeepManager.displayIncomingCall(
      callUUID,
      payload.callerName ?? payload.friendName ?? 'Crumbo Friend',
      payload.callerName ?? payload.friendName ?? 'Crumbo Friend',
      targetId,
      payload.roomName,
      payload.isVideo,
      identity.mode,
    );
    return;
  }

  if (payload.type === 'DECLINE_CALL' || payload.type === 'END_CALL' || payload.type === 'CANCEL_CALL') {
    // Must run BEFORE the dismiss below (which cancels this same notification, so isShowing
    // would already read false afterward) — see logMissedIncomingCall's own doc for why this
    // check is what scopes it to a genuine missed call.
    if (payload.callUUID && IncomingCall?.isShowing(payload.callUUID)) {
      await logMissedIncomingCall(payload).catch((e) =>
        console.error('[CallKeep Background Task] Failed to log/notify missed call:', e)
      );
    }

    try {
      const RNCallKeepLocal = require('react-native-callkeep').default;
      RNCallKeepLocal.endAllCalls();
    } catch (err) {
      console.error('[CallKeep Background Task] Failed to end all calls:', err);
    }
    // dismissAllNotificationsAsync() alone does NOT silence the still-ringing CallStyle
    // notification — same NotificationManager.cancelAll()-skips-ongoing-notifications issue
    // documented on CallKeepManager.endCall(), which targets IncomingCall.dismiss(uuid)
    // instead. Without it here too, a caller cancelling early while this app is
    // backgrounded/killed kept ringing for the full 45s AlarmManager backstop regardless —
    // this stops it immediately, and (via IncomingCallModule.dismiss's own
    // cancelRingTimeout call) cancels that backstop so it can't also post a late/duplicate
    // missed-call notification for a call that was actually just cancelled.
    if (payload.callUUID) {
      try {
        IncomingCall?.dismiss(payload.callUUID);
      } catch (err) {
        console.error('[CallKeep Background Task] Failed to dismiss native call notification:', err);
      }
    }
    await Notifications.dismissAllNotificationsAsync().catch(() => {});
  }
});

if (Platform.OS === 'android') {
  Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK).catch(err => {
    console.error('[CallKeep] Failed to register background task:', err);
  });
}
