const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
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
  buildSyncRepoName,
  activeSyncDestinations,
  matchesPattern,
  filterRepositories,
  buildSyncReport,
} = require("../git-migrate.js");

test("buildProfiles: легаси-переменные заполняют обе стороны", () => {
  const profiles = buildProfiles({
    GITLAB_BASE_URL: "https://gitlab.example.com/",
    GITLAB_TOKEN: "gl-token",
    GITLAB_GROUP_ID: "42",
    GITLAB_TARGET_NAMESPACE_ID: "77",
    GITHUB_TOKEN: "gh-token",
    GITHUB_OWNER: "me",
    GITHUB_OWNER_TYPE: "ORG",
  });

  assert.equal(profiles.sourceGitlab.baseUrl, "https://gitlab.example.com");
  assert.equal(profiles.sourceGitlab.token, "gl-token");
  assert.equal(profiles.sourceGitlab.groupId, "42");
  assert.equal(profiles.destGitlab.baseUrl, "https://gitlab.example.com");
  assert.equal(profiles.destGitlab.token, "gl-token");
  assert.equal(profiles.destGitlab.namespaceId, "77");
  assert.equal(profiles.sourceGithub.token, "gh-token");
  assert.equal(profiles.sourceGithub.owner, "me");
  assert.equal(profiles.sourceGithub.ownerType, "org");
  assert.equal(profiles.destGithub.token, "gh-token");
  assert.equal(profiles.destGithub.owner, "me");
});

test("buildProfiles: SOURCE_*/DEST_* имеют приоритет над легаси", () => {
  const profiles = buildProfiles({
    GITLAB_BASE_URL: "https://legacy.gitlab.com",
    GITLAB_TOKEN: "legacy-token",
    SOURCE_GITLAB_BASE_URL: "https://work.gitlab.com",
    SOURCE_GITLAB_TOKEN: "work-token",
    DEST_GITLAB_BASE_URL: "https://gitlab.com",
    DEST_GITLAB_TOKEN: "personal-token",
    GITHUB_TOKEN: "legacy-gh",
    GITHUB_OWNER: "legacy-owner",
    DEST_GITHUB_TOKEN: "personal-gh",
    DEST_GITHUB_OWNER: "personal-owner",
  });

  assert.equal(profiles.sourceGitlab.baseUrl, "https://work.gitlab.com");
  assert.equal(profiles.sourceGitlab.token, "work-token");
  assert.equal(profiles.destGitlab.baseUrl, "https://gitlab.com");
  assert.equal(profiles.destGitlab.token, "personal-token");
  assert.equal(profiles.destGithub.token, "personal-gh");
  assert.equal(profiles.destGithub.owner, "personal-owner");
  // sourceGithub не переопределён — падает на легаси
  assert.equal(profiles.sourceGithub.token, "legacy-gh");
  assert.equal(profiles.sourceGithub.owner, "legacy-owner");
});

test("buildProfiles: пустое окружение даёт пустые строки и ownerType user", () => {
  const profiles = buildProfiles({});
  assert.equal(profiles.sourceGitlab.baseUrl, "");
  assert.equal(profiles.sourceGitlab.token, "");
  assert.equal(profiles.destGithub.owner, "");
  assert.equal(profiles.sourceGithub.ownerType, "user");
  assert.equal(profiles.destGithub.ownerType, "user");
});

test("validateProfilesForDirection: gl2gh перечисляет недостающие переменные", () => {
  const profiles = buildProfiles({});
  assert.throws(
    () => validateProfilesForDirection("gitlab-to-github", profiles),
    (err) => {
      assert.match(err.message, /gitlab-to-github/);
      assert.match(err.message, /SOURCE_GITLAB_BASE_URL \(or GITLAB_BASE_URL\)/);
      assert.match(err.message, /SOURCE_GITLAB_TOKEN/);
      assert.match(err.message, /DEST_GITHUB_TOKEN/);
      assert.match(err.message, /DEST_GITHUB_OWNER/);
      return true;
    },
  );
});

test("validateProfilesForDirection: gh2gl перечисляет недостающие переменные", () => {
  const profiles = buildProfiles({});
  assert.throws(
    () => validateProfilesForDirection("github-to-gitlab", profiles),
    (err) => {
      assert.match(err.message, /SOURCE_GITHUB_TOKEN/);
      assert.match(err.message, /SOURCE_GITHUB_OWNER/);
      assert.match(err.message, /DEST_GITLAB_BASE_URL/);
      assert.match(err.message, /DEST_GITLAB_TOKEN/);
      return true;
    },
  );
});

test("validateProfilesForDirection: полный легаси-конфиг проходит оба направления", () => {
  const profiles = buildProfiles({
    GITLAB_BASE_URL: "https://gitlab.com",
    GITLAB_TOKEN: "t",
    GITHUB_TOKEN: "t",
    GITHUB_OWNER: "o",
  });
  assert.doesNotThrow(() =>
    validateProfilesForDirection("gitlab-to-github", profiles),
  );
  assert.doesNotThrow(() =>
    validateProfilesForDirection("github-to-gitlab", profiles),
  );
});

test("normalizeDirection: принимает синонимы и отклоняет мусор", () => {
  assert.equal(normalizeDirection("1"), "gitlab-to-github");
  assert.equal(normalizeDirection("gl2gh"), "gitlab-to-github");
  assert.equal(normalizeDirection("GitLab-To-GitHub"), "gitlab-to-github");
  assert.equal(normalizeDirection("2"), "github-to-gitlab");
  assert.equal(normalizeDirection("gh2gl"), "github-to-gitlab");
  assert.equal(normalizeDirection(""), "");
  assert.equal(normalizeDirection("nonsense"), "");
});

test("parseNextLink: разбирает заголовок Link от GitHub", () => {
  const header =
    '<https://api.github.com/user/repos?page=2>; rel="next", ' +
    '<https://api.github.com/user/repos?page=5>; rel="last"';
  assert.equal(parseNextLink(header), "https://api.github.com/user/repos?page=2");
  assert.equal(parseNextLink('<https://x>; rel="last"'), "");
  assert.equal(parseNextLink(null), "");
});

test("resolveLogLevel: известные уровни проходят, мусор падает на info", () => {
  assert.equal(resolveLogLevel("debug"), "debug");
  assert.equal(resolveLogLevel("ERROR"), "error");
  assert.equal(resolveLogLevel(undefined), "info");
  assert.equal(resolveLogLevel("bogus"), "info");
  // порядок уровней корректен для фильтрации
  assert.ok(LOG_LEVELS.debug < LOG_LEVELS.info);
  assert.ok(LOG_LEVELS.info < LOG_LEVELS.warn);
  assert.ok(LOG_LEVELS.warn < LOG_LEVELS.error);
});

test("redactUrl: прячет встроенные креденшалы", () => {
  assert.equal(
    redactUrl("https://oauth2:secret-token@gitlab.com/g/p.git"),
    "https://***@gitlab.com/g/p.git",
  );
  assert.equal(redactUrl("https://gitlab.com/g/p.git"), "https://gitlab.com/g/p.git");
});

test("normalizeBaseUrl: обрезает завершающие слэши", () => {
  assert.equal(normalizeBaseUrl("https://gitlab.com///"), "https://gitlab.com");
  assert.equal(normalizeBaseUrl(""), "");
  assert.equal(normalizeBaseUrl(undefined), "");
});

test("normalizeDirection: sync-синонимы", () => {
  assert.equal(normalizeDirection("3"), "sync");
  assert.equal(normalizeDirection("sync"), "sync");
  assert.equal(normalizeDirection("BACKUP"), "sync");
});

test("validateProfilesForDirection: sync требует источник и хотя бы одно назначение", () => {
  // нет ничего — перечисляет источник и назначения
  assert.throws(
    () => validateProfilesForDirection("sync", buildProfiles({})),
    (err) => {
      assert.match(err.message, /SOURCE_GITLAB_BASE_URL/);
      assert.match(err.message, /at least one destination/);
      return true;
    },
  );

  const source = {
    SOURCE_GITLAB_BASE_URL: "https://work.gitlab.com",
    SOURCE_GITLAB_TOKEN: "t",
  };

  // источник есть, назначений нет — ошибка только про назначения
  assert.throws(
    () => validateProfilesForDirection("sync", buildProfiles(source)),
    /at least one destination/,
  );

  // достаточно одного GitHub-назначения
  assert.doesNotThrow(() =>
    validateProfilesForDirection(
      "sync",
      buildProfiles({ ...source, DEST_GITHUB_TOKEN: "t", DEST_GITHUB_OWNER: "me" }),
    ),
  );

  // достаточно одного GitLab-назначения
  assert.doesNotThrow(() =>
    validateProfilesForDirection(
      "sync",
      buildProfiles({
        ...source,
        DEST_GITLAB_BASE_URL: "https://gitlab.com",
        DEST_GITLAB_TOKEN: "t",
      }),
    ),
  );

  // назначение есть, источника нет — ошибка про источник
  assert.throws(
    () =>
      validateProfilesForDirection(
        "sync",
        buildProfiles({ DEST_GITHUB_TOKEN: "t", DEST_GITHUB_OWNER: "me" }),
      ),
    /SOURCE_GITLAB_TOKEN/,
  );
});

test("activeSyncDestinations: определяет полностью настроенные назначения", () => {
  const profiles = buildProfiles({
    DEST_GITHUB_TOKEN: "t",
    DEST_GITHUB_OWNER: "me",
    DEST_GITLAB_BASE_URL: "https://gitlab.com",
    // DEST_GITLAB_TOKEN отсутствует — gitlab не активен
  });
  assert.deepEqual(activeSyncDestinations(profiles), {
    github: true,
    gitlab: false,
  });
});

test("buildSyncRepoName: путь через __ по умолчанию", () => {
  const project = { path: "lib", path_with_namespace: "team/sub/lib" };
  assert.equal(
    buildSyncRepoName(project, sanitizeGitHubRepoSegment, false),
    "team__sub__lib",
  );
  assert.equal(
    buildSyncRepoName(project, sanitizeGitLabPathSegment, false),
    "team__sub__lib",
  );
});

test("buildSyncRepoName: flat-режим использует только имя проекта", () => {
  const project = { path: "lib", path_with_namespace: "team/sub/lib" };
  assert.equal(buildSyncRepoName(project, sanitizeGitHubRepoSegment, true), "lib");
});

test("buildSyncRepoName: сегменты санитизируются, длина ограничена 100", () => {
  const project = {
    path: "App Name",
    path_with_namespace: "My Group/App Name",
  };
  assert.equal(
    buildSyncRepoName(project, sanitizeGitHubRepoSegment, false),
    "My-Group__App-Name",
  );

  const longSegment = "a".repeat(120);
  const longProject = {
    path: longSegment,
    path_with_namespace: `group/${longSegment}`,
  };
  const name = buildSyncRepoName(longProject, sanitizeGitHubRepoSegment, false);
  assert.ok(name.length <= 100, `length ${name.length} > 100`);
  assert.ok(name.startsWith("group__a"));
});

test("matchesPattern: точное совпадение, glob и регистр", () => {
  assert.ok(matchesPattern("team/app", "team/app"));
  assert.ok(matchesPattern("team/app", "team/*"));
  assert.ok(matchesPattern("team/sub/app", "team/*"));
  assert.ok(matchesPattern("team/sandbox-x", "*/sandbox-*"));
  assert.ok(matchesPattern("Team/App", "team/app")); // регистронезависимо
  assert.ok(!matchesPattern("other/app", "team/*"));
  assert.ok(!matchesPattern("team/app", "team")); // полное совпадение, не префикс
  assert.ok(matchesPattern("a.b/c", "a.b/*")); // точка экранируется
  assert.ok(!matchesPattern("axb/c", "a.b/*"));
});

test("filterRepositories: include, exclude и их приоритет", () => {
  const repos = [
    { name: "team/app" },
    { name: "team/sandbox-test" },
    { name: "other/lib" },
  ];
  const byName = (r) => r.name;

  // пустые фильтры — всё проходит
  assert.equal(filterRepositories(repos, byName, [], []).length, 3);

  // только include
  assert.deepEqual(
    filterRepositories(repos, byName, ["team/*"], []).map(byName),
    ["team/app", "team/sandbox-test"],
  );

  // только exclude
  assert.deepEqual(
    filterRepositories(repos, byName, [], ["*/sandbox-*"]).map(byName),
    ["team/app", "other/lib"],
  );

  // exclude побеждает include
  assert.deepEqual(
    filterRepositories(repos, byName, ["team/*"], ["*/sandbox-*"]).map(byName),
    ["team/app"],
  );
});

test("buildSyncReport: totals и список репозиториев", () => {
  const meta = {
    startedAt: "2026-06-10T10:00:00.000Z",
    finishedAt: "2026-06-10T10:05:00.000Z",
    dryRun: false,
    source: "https://work.gitlab.com",
    destinations: { github: true, gitlab: true },
  };
  const repos = [
    { name: "team/app", github: "ok", gitlab: "ok" },
    { name: "team/lib", github: "failed", gitlab: "ok" },
    { name: "team/old", github: "ok", gitlab: "skipped" },
  ];

  const report = buildSyncReport(meta, repos);

  assert.equal(report.source, "https://work.gitlab.com");
  assert.deepEqual(report.totals.github, { ok: 2, failed: 1, skipped: 0 });
  assert.deepEqual(report.totals.gitlab, { ok: 2, failed: 0, skipped: 1 });
  assert.equal(report.repos.length, 3);
  assert.deepEqual(report.repos[1], {
    name: "team/lib",
    github: "failed",
    gitlab: "ok",
  });
  // отчёт сериализуем в JSON без потерь
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test("buildSyncReport: пустой прогон", () => {
  const report = buildSyncReport({ dryRun: true }, []);
  assert.deepEqual(report.totals.github, { ok: 0, failed: 0, skipped: 0 });
  assert.deepEqual(report.repos, []);
});

test("санитайзеры имён репозиториев", () => {
  // "/" -> "--", но затем серия дефисов коллапсируется в один
  assert.equal(sanitizeRepoName("Group/Sub Project"), "group-sub-project");
  assert.equal(sanitizeGitHubRepoSegment("My Repo/Name"), "My-Repo-Name");
  assert.equal(sanitizeGitLabPathSegment("My Repo!!"), "my-repo");
  assert.equal(sanitizeGitLabPathSegment("--weird--"), "weird");
});
