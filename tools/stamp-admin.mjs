/**
 * Cache-bust the CMS assets.
 *
 * The admin is plain static files with no build step, so GitHub Pages happily
 * serves a browser its cached copy long after a deploy. That makes a shipped
 * fix look like it never landed - the code is correct, the browser just never
 * fetches it.
 *
 * A short hash of the admin sources is appended to every reference, so the URL
 * changes whenever the code does and stays stable when it doesn't.
 *
 *   node tools/stamp-admin.mjs _site
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] || "_site";
const adminDir = path.join(outDir, "admin");

if (!fs.existsSync(adminDir)) {
  console.log("No admin/ in the build - nothing to stamp.");
  process.exit(0);
}

const sources = ["app.js", "github.js", "config.js", "admin.css"]
  .map((f) => path.join(adminDir, f))
  .filter((f) => fs.existsSync(f));

const hash = crypto
  .createHash("sha256")
  .update(sources.map((f) => fs.readFileSync(f)).join(""))
  .digest("hex")
  .slice(0, 8);

const indexPath = path.join(adminDir, "index.html");
if (fs.existsSync(indexPath)) {
  let html = fs.readFileSync(indexPath, "utf8");
  html = html
    .replace(/(src|href)="(app\.js|admin\.css)"/g, `$1="$2?v=${hash}"`);
  fs.writeFileSync(indexPath, html);
}

// The entry module imports the others, so those need stamping too or they
// stay cached independently of app.js.
const appPath = path.join(adminDir, "app.js");
if (fs.existsSync(appPath)) {
  let js = fs.readFileSync(appPath, "utf8");
  js = js.replace(/from "\.\/(config|github)\.js"/g, `from "./$1.js?v=${hash}"`);
  fs.writeFileSync(appPath, js);
}

console.log(`Stamped admin assets with v=${hash}.`);
