import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StorageService } from '@/services/storage';

export type DisplaySize = 'small' | 'default' | 'large';
export type AppTheme = 'light' | 'dark';

export const ThemeColors = {
  light: {
    bg: '#FFFDF3',
    cardBg: '#FFFFFF',
    text: '#4E342E',
    textSecondary: '#8D6E63',
    border: '#FFF5D1',
    borderStrong: '#FFEFC0',
    primaryBtn: '#FFC93C',
    primaryBtnText: '#4E342E',
    primaryBtnFaded: '#FFF0C2',
    inputBg: '#FFFDF5',
    inputText: '#4E342E',
    cardHeaderLeftIcon: '#D4A373',
    actionBtnSecondaryBg: '#FFFDF5',
    actionBtnSecondaryText: '#8D6E63',
    dangerBg: '#FFEBEE',
    dangerText: '#D32F2F',
    successText: '#2E7D32',
    statusBar: 'dark' as 'dark' | 'light',
  },
  dark: {
    bg: '#1A120B',
    cardBg: '#2C1E15',
    text: '#FFFDF3',
    textSecondary: '#D4A373',
    border: '#3D2A1D',
    borderStrong: '#4E342E',
    primaryBtn: '#FFC93C',
    primaryBtnText: '#1A120B',
    primaryBtnFaded: '#4A3818',
    inputBg: '#241810',
    inputText: '#FFFDF3',
    cardHeaderLeftIcon: '#FFC93C',
    actionBtnSecondaryBg: '#3D2A1D',
    actionBtnSecondaryText: '#D4A373',
    dangerBg: '#5C1E1E',
    dangerText: '#FF8A80',
    successText: '#81C784',
    statusBar: 'light' as 'dark' | 'light',
  },
};

interface SettingsContextType {
  displaySize: DisplaySize;
  theme: AppTheme;
  scale: number;
  s: (size: number) => number;
  colors: typeof ThemeColors.light;
  isDark: boolean;
  changeDisplaySize: (size: DisplaySize) => Promise<void>;
  changeTheme: (theme: AppTheme) => Promise<void>;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [displaySize, setDisplaySize] = useState<DisplaySize>('default');
  const [theme, setTheme] = useState<AppTheme>('light');

  const loadSettings = useCallback(async () => {
    try {
      const savedSize = await AsyncStorage.getItem('crumbo_display_size');
      if (savedSize === 'small' || savedSize === 'default' || savedSize === 'large') {
        setDisplaySize(savedSize);
      }
      const savedTheme = await AsyncStorage.getItem('crumbo_theme');
      if (savedTheme === 'light' || savedTheme === 'dark') {
        setTheme(savedTheme);
      }
    } catch (e) {
      console.error('Error loading settings context:', e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const changeDisplaySize = useCallback(async (size: DisplaySize) => {
    setDisplaySize(size);
    await AsyncStorage.setItem('crumbo_display_size', size);
    await StorageService.syncParentData().catch(e => console.error("Failed to sync display size:", e));
  }, []);

  const changeTheme = useCallback(async (newTheme: AppTheme) => {
    setTheme(newTheme);
    await AsyncStorage.setItem('crumbo_theme', newTheme);
    await StorageService.syncParentData().catch(e => console.error("Failed to sync theme:", e));
  }, []);

  // Scale calculations
  const scale = displaySize === 'small' ? 0.85 : displaySize === 'large' ? 1.25 : 1.0;
  const s = useCallback((size: number) => Math.round(size * scale), [scale]);

  const colors = ThemeColors[theme];
  const isDark = theme === 'dark';

  return (
    <SettingsContext.Provider
      value={{
        displaySize,
        theme,
        scale,
        s,
        colors,
        isDark,
        changeDisplaySize,
        changeTheme,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
