import { formatMessagePreview } from '@/components/ChatMediaBubble';
import { callKeepManager } from '@/services/callkeep';
import { registerForPushNotificationsAsync } from '@/services/notifications';
import { KidProfile, Message, StorageService } from '@/services/storage';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

export type ContactListMode = 'kid' | 'adult';

export interface ContactListRow {
  key: string;
  name: string;
  avatarEmoji?: string;
  avatarUrl?: string;
  isAdultAvatar: boolean;
  subtitle: string;
  badge?: string;
  showCallButtons: boolean;
  hideVoiceCall: boolean;
  hideVideoCall: boolean;
  onPress: () => void;
  onQuickCall: (isVideo: boolean) => void;
}

// Most-recently-interacted-with first, so the list reorders itself as conversations happen
// instead of staying pinned in whatever order friends/contacts were added — mirrors how every
// other chat app sorts its list. A contact with no messages yet (lastMsg null, e.g. a fresh
// pairing) has no timestamp to sort by, so it sinks to the bottom, below anyone with history.
function sortByLastActivity<T extends { lastMsg: Message | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTime = a.lastMsg ? new Date(a.lastMsg.timestamp).getTime() : -Infinity;
    const bTime = b.lastMsg ? new Date(b.lastMsg.timestamp).getTime() : -Infinity;
    return bTime - aTime;
  });
}

interface UseContactListResult {
  rows: ContactListRow[];
  /** Only populated in kid mode — the adult list has no equivalent single "own profile". */
  kidProfile: KidProfile | null;
  /** True only until the first reload() completes — lets the empty state wait for real data
   *  instead of flashing "No chats yet" while rows is still just its initial []. */
  loading: boolean;
  reload: () => Promise<void>;
}

// Shared data layer for chat/index.tsx (Cookie Jar) and parent/chat/index.tsx (Chats) — both
// screens are otherwise identical (header, FlatList of rows with quick-call buttons, empty
// state), so the only thing that needs to differ is how `rows` gets built: a kid's friends list
// carries parental locks + a pending-pairing gate that an adult's contact list never has.
export function useContactList(mode: ContactListMode): UseContactListResult {
  const router = useRouter();
  const [rows, setRows] = useState<ContactListRow[]>([]);
  const [kidProfile, setKidProfile] = useState<KidProfile | null>(null);
  const [loading, setLoading] = useState(true);

  // loadKidRows only runs once per useFocusEffect mount (see below) — reading pairingStatuses
  // state directly there would always see the initial {}, never a later update. A ref keeps
  // "preserve last known status on a failed re-check" seeing the latest values instead.
  const pairingStatusesRef = useRef<Record<string, 'paired' | 'pending'>>({});

  const loadKidRows = useCallback(async () => {
    const kp = await StorageService.getKidProfile();
    if (!kp) {
      router.replace('/');
      return;
    }

    // Refresh from the parent's synced profile before checking isSubscribed() below — also
    // mirrors the parent's actual subscription state onto this device (bug #6 in BUGS.md).
    let syncedProf: KidProfile | null = null;
    try {
      syncedProf = await StorageService.syncKidProfileAndFriends();
    } catch (e) {
      if (e instanceof Error && e.message === 'KID_NOT_FOUND') {
        await StorageService.logoutKid();
        router.replace('/');
        return;
      }
      // Other failures (network etc.) — fall through and use the last-known local cache.
    }

    const isSub = await StorageService.isSubscribed();
    if (!isSub) {
      router.replace('/');
      return;
    }

    const profile = syncedProf || kp;
    setKidProfile(profile);

    registerForPushNotificationsAsync().then(async (token) => {
      await StorageService.registerPushToken(token);
    }).catch(async (err) => {
      console.error("Push registration failed, syncing profile without push notifications", err);
      await StorageService.registerPushToken(null);
    });
    callKeepManager.promptForReliableCallsIfNeeded();

    const friendsList = await StorageService.getFriends();

    // Last message + pairing status per friend, each its own Supabase round-trip — run every
    // friend AND both of their calls concurrently (rather than one friend at a time, and within
    // a friend, one call at a time) so total wait time is one round-trip, not friends × 2.
    const perFriend = await Promise.all(
      friendsList.map(async (friend) => {
        const [msgs, statusResult] = await Promise.all([
          StorageService.getMessages(friend.id),
          StorageService.checkFriendPairingStatus(profile.cookieCode, friend.cookieCode).catch((e) => {
            console.error('Error checking pairing status for', friend.id, e);
            return null;
          }),
        ]);
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        return { friend, lastMsg, status: statusResult?.status, avatarEmoji: statusResult?.avatarEmoji };
      })
    );

    // Seeded from last known statuses so a friend whose check failed above keeps showing their
    // last known status instead of being demoted to "pending" on a transient network hiccup.
    const statuses: Record<string, 'paired' | 'pending'> = { ...pairingStatusesRef.current };
    const avatarUpdates: { friendId: string; avatarEmoji: string }[] = [];
    for (const { friend, status, avatarEmoji } of perFriend) {
      if (status) statuses[friend.id] = status;
      if (avatarEmoji && avatarEmoji !== friend.avatarEmoji) avatarUpdates.push({ friendId: friend.id, avatarEmoji });
    }
    pairingStatusesRef.current = statuses;

    // Live avatars: a friend's current emoji comes along for free on the pairing check above —
    // persist it so it's there instantly on the next load too.
    if (avatarUpdates.length > 0) {
      await Promise.all(avatarUpdates.map(u => StorageService.updateFriendAvatar(u.friendId, u.avatarEmoji)));
    }

    setRows(sortByLastActivity(perFriend).map(({ friend, lastMsg }) => {
      const avatarEmoji = avatarUpdates.find(u => u.friendId === friend.id)?.avatarEmoji || friend.avatarEmoji;
      const resolvedStatus = statuses[friend.id] || 'pending';
      return {
        key: friend.id,
        name: friend.name,
        avatarEmoji,
        avatarUrl: friend.avatarUrl,
        isAdultAvatar: friend.cookieCode.startsWith('PARENT:'),
        subtitle: resolvedStatus === 'pending' ? 'Waiting for parent approval ⏳' : formatMessagePreview(lastMsg),
        badge: resolvedStatus === 'pending' ? 'Pending' : undefined,
        showCallButtons: resolvedStatus === 'paired',
        hideVoiceCall: !!profile.callingDisabled,
        hideVideoCall: !!profile.videoCallingDisabled,
        onPress: () => router.push(`/chat/${friend.id}`),
        onQuickCall: (isVideo: boolean) =>
          router.push({ pathname: `/chat/${friend.id}`, params: { autoStartCall: isVideo ? 'video' : 'audio' } }),
      };
    }));
  }, [router]);

  const goToContact = useCallback(
    (c: { code: string; name: string; avatarEmoji?: string; avatarUrl?: string; isOwnKid: boolean }, extraParams?: Record<string, string>) => {
      router.push({
        pathname: `/parent/chat/${encodeURIComponent(c.code)}`,
        params: {
          name: c.name,
          isOwnKid: c.isOwnKid ? '1' : '0',
          avatarEmoji: c.avatarEmoji || '',
          avatarUrl: c.avatarUrl || '',
          ...extraParams,
        },
      });
    },
    [router]
  );

  const loadAdultRows = useCallback(async () => {
    const isParentActive = await StorageService.isParentActiveOnDevice();
    const code = await StorageService.getMyParentCode();
    // isParentActiveOnDevice() alone isn't sufficient — that flag and the actual email
    // credential can drift apart. Treat a missing code the same as not being active.
    if (!isParentActive || !code) {
      router.replace('/');
      return;
    }

    // Registers this device's push token against the parent identity so an incoming call can
    // wake a backgrounded/killed app the same way it already does for a kid — see
    // registerParentPushToken's own comment for why this can't just reuse registerPushToken.
    registerForPushNotificationsAsync().then(async (token) => {
      await StorageService.registerParentPushToken(token);
    }).catch(async (err) => {
      console.error("Parent push registration failed, syncing profile without push notifications", err);
      await StorageService.registerParentPushToken(null);
    });

    const contacts = await StorageService.getParentContacts();
    const withPreviews = await Promise.all(
      contacts.map(async (c) => {
        const history = await StorageService.getChatLogsForParent(code, c.code);
        const lastMsg = history.length > 0 ? history[history.length - 1] : null;
        return { c, lastMsg };
      })
    );

    setRows(sortByLastActivity(withPreviews).map(({ c, lastMsg }) => ({
      key: c.code,
      name: c.name,
      avatarEmoji: c.avatarEmoji,
      avatarUrl: c.avatarUrl,
      isAdultAvatar: !c.isOwnKid,
      subtitle: formatMessagePreview(lastMsg),
      showCallButtons: true,
      hideVoiceCall: false,
      hideVideoCall: false,
      onPress: () => goToContact(c),
      onQuickCall: (isVideo: boolean) => goToContact(c, { autoStartCall: isVideo ? 'video' : 'audio' }),
    })));
  }, [goToContact, router]);

  const reload = useCallback(async () => {
    try {
      await (mode === 'kid' ? loadKidRows() : loadAdultRows());
    } finally {
      setLoading(false);
    }
  }, [mode, loadKidRows, loadAdultRows]);

  useFocusEffect(
    useCallback(() => {
      reload();

      if (mode === 'kid') {
        // Chat messages only (call signals travel on their own channel) — any new message just
        // refreshes the previews.
        const unsubscribe = StorageService.subscribeToMessages(() => reload());
        return () => unsubscribe();
      }

      // Adult contacts/previews aren't cached locally, so a live subscription keeps the list
      // fresh the same way the kid list's does — mirrors subscribeToParentMessages's own use in
      // the per-conversation screen.
      let unsubscribe = () => {};
      (async () => {
        const code = await StorageService.getMyParentCode();
        if (code) unsubscribe = StorageService.subscribeToParentMessages(code, () => reload());
      })();
      return () => unsubscribe();
    }, [mode, reload])
  );

  return { rows, kidProfile, loading, reload };
}
