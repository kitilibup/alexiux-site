#!/usr/bin/env python3
"""Split the mirrored pages into named regions.

Shared by the templatize step and by ad-hoc analysis. Region boundaries come
from the page structure the mirror revealed:

    body
      div.global-styles          inline <style>, shared
      div.preloader              home only
      div.cursor-wrapper         home only
      div.page-wrapper
        div.navbar#Nav           shared
        div.section  x N         <- the page's actual content
        div.footer               shared
        a.scroll-up              shared
      <script> x N               shared
"""

import re

# Matches an opening tag, a closing tag, or a self-closing/void tag.
TAG_RE = re.compile(r"<(/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(/?)>")
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}

# Webflow puts data-w-id before class on animated elements, so regions have to
# be located by class value rather than by an exact opening tag.
CLS = r'<div\b[^>]*class="%s"[^>]*>' 


def match_element(html, start):
    """Given the index of an opening tag, return the index just past its close.

    Depth-counts same-name tags so nested divs don't end the match early.
    <script> content is skipped wholesale, since markup inside a JS string
    would otherwise be read as real tags.
    """
    m = TAG_RE.match(html, start)
    if not m:
        raise ValueError(f"no tag at {start}: {html[start:start+60]!r}")
    name = m.group(2).lower()
    if name in VOID or m.group(4):
        return m.end()

    depth = 0
    pos = start
    while pos < len(html):
        m = TAG_RE.search(html, pos)
        if not m:
            break
        tag = m.group(2).lower()

        if tag == "script" and not m.group(1):
            end = html.find("</script>", m.end())
            pos = len(html) if end == -1 else end + len("</script>")
            continue

        if tag == name and not m.group(4):
            if m.group(1):
                depth -= 1
                if depth == 0:
                    return m.end()
            else:
                depth += 1
        pos = m.end()
    raise ValueError(f"unclosed <{name}> from {start}")


def find_element(html, pattern, start=0):
    """Locate an element by a regex matching its opening tag.

    Returns (start, end, inner_html) or None.
    """
    m = re.compile(pattern).search(html, start)
    if not m:
        return None
    s = m.start()
    e = match_element(html, s)
    inner = html[m.end():html.rfind("<", s, e)]
    return s, e, inner


def split_page(html):
    """Break one page into its named regions."""
    out = {}

    head_m = re.search(r"<head>(.*?)</head>", html, re.S)
    out["head"] = head_m.group(1)
    out["html_open"] = html[:head_m.start()]

    body_start = html.index("<body", head_m.end())
    body_open_end = html.index(">", body_start) + 1
    out["body_open"] = html[body_start:body_open_end]

    body = html[body_open_end:html.rindex("</body>")]

    def take(pattern, key, required=True):
        """Pull a region out of `body`, leaving the remainder behind."""
        nonlocal body
        found = find_element(body, pattern)
        if not found:
            if required:
                raise ValueError(f"missing region: {key}")
            out[key] = None
            return
        s, e, _ = found
        out[key] = body[s:e]
        body = body[:s] + body[e:]

    take(CLS % "global-styles w-embed", "global_styles")
    take(CLS % "preloader", "preloader", required=False)
    take(CLS % "cursor-wrapper", "cursor", required=False)

    wrap = find_element(body, CLS % "page-wrapper")
    if not wrap:
        raise ValueError("missing page-wrapper")
    ws, we, inner = wrap
    # The wrapper's own opening tag carries a data-w-id that drives a Webflow
    # interaction, so it has to be preserved rather than regenerated.
    out["wrapper_open"] = re.match(CLS % "page-wrapper", body[ws:]).group(0)
    out["wrapper_close"] = body[body.rfind("<", ws, we):we]
    out["before_wrapper"] = body[:ws]
    out["after_wrapper"] = body[we:]

    def take_inner(pattern, key, required=True):
        nonlocal inner
        found = find_element(inner, pattern)
        if not found:
            if required:
                raise ValueError(f"missing region: {key}")
            out[key] = None
            return
        s, e, _ = found
        out[key] = inner[s:e]
        inner = inner[:s] + inner[e:]

    take_inner(CLS % "navbar w-nav", "navbar")
    take_inner(CLS % "footer", "footer")
    take_inner(r'<a\b[^>]*class="scroll-up w-inline-block"[^>]*>', "scroll_up")

    # Whatever is left inside page-wrapper is the page's own content.
    out["content"] = inner
    return out
