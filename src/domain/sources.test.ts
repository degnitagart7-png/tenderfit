import { describe, expect, it } from "vitest";
import {
  SOURCES,
  defaultSources,
  documentationSources,
  eisPublishedSources,
  freeSourceTitles,
  freeSyncSources,
  slowTrackSources,
  sourceFacts,
  syncableSources,
} from "./sources";
import type { TenderDataSource } from "@/types/database";

describe("каталог источников", () => {
  it("описывает каждое значение TenderDataSource ровно один раз", () => {
    const all: TenderDataSource[] = [
      "MOCK",
      "EIS",
      "IMPORT",
      "SBER_AST",
      "KONTUR",
      "TEK_TORG",
      "ROSELTORG",
      "FABRIKANT",
    ];
    const listed = SOURCES.map((s) => s.source);
    expect([...listed].sort()).toEqual([...all].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("приоритеты не повторяются: две площадки с равным весом молча перезаписали бы друг друга", () => {
    const priorities = SOURCES.map((s) => s.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it("ЕИС выше любой площадки: реестр остаётся авторитетом при совпадении номера", () => {
    const eis = sourceFacts("EIS").priority;
    for (const s of SOURCES) {
      if (s.source !== "EIS") expect(s.priority).toBeLessThan(eis);
    }
  });

  it("у источника без документов есть причина, у источника с документами её нет", () => {
    for (const s of SOURCES) {
      if (s.documents === "none") {
        expect(s.documentsReason, s.source).toBeTruthy();
      } else {
        expect(s.documentsReason, s.source).toBeNull();
      }
    }
  });

  it("платный источник не входит в прогон по умолчанию", () => {
    for (const s of SOURCES) {
      if (s.cost === "paid") expect(s.byDefault, s.source).toBe(false);
    }
  });

  it("коммерческие площадки опрашиваются по умолчанию", () => {
    // Коммерческие торги — главное отличие продукта. Пока площадки были «только
    // явно», плановый сбор их не видел: профили сервера и спрос посетителей
    // sources не перечисляют (журнал 05.10.2026: «не выбран ни одним профилем»).
    expect(defaultSources()).toEqual(
      expect.arrayContaining(["EIS", "TEK_TORG", "SBER_AST", "FABRIKANT", "ROSELTORG"]),
    );
  });

  it("документацию отдают ЕИС, ТЭК-Торг и Контур.Закупки", () => {
    expect(documentationSources()).toEqual(["EIS", "TEK_TORG", "KONTUR"]);
  });

  it("ТЭК-Торг отдаёт байты документов без ключа", () => {
    expect(sourceFacts("TEK_TORG").documents).toBe("bytes");
    expect(sourceFacts("TEK_TORG").documentsReason).toBeNull();
  });

  it("в ЕИС публикуются только ЕИС и Контур.Закупки", () => {
    // Агрегатор отдаёт тот же номер извещения, что публикует реестр, поэтому по
    // нему печатную форму ЕИС найти можно. Номер площадки («ЗП610102») в ЕИС не
    // ищется вовсе: запрос по нему вернул бы чужую закупку или ничего.
    expect(eisPublishedSources()).toEqual(["EIS", "KONTUR"]);
    expect(sourceFacts("TEK_TORG").publishedInEis).toBe(false);
    expect(sourceFacts("SBER_AST").publishedInEis).toBe(false);
  });

  it("источник с документацией, которой нет в ЕИС, существует: два факта не сливаются в один", () => {
    // Проверка на будущее: если площадка начнёт отдавать байты, но не будет
    // публиковаться в реестре, список «документация читаема» и список «номер
    // ищется в ЕИС» обязаны разойтись. Совпадение списков означало бы, что
    // загрузчик снова ищет байты по номеру, которого в реестре нет.
    const documented = new Set(documentationSources());
    const published = new Set(eisPublishedSources());
    expect([...documented].some((s) => !published.has(s))).toBe(true);
  });

  it("причина отказа Сбербанк-АСТ называет площадку и КЭП", () => {
    const reason = sourceFacts("SBER_AST").documentsReason ?? "";
    expect(reason).toMatch(/Сбербанк-АСТ/);
    expect(reason).toMatch(/КЭП/);
  });

  it("причина отказа ручного импорта говорит «вручную»", () => {
    expect(sourceFacts("IMPORT").documentsReason ?? "").toMatch(/вручную/);
  });

  it("Росэлторг бесплатный, опрашивается по умолчанию и документов не отдаёт", () => {
    const facts = sourceFacts("ROSELTORG");
    expect(facts.cost).toBe("free");
    expect(facts.byDefault).toBe(true);
    expect(facts.documents).toBe("none");
    expect(facts.publishedInEis).toBe(false);
    // Причина обязана называть хост и запрет: «документов нет» без объяснения
    // читается как наша недоработка, а не как правило площадки.
    expect(facts.documentsReason ?? "").toMatch(/com\.roseltorg\.ru/);
    expect(facts.documentsReason ?? "").toMatch(/робот/);
  });

  it("Росэлторг ниже агрегаторов: запись беднее, и вытеснять более полную нельзя", () => {
    // Исключение из порядка «площадка-первоисточник выше агрегатора». Секции
    // 223-ФЗ печатают номер извещения ЕИС, поэтому совпадение с чужой записью
    // вероятно, а `update` пишет null на место отсутствующих значений: без этого
    // правила прогон стёр бы ОКПД2, дату публикации и ссылку на карточку реестра.
    const roseltorg = sourceFacts("ROSELTORG").priority;
    expect(roseltorg).toBeLessThan(sourceFacts("KONTUR").priority);
    expect(roseltorg).toBeGreaterThan(sourceFacts("MOCK").priority);
  });

  it("Фабрикант бесплатный, опрашивается по умолчанию и документов не отдаёт", () => {
    const facts = sourceFacts("FABRIKANT");
    expect(facts.cost).toBe("free");
    expect(facts.byDefault).toBe(true);
    expect(facts.documents).toBe("none");
    expect(facts.publishedInEis).toBe(false);
    // Причина обязана называть хост и запрет: «документов нет» без объяснения
    // читается как наша недоработка, а не как правило площадки.
    expect(facts.documentsReason ?? "").toMatch(/storage\.fabrikant\.ru/);
    expect(facts.documentsReason ?? "").toMatch(/робот/);
  });

  it("Фабрикант выше ручного импорта, но ниже площадок, уже проверенных в бою", () => {
    // Номер извещения ЕИС публикуется на одной площадке, поэтому записи
    // Сбербанк-АСТ и Фабриканта не пересекаются и порядок между ними почти ни на
    // что не влияет. Влияет он на пересечение с ручным импортом: карточка
    // Фабриканта полнее загруженного файла (дата, ОКПД2, цена, организатор),
    // поэтому новая площадка перезаписывает IMPORT. Ниже Сбербанк-АСТ Фабрикант
    // стоит как источник, который ещё не отработал ни одного планового прогона.
    const fabrikant = sourceFacts("FABRIKANT").priority;
    expect(fabrikant).toBeGreaterThan(sourceFacts("IMPORT").priority);
    expect(fabrikant).toBeLessThan(sourceFacts("SBER_AST").priority);
    expect(fabrikant).toBeLessThan(sourceFacts("EIS").priority);
  });
});

describe("бесплатная часть прогона", () => {
  /*
    Кнопка «Найти новые закупки» обещает партнёру перечень источников, поэтому
    перечень обязан браться из каталога, а не печататься строкой в компоненте:
    за неделю набор площадок менялся трижды, и догонять его в подписях — значит
    держать в дереве текст, который устареет к следующему деплою.
  */
  it("содержит все бесплатные площадки и не содержит платный агрегатор", () => {
    const sources = freeSyncSources().map((s) => s.source);
    expect(sources).toContain("EIS");
    expect(sources).toContain("TEK_TORG");
    expect(sources).toContain("SBER_AST");
    expect(sources).toContain("ROSELTORG");
    expect(sources).toContain("FABRIKANT");
    expect(sources).not.toContain("KONTUR");
  });

  it("не содержит того, что прогон не опрашивает: демо-данных и ручной загрузки", () => {
    const sources = freeSyncSources().map((s) => s.source);
    expect(sources).not.toContain("MOCK");
    expect(sources).not.toContain("IMPORT");
  });

  it("это бесплатное подмножество опрашиваемых источников в порядке каталога", () => {
    const free = freeSyncSources().map((s) => s.source);
    expect(free).toEqual(
      syncableSources().filter((source) => sourceFacts(source).cost === "free"),
    );
  });

  it("подпись перечисляет источники каталожными названиями", () => {
    expect(freeSourceTitles()).toEqual([
      "ЕИС",
      "ТЭК-Торг",
      "Сбербанк-АСТ",
      "Фабрикант",
      "Росэлторг",
    ]);
  });

  /*
    Названия отдельной функцией, а не `.map(...)` в четырёх местах: строку
    «ЕИС, ТЭК-Торг, Сбербанк-АСТ, Фабрикант и Росэлторг» печатают экран входа,
    панель администратора, панель поиска и причина остановки платного источника.
    Четыре копии одного перечня разошлись бы при первом же подключённом
    источнике — ровно так уже случилось с подписями, написанными от руки.
  */
  it("названия берутся из тех же записей каталога, что и факты", () => {
    expect(freeSourceTitles()).toEqual(freeSyncSources().map((facts) => facts.title));
  });
});

/**
 * Два трека опроса: какие площадки быстрые, какие медленные.
 *
 * Медленными названы те, что тратят отдельный запрос карточки на каждую
 * процедуру: Росэлторг и Фабрикант. В прогоне 03.10.2026 они заняли 86 секунд
 * из 280. Остальные отдают выдачу одним-двумя запросами, а платный Контур
 * ограничен своим суточным бюджетом и имеет собственный интервал, поэтому в
 * медленный трек не входит: два разных правила на один источник — это
 * ошибка, а не страховка.
 */
describe("треки опроса", () => {
  it("у каждого источника каталога есть трек", () => {
    for (const source of SOURCES) {
      expect(["fast", "slow"]).toContain(source.track);
    }
  });

  it("медленные — только площадки с запросом карточки на каждую процедуру", () => {
    expect(slowTrackSources().sort()).toEqual(["FABRIKANT", "ROSELTORG"]);
  });

  it("платный Контур остаётся быстрым: его частоту держит собственный интервал", () => {
    expect(sourceFacts("KONTUR").track).toBe("fast");
  });

  it("медленные площадки входят в плановый прогон: трек меняет частоту, а не состав", () => {
    const syncable = syncableSources();
    for (const source of slowTrackSources()) expect(syncable).toContain(source);
  });
});
