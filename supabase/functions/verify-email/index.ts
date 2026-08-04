/* Supabase Edge Function: verify-email
 *
 * The web fallback for the "Confirm your email" link in signup confirmation emails (see
 * emailRedirectTo in gate.tsx's handleRegister). Supabase's own /auth/v1/verify endpoint
 * validates the token and marks the account confirmed BEFORE redirecting here — by the time this
 * page loads, verification has already happened server-side, regardless of what this page shows
 * or which device opened the link. This page's only job is to give a real confirmation screen to
 * anyone who isn't on a device with the app installed (previously: a broken "can't open app"
 * browser error, even though the account really was verified underneath it).
 *
 * On a device with the app installed, this attempts to jump straight into it
 * (crumbo://parent/gate) so mobile keeps working exactly like before; anywhere that fails
 * (desktop, no app installed) the static "you're verified" message underneath stays visible
 * instead of a dead redirect.
 *
 * Deploy: supabase functions deploy verify-email --no-verify-jwt
 * (also set verify_jwt = false for this function in supabase/config.toml — this endpoint is hit
 * by a bare browser GET from an email link, with no Authorization header at all, so the
 * platform's default JWT check would reject it before this code ever runs)
 */

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const APP_DEEP_LINK = "crumbo://parent/gate";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Email Verified — Crumbo</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #FFFDF3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #4E342E;
    padding: 24px;
  }
  .card {
    max-width: 420px;
    width: 100%;
    background: #FFFFFF;
    border: 2px solid #FFF5D1;
    border-radius: 28px;
    padding: 40px 32px;
    text-align: center;
    box-shadow: 0 6px 24px rgba(141, 110, 99, 0.15);
  }
  .emoji { font-size: 56px; margin-bottom: 8px; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.5; color: #8D6E63; margin: 0 0 28px; }
  a.button {
    display: inline-block;
    background: #FFC93C;
    color: #4E342E;
    font-weight: 800;
    text-decoration: none;
    padding: 14px 28px;
    border-radius: 20px;
    font-size: 16px;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="emoji">🍪✅</div>
    <h1>Email Verified!</h1>
    <p>Your Crumbo account is confirmed. You can sign in and start setting up your family now.</p>
    <a class="button" href="${APP_DEEP_LINK}">Open Crumbo App</a>
  </div>
  <script>
    // Best-effort jump straight into the app on a device that has it installed — the button
    // above is the fallback for anywhere this silently does nothing (desktop, no app installed).
    window.location.href = ${JSON.stringify(APP_DEEP_LINK)};
  </script>
</body>
</html>`;

Deno.serve((_req) => {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
