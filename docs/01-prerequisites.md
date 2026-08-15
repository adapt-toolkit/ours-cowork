# Prerequisites

ours-cowork requires Node.js 20 or newer and access to an ours/ADAPT broker over WebSocket. The daemon is a standalone process with its own package, configuration, state directory, embedded standard-SDK host, and operator socket.

The account running it must be able to create a private `0700` state directory. The Unix management socket is local and owner-only. systemd user services are supported on Linux and launchd agents on macOS.
