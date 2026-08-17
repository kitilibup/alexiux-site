#!/usr/bin/env python3
"""Self-host the Google fonts the site loads at runtime.

The Webflow build pulls Inter and Manrope through Google's WebFont loader,
which is render-blocking and sends visitor IPs to Google on every page view.
This fetches the same faces once and writes assets/css/fonts.css.

Google's stylesheet splits each family into unicode-range subsets so browsers
only download the ranges a page actually uses. That structure is preserved -
only the URLs are swapped for local ones.
"""

import os
import re
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "assets", "fonts")
CSS_OUT = os.path.join(ROOT, "assets", "css", "fonts.css")

FAMILIES = "family=Inter:wght@300;400;500;600;700&family=Manrope:wght@300;400;500;600;700"
CSS_URL = f"https://fonts.googleapis.com/css2?{FAMILIES}&display=swap"

# A modern browser UA is required, otherwise Google serves legacy TTF instead
# of the much smaller woff2.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "\
     "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"


def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8")


def main():
    os.makedirs(FONT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(CSS_OUT), exist_ok=True)

    css = fetch(CSS_URL)
    urls = sorted(set(re.findall(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", css)))
    print(f"{len(urls)} font files referenced")

    total = 0
    for url in urls:
        # e.g. .../inter/v20/UcC73Fwr...woff2  ->  inter-v20-UcC73Fwr.woff2
        parts = url.split("/")
        name = f"{parts[-3]}-{parts[-2]}-{parts[-1]}"
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", name)
        dest = os.path.join(FONT_DIR, name)

        if not (os.path.exists(dest) and os.path.getsize(dest) > 0):
            data = fetch(url, binary=True)
            with open(dest, "wb") as f:
                f.write(data)
            total += len(data)
        css = css.replace(url, f"/assets/fonts/{name}")

    with open(CSS_OUT, "w", encoding="utf-8") as f:
        f.write("/* Self-hosted Inter + Manrope. Regenerate with tools/fonts.py */\n")
        f.write(css)

    faces = css.count("@font-face")
    print(f"Downloaded {total // 1024} KB, wrote {faces} @font-face rules to assets/css/fonts.css")


if __name__ == "__main__":
    main()
