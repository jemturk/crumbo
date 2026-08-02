import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { supabase } from '@/services/supabase';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

// Mirrors gate.tsx's requirement exactly, so a reset password is held to the same bar as a
// newly-registered one.
const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PASSWORD_REQUIREMENTS_TEXT = 'Password must be at least 8 characters and include a letter, a number, and a special character.';

type ExchangeStatus = 'exchanging' | 'ready' | 'error';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { s } = useDisplayScale();
  const { colors } = useAppTheme();
  // The reset-password link opens this route as crumbo://reset-password?code=... (PKCE flow,
  // see services/supabase.ts) — the code is a one-time credential that must be exchanged for a
  // real session before updateUser() can change the password.
  const { code } = useLocalSearchParams<{ code?: string }>();

  const [status, setStatus] = useState<ExchangeStatus>('exchanging');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);

  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    message: string;
    buttons?: AlertButton[];
  }>({ visible: false, title: '', message: '' });

  const showAlert = (title: string, message: string, buttons?: AlertButton[]) => {
    setAlertConfig({ visible: true, title, message, buttons });
  };

  useEffect(() => {
    const exchange = async () => {
      if (!code) {
        setStatus('error');
        return;
      }
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      setStatus(error ? 'error' : 'ready');
    };
    exchange();
  }, [code]);

  const handleSetNewPassword = async () => {
    const pwd = newPassword.trim();
    if (!PASSWORD_COMPLEXITY_REGEX.test(pwd)) {
      showAlert("Weak Password", PASSWORD_REQUIREMENTS_TEXT);
      return;
    }

    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: pwd });
    setSaving(false);

    if (error) {
      showAlert("Error", "Could not update your password. This reset link may have expired — request a new one from the sign-in screen.");
      return;
    }

    // This session only exists to authorize the password change — sign out and send them
    // through the normal sign-in flow so fetchAndRestoreParentData runs as usual.
    await supabase.auth.signOut();
    showAlert("Password Updated 🔒", "Your password has been changed. Please sign in with your new password.", [
      { text: "OK", onPress: () => router.replace('/parent/gate') }
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: s(32) }]} keyboardShouldPersistTaps="handled">
          {status === 'exchanging' && (
            <>
              <ActivityIndicator size="large" color={colors.primaryBtn} />
              <Text style={[styles.statusText, { color: colors.textSecondary, fontSize: s(15), marginTop: s(16) }]}>
                Verifying your reset link…
              </Text>
            </>
          )}

          {status === 'error' && (
            <>
              <Ionicons name="alert-circle" size={s(56)} color={colors.dangerText} />
              <Text style={[styles.title, { color: colors.text, fontSize: s(24), marginTop: s(16) }]}>Link Expired</Text>
              <Text style={[styles.statusText, { color: colors.textSecondary, fontSize: s(15), marginTop: s(8), marginBottom: s(24) }]}>
                This password reset link is invalid or has expired. Request a new one from the sign-in screen.
              </Text>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: colors.primaryBtn, borderRadius: s(20), paddingVertical: s(16) }]}
                onPress={() => router.replace('/parent/gate')}
              >
                <Text style={[styles.buttonText, { fontSize: s(16), color: colors.primaryBtnText }]}>Back to Sign In</Text>
              </TouchableOpacity>
            </>
          )}

          {status === 'ready' && (
            <>
              <Ionicons name="lock-closed" size={s(48)} color={colors.text} style={{ marginBottom: s(16) }} />
              <Text style={[styles.title, { color: colors.text, fontSize: s(26), marginBottom: s(8) }]}>Set a New Password</Text>
              <Text style={[styles.statusText, { color: colors.textSecondary, fontSize: s(14), marginBottom: s(24) }]}>
                Choose a new password for your Parent account.
              </Text>

              <View style={styles.passwordFieldWrapper}>
                <TextInput
                  style={[styles.input, { backgroundColor: colors.inputBg, color: colors.inputText, borderColor: colors.borderStrong, height: s(52), borderRadius: s(20), fontSize: s(16), paddingLeft: s(20), paddingRight: s(48) }]}
                  placeholder="New Password"
                  placeholderTextColor={colors.textSecondary}
                  secureTextEntry={!showPassword}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  onSubmitEditing={handleSetNewPassword}
                />
                <TouchableOpacity
                  style={[styles.passwordVisibilityBtn, { right: s(14) }]}
                  onPress={() => setShowPassword(!showPassword)}
                >
                  <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={s(20)} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.passwordHintText, { color: colors.textSecondary, fontSize: s(12), marginBottom: s(20) }]}>
                {PASSWORD_REQUIREMENTS_TEXT}
              </Text>

              <TouchableOpacity
                style={[styles.button, { backgroundColor: colors.primaryBtn, borderRadius: s(20), paddingVertical: s(16) }]}
                onPress={handleSetNewPassword}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color={colors.primaryBtnText} />
                ) : (
                  <Text style={[styles.buttonText, { fontSize: s(16), color: colors.primaryBtnText }]}>Update Password</Text>
                )}
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {status !== 'exchanging' && (
        <View style={{ position: 'absolute', top: insets.top + s(4), right: s(16) }}>
          <TouchableOpacity style={{ padding: s(8) }} onPress={() => router.replace('/parent/gate')}>
            <Ionicons name="close-circle" size={s(36)} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

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
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontWeight: '900',
    textAlign: 'center',
  },
  statusText: {
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 20,
  },
  passwordFieldWrapper: {
    width: '100%',
    position: 'relative',
  },
  input: {
    width: '100%',
    borderWidth: 2,
    fontWeight: '600',
  },
  passwordVisibilityBtn: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  passwordHintText: {
    width: '100%',
    fontWeight: '600',
    lineHeight: 16,
  },
  button: {
    width: '100%',
    alignItems: 'center',
  },
  buttonText: {
    fontWeight: '800',
  },
});
