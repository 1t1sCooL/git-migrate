# git-migrate

[![Lint](https://github.com/1t1sCooL/git-migrate/actions/workflows/lint.yml/badge.svg)](https://github.com/1t1sCooL/git-migrate/actions/workflows/lint.yml)
[![Security](https://github.com/1t1sCooL/git-migrate/actions/workflows/security.yml/badge.svg)](https://github.com/1t1sCooL/git-migrate/actions/workflows/security.yml)

> Двусторонняя зеркальная миграция git-репозиториев между GitLab и GitHub.

CLI-утилита на Node.js, которая переносит репозитории целиком (со всей историей) в направлениях `GitLab → GitHub` и `GitHub → GitLab`. Направление выбирается интерактивно или через переменную окружения. Все создаваемые на стороне назначения репозитории создаются как `private`.

## Быстрый старт

```bash
cp .env.example .env   # заполните токены и настройки
node git-migrate.js    # DRY_RUN=true по умолчанию — безопасный прогон
```

Требуется Node.js 18+ и `git` в `PATH`. Подробнее — в [Getting Started](docs/getting-started.md).

Через Makefile:

```bash
make setup     # создать .env из .env.example
make dry-run   # безопасный прогон
make help      # все доступные команды
```

## Возможности

- **Два направления** — `GitLab → GitHub` и `GitHub → GitLab`, выбор интерактивно или через `MIGRATION_DIRECTION`.
- **Профили источника и назначений** — раздельные токены и base URL: рабочий GitLab как источник, личные GitLab/GitHub как назначения (`SOURCE_*`/`DEST_*` с fallback на `GITLAB_*`/`GITHUB_*`).
- **Полное зеркало** — перенос всей истории через `git clone --mirror` / `git push --mirror`.
- **Идемпотентность** — репозитории/проекты/подгруппы на стороне назначения создаются только если их нет.
- **Сохранение имён** — имя репозитория по умолчанию сохраняется как в источнике.
- **Интерактивное именование** — если репозитория ещё нет в назначении, скрипт предложит ввести имя (Enter — имя по умолчанию); отключается через `INTERACTIVE_NAMING=false`.
- **Подгруппы GitLab** — для `GitHub → GitLab` можно автоматически создавать подгруппу по owner из GitHub.
- **LFS (опционально)** — перенос LFS-объектов при `MIGRATE_LFS=true`.
- **Безопасность** — приватные репозитории по умолчанию, режим `DRY_RUN`, токены только из окружения.
- **Zero-dependency** — только встроенные модули Node.

## Пример

```bash
# GitLab → GitHub, реальный запуск
MIGRATION_DIRECTION=gitlab-to-github DRY_RUN=false node git-migrate.js
```

---

## Документация

| Раздел | Описание |
|--------|----------|
| [Getting Started](docs/getting-started.md) | Требования, установка, настройка `.env`, первый запуск |
| [Configuration](docs/configuration.md) | Полный справочник переменных окружения и флагов |
| [Usage](docs/usage.md) | Направления миграции и логика переноса |

## Лицензия

См. файл лицензии в репозитории (при наличии).
