# Соответствие production-состоянию

Актуализировано: 2026-09-11.

Этот документ — текущая доказательная база пункта №1 MASTER PLAN. Он фиксирует
фактически подтверждённое production-состояние после завершения пунктов №1–44
и последующего production-deploy. Исторический baseline от 2026-09-02 сохранён
ниже отдельно, чтобы не смешивать старое и текущее состояние.

## Текущее production-состояние

### Cloudflare Worker

    Worker                    russkie-shashki-auth
    активная Version ID       db07d6a5-4067-4ac2-a2e7-d4b827e93218
    production URL            https://russkie-shashki-auth.iliushazb.workers.dev
    compatibility_date        2026-08-30
    placement                 Default
    compatibility flags       отсутствуют
    cache                     Disabled
    способ последнего deploy  Wrangler CLI после успешного dry-run

Предыдущая активная версия перед этим deploy:

    b4ddde49-7a6a-4ee4-9acd-75f8571fdbc7

Она остаётся только в истории Cloudflare как rollback-кандидат; автоматически
на неё не откатываться.

Последний production-deploy Worker был выполнен полным модульным графом:

    worker/index.mjs
    shared/game-engine.js

Проверенные локальные артефакты deploy-пакета:

    worker/index.mjs
      105 804 байт
      SHA-256 89cccf5b1c8ff33fc195a222ac85430cb763be881fdcde599f3da6b9c1398f8b

    shared/game-engine.js
      27 307 байт
      SHA-256 37c7c2ebae6d7548c8b41e7dbbbff3285029526e25d2749a9fcc27bd1897973b

    worker/wrangler.toml
      2 568 байт на момент deploy-пакета
      SHA-256 5647246062a119e009cba8851c96f8f7f48c6d40100d2a0da9f0a6c4f9223bee

Перед реальным deploy dry-run с compatibility_date 2026-08-30 прошёл без
предупреждений. Реальный deploy завершился успешно; `/rated/event` после него
работает в production, что подтверждено реальной онлайн-партией: вход, ходы и
взятия проходят корректно.

### Cloudflare bindings

В production подтверждены шесть несекретных переменных, соответствующих
`worker/wrangler.toml`:

    ALLOWED_ORIGINS
    FIREBASE_APP_ID
    FIREBASE_DB_URL
    FIREBASE_SERVICE_ACCOUNT_EMAIL
    FIREBASE_WEB_API_KEY
    TELEGRAM_AUTH_MAX_AGE_SECONDS

И два секрета только по именам:

    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY
    TELEGRAM_BOT_TOKEN

Значения секретов в репозитории отсутствуют и в этот документ не заносятся.
`APP_CHECK_REQUIRED` в production-конфигурации отсутствует; автоматически его
не добавлять и не менять.

### IAM / Service Account — проверка №7

Фактическое project-level IAM-состояние проверено вручную 2026-09-11 в
Google Cloud Console для проекта `russkie-shashki-online`.

Проверенная сервисная учётная запись:

    firebase-adminsdk-fbsvc@russkie-shashki-online.iam.gserviceaccount.com

На момент проверки у неё назначена ровно одна project-level роль:

    Firebase App Check Admin

Роли `Owner` и `Editor` отсутствуют. Других project-level ролей в окне
`Edit access` для этой сервисной учётной записи не отображалось.

По текущему `worker/index.mjs` IAM-зависим только путь выпуска App Check
токена. JWT подписываются локально приватным ключом сервисной учётной записи
через `crypto.subtle`; Worker не вызывает `iamcredentials`/`signBlob`, поэтому
`Service Account Token Creator` не требуется. Доступ к Realtime Database для
server-side settlement выполняется через Firebase ID token для
`uid=srv_settlement` и далее ограничивается Firebase Realtime Database Rules,
а не project-level IAM-ролью сервисной учётной записи.

В рамках этой проверки IAM-права не изменялись. Более узкую custom IAM role
сейчас не вводить: текущая специализированная роль не даёт Owner/Editor-доступа
к проекту, а изменение IAM во время незакрытой диагностики rated-settlement P0
создало бы лишний production-риск.

### Firebase Realtime Database Rules

Текущие production Rules опубликованы после завершения MASTER PLAN и затем
повторно опубликованы после диагностического rollback, когда было доказано,
что предыдущий баг с отскакивающим ходом вызван не Rules, а старой production-
версией Worker.

Текущий canonical файл:

    firebase/database.rules.json
    35 292 байт
    SHA-256 b00e10da4b8764a5973ee61ab15b21b1c2bdb6f344377b359c7ee897f7c81408

Production Rules соответствуют финальной архитектуре с `roomSpectators`,
`ratedEvents`, server-only settlement/stats boundaries и другими изменениями
MASTER PLAN №1–44.

### GitHub Pages / frontend

Frontend публикуется через GitHub Pages из `main`. После завершения №44
production frontend уже был актуальным; отдельный Firebase Hosting или
Firebase Functions deploy для этого проекта не используется.

Исходный финальный код №1–44 был на commit:

    364db6a66b90eb29f2d4f9ccf28dc7fec2eb1dba

После аудита PHASE 1 пункт №6 был исправлен отдельным CI-only commit:

    f89e695afc4b7b3d6e3374c308f2638cbd938006

Он меняет только `.github/workflows/backend.yml` и не меняет production-код
Worker, Firebase Rules или игровую логику.

## Известный текущий production-дефект

После обновления Worker онлайн-игра работает: вход, обычные ходы, взятия и
визуальное завершение через surrender подтверждены. Однако после surrender
постоянные `games/wins/losses/rating` не изменились. Причина settlement/final-
ization пока не доказана и не должна подменяться гипотезой. До диагностики
этот дефект считается P0 для rated-результатов.

## Исторический baseline 2026-09-02

До выполнения MASTER PLAN production был зафиксирован так:

    базовый commit клиента     f384b3364f341915bc89ccfbb5c5e8b5a36f4520
    активная Worker-версия     b4ddde49 (видимый Dashboard-префикс)
    Worker source              44 419 байт LF
    Worker SHA-256             b7d0d2ba5437dd88adbcfb46f3176843cb0ff5814a6fc3df688e3d7c8930ef08
    Rules source               16 751 байт в канонической форме
    Rules canonical SHA-256    63a46ac332726f8a121a3f9ceca053b17765d1d8ef3ea22a04d4d5d3578c8271
    compatibility_date         тогда ещё не была установлена

Этот baseline оставлен только как историческая точка сравнения. Он НЕ описывает
текущее production-состояние.

## Правила использования этого документа

- Не считать исторический baseline текущей production-версией.
- Перед следующим production deploy обновлять этот документ только по реально
  проверенным данным, без догадок.
- Не записывать значения секретов.
- Не выполнять rollback Worker автоматически.
- Любое изменение Worker, Firebase Rules или Cloudflare production-конфигурации
  требует отдельного явного согласования.
- Документационные изменения сами по себе не являются production deploy.
