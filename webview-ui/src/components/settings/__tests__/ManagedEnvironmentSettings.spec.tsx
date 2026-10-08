import { fireEvent, render, screen } from "@testing-library/react"
import type { ExtensionState } from "@roo-code/types"
import { ManagedEnvironmentSettings } from "../ManagedEnvironmentSettings"
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it("starts disabled and changes only the dedicated consent field", () => {
	const setField = vi.fn()
	render(<ManagedEnvironmentSettings state={{} as ExtensionState} setField={setField} />)
	const consent = screen.getByLabelText("settings:managedEnvironments.autoApprove")
	expect(consent).not.toBeChecked()
	expect(screen.getByLabelText("settings:managedEnvironments.enabled")).not.toBeChecked()
	fireEvent.click(consent)
	expect(setField).toHaveBeenCalledWith("alwaysAllowManagedEnvironments", true)
	expect(setField).toHaveBeenCalledTimes(1)
})
