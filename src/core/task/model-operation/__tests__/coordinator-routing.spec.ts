// npx vitest run core/task/model-operation/__tests__/coordinator-routing.spec.ts

import type { WebviewMessage } from "@roo-code/types"
import type { ClineProvider } from "../../../webview/ClineProvider"
import { webviewMessageHandler } from "../../../webview/webviewMessageHandler"

// Keep the real message router, without constructing a provider or loading model caches.
vi.mock("../../../webview/ClineProvider", () => ({ ClineProvider: vi.fn() }))
vi.mock("../../../../api/providers/fetchers/modelCache")
vi.mock("@anthropic-ai/vertex-sdk", () => ({ AnthropicVertex: vi.fn() }))
vi.mock("google-auth-library", () => ({ GoogleAuth: vi.fn() }))
vi.mock("ollama", () => ({ Ollama: vi.fn() }))
vi.mock("../../../mentions/resolveImageMentions", () => ({
	resolveImageMentions: vi.fn(async ({ text, images }: { text: string; images?: string[] }) => ({ text, images })),
}))

const operation = Object.freeze({
	operationId: "operation-1",
	kind: "regenerate",
	taskId: "task-1",
	instanceId: "instance-1",
	revision: 3,
	profileId: "profile-1",
	requestId: "request-1",
	confirmCurrentWorkspace: true,
})

const approval = Object.freeze({
	taskId: "task-1",
	instanceId: "instance-1",
	revision: 3,
	approvalId: "approval-1",
	approved: true,
})

function createProvider() {
	const task = {
		cwd: "/mock/workspace",
		handleWebviewAskResponse: vi.fn().mockResolvedValue(undefined),
	}
	const provider = {
		getCurrentTask: vi.fn().mockReturnValue(task),
		getState: vi.fn().mockResolvedValue({}),
		handleModelOperation: vi.fn().mockResolvedValue(undefined),
		handleModelOperationApproval: vi.fn().mockResolvedValue(undefined),
	}

	return { task, provider, handlerProvider: provider as unknown as ClineProvider }
}

describe("model operation webview routing", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe.each([
		{
			type: "modelOperation",
			handler: "handleModelOperation",
			otherHandler: "handleModelOperationApproval",
			payloads: [operation, Object.freeze({ ...operation, kind: "switch" })],
		},
		{
			type: "modelOperationApproval",
			handler: "handleModelOperationApproval",
			otherHandler: "handleModelOperation",
			payloads: [approval, Object.freeze({ ...approval, approved: false })],
		},
	] as const)("$type", ({ type, handler, otherHandler, payloads }) => {
		it.each([
			{ label: "first valid payload", payload: payloads[0] },
			{ label: "second valid payload", payload: payloads[1] },
			{ label: "invalid object with extra fields", payload: Object.freeze({ unexpected: "preserve me" }) },
			{ label: "empty object", payload: Object.freeze({}) },
			{ label: "string", payload: "invalid payload" },
			{ label: "false", payload: false },
			{ label: "zero", payload: 0 },
			{ label: "null", payload: null },
			{ label: "undefined", payload: undefined },
		])("forwards $label unchanged without answering an ordinary task ask", async ({ payload }) => {
			const { task, provider, handlerProvider } = createProvider()
			// Include ordinary approval fields to catch accidental fallthrough or approval bypass.
			const message = {
				type,
				[type]: payload,
				askResponse: "yesButtonClicked",
				text: "approve",
				images: [],
			} as unknown as WebviewMessage

			await webviewMessageHandler(handlerProvider, message)

			expect(provider[handler]).toHaveBeenCalledExactlyOnceWith(payload)
			expect(provider[handler].mock.calls[0][0]).toBe(payload)
			expect(provider[otherHandler]).not.toHaveBeenCalled()
			expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
		})

		it("forwards an omitted payload as undefined", async () => {
			const { task, provider, handlerProvider } = createProvider()

			await webviewMessageHandler(handlerProvider, { type })

			expect(provider[handler]).toHaveBeenCalledExactlyOnceWith(undefined)
			expect(provider[otherHandler]).not.toHaveBeenCalled()
			expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
		})

		it("awaits the provider handler", async () => {
			const { task, provider, handlerProvider } = createProvider()
			let release!: () => void
			const pending = new Promise<void>((resolve) => {
				release = resolve
			})
			provider[handler].mockReturnValueOnce(pending)
			const completed = vi.fn()
			const handling = webviewMessageHandler(handlerProvider, {
				type,
				[type]: payloads[0],
			} as WebviewMessage).then(completed)

			try {
				expect(provider[handler]).toHaveBeenCalledExactlyOnceWith(payloads[0])
				// Flush promise continuations without timers while the provider is still pending.
				await Promise.resolve()
				await Promise.resolve()
				expect(completed).not.toHaveBeenCalled()
			} finally {
				release()
				await handling
			}

			expect(completed).toHaveBeenCalledTimes(1)
			expect(provider[otherHandler]).not.toHaveBeenCalled()
			expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
		})
	})

	it.each(["yesButtonClicked", "noButtonClicked", "messageResponse"] as const)(
		"keeps ordinary %s responses on the task approval path",
		async (askResponse) => {
			const { task, provider, handlerProvider } = createProvider()
			const text = "ordinary task response"
			const images = ["data:image/png;base64,ordinary"]

			await webviewMessageHandler(handlerProvider, {
				type: "askResponse",
				askResponse,
				text,
				images,
				// Payload presence must not override the explicit message type.
				modelOperation: operation,
				modelOperationApproval: approval,
			})

			expect(task.handleWebviewAskResponse).toHaveBeenCalledExactlyOnceWith(askResponse, text, images)
			expect(provider.handleModelOperation).not.toHaveBeenCalled()
			expect(provider.handleModelOperationApproval).not.toHaveBeenCalled()
		},
	)
})
