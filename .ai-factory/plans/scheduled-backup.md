# План: Запуск по расписанию — launchd для make backup

Branch: main (без создания ветки, `git.create_branches: false`)
Создан: 2026-06-10

## Settings

- Testing: lint-only (plutil -lint для plist, bash -n для скрипта; node-тесты не нужны — кода JS нет)
- Logging: stdout/stderr launchd-агента в logs/backup.log и logs/backup.err.log; echo-шаги в schedule.sh
- Docs: yes (раздел «Расписание» в docs/backup.md)

## Roadmap Linkage

Milestone: "Запуск по расписанию"
Rationale: последний шаг автоматизации — ежедневный автобекап без участия пользователя.

## Контекст и решения

- **launchd, не cron** — родной для macOS: `StartCalendarInterval` догоняет пропущенный во сне запуск при пробуждении; cron на macOS такие запуски молча пропускает.
- **plist вызывает `make backup`** (`/usr/bin/make -C <repo> backup`) с явным `PATH` в `EnvironmentVariables` — окружение launchd минимально, node/git туда не входят. `DRY_RUN=false` из цели backup имеет приоритет над `.env` (loadEnvFromFile не перетирает установленные переменные).
- **Агент пользователя** — `~/Library/LaunchAgents/com.git-migrate.backup.plist`, управление через `launchctl bootstrap/bootout gui/$UID`.
- **Частота** — раз в день, время настраивается: `make schedule-install BACKUP_TIME=13:00`.
- **Логи** — `logs/` внутри репозитория, добавить в `.gitignore`.

## Tasks

- [x] Task 13: Шаблон launchd plist — scripts/com.git-migrate.backup.plist.template с плейсхолдерами {{REPO_DIR}}/{{HOUR}}/{{MINUTE}}/{{PATH_VALUE}}
- [x] Task 14: scripts/schedule.sh — install [HH:MM] / uninstall / status; рендер sed'ом, plutil -lint, launchctl bootstrap/bootout, идемпотентность
- [x] Task 15: Makefile-цели schedule-install/uninstall/status (BACKUP_TIME ?= 13:00) + logs/ в .gitignore + smoke-проверка на этой машине

## Критерии готовности

- `make schedule-install` ставит агент, `make schedule-status` показывает его и хвост лога, `make schedule-uninstall` снимает; повторные вызовы не падают
- `plutil -lint` отрендеренного plist проходит
- `make ci` остаётся зелёным; существующие цели не задеты
- После smoke-проверки агент снят (включает пользователь осознанно)
