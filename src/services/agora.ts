import createAgoraRtcEngine, {
  IRtcEngine,
  ChannelProfileType,
  ClientRoleType,
  RtcConnection,
  UserOfflineReasonType,
} from 'react-native-agora';
import { supabase } from './supabase';

// Hash function to convert string (cookieCode) into a 32-bit positive integer for Agora UIDs
export function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  // Ensure it's positive and greater than 0
  return Math.abs(hash) || 1;
}

class AgoraManager {
  private engine: IRtcEngine | null = null;
  private isInitialized = false;

  async init(
    appId: string,
    onUserJoined: (uid: number) => void,
    onUserOffline: (uid: number) => void,
    onError: (err: any) => void
  ): Promise<void> {
    if (this.isInitialized && this.engine) {
      console.log('[Agora] Already initialized. Updating event handlers to avoid stale closures.');
      this.engine.unregisterEventHandler({});
      this.engine.registerEventHandler({
        onJoinChannelSuccess: (connection: RtcConnection, elapsed: number) => {
          console.log('[Agora] Local user joined successfully', connection.channelId, connection.localUid);
        },
        onUserJoined: (connection: RtcConnection, remoteUid: number, elapsed: number) => {
          console.log('[Agora] Remote user joined', remoteUid);
          onUserJoined(remoteUid);
        },
        onUserOffline: (connection: RtcConnection, remoteUid: number, reason: UserOfflineReasonType) => {
          console.log('[Agora] Remote user offline', remoteUid, reason);
          onUserOffline(remoteUid);
        },
        onError: (err: number, msg: string) => {
          console.error('[Agora] Engine error:', err, msg);
          onError({ err, msg });
        }
      });
      return;
    }

    try {
      this.engine = createAgoraRtcEngine();
      await this.engine.initialize({ appId });

      this.engine.registerEventHandler({
        onJoinChannelSuccess: (connection: RtcConnection, elapsed: number) => {
          console.log('[Agora] Local user joined successfully', connection.channelId, connection.localUid);
        },
        onUserJoined: (connection: RtcConnection, remoteUid: number, elapsed: number) => {
          console.log('[Agora] Remote user joined', remoteUid);
          onUserJoined(remoteUid);
        },
        onUserOffline: (connection: RtcConnection, remoteUid: number, reason: UserOfflineReasonType) => {
          console.log('[Agora] Remote user offline', remoteUid, reason);
          onUserOffline(remoteUid);
        },
        onError: (err: number, msg: string) => {
          console.error('[Agora] Engine error:', err, msg);
          onError({ err, msg });
        }
      });

      this.isInitialized = true;
    } catch (e) {
      console.error('[Agora] Failed to initialize engine', e);
      throw e;
    }
  }

  async join(token: string, channelId: string, uid: number, isVideo: boolean): Promise<void> {
    if (!this.engine) throw new Error('Agora engine not initialized');

    try {
      await this.engine.setChannelProfile(ChannelProfileType.ChannelProfileCommunication);

      if (isVideo) {
        await this.engine.enableVideo();
        await this.engine.startPreview();
      } else {
        await this.engine.disableVideo();
      }

      await this.engine.joinChannel(token, channelId, uid, {
        clientRoleType: ClientRoleType.ClientRoleBroadcaster,
        publishCameraTrack: isVideo,
        publishMicrophoneTrack: true,
      });
      console.log(`[Agora] Joining channel ${channelId} with UID ${uid}`);
    } catch (e) {
      console.error('[Agora] Failed to join channel', e);
      throw e;
    }
  }

  async leave(): Promise<void> {
    if (this.engine) {
      try {
        console.log('[Agora] Disabling local audio and video...');
        await this.engine.enableLocalAudio(false);
        await this.engine.enableLocalVideo(false);
        await this.engine.disableAudio();
        await this.engine.disableVideo();
        await this.engine.leaveChannel();
        await this.engine.stopPreview();
        console.log('[Agora] Left channel successfully and released focus');
      } catch (e) {
        console.error('[Agora] Error leaving channel', e);
      }
    }
  }

  async muteAudio(mute: boolean): Promise<void> {
    if (this.engine) {
      await this.engine.muteLocalAudioStream(mute);
    }
  }

  async muteVideo(mute: boolean): Promise<void> {
    if (this.engine) {
      await this.engine.muteLocalVideoStream(mute);
    }
  }

  async switchCamera(): Promise<void> {
    if (this.engine) {
      await this.engine.switchCamera();
    }
  }

  async startCallingSound(localUri: string): Promise<void> {
    if (this.engine) {
      try {
        console.log('[Agora] Starting calling/ringback sound via Agora engine:', localUri);
        // Use ID 1 for calling sound
        this.engine.preloadEffect(1, localUri);
        this.engine.playEffect(
          1,         // soundId
          localUri,  // filePath
          -1,        // loopCount (-1 means loop infinitely)
          1.0,       // pitch
          0.0,       // pan (center)
          100.0,     // gain (volume)
          false      // publish (do NOT publish calling sound to remote user!)
        );
      } catch (e) {
        console.error('[Agora] Failed to play calling sound via Agora:', e);
      }
    }
  }

  async stopCallingSound(): Promise<void> {
    if (this.engine) {
      try {
        console.log('[Agora] Stopping calling sound');
        this.engine.stopEffect(1);
        this.engine.unloadEffect(1);
      } catch (e) {
        console.error('[Agora] Failed to stop calling sound via Agora:', e);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.engine) {
      try {
        await this.leave();
        this.engine.unregisterEventHandler({});
        // Defer engine release by 100ms to allow native call stack to unwind
        const engineToRelease = this.engine;
        setTimeout(() => {
          try {
            engineToRelease.release();
            console.log('[Agora] Native engine released successfully');
          } catch (err) {
            console.error('[Agora] Error releasing native engine:', err);
          }
        }, 100);
      } catch (e) {
        console.error('[Agora] Error releasing engine', e);
      } finally {
        this.engine = null;
        this.isInitialized = false;
      }
    }
  }
}

export const agoraManager = new AgoraManager();

export async function fetchAgoraToken(channelName: string, uid: number): Promise<string> {
  const { data, error } = await supabase.functions.invoke('generate-agora-token', {
    body: { channelName, uid, role: 'publisher' }
  });

  if (error) {
    console.error('[Agora] Error invoking generate-agora-token Edge Function:', error);
    throw error;
  }

  if (!data || !data.token) {
    throw new Error('Invalid token response from Supabase Edge Function');
  }

  return data.token;
}
