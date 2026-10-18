#!/usr/bin/env bash
# Отправка кода воркера на сервер в России.
#
# Скрипт запускается с рабочей машины из корня проекта:
#   TENDERFIT_VPS=root@95.167.245.92 deploy/deploy-worker.sh [--restart]
#
# Пользователь в адресе — тот, кто может войти по ssh и писать в /opt и
# /etc/tenderfit: root или пользователь с `sudo -n`. Служебный tenderfit не
# годится — он создаётся с оболочкой nologin и по ssh не входит.
#
# Ключи он не трогает: они лежат на сервере в /etc/tenderfit/worker.env и в
# архив не попадают (см. deploy/worker.env.example).
#
# Кроме кода скрипт привозит корневой сертификат Минцифры: ЕИС отдаёт
# сертификат, подписанный Russian Trusted Root CA, которого нет в наборе
# Mozilla, и без него любой запрос к zakupki.gov.ru падает на проверке
# цепочки. Обойти это отключением проверки нельзя — вместо этого сертификат
# ставится в системное хранилище и подключается к Node через
# NODE_EXTRA_CA_CERTS.

set -euo pipefail

REMOTE="${TENDERFIT_VPS:-}"
REMOTE_DIR="${TENDERFIT_REMOTE_DIR:-/opt/tenderfit-ai}"
SSH_KEY="${TENDERFIT_SSH_KEY:-}"
RESTART=0
WITH_BASE=0

# Отдельный файл ключа нужен потому, что ключ сервера не обязан быть ключом по
# умолчанию: на рабочей машине их несколько, и угадывать, каким подключаться,
# скрипт не должен.
SSH_OPTS=()
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
fi

# Keepalive: установка зависимостей идёт молча по минуте и дольше, а
# молчаливое соединение рвётся первым. 03.10.2026 так оборвался деплой
# приложения (deploy-app.sh) — «Connection reset by peer» во время npm ci:
# дерево кода обновилось, а сборка и перезапуск не выполнились.
# ServerAliveInterval шлёт пакеты в паузах и держит сессию живой.
SSH_OPTS+=(-o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o ConnectTimeout=20)

# Отпечаток корневого сертификата, который скрипт согласен поставить.
# Сверяется на сервере после распаковки: если файл в дереве кто-то подменил,
# деплой останавливается, а не добавляет в доверие чужой корень.
ROOT_CA_SHA256="D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31"
ROOT_CA_SRC="deploy/certs/russian_trusted_root_ca.pem"
ROOT_CA_DEST="/etc/tenderfit/russian_trusted_root_ca.pem"

usage() {
  cat <<'USAGE'
deploy/deploy-worker.sh — копия дерева проекта на сервер в России.

  TENDERFIT_VPS=root@95.167.245.92 deploy/deploy-worker.sh [--restart]

Переменные:
  TENDERFIT_VPS         ssh-адрес сервера (обязательно)
  TENDERFIT_REMOTE_DIR  куда распаковывать, по умолчанию /opt/tenderfit-ai
  TENDERFIT_SSH_KEY     файл закрытого ключа, если он не ключ по умолчанию

Требования к серверу: Node 20 или новее и npm 10 или новее (lock-файл версии 3).

Что делает: собирает архив без node_modules, .next, logs и любых .env*,
копирует его по ssh, распаковывает поверх кода и ставит зависимости полным
npm ci. Полный, а не --omit=dev: воркер запускается tsx, а tsx лежит
в devDependencies. Затем кладёт в /etc/tenderfit корневой сертификат
Минцифры, сверив его отпечаток, и добавляет в системное хранилище.

--restart — перезапустить tenderfit-worker. Без флага скрипт только печатает
команду: перезапуск прерывает текущее задание, и решать, сейчас ли это уместно,
должен человек, а не деплой.

--with-base — взять с собой базу сметных нормативов data/fsnb (396 МБ). Без
флага она не едет: база меняется раз в квартал, а код — каждый день, и гонять
по ssh четыреста мегабайт ради правки в одном файле незачем. Первый деплой,
деплой после пересборки индекса и деплой на чистый сервер делают с флагом.
Расчёт сметы без базы на сервере не работает — воркер скажет об этом в журнале.

Папка REMOTE_DIR должна существовать; после распаковки скрипт передаёт её
пользователю tenderfit, от которого работает служба:
  sudo install -d -o tenderfit -g tenderfit /opt/tenderfit-ai
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    --with-base) WITH_BASE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$REMOTE" ]]; then
  echo "Не задан адрес сервера: TENDERFIT_VPS=root@<адрес> deploy/deploy-worker.sh" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# Версия npm на сервере проверяется до архива: lock-файл собран npm 11, а в
# apt Ubuntu лежит npm 9 — с ним `npm ci` падает на «Missing: @emnapi/… from
# lock file», и без этой проверки ошибка выглядела бы как рассинхрон lock-файла
# в проекте, которого нет.
REMOTE_NPM="$(ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$REMOTE" 'npm -v 2>/dev/null || echo 0')"
REMOTE_NPM_MAJOR="${REMOTE_NPM%%.*}"
if [[ "${REMOTE_NPM_MAJOR:-0}" -lt 10 ]]; then
  echo "На сервере npm $REMOTE_NPM, а нужен 10 или новее (lock-файл версии 3 собран npm 11)." >&2
  echo "Обновите: ssh $REMOTE 'npm install -g npm@11'" >&2
  exit 1
fi
echo "→ Сервер: npm $REMOTE_NPM"

WORK_DIR="$(mktemp -d)"
ARCHIVE="$WORK_DIR/tenderfit-worker.tar.gz"
trap 'rm -rf "$WORK_DIR"' EXIT

# База сметных нормативов и папка приказов в обычный деплой не едут: вместе они
# весят под полгигабайта, меняются раз в квартал и к правкам кода отношения не
# имеют. Первый раз базу везут с --with-base.
BASE_EXCLUDE=()
if [[ "$WITH_BASE" -eq 0 ]]; then
  BASE_EXCLUDE+=(--exclude=./data/fsnb)
fi

if [[ "$WITH_BASE" -eq 1 ]]; then
  echo "→ Собираю архив кода вместе с базой нормативов data/fsnb (это надолго)"
else
  echo "→ Собираю архив кода (без node_modules, .next, logs, .env* и data/fsnb)"
fi
# macOS кладёт в архив служебные файлы `._имя` с расширенными атрибутами
# (пометка «скачано из интернета» и подобные). На сервере это мусор: 05.10.2026
# три деплоя с Mac оставили 649 таких файлов, и тесты спотыкались о них как о
# повреждённые исходники. COPYFILE_DISABLE выключает их у bsdtar, исключение —
# страховка для других сборок tar.
export COPYFILE_DISABLE=1
tar -czf "$ARCHIVE" \
  --exclude='._*' \
  ${BASE_EXCLUDE[@]+"${BASE_EXCLUDE[@]}"} \
  --exclude=./node_modules \
  --exclude=./.next \
  --exclude=./.git \
  --exclude=./logs \
  --exclude=./tsconfig.tsbuildinfo \
  --exclude='./.env*' \
  --exclude=./.vercel \
  --exclude='./Письма МИНСТРОЙ' \
  --exclude='./Документация о закупке*' \
  .

# Проверка до отправки, а не после: уехавший на сервер ключ считается
# засвеченным, и отзыв занимал бы больше времени, чем эта строка.
#
# Оглавление читаем один раз в переменную. Конвейер `tar -tzf | grep -q`
# здесь не годится: grep находит строку и выходит, tar получает SIGPIPE, а
# pipefail превращает это в ошибку — и проверка рапортовала бы об отсутствии
# файла, который в архиве есть.
LISTING="$(tar -tzf "$ARCHIVE")"
if grep -E '(^|/)\.env' <<<"$LISTING" >&2; then
  echo "В архив попал файл окружения — деплой прерван." >&2
  exit 1
fi
if ! grep -qx './scripts/worker.ts' <<<"$LISTING"; then
  echo "В архиве нет scripts/worker.ts — деплой прерван." >&2
  exit 1
fi
# Сертификат проверяем до отправки: на сервере его уже нельзя отличить от
# подделанного, кроме как по отпечатку, а отпечаток сверяется там же.
if ! grep -qx "./$ROOT_CA_SRC" <<<"$LISTING"; then
  echo "В архиве нет $ROOT_CA_SRC — деплой прерван." >&2
  echo "Без корневого сертификата Минцифры сервер не сможет открыть zakupki.gov.ru." >&2
  exit 1
fi

# Страховка от забытого исключения, как в deploy-app.sh. Порог зависит от
# флага: код воркера — это единицы мегабайт, а с базой нормативов архив
# законно весит больше сотни.
SIZE_KB="$(du -k "$ARCHIVE" | cut -f1)"
if [[ "$WITH_BASE" -eq 0 ]] && (( SIZE_KB > 30720 )); then
  echo "Архив весит ${SIZE_KB} КБ без базы нормативов — это слишком много для кода." >&2
  echo "Скорее всего, в него затянуло рабочую выгрузку. Проверьте список --exclude." >&2
  exit 1
fi

echo "→ $(du -h "$ARCHIVE" | cut -f1): копирую на $REMOTE"
scp -q ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$ARCHIVE" "$REMOTE:/tmp/tenderfit-worker.tar.gz"

echo "→ Распаковываю в $REMOTE_DIR, ставлю зависимости и корневой сертификат"
ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$REMOTE" \
  REMOTE_DIR="$REMOTE_DIR" \
  ROOT_CA_DEST="$ROOT_CA_DEST" \
  ROOT_CA_SRC="$ROOT_CA_SRC" \
  ROOT_CA_SHA256="$ROOT_CA_SHA256" \
  bash -s <<'REMOTE_SCRIPT'
set -euo pipefail
if [[ ! -d "$REMOTE_DIR" ]]; then
  echo "Папки $REMOTE_DIR нет. Создайте её:" >&2
  echo "  sudo install -d -o tenderfit -g tenderfit $REMOTE_DIR" >&2
  exit 1
fi
tar -xzf /tmp/tenderfit-worker.tar.gz -C "$REMOTE_DIR"
rm -f /tmp/tenderfit-worker.tar.gz
cd "$REMOTE_DIR"
mkdir -p logs
npm ci --no-audit --no-fund
# Распаковка идёт от имени того, кто деплоит, а служба работает от tenderfit:
# без смены владельца файл лога и замок в logs/ оказались бы недоступны.
if id tenderfit >/dev/null 2>&1; then
  chown -R tenderfit:tenderfit "$REMOTE_DIR" 2>/dev/null || true
fi
# Версия кода в пульсе — это момент изменения scripts/worker.ts, поэтому
# печатаем его же: то, что видно здесь, должно совпасть с плиткой
# «Код на сервере» на /admin/jobs после перезапуска.
echo "Код обновлён: scripts/worker.ts от $(date -r scripts/worker.ts '+%Y-%m-%d %H:%M' 2>/dev/null || echo '—')"

# База сметных нормативов: без неё воркер выполнит всё, кроме расчёта сметы, и
# узнать об этом иначе можно только из упавшего задания.
if [[ -f "data/fsnb/index/build-info.json" ]]; then
  echo "База нормативов на месте: $(du -sh data/fsnb/index 2>/dev/null | cut -f1)"
else
  echo "ВНИМАНИЕ: базы нормативов в $REMOTE_DIR/data/fsnb/index нет."
  echo "  Расчёт сметы работать не будет. Привезите её: deploy/deploy-worker.sh --with-base"
fi

# ---- корневой сертификат Минцифры ----
if ! command -v openssl >/dev/null 2>&1; then
  echo "На сервере нет openssl: отпечаток сертификата не сверить, деплой прерван." >&2
  exit 1
fi
ACTUAL="$(openssl x509 -in "$ROOT_CA_SRC" -noout -fingerprint -sha256 | sed 's/.*Fingerprint=//')"
if [[ "$ACTUAL" != "$ROOT_CA_SHA256" ]]; then
  echo "Отпечаток сертификата не совпал — деплой прерван." >&2
  echo "  ожидался: $ROOT_CA_SHA256" >&2
  echo "  получен:  $ACTUAL" >&2
  exit 1
fi
echo "Сертификат сверен: Russian Trusted Root CA, $ACTUAL"

SYS_CA="/usr/local/share/ca-certificates/russian_trusted_root_ca.crt"
if [[ -f "$ROOT_CA_DEST" && -f "$SYS_CA" ]]; then
  echo "Сертификат уже установлен: $ROOT_CA_DEST"
else
  # Под root sudo не нужен; под обычным пользователем -n не даст скрипту
  # зависнуть в ожидании пароля, который никто не введёт.
  SUDO=""
  if [[ "$(id -u)" -ne 0 ]]; then SUDO="sudo -n"; fi
  $SUDO install -d -m 750 -o root -g tenderfit "$(dirname "$ROOT_CA_DEST")"
  $SUDO install -m 644 -o root -g tenderfit "$ROOT_CA_SRC" "$ROOT_CA_DEST"
  $SUDO install -m 644 -o root -g root "$ROOT_CA_SRC" "$SYS_CA"
  $SUDO update-ca-certificates >/dev/null
  echo "Сертификат установлен: $ROOT_CA_DEST"
fi
REMOTE_SCRIPT

if [[ "$RESTART" -eq 1 ]]; then
  echo "→ Перезапускаю tenderfit-worker"
  # sudo -n: если пароль всё-таки нужен, скрипт скажет об этом, а не зависнет
  # в ожидании ввода, который никто не увидит.
  if ! ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$REMOTE" "sudo -n systemctl restart tenderfit-worker"; then
    echo "Перезапустить не удалось (нужен пароль sudo). Выполните на сервере:" >&2
    echo "  sudo systemctl restart tenderfit-worker" >&2
    exit 1
  fi
else
  echo
  echo "Код на сервере обновлён, служба не перезапускалась. Чтобы воркер подхватил"
  echo "новые файлы, выполните на сервере:"
  echo "  sudo systemctl restart tenderfit-worker"
fi

cat <<'CHECKS'

Проверка после деплоя:
  ssh <адрес> "systemctl --no-pager -l status tenderfit-worker"
  ssh <адрес> "journalctl -u tenderfit-worker -n 50 --no-pager"
  нажмите «Обновить» на /admin/jobs: подпись состояния и плитка «Код на сервере»
  должны смениться в течение минуты.
CHECKS
