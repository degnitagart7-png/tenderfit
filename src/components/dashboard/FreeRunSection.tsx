"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { freeSourceTitles } from "@/domain/sources";
import { DEFAULT_SYNC_INTERVAL_HOURS } from "@/domain/workerSchedule";
import { Button } from "@/components/ui/primitives";
import { joinRuList, pluralRu } from "@/utils/format";

/** Чем кончилось нажатие «Запустить прогон». */
export type FreeRunOutcome =
  | { kind: "queued" }
  | { kind: "deduped" }
  | { kind: "error"; message: string };

/**
 * Перечень площадок, которые опрашивает бесплатный прогон.
 *
 * Собирается из каталога источников, а не печатается строкой: перечень менялся
 * трижды за две недели, и подпись, написанная от руки, разошлась бы с
 * реальностью на первом же подключённом источнике. Партнёр увидел бы обещание,
 * которое прогон не выполняет.
 */
const FREE_SOURCES_TEXT = joinRuList(freeSourceTitles());

/**
 * Основной раздел панели: прогон бесплатных площадок.
 *
 * Нажатие не опрашивает источники из браузера — оно ставит задание в очередь
 * сервера с российским адресом, и только он может это выполнить: ЕИС и её
 * хранилище файлов зарубежным адресам не отвечают. Отсюда два следствия,
 * которые раздел обязан назвать до нажатия, а не после:
 *
 * - прогон идёт по условиям поиска, заведённым на сервере, а не по профилю в
 *   этом браузере (профили браузера живут в localStorage и до сервера не
 *   доходят);
 * - страница не ждёт завершения: прогон занимает десятки минут, поэтому ответ
 *   кнопки — «поставлено в очередь», а не «готово».
 *
 * Платного расхода здесь нет по построению: источник, который стоит денег, в
 * `freeSyncSources()` не попадает, и подпись не может пообещать его опрос.
 */
export function FreeRunSection({
  running,
  disabled,
  outcome,
  serverAnswers,
  onRun,
}: {
  /** Запрос на постановку ещё не вернулся. */
  running: boolean;
  /** Причина не нажать: идёт платный поиск. */
  disabled: boolean;
  outcome: FreeRunOutcome | null;
  /**
   * Отвечает ли сервер, которому адресовано задание.
   *
   * null — состояние не прочитано, и утверждать что-либо о сервере тогда нельзя:
   * «он не запущен» и «мы не смогли прочитать» чинятся по-разному.
   */
  serverAnswers: boolean | null;
  onRun: () => void;
}) {
  return (
    <div className="space-y-2.5 rounded-control border border-border bg-panel-raised px-4 py-3">
      <div className="space-y-1">
        <h3
          className="text-[14.5px] font-semibold text-foreground"
          title="Поиск идёт по условиям, заведённым на сервере, а не по профилю в этом браузере. Платный источник не тратится."
        >
          Поиск на площадках
        </h3>
        <p className="text-[13.5px] leading-relaxed text-muted-foreground">
          Проверим {FREE_SOURCES_TEXT}. Займёт десятки минут, лента обновится
          сама.{" "}
          <Link href="/admin/jobs" className="underline underline-offset-2">
            Ход работы
          </Link>
        </p>
      </div>

      {serverAnswers === false && (
        <p className="flex items-start gap-2 rounded-control border border-mustard/40 px-3 py-2 text-[13.5px] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-mustard-fg" aria-hidden />
          <span>
            Сервер в России сейчас не на связи: задание дождётся его в очереди.
          </span>
        </p>
      )}

      <div>
        <Button onClick={onRun} loading={running} disabled={disabled}>
          {running ? "Ставим в очередь…" : "Запустить поиск"}
        </Button>
      </div>

      {outcome && <FreeRunOutcomeNote outcome={outcome} />}
    </div>
  );
}

/**
 * Исход постановки — как есть.
 *
 * Повтор не называется успехом: «прогон поставлен в очередь» про задание,
 * которое уже выполняется, заставил бы партнёра ждать второй прогон. Отказ
 * очереди показывается с причиной и с тем, что происходит вместо неё, — иначе
 * он неотличим от «лента больше не пополняется», хотя расписание на сервере
 * продолжает работать.
 */
function FreeRunOutcomeNote({ outcome }: { outcome: FreeRunOutcome }) {
  if (outcome.kind === "queued") {
    return (
      <p className="text-[13.5px] text-muted-foreground">
        Поиск поставлен в очередь, начнётся в течение минуты.
      </p>
    );
  }
  if (outcome.kind === "deduped") {
    return (
      <p className="text-[13.5px] text-muted-foreground">
        Поиск уже в очереди — повторно не ставили.
      </p>
    );
  }
  return (
    <p className="text-[13.5px] text-brick-fg">
      Поиск не запущен: {outcome.message}. Лента пополняется и по
      расписанию — каждые {DEFAULT_SYNC_INTERVAL_HOURS}{" "}
      {pluralRu(DEFAULT_SYNC_INTERVAL_HOURS, ["час", "часа", "часов"])}.
    </p>
  );
}
