"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { DigestSettings } from "@/domain/entities";
import { settingsRepository, defaultDigestSettings } from "@/repositories/settingsRepository";
import { Button, Card, Field, Input } from "@/components/ui/primitives";

/**
 * Настройки уведомлений.
 *
 * Доставка не подключена: ни письма, ни сообщения в Telegram приложение не
 * отправляет. Поэтому на странице оставлен только тот параметр, который
 * действительно на что-то влияет (порог попадания в отчёт), а время отправки,
 * адрес и подписки убраны — они создавали вид работающей доставки.
 * Вернутся, когда появится настоящий провайдер уведомлений.
 */
export default function SettingsNotificationsPage() {
  const [settings, setSettings] = useState<DigestSettings>(defaultDigestSettings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSettings(settingsRepository.get());
  }, []);

  const patch = (p: Partial<DigestSettings>) => {
    setSettings((s) => ({ ...s, ...p }));
    setSaved(false);
  };

  const save = () => {
    settingsRepository.save(settings);
    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Уведомления</h1>
        <div className="flex items-center gap-2">
          {saved && <span className="text-sm text-olive-fg">Сохранено</span>}
          <Button onClick={save}>Сохранить</Button>
        </div>
      </div>

      <Card title="Что попадает в отчёт">
        <div className="space-y-3">
          <Field
            label="Минимальная оценка соответствия"
            hint="От 0 до 100. Закупки с более низкой оценкой в отчёт не попадут — они останутся в общем списке с причиной отказа."
          >
            <Input
              type="number"
              min={0}
              max={100}
              className="w-40"
              value={String(settings.minFitScore)}
              onChange={(e) => patch({ minFitScore: Number(e.target.value) || 0 })}
            />
          </Field>
          <p className="text-[14.5px] text-muted-foreground">
            Отчёт собирается сразу и доступен на странице{" "}
            <Link href="/reports/daily" className="text-accent-fg hover:underline">
              «Отчёты»
            </Link>
            .
          </p>
        </div>
      </Card>

      <Card title="Почта и Telegram">
        <p className="text-[14.5px] text-muted-foreground">
          Доставка не подключена: отчёт никуда не отправляется, смотреть его можно только
          внутри приложения. Когда отправку подключим, здесь появятся время отправки, адрес
          и подписки — на срочные закупки и на изменения документации.
        </p>
      </Card>
    </div>
  );
}
