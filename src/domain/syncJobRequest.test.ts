import { describe, it, expect } from "vitest";
import {
  MAX_REG_NUMBERS_PER_JOB,
  findReusableJob,
  parseSyncJobRequest,
  regNumbersKey,
} from "./syncJobRequest";
import type { SyncJobRow } from "@/types/database";

function job(overrides: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: "job-1",
    kind: "documents",
    status: "pending",
    payload: { regNumbers: ["1", "2"], reason: "press" },
    requested_by: null,
    attempts: 0,
    worker_id: null,
    claimed_at: null,
    finished_at: null,
    report: null,
    error: null,
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
    ...overrides,
  } as SyncJobRow;
}

function request(regNumbers: string[], kind: "documents" | "full_sync" = "documents") {
  const parsed = parseSyncJobRequest({ kind, regNumbers });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.request;
}

describe("parseSyncJobRequest", () => {
  it("по умолчанию ставит задание на документацию", () => {
    const parsed = parseSyncJobRequest({ regNumbers: ["32616407955"] });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.kind).toBe("documents");
    expect(parsed.request.reason).toBe("manual");
    expect(parsed.request.requestedBy).toBeNull();
  });

  it("полный прогон допускается без номеров", () => {
    const parsed = parseSyncJobRequest({ kind: "full_sync" });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.kind).toBe("full_sync");
    expect(parsed.request.regNumbers).toEqual([]);
  });

  it("задание на документацию без номеров отклоняется", () => {
    expect(parseSyncJobRequest({ kind: "documents", regNumbers: [] })).toEqual({
      ok: false,
      error: "Не указано ни одного номера закупки",
    });
    expect(parseSyncJobRequest({}).ok).toBe(false);
  });

  it("номера обрезаются по краям, пустые и повторные отбрасываются", () => {
    const parsed = parseSyncJobRequest({
      regNumbers: [" 32616407955 ", "32616407955", "", "0336300038526000037"],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.regNumbers).toEqual(["32616407955", "0336300038526000037"]);
  });

  it("не строка в списке номеров — ошибка с внятной причиной", () => {
    expect(parseSyncJobRequest({ regNumbers: [32616407955] })).toEqual({
      ok: false,
      error: "Номер закупки — строка, а не число или объект",
    });
    expect(parseSyncJobRequest({ regNumbers: "32616407955" })).toEqual({
      ok: false,
      error: "Номера закупок ожидаются списком",
    });
  });

  it("неизвестный вид задания отклоняется со списком допустимых", () => {
    const parsed = parseSyncJobRequest({ kind: "deep_analysis", regNumbers: ["1"] });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Неизвестный вид задания: deep_analysis");
    expect(parsed.error).toContain("documents");
    expect(parsed.error).toContain("full_sync");
  });

  it("потолок номеров в одном задании защищает очередь от часового прогона", () => {
    const over = Array.from({ length: MAX_REG_NUMBERS_PER_JOB + 1 }, (_, i) => `n${i}`);
    const atLimit = over.slice(0, MAX_REG_NUMBERS_PER_JOB);

    expect(parseSyncJobRequest({ regNumbers: atLimit }).ok).toBe(true);
    const parsed = parseSyncJobRequest({ regNumbers: over });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain(String(MAX_REG_NUMBERS_PER_JOB + 1));
  });

  it("не объект в теле и кто поставил задание", () => {
    expect(parseSyncJobRequest("documents")).toEqual({
      ok: false,
      error: "Ожидался JSON-объект с параметрами задания",
    });

    const parsed = parseSyncJobRequest({
      regNumbers: ["1"],
      reason: "  press  ",
      requestedBy: "  Строительная компания  ",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.reason).toBe("press");
    expect(parsed.request.requestedBy).toBe("Строительная компания");
  });
});

describe("findReusableJob", () => {
  it("порядок номеров не важен: повторное нажатие не плодит задания", () => {
    const active = [job({ payload: { regNumbers: ["2", "1"], reason: "press" } })];

    expect(findReusableJob(active, request(["1", "2"]))?.id).toBe("job-1");
  });

  it("частичное пересечение — другое задание", () => {
    const active = [job({ payload: { regNumbers: ["1", "2"], reason: "press" } })];

    expect(findReusableJob(active, request(["1", "2", "3"]))).toBeNull();
  });

  it("выполненное задание не переиспользуется", () => {
    const done = [job({ status: "completed", payload: { regNumbers: ["1", "2"] } })];

    expect(findReusableJob(done, request(["1", "2"]))).toBeNull();
  });

  it("задание в работе переиспользуется: второй такой же запрос не нужен", () => {
    const processing = [job({ status: "processing", payload: { regNumbers: ["1", "2"] } })];

    expect(findReusableJob(processing, request(["1", "2"]))?.status).toBe("processing");
  });

  it("полный прогон не совмещается с загрузкой документации", () => {
    const active = [job({ kind: "full_sync", payload: {} })];

    expect(findReusableJob(active, request(["1", "2"]))).toBeNull();
  });

  it("второй плановый прогон подряд не ставится: он уже в очереди", () => {
    // Прогон занимает сервер десятки минут и тратит суточный бюджет
    // Контур.Закупок, поэтому повторное нажатие обязано вернуть прежнее задание.
    const active = [job({ id: "sync-1", kind: "full_sync", payload: {} })];

    expect(findReusableJob(active, request([], "full_sync"))?.id).toBe("sync-1");
  });

  it("завершённый плановый прогон не мешает поставить новый", () => {
    const done = [job({ kind: "full_sync", status: "completed", payload: {} })];

    expect(findReusableJob(done, request([], "full_sync"))).toBeNull();
  });

  it("ключ сравнения устойчив к пробелам", () => {
    expect(regNumbersKey([" b ", "a"])).toBe(regNumbersKey(["a", "b"]));
  });
});

describe("платная карточка Контур.Закупок в задании", () => {
  /** Задание на документацию одной закупки с платной карточкой источника. */
  function paidRequest(regNumbers: string[]) {
    const parsed = parseSyncJobRequest({
      kind: "documents",
      regNumbers,
      reason: "kontur-card",
      konturCards: true,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.request;
  }

  it("флаг доходит до запроса: без него воркер не купил бы карточку", () => {
    expect(paidRequest(["RH24092600035"]).konturCards).toBe(true);
  });

  it("по умолчанию задание бесплатное", () => {
    expect(request(["RH24092600035"]).konturCards).toBe(false);
  });

  it("плановый прогон не может стать платным: карточки — только явное задание", () => {
    // Прогон идёт по десяткам закупок: флаг в нём означал бы десятки платных
    // карточек за раз и молча истраченный суточный бюджет группы `purchase`.
    expect(parseSyncJobRequest({ kind: "full_sync", konturCards: true })).toEqual({
      ok: false,
      error: "Платные карточки Контур.Закупок доступны только в задании на документацию",
    });
  });

  it("не логическое значение флага отклоняется", () => {
    expect(parseSyncJobRequest({ regNumbers: ["1"], konturCards: "yes" }).ok).toBe(false);
  });

  it("платное задание не переиспользует бесплатное с теми же номерами", () => {
    // Обратное означало бы, что карточку никто не купит: очередь вернула бы
    // прежнее задание, и воркер выполнил бы его без платного флага.
    const active = [job({ payload: { regNumbers: ["RH24092600035"], reason: "press" } })];

    expect(findReusableJob(active, paidRequest(["RH24092600035"]))).toBeNull();
  });

  it("бесплатное задание не переиспользует платное: деньги второй раз не тратятся", () => {
    const active = [
      job({
        payload: { regNumbers: ["RH24092600035"], reason: "kontur-card", konturCards: true },
      }),
    ];

    expect(findReusableJob(active, request(["RH24092600035"]))).toBeNull();
  });

  it("повторное платное нажатие возвращает прежнее платное задание", () => {
    const active = [
      job({ id: "paid-1", payload: { regNumbers: ["RH24092600035"], konturCards: true } }),
    ];

    expect(findReusableJob(active, paidRequest(["RH24092600035"]))?.id).toBe("paid-1");
  });
});
