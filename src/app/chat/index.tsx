import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, TextInput, SafeAreaView, Platform } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, Friend, KidProfile, Message } from '@/services/storage';
import { registerForPushNotificationsAsync } from '@/services/notifications';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ChatDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // State
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [lastMessages, setLastMessages] = useState<Record<string, Message | null>>({});
  const [pairingStatuses, setPairingStatuses] = useState<Record<string, 'paired' | 'pending'>>({});

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

  useFocusEffect(
    useCallback(() => {
      loadDashboardData();

      const unsubscribe = StorageService.subscribeToMessages((newMsg, friendId) => {
        if (newMsg.text && newMsg.text.startsWith('[CALL_SIGNAL:START_') && newMsg.sender === 'them') {
          const isVideo = newMsg.text.includes('START_VIDEO_CALL');
          const parts = newMsg.text.split(':');
          const roomName = parts[parts.length - 1];
          router.push({
            pathname: `/chat/${friendId}`,
            params: {
              incomingCall: 'true',
              callType: isVideo ? 'video' : 'audio',
              roomName
            }
          });
          return;
        }
        loadDashboardData();
      });

      return () => unsubscribe();
    }, [])
  );

  const loadDashboardData = async () => {
    try {
      // 1. Verify subscription and profile
      const isSub = await StorageService.isSubscribed();
      const kidProf = await StorageService.getKidProfile();

      if (!isSub || !kidProf) {
        router.replace('/');
        return;
      }

      const syncedProf = await StorageService.syncKidProfileAndFriends();
      setProfile(syncedProf || kidProf);
      
      // Async request and register push notification token, always syncing the profile to Supabase
      registerForPushNotificationsAsync().then(async (token) => {
        await StorageService.registerPushToken(token);
        if (!token) {
          console.log("No push token returned. Profile synced without push notifications.");
        }
      }).catch(async (err) => {
        console.error("Push registration failed, syncing profile without push notifications", err);
        await StorageService.registerPushToken(null);
      });

      // 2. Load friends
      const friendsList = await StorageService.getFriends();
      setFriends(friendsList);

      // 3. Load last messages for previews
      const previews: Record<string, Message | null> = {};
      const statuses: Record<string, 'paired' | 'pending'> = {};
      for (const friend of friendsList) {
        const msgs = await StorageService.getMessages(friend.id);
        previews[friend.id] = msgs.length > 0 ? msgs[msgs.length - 1] : null;

        if (syncedProf || kidProf) {
          const kp = syncedProf || kidProf;
          const status = await StorageService.checkFriendPairingStatus(kp.cookieCode, friend.cookieCode);
          statuses[friend.id] = status;
        }
      }
      setLastMessages(previews);
      setPairingStatuses(statuses);

    } catch (e) {
      console.error("Error loading chat dashboard", e);
    }
  };

  const handleLogout = () => {
    showAlert(
      "Log Out?",
      "Are you sure you want to log out of your Cookie Jar?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log Out",
          style: "destructive",
          onPress: async () => {
            await StorageService.logoutKid();
            router.replace('/');
          }
        }
      ]
    );
  };



  const renderFriendItem = ({ item }: { item: Friend }) => {
    const lastMsg = lastMessages[item.id];
    const status = pairingStatuses[item.id] || 'pending';

    const renderLastMsgText = () => {
      if (!lastMsg) return 'Tap to start chatting! 🍪';
      
      if (lastMsg.text.startsWith('[CALL_LOG:')) {
        const logType = lastMsg.text.replace('[CALL_LOG:', '').replace(']', '');
        switch (logType) {
          case 'MISSED_VIDEO':
            return '📹 Missed Video Call';
          case 'MISSED_AUDIO':
            return '📞 Missed Voice Call';
          case 'ENDED_VIDEO':
            return '📹 Video Call Ended';
          case 'ENDED_AUDIO':
          default:
            return '📞 Voice Call Ended';
        }
      }
      
      return `${lastMsg.sender === 'me' ? 'You: ' : ''}${lastMsg.text}`;
    };
    
    return (
      <TouchableOpacity 
        style={styles.friendCard}
        onPress={() => router.push(`/chat/${item.id}`)}
      >
        <View style={styles.avatarContainer}>
          <Text style={styles.avatarText}>{item.avatarEmoji}</Text>
        </View>

        <View style={styles.friendInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.friendName}>{item.name}</Text>
            {status === 'pending' && (
              <View style={styles.pendingBadgeSmall}>
                <Text style={styles.pendingBadgeTextSmall}>Pending</Text>
              </View>
            )}
          </View>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {status === 'pending' 
              ? 'Waiting for parent approval ⏳'
              : renderLastMsgText()}
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={20} color="#D4A373" />
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Custom Header */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + 8 : 44) : 14 }]}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerAvatar}>🍪</Text>
          <View>
            <Text style={styles.headerSub}>{profile?.name}'s</Text>
            <Text style={styles.headerTitle}>Cookie Jar</Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <TouchableOpacity 
            style={styles.logoutButton}
            onPress={handleLogout}
          >
            <Ionicons name="log-out-outline" size={24} color="#D32F2F" />
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.settingsButton}
            onPress={() => router.push('/parent/gate')}
          >
            <Ionicons name="settings" size={24} color="#8D6E63" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Friends List */}
      {friends.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyEmoji}>🧁</Text>
          <Text style={styles.emptyText}>Your cookie jar is empty!</Text>
          <Text style={styles.emptySubtext}>
            Ask your parent to add buddies for you using your Cookie Code: {profile?.cookieCode}
          </Text>
        </View>
      ) : (
        <FlatList
          data={friends}
          keyExtractor={(item) => item.id}
          renderItem={renderFriendItem}
          contentContainerStyle={styles.listContent}
        />
      )}
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
  container: {
    flex: 1,
    backgroundColor: '#FFFDF3',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 2,
    borderColor: '#FFF5D1',
    backgroundColor: '#FFFFFF',
    paddingTop: Platform.OS === 'android' ? 44 : 14,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerAvatar: {
    fontSize: 32,
  },
  headerSub: {
    fontSize: 12,
    color: '#8D6E63',
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#4E342E',
    marginTop: -2,
  },
  settingsButton: {
    padding: 6,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  friendCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#FFF5D1',
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  avatarContainer: {
    backgroundColor: '#FFFDF0',
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
    borderWidth: 2,
    borderColor: '#FFEFC0',
  },
  avatarText: {
    fontSize: 28,
  },
  friendInfo: {
    flex: 1,
  },
  friendName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#4E342E',
    marginBottom: 4,
  },
  lastMessage: {
    fontSize: 14,
    color: '#8D6E63',
    fontWeight: '600',
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    backgroundColor: '#FFC93C',
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#FFC93C',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 4,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyEmoji: {
    fontSize: 72,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#4E342E',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#8D6E63',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    fontWeight: '600',
  },
  addFriendBtnInline: {
    backgroundColor: '#FFC93C',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 16,
  },
  addFriendBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#4E342E',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(78, 52, 46, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 28,
    padding: 24,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 5,
    borderWidth: 2,
    borderColor: '#FFF5D1',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#4E342E',
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#795548',
    lineHeight: 20,
    marginBottom: 20,
    fontWeight: '600',
  },
  label: {
    fontSize: 12,
    fontWeight: '800',
    color: '#8D6E63',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#FFFDF5',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    borderRadius: 16,
    height: 50,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#4E342E',
    fontWeight: '600',
    marginBottom: 16,
  },
  modalSubmit: {
    backgroundColor: '#FFC93C',
    borderRadius: 16,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  modalSubmitText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#4E342E',
  },
  logoutButton: {
    padding: 6,
  },
  pendingBadgeSmall: {
    backgroundColor: '#FFE0B2',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pendingBadgeTextSmall: {
    fontSize: 10,
    color: '#E65100',
    fontWeight: '800',
  },
});
