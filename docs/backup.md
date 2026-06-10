[← Configuration](configuration.md) · [Back to README](../README.md) · [Usage →](usage.md)

# Бекап одной командой (режим sync)

Режим `sync` — fan-out бекап: один fetch всех доступных репозиториев рабочего GitLab и push --mirror сразу в личные GitLab и GitHub за один проход.

## Сводка

- **Команда:** `make backup` (или `MIGRATION_DIRECTION=sync node git-migrate.js`)
- **Источник:** рабочий GitLab (`SOURCE_GITLAB_*`)
- **Назначения:** личный GitHub (`DEST_GITHUB_*`) и/или личный GitLab (`DEST_GITLAB_*`) — достаточно одного, но тогда бекап не дублируется (warn)
- **Без интерактива:** режим рассчитан на запуск из cron — никаких вопросов в терминале
- **Изоляция ошибок:** сбой одного назначения не мешает второму, сбой одного репозитория не останавливает остальные

## Настройка

1. Заполните `.env` (см. [Configuration](configuration.md)):

```bash
# Рабочий GitLab — источник
SOURCE_GITLAB_BASE_URL=https://gitlab.mycompany.com
SOURCE_GITLAB_TOKEN=glpat_xxx          # права: read_api, read_repository
SOURCE_GITLAB_GROUP_ID=                # пусто = все доступные репозитории (membership)

# Личный GitHub — назначение
DEST_GITHUB_TOKEN=github_pat_xxx       # права: repo (создание приватных репозиториев)
DEST_GITHUB_OWNER=my-user

# Личный GitLab — назначение
DEST_GITLAB_BASE_URL=https://gitlab.com
DEST_GITLAB_TOKEN=glpat_yyy            # права: api (создание проектов)
DEST_GITLAB_NAMESPACE_ID=              # пусто = личный namespace токена
```

2. Проверьте без изменений:

```bash
make backup-dry-run
```

Вывод перечислит все найденные репозитории и куда они будут запушены.

3. Запустите бекап:

```bash
make backup
```

## Именование в назначениях

По умолчанию имя строится из полного пути рабочего репозитория с разделителем `__`: `team/sub/lib` → `team__sub__lib`. Это исключает коллизии одноимённых проектов из разных групп — они не перезапишут бекапы друг друга.

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `SYNC_FLAT_NAMES` | `false` | `true` — использовать только имя проекта (`lib`). Безопасно, если имена уникальны во всех группах. |

Имена длиннее 100 символов обрезаются (лимит GitHub) с предупреждением в логе.

## Фильтры: что бекапить

Полные пути репозиториев фильтруются glob-шаблонами (`*` — любые символы, exclude побеждает):

```bash
REPO_INCLUDE_PATTERNS=team/*               # только группа team
REPO_EXCLUDE_PATTERNS=*/sandbox-*,archive/*  # без песочниц и архивной группы
```

Количество отфильтрованного видно в логе (`Filtered out: N`), каждый пропущенный репозиторий — при `LOG_LEVEL=debug`.

## Итог запуска

В конце выводится сводка по каждому назначению:

```
Sync done. Repositories: 42
GitHub: ok 41, failed 1
GitLab: ok 42, failed 0
[warn] Repositories with failures: 1
```

При любых сбоях код выхода ненулевой — удобно для cron-алертов.

После реального запуска рядом появляется машиночитаемый отчёт `report-sync-<timestamp>.json`: время, источник, назначения, totals и статус каждого репозитория. Отключается `SYNC_REPORT=false`, путь переопределяется `SYNC_REPORT_FILE`. Файлы `report-*.json` игнорируются git и удаляются `make clean`.

## Автобекап по расписанию (macOS)

Ежедневный автозапуск через launchd (родной планировщик macOS — пропущенный во сне запуск выполнится при пробуждении, в отличие от cron):

```bash
make schedule-install                    # ежедневно в 13:00
make schedule-install BACKUP_TIME=09:30  # своё время
make schedule-status                     # состояние агента + хвост лога
make schedule-uninstall                  # выключить
```

Под капотом: `scripts/schedule.sh` рендерит `scripts/com.git-migrate.backup.plist.template`, валидирует его `plutil -lint` и ставит пользовательский launchd-агент `com.git-migrate.backup`, который запускает `make backup`. Вывод пишется в `logs/backup.log` (ошибки — `logs/backup.err.log`); при сбое бекапа агент завершится с ненулевым кодом, это видно в `make schedule-status` (`last exit code`).

Перед включением убедитесь, что `make backup-dry-run` отрабатывает корректно — агент использует тот же `.env`.

## Повторные запуски

Локальные зеркала кешируются в `MIRROR_ROOT` (`./mirrors`): повторный запуск делает `git fetch --prune` вместо полного клона, поэтому регулярный бекап быстрый.

## Troubleshooting

- **`Missing required configuration for sync: ...`** — перечислены недостающие переменные; нужен источник и минимум одно полное назначение.
- **Ошибка по одному назначению** — смотрите `[error] <Dest> destination failed for <repo>: ...`; второе назначение и остальные репозитории продолжают обрабатываться.
- **Подробная трассировка** — `LOG_LEVEL=debug make backup-dry-run` (токены в логах маскируются).

## См. также

- [Configuration](configuration.md) — все переменные окружения
- [Usage](usage.md) — направления миграции
