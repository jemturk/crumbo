/* Supabase Edge Function: invite-relative
 *
 * Tells a relative (grandparent, aunt/uncle, second parent — anyone who isn't this kid's OWN
 * registered parent) that they've been connected to a kid. Two cases, both reaching here:
 *
 *  - NO ACCOUNT YET (`linked` false/absent): rpc_add_relative_to_kid has parked the link in
 *    pending_relative_links, keyed by email. They get an email pointing at the Play Store; they
 *    install Crumbo and register completely normally, and rpc_claim_pending_relative_links
 *    attaches the kid on their first sign-in.
 *
 *  - ALREADY HAS AN ACCOUNT (`linked` true): rpc_add_relative_to_kid has already written the kid
 *    straight into their profile's friends[], so the kid simply appears next time their chat list
 *    loads. They need to DO nothing — which is exactly why they get told: previously this path
 *    sent nothing at all, so the person best able to act immediately was the one told least, and
 *    the kid just silently materialised in their list. They get both an email and a push, since
 *    an existing account means an installed app worth waking.
 *
 * This function deliberately does NOT create accounts. Its predecessor called
 * admin.inviteUserByEmail, and that one choice forced everything awkward about the old flow: a
 * passwordless account that had to be *claimed* rather than signed up for, claiming meant proving
 * inbox control, and that meant typing a 6-digit code out of an email. It also collided with any
 * later invite to the same address, hence a delete-and-reinvite workaround that no longer exists.
 *
 * Mail goes through Resend directly rather than GoTrue, because none of this is an auth event any
 * more. That also keeps these emails clear of GoTrue's template engine, which cost a full session
 * to two silent traps: an empty double-brace action falling back to the stock default template,
 * and a cached template surviving a config push.
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

// Matches the SMTP identity the auth emails already send as, so these don't arrive from a
// different-looking sender than confirmation/recovery mail (see config.toml's auth.email.smtp).
const FROM = "Crumbo <noreply@revynd.com>";
const PLAY_STORE_URL = "https://play.google.com/apps/internaltest/4700663189064785694";
// Google's own hosted copy of the official badge, so it always matches current Play branding. Its
// 646x250 source already contains the clear space the badge guidelines require around the artwork,
// so scaling the whole asset (to 180x70, the same 2.584 ratio) keeps that spacing correct — never
// crop it, and never pull it up with a negative margin. Many mail clients block remote images,
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
 * Shared cream-card shell, matching the confirmation/recovery templates' visual language. Inlined
 * rather than read from supabase/templates/ because these are no longer GoTrue templates — nothing
 * would substitute values into them, and an edge function can't reliably read repo files at
 * runtime. Callers pass already-escaped inner HTML.
 */
const emailShell = (emoji: string, heading: string, inner: string) =>
  `<div style="background-color:#FFFDF3;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border:2px solid #FFF5D1;border-radius:24px;padding:32px;text-align:center;">
    <div style="font-size:48px;line-height:1;margin-bottom:8px;">${emoji}</div>
    <h1 style="color:#4E342E;font-size:22px;margin:0 0 12px;">${heading}</h1>
    ${inner}
    <p style="color:#A1887F;font-size:12px;margin-top:24px;">
      If you weren't expecting this, you can safely ignore this email.
    </p>
  </div>
</div>`;

/** For someone with no Crumbo account yet — the point of this one is the Play Store link. */
function inviteEmailHtml(inviterName: string, kidName: string, inviteeEmail: string): string {
  const inviter = escapeHtml(inviterName);
  const kid = escapeHtml(kidName);
  const email = escapeHtml(inviteeEmail);
  return emailShell("👋", "You've Been Invited!", `
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
    </p>`);
}

/**
 * For someone who already has an account. No Play Store badge and no instructions: they have the
 * app, the contact is already in their list, and there is genuinely nothing for them to do — so
 * this says so plainly rather than inventing a call to action.
 */
function linkedEmailHtml(inviterName: string, kidName: string): string {
  const inviter = escapeHtml(inviterName);
  const kid = escapeHtml(kidName);
  return emailShell("🍪", `You can now chat with ${kid}!`, `
    <p style="color:#8D6E63;font-size:15px;line-height:22px;margin:0 0 20px;">
      ${inviter} added you to ${kid}'s friends list on Crumbo.
    </p>
    <p style="color:#8D6E63;font-size:15px;line-height:22px;margin:0;">
      Nothing to set up — just open Crumbo and you'll find ${kid} waiting in your chat list.
    </p>`);
}

/** Same shape as notify-call's: a kid row's push_token IS the raw token, a parent/relative row's
 *  holds their whole JSON payload with the token nested at `pushToken`. */
function extractExpoToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const isRawToken = (v: string) => v.startsWith("ExponentPushToken") || v.startsWith("ExpoPushToken");
  if (isRawToken(raw)) return raw;
  try {
    const payload = JSON.parse(raw);
    if (typeof payload?.pushToken === "string" && isRawToken(payload.pushToken)) return payload.pushToken;
  } catch {
    // Not JSON either — genuinely not a token.
  }
  return null;
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

    // Verify who's actually calling using their own JWT — this is sent "from" whoever is
    // authenticated right now, not whatever email the client claims.
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: callerData, error: callerError } = await callerClient.auth.getUser();
    if (callerError || !callerData?.user?.email) {
      return json({ error: "Could not verify caller identity" }, 401);
    }

    const { email, kidCookieCode, kidName, linked } = await req.json();
    if (!email || !kidCookieCode || !kidName) {
      return json({ error: "email, kidCookieCode and kidName are required" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const relativeEmail = String(email).toLowerCase();
    const relativeCode = `PARENT:${relativeEmail}`;

    // Only ever announce a link that genuinely exists. rpc_add_relative_to_kid does the real work
    // (as the caller, ownership-checked) immediately before this is invoked, so if its trace is
    // missing then that call didn't happen or didn't apply to this pair — and an email claiming a
    // waiting kid would simply be false.
    let relativePushToken: string | null = null;
    if (linked) {
      const { data: relativeRow } = await admin
        .from("profiles")
        .select("push_token")
        .eq("cookie_code", relativeCode)
        .maybeSingle();
      if (!relativeRow) {
        return json({ error: "No account for this address" }, 409);
      }
      let hasKid = false;
      try {
        const payload = JSON.parse(relativeRow.push_token || "{}");
        hasKid = (payload?.friends || []).some(
          (f: { cookieCode?: string }) => f?.cookieCode === kidCookieCode,
        );
      } catch {
        // Unparseable payload — treated as "no link", same as a missing one.
      }
      if (!hasKid) {
        return json({ error: "That kid is not linked to this account" }, 409);
      }
      relativePushToken = extractExpoToken(relativeRow.push_token);
    } else {
      const { data: pending } = await admin
        .from("pending_relative_links")
        .select("kid_name")
        .eq("email", relativeEmail)
        .eq("kid_cookie_code", kidCookieCode)
        .maybeSingle();
      if (!pending) {
        return json({ error: "No pending invite for this address and kid" }, 409);
      }
    }

    // The caller's own preferred display name, for a personal "Jem added you..." instead of a raw
    // email address. A PARENT: row's `name` COLUMN is a fixed sentinel — the real display name
    // lives inside push_token's JSON as parentName (see StorageService.syncParentData).
    const { data: callerProfile } = await admin
      .from("profiles")
      .select("push_token")
      .eq("cookie_code", `PARENT:${callerData.user.email}`)
      .maybeSingle();
    let inviterName = callerData.user.email as string;
    try {
      const callerPayload = JSON.parse(callerProfile?.push_token || "{}");
      if (typeof callerPayload?.parentName === "string" && callerPayload.parentName.trim()) {
        inviterName = callerPayload.parentName.trim();
      }
    } catch {
      // Not JSON, or no row yet — keep the email fallback.
    }

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: linked
          ? `You can now chat with ${kidName} on Crumbo 🍪`
          : `${inviterName} invited you to chat with ${kidName} on Crumbo 👋`,
        html: linked
          ? linkedEmailHtml(inviterName, kidName)
          : inviteEmailHtml(inviterName, kidName, email),
      }),
    });
    const emailResult = await emailRes.json();
    if (!emailRes.ok) {
      console.error("Resend rejected the email:", JSON.stringify(emailResult));
      return json({ error: "Could not send the email", detail: emailResult }, 502);
    }

    // Push only makes sense for the already-has-an-account case; nobody else has a device
    // registered yet. Deliberately a normal visible notification with title/body — unlike
    // notify-call, which must stay data-only so the app builds the call UI itself.
    let pushed = false;
    if (linked && relativePushToken) {
      try {
        const pushRes = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
          },
          body: JSON.stringify({
            to: relativePushToken,
            title: `You can now chat with ${kidName}! 🍪`,
            body: `${inviterName} added you to ${kidName}'s friends list.`,
            sound: "default",
            priority: "high",
            // `kind` is what the tap handler routes on, and senderCode is the OTHER party's
            // cookie code — the same shape chat_message pushes use, so tapping this opens the
            // conversation with the kid (see callkeep.ts's notification response listener).
            data: { kind: "relative_linked", senderCode: kidCookieCode },
          }),
        });
        const pushResult = await pushRes.json();
        const ticket = Array.isArray(pushResult?.data) ? pushResult.data[0] : pushResult?.data;
        pushed = pushRes.ok && ticket?.status === "ok";
        if (!pushed) {
          console.error("Expo rejected the relative-linked push:", JSON.stringify(ticket ?? pushResult));
        }
      } catch (e) {
        // Non-fatal: the email already landed, and the contact is in their list either way.
        console.error("Failed to send relative-linked push:", e);
      }
    }

    return json({ success: true, id: emailResult?.id ?? null, pushed });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
