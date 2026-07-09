import { Stack, useRouter, useSegments, useGlobalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { callKeepManager } from '@/services/callkeep';
import { SettingsProvider, useSettings } from '@/context/settings-context';
import { StorageService } from '@/services/storage';

import { StatusBar as RNStatusBar, Platform } from 'react-native';

function NavigationLayout() {
  const { theme, colors } = useSettings();
  const router = useRouter();
  const segments = useSegments();
  const globalParams = useGlobalSearchParams<{ friendId?: string }>();

  useEffect(() => {
    RNStatusBar.setBarStyle(theme === 'dark' ? 'light-content' : 'dark-content', true);
    if (Platform.OS === 'android') {
      RNStatusBar.setBackgroundColor('transparent');
      RNStatusBar.setTranslucent(true);
    }
  }, [theme]);

  useEffect(() => {
    const unsubscribe = StorageService.subscribeToMessages((newMsg, msgFriendId) => {
      if (newMsg.text && newMsg.text.startsWith('[CALL_SIGNAL:START_') && newMsg.sender === 'them') {
        const isVideo = newMsg.text.includes('START_VIDEO_CALL');
        const parts = newMsg.text.split(':');
        const roomName = parts[parts.length - 1];

        // Check if we are already in the chat screen with this specific friend
        const isCurrentlyInChatWithFriend = 
          segments[0] === 'chat' && 
          (segments as string[])[1] === '[friendId]' && 
          globalParams.friendId === msgFriendId;

        if (!isCurrentlyInChatWithFriend) {
          console.log(`[GlobalCallListener] Incoming call signal from friend ${msgFriendId}. Redirecting...`);
          StorageService.getFriends().then(friendsList => {
            const friendObj = friendsList.find(f => f.id === msgFriendId);
            const friendName = friendObj ? friendObj.name : 'Friend';
            router.push({
              pathname: `/chat/${msgFriendId}`,
              params: {
                incomingCall: 'true',
                callType: isVideo ? 'video' : 'audio',
                roomName,
                friendName
              }
            });
          }).catch(err => {
            console.error('[GlobalCallListener] Failed to fetch friends:', err);
            router.push({
              pathname: `/chat/${msgFriendId}`,
              params: {
                incomingCall: 'true',
                callType: isVideo ? 'video' : 'audio',
                roomName
              }
            });
          });
        }
      }
    });

    return () => unsubscribe();
  }, [segments, globalParams]);

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
