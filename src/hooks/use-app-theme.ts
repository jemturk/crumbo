import { useSettings } from '@/context/settings-context';
import { ThemeColors } from '@/context/settings-context';

export type AppTheme = 'light' | 'dark';

export { ThemeColors };

export function useAppTheme() {
  const { theme, colors, isDark } = useSettings();

  return {
    theme,
    colors,
    isDark,
  };
}
