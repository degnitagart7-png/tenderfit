import { describe, expect, it } from "vitest";

import { RegisterArgsError, parseRegisterArgs, planRegistration, webhookUrl } from "./tochka-webhook-register.lib";

const URL_OK = "https://tender-fit.ru/api/payments/tochka/webhook";
const ALL = ["incomingPayment", "incomingSbpPayment", "incomingSbpB2BPayment"];

describe("tochka-webhook-register: аргументы", () => {
  it("по умолчанию — регистрация; --dry-run, --url, --list, --help", () => {
    expect(parseRegisterArgs([])).toEqual({ kind: "register", dryRun: false, url: null });
    expect(parseRegisterArgs(["--dry-run"])).toEqual({ kind: "register", dryRun: true, url: null });
    expect(parseRegisterArgs(["--url", "https://x.ru/h"])).toEqual({ kind: "register", dryRun: false, url: "https://x.ru/h" });
    expect(parseRegisterArgs(["--list"])).toEqual({ kind: "list" });
    expect(parseRegisterArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("--test-send: все события или названные", () => {
    expect(parseRegisterArgs(["--test-send"])).toEqual({ kind: "test-send", events: ALL });
    expect(parseRegisterArgs(["--test-send", "incomingSbpPayment"])).toEqual({ kind: "test-send", events: ["incomingSbpPayment"] });
  });

  it("неизвестное и недостающее отклоняются", () => {
    expect(() => parseRegisterArgs(["--wat"])).toThrow(RegisterArgsError);
    expect(() => parseRegisterArgs(["--url"])).toThrow(/требует адрес/);
    expect(() => parseRegisterArgs(["incomingPayment"])).toThrow(RegisterArgsError);
  });
});

describe("tochka-webhook-register: адрес и решение", () => {
  it("адрес собирается из APP_BASE_URL; банк принимает только https и порт 443", () => {
    expect(webhookUrl("https://tender-fit.ru/", null)).toBe(URL_OK);
    expect(() => webhookUrl("http://tender-fit.ru", null)).toThrow(/HTTPS/);
    expect(() => webhookUrl("https://tender-fit.ru:8443", null)).toThrow(/порт 443/);
    expect(() => webhookUrl("мусор", null)).toThrow(/Некорректный адрес/);
    expect(webhookUrl("https://tender-fit.ru", "https://stage.tender-fit.ru/hook")).toBe("https://stage.tender-fit.ru/hook");
  });

  it("нет вебхука — создать; другой адрес или набор событий — изменить; то же самое — ничего", () => {
    expect(planRegistration(null, URL_OK)).toBe("create");
    expect(planRegistration({ url: "https://old.ru/h", webhooksList: ALL }, URL_OK)).toBe("edit");
    expect(planRegistration({ url: URL_OK, webhooksList: ["incomingPayment"] }, URL_OK)).toBe("edit");
    expect(planRegistration({ url: URL_OK, webhooksList: [...ALL].reverse() }, URL_OK)).toBe("keep");
  });
});
