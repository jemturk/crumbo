import { AlertButton } from '@/components/CustomAlertModal';
import { StorageService } from '@/services/storage';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';

interface Options {
  onAvatarUrlChange: (url: string | null) => void;
  onAvatarEmojiChange: (emoji: string | null) => void;
  showAlert: (title: string, message: string, buttons?: AlertButton[]) => void;
}

// Shared by parent/chat/index.tsx (own header avatar), dashboard.tsx (Managed Users parent
// card), and index.tsx (the gate) — all three let a parent pick a real photo (camera/library) or
// one of the family-role preset avatars (see AdultAvatarPickerModal) the same way.
export function useParentAvatarPicker({ onAvatarUrlChange, onAvatarEmojiChange, showAlert }: Options) {
  const [pickerVisible, setPickerVisible] = useState(false);

  // Optimistic, matching the kid avatar picker (see handleKidAvatarSelect in index.tsx) — the
  // picker closes and the new avatar shows immediately, with the actual upload/save happening in
  // the background rather than blocking the modal open with a spinner.
  const saveNewAvatar = (localUri: string) => {
    setPickerVisible(false);
    onAvatarUrlChange(localUri);
    onAvatarEmojiChange(null);
    StorageService.uploadParentAvatar(localUri).then((url) => {
      if (url) {
        // Swap the local file URI for the real hosted one once the upload finishes.
        onAvatarUrlChange(url);
      } else {
        showAlert('Upload Failed', "Couldn't upload your photo — check your connection and try again.");
      }
    });
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      showAlert('Permission Required', 'Camera permission is required to take a photo.');
      return;
    }
    // Front camera — this is a selfie-style profile photo, not a photo of something else.
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
      cameraType: ImagePicker.CameraType.front,
    });
    if (result.canceled) return;
    saveNewAvatar(result.assets[0].uri);
  };

  const chooseFromGallery = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showAlert('Permission Required', 'Photo library permission is required to choose a photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1] });
    if (result.canceled) return;
    saveNewAvatar(result.assets[0].uri);
  };

  const removePhoto = () => {
    setPickerVisible(false);
    onAvatarUrlChange(null);
    StorageService.removeParentAvatar();
  };

  const selectPreset = (emoji: string) => {
    setPickerVisible(false);
    onAvatarEmojiChange(emoji);
    onAvatarUrlChange(null);
    StorageService.setParentAvatarEmoji(emoji).then((success) => {
      if (!success) {
        showAlert('Error', "Couldn't update your avatar — check your connection and try again.");
      }
    });
  };

  return {
    pickerVisible,
    openPicker: () => setPickerVisible(true),
    closePicker: () => setPickerVisible(false),
    takePhoto,
    chooseFromGallery,
    removePhoto,
    selectPreset,
  };
}
