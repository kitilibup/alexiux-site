# alexiux.com

The portfolio, moved off Webflow: a static site built by [Eleventy](https://www.11ty.dev/),
edited through a custom CMS, hosted on GitHub Pages.

```
content/          the site's content as JSON - what the CMS edits
  _schema/        field definitions; these drive the CMS forms
  pages/          home, about, work, collaborate
  projects/       the 8 case studies
src/              Eleventy templates and shared chrome
assets/           mirrored CSS/JS/images, self-hosted fonts, CMS uploads
admin/            the CMS (static, no build step)
auth-worker/      Cloudflare Worker that completes GitHub sign-in
tools/            mirroring and verification scripts
mirror/dist/      the verified copy of the original site (reference)
```

## Everyday use

Edit content at `/admin` on the deployed site. Saving commits to `main`,
which triggers a build; the CMS polls the workflow and reports whether it
actually succeeded.

Locally:

```bash
npm install
npm run build     # -> _site/
npm run serve     # http://localhost:8080
```

## Setup

Three one-time steps. The first gets the site live; the other two enable
sign-in and the custom domain.

### 1. Push to GitHub and turn on Pages

```bash
git remote add origin https://github.com/<username>/alexiux-site.git
git push -u origin main
```

In **Settings → Pages**, set *Source* to **GitHub Actions**. The next push
builds and deploys. Then set `owner` and `siteUrl` in
[admin/config.js](admin/config.js).

Until sign-in is configured, the CMS accepts a
[fine-grained personal access token](https://github.com/settings/tokens?type=beta)
scoped to this repository with **Contents: read and write**. It is held in
`sessionStorage` and cleared when the tab closes.

### 2. Sign in with GitHub

Create an OAuth app at **Settings → Developer settings → OAuth Apps**:

- Homepage URL: your Pages URL
- Authorization callback URL: `https://<worker-name>.<subdomain>.workers.dev/callback`

Then deploy the worker:

```bash
cd auth-worker
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Set `ALLOWED_ORIGIN` in [auth-worker/wrangler.toml](auth-worker/wrangler.toml)
to the admin's exact origin, and `authWorker` in `admin/config.js` to the
deployed worker URL. The client secret stays in the worker; the browser never
sees it.

### 3. Point the domain at GitHub (do this last)

Only once you're satisfied with the deployed site — this is the step that
takes traffic away from Webflow.

Add a `CNAME` file containing `alexiux.com` to `assets/`, set the custom
domain under **Settings → Pages**, then update DNS:

| Type  | Name | Value |
|-------|------|-------|
| A     | @    | `185.199.108.153`, `.109.153`, `.110.153`, `.111.153` |
| CNAME | www  | `<username>.github.io` |

Enable **Enforce HTTPS** once the certificate is issued. Update
`ALLOWED_ORIGIN` and `authWorker` to the new origin.

## What changed from the Webflow original

The design is a byte-exact copy. These were deliberate migration changes:

- **Contact form is inert.** It posted to Webflow's servers. The markup and
  styling are intact, the submit button is disabled, and a note points at the
  email and WhatsApp links. Wire it to a form service when you're ready.
- **Fonts are self-hosted.** Google's WebFont loader was render-blocking and
  sent visitor IPs to Google on every view.
- **Webflow's GA proxy was removed** — that endpoint only exists on their
  hosting. Analytics still runs via the standard tag that was already present.
- **SRI hashes were stripped** from self-hosted assets, since mirroring
  rewrites URLs inside the stylesheet and a stale hash makes browsers silently
  refuse to apply it.
- **Not migrated:** the `/service/*` pages, the Webflow Membership pages
  (they need Webflow's user backend), `/projects` and `/test-svg`.

## Verifying a change

```bash
python3 -m http.server 8099 --bind 127.0.0.1   # in one terminal

python3 tools/verify.py http://127.0.0.1:8099/mirror/dist   # every asset resolves
tools/visual-diff.sh ./visual-diff 1440                     # local vs live, per page
```

`tools/visual-diff.sh` renders each page from both the local copy and the live
site and compares them byte for byte. Eight of the twelve match exactly; the
other four differ only in the animation phase of a looping marquee, which
lands differently on each capture.

To confirm the templates still reproduce the original exactly:

```bash
npm run build
python3 - <<'EOF'
import glob, os
for f in sorted(glob.glob('mirror/dist/**/*.html', recursive=True)):
    slug = os.path.relpath(f, 'mirror/dist')[:-5]
    built = '_site/index.html' if slug == 'index' else f'_site/{slug}/index.html'
    a, b = open(f).read(), open(built).read()
    print(('OK   ' if a == b else 'DIFF '), slug)
EOF
```

## Re-mirroring

While the Webflow site is still up, `npm run mirror` re-downloads it and
re-applies the migration edits. It will overwrite `mirror/dist/`, but not
`content/` — so it is safe to run without losing CMS edits. Run
`python3 tools/templatize.py` only if you intend to regenerate content from
the Webflow original, which **does** overwrite `content/`.
