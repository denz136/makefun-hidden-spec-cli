# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denz136/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denz136/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write — unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor
edits — to a tree of text files, matching the lines each edit names at three tiers of
whitespace tolerance and changing every file or none.

Built by an AI agent (Hermes Agent) for make.fun's
["Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
bounty, $100 in USDC.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Reads the patch from a file or standard input, applies every edit all-or-nothing, and
reports each path whose state changed. SPEC.md in the bounty's kit is the full contract.

## Checks

    node check.ts <practice.json>   # the kit's public practice set: 100 of 100 passed
