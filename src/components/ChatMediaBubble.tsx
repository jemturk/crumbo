import { StorageService, type Message } from '@/services/storage';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

export type ParsedMediaMessage =
  | { kind: 'photo' | 'drawing'; url: string }
  | { kind: 'voice'; url: string; durationSeconds: number };

// Both chat/[friendId].tsx (kid-to-kid/parent) and parent/chat/[code].tsx (parent-to-parent/kid)
// encode a sent photo/drawing as `[IMAGE:<url>]`/`[DRAWING:<url>]`, and a voice message as
// `[VOICE:<durationSeconds>|<url>]` (see StorageService.sendMediaMessage/sendVoiceMessage) —
// this is the one place that knows those conventions, so a screen doesn't have to duplicate the
// prefix-stripping to render one. Despite the field name, `url` is a kid_media storage PATH for
// anything sent after the bucket went private (see StorageService.getMediaUrl) — a legacy full
// public URL only for messages sent before that. Both are resolved to an actual displayable URI
// by ChatMediaBubble/VoiceMessageBubble, not used directly.
export function parseMediaMessage(text: string): ParsedMediaMessage | null {
  if (text.startsWith('[IMAGE:')) {
    return { kind: 'photo', url: text.replace('[IMAGE:', '').replace(/\]$/, '') };
  }
  if (text.startsWith('[DRAWING:')) {
    return { kind: 'drawing', url: text.replace('[DRAWING:', '').replace(/\]$/, '') };
  }
  if (text.startsWith('[VOICE:')) {
    const body = text.replace('[VOICE:', '').replace(/\]$/, '');
    const separatorIndex = body.indexOf('|');
    if (separatorIndex === -1) return null;
    const durationSeconds = parseInt(body.slice(0, separatorIndex), 10);
    const url = body.slice(separatorIndex + 1);
    if (!url || isNaN(durationSeconds)) return null;
    return { kind: 'voice', url, durationSeconds };
  }
  return null;
}

// Shared by both the kid Cookie Jar list and the parent Chats list to render a contact row's
// last-message preview identically — call-log/media-aware, with a "You: " prefix on own sends.
export function formatMessagePreview(message: Message | null | undefined): string {
  if (!message) return 'Tap to start chatting! 🍪';

  if (message.text.startsWith('[CALL_LOG:')) {
    // Newer rows carry a :INCOMING/:OUTGOING direction suffix — strip it for the preview.
    const logType = message.text.replace('[CALL_LOG:', '').replace(']', '').split(':')[0];
    switch (logType) {
      case 'MISSED_VIDEO':
        return '📹 Missed Video Call';
      case 'MISSED_AUDIO':
        return '📞 Missed Voice Call';
      case 'ENDED_VIDEO':
        return '📹 Video Call Ended';
      case 'ENDED_AUDIO':
      default:
        return '📞 Voice Call Ended';
    }
  }

  const prefix = message.sender === 'me' ? 'You: ' : '';
  const media = parseMediaMessage(message.text);
  if (media) {
    const label = media.kind === 'photo' ? '📷 Photo' : media.kind === 'drawing' ? '🎨 Drawing' : '🎤 Voice Message';
    return `${prefix}${label}`;
  }

  return `${prefix}${message.text}`;
}

// `uri` here is what parseMediaMessage returned — a kid_media storage path (or legacy public
// URL) — not yet a fetchable link, since the bucket is private. Resolved to a short-lived signed
// URL on mount/change via StorageService.getMediaUrl before anything is rendered.
export default function ChatMediaBubble({ uri, size, borderRadius, borderWidth, borderColor }: { uri: string; size: number; borderRadius: number; borderWidth?: number; borderColor?: string }) {
  // Keyed by the uri it was resolved for, so a stale in-flight resolve from a previous `uri`
  // can't ever be mistaken for the current one — avoids resetting state synchronously inside the
  // effect (which itself causes an extra render pass) just to represent "not resolved yet".
  const [resolved, setResolved] = useState<{ forUri: string; url: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    StorageService.getMediaUrl(uri).then(url => {
      if (!cancelled) setResolved({ forUri: uri, url });
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const resolvedUri = resolved?.forUri === uri ? resolved.url : null;

  const borderStyle = borderWidth ? { borderWidth, borderColor } : undefined;

  if (!resolvedUri) {
    return (
      <View style={[styles.bubble, styles.loading, { width: size, height: size, borderRadius }, borderStyle]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <Image
      source={{ uri: resolvedUri }}
      style={[styles.bubble, { width: size, height: size, borderRadius }, borderStyle]}
      contentFit="cover"
      transition={150}
    />
  );
}

const styles = StyleSheet.create({
  bubble: {
    overflow: 'hidden',
  },
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
});
