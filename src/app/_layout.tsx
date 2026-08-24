import { SettingsProvider, useSettings } from '@/context/settings-context';
import { isStartSignal, subscribeToCallSignals, subscribeToParentCallSignals } from '@/services/callSignaling';
import { callKeepManager } from '@/services/callkeep';
import { StorageService } from '@/services/storage';
import { Stack, useGlobalSearchParams, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';

import { Platform, StatusBar as RNStatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';

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
  // with whichever identity is active on this device — exactly one of a kid or a parent, per the
  // app's own "single active user per device" rule (see activateKidOnThisDevice/
  // activateParentOnDevice) — and refresh it whenever that changes.
  const callSubRef = useRef<() => void>(() => {});
  const subscribedCodeRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const kidProfile = await StorageService.getKidProfile();
      const parentActive = !kidProfile && (await StorageService.isParentActiveOnDevice());
      const parentCode = parentActive ? await StorageService.getMyParentCode() : null;
      const code = kidProfile?.cookieCode ?? parentCode ?? null;

      if (cancelled || code === subscribedCodeRef.current) return;

      callSubRef.current(); // tear down previous subscription
      subscribedCodeRef.current = code;
      if (!code) {
        callSubRef.current = () => {};
        return;
      }

      if (parentCode) {
        // A parent's contacts are addressed directly by raw cookie code everywhere (see
        // parent/chat/[code].tsx) — no local Friend.id indirection to resolve, unlike the kid
        // path below.
        callSubRef.current = subscribeToParentCallSignals(parentCode, (payload, otherCode) => {
          if (!isStartSignal(payload.type) || !otherCode) return;

          const currentSegments = segmentsRef.current as string[];
          const isCurrentlyInThisParentChat =
            Array.isArray(currentSegments) &&
            currentSegments.length >= 3 &&
            currentSegments[0] === 'parent' &&
            currentSegments[1] === 'chat' &&
            decodeURIComponent(currentSegments[2]) === otherCode;

          if (isCurrentlyInThisParentChat) return; // that screen's own hook handles it

          console.log(`[GlobalCallListener] Incoming parent call from ${otherCode}. Redirecting...`);
          router.push({
            pathname: `/parent/chat/${encodeURIComponent(otherCode)}`,
            params: {
              incomingCall: 'true',
              callType: payload.type === 'START_VIDEO_CALL' ? 'video' : 'audio',
              roomName: payload.roomName || '',
              friendName: payload.callerName || payload.friendName || 'Contact',
              callUUID: payload.callUUID || '',
            },
          });
        });
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
        <Stack.Screen name="reset-password" />
        <Stack.Screen name="chat/index" />
        <Stack.Screen name="chat/[friendId]" />
        <Stack.Screen name="parent/chat/index" />
        <Stack.Screen name="parent/chat/[code]" />
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
    // Required by react-native-gesture-handler's Gesture/GestureDetector API (used by the
    // drawing canvas) — without a root view somewhere above it, gestures silently fail to
    // recognize touches rather than throwing. DrawingCanvasModal adds its own nested one too,
    // since RN's Modal renders into a separate native root that this one doesn't reach into.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SettingsProvider>
          <NavigationLayout />
        </SettingsProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
