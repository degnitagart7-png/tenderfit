// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JSZip from "jszip";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireAccess = vi.fn();
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: (...args: unknown[]) => requireAccess(...args) }));

// Настоящий разбор, но с видимыми вызовами: проверяем, как маршрут его зовёт.
vi.mock("@/services/attachmentParser", async () => {
  const actual = await vi.importActual<typeof import("@/services/attachmentParser")>("@/services/attachmentParser");
  return { ...actual, parseAttachmentFile: vi.fn(actual.parseAttachmentFile) };
});

import { POST } from "@/app/api/documents/parse/route";
import { MAX_UPLOAD_BYTES } from "@/domain/documentUpload";
import { parseAttachmentFile } from "@/services/attachmentParser";

/*
  Серверный разбор загрузки с экрана «Смета»: вход обязателен, размер ограничен,
  .doc и архивы читает серверный разбор, а сканы (OCR выключен) попадают в список
  пропущенных с причиной. Временные файлы убираются при любом исходе.
*/

let counter = 0;
let tmp = "";

function upload(file: File | null, headers: Record<string, string> = {}): NextRequest {
  counter += 1;
  const form = new FormData();
  if (file) form.append("file", file);
  // Свой адрес на каждый вызов: лимит запросов не должен зависеть от порядка тестов.
  return new NextRequest("http://localhost/api/documents/parse", {
    method: "POST",
    body: form,
    headers: { "x-real-ip": `10.9.0.${String(counter)}`, ...headers },
  });
}

async function tempLeftovers(): Promise<string[]> {
  return (await readdir(tmp)).filter((name) => name.startsWith("tenderfit-upload-"));
}

beforeEach(async () => {
  requireAccess.mockReset();
  requireAccess.mockResolvedValue(null);
  vi.mocked(parseAttachmentFile).mockClear();
  tmp = await mkdtemp(join(tmpdir(), "parse-route-"));
  vi.stubEnv("TENDERFIT_TMPDIR", tmp);
  // На машине разработки 7z может быть, а может не быть: тесты не должны от этого зависеть.
  vi.stubEnv("TENDERFIT_ARCHIVE_CLI", "off");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

describe("POST /api/documents/parse", () => {
  it("без входа — отказ из requireAccess, файл не разбирается", async () => {
    requireAccess.mockResolvedValue(NextResponse.json({ error: "Войдите, чтобы продолжить" }, { status: 401 }));

    const res = await POST(upload(new File(["x".repeat(100)], "a.txt")));

    expect(res.status).toBe(401);
    expect(parseAttachmentFile).not.toHaveBeenCalled();
  });

  it("zip: тексты файлов склеены, прочитано N из M, скан пропущен с причиной (OCR выключен)", async () => {
    const zip = new JSZip();
    zip.file("ведомость.txt", "Ведомость объёмов работ: земляные работы, 120 м3, бетонирование, 14 м3.");
    zip.file("скан.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const res = await POST(upload(new File([bytes], "документация.zip", { type: "application/zip" })));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      text: string;
      reason: string | null;
      archive: { parsed: number; total: number; skipped?: { name: string; reason: string }[] };
    };
    expect(body.status).toBe("parsed");
    expect(body.text).toContain("Ведомость объёмов работ");
    expect(body.reason).toBeNull();
    expect(body.archive).toMatchObject({ parsed: 1, total: 2 });
    expect(body.archive.skipped?.map((item) => item.name)).toEqual(["скан.png"]);
    expect(body.archive.skipped?.[0]?.reason).toBeTruthy();

    // OCR выключен явно, расширение передано как есть.
    const call = vi.mocked(parseAttachmentFile).mock.calls[0]!;
    expect(call[1]).toBe("документация.zip");
    expect(call[4]).toEqual({ ocr: null });
    expect(await tempLeftovers()).toEqual([]);
  });

  it(".doc идёт в серверный разбор под своим именем, а не в mammoth: битый .doc — статус и причина, не 500", async () => {
    const res = await POST(upload(new File([new Uint8Array(2048).fill(7)], "ТЗ.doc")));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; text: string; reason: string | null; archive: unknown };
    expect(body.status).not.toBe("parsed");
    expect(body.text).toBe("");
    expect(body.reason).toBeTruthy();
    expect(body.archive).toBeNull();
    expect(vi.mocked(parseAttachmentFile).mock.calls[0]![1]).toBe("ТЗ.doc");
    expect(await tempLeftovers()).toEqual([]);
  });

  it("путь в имени файла отбрасывается", async () => {
    await POST(upload(new File(["Текст документа, достаточно длинный для разбора и проверки имени."], "C:\\Users\\x\\..\\смета.txt")));

    expect(vi.mocked(parseAttachmentFile).mock.calls[0]![1]).toBe("смета.txt");
  });

  it("файл больше предела — 413 и разбор не запускается", async () => {
    const res = await POST(upload(new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "большой.zip")));

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain("50 МБ");
    expect(parseAttachmentFile).not.toHaveBeenCalled();
  });

  it("огромный Content-Length отсекается до чтения тела", async () => {
    const formData = vi.fn();
    const fake = {
      headers: new Headers({ "content-length": String(MAX_UPLOAD_BYTES * 3), "x-real-ip": "10.9.9.9" }),
      formData,
    } as unknown as NextRequest;

    const res = await POST(fake);

    expect(res.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
  });

  it("нет поля file или файл пуст — 400", async () => {
    expect((await POST(upload(null))).status).toBe(400);
    expect((await POST(upload(new File([], "пусто.zip")))).status).toBe(400);
    expect(parseAttachmentFile).not.toHaveBeenCalled();
  });

  it("тело не multipart — 400", async () => {
    counter += 1;
    const res = await POST(
      new NextRequest("http://localhost/api/documents/parse", {
        method: "POST",
        body: "просто текст",
        headers: { "x-real-ip": `10.9.1.${String(counter)}` },
      }),
    );

    expect(res.status).toBe(400);
  });

  it("слишком частые обращения с одного адреса — 429 с Retry-After", async () => {
    let last = 200;
    for (let index = 0; index < 31; index += 1) {
      const res = await POST(upload(null, { "x-real-ip": "10.77.0.1" }));
      last = res.status;
      if (res.status === 429) {
        expect(res.headers.get("Retry-After")).toBeTruthy();
        break;
      }
    }
    expect(last).toBe(429);
  });

  it("сбой разбора — 500 без содержимого файла, каталог убран", async () => {
    vi.mocked(parseAttachmentFile).mockRejectedValueOnce(new Error("внезапный сбой"));

    const res = await POST(upload(new File(["секретное содержимое документа"], "a.zip")));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("секретное");
    expect(await tempLeftovers()).toEqual([]);
  });
});
