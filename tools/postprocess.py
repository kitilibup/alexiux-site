#!/usr/bin/env python3
"""Apply the migration edits to the mirrored pages.

Reads the pristine mirror from mirror/site/ and writes the deployable pages to
mirror/dist/. Kept separate from mirror.py so re-downloading the site never
clobbers these edits, and so each edit is independently auditable.

Three groups of changes:

  fonts      swap Google's render-blocking WebFont loader for self-hosted faces
  analytics  drop Webflow's first-party GA proxy, which only exists on their
             infrastructure and would 404 anywhere else
  form       disable the contact form, which posted to Webflow's servers

Every rule reports a hit count and the script exits non-zero if any rule fails
to fire on a page that should have it, so a silent partial edit can't slip by.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "mirror", "site")
DIST = os.path.join(ROOT, "mirror", "dist")

FONTS_LINK = '<link href="/assets/css/fonts.css" rel="stylesheet" type="text/css"/>'

# Shown in place of the form's submit control. The form still renders exactly as
# designed; it just can't pretend to deliver a message it has no backend for.
FORM_NOTICE = (
    '<div class="form-disabled-notice" style="margin-top:16px;font-size:14px;'
    'line-height:1.5;opacity:.7">'
    'This form isn\'t connected yet &mdash; please reach out by email or WhatsApp above.'
    "</div>"
)

# (name, pattern, replacement, required)
RULES = [
    # --- fonts -------------------------------------------------------------
    ("fonts: drop WebFont loader script",
     re.compile(r'<script src="https://ajax\.googleapis\.com/ajax/libs/webfont/[^"]*"[^>]*></script>'),
     "", True),
    ("fonts: drop WebFont.load call",
     re.compile(r'<script type="text/javascript">WebFont\.load\(.*?\);?</script>', re.S),
     "", True),
    ("fonts: drop Google preconnects",
     re.compile(r'<link[^>]+href="https://fonts\.g(?:oogleapis|static)\.com"[^>]*/?>'),
     "", True),

    # --- analytics ---------------------------------------------------------
    # Webflow proxies GA through a per-site first-party path. That endpoint is
    # part of their hosting, so off-Webflow it is a guaranteed 404. The standard
    # googletagmanager loader is already present on every page, so GA keeps
    # working once this is gone - nothing needs to replace it.
    ("analytics: drop Webflow GA proxy script",
     re.compile(r'<script async(?:="")? src="/x[A-Za-z0-9_/-]+"></script>'),
     "", True),
    ("analytics: drop first-party GA bootstrap",
     re.compile(r"<script>\(function\(w,i,g\)\{.*?google_tags_first_party'\);</script>", re.S),
     "", True),

    # --- contact form ------------------------------------------------------
    ("form: drop reCAPTCHA script",
     re.compile(r'<script src="https://www\.google\.com/recaptcha/api\.js"[^>]*></script>'),
     "", True),
    ("form: drop reCAPTCHA widget",
     re.compile(r'<div[^>]*class="w-form-formrecaptcha[^"]*"[^>]*></div>'),
     "", True),
    # A custom embed that toggled the widget's data-size at mobile widths. With
    # the widget gone it is dead code - it would find nothing and do nothing.
    ("form: drop reCAPTCHA resize embed",
     re.compile(r'<div class="code-embed-2 w-embed w-script"><script>\s*document'
                r'\.addEventListener\("DOMContentLoaded".*?updateRecaptchaSize\);?\s*\}\);'
                r'</script></div>', re.S),
     "", True),
    ("form: disable submit",
     re.compile(r'(<input type="submit"[^>]*class="send-button w-button"[^>]*?)\s*/?>'),
     r'\1 disabled aria-disabled="true"/>' + FORM_NOTICE, True),
]


# Tags loading assets we now serve ourselves.
SELF_HOSTED_TAG_RE = re.compile(
    r'<(?:link|script)\b[^>]*?(?:href|src)="/assets/[^"]*"[^>]*?>'
)
SRI_ATTR_RE = re.compile(r'\s+(?:integrity|crossorigin)="[^"]*"')


def strip_sri(html):
    """Remove subresource-integrity hashes from self-hosted assets.

    Webflow ships its CSS and JS with SRI hashes computed against the files as
    served from their CDN. Mirroring rewrites URLs *inside* the stylesheet, so
    its hash no longer matches and the browser silently refuses to apply it -
    the page loads completely unstyled while every asset still returns 200.

    SRI protects against a third-party CDN being tampered with. These files are
    same-origin now, so the hashes buy nothing and would break again on any
    future edit.
    """
    count = 0

    def repl(m):
        nonlocal count
        tag, n = SRI_ATTR_RE.subn("", m.group(0))
        count += 1 if n else 0
        return tag

    return SELF_HOSTED_TAG_RE.sub(repl, html), count


def inject_fonts_css(html):
    """Add the self-hosted font stylesheet ahead of the main stylesheet."""
    if FONTS_LINK in html:
        return html, 1
    m = re.search(r'<link href="/assets/css/[^"]*\.css" rel="stylesheet"[^>]*/?>', html)
    if not m:
        return html, 0
    return html[:m.start()] + FONTS_LINK + html[m.start():], 1


def main():
    pages = []
    for dirpath, _, names in os.walk(SRC):
        for n in sorted(names):
            if n.endswith(".html"):
                full = os.path.join(dirpath, n)
                pages.append((full, os.path.relpath(full, SRC)))
    pages.sort(key=lambda p: p[1])

    if not pages:
        sys.exit("No pages in mirror/site/ - run tools/mirror.py first.")

    totals = {name: 0 for name, _, _, _ in RULES}
    totals["fonts: inject self-hosted stylesheet"] = 0
    totals["assets: strip stale SRI hashes"] = 0
    failures = []

    for full, rel in pages:
        html = open(full, encoding="utf-8").read()

        for name, pattern, repl, required in RULES:
            html, n = pattern.subn(repl, html)
            totals[name] += n
            if required and n == 0:
                failures.append(f"{rel}: rule did not fire - {name}")

        html, n = inject_fonts_css(html)
        totals["fonts: inject self-hosted stylesheet"] += n
        if n == 0:
            failures.append(f"{rel}: rule did not fire - fonts: inject stylesheet")

        html, n = strip_sri(html)
        totals["assets: strip stale SRI hashes"] += n
        if n == 0:
            failures.append(f"{rel}: rule did not fire - assets: strip SRI")

        dest = os.path.join(DIST, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(html)

    print(f"Processed {len(pages)} pages -> mirror/dist/\n")
    for name in sorted(totals):
        print(f"  {totals[name]:>3}x  {name}")

    # Nothing from the old hosting should survive into the deployable copy.
    print()
    leftovers = 0
    for full, rel in pages:
        out = open(os.path.join(DIST, rel), encoding="utf-8").read()
        for probe in ("website-files.com", "cloudfront.net", "recaptcha",
                      "WebFont.load", "google_tags_first_party"):
            if probe in out:
                print(f"  LEFTOVER {probe} in {rel}")
                leftovers += 1
    print("  no leftovers" if not leftovers else f"  {leftovers} leftover(s)")

    if failures:
        print("\nFAILURES:", file=sys.stderr)
        for f in failures:
            print("  " + f, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
