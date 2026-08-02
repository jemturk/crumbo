/* Supabase Edge Function: delete-account
 *
 * Permanently deletes a parent's entire account: every kid's own `profiles` row (name + push
 * token), all chat history and call signals either side of any of their cookie codes, any
 * photos/drawings they uploaded to the kid_media bucket, the parent's own `profiles` row
 * (cookie_code = PARENT:<email>), and finally their auth.users row. That last step needs
 * admin.deleteUser, which only works with the service-role key — never exposed to the client —
 * so this whole operation runs here instead of in storage.ts.
 *
 * The caller is identified from their own Supabase Auth session (the Authorization header
 * supabase-js forwards automatically on functions.invoke()), verified against the anon key
 * before any service-role client touches data — so one parent can never delete another
 * account by guessing an email.
 *
 * Deploy: supabase functions deploy delete-account
 * Env (auto-available in Edge runtime): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({ error: "Supabase environment not configured" }, 500);
    }

    // Verify who's actually calling using their own JWT (anon-key client) — never trust a
    // client-supplied email/id for something this destructive.
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData?.user?.email) {
      return json({ error: "Could not verify caller identity" }, 401);
    }

    const email = userData.user.email;
    const userId = userData.user.id;

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    // Find every kid cookie code under this parent so their data can be purged too.
    const { data: parentRow } = await admin
      .from("profiles")
      .select("push_token")
      .eq("cookie_code", `PARENT:${email}`)
      .single();

    let kidCodes: string[] = [];
    if (parentRow?.push_token) {
      try {
        const payload = JSON.parse(parentRow.push_token);
        kidCodes = (payload?.kids || [])
          .map((k: { cookieCode?: string }) => k.cookieCode)
          .filter((c: string | undefined): c is string => !!c);
      } catch {
        // Malformed payload — nothing to salvage, still proceed to delete the parent row itself.
      }
    }

    for (const code of kidCodes) {
      await admin.from("messages").delete().eq("sender_code", code);
      await admin.from("messages").delete().eq("receiver_code", code);
      await admin.from("call_signals").delete().eq("sender_code", code);
      await admin.from("call_signals").delete().eq("receiver_code", code);
      // Kid-sent photos/drawings live under `${cookieCode}/...` in the kid_media bucket
      // (see supabase/migrations/20260801000000_kid_media_bucket.sql).
      const { data: files } = await admin.storage.from("kid_media").list(code);
      if (files && files.length > 0) {
        await admin.storage.from("kid_media").remove(files.map((f: { name: string }) => `${code}/${f.name}`));
      }
      // Each kid also has their own profiles row (push token registration) keyed by their raw
      // cookie code, separate from the parent's aggregate PARENT:<email> row.
      await admin.from("profiles").delete().eq("cookie_code", code);
    }

    await admin.from("profiles").delete().eq("cookie_code", `PARENT:${email}`);

    const { error: deleteUserError } = await admin.auth.admin.deleteUser(userId);
    if (deleteUserError) {
      return json({ error: deleteUserError.message }, 500);
    }

    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
