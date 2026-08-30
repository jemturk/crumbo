import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, SafeAreaView, ActivityIndicator, Platform, KeyboardAvoidingView, ScrollView, Linking } from 'react-native';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import Constants from 'expo-constants';
import { StorageService, KidProfile } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import AdultAvatar from '@/components/AdultAvatar';
import AdultAvatarPickerModal from '@/components/AdultAvatarPickerModal';
import AppSettingsModal from '@/components/AppSettingsModal';
import AvatarPickerModal from '@/components/AvatarPickerModal';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import OnboardingModal from '@/components/OnboardingModal';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useParentAvatarPicker } from '@/hooks/use-parent-avatar-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Read from app.json (via app config, not hardcoded) so this can't drift out of sync with the
// actual shipped version.
const APP_VERSION = Constants.expoConfig?.version;

// Hosted as a static page on GitHub Pages (docs/privacy-policy.html), alongside
// reset-password.html/verify-email.html — not as a Supabase Edge Function. Supabase's edge
// gateway rewrites any text/html response to text/plain the moment a client sends its normal
// Accept-Encoding: gzip header, regardless of what the function itself sets — a documented
// platform restriction (HTML from Edge Functions needs a Pro plan + custom domain), not a bug.
const PRIVACY_POLICY_URL = 'https://jemturk.github.io/crumbo/privacy-policy.html';

export default function WelcomeScreen() {
  const router = useRouter();
  // Set only by a chat header's logout button (see chat/index.tsx and parent/chat/index.tsx) —
  // marks a deliberate hop back to this screen rather than a normal cold launch, so checkAppState
  // below knows to show the "Welcome back"/"Hey, {name}" card for the still-active kid or parent
  // instead of auto-redirecting straight back into their chat list.
  const { fromLogout } = useLocalSearchParams<{ fromLogout?: string }>();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [parentActive, setParentActive] = useState(false);
  const [parentName, setParentName] = useState<string | null>(null);
  const [parentAvatarUrl, setParentAvatarUrl] = useState<string | null>(null);
  const [parentAvatarEmoji, setParentAvatarEmoji] = useState<string | null>(null);

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [avatarPickerVisible, setAvatarPickerVisible] = useState(false);

  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    message: string;
    buttons?: AlertButton[];
  }>({ visible: false, title: '', message: '' });

  const showAlert = (title: string, message: string, buttons?: AlertButton[]) => {
    setAlertConfig({ visible: true, title, message, buttons });
  };

  const parentAvatarPicker = useParentAvatarPicker({
    onAvatarUrlChange: setParentAvatarUrl,
    onAvatarEmojiChange: setParentAvatarEmoji,
    showAlert,
  });

  const handleKidAvatarSelect = (emoji: string) => {
    setAvatarPickerVisible(false);
    // Optimistic: update immediately rather than waiting on the network round-trip.
    setProfile(prev => (prev ? { ...prev, avatarEmoji: emoji } : prev));
    StorageService.setKidAvatar(emoji).then((success) => {
      if (!success) {
        showAlert("Connection Error", "Could not save your new avatar. Please check your network and try again.");
      }
    });
  };

  useFocusEffect(
    useCallback(() => {
      checkAppState();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fromLogout])
  );

  const checkAppState = async () => {
    try {
      setLoading(true);
      const isSub = await StorageService.isSubscribed();
      let kidProf = await StorageService.getKidProfile();
      const isParentActive = await StorageService.isParentActiveOnDevice();

      // An active kid or parent on this device skips straight to their chat list — there's
      // nothing to decide here (activating/deactivating is a Parent Area action only, see the
      // card's own comment below), so landing on this screen first is just friction. replace()
      // (not push()) so this screen isn't left sitting in history — back-navigation shouldn't
      // return here. EXCEPT when they just came from a chat header's logout button (fromLogout)
      // — that's a deliberate hop back to this screen specifically to show the "Welcome back"
      // card below, not something to immediately redirect away from again.
      if (kidProf && !fromLogout) {
        // Repairs a lost Supabase Auth session (app killed and relaunched, token expiry, ...)
        // before this device ever reaches a screen that depends on it — see ensureKidSession's
        // own doc for why a lost session otherwise fails silently forever. It can also determine
        // this device is no longer the active one for this kid at all (e.g. a parent activated
        // them elsewhere) and clear the local profile itself — re-read rather than trusting the
        // `kidProf` captured above for everything below, or this would keep treating the kid as
        // active on a profile that no longer exists, looking active with no way to actually load
        // anything.
        await StorageService.ensureKidSession();
        kidProf = await StorageService.getKidProfile();
        if (kidProf) {
          router.replace('/chat');
          return;
        }
      }
      if (isParentActive && !fromLogout) {
        router.replace('/parent/chat');
        return;
      }

      const seenOnboarding = await StorageService.hasSeenOnboarding();
      setSubscribed(isSub);
      setParentActive(isParentActive);
      if (kidProf) {
        setProfile(kidProf);
        setOnboardingVisible(false);
      } else if (isParentActive) {
        setProfile(null);
        const [name, email, avatarUrl, avatarEmoji] = await Promise.all([
          StorageService.getParentName(),
          StorageService.getParentEmail(),
          StorageService.getParentAvatarUrl(),
          StorageService.getParentAvatarEmoji(),
        ]);
        setParentName(name || email);
        setParentAvatarUrl(avatarUrl);
        setParentAvatarEmoji(avatarEmoji);
        setOnboardingVisible(false);
      } else {
        // Neither is active (else we'd already have redirected or hit a branch above) — reset
        // any stale state from a previous run (e.g. a parent who was just deactivated via Parent
        // Area) and show the "no one's active here yet" card.
        setProfile(null);
        setOnboardingVisible(!seenOnboarding);
      }
    } catch (e) {
      console.error("Error loading app state", e);
    } finally {
      setLoading(false);
    }
  };

  const handleOnboardingDone = async () => {
    setOnboardingVisible(false);
    await StorageService.setOnboardingSeen();
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
          <Ionicons name="help-circle-outline" size={s(26)} color={colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={{ padding: s(8) }}
          onPress={() => setSettingsVisible(true)}
        >
          <Ionicons name="settings-outline" size={s(26)} color={colors.textSecondary} />
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

          {/* Dynamic Action Card — exactly one of profile (a kid) or parentActive can be true at
              a time (see activateKidOnThisDevice/activateParentOnDevice). There is no self-service
              login or logout here: activating OR deactivating anyone on this device is a Parent
              Area action only, to prevent an accidental one-tap deactivation from this screen. */}
          <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, shadowColor: colors.textSecondary }]}>
            {profile ? (
              <View style={styles.cardContent}>
                <TouchableOpacity onPress={() => setAvatarPickerVisible(true)}>
                  <Text style={[styles.cardEmoji, { fontSize: s(48) }]}>{profile.avatarEmoji || '🍪'}</Text>
                </TouchableOpacity>
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
            ) : parentActive ? (
              <View style={styles.cardContent}>
                <TouchableOpacity style={{ marginBottom: s(12) }} onPress={parentAvatarPicker.openPicker}>
                  <AdultAvatar uri={parentAvatarUrl || undefined} emoji={parentAvatarEmoji || undefined} size={s(64)} />
                </TouchableOpacity>
                <Text style={[styles.cardTitle, { fontSize: s(22), color: colors.text }]}>Welcome back{parentName ? `, ${parentName}` : ''}!</Text>
                <Text style={[styles.cardText, { fontSize: s(14), lineHeight: s(20), color: colors.textSecondary }]}>
                  You&apos;re active on this device. Jump in to chat with your kids or paired parents!
                </Text>
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: colors.primaryBtn }]}
                  onPress={() => router.push('/parent/chat')}
                >
                  <Text style={[styles.primaryButtonText, { fontSize: s(18), color: colors.primaryBtnText }]}>Enter 🍪</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={[styles.cardContent, { width: '100%' }]}>
                <Text style={[styles.cardEmoji, { fontSize: s(48) }]}>🍪</Text>
                <Text style={[styles.cardTitle, { fontSize: s(22), color: colors.text }]}>No one&apos;s active here yet</Text>
                <Text style={[styles.cardText, { fontSize: s(14), lineHeight: s(20), color: colors.textSecondary }]}>
                  Ask a parent to sign in to the Parents Area and activate a user on this device.
                </Text>
                <TouchableOpacity
                  style={[styles.primaryButton, { flexDirection: 'row', justifyContent: 'center', backgroundColor: colors.primaryBtn }]}
                  onPress={() => router.push('/parent/gate')}
                >
                  <Ionicons name="lock-closed" size={s(16)} color={colors.primaryBtnText} style={{ marginRight: s(6) }} />
                  <Text style={[styles.primaryButtonText, { fontSize: s(18), color: colors.primaryBtnText }]}>Parent Controls</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Footer Area — flex:1 fills the remaining space below the card, with the privacy
              promise and version centered in that space (where the "Parents Area" button used
              to sit) rather than pinned to the bottom edge. */}
          <View style={[styles.footer, { flex: 1, justifyContent: 'center' }]}>
            <Text style={[styles.privacyText, { fontSize: s(11), color: colors.textSecondary }]}>
              Privacy promise: Your family&apos;s messages stay private to your account, encrypted, and are never sold or shared with third parties.
            </Text>
            <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
              <Text style={[styles.privacyText, { fontSize: s(11), color: colors.textSecondary, textDecorationLine: 'underline' }]}>
                Read our Privacy Policy
              </Text>
            </TouchableOpacity>
            {APP_VERSION && (
              <Text style={[styles.versionText, { fontSize: s(10), color: colors.textSecondary }]}>
                v{APP_VERSION}
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <AppSettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        showParentControlsOption={true}
        onParentControlsPress={() => router.push('/parent/gate')}
      />
      <OnboardingModal
        visible={onboardingVisible}
        onDone={handleOnboardingDone}
      />
      <AvatarPickerModal
        visible={avatarPickerVisible}
        currentEmoji={profile?.avatarEmoji}
        onClose={() => setAvatarPickerVisible(false)}
        onSelect={handleKidAvatarSelect}
      />
      <CustomAlertModal
        visible={alertConfig.visible}
        title={alertConfig.title}
        message={alertConfig.message}
        buttons={alertConfig.buttons}
        onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
      />
      <AdultAvatarPickerModal
        visible={parentAvatarPicker.pickerVisible}
        currentAvatarUrl={parentAvatarUrl}
        currentAvatarEmoji={parentAvatarEmoji}
        onClose={parentAvatarPicker.closePicker}
        onTakePhoto={parentAvatarPicker.takePhoto}
        onChooseFromGallery={parentAvatarPicker.chooseFromGallery}
        onRemovePhoto={parentAvatarPicker.removePhoto}
        onSelectPreset={parentAvatarPicker.selectPreset}
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
  privacyText: {
    fontSize: 11,
    color: '#A1887F',
    textAlign: 'center',
    fontWeight: '600',
  },
  versionText: {
    fontSize: 10,
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
