import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, SafeAreaView, ActivityIndicator, Platform, Modal, TextInput, KeyboardAvoidingView, ScrollView } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { StorageService, KidProfile } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';

export default function WelcomeScreen() {
  const router = useRouter();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  const [profile, setProfile] = useState<KidProfile | null>(null);

  const [cookieCodeInput, setCookieCodeInput] = useState('');
  const [syncing, setSyncing] = useState(false);

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
      setSubscribed(isSub);
      setProfile(kidProf);
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

    setSyncing(true);
    try {
      const kidProfile = await StorageService.loginKidWithCode(code);
      if (kidProfile) {
        setProfile(kidProfile);
        setSubscribed(true);
        setCookieCodeInput('');
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
      showAlert("Error", "An error occurred during login. Please try again.");
    } finally {
      setSyncing(false);
    }
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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView 
          contentContainerStyle={[styles.content, { flex: 0, flexGrow: 1 }]} 
          keyboardShouldPersistTaps="handled"
        >
          {/* Brand Header */}
          <View style={styles.brandContainer}>
            <Image 
              source={require('@/assets/images/logo.png')} 
              style={[styles.logo, { width: s(140), height: s(140) }]}
              resizeMode="contain"
            />
            <Text style={[styles.title, { fontSize: s(48), color: colors.text }]}>Crumbo</Text>
            <Text style={[styles.subtitle, { fontSize: s(16), color: colors.textSecondary }]}>The cookie-jar chat messenger for kids!</Text>
          </View>

          {/* Dynamic Action Card */}
          <View style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.border, shadowColor: colors.textSecondary }]}>
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

          {/* Footer Area for parents */}
          <View style={styles.footer}>
            <TouchableOpacity 
              style={styles.linkButton} 
              onPress={() => router.push('/parent/gate')}
            >
              <Text style={[styles.linkButtonText, { fontSize: s(14), color: colors.textSecondary }]}>Parents Area (Setup & Controls)</Text>
            </TouchableOpacity>
            <Text style={[styles.privacyText, { fontSize: s(11), color: colors.textSecondary }]}>
              Privacy promise: No child data will ever be collected or stored.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  brandContainer: {
    alignItems: 'center',
    marginTop: 40,
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
  linkButton: {
    padding: 8,
  },
  linkButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#8D6E63',
    textDecorationLine: 'underline',
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
