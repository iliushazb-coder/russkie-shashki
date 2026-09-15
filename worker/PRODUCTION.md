# Соответствие production-состоянию

Актуализировано: 2026-09-15.

Этот документ — текущая доказательная база пункта №1 MASTER PLAN. Он фиксирует
фактически подтверждённое production-состояние после завершения пунктов №1–44
и последующего production-deploy. Исторический baseline от 2026-09-02 сохранён
ниже отдельно, чтобы не смешивать старое и текущее состояние.

## Текущее production-состояние

### Cloudflare Worker

    Worker                    russkie-shashki-auth
    активная Version ID       455b5258-dc40-4ac3-8023-da6c62a5e353
    traffic                   100%
    production URL            https://russkie-shashki-auth.iliushazb.workers.dev
    compatibility_date        2026-08-30
    placement                 Default
    compatibility flags       отсутствуют
    cache                     Disabled
    способ последнего deploy  Wrangler CLI после успешного dry-run

Предшествующие production-версии в истории Cloudflare остаются доступными как
rollback-кандидаты; автоматически на них не откатываться. Конкретная Version ID
непосредственного предшественника в этом документе не фиксируется: независимого
подтверждения из Cloudflare на момент актуализации нет.

Отдельно отмечается: версия

    dd34b0fb-a4c3-48f0-9d08-9c07d20c31df

была более ранней TEMP diagnostic сборкой и НЕ является непосредственным
предшественником текущей cleanup-версии.

Последний production-deploy Worker был выполнен полным модульным графом:

    worker/index.mjs
    shared/game-engine.js

Проверенные локальные артефакты текущего repository state (пересчитаны на базе
runtime source c0cf301a557eccd7e5e1b9eaa969bdcc81658dc9):

    worker/index.mjs
      126 985 байт
      SHA-256 ab489937546ec40cb6dd66abd18f357dd3f6bacbab2c169e7b5a674ed6cc2668

    shared/game-engine.js
      27 307 байт
      SHA-256 37c7c2ebae6d7548c8b41e7dbbbff3285029526e25d2749a9fcc27bd1897973b

    worker/wrangler.toml
      2 105 байт
      SHA-256 0f085fe3e57289b7ec0e03e565d088adc82e929f5d0e855f0ef6400d8c42027f

Перед реальным deploy dry-run с compatibility_date 2026-08-30 прошёл без
предупреждений. Реальный cleanup-deploy завершился успешно: активная версия
455b5258-dc40-4ac3-8023-da6c62a5e353, traffic 100%, compatibility_date
2026-08-30 подтверждены. Этот deploy удалил только TEMP-диагностику
(PR #11) и не менял production-семантику.

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

Текущие production Rules задеплоены из состояния merge-коммита PR #10:

    3046c493b882452835b33fa00e9489d5cc9245c8

После cleanup PR #11 Rules НЕ менялись и повторно НЕ публиковались: cleanup
затрагивал только Worker и тесты. Проверено, что current main содержит тот же
blob `firebase/database.rules.json`, что и 3046c493 (blob abb07805).

Текущий canonical файл:

    firebase/database.rules.json
    43 317 байт
    SHA-256 a7b78795b4ac5f124bd33b9e0d2696456b273864229a1177b908ce98451af3f7

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

Source commit текущего deployed Worker runtime:

    c0cf301a557eccd7e5e1b9eaa969bdcc81658dc9

## История rated-настройки (закрыто)

Ранее в этом документе значился текущий P0: после surrender постоянные
`games/wins/losses/rating` не изменялись. Этот дефект **закрыт**.

Ручной production acceptance был завершён на post-fix production Worker ДО
cleanup и охватил:

    обычные онлайн-ходы
    ничья + Elo
    сдача + Elo
    timeout + Elo
    disconnect + Elo

Последующий cleanup-deploy (версия 455b5258-dc40-4ac3-8023-da6c62a5e353)
удалил только TEMP-диагностику и был semantics-neutral. Повторный ручной
gameplay-acceptance на 455b5258 отдельно не проводился.

Новых P0 в этом acceptance scope не заявляется: без доказательства такие
утверждения в этот документ не вносятся.

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
