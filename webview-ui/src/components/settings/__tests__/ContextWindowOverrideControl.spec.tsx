// cd webview-ui && npx vitest run src/components/settings/__tests__/ContextWindowOverrideControl.spec.tsx

import { render, screen, fireEvent } from "@testing-library/react"

import { ContextWindowOverrideControl, parseContextWindowOverride } from "../ContextWindowOverrideControl"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

describe("ContextWindowOverrideControl", () => {
	it("renders label, description and an empty field without an override", () => {
		render(<ContextWindowOverrideControl onChange={vi.fn()} />)
		expect(screen.getByText("settings:providers.contextWindowOverride.label")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.contextWindowOverride.description")).toBeInTheDocument()
		expect(screen.getByTestId("context-window-override-input")).toHaveValue("")
	})

	it("shows the saved value", () => {
		render(<ContextWindowOverrideControl value={64000} onChange={vi.fn()} />)
		expect(screen.getByTestId("context-window-override-input")).toHaveValue("64000")
	})

	it("updates the profile with a positive integer and clears it when emptied", () => {
		const onChange = vi.fn()
		render(<ContextWindowOverrideControl value={64000} onChange={onChange} />)
		const input = screen.getByTestId("context-window-override-input")
		fireEvent.change(input, { target: { value: "32000" } })
		expect(onChange).toHaveBeenLastCalledWith(32000)
		fireEvent.change(input, { target: { value: "" } })
		expect(onChange).toHaveBeenLastCalledWith(undefined)
	})

	it.each([
		["64000", 64000],
		[" 1 ", 1],
		["", undefined],
		["0", undefined],
		["-5", undefined],
		["1.5", undefined],
		["abc", undefined],
	])("parses %j as %j", (text, expected) => {
		expect(parseContextWindowOverride(text)).toBe(expected)
	})
})
