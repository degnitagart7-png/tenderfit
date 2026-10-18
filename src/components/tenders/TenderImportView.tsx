"use client";

import { AddTenderByLink } from "@/components/tenders/AddTenderByLink";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileDown, Trash2, Upload } from "lucide-react";
import type { ImportedTender, PlacingWay, TenderLaw } from "@/domain/entities";
import { UNKNOWN_CUSTOMER, UNKNOWN_REGION } from "@/domain/entities";
import { parseTendersCsv } from "@/domain/tenderImport";
import { importedTendersRepository } from "@/repositories/importedTendersRepository";
import { jobsRepository } from "@/repositories/jobsRepository";
import { Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { lawLabels, placingWayLabels } from "@/lib/labels";
import { formatDate, formatTenderPrice } from "@/utils/format";

const CSV_TEMPLATE = [
  "Реестровый номер;Закон;Предмет;Заказчик;ИНН заказчика;Регион;НМЦК;Способ определения;ОКПД2;Окончание подачи;Срок поставки, дн.;Текст документации",
  "0173200000126000001;44-ФЗ;Поставка ноутбуков для офиса;ГБУ «Центр»;7701234567;Москва;1 500 000;Электронный аукцион;26.20.11;31.10.2026;20;Поставка ноутбуков, требования к характеристикам в приложении.",
].join("\n");

function emptyManual() {
  return {
    regNumber: "",
    law: "FZ_44" as TenderLaw,
    placingWay: "ELECTRONIC_AUCTION" as PlacingWay,
    subject: "",
    customerName: "",
    region: "",
    price: "",
    okpd2Codes: "",
    submissionEnd: "",
    deliveryTermDays: "",
    documentsText: "",
  };
}

export function TenderImportView() {
  const [csv, setCsv] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportedTender[]>([]);
  const [manual, setManual] = useState(emptyManual());
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => setImported(importedTendersRepository.getAll());
  useEffect(refresh, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const importCsv = () => {
    const res = parseTendersCsv(csv);
    setErrors(res.errors.map((e) => `Строка ${e.line}: ${e.message}`));
    if (res.rows.length === 0) {
      if (res.errors.length === 0) setErrors(["CSV не содержит строк данных"]);
      return;
    }
    const { added, skipped } = importedTendersRepository.addMany(res.rows);
    jobsRepository.add("TENDER_IMPORT", `Импортировано из CSV: ${added}`);
    refresh();
    setCsv("");
    setNotice(
      `Импортировано ${added} закуп${added === 1 ? "ка" : added < 5 ? "ки" : "ок"}${skipped > 0 ? `, пропущено дублей: ${skipped}` : ""}.`,
    );
  };

  const importManual = () => {
    const nextErrors: string[] = [];
    if (manual.regNumber.trim().length < 5) nextErrors.push("Укажите реестровый номер");
    if (manual.subject.trim().length < 5) nextErrors.push("Укажите предмет закупки");
    const price = Number(manual.price.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(price) || price <= 0) nextErrors.push("Укажите корректную НМЦК");
    if (!manual.submissionEnd) nextErrors.push("Укажите дату окончания подачи");
    setErrors(nextErrors);
    if (nextErrors.length > 0) return;
    const draft: ImportedTender = {
      id: `imp-${manual.regNumber.trim()}`,
      regNumber: manual.regNumber.trim(),
      law: manual.law,
      placingWay: manual.placingWay,
      subject: manual.subject.trim(),
      customerName: manual.customerName.trim() || UNKNOWN_CUSTOMER,
      customerInn: null,
      region: manual.region.trim() || UNKNOWN_REGION,
      price,
      okpd2Codes: manual.okpd2Codes
        .split(/[,;]+/)
        .map((c) => c.trim())
        .filter(Boolean),
      submissionEnd: new Date(manual.submissionEnd).toISOString(),
      deliveryTermDays: manual.deliveryTermDays ? Number(manual.deliveryTermDays) : null,
      documentsText: manual.documentsText.trim(),
      importedAt: new Date().toISOString(),
      source: "MANUAL",
    };
    const { added, skipped } = importedTendersRepository.addMany([draft]);
    jobsRepository.add("TENDER_IMPORT", `Ручной импорт: ${draft.regNumber}`);
    setManual(emptyManual());
    refresh();
    setNotice(
      added === 1
        ? "Закупка добавлена и уже проходит анализ наравне с базой."
        : `Такая закупка уже импортирована (пропущено: ${skipped}).`,
    );
  };

  const removeRow = (id: string) => {
    importedTendersRepository.remove(id);
    refresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Добавить закупку</h1>
          <p className="muted mt-1">
            Проще всего — по ссылке из ЕИС: документы и анализ подтянутся сами. Ниже — ручной ввод и CSV для закупок,
            которых в ЕИС нет.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setCsv(CSV_TEMPLATE)}>
          <FileDown className="h-4 w-4" /> Подставить шаблон CSV
        </Button>
      </div>

      <AddTenderByLink />

      {notice && (
        <div
          role="status"
          className="rounded-md border border-olive/40 bg-olive/10 px-3 py-2 text-sm text-olive-fg"
        >
          {notice}
        </div>
      )}
      {errors.length > 0 && (
        <div
          role="alert"
          className="rounded-md border border-brick/40 bg-brick/10 px-3 py-2 text-sm text-brick-fg"
        >
          <ul className="list-disc pl-5 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Импорт из CSV" actions={<Badge tone="accent">; или ,</Badge>}>
          <Textarea
            rows={6}
            value={csv}
            placeholder="Вставьте строки CSV: заголовки на русском, разделитель «;» или «,». Обязательны реестровый номер, предмет и НМЦК."
            onChange={(e) => setCsv(e.target.value)}
          />
          <div className="mt-3 flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => setCsv(String(reader.result ?? ""));
                reader.readAsText(f, "utf-8");
                e.target.value = "";
              }}
            />
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Выбрать файл…
            </Button>
            <Button size="sm" onClick={importCsv} disabled={csv.trim().length === 0}>
              Импортировать
            </Button>
          </div>
        </Card>

        <Card title="Добавить одну закупку вручную">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Реестровый номер">
              <Input
                value={manual.regNumber}
                onChange={(e) => setManual({ ...manual, regNumber: e.target.value })}
                placeholder="0173200000126000001"
              />
            </Field>
            <Field label="Закон">
              <Select
                value={manual.law}
                onChange={(e) => setManual({ ...manual, law: e.target.value as TenderLaw })}
              >
                {(Object.keys(lawLabels) as TenderLaw[]).map((l) => (
                  <option key={l} value={l}>
                    {lawLabels[l]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Способ определения">
              <Select
                value={manual.placingWay}
                onChange={(e) => setManual({ ...manual, placingWay: e.target.value as PlacingWay })}
              >
                {(Object.keys(placingWayLabels) as PlacingWay[]).map((pw) => (
                  <option key={pw} value={pw}>
                    {placingWayLabels[pw]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Предмет закупки">
                <Input
                  value={manual.subject}
                  onChange={(e) => setManual({ ...manual, subject: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Заказчик">
              <Input
                value={manual.customerName}
                onChange={(e) => setManual({ ...manual, customerName: e.target.value })}
              />
            </Field>
            <Field label="Регион">
              <Input
                value={manual.region}
                onChange={(e) => setManual({ ...manual, region: e.target.value })}
              />
            </Field>
            <Field label="НМЦК, ₽">
              <Input
                value={manual.price}
                inputMode="numeric"
                onChange={(e) => setManual({ ...manual, price: e.target.value })}
              />
            </Field>
            <Field label="ОКПД2 (через запятую)">
              <Input
                value={manual.okpd2Codes}
                onChange={(e) => setManual({ ...manual, okpd2Codes: e.target.value })}
                placeholder="26.20.11, 28.23"
              />
            </Field>
            <Field label="Окончание подачи">
              <Input
                type="date"
                value={manual.submissionEnd}
                onChange={(e) => setManual({ ...manual, submissionEnd: e.target.value })}
              />
            </Field>
            <Field label="Срок поставки, дн.">
              <Input
                type="number"
                min={0}
                value={manual.deliveryTermDays}
                onChange={(e) => setManual({ ...manual, deliveryTermDays: e.target.value })}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Текст документации (для разбора рисков и характеристик)">
                <Textarea
                  rows={3}
                  value={manual.documentsText}
                  onChange={(e) => setManual({ ...manual, documentsText: e.target.value })}
                  placeholder="Вставьте ключевые фрагменты ТЗ и проекта контракта…"
                />
              </Field>
            </div>
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={importManual}>
              Добавить закупку
            </Button>
          </div>
        </Card>
      </div>

      <Card title="Добавленные закупки" actions={<span className="muted">{imported.length}</span>}>
        {imported.length === 0 ? (
          <p className="muted">
            Пока пусто. Закупки хранятся только в этом браузере.
          </p>
        ) : (
          <ul className="space-y-2">
            {imported.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <Link
                    href={`/tenders/${t.id}`}
                    className="font-medium text-foreground hover:text-accent-fg line-clamp-1"
                  >
                    {t.subject}
                  </Link>
                  <p className="muted text-xs mt-0.5">
                    № {t.regNumber} · {lawLabels[t.law]} · {t.region} ·{" "}
                    {formatTenderPrice(t.price)} · подача до {formatDate(t.submissionEnd)} ·{" "}
                    {t.source === "CSV" ? "CSV" : "вручную"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone="mustard">Импорт</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Удалить закупку ${t.regNumber}`}
                    onClick={() => removeRow(t.id)}
                  >
                    <Trash2 className="h-4 w-4 text-brick-fg" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
