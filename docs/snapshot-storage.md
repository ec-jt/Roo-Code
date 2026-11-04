# Deduplicated request snapshot storage

New request snapshots use task-local content-addressed blocks. Existing task data is not migrated, rewritten, inventoried, pruned, or deleted. This change does not reclaim space already occupied by legacy snapshots.

## Compatibility and ownership

The public [snapshot API](../src/core/task/model-operation/storage.ts:205) still accepts and returns the complete version-1 snapshot object. Effective API messages, frozen UI messages, unknown nested message fields, prompt, provider/model identity, timestamp, and request identity retain their original values. The dispatch persistence barrier and caller behavior are unchanged.

The reader accepts legacy version-1 envelopes and new version-2 envelopes. An identical retry of an existing request validates the complete snapshot and synchronizes the existing manifest without replacing its inode or creating blocks. A differing retry or corrupt existing snapshot fails without replacement. It does not repair missing blocks or upgrade legacy records.

Each task owns its own block directory. New branches reconstruct the selected snapshot and save independent blocks under the branch task before publishing provenance. They do not link source-task block inodes or depend on source-task storage. Legacy branch provenance retains its existing single source lookup.

Older builds that understand only version-1 envelopes **cannot replay version-2 snapshots**. Rolling back the application does not convert these snapshots. Main chat history files are unchanged by this storage change, but replay of requests recorded in the new format requires a build with the new reader. There is no automatic downgrade or migration.

## On-disk format

The existing request filename remains the immutable manifest location under the task's model-operation directory. The [envelope reader](../src/core/task/model-operation/storage.ts:153) checks envelope version, record type, task/request identity, and the SHA-256 checksum of the canonical envelope excluding its checksum field.

A version-2 payload has a blocks-v1 encoding discriminator, snapshot metadata, two sequence descriptors, and a prompt reference. Each descriptor contains one root hash and one message count. Empty UI history has a null root and zero count. Manifest size does not grow with the number of message references, apart from count digits.

The [block implementation](../src/core/task/model-operation/snapshot-blocks.ts) stores blocks below the same model-operation directory in a blocks subdirectory, sharded by the first two hash characters. Each filename is a 64-character lowercase hexadecimal SHA-256 hash with a JSON extension. References are validated before path construction.

A block's hash covers its entire canonical JSON representation, including version and kind. Separate kinds identify API messages, UI messages, prompts, and sequence nodes. Each message or prompt is stored as one value block. Sequence nodes hold at most 32 references. Level zero references messages; higher levels reference sequence nodes. The canonical tree groups references from the beginning in chunks of 32 and repeats that grouping until one root remains.

Completed prefix nodes keep their identities as a sequence grows. Appending one message writes its value block and at most one new node per tree level. The partial tail is copied as bounded reference metadata, not as message content. Editing an existing message creates its new value and ancestor nodes. Compaction or insertion can change more sequence nodes, but unchanged message blocks remain reusable. No per-request full hash array is persisted.

## Durability and validation

All JSON writes use the existing atomic JSON writer through the [immutable publication helper](../src/core/task/model-operation/immutable-json.ts:137). A private staging file is synchronized, published with a same-directory hard link that cannot overwrite a winner, and synchronized through its ancestor directories to the trusted storage root. Identical concurrent blocks are verified before reuse. All referenced blocks complete this durability protocol before the manifest can become visible.

Publication failures are surfaced to the caller. Block failures cannot publish a manifest. Failed or competing saves can leave unreferenced blocks, and a crash can leave staging files. There is no garbage collector or cleanup pass. A failure after manifest publication may leave a complete manifest; a retry validates and synchronizes it. Hard-link support is required; there is no overwrite fallback.

Reads reject missing or corrupt blocks, wrong kinds, invalid identities, unsafe references, inconsistent counts, and incorrect tree levels. Reconstruction uses an iterative bounded-depth traversal. Expected levels decrease on every tree edge, preventing cycles from causing unbounded traversal even apart from hash validation. Hashes detect corruption, not an attacker who can replace all records and recompute checksums.

The reader rejects symlinks beneath the trusted root and non-regular files before opening them. It checks file size before allocation and uses bounded read operations with inode, size, modification-time, and checksum checks. Metadata-only timestamp changes from staging hard-link removal are allowed. The storage root and its permissions remain the caller's responsibility. This is not a sandbox against hostile concurrent replacement of directories. No encryption or new permission policy is introduced.

POSIX directory synchronization is retained. Windows regular files use writable handles for synchronization, but Windows has no directory-fsync power-loss guarantee. Real power-loss behavior on Windows, macOS, network filesystems, and unusual filesystems is not established by the Linux unit tests.

## Safety limits and growth

The [per-operation limits](../src/core/task/model-operation/snapshot-blocks.ts:8) fail closed rather than truncating:

- 64 MiB for one message, prompt, or sequence block, including JSON structure.
- 512 MiB of referenced block bytes per snapshot reconstruction or save, counting repeated references.
- 1,000,000 messages per sequence.
- 64 KiB per version-2 manifest.
- 512 MiB per legacy envelope before allocation. This is a new read safety guard, not a migration or deletion. Larger legacy records remain untouched but cannot be replayed by this reader.
- The existing canonical JSON nesting limit remains 100.

The shared envelope reader permits up to the legacy envelope limit before it can identify the format, then applies the smaller version-2 manifest limit. Parsed objects and canonicalization consume additional memory beyond serialized byte limits. This API still materializes a full snapshot for its caller; it is not a streaming replay API.

For an append-only history recorded after every message, unique payload growth is linear in newly observed content. Persistent tree metadata adds bounded nodes per tree level per snapshot, rather than a full prefix reference array. Total growth is therefore unique content plus request manifests and approximately logarithmic tree-path metadata per append. Identical messages within a task share blocks; distinct API/UI message kinds intentionally do not share one block.

Saving still canonicalizes the supplied snapshot and verifies existing blocks throughout its history. CPU work, filesystem reads, and synchronization are not incremental and can grow with history length. This change targets duplicate disk storage first. Many tiny blocks also consume filesystem allocation units and inodes.

There is **no total task quota or retention policy**. Unique payloads, edited histories, prompts, manifests, and orphan blocks can keep growing. No claim of bounded total disk use or recovery of existing disk space is made.

## Verification

The [storage tests](../src/core/task/model-operation/__tests__/storage.spec.ts) cover legacy byte/inode preservation, exact new-format replay, unknown fields, tool calls and images, edits and compaction, concurrent publication, missing/corrupt/oversized blocks, invalid references and tree structures, publication failure, and branch independence after source deletion.

The growth regression records 96 snapshots with one new 1,000-character API message and UI message per request. It checks total logical file bytes below one eighth of equivalent full copies, allocated bytes below one half, bounded block/inode counts, near-constant manifest size, and exact replay. It uses temporary fixtures only, not installed task data.
