"use client";

import { accountSync } from "@/services/accountSync";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { CompanyProfile } from "@/domain/entities";
import { innSchema } from "@/domain/schemas";
import { readConsent, saveConsent } from "@/lib/consent";
import { companyProfileRepository } from "@/repositories/companyProfileRepository";
import { NO_AMOUNT_LIMIT, NO_DAYS_LIMIT } from "@/domain/emptyCompanyProfile";
import { Button, Card, Checkbox, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { TagListInput } from "@/components/onboarding/TagListInput";
import { RegionPicker } from "@/components/ui/RegionPicker";
import {
  ExperienceEditor,
  LicenseEditor,
  NumField,
  SroEditor,
  StaffEditor,
  legalFormLabels,
  taxSystemLabels,
} from "@/components/onboarding/OnboardingWizard";
import { DocumentUploader } from "@/components/settings/DocumentUploader";
import { cn } from "@/lib/cn";
import { ProfileAuditNotice } from "@/components/settings/ProfileAuditNotice";

/** Форма редактирования профиля компании (раздел «Настройки → Профиль»). */
export function CompanyProfileForm({ initial }: { initial: CompanyProfile }) {
  const [profile, setProfile] = useState<CompanyProfile>(initial);
  const [innError, setInnError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /*
    Согласие на обработку ПД. Читается в эффекте, а не при инициализации
    состояния: localStorage недоступен на сервере, и обращение к нему при
    первом рендере рассинхронизировало бы разметку после гидратации.
  */
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState(false);

  useEffect(() => {
    setConsent(readConsent() !== null);
  }, []);

  const patch = (p: Partial<CompanyProfile>) => {
    setProfile((prev) => ({ ...prev, ...p }));
    setSaved(false);
  };
  const patchRestrictions = (p: Partial<CompanyProfile["restrictions"]>) =>
    patch({ restrictions: { ...profile.restrictions, ...p } });
  const patchCapabilities = (p: Partial<CompanyProfile["capabilities"]>) =>
    patch({ capabilities: { ...profile.capabilities, ...p } });
  const patchPreferences = (p: Partial<CompanyProfile["preferences"]>) =>
    patch({ preferences: { ...profile.preferences, ...p } });

  const save = () => {
    // Согласие проверяется первым: профиль содержит ИНН и наименование, а для
    // индивидуального предпринимателя это персональные данные — сохранять их
    // без правового основания нельзя.
    if (!consent) {
      setConsentError(true);
      return;
    }
    const res = innSchema.safeParse(profile.inn);
    if (!res.success) {
      setInnError(res.error.issues[0]?.message ?? "Некорректный ИНН");
      return;
    }
    setInnError(null);
    setConsentError(false);
    saveConsent();
    companyProfileRepository.save(profile);
    void accountSync.pushIfSignedIn();
    setSaved(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground">Профиль компании</h1>
        <div className="flex items-center gap-2">
          {saved && <span className="text-sm text-olive-fg">Сохранено</span>}
          {/*
            Кнопки «Сбросить к демо-профилю» здесь больше нет: она одним кликом
            стирала заполненный профиль реальной компании без подтверждения, а
            пользы от неё нет — поля редактируются по отдельности.
          */}
          <Button onClick={save}>Сохранить</Button>
        </div>
      </div>

      <ProfileAuditNotice profile={profile} />

      {/*
        Согласие на обработку ПД. Стоит над формой, а не под кнопкой: человек
        должен видеть условие до того, как начнёт вводить ИНН, а не после.
      */}
      <div
        className={cn(
          "rounded-card border bg-panel p-4 shadow-card",
          consentError ? "border-brick/60" : "border-border/70",
        )}
      >
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              if (e.target.checked) setConsentError(false);
            }}
            aria-invalid={consentError || undefined}
            aria-describedby="pd-consent-hint"
            className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-border bg-panel accent-[rgb(var(--accent))]"
          />
          <span className="text-[15.5px] leading-relaxed text-ink-soft">
            Даю{" "}
            <Link href="/legal/consent" className="text-accent-fg underline underline-offset-2">
              согласие на обработку персональных данных
            </Link>{" "}
            и подтверждаю, что ознакомлен с{" "}
            <Link href="/legal/privacy" className="text-accent-fg underline underline-offset-2">
              политикой конфиденциальности
            </Link>
            .
          </span>
        </label>
        <p id="pd-consent-hint" className="mt-2 pl-7 text-[14.5px] text-muted-foreground">
          Для индивидуального предпринимателя ИНН и наименование — персональные данные.
          Без согласия профиль не сохранится.
        </p>
        {consentError && (
          <p className="mt-2 pl-7 text-[14.5px] text-brick-fg" role="alert">
            Отметьте согласие, чтобы сохранить профиль.
          </p>
        )}
      </div>

      <Card title="Сведения о компании">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Название">
            <Input value={profile.legalName} onChange={(e) => patch({ legalName: e.target.value })} />
          </Field>
          <Field label="ИНН" error={innError ?? undefined}>
            <Input
              value={profile.inn}
              inputMode="numeric"
              onChange={(e) => patch({ inn: e.target.value.replace(/\D/g, "").slice(0, 12) })}
            />
          </Field>
          <Field label="Форма">
            <Select
              value={profile.legalForm}
              onChange={(e) => patch({ legalForm: e.target.value as CompanyProfile["legalForm"] })}
            >
              {(Object.keys(legalFormLabels) as CompanyProfile["legalForm"][]).map((k) => (
                <option key={k} value={k}>
                  {legalFormLabels[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Налогообложение">
            <Select
              value={profile.taxSystem}
              onChange={(e) => patch({ taxSystem: e.target.value as CompanyProfile["taxSystem"] })}
            >
              {(Object.keys(taxSystemLabels) as CompanyProfile["taxSystem"][]).map((k) => (
                <option key={k} value={k}>
                  {taxSystemLabels[k]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Описание деятельности">
              <Textarea
                rows={3}
                value={profile.activityDescription}
                onChange={(e) => patch({ activityDescription: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex gap-6">
            <Checkbox
              label="Работает с НДС"
              checked={profile.worksWithVat}
              onChange={(e) => patch({ worksWithVat: e.target.checked })}
            />
            <Checkbox
              label="Есть персонал"
              checked={profile.hasPersonnel}
              onChange={(e) => patch({ hasPersonnel: e.target.checked })}
            />
            <Checkbox
              label="Есть техника"
              checked={profile.hasEquipment}
              onChange={(e) => patch({ hasEquipment: e.target.checked })}
            />
            <Checkbox
              label="Открыт спецсчёт"
              checked={profile.hasSpecialAccount}
              onChange={(e) => patch({ hasSpecialAccount: e.target.checked })}
            />
          </div>
        </div>
      </Card>

      <Card title="Что вы поставляете и выполняете">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Товары">
            <TagListInput
              values={profile.capabilities.products}
              onChange={(v) => patchCapabilities({ products: v })}
            />
          </Field>
          <Field label="Работы">
            <TagListInput
              values={profile.capabilities.works}
              onChange={(v) => patchCapabilities({ works: v })}
            />
          </Field>
          <Field label="Услуги">
            <TagListInput
              values={profile.capabilities.services}
              onChange={(v) => patchCapabilities({ services: v })}
            />
          </Field>
          <Field label="Бренды и модели">
            <TagListInput
              values={profile.capabilities.brandsAndModels}
              onChange={(v) => patchCapabilities({ brandsAndModels: v })}
            />
          </Field>
          <Field label="Ключевые слова">
            <TagListInput
              values={profile.capabilities.keywords}
              onChange={(v) => patchCapabilities({ keywords: v })}
            />
          </Field>
          <Field label="Синонимы">
            <TagListInput
              values={profile.capabilities.synonyms}
              onChange={(v) => patchCapabilities({ synonyms: v })}
            />
          </Field>
          <Field label="Стоп-слова">
            <TagListInput
              values={profile.capabilities.stopWords}
              onChange={(v) => patchCapabilities({ stopWords: v })}
            />
          </Field>
          <Field label="Коды ОКПД2">
            <TagListInput
              values={profile.capabilities.okpd2Codes}
              onChange={(v) => patchCapabilities({ okpd2Codes: v })}
            />
          </Field>
        </div>
      </Card>

      <Card title="За что не беретесь — закупка с этим отсеивается">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumField
            label="Цена от"
            suffix="₽"
            value={profile.restrictions.minPrice}
            onChange={(n) => patchRestrictions({ minPrice: n })}
          />
          <NumField
            label="Цена до"
            suffix="₽"
            value={profile.restrictions.maxPrice}
            unlimitedAt={NO_AMOUNT_LIMIT}
            onChange={(n) => patchRestrictions({ maxPrice: n })}
          />
          <NumField
            label="Макс. удалённость"
            suffix="км"
            value={profile.restrictions.maxDistanceKm ?? 0}
            onChange={(n) => patchRestrictions({ maxDistanceKm: n > 0 ? n : null })}
          />
          <NumField
            label="Макс. срок оплаты"
            suffix="дней"
            value={profile.restrictions.maxPaymentTermDays}
            unlimitedAt={NO_DAYS_LIMIT}
            onChange={(n) => patchRestrictions({ maxPaymentTermDays: n })}
          />
          <NumField
            label="Мин. срок поставки"
            suffix="дней"
            value={profile.restrictions.minDeliveryTermDays}
            onChange={(n) => patchRestrictions({ minDeliveryTermDays: n })}
          />
          <NumField
            label="Мин. маржинальность"
            suffix="%"
            value={profile.restrictions.minMarginPercent}
            onChange={(n) => patchRestrictions({ minMarginPercent: n })}
          />
          <NumField
            label="Макс. обеспечение заявки"
            suffix="₽"
            value={profile.restrictions.maxBidSecurity}
            unlimitedAt={NO_AMOUNT_LIMIT}
            onChange={(n) => patchRestrictions({ maxBidSecurity: n })}
          />
          <NumField
            label="Макс. обеспечение контракта"
            suffix="₽"
            value={profile.restrictions.maxContractSecurity}
            unlimitedAt={NO_AMOUNT_LIMIT}
            onChange={(n) => patchRestrictions({ maxContractSecurity: n })}
          />
          <div className="flex items-end pb-2">
            <Checkbox
              label="Участие без аванса допустимо"
              checked={profile.restrictions.allowNoAdvance}
              onChange={(e) => patchRestrictions({ allowNoAdvance: e.target.checked })}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-3">
          <Field label="Регионы работы">
            <RegionPicker
              values={profile.restrictions.workRegions}
              onChange={(v) => patchRestrictions({ workRegions: v })}
            />
          </Field>
          <Field label="Белый список заказчиков">
            <TagListInput
              values={profile.restrictions.customerWhitelist}
              onChange={(v) => patchRestrictions({ customerWhitelist: v })}
            />
          </Field>
          <Field label="Чёрный список заказчиков">
            <TagListInput
              values={profile.restrictions.customerBlacklist}
              onChange={(v) => patchRestrictions({ customerBlacklist: v })}
            />
          </Field>
          <div className="sm:col-span-3">
            <Field label="Дополнительные жёсткие ограничения (текстом)">
              <TagListInput
                values={profile.restrictions.custom}
                onChange={(v) => patchRestrictions({ custom: v })}
                placeholder="Например: не участвуем с казначейским сопровождением"
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Что предпочитаете — поднимает в списке, но не отсеивает">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Приоритетные регионы">
            <RegionPicker
              values={profile.preferences.priorityRegions}
              onChange={(v) => patchPreferences({ priorityRegions: v })}
            />
          </Field>
          <Field label="Приоритетные бренды">
            <TagListInput
              values={profile.preferences.priorityBrands}
              onChange={(v) => patchPreferences({ priorityBrands: v })}
            />
          </Field>
          <NumField
            label="Желаемая цена от"
            suffix="₽"
            value={profile.preferences.preferredMinPrice ?? 0}
            onChange={(n) => patchPreferences({ preferredMinPrice: n > 0 ? n : null })}
          />
          <NumField
            label="Желаемая цена до"
            suffix="₽"
            value={profile.preferences.preferredMaxPrice ?? 0}
            onChange={(n) => patchPreferences({ preferredMaxPrice: n > 0 ? n : null })}
          />
          <div className="flex items-end gap-6 pb-2 sm:col-span-3 flex-wrap">
            <Checkbox
              label="Предпочтителен аванс"
              checked={profile.preferences.preferAdvance}
              onChange={(e) => patchPreferences({ preferAdvance: e.target.checked })}
            />
            <Checkbox
              label="Предпочтителен короткий срок оплаты"
              checked={profile.preferences.preferShortPaymentTerm}
              onChange={(e) => patchPreferences({ preferShortPaymentTerm: e.target.checked })}
            />
            <Checkbox
              label="Избегать казначейского сопровождения"
              checked={profile.preferences.avoidTreasurySupport}
              onChange={(e) => patchPreferences({ avoidTreasurySupport: e.target.checked })}
            />
          </div>
          <div className="sm:col-span-3">
            <Field label="Заметки о приоритетах">
              <TagListInput
                values={profile.preferences.notes}
                onChange={(v) => patchPreferences({ notes: v })}
                placeholder="Например: предпочтительны контракты на техподдержку с продлением"
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Лицензии">
        <LicenseEditor
          licenses={profile.licenses}
          onChange={(licenses) => patch({ licenses })}
        />
      </Card>

      <Card title="Допуски СРО">
        <div className="space-y-3">
          <p className="muted">
            Вид работ и уровень ответственности задают предел стоимости одного договора.
          </p>
          <SroEditor
            memberships={profile.sroMemberships}
            onChange={(sroMemberships) => patch({ sroMemberships })}
          />
        </div>
      </Card>

      <Card title="Кадровый состав">
        <StaffEditor
          staff={profile.staff}
          onChange={(staff) => patch({ staff })}
        />
      </Card>

      <Card title="Опыт исполнения контрактов">
        <div className="space-y-4">
          <ExperienceEditor
            records={profile.experience}
            onChange={(experience) => patch({ experience })}
          />
          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-foreground">
              Суммы выполненных работ
            </h3>
            <p className="muted mb-3">
              Как в анкете контрагента; важнее списка контрактов выше. 0 — не заявлено.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <NumField
                label="За предыдущий год"
                suffix="₽"
                value={profile.experienceTotals.lastYearAmount ?? 0}
                onChange={(n) =>
                  patch({
                    experienceTotals: {
                      ...profile.experienceTotals,
                      lastYearAmount: n > 0 ? n : null,
                    },
                  })
                }
              />
              <NumField
                label="За последние 3 года"
                suffix="₽"
                value={profile.experienceTotals.last3YearsAmount ?? 0}
                onChange={(n) =>
                  patch({
                    experienceTotals: {
                      ...profile.experienceTotals,
                      last3YearsAmount: n > 0 ? n : null,
                    },
                  })
                }
              />
            </div>
          </div>
        </div>
      </Card>

      <Card title="Документы компании">
        <DocumentUploader
          documents={profile.documents}
          onChange={(documents) => patch({ documents })}
        />
      </Card>
    </div>
  );
}
