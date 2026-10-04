import * as vscode from "vscode"
import { getApiRequestTimeout } from "../timeout-config"
import manifest from "../../../../package.json"

vi.mock("vscode", () => ({ workspace: { getConfiguration: vi.fn() } }))

describe("getApiRequestTimeout", () => {
	const get = vi.fn()
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get } as never)
	})

	it("defaults to unlimited in both the setting contribution and helper", () => {
		get.mockImplementation((_key, fallback) => fallback)
		expect(getApiRequestTimeout()).toBe(0)
		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("roo-cline")
		expect(get).toHaveBeenCalledWith("apiRequestTimeout", 0)
		expect(manifest.contributes.configuration.properties["roo-cline.apiRequestTimeout"].default).toBe(0)
	})

	it.each([0, -100, null, undefined, NaN, Infinity, -Infinity, "120", true])(
		"uses unlimited for invalid or nonpositive configuration %s",
		(value) => {
			get.mockReturnValue(value)
			expect(getApiRequestTimeout()).toBe(0)
		},
	)

	it.each([
		[1200, 1_200_000],
		[0.001, 1],
		[0.0001, 1],
		[0.0011, 2],
		[3_000_000, 3_000_000_000],
		[Number.MAX_VALUE, Number.MAX_SAFE_INTEGER],
	])("converts %s seconds to %s safe integer milliseconds", (value, expected) => {
		get.mockReturnValue(value)
		expect(getApiRequestTimeout()).toBe(expected)
	})
})
