import { useSettings } from '@/context/settings-context';

export function useAppTheme() {
  const { theme, colors, isDark } = useSettings();

  return {
    theme,
    colors,
    isDark,
  };
}
