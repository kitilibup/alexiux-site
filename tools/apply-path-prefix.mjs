/**
 * Rewrite root-absolute URLs so the site works under a sub-path.
 *
 * GitHub project pages serve at /<repo>/, but the mirrored Webflow markup uses
 * root-absolute paths throughout (/about, /assets/...). Those resolve to the
 * domain root, so without this every link and asset 404s on the project URL.
 *
 * Skipped entirely when a CNAME is present: on a custom domain the site is at
 * the root and the original paths are already correct.
 *
 *   node tools/apply-path-prefix.mjs _site /alexiux-site
 */

import fs from "node:fs";
import path from "node:path";

const [, , outDir = "_site", rawPrefix = ""] = process.argv;
const prefix = rawPrefix.replace(/\/+$/, "");

if (!prefix) {
  console.log("No path prefix given - leaving URLs at the root.");
  process.exit(0);
}
if (fs.existsSync(path.join(outDir, "CNAME"))) {
  console.log("CNAME present - custom domain serves at the root, skipping prefix.");
  process.exit(0);
}

/** Absolute paths that belong to this site (not protocol-relative, not external). */
const isLocal = (url) =>
  url.startsWith("/") &&
  !url.startsWith("//") &&
  !url.startsWith(`${prefix}/`) &&
  url !== prefix;

const addPrefix = (url) => (isLocal(url) ? prefix + url : url);

/** href/src/action/poster plus srcset's comma-separated candidate list. */
function rewriteMarkup(html) {
  let out = html.replace(
    /\b(href|src|action|poster)="(\/[^"]*)"/g,
    (m, attr, url) => `${attr}="${addPrefix(url)}"`
  );

  out = out.replace(/\bsrcset="([^"]*)"/g, (m, value) => {
    const rewritten = value
      .split(",")
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return candidate;
        const [url, ...rest] = trimmed.split(/\s+/);
        return [addPrefix(url), ...rest].join(" ");
      })
      .join(", ");
    return `srcset="${rewritten}"`;
  });

  // webflow.js percent-decodes these and injects the markup at runtime, so the
  // URLs inside them need the same treatment or the collection items 404.
  out = out.replace(
    /(<script type="text\/x-wf-template" id="[^"]*">)([^<]*)(<\/script>)/g,
    (m, open, payload, close) => {
      const decoded = decodeURIComponent(payload);
      const rewritten = rewriteMarkup(decoded);
      if (rewritten === decoded) return m;
      return open + encodeURIComponent(rewritten) + close;
    }
  );

  return out;
}

const rewriteCss = (css) =>
  css.replace(/url\((['"]?)(\/[^)'"]*)\1\)/g, (m, q, url) => `url(${q}${addPrefix(url)}${q})`);

function walk(dir, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, fn);
    else fn(full);
  }
}

let html = 0;
let css = 0;
walk(outDir, (file) => {
  if (file.endsWith(".html")) {
    const before = fs.readFileSync(file, "utf8");
    const after = rewriteMarkup(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
      html += 1;
    }
  } else if (file.endsWith(".css")) {
    const before = fs.readFileSync(file, "utf8");
    const after = rewriteCss(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
      css += 1;
    }
  }
});

console.log(`Applied prefix "${prefix}" to ${html} HTML and ${css} CSS files.`);
