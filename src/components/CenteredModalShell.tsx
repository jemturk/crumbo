import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface CenteredModalShellProps {
  visible: boolean;
  onClose: () => void;
  closeDisabled?: boolean;
  title: string;
  /** Unscaled card width — the shell applies display scaling itself. */
  width: number;
  /** Unscaled space below the header row. Defaults to 20 (AdultAvatarPickerModal used 16). */
  headerMarginBottom?: number;
  children: React.ReactNode;
}

// Shared "centered card" shell for settings/picker-style modals (AvatarPickerModal,
// AdultAvatarPickerModal, AppSettingsModal) — warm overlay + bordered/shadowed rounded card +
// title-and-close-button header. Only the width and body content differ per use.
export default function CenteredModalShell({
  visible,
  onClose,
  closeDisabled,
  title,
  width,
  headerMarginBottom = 20,
  children,
}: CenteredModalShellProps) {
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();

  const handleOverlayPress = () => {
    if (!closeDisabled) onClose();
  };

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <TouchableOpacity
        style={[styles.overlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(78, 52, 46, 0.4)' }]}
        activeOpacity={1}
        onPress={handleOverlayPress}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => {}}
          style={[styles.container, { backgroundColor: colors.cardBg, borderColor: colors.borderStrong, width: s(width), padding: s(20), borderRadius: s(24) }]}
        >
          <View style={[styles.header, { marginBottom: s(headerMarginBottom) }]}>
            <Text style={[styles.title, { fontSize: s(20), color: colors.text }]}>{title}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} disabled={closeDisabled}>
              <Ionicons name="close-circle" size={s(26)} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {children}
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
  },
  container: {
    borderWidth: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 6,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontWeight: '900',
  },
  closeBtn: {
    padding: 2,
  },
});
