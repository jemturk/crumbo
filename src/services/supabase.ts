import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Supabase credentials missing! Please configure them in your .env file.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Parent sign-in/registration uses real Supabase Auth (see parent/gate.tsx) — kids still
    // authenticate via cookie codes directly, with no session of their own.
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    // 'pkce' puts the reset-password link's token in a `?code=` query param instead of a URL
    // fragment (the 'implicit' flow's `#access_token=...`) — expo-router's search params parse
    // query strings natively, so this avoids hand-parsing a URL fragment in reset-password.tsx.
    flowType: 'pkce',
    // RN has no browser URL bar for the library to auto-detect a session from; the
    // reset-password screen calls exchangeCodeForSession itself instead.
    detectSessionInUrl: false,
  }
});
