import { GoogleSignin, isCancelledResponse, statusCodes } from '@react-native-google-signin/google-signin';
import { supabase } from './supabase';

let configured = false;

// GoogleSignin.configure() only needs to run once per app launch — deferred to first use
// (rather than at module load / app startup) so it never runs before .env vars are available.
function ensureConfigured() {
  if (configured) return;
  GoogleSignin.configure({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  });
  configured = true;
}

export type GoogleAuthResult =
  | { status: 'success'; email: string; name: string | null }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Native Google Sign-In → Supabase session, in one call. Works for both sign-in AND
 * registration — signInWithIdToken creates the auth user on first use, same as any other
 * Supabase OAuth provider, so gate.tsx doesn't need a separate "register with Google" path.
 * Requires EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID (see .env) and Supabase's Google provider to both be
 * configured with the same Google Cloud "Web application" OAuth client — see .env for the full
 * external setup this depends on.
 */
export async function signInWithGoogle(): Promise<GoogleAuthResult> {
  ensureConfigured();
  try {
    await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();
    if (isCancelledResponse(response)) {
      return { status: 'cancelled' };
    }

    const { idToken, user } = response.data;
    if (!idToken) {
      return { status: 'error', message: 'Google did not return an ID token — check that EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is set correctly.' };
    }

    const { data, error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
    if (error || !data.user?.email) {
      return { status: 'error', message: error?.message || 'Could not sign in with Google.' };
    }

    return { status: 'success', email: data.user.email, name: user.name };
  } catch (e: any) {
    if (e?.code === statusCodes.SIGN_IN_CANCELLED) {
      return { status: 'cancelled' };
    }
    console.error('[GoogleAuth] Sign-in failed:', e);
    return { status: 'error', message: e?.message || 'Google sign-in failed.' };
  }
}
