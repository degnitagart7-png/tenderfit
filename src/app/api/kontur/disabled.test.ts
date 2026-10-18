import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { GET as cardGet, POST as cardPost } from "@/app/api/analysis/kontur-card/route";
import { POST as sync } from "@/app/api/kontur/sync/route";
import { GET as usage } from "@/app/api/kontur/usage/route";

/**
 * Контур.Закупки отключены: ни одна его ручка не должна обращаться к его API.
 *
 * Строка в журнале «Остаток лимита (бесплатно)» появилась именно так: экран
 * открывали, и ручка ходила к Контуру. Теперь ручки отвечают 410 до любого
 * обращения наружу.
 */

describe("ручки Контур.Закупок при выключенном Контуре", () => {
  it("ни одна не обращается в сеть и все отвечают 410", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const responses = await Promise.all([
      usage(new NextRequest("http://localhost/api/kontur/usage")),
      sync(
        new NextRequest("http://localhost/api/kontur/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords: ["юрист"] }),
        }),
      ),
      cardGet(new NextRequest("http://localhost/api/analysis/kontur-card?tenderId=1")),
      cardPost(
        new NextRequest("http://localhost/api/analysis/kontur-card", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenderId: "1" }),
        }),
      ),
    ]);

    expect(responses.map((r) => r.status)).toEqual([410, 410, 410, 410]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await responses[0]?.json()).error).toMatch(/отключены/i);
    vi.unstubAllGlobals();
  });
});
