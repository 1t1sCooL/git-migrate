#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

loadEnvFromFile();

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Behavior flags only; remote credentials/endpoints live in `profiles`.
const config = {
  mirrorRoot: path.resolve(process.env.MIRROR_ROOT || "./mirrors"),
  includeArchived: process.env.INCLUDE_ARCHIVED === "true",
  dryRun: process.env.DRY_RUN === "true",
  useOriginalRepoName:
    (process.env.USE_ORIGINAL_REPO_NAME || "true").toLowerCase() === "true",
  preserveNamespace:
    (process.env.PRESERVE_NAMESPACE_IN_NAME || "true").toLowerCase() === "true",
  preserveSourceOwnerAsGitLabGroup:
    (process.env.PRESERVE_SOURCE_OWNER_AS_GITLAB_GROUP || "true").toLowerCase() === "true",
  lfs: process.env.MIGRATE_LFS === "true",
  migrationDirection: process.env.MIGRATION_DIRECTION || "",
  interactiveNaming:
    (process.env.INTERACTIVE_NAMING || "true").toLowerCase() === "true",
  syncFlatNames:
    (process.env.SYNC_FLAT_NAMES || "false").toLowerCase() === "true",
  includePatterns: parsePatternList(process.env.REPO_INCLUDE_PATTERNS),
  excludePatterns: parsePatternList(process.env.REPO_EXCLUDE_PATTERNS),
  logLevel: resolveLogLevel(process.env.LOG_LEVEL),
};

function parsePatternList(value) {
  return String(value || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

const profiles = buildProfiles(process.env);

const gitlabNamespaceCache = new Map();

function normalizeBaseUrl(value) {
  return (value || "").replace(/\/+$/, "");
}

// Builds the four named remote profiles. New SOURCE_*/DEST_* variables win;
// legacy GITLAB_*/GITHUB_* variables fill both source and dest sides so
// existing configurations keep working unchanged.
function buildProfiles(env) {
  const pick = (label, ...candidates) => {
    for (const [name, value] of candidates) {
      if (value) {
        logDebug(`profile ${label} <- ${name}`);
        return value;
      }
    }
    return "";
  };

  const sourceGitlab = {
    baseUrl: normalizeBaseUrl(
      pick(
        "sourceGitlab.baseUrl",
        ["SOURCE_GITLAB_BASE_URL", env.SOURCE_GITLAB_BASE_URL],
        ["GITLAB_BASE_URL", env.GITLAB_BASE_URL],
      ),
    ),
    token: pick(
      "sourceGitlab.token",
      ["SOURCE_GITLAB_TOKEN", env.SOURCE_GITLAB_TOKEN],
      ["GITLAB_TOKEN", env.GITLAB_TOKEN],
    ),
    groupId: pick(
      "sourceGitlab.groupId",
      ["SOURCE_GITLAB_GROUP_ID", env.SOURCE_GITLAB_GROUP_ID],
      ["GITLAB_GROUP_ID", env.GITLAB_GROUP_ID],
    ),
  };

  const sourceGithub = {
    token: pick(
      "sourceGithub.token",
      ["SOURCE_GITHUB_TOKEN", env.SOURCE_GITHUB_TOKEN],
      ["GITHUB_TOKEN", env.GITHUB_TOKEN],
    ),
    owner: pick(
      "sourceGithub.owner",
      ["SOURCE_GITHUB_OWNER", env.SOURCE_GITHUB_OWNER],
      ["GITHUB_OWNER", env.GITHUB_OWNER],
    ),
    ownerType: (
      pick(
        "sourceGithub.ownerType",
        ["SOURCE_GITHUB_OWNER_TYPE", env.SOURCE_GITHUB_OWNER_TYPE],
        ["GITHUB_OWNER_TYPE", env.GITHUB_OWNER_TYPE],
      ) || "user"
    ).toLowerCase(),
  };

  const destGitlab = {
    baseUrl: normalizeBaseUrl(
      pick(
        "destGitlab.baseUrl",
        ["DEST_GITLAB_BASE_URL", env.DEST_GITLAB_BASE_URL],
        ["GITLAB_BASE_URL", env.GITLAB_BASE_URL],
      ),
    ),
    token: pick(
      "destGitlab.token",
      ["DEST_GITLAB_TOKEN", env.DEST_GITLAB_TOKEN],
      ["GITLAB_TOKEN", env.GITLAB_TOKEN],
    ),
    namespaceId: pick(
      "destGitlab.namespaceId",
      ["DEST_GITLAB_NAMESPACE_ID", env.DEST_GITLAB_NAMESPACE_ID],
      ["GITLAB_TARGET_NAMESPACE_ID", env.GITLAB_TARGET_NAMESPACE_ID],
    ),
  };

  const destGithub = {
    token: pick(
      "destGithub.token",
      ["DEST_GITHUB_TOKEN", env.DEST_GITHUB_TOKEN],
      ["GITHUB_TOKEN", env.GITHUB_TOKEN],
    ),
    owner: pick(
      "destGithub.owner",
      ["DEST_GITHUB_OWNER", env.DEST_GITHUB_OWNER],
      ["GITHUB_OWNER", env.GITHUB_OWNER],
    ),
    ownerType: (
      pick(
        "destGithub.ownerType",
        ["DEST_GITHUB_OWNER_TYPE", env.DEST_GITHUB_OWNER_TYPE],
        ["GITHUB_OWNER_TYPE", env.GITHUB_OWNER_TYPE],
      ) || "user"
    ).toLowerCase(),
  };

  return { sourceGitlab, sourceGithub, destGitlab, destGithub };
}

// Glob-style match: '*' means any characters; the whole name must match.
// Case-insensitive, because GitHub/GitLab paths are case-insensitive in practice.
function matchesPattern(name, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

// Discovery filter: exclude wins over include; empty include means "all".
// getName extracts the comparable full path (group/sub/project, owner/repo).
function filterRepositories(items, getName, include, exclude) {
  const kept = items.filter((item) => {
    const name = getName(item);
    if (include.length > 0 && !include.some((p) => matchesPattern(name, p))) {
      logDebug(`filter: '${name}' not in include patterns -> skipped`);
      return false;
    }
    if (exclude.some((p) => matchesPattern(name, p))) {
      logDebug(`filter: '${name}' matches exclude pattern -> skipped`);
      return false;
    }
    return true;
  });

  if (include.length > 0 || exclude.length > 0) {
    log(
      `Filtered out: ${items.length - kept.length} ` +
        `(include: ${include.join(", ") || "-"}; exclude: ${exclude.join(", ") || "-"})`,
    );
  }
  return kept;
}

// Which sync destinations are fully configured.
function activeSyncDestinations(remoteProfiles) {
  return {
    github: Boolean(
      remoteProfiles.destGithub.token && remoteProfiles.destGithub.owner,
    ),
    gitlab: Boolean(
      remoteProfiles.destGitlab.baseUrl && remoteProfiles.destGitlab.token,
    ),
  };
}

// Direction-aware replacement for the old global REQUIRED_ENV check.
function validateProfilesForDirection(direction, remoteProfiles) {
  const missing = [];
  const req = (value, label) => {
    if (!value) missing.push(label);
  };

  if (direction === "sync") {
    req(
      remoteProfiles.sourceGitlab.baseUrl,
      "SOURCE_GITLAB_BASE_URL (or GITLAB_BASE_URL)",
    );
    req(
      remoteProfiles.sourceGitlab.token,
      "SOURCE_GITLAB_TOKEN (or GITLAB_TOKEN)",
    );
    const destinations = activeSyncDestinations(remoteProfiles);
    if (!destinations.github && !destinations.gitlab) {
      missing.push(
        "at least one destination: DEST_GITHUB_TOKEN + DEST_GITHUB_OWNER (GitHub) " +
          "or DEST_GITLAB_BASE_URL + DEST_GITLAB_TOKEN (GitLab)",
      );
    }
  } else if (direction === "gitlab-to-github") {
    req(
      remoteProfiles.sourceGitlab.baseUrl,
      "SOURCE_GITLAB_BASE_URL (or GITLAB_BASE_URL)",
    );
    req(
      remoteProfiles.sourceGitlab.token,
      "SOURCE_GITLAB_TOKEN (or GITLAB_TOKEN)",
    );
    req(remoteProfiles.destGithub.token, "DEST_GITHUB_TOKEN (or GITHUB_TOKEN)");
    req(remoteProfiles.destGithub.owner, "DEST_GITHUB_OWNER (or GITHUB_OWNER)");
  } else {
    req(
      remoteProfiles.sourceGithub.token,
      "SOURCE_GITHUB_TOKEN (or GITHUB_TOKEN)",
    );
    req(
      remoteProfiles.sourceGithub.owner,
      "SOURCE_GITHUB_OWNER (or GITHUB_OWNER)",
    );
    req(
      remoteProfiles.destGitlab.baseUrl,
      "DEST_GITLAB_BASE_URL (or GITLAB_BASE_URL)",
    );
    req(
      remoteProfiles.destGitlab.token,
      "DEST_GITLAB_TOKEN (or GITLAB_TOKEN)",
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration for ${direction}: ${missing.join(", ")}`,
    );
  }
}

function resolveLogLevel(value) {
  const raw = (value || "info").toLowerCase();
  if (!(raw in LOG_LEVELS)) {
    console.error(`[warn] Unknown LOG_LEVEL '${raw}', falling back to 'info'`);
    return "info";
  }
  return raw;
}

function shouldLog(level) {
  return LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
}

function log(message) {
  if (shouldLog("info")) console.log(message);
}

function logDebug(message) {
  if (shouldLog("debug")) console.log(`[debug] ${message}`);
}

function logWarn(message) {
  if (shouldLog("warn")) console.error(`[warn] ${message}`);
}

function logError(message) {
  if (shouldLog("error")) console.error(message);
}

// Strip embedded credentials (https://user:token@host) before logging.
function redactUrl(value) {
  return String(value).replace(/:\/\/[^@/\s]+@/g, "://***@");
}

function loadEnvFromFile() {
  const envFilePath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envFilePath)) {
    return;
  }

  const raw = fs.readFileSync(envFilePath, "utf8");
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Do not override values that were already explicitly set in shell.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function encodeToken(token) {
  return encodeURIComponent(token);
}

function sanitizeRepoName(name) {
  return name
    .replace(/\//g, "--")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function buildGitHubRepoName(project) {
  if (config.useOriginalRepoName) {
    return sanitizeGitHubRepoSegment(project.path);
  }
  if (config.preserveNamespace) {
    return sanitizeRepoName(project.path_with_namespace);
  }
  return sanitizeRepoName(project.path);
}

function buildGitLabProjectPath(repo, sourceOwner) {
  if (config.useOriginalRepoName) {
    return sanitizeGitLabPathSegment(repo.name);
  }
  if (config.preserveNamespace) {
    return sanitizeRepoName(
      repo.full_name || `${sourceOwner || ""}/${repo.name}`,
    );
  }
  return sanitizeRepoName(repo.name);
}

// GitHub limits repository names to 100 characters.
const MAX_SYNC_REPO_NAME_LENGTH = 100;

// Backup name for sync mode. By default keeps the full namespace path
// (group__sub__project) so same-named projects from different work groups
// cannot collide and overwrite each other's backups.
function buildSyncRepoName(project, sanitizeSegment, flat = config.syncFlatNames) {
  let name;
  if (flat) {
    name = sanitizeSegment(project.path);
  } else {
    name = String(project.path_with_namespace || project.path)
      .split("/")
      .map((segment) => sanitizeSegment(segment))
      .filter(Boolean)
      .join("__");
  }

  if (name.length > MAX_SYNC_REPO_NAME_LENGTH) {
    name = name.slice(0, MAX_SYNC_REPO_NAME_LENGTH).replace(/[_.-]+$/, "");
    logWarn(
      `Sync repo name for '${project.path_with_namespace || project.path}' ` +
        `truncated to ${MAX_SYNC_REPO_NAME_LENGTH} chars: ${name}`,
    );
  }

  logDebug(
    `buildSyncRepoName: ${project.path_with_namespace || project.path} -> ${name}`,
  );
  return name;
}

function sanitizeGitHubRepoSegment(name) {
  return String(name)
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeGitLabPathSegment(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeDirection(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  if (
    ["1", "gitlab-to-github", "gitlab2github", "gl2gh"].includes(normalized)
  ) {
    return "gitlab-to-github";
  }
  if (
    ["2", "github-to-gitlab", "github2gitlab", "gh2gl"].includes(normalized)
  ) {
    return "github-to-gitlab";
  }
  if (["3", "sync", "backup"].includes(normalized)) {
    return "sync";
  }
  return "";
}

async function askDirection() {
  const fromEnv = normalizeDirection(config.migrationDirection);
  if (fromEnv) return fromEnv;

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    log("\nSelect migration direction:");
    log("1) GitLab -> GitHub");
    log("2) GitHub -> GitLab");
    log("3) Sync: source GitLab -> personal GitLab + GitHub (backup)");
    const answer = await rl.question("Enter 1, 2 or 3: ");
    const direction = normalizeDirection(answer);
    if (!direction) {
      throw new Error("Invalid direction. Use 1, 2 or 3.");
    }
    return direction;
  } finally {
    rl.close();
  }
}

async function askTargetRepoName(sourceLabel, defaultName, sanitize, exists) {
  // Non-interactive runs (cron, CI) and INTERACTIVE_NAMING=false fall back
  // to the computed default name without blocking on stdin.
  if (!config.interactiveNaming || !stdin.isTTY) {
    return defaultName;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    log(`Repository for '${sourceLabel}' does not exist in target yet.`);
    for (;;) {
      const answer = (
        await rl.question(`New repository name [${defaultName}]: `)
      ).trim();
      // The caller already verified the default name is free.
      if (!answer) return defaultName;

      const sanitized = sanitize(answer);
      if (!sanitized) {
        log("Invalid name, try again.");
        continue;
      }
      if (sanitized !== answer) {
        log(`Using sanitized name: ${sanitized}`);
      }

      if (await exists(sanitized)) {
        const confirm = (
          await rl.question(
            `Repository '${sanitized}' already exists in target. ` +
              "push --mirror will overwrite its branches. Continue? (y/N): ",
          )
        )
          .trim()
          .toLowerCase();
        if (confirm !== "y" && confirm !== "yes") {
          continue;
        }
      }

      return sanitized;
    }
  } finally {
    rl.close();
  }
}

async function run(cmd, args, options = {}) {
  logDebug(`run: ${cmd} ${args.map(redactUrl).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: options.stdio || "inherit",
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
    });

    let stderr = "";
    if (child.stderr) {
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${cmd} ${args.join(" ")} failed with code ${code}\n${stderr}`,
        ),
      );
    });
  });
}

async function gitlabGetAll(profile, url) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    logDebug(`GitLab API GET ${nextUrl}`);
    const res = await fetch(nextUrl, {
      headers: {
        "PRIVATE-TOKEN": profile.token,
      },
    });

    if (!res.ok) {
      throw new Error(`GitLab API ${res.status}: ${await res.text()}`);
    }

    const pageItems = await res.json();
    logDebug(`GitLab API GET -> ${res.status}, items: ${pageItems.length}`);
    items.push(...pageItems);

    const nextPage = res.headers.get("x-next-page");
    if (nextPage) {
      const u = new URL(nextUrl);
      u.searchParams.set("page", nextPage);
      nextUrl = u.toString();
    } else {
      nextUrl = "";
    }
  }

  return items;
}

async function githubGetAll(profile, url) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    logDebug(`GitHub API GET ${nextUrl}`);
    const res = await fetch(nextUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${profile.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "git-mirror-migrator",
      },
    });

    const text = await res.text();
    const data = text ? safeJsonParse(text) : null;

    if (!res.ok) {
      const message =
        typeof data === "object" && data && data.message
          ? data.message
          : text || "Unknown error";
      throw new Error(`GitHub API GET ${nextUrl} -> ${res.status}: ${message}`);
    }

    if (!Array.isArray(data)) {
      throw new Error(`GitHub API GET ${nextUrl} returned non-array payload`);
    }

    items.push(...data);
    nextUrl = parseNextLink(res.headers.get("link"));
  }

  return items;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return "";
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes('rel="next"')) {
      const match = trimmed.match(/<([^>]+)>/);
      if (match) return match[1];
    }
  }
  return "";
}

async function getGitLabProjects(profile) {
  const perPage = 100;
  let url;

  if (profile.groupId) {
    url = `${profile.baseUrl}/api/v4/groups/${encodeURIComponent(
      profile.groupId,
    )}/projects?include_subgroups=true&per_page=${perPage}&page=1&simple=true`;
  } else {
    url = `${profile.baseUrl}/api/v4/projects?membership=true&per_page=${perPage}&page=1&simple=true`;
  }

  const projects = await gitlabGetAll(profile, url);
  return projects.filter((p) => (config.includeArchived ? true : !p.archived));
}

async function getGitHubRepos(profile) {
  const perPage = 100;
  if (profile.ownerType === "org") {
    const url = `https://api.github.com/orgs/${encodeURIComponent(
      profile.owner,
    )}/repos?per_page=${perPage}&type=all&page=1`;
    return githubGetAll(profile, url);
  }

  const url = `https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=${perPage}&page=1`;
  const repos = await githubGetAll(profile, url);
  return repos.filter(
    (repo) => repo.owner && repo.owner.login === profile.owner,
  );
}

async function githubRequest(profile, method, endpoint, body) {
  logDebug(`GitHub API ${method} ${endpoint}`);
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${profile.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gitlab-to-github-mirror-migrator",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const message =
      typeof data === "object" && data && data.message
        ? data.message
        : text || "Unknown error";
    throw new Error(
      `GitHub API ${method} ${endpoint} -> ${res.status}: ${message}`,
    );
  }

  return data;
}

async function gitlabRequest(profile, method, endpoint, body) {
  logDebug(`GitLab API ${method} ${endpoint}`);
  const res = await fetch(`${profile.baseUrl}/api/v4${endpoint}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": profile.token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const message =
      typeof data === "object" && data && data.message
        ? JSON.stringify(data.message)
        : text || "Unknown error";
    const err = new Error(
      `GitLab API ${method} ${endpoint} -> ${res.status}: ${message}`,
    );
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  return data;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function githubRepoExists(profile, repoName) {
  try {
    await githubRequest(profile, "GET", `/repos/${profile.owner}/${repoName}`);
    return true;
  } catch (err) {
    if (String(err.message).includes("404")) {
      return false;
    }
    throw err;
  }
}

async function ensureGitHubRepo(profile, repoName, description) {
  if (await githubRepoExists(profile, repoName)) {
    return { created: false };
  }

  const payload = {
    name: repoName,
    // Business rule: always create private repositories in GitHub.
    private: true,
    description: description || "",
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  };

  if (profile.ownerType === "org") {
    await githubRequest(
      profile,
      "POST",
      `/orgs/${profile.owner}/repos`,
      payload,
    );
  } else {
    await githubRequest(profile, "POST", "/user/repos", payload);
  }

  return { created: true };
}

async function findGitLabProjectByPath(profile, repoPath, namespaceId) {
  const result = await gitlabRequest(
    profile,
    "GET",
    `/projects?search=${encodeURIComponent(repoPath)}&simple=true&per_page=100`,
  );

  const namespaceIdFilter = namespaceId || null;

  for (const project of result) {
    if (project.path !== repoPath) continue;
    if (
      namespaceIdFilter &&
      project.namespace &&
      project.namespace.id !== namespaceIdFilter
    ) {
      continue;
    }
    return project;
  }

  return null;
}

async function ensureGitLabProject(profile, repoPath, description, namespaceId) {
  const existing = await findGitLabProjectByPath(profile, repoPath, namespaceId);
  if (existing) {
    return { created: false, project: existing };
  }

  const payload = {
    name: repoPath,
    path: repoPath,
    description: description || "",
    visibility: "private",
  };

  if (namespaceId) {
    payload.namespace_id = Number(namespaceId);
  }

  try {
    const created = await gitlabRequest(profile, "POST", "/projects", payload);
    return { created: true, project: created };
  } catch (err) {
    if (err.status === 400 || err.status === 409) {
      const project = await findGitLabProjectByPath(
        profile,
        repoPath,
        namespaceId,
      );
      if (project) {
        return { created: false, project };
      }
    }
    throw err;
  }
}

async function findOrCreateGitLabSubgroup(profile, parentGroupId, subgroupName) {
  const safePath = sanitizeGitLabPathSegment(subgroupName);
  if (!safePath) {
    throw new Error(
      `Cannot derive valid GitLab subgroup path from '${subgroupName}'`,
    );
  }

  // Different GitLab instances may reuse numeric group ids.
  const cacheKey = `${profile.baseUrl}:${parentGroupId}:${safePath}`;
  if (gitlabNamespaceCache.has(cacheKey)) {
    return gitlabNamespaceCache.get(cacheKey);
  }

  const subgroups = await gitlabGetAll(
    profile,
    `${profile.baseUrl}/api/v4/groups/${encodeURIComponent(
      parentGroupId,
    )}/subgroups?per_page=100&page=1`,
  );
  const existing = subgroups.find((group) => group.path === safePath);
  if (existing) {
    gitlabNamespaceCache.set(cacheKey, existing.id);
    return existing.id;
  }

  const created = await gitlabRequest(profile, "POST", "/groups", {
    name: subgroupName,
    path: safePath,
    parent_id: Number(parentGroupId),
    visibility: "private",
  });
  gitlabNamespaceCache.set(cacheKey, created.id);
  return created.id;
}

async function resolveTargetNamespaceIdForGitHubRepo(profile, repo) {
  if (!profile.namespaceId) {
    return null;
  }

  const baseNamespaceId = Number(profile.namespaceId);
  if (!config.preserveSourceOwnerAsGitLabGroup) {
    return baseNamespaceId;
  }

  const ownerName = repo.owner && repo.owner.login ? repo.owner.login : "";
  if (!ownerName) {
    return baseNamespaceId;
  }

  return findOrCreateGitLabSubgroup(profile, baseNamespaceId, ownerName);
}

async function ensureMirrorUpToDate(localMirrorPath, gitlabUrlWithToken) {
  logDebug(`ensureMirrorUpToDate: ${localMirrorPath}`);
  if (!fs.existsSync(localMirrorPath)) {
    await run("git", [
      "clone",
      "--mirror",
      gitlabUrlWithToken,
      localMirrorPath,
    ]);
    return;
  }

  await run("git", [
    "--git-dir",
    localMirrorPath,
    "remote",
    "set-url",
    "origin",
    gitlabUrlWithToken,
  ]);
  await run("git", [
    "--git-dir",
    localMirrorPath,
    "fetch",
    "--prune",
    "origin",
  ]);
}

async function pushMirror(
  localMirrorPath,
  targetRemoteName,
  targetUrlWithToken,
) {
  try {
    await run("git", [
      "--git-dir",
      localMirrorPath,
      "remote",
      "add",
      targetRemoteName,
      targetUrlWithToken,
    ]);
  } catch {
    await run("git", [
      "--git-dir",
      localMirrorPath,
      "remote",
      "set-url",
      targetRemoteName,
      targetUrlWithToken,
    ]);
  }

  await run("git", [
    "--git-dir",
    localMirrorPath,
    "push",
    "--mirror",
    targetRemoteName,
  ]);

  if (config.lfs) {
    await run("git", [
      "--git-dir",
      localMirrorPath,
      "lfs",
      "fetch",
      "--all",
      "origin",
    ]);
    await run("git", [
      "--git-dir",
      localMirrorPath,
      "lfs",
      "push",
      "--all",
      targetRemoteName,
    ]);
  }
}

async function migrateGitLabToGitHub(project) {
  let repoName = buildGitHubRepoName(project);
  const glHttp = project.http_url_to_repo;

  const gitlabUrlWithToken = glHttp.replace(
    "://",
    `://oauth2:${encodeToken(profiles.sourceGitlab.token)}@`,
  );

  const localMirrorPath = path.join(
    config.mirrorRoot,
    `gl2gh__${project.path_with_namespace.replace(/\//g, "__")}.git`,
  );

  log(
    `\n=== ${project.path_with_namespace} -> ${profiles.destGithub.owner}/${repoName} ===`,
  );

  if (config.dryRun) {
    log("[DRY RUN] skip clone/push");
    return;
  }

  const destGithub = profiles.destGithub;

  if (!(await githubRepoExists(destGithub, repoName))) {
    repoName = await askTargetRepoName(
      project.path_with_namespace,
      repoName,
      sanitizeGitHubRepoSegment,
      (name) => githubRepoExists(destGithub, name),
    );
  }

  const githubUrlWithToken = `https://x-access-token:${encodeToken(
    destGithub.token,
  )}@github.com/${destGithub.owner}/${repoName}.git`;

  const { created } = await ensureGitHubRepo(
    destGithub,
    repoName,
    project.description ||
      `Migrated from GitLab: ${project.path_with_namespace}`,
  );
  log(
    created ? "Created GitHub repository" : "GitHub repository already exists",
  );

  fs.mkdirSync(path.dirname(localMirrorPath), { recursive: true });

  await ensureMirrorUpToDate(localMirrorPath, gitlabUrlWithToken);
  await pushMirror(localMirrorPath, "target", githubUrlWithToken);
  log("Success");
}

async function migrateGitHubToGitLab(repo) {
  let gitlabPath = buildGitLabProjectPath(repo, profiles.sourceGithub.owner);
  const githubHttp = repo.clone_url;

  const githubUrlWithToken = githubHttp.replace(
    "://",
    `://x-access-token:${encodeToken(profiles.sourceGithub.token)}@`,
  );

  const localMirrorPath = path.join(
    config.mirrorRoot,
    `gh2gl__${(repo.full_name || repo.name).replace(/\//g, "__")}.git`,
  );

  log(`\n=== ${repo.full_name} -> GitLab/${gitlabPath} ===`);

  if (config.dryRun) {
    log("[DRY RUN] skip clone/push");
    return;
  }

  const destGitlab = profiles.destGitlab;
  const namespaceId = await resolveTargetNamespaceIdForGitHubRepo(
    destGitlab,
    repo,
  );

  if (!(await findGitLabProjectByPath(destGitlab, gitlabPath, namespaceId))) {
    gitlabPath = await askTargetRepoName(
      repo.full_name,
      gitlabPath,
      sanitizeGitLabPathSegment,
      async (name) =>
        Boolean(await findGitLabProjectByPath(destGitlab, name, namespaceId)),
    );
  }

  const { created, project } = await ensureGitLabProject(
    destGitlab,
    gitlabPath,
    repo.description || `Migrated from GitHub: ${repo.full_name}`,
    namespaceId,
  );
  log(created ? "Created GitLab project" : "GitLab project already exists");

  const gitlabUrlWithToken = project.http_url_to_repo.replace(
    "://",
    `://oauth2:${encodeToken(destGitlab.token)}@`,
  );

  fs.mkdirSync(path.dirname(localMirrorPath), { recursive: true });

  await ensureMirrorUpToDate(localMirrorPath, githubUrlWithToken);
  await pushMirror(localMirrorPath, "target", gitlabUrlWithToken);
  log("Success");
}

// Backup one work repository into every configured personal destination.
// No interactive prompts here: sync is designed to run unattended (cron).
// A failure in one destination must not affect the other one.
async function syncProject(project, destinations) {
  const sourceUrlWithToken = project.http_url_to_repo.replace(
    "://",
    `://oauth2:${encodeToken(profiles.sourceGitlab.token)}@`,
  );

  const localMirrorPath = path.join(
    config.mirrorRoot,
    `sync__${project.path_with_namespace.replace(/\//g, "__")}.git`,
  );

  const targets = [];
  if (destinations.github) targets.push("GitHub");
  if (destinations.gitlab) targets.push("GitLab");
  log(
    `\n=== sync ${project.path_with_namespace} -> ${targets.join(" + ")} ===`,
  );

  const result = {
    github: destinations.github ? "pending" : "skipped",
    gitlab: destinations.gitlab ? "pending" : "skipped",
  };

  if (config.dryRun) {
    if (destinations.github) {
      const repoName = buildSyncRepoName(project, sanitizeGitHubRepoSegment);
      log(
        `[DRY RUN] would push to GitHub ${profiles.destGithub.owner}/${repoName}`,
      );
      result.github = "ok";
    }
    if (destinations.gitlab) {
      const projectPath = buildSyncRepoName(project, sanitizeGitLabPathSegment);
      log(
        `[DRY RUN] would push to GitLab ${profiles.destGitlab.baseUrl} as ${projectPath}`,
      );
      result.gitlab = "ok";
    }
    return result;
  }

  fs.mkdirSync(path.dirname(localMirrorPath), { recursive: true });
  await ensureMirrorUpToDate(localMirrorPath, sourceUrlWithToken);

  if (destinations.github) {
    try {
      const repoName = buildSyncRepoName(project, sanitizeGitHubRepoSegment);
      const { created } = await ensureGitHubRepo(
        profiles.destGithub,
        repoName,
        `Backup of ${project.path_with_namespace}`,
      );
      logDebug(
        created
          ? `GitHub repository created: ${repoName}`
          : `GitHub repository exists: ${repoName}`,
      );
      const githubUrlWithToken = `https://x-access-token:${encodeToken(
        profiles.destGithub.token,
      )}@github.com/${profiles.destGithub.owner}/${repoName}.git`;
      await pushMirror(localMirrorPath, "github", githubUrlWithToken);
      log(`GitHub: ok (${profiles.destGithub.owner}/${repoName})`);
      result.github = "ok";
    } catch (err) {
      result.github = "failed";
      logError(
        `GitHub destination failed for ${project.path_with_namespace}: ${err.message}`,
      );
    }
  }

  if (destinations.gitlab) {
    try {
      const projectPath = buildSyncRepoName(project, sanitizeGitLabPathSegment);
      const namespaceId = profiles.destGitlab.namespaceId
        ? Number(profiles.destGitlab.namespaceId)
        : null;
      const { created, project: destProject } = await ensureGitLabProject(
        profiles.destGitlab,
        projectPath,
        `Backup of ${project.path_with_namespace}`,
        namespaceId,
      );
      logDebug(
        created
          ? `GitLab project created: ${projectPath}`
          : `GitLab project exists: ${projectPath}`,
      );
      const gitlabUrlWithToken = destProject.http_url_to_repo.replace(
        "://",
        `://oauth2:${encodeToken(profiles.destGitlab.token)}@`,
      );
      await pushMirror(localMirrorPath, "gitlab", gitlabUrlWithToken);
      log(
        `GitLab: ok (${destProject.path_with_namespace || projectPath})`,
      );
      result.gitlab = "ok";
    } catch (err) {
      result.gitlab = "failed";
      logError(
        `GitLab destination failed for ${project.path_with_namespace}: ${err.message}`,
      );
    }
  }

  return result;
}

// Sync flow: fetch every available work repository once, push the mirror
// into all configured personal destinations, report per-destination totals.
async function runSync() {
  const destinations = activeSyncDestinations(profiles);

  log("Starting sync (backup)");
  log(`Source: GitLab ${profiles.sourceGitlab.baseUrl}`);
  if (destinations.github) {
    log(
      `Destination: GitHub ${profiles.destGithub.owner} (${profiles.destGithub.ownerType})`,
    );
  }
  if (destinations.gitlab) {
    log(`Destination: GitLab ${profiles.destGitlab.baseUrl}`);
  }
  if (!destinations.github || !destinations.gitlab) {
    logWarn(
      "Only one sync destination is configured; the backup will not be duplicated",
    );
  }

  const found = await getGitLabProjects(profiles.sourceGitlab);
  const projects = filterRepositories(
    found,
    (p) => p.path_with_namespace,
    config.includePatterns,
    config.excludePatterns,
  );
  log(`Repositories found: ${projects.length}`);

  const counters = {
    github: { ok: 0, failed: 0, skipped: 0 },
    gitlab: { ok: 0, failed: 0, skipped: 0 },
  };
  let failedRepos = 0;

  for (const project of projects) {
    try {
      const result = await syncProject(project, destinations);
      counters.github[result.github] += 1;
      counters.gitlab[result.gitlab] += 1;
      if (result.github === "failed" || result.gitlab === "failed") {
        failedRepos += 1;
      }
    } catch (err) {
      // Source-side failure (fetch of the mirror itself).
      failedRepos += 1;
      if (destinations.github) counters.github.failed += 1;
      if (destinations.gitlab) counters.gitlab.failed += 1;
      logError(`Failed: ${project.path_with_namespace} -> ${err.message}`);
    }
  }

  log(`\nSync done. Repositories: ${projects.length}`);
  if (destinations.github) {
    log(
      `GitHub: ok ${counters.github.ok}, failed ${counters.github.failed}`,
    );
  }
  if (destinations.gitlab) {
    log(
      `GitLab: ok ${counters.gitlab.ok}, failed ${counters.gitlab.failed}`,
    );
  }
  if (failedRepos > 0) {
    logWarn(`Repositories with failures: ${failedRepos}`);
    process.exitCode = 1;
  }
}

async function main() {
  const direction = await askDirection();
  validateProfilesForDirection(direction, profiles);
  fs.mkdirSync(config.mirrorRoot, { recursive: true });

  if (direction === "sync") {
    return runSync();
  }

  log(`Starting migration: ${direction}`);
  if (direction === "gitlab-to-github") {
    log(`Source: GitLab ${profiles.sourceGitlab.baseUrl}`);
    log(
      `Destination: GitHub ${profiles.destGithub.owner} (${profiles.destGithub.ownerType})`,
    );
  } else {
    log(
      `Source: GitHub ${profiles.sourceGithub.owner} (${profiles.sourceGithub.ownerType})`,
    );
    log(`Destination: GitLab ${profiles.destGitlab.baseUrl}`);
  }

  const found =
    direction === "gitlab-to-github"
      ? await getGitLabProjects(profiles.sourceGitlab)
      : await getGitHubRepos(profiles.sourceGithub);
  const items = filterRepositories(
    found,
    (item) => item.path_with_namespace || item.full_name || item.name || "",
    config.includePatterns,
    config.excludePatterns,
  );
  log(`Repositories found: ${items.length}`);

  let ok = 0;
  let failed = 0;

  for (const item of items) {
    try {
      if (direction === "gitlab-to-github") {
        await migrateGitLabToGitHub(item);
      } else {
        await migrateGitHubToGitLab(item);
      }
      ok += 1;
    } catch (err) {
      failed += 1;
      const sourceName =
        item.path_with_namespace || item.full_name || item.name || "unknown";
      logError(`Failed: ${sourceName} -> ${err.message}`);
    }
  }

  log(`\nDone. Success: ${ok}, Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    logError(`Fatal error: ${err.stack || err}`);
    process.exit(1);
  });
}

// Exported for tests (test/git-migrate.test.js); not a public API.
module.exports = {
  LOG_LEVELS,
  buildProfiles,
  validateProfilesForDirection,
  resolveLogLevel,
  redactUrl,
  normalizeBaseUrl,
  normalizeDirection,
  parseNextLink,
  sanitizeRepoName,
  sanitizeGitHubRepoSegment,
  sanitizeGitLabPathSegment,
  buildGitHubRepoName,
  buildGitLabProjectPath,
  buildSyncRepoName,
  activeSyncDestinations,
  matchesPattern,
  filterRepositories,
};
