import { billEditsRecordSchema, type BillEditsRecord } from "@/domain/estimate/billEdits";
import { readJsonOrThrow } from "@/lib/readJson";
import { readJSON, removeKey, writeJSON } from "@/lib/storage";

/**
 * Где лежат правки ведомости: за закупкой и пользователем.
 *
 * Вошедшему — на сервере, в данных аккаунта под ключом `bill-edits:<tenderId>`
 * (`/api/estimate/edits`): правки следуют за ним на другое устройство. Гостю, а также когда сервер
 * правки не принимает (сессия истекла, колонка app_state не создана) — на устройстве. Сбой связи
 * правку не теряет: она остаётся на устройстве, а следующее сохранение уйдёт на сервер.
 *
 * Серверная запись главнее: если на сервере что-то есть, устройство не спорит. Локальная запись,
 * пока сервера нет, переезжает на него при первом удачном сохранении и с устройства удаляется.
 */

export type EditsPlace = "server" | "device";

const localKey = (tenderId: string): string => `tf.billEdits:${tenderId}`;

function readLocal(tenderId: string): BillEditsRecord | null {
  const parsed = billEditsRecordSchema.safeParse(readJSON<unknown>(localKey(tenderId), null));
  return parsed.success ? parsed.data : null;
}

export const billEditsStore = {
  async load(tenderId: string): Promise<{ record: BillEditsRecord | null; place: EditsPlace }> {
    try {
      const response = await fetch(`/api/estimate/edits?tenderId=${encodeURIComponent(tenderId)}`);
      const payload = await readJsonOrThrow<{ record?: unknown }>(response);
      const parsed = billEditsRecordSchema.safeParse(payload.record);
      if (parsed.success) return { record: parsed.data, place: "server" };
      // На сервере правок нет: могли остаться на устройстве с тех пор, как человек не был вошёл.
      const local = readLocal(tenderId);
      return { record: local, place: local === null ? "server" : "device" };
    } catch {
      return { record: readLocal(tenderId), place: "device" };
    }
  },

  /** `null` — отбросить правки. Возвращает, где они в итоге лежат. */
  async save(tenderId: string, record: BillEditsRecord | null): Promise<EditsPlace> {
    try {
      const response = await fetch("/api/estimate/edits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenderId, record }),
      });
      await readJsonOrThrow<{ saved: boolean }>(response);
      removeKey(localKey(tenderId));
      return "server";
    } catch {
      if (record === null || record.edits.length === 0) removeKey(localKey(tenderId));
      else writeJSON(localKey(tenderId), record);
      return "device";
    }
  },
};
