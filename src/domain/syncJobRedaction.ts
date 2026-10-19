import type { SyncJobPayload, SyncJobRow } from "@/types/database";

/**
 * Документ в задании, отданном наружу: имя есть, содержимого нет.
 *
 * Отдельный тип, а не тот же с пустым текстом, потому что разницу должен
 * ловить компилятор. Код, которому нужен текст, не должен молча принять
 * вычищенное задание и посчитать, что документ пуст.
 */
export interface RedactedDocument {
  readonly name: string;
  /** Длина исходного текста в знаках: видно, сколько воркер прочитал. */
  readonly chars: number;
}

export interface RedactedSyncJobPayload extends Omit<SyncJobPayload, "documents"> {
  readonly documents?: readonly RedactedDocument[];
}

export type RedactedSyncJob = Omit<SyncJobRow, "payload"> & {
  readonly payload: RedactedSyncJobPayload | null;
};

/**
 * Убирает из задания тексты присланных документов перед отдачей наружу.
 *
 * Зачем. Расчёт сметы принимает файлы, разобранные в браузере: на сервер
 * уходит текст, и деться ему некуда — закупки, к которой его можно было бы
 * привязать, у такого расчёта нет, поэтому текст лежит в самом задании.
 * Журнал очереди (`GET /api/sync-jobs`) отдаёт задания целиком, и вместе с
 * ними наружу уходила бы вся документация закупки.
 *
 * Почему это не косметика. `POST /api/estimate` те же тексты намеренно не
 * возвращает — решение принято и записано там же. Журнал обходил его стороной,
 * хотя по составу доступа он шире: смету заказывает тот, кто прислал файлы, а
 * журнал открыт всей панели. Документация закупки часто идёт под NDA, и
 * «показали в журнале» — не то место, где такое условие нарушают.
 *
 * Что остаётся. Имя файла и длина текста: по ним видно, что воркер получил и
 * сколько прочитал, — без этого журнал перестаёт отвечать на вопрос, почему
 * расчёт вышел таким. Само содержимое для этого не нужно.
 */
export function redactSyncJob(source: SyncJobRow): RedactedSyncJob {
  /*
    Почта того, кто поставил задание, наружу не уходит: с 14.10.2026 в
    `requested_by` лежит адрес вошедшего (по нему админ-панель считает расход), а
    журнал очереди видит каждый вошедший — чужая почта в нём ни к чему. Метки
    источника («ui», «live-search», «press») остаются: в них секрета нет.
  */
  let job: SyncJobRow =
    typeof source.requested_by === "string" && source.requested_by.includes("@")
      ? { ...source, requested_by: null }
      : source;
  /*
    Результат расчёта сметы — личный: он принадлежит тому, кто его поставил (с 20.10.2026 ручки
    `/api/estimate*` отдают его только владельцу), а журнал очереди видит каждый вошедший. Без этого
    чужую смету и проверку сметы заказчика можно было прочесть в `recent[].report`. Счётчики отчёта
    (`tenders`, `note` и т. п.) остаются: журнал отвечает на вопрос «что делал воркер».
  */
  if (job.report !== null && job.report !== undefined && (job.report.estimate !== undefined || job.report.audit !== undefined)) {
    const { estimate: _estimate, audit: _audit, ...counters } = job.report;
    job = { ...job, report: counters };
  }
  const payload = job.payload;
  if (payload === null || payload === undefined) return { ...job, payload: null };

  // Тексты снимаются разбором, а не удалением из копии: так новое поле с
  // содержимым, добавленное в payload завтра, попадёт в `rest` и уедет наружу
  // — но это будет видно здесь, в одном месте, а не в ответе роута.
  const { documents, ...rest } = payload;
  if (documents === undefined) return { ...job, payload: rest };

  return {
    ...job,
    payload: {
      ...rest,
      documents: documents.map((document) => ({
        name: document.name,
        chars: document.text.length,
      })),
    },
  };
}

/** То же для списка заданий: журнал отдаётся только в таком виде. */
export function redactSyncJobs(jobs: readonly SyncJobRow[]): RedactedSyncJob[] {
  return jobs.map(redactSyncJob);
}
