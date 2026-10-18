"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DigestSettings } from "@/domain/entities";
import { TIME_ZONE_OPTIONS, isValidTimeZone, normalizeSendTime, timeZoneOption } from "@/domain/digestSettings";
import { settingsRepository, defaultDigestSettings } from "@/repositories/settingsRepository";
import { accountApiService } from "@/services/accountApiService";
import { notificationApiService } from "@/services/notificationApiService";
import { Button, Card, Checkbox, Field, Input, Select } from "@/components/ui/primitives";

/**
 * Настройки уведомлений: утренняя сводка и письмо «готов анализ или смета».
 *
 * Оба письма включены по умолчанию, и каждый отключает их у себя. Письма идут на почту аккаунта,
 * время и часовой пояс — клиента: утром по его часам, а не по серверным. Пояс берётся из браузера
 * и сохраняется при первом открытии (см. `settingsRepository.ensureTimeZone`); человек может его
 * сменить. Настройки лежат на устройстве и уходят в аккаунт сами (автоотправка), воркер читает их
 * оттуда.
 */

/** Часы утренней сводки: с 06:00 до 12:00 с шагом час. */
const SEND_TIMES = ["06:00", "07:00", "08:00", "09:00", "10:00", "11:00", "12:00"];

export default function SettingsNotificationsPage() {
  const [settings, setSettings] = useState<DigestSettings>(defaultDigestSettings);
  const [saved, setSaved] = useState(false);
  /** Почта аккаунта; null — не вошли (или вход не настроен). */
  const [email, setEmail] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    // Пояс браузера запоминается при первом открытии: без него письма шли бы по Москве.
    settingsRepository.ensureTimeZone();
    setSettings(settingsRepository.get());
    let cancelled = false;
    void accountApiService
      .me()
      .then((state) => {
        if (!cancelled) setEmail(state.user?.email ?? null);
      })
      .catch(() => {
        // Сервер не ответил: страница работает без адреса, письма отправить нельзя.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (p: Partial<DigestSettings>) => {
    setSettings((s) => ({ ...s, ...p }));
    setSaved(false);
  };

  const save = () => {
    settingsRepository.save(settings);
    setSaved(true);
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await notificationApiService.sendTestDigest();
      setTestResult(
        result.sent
          ? { ok: true, text: `Письмо отправлено на ${email ?? "вашу почту"}, строк в нём: ${String(result.items)}.` }
          : { ok: false, text: result.reason ?? "Письмо не отправлено." },
      );
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : "Письмо не отправлено." });
    } finally {
      setTesting(false);
    }
  };

  const timeZone = isValidTimeZone(settings.timeZone) ? settings.timeZone : null;
  const zoneOption = timeZone === null ? null : timeZoneOption(timeZone);
  const selectedZone = zoneOption?.value ?? timeZone ?? "";
  const sendTime = normalizeSendTime(settings.sendTime) ?? "08:00";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Уведомления</h1>
        <div className="flex items-center gap-2">
          {saved && <span className="text-sm text-olive-fg">Сохранено</span>}
          <Button onClick={save}>Сохранить</Button>
        </div>
      </div>

      <Card title="Утренняя сводка">
        <div className="space-y-4">
          <p className="text-[14.5px] text-muted-foreground">
            Раз в день на почту: новые закупки по вашему профилю, что закрывается в ближайшие 48 часов и что у вас в работе.
          </p>
          <Checkbox
            checked={settings.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            label={`Присылать сводку на ${email ?? "почту аккаунта"}`}
          />
          {email === null && (
            <p className="muted">
              Письма приходят на почту аккаунта.{" "}
              <Link href="/login" className="text-accent-fg hover:underline">
                Войдите
              </Link>
              , чтобы их получать.
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Время">
              <Select
                value={sendTime}
                disabled={!settings.enabled}
                onChange={(e) => patch({ sendTime: e.target.value })}
              >
                {!SEND_TIMES.includes(sendTime) && <option value={sendTime}>{sendTime}</option>}
                {SEND_TIMES.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Часовой пояс">
              <Select
                value={selectedZone}
                disabled={!settings.enabled}
                onChange={(e) => patch({ timeZone: e.target.value })}
              >
                {timeZone === null && <option value="">Определяется…</option>}
                {timeZone !== null && zoneOption === null && <option value={timeZone}>{timeZone}</option>}
                {TIME_ZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Минимальная оценка соответствия" hint="От 0 до 100. Закупки с оценкой ниже в сводку не попадут.">
              <Input
                type="number"
                min={0}
                max={100}
                value={String(settings.minFitScore)}
                disabled={!settings.enabled}
                onChange={(e) => patch({ minFitScore: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => void sendTest()} loading={testing} disabled={email === null}>
              Прислать пробную сводку сейчас
            </Button>
            <Link href="/reports/daily" className="text-[14.5px] text-accent-fg hover:underline">
              Открыть отчёт
            </Link>
          </div>
          {testResult !== null && (
            <p role="status" className={testResult.ok ? "text-sm text-olive-fg" : "text-sm text-muted-foreground"}>
              {testResult.text}
            </p>
          )}
          <p className="muted">Пробная сводка собирается по сохранённым настройкам и не отменяет утреннюю.</p>
        </div>
      </Card>

      <Card title="Готов анализ или смета">
        <div className="space-y-3">
          <Checkbox
            checked={settings.readyEnabled !== false}
            onChange={(e) => patch({ readyEnabled: e.target.checked })}
            label="Писать, когда глубокий анализ или смета готовы"
          />
          <p className="muted">Письмо придёт, если расчёт шёл дольше двух минут — чтобы не ждать на странице.</p>
        </div>
      </Card>
    </div>
  );
}
