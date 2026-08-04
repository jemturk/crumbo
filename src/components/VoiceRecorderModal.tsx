import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Ionicons } from '@expo/vector-icons';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface VoiceRecorderModalProps {
  visible: boolean;
  onClose: () => void;
  onSend: (localUri: string, durationSeconds: number) => void;
  onError: (message: string) => void;
}

const MAX_DURATION_SECONDS = 180;

const formatDuration = (totalSeconds: number) => {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const mins = Math.floor(safeSeconds / 60);
  const secs = Math.floor(safeSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

type Phase = 'idle' | 'recording' | 'recorded';

// Record → preview → send flow for a voice message, capped at MAX_DURATION_SECONDS (matches
// StorageService.sendVoiceMessage's expectations, and the recorder itself is told to auto-stop
// at that same cap via record({ forDuration })). Opened from a mic button in chat/[friendId].tsx's
// attachment menu; the parent screen owns actually uploading/sending via onSend.
export default function VoiceRecorderModal({ visible, onClose, onSend, onError }: VoiceRecorderModalProps) {
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();

  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, extension: '.m4a' });
  const recorderState = useAudioRecorderState(recorder, 100);

  const [phase, setPhase] = useState<Phase>('idle');
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  const [recordedDuration, setRecordedDuration] = useState(0);
  const wasRecordingRef = useRef(false);

  const player = useAudioPlayer(recordedUri);
  const playerStatus = useAudioPlayerStatus(player);

  // Catches BOTH a manual stop() and the native forDuration auto-stop at the 3-minute cap —
  // either way isRecording flips to false on its own, and this is what actually transitions the
  // UI rather than only the explicit "stop" button press.
  useEffect(() => {
    if (wasRecordingRef.current && !recorderState.isRecording && phase === 'recording') {
      const uri = recorder.uri;
      if (uri) {
        setRecordedUri(uri);
        setRecordedDuration(recorderState.durationMillis / 1000);
        setPhase('recorded');
      } else {
        setPhase('idle');
      }
    }
    wasRecordingRef.current = recorderState.isRecording;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorderState.isRecording]);

  const reset = () => {
    setPhase('idle');
    setRecordedUri(null);
    setRecordedDuration(0);
  };

  const handleClose = () => {
    if (recorderState.isRecording) {
      recorder.stop().catch(() => {});
    }
    if (playerStatus.playing) {
      player.pause();
    }
    reset();
    onClose();
  };

  const handleStartRecording = async () => {
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        onError('Microphone permission is required to record a voice message.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: MAX_DURATION_SECONDS });
      setPhase('recording');
    } catch (e) {
      console.error('Error starting voice recording', e);
      onError("Couldn't start recording — please try again.");
    }
  };

  const handleStopRecording = async () => {
    try {
      await recorder.stop();
      // The isRecording-watching effect above picks up the resulting uri/duration and moves
      // phase to 'recorded' — nothing else to do here.
    } catch (e) {
      console.error('Error stopping voice recording', e);
      onError("Couldn't finish recording — please try again.");
      reset();
    }
  };

  const handleReRecord = () => {
    if (playerStatus.playing) {
      player.pause();
    }
    reset();
  };

  const togglePreviewPlayback = () => {
    if (playerStatus.playing) {
      player.pause();
    } else {
      if (playerStatus.didJustFinish) {
        player.seekTo(0);
      }
      player.play();
    }
  };

  const handleSend = () => {
    if (!recordedUri) return;
    const uri = recordedUri;
    const duration = recordedDuration;
    reset();
    onSend(uri, duration);
  };

  const liveSeconds = recorderState.durationMillis / 1000;

  return (
    <Modal animationType="slide" visible={visible} onRequestClose={handleClose} transparent>
      <View style={[styles.overlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(78, 52, 46, 0.4)' }]}>
        <SafeAreaView style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.borderStrong }]}>
          <View style={styles.header}>
            <TouchableOpacity onPress={handleClose} style={styles.headerBtn}>
              <Text style={[styles.headerBtnText, { color: colors.textSecondary, fontSize: s(15) }]}>Cancel</Text>
            </TouchableOpacity>
            <Text style={[styles.title, { color: colors.text, fontSize: s(17) }]}>Voice Message</Text>
            <TouchableOpacity onPress={handleSend} style={styles.headerBtn} disabled={phase !== 'recorded'}>
              <Text style={[styles.headerBtnText, { color: phase !== 'recorded' ? colors.textSecondary : colors.primaryBtn, fontSize: s(15), fontWeight: '800' }]}>
                Send
              </Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.content, { paddingVertical: s(32) }]}>
            {phase === 'idle' && (
              <>
                <TouchableOpacity
                  onPress={handleStartRecording}
                  style={[styles.micButton, { width: s(88), height: s(88), borderRadius: s(44), backgroundColor: colors.primaryBtn }]}
                >
                  <Ionicons name="mic" size={s(36)} color={colors.primaryBtnText} />
                </TouchableOpacity>
                <Text style={[styles.hint, { color: colors.textSecondary, fontSize: s(14), marginTop: s(16) }]}>
                  Tap to start recording (up to 3 minutes)
                </Text>
              </>
            )}

            {phase === 'recording' && (
              <>
                <View style={[styles.recordingDot, { width: s(12), height: s(12), borderRadius: s(6), marginBottom: s(12) }]} />
                <Text style={[styles.timer, { color: colors.text, fontSize: s(32) }]}>
                  {formatDuration(liveSeconds)}
                  <Text style={{ fontSize: s(16), color: colors.textSecondary }}> / {formatDuration(MAX_DURATION_SECONDS)}</Text>
                </Text>
                <TouchableOpacity
                  onPress={handleStopRecording}
                  style={[styles.micButton, { width: s(88), height: s(88), borderRadius: s(44), backgroundColor: colors.dangerText, marginTop: s(24) }]}
                >
                  <Ionicons name="stop" size={s(32)} color="#FFFFFF" />
                </TouchableOpacity>
              </>
            )}

            {phase === 'recorded' && (
              <>
                <TouchableOpacity
                  onPress={togglePreviewPlayback}
                  style={[styles.micButton, { width: s(72), height: s(72), borderRadius: s(36), backgroundColor: colors.primaryBtn }]}
                >
                  <Ionicons name={playerStatus.playing ? 'pause' : 'play'} size={s(30)} color={colors.primaryBtnText} />
                </TouchableOpacity>
                <Text style={[styles.timer, { color: colors.text, fontSize: s(20), marginTop: s(16) }]}>
                  {formatDuration(playerStatus.playing || playerStatus.currentTime > 0 ? playerStatus.currentTime : recordedDuration)}
                </Text>
                <TouchableOpacity onPress={handleReRecord} style={{ marginTop: s(16) }}>
                  <Text style={[styles.hint, { color: colors.textSecondary, fontSize: s(14), textDecorationLine: 'underline' }]}>Re-record</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  card: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 2,
    borderBottomWidth: 0,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerBtn: {
    padding: 4,
  },
  headerBtnText: {
    fontWeight: '700',
  },
  title: {
    fontWeight: '800',
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  micButton: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  hint: {
    fontWeight: '600',
    textAlign: 'center',
  },
  recordingDot: {
    backgroundColor: '#D32F2F',
  },
  timer: {
    fontWeight: '900',
  },
});
