import { CallDirection, CallStatus } from '@/hooks/use-call';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect, useRef } from 'react';
import { Animated, Modal, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RtcSurfaceView } from 'react-native-agora';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface CallModalProps {
  visible: boolean;
  callTypeVideo: boolean;
  callStatus: CallStatus;
  callDuration: number;
  callDirection: CallDirection;
  remoteUid: number | null;
  isMuted: boolean;
  isVideoMuted: boolean;
  friendName: string;
  friendAvatarEmoji?: string;
  friendAvatarUrl?: string;
  onAccept: () => void;
  onDecline: () => void;
  onEnd: () => void;
  onToggleMute: () => void;
  onSwitchCamera: () => void;
  onToggleSpeaker: () => void;
  formatDuration: (seconds: number) => string;
}

// The full-screen calling UI (ringing/connected, audio or video, Agora surfaces + controls) —
// originally lived inline in chat/[friendId].tsx; extracted so parent/chat/[code].tsx can render
// the exact same thing off its own useCall() instance without duplicating ~250 lines of JSX.
// Deliberately not theme-aware (always the same light call-screen look, independent of the app's
// own dark mode) — matches the original's behavior.
export default function CallModal({
  visible,
  callTypeVideo,
  callStatus,
  callDuration,
  callDirection,
  remoteUid,
  isMuted,
  isVideoMuted,
  friendName,
  friendAvatarEmoji,
  friendAvatarUrl,
  onAccept,
  onDecline,
  onEnd,
  onToggleMute,
  onSwitchCamera,
  onToggleSpeaker,
  formatDuration,
}: CallModalProps) {
  const { s } = useDisplayScale();
  const insets = useSafeAreaInsets();

  // Draggable local video thumbnail, during an active video call.
  const pan = useRef(new Animated.ValueXY()).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => pan.extractOffset(),
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: () => pan.flattenOffset(),
    })
  ).current;

  useEffect(() => {
    if (!visible) {
      pan.setValue({ x: 0, y: 0 });
      pan.setOffset({ x: 0, y: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const videoConnected = callTypeVideo && callStatus === 'connected' && remoteUid !== null;

  return (
    <Modal animationType="fade" transparent={false} visible={visible} onRequestClose={onEnd}>
      <View style={[styles.callModalContainer, callTypeVideo ? styles.callVideoBg : styles.callAudioBg]}>
        {/* Video Views if connected/video call */}
        {callTypeVideo && callStatus === 'connected' && (
          <View style={StyleSheet.absoluteFill}>
            {remoteUid !== null ? (
              <>
                <RtcSurfaceView style={styles.remoteVideo} canvas={{ uid: remoteUid }} />

                <Animated.View
                  {...panResponder.panHandlers}
                  style={[
                    styles.localVideo,
                    {
                      transform: pan.getTranslateTransform(),
                      top: insets.top > 0 ? insets.top + s(10) : s(20),
                    },
                  ]}
                >
                  <RtcSurfaceView style={styles.localVideoSurface} canvas={{ uid: 0 }} zOrderMediaOverlay={true} />
                </Animated.View>
              </>
            ) : (
              <RtcSurfaceView style={styles.localVideoFullScreen} canvas={{ uid: 0 }} />
            )}
          </View>
        )}

        {/* Header Call Info */}
        <View style={[
          styles.callHeaderContainer,
          { paddingTop: insets.top > 0 ? insets.top + s(10) : s(30) },
          videoConnected && styles.callHeaderVideoConnected
        ]}>
          <Text style={[
            styles.callLabel,
            { fontSize: s(11) },
            videoConnected ? styles.textShadowLightBlue : styles.callLabelText
          ]}>
            {callTypeVideo ? '📹 VIDEO CALL' : '📞 CRUMBO VOICE CALL'}
          </Text>

          <Text style={[
            styles.callFriendName,
            { fontSize: s(28) },
            videoConnected ? [styles.callFriendNameVideo, styles.textShadow] : styles.callFriendNameAudio
          ]}>
            {friendName}
          </Text>

          <Text style={[
            styles.callStatusText,
            { fontSize: s(15) },
            videoConnected ? [styles.callStatusTextVideo, styles.textShadow] : styles.callStatusTextAudio
          ]}>
            {callStatus === 'ringing' && (callDirection === 'incoming' ? 'Incoming Call...' : 'Ringing...')}
            {callStatus === 'connected' && (remoteUid === null && callTypeVideo ? 'Connecting video...' : `Connected • ${formatDuration(callDuration)}`)}
            {callStatus === 'ended' && 'Call Ended'}
          </Text>
        </View>

        {/* Middle Section (for Avatar when not in active video) */}
        {(!callTypeVideo || callStatus !== 'connected' || remoteUid === null) && (
          <View style={styles.callMiddleContainer}>
            <View style={[
              styles.avatarContainerLarge,
              { width: s(130), height: s(130), borderRadius: s(65) }
            ]}>
              {friendAvatarUrl ? (
                <Image source={{ uri: friendAvatarUrl }} style={{ width: '100%', height: '100%', borderRadius: s(65) }} contentFit="cover" />
              ) : (
                <Text style={[styles.avatarEmojiLarge, { fontSize: s(64) }]}>{friendAvatarEmoji || '🍪'}</Text>
              )}
            </View>
          </View>
        )}

        {/* Empty spacer to push controls to bottom when active video is showing */}
        {videoConnected && <View style={{ flex: 1 }} />}

        {/* Controls — hidden once the call has ended so the modal's closing animation isn't
            covering a still-live "end call" button (see teardown's re-entry guard in
            use-call.ts for why a stray extra tap here used to resend a signal and rewrite the
            call log every time). */}
        {callStatus !== 'ended' && (callStatus === 'ringing' && callDirection === 'incoming' ? (
          <View style={[
            styles.controlsContainer,
            callTypeVideo ? styles.controlsContainerVideo : styles.controlsContainerAudio,
            { paddingBottom: insets.bottom > 0 ? insets.bottom + s(20) : s(30) }
          ]}>
            <View style={styles.callControlsRowIncoming}>
              <TouchableOpacity style={[styles.callControlBtn, styles.declineBtn, { width: s(64), height: s(64), borderRadius: s(32) }]} onPress={onDecline}>
                <Ionicons name="close" size={s(32)} color="#FFFFFF" />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.callControlBtn, styles.acceptBtn, { width: s(64), height: s(64), borderRadius: s(32) }]} onPress={onAccept}>
                <Ionicons name="checkmark" size={s(32)} color="#FFFFFF" />
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={[
            styles.controlsContainer,
            videoConnected ? styles.controlsContainerVideo : styles.controlsContainerAudio,
            { paddingBottom: insets.bottom > 0 ? insets.bottom + s(20) : s(30) }
          ]}>
            <View style={styles.callControlsRow}>
              <TouchableOpacity
                style={[
                  styles.callMuteBtn,
                  isMuted && (videoConnected ? styles.activeMuteBtnVideo : styles.activeMuteBtn),
                  videoConnected && styles.videoCallControlBtn,
                  { width: s(56), height: s(56), borderRadius: s(28) }
                ]}
                onPress={onToggleMute}
              >
                <Ionicons
                  name={isMuted ? 'mic-off' : 'mic'}
                  size={s(24)}
                  color={isMuted ? '#FFFFFF' : (videoConnected ? '#FFFFFF' : '#4E342E')}
                />
              </TouchableOpacity>

              <TouchableOpacity style={[styles.callEndBtn, { width: s(72), height: s(72), borderRadius: s(36) }]} onPress={onEnd}>
                <Ionicons name="close" size={s(32)} color="#FFFFFF" />
              </TouchableOpacity>

              {callTypeVideo ? (
                <TouchableOpacity
                  style={[
                    styles.callMuteBtn,
                    videoConnected && styles.videoCallControlBtn,
                    { width: s(56), height: s(56), borderRadius: s(28) }
                  ]}
                  onPress={onSwitchCamera}
                >
                  <Ionicons name="camera-reverse" size={s(24)} color={videoConnected ? '#FFFFFF' : '#4E342E'} />
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[
                    styles.callMuteBtn,
                    isVideoMuted && styles.activeMuteBtn,
                    { width: s(56), height: s(56), borderRadius: s(28) }
                  ]}
                  onPress={onToggleSpeaker}
                >
                  <Ionicons name="volume-high" size={s(24)} color={isVideoMuted ? '#BDBDBD' : '#4E342E'} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  callModalContainer: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  callVideoBg: {
    backgroundColor: '#E1F5FE',
  },
  callAudioBg: {
    backgroundColor: '#FFFDE7',
  },
  callHeaderContainer: {
    alignItems: 'center',
    width: '100%',
    zIndex: 10,
  },
  callHeaderVideoConnected: {
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    width: '90%',
    alignSelf: 'center',
  },
  callLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  callLabelText: {
    color: '#8D6E63',
  },
  textShadowLightBlue: {
    color: '#B3E5FC',
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  callFriendName: {
    fontWeight: '900',
  },
  callFriendNameAudio: {
    color: '#4E342E',
  },
  callFriendNameVideo: {
    color: '#FFFFFF',
  },
  callStatusText: {
    fontWeight: '700',
  },
  callStatusTextAudio: {
    color: '#8D6E63',
  },
  callStatusTextVideo: {
    color: '#E1F5FE',
  },
  textShadow: {
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  callMiddleContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  avatarContainerLarge: {
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: '#FFD54F',
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 4,
    overflow: 'hidden',
  },
  avatarEmojiLarge: {
    fontSize: 80,
  },
  controlsContainer: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  controlsContainerVideo: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  controlsContainerAudio: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderColor: '#FFEFC0',
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 6,
  },
  callControlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 28,
    zIndex: 10,
  },
  callMuteBtn: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#FFEFC0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  videoCallControlBtn: {
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderColor: 'rgba(255, 255, 255, 0.35)',
    borderWidth: 1.5,
  },
  callEndBtn: {
    backgroundColor: '#E53935',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#E53935',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  callControlsRowIncoming: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 40,
    width: '100%',
    zIndex: 10,
  },
  callControlBtn: {
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
  },
  acceptBtn: {
    backgroundColor: '#4CAF50',
  },
  declineBtn: {
    backgroundColor: '#F44336',
  },
  activeMuteBtn: {
    backgroundColor: '#FFCDD2',
    borderColor: '#E53935',
  },
  activeMuteBtnVideo: {
    backgroundColor: '#E53935',
    borderColor: '#FFCDD2',
  },
  remoteVideo: {
    width: '100%',
    height: '100%',
  },
  localVideo: {
    width: 110,
    height: 150,
    position: 'absolute',
    right: 20,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    backgroundColor: '#000000',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
    zIndex: 20,
  },
  localVideoSurface: {
    width: '100%',
    height: '100%',
  },
  localVideoFullScreen: {
    width: '100%',
    height: '100%',
  },
});
