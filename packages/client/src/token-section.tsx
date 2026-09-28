import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@tommilevs/dsh-control-mcp-host/remote";
import type {
	CreateClientTokenInput,
	ListenerPreferences,
	ListenerStatus,
	TokenMetadata,
	TokenScope,
} from "@tommilevs/dsh-control-mcp-host/types";
import React, { useEffect, useId, useState } from "react";

type ClientTokensRemote = Context["remote"]["clientTokens"];
export type TokenSectionRemote = Pick<
	ClientTokensRemote,
	"listTokenMetadata" | "createClientToken" | "revokeClientToken"
> &
	Partial<
		Pick<
			ClientTokensRemote,
			"getListenerPreferences" | "getListenerStatus" | "setListenerPreferences"
		>
	>;

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
		listener: "HTTP listener",
		listenerEnabled: "Enable dedicated MCP listener",
		bindAddress: "Listen on this address",
		port: "Port",
		requireBearer: "Require bearer token",
		localOnlyHint:
			"Without a bearer token, the listener is restricted to this computer.",
		httpWarning:
			"LAN access uses plain HTTP. Other devices on the network may be able to read the token and traffic. Use only on a trusted private network and do not forward this port from your router.",
		listenerUrl: "MCP URL",
		listenerStopped: "Listener is disabled.",
		listenerError:
			"Listener could not use the requested address or port. It fell back to authenticated localhost when possible.",
		listenerSave: "Save listener settings",
		listenerSaveError: "Could not save listener settings.",
		listenerUnsupported: "Update the DSH Host plugin to manage this listener.",
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
		listener: "HTTP-подключение",
		listenerEnabled: "Включить отдельный MCP listener",
		bindAddress: "Слушать на этом адресе",
		port: "Порт",
		requireBearer: "Требовать bearer-токен",
		localOnlyHint:
			"Без bearer-токена listener доступен только на этом компьютере.",
		httpWarning:
			"Для доступа по LAN используется обычный HTTP. Другие устройства в сети могут перехватить токен и трафик. Используй этот режим только в доверенной частной сети и не настраивай проброс порта на роутере.",
		listenerUrl: "MCP URL",
		listenerStopped: "Listener отключён.",
		listenerError:
			"Не удалось открыть выбранный адрес или порт. Если возможно, включён безопасный резервный режим с bearer-токеном на localhost.",
		listenerSave: "Сохранить настройки listener",
		listenerSaveError: "Не удалось сохранить настройки listener.",
		listenerUnsupported: "Обнови Host-плагин DSH, чтобы управлять listener.",
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
	const [listenerPreferences, setListenerPreferences] =
		useState<ListenerPreferences | null>(null);
	const [listenerStatus, setListenerStatus] = useState<ListenerStatus | null>(
		null,
	);
	const [displayName, setDisplayName] = useState("");
	const [scopes, setScopes] = useState<TokenScope[]>([]);
	const [newToken, setNewToken] = useState<string | null>(null);
	const [language, setLanguage] = useState<Language>(initialLanguage);
	const [busy, setBusy] = useState(false);
	const [listenerBusy, setListenerBusy] = useState(false);
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

	useEffect(() => {
		let active = true;
		const getPreferences = remote.getListenerPreferences;
		const getStatus = remote.getListenerStatus;
		if (!getPreferences || !getStatus) {
			setError(t.listenerUnsupported);
			return () => {
				active = false;
			};
		}
		void Promise.all([getPreferences.call(remote), getStatus.call(remote)])
			.then(([preferences, status]) => {
				if (!active) return;
				if (preferences.ok) setListenerPreferences(preferences.value);
				if (status.ok) setListenerStatus(status.value);
			})
			.catch(() => {
				if (active) setError(t.listenerSaveError);
			});
		return () => {
			active = false;
		};
	}, [remote, t.listenerSaveError, t.listenerUnsupported]);

	async function saveListenerPreferences() {
		if (!listenerPreferences || listenerBusy) return;
		setListenerBusy(true);
		setError(null);
		try {
			const setPreferences = remote.setListenerPreferences;
			if (!setPreferences) {
				setError(t.listenerUnsupported);
				return;
			}
			const result = await setPreferences.call(remote, listenerPreferences);
			if (!result.ok) {
				setError(t.listenerSaveError);
				return;
			}
			setListenerStatus(result.value);
			setListenerPreferences(result.value.preferences);
		} catch {
			setError(t.listenerSaveError);
		} finally {
			setListenerBusy(false);
		}
	}

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

			<h3>{t.listener}</h3>
			{listenerPreferences && (
				<fieldset disabled={listenerBusy}>
					<label>
						<input
							checked={listenerPreferences.enabled}
							onChange={(event) =>
								setListenerPreferences({
									...listenerPreferences,
									enabled: event.target.checked,
								})
							}
							type="checkbox"
						/>
						{t.listenerEnabled}
					</label>
					<label>
						{t.bindAddress}
						<select
							value={listenerPreferences.host}
							onChange={(event) =>
								setListenerPreferences({
									...listenerPreferences,
									host: event.target.value,
									requireBearer:
										event.target.value === "127.0.0.1"
											? listenerPreferences.requireBearer
											: true,
								})
							}
						>
							{[
								...new Set([
									"127.0.0.1",
									...(listenerStatus?.availableAddresses ?? []),
									listenerPreferences.host,
								]),
							].map((address) => (
								<option key={address} value={address}>
									{address}
								</option>
							))}
						</select>
					</label>
					<label>
						{t.port}
						<input
							max={65535}
							min={1024}
							onChange={(event) =>
								setListenerPreferences({
									...listenerPreferences,
									port: Number(event.target.value),
								})
							}
							type="number"
							value={listenerPreferences.port}
						/>
					</label>
					<label>
						<input
							checked={listenerPreferences.requireBearer}
							onChange={(event) =>
								setListenerPreferences({
									...listenerPreferences,
									requireBearer: event.target.checked,
									host: event.target.checked
										? listenerPreferences.host
										: "127.0.0.1",
								})
							}
							type="checkbox"
						/>
						{t.requireBearer}
					</label>
					{!listenerPreferences.requireBearer && <p>{t.localOnlyHint}</p>}
					{!listenerPreferences.host.startsWith("127.") && (
						<p role="note">{t.httpWarning}</p>
					)}
					<button onClick={() => void saveListenerPreferences()} type="button">
						{t.listenerSave}
					</button>
				</fieldset>
			)}
			{listenerStatus?.url && (
				<p>
					{t.listenerUrl}: <code>{listenerStatus.url}</code>
				</p>
			)}
			{listenerStatus?.state === "disabled" && <p>{t.listenerStopped}</p>}
			{listenerStatus?.error && <p role="alert">{t.listenerError}</p>}

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
