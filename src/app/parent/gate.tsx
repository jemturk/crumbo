import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, SafeAreaView, Platform, ActivityIndicator, KeyboardAvoidingView, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StorageService } from '@/services/storage';
import { supabase } from '@/services/supabase';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';

// At least 8 characters, one letter, one number, one special character.
const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_REQUIREMENTS_TEXT = 'Password must be at least 8 characters and include a letter, a number, and a special character.';

export default function ParentGate() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();
  
  // Mode: 'signin' | 'register'
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);

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

  const handleResendVerification = async (email: string) => {
    const { error: resendError } = await supabase.auth.resend({ type: 'signup', email });
    if (resendError) {
      showAlert("Error", "Could not resend the verification email. Please try again shortly.");
    } else {
      showAlert("Email Sent", `A new verification link was sent to ${email}.`);
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

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: pwd });

    if (signInError) {
      setLoading(false);
      setError(true);
      if (signInError.code === 'email_not_confirmed') {
        showAlert("Verify Your Email", "Please confirm your email address before signing in — check your inbox for the verification link.", [
          { text: "Resend Email", onPress: () => handleResendVerification(email) },
          { text: "OK", style: "cancel" },
        ]);
      } else if (signInError.code === 'invalid_credentials') {
        setPasswordInput('');
        showAlert("Access Denied", "Incorrect email or password. Please try again.");
      } else {
        console.error('Sign-in error:', signInError.code, signInError.status, signInError.message);
        showAlert("Sign In Failed", `${signInError.message} (${signInError.code || 'unknown'})`);
      }
      return;
    }

    try {
      await StorageService.saveParentEmail(email);
      const restored = await StorageService.fetchAndRestoreParentData(email);
      if (!restored) {
        // Signed in but no data row yet (shouldn't normally happen — register creates one).
        // Set subscribed first — createParentAccount bakes the CURRENT isSubscribed() flag into
        // the row it creates, so setting it after would create the row as subscribed:false.
        await StorageService.setSubscribed(true);
        await StorageService.createParentAccount(email);
      }
      setLoading(false);
      router.replace('/parent/dashboard');
    } catch (e) {
      setLoading(false);
      showAlert("Connection Error", "Could not restore your account data. Please check your network.");
    }
  };

  const handleForgotPassword = async () => {
    const email = emailInput.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      showAlert("Email Required", "Enter your email address above first, then tap \"Forgot password?\" again.");
      return;
    }

    setLoading(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'crumbo://reset-password',
    });
    setLoading(false);

    // Supabase intentionally reports success here even for an email with no account, to avoid
    // leaking which emails are registered — so this message is shown either way.
    if (resetError) {
      if (resetError.code === 'over_email_send_rate_limit') {
        showAlert("Too Many Requests", "Supabase's shared email sender is rate-limited — please wait a bit before requesting another reset email.");
      } else {
        console.error('Reset password error:', resetError.code, resetError.status, resetError.message);
        showAlert("Error", `${resetError.message} (${resetError.code || 'unknown'})`);
      }
    } else {
      showAlert("Check Your Email 📬", `If an account exists for ${email}, a password reset link has been sent.`);
    }
  };

  const handleRegister = async () => {
    const email = emailInput.trim().toLowerCase();
    const pwd = passwordInput.trim();

    if (!email || !email.includes('@')) {
      showAlert("Invalid Email", "Please enter a valid parent email address.");
      return;
    }
    if (!PASSWORD_COMPLEXITY_REGEX.test(pwd)) {
      showAlert("Weak Password", PASSWORD_REQUIREMENTS_TEXT);
      return;
    }

    setLoading(true);
    setError(false);

    try {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password: pwd,
        options: { emailRedirectTo: 'crumbo://' },
      });

      if (signUpError) {
        setLoading(false);
        if (signUpError.code === 'user_already_exists') {
          showAlert("Account Exists", "An account with this email already exists. Please sign in.", [
            { text: "OK", onPress: () => setMode('signin') }
          ]);
        } else if (signUpError.code === 'weak_password') {
          showAlert("Weak Password", PASSWORD_REQUIREMENTS_TEXT);
        } else if (signUpError.code === 'over_email_send_rate_limit') {
          showAlert("Too Many Requests", "Supabase's shared email sender is rate-limited — please wait a bit before trying to register again.");
        } else {
          console.error('Sign-up error:', signUpError.code, signUpError.status, signUpError.message);
          showAlert("Registration Failed", `${signUpError.message} (${signUpError.code || 'unknown'})`);
        }
        return;
      }

      // Supabase's signUp returns success (rather than an error, to avoid leaking which emails
      // are registered) for an email that already has a CONFIRMED account — surfaced as an
      // empty identities array instead of a new one.
      if (signUpData.user && signUpData.user.identities && signUpData.user.identities.length === 0) {
        setLoading(false);
        showAlert("Account Exists", "An account with this email already exists. Please sign in.", [
          { text: "OK", onPress: () => setMode('signin') }
        ]);
        return;
      }

      await StorageService.saveParentEmail(email);
      // A brand-new account has no kids of its own — clear any previous account's cached kids
      // list rather than leaving it in place (see clearManagedKidsCache).
      await StorageService.clearManagedKidsCache();
      // Order matters: createParentAccount builds the server row's payload from the CURRENT
      // local isSubscribed() flag, so it must be set true first — otherwise the row is created
      // with subscribed:false baked in, and a kid's device later mirrors that false value down
      // from the parent's row and gets locked out of their own already-active chat jar.
      await StorageService.setSubscribed(true); // Default active status on register
      const result = await StorageService.createParentAccount(email);
      if (result === 'exists') {
        // A row for this email already existed (e.g. from before this app's auth migration) —
        // refresh it to match this device's current, correct state rather than leaving stale
        // data (an old subscribed:false, an old kids list, etc.) sitting on the server.
        await StorageService.syncParentData();
      }

      setLoading(false);

      if (!signUpData.session) {
        // Email confirmation is required before sign-in will succeed.
        showAlert("Verify Your Email 📬", `We've sent a verification link to ${email}. Please confirm it, then sign in.`, [
          { text: "OK", onPress: () => setMode('signin') }
        ]);
      } else {
        showAlert("Registration Complete! 🔒", "Your parent account and subscription are now active.", [
          { text: "OK", onPress: () => router.replace('/parent/dashboard') }
        ]);
      }
    } catch (e) {
      setLoading(false);
      showAlert("Error", "Could not complete registration. Please check your connection.");
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Close button lives outside the KeyboardAvoidingView/ScrollView entirely (like the
          equivalent buttons on index.tsx) so it can't get caught up in Android's keyboard-open
          resize of that container — that resize was pushing this button's own padding around
          and shoving it up under the status bar. */}
      <View style={{ position: 'absolute', top: insets.top + s(4), right: s(16), zIndex: 10 }}>
        <TouchableOpacity style={{ padding: s(8) }} onPress={() => router.back()}>
          <Ionicons name="close-circle" size={s(36)} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { flex: 0, flexGrow: 1, paddingBottom: s(24) }]}
          keyboardShouldPersistTaps="handled"
        >
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
              <View style={styles.passwordFieldWrapper}>
                <TextInput
                  style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingLeft: s(20), paddingRight: s(48), marginBottom: s(14) }, error && styles.inputError]}
                  placeholder="Parent Password"
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry={!showPassword}
                  value={passwordInput}
                  onChangeText={setPasswordInput}
                  onSubmitEditing={handleSignIn}
                />
                <TouchableOpacity
                  style={[styles.passwordVisibilityBtn, { right: s(14), bottom: s(14) }]}
                  onPress={() => setShowPassword(!showPassword)}
                >
                  <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={s(20)} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity onPress={handleForgotPassword} style={styles.forgotPasswordBtn} disabled={loading}>
                <Text style={[styles.forgotPasswordText, { color: colors.textSecondary, fontSize: s(13) }]}>Forgot password?</Text>
              </TouchableOpacity>

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
              <View style={styles.passwordFieldWrapper}>
                <TextInput
                  style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingLeft: s(20), paddingRight: s(48), marginBottom: s(6) }, error && styles.inputError]}
                  placeholder="Create Password"
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry={!showPassword}
                  value={passwordInput}
                  onChangeText={setPasswordInput}
                  onSubmitEditing={handleRegister}
                />
                <TouchableOpacity
                  style={[styles.passwordVisibilityBtn, { right: s(14), bottom: s(6) }]}
                  onPress={() => setShowPassword(!showPassword)}
                >
                  <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={s(20)} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.passwordHintText, { color: colors.textSecondary, fontSize: s(12), marginBottom: s(14) }]}>
                {PASSWORD_REQUIREMENTS_TEXT}
              </Text>

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
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
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
  passwordFieldWrapper: {
    width: '100%',
    position: 'relative',
  },
  passwordVisibilityBtn: {
    position: 'absolute',
    top: 0,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  passwordHintText: {
    width: '100%',
    fontWeight: '600',
    lineHeight: 16,
  },
  forgotPasswordBtn: {
    width: '100%',
    alignItems: 'flex-end',
    marginBottom: 8,
  },
  forgotPasswordText: {
    fontWeight: '700',
    textDecorationLine: 'underline',
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
