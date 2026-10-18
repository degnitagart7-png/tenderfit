import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import LoginPage from "@/app/login/page";

/**
 * Вход и регистрация — один путь: почта → код из письма → внутри; аккаунт создаётся сам.
 *
 * Без почтового сервера код не отправить — тогда страница сама переходит к входу и
 * регистрации по паролю. Почта Google не принимается: об этом сказано до отправки,
 * отказ сервера — его словами.
 */

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Ответы по адресу ручки; /api/auth/me — вход по коду выключен, если не сказано иное. */
function routes(map: Record<string, Response | (() => Response)>, codeLogin = false) {
  vi.mocked(fetch).mockImplementation(async (url) => {
    const key = String(url);
    if (key === "/api/auth/me") return answer({ user: null, loginEnabled: true, codeLoginEnabled: codeLogin });
    if (key === "/api/me/data") return answer({ searchProfiles: [], companyProfile: null });
    const found = map[key];
    if (found === undefined) return answer({ error: "нет" }, 404);
    return typeof found === "function" ? found() : found.clone();
  });
}

/** Без почты на сервере форма переходит к паролю, когда узнает об этом от /api/auth/me. */
const passwordForm = () => screen.findByLabelText("Пароль");

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Код из письма: вставка в первую ячейку (так же работает автозаполнение из СМС). */
const enterCode = (code: string) =>
  fireEvent.change(screen.getByLabelText("Цифра 1 из 6"), { target: { value: code } });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  push.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LoginPage — почта и код (основной путь)", () => {
  const withMail = (extra: Record<string, Response> = {}) =>
    routes(
      {
        "/api/auth/request": answer({ sent: true }),
        "/api/auth/verify": answer({ user: { email: "ivan@firma.ru" } }),
        ...extra,
      },
      true,
    );

  it("один экран: почта, согласие и «Продолжить», без вкладок и пароля", async () => {
    withMail();
    render(<LoginPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(screen.getByText("Вход и регистрация")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByLabelText("Пароль")).toBeNull();
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.getByRole("link", { name: /обработку персональных данных/i })).toBeTruthy();
  });

  it("почта → код из письма → вход сразу по шестой цифре, без нажатия «Войти»", async () => {
    withMail();
    render(<LoginPage />);
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^продолжить$/i }));

    await screen.findByRole("group", { name: "Код из письма" });
    const request = vi.mocked(fetch).mock.calls.find((c) => String(c[0]) === "/api/auth/request");
    expect(JSON.parse(String((request?.[1] as RequestInit).body))).toEqual({ email: "ivan@firma.ru", consent: true });

    enterCode("123456");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
    const verify = vi.mocked(fetch).mock.calls.find((c) => String(c[0]) === "/api/auth/verify");
    expect(JSON.parse(String((verify?.[1] as RequestInit).body))).toEqual({ email: "ivan@firma.ru", code: "123456" });
  });

  it("неверный код — слова сервера, остаёмся на странице; почту можно поменять", async () => {
    withMail({ "/api/auth/verify": answer({ error: "Код не подошёл или устарел. Запросите новый." }, 400) });
    render(<LoginPage />);
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^продолжить$/i }));
    await screen.findByRole("group", { name: "Код из письма" });
    enterCode("000000");

    expect((await screen.findByRole("alert")).textContent).toMatch(/не подошёл/);
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Изменить почту" }));
    expect(screen.getByLabelText("Почта")).toBeTruthy();
  });

  it("неверная почта ловится до отправки: одно сообщение, поле подсвечено", async () => {
    withMail();
    render(<LoginPage />);
    fill("Почта", "не-почта");
    fireEvent.click(screen.getByRole("button", { name: /^продолжить$/i }));

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByLabelText("Почта").getAttribute("aria-invalid")).toBe("true");
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "/api/auth/request")).toBe(false);
  });

  it("без галочки согласия код не отправляется", async () => {
    withMail();
    render(<LoginPage />);
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("button", { name: /^продолжить$/i }));

    expect(screen.getByRole("alert").textContent).toMatch(/согласие/);
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "/api/auth/request")).toBe(false);
  });

  it("почта Google: о запрете сказано заранее, отказ сервера — его словами", async () => {
    withMail({ "/api/auth/request": answer({ error: "Почта Google (gmail.com) не принимается. Укажите другой адрес." }, 403) });
    render(<LoginPage />);
    expect(screen.getByText(/gmail\.com\) не принимается/i)).toBeTruthy();
    fill("Почта", "ivan@gmail.com");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^продолжить$/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/укажите другой адрес/i);
  });

  it("кто задал пароль, входит по ссылке «Войти с паролем»", async () => {
    withMail({ "/api/auth/login": answer({ user: { email: "ivan@firma.ru" } }) });
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Войти с паролем" }));
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "надёжный-пароль-1");
    fireEvent.click(screen.getByRole("button", { name: /^войти$/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("входа не обойти и семь дней бесплатно обещаны", () => {
    withMail();
    render(<LoginPage />);
    expect(screen.queryByRole("link", { name: /без входа/i })).toBeNull();
    expect(screen.getAllByText(/7 дней бесплатно/).length).toBeGreaterThan(0);
  });
});

describe("LoginPage — повторная отправка кода", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("после отправки кнопка «ещё раз» ждёт 60 секунд с обратным отсчётом", async () => {
    routes({ "/api/auth/request": answer({ sent: true }) }, true);
    render(<LoginPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("checkbox"));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole("button", { name: /^продолжить$/i }));

    const resend = await screen.findByRole("button", { name: /ещё раз через 60 с/i });
    expect((resend as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByRole("button", { name: /ещё раз через 45 с/i })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    const ready = screen.getByRole("button", { name: "Отправить код ещё раз" }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
  });
});

describe("LoginPage — восстановление пароля", () => {
  it("«Войти с паролем» → «Забыли пароль?» → код → новый пароль → вход", async () => {
    routes(
      {
        "/api/auth/request": answer({ sent: true }),
        "/api/auth/reset": answer({ user: { email: "ivan@firma.ru" } }),
      },
      true,
    );
    render(<LoginPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Войти с паролем" }));
    fireEvent.click(screen.getByRole("button", { name: /забыли пароль/i }));
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /получить код/i }));

    await screen.findByRole("group", { name: "Код из письма" });
    enterCode("123456");
    fill("Новый пароль", "новый-пароль-2");
    fireEvent.click(screen.getByRole("button", { name: /сохранить пароль и войти/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const call = vi.mocked(fetch).mock.calls.find((c) => String(c[0]) === "/api/auth/reset");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
      email: "ivan@firma.ru",
      code: "123456",
      password: "новый-пароль-2",
    });
  });
});

describe("LoginPage — без почтового сервера: пароль", () => {
  it("кода не предлагает: сразу вход по паролю, «Забыли пароль?» нет", async () => {
    routes({});
    render(<LoginPage />);
    await passwordForm();

    expect(screen.queryByRole("button", { name: /^продолжить$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /забыли пароль/i })).toBeNull();
  });

  it("верный пароль — переход дальше", async () => {
    routes({ "/api/auth/login": answer({ user: { email: "ivan@firma.ru" } }) });
    render(<LoginPage />);
    await passwordForm();
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "надёжный-пароль-1");
    fireEvent.click(screen.getByRole("button", { name: /^войти$/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
  });

  it("аккаунт уже прошёл онбординг — после входа сразу закупки", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const key = String(url);
      if (key === "/api/auth/me") return answer({ user: { email: "ivan@firma.ru" }, loginEnabled: true, codeLoginEnabled: false });
      if (key === "/api/me/data") {
        return answer({ searchProfiles: [], companyProfile: { name: "ООО Ромашка" }, appState: { onboardingDone: true } });
      }
      if (key === "/api/auth/login") return answer({ user: { email: "ivan@firma.ru" } });
      return answer({ error: "нет" }, 404);
    });
    render(<LoginPage />);
    await passwordForm();
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "надёжный-пароль-1");
    fireEvent.click(screen.getByRole("button", { name: /^войти$/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/tenders"));
  });

  it("неверный пароль — слова сервера, остаёмся на странице", async () => {
    routes({ "/api/auth/login": answer({ error: "Неверная почта или пароль." }, 400) });
    render(<LoginPage />);
    await passwordForm();
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "не-тот");
    fireEvent.click(screen.getByRole("button", { name: /^войти$/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/неверная почта или пароль/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("пароль можно показать и скрыть", async () => {
    routes({});
    render(<LoginPage />);
    const input = (await passwordForm()) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Показать пароль" }));
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Скрыть пароль" }));
    expect(input.type).toBe("password");
  });

  it("регистрация по паролю: «Создать аккаунт», пароли сверяются до отправки", async () => {
    routes({ "/api/auth/register": answer({ user: { email: "ivan@firma.ru" } }) });
    render(<LoginPage />);
    await passwordForm();
    fireEvent.click(screen.getByRole("button", { name: "Создать аккаунт" }));
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "надёжный-пароль-1");
    fill("Повторите пароль", "другой-пароль-2");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/не совпадают/);

    fill("Повторите пароль", "надёжный-пароль-1");
    fireEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("во время запроса кнопка занята и повторно не нажимается", async () => {
    let release: (value: Response) => void = () => undefined;
    vi.mocked(fetch).mockImplementation(async (url) => {
      const key = String(url);
      if (key === "/api/auth/me") return answer({ user: null, loginEnabled: true, codeLoginEnabled: false });
      if (key === "/api/auth/login") return new Promise<Response>((resolve) => { release = resolve; });
      return answer({ searchProfiles: [], companyProfile: null });
    });
    render(<LoginPage />);
    await passwordForm();
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "надёжный-пароль-1");
    fireEvent.click(screen.getByRole("button", { name: /^войти$/i }));

    const busyButton = await screen.findByRole("button", { name: /вхожу/i });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);
    release(answer({ user: { email: "ivan@firma.ru" } }));
    await waitFor(() => expect(push).toHaveBeenCalled());
  });
});

describe("LoginPage — возврат на страницу, с которой отправили на вход", () => {
  async function signIn() {
    routes(
      {
        "/api/auth/request": answer({ sent: true }),
        "/api/auth/verify": answer({ user: { email: "ivan@firma.ru" } }),
      },
      true,
    );
    render(<LoginPage />);
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^продолжить$/i }));
    await screen.findByRole("group", { name: "Код из письма" });
    enterCode("123456");
  }

  afterEach(() => window.history.pushState({}, "", "/"));

  it("безопасный next — после входа туда, а не на онбординг", async () => {
    window.history.pushState({}, "", "/login?next=%2Festimate%3FtenderId%3D1");
    await signIn();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/estimate?tenderId=1"));
  });

  it.each(["//evil.ru", "https://evil.ru", "/%2F/evil.ru", "/login"])(
    "опасный next %s игнорируется: обычная логика входа",
    async (next) => {
      window.history.pushState({}, "", `/login?next=${encodeURIComponent(next)}`);
      await signIn();

      await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
      expect(push).not.toHaveBeenCalledWith(next);
    },
  );
});

describe("LoginPage — код не уходит дважды", () => {
  it("шестая цифра и Enter сразу следом — один запрос проверки", async () => {
    let release: (value: Response) => void = () => undefined;
    vi.mocked(fetch).mockImplementation(async (url) => {
      const key = String(url);
      if (key === "/api/auth/me") return answer({ user: null, loginEnabled: true, codeLoginEnabled: true });
      if (key === "/api/auth/request") return answer({ sent: true });
      if (key === "/api/auth/verify") return new Promise<Response>((resolve) => { release = resolve; });
      return answer({ searchProfiles: [], companyProfile: null });
    });
    render(<LoginPage />);
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^продолжить$/i }));
    await screen.findByRole("group", { name: "Код из письма" });

    enterCode("123456");
    fireEvent.submit(screen.getByRole("group", { name: "Код из письма" }).closest("form")!);
    release(answer({ user: { email: "ivan@firma.ru" } }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(vi.mocked(fetch).mock.calls.filter((c) => String(c[0]) === "/api/auth/verify")).toHaveLength(1);
  });
});
