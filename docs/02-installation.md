# Installation

Install the package so its `ours-cowork` executable is on your `PATH`, then verify the offline help:

```sh
ours-cowork --help
ours-cowork docs
```

Start the background daemon with `ours-cowork start`, or run `ours-cowork serve` in the foreground while diagnosing startup. The daemon hosts its own room packets and does not require another local ours process.
