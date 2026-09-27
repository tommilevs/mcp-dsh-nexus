import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {
	CreateClientTokenInput,
	TokenMetadata,
	TokenScope,
} from "@tommilevs/dsh-control-mcp-host";
import type {} from "@tommilevs/dsh-control-mcp-host/remote";
import React, { useEffect, useId, useState } from "react";

export type TokenSectionRemote = Context["remote"]["clientTokens"];

export interface TokenSectionProps {
	remote: TokenSectionRemote;
	clipboard?: Pick<Clipboard, "writeText">;
}

const grantableScopes: readonly TokenScope[] = [
	"status:read",
	"models:read",
	"workspaces:read",
	"sessions:list",
	"sessions:read",
	"sessions:follow",
	"chat:create",
	"chat:send",
	"chat:cancel",
];

const messages = {
	en: {
		language: "Language",
		english: "English",
		russian: "Русский",
		title: "MCP clients",
		trust:
			"DSH treats authenticated local API callers as one shared operator. Any local authenticated DSH API process has the same authority. New tokens can access only sessions they create.",
		clientName: "Client name",
		permissions: "Permissions",
		create: "Create token",
		loadingError: "Could not load MCP client metadata.",
		createError: "Could not create the MCP client token.",
		revokeError: "Could not revoke the MCP client token.",
		copyError: "Copy failed. The token is still available to select or retry.",
		clipboardUnavailable:
			"Clipboard access is unavailable. Select the token to copy it manually or retry later.",
		copyPrompt: "Copy this token now. It will not be shown again.",
		oneTimeToken: "One-time token",
		copy: "Copy token",
		dismiss: "Dismiss token",
		copied: "Token copied. It will not be shown again.",
		issued: "Issued clients",
		empty: "No client tokens have been issued.",
		none: "No permissions",
		active: "Active",
		revoked: "Revoked",
		revoke: (name: string) => `Revoke ${name}`,
	},
	ru: {
		language: "Язык",
		english: "English",
		russian: "Русский",
		title: "Клиенты MCP",
		trust:
			"DSH считает все аутентифицированные локальные API-процессы одним оператором с общими полномочиями. Новые токены получают доступ только к созданным ими сессиям.",
		clientName: "Имя клиента",
		permissions: "Разрешения",
		create: "Создать токен",
		loadingError: "Не удалось загрузить метаданные клиентов MCP.",
		createError: "Не удалось создать токен клиента MCP.",
		revokeError: "Не удалось отозвать токен клиента MCP.",
		copyError:
			"Не удалось скопировать токен. Его можно выделить вручную или повторить попытку.",
		clipboardUnavailable:
			"Буфер обмена недоступен. Выделите токен для ручного копирования или попробуйте позже.",
		copyPrompt: "Скопируйте токен сейчас. Позже он не будет показан.",
		oneTimeToken: "Одноразовый токен",
		copy: "Скопировать токен",
		dismiss: "Скрыть токен",
		copied: "Токен скопирован. Позже он не будет показан.",
		issued: "Созданные клиенты",
		empty: "Токены клиентов ещё не создавались.",
		none: "Нет разрешений",
		active: "Активен",
		revoked: "Отозван",
		revoke: (name: string) => `Отозвать ${name}`,
	},
} as const;

type Language = keyof typeof messages;

function initialLanguage(): Language {
	return typeof navigator !== "undefined" &&
		navigator.language.toLowerCase().startsWith("ru")
		? "ru"
		: "en";
}

function metadataResult(value: unknown): value is TokenMetadata[] {
	return Array.isArray(value);
}

export function TokenSection({ remote, clipboard }: TokenSectionProps) {
	const titleId = useId();
	const [tokens, setTokens] = useState<TokenMetadata[]>([]);
	const [displayName, setDisplayName] = useState("");
	const [scopes, setScopes] = useState<TokenScope[]>([]);
	const [newToken, setNewToken] = useState<string | null>(null);
	const [language, setLanguage] = useState<Language>(initialLanguage);
	const [busy, setBusy] = useState(false);
	const [copying, setCopying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const t = messages[language];

	useEffect(() => {
		let active = true;
		void remote
			.listTokenMetadata()
			.then((result) => {
				if (!active) return;
				if (!result.ok || !metadataResult(result.value)) {
					setError(t.loadingError);
					return;
				}
				setTokens(result.value);
			})
			.catch(() => {
				if (active) setError(t.loadingError);
			});
		return () => {
			active = false;
		};
	}, [remote, t.loadingError]);

	async function createToken() {
		if (busy || newToken !== null) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		const input: CreateClientTokenInput = { displayName, scopes };
		try {
			const result = await remote.createClientToken(input);
			if (!result.ok) {
				setError(t.createError);
				return;
			}
			setNewToken(result.value.token);
			setTokens((current) => [result.value.metadata, ...current]);
			setDisplayName("");
			setScopes([]);
		} catch {
			setError(t.createError);
		} finally {
			setBusy(false);
		}
	}

	async function copyNewToken() {
		if (!newToken || copying) return;
		const writer = clipboard ?? navigator.clipboard;
		if (!writer?.writeText) {
			setError(t.clipboardUnavailable);
			return;
		}
		setCopying(true);
		setError(null);
		try {
			await writer.writeText(newToken);
			setNewToken(null);
			setNotice(t.copied);
		} catch {
			// Preserve the only plaintext copy until the user can copy or dismiss it.
			setError(t.copyError);
		} finally {
			setCopying(false);
		}
	}

	async function revokeToken(id: string) {
		setBusy(true);
		setError(null);
		try {
			const result = await remote.revokeClientToken(id);
			if (!result.ok) {
				setError(t.revokeError);
				return;
			}
			setTokens((current) =>
				current.map((token) =>
					token.id === id ? { ...token, revoked: true } : token,
				),
			);
		} catch {
			setError(t.revokeError);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section aria-labelledby={titleId}>
			<div>
				<span>{t.language}: </span>
				<button
					aria-pressed={language === "en"}
					onClick={() => setLanguage("en")}
					type="button"
				>
					{t.english}
				</button>
				<button
					aria-pressed={language === "ru"}
					onClick={() => setLanguage("ru")}
					type="button"
				>
					{t.russian}
				</button>
			</div>
			<h2 id={titleId}>{t.title}</h2>
			<p>{t.trust}</p>

			<form
				onSubmit={(event) => {
					event.preventDefault();
					void createToken();
				}}
			>
				<label>
					{t.clientName}
					<input
						value={displayName}
						onChange={(event) => setDisplayName(event.target.value)}
						required
					/>
				</label>
				<fieldset>
					<legend>{t.permissions}</legend>
					{grantableScopes.map((scope) => (
						<label key={scope}>
							<input
								aria-label={scope}
								type="checkbox"
								checked={scopes.includes(scope)}
								onChange={(event) =>
									setScopes((current) =>
										event.target.checked
											? [...current, scope]
											: current.filter((value) => value !== scope),
									)
								}
							/>
							{scope}
						</label>
					))}
				</fieldset>
				<button
					disabled={busy || newToken !== null || !displayName.trim()}
					type="submit"
				>
					{t.create}
				</button>
			</form>

			{newToken !== null && (
				<div>
					<p>{t.copyPrompt}</p>
					<input
						aria-label={t.oneTimeToken}
						onFocus={(event) => event.currentTarget.select()}
						readOnly
						value={newToken}
					/>
					<button
						disabled={copying}
						onClick={() => void copyNewToken()}
						type="button"
					>
						{t.copy}
					</button>
					<button
						disabled={copying}
						onClick={() => setNewToken(null)}
						type="button"
					>
						{t.dismiss}
					</button>
				</div>
			)}
			{notice && <output>{notice}</output>}
			{error && <p role="alert">{error}</p>}

			<h3>{t.issued}</h3>
			{tokens.length === 0 ? (
				<p>{t.empty}</p>
			) : (
				<ul>
					{tokens.map((token) => (
						<li key={token.id}>
							<strong>{token.displayName}</strong>
							<span>{token.scopes.join(", ") || t.none}</span>
							<span>{token.revoked ? t.revoked : t.active}</span>
							{!token.revoked && (
								<button
									disabled={busy}
									onClick={() => void revokeToken(token.id)}
									type="button"
								>
									{t.revoke(token.displayName)}
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
