import ChatMediaBubble from '@/components/ChatMediaBubble';
import { Dimensions, Modal, StyleSheet, TouchableOpacity } from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const VIEWER_SIZE = Math.min(SCREEN_WIDTH - 64, 440);
const OUTER_RADIUS = 20;
const BORDER_WIDTH = 4;
// For concentric corners, the inner content's radius must be the outer radius minus the border
// it's inset by — using the same radius for both (as if the border weren't there) makes the
// inner curve poke out past the outer one at each corner.
const INNER_RADIUS = OUTER_RADIUS - BORDER_WIDTH;

interface MediaViewerModalProps {
  visible: boolean;
  onClose: () => void;
  // The raw storage path/url from parseMediaMessage — same value ChatMediaBubble already takes
  // in the chat list, resolved to a signed URL internally.
  uri: string | null;
  // Drawings get a subtle border to define the edge of the (often near-white) canvas against
  // the frame — photos don't need it, they already have enough contrast of their own.
  isDrawing?: boolean;
}

// Tapping a photo or drawing message bubble in ConversationView opens this — a full-size,
// tap-anywhere-to-dismiss look at the image, mirroring AvatarPreviewModal's overlay styling.
export default function MediaViewerModal({ visible, onClose, uri, isDrawing }: MediaViewerModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.imageWrap}>
          {uri && (
            <ChatMediaBubble
              uri={uri}
              size={VIEWER_SIZE}
              borderRadius={INNER_RADIUS}
              borderWidth={isDrawing ? 1 : undefined}
              borderColor={isDrawing ? '#FFF5D1' : undefined}
            />
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(78, 52, 46, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  imageWrap: {
    borderRadius: OUTER_RADIUS,
    overflow: 'hidden',
    borderWidth: BORDER_WIDTH,
    borderColor: '#FFFFFF',
  },
});
