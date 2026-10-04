"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import type {
  CompanyProfile,
  DigestSettings,
  ExperienceRecord,
  License,
  SroMembership,
  StaffComposition,
} from "@/domain/entities";
import {
  SRO_KINDS,
  SRO_KIND_LABELS,
  SRO_LEVEL_LIMITS,
  sroLevelLimit,
  type SroKind,
} from "@/domain/enums";
import { effectiveSroLimit } from "@/domain/scoring/admission";
import { innSchema } from "@/domain/schemas";
import { demoCompanyProfile } from "@/mocks/companyProfile";
import { companyProfileRepository, normalizeSavedProfile } from "@/repositories/companyProfileRepository";
import { settingsRepository } from "@/repositories/settingsRepository";
import { readJSON, writeJSON, removeKey, STORAGE_KEYS } from "@/lib/storage";
import {
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  ProgressBar,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { TagListInput } from "@/components/onboarding/TagListInput";
import { ProfileAuditNotice } from "@/components/settings/ProfileAuditNotice";
import { formatCurrency } from "@/utils/format";

/* ============================== Схемы валидации ============================== */

const companySchema = z.object({
  legalName: z.string().min(2, "Укажите название компании"),
  inn: innSchema,
  legalForm: z.enum(["IP", "OOO", "AO", "OTHER"]),
  taxSystem: z.enum(["OSNO", "USN_INCOME", "USN_INCOME_EXPENSES", "PATENT"]),
  activityDescription: z.string().min(10, "Опишите деятельность (минимум 10 символов)"),
});

const financeSchema = z
  .object({
    minPrice: z.number().min(0),
    maxPrice: z.number().min(0),
    maxPaymentTermDays: z.number().int().min(0),
    minDeliveryTermDays: z.number().int().min(0),
    maxBidSecurity: z.number().min(0),
    maxContractSecurity: z.number().min(0),
    minMarginPercent: z.number().min(0).max(100),
  })
  .refine((v) => v.minPrice <= v.maxPrice, {
    message: "Минимальная цена не может превышать максимальную",
    path: ["minPrice"],
  });

const digestSchema = z.object({
  email: z.string().email("Некорректный email"),
  sendTime: z.string().regex(/^\d{2}:\d{2}$/, "Формат времени ЧЧ:ММ"),
  minFitScore: z.number().int().min(0).max(100),
});

/* ============================== Шаги ============================== */

const STEPS = [
  "Сведения о компании",
  "Направления деятельности",
  "География и заказчики",
  "Финансовые ограничения",
  "Лицензии и допуски",
  "Опыт исполнения",
  "Ключевые и стоп-слова",
  "Первый ежедневный отчёт",
  "Итоговая проверка",
] as const;

interface Draft {
  step: number;
  profile: CompanyProfile;
  digest: DigestSettings;
}

export const legalFormLabels: Record<CompanyProfile["legalForm"], string> = {
  IP: "ИП",
  OOO: "ООО",
  AO: "АО",
  OTHER: "Иная форма",
};

export const taxSystemLabels: Record<CompanyProfile["taxSystem"], string> = {
  OSNO: "ОСНО",
  USN_INCOME: "УСН «Доходы»",
  USN_INCOME_EXPENSES: "УСН «Доходы минус расходы»",
  PATENT: "Патент",
};

/* ============================== Вспомогательные компоненты ============================== */

/**
 * Числовое поле профиля.
 *
 * `unlimitedAt` — величина, которой схема выражает «ограничения нет»: поля
 * ограничений не допускают `null`, и предел приходится записывать заведомо
 * недостижимым числом. Показывать его как есть нельзя — в поле «Цена до»
 * стояло бы 1000000000000, и человек читал бы это как заданный им потолок.
 * Поэтому такое значение рисуется пустым полем, а очищенное поле его и
 * возвращает: пусто значит «не ограничиваю».
 */
export function NumField({
  label,
  value,
  onChange,
  suffix,
  error,
  min = 0,
  unlimitedAt,
  placeholder,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  suffix?: string;
  error?: string;
  min?: number;
  unlimitedAt?: number;
  placeholder?: string;
}) {
  const isUnlimited = unlimitedAt !== undefined && value === unlimitedAt;
  return (
    <Field label={suffix ? `${label}, ${suffix}` : label} error={error}>
      <Input
        type="number"
        min={min}
        placeholder={
          placeholder ?? (unlimitedAt === undefined ? undefined : "без ограничения")
        }
        value={isUnlimited ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "" && unlimitedAt !== undefined) {
            onChange(unlimitedAt);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : 0);
        }}
      />
    </Field>
  );
}

export function LicenseEditor({
  licenses,
  onChange,
}: {
  licenses: License[];
  onChange: (next: License[]) => void;
}) {
  const [kind, setKind] = useState("");
  const [number, setNumber] = useState("");
  const [issuer, setIssuer] = useState("");
  const [validUntil, setValidUntil] = useState("");

  const add = () => {
    if (!kind.trim() || !number.trim()) return;
    onChange([
      ...licenses,
      {
        id: `lic-${Date.now()}`,
        kind: kind.trim(),
        number: number.trim(),
        issuer: issuer.trim() || "Не указан",
        validUntil: validUntil || null,
        confirmed: true,
      },
    ]);
    setKind("");
    setNumber("");
    setIssuer("");
    setValidUntil("");
  };

  return (
    <div className="space-y-3">
      {licenses.length === 0 && (
        <p className="muted">Лицензий нет. Если закупка потребует лицензию — система это отметит.</p>
      )}
      {licenses.map((l) => (
        <div
          key={l.id}
          className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
        >
          <div>
            <p className="font-medium text-foreground">{l.kind}</p>
            <p className="muted">
              № {l.number}
              {l.validUntil ? ` · до ${l.validUntil}` : " · бессрочно"}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Удалить лицензию ${l.kind}`}
            onClick={() => onChange(licenses.filter((x) => x.id !== l.id))}
          >
            <Trash2 className="h-4 w-4 text-brick-fg" />
          </Button>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Вид лицензии">
          <Input
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            placeholder="Например: МЧС, ФСТЭК"
          />
        </Field>
        <Field label="Номер">
          <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Л014-..." />
        </Field>
        <Field label="Кем выдана">
          <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        </Field>
        <Field label="Действует до" hint="Пусто — бессрочно">
          <Input
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </Field>
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={add}>
        <Plus className="h-4 w-4" /> Добавить лицензию
      </Button>
    </div>
  );
}

/**
 * Редактор допусков СРО.
 *
 * Уровень ответственности определяет предел стоимости одного договора
 * (ст. 55.16 ГрК РФ), поэтому выбирается вместе с видом работ: для
 * строительства шкала из пяти уровней, для проектирования и изысканий — из четырёх.
 */
export function SroEditor({
  memberships,
  onChange,
}: {
  memberships: SroMembership[];
  onChange: (next: SroMembership[]) => void;
}) {
  const [kind, setKind] = useState<SroKind>("CONSTRUCTION");
  const [level, setLevel] = useState("1");
  const [number, setNumber] = useState("");
  const [validUntil, setValidUntil] = useState("");

  const scaleOf = (k: SroKind) => (k === "OTHER" ? [] : SRO_LEVEL_LIMITS[k]);
  const parsedLevel = level === "" ? null : Number(level);
  const previewLimit = sroLevelLimit(kind, parsedLevel);

  const patch = (id: string, p: Partial<SroMembership>) =>
    onChange(memberships.map((m) => (m.id === id ? { ...m, ...p } : m)));

  const changeKind = (id: string, nextKind: SroKind) => {
    const nextLevel = scaleOf(nextKind)[0]?.level ?? null;
    patch(id, {
      kind: nextKind,
      type: SRO_KIND_LABELS[nextKind],
      responsibilityLevel: nextLevel,
      maxContractAmount: sroLevelLimit(nextKind, nextLevel),
    });
  };

  const changeLevel = (id: string, value: string) => {
    const membership = memberships.find((m) => m.id === id);
    if (!membership) return;
    const nextLevel = value === "" ? null : Number(value);
    patch(id, {
      responsibilityLevel: nextLevel,
      maxContractAmount: sroLevelLimit(membership.kind, nextLevel),
    });
  };

  const add = () => {
    onChange([
      ...memberships,
      {
        id: `sro-${Date.now()}`,
        kind,
        type: SRO_KIND_LABELS[kind],
        number: number.trim() || "номер не указан",
        responsibilityLevel: parsedLevel,
        maxContractAmount: previewLimit,
        validUntil: validUntil || null,
        confirmed: true,
      },
    ]);
    setNumber("");
    setValidUntil("");
  };

  return (
    <div className="space-y-3">
      {memberships.length === 0 && (
        <p className="muted">
          Допусков СРО нет. Закупки на строительные, проектные и изыскательские работы
          получат отметку о необходимости проверить членство в СРО.
        </p>
      )}
      {memberships.map((m) => {
        const limit = effectiveSroLimit(m);
        const expired =
          m.validUntil !== null && new Date(m.validUntil).getTime() < Date.now();
        return (
          <div
            key={m.id}
            className="space-y-2 rounded-md border border-border px-3 py-2 text-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-foreground">
                  {SRO_KIND_LABELS[m.kind]}
                  {m.responsibilityLevel
                    ? ` · ${m.responsibilityLevel}-й уровень ответственности`
                    : ""}
                </p>
                <p className="muted">
                  {m.number} ·{" "}
                  {limit === null
                    ? "предел стоимости договора не указан"
                    : `предел ${formatCurrency(limit)}`}
                  {m.validUntil ? ` · до ${m.validUntil}` : " · бессрочно"}
                  {expired ? " · срок истёк" : ""}
                  {!m.confirmed ? " · не подтверждено" : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Удалить допуск СРО ${SRO_KIND_LABELS[m.kind]}`}
                onClick={() => onChange(memberships.filter((x) => x.id !== m.id))}
              >
                <Trash2 className="h-4 w-4 text-brick-fg" />
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <Field label="Вид работ">
                <Select
                  value={m.kind}
                  onChange={(e) => changeKind(m.id, e.target.value as SroKind)}
                >
                  {SRO_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {SRO_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Уровень ответственности">
                <Select
                  value={m.responsibilityLevel === null ? "" : String(m.responsibilityLevel)}
                  onChange={(e) => changeLevel(m.id, e.target.value)}
                >
                  <option value="">Не указан</option>
                  {scaleOf(m.kind).map((row) => (
                    <option key={row.level} value={row.level}>
                      {row.level}-й уровень ·{" "}
                      {row.maxContractAmount === null
                        ? "без ограничения"
                        : `до ${formatCurrency(row.maxContractAmount)}`}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Действует до" hint="Пусто — бессрочно">
                <Input
                  type="date"
                  value={m.validUntil ?? ""}
                  onChange={(e) =>
                    patch(m.id, { validUntil: e.target.value || null })
                  }
                />
              </Field>
              <div className="flex items-end pb-2">
                <Checkbox
                  label="Подтверждено выпиской"
                  checked={m.confirmed}
                  onChange={(e) => patch(m.id, { confirmed: e.target.checked })}
                />
              </div>
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Вид работ">
          <Select
            value={kind}
            onChange={(e) => {
              const next = e.target.value as SroKind;
              setKind(next);
              setLevel(String(scaleOf(next)[0]?.level ?? ""));
            }}
          >
            {SRO_KINDS.map((k) => (
              <option key={k} value={k}>
                {SRO_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Уровень ответственности">
          <Select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">Не указан</option>
            {scaleOf(kind).map((row) => (
              <option key={row.level} value={row.level}>
                {row.level}-й уровень ·{" "}
                {row.maxContractAmount === null
                  ? "без ограничения"
                  : `до ${formatCurrency(row.maxContractAmount)}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Номер в реестре СРО">
          <Input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="СРО-С-000-000000"
          />
        </Field>
        <Field label="Действует до" hint="Пусто — бессрочно">
          <Input
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
          />
        </Field>
      </div>
      {previewLimit !== null && (
        <p className="muted">
          Предел стоимости одного договора по этому уровню: {formatCurrency(previewLimit)}.
        </p>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={add}>
        <Plus className="h-4 w-4" /> Добавить допуск СРО
      </Button>
    </div>
  );
}

/**
 * Кадровый состав: общая численность и специалисты, включённые в реестры
 * НРС (НОСТРОЙ) и НОПРИЗ. Числа сверяются с требованиями закупок к персоналу.
 */
export function StaffEditor({
  staff,
  onChange,
}: {
  staff: StaffComposition;
  onChange: (next: StaffComposition) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <NumField
          label="Численность штата"
          suffix="чел."
          value={staff.total ?? 0}
          onChange={(n) => onChange({ ...staff, total: n > 0 ? n : null })}
        />
        <NumField
          label="Из них в НРС"
          suffix="чел."
          value={staff.nrsCount}
          onChange={(n) => onChange({ ...staff, nrsCount: Math.round(n) })}
        />
        <NumField
          label="Из них в НОПРИЗ"
          suffix="чел."
          value={staff.noprizCount}
          onChange={(n) => onChange({ ...staff, noprizCount: Math.round(n) })}
        />
      </div>
      <p className="muted">
        НРС — национальный реестр специалистов НОСТРОЙ (строители), НОПРИЗ —
        проектировщики и изыскатели. Закупки с требованием к числу таких
        специалистов проверяются по этим данным.
      </p>
    </div>
  );
}

export function ExperienceEditor({
  records,
  onChange,
}: {
  records: ExperienceRecord[];
  onChange: (next: ExperienceRecord[]) => void;
}) {
  const [subject, setSubject] = useState("");
  const [customer, setCustomer] = useState("");
  const [contractNumber, setContractNumber] = useState("");
  const [amount, setAmount] = useState("0");
  const [completedAt, setCompletedAt] = useState("");

  const add = () => {
    if (!subject.trim() || !customer.trim()) return;
    onChange([
      ...records,
      {
        id: `exp-${Date.now()}`,
        subject: subject.trim(),
        customer: customer.trim(),
        contractNumber: contractNumber.trim() || "—",
        amount: Number(amount) || 0,
        completedAt: completedAt || new Date().toISOString().slice(0, 10),
        okpd2Code: null,
      },
    ]);
    setSubject("");
    setCustomer("");
    setContractNumber("");
    setAmount("0");
    setCompletedAt("");
  };

  return (
    <div className="space-y-3">
      {records.length === 0 && (
        <p className="muted">
          Опыта пока нет. Закупки с требованием опыта получат вердикт «Требуется ручная проверка».
        </p>
      )}
      {records.map((r) => (
        <div
          key={r.id}
          className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
        >
          <div>
            <p className="font-medium text-foreground">{r.subject}</p>
            <p className="muted">
              {r.customer} · {formatCurrency(r.amount)} · завершён {r.completedAt}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Удалить контракт ${r.subject}`}
            onClick={() => onChange(records.filter((x) => x.id !== r.id))}
          >
            <Trash2 className="h-4 w-4 text-brick-fg" />
          </Button>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Предмет контракта">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Заказчик">
          <Input value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </Field>
        <Field label="Номер контракта">
          <Input value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} />
        </Field>
        <Field label="Сумма, ₽">
          <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Дата завершения">
          <Input type="date" value={completedAt} onChange={(e) => setCompletedAt(e.target.value)} />
        </Field>
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={add}>
        <Plus className="h-4 w-4" /> Добавить контракт
      </Button>
    </div>
  );
}

/* ============================== Мастер ============================== */

export function OnboardingWizard() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => ({
    step: 0,
    profile: demoCompanyProfile,
    digest: settingsRepository.get(),
  }));
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Восстановление черновика из localStorage.
  useEffect(() => {
    const saved = readJSON<Draft | null>(STORAGE_KEYS.onboardingDraft, null);
    if (saved && saved.profile && typeof saved.step === "number") {
      setDraft({
        step: Math.min(Math.max(0, saved.step), STEPS.length - 1),
        // Черновик мог быть сохранён до появления штата, сумм опыта и видов СРО:
        // нормализация достраивает недостающие поля и приводит допуски к схеме.
        profile: normalizeSavedProfile(saved.profile, demoCompanyProfile),
        digest: { ...settingsRepository.get(), ...saved.digest },
      });
    }
    setLoaded(true);
  }, []);

  // Сохранение черновика.
  useEffect(() => {
    if (loaded) writeJSON(STORAGE_KEYS.onboardingDraft, draft);
  }, [draft, loaded]);

  const setProfile = useCallback(
    (patch: Partial<CompanyProfile>) =>
      setDraft((d) => ({ ...d, profile: { ...d.profile, ...patch } })),
    [],
  );
  const setRestrictions = useCallback(
    (patch: Partial<CompanyProfile["restrictions"]>) =>
      setDraft((d) => ({
        ...d,
        profile: { ...d.profile, restrictions: { ...d.profile.restrictions, ...patch } },
      })),
    [],
  );
  const setCapabilities = useCallback(
    (patch: Partial<CompanyProfile["capabilities"]>) =>
      setDraft((d) => ({
        ...d,
        profile: { ...d.profile, capabilities: { ...d.profile.capabilities, ...patch } },
      })),
    [],
  );
  const setDigest = useCallback(
    (patch: Partial<DigestSettings>) =>
      setDraft((d) => ({ ...d, digest: { ...d.digest, ...patch } })),
    [],
  );

  const validateStep = (step: number): boolean => {
    const errs: Record<string, string> = {};
    if (step === 0) {
      const res = companySchema.safeParse(draft.profile);
      if (!res.success) {
        for (const issue of res.error.issues) {
          const key = String(issue.path[0] ?? "form");
          if (!errs[key]) errs[key] = issue.message;
        }
      }
    }
    if (step === 3) {
      const r = draft.profile.restrictions;
      const res = financeSchema.safeParse({
        minPrice: r.minPrice,
        maxPrice: r.maxPrice,
        maxPaymentTermDays: r.maxPaymentTermDays,
        minDeliveryTermDays: r.minDeliveryTermDays,
        maxBidSecurity: r.maxBidSecurity,
        maxContractSecurity: r.maxContractSecurity,
        minMarginPercent: r.minMarginPercent,
      });
      if (!res.success) {
        for (const issue of res.error.issues) {
          const key = String(issue.path[0] ?? "form");
          if (!errs[key]) errs[key] = issue.message;
        }
      }
    }
    if (step === 7) {
      const res = digestSchema.safeParse(draft.digest);
      if (!res.success) {
        for (const issue of res.error.issues) {
          const key = String(issue.path[0] ?? "form");
          if (!errs[key]) errs[key] = issue.message;
        }
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const next = () => {
    if (!validateStep(draft.step)) return;
    setDraft((d) => ({ ...d, step: Math.min(d.step + 1, STEPS.length - 1) }));
  };
  const prev = () => setDraft((d) => ({ ...d, step: Math.max(d.step - 1, 0) }));

  const finish = () => {
    companyProfileRepository.save(draft.profile);
    settingsRepository.save(draft.digest);
    writeJSON(STORAGE_KEYS.onboardingDone, true);
    removeKey(STORAGE_KEYS.onboardingDraft);
    router.push("/tenders");
  };

  const p = draft.profile;
  const step = draft.step;
  const progress = ((step + 1) / STEPS.length) * 100;

  const nav = (
    <div className="flex items-center justify-between border-t border-border pt-4">
      <Button variant="secondary" onClick={prev} disabled={step === 0}>
        Назад
      </Button>
      <span className="muted">
        Шаг {step + 1} из {STEPS.length}
      </span>
      {step < STEPS.length - 1 ? (
        <Button onClick={next}>Далее</Button>
      ) : (
        <Button onClick={finish}>
          <CheckCircle2 className="h-4 w-4" /> Завершить настройку
        </Button>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Настройка профиля компании</h1>
      <p className="muted mt-1 mb-4">
        Поля заполнены примером — проверьте и замените на свои данные. Черновик сохраняется
        автоматически.
      </p>
      <ProgressBar value={progress} className="mb-6" />

      <Card title={STEPS[step]}>
        <div className="space-y-4">
          {step === 0 && (
            <>
              <Field label="Название компании" error={errors.legalName}>
                <Input
                  value={p.legalName}
                  onChange={(e) => setProfile({ legalName: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="ИНН" error={errors.inn} hint="10 или 12 цифр с контрольными числами">
                  <Input
                    value={p.inn}
                    inputMode="numeric"
                    onChange={(e) =>
                      setProfile({ inn: e.target.value.replace(/\D/g, "").slice(0, 12) })
                    }
                  />
                </Field>
                <Field label="Организационно-правовая форма">
                  <Select
                    value={p.legalForm}
                    onChange={(e) =>
                      setProfile({ legalForm: e.target.value as CompanyProfile["legalForm"] })
                    }
                  >
                    {(Object.keys(legalFormLabels) as CompanyProfile["legalForm"][]).map((k) => (
                      <option key={k} value={k}>
                        {legalFormLabels[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Система налогообложения">
                  <Select
                    value={p.taxSystem}
                    onChange={(e) =>
                      setProfile({ taxSystem: e.target.value as CompanyProfile["taxSystem"] })
                    }
                  >
                    {(Object.keys(taxSystemLabels) as CompanyProfile["taxSystem"][]).map((k) => (
                      <option key={k} value={k}>
                        {taxSystemLabels[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-end pb-2">
                  <Checkbox
                    label="Работает с НДС"
                    checked={p.worksWithVat}
                    onChange={(e) => setProfile({ worksWithVat: e.target.checked })}
                  />
                </div>
              </div>
              <Field label="Описание деятельности" error={errors.activityDescription}>
                <Textarea
                  rows={3}
                  value={p.activityDescription}
                  onChange={(e) => setProfile({ activityDescription: e.target.value })}
                />
              </Field>
            </>
          )}

          {step === 1 && (
            <>
              <Field label="Товары" hint="Enter или запятая — добавить">
                <TagListInput
                  values={p.capabilities.products}
                  onChange={(v) => setCapabilities({ products: v })}
                  placeholder="Например: ноутбуки, МФУ"
                />
              </Field>
              <Field label="Работы">
                <TagListInput
                  values={p.capabilities.works}
                  onChange={(v) => setCapabilities({ works: v })}
                  placeholder="Например: монтаж СКС"
                />
              </Field>
              <Field label="Услуги">
                <TagListInput
                  values={p.capabilities.services}
                  onChange={(v) => setCapabilities({ services: v })}
                  placeholder="Например: техническое обслуживание"
                />
              </Field>
              <Field label="Бренды и модели">
                <TagListInput
                  values={p.capabilities.brandsAndModels}
                  onChange={(v) => setCapabilities({ brandsAndModels: v })}
                  placeholder="Например: Acer, HP LaserJet"
                />
              </Field>
            </>
          )}

          {step === 2 && (
            <>
              <Field label="Регионы работы" hint="Закупки вне этих регионов получат блокер">
                <TagListInput
                  values={p.restrictions.workRegions}
                  onChange={(v) => setRestrictions({ workRegions: v })}
                  placeholder="Например: Москва"
                />
              </Field>
              <Field label="Белый список заказчиков" hint="Необязательно">
                <TagListInput
                  values={p.restrictions.customerWhitelist}
                  onChange={(v) => setRestrictions({ customerWhitelist: v })}
                  placeholder="Название заказчика"
                />
              </Field>
              <Field label="Чёрный список заказчиков" hint="Эти заказчики будут отклоняться">
                <TagListInput
                  values={p.restrictions.customerBlacklist}
                  onChange={(v) => setRestrictions({ customerBlacklist: v })}
                  placeholder="Название заказчика"
                />
              </Field>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumField
                  label="Минимальная цена закупки"
                  suffix="₽"
                  value={p.restrictions.minPrice}
                  error={errors.minPrice}
                  onChange={(n) => setRestrictions({ minPrice: n })}
                />
                <NumField
                  label="Максимальная цена закупки"
                  suffix="₽"
                  value={p.restrictions.maxPrice}
                  onChange={(n) => setRestrictions({ maxPrice: n })}
                />
                <NumField
                  label="Максимальный срок оплаты"
                  suffix="дней"
                  value={p.restrictions.maxPaymentTermDays}
                  onChange={(n) => setRestrictions({ maxPaymentTermDays: n })}
                />
                <NumField
                  label="Минимальный срок поставки"
                  suffix="дней"
                  value={p.restrictions.minDeliveryTermDays}
                  onChange={(n) => setRestrictions({ minDeliveryTermDays: n })}
                />
                <NumField
                  label="Максимальное обеспечение заявки"
                  suffix="₽"
                  value={p.restrictions.maxBidSecurity}
                  onChange={(n) => setRestrictions({ maxBidSecurity: n })}
                />
                <NumField
                  label="Максимальное обеспечение контракта"
                  suffix="₽"
                  value={p.restrictions.maxContractSecurity}
                  onChange={(n) => setRestrictions({ maxContractSecurity: n })}
                />
                <NumField
                  label="Минимальная ожидаемая маржинальность"
                  suffix="%"
                  value={p.restrictions.minMarginPercent}
                  onChange={(n) => setRestrictions({ minMarginPercent: n })}
                />
              </div>
              <Checkbox
                label="Допускаю участие без аванса"
                checked={p.restrictions.allowNoAdvance}
                onChange={(e) => setRestrictions({ allowNoAdvance: e.target.checked })}
              />
            </>
          )}

          {step === 4 && (
            <>
              <LicenseEditor
                licenses={p.licenses}
                onChange={(licenses) => setProfile({ licenses })}
              />
              <div className="pt-4">
                <h2 className="text-base font-semibold text-foreground">Допуски СРО</h2>
                <p className="muted mb-3">
                  Вид работ и уровень ответственности: от уровня зависит предел
                  стоимости договора, который компания вправе заключить.
                </p>
                <SroEditor
                  memberships={p.sroMemberships}
                  onChange={(sroMemberships) => setProfile({ sroMemberships })}
                />
              </div>
              <div className="pt-4">
                <h2 className="text-base font-semibold text-foreground">
                  Кадровый состав
                </h2>
                <p className="muted mb-3">
                  Численность и специалисты в реестрах НРС и НОПРИЗ.
                </p>
                <StaffEditor
                  staff={p.staff}
                  onChange={(staff) => setProfile({ staff })}
                />
              </div>
              <div className="flex gap-6 pt-4">
                <Checkbox
                  label="Есть персонал"
                  checked={p.hasPersonnel}
                  onChange={(e) => setProfile({ hasPersonnel: e.target.checked })}
                />
                <Checkbox
                  label="Есть техника/оборудование"
                  checked={p.hasEquipment}
                  onChange={(e) => setProfile({ hasEquipment: e.target.checked })}
                />
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <ExperienceEditor
                records={p.experience}
                onChange={(experience) => setProfile({ experience })}
              />
              <div className="pt-4">
                <h2 className="text-base font-semibold text-foreground">
                  Суммы выполненных работ
                </h2>
                <p className="muted mb-3">
                  Совокупная стоимость исполненных работ — так её указывает анкета
                  контрагента. Значения имеют приоритет перед расчётом по списку
                  контрактов выше; 0 — сумма не заявлена.
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <NumField
                    label="За предыдущий год"
                    suffix="₽"
                    value={p.experienceTotals.lastYearAmount ?? 0}
                    onChange={(n) =>
                      setProfile({
                        experienceTotals: {
                          ...p.experienceTotals,
                          lastYearAmount: n > 0 ? n : null,
                        },
                      })
                    }
                  />
                  <NumField
                    label="За последние 3 года"
                    suffix="₽"
                    value={p.experienceTotals.last3YearsAmount ?? 0}
                    onChange={(n) =>
                      setProfile({
                        experienceTotals: {
                          ...p.experienceTotals,
                          last3YearsAmount: n > 0 ? n : null,
                        },
                      })
                    }
                  />
                </div>
              </div>
            </>
          )}

          {step === 6 && (
            <>
              <Field label="Ключевые слова" hint="По ним ищем предмет закупки">
                <TagListInput
                  values={p.capabilities.keywords}
                  onChange={(v) => setCapabilities({ keywords: v })}
                  placeholder="Например: компьютер"
                />
              </Field>
              <Field label="Синонимы">
                <TagListInput
                  values={p.capabilities.synonyms}
                  onChange={(v) => setCapabilities({ synonyms: v })}
                  placeholder="Например: ПК, ЭВМ"
                />
              </Field>
              <Field label="Стоп-слова" hint="Совпадение снижает оценку релевантности">
                <TagListInput
                  values={p.capabilities.stopWords}
                  onChange={(v) => setCapabilities({ stopWords: v })}
                  placeholder="Например: аренда"
                />
              </Field>
              <Field label="Коды ОКПД2">
                <TagListInput
                  values={p.capabilities.okpd2Codes}
                  onChange={(v) => setCapabilities({ okpd2Codes: v })}
                  placeholder="Например: 26.20"
                />
              </Field>
            </>
          )}

          {step === 7 && (
            <>
              <Checkbox
                label="Собирать ежедневный отчёт"
                checked={draft.digest.enabled}
                onChange={(e) => setDigest({ enabled: e.target.checked })}
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Время отправки (МСК)" error={errors.sendTime}>
                  <Input
                    type="time"
                    value={draft.digest.sendTime}
                    onChange={(e) => setDigest({ sendTime: e.target.value })}
                  />
                </Field>
                <Field label="Email для отчёта" error={errors.email}>
                  <Input
                    type="email"
                    value={draft.digest.email}
                    onChange={(e) => setDigest({ email: e.target.value })}
                  />
                </Field>
                <Field
                  label="Минимальная оценка соответствия"
                  hint="Закупки ниже порога попадут в раздел «Не подошло»"
                  error={errors.minFitScore}
                >
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={String(draft.digest.minFitScore)}
                    onChange={(e) => setDigest({ minFitScore: Number(e.target.value) || 0 })}
                  />
                </Field>
              </div>
              {/*
                Время и адрес сохраняем, но не обещаем доставку: отправка не
                подключена, и молча собирать недоставляемые настройки — значит
                врать пользователю на первом же экране.
              */}
              <p className="muted text-xs">
                Отправка на почту пока не подключена: отчёт будет доступен внутри приложения.
                Время и адрес сохраним и используем, когда доставка появится.
              </p>
            </>
          )}

          {step === 8 && (
            <div className="space-y-3 text-sm">
              {/* Противоречия в заполненном — до сводки, пока их ещё можно поправить. */}
              <ProfileAuditNotice profile={p} />
              <SummaryRow label="Компания" value={`${p.legalName}, ИНН ${p.inn}`} />
              <SummaryRow
                label="Форма и налоги"
                value={`${legalFormLabels[p.legalForm]}, ${taxSystemLabels[p.taxSystem]}${
                  p.worksWithVat ? ", с НДС" : ", без НДС"
                }`}
              />
              <SummaryRow
                label="Регионы"
                value={p.restrictions.workRegions.join(", ") || "не указаны"}
              />
              <SummaryRow
                label="Диапазон цен"
                value={`${formatCurrency(p.restrictions.minPrice)} — ${formatCurrency(p.restrictions.maxPrice)}`}
              />
              <SummaryRow
                label="Ключевые слова"
                value={p.capabilities.keywords.join(", ") || "не указаны"}
              />
              <SummaryRow
                label="Стоп-слова"
                value={p.capabilities.stopWords.join(", ") || "нет"}
              />
              <SummaryRow
                label="Лицензии"
                value={p.licenses.map((l) => l.kind).join(", ") || "нет"}
              />
              <SummaryRow
                label="Опыт"
                value={p.experience.length > 0 ? `${p.experience.length} контракт(ов)` : "нет"}
              />
              <SummaryRow
                label="Ежедневный отчёт"
                value={
                  draft.digest.enabled
                    ? `включён, порог соответствия ${draft.digest.minFitScore}`
                    : "выключен"
                }
              />
              <p className="muted pt-2">
                После завершения профиль можно изменить в разделе «Настройки → Профиль компании».
              </p>
            </div>
          )}
        </div>
      </Card>

      <div className="mt-4">{nav}</div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="muted w-40 shrink-0">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}
