import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const formatDuration = (totalSeconds: number) => {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const mins = Math.floor(safeSeconds / 60);
  const secs = Math.floor(safeSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

interface VoiceMessageBubbleProps {
  uri: string;
  // Duration recorded at send time — shown immediately, before the player itself has loaded and
  // can report its own (more authoritative) duration.
  durationSeconds: number;
  isMe: boolean;
}

// Playback bubble for a voice message (see VoiceRecorderModal for how one gets sent) — a
// play/pause button, a thin progress track, and a duration readout. Used anywhere a
// parseMediaMessage result comes back as kind: 'voice': chat/[friendId].tsx, parent/chat/[code].tsx,
// and dashboard.tsx's chat-log viewer.
export default function VoiceMessageBubble({ uri, durationSeconds, isMe }: VoiceMessageBubbleProps) {
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);

  const totalSeconds = status.duration || durationSeconds;
  const progress = totalSeconds > 0 ? Math.min(status.currentTime / totalSeconds, 1) : 0;

  const togglePlayback = () => {
    if (status.playing) {
      player.pause();
    } else {
      // Replay from the start once it's finished, rather than a no-op tap on a "done" bubble.
      if (status.didJustFinish || (totalSeconds > 0 && status.currentTime >= totalSeconds)) {
        player.seekTo(0);
      }
      player.play();
    }
  };

  const iconColor = isMe ? colors.primaryBtnText : colors.text;
  const trackColor = isMe
    ? (isDark ? 'rgba(26,18,11,0.35)' : 'rgba(78,52,46,0.2)')
    : (isDark ? 'rgba(255,253,243,0.2)' : 'rgba(78,52,46,0.15)');

  return (
    <View style={[styles.container, { gap: s(10), paddingVertical: s(4), width: s(200) }]}>
      <TouchableOpacity
        onPress={togglePlayback}
        style={[styles.playButton, { width: s(36), height: s(36), borderRadius: s(18), backgroundColor: isMe ? (isDark ? 'rgba(26,18,11,0.25)' : 'rgba(78,52,46,0.12)') : (isDark ? 'rgba(255,253,243,0.15)' : 'rgba(78,52,46,0.08)') }]}
      >
        <Ionicons name={status.playing ? 'pause' : 'play'} size={s(18)} color={iconColor} />
      </TouchableOpacity>
      <View style={{ flex: 1, gap: s(6) }}>
        <View style={[styles.track, { height: s(4), borderRadius: s(2), backgroundColor: trackColor }]}>
          <View style={[styles.trackFill, { width: `${progress * 100}%`, borderRadius: s(2), backgroundColor: iconColor }]} />
        </View>
        <Text style={{ fontSize: s(11), color: iconColor, fontWeight: '600' }}>
          {formatDuration(status.playing || status.currentTime > 0 ? status.currentTime : totalSeconds)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  playButton: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  track: {
    width: '100%',
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
  },
});
