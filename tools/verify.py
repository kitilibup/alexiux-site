#!/usr/bin/env python3
"""Check every local asset referenced by the built pages actually resolves.

Point it at whatever is being served:

    python3 tools/verify.py http://127.0.0.1:8099/mirror/dist

Covers plain markup, the percent-encoded Webflow collection templates that
webflow.js expands at runtime, and url() references inside the stylesheets.
"""

import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "mirror", "dist")

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8099/mirror/dist"
ORIGIN = "/".join(BASE.split("/")[:3])

REF_RE = re.compile(r'(?:href|src)="(/assets/[^"]+)"')
CSS_URL_RE = re.compile(r'url\(["\']?(/assets/[^)"\']+)')
WF_TEMPLATE_RE = re.compile(r'<script type="text/x-wf-template" id="[^"]*">([^<]*)</script>')


def head(url):
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # noqa: BLE001
        return f"ERR {e}"


def main():
    refs = {}  # asset path -> set of pages referencing it

    for dirpath, _, names in os.walk(DIST):
        for n in sorted(names):
            if not n.endswith(".html"):
                continue
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, DIST)
            html = open(full, encoding="utf-8").read()

            found = set(REF_RE.findall(html))
            # webflow.js decodes these and injects the markup at runtime, so
            # anything referenced inside them has to resolve too.
            for payload in WF_TEMPLATE_RE.findall(html):
                found |= set(REF_RE.findall(urllib.parse.unquote(payload)))
            for path in found:
                refs.setdefault(path, set()).add(rel)

    # Stylesheets pull in fonts and background images of their own.
    for css_rel in ("css/alexei-portfolio-site.webflow.shared.8e6b5cb7d.css", "css/fonts.css"):
        css_file = os.path.join(ROOT, "assets", css_rel)
        if os.path.exists(css_file):
            css = open(css_file, encoding="utf-8", errors="replace").read()
            for path in set(CSS_URL_RE.findall(css)):
                refs.setdefault(path, set()).add(f"assets/{css_rel}")

    print(f"Checking {len(refs)} unique local assets against {ORIGIN} ...\n")
    bad = []
    for path in sorted(refs):
        # Some references carry a cache-busting query (e.g. jquery's ?site=...).
        # Static servers ignore it; it must not be encoded into the path.
        file_path = path.split("?", 1)[0]
        status = head(ORIGIN + urllib.parse.quote(file_path))
        if status != 200:
            bad.append((path, status, refs[path]))

    if bad:
        print(f"{len(bad)} BROKEN:\n")
        for path, status, pages in bad:
            where = ", ".join(sorted(pages)[:3])
            print(f"  [{status}] {path}\n        <- {where}")
    else:
        print(f"  All {len(refs)} assets resolve (200).")

    # Anything still pointing at the old hosting would silently keep working in
    # a browser, which is exactly why it needs flagging here.
    print()
    stale = 0
    for dirpath, _, names in os.walk(DIST):
        for n in sorted(names):
            if n.endswith(".html"):
                html = open(os.path.join(dirpath, n), encoding="utf-8").read()
                for probe in ("website-files.com", "cloudfront.net"):
                    if probe in html:
                        print(f"  STALE {probe} in {n}")
                        stale += 1
    print("  No references to Webflow hosting." if not stale else f"  {stale} stale reference(s).")

    sys.exit(1 if bad or stale else 0)


if __name__ == "__main__":
    main()
