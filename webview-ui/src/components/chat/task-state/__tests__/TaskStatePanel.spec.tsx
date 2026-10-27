import { act, fireEvent, render, screen } from "@testing-library/react"
import {
	taskStatePolicySchema,
	type TaskStateNativeRequest,
	type TaskStateNativeResponse,
	type TaskStateSnapshot,
} from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { TaskStatePanel } from "../TaskStatePanel"
import { TaskStateToolApproval } from "../TaskStateToolApproval"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const head = "a".repeat(64)
const selected = "b".repeat(64)
const anchor = "c".repeat(64)
const policy = taskStatePolicySchema.parse({})
const snapshot: TaskStateSnapshot = {
	schemaVersion: 1,
	revision: selected,
	sequence: 1,
	parentRevision: null,
	baseRevision: null,
	historyAnchor: anchor,
	historyPosition: 4,
	createdAt: "2026-10-27T00:00:00.000Z",
	actor: "user",
	policy,
	data: {
		goal: "Stored goal",
		nextAction: "Review",
		acceptanceCriteria: [],
		constraints: [],
		decisions: [],
		failedApproaches: [],
		blockers: [],
		workItems: [],
		evidenceRefs: [],
	},
}
function lastRequest(): TaskStateNativeRequest {
	return vi.mocked(vscode.postMessage).mock.calls.at(-1)![0].taskStateRequest!
}
async function respond(extra: Partial<TaskStateNativeResponse> = {}, request = lastRequest()) {
	await act(async () => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "taskStateResponse",
					taskStateResponse: {
						requestId: request.requestId,
						taskId: request.taskId,
						revision: head,
						snapshot,
						policy,
						history: { anchor, position: 4 },
						...extra,
					},
				},
			}),
		)
	})
}
async function open(extra: Partial<TaskStateNativeResponse> = {}) {
	const view = render(<TaskStatePanel taskId="task-a" />)
	fireEvent.click(screen.getByRole("button", { name: "Task state" }))
	await respond(extra)
	return view
}
function click(name: string) {
	fireEvent.click(screen.getByRole("button", { name }))
}
function change(label: string, value: string) {
	fireEvent.change(screen.getByLabelText(label), { target: { value } })
}
function expand(name: string) {
	fireEvent.click(screen.getByText(name, { selector: "summary" }))
}

describe("TaskStatePanel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubGlobal("acquireVsCodeApi", vi.fn())
	})
	afterEach(() => vi.unstubAllGlobals())

	it("reads only on opening and initializes only after explicit opt-in with seeded fields", async () => {
		render(<TaskStatePanel taskId="task-a" />)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		click("Task state")
		expect(lastRequest().action).toBe("read")
		await respond({ revision: null, snapshot: null })
		expect(screen.getByText(/Task state is off/)).toBeInTheDocument()
		change("Goal", "User goal")
		change("Next action", "First step")
		click("Enable task state")
		expect(lastRequest()).toMatchObject({
			action: "initialize",
			expectedRevision: null,
			operations: [
				{ op: "set", field: "goal", value: "User goal" },
				{ op: "set", field: "nextAction", value: "First step" },
			],
		})
		expect(lastRequest().policy).toBeUndefined()
	})

	it("sends ledger head rather than selected snapshot, retains conflict draft, and requires refresh", async () => {
		await open()
		change("Goal", "My correction")
		click("Review and save state")
		expect(lastRequest()).toMatchObject({ action: "correct", expectedRevision: head })
		expect(lastRequest().expectedRevision).not.toBe(selected)
		await respond({ error: "Task state changed; refresh before retrying" })
		expect(screen.getByLabelText("Goal")).toHaveValue("My correction")
		expect(screen.getByRole("button", { name: "Review and save state" })).toBeDisabled()
		click("Refresh task state")
		await respond({
			revision: "d".repeat(64),
			snapshot: { ...snapshot, data: { ...snapshot.data, goal: "Other edit" } },
		})
		expect(screen.getByLabelText("Goal")).toHaveValue("My correction")
		click("Review and save state")
		expect(lastRequest()).toMatchObject({
			expectedRevision: "d".repeat(64),
			operations: [
				{ op: "set", field: "goal", value: "My correction" },
				{ op: "set", field: "nextAction", value: "Review" },
			],
		})
	})

	it("keeps drafts when collapsed and clears them on task switch", async () => {
		const view = await open()
		change("Goal", "Unsaved")
		click("Task state")
		click("Task state")
		expect(screen.getByLabelText("Goal")).toHaveValue("Unsaved")
		click("Refresh task state")
		const old = lastRequest()
		view.rerender(<TaskStatePanel taskId="task-b" />)
		click("Task state")
		await respond({ snapshot: { ...snapshot, data: { ...snapshot.data, goal: "Late old task" } } }, old)
		expect(screen.getByLabelText("Goal")).toHaveValue("")
		await respond({ snapshot: { ...snapshot, data: { ...snapshot.data, goal: "Task B" } } })
		expect(screen.getByLabelText("Goal")).toHaveValue("Task B")
	})

	it("warns on incompatible history without offering initialization", async () => {
		await open({ snapshot: null })
		expect(screen.getByText(/Incompatible history:/)).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Enable task state" })).not.toBeInTheDocument()
		click("Review and save state")
		expect(lastRequest().action).toBe("correct")
		expect(lastRequest().expectedRevision).toBe(head)
	})

	it("edits records incrementally and prevents changing runtime evidence", async () => {
		await open({
			snapshot: {
				...snapshot,
				data: {
					...snapshot.data,
					evidenceRefs: [{ id: "receipt", text: "Observed", source: "tool", provenance: "runtime_observed" }],
				},
			},
		})
		expand("Records and evidence")
		change("Record ID", "criterion-1")
		change("Record text", "Acceptance description")
		click("Add or update draft record")
		expect(screen.getByText("criterion-1", { selector: "strong" })).toBeInTheDocument()
		change("Record collection", "evidenceRefs")
		expect(screen.getByRole("button", { name: "Edit receipt" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Remove receipt" })).toBeDisabled()
		click("Review and save state")
		expect(lastRequest().operations?.[0]).toEqual({
			op: "upsert",
			collection: "acceptanceCriteria",
			value: { id: "criterion-1", text: "Acceptance description" },
		})
	})

	it("starts disabled and requests native policy confirmation with complete bounds and checks", async () => {
		await open()
		expand("Recall and bounded continuation policy")
		expect(screen.getByLabelText("Enable bounded continuation")).not.toBeChecked()
		expect(screen.getByLabelText("Recall task data to the provider")).toBeChecked()
		expect(screen.getByLabelText("Maximum steps")).toHaveValue(20)
		fireEvent.click(screen.getByLabelText("Enable bounded continuation"))
		click("Review and save policy")
		expect(screen.getByRole("alert")).toHaveTextContent("at least one")
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		click("Add acceptance check")
		change("Check 1 ID", "review")
		change("Check 1 description", "Review acceptance evidence")
		click("Review and save policy")
		expect(lastRequest()).toMatchObject({
			action: "configure",
			expectedRevision: head,
			policy: { ...policy, enabled: true, checks: [{ id: "review", text: "Review acceptance evidence" }] },
		})
		expect(screen.getByText(/resets counters and user attestations/)).toBeInTheDocument()
	})

	it("requires an explicit reviewed save at current coverage before fresh context", async () => {
		await open()
		expand("Reviewed fresh context")
		expect(screen.getByRole("button", { name: "Review and create fresh context" })).toBeDisabled()
		click("Review and save state")
		expect(lastRequest()).toMatchObject({
			action: "correct",
			operations: [{ op: "set", field: "nextAction", value: "Review" }],
		})
		await respond({ revision: "d".repeat(64) })
		click("Review and create fresh context")
		expect(lastRequest()).toMatchObject({ action: "fresh-context", expectedRevision: "d".repeat(64) })
		expect(screen.getByText(/It does not summarize that transcript/)).toBeInTheDocument()
	})

	it("sends only arm, disable, and stop actions without dispatching work", async () => {
		await open({ policy: { ...policy, enabled: true, checks: [{ id: "check", text: "Check" }] } })
		click("Arm next ordinary turn")
		expect(lastRequest().action).toBe("start")
		click("Stop continuation")
		expect(lastRequest().action).toBe("stop")
		await respond()
		click("Disable recall and continuation")
		expect(lastRequest().action).toBe("disable")
		expect(vi.mocked(vscode.postMessage).mock.calls.every(([message]) => message.type === "taskStateRequest")).toBe(
			true,
		)
	})

	it("requires notes for user attestations and exports untrusted Markdown as read-only text", async () => {
		await open({ policy: { ...policy, checks: [{ id: "review", text: "Review" }] } })
		expand("Record user check result")
		change("Acceptance check", "review")
		expect(screen.getByRole("button", { name: "Review user check result" })).toBeDisabled()
		change("Result note", "Reviewed manually")
		click("Review user check result")
		expect(lastRequest()).toMatchObject({
			action: "attest",
			check: { id: "review", result: "passed", note: "Reviewed manually" },
		})
		await respond({
			runtime: {
				armed: false,
				steps: 1,
				tokens: 2,
				elapsedMs: 3,
				noProgressSteps: 0,
				status: "completed",
				reason: "checks",
				checks: [{ id: "review", result: "passed", note: "Reviewed manually", provenance: "user_attested" }],
			},
		})
		expect(screen.getByText(/completion uses user attestations/)).toBeInTheDocument()
		click("Export Markdown")
		expect(lastRequest().action).toBe("export")
		const text = "# Export\n<script>alert('no')</script>"
		await respond({ exportText: text })
		const output = screen.getByLabelText("Markdown export (read-only; select to copy)")
		expect(output).toHaveValue(text)
		expect(output).toHaveAttribute("readonly")
		expect(document.querySelector("script")).toBeNull()
	})

	it("forks only by explicit source task and snapshot revision", async () => {
		await open({ revision: null, snapshot: null })
		expand("Fork reviewed state from another task")
		change("Source task ID", "source-task")
		change("Source snapshot revision", selected)
		click("Review and fork task state")
		expect(lastRequest()).toMatchObject({
			action: "fork",
			expectedRevision: null,
			source: { taskId: "source-task", revision: selected },
		})
	})

	it("renders exact tool approval content safely without adding approval bypasses", () => {
		const content = JSON.stringify({
			action: "patch",
			expected_revision: head,
			operations: '[{"op":"set","field":"goal","value":"<script>no</script>"}]',
		})
		const { container } = render(<TaskStateToolApproval content={content} />)
		expect(container.querySelector("pre")?.textContent).toBe(JSON.stringify(JSON.parse(content), null, 2))
		expect(container.querySelector("script")).toBeNull()
		expect(screen.queryByRole("button")).toBeNull()
		expect(screen.getByText(/existing chat approval controls/)).toBeInTheDocument()
	})
})
