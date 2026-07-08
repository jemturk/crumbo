import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  FlatList, 
  TextInput, 
  TouchableOpacity, 
  SafeAreaView, 
  KeyboardAvoidingView, 
  Platform, 
  ActivityIndicator,
  Keyboard,
  Modal,
  Vibration,
  Animated,
  PanResponder
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, Message, Friend, KidProfile, triggerMockReply } from '@/services/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { Camera } from 'expo-camera';
import { RtcSurfaceView } from 'react-native-agora';
import { agoraManager, hashCode, fetchAgoraToken } from '@/services/agora';
import { callKeepManager } from '@/services/callkeep';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export default function ChatScreen() {
  const router = useRouter();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();
  const { friendId, incomingCall, callType, roomName } = useLocalSearchParams<{ 
    friendId: string;
    incomingCall?: string;
    callType?: string;
    roomName?: string;
  }>();
  const insets = useSafeAreaInsets();

  // State
  const [friend, setFriend] = useState<Friend | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Custom Alert State
  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    message: string;
    buttons?: AlertButton[];
  }>({ visible: false, title: '', message: '' });

  const showAlert = (
    title: string,
    message: string,
    buttons?: AlertButton[]
  ) => {
    setAlertConfig({ visible: true, title, message, buttons });
  };

  // Parental Locks State
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [chatDisabled, setChatDisabled] = useState(false);
  const [callingDisabled, setCallingDisabled] = useState(false);
  const [videoCallingDisabled, setVideoCallingDisabled] = useState(false);
  const [pairingStatus, setPairingStatus] = useState<'paired' | 'pending'>('paired');

  // Calling states
  const [callModalVisible, setCallModalVisible] = useState(false);
  const [callTypeVideo, setCallTypeVideo] = useState(false);
  const [callStatus, setCallStatus] = useState<'ringing' | 'connected' | 'ended'>('ringing');
  const [callDuration, setCallDuration] = useState(0);
  const [callDirection, setCallDirection] = useState<'incoming' | 'outgoing'>('outgoing');
  const [callRoom, setCallRoom] = useState<string>('');
  const [remoteUid, setRemoteUid] = useState<number | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [activeCallUuid, setActiveCallUuid] = useState<string | null>(null);

  // Draggable local video view setup
  const pan = useRef(new Animated.ValueXY()).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        pan.extractOffset();
      },
      onPanResponderMove: Animated.event(
        [null, { dx: pan.x, dy: pan.y }],
        { useNativeDriver: false }
      ),
      onPanResponderRelease: () => {
        pan.flattenOffset();
      }
    })
  ).current;

  useEffect(() => {
    if (!callModalVisible) {
      pan.setValue({ x: 0, y: 0 });
      pan.setOffset({ x: 0, y: 0 });
    }
  }, [callModalVisible]);

  // CallKeep callbacks hook
  useEffect(() => {
    callKeepManager.registerCallbacks(
      () => {
        handleAcceptCall();
      },
      () => {
        if (callStatus === 'ringing') {
          if (callDirection === 'incoming') {
            handleDeclineCall();
          } else {
            handleEndCall();
          }
        } else if (callStatus === 'connected') {
          handleEndCall();
        }
      }
    );
    return () => {
      callKeepManager.clearCallbacks();
    };
  }, [callStatus, callDirection, callRoom, callTypeVideo, friendId]);

  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow',
      (e) => {
        setKeyboardVisible(true);
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide',
      () => {
        setKeyboardVisible(false);
        setKeyboardHeight(0);
      }
    );

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const flatListRef = useRef<FlatList>(null);
  const initialCallHandled = useRef(false);

  useEffect(() => {
    initialCallHandled.current = false;
  }, [friendId]);

  useEffect(() => {
    if (incomingCall === 'true' && !initialCallHandled.current) {
      initialCallHandled.current = true;
      const isVideo = callType === 'video';
      setCallTypeVideo(isVideo);
      setCallDirection('incoming');
      setCallStatus('ringing');
      setCallRoom(roomName || '');
      setCallModalVisible(true);
      Vibration.vibrate([1000, 1000], true);
    }
  }, [incomingCall, callType, roomName]);

  useFocusEffect(
    useCallback(() => {
      loadChat();
    }, [friendId])
  );

  // Call duration timer
  useEffect(() => {
    let timer: any;
    if (callStatus === 'connected') {
      timer = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(timer);
  }, [callStatus]);

  const callRoomRef = useRef<string>('');
  useEffect(() => {
    callRoomRef.current = callRoom;
  }, [callRoom]);

  useEffect(() => {
    // Subscribe to realtime database updates
    const unsubscribe = StorageService.subscribeToMessages((newMsg, msgFriendId) => {
      if (newMsg.text && newMsg.text.startsWith('[CALL_SIGNAL:')) {
        if (newMsg.text.startsWith('[CALL_SIGNAL:START_') && newMsg.sender === 'them' && msgFriendId !== friendId) {
          // Incoming call from a different friend! Redirect to their chat with call params
          const isVideo = newMsg.text.includes('START_VIDEO_CALL');
          const parts = newMsg.text.split(':');
          const roomName = parts[parts.length - 1];
          router.push({
            pathname: `/chat/${msgFriendId}`,
            params: {
              incomingCall: 'true',
              callType: isVideo ? 'video' : 'audio',
              roomName
            }
          });
        } else if (msgFriendId === friendId) {
          // Call signal for the current friend's conversation
          handleIncomingCallSignal(newMsg);
        }
        return;
      }

      if (msgFriendId === friendId) {
        setMessages(prev => {
          if (prev.find(m => m.id === newMsg.id)) return prev;
          return [...prev, newMsg];
        });
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      }
    });

    return () => {
      Vibration.cancel();
      agoraManager.destroy();
      unsubscribe();
    };
  }, [friendId]);

  const loadChat = async () => {
    if (!friendId) return;
    try {
      setLoading(true);
      const friends = await StorageService.getFriends();
      const currentFriend = friends.find(f => f.id === friendId) || null;
      setFriend(currentFriend);

      // Load kid profile to get parental locks
      const kidProf = await StorageService.getKidProfile();
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
          const status = await StorageService.checkFriendPairingStatus(kidProf.cookieCode, currentFriend.cookieCode);
          setPairingStatus(status);
        }
      }
    } catch (e) {
      console.error("Error loading chat", e);
    } finally {
      setLoading(false);
      // Scroll to bottom after load
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100);
    }
  };

  const startAgoraCall = async (channelName: string, isVideo: boolean, isIncoming: boolean) => {
    if (!profile) return;

    if (isVideo) {
      const cameraStatus = await Camera.requestCameraPermissionsAsync();
      if (!cameraStatus.granted) {
        showAlert("Permission Required", "Camera permission is required for video calls.");
        return;
      }
    }
    const micStatus = await Camera.requestMicrophonePermissionsAsync();
    if (!micStatus.granted) {
      showAlert("Permission Required", "Microphone permission is required for voice calls.");
      return;
    }

    const appID = process.env.EXPO_PUBLIC_AGORA_APP_ID || '';
    if (!appID) {
      console.warn("Agora APP ID is missing. Voice/video streaming will not work.");
    }

    try {
      await agoraManager.init(
        appID,
        (uid) => {
          setRemoteUid(uid);
          setCallStatus('connected');
        },
        (uid) => {
          setRemoteUid(null);
          handleEndCall();
        },
        (err) => {
          console.error("Agora engine error:", err);
        }
      );

      const localUid = hashCode(profile.cookieCode);
      let token = '';
      try {
        token = await fetchAgoraToken(channelName, localUid);
      } catch (tokenErr) {
        console.warn("[Agora] Failed to fetch token, falling back to tokenless join. If your Agora project requires tokens, this call will fail.", tokenErr);
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
      console.error("Failed to start Agora call:", e);
      showAlert("Call Error", "Could not establish connection.");
      handleEndCall();
    }
  };

  const handleIncomingCallSignal = async (msg: Message) => {
    const isThem = msg.sender === 'them';

    if (msg.text.startsWith('[CALL_SIGNAL:START_')) {
      if (isThem) {
        const isVideo = msg.text.includes('START_VIDEO_CALL');
        const parts = msg.text.split(':');
        const roomName = parts[parts.length - 1];

        const uuid = generateUUID();
        setActiveCallUuid(uuid);
        callKeepManager.displayIncomingCall(uuid, friend?.name || 'Friend', friend?.name || 'Friend');

        setCallTypeVideo(isVideo);
        setCallDirection('incoming');
        setCallStatus('ringing');
        setCallRoom(roomName);
        setCallModalVisible(true);
        Vibration.vibrate([1000, 1000], true);
      }
    } else if (msg.text === '[CALL_SIGNAL:ACCEPT_CALL]') {
      if (isThem) {
        Vibration.cancel();
        setCallStatus('connected');
      }
    } else if (msg.text === '[CALL_SIGNAL:DECLINE_CALL]') {
      if (isThem) {
        Vibration.cancel();
        setCallStatus('ended');
        if (activeCallUuid) {
          callKeepManager.endCall(activeCallUuid);
          setActiveCallUuid(null);
        }
        showAlert("Call Busy", `${friend?.name || 'Friend'} is busy right now.`);
        await agoraManager.destroy();
        setRemoteUid(null);
        setTimeout(() => {
          setCallModalVisible(false);
        }, 1500);
      }
    } else if (msg.text === '[CALL_SIGNAL:END_CALL]') {
      if (isThem) {
        Vibration.cancel();
        setCallStatus('ended');
        if (activeCallUuid) {
          callKeepManager.endCall(activeCallUuid);
          setActiveCallUuid(null);
        }
        await agoraManager.destroy();
        setRemoteUid(null);
        setTimeout(() => {
          setCallModalVisible(false);
        }, 1500);
      }
    }
  };

  const handleStartCall = async (isVideo: boolean) => {
    if (!profile || !friend) return;

    const roomName = `CrumboCall_${profile.cookieCode}_${friend.cookieCode}`.replace(/-/g, '_');
    setCallRoom(roomName);
    setCallTypeVideo(isVideo);
    setCallDirection('outgoing');
    setCallStatus('ringing');
    setCallModalVisible(true);

    const uuid = generateUUID();
    setActiveCallUuid(uuid);
    callKeepManager.startCall(uuid, friend.name, friend.name);

    const signalText = `[CALL_SIGNAL:START_${isVideo ? 'VIDEO' : 'AUDIO'}_CALL]:${roomName}`;
    await StorageService.sendCallSignal(friendId, signalText);

    await startAgoraCall(roomName, isVideo, false);
  };

  const handleAcceptCall = async () => {
    Vibration.cancel();
    setCallStatus('connected');
    await StorageService.sendCallSignal(friendId, '[CALL_SIGNAL:ACCEPT_CALL]');
    if (callRoom) {
      await startAgoraCall(callRoom, callTypeVideo, true);
    }
  };

  const handleDeclineCall = async () => {
    Vibration.cancel();
    setCallStatus('ended');
    if (activeCallUuid) {
      callKeepManager.endCall(activeCallUuid);
      setActiveCallUuid(null);
    }
    await agoraManager.destroy();
    setRemoteUid(null);
    setCallModalVisible(false);
    await StorageService.sendCallSignal(friendId, '[CALL_SIGNAL:DECLINE_CALL]');

    const callLogText = callTypeVideo ? '[CALL_LOG:MISSED_VIDEO]' : '[CALL_LOG:MISSED_AUDIO]';
    try {
      const logMsg = await StorageService.sendCallLogMessage(friendId, callLogText);
      setMessages(prev => {
        if (prev.find(m => m.id === logMsg.id)) return prev;
        return [...prev, logMsg];
      });
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 150);
    } catch (e) {
      console.error("Failed to save call log:", e);
    }
  };

  const handleEndCall = async () => {
    Vibration.cancel();
    const finalStatus = callStatus;
    setCallStatus('ended');
    if (activeCallUuid) {
      callKeepManager.endCall(activeCallUuid);
      setActiveCallUuid(null);
    }
    await agoraManager.destroy();
    setRemoteUid(null);

    setTimeout(() => {
      setCallModalVisible(false);
    }, 500);

    await StorageService.sendCallSignal(friendId, '[CALL_SIGNAL:END_CALL]');

    let callLogText = '';
    if (finalStatus === 'ringing') {
      callLogText = callTypeVideo ? '[CALL_LOG:MISSED_VIDEO]' : '[CALL_LOG:MISSED_AUDIO]';
    } else {
      callLogText = callTypeVideo ? '[CALL_LOG:ENDED_VIDEO]' : '[CALL_LOG:ENDED_AUDIO]';
    }

    try {
      const logMsg = await StorageService.sendCallLogMessage(friendId, callLogText);
      setMessages(prev => {
        if (prev.find(m => m.id === logMsg.id)) return prev;
        return [...prev, logMsg];
      });
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 150);
    } catch (e) {
      console.error("Failed to save call log:", e);
    }
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    agoraManager.muteAudio(nextMuted);
  };

  const switchCamera = () => {
    agoraManager.switchCamera();
  };

  const toggleSpeakerMock = () => {
    setIsVideoMuted(prev => !prev);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSend = async () => {
    if (!inputText.trim() || !friend) return;

    const textToSend = inputText.trim();
    setInputText('');

    try {
      // 1. Save and show local message (optimistic UI update)
      const savedMsg = await StorageService.sendMessage(friendId, textToSend);
      setMessages(prev => {
        if (prev.find(m => m.id === savedMsg.id)) return prev;
        return [...prev, savedMsg];
      });
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);

      // 2. Mock replies disabled for live multi-device chat testing.
      // Uncomment this block if you want to chat with simulated friends local-only.
      /*
      setIsTyping(true);
      triggerMockReply(friend, textToSend, (replyMsg) => {
        setIsTyping(false);
        setMessages(prev => [...prev, replyMsg]);
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      });
      */
    } catch (e) {
      console.error("Error sending message", e);
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
      const logType = item.text.replace('[CALL_LOG:', '').replace(']', '');
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

      return (
        <View style={styles.callLogWrapper}>
          <View style={[styles.callLogContainer, { 
            backgroundColor: isMissed 
              ? (isDark ? '#4C1E20' : '#FFEBEE')
              : (isDark ? '#2C1E15' : '#F5F5F5'),
            borderColor: isMissed
              ? (isDark ? '#5C2E30' : '#FFCDD2')
              : (isDark ? '#3D2A1D' : '#E0E0E0')
          }, { paddingHorizontal: s(12), paddingVertical: s(6), gap: s(6) }]}>
            <Ionicons name={logIcon} size={s(16)} color={isMissed ? (isDark ? '#FF8A80' : '#D32F2F') : colors.textSecondary} style={styles.callLogIcon} />
            <Text style={[styles.callLogText, { color: isMissed ? (isDark ? '#FF8A80' : '#D32F2F') : colors.text }, { fontSize: s(12) }]}>
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
      {/* Header matching requested visual specs */}
      <View style={[styles.header, { backgroundColor: colors.cardBg, borderColor: colors.border, paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + s(8) : s(44)) : s(14), paddingHorizontal: s(20), paddingVertical: s(14) }]}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={s(26)} color={colors.text} />
        </TouchableOpacity>
        
        <View style={styles.headerInfo}>
          <Text style={[styles.headerName, { fontSize: s(20), color: colors.text }]}>{friend?.name}</Text>
          {/* CRITICAL: Active now / Active X mins ago is excluded as requested */}
        </View>

        <View style={styles.headerRight}>
          {!callingDisabled && pairingStatus === 'paired' && (
            <TouchableOpacity style={[styles.headerCallBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong }]} onPress={() => handleStartCall(false)}>
              <Ionicons name="call" size={s(20)} color={colors.actionBtnSecondaryText} />
            </TouchableOpacity>
          )}
          {!videoCallingDisabled && pairingStatus === 'paired' && (
            <TouchableOpacity style={[styles.headerCallBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong }]} onPress={() => handleStartCall(true)}>
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
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessageItem}
          style={{ flex: 1 }}
          contentContainerStyle={[styles.messagesList, { padding: s(16), gap: s(12) }]}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          onLayout={() => flatListRef.current?.scrollToEnd({ animated: true })}
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
        onRequestClose={handleEndCall}
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
              {friend?.name}
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
                <TouchableOpacity style={[styles.callControlBtn, styles.declineBtn, { width: s(64), height: s(64), borderRadius: s(32) }]} onPress={handleDeclineCall}>
                  <Ionicons name="close" size={s(32)} color="#FFFFFF" />
                </TouchableOpacity>
                <TouchableOpacity style={[styles.callControlBtn, styles.acceptBtn, { width: s(64), height: s(64), borderRadius: s(32) }]} onPress={handleAcceptCall}>
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
                
                <TouchableOpacity style={[styles.callEndBtn, { width: s(72), height: s(72), borderRadius: s(36) }]} onPress={handleEndCall}>
                  <Ionicons name="close" size={s(32)} color="#FFFFFF" />
                </TouchableOpacity>

                {callTypeVideo ? (
                  <TouchableOpacity 
                    style={[
                      styles.callMuteBtn,
                      styles.videoCallControlBtn,
                      { width: s(56), height: s(56), borderRadius: s(28) }
                    ]} 
                    onPress={switchCamera}
                  >
                    <Ionicons name="camera-reverse" size={s(24)} color="#FFFFFF" />
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
    alignSelf: 'center',
    marginVertical: 4,
    maxWidth: '85%',
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
