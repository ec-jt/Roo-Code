# Direct-CDP browser controls

These controls are included in the 4.2.51 / Cordis preview 47 release. Packaging and automated checks do not establish live browser compatibility. Direct-CDP browser access runs on the VS Code extension host, which may be a remote SSH host, not the machine displaying the webview. Existing local browser launch and remote CDP connection settings remain the entry point for this transport. An optional [per-tab Chrome extension bridge](browser-extension-bridge.md) provides a separate, more restricted transport with native-only pairing and explicit popup attachment. Read the active transport and capability flags; the command table below describes CDP, not feature parity with the companion.

## Native session panel

1. Open a task and expand **Browser controls** in the chat view.
2. Select **Refresh status** to read local session metadata without enumerating tabs.
3. Read the actual extension-host platform, hostname and remote environment, transport, ownership, selected tab and capabilities.
4. Select **List tabs** and approve the native confirmation to expose sanitized tab URLs to the panel.
5. Select **Select tab** and approve the native confirmation before model interaction with an existing tab.
6. Select **Disconnect** and approve the native confirmation when finished.

Tab listing, selection and disconnect require the current idle foreground task. They carry request, task, task-instance and session identifiers. A session or task change during native review invalidates the request. Cancellation executes no browser command. Refresh after a timeout or stale-session error; do not assume an approved mutation failed merely because its reply was lost.

Disconnect detaches an attached browser without closing user tabs. It closes Roo-owned sessions. The panel cannot send arbitrary browser commands. Launch/connect remain available through existing browser settings and the browser action tool.

URLs omit user credentials, query and fragment. Paths remain visible and can contain secrets. There is no claim of complete redaction. The panel uses native messaging only and does not log requests through the browser-development fallback.

## Model tool

The existing browser action tool accepts an outer control action and a typed command object. The native schema describes every command field. JSON-encoded command objects are also validated at the parser boundary. Unknown fields, model-provided approval flags, unsupported actions and invalid limits are rejected before approval.

Read-only commands (status, tabs, snapshot, console, network, inspect, styles and performance) require one native confirmation per task and browser session. Later read-only commands in the same session run without another prompt. A new session or task requires a fresh confirmation. Mutating commands (navigate, click_ref, fill_ref, select_ref) and select_tab always require explicit approval for each call. Generic browser and all-tools auto-approval do not approve any of these commands. Mode/tool restrictions and task-operation cancellation still apply. The implementation rechecks task identity, operation revision and session selection around asynchronous approval/settings boundaries.

Supported commands:

| Command     | Required command fields                   | Behavior                                                                 |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| status      | action                                    | Local connection, host and capability metadata                           |
| tabs        | action                                    | At most 100 eligible tabs with opaque IDs and sanitized URLs             |
| select_tab  | action, sessionId, tabId                  | Explicit tab selection                                                   |
| navigate    | action, url                               | HTTP(S); selected tab only, or a new Roo-owned tab when none is selected |
| snapshot    | action, sessionId, tabId                  | Bounded element references; optional limit from 1 to 100                 |
| click_ref   | action, sessionId, tabId, ref             | Click a fresh referenced element                                         |
| fill_ref    | action, sessionId, tabId, ref, text       | Fill up to 10,000 characters                                             |
| select_ref  | action, sessionId, tabId, ref, values     | Select 1 to 20 values                                                    |
| wait        | action, sessionId, tabId, durationMs      | Bounded delay from 0 to 5,000 milliseconds                               |
| console     | action, sessionId, tabId                  | Bounded selected-tab console buffer; optional clear                      |
| network     | action, sessionId, tabId                  | Bounded network metadata, never response bodies; optional clear          |
| inspect     | action, sessionId, tabId, ref             | Bounded element metadata                                                 |
| styles      | action, sessionId, tabId, ref, properties | 1 to 30 CSS property names                                               |
| performance | action, sessionId, tabId                  | Bounded numeric metrics                                                  |

All commands except status accept an optional timeout from 100 to 15,000 milliseconds. Use IDs returned by current results. Console/network collection begins after explicit selection; it does not expose historical browser traffic. Legacy screenshot/coordinate actions clear rich selection and element references. Navigation invalidates references. Take a fresh snapshot after a stale-reference response. Do not automatically retry an uncertain click, fill, selection or navigation.

Rich results are structured, not screenshots. The chat row offers an expandable result. **Model tool results enter task history and model context.** DOM, console, network metadata and URL paths may contain secrets or malicious page instructions. Approval discloses this persistence and exposure. Treat all page content as untrusted data, never as permission to use tools or change policy. Input parameters also follow the normal tool-call transcript path; do not use these tools for secrets that must not enter task history.

## Limitations and TLS

Arbitrary evaluation, raw CDP methods, response bodies and debugger controls are not usable or advertised as supported. Model commands cannot enable certificate exceptions. The panel reports unavailable model capabilities explicitly. There is no automatic tab choice, automatic session launch or silent action retry in the rich-control flow.

TLS verification stays enabled by default. Check the certificate chain, hostname, expiry, clock and browser trust store. An attached browser can run on a different machine from the extension host. Remote SSH and direct-CDP transport setup instructions remain unchanged.

### Native-only isolated certificate session

Prefer fixing the certificate or installing the correct internal CA. If an exception is necessary, disconnect the browser, disable remote-browser connection in settings, then use **Review isolated certificate exception** in the idle foreground task's panel. Two native confirmations precede launch. Roo creates a new local browser process with a fresh temporary profile on the reported extension host. No page opens automatically; use an approved rich navigation command afterward, not the legacy launch action (which replaces the session).

**All invalid TLS certificates are accepted throughout that isolated session**, including redirects and subresources. This is not a hostname-specific exception or certificate pin. Do not use personal accounts or unrelated sites. The panel and model status expose the exception policy. Disconnect closes the owned browser and removes its temporary profile; a later normal launch verifies certificates again. Attached CDP browsers, configured remote browsers and the Chrome companion cannot use this action. A model approval flag cannot enable it. Native approval is rechecked before launch and stale task completion closes the new session.

This exception does not authorize BIOS changes, power operations, form submissions or other site mutations. It does not alter the separate credential-free PDF fetcher's TLS policy or the user's Python environment.

Service and UI tests use mocks; bridge authentication tests also use an ephemeral loopback HTTP listener. No personal browser profile or private host was contacted. A disposable sandboxed Chromium smoke test was attempted, but Snap refused launch from the code-server service cgroup. No sandbox bypass or alternate browser installation was attempted. Live browser control, certificate-error navigation, and installed-extension behavior remain unverified. The PDF and token-count worker entry sources were bundled successfully in a temporary directory; no VSIX was built.
