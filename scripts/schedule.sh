#!/usr/bin/env bash
# Управление ежедневным автобекапом (launchd-агент com.git-migrate.backup).
# Использование: schedule.sh install [HH:MM] | uninstall | status
set -euo pipefail

LABEL="com.git-migrate.backup"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "${SCRIPT_DIR}")"
TEMPLATE="${SCRIPT_DIR}/${LABEL}.plist.template"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  install [HH:MM]   Включить ежедневный автобекап (по умолчанию 13:00)
  uninstall         Выключить автобекап и удалить агент
  status            Состояние агента и последние строки лога
EOF
  exit 1
}

install_agent() {
  local time="${1:-13:00}"

  if [[ ! "${time}" =~ ^([01]?[0-9]|2[0-3]):[0-5][0-9]$ ]]; then
    echo "Ошибка: время должно быть в формате HH:MM (например 13:00), получено: '${time}'" >&2
    exit 1
  fi
  local hour="${time%%:*}"
  local minute="${time##*:}"
  # без ведущих нулей — plist ждёт integer
  hour=$((10#${hour}))
  minute=$((10#${minute}))

  if ! command -v node >/dev/null 2>&1; then
    echo "Ошибка: node не найден в PATH — бекапу нечем запускаться" >&2
    exit 1
  fi
  local node_dir
  node_dir="$(dirname "$(command -v node)")"
  local path_value="${node_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

  echo "Репозиторий:  ${REPO_DIR}"
  echo "Расписание:   ежедневно в $(printf '%02d:%02d' "${hour}" "${minute}")"
  echo "PATH агента:  ${path_value}"

  mkdir -p "${REPO_DIR}/logs" "${HOME}/Library/LaunchAgents"

  local rendered
  rendered="$(mktemp "/tmp/${LABEL}.plist.XXXXXX")"
  sed -e "s|{{REPO_DIR}}|${REPO_DIR}|g" \
      -e "s|{{PATH_VALUE}}|${path_value}|g" \
      -e "s|{{HOUR}}|${hour}|g" \
      -e "s|{{MINUTE}}|${minute}|g" \
      "${TEMPLATE}" > "${rendered}"

  echo "Проверяю plist (plutil -lint)..."
  plutil -lint "${rendered}"

  cp "${rendered}" "${PLIST_DEST}"
  rm -f "${rendered}"

  echo "Перезагружаю launchd-агент..."
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "${DOMAIN}" "${PLIST_DEST}"

  echo "Готово: автобекап включён — ежедневно в $(printf '%02d:%02d' "${hour}" "${minute}")."
  echo "Логи: ${REPO_DIR}/logs/backup.log (ошибки: backup.err.log)"
  echo "Статус: make schedule-status; выключить: make schedule-uninstall"
}

uninstall_agent() {
  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "Снимаю launchd-агент ${LABEL}..."
    launchctl bootout "${DOMAIN}/${LABEL}"
  else
    echo "Агент ${LABEL} не загружен — пропускаю bootout."
  fi

  if [[ -f "${PLIST_DEST}" ]]; then
    rm -f "${PLIST_DEST}"
    echo "Удалён ${PLIST_DEST}"
  else
    echo "Файл агента отсутствует — уже удалён."
  fi
  echo "Автобекап выключен."
}

status_agent() {
  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "Агент ${LABEL}: загружен"
    launchctl print "${DOMAIN}/${LABEL}" | grep -E "state|last exit code|run interval" || true
    if [[ -f "${PLIST_DEST}" ]]; then
      local hour minute
      hour="$(plutil -extract StartCalendarInterval.Hour raw -o - "${PLIST_DEST}")"
      minute="$(plutil -extract StartCalendarInterval.Minute raw -o - "${PLIST_DEST}")"
      printf 'Расписание: ежедневно в %02d:%02d\n' "${hour}" "${minute}"
    fi
  else
    echo "Агент ${LABEL}: не загружен (включить: make schedule-install)"
  fi

  local log_file="${REPO_DIR}/logs/backup.log"
  if [[ -f "${log_file}" ]]; then
    echo
    echo "Последние строки ${log_file}:"
    tail -n 5 "${log_file}"
  else
    echo "Лог ещё не создан: ${log_file}"
  fi
}

case "${1:-}" in
  install)   install_agent "${2:-13:00}" ;;
  uninstall) uninstall_agent ;;
  status)    status_agent ;;
  *)         usage ;;
esac
