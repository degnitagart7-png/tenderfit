"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EstimateResultData } from "@/components/estimate/EstimateResult";
import {
  applyBillEdits,
  billSignature,
  clearEdit,
  describeBillEdits,
  recordEdit,
  remainingRejected,
  remapEdits,
  type AppliedBillEdits,
  type BillEdit,
  type BillEditMark,
  type BillEditsRecord,
  type RemappedEdits,
} from "@/domain/estimate/billEdits";
import type { EstimateBillSnapshot } from "@/domain/estimate/billReview";
import type { EstimateDocument, EstimateLine } from "@/domain/estimate/types";
import { readJsonOrThrow } from "@/lib/readJson";
import { billEditsStore, type EditsPlace } from "@/services/billEditsStore";

/**
 * Правки ведомости на экране: список правок, сохранение, пересчёт и конфликт с новой ведомостью.
 *
 * Состояние такое: `base` — результат расчёта как он пришёл от воркера (ведомость и нормы, подобранные
 * автоматически); `edits` — то, что человек исправил; `applied` — результат последнего пересчёта.
 * Правка сразу попадает в список и сохраняется (через полсекунды), но на итог влияет только после
 * «Пересчитать»: до этого строки с неприменёнными правками помечены, а кнопка активна.
 *
 * Пересчёт — запрос `/api/estimate/recalc` (без модели, секунды). Нет правок — запроса нет, показан
 * исходный расчёт.
 *
 * Повторный «Рассчитать смету» даёт новую ведомость. Если она совпала с прежней (тот же отпечаток),
 * правки переезжают молча; если изменилась — `conflict`: «применить / отбросить». Молча терять или
 * молча применять правки к другой ведомости нельзя.
 */

const SAVE_DELAY_MS = 500;

/** Правки, найденные для прежней ведомости, и что из них встанет на места в новой. */
export interface BillEditsConflict {
  readonly record: BillEditsRecord;
  readonly remapped: RemappedEdits;
}

/** Итоги «было → стало». */
export interface TotalsDiff {
  readonly before: { readonly workCost: number; readonly total: number };
  readonly after: { readonly workCost: number; readonly total: number };
}

export interface BillEditor {
  /** Править можно: расчёт сделан воркером, который записывает ведомость, и есть задание. */
  readonly available: boolean;
  /** Загрузка сохранённых правок идёт. */
  readonly loading: boolean;
  /** Текущий список правок. */
  readonly edits: readonly BillEdit[];
  /** Исходный расчёт: по нему строятся «якоря» правок и «было». */
  readonly base: EstimateResultData;
  /** То, что показывать: исходный расчёт или результат последнего пересчёта. */
  readonly effective: EstimateResultData;
  /** Ведомость с применёнными (пока на экране) правками: значения для полей ввода. */
  readonly desired: AppliedBillEdits;
  /** Есть правки, которых нет в показанном расчёте: «Пересчитать» активна. */
  readonly dirty: boolean;
  /** Идентификаторы строк, у которых правка ещё не применена к показанному расчёту. */
  readonly pendingIds: ReadonlySet<string>;
  readonly recalculating: boolean;
  readonly error: string | null;
  /** Сообщение после пересчёта: сколько правок не нашло свою строку. */
  readonly notice: string | null;
  readonly conflict: BillEditsConflict | null;
  /** Правки словами по последнему пересчёту: для пометок и отчёта. */
  readonly marks: readonly BillEditMark[];
  /** «Было → стало»; null — пересчёта нет или итог не изменился. */
  readonly diff: TotalsDiff | null;
  /** Где хранятся правки. */
  readonly place: EditsPlace;
  readonly record: (edit: BillEdit) => void;
  readonly clear: (itemId: string, kind: "change" | "norm" | "price" | "remove" | "coefficients" | "material", resourceCode?: string) => void;
  /** Убрать правку по номеру в списке (отмена добавления и т. п.). */
  readonly drop: (edit: BillEdit) => void;
  readonly resetAll: () => void;
  readonly recalc: () => Promise<void>;
  readonly applyConflict: () => Promise<void>;
  readonly discardConflict: () => void;
}

interface RecalcResponse {
  readonly document: EstimateDocument;
  readonly bill: EstimateBillSnapshot;
  readonly billItems: number;
  readonly applied: { readonly count: number; readonly unmatched: readonly BillEdit[]; readonly marks: readonly BillEditMark[] };
}

const keyOf = (edits: readonly BillEdit[]): string => JSON.stringify(edits);

function editId(edit: BillEdit): string {
  return edit.kind === "add" || edit.kind === "restore" ? edit.id : edit.anchor.itemId;
}

/** Строки сметы по идентификатору позиции. */
export function linesById(document: EstimateDocument): ReadonlyMap<string, EstimateLine> {
  return new Map(document.sections.flatMap((section) => section.lines).map((line) => [line.itemId, line] as const));
}

export function useBillEdits(args: {
  /** Закупка, за которой хранятся правки; нет — правки живут только на экране. */
  readonly tenderId: string | undefined;
  readonly jobId: string | null | undefined;
  readonly result: EstimateResultData | null;
}): BillEditor | null {
  const { tenderId, jobId, result } = args;
  const bill = result?.bill;
  const available = result !== null && bill !== undefined && bill.calc !== undefined && typeof jobId === "string";

  const [edits, setEdits] = useState<readonly BillEdit[]>([]);
  const [applied, setApplied] = useState<{ key: string; response: RecalcResponse | null }>({ key: "[]", response: null });
  const [loading, setLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<BillEditsConflict | null>(null);
  const [place, setPlace] = useState<EditsPlace>("server");
  const loaded = useRef(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ edits, jobId, tenderId, bill });
  latest.current = { edits, jobId, tenderId, bill };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const callRecalc = useCallback(
    async (list: readonly BillEdit[], job: string): Promise<boolean> => {
      setRecalculating(true);
      setError(null);
      try {
        const response = await fetch("/api/estimate/recalc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: job, edits: list }),
        });
        const payload = await readJsonOrThrow<RecalcResponse>(response);
        if (!alive.current) return false;
        setApplied({ key: keyOf(list), response: payload });
        const missed = payload.applied.unmatched.length;
        setNotice(
          missed > 0
            ? `Применено правок: ${String(payload.applied.count - missed)} из ${String(payload.applied.count)}. Не нашли свою строку: ${String(missed)}.`
            : null,
        );
        return true;
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : "Не удалось пересчитать смету");
        return false;
      } finally {
        if (alive.current) setRecalculating(false);
      }
    },
    [],
  );

  const persist = useCallback(async (list: readonly BillEdit[]): Promise<void> => {
    const { jobId: job, tenderId: tender, bill: snapshot } = latest.current;
    if (tender === undefined || typeof job !== "string" || snapshot === undefined) return;
    const record: BillEditsRecord | null =
      list.length === 0
        ? null
        : {
            version: 1,
            tenderId: tender,
            baseJobId: job,
            billSignature: billSignature(snapshot.sections),
            updatedAt: new Date().toISOString(),
            edits: list,
          };
    const where = await billEditsStore.save(tender, record);
    if (alive.current) setPlace(where);
  }, []);

  // Новый результат расчёта (или другая закупка): сброс и подгрузка сохранённых правок.
  useEffect(() => {
    loaded.current = false;
    setEdits([]);
    setApplied({ key: "[]", response: null });
    setConflict(null);
    setNotice(null);
    setError(null);
    if (!available || tenderId === undefined || typeof jobId !== "string" || bill === undefined) return;

    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { record, place: where } = await billEditsStore.load(tenderId);
      if (cancelled || !alive.current) return;
      setPlace(where);
      setLoading(false);
      if (record === null || record.edits.length === 0) {
        loaded.current = true;
        return;
      }
      const same = record.baseJobId === jobId || record.billSignature === billSignature(bill.sections);
      if (!same) {
        // Ведомость изменилась: решает человек. Правки не применяются и не теряются, пока он не выбрал.
        setConflict({ record, remapped: remapEdits(record.edits, bill.sections) });
        loaded.current = true;
        return;
      }
      // Та же ведомость при другом задании: идентификаторы строк могли смениться, поэтому правки
      // находят строки заново (по наименованию и объёму), а запись переезжает на новое задание.
      const carried = record.baseJobId === jobId ? record.edits : remapEdits(record.edits, bill.sections).edits;
      setEdits(carried);
      loaded.current = true;
      if (record.baseJobId !== jobId) void persist(carried);
      await callRecalc(carried, jobId);
    })();
    return () => {
      cancelled = true;
    };
    // available/tenderId/jobId/bill задают «какой это расчёт»: пересчитывать надо при их смене.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, tenderId, jobId, bill]);

  // Сохранение правок: через паузу, а при закрытии экрана — сразу.
  const pendingSave = useRef(false);
  useEffect(() => {
    if (!loaded.current) return;
    pendingSave.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      pendingSave.current = false;
      void persist(edits);
    }, SAVE_DELAY_MS);
  }, [edits, persist]);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
        if (pendingSave.current) void persist(latest.current.edits);
      }
    },
    [persist],
  );

  const base = result;
  const sections = bill?.sections;
  const desired = useMemo(() => applyBillEdits(sections ?? [], edits), [sections, edits]);

  const effective = useMemo((): EstimateResultData | null => {
    if (base === null) return null;
    const response = applied.response;
    if (response === null) return base;
    // Показан пересчёт: документ и ведомость — его, а «не вошло» — по тем правкам, что в него вошли.
    const appliedEdits: BillEdit[] = JSON.parse(applied.key) as BillEdit[];
    return {
      ...base,
      document: response.document,
      bill: response.bill,
      billItems: response.billItems,
      rejected: remainingRejected(base.rejected, appliedEdits),
    };
  }, [base, applied]);

  const pendingIds = useMemo(() => {
    const appliedList: BillEdit[] = JSON.parse(applied.key) as BillEdit[];
    const was = new Map<string, string>();
    for (const edit of appliedList) was.set(`${edit.kind}:${editId(edit)}`, JSON.stringify(edit));
    const now = new Map<string, string>();
    for (const edit of edits) now.set(`${edit.kind}:${editId(edit)}`, JSON.stringify(edit));
    const ids = new Set<string>();
    for (const [key, value] of now) if (was.get(key) !== value) ids.add(key.slice(key.indexOf(":") + 1));
    for (const key of was.keys()) if (!now.has(key)) ids.add(key.slice(key.indexOf(":") + 1));
    return ids;
  }, [applied.key, edits]);

  const marks = useMemo(() => {
    const response = applied.response;
    if (response === null) return [];
    return response.applied.marks;
  }, [applied.response]);

  const diff = useMemo((): TotalsDiff | null => {
    const response = applied.response;
    if (base === null || response === null) return null;
    const before = base.document.totals;
    const after = response.document.totals;
    if (before.workCost === after.workCost && before.total === after.total) return null;
    return {
      before: { workCost: before.workCost, total: before.total },
      after: { workCost: after.workCost, total: after.total },
    };
  }, [base, applied.response]);

  const record = useCallback((edit: BillEdit): void => {
    setEdits((current) => recordEdit(current, edit));
  }, []);
  const clear = useCallback((itemId: string, kind: "change" | "norm" | "price" | "remove" | "coefficients" | "material", resourceCode?: string): void => {
    setEdits((current) => clearEdit(current, itemId, kind, resourceCode));
  }, []);
  const drop = useCallback((edit: BillEdit): void => {
    setEdits((current) => current.filter((item) => JSON.stringify(item) !== JSON.stringify(edit)));
  }, []);
  const resetAll = useCallback((): void => {
    setEdits([]);
    setApplied({ key: "[]", response: null });
    setNotice(null);
    setError(null);
  }, []);

  const recalc = useCallback(async (): Promise<void> => {
    if (typeof jobId !== "string") return;
    if (edits.length === 0) {
      setApplied({ key: "[]", response: null });
      setNotice(null);
      return;
    }
    await callRecalc(edits, jobId);
  }, [callRecalc, edits, jobId]);

  const applyConflict = useCallback(async (): Promise<void> => {
    if (conflict === null || typeof jobId !== "string") return;
    const next = conflict.remapped.edits;
    setConflict(null);
    setEdits(next);
    await persist(next);
    const ok = next.length > 0 ? await callRecalc(next, jobId) : true;
    if (ok) {
      const lost = conflict.remapped.unmatched.length;
      const skipped = conflict.remapped.alreadyPresent.length;
      const parts: string[] = [`Применено правок: ${String(next.length)}`];
      if (lost > 0) parts.push(`не нашли свою строку: ${String(lost)}`);
      if (skipped > 0) parts.push(`уже есть в новой ведомости: ${String(skipped)}`);
      setNotice(`${parts.join(", ")}.`);
    }
  }, [callRecalc, conflict, jobId, persist]);

  const discardConflict = useCallback((): void => {
    setConflict(null);
    void persist([]);
  }, [persist]);

  if (base === null || effective === null) return null;

  return {
    available,
    loading,
    edits,
    base,
    effective,
    desired,
    dirty: keyOf(edits) !== applied.key,
    pendingIds,
    recalculating,
    error,
    notice,
    conflict,
    marks,
    diff,
    place,
    record,
    clear,
    drop,
    resetAll,
    recalc,
    applyConflict,
    discardConflict,
  };
}

/** Правки словами для отчёта: по состоянию на показанный расчёт. */
export function marksOf(editor: BillEditor | null): { count: number; marks: readonly BillEditMark[] } | null {
  if (editor === null || editor.edits.length === 0 || editor.dirty) return null;
  const bill = editor.base.bill;
  if (bill === undefined) return null;
  const marks =
    editor.marks.length > 0
      ? editor.marks
      : describeBillEdits({ baseSections: bill.sections, edits: editor.edits });
  return { count: editor.edits.length, marks };
}
