import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Platform,
  Modal,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, KidProfile } from '@/services/storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useSettings } from '@/context/settings-context';

export default function ParentDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();
  const { displaySize, theme: appTheme, changeDisplaySize, changeTheme } = useSettings();
  
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

  // State
  const [subscribed, setSubscribed] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [parentEmail, setParentEmail] = useState<string | null>(null);
  const [kidsList, setKidsList] = useState<KidProfile[]>([]);

  // Accordion Toggles
  const [childrenExpanded, setChildrenExpanded] = useState(true);
  const [subscriptionExpanded, setSubscriptionExpanded] = useState(false);
  const [appSettingsExpanded, setAppSettingsExpanded] = useState(false);
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

  // QR Code Pairing State
  const [permission, requestPermission] = useCameraPermissions();
  const [qrScannerVisible, setQrScannerVisible] = useState(false);
  const [qrCodeVisible, setQrCodeVisible] = useState(false);

  const handleStartQRScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        showAlert("Permission Required", "Camera access is needed to scan QR codes.");
        return;
      }
    }
    setQrScannerVisible(true);
  };

  // Chat Logs State
  const [selectedBuddyForLogs, setSelectedBuddyForLogs] = useState<any | null>(null);
  const [chatLogs, setChatLogs] = useState<any[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (selectedKidForLogs && friendsModalVisible) {
      loadPairingStatuses(selectedKidForLogs);
    } else {
      setSelectedBuddyForLogs(null);
      setChatLogs([]);
    }
  }, [selectedKidForLogs, friendsModalVisible]);

  const loadChatLogs = async (buddy: any) => {
    if (!selectedKidForLogs) return;
    setLoadingLogs(true);
    setSelectedBuddyForLogs(buddy);
    try {
      const logs = await StorageService.getChatLogsForParent(
        selectedKidForLogs.cookieCode,
        buddy.cookieCode
      );
      setChatLogs(logs);
    } catch (e) {
      console.error("Error loading chat logs", e);
    } finally {
      setLoadingLogs(false);
    }
  };

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

  const handleUpdateDisplaySize = async (size: 'small' | 'default' | 'large') => {
    try {
      await changeDisplaySize(size);
    } catch (e) {
      console.error("Failed to save display size:", e);
    }
  };

  const handleUpdateTheme = async (newTheme: 'light' | 'dark') => {
    try {
      await changeTheme(newTheme);
    } catch (e) {
      console.error("Failed to save theme:", e);
    }
  };

  const handleLogout = () => {
    showAlert(
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
      showAlert("Invalid Email", "Please enter a valid email address.");
      return;
    }

    try {
      setSyncing(true);
      const restored = await StorageService.fetchAndRestoreParentData(trimmedEmail);
      if (restored) {
        showAlert(
          "Welcome Back! 🎉", 
          "We found your existing parent profile. All settings and child data have been restored.",
          [
            { text: "OK", onPress: async () => { await loadSettings(); } }
          ]
        );
        setSyncing(false);
        return;
      }

      await StorageService.saveParentEmail(trimmedEmail);
      await StorageService.setSubscribed(true);
      setParentEmail(trimmedEmail);
      setSubscribed(true);
      await StorageService.syncParentData();
      setSyncing(false);
      showAlert("Subscription Activated!", "Your Crumbo parental control account is active.");
    } catch (e) {
      setSyncing(false);
      showAlert("Error", "Could not complete registration.");
    }
  };

  const handleCancelSubscription = async () => {
    showAlert(
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
            showAlert("Subscription Cancelled", "Your subscription is now inactive.");
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
      showAlert("Name Required", "Please enter a nickname for the profile.");
      return;
    }

    try {
      setSyncing(true);
      await StorageService.createKidProfile(name);
      setAddKidModalVisible(false);
      await StorageService.syncParentData();
      await loadSettings();
      setSyncing(false);
      showAlert("Profile Created!", `Child profile for ${name} has been added.`);
    } catch (e) {
      setSyncing(false);
      showAlert("Error", "Could not create child profile.");
    }
  };

  const handleDeleteChild = (cookieCode: string, name: string) => {
    showAlert(
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
            showAlert("Deleted", "Profile successfully deleted.");
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
      showAlert("Name Required", "Please enter a name for the buddy.");
      return;
    }

    const codePattern = /^CRUM-\d{3}-\d{3}$/;
    if (!codePattern.test(code)) {
      showAlert(
        "Invalid Cookie Code", 
        "Cookie Code must match format: CRUM-123-456"
      );
      return;
    }

    if (code === selectedKidForLogs.cookieCode) {
      showAlert("Invalid Buddy Code", "A child cannot add themselves as a buddy!");
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
      showAlert("Success", `${name} added to buddy list!`);
    } catch (e) {
      showAlert("Error", "Could not add buddy.");
    } finally {
      setSyncing(false);
    }
  };

  const handleDeleteFriendFromKid = async (friendCookieCode: string, friendName: string) => {
    if (!selectedKidForLogs) return;

    showAlert(
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
              showAlert("Success", "Buddy removed.");
            } catch (e) {
              showAlert("Error", "Could not remove buddy.");
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

  const copyToClipboard = async (code: string) => {
    try {
      await Clipboard.setStringAsync(code);
    } catch (e) {
      showAlert("Pairing Code", code);
    }
  };

  const handleResetApp = async () => {
    showAlert(
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
            showAlert("Reset Completed", "All data successfully cleared.");
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header matching exact layout specs */}
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.cardBg, paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + s(8) : s(44)) : s(16), paddingHorizontal: s(16), borderBottomWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
        <Text style={[styles.headerTitle, { color: colors.text, fontSize: s(18) }]}>Parent Area</Text>

        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={s(22)} color="#D32F2F" />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={[styles.scrollContent, { padding: s(16), gap: s(16) }]}>
        
        {/* Accordion 1: Managed Children */}
        <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, borderRadius: s(24) }]}>
          <TouchableOpacity 
            style={[styles.cardHeader, { paddingHorizontal: s(16), paddingVertical: s(14) }]} 
            onPress={() => setChildrenExpanded(!childrenExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="people-outline" size={s(24)} color={colors.cardHeaderLeftIcon} style={styles.cardIcon} />
              <Text style={[styles.cardTitle, { color: colors.text, fontSize: s(16) }]}>Managed Children</Text>
            </View>
            <Ionicons 
              name={childrenExpanded ? "chevron-up" : "chevron-down"} 
              size={s(20)} 
              color="#A1887F" 
            />
          </TouchableOpacity>

          {childrenExpanded && (
            <View style={[styles.cardBody, { borderTopColor: colors.border }]}>
              {kidsList.length > 0 ? (
                kidsList.map((kid) => {
                  return (
                    <View key={kid.cookieCode} style={[styles.childContainer, { borderColor: colors.border, padding: s(16), borderRadius: s(20), backgroundColor: isDark ? colors.inputBg : '#FFFDF8' }]}>
                      {/* Name and Delete Row */}
                      <View style={styles.childMetaRow}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8) }}>
                          <Text style={[styles.childName, { color: colors.text, fontSize: s(18) }]}>{kid.name}</Text>
                        </View>
                        <TouchableOpacity style={styles.deleteChildBtn} onPress={() => handleDeleteChild(kid.cookieCode, kid.name)}>
                          <Ionicons name="trash" size={s(18)} color="#D32F2F" />
                        </TouchableOpacity>
                      </View>

                      {/* Pairing Code Pill and QR */}
                      <View style={styles.codeRow}>
                        <TouchableOpacity style={[styles.codePill, { backgroundColor: isDark ? '#3D2A1D' : '#FFF5D1', paddingHorizontal: s(12), paddingVertical: s(6), borderRadius: s(12) }]} onPress={() => copyToClipboard(kid.cookieCode)} activeOpacity={0.7}>
                          <Text style={[styles.codeText, { color: colors.textSecondary, fontSize: s(13) }]}>{kid.cookieCode}</Text>
                          <Ionicons name="copy-outline" size={s(14)} color="#8D6E63" />
                        </TouchableOpacity>
                        
                        <TouchableOpacity style={[styles.qrBtn, { width: s(36), height: s(36), borderRadius: s(18), backgroundColor: isDark ? '#3D2A1D' : '#FFFDF5' }]} onPress={() => { setSelectedKidForLogs(kid); setQrCodeVisible(true); }}>
                          <Ionicons name="qr-code-outline" size={s(16)} color="#8D6E63" />
                        </TouchableOpacity>
                      </View>

                      {/* Locks & Controls Row */}
                      <View style={styles.controlsRow}>
                        <View style={styles.togglesGroup}>
                          {/* Chat Toggle */}
                          <TouchableOpacity 
                            style={[styles.toggleCircle, { width: s(40), height: s(40), borderRadius: s(20) }, kid.chatDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleChat(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="chatbubble" size={s(20)} color="#FFFFFF" />
                            {kid.chatDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Voice Call Toggle */}
                          <TouchableOpacity 
                            style={[styles.toggleCircle, { width: s(40), height: s(40), borderRadius: s(20) }, kid.callingDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleCalling(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="call" size={s(20)} color="#FFFFFF" />
                            {kid.callingDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Video Call Toggle */}
                          <TouchableOpacity 
                            style={[styles.toggleCircle, { width: s(40), height: s(40), borderRadius: s(20) }, kid.videoCallingDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleVideo(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="videocam" size={s(20)} color="#FFFFFF" />
                            {kid.videoCallingDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>
                        </View>

                        {/* Friends and Logs Button */}
                        <TouchableOpacity 
                          style={[styles.friendsLogsBtn, { height: s(40), borderRadius: s(12), paddingHorizontal: s(16), backgroundColor: isDark ? '#3D2A1D' : '#FFFDF5', borderColor: colors.border }]} 
                          onPress={() => {
                            setSelectedKidForLogs(kid);
                            setFriendsModalVisible(true);
                          }}
                        >
                          <Text style={[styles.friendsLogsBtnText, { color: colors.textSecondary, fontSize: s(13) }]}>Friends & Logs</Text>
                          <Ionicons name="chevron-forward" size={s(14)} color="#8D6E63" />
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })
              ) : (
                <Text style={[styles.noChildrenText, { color: colors.textSecondary, fontSize: s(14) }]}>No children paired on this device yet.</Text>
              )}

              {/* Add Child Profile Button */}
              <TouchableOpacity style={[styles.addChildBtn, { height: s(50), borderRadius: s(16), borderColor: colors.border, marginTop: s(8) }]} onPress={handleAddChildClick}>
                <Ionicons name="add" size={s(18)} color="#8D6E63" />
                <Text style={[styles.addChildBtnText, { color: colors.textSecondary, fontSize: s(14) }]}>Add Child Profile</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Accordion 2: Subscription Settings */}
        <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, borderRadius: s(24) }]}>
          <TouchableOpacity 
            style={[styles.cardHeader, { paddingHorizontal: s(16), paddingVertical: s(14) }]} 
            onPress={() => setSubscriptionExpanded(!subscriptionExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="card-outline" size={s(24)} color={colors.cardHeaderLeftIcon} style={styles.cardIcon} />
              <Text style={[styles.cardTitle, { color: colors.text, fontSize: s(16) }]}>Subscription Settings</Text>
            </View>
            <Ionicons 
              name={subscriptionExpanded ? "chevron-up" : "chevron-down"} 
              size={s(20)} 
              color="#A1887F" 
            />
          </TouchableOpacity>

          {subscriptionExpanded && (
            <View style={styles.cardBodyPadding}>
              {!subscribed ? (
                <View>
                  <Text style={[styles.infoText, { color: colors.textSecondary, fontSize: s(13), lineHeight: s(18) }]}>
                    Crumbo requires a simulation subscription to cover hosting and keep messaging ad-free and tracking-free.
                  </Text>
                  <Text style={[styles.inputLabel, { color: colors.text, fontSize: s(13) }]}>Parent Email Address</Text>
                  <TextInput
                    style={[styles.textInput, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, fontSize: s(14), height: s(48), borderRadius: s(14), paddingHorizontal: s(14) }]}
                    placeholder="parent@example.com"
                    placeholderTextColor="#A1887F"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    value={emailInput}
                    onChangeText={setEmailInput}
                  />
                  <TouchableOpacity style={[styles.actionBtnPrimary, { backgroundColor: colors.primaryBtn, height: s(48), borderRadius: s(14) }]} onPress={handleSubscribe} disabled={syncing}>
                    {syncing ? (
                      <ActivityIndicator color="#4E342E" />
                    ) : (
                      <Text style={[styles.actionBtnPrimaryText, { color: colors.primaryBtnText, fontSize: s(14) }]}>Subscribe Now - $4.99/mo</Text>
                    )}
                  </TouchableOpacity>
                </View>
              ) : (
                <View>
                  <View style={[styles.activeSubBadge, { backgroundColor: isDark ? '#1B5E20' : '#E8F5E9', padding: s(12), borderRadius: s(12) }]}>
                    <Ionicons name="checkmark-circle" size={s(18)} color={colors.successText} />
                    <Text style={[styles.activeSubText, { color: colors.successText, fontSize: s(14) }]}>Active Subscription</Text>
                  </View>
                  <Text style={[styles.inputLabel, { color: colors.text, fontSize: s(13) }]}>Registered Email</Text>
                  <Text style={[styles.emailDisplay, { color: colors.text, fontSize: s(15) }]}>{parentEmail}</Text>
                  
                  <TouchableOpacity style={[styles.actionBtnSecondary, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.border, height: s(48), borderRadius: s(14) }]} onPress={handleCancelSubscription}>
                    <Text style={[styles.actionBtnSecondaryText, { color: colors.actionBtnSecondaryText, fontSize: s(14) }]}>Cancel Subscription</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>

        {/* Accordion 3: App Settings */}
        <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, borderRadius: s(24) }]}>
          <TouchableOpacity 
            style={[styles.cardHeader, { paddingHorizontal: s(16), paddingVertical: s(14) }]} 
            onPress={() => setAppSettingsExpanded(!appSettingsExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="settings-outline" size={s(24)} color={colors.cardHeaderLeftIcon} style={styles.cardIcon} />
              <Text style={[styles.cardTitle, { color: colors.text, fontSize: s(16) }]}>App Settings</Text>
            </View>
            <Ionicons 
              name={appSettingsExpanded ? "chevron-up" : "chevron-down"} 
              size={s(20)} 
              color="#A1887F" 
            />
          </TouchableOpacity>

          {appSettingsExpanded && (
            <View style={styles.cardBodyPadding}>
              <Text style={[styles.infoText, { color: colors.textSecondary, fontSize: s(13), lineHeight: s(18) }]}>
                Customize display settings for Crumbo kid's interfaces on this device.
              </Text>
              
              <Text style={[styles.inputLabel, { color: colors.text, fontSize: s(13), marginTop: s(8) }]}>Display Size</Text>
              <View style={[styles.settingsRow, { gap: s(8) }]}>
                {(['small', 'default', 'large'] as const).map((size) => (
                  <TouchableOpacity 
                    key={size}
                    style={[
                      styles.settingsBtn, 
                      { height: s(48), borderRadius: s(16), borderColor: colors.borderStrong, backgroundColor: colors.cardBg },
                      displaySize === size && { backgroundColor: colors.primaryBtn, borderColor: colors.primaryBtn }
                    ]}
                    onPress={() => handleUpdateDisplaySize(size)}
                  >
                    <Text style={[
                      styles.settingsBtnText, 
                      { color: colors.textSecondary, fontSize: s(14), fontWeight: '800' },
                      displaySize === size && { color: colors.primaryBtnText }
                    ]}>
                      {size.charAt(0).toUpperCase() + size.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[styles.inputLabel, { color: colors.text, fontSize: s(13), marginTop: s(16) }]}>App Theme</Text>
              <View style={[styles.settingsRow, { gap: s(8) }]}>
                {(['light', 'dark'] as const).map((mode) => (
                  <TouchableOpacity 
                    key={mode}
                    style={[
                      styles.settingsBtn, 
                      { height: s(48), borderRadius: s(16), borderColor: colors.borderStrong, backgroundColor: colors.cardBg },
                      appTheme === mode && { backgroundColor: colors.primaryBtn, borderColor: colors.primaryBtn }
                    ]}
                    onPress={() => handleUpdateTheme(mode)}
                  >
                    <Text style={[
                      styles.settingsBtnText, 
                      { color: colors.textSecondary, fontSize: s(14), fontWeight: '800' },
                      appTheme === mode && { color: colors.primaryBtnText }
                    ]}>
                      {mode.charAt(0).toUpperCase() + mode.slice(1)} Mode
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* Accordion 4: Local Device Cache */}
        <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, borderRadius: s(24) }]}>
          <TouchableOpacity 
            style={[styles.cardHeader, { paddingHorizontal: s(16), paddingVertical: s(14) }]} 
            onPress={() => setCacheExpanded(!cacheExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="trash-outline" size={s(24)} color={colors.cardHeaderLeftIcon} style={styles.cardIcon} />
              <Text style={[styles.cardTitle, { color: colors.text, fontSize: s(16) }]}>Local Device Cache</Text>
            </View>
            <Ionicons 
              name={cacheExpanded ? "chevron-up" : "chevron-down"} 
              size={s(20)} 
              color="#A1887F" 
            />
          </TouchableOpacity>

          {cacheExpanded && (
            <View style={styles.cardBodyPadding}>
              <Text style={[styles.infoText, { color: colors.textSecondary, fontSize: s(13), lineHeight: s(18) }]}>
                Erase local cookies, pairing profiles, messaging history, and cached media on this local device. This action cannot be undone.
              </Text>
              <TouchableOpacity style={[styles.actionBtnSecondary, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.border, height: s(48), borderRadius: s(14) }]} onPress={handleResetApp}>
                <Text style={[styles.actionBtnSecondaryText, { color: colors.actionBtnSecondaryText, fontSize: s(14) }]}>Erase All Local Data</Text>
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
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { paddingBottom: insets.bottom > 0 ? insets.bottom + s(24) : s(24) }]}>
            {selectedBuddyForLogs ? (
              // Chat Logs View
              <>
                <View style={styles.modalHeader}>
                  <TouchableOpacity onPress={() => setSelectedBuddyForLogs(null)} style={styles.backBtn}>
                    <Ionicons name="arrow-back" size={24} color="#8D6E63" />
                  </TouchableOpacity>
                  <Text style={styles.modalTitle} numberOfLines={1}>
                    {selectedKidForLogs?.name} & {selectedBuddyForLogs?.name}
                  </Text>
                  <TouchableOpacity onPress={() => setFriendsModalVisible(false)}>
                    <Ionicons name="close-circle" size={28} color="#8D6E63" />
                  </TouchableOpacity>
                </View>

                {loadingLogs ? (
                  <View style={styles.logsLoadingContainer}>
                    <ActivityIndicator size="large" color="#FFC93C" />
                    <Text style={styles.logsLoadingText}>Loading chat logs...</Text>
                  </View>
                ) : (
                  <ScrollView 
                    contentContainerStyle={styles.logsScrollContent} 
                    style={styles.logsScrollView}
                    showsVerticalScrollIndicator={true}
                  >
                    {chatLogs.length === 0 ? (
                      <Text style={styles.noLogsText}>No messages exchanged yet.</Text>
                    ) : (
                      chatLogs.map((msg) => {
                        const isCallLog = msg.text.startsWith('[CALL_LOG:');

                        if (isCallLog) {
                          // Newer rows carry a :INCOMING/:OUTGOING direction suffix — strip it here.
                          const logType = msg.text.replace('[CALL_LOG:', '').replace(']', '').split(':')[0];
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
                            <View key={msg.id} style={styles.logCallWrapper}>
                              <View style={[styles.logCallContainer, isMissed ? styles.logCallMissed : styles.logCallEnded]}>
                                <Ionicons name={logIcon} size={14} color={isMissed ? '#D32F2F' : '#8D6E63'} style={styles.logCallIcon} />
                                <Text style={[styles.logCallText, isMissed && styles.logCallTextMissed]}>
                                  {logTitle}
                                </Text>
                                <Text style={styles.logCallTime}>
                                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </Text>
                              </View>
                            </View>
                          );
                        }

                        const isMe = msg.sender === 'me';
                        return (
                          <View 
                            key={msg.id} 
                            style={[
                              styles.logMessageBubble,
                              isMe ? styles.logMsgKid : styles.logMsgBuddy
                            ]}
                          >
                            <Text style={styles.logMsgSender}>
                              {isMe ? selectedKidForLogs?.name : selectedBuddyForLogs?.name}
                            </Text>
                            <Text style={styles.logMsgText}>{msg.text}</Text>
                            <Text style={styles.logMsgTime}>
                              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </Text>
                          </View>
                        );
                      })
                    )}
                  </ScrollView>
                )}
              </>
            ) : (
              // Buddies List & Add Friend View
              <>
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
                          
                          {status !== 'paired' && (
                            <View style={[styles.statusBadge, styles.statusPending]}>
                              <Text style={styles.statusBadgeText}>Pending</Text>
                            </View>
                          )}

                          <TouchableOpacity 
                            style={styles.friendLogBadge} 
                            onPress={() => loadChatLogs(friend)}
                          >
                            <Text style={styles.friendLogBadgeText}>Logs</Text>
                          </TouchableOpacity>

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
                      <Text style={styles.addBuddySubmitText}>Add Buddy by Code</Text>
                    )}
                  </TouchableOpacity>

                  <View style={styles.qrDividerRow}>
                    <View style={styles.qrDividerLine} />
                    <Text style={styles.qrDividerText}>OR PAIR INSTANTLY</Text>
                    <View style={styles.qrDividerLine} />
                  </View>

                  <View style={styles.qrButtonsRow}>
                    <TouchableOpacity style={styles.qrShowBtn} onPress={() => setQrCodeVisible(true)}>
                      <Ionicons name="qr-code-outline" size={18} color="#4E342E" style={{ marginRight: 6 }} />
                      <Text style={styles.qrBtnText}>Show QR</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.qrScanBtn} onPress={handleStartQRScan}>
                      <Ionicons name="scan-outline" size={18} color="#FFFFFF" style={{ marginRight: 6 }} />
                      <Text style={styles.qrBtnTextWhite}>Scan QR</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Show QR Code Modal */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={qrCodeVisible}
        onRequestClose={() => setQrCodeVisible(false)}
      >
        <View style={styles.modalOverlayCentered}>
          <View style={styles.qrCodeDialog}>
            <Text style={styles.dialogTitle}>{selectedKidForLogs?.name}'s QR Code</Text>
            <Text style={styles.qrCodeSubtitle}>Let another parent scan this to pair immediately!</Text>
            
            {selectedKidForLogs && (
              <Image 
                source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(JSON.stringify({ crumType: 'buddy_qr', cookieCode: selectedKidForLogs.cookieCode, name: selectedKidForLogs.name }))}` }}
                style={styles.qrCodeImage}
              />
            )}

            <Text style={styles.qrCodeText}>{selectedKidForLogs?.cookieCode}</Text>

            <TouchableOpacity style={styles.dialogCloseBtn} onPress={() => setQrCodeVisible(false)}>
              <Text style={styles.dialogCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* QR Scanner Modal */}
      <Modal
        animationType="slide"
        transparent={false}
        visible={qrScannerVisible}
        onRequestClose={() => setQrScannerVisible(false)}
      >
        <SafeAreaView style={styles.scannerContainer}>
          <View style={styles.scannerHeader}>
            <TouchableOpacity onPress={() => setQrScannerVisible(false)} style={styles.scannerBackBtn}>
              <Ionicons name="arrow-back" size={28} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.scannerTitle}>Scan Buddy's QR Code</Text>
            <View style={{ width: 28 }} />
          </View>

          {qrScannerVisible && (
            <CameraView
              style={StyleSheet.absoluteFill}
              onBarcodeScanned={async ({ data }) => {
                if (!qrScannerVisible) return;
                setQrScannerVisible(false);
                
                try {
                  const parsed = JSON.parse(data);
                  if (parsed && parsed.crumType === 'buddy_qr' && parsed.cookieCode && parsed.name) {
                    if (parsed.cookieCode === selectedKidForLogs?.cookieCode) {
                      showAlert("Error", "A child cannot add themselves as a buddy!");
                      return;
                    }
                    
                    setSyncing(true);
                    const success = await StorageService.pairKidsViaQRCode(
                      selectedKidForLogs!.cookieCode,
                      selectedKidForLogs!.name,
                      parsed.cookieCode,
                      parsed.name
                    );

                    if (success) {
                      // Reload lists
                      const freshKids = await StorageService.getKidsList();
                      setKidsList(freshKids);
                      const updatedKid = freshKids.find(k => k.cookieCode === selectedKidForLogs!.cookieCode) || null;
                      setSelectedKidForLogs(updatedKid);
                      
                      showAlert("Success", `${parsed.name} and ${selectedKidForLogs?.name} are now paired buddies!`);
                    } else {
                      showAlert("Error", "Failed to pair with buddy profile.");
                    }
                  } else {
                    showAlert("Invalid QR", "This QR code is not a valid Crumbo buddy code.");
                  }
                } catch (e) {
                  showAlert("Invalid QR", "This QR code could not be read.");
                } finally {
                  setSyncing(false);
                }
              }}
              barcodeScannerSettings={{
                barcodeTypes: ['qr'],
              }}
            />
          )}
          
          <View style={styles.scannerOverlay}>
            <View style={styles.scannerTargetFrame} />
            <Text style={styles.scannerInstructions}>
              Align buddy's QR code within the frame to pair immediately
            </Text>
          </View>
        </SafeAreaView>
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
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: '#FFFDF0',
    backgroundColor: '#FFFFFF',
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
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
  // Chat Logs Viewer Styles
  logsLoadingContainer: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logsLoadingText: {
    fontSize: 14,
    color: '#8D6E63',
    marginTop: 12,
    fontWeight: '700',
  },
  logsScrollView: {
    height: 380,
    backgroundColor: '#FFFDF9',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1.5,
    borderColor: '#FFEFC0',
  },
  logsScrollContent: {
    paddingBottom: 24,
    gap: 12,
  },
  noLogsText: {
    fontSize: 14,
    color: '#8D6E63',
    textAlign: 'center',
    marginTop: 48,
    fontWeight: '600',
  },
  logMessageBubble: {
    maxWidth: '85%',
    padding: 12,
    borderRadius: 16,
    shadowColor: '#4E342E',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 1,
    elevation: 1,
  },
  logMsgKid: {
    backgroundColor: '#FFEFC0',
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  logMsgBuddy: {
    backgroundColor: '#FFFFFF',
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
    borderWidth: 1.5,
    borderColor: '#FFEFC0',
  },
  logMsgSender: {
    fontSize: 11,
    fontWeight: '800',
    color: '#8D6E63',
    marginBottom: 4,
  },
  logMsgText: {
    fontSize: 14,
    color: '#4E342E',
    fontWeight: '600',
  },
  logMsgTime: {
    fontSize: 10,
    color: '#A1887F',
    alignSelf: 'flex-end',
    marginTop: 4,
    fontWeight: '500',
  },
  backBtn: {
    marginRight: 10,
    padding: 4,
  },
  logCallWrapper: {
    alignSelf: 'center',
    marginVertical: 4,
    maxWidth: '85%',
  },
  logCallContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
  },
  logCallMissed: {
    backgroundColor: '#FFEBEE',
    borderColor: '#FFCDD2',
  },
  logCallEnded: {
    backgroundColor: '#F5F5F5',
    borderColor: '#E0E0E0',
  },
  logCallIcon: {
    marginRight: 2,
  },
  logCallText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4E342E',
  },
  logCallTextMissed: {
    color: '#D32F2F',
  },
  logCallTime: {
    fontSize: 10,
    color: '#8D6E63',
    marginLeft: 6,
    fontWeight: '600',
  },
  // QR Dialog & Scanner Styles
  qrCodeDialog: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    width: '85%',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#FFEFC0',
  },
  qrCodeSubtitle: {
    fontSize: 13,
    color: '#8D6E63',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 20,
    fontWeight: '600',
  },
  qrCodeImage: {
    width: 200,
    height: 200,
    marginBottom: 16,
    borderRadius: 12,
  },
  qrCodeText: {
    fontSize: 16,
    fontWeight: '900',
    color: '#4E342E',
    letterSpacing: 1.5,
    marginBottom: 24,
  },
  dialogCloseBtn: {
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderWidth: 1.5,
    borderColor: '#FFEFC0',
  },
  dialogCloseBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#4E342E',
  },
  qrDividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
  },
  qrDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#FFEFC0',
  },
  qrDividerText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#A1887F',
    paddingHorizontal: 12,
    letterSpacing: 1,
  },
  qrButtonsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  qrShowBtn: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#FFFDF0',
    borderWidth: 1.5,
    borderColor: '#FFEFC0',
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  qrScanBtn: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#4E342E',
    borderRadius: 12,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  qrBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#4E342E',
  },
  qrBtnTextWhite: {
    fontSize: 14,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  scannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    zIndex: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  scannerBackBtn: {
    padding: 4,
  },
  scannerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  scannerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  scannerTargetFrame: {
    width: 250,
    height: 250,
    borderWidth: 3,
    borderColor: '#FFC93C',
    borderRadius: 24,
    backgroundColor: 'transparent',
  },
  scannerInstructions: {
    fontSize: 14,
    color: '#FFFFFF',
    fontWeight: '700',
    textAlign: 'center',
    paddingHorizontal: 32,
    marginTop: 32,
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  settingsBtn: {
    flex: 1,
    height: 48,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#FFEFC0',
    backgroundColor: '#FFFDF8',
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsBtnActive: {
    backgroundColor: '#FFC93C',
    borderColor: '#FFC93C',
  },
  settingsBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#8D6E63',
  },
  settingsBtnTextActive: {
    color: '#4E342E',
  },
});
