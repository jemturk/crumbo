import { agoraManager, fetchAgoraToken, hashCode } from '@/services/agora';
import { callKeepManager } from '@/services/callkeep';
import {
  CallSignalPayload,
  isStartSignal,
  sendCallSignal,
  subscribeToCallSignals,
} from '@/services/callSignaling';
import { Friend, KidProfile, Message, StorageService } from '@/services/storage';
import { Camera } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Vibration } from 'react-native';
import IncomingCall from '../../modules/incoming-call';

export type CallStatus = 'ringing' | 'connected' | 'ended';
export type CallDirection = 'incoming' | 'outgoing';

export interface IncomingCallParams {
  incomingCall?: string;
  callType?: string;
  roomName?: string;
  friendName?: string;
  acceptCallImmediately?: string;
  callUUID?: string;
  /** Set when the user tapped Decline on the native full-screen incoming-call notification. */
  declineCall?: string;
}

interface UseCallOptions {
  friendId: string;
  friend: Friend | null;
  profile: KidProfile | null;
  incomingParams: IncomingCallParams;
  clearIncomingParams: () => void;
  onCallLog: (msg: Message) => void;
  showAlert: (title: string, message: string) => void;
}

// How long an unanswered call rings before auto-ending (WhatsApp rings ~45-60s).
const RING_TIMEOUT_MS = 45000;

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Owns the entire call state machine + the Agora / CallKeep / sound / vibration
 * lifecycles for a 1:1 conversation. Signaling goes over the dedicated call_signals
 * channel (see src/services/callSignaling.ts); this hook never touches the chat table
 * except to append [CALL_LOG:*] history via onCallLog.
 */
export function useCall({
  friendId,
  friend,
  profile,
  incomingParams,
  clearIncomingParams,
  onCallLog,
  showAlert,
}: UseCallOptions) {
  const [callModalVisible, setCallModalVisible] = useState(false);
  const [callTypeVideo, setCallTypeVideo] = useState(false);
  const [callStatus, setCallStatus] = useState<CallStatus>('ringing');
  const [callDuration, setCallDuration] = useState(0);
  const [callDirection, setCallDirection] = useState<CallDirection>('outgoing');
  const [callRoom, setCallRoom] = useState<string>('');
  const [remoteUid, setRemoteUid] = useState<number | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [activeCallUuid, setActiveCallUuid] = useState<string | null>(null);

  const isMounted = useRef(true);
  const callStatusRef = useRef<CallStatus>('ringing');
  const callDirectionRef = useRef<CallDirection>('outgoing');
  const callRoomRef = useRef<string>('');
  const activeCallUuidRef = useRef<string | null>(null);
  const handledStartUuids = useRef<Set<string>>(new Set());
  const handleEndCallRef = useRef<(() => Promise<void>) | null>(null);
  const handleDeclineCallRef = useRef<(() => Promise<void>) | null>(null);
  const handleMissCallRef = useRef<(() => Promise<void>) | null>(null);
  // True when the native CallStyle notification owns the ring for the current incoming call
  // (its channel plays a looping ringtone). In that case the in-app ringtone/vibration must
  // stay silent or the user hears two ringers at once.
  const ringHandledByNotification = useRef(false);

  useEffect(() => {
    callStatusRef.current = callStatus;
  }, [callStatus]);
  useEffect(() => {
    callDirectionRef.current = callDirection;
  }, [callDirection]);
  useEffect(() => {
    callRoomRef.current = callRoom;
  }, [callRoom]);
  useEffect(() => {
    activeCallUuidRef.current = activeCallUuid;
  }, [activeCallUuid]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // --- Agora media -----------------------------------------------------------
  const startAgoraCall = useCallback(
    async (channelName: string, isVideo: boolean, isIncoming: boolean) => {
      if (!profile) return;

      if (isVideo) {
        const cameraStatus = await Camera.requestCameraPermissionsAsync();
        if (!cameraStatus.granted) {
          showAlert('Permission Required', 'Camera permission is required for video calls.');
          return;
        }
      }
      const micStatus = await Camera.requestMicrophonePermissionsAsync();
      if (!micStatus.granted) {
        showAlert('Permission Required', 'Microphone permission is required for voice calls.');
        return;
      }

      const appID = process.env.EXPO_PUBLIC_AGORA_APP_ID || '';
      if (!appID) {
        console.warn('Agora APP ID is missing. Voice/video streaming will not work.');
      }

      try {
        await agoraManager.init(
          appID,
          (uid) => {
            setRemoteUid(uid);
            setCallStatus('connected');
          },
          () => {
            setRemoteUid(null);
            handleEndCallRef.current?.();
          },
          (err) => {
            console.error('Agora engine error:', err);
          }
        );

        const localUid = hashCode(profile.cookieCode);
        let token = '';
        try {
          token = await fetchAgoraToken(channelName, localUid);
        } catch (tokenErr) {
          console.warn(
            '[Agora] Failed to fetch token, falling back to tokenless join. If your Agora project requires tokens, this call will fail.',
            tokenErr
          );
        }
        await agoraManager.join(token, channelName, localUid, isVideo);

        setIsMuted(false);
        setIsVideoMuted(false);

        if (!isIncoming) {
          setCallStatus('ringing');
        } else {
          setCallStatus('connected');
        }
      } catch (e) {
        console.error('Failed to start Agora call:', e);
        showAlert('Call Error', 'Could not establish connection.');
        handleEndCallRef.current?.();
      }
    },
    [profile, showAlert]
  );

  // --- Call log helper -------------------------------------------------------
  const writeCallLog = useCallback(
    async (text: string) => {
      try {
        const logMsg = await StorageService.sendCallLogMessage(friendId, text);
        if (isMounted.current) onCallLog(logMsg);
      } catch (e) {
        console.error('Failed to save call log:', e);
      }
    },
    [friendId, onCallLog]
  );

  // --- Outgoing --------------------------------------------------------------
  const startCall = useCallback(
    async (isVideo: boolean) => {
      if (!profile || !friend) return;

      const roomName = `CrumboCall_${profile.cookieCode}_${friend.cookieCode}`.replace(/-/g, '_');
      const uuid = generateUUID();

      setCallRoom(roomName);
      setCallTypeVideo(isVideo);
      setCallDirection('outgoing');
      setCallStatus('ringing');
      setCallModalVisible(true);
      setActiveCallUuid(uuid);

      callKeepManager.startCall(uuid, friend.name, friend.name);

      await sendCallSignal({
        type: isVideo ? 'START_VIDEO_CALL' : 'START_AUDIO_CALL',
        callUUID: uuid,
        senderCode: profile.cookieCode,
        senderName: profile.name,
        receiverCode: friend.cookieCode,
        roomName,
        isVideo,
      });

      await startAgoraCall(roomName, isVideo, false);
    },
    [profile, friend, startAgoraCall]
  );

  // --- Accept ----------------------------------------------------------------
  const acceptCall = useCallback(async () => {
    Vibration.cancel();
    setCallStatus('connected');
    const uuid = activeCallUuidRef.current;
    if (uuid) callKeepManager.answerCall(uuid);

    if (profile && friend) {
      await sendCallSignal({
        type: 'ACCEPT_CALL',
        callUUID: uuid || generateUUID(),
        senderCode: profile.cookieCode,
        senderName: profile.name,
        receiverCode: friend.cookieCode,
        roomName: callRoomRef.current,
        isVideo: callTypeVideo,
      });
    }

    if (callRoomRef.current) {
      await startAgoraCall(callRoomRef.current, callTypeVideo, true);
    }
  }, [profile, friend, callTypeVideo, startAgoraCall]);

  // --- Teardown (shared by decline / end / miss) ------------------------------
  const teardown = useCallback(
    async (signalType: 'DECLINE_CALL' | 'END_CALL' | 'CANCEL_CALL', logText: string) => {
      Vibration.cancel();
      const uuid = activeCallUuidRef.current;
      if (isMounted.current) setCallStatus('ended');
      if (uuid) {
        callKeepManager.endCall(uuid);
        if (isMounted.current) setActiveCallUuid(null);
      }
      await agoraManager.destroy();
      if (isMounted.current) setRemoteUid(null);

      if (profile && friend) {
        await sendCallSignal({
          type: signalType,
          callUUID: uuid || generateUUID(),
          senderCode: profile.cookieCode,
          senderName: profile.name,
          receiverCode: friend.cookieCode,
          roomName: callRoomRef.current,
          isVideo: callTypeVideo,
        });
      }

      await writeCallLog(logText);
    },
    [profile, friend, callTypeVideo, writeCallLog]
  );

  const declineCall = useCallback(async () => {
    const logText = callTypeVideo ? '[CALL_LOG:MISSED_VIDEO]' : '[CALL_LOG:MISSED_AUDIO]';
    await teardown('DECLINE_CALL', logText);
    if (isMounted.current) setCallModalVisible(false);
  }, [callTypeVideo, teardown]);

  // An incoming call that timed out unanswered (see the ring-timeout effect below). Sends
  // CANCEL_CALL rather than DECLINE_CALL so the caller sees a silent "no answer" end instead
  // of the "Call Busy" alert reserved for an active decline — matching WhatsApp's behavior.
  const missCall = useCallback(async () => {
    const logText = callTypeVideo ? '[CALL_LOG:MISSED_VIDEO]' : '[CALL_LOG:MISSED_AUDIO]';
    await teardown('CANCEL_CALL', logText);
    if (isMounted.current) setCallModalVisible(false);
  }, [callTypeVideo, teardown]);

  const endCall = useCallback(async () => {
    const wasRinging = callStatusRef.current === 'ringing';
    const logText = wasRinging
      ? callTypeVideo
        ? '[CALL_LOG:MISSED_VIDEO]'
        : '[CALL_LOG:MISSED_AUDIO]'
      : callTypeVideo
      ? '[CALL_LOG:ENDED_VIDEO]'
      : '[CALL_LOG:ENDED_AUDIO]';
    await teardown('END_CALL', logText);
    if (isMounted.current) {
      setTimeout(() => {
        if (isMounted.current) setCallModalVisible(false);
      }, 500);
    }
  }, [callTypeVideo, teardown]);

  handleDeclineCallRef.current = declineCall;
  handleEndCallRef.current = endCall;
  handleMissCallRef.current = missCall;

  // --- Inbound signal handling ----------------------------------------------
  const handleSignal = useCallback(
    (payload: CallSignalPayload) => {
      if (isStartSignal(payload.type)) {
        const uuid = payload.callUUID || generateUUID();
        if (handledStartUuids.current.has(uuid)) return; // realtime + push dedup
        handledStartUuids.current.add(uuid);

        const isVideo = payload.type === 'START_VIDEO_CALL';
        setActiveCallUuid(uuid);
        setCallTypeVideo(isVideo);
        setCallDirection('incoming');
        setCallStatus('ringing');
        setCallRoom(payload.roomName || '');
        setCallModalVisible(true);

        // Foregrounded: this modal + vibration only. Backgrounded: displayIncomingCall
        // below leads to the native CallStyle notification, whose channel rings with the
        // device's default ringtone.
        ringHandledByNotification.current = AppState.currentState !== 'active';

        const callerName = payload.callerName || friend?.name || 'Friend';
        callKeepManager.displayIncomingCall(uuid, callerName, callerName, friendId, payload.roomName || '', isVideo);
        if (!ringHandledByNotification.current) {
          Vibration.vibrate([1000, 1000], true);
        }
        return;
      }

      if (payload.type === 'ACCEPT_CALL') {
        Vibration.cancel();
        setCallStatus('connected');
        return;
      }

      if (payload.type === 'DECLINE_CALL' || payload.type === 'CANCEL_CALL') {
        Vibration.cancel();
        setCallStatus('ended');
        const uuid = activeCallUuidRef.current;
        if (uuid) {
          callKeepManager.endCall(uuid);
          setActiveCallUuid(null);
        }
        if (payload.type === 'DECLINE_CALL') {
          showAlert('Call Busy', `${friend?.name || 'Friend'} is busy right now.`);
        }
        agoraManager.destroy();
        setRemoteUid(null);
        setTimeout(() => {
          if (isMounted.current) setCallModalVisible(false);
        }, 1500);
        return;
      }

      if (payload.type === 'END_CALL') {
        Vibration.cancel();
        setCallStatus('ended');
        const uuid = activeCallUuidRef.current;
        if (uuid) {
          callKeepManager.endCall(uuid);
          setActiveCallUuid(null);
        }
        agoraManager.destroy();
        setRemoteUid(null);
        setTimeout(() => {
          if (isMounted.current) setCallModalVisible(false);
        }, 1500);
        return;
      }
    },
    [friend, friendId, showAlert]
  );

  // Subscribe to call signals for this conversation.
  useEffect(() => {
    if (!profile) return;
    const unsubscribe = subscribeToCallSignals(profile.cookieCode, (payload, signalFriendId) => {
      if (signalFriendId === friendId) handleSignal(payload);
    });
    return () => unsubscribe();
  }, [profile, friendId, handleSignal]);

  // --- Incoming call route params (deep link / push answer) ------------------
  const initialParamsHandled = useRef(false);
  useEffect(() => {
    initialParamsHandled.current = false;
  }, [friendId]);

  useEffect(() => {
    const handleIncomingParams = async () => {
      if (incomingParams.incomingCall !== 'true' || initialParamsHandled.current) return;
      if (incomingParams.declineCall === 'true') return; // handled by the dedicated effect below
      initialParamsHandled.current = true;

      const { callType, roomName, friendName, acceptCallImmediately, callUUID } = incomingParams;
      clearIncomingParams();

      const isVideo = callType === 'video';
      const uuid = callUUID || generateUUID();
      if (callUUID) handledStartUuids.current.add(callUUID);

      // If the CallStyle notification for this call is still displayed (we arrived here from
      // its tap / full-screen intent), it is the one ringing — keep the in-app ringer silent.
      ringHandledByNotification.current = !!callUUID && callKeepManager.isCallNotificationShowing(callUUID);

      setCallTypeVideo(isVideo);
      setCallDirection('incoming');
      setCallRoom(roomName || '');
      setActiveCallUuid(uuid);

      // If the native CallKeep UI hasn't already been shown (no callUUID from push), show it.
      if (!callUUID) {
        const displayName = friendName || friend?.name || 'Crumbo Friend';
        callKeepManager.displayIncomingCall(uuid, displayName, displayName, friendId, roomName || '', isVideo);
      }

      if (acceptCallImmediately === 'true') {
        setCallStatus('connected');
        setCallModalVisible(true);
        // Tell Telecom the call is answered and dismiss the CallStyle notification —
        // it rings insistently until explicitly cancelled.
        callKeepManager.answerCall(uuid);
        if (profile && friend) {
          await sendCallSignal({
            type: 'ACCEPT_CALL',
            callUUID: uuid,
            senderCode: profile.cookieCode,
            senderName: profile.name,
            receiverCode: friend.cookieCode,
            roomName: roomName || '',
            isVideo,
          });
        }
        await startAgoraCall(roomName || '', isVideo, true);
      } else {
        setCallStatus('ringing');
        setCallModalVisible(true);
        if (!ringHandledByNotification.current) {
          Vibration.vibrate([1000, 1000], true);
        }
      }
    };

    handleIncomingParams().catch((err) => {
      console.error('[useCall] Failed to handle incoming call params:', err);
    });
  }, [incomingParams, friend, profile, friendId, clearIncomingParams, startAgoraCall]);

  // --- Quick decline from the native full-screen notification's Decline action -----
  // A cold start races loadChat()'s async profile/friend fetch, so — unlike the accept
  // path above — this waits for both before sending, rather than firing (and silently
  // dropping the signal) on the very first render.
  const declineParamHandled = useRef(false);
  useEffect(() => {
    if (incomingParams.declineCall !== 'true' || declineParamHandled.current) return;
    if (!profile || !friend) return;
    declineParamHandled.current = true;

    const isVideo = incomingParams.callType === 'video';
    // Mark this call resolved so a START signal arriving after the fact (e.g. redelivered when
    // the realtime socket reconnects on foreground) can't re-open the ringing modal — mirrors
    // the accept path above.
    if (incomingParams.callUUID) handledStartUuids.current.add(incomingParams.callUUID);
    // Silence the (insistently ringing) CallStyle notification and clean up Telecom state.
    if (incomingParams.callUUID) {
      callKeepManager.endCall(incomingParams.callUUID);
    }
    clearIncomingParams();

    (async () => {
      await sendCallSignal({
        type: 'DECLINE_CALL',
        callUUID: incomingParams.callUUID || generateUUID(),
        senderCode: profile.cookieCode,
        senderName: profile.name,
        receiverCode: friend.cookieCode,
        roomName: incomingParams.roomName,
        isVideo,
      });
      await writeCallLog(isVideo ? '[CALL_LOG:MISSED_VIDEO]' : '[CALL_LOG:MISSED_AUDIO]');
    })().catch((err) => {
      console.error('[useCall] Failed to process quick decline:', err);
    });
  }, [incomingParams, profile, friend, clearIncomingParams, writeCallLog]);

  // --- CallKeep native UI callbacks ------------------------------------------
  useEffect(() => {
    callKeepManager.registerCallbacks(
      () => acceptCall(),
      (isUserInitiated) => {
        if (callStatusRef.current === 'ringing') {
          if (callDirectionRef.current === 'incoming') {
            if (isUserInitiated) {
              declineCall();
            } else {
              console.log('[useCall] Ignoring system-initiated reject during ringing to keep modal open.');
            }
          } else {
            endCall();
          }
        } else if (callStatusRef.current === 'connected') {
          endCall();
        }
      }
    );
    return () => callKeepManager.clearCallbacks();
  }, [acceptCall, declineCall, endCall]);

  // --- Direct answer/decline from the notification (see IncomingCallActionReceiver.kt) -----
  // Fired natively the instant Answer/Decline is tapped, independent of whether the deep-link
  // query params (acceptCallImmediately/declineCall, handled below) actually make it through —
  // this is the primary path now; that remains only as a fallback for a very cold start.
  // Matching on friendId (not just callUUID) guards against a previous chat screen still
  // mounted in the navigation stack also reacting to the same event.
  useEffect(() => {
    if (!IncomingCall) return;

    const answerSub = IncomingCall.addListener('onAnswerFromNotification', (event) => {
      if (event.friendId !== friendId) return;
      acceptCall();
    });
    const declineSub = IncomingCall.addListener('onDeclineFromNotification', (event) => {
      if (event.friendId !== friendId) return;
      declineCall();
    });

    return () => {
      answerSub.remove();
      declineSub.remove();
    };
  }, [friendId, acceptCall, declineCall]);

  // --- Duration timer --------------------------------------------------------
  useEffect(() => {
    let timer: any;
    if (callStatus === 'connected') {
      timer = setInterval(() => setCallDuration((prev) => prev + 1), 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(timer);
  }, [callStatus]);

  // Reset the notification-ring flag once the ring phase ends, so the next incoming call
  // determines vibration behavior fresh.
  useEffect(() => {
    if (!(callStatus === 'ringing' && callDirection === 'incoming')) {
      ringHandledByNotification.current = false;
    }
  }, [callStatus, callDirection]);

  // --- Ring timeout: auto-end an unanswered call after RING_TIMEOUT_MS -------
  // Without this a call rings forever until someone manually hangs up. Matches WhatsApp:
  // the caller auto-cancels (and both sides log a missed call), the callee auto-misses.
  useEffect(() => {
    if (callStatus !== 'ringing') return;
    const timer = setTimeout(() => {
      if (!isMounted.current || callStatusRef.current !== 'ringing') return;
      if (callDirectionRef.current === 'outgoing') {
        handleEndCallRef.current?.();
      } else {
        handleMissCallRef.current?.();
      }
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [callStatus]);

  // --- Unmount: end an in-flight call ---------------------------------------
  useEffect(() => {
    return () => {
      if (callStatusRef.current === 'ringing' || callStatusRef.current === 'connected') {
        if (callStatusRef.current === 'ringing' && callDirectionRef.current === 'incoming') {
          handleDeclineCallRef.current?.();
        } else {
          handleEndCallRef.current?.();
        }
      }
      Vibration.cancel();
      agoraManager.destroy();
    };
  }, []);

  // --- Media controls --------------------------------------------------------
  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      agoraManager.muteAudio(next);
      return next;
    });
  }, []);

  const switchCamera = useCallback(() => {
    agoraManager.switchCamera();
  }, []);

  const toggleSpeakerMock = useCallback(() => {
    setIsVideoMuted((prev) => !prev);
  }, []);

  const formatDuration = useCallback((seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }, []);

  return {
    callModalVisible,
    callTypeVideo,
    callStatus,
    callDuration,
    callDirection,
    remoteUid,
    isMuted,
    isVideoMuted,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMute,
    switchCamera,
    toggleSpeakerMock,
    formatDuration,
  };
}
