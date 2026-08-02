import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { supabase } from './supabase';

// Interfaces
export interface Message {
  id: string;
  text: string;
  timestamp: string; // ISO String
  sender: 'me' | 'them';
}

// A message whose Supabase insert failed (offline, dropped connection, etc.) — kept separately
// per friendId so it isn't lost when getMessages' next server-sync overwrites the local cache
// with the server's view, and so it can be retried. See bug #4 in BUGS.md.
interface OutboxEntry {
  id: string;
  senderCode: string;
  receiverCode: string;
  text: string;
  createdAt: string;
}

export interface Friend {
  id: string;
  name: string;
  cookieCode: string;
  avatarEmoji: string;
}

// Adding a new per-kid lock flag? There's no single source of truth for KidProfile — it's
// manually reconstructed at every one of these sites, so a new flag must be added to all of
// them or it'll silently fail to persist/sync: createKidProfile, buildParentPushTokenPayload,
// fetchAndRestoreParentData, deleteKidProfile's reactivation, updateKidSettingsForProfile's
// (and updateKidSettings's) settings type, activateKidProfile, loginKidWithCode, and
// syncKidProfileAndFriends (the most important one — it's what delivers a parent's toggle to
// the kid's device). Also: every settings-object literal passed to updateKidSettingsForProfile
// in dashboard.tsx.
export interface KidProfile {
  name: string;
  cookieCode: string;
  avatarEmoji?: string;
  chatDisabled?: boolean;
  callingDisabled?: boolean;
  videoCallingDisabled?: boolean;
  photosDisabled?: boolean;
  drawingDisabled?: boolean;
  friends?: any[];
}

// Storage keys
const KEYS = {
  PARENT_EMAIL: 'crumbo_parent_email',
  IS_SUBSCRIBED: 'crumbo_is_subscribed',
  KID_PROFILE: 'crumbo_kid_profile',
  FRIENDS: 'crumbo_friends',
  MESSAGES_PREFIX: 'crumbo_messages_',
  OUTBOX_PREFIX: 'crumbo_outbox_',
  KIDS_LIST: 'crumbo_parent_kids_list',
  HAS_SEEN_ONBOARDING: 'crumbo_has_seen_onboarding',
  DEVICE_ID: 'crumbo_device_id',
};

// Default setup — also the pool the avatar picker UI offers (see AvatarPickerModal).
export const DEFAULT_EMOJIS = ['🍪', '🧁', '🍩', '🍫', '🍧', '🍰', '🍭', '🍓', '🍒', '🦕', '🐱', '🐼', '🐨', '🦊', '🦁'];

function randomAvatarEmoji(): string {
  return DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
}

// `profiles.name` isn't used for parent rows (kid rows store the kid's real name there) — this
// fixed marker just distinguishes a parent account row at a glance. Kept as a constant so
// syncParentData and createParentAccount can't drift apart.
const PARENT_ROW_NAME_MARKER = "6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19";

// getMessages, sendMessage, sendCallLogMessage, receiveMockMessage and the realtime subscriber
// (subscribeToMessages) all read-modify-write the same crumbo_messages_<friendId> AsyncStorage
// key independently. Without serialization, two of these interleaving (e.g. a send racing an
// incoming realtime message) can each read the same "before" array and write back their own
// version, silently dropping whichever wrote first. This chains all such operations for the
// same friendId onto one promise queue so they run one at a time instead of overlapping;
// different friendIds still run fully in parallel.
const messageWriteQueues = new Map<string, Promise<unknown>>();

function withMessagesLock<T>(friendId: string, fn: () => Promise<T>): Promise<T> {
  const previous = messageWriteQueues.get(friendId) || Promise.resolve();
  const run = previous.then(fn, fn);
  // Swallow so one failed op doesn't wedge the queue for this friendId forever; the real
  // rejection still propagates to whoever awaited `run` below.
  messageWriteQueues.set(friendId, run.catch(() => {}));
  return run;
}

// Raw read (no Supabase sync) for callers that only need "whatever's currently cached" to
// append onto inside a withMessagesLock section — going through getMessages() there would both
// re-trigger a server round-trip and re-enter the very lock it's called under.
async function readCachedMessages(friendId: string): Promise<Message[]> {
  const cachedData = await AsyncStorage.getItem(`${KEYS.MESSAGES_PREFIX}${friendId}`);
  const messages: Message[] = cachedData ? JSON.parse(cachedData) : [];
  return messages.filter(m => m.text && !StorageService.isCallSignalText(m.text));
}

// [CALL_LOG:type:direction:callUUID(:duration)] — callUUID is the 3rd field. use-call.ts embeds
// it in every call-log row it writes; older rows written before this existed have no 3rd field
// (nothing to dedupe against). A brief prior format instead had a plain duration-in-seconds
// integer at this same position for ended calls — the hyphen check rejects that so it's never
// mistaken for a callUUID (which would wrongly collapse two different calls that happened to
// last the same number of seconds).
function extractCallLogUUID(text: string): string | null {
  if (!text.startsWith('[CALL_LOG:')) return null;
  const candidate = text.replace('[CALL_LOG:', '').replace(']', '').split(':')[2];
  return candidate && candidate.includes('-') ? candidate : null;
}

// Both sides of a call independently run their own ~45s ring timeout and can each write their
// own missed-call row for the same call before the other side's END/CANCEL signal lands — both
// rows sync to both devices, so without this a kid sees the same missed call listed twice (see
// bug #5 in BUGS.md). Rows sharing a callUUID are collapsed to one, keeping whichever has the
// lexicographically smaller id — an arbitrary but deterministic tiebreak, so both devices
// (which eventually see the same pair of rows) converge on keeping the same one.
function dedupeCallLogs(messages: Message[]): Message[] {
  const bestByCallUUID = new Map<string, Message>();
  for (const m of messages) {
    const callUUID = extractCallLogUUID(m.text);
    if (!callUUID) continue;
    const existing = bestByCallUUID.get(callUUID);
    if (!existing || m.id < existing.id) {
      bestByCallUUID.set(callUUID, m);
    }
  }
  return messages.filter(m => {
    const callUUID = extractCallLogUUID(m.text);
    return !callUUID || bestByCallUUID.get(callUUID) === m;
  });
}

async function getOutbox(friendId: string): Promise<OutboxEntry[]> {
  const data = await AsyncStorage.getItem(`${KEYS.OUTBOX_PREFIX}${friendId}`);
  return data ? JSON.parse(data) : [];
}

async function addToOutbox(friendId: string, entry: OutboxEntry): Promise<void> {
  const outbox = await getOutbox(friendId);
  outbox.push(entry);
  await AsyncStorage.setItem(`${KEYS.OUTBOX_PREFIX}${friendId}`, JSON.stringify(outbox));
}

// Attempts the actual `messages` row insert for one outbox entry. Shared by sendMessage/
// sendCallLogMessage's first attempt and getMessages' retry pass, so both go through the exact
// same insert shape.
async function insertOutboxEntry(entry: OutboxEntry): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('messages')
      .insert({
        id: entry.id,
        sender_code: entry.senderCode,
        receiver_code: entry.receiverCode,
        text: entry.text,
        created_at: entry.createdAt,
      });
    if (error) {
      console.error("Error writing message to Supabase:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("Error writing message to Supabase:", e);
    return false;
  }
}

/**
 * Resizes/compresses a locally-picked photo or captured drawing and uploads it to the
 * `kid_media` Supabase Storage bucket (see supabase/migrations/20260801000000_kid_media_bucket.sql),
 * returning its public URL. Used by sendImageMessage/sendDrawingMessage, which embed the URL
 * in the message text (`[IMAGE:<url>]` / `[DRAWING:<url>]`) rather than storing image bytes
 * directly — keeps the local per-friend AsyncStorage message cache small.
 *
 * Unlike a failed messages-row insert (which the outbox retries), a failed upload has nothing
 * to retry from — there's no local record of "a photo was supposed to go here." Callers should
 * let this throw and show a "couldn't send" alert rather than writing anything locally first.
 */
async function compressAndUploadImage(localUri: string, kind: 'photo' | 'drawing', senderCookieCode: string): Promise<string> {
  const manipulated =
    kind === 'photo'
      ? await ImageManipulator.manipulate(localUri)
          .resize({ width: 1080 })
          .renderAsync()
          .then(image => image.saveAsync({ compress: 0.6, format: SaveFormat.JPEG }))
      // Drawings stay lossless PNG — the canvas is a plain white background (like paper), and
      // JPEG compression would visibly smear/fringe the thin strokes drawn on it.
      : await ImageManipulator.manipulate(localUri)
          .renderAsync()
          .then(image => image.saveAsync({ format: SaveFormat.PNG }));

  const file = new File(manipulated.uri);
  const bytes = await file.arrayBuffer();
  const ext = kind === 'photo' ? 'jpg' : 'png';
  const path = `${senderCookieCode}/${kind}_${Crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from('kid_media')
    .upload(path, bytes, { contentType: kind === 'photo' ? 'image/jpeg' : 'image/png' });

  if (error) {
    throw new Error(error.message || 'Failed to upload image');
  }

  const { data } = supabase.storage.from('kid_media').getPublicUrl(path);
  return data.publicUrl;
}

function randomCookieCode(): string {
  const part1 = Math.floor(100 + Math.random() * 900);
  const part2 = Math.floor(100 + Math.random() * 900);
  return `CRUM-${part1}-${part2}`;
}

// createKidProfile used to pick a code purely locally with no server check at all — see bug #2
// (only 810,000 combinations, ~50% chance of at least one collision by ~1,000 kids). Kid codes
// live nested inside each parent row's push_token JSON blob rather than as their own indexed
// column, so there's no DB uniqueness constraint to fall back on here (that needs the schema
// rework tracked as bug #1); this is the best available guard until then — check-then-generate
// against the server, retrying on an actual collision. It doesn't close the race between two
// devices checking at the exact same instant, but that's a vanishingly rare coincidence compared
// to the previous "no check at all, guaranteed to collide eventually" state.
async function generateUniqueCookieCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomCookieCode();
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('cookie_code')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${candidate}"%`)
        .limit(1);
      if (error) {
        console.error("Error checking cookie code uniqueness:", error);
        return candidate; // Can't verify — don't block profile creation on it.
      }
      if (!data || data.length === 0) return candidate;
      // Collision — loop and try another candidate.
    } catch (e) {
      console.error("Error checking cookie code uniqueness:", e);
      return candidate; // Offline or query failed — same fallback as above.
    }
  }
  // Exhausting 5 retries in an 810,000-code space would mean the pool is nearly saturated;
  // fall back to one last random code rather than failing profile creation outright.
  return randomCookieCode();
}

// A Cookie Code alone used to be the entire kid credential — no password, no device check —
// so anyone who obtained a code (guessed, leaked, shoulder-surfed) could log in as that kid from
// anywhere. This device ID is generated once and cached locally; loginKidWithCode binds a code
// to the first device that successfully uses it, and rejects the same code from any other
// device afterward (see loginKidWithCode / regenerateKidCode below).
async function getDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(KEYS.DEVICE_ID);
  if (existing) return existing;
  const generated = Crypto.randomUUID();
  await AsyncStorage.setItem(KEYS.DEVICE_ID, generated);
  return generated;
}

export const StorageService = {
  // Parent Subscription
  async getParentEmail(): Promise<string | null> {
    return await AsyncStorage.getItem(KEYS.PARENT_EMAIL);
  },

  async saveParentEmail(email: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARENT_EMAIL, email);
  },

  /**
   * Undoes saveParentEmail. Used by gate.tsx when createParentAccount loses a registration race
   * (email already taken by another device) — without this, the losing device would be left
   * with someone else's email cached as its own PARENT_EMAIL, and a later unrelated
   * syncParentData() call would upsert local settings into that stranger's account row.
   */
  async clearParentCredentials(): Promise<void> {
    await AsyncStorage.removeItem(KEYS.PARENT_EMAIL);
  },

  /**
   * Clears the parent dashboard's local "kids I manage" cache. Deliberately narrow — does NOT
   * touch KID_PROFILE/FRIENDS/IS_SUBSCRIBED, since a shared device may have a kid actively
   * logged in independently of the parent dashboard, and logging out of the parent side must
   * not disturb that (see handleLogout's own alert text: "your child's active chat session will
   * remain active"). Without this, KIDS_LIST kept whatever was cached from a previous parent
   * account indefinitely — logging out of account A and registering (or signing into) a
   * DIFFERENT account B would still show A's kids under B, since nothing ever cleared it, only
   * PARENT_EMAIL. Call on parent logout, and defensively at the start of registration too (a
   * brand-new account has no kids of its own yet to overwrite it with).
   */
  async clearManagedKidsCache(): Promise<void> {
    await AsyncStorage.removeItem(KEYS.KIDS_LIST);
  },

  async isSubscribed(): Promise<boolean> {
    const status = await AsyncStorage.getItem(KEYS.IS_SUBSCRIBED);
    return status === 'true';
  },

  async setSubscribed(subscribed: boolean): Promise<void> {
    await AsyncStorage.setItem(KEYS.IS_SUBSCRIBED, subscribed ? 'true' : 'false');
  },

  // Gates the one-time first-launch OnboardingModal (see index.tsx) — not tied to any profile
  // or device, so it still shows once even for a device that never subscribes or logs in.
  async hasSeenOnboarding(): Promise<boolean> {
    const seen = await AsyncStorage.getItem(KEYS.HAS_SEEN_ONBOARDING);
    return seen === 'true';
  },

  async setOnboardingSeen(): Promise<void> {
    await AsyncStorage.setItem(KEYS.HAS_SEEN_ONBOARDING, 'true');
  },

  // Kid Profile List
  async getKidsList(): Promise<KidProfile[]> {
    const data = await AsyncStorage.getItem(KEYS.KIDS_LIST);
    if (!data) return [];
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  },

  async saveKidsList(kids: KidProfile[]): Promise<void> {
    await AsyncStorage.setItem(KEYS.KIDS_LIST, JSON.stringify(kids));
  },

  async getKidProfile(): Promise<KidProfile | null> {
    const data = await AsyncStorage.getItem(KEYS.KID_PROFILE);
    if (!data) return null;
    return JSON.parse(data);
  },

  async createKidProfile(name: string): Promise<KidProfile> {
    // e.g. CRUM-123-456 — checked against the server for an existing collision first (bug #2).
    const cookieCode = await generateUniqueCookieCode();

    const initialFriends: Friend[] = [];

    const profile: KidProfile = {
      name,
      cookieCode,
      avatarEmoji: randomAvatarEmoji(),
      chatDisabled: false,
      callingDisabled: false,
      videoCallingDisabled: false,
      photosDisabled: false,
      drawingDisabled: false,
      friends: initialFriends
    };

    // Add to kids list
    const kids = await this.getKidsList();
    kids.push(profile);
    await this.saveKidsList(kids);

    // If no active profile, set this one as active
    const active = await this.getKidProfile();
    if (!active) {
      await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(profile));
      await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(initialFriends));
    }

    return profile;
  },

  // Friends Management
  async getFriends(): Promise<Friend[]> {
    const data = await AsyncStorage.getItem(KEYS.FRIENDS);
    if (!data) {
      // Seed some initial friendly contacts for the demo
      const initialFriends: Friend[] = [];
      await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(initialFriends));
      
      return initialFriends;
    }
    return JSON.parse(data);
  },

  async addFriend(name: string, cookieCode: string): Promise<Friend> {
    const friends = await this.getFriends();
    
    // Check if friend already exists by code
    const existing = friends.find(f => f.cookieCode === cookieCode);
    if (existing) return existing;

    const randomEmoji = randomAvatarEmoji();
    const newFriend: Friend = {
      id: Crypto.randomUUID(),
      name,
      cookieCode,
      avatarEmoji: randomEmoji,
    };

    const updated = [...friends, newFriend];
    await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(updated));

    // Also update the active kid's friends array inside the KIDS_LIST!
    const active = await this.getKidProfile();
    if (active) {
      const kids = await this.getKidsList();
      const updatedKids = kids.map(k => {
        if (k.cookieCode === active.cookieCode) {
          return {
            ...k,
            friends: updated
          };
        }
        return k;
      });
      await this.saveKidsList(updatedKids);
    }

    return newFriend;
  },

  // Message Management
  async getMessages(friendId: string): Promise<Message[]> {
    // 1. Load cached messages for instant display
    const cachedData = await AsyncStorage.getItem(`${KEYS.MESSAGES_PREFIX}${friendId}`);
    let messages: Message[] = cachedData ? JSON.parse(cachedData) : [];
    messages = messages.filter(m => m.text && !this.isCallSignalText(m.text));

    // 2. Fetch fresh history from Supabase to sync, retrying any outbox messages first. The
    // overwrite below is serialized per-friend (see withMessagesLock) so it can't race
    // sendMessage/sendCallLogMessage/receiveMockMessage/the realtime subscriber appending to the
    // same local cache at the same time and silently dropping whichever wrote first.
    const fetchedMessages = await withMessagesLock(friendId, async (): Promise<Message[] | null> => {
      try {
        const profile = await this.getKidProfile();
        const friends = await this.getFriends();
        const friend = friends.find(f => f.id === friendId);

        if (profile && friend) {
          // Retry anything that failed to sync last time (offline send, dropped connection,
          // etc.) — see bug #4 (messages sent offline used to just evaporate on the next
          // server-sync overwrite below, with no outbox or retry at all).
          const outbox = await getOutbox(friendId);
          const retryResults = await Promise.all(
            outbox.map(async (entry) => ({ entry, synced: await insertOutboxEntry(entry) }))
          );

          const { data: dbMsgs, error } = await supabase
            .from('messages')
            .select('*')
            .or(`and(sender_code.eq.${profile.cookieCode},receiver_code.eq.${friend.cookieCode}),and(sender_code.eq.${friend.cookieCode},receiver_code.eq.${profile.cookieCode})`)
            .order('created_at', { ascending: true });

          if (!error && dbMsgs) {
            const fetched: Message[] = dbMsgs
              .filter(msg => msg.text && !this.isCallSignalText(msg.text))
              .map(msg => ({
                id: msg.id,
                text: msg.text,
                timestamp: msg.created_at,
                sender: msg.sender_code === profile.cookieCode ? 'me' : 'them',
              }));

            // A retry can fail with "already exists" if an earlier attempt actually succeeded
            // server-side but this device crashed/lost connectivity before clearing the outbox
            // entry — cross-check against `fetched` (the actual server state) rather than trust
            // insertOutboxEntry's own success flag, so that case still clears correctly instead
            // of getting stuck retrying (and duplicating) forever.
            const stillPending = retryResults
              .filter(({ entry, synced }) => !synced && !fetched.some(f => f.id === entry.id))
              .map(({ entry }) => entry);
            if (stillPending.length !== outbox.length) {
              await AsyncStorage.setItem(`${KEYS.OUTBOX_PREFIX}${friendId}`, JSON.stringify(stillPending));
            }

            // Still-pending entries haven't made it to the server yet — merge them back in so
            // the overwrite below doesn't erase them from the local cache.
            const pendingAsMessages: Message[] = stillPending.map(e => ({
              id: e.id,
              text: e.text,
              timestamp: e.createdAt,
              sender: 'me',
            }));
            const merged = dedupeCallLogs(
              [...fetched, ...pendingAsMessages].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
              )
            );

            // Overwrite local storage cache with latest data
            await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify(merged));
            return merged;
          } else if (error) {
            console.error("Error fetching messages from Supabase:", error);
          }
        }
      } catch (e) {
        console.error("Failed to sync messages with Supabase:", e);
      }
      return null;
    });

    return fetchedMessages ?? messages;
  },

  async getChatLogsForParent(kidCookieCode: string, friendCookieCode: string): Promise<Message[]> {
    try {
      const { data: dbMsgs, error } = await supabase
        .from('messages')
        .select('*')
        .or(`and(sender_code.eq.${kidCookieCode},receiver_code.eq.${friendCookieCode}),and(sender_code.eq.${friendCookieCode},receiver_code.eq.${kidCookieCode})`)
        .order('created_at', { ascending: true });

      if (!error && dbMsgs) {
        return dbMsgs
          .filter(msg => msg.text && !this.isCallSignalText(msg.text))
          .map(msg => ({
            id: msg.id,
            text: msg.text,
            timestamp: msg.created_at,
            sender: msg.sender_code === kidCookieCode ? 'me' : 'them',
          }));
      } else if (error) {
        console.error("Error fetching logs for parent:", error);
      }
    } catch (e) {
      console.error("Failed to query parent chat logs:", e);
    }
    return [];
  },

  async sendMessage(friendId: string, text: string): Promise<Message> {
    const newMsgId = Crypto.randomUUID();

    const newMsg: Message = {
      id: newMsgId,
      text,
      timestamp: new Date().toISOString(),
      sender: 'me',
    };

    await withMessagesLock(friendId, async () => {
      const messages = await readCachedMessages(friendId);
      const updated = [...messages, newMsg];
      await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify(updated));
    });

    // Write to Supabase — if this fails (offline, dropped connection, etc.), queue it in the
    // outbox instead of silently losing it. getMessages retries the outbox on its next sync
    // (see bug #4).
    const profile = await this.getKidProfile();
    const friends = await this.getFriends();
    const friend = friends.find(f => f.id === friendId);
    if (profile && friend) {
      const entry: OutboxEntry = {
        id: newMsgId,
        senderCode: profile.cookieCode,
        receiverCode: friend.cookieCode,
        text,
        createdAt: newMsg.timestamp,
      };
      const synced = await insertOutboxEntry(entry);
      if (!synced) {
        await addToOutbox(friendId, entry);
      }
    }

    return newMsg;
  },

  async receiveMockMessage(friendId: string, text: string): Promise<Message> {
    const newMsg: Message = {
      id: Crypto.randomUUID(),
      text,
      timestamp: new Date().toISOString(),
      sender: 'them',
    };

    await withMessagesLock(friendId, async () => {
      const messages = await readCachedMessages(friendId);
      const updated = [...messages, newMsg];
      await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify(updated));
    });
    return newMsg;
  },

  isCallSignalText(value: unknown): boolean {
    if (!value) return false;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            return (
              typeof (parsed as any).type === 'string' ||
              typeof (parsed as any).callSignal === 'string'
            );
          }
          return false;
        } catch {
          return false;
        }
      }
      return false;
    }

    if (typeof value === 'object' && value !== null) {
      return (
        typeof (value as any).type === 'string' ||
        typeof (value as any).callSignal === 'string'
      );
    }

    return false;
  },

  async registerPushToken(token: string | null): Promise<void> {
    try {
      const profile = await this.getKidProfile();
      if (profile) {
        await supabase
          .from('profiles')
          .upsert({
            cookie_code: profile.cookieCode,
            push_token: token || null,
            name: profile.name
          });
      }
    } catch (e) {
      console.error("Error registering push token on Supabase", e);
    }
  },

  // Realtime subscription helper — plain chat messages only. Call signaling lives on its
  // own channel (see src/services/callSignaling.ts).
  subscribeToMessages(onNewMessage: (msg: Message, friendId: string) => void): () => void {
    const channelId = Math.random().toString(36).substring(2, 9);
    const dbChannel = supabase
      .channel(`public:messages:${channelId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        async (payload) => {
          const newRow = payload.new;
          if (this.isCallSignalText(newRow.text)) return; // defensive: ignore legacy signal rows

          const profile = await this.getKidProfile();
          if (!profile) return;

          const isSentByMe = newRow.sender_code === profile.cookieCode;
          const isReceivedByMe = newRow.receiver_code === profile.cookieCode;
          if (!isSentByMe && !isReceivedByMe) return;

          const friends = await this.getFriends();
          const correspondingFriend = friends.find(f =>
            f.cookieCode === (isSentByMe ? newRow.receiver_code : newRow.sender_code)
          );
          if (!correspondingFriend) return;

          const localMsg: Message = {
            id: newRow.id,
            text: newRow.text,
            timestamp: newRow.created_at,
            sender: isSentByMe ? 'me' : 'them',
          };

          // Read AsyncStorage directly to de-dupe and avoid redundant API requests. Serialized
          // per-friend (see withMessagesLock) so this can't race a local sendMessage/
          // sendCallLogMessage/receiveMockMessage/getMessages sync writing the same key at the
          // same time and silently dropping whichever wrote first.
          const wasNew = await withMessagesLock(correspondingFriend.id, async () => {
            const data = await AsyncStorage.getItem(`${KEYS.MESSAGES_PREFIX}${correspondingFriend.id}`);
            const cachedMessages: Message[] = data ? JSON.parse(data) : [];
            if (cachedMessages.find(m => m.id === localMsg.id)) return false;

            // dedupeCallLogs collapses this against any existing call-log row for the same
            // callUUID (see bug #5 — both sides of a missed call can independently write their
            // own row for it). `wasNew` reflects whether localMsg actually survived that, so a
            // duplicate that lost the tiebreak is written to cache (a no-op) but never surfaced
            // to the UI via onNewMessage.
            const updated = dedupeCallLogs([...cachedMessages, localMsg]);
            await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${correspondingFriend.id}`, JSON.stringify(updated));
            return updated.some(m => m.id === localMsg.id);
          });
          if (wasNew) onNewMessage(localMsg, correspondingFriend.id);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(dbChannel);
    };
  },

  async buildParentPushTokenPayload(): Promise<string> {
    const subscribed = await this.isSubscribed();
    const kids = await this.getKidsList();
    const activeProfile = await this.getKidProfile();
    const activeFriends = await this.getFriends();

    const kidsPayload = kids.map(k => {
      // If this is the active kid, use the latest friends list/avatar from storage — this
      // device's own KID_PROFILE is fresher than the parent dashboard's KIDS_LIST cache when
      // they're the same kid (e.g. a kid who picked a new avatar via setKidAvatar, which writes
      // straight to the server but has no way to update THIS separate device's local cache).
      const isCurrentActive = activeProfile?.cookieCode === k.cookieCode;
      const friendsList = isCurrentActive ? activeFriends : (k.friends || []);
      const avatarEmoji = isCurrentActive && activeProfile ? activeProfile.avatarEmoji : k.avatarEmoji;

      return {
        cookieCode: k.cookieCode,
        name: k.name,
        avatarEmoji,
        chatDisabled: !!k.chatDisabled,
        callingDisabled: !!k.callingDisabled,
        videoCallingDisabled: !!k.videoCallingDisabled,
        photosDisabled: !!k.photosDisabled,
        drawingDisabled: !!k.drawingDisabled,
        friends: friendsList.map((f: any) => ({
          id: f.id,
          name: f.name,
          cookieCode: f.cookieCode,
          avatarEmoji: f.avatarEmoji
        }))
      };
    });

    const displaySize = await AsyncStorage.getItem('crumbo_display_size') || 'default';
    const theme = await AsyncStorage.getItem('crumbo_theme') || 'light';

    return JSON.stringify({
      subscribed,
      kids: kidsPayload,
      displaySize,
      theme
    });
  },

  async syncParentData(): Promise<void> {
    try {
      const email = await this.getParentEmail();
      if (!email) return;

      const pushTokenPayload = await this.buildParentPushTokenPayload();

      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert({
          cookie_code: `PARENT:${email}`,
          push_token: pushTokenPayload,
          name: PARENT_ROW_NAME_MARKER
        });

      if (upsertError) {
        throw new Error(upsertError.message || "Failed to upsert parent settings");
      }
    } catch (e) {
      console.error("Failed to sync parent settings to Supabase:", e);
      throw e;
    }
  },

  /**
   * Creates the parent account row with a real INSERT rather than syncParentData's upsert.
   * Two devices registering the same email can both pass gate.tsx's own exists-check before
   * either has written — that pre-check is only a fast-path UX hint, not a guarantee. This
   * insert is the actual guard: it relies on the unique constraint on profiles.cookie_code
   * (see supabase/migrations/20260731000000_profiles_cookie_code_unique.sql) to make the
   * loser's insert fail with a Postgres unique-violation instead of silently overwriting the
   * winner's row.
   */
  async createParentAccount(email: string): Promise<'created' | 'exists'> {
    const pushTokenPayload = await this.buildParentPushTokenPayload();

    const { error } = await supabase
      .from('profiles')
      .insert({
        cookie_code: `PARENT:${email}`,
        push_token: pushTokenPayload,
        name: PARENT_ROW_NAME_MARKER
      });

    if (error) {
      if (error.code === '23505') return 'exists'; // unique_violation
      throw new Error(error.message || "Failed to create parent account");
    }
    return 'created';
  },

  async fetchAndRestoreParentData(email: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('cookie_code', `PARENT:${email}`)
        .single();

      if (!error && data && data.push_token) {
        const payload = JSON.parse(data.push_token);

        await AsyncStorage.setItem(KEYS.IS_SUBSCRIBED, payload.subscribed ? 'true' : 'false');
        await AsyncStorage.setItem(KEYS.PARENT_EMAIL, email);

        if (payload.displaySize) {
          await AsyncStorage.setItem('crumbo_display_size', payload.displaySize);
        }

        if (payload.theme) {
          await AsyncStorage.setItem('crumbo_theme', payload.theme);
        }

        // Always reflect THIS account's kids — even when there are none — rather than only
        // writing KIDS_LIST/KID_PROFILE/FRIENDS when non-empty. Skipping that when empty used to
        // leave a PREVIOUS account's kids sitting in local cache untouched, so switching accounts
        // on the same device (sign out, then sign into or register a different email) could keep
        // showing the old account's kids for as long as the new one had none of its own yet.
        const kids = payload.kids || [];
        await AsyncStorage.setItem(KEYS.KIDS_LIST, JSON.stringify(kids));

        if (kids.length > 0) {
          // Decide which kid to activate on this device
          const currentActive = await this.getKidProfile();
          const matchInRestored = currentActive
            ? kids.find((k: any) => k.cookieCode === currentActive.cookieCode)
            : null;

          const kidToActivate = matchInRestored || kids[0];

          const kidProfile: KidProfile = {
            name: kidToActivate.name,
            cookieCode: kidToActivate.cookieCode,
            chatDisabled: !!kidToActivate.chatDisabled,
            callingDisabled: !!kidToActivate.callingDisabled,
            videoCallingDisabled: !!kidToActivate.videoCallingDisabled,
            photosDisabled: !!kidToActivate.photosDisabled,
            drawingDisabled: !!kidToActivate.drawingDisabled
          };
          await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(kidProfile));
          await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(kidToActivate.friends || []));
        } else {
          await AsyncStorage.removeItem(KEYS.KID_PROFILE);
          await AsyncStorage.removeItem(KEYS.FRIENDS);
        }
        return true;
      }
    } catch (e) {
      console.error("Failed to restore parent data from Supabase:", e);
    }
    return false;
  },

  async updateKidSettings(settings: { chatDisabled: boolean; callingDisabled: boolean; videoCallingDisabled: boolean; photosDisabled: boolean; drawingDisabled: boolean }): Promise<void> {
    const profile = await this.getKidProfile();
    if (profile) {
      await this.updateKidSettingsForProfile(profile.cookieCode, settings);
    }
  },

  async sendCallLogMessage(friendId: string, text: string): Promise<Message> {
    const newMsgId = Crypto.randomUUID();

    const newMsg: Message = {
      id: newMsgId,
      text,
      timestamp: new Date().toISOString(),
      sender: 'me',
    };

    await withMessagesLock(friendId, async () => {
      const messages = await readCachedMessages(friendId);
      // Defensive: the other side's row for the same call may have already synced in (e.g. via
      // the realtime subscriber) before this local write lands — dedupeCallLogs collapses that
      // pair down to one immediately rather than waiting for the next getMessages sync.
      const updated = dedupeCallLogs([...messages, newMsg]);
      await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify(updated));
    });

    // Same outbox/retry treatment as sendMessage — a call log is just a specially-formatted
    // message, and evaporates the same way without it (bug #4).
    const profile = await this.getKidProfile();
    const friends = await this.getFriends();
    const friend = friends.find(f => f.id === friendId);
    if (profile && friend) {
      const entry: OutboxEntry = {
        id: newMsgId,
        senderCode: profile.cookieCode,
        receiverCode: friend.cookieCode,
        text,
        createdAt: newMsg.timestamp,
      };
      const synced = await insertOutboxEntry(entry);
      if (!synced) {
        await addToOutbox(friendId, entry);
      }
    }

    return newMsg;
  },

  /**
   * Sends a photo (from camera or gallery). Unlike sendMessage/sendCallLogMessage, this
   * uploads FIRST and only writes anything (local cache or outbox) once there's a real URL —
   * a failed upload has nothing to retry from, so callers should let this throw and show a
   * "couldn't send" alert rather than optimistically appending a message first.
   */
  async sendImageMessage(friendId: string, localUri: string): Promise<Message> {
    return this.sendMediaMessage(friendId, localUri, 'photo', 'IMAGE');
  },

  /** Sends a hand-drawn sketch captured from the drawing canvas. See sendImageMessage. */
  async sendDrawingMessage(friendId: string, localUri: string): Promise<Message> {
    return this.sendMediaMessage(friendId, localUri, 'drawing', 'DRAWING');
  },

  async sendMediaMessage(friendId: string, localUri: string, kind: 'photo' | 'drawing', prefix: 'IMAGE' | 'DRAWING'): Promise<Message> {
    const profile = await this.getKidProfile();
    const friends = await this.getFriends();
    const friend = friends.find(f => f.id === friendId);
    if (!profile || !friend) {
      throw new Error('No active profile or friend to send to');
    }

    const url = await compressAndUploadImage(localUri, kind, profile.cookieCode);
    const text = `[${prefix}:${url}]`;
    const newMsgId = Crypto.randomUUID();
    const newMsg: Message = {
      id: newMsgId,
      text,
      timestamp: new Date().toISOString(),
      sender: 'me',
    };

    await withMessagesLock(friendId, async () => {
      const messages = await readCachedMessages(friendId);
      await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify([...messages, newMsg]));
    });

    const entry: OutboxEntry = {
      id: newMsgId,
      senderCode: profile.cookieCode,
      receiverCode: friend.cookieCode,
      text,
      createdAt: newMsg.timestamp,
    };
    const synced = await insertOutboxEntry(entry);
    if (!synced) {
      await addToOutbox(friendId, entry);
    }

    return newMsg;
  },

  async deleteKidProfile(cookieCode: string): Promise<void> {
    const kids = await this.getKidsList();
    const updatedKids = kids.filter(k => k.cookieCode !== cookieCode);
    await this.saveKidsList(updatedKids);

    // If the active profile is the one being deleted, switch active profile
    const active = await this.getKidProfile();
    if (active && active.cookieCode === cookieCode) {
      if (updatedKids.length > 0) {
        const nextActive = updatedKids[0];
        await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify({
          name: nextActive.name,
          cookieCode: nextActive.cookieCode,
          chatDisabled: !!nextActive.chatDisabled,
          callingDisabled: !!nextActive.callingDisabled,
          videoCallingDisabled: !!nextActive.videoCallingDisabled,
          photosDisabled: !!nextActive.photosDisabled,
          drawingDisabled: !!nextActive.drawingDisabled
        }));
        if (nextActive.friends) {
          await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(nextActive.friends));
        }
      } else {
        await AsyncStorage.removeItem(KEYS.KID_PROFILE);
        await AsyncStorage.removeItem(KEYS.FRIENDS);
      }
    }
  },

  /**
   * Issues a kid a brand-new Cookie Code and invalidates the old one everywhere — the actual
   * incident response for "someone else has my kid's code" (see loginKidWithCode's device
   * binding), and also how a kid moves onto a new/replacement phone. Any device currently using
   * the old code (the kid's own included) stops working immediately; loginKidWithCode must be
   * used again with the new code to claim it fresh. Existing pairings and chat history are
   * carried over to the new code rather than starting over.
   */
  async regenerateKidCode(oldCookieCode: string): Promise<string | null> {
    try {
      const newCookieCode = await generateUniqueCookieCode();

      // A single search for '"cookieCode":"<old>"' finds every row that mentions this code at
      // all — both the owning parent (where it's a kid's OWN code) and any friend's parent row
      // (where it's stored as a friend reference) — so one pass renames it everywhere it lives.
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${oldCookieCode}"%`);

      if (error || !data) return null;

      let ownerRenamed = false;
      for (const parentRow of data) {
        try {
          const payload = JSON.parse(parentRow.push_token);
          if (!payload?.kids) continue;
          let changed = false;

          for (const kid of payload.kids) {
            if (kid.cookieCode === oldCookieCode) {
              kid.cookieCode = newCookieCode;
              kid.boundDeviceId = null; // free for a legitimate device to claim
              // A brand-new code is a fresh secret nobody else has seen yet — safe to claim on
              // first use same as any new kid profile, so any leftover claim gate from a prior
              // deactivateKidDevice call on the OLD code shouldn't carry over and block it.
              kid.pendingClaimToken = null;
              kid.pendingClaimExpiresAt = null;
              changed = true;
              ownerRenamed = true;
            }
            if (kid.friends) {
              for (const friend of kid.friends) {
                if (friend.cookieCode === oldCookieCode) {
                  friend.cookieCode = newCookieCode;
                  changed = true;
                }
              }
            }
          }

          if (changed) {
            await supabase
              .from('profiles')
              .upsert({ cookie_code: parentRow.cookie_code, push_token: JSON.stringify(payload), name: parentRow.name });
          }
        } catch {}
      }

      if (!ownerRenamed) return null; // never actually found the kid itself — don't touch messages

      // Chat history is addressed by cookie code (messages.sender_code/receiver_code have no
      // foreign key to a kid, just plain text matching) — repoint existing rows to the new code
      // so history stays intact under the new identity instead of becoming unreachable.
      await supabase.from('messages').update({ sender_code: newCookieCode }).eq('sender_code', oldCookieCode);
      await supabase.from('messages').update({ receiver_code: newCookieCode }).eq('receiver_code', oldCookieCode);

      // Reflect the rename in this (parent) device's own local cache too, so the dashboard
      // doesn't show the stale code until its next full resync.
      const kids = await this.getKidsList();
      await this.saveKidsList(kids.map(k => (k.cookieCode === oldCookieCode ? { ...k, cookieCode: newCookieCode } : k)));

      return newCookieCode;
    } catch (e) {
      console.error("Error regenerating kid code:", e);
      return null;
    }
  },

  /**
   * Releases this Cookie Code's device lock WITHOUT issuing a new code (see regenerateKidCode
   * above for that heavier alternative) — the fix for "kid needs to log in on a new phone but
   * this code says it's already active elsewhere": a parent opens the OLD phone's Parent Area
   * (account-based, works from any device) and deactivates it there, freeing the code for the
   * new phone's loginKidWithCode to claim. If the device calling this is the one that had the
   * kid active locally, it's logged out here too so this device's own UI reflects the change.
   *
   * Freeing boundDeviceId alone would turn the (long-lived, possibly-seen-by-others) Cookie Code
   * back into a bare bearer secret — anyone with it could win the race to claim the freed slot,
   * not just the phone the parent actually intends. So this also mints a short-lived, one-time
   * claim code that loginKidWithCode requires alongside the Cookie Code to complete that claim;
   * only the authenticated parent ever sees it, and it expires in 15 minutes or on first use.
   */
  async deactivateKidDevice(cookieCode: string): Promise<{ success: boolean; claimCode?: string }> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${cookieCode}"%`);

      if (error || !data) return { success: false };

      for (const parentRow of data) {
        try {
          const payload = JSON.parse(parentRow.push_token);
          if (!payload?.kids) continue;
          const kidIndex = payload.kids.findIndex((k: any) => k.cookieCode === cookieCode);
          if (kidIndex === -1) continue;

          const claimCode = Crypto.randomUUID().slice(0, 8).toUpperCase();
          const claimExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

          payload.kids[kidIndex] = {
            ...payload.kids[kidIndex],
            boundDeviceId: null,
            pendingClaimToken: claimCode,
            pendingClaimExpiresAt: claimExpiresAt
          };
          await supabase
            .from('profiles')
            .upsert({ cookie_code: parentRow.cookie_code, push_token: JSON.stringify(payload), name: parentRow.name });

          const active = await this.getKidProfile();
          if (active && active.cookieCode === cookieCode) {
            await this.logoutKid();
          }
          return { success: true, claimCode };
        } catch {}
      }
      return { success: false };
    } catch (e) {
      console.error("Error deactivating kid device:", e);
      return { success: false };
    }
  },

  async updateKidSettingsForProfile(
    cookieCode: string, 
    settings: { chatDisabled: boolean; callingDisabled: boolean; videoCallingDisabled: boolean; photosDisabled: boolean; drawingDisabled: boolean }
  ): Promise<void> {
    const kids = await this.getKidsList();
    const updatedKids = kids.map(k => {
      if (k.cookieCode === cookieCode) {
        return {
          ...k,
          ...settings
        };
      }
      return k;
    });
    await this.saveKidsList(updatedKids);

    // If this is also the active kid, update the active KID_PROFILE storage as well
    const active = await this.getKidProfile();
    if (active && active.cookieCode === cookieCode) {
      await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify({
        ...active,
        ...settings
      }));
    }
  },

  async activateKidProfile(cookieCode: string): Promise<void> {
    const kids = await this.getKidsList();
    const target = kids.find(k => k.cookieCode === cookieCode);
    if (target) {
      await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify({
        name: target.name,
        cookieCode: target.cookieCode,
        chatDisabled: !!target.chatDisabled,
        callingDisabled: !!target.callingDisabled,
        videoCallingDisabled: !!target.videoCallingDisabled,
        photosDisabled: !!target.photosDisabled,
        drawingDisabled: !!target.drawingDisabled
      }));
      if (target.friends) {
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(target.friends));
      } else {
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([]));
      }
    }
  },



  async loginKidWithCode(cookieCode: string, claimCode?: string): Promise<KidProfile | null> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${cookieCode}"%`);

      if (error) {
        throw new Error(error.message || "Failed to query database");
      }

      if (!data || data.length === 0) {
        return null;
      }

      // Find the parent profile that actually OWNS this kid
      let targetKid = null;
      let owningRow = null;
      let owningPayload: any = null;
      for (const parentProfile of data) {
        try {
          const payload = JSON.parse(parentProfile.push_token);
          if (payload && payload.kids) {
            const found = payload.kids.find((k: any) => k.cookieCode === cookieCode);
            if (found) {
              targetKid = found;
              owningRow = parentProfile;
              owningPayload = payload;
              break;
            }
          }
        } catch {}
      }

      if (targetKid) {
        const deviceId = await getDeviceId();

        if (targetKid.boundDeviceId && targetKid.boundDeviceId !== deviceId) {
          // Someone else's device already claimed this code — a leaked/guessed code alone is no
          // longer enough. Thrown (not returned null) so callers can show a specific message
          // instead of the generic "code not found" one.
          throw new Error('DEVICE_MISMATCH');
        }

        if (!targetKid.boundDeviceId) {
          // A code freed by deactivateKidDevice (as opposed to one that's simply never been
          // claimed yet) carries a one-time claim code — without this gate, freeing the slot
          // would make the bare Cookie Code a sufficient bearer secret again, letting ANYONE who
          // has it win the race to claim it, not just the device the parent actually intended.
          if (targetKid.pendingClaimToken) {
            const expired = !targetKid.pendingClaimExpiresAt || Date.parse(targetKid.pendingClaimExpiresAt) < Date.now();
            if (!claimCode) {
              throw new Error('CLAIM_CODE_REQUIRED');
            }
            if (expired || claimCode.trim().toUpperCase() !== targetKid.pendingClaimToken) {
              throw new Error('CLAIM_CODE_INVALID');
            }
          }

          // First-ever login for this code, or a freed one whose claim code just checked out —
          // claim this device. Written directly to the owning parent row (same cross-family-write
          // pattern as setKidAvatar below), since this kid's device has no local parent
          // credentials to sync through.
          const kidIndex = owningPayload.kids.findIndex((k: any) => k.cookieCode === cookieCode);
          owningPayload.kids[kidIndex] = {
            ...owningPayload.kids[kidIndex],
            boundDeviceId: deviceId,
            pendingClaimToken: null,
            pendingClaimExpiresAt: null
          };
          await supabase
            .from('profiles')
            .upsert({
              cookie_code: owningRow!.cookie_code,
              push_token: JSON.stringify(owningPayload),
              name: owningRow!.name
            });
        }

        const kidProfile: KidProfile = {
          name: targetKid.name,
          cookieCode: targetKid.cookieCode,
          avatarEmoji: targetKid.avatarEmoji,
          chatDisabled: !!targetKid.chatDisabled,
          callingDisabled: !!targetKid.callingDisabled,
          videoCallingDisabled: !!targetKid.videoCallingDisabled,
          photosDisabled: !!targetKid.photosDisabled,
          drawingDisabled: !!targetKid.drawingDisabled
        };
        await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(kidProfile));
        await AsyncStorage.setItem(KEYS.IS_SUBSCRIBED, 'true');

        if (targetKid.friends) {
          await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(targetKid.friends));
        } else {
          await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([]));
        }

        return kidProfile;
      }
    } catch (e) {
      console.error("Error logging in kid with code:", e);
      throw e;
    }
    return null;
  },

  async logoutKid(): Promise<void> {
    await AsyncStorage.removeItem(KEYS.KID_PROFILE);
    await AsyncStorage.removeItem(KEYS.FRIENDS);

    // IS_SUBSCRIBED doubles as the parent dashboard's own "is my account active" flag (see
    // isSubscribed/setSubscribed, read by dashboard.tsx to decide whether to show "Subscribe
    // Now" or "Active Subscription"). On a shared device that also has a parent account
    // registered locally, clearing it here would make the dashboard falsely claim the parent
    // isn't subscribed anymore, even though nothing about their actual subscription changed.
    // Only reset it on a kid-only device (no local parent email), where it really was just
    // this kid session's flag.
    const parentEmail = await this.getParentEmail();
    if (!parentEmail) {
      await AsyncStorage.removeItem(KEYS.IS_SUBSCRIBED);
    }
  },

  async syncKidProfileAndFriends(): Promise<KidProfile | null> {
    const active = await this.getKidProfile();
    if (!active) return null;

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${active.cookieCode}"%`);

      if (error) {
        console.error("Failed to sync kid profile from Supabase:", error);
        return null; // query itself failed (network etc.) — caller falls back to stale cache
      }

      // Find the parent profile that actually OWNS this kid
      let targetKid = null;
      let owningPayload: any = null;
      if (data) {
        for (const parentProfile of data) {
          try {
            const payload = JSON.parse(parentProfile.push_token);
            if (payload && payload.kids) {
              const found = payload.kids.find((k: any) => k.cookieCode === active.cookieCode);
              if (found) {
                targetKid = found;
                owningPayload = payload;
                break;
              }
            }
          } catch {}
        }
      }

      if (!targetKid) {
        // The query succeeded but no parent row's kids[] contains this cookie code anymore —
        // this kid was removed, or (see regenerateKidCode) their code was rotated out from under
        // this exact device. Unlike a network hiccup, this genuinely means "you don't exist here
        // anymore" — thrown so the caller can force a real logout instead of silently continuing
        // to operate on stale local cache.
        throw new Error('KID_NOT_FOUND');
      }

      const updatedProfile: KidProfile = {
        name: targetKid.name,
        cookieCode: targetKid.cookieCode,
        avatarEmoji: targetKid.avatarEmoji,
        chatDisabled: !!targetKid.chatDisabled,
        callingDisabled: !!targetKid.callingDisabled,
        videoCallingDisabled: !!targetKid.videoCallingDisabled,
        photosDisabled: !!targetKid.photosDisabled,
        drawingDisabled: !!targetKid.drawingDisabled
      };
      await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(updatedProfile));
      if (targetKid.friends) {
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(targetKid.friends));
      } else {
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([]));
      }
      // Mirror the parent's actual subscription state onto this device — IS_SUBSCRIBED was
      // previously only ever set once at kid-login and never re-checked, so a parent
      // cancelling on their own device (see handleCancelSubscription in dashboard.tsx) never
      // reached the kid's device at all (bug #6). Only touch it when the field is actually
      // present, so a parent row from before `subscribed` existed in the payload doesn't
      // spuriously lock an otherwise-active kid out.
      if (typeof owningPayload.subscribed === 'boolean') {
        await AsyncStorage.setItem(KEYS.IS_SUBSCRIBED, owningPayload.subscribed ? 'true' : 'false');
      }
      return updatedProfile;
    } catch (e) {
      if (e instanceof Error && e.message === 'KID_NOT_FOUND') throw e;
      console.error("Failed to sync kid profile from Supabase:", e);
      return null;
    }
  },

  /**
   * Lets a kid change their own avatar. Updates this device's cache immediately, then pushes
   * the change to the owning parent's row. A kid's device doesn't necessarily have the parent's
   * email/password cached locally (syncParentData() would just no-op without an email) — so,
   * like pairKidsViaQRCode's cross-family write, this looks up the owning PARENT: row directly
   * and upserts the modified payload back, rather than requiring local parent credentials.
   */
  async setKidAvatar(avatarEmoji: string): Promise<boolean> {
    const active = await this.getKidProfile();
    if (!active) return false;

    const updated: KidProfile = { ...active, avatarEmoji };
    await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(updated));
    const kids = await this.getKidsList();
    if (kids.some(k => k.cookieCode === active.cookieCode)) {
      await this.saveKidsList(kids.map(k => (k.cookieCode === active.cookieCode ? { ...k, avatarEmoji } : k)));
    }

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${active.cookieCode}"%`);

      if (error || !data) return false;

      for (const parentRow of data) {
        try {
          const payload = JSON.parse(parentRow.push_token);
          if (!payload?.kids) continue;
          const kidIndex = payload.kids.findIndex((k: any) => k.cookieCode === active.cookieCode);
          if (kidIndex === -1) continue;

          payload.kids[kidIndex] = { ...payload.kids[kidIndex], avatarEmoji };
          const { error: upsertError } = await supabase
            .from('profiles')
            .upsert({
              cookie_code: parentRow.cookie_code,
              push_token: JSON.stringify(payload),
              name: parentRow.name
            });
          return !upsertError;
        } catch {}
      }
      return false;
    } catch (e) {
      console.error("Error syncing avatar to server:", e);
      return false;
    }
  },

  async addFriendToKidProfile(kidCookieCode: string, friendName: string, friendCookieCode: string): Promise<Friend> {
    const randomEmoji = randomAvatarEmoji();
    const newFriend: Friend = {
      id: Crypto.randomUUID(),
      name: friendName,
      cookieCode: friendCookieCode,
      avatarEmoji: randomEmoji
    };

    // 1. Update friends list in the KIDS_LIST array
    const kids = await this.getKidsList();
    const updatedKids = kids.map(k => {
      if (k.cookieCode === kidCookieCode) {
        const friends = k.friends || [];
        if (!friends.some(f => f.cookieCode === friendCookieCode)) {
          return { ...k, friends: [...friends, newFriend] };
        }
      }
      return k;
    });
    await this.saveKidsList(updatedKids);

    // 2. If this is the active profile on this device, also update active KEYS.FRIENDS
    const active = await this.getKidProfile();
    if (active && active.cookieCode === kidCookieCode) {
      const activeFriends = await this.getFriends();
      if (!activeFriends.some(f => f.cookieCode === friendCookieCode)) {
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([...activeFriends, newFriend]));
      }
    }

    return newFriend;
  },

  async removeFriendFromKidProfile(kidCookieCode: string, friendCookieCode: string): Promise<void> {
    // 1. Update in KIDS_LIST
    const kids = await this.getKidsList();
    const updatedKids = kids.map(k => {
      if (k.cookieCode === kidCookieCode) {
        const friends = k.friends || [];
        return { ...k, friends: friends.filter(f => f.cookieCode !== friendCookieCode) };
      }
      return k;
    });
    await this.saveKidsList(updatedKids);

    // 2. If active profile, also update KEYS.FRIENDS
    const active = await this.getKidProfile();
    if (active && active.cookieCode === kidCookieCode) {
      const activeFriends = await this.getFriends();
      await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(activeFriends.filter(f => f.cookieCode !== friendCookieCode)));
    }
  },

  /**
   * Throws on a network/query failure instead of swallowing it to 'pending' — a failed lookup
   * is not evidence the pairing was ever revoked, and returning 'pending' for it demotes an
   * already-paired friend (locking their chat input) on every transient network hiccup. Callers
   * should catch this and keep showing the friend's last known status rather than treat a throw
   * as 'pending'.
   *
   * Also returns the friend's current avatarEmoji straight from their own profile — this same
   * per-friend lookup already runs on every chat-list load, so piggybacking the live avatar onto
   * it (rather than a separate query) is how a kid's avatar change shows up for friends without
   * any extra network round-trips. Callers should merge a defined avatarEmoji into their cached
   * Friend record (see updateFriendAvatar) when present.
   */
  async checkFriendPairingStatus(
    kidCookieCode: string,
    friendCookieCode: string
  ): Promise<{ status: 'paired' | 'pending'; avatarEmoji?: string }> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .like('cookie_code', 'PARENT:%')
      .like('push_token', `%"cookieCode":"${friendCookieCode}"%`);

    if (error) {
      throw error;
    }

    if (!data || data.length === 0) {
      return { status: 'pending' };
    }

    // Find the parent profile that actually OWNS the friend (not just a parent who has added the friend as a buddy)
    let friendProfileInDb = null;
    for (const parentProfile of data) {
      try {
        const payload = JSON.parse(parentProfile.push_token);
        if (payload && payload.kids) {
          const found = payload.kids.find((k: any) => k.cookieCode === friendCookieCode);
          if (found) {
            friendProfileInDb = found;
            break;
          }
        }
      } catch {}
    }

    const avatarEmoji: string | undefined = friendProfileInDb?.avatarEmoji;

    if (friendProfileInDb && friendProfileInDb.friends) {
      const isPaired = friendProfileInDb.friends.some((f: any) => f.cookieCode === kidCookieCode);
      if (isPaired) {
        return { status: 'paired', avatarEmoji };
      }
    }
    return { status: 'pending', avatarEmoji };
  },

  /** Updates one friend's cached avatarEmoji in both FRIENDS and the active kid's KIDS_LIST entry. */
  async updateFriendAvatar(friendId: string, avatarEmoji: string): Promise<void> {
    const friends = await this.getFriends();
    const friend = friends.find(f => f.id === friendId);
    if (!friend || friend.avatarEmoji === avatarEmoji) return;

    const updatedFriends = friends.map(f => (f.id === friendId ? { ...f, avatarEmoji } : f));
    await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(updatedFriends));

    const active = await this.getKidProfile();
    if (active) {
      const kids = await this.getKidsList();
      const updatedKids = kids.map(k => (k.cookieCode === active.cookieCode ? { ...k, friends: updatedFriends } : k));
      await this.saveKidsList(updatedKids);
    }
  },

  async pairKidsViaQRCode(kidCookieCode: string, kidName: string, friendCookieCode: string, friendName: string): Promise<boolean> {
    try {
      // 1. Find Friend's Parent Profile in Supabase
      const { data: parents, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${friendCookieCode}"%`);

      if (error || !parents || parents.length === 0) {
        console.error("Could not find buddy's parent profile in Supabase");
        return false;
      }

      // Find the specific parent profile that contains this kid
      let targetParentRow = null;
      let targetPayload: any = null;
      for (const parent of parents) {
        try {
          const payload = JSON.parse(parent.push_token);
          if (payload && payload.kids && payload.kids.some((k: any) => k.cookieCode === friendCookieCode)) {
            targetParentRow = parent;
            targetPayload = payload;
            break;
          }
        } catch {}
      }

      if (!targetParentRow || !targetPayload) {
        console.error("Buddy's kid profile not found inside the parent payloads");
        return false;
      }

      // 2. Add Kid A (the scanner) to Kid B's (the scannee) friends list in their parent's profile
      const kidAEmoji = randomAvatarEmoji();
      const newFriendForB = {
        id: Crypto.randomUUID(),
        name: kidName,
        cookieCode: kidCookieCode,
        avatarEmoji: kidAEmoji
      };

      const updatedFriendKids = targetPayload.kids.map((k: any) => {
        if (k.cookieCode === friendCookieCode) {
          const friends = k.friends || [];
          if (!friends.some((f: any) => f.cookieCode === kidCookieCode)) {
            return { ...k, friends: [...friends, newFriendForB] };
          }
        }
        return k;
      });

      targetPayload.kids = updatedFriendKids;

      // Upsert Friend's Parent Profile back to Supabase
      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert({
          cookie_code: targetParentRow.cookie_code,
          push_token: JSON.stringify(targetPayload),
          name: targetParentRow.name
        });

      if (upsertError) {
        console.error("Failed to update buddy's parent profile:", upsertError);
        return false;
      }

      // 3. Add Kid B (the scannee) to Kid A's (the scanner) local friends list
      await this.addFriendToKidProfile(kidCookieCode, friendName, friendCookieCode);

      // 4. Sync Parent A's data back to Supabase
      await this.syncParentData();

      return true;
    } catch (e) {
      console.error("Error in QR pairing:", e);
      return false;
    }
  },

  // App Display Size
  async getDisplaySize(): Promise<'small' | 'default' | 'large'> {
    const size = await AsyncStorage.getItem('crumbo_display_size');
    if (size === 'small' || size === 'default' || size === 'large') {
      return size;
    }
    return 'default';
  },

  async saveDisplaySize(size: 'small' | 'default' | 'large'): Promise<void> {
    await AsyncStorage.setItem('crumbo_display_size', size);
  },

  // App Theme
  async getTheme(): Promise<'light' | 'dark'> {
    const theme = await AsyncStorage.getItem('crumbo_theme');
    if (theme === 'light' || theme === 'dark') {
      return theme;
    }
    return 'light';
  },

  async saveTheme(theme: 'light' | 'dark'): Promise<void> {
    await AsyncStorage.setItem('crumbo_theme', theme);
  },

  // Reset helper
  async clearAll(): Promise<void> {
    await AsyncStorage.clear();
  },

  /**
   * Permanently deletes this parent's entire account from the server: every kid's profile row,
   * their push tokens, all chat/call history, any uploaded photos/drawings, and finally the
   * auth.users row itself. Deleting an auth user requires the service-role key, which the app
   * never holds — this delegates to the delete-account Edge Function (runs server-side with
   * that key), authenticated via this client's current Supabase Auth session. Irreversible;
   * callers are expected to confirm with the user first and clear local state afterward.
   */
  async deleteAccountFromServer(): Promise<void> {
    const { error } = await supabase.functions.invoke('delete-account');
    if (error) {
      throw new Error(error.message || "Failed to delete account from the server");
    }
  }
};

// A helper for simulated friend responses
const MOCK_ANSWERS: Record<string, string[]> = {
  general: [
    "That is so cool! 🌟",
    "Haha awesome! 👾",
    "Do you want to play a game later? 🎮",
    "Let's bake some cookies! 🍪🍪",
    "Look at this: 🦕 rawr!",
    "Wow, I love that! ❤️",
    "What are you doing today? 🎈",
    "I am building a lego castle right now 🧱"
  ]
};

export function triggerMockReply(
  friend: Friend,
  userMessageText: string,
  onReply: (msg: Message) => void
) {
  setTimeout(async () => {
    const list = MOCK_ANSWERS.general;
    const replyText = list[Math.floor(Math.random() * list.length)];

    const received = await StorageService.receiveMockMessage(friend.id, replyText);
    onReply(received);
  }, 1500); // 1.5 seconds typing lag for realism
}
