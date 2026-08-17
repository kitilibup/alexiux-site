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

/* ------------------------------------------------- project grid ---------
 * The Work page and home page were mirrored with their project grids already
 * rendered, so adding a project in the CMS would create its page but list it
 * nowhere. These regenerate the grid from content/projects at build time.
 *
 * Webflow emitted a #w-node-... grid rule for every element of every item -
 * 64 rules for 8 items - so a 9th project would have no rules at all. Every
 * item proved to use the identical eight rules, so each generated card keeps
 * the template's ids and is styled by the rules already in the stylesheet.
 *
 * That repeats the ids across cards, which is invalid strictly speaking, but
 * CSS id selectors style every matching element, so it renders exactly as
 * Webflow did. Re-expressing the rules structurally was tried first and was
 * not faithful: id selectors outrank the class rules they were overriding,
 * and the year ended up on top of the project title.
 */

const VOID_EL = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);

/** Offsets of an element given its opening-tag match. */
function elementSpan(html, start, name) {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    const tag = m[2].toLowerCase();
    if (tag !== name || VOID_EL.has(tag) || m[4]) continue;
    if (m[1]) { if (--depth === 0) return { end: re.lastIndex, innerEnd: m.index }; }
    else depth += 1;
  }
  return null;
}

function findEl(html, pattern, from = 0) {
  const re = new RegExp(pattern, "g");
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return null;
  const name = m[0].match(/^<([a-zA-Z][a-zA-Z0-9-]*)/)[1].toLowerCase();
  const span = elementSpan(html, m.index, name);
  if (!span) return null;
  return { start: m.index, end: span.end, innerStart: m.index + m[0].length, innerEnd: span.innerEnd };
}

/** Replace the text inside the first element matching `pattern`. */
function setInner(html, pattern, value) {
  const at = findEl(html, pattern);
  if (!at) return html;
  return html.slice(0, at.innerStart) + value + html.slice(at.innerEnd);
}

const escapeHtmlText = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildCard(template, project, position) {
  let card = template;
  card = setInner(card, '<div\\b[^>]*class="text-project-description"[^>]*>',
    String(position).padStart(2, "0"));
  card = setInner(card, '<div\\b[^>]*class="text-divider"[^>]*>', escapeHtmlText(project.year || ""));
  card = setInner(card, '<h3\\b[^>]*class="case-heading"[^>]*>', escapeHtmlText(project.title || project.slug));
  card = card.replace(/href="\/project\/[^"]*"/g, `href="/project/${project.slug}"`);
  if (project.thumbnail) {
    card = card.replace(/(<img\b[^>]*class="project-thumbnail"[^>]*>)/, (tag) =>
      tag.replace(/\ssrc="[^"]*"/, ` src="${project.thumbnail}"`)
         .replace(/\s(?:srcset|sizes)="[^"]*"/g, ""));
    card = card.replace(/(<img\b[^>]*)\ssrc="[^"]*"([^>]*class="project-thumbnail")/,
      `$1 src="${project.thumbnail}"$2`);
  }
  return card;
}

/** Regenerate any project collection list found in a page body. */
function renderProjectGrid(bodyHtml, projects, totalProjectCount) {
  const grid = findEl(bodyHtml, '<div\\b[^>]*class="[^"]*w-dyn-items[^"]*"[^>]*>');
  if (!grid) return bodyHtml;

  const inner = bodyHtml.slice(grid.innerStart, grid.innerEnd);
  const first = findEl(inner, '<div\\b[^>]*class="collection-item w-dyn-item"[^>]*>');
  if (!first) return bodyHtml;

  const template = inner.slice(first.start, first.end);

  // The home page deliberately showed a curated subset (5 of 8) while Work
  // showed everything. A page that listed every project is treated as
  // unlimited so new work appears there; a shorter list keeps its limit
  // rather than silently growing.
  const shown = (inner.match(/class="collection-item w-dyn-item"/g) || []).length;
  const limited = shown > 0 && shown < totalProjectCount;
  const list = limited ? projects.slice(0, shown) : projects;

  const cards = list.map((p, i) => buildCard(template, p, i + 1)).join("");
  return bodyHtml.slice(0, grid.innerStart) + cards + bodyHtml.slice(grid.innerEnd);
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

  // Rebuild the project grids after sorting, so a project added in the CMS
  // appears in the listings rather than only at its own URL.
  const live = projects.filter((p) => !p.draft);
  for (const page of pages) {
    page.bodyHtml = renderProjectGrid(page.bodyHtml, live, live.length);
  }

  return {
    pages,
    // Drafts are editable in the CMS but never reach the built site.
    projects: projects.filter((p) => !p.draft),
    allProjects: projects,
  };
}
