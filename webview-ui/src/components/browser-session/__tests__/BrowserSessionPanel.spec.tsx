import { act, render, screen } from "@testing-library/react"

import BrowserSessionPanel from "../BrowserSessionPanel"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("../../common/CodeBlock", () => ({ default: () => null }))

describe("standalone browser panel activity", () => {
	it.each([false, true])("uses live updates after hydration with active=%s", (initiallyActive) => {
		render(<BrowserSessionPanel />)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { isBrowserSessionActive: initiallyActive, browserViewportSize: "900x600" },
					},
				}),
			)
		})
		const expectActive = (active: boolean) => {
			const indicator = screen.getByLabelText("Browser interaction")
			if (active) expect(indicator).toHaveStyle({ color: "#4ade80" })
			else expect(indicator).not.toHaveStyle({ color: "#4ade80" })
		}
		expectActive(initiallyActive)
		for (const active of [!initiallyActive, initiallyActive]) {
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "browserSessionUpdate", isBrowserSessionActive: active },
					}),
				)
			})
			expectActive(active)
		}
	})
})
