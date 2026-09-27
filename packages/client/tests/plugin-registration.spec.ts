/** @vitest-environment jsdom */
import { Context } from "@deepseek-ai/cordis";
import { SlotCore } from "@deepseek-ai/dsh-client-ui-slots";
import { waitFor } from "@testing-library/react";
import { TYPERT_REMOTE } from "@tommilevs/dsh-control-mcp-host/remote";
import { describe, expect, it, vi } from "vitest";
import { apply, inject } from "../src/index.js";

describe("DSH MCP client registration", () => {
	it("mounts its generated Remote namespace and disposes its settings contribution", async () => {
		const ctx = new Context();
		const slots = new SlotCore();
		const release = slots.register(
			{
				name: "root",
				children: { "settings.section": { kind: "list", scope: "root" } },
			},
			({ renderSlot }) => renderSlot("settings.section", { close: () => {} }),
		);
		const namespace = {
			listTokenMetadata: vi.fn(),
			createClientToken: vi.fn(),
			revokeClientToken: vi.fn(),
		};
		const unmount = vi.fn(async () => {});
		const mount = vi.fn(async () => {
			ctx.provide("remote.clientTokens", namespace);
			return unmount;
		});
		ctx.provide("slots", slots);
		ctx.provide("remote", { $mount: mount, clientTokens: namespace });
		try {
			const fiber = await ctx.plugin({ apply, inject });
			await waitFor(() =>
				expect(slots.entriesOfSlot("settings.section")).toHaveLength(1),
			);
			expect(mount).toHaveBeenCalledWith(TYPERT_REMOTE);
			const entry = slots.entriesOfSlot("settings.section")[0];
			expect(entry?.options.id).toBe("dsh-control-mcp");
			expect(entry?.inject?.()).toEqual({ remote: namespace });
			await fiber.dispose();
			expect(unmount).toHaveBeenCalledOnce();
			expect(slots.entriesOfSlot("settings.section")).toHaveLength(0);
		} finally {
			release();
			await ctx.fiber.dispose();
		}
	});
});
