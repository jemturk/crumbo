import { SettingsProvider, useSettings } from '@/context/settings-context';
import { isStartSignal, subscribeToCallSignals } from '@/services/callSignaling';
import { callKeepManager } from '@/services/callkeep';
import { StorageService } from '@/services/storage';
import { Stack, useGlobalSearchParams, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';

import { Platform, StatusBar as RNStatusBar } from 'react-native';

function NavigationLayout() {
  const { theme, colors } = useSettings();
  const router = useRouter();
  const segments = useSegments();
  const globalParams = useGlobalSearchParams<{ friendId?: string }>();

  const segmentsRef = useRef(segments);
  const globalParamsRef = useRef(globalParams);

  useEffect(() => {
    segmentsRef.current = segments;
    globalParamsRef.current = globalParams;
  }, [segments, globalParams]);

  useEffect(() => {
    RNStatusBar.setBarStyle(theme === 'dark' ? 'light-content' : 'dark-content', true);
    if (Platform.OS === 'android') {
      RNStatusBar.setBackgroundColor('transparent');
      RNStatusBar.setTranslucent(true);
    }
  }, [theme]);

  // Global incoming-call listener. call_signals is filtered per-receiver, so we (re)subscribe
  // with the active kid's cookie code and refresh it whenever the logged-in kid changes.
  const callSubRef = useRef<() => void>(() => {});
  const subscribedCodeRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const profile = await StorageService.getKidProfile();
      const code = profile?.cookieCode ?? null;
      if (cancelled || code === subscribedCodeRef.current) return;

      callSubRef.current(); // tear down previous subscription
      subscribedCodeRef.current = code;
      if (!code) {
        callSubRef.current = () => {};
        return;
      }

      callSubRef.current = subscribeToCallSignals(code, (payload, friendId) => {
        if (!isStartSignal(payload.type) || !friendId) return;

        const currentSegments = segmentsRef.current as string[];
        const currentParams = globalParamsRef.current;
        const isCurrentlyInChatWithFriend =
          Array.isArray(currentSegments) &&
          currentSegments.length >= 2 &&
          currentSegments[0] === 'chat' &&
          currentSegments[1] === friendId &&
          currentParams.friendId === friendId;

        if (isCurrentlyInChatWithFriend) return; // the chat screen's own hook handles it

        console.log(`[GlobalCallListener] Incoming call from friend ${friendId}. Redirecting...`);
        router.push({
          pathname: `/chat/${friendId}`,
          params: {
            incomingCall: 'true',
            callType: payload.type === 'START_VIDEO_CALL' ? 'video' : 'audio',
            roomName: payload.roomName || '',
            friendName: payload.callerName || payload.friendName || 'Friend',
            callUUID: payload.callUUID || '',
          },
        });
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [segments]);

  useEffect(() => () => callSubRef.current(), []);

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
