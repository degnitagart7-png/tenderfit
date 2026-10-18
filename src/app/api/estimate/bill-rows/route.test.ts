import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBillRows = vi.fn();
vi.mock("@/services/billOfWorkExtraction", () => ({ fetchBillRows: (...args: unknown[]) => fetchBillRows(...args) }));

process.env["TENDERFIT_WORKER_SECRET"] = "test-worker-secret-0123456789abcdef";
const { POST } = await import("./route");

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/estimate/bill-rows", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-worker-secret": "test-worker-secret-0123456789abcdef" },
  });
}

describe("POST /api/estimate/bill-rows: только воркер", () => {
  it("без секрета воркера — 403, модель не зовётся", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/estimate/bill-rows", {
        method: "POST",
        body: JSON.stringify({ chunk: "текст", regNumber: "1", subject: "s", documentName: "d" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(403);
    expect(fetchBillRows).not.toHaveBeenCalled();
  });
});

describe("POST /api/estimate/bill-rows", () => {
  beforeEach(() => {
    fetchBillRows.mockReset();
    fetchBillRows.mockResolvedValue({ rows: [], hasBill: false, tokens: 0, malformed: 0, truncated: false });
  });

  it("длинный предмет закупки и имя файла обрезаются, а не роняют расчёт (0302300048726001118, 517 знаков)", async () => {
    const subject = "Выполнение работ ".repeat(40);
    const documentName = `${"Описание объекта закупки.rar.zip/".repeat(12)}смета.xlsx`;
    const res = await POST(request({ chunk: "текст", regNumber: "0302300048726001118", subject, documentName }));
    expect(res.status).toBe(200);
    const call = fetchBillRows.mock.calls[0]![0] as { context: { subject: string }; documentName: string };
    expect(call.context.subject.length).toBeLessThanOrEqual(1000);
    expect(call.documentName.length).toBeLessThanOrEqual(500);
  });

  it("без текста фрагмента — 400 с названием поля", async () => {
    const res = await POST(request({ chunk: "", regNumber: "1", subject: "s", documentName: "d" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("chunk");
  });

  it("сбой модели — 502 с текстом причины (воркер повторит и пропустит фрагмент, а не уронит расчёт)", async () => {
    fetchBillRows.mockRejectedValue(new Error("Шлюз модели ответил 500"));
    const res = await POST(request({ chunk: "текст", regNumber: "32616409061", subject: "s", documentName: "d" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("Шлюз модели ответил 500");
  });
});
