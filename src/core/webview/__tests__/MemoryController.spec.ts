import * as vscode from "vscode"
import { MemoryController } from "../MemoryController"
import { MemoryStore, resolveMemoryProject } from "../../../services/memory"

vi.mock("../../../services/memory", () => ({ MemoryStore: vi.fn(), resolveMemoryProject: vi.fn() }))
const project = { key: "project", label: "Project", rootPath: "/workspace" }
let store: any
let controller: MemoryController
let provider: any
beforeEach(() => {
	vi.clearAllMocks()
	Object.defineProperty(vscode.workspace, "isTrusted", { value: true, configurable: true })
	vi.mocked(resolveMemoryProject).mockResolvedValue(project)
	store = {
		project,
		getConsent: vi.fn(async () => ({ enabled: false, personalRecall: false, revision: "disabled" })),
		setConsent: vi.fn(),
		list: vi.fn(async () => ({ records: [], revision: "list", errors: [], omitted: 0 })),
		getDirectory: () => "/storage/memory",
		read: vi.fn(),
		upsert: vi.fn(),
		delete: vi.fn(),
	}
	vi.mocked(MemoryStore).mockImplementation(() => store)
	provider = {
		cwd: "/workspace",
		getCurrentTask: () => undefined,
		context: { globalStorageUri: { fsPath: "/storage" } },
		postMessageToWebview: vi.fn(),
	}
	controller = new MemoryController(provider)
})
afterEach(() => {
	controller.dispose()
	vi.restoreAllMocks()
})

it("denied opt-in never enables memory", async () => {
	vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
	await controller.handle({
		action: "consent",
		scope: "project",
		projectKey: "project",
		consentRevision: "disabled",
		enabled: true,
		personalRecall: false,
	})
	expect(store.setConsent).not.toHaveBeenCalled()
})
it("rejects a scope change while consent confirmation is open", async () => {
	vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(async () => {
		provider.cwd = "/other"
		vi.mocked(resolveMemoryProject).mockResolvedValue({ ...project, key: "other" })
		vi.mocked(MemoryStore).mockImplementation(() => ({ ...store, project: { ...project, key: "other" } }))
		return "Enable memory" as never
	})
	await controller.handle({
		action: "consent",
		scope: "project",
		projectKey: "project",
		consentRevision: "disabled",
		enabled: true,
	})
	expect(store.setConsent).not.toHaveBeenCalled()
	expect(provider.postMessageToWebview).toHaveBeenCalledWith(
		expect.objectContaining({ memoryError: expect.stringContaining("changed") }),
	)
})
it("requires exact native confirmation for personal saves", async () => {
	vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
	await controller.handle({
		action: "save",
		scope: "personal",
		projectKey: "project",
		consentRevision: "disabled",
		expectedRevision: null,
		input: { name: "Preference", description: "Preference", type: "user", body: "Prefer concise answers" },
	})
	expect(store.upsert).not.toHaveBeenCalled()
	expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
		expect.stringContaining("across projects"),
		expect.objectContaining({ detail: expect.stringContaining("Prefer concise answers") }),
		"Save personal memory",
	)
})
it("does not open storage in an untrusted workspace", async () => {
	Object.defineProperty(vscode.workspace, "isTrusted", { value: false, configurable: true })
	expect(await controller.enabled()).toBe(false)
	expect(resolveMemoryProject).not.toHaveBeenCalled()
})
