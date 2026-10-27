# Bounded directory listing

The filesystem directory-listing action and the legacy list-files tool request approval before scanning. Both use the same bounded scanner. Denied approval starts no scan. Task cancellation, abandonment, and dispatch closure stop waiting and discard late results.

## Behavior

- Shallow listing reads direct directory entries only. It does not open entry contents, read Git ignore files, or follow discovered symbolic links. Hidden entries are visible, subject to the existing large-directory exclusions.
- Recursive listing uses breadth-first traversal. It does not follow discovered symbolic links. Explicit hidden-directory targets remain supported.
- Recursive requests for canonical paths under the standard Unix virtual-filesystem roots are reduced to shallow listing, with an explicit explanation. Other filesystem mounts remain subject to the same work and time budgets.
- Root and home directory guards remain in place, including canonical aliases.
- Cached Roo ignore rules prevent traversal of denied directories. Ignored names can still be displayed as locked entries when the setting permits this. Write-protection annotations remain in the formatted output.
- Recursive scans read regular Git ignore files only, with a 64 KiB limit per file and a 1 MiB aggregate limit. Ancestor and nested rules use their own directory as the base. Shallow scans intentionally do not apply disk-based Git ignore rules. Global Git configuration and ripgrep-specific ignore files are not loaded.

## Limits and failure reporting

A scan has one 10-second deadline, including canonical-path resolution, ignore discovery, and directory operations. It also has a 100,000-entry work budget, a maximum recursive depth of 32, and a maximum result count of 50,000. Interactive tools request 200 results. A directory is read in batches of 32, with one filesystem request in flight per worker.

Filesystem operations run in an isolated Node subprocess using the host runtime. No additional executable, dependency, or worker asset is required. The subprocess uses Node mode when the host runtime is Electron. The parent closes its pipes and sends termination on completion, timeout, or cancellation. It escalates to forced termination after 250 milliseconds if the process has not exited.

An incomplete scan returns partial results with a reason. A timeout without results, unreadable target, or policy-denied target reports an error rather than claiming that the directory is empty. Existing tuple callers receive the truncation flag; interactive tools also show the reason.

## Operating-system limits

A process blocked in an uninterruptible kernel operation may not exit promptly, even after forced termination. The extension stops waiting, but does not claim that the kernel call has ended. At most four listing subprocesses may remain live. A blocked process retains its slot until exit, preventing repeated requests from accumulating unlimited blocked scans.

Canonical checks reject paths that change before a directory is opened. These checks are not an atomic filesystem snapshot. Concurrent mount changes or path replacement between a check and an operating-system call remain possible. The deadline, work budgets, and process cap still apply.

Linux fixture tests exercise the subprocess protocol. Packaging includes the scanner as inline source in the extension bundle; no separate worker asset is emitted. Desktop Electron, Windows, macOS, and remote filesystem behavior require platform-specific verification before claiming those environments were tested.
