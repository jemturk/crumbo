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
  // Only ever set for an adult contact (a parent or a relative added by email) who's uploaded a
  // real photo — takes rendering priority over avatarEmoji when present. Kids stick to the emoji
  // picker and never set this.
  avatarUrl?: string;
}

// Adding a new per-kid lock flag? There's no single source of truth for KidProfile — it's
// manually reconstructed at every one of these sites, so a new flag must be added to all of
// them or it'll silently fail to persist/sync: createKidProfile, buildParentPushTokenPayload,
// fetchAndRestoreParentData, deleteKidProfile's reactivation, updateKidSettingsForProfile's
// (and updateKidSettings's) settings type, activateKidOnThisDevice, and syncKidProfileAndFriends
// (the most important one — it's what delivers a parent's toggle to the kid's device). Also:
// every settings-object literal passed to updateKidSettingsForProfile in dashboard.tsx.
export interface KidProfile {
  name: string;
  cookieCode: string;
  avatarEmoji?: string;
  chatDisabled?: boolean;
  callingDisabled?: boolean;
  videoCallingDisabled?: boolean;
  photosDisabled?: boolean;
  drawingDisabled?: boolean;
  voiceMessagesDisabled?: boolean;
  friends?: any[];
  // Which physical device currently has this kid activated (see activateKidOnThisDevice /
  // deactivateKidOnThisDevice). Only meaningful on the KIDS_LIST entries a parent's device
  // caches from the server — the device's own KID_PROFILE (this kid's local, active-on-THIS-
  // device copy) doesn't need it, since being present in KID_PROFILE at all already implies it.
  boundDeviceId?: string | null;
}

// Storage keys
const KEYS = {
  PARENT_EMAIL: 'crumbo_parent_email',
  PARENT_NAME: 'crumbo_parent_name',
  PARENT_AVATAR_URL: 'crumbo_parent_avatar_url',
  PARENT_AVATAR_EMOJI: 'crumbo_parent_avatar_emoji',
  PARENT_PUSH_TOKEN: 'crumbo_parent_push_token',
  IS_SUBSCRIBED: 'crumbo_is_subscribed',
  KID_PROFILE: 'crumbo_kid_profile',
  FRIENDS: 'crumbo_friends',
  MESSAGES_PREFIX: 'crumbo_messages_',
  OUTBOX_PREFIX: 'crumbo_outbox_',
  KIDS_LIST: 'crumbo_parent_kids_list',
  HAS_SEEN_ONBOARDING: 'crumbo_has_seen_onboarding',
  DEVICE_ID: 'crumbo_device_id',
  // Whether the PARENT (as opposed to one of their kids) is the active user on this device.
  // Mutually exclusive with KID_PROFILE by construction — activateParentOnDevice/
  // activateKidOnThisDevice each clear the other slot before setting their own.
  PARENT_ACTIVE_ON_DEVICE: 'crumbo_parent_active_on_device',
  // Opt-in: this device may use Face ID/fingerprint to resume an already-persisted Supabase
  // session on gate.tsx, instead of typing the password again. Never gates a FRESH sign-in —
  // there's no session to resume if the parent has actually signed out, or never signed in here.
  BIOMETRIC_ENABLED: 'crumbo_biometric_enabled',
};

// Default setup — also the pool the avatar picker UI offers (see AvatarPickerModal).
export const DEFAULT_EMOJIS = ['🍪', '🧁', '🍩', '🍫', '🍧', '🍰', '🍭', '🍓', '🍒', '🦕', '🐱', '🐼', '🐨', '🦊', '🦁', '🐶', '🐰', '🐸', '🦄', '🐧'];

function randomAvatarEmoji(): string {
  return DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
}

// The adult-avatar picker's family-role presets (see AdultAvatarPickerModal) — an alternative to
// an uploaded photo, not a kid's food/animal-style pick. Aunt/uncle deliberately use a visually
// distinct emoji from mom/dad (not just a different label on the same glyph).
export const ADULT_AVATAR_PRESETS: { emoji: string; label: string }[] = [
  { emoji: '👩', label: 'Mom' },
  { emoji: '👨', label: 'Dad' },
  { emoji: '👵', label: 'Grandma' },
  { emoji: '👴', label: 'Grandpa' },
  { emoji: '👩‍🦱', label: 'Aunt' },
  { emoji: '🧔‍♂️', label: 'Uncle' },
];

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

/**
 * Uploads a recorded voice message (already-finished .m4a file from VoiceRecorderModal) to the
 * same `kid_media` bucket used for photos/drawings — no re-encoding needed, expo-audio's
 * recorder output is used as-is. Used by sendVoiceMessage, which embeds the URL (and duration,
 * so the player bubble can show a length before the audio itself has loaded) in the message
 * text as `[VOICE:<durationSeconds>|<url>]`.
 */
async function uploadAudioMessage(localUri: string, senderCookieCode: string): Promise<string> {
  const file = new File(localUri);
  const bytes = await file.arrayBuffer();
  const path = `${senderCookieCode}/voice_${Crypto.randomUUID()}.m4a`;

  const { error } = await supabase.storage
    .from('kid_media')
    .upload(path, bytes, { contentType: 'audio/m4a' });

  if (error) {
    throw new Error(error.message || 'Failed to upload voice message');
  }

  const { data } = supabase.storage.from('kid_media').getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Uploads an adult's avatar photo to the (separate, dedicated) `avatars` bucket. Unlike
 * compressAndUploadImage's random per-message filenames, this always writes to the SAME path per
 * account — re-uploading just overwrites it, no orphaned files pile up. A `?t=<timestamp>` query
 * param is appended to the returned URL purely to cache-bust: the underlying object path never
 * changes, so without it clients could keep showing a stale cached copy after a re-upload.
 */
async function compressAndUploadAvatar(localUri: string, pathKey: string): Promise<string> {
  const manipulated = await ImageManipulator.manipulate(localUri)
    .resize({ width: 400, height: 400 })
    .renderAsync()
    .then(image => image.saveAsync({ compress: 0.7, format: SaveFormat.JPEG }));

  const file = new File(manipulated.uri);
  const bytes = await file.arrayBuffer();
  const path = `${pathKey}/avatar.jpg`;

  const { error } = await supabase.storage
    .from('avatars')
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });

  if (error) {
    throw new Error(error.message || 'Failed to upload avatar');
  }

  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return `${data.publicUrl}?t=${Date.now()}`;
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

// A Cookie Code alone used to be the entire kid credential — no password, no device check — so
// anyone who obtained a code (guessed, leaked, shoulder-surfed) could log in as that kid from
// anywhere. There's no self-service login at all anymore (see activateKidOnThisDevice): this
// device ID is generated once and cached locally, and is set as a kid's boundDeviceId only by an
// authenticated parent's own activation action, never by anyone presenting a code.
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

  // The parent's own stable chat identity — their profiles.cookie_code, `PARENT:<email>` — for
  // sendParentMessage/subscribeToParentMessages. Kept behind this helper so the UI layer doesn't
  // need to know the `PARENT:` prefix convention itself.
  async getMyParentCode(): Promise<string | null> {
    const email = await this.getParentEmail();
    return email ? `PARENT:${email}` : null;
  },

  async saveParentEmail(email: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARENT_EMAIL, email);
  },

  // The parent's own preferred display name — shown in Managed Users and used as the "name" a
  // paired parent sees for this account (see pairParentsViaQRCode/getParentContacts), in place of
  // the raw email. Synced up via buildParentPushTokenPayload and restored by
  // fetchAndRestoreParentData, same as displaySize/theme.
  async getParentName(): Promise<string | null> {
    return await AsyncStorage.getItem(KEYS.PARENT_NAME);
  },

  async saveParentName(name: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARENT_NAME, name);
  },

  async getParentAvatarUrl(): Promise<string | null> {
    return await AsyncStorage.getItem(KEYS.PARENT_AVATAR_URL);
  },

  async saveParentAvatarUrl(url: string | null): Promise<void> {
    if (url) {
      await AsyncStorage.setItem(KEYS.PARENT_AVATAR_URL, url);
    } else {
      await AsyncStorage.removeItem(KEYS.PARENT_AVATAR_URL);
    }
  },

  async getParentAvatarEmoji(): Promise<string | null> {
    return await AsyncStorage.getItem(KEYS.PARENT_AVATAR_EMOJI);
  },

  async saveParentAvatarEmoji(emoji: string | null): Promise<void> {
    if (emoji) {
      await AsyncStorage.setItem(KEYS.PARENT_AVATAR_EMOJI, emoji);
    } else {
      await AsyncStorage.removeItem(KEYS.PARENT_AVATAR_EMOJI);
    }
  },

  async getParentPushToken(): Promise<string | null> {
    return await AsyncStorage.getItem(KEYS.PARENT_PUSH_TOKEN);
  },

  async saveParentPushToken(token: string | null): Promise<void> {
    if (token) {
      await AsyncStorage.setItem(KEYS.PARENT_PUSH_TOKEN, token);
    } else {
      await AsyncStorage.removeItem(KEYS.PARENT_PUSH_TOKEN);
    }
  },

  /**
   * Adult counterpart to registerPushToken — a parent's `profiles.push_token` column already
   * holds their whole kids/friends JSON payload (see buildParentPushTokenPayload), not a raw
   * Expo token, so this can't just overwrite that column directly the way the kid version does.
   * Instead the token is cached locally (like parentName/parentAvatarEmoji) and nested into the
   * payload as a `pushToken` field on the next sync — see notify-call/index.ts's matching
   * branch, which knows to look in either place depending on which kind of row it finds.
   */
  async registerParentPushToken(token: string | null): Promise<void> {
    try {
      await this.saveParentPushToken(token);
      await this.syncParentData();
    } catch (e) {
      console.error("Error registering parent push token on Supabase", e);
    }
  },

  /**
   * Picks one of the family-role preset avatars (see ADULT_AVATAR_PRESETS) instead of an
   * uploaded photo. Mutually exclusive with the photo — picking a preset clears any uploaded
   * photo the same way uploading a new photo clears any picked preset (AdultAvatar only ever
   * shows one: the photo if present, else the emoji, else a plain "G").
   */
  async setParentAvatarEmoji(emoji: string): Promise<boolean> {
    try {
      await this.saveParentAvatarEmoji(emoji);
      await this.saveParentAvatarUrl(null);
      await this.syncParentData();
      return true;
    } catch (e) {
      console.error("Error setting parent avatar emoji:", e);
      return false;
    }
  },

  /**
   * Uploads a new avatar photo for the signed-in parent, saves it locally, and syncs it to the
   * server so it's what a kid/paired parent/relative sees for this account going forward. Note:
   * anyone who already has this parent cached as a Friend (a kid's own friends[] entry, a paired
   * parent's, etc.) won't see the change until THEIR next resync of that entry — there's no live
   * avatar-push the way kid buddies get via checkFriendPairingStatus's piggybacked avatar fetch.
   */
  async uploadParentAvatar(localUri: string): Promise<string | null> {
    const email = await this.getParentEmail();
    if (!email) return null;
    try {
      // Pass the RAW email, not encodeURIComponent(email) — compressAndUploadAvatar's own
      // getPublicUrl() call already percent-encodes the path when building the URL. Pre-encoding
      // here too made the object actually get stored under a key containing a literal "%40" (3
      // characters) instead of "@", while the returned URL then encoded THAT "%" again into
      // "%25" — a URL that 404s/400s against the real key, so the photo silently failed to load
      // anywhere it was used.
      const url = await compressAndUploadAvatar(localUri, email);
      await this.saveParentAvatarUrl(url);
      // Mutually exclusive with a picked preset (see setParentAvatarEmoji) — a real photo always
      // wins once one is uploaded.
      await this.saveParentAvatarEmoji(null);
      await this.syncParentData();
      return url;
    } catch (e) {
      console.error("Error uploading parent avatar:", e);
      return null;
    }
  },

  async removeParentAvatar(): Promise<void> {
    const email = await this.getParentEmail();
    await this.saveParentAvatarUrl(null);
    if (email) {
      try {
        // Raw email, matching the (now-fixed) raw key uploadParentAvatar actually stores under.
        await supabase.storage.from('avatars').remove([`${email}/avatar.jpg`]);
      } catch (e) {
        console.error("Error removing avatar file:", e);
      }
      await this.syncParentData();
    }
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

    // A kid's own parent is a chat contact from the moment they exist — no pairing needed, same
    // as the parent's own side already auto-including every kid they manage (getParentContacts).
    // Uses the same PARENT:<email> address/Friend-entry convention as everything else that
    // addresses a parent as a chat contact (pairParentsViaQRCode, addRelativeToKidByEmail).
    const initialFriends: Friend[] = [];
    const parentEmail = await this.getParentEmail();
    if (parentEmail) {
      const parentName = (await this.getParentName()) || parentEmail;
      const parentAvatarUrl = await this.getParentAvatarUrl();
      const parentAvatarEmoji = await this.getParentAvatarEmoji();
      initialFriends.push({
        id: Crypto.randomUUID(),
        name: parentName,
        cookieCode: `PARENT:${parentEmail}`,
        avatarEmoji: parentAvatarEmoji || '👪',
        avatarUrl: parentAvatarUrl || undefined
      });
    }

    const profile: KidProfile = {
      name,
      cookieCode,
      avatarEmoji: randomAvatarEmoji(),
      chatDisabled: false,
      callingDisabled: false,
      videoCallingDisabled: false,
      photosDisabled: false,
      drawingDisabled: false,
      voiceMessagesDisabled: false,
      friends: initialFriends
    };

    // Add to kids list
    const kids = await this.getKidsList();
    const isFirstKidEver = kids.length === 0;
    kids.push(profile);
    await this.saveKidsList(kids);

    // The very first kid on a brand-new account becomes active on this device automatically
    // (the common "just registered, immediately added my kid" setup flow) — but only if this
    // device has no one else already active, so it never silently swaps out an existing kid or
    // parent session. The caller (dashboard.tsx's handleCreateProfile) still needs to claim the
    // server-side device lock via activateKidOnThisDevice once this kid has been synced up.
    if (isFirstKidEver) {
      const activeKid = await this.getKidProfile();
      const parentActive = await this.isParentActiveOnDevice();
      if (!activeKid && !parentActive) {
        await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(profile));
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(initialFriends));
      }
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

  /**
   * The parent's own chat contacts: every kid they manage (automatic — no pairing needed, it's
   * literally their own account) plus any other parents they've paired with (see
   * pairParentsViaQRCode) — stored as a top-level `friends` field on the parent's own payload,
   * sibling to `kids` rather than nested inside any one kid's own friends list.
   */
  async getParentContacts(): Promise<{ code: string; name: string; avatarEmoji?: string; avatarUrl?: string; isOwnKid: boolean }[]> {
    const email = await this.getParentEmail();
    if (!email) return [];
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('cookie_code', `PARENT:${email}`)
        .single();

      if (error || !data || !data.push_token) return [];
      const payload = JSON.parse(data.push_token);

      const ownKids = (payload.kids || []).map((k: any) => ({
        code: k.cookieCode,
        name: k.name,
        avatarEmoji: k.avatarEmoji,
        isOwnKid: true,
      }));

      // The snapshot in `payload.friends` is only ever written once, at pairing time (see
      // pairParentsViaQRCode) — buildParentPushTokenPayload preserves it verbatim on every later
      // sync (it has no way to track this list, see the comment there), so a paired parent's own
      // avatar/name changes never reach it. Refresh each entry from that parent's own live
      // profile row here, at chat-list read time — the same way checkFriendPairingStatus
      // piggybacks a live avatar fetch for kid friends — falling back to the cached snapshot if
      // the lookup fails (offline) or that parent has no avatar set yet.
      const rawParentFriends: any[] = payload.friends || [];
      const pairedParents = await Promise.all(rawParentFriends.map(async (f: any) => {
        let name = f.name;
        let avatarEmoji = f.avatarEmoji;
        let avatarUrl = f.avatarUrl;
        try {
          const { data: friendData } = await supabase
            .from('profiles')
            .select('push_token')
            .eq('cookie_code', f.cookieCode)
            .single();
          if (friendData?.push_token) {
            const friendPayload = JSON.parse(friendData.push_token);
            name = friendPayload.parentName || name;
            avatarEmoji = friendPayload.parentAvatarEmoji || avatarEmoji;
            avatarUrl = friendPayload.parentAvatarUrl || avatarUrl;
          }
        } catch {
          // Offline/lookup failure — fall back to the cached snapshot values above.
        }
        return {
          code: f.cookieCode,
          name,
          avatarEmoji,
          avatarUrl,
          isOwnKid: false,
        };
      }));

      return [...ownKids, ...pairedParents];
    } catch (e) {
      console.error("Error fetching parent contacts:", e);
      return [];
    }
  },

  /**
   * Sending as the parent uses their own `PARENT:<email>` cookie_code as sender_code — already
   * guaranteed unique (it's the row's own key) and never collides with a kid's CRUM-###-### format,
   * so this needs no new column or migration, just a different sender identity than sendMessage's
   * (which always derives it from getKidProfile()). No local cache/outbox here (unlike
   * sendMessage) — the parent's contact list and conversations are always read live from the
   * server rather than cached offline, matching getParentContacts/getChatLogsForParent.
   */
  async sendParentMessage(myCode: string, receiverCode: string, text: string): Promise<Message> {
    const newMsg: Message = {
      id: Crypto.randomUUID(),
      text,
      timestamp: new Date().toISOString(),
      sender: 'me',
    };

    const { error } = await supabase
      .from('messages')
      .insert({
        id: newMsg.id,
        sender_code: myCode,
        receiver_code: receiverCode,
        text,
        created_at: newMsg.timestamp,
      });

    if (error) {
      throw new Error(error.message || "Failed to send message");
    }
    return newMsg;
  },

  /**
   * Adult-side counterparts to sendImageMessage/sendDrawingMessage/sendVoiceMessage — same
   * upload-then-send shape (compressAndUploadImage/uploadAudioMessage are already generic, keyed
   * by sender cookie code rather than a kid identity), but live-only like sendParentMessage: no
   * local cache/outbox, since adult conversations are never cached offline.
   */
  async sendParentImageMessage(myCode: string, receiverCode: string, localUri: string): Promise<Message> {
    const url = await compressAndUploadImage(localUri, 'photo', myCode);
    return this.sendParentMessage(myCode, receiverCode, `[IMAGE:${url}]`);
  },

  async sendParentDrawingMessage(myCode: string, receiverCode: string, localUri: string): Promise<Message> {
    const url = await compressAndUploadImage(localUri, 'drawing', myCode);
    return this.sendParentMessage(myCode, receiverCode, `[DRAWING:${url}]`);
  },

  async sendParentVoiceMessage(myCode: string, receiverCode: string, localUri: string, durationSeconds: number): Promise<Message> {
    const url = await uploadAudioMessage(localUri, myCode);
    return this.sendParentMessage(myCode, receiverCode, `[VOICE:${Math.round(durationSeconds)}|${url}]`);
  },

  // Realtime counterpart to sendParentMessage/getChatLogsForParent — mirrors subscribeToMessages
  // but keyed by an explicit `myCode` (the parent's own PARENT:<email>) instead of deriving it
  // from getKidProfile(), and dispatches by the OTHER party's raw code directly (no local
  // Friend.id to resolve, since parent conversations aren't cached locally).
  subscribeToParentMessages(myCode: string, onNewMessage: (msg: Message, otherCode: string) => void): () => void {
    const channelId = Math.random().toString(36).substring(2, 9);
    const dbChannel = supabase
      .channel(`public:messages:${channelId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const newRow = payload.new;
          if (this.isCallSignalText(newRow.text)) return;

          const isSentByMe = newRow.sender_code === myCode;
          const isReceivedByMe = newRow.receiver_code === myCode;
          if (!isSentByMe && !isReceivedByMe) return;

          const msg: Message = {
            id: newRow.id,
            text: newRow.text,
            timestamp: newRow.created_at,
            sender: isSentByMe ? 'me' : 'them',
          };
          onNewMessage(msg, isSentByMe ? newRow.receiver_code : newRow.sender_code);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(dbChannel);
    };
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
    const email = await this.getParentEmail();
    const parentName = await this.getParentName();
    const parentAvatarUrl = await this.getParentAvatarUrl();
    const parentAvatarEmoji = await this.getParentAvatarEmoji();
    const pushToken = await this.getParentPushToken();
    const parentCode = email ? `PARENT:${email}` : null;
    const parentDisplayName = parentName || email || 'Parent';

    // Fetched once up front so both the `friends` preservation below AND the kids merge just
    // after it can use the same server snapshot, rather than two separate round-trips.
    let serverPayload: any = null;
    if (email) {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('push_token')
          .eq('cookie_code', `PARENT:${email}`)
          .single();
        if (data?.push_token) {
          serverPayload = JSON.parse(data.push_token);
        }
      } catch {
        // Offline/new account — nothing to preserve yet.
      }
    }

    const kidsPayload = kids.map(k => {
      // If this is the active kid, use the latest friends list/avatar from storage — this
      // device's own KID_PROFILE is fresher than the parent dashboard's KIDS_LIST cache when
      // they're the same kid (e.g. a kid who picked a new avatar via setKidAvatar, which writes
      // straight to the server but has no way to update THIS separate device's local cache).
      const isCurrentActive = activeProfile?.cookieCode === k.cookieCode;
      const friendsList = isCurrentActive ? activeFriends : (k.friends || []);

      // Every kid automatically has their own parent as a chat contact (see createKidProfile) —
      // backfilled defensively here too, for any kid created before this existed. Also keeps an
      // EXISTING entry's name/avatarUrl in sync on every sync — without this, a kid created
      // before the parent ever uploaded a photo keeps that parent's friend-list entry frozen at
      // "no photo" forever, since the entry already existing short-circuited the backfill and
      // nothing else ever goes back to refresh it (this is the one call site that runs right when
      // the parent's own device changes its photo, so it's the most direct place to propagate it).
      const existingParentEntry = parentCode ? friendsList.find((f: any) => f.cookieCode === parentCode) : undefined;
      const friendsWithParent = !parentCode
        ? friendsList
        : !existingParentEntry
        ? [...friendsList, { id: Crypto.randomUUID(), name: parentDisplayName, cookieCode: parentCode, avatarEmoji: parentAvatarEmoji || '👪', avatarUrl: parentAvatarUrl || undefined }]
        : friendsList.map((f: any) =>
            f.cookieCode === parentCode ? { ...f, name: parentDisplayName, avatarEmoji: parentAvatarEmoji || '👪', avatarUrl: parentAvatarUrl || undefined } : f
          );

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
        voiceMessagesDisabled: !!k.voiceMessagesDisabled,
        boundDeviceId: k.boundDeviceId,
        friends: friendsWithParent.map((f: any) => ({
          id: f.id,
          name: f.name,
          cookieCode: f.cookieCode,
          avatarEmoji: f.avatarEmoji,
          avatarUrl: f.avatarUrl
        }))
      };
    });

    const displaySize = await AsyncStorage.getItem('crumbo_display_size') || 'default';
    const theme = await AsyncStorage.getItem('crumbo_theme') || 'light';

    // Preserve the existing top-level `friends` field (other parents paired via
    // pairParentsViaQRCode, sibling to `kids`) — everything above is rebuilt from local caches
    // that don't track that list at all, so without this, ANY syncParentData() call after
    // pairing (adding a kid, toggling a lock, etc.) would silently overwrite it away to nothing.
    const parentFriends: unknown[] = serverPayload?.friends || [];

    // Same problem, much higher stakes: this device's local getKidsList() cache can be empty or
    // incomplete for reasons that have nothing to do with the parent actually having no kids —
    // a device that's only ever been used for one narrow task (e.g. just uploading an avatar
    // photo, or right after a "Log Out" that clears the local cache) may never have pulled the
    // real kids list down at all. Blindly trusting kidsPayload here turned "upload a photo" into
    // "silently delete every kid" the first time this happened. Any kid the SERVER still knows
    // about that this device's local cache doesn't is carried over untouched instead of dropped —
    // a kid genuinely deleted goes through deleteKidProfile, which removes it from the local
    // cache AND pushes that removal itself, so it's gone from both sides in lockstep already.
    const localCookieCodes = new Set(kidsPayload.map(k => k.cookieCode));
    const preservedServerKids = ((serverPayload?.kids || []) as any[]).filter(
      k => !localCookieCodes.has(k.cookieCode)
    );

    return JSON.stringify({
      subscribed,
      kids: [...kidsPayload, ...preservedServerKids],
      displaySize,
      theme,
      parentName,
      parentAvatarUrl,
      parentAvatarEmoji,
      pushToken,
      friends: parentFriends
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

        if (payload.parentName) {
          await AsyncStorage.setItem(KEYS.PARENT_NAME, payload.parentName);
        }

        if (payload.parentAvatarUrl) {
          await AsyncStorage.setItem(KEYS.PARENT_AVATAR_URL, payload.parentAvatarUrl);
        }

        if (payload.parentAvatarEmoji) {
          await AsyncStorage.setItem(KEYS.PARENT_AVATAR_EMOJI, payload.parentAvatarEmoji);
        }

        // Always reflect THIS account's kids — even when there are none — rather than only
        // writing KIDS_LIST when non-empty. Skipping that when empty used to leave a PREVIOUS
        // account's kids sitting in local cache untouched, so switching accounts on the same
        // device (sign out, then sign into or register a different email) could keep showing the
        // old account's kids for as long as the new one had none of its own yet.
        //
        // Deliberately does NOT touch KID_PROFILE/FRIENDS (which kid, if any, is active on THIS
        // device) — activation only ever happens via an explicit Managed Users action
        // (activateKidOnThisDevice), never as a side effect of merely signing in. Whatever was
        // active on this device before this call stays active after it.
        const kids = payload.kids || [];
        await AsyncStorage.setItem(KEYS.KIDS_LIST, JSON.stringify(kids));
        return true;
      }
    } catch (e) {
      console.error("Failed to restore parent data from Supabase:", e);
    }
    return false;
  },

  async updateKidSettings(settings: { chatDisabled: boolean; callingDisabled: boolean; videoCallingDisabled: boolean; photosDisabled: boolean; drawingDisabled: boolean; voiceMessagesDisabled: boolean }): Promise<void> {
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

  /**
   * Sends a recorded voice message (see VoiceRecorderModal, capped at 3 minutes there). Mirrors
   * sendMediaMessage's upload-then-send shape, but encodes duration alongside the URL —
   * `[VOICE:<durationSeconds>|<url>]` — so a message preview or bubble can show a length
   * immediately without first loading the audio file itself.
   */
  async sendVoiceMessage(friendId: string, localUri: string, durationSeconds: number): Promise<Message> {
    const profile = await this.getKidProfile();
    const friends = await this.getFriends();
    const friend = friends.find(f => f.id === friendId);
    if (!profile || !friend) {
      throw new Error('No active profile or friend to send to');
    }

    const url = await uploadAudioMessage(localUri, profile.cookieCode);
    const text = `[VOICE:${Math.round(durationSeconds)}|${url}]`;
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
          drawingDisabled: !!nextActive.drawingDisabled,
          voiceMessagesDisabled: !!nextActive.voiceMessagesDisabled
        }));
        if (nextActive.friends) {
          await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(nextActive.friends));
        }
      } else {
        await AsyncStorage.removeItem(KEYS.KID_PROFILE);
        await AsyncStorage.removeItem(KEYS.FRIENDS);
      }
    }

    // Removed from the SERVER's kids[] directly too, rather than leaving it to some later
    // syncParentData() call to notice it's missing from the local list — buildParentPushTokenPayload
    // deliberately preserves any kid the server still has that this device's local cache doesn't
    // (see its own comment), specifically so an incomplete/stale local cache can never silently wipe
    // out a kid it simply hasn't synced down yet. Without this direct removal, that exact protection
    // would just as happily un-delete a kid that actually was deleted a moment ago on this device.
    const email = await this.getParentEmail();
    if (email) {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('*')
          .eq('cookie_code', `PARENT:${email}`)
          .single();
        if (data?.push_token) {
          const payload = JSON.parse(data.push_token);
          payload.kids = (payload.kids || []).filter((k: any) => k.cookieCode !== cookieCode);
          await supabase
            .from('profiles')
            .upsert({ cookie_code: data.cookie_code, push_token: JSON.stringify(payload), name: data.name });
        }
      } catch (e) {
        console.error("Error removing kid from server:", e);
      }
    }
  },

  /**
   * Clears this kid's device binding server-side. Callable from any device the parent happens
   * to be signed into Parent Area on — it's a pure server-side mutation, not tied to physical
   * possession of the kid's old phone. If the device calling this happens to be the one that had
   * the kid active locally, it's logged out here too so this device's own UI reflects the change
   * immediately.
   *
   * There's no self-service reclaim path anymore (see activateKidOnThisDevice) — freeing this
   * binding doesn't hand the code back out as a bearer secret the way it used to, since claiming
   * it again always requires the parent to activate it from Managed Users.
   */
  async deactivateKidOnThisDevice(cookieCode: string): Promise<{ success: boolean }> {
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

          payload.kids[kidIndex] = { ...payload.kids[kidIndex], boundDeviceId: null };
          await supabase
            .from('profiles')
            .upsert({ cookie_code: parentRow.cookie_code, push_token: JSON.stringify(payload), name: parentRow.name });

          const active = await this.getKidProfile();
          if (active && active.cookieCode === cookieCode) {
            await this.logoutKid();
          }
          return { success: true };
        } catch {}
      }
      return { success: false };
    } catch (e) {
      console.error("Error deactivating kid on this device:", e);
      return { success: false };
    }
  },

  /**
   * The ONLY way a kid ever becomes active on a device — always called from the authenticated
   * Parent Area (Managed Users), never by the kid themselves. There is no code-entry login
   * anymore; a Cookie Code identifies a kid for cross-family friend pairing only.
   *
   * Enforces "no other device can activate the same kid" (boundDeviceId must be unset or already
   * this device before claiming), and — per the single-active-user-per-device rule — clears
   * whatever else was active on this device first (a different kid, or the parent) so activating
   * a new user is always a one-step swap.
   */
  async activateKidOnThisDevice(cookieCode: string): Promise<{ success: boolean; error?: 'ALREADY_ACTIVE_ELSEWHERE' | 'NOT_FOUND' }> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${cookieCode}"%`);

      if (error || !data) return { success: false, error: 'NOT_FOUND' };

      let targetKid = null;
      let owningRow = null;
      let owningPayload: any = null;
      for (const parentProfile of data) {
        try {
          const payload = JSON.parse(parentProfile.push_token);
          const found = payload?.kids?.find((k: any) => k.cookieCode === cookieCode);
          if (found) {
            targetKid = found;
            owningRow = parentProfile;
            owningPayload = payload;
            break;
          }
        } catch {}
      }

      if (!targetKid) return { success: false, error: 'NOT_FOUND' };

      const deviceId = await getDeviceId();
      if (targetKid.boundDeviceId && targetKid.boundDeviceId !== deviceId) {
        return { success: false, error: 'ALREADY_ACTIVE_ELSEWHERE' };
      }

      const kidIndex = owningPayload.kids.findIndex((k: any) => k.cookieCode === cookieCode);
      owningPayload.kids[kidIndex] = { ...owningPayload.kids[kidIndex], boundDeviceId: deviceId };
      await supabase
        .from('profiles')
        .upsert({
          cookie_code: owningRow!.cookie_code,
          push_token: JSON.stringify(owningPayload),
          name: owningRow!.name
        });

      // Exactly one active user per device: free whichever OTHER kid was locally active here
      // (their own boundDeviceId lock, server-side), and drop the parent-active flag too.
      const previouslyActive = await this.getKidProfile();
      if (previouslyActive && previouslyActive.cookieCode !== cookieCode) {
        await this.deactivateKidOnThisDevice(previouslyActive.cookieCode);
      }
      await this.deactivateParentOnDevice();

      // Writes KID_PROFILE/FRIENDS straight from the payload just fetched and patched above,
      // rather than going through activateKidProfile (which re-reads this device's own
      // getKidsList() cache) — that cache can be stale enough to not contain this kid at all yet
      // (e.g. the very first activation on a device that never synced before), silently leaving
      // KID_PROFILE unset even though the server-side boundDeviceId claim just succeeded.
      const target = owningPayload.kids[kidIndex];
      await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify({
        name: target.name,
        cookieCode: target.cookieCode,
        avatarEmoji: target.avatarEmoji,
        chatDisabled: !!target.chatDisabled,
        callingDisabled: !!target.callingDisabled,
        videoCallingDisabled: !!target.videoCallingDisabled,
        photosDisabled: !!target.photosDisabled,
        drawingDisabled: !!target.drawingDisabled,
        voiceMessagesDisabled: !!target.voiceMessagesDisabled
      }));
      await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(target.friends || []));

      return { success: true };
    } catch (e) {
      console.error("Error activating kid on this device:", e);
      return { success: false };
    }
  },

  async updateKidSettingsForProfile(
    cookieCode: string, 
    settings: { chatDisabled: boolean; callingDisabled: boolean; videoCallingDisabled: boolean; photosDisabled: boolean; drawingDisabled: boolean; voiceMessagesDisabled: boolean }
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

  async isParentActiveOnDevice(): Promise<boolean> {
    const value = await AsyncStorage.getItem(KEYS.PARENT_ACTIVE_ON_DEVICE);
    return value === 'true';
  },

  // Exposes the module-private device id so Managed Users can tell "active on THIS device"
  // apart from "active on some other device" for each kid's boundDeviceId.
  async getDeviceId(): Promise<string> {
    return getDeviceId();
  },

  async isBiometricEnabled(): Promise<boolean> {
    const value = await AsyncStorage.getItem(KEYS.BIOMETRIC_ENABLED);
    return value === 'true';
  },

  async setBiometricEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      await AsyncStorage.setItem(KEYS.BIOMETRIC_ENABLED, 'true');
    } else {
      await AsyncStorage.removeItem(KEYS.BIOMETRIC_ENABLED);
    }
  },

  /**
   * Makes the PARENT (rather than any of their kids) the active user on this device — purely
   * local, no server call, since a signed-in parent isn't device-locked the way a kid is (they
   * can be "active" — i.e. using their own chat — on more than one device at once; only a KID's
   * identity is restricted to a single bound device). Clears any locally-active kid first so the
   * two states stay mutually exclusive.
   */
  async activateParentOnDevice(): Promise<void> {
    // deactivateKidOnThisDevice clears that kid's SERVER-side boundDeviceId too — without it, a
    // kid who was active here would keep showing as "active on this device" everywhere (and stay
    // wrongly blocked from being activated on any OTHER device) even after the parent takes over
    // this device. A plain logoutKid() call afterward guarantees the LOCAL half of this always
    // happens even if that server call fails (e.g. offline) — better to be locally consistent now
    // and let the next successful sync reconcile the server side, than leave both parent and kid
    // looking simultaneously "active" on this one device.
    const previouslyActiveKid = await this.getKidProfile();
    if (previouslyActiveKid) {
      await this.deactivateKidOnThisDevice(previouslyActiveKid.cookieCode);
    }

    // Belt-and-suspenders check straight against the server's own kids[], not just this
    // device's local KID_PROFILE cache — the two can drift (e.g. a kid claimed on a device whose
    // local kids[] cache didn't have them yet used to leave KID_PROFILE unset even though the
    // server-side boundDeviceId claim succeeded), which could leave a kid's Managed Users card
    // stuck showing "Active on this device" even after a parent activated here. Only checks
    // kids owned by THIS parent's own account — a kid active here via a different owning
    // account (e.g. an invited relative) is already covered by the local check above.
    const deviceId = await getDeviceId();
    const email = await this.getParentEmail();
    if (email) {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('*')
          .eq('cookie_code', `PARENT:${email}`)
          .single();
        if (data?.push_token) {
          const payload = JSON.parse(data.push_token);
          const boundKid = (payload.kids || []).find((k: any) => k.boundDeviceId === deviceId);
          if (boundKid) {
            await this.deactivateKidOnThisDevice(boundKid.cookieCode);
          }
        }
      } catch (e) {
        console.error("Error checking for a kid still bound to this device:", e);
      }
    }

    await this.logoutKid();
    await AsyncStorage.setItem(KEYS.PARENT_ACTIVE_ON_DEVICE, 'true');
  },

  async deactivateParentOnDevice(): Promise<void> {
    await AsyncStorage.removeItem(KEYS.PARENT_ACTIVE_ON_DEVICE);
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
      let owningRow: any = null;
      let owningPayload: any = null;
      if (data) {
        for (const parentProfile of data) {
          try {
            const payload = JSON.parse(parentProfile.push_token);
            if (payload && payload.kids) {
              const found = payload.kids.find((k: any) => k.cookieCode === active.cookieCode);
              if (found) {
                targetKid = found;
                owningRow = parentProfile;
                owningPayload = payload;
                break;
              }
            }
          } catch {}
        }
      }

      if (!targetKid) {
        // The query succeeded but no parent row's kids[] contains this cookie code anymore —
        // this kid was removed. Unlike a network hiccup, this genuinely means "you don't exist
        // here anymore" — thrown so the caller can force a real logout instead of silently
        // continuing to operate on stale local cache.
        throw new Error('KID_NOT_FOUND');
      }

      // Self-heal: make sure this kid's OWN current owning parent is in their friends list, AND
      // that an existing entry's name/avatarUrl match the parent's current ones.
      // buildParentPushTokenPayload's own backfill only ever runs when the PARENT's device calls
      // syncParentData() — merely activating a parent/kid on a device never does, so a kid added
      // to a parent's kids[] by any other path (or whose parent hasn't synced since, e.g. they
      // uploaded a new photo while this kid's own entry already existed) can be stuck without
      // their own parent as a contact, or stuck showing a stale/missing photo, indefinitely.
      // Checked on every focus-triggered sync here instead, so it corrects itself the next time
      // the kid's own device looks, regardless of what the parent's device has or hasn't done.
      const ownerCode = owningRow.cookie_code;
      const existingFriends: any[] = targetKid.friends || [];
      const existingOwnerEntry = existingFriends.find((f: any) => f.cookieCode === ownerCode);
      const ownerName = owningPayload.parentName || ownerCode.replace('PARENT:', '');
      const ownerAvatarEmoji = owningPayload.parentAvatarEmoji || '👪';
      const isStale = existingOwnerEntry
        && (existingOwnerEntry.name !== ownerName
          || existingOwnerEntry.avatarUrl !== (owningPayload.parentAvatarUrl || undefined)
          || existingOwnerEntry.avatarEmoji !== ownerAvatarEmoji);
      if (!existingOwnerEntry || isStale) {
        const updatedFriends = !existingOwnerEntry
          ? [...existingFriends, {
              id: Crypto.randomUUID(),
              name: ownerName,
              cookieCode: ownerCode,
              avatarEmoji: ownerAvatarEmoji,
              avatarUrl: owningPayload.parentAvatarUrl || undefined,
            }]
          : existingFriends.map((f: any) =>
              f.cookieCode === ownerCode ? { ...f, name: ownerName, avatarEmoji: ownerAvatarEmoji, avatarUrl: owningPayload.parentAvatarUrl || undefined } : f
            );
        const kidIndex = owningPayload.kids.findIndex((k: any) => k.cookieCode === active.cookieCode);
        owningPayload.kids[kidIndex] = { ...owningPayload.kids[kidIndex], friends: updatedFriends };
        const { error: upsertError } = await supabase
          .from('profiles')
          .upsert({ cookie_code: owningRow.cookie_code, push_token: JSON.stringify(owningPayload), name: owningRow.name });
        if (!upsertError) {
          targetKid = owningPayload.kids[kidIndex];
        }
      }

      const updatedProfile: KidProfile = {
        name: targetKid.name,
        cookieCode: targetKid.cookieCode,
        avatarEmoji: targetKid.avatarEmoji,
        chatDisabled: !!targetKid.chatDisabled,
        callingDisabled: !!targetKid.callingDisabled,
        videoCallingDisabled: !!targetKid.videoCallingDisabled,
        photosDisabled: !!targetKid.photosDisabled,
        drawingDisabled: !!targetKid.drawingDisabled,
        voiceMessagesDisabled: !!targetKid.voiceMessagesDisabled
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
    // A PARENT:-prefixed code here is an adult relative (see addRelativeToKidByEmail), not
    // another kid buddy — a random food/animal emoji doesn't fit a grown-up. Plain "silhouette"
    // default until/unless that relative picks one of their own adult avatar presets, which then
    // reaches this entry the same self-healing way a kid's OWN parent's avatar does.
    const isAdult = friendCookieCode.startsWith('PARENT:');
    const newFriend: Friend = {
      id: Crypto.randomUUID(),
      name: friendName,
      cookieCode: friendCookieCode,
      avatarEmoji: isAdult ? '👤' : randomAvatarEmoji()
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
    // A relative adult (see addRelativeToKidByEmail) is addressed by their own PARENT:<email>
    // code, not a CRUM code nested inside some other parent's kids[] — the lookup below would
    // never find them there and would wrongly report "pending" forever. That relationship has no
    // pending/request-response step to begin with (same as pairParentsViaQRCode), so it's always
    // paired once it exists as a friend entry at all.
    if (friendCookieCode.startsWith('PARENT:')) {
      return { status: 'paired' };
    }

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

  /**
   * Parent-to-parent counterpart to pairKidsViaQRCode, simpler because a parent's PARENT:<email>
   * code IS their profiles row's own key — no .like() scan into a nested kids[] array needed,
   * just a direct fetch of both rows. Writes both sides' top-level `friends` field (sibling to
   * `kids`, not nested inside any one kid) in one call, always mutually — there's no one-sided
   * "pending" state to track the way the kid's manual add-by-code path has.
   */
  async pairParentsViaQRCode(myEmail: string, myName: string, friendParentCode: string, friendName: string): Promise<boolean> {
    try {
      const myCode = `PARENT:${myEmail}`;
      if (friendParentCode === myCode) return false;

      const { data: myRow, error: myError } = await supabase
        .from('profiles')
        .select('*')
        .eq('cookie_code', myCode)
        .single();
      const { data: friendRow, error: friendError } = await supabase
        .from('profiles')
        .select('*')
        .eq('cookie_code', friendParentCode)
        .single();

      if (myError || !myRow || friendError || !friendRow) {
        console.error("Could not find one or both parent profiles for pairing");
        return false;
      }

      const myPayload = JSON.parse(myRow.push_token);
      const friendPayload = JSON.parse(friendRow.push_token);

      if (!(myPayload.friends || []).some((f: any) => f.cookieCode === friendParentCode)) {
        myPayload.friends = [...(myPayload.friends || []), {
          id: Crypto.randomUUID(),
          name: friendName,
          cookieCode: friendParentCode,
          avatarEmoji: friendPayload.parentAvatarEmoji || '👤',
          avatarUrl: friendPayload.parentAvatarUrl || undefined
        }];
      }
      if (!(friendPayload.friends || []).some((f: any) => f.cookieCode === myCode)) {
        friendPayload.friends = [...(friendPayload.friends || []), {
          id: Crypto.randomUUID(),
          name: myName,
          cookieCode: myCode,
          avatarEmoji: myPayload.parentAvatarEmoji || '👤',
          avatarUrl: myPayload.parentAvatarUrl || undefined
        }];
      }

      const { error: myUpsertError } = await supabase
        .from('profiles')
        .upsert({ cookie_code: myRow.cookie_code, push_token: JSON.stringify(myPayload), name: myRow.name });
      if (myUpsertError) {
        console.error("Failed to update my own parent profile:", myUpsertError);
        return false;
      }

      const { error: friendUpsertError } = await supabase
        .from('profiles')
        .upsert({ cookie_code: friendRow.cookie_code, push_token: JSON.stringify(friendPayload), name: friendRow.name });
      if (friendUpsertError) {
        console.error("Failed to update the other parent's profile:", friendUpsertError);
        return false;
      }

      return true;
    } catch (e) {
      console.error("Error in parent QR pairing:", e);
      return false;
    }
  },

  /**
   * Connects a kid directly with a relative adult (grandparent, aunt/uncle, a second parent who
   * doesn't manage this kid's account, etc.) by email — someone who isn't one of this kid's OWN
   * registered parents, but should still be able to chat with them directly. Reuses the exact
   * same mechanism as pairParentsViaQRCode: the relative's `PARENT:<email>` code goes straight
   * into the kid's own `friends[]` (the same field used for cross-family kid buddies — the kid's
   * existing chat screens address any friend by raw cookieCode already, so this needs no changes
   * there beyond treating a `PARENT:`-prefixed friend as always paired, no request/response step).
   *
   * If the relative already has an account, both sides are linked immediately, mirroring
   * pairParentsViaQRCode's always-symmetric write. If not, sends them a real invite email (via
   * the invite-relative Edge Function, which needs the service-role key) and reflects the
   * relationship on the kid's side right away regardless — the relative's own side completes
   * later, via completePendingRelativeLinks, once they actually finish signing up.
   */
  async addRelativeToKidByEmail(
    kidCookieCode: string,
    kidName: string,
    kidAvatarEmoji: string | undefined,
    relativeEmail: string,
    relativeDisplayName: string
  ): Promise<'linked' | 'invited' | 'error'> {
    try {
      const relativeCode = `PARENT:${relativeEmail}`;

      const { data: relativeRow } = await supabase
        .from('profiles')
        .select('*')
        .eq('cookie_code', relativeCode)
        .single();

      if (relativeRow && relativeRow.push_token) {
        const relativePayload = JSON.parse(relativeRow.push_token);
        if (!(relativePayload.friends || []).some((f: any) => f.cookieCode === kidCookieCode)) {
          relativePayload.friends = [...(relativePayload.friends || []), {
            id: Crypto.randomUUID(),
            name: kidName,
            cookieCode: kidCookieCode,
            avatarEmoji: kidAvatarEmoji
          }];
          const { error: upsertError } = await supabase
            .from('profiles')
            .upsert({ cookie_code: relativeRow.cookie_code, push_token: JSON.stringify(relativePayload), name: relativeRow.name });
          if (upsertError) {
            console.error("Failed to update relative's profile:", upsertError);
            return 'error';
          }
        }

        await this.addFriendToKidProfile(kidCookieCode, relativeDisplayName, relativeCode);
        await this.syncParentData();
        return 'linked';
      }

      const { error: inviteError } = await supabase.functions.invoke('invite-relative', {
        body: { email: relativeEmail, kidCookieCode, kidName, kidAvatarEmoji, relativeDisplayName },
      });
      if (inviteError) {
        console.error("Error inviting relative:", inviteError);
        return 'error';
      }

      await this.addFriendToKidProfile(kidCookieCode, relativeDisplayName, relativeCode);
      await this.syncParentData();
      return 'invited';
    } catch (e) {
      console.error("Error adding relative to kid:", e);
      return 'error';
    }
  },

  /**
   * Completes the OTHER side of addRelativeToKidByEmail's invited-relative case — called from
   * gate.tsx right after a successful sign-in, whenever that account's own user_metadata still
   * carries pendingRelativeLinks (set by the invite-relative Edge Function). Idempotent: only
   * appends links not already present, so it's safe to call on every sign-in.
   */
  async completePendingRelativeLinks(
    myEmail: string,
    pendingLinks: { cookieCode: string; name: string; avatarEmoji?: string }[]
  ): Promise<void> {
    try {
      const myCode = `PARENT:${myEmail}`;
      const { data: myRow } = await supabase
        .from('profiles')
        .select('*')
        .eq('cookie_code', myCode)
        .single();
      if (!myRow) return;

      const payload = JSON.parse(myRow.push_token || '{}');
      const existingFriends = payload.friends || [];
      let changed = false;
      for (const link of pendingLinks) {
        if (!existingFriends.some((f: any) => f.cookieCode === link.cookieCode)) {
          existingFriends.push({ id: Crypto.randomUUID(), name: link.name, cookieCode: link.cookieCode, avatarEmoji: link.avatarEmoji });
          changed = true;
        }
      }
      if (changed) {
        payload.friends = existingFriends;
        await supabase
          .from('profiles')
          .upsert({ cookie_code: myRow.cookie_code, push_token: JSON.stringify(payload), name: myRow.name });
      }
    } catch (e) {
      console.error("Error completing pending relative links:", e);
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
