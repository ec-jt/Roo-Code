import type { Task } from "../../../core/task/Task"
import { getManagedEnvironmentPolicy } from "../settings"
import { getCheckpointEnvironmentWarning } from "../checkpoint"
import { inspectEnvironments } from "../index"

vi.mock("../index", () => ({ inspectEnvironments: vi.fn() }))
const settings = {
	managedEnvironmentsEnabled: true,
	managedEnvironmentsRoot: "/managed",
	managedEnvironmentsPythonPath: "/usr/bin/python3.11",
}
const inventory = {
	environments: [],
	manifestPaths: ["/workspace/roo-environment.json"],
	selected: null,
	manifestMismatch: false,
	incompleteCount: 0,
	invalidCount: 0,
}
const task = (state = settings, access = true) =>
	({
		cwd: "/workspace",
		providerRef: { deref: () => ({ getState: async () => state }) },
		rooIgnoreController: { validateAccess: () => access },
		rooProtectedController: { isWriteProtected: () => false },
	}) as unknown as Task
beforeEach(() => vi.resetAllMocks())

it("defaults disabled and validates explicit limits", () => {
	expect(() => getManagedEnvironmentPolicy()).toThrow("disabled")
	expect(() => getManagedEnvironmentPolicy({ ...settings, managedEnvironmentsPythonPath: "python" })).toThrow(
		"absolute",
	)
	expect(() => getManagedEnvironmentPolicy({ ...settings, managedEnvironmentsMaxDownloadMb: 0 })).toThrow("limit")
	expect(getManagedEnvironmentPolicy(settings)).toMatchObject({
		maxDownloadBytes: 512 * 1024 ** 2,
		timeoutMs: 600000,
	})
})

it("does nothing when disabled", async () => {
	expect(
		await getCheckpointEnvironmentWarning(task({ ...settings, managedEnvironmentsEnabled: false })),
	).toBeUndefined()
	expect(inspectEnvironments).not.toHaveBeenCalled()
})

it("warns after restore when manifest no longer matches; never repairs", async () => {
	vi.mocked(inspectEnvironments)
		.mockResolvedValueOnce(inventory)
		.mockResolvedValueOnce({ ...inventory, manifestMismatch: true })
	expect(await getCheckpointEnvironmentWarning(task())).toContain("1 unmatched")
	expect(inspectEnvironments).toHaveBeenCalledTimes(2)
})

it("does not warn for a matching manifest", async () => {
	vi.mocked(inspectEnvironments)
		.mockResolvedValueOnce(inventory)
		.mockResolvedValueOnce({ ...inventory, selected: {} as never })
	expect(await getCheckpointEnvironmentWarning(task())).toBeUndefined()
})

it("does not read restricted roots or traverse manifests from inventory", async () => {
	expect(await getCheckpointEnvironmentWarning(task(settings, false))).toContain("restricted")
	expect(inspectEnvironments).not.toHaveBeenCalled()
	vi.mocked(inspectEnvironments).mockResolvedValueOnce({ ...inventory, manifestPaths: ["/outside/private.json"] })
	expect(await getCheckpointEnvironmentWarning(task())).toContain("1 access-restricted")
	expect(inspectEnvironments).toHaveBeenCalledTimes(1)
})
