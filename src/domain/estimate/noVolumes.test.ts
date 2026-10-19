import { describe, expect, it } from "vitest";

import {
  NO_VOLUME_SOURCE_KIND,
  noVolumesGap,
  noVolumesMessage,
  noVolumesNotice,
  noVolumesNoticeFor,
} from "@/domain/estimate/noVolumes";
import type { EstimateGap } from "@/domain/estimate/types";

/*
  Документы закупки без объёмов: сообщение должно называть, что просмотрено, и
  что делать, — и не врать, когда часть текста модель просто не прочитала.
*/

describe("noVolumesNotice", () => {
  it("говорит, чего нет в документах, и что загрузить на странице «Смета»", () => {
    const notice = noVolumesNotice({ documentCount: 5, documentsWithoutBill: ["ТЗ.docx"] });

    expect(notice.found).toContain("нет ведомости объёмов, сметы заказчика и таблиц с количествами");
    expect(notice.found).toContain("чертежи без спецификаций и ТЗ без объёмов объёмов не дают");
    expect(notice.found).toContain("Просмотрено 5 документов.");
    expect(notice.found).toContain("«ТЗ.docx»");
    expect(notice.action).toContain("ВОР, дефектную ведомость или смету заказчика");
    expect(notice.action).toContain("Гранд-Сметы или Smeta.RU");
    expect(notice.action).toContain("странице «Смета»");
  });

  it("предупреждает, что родные файлы .gsfx и .xml не читаются", () => {
    const { action } = noVolumesNotice({ documentsWithoutBill: [] });

    expect(action).toContain(".gsfx");
    expect(action).toContain(".xml");
    expect(action).toContain("выгрузите их в Excel или PDF");
  });

  it("склоняет число документов и сокращает длинные списки", () => {
    expect(noVolumesNotice({ documentCount: 1, documentsWithoutBill: [] }).found).toContain("Просмотрено 1 документ.");
    expect(noVolumesNotice({ documentCount: 3, documentsWithoutBill: [] }).found).toContain("3 документа");
    expect(noVolumesNotice({ documentCount: 12, documentsWithoutBill: [] }).found).toContain("12 документов");

    const many = noVolumesNotice({
      documentsWithoutBill: ["а", "б", "в", "г", "д", "е"],
      skippedNoVolumes: [{ name: "Проект контракта.docx" }],
    });
    expect(many.found).toContain("и ещё 2");
    expect(many.found).toContain("Как не содержащие объёмов не читались: «Проект контракта.docx».");
  });

  it("при непрочитанных фрагментах не утверждает, что объёмов в документах нет", () => {
    const notice = noVolumesNotice({ documentCount: 4, documentsWithoutBill: [], unreadChunks: 2 });

    expect(notice.found).toContain("не смогла прочитать 2 фрагментов");
    expect(notice.found).not.toContain("нет ведомости объёмов");
    expect(notice.action).toContain("повтор");
    expect(notice.action).toContain(".gsfx");
  });
});

describe("noVolumesGap", () => {
  it("кладёт весь текст в пробел документа", () => {
    const gap = noVolumesGap({ documentCount: 2, documentsWithoutBill: [] });

    expect(gap.kind).toBe(NO_VOLUME_SOURCE_KIND);
    expect(gap.code).toBeNull();
    expect(gap.message).toBe(noVolumesMessage({ documentCount: 2, documentsWithoutBill: [] }));
    expect(gap.message).toContain("странице «Смета»");
  });
});

describe("noVolumesNoticeFor", () => {
  const empty = (over: Partial<Parameters<typeof noVolumesNoticeFor>[0]> = {}) => ({
    document: { gaps: [] as EstimateGap[] },
    billItems: 0,
    volumeSource: null,
    documentsWithoutBill: ["ТЗ.docx"],
    ...over,
  });

  it("у пустой сметы без пробела (расчёт до этой версии) собирает текст из результата", () => {
    const notice = noVolumesNoticeFor(empty());

    expect(notice?.found).toContain("«ТЗ.docx»");
    expect(notice?.action).toContain("странице «Смета»");
  });

  it("берёт текст из пробела документа, когда он есть: там известно и число документов", () => {
    const gap = noVolumesGap({ documentCount: 7, documentsWithoutBill: ["ТЗ.docx"] });
    const notice = noVolumesNoticeFor(empty({ document: { gaps: [gap] } }));

    expect(notice?.found).toContain("Просмотрено 7 документов.");
    expect(notice?.action).toContain("странице «Смета»");
    expect(notice?.found).not.toContain("странице «Смета»");
  });

  it("плашки нет, когда есть позиции или источник объёмов", () => {
    expect(noVolumesNoticeFor(empty({ billItems: 3 }))).toBeNull();
    expect(
      noVolumesNoticeFor(empty({ volumeSource: { level: "BILL" } })),
    ).toBeNull();
  });

  it("считает сбои чтения по пробелам документа", () => {
    const unread: EstimateGap = { kind: "BILL_CHUNK_UNREAD", message: "фрагмент 1", code: null, baseType: null };
    const notice = noVolumesNoticeFor(empty({ document: { gaps: [unread] } }));

    expect(notice?.found).toContain("не смогла прочитать 1 фрагмент");
  });
});
