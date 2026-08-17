import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

// Must match the escaping Python's html.escape(quote=True) produced when the
// values were pulled out of <head>, or the rebuilt page won't be byte-identical.
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * Substitute the CMS-owned SEO values back into the captured <head>.
 *
 * Done here in plain JS rather than through Nunjucks: the head is verbatim
 * Webflow output containing braces and quotes of its own, and running it
 * through a template engine risks it being reinterpreted.
 */
function renderHead(record) {
  const seo = record.seo || {};
  return (record.head || "").replace(
    /\{\{\s*seo\.(\w+)\s*\}\}/g,
    (_, key) => escapeHtml(seo[key] ?? "")
  );
}

const navbarCache = new Map();

function readPartial(name) {
  if (!navbarCache.has(name)) {
    navbarCache.set(
      name,
      fs.readFileSync(path.join(ROOT, "src/_includes/partials", name), "utf8")
    );
  }
  return navbarCache.get(name);
}

/**
 * Re-apply Webflow's active-link markers to the shared navbar.
 *
 * The navbar is stored once with the markers stripped, so one partial can serve
 * every page. Which anchors were active is recorded per page as positions -
 * the home page marks two of them, and several anchors share an href, so
 * positions are the only unambiguous handle.
 */
function renderNavbar(record, isProject) {
  const markup = readPartial(isProject ? "navbar-project.njk" : "navbar-main.njk");
  const active = new Set(record.navActive || []);
  if (active.size === 0) return markup;

  let i = 0;
  return markup.replace(/<a\b[^>]*>/g, (tag) => {
    if (!active.has(i++)) return tag;
    return tag
      .replace(/\sclass="/, ' aria-current="page" class="')
      .replace(/(\sclass="[^"]*)"/, '$1 w--current"');
  });
}

function loadDir(dir) {
  const full = path.join(ROOT, "content", dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const record = JSON.parse(fs.readFileSync(path.join(full, f), "utf8"));
      return {
        ...record,
        headHtml: renderHead(record),
        navbarHtml: renderNavbar(record, dir === "projects"),
      };
    });
}

export default function () {
  const pages = loadDir("pages");
  const projects = loadDir("projects");

  const order = ["index", "about", "work", "collaborate"];
  pages.sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
  projects.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.slug.localeCompare(b.slug));

  return {
    pages,
    // Drafts are editable in the CMS but never reach the built site.
    projects: projects.filter((p) => !p.draft),
    allProjects: projects,
  };
}
