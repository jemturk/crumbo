import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useCall } from '@/hooks/use-call';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Friend, KidProfile, Message, StorageService } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Animated,
    FlatList,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    PanResponder,
    Platform,
    SafeAreaView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { RtcSurfaceView } from 'react-native-agora';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Per-type color so a missed voice call, a missed video call, a finished voice call and a
// finished video call are each visually distinct at a glance instead of collapsing to a single
// "red = missed, gray = ended" state. Missed voice stays red (alert); missed video is purple —
// far enough around the wheel from red to actually read as different, rather than rose/red
// which are too close together at this chip's size. Ended calls use the calmer teal/blue
// family — voice vs. video each get their own hue within that family.
const CALL_LOG_COLORS: Record<string, { fg: string; fgDark: string; bg: string; bgDark: string; border: string; borderDark: string }> = {
  MISSED_AUDIO: { fg: '#D32F2F', fgDark: '#FF8A80', bg: '#FFEBEE', bgDark: '#4C1E20', border: '#FFCDD2', borderDark: '#5C2E30' },
  MISSED_VIDEO: { fg: '#7B1FA2', fgDark: '#CE93D8', bg: '#F3E5F5', bgDark: '#3B1F47', border: '#E1BEE7', borderDark: '#4A2B58' },
  ENDED_AUDIO: { fg: '#00796B', fgDark: '#4DB6AC', bg: '#E0F2F1', bgDark: '#123330', border: '#B2DFDB', borderDark: '#1F4A45' },
  ENDED_VIDEO: { fg: '#1976D2', fgDark: '#64B5F6', bg: '#E3F2FD', bgDark: '#12293D', border: '#BBDEFB', borderDark: '#1E3A5A' },
};

const formatCallDuration = (totalSeconds: number) => {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// Locks (chatDisabled/callingDisabled/videoCallingDisabled) and pairing status used to only be
// refreshed on focus — a kid staying on an open chat while a parent flipped a lock elsewhere
// wouldn't see it take effect until navigating away and back (bug #3 in BUGS.md). There's no
// realtime channel for profile/lock changes, so polling while this screen is the focused one is
// the practical middle ground between staying reasonably live and hammering the server.
const LOCK_REFRESH_INTERVAL_MS = 20000;

export default function ChatScreen() {
  const router = useRouter();
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();
  const { friendId, incomingCall, callType, roomName, friendName, acceptCallImmediately, callUUID, declineCall: declineCallParam } = useLocalSearchParams<{
    friendId: string;
    incomingCall?: string;
    callType?: string;
    roomName?: string;
    friendName?: string;
    acceptCallImmediately?: string;
    callUUID?: string;
    declineCall?: string;
  }>();
  const insets = useSafeAreaInsets();

  // Chat state
  const [friend, setFriend] = useState<Friend | null>(null);
  // The periodic lock-refresh poll (see LOCK_REFRESH_INTERVAL_MS below) is set up once per
  // useFocusEffect run, so its setInterval callback closes over `friend` as of that moment —
  // reading a ref instead keeps it current across renders (same pattern used throughout
  // use-call.ts / chat/index.tsx's pairingStatusesRef).
  const friendRef = useRef<Friend | null>(null);
  useEffect(() => {
    friendRef.current = friend;
  }, [friend]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [isTyping] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Parental locks + pairing
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [chatDisabled, setChatDisabled] = useState(false);
  const [callingDisabled, setCallingDisabled] = useState(false);
  const [videoCallingDisabled, setVideoCallingDisabled] = useState(false);
  const [pairingStatus, setPairingStatus] = useState<'paired' | 'pending'>('paired');

  // Custom Alert State
  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    message: string;
    buttons?: AlertButton[];
  }>({ visible: false, title: '', message: '' });

  const showAlert = useCallback((title: string, message: string, buttons?: AlertButton[]) => {
    setAlertConfig({ visible: true, title, message, buttons });
  }, []);

  const flatListRef = useRef<FlatList>(null);
  const invertedMessages = useMemo(() => [...messages].reverse(), [messages]);

  // Draggable local video view
  const pan = useRef(new Animated.ValueXY()).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => pan.extractOffset(),
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: () => pan.flattenOffset(),
    })
  ).current;

  // Append a call-log message emitted by the call hook.
  const handleCallLog = useCallback((logMsg: Message) => {
    setMessages(prev => (prev.find(m => m.id === logMsg.id) ? prev : [...prev, logMsg]));
  }, []);

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

  // All call state + Agora/CallKeep/sound lifecycle lives in the hook.
  const {
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
  } = useCall({
    friendId,
    friend,
    profile,
    incomingParams: useMemo(
      () => ({ incomingCall, callType, roomName, friendName, acceptCallImmediately, callUUID, declineCall: declineCallParam }),
      [incomingCall, callType, roomName, friendName, acceptCallImmediately, callUUID, declineCallParam]
    ),
    clearIncomingParams,
    onCallLog: handleCallLog,
    showAlert,
  });

  // Reset the draggable local-video position whenever the call modal closes.
  useEffect(() => {
    if (!callModalVisible) {
      pan.setValue({ x: 0, y: 0 });
      pan.setOffset({ x: 0, y: 0 });
    }
  }, [callModalVisible]);

  // Keyboard tracking
  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow',
      (e) => {
        setKeyboardVisible(true);
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide',
      () => {
        setKeyboardVisible(false);
        setKeyboardHeight(0);
      }
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadChat();
      // Keep locks/pairing status live while this screen stays focused, not just on the next
      // focus — see LOCK_REFRESH_INTERVAL_MS's comment (bug #3 in BUGS.md).
      const interval = setInterval(refreshLocksAndStatus, LOCK_REFRESH_INTERVAL_MS);
      return () => clearInterval(interval);
    }, [friendId])
  );

  // Realtime chat messages for this conversation (call signals travel elsewhere).
  useEffect(() => {
    const unsubscribe = StorageService.subscribeToMessages((newMsg, msgFriendId) => {
      if (msgFriendId !== friendId) return;
      setMessages(prev => (prev.find(m => m.id === newMsg.id) ? prev : [...prev, newMsg]));
    });
    return () => unsubscribe();
  }, [friendId]);

  const loadChat = async () => {
    if (!friendId) return;
    try {
      setLoading(true);
      const friends = await StorageService.getFriends();
      const currentFriend = friends.find(f => f.id === friendId) || null;
      setFriend(currentFriend);

      // Synced from the parent's profile (not just the local cache) so a lock the parent just
      // flipped is picked up on this load rather than whatever was cached from before — falls
      // back to the local cache if the sync fails (offline etc.), same as chat/index.tsx.
      const kidProf = (await StorageService.syncKidProfileAndFriends()) || (await StorageService.getKidProfile());
      setProfile(kidProf);
      if (kidProf) {
        setChatDisabled(!!kidProf.chatDisabled);
        setCallingDisabled(!!kidProf.callingDisabled);
        setVideoCallingDisabled(!!kidProf.videoCallingDisabled);
      }

      if (currentFriend) {
        const msgs = await StorageService.getMessages(currentFriend.id);
        setMessages(msgs);

        if (kidProf) {
          try {
            const status = await StorageService.checkFriendPairingStatus(kidProf.cookieCode, currentFriend.cookieCode);
            setPairingStatus(status);
          } catch (e) {
            // A failed check is not evidence the pairing was revoked — keep showing whatever
            // pairingStatus was last known to be instead of demoting to 'pending' and locking
            // the chat input over a transient network error.
            console.error('Error checking pairing status', e);
          }
        }
      }
    } catch (e) {
      console.error('Error loading chat', e);
    } finally {
      setLoading(false);
    }
  };

  // Lightweight sibling of loadChat for the periodic poll set up in the useFocusEffect above —
  // refreshes only locks/pairing status, without setLoading(true)/reloading messages, so it
  // doesn't blank the screen out from under a kid mid-conversation every
  // LOCK_REFRESH_INTERVAL_MS.
  const refreshLocksAndStatus = async () => {
    if (!friendId) return;
    try {
      const kidProf = (await StorageService.syncKidProfileAndFriends()) || (await StorageService.getKidProfile());
      setProfile(kidProf);
      if (kidProf) {
        setChatDisabled(!!kidProf.chatDisabled);
        setCallingDisabled(!!kidProf.callingDisabled);
        setVideoCallingDisabled(!!kidProf.videoCallingDisabled);
      }

      const currentFriend = friendRef.current;
      if (kidProf && currentFriend) {
        try {
          const status = await StorageService.checkFriendPairingStatus(kidProf.cookieCode, currentFriend.cookieCode);
          setPairingStatus(status);
        } catch (e) {
          console.error('Error checking pairing status', e);
        }
      }
    } catch (e) {
      console.error('Error refreshing locks/status', e);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() || !friend) return;
    const textToSend = inputText.trim();
    setInputText('');
    try {
      const savedMsg = await StorageService.sendMessage(friendId, textToSend);
      setMessages(prev => (prev.find(m => m.id === savedMsg.id) ? prev : [...prev, savedMsg]));
    } catch (e) {
      console.error('Error sending message', e);
    }
  };

  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  };

  const renderMessageItem = ({ item }: { item: Message }) => {
    const isCallLog = item.text.startsWith('[CALL_LOG:');

    if (isCallLog) {
      // Direction suffix (INCOMING/OUTGOING) is who initiated the call; callUUID (used to
      // dedupe each side's independent missed-call write, see storage.ts's dedupeCallLogs) and
      // a completed (non-missed) call's trailing duration-in-seconds field were added after
      // this log format first shipped, so older stored entries may be missing some of these.
      const [logType, direction, , durationStr] = item.text.replace('[CALL_LOG:', '').replace(']', '').split(':');
      let logTitle = '';
      let logIcon: keyof typeof Ionicons.glyphMap = 'call';
      let isMissed = false;

      switch (logType) {
        case 'MISSED_VIDEO':
          logTitle = 'Missed Video Call';
          logIcon = 'videocam-off';
          isMissed = true;
          break;
        case 'MISSED_AUDIO':
          logTitle = 'Missed Voice Call';
          logIcon = 'call-outline';
          isMissed = true;
          break;
        case 'ENDED_VIDEO':
          logTitle = 'Video Call Ended';
          logIcon = 'videocam';
          break;
        case 'ENDED_AUDIO':
        default:
          logTitle = 'Voice Call Ended';
          logIcon = 'call';
          break;
      }

      const durationSeconds = !isMissed && durationStr ? parseInt(durationStr, 10) : NaN;
      if (!isNaN(durationSeconds)) {
        logTitle = `${logTitle} · ${formatCallDuration(durationSeconds)}`;
      }

      const logColors = CALL_LOG_COLORS[logType] || CALL_LOG_COLORS.ENDED_AUDIO;
      const logColor = isDark ? logColors.fgDark : logColors.fg;

      // The direction suffix is relative to whoever WROTE the log row, and rows sync to both
      // devices through the shared messages table. On the writer's device sender is 'me'; on
      // the other kid's device the same row arrives with sender 'them' and the meaning flips
      // (their OUTGOING = my incoming). XOR the two to get "did I initiate this call".
      const initiatedByMe = (item.sender === 'me') === (direction === 'OUTGOING');
      const callLogAlignStyle = !direction
        ? styles.callLogCentered // legacy rows written before the direction suffix existed
        : initiatedByMe
        ? styles.myRow
        : styles.theirRow;

      return (
        <View style={[styles.callLogWrapper, callLogAlignStyle]}>
          <View style={[styles.callLogContainer, {
            backgroundColor: isDark ? logColors.bgDark : logColors.bg,
            borderColor: isDark ? logColors.borderDark : logColors.border
          }, { paddingHorizontal: s(12), paddingVertical: s(6), gap: s(6) }]}>
            {direction && (
              // Diagonal arrow, like a phone app's call log: ↗ this device called out,
              // ↙ this device was called (red when that incoming call went unanswered).
              <Ionicons
                name="arrow-up-outline"
                size={s(12)}
                color={logColor}
                style={{ transform: [{ rotate: initiatedByMe ? '45deg' : '225deg' }] }}
              />
            )}
            <Ionicons name={logIcon} size={s(16)} color={logColor} style={styles.callLogIcon} />
            <Text style={[styles.callLogText, { color: logColor }, { fontSize: s(12) }]}>
              {logTitle}
            </Text>
            <Text style={[styles.callLogTime, { color: colors.textSecondary }, { fontSize: s(10) }]}>{formatTime(item.timestamp)}</Text>
          </View>
        </View>
      );
    }

    const isMe = item.sender === 'me';
    return (
      <View style={[styles.messageRow, isMe ? styles.myRow : styles.theirRow]}>
        <View style={[
          styles.bubble,
          isMe ? [styles.myBubble, { backgroundColor: colors.primaryBtn, borderBottomRightRadius: 4 }]
               : [styles.theirBubble, { backgroundColor: isDark ? '#3D2A1D' : '#FFFEC6', borderColor: isDark ? '#4E342E' : '#FFF9C4', borderBottomLeftRadius: 4 }],
          { paddingHorizontal: s(16), paddingVertical: s(10), borderRadius: s(20) }
        ]}>
          <Text style={[styles.messageText, { color: isMe ? colors.primaryBtnText : colors.text }, { fontSize: s(16), lineHeight: s(22) }]}>{item.text}</Text>
        </View>
        <Text style={[styles.timestamp, isMe ? styles.myTimestamp : styles.theirTimestamp, { color: colors.textSecondary }, { fontSize: s(10) }]}>
          {formatTime(item.timestamp)}
        </Text>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.primaryBtn} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.cardBg, borderColor: colors.border, paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + s(8) : s(44)) : s(14), paddingHorizontal: s(20), paddingVertical: s(14) }]}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.replace('/chat')}>
          <Ionicons name="arrow-back" size={s(26)} color={colors.text} />
        </TouchableOpacity>

        <View style={styles.headerInfo}>
          <Text style={[styles.headerName, { fontSize: s(20), color: colors.text }]}>{friend?.name}</Text>
        </View>

        <View style={styles.headerRight}>
          {!callingDisabled && pairingStatus === 'paired' && (
            <TouchableOpacity style={[styles.headerCallBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong }]} onPress={() => startCall(false)}>
              <Ionicons name="call" size={s(20)} color={colors.actionBtnSecondaryText} />
            </TouchableOpacity>
          )}
          {!videoCallingDisabled && pairingStatus === 'paired' && (
            <TouchableOpacity style={[styles.headerCallBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong }]} onPress={() => startCall(true)}>
              <Ionicons name="videocam" size={s(20)} color={colors.actionBtnSecondaryText} />
            </TouchableOpacity>
          )}
          {(callingDisabled || pairingStatus === 'pending') && (videoCallingDisabled || pairingStatus === 'pending') && (
            <View style={{ width: s(36) }} />
          )}
        </View>
      </View>

      {/* Keyboard Avoiding Container */}
      <KeyboardAvoidingView
        style={[styles.keyboardContainer, Platform.OS === 'android' && { paddingBottom: keyboardHeight > 0 ? keyboardHeight + s(24) : 0 }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Messages list */}
        <FlatList
          ref={flatListRef}
          inverted
          data={invertedMessages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessageItem}
          style={{ flex: 1 }}
          contentContainerStyle={[styles.messagesList, { padding: s(16), gap: s(12) }]}
        />

        {/* Typing indicator */}
        {isTyping && (
          <View style={[styles.typingContainer, { paddingHorizontal: s(16), paddingVertical: s(8) }]}>
            <Text style={[styles.typingText, { fontSize: s(14), color: colors.textSecondary }]}>{friend?.name} is typing...</Text>
          </View>
        )}

        {/* Bottom Input Area */}
        {chatDisabled ? (
          <View style={[styles.disabledInputArea, { backgroundColor: isDark ? '#3D1B1B' : '#FFF5F5', borderColor: isDark ? '#5C2525' : '#FFD1D1' }, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + s(16) : s(16)) : s(16), paddingHorizontal: s(16), paddingVertical: s(16), gap: s(12) }]}>
            <Ionicons name="lock-closed" size={s(20)} color={colors.dangerText} />
            <Text style={[styles.disabledInputText, { fontSize: s(14), lineHeight: s(20), color: colors.dangerText }]}>Chatting is paused by your parent 🍪</Text>
          </View>
        ) : pairingStatus === 'pending' ? (
          <View style={[styles.pendingInputArea, { backgroundColor: isDark ? '#3D291B' : '#FFF3E0', borderColor: isDark ? '#5C3E25' : '#FFE0B2' }, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + s(16) : s(16)) : s(16), paddingHorizontal: s(16), paddingVertical: s(16), gap: s(12) }]}>
            <Ionicons name="alert-circle" size={s(20)} color={colors.textSecondary} />
            <Text style={[styles.pendingInputText, { fontSize: s(14), lineHeight: s(20), color: colors.textSecondary }]}>
              Waiting for parent approval. Tell friend's parent your Cookie Code: {profile?.cookieCode}
            </Text>
          </View>
        ) : (
          <View style={[styles.inputArea, { backgroundColor: colors.cardBg, borderColor: colors.border }, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + s(12) : s(12)) : s(12), paddingHorizontal: s(16), paddingVertical: s(8), gap: s(12) }]}>
            <View style={[styles.inputContainer, { backgroundColor: colors.inputBg, borderColor: colors.borderStrong }, { paddingHorizontal: s(16), borderRadius: s(24), height: s(48) }]}>
              <TextInput
                style={[styles.textInput, { color: colors.inputText }, { fontSize: s(16) }]}
                placeholder="Write something..."
                placeholderTextColor={colors.textSecondary}
                value={inputText}
                onChangeText={setInputText}
                onSubmitEditing={handleSend}
                multiline={false}
              />
            </View>
            <TouchableOpacity
              style={[styles.sendButton, { backgroundColor: colors.primaryBtn }, !inputText.trim() && styles.sendButtonDisabled, { width: s(48), height: s(48), borderRadius: s(24) }]}
              onPress={handleSend}
              disabled={!inputText.trim()}
            >
              <Ionicons name="paper-plane" size={s(20)} color={colors.primaryBtnText} />
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Calling Modal */}
      <Modal
        animationType="fade"
        transparent={false}
        visible={callModalVisible}
        onRequestClose={endCall}
      >
        <View style={[styles.callModalContainer, callTypeVideo ? styles.callVideoBg : styles.callAudioBg]}>
          {/* Video Views if connected/video call */}
          {callTypeVideo && callStatus === 'connected' && (
            <View style={StyleSheet.absoluteFill}>
              {remoteUid !== null ? (
                <>
                  <RtcSurfaceView style={styles.remoteVideo} canvas={{ uid: remoteUid }} />

                  <Animated.View
                    {...panResponder.panHandlers}
                    style={[
                      styles.localVideo,
                      {
                        transform: pan.getTranslateTransform(),
                        top: insets.top > 0 ? insets.top + s(10) : s(20),
                      },
                    ]}
                  >
                    <RtcSurfaceView style={styles.localVideoSurface} canvas={{ uid: 0 }} zOrderMediaOverlay={true} />
                  </Animated.View>
                </>
              ) : (
                <RtcSurfaceView style={styles.localVideoFullScreen} canvas={{ uid: 0 }} />
              )}
            </View>
          )}

          {/* Header Call Info */}
          <View style={[
            styles.callHeaderContainer,
            { paddingTop: insets.top > 0 ? insets.top + s(10) : s(30) },
            callTypeVideo && callStatus === 'connected' && remoteUid !== null && styles.callHeaderVideoConnected
          ]}>
            <Text style={[
              styles.callLabel,
              { fontSize: s(11) },
              callTypeVideo && callStatus === 'connected' && remoteUid !== null ? styles.textShadowLightBlue : styles.callLabelText
            ]}>
              {callTypeVideo ? '📹 VIDEO CALL' : '📞 CRUMBO VOICE CALL'}
            </Text>

            <Text style={[
              styles.callFriendName,
              { fontSize: s(28) },
              callTypeVideo && callStatus === 'connected' && remoteUid !== null ? [styles.callFriendNameVideo, styles.textShadow] : styles.callFriendNameAudio
            ]}>
              {friend?.name || friendName || 'Crumbo Friend'}
            </Text>

            <Text style={[
              styles.callStatusText,
              { fontSize: s(15) },
              callTypeVideo && callStatus === 'connected' && remoteUid !== null ? [styles.callStatusTextVideo, styles.textShadow] : styles.callStatusTextAudio
            ]}>
              {callStatus === 'ringing' && (callDirection === 'incoming' ? 'Incoming Call...' : 'Ringing...')}
              {callStatus === 'connected' && (remoteUid === null && callTypeVideo ? 'Connecting video...' : `Connected • ${formatDuration(callDuration)}`)}
              {callStatus === 'ended' && 'Call Ended'}
            </Text>
          </View>

          {/* Middle Section (for Avatar when not in active video) */}
          {(!callTypeVideo || callStatus !== 'connected' || remoteUid === null) && (
            <View style={styles.callMiddleContainer}>
              <View style={[
                styles.avatarContainerLarge,
                { width: s(130), height: s(130), borderRadius: s(65) }
              ]}>
                <Text style={[styles.avatarEmojiLarge, { fontSize: s(64) }]}>{friend?.avatarEmoji || '🍪'}</Text>
              </View>
            </View>
          )}

          {/* Empty spacer to push controls to bottom when active video is showing */}
          {callTypeVideo && callStatus === 'connected' && remoteUid !== null && (
            <View style={{ flex: 1 }} />
          )}

          {/* Controls */}
          {callStatus === 'ringing' && callDirection === 'incoming' ? (
            <View style={[
              styles.controlsContainer,
              callTypeVideo ? styles.controlsContainerVideo : styles.controlsContainerAudio,
              { paddingBottom: insets.bottom > 0 ? insets.bottom + s(20) : s(30) }
            ]}>
              <View style={styles.callControlsRowIncoming}>
                <TouchableOpacity style={[styles.callControlBtn, styles.declineBtn, { width: s(64), height: s(64), borderRadius: s(32) }]} onPress={declineCall}>
                  <Ionicons name="close" size={s(32)} color="#FFFFFF" />
                </TouchableOpacity>
                <TouchableOpacity style={[styles.callControlBtn, styles.acceptBtn, { width: s(64), height: s(64), borderRadius: s(32) }]} onPress={acceptCall}>
                  <Ionicons name="checkmark" size={s(32)} color="#FFFFFF" />
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <View style={[
              styles.controlsContainer,
              callTypeVideo && callStatus === 'connected' && remoteUid !== null ? styles.controlsContainerVideo : styles.controlsContainerAudio,
              { paddingBottom: insets.bottom > 0 ? insets.bottom + s(20) : s(30) }
            ]}>
              <View style={styles.callControlsRow}>
                <TouchableOpacity
                  style={[
                    styles.callMuteBtn,
                    isMuted && (callTypeVideo && callStatus === 'connected' && remoteUid !== null ? styles.activeMuteBtnVideo : styles.activeMuteBtn),
                    callTypeVideo && callStatus === 'connected' && remoteUid !== null && styles.videoCallControlBtn,
                    { width: s(56), height: s(56), borderRadius: s(28) }
                  ]}
                  onPress={toggleMute}
                >
                  <Ionicons
                    name={isMuted ? "mic-off" : "mic"}
                    size={s(24)}
                    color={isMuted ? "#FFFFFF" : (callTypeVideo && callStatus === 'connected' && remoteUid !== null ? '#FFFFFF' : '#4E342E')}
                  />
                </TouchableOpacity>

                <TouchableOpacity style={[styles.callEndBtn, { width: s(72), height: s(72), borderRadius: s(36) }]} onPress={endCall}>
                  <Ionicons name="close" size={s(32)} color="#FFFFFF" />
                </TouchableOpacity>

                {callTypeVideo ? (
                  <TouchableOpacity
                    style={[
                      styles.callMuteBtn,
                      callTypeVideo && callStatus === 'connected' && remoteUid !== null && styles.videoCallControlBtn,
                      { width: s(56), height: s(56), borderRadius: s(28) }
                    ]}
                    onPress={switchCamera}
                  >
                    <Ionicons
                      name="camera-reverse"
                      size={s(24)}
                      color={callTypeVideo && callStatus === 'connected' && remoteUid !== null ? '#FFFFFF' : '#4E342E'}
                    />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[
                      styles.callMuteBtn,
                      isVideoMuted && styles.activeMuteBtn,
                      { width: s(56), height: s(56), borderRadius: s(28) }
                    ]}
                    onPress={toggleSpeakerMock}
                  >
                    <Ionicons
                      name="volume-high"
                      size={s(24)}
                      color={isVideoMuted ? '#BDBDBD' : '#4E342E'}
                    />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </View>
      </Modal>
      <CustomAlertModal
        visible={alertConfig.visible}
        title={alertConfig.title}
        message={alertConfig.message}
        buttons={alertConfig.buttons}
        onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#FFFDF4',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    backgroundColor: '#FFFDF4',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderColor: '#FFF5D1',
    backgroundColor: '#FFFFFF',
    paddingTop: Platform.OS === 'android' ? 44 : 14,
  },
  backButton: {
    padding: 6,
  },
  headerInfo: {
    alignItems: 'center',
    flex: 1,
  },
  headerName: {
    fontSize: 22,
    fontWeight: '900',
    color: '#4E342E',
    textAlign: 'center',
  },
  keyboardContainer: {
    flex: 1,
  },
  messagesList: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 16,
  },
  messageRow: {
    maxWidth: '75%',
    marginBottom: 4,
  },
  myRow: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  theirRow: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  bubble: {
    borderRadius: 20,
    paddingVertical: 12,
    paddingHorizontal: 18,
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  myBubble: {
    backgroundColor: '#FBC02D', // Golden yellow
    borderBottomRightRadius: 4,
  },
  theirBubble: {
    backgroundColor: '#FFFEC6', // Very soft light yellow/cream
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#FFF9C4',
  },
  messageText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4E342E',
    lineHeight: 22,
  },
  timestamp: {
    fontSize: 11,
    color: '#8D6E63',
    marginTop: 4,
    fontWeight: '600',
    paddingHorizontal: 6,
  },
  myTimestamp: {
    alignSelf: 'flex-end',
  },
  theirTimestamp: {
    alignSelf: 'flex-start',
  },
  typingContainer: {
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  typingText: {
    fontSize: 13,
    color: '#8D6E63',
    fontStyle: 'italic',
    fontWeight: '600',
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderColor: '#FFF5D1',
    gap: 12,
  },
  inputContainer: {
    flex: 1,
    backgroundColor: '#FFFDF0',
    borderWidth: 2,
    borderColor: '#FFF1C5',
    borderRadius: 25,
    height: 50,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  textInput: {
    fontSize: 16,
    color: '#4E342E',
    fontWeight: '600',
  },
  sendButton: {
    backgroundColor: '#FBC02D',
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#FBC02D',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 2,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerCallBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#FFFDF5',
    borderWidth: 1,
    borderColor: '#FFEFC0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  disabledInputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: '#FFF5F5',
    borderTopWidth: 1,
    borderColor: '#FFD1D1',
    gap: 8,
  },
  disabledInputText: {
    fontSize: 14,
    color: '#D32F2F',
    fontWeight: '800',
  },
  callModalContainer: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  callVideoBg: {
    backgroundColor: '#E1F5FE', // Soft video calling blue
  },
  callAudioBg: {
    backgroundColor: '#FFFDE7', // Soft warm audio calling yellow
  },
  callHeaderContainer: {
    alignItems: 'center',
    width: '100%',
    zIndex: 10,
  },
  callHeaderVideoConnected: {
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    width: '90%',
    alignSelf: 'center',
  },
  callLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  callLabelText: {
    color: '#8D6E63',
  },
  textShadowLightBlue: {
    color: '#B3E5FC',
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  callFriendName: {
    fontWeight: '900',
  },
  callFriendNameAudio: {
    color: '#4E342E',
  },
  callFriendNameVideo: {
    color: '#FFFFFF',
  },
  callStatusText: {
    fontWeight: '700',
  },
  callStatusTextAudio: {
    color: '#8D6E63',
  },
  callStatusTextVideo: {
    color: '#E1F5FE',
  },
  textShadow: {
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  callMiddleContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  avatarContainerLarge: {
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: '#FFD54F',
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 4,
  },
  avatarEmojiLarge: {
    fontSize: 80,
  },
  controlsContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  controlsContainerVideo: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  controlsContainerAudio: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderColor: '#FFEFC0',
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 6,
  },
  callControlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 28,
    zIndex: 10,
  },
  callMuteBtn: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  videoCallControlBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderColor: 'rgba(255, 255, 255, 0.35)',
    borderWidth: 1.5,
  },
  callEndBtn: {
    backgroundColor: '#E53935',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#E53935',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  callLogWrapper: {
    marginVertical: 4,
    maxWidth: '85%',
  },
  callLogCentered: {
    alignSelf: 'center',
  },
  callLogContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
  },
  callLogMissed: {
    backgroundColor: '#FFEBEE',
    borderColor: '#FFCDD2',
  },
  callLogEnded: {
    backgroundColor: '#F5F5F5',
    borderColor: '#E0E0E0',
  },
  callLogIcon: {
    marginRight: 2,
  },
  callLogText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4E342E',
  },
  callLogTextMissed: {
    color: '#D32F2F',
  },
  callLogTime: {
    fontSize: 10,
    color: '#8D6E63',
    marginLeft: 6,
    fontWeight: '600',
  },
  callControlsRowIncoming: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 40,
    width: '100%',
    zIndex: 10,
  },
  callControlBtn: {
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
  },
  acceptBtn: {
    backgroundColor: '#4CAF50',
  },
  declineBtn: {
    backgroundColor: '#F44336',
  },
  pendingInputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: '#FFF3E0',
    borderTopWidth: 1,
    borderColor: '#FFE0B2',
    gap: 8,
  },
  pendingInputText: {
    fontSize: 13,
    color: '#E65100',
    fontWeight: '800',
    flexShrink: 1,
    textAlign: 'center',
  },
  activeMuteBtn: {
    backgroundColor: '#FFCDD2',
    borderColor: '#E53935',
  },
  activeMuteBtnVideo: {
    backgroundColor: '#E53935',
    borderColor: '#FFCDD2',
  },
  remoteVideo: {
    width: '100%',
    height: '100%',
  },
  localVideo: {
    width: 110,
    height: 150,
    position: 'absolute',
    right: 20,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    backgroundColor: '#000000',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
    zIndex: 20,
  },
  localVideoSurface: {
    width: '100%',
    height: '100%',
  },
  localVideoFullScreen: {
    width: '100%',
    height: '100%',
  },
});
