import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Доступ проверяет requireAccess (его правила — в access.routes.test.ts); здесь ручка ведёт себя как для вошедшего.
vi.mock("@/app/api/auth/requireAccess", () => ({ requireAccess: vi.fn(async () => null) }));

import { NextRequest } from "next/server";

import { GET as getZones } from "@/app/api/estimate/zones/route";

const GET = () => getZones(new NextRequest("http://localhost/api/estimate/zones"));

/*
  Список собранных зон для экрана. Приложение работает на том же сервере, где
  лежит data/fsnb, но без индекса (разработка, деплой без данных) ответ — пустые
  списки, а не 500: экран просто не предлагает выбор зоны.
*/

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zones-route-"));
  vi.stubEnv("FSNB_INDEX_DIR", dir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("GET /api/estimate/zones", () => {
  it("каталога индекса нет — пустые списки, статус 200", async () => {
    vi.stubEnv("FSNB_INDEX_DIR", join(dir, "нет-такого"));
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ zones: [], allZones: [], directory: [] });
  });

  it("индекс есть, зон нет — пустой список собранных, справочник на месте", async () => {
    await writeFile(
      join(dir, "zones.jsonl"),
      `${JSON.stringify({ subjectCode: "3", subjectName: "Республика Бурятия", zoneName: "Республика Бурятия (5 зона)", center: "г. Улан-Удэ", municipalities: "р-н. Кабанский" })}\n`,
    );
    const body = (await (await GET()).json()) as { zones: unknown[]; allZones: Record<string, string>[] };

    expect(body.zones).toEqual([]);
    expect(body.allZones).toEqual([
      { name: "Республика Бурятия (5 зона)", subjectCode: "3", subjectName: "Республика Бурятия", center: "г. Улан-Удэ", municipalities: "р-н. Кабанский" },
    ]);
  });

  it("собранные зоны отдаются с названием, субъектом и периодом", async () => {
    await mkdir(join(dir, "zones", "236"), { recursive: true });
    await writeFile(
      join(dir, "zones", "236", "zone.json"),
      JSON.stringify({ priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)", subject: "Республика Бурятия", period: "3 квартал 2026 г.", periodId: 427 }),
    );
    const body = (await (await GET()).json()) as { zones: unknown[] };

    expect(body.zones).toEqual([
      { priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)", subject: "Республика Бурятия", period: "3 квартал 2026 г." },
    ]);
  });

  it("справочник ФГИС ЦС на диске — номера всех зон, и не собранных тоже", async () => {
    await writeFile(
      join(dir, "zones-directory.json"),
      JSON.stringify({
        zones: [
          { value: 193, text: "Республика Бурятия" },
          { value: 232, text: "Республика Бурятия (1 зона)" },
          { value: 236, text: "Республика Бурятия (5 зона)" },
        ],
      }),
    );
    const body = (await (await GET()).json()) as { directory: unknown[] };

    // Запись самого субъекта не зона: цены публикуются по зонам.
    expect(body.directory).toEqual([
      { priceZoneId: 232, zoneName: "Республика Бурятия (1 зона)" },
      { priceZoneId: 236, zoneName: "Республика Бурятия (5 зона)" },
    ]);
  });

  it("повреждённый справочник зон — 500 с причиной, а не молчаливая пустота", async () => {
    await writeFile(join(dir, "zones.jsonl"), "{не json\n");
    const response = await GET();

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain("zones.jsonl");
  });
});
