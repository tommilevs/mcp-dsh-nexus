# MCP DSH Nexus / MCP для управления DeepSeek Harness

**English:** A local, permission-scoped MCP bridge for DeepSeek Harness Desktop.
**Русский:** Локальный MCP-мост с ограниченными правами для DeepSeek Harness Desktop.

> **Status / Статус:** early development (`0.1.0`). The source includes the HTTP host plugin, chat/session tools, a bilingual token panel, and an optional stdio adapter. Desktop installation still needs integration validation. There is no stable release or one-click installation yet. Screenshot capture, UI navigation, and settings/plugin changes are not implemented in this release.

> **По-русски:** исходники версии `0.1.0` находятся в разработке. HTTP-мост, инструменты чатов, панель токенов и stdio-адаптер проходят автоматические тесты; установка и работа в Desktop ещё требуют проверки. Скриншоты, навигация и изменение настроек/плагинов пока не реализованы.

## What works today / Что уже работает

The Host plugin mounts Streamable HTTP on DSH's existing loopback server at `/api/dsh-control-mcp/mcp`. It does not open another port. Each MCP client authenticates with its own bearer token and only sees the tools granted to that token.

Хост-плагин подключает Streamable HTTP к уже работающему локальному серверу DSH по адресу `/api/dsh-control-mcp/mcp`; отдельный порт не открывается. Каждый MCP-клиент проходит проверку своим bearer-токеном и видит только разрешённые этому токену инструменты.

Current tools cover DSH status, model/workspace/session listings, bounded text-only session history/follow, and chat create/send/wait/cancel. New chats use DSH's current default model; this bridge does not switch the global model. Session access is restricted to sessions granted to the token or created by it.

Сейчас доступны состояние DSH, списки моделей/рабочих областей/сессий, ограниченное чтение текстовой истории и ожидание новых сообщений, а также создание чата, отправка сообщения, ожидание ответа и отмена. Новый чат использует текущую модель DSH по умолчанию; мост не переключает глобальную модель. Токен может работать только с разрешёнными ему сессиями и сессиями, которые создал сам.

## Network and security / Сеть и безопасность

- The bridge requires DSH to listen on `127.0.0.1`. It rejects non-loopback peers, unexpected `Host`/`Origin`, forwarded headers, and requests without a bearer token.
- Do **not** expose this endpoint to your LAN or the Internet. Remote access requires a separately designed secure tunnel/TLS boundary.
- Client tokens are random, stored as digests in DSH's credential store, shown once at creation, and revocable. Keep each secret in the MCP client's secret store or environment; never put it in a URL or source control.
- Requests, sessions, body size, history, and concurrent tool calls are bounded. See [the security model](docs/security-model.md) for exact limits and caveats.

- Плагин требует, чтобы DSH слушал только `127.0.0.1`. Он отклоняет запросы не с loopback, неожиданные `Host`/`Origin`, forwarded-заголовки и запросы без bearer-токена.
- Не открывайте endpoint в локальную сеть или Интернет. Для удалённого доступа нужен отдельно спроектированный защищённый туннель/TLS.
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

Требования: Node.js 22, pnpm 10 и совместимая установленная версия DeepSeek Harness Desktop. Команды проверки и сборки приведены выше.

The source currently targets DSH's `0.1.7-rc.2` Host API packages. This repository is not yet a published npm package; do not treat the current branch as a stable production release. Installation instructions will be added after the token-management UI and client transports are verified against the desktop app.

Исходный код сейчас рассчитан на Host API DSH `0.1.7-rc.2`. Пакет ещё не опубликован в npm; текущую ветку не следует считать стабильной production-версией. Инструкции установки появятся после проверки UI управления токенами и клиентских транспортов в Desktop.

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
