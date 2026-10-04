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
