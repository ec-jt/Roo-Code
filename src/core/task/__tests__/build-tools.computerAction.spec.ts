// npx vitest run core/task/__tests__/build-tools.computerAction.spec.ts

import type OpenAI from "openai"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: () => undefined },
}))

import { buildNativeToolsArray } from "../build-tools"

function toolNames(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools.map((t) => (t as { function?: { name: string } }).function?.name ?? "")
}

function createProvider(state: Record<string, unknown>) {
	return {
		getMcpHub: () => undefined,
		context: {},
		getState: vi.fn(async () => state),
	}
}

async function build(state: Record<string, unknown>, supportsImages: boolean) {
	return toolNames(
		await buildNativeToolsArray({
			provider: createProvider(state) as never,
			cwd: "/workspace",
			mode: "code",
			customModes: [],
			experiments: {},
			apiConfiguration: undefined,
			browserToolEnabled: true,
			disabledTools: undefined,
			modelInfo: { supportsImages, contextWindow: 200_000, supportsPromptCache: false } as never,
		} as never),
	)
}

describe("buildNativeToolsArray - computer_action gate", () => {
	it("includes computer_action when enabled and the model supports images", async () => {
		expect(await build({ computerUseEnabled: true }, true)).toContain("computer_action")
	})

	it("excludes computer_action when the model does not support images, even if enabled", async () => {
		expect(await build({ computerUseEnabled: true }, false)).not.toContain("computer_action")
	})

	it("excludes computer_action when the setting is off or absent", async () => {
		expect(await build({ computerUseEnabled: false }, true)).not.toContain("computer_action")
		expect(await build({}, true)).not.toContain("computer_action")
	})

	it("does not affect other tools", async () => {
		const names = await build({}, true)
		expect(names).toContain("read_file")
		expect(names).toContain("execute_command")
	})
})
