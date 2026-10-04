#!/usr/bin/env bash
# Отправка приложения TenderFit на сервер в России.
#
# Скрипт запускается с рабочей машины из корня проекта:
#   TENDERFIT_VPS=root@5.35.86.186 deploy/deploy-app.sh
#
# Чем отличается от deploy-worker.sh: тот возит только код воркера и на этом
# заканчивается. Приложение живёт в той же папке, но ему нужна сборка
# (`npm run build`) и перезапуск службы tenderfit-app, поэтому шаги разные, а
# дерево кода одно — после этого скрипта воркер тоже работает на новом коде.
#
# Ключи он не трогает: они лежат на сервере в /etc/tenderfit/app.env и
# /etc/tenderfit/worker.env и в архив не попадают.
#
# Простоя почти нет: сборка идёт, пока старая версия обслуживает запросы,
# и наружу меняется только в момент перезапуска — это несколько секунд.
set -euo pipefail

REMOTE="${TENDERFIT_VPS:-}"
REMOTE_DIR="${TENDERFIT_REMOTE_DIR:-/opt/tenderfit-ai}"
SSH_KEY="${TENDERFIT_SSH_KEY:-}"
RESTART_WORKER=0

SSH_OPTS=()
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
fi

# Keepalive: шаги «Зависимости» и «Сборка» идут молча по минуте и дольше, а
# молчаливое соединение рвётся первым. 03.10.2026 деплой оборвался ровно так —
# «Connection reset by peer» во время npm ci: дерево кода обновилось, а сборка
# и перезапуск не выполнились, и доделывать пришлось руками на сервере.
# ServerAliveInterval шлёт пакеты в паузах и держит сессию живой.
SSH_OPTS+=(-o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o ConnectTimeout=20)

usage() {
  cat <<'USAGE'
deploy/deploy-app.sh — сборка и запуск приложения на сервере в России.

  TENDERFIT_VPS=root@5.35.86.186 deploy/deploy-app.sh [--with-worker]

Переменные:
  TENDERFIT_VPS         ssh-адрес сервера (обязательно)
  TENDERFIT_REMOTE_DIR  куда распаковывать, по умолчанию /opt/tenderfit-ai
  TENDERFIT_SSH_KEY     файл закрытого ключа, если он не ключ по умолчанию

Что делает: собирает архив без node_modules, .next, logs, рабочих выгрузок и
любых .env*, копирует по ssh, распаковывает, ставит зависимости, собирает
Next.js и перезапускает tenderfit-app. После перезапуска проверяет, что
приложение отвечает, и при отказе выходит с ошибкой.

--with-worker — перезапустить заодно tenderfit-worker. Без флага воркер
продолжает работать на новом коде до ближайшего своего перезапуска:
перезапуск прерывает текущее задание, и решать, уместно ли это сейчас,
должен человек.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --with-worker) RESTART_WORKER=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$REMOTE" ]]; then
  echo "Не задан TENDERFIT_VPS — некуда отправлять." >&2
  usage >&2
  exit 2
fi

if [[ ! -f package.json ]]; then
  echo "Запускать из корня проекта: package.json рядом не найден." >&2
  exit 2
fi

ARCHIVE="$(mktemp -t tenderfit-app-XXXXXX.tar.gz)"
trap 'rm -f "$ARCHIVE"' EXIT

# Рабочие выгрузки исключены отдельной строкой каждая, а не общим шаблоном:
# это сотни мегабайт нормативных баз и документации закупок, которые лежат
# в дереве у разработчика и на сервере не нужны. Без них архив весит ~1 МБ,
# с ними — под сотню.
echo "→ Собираю архив"
tar -czf "$ARCHIVE" \
  --exclude=./node_modules \
  --exclude=./.next \
  --exclude=./.git \
  --exclude=./logs \
  --exclude=./tsconfig.tsbuildinfo \
  --exclude='./.env*' \
  --exclude=./.vercel \
  --exclude=./data \
  --exclude='./*.sst' \
  --exclude='./Письма МИНСТРОЙ' \
  --exclude='./Документация о закупке*' \
  .

# Проверка до отправки, а не после: уехавший на сервер ключ считается
# засвеченным, и отзыв занимал бы больше времени, чем эта строка.
LISTING="$(tar -tzf "$ARCHIVE")"
if grep -E '(^|/)\.env' <<<"$LISTING" >&2; then
  echo "В архив попал файл окружения — деплой прерван." >&2
  exit 1
fi
if ! grep -qx './package.json' <<<"$LISTING"; then
  echo "В архиве нет package.json — деплой прерван." >&2
  exit 1
fi

# Страховка от забытого исключения: архив приложения — это исходники, а не
# данные. Внезапные десятки мегабайт означают, что в него затянуло выгрузку.
SIZE_KB="$(du -k "$ARCHIVE" | cut -f1)"
if (( SIZE_KB > 20480 )); then
  echo "Архив весит ${SIZE_KB} КБ — это слишком много для исходников." >&2
  echo "Скорее всего, в него попала рабочая выгрузка. Проверьте список --exclude." >&2
  exit 1
fi

echo "→ $(du -h "$ARCHIVE" | cut -f1): копирую на $REMOTE"
scp -q ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$ARCHIVE" "$REMOTE:/tmp/tenderfit-app.tar.gz"

echo "→ Распаковываю, собираю и перезапускаю"
ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$REMOTE" \
  REMOTE_DIR="$REMOTE_DIR" \
  RESTART_WORKER="$RESTART_WORKER" \
  bash -s <<'REMOTE_SCRIPT'
set -euo pipefail

if [[ ! -d "$REMOTE_DIR" ]]; then
  echo "Папки $REMOTE_DIR нет. Создайте её:" >&2
  echo "  sudo install -d -o tenderfit -g tenderfit $REMOTE_DIR" >&2
  exit 1
fi

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then SUDO="sudo -n"; fi

# Зависимости ставит и сборку запускает пользователь службы: иначе файлы в
# node_modules и .next остаются за тем, кто деплоил, и приложение под
# tenderfit их не прочитает.
AS_APP="$SUDO"
if id tenderfit >/dev/null 2>&1; then
  AS_APP="$SUDO -u tenderfit"
  if [[ "$(id -u)" -eq 0 ]]; then AS_APP="sudo -u tenderfit"; fi
fi

tar -xzf /tmp/tenderfit-app.tar.gz -C "$REMOTE_DIR"
rm -f /tmp/tenderfit-app.tar.gz
cd "$REMOTE_DIR"
mkdir -p logs
if id tenderfit >/dev/null 2>&1; then
  $SUDO chown -R tenderfit:tenderfit "$REMOTE_DIR" 2>/dev/null || true
fi

# npm ci — воспроизводимая установка, и она предпочтительна. Но lock-файл
# проекта собран на Windows и не содержит линуксовых разрешений
# необязательных зависимостей (@emnapi и подобные), из-за чего ci отказывает
# с EUSAGE. Пока lock не пересобран под Linux, откатываемся на install —
# иначе деплой невозможен вовсе. Сообщение печатается громко: это не норма,
# а обход известной поломки.
echo "→ Зависимости"
if ! $AS_APP npm ci --no-audit --no-fund 2>/tmp/npm-ci.log; then
  echo "  npm ci отказал, причина ниже. Ставлю через npm install." >&2
  tail -3 /tmp/npm-ci.log >&2
  echo "  Чтобы вернуть воспроизводимую установку, пересоберите package-lock.json на Linux." >&2
  $AS_APP npm install --no-audit --no-fund
fi
rm -f /tmp/npm-ci.log

echo "→ Сборка"
$AS_APP env NODE_ENV=production npm run build

echo "→ Перезапуск приложения"
$SUDO systemctl restart tenderfit-app

# Проверка после перезапуска: молчаливо упавшая служба означает недоступный
# сайт, и узнать об этом от пользователя — худший вариант.
echo "→ Проверка"
OK=0
for _ in $(seq 1 20); do
  sleep 3
  CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/dashboard || true)"
  if [[ "$CODE" == "200" ]]; then OK=1; break; fi
done
if [[ "$OK" -ne 1 ]]; then
  echo "Приложение не ответило 200 после перезапуска." >&2
  echo "Журнал: journalctl -u tenderfit-app -n 40 --no-pager" >&2
  echo "Откат на Vercel:" >&2
  echo "  cp /etc/nginx/sites-available/tenderfit-proxy.vercel /etc/nginx/sites-available/tenderfit-proxy" >&2
  echo "  nginx -t && systemctl reload nginx" >&2
  exit 1
fi
echo "Приложение отвечает."

if [[ "$RESTART_WORKER" == "1" ]]; then
  echo "→ Перезапуск воркера"
  $SUDO systemctl restart tenderfit-worker
  sleep 5
  $SUDO systemctl is-active tenderfit-worker
else
  echo "Воркер не перезапускался: он уже работает на новом коде, но старый"
  echo "процесс держит прежнюю версию в памяти. Когда будет уместно:"
  echo "  sudo systemctl restart tenderfit-worker"
fi
REMOTE_SCRIPT

echo "Готово: https://tender-fit.ru"
