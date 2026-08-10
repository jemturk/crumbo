import CenteredModalShell from '@/components/CenteredModalShell';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { ADULT_AVATAR_PRESETS } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface AdultAvatarPickerModalProps {
  visible: boolean;
  currentAvatarUrl: string | null;
  currentAvatarEmoji: string | null;
  onClose: () => void;
  onTakePhoto: () => void;
  onChooseFromGallery: () => void;
  onRemovePhoto: () => void;
  onSelectPreset: (emoji: string) => void;
}

// Adult counterpart to AvatarPickerModal (kids' food/animal emoji grid) — a real photo, taken or
// picked from the device, plus a family-role preset grid (mom/dad/grandma/grandpa/aunt/uncle) as
// an alternative for anyone who'd rather not use a photo. Picking either one closes this modal
// immediately and applies optimistically (see useParentAvatarPicker) — same as the kid picker,
// no in-modal spinner while the change saves in the background.
export default function AdultAvatarPickerModal({
  visible,
  currentAvatarUrl,
  currentAvatarEmoji,
  onClose,
  onTakePhoto,
  onChooseFromGallery,
  onRemovePhoto,
  onSelectPreset,
}: AdultAvatarPickerModalProps) {
  const { s } = useDisplayScale();
  const { colors } = useAppTheme();

  return (
    <CenteredModalShell
      visible={visible}
      onClose={onClose}
      title="Update Your Photo"
      width={340}
      headerMarginBottom={16}
    >
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
        <TouchableOpacity
          style={[
            styles.removeBtn,
            {
              borderColor: colors.dangerText,
              backgroundColor: colors.dangerBg,
              borderRadius: s(12),
              paddingVertical: s(7),
              paddingHorizontal: s(12),
              marginTop: s(16),
              gap: s(6),
            },
          ]}
          onPress={onRemovePhoto}
        >
          <Ionicons name="trash-outline" size={s(14)} color={colors.dangerText} />
          <Text style={[styles.removeText, { fontSize: s(12), color: colors.dangerText }]}>Remove Photo</Text>
        </TouchableOpacity>
      )}
    </CenteredModalShell>
  );
}

const styles = StyleSheet.create({
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
    flexDirection: 'row',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  removeText: {
    fontWeight: '800',
  },
});
