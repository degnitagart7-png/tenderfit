import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { anchorOf, billSignature, type BillEditsRecord } from "@/domain/estimate/billEdits";
import { makeBillItem, makeBillSection } from "@/test/estimateFixtures";

const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
let enabled = true;
const repo = vi.hoisted(() => ({ getAppState: vi.fn(), setAppStateEntry: vi.fn() }));

vi.mock("@/services/authRuntime", () => ({
  SESSION_COOKIE: "tf_session",
  getAuthService: () => (enabled ? auth : null),
}));
vi.mock("@/repositories/userDataRepository", async () => {
  const actual = await vi.importActual<typeof import("@/repositories/userDataRepository")>("@/repositories/userDataRepository");
  return { ...actual, userDataRepository: repo };
});

import { GET, PUT } from "@/app/api/estimate/edits/route";
import { AppStateUnavailableError } from "@/repositories/userDataRepository";

/*
  Правки ведомости за закупкой и пользователем: ключ `bill-edits:<tenderId>` в данных аккаунта.
  Без входа — 401 (экран держит правки на устройстве); чужие данные не читаются и не пишутся.
*/

const item = makeBillItem({ id: "a-1", workName: "Демонтаж наружных стен", quantity: 120, quantityUnit: "м2" });
const RECORD: BillEditsRecord = {
  version: 1,
  tenderId: "0123",
  baseJobId: "job-1",
  billSignature: billSignature([makeBillSection("ВОР", [item])]),
  updatedAt: "2026-10-09T10:00:00.000Z",
  edits: [{ kind: "price", anchor: anchorOf(item), unitPrice: 1000 }],
};

let counter = 0;
function call(method: "GET" | "PUT", opts: { query?: string; body?: unknown; raw?: string } = {}): NextRequest {
  counter += 1;
  return new NextRequest(`http://localhost/api/estimate/edits${opts.query ?? ""}`, {
    method,
    headers: { "x-real-ip": `10.6.0.${String(counter)}`, cookie: "tf_session=tok" },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  enabled = true;
  auth.getUser.mockResolvedValue({ id: "u1", email: "ivan@firma.ru" });
});

describe("/api/estimate/edits", () => {
  it("без сессии — 401 и в данные аккаунта не ходят", async () => {
    auth.getUser.mockResolvedValue(null);
    expect((await GET(call("GET", { query: "?tenderId=0123" }))).status).toBe(401);
    expect((await PUT(call("PUT", { body: { tenderId: "0123", record: RECORD } }))).status).toBe(401);
    expect(repo.getAppState).not.toHaveBeenCalled();
    expect(repo.setAppStateEntry).not.toHaveBeenCalled();
  });

  it("вход не настроен — как гость: 401", async () => {
    enabled = false;
    expect((await GET(call("GET", { query: "?tenderId=0123" }))).status).toBe(401);
  });

  it("PUT пишет правки по ключу bill-edits:<tenderId> именно этого пользователя", async () => {
    const response = await PUT(call("PUT", { body: { tenderId: "0123", record: RECORD } }));

    expect(response.status).toBe(200);
    expect(repo.setAppStateEntry).toHaveBeenCalledWith("u1", "bill-edits:0123", RECORD);
  });

  it("GET отдаёт сохранённое и восстанавливает его таким, каким сохранили", async () => {
    repo.getAppState.mockResolvedValue({ "bill-edits:0123": RECORD, "bill-edits:999": { чужая: true }, onboardingDone: true });

    const body = (await (await GET(call("GET", { query: "?tenderId=0123" }))).json()) as { record: BillEditsRecord };

    expect(repo.getAppState).toHaveBeenCalledWith("u1");
    expect(body.record).toEqual(RECORD);
  });

  it("правок нет или запись в старом формате — record: null, не ошибка", async () => {
    repo.getAppState.mockResolvedValue({ "bill-edits:0123": { version: 0, что: "то" } });
    expect(await (await GET(call("GET", { query: "?tenderId=0123" }))).json()).toEqual({ record: null });

    repo.getAppState.mockResolvedValue(null);
    expect(await (await GET(call("GET", { query: "?tenderId=0123" }))).json()).toEqual({ record: null });
  });

  it("record: null или пустой список правок удаляют ключ", async () => {
    await PUT(call("PUT", { body: { tenderId: "0123", record: null } }));
    expect(repo.setAppStateEntry).toHaveBeenLastCalledWith("u1", "bill-edits:0123", null);

    await PUT(call("PUT", { body: { tenderId: "0123", record: { ...RECORD, edits: [] } } }));
    expect(repo.setAppStateEntry).toHaveBeenLastCalledWith("u1", "bill-edits:0123", null);
  });

  it("правки другой закупки, мусор и не JSON — 400; слишком большое тело — 413", async () => {
    expect((await PUT(call("PUT", { body: { tenderId: "999", record: RECORD } }))).status).toBe(400);
    expect((await PUT(call("PUT", { body: { tenderId: "0123", record: { ...RECORD, edits: [{ kind: "взрыв" }] } } }))).status).toBe(400);
    expect((await PUT(call("PUT", { raw: "не json" }))).status).toBe(400);
    expect((await PUT(call("PUT", { raw: "x".repeat(600_001) }))).status).toBe(413);
    expect((await GET(call("GET"))).status).toBe(400);
    expect(repo.setAppStateEntry).not.toHaveBeenCalled();
  });

  it("колонки app_state нет (миграция не применена) — 503: экран оставит правки на устройстве", async () => {
    repo.setAppStateEntry.mockRejectedValue(new AppStateUnavailableError());
    const response = await PUT(call("PUT", { body: { tenderId: "0123", record: RECORD } }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/на этом устройстве/);
  });
});
