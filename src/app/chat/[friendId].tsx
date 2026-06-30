import React, { useState, useEffect, useRef } from 'react';
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
  Keyboard
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, Message, Friend, triggerMockReply } from '@/services/storage';
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

  useEffect(() => {
    loadChat();
  }, [friendId]);

  const loadChat = async () => {
    if (!friendId) return;
    try {
      setLoading(true);
      const friends = await StorageService.getFriends();
      const currentFriend = friends.find(f => f.id === friendId) || null;
      setFriend(currentFriend);

      if (currentFriend) {
        const msgs = await StorageService.getMessages(currentFriend.id);
        setMessages(msgs);
      }
    } catch (e) {
      console.error("Error loading chat", e);
    } finally {
      setLoading(false);
      // Scroll to bottom after load
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() || !friend) return;
    const textToSend = inputText.trim();
    setInputText('');

    try {
      // 1. Save and update UI for user message
      const userMsg = await StorageService.sendMessage(friend.id, textToSend);
      setMessages(prev => [...prev, userMsg]);
      
      // Scroll to bottom
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);

      // 2. Trigger mock reply with a typing indicator delay
      setIsTyping(true);
      
      triggerMockReply(friend, textToSend, (replyMsg) => {
        setIsTyping(false);
        setMessages(prev => [...prev, replyMsg]);
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      });

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

        {/* Dummy spacing element to center name */}
        <View style={{ width: 36 }} />
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
      </KeyboardAvoidingView>
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
});
