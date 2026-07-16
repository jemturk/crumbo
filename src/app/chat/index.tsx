import AppSettingsModal from '@/components/AppSettingsModal';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { callKeepManager } from '@/services/callkeep';
import { registerForPushNotificationsAsync } from '@/services/notifications';
import { Friend, KidProfile, Message, StorageService } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Platform, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ChatDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();

  // State
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [lastMessages, setLastMessages] = useState<Record<string, Message | null>>({});
  const [pairingStatuses, setPairingStatuses] = useState<Record<string, 'paired' | 'pending'>>({});
  const [settingsVisible, setSettingsVisible] = useState(false);

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

      // Chat messages only now (call signals travel on their own channel), so any new
      // message just refreshes the dashboard previews.
      const unsubscribe = StorageService.subscribeToMessages(() => {
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

      // One-time-per-launch nudge toward the OS settings that make incoming calls reliable
      // (full-screen lock-screen bypass, battery-optimization exemption).
      callKeepManager.promptForReliableCallsIfNeeded();

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
        style={[styles.friendCard, { backgroundColor: colors.cardBg, borderColor: colors.border, padding: s(16), shadowColor: colors.textSecondary }]}
        onPress={() => router.push(`/chat/${item.id}`)}
      >
        <View style={[styles.avatarContainer, { backgroundColor: isDark ? colors.inputBg : '#FFFDF0', borderColor: colors.borderStrong, width: s(52), height: s(52), borderRadius: s(26), marginRight: s(16) }]}>
          <Text style={[styles.avatarText, { fontSize: s(28) }]}>{item.avatarEmoji}</Text>
        </View>

        <View style={styles.friendInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(6) }}>
            <Text style={[styles.friendName, { fontSize: s(18), color: colors.text }]}>{item.name}</Text>
            {status === 'pending' && (
              <View style={[styles.pendingBadgeSmall, { paddingHorizontal: s(6), paddingVertical: s(2) }]}>
                <Text style={[styles.pendingBadgeTextSmall, { fontSize: s(10) }]}>Pending</Text>
              </View>
            )}
          </View>
          <Text style={[styles.lastMessage, { fontSize: s(14), color: colors.textSecondary }]} numberOfLines={1}>
            {status === 'pending' 
              ? 'Waiting for parent approval ⏳'
              : renderLastMsgText()}
          </Text>
        </View>

        <Ionicons name="chevron-forward" size={s(20)} color={colors.textSecondary} />
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Custom Header */}
      <View style={[styles.header, { backgroundColor: colors.cardBg, borderColor: colors.border, paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + s(8) : s(44)) : s(14), paddingHorizontal: s(20), paddingVertical: s(14), borderBottomWidth: 2 }]}>
        <View style={styles.headerLeft}>
          <Text style={[styles.headerAvatar, { fontSize: s(32) }]}>🍪</Text>
          <View>
            <Text style={[styles.headerSub, { fontSize: s(12), color: colors.textSecondary }]}>{profile?.name}'s</Text>
            <Text style={[styles.headerTitle, { fontSize: s(20), color: colors.text }]}>Cookie Jar</Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12) }}>
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={() => setSettingsVisible(true)}
          >
            <Ionicons name="settings" size={s(24)} color={colors.textSecondary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.logoutButton}
            onPress={handleLogout}
          >
            <Ionicons name="log-out-outline" size={s(24)} color="#D32F2F" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Friends List */}
      {friends.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyEmoji, { fontSize: s(72) }]}>🧁</Text>
          <Text style={[styles.emptyText, { fontSize: s(22), color: colors.text }]}>Your cookie jar is empty!</Text>
          <Text style={[styles.emptySubtext, { fontSize: s(14), lineHeight: s(20), color: colors.textSecondary }]}>
            Ask your parent to add buddies for you using your Cookie Code: {profile?.cookieCode}
          </Text>
        </View>
      ) : (
        <FlatList
          data={friends}
          keyExtractor={(item) => item.id}
          renderItem={renderFriendItem}
          contentContainerStyle={[styles.listContent, { padding: s(16), gap: s(12) }]}
        />
      )}
      <CustomAlertModal
        visible={alertConfig.visible}
        title={alertConfig.title}
        message={alertConfig.message}
        buttons={alertConfig.buttons}
        onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
      />
      <AppSettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        showParentControlsOption={true}
        onParentControlsPress={() => router.push('/parent/gate')}
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
