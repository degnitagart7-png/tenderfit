import { describe, expect, it } from "vitest";

import { SERVICE_OWNER, canReadEstimateJob, ownerKey, type EstimateViewer } from "@/domain/estimate/jobOwnership";

const anna: EstimateViewer = { email: "anna@firma.ru", admin: false };
const admin: EstimateViewer = { email: "owner@tender-fit.ru", admin: true };
const service: EstimateViewer = { email: null, admin: false };

describe("ownerKey: по какому requested_by отбираются «мои» расчёты", () => {
  it("вошедший — его почта; служебный запрос — метка «ui», которой пишутся его задания", () => {
    expect(ownerKey(anna)).toBe("anna@firma.ru");
    expect(ownerKey(service)).toBe(SERVICE_OWNER);
    expect(SERVICE_OWNER).toBe("ui");
  });

  it("администратор в списках тоже со своей почтой", () => {
    expect(ownerKey(admin)).toBe("owner@tender-fit.ru");
  });
});

describe("canReadEstimateJob", () => {
  it("свой расчёт открывается, регистр и пробелы в базе не мешают", () => {
    expect(canReadEstimateJob(anna, "anna@firma.ru")).toBe(true);
    expect(canReadEstimateJob(anna, "  Anna@Firma.RU ")).toBe(true);
  });

  it("чужой, служебный («ui»), без владельца — нет", () => {
    expect(canReadEstimateJob(anna, "boris@firma.ru")).toBe(false);
    expect(canReadEstimateJob(anna, "ui")).toBe(false);
    expect(canReadEstimateJob(anna, null)).toBe(false);
    expect(canReadEstimateJob(anna, undefined)).toBe(false);
    expect(canReadEstimateJob(anna, "")).toBe(false);
  });

  it("почта-подстрока не считается своей", () => {
    expect(canReadEstimateJob(anna, "xanna@firma.ru")).toBe(false);
    expect(canReadEstimateJob(anna, "anna@firma.ru.evil.test")).toBe(false);
  });

  it("администратор и служебный запрос открывают любое по номеру", () => {
    for (const owner of ["anna@firma.ru", "ui", null]) {
      expect(canReadEstimateJob(admin, owner)).toBe(true);
      expect(canReadEstimateJob(service, owner)).toBe(true);
    }
  });
});
