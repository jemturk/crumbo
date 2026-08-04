import { useAppTheme } from '@/hooks/use-app-theme';
import { Image } from 'expo-image';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface AvatarPreviewModalProps {
  visible: boolean;
  onClose: () => void;
  // Either a photo (adult with an uploaded picture) or an emoji (a kid, or an adult with no
  // photo yet) — whichever this contact actually shows in its small header avatar, just bigger.
  uri?: string;
  emoji?: string;
}

// Tapping a header avatar in chat/[friendId].tsx or parent/chat/[code].tsx opens this — a plain
// tap-anywhere-to-dismiss preview, matching CustomAlertModal's overlay styling.
export default function AvatarPreviewModal({ visible, onClose, uri, emoji }: AvatarPreviewModalProps) {
  const { colors, isDark } = useAppTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        {uri ? (
          <Image source={{ uri }} style={styles.photo} contentFit="cover" transition={150} />
        ) : (
          <View
            style={[
              styles.emojiCircle,
              { backgroundColor: isDark ? colors.inputBg : '#FFFDF0', borderColor: colors.borderStrong },
            ]}
          >
            <Text style={styles.emojiText}>{emoji || '🍪'}</Text>
          </View>
        )}
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(78, 52, 46, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  photo: {
    width: 260,
    height: 260,
    borderRadius: 130,
    borderWidth: 4,
    borderColor: '#FFFFFF',
  },
  emojiCircle: {
    width: 260,
    height: 260,
    borderRadius: 130,
    borderWidth: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emojiText: {
    fontSize: 140,
  },
});
