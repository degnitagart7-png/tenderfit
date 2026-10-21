import { describe, expect, it } from "vitest";

import {
  ANTI_DUMPING_NMC_THRESHOLD,
  ANTI_DUMPING_REDUCTION_PERCENT,
  antiDumpingNote,
  isAntiDumpingReduction,
} from "@/domain/estimate/antiDumping";

describe("antiDumpingNote: порог снижения", () => {
  it("24,99 % — ещё не мера, 25 % — мера (порог включительно)", () => {
    expect(antiDumpingNote({ law: "FZ_44", nmc: 10_000_000, reductionPercent: 24.99 })).toBeNull();
    expect(antiDumpingNote({ law: "FZ_44", nmc: 10_000_000, reductionPercent: 25 })).not.toBeNull();
    expect(antiDumpingNote({ law: "FZ_44", nmc: 10_000_000, reductionPercent: 40 })).not.toBeNull();
    expect(isAntiDumpingReduction(ANTI_DUMPING_REDUCTION_PERCENT)).toBe(true);
  });

  it("снижения нет или цена выше НМЦК — меры нет", () => {
    expect(antiDumpingNote({ law: "FZ_44", nmc: 1, reductionPercent: null })).toBeNull();
    expect(antiDumpingNote({ law: "FZ_44", nmc: 1, reductionPercent: 0 })).toBeNull();
    expect(antiDumpingNote({ law: "FZ_44", nmc: 1, reductionPercent: -5 })).toBeNull();
  });
});

describe("antiDumpingNote: закон и 15 млн", () => {
  it("223-ФЗ: статья 37 не применяется", () => {
    expect(antiDumpingNote({ law: "FZ_223", nmc: 10_000_000, reductionPercent: 50 })).toBeNull();
  });

  it("закон не известен — правило условное: «если закупка по 44-ФЗ»", () => {
    const note = antiDumpingNote({ law: undefined, nmc: 10_000_000, reductionPercent: 30 });
    expect(note?.conditional).toBe(true);
    expect(note?.law).toBeNull();
    expect(note?.text.startsWith("Если закупка по 44-ФЗ")).toBe(true);
  });

  it("44-ФЗ известен — правило безусловное, обеспечение ×1,5", () => {
    const note = antiDumpingNote({ law: "FZ_44", nmc: 10_000_000, reductionPercent: 30 });
    expect(note?.conditional).toBe(false);
    expect(note?.securityMultiplier).toBe(1.5);
    expect(note?.text).toContain("1,5 раза");
  });

  it("НМЦК до 15 млн включительно: можно подтвердить добросовестность; выше — нельзя", () => {
    const low = antiDumpingNote({ law: "FZ_44", nmc: ANTI_DUMPING_NMC_THRESHOLD, reductionPercent: 30 });
    expect(low?.goodFaithAlternative).toBe(true);
    expect(low?.text).toContain("не выше 15 млн");
    const high = antiDumpingNote({ law: "FZ_44", nmc: ANTI_DUMPING_NMC_THRESHOLD + 1, reductionPercent: 30 });
    expect(high?.goodFaithAlternative).toBe(false);
    expect(high?.text).toContain("повышенное обеспечение обязательно");
  });

  it("НМЦК не известна — альтернатива названа условно, значение null", () => {
    const note = antiDumpingNote({ law: "FZ_44", nmc: null, reductionPercent: 30 });
    expect(note?.goodFaithAlternative).toBeNull();
    expect(note?.text).toContain("при НМЦК до 15 млн");
  });

  it("в каждом тексте есть просьба сверить с актуальной редакцией", () => {
    expect(antiDumpingNote({ law: "FZ_44", nmc: 1, reductionPercent: 30 })?.text).toContain("актуальной редакцией");
  });
});
