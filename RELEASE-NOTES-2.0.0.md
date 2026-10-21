# cowork 2.0.0 (major release)

This release makes the latest `prerelease` line the stable `@ours.network/cowork`.
The version is produced by the `main` version-bump job from the merge commit's
Conventional Commits subject; it is not written by hand.

| package | current `latest` | expected release |
|---|---|---|
| `@ours.network/cowork` | 1.3.3 | 2.0.0 |

## Source

The tree is the `prerelease` tree. As directed by the owner, changes that
existed only on `main` are not carried forward: REST file uploads and resumable
room archive events (#50), the daemon stale-owner/serialized-recovery change and
its `fs-ext` dependency (#62), and main-only documentation. `main`'s history is
recorded by a merge commit; its content is not.

## Dependencies

- `@ours.network/sdk` 5.0.0 (exact pin; previously a 4.1.1 nightly)
- development: `@ours.network/cli` 4.0.0 and `@ours.network/daemon` 5.0.0

## Breaking changes

- Cowork runs against an externally deployed shared ours daemon reached through
  the thin SDK 5 client and a gateway client profile; install the daemon
  separately (`@ours.network/daemon`).
- The REST file upload and resumable room archive event endpoints added on
  `main` in 1.3.2 are not present.

## Features and fixes promoted from prerelease

- Authenticated HTTP room management and browser sessions.
- Complete resource SSE updates; less idle live delivery health traffic.
- Opt-in diagnostics operation trace for room intake, mutex and SDK calls.
- Room delivery restored after abrupt supervisor and worker loss; start/stop
  wait for the previous supervisor; rooms stay hosted when startup fanout fails
  in transport; fanout retries tracked until quarantine settles.
- Room inbox preserved while provisioning; shorter private Unix socket names
  for deep workspaces.
