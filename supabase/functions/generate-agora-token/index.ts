/* Supabase Edge Function: generate-agora-token
 *
 * Issues an Agora RTC token for a call channel. Previously had NO caller verification at all —
 * any request (even fully anonymous, before this project even had anonymous auth) got a valid
 * PUBLISHER token for whatever channelName it asked for. Combined with the channel name being
 * fully deterministic (`CrumboCall_<kidCode>_<friendCode>`, see use-call.ts) and cookie codes
 * being a small guessable space (3 numeric digits each), this meant anyone could compute a real
 * call's channel name and get a token to join and transmit into it — a live eavesdropping/
 * hijacking path, not just a data leak. Fixed by requiring a real session and verifying the
 * caller's own cookie_code is actually embedded in the channel name they're requesting a token
 * for, mirroring the ownership checks used throughout the RLS/RPC work.
 *
 * Deploy: supabase functions deploy generate-agora-token
 * Env (auto-available in Edge runtime): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

// Supabase Edge Functions run on Deno – declare globals for the Node TS server
declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
  env: { get(key: string): string | undefined };
};
// @ts-ignore: npm: specifier is valid Deno syntax (Supabase Edge Functions runtime)
import { RtcTokenBuilder, RtcRole } from "npm:agora-access-token";
// @ts-ignore: npm: specifier is valid Deno syntax (Supabase Edge Functions runtime)
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  // Handle CORS preflight options
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({ error: "Supabase environment not configured" }, 500);
    }

    // Verify who's actually calling using their own JWT — never trust a client-supplied
    // channelName as proof of who's allowed into it. Works for both real parent sessions and
    // anonymous kid sessions, since both carry a real auth.uid().
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

    if (!callerProfile?.cookie_code) {
      return json({ error: "No profile associated with this session" }, 403);
    }

    const appId = Deno.env.get("AGORA_APP_ID");
    const appCertificate = Deno.env.get("AGORA_APP_CERTIFICATE");

    if (!appId || !appCertificate) {
      return json({ error: "Agora credentials (AGORA_APP_ID / AGORA_APP_CERTIFICATE) are not set in Supabase secrets." }, 500);
    }

    const { channelName, uid, role } = await req.json();

    if (!channelName) {
      return json({ error: "channelName is required" }, 400);
    }
    if (!uid) {
      return json({ error: "uid is required" }, 400);
    }

    // The channel name is always `CrumboCall_<codeA>_<codeB>` with every `-` swapped for `_`
    // (see use-call.ts). Requiring the caller's own (equally transformed) cookie code to appear
    // in it is exactly "am I one of this call's two parties" — only two people ever have their
    // code embedded in a given channel name.
    const myTransformedCode = callerProfile.cookie_code.replace(/-/g, "_");
    if (typeof channelName !== "string" || !channelName.includes(myTransformedCode)) {
      return json({ error: "Not authorized for this call channel" }, 403);
    }

    const expirationTimeInSeconds = 3600; // Token valid for 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      role === "publisher" ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
      privilegeExpiredTs
    );

    return json({ token });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
