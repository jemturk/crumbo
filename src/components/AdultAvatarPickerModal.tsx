import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { ADULT_AVATAR_PRESETS } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface AdultAvatarPickerModalProps {
  visible: boolean;
  currentAvatarUrl: string | null;
  currentAvatarEmoji: string | null;
  uploading: boolean;
  onClose: () => void;
  onTakePhoto: () => void;
  onChooseFromGallery: () => void;
  onRemovePhoto: () => void;
  onSelectPreset: (emoji: string) => void;
}

// Adult counterpart to AvatarPickerModal (kids' food/animal emoji grid) — a real photo, taken or
// picked from the device, plus a family-role preset grid (mom/dad/grandma/grandpa/aunt/uncle) as
// an alternative for anyone who'd rather not use a photo.
export default function AdultAvatarPickerModal({
  visible,
  currentAvatarUrl,
  currentAvatarEmoji,
  uploading,
  onClose,
  onTakePhoto,
  onChooseFromGallery,
  onRemovePhoto,
  onSelectPreset,
}: AdultAvatarPickerModalProps) {
  const { s } = useDisplayScale();
  const { colors, isDark } = useAppTheme();

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(78, 52, 46, 0.4)' }]}>
        <View style={[styles.container, { backgroundColor: colors.cardBg, borderColor: colors.borderStrong, width: s(340), padding: s(20), borderRadius: s(24) }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { fontSize: s(20), color: colors.text }]}>Update Your Photo</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} disabled={uploading}>
              <Ionicons name="close-circle" size={s(26)} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {uploading ? (
            <ActivityIndicator size="large" color={colors.primaryBtn} style={{ paddingVertical: s(24) }} />
          ) : (
            <>
              <TouchableOpacity
                style={[styles.actionRow, { borderColor: colors.border, borderRadius: s(14), paddingVertical: s(12), paddingHorizontal: s(14), marginBottom: s(10) }]}
                onPress={onTakePhoto}
              >
                <Ionicons name="camera" size={s(20)} color={colors.textSecondary} />
                <Text style={[styles.actionText, { fontSize: s(15), color: colors.text }]}>Take Photo</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionRow, { borderColor: colors.border, borderRadius: s(14), paddingVertical: s(12), paddingHorizontal: s(14), marginBottom: s(16) }]}
                onPress={onChooseFromGallery}
              >
                <Ionicons name="images" size={s(20)} color={colors.textSecondary} />
                <Text style={[styles.actionText, { fontSize: s(15), color: colors.text }]}>Choose from Library</Text>
              </TouchableOpacity>

              <Text style={[styles.orLabel, { fontSize: s(12), color: colors.textSecondary }]}>OR PICK AN AVATAR</Text>

              <View style={styles.grid}>
                {ADULT_AVATAR_PRESETS.map(({ emoji, label }) => {
                  const isSelected = !currentAvatarUrl && emoji === currentAvatarEmoji;
                  return (
                    <TouchableOpacity
                      key={emoji}
                      style={styles.presetBtn}
                      onPress={() => onSelectPreset(emoji)}
                    >
                      <View
                        style={[
                          styles.emojiCircle,
                          {
                            width: s(56),
                            height: s(56),
                            borderRadius: s(28),
                            borderColor: isSelected ? colors.primaryBtn : colors.border,
                            backgroundColor: isSelected ? `${colors.primaryBtn}33` : colors.inputBg,
                          },
                        ]}
                      >
                        <Text style={{ fontSize: s(28) }}>{emoji}</Text>
                      </View>
                      <Text style={[styles.presetLabel, { fontSize: s(11), color: colors.textSecondary }]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {currentAvatarUrl && (
                <TouchableOpacity style={[styles.removeBtn, { marginTop: s(16) }]} onPress={onRemovePhoto}>
                  <Text style={[styles.removeText, { fontSize: s(14), color: colors.dangerText }]}>Remove Photo</Text>
                </TouchableOpacity>
              )}
            </>
          )}
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
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 2,
  },
  actionText: {
    fontWeight: '700',
  },
  orLabel: {
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'center',
    marginBottom: 12,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'center',
  },
  presetBtn: {
    alignItems: 'center',
    gap: 4,
    width: 72,
  },
  emojiCircle: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  presetLabel: {
    fontWeight: '700',
  },
  removeBtn: {
    alignItems: 'center',
  },
  removeText: {
    fontWeight: '800',
  },
});
