import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, SafeAreaView, Platform, ActivityIndicator, KeyboardAvoidingView, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StorageService } from '@/services/storage';
import { supabase } from '@/services/supabase';
import { signInWithGoogle } from '@/services/googleAuth';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useAppTheme } from '@/hooks/use-app-theme';

// At least 8 characters, one uppercase letter, one lowercase letter, one number, one special character.
const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_REQUIREMENTS_TEXT = 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.';

// Web fallbacks (see docs/verify-email.html and docs/reset-password.html) for whoever opens the
// confirmation/reset email on a device without the app installed — these pages verify/reset
// there in the browser, then best-effort redirect into the app if it turns out to be installed
// after all. Replaces pointing straight at the crumbo:// scheme, which just silently failed with
// no fallback on a device (or a PC) that doesn't have the app.
//
// Hosted on GitHub Pages, not as Supabase Edge Functions — Supabase's edge gateway rewrites any
// text/html response to text/plain + nosniff the moment a real browser's default
// Accept-Encoding: gzip header is present, so these pages showed raw HTML source instead of
// rendering for every real user. Confirmed as a documented platform restriction (HTML from Edge
// Functions needs a Pro plan + custom domain), not fixable in the function code itself.
const VERIFY_EMAIL_REDIRECT_URL = 'https://jemturk.github.io/crumbo/verify-email.html';
const RESET_PASSWORD_REDIRECT_URL = 'https://jemturk.github.io/crumbo/reset-password.html';

// Google's official multi-color "G" mark — everything else on this button follows Crumbo's own
// theme, but the mark itself is required to stay full-color per Google's sign-in button branding
// guidelines, so it's the one un-themed element here. Rendered locally from the standard path
// data rather than fetched as an image, same reasoning as the QR codes elsewhere in this app.
function GoogleGLogo({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z" />
      <Path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z" />
      <Path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z" />
      <Path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z" />
    </Svg>
  );
}

export default function ParentGate() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { s } = useDisplayScale();
  const { theme, colors, isDark } = useAppTheme();
  
  // Mode: 'signin' | 'register' | 'reset' — 'reset' is the "enter the code we emailed you" step
  // of the forgot-password flow (see handleForgotPassword/handleCompletePasswordReset).
  const [mode, setMode] = useState<'signin' | 'register' | 'reset'>('signin');

  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [resetCodeInput, setResetCodeInput] = useState('');
  const [resetPasswordInput, setResetPasswordInput] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);

  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  // Biometric sign-in is opt-in (see BIOMETRIC_ENABLED) and only ever resumes an ALREADY
  // persisted Supabase session — it never substitutes for a fresh password sign-in, and holds no
  // credential of its own.
  const [biometricAvailable, setBiometricAvailable] = useState(false);

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
    checkBiometric();
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

  const checkBiometric = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      const enabled = await StorageService.isBiometricEnabled();
      const available = hasHardware && isEnrolled && enabled;
      setBiometricAvailable(available);
      if (available) {
        // Auto-attempt on arrival — the whole point of opting in is not having to also tap a
        // button every time — but the manual "Use Biometrics" button (rendered whenever
        // biometricAvailable is true) covers a dismissed/cancelled prompt without a full remount.
        handleBiometricSignIn(false);
      }
    } catch (e) {
      console.error("Error checking biometric availability", e);
    }
  };

  const handleBiometricSignIn = async (manual: boolean = true) => {
    const { data: { session } } = await supabase.auth.getSession();
    // No session at all, or an anonymous one — a kid activated on this device (see
    // activateKidOnThisDevice) replaces whatever parent session was persisted here with a fresh
    // anonymous one, which has no email. Either way there's no parent session left to resume.
    if (!session?.user?.email || session.user.is_anonymous) {
      // The silent auto-attempt on arrival shouldn't interrupt anyone — the password form below
      // still works either way. A manual tap producing literally nothing looks broken, though,
      // so that one gets an explicit explanation instead.
      if (manual) {
        showAlert("Sign In Required", "There's no signed-in session on this device to resume with biometrics — please sign in with your email and password below.");
      }
      return;
    }

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Sign in to Crumbo',
      cancelLabel: 'Use Password',
    });
    if (!result.success) return; // cancelled or failed — just fall back to the manual form

    const email = session.user.email;
    setLoading(true);
    try {
      await StorageService.saveParentEmail(email);
      const restored = await StorageService.fetchAndRestoreParentData(email);
      if (!restored) {
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
      await completeSignedInFlow(email);
    } catch (e) {
      setLoading(false);
      showAlert("Connection Error", "Could not restore your account data. Please check your network.");
    }
  };

  /**
   * Shared by every path that ends with a real Supabase session established (password sign-in,
   * biometric resume, Google sign-in/register) — restores or creates this account's server row,
   * then either offers to enable biometric sign-in or goes straight to the dashboard.
   * `fallbackName` is used only for a brand-new account with no row yet (e.g. Google provides a
   * display name for free, sparing a first-time Google user the Preferred Name field).
   */
  const completeSignedInFlow = async (email: string, fallbackName?: string) => {
    await StorageService.saveParentEmail(email);
    const restored = await StorageService.fetchAndRestoreParentData(email);
    if (!restored) {
      // Signed in but no data row yet (shouldn't normally happen for password sign-in — register
      // creates one — but is the normal case for a brand-new Google account, or a relative
      // completing an invite for the very first time).
      if (fallbackName) {
        await StorageService.saveParentName(fallbackName);
      }
      // Set subscribed first — createParentAccount bakes the CURRENT isSubscribed() flag into
      // the row it creates, so setting it after would create the row as subscribed:false.
      await StorageService.setSubscribed(true);
      await StorageService.createParentAccount(email);
      // First-time registration (Google, or a relative's first invite completion) — activate
      // the parent right away rather than leaving them signed in but inactive until they find
      // the manual "Activate" toggle in Parent Area.
      await StorageService.activateParentOnDevice();
    }

    // A relative invited via addRelativeToKidByEmail carries the pending kid link in their own
    // auth user_metadata until they actually finish signing up — complete it here, on every
    // sign-in, since this is the first point after ANY sign-in method where a real session (and
    // thus this metadata) is available. Idempotent and cheap when there's nothing pending.
    const { data: userData } = await supabase.auth.getUser();
    const pendingLinks = userData?.user?.user_metadata?.pendingRelativeLinks as
      { cookieCode: string; name: string; avatarEmoji?: string }[] | undefined;
    if (pendingLinks && pendingLinks.length > 0) {
      await StorageService.completePendingRelativeLinks(email, pendingLinks);
      await supabase.auth.updateUser({ data: { pendingRelativeLinks: null } });
    }

    setLoading(false);

    const alreadyEnabled = await StorageService.isBiometricEnabled();
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    if (!alreadyEnabled && hasHardware && isEnrolled) {
      showAlert("Enable Biometric Sign-In?", "Use Face ID or your fingerprint to sign in next time instead of typing your password.", [
        { text: "Not Now", style: "cancel", onPress: () => router.replace('/parent/dashboard') },
        {
          text: "Enable", onPress: async () => {
            await StorageService.setBiometricEnabled(true);
            router.replace('/parent/dashboard');
          }
        },
      ]);
      return;
    }

    router.replace('/parent/dashboard');
  };

  const handleGoogleAuth = async () => {
    setLoading(true);
    setError(false);

    const result = await signInWithGoogle();
    if (result.status === 'cancelled') {
      setLoading(false);
      return;
    }
    if (result.status === 'error') {
      setLoading(false);
      showAlert("Google Sign-In Failed", result.message);
      return;
    }

    try {
      await completeSignedInFlow(result.email, result.name || undefined);
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
    // redirectTo is now unused (the recovery email template shows a code, not a link — see
    // supabase/templates/recovery.html's own comment for why) but harmless to leave set.
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: RESET_PASSWORD_REDIRECT_URL,
    });
    setLoading(false);

    // Supabase intentionally reports success here even for an email with no account, to avoid
    // leaking which emails are registered — so this message is shown either way, and the code
    // step is shown regardless (entering a wrong/unregistered email's code just fails at verify
    // time with the same generic error as an expired code, which is the same non-leaking
    // property, just one step later).
    if (resetError) {
      if (resetError.code === 'over_email_send_rate_limit') {
        showAlert("Too Many Requests", "Supabase's shared email sender is rate-limited — please wait a bit before requesting another reset email.");
      } else {
        console.error('Reset password error:', resetError.code, resetError.status, resetError.message);
        showAlert("Error", `${resetError.message} (${resetError.code || 'unknown'})`);
      }
      return;
    }

    setResetCodeInput('');
    setResetPasswordInput('');
    setMode('reset');
  };

  /**
   * Completes the forgot-password flow with the 6-digit code from the recovery email (see
   * supabase/templates/recovery.html) instead of a magic link. Supabase's PKCE code-exchange
   * flow requires the exchange to happen in the SAME client that called resetPasswordForEmail
   * (confirmed: "both auth code and code verifier should be non-empty" when attempted from a
   * different browser/device) — since a reset is always requested from this app, a link opened
   * anywhere else (a PC, or even this same phone's browser) can never complete it. An emailed
   * code verified via verifyOtp has no such restriction: it's a server-side shared secret, not a
   * client-local code/verifier pairing, so it works from wherever the parent reads their email.
   */
  const handleCompletePasswordReset = async () => {
    const email = emailInput.trim().toLowerCase();
    const code = resetCodeInput.trim();
    const pwd = resetPasswordInput.trim();

    if (!code) {
      showAlert("Code Required", "Enter the 6-digit code from your email.");
      return;
    }
    if (!PASSWORD_COMPLEXITY_REGEX.test(pwd)) {
      showAlert("Weak Password", PASSWORD_REQUIREMENTS_TEXT);
      return;
    }

    setLoading(true);
    const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: code, type: 'recovery' });
    if (verifyError) {
      setLoading(false);
      showAlert("Invalid Code", "That code is incorrect or has expired. Request a new one from \"Forgot password?\".");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: pwd });
    setLoading(false);

    if (updateError) {
      showAlert("Error", `${updateError.message} (${updateError.code || 'unknown'})`);
      return;
    }

    // This session only exists to authorize the password change — sign out and send them
    // through the normal sign-in flow so fetchAndRestoreParentData runs as usual.
    await supabase.auth.signOut();
    setResetCodeInput('');
    setResetPasswordInput('');
    setMode('signin');
    showAlert("Password Updated 🔒", "Your password has been changed. Please sign in with your new password.");
  };

  const handleRegister = async () => {
    const email = emailInput.trim().toLowerCase();
    const pwd = passwordInput.trim();
    const name = nameInput.trim();

    if (!email || !email.includes('@')) {
      showAlert("Invalid Email", "Please enter a valid parent email address.");
      return;
    }
    if (!name) {
      showAlert("Name Required", "Please enter a preferred name.");
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
        // Points the confirmation email's link at the verify-email web page, which itself
        // redirects into the app on a device that has it (see VERIFY_EMAIL_REDIRECT_URL's own
        // comment) — landing back on this sign-in screen either way (this route defaults to
        // mode: 'signin').
        options: { emailRedirectTo: VERIFY_EMAIL_REDIRECT_URL },
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
      await StorageService.saveParentName(name);
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

      // Activate right away rather than leaving them registered-but-inactive until they find the
      // manual "Activate" toggle in Parent Area. Purely local, so it's fine to set even if email
      // confirmation is still pending below — by the time they actually sign in, it's already set.
      await StorageService.activateParentOnDevice();

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

          {/* Tab Selection — hidden mid-reset, same reasoning as reset-password.tsx's own close
              button only appearing once past the "exchanging" state: this step isn't a mode you
              tab into, it's a consequence of "Forgot password?" that should be finished or
              explicitly backed out of, not casually switched away from. */}
          {mode !== 'reset' && (
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
          )}

          {mode === 'reset' ? (
            <View style={styles.formWidth}>
              <Text style={[styles.subtitle, { color: colors.textSecondary, fontSize: s(14), lineHeight: s(20), marginBottom: s(20) }]}>
                Enter the 6-digit code we sent to {emailInput.trim()} along with your new password.
              </Text>

              <TextInput
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingHorizontal: s(20), marginBottom: s(14), textAlign: 'center', letterSpacing: s(4) }]}
                placeholder="123456"
                placeholderTextColor={colors.textSecondary}
                keyboardType="number-pad"
                maxLength={6}
                value={resetCodeInput}
                onChangeText={setResetCodeInput}
              />

              <View style={styles.passwordFieldWrapper}>
                <TextInput
                  style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingLeft: s(20), paddingRight: s(48), marginBottom: s(6) }]}
                  placeholder="New Password"
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry={!showResetPassword}
                  value={resetPasswordInput}
                  onChangeText={setResetPasswordInput}
                  onSubmitEditing={handleCompletePasswordReset}
                />
                <TouchableOpacity
                  style={[styles.passwordVisibilityBtn, { right: s(14), bottom: s(6) }]}
                  onPress={() => setShowResetPassword(!showResetPassword)}
                >
                  <Ionicons name={showResetPassword ? 'eye-off' : 'eye'} size={s(20)} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.passwordHintText, { color: colors.textSecondary, fontSize: s(12), marginBottom: s(14) }]}>
                {PASSWORD_REQUIREMENTS_TEXT}
              </Text>

              <TouchableOpacity style={[styles.verifyButton, { backgroundColor: colors.primaryBtn, borderRadius: s(20), paddingVertical: s(16), marginTop: s(8) }]} onPress={handleCompletePasswordReset} disabled={loading}>
                {loading ? (
                  <ActivityIndicator color={colors.primaryBtnText} />
                ) : (
                  <Text style={[styles.verifyButtonText, { fontSize: s(16), color: colors.primaryBtnText }]}>Update Password</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setMode('signin')} style={styles.forgotPasswordBtn} disabled={loading}>
                <Text style={[styles.forgotPasswordText, { color: colors.textSecondary, fontSize: s(13) }]}>Back to Sign In</Text>
              </TouchableOpacity>
            </View>
          ) : mode === 'signin' ? (
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

              <TouchableOpacity
                style={[styles.googleButton, { borderColor: colors.borderStrong, backgroundColor: colors.cardBg, borderRadius: s(20), paddingVertical: s(14), marginTop: s(12) }]}
                onPress={handleGoogleAuth}
                disabled={loading}
              >
                <View style={{ marginRight: s(8) }}>
                  <GoogleGLogo size={s(18)} />
                </View>
                <Text style={[styles.googleButtonText, { fontSize: s(15), color: colors.text }]}>Sign in with Google</Text>
              </TouchableOpacity>

              {biometricAvailable && (
                <TouchableOpacity
                  style={[styles.biometricButton, { borderColor: colors.borderStrong, borderRadius: s(20), paddingVertical: s(14), marginTop: s(12) }]}
                  onPress={() => handleBiometricSignIn(true)}
                  disabled={loading}
                >
                  <Ionicons name="finger-print" size={s(20)} color={colors.text} style={{ marginRight: s(8) }} />
                  <Text style={[styles.biometricButtonText, { fontSize: s(15), color: colors.text }]}>Use Biometrics</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View style={styles.formWidth}>
              {/* Preferred Name Input */}
              <TextInput
                style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingHorizontal: s(20), marginBottom: s(14) }, error && styles.inputError]}
                placeholder="Preferred Name"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="words"
                value={nameInput}
                onChangeText={setNameInput}
              />

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

              <TouchableOpacity
                style={[styles.googleButton, { borderColor: colors.borderStrong, backgroundColor: colors.cardBg, borderRadius: s(20), paddingVertical: s(14), marginTop: s(12) }]}
                onPress={handleGoogleAuth}
                disabled={loading}
              >
                <View style={{ marginRight: s(8) }}>
                  <GoogleGLogo size={s(18)} />
                </View>
                <Text style={[styles.googleButtonText, { fontSize: s(15), color: colors.text }]}>Register with Google</Text>
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
  biometricButton: {
    flexDirection: 'row',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  biometricButtonText: {
    fontWeight: '700',
  },
  googleButton: {
    flexDirection: 'row',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  googleButtonText: {
    fontWeight: '700',
  },
});
