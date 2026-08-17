/**
 * CMS configuration.
 *
 * `authWorker` points at the Cloudflare Worker that completes the GitHub OAuth
 * handshake. Until it is deployed, leave it as-is: the admin falls back to a
 * pasted personal access token, so the CMS is usable before that
 * infrastructure exists. See auth-worker/README.md.
 */
export const CONFIG = {
  owner: "REPLACE_WITH_GITHUB_USERNAME",
  repo: "alexiux-site",
  branch: "main",

  // Deployed Worker URL, e.g. "https://alexiux-cms-auth.<subdomain>.workers.dev".
  // Empty string disables the "Sign in with GitHub" button.
  authWorker: "",

  // Where uploads land. Referenced from content as /assets/uploads/<file>.
  uploadPath: "assets/uploads",

  collections: ["projects", "pages"],

  // Shown as the "view site" link once a publish lands.
  siteUrl: "",
};
