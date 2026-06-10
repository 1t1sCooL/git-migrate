#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

loadEnvFromFile();

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const config = {
  gitlabBaseUrl: (process.env.GITLAB_BASE_URL || "").replace(/\/+$/, ""),
  gitlabToken: process.env.GITLAB_TOKEN || "",
  gitlabGroupId: process.env.GITLAB_GROUP_ID || "",
  gitlabTargetNamespaceId: process.env.GITLAB_TARGET_NAMESPACE_ID || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  githubOwner: process.env.GITHUB_OWNER || "",
  githubOwnerType: (process.env.GITHUB_OWNER_TYPE || "user").toLowerCase(),
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
  logLevel: resolveLogLevel(process.env.LOG_LEVEL),
};

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

// Direction-aware replacement for the old global REQUIRED_ENV check.
function validateProfilesForDirection(direction, remoteProfiles) {
  const missing = [];
  const req = (value, label) => {
    if (!value) missing.push(label);
  };

  if (direction === "gitlab-to-github") {
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

function buildGitLabProjectPath(repo) {
  if (config.useOriginalRepoName) {
    return sanitizeGitLabPathSegment(repo.name);
  }
  if (config.preserveNamespace) {
    return sanitizeRepoName(
      repo.full_name || `${config.githubOwner}/${repo.name}`,
    );
  }
  return sanitizeRepoName(repo.name);
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
    const answer = await rl.question("Enter 1 or 2: ");
    const direction = normalizeDirection(answer);
    if (!direction) {
      throw new Error("Invalid direction. Use 1 or 2.");
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

async function gitlabGetAll(url) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    logDebug(`GitLab API GET ${nextUrl}`);
    const res = await fetch(nextUrl, {
      headers: {
        "PRIVATE-TOKEN": config.gitlabToken,
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

async function githubGetAll(url) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    logDebug(`GitHub API GET ${nextUrl}`);
    const res = await fetch(nextUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.githubToken}`,
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

async function getGitLabProjects() {
  const perPage = 100;
  let url;

  if (config.gitlabGroupId) {
    url = `${config.gitlabBaseUrl}/api/v4/groups/${encodeURIComponent(
      config.gitlabGroupId,
    )}/projects?include_subgroups=true&per_page=${perPage}&page=1&simple=true`;
  } else {
    url = `${config.gitlabBaseUrl}/api/v4/projects?membership=true&per_page=${perPage}&page=1&simple=true`;
  }

  const projects = await gitlabGetAll(url);
  return projects.filter((p) => (config.includeArchived ? true : !p.archived));
}

async function getGitHubRepos() {
  const perPage = 100;
  if (config.githubOwnerType === "org") {
    const url = `https://api.github.com/orgs/${encodeURIComponent(
      config.githubOwner,
    )}/repos?per_page=${perPage}&type=all&page=1`;
    return githubGetAll(url);
  }

  const url = `https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=${perPage}&page=1`;
  const repos = await githubGetAll(url);
  return repos.filter(
    (repo) => repo.owner && repo.owner.login === config.githubOwner,
  );
}

async function githubRequest(method, endpoint, body) {
  logDebug(`GitHub API ${method} ${endpoint}`);
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
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

async function gitlabRequest(method, endpoint, body) {
  logDebug(`GitLab API ${method} ${endpoint}`);
  const res = await fetch(`${config.gitlabBaseUrl}/api/v4${endpoint}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": config.gitlabToken,
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

async function githubRepoExists(repoName) {
  try {
    await githubRequest("GET", `/repos/${config.githubOwner}/${repoName}`);
    return true;
  } catch (err) {
    if (String(err.message).includes("404")) {
      return false;
    }
    throw err;
  }
}

async function ensureGitHubRepo(repoName, description) {
  if (await githubRepoExists(repoName)) {
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

  if (config.githubOwnerType === "org") {
    await githubRequest("POST", `/orgs/${config.githubOwner}/repos`, payload);
  } else {
    await githubRequest("POST", "/user/repos", payload);
  }

  return { created: true };
}

async function findGitLabProjectByPath(repoPath, namespaceId) {
  const result = await gitlabRequest(
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

async function ensureGitLabProject(repoPath, description, namespaceId) {
  const existing = await findGitLabProjectByPath(repoPath, namespaceId);
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
    const created = await gitlabRequest("POST", "/projects", payload);
    return { created: true, project: created };
  } catch (err) {
    if (err.status === 400 || err.status === 409) {
      const project = await findGitLabProjectByPath(repoPath, namespaceId);
      if (project) {
        return { created: false, project };
      }
    }
    throw err;
  }
}

async function findOrCreateGitLabSubgroup(parentGroupId, subgroupName) {
  const safePath = sanitizeGitLabPathSegment(subgroupName);
  if (!safePath) {
    throw new Error(
      `Cannot derive valid GitLab subgroup path from '${subgroupName}'`,
    );
  }

  const cacheKey = `${parentGroupId}:${safePath}`;
  if (gitlabNamespaceCache.has(cacheKey)) {
    return gitlabNamespaceCache.get(cacheKey);
  }

  const subgroups = await gitlabGetAll(
    `${config.gitlabBaseUrl}/api/v4/groups/${encodeURIComponent(
      parentGroupId,
    )}/subgroups?per_page=100&page=1`,
  );
  const existing = subgroups.find((group) => group.path === safePath);
  if (existing) {
    gitlabNamespaceCache.set(cacheKey, existing.id);
    return existing.id;
  }

  const created = await gitlabRequest("POST", "/groups", {
    name: subgroupName,
    path: safePath,
    parent_id: Number(parentGroupId),
    visibility: "private",
  });
  gitlabNamespaceCache.set(cacheKey, created.id);
  return created.id;
}

async function resolveTargetNamespaceIdForGitHubRepo(repo) {
  if (!config.gitlabTargetNamespaceId) {
    return null;
  }

  const baseNamespaceId = Number(config.gitlabTargetNamespaceId);
  if (!config.preserveSourceOwnerAsGitLabGroup) {
    return baseNamespaceId;
  }

  const ownerName = repo.owner && repo.owner.login ? repo.owner.login : "";
  if (!ownerName) {
    return baseNamespaceId;
  }

  return findOrCreateGitLabSubgroup(baseNamespaceId, ownerName);
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
    `://oauth2:${encodeToken(config.gitlabToken)}@`,
  );

  const localMirrorPath = path.join(
    config.mirrorRoot,
    `gl2gh__${project.path_with_namespace.replace(/\//g, "__")}.git`,
  );

  log(
    `\n=== ${project.path_with_namespace} -> ${config.githubOwner}/${repoName} ===`,
  );

  if (config.dryRun) {
    log("[DRY RUN] skip clone/push");
    return;
  }

  if (!(await githubRepoExists(repoName))) {
    repoName = await askTargetRepoName(
      project.path_with_namespace,
      repoName,
      sanitizeGitHubRepoSegment,
      (name) => githubRepoExists(name),
    );
  }

  const githubUrlWithToken = `https://x-access-token:${encodeToken(
    config.githubToken,
  )}@github.com/${config.githubOwner}/${repoName}.git`;

  const { created } = await ensureGitHubRepo(
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
  let gitlabPath = buildGitLabProjectPath(repo);
  const githubHttp = repo.clone_url;

  const githubUrlWithToken = githubHttp.replace(
    "://",
    `://x-access-token:${encodeToken(config.githubToken)}@`,
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

  const namespaceId = await resolveTargetNamespaceIdForGitHubRepo(repo);

  if (!(await findGitLabProjectByPath(gitlabPath, namespaceId))) {
    gitlabPath = await askTargetRepoName(
      repo.full_name,
      gitlabPath,
      sanitizeGitLabPathSegment,
      async (name) => Boolean(await findGitLabProjectByPath(name, namespaceId)),
    );
  }

  const { created, project } = await ensureGitLabProject(
    gitlabPath,
    repo.description || `Migrated from GitHub: ${repo.full_name}`,
    namespaceId,
  );
  log(created ? "Created GitLab project" : "GitLab project already exists");

  const gitlabUrlWithToken = project.http_url_to_repo.replace(
    "://",
    `://oauth2:${encodeToken(config.gitlabToken)}@`,
  );

  fs.mkdirSync(path.dirname(localMirrorPath), { recursive: true });

  await ensureMirrorUpToDate(localMirrorPath, githubUrlWithToken);
  await pushMirror(localMirrorPath, "target", gitlabUrlWithToken);
  log("Success");
}

async function main() {
  const direction = await askDirection();
  validateProfilesForDirection(direction, profiles);
  log(`Starting migration: ${direction}`);
  fs.mkdirSync(config.mirrorRoot, { recursive: true });

  const items =
    direction === "gitlab-to-github"
      ? await getGitLabProjects()
      : await getGitHubRepos();
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

main().catch((err) => {
  logError(`Fatal error: ${err.stack || err}`);
  process.exit(1);
});
