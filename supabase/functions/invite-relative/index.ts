/* Supabase Edge Function: invite-relative
 *
 * A parent wants a relative (grandparent, aunt/uncle, second parent, etc. — anyone who isn't
 * this kid's OWN registered parent) to be able to chat with their kid, and that relative doesn't
 * have a Crumbo account yet. Sends them a real invite email via Supabase's own admin invite flow
 * (the same "set a password" link as password recovery — see src/app/reset-password.tsx, reused
 * as-is for accepting this invite too) and stashes the pending kid link in that user's own
 * metadata so it can be completed once they actually finish signing up — see
 * StorageService.completePendingRelativeLinks, called from gate.tsx after every sign-in.
 *
 * This needs admin.inviteUserByEmail / admin.updateUserById, which only work with the
 * service-role key — never exposed to the client — so it runs here instead of in storage.ts.
 * The caller is identified from their own Supabase Auth session, same pattern as delete-account.
 *
 * Deploy: supabase functions deploy invite-relative
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

    // Verify who's actually calling using their own JWT — an invite is sent "from" whoever is
    // authenticated right now, not whatever email the client claims.
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: callerData, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !callerData?.user?.email) {
      return json({ error: "Could not verify caller identity" }, 401);
    }

    const { email, kidCookieCode, kidName, kidAvatarEmoji, relativeDisplayName } = await req.json();
    if (!email || !kidCookieCode || !kidName) {
      return json({ error: "email, kidCookieCode and kidName are required" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const newLink = { cookieCode: kidCookieCode, name: kidName, avatarEmoji: kidAvatarEmoji };

    // inviteUserByEmail fails if this email already has an (even unconfirmed) auth user — e.g.
    // invited previously by a different family, still pending. In that case, merge this link
    // into their existing pendingRelativeLinks instead of erroring out.
    const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      // Points at the reset-password page, not the bare crumbo:// scheme — see that page's own
      // comment. It redirects into the app on a device that has it, and falls back to an
      // in-browser "set your password" form everywhere else (PC, no app installed). Hosted on
      // GitHub Pages, not as a Supabase Edge Function — see docs/reset-password.html's comment
      // for why (Supabase's edge gateway can't actually serve HTML to a real browser).
      redirectTo: 'https://jemturk.github.io/crumbo/reset-password.html',
      data: { pendingRelativeLinks: [newLink], invitedAs: relativeDisplayName || kidName },
    });

    if (!inviteError) {
      return json({ success: true, userId: inviteData.user.id, alreadyExisted: false });
    }

    // Fall back to finding the existing (still-unconfirmed) user and merging the link in.
    const { data: existingList, error: listError } = await admin.auth.admin.listUsers();
    if (listError) {
      return json({ error: inviteError.message || "Failed to invite relative" }, 500);
    }
    const existingUser = existingList.users.find((u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase());
    if (!existingUser) {
      return json({ error: inviteError.message || "Failed to invite relative" }, 500);
    }

    const existingLinks: { cookieCode: string; name: string; avatarEmoji?: string }[] =
      existingUser.user_metadata?.pendingRelativeLinks || [];
    const alreadyPending = existingLinks.some((l) => l.cookieCode === kidCookieCode);
    const mergedLinks = alreadyPending ? existingLinks : [...existingLinks, newLink];

    const { error: updateError } = await admin.auth.admin.updateUserById(existingUser.id, {
      user_metadata: { ...existingUser.user_metadata, pendingRelativeLinks: mergedLinks },
    });
    if (updateError) {
      return json({ error: updateError.message }, 500);
    }

    return json({ success: true, userId: existingUser.id, alreadyExisted: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
