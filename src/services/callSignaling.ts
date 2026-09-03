import { StorageService } from './storage';
import { supabase } from './supabase';

/**
 * Call signaling transport.
 *
 * Call control events travel on their own `call_signals` table (delivered per-receiver
 * over Supabase Realtime) instead of being smuggled through the chat `messages` table.
 * A killed/backgrounded receiver is additionally woken by the `notify-call` edge
 * function, which sends a high-priority Expo push that the CallKeep background task
 * (src/services/callkeep.ts) turns into a native incoming-call screen.
 *
 * Only [CALL_LOG:*] history rows still live in `messages` — those are real chat history.
 */

export type CallSignalType =
  | 'START_AUDIO_CALL'
  | 'START_VIDEO_CALL'
  | 'ACCEPT_CALL'
  | 'DECLINE_CALL'
  | 'END_CALL'
  | 'CANCEL_CALL';

export interface CallSignalPayload {
  type: CallSignalType;
  callUUID?: string;
  roomName?: string;
  callerName?: string;
  friendId?: string;
  friendName?: string;
  isVideo?: boolean;
  /** The sender's cookie code, used to resolve friendId locally when the signal didn't carry one. */
  senderCode?: string;
}

/** Full signal as sent over the wire (caller-side). */
export interface OutgoingCallSignal {
  type: CallSignalType;
  callUUID: string;
  senderCode: string;
  senderName?: string;
  receiverCode: string;
  roomName?: string;
  isVideo?: boolean;
}

export const isStartSignal = (type: CallSignalType) =>
  type === 'START_AUDIO_CALL' || type === 'START_VIDEO_CALL';

/**
 * Parse a call signal out of an arbitrary value (used to read push-notification `data`
 * payloads in callkeep.ts). Kept tolerant of both stringified JSON and plain objects.
 */
export const parseCallSignalText = (value: unknown): CallSignalPayload | null => {
  if (!value) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseCallSignalText(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return null;
  }

  if (typeof value === 'object') {
    const data = value as Record<string, any>;
    const type =
      typeof data.type === 'string'
        ? (data.type as CallSignalType)
        : typeof data.callSignal === 'string'
        ? (data.callSignal as CallSignalType)
        : undefined;

    if (type) {
      return {
        type,
        callUUID: typeof data.callUUID === 'string' ? data.callUUID : undefined,
        roomName: typeof data.roomName === 'string' ? data.roomName : undefined,
        callerName: typeof data.callerName === 'string' ? data.callerName : undefined,
        friendId: typeof data.friendId === 'string' ? data.friendId : undefined,
        friendName: typeof data.friendName === 'string' ? data.friendName : undefined,
        isVideo:
          typeof data.isVideo === 'boolean' ? data.isVideo : type === 'START_VIDEO_CALL',
        senderCode:
          typeof data.sender_code === 'string'
            ? data.sender_code
            : typeof data.senderCode === 'string'
            ? data.senderCode
            : undefined,
      };
    }

    if ('text' in data && typeof data.text === 'string') {
      return parseCallSignalText(data.text);
    }
  }

  return null;
};

/**
 * Send a call signal: write it to `call_signals` (Realtime delivers to a live receiver)
 * and, for everything except ACCEPT, invoke `notify-call` so a killed/backgrounded
 * receiver is woken (START) or has its ringing UI torn down (CANCEL/END/DECLINE).
 */
export async function sendCallSignal(signal: OutgoingCallSignal): Promise<void> {
  const { type, callUUID, senderCode, senderName, receiverCode, roomName, isVideo } = signal;

  try {
    const { error } = await supabase.from('call_signals').insert({
      call_uuid: callUUID,
      type,
      sender_code: senderCode,
      sender_name: senderName ?? null,
      receiver_code: receiverCode,
      room_name: roomName ?? null,
      is_video: !!isVideo,
    });
    if (error) {
      console.error('[CallSignaling] Failed to insert call signal:', error);
    }
  } catch (e) {
    console.error('[CallSignaling] Error writing call signal:', e);
  }

  // ACCEPT only matters to an already-connected peer, so it never needs a push.
  if (type === 'ACCEPT_CALL') return;

  try {
    const { data, error } = await supabase.functions.invoke('notify-call', {
      body: { receiverCode, senderCode, callUUID, type, senderName, roomName, isVideo: !!isVideo },
    });
    // A soft "not delivered" (no token registered, rejected ticket, etc.) comes back as a normal
    // 200 response, not a thrown error — previously discarded entirely, which meant a receiver
    // whose push silently never arrives looked identical in the caller's own logs to one that
    // rang fine. Only worth surfacing for START — CANCEL/END/DECLINE reaching a foregrounded
    // peer via Realtime instead is the normal, non-broken case.
    if (!error && data && data.delivered === false && (type === 'START_AUDIO_CALL' || type === 'START_VIDEO_CALL')) {
      console.warn(`[CallSignaling] notify-call did not deliver for ${type} → ${receiverCode} (callUUID=${callUUID}):`, data.reason ?? data.expo);
    }
  } catch (e) {
    // A failed push is non-fatal — a foregrounded peer still gets the Realtime event.
    console.warn('[CallSignaling] notify-call push failed (non-fatal):', e);
  }
}

/**
 * Subscribe to call signals addressed to `myCookieCode`. The handler receives the parsed
 * signal plus the local `friendId` of the other party (resolved from sender_code), or
 * null if the sender is not a known friend on this device.
 */
export function subscribeToCallSignals(
  myCookieCode: string,
  onSignal: (payload: CallSignalPayload & { senderCode: string }, friendId: string | null) => void
): () => void {
  // Multiple call sites (the global _layout.tsx listener AND each chat screen's useCall
  // hook) subscribe with the same cookieCode concurrently. Supabase reuses a channel
  // object for a repeated topic name, so a shared/deterministic name here would make the
  // second subscriber's .on() throw ("cannot add postgres_changes callbacks ... after
  // subscribe()") once the first has already called .subscribe(). Suffix a random id so
  // every call gets its own independent channel, matching StorageService.subscribeToMessages.
  const channelId = Math.random().toString(36).substring(2, 9);
  const channel = supabase
    .channel(`call_signals:${myCookieCode}:${channelId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'call_signals',
        filter: `receiver_code=eq.${myCookieCode}`,
      },
      async (event) => {
        const row = event.new as Record<string, any>;
        const senderCode: string = row.sender_code;

        const friends = await StorageService.getFriends();
        const friend = friends.find((f) => f.cookieCode === senderCode) || null;

        onSignal(
          {
            type: row.type as CallSignalType,
            callUUID: row.call_uuid,
            roomName: row.room_name || undefined,
            callerName: row.sender_name || undefined,
            friendName: row.sender_name || undefined,
            isVideo: !!row.is_video,
            senderCode,
          },
          friend ? friend.id : null
        );
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Parent-side counterpart to subscribeToCallSignals — a parent's contacts (their own kids,
 * paired parents, relatives) are never cached in the kid-oriented getFriends() list that
 * function resolves against, so its friendId would always come back null for a parent receiver
 * and the call would be silently dropped. A parent's conversations are already addressed
 * directly by raw cookie code everywhere else (see parent/chat/[code].tsx) — same here: the
 * "otherCode" handed to onSignal is just the sender's cookie code as-is, no lookup needed.
 */
export function subscribeToParentCallSignals(
  myCookieCode: string,
  onSignal: (payload: CallSignalPayload & { senderCode: string }, otherCode: string) => void
): () => void {
  const channelId = Math.random().toString(36).substring(2, 9);
  const channel = supabase
    .channel(`call_signals:${myCookieCode}:${channelId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'call_signals',
        filter: `receiver_code=eq.${myCookieCode}`,
      },
      (event) => {
        const row = event.new as Record<string, any>;
        const senderCode: string = row.sender_code;

        onSignal(
          {
            type: row.type as CallSignalType,
            callUUID: row.call_uuid,
            roomName: row.room_name || undefined,
            callerName: row.sender_name || undefined,
            friendName: row.sender_name || undefined,
            isVideo: !!row.is_video,
            senderCode,
          },
          senderCode
        );
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
