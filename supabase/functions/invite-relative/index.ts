/* Supabase Edge Function: invite-relative
 *
 * A parent wants a relative (grandparent, aunt/uncle, second parent, etc. — anyone who isn't this
 * kid's OWN registered parent) to be able to chat with their kid, and that relative doesn't have
 * a Crumbo account yet. rpc_add_relative_to_kid has already parked the pending link in
 * pending_relative_links, keyed by email; this function's only job is telling the person about it.
 *
 * It deliberately does NOT create an account for them. The previous version called
 * admin.inviteUserByEmail, and that one choice forced everything awkward about the old flow: the
 * invitee ended up with a passwordless account they had to *claim* rather than sign up for,
 * claiming meant proving inbox control, and that meant typing a 6-digit code out of an email.
 * Worse, the half-made account then collided with any later invite to the same address, which is
 * why this function used to carry a delete-and-reinvite workaround. Now the invitee simply
 * installs Crumbo and registers normally, and rpc_claim_pending_relative_links attaches the kid
 * on their first sign-in — see StorageService.claimPendingRelativeLinks.
 *
 * Because this is no longer an auth event, GoTrue won't send it: the mail goes out through Resend
 * directly. That also puts this email outside GoTrue's template engine, which is a feature —
 * see supabase/templates/invite.html's history for the two silent traps (an empty double-brace
 * action falling back to the stock default, and a cached template surviving a config push) that
 * cost a full debugging session.
 *
 * Deploy: supabase functions deploy invite-relative
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto), RESEND_API_KEY (set via
 *      `supabase secrets set RESEND_API_KEY=...`)
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

// Matches the SMTP identity the auth emails already send as, so an invite doesn't arrive from a
// different-looking sender than the confirmation/recovery mail (see config.toml's auth.email.smtp).
const FROM = "Crumbo <noreply@revynd.com>";
const PLAY_STORE_URL = "https://play.google.com/apps/internaltest/4700663189064785694";
// Google's own hosted copy of the official badge, so it always matches current Play branding. Its
// 646x250 source already contains the clear space the badge guidelines require around the artwork,
// so scaling the whole asset (to 180x70, the same 2.584 ratio) keeps that spacing correct — never
// crop it, and never pull it upward with a negative margin. Many mail clients block remote images,
// hence alt text that reads as the badge's own wording.
const PLAY_BADGE_URL =
  "https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Same cream-card visual language as the confirmation/recovery templates. Inlined here rather than
 * read from supabase/templates/ because this is no longer a GoTrue template — nothing would
 * substitute values into it, and an edge function can't reliably read repo files at runtime.
 * Every interpolated value is escaped: inviterName and kidName are user-supplied.
 */
function inviteEmailHtml(inviterName: string, kidName: string, inviteeEmail: string): string {
  const inviter = escapeHtml(inviterName);
  const kid = escapeHtml(kidName);
  const email = escapeHtml(inviteeEmail);
  return `<div style="background-color:#FFFDF3;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border:2px solid #FFF5D1;border-radius:24px;padding:32px;text-align:center;">
    <div style="font-size:48px;line-height:1;margin-bottom:8px;">👋</div>
    <h1 style="color:#4E342E;font-size:22px;margin:0 0 12px;">You've Been Invited!</h1>
    <p style="color:#8D6E63;font-size:15px;line-height:22px;margin:0 0 20px;">
      ${inviter} added you to ${kid}'s friends list on Crumbo — a small, parent-controlled chat app for kids.
    </p>
    <p style="color:#8D6E63;font-size:15px;line-height:22px;margin:0 0 4px;">
      Get the app and sign up with <strong style="color:#4E342E;">${email}</strong>, and ${kid} will be waiting in your chat list.
    </p>
    <p style="color:#8D6E63;font-size:13px;line-height:20px;margin:24px 0 0;">
      Don't have the app yet?
    </p>
    <a href="${PLAY_STORE_URL}" style="display:inline-block;line-height:0;">
      <img src="${PLAY_BADGE_URL}" alt="Get it on Google Play" width="180" height="70" style="border:0;display:block;" />
    </a>
    <p style="color:#8D6E63;font-size:13px;line-height:20px;margin:20px 0 0;">
      Already have Crumbo? Just sign in with that address.
    </p>
    <p style="color:#A1887F;font-size:12px;margin-top:24px;">
      If you weren't expecting this invite, you can safely ignore this email.
    </p>
  </div>
</div>`;
}

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
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json({ error: "Supabase environment not configured" }, 500);
    }
    if (!resendKey) {
      return json({ error: "RESEND_API_KEY is not configured" }, 500);
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

    const { email, kidCookieCode, kidName } = await req.json();
    if (!email || !kidCookieCode || !kidName) {
      return json({ error: "email, kidCookieCode and kidName are required" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Only tell the invitee about a link that genuinely exists. rpc_add_relative_to_kid writes it
    // (as the caller, ownership-checked) immediately before this is invoked, so its absence means
    // that call didn't happen or didn't apply to this pair — in which case an email promising a
    // waiting kid would simply be wrong.
    const { data: pending } = await admin
      .from("pending_relative_links")
      .select("kid_name")
      .eq("email", String(email).toLowerCase())
      .eq("kid_cookie_code", kidCookieCode)
      .maybeSingle();
    if (!pending) {
      return json({ error: "No pending invite for this address and kid" }, 409);
    }

    // The caller's own preferred display name, for a personal "Jem added you..." instead of a raw
    // email address. A PARENT: row's `name` COLUMN is a fixed sentinel — the real display name
    // lives inside push_token's JSON as parentName (see StorageService.syncParentData).
    const { data: callerProfile } = await admin
      .from("profiles")
      .select("push_token")
      .eq("cookie_code", `PARENT:${callerData.user.email}`)
      .maybeSingle();
    let inviterName = callerData.user.email;
    try {
      const callerPayload = JSON.parse(callerProfile?.push_token || "{}");
      if (typeof callerPayload?.parentName === "string" && callerPayload.parentName.trim()) {
        inviterName = callerPayload.parentName.trim();
      }
    } catch {
      // Not JSON, or no row yet — keep the email fallback.
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: `${inviterName} invited you to chat with ${kidName} on Crumbo 👋`,
        html: inviteEmailHtml(inviterName as string, kidName, email),
      }),
    });

    const result = await res.json();
    if (!res.ok) {
      console.error("Resend rejected the invite email:", JSON.stringify(result));
      return json({ error: "Could not send the invite email", detail: result }, 502);
    }

    return json({ success: true, id: result?.id ?? null });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
