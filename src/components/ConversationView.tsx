import AdultAvatar from '@/components/AdultAvatar';
import AvatarPreviewModal from '@/components/AvatarPreviewModal';
import CallModal from '@/components/CallModal';
import ChatMediaBubble, { parseMediaMessage } from '@/components/ChatMediaBubble';
import CustomAlertModal from '@/components/CustomAlertModal';
import DrawingCanvasModal from '@/components/DrawingCanvasModal';
import PhotoConfirmModal from '@/components/PhotoConfirmModal';
import VoiceMessageBubble from '@/components/VoiceMessageBubble';
import VoiceRecorderModal from '@/components/VoiceRecorderModal';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useConversation } from '@/hooks/use-conversation';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useKeyboardVisibility } from '@/hooks/use-keyboard-visibility';
import { Message } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import React, { useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    KeyboardAvoidingView,
    Platform,
    SafeAreaView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Per-type color so a missed voice call, a missed video call, a finished voice call and a
// finished video call are each visually distinct at a glance instead of collapsing to a single
// "red = missed, gray = ended" state. Missed voice stays red (alert); missed video is purple —
// far enough around the wheel from red to actually read as different, rather than rose/red
// which are too close together at this chip's size. Ended calls use the calmer teal/blue
// family — voice vs. video each get their own hue within that family.
const CALL_LOG_COLORS: Record<string, { fg: string; fgDark: string; bg: string; bgDark: string; border: string; borderDark: string }> = {
  MISSED_AUDIO: { fg: '#D32F2F', fgDark: '#FF8A80', bg: '#FFEBEE', bgDark: '#4C1E20', border: '#FFCDD2', borderDark: '#5C2E30' },
  MISSED_VIDEO: { fg: '#7B1FA2', fgDark: '#CE93D8', bg: '#F3E5F5', bgDark: '#3B1F47', border: '#E1BEE7', borderDark: '#4A2B58' },
  ENDED_AUDIO: { fg: '#00796B', fgDark: '#4DB6AC', bg: '#E0F2F1', bgDark: '#123330', border: '#B2DFDB', borderDark: '#1F4A45' },
  ENDED_VIDEO: { fg: '#1976D2', fgDark: '#64B5F6', bg: '#E3F2FD', bgDark: '#12293D', border: '#BBDEFB', borderDark: '#1E3A5A' },
};

const formatCallDuration = (totalSeconds: number) => {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// Detects a Cookie Code mentioned in ordinary message text (e.g. a kid relaying a friend's code
// to a parent, or a parent relaying one to another parent) so it can be rendered with its own
// tap-to-copy affordance — copying just the code itself, not the surrounding sentence.
const COOKIE_CODE_REGEX = /CRUM-\d{3}-\d{3}/g;

interface ConversationViewProps {
  conversation: ReturnType<typeof useConversation>;
  onBack: () => void;
}

// Shared presentational screen for chat/[friendId].tsx (kid) and parent/chat/[code].tsx (adult)
// — see use-conversation.ts for how the two differ (parental locks + pending-pairing gate on the
// kid side only). Everything here reads from the hook's output with no mode branching at all;
// a locked/pending state simply never occurs for an adult conversation.
export default function ConversationView({ conversation, onBack }: ConversationViewProps) {
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const { keyboardVisible, keyboardHeight } = useKeyboardVisibility();

  const { otherParty, locks, pairingStatus, messages, loading, myCookieCode } = conversation;

  const [avatarPreviewVisible, setAvatarPreviewVisible] = useState(false);
  const [inputText, setInputText] = useState('');
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  const [drawingModalVisible, setDrawingModalVisible] = useState(false);
  const [voiceRecorderVisible, setVoiceRecorderVisible] = useState(false);
  const [pendingPhotoUri, setPendingPhotoUri] = useState<string | null>(null);

  const flatListRef = useRef<FlatList>(null);
  const invertedMessages = useMemo(() => [...messages].reverse(), [messages]);

  const copyCookieCode = async (code: string) => {
    try {
      await Clipboard.setStringAsync(code);
    } catch {
      conversation.showAlert("Cookie Code", code);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim()) return;
    const textToSend = inputText.trim();
    setInputText('');
    try {
      await conversation.sendText(textToSend);
    } catch (e) {
      console.error('Error sending message', e);
    }
  };

  const sendImage = async (uri: string) => {
    try {
      await conversation.sendImage(uri);
    } catch (e) {
      console.error('Error sending photo', e);
      conversation.showAlert('Send Failed', "Couldn't send that photo — check your connection and try again.");
    }
  };

  const handleTakePhoto = async () => {
    setAttachmentMenuVisible(false);
    if (locks.photosDisabled) {
      conversation.showAlert('Paused', 'Sending photos is paused by your parent.');
      return;
    }
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      conversation.showAlert('Permission Required', 'Camera permission is required to take a photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (result.canceled) return;
    setPendingPhotoUri(result.assets[0].uri);
  };

  const handleChooseFromGallery = async () => {
    setAttachmentMenuVisible(false);
    if (locks.photosDisabled) {
      conversation.showAlert('Paused', 'Sending photos is paused by your parent.');
      return;
    }
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      conversation.showAlert('Permission Required', 'Photo library permission is required to choose a photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, mediaTypes: ['images'] });
    if (result.canceled) return;
    setPendingPhotoUri(result.assets[0].uri);
  };

  const handleCancelPendingPhoto = () => setPendingPhotoUri(null);

  const handleConfirmSendPhoto = async () => {
    const uri = pendingPhotoUri;
    setPendingPhotoUri(null);
    if (uri) await sendImage(uri);
  };

  const handleOpenDrawing = () => {
    setAttachmentMenuVisible(false);
    if (locks.drawingDisabled) {
      conversation.showAlert('Paused', 'Sending drawings is paused by your parent.');
      return;
    }
    setDrawingModalVisible(true);
  };

  const handleSendDrawing = async (uri: string) => {
    setDrawingModalVisible(false);
    try {
      await conversation.sendDrawing(uri);
    } catch (e) {
      console.error('Error sending drawing', e);
      conversation.showAlert('Send Failed', "Couldn't send that drawing — check your connection and try again.");
    }
  };

  const handleOpenVoiceRecorder = () => {
    setAttachmentMenuVisible(false);
    if (locks.voiceMessagesDisabled) {
      conversation.showAlert('Paused', 'Sending voice messages is paused by your parent.');
      return;
    }
    setVoiceRecorderVisible(true);
  };

  const handleSendVoiceMessage = async (localUri: string, durationSeconds: number) => {
    setVoiceRecorderVisible(false);
    try {
      await conversation.sendVoice(localUri, durationSeconds);
    } catch (e) {
      console.error('Error sending voice message', e);
      conversation.showAlert('Send Failed', "Couldn't send that voice message — check your connection and try again.");
    }
  };

  const formatTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  const renderMessageItem = ({ item }: { item: Message }) => {
    const isCallLog = item.text.startsWith('[CALL_LOG:');

    if (isCallLog) {
      // Direction suffix (INCOMING/OUTGOING) is who initiated the call; callUUID (used to
      // dedupe each side's independent missed-call write, see storage.ts's dedupeCallLogs) and
      // a completed (non-missed) call's trailing duration-in-seconds field were added after
      // this log format first shipped, so older stored entries may be missing some of these.
      const [logType, direction, , durationStr] = item.text.replace('[CALL_LOG:', '').replace(']', '').split(':');
      let logTitle = '';
      let logIcon: keyof typeof Ionicons.glyphMap = 'call';
      let isMissed = false;

      switch (logType) {
        case 'MISSED_VIDEO':
          logTitle = 'Missed Video Call';
          logIcon = 'videocam-off';
          isMissed = true;
          break;
        case 'MISSED_AUDIO':
          logTitle = 'Missed Voice Call';
          logIcon = 'call-outline';
          isMissed = true;
          break;
        case 'ENDED_VIDEO':
          logTitle = 'Video Call Ended';
          logIcon = 'videocam';
          break;
        case 'ENDED_AUDIO':
        default:
          logTitle = 'Voice Call Ended';
          logIcon = 'call';
          break;
      }

      const durationSeconds = !isMissed && durationStr ? parseInt(durationStr, 10) : NaN;
      if (!isNaN(durationSeconds)) {
        logTitle = `${logTitle} · ${formatCallDuration(durationSeconds)}`;
      }

      const logColors = CALL_LOG_COLORS[logType] || CALL_LOG_COLORS.ENDED_AUDIO;
      const logColor = isDark ? logColors.fgDark : logColors.fg;

      // The direction suffix is relative to whoever WROTE the log row, and rows sync to both
      // devices through the shared messages table. On the writer's device sender is 'me'; on
      // the other side's device the same row arrives with sender 'them' and the meaning flips
      // (their OUTGOING = my incoming). XOR the two to get "did I initiate this call".
      const initiatedByMe = (item.sender === 'me') === (direction === 'OUTGOING');
      const callLogAlignStyle = !direction
        ? styles.callLogCentered // legacy rows written before the direction suffix existed
        : initiatedByMe
        ? styles.myRow
        : styles.theirRow;

      return (
        <View style={[styles.callLogWrapper, callLogAlignStyle]}>
          <View style={[styles.callLogContainer, {
            backgroundColor: isDark ? logColors.bgDark : logColors.bg,
            borderColor: isDark ? logColors.borderDark : logColors.border
          }, { paddingHorizontal: s(12), paddingVertical: s(6), gap: s(6) }]}>
            {direction && (
              <Ionicons
                name="arrow-up-outline"
                size={s(12)}
                color={logColor}
                style={{ transform: [{ rotate: initiatedByMe ? '45deg' : '225deg' }] }}
              />
            )}
            <Ionicons name={logIcon} size={s(16)} color={logColor} style={styles.callLogIcon} />
            <Text style={[styles.callLogText, { color: logColor }, { fontSize: s(12) }]}>
              {logTitle}
            </Text>
            <Text style={[styles.callLogTime, { color: colors.textSecondary }, { fontSize: s(10) }]}>{formatTime(item.timestamp)}</Text>
          </View>
        </View>
      );
    }

    const media = parseMediaMessage(item.text);

    if (media && media.kind !== 'voice') {
      const isMeMedia = item.sender === 'me';
      const isBlocked = media.kind === 'photo' ? locks.photosDisabled : locks.drawingDisabled;

      return (
        <View style={[styles.messageRow, isMeMedia ? styles.myRow : styles.theirRow]}>
          {isBlocked ? (
            <View style={[styles.mediaBubble, styles.mediaBlockedBubble, { backgroundColor: isDark ? '#3D1B1B' : '#FFF5F5', borderColor: isDark ? '#5C2525' : '#FFD1D1' }, { width: s(200), height: s(200), borderRadius: s(16) }]}>
              <Ionicons name="lock-closed" size={s(28)} color={colors.dangerText} />
              <Text style={[styles.mediaBlockedText, { color: colors.dangerText, fontSize: s(13) }]}>
                {media.kind === 'photo' ? 'Photo hidden' : 'Drawing hidden'}
              </Text>
            </View>
          ) : (
            <ChatMediaBubble uri={media.url} size={s(200)} borderRadius={s(16)} />
          )}
          <Text style={[styles.timestamp, isMeMedia ? styles.myTimestamp : styles.theirTimestamp, { color: colors.textSecondary }, { fontSize: s(10) }]}>
            {formatTime(item.timestamp)}
          </Text>
        </View>
      );
    }

    if (media && media.kind === 'voice') {
      const isMeMedia = item.sender === 'me';
      const isBlocked = locks.voiceMessagesDisabled;

      return (
        <View style={[styles.messageRow, isMeMedia ? styles.myRow : styles.theirRow]}>
          {isBlocked ? (
            <View style={[styles.mediaBubble, styles.mediaBlockedBubble, { backgroundColor: isDark ? '#3D1B1B' : '#FFF5F5', borderColor: isDark ? '#5C2525' : '#FFD1D1' }, { width: s(200), height: s(56), borderRadius: s(16) }]}>
              <Ionicons name="lock-closed" size={s(20)} color={colors.dangerText} />
              <Text style={[styles.mediaBlockedText, { color: colors.dangerText, fontSize: s(13) }]}>Voice message hidden</Text>
            </View>
          ) : (
            <View style={[
              styles.bubble,
              isMeMedia ? [styles.myBubble, { backgroundColor: colors.primaryBtn, borderBottomRightRadius: 4 }]
                : [styles.theirBubble, { backgroundColor: isDark ? '#3D2A1D' : '#FFFEC6', borderColor: isDark ? '#4E342E' : '#FFF9C4', borderBottomLeftRadius: 4 }],
              { paddingHorizontal: s(12), paddingVertical: s(8), borderRadius: s(20) }
            ]}>
              <VoiceMessageBubble uri={media.url} durationSeconds={media.durationSeconds} isMe={isMeMedia} />
            </View>
          )}
          <Text style={[styles.timestamp, isMeMedia ? styles.myTimestamp : styles.theirTimestamp, { color: colors.textSecondary }, { fontSize: s(10) }]}>
            {formatTime(item.timestamp)}
          </Text>
        </View>
      );
    }

    const isMe = item.sender === 'me';
    const textColor = isMe ? colors.primaryBtnText : colors.text;

    const codeMatches = item.text.match(COOKIE_CODE_REGEX);
    const messageContent: React.ReactNode = codeMatches
      ? item.text.split(COOKIE_CODE_REGEX).reduce<React.ReactNode[]>((nodes, part, i) => {
          if (part) nodes.push(part);
          const code = codeMatches[i];
          if (code) {
            nodes.push(
              <Text
                key={`code-${i}`}
                onPress={() => copyCookieCode(code)}
                style={{ fontWeight: '800', textDecorationLine: 'underline' }}
              >
                {code} <Ionicons name="copy-outline" size={s(14)} color={textColor} />
              </Text>
            );
          }
          return nodes;
        }, [])
      : item.text;

    return (
      <View style={[styles.messageRow, isMe ? styles.myRow : styles.theirRow]}>
        <View style={[
          styles.bubble,
          isMe ? [styles.myBubble, { backgroundColor: colors.primaryBtn, borderBottomRightRadius: 4 }]
               : [styles.theirBubble, { backgroundColor: isDark ? '#3D2A1D' : '#FFFEC6', borderColor: isDark ? '#4E342E' : '#FFF9C4', borderBottomLeftRadius: 4 }],
          { paddingHorizontal: s(16), paddingVertical: s(10), borderRadius: s(20) }
        ]}>
          <Text style={[styles.messageText, { color: textColor }, { fontSize: s(16), lineHeight: s(22) }]}>{messageContent}</Text>
        </View>
        <Text style={[styles.timestamp, isMe ? styles.myTimestamp : styles.theirTimestamp, { color: colors.textSecondary }, { fontSize: s(10) }]}>
          {formatTime(item.timestamp)}
        </Text>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.primaryBtn} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.cardBg, borderColor: colors.border, paddingTop: Platform.OS === 'android' ? (insets.top > 0 ? insets.top + s(8) : s(44)) : s(14), paddingHorizontal: s(20), paddingVertical: s(14) }]}>
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <Ionicons name="arrow-back" size={s(26)} color={colors.text} />
        </TouchableOpacity>

        <View style={[styles.headerInfo, { flexDirection: 'row', justifyContent: 'flex-start', gap: s(8), marginLeft: s(12) }]}>
          {otherParty && (
            <TouchableOpacity onPress={() => setAvatarPreviewVisible(true)}>
              {otherParty.isAdult ? (
                <AdultAvatar uri={otherParty.avatarUrl} emoji={otherParty.avatarEmoji} size={s(44)} />
              ) : (
                <View style={{ width: s(44), height: s(44), borderRadius: s(22), backgroundColor: isDark ? colors.inputBg : '#FFFDF0', borderWidth: 2, borderColor: colors.borderStrong, justifyContent: 'center', alignItems: 'center' }}>
                  <Text style={{ fontSize: s(22) }}>{otherParty.avatarEmoji || '🍪'}</Text>
                </View>
              )}
            </TouchableOpacity>
          )}
          <Text style={[styles.headerName, { fontSize: s(20), color: colors.text, flexShrink: 1 }]} numberOfLines={1}>{otherParty?.name}</Text>
        </View>

        <View style={styles.headerRight}>
          {!locks.callingDisabled && pairingStatus === 'paired' && (
            <TouchableOpacity style={[styles.headerCallBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong }]} onPress={() => conversation.startCall(false)}>
              <Ionicons name="call" size={s(20)} color={colors.actionBtnSecondaryText} />
            </TouchableOpacity>
          )}
          {!locks.videoCallingDisabled && pairingStatus === 'paired' && (
            <TouchableOpacity style={[styles.headerCallBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong }]} onPress={() => conversation.startCall(true)}>
              <Ionicons name="videocam" size={s(20)} color={colors.actionBtnSecondaryText} />
            </TouchableOpacity>
          )}
          {(locks.callingDisabled || pairingStatus === 'pending') && (locks.videoCallingDisabled || pairingStatus === 'pending') && (
            <View style={{ width: s(36) }} />
          )}
        </View>
      </View>

      {/* Keyboard Avoiding Container */}
      <KeyboardAvoidingView
        style={[styles.keyboardContainer, Platform.OS === 'android' && { paddingBottom: keyboardHeight > 0 ? keyboardHeight + s(24) : 0 }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Messages list */}
        <FlatList
          ref={flatListRef}
          inverted
          data={invertedMessages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessageItem}
          style={{ flex: 1 }}
          contentContainerStyle={[styles.messagesList, { padding: s(16), gap: s(12) }]}
        />

        {/* Bottom Input Area */}
        {locks.chatDisabled ? (
          <View style={[styles.disabledInputArea, { backgroundColor: isDark ? '#3D1B1B' : '#FFF5F5', borderColor: isDark ? '#5C2525' : '#FFD1D1' }, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + s(16) : s(16)) : s(16), paddingHorizontal: s(16), paddingVertical: s(16), gap: s(12) }]}>
            <Ionicons name="lock-closed" size={s(20)} color={colors.dangerText} />
            <Text style={[styles.disabledInputText, { fontSize: s(14), lineHeight: s(20), color: colors.dangerText }]}>Chatting is paused by your parent 🍪</Text>
          </View>
        ) : pairingStatus === 'pending' ? (
          <View style={[styles.pendingInputArea, { backgroundColor: isDark ? '#3D291B' : '#FFF3E0', borderColor: isDark ? '#5C3E25' : '#FFE0B2' }, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + s(16) : s(16)) : s(16), paddingHorizontal: s(16), paddingVertical: s(16), gap: s(12) }]}>
            <Ionicons name="alert-circle" size={s(20)} color={colors.textSecondary} />
            <Text style={[styles.pendingInputText, { fontSize: s(14), lineHeight: s(20), color: colors.textSecondary }]}>
              Waiting for parent approval. Tell friend&apos;s parent your Cookie Code: {myCookieCode}
            </Text>
          </View>
        ) : (
          <View style={[styles.inputArea, { backgroundColor: colors.cardBg, borderColor: colors.border }, { paddingBottom: Platform.OS === 'android' ? (insets.bottom > 0 && !keyboardVisible ? insets.bottom + s(12) : s(12)) : s(12), paddingHorizontal: s(16), paddingVertical: s(8), gap: s(12) }]}>
            {!(locks.photosDisabled && locks.drawingDisabled && locks.voiceMessagesDisabled) && (
              <View style={{ position: 'relative' }}>
                {attachmentMenuVisible && (
                  <View style={[styles.attachIconsColumn, { gap: s(8), bottom: s(48) }]}>
                    {!locks.photosDisabled && (
                      <TouchableOpacity
                        style={[styles.attachIconButton, { width: s(40), height: s(40), borderRadius: s(20), backgroundColor: colors.inputBg }]}
                        onPress={handleTakePhoto}
                      >
                        <Ionicons name="camera" size={s(19)} color={colors.textSecondary} />
                      </TouchableOpacity>
                    )}
                    {!locks.photosDisabled && (
                      <TouchableOpacity
                        style={[styles.attachIconButton, { width: s(40), height: s(40), borderRadius: s(20), backgroundColor: colors.inputBg }]}
                        onPress={handleChooseFromGallery}
                      >
                        <Ionicons name="images" size={s(19)} color={colors.textSecondary} />
                      </TouchableOpacity>
                    )}
                    {!locks.drawingDisabled && (
                      <TouchableOpacity
                        style={[styles.attachIconButton, { width: s(40), height: s(40), borderRadius: s(20), backgroundColor: colors.inputBg }]}
                        onPress={handleOpenDrawing}
                      >
                        <Ionicons name="brush" size={s(19)} color={colors.textSecondary} />
                      </TouchableOpacity>
                    )}
                    {!locks.voiceMessagesDisabled && (
                      <TouchableOpacity
                        style={[styles.attachIconButton, { width: s(40), height: s(40), borderRadius: s(20), backgroundColor: colors.inputBg }]}
                        onPress={handleOpenVoiceRecorder}
                      >
                        <Ionicons name="mic" size={s(19)} color={colors.textSecondary} />
                      </TouchableOpacity>
                    )}
                  </View>
                )}
                <TouchableOpacity
                  style={[styles.attachButton, { width: s(40), height: s(40), borderRadius: s(20) }]}
                  onPress={() => setAttachmentMenuVisible(!attachmentMenuVisible)}
                >
                  <Ionicons name={attachmentMenuVisible ? 'close' : 'add-circle'} size={s(28)} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            )}
            <View style={[styles.inputContainer, { backgroundColor: colors.inputBg, borderColor: colors.borderStrong }, { paddingHorizontal: s(16), borderRadius: s(24), height: s(48) }]}>
              <TextInput
                style={[styles.textInput, { color: colors.inputText }, { fontSize: s(16) }]}
                placeholder="Write something..."
                placeholderTextColor={colors.textSecondary}
                value={inputText}
                onChangeText={setInputText}
                onSubmitEditing={handleSend}
                multiline={false}
              />
            </View>
            <TouchableOpacity
              style={[styles.sendButton, { backgroundColor: colors.primaryBtn }, !inputText.trim() && styles.sendButtonDisabled, { width: s(48), height: s(48), borderRadius: s(24) }]}
              onPress={handleSend}
              disabled={!inputText.trim()}
            >
              <Ionicons name="paper-plane" size={s(20)} color={colors.primaryBtnText} />
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>

      <CallModal
        visible={conversation.callModalVisible}
        callTypeVideo={conversation.callTypeVideo}
        callStatus={conversation.callStatus}
        callDuration={conversation.callDuration}
        callDirection={conversation.callDirection}
        remoteUid={conversation.remoteUid}
        isMuted={conversation.isMuted}
        isVideoMuted={conversation.isVideoMuted}
        friendName={otherParty?.name || 'Crumbo'}
        friendAvatarEmoji={otherParty?.avatarEmoji}
        friendAvatarUrl={otherParty?.avatarUrl}
        onAccept={conversation.acceptCall}
        onDecline={conversation.declineCall}
        onEnd={conversation.endCall}
        onToggleMute={conversation.toggleMute}
        onSwitchCamera={conversation.switchCamera}
        onToggleSpeaker={conversation.toggleSpeakerMock}
        formatDuration={conversation.formatDuration}
      />
      <CustomAlertModal
        visible={conversation.alertConfig.visible}
        title={conversation.alertConfig.title}
        message={conversation.alertConfig.message}
        buttons={conversation.alertConfig.buttons}
        onClose={conversation.dismissAlert}
      />
      <DrawingCanvasModal
        visible={drawingModalVisible}
        onClose={() => setDrawingModalVisible(false)}
        onSend={handleSendDrawing}
      />
      <VoiceRecorderModal
        visible={voiceRecorderVisible}
        onClose={() => setVoiceRecorderVisible(false)}
        onSend={handleSendVoiceMessage}
        onError={(message) => conversation.showAlert('Error', message)}
      />
      <PhotoConfirmModal
        visible={!!pendingPhotoUri}
        uri={pendingPhotoUri}
        onCancel={handleCancelPendingPhoto}
        onSend={handleConfirmSendPhoto}
      />
      <AvatarPreviewModal
        visible={avatarPreviewVisible}
        onClose={() => setAvatarPreviewVisible(false)}
        uri={otherParty?.isAdult ? otherParty.avatarUrl : undefined}
        emoji={otherParty?.isAdult ? (otherParty.avatarUrl ? undefined : otherParty.avatarEmoji) : otherParty?.avatarEmoji}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: '#FFFDF4',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    backgroundColor: '#FFFDF4',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderColor: '#FFF5D1',
    backgroundColor: '#FFFFFF',
    paddingTop: Platform.OS === 'android' ? 44 : 14,
  },
  backButton: {
    padding: 6,
  },
  headerInfo: {
    alignItems: 'center',
    flex: 1,
  },
  headerName: {
    fontSize: 22,
    fontWeight: '900',
    color: '#4E342E',
    textAlign: 'center',
  },
  keyboardContainer: {
    flex: 1,
  },
  messagesList: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 16,
  },
  messageRow: {
    maxWidth: '75%',
    marginBottom: 4,
  },
  myRow: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  theirRow: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  bubble: {
    borderRadius: 20,
    paddingVertical: 12,
    paddingHorizontal: 18,
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  myBubble: {
    backgroundColor: '#FBC02D',
    borderBottomRightRadius: 4,
  },
  theirBubble: {
    backgroundColor: '#FFFEC6',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#FFF9C4',
  },
  messageText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4E342E',
    lineHeight: 22,
  },
  mediaBubble: {
    overflow: 'hidden',
  },
  mediaBlockedBubble: {
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  mediaBlockedText: {
    fontWeight: '700',
  },
  timestamp: {
    fontSize: 11,
    color: '#8D6E63',
    marginTop: 4,
    fontWeight: '600',
    paddingHorizontal: 6,
  },
  myTimestamp: {
    alignSelf: 'flex-end',
  },
  theirTimestamp: {
    alignSelf: 'flex-start',
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderColor: '#FFF5D1',
    gap: 12,
  },
  inputContainer: {
    flex: 1,
    backgroundColor: '#FFFDF0',
    borderWidth: 2,
    borderColor: '#FFF1C5',
    borderRadius: 25,
    height: 50,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  textInput: {
    fontSize: 16,
    color: '#4E342E',
    fontWeight: '600',
  },
  sendButton: {
    backgroundColor: '#FBC02D',
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#FBC02D',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 2,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  attachButton: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  attachIconsColumn: {
    position: 'absolute',
    left: 0,
    flexDirection: 'column-reverse',
    alignItems: 'center',
  },
  attachIconButton: {
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerCallBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#FFFDF5',
    borderWidth: 1,
    borderColor: '#FFEFC0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  disabledInputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: '#FFF5F5',
    borderTopWidth: 1,
    borderColor: '#FFD1D1',
    gap: 8,
  },
  disabledInputText: {
    fontSize: 14,
    color: '#D32F2F',
    fontWeight: '800',
  },
  callLogWrapper: {
    marginVertical: 4,
    maxWidth: '85%',
  },
  callLogCentered: {
    alignSelf: 'center',
  },
  callLogContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
  },
  callLogIcon: {
    marginRight: 2,
  },
  callLogText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4E342E',
  },
  callLogTime: {
    fontSize: 10,
    color: '#8D6E63',
    marginLeft: 6,
    fontWeight: '600',
  },
  pendingInputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 18,
    backgroundColor: '#FFF3E0',
    borderTopWidth: 1,
    borderColor: '#FFE0B2',
    gap: 8,
  },
  pendingInputText: {
    fontSize: 13,
    color: '#E65100',
    fontWeight: '800',
    flexShrink: 1,
    textAlign: 'center',
  },
});
