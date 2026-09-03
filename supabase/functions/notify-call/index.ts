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
 * Previously had NO caller verification at all — any request, from anyone, could claim any
 * senderCode and push a fake "incoming call" to any receiverCode, or use the delivered/reason
 * response to probe whether a given cookie code has an active push token registered. Fixed by
 * requiring a real session and verifying the caller actually owns the senderCode they're
 * claiming — the same ownership check call_signals' own RLS insert policy already enforces, kept
 * consistent here since this function does on the caller's behalf what that insert does.
 *
 * Deploy: supabase functions deploy notify-call
 * Env (auto-available in Edge runtime): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

// Supabase Edge Functions run on Deno – declare globals for the Node TS server.
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
  env: { get(key: string): string | undefined };
};
// Lets a background task (the delayed receipt check below) keep running after the response
// is already sent back to the caller, instead of blocking the caller on it.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({ error: "Supabase environment not configured" }, 500);
    }

    // Verify who's actually calling, and that they own the senderCode they're claiming — never
    // trust a client-supplied senderCode as proof of identity.
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData?.user?.id) {
      return json({ error: "Could not verify caller identity" }, 401);
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { data: callerProfile } = await admin
      .from("profiles")
      .select("cookie_code")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (!callerProfile?.cookie_code || callerProfile.cookie_code !== senderCode) {
      return json({ error: "Not authorized to send as this senderCode" }, 403);
    }

    // The receiver's raw Expo push token is stored on their own profile row — for a kid row
    // that's StorageService.registerPushToken's plain upsert (push_token IS the token). A
    // parent/relative row's push_token column instead holds their whole kids/friends JSON
    // payload (see buildParentPushTokenPayload), with the token nested at payload.pushToken
    // (StorageService.registerParentPushToken) — so a row can't be identified by shape alone
    // without trying both.
    const { data: profile, error } = await admin
      .from("profiles")
      .select("push_token")
      .eq("cookie_code", receiverCode)
      .single();

    if (error || !profile?.push_token) {
      // Not an error for the caller: the receiver just has no push token registered.
      return json({ delivered: false, reason: "no push token for receiver" });
    }

    const raw: string = profile.push_token;
    const isRawToken = (value: string) => value.startsWith("ExponentPushToken") || value.startsWith("ExpoPushToken");

    let expoToken: string | null = null;
    if (isRawToken(raw)) {
      expoToken = raw;
    } else {
      try {
        const payload = JSON.parse(raw);
        if (typeof payload?.pushToken === "string" && isRawToken(payload.pushToken)) {
          expoToken = payload.pushToken;
        }
      } catch {
        // Not JSON either — genuinely not a token.
      }
    }

    if (!expoToken) {
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
    // A 200 here only means Expo's relay accepted the request — it says nothing about the
    // actual push. The real per-message outcome is this ticket's own status; `res.ok` alone
    // previously made `delivered: true` a lie for a rejected ticket (e.g. a malformed token).
    const ticket = Array.isArray(result?.data) ? result.data[0] : result?.data;
    const ticketOk = res.ok && ticket?.status === "ok";
    const logTag = `${type} → ${receiverCode} (callUUID=${callUUID})`;

    if (!ticketOk) {
      console.error(`[notify-call] Push ticket error for ${logTag}:`, JSON.stringify(ticket ?? result));
    } else if (ticket?.id) {
      // A ticket status of "ok" only means Expo accepted the token's shape — it does NOT mean
      // the push actually reached the device. The real delivery outcome (e.g.
      // "DeviceNotRegistered" for a stale/invalid token after a reinstall or revoked
      // notification permission) only shows up later via getReceipts, and until now nothing
      // ever checked it — a receiver stuck with a dead token silently never rang, forever, with
      // no error anywhere. Runs after the response is already sent so it doesn't hold up the
      // caller; Expo recommends waiting before the receipt is ready, 15s is a practical middle
      // ground for a value that's purely diagnostic here (logged, not acted on).
      const ticketId = ticket.id;
      EdgeRuntime.waitUntil(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 15000));
          try {
            const receiptRes = await fetch("https://exp.host/--/api/v2/push/getReceipts", {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ ids: [ticketId] }),
            });
            const receiptResult = await receiptRes.json();
            const receipt = receiptResult?.data?.[ticketId];
            if (receipt?.status === "error") {
              console.error(`[notify-call] Push receipt error for ${logTag}:`, JSON.stringify(receipt));
            } else {
              console.log(`[notify-call] Push receipt ok for ${logTag}`);
            }
          } catch (e) {
            console.error(`[notify-call] Failed to check push receipt for ${logTag}:`, e);
          }
        })()
      );
    }

    return json({ delivered: ticketOk, expo: result });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
