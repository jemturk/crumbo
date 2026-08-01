import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface AttachmentMenuModalProps {
  visible: boolean;
  photosDisabled: boolean;
  drawingDisabled: boolean;
  onClose: () => void;
  onTakePhoto: () => void;
  onChooseFromGallery: () => void;
  onDraw: () => void;
}

export default function AttachmentMenuModal({
  visible,
  photosDisabled,
  drawingDisabled,
  onClose,
  onTakePhoto,
  onChooseFromGallery,
  onDraw,
}: AttachmentMenuModalProps) {
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();

  const renderRow = (icon: keyof typeof Ionicons.glyphMap, label: string, locked: boolean, onPress: () => void) => (
    <TouchableOpacity
      style={[
        styles.row,
        {
          borderColor: locked ? (isDark ? '#5C2525' : '#FFD1D1') : colors.border,
          backgroundColor: locked ? (isDark ? '#3D1B1B' : '#FFF5F5') : colors.inputBg,
          paddingVertical: s(14),
          paddingHorizontal: s(16),
          borderRadius: s(16),
          gap: s(12),
        },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Ionicons name={locked ? 'lock-closed' : icon} size={s(22)} color={locked ? colors.dangerText : colors.text} />
      <Text style={[styles.rowText, { fontSize: s(15), color: locked ? colors.dangerText : colors.text }]}>
        {locked ? `${label} (paused)` : label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(78, 52, 46, 0.4)' }]}>
        <View style={[styles.container, { backgroundColor: colors.cardBg, borderColor: colors.borderStrong, width: s(300), padding: s(20), borderRadius: s(24) }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { fontSize: s(18), color: colors.text }]}>Send Something</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close-circle" size={s(24)} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={{ gap: s(10) }}>
            {renderRow('camera', 'Take Photo', photosDisabled, onTakePhoto)}
            {renderRow('images', 'Choose from Gallery', photosDisabled, onChooseFromGallery)}
            {renderRow('brush', 'Draw a Picture', drawingDisabled, onDraw)}
          </View>
        </View>
      </View>
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
    marginBottom: 16,
  },
  title: {
    fontWeight: '900',
  },
  closeBtn: {
    padding: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
  },
  rowText: {
    fontWeight: '700',
  },
});
