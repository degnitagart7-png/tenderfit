// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { MAX_UPLOAD_BYTES } from "@/domain/documentUpload";
import { isUnreadableText, parseDocument, UNSUPPORTED_FORMAT_TEXT } from "@/services/documentParser";
import { isArchiveName, needsServerParse, parseDocumentSmart } from "@/services/serverDocumentParse";

/*
  Куда уходит файл с экрана «Смета»: старый .doc и архивы читает сервер, остальное —
  браузер. И главное: что бы ни ответил сервер, нечитаемый файл возвращается
  текстом-объяснением, который `isUnreadableText` узнаёт, — иначе расчёт сметы
  получил бы объяснение вместо содержимого.
*/

function reply(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("needsServerParse", () => {
  it.each(["ТЗ.doc", "Документация.ZIP", "проект.rar", "проект.7z", "архив.v2.zip"])("%s — на сервер", (name) => {
    expect(needsServerParse(name)).toBe(true);
  });

  it.each(["смета.docx", "ведомость.xlsx", "акт.pdf", "заметки.txt", "без_расширения", "docx"])("%s — в браузере", (name) => {
    expect(needsServerParse(name)).toBe(false);
  });

  it("архивом считаются zip, rar и 7z, но не doc", () => {
    expect(isArchiveName("a.zip")).toBe(true);
    expect(isArchiveName("a.7z")).toBe(true);
    expect(isArchiveName("a.doc")).toBe(false);
  });
});

describe("parseDocument: .doc больше не уходит в mammoth", () => {
  it("в браузере .doc — «неподдерживаемый формат», а не ошибка чтения zip", async () => {
    const parsed = await parseDocument(new File([new Uint8Array(64)], "ТЗ.doc"));

    expect(parsed.text).toBe(UNSUPPORTED_FORMAT_TEXT);
    expect(isUnreadableText(parsed.text)).toBe(true);
  });
});

describe("parseDocumentSmart", () => {
  it("архив уходит на сервер как multipart и возвращается с отчётом", async () => {
    const fetchImpl = reply(200, {
      status: "parsed",
      text: "=== a.txt ===\nВедомость объёмов работ",
      reason: null,
      archive: { parsed: 1, total: 2, skipped: [{ name: "скан.png", reason: "скан" }] },
      truncated: false,
    });

    const parsed = await parseDocumentSmart(new File(["zip"], "док.zip"), fetchImpl);

    expect(isUnreadableText(parsed.text)).toBe(false);
    expect(parsed.text).toContain("Ведомость");
    expect(parsed.archive).toEqual({ parsed: 1, total: 2, skipped: [{ name: "скан.png", reason: "скан" }] });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("/api/documents/parse");
    expect(init?.method).toBe("POST");
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("серверный статус не «parsed» — нечитаемый текст с причиной, отчёт сохранён", async () => {
    const parsed = await parseDocumentSmart(
      new File(["zip"], "сканы.zip"),
      reply(200, {
        status: "empty",
        text: "",
        reason: "В архиве 3 файла, ни один не удалось прочитать.",
        archive: { parsed: 0, total: 3, skipped: [{ name: "1.png", reason: "скан" }] },
        truncated: false,
      }),
    );

    expect(isUnreadableText(parsed.text)).toBe(true);
    expect(parsed.text).toContain("ни один не удалось прочитать");
    expect(parsed.archive?.skipped).toHaveLength(1);
  });

  it("«parsed», но текст пуст — тоже нечитаемый", async () => {
    const parsed = await parseDocumentSmart(
      new File(["x"], "ТЗ.doc"),
      reply(200, { status: "parsed", text: "  ", reason: null, archive: null, truncated: false }),
    );

    expect(isUnreadableText(parsed.text)).toBe(true);
  });

  it.each([
    [401, { error: "Войдите, чтобы продолжить" }, "Войдите"],
    [413, { error: "Файл больше 50 МБ" }, "50 МБ"],
    [500, { error: "Не удалось разобрать файл на сервере." }, "Не удалось разобрать"],
  ])("ответ %i — нечитаемый результат с сообщением сервера", async (status, body, fragment) => {
    const parsed = await parseDocumentSmart(new File(["x"], "а.zip"), reply(status, body));

    expect(isUnreadableText(parsed.text)).toBe(true);
    expect(parsed.text).toContain(fragment);
  });

  it("ответ не JSON (страница ошибки прокси) — причина по коду", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;

    const parsed = await parseDocumentSmart(new File(["x"], "а.zip"), fetchImpl);

    expect(isUnreadableText(parsed.text)).toBe(true);
    expect(parsed.text).toContain("502");
  });

  it("сеть недоступна — нечитаемый результат, а не исключение", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const parsed = await parseDocumentSmart(new File(["x"], "а.7z"), fetchImpl);

    expect(isUnreadableText(parsed.text)).toBe(true);
  });

  it("файл больше предела не отправляется", async () => {
    const fetchImpl = reply(200, {});
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "огромный.rar");

    const parsed = await parseDocumentSmart(big, fetchImpl);

    expect(isUnreadableText(parsed.text)).toBe(true);
    expect(parsed.text).toContain("50 МБ");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("обычный файл читается в браузере, сервер не зовётся", async () => {
    const fetchImpl = reply(200, {});

    const parsed = await parseDocumentSmart(new File(["Ведомость объёмов работ"], "в.txt"), fetchImpl);

    expect(parsed.text).toBe("Ведомость объёмов работ");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
