import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, SafeAreaView, ScrollView, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageService, KidProfile } from '@/services/storage';

export default function ParentDashboard() {
  const router = useRouter();
  
  // State
  const [subscribed, setSubscribed] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [kidNameInput, setKidNameInput] = useState('');
  const [profile, setProfile] = useState<KidProfile | null>(null);
  const [parentEmail, setParentEmail] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const isSub = await StorageService.isSubscribed();
      const pEmail = await StorageService.getParentEmail();
      const kidProf = await StorageService.getKidProfile();

      setSubscribed(isSub);
      setParentEmail(pEmail);
      setProfile(kidProf);

      if (pEmail) {
        setEmailInput(pEmail);
      }
    } catch (e) {
      console.error("Error loading settings", e);
    }
  };

  const handleSubscribe = async () => {
    const trimmedEmail = emailInput.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      Alert.alert("Invalid Email", "Please enter a valid email address.");
      return;
    }

    try {
      // Simulate successful payment gateway verification and storage save
      await StorageService.saveParentEmail(trimmedEmail);
      await StorageService.setSubscribed(true);
      
      setParentEmail(trimmedEmail);
      setSubscribed(true);
      
      Alert.alert("Subscription Active! 🎉", "Welcome to Crumbo. Only this email address has been saved. Your kid's chat environment is now completely unlocked.");
    } catch (e) {
      Alert.alert("Error", "Could not complete simulated subscription. Please try again.");
    }
  };

  const handleCancelSubscription = async () => {
    Alert.alert(
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
            Alert.alert("Subscription Cancelled", "Your subscription is now inactive.");
          }
        }
      ]
    );
  };

  const handleCreateProfile = async () => {
    const name = kidNameInput.trim();
    if (!name) {
      Alert.alert("Nickname Required", "Please enter a nickname or name for your kid's profile.");
      return;
    }

    try {
      const prof = await StorageService.createKidProfile(name);
      setProfile(prof);
      setKidNameInput('');
      Alert.alert("Profile Created!", `Welcome aboard, ${name}! Your unique cookie code is ready.`);
    } catch (e) {
      Alert.alert("Error", "Could not create kid profile.");
    }
  };

  const handleResetApp = async () => {
    Alert.alert(
      "Reset App?",
      "This will erase ALL local profiles, friends list, and messaging histories. This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset Everything",
          style: "destructive",
          onPress: async () => {
            await StorageService.clearAll();
            setSubscribed(false);
            setParentEmail(null);
            setProfile(null);
            setEmailInput('');
            setKidNameInput('');
            Alert.alert("Reset Completed", "All local data has been successfully deleted.");
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.replace('/')}>
          <Ionicons name="arrow-back" size={24} color="#4E342E" />
          <Text style={styles.backButtonText}>Back to Welcome</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Parent Controls</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        
        {/* Card 1: Subscription Status */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="card" size={24} color="#D4A373" style={styles.cardIcon} />
            <Text style={styles.cardTitle}>Subscription & Email</Text>
          </View>
          
          {!subscribed ? (
            <View>
              <Text style={styles.infoText}>
                Crumbo is ad-free and does not monetize or track kids. To cover operating costs and maintain privacy, we require a subscription of **$4.99/month**.
              </Text>
              
              <Text style={styles.label}>Parent Email Address</Text>
              <TextInput
                style={styles.input}
                placeholder="parent@example.com"
                placeholderTextColor="#A1887F"
                keyboardType="email-address"
                autoCapitalize="none"
                value={emailInput}
                onChangeText={setEmailInput}
              />
              
              <TouchableOpacity style={styles.subscribeButton} onPress={handleSubscribe}>
                <Text style={styles.subscribeButtonText}>Subscribe Now - $4.99/mo</Text>
              </TouchableOpacity>
              
              <Text style={styles.privacyGuarantee}>
                🔒 Privacy Guarantee: This email is the *only* piece of information saved on our servers. No kid data is ever collected.
              </Text>
            </View>
          ) : (
            <View>
              <View style={styles.statusBadge}>
                <Ionicons name="checkmark-circle" size={18} color="#2E7D32" />
                <Text style={styles.statusBadgeText}>Active Subscription</Text>
              </View>
              
              <Text style={styles.label}>Registered Email</Text>
              <Text style={styles.emailValue}>{parentEmail}</Text>

              <TouchableOpacity style={styles.cancelButton} onPress={handleCancelSubscription}>
                <Text style={styles.cancelButtonText}>Cancel Subscription</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Card 2: Kid Profile Management */}
        {subscribed && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="happy" size={24} color="#D4A373" style={styles.cardIcon} />
              <Text style={styles.cardTitle}>Kid Profile</Text>
            </View>

            {!profile ? (
              <View>
                <Text style={styles.infoText}>
                  Set up a local nickname for your child. This name is stored **only on this device** and is never collected on the server.
                </Text>
                
                <Text style={styles.label}>Child's Nickname</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Alex"
                  placeholderTextColor="#A1887F"
                  value={kidNameInput}
                  onChangeText={setKidNameInput}
                />
                
                <TouchableOpacity style={styles.createButton} onPress={handleCreateProfile}>
                  <Text style={styles.createButtonText}>Create Local Profile</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View>
                <View style={styles.profileBadge}>
                  <Text style={styles.profileAvatar}>🍪</Text>
                  <View>
                    <Text style={styles.profileName}>{profile.name}</Text>
                    <Text style={styles.profileStatus}>Active Profile</Text>
                  </View>
                </View>

                <View style={styles.codeContainer}>
                  <Text style={styles.codeLabel}>Child's Anonymous pairing Code:</Text>
                  <Text style={styles.codeValue}>{profile.cookieCode}</Text>
                  <Text style={styles.codeInstructions}>
                    Share this code with your kid's friends so they can add each other. This is an anonymous identifier.
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Card 3: Storage & Diagnostics */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="shield-checkmark" size={24} color="#D4A373" style={styles.cardIcon} />
            <Text style={styles.cardTitle}>Privacy & Device Data</Text>
          </View>
          <Text style={styles.infoText}>
            All messages, chat histories, friend names, and child information are stored strictly inside this device's local database. Our servers only route transient, encrypted message packages without logging them.
          </Text>
          
          <TouchableOpacity style={styles.dangerButton} onPress={handleResetApp}>
            <Text style={styles.dangerButtonText}>Erase All Local Data</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>
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
    borderColor: '#FFF5D1',
    backgroundColor: '#FFFFFF',
    paddingTop: Platform.OS === 'android' ? 44 : 16,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4E342E',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#4E342E',
  },
  scrollContent: {
    padding: 20,
    gap: 20,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 20,
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1,
    borderColor: '#FFF5D1',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  cardIcon: {
    marginRight: 10,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#4E342E',
  },
  infoText: {
    fontSize: 14,
    color: '#795548',
    lineHeight: 20,
    marginBottom: 16,
    fontWeight: '500',
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#8D6E63',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: '#FFFDF5',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    borderRadius: 16,
    height: 52,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#4E342E',
    fontWeight: '600',
    marginBottom: 16,
  },
  subscribeButton: {
    backgroundColor: '#FFC93C',
    borderRadius: 16,
    height: 54,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#FFC93C',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  subscribeButtonText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#4E342E',
  },
  privacyGuarantee: {
    fontSize: 11,
    color: '#A1887F',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#E8F5E9',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    alignSelf: 'flex-start',
    marginBottom: 16,
  },
  statusBadgeText: {
    fontSize: 12,
    color: '#2E7D32',
    fontWeight: '800',
  },
  emailValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#4E342E',
    marginBottom: 20,
  },
  cancelButton: {
    borderWidth: 2,
    borderColor: '#E57373',
    borderRadius: 16,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#D32F2F',
  },
  createButton: {
    backgroundColor: '#4E342E',
    borderRadius: 16,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  profileBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    backgroundColor: '#FFFDF5',
    padding: 16,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#FFEFC0',
    marginBottom: 20,
  },
  profileAvatar: {
    fontSize: 36,
  },
  profileName: {
    fontSize: 20,
    fontWeight: '900',
    color: '#4E342E',
  },
  profileStatus: {
    fontSize: 12,
    color: '#8D6E63',
    fontWeight: '700',
  },
  codeContainer: {
    backgroundColor: '#FFFDF5',
    borderRadius: 20,
    padding: 16,
    borderWidth: 2,
    borderColor: '#FFD966',
    alignItems: 'center',
  },
  codeLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#8D6E63',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  codeValue: {
    fontSize: 28,
    fontWeight: '900',
    color: '#4E342E',
    letterSpacing: 2,
    marginBottom: 8,
  },
  codeInstructions: {
    fontSize: 11,
    color: '#795548',
    textAlign: 'center',
    lineHeight: 16,
    fontWeight: '600',
  },
  dangerButton: {
    borderWidth: 2,
    borderColor: '#FFEFC0',
    borderRadius: 16,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  dangerButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#795548',
  },
});
