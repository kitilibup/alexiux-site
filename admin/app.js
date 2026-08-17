import { CONFIG } from "./config.js";
import { GitHub, bytesToBase64 } from "./github.js";

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) {
    if (k != null) node.append(k.nodeType ? k : document.createTextNode(k));
  }
  return node;
};

const state = {
  gh: null,
  user: null,
  schemas: {},
  items: {},        // collection -> [record]
  view: { name: "projects" },
  dirty: false,     // unsaved edits in the open editor
  media: null,      // cached upload listing
};

/* ---------------------------------------------------------------- values */

const getField = (obj, path) =>
  path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

function setField(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  if (value === "" || value == null) delete cur[last];
  else cur[last] = value;
}

const slugify = (s) =>
  s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const escapeAttr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const unescapeAttr = (s) =>
  String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/* ------------------------------------------------------- body images ---
 * The case-study bodies are verbatim Webflow markup, so images live inside
 * the HTML rather than in a field of their own. Rather than make you edit
 * raw markup, these pull every <img> out for editing and write the change
 * back into the exact tag it came from - the rest of the HTML is untouched.
 */

const IMG_TAG_RE = /<img\b[^>]*>/gi;

const getAttr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? unescapeAttr(m[1]) : "";
};

function setAttr(tag, name, value) {
  const existing = new RegExp(`\\s${name}="[^"]*"`, "i");
  const attr = ` ${name}="${escapeAttr(value)}"`;
  if (existing.test(tag)) return tag.replace(existing, attr);
  // Insert before the closing bracket, keeping any self-closing slash.
  return tag.replace(/\s*(\/?)>$/, (m, slash) => `${attr}${slash ? " /" : ""}>`);
}

const parseBodyImages = (html) =>
  [...String(html || "").matchAll(IMG_TAG_RE)].map((m, i) => ({
    index: i,
    tag: m[0],
    src: getAttr(m[0], "src"),
    alt: getAttr(m[0], "alt"),
  }));

/** Replace the nth <img> tag, leaving every other byte of the body alone. */
function updateBodyImage(html, index, patch) {
  let i = 0;
  return String(html).replace(IMG_TAG_RE, (tag) => {
    if (i++ !== index) return tag;
    let out = tag;
    if (patch.src !== undefined) {
      out = setAttr(out, "src", patch.src);
      // A stale srcset would keep winning over the new src.
      out = out.replace(/\s(?:srcset|data-src|sizes)="[^"]*"/gi, "");
    }
    if (patch.alt !== undefined) out = setAttr(out, "alt", patch.alt);
    return out;
  });
}

/* ------------------------------------------------------------------ auth */

function saveToken(token) {
  sessionStorage.setItem("alexiux_cms_token", token);
}
const loadToken = () => sessionStorage.getItem("alexiux_cms_token");
function clearToken() {
  sessionStorage.removeItem("alexiux_cms_token");
}

/**
 * OAuth via the Worker. The popup posts the token back to this window; the
 * client secret never reaches the browser.
 */
function signInWithGitHub() {
  const w = window.open(
    `${CONFIG.authWorker}/auth`,
    "github-oauth",
    "width=720,height=760"
  );
  if (!w) {
    toast("Popup blocked. Allow popups for this site and try again.", "error");
    return;
  }
  const onMessage = async (event) => {
    if (new URL(CONFIG.authWorker).origin !== event.origin) return;
    if (!event.data?.token) return;
    window.removeEventListener("message", onMessage);
    saveToken(event.data.token);
    await start();
  };
  window.addEventListener("message", onMessage);
}

async function start() {
  const token = loadToken();
  if (!token) return renderLogin();

  state.gh = new GitHub({ ...CONFIG, token });
  try {
    state.user = await state.gh.user();
    await state.gh.checkAccess();
  } catch (err) {
    clearToken();
    return renderLogin(err.message);
  }
  await loadAll();
  render();
}

/* ------------------------------------------------------------------ data */

async function loadAll() {
  for (const name of CONFIG.collections) {
    state.schemas[name] = await state.gh.readJson(`content/_schema/${name}.json`);
    const files = (await state.gh.listDir(state.schemas[name].folder)).filter((f) =>
      f.name.endsWith(".json")
    );
    const records = [];
    for (const f of files) {
      const record = JSON.parse(await state.gh.readFile(f.path));
      record.__path = f.path;
      records.push(record);
    }
    sortRecords(records, state.schemas[name]);
    state.items[name] = records;
  }
}

function sortRecords(records, schema) {
  const key = schema.sortBy || "slug";
  records.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    return String(av ?? "").localeCompare(String(bv ?? ""));
  });
}

/* ----------------------------------------------------------------- views */

function renderLogin(error) {
  document.body.className = "login-body";
  document.body.replaceChildren(
    el("div", { className: "login" },
      el("h1", {}, "alexiux.com"),
      el("p", { className: "sub" }, "Content management"),
      error ? el("p", { className: "error" }, error) : null,
      CONFIG.authWorker
        ? el("button", { className: "btn primary", onclick: signInWithGitHub },
            "Sign in with GitHub")
        : el("p", { className: "hint" },
            "Sign-in isn't configured yet. Deploy the auth worker, or paste a token below."),
      el("details", { className: "token-fallback" },
        el("summary", {}, "Use a personal access token"),
        el("p", { className: "hint" },
          "Fine-grained token with Contents: read and write on this repository. " +
          "It stays in this tab only and is cleared when the tab closes."),
        el("input", { type: "password", id: "pat", placeholder: "github_pat_..." }),
        el("button", {
          className: "btn",
          onclick: async () => {
            const v = $("#pat").value.trim();
            if (!v) return;
            saveToken(v);
            await start();
          },
        }, "Continue")
      )
    )
  );
}

function render() {
  document.body.className = "";
  document.body.replaceChildren(
    el("aside", { className: "sidebar" },
      el("div", { className: "brand" }, "alexiux.com"),
      ...CONFIG.collections.map((name) =>
        el("button", {
          className: "nav-item" + (state.view.name === name ? " active" : ""),
          onclick: () => go({ name }),
        }, state.schemas[name].label)
      ),
      el("button", {
        className: "nav-item" + (state.view.name === "media" ? " active" : ""),
        onclick: () => go({ name: "media" }),
      }, "Media"),
      el("div", { className: "spacer" }),
      el("div", { className: "user" },
        state.user.avatar_url
          ? el("img", { src: state.user.avatar_url, alt: "", width: 24, height: 24 })
          : null,
        el("span", {}, state.user.login),
        el("button", {
          className: "link",
          onclick: () => { clearToken(); renderLogin(); },
        }, "Sign out")
      )
    ),
    el("main", { className: "main", id: "main" })
  );
  renderMain();
}

function go(view) {
  if (state.dirty && !confirm("Discard unsaved changes?")) return;
  state.dirty = false;
  state.view = view;
  if (document.querySelector(".sidebar")) render();
  else renderMain();
}

function renderMain() {
  const main = $("#main");
  if (!main) return;
  const { name, slug } = state.view;
  if (name === "media") return main.replaceChildren(mediaView());
  if (slug !== undefined) return main.replaceChildren(editorView(name, slug));
  main.replaceChildren(listView(name));
}

/* ------------------------------------------------------------ list view */

function listView(collection) {
  const schema = state.schemas[collection];
  const records = state.items[collection];

  const rows = records.map((r) =>
    el("tr", { className: r.draft ? "is-draft" : "" },
      el("td", { className: "thumb-cell" },
        r.thumbnail ? el("img", { src: "../" + r.thumbnail.replace(/^\//, ""), alt: "" }) : null),
      el("td", {},
        el("button", {
          className: "link strong",
          onclick: () => go({ name: collection, slug: r.slug }),
        }, r[schema.titleField] || r.slug),
        el("div", { className: "muted" }, "/" + (collection === "projects" ? "project/" : "") + r.slug)
      ),
      el("td", { className: "muted" }, r.year || ""),
      el("td", { className: "muted" }, r.order ?? ""),
      el("td", {}, r.draft ? el("span", { className: "badge" }, "Draft") : ""),
      el("td", { className: "row-actions" },
        schema.fixed ? null : el("button", {
          className: "link",
          onclick: () => duplicateRecord(collection, r),
        }, "Duplicate"),
        schema.fixed ? null : el("button", {
          className: "link danger",
          onclick: () => removeRecord(collection, r),
        }, "Delete")
      )
    )
  );

  return el("div", { className: "page" },
    el("header", { className: "page-head" },
      el("h1", {}, schema.label),
      schema.fixed ? null : el("button", {
        className: "btn primary",
        onclick: () => newRecord(collection),
      }, `New ${schema.singular.toLowerCase()}`)
    ),
    schema.note ? el("p", { className: "hint" }, schema.note) : null,
    el("table", { className: "table" },
      el("thead", {},
        el("tr", {}, el("th", {}, ""), el("th", {}, "Name"), el("th", {}, "Year"),
          el("th", {}, "Order"), el("th", {}, ""), el("th", {}, ""))),
      el("tbody", {}, ...rows)
    ),
    records.length ? null : el("p", { className: "hint" }, "Nothing here yet.")
  );
}

/* ---------------------------------------------------------- editor view */

function editorView(collection, slug) {
  const schema = state.schemas[collection];
  const original = state.items[collection].find((r) => r.slug === slug);
  if (!original) return el("p", { className: "hint" }, "Not found.");

  // Edit a copy, so navigating away without saving changes nothing.
  const draft = JSON.parse(JSON.stringify(original));
  const groups = new Map();
  for (const field of schema.fields) {
    const g = field.group || "Details";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(field);
  }

  const status = el("span", { className: "status" });
  const markDirty = () => {
    state.dirty = true;
    status.textContent = "Unsaved changes";
    status.className = "status warn";
  };

  const body = [...groups.entries()].map(([groupName, fields]) =>
    el("section", { className: "group" },
      el("h2", {}, groupName),
      ...fields.map((f) => fieldControl(f, draft, markDirty))
    )
  );

  return el("div", { className: "page" },
    el("header", { className: "page-head" },
      el("div", {},
        el("button", { className: "link", onclick: () => go({ name: collection }) },
          "← " + schema.label),
        el("h1", {}, draft[schema.titleField] || draft.slug)
      ),
      el("div", { className: "actions" },
        status,
        el("button", {
          className: "btn primary",
          onclick: (e) => saveRecord(collection, original, draft, e.target, status),
        }, "Save")
      )
    ),
    ...body
  );
}

/* -------------------------------------------------------- rich text ---
 * Editing text inside verbatim Webflow markup.
 *
 * The body is generated markup whose structure carries the layout (grid
 * classes) and the animations (data-w-id). Feeding the whole thing through a
 * DOM parser and re-serialising would silently renormalise it - attribute
 * order, self-closing tags, entities - so the approach here is the same as
 * the image manager: locate each text block's exact offsets in the original
 * string, and replace only the bytes inside it.
 *
 * That also means you can edit copy without ever being able to break the
 * layout, which mirrors how Webflow's Editor works.
 */

// Tags that make an element a structural container rather than a text block.
const BLOCK_CHILD_RE = /<(div|section|figure|ul|ol|img|table|form|script|iframe|svg|video)\b/i;
const TEXT_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "figcaption", "blockquote", "div"];
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"]);

/** Index just past the close of the element whose opening tag starts at `start`. */
function matchElementEnd(html, start, name) {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  tagRe.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[2].toLowerCase();
    if (tag === "script" && !m[1]) {
      const close = html.indexOf("</script>", tagRe.lastIndex);
      if (close === -1) break;
      tagRe.lastIndex = close + 9;
      continue;
    }
    if (tag !== name || VOID_TAGS.has(tag) || m[4]) continue;
    if (m[1]) {
      if (--depth === 0) return { end: tagRe.lastIndex, innerEnd: m.index };
    } else {
      depth += 1;
    }
  }
  return null;
}

/** Every leaf text element, in document order, with exact string offsets. */
function findTextBlocks(html) {
  const source = String(html || "");
  const openRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  const blocks = [];
  let m;
  while ((m = openRe.exec(source))) {
    const tag = m[1].toLowerCase();
    if (!TEXT_TAGS.includes(tag) || m[2].endsWith("/")) continue;

    const found = matchElementEnd(source, m.index, tag);
    if (!found) continue;

    const innerStart = m.index + m[0].length;
    const inner = source.slice(innerStart, found.innerEnd);

    // Structural elements are skipped; their text lives in their children.
    if (BLOCK_CHILD_RE.test(inner)) continue;
    if (!inner.replace(/<[^>]+>/g, "").trim()) continue;

    const cls = (m[2].match(/class="([^"]*)"/) || [, ""])[1];
    blocks.push({ tag, cls, inner, innerStart, innerEnd: found.innerEnd });
  }
  return blocks;
}

/** Replace one block's inner HTML, leaving every other byte untouched. */
function replaceTextBlock(html, block, newInner) {
  return html.slice(0, block.innerStart) + newInner + html.slice(block.innerEnd);
}

/**
 * Keep only inline formatting. Anything pasted from Word or another site
 * arrives with fonts, colours and spans that would fight the site's styles.
 */
function sanitizeInline(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild;
  const ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, A: 1, BR: 1, U: 1 };

  (function walk(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) { child.remove(); continue; }
      walk(child);
      if (!ALLOWED[child.tagName]) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        const keep = child.tagName === "A" && attr.name === "href";
        if (!keep) child.removeAttribute(attr.name);
      }
      if (child.tagName === "A") {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener");
      }
    }
  })(root);

  return root.innerHTML;
}

/** Recommended lengths before search engines start truncating. */
const SEO_LIMITS = { "seo.title": 60, "seo.description": 160 };

/** Live approximation of the Google result for this page. */
function seoPreview(draft) {
  const node = el("div", { className: "seo-preview" });

  const paint = () => {
    const title = getField(draft, "seo.title") || draft.title || draft.slug;
    const desc = getField(draft, "seo.description") || "";
    const slug = draft.slug === "index" ? "" : draft.slug;
    node.replaceChildren(
      el("div", { className: "seo-url" }, "alexiux.com" + (slug ? " › " + slug : "")),
      el("div", { className: "seo-title" }, String(title).slice(0, 60)),
      el("div", { className: "seo-desc" },
        desc ? desc.slice(0, 160) : "No meta description — search engines will invent one from the page text."),
      el("p", { className: "hint" },
        "This is roughly how the page appears in search results.")
    );
  };

  paint();
  node.addEventListener("seo:refresh", paint);
  return node;
}

const refreshSeoPreview = () =>
  document.querySelector(".seo-preview")?.dispatchEvent(new CustomEvent("seo:refresh"));

/**
 * Text and images together, in the order they appear on the page.
 *
 * findTextBlocks skips any element containing an <img>, so the two sets never
 * overlap and can be merged by position into a single document view.
 */
function findBodyBlocks(html) {
  const source = String(html || "");

  const text = findTextBlocks(source).map((b, i) => ({
    ...b, kind: "text", index: i, at: b.innerStart,
  }));

  const images = [...source.matchAll(IMG_TAG_RE)].map((m, i) => ({
    kind: "image",
    index: i,
    at: m.index,
    tag: m[0],
    src: getAttr(m[0], "src"),
    alt: getAttr(m[0], "alt"),
  }));

  return [...text, ...images].sort((a, b) => a.at - b.at);
}

/** Human label for a block, so you can tell which bit of the page it is. */
function blockLabel(block) {
  if (/^h[1-6]$/.test(block.tag)) return block.tag.toUpperCase();
  const cls = (block.cls || "").split(/\s+/)[0] || "";
  if (/heading/i.test(cls)) return "Heading";
  if (/description|paragraph|rich/i.test(cls)) return "Paragraph";
  if (cls) return cls.replace(/-/g, " ");
  return block.tag === "p" ? "Paragraph" : "Text";
}

/**
 * WYSIWYG editing for the page copy.
 *
 * Each text block is its own contenteditable, so the surrounding structure -
 * and the animations bound to it - can't be disturbed.
 */
/**
 * One WYSIWYG surface for the whole page body.
 *
 * The body is rendered inside an iframe carrying the site's own stylesheets,
 * so you edit the page as it actually looks rather than a list of fields. An
 * iframe rather than an inline div because the site's CSS is 168KB of global
 * rules that would otherwise style the CMS itself.
 *
 * Structure is still protected: the layout containers are marked
 * non-editable, so text and images can be changed but the grid and the
 * animations bound to it can't be dismantled.
 */
/*
 * Content stores root-absolute paths (/assets/img/...). On a project-pages
 * deploy the site lives under /<repo>/, so inside the editor those resolve to
 * the domain root and every image 404s. They are rebased for display and
 * un-rebased on save, so what is stored never changes.
 */
const SITE_BASE = location.pathname.replace(/\/admin\/?$/, "");

const toEditorHtml = (html) =>
  SITE_BASE ? String(html).replace(/(src|href)="\/assets\//g, `$1="${SITE_BASE}/assets/`) : String(html);

const fromEditorHtml = (html) =>
  SITE_BASE
    ? String(html).replace(new RegExp(`(src|href)="${SITE_BASE}/assets/`, "g"), '$1="/assets/')
    : String(html);

function richTextPanel(draft, fieldName, markDirty) {
  const frame = el("iframe", { className: "rt-frame", title: "Page content" });
  const status = el("span", { className: "rt-status" });

  /*
   * execCommand acts on the *focused* document's current selection. Focusing
   * after the call is too late, and any dialog - a prompt(), or even clicking
   * an input in the toolbar - collapses the selection before the command runs.
   * So the range is captured as it changes and restored immediately before
   * every command.
   */
  let savedRange = null;

  const saveSelection = () => {
    const sel = frame.contentDocument?.getSelection();
    if (sel && sel.rangeCount && root?.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    const sel = frame.contentDocument?.getSelection();
    if (!sel || !savedRange) return false;
    sel.removeAllRanges();
    sel.addRange(savedRange);
    return true;
  };

  /*
   * Formatting is applied by rewriting the range directly rather than through
   * execCommand, which only acts on the focused document and silently does
   * nothing when focus is anywhere else - the toolbar, another pane, a dialog.
   * It is also deprecated. Range surgery is deterministic and testable.
   */
  const ancestor = (tagNames) => {
    const node = savedRange?.startContainer;
    const start = node?.nodeType === 1 ? node : node?.parentElement;
    return start?.closest?.(tagNames.join(",")) || null;
  };

  const unwrap = (node) => {
    const parent = node.parentNode;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  };

  /** Wrap the current selection, or unwrap it if already wrapped. */
  const toggleWrap = (tagName, tagNames) => {
    const doc = frame.contentDocument;
    if (!doc || !savedRange) return null;

    const existing = ancestor(tagNames);
    if (existing && root.contains(existing)) {
      unwrap(existing);
      commit();
      fit();
      return null;
    }
    if (savedRange.collapsed) return null;

    const node = doc.createElement(tagName);
    const range = savedRange.cloneRange();
    try {
      node.appendChild(range.extractContents());
      range.insertNode(node);
    } catch {
      return null;   // selection spanned element boundaries
    }
    // Keep the same text selected so formatting can be stacked.
    const after = doc.createRange();
    after.selectNodeContents(node);
    savedRange = after.cloneRange();
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);

    commit();
    fit();
    return node;
  };

  /** The <a> containing the current selection, if any. */
  const currentLink = () => {
    const node = savedRange?.startContainer;
    const elNode = node?.nodeType === 1 ? node : node?.parentElement;
    return elNode?.closest?.("a") || null;
  };

  const linkInput = el("input", { type: "url", placeholder: "https://example.com" });
  const linkApply = el("button", { className: "btn small" }, "Apply");
  const linkRemove = el("button", { className: "btn small" }, "Remove");
  const linkBar = el("div", { className: "rt-linkbar", hidden: true },
    el("label", {}, "Link"), linkInput, linkApply, linkRemove,
    el("button", { className: "link", onclick: () => { linkBar.hidden = true; } }, "Cancel")
  );

  const openLinkEditor = () => {
    saveSelection();
    const existing = currentLink();
    const sel = frame.contentDocument?.getSelection();
    if (!existing && (!sel || sel.isCollapsed)) {
      toast("Select some text first, then add the link.", "error");
      return;
    }
    linkInput.value = existing ? existing.getAttribute("href") || "" : "";
    linkRemove.hidden = !existing;
    linkBar.hidden = false;
    linkInput.focus();
    linkInput.select();
  };

  linkApply.onclick = () => {
    const url = linkInput.value.trim();
    if (!url) return;
    const existing = currentLink();
    if (existing) {
      existing.setAttribute("href", url);
      commit();
    } else {
      const made = toggleWrap("a", ["a"]);
      if (made) {
        made.setAttribute("href", url);
        // Links leaving the site should not hand over the tab or referrer.
        if (/^https?:\/\//i.test(url)) {
          made.setAttribute("target", "_blank");
          made.setAttribute("rel", "noopener");
        }
        commit();
      }
    }
    linkBar.hidden = true;
  };

  linkRemove.onclick = () => {
    const existing = currentLink();
    if (existing && root.contains(existing)) {
      unwrap(existing);
      commit();
    }
    linkBar.hidden = true;
  };

  const toolbar = el("div", { className: "rt-toolbar" },
    el("button", { className: "rt-btn", title: "Bold",
      onmousedown: (e) => { e.preventDefault(); toggleWrap("strong", ["strong", "b"]); } }, "B"),
    el("button", { className: "rt-btn ital", title: "Italic",
      onmousedown: (e) => { e.preventDefault(); toggleWrap("em", ["em", "i"]); } }, "I"),
    el("button", { className: "rt-btn", title: "Add or edit a link",
      onmousedown: (e) => { e.preventDefault(); openLinkEditor(); } }, "Link"),
    el("span", { className: "rt-sep" }),
    el("span", { className: "hint" }, "Select text to format it, or click an image"),
    status
  );

  // Settings for the selected image, alongside the canvas.
  const panelPreview = el("img", { className: "ip-preview", alt: "" });
  const panelName = el("code", { className: "src-label" });
  const panelAlt = el("input", { type: "text", placeholder: "Describe this image…" });
  const panelReplace = el("button", { className: "btn small" }, "Replace image");
  const panelEmpty = el("p", { className: "hint ip-empty" },
    "Select an image in the page to replace it or edit its alt text.");
  const panelFields = el("div", { className: "ip-fields", hidden: true },
    panelPreview,
    panelName,
    el("label", { className: "alt-label" }, "Alt text"),
    panelAlt,
    el("p", { className: "hint" }, "Describes the image for screen readers and search engines."),
    panelReplace
  );
  const imagePanel = el("div", { className: "image-panel" },
    el("div", { className: "ip-head" }, "Image"),
    panelEmpty,
    panelFields
  );

  let root = null;

  const commit = () => {
    if (!root) return;
    const html = fromEditorHtml(root.innerHTML);
    if (html === getField(draft, fieldName)) return;
    setField(draft, fieldName, html);
    markDirty();
    status.textContent = "edited";
  };

  const fit = () => {
    const doc = frame.contentDocument;
    if (doc?.body) frame.style.height = doc.body.scrollHeight + 40 + "px";
  };

  let ready = false;

  const init = () => {
    if (ready) return;
    const doc = frame.contentDocument;
    root = doc?.getElementById("cms-root");
    if (!root) return;
    ready = true;

    root.contentEditable = "true";

    // Keep the page's own structure intact: only text and images are editable.
    for (const node of root.querySelectorAll("script,iframe,video,svg")) {
      node.setAttribute("contenteditable", "false");
    }

    root.addEventListener("input", () => { commit(); fit(); });
    for (const ev of ["mouseup", "keyup", "selectionchange"]) {
      (ev === "selectionchange" ? doc : root).addEventListener(ev, saveSelection);
    }
    root.addEventListener("blur", commit, true);

    // Pasting keeps text only, so foreign markup and styling never arrive.
    root.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || frame.contentWindow.clipboardData).getData("text/plain");
      doc.execCommand("insertText", false, text);
    });

    // Selecting an image opens its settings, the way Webflow does.
    root.addEventListener("click", (e) => {
      const img = e.target.closest?.("img");
      for (const prev of root.querySelectorAll("img.cms-selected")) {
        prev.classList.remove("cms-selected");
      }
      if (!img) return hideImagePanel();
      e.preventDefault();
      img.classList.add("cms-selected");
      showImagePanel(img);
    });

    function hideImagePanel() {
      panelFields.hidden = true;
      panelEmpty.hidden = false;
    }

    function showImagePanel(img) {
      panelFields.hidden = false;
      panelEmpty.hidden = true;
      const src = img.getAttribute("src") || "";
      panelPreview.src = src;
      panelName.textContent = src.split("/").pop() || src;
      panelAlt.value = img.getAttribute("alt") || "";
      panelAlt.className = panelAlt.value ? "" : "needs-alt";

      panelAlt.oninput = () => {
        img.setAttribute("alt", panelAlt.value);
        panelAlt.className = panelAlt.value ? "" : "needs-alt";
        commit();
      };

      panelReplace.onclick = async () => {
        const picked = await pickImage();
        if (!picked) return;
        // Rebase for display; commit() converts it back on the way out.
        img.setAttribute("src", toEditorHtml(`src="${picked}"`).slice(5, -1));
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
        panelPreview.src = img.getAttribute("src");
        panelName.textContent = picked.split("/").pop();
        commit();
        fit();
      };
    }

    fit();
    setTimeout(fit, 600);
  };

  // srcdoc doesn't reliably fire `load` before the document is reachable, so
  // initialisation is attempted from both, and init() is idempotent.
  frame.addEventListener("load", init);
  const poll = setInterval(() => {
    init();
    if (ready) clearInterval(poll);
  }, 60);
  setTimeout(() => clearInterval(poll), 10000);

  // srcdoc rather than document.write: it keeps the frame same-origin while
  // letting the site's stylesheets load by relative path.
  // The page's own <style> blocks live in its <head>; without them the editor
  // is missing rules the real page has, such as figcaption spacing.
  const pageStyles = (String(draft.head || "").match(/<style>[\s\S]*?<\/style>/gi) || []).join("");
  const body = toEditorHtml(getField(draft, fieldName) || "");
  frame.srcdoc =
    "<!doctype html><html><head><meta charset='utf-8'>" +
    (CONFIG.siteCss || []).map((h) => `<link rel="stylesheet" href="${h}">`).join("") +
    "<style>html,body{margin:0;background:#fff}" +
    "#cms-root{outline:none}" +
    "#cms-root img{cursor:pointer}" +
    "#cms-root img:hover{outline:2px solid #2b2bff;outline-offset:2px;" +
    "box-shadow:0 0 0 9999px rgba(43,43,255,.04)}" +
    "#cms-root img.cms-selected{outline:2px solid #2b2bff;outline-offset:2px}" +
    "</style>" + pageStyles + "</head><body><div class='page-wrapper'><div id='cms-root'>" +
    body +
    "</div></div></body></html>";

  return el("div", { className: "rt-wrap" }, toolbar, linkBar,
    el("div", { className: "rt-body" }, frame, imagePanel));
}

/** One image, inline in the document flow: preview, replace, alt text. */
function imageBlockRow(block, draft, fieldName, markDirty, rebuild) {
  const preview = el("img", { src: "../" + block.src.replace(/^\//, ""), alt: "", loading: "lazy" });
  preview.onerror = () => preview.classList.add("missing");

  const altInput = el("input", {
    type: "text",
    value: block.alt,
    placeholder: "Describe this image…",
    className: block.alt ? "" : "needs-alt",
  });
  altInput.oninput = () => {
    setField(draft, fieldName,
      updateBodyImage(getField(draft, fieldName), block.index, { alt: altInput.value }));
    altInput.className = altInput.value ? "" : "needs-alt";
    markDirty();
  };

  const replace = el("button", {
    className: "btn small",
    onclick: async () => {
      const picked = await pickImage();
      if (!picked) return;
      setField(draft, fieldName,
        updateBodyImage(getField(draft, fieldName), block.index, { src: picked }));
      markDirty();
      rebuild();
    },
  }, "Replace");

  return el("div", { className: "rt-block is-image" },
    el("div", { className: "rt-head" },
      el("span", { className: "rt-tag" }, "Image"),
      el("div", { className: "rt-tools" }, replace)
    ),
    el("div", { className: "img-row" },
      el("div", { className: "img-row-thumb" }, preview),
      el("div", { className: "img-row-body" },
        el("code", { className: "src-label" }, block.src.split("/").pop() || block.src),
        el("label", { className: "alt-label" }, "Alt text"),
        altInput
      )
    )
  );
}

/** One editable text block. */
function textBlockRow(block, draft, fieldName, markDirty) {
  const i = block.index;
  const editor = el("div", { className: "rt-editable" });
  editor.contentEditable = "true";
  editor.innerHTML = block.inner;
  editor.spellcheck = true;

  // Blocks are located by offset, so committing on blur avoids
  // recomputing positions on every keystroke.
  const commit = () => {
    const cleaned = sanitizeInline(editor.innerHTML);
    if (cleaned === block.inner) return;
    const current = getField(draft, fieldName);
    const fresh = findTextBlocks(current)[i];
    if (!fresh) return;
    setField(draft, fieldName, replaceTextBlock(current, fresh, cleaned));
    block.inner = cleaned;
    markDirty();
  };
  editor.addEventListener("blur", commit);

  // Paste as plain text: pasted markup would drag foreign styling in.
  editor.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  // Enter inserts a line break rather than a new block, which would
  // change the document structure.
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
    }
  });

  const cmd = (name, label, title) =>
    el("button", {
      className: "rt-btn", title,
      // Keep focus in the editable so the command applies to the selection.
      onmousedown: (e) => { e.preventDefault(); document.execCommand(name); commit(); },
    }, label);

  const linkBtn = el("button", {
    className: "rt-btn", title: "Add or edit a link",
    onmousedown: (e) => {
      e.preventDefault();
      const url = prompt("Link URL (leave empty to remove the link):", "");
      if (url === null) return;
      document.execCommand(url ? "createLink" : "unlink", false, url || undefined);
      commit();
    },
  }, "Link");

  return el("div", { className: "rt-block" },
    el("div", { className: "rt-head" },
      el("span", { className: "rt-tag" }, blockLabel(block)),
      el("div", { className: "rt-tools" },
        cmd("bold", "B", "Bold"), cmd("italic", "I", "Italic"), linkBtn)
    ),
    editor
  );
}

/**
 * Every image in the page body, with a preview, a replace button and an alt
 * field. Edits are written straight back into the markup.
 */
function bodyImagesPanel(draft, fieldName, markDirty) {
  const wrap = el("div", { className: "img-manager" });

  const rebuild = () => {
    const images = parseBodyImages(getField(draft, fieldName));
    if (!images.length) {
      wrap.replaceChildren(el("p", { className: "hint" }, "No images in this page body."));
      return;
    }

    wrap.replaceChildren(
      el("p", { className: "hint" },
        `${images.length} image${images.length === 1 ? "" : "s"}. ` +
        "Alt text describes the image for screen readers and search engines; " +
        "leave it empty only for purely decorative images."),
      ...images.map((img) => {
        const preview = el("img", {
          src: "../" + img.src.replace(/^\//, ""),
          alt: "",
          loading: "lazy",
        });
        preview.onerror = () => preview.classList.add("missing");

        const srcLabel = el("code", { className: "src-label" },
          img.src.split("/").pop() || img.src);

        const altInput = el("input", {
          type: "text",
          value: img.alt,
          placeholder: "Describe this image…",
          className: img.alt ? "" : "needs-alt",
        });
        altInput.oninput = () => {
          setField(draft, fieldName,
            updateBodyImage(getField(draft, fieldName), img.index, { alt: altInput.value }));
          altInput.className = altInput.value ? "" : "needs-alt";
          markDirty();
        };

        const replace = el("button", {
          className: "btn small",
          onclick: async () => {
            const picked = await pickImage();
            if (!picked) return;
            setField(draft, fieldName,
              updateBodyImage(getField(draft, fieldName), img.index, { src: picked }));
            markDirty();
            rebuild();
          },
        }, "Replace");

        return el("div", { className: "img-row" },
          el("div", { className: "img-row-thumb" }, preview),
          el("div", { className: "img-row-body" },
            el("div", { className: "img-row-top" }, srcLabel, replace),
            el("label", { className: "alt-label" }, "Alt text"),
            altInput
          )
        );
      })
    );
  };

  rebuild();
  return wrap;
}

function fieldControl(field, draft, markDirty) {
  const value = getField(draft, field.name) ?? "";
  const id = "f_" + field.name.replace(/\./g, "_");
  let input;

  const limit = SEO_LIMITS[field.name];
  const counter = limit ? el("span", { className: "counter" }) : null;

  const paintCounter = () => {
    if (!counter) return;
    const n = String(getField(draft, field.name) ?? "").length;
    counter.textContent = `${n}/${limit}`;
    counter.className = "counter" + (n > limit ? " over" : n === 0 ? " empty" : " ok");
  };

  const onInput = (v) => {
    setField(draft, field.name, v);
    markDirty();
    paintCounter();
    if (field.name.startsWith("seo.") || field.name === "title") refreshSeoPreview();
  };

  switch (field.type) {
    case "toggle":
      input = el("input", { type: "checkbox", id, checked: !!value });
      input.onchange = () => onInput(input.checked);
      break;

    case "number":
      input = el("input", { type: "number", id, value });
      input.oninput = () => onInput(input.value === "" ? "" : Number(input.value));
      break;

    case "textarea":
      input = el("textarea", { id, rows: 3, value });
      input.oninput = () => onInput(input.value);
      break;

    case "seoPreview":
      input = seoPreview(draft);
      break;

    case "html":
      input = el("textarea", { id, rows: 18, value, className: "code" });
      input.oninput = () => onInput(input.value);
      break;

    case "image":
      input = el("div", { className: "image-field" },
        el("input", { type: "text", id, value, placeholder: "/assets/uploads/..." }),
        el("button", {
          className: "btn small",
          onclick: async () => {
            const picked = await pickImage();
            if (picked) {
              $("#" + id).value = picked;
              onInput(picked);
              refreshPreview();
            }
          },
        }, "Choose")
      );
      $("input", input).oninput = () => { onInput($("input", input).value); refreshPreview(); };
      break;

    case "slug":
      input = el("input", { type: "text", id, value });
      input.oninput = () => onInput(slugify(input.value));
      break;

    case "images":
      input = bodyImagesPanel(draft, field.name, markDirty);
      break;

    case "richtext":
      input = richTextPanel(draft, field.name, markDirty);
      break;

    default:
      input = el("input", { type: "text", id, value });
      input.oninput = () => onInput(input.value);
  }

  const preview = el("div", { className: "img-preview" });
  function refreshPreview() {
    const v = getField(draft, field.name);
    preview.replaceChildren(
      v ? el("img", { src: "../" + String(v).replace(/^\//, ""), alt: "" }) : ""
    );
  }
  if (field.type === "image") refreshPreview();

  if (counter) paintCounter();

  return el("div", { className: "field" },
    el("label", { htmlFor: id },
      field.label,
      field.required ? el("span", { className: "req" }, "*") : null,
      counter),
    input,
    field.type === "image" ? preview : null,
    field.help ? el("p", { className: "hint" }, field.help) : null
  );
}

/* --------------------------------------------------------------- actions */

async function saveRecord(collection, original, draft, button, status) {
  const schema = state.schemas[collection];
  for (const f of schema.fields) {
    if (f.required && !getField(draft, f.name)) {
      return toast(`${f.label} is required.`, "error");
    }
    const v = getField(draft, f.name);
    if (f.pattern && v && !new RegExp(f.pattern).test(String(v))) {
      return toast(`${f.label} doesn't look right.`, "error");
    }
  }

  const renamed = draft.slug !== original.slug;
  if (renamed && state.items[collection].some((r) => r.slug === draft.slug)) {
    return toast(`Another entry already uses the slug "${draft.slug}".`, "error");
  }

  button.disabled = true;
  status.textContent = "Saving…";
  status.className = "status";

  const payload = { ...draft };
  delete payload.__path;
  const path = `${schema.folder}/${draft.slug}.json`;

  try {
    await state.gh.writeFile(
      path,
      JSON.stringify(payload, null, 2) + "\n",
      `CMS: update ${collection}/${draft.slug}`
    );
    if (renamed) {
      await state.gh.deleteFile(original.__path, `CMS: rename ${original.slug} to ${draft.slug}`);
    }
    Object.assign(original, payload, { __path: path });
    sortRecords(state.items[collection], schema);
    state.dirty = false;
    status.textContent = "Saved";
    status.className = "status ok";
    toast("Saved. The site rebuilds automatically — give it a minute.");
    watchBuild();
  } catch (err) {
    status.textContent = "Not saved";
    status.className = "status warn";
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
}

/**
 * Ask for a name and a template.
 *
 * A page cannot be built from nothing: head, wrapper, footer and scripts are
 * structural, and the body is Webflow markup whose layout lives in generated
 * classes. So a new page always starts from an existing one - the choice is
 * which, rather than whether.
 */
function chooseTemplate(collection) {
  const schema = state.schemas[collection];
  const items = state.items[collection];

  return new Promise((resolve) => {
    let picked = items[0] || null;

    const nameInput = el("input", {
      type: "text",
      placeholder: `${schema.singular} name`,
      id: "new-name",
    });

    const grid = el("div", { className: "media-grid tpl-grid" });
    const paint = () => {
      grid.replaceChildren(
        ...items.map((r) =>
          el("button", {
            className: "media-item pick tpl" + (picked === r ? " selected" : ""),
            onclick: () => { picked = r; paint(); },
          },
            r.thumbnail
              ? el("img", { src: "../" + r.thumbnail.replace(/^\//, ""), alt: "", loading: "lazy" })
              : el("div", { className: "tpl-noimg" }, "No image"),
            el("figcaption", {}, r.title || r.slug),
            el("span", { className: "tpl-meta" },
              `${parseBodyImages(r.bodyHtml).length} images`)
          )
        )
      );
    };
    paint();

    const close = (value) => { overlay.remove(); resolve(value); };

    const create = el("button", { className: "btn primary" }, `Create ${schema.singular.toLowerCase()}`);
    create.onclick = () => {
      const title = nameInput.value.trim();
      if (!title) return toast("Give it a name first.", "error");
      if (!picked) return toast("Pick a template first.", "error");
      const slug = slugify(title);
      if (!slug) return toast("That name doesn't produce a usable slug.", "error");
      if (items.some((r) => r.slug === slug)) {
        return toast(`"${slug}" already exists.`, "error");
      }
      close({ title, slug, template: picked });
    };

    const overlay = el("div", { className: "overlay" },
      el("div", { className: "modal" },
        el("header", {},
          el("h2", {}, `New ${schema.singular.toLowerCase()}`),
          el("button", { className: "link", onclick: () => close(null) }, "Close")
        ),
        el("div", { className: "field" },
          el("label", { htmlFor: "new-name" }, "Name"),
          nameInput
        ),
        el("div", { className: "field" },
          el("label", {}, "Start from"),
          el("p", { className: "hint" },
            "The new page copies this one's layout and content, which you then edit. " +
            "Pick whichever is closest to what you want to build."),
          grid
        ),
        el("div", { className: "modal-actions" }, create)
      )
    );

    document.body.append(overlay);
    nameInput.focus();
  });
}

async function newRecord(collection) {
  const schema = state.schemas[collection];
  if (!state.items[collection].length) {
    return toast("Need at least one existing entry to use as a template.", "error");
  }

  const chosen = await chooseTemplate(collection);
  if (!chosen) return;
  const { title, slug, template } = chosen;

  const record = {
    slug,
    title,
    year: String(new Date().getFullYear()),
    order: Math.max(0, ...state.items[collection].map((r) => r.order ?? 0)) + 1,
    thumbnail: null,
    draft: true,
    seo: { title, ogTitle: title },
    navActive: template.navActive,
    head: template.head,
    htmlOpen: template.htmlOpen,
    bodyOpen: template.bodyOpen,
    wrapperOpen: template.wrapperOpen,
    wrapperClose: template.wrapperClose,
    bodyHtml: template.bodyHtml,
    footerHtml: template.footerHtml,
    scriptsHtml: template.scriptsHtml,
  };

  try {
    const path = `${schema.folder}/${slug}.json`;
    await state.gh.writeFile(path, JSON.stringify(record, null, 2) + "\n",
      `CMS: create ${collection}/${slug}`);
    record.__path = path;
    state.items[collection].push(record);
    sortRecords(state.items[collection], schema);
    toast(`Created "${title}" as a draft. Edit it, then untick Draft to publish.`);
    go({ name: collection, slug });
  } catch (err) {
    toast(err.message, "error");
  }
}

/** Copy an entry, using it as its own template. */
async function duplicateRecord(collection, source) {
  const schema = state.schemas[collection];
  const base = `${source.title || source.slug} copy`;
  let slug = slugify(base);
  let n = 2;
  while (state.items[collection].some((r) => r.slug === slug)) slug = `${slugify(base)}-${n++}`;

  const record = JSON.parse(JSON.stringify(source));
  delete record.__path;
  Object.assign(record, {
    slug,
    title: base,
    draft: true,
    order: Math.max(0, ...state.items[collection].map((r) => r.order ?? 0)) + 1,
  });

  try {
    const path = `${schema.folder}/${slug}.json`;
    await state.gh.writeFile(path, JSON.stringify(record, null, 2) + "\n",
      `CMS: duplicate ${collection}/${source.slug}`);
    record.__path = path;
    state.items[collection].push(record);
    sortRecords(state.items[collection], schema);
    toast(`Duplicated as a draft: "${base}".`);
    go({ name: collection, slug });
  } catch (err) {
    toast(err.message, "error");
  }
}

async function removeRecord(collection, record) {
  if (!confirm(`Delete "${record.title || record.slug}"? This cannot be undone from here.`)) return;
  try {
    await state.gh.deleteFile(record.__path, `CMS: delete ${collection}/${record.slug}`);
    state.items[collection] = state.items[collection].filter((r) => r !== record);
    renderMain();
    toast("Deleted.");
    watchBuild();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ----------------------------------------------------------------- media */

async function loadMedia(force = false) {
  if (state.media && !force) return state.media;
  const files = await state.gh.listDir(CONFIG.uploadPath);
  state.media = files
    .filter((f) => f.type === "file" && /\.(avif|webp|png|jpe?g|gif|svg)$/i.test(f.name))
    .map((f) => ({ name: f.name, path: "/" + f.path }));
  return state.media;
}

function mediaView() {
  const grid = el("div", { className: "media-grid" }, "Loading…");

  const refresh = async () => {
    const files = await loadMedia(true);
    grid.replaceChildren(
      ...(files.length
        ? files.map((f) =>
            el("figure", { className: "media-item" },
              el("img", { src: "../" + f.path.replace(/^\//, ""), alt: f.name, loading: "lazy" }),
              el("figcaption", {}, f.name),
              el("button", {
                className: "link",
                onclick: () => {
                  navigator.clipboard?.writeText(f.path);
                  toast("Path copied: " + f.path);
                },
              }, "Copy path")
            )
          )
        : [el("p", { className: "hint" }, "No uploads yet.")])
    );
  };
  refresh();

  const fileInput = el("input", {
    type: "file", accept: "image/*", multiple: true, hidden: true,
  });
  fileInput.onchange = async () => {
    for (const file of fileInput.files) await uploadFile(file);
    fileInput.value = "";
    await refresh();
  };

  return el("div", { className: "page" },
    el("header", { className: "page-head" },
      el("h1", {}, "Media"),
      el("button", { className: "btn primary", onclick: () => fileInput.click() }, "Upload images")
    ),
    el("p", { className: "hint" },
      "Uploads are committed to the repository and served from /assets/uploads/."),
    fileInput,
    grid
  );
}

async function uploadFile(file) {
  const name = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  const path = `${CONFIG.uploadPath}/${Date.now()}-${name}`;
  const buf = new Uint8Array(await file.arrayBuffer());
  try {
    await state.gh.writeFile(path, bytesToBase64(buf), `CMS: upload ${name}`, { base64: true });
    toast(`Uploaded ${name}`);
    // Invalidate the cache so the new file shows without a reload.
    state.media = null;
    return "/" + path;
  } catch (err) {
    toast(`Upload failed: ${err.message}`, "error");
    return null;
  }
}

/**
 * Image picker. Shows previously uploaded files and the images already used on
 * the site, and can upload a new one without leaving the editor.
 */
function pickImage() {
  return new Promise((resolve) => {
    const grid = el("div", { className: "media-grid" }, "Loading…");
    const close = (value) => { overlay.remove(); resolve(value); };

    const fileInput = el("input", { type: "file", accept: "image/*", multiple: false, hidden: true });
    const uploadBtn = el("button", { className: "btn primary small", onclick: () => fileInput.click() },
      "Upload new image");

    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      uploadBtn.disabled = true;
      uploadBtn.textContent = "Uploading…";
      const uploaded = await uploadFile(file);
      uploadBtn.disabled = false;
      uploadBtn.textContent = "Upload new image";
      if (uploaded) close(uploaded);
    };

    const overlay = el("div", { className: "overlay" },
      el("div", { className: "modal" },
        el("header", {},
          el("h2", {}, "Choose an image"),
          el("div", { className: "actions" }, uploadBtn,
            el("button", { className: "link", onclick: () => close(null) }, "Close"))
        ),
        fileInput,
        grid
      )
    );

    Promise.all([loadMedia(), loadSiteImages()]).then(([uploads, existing]) => {
      const seen = new Set(uploads.map((f) => f.path));
      const files = [...uploads, ...existing.filter((f) => !seen.has(f.path))];
      grid.replaceChildren(
        ...(files.length
          ? files.map((f) =>
              el("button", { className: "media-item pick", onclick: () => close(f.path) },
                el("img", { src: "../" + f.path.replace(/^\//, ""), alt: f.name, loading: "lazy" }),
                el("figcaption", {}, f.name)
              ))
          : [el("p", { className: "hint" }, "No images yet — upload one above.")])
      );
    });

    document.body.append(overlay);
  });
}

/**
 * Images already shipped with the site. Without these the picker would only
 * offer new uploads, making it impossible to reuse an existing asset.
 */
async function loadSiteImages() {
  if (state.siteImages) return state.siteImages;
  const files = await state.gh.listDir("assets/img");
  state.siteImages = files
    .filter((f) => f.type === "file" && /\.(avif|webp|png|jpe?g|gif|svg)$/i.test(f.name))
    .map((f) => ({ name: f.name, path: "/" + f.path }));
  return state.siteImages;
}

/* ------------------------------------------------------------- publishing */

let buildTimer = null;

/**
 * Report what the build actually did.
 *
 * A commit only means the content was saved; the site isn't updated until the
 * workflow finishes, so this polls rather than claiming success up front.
 */
async function watchBuild() {
  clearTimeout(buildTimer);
  let tries = 0;
  const poll = async () => {
    tries += 1;
    try {
      const run = await state.gh.latestRun();
      if (run && run.status !== "completed") {
        setBuildStatus("Publishing…", "busy");
      } else if (run?.conclusion === "success") {
        setBuildStatus("Published", "ok");
        return;
      } else if (run?.conclusion) {
        setBuildStatus(`Build ${run.conclusion}`, "error");
        return;
      }
    } catch {
      // Workflow may not exist yet; stay quiet rather than alarm the user.
    }
    if (tries < 20) buildTimer = setTimeout(poll, 6000);
  };
  buildTimer = setTimeout(poll, 4000);
}

function setBuildStatus(text, kind) {
  let bar = $("#build-status");
  if (!bar) {
    bar = el("div", { id: "build-status" });
    document.body.append(bar);
  }
  bar.className = kind;
  bar.replaceChildren(
    text,
    kind === "ok" && CONFIG.siteUrl
      ? el("a", { href: CONFIG.siteUrl, target: "_blank", rel: "noreferrer" }, "View site")
      : null
  );
  if (kind === "ok") setTimeout(() => bar.remove(), 8000);
}

/* -------------------------------------------------------------- feedback */

function toast(message, kind = "ok") {
  const node = el("div", { className: `toast ${kind}` }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), kind === "error" ? 7000 : 4000);
}

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

start();
