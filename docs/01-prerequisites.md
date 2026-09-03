# Prerequisites

ours-cowork requires Node.js 22 or newer and one already-running shared ours daemon. Install the operator lifecycle with `npm install --global @ours.network/cli@2.7.0`, then use `ours daemon start` or `ours daemon install-service --yes`. The shared daemon owns broker connectivity and global identity state; cowork attaches through `@ours.network/sdk` 3.7.0 and never starts a runtime of its own.

The selected SDK and CLI must include the external-history storage epoch: structured `listIncomingMessages`/`getHistoryItem`/`getMessages` and `listIncomingFiles`/`fetchFile`/selected `getFiles` APIs backed by per-identity history and immutable blobs. A package with the same nominal version but the older packet-inbox contract is not compatible.

The account running both processes must be able to create private `0700` state directories. Cowork's Unix management socket is local and owner-only. systemd user services are supported on Linux and launchd agents on macOS.
