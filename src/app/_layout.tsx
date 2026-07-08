import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { callKeepManager } from '@/services/callkeep';
import { SettingsProvider, useSettings } from '@/context/settings-context';

import { StatusBar as RNStatusBar, Platform } from 'react-native';

function NavigationLayout() {
  const { theme, colors } = useSettings();

  useEffect(() => {
    RNStatusBar.setBarStyle(theme === 'dark' ? 'light-content' : 'dark-content', true);
    if (Platform.OS === 'android') {
      RNStatusBar.setBackgroundColor('transparent');
      RNStatusBar.setTranslucent(true);
    }
  }, [theme]);

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="parent/gate" />
        <Stack.Screen name="parent/dashboard" />
        <Stack.Screen name="chat/index" />
        <Stack.Screen name="chat/[friendId]" />
      </Stack>
      <StatusBar style={colors.statusBar} />
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    callKeepManager.setup().catch(err => {
      console.error('[CallKeep] Setup failed in RootLayout:', err);
    });
  }, []);

  return (
    <SettingsProvider>
      <NavigationLayout />
    </SettingsProvider>
  );
}
