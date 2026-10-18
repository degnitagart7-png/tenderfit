"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanyProfile } from "@/domain/entities";
import type { TenderLaw } from "@/domain/enums";
import type { KonturPressPlan } from "@/domain/konturPressPlan";
import type { TenderRow } from "@/domain/filtering";
import { tenderApiService } from "@/services/tenderApiService";
import { konturApiService, type KonturSyncResponse } from "@/services/konturApiService";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { searchProfileRepository } from "@/repositories/searchProfileRepository";
import { withSearchRegions } from "@/domain/scoringGeography";

/** Законы по умолчанию: роут отвечает 400 на пустой список. */
const DEFAULT_LAWS: TenderLaw[] = ["FZ_44", "FZ_223"];

/**
 * Закупок на одно ключевое слово — ровно страница выдачи Контур.Закупок
 * (API всегда отдаёт 50 записей). Больше не значит дороже, но и не значит
 * полнее: сверх одной страницы нужен второй платный запрос.
 */
const TENDERS_PER_KEYWORD = 50;

/**
 * Страниц выдачи на одно слово — одна.
 *
 * Без этого потолок «не больше трёх платных поисков на нажатие» не
 * выполняется: локальные фильтры региона и ОКПД2 отсеивают часть выдачи, и
 * адаптер листает страницы, пока не наберётся `limit` подходящих записей, —
 * до пяти платных запросов на слово вместо одного.
 */
const PAGES_PER_KEYWORD = 1;

/** Итог прогона: ответ роута плюс профиль, по которому он выполнялся. */
export interface KonturSyncReport extends KonturSyncResponse {
  profileName: string;
}

interface TenderDataState {
  profile: CompanyProfile | null;
  rows: TenderRow[];
  loading: boolean;
  error: string | null;
}

/** Состояние прогона по кнопке: его показывает панель поиска на дашборде. */
export interface TenderSyncState {
  syncing: boolean;
  error: string | null;
  /** Момент последнего удачного прогона; 0 — удачных ещё не было. */
  lastSynced: number;
  progress: string | null;
  /** Отчёт последнего прогона. null — кнопкой в этом сеансе не пользовались. */
  report: KonturSyncReport | null;
}

const IDLE_SYNC_STATE: TenderSyncState = {
  syncing: false,
  error: null,
  lastSynced: 0,
  progress: null,
  report: null,
};

/**
 * Загружает профиль компании и полные строки закупок (закупка + анализ + воронка)
 * и выполняет платный поиск Контур.Закупок из панели «Найти новые закупки».
 *
 * Ленту наполняет прогон на машине с российским адресом: реестр ЕИС и его
 * хранилище файлов зарубежным IP не отвечают, и часть площадок закрывает доступ
 * из-за рубежа тоже. Воркер `scripts/worker.ts` на сервере в России раз в два часа
 * запускает `scripts/sync-eis.ts` и заодно разбирает очередь заданий; задача
 * Windows на компьютере владельца отключена 25.09.2026, расписание живёт только
 * на сервере. Основное действие кнопки — постановка в ту же очередь задания
 * `full_sync` (`syncJobApiService.enqueueFullSync`): бесплатный прогон
 * источников, которые не стоят денег.
 *
 * Этот хук отвечает только за вторую, платную часть панели. Она необязательна и
 * не опорная:
 *
 * - Контур.Закупки отвечают серверу Vercel, поэтому результат такого поиска
 *   виден сразу, а не через десятки минут, — в этом его единственное
 *   преимущество перед бесплатным прогоном;
 * - каждое ключевое слово стоит один поиск из суточного тарифа, поэтому план
 *   нажатия (`konturPressPlan`) ограничен тремя словами и показывается партнёру
 *   до запуска, а не после;
 * - кончившаяся подписка останавливает источник отказом, а не роняет ленту:
 *   бесплатный прогон от ключа агрегатора не зависит.
 *
 * Какие источники участвуют в прогоне, решает каталог `src/domain/sources.ts`,
 * а не этот комментарий: перечень менялся трижды за две недели, и догонять его в
 * подписях — значит держать в дереве строку, которая устареет к следующему
 * деплою. Только прогон приносит документацию для глубокого разбора: в
 * поисковой выдаче Контур списка файлов нет вовсе. Платный поиск ставит
 * найденные закупки в очередь на документацию (`queueDocuments`), а что вышло из
 * постановки, рассказывает поле `documentsQueue` ответа.
 *
 * Роут `POST /api/tenders/sync` (ЕИС внутри серверлесс-функции) отсюда больше
 * не вызывается: на проде он всегда падал, а интерфейс показывал это как
 * «Новые закупки не загрузились».
 */
/** Через сколько данные считаются устаревшими при возвращении на вкладку. */
export const BACKGROUND_REFRESH_AFTER_MS = 5 * 60_000;
/** Как часто лента обновляется сама, пока вкладка видна. */
export const BACKGROUND_REFRESH_EVERY_MS = 10 * 60_000;

export function useTenderData(): TenderDataState & {
  /** Перечитывает данные и возвращает свежий список — ждать, а не «вызвать и забыть». */
  reload: () => Promise<TenderRow[]>;
  /** Прогон по плану нажатия; null — запрос не выполнялся или не удался. */
  syncKontur: (plan: KonturPressPlan) => Promise<KonturSyncReport | null>;
  syncState: TenderSyncState;
} {
  const [state, setState] = useState<TenderDataState>({
    profile: null,
    rows: [],
    loading: true,
    error: null,
  });

  const [syncState, setSyncState] = useState<TenderSyncState>(IDLE_SYNC_STATE);

  const lastLoadedAt = useRef(0);

  /**
   * Загрузка ленты. `silent` — фоновое обновление: без заглушки загрузки, и
   * сбой не заменяет уже показанную ленту ошибкой. `fresh` — данные только что
   * изменились (поиск закончился, нажато «Обновить»): готовую ленту из памяти
   * сервиса не берём. Первая загрузка и фоновое обновление идут без `fresh`:
   * несколько компонентов страницы, открытых вместе, делят один запрос.
   */
  const load = useCallback(async (silent = false, fresh = false): Promise<TenderRow[]> => {
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const profile = companyProfileRepository.get();
      // Подбор учитывает и регионы из «Что ищем»: выбранный там регион не
      // должен получать «Не подходит» из-за узкой географии в профиле компании.
      const rows = await tenderApiService.getRows(
        withSearchRegions(profile, searchProfileRepository.getAll()),
        undefined,
        fresh ? { fresh: true } : undefined,
      );
      lastLoadedAt.current = Date.now();
      setState({ profile, rows, loading: false, error: null });
      return rows;
    } catch (err) {
      if (silent) return [];
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : "Неизвестная ошибка",
      }));
      return [];
    }
  }, []);

  const syncKontur = useCallback(
    async (plan: KonturPressPlan): Promise<KonturSyncReport | null> => {
      // Оба отказа — до запроса в сеть: деньги обязаны тратиться только на то,
      // что панель подтверждения показала партнёру.
      if (!plan.profile) {
        setSyncState((s) => ({
          ...s,
          syncing: false,
          progress: null,
          report: null,
          error:
            "Нет включённого профиля поиска. Укажите, что ищем, в разделе «Условия поиска» — иначе искать нечего.",
        }));
        return null;
      }
      if (plan.spend <= 0) {
        setSyncState((s) => ({
          ...s,
          syncing: false,
          progress: null,
          report: null,
          error: "Прогон ничего не стоит и ничего не найдёт: потолок платных поисков равен нулю.",
        }));
        return null;
      }

      const profile = plan.profile;
      setSyncState((s) => ({
        ...s,
        syncing: true,
        error: null,
        progress: `Контур.Закупки · профиль «${profile.name}»…`,
        report: null,
      }));

      try {
        const response = await konturApiService.sync({
          laws: profile.laws.length > 0 ? profile.laws : DEFAULT_LAWS,
          // Ровно те слова, что показаны в панели: потолок применяется до
          // запроса, поэтому фактический расход не может превысить обещанный.
          keywords: plan.keywords,
          excludeKeywords: profile.stopWords.length > 0 ? profile.stopWords : undefined,
          regions: profile.regions.length > 0 ? profile.regions : undefined,
          customerInns: profile.customerInns.length > 0 ? profile.customerInns : undefined,
          okpd2Codes: profile.okpd2Codes.length > 0 ? profile.okpd2Codes : undefined,
          minPrice: profile.minPrice,
          maxPrice: profile.maxPrice,
          limit: TENDERS_PER_KEYWORD,
          maxPages: PAGES_PER_KEYWORD,
          // Документов в поисковой выдаче нет: список файлов приходит только в
          // платной карточке, которую кнопка не покупает.
          saveDocuments: false,
          // Файлы лежат в хранилище ЕИС, а оно не отвечает зарубежным адресам:
          // скачает воркер на сервере в России. Просим явно — иначе прогон
          // вернёт закупки без документации и без объяснения, где она.
          queueDocuments: true,
        });
        const report: KonturSyncReport = { ...response, profileName: profile.name };
        setSyncState({
          syncing: false,
          error: null,
          lastSynced: Date.now(),
          progress: null,
          report,
        });
        // Платный поиск дописал закупки в базу: лента читается заново.
        await load(false, true);
        return report;
      } catch (err) {
        /*
          Сетевой сбой браузера (fetch отклоняется с TypeError) переводим на
          русский: «Failed to fetch» партнёру ничего не говорит. Отказ роута
          трогаем как есть — там причина уже сформулирована («Исчерпан суточный
          лимит…», «Ключ отклонён»).
          Момент последнего удачного прогона не затираем: ошибка сегодня не
          означает, что лента стала несвежей прямо сейчас.
        */
        const message =
          err instanceof TypeError
            ? "Сервер не ответил — проверьте подключение к интернету и попробуйте снова."
            : err instanceof Error
              ? err.message
              : "Ошибка синхронизации";
        setSyncState((s) => ({
          ...s,
          syncing: false,
          progress: null,
          report: null,
          error: message,
        }));
        return null;
      }
    },
    [load],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /*
    Свежие закупки без перезагрузки страницы. Сборщик приносит новое раз в два
    часа и по кнопке поиска, а лента загружалась один раз при открытии: вкладка,
    открытая с утра, новых закупок не показывала (замечание 05.10.2026).
    Обновляем тихо: при возвращении на вкладку, если данные старше пяти минут,
    и раз в десять минут, пока вкладка видна.
  */
  useEffect(() => {
    const refreshIfStale = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastLoadedAt.current < BACKGROUND_REFRESH_AFTER_MS) return;
      void load(true);
    };
    const timer = window.setInterval(refreshIfStale, BACKGROUND_REFRESH_EVERY_MS);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [load]);

  return { ...state, reload: () => load(false, true), syncKontur, syncState };
}
