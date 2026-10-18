import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Загрузка файла для обхода вложений: в память — до порога, на диск — выше него.
 * Сеть подменена потоком из заданных кусков; каталог для файлов настоящий.
 */

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "utf-8"));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tenderfit-fetchfile-test-"));
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("fetchFile", () => {
  it("без spool файл остаётся в памяти, предел по умолчанию — 50 МБ", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(streamResponse([bytesOf("abc"), bytesOf("def")]));
    const { fetchFile } = await import("./fetch-tender-documents");

    const file = await fetchFile("https://zakupki.gov.ru/f?uid=1");

    expect(Buffer.from(file.bytes).toString()).toBe("abcdef");
    expect(file.path).toBeUndefined();
  });

  it("заявленный объём больше предела — тело не читается, tooLarge", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse([bytesOf("x")], { "content-length": String(60_000_000) }),
    );
    const { fetchFile } = await import("./fetch-tender-documents");

    const file = await fetchFile("https://zakupki.gov.ru/f?uid=1");

    expect(file.tooLarge).toBe(true);
    expect(file.contentLength).toBe(60_000_000);
    expect(file.bytes.byteLength).toBe(0);
  });

  it("с spool малый файл остаётся в памяти, большой — уходит на диск целиком и по кускам", async () => {
    const { fetchFile } = await import("./fetch-tender-documents");

    vi.mocked(fetch).mockResolvedValueOnce(streamResponse([bytesOf("мал")]));
    const small = await fetchFile("https://x/1", {
      maxBytes: 1_000,
      spool: { dir, name: "small", above: 100 },
    });
    expect(small.path).toBeUndefined();
    expect(Buffer.from(small.bytes).toString()).toBe("мал");

    const parts = ["часть-один;", "часть-два;", "часть-три;"].map(bytesOf);
    vi.mocked(fetch).mockResolvedValueOnce(streamResponse(parts));
    const big = await fetchFile("https://x/2", {
      maxBytes: 1_000,
      spool: { dir, name: "big", above: 20 },
    });
    expect(big.path).toBe(join(dir, "big"));
    expect(big.bytes.byteLength).toBe(0);
    expect(big.size).toBe(parts.reduce((sum, part) => sum + part.byteLength, 0));
    expect(await readFile(big.path!, "utf-8")).toBe("часть-один;часть-два;часть-три;");
  });

  it("above: 0 — файл на диске в любом случае, даже пустой", async () => {
    const { fetchFile } = await import("./fetch-tender-documents");
    vi.mocked(fetch).mockResolvedValueOnce(streamResponse([]));

    const file = await fetchFile("https://x/3", { maxBytes: 1_000, spool: { dir, name: "vol", above: 0 } });

    expect(file.path).toBe(join(dir, "vol"));
    expect(file.size).toBe(0);
    expect(existsSync(join(dir, "vol"))).toBe(true);
  });

  it("поток перерос предел на диске: tooLarge и недокачанный файл удалён", async () => {
    const { fetchFile } = await import("./fetch-tender-documents");
    vi.mocked(fetch).mockResolvedValueOnce(streamResponse([bytesOf("1234567890"), bytesOf("1234567890")]));

    const file = await fetchFile("https://x/4", { maxBytes: 15, spool: { dir, name: "cut", above: 0 } });

    expect(file.tooLarge).toBe(true);
    expect(file.path).toBeUndefined();
    expect(existsSync(join(dir, "cut"))).toBe(false);
  });

  it("предел задаётся вызывающим: 300 МБ для файла на диске", async () => {
    const { fetchFile } = await import("./fetch-tender-documents");
    vi.mocked(fetch).mockResolvedValueOnce(
      streamResponse([bytesOf("x")], { "content-length": String(250_000_000) }),
    );

    // 250 МБ меньше 300 МБ: в отказ не уходит (тело — одна заглушка, но предел пройден).
    const file = await fetchFile("https://x/5", {
      maxBytes: 300_000_000,
      spool: { dir, name: "f", above: 100_000_000 },
    });
    expect(file.tooLarge).not.toBe(true);
  });

  it("HTTP-ошибка — исключение, файл не создаётся", async () => {
    const { fetchFile } = await import("./fetch-tender-documents");
    vi.mocked(fetch).mockResolvedValueOnce(new Response("нет", { status: 404 }));

    await expect(
      fetchFile("https://x/6", { maxBytes: 100, spool: { dir, name: "e", above: 0 } }),
    ).rejects.toThrow(/HTTP 404/);
    expect(existsSync(join(dir, "e"))).toBe(false);
  });

  describe("блокировка ЕИС (HTTP 434/403/429)", () => {
    beforeEach(() => {
      // Затвор по умолчанию читает путь из окружения при каждом обращении.
      vi.stubEnv("EIS_GATE_FILE", join(dir, "eis-gate.json"));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("filestore ответил 434 — EisBlockedError, а следующий файл не стоит ни одного запроса", async () => {
      const { fetchFile } = await import("./fetch-tender-documents");
      vi.mocked(fetch).mockResolvedValue(new Response("", { status: 434 }));

      await expect(fetchFile("https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=A1")).rejects.toThrow(
        /ЕИС временно ограничила доступ к серверу \(HTTP 434\), повторим после \d\d:\d\d МСК/,
      );
      await expect(fetchFile("https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=A2")).rejects.toThrow(
        /ЕИС временно ограничила доступ/,
      );

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("429 — тоже блокировка, а адреса не ЕИС идут мимо затвора", async () => {
      const { fetchFile } = await import("./fetch-tender-documents");
      vi.mocked(fetch).mockResolvedValueOnce(new Response("", { status: 429 }));
      await expect(fetchFile("https://zakupki.gov.ru/a")).rejects.toThrow(/HTTP 429/);

      vi.mocked(fetch).mockResolvedValueOnce(streamResponse([bytesOf("ok")]));
      const other = await fetchFile("https://www.tektorg.ru/file/1");
      expect(Buffer.from(other.bytes).toString()).toBe("ok");
    });
  });
});
