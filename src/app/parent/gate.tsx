import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, SafeAreaView, Platform, ActivityIndicator, KeyboardAvoidingView, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StorageService } from '@/services/storage';
import { supabase } from '@/services/supabase';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';

export default function ParentGate() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();
  
  // Mode: 'signin' | 'register'
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [confirmInput, setConfirmInput] = useState('');
  
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

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

  useEffect(() => {
    prefillEmail();
  }, []);

  const prefillEmail = async () => {
    try {
      const email = await StorageService.getParentEmail();
      if (email) {
        setEmailInput(email);
      }
    } catch (e) {
      console.error("Error prefilling email", e);
    }
  };

  const handleSignIn = async () => {
    const email = emailInput.trim().toLowerCase();
    const pwd = passwordInput.trim();

    if (!email || !email.includes('@')) {
      showAlert("Invalid Email", "Please enter a valid parent email address.");
      return;
    }
    if (!pwd) {
      showAlert("Password Required", "Please enter your password.");
      return;
    }

    setLoading(true);
    setError(false);

    try {
      const { data, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('cookie_code', `PARENT:${email}`)
        .single();

      if (fetchError || !data || !data.push_token) {
        setLoading(false);
        setError(true);
        showAlert("Account Not Found", "No account found with this email. Please register first.");
        return;
      }

      const payload = JSON.parse(data.push_token);
      
      if (payload.parentPassword === pwd) {
        // Correct password! Call restore helper to pull profile
        await StorageService.fetchAndRestoreParentData(email);
        await StorageService.saveParentPassword(pwd);

        setLoading(false);
        router.replace('/parent/dashboard');
      } else {
        setLoading(false);
        setError(true);
        setPasswordInput('');
        showAlert("Access Denied", "Incorrect password. Please try again.");
      }
    } catch (e) {
      setLoading(false);
      showAlert("Connection Error", "Could not connect to the database. Please check your network.");
    }
  };

  const handleRegister = async () => {
    const email = emailInput.trim().toLowerCase();
    const pwd = passwordInput.trim();
    const confirm = confirmInput.trim();

    if (!email || !email.includes('@')) {
      showAlert("Invalid Email", "Please enter a valid parent email address.");
      return;
    }
    if (pwd.length < 4) {
      showAlert("Weak Password", "Please set a password of at least 4 characters.");
      return;
    }
    if (pwd !== confirm) {
      showAlert("Passwords Match", "The passwords you entered do not match. Please try again.");
      return;
    }

    setLoading(true);
    setError(false);

    try {
      // Check if email already exists in Supabase
      const { data } = await supabase
        .from('profiles')
        .select('cookie_code')
        .eq('cookie_code', `PARENT:${email}`)
        .single();

      if (data) {
        setLoading(false);
        showAlert("Account Exists", "An account with this email already exists. Please sign in.", [
          { text: "OK", onPress: () => setMode('signin') }
        ]);
        return;
      }

      // Save credentials locally
      await StorageService.saveParentEmail(email);
      await StorageService.saveParentPassword(pwd);
      await StorageService.setSubscribed(true); // Default active status on register

      // Sync settings to Supabase
      await StorageService.syncParentData();

      setLoading(false);
      showAlert("Registration Complete! 🔒", "Your parent account and subscription are now active.", [
        { text: "OK", onPress: () => router.replace('/parent/dashboard') }
      ]);
    } catch (e) {
      setLoading(false);
      showAlert("Error", "Could not complete registration. Please check your connection.");
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView 
          contentContainerStyle={[styles.content, { flex: 0, flexGrow: 1, paddingBottom: s(24) }]} 
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={[styles.header, { width: '100%', paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + s(8) : s(40)) : s(10) }]}>
            <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
              <Ionicons name="close-circle" size={s(36)} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={[styles.iconContainer, { backgroundColor: isDark ? colors.cardBg : '#FFEFC0', borderColor: isDark ? colors.borderStrong : '#FFD966', width: s(80), height: s(80), borderRadius: s(40), borderWidth: 2 }]}>
            <Text style={[styles.lockIcon, { fontSize: s(40) }]}>🔒</Text>
          </View>

          <Text style={[styles.title, { color: colors.text, fontSize: s(32), marginBottom: s(8) }]}>Parent Controls</Text>
          
          <Text style={[styles.subtitle, { color: colors.textSecondary, fontSize: s(14), lineHeight: s(20), marginBottom: s(24) }]}>
            Sign in or register to manage controls, buddy requests, and limits.
          </Text>

          {/* Tab Selection */}
          <View style={[styles.tabContainer, { backgroundColor: isDark ? colors.inputBg : '#FFFDF0', borderColor: colors.borderStrong, borderRadius: s(25), padding: s(4), marginBottom: s(24) }]}>
            <TouchableOpacity 
              style={[styles.tabButton, { borderRadius: s(20) }, mode === 'signin' ? { backgroundColor: colors.primaryBtn } : styles.tabButtonInactive]} 
              onPress={() => { setMode('signin'); setError(false); }}
            >
              <Text style={[styles.tabText, { fontSize: s(15) }, mode === 'signin' ? { color: colors.primaryBtnText } : { color: colors.textSecondary }]}>Sign In</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.tabButton, { borderRadius: s(20) }, mode === 'register' ? { backgroundColor: colors.primaryBtn } : styles.tabButtonInactive]} 
              onPress={() => { setMode('register'); setError(false); }}
            >
              <Text style={[styles.tabText, { fontSize: s(15) }, mode === 'register' ? { color: colors.primaryBtnText } : { color: colors.textSecondary }]}>Register</Text>
            </TouchableOpacity>
          </View>

          {mode === 'signin' ? (
            <View style={styles.formWidth}>
              {/* Email Input */}
              <TextInput
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingHorizontal: s(20), marginBottom: s(14) }, error && styles.inputError]}
                placeholder="Email Address"
                placeholderTextColor={colors.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                value={emailInput}
                onChangeText={setEmailInput}
              />

              {/* Password Input */}
              <TextInput
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingHorizontal: s(20), marginBottom: s(14) }, error && styles.inputError]}
                placeholder="Parent Password"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry={true}
                value={passwordInput}
                onChangeText={setPasswordInput}
                onSubmitEditing={handleSignIn}
              />

              {/* Submit Button */}
              <TouchableOpacity style={[styles.verifyButton, { backgroundColor: colors.primaryBtn, borderRadius: s(20), paddingVertical: s(16), marginTop: s(8) }]} onPress={handleSignIn} disabled={loading}>
                {loading ? (
                  <ActivityIndicator color={colors.primaryBtnText} />
                ) : (
                  <Text style={[styles.verifyButtonText, { fontSize: s(16), color: colors.primaryBtnText }]}>Sign In</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.formWidth}>
              {/* Email Input */}
              <TextInput
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingHorizontal: s(20), marginBottom: s(14) }, error && styles.inputError]}
                placeholder="Email Address"
                placeholderTextColor={colors.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                value={emailInput}
                onChangeText={setEmailInput}
              />

              {/* Create Password Input */}
              <TextInput
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingHorizontal: s(20), marginBottom: s(14) }, error && styles.inputError]}
                placeholder="Create Password"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry={true}
                value={passwordInput}
                onChangeText={setPasswordInput}
              />

              {/* Confirm Password Input */}
              <TextInput
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingHorizontal: s(20), marginBottom: s(14) }, error && styles.inputError]}
                placeholder="Confirm Password"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry={true}
                value={confirmInput}
                onChangeText={setConfirmInput}
                onSubmitEditing={handleRegister}
              />

              {/* Submit Button */}
              <TouchableOpacity style={[styles.verifyButton, { backgroundColor: colors.primaryBtn, borderRadius: s(20), paddingVertical: s(16), marginTop: s(8) }]} onPress={handleRegister} disabled={loading}>
                {loading ? (
                  <ActivityIndicator color={colors.primaryBtnText} />
                ) : (
                  <Text style={[styles.verifyButtonText, { fontSize: s(16), color: colors.primaryBtnText }]}>Register & Subscribe</Text>
                )}
              </TouchableOpacity>
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
    justifyContent: 'flex-end',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 40 : 10,
  },
  closeButton: {
    padding: 4,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    marginTop: -30,
  },
  iconContainer: {
    backgroundColor: '#FFEFC0',
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 2,
    borderColor: '#FFD966',
  },
  lockIcon: {
    fontSize: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: '900',
    color: '#4E342E',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#795548',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
    fontWeight: '600',
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#FFFDF0',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    borderRadius: 25,
    padding: 4,
    marginBottom: 24,
    width: '100%',
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 20,
  },
  tabButtonActive: {
    backgroundColor: '#FFC93C',
  },
  tabButtonInactive: {
    backgroundColor: 'transparent',
  },
  tabText: {
    fontSize: 15,
    fontWeight: '800',
  },
  tabTextActive: {
    color: '#4E342E',
  },
  tabTextInactive: {
    color: '#A1887F',
  },
  formWidth: {
    width: '100%',
    alignItems: 'center',
  },
  input: {
    backgroundColor: '#FFFFFF',
    width: '100%',
    height: 52,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#FFD966',
    paddingHorizontal: 20,
    fontSize: 16,
    fontWeight: '600',
    color: '#4E342E',
    marginBottom: 14,
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
  },
  inputError: {
    borderColor: '#E57373',
    backgroundColor: '#FFEBEE',
  },
  verifyButton: {
    backgroundColor: '#FFC93C',
    borderRadius: 20,
    paddingVertical: 16,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#FFC93C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 3,
    marginTop: 8,
  },
  verifyButtonText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#4E342E',
  },
});
