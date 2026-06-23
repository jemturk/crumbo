import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, SafeAreaView, ActivityIndicator, Platform } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { StorageService, KidProfile } from '@/services/storage';

export default function WelcomeScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  const [profile, setProfile] = useState<KidProfile | null>(null);

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

  const handleStartChatting = async () => {
    if (!subscribed) {
      // Direct them to tell their parent if not subscribed
      return;
    }
    
    if (!profile) {
      // If subscribed but no profile yet, go to parent dashboard to set one up
      router.push('/parent/gate');
    } else {
      // Go directly to chat list!
      router.push('/chat');
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#FFC93C" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        
        {/* Brand Header */}
        <View style={styles.brandContainer}>
          <Image 
            source={require('@/assets/images/logo.png')} 
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>Crumbo</Text>
          <Text style={styles.subtitle}>The cookie-jar chat messenger for kids!</Text>
        </View>

        {/* Dynamic Action Card */}
        <View style={styles.card}>
          {!subscribed ? (
            <View style={styles.cardContent}>
              <Text style={styles.cardEmoji}>🔒</Text>
              <Text style={styles.cardTitle}>Ask your parent to set up Crumbo!</Text>
              <Text style={styles.cardText}>
                Crumbo is a safe space for messaging friends. We collect absolutely zero kid data.
              </Text>
              <TouchableOpacity 
                style={styles.parentGateButton}
                onPress={() => router.push('/parent/gate')}
              >
                <Text style={styles.parentGateButtonText}>Setup Crumbo for Kids</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.cardContent}>
              <Text style={styles.cardEmoji}>🍪</Text>
              <Text style={styles.cardTitle}>
                {profile ? `Hey, ${profile.name}!` : 'Ready to start?'}
              </Text>
              <Text style={styles.cardText}>
                {profile 
                  ? 'Your cookie jar is ready. Jump in to chat with your friends!' 
                  : 'Your parent has activated Crumbo! Let\'s set up your profile.'}
              </Text>
              
              <TouchableOpacity 
                style={styles.primaryButton}
                onPress={handleStartChatting}
              >
                <Text style={styles.primaryButtonText}>
                  {profile ? 'Enter Cookie Jar 🍪' : 'Create Kid Profile'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Footer Area for parents */}
        <View style={styles.footer}>
          {subscribed && (
            <TouchableOpacity 
              style={styles.linkButton} 
              onPress={() => router.push('/parent/gate')}
            >
              <Text style={styles.linkButtonText}>Parents Area (Manage Subscription)</Text>
            </TouchableOpacity>
          )}
          <Text style={styles.privacyText}>
            Privacy promise: No child data will ever be collected or stored.
          </Text>
        </View>

      </View>
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
  parentGateButton: {
    backgroundColor: '#4E342E',
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 32,
    width: '100%',
    alignItems: 'center',
  },
  parentGateButtonText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
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
});
