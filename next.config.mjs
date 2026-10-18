/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // Линт запускается отдельной командой npm run lint
    ignoreDuringBuilds: true,
  },
  typescript: {
    /*
      Сборка проверяет типы по tsconfig.build.json — по тому коду, который
      реально уезжает на сайт. Проверка НЕ отключена (ignoreBuildErrors не
      выставлен): ошибка в любом маршруте, компоненте или сервисе по-прежнему
      роняет сборку. Из охвата выведены только тесты, оффлайновые скрипты и
      незавершённый расчёт сметы — см. комментарий в самом tsconfig.build.json.
    */
    tsconfigPath: "tsconfig.build.json",
  },
  /*
    Корень сайта — промо-страница (src/app/route.ts), а не кабинет. Прежний
    редирект «/ → /tenders» убран: гость попадал сразу в форму входа и не видел,
    что сервис делает. Вошедший человек открывает кабинет кнопкой «Войти» и по
    своим адресам (/tenders, /dashboard).
  */
};

export default nextConfig;
