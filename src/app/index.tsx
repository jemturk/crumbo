import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, SafeAreaView, ActivityIndicator, Platform, Modal, TextInput, KeyboardAvoidingView, ScrollView, Keyboard } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { StorageService, KidProfile } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import AppSettingsModal from '@/components/AppSettingsModal';
import OnboardingModal from '@/components/OnboardingModal';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function WelcomeScreen() {
  const router = useRouter();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  const [profile, setProfile] = useState<KidProfile | null>(null);

  const [cookieCodeInput, setCookieCodeInput] = useState('');
  const [claimCodeInput, setClaimCodeInput] = useState('');
  const [claimCodeNeeded, setClaimCodeNeeded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow',
      () => setKeyboardVisible(true)
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide',
      () => setKeyboardVisible(false)
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

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
      checkAppState();
    }, [])
  );

  const checkAppState = async () => {
    try {
      setLoading(true);
      const isSub = await StorageService.isSubscribed();
      const kidProf = await StorageService.getKidProfile();
      const seenOnboarding = await StorageService.hasSeenOnboarding();
      setSubscribed(isSub);
      setProfile(kidProf);
      setOnboardingVisible(!seenOnboarding);
    } catch (e) {
      console.error("Error loading app state", e);
    } finally {
      setLoading(false);
    }
  };

  const handleKidLogin = async () => {
    const code = cookieCodeInput.trim().toUpperCase();
    const codePattern = /^CRUM-\d{3}-\d{3}$/;
    
    if (!codePattern.test(code)) {
      showAlert(
        "Invalid Cookie Code", 
        "Code should look like CRUM-123-456. Ask your parent for your code!"
      );
      return;
    }

    if (claimCodeNeeded && !claimCodeInput.trim()) {
      showAlert("Activation Code Required", "Ask a parent for the Activation Code shown in the Parent Area, then enter it below.");
      return;
    }

    setSyncing(true);
    try {
      const kidProfile = await StorageService.loginKidWithCode(code, claimCodeInput.trim() || undefined);
      if (kidProfile) {
        setProfile(kidProfile);
        setSubscribed(true);
        setCookieCodeInput('');
        setClaimCodeInput('');
        setClaimCodeNeeded(false);
        showAlert("Welcome! 🍪", `Logged in as ${kidProfile.name}!`, [
          { text: "OK", onPress: () => { router.push('/chat'); } }
        ]);
      } else {
        showAlert(
          "Profile Not Found",
          "Could not find a kid profile with this Cookie Code. Please verify the code in the parent dashboard."
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'DEVICE_MISMATCH') {
        showAlert(
          "Already Logged In Elsewhere",
          "This Cookie Code is already active on another device. If this is your kid's new phone, ask a parent to deactivate the old device from the Parent Area."
        );
      } else if (e instanceof Error && e.message === 'CLAIM_CODE_REQUIRED') {
        setClaimCodeNeeded(true);
        showAlert(
          "Activation Code Needed",
          "This Cookie Code was freed up from another device. Ask a parent for the one-time Activation Code shown in the Parent Area, then enter it below and try again."
        );
      } else if (e instanceof Error && e.message === 'CLAIM_CODE_INVALID') {
        showAlert(
          "Invalid or Expired Code",
          "That Activation Code is wrong or has expired. Ask a parent to deactivate the old device again to get a fresh one."
        );
      } else {
        showAlert("Connection Error", "Could not connect to the database. Please check your network.");
      }
    } finally {
      setSyncing(false);
    }
  };

  const handleOnboardingDone = async () => {
    setOnboardingVisible(false);
    await StorageService.setOnboardingSeen();
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
            setProfile(null);
            setSubscribed(false);
          }
        }
      ]
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
      {/* Top right help + settings buttons */}
      <View style={{ position: 'absolute', top: insets.top + s(4), right: s(16), zIndex: 10, flexDirection: 'row', alignItems: 'center' }}>
        <TouchableOpacity
          style={{ padding: s(8) }}
          onPress={() => setOnboardingVisible(true)}
        >
          <Ionicons name="help-circle" size={s(26)} color={colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={{ padding: s(8) }}
          onPress={() => setSettingsVisible(true)}
        >
          <Ionicons name="settings" size={s(26)} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView 
          contentContainerStyle={[styles.content, { flex: 0, flexGrow: 1 }]} 
          keyboardShouldPersistTaps="handled"
        >
          {/* Brand Header — centered within the whole region above the card (not just anchored
              to the top with a spacer below it), so it sits in the middle of that space rather
              than hugging the status bar. */}
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <View style={styles.brandContainer}>
              <Image
                source={require('@/assets/images/logo.png')}
                style={[styles.logo, { width: s(112), height: s(112) }]}
                resizeMode="contain"
              />
              <Text style={[styles.title, { fontSize: s(40), color: colors.text }]}>Crumbo</Text>
              <Text style={[styles.subtitle, { fontSize: s(16), color: colors.textSecondary }]}>The cookie-jar chat messenger for kids!</Text>
            </View>
          </View>

          {/* Dynamic Action Card */}
          <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, shadowColor: colors.textSecondary }]}>
            {profile && (
              <TouchableOpacity
                style={{ position: 'absolute', top: s(12), right: s(12), padding: s(4), zIndex: 10 }}
                onPress={handleLogout}
              >
                <Ionicons name="log-out-outline" size={s(20)} color="#D32F2F" />
              </TouchableOpacity>
            )}
            {profile ? (
              <View style={styles.cardContent}>
                <Text style={[styles.cardEmoji, { fontSize: s(48) }]}>🍪</Text>
                <Text style={[styles.cardTitle, { fontSize: s(22), color: colors.text }]}>Hey, {profile.name}!</Text>
                <Text style={[styles.cardText, { fontSize: s(14), lineHeight: s(20), color: colors.textSecondary }]}>
                  Your cookie jar is ready. Jump in to chat with your friends!
                </Text>
                <TouchableOpacity 
                  style={[styles.primaryButton, { backgroundColor: colors.primaryBtn }]}
                  onPress={() => router.push('/chat')}
                >
                  <Text style={[styles.primaryButtonText, { fontSize: s(18), color: colors.primaryBtnText }]}>Enter Cookie Jar 🍪</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={[styles.cardContent, { width: '100%' }]}>
                <Text style={[styles.cardEmoji, { fontSize: s(48) }]}>🍪</Text>
                <Text style={[styles.cardTitle, { fontSize: s(22), color: colors.text }]}>Ready to start chatting?</Text>
                <Text style={[styles.cardText, { fontSize: s(14), lineHeight: s(20), color: colors.textSecondary }]}>
                  Log in as a kid using the Cookie Code provided by your parent.
                </Text>
                <TextInput
                  style={[styles.input, { width: '100%', marginBottom: s(16), fontSize: s(16), backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong }]}
                  placeholder="Cookie Code (e.g. CRUM-123-456)"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  value={cookieCodeInput}
                  onChangeText={setCookieCodeInput}
                />
                {claimCodeNeeded && (
                  <TextInput
                    style={[styles.input, { width: '100%', marginBottom: s(16), fontSize: s(16), backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong }]}
                    placeholder="Activation Code from a parent"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    value={claimCodeInput}
                    onChangeText={setClaimCodeInput}
                  />
                )}
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: colors.primaryBtn }]}
                  onPress={handleKidLogin}
                  disabled={syncing}
                >
                  {syncing ? (
                    <ActivityIndicator color={colors.primaryBtnText} />
                  ) : (
                    <Text style={[styles.primaryButtonText, { fontSize: s(18), color: colors.primaryBtnText }]}>Kid Login 🍪</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Footer Area for parents — flex:1 fills the remaining space below the card and
              centers within it, so it sits midway to the bottom rather than hugging the card.
              Hidden while the keyboard is open so it doesn't get squeezed above it. */}
          {!keyboardVisible && (
            <View style={[styles.footer, { flex: 1, justifyContent: 'center' }]}>
              <TouchableOpacity
                style={[styles.secondaryButton, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong }]}
                onPress={() => router.push('/parent/gate')}
              >
                <Text style={[styles.secondaryButtonText, { fontSize: s(14), color: colors.actionBtnSecondaryText }]}>Parents Area (Setup & Controls)</Text>
              </TouchableOpacity>
              <Text style={[styles.privacyText, { fontSize: s(11), color: colors.textSecondary }]}>
                Privacy promise: No child data will ever be collected or stored.
              </Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
      />
      <OnboardingModal
        visible={onboardingVisible}
        onDone={handleOnboardingDone}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#FFFDF3',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    backgroundColor: '#FFFDF3',
  },
  content: {
    flex: 1,
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  brandContainer: {
    alignItems: 'center',
  },
  logo: {
    width: 140,
    height: 140,
    marginBottom: 16,
  },
  title: {
    fontSize: 48,
    fontWeight: '900',
    color: '#4E342E',
    letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'AvenirNext-Bold' : 'sans-serif-medium',
  },
  subtitle: {
    fontSize: 16,
    color: '#8D6E63',
    textAlign: 'center',
    marginTop: 8,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 28,
    padding: 24,
    width: '100%',
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 4,
    borderWidth: 2,
    borderColor: '#FFF5D1',
  },
  cardContent: {
    alignItems: 'center',
  },
  cardEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#4E342E',
    textAlign: 'center',
    marginBottom: 8,
  },
  cardText: {
    fontSize: 14,
    color: '#795548',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
    fontWeight: '500',
  },
  primaryButton: {
    backgroundColor: '#FFC93C',
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 32,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#FFC93C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 3,
  },
  primaryButtonText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#4E342E',
  },
  footer: {
    width: '100%',
    alignItems: 'center',
    gap: 12,
  },
  secondaryButton: {
    borderRadius: 20,
    borderWidth: 1.5,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontWeight: '700',
  },
  privacyText: {
    fontSize: 11,
    color: '#A1887F',
    textAlign: 'center',
    fontWeight: '600',
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
