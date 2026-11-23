import { render, screen, fireEvent } from "@testing-library/react"

import { ExperimentalSettings } from "../ExperimentalSettings"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

// Native <select> stand-in for the Radix select, so tests can choose an option directly.
vi.mock("@src/components/ui", () => ({
	Select: ({ value, onValueChange, children }: any) => (
		<select data-testid="mock-select" value={value} onChange={(e) => onValueChange(e.target.value)}>
			{children}
		</select>
	),
	SelectTrigger: () => null,
	SelectValue: () => null,
	SelectContent: ({ children }: any) => <>{children}</>,
	SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
}))

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ settingId, children }: any) => <div data-setting-id={settingId}>{children}</div>,
}))
vi.mock("../SectionHeader", () => ({ SectionHeader: ({ children }: any) => <div>{children}</div> }))
vi.mock("../Section", () => ({ Section: ({ children }: any) => <div>{children}</div> }))
vi.mock("../ExperimentalFeature", () => ({
	ExperimentalFeature: ({ experimentKey }: any) => <div data-testid={`feature-${experimentKey}`} />,
}))
vi.mock("../ImageGenerationSettings", () => ({ ImageGenerationSettings: () => null }))
vi.mock("../NativeToolIntegrationsSettings", () => ({ NativeToolIntegrationsSettings: () => null }))
vi.mock("../CustomToolsSettings", () => ({ CustomToolsSettings: () => null }))

function profileSelect(): HTMLSelectElement {
	const container = document.querySelector('[data-setting-id="experimental-task-profile"]')!
	return container.querySelector("select") as HTMLSelectElement
}

describe("ExperimentalSettings task profile select", () => {
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

	it("replaces the Cordis on/off toggle with a three-option select", () => {
		renderSettings({})
		expect(screen.queryByTestId("feature-CORDIS_RUNTIME_PREVIEW")).toBeNull()
		const options = Array.from(profileSelect().options).map((o) => o.value)
		expect(options).toEqual(["modes", "cordis", "hybrid"])
	})

	it("writes taskProfile and never the legacy flag", () => {
		const { setCachedStateField, setExperimentEnabled } = renderSettings({})
		fireEvent.change(profileSelect(), { target: { value: "hybrid" } })
		expect(setCachedStateField).toHaveBeenCalledWith("taskProfile", "hybrid")
		expect(setExperimentEnabled).not.toHaveBeenCalled()
	})

	it("shows the effective value from the legacy flag when taskProfile is not set", () => {
		renderSettings({ experiments: { cordisRuntimePreview: false } })
		expect(profileSelect().value).toBe("modes")
	})

	it("shows modes when neither taskProfile nor the legacy flag is set (ADR-2026-11-23-modes-default-profile)", () => {
		renderSettings({})
		expect(profileSelect().value).toBe("modes")
	})

	it("shows cordis for a stored legacy flag true without taskProfile", () => {
		renderSettings({ experiments: { cordisRuntimePreview: true } })
		expect(profileSelect().value).toBe("cordis")
	})

	it("shows taskProfile when set, over the legacy flag", () => {
		renderSettings({ taskProfile: "hybrid", experiments: { cordisRuntimePreview: false } })
		expect(profileSelect().value).toBe("hybrid")
	})
})
