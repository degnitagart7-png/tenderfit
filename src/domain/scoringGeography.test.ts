import { describe, expect, it } from "vitest";
import type { SearchProfile } from "@/domain/entities";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { mockTenderAnalysisProvider } from "@/adapters/tender-analysis/mockTenderAnalysisProvider";
import { withSearchRegions } from "@/domain/scoringGeography";
import { demoTenders } from "@/mocks/tenders";

const search = (regions: string[], enabled = true) =>
  ({ id: `sp-${regions.join("-")}`, name: "Поиск", regions, enabled }) as unknown as SearchProfile;

const company = (workRegions: string[]) => ({
  ...demoCompanyProfile,
  restrictions: { ...demoCompanyProfile.restrictions, workRegions },
});

describe("withSearchRegions", () => {
  it("дополняет географию компании регионами включённых профилей поиска", () => {
    const result = withSearchRegions(company(["Республика Бурятия"]), [
      search(["Иркутская область", "Забайкальский край"]),
    ]);
    expect(result.restrictions.workRegions).toEqual([
      "Республика Бурятия",
      "Иркутская область",
      "Забайкальский край",
    ]);
  });

  it("пустая география — «работаем везде» — регионами поиска не сужается", () => {
    const profile = company([]);
    expect(withSearchRegions(profile, [search(["Иркутская область"])])).toBe(profile);
  });

  it("выключенный профиль поиска и повторы того же субъекта не добавляются", () => {
    const profile = company(["Республика Бурятия"]);
    const result = withSearchRegions(profile, [
      search(["Иркутская область"], false),
      search(["Бурятия"]),
    ]);
    expect(result).toBe(profile);
  });

  it("закупка в регионе из «Что ищем» больше не получает блокер региона", async () => {
    const tender = { ...demoTenders[0]!, region: "Иркутская область" };
    const narrow = company(["Республика Бурятия"]);
    const before = await mockTenderAnalysisProvider.analyze(tender, narrow);
    expect(before.hardBlockers.some((b) => b.id.endsWith("-block-region"))).toBe(true);

    const after = await mockTenderAnalysisProvider.analyze(
      tender,
      withSearchRegions(narrow, [search(["Иркутская область"])]),
    );
    expect(after.hardBlockers.some((b) => b.id.endsWith("-block-region"))).toBe(false);
  });
});
