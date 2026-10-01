import { render, waitFor, screen, fireEvent } from "@/utils/test-utils"

import { openAiCodexModels } from "@roo-code/types"

const { postMessageMock, modelPickerProps } = vi.hoisted(() => ({
	postMessageMock: vi.fn(),
	modelPickerProps: { current: undefined as unknown },
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: Record<string, any>) => options?.defaultValue ?? key,
	}),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: postMessageMock,
	},
}))

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: unknown) => {
		modelPickerProps.current = props
		return null
	},
}))

vi.mock("../OpenAICodexRateLimitDashboard", () => ({
	OpenAICodexRateLimitDashboard: () => null,
}))

// The toolkit component is a custom element with a shadow root, which jsdom cannot drive.
// Render a plain input and forward the events the panel cares about.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, onKeyDown, placeholder, className }: any) => (
		<div className={className}>
			{children}
			<input
				type="text"
				value={value}
				onChange={(e) => onInput && onInput(e)}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
			/>
		</div>
	),
}))

const CALLBACK_PLACEHOLDER = "http://localhost:1455/auth/callback?code=..."
const CALLBACK_URL = "http://localhost:1455/auth/callback?code=abc&state=xyz"

import { OpenAICodex, mergeOpenAiCodexModels } from "../OpenAICodex"

const renderPanel = (authenticated: boolean) =>
	render(
		<OpenAICodex
			apiConfiguration={{ apiProvider: "openai-codex" } as never}
			setApiConfigurationField={() => {}}
			openAiCodexIsAuthenticated={authenticated}
		/>,
	)

describe("OpenAICodex model discovery", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
		modelPickerProps.current = undefined
	})

	it("requests discovery once when authenticated", () => {
		renderPanel(true)
		expect(postMessageMock).toHaveBeenCalledWith({ type: "requestOpenAiCodexModels" })
	})

	it("does not request discovery when not authenticated", () => {
		renderPanel(false)
		expect(postMessageMock).not.toHaveBeenCalledWith({ type: "requestOpenAiCodexModels" })
	})

	it("falls back to the static catalog when discovery returns empty", async () => {
		renderPanel(true)

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "openAiCodexModels", openAiCodexModels: [] },
			}),
		)

		await waitFor(() => {
			const models = (modelPickerProps.current as { models: Record<string, unknown> }).models
			expect(Object.keys(models).sort()).toEqual(Object.keys(openAiCodexModels).sort())
		})
	})

	it("merges discovered ids, keeping static metadata and defaulting unknown ids", async () => {
		renderPanel(true)

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "openAiCodexModels", openAiCodexModels: ["brand-new-codex", "gpt-6-sol"] },
			}),
		)

		await waitFor(() => {
			const models = (modelPickerProps.current as { models: Record<string, any> }).models
			expect(models["brand-new-codex"]).toBeDefined()
			expect(models["brand-new-codex"].contextWindow).toBe(1_050_000)
			expect(models["brand-new-codex"].maxTokens).toBe(128_000)
			expect(models["brand-new-codex"].supportsImages).toBe(true)
			// Static entry keeps its curated metadata rather than being overwritten by defaults.
			expect(models["gpt-6-sol"].description).toContain("GPT-6 Sol")
		})
	})

	it("offers GPT-6 Astra on the subscription catalog with the top effort tier", () => {
		const astra = openAiCodexModels["gpt-6-astra"]

		expect(astra).toBeDefined()
		expect(astra.contextWindow).toBe(1_050_000)
		expect(astra.maxTokens).toBe(128_000)
		expect(astra.supportsReasoningEffort).toContain("max")
		expect(astra.reasoningEffort).toBe("high")
		expect(astra.supportsTemperature).toBe(false)
	})

	it("mergeOpenAiCodexModels falls back to the static catalog for empty/null discovery", () => {
		const staticKeys = Object.keys(openAiCodexModels).sort()
		expect(Object.keys(mergeOpenAiCodexModels([])).sort()).toEqual(staticKeys)
		expect(Object.keys(mergeOpenAiCodexModels(null)).sort()).toEqual(staticKeys)
		expect(Object.keys(mergeOpenAiCodexModels(undefined)).sort()).toEqual(staticKeys)
	})
})

describe("OpenAICodex manual callback sign in", () => {
	beforeEach(() => {
		postMessageMock.mockClear()
	})

	it("posts the pasted callback URL to the extension", () => {
		renderPanel(false)

		fireEvent.change(screen.getByPlaceholderText(CALLBACK_PLACEHOLDER), { target: { value: CALLBACK_URL } })
		fireEvent.click(screen.getByRole("button", { name: "Complete sign in" }))

		expect(postMessageMock).toHaveBeenCalledWith({ type: "openAiCodexSubmitCallbackUrl", text: CALLBACK_URL })
	})

	it("warns instead of posting when nothing was pasted", () => {
		renderPanel(false)

		fireEvent.click(screen.getByRole("button", { name: "Complete sign in" }))

		expect(screen.getByText("Paste the callback URL from your browser first.")).toBeTruthy()
		expect(postMessageMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "openAiCodexSubmitCallbackUrl" }),
		)
	})

	it("surfaces the failure reported by the extension", async () => {
		renderPanel(false)

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "openAiCodexCallbackResult", success: false, error: "State mismatch." },
			}),
		)

		await waitFor(() => expect(screen.getByText("State mismatch.")).toBeTruthy())
	})

	it("clears the field after a successful result", async () => {
		renderPanel(false)

		fireEvent.change(screen.getByPlaceholderText(CALLBACK_PLACEHOLDER), { target: { value: CALLBACK_URL } })

		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "openAiCodexCallbackResult", success: true } }),
		)

		await waitFor(() =>
			expect((screen.getByPlaceholderText(CALLBACK_PLACEHOLDER) as HTMLInputElement).value).toBe(""),
		)
	})

	it("hides the paste field once authenticated", () => {
		renderPanel(true)

		expect(screen.queryByPlaceholderText(CALLBACK_PLACEHOLDER)).toBeNull()
	})
})
