import React from "react"

interface CloudViewProps {
	userInfo?: { organizationName?: string; email?: string }
	isAuthenticated?: boolean
	cloudApiUrl?: string
	organizations?: Array<{ id: string; name: string }>
}

export const CloudView: React.FC<CloudViewProps> = ({ userInfo, isAuthenticated, cloudApiUrl, organizations }) => {
	return (
		<div style={{ padding: "20px" }}>
			<h2>Cloud</h2>
			{isAuthenticated ? (
				<div>
					<p>Connected to Roo Code Cloud</p>
					{userInfo?.email && <p>Email: {userInfo.email}</p>}
					{userInfo?.organizationName && <p>Organization: {userInfo.organizationName}</p>}
					{organizations && organizations.length > 0 && (
						<div>
							<h3>Organizations</h3>
							<ul>
								{organizations.map((org) => (
									<li key={org.id}>{org.name}</li>
								))}
							</ul>
						</div>
					)}
				</div>
			) : (
				<p>Not connected to Roo Code Cloud. Configure your cloud settings to get started.</p>
			)}
		</div>
	)
}

export default CloudView
