/* Supabase Edge Function: reset-password-web
 *
 * Web fallback for the "Reset your password" link (see redirectTo in gate.tsx's
 * handleForgotPassword) — and, since it's the exact same accept-invite mechanism, for a
 * relative's "set your password" invite link too (see the invite-relative function). Mirrors
 * src/app/reset-password.tsx's own PKCE code-exchange flow exactly (same ?code= query param,
 * same supabase.auth.exchangeCodeForSession → updateUser({password}) sequence) — just running
 * Supabase's JS SDK in a plain browser instead of React Native.
 *
 * On a mobile device, this attempts to jump straight into the app (crumbo://reset-password?
 * code=...) so mobile keeps working exactly like before. This used to be attempted
 * unconditionally, on the assumption that a `crumbo://` navigation with nothing registered to
 * catch it just fails silently — it doesn't: on desktop browsers (and some mobile ones without
 * the app installed) it surfaces a visible "open this link?" prompt or a broken-link error, i.e.
 * exactly the page trying to open an app that isn't there. The user-agent check below keeps that
 * script line out of the response entirely for anything that doesn't look like iOS/Android, so
 * desktop skips straight to the in-browser password form with no attempted handoff and no
 * artificial delay waiting for one.
 *
 * The PKCE code is one-time-use: if the app opens and exchanges it first, this page's own later
 * attempt just shows "link expired" in what is by then an abandoned browser tab — harmless.
 *
 * Deploy: supabase functions deploy reset-password-web --no-verify-jwt
 * (also set verify_jwt = false for this function in supabase/config.toml — this endpoint is hit
 * by a bare browser GET from an email link, with no Authorization header at all, so the
 * platform's default JWT check would reject it before this code ever runs)
 * Env (auto-available in Edge runtime): SUPABASE_URL, SUPABASE_ANON_KEY
 */

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
  env: { get(key: string): string | undefined };
};

Deno.serve((req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const userAgent = req.headers.get("user-agent") || "";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(userAgent);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Reset Your Password — Crumbo</title>
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
  .emoji { font-size: 48px; margin-bottom: 8px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { font-size: 14px; line-height: 1.5; color: #8D6E63; margin: 0 0 20px; }
  input {
    width: 100%;
    font-size: 16px;
    padding: 14px 16px;
    border-radius: 16px;
    border: 2px solid #FFEFC0;
    background: #FFFDF5;
    color: #4E342E;
    margin-bottom: 8px;
  }
  input:focus { outline: 2px solid #FFC93C; }
  .hint { font-size: 12px; color: #8D6E63; text-align: left; margin: 0 0 20px; line-height: 1.4; }
  button {
    width: 100%;
    background: #FFC93C;
    color: #4E342E;
    font-weight: 800;
    border: none;
    padding: 14px 28px;
    border-radius: 20px;
    font-size: 16px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { color: #D32F2F; font-size: 13px; margin-top: 12px; }
  .success { color: #2E7D32; font-size: 15px; font-weight: 700; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="card">
    <div id="loading">
      <div class="emoji">🔒</div>
      <p>Verifying your reset link…</p>
    </div>

    <div id="form-state" class="hidden">
      <div class="emoji">🔒</div>
      <h1>Set a New Password</h1>
      <p>Choose a new password for your Crumbo Parent account.</p>
      <input id="password" type="password" placeholder="New password" autocomplete="new-password" />
      <p class="hint">At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a special character.</p>
      <button id="submit-btn">Update Password</button>
      <div id="error" class="error hidden"></div>
    </div>

    <div id="success-state" class="hidden">
      <div class="emoji">🍪✅</div>
      <h1>Password Updated!</h1>
      <p class="success">You can now sign in to Crumbo with your new password.</p>
    </div>

    <div id="error-state" class="hidden">
      <div class="emoji">⚠️</div>
      <h1>Link Expired</h1>
      <p>This password reset link is invalid or has expired. Request a new one from the sign-in screen in the app.</p>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
  <script>
    const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
    const SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey)};
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    function show(id) {
      ['loading', 'form-state', 'success-state', 'error-state'].forEach((el) => {
        document.getElementById(el).classList.toggle('hidden', el !== id);
      });
    }

    ${isMobile ? `
    // Best-effort jump straight into the app on a device that has it installed — everything
    // below is the fallback for anywhere this silently does nothing (no app installed).
    if (code) {
      window.location.href = 'crumbo://reset-password?code=' + encodeURIComponent(code);
    }
    ` : ""}

    // Give the OS a moment to actually hand off to the app before committing to the web form —
    // if we're still here after that, there's nothing installed to catch the link above. Desktop
    // never attempted a handoff at all, so there's nothing to wait for — go straight to the form.
    setTimeout(async () => {
      if (!code) {
        show('error-state');
        return;
      }

      const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { detectSessionInUrl: false, persistSession: false, autoRefreshToken: false },
      });

      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error) {
        show('error-state');
        return;
      }

      show('form-state');

      document.getElementById('submit-btn').addEventListener('click', async () => {
        const pwd = document.getElementById('password').value;
        const complexity = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[^A-Za-z0-9]).{8,}$/;
        const errorEl = document.getElementById('error');
        if (!complexity.test(pwd)) {
          errorEl.textContent = 'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character.';
          errorEl.classList.remove('hidden');
          return;
        }
        errorEl.classList.add('hidden');
        const btn = document.getElementById('submit-btn');
        btn.disabled = true;
        btn.textContent = 'Updating…';

        const { error: updateError } = await client.auth.updateUser({ password: pwd });
        if (updateError) {
          errorEl.textContent = 'Could not update your password. Please request a new reset link.';
          errorEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Update Password';
          return;
        }
        await client.auth.signOut();
        show('success-state');
      });
    }, ${isMobile ? 1200 : 0});
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
