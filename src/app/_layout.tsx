import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
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
