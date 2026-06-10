# git-migrate — build automation
# Zero-dependency Node.js CLI. Targets cover setup, running, and cleanup.

SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --no-print-directory

# Variables
NODE        ?= node
ENTRY       := git-migrate.js
ENV_FILE    := .env
ENV_EXAMPLE := .env.example
MIRROR_ROOT ?= ./mirrors

.PHONY: help setup check test run dry-run migrate-gl2gh migrate-gh2gl backup backup-dry-run schedule-install schedule-uninstall schedule-status clean ci

##@ General

help: ## Показать это сообщение со списком целей
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ Setup

setup: ## Создать .env из .env.example (если ещё нет)
	@if [ -f "$(ENV_FILE)" ]; then \
		echo "$(ENV_FILE) уже существует — пропускаю"; \
	else \
		cp "$(ENV_EXAMPLE)" "$(ENV_FILE)"; \
		echo "Создан $(ENV_FILE). Заполните токены и настройки."; \
	fi

check: ## Проверить синтаксис скрипта (node --check)
	@$(NODE) --check $(ENTRY)
	@echo "Синтаксис OK: $(ENTRY)"

test: ## Запустить тесты (node --test)
	@$(NODE) --test

##@ Run

run: ## Запустить миграцию (направление из .env или интерактивно)
	@$(NODE) $(ENTRY)

dry-run: ## Безопасный прогон без изменений (DRY_RUN=true)
	@DRY_RUN=true $(NODE) $(ENTRY)

migrate-gl2gh: ## Реальная миграция GitLab -> GitHub
	@MIGRATION_DIRECTION=gitlab-to-github DRY_RUN=false $(NODE) $(ENTRY)

migrate-gh2gl: ## Реальная миграция GitHub -> GitLab
	@MIGRATION_DIRECTION=github-to-gitlab DRY_RUN=false $(NODE) $(ENTRY)

backup: ## Бекап: все рабочие репозитории -> личные GitLab + GitHub
	@MIGRATION_DIRECTION=sync DRY_RUN=false $(NODE) $(ENTRY)

backup-dry-run: ## Безопасная проверка бекапа без изменений
	@MIGRATION_DIRECTION=sync DRY_RUN=true $(NODE) $(ENTRY)

##@ Schedule

BACKUP_TIME ?= 13:00

schedule-install: ## Включить ежедневный автобекап (make schedule-install BACKUP_TIME=13:00)
	@scripts/schedule.sh install "$(BACKUP_TIME)"

schedule-uninstall: ## Выключить автобекап
	@scripts/schedule.sh uninstall

schedule-status: ## Статус автобекапа и последние логи
	@scripts/schedule.sh status

##@ Maintenance

clean: ## Удалить локальные зеркала, логи и отчёты
	@rm -rf "$(MIRROR_ROOT)"
	@rm -f ./*.log report-*.json report-*.csv
	@echo "Очищено: $(MIRROR_ROOT), логи, отчёты"

##@ CI

ci: check test ## Проверки для CI (синтаксис + тесты)
	@echo "CI checks passed"
