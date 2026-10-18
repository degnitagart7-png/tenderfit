import { fireEvent, screen } from "@testing-library/react";

/**
 * Открывает вкладку «Смета» в панели глубокого анализа.
 *
 * Кнопки расчёта и проверки сметы, параметры расчёта и результат лежат на этой
 * вкладке, а не в общей ленте: пока она не открыта, их нет для кнопочных
 * запросов (`getByRole`), как нет и для человека.
 */
export async function openEstimateTab(): Promise<void> {
  fireEvent.click(await screen.findByRole("tab", { name: /Смета/ }));
}
