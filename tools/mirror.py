#!/usr/bin/env python3
"""Mirror the live Webflow site into a self-contained static copy.

Downloads the 12 in-scope pages plus every asset they reference on Webflow's
CDN, then rewrites the markup to point at local paths.

  mirror/raw/   pristine HTML exactly as served  (reference for diffing)
  mirror/site/  processed HTML with local URLs   (the working mirror)
  assets/       css, js and images

Re-running is safe: assets already on disk are not re-downloaded.
"""

import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "mirror", "raw")
SITE = os.path.join(ROOT, "mirror", "site")
ASSETS = os.path.join(ROOT, "assets")

BASE = "https://alexiux.com"

PAGES = [
    ("/", "index"),
    ("/about", "about"),
    ("/work", "work"),
    ("/collaborate", "collaborate"),
    ("/project/campy", "project/campy"),
    ("/project/connect-project-transmixr", "project/connect-project-transmixr"),
    ("/project/feedback", "project/feedback"),
    ("/project/kombain-by", "project/kombain-by"),
    ("/project/mercedes-me-app", "project/mercedes-me-app"),
    ("/project/musicians-page", "project/musicians-page"),
    ("/project/neighbour", "project/neighbour"),
    ("/project/runorugs", "project/runorugs"),
]

# Hosts we pull down and serve ourselves. Everything else (Wistia, Spline,
# Finsweet, reCAPTCHA, analytics) stays remote and keeps working as-is.
LOCAL_HOSTS = ("cdn.prod.website-files.com", "d3e54v103j8qbb.cloudfront.net")

# Anchored on the file extension rather than stopping at the first bracket:
# Webflow filenames legitimately contain "(" and ")" (e.g. "c_7-min%20(1).avif"),
# so those must stay inside the match. The leading run is greedy so it backtracks
# to the *last* extension in the path, and ends the match there - which also
# trims the trailing ")" off unquoted CSS url(...) references.
ASSET_RE = re.compile(
    r"https://(?:cdn\.prod\.website-files\.com|d3e54v103j8qbb\.cloudfront\.net)"
    r"/[^\"'\s\\<>]*"
    r"\.(?:css|js|avif|jpeg|jpg|png|svg|webp|gif|mp4|woff2|woff|ico)",
    re.IGNORECASE,
)

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "\
     "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def local_name(url):
    """Map a CDN URL to a local folder + filename."""
    path = urllib.parse.urlparse(url).path
    name = path.rsplit("/", 1)[-1]
    # Webflow filenames arrive percent-encoded, sometimes doubly so.
    for _ in range(2):
        decoded = urllib.parse.unquote(name)
        if decoded == name:
            break
        name = decoded
    # Keep it filesystem- and URL-safe.
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-")

    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext == "css":
        folder = "css"
    elif ext == "js":
        folder = "js"
    else:
        folder = "img"
    return folder, name


def download_assets(urls):
    """Download each URL once; return {url: /assets/<folder>/<name>}."""
    mapping = {}
    for i, url in enumerate(sorted(urls), 1):
        folder, name = local_name(url)
        dest_dir = os.path.join(ASSETS, folder)
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, name)
        web_path = f"/assets/{folder}/{name}"
        mapping[url] = web_path

        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            continue
        try:
            data = fetch(url, binary=True)
            with open(dest, "wb") as f:
                f.write(data)
            print(f"  [{i}/{len(urls)}] {name} ({len(data) // 1024} KB)")
        except Exception as exc:  # noqa: BLE001 - report and keep going
            print(f"  !! FAILED {url}: {exc}", file=sys.stderr)
            mapping.pop(url, None)
    return mapping


WF_TEMPLATE_RE = re.compile(
    r'(<script type="text/x-wf-template" id="[^"]*">)([^<]*)(</script>)'
)

# Preconnect/prefetch hints pointing at the CDN we no longer use.
DEAD_HINT_RE = re.compile(
    r'<link[^>]+href="https://cdn\.prod\.website-files\.com"[^>]*/?>'
)


def apply_mapping(text, mapping):
    """Swap CDN URLs for local paths, in plain and backslash-escaped form."""
    for url, local in mapping.items():
        text = text.replace(url, local)
        text = text.replace(url.replace("/", "\\/"), local)
    return text


def rewrite_wf_templates(html, mapping):
    """Rewrite URLs inside Webflow's percent-encoded collection templates.

    webflow.js decodes these at runtime to render repeated collection items,
    so URLs left in here would still be fetched from Webflow's CDN even though
    nothing in the static markup references it.
    """

    def repl(m):
        open_tag, payload, close_tag = m.groups()
        decoded = urllib.parse.unquote(payload)
        rewritten = apply_mapping(decoded, mapping)
        if rewritten == decoded:
            return m.group(0)
        return open_tag + urllib.parse.quote(rewritten, safe="") + close_tag

    return WF_TEMPLATE_RE.sub(repl, html)


def main():
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(SITE, exist_ok=True)

    # 1. Pull every page, keeping a pristine copy.
    print(f"Fetching {len(PAGES)} pages...")
    raw_html = {}
    for path, slug in PAGES:
        html = fetch(BASE + path)
        raw_html[slug] = html
        dest = os.path.join(RAW, slug + ".html")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"  {path}  ({len(html) // 1024} KB)")

    # 2. Collect every asset URL referenced across all pages.
    urls = set()
    for html in raw_html.values():
        for m in ASSET_RE.findall(html):
            urls.add(m.replace("\\/", "/").rstrip("\\"))

    # The stylesheet references more assets from inside its own rules.
    css_urls = {u for u in urls if u.endswith(".css")}
    print(f"\nFetching {len(urls)} assets referenced in HTML...")
    mapping = download_assets(urls)

    for css_url in css_urls:
        folder, name = local_name(css_url)
        css_path = os.path.join(ASSETS, folder, name)
        if not os.path.exists(css_path):
            continue
        css = open(css_path, encoding="utf-8", errors="replace").read()
        nested = {m.replace("\\/", "/") for m in ASSET_RE.findall(css)}
        nested -= set(mapping)
        if nested:
            print(f"\nFetching {len(nested)} assets referenced inside {name}...")
            nested_map = download_assets(nested)
            mapping.update(nested_map)
            for url, local in nested_map.items():
                css = css.replace(url, local)
            with open(css_path, "w", encoding="utf-8") as f:
                f.write(css)

    # 3. Rewrite the markup to use local paths.
    print("\nRewriting pages...")
    for slug, html in raw_html.items():
        out = apply_mapping(html, mapping)
        out = rewrite_wf_templates(out, mapping)
        out = DEAD_HINT_RE.sub("", out)
        dest = os.path.join(SITE, slug + ".html")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(out)
        left = len(re.findall(r"website-files\.com|cloudfront\.net", out))
        flag = "" if left == 0 else f"  <-- {left} unrewritten refs"
        print(f"  {slug}.html{flag}")

    print(f"\nDone. {len(mapping)} assets in assets/, {len(PAGES)} pages in mirror/site/")


if __name__ == "__main__":
    main()
