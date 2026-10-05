"use client";

import { useEffect, useState } from "react";

import { Button, Card, Field, Input } from "@/components/ui/primitives";
import type { SearchProfile } from "@/domain/entities";
import { toServerProfiles } from "@/domain/syncProfiles";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { describeError } from "@/lib/errors";
import { syncProfilesApiService } from "@/services/syncProfilesApiService";

const TOKEN_KEY = "tenderfit.adminToken";

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Память браузера недоступна: ключ придётся ввести снова, отправке это не мешает.
  }
}

/** Куда пойдёт сбор: регионы названы, чтобы «вся Россия» не получилась молча. */
function regionsNote(sent: ReadonlyArray<{ name: string; regions: string[] }>): string {
  const parts = sent.map((p) => `«${p.name}» — ${p.regions.length > 0 ? p.regions.join(", ") : "вся Россия"}`);
  return ` Регионы сбора: ${parts.join("; ")}.`;
}

/**
 * Отправка профилей владельца на сервер (раздел администрирования).
 *
 * Профили владельца собираются всегда, спрос посетителей добавляется к ним.
 * Сборщик берёт слова, законы и границы цены. Отправка закрыта ключом владельца,
 * и без ключа посетитель не мог бы подменить закреплённые темы сбора.
 */
export function ServerProfilesCard({ profiles }: { profiles: readonly SearchProfile[] }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    setToken(readToken());
  }, []);

  const priority = companyProfileRepository.get().preferences.priorityRegions.filter((r) => r.trim() !== "");
  const { profiles: toSend, skipped } = toServerProfiles(profiles, priority);
  const canSend = token.trim() !== "" && toSend.length > 0 && !busy;

  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const saved = await syncProfilesApiService.push(token.trim(), toSend);
      rememberToken(token.trim());
      const tail =
        skipped.length > 0 ? ` Не отправлены (нет ключевых слов): ${skipped.join(", ")}.` : "";
      setResult({
        kind: "ok",
        text: `Отправлено профилей: ${String(saved)}. Сервер соберёт по ним закупки при ближайшем плановом прогоне.${regionsNote(toSend)}${tail}`,
      });
    } catch (error) {
      setResult({ kind: "error", text: describeError(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Сбор закупок на сервере">
      <p className="text-sm text-muted-foreground">
        Темы, которые сервер собирает всегда, независимо от того, кто заходит на сайт. Сверх них
        он собирает темы посетителей. Пока вы ничего не отправили, а посетителей нет, сервер
        собирает три заготовленные темы: автомобили, компьютеры и стройку.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <Field label="Ключ владельца" hint="Задаётся администратором сервера (ADMIN_TOKEN).">
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        <Button onClick={() => void send()} disabled={!canSend}>
          {busy ? "Отправляю…" : "Отправить на сервер"}
        </Button>
      </div>
      {result && (
        <p
          role="status"
          className={`mt-3 text-sm ${result.kind === "ok" ? "text-olive-fg" : "text-mustard-fg"}`}
        >
          {result.text}
        </p>
      )}
    </Card>
  );
}
