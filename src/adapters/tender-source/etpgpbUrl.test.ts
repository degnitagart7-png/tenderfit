import { describe, expect, it } from "vitest";
import {
  EtpgpbUrlNotAllowedError,
  assertEtpgpbUrlAllowed,
  etpgpbCardUrl,
  etpgpbChunkNumber,
  etpgpbUrlKind,
  isEtpgpbUrlAllowed,
  parseEtpgpbCardUrl,
} from "@/adapters/tender-source/etpgpbUrl";

/**
 * Охрана адресов: единственное, что отделяет адаптер от запрещённых `robots.txt` путей.
 * Тесты фиксируют каждое правило живого `robots.txt` (19.10.2026), а не «разумный» набор.
 */
describe("isEtpgpbUrlAllowed: разрешённые адреса", () => {
  it.each([
    ["индекс карты сайта", "https://etpgpb.ru/sitemap.xml", "sitemap-index"],
    ["список кусков процедур", "https://etpgpb.ru/sitemap/procedures.xml", "sitemap-procedures"],
    ["кусок карты процедур", "https://etpgpb.ru/sitemap/procedures/procedures60.xml", "sitemap-chunk"],
    ["кусок карты с одной цифрой", "https://etpgpb.ru/sitemap/procedures/procedures1.xml", "sitemap-chunk"],
    [
      "карточка вида etp",
      "https://etpgpb.ru/procedures/etp/1298399-postavka-rashodnogo-material-dlya-laboratorii/",
      "card",
    ],
    ["карточка вида price_request", "https://etpgpb.ru/procedures/price_request/1026139-motopompa-pozharnaya/", "card"],
    ["карточка вида etp_click", "https://etpgpb.ru/procedures/etp_click/2081479-postavka-igrushek/", "card"],
    ["карточка вида gaz", "https://etpgpb.ru/procedures/gaz/259022-postavka-mayoneza/", "card"],
    ["карточка вида commerce", "https://etpgpb.ru/procedures/commerce/8736-derevyannye-poddony/", "card"],
  ])("%s", (_name, url, kind) => {
    expect(isEtpgpbUrlAllowed(url)).toBe(true);
    expect(etpgpbUrlKind(url)).toBe(kind);
  });
});

describe("isEtpgpbUrlAllowed: запрещённые адреса", () => {
  it("отвергает любую query-строку: `Disallow: /*?`", () => {
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/1-a/?utm_source=x")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/sitemap.xml?x=1")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/sitemap/procedures/procedures1.xml?page=2")).toBe(false);
    // Пустая query-строка — тоже `?`: `robots.txt` запрещает и её, а разбор адреса её теряет.
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/1-a/?")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/sitemap.xml?")).toBe(false);
  });

  it("отвергает постраничные списки процедур: `Disallow: /procedures/page`", () => {
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/page/2/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/page")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/page2/10-x/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/page/10-x/")).toBe(false);
  });

  it("отвергает закрытые хосты: etp.gpb.ru и com.etpgpb.ru закрыты целиком", () => {
    expect(isEtpgpbUrlAllowed("https://etp.gpb.ru/file/get/t/LotDocuments/id/1/name/x")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etp.gpb.ru/sitemap.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://com.etpgpb.ru/api/public/gate/x")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://com.etpgpb.ru/procedures/etp/1-a/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://click.etpgpb.ru/tp3-public/QuoteRequest/x")).toBe(false);
  });

  it("отвергает внутренний API и прочие пути", () => {
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/api/v2/procedures/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/api/v2/procedures/?page[size]=50")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/uploads/file.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/etpgpb/x/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/partners")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/sitemap/lots.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/")).toBe(false);
  });

  it("отвергает карточку без слеша в конце, без slug и с нецифровым id", () => {
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/1298399-postavka")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/1298399/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/abc-postavka/")).toBe(false);
  });

  it("отвергает не-https, порт, логин, поддомен, чужой регистр хоста и фрагмент", () => {
    expect(isEtpgpbUrlAllowed("http://etpgpb.ru/sitemap.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru:8443/sitemap.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://user@etpgpb.ru/sitemap.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://www.etpgpb.ru/sitemap.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru.evil.example/sitemap.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://evil.example/etpgpb.ru/sitemap.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://ETPGPB.RU/sitemap.xml")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/sitemap.xml#x")).toBe(false);
  });

  it("отвергает процентное кодирование, обход пути и мусор", () => {
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/1-%2e%2e/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/../page/1-a/")).toBe(false);
    expect(isEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/1-закупка/")).toBe(false);
    expect(isEtpgpbUrlAllowed("")).toBe(false);
    expect(isEtpgpbUrlAllowed("not a url")).toBe(false);
    expect(isEtpgpbUrlAllowed("/procedures/etp/1-a/")).toBe(false);
    expect(isEtpgpbUrlAllowed("a".repeat(5000))).toBe(false);
  });
});

describe("assertEtpgpbUrlAllowed", () => {
  it("возвращает вид разрешённого адреса", () => {
    expect(assertEtpgpbUrlAllowed("https://etpgpb.ru/sitemap.xml")).toBe("sitemap-index");
  });

  it("бросает ошибку с адресом на запрещённом", () => {
    expect(() => assertEtpgpbUrlAllowed("https://etpgpb.ru/procedures/etp/1-a/?x=1")).toThrow(
      EtpgpbUrlNotAllowedError,
    );
    expect(() => assertEtpgpbUrlAllowed("https://etp.gpb.ru/file/get/x")).toThrow(/etp\.gpb\.ru/);
  });
});

describe("разбор адреса карточки", () => {
  const url = "https://etpgpb.ru/procedures/price_request/1026139-motopompa-pozharnaya-tanker-50pzh/";

  it("достаёт вид, номер, slug и путь", () => {
    expect(parseEtpgpbCardUrl(url)).toEqual({
      url,
      kind: "price_request",
      id: "1026139",
      slug: "motopompa-pozharnaya-tanker-50pzh",
      path: "/procedures/price_request/1026139-motopompa-pozharnaya-tanker-50pzh/",
    });
  });

  it("собирается обратно из частей", () => {
    expect(etpgpbCardUrl("price_request", "1026139", "motopompa-pozharnaya-tanker-50pzh")).toBe(url);
  });

  it("не разбирает ничего, кроме карточки", () => {
    expect(parseEtpgpbCardUrl("https://etpgpb.ru/sitemap.xml")).toBeNull();
    expect(parseEtpgpbCardUrl("https://etp.gpb.ru/procedures/etp/1-a/")).toBeNull();
  });

  it("номер куска карты", () => {
    expect(etpgpbChunkNumber("https://etpgpb.ru/sitemap/procedures/procedures60.xml")).toBe(60);
    expect(etpgpbChunkNumber("https://etpgpb.ru/sitemap/procedures.xml")).toBeNull();
  });
});
