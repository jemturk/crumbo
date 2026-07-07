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
  Modal
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, Message, Friend, KidProfile, triggerMockReply } from '@/services/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ChatScreen() {
  const router = useRouter();
  const { friendId } = useLocalSearchParams<{ friendId: string }>();
  const insets = useSafeAreaInsets();

  // State
  const [friend, setFriend] = useState<Friend | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Parental Locks State
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [chatDisabled, setChatDisabled] = useState(false);
  const [callingDisabled, setCallingDisabled] = useState(false);
  const [videoCallingDisabled, setVideoCallingDisabled] = useState(false);
  const [pairingStatus, setPairingStatus] = useState<'paired' | 'pending'>('paired');

  // Call simulation states
  const [callModalVisible, setCallModalVisible] = useState(false);
  const [callTypeVideo, setCallTypeVideo] = useState(false);
  const [callStatus, setCallStatus] = useState<'ringing' | 'connected' | 'ended'>('ringing');
  const [callDuration, setCallDuration] = useState(0);

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

  useEffect(() => {
    // Subscribe to realtime database updates
    const unsubscribe = StorageService.subscribeToMessages((newMsg, msgFriendId) => {
      if (msgFriendId === friendId) {
        setMessages(prev => {
          if (prev.find(m => m.id === newMsg.id)) return prev;
          return [...prev, newMsg];
        });
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      }
    });

    return () => {
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

  const handleStartCall = (isVideo: boolean) => {
    setCallTypeVideo(isVideo);
    setCallStatus('ringing');
    setCallModalVisible(true);

    // Simulated accept after 3 seconds
    setTimeout(() => {
      setCallStatus('connected');
    }, 3000);
  };

  const handleEndCall = async () => {
    const finalStatus = callStatus;
    setCallStatus('ended');
    setTimeout(() => {
      setCallModalVisible(false);
    }, 500);

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
          <View style={[styles.callLogContainer, isMissed ? styles.callLogMissed : styles.callLogEnded]}>
            <Ionicons name={logIcon} size={16} color={isMissed ? '#D32F2F' : '#8D6E63'} style={styles.callLogIcon} />
            <Text style={[styles.callLogText, isMissed && styles.callLogTextMissed]}>
              {logTitle}
            </Text>
            <Text style={styles.callLogTime}>{formatTime(item.timestamp)}</Text>
          </View>
        </View>
      );
    }

    const isMe = item.sender === 'me';
    return (
      <View style={[styles.messageRow, isMe ? styles.myRow : styles.theirRow]}>
        <View style={[styles.bubble, isMe ? styles.myBubble : styles.theirBubble]}>
          <Text style={styles.messageText}>{item.text}</Text>
        </View>
        <Text style={[styles.timestamp, isMe ? styles.myTimestamp : styles.theirTimestamp]}>
          {formatTime(item.timestamp)}
        </Text>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#FFC93C" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header matching requested visual specs */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + 8 : 44) : 14 }]}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={26} color="#4E342E" />
        </TouchableOpacity>
        
        <View style={styles.headerInfo}>
          <Text style={styles.headerName}>{friend?.name}</Text>
          {/* CRITICAL: Active now / Active X mins ago is excluded as requested */}
        </View>

        <View style={styles.headerRight}>
          {!callingDisabled && pairingStatus === 'paired' && (
            <TouchableOpacity style={styles.headerCallBtn} onPress={() => handleStartCall(false)}>
              <Ionicons name="call" size={20} color="#8D6E63" />
            </TouchableOpacity>
          )}
          {!videoCallingDisabled && pairingStatus === 'paired' && (
            <TouchableOpacity style={styles.headerCallBtn} onPress={() => handleStartCall(true)}>
              <Ionicons name="videocam" size={20} color="#8D6E63" />
            </TouchableOpacity>
          )}
          {(callingDisabled || pairingStatus === 'pending') && (videoCallingDisabled || pairingStatus === 'pending') && (
            <View style={{ width: 36 }} />
          )}
        </View>
      </View>

      {/* Keyboard Avoiding Container */}
      <KeyboardAvoidingView 
        style={[styles.keyboardContainer, Platform.OS === 'android' && { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 24 : 0 }]}
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
          contentContainerStyle={styles.messagesList}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          onLayout={() => flatListRef.current?.scrollToEnd({ animated: true })}
        />

        {/* Typing indicator */}
        {isTyping && (
          <View style={styles.typingContainer}>
            <Text style={styles.typingText}>{friend?.name} is typing...</Text>
          </View>
        )}

        {/* Bottom Input Area */}
        {/* Bottom Input Area */}
        {chatDisabled ? (
          <View style={[styles.disabledInputArea, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + 16 : 16) : 16 }]}>
            <Ionicons name="lock-closed" size={20} color="#8D6E63" />
            <Text style={styles.disabledInputText}>Chatting is paused by your parent 🍪</Text>
          </View>
        ) : pairingStatus === 'pending' ? (
          <View style={[styles.pendingInputArea, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + 16 : 16) : 16 }]}>
            <Ionicons name="alert-circle" size={20} color="#E65100" />
            <Text style={styles.pendingInputText}>
              Waiting for parent approval. Tell friend's parent your Cookie Code: {profile?.cookieCode}
            </Text>
          </View>
        ) : (
          <View style={[styles.inputArea, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + 12 : 12) : 12 }]}>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.textInput}
                placeholder="Write something..."
                placeholderTextColor="#A1887F"
                value={inputText}
                onChangeText={setInputText}
                onSubmitEditing={handleSend}
                multiline={false}
              />
            </View>
            <TouchableOpacity 
              style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]} 
              onPress={handleSend}
              disabled={!inputText.trim()}
            >
              <Ionicons name="paper-plane" size={20} color="#4E342E" />
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>

      {/* Calling Simulation Modal */}
      <Modal
        animationType="fade"
        transparent={false}
        visible={callModalVisible}
        onRequestClose={handleEndCall}
      >
        <SafeAreaView style={[styles.callModalContainer, callTypeVideo ? styles.callVideoBg : styles.callAudioBg]}>
          <View style={styles.callContent}>
            <Text style={styles.callLabel}>
              {callTypeVideo ? '📹 VIDEO CALL' : '📞 CRUMBO VOICE CALL'}
            </Text>
            
            <View style={styles.avatarContainerLarge}>
              <Text style={styles.avatarEmojiLarge}>{friend?.avatarEmoji || '🍪'}</Text>
            </View>

            <Text style={styles.callFriendName}>{friend?.name}</Text>
            
            <Text style={styles.callStatusText}>
              {callStatus === 'ringing' && 'Ringing...'}
              {callStatus === 'connected' && formatDuration(callDuration)}
              {callStatus === 'ended' && 'Call Ended'}
            </Text>
          </View>

          {/* Controls */}
          <View style={styles.callControlsRow}>
            <TouchableOpacity style={styles.callMuteBtn}>
              <Ionicons name="mic" size={24} color="#4E342E" />
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.callEndBtn} onPress={handleEndCall}>
              <Ionicons name="close" size={28} color="#FFFFFF" />
            </TouchableOpacity>

            <TouchableOpacity style={styles.callMuteBtn}>
              <Ionicons name={callTypeVideo ? "videocam" : "volume-high"} size={24} color="#4E342E" />
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
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
    paddingVertical: 40,
  },
  callVideoBg: {
    backgroundColor: '#E1F5FE', // Soft video calling blue
  },
  callAudioBg: {
    backgroundColor: '#FFFDE7', // Soft warm audio calling yellow
  },
  callContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
    width: '100%',
  },
  callLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#8D6E63',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  avatarContainerLarge: {
    width: 140,
    height: 140,
    borderRadius: 70,
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
  callFriendName: {
    fontSize: 32,
    fontWeight: '900',
    color: '#4E342E',
  },
  callStatusText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#8D6E63',
  },
  callControlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 28,
    marginBottom: 40,
  },
  callMuteBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  callEndBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
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
});
