"use client";

import { useRef, useState } from "react";
import { Upload, FileText, X } from "lucide-react";
import type { CompanyDocument } from "@/domain/entities";
import { Button } from "@/components/ui/primitives";
import { parseDocument, formatFileSize } from "@/services/documentParser";

const categoryLabels: Record<CompanyDocument["category"], string> = {
  license: "Лицензия",
  sro: "СРО",
  experience: "Опыт",
  financial: "Финансовый документ",
  other: "Другое",
};

const categoryOptions: { value: CompanyDocument["category"]; label: string }[] = [
  { value: "license", label: "Лицензия" },
  { value: "sro", label: "СРО" },
  { value: "experience", label: "Опыт" },
  { value: "financial", label: "Финансовый документ" },
  { value: "other", label: "Другое" },
];

interface DocumentUploaderProps {
  documents: CompanyDocument[];
  onChange: (documents: CompanyDocument[]) => void;
}

/** Компонент загрузки и управления документами компании. */
export function DocumentUploader({ documents, onChange }: DocumentUploaderProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<CompanyDocument["category"]>("other");

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    setError(null);

    const newDocs: CompanyDocument[] = [];

    for (const file of Array.from(files)) {
      const ext = file.name.toLowerCase().split(".").pop() ?? "";
      if (!["pdf", "docx", "doc", "csv"].includes(ext)) {
        setError(`Файл "${file.name}" имеет неподдерживаемый формат. Допустимы: PDF, Word, CSV`);
        continue;
      }

      try {
        const parsed = await parseDocument(file);
        const doc: CompanyDocument = {
          id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          fileName: parsed.fileName,
          fileType: parsed.fileType,
          size: parsed.size,
          uploadedAt: new Date().toISOString(),
          text: parsed.text,
          pageCount: parsed.pageCount,
          category: selectedCategory,
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
          accept=".pdf,.docx,.doc,.csv"
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
          onChange={(e) => setSelectedCategory(e.target.value as CompanyDocument["category"])}
          className="rounded-md border border-border bg-panel px-2 py-1.5 text-[13.5px] text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {categoryOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="text-[12.5px] text-muted-foreground">
          PDF, Word, CSV
        </span>
      </div>

      {error && (
        <p className="text-[13.5px] text-brick-fg">{error}</p>
      )}

      {documents.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">
          Документы не загружены. Добавьте лицензии, свидетельства СРО, контракты или другие документы.
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
