import React from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSettings } from '@/context/settings-context';

interface AppSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  showParentControlsOption?: boolean;
  onParentControlsPress?: () => void;
}

export default function AppSettingsModal({
  visible,
  onClose,
  showParentControlsOption,
  onParentControlsPress,
}: AppSettingsModalProps) {
  const { displaySize, theme, colors, isDark, changeDisplaySize, changeTheme, s } = useSettings();

  const handleParentControls = () => {
    onClose();
    if (onParentControlsPress) {
      onParentControlsPress();
    }
  };

  return (
    <Modal
      animationType="fade"
      transparent={true}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={[styles.overlay, { backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(78, 52, 46, 0.4)' }]}>
        <View style={[styles.container, { backgroundColor: colors.cardBg, borderColor: colors.borderStrong, width: s(310), padding: s(20), borderRadius: s(24) }]}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { fontSize: s(20), color: colors.text }]}>App Settings</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close-circle" size={s(26)} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Settings Section: Theme */}
          <View style={[styles.section, { borderBottomColor: colors.border, paddingBottom: s(16), marginBottom: s(16) }]}>
            <Text style={[styles.sectionTitle, { fontSize: s(14), color: colors.textSecondary }]}>THEME</Text>
            <View style={styles.row}>
              <View style={styles.rowLabelGroup}>
                <Ionicons name={isDark ? "moon" : "sunny"} size={s(20)} color={colors.text} style={{ marginRight: s(8) }} />
                <Text style={[styles.rowText, { fontSize: s(15), color: colors.text }]}>Dark Mode</Text>
              </View>
              <Switch
                value={isDark}
                onValueChange={(val) => changeTheme(val ? 'dark' : 'light')}
                trackColor={{ false: '#FFEFC0', true: '#FFC93C' }}
                thumbColor={isDark ? '#FFFDF3' : '#FFC93C'}
              />
            </View>
          </View>

          {/* Settings Section: Text Size */}
          <View style={[styles.section, { borderBottomColor: colors.border, paddingBottom: s(16), marginBottom: s(16) }]}>
            <Text style={[styles.sectionTitle, { fontSize: s(14), color: colors.textSecondary }]}>DISPLAY SIZE</Text>
            <View style={[styles.sizeSelector, { backgroundColor: isDark ? colors.inputBg : '#FFFDF0', borderColor: colors.borderStrong, borderRadius: s(16), padding: s(4) }]}>
              {(['small', 'default', 'large'] as const).map((size) => {
                const isActive = displaySize === size;
                return (
                  <TouchableOpacity
                    key={size}
                    style={[
                      styles.sizeBtn,
                      isActive && { backgroundColor: colors.primaryBtn },
                      { borderRadius: s(12), paddingVertical: s(8) }
                    ]}
                    onPress={() => changeDisplaySize(size)}
                  >
                    <Text
                      style={[
                        styles.sizeBtnText,
                        { fontSize: s(13) },
                        isActive ? { color: colors.primaryBtnText } : { color: colors.textSecondary }
                      ]}
                    >
                      {size.charAt(0).toUpperCase() + size.slice(1)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Settings Section: Parent Controls */}
          {showParentControlsOption && (
            <TouchableOpacity
              style={[styles.parentBtn, { backgroundColor: colors.primaryBtn, borderRadius: s(16), paddingVertical: s(12), marginTop: s(8) }]}
              onPress={handleParentControls}
            >
              <Ionicons name="lock-closed" size={s(16)} color={colors.primaryBtnText} style={{ marginRight: s(6) }} />
              <Text style={[styles.parentBtnText, { fontSize: s(15), color: colors.primaryBtnText }]}>Parent Controls</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    borderWidth: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 6,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    fontWeight: '900',
  },
  closeBtn: {
    padding: 2,
  },
  section: {
    borderBottomWidth: 1,
  },
  sectionTitle: {
    fontWeight: '800',
    marginBottom: 10,
    letterSpacing: 0.8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rowLabelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowText: {
    fontWeight: '700',
  },
  sizeSelector: {
    flexDirection: 'row',
    borderWidth: 2,
  },
  sizeBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sizeBtnText: {
    fontWeight: '800',
  },
  parentBtn: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  parentBtnText: {
    fontWeight: '800',
  },
});
