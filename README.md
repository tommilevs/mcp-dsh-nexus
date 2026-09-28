# MCP DSH Nexus / MCP для управления DeepSeek Harness

**English:** A local, permission-scoped MCP bridge for DeepSeek Harness Desktop.
**Русский:** Локальный MCP-мост с ограниченными правами для DeepSeek Harness Desktop.

> **Status / Статус:** early development (`0.1.1`). The source includes the HTTP host plugin, chat/session tools, a bilingual token and listener panel, a dedicated MCP-only HTTP listener, and an optional stdio adapter. The plugin has been installed and activated in DSH Desktop 2.0.14; compatibility with other Desktop versions still needs checking. There is no stable public package release or one-click marketplace installation yet. Screenshot capture, UI navigation, and settings/plugin changes are not implemented in this release.

> **По-русски:** исходники версии `0.1.1` находятся в ранней разработке. В них есть HTTP-мост, инструменты чатов, двуязычная панель токенов и отдельный MCP-only HTTP listener, а также stdio-адаптер. Плагин установлен и активирован в DSH Desktop 2.0.14; совместимость с другими версиями Desktop нужно проверять отдельно. Публичный пакет и установка из каталога пока не опубликованы. Скриншоты, навигация и изменение настроек/плагинов пока не реализованы.

## What works today / Что уже работает

The Host plugin preserves DSH's existing loopback-only route at `/api/dsh-control-mcp/mcp` and can also open a dedicated listener on a selected local or private IPv4 address. That listener serves only the MCP path; it does not expose the rest of DSH's web server. Each MCP client authenticates with its own bearer token and only sees the tools granted to that token.

Хост-плагин сохраняет локальный маршрут DSH по адресу `/api/dsh-control-mcp/mcp` и может открыть отдельный listener на выбранном локальном или частном IPv4-адресе. Через него доступен только MCP-маршрут — остальные страницы и API DSH не публикуются. Каждый MCP-клиент проходит проверку своим bearer-токеном и видит только разрешённые этому токену инструменты.

Current tools cover DSH status, model/workspace/session listings, bounded text-only session history/follow, and chat create/send/wait/cancel. New chats use DSH's current default model; this bridge does not switch the global model. Session access is restricted to sessions granted to the token or created by it.

Сейчас доступны состояние DSH, списки моделей/рабочих областей/сессий, ограниченное чтение текстовой истории и ожидание новых сообщений, а также создание чата, отправка сообщения, ожидание ответа и отмена. Новый чат использует текущую модель DSH по умолчанию; мост не переключает глобальную модель. Токен может работать только с разрешёнными ему сессиями и сессиями, которые создал сам.

## Network and security / Сеть и безопасность

- DSH's existing web server remains bound to `127.0.0.1`. The dedicated listener can bind to loopback or a selected RFC1918 IPv4 address and serves only the MCP route. LAN binding always requires bearer authentication.
- Bearer authentication is enabled by default. Disabling it forces the dedicated listener to `127.0.0.1`; an unauthenticated LAN listener is rejected.
- LAN mode uses plain HTTP. Use it only on a trusted private network, restrict inbound access with the Windows firewall, and never forward the port from your router or expose it to the public Internet. For untrusted networks use a separately secured VPN/TLS tunnel.
- The listener rejects unexpected peers, `Host`/`Origin`, and forwarded headers. It does not enable CORS.
- Client tokens are random, stored as digests in DSH's credential store, shown once at creation, and revocable. Keep each secret in the MCP client's secret store or environment; never put it in a URL or source control.
- Requests, sessions, body size, history, and concurrent tool calls are bounded. See [the security model](docs/security-model.md) for exact limits and caveats.

- Основной веб-сервер DSH остаётся на `127.0.0.1`. Отдельный listener можно привязать к loopback или выбранному частному IPv4-адресу; через него доступен только MCP-маршрут. Для LAN bearer-аутентификация обязательна.
- Требование bearer-токена включено по умолчанию. При его отключении listener принудительно переключается на `127.0.0.1`; неаутентифицированный доступ по LAN запрещён.
- В режиме LAN используется обычный HTTP. Подключайся только из доверенной частной сети, ограничь входящие подключения брандмауэром Windows и не пробрасывай порт на роутере и в Интернет. Для недоверенной сети используй отдельно защищённый VPN/TLS-туннель.
- Listener отклоняет запросы от посторонних адресов, неожиданные `Host`/`Origin` и forwarded-заголовки. CORS не включён.
- Случайные токены клиентов хранятся в хранилище учётных данных DSH только в виде хеша, показываются один раз и могут быть отозваны. Храните секрет в менеджере секретов MCP-клиента или в переменной окружения, но не в URL и не в Git.
- Для запросов, сессий, размера тела, истории и параллельных вызовов установлены ограничения. Точные значения и оговорки — в [модели безопасности](docs/security-model.md).

## Build / Сборка

Requirements: Node.js 22, pnpm 10, and a compatible DeepSeek Harness Desktop installation. From this repository:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
```

## Install in DSH / Установка в DSH

The Host and Client are separate packages. Build them with `pnpm build`, then pack both workspaces with `pnpm --filter @tommilevs/dsh-control-mcp-host pack` and `pnpm --filter @tommilevs/dsh-control-mcp-client pack`. In DSH Desktop, use the plugin manager's local package installation for both tarballs, then restart Desktop. The Client package is loaded by DSH's plugin marketplace metadata; do not add it as a second Cordis profile bundle.

После `pnpm build` собери Host и Client отдельно командами `pnpm --filter @tommilevs/dsh-control-mcp-host pack` и `pnpm --filter @tommilevs/dsh-control-mcp-client pack`. Установи оба tarball-пакета через локальную установку в менеджере плагинов DSH и перезапусти Desktop. Client загружается через метаданные каталога плагинов DSH — не добавляй его второй раз в список Cordis-плагинов профиля.

After activation, open the plugin's settings panel. The dedicated listener defaults to `127.0.0.1:43121` with bearer authentication enabled. To allow a LAN client, choose the computer's private IPv4 address, keep bearer authentication enabled, save, and create a client token. The panel displays the MCP endpoint; configure the client with that endpoint and the token in its `Authorization: Bearer …` header. Allow inbound TCP on that port only for trusted devices using the Windows Firewall. Do not expose it through router port forwarding.

После запуска открой панель настроек плагина. Отдельный listener по умолчанию привязан к `127.0.0.1:43121`, bearer-аутентификация включена. Чтобы подключить клиента из LAN, выбери частный IPv4-адрес этого компьютера, оставь bearer включённым, сохрани настройки и создай токен клиента. Панель покажет MCP-адрес; укажи его в клиенте и передавай токен заголовком `Authorization: Bearer …`. Разреши входящий TCP-порт только доверенным устройствам в брандмауэре Windows. Не пробрасывай порт через роутер.

Требования: Node.js 22, pnpm 10 и совместимая установленная версия DeepSeek Harness Desktop. Команды проверки и сборки приведены выше.

The source currently targets DSH's `0.1.7-rc.2` Host API packages. This repository is not yet a published npm package; do not treat the current branch as a stable production release. The local package procedure above was exercised with DSH Desktop 2.0.14.

Исходный код сейчас рассчитан на Host API DSH `0.1.7-rc.2`. Пакет ещё не опубликован в npm; текущую ветку не следует считать стабильной production-версией. Локальная установка по инструкции выше проверена на DSH Desktop 2.0.14.

## Roadmap / План работ

- Validate the token-management panel and installation against DSH Desktop.
- [Configure the optional stdio adapter](packages/stdio/README.md) for clients that cannot use HTTP.
- Add screenshots/navigation only if DSH exposes a safe, typed Desktop capability.
- Add settings/plugin read and propose/apply operations with explicit confirmation.

- Проверить панель токенов и установку в DSH Desktop.
- [Настроить готовый stdio-адаптер](packages/stdio/README.md) для клиентов без поддержки HTTP.
- Добавлять скриншоты и навигацию только при наличии безопасного типизированного API в DSH.
- Добавить чтение настроек/плагинов и операции «предложить / применить» с явным подтверждением.

See the [architecture and capability spec](docs/dsh-desktop-mcp-spec.md) for the longer-term design, and [the security model](docs/security-model.md) for current boundaries.
