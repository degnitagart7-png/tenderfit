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
  async redirects() {
    return [
      {
        /*
          Вход — список закупок, а не сводка. Человек приходит за ответом
          «что мне сегодня подать», и сводка этот ответ откладывала: сначала
          четыре блока с пересказом, список — ниже сгиба. Сводка осталась
          отдельной страницей «Сегодня».

          permanent: false намеренно — точка входа ещё может поменяться, а
          постоянный редирект браузеры кешируют намертво.
        */
        source: "/",
        destination: "/tenders",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
