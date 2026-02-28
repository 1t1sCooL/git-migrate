# Git mirror migration (two-way)

Скрипт поддерживает два направления:

- `GitLab -> GitHub`
- `GitHub -> GitLab`

При запуске он спрашивает направление в терминале.
Можно также заранее задать направление через `MIGRATION_DIRECTION`.

Все создаваемые репозитории/проекты на целевой стороне создаются как `private`.
По умолчанию имя репозитория сохраняется как в источнике.

## Требования

- Node.js 18+
- git в PATH
- Токены GitLab/GitHub с нужными правами

## Подготовка

1. Скопируй `.env.example` в `.env`.
2. Заполни значения в `.env`.
3. Скрипт автоматически загружает `.env` при старте.

### Важные переменные

- `GITHUB_OWNER_TYPE=user|org`
  - `user` для личного аккаунта
  - `org` для GitHub organization
- `GITLAB_GROUP_ID`
  - используется как источник при `GitLab -> GitHub`
- `GITLAB_TARGET_NAMESPACE_ID`
  - используется как namespace назначения при `GitHub -> GitLab`
  - если пусто, проект создается в личном namespace токена GitLab
- `USE_ORIGINAL_REPO_NAME=true|false`
  - `true` (по умолчанию): использовать имя репозитория как в источнике
  - `false`: использовать старую схему со склейкой namespace
- `PRESERVE_SOURCE_OWNER_AS_GITLAB_GROUP=true|false`
  - работает для `GitHub -> GitLab`
  - при `true` в GitLab создается/используется подгруппа с именем owner из GitHub, и репозиторий создается внутри нее
- `MIGRATION_DIRECTION`
  - опционально: `gitlab-to-github` или `github-to-gitlab`
  - если пусто, скрипт спросит в терминале

## Запуск

```powershell
node .\migrate-gitlab-to-github.js
```

## Как это работает

- Выбирает направление миграции (интерактивно или из `MIGRATION_DIRECTION`).
- Получает список репозиториев со стороны источника через API.
- Создает репозиторий/проект на стороне назначения (если его нет).
- Сохраняет исходное имя репозитория (по умолчанию).
- Для `GitHub -> GitLab` может автоматически создавать группу назначения по owner.
- Выполняет `git clone --mirror` или `git fetch --prune` из источника.
- Выполняет `git push --mirror` в назначение.
- При `MIGRATE_LFS=true` дополнительно переносит LFS-объекты.
