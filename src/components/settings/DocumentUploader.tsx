"use client";

import { useRef, useState } from "react";
import { Upload, FileText, X } from "lucide-react";
import type { CompanyDocument } from "@/domain/entities";
import { COMPANY_DOCUMENT_CATEGORY_LABELS } from "@/domain/companyFacts/types";
import { guessDocumentCategory } from "@/domain/companyFacts/guessCategory";
import { Button } from "@/components/ui/primitives";
import { formatFileSize } from "@/services/documentParser";
import { isUnreadableText } from "@/services/documentParser";
import { parseDocumentSmart } from "@/services/serverDocumentParse";

/** Подписи берутся из домена фактов: там же решается, как категория влияет на разбор (прайс — отдельным запросом и т. д.). */
const categoryLabels = COMPANY_DOCUMENT_CATEGORY_LABELS;

const CATEGORY_ORDER: readonly CompanyDocument["category"][] = ["price", "experience", "sro", "license", "staff", "equipment", "financial", "other"];

const categoryOptions: { value: CompanyDocument["category"]; label: string }[] = CATEGORY_ORDER.map((value) => ({
  value,
  label: categoryLabels[value],
}));

interface DocumentUploaderProps {
  documents: CompanyDocument[];
  onChange: (documents: CompanyDocument[]) => void;
}

/** Компонент загрузки и управления документами компании. */
export function DocumentUploader({ documents, onChange }: DocumentUploaderProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** «auto» — категория определяется по названию файла (прайс, реестр, СРО…); остальное — выбор человека для всех добавляемых файлов. */
  const [selectedCategory, setSelectedCategory] = useState<"auto" | CompanyDocument["category"]>("auto");

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    setError(null);

    const newDocs: CompanyDocument[] = [];

    for (const file of Array.from(files)) {
      const ext = file.name.toLowerCase().split(".").pop() ?? "";
      if (!["pdf", "docx", "doc", "csv", "xlsx", "xls", "odt", "ods", "rtf"].includes(ext)) {
        setError(`Файл "${file.name}" имеет неподдерживаемый формат. Допустимы: PDF, Word, Excel, OpenOffice (odt, ods), RTF, CSV`);
        continue;
      }

      try {
        const parsed = await parseDocumentSmart(file);
        // Причина вместо содержимого («[Ошибка парсинга: …]») — не текст документа: в
        // профиле компании она ушла бы в модель как описание опыта и лицензий.
        if (isUnreadableText(parsed.text)) {
          setError(`Не удалось прочитать "${file.name}": ${parsed.text.trim().replace(/^\[|\]$/g, "")}`);
          continue;
        }
        const doc: CompanyDocument = {
          id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          fileName: parsed.fileName,
          fileType: parsed.fileType,
          size: parsed.size,
          uploadedAt: new Date().toISOString(),
          text: parsed.text,
          pageCount: parsed.pageCount,
          category: selectedCategory === "auto" ? guessDocumentCategory(file.name) : selectedCategory,
        };
        newDocs.push(doc);
      } catch (err) {
        setError(`Ошибка загрузки "${file.name}": ${err instanceof Error ? err.message : "неизвестная ошибка"}`);
      }
    }

    if (newDocs.length > 0) {
      onChange([...documents, ...newDocs]);
    }

    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const removeDocument = (id: string) => {
    onChange(documents.filter((d) => d.id !== id));
  };

  const updateCategory = (id: string, category: CompanyDocument["category"]) => {
    onChange(
      documents.map((d) => (d.id === id ? { ...d, category } : d)),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.doc,.csv,.xlsx,.xls,.odt,.ods,.rtf"
          multiple
          className="hidden"
          onChange={handleUpload}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          <Upload className="h-4 w-4" />
          {uploading ? "Загрузка…" : "Добавить файлы"}
        </Button>
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value as "auto" | CompanyDocument["category"])}
          className="rounded-md border border-border bg-panel px-2 py-1.5 text-[13.5px] text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="auto">Определить по названию</option>
          {categoryOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="text-[12.5px] text-muted-foreground">
          PDF, Word, Excel, CSV
        </span>
      </div>

      {error && (
        <p className="text-[13.5px] text-brick-fg">{error}</p>
      )}

      {documents.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          Документы не загружены. Добавьте прайс-лист, реестр контрактов, свидетельства СРО, лицензии или другие документы.
        </p>
      ) : (
        <ul className="space-y-2">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="rounded-md border border-border bg-panel p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5 min-w-0">
                  <FileText className="h-4 w-4 text-accent shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-[14.5px] font-medium text-foreground truncate">
                      {doc.fileName}
                    </p>
                    <p className="text-[12.5px] text-muted-foreground mt-0.5">
                      {formatFileSize(doc.size)}
                      {doc.pageCount ? ` · ${doc.pageCount} стр.` : ""}
                      {` · ${categoryLabels[doc.category]}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={doc.category}
                    onChange={(e) => updateCategory(doc.id, e.target.value as CompanyDocument["category"])}
                    className="rounded-md border border-border bg-panel px-2 py-1 text-[12.5px] text-foreground focus:border-accent focus:outline-none"
                  >
                    {categoryOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeDocument(doc.id)}
                    className="p-1 rounded hover:bg-panel-raised text-muted-foreground hover:text-foreground"
                    aria-label="Удалить документ"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {doc.text && (
                <details className="mt-2">
                  <summary className="text-[12.5px] text-accent-fg cursor-pointer hover:underline">
                    Показать содержимое
                  </summary>
                  <pre className="mt-2 text-[12.5px] text-muted-foreground bg-panel-raised rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap">
                    {doc.text.slice(0, 2000)}
                    {doc.text.length > 2000 && "\n\n... (обрезано)"}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
