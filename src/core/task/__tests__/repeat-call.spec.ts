import {
	recordRepeatCall,
	repeatCallKey,
	repeatCallNote,
	resetRepeatCalls,
	type RepeatChainHolder,
} from "../repeat-call"

function callN(holder: RepeatChainHolder, n: number, tool = "read_file", args: unknown = { path: "a.ts" }) {
	const notes: (string | undefined)[] = []
	for (let i = 0; i < n; i++) notes.push(recordRepeatCall(holder, tool, args))
	return notes
}

describe("repeat-call reminder", () => {
	it("adds a note at calls 3, 5 and 8 only", () => {
		const holder: RepeatChainHolder = {}
		const notes = callN(holder, 9)
		const noted = notes.map((n, i) => (n ? i + 1 : 0)).filter(Boolean)
		expect(noted).toEqual([3, 5, 8])
		expect(notes[2]).toBe(repeatCallNote("read_file", 3))
		expect(notes[2]).toContain("call 3 of read_file with identical arguments")
	})

	it("treats argument key order as identical", () => {
		expect(repeatCallKey("x", { a: 1, b: { d: 2, c: 3 } })).toBe(repeatCallKey("x", { b: { c: 3, d: 2 }, a: 1 }))
		const holder: RepeatChainHolder = {}
		recordRepeatCall(holder, "x", { a: 1, b: 2 })
		recordRepeatCall(holder, "x", { b: 2, a: 1 })
		expect(recordRepeatCall(holder, "x", { a: 1, b: 2 })).toBeDefined()
	})

	it("resets the count on a different call", () => {
		const holder: RepeatChainHolder = {}
		callN(holder, 2)
		recordRepeatCall(holder, "read_file", { path: "b.ts" })
		expect(callN(holder, 2)).toEqual([undefined, undefined])
		expect(holder.repeatChain?.count).toBe(2)
	})

	it("ignores excluded tools without resetting the chain", () => {
		const holder: RepeatChainHolder = {}
		callN(holder, 2)
		for (const tool of ["update_todo_list", "task_state", "ask_followup_question", "attempt_completion"]) {
			expect(recordRepeatCall(holder, tool, {})).toBeUndefined()
		}
		expect(recordRepeatCall(holder, "read_file", { path: "a.ts" })).toBeDefined()
	})

	it("resets on a new user message", () => {
		const holder: RepeatChainHolder = {}
		callN(holder, 2)
		resetRepeatCalls(holder)
		expect(holder.repeatChain).toBeUndefined()
		expect(callN(holder, 2)).toEqual([undefined, undefined])
	})
})
