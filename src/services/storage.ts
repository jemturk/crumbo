import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// Interfaces
export interface Message {
  id: string;
  text: string;
  timestamp: string; // ISO String
  sender: 'me' | 'them';
}

export interface Friend {
  id: string;
  name: string;
  cookieCode: string;
  avatarEmoji: string;
}

export interface KidProfile {
  name: string;
  cookieCode: string;
  chatDisabled?: boolean;
  callingDisabled?: boolean;
  videoCallingDisabled?: boolean;
  friends?: any[];
}

// Storage keys
const KEYS = {
  PARENT_EMAIL: 'crumbo_parent_email',
  IS_SUBSCRIBED: 'crumbo_is_subscribed',
  KID_PROFILE: 'crumbo_kid_profile',
  FRIENDS: 'crumbo_friends',
  MESSAGES_PREFIX: 'crumbo_messages_',
  PARENT_PASSWORD: 'crumbo_parent_password',
  KIDS_LIST: 'crumbo_parent_kids_list',
};

// Default setup
const DEFAULT_EMOJIS = ['🍪', '🧁', '🍩', '🍫', '🍧', '🍰', '🍭', '🍓', '🍒', '🦕', '🐱', '🐼', '🐨', '🦊', '🦁'];

export const StorageService = {
  // Parent Subscription
  async getParentEmail(): Promise<string | null> {
    return await AsyncStorage.getItem(KEYS.PARENT_EMAIL);
  },

  async saveParentEmail(email: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARENT_EMAIL, email);
  },

  async getParentPassword(): Promise<string | null> {
    return await AsyncStorage.getItem(KEYS.PARENT_PASSWORD);
  },

  async saveParentPassword(password: string): Promise<void> {
    await AsyncStorage.setItem(KEYS.PARENT_PASSWORD, password);
  },

  async isSubscribed(): Promise<boolean> {
    const status = await AsyncStorage.getItem(KEYS.IS_SUBSCRIBED);
    return status === 'true';
  },

  async setSubscribed(subscribed: boolean): Promise<void> {
    await AsyncStorage.setItem(KEYS.IS_SUBSCRIBED, subscribed ? 'true' : 'false');
  },

  // Kid Profile List
  async getKidsList(): Promise<KidProfile[]> {
    const data = await AsyncStorage.getItem(KEYS.KIDS_LIST);
    if (!data) return [];
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  },

  async saveKidsList(kids: KidProfile[]): Promise<void> {
    await AsyncStorage.setItem(KEYS.KIDS_LIST, JSON.stringify(kids));
  },

  async getKidProfile(): Promise<KidProfile | null> {
    const data = await AsyncStorage.getItem(KEYS.KID_PROFILE);
    if (!data) return null;
    return JSON.parse(data);
  },

  async createKidProfile(name: string): Promise<KidProfile> {
    // Generate a random Cookie Code e.g. CRUM-123-456
    const part1 = Math.floor(100 + Math.random() * 900);
    const part2 = Math.floor(100 + Math.random() * 900);
    const cookieCode = `CRUM-${part1}-${part2}`;
    
    const initialFriends: Friend[] = [];

    const profile: KidProfile = { 
      name, 
      cookieCode,
      chatDisabled: false,
      callingDisabled: false,
      videoCallingDisabled: false,
      friends: initialFriends
    };

    // Add to kids list
    const kids = await this.getKidsList();
    kids.push(profile);
    await this.saveKidsList(kids);

    // If no active profile, set this one as active
    const active = await this.getKidProfile();
    if (!active) {
      await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(profile));
      await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(initialFriends));
    }

    return profile;
  },

  // Friends Management
  async getFriends(): Promise<Friend[]> {
    const data = await AsyncStorage.getItem(KEYS.FRIENDS);
    if (!data) {
      // Seed some initial friendly contacts for the demo
      const initialFriends: Friend[] = [];
      await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(initialFriends));
      
      return initialFriends;
    }
    return JSON.parse(data);
  },

  async addFriend(name: string, cookieCode: string): Promise<Friend> {
    const friends = await this.getFriends();
    
    // Check if friend already exists by code
    const existing = friends.find(f => f.cookieCode === cookieCode);
    if (existing) return existing;

    const randomEmoji = DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
    const newFriend: Friend = {
      id: Math.random().toString(36).substring(2, 9),
      name,
      cookieCode,
      avatarEmoji: randomEmoji,
    };

    const updated = [...friends, newFriend];
    await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(updated));

    // Also update the active kid's friends array inside the KIDS_LIST!
    const active = await this.getKidProfile();
    if (active) {
      const kids = await this.getKidsList();
      const updatedKids = kids.map(k => {
        if (k.cookieCode === active.cookieCode) {
          return {
            ...k,
            friends: updated
          };
        }
        return k;
      });
      await this.saveKidsList(updatedKids);
    }

    return newFriend;
  },

  // Message Management
  async getMessages(friendId: string): Promise<Message[]> {
    // 1. Load cached messages for instant display
    const cachedData = await AsyncStorage.getItem(`${KEYS.MESSAGES_PREFIX}${friendId}`);
    let messages: Message[] = cachedData ? JSON.parse(cachedData) : [];
    messages = messages.filter(m => m.text && !m.text.startsWith('[CALL_SIGNAL:'));

    // 2. Fetch fresh history from Supabase to sync
    try {
      const profile = await this.getKidProfile();
      const friends = await this.getFriends();
      const friend = friends.find(f => f.id === friendId);

      if (profile && friend) {
        const { data: dbMsgs, error } = await supabase
          .from('messages')
          .select('*')
          .or(`and(sender_code.eq.${profile.cookieCode},receiver_code.eq.${friend.cookieCode}),and(sender_code.eq.${friend.cookieCode},receiver_code.eq.${profile.cookieCode})`)
          .order('created_at', { ascending: true });

        if (!error && dbMsgs) {
          const fetchedMessages: Message[] = dbMsgs
            .filter(msg => msg.text && !msg.text.startsWith('[CALL_SIGNAL:'))
            .map(msg => ({
              id: msg.id,
              text: msg.text,
              timestamp: msg.created_at,
              sender: msg.sender_code === profile.cookieCode ? 'me' : 'them',
            }));

          // Overwrite local storage cache with latest data
          await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify(fetchedMessages));
          return fetchedMessages;
        } else if (error) {
          console.error("Error fetching messages from Supabase:", error);
        }
      }
    } catch (e) {
      console.error("Failed to sync messages with Supabase:", e);
    }

    return messages;
  },

  async getChatLogsForParent(kidCookieCode: string, friendCookieCode: string): Promise<Message[]> {
    try {
      const { data: dbMsgs, error } = await supabase
        .from('messages')
        .select('*')
        .or(`and(sender_code.eq.${kidCookieCode},receiver_code.eq.${friendCookieCode}),and(sender_code.eq.${friendCookieCode},receiver_code.eq.${kidCookieCode})`)
        .order('created_at', { ascending: true });

      if (!error && dbMsgs) {
        return dbMsgs
          .filter(msg => msg.text && !msg.text.startsWith('[CALL_SIGNAL:'))
          .map(msg => ({
            id: msg.id,
            text: msg.text,
            timestamp: msg.created_at,
            sender: msg.sender_code === kidCookieCode ? 'me' : 'them',
          }));
      } else if (error) {
        console.error("Error fetching logs for parent:", error);
      }
    } catch (e) {
      console.error("Failed to query parent chat logs:", e);
    }
    return [];
  },

  async sendMessage(friendId: string, text: string): Promise<Message> {
    const messages = await this.getMessages(friendId);
    const newMsgId = Math.random().toString(36).substring(2, 9);
    
    const newMsg: Message = {
      id: newMsgId,
      text,
      timestamp: new Date().toISOString(),
      sender: 'me',
    };

    const updated = [...messages, newMsg];
    await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify(updated));

    // Async write to Supabase
    try {
      const profile = await this.getKidProfile();
      const friends = await this.getFriends();
      const friend = friends.find(f => f.id === friendId);
      if (profile && friend) {
        await supabase
          .from('messages')
          .insert({
            id: newMsgId,
            sender_code: profile.cookieCode,
            receiver_code: friend.cookieCode,
            text: text,
            created_at: newMsg.timestamp
          });
      }
    } catch (e) {
      console.error("Error writing message to Supabase", e);
    }

    return newMsg;
  },

  async sendCallSignal(friendId: string, text: string): Promise<void> {
    try {
      const profile = await this.getKidProfile();
      const friends = await this.getFriends();
      const friend = friends.find(f => f.id === friendId);
      if (profile && friend) {
        const signalId = Math.random().toString(36).substring(2, 9);
        await supabase
          .from('messages')
          .insert({
            id: signalId,
            sender_code: profile.cookieCode,
            receiver_code: friend.cookieCode,
            text: text,
            created_at: new Date().toISOString()
          });
      }
    } catch (e) {
      console.error("Error sending call signal to Supabase", e);
    }
  },

  async receiveMockMessage(friendId: string, text: string): Promise<Message> {
    const messages = await this.getMessages(friendId);
    
    const newMsg: Message = {
      id: Math.random().toString(36).substring(2, 9),
      text,
      timestamp: new Date().toISOString(),
      sender: 'them',
    };

    const updated = [...messages, newMsg];
    await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify(updated));
    return newMsg;
  },

  async registerPushToken(token: string | null): Promise<void> {
    try {
      const profile = await this.getKidProfile();
      if (profile) {
        await supabase
          .from('profiles')
          .upsert({
            cookie_code: profile.cookieCode,
            push_token: token || null,
            name: profile.name
          });
      }
    } catch (e) {
      console.error("Error registering push token on Supabase", e);
    }
  },

  // Realtime subscription helper
  subscribeToMessages(onNewMessage: (msg: Message, friendId: string) => void): () => void {
    const channelId = Math.random().toString(36).substring(2, 9);
    const channel = supabase
      .channel(`public:messages:${channelId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        async (payload) => {
          const newRow = payload.new;
          const profile = await this.getKidProfile();
          if (!profile) return;

          const isSentByMe = newRow.sender_code === profile.cookieCode;
          const isReceivedByMe = newRow.receiver_code === profile.cookieCode;

          if (isSentByMe || isReceivedByMe) {
            const friends = await this.getFriends();
            const correspondingFriend = friends.find(f => 
              f.cookieCode === (isSentByMe ? newRow.receiver_code : newRow.sender_code)
            );

            if (correspondingFriend) {
              const localMsg: Message = {
                id: newRow.id,
                text: newRow.text,
                timestamp: newRow.created_at,
                sender: isSentByMe ? 'me' : 'them',
              };

              const isCallSignal = newRow.text && newRow.text.startsWith('[CALL_SIGNAL:');

              if (isCallSignal) {
                // Do not cache call signals in AsyncStorage. Just forward to listener
                onNewMessage(localMsg, correspondingFriend.id);
              } else {
                // Read AsyncStorage directly to check duplicates and avoid redundant API requests
                const data = await AsyncStorage.getItem(`${KEYS.MESSAGES_PREFIX}${correspondingFriend.id}`);
                const cachedMessages: Message[] = data ? JSON.parse(data) : [];

                if (!cachedMessages.find(m => m.id === localMsg.id)) {
                  const updated = [...cachedMessages, localMsg];
                  await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${correspondingFriend.id}`, JSON.stringify(updated));
                  onNewMessage(localMsg, correspondingFriend.id);
                }
              }
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  },

  async syncParentData(): Promise<void> {
    try {
      const email = await this.getParentEmail();
      if (!email) return;

      const subscribed = await this.isSubscribed();
      const parentPassword = await this.getParentPassword();
      const kids = await this.getKidsList();
      const activeProfile = await this.getKidProfile();
      const activeFriends = await this.getFriends();

      const kidsPayload = kids.map(k => {
        // If this is the active kid, use the latest friends list from storage
        const isCurrentActive = activeProfile?.cookieCode === k.cookieCode;
        const friendsList = isCurrentActive ? activeFriends : (k.friends || []);
        
        return {
          cookieCode: k.cookieCode,
          name: k.name,
          chatDisabled: !!k.chatDisabled,
          callingDisabled: !!k.callingDisabled,
          videoCallingDisabled: !!k.videoCallingDisabled,
          friends: friendsList.map((f: any) => ({
            id: f.id,
            name: f.name,
            cookieCode: f.cookieCode,
            avatarEmoji: f.avatarEmoji
          }))
        };
      });

      const displaySize = await AsyncStorage.getItem('crumbo_display_size') || 'default';
      const theme = await AsyncStorage.getItem('crumbo_theme') || 'light';

      const pushTokenPayload = JSON.stringify({
        subscribed,
        parentPassword,
        kids: kidsPayload,
        displaySize,
        theme
      });

      await supabase
        .from('profiles')
        .upsert({
          cookie_code: `PARENT:${email}`,
          push_token: pushTokenPayload,
          name: "6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19"
        });
    } catch (e) {
      console.error("Failed to sync parent settings to Supabase:", e);
      throw e;
    }
  },

  async fetchAndRestoreParentData(email: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('cookie_code', `PARENT:${email}`)
        .single();

      if (!error && data && data.push_token) {
        const payload = JSON.parse(data.push_token);
        
        await AsyncStorage.setItem(KEYS.IS_SUBSCRIBED, payload.subscribed ? 'true' : 'false');
        await AsyncStorage.setItem(KEYS.PARENT_EMAIL, email);

        if (payload.parentPassword) {
          await AsyncStorage.setItem(KEYS.PARENT_PASSWORD, payload.parentPassword);
        }

        if (payload.displaySize) {
          await AsyncStorage.setItem('crumbo_display_size', payload.displaySize);
        }

        if (payload.theme) {
          await AsyncStorage.setItem('crumbo_theme', payload.theme);
        }

        if (payload.kids && payload.kids.length > 0) {
          // Restore KIDS_LIST
          await AsyncStorage.setItem(KEYS.KIDS_LIST, JSON.stringify(payload.kids));
          
          // Decide which kid to activate on this device
          const currentActive = await this.getKidProfile();
          const matchInRestored = currentActive 
            ? payload.kids.find((k: any) => k.cookieCode === currentActive.cookieCode)
            : null;

          const kidToActivate = matchInRestored || payload.kids[0];
          
          const kidProfile: KidProfile = {
            name: kidToActivate.name,
            cookieCode: kidToActivate.cookieCode,
            chatDisabled: !!kidToActivate.chatDisabled,
            callingDisabled: !!kidToActivate.callingDisabled,
            videoCallingDisabled: !!kidToActivate.videoCallingDisabled
          };
          await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(kidProfile));

          if (kidToActivate.friends) {
            await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(kidToActivate.friends));
          } else {
            await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([]));
          }
        }
        return true;
      }
    } catch (e) {
      console.error("Failed to restore parent data from Supabase:", e);
    }
    return false;
  },

  async updateKidSettings(settings: { chatDisabled: boolean; callingDisabled: boolean; videoCallingDisabled: boolean }): Promise<void> {
    const profile = await this.getKidProfile();
    if (profile) {
      await this.updateKidSettingsForProfile(profile.cookieCode, settings);
    }
  },

  async sendCallLogMessage(friendId: string, text: string): Promise<Message> {
    const messages = await this.getMessages(friendId);
    const newMsgId = Math.random().toString(36).substring(2, 9);
    
    const newMsg: Message = {
      id: newMsgId,
      text,
      timestamp: new Date().toISOString(),
      sender: 'me',
    };

    const updated = [...messages, newMsg];
    await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}${friendId}`, JSON.stringify(updated));

    try {
      const profile = await this.getKidProfile();
      const friends = await this.getFriends();
      const friend = friends.find(f => f.id === friendId);
      if (profile && friend) {
        await supabase
          .from('messages')
          .insert({
            id: newMsgId,
            sender_code: profile.cookieCode,
            receiver_code: friend.cookieCode,
            text: text,
            created_at: newMsg.timestamp
          });
      }
    } catch (e) {
      console.error("Error writing call log to Supabase", e);
    }

    return newMsg;
  },

  async deleteKidProfile(cookieCode: string): Promise<void> {
    const kids = await this.getKidsList();
    const updatedKids = kids.filter(k => k.cookieCode !== cookieCode);
    await this.saveKidsList(updatedKids);

    // If the active profile is the one being deleted, switch active profile
    const active = await this.getKidProfile();
    if (active && active.cookieCode === cookieCode) {
      if (updatedKids.length > 0) {
        const nextActive = updatedKids[0];
        await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify({
          name: nextActive.name,
          cookieCode: nextActive.cookieCode,
          chatDisabled: !!nextActive.chatDisabled,
          callingDisabled: !!nextActive.callingDisabled,
          videoCallingDisabled: !!nextActive.videoCallingDisabled
        }));
        if (nextActive.friends) {
          await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(nextActive.friends));
        }
      } else {
        await AsyncStorage.removeItem(KEYS.KID_PROFILE);
        await AsyncStorage.removeItem(KEYS.FRIENDS);
      }
    }
  },

  async updateKidSettingsForProfile(
    cookieCode: string, 
    settings: { chatDisabled: boolean; callingDisabled: boolean; videoCallingDisabled: boolean }
  ): Promise<void> {
    const kids = await this.getKidsList();
    const updatedKids = kids.map(k => {
      if (k.cookieCode === cookieCode) {
        return {
          ...k,
          ...settings
        };
      }
      return k;
    });
    await this.saveKidsList(updatedKids);

    // If this is also the active kid, update the active KID_PROFILE storage as well
    const active = await this.getKidProfile();
    if (active && active.cookieCode === cookieCode) {
      await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify({
        ...active,
        ...settings
      }));
    }
  },

  async activateKidProfile(cookieCode: string): Promise<void> {
    const kids = await this.getKidsList();
    const target = kids.find(k => k.cookieCode === cookieCode);
    if (target) {
      await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify({
        name: target.name,
        cookieCode: target.cookieCode,
        chatDisabled: !!target.chatDisabled,
        callingDisabled: !!target.callingDisabled,
        videoCallingDisabled: !!target.videoCallingDisabled
      }));
      if (target.friends) {
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(target.friends));
      } else {
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([]));
      }
    }
  },



  async loginKidWithCode(cookieCode: string): Promise<KidProfile | null> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${cookieCode}"%`);

      if (error || !data || data.length === 0) {
        return null;
      }

      // Find the parent profile that actually OWNS this kid
      let targetKid = null;
      for (const parentProfile of data) {
        try {
          const payload = JSON.parse(parentProfile.push_token);
          if (payload && payload.kids) {
            const found = payload.kids.find((k: any) => k.cookieCode === cookieCode);
            if (found) {
              targetKid = found;
              break;
            }
          }
        } catch {}
      }

      if (targetKid) {
        const kidProfile: KidProfile = {
          name: targetKid.name,
          cookieCode: targetKid.cookieCode,
          chatDisabled: !!targetKid.chatDisabled,
          callingDisabled: !!targetKid.callingDisabled,
          videoCallingDisabled: !!targetKid.videoCallingDisabled
        };
        await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(kidProfile));
        await AsyncStorage.setItem(KEYS.IS_SUBSCRIBED, 'true');
        
        if (targetKid.friends) {
          await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(targetKid.friends));
        } else {
          await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([]));
        }

        return kidProfile;
      }
    } catch (e) {
      console.error("Error logging in kid with code:", e);
    }
    return null;
  },

  async logoutKid(): Promise<void> {
    await AsyncStorage.removeItem(KEYS.KID_PROFILE);
    await AsyncStorage.removeItem(KEYS.FRIENDS);
    await AsyncStorage.removeItem(KEYS.IS_SUBSCRIBED);
  },

  async syncKidProfileAndFriends(): Promise<KidProfile | null> {
    try {
      const active = await this.getKidProfile();
      if (!active) return null;

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${active.cookieCode}"%`);

      if (!error && data && data.length > 0) {
        // Find the parent profile that actually OWNS this kid
        let targetKid = null;
        for (const parentProfile of data) {
          try {
            const payload = JSON.parse(parentProfile.push_token);
            if (payload && payload.kids) {
              const found = payload.kids.find((k: any) => k.cookieCode === active.cookieCode);
              if (found) {
                targetKid = found;
                break;
              }
            }
          } catch {}
        }

        if (targetKid) {
          const updatedProfile: KidProfile = {
            name: targetKid.name,
            cookieCode: targetKid.cookieCode,
            chatDisabled: !!targetKid.chatDisabled,
            callingDisabled: !!targetKid.callingDisabled,
            videoCallingDisabled: !!targetKid.videoCallingDisabled
          };
          await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(updatedProfile));
          if (targetKid.friends) {
            await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(targetKid.friends));
          } else {
            await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([]));
          }
          return updatedProfile;
        }
      }
    } catch (e) {
      console.error("Failed to sync kid profile from Supabase:", e);
    }
    return null;
  },

  async addFriendToKidProfile(kidCookieCode: string, friendName: string, friendCookieCode: string): Promise<Friend> {
    const randomEmoji = DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
    const newFriend: Friend = {
      id: Math.random().toString(36).substring(2, 9),
      name: friendName,
      cookieCode: friendCookieCode,
      avatarEmoji: randomEmoji
    };

    // 1. Update friends list in the KIDS_LIST array
    const kids = await this.getKidsList();
    const updatedKids = kids.map(k => {
      if (k.cookieCode === kidCookieCode) {
        const friends = k.friends || [];
        if (!friends.some(f => f.cookieCode === friendCookieCode)) {
          return { ...k, friends: [...friends, newFriend] };
        }
      }
      return k;
    });
    await this.saveKidsList(updatedKids);

    // 2. If this is the active profile on this device, also update active KEYS.FRIENDS
    const active = await this.getKidProfile();
    if (active && active.cookieCode === kidCookieCode) {
      const activeFriends = await this.getFriends();
      if (!activeFriends.some(f => f.cookieCode === friendCookieCode)) {
        await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify([...activeFriends, newFriend]));
      }
    }

    return newFriend;
  },

  async removeFriendFromKidProfile(kidCookieCode: string, friendCookieCode: string): Promise<void> {
    // 1. Update in KIDS_LIST
    const kids = await this.getKidsList();
    const updatedKids = kids.map(k => {
      if (k.cookieCode === kidCookieCode) {
        const friends = k.friends || [];
        return { ...k, friends: friends.filter(f => f.cookieCode !== friendCookieCode) };
      }
      return k;
    });
    await this.saveKidsList(updatedKids);

    // 2. If active profile, also update KEYS.FRIENDS
    const active = await this.getKidProfile();
    if (active && active.cookieCode === kidCookieCode) {
      const activeFriends = await this.getFriends();
      await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(activeFriends.filter(f => f.cookieCode !== friendCookieCode)));
    }
  },

  async checkFriendPairingStatus(kidCookieCode: string, friendCookieCode: string): Promise<'paired' | 'pending'> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${friendCookieCode}"%`);

      if (error || !data || data.length === 0) {
        return 'pending';
      }

      // Find the parent profile that actually OWNS the friend (not just a parent who has added the friend as a buddy)
      let friendProfileInDb = null;
      for (const parentProfile of data) {
        try {
          const payload = JSON.parse(parentProfile.push_token);
          if (payload && payload.kids) {
            const found = payload.kids.find((k: any) => k.cookieCode === friendCookieCode);
            if (found) {
              friendProfileInDb = found;
              break;
            }
          }
        } catch {}
      }

      if (friendProfileInDb && friendProfileInDb.friends) {
        const isPaired = friendProfileInDb.friends.some((f: any) => f.cookieCode === kidCookieCode);
        if (isPaired) {
          return 'paired';
        }
      }
    } catch (e) {
      console.error("Error checking pairing status:", e);
    }
    return 'pending';
  },

  async pairKidsViaQRCode(kidCookieCode: string, kidName: string, friendCookieCode: string, friendName: string): Promise<boolean> {
    try {
      // 1. Find Friend's Parent Profile in Supabase
      const { data: parents, error } = await supabase
        .from('profiles')
        .select('*')
        .like('cookie_code', 'PARENT:%')
        .like('push_token', `%"cookieCode":"${friendCookieCode}"%`);

      if (error || !parents || parents.length === 0) {
        console.error("Could not find buddy's parent profile in Supabase");
        return false;
      }

      // Find the specific parent profile that contains this kid
      let targetParentRow = null;
      let targetPayload: any = null;
      for (const parent of parents) {
        try {
          const payload = JSON.parse(parent.push_token);
          if (payload && payload.kids && payload.kids.some((k: any) => k.cookieCode === friendCookieCode)) {
            targetParentRow = parent;
            targetPayload = payload;
            break;
          }
        } catch {}
      }

      if (!targetParentRow || !targetPayload) {
        console.error("Buddy's kid profile not found inside the parent payloads");
        return false;
      }

      // 2. Add Kid A (the scanner) to Kid B's (the scannee) friends list in their parent's profile
      const kidAEmoji = DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
      const newFriendForB = {
        id: Math.random().toString(36).substring(2, 9),
        name: kidName,
        cookieCode: kidCookieCode,
        avatarEmoji: kidAEmoji
      };

      const updatedFriendKids = targetPayload.kids.map((k: any) => {
        if (k.cookieCode === friendCookieCode) {
          const friends = k.friends || [];
          if (!friends.some((f: any) => f.cookieCode === kidCookieCode)) {
            return { ...k, friends: [...friends, newFriendForB] };
          }
        }
        return k;
      });

      targetPayload.kids = updatedFriendKids;

      // Upsert Friend's Parent Profile back to Supabase
      const { error: upsertError } = await supabase
        .from('profiles')
        .upsert({
          cookie_code: targetParentRow.cookie_code,
          push_token: JSON.stringify(targetPayload),
          name: targetParentRow.name
        });

      if (upsertError) {
        console.error("Failed to update buddy's parent profile:", upsertError);
        return false;
      }

      // 3. Add Kid B (the scannee) to Kid A's (the scanner) local friends list
      await this.addFriendToKidProfile(kidCookieCode, friendName, friendCookieCode);

      // 4. Sync Parent A's data back to Supabase
      await this.syncParentData();

      return true;
    } catch (e) {
      console.error("Error in QR pairing:", e);
      return false;
    }
  },

  // App Display Size
  async getDisplaySize(): Promise<'small' | 'default' | 'large'> {
    const size = await AsyncStorage.getItem('crumbo_display_size');
    if (size === 'small' || size === 'default' || size === 'large') {
      return size;
    }
    return 'default';
  },

  async saveDisplaySize(size: 'small' | 'default' | 'large'): Promise<void> {
    await AsyncStorage.setItem('crumbo_display_size', size);
  },

  // App Theme
  async getTheme(): Promise<'light' | 'dark'> {
    const theme = await AsyncStorage.getItem('crumbo_theme');
    if (theme === 'light' || theme === 'dark') {
      return theme;
    }
    return 'light';
  },

  async saveTheme(theme: 'light' | 'dark'): Promise<void> {
    await AsyncStorage.setItem('crumbo_theme', theme);
  },

  // Reset helper
  async clearAll(): Promise<void> {
    await AsyncStorage.clear();
  }
};

// A helper for simulated friend responses
const MOCK_ANSWERS: Record<string, string[]> = {
  general: [
    "That is so cool! 🌟",
    "Haha awesome! 👾",
    "Do you want to play a game later? 🎮",
    "Let's bake some cookies! 🍪🍪",
    "Look at this: 🦕 rawr!",
    "Wow, I love that! ❤️",
    "What are you doing today? 🎈",
    "I am building a lego castle right now 🧱"
  ]
};

export function triggerMockReply(
  friend: Friend,
  userMessageText: string,
  onReply: (msg: Message) => void
) {
  setTimeout(async () => {
    const list = MOCK_ANSWERS.general;
    const replyText = list[Math.floor(Math.random() * list.length)];

    const received = await StorageService.receiveMockMessage(friend.id, replyText);
    onReply(received);
  }, 1500); // 1.5 seconds typing lag for realism
}
