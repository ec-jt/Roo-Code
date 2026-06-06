import React from "react"

import { render, screen } from "@/utils/test-utils"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@roo/package", () => ({
	Package: {
		version: "3.54.0",
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} onClick={onClick} {...props}>
			{children}
		</a>
	),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey, components }: { i18nKey: string; components?: Record<string, React.ReactElement> }) => {
		if (i18nKey === "chat:announcement.communityFork.intro") {
			return (
				<span>
					Welcome to the community-maintained fork of Roo Code! This fork is maintained by{" "}
					{components?.forkLink && React.cloneElement(components.forkLink, {}, "ec-jt")} and the community to
					keep the project alive and actively developed.
				</span>
			)
		}

		return <span>{i18nKey}</span>
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { version?: string }) => {
			const translations: Record<string, string> = {
				"chat:announcement.communityFork.title": "Roo Code Community Fork 3.54.0",
				"chat:announcement.communityFork.continuity":
					"This extension will continue to receive bug fixes, new features, and model updates from the community.",
				"chat:announcement.communityFork.signoff": "Happy coding!",
			}

			if (key === "chat:announcement.communityFork.title") {
				return `${translations[key]}${options?.version ? "" : ""}`
			}

			return translations[key] ?? key
		},
	}),
}))

describe("Announcement", () => {
	it("renders the community fork announcement", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Roo Code Community Fork 3.54.0")).toBeInTheDocument()
		expect(screen.getByText(/Welcome to the community-maintained fork/)).toBeInTheDocument()
		expect(
			screen.getByText(
				"This extension will continue to receive bug fixes, new features, and model updates from the community.",
			),
		).toBeInTheDocument()
		expect(screen.getByText("Happy coding!")).toBeInTheDocument()
	})

	it("renders the fork link", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByRole("link", { name: "ec-jt" })).toHaveAttribute(
			"href",
			"https://github.com/ec-jt/Roo-Code",
		)
	})
})
