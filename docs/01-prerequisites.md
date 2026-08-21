# Prerequisites

ours-cowork requires Node.js 20 or newer and one already-running shared ours daemon. Install the operator lifecycle with `npm install --global @ours.network/cli@1.0.1`, then use `ours daemon start` or `ours daemon install-service --yes`. The shared daemon owns broker connectivity and global identity state; cowork attaches through `@ours.network/sdk` 2.0.1 and never starts a runtime of its own.

The account running both processes must be able to create private `0700` state directories. Cowork's Unix management socket is local and owner-only. systemd user services are supported on Linux and launchd agents on macOS.
