# Cowork 2.0.0 (major release candidate)

This release promotes the validated `prerelease` line to `main` as a major
release. Versions are produced by the `main` version-bump job, not written by
hand.

| package | current `latest` | expected release |
|---|---|---|
| `@ours.network/cowork` | 1.3.3 | 2.0.0 |

## Breaking changes

- Requires the SDK 4 line: default client attach goes through a saved shared
  gateway client profile, legacy environment daemon selection is rejected, and
  the daemon runtime ships separately as `@ours.network/daemon`. See ours-sdk
  `RELEASE-NOTES-4.0.0.md`.
- Cowork runs against an external `@ours.network/daemon` deployment (#45)
  rather than a daemon embedded in the SDK.
- Main-only 1.3.2/1.3.3 changes (#50 REST file uploads and resumable room
  archive events, #62 stale daemon process ownership) are carried into this line.

## Stable dependency pins (blocked on upstream publication)

`prerelease` pins nightly `@ours.network/*` versions exactly. Before this
release merges, the release branch must be repinned to the published stable
versions below, `package-lock.json` regenerated, and CI rerun on the new head:

| dependency | prerelease pin | stable target |
|---|---|---|
| `@ours.network/sdk` (dependencies) | 3.8.1-nightly.18 | 4.0.0 |
| `@ours.network/cli` (devDependencies) | 2.8.1-nightly.16 | 3.0.0 |
| `@ours.network/daemon` (devDependencies) | 3.8.1-nightly.10 | 4.0.0 |

None of these stable versions is published at the time of writing; they are the
versions the upstream `main` bump jobs are expected to produce.

## Features

- add authenticated HTTP room management and browser sessions (#49)
- support external daemon deployment for Cowork (#45)

## Fixes

- restore room delivery after abrupt supervisor and worker loss (#63)
- shorten private Unix socket names for deep workspaces
- preserve room inbox while provisioning (#51)
- pin published HTTPS SDK nightly (#46)

## Merging

The `main` bump reads only the head commit message. Merge with a merge commit
whose subject is `feat!: promote prerelease to main` and whose body contains a
`BREAKING CHANGE:` line; the default "Merge pull request" subject yields a patch.
