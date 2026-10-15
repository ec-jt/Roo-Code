/** Setup instructions only. Never launch processes or change host policy from settings. */
export function BrowserSshSetup() {
	return (
		<details className="text-sm text-vscode-descriptionForeground">
			<summary className="cursor-pointer font-medium">Remote SSH: browser on the server or on your Mac</summary>
			<div className="mt-2 space-y-3">
				<p>
					Local browser means the VS Code extension host. In Remote SSH this is the Linux server, not your
					Mac.
				</p>
				<p>
					<strong>On Linux:</strong> turn Remote browser off and leave Show browser window off for a headless
					server. Select Managed Chromium or Installed Google Chrome. Chrome must already be installed on the
					server. Both retain the sandbox. If user namespaces or AppArmor block launch, ask the administrator
					to review the denial for the executable shown in the error. Roo does not change security policy.
				</p>
				<p>
					<strong>On your Mac:</strong> use a dedicated Chrome profile, never your personal signed-in profile.
					Run the following in a Mac terminal, not the VS Code remote terminal. Close this separate Chrome
					instance when finished.
				</p>
				<pre className="whitespace-pre-wrap break-all rounded bg-vscode-editor-background p-2 select-text">{`ROO_CHROME_PROFILE=$(mktemp -d /tmp/roo-chrome-XXXXXX)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
  --user-data-dir="$ROO_CHROME_PROFILE" \\
  --remote-debugging-address=127.0.0.1 \\
  --remote-debugging-port=9222 --no-first-run --no-default-browser-check`}</pre>
				<p>
					In a second Mac terminal, replace USER@SERVER with your SSH destination. Keep this tunnel running:
				</p>
				<pre className="whitespace-pre-wrap break-all rounded bg-vscode-editor-background p-2 select-text">{`ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \\
  -R 127.0.0.1:9222:127.0.0.1:9222 USER@SERVER`}</pre>
				<p>
					In Roo, enable Remote browser, enter <strong>http://127.0.0.1:9222</strong>, test the connection,
					and save. Close any existing Roo browser session before launching again. The connection test checks
					the discovery response; a browser launch also needs a working WebSocket connection.
				</p>
				<p>
					For a development server on Linux port 3000, add <strong>-L 127.0.0.1:3000:127.0.0.1:3000</strong>{" "}
					to that SSH command, then browse to <strong>http://127.0.0.1:3000</strong>. With Mac Chrome,
					localhost means the Mac. With Linux Chromium, localhost means the server.
				</p>
				<p>
					<strong>Security:</strong> debugging grants control of the dedicated browser. Use only a trusted
					server and account. Other users on a shared server may reach its loopback listener. Verify the
					server listener stays on 127.0.0.1, not 0.0.0.0 or [::]; server GatewayPorts policy can override the
					requested binding. Do not open a firewall port or disable the browser sandbox. Stop the tunnel when
					finished. If forwarding is prohibited, ask the administrator rather than bypassing the restriction.
				</p>
				<p>
					Roo cannot start Chrome on your Mac from the remote extension host. The separate web-to-Markdown
					fetcher still uses Chromium on the extension host; the remote-browser setting applies to browser
					actions.
				</p>
			</div>
		</details>
	)
}
