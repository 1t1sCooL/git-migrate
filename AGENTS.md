# AGENTS.md

> Файл-карта проекта для AI-агентов и новых разработчиков. Обновляйте при значимых изменениях структуры. Раздел «Документация» поддерживается командой `/aif-docs`.

## Обзор проекта

CLI-утилита на Node.js для двусторонней зеркальной миграции репозиториев между GitLab и GitHub. Подробности — в `.ai-factory/DESCRIPTION.md`.

## Технологический стек

- **Язык программирования:** JavaScript (Node.js 18+, CommonJS)
- **Фреймворк:** отсутствует (standalone CLI)
- **База данных:** отсутствует
- **ORM:** отсутствует

## Структура проекта

```
git-migrate/
├── git-migrate.js          # Единый исполняемый CLI-скрипт (миграция + sync-бекап)
├── test/                   # Тесты node:test (make test)
├── scripts/                # schedule.sh + launchd plist-шаблон (автобекап по расписанию)
├── .env.example            # Шаблон переменных окружения (профили SOURCE_*/DEST_*, флаги)
├── Makefile                # Команды: setup, run, backup, schedule-*, check, test, clean
├── README.md               # Посадочная страница (RU)
├── docs/                   # Детальная документация (getting-started, configuration, backup, usage)
├── .gitignore              # Игнорирует .env, mirrors/, логи, отчёты
├── .mcp.json               # Конфигурация MCP-серверов
├── .ai-factory/            # Контекст AI Factory (конфиг, описание, правила, архитектура)
│   ├── config.yaml         # Настройки AI Factory (язык, git, пути)
│   ├── DESCRIPTION.md      # Спецификация проекта
│   └── rules/base.md       # Автоопределённые соглашения кодовой базы
├── .github/workflows/      # CI: lint.yml (синтаксис), security.yml (gitleaks, audit)
├── .claude/                # Skills и настройки для Claude Code
└── .cursor/                # Skills и настройки для Cursor
```

## Ключевые точки входа

| Файл | Назначение |
|------|------------|
| `git-migrate.js` | Точка входа CLI; `main()` оркестрирует выбор направления, миграцию и sync-бекап |
| `scripts/schedule.sh` | Управление launchd-агентом автобекапа (install/uninstall/status) |
| `.env.example` | Эталон конфигурации окружения; копируется в `.env` перед запуском |
| `.mcp.json` | Конфигурация MCP-серверов для AI-агентов |

## Документация

| Документ | Путь | Описание |
|----------|------|----------|
| README | README.md | Посадочная страница проекта |
| Getting Started | docs/getting-started.md | Требования, установка, настройка, первый запуск |
| Configuration | docs/configuration.md | Переменные окружения и флаги |
| Backup | docs/backup.md | Бекап одной командой и автобекап по расписанию |
| Usage | docs/usage.md | Направления миграции и логика переноса |

## AI-контекстные файлы

| Файл | Назначение |
|------|------------|
| AGENTS.md | Структурная карта проекта для AI-агентов |
| .ai-factory/DESCRIPTION.md | Спецификация: стек, возможности, архитектура |
| .ai-factory/ARCHITECTURE.md | Архитектурные правила проекта (паттерн: Layered) |
| .ai-factory/rules/base.md | Автоопределённые соглашения кодовой базы |
| CLAUDE.md | Глобальные пользовательские инструкции |

## Правила для агентов

- Не объединяйте независимые shell-команды через `&&` — выполняйте их по отдельности:
  - Неправильно: `git checkout main && git pull`
  - Правильно: сначала `git checkout main`, затем `git pull origin main`
- Секреты (токены) только из окружения/`.env`; не хардкодить и не коммитить.
- Изменения проверять в режиме `DRY_RUN=true` перед реальным запуском.
