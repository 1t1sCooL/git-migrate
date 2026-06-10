# План: Профили источника и назначений

Branch: main (без создания ветки, `git.create_branches: false`)
Создан: 2026-06-10

## Settings

- Testing: yes (node:test, без внешних зависимостей)
- Logging: verbose (LOG_LEVEL: debug|info|warn|error, по умолчанию info)
- Docs: yes

## Roadmap Linkage

Milestone: "Профили источника и назначений"
Rationale: фундамент для режима sync (fan-out) и единой команды бекапа — конфигурация «рабочий GitLab» + «личный GitLab» + «личный GitHub» с раздельными токенами и base URL.

## Контекст

Сейчас конфиг знает один GitLab (`GITLAB_*`) и один GitHub (`GITHUB_*`); направление миграции решает, кто источник. Для цели «бекап рабочего гита в личные GitLab и GitHub» нужны раздельные профили. Вводим четыре именованных профиля с fallback на легаси-переменные:

| Профиль | Переменные | Легаси-fallback |
|---------|-----------|-----------------|
| sourceGitlab | `SOURCE_GITLAB_BASE_URL`, `SOURCE_GITLAB_TOKEN`, `SOURCE_GITLAB_GROUP_ID` | `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `GITLAB_GROUP_ID` |
| sourceGithub | `SOURCE_GITHUB_TOKEN`, `SOURCE_GITHUB_OWNER`, `SOURCE_GITHUB_OWNER_TYPE` | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_OWNER_TYPE` |
| destGitlab | `DEST_GITLAB_BASE_URL`, `DEST_GITLAB_TOKEN`, `DEST_GITLAB_NAMESPACE_ID` | `GITLAB_BASE_URL`, `GITLAB_TOKEN`, `GITLAB_TARGET_NAMESPACE_ID` |
| destGithub | `DEST_GITHUB_TOKEN`, `DEST_GITHUB_OWNER`, `DEST_GITHUB_OWNER_TYPE` | `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_OWNER_TYPE` |

API-клиенты перестают читать глобальный config и принимают профиль параметром (правило архитектуры: конфигурация — на границе). Глобальный `REQUIRED_ENV` заменяется валидацией по выбранному направлению.

## Tasks

### Фаза 1: Фундамент

- [x] Task 1: Логирование с уровнями (LOG_LEVEL) — logDebug/logInfo/logWarn/logError, debug-трассировка API и git-операций, без токенов в логах
- [x] Task 2: Профили источника и назначений в конфиге — buildProfiles() с fallback на легаси, обновить .env.example

### Фаза 2: Рефакторинг клиентов (зависят от задачи 2)

- [x] Task 3: Рефакторинг GitLab-клиента под профили — все gitlab*-функции принимают profile, кэш namespace с baseUrl в ключе
- [x] Task 4: Рефакторинг GitHub-клиента под профили — все github*-функции принимают profile

### Фаза 3: Сценарии и проверка (зависят от задач 3-4)

- [x] Task 5: Сценарии миграции и main() на профилях — gl2gh: sourceGitlab→destGithub, gh2gl: sourceGithub→destGitlab; валидация по направлению; module.exports + require.main guard
- [x] Task 6: Тесты node:test + make test — buildProfiles/санитайзеры/normalizeDirection/parseNextLink/LOG_LEVEL; цель `test` в Makefile и в `ci`

## Commit Plan

| Checkpoint | После задач | Сообщение |
|------------|-------------|-----------|
| 1 | 1-2 | `feat(config): add source/destination remote profiles with legacy fallback` |
| 2 | 3-5 | `refactor(clients): pass remote profiles to GitLab/GitHub API clients` |
| 3 | 6 | `test: cover profiles, sanitizers and log levels with node:test` |

## Критерии готовности

- Легаси-конфиг (`GITLAB_*`/`GITHUB_*`) работает без изменений — оба направления миграции ведут себя как раньше
- Новые `SOURCE_*`/`DEST_*` переменные имеют приоритет над легаси
- `node --check git-migrate.js` и `node --test test/` проходят
- Токены не появляются в логах ни на одном уровне
