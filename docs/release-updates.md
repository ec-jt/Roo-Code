# Updating from this fork's GitHub releases

Use **Roo Settings > About > GitHub release updates**. This updater checks only **ec-jt/Roo-Code**, including stable releases and experimental Cordis previews. It does not search the Marketplace or accept a custom repository, URL, or installer path from chat.

## Manual update

1. Save your work. Installation is allowed while a Roo task is loaded or running; activation is separate.
2. Select **Check for updates** to see the newer version and release notes, or select **Update / install latest** to check and install in one flow.
3. Confirm the version and source in the native VS Code dialog.
4. Wait for download, verification, and VS Code installation to finish.
5. Finish or stop work and close the loaded task before selecting **Reload to activate**. Reload interrupts the extension host. **Developer: Reload Window** bypasses Roo's reload guard, so use it only when safe.

The updater does not uninstall Roo, delete settings/tasks, or automatically reload. A successful installation command is not proof that the running extension has switched versions; reload and check the version shown in About.

The first release containing this updater must still be installed once using **Extensions: Install from VSIX**. Version 4.2.29 and earlier do not contain it. Subsequent newer releases can be installed from About without a manual download command.

## Optional automatic installation

Automatic updating is **off by default**. Enable **Automatically install GitHub release updates** and confirm the native warning. This is host-local consent, not part of imported or synchronized Roo settings. The option takes effect immediately and does not use the Settings Save button.

When enabled, Roo checks about 30 seconds after activation and every six hours. Loaded or running tasks do not block checks or installation. Installation rechecks cancellation and automatic-update consent after download. Failed checks do not retry in a tight loop; use the manual button or wait for the next scheduled check. No additional update is installed while a previously installed version awaits reload.

Disabling automation stops pending work before it is handed to VS Code. Once VS Code is installing, the updater cannot cancel that installation. Reload is always manual. Other VS Code windows can have separate extension hosts; this is not a machine-wide task lock.

## Remote SSH and code-server

The download runs where Roo's extension host runs. The verified VSIX is passed to VS Code as a file URI, not a Marketplace extension ID or a shell command. VS Code's remote-extension RPC transforms host file URIs for its installer. In Remote SSH, perform the update in the remote window and verify the installed version in that remote extension list. Update a separate local Mac installation or another SSH host separately.

VS Code distributions and administrator policies can reject VSIX installation. Errors are reported rather than falling back to an unverified or shell-based installer. Actual installation and remote targeting still require platform integration testing; unit tests mock the VS Code install command.

## Verification and trust

- Consider only strict versioned release tags and exact matching VSIX/checksum asset names. Do not downgrade or reinstall the running version. Search at most the latest 300 listed releases.
- Use HTTPS with certificate verification, a fixed host allowlist, bounded redirects, timeouts, and download size limits. No repository credentials or provider keys are sent.
- Download to a unique temporary directory. On Linux/macOS, enforce owner-only permissions and verify ownership. On Windows, inherit the temporary location's ACLs; Node's Unix mode bits do not describe Windows ACL privacy and are not used to reject the directory. Keep the Windows user temporary location protected by its normal user ACLs; custom shared temporary locations are not supported as a security boundary. Check SHA-256 against the release sidecar and GitHub's asset digest when present.
- Inspect archive paths, size/compression limits, and the extension manifest without extracting or executing it. Require the expected publisher, extension name, and release version. Reject known incompatible engine ranges; VS Code remains responsible for final compatibility checks.
- Hand the verified file to the VS Code installer. Clean temporary files after success, rejection, or failure. An extension-host crash may leave its private temporary directory behind.

Checksums detect corruption or mismatch. They are not an independent signature and do not protect against a compromised release publisher. Enable automation only if you trust this repository's releases. The updater currently uses direct HTTPS; environments requiring a mandatory HTTP proxy can fail and may need manual installation. No security checks are disabled to make an update succeed.

## Marketplace auto-update is separate

This fork retains the same extension identity as upstream. VS Code/Open VSX auto-update is controlled by the editor, not this updater. Disable marketplace auto-update for this extension through the Extensions UI if you want only the fork's GitHub releases. Roo does not change the editor's global update settings or disable updates for other extensions.

Rollback remains a manual installation of an older trusted VSIX. It does not restore task history, files, or settings. A saved pending-install receipt may still show a newer installed version if you deliberately downgrade before activating it; clear that receipt only after verifying the actual installed version.
