import { workConditionsSentence } from "@/domain/estimate/workConditions";
import type { AppliedNormative } from "@/domain/estimate/types";

/**
 * Нормативы сверх норм ГЭСН, на которых стоят начисления сметы: коэффициенты условий работ
 * (421/пр, приложение 10), зимнее удорожание (325/пр), временные здания (332/пр), районы Крайнего
 * Севера (812/пр, постановление Правительства РФ N 1946). Каждая запись называет приказ и пункт, а
 * ненаписанное начисление — причину: сумма без него занижена, и это надо видеть.
 */
export function AppliedNormatives({
  normatives,
  compact = false,
}: {
  normatives: readonly AppliedNormative[] | undefined;
  /** Короткий вид для карточки «На чём стоят эти числа»: без полного текста условий. */
  compact?: boolean;
}) {
  if (normatives === undefined || normatives.length === 0) return null;
  const sentence = workConditionsSentence(normatives);
  return (
    <div className="space-y-1.5" data-testid="applied-normatives">
      {sentence !== null && <p data-testid="work-conditions-sentence">{sentence}</p>}
      <ul className="space-y-1.5">
        {normatives.map((item, index) => (
          <li key={`${item.code}-${String(index)}`} className="text-sm">
            <span className="font-medium text-foreground">{item.title}</span>
            {": "}
            <span className={item.applied ? undefined : "text-mustard-fg"}>{item.applied ? item.value : `не начислено — ${item.reason ?? item.value}`}</span>
            {item.assumption !== undefined && <span className="text-mustard-fg">{` (допущение: ${item.assumption})`}</span>}
            {!compact && item.text !== "" && <span className="block text-xs text-muted-foreground">{item.text}</span>}
            <span className="block text-xs text-muted-foreground">{item.source}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
