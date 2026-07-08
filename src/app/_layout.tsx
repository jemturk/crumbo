import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { callKeepManager } from '@/services/callkeep';

export default function RootLayout() {
  useEffect(() => {
    callKeepManager.setup().catch(err => {
      console.error('[CallKeep] Setup failed in RootLayout:', err);
    });
  }, []);

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="parent/gate" />
        <Stack.Screen name="parent/dashboard" />
        <Stack.Screen name="chat/index" />
        <Stack.Screen name="chat/[friendId]" />
      </Stack>
      <StatusBar style="dark" />
    </>
  );
}
