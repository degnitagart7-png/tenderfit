import { describe, it, expect } from "vitest";
import { readEgressReply } from "./workerEgress";

describe("readEgressReply", () => {
  it("голый адрес текстом (ifconfig.me)", () => {
    expect(readEgressReply("176.97.134.221\n")).toEqual({
      ip: "176.97.134.221",
      country: null,
    });
  });

  it("ipinfo.io: адрес и страна", () => {
    expect(readEgressReply({ ip: "176.97.134.221", country: "RU", city: "Moscow" })).toEqual({
      ip: "176.97.134.221",
      country: "RU",
    });
  });

  it("ipapi.co: страна в другом поле и в нижнем регистре", () => {
    expect(readEgressReply({ ip: "2.26.131.126", country_code: "gb" })).toEqual({
      ip: "2.26.131.126",
      country: "GB",
    });
  });

  it("ip-api.com: поле query", () => {
    expect(readEgressReply({ query: "176.97.134.221", countryCode: "ru" })).toEqual({
      ip: "176.97.134.221",
      country: "RU",
    });
  });

  it("список адресов в origin: берётся первый", () => {
    expect(readEgressReply({ origin: "176.97.134.221, 8.8.8.8" })).toEqual({
      ip: "176.97.134.221",
      country: null,
    });
  });

  it("IPv6 распознаётся", () => {
    expect(readEgressReply({ ip: "2a00:1450::1" }).ip).toBe("2a00:1450::1");
  });

  it("мусор вместо адреса не выдаётся за адрес", () => {
    // Страница ошибки провайдера или HTML-заглушка не должны попадать в пульс:
    // партнёр увидел бы «выход из России (Access denied)».
    expect(readEgressReply({ ip: "Access denied" })).toEqual({ ip: null, country: null });
    expect(readEgressReply("<html>503</html>")).toEqual({ ip: null, country: null });
    expect(readEgressReply({ country: "United Kingdom" }).country).toBeNull();
  });

  it("нераспознанный ответ не роняет воркер", () => {
    for (const body of [null, undefined, 42, [], {}, NaN]) {
      expect(readEgressReply(body)).toEqual({ ip: null, country: null });
    }
  });
});
