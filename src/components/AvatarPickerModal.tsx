import CenteredModalShell from '@/components/CenteredModalShell';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { DEFAULT_EMOJIS } from '@/services/storage';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface AvatarPickerModalProps {
  visible: boolean;
  currentEmoji?: string;
  onClose: () => void;
  onSelect: (emoji: string) => void;
}

export default function AvatarPickerModal({ visible, currentEmoji, onClose, onSelect }: AvatarPickerModalProps) {
  const { s } = useDisplayScale();
  const { colors } = useAppTheme();

  return (
    <CenteredModalShell visible={visible} onClose={onClose} title="Choose Your Avatar" width={320}>
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
    </CenteredModalShell>
  );
}

const styles = StyleSheet.create({
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
