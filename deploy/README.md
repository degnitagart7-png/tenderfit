# Развёртывание TenderFit

Сервис работает на одном сервере в России. Российский адрес — не удобство, а
условие работы: ЕИС и Сбербанк-АСТ зарубежным IP не отвечают, а filestore
zakupki.gov.ru не отдаёт документы.

## Что где работает

```
tender-fit.ru
  └─ nginx (80/443, сертификат Let's Encrypt)
       └─ 127.0.0.1:3000 — tenderfit-app.service   (Next.js, веб-приложение)
          /opt/tenderfit-ai — общее дерево кода
       └─ tenderfit-worker.service                 (прогон источников, очередь заданий)
```

Обе службы работают из одной папки и от пользователя `tenderfit`, поэтому один
деплой обновляет код для обеих. Данные лежат во внешнем Supabase.

Раньше приложение жило на Vercel, а этот сервер только проксировал на него.
От схемы отказались: запрос уходил за рубеж и возвращался, хотя и клиент, и
база, и источники находятся в России.

## Ключи

| Файл | Кому | Права |
| --- | --- | --- |
| `/etc/tenderfit/app.env` | приложению | `640 root:tenderfit` |
| `/etc/tenderfit/worker.env` | воркеру | `640 root:tenderfit` |

В дереве проекта ключей нет и быть не должно: оба скрипта деплоя исключают
любые `.env*` из архива и прерываются, если такой файл в него всё же попал.

Образцы состава — `worker.env.example`. Приложению дополнительно нужны
`LLM_*` и `NEXT_PUBLIC_SITE_URL`.

## Обычный деплой

```bash
TENDERFIT_VPS=root@5.35.86.186 deploy/deploy-app.sh
```

Скрипт собирает архив исходников, ставит зависимости, собирает Next.js,
перезапускает `tenderfit-app` и проверяет, что приложение ответило. Сборка идёт,
пока старая версия обслуживает запросы, — наружу меняется только момент
перезапуска.

Воркер по умолчанию не трогается: перезапуск прерывает текущее задание.
Когда это уместно, добавьте `--with-worker` или перезапустите вручную.

Только код воркера, без сборки приложения:

```bash
TENDERFIT_VPS=root@5.35.86.186 deploy/deploy-worker.sh --restart
```

## Первая установка

```bash
# папка под код
sudo install -d -o tenderfit -g tenderfit /opt/tenderfit-ai

# ключи
sudo install -d -m 750 -o root -g tenderfit /etc/tenderfit
sudo cp deploy/worker.env.example /etc/tenderfit/worker.env   # заполнить
sudo chmod 640 /etc/tenderfit/worker.env
sudo chown root:tenderfit /etc/tenderfit/worker.env

# службы
sudo cp deploy/tenderfit-app.service deploy/tenderfit-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tenderfit-app tenderfit-worker

# nginx и сертификат
sudo cp deploy/nginx-tenderfit.conf /etc/nginx/sites-available/tenderfit-proxy
sudo ln -sf /etc/nginx/sites-available/tenderfit-proxy /etc/nginx/sites-enabled/
sudo certbot --nginx -d tender-fit.ru
sudo nginx -t && sudo systemctl reload nginx
```

## Незакрытое: воркер берёт разбор у Vercel

`SYNC_BASE_URL` в `/etc/tenderfit/worker.env` указывает на
`https://tenderfit-ai-sage.vercel.app`. Причина, записанная там же, устарела:
ключ модели теперь лежит в `/etc/tenderfit/app.env` на этом же сервере, и
приложение отвечает на `POST /api/estimate/bill-rows` само — проверено.

Пока адрес прежний, запрос на разбор ведомости уходит за рубеж и возвращается,
а код на Vercel живёт своей жизнью и отстаёт: смета считается тем разбором,
который был развёрнут туда последним, а не тем, что лежит в `/opt/tenderfit-ai`.

```bash
sudo cp /etc/tenderfit/worker.env /etc/tenderfit/worker.env.bak
sudo sed -i 's|^SYNC_BASE_URL=.*|SYNC_BASE_URL=http://127.0.0.1:3000|' /etc/tenderfit/worker.env
sudo systemctl restart tenderfit-worker
journalctl -u tenderfit-worker -n 5 --no-pager
```

В журнале после перезапуска должно стоять `прод http://127.0.0.1:3000`. Откат —
вернуть `worker.env.bak` на место и перезапустить воркер.

## Ценовые зоны: ночное обновление и сборка по требованию

Цены считаются по ценовой зоне ФГИС ЦС (около 157 зон). Каждая зона — каталог
`data/fsnb/index/zones/<id>/` (текущие цены, сплит-форма, ставки, сметные цены перевозки и
погрузки), около 21 МБ; полный набор — около 3,3 ГБ. Собирается он на сервере: ФГИС ЦС отвечает
только российским адресам.

Две службы собирают зоны, и обе пользуются одним замком `data/fsnb/zones-build.lock` — одна сборка
за раз:

- `tenderfit-zones.timer` — раз в сутки в 02:30 запускает `build-all-zones.ts`. Он берёт справочник
  зон и последний период каждой; собирает недостающие и устаревшие (период в `zone.json` не равен
  последнему), остальные пропускает. Сбой одной зоны не останавливает остальные, в конце — итог
  (собрано, пропущено, ошибки, размер на диске), код выхода 1, если ошибки были. Новый квартал
  пересобирает все зоны за несколько ночей: после 7 часов (`--max-minutes 420`) новые зоны не
  начинаются, остальные — следующей ночью.
- воркер: расчёт для зоны, которой нет на диске, не падает, а собирает её (скачивание и сборка
  дочерним процессом, до 20 минут) и считает дальше.

Зона собирается во временный каталог (`zones/.build-<id>-<pid>`) и подменяет `zones/<id>`
переименованием, поэтому расчёт не прочитает полусобранную зону. Скачанное сырьё удаляется после
удачной сборки (`--keep-raw` — оставить).

### Включить

```bash
# 1. data/ должен принадлежать пользователю служб: зоны, собранные раньше от root, они не заменят
sudo chown -R tenderfit:tenderfit /opt/tenderfit-ai/data

# 2. таймер ночного обновления
sudo cp deploy/tenderfit-zones.service deploy/tenderfit-zones.timer /etc/systemd/system/
# 3. воркеру нужна запись в data/ (сборка по требованию): ReadWritePaths обновлён в юните
sudo cp deploy/tenderfit-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tenderfit-zones.timer
sudo systemctl restart tenderfit-worker        # прервёт текущее задание

systemctl list-timers tenderfit-zones.timer
```

### Проверить и запустить вручную

```bash
cd /opt/tenderfit-ai

# что было бы собрано (запросы только к справочнику и периодам, ничего не скачивается и не пишется)
sudo -u tenderfit node_modules/.bin/tsx scripts/fsnb/build-all-zones.ts --dry-run

# первая полная сборка: надолго, запускать в tmux/screen, а не из ssh-сессии без защиты от обрыва
sudo -u tenderfit node_modules/.bin/tsx scripts/fsnb/build-all-zones.ts

# отдельные зоны, в том числе принудительно
sudo -u tenderfit node_modules/.bin/tsx scripts/fsnb/build-all-zones.ts --only 246,282 --force

# ночной запуск вне расписания и его журнал
sudo systemctl start tenderfit-zones.service
journalctl -u tenderfit-zones -n 200 --no-pager
```

Флаги `build-all-zones.ts`: `--only <ids>`, `--force`, `--dry-run`, `--pause <мс>` (между запросами,
по умолчанию 2000), `--max-minutes <N>`, `--keep-raw`, `--lock-wait-minutes <N>`.

### Если что-то не так

- «замок сборки занят» — сборку держит другой процесс: `cat /opt/tenderfit-ai/data/fsnb/zones-build.lock`.
  Замок брошенного процесса (его pid на этой машине не существует) или старше часа снимается сам;
  вручную — `rm` файла, когда точно ничего не собирается.
- `Permission denied` при записи в `data/fsnb` — каталог принадлежит root (первый пункт выше).
- Сборка по требованию «не уложилась в 20 минут» — расчёт упал с этой причиной; зону можно
  собрать вручную командой из сообщения и повторить расчёт.

## Метод БИМ: ФЕР-2020 и индексы Минстроя

Базисно-индексный метод (ФЕР-2001 в ценах 01.01.2000 × индексы письма Минстроя по субъекту и объекту) берёт два набора
данных, оба собираются на сервере (ФГИС ЦС — только российские адреса, `data/` на сервер не выкладывается):

- ФЕР-2020 — `data/fsnb/index/fer2020/` (расценки, ФССЦ, ФСЭМ, перевозка; ~60 МБ). Собирает
  `scripts/fsnb/build-fer2020.ts`: сам скачивает архив «ФСНБ-2020 включая дополнение №9» (13 МБ,
  `…/GetFileContent/6b5f31bd-879d-4578-bb7e-bcfb64cd8bbf`), ~3 с, пик памяти ~0,4 ГБ RSS. Без сети —
  `--from-file fsnb2020.zip`.
- индексы письма Минстроя — `data/fsnb/index/bim-indices/bim-indices-<год>q<кв>.json`. Собирает
  `scripts/fsnb/fetch-bim-indices.ts`: обходит дерево ФГИС ЦС (годы → кварталы → «по объектам строительства»),
  скачивает письма, `pdftotext -layout`, разбор. Письма III квартала 2026 года уже лежат в приложении (справочник
  `normativesData/bim-indices-2026q3.json`), поэтому расчёт работает и без этого шага; следующие кварталы подтянет он.

Оба шага вшиты в `tenderfit-zones.service` как `ExecStartPre=-…` (сбой не отменяет обновление зон; нового нет — секунды).
Нужен `pdftotext`: `sudo apt install poppler-utils`.

```bash
cd /opt/tenderfit-ai
sudo -u tenderfit node_modules/.bin/tsx scripts/fsnb/build-fer2020.ts                 # один раз вручную
sudo -u tenderfit node_modules/.bin/tsx scripts/fsnb/fetch-bim-indices.ts --dump-tree # что вернул сервер: проверить имена папок
sudo -u tenderfit node_modules/.bin/tsx scripts/fsnb/fetch-bim-indices.ts             # последний квартал
```

Метод расчёта смета выбирает по документации заказчика (смета на ФЕР/ТЕР, слова «базисно-индексный метод»), пользователь может
переопределить его в карточке закупки. Нет `fer2020/` — выбранный вручную БИМ отказывает с командой сборки, а выведенный из документов
заказчика считается ресурсным методом с пометкой в смете; аудит такой сметы называет причину в «не проверено построчно».
Воркер после правки обязательно перезапустить (`deploy/deploy-worker.sh --restart`): без него метод в задании игнорируется
(минимальная версия воркера в `src/app/api/estimate/route.ts` поднята). Поиск расценок ФЕР при правке ведомости идёт в приложении
(`/api/estimate/norms?method=BASE_INDEX`): первый запрос после рестарта читает 52 тыс. расценок (~150 МБ памяти процесса приложения).

Формат ответа дерева ФГИС ЦС до запуска на сервере не проверялся (с машины разработчика сеть не доходит): если
`fetch-bim-indices.ts` пишет «писем не найдено», `--dump-tree` покажет узлы, а `--guid <узел>`, `--year`,
`--quarter` позволят начать с нужного места.

## Если что-то сломалось

Состояние и журналы:

```bash
systemctl status tenderfit-app tenderfit-worker nginx
journalctl -u tenderfit-app -n 50 --no-pager
journalctl -u tenderfit-worker -n 50 --no-pager
```

Откат на Vercel — прежний конфиг сохранён рядом:

```bash
sudo cp /etc/nginx/sites-available/tenderfit-proxy.vercel \
        /etc/nginx/sites-available/tenderfit-proxy
sudo nginx -t && sudo systemctl reload nginx
```

Развёртывание на Vercel остаётся рабочим и примет трафик сразу.

## package-lock.json собирается на Linux

`npm ci` требует, чтобы lock точно соответствовал платформе: часть
зависимостей подтягивает разные двоичные сборки под разные системы, а вместе
с ними — разные версии их собственных зависимостей. Lock, собранный на
Windows, линуксовых веток не содержит, и на сервере `npm ci` отказывал с
`EUSAGE` («Missing: @emnapi/core@1.11.3 from lock file»).

Действующий lock собран на Linux и проверен на обеих системах: `npm ci`
проходит и на сервере, и на Windows.

Если понадобится пересобрать — делайте это на Linux, не на рабочей машине:

```bash
# на сервере
cd /opt/tenderfit-ai && npm install --package-lock-only
# затем забрать файл к себе и положить в репозиторий
```

Пересборка на Windows проблему не решает: npm просто не видит линуксовых
веток дерева и снова запишет версии своей платформы.

Скрипт деплоя к отказу `npm ci` устойчив — он откатывается на `npm install` и
громко об этом пишет, так что рассинхрон lock останавливает не деплой, а
только воспроизводимость установки.
