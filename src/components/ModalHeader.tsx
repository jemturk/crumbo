import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface ModalHeaderProps {
  title: string;
  onCancel: () => void;
  onSend: () => void;
  sendDisabled?: boolean;
}

// Shared "Cancel / Title / Send" header for the attachment-capture modals (DrawingCanvasModal,
// VoiceRecorderModal) — identical styling and behavior in both.
export default function ModalHeader({ title, onCancel, onSend, sendDisabled }: ModalHeaderProps) {
  const { s } = useDisplayScale();
  const { colors } = useAppTheme();

  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onCancel}
        style={[styles.headerBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong, borderRadius: s(16), paddingHorizontal: s(14), paddingVertical: s(8) }]}
      >
        <Text style={[styles.headerBtnText, { color: colors.actionBtnSecondaryText, fontSize: s(14) }]}>Cancel</Text>
      </TouchableOpacity>
      <Text style={[styles.title, { color: colors.text, fontSize: s(17) }]}>{title}</Text>
      <TouchableOpacity
        onPress={onSend}
        style={[
          styles.headerBtn,
          { backgroundColor: colors.primaryBtn, borderColor: 'transparent', borderRadius: s(16), paddingHorizontal: s(16), paddingVertical: s(8) },
          sendDisabled && styles.headerBtnDisabled,
        ]}
        disabled={sendDisabled}
      >
        <Text style={[styles.headerBtnText, { color: colors.primaryBtnText, fontSize: s(14), fontWeight: '800' }]}>
          Send
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerBtn: {
    borderWidth: 2,
  },
  headerBtnDisabled: {
    opacity: 0.5,
  },
  headerBtnText: {
    fontWeight: '700',
  },
  title: {
    fontWeight: '800',
  },
});
