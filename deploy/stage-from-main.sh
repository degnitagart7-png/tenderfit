#!/usr/bin/env bash
#
# Чистая копия для выкладки — только из ветки main.
#
#   bash deploy/stage-from-main.sh /tmp/tenderfit-stage
#   (cd /tmp/tenderfit-stage && TENDERFIT_VPS=root@5.35.86.186 TENDERFIT_SSH_KEY=~/.ssh/id_ed25519 \
#     bash deploy/deploy-app.sh [--with-worker])
#
# Зачем. В рабочей папке параллельно идут несколько задач, и выкладка «всего, что отличается
# от сервера» однажды чуть не увезла на прод чужую недоделанную отмену анализа с миграцией
# (15.10.2026). main — это то, что выкачено; новая работа попадает в main слиянием ветки,
# а на сервер — только отсюда. Копия собирается `git archive`, без незакоммиченных файлов.
#
set -euo pipefail

STAGE="${1:?укажите папку для копии, например /tmp/tenderfit-stage}"
REPO="$(git rev-parse --show-toplevel)"

rm -rf "$STAGE"
mkdir -p "$STAGE"
git -C "$REPO" archive main | tar -x -C "$STAGE"

# Версия воркера — время изменения scripts/worker.ts (`workerVersion`), а git archive ставит
# время коммита: без touch новый воркер мог бы выглядеть старее MIN_WORKER_VERSION сметы.
touch "$STAGE/scripts/worker.ts"

ln -s "$REPO/node_modules" "$STAGE/node_modules"
trap 'rm -f "$STAGE/node_modules"' EXIT
(
  cd "$STAGE"
  npx tsc --noEmit -p .
  # 7 PDF-тестов падают на Node 21 (нет Promise.withResolvers) — известное, на сервере Node 22.
  npx vitest run || echo "Тесты упали — проверьте, только ли PDF (attachmentParser, pdfTextBoxes)."
)
echo "Копия из main ($(git -C "$REPO" rev-parse --short main)) готова: $STAGE"
