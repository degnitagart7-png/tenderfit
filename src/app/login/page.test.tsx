import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import LoginPage from "@/app/login/page";

/**
 * Приветственная страница: вход по паролю, регистрация, вход по коду из письма.
 *
 * Пароль работает без почтового сервера, поэтому это основной путь. Код из
 * письма показывается, только когда сервер умеет отправлять письма. Почта
 * Google не принимается: об этом сказано до отправки, отказ сервера — его словами.
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

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

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

describe("LoginPage — вход по паролю", () => {
  it("приветствие, вкладки «Вход» и «Регистрация», поля пустые", () => {
    routes({});
    render(<LoginPage />);

    expect(screen.getByText("Добро пожаловать")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Вход" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Регистрация" })).toBeTruthy();
    expect((screen.getByLabelText("Почта") as HTMLInputElement).value).toBe("");
  });

  it("верный пароль — переход дальше", async () => {
    routes({ "/api/auth/login": answer({ user: { email: "ivan@firma.ru" } }) });
    render(<LoginPage />);
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "надёжный-пароль-1");

    fireEvent.click(screen.getByRole("button", { name: /^войти$/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
    const call = vi.mocked(fetch).mock.calls.find((c) => String(c[0]) === "/api/auth/login");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
      email: "ivan@firma.ru",
      password: "надёжный-пароль-1",
    });
  });

  it("неверный пароль — слова сервера, остаёмся на странице", async () => {
    routes({ "/api/auth/login": answer({ error: "Неверная почта или пароль." }, 400) });
    render(<LoginPage />);
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "не-тот");

    fireEvent.click(screen.getByRole("button", { name: /^войти$/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/неверная почта или пароль/i);
    expect(push).not.toHaveBeenCalled();
  });

  it("вход по коду не предлагается, пока сервер не умеет отправлять письма", async () => {
    routes({});
    render(<LoginPage />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /по коду/i })).toBeNull();
  });

  it("можно продолжить без входа", () => {
    routes({});
    render(<LoginPage />);

    expect((screen.getByRole("link", { name: /без входа/i }) as HTMLAnchorElement).getAttribute("href")).toBe("/tenders");
  });
});

describe("LoginPage — регистрация", () => {
  function openRegister() {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Регистрация" }));
  }

  it("успешная регистрация входит сразу", async () => {
    routes({ "/api/auth/register": answer({ user: { email: "ivan@firma.ru" } }) });
    openRegister();
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "надёжный-пароль-1");
    fill("Повторите пароль", "надёжный-пароль-1");
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const call = vi.mocked(fetch).mock.calls.find((c) => String(c[0]) === "/api/auth/register");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
      email: "ivan@firma.ru",
      password: "надёжный-пароль-1",
      consent: true,
    });
  });

  it("пароли не совпадают — на сервер не уходит", () => {
    routes({});
    openRegister();
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "надёжный-пароль-1");
    fill("Повторите пароль", "другой-пароль-2");
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));

    expect(screen.getByRole("alert").textContent).toMatch(/не совпадают/);
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]) === "/api/auth/register")).toBe(false);
  });

  it("короткий пароль и отсутствие согласия ловятся до отправки", () => {
    routes({});
    openRegister();
    fill("Почта", "ivan@firma.ru");
    fill("Пароль", "123");
    fill("Повторите пароль", "123");

    fireEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/не короче 8/);

    fill("Пароль", "надёжный-пароль-1");
    fill("Повторите пароль", "надёжный-пароль-1");
    fireEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/согласие/);
  });

  it("почта Google: о запрете сказано заранее, отказ сервера — его словами", async () => {
    routes({
      "/api/auth/register": answer({ error: "Регистрация с почтой Google (gmail.com) недоступна. Укажите другой адрес." }, 403),
    });
    openRegister();
    expect(screen.getByText(/gmail\.com\) недоступна/i)).toBeTruthy();
    fill("Почта", "ivan@gmail.com");
    fill("Пароль", "надёжный-пароль-1");
    fill("Повторите пароль", "надёжный-пароль-1");
    fireEvent.click(screen.getByRole("checkbox"));

    fireEvent.click(screen.getByRole("button", { name: /зарегистрироваться/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/укажите другой адрес/i);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("LoginPage — вход по коду из письма", () => {
  it("когда письма настроены: почта, код, переход дальше", async () => {
    routes(
      {
        "/api/auth/request": answer({ sent: true }),
        "/api/auth/verify": answer({ user: { email: "ivan@firma.ru" } }),
      },
      true,
    );
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole("button", { name: /по коду/i }));
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /получить код/i }));

    fireEvent.change(await screen.findByLabelText("Код из письма"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^войти$/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());
  });
});


describe("LoginPage — восстановление пароля", () => {
  it("«Забыли пароль?» есть только при настроенной почте", async () => {
    routes({});
    render(<LoginPage />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: /забыли пароль/i })).toBeNull();
  });

  it("почта → код → новый пароль → вход", async () => {
    routes(
      {
        "/api/auth/request": answer({ sent: true }),
        "/api/auth/reset": answer({ user: { email: "ivan@firma.ru" } }),
      },
      true,
    );
    render(<LoginPage />);
    fireEvent.click(await screen.findByRole("button", { name: /забыли пароль/i }));
    fill("Почта", "ivan@firma.ru");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /получить код/i }));

    fireEvent.change(await screen.findByLabelText("Код из письма"), { target: { value: "123456" } });
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
