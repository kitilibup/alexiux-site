/**
 * Minimal GitHub client for the CMS.
 *
 * Everything the admin does is a Contents API call against one repo, plus the
 * Actions API to report whether a publish actually built. No dependencies, so
 * the admin deploys as plain static files alongside the site.
 */

const API = "https://api.github.com";

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
    // path -> blob sha, so updates can prove which revision they replace.
    this.shas = new Map();
  }

  get base() {
    return `${API}/repos/${this.owner}/${this.repo}`;
  }

  async request(url, options = {}) {
    const res = await fetch(url.startsWith("http") ? url : this.base + url, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });

    if (res.status === 401) throw new Error("Sign-in expired or token invalid.");
    if (res.status === 403) {
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        throw new Error("GitHub rate limit reached. Try again in a few minutes.");
      }
      // GitHub's own message distinguishes the causes that all surface as 403 -
      // token not granted to this repo, expired, awaiting org approval, or
      // missing the Contents permission - so pass it through rather than guess.
      let detail = "";
      try {
        detail = (await res.json()).message || "";
      } catch {
        /* not JSON */
      }
      throw new Error(
        `Access denied by GitHub${detail ? `: ${detail}` : ""}. ` +
        "Check the token grants this repository under Repository access, " +
        "and sets Repository permissions -> Contents to Read and write."
      );
    }
    if (res.status === 404) {
      const err = new Error(`Not found: ${url}`);
      err.status = 404;
      throw err;
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).message || "";
      } catch {
        /* response wasn't JSON */
      }
      throw new Error(`GitHub ${res.status}: ${detail || res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async user() {
    return this.request(`${API}/user`);
  }

  /** Confirm the repo exists and the token can actually write to it. */
  async checkAccess() {
    const repo = await this.request("");
    if (!repo.permissions?.push) {
      throw new Error(
        `Signed in, but this account cannot write to ${this.owner}/${this.repo}.`
      );
    }
    return repo;
  }

  async listDir(path) {
    try {
      const items = await this.request(
        `/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`
      );
      return Array.isArray(items) ? items : [];
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  async readFile(path) {
    const data = await this.request(
      `/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`
    );
    this.shas.set(path, data.sha);
    // Base64 -> bytes -> UTF-8, so accented characters survive the round trip.
    const bytes = Uint8Array.from(atob(data.content.replace(/\s/g, "")), (c) =>
      c.charCodeAt(0)
    );
    return new TextDecoder().decode(bytes);
  }

  async readJson(path) {
    return JSON.parse(await this.readFile(path));
  }

  /**
   * Create or update a file.
   *
   * Sends the sha of the revision being replaced; GitHub rejects the write if
   * the file moved on in the meantime, so a stale tab can't clobber a newer
   * edit without the conflict surfacing.
   */
  async writeFile(path, content, message, { base64 = false } = {}) {
    let sha = this.shas.get(path);
    if (!sha) {
      try {
        const meta = await this.request(
          `/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`
        );
        sha = meta.sha;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }

    const body = {
      message,
      branch: this.branch,
      content: base64 ? content : bytesToBase64(new TextEncoder().encode(content)),
      ...(sha ? { sha } : {}),
    };

    const res = await this.request(`/contents/${encodeURI(path)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    this.shas.set(path, res.content.sha);
    return res;
  }

  async deleteFile(path, message) {
    let sha = this.shas.get(path);
    if (!sha) {
      const meta = await this.request(
        `/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`
      );
      sha = meta.sha;
    }
    await this.request(`/contents/${encodeURI(path)}`, {
      method: "DELETE",
      body: JSON.stringify({ message, sha, branch: this.branch }),
    });
    this.shas.delete(path);
  }

  /** Most recent workflow run, used to show real publish status. */
  async latestRun() {
    const data = await this.request(
      `/actions/runs?branch=${encodeURIComponent(this.branch)}&per_page=1`
    );
    return data.workflow_runs?.[0] || null;
  }
}

export function bytesToBase64(bytes) {
  // Chunked: spreading a multi-MB array into String.fromCharCode blows the
  // call stack, and uploads here are image-sized.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
