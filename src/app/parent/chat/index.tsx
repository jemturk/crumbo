import AdultAvatar from '@/components/AdultAvatar';
import AdultAvatarPickerModal from '@/components/AdultAvatarPickerModal';
import AppSettingsModal from '@/components/AppSettingsModal';
import ContactListView from '@/components/ContactListView';
import CustomAlertModal, { AlertButton } from '@/components/CustomAlertModal';
import { useContactList } from '@/hooks/use-contact-list';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { useParentAvatarPicker } from '@/hooks/use-parent-avatar-picker';
import { StorageService } from '@/services/storage';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Modal, Platform, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';

export default function ParentChatDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { s } = useDisplayScale();
  const { rows, loading, reload } = useContactList('adult');

  const [myCode, setMyCode] = useState<string | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  const [myAvatarEmoji, setMyAvatarEmoji] = useState<string | null>(null);

  // QR pairing with another parent — mirrors dashboard.tsx's buddy QR flow, just for parents
  // instead of kids (see pairParentsViaQRCode). This stays adult-only; the kid Cookie Jar list
  // has no equivalent.
  const [permission, requestPermission] = useCameraPermissions();
  const [qrCodeVisible, setQrCodeVisible] = useState(false);
  const [qrScannerVisible, setQrScannerVisible] = useState(false);
  const qrScanHandledRef = useRef(false);
  const [settingsVisible, setSettingsVisible] = useState(false);

  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    message: string;
    buttons?: AlertButton[];
  }>({ visible: false, title: '', message: '' });

  const showAlert = (title: string, message: string, buttons?: AlertButton[]) => {
    setAlertConfig({ visible: true, title, message, buttons });
  };

  const avatarPicker = useParentAvatarPicker({
    onAvatarUrlChange: setMyAvatarUrl,
    onAvatarEmojiChange: setMyAvatarEmoji,
    showAlert,
  });

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const code = await StorageService.getMyParentCode();
        if (!code) return;
        setMyCode(code);
        const name = await StorageService.getParentName();
        const email = await StorageService.getParentEmail();
        setMyName(name || email);
        setMyAvatarUrl(await StorageService.getParentAvatarUrl());
        setMyAvatarEmoji(await StorageService.getParentAvatarEmoji());
      })();
    }, [])
  );

  const handleStartQRScan = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        showAlert("Permission Required", "Camera access is needed to scan a QR code.");
        return;
      }
    }
    qrScanHandledRef.current = false;
    setQrScannerVisible(true);
  };

  const handleScannedParentQR = async (data: string) => {
    try {
      const parsed = JSON.parse(data);
      if (!parsed || parsed.crumType !== 'parent_qr' || !parsed.code || !parsed.name) {
        showAlert("Invalid QR", "This QR code is not a valid Crumbo parent code.");
        return;
      }
      if (!myCode) return;
      if (parsed.code === myCode) {
        showAlert("Error", "You can't pair with yourself!");
        return;
      }

      const myEmail = myCode.replace('PARENT:', '');
      const success = await StorageService.pairParentsViaQRCode(myEmail, myName || myEmail, parsed.code, parsed.name);
      if (success) {
        await reload();
        showAlert("Success", `You and ${parsed.name} are now paired!`);
      } else {
        showAlert("Error", "Failed to pair with that parent.");
      }
    } catch {
      showAlert("Invalid QR", "This QR code could not be read.");
    }
  };

  return (
    <ContactListView
      headerAvatar={<AdultAvatar uri={myAvatarUrl || undefined} emoji={myAvatarEmoji || undefined} size={s(38)} />}
      onHeaderAvatarPress={avatarPicker.openPicker}
      headerTitle="Chats"
      headerActions={[
        { key: 'qr-show', icon: 'qr-code-outline', onPress: () => setQrCodeVisible(true) },
        { key: 'qr-scan', icon: 'scan-outline', onPress: handleStartQRScan },
        { key: 'settings', icon: 'settings', onPress: () => setSettingsVisible(true) },
        // Just navigates to the gate — doesn't deactivate anything. Deactivating a parent on
        // this device is a Parent Area action only, to prevent an accidental one-tap logout
        // here. The fromLogout param tells '/' to show its "Welcome back" card instead of its
        // normal auto-redirect straight back here for a still-active parent (see app/index.tsx).
        { key: 'logout', icon: 'log-out-outline', onPress: () => router.replace('/?fromLogout=1') },
      ]}
      rows={rows}
      loading={loading}
      emptyEmoji="🍪"
      emptyTitle="No chats yet"
      emptySubtitle="Add a kid from the Parent Area to start chatting with them here, or tap the scan icon above to pair with another parent."
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
        onParentControlsPress={() => router.push('/parent/dashboard')}
      />
      <AdultAvatarPickerModal
        visible={avatarPicker.pickerVisible}
        currentAvatarUrl={myAvatarUrl}
        currentAvatarEmoji={myAvatarEmoji}
        onClose={avatarPicker.closePicker}
        onTakePhoto={avatarPicker.takePhoto}
        onChooseFromGallery={avatarPicker.chooseFromGallery}
        onRemovePhoto={avatarPicker.removePhoto}
        onSelectPreset={avatarPicker.selectPreset}
      />

      {/* Show My QR Code Modal */}
      <Modal animationType="fade" transparent visible={qrCodeVisible} onRequestClose={() => setQrCodeVisible(false)}>
        <TouchableOpacity style={styles.modalOverlayCentered} activeOpacity={1} onPress={() => setQrCodeVisible(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.qrCodeDialog}>
            <Text style={styles.dialogTitle}>Your Parent QR Code</Text>
            <Text style={styles.qrCodeSubtitle}>Let another parent scan this to pair with you!</Text>

            {myCode && (
              // Rendered locally (react-native-qrcode-svg), same as the kid buddy QR — no
              // parent data is ever sent to a third-party QR image service.
              <View style={styles.qrCodeImage}>
                <QRCode
                  value={JSON.stringify({ crumType: 'parent_qr', code: myCode, name: myName || myCode.replace('PARENT:', '') })}
                  size={200}
                  backgroundColor="transparent"
                />
              </View>
            )}

            <TouchableOpacity style={styles.dialogCloseBtn} onPress={() => setQrCodeVisible(false)}>
              <Text style={styles.dialogCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* QR Scanner Modal */}
      <Modal animationType="slide" transparent={false} visible={qrScannerVisible} onRequestClose={() => setQrScannerVisible(false)}>
        <SafeAreaView style={styles.scannerContainer}>
          {/* react-native's own SafeAreaView only insets on iOS — Android needs this padding
              computed explicitly, same as every other header in the app. */}
          <View style={[styles.scannerHeader, { paddingTop: Platform.OS === 'android' ? insets.top + 14 : 14 }]}>
            <TouchableOpacity onPress={() => setQrScannerVisible(false)} style={styles.scannerBackBtn}>
              <Ionicons name="arrow-back" size={28} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.scannerTitle}>Scan a Parent&apos;s QR Code</Text>
            <View style={{ width: 28 }} />
          </View>

          {qrScannerVisible && (
            <CameraView
              style={StyleSheet.absoluteFill}
              onBarcodeScanned={async ({ data }) => {
                if (qrScanHandledRef.current) return;
                qrScanHandledRef.current = true;
                setQrScannerVisible(false);
                await handleScannedParentQR(data);
              }}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            />
          )}
        </SafeAreaView>
      </Modal>
    </ContactListView>
  );
}

const styles = StyleSheet.create({
  modalOverlayCentered: {
    flex: 1,
    backgroundColor: 'rgba(78, 52, 46, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  qrCodeDialog: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    width: '85%',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#FFEFC0',
  },
  dialogTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#4E342E',
    marginBottom: 8,
  },
  qrCodeSubtitle: {
    fontSize: 13,
    color: '#8D6E63',
    textAlign: 'center',
    marginBottom: 20,
    fontWeight: '600',
  },
  qrCodeImage: {
    width: 200,
    height: 200,
    marginBottom: 16,
    borderRadius: 12,
  },
  dialogCloseBtn: {
    backgroundColor: '#F5F5F5',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderWidth: 1.5,
    borderColor: '#FFEFC0',
  },
  dialogCloseBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#4E342E',
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  scannerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    zIndex: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  scannerBackBtn: {
    padding: 4,
  },
  scannerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
  },
});
