/* Supabase Edge Function: notify-call
 *
 * Sends a high-priority Expo push so an incoming call rings a backgrounded/killed
 * Android app. The device's background notification task (see src/services/callkeep.ts,
 * CRUMBO_CALLKEEP_BACKGROUND_NOTIFICATION_TASK) turns the push into a native CallKeep
 * incoming-call screen for START_* signals, and tears the screen down for END/DECLINE/CANCEL.
 *
 * Realtime (the call_signals table) already delivers signals to a foregrounded receiver;
 * this function exists purely to wake a receiver that is NOT currently connected.
 *
 * Deploy: supabase functions deploy notify-call
 * Env (auto-available in Edge runtime): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

// Supabase Edge Functions run on Deno – declare globals for the Node TS server.
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
  env: { get(key: string): string | undefined };
};
// @ts-ignore: npm: specifier is valid Deno syntax (Supabase Edge Functions runtime)
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type SignalType =
  | "START_AUDIO_CALL"
  | "START_VIDEO_CALL"
  | "ACCEPT_CALL"
  | "DECLINE_CALL"
  | "END_CALL"
  | "CANCEL_CALL";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      receiverCode,
      senderCode,
      callUUID,
      type,
      senderName,
      roomName,
      isVideo,
    }: {
      receiverCode?: string;
      senderCode?: string;
      callUUID?: string;
      type?: SignalType;
      senderName?: string;
      roomName?: string;
      isVideo?: boolean;
    } = await req.json();

    if (!receiverCode || !senderCode || !callUUID || !type) {
      return json({ error: "receiverCode, senderCode, callUUID and type are required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return json({ error: "Supabase environment not configured" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // The receiver's raw Expo push token is stored on their own profile row
    // (StorageService.registerPushToken upserts { cookie_code, push_token }).
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("push_token")
      .eq("cookie_code", receiverCode)
      .single();

    if (error || !profile?.push_token) {
      // Not an error for the caller: the receiver just has no push token registered.
      return json({ delivered: false, reason: "no push token for receiver" });
    }

    const expoToken: string = profile.push_token;
    if (!expoToken.startsWith("ExponentPushToken") && !expoToken.startsWith("ExpoPushToken")) {
      return json({ delivered: false, reason: "receiver row has no Expo push token" });
    }

    // The receiver resolves which friend is calling from sender_code, and reads the call
    // details from the same fields parseCallSignalText() understands on the client.
    const signalData = {
      type,
      callSignal: type,
      callUUID,
      roomName: roomName ?? null,
      callerName: senderName ?? null,
      friendName: senderName ?? null,
      isVideo: !!isVideo,
      sender_code: senderCode,
    };

    // Build the Expo push message. This is deliberately data-only — no title, no body, and
    // critically NO channelId — for every signal type, START included.
    //
    // Confirmed on-device (adb logcat + dumpsys notification): any display-related field
    // (title/body, and channelId too) makes Expo's relay emit an FCM `notification` block.
    // When that block is present, Google Play Services displays the notification itself and
    // NEVER invokes the app's FirebaseMessagingService — so the background task, CallKeep,
    // and the native full-screen call UI are all silently bypassed (the "blank banner" bug).
    // A pure data message with priority:"high" is what actually wakes the app to run
    // CRUMBO_CALLKEEP_BACKGROUND_NOTIFICATION_TASK and build the real incoming-call UI;
    // the notification channel is chosen on-device by the native module.
    const message: Record<string, unknown> = {
      to: expoToken,
      priority: "high",
      data: signalData,
      contentAvailable: true, // iOS background delivery hint; no effect on Android
      ttl: 30, // a ring (or its teardown) is only meaningful for ~30s
    };

    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(message),
    });

    const result = await res.json();
    return json({ delivered: res.ok, expo: result });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
