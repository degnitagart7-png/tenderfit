import {
  describeBuiltZones,
  northOfZone,
  resolvePriceZone,
  type PriceZoneBasis,
  type PriceZoneRecord,
} from "@/domain/estimate/priceZoneResolve";
import { sameZone, subjectOfZoneName } from "@/domain/estimate/customerPriceLevel";
import type { NorthBasis } from "@/domain/estimate/north";
import { zoneNumberIn } from "@/domain/estimate/priceLevel";
import { isSameRegion } from "@/domain/regionCodes";
import { normalizeRegionText } from "@/domain/regions";
import type { NorthZone } from "@/domain/estimate/overheadNormatives";

/**
 * Выбор ценовой зоны для расчёта сметы: что решает воркер до вызова модели.
 *
 * Правило продукта: молча считать в чужих ценах нельзя. Зона берётся у
 * пользователя (если он выбрал вручную), иначе — ту, в которой заказчик составил свою
 * локальную смету (шапка ЛСР: «Республика Бурятия (5 зона)»), иначе ту, чьи ставки оплаты труда
 * заказчик напечатал в своих ресурсных строках (`fingerprint`, основание CUSTOMER_PRICES), иначе
 * определяется по закупке (регион, адрес, заказчик). Зона из шапки сметы принимается, если однозначно
 * находится в справочнике; регион закупки ей не помеха: смета заказчика — более сильное свидетельство, где
 * находится объект, чем поле «регион» закупки по 223-ФЗ (там бывает регистрация заказчика: закупка 32616409061 —
 * «город Москва», а смета и объект — Сахалинская область). Расхождение называется в `notes`. Если шапка и
 * отпечаток цен называют разные зоны, берётся шапка и об этом сказано в `notes`. Если зоны цен нет или её
 * цены не собраны или выбрать не по чему — задание падает с внятной причиной и
 * подсказкой, что собрано и как выбрать зону вручную. Модуль чистый: списки зон и
 * закупку ему отдаёт вызывающий код (воркер читает их из индекса и базы).
 */

export interface BuiltZoneRef {
  readonly priceZoneId: number;
  readonly zoneName: string;
  readonly subject: string;
}

/** Зона, названная в шапке локальной сметы заказчика (`extractDeclaredPriceLevel`). */
export interface DeclaredZone {
  readonly subject: string | null;
  readonly zoneName: string | null;
  readonly zoneNumber: number | null;
}

/** Зона по ценам сметы заказчика: название зоны и коды ставок, совпавшие с её реестром. */
export interface ZoneFingerprint {
  readonly zoneName: string;
  readonly matchedCodes: readonly string[];
}

export interface ZoneChoiceInput {
  /** Зона, которую выбрал пользователь; нет — берётся зона из сметы заказчика, затем определяется по закупке. */
  readonly userPriceZoneId?: number | null;
  /**
   * Зона, в которой заказчик составил свои локальные сметы. Приоритет ниже ручного выбора и выше определения
   * по закупке. Используется, только если находится в списках зон однозначно и её субъект совпадает с регионом закупки.
   */
  readonly declared?: DeclaredZone | null;
  /**
   * Зона, узнанная по ставкам оплаты труда в ресурсных строках смет заказчика (`identifyZoneByWages`,
   * `src/services/estimateZoneFingerprint.ts`). Приоритет ниже ручного выбора и шапки сметы, выше определения по закупке.
   * Нет — отпечатка нет или он неоднозначен.
   */
  readonly fingerprint?: ZoneFingerprint | null;
  /** Данные закупки; null — расчёт по присланным документам без закупки. */
  readonly tender?: {
    readonly region?: string | null;
    readonly address?: string | null;
    readonly customerName?: string | null;
  } | null;
  readonly zones: readonly PriceZoneRecord[];
  readonly built: readonly BuiltZoneRef[];
  /**
   * Все зоны справочника ФГИС ЦС (номер и название), собранные и нет. Есть — зона, которой на
   * диске нет, не отказ, а выбор с `built: false`: воркер соберёт её по требованию перед
   * расчётом. Нет — как раньше: не собранная зона отказывает с перечнем собранных.
   */
  readonly directory?: readonly { readonly priceZoneId: number; readonly zoneName: string }[] | null;
}

export interface ZoneChoice {
  readonly priceZoneId: number;
  readonly basis: PriceZoneBasis;
  readonly matched: string | null;
  readonly northZone: NorthZone;
  /** Как определена северность (перечень районов Крайнего Севера): для допущений расчёта. */
  readonly northBasis: NorthBasis;
  readonly zoneName: string;
  /**
   * Пояснения к выбору: например, почему зона из сметы заказчика не использована. Нет поля — пояснять нечего,
   * так результат для прежних вызовов не отличается от прежнего.
   */
  readonly notes?: readonly string[];
  /**
   * `false` — цен зоны на диске нет, и её нужно собрать до расчёта (возможно только при `directory`).
   * Нет поля — зона собрана: так результат для собранных зон не отличается от прежнего.
   */
  readonly built?: false;
}

/** Зона не выбрана или не собрана: расчёт невозможен, и это надо сказать словами. */
export class EstimatePriceZoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EstimatePriceZoneError";
  }
}

const MANUAL_HINT = "Можно выбрать зону вручную.";

/** Зона для расчёта или `EstimatePriceZoneError` с объяснением. */
export function chooseEstimateZone(input: ZoneChoiceInput): ZoneChoice {
  const built = input.built;
  const collected = describeBuiltZones(built);

  const tender = input.tender ?? null;
  const directory = input.directory ?? null;
  // Номера зон: собранные и (если справочник есть) все остальные — по ним выбирается и не собранная зона.
  const zoneIds = new Map<string, number>([
    ...(directory ?? []).map((zone) => [zone.zoneName, zone.priceZoneId] as const),
    ...built.map((zone) => [zone.zoneName, zone.priceZoneId] as const),
  ]);
  const resolveByTender = (): ReturnType<typeof resolvePriceZone> =>
    resolvePriceZone(
      {
        region: tender?.region ?? "",
        address: tender?.address ?? null,
        customerName: tender?.customerName ?? null,
      },
      input.zones,
      built.map((zone) => zone.priceZoneId),
      zoneIds,
    );

  if (input.userPriceZoneId !== undefined && input.userPriceZoneId !== null) {
    const builtChoice = built.find((zone) => zone.priceZoneId === input.userPriceZoneId);
    const listed = directory?.find((zone) => zone.priceZoneId === input.userPriceZoneId);
    if (builtChoice === undefined && listed === undefined) {
      throw new EstimatePriceZoneError(
        `Цен по ценовой зоне ${String(input.userPriceZoneId)} ещё нет. Собраны: ${collected}.`,
      );
    }
    const chosen: BuiltZoneRef =
      builtChoice ?? { priceZoneId: (listed as { priceZoneId: number }).priceZoneId, zoneName: (listed as { zoneName: string }).zoneName, subject: "" };
    const isBuilt = builtChoice !== undefined;
    /*
      Зона Севера для нормативов НР. Если по закупке определилась та же зона, что
      выбрал человек, северность берётся оттуда — она знает муниципалитет (Северо-
      Байкальский район — МПРКС, Баргузинский — нет) — вместе с совпавшим
      названием. Иначе остаётся северность зоны целиком: МПРКС, только если все её
      районы и города из таблицы Севера (зона 8 Бурятии); смешанная зона —
      обычная территория.
    */
    const byTender = tender === null ? null : resolveByTender();
    if (byTender !== null && byTender.priceZoneId === chosen.priceZoneId) {
      return {
        priceZoneId: chosen.priceZoneId,
        basis: "USER",
        matched: byTender.matched,
        northZone: byTender.northZone,
        northBasis: byTender.northBasis,
        zoneName: chosen.zoneName,
        ...(isBuilt ? {} : { built: false as const }),
      };
    }
    const record = input.zones.find((zone) => zone.zoneName === chosen.zoneName);
    return {
      priceZoneId: chosen.priceZoneId,
      basis: "USER",
      matched: null,
      ...(record === undefined ? { northZone: "TERRITORY" as const, northBasis: "NONE" as const } : northOfZone(record)),
      zoneName: chosen.zoneName,
      ...(isBuilt ? {} : { built: false as const }),
    };
  }

  /*
    Зона из сметы заказчика. Он считал в ней, и сравнение с его сметой имеет смысл только в тех же ценах.
    Принимается, когда зона находится в списках однозначно. Регион закупки ей не противоречит и не мешает: поле «регион»
    закупки по 223-ФЗ часто — регион регистрации заказчика, а объект и смета — в другом субъекте (закупка 32616409061:
    регион «город Москва», смета и объект — «Сахалинская область (1 зона)»; расчёт в московских ценах дал −15 %). Расхождение
    уходит в `notes`. Не принята — причина тоже в `notes`, дальше отпечаток цен и закупка, как раньше.
  */
  const notes: string[] = [];
  const declared = input.declared ?? null;
  if (declared !== null && (declared.zoneName !== null || declared.subject !== null)) {
    const label = declared.zoneName ?? declared.subject ?? "";
    const matched = matchDeclaredZone(declared, zoneCandidates(input.zones, built, zoneIds));
    if (matched.kind !== "FOUND") {
      notes.push(`Зона из сметы заказчика «${label}» не использована: ${matched.reason}.`);
    } else {
      const candidate = matched.candidate;
      const byTender = tender === null ? null : resolveByTender();
      const tenderSubject = byTender?.subject ?? null;
      if (tenderSubject !== null && !isSameRegion(candidate.subject, tenderSubject)) {
        notes.push(
          `Регион закупки «${tenderSubject}», смета заказчика составлена в зоне «${candidate.zoneName}» — считаем в зоне сметы.`,
        );
      }
      if (candidate.priceZoneId === null) {
        // Зона есть в справочнике зон, но номера у неё нет: нужен справочник ФГИС ЦС, воркер его подгрузит.
        if (directory === null) {
          throw new EstimatePriceZoneError(
            `Смета заказчика составлена в зоне «${candidate.zoneName}», цен по ней ещё нет. Собраны: ${collected}. ${MANUAL_HINT}`,
          );
        }
        notes.push(`Зона из сметы заказчика «${label}» не использована: её нет в справочнике зон ФГИС ЦС.`);
      } else {
        const isBuilt = built.some((zone) => zone.priceZoneId === candidate.priceZoneId);
        const record = input.zones.find((zone) => zone.zoneName === candidate.zoneName);
        // Отпечаток цен назвал другую зону: шапка важнее, но расхождение видно — так сметчик заметит чужую шапку.
        const fingerprint = input.fingerprint ?? null;
        if (fingerprint !== null && normalizeRegionText(fingerprint.zoneName) !== normalizeRegionText(candidate.zoneName)) {
          notes.push(
            `По ставкам оплаты труда в смете заказчика (${fingerprint.matchedCodes.join(", ")}) определяется зона «${fingerprint.zoneName}», ` +
              `а в шапке сметы названа «${candidate.zoneName}» — принята зона из шапки.`,
          );
        }
        // Северность: если по закупке определилась та же зона, она знает муниципалитет; иначе — северность зоны целиком.
        const north =
          byTender !== null && byTender.priceZoneId === candidate.priceZoneId
            ? { northZone: byTender.northZone, northBasis: byTender.northBasis }
            : record === undefined
              ? { northZone: "TERRITORY" as const, northBasis: "NONE" as const }
              : northOfZone(record);
        return {
          priceZoneId: candidate.priceZoneId,
          basis: "CUSTOMER_ESTIMATE",
          matched: byTender !== null && byTender.priceZoneId === candidate.priceZoneId ? byTender.matched : null,
          ...north,
          zoneName: candidate.zoneName,
          ...(isBuilt ? {} : { built: false as const }),
          ...(notes.length === 0 ? {} : { notes }),
        };
      }
    }
  }

  /*
    Зона по ценам сметы заказчика: ставки труда в его ресурсных строках совпали с реестром ровно одной зоны. Только для зоны,
    которая находится среди известных (собранных или справочника), — иначе отпечаток не используется.
  */
  const fingerprint = input.fingerprint ?? null;
  if (fingerprint !== null) {
    const wanted = normalizeRegionText(fingerprint.zoneName);
    const found = zoneCandidates(input.zones, built, zoneIds).find(
      (candidate) => normalizeRegionText(candidate.zoneName) === wanted && candidate.priceZoneId !== null,
    );
    if (found !== undefined && found.priceZoneId !== null) {
      const isBuilt = built.some((zone) => zone.priceZoneId === found.priceZoneId);
      if (isBuilt || directory !== null) {
        const record = input.zones.find((zone) => zone.zoneName === found.zoneName);
        const byTender = tender === null ? null : resolveByTender();
        const sameAsTender = byTender !== null && byTender.priceZoneId === found.priceZoneId;
        const north = sameAsTender
          ? { northZone: byTender.northZone, northBasis: byTender.northBasis }
          : record === undefined
            ? { northZone: "TERRITORY" as const, northBasis: "NONE" as const }
            : northOfZone(record);
        const tenderZone = byTender?.zoneName ?? null;
        if (byTender !== null && byTender.priceZoneId !== null && !sameAsTender && tenderZone !== null) {
          notes.push(
            `Ставки оплаты труда в смете заказчика (${fingerprint.matchedCodes.join(", ")}) совпали с реестром зоны «${found.zoneName}», ` +
              `а по закупке определялась «${tenderZone}» — считаем в зоне по ценам сметы.`,
          );
        }
        return {
          priceZoneId: found.priceZoneId,
          basis: "CUSTOMER_PRICES",
          matched: fingerprint.matchedCodes.join(", "),
          ...north,
          zoneName: found.zoneName,
          ...(isBuilt ? {} : { built: false as const }),
          ...(notes.length === 0 ? {} : { notes }),
        };
      }
    }
  }

  const resolution = resolveByTender();

  if (resolution.basis === "UNKNOWN_REGION") {
    if (resolution.subject === null) {
      throw new EstimatePriceZoneError(
        `Регион закупки не определён, поэтому цены ценовой зоны выбрать нельзя. Собраны: ${collected}. ${MANUAL_HINT}`,
      );
    }
    throw new EstimatePriceZoneError(
      `Ценовую зону внутри субъекта «${resolution.subject}» определить не удалось: в адресе и названии заказчика нет муниципалитета из списка зон. Собраны: ${collected}. ${MANUAL_HINT}`,
    );
  }

  // Зона определена, номер известен, но на диске её нет: со справочником её соберут по требованию.
  if (resolution.priceZoneId !== null && !resolution.built && directory !== null) {
    return {
      priceZoneId: resolution.priceZoneId,
      basis: resolution.basis,
      matched: resolution.matched,
      northZone: resolution.northZone,
      northBasis: resolution.northBasis,
      zoneName: resolution.zoneName ?? "",
      built: false as const,
      ...(notes.length === 0 ? {} : { notes }),
    };
  }

  if (resolution.priceZoneId === null || !resolution.built) {
    const target = resolution.subject !== null && resolution.zoneName !== null && resolution.zoneName !== resolution.subject
      ? resolution.zoneName
      : (resolution.subject ?? resolution.zoneName ?? "");
    throw new EstimatePriceZoneError(`Цен по зоне «${target}» ещё нет. Собраны: ${collected}. ${MANUAL_HINT}`);
  }

  return {
    priceZoneId: resolution.priceZoneId,
    basis: resolution.basis,
    matched: resolution.matched,
    northZone: resolution.northZone,
    northBasis: resolution.northBasis,
    zoneName: resolution.zoneName ?? "",
    ...(notes.length === 0 ? {} : { notes }),
  };
}

/**
 * Собранные зоны одного субъекта, среди которых искать зону по ценам сметы заказчика: субъект из шапки сметы (даже без названия
 * зоны), иначе субъект закупки. Только собранные: шкалы ставок читаются с диска. Пусто — субъект назвать нельзя или его зон на диске нет.
 * (Если рядом с собранной зоной лежит несобранная с теми же ставками, отпечаток их не различит — как и любое другое определение.)
 */
export function fingerprintCandidateZones(input: Pick<ZoneChoiceInput, "declared" | "tender" | "zones" | "built">): BuiltZoneRef[] {
  const declared = input.declared ?? null;
  let subject = declared?.subject ?? (declared?.zoneName == null ? null : subjectOfZoneName(declared.zoneName));
  if (subject === null || subject === "") {
    const tender = input.tender ?? null;
    // Субъекта не знает ни смета, ни закупка — кандидаты все собранные зоны (см. ниже).
    if (tender === null) return [...input.built];
    const names = [...new Set(input.zones.map((zone) => zone.subjectName))];
    const region = tender.region ?? "";
    subject = names.find((name) => isSameRegion(region, name)) ?? null;
    if (subject === null) {
      const byAddress = resolvePriceZone(
        { region, address: tender.address ?? null, customerName: tender.customerName ?? null },
        input.zones,
        [],
        new Map(),
      ).subject;
      subject = byAddress;
    }
  }
  /*
    Субъект не определился ни по смете, ни по закупке (капремонт Москвы по 223-ФЗ: шапка сметы без субъекта, регион в
    карточке пуст) — кандидатами идут все собранные зоны. Ложного выбора это не даёт: отпечаток требует точного, до копейки,
    совпадения ставок минимум по двум кодам и отказывает, если подходят две зоны (`identifyZoneByWages`). Ставки реестров
    разных субъектов до копейки на двух разрядах сразу не совпадают.
  */
  if (subject === null || subject === "") return [...input.built];
  const wanted = subject;
  const zones = input.built.filter((zone) => isSameRegion(wanted, zone.subject === "" ? subjectOfZoneName(zone.zoneName) : zone.subject));
  return zones;
}

/* ------------------- Зона заказчика среди зон справочника ------------------- */

interface ZoneCandidate {
  readonly zoneName: string;
  readonly subject: string;
  /** Номер зоны во ФГИС ЦС; `null` — среди собранных и справочника её нет. */
  readonly priceZoneId: number | null;
}

/** Все известные зоны: из `zones.jsonl` (с субъектом), собранные и справочник (по названию), без повторов. */
function zoneCandidates(
  records: readonly PriceZoneRecord[],
  built: readonly BuiltZoneRef[],
  zoneIds: ReadonlyMap<string, number>,
): ZoneCandidate[] {
  const result = new Map<string, ZoneCandidate>();
  for (const record of records) {
    result.set(record.zoneName, {
      zoneName: record.zoneName,
      subject: record.subjectName,
      priceZoneId: zoneIds.get(record.zoneName) ?? null,
    });
  }
  for (const [zoneName, priceZoneId] of zoneIds) {
    if (result.has(zoneName)) continue;
    const subject = built.find((zone) => zone.zoneName === zoneName)?.subject ?? "";
    result.set(zoneName, { zoneName, subject: subject === "" ? subjectOfZoneName(zoneName) : subject, priceZoneId });
  }
  return [...result.values()];
}

type DeclaredMatch =
  | { readonly kind: "FOUND"; readonly candidate: ZoneCandidate }
  | { readonly kind: "NONE" | "AMBIGUOUS"; readonly reason: string };

/**
 * Находит зону заказчика среди зон: совпало нормализованное название либо тот же субъект и тот же номер зоны
 * (у субъекта с одной зоной номера нет — достаточно субъекта). Не нашлось или подходят несколько — зона не выбирается.
 */
function matchDeclaredZone(declared: DeclaredZone, candidates: readonly ZoneCandidate[]): DeclaredMatch {
  const none = { kind: "NONE", reason: "такой зоны нет в справочнике зон" } as const;
  if (declared.zoneName !== null) {
    const wanted = normalizeRegionText(declared.zoneName);
    const exact = candidates.filter((candidate) => normalizeRegionText(candidate.zoneName) === wanted);
    if (exact.length === 1 && exact[0] !== undefined) return { kind: "FOUND", candidate: exact[0] };
    if (exact.length > 1) return { kind: "AMBIGUOUS", reason: "название подходит нескольким зонам" };
  }
  const subject = declared.subject ?? (declared.zoneName === null ? null : subjectOfZoneName(declared.zoneName));
  if (subject === null || subject === "") return none;
  const ofSubject = candidates.filter((candidate) => candidate.subject !== "" && isSameRegion(subject, candidate.subject));
  const number = declared.zoneNumber ?? (declared.zoneName === null ? null : zoneNumberIn(declared.zoneName));
  const pool =
    number === null ? ofSubject : ofSubject.filter((candidate) => zoneNumberIn(candidate.zoneName) === number);
  const [only] = pool;
  if (pool.length === 1 && only !== undefined && sameZone(declared, only.zoneName)) return { kind: "FOUND", candidate: only };
  if (pool.length > 1) return { kind: "AMBIGUOUS", reason: "зона определяется неоднозначно" };
  return none;
}
