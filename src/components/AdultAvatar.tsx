import { useAppTheme } from '@/hooks/use-app-theme';
import { Image } from 'expo-image';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface AdultAvatarProps {
  uri?: string;
  // One of ADULT_AVATAR_PRESETS (mom/dad/grandma/grandpa/aunt/uncle) — see AdultAvatarPickerModal.
  // Only rendered when there's no uri; a real photo always takes priority over a picked preset.
  emoji?: string;
  size: number;
}

/** How a grown-up (a parent, or a relative added by email) is represented as an avatar: their
 * uploaded photo if they've set one, else a picked family-role preset emoji if they've set one,
 * otherwise a plain "G" (for grown-up) — kids get their own emoji picker instead, see
 * AvatarPickerModal. */
export default function AdultAvatar({ uri, emoji, size }: AdultAvatarProps) {
  const { colors, isDark } = useAppTheme();

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[styles.image, { width: size, height: size, borderRadius: size / 2 }]}
        contentFit="cover"
        transition={150}
      />
    );
  }

  return (
    <View
      style={[
        styles.fallback,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: isDark ? colors.inputBg : '#FFFDF0',
          borderColor: colors.borderStrong,
        },
      ]}
    >
      {emoji ? (
        <Text style={{ fontSize: size * 0.55 }}>{emoji}</Text>
      ) : (
        <Text style={[styles.letter, { fontSize: size * 0.45, color: colors.textSecondary }]}>G</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    borderWidth: 0,
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  letter: {
    fontWeight: '800',
  },
});
