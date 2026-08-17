/**
 * GitHub OAuth broker for the CMS.
 *
 * The admin is a static page, and OAuth's code-for-token exchange requires the
 * client secret. A browser cannot hold that secret, so this Worker performs the
 * exchange and hands only the resulting token back to the opener window.
 *
 * Routes:
 *   GET /auth      redirect to GitHub's consent screen
 *   GET /callback  exchange ?code for a token, post it to the opener, close
 *
 * Secrets (set with `wrangler secret put`, never committed):
 *   GITHUB_CLIENT_ID
 *   GITHUB_CLIENT_SECRET
 * Variable (wrangler.toml):
 *   ALLOWED_ORIGIN   exact origin of the admin page
 */

const SCOPE = "repo";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return new Response("Worker is missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET.", {
        status: 500,
      });
    }

    if (url.pathname === "/auth") return startAuth(url, env);
    if (url.pathname === "/callback") return finishAuth(url, env, request);
    return new Response("Not found", { status: 404 });
  },
};

function startAuth(url, env) {
  // Random state, echoed back by GitHub and checked on return, so a third
  // party can't feed this endpoint a code it obtained elsewhere.
  const state = crypto.randomUUID();
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${url.origin}/callback`);
  target.searchParams.set("scope", SCOPE);
  target.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      // Host-only, HttpOnly: readable by this Worker on the callback, not by
      // any page script.
      "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}

async function finishAuth(url, env, request) {
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const cookie = /oauth_state=([^;]+)/.exec(request.headers.get("Cookie") || "")?.[1];

  if (!code) return page(env, { error: "GitHub did not return a code." });
  if (!returnedState || returnedState !== cookie) {
    return page(env, { error: "State mismatch — the sign-in was not completed in this browser." });
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/callback`,
    }),
  });

  const data = await res.json();
  if (data.error || !data.access_token) {
    return page(env, { error: data.error_description || "Token exchange failed." });
  }
  return page(env, { token: data.access_token });
}

/** Hand the result to the opener and close. */
function page(env, payload) {
  const origin = env.ALLOWED_ORIGIN || "";
  const body = `<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="font:15px system-ui;padding:32px;text-align:center">
<p>${payload.error ? "Sign-in failed." : "Signed in. You can close this window."}</p>
${payload.error ? `<p style="color:#c0392b">${escapeHtml(payload.error)}</p>` : ""}
<script>
  (function () {
    var payload = ${JSON.stringify(payload)};
    if (window.opener) {
      window.opener.postMessage(payload, ${JSON.stringify(origin)});
      setTimeout(function () { window.close(); }, payload.error ? 4000 : 400);
    }
  })();
</script>`;
  return new Response(body, {
    status: payload.error ? 400 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[c])
  );
}
