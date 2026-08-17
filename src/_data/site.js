/**
 * Canonical site URL used by sitemap.xml and robots.txt.
 *
 * Search engines need absolute URLs, so this has to match wherever the site is
 * actually served. SITE_URL is set by the deploy workflow; the fallback is the
 * project-pages URL used before the custom domain is live.
 */
export default {
  url: (process.env.SITE_URL || "https://kitilibup.github.io/alexiux-site").replace(/\/+$/, ""),
};
