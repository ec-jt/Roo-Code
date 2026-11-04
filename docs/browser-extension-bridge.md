# Optional per-tab Chrome extension bridge

The 4.2.51 / Cordis preview 47 release includes the host support and a separate companion source ZIP. The companion is not installed automatically and has not been verified against a live Chrome profile. Extract the source ZIP before following the manual unpacked-extension installation steps below. No dependencies or extension build are required. Use Chrome 118 or later. Chrome 118 keeps a service worker with an active debugger attachment alive; pairing state is never restored after a worker restart.

The existing dedicated-browser and direct-CDP workflows remain available. This optional transport attaches only the active HTTP(S) tab after an explicit action in the companion popup. It does not discover Chrome debugging ports, enumerate all browser tabs, attach automatically, or close user tabs.

## Trust and permissions

The companion requests Chrome debugger permission and active-tab permission. **Debugger permission is powerful.** Review the companion source before loading it. The implementation deliberately exposes only bounded, typed, read-only commands. A modified or compromised companion is outside this protection boundary. The extension host and local OS are trusted: a local process that steals the bearer secret can impersonate a client and spoof HTTP headers. Exact origins and Host validation are not authentication against such a process.

The only host permission is HTTP loopback on 127.0.0.1. There are no content scripts, external-message entry points, persistent storage permissions, cookies, response-body collection, arbitrary page evaluation, or certificate bypasses. The bridge never enables the CDP Security domain. Chrome's existing trust store and profile policies still apply; Roo does not audit a user's previously configured browser trust policy.

Page metadata and URL paths may contain secrets or malicious instructions. Approved model results enter task history and model context. Labels are untrusted text, not tool instructions. URL metadata removes username, password, query, and fragment, not path secrets. The snapshot exports tag, role, selected accessibility-label attributes, input type, and opaque references, not input values or raw attributes. DOM snapshots are bounded structural metadata, not a complete accessibility tree or screenshot. They exclude shadow trees and child-frame documents. Very large nodes may fail closed rather than return partial raw data.

## Manual setup

1. In Chrome's extensions manager, enable developer mode.
2. Choose **Load unpacked** and select [apps/browser-bridge](../apps/browser-bridge/manifest.json).
3. Open the companion popup and note its extension ID.
4. In an idle foreground Roo task, open **Browser controls** and select **Refresh status**.
5. Disconnect any existing browser transport. Select **Start Chrome bridge** and approve the native confirmation.
6. Enter the companion's exact extension ID in the native VS Code input. Roo accepts only that extension origin.
7. Copy the loopback endpoint and secret from the native pairing input into the companion popup. Keep secrets out of chat, screenshots, recordings, logs, tickets, and files. VS Code shows the secret as selectable text; it is not sent to the webview. Clipboard history, if used, is outside Roo's control.
8. Make the intended HTTP(S) tab active and choose **Pair and attach active tab** in the popup. This is the explicit debugger-attachment authorization.
9. Confirm the native pairing input with Enter to keep the listener. Escape revokes it. The input is not a model-tool approval.
10. Refresh Roo status, list tabs, and select the attached tab. Native confirmation is required for listing and selection. The list contains only the one explicitly attached tab.
11. Approve each subsequent typed model command separately in its native modal.
12. Finish with **Stop Chrome bridge**, **Disconnect**, or **Revoke and detach** in the popup. A new pairing requires a new native start. There is no reconnect or retry button that bypasses approval.

Pairing must finish within two minutes. A paired session expires after thirty minutes or ten seconds without authenticated client activity. Native stop immediately revokes the listener and pending work; the companion detaches when its next request fails. Popup revoke detaches immediately; the service observes the lost heartbeat within ten seconds. Task teardown also revokes the listener. An unsupported top-level URL, DevTools taking over the debugger, failed transport/authentication, timeout, or malformed server command detaches the companion. No user tab is closed. Worker suspension makes a best-effort detach and loses all credentials; it never restores or resumes commands.

If the native dialog expires, pairing fails, or the panel times out, refresh status and explicitly stop/restart the bridge. Do not assume an approved operation failed merely because its reply was lost. Credentials are ephemeral and cannot be retrieved later through the panel or a model command.

## Transport and bounds

The extension-host service binds only 127.0.0.1 on an OS-assigned port after native approval. It uses bounded HTTP POST polling. Requests require an exact Host, exact selected extension Origin, and a 256-bit secret in the authorization header. CORS permits only the selected origin, POST, authorization, and content-type headers. Credentials are never URL parameters. Bodies use strict schemas, a maximum of 128 KiB, a per-client sequence counter, and one paired client. The listener permits at most eight sockets, forty requests per second, and one outstanding command. Socket idle/header/request deadlines, command deadlines, pairing expiry, session expiry, and heartbeat expiry bound resource use. A command is delivered once, not resent on a later poll. Results match an outstanding request and document ID. The companion also rejects duplicate command IDs and ends a session after at most 1,000 commands.

Reference IDs are random, scoped to the current attachment/document and snapshot, and cleared on document changes, new snapshots, and detach. The host changes its session ID on revocation. Only the native session panel can start the listener or show credentials. Its request schema has no secret, endpoint, extension ID, or arbitrary browser-command field.

Supported bridge commands are status, tabs, explicit selection, snapshot, inspect, and bounded wait. Snapshot returns at most 100 elements and traverses at most 200 nodes. Inspect reads bounded metadata for a current reference. Navigation, click, fill, select-value, styles, console, network, performance, evaluation, response bodies, debugger controls, and certificate exceptions are unavailable on this transport. Capability flags report these restrictions. Use dedicated CDP for its broader separately approved command set. Legacy launch, coordinates, screenshots, navigation, and full-page capture refuse while the bridge transport is active instead of silently launching or using another browser. Close explicitly revokes it.

## Remote extension hosts

Loopback belongs to the machine running the VS Code extension host, not necessarily the desktop displaying VS Code. A Chrome companion on another machine cannot reach that listener automatically. Same-machine use works without forwarding. An experienced user may independently create a private loopback-to-loopback reverse forwarding arrangement, preserving the same port and exact Host header. Roo does not create, configure, discover, or verify such forwarding. Do not expose the listener publicly, use wildcard binds, disable authentication, or change the origin check. A forwarding system expands the trust boundary to its endpoints and operators. No automatic private-host access or tunnel is provided.

## Validation status

Focused tests cover loopback authentication, wrong origin/Host/token, strict schema and size rejection, replay/sequence rejection, one-client selection, document/session invalidation, close, native denial/staleness/cancellation, and mocked companion attachment/revocation. These do not establish live Chrome compatibility, enterprise-policy behavior, DevTools timing, browser-version CORS behavior, or remote-forwarding safety. No live installation or attach was performed.
