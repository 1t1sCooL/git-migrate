# План: Режим sync — fan-out из рабочего GitLab в личные GitLab и GitHub

Branch: main (без создания ветки, `git.create_branches: false`)
Создан: 2026-06-10

## Settings

- Testing: yes (расширение test/git-migrate.test.js)
- Logging: verbose (через существующий LOG_LEVEL)
- Docs: yes

## Roadmap Linkage

Milestone: "Режим sync (fan-out)"
Rationale: ключевой шаг к единой команде бекапа — один fetch из рабочего GitLab, push --mirror сразу в личные GitLab и GitHub за один проход.

## Контекст и решения

Профили (`sourceGitlab`, `destGitlab`, `destGithub`) уже готовы (майлстоун «Профили источника и назначений»). Sync добавляется как третье «направление» поверх них.

Ключевые решения:

1. **Без интерактива** — sync рассчитан на cron: никаких вопросов в терминале, `askTargetRepoName` не используется.
2. **Имена из полного пути** — по умолчанию `group__sub__project` (сегменты `path_with_namespace` через `__`), чтобы одноимённые проекты из разных рабочих групп не перезаписывали друг друга. `SYNC_FLAT_NAMES=true` → плоские имена (`project`).
3. **Изоляция ошибок на двух уровнях** — сбой одного назначения не мешает второму; сбой одного репозитория не останавливает остальные.
4. **Хотя бы одно назначение** — sync работает и с одним настроенным личным git (warn), требует оба профиля только если оба заданы.

## Tasks

### Фаза 1: Фундамент sync

- [x] Task 7: Направление sync в CLI и валидация — normalizeDirection/askDirection + validateProfilesForDirection("sync"): источник + минимум одно назначение
- [x] Task 8: Имена репозиториев для бекапа — buildSyncRepoName: путь через `__`, флаг SYNC_FLAT_NAMES, лимит длины GitHub

### Фаза 2: Сценарий (зависит от 7-8)

- [x] Task 9: Сценарий syncProject с fan-out — одно зеркало, push в оба назначения, per-destination try/catch, без интерактива, DRY_RUN
- [x] Task 10: Ветка sync в main() — цикл по репозиториям, сводка per-destination (ok/failed/skipped), exit code

### Фаза 3: Команда и проверка (зависят от 10)

- [x] Task 11: make backup и backup-dry-run — единая команда бекапа в Makefile
- [x] Task 12: Тесты sync — направление, валидация назначений, buildSyncRepoName

## Commit Plan

| Checkpoint | После задач | Сообщение |
|------------|-------------|-----------|
| 1 | 7-10 | `feat(sync): fan-out backup from work GitLab to personal GitLab and GitHub` |
| 2 | 11-12 | `feat(sync): add make backup command and sync test coverage` |

## Критерии готовности

- `make backup-dry-run` с настроенными профилями перечисляет все доступные рабочие репозитории и план действий без изменений
- Ошибка пуша в одно назначение не мешает второму и следующим репозиториям; в сводке видно per-destination итоги
- Существующие направления `gitlab-to-github` / `github-to-gitlab` не изменились
- `make ci` зелёный (синтаксис + все тесты)
- Токены не светятся в логах
