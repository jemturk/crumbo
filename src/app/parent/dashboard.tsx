import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TextInput, 
  TouchableOpacity, 
  SafeAreaView, 
  ScrollView, 
  Alert, 
  Platform, 
  Modal, 
  Clipboard,
  ActivityIndicator
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, KidProfile } from '@/services/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function ParentDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  
  // State
  const [subscribed, setSubscribed] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [parentEmail, setParentEmail] = useState<string | null>(null);
  const [kidsList, setKidsList] = useState<KidProfile[]>([]);

  // Accordion Toggles
  const [childrenExpanded, setChildrenExpanded] = useState(true);
  const [subscriptionExpanded, setSubscriptionExpanded] = useState(false);
  const [cacheExpanded, setCacheExpanded] = useState(false);

  // Modals
  const [friendsModalVisible, setFriendsModalVisible] = useState(false);
  const [addKidModalVisible, setAddKidModalVisible] = useState(false);
  const [newKidName, setNewKidName] = useState('');
  const [selectedKidForLogs, setSelectedKidForLogs] = useState<KidProfile | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [newFriendName, setNewFriendName] = useState('');
  const [newFriendCode, setNewFriendCode] = useState('');
  const [pairingStatuses, setPairingStatuses] = useState<Record<string, 'paired' | 'pending'>>({});

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (selectedKidForLogs && friendsModalVisible) {
      loadPairingStatuses(selectedKidForLogs);
    }
  }, [selectedKidForLogs, friendsModalVisible]);

  const loadPairingStatuses = async (kid: KidProfile) => {
    if (!kid || !kid.friends) return;
    const statuses: Record<string, 'paired' | 'pending'> = {};
    for (const friend of kid.friends) {
      const status = await StorageService.checkFriendPairingStatus(kid.cookieCode, friend.cookieCode);
      statuses[friend.cookieCode] = status;
    }
    setPairingStatuses(statuses);
  };

  const loadSettings = async () => {
    try {
      const isSub = await StorageService.isSubscribed();
      const pEmail = await StorageService.getParentEmail();
      const kidProf = await StorageService.getKidProfile();
      const list = await StorageService.getKidsList();

      setSubscribed(isSub);
      setParentEmail(pEmail);
      setProfile(kidProf);
      setKidsList(list);

      if (pEmail) {
        setEmailInput(pEmail);
      }
    } catch (e) {
      console.error("Error loading settings", e);
    }
  };

  const handleLogout = () => {
    Alert.alert(
      "Log Out",
      "Are you sure you want to log out of the Parent Area? Your child's active chat session will remain active.",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Log Out", 
          style: "destructive",
          onPress: async () => {
            await StorageService.saveParentEmail('');
            await StorageService.saveParentPassword('');
            setParentEmail(null);
            router.replace('/');
          }
        }
      ]
    );
  };

  const handleSubscribe = async () => {
    const trimmedEmail = emailInput.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      Alert.alert("Invalid Email", "Please enter a valid email address.");
      return;
    }

    try {
      setSyncing(true);
      const restored = await StorageService.fetchAndRestoreParentData(trimmedEmail);
      if (restored) {
        Alert.alert(
          "Welcome Back! 🎉", 
          "We found your existing parent profile. All settings and child data have been restored."
        );
        await loadSettings();
        setSyncing(false);
        return;
      }

      await StorageService.saveParentEmail(trimmedEmail);
      await StorageService.setSubscribed(true);
      setParentEmail(trimmedEmail);
      setSubscribed(true);
      await StorageService.syncParentData();
      setSyncing(false);
      Alert.alert("Subscription Activated!", "Your Crumbo parental control account is active.");
    } catch (e) {
      setSyncing(false);
      Alert.alert("Error", "Could not complete registration.");
    }
  };

  const handleCancelSubscription = async () => {
    Alert.alert(
      "Cancel Subscription?",
      "Your child won't be able to chat anymore. No data will be lost from the device.",
      [
        { text: "Keep Subscription", style: "cancel" },
        { 
          text: "Cancel Subscription", 
          style: "destructive",
          onPress: async () => {
            await StorageService.setSubscribed(false);
            setSubscribed(false);
            Alert.alert("Subscription Cancelled", "Your subscription is now inactive.");
          }
        }
      ]
    );
  };

  const handleAddChildClick = () => {
    setNewKidName('');
    setAddKidModalVisible(true);
  };

  const handleCreateProfile = async () => {
    const name = newKidName.trim();
    if (!name) {
      Alert.alert("Name Required", "Please enter a nickname for the profile.");
      return;
    }

    try {
      setSyncing(true);
      await StorageService.createKidProfile(name);
      setAddKidModalVisible(false);
      await StorageService.syncParentData();
      await loadSettings();
      setSyncing(false);
      Alert.alert("Profile Created!", `Child profile for ${name} has been added.`);
    } catch (e) {
      setSyncing(false);
      Alert.alert("Error", "Could not create child profile.");
    }
  };

  const handleDeleteChild = (cookieCode: string, name: string) => {
    Alert.alert(
      "Delete Profile?",
      `Are you sure you want to delete ${name}'s profile? All local chats, buddies, and pairing codes will be deleted permanently.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Profile",
          style: "destructive",
          onPress: async () => {
            setSyncing(true);
            await StorageService.deleteKidProfile(cookieCode);
            await StorageService.syncParentData();
            await loadSettings();
            setSyncing(false);
            Alert.alert("Deleted", "Profile successfully deleted.");
          }
        }
      ]
    );
  };

  const handleAddFriendToKid = async () => {
    if (!selectedKidForLogs) return;
    const name = newFriendName.trim();
    const code = newFriendCode.trim().toUpperCase();

    if (!name) {
      Alert.alert("Name Required", "Please enter a name for the buddy.");
      return;
    }

    const codePattern = /^CRUM-\d{3}-\d{3}$/;
    if (!codePattern.test(code)) {
      Alert.alert(
        "Invalid Cookie Code", 
        "Cookie Code must match format: CRUM-123-456"
      );
      return;
    }

    if (code === selectedKidForLogs.cookieCode) {
      Alert.alert("Invalid Buddy Code", "A child cannot add themselves as a buddy!");
      return;
    }

    setSyncing(true);
    try {
      await StorageService.addFriendToKidProfile(selectedKidForLogs.cookieCode, name, code);
      // Sync update to Supabase
      await StorageService.syncParentData();
      
      // Reload lists
      const freshKids = await StorageService.getKidsList();
      setKidsList(freshKids);
      const updatedKid = freshKids.find(k => k.cookieCode === selectedKidForLogs.cookieCode) || null;
      setSelectedKidForLogs(updatedKid);

      setNewFriendName('');
      setNewFriendCode('');
      Alert.alert("Success", `${name} added to buddy list!`);
    } catch (e) {
      Alert.alert("Error", "Could not add buddy.");
    } finally {
      setSyncing(false);
    }
  };

  const handleDeleteFriendFromKid = async (friendCookieCode: string, friendName: string) => {
    if (!selectedKidForLogs) return;

    Alert.alert(
      "Remove Buddy?",
      `Are you sure you want to remove ${friendName} from ${selectedKidForLogs.name}'s buddies list?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setSyncing(true);
            try {
              await StorageService.removeFriendFromKidProfile(selectedKidForLogs.cookieCode, friendCookieCode);
              // Sync update to Supabase
              await StorageService.syncParentData();
              
              // Reload lists
              const freshKids = await StorageService.getKidsList();
              setKidsList(freshKids);
              const updatedKid = freshKids.find(k => k.cookieCode === selectedKidForLogs.cookieCode) || null;
              setSelectedKidForLogs(updatedKid);
              Alert.alert("Success", "Buddy removed.");
            } catch (e) {
              Alert.alert("Error", "Could not remove buddy.");
            } finally {
              setSyncing(false);
            }
          }
        }
      ]
    );
  };


  // Lock toggles
  const handleToggleChat = async (kid: KidProfile) => {
    const nextChatDisabled = !kid.chatDisabled;
    let nextCallingDisabled = !!kid.callingDisabled;
    let nextVideoCallingDisabled = !!kid.videoCallingDisabled;

    if (nextChatDisabled) {
      // Disabling chat disables voice and video calls too
      nextCallingDisabled = true;
      nextVideoCallingDisabled = true;
    }

    await StorageService.updateKidSettingsForProfile(kid.cookieCode, {
      chatDisabled: nextChatDisabled,
      callingDisabled: nextCallingDisabled,
      videoCallingDisabled: nextVideoCallingDisabled
    });
    await StorageService.syncParentData().catch(e => console.error(e));
    await loadSettings();
  };

  const handleToggleCalling = async (kid: KidProfile) => {
    const nextCallingDisabled = !kid.callingDisabled;
    let nextChatDisabled = !!kid.chatDisabled;
    let nextVideoCallingDisabled = !!kid.videoCallingDisabled;

    if (nextCallingDisabled) {
      // Disabling voice calls disables video calls too
      nextVideoCallingDisabled = true;
    } else {
      // Enabling voice calls enables chat too
      nextChatDisabled = false;
    }

    await StorageService.updateKidSettingsForProfile(kid.cookieCode, {
      chatDisabled: nextChatDisabled,
      callingDisabled: nextCallingDisabled,
      videoCallingDisabled: nextVideoCallingDisabled
    });
    await StorageService.syncParentData().catch(e => console.error(e));
    await loadSettings();
  };

  const handleToggleVideo = async (kid: KidProfile) => {
    const nextVideoCallingDisabled = !kid.videoCallingDisabled;
    let nextChatDisabled = !!kid.chatDisabled;
    let nextCallingDisabled = !!kid.callingDisabled;

    if (!nextVideoCallingDisabled) {
      // Enabling video calls enables voice calls and chat too
      nextCallingDisabled = false;
      nextChatDisabled = false;
    }

    await StorageService.updateKidSettingsForProfile(kid.cookieCode, {
      chatDisabled: nextChatDisabled,
      callingDisabled: nextCallingDisabled,
      videoCallingDisabled: nextVideoCallingDisabled
    });
    await StorageService.syncParentData().catch(e => console.error(e));
    await loadSettings();
  };

  const copyToClipboard = (code: string) => {
    try {
      Clipboard.setString(code);
      Alert.alert("Copied! 📋", "Pairing code copied to clipboard.");
    } catch (e) {
      Alert.alert("Pairing Code", code);
    }
  };

  const handleResetApp = async () => {
    Alert.alert(
      "Erase All Data?",
      "This will erase ALL local profiles, friends, and messaging histories. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Erase Everything",
          style: "destructive",
          onPress: async () => {
            await StorageService.clearAll();
            setSubscribed(false);
            setParentEmail(null);
            setProfile(null);
            setEmailInput('');
            setKidsList([]);
            Alert.alert("Reset Completed", "All data successfully cleared.");
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header matching exact layout specs */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + 8 : 44) : 16 }]}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={22} color="#D32F2F" />
          <Text style={styles.logoutButtonText}>Log Out</Text>
        </TouchableOpacity>
        
        <Text style={styles.headerTitle}>Parent Area</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* Accordion 1: Managed Children */}
        <View style={styles.card}>
          <TouchableOpacity 
            style={styles.cardHeader} 
            onPress={() => setChildrenExpanded(!childrenExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="people-outline" size={24} color="#D4A373" style={styles.cardIcon} />
              <Text style={styles.cardTitle}>Managed Children</Text>
            </View>
            <Ionicons 
              name={childrenExpanded ? "chevron-up" : "chevron-down"} 
              size={20} 
              color="#A1887F" 
            />
          </TouchableOpacity>

          {childrenExpanded && (
            <View style={styles.cardBody}>
              {kidsList.length > 0 ? (
                kidsList.map((kid) => {
                  return (
                    <View key={kid.cookieCode} style={styles.childContainer}>
                      {/* Name and Delete Row */}
                      <View style={styles.childMetaRow}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Text style={styles.childName}>{kid.name}</Text>
                        </View>
                        <TouchableOpacity style={styles.deleteChildBtn} onPress={() => handleDeleteChild(kid.cookieCode, kid.name)}>
                          <Ionicons name="trash" size={18} color="#D32F2F" />
                        </TouchableOpacity>
                      </View>

                      {/* Pairing Code Pill and QR */}
                      <View style={styles.codeRow}>
                        <TouchableOpacity style={styles.codePill} onPress={() => copyToClipboard(kid.cookieCode)} activeOpacity={0.7}>
                          <Text style={styles.codeText}>{kid.cookieCode}</Text>
                          <Ionicons name="copy-outline" size={14} color="#8D6E63" />
                        </TouchableOpacity>
                        
                        <TouchableOpacity style={styles.qrBtn}>
                          <Ionicons name="qr-code-outline" size={16} color="#8D6E63" />
                        </TouchableOpacity>
                      </View>

                      {/* Locks & Controls Row */}
                      <View style={styles.controlsRow}>
                        <View style={styles.togglesGroup}>
                          {/* Chat Toggle */}
                          <TouchableOpacity 
                            style={[styles.toggleCircle, kid.chatDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleChat(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="chatbubble" size={20} color="#FFFFFF" />
                            {kid.chatDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Voice Call Toggle */}
                          <TouchableOpacity 
                            style={[styles.toggleCircle, kid.callingDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleCalling(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="call" size={20} color="#FFFFFF" />
                            {kid.callingDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Video Call Toggle */}
                          <TouchableOpacity 
                            style={[styles.toggleCircle, kid.videoCallingDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleVideo(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="videocam" size={20} color="#FFFFFF" />
                            {kid.videoCallingDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>
                        </View>

                        {/* Friends and Logs Button */}
                        <TouchableOpacity 
                          style={styles.friendsLogsBtn} 
                          onPress={() => {
                            setSelectedKidForLogs(kid);
                            setFriendsModalVisible(true);
                          }}
                        >
                          <Text style={styles.friendsLogsBtnText}>Friends & Logs</Text>
                          <Ionicons name="chevron-forward" size={14} color="#8D6E63" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })
              ) : (
                <Text style={styles.noChildrenText}>No children paired on this device yet.</Text>
              )}

              {/* Add Child Profile Button */}
              <TouchableOpacity style={styles.addChildBtn} onPress={handleAddChildClick}>
                <Ionicons name="add" size={18} color="#8D6E63" />
                <Text style={styles.addChildBtnText}>Add Child Profile</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Accordion 2: Subscription Settings */}
        <View style={styles.card}>
          <TouchableOpacity 
            style={styles.cardHeader} 
            onPress={() => setSubscriptionExpanded(!subscriptionExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="card-outline" size={24} color="#D4A373" style={styles.cardIcon} />
              <Text style={styles.cardTitle}>Subscription Settings</Text>
            </View>
            <Ionicons 
              name={subscriptionExpanded ? "chevron-up" : "chevron-down"} 
              size={20} 
              color="#A1887F" 
            />
          </TouchableOpacity>

          {subscriptionExpanded && (
            <View style={styles.cardBodyPadding}>
              {!subscribed ? (
                <View>
                  <Text style={styles.infoText}>
                    Crumbo requires a simulation subscription to cover hosting and keep messaging ad-free and tracking-free.
                  </Text>
                  <Text style={styles.inputLabel}>Parent Email Address</Text>
                  <TextInput
                    style={styles.textInput}
                    placeholder="parent@example.com"
                    placeholderTextColor="#A1887F"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    value={emailInput}
                    onChangeText={setEmailInput}
                  />
                  <TouchableOpacity style={styles.actionBtnPrimary} onPress={handleSubscribe} disabled={syncing}>
                    {syncing ? (
                      <ActivityIndicator color="#4E342E" />
                    ) : (
                      <Text style={styles.actionBtnPrimaryText}>Subscribe Now - $4.99/mo</Text>
                    )}
                  </TouchableOpacity>
                </View>
              ) : (
                <View>
                  <View style={styles.activeSubBadge}>
                    <Ionicons name="checkmark-circle" size={18} color="#2E7D32" />
                    <Text style={styles.activeSubText}>Active Subscription</Text>
                  </View>
                  <Text style={styles.inputLabel}>Registered Email</Text>
                  <Text style={styles.emailDisplay}>{parentEmail}</Text>
                  
                  <TouchableOpacity style={styles.actionBtnSecondary} onPress={handleCancelSubscription}>
                    <Text style={styles.actionBtnSecondaryText}>Cancel Subscription</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>

        {/* Accordion 3: Local Device Cache */}
        <View style={styles.card}>
          <TouchableOpacity 
            style={styles.cardHeader} 
            onPress={() => setCacheExpanded(!cacheExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="trash-outline" size={24} color="#D4A373" style={styles.cardIcon} />
              <Text style={styles.cardTitle}>Local Device Cache</Text>
            </View>
            <Ionicons 
              name={cacheExpanded ? "chevron-up" : "chevron-down"} 
              size={20} 
              color="#A1887F" 
            />
          </TouchableOpacity>

          {cacheExpanded && (
            <View style={styles.cardBodyPadding}>
              <Text style={styles.infoText}>
                Erase local cookies, pairing profiles, messaging history, and cached media on this local device. This action cannot be undone.
              </Text>
              <TouchableOpacity style={styles.actionBtnSecondary} onPress={handleResetApp}>
                <Text style={styles.actionBtnSecondaryText}>Erase All Local Data</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Friends & Logs Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={friendsModalVisible}
        onRequestClose={() => setFriendsModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{selectedKidForLogs?.name}'s Buddies</Text>
              <TouchableOpacity onPress={() => setFriendsModalVisible(false)}>
                <Ionicons name="close-circle" size={28} color="#8D6E63" />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.modalScroll} style={{ maxHeight: 220 }}>
              {(!selectedKidForLogs || !selectedKidForLogs.friends || selectedKidForLogs.friends.length === 0) ? (
                <Text style={styles.noFriendsText}>No buddies added yet. Use the form below to connect!</Text>
              ) : (
                selectedKidForLogs.friends.map((friend: any) => {
                  const status = pairingStatuses[friend.cookieCode] || 'pending';
                  return (
                    <View key={friend.id} style={styles.friendRow}>
                      <View style={styles.friendAvatar}>
                        <Text style={styles.friendAvatarEmoji}>{friend.avatarEmoji || '🍪'}</Text>
                      </View>
                      <View style={styles.friendInfo}>
                        <Text style={styles.friendNameText}>{friend.name}</Text>
                        <Text style={styles.friendCodeText}>{friend.cookieCode}</Text>
                      </View>
                      
                      <View style={[styles.statusBadge, status === 'paired' ? styles.statusPaired : styles.statusPending]}>
                        <Text style={styles.statusBadgeText}>
                          {status === 'paired' ? 'Paired' : 'Pending'}
                        </Text>
                      </View>

                      <TouchableOpacity 
                        style={styles.deleteFriendBtn} 
                        onPress={() => handleDeleteFriendFromKid(friend.cookieCode, friend.name)}
                      >
                        <Ionicons name="trash" size={16} color="#D32F2F" />
                      </TouchableOpacity>
                    </View>
                  );
                })
              )}
            </ScrollView>

            {/* Add Buddy Section */}
            <View style={styles.addBuddySection}>
              <Text style={styles.addBuddyTitle}>Add New Buddy</Text>
              
              <TextInput
                style={styles.buddyInput}
                placeholder="Buddy Name (e.g. Sam)"
                placeholderTextColor="#A1887F"
                value={newFriendName}
                onChangeText={setNewFriendName}
              />

              <TextInput
                style={styles.buddyInput}
                placeholder="Buddy Cookie Code (e.g. CRUM-123-456)"
                placeholderTextColor="#A1887F"
                autoCapitalize="characters"
                autoCorrect={false}
                value={newFriendCode}
                onChangeText={setNewFriendCode}
              />

              <TouchableOpacity style={styles.addBuddySubmitBtn} onPress={handleAddFriendToKid} disabled={syncing}>
                {syncing ? (
                  <ActivityIndicator color="#4E342E" />
                ) : (
                  <Text style={styles.addBuddySubmitText}>Add Buddy</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Add Child Nickname Modal */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={addKidModalVisible}
        onRequestClose={() => setAddKidModalVisible(false)}
      >
        <View style={styles.modalOverlayCentered}>
          <View style={styles.modalDialog}>
            <Text style={styles.dialogTitle}>Add Child Profile</Text>
            
            <Text style={styles.dialogLabel}>Enter child's name or nickname:</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="e.g. Cem"
              placeholderTextColor="#A1887F"
              value={newKidName}
              onChangeText={setNewKidName}
              autoFocus={true}
            />

            <View style={styles.dialogButtons}>
              <TouchableOpacity 
                style={styles.dialogBtnCancel} 
                onPress={() => setAddKidModalVisible(false)}
              >
                <Text style={styles.dialogBtnCancelText}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={styles.dialogBtnCreate} 
                onPress={handleCreateProfile}
                disabled={syncing}
              >
                {syncing ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.dialogBtnCreateText}>Create</Text>
                )}
              </TouchableOpacity>
            </View>
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
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: '#FFFDF0',
    backgroundColor: '#FFFFFF',
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  logoutButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#D32F2F',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#4E342E',
  },
  scrollContent: {
    padding: 16,
    gap: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#FFFDF0',
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20,
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardIcon: {
    marginRight: 12,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: '#4E342E',
  },
  cardBody: {
    borderTopWidth: 1,
    borderColor: '#FFFDF0',
    padding: 20,
  },
  cardBodyPadding: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  noChildrenText: {
    fontSize: 14,
    color: '#8D6E63',
    fontWeight: '600',
    textAlign: 'center',
    marginVertical: 16,
  },
  childContainer: {
    backgroundColor: '#FFFDF8',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#FFEFC0',
    padding: 16,
    marginBottom: 16,
  },
  childMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  childName: {
    fontSize: 20,
    fontWeight: '900',
    color: '#4E342E',
  },
  deleteChildBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFEBEE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  codePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFDE7',
    borderWidth: 1,
    borderColor: '#FFD54F',
    borderRadius: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 6,
  },
  codeText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#8D6E63',
  },
  qrBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FFEFC0',
    backgroundColor: '#FFFDF5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  togglesGroup: {
    flexDirection: 'row',
    gap: 10,
  },
  toggleCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  toggleGreenBg: {
    backgroundColor: '#2E7D32',
  },
  toggleRedBg: {
    backgroundColor: '#D32F2F',
  },
  slashOverlay: {
    position: 'absolute',
    width: '75%',
    height: 2,
    backgroundColor: '#FFFFFF',
    transform: [{ rotate: '-45deg' }],
  },
  friendsLogsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFDF5',
    borderWidth: 1,
    borderColor: '#FFEFC0',
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 4,
  },
  friendsLogsBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#8D6E63',
  },
  addChildBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#D4A373',
    borderRadius: 16,
    paddingVertical: 14,
    gap: 6,
    backgroundColor: '#FFFDF5',
  },
  addChildBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#8D6E63',
  },
  infoText: {
    fontSize: 14,
    color: '#795548',
    lineHeight: 20,
    marginBottom: 16,
    fontWeight: '500',
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#8D6E63',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  textInput: {
    backgroundColor: '#FFFDF5',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    borderRadius: 16,
    height: 50,
    paddingHorizontal: 16,
    fontSize: 15,
    color: '#4E342E',
    fontWeight: '600',
    marginBottom: 14,
  },
  actionBtnPrimary: {
    backgroundColor: '#FFC93C',
    borderRadius: 16,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionBtnPrimaryText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#4E342E',
  },
  activeSubBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#E8F5E9',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    alignSelf: 'flex-start',
    marginBottom: 14,
  },
  activeSubText: {
    fontSize: 12,
    color: '#2E7D32',
    fontWeight: '800',
  },
  emailDisplay: {
    fontSize: 16,
    fontWeight: '700',
    color: '#4E342E',
    marginBottom: 18,
  },
  actionBtnSecondary: {
    borderWidth: 1.5,
    borderColor: '#E57373',
    borderRadius: 16,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionBtnSecondaryText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#D32F2F',
  },
  // Modal layout
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(78, 52, 46, 0.4)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '80%',
    padding: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#4E342E',
  },
  modalScroll: {
    gap: 14,
    paddingBottom: 40,
  },
  noFriendsText: {
    fontSize: 14,
    color: '#8D6E63',
    textAlign: 'center',
    lineHeight: 20,
    marginVertical: 32,
    fontWeight: '600',
  },
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFDF8',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#FFEFC0',
    padding: 12,
    gap: 12,
  },
  friendAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  friendAvatarEmoji: {
    fontSize: 24,
  },
  friendInfo: {
    flex: 1,
  },
  friendNameText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#4E342E',
  },
  friendCodeText: {
    fontSize: 12,
    color: '#8D6E63',
    fontWeight: '600',
    marginTop: 2,
  },
  friendLogBadge: {
    backgroundColor: '#E8F5E9',
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  friendLogBadgeText: {
    fontSize: 11,
    color: '#2E7D32',
    fontWeight: '800',
  },
  // Centered Dialog
  modalOverlayCentered: {
    flex: 1,
    backgroundColor: 'rgba(78, 52, 46, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalDialog: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    width: '100%',
    padding: 24,
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 4,
  },
  dialogTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#4E342E',
    marginBottom: 16,
  },
  dialogLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#8D6E63',
    marginBottom: 8,
  },
  dialogInput: {
    backgroundColor: '#FFFDF5',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    borderRadius: 16,
    height: 50,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#4E342E',
    fontWeight: '600',
    marginBottom: 20,
  },
  dialogButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  dialogBtnCancel: {
    flex: 1,
    height: 48,
    borderWidth: 1.5,
    borderColor: '#FFEFC0',
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialogBtnCancelText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#8D6E63',
  },
  dialogBtnCreate: {
    flex: 1,
    height: 48,
    backgroundColor: '#FFC93C',
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialogBtnCreateText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#4E342E',
  },
  activeDeviceBadge: {
    backgroundColor: '#E8F5E9',
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  activeDeviceBadgeText: {
    fontSize: 11,
    color: '#2E7D32',
    fontWeight: '800',
  },
  activateDeviceBtn: {
    backgroundColor: '#FFF8E1',
    borderWidth: 1,
    borderColor: '#FFD54F',
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  activateDeviceBtnText: {
    fontSize: 11,
    color: '#F57F17',
    fontWeight: '800',
  },
  statusBadge: {
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  statusPaired: {
    backgroundColor: '#E8F5E9',
  },
  statusPending: {
    backgroundColor: '#FFF3E0',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#37474F',
  },
  deleteFriendBtn: {
    padding: 6,
    marginLeft: 4,
  },
  addBuddySection: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#FFEFC0',
    paddingTop: 16,
  },
  addBuddyTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#4E342E',
    marginBottom: 12,
  },
  buddyInput: {
    backgroundColor: '#FFFDF5',
    borderWidth: 1.5,
    borderColor: '#FFEFC0',
    borderRadius: 12,
    height: 44,
    paddingHorizontal: 12,
    fontSize: 14,
    color: '#4E342E',
    fontWeight: '600',
    marginBottom: 10,
  },
  addBuddySubmitBtn: {
    backgroundColor: '#FFC93C',
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  addBuddySubmitText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#4E342E',
  },
});
