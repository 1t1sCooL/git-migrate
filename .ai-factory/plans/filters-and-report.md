# План: Фильтры обнаружения + JSON-отчёт синхронизации

Branch: main (без создания ветки, `git.create_branches: false`)
Создан: 2026-06-10

## Settings

- Testing: yes (расширение test/git-migrate.test.js)
- Logging: verbose (существующий LOG_LEVEL)
- Docs: yes

## Roadmap Linkage

Milestone: "Обнаружение всех доступных репозиториев" + "Отчёт о синхронизации"
Rationale: закрывают два оставшихся реализуемых майлстоуна; membership-обнаружение и сводка с exit code уже сделаны ранее — остались фильтры include/exclude и файл-отчёт.

## Контекст и решения

- **Фильтры** — `REPO_INCLUDE_PATTERNS` / `REPO_EXCLUDE_PATTERNS` (через запятую, glob `*`), сопоставление по полному пути (`group/sub/project` / `owner/repo`), exclude побеждает; применяются и в sync, и в миграциях.
- **Отчёт** — JSON `report-sync-<timestamp>.json` (паттерн уже в `.gitignore` и `make clean`); чистый builder для тестируемости; отключается `SYNC_REPORT=false`; ошибки записи не валят бекап.

## Tasks

- [x] Task 16: Фильтры обнаружения include/exclude + тесты — matchesPattern/filterRepositories, применение в runSync и main(), .env.example
- [x] Task 17: JSON-отчёт синхронизации + тесты — buildSyncReport, запись в runSync, SYNC_REPORT/SYNC_REPORT_FILE, .env.example

## Критерии готовности

- Фильтры работают в dry-run sync против мок-API (исключённые видны в debug-логе, в сводке их нет)
- После реального/мок sync появляется валидный JSON-отчёт с totals и пер-репозиторными статусами
- `make ci` зелёный, легаси-поведение без фильтров не изменилось
