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
}

// Storage keys
const KEYS = {
  PARENT_EMAIL: 'crumbo_parent_email',
  IS_SUBSCRIBED: 'crumbo_is_subscribed',
  KID_PROFILE: 'crumbo_kid_profile',
  FRIENDS: 'crumbo_friends',
  MESSAGES_PREFIX: 'crumbo_messages_',
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

  async isSubscribed(): Promise<boolean> {
    const status = await AsyncStorage.getItem(KEYS.IS_SUBSCRIBED);
    return status === 'true';
  },

  async setSubscribed(subscribed: boolean): Promise<void> {
    await AsyncStorage.setItem(KEYS.IS_SUBSCRIBED, subscribed ? 'true' : 'false');
  },

  // Kid Profile
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
    
    const profile: KidProfile = { name, cookieCode };
    await AsyncStorage.setItem(KEYS.KID_PROFILE, JSON.stringify(profile));
    return profile;
  },

  // Friends Management
  async getFriends(): Promise<Friend[]> {
    const data = await AsyncStorage.getItem(KEYS.FRIENDS);
    if (!data) {
      // Seed some initial friendly contacts for the demo
      const initialFriends: Friend[] = [
        { id: '1', name: 'Alex', cookieCode: 'CRUM-482-195', avatarEmoji: '🍪' },
        { id: '2', name: 'Chloe', cookieCode: 'CRUM-721-394', avatarEmoji: '🧁' },
        { id: '3', name: 'Danny', cookieCode: 'CRUM-889-204', avatarEmoji: '🦕' },
      ];
      await AsyncStorage.setItem(KEYS.FRIENDS, JSON.stringify(initialFriends));
      
      // Seed initial messages for Alex as shown in mockup
      const alexMessages: Message[] = [
        { id: 'm1', text: 'Hey! I finished that drawing 🎨', timestamp: new Date(Date.now() - 3 * 60 * 1000).toISOString(), sender: 'them' },
      ];
      await AsyncStorage.setItem(`${KEYS.MESSAGES_PREFIX}1`, JSON.stringify(alexMessages));
      
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
    return newFriend;
  },

  // Message Management
  async getMessages(friendId: string): Promise<Message[]> {
    // 1. Load cached messages for instant display
    const cachedData = await AsyncStorage.getItem(`${KEYS.MESSAGES_PREFIX}${friendId}`);
    let messages: Message[] = cachedData ? JSON.parse(cachedData) : [];

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
          const fetchedMessages: Message[] = dbMsgs.map(msg => ({
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
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
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
  ],
  alex: [
    "Yeah, uploading now 🖌️",
    "Got it! Let me know if you like the details!",
    "Thanks! It took me like an hour to sketch 🎨",
    "Let's draw together tomorrow! ✏️"
  ]
};

export function triggerMockReply(
  friend: Friend,
  userMessageText: string,
  onReply: (msg: Message) => void
) {
  setTimeout(async () => {
    let replyText = "";
    const lowercaseMsg = userMessageText.toLowerCase();

    if (friend.name.toLowerCase() === 'alex') {
      if (lowercaseMsg.includes('drawing') || lowercaseMsg.includes('send')) {
        replyText = MOCK_ANSWERS.alex[0]; // "Yeah, uploading now 🖌️"
      } else if (lowercaseMsg.includes('love') || lowercaseMsg.includes('colors') || lowercaseMsg.includes('got it')) {
        replyText = "Thanks! It took me like an hour to sketch 🎨";
      } else {
        const list = MOCK_ANSWERS.alex;
        replyText = list[Math.floor(Math.random() * list.length)];
      }
    } else {
      const list = MOCK_ANSWERS.general;
      replyText = list[Math.floor(Math.random() * list.length)];
    }

    const received = await StorageService.receiveMockMessage(friend.id, replyText);
    onReply(received);
  }, 1500); // 1.5 seconds typing lag for realism
}
