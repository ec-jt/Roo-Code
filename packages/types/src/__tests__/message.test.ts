// pnpm --filter @roo-code/types test src/__tests__/message.test.ts

import {
	clineAsks,
	clineMessageSchema,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	isNonBlockingAsk,
} from "../message.js"

describe("ask messages", () => {
	test("all ask messages are classified", () => {
		for (const ask of clineAsks) {
			expect(
				isIdleAsk(ask) || isInteractiveAsk(ask) || isResumableAsk(ask) || isNonBlockingAsk(ask),
				`${ask} is not classified`,
			).toBe(true)
		}
	})
})

describe("message request identity", () => {
	it("accepts legacy messages without a request identity", () => {
		const message = { ts: 1, type: "say", say: "api_req_started" }
		expect(clineMessageSchema.parse(message)).toEqual(message)
	})

	it.each(["ask", "say"])("preserves a request identity on %s messages", (type) => {
		const message = { ts: 1, type, requestId: "request-1" }
		expect(clineMessageSchema.parse(message)).toEqual(message)
	})

	it.each(["", 1, null, false])("rejects invalid request identity %s", (requestId) => {
		expect(clineMessageSchema.safeParse({ ts: 1, type: "say", requestId }).success).toBe(false)
	})
})
