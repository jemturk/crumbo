import { AlertButton } from '@/components/CustomAlertModal';
import { subscribeToParentCallSignals } from '@/services/callSignaling';
import { Friend, KidProfile, Message, StorageService } from '@/services/storage';
import { CallerIdentity, CallParty, IncomingCallParams, useCall } from '@/hooks/use-call';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ConversationMode = 'kid' | 'adult';

export interface ConversationOtherParty {
  cookieCode: string;
  name: string;
  avatarEmoji?: string;
  avatarUrl?: string;
  isAdult: boolean;
}

export interface ConversationLocks {
  chatDisabled: boolean;
  callingDisabled: boolean;
  videoCallingDisabled: boolean;
  photosDisabled: boolean;
  drawingDisabled: boolean;
  voiceMessagesDisabled: boolean;
}

interface UseConversationParams extends IncomingCallParams {
  mode: ConversationMode;
  /** kid mode only — the local Friend id. */
  friendId?: string;
  /** adult mode only — the other party's raw PARENT:<email>/CRUM-xxx-xxx cookie code. */
  otherCode?: string;
  otherName?: string;
  otherAvatarEmoji?: string;
  otherAvatarUrl?: string;
  /** adult mode only — whether otherCode is one of MY OWN kids vs. a paired adult contact. */
  isOwnKid?: boolean;
  /** Set when navigated here from a quick-call button on a contact list — 'audio' | 'video'. */
  autoStartCall?: string;
}

// A kid staying on an open chat while a parent flips a lock elsewhere wouldn't otherwise see it
// take effect until navigating away and back (bug #3 in BUGS.md) — there's no realtime channel
// for profile/lock changes, so polling while this screen stays focused is the practical middle
// ground. Adults have no locks, so this only ever actually runs anything in kid mode.
const LOCK_REFRESH_INTERVAL_MS = 20000;

const NO_LOCKS: ConversationLocks = {
  chatDisabled: false,
  callingDisabled: false,
  videoCallingDisabled: false,
  photosDisabled: false,
  drawingDisabled: false,
  voiceMessagesDisabled: false,
};

// Shared data/lock/send layer for chat/[friendId].tsx and parent/chat/[code].tsx — the two
// screens differ in exactly two ways: a kid's conversation carries parental locks + a
// pending-pairing gate + a local cache/outbox (see storage.ts's outbox comment), and an adult's
// conversation is always unlocked/paired and lives entirely server-side. Everything else
// (rendering messages, calling, attachments) is identical, so ConversationView.tsx is driven
// entirely by this hook's output with no mode branching of its own.
export function useConversation(params: UseConversationParams) {
  const {
    mode, friendId, otherCode, otherName, otherAvatarEmoji, otherAvatarUrl, isOwnKid, autoStartCall,
    incomingCall, callType, roomName, friendName, acceptCallImmediately, callUUID, declineCall,
  } = params;
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);

  // Kid-only state
  const [friend, setFriend] = useState<Friend | null>(null);
  const friendRef = useRef<Friend | null>(null);
  useEffect(() => { friendRef.current = friend; }, [friend]);
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [locks, setLocks] = useState<ConversationLocks>(NO_LOCKS);
  const [pairingStatus, setPairingStatus] = useState<'paired' | 'pending'>('paired');

  // Adult-only state
  const [myCode, setMyCode] = useState<string | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  // The other party's name/avatar/isOwnKid as passed in via route params (from whichever screen
  // navigated here) are only a best-effort hint — the global incoming-call redirect in
  // _layout.tsx, for one, never has this on hand and passes none of it. Resolved here from the
  // server instead of trusted as-is, so the header is correct regardless of how this screen was
  // reached, and stays live if a kid's name/avatar changes mid-conversation.
  const [resolvedContact, setResolvedContact] = useState<{ name: string; avatarEmoji?: string; avatarUrl?: string; isOwnKid: boolean } | null>(null);

  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    message: string;
    buttons?: AlertButton[];
  }>({ visible: false, title: '', message: '' });
  const showAlert = useCallback((title: string, message: string, buttons?: AlertButton[]) => {
    setAlertConfig({ visible: true, title, message, buttons });
  }, []);
  const dismissAlert = useCallback(() => setAlertConfig(prev => ({ ...prev, visible: false })), []);

  const appendMessage = useCallback((msg: Message) => {
    setMessages(prev => (prev.find(m => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  // Wraps syncKidProfileAndFriends so a kid whose code no longer resolves to anyone (removed)
  // gets logged out from here too, not just from the contact list — this screen can be the one
  // left open when that happens.
  const syncOrHandleRemoval = useCallback(async (): Promise<KidProfile | null> => {
    try {
      return await StorageService.syncKidProfileAndFriends();
    } catch (e) {
      if (e instanceof Error && e.message === 'KID_NOT_FOUND') {
        await StorageService.logoutKid();
        router.replace('/');
        return null;
      }
      return null; // other failures (network etc.) — caller falls back to local cache
    }
  }, [router]);

  const applyKidLocks = (kidProf: KidProfile | null) => {
    setProfile(kidProf);
    if (kidProf) {
      setLocks({
        chatDisabled: !!kidProf.chatDisabled,
        callingDisabled: !!kidProf.callingDisabled,
        videoCallingDisabled: !!kidProf.videoCallingDisabled,
        photosDisabled: !!kidProf.photosDisabled,
        drawingDisabled: !!kidProf.drawingDisabled,
        voiceMessagesDisabled: !!kidProf.voiceMessagesDisabled,
      });
    }
  };

  const loadKid = useCallback(async () => {
    if (!friendId) return;
    try {
      setLoading(true);
      const friends = await StorageService.getFriends();
      const currentFriend = friends.find(f => f.id === friendId) || null;
      setFriend(currentFriend);

      // Synced from the parent's profile (not just the local cache) so a lock the parent just
      // flipped is picked up on this load — falls back to the local cache if the sync fails.
      const kidProf = (await syncOrHandleRemoval()) || (await StorageService.getKidProfile());
      applyKidLocks(kidProf);

      if (currentFriend) {
        const msgs = await StorageService.getMessages(currentFriend.id);
        setMessages(msgs);

        if (kidProf) {
          try {
            const result = await StorageService.checkFriendPairingStatus(kidProf.cookieCode, currentFriend.cookieCode);
            setPairingStatus(result.status);
            // Live avatar — comes along for free on the pairing check above.
            if (result.avatarEmoji && result.avatarEmoji !== currentFriend.avatarEmoji) {
              setFriend({ ...currentFriend, avatarEmoji: result.avatarEmoji });
              StorageService.updateFriendAvatar(currentFriend.id, result.avatarEmoji);
            }
          } catch (e) {
            // A failed check is not evidence the pairing was revoked — keep the last known status.
            console.error('Error checking pairing status', e);
          }
        }
      }
    } catch (e) {
      console.error('Error loading chat', e);
    } finally {
      setLoading(false);
    }
  }, [friendId, syncOrHandleRemoval]);

  // Lightweight sibling of loadKid for the periodic poll below — refreshes only locks/pairing
  // status, without setLoading(true)/reloading messages, so it doesn't blank the screen out from
  // under a kid mid-conversation every LOCK_REFRESH_INTERVAL_MS.
  const refreshKidLocksAndStatus = useCallback(async () => {
    if (!friendId) return;
    try {
      const kidProf = (await syncOrHandleRemoval()) || (await StorageService.getKidProfile());
      applyKidLocks(kidProf);

      const currentFriend = friendRef.current;
      if (kidProf && currentFriend) {
        try {
          const result = await StorageService.checkFriendPairingStatus(kidProf.cookieCode, currentFriend.cookieCode);
          setPairingStatus(result.status);
          if (result.avatarEmoji && result.avatarEmoji !== currentFriend.avatarEmoji) {
            setFriend({ ...currentFriend, avatarEmoji: result.avatarEmoji });
            StorageService.updateFriendAvatar(currentFriend.id, result.avatarEmoji);
          }
        } catch (e) {
          console.error('Error checking pairing status', e);
        }
      }
    } catch (e) {
      console.error('Error refreshing locks/status', e);
    }
  }, [friendId, syncOrHandleRemoval]);

  const loadAdult = useCallback(async () => {
    const code = await StorageService.getMyParentCode();
    if (!code || !otherCode) {
      router.replace('/');
      return;
    }
    setMyCode(code);
    setMyName(await StorageService.getParentName());
    setLoading(true);
    const [history, contacts] = await Promise.all([
      StorageService.getChatLogsForParent(code, otherCode),
      StorageService.getParentContacts(),
    ]);
    setMessages(history);
    const match = contacts.find(c => c.code === otherCode);
    if (match) {
      setResolvedContact({ name: match.name, avatarEmoji: match.avatarEmoji, avatarUrl: match.avatarUrl, isOwnKid: match.isOwnKid });
    }
    setLoading(false);
  }, [otherCode, router]);

  useFocusEffect(
    useCallback(() => {
      if (mode === 'kid') {
        loadKid();
        const interval = setInterval(refreshKidLocksAndStatus, LOCK_REFRESH_INTERVAL_MS);
        return () => clearInterval(interval);
      }
      loadAdult();
    }, [mode, loadKid, refreshKidLocksAndStatus, loadAdult])
  );

  // Realtime chat messages for this conversation (call signals travel elsewhere).
  useEffect(() => {
    if (mode === 'kid') {
      if (!friendId) return;
      const unsubscribe = StorageService.subscribeToMessages((newMsg, msgFriendId) => {
        if (msgFriendId !== friendId) return;
        appendMessage(newMsg);
      });
      return () => unsubscribe();
    }
    if (!myCode || !otherCode) return;
    const unsubscribe = StorageService.subscribeToParentMessages(myCode, (msg, fromOrToCode) => {
      if (fromOrToCode !== otherCode) return;
      appendMessage(msg);
    });
    return () => unsubscribe();
  }, [mode, friendId, myCode, otherCode, appendMessage]);

  const otherParty: ConversationOtherParty | null = useMemo(() => {
    if (mode === 'kid') {
      if (!friend) return null;
      return {
        cookieCode: friend.cookieCode,
        name: friend.name,
        avatarEmoji: friend.avatarEmoji,
        avatarUrl: friend.avatarUrl,
        isAdult: friend.cookieCode.startsWith('PARENT:'),
      };
    }
    if (!otherCode) return null;
    // resolvedContact (fetched from the server, see loadAdult) is the source of truth once it's
    // loaded — the route-param versions are only a best-effort hint used before that resolves,
    // and are all a killed-app incoming-call redirect ever has to go on.
    const name = resolvedContact?.name || otherName || otherCode;
    const isAdultOther = resolvedContact ? !resolvedContact.isOwnKid : !isOwnKid;
    const avatarEmoji = resolvedContact ? resolvedContact.avatarEmoji : otherAvatarEmoji;
    const avatarUrl = resolvedContact ? resolvedContact.avatarUrl : otherAvatarUrl;
    return {
      cookieCode: otherCode,
      name,
      avatarEmoji: isAdultOther ? avatarEmoji : (avatarEmoji || '🍪'),
      avatarUrl: isAdultOther ? avatarUrl : undefined,
      isAdult: isAdultOther,
    };
  }, [mode, friend, otherCode, otherName, otherAvatarEmoji, otherAvatarUrl, isOwnKid, resolvedContact]);

  // --- Sending ---------------------------------------------------------------

  const sendText = useCallback(async (text: string): Promise<Message | null> => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    if (mode === 'kid') {
      if (!friend) return null;
      const saved = await StorageService.sendMessage(friendId!, trimmed);
      appendMessage(saved);
      return saved;
    }
    if (!myCode || !otherCode) return null;
    const saved = await StorageService.sendParentMessage(myCode, otherCode, trimmed);
    appendMessage(saved);
    return saved;
  }, [mode, friend, friendId, myCode, otherCode, appendMessage]);

  const sendImage = useCallback(async (localUri: string): Promise<Message> => {
    const saved = mode === 'kid'
      ? await StorageService.sendImageMessage(friendId!, localUri)
      : await StorageService.sendParentImageMessage(myCode!, otherCode!, localUri);
    appendMessage(saved);
    return saved;
  }, [mode, friendId, myCode, otherCode, appendMessage]);

  const sendDrawing = useCallback(async (localUri: string): Promise<Message> => {
    const saved = mode === 'kid'
      ? await StorageService.sendDrawingMessage(friendId!, localUri)
      : await StorageService.sendParentDrawingMessage(myCode!, otherCode!, localUri);
    appendMessage(saved);
    return saved;
  }, [mode, friendId, myCode, otherCode, appendMessage]);

  const sendVoice = useCallback(async (localUri: string, durationSeconds: number): Promise<Message> => {
    const saved = mode === 'kid'
      ? await StorageService.sendVoiceMessage(friendId!, localUri, durationSeconds)
      : await StorageService.sendParentVoiceMessage(myCode!, otherCode!, localUri, durationSeconds);
    appendMessage(saved);
    return saved;
  }, [mode, friendId, myCode, otherCode, appendMessage]);

  // --- Calling -----------------------------------------------------------------

  const clearIncomingParams = useCallback(() => {
    router.setParams({
      incomingCall: undefined,
      callType: undefined,
      roomName: undefined,
      friendName: undefined,
      acceptCallImmediately: undefined,
      callUUID: undefined,
      declineCall: undefined,
    });
  }, [router]);

  const sendCallLog = useCallback((text: string): Promise<Message> => {
    if (mode === 'kid') return StorageService.sendCallLogMessage(friendId!, text);
    if (!myCode || !otherCode) return Promise.reject(new Error('Not signed in'));
    return StorageService.sendParentMessage(myCode, otherCode, text);
  }, [mode, friendId, myCode, otherCode]);

  // KidProfile/Friend already structurally satisfy CallerIdentity/CallParty — see use-call.ts.
  const callProfile: CallerIdentity | null = mode === 'kid'
    ? profile
    : (myCode ? { cookieCode: myCode, name: myName || myCode.replace('PARENT:', '') } : null);
  const callFriendParty: CallParty | null = mode === 'kid'
    ? friend
    // Reuse otherParty's resolution chain (resolvedContact -> route-param hints -> cookie code)
    // instead of only otherName, so an incoming-call redirect — which only ever has friendName,
    // never name (see _layout.tsx/callkeep.ts's notification handlers) — doesn't fall straight
    // through to the raw cookie code while resolvedContact is still loading.
    : (otherCode ? { cookieCode: otherCode, name: otherParty?.name || friendName || otherName || otherCode } : null);

  const call = useCall({
    friendId: mode === 'kid' ? (friendId || '') : (otherCode || ''),
    friend: callFriendParty,
    profile: callProfile,
    chatMode: mode === 'kid' ? 'kid' : 'adult',
    incomingParams: useMemo(
      () => ({ incomingCall, callType, roomName, friendName, acceptCallImmediately, callUUID, declineCall }),
      [incomingCall, callType, roomName, friendName, acceptCallImmediately, callUUID, declineCall]
    ),
    clearIncomingParams,
    onCallLog: appendMessage,
    showAlert,
    sendCallLog,
    subscribeToSignals: mode === 'adult' ? subscribeToParentCallSignals : undefined,
  });

  // Quick-call from a contact list's call button — fires once this conversation's own data
  // (friend, locks, pairing status for a kid; just myCode for an adult) has actually loaded.
  const { startCall } = call;
  const autoStartHandledRef = useRef(false);
  useEffect(() => {
    if (!autoStartCall || autoStartHandledRef.current || loading) return;
    if (mode === 'kid' && (!friend || pairingStatus !== 'paired')) return;
    if (mode === 'adult' && !myCode) return;
    const isVideo = autoStartCall === 'video';
    if (isVideo ? locks.videoCallingDisabled : locks.callingDisabled) return;
    autoStartHandledRef.current = true;
    router.setParams({ autoStartCall: undefined });
    startCall(isVideo);
  }, [autoStartCall, loading, mode, friend, pairingStatus, myCode, locks.callingDisabled, locks.videoCallingDisabled, startCall, router]);

  return {
    loading,
    otherParty,
    myCookieCode: mode === 'kid' ? (profile?.cookieCode ?? null) : myCode,
    messages,
    locks,
    pairingStatus,
    sendText,
    sendImage,
    sendDrawing,
    sendVoice,
    alertConfig,
    showAlert,
    dismissAlert,
    // Call state/actions — plain passthrough from useCall.
    callModalVisible: call.callModalVisible,
    callTypeVideo: call.callTypeVideo,
    callStatus: call.callStatus,
    callDuration: call.callDuration,
    callDirection: call.callDirection,
    remoteUid: call.remoteUid,
    isMuted: call.isMuted,
    isVideoMuted: call.isVideoMuted,
    startCall: call.startCall,
    acceptCall: call.acceptCall,
    declineCall: call.declineCall,
    endCall: call.endCall,
    toggleMute: call.toggleMute,
    switchCamera: call.switchCamera,
    toggleSpeakerMock: call.toggleSpeakerMock,
    formatDuration: call.formatDuration,
  };
}
