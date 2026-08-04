import { useAppTheme } from '@/hooks/use-app-theme';
import { useDisplayScale } from '@/hooks/use-display-scale';
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import ViewShot, { ViewShotRef } from 'react-native-view-shot';

interface DrawingCanvasModalProps {
  visible: boolean;
  onClose: () => void;
  onSend: (localUri: string) => void;
}

interface StrokePath {
  d: string;
  color: string;
  strokeWidth: number;
}

const SWATCH_COLORS = ['#4E342E', '#D32F2F', '#1976D2', '#2E7D32', '#F7931E', '#7B1FA2'];
const BRUSH_SIZES = [4, 8, 14];
const CANVAS_SIZE = 300;

export default function DrawingCanvasModal({ visible, onClose, onSend }: DrawingCanvasModalProps) {
  const { s } = useDisplayScale();
  const { colors } = useAppTheme();
  // react-native-view-shot's own type only exposes the underlying View — .capture() is attached
  // at runtime (see ViewShotRef in the library), so this ref's type already accounts for it.
  const viewShotRef = useRef<ViewShotRef>(null);

  const [paths, setPaths] = useState<StrokePath[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [color, setColor] = useState(SWATCH_COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(BRUSH_SIZES[1]);

  // The Pan gesture's callbacks (below) close over these — .runOnJS(true) makes them run as
  // plain JS callbacks (not UI-thread worklets), so ordinary refs/state here are safe to use.
  const colorRef = useRef(color);
  const strokeWidthRef = useRef(strokeWidth);
  useEffect(() => {
    colorRef.current = color;
    strokeWidthRef.current = strokeWidth;
  }, [color, strokeWidth]);

  const pan = Gesture.Pan()
    .runOnJS(true)
    .onStart((e) => {
      setCurrentPath(`M ${e.x.toFixed(1)} ${e.y.toFixed(1)}`);
    })
    .onUpdate((e) => {
      setCurrentPath((prev) => `${prev ?? `M ${e.x.toFixed(1)} ${e.y.toFixed(1)}`} L ${e.x.toFixed(1)} ${e.y.toFixed(1)}`);
    })
    .onEnd(() => {
      setCurrentPath((prev) => {
        if (prev) {
          setPaths((prevPaths) => [...prevPaths, { d: prev, color: colorRef.current, strokeWidth: strokeWidthRef.current }]);
        }
        return null;
      });
    });

  const handleUndo = () => setPaths((prev) => prev.slice(0, -1));
  const handleClear = () => setPaths([]);

  const reset = () => {
    setPaths([]);
    setCurrentPath(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSend = async () => {
    if (paths.length === 0) return;
    try {
      const uri = await viewShotRef.current?.capture?.();
      if (uri) {
        reset();
        onSend(uri);
      }
    } catch (e) {
      console.error('Failed to capture drawing', e);
    }
  };

  return (
    <Modal animationType="slide" visible={visible} onRequestClose={handleClose}>
      {/* RN's Modal renders into a separate native root, outside the app's own component tree —
          the app-level GestureHandlerRootView (src/app/_layout.tsx) doesn't reach in here, so
          gestures need their own root view local to this modal too. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaView style={[styles.container, { backgroundColor: colors.bg }]}>
          <View style={styles.header}>
            <TouchableOpacity
              onPress={handleClose}
              style={[styles.headerBtn, { backgroundColor: colors.actionBtnSecondaryBg, borderColor: colors.borderStrong, borderRadius: s(16), paddingHorizontal: s(14), paddingVertical: s(8) }]}
            >
              <Text style={[styles.headerBtnText, { color: colors.actionBtnSecondaryText, fontSize: s(14) }]}>Cancel</Text>
            </TouchableOpacity>
            <Text style={[styles.title, { color: colors.text, fontSize: s(17) }]}>Draw a Picture</Text>
            <TouchableOpacity
              onPress={handleSend}
              style={[
                styles.headerBtn,
                { backgroundColor: colors.primaryBtn, borderColor: 'transparent', borderRadius: s(16), paddingHorizontal: s(16), paddingVertical: s(8) },
                paths.length === 0 && styles.headerBtnDisabled,
              ]}
              disabled={paths.length === 0}
            >
              <Text style={[styles.headerBtnText, { color: colors.primaryBtnText, fontSize: s(14), fontWeight: '800' }]}>
                Send
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.canvasWrapper}>
            <ViewShot ref={viewShotRef} options={{ format: 'png', result: 'tmpfile' }}>
              <View style={[styles.canvas, { width: s(CANVAS_SIZE), height: s(CANVAS_SIZE), borderColor: colors.border }]}>
                <GestureDetector gesture={pan}>
                  <Svg width={s(CANVAS_SIZE)} height={s(CANVAS_SIZE)} style={StyleSheet.absoluteFill}>
                    {paths.map((p, i) => (
                      <Path key={i} d={p.d} stroke={p.color} strokeWidth={p.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    ))}
                    {currentPath && (
                      <Path d={currentPath} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    )}
                  </Svg>
                </GestureDetector>
              </View>
            </ViewShot>
          </View>

          <View style={[styles.toolbar, { paddingHorizontal: s(20) }]}>
            <View style={styles.colorRow}>
              {SWATCH_COLORS.map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setColor(c)}
                  style={[
                    styles.colorSwatch,
                    { width: s(32), height: s(32), borderRadius: s(16), backgroundColor: c, borderColor: color === c ? colors.text : 'transparent' },
                  ]}
                />
              ))}
            </View>

            <View style={styles.brushRow}>
              {BRUSH_SIZES.map((size) => (
                <TouchableOpacity
                  key={size}
                  onPress={() => setStrokeWidth(size)}
                  style={[
                    styles.brushBtn,
                    { width: s(40), height: s(40), borderRadius: s(20), borderColor: strokeWidth === size ? colors.primaryBtn : colors.border },
                  ]}
                >
                  <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.text }} />
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.actionsRow}>
              <TouchableOpacity onPress={handleUndo} style={[styles.actionBtn, { borderColor: colors.border }]}>
                <Ionicons name="arrow-undo" size={s(18)} color={colors.text} />
                <Text style={[styles.actionBtnText, { color: colors.text, fontSize: s(13) }]}>Undo</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleClear} style={[styles.actionBtn, { borderColor: colors.border }]}>
                <Ionicons name="trash" size={s(18)} color={colors.dangerText} />
                <Text style={[styles.actionBtnText, { color: colors.dangerText, fontSize: s(13) }]}>Clear</Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerBtn: {
    borderWidth: 2,
  },
  headerBtnDisabled: {
    opacity: 0.5,
  },
  headerBtnText: {
    fontWeight: '700',
  },
  title: {
    fontWeight: '800',
  },
  canvasWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  canvas: {
    borderWidth: 2,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
  },
  toolbar: {
    gap: 16,
    paddingBottom: 24,
  },
  colorRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
  },
  colorSwatch: {
    borderWidth: 3,
  },
  brushRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
  },
  brushBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 2,
  },
  actionBtnText: {
    fontWeight: '700',
  },
});
