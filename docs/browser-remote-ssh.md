# Browser use with VS Code Remote SSH

The VS Code window can run on your Mac while Roo's extension host runs on Linux. Local browser selection refers to that Linux host, not the Mac. Choose one of the following paths; Roo does not automatically switch between them after failure.

## A. Browser on the Linux server

1. Turn **Remote browser** off in Roo's Browser settings.
2. Leave **Show browser window** off for a headless server.
3. Select **Managed Chromium**, or **Installed Google Chrome** if an administrator has already installed Chrome on that server.
4. Save settings and close any existing Roo browser session before launching another.

Both browsers keep their sandbox enabled. Installed Chrome can work where downloaded Chromium lacks a matching AppArmor policy, but that is not guaranteed. Root execution, disabled user namespaces, container restrictions, and security policy can still prevent either browser from launching. A display server does not fix a sandbox failure.

### Read-only diagnostics

Run these in the affected VS Code **remote** terminal. They do not change policy or require elevation:

```bash
id
uname -sr
sysctl kernel.unprivileged_userns_clone kernel.apparmor_restrict_unprivileged_userns user.max_user_namespaces 2>/dev/null
cat /proc/self/attr/current
grep -E '^(NoNewPrivs|Seccomp):' /proc/self/status
journalctl -k --since '15 minutes ago' --no-pager 2>/dev/null | grep -Ei 'apparmor|userns|denied|seccomp' | tail -60
```

Missing sysctl keys are normal on some distributions. Logs may be inaccessible to your account; no visible denial does not prove that policy allowed the launch. The terminal's confinement may differ from the extension host or Chromium. Give the administrator the launch error, executable path, timestamp, and accessible denial messages. Ask for a narrowly scoped, supported browser policy or installation. Do not disable AppArmor globally, change system-wide namespace policy blindly, or add sandbox-disabled flags.

With a browser on Linux, a localhost development URL refers to the Linux server.

## B. Chrome on the Mac, controlled through SSH

Use only a trusted server and SSH account. Chrome debugging gives the remote side control of the dedicated browser and access to pages/network resources that browser can reach. Other users on a shared server may access a loopback TCP listener. Do not use this setup on an untrusted multi-user host. Never use your personal Chrome profile or expose the debugging endpoint publicly.

These commands are examples to run yourself, not commands Roo runs automatically. Replace USER@SERVER with the same destination or SSH alias used by VS Code. Ports 9222 and 3000 must be available.

1. In a **Mac terminal**, start a separate Chrome process with a temporary profile:

    ```bash
    ROO_CHROME_PROFILE=$(mktemp -d /tmp/roo-chrome-XXXXXX)
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --user-data-dir="$ROO_CHROME_PROFILE" \
      --remote-debugging-address=127.0.0.1 \
      --remote-debugging-port=9222 --no-first-run --no-default-browser-check
    ```

    The separate data directory also meets recent Chrome restrictions on debugging the default profile. Keep the browser running. The sandbox remains enabled.

2. In another **Mac terminal**, verify Chrome's loopback listener:

    ```bash
    lsof -nP -iTCP:9222 -sTCP:LISTEN
    curl --fail --max-time 5 http://127.0.0.1:9222/json/version
    ```

    Expect a loopback listener and a JSON response with a browser-level WebSocket URL. Stop if the listener is public. Do not share the debugging URL.

3. In that **Mac terminal**, open the reverse tunnel:

    ```bash
    ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
      -R 127.0.0.1:9222:127.0.0.1:9222 USER@SERVER
    ```

    Keep it running. If SSH forwarding is prohibited, ask the administrator. Do not bypass the restriction. A port conflict must be resolved before proceeding; do not kill an unrelated listener.

4. In the VS Code **remote terminal**, verify the server binding and reachability:

    ```bash
    ss -ltn 'sport = :9222'
    curl --fail --max-time 5 http://127.0.0.1:9222/json/version
    ```

    The server listener must be on 127.0.0.1, not 0.0.0.0 or [::]. Server GatewayPorts configuration can override requested bindings; stop the tunnel if it exposes the endpoint. Do not open a firewall port. Use the same port at both ends for this recipe so the advertised WebSocket port stays reachable.

5. In Roo's Browser settings, enable **Remote browser** and enter **http://127.0.0.1:9222** explicitly. Test and save. The test verifies HTTP discovery; a browser action must also establish the WebSocket connection.
6. Close any existing Roo browser session and launch a new browser action. Roo uses the Mac browser rather than launching Linux Chromium.

### Accessing a development server on Linux

Mac Chrome's localhost is the Mac. To reach a development server listening on Linux port 3000, stop the tunnel above and replace it with this command in the **Mac terminal**:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -R 127.0.0.1:9222:127.0.0.1:9222 \
  -L 127.0.0.1:3000:127.0.0.1:3000 USER@SERVER
```

Browse to **http://127.0.0.1:3000**. Forward additional application ports as needed, or use VS Code's Ports view. Do not create a duplicate forward on a port already used by VS Code.

### Finish the session

Disconnect Roo, close the dedicated Chrome process, and stop the SSH tunnel with Ctrl+C. Roo disconnects rather than shutting down externally managed Chrome. The temporary profile remains on your Mac; remove only the exact directory you created after Chrome has exited if it is no longer needed. Never remove a normal Chrome profile.

## Scope and verification

The Remote browser setting applies to browser actions. The separate web-to-Markdown fetcher still launches managed Chromium on the extension host and needs that host's sandbox to work.

Roo cannot launch an application on the Mac from the Linux extension host without a separate local helper. This setup uses manually started Chrome and standard SSH forwarding, not a local helper or a public debugging service. Unit tests cover Linux executable selection, preserved sandbox flags, no fallback, endpoint response validation, and settings guidance. They do not prove that a particular server permits namespaces or that a Mac-to-server SSH tunnel works. Those require checks on the affected machines.
