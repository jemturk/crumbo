import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { DEFAULT_EMOJIS } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface AvatarPickerModalProps {
  visible: boolean;
  currentEmoji?: string;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

export default function AvatarPickerModal({ visible, currentEmoji, onClose, onSelect }: AvatarPickerModalProps) {
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(78, 52, 46, 0.4)' }]}>
        <View style={[styles.container, { backgroundColor: colors.cardBg, borderColor: colors.borderStrong, width: s(320), padding: s(20), borderRadius: s(24) }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { fontSize: s(20), color: colors.text }]}>Choose Your Avatar</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close-circle" size={s(26)} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.grid}>
            {DEFAULT_EMOJIS.map((emoji) => {
              const isSelected = emoji === currentEmoji;
              return (
                <TouchableOpacity
                  key={emoji}
                  style={[
                    styles.emojiBtn,
                    {
                      width: s(56),
                      height: s(56),
                      borderRadius: s(16),
                      borderColor: isSelected ? colors.primaryBtn : colors.border,
                      backgroundColor: isSelected ? `${colors.primaryBtn}33` : colors.inputBg,
                    },
                  ]}
                  onPress={() => onSelect(emoji)}
                >
                  <Text style={{ fontSize: s(28) }}>{emoji}</Text>
                </TouchableOpacity>
              );
            })}
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
    marginBottom: 20,
  },
  title: {
    fontWeight: '900',
  },
  closeBtn: {
    padding: 2,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'center',
  },
  emojiBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
});
