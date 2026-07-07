import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, SafeAreaView, Alert, Platform, ActivityIndicator, KeyboardAvoidingView, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StorageService } from '@/services/storage';
import { supabase } from '@/services/supabase';

export default function ParentGate() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  
  // Mode: 'signin' | 'register'
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [confirmInput, setConfirmInput] = useState('');
  
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

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
      Alert.alert("Invalid Email", "Please enter a valid parent email address.");
      return;
    }
    if (!pwd) {
      Alert.alert("Password Required", "Please enter your password.");
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
        Alert.alert("Account Not Found", "No account found with this email. Please register first.");
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
        Alert.alert("Access Denied", "Incorrect password. Please try again.");
      }
    } catch (e) {
      setLoading(false);
      Alert.alert("Connection Error", "Could not connect to the database. Please check your network.");
    }
  };

  const handleRegister = async () => {
    const email = emailInput.trim().toLowerCase();
    const pwd = passwordInput.trim();
    const confirm = confirmInput.trim();

    if (!email || !email.includes('@')) {
      Alert.alert("Invalid Email", "Please enter a valid parent email address.");
      return;
    }
    if (pwd.length < 4) {
      Alert.alert("Weak Password", "Please set a password of at least 4 characters.");
      return;
    }
    if (pwd !== confirm) {
      Alert.alert("Passwords Match", "The passwords you entered do not match. Please try again.");
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
        Alert.alert("Account Exists", "An account with this email already exists. Please sign in.");
        setMode('signin');
        return;
      }

      // Save credentials locally
      await StorageService.saveParentEmail(email);
      await StorageService.saveParentPassword(pwd);
      await StorageService.setSubscribed(true); // Default active status on register

      // Sync settings to Supabase
      await StorageService.syncParentData();

      setLoading(false);
      Alert.alert("Registration Complete! 🔒", "Your parent account and subscription are now active.");
      router.replace('/parent/dashboard');
    } catch (e) {
      setLoading(false);
      Alert.alert("Error", "Could not complete registration. Please check your connection.");
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView 
          contentContainerStyle={[styles.content, { flex: 0, flexGrow: 1, paddingBottom: 24 }]} 
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={[styles.header, { width: '100%', paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + 8 : 40) : 10 }]}>
            <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
              <Ionicons name="close-circle" size={36} color="#8D6E63" />
            </TouchableOpacity>
          </View>

          <View style={styles.iconContainer}>
            <Text style={styles.lockIcon}>🔒</Text>
          </View>

          <Text style={styles.title}>Parent Controls</Text>
          
          <Text style={styles.subtitle}>
            Sign in or register to manage controls, buddy requests, and limits.
          </Text>

          {/* Tab Selection */}
          <View style={styles.tabContainer}>
            <TouchableOpacity 
              style={[styles.tabButton, mode === 'signin' ? styles.tabButtonActive : styles.tabButtonInactive]} 
              onPress={() => { setMode('signin'); setError(false); }}
            >
              <Text style={[styles.tabText, mode === 'signin' ? styles.tabTextActive : styles.tabTextInactive]}>Sign In</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.tabButton, mode === 'register' ? styles.tabButtonActive : styles.tabButtonInactive]} 
              onPress={() => { setMode('register'); setError(false); }}
            >
              <Text style={[styles.tabText, mode === 'register' ? styles.tabTextActive : styles.tabTextInactive]}>Register</Text>
            </TouchableOpacity>
          </View>

          {mode === 'signin' ? (
            <View style={styles.formWidth}>
              {/* Email Input */}
              <TextInput
                style={[styles.input, error && styles.inputError]}
                placeholder="Email Address"
                placeholderTextColor="#A1887F"
                keyboardType="email-address"
                autoCapitalize="none"
                value={emailInput}
                onChangeText={setEmailInput}
              />

              {/* Password Input */}
              <TextInput
                style={[styles.input, error && styles.inputError]}
                placeholder="Parent Password"
                placeholderTextColor="#A1887F"
                secureTextEntry={true}
                value={passwordInput}
                onChangeText={setPasswordInput}
                onSubmitEditing={handleSignIn}
              />

              {/* Submit Button */}
              <TouchableOpacity style={styles.verifyButton} onPress={handleSignIn} disabled={loading}>
                {loading ? (
                  <ActivityIndicator color="#4E342E" />
                ) : (
                  <Text style={styles.verifyButtonText}>Sign In</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.formWidth}>
              {/* Email Input */}
              <TextInput
                style={[styles.input, error && styles.inputError]}
                placeholder="Email Address"
                placeholderTextColor="#A1887F"
                keyboardType="email-address"
                autoCapitalize="none"
                value={emailInput}
                onChangeText={setEmailInput}
              />

              {/* Create Password Input */}
              <TextInput
                style={[styles.input, error && styles.inputError]}
                placeholder="Create Password"
                placeholderTextColor="#A1887F"
                secureTextEntry={true}
                value={passwordInput}
                onChangeText={setPasswordInput}
              />

              {/* Confirm Password Input */}
              <TextInput
                style={[styles.input, error && styles.inputError]}
                placeholder="Confirm Password"
                placeholderTextColor="#A1887F"
                secureTextEntry={true}
                value={confirmInput}
                onChangeText={setConfirmInput}
                onSubmitEditing={handleRegister}
              />

              {/* Submit Button */}
              <TouchableOpacity style={styles.verifyButton} onPress={handleRegister} disabled={loading}>
                {loading ? (
                  <ActivityIndicator color="#4E342E" />
                ) : (
                  <Text style={styles.verifyButtonText}>Register & Subscribe</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
