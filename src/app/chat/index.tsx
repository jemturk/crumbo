import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, TextInput, SafeAreaView, Alert, Platform } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, Friend, KidProfile, Message } from '@/services/storage';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ChatDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // State
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [lastMessages, setLastMessages] = useState<Record<string, Message | null>>({});
  const [modalVisible, setModalVisible] = useState(false);
  const [friendName, setFriendName] = useState('');
  const [friendCode, setFriendCode] = useState('');

  useFocusEffect(
    useCallback(() => {
      loadDashboardData();
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

      setProfile(kidProf);

      // 2. Load friends
      const friendsList = await StorageService.getFriends();
      setFriends(friendsList);

      // 3. Load last messages for previews
      const previews: Record<string, Message | null> = {};
      for (const friend of friendsList) {
        const msgs = await StorageService.getMessages(friend.id);
        previews[friend.id] = msgs.length > 0 ? msgs[msgs.length - 1] : null;
      }
      setLastMessages(previews);

    } catch (e) {
      console.error("Error loading chat dashboard", e);
    }
  };

  const handleAddFriend = async () => {
    const name = friendName.trim();
    const code = friendCode.trim().toUpperCase();

    if (!name) {
      Alert.alert("Friend's Name", "Please enter your friend's name.");
      return;
    }

    // Basic format validation for CRUM-XXX-XXX
    const codePattern = /^CRUM-\d{3}-\d{3}$/;
    if (!codePattern.test(code)) {
      Alert.alert(
        "Invalid Cookie Code", 
        "Code should look like CRUM-123-456. Ask your friend for their code!"
      );
      return;
    }

    try {
      const added = await StorageService.addFriend(name, code);
      setModalVisible(false);
      setFriendName('');
      setFriendCode('');
      
      // Seed first hello message from the added friend
      await StorageService.receiveMockMessage(
        added.id, 
        `Hey ${profile?.name}! I just added you on Crumbo! 🍪`
      );
      
      await loadDashboardData();
      Alert.alert("Added Friend!", `${name} has been added to your cookie jar!`);
    } catch (e) {
      Alert.alert("Error", "Could not add friend.");
    }
  };

  const renderFriendItem = ({ item }: { item: Friend }) => {
    const lastMsg = lastMessages[item.id];
    
    return (
      <TouchableOpacity 
        style={styles.friendCard}
        onPress={() => router.push(`/chat/${item.id}`)}
      >
        <View style={styles.avatarContainer}>
          <Text style={styles.avatarText}>{item.avatarEmoji}</Text>
        </View>

        <View style={styles.friendInfo}>
          <Text style={styles.friendName}>{item.name}</Text>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {lastMsg 
              ? `${lastMsg.sender === 'me' ? 'You: ' : ''}${lastMsg.text}`
              : 'Tap to start chatting! 🍪'}
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

        <TouchableOpacity 
          style={styles.settingsButton}
          onPress={() => router.push('/parent/gate')}
        >
          <Ionicons name="settings" size={24} color="#8D6E63" />
        </TouchableOpacity>
      </View>

      {/* Friends List */}
      {friends.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyEmoji}>🧁</Text>
          <Text style={styles.emptyText}>Your cookie jar is empty!</Text>
          <Text style={styles.emptySubtext}>
            Add a friend using their Cookie Code to start chatting.
          </Text>
          <TouchableOpacity 
            style={styles.addFriendBtnInline}
            onPress={() => setModalVisible(true)}
          >
            <Text style={styles.addFriendBtnText}>Add a Friend</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={friends}
          keyExtractor={(item) => item.id}
          renderItem={renderFriendItem}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* Floating Add Friend Button */}
      {friends.length > 0 && (
        <TouchableOpacity 
          style={styles.fab}
          onPress={() => setModalVisible(true)}
        >
          <Ionicons name="add" size={32} color="#4E342E" />
        </TouchableOpacity>
      )}

      {/* Add Friend Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add a Friend 🍪</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close-circle" size={28} color="#8D6E63" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubtitle}>
              Ask your friend for their name and code, then type it below!
            </Text>

            {/* Inputs */}
            <Text style={styles.label}>Friend's Name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Alex"
              placeholderTextColor="#A1887F"
              value={friendName}
              onChangeText={setFriendName}
            />

            <Text style={styles.label}>Friend's Cookie Code</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. CRUM-123-456"
              placeholderTextColor="#A1887F"
              autoCapitalize="characters"
              autoCorrect={false}
              value={friendCode}
              onChangeText={setFriendCode}
            />

            {/* Submit */}
            <TouchableOpacity style={styles.modalSubmit} onPress={handleAddFriend}>
              <Text style={styles.modalSubmitText}>Add to Jar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
});
