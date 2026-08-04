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
  const [uploading, setUploading] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);

  const saveNewAvatar = async (localUri: string) => {
    setUploading(true);
    const url = await StorageService.uploadParentAvatar(localUri);
    setUploading(false);
    if (url) {
      onAvatarUrlChange(url);
      onAvatarEmojiChange(null);
      setPickerVisible(false);
    } else {
      showAlert('Upload Failed', "Couldn't upload your photo — check your connection and try again.");
    }
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
    await saveNewAvatar(result.assets[0].uri);
  };

  const chooseFromGallery = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      showAlert('Permission Required', 'Photo library permission is required to choose a photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8, mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1] });
    if (result.canceled) return;
    await saveNewAvatar(result.assets[0].uri);
  };

  const removePhoto = async () => {
    setUploading(true);
    await StorageService.removeParentAvatar();
    setUploading(false);
    onAvatarUrlChange(null);
    setPickerVisible(false);
  };

  const selectPreset = async (emoji: string) => {
    setUploading(true);
    const success = await StorageService.setParentAvatarEmoji(emoji);
    setUploading(false);
    if (success) {
      onAvatarEmojiChange(emoji);
      onAvatarUrlChange(null);
      setPickerVisible(false);
    } else {
      showAlert('Error', "Couldn't update your avatar — check your connection and try again.");
    }
  };

  return {
    uploading,
    pickerVisible,
    openPicker: () => setPickerVisible(true),
    closePicker: () => setPickerVisible(false),
    takePhoto,
    chooseFromGallery,
    removePhoto,
    selectPreset,
  };
}
