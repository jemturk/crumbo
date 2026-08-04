import AppSettingsModal from '@/components/AppSettingsModal';
import AvatarPickerModal from '@/components/AvatarPickerModal';
import ContactListView from '@/components/ContactListView';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useContactList } from '@/hooks/use-contact-list';
import { StorageService } from '@/services/storage';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';

export default function ChatDashboard() {
  const router = useRouter();
  const { s } = useDisplayScale();
  const { rows, kidProfile } = useContactList('kid');

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [avatarPickerVisible, setAvatarPickerVisible] = useState(false);
  // Optimistic override so tapping a new avatar reflects instantly rather than waiting on the
  // next reload() round-trip — falls back to kidProfile's own value once loaded/re-synced.
  const [avatarOverride, setAvatarOverride] = useState<string | undefined>(undefined);
  const avatarEmoji = avatarOverride ?? kidProfile?.avatarEmoji;

  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    message: string;
    buttons?: AlertButton[];
  }>({ visible: false, title: '', message: '' });

  const showAlert = (title: string, message: string, buttons?: AlertButton[]) => {
    setAlertConfig({ visible: true, title, message, buttons });
  };

  const handleAvatarSelect = (emoji: string) => {
    setAvatarPickerVisible(false);
    setAvatarOverride(emoji);
    StorageService.setKidAvatar(emoji).then((success) => {
      if (!success) {
        showAlert("Connection Error", "Could not save your new avatar. Please check your network and try again.");
      }
    });
  };

  return (
    <ContactListView
      headerAvatar={<Text style={{ fontSize: s(32) }}>{avatarEmoji || '🍪'}</Text>}
      onHeaderAvatarPress={() => setAvatarPickerVisible(true)}
      headerSubtitle={kidProfile ? `${kidProfile.name}'s` : undefined}
      headerTitle="Cookie Jar"
      headerActions={[
        { key: 'settings', icon: 'settings', onPress: () => setSettingsVisible(true) },
        // Just navigates back to the gate — doesn't deactivate anything. Deactivating a kid on
        // this device is a Parent Area action only now, to prevent an accidental one-tap logout
        // here; the active profile is still right there next time you tap Enter.
        { key: 'logout', icon: 'log-out-outline', onPress: () => router.replace('/') },
      ]}
      rows={rows}
      emptyEmoji="🧁"
      emptyTitle="Your cookie jar is empty!"
      emptySubtitle={`Ask your parent to add buddies for you using your Cookie Code: ${kidProfile?.cookieCode}`}
    >
      <CustomAlertModal
        visible={alertConfig.visible}
        title={alertConfig.title}
        message={alertConfig.message}
        buttons={alertConfig.buttons}
        onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
      />
      <AppSettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        showParentControlsOption={true}
        onParentControlsPress={() => router.push('/parent/gate')}
      />
      <AvatarPickerModal
        visible={avatarPickerVisible}
        currentEmoji={avatarEmoji}
        onClose={() => setAvatarPickerVisible(false)}
        onSelect={handleAvatarSelect}
      />
    </ContactListView>
  );
}
