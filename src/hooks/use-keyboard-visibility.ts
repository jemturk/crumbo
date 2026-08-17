import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

// Android has no built-in KeyboardAvoidingView 'padding' behavior worth trusting here (see
// chat/[friendId].tsx and parent/chat/[code].tsx, both of which pass behavior={undefined} on
// Android) — screens track the keyboard's own height themselves and pad the input area with it.
export function useKeyboardVisibility() {
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow',
      (e) => {
        setKeyboardVisible(true);
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide',
      () => {
        setKeyboardVisible(false);
        setKeyboardHeight(0);
      }
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return { keyboardVisible, keyboardHeight };
}
