import { createAudioPlayer } from 'expo-audio';

const ringtoneSource = require('../../assets/sounds/ringtone.mp3');
const callingSource = require('../../assets/sounds/calling.mp3');

class SoundManager {
  private ringtonePlayer: any = null;
  private callingPlayer: any = null;

  playRingtone() {
    this.stopAll();
    try {
      console.log('[SoundManager] Starting ringtone...');
      this.ringtonePlayer = createAudioPlayer(ringtoneSource);
      this.ringtonePlayer.loop = true;
      this.ringtonePlayer.play();
    } catch (e) {
      console.error('[SoundManager] Failed to play ringtone:', e);
    }
  }

  playCallingSound() {
    this.stopAll();
    try {
      console.log('[SoundManager] Starting calling/ringback sound...');
      this.callingPlayer = createAudioPlayer(callingSource);
      this.callingPlayer.loop = true;
      this.callingPlayer.play();
    } catch (e) {
      console.error('[SoundManager] Failed to play calling sound:', e);
    }
  }

  stopAll() {
    console.log('[SoundManager] Stopping all sounds...');
    if (this.ringtonePlayer) {
      try {
        this.ringtonePlayer.pause();
        this.ringtonePlayer.release();
      } catch (e) {
        console.warn('[SoundManager] Error stopping ringtonePlayer:', e);
      }
      this.ringtonePlayer = null;
    }
    if (this.callingPlayer) {
      try {
        this.callingPlayer.pause();
        this.callingPlayer.release();
      } catch (e) {
        console.warn('[SoundManager] Error stopping callingPlayer:', e);
      }
      this.callingPlayer = null;
    }
  }
}

export const soundManager = new SoundManager();
