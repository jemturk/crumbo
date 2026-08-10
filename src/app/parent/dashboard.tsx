import React, { useState, useEffect, useRef } from 'react';
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
  KeyboardAvoidingView
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, KidProfile } from '@/services/storage';
import { supabase } from '@/services/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AdultAvatar from '@/components/AdultAvatar';
import AdultAvatarPickerModal from '@/components/AdultAvatarPickerModal';
import ChatMediaBubble, { parseMediaMessage } from '@/components/ChatMediaBubble';
import VoiceMessageBubble from '@/components/VoiceMessageBubble';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import OnboardingModal from '@/components/OnboardingModal';
import { CameraView, useCameraPermissions } from 'expo-camera';
import QRCode from 'react-native-qrcode-svg';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useParentAvatarPicker } from '@/hooks/use-parent-avatar-picker';
import { useSettings } from '@/context/settings-context';

// Mirrors CALL_LOG_COLORS in chat/[friendId].tsx — kept in sync so a parent reviewing logs
// sees the exact same call-type colors a kid sees in their own chat.
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
  const [parentEmail, setParentEmail] = useState<string | null>(null);
  const [parentName, setParentName] = useState<string | null>(null);
  const [parentAvatarUrl, setParentAvatarUrl] = useState<string | null>(null);
  const [parentAvatarEmoji, setParentAvatarEmoji] = useState<string | null>(null);
  const [kidsList, setKidsList] = useState<KidProfile[]>([]);
  const [parentActiveOnDevice, setParentActiveOnDevice] = useState(false);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);

  // Accordion Toggles
  const [childrenExpanded, setChildrenExpanded] = useState(true);
  const [subscriptionExpanded, setSubscriptionExpanded] = useState(false);
  const [appSettingsExpanded, setAppSettingsExpanded] = useState(false);
  const [cacheExpanded, setCacheExpanded] = useState(false);

  // Modals
  const [friendsModalVisible, setFriendsModalVisible] = useState(false);
  const [addKidModalVisible, setAddKidModalVisible] = useState(false);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [newKidName, setNewKidName] = useState('');
  const [editNameModalVisible, setEditNameModalVisible] = useState(false);
  const [editNameInput, setEditNameInput] = useState('');
  const [selectedKidForLogs, setSelectedKidForLogs] = useState<KidProfile | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [newFriendName, setNewFriendName] = useState('');
  const [newFriendCode, setNewFriendCode] = useState('');
  const [newRelativeName, setNewRelativeName] = useState('');
  const [newRelativeEmail, setNewRelativeEmail] = useState('');
  const [pairingStatuses, setPairingStatuses] = useState<Record<string, 'paired' | 'pending'>>({});

  // QR Code Pairing State
  const [permission, requestPermission] = useCameraPermissions();
  const [qrScannerVisible, setQrScannerVisible] = useState(false);
  const [qrCodeVisible, setQrCodeVisible] = useState(false);
  // onBarcodeScanned fires once per detected frame, and `if (!qrScannerVisible) return` inside
  // that closure reads a stale value captured at render time — several frames' worth of scans
  // can pass the guard before the setQrScannerVisible(false) re-render actually lands, firing
  // pairKidsViaQRCode (and its alert) multiple times for one scan. A ref is read synchronously
  // on every call, so latching on it (instead of the stale state) actually stops duplicates.
  const qrScanHandledRef = useRef(false);

  const handleStartQRScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        showAlert("Permission Required", "Camera access is needed to scan QR codes.");
        return;
      }
    }
    qrScanHandledRef.current = false;
    setQrScannerVisible(true);
  };

  // Chat Logs State
  const [selectedBuddyForLogs, setSelectedBuddyForLogs] = useState<any | null>(null);
  const [chatLogs, setChatLogs] = useState<any[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const avatarPicker = useParentAvatarPicker({
    onAvatarUrlChange: setParentAvatarUrl,
    onAvatarEmojiChange: setParentAvatarEmoji,
    showAlert,
  });

  useEffect(() => {
    // Plain loadSettings() alone only re-reads the local KIDS_LIST cache, which is last synced
    // from the server at sign-in time — so a kid's boundDeviceId (and every other kid/device's
    // Active/Inactive badge here) would keep showing whatever was cached back then no matter how
    // stale, even on a fresh app open. Pull a live copy down first, same as refreshKidsFromServer
    // does after an activate/deactivate action, so the very first render is honest too.
    (async () => {
      const email = await StorageService.getParentEmail();
      if (email) {
        await StorageService.fetchAndRestoreParentData(email);
      }
      await loadSettings();
    })();
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
      try {
        // checkFriendPairingStatus also returns the friend's current avatarEmoji, but this is a
        // multi-kid parent device (no single "active" KID_PROFILE the way updateFriendAvatar
        // assumes) — not worth a bespoke cache-write path just for this management view; it'll
        // still pick up the latest avatar next time this kid's profile syncs.
        const result = await StorageService.checkFriendPairingStatus(kid.cookieCode, friend.cookieCode);
        statuses[friend.cookieCode] = result.status;
      } catch (e) {
        console.error('Error checking pairing status for', friend.cookieCode, e);
      }
    }
    setPairingStatuses(statuses);
  };

  const loadSettings = async () => {
    try {
      const isSub = await StorageService.isSubscribed();
      const pEmail = await StorageService.getParentEmail();
      const pName = await StorageService.getParentName();
      const pAvatarUrl = await StorageService.getParentAvatarUrl();
      const pAvatarEmoji = await StorageService.getParentAvatarEmoji();
      const list = await StorageService.getKidsList();
      const parentActive = await StorageService.isParentActiveOnDevice();
      const deviceId = await StorageService.getDeviceId();
      const biometric = await StorageService.isBiometricEnabled();

      setSubscribed(isSub);
      setParentEmail(pEmail);
      setParentName(pName);
      setParentAvatarUrl(pAvatarUrl);
      setParentAvatarEmoji(pAvatarEmoji);
      setKidsList(list);
      setParentActiveOnDevice(parentActive);
      setThisDeviceId(deviceId);
      setBiometricEnabledState(biometric);

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

  const handleToggleBiometric = async (enabled: boolean) => {
    await StorageService.setBiometricEnabled(enabled);
    setBiometricEnabledState(enabled);
  };

  const handleLogout = () => {
    showAlert(
      "Log Out",
      "Are you sure you want to log out of the Parent Area? You'll need to sign in again to manage settings, but any active chat session on this device (yours or your child's) stays active.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log Out",
          style: "destructive",
          onPress: async () => {
            const biometricOn = await StorageService.isBiometricEnabled();
            if (!biometricOn) {
              // No biometric to resume later — a real sign-out, matching what "Log Out" implies.
              await supabase.auth.signOut();
            }
            // If biometric IS enabled, deliberately skip signOut(): the whole point of turning it
            // on is that Face ID/fingerprint stands in for the password on the NEXT sign-in too,
            // not just for staying in the current app session — so the underlying Supabase
            // session stays alive on this device for handleBiometricSignIn to resume, gated by
            // the OS's own biometric prompt, the same way a banking app's "log out" works.
            //
            // Deliberately does NOT clear PARENT_EMAIL, PARENT_ACTIVE_ON_DEVICE, or the local
            // KIDS_LIST cache — this "Log Out" only ever gates re-entry into Parent Area's OWN
            // settings/dashboard (always reached through gate.tsx, which requires either a live
            // session or a fresh password), not whether this device stays "active" for chat.
            // Clearing the email/active flag used to leave them mismatched (silently broke the
            // Chats screen — see parent/chat/index.tsx's own defensive check); clearing KIDS_LIST
            // was worse — any later syncParentData() call from this now-signed-out-but-still-
            // active device (e.g. uploading an avatar photo) would rebuild the server's kids[]
            // from this now-empty local cache, wiping every real kid. gate.tsx's own sign-in
            // already unconditionally refreshes KIDS_LIST from the server on every real sign-in
            // (see fetchAndRestoreParentData), so clearing it here was always redundant anyway.
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
      // Force-activate and push the corrected state either way — restoring an existing row
      // as-is would silently keep a stale subscribed:false from ever getting corrected (this is
      // the one UI path meant to fix exactly that), and a kid's device mirrors that flag down
      // from here, locking them out of their own already-active chat jar.
      await StorageService.saveParentEmail(trimmedEmail);
      await StorageService.setSubscribed(true);
      setParentEmail(trimmedEmail);
      setSubscribed(true);
      await StorageService.syncParentData();
      setSyncing(false);

      if (restored) {
        showAlert(
          "Welcome Back! 🎉",
          "We found your existing parent profile. All settings and child data have been restored.",
          [
            { text: "OK", onPress: async () => { await loadSettings(); } }
          ]
        );
      } else {
        showAlert("Subscription Activated!", "Your Crumbo parental control account is active.");
      }
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
            try {
              // Push the cancellation to Supabase — without this it only ever set a flag on
              // this device, and the kid's device (which checks the parent's synced row, not
              // anything local to it) would never learn the subscription was cancelled. See
              // bug #6 in BUGS.md.
              await StorageService.syncParentData();
              setSubscribed(false);
              showAlert("Subscription Cancelled", "Your subscription is now inactive.");
            } catch (e) {
              // Roll back the local flag — better to show "still subscribed" (safe/consistent
              // with the server) than to silently claim cancellation succeeded when the kid's
              // device was never actually told.
              await StorageService.setSubscribed(true);
              showAlert("Connection Error", "Could not cancel your subscription. Please check your network and try again.");
            }
          }
        }
      ]
    );
  };

  const handleAddChildClick = () => {
    setNewKidName('');
    setAddKidModalVisible(true);
  };

  const handleOpenEditName = () => {
    setEditNameInput(parentName || '');
    setEditNameModalVisible(true);
  };

  const handleSaveParentName = async () => {
    const name = editNameInput.trim();
    if (!name) {
      showAlert("Name Required", "Please enter a name.");
      return;
    }

    try {
      setSyncing(true);
      await StorageService.saveParentName(name);
      setParentName(name);
      setEditNameModalVisible(false);
      // Same propagation path as the avatar picker (see useParentAvatarPicker) — pushes the new
      // name into this parent's own profile row, and buildParentPushTokenPayload's per-kid
      // backfill carries it into every kid-they-manage's friends[] entry for "me". A paired
      // parent's copy is refreshed lazily at their own next getParentContacts() read, same as
      // their avatar (see the comment there).
      await StorageService.syncParentData();
    } catch (e) {
      showAlert("Error", "Could not update your name.");
    } finally {
      setSyncing(false);
    }
  };

  const handleCreateProfile = async () => {
    const name = newKidName.trim();
    if (!name) {
      showAlert("Name Required", "Please enter a nickname for the profile.");
      return;
    }

    try {
      setSyncing(true);
      const newKid = await StorageService.createKidProfile(name);
      setAddKidModalVisible(false);
      await StorageService.syncParentData();
      // createKidProfile auto-activates the very first kid on an account locally (if nothing
      // else is active on this device yet) — claim the matching server-side device lock too, now
      // that the kid is actually synced up, so Managed Users' status badge and any other device's
      // activateKidOnThisDevice check both see it consistently.
      const active = await StorageService.getKidProfile();
      if (active && active.cookieCode === newKid.cookieCode) {
        await StorageService.activateKidOnThisDevice(newKid.cookieCode);
        await refreshKidsFromServer();
      } else {
        await loadSettings();
      }
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

  const handleAddRelativeToKid = async () => {
    if (!selectedKidForLogs) return;
    const name = newRelativeName.trim();
    const email = newRelativeEmail.trim().toLowerCase();

    if (!name) {
      showAlert("Name Required", "Please enter a name for this relative (e.g. \"Grandma\", \"Uncle Bob\").");
      return;
    }
    if (!email || !email.includes('@')) {
      showAlert("Invalid Email", "Please enter a valid email address.");
      return;
    }
    if (email === parentEmail) {
      showAlert("Invalid Email", "That's your own email address!");
      return;
    }

    setSyncing(true);
    try {
      const result = await StorageService.addRelativeToKidByEmail(
        selectedKidForLogs.cookieCode,
        selectedKidForLogs.name,
        selectedKidForLogs.avatarEmoji,
        email,
        name
      );

      if (result === 'error') {
        showAlert("Error", "Could not add this relative. Please check your connection and try again.");
        return;
      }

      const freshKids = await StorageService.getKidsList();
      setKidsList(freshKids);
      const updatedKid = freshKids.find(k => k.cookieCode === selectedKidForLogs.cookieCode) || null;
      setSelectedKidForLogs(updatedKid);

      setNewRelativeName('');
      setNewRelativeEmail('');

      if (result === 'linked') {
        showAlert("Success", `${name} can now chat with ${selectedKidForLogs.name}!`);
      } else {
        showAlert("Invite Sent 📬", `${name} doesn't have a Crumbo account yet — we've sent them an email invite. Once they sign up, they'll be able to chat with ${selectedKidForLogs.name}.`);
      }
    } catch (e) {
      showAlert("Error", "Could not add this relative.");
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
      videoCallingDisabled: nextVideoCallingDisabled,
      photosDisabled: !!kid.photosDisabled,
      drawingDisabled: !!kid.drawingDisabled,
      voiceMessagesDisabled: !!kid.voiceMessagesDisabled
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
      videoCallingDisabled: nextVideoCallingDisabled,
      photosDisabled: !!kid.photosDisabled,
      drawingDisabled: !!kid.drawingDisabled,
      voiceMessagesDisabled: !!kid.voiceMessagesDisabled
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
      videoCallingDisabled: nextVideoCallingDisabled,
      photosDisabled: !!kid.photosDisabled,
      drawingDisabled: !!kid.drawingDisabled,
      voiceMessagesDisabled: !!kid.voiceMessagesDisabled
    });
    await StorageService.syncParentData().catch(e => console.error(e));
    await loadSettings();
  };

  // Independent of chat/calling/video and of each other — no cascade logic, unlike the three
  // handlers above.
  const handleTogglePhotos = async (kid: KidProfile) => {
    await StorageService.updateKidSettingsForProfile(kid.cookieCode, {
      chatDisabled: !!kid.chatDisabled,
      callingDisabled: !!kid.callingDisabled,
      videoCallingDisabled: !!kid.videoCallingDisabled,
      photosDisabled: !kid.photosDisabled,
      drawingDisabled: !!kid.drawingDisabled,
      voiceMessagesDisabled: !!kid.voiceMessagesDisabled
    });
    await StorageService.syncParentData().catch(e => console.error(e));
    await loadSettings();
  };

  const handleToggleDrawing = async (kid: KidProfile) => {
    await StorageService.updateKidSettingsForProfile(kid.cookieCode, {
      chatDisabled: !!kid.chatDisabled,
      callingDisabled: !!kid.callingDisabled,
      videoCallingDisabled: !!kid.videoCallingDisabled,
      photosDisabled: !!kid.photosDisabled,
      drawingDisabled: !kid.drawingDisabled,
      voiceMessagesDisabled: !!kid.voiceMessagesDisabled
    });
    await StorageService.syncParentData().catch(e => console.error(e));
    await loadSettings();
  };

  const handleToggleVoiceMessages = async (kid: KidProfile) => {
    await StorageService.updateKidSettingsForProfile(kid.cookieCode, {
      chatDisabled: !!kid.chatDisabled,
      callingDisabled: !!kid.callingDisabled,
      videoCallingDisabled: !!kid.videoCallingDisabled,
      photosDisabled: !!kid.photosDisabled,
      drawingDisabled: !!kid.drawingDisabled,
      voiceMessagesDisabled: !kid.voiceMessagesDisabled
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
      "This will erase ALL local profiles, friends, and messaging histories on this device, and log you out of the Parent Area. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Erase Everything",
          style: "destructive",
          onPress: async () => {
            // Wipe local state, but explicitly sign out first — AsyncStorage.clear() (inside
            // clearAll) only erases the session's on-disk cache; the JS client still holds the
            // access token in memory and would keep making authenticated calls until restart.
            await supabase.auth.signOut();
            await StorageService.clearAll();
            router.replace('/');
          }
        }
      ]
    );
  };

  // activateKidOnThisDevice/deactivateKidOnThisDevice update boundDeviceId on the SERVER row —
  // loadSettings() alone re-reads the local KIDS_LIST cache, which only ever gets refreshed from
  // the server at sign-in time, so every card's Active/Inactive badge would just keep showing
  // whatever was cached back then, drifting further from reality with each activate/deactivate.
  // Pulling a fresh copy down first is what actually keeps the list honest.
  const refreshKidsFromServer = async () => {
    if (parentEmail) {
      await StorageService.fetchAndRestoreParentData(parentEmail);
    }
    await loadSettings();
  };

  const handleActivateKid = (kid: KidProfile) => {
    showAlert(
      `Activate ${kid.name} on This Device?`,
      `${kid.name} will become the active user on this device. Anyone else currently active here (a different kid, or you as parent) will be deactivated first.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Activate",
          onPress: async () => {
            setSyncing(true);
            const result = await StorageService.activateKidOnThisDevice(kid.cookieCode);
            await refreshKidsFromServer();
            setSyncing(false);
            if (!result.success) {
              if (result.error === 'ALREADY_ACTIVE_ELSEWHERE') {
                showAlert("Active on Another Device", `${kid.name} is already active on a different device. Deactivate them there first (tap Deactivate on ${kid.name}'s card here), then activate them on this device.`);
              } else {
                showAlert("Error", "Could not activate this profile. Please check your connection and try again.");
              }
            }
          }
        }
      ]
    );
  };

  const handleDeactivateKid = (kid: KidProfile) => {
    showAlert(
      `Deactivate ${kid.name}?`,
      `${kid.name} will no longer be active on any device. They can be activated again here or on any other device afterward.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Deactivate",
          style: "destructive",
          onPress: async () => {
            setSyncing(true);
            const result = await StorageService.deactivateKidOnThisDevice(kid.cookieCode);
            await refreshKidsFromServer();
            setSyncing(false);
            if (!result.success) {
              showAlert("Error", "Could not deactivate this profile. Please check your connection and try again.");
            }
          }
        }
      ]
    );
  };

  const handleActivateParent = async () => {
    setSyncing(true);
    // Activating the parent can also release a previously-active kid's SERVER-side device lock
    // (see activateParentOnDevice) — refreshKidsFromServer (not plain loadSettings) is what
    // actually picks that up, same reasoning as the kid activate/deactivate handlers above.
    await StorageService.activateParentOnDevice();
    await refreshKidsFromServer();
    setSyncing(false);
  };

  const handleDeactivateParent = async () => {
    setSyncing(true);
    await StorageService.deactivateParentOnDevice();
    await loadSettings();
    setSyncing(false);
  };

  const handleDeleteServerData = () => {
    showAlert(
      "Delete Account & All Data?",
      "This permanently deletes your parent account, every child profile, all chat and call history, and every uploaded photo or drawing from the server. Shared chat history is deleted for buddies too — this cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Everything",
          style: "destructive",
          onPress: async () => {
            setSyncing(true);
            try {
              await StorageService.deleteAccountFromServer();
              // Best-effort only — the auth.users row is already gone at this point, so a
              // failure here doesn't matter; clearAll() below wipes the session cache regardless.
              await supabase.auth.signOut().catch(() => {});
              await StorageService.clearAll();
              router.replace('/');
            } catch (e) {
              setSyncing(false);
              showAlert("Error", `Could not delete account: ${e instanceof Error ? e.message : 'unknown error'}`);
            }
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

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(16) }}>
          <TouchableOpacity style={styles.logoutButton} onPress={() => setOnboardingVisible(true)}>
            <Ionicons name="help-circle-outline" size={s(28)} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={s(28)} color="#D32F2F" />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.scrollContent, { padding: s(16), gap: s(16) }]}>
        
        {/* Accordion 1: Managed Users */}
        <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, borderRadius: s(24) }]}>
          <TouchableOpacity 
            style={[styles.cardHeader, { paddingHorizontal: s(16), paddingVertical: s(14) }]} 
            onPress={() => setChildrenExpanded(!childrenExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="people-outline" size={s(24)} color={colors.cardHeaderLeftIcon} style={styles.cardIcon} />
              <Text style={[styles.cardTitle, { color: colors.text, fontSize: s(16) }]}>Managed Users</Text>
            </View>
            <Ionicons 
              name={childrenExpanded ? "chevron-up" : "chevron-down"} 
              size={s(20)} 
              color="#A1887F" 
            />
          </TouchableOpacity>

          {childrenExpanded && (
            <View style={[styles.cardBody, { borderTopColor: colors.border }]}>
              {/* Parent card — pinned first, distinctly styled so it never reads as "just
                  another kid": gold border/badge instead of a kid's avatar-style row, and no
                  delete/regenerate-code controls (removing the account lives in Device &
                  Account Data instead). Exactly one of this card or a kid card below can show
                  "Active on this device" at a time. */}
              <View style={[styles.childContainer, { borderColor: '#FFC93C', borderWidth: 2, paddingHorizontal: s(16), paddingVertical: s(30), borderRadius: s(20), backgroundColor: isDark ? colors.inputBg : '#FFFDF8', marginBottom: s(12) }]}>
                <View style={{ position: 'absolute', top: s(-1), right: s(-1), backgroundColor: '#FFC93C', borderTopRightRadius: s(18), borderBottomLeftRadius: s(12), paddingHorizontal: s(10), paddingVertical: s(4) }}>
                  <Text style={{ fontSize: s(11), fontWeight: '800', color: '#4E342E' }}>PARENT</Text>
                </View>
                <View style={[styles.childMetaRow, { marginBottom: 0 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8), flexShrink: 1 }}>
                    <TouchableOpacity onPress={avatarPicker.openPicker}>
                      <AdultAvatar uri={parentAvatarUrl || undefined} emoji={parentAvatarEmoji || undefined} size={s(36)} />
                    </TouchableOpacity>
                    <View style={{ flexShrink: 1 }}>
                      <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: s(6) }} onPress={handleOpenEditName}>
                        <Text style={[styles.childName, { color: colors.text, fontSize: s(18) }]} numberOfLines={1}>{parentName || parentEmail}</Text>
                        <Ionicons name="pencil" size={s(14)} color={colors.textSecondary} />
                      </TouchableOpacity>
                      {parentName && (
                        <Text style={[styles.infoText, { color: colors.textSecondary, fontSize: s(12), marginBottom: 0 }]} numberOfLines={1}>{parentEmail}</Text>
                      )}
                    </View>
                  </View>
                  <TouchableOpacity
                    style={[styles.actionBtnSecondary, { alignSelf: 'center', backgroundColor: parentActiveOnDevice ? colors.successBg : colors.dangerBg, borderColor: parentActiveOnDevice ? colors.successText : colors.dangerText, height: s(36), borderRadius: s(12), width: s(92), paddingHorizontal: s(6) }]}
                    onPress={parentActiveOnDevice ? handleDeactivateParent : handleActivateParent}
                  >
                    <Text
                      style={[styles.actionBtnSecondaryText, { color: parentActiveOnDevice ? colors.successText : colors.dangerText, fontSize: s(13) }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.7}
                    >
                      {parentActiveOnDevice ? 'Active' : 'Inactive'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {kidsList.length > 0 ? (
                kidsList.map((kid) => {
                  // Sending photos/drawings happens IN the chat, so with chat off they're
                  // effectively unusable too — shown red here to reflect that, without actually
                  // touching their own stored flag. Turning chat back on reveals whatever
                  // photosDisabled/drawingDisabled already was, since it was never mutated.
                  const photosEffectivelyDisabled = kid.chatDisabled || kid.photosDisabled;
                  const drawingEffectivelyDisabled = kid.chatDisabled || kid.drawingDisabled;
                  const voiceMessagesEffectivelyDisabled = kid.chatDisabled || kid.voiceMessagesDisabled;
                  const activeHere = !!kid.boundDeviceId && kid.boundDeviceId === thisDeviceId;
                  const activeElsewhere = !!kid.boundDeviceId && kid.boundDeviceId !== thisDeviceId;
                  const statusButtonLabel = activeHere ? 'Active' : activeElsewhere ? 'Active (another device)' : 'Inactive';
                  const statusButtonBg = activeHere ? colors.successBg : activeElsewhere ? colors.successBgFaint : colors.dangerBg;
                  const statusButtonBorder = activeHere || activeElsewhere ? colors.successText : colors.dangerText;
                  const statusButtonText = activeHere || activeElsewhere ? colors.successText : colors.dangerText;
                  return (
                    <View key={kid.cookieCode} style={[styles.childContainer, { borderColor: colors.border, padding: s(16), borderRadius: s(20), backgroundColor: isDark ? colors.inputBg : '#FFFDF8' }]}>
                      {/* Name and Delete Row */}
                      <View style={styles.childMetaRow}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8) }}>
                          <View style={{ width: s(36), height: s(36), borderRadius: s(18), backgroundColor: isDark ? colors.inputBg : '#FFFDF0', borderWidth: 2, borderColor: colors.borderStrong, justifyContent: 'center', alignItems: 'center' }}>
                            <Text style={{ fontSize: s(18) }}>{kid.avatarEmoji || '🍪'}</Text>
                          </View>
                          <Text style={[styles.childName, { color: colors.text, fontSize: s(18) }]}>{kid.name}</Text>
                        </View>
                        <TouchableOpacity style={styles.deleteChildBtn} onPress={() => handleDeleteChild(kid.cookieCode, kid.name)}>
                          <Ionicons name="trash" size={s(18)} color="#D32F2F" />
                        </TouchableOpacity>
                      </View>

                      {/* Pairing Code Pill, QR, and Activation Status */}
                      <View style={[styles.codeRow, { justifyContent: 'space-between', marginTop: s(8) }]}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8) }}>
                          <TouchableOpacity style={[styles.codePill, { backgroundColor: isDark ? '#3D2A1D' : '#FFF5D1', paddingHorizontal: s(12), paddingVertical: s(6), borderRadius: s(12) }]} onPress={() => copyToClipboard(kid.cookieCode)} activeOpacity={0.7}>
                            <Text style={[styles.codeText, { color: colors.textSecondary, fontSize: s(13) }]}>{kid.cookieCode}</Text>
                            <Ionicons name="copy-outline" size={s(14)} color="#8D6E63" />
                          </TouchableOpacity>

                          <TouchableOpacity style={[styles.qrBtn, { width: s(36), height: s(36), borderRadius: s(18), backgroundColor: isDark ? '#3D2A1D' : '#FFFDF5' }]} onPress={() => { setSelectedKidForLogs(kid); setQrCodeVisible(true); }}>
                            <Ionicons name="qr-code-outline" size={s(16)} color="#8D6E63" />
                          </TouchableOpacity>
                        </View>

                        <TouchableOpacity
                          style={[styles.actionBtnSecondary, { backgroundColor: statusButtonBg, borderColor: statusButtonBorder, height: s(36), borderRadius: s(12), width: s(92), paddingHorizontal: s(6) }]}
                          onPress={() => (activeHere || activeElsewhere ? handleDeactivateKid(kid) : handleActivateKid(kid))}
                        >
                          <Text
                            style={[styles.actionBtnSecondaryText, { color: statusButtonText, fontSize: s(13) }]}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            minimumFontScale={0.7}
                          >
                            {statusButtonLabel}
                          </Text>
                        </TouchableOpacity>
                      </View>

                      {/* Locks & Controls Row */}
                      <View style={styles.controlsRow}>
                        <View style={styles.togglesGroup}>
                          {/* Chat Toggle */}
                          <TouchableOpacity
                            style={[styles.toggleCircle, { width: s(36), height: s(36), borderRadius: s(18) }, kid.chatDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleChat(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="chatbubble" size={s(18)} color="#FFFFFF" />
                            {kid.chatDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Voice Call Toggle */}
                          <TouchableOpacity
                            style={[styles.toggleCircle, { width: s(36), height: s(36), borderRadius: s(18) }, kid.callingDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleCalling(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="call" size={s(18)} color="#FFFFFF" />
                            {kid.callingDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Video Call Toggle */}
                          <TouchableOpacity
                            style={[styles.toggleCircle, { width: s(36), height: s(36), borderRadius: s(18) }, kid.videoCallingDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleVideo(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="videocam" size={s(18)} color="#FFFFFF" />
                            {kid.videoCallingDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Photos Toggle */}
                          <TouchableOpacity
                            style={[styles.toggleCircle, { width: s(36), height: s(36), borderRadius: s(18) }, photosEffectivelyDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleTogglePhotos(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="image" size={s(18)} color="#FFFFFF" />
                            {photosEffectivelyDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Drawing Toggle */}
                          <TouchableOpacity
                            style={[styles.toggleCircle, { width: s(36), height: s(36), borderRadius: s(18) }, drawingEffectivelyDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleDrawing(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="brush" size={s(18)} color="#FFFFFF" />
                            {drawingEffectivelyDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>

                          {/* Voice Messages Toggle */}
                          <TouchableOpacity
                            style={[styles.toggleCircle, { width: s(36), height: s(36), borderRadius: s(18) }, voiceMessagesEffectivelyDisabled ? styles.toggleRedBg : styles.toggleGreenBg]}
                            onPress={() => handleToggleVoiceMessages(kid)}
                            activeOpacity={0.8}
                          >
                            <Ionicons name="mic" size={s(18)} color="#FFFFFF" />
                            {voiceMessagesEffectivelyDisabled && <View style={styles.slashOverlay} />}
                          </TouchableOpacity>
                        </View>

                        {/* Friends and Logs Button */}
                        <TouchableOpacity
                          style={[styles.friendsLogsBtn, { borderRadius: s(12), paddingVertical: s(6), paddingHorizontal: s(12), backgroundColor: isDark ? '#3D2A1D' : '#FFFDF5', borderColor: '#FFD54F' }]}
                          onPress={() => {
                            setSelectedKidForLogs(kid);
                            setFriendsModalVisible(true);
                          }}
                        >
                          <Text style={[styles.friendsLogsBtnText, { color: colors.textSecondary, fontSize: s(13) }]}>Friends & Logs</Text>
                          <Ionicons name="chevron-forward" size={s(14)} color={colors.textSecondary} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                })
              ) : (
                <Text style={[styles.noChildrenText, { color: colors.textSecondary, fontSize: s(14) }]}>No children paired on this device yet.</Text>
              )}

              {/* Add Child Profile Button */}
              <TouchableOpacity style={[styles.addChildBtn, { height: s(50), borderRadius: s(16), borderColor: '#FFD54F', backgroundColor: colors.primaryBtnFaded, marginTop: s(8) }]} onPress={handleAddChildClick}>
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

              <Text style={[styles.inputLabel, { color: colors.text, fontSize: s(13), marginTop: s(16) }]}>Biometric Sign-In</Text>
              <View style={[styles.settingsRow, { gap: s(8) }]}>
                {([{ label: 'On', value: true }, { label: 'Off', value: false }]).map((opt) => (
                  <TouchableOpacity
                    key={opt.label}
                    style={[
                      styles.settingsBtn,
                      { height: s(48), borderRadius: s(16), borderColor: colors.borderStrong, backgroundColor: colors.cardBg },
                      biometricEnabled === opt.value && { backgroundColor: colors.primaryBtn, borderColor: colors.primaryBtn }
                    ]}
                    onPress={() => handleToggleBiometric(opt.value)}
                  >
                    <Text style={[
                      styles.settingsBtnText,
                      { color: colors.textSecondary, fontSize: s(14), fontWeight: '800' },
                      biometricEnabled === opt.value && { color: colors.primaryBtnText }
                    ]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* Accordion 4: Device & Account Data */}
        <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, borderRadius: s(24) }]}>
          <TouchableOpacity
            style={[styles.cardHeader, { paddingHorizontal: s(16), paddingVertical: s(14) }]}
            onPress={() => setCacheExpanded(!cacheExpanded)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeaderLeft}>
              <Ionicons name="phone-portrait-outline" size={s(24)} color={colors.cardHeaderLeftIcon} style={styles.cardIcon} />
              <Text style={[styles.cardTitle, { color: colors.text, fontSize: s(16) }]}>Device & Account Data</Text>
            </View>
            <Ionicons
              name={cacheExpanded ? "chevron-up" : "chevron-down"}
              size={s(20)}
              color="#A1887F"
            />
          </TouchableOpacity>

          {cacheExpanded && (
            <View style={[styles.cardBodyPadding, { gap: s(12) }]}>
              {/* Sub-section: local data erasure */}
              <View style={[styles.deviceDataSection, { backgroundColor: colors.bg, borderColor: colors.border }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8), marginBottom: s(8) }}>
                  <Ionicons name="trash-outline" size={s(18)} color={colors.textSecondary} />
                  <Text style={[styles.inputLabel, { color: colors.text, fontSize: s(13) }]}>Local Data</Text>
                </View>
                <Text style={[styles.infoText, { color: colors.textSecondary, fontSize: s(13), lineHeight: s(18), marginBottom: s(10) }]}>
                  Erase local cookies, pairing profiles, messaging history, and cached media on this device, and log out of the Parent Area. This action cannot be undone.
                </Text>
                <TouchableOpacity style={[styles.actionBtnSecondary, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.border, height: s(48), borderRadius: s(14) }]} onPress={handleResetApp}>
                  <Text style={[styles.actionBtnSecondaryText, { color: colors.actionBtnSecondaryText, fontSize: s(14) }]}>Erase All Local Data</Text>
                </TouchableOpacity>
              </View>

              {/* Sub-section: full account deletion */}
              <View style={[styles.deviceDataSection, { backgroundColor: colors.bg, borderColor: '#D32F2F' }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(8), marginBottom: s(8) }}>
                  <Ionicons name="warning-outline" size={s(18)} color="#D32F2F" />
                  <Text style={[styles.inputLabel, { color: '#D32F2F', fontSize: s(13) }]}>Delete Account</Text>
                </View>
                <Text style={[styles.infoText, { color: colors.textSecondary, fontSize: s(13), lineHeight: s(18), marginBottom: s(10) }]}>
                  Permanently delete your parent account and all of its data — profiles, chat and call history, and uploaded media — from the server. This action cannot be undone.
                </Text>
                <TouchableOpacity style={[styles.actionBtnSecondary, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: '#D32F2F', height: s(48), borderRadius: s(14) }]} onPress={handleDeleteServerData}>
                  <Text style={[styles.actionBtnSecondaryText, { color: '#D32F2F', fontSize: s(14) }]}>Delete Account & All Server Data</Text>
                </TouchableOpacity>
              </View>
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
          <TouchableOpacity style={styles.modalOverlayTouchable} activeOpacity={1} onPress={() => setFriendsModalVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={[styles.modalContent, { paddingBottom: insets.bottom > 0 ? insets.bottom + s(24) : s(24) }]}>
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
                        const formatTime = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                        if (isCallLog) {
                          // Direction suffix (INCOMING/OUTGOING) is who initiated the call; callUUID
                          // and a completed call's trailing duration-in-seconds may be missing on
                          // older rows — same format chat/[friendId].tsx parses.
                          const [logType, direction, , durationStr] = msg.text.replace('[CALL_LOG:', '').replace(']', '').split(':');
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

                          // Direction is relative to whoever wrote the row; XOR with which kid this
                          // log view's "me" is (selectedKidForLogs) to get "did that kid initiate it".
                          const initiatedByMe = (msg.sender === 'me') === (direction === 'OUTGOING');
                          const rowAlign = !direction ? styles.logRowCenter : initiatedByMe ? styles.logRowMe : styles.logRowThem;

                          return (
                            <View key={msg.id} style={[styles.logCallWrapper, rowAlign]}>
                              <View style={[styles.logCallContainer, {
                                backgroundColor: isDark ? logColors.bgDark : logColors.bg,
                                borderColor: isDark ? logColors.borderDark : logColors.border,
                              }]}>
                                {direction && (
                                  <Ionicons
                                    name="arrow-up-outline"
                                    size={12}
                                    color={logColor}
                                    style={{ transform: [{ rotate: initiatedByMe ? '45deg' : '225deg' }] }}
                                  />
                                )}
                                <Ionicons name={logIcon} size={14} color={logColor} style={styles.logCallIcon} />
                                <Text style={[styles.logCallText, { color: logColor }]}>
                                  {logTitle}
                                </Text>
                                <Text style={styles.logCallTime}>{formatTime(msg.timestamp)}</Text>
                              </View>
                            </View>
                          );
                        }

                        const media = parseMediaMessage(msg.text);

                        if (media && media.kind === 'voice') {
                          const isMeVoice = msg.sender === 'me';
                          return (
                            <View
                              key={msg.id}
                              style={[styles.logMessageBubble, isMeVoice ? styles.logMsgKid : styles.logMsgBuddy]}
                            >
                              <Text style={styles.logMsgSender}>
                                {isMeVoice ? selectedKidForLogs?.name : selectedBuddyForLogs?.name}
                              </Text>
                              <View style={{ marginTop: 2 }}>
                                <VoiceMessageBubble uri={media.url} durationSeconds={media.durationSeconds} isMe={isMeVoice} />
                              </View>
                              <Text style={styles.logMsgTime}>{formatTime(msg.timestamp)}</Text>
                            </View>
                          );
                        }

                        if (media) {
                          const isMeMedia = msg.sender === 'me';
                          return (
                            <View key={msg.id} style={[styles.logCallWrapper, isMeMedia ? styles.logRowMe : styles.logRowThem]}>
                              <Text style={styles.logMsgSender}>
                                {isMeMedia ? selectedKidForLogs?.name : selectedBuddyForLogs?.name}
                              </Text>
                              <View style={{ marginTop: 2 }}>
                                <ChatMediaBubble uri={media.url} size={s(160)} borderRadius={s(16)} />
                              </View>
                              <Text style={styles.logMsgTime}>{formatTime(msg.timestamp)}</Text>
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
                            <Text style={styles.logMsgTime}>{formatTime(msg.timestamp)}</Text>
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

                {/* Add Relative Section — a grandparent, aunt/uncle, second parent, etc. who
                    isn't one of this kid's own registered parents, added by email instead of a
                    Cookie Code (they likely don't have the kid's code on hand, and may not even
                    have a Crumbo account yet). */}
                <View style={styles.addBuddySection}>
                  <Text style={styles.addBuddyTitle}>Add a Relative</Text>
                  <Text style={styles.addRelativeHint}>
                    For grandparents, aunts/uncles, or a second parent — connects by email instead of a Cookie Code.
                  </Text>

                  <TextInput
                    style={styles.buddyInput}
                    placeholder="Relative's Name (e.g. Grandma)"
                    placeholderTextColor="#A1887F"
                    value={newRelativeName}
                    onChangeText={setNewRelativeName}
                  />

                  <TextInput
                    style={styles.buddyInput}
                    placeholder="Relative's Email Address"
                    placeholderTextColor="#A1887F"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={newRelativeEmail}
                    onChangeText={setNewRelativeEmail}
                  />

                  <TouchableOpacity style={styles.addBuddySubmitBtn} onPress={handleAddRelativeToKid} disabled={syncing}>
                    {syncing ? (
                      <ActivityIndicator color="#4E342E" />
                    ) : (
                      <Text style={styles.addBuddySubmitText}>Add Relative by Email</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </>
            )}
          </TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* Show QR Code Modal */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={qrCodeVisible}
        onRequestClose={() => setQrCodeVisible(false)}
      >
        <TouchableOpacity style={styles.modalOverlayCentered} activeOpacity={1} onPress={() => setQrCodeVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.qrCodeDialog}>
            <Text style={styles.dialogTitle}>{selectedKidForLogs?.name}'s QR Code</Text>
            <Text style={styles.qrCodeSubtitle}>Let another parent scan this to pair immediately!</Text>
            
            {selectedKidForLogs && (
              // Rendered locally (react-native-qrcode-svg) rather than fetched from a third-party
              // QR image service — that previously sent the kid's name and cookie code out over
              // the network to api.qrserver.com, contradicting the app's "no child data is ever
              // collected" promise, and needed network access just to show a pairing code.
              <View style={styles.qrCodeImage}>
                <QRCode
                  value={JSON.stringify({ crumType: 'buddy_qr', cookieCode: selectedKidForLogs.cookieCode, name: selectedKidForLogs.name })}
                  size={200}
                  backgroundColor="transparent"
                />
              </View>
            )}

            <Text style={styles.qrCodeText}>{selectedKidForLogs?.cookieCode}</Text>

            <TouchableOpacity style={styles.dialogCloseBtn} onPress={() => setQrCodeVisible(false)}>
              <Text style={styles.dialogCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* QR Scanner Modal */}
      <Modal
        animationType="slide"
        transparent={false}
        visible={qrScannerVisible}
        onRequestClose={() => setQrScannerVisible(false)}
      >
        <SafeAreaView style={styles.scannerContainer}>
          {/* react-native's own SafeAreaView (imported above) only insets on iOS — Android needs
              this padding computed explicitly, same as every other header in the app, or this
              title sits directly under the status bar. */}
          <View style={[styles.scannerHeader, { paddingTop: Platform.OS === 'android' ? insets.top + 14 : 14 }]}>
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
                if (qrScanHandledRef.current) return;
                qrScanHandledRef.current = true;
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
        <TouchableOpacity style={styles.modalOverlayCentered} activeOpacity={1} onPress={() => setAddKidModalVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalDialog}>
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
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
      {/* Edit Preferred Name Modal */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={editNameModalVisible}
        onRequestClose={() => setEditNameModalVisible(false)}
      >
        <TouchableOpacity style={styles.modalOverlayCentered} activeOpacity={1} onPress={() => setEditNameModalVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.modalDialog}>
            <Text style={styles.dialogTitle}>Edit Your Name</Text>

            <Text style={styles.dialogLabel}>This is the name shown to your kids and any paired parents:</Text>
            <TextInput
              style={styles.dialogInput}
              placeholder="e.g. Mom"
              placeholderTextColor="#A1887F"
              value={editNameInput}
              onChangeText={setEditNameInput}
              autoFocus={true}
            />

            <View style={styles.dialogButtons}>
              <TouchableOpacity
                style={styles.dialogBtnCancel}
                onPress={() => setEditNameModalVisible(false)}
              >
                <Text style={styles.dialogBtnCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.dialogBtnCreate}
                onPress={handleSaveParentName}
                disabled={syncing}
              >
                {syncing ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.dialogBtnCreateText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
      <CustomAlertModal
        visible={alertConfig.visible}
        title={alertConfig.title}
        message={alertConfig.message}
        buttons={alertConfig.buttons}
        onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
      />
      <OnboardingModal
        visible={onboardingVisible}
        onDone={() => setOnboardingVisible(false)}
      />
      <AdultAvatarPickerModal
        visible={avatarPicker.pickerVisible}
        currentAvatarUrl={parentAvatarUrl}
        currentAvatarEmoji={parentAvatarEmoji}
        onClose={avatarPicker.closePicker}
        onTakePhoto={avatarPicker.takePhoto}
        onChooseFromGallery={avatarPicker.chooseFromGallery}
        onRemovePhoto={avatarPicker.removePhoto}
        onSelectPreset={avatarPicker.selectPreset}
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
  deviceDataSection: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
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
    flexDirection: 'column',
    gap: 16,
  },
  togglesGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
    alignSelf: 'flex-start',
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
  modalOverlayTouchable: {
    flex: 1,
    width: '100%',
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
  addRelativeHint: {
    fontSize: 12,
    color: '#8D6E63',
    fontWeight: '600',
    marginTop: -6,
    marginBottom: 12,
    lineHeight: 16,
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
    marginVertical: 4,
    maxWidth: '85%',
  },
  logRowCenter: {
    alignSelf: 'center',
  },
  logRowMe: {
    alignSelf: 'flex-end',
  },
  logRowThem: {
    alignSelf: 'flex-start',
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
  logCallIcon: {
    marginRight: 2,
  },
  logCallText: {
    fontSize: 13,
    fontWeight: '700',
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
