import { useKeyboardState } from 'react-native-keyboard-controller';

// Backed by react-native-keyboard-controller's native WindowInsets-based keyboard state instead
// of RN's legacy `Keyboard` module: the legacy module's reported height proved unreliable across
// devices (flush-but-fine on one phone, the keyboard covering half the input box on a tablet
// whose keyboard app renders an extra suggestion-strip row the legacy height event doesn't
// count), and swapping the underlying KeyboardAvoidingView to this library's version (see
// ConversationView) fixed that. `keyboardVisible` tells ConversationView when to skip adding the
// bottom safe-area inset (the gesture bar) on top of the keyboard's own padding — stacking both
// was double-compensating and produced inconsistent input-bar spacing across devices (tight on
// some, keyboard overlapping the input on others).
export function useKeyboardVisibility() {
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);

  return { keyboardVisible, keyboardHeight };
}
