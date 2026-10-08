import type { WebviewMessage } from "@roo-code/types"
import { webviewMessageHandler } from "../../webviewMessageHandler"
import { ClineProvider } from "../../ClineProvider"

describe("historical chat action fencing", () => {
	it.each([
		"askResponse",
		"alwaysAllowReadOnlyAsk",
		"terminalOperation",
		"checkpointRestore",
		"deleteMessage",
		"submitEditedMessage",
		"deleteMessageConfirm",
		"editMessageConfirm",
		"queueMessage",
		"removeQueuedMessage",
		"editQueuedMessage",
		"modelOperation",
		"modelOperationApproval",
		"condenseTaskContextRequest",
		"mode",
		"updateTodoList",
		"cancelTask",
		"cancelAutoApproval",
		"killBrowserSession",
		"commandActivityControl",
		"loadApiConfiguration",
		"loadApiConfigurationById",
	] as WebviewMessage["type"][])("rejects %s before accessing the live task", async (type) => {
		const getCurrentTask = vi.fn(() => {
			throw new Error("must not reach live controls")
		})
		const provider = { isChatWindowFollowing: () => false, getCurrentTask } as unknown as ClineProvider
		await webviewMessageHandler(provider, { type })
		expect(getCurrentTask).not.toHaveBeenCalled()
	})
})
