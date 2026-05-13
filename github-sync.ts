// github-sync.ts
// Syncs skills from GitHub repos listed in github-repos.json on every startup.
// Requires: GITHUB_TOKEN env var (PAT with repo scope, authorized for org SSO)

import { mkdir, writeFile, appendFile, readFile, unlink, stat, open } from "fs/promises"
import { join } from "path"

const API        = "https://api.github.com"
const CONFIG_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".config", "opencode")
const LOG_FILE   = join(CONFIG_DIR, "github-sync.log")
const CACHE_FILE = join(CONFIG_DIR, ".github-sync-cache.json")
const LOCK_FILE  = join(CONFIG_DIR, ".github-sync.lock")
const REPOS_FILE = join(CONFIG_DIR, "github-repos.json")
const LOCK_TTL   = 30_000 // ms — stale lock timeout
const LOG_MAX_LINES = 500

// --- Types ---

interface ManifestSkill {
  name: string
  path: string
}

interface Manifest {
  skills?: ManifestSkill[]
}

interface GitHubFile {
  sha: string
  content: string
}

// --- Logging ---

async function log(msg: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    const existing = await readFile(LOG_FILE, "utf8")
    const lines = existing.split("\n").filter(Boolean)
    if (lines.length >= LOG_MAX_LINES) {
      const trimmed = lines.slice(-LOG_MAX_LINES + 1).join("\n") + "\n"
      await writeFile(LOG_FILE, trimmed + line, "utf8")
      return
    }
  } catch {
    // File doesn't exist yet — appendFile will create it
  }
  await appendFile(LOG_FILE, line, "utf8")
}

// --- Async file helpers (no existsSync) ---

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// --- Lock ---
// Uses O_EXCL (exclusive create) for an atomic lock acquisition.
// Only one process can create the file — the OS guarantees this.

async function acquireLock(): Promise<boolean> {
  // Remove stale lock if older than LOCK_TTL
  try {
    const info = await stat(LOCK_FILE)
    if (Date.now() - info.mtimeMs > LOCK_TTL) {
      await unlink(LOCK_FILE)
      await log("removed stale lock file")
    } else {
      return false
    }
  } catch {
    // Lock file doesn't exist — proceed to create
  }

  try {
    // wx flag = exclusive create: fails atomically if file already exists
    const fh = await open(LOCK_FILE, "wx")
    await fh.writeFile(String(process.pid), "utf8")
    await fh.close()
    return true
  } catch {
    return false
  }
}

async function releaseLock(): Promise<void> {
  try {
    await unlink(LOCK_FILE)
  } catch {
    // Already gone — that's fine
  }
}

// --- Cache ---

async function loadCache(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8"))
  } catch {
    return {}
  }
}

async function saveCache(cache: Record<string, string>): Promise<void> {
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8")
}

// --- Config ---

async function loadRepos(): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(REPOS_FILE, "utf8")
  } catch {
    await log(`WARNING: ${REPOS_FILE} not found — no repos to sync`)
    return []
  }
  try {
    const config = JSON.parse(raw) as { repos?: unknown }
    if (!Array.isArray(config.repos)) {
      await log(`WARNING: github-repos.json must have a "repos" array`)
      return []
    }
    return config.repos as string[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await log(`ERROR: failed to parse github-repos.json: ${msg}`)
    return []
  }
}

// --- GitHub API ---

async function githubGet(token: string, repo: string, path: string): Promise<GitHubFile> {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "opencode-github-sync",
      Accept: "application/vnd.github+json",
    },
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}: ${await res.text()}`)
  return res.json() as Promise<GitHubFile>
}

// --- Sync ---

async function syncRepo(
  token: string,
  repo: string,
  cache: Record<string, string>
): Promise<{ synced: number; skipped: number }> {
  const manifestFile = await githubGet(token, repo, "opencode-manifest.json")
  const manifest = JSON.parse(
    Buffer.from(manifestFile.content, "base64").toString("utf8")
  ) as Manifest

  let synced = 0
  let skipped = 0

  for (const skill of manifest.skills ?? []) {
    const cacheKey = `${repo}:${skill.path}`
    const file = await githubGet(token, repo, skill.path)

    if (cache[cacheKey] === file.sha) {
      await log(`[${repo}] skipped (unchanged): ${skill.name}`)
      skipped++
      continue
    }

    const content  = Buffer.from(file.content, "base64").toString("utf8")
    const destDir  = join(CONFIG_DIR, "skills", skill.name)
    const destFile = join(destDir, "SKILL.md")

    await mkdir(destDir, { recursive: true })
    await writeFile(destFile, content, "utf8")

    cache[cacheKey] = file.sha
    await log(`[${repo}] wrote skill: ${skill.name} (sha: ${file.sha.slice(0, 7)})`)
    synced++
  }

  return { synced, skipped }
}

// --- Plugin entry point ---

export const GithubSync = async () => {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    await log("GITHUB_TOKEN not set — skipping sync")
    return {}
  }

  // Read cache before touching the lock — if all SHAs match we can skip entirely
  const repos = await loadRepos()
  if (repos.length === 0) return {}

  const acquired = await acquireLock()
  if (!acquired) {
    await log(`skipped — another worker is syncing (pid: ${process.pid})`)
    return {}
  }

  try {
    await log(`starting sync of ${repos.length} repo(s) (pid: ${process.pid})`)
    const cache = await loadCache()

    let totalSynced = 0
    let totalSkipped = 0

    for (const repo of repos) {
      try {
        const { synced, skipped } = await syncRepo(token, repo, cache)
        totalSynced += synced
        totalSkipped += skipped
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await log(`[${repo}] ERROR: ${msg}`)
      }
    }

    await saveCache(cache)
    await log(`done — synced: ${totalSynced}, skipped: ${totalSkipped}`)
  } finally {
    await releaseLock()
  }

  return {}
}
