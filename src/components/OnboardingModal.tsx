import { ThemeColors } from '@/context/settings-context';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Ionicons } from '@expo/vector-icons';
import React, { useRef, useState } from 'react';
import { Dimensions, Modal, NativeScrollEvent, NativeSyntheticEvent, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface OnboardingModalProps {
  visible: boolean;
  onDone: () => void;
}

type Scale = (n: number) => number;
type Colors = typeof ThemeColors['light'];
interface VisualProps {
  s: Scale;
  colors: Colors;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Small building blocks the per-slide illustrations below are made of. Plain RN views/icons
// rather than screenshots, so they can't go stale against the real UI and stay theme-aware.
function MockFrame({ s, colors, children }: VisualProps & { children: React.ReactNode }) {
  return (
    <View style={[styles.mockFrame, { backgroundColor: colors.cardBg, borderColor: colors.border, borderRadius: s(20), padding: s(16), gap: s(10) }]}>
      {children}
    </View>
  );
}

function MockCodePill({ s, colors, code }: VisualProps & { code: string }) {
  return (
    <View style={[styles.mockCodePill, { backgroundColor: colors.inputBg, borderColor: colors.borderStrong, borderRadius: s(12), paddingVertical: s(8), paddingHorizontal: s(14) }]}>
      <Text style={[styles.mockCodeText, { color: colors.text, fontSize: s(15) }]}>{code}</Text>
      <Ionicons name="copy-outline" size={s(15)} color={colors.textSecondary} />
    </View>
  );
}

function MockDevice({ s, colors, label, children }: VisualProps & { label: string; children: React.ReactNode }) {
  return (
    <View style={[styles.mockDevice, { backgroundColor: colors.inputBg, borderColor: colors.border, borderRadius: s(16), padding: s(12), gap: s(8) }]}>
      <Text style={[styles.mockDeviceLabel, { color: colors.textSecondary, fontSize: s(10) }]}>{label}</Text>
      {children}
    </View>
  );
}

function MockBadge({ s, colors, tone, icon, label }: VisualProps & { tone: 'pending' | 'good'; icon: keyof typeof Ionicons.glyphMap; label: string }) {
  const tint = tone === 'good' ? colors.successText : colors.textSecondary;
  return (
    <View style={[styles.mockBadge, { backgroundColor: colors.inputBg, borderColor: tint, borderRadius: s(10), paddingVertical: s(4), paddingHorizontal: s(8) }]}>
      <Ionicons name={icon} size={s(12)} color={tint} />
      <Text style={[styles.mockBadgeText, { color: tint, fontSize: s(11) }]}>{label}</Text>
    </View>
  );
}

function WelcomeVisual({ s, colors }: VisualProps) {
  return (
    <View style={[styles.welcomeRow, { gap: s(14) }]}>
      <Text style={{ fontSize: s(40) }}>🧒</Text>
      <View style={[styles.welcomeBubble, { backgroundColor: colors.primaryBtn, borderRadius: s(20), padding: s(12) }]}>
        <Text style={{ fontSize: s(30) }}>🍪</Text>
      </View>
      <Text style={{ fontSize: s(40) }}>🧑</Text>
    </View>
  );
}

function ParentSetupVisual({ s, colors }: VisualProps) {
  return (
    <MockFrame s={s} colors={colors}>
      <View style={[styles.mockHeaderRow, { gap: s(6) }]}>
        <Ionicons name="people-outline" size={s(16)} color={colors.textSecondary} />
        <Text style={[styles.mockHeaderText, { color: colors.text, fontSize: s(13) }]}>Managed Children</Text>
      </View>
      <View style={[styles.mockDashedBtn, { borderColor: colors.primaryBtn, borderRadius: s(14), paddingVertical: s(10), gap: s(8) }]}>
        <Ionicons name="add-circle" size={s(18)} color={colors.text} />
        <Text style={[styles.mockDashedBtnText, { color: colors.text, fontSize: s(13) }]}>Add Child Profile</Text>
      </View>
    </MockFrame>
  );
}

function CookieCodeVisual({ s, colors }: VisualProps) {
  return (
    <MockFrame s={s} colors={colors}>
      <MockCodePill s={s} colors={colors} code="CRUM-482-917" />
      <View style={[styles.mockQrRow, { gap: s(10) }]}>
        <View style={[styles.mockQrBox, { borderColor: colors.border, borderRadius: s(12), padding: s(8) }]}>
          <Ionicons name="qr-code" size={s(36)} color={colors.text} />
        </View>
        <Text style={[styles.mockCaption, { color: colors.textSecondary, fontSize: s(12) }]}>Copy it, or{'\n'}share the QR</Text>
      </View>
    </MockFrame>
  );
}

function KidLoginVisual({ s, colors }: VisualProps) {
  return (
    <MockFrame s={s} colors={colors}>
      <View style={[styles.mockInput, { backgroundColor: colors.inputBg, borderColor: colors.borderStrong, borderRadius: s(14), paddingVertical: s(10), paddingHorizontal: s(12) }]}>
        <Text style={[styles.mockInputText, { color: colors.textSecondary, fontSize: s(13) }]}>CRUM-482-917</Text>
      </View>
      <View style={[styles.mockPrimaryBtn, { backgroundColor: colors.primaryBtn, borderRadius: s(14), paddingVertical: s(10) }]}>
        <Text style={[styles.mockPrimaryBtnText, { color: colors.primaryBtnText, fontSize: s(13) }]}>Kid Login 🍪</Text>
      </View>
    </MockFrame>
  );
}

function BuddyCodeVisual({ s, colors }: VisualProps) {
  return (
    <View style={[styles.pairRow, { gap: s(10) }]}>
      <MockDevice s={s} colors={colors} label="ALEX'S BUDDIES">
        <Text style={[styles.mockMiniText, { color: colors.text, fontSize: s(12) }]}>Sam{'\n'}CRUM-118-224</Text>
        <MockBadge s={s} colors={colors} tone="pending" icon="time-outline" label="Pending" />
      </MockDevice>
      <Ionicons name="swap-horizontal" size={s(20)} color={colors.textSecondary} />
      <MockDevice s={s} colors={colors} label="SAM'S BUDDIES">
        <Text style={[styles.mockMiniText, { color: colors.text, fontSize: s(12) }]}>Alex{'\n'}CRUM-482-917</Text>
        <MockBadge s={s} colors={colors} tone="good" icon="checkmark-circle" label="Paired" />
      </MockDevice>
    </View>
  );
}

function QRPairVisual({ s, colors }: VisualProps) {
  return (
    <View style={{ alignItems: 'center', gap: s(12) }}>
      <View style={[styles.pairRow, { gap: s(10) }]}>
        <MockDevice s={s} colors={colors} label="ALEX'S PHONE">
          <Ionicons name="qr-code" size={s(32)} color={colors.text} />
          <Text style={[styles.mockMiniText, { color: colors.textSecondary, fontSize: s(11) }]}>Show QR</Text>
        </MockDevice>
        <Ionicons name="scan-outline" size={s(22)} color={colors.textSecondary} />
        <MockDevice s={s} colors={colors} label="SAM'S PHONE">
          <Ionicons name="camera" size={s(32)} color={colors.text} />
          <Text style={[styles.mockMiniText, { color: colors.textSecondary, fontSize: s(11) }]}>Scan QR</Text>
        </MockDevice>
      </View>
      <MockBadge s={s} colors={colors} tone="good" icon="flash" label="Paired instantly!" />
    </View>
  );
}

function ChatVisual({ s, colors }: VisualProps) {
  return (
    <MockFrame s={s} colors={colors}>
      <View style={[styles.mockBubbleThem, { backgroundColor: colors.inputBg, borderRadius: s(14), paddingVertical: s(8), paddingHorizontal: s(12) }]}>
        <Text style={{ color: colors.text, fontSize: s(13) }}>Hey! 👋</Text>
      </View>
      <View style={[styles.mockBubbleMe, { backgroundColor: colors.primaryBtn, borderRadius: s(14), padding: s(10) }]}>
        <Ionicons name="image" size={s(16)} color={colors.primaryBtnText} />
      </View>
      <View style={[styles.mockIconRow, { gap: s(14) }]}>
        <Ionicons name="camera" size={s(20)} color={colors.textSecondary} />
        <Ionicons name="images" size={s(20)} color={colors.textSecondary} />
        <Ionicons name="brush" size={s(20)} color={colors.textSecondary} />
      </View>
    </MockFrame>
  );
}

function ControlVisual({ s, colors }: VisualProps) {
  return (
    <MockFrame s={s} colors={colors}>
      <View style={[styles.mockToggleRow, { gap: s(10) }]}>
        <View style={[styles.mockToggle, { width: s(36), height: s(36), borderRadius: s(18), backgroundColor: colors.successText }]}>
          <Ionicons name="chatbubble" size={s(16)} color="#FFFFFF" />
        </View>
        <View style={[styles.mockToggle, { width: s(36), height: s(36), borderRadius: s(18), backgroundColor: colors.successText }]}>
          <Ionicons name="call" size={s(16)} color="#FFFFFF" />
        </View>
        <View style={[styles.mockToggle, { width: s(36), height: s(36), borderRadius: s(18), backgroundColor: colors.dangerText }]}>
          <Ionicons name="videocam" size={s(16)} color="#FFFFFF" />
        </View>
      </View>
      <View style={[styles.mockLockRow, { gap: s(6) }]}>
        <Ionicons name="lock-closed" size={s(13)} color={colors.dangerText} />
        <Text style={[styles.mockCaption, { color: colors.dangerText, fontSize: s(12) }]}>Paused any time</Text>
      </View>
    </MockFrame>
  );
}

const SLIDES = [
  {
    title: 'Welcome to Crumbo!',
    body: "A cookie jar just for you and your friends — a safe, simple place to chat.",
    Visual: WelcomeVisual,
  },
  {
    title: 'A grown-up sets up first',
    body: 'In the Parents Area, tap "Add Child Profile" to create a cookie jar for each kid.',
    Visual: ParentSetupVisual,
  },
  {
    title: 'Everyone gets a Cookie Code',
    body: 'Each kid gets their own Cookie Code, like CRUM-482-917. Copy it or show its QR code from the Parents Area.',
    Visual: CookieCodeVisual,
  },
  {
    title: 'Kids log in with the code',
    body: 'On the main screen, type that Cookie Code into "Kid Login" to open your own cookie jar.',
    Visual: KidLoginVisual,
  },
  {
    title: 'Adding buddies by code',
    body: 'Open "Friends & Logs" for each kid and add the other’s name + Cookie Code. Both kids’ parents need to add each other — once both sides do, they’re paired!',
    Visual: BuddyCodeVisual,
  },
  {
    title: 'Or pair instantly with a QR code',
    body: 'One parent taps "Show QR", the other taps "Scan QR" — one scan pairs both kids right away, no waiting.',
    Visual: QRPairVisual,
  },
  {
    title: 'Chat, snap & draw',
    body: 'Send messages, photos from your camera or gallery, and pictures you draw yourself, right in the chat.',
    Visual: ChatVisual,
  },
  {
    title: 'A grown-up is in charge',
    body: 'A parent sets everything up and can pause chat, calls, photos, or drawing any time from the Parents Area.',
    Visual: ControlVisual,
  },
];

export default function OnboardingModal({ visible, onDone }: OnboardingModalProps) {
  const { s } = useDisplayScale();
  const { colors } = useAppTheme();
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);

  const isLast = page === SLIDES.length - 1;

  const goToPage = (index: number) => {
    scrollRef.current?.scrollTo({ x: index * SCREEN_WIDTH, animated: true });
    setPage(index);
  };

  const handleScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setPage(index);
  };

  const handleNext = () => {
    if (isLast) {
      onDone();
    } else {
      goToPage(page + 1);
    }
  };

  return (
    <Modal animationType="fade" visible={visible} onRequestClose={onDone}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
        <View style={styles.skipRow}>
          <TouchableOpacity onPress={onDone} style={{ padding: s(8) }}>
            <Text style={[styles.skipText, { color: colors.textSecondary, fontSize: s(14) }]}>Skip</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScrollEnd}
          scrollEventThrottle={16}
        >
          {SLIDES.map((slide, i) => {
            const Visual = slide.Visual;
            return (
              <View key={i} style={[styles.slide, { width: SCREEN_WIDTH, paddingHorizontal: s(28), gap: s(20) }]}>
                <Visual s={s} colors={colors} />
                <Text style={[styles.title, { fontSize: s(24), color: colors.text }]}>{slide.title}</Text>
                <Text style={[styles.body, { fontSize: s(15), lineHeight: s(22), color: colors.textSecondary }]}>{slide.body}</Text>
              </View>
            );
          })}
        </ScrollView>

        <View style={styles.footer}>
          <View style={styles.dotsRow}>
            {SLIDES.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  { width: s(8), height: s(8), borderRadius: s(4) },
                  { backgroundColor: i === page ? colors.primaryBtn : colors.border },
                ]}
              />
            ))}
          </View>

          <TouchableOpacity
            style={[styles.nextButton, { backgroundColor: colors.primaryBtn }]}
            onPress={handleNext}
          >
            <Text style={[styles.nextButtonText, { fontSize: s(18), color: colors.primaryBtnText }]}>
              {isLast ? 'Get Started 🍪' : 'Next'}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  skipRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
  },
  skipText: {
    fontWeight: '700',
  },
  slide: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontWeight: '900',
    textAlign: 'center',
  },
  body: {
    fontWeight: '500',
    textAlign: 'center',
  },
  footer: {
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingBottom: 24,
    gap: 20,
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dot: {},
  nextButton: {
    borderRadius: 20,
    paddingVertical: 16,
    width: '100%',
    alignItems: 'center',
  },
  nextButtonText: {
    fontWeight: '800',
  },
  // --- Mock illustration pieces ---
  mockFrame: {
    borderWidth: 2,
    alignItems: 'center',
    width: '100%',
  },
  welcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcomeBubble: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  mockHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  mockHeaderText: {
    fontWeight: '800',
  },
  mockDashedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderStyle: 'dashed',
    width: '100%',
  },
  mockDashedBtnText: {
    fontWeight: '800',
  },
  mockCodePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 2,
    width: '100%',
  },
  mockCodeText: {
    fontWeight: '800',
  },
  mockQrRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  mockQrBox: {
    borderWidth: 2,
  },
  mockCaption: {
    fontWeight: '600',
    lineHeight: 16,
  },
  mockInput: {
    borderWidth: 2,
    width: '100%',
  },
  mockInputText: {
    fontWeight: '700',
  },
  mockPrimaryBtn: {
    alignItems: 'center',
    width: '100%',
  },
  mockPrimaryBtnText: {
    fontWeight: '800',
  },
  pairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  mockDevice: {
    borderWidth: 2,
    alignItems: 'center',
    flex: 1,
  },
  mockDeviceLabel: {
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  mockMiniText: {
    fontWeight: '700',
    textAlign: 'center',
  },
  mockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1.5,
  },
  mockBadgeText: {
    fontWeight: '800',
  },
  mockBubbleThem: {
    alignSelf: 'flex-start',
  },
  mockBubbleMe: {
    alignSelf: 'flex-end',
  },
  mockIconRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
  },
  mockToggleRow: {
    flexDirection: 'row',
  },
  mockToggle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  mockLockRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
