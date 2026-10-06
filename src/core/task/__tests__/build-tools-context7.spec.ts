import type OpenAI from "openai"
import type { ClineProvider } from "../../webview/ClineProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"

vi.mock("@roo-code/core", () => ({ customToolRegistry: {}, formatNative: vi.fn() }))
vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getInstance: vi.fn(() => undefined) },
}))
vi.mock("../../prompts/tools/native-tools", () => ({
	getNativeTools: () =>
		[
			"context7_resolve_library_id",
			"context7_query_docs",
			"brave_web_search",
			"brave_local_search",
			"git_tools",
			"git_repo_research",
		].map((name) => ({
			type: "function",
			function: { name, description: name, parameters: { type: "object", properties: {} } },
		})),
	getMcpServerTools: () => [],
}))

describe("Context7 native tool registration", () => {
	const context7Tools = ["context7_resolve_library_id", "context7_query_docs"]
	const names = (tools: OpenAI.Chat.ChatCompletionTool[]) =>
		tools.map((tool) => {
			if (tool.type !== "function") throw new Error("Expected function tool")
			return tool.function.name
		})
	const build = (
		state: { context7ApiKey?: string; braveApiKey?: string; nativeToolEnabled?: Record<string, boolean> },
		overrides: Partial<Parameters<typeof buildNativeToolsArrayWithRestrictions>[0]> = {},
	) =>
		buildNativeToolsArrayWithRestrictions({
			provider: {
				getMcpHub: () => undefined,
				getState: async () => state,
				context: {},
			} as unknown as ClineProvider,
			cwd: "/workspace",
			mode: "code",
			customModes: undefined,
			experiments: undefined,
			apiConfiguration: undefined,
			...overrides,
		})

	it.each([undefined, "", " \t "])("registers Context7 with key %j", async (context7ApiKey) => {
		const result = await build({ context7ApiKey }, { includeAllToolsWithRestrictions: true })
		expect(names(result.tools)).toEqual(expect.arrayContaining(context7Tools))
		expect(result.allowedFunctionNames).toEqual(expect.arrayContaining(context7Tools))
	})

	it.each(context7Tools)("honors the explicit native disable for %s without a key", async (name) => {
		const result = await build({ nativeToolEnabled: { [name]: false } }, { includeAllToolsWithRestrictions: true })
		expect(names(result.tools)).not.toContain(name)
		expect(result.allowedFunctionNames).not.toContain(name)
		expect(names(result.tools)).toContain(context7Tools.find((other) => other !== name))
	})

	it("preserves general disabled-tool restrictions", async () => {
		const result = await build({}, { disabledTools: context7Tools })
		for (const name of context7Tools) expect(names(result.tools)).not.toContain(name)
	})

	it.each([false, true])(
		"preserves mode restrictions with includeAllToolsWithRestrictions=%s",
		async (includeAllToolsWithRestrictions) => {
			const result = await build(
				{},
				{
					mode: "no-read",
					customModes: [{ slug: "no-read", name: "No read", roleDefinition: "Test", groups: ["edit"] }],
					includeAllToolsWithRestrictions,
				},
			)
			for (const name of context7Tools) {
				if (includeAllToolsWithRestrictions) {
					expect(names(result.tools)).toContain(name)
					expect(result.allowedFunctionNames).not.toContain(name)
				} else {
					expect(names(result.tools)).not.toContain(name)
				}
			}
		},
	)

	it.each([undefined, "", " \t\n "])(
		"hides Brave tools for missing key %j in both registration modes",
		async (braveApiKey) => {
			for (const includeAllToolsWithRestrictions of [false, true]) {
				const result = await build({ braveApiKey }, { includeAllToolsWithRestrictions })
				for (const name of ["brave_web_search", "brave_local_search"]) {
					expect(names(result.tools)).not.toContain(name)
					if (includeAllToolsWithRestrictions) expect(result.allowedFunctionNames).not.toContain(name)
				}
				expect(names(result.tools)).toEqual(expect.arrayContaining(context7Tools))
			}
		},
	)

	it("registers Brave with a nonblank key but honors explicit disable settings", async () => {
		const state = { braveApiKey: " test-key " }
		const enabled = await build(state, { includeAllToolsWithRestrictions: true })
		for (const name of ["brave_web_search", "brave_local_search"]) {
			expect(names(enabled.tools)).toContain(name)
			expect(enabled.allowedFunctionNames).toContain(name)
			const disabled = await build({ ...state, nativeToolEnabled: { [name]: false } })
			expect(names(disabled.tools)).not.toContain(name)
			const restricted = await build(state, { disabledTools: [name] })
			expect(names(restricted.tools)).not.toContain(name)
		}
	})

	it("keeps existing Brave and Git credential behavior", async () => {
		const result = await build({ braveApiKey: "", context7ApiKey: "" })
		expect(names(result.tools)).not.toContain("brave_web_search")
		expect(names(result.tools)).not.toContain("brave_local_search")
		expect(names(result.tools)).toEqual(
			expect.arrayContaining([...context7Tools, "git_tools", "git_repo_research"]),
		)
	})
})
