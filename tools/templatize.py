#!/usr/bin/env python3
"""Turn the mirrored pages into Eleventy templates + editable content files.

Splits each page into shared chrome (which becomes a partial) and page content
(which becomes JSON the CMS can edit), then writes the Eleventy templates that
reassemble them.

The chrome comes in two flavours, because Webflow bakes per-page grid node ids
like #w-node-_6fa84971-... into both the markup and the stylesheet's grid rules.
Those ids are load-bearing, so the chrome is captured verbatim per page type
rather than unified:

    main     index / about / work / collaborate  - identical but for the
             active nav link, which becomes a parameter
    project  the 8 case studies                  - byte-identical already

Run after tools/postprocess.py:

    python3 tools/templatize.py
"""

import glob
import html as htmllib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from regions import split_page  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "mirror", "dist")
SRC = os.path.join(ROOT, "src")
CONTENT = os.path.join(ROOT, "content")

MAIN_PAGES = ["index", "about", "work", "collaborate"]

# Nav links carry the active marker on whichever page is showing.
ACTIVE_RE = re.compile(r'\s*aria-current="page"|\s+w--current(?=")')


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


ANCHOR_RE = re.compile(r"<a\b[^>]*>")


def deactivate_nav(navbar):
    """Strip active-state markers so a single partial serves every page.

    Returns the neutral markup plus the positions of the anchors that were
    active, which the data layer re-applies at build time. Positions rather
    than ids or hrefs, because a page can mark more than one anchor active -
    the home page flags both the logo and the Home link - and positions stay
    unambiguous when several anchors share an href.
    """
    active = [i for i, m in enumerate(ANCHOR_RE.finditer(navbar))
              if 'aria-current="page"' in m.group(0)]
    return ACTIVE_RE.sub("", navbar), active


def extract_meta(head):
    """Pull the SEO fields the CMS should own out of the raw <head>."""
    def grab(pattern):
        m = re.search(pattern, head)
        return htmllib.unescape(m.group(1)) if m else None

    return {
        "title": grab(r"<title>(.*?)</title>"),
        "description": grab(r'<meta content="([^"]*)" name="description"'),
        "ogTitle": grab(r'<meta content="([^"]*)" property="og:title"'),
        "ogImage": grab(r'<meta content="([^"]*)" property="og:image"'),
    }


def tokenize_head(head, meta):
    """Replace the editable SEO values in <head> with template placeholders.

    Everything else - charset, stylesheet links, favicons, analytics - is
    boilerplate that stays verbatim, so the rebuilt head matches byte for byte.
    """
    out = head
    if meta["title"] is not None:
        out = out.replace(f"<title>{htmllib.escape(meta['title'], quote=False)}</title>",
                          "<title>{{ seo.title }}</title>", 1)
        # Fall back to the raw form if the title had no escapable characters.
        out = re.sub(r"<title>.*?</title>", "<title>{{ seo.title }}</title>", out, count=1)
    for key, attr in (("description", 'name="description"'),
                      ("ogTitle", 'property="og:title"'),
                      ("ogImage", 'property="og:image"')):
        if meta[key] is None:
            continue
        esc = htmllib.escape(meta[key], quote=True)
        out = out.replace(f'<meta content="{esc}" {attr}/>',
                          '<meta content="{{ seo.%s }}" %s/>' % (key, attr), 1)
    return out


def project_slug(rel):
    return os.path.basename(rel)[:-len(".html")]


def scrape_work_listing():
    """Recover per-project fields from the /work collection list.

    The case-study pages themselves don't carry their listing metadata, but the
    grid on /work renders it for every project: display order, year, title and
    thumbnail. Reading it here gives the CMS real typed fields instead of only
    a body blob.
    """
    from regions import find_element  # local import: same package dir

    path = os.path.join(DIST, "work.html")
    if not os.path.exists(path):
        return {}
    html = open(path, encoding="utf-8").read()
    grid = find_element(html, r'<div[^>]*class="projects-grid w-dyn-items"[^>]*>')
    if not grid:
        return {}

    items, pos = {}, 0
    inner = grid[2]
    while True:
        found = find_element(inner, r'<div[^>]*class="collection-item w-dyn-item"[^>]*>', pos)
        if not found:
            break
        _, end, item = found
        pos = end

        href = re.search(r'href="/project/([^"]+)"', item)
        if not href:
            continue
        thumb = re.search(r'src="([^"]*)"[^>]*class="project-thumbnail"', item)
        texts = [htmllib.unescape(t.strip())
                 for t in re.findall(r">([^<>]{1,80})<", item) if t.strip()]
        # Rendered order is: index ("01"), year ("2025"), then the title.
        num = next((t for t in texts if re.fullmatch(r"\d{1,2}", t)), None)
        year = next((t for t in texts if re.fullmatch(r"(19|20)\d{2}", t)), None)
        title = next((t for t in texts
                      if t not in (num, year) and t.lower() != "view more"), None)

        items[href.group(1)] = {
            "order": int(num) if num else 999,
            "year": year,
            "title": title,
            "thumbnail": thumb.group(1) if thumb else None,
        }
    return items


def main():
    pages = {}
    for f in sorted(glob.glob(os.path.join(DIST, "**", "*.html"), recursive=True)):
        rel = os.path.relpath(f, DIST)
        pages[rel] = split_page(open(f, encoding="utf-8").read())

    if not pages:
        sys.exit("No pages in mirror/dist/ - run tools/mirror.py && tools/postprocess.py")

    proj = {k: v for k, v in pages.items() if k.startswith("project/")}
    main_p = {k: v for k, v in pages.items() if not k.startswith("project/")}

    # ---- shared chrome ---------------------------------------------------
    ref_main = main_p["about.html"]
    ref_proj = next(iter(proj.values()))

    nav_main, _ = deactivate_nav(ref_main["navbar"])
    nav_proj, _ = deactivate_nav(ref_proj["navbar"])

    # Every page's chrome must reduce to one of these two, or the partial would
    # silently lose markup on some page.
    for rel, r in pages.items():
        neutral, _ = deactivate_nav(r["navbar"])
        expect = nav_proj if rel.startswith("project/") else nav_main
        if neutral != expect:
            sys.exit(f"navbar for {rel} does not reduce to its shared partial")

    write(os.path.join(SRC, "_includes/partials/global-styles.njk"), ref_main["global_styles"])
    write(os.path.join(SRC, "_includes/partials/navbar-main.njk"), nav_main)
    write(os.path.join(SRC, "_includes/partials/navbar-project.njk"), nav_proj)
    write(os.path.join(SRC, "_includes/partials/scroll-up.njk"), ref_main["scroll_up"])
    write(os.path.join(SRC, "_includes/partials/scroll-up-project.njk"), ref_proj["scroll_up"])
    write(os.path.join(SRC, "_includes/partials/preloader.njk"),
          (pages["index.html"]["preloader"] or "") + (pages["index.html"]["cursor"] or ""))

    # Footer and trailing scripts differ per page (form id, extra embeds), so
    # they ride along in the page's own content file.

    # ---- per-page content ------------------------------------------------
    work_fields = scrape_work_listing()
    counts = {"pages": 0, "projects": 0}
    for rel, r in pages.items():
        meta = extract_meta(r["head"])
        _, active = deactivate_nav(r["navbar"])
        is_proj = rel.startswith("project/")
        slug = project_slug(rel) if is_proj else rel[:-len(".html")]

        record = {
            "slug": slug,
            "seo": {k: v for k, v in meta.items() if v is not None},
            "navActive": active,
            # Captured verbatim so the rebuild is byte-exact. The CMS edits the
            # structured fields above and the body below.
            "head": tokenize_head(r["head"], meta),
            "htmlOpen": r["html_open"],
            "bodyOpen": r["body_open"],
            "wrapperOpen": r["wrapper_open"],
            "wrapperClose": r["wrapper_close"],
            "bodyHtml": r["content"],
            "footerHtml": r["footer"],
            "scriptsHtml": r["after_wrapper"],
        }

        if is_proj:
            listing = work_fields.get(slug, {})
            record["title"] = (listing.get("title") or meta.get("ogTitle")
                               or slug.replace("-", " ").title())
            record["year"] = listing.get("year")
            record["order"] = listing.get("order", 999)
            record["thumbnail"] = listing.get("thumbnail")
            record["draft"] = False
            write(os.path.join(CONTENT, "projects", slug + ".json"),
                  json.dumps(record, indent=2, ensure_ascii=False) + "\n")
            counts["projects"] += 1
        else:
            record["hasPreloader"] = bool(r["preloader"])
            write(os.path.join(CONTENT, "pages", slug + ".json"),
                  json.dumps(record, indent=2, ensure_ascii=False) + "\n")
            counts["pages"] += 1

    print(f"  wrote {counts['pages']} page files, {counts['projects']} project files")
    print(f"  wrote 6 chrome partials to src/_includes/partials/")


if __name__ == "__main__":
    main()
