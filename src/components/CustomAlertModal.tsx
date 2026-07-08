import React from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity } from 'react-native';

export interface AlertButton {
  text: string;
  style?: 'cancel' | 'destructive' | 'default';
  onPress?: () => void | Promise<void>;
}

interface CustomAlertModalProps {
  visible: boolean;
  title: string;
  message: string;
  buttons?: AlertButton[];
  onClose: () => void;
}

export default function CustomAlertModal({
  visible,
  title,
  message,
  buttons,
  onClose,
}: CustomAlertModalProps) {
  // If no buttons, default to a simple "OK" button
  const alertButtons = buttons && buttons.length > 0 ? buttons : [{ text: 'OK', onPress: onClose }];

  return (
    <Modal
      animationType="fade"
      transparent={true}
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.alertContainer}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          
          <View style={[
            styles.buttonsContainer,
            alertButtons.length > 2 ? styles.buttonsVertical : styles.buttonsHorizontal
          ]}>
            {alertButtons.map((btn, index) => {
              const isCancel = btn.style === 'cancel';
              const isDestructive = btn.style === 'destructive';
              
              let btnStyle = styles.defaultBtn;
              let textStyle = styles.defaultBtnText;
              
              if (isCancel) {
                btnStyle = styles.cancelBtn;
                textStyle = styles.cancelBtnText;
              } else if (isDestructive) {
                btnStyle = styles.destructiveBtn;
                textStyle = styles.destructiveBtnText;
              }
              
              const handlePress = async () => {
                onClose();
                if (btn.onPress) {
                  await btn.onPress();
                }
              };

              return (
                <TouchableOpacity
                  key={index}
                  style={[styles.button, btnStyle, alertButtons.length > 2 && { width: '100%', flex: 0 }]}
                  onPress={handlePress}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.btnText, textStyle]}>{btn.text}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(78, 52, 46, 0.4)', // Warm overlay
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  alertContainer: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#FFFDF4',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#FFD54F',
    shadowColor: '#8D6E63',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '900',
    color: '#4E342E',
    textAlign: 'center',
    marginBottom: 12,
  },
  message: {
    fontSize: 15,
    fontWeight: '600',
    color: '#8D6E63',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  buttonsContainer: {
    width: '100%',
    gap: 12,
  },
  buttonsHorizontal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  buttonsVertical: {
    flexDirection: 'column',
  },
  button: {
    flex: 1,
    height: 48,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
  },
  defaultBtn: {
    backgroundColor: '#FBC02D',
    borderColor: '#FBC02D',
  },
  defaultBtnText: {
    color: '#4E342E',
  },
  cancelBtn: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFEFC0',
  },
  cancelBtnText: {
    color: '#8D6E63',
  },
  destructiveBtn: {
    backgroundColor: '#E53935',
    borderColor: '#E53935',
  },
  destructiveBtnText: {
    color: '#FFFFFF',
  },
  btnText: {
    fontSize: 15,
    fontWeight: '800',
  },
});
