/** @vitest-environment jsdom */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenSection, type TokenSectionRemote } from "../src/token-section.js";

const tokenMetadata = {
	id: "0123456789abcdef0123456789abcdef",
	displayName: "Laptop",
	scopes: ["status:read", "sessions:read"] as const,
	allowedSessionIds: [] as const,
	ownedSessionIds: [],
	createdAt: 1_790_000_000_000,
	revoked: false,
};

afterEach(cleanup);

describe("DSH token settings section", () => {
	it("reports a rejected Remote call and allows a later retry", async () => {
		const remote: TokenSectionRemote = {
			listTokenMetadata: vi.fn().mockResolvedValue({ ok: true, value: [] }),
			createClientToken: vi
				.fn()
				.mockRejectedValueOnce(new Error("namespace not mounted"))
				.mockResolvedValueOnce({
					ok: true,
					value: { token: "retry-secret", metadata: tokenMetadata },
				}),
			revokeClientToken: vi.fn(),
		};
		render(createElement(TokenSection, { remote }));
		fireEvent.change(screen.getByLabelText("Client name"), {
			target: { value: "Laptop" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create token" }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Create token" }));
		expect(
			((await screen.findByLabelText("One-time token")) as HTMLInputElement)
				.value,
		).toBe("retry-secret");
	});

	it("keeps the only plaintext token visible when clipboard access is unavailable", async () => {
		const remote: TokenSectionRemote = {
			listTokenMetadata: vi.fn().mockResolvedValue({ ok: true, value: [] }),
			createClientToken: vi.fn().mockResolvedValue({
				ok: true,
				value: { token: "manual-copy-secret", metadata: tokenMetadata },
			}),
			revokeClientToken: vi.fn(),
		};
		render(createElement(TokenSection, { remote }));
		fireEvent.change(screen.getByLabelText("Client name"), {
			target: { value: "Laptop" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create token" }));
		await screen.findByLabelText("One-time token");
		fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(
			(screen.getByLabelText("One-time token") as HTMLInputElement).value,
		).toBe("manual-copy-secret");
	});

	it("loads and lists metadata without asking for an existing secret", async () => {
		const remote: TokenSectionRemote = {
			listTokenMetadata: vi
				.fn()
				.mockResolvedValue({ ok: true, value: [tokenMetadata] }),
			createClientToken: vi.fn(),
			revokeClientToken: vi.fn(),
		};

		render(createElement(TokenSection, { remote }));

		expect(await screen.findByText("Laptop")).toBeTruthy();
		expect(screen.getByText("status:read, sessions:read")).toBeTruthy();
		expect(remote.listTokenMetadata).toHaveBeenCalledOnce();
		expect(remote.createClientToken).not.toHaveBeenCalled();
	});

	it("offers one copy action for a just-created secret and clears it after use", async () => {
		const remote: TokenSectionRemote = {
			listTokenMetadata: vi.fn().mockResolvedValue({ ok: true, value: [] }),
			createClientToken: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					token: "new-client-secret",
					metadata: tokenMetadata,
				},
			}),
			revokeClientToken: vi.fn(),
		};
		const writeText = vi.fn().mockResolvedValue(undefined);

		render(createElement(TokenSection, { remote, clipboard: { writeText } }));
		fireEvent.change(screen.getByLabelText("Client name"), {
			target: { value: "Laptop" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create token" }));

		const oneTimeToken = (await screen.findByLabelText(
			"One-time token",
		)) as HTMLInputElement;
		expect(oneTimeToken.value).toBe("new-client-secret");
		const copyButton = screen.getByRole("button", { name: "Copy token" });
		fireEvent.click(copyButton);

		await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
		expect(writeText).toHaveBeenCalledWith("new-client-secret");
		expect(screen.queryByLabelText("One-time token")).toBeNull();
		expect(screen.queryByRole("button", { name: "Copy token" })).toBeNull();
	});

	it("keeps a failed one-time copy visible and selectable until retry succeeds", async () => {
		const remote: TokenSectionRemote = {
			listTokenMetadata: vi.fn().mockResolvedValue({ ok: true, value: [] }),
			createClientToken: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					token: "new-client-secret",
					metadata: tokenMetadata,
				},
			}),
			revokeClientToken: vi.fn(),
		};
		const writeText = vi
			.fn<Clipboard["writeText"]>()
			.mockRejectedValueOnce(new Error("clipboard denied"))
			.mockResolvedValueOnce(undefined);

		render(createElement(TokenSection, { remote, clipboard: { writeText } }));
		fireEvent.change(screen.getByLabelText("Client name"), {
			target: { value: "Laptop" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create token" }));

		const oneTimeToken = (await screen.findByLabelText(
			"One-time token",
		)) as HTMLInputElement;
		fireEvent.click(screen.getByRole("button", { name: "Copy token" }));

		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(oneTimeToken.value).toBe("new-client-secret");
		expect(oneTimeToken.readOnly).toBe(true);
		expect(screen.getByRole("button", { name: "Copy token" })).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
		await waitFor(() =>
			expect(screen.queryByLabelText("One-time token")).toBeNull(),
		);
		expect(writeText).toHaveBeenCalledTimes(2);
	});

	it("allows an explicit dismissal of the one-time secret", async () => {
		const remote: TokenSectionRemote = {
			listTokenMetadata: vi.fn().mockResolvedValue({ ok: true, value: [] }),
			createClientToken: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					token: "new-client-secret",
					metadata: tokenMetadata,
				},
			}),
			revokeClientToken: vi.fn(),
		};

		render(createElement(TokenSection, { remote }));
		fireEvent.change(screen.getByLabelText("Client name"), {
			target: { value: "Laptop" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create token" }));
		await screen.findByLabelText("One-time token");
		fireEvent.click(screen.getByRole("button", { name: "Dismiss token" }));
		expect(screen.queryByLabelText("One-time token")).toBeNull();
	});

	it("detects Russian and keeps a visible language toggle", async () => {
		const originalLanguage = navigator.language;
		Object.defineProperty(navigator, "language", {
			configurable: true,
			value: "ru-RU",
		});
		const remote: TokenSectionRemote = {
			listTokenMetadata: vi.fn().mockResolvedValue({ ok: true, value: [] }),
			createClientToken: vi.fn(),
			revokeClientToken: vi.fn(),
		};

		try {
			render(createElement(TokenSection, { remote }));
			expect(
				await screen.findByRole("heading", { name: "Клиенты MCP" }),
			).toBeTruthy();
			expect(screen.getByRole("button", { name: "English" })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "English" }));
			expect(screen.getByRole("heading", { name: "MCP clients" })).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "Русский" }));
			expect(screen.getByRole("heading", { name: "Клиенты MCP" })).toBeTruthy();
		} finally {
			Object.defineProperty(navigator, "language", {
				configurable: true,
				value: originalLanguage,
			});
		}
	});

	it("does not offer admin or cross-session grants by default", async () => {
		const remote: TokenSectionRemote = {
			listTokenMetadata: vi.fn().mockResolvedValue({ ok: true, value: [] }),
			createClientToken: vi.fn().mockResolvedValue({
				ok: true,
				value: {
					token: "new-client-secret",
					metadata: tokenMetadata,
				},
			}),
			revokeClientToken: vi.fn(),
		};

		render(createElement(TokenSection, { remote }));

		expect(screen.queryByLabelText("admin")).toBeNull();
		expect(screen.queryByLabelText("Allowed sessions")).toBeNull();
		const checkboxes = screen.getAllByRole("checkbox");
		expect(
			checkboxes.every((checkbox) => !(checkbox as HTMLInputElement).checked),
		).toBe(true);
	});
});
