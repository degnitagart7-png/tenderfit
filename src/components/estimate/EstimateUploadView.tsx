"use client";

import { useState, type ChangeEvent } from "react";
import { Calculator, FileText, X } from "lucide-react";

import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
} from "@/components/ui/primitives";
import { EstimateResult } from "@/components/estimate/EstimateResult";
import { useEstimateJob } from "@/hooks/useEstimateJob";
import { isUnreadableText, parseDocument } from "@/services/documentParser";
import { formatFileSize } from "@/utils/format";

/**
 * Расчёт сметы по своей документации.
 *
 * Зачем отдельный экран, когда кнопка есть в карточке закупки. Закупка нужна не
 * всегда: сметой проверяют своё коммерческое предложение, считают объект вне
 * торгов, пересчитывают чужую смету. Требовать ради этого завести закупку
 * значит заставить выдумать номер, которого нет.
 *
 * Файлы разбираются в браузере, а не отправляются целиком: документация
 * закупки — это десятки мегабайт, из которых серверу нужен только текст.
 * Разбор тот же самый, что у воркера, поэтому результат совпадает с тем, что
 * увидит карточка закупки.
 */

interface LoadedDocument {
  readonly name: string;
  readonly text: string;
  readonly size: number;
}

export function EstimateUploadView() {
  const [documents, setDocuments] = useState<LoadedDocument[]>([]);
  const [subject, setSubject] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useEstimateJob();
  const calculating = job.status === "queued" || job.status === "running";

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    if (files.length === 0) return;

    setReading(true);
    setError(null);
    const loaded: LoadedDocument[] = [];
    const failed: string[] = [];

    for (const file of files) {
      try {
        const parsed = await parseDocument(file);
        /*
          Разбор не бросает исключение: он возвращает объяснение в поле текста.
          Отправить такое объяснение на сервер значит получить смету на ноль
          рублей, которая выглядит как настоящая, — поэтому нечитаемый файл
          попадает в список неудач, а не в расчёт.
        */
        if (isUnreadableText(parsed.text)) {
          failed.push(`${file.name}: ${parsed.text.trim()}`);
          continue;
        }
        if (parsed.text.trim().length === 0) {
          failed.push(`${file.name}: текста не нашлось`);
          continue;
        }
        loaded.push({ name: file.name, text: parsed.text, size: file.size });
      } catch (err) {
        failed.push(
          `${file.name}: ${err instanceof Error ? err.message : "не читается"}`,
        );
      }
    }

    setDocuments((current) => [...current, ...loaded]);
    if (failed.length > 0) setError(`Не прочитано — ${failed.join("; ")}`);
    setReading(false);
    // Сбрасываем input, иначе тот же файл второй раз не выберется.
    event.target.value = "";
  };

  const calculate = async (): Promise<void> => {
    setError(null);
    await job.start({
      subject: subject.trim() === "" ? "Расчёт по документации" : subject,
      documents: documents.map((item) => ({
        name: item.name,
        text: item.text,
      })),
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Расчёт сметы</h1>
        <p className="text-sm text-muted-foreground">
          Загрузите ведомость объёмов работ, техническое задание или смету
          заказчика. Объёмы извлекаются из текста, стоимость считается
          ресурсно-индексным методом по ФСНБ-2022.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <Field label="Наименование объекта" hint="Печатается в шапке сметы">
          <Input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Реконструкция запорных колодцев"
          />
        </Field>

        <div>
          <label className="mb-1 block text-sm font-medium">Документы</label>
          <input
            type="file"
            multiple
            accept=".pdf,.docx,.doc,.csv,.txt"
            onChange={(event) => void addFiles(event)}
            disabled={reading}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
          />
          <p className="muted mt-1 text-xs">
            PDF, Word, CSV. Файлы читаются в браузере — на сервер уходит только
            текст.
          </p>
        </div>

        {documents.length > 0 && (
          <ul className="space-y-1">
            {documents.map((item, index) => (
              <li
                key={`${item.name}-${String(index)}`}
                className="flex items-center gap-2 text-sm"
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="muted text-xs">
                  {formatFileSize(item.size)} ·{" "}
                  {item.text.length.toLocaleString("ru-RU")} знаков
                </span>
                <button
                  type="button"
                  aria-label={`Убрать ${item.name}`}
                  onClick={() =>
                    setDocuments((current) =>
                      current.filter((_, at) => at !== index),
                    )
                  }
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <Button
          onClick={() => void calculate()}
          disabled={documents.length === 0 || calculating || reading}
          className="gap-1.5"
        >
          <Calculator className="h-4 w-4" />
          {calculating ? "Читаем ведомость..." : "Рассчитать смету"}
        </Button>

        {calculating && (
          <p className="muted text-sm">
            {job.status === "queued"
              ? "Расчёт в очереди — его заберёт сервер с базой нормативов."
              : "Сервер читает ведомость объёмов и считает смету."}
          </p>
        )}
        {error !== null && <p className="text-sm text-brick-fg">{error}</p>}
        {job.error !== null && (
          <p className="text-sm text-brick-fg">{job.error}</p>
        )}
      </Card>

      {job.result === null ? (
        <EmptyState
          title="Сметы пока нет"
          description="Добавьте документы и нажмите «Рассчитать смету». Разбор идёт минутами: модель читает документацию фрагментами."
        />
      ) : (
        <EstimateResult data={job.result} regNumber={subject || "расчёт"} />
      )}
    </div>
  );
}
