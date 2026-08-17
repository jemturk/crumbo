import { useSettings } from '@/context/settings-context';

export type DisplaySize = 'small' | 'default' | 'large';

export function useDisplayScale() {
  const { displaySize, scale, s } = useSettings();

  return {
    displaySize,
    scale,
    s,
  };
}
