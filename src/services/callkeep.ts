import { Platform } from 'react-native';
import RNCallKeep from 'react-native-callkeep';

const options = {
  ios: {
    appName: 'Crumbo',
  },
  android: {
    alertTitle: 'Permissions required',
    alertDescription: 'This application needs to access your phone accounts to make calls.',
    cancelButton: 'Cancel',
    okButton: 'OK',
    imageName: 'phone_keep_icon',
    additionalPermissions: [],
    selfManaged: true, // Use self-managed ConnectionService for VoIP calls
    foregroundService: {
      channelId: 'com.jemturk.crumbo.calling',
      channelName: 'Active Call Service',
      notificationTitle: 'Crumbo call active',
      notificationIcon: 'phone_keep_icon',
    }
  }
};

class CallKeepManager {
  private initialized = false;
  private onAnswerCallback: (() => void) | null = null;
  private onRejectCallback: (() => void) | null = null;

  constructor() {
    this.registerCallKeepListeners();
  }

  async setup() {
    if (Platform.OS !== 'android') return;
    if (this.initialized) return;

    try {
      await RNCallKeep.setup(options);
      RNCallKeep.setAvailable(true);
      this.initialized = true;
      console.log('[CallKeep] Setup successfully initialized');

      // Clear any ghost connections left from previous app runs/crashes
      RNCallKeep.endAllCalls();

      const isConnectionAvailable = await RNCallKeep.isConnectionServiceAvailable();
      console.log('[CallKeep] Android ConnectionService available:', isConnectionAvailable);
    } catch (err) {
      console.error('[CallKeep] Setup error:', err);
    }
  }

  // Register answer/reject callbacks from the UI layer
  registerCallbacks(onAnswer: () => void, onReject: () => void) {
    this.onAnswerCallback = onAnswer;
    this.onRejectCallback = onReject;
  }

  clearCallbacks() {
    this.onAnswerCallback = null;
    this.onRejectCallback = null;
  }

  // Show native incoming call UI
  async displayIncomingCall(uuid: string, handle: string, name: string) {
    if (Platform.OS !== 'android') return;
    await this.setup();
    try {
      console.log(`[CallKeep] Displaying incoming call: ${uuid} for ${name}`);
      RNCallKeep.displayIncomingCall(uuid, handle, name, 'number', false);
    } catch (err) {
      console.error('[CallKeep] Failed to display incoming call:', err);
    }
  }

  // Notify system about outgoing call
  async startCall(uuid: string, handle: string, name: string) {
    if (Platform.OS !== 'android') return;
    await this.setup();
    try {
      console.log(`[CallKeep] Starting outgoing call: ${uuid} to ${name}`);
      RNCallKeep.startCall(uuid, handle, name, 'number', false);
    } catch (err) {
      console.error('[CallKeep] Failed to start outgoing call:', err);
    }
  }

  // End native call
  endCall(uuid: string) {
    if (Platform.OS !== 'android') return;
    try {
      console.log(`[CallKeep] Ending call: ${uuid}`);
      RNCallKeep.endCall(uuid);
      // Clean up all active calls to prevent ghost calls in the Telecom system
      RNCallKeep.endAllCalls();
    } catch (err) {
      console.error('[CallKeep] Failed to end call:', err);
    }
  }

  private registerCallKeepListeners() {
    if (Platform.OS !== 'android') return;

    RNCallKeep.addEventListener('answerCall', ({ callUUID }) => {
      console.log(`[CallKeep] User answered call from system UI: ${callUUID}`);
      if (this.onAnswerCallback) {
        this.onAnswerCallback();
      }
    });

    RNCallKeep.addEventListener('endCall', ({ callUUID }) => {
      console.log(`[CallKeep] User ended/rejected call from system UI: ${callUUID}`);
      if (this.onRejectCallback) {
        this.onRejectCallback();
      }
    });
  }
}

export const callKeepManager = new CallKeepManager();
