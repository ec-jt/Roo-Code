import { render, screen, fireEvent } from "@testing-library/react"

import { ExperimentalSettings } from "../ExperimentalSettings"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

// Simple stand-ins: a range input for the Radix slider, a plain input, and a native select.
vi.mock("@src/components/ui", () => ({
	Select: ({ value, onValueChange, children }: any) => (
		<select value={value} onChange={(e) => onValueChange(e.target.value)}>
			{children}
		</select>
	),
	SelectTrigger: () => null,
	SelectValue: () => null,
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
	Slider: ({ value, min, max, onValueChange, ...rest }: any) => (
		<input
			type="range"
			min={min}
			max={max}
			value={value[0]}
			onChange={(e) => onValueChange([Number(e.target.value)])}
			data-testid={rest["data-testid"]}
		/>
	),
	Input: (props: any) => <input {...props} />,
}))

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ settingId, children }: any) => <div data-setting-id={settingId}>{children}</div>,
}))
vi.mock("../SectionHeader", () => ({ SectionHeader: ({ children }: any) => <div>{children}</div> }))
vi.mock("../Section", () => ({ Section: ({ children }: any) => <div>{children}</div> }))
vi.mock("../ExperimentalFeature", () => ({
	ExperimentalFeature: ({ experimentKey, onChange }: any) => (
		<button data-testid={`feature-${experimentKey}`} onClick={() => onChange(true)} />
	),
}))
vi.mock("../ImageGenerationSettings", () => ({ ImageGenerationSettings: () => null }))
vi.mock("../NativeToolIntegrationsSettings", () => ({ NativeToolIntegrationsSettings: () => null }))
vi.mock("../CustomToolsSettings", () => ({ CustomToolsSettings: () => null }))

describe("ExperimentalSettings parallel subtasks", () => {
	const renderSettings = (props: Record<string, unknown>) => {
		const setCachedStateField = vi.fn()
		const setExperimentEnabled = vi.fn()
		render(
			<ExperimentalSettings
				experiments={{} as any}
				setExperimentEnabled={setExperimentEnabled}
				setCachedStateField={setCachedStateField}
				{...props}
			/>,
		)
		return { setCachedStateField, setExperimentEnabled }
	}

	it("shows the toggle, which writes the experiment, and hides the limits while it is off", () => {
		const { setExperimentEnabled } = renderSettings({})
		fireEvent.click(screen.getByTestId("feature-PARALLEL_SUBTASKS"))
		expect(setExperimentEnabled).toHaveBeenCalledWith("parallelSubtasks", true)
		expect(screen.queryByTestId("parallel-subtasks-concurrency-slider")).toBeNull()
		expect(screen.queryByTestId("parallel-subtasks-token-budget-input")).toBeNull()
	})

	it("shows defaults when the experiment is on and no value is stored", () => {
		renderSettings({ experiments: { parallelSubtasks: true } })
		expect(screen.getByTestId("parallel-subtasks-concurrency-value")).toHaveTextContent("2")
		expect(screen.getByTestId("parallel-subtasks-token-budget-input")).toHaveValue(2_000_000)
	})

	it("the concurrency slider (1 to 4) writes parallelSubtasksConcurrency", () => {
		const { setCachedStateField } = renderSettings({
			experiments: { parallelSubtasks: true },
			parallelSubtasksConcurrency: 3,
		})
		const slider = screen.getByTestId("parallel-subtasks-concurrency-slider")
		expect(slider).toHaveAttribute("min", "1")
		expect(slider).toHaveAttribute("max", "4")
		fireEvent.change(slider, { target: { value: "4" } })
		expect(setCachedStateField).toHaveBeenCalledWith("parallelSubtasksConcurrency", 4)
	})

	it("the budget input writes parallelSubtasksTokenBudget only at or above 100,000", () => {
		const { setCachedStateField } = renderSettings({ experiments: { parallelSubtasks: true } })
		const input = screen.getByTestId("parallel-subtasks-token-budget-input")
		fireEvent.change(input, { target: { value: "50000" } })
		expect(setCachedStateField).not.toHaveBeenCalledWith("parallelSubtasksTokenBudget", 50_000)
		expect(screen.getByText("settings:experimental.parallelSubtasks.tokenBudgetMinimum")).toBeInTheDocument()
		fireEvent.change(input, { target: { value: "750000" } })
		expect(setCachedStateField).toHaveBeenCalledWith("parallelSubtasksTokenBudget", 750_000)
		expect(screen.queryByText("settings:experimental.parallelSubtasks.tokenBudgetMinimum")).toBeNull()
	})
})
