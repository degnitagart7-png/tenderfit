import { getSupabaseServerClient } from "@/lib/supabase";
import { sourcePriorities } from "@/domain/sources";
import type { TenderRow, TenderLaw, PlacingWay, TenderDataSource } from "@/types/database";

export interface CreateTenderInput {
  reg_number: string;
  external_id?: string | null;
  law: TenderLaw;
  placing_way: PlacingWay;
  subject: string;
  customer_name: string;
  customer_inn?: string | null;
  region: string;
  delivery_address?: string | null;
  price?: number | null;
  currency?: string;
  advance_payment?: number | null;
  security_bid?: number | null;
  security_contract?: number | null;
  submission_end: string;
  publication_date?: string | null;
  last_update_date?: string | null;
  delivery_term_days?: number | null;
  delivery_date_end?: string | null;
  okpd2_codes?: string[] | null;
  lots?: unknown[] | null;
  requirements?: unknown[] | null;
  national_regime?: boolean;
  only_for_smp?: boolean;
  eis_url?: string | null;
  data_source?: TenderDataSource;
  change_log?: unknown[] | null;
  /** Сырой ответ источника (колонки появятся после миграции 20260921000003). */
  raw_data?: Record<string, unknown> | null;
  synced_at?: string | null;
}

export interface UpdateTenderInput {
  subject?: string;
  customer_name?: string;
  customer_inn?: string | null;
  region?: string;
  delivery_address?: string | null;
  price?: number | null;
  /** Пишется, только если передан: null здесь сломал бы валюту по умолчанию. */
  currency?: string;
  /** Внешний идентификатор источника (у Контур.Закупок — номер извещения). */
  external_id?: string | null;
  advance_payment?: number | null;
  security_bid?: number | null;
  security_contract?: number | null;
  submission_end?: string;
  publication_date?: string | null;
  last_update_date?: string | null;
  delivery_term_days?: number | null;
  delivery_date_end?: string | null;
  okpd2_codes?: string[] | null;
  lots?: unknown[] | null;
  requirements?: unknown[] | null;
  national_regime?: boolean;
  only_for_smp?: boolean;
  eis_url?: string | null;
  /**
   * Источник обновляемых данных. Передаётся, только если строку принёс более
   * авторитетный источник: иначе закупка осталась бы подписана агрегатором при
   * данных из ЕИС.
   */
  data_source?: TenderDataSource;
  change_log?: unknown[] | null;
  /** Сырой ответ источника (колонки появятся после миграции 20260921000003). */
  raw_data?: Record<string, unknown> | null;
  synced_at?: string | null;
}

/**
 * Авторитетность источника данных.
 *
 * Контур.Закупки — агрегатор: он отдаёт те же извещения 44-ФЗ и 223-ФЗ, что
 * публикует ЕИС, а номер закупки в его выдаче (поле `Id`) совпадает с номером
 * извещения в ЕИС. Значит одна и та же закупка приходит из двух источников, и
 * без правила «кто главнее» вторая синхронизация перезаписала бы первую:
 * `update` пишет null на место отсутствующих значений, поэтому вместе с
 * менее полными данными агрегатора пропали бы заказчик, регион, ссылка на
 * карточку ЕИС и требования.
 *
 * Порядок: первоисточник (ЕИС) выше площадок-первоисточников (ТЭК-Торг,
 * Сбербанк-АСТ, Фабрикант), те выше ручной загрузки и агрегаторов, а
 * демонстрационные данные — ниже всех, чтобы любой настоящий прогон их
 * вытеснял. Числа приоритета задаёт каталог `src/domain/sources.ts`.
 *
 * Одно исключение выглядит нарушением этого порядка, и оно осознанное: Росэлторг
 * стоит ниже агрегаторов. Он тоже площадка-первоисточник, но его строка выдачи
 * беднее чужих записей — нет даты публикации, кодов ОКПД2 и документов, а цена
 * есть только при полном наборе лотов. Секции 223-ФЗ печатают номер извещения ЕИС,
 * то есть совпадение с чужой записью вероятно, и вытеснять более полную запись
 * менее полной значит потерять данные. Ценность Росэлторга — процедуры с номерами
 * площадки, у которых совпадений не бывает вовсе.
 *
 * Числа здесь не записаны: они лежат в каталоге `src/domain/sources.ts`, откуда
 * выводятся, и новый источник добавляется одной записью там, а не правкой в
 * двух слоях.
 */
export const TENDER_SOURCE_PRIORITY: Record<TenderDataSource, number> =
  sourcePriorities();

/** Источник по умолчанию — как в `create`, чтобы сравнение не расходилось с записью. */
function resolveSource(input: { data_source?: TenderDataSource }): TenderDataSource {
  return input.data_source ?? "EIS";
}

export interface TenderFilters {
  law?: TenderLaw;
  region?: string;
  data_source?: TenderDataSource;
  customer_inn?: string;
  okpd2_code?: string;
  submission_end_after?: string;
  submission_end_before?: string;
  price_min?: number;
  price_max?: number;
  /** Реестровый номер — для выборки одной конкретной закупки. */
  reg_number?: string;
}

export const tenderRepository = {
  async create(input: CreateTenderInput): Promise<TenderRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tenders")
      .insert({
        reg_number: input.reg_number,
        external_id: input.external_id ?? null,
        law: input.law,
        placing_way: input.placing_way,
        subject: input.subject,
        customer_name: input.customer_name,
        customer_inn: input.customer_inn ?? null,
        region: input.region,
        delivery_address: input.delivery_address ?? null,
        price: input.price ?? null,
        currency: input.currency ?? "RUB",
        advance_payment: input.advance_payment ?? null,
        security_bid: input.security_bid ?? null,
        security_contract: input.security_contract ?? null,
        submission_end: input.submission_end,
        publication_date: input.publication_date ?? null,
        last_update_date: input.last_update_date ?? null,
        delivery_term_days: input.delivery_term_days ?? null,
        delivery_date_end: input.delivery_date_end ?? null,
        okpd2_codes: input.okpd2_codes ?? null,
        lots: input.lots ?? null,
        requirements: input.requirements ?? null,
        national_regime: input.national_regime ?? false,
        only_for_smp: input.only_for_smp ?? false,
        eis_url: input.eis_url ?? null,
        data_source: input.data_source ?? "EIS",
        change_log: input.change_log ?? null,
        // Колонки raw_data/synced_at появляются только с миграцией
        // 20260921000003, поэтому пишем их лишь когда значение передано:
        // иначе синхронизация упала бы до применения миграции.
        ...(input.raw_data !== undefined ? { raw_data: input.raw_data } : {}),
        ...(input.synced_at !== undefined ? { synced_at: input.synced_at } : {}),
      })
      .select()
      .single();

    if (error) throw error;
    return data as TenderRow;
  },

  async findById(id: string): Promise<TenderRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tenders")
      .select("*")
      .eq("id", id)
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return data as TenderRow;
  },

  async findByRegNumber(regNumber: string): Promise<TenderRow | null> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tenders")
      .select("*")
      .eq("reg_number", regNumber)
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw error;
    }
    return data as TenderRow;
  },

  async list(filters?: TenderFilters, limit = 100, offset = 0): Promise<TenderRow[]> {
    const supabase = getSupabaseServerClient();
    let query = supabase.from("tenders").select("*");

    if (filters?.law) {
      query = query.eq("law", filters.law);
    }
    if (filters?.reg_number) {
      query = query.eq("reg_number", filters.reg_number);
    }
    if (filters?.region) {
      query = query.eq("region", filters.region);
    }
    if (filters?.data_source) {
      query = query.eq("data_source", filters.data_source);
    }
    if (filters?.customer_inn) {
      query = query.eq("customer_inn", filters.customer_inn);
    }
    if (filters?.okpd2_code) {
      query = query.contains("okpd2_codes", [filters.okpd2_code]);
    }
    if (filters?.submission_end_after) {
      query = query.gt("submission_end", filters.submission_end_after);
    }
    if (filters?.submission_end_before) {
      query = query.lt("submission_end", filters.submission_end_before);
    }
    if (filters?.price_min !== undefined) {
      query = query.gte("price", filters.price_min);
    }
    if (filters?.price_max !== undefined) {
      query = query.lte("price", filters.price_max);
    }

    const { data, error } = await query
      .order("submission_end", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return (data ?? []) as TenderRow[];
  },

  async update(id: string, input: UpdateTenderInput): Promise<TenderRow> {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("tenders")
      .update({
        subject: input.subject ?? undefined,
        customer_name: input.customer_name ?? undefined,
        customer_inn: input.customer_inn,
        region: input.region ?? undefined,
        delivery_address: input.delivery_address,
        price: input.price,
        advance_payment: input.advance_payment,
        security_bid: input.security_bid,
        security_contract: input.security_contract,
        submission_end: input.submission_end ?? undefined,
        last_update_date: input.last_update_date,
        delivery_term_days: input.delivery_term_days,
        delivery_date_end: input.delivery_date_end,
        okpd2_codes: input.okpd2_codes,
        lots: input.lots,
        requirements: input.requirements,
        national_regime: input.national_regime ?? undefined,
        only_for_smp: input.only_for_smp ?? undefined,
        eis_url: input.eis_url,
        change_log: input.change_log,
        // Три поля пишем только когда их передали: `currency` по умолчанию RUB,
        // а null вместо неё сломал бы деньги в уже сохранённой закупке.
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.external_id !== undefined ? { external_id: input.external_id } : {}),
        ...(input.publication_date !== undefined
          ? { publication_date: input.publication_date }
          : {}),
        ...(input.data_source !== undefined ? { data_source: input.data_source } : {}),
        ...(input.raw_data !== undefined ? { raw_data: input.raw_data } : {}),
        ...(input.synced_at !== undefined ? { synced_at: input.synced_at } : {}),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data as TenderRow;
  },

  /**
   * Сохранить закупку, не плодя дублей.
   *
   * Идентификатор закупки — реестровый номер: по нему одна и та же закупка с
   * разных площадок попадает в одну строку. Если строку уже принёс более
   * авторитетный источник, запись пропускается, а источник возвращается в
   * `duplicateOf` — вызывающий код считает такие случаи как дубли, а не как
   * обновления.
   */
  async upsertByRegNumber(
    input: CreateTenderInput,
  ): Promise<{ row: TenderRow; created: boolean; duplicateOf?: TenderDataSource }> {
    const existing = await this.findByRegNumber(input.reg_number);

    if (existing) {
      const incoming = resolveSource(input);
      const stored = existing.data_source;
      if (
        stored &&
        TENDER_SOURCE_PRIORITY[stored] !== undefined &&
        TENDER_SOURCE_PRIORITY[stored] > TENDER_SOURCE_PRIORITY[incoming]
      ) {
        return { row: existing, created: false, duplicateOf: stored };
      }
      const updated = await this.update(existing.id, input);
      return { row: updated, created: false };
    } else {
      const created = await this.create(input);
      return { row: created, created: true };
    }
  },

  async delete(id: string): Promise<void> {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase.from("tenders").delete().eq("id", id);
    if (error) throw error;
  },
};
