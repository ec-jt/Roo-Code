import { memo, type ReactNode, useState } from "react"
import { Trans } from "react-i18next"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { Package } from "@roo/package"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@src/components/ui"

interface AnnouncementProps {
	hideAnnouncement: () => void
}

/**
 * You must update the `latestAnnouncementId` in ClineProvider for new
 * announcements to show to users. This new id will be compared with what's in
 * state for the 'last announcement shown', and if it's different then the
 * announcement will render. As soon as an announcement is shown, the id will be
 * updated in state. This ensures that announcements are not shown more than
 * once, even if the user doesn't close it themselves.
 */

const Announcement = ({ hideAnnouncement }: AnnouncementProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(true)

	return (
		<Dialog
			open={open}
			onOpenChange={(open) => {
				setOpen(open)

				if (!open) {
					hideAnnouncement()
				}
			}}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("chat:announcement.communityFork.title", { version: Package.version })}</DialogTitle>
				</DialogHeader>
				<div className="text-sm leading-relaxed text-vscode-descriptionForeground">
					<p className="mt-0">
						<Trans
							i18nKey="chat:announcement.communityFork.intro"
							components={{
								forkLink: (
									<ExternalLink href="https://github.com/ec-jt/Roo-Code" />
								),
							}}
						/>
					</p>
					<p>{t("chat:announcement.communityFork.continuity")}</p>
					<p className="mb-0">{t("chat:announcement.communityFork.signoff")}</p>
				</div>
			</DialogContent>
		</Dialog>
	)
}

const ExternalLink = ({ children, href }: { children?: ReactNode; href: string }) => (
	<VSCodeLink
		href={href}
		onClick={(e) => {
			e.preventDefault()
			vscode.postMessage({ type: "openExternal", url: href })
		}}>
		{children}
	</VSCodeLink>
)

export default memo(Announcement)
