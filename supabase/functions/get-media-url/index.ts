/* Supabase Edge Function: get-media-url
 *
 * kid_media (photos, drawings, voice messages sent in chat) was a PUBLIC bucket — anyone with
 * the exact file URL could view it with zero authentication, bypassing RLS entirely. That's a
 * third way to read sensitive data beyond "legitimate kid/parent privileges" or "a stolen parent
 * password" — closed by making the bucket private and issuing short-lived signed URLs through
 * here instead of permanent public links.
 *
 * Authorization: the caller must either be the file's own uploader (its path is always
 * `${uploaderCookieCode}/...`, see compressAndUploadImage/uploadAudioMessage in storage.ts), or
 * have exchanged at least one message with that uploader — i.e. actually be a party to the
 * conversation the media was sent in, not just anyone who obtained the path/URL some other way.
 *
 * Deploy: supabase functions deploy get-media-url --use-api
 * Env (auto-available in Edge runtime): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const SIGNED_URL_TTL_SECONDS = 600; // 10 minutes — long enough for a chat screen session, short enough that a leaked link goes stale quickly

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const { path }: { path?: string } = await req.json();
    if (!path || typeof path !== "string") {
      return json({ error: "path is required" }, 400);
    }

    // Path is always `${uploaderCookieCode}/${filename}` — reject anything that doesn't look
    // like that shape before ever touching storage, rather than passing an arbitrary string
    // straight to createSignedUrl.
    const slashIndex = path.indexOf("/");
    if (slashIndex <= 0 || path.includes("..")) {
      return json({ error: "Invalid path" }, 400);
    }
    const ownerCode = path.slice(0, slashIndex);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({ error: "Supabase environment not configured" }, 500);
    }

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

    const callerCode = callerProfile?.cookie_code;
    if (!callerCode) {
      return json({ error: "No profile associated with this session" }, 403);
    }

    let authorized = callerCode === ownerCode;
    if (!authorized) {
      const { count } = await admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .or(
          `and(sender_code.eq.${ownerCode},receiver_code.eq.${callerCode}),and(sender_code.eq.${callerCode},receiver_code.eq.${ownerCode})`
        );
      authorized = !!count && count > 0;
    }

    if (!authorized) {
      return json({ error: "Not authorized to view this file" }, 403);
    }

    const { data: signed, error: signError } = await admin.storage
      .from("kid_media")
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);

    if (signError || !signed?.signedUrl) {
      return json({ error: signError?.message || "Failed to sign URL" }, 500);
    }

    return json({ url: signed.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
