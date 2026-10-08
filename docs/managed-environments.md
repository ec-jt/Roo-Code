# Managed Python environments MVP

This feature creates a new Roo-owned Python virtual environment from a reviewed manifest of exact wheels. It is not a general package manager, a sandbox, or a system installer.

## Using the experimental feature

Configure **Settings > Experimental > Managed Python environments**. Both feature enablement and install auto-approval default off. Set a private absolute environment root outside the workspace and the real absolute CPython executable path (not a symlink). The root's parent must exist. Limits default to 512 MiB downloaded, 2048 MiB observed disk use per installation, and 600 seconds.

The structured `managed_environment` tool accepts `action` (`prepare`, `install`, or `status`) and a workspace-relative `manifest_path`, such as `roo-environment.json`. It is available only in modes with command tools and when configured. Create the manifest using the ordinary file-write permissions. `install` asks once for the exact prepared plan and verifies it again afterward. Auto-approval requires both the master auto-approval setting and the dedicated managed-install setting. General all-actions, command, or file-write consent does not authorize this tool's installs. These settings do not restrict previously authorized generic shell commands; this is not a replacement for shell permission policy.

Use `status` for the workspace inventory and matching interpreter path. This version does not automatically reuse, activate, upgrade, or delete environments. Running installed code remains a separate command action. Never use a shell install to bypass a rejected managed operation.

Checkpoint restore compares workspace-associated manifests against external environment records and warns about missing, changed, inaccessible, or invalid definitions. It never rebuilds environments or modifies drivers/processes. This is advisory, not an enforcement gate on arbitrary shell commands. Keep manifests outside excluded environment/cache directories so shadow Git can capture them, subject to normal ignore rules.

An isolated virtual environment does not isolate user permissions. Installed third-party code may access files and the network when later executed. The initial UI labels use English fallback.

## Public service contract

The exports are in [the service entry point](../src/services/managed-environments/index.ts).

- [`ManagedEnvironmentPolicy`](../src/services/managed-environments/index.ts:12): absolute managed root, absolute configured Python executable, maximum download bytes, maximum observed disk bytes, and operation timeout in milliseconds.
- [`parseManifest(input)`](../src/services/managed-environments/manifest.ts:74): validates unknown input and returns a manifest. [`manifestSchema`](../src/services/managed-environments/manifest.ts:45) is also exported.
- [`prepareEnvironment({ workspaceDir, manifestPath, policy })`](../src/services/managed-environments/index.ts:133): returns a plan with the manifest snapshot, raw manifest SHA-256, policy snapshot, executable SHA-256, approval fingerprint, environment/interpreter paths, platform, architecture, and total declared download bytes. It performs bounded filesystem reads only. No subprocess, network request, or write occurs.
- [`installEnvironment(plan, { taskId, signal? })`](../src/services/managed-environments/index.ts:227): returns a ready result with approval fingerprint, runtime fingerprint, environment/interpreter paths, actual Python version, manifest SHA-256, and creation time. It requires the original in-process plan object. Cloned, serialized, or changed plans are rejected. The caller must approve that plan first.
- [`inspectEnvironments({ workspaceDir, manifestPath?, policy })`](../src/services/managed-environments/index.ts:381): returns ready environments associated with the workspace, the selected exact match or null, a manifest-mismatch flag, optional manifest error, incomplete-directory count, and invalid-record count. It performs no executable runs, network requests, or writes. A missing or malformed manifest remains visible as a mismatch while inventory remains available.

The caller must recheck the current settings policy before invoking installation if settings changed while approval was pending. The service detects mutation of its supplied policy snapshot, not changes in an external settings store.

## Manifest contract

The manifest is JSON, at most 256 KiB, with exactly these fields:

```json
{
	"version": 1,
	"pythonVersion": "3.11",
	"packages": [
		{
			"name": "example",
			"version": "1.0",
			"url": "https://files.pythonhosted.org/packages/ab/cd/example-1.0-py3-none-any.whl",
			"sha256": "0000000000000000000000000000000000000000000000000000000000000000",
			"sizeBytes": 1234
		}
	]
}
```

This is a shape example, not a downloadable package. Replace all artifact information with verified values before use. There must be 1 to 100 packages. Names are unique after Python package-name normalization. Every dependency must be supplied as an exact wheel. The filename must match the declared package name and version. Unknown fields, installer replacements, source distributions, shell commands, package indexes, arbitrary flags, URL credentials, ports, encoded paths, queries, fragments, and redirects are rejected. The supported filename/version grammar is deliberately narrower than all valid Python packaging syntax.

## Supported runtime and storage

The MVP supports Linux x64 and arm64 with CPython 3.9 or newer and a working standard-library venv/ensurepip installation. The configured executable must not itself be in a virtual environment. Unsupported interpreters, versions, platforms, and limits fail closed. No runtime or installer is downloaded automatically.

The root and configured interpreter must be absolute, canonical, separate from the workspace, and free of symlinks in all ancestors. The configured interpreter must also be outside the managed root. Root/interpreter ancestors must be owned by the current user or root and must not be group/world writable. Consequently, shared temporary-directory roots are unsupported. Use an actual interpreter executable rather than a symlink. The managed root's parent must already exist. A present root must be a private directory owned by the current user; nonempty unmarked roots are never adopted.

The manifest must be a regular, singly linked file under a canonical workspace path without symlink ancestors. The caller must additionally apply workspace ignore and protected-path rules before calling preparation and again after approval.

An exclusive per-fingerprint directory lock prevents cooperating installs from colliding. Each attempt uses a fresh private pending directory. Only successful completion publishes the final directory. An existing final directory always causes failure: there is no automatic reuse, adoption, repair, update, or deletion. Failed pending directories and stale crash locks remain for explicit user inspection and cleanup. They are never reported as ready. Inventory size is capped at 1,000 root entries.

Association records live under the managed root, outside the workspace. They store workspace path, manifest path/snapshot/hash, task ID, and both identities. A workspace checkpoint therefore cannot roll back an environment; inspection compares the restored manifest to external records instead. Inventory is metadata-based status, not a complete integrity attestation of every installed file.

## Identity and approval

The approval fingerprint hashes the parsed manifest, raw manifest bytes hash, canonical configured executable path, executable content hash, platform, architecture, workspace path, and manifest path. Raw-byte binding intentionally treats even whitespace changes after approval as a mutation.

Read-only preparation cannot run a version probe. The requested major/minor version is already included through the manifest. After approval, an isolated trusted-interpreter probe must match that requested version. A second runtime fingerprint combines the approval fingerprint with the observed full CPython version and implementation. The final directory retains the approval fingerprint so its interpreter path is known before consent. Both identities are persisted. The interpreter hash does not attest its shared libraries or the complete system Python standard library; configured Python is trusted local infrastructure.

Installation checks the original plan against fresh manifest, executable, and policy-path observations after approval, before starting work, and before publication. Mutation causes failure requiring a new preparation and approval. It never silently updates approved input.

## Installation safety and limits

Processes use isolated Python, no shell, a fixed argument list, a minimal environment allowlist, and private working/home/temp directories. Python, pip, loader, proxy, credential, and arbitrary extension-process environment variables are not inherited. The venv is created with copied executables. The installer uses only the newly created environment's bundled pip with isolated, no-index, no-dependency, binary-only, no-cache, and no-bytecode-compilation options, followed by dependency checking. Standard-library imports precede installed package paths. Python startup-site processing is disabled for pip invocation. No activation script or downloaded package entry point is run.

HTTPS downloads require certificate validation and the exact approved host and path. Actual streamed size and SHA-256 must match the manifest. Redirects and content encodings are rejected. Trusted Python standard-library ZIP inspection fully decompresses each entry without extraction or import. It rejects path traversal, absolute paths, special files, symlinks, encryption, unsupported compression, duplicate entries, startup hooks, installer replacements, unsafe/reserved generated script names, and wheel data relocation. These restrictions intentionally reject some otherwise legitimate wheels.

The operation timeout and caller cancellation terminate the spawned POSIX process group and abort downloads. Child completion is awaited before returning failure. Cancellation can race with the final atomic publication; a completed ready environment is not rolled back by deleting it.

Download bytes are enforced during streaming. ZIP declared and actual uncompressed bytes and archive entry counts are bounded. Installation checks observed directory sizes and conservatively budgets an extra extraction copy. These are not kernel-enforced disk, memory, CPU, or network quotas. A trusted interpreter, ensurepip, pip, ZIP decompression, and filesystem metadata can use transient resources between checks. The service does not promise protection from a malicious configured runtime, compromised operating system, or concurrent same-user filesystem attacker. Path checks reduce mistakes and common link attacks but are not a race-free filesystem capability sandbox.

Installed third-party code can execute later when the user explicitly runs the resulting interpreter or package. Artifact hashes bind approval to bytes; they do not establish that a package is benign. Only explicit interpreter-path use is supported. Activation scripts are removed because a staged venv moves on publication; seeded installer launchers may retain staging shebangs. Use the returned interpreter rather than shell activation or seeded pip launchers.

The separate automatic-approval setting must default off and cover only this new Roo-owned binary-wheel operation. System Python, drivers, CUDA, existing/user environments, shell package installs, deletion, and arbitrary runtime execution remain outside this service and its automatic consent.

## Validation

Focused tests cover strict manifest parsing, URL restrictions, size/hash enforcement, path containment and symlinks, insecure roots, approval mutation, cancellation, failed staging, no reuse/adoption, ready publication, and read-only checkpoint mismatch. Network and installation processes are mocked. Separate ZIP tests execute only trusted system Python standard-library code against synthetic temporary archives. They do not download, install, or execute package code. A real package installation is not part of automated validation.
