import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Image } from 'expo-image';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface PhotoConfirmModalProps {
  visible: boolean;
  uri: string | null;
  onCancel: () => void;
  onSend: () => void;
}

// Shown right after a photo is taken/picked in ConversationView, before it actually goes out —
// gives a beat to back out of a butt-dial camera shot or a wrong gallery pick instead of it
// sending the instant the picker returns.
export default function PhotoConfirmModal({ visible, uri, onCancel, onSend }: PhotoConfirmModalProps) {
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableOpacity
        style={[styles.overlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.7)' : 'rgba(78, 52, 46, 0.5)' }]}
        activeOpacity={1}
        onPress={onCancel}
      >
        <TouchableOpacity activeOpacity={1} onPress={() => {}}>
          <SafeAreaView style={[styles.card, { backgroundColor: colors.cardBg, borderColor: colors.borderStrong }]}>
            <Text style={[styles.title, { color: colors.text, fontSize: s(17) }]}>Send this photo?</Text>
            {uri && (
              <Image source={{ uri }} style={[styles.preview, { width: s(240), height: s(240), borderRadius: s(16), borderColor: colors.border }]} contentFit="cover" />
            )}
            <View style={[styles.actionsRow, { gap: s(12) }]}>
              <TouchableOpacity
                onPress={onCancel}
                style={[styles.actionBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong, borderRadius: s(16), paddingHorizontal: s(20), paddingVertical: s(12) }]}
              >
                <Text style={[styles.actionBtnText, { color: colors.actionBtnSecondaryText, fontSize: s(15) }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onSend}
                style={[styles.actionBtn, { backgroundColor: colors.primaryBtn, borderColor: 'transparent', borderRadius: s(16), paddingHorizontal: s(20), paddingVertical: s(12) }]}
              >
                <Text style={[styles.actionBtnText, { color: colors.primaryBtnText, fontSize: s(15), fontWeight: '800' }]}>Send</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    borderRadius: 28,
    borderWidth: 2,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
    gap: 16,
  },
  title: {
    fontWeight: '800',
  },
  preview: {
    borderWidth: 2,
  },
  actionsRow: {
    flexDirection: 'row',
  },
  actionBtn: {
    borderWidth: 2,
  },
  actionBtnText: {
    fontWeight: '700',
  },
});
