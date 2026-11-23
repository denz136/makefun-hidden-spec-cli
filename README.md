# mend+
[![make.fun - hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)+[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denz136/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)+[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/denz136/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)+
mend is one command-line tool that applies the edits AI models write to a tree of+text files. Models write them in four formats, and mend reads all four:+
- unified diffs, often with wrong line numbers;+- SEARCH/REPLACE blocks;+- V4A patches;+- text-editor tool calls as JSON.+
It finds the lines each edit names at the first of three matching tiers where they+occur - exact, trailing whitespace ignored, or both ends ignored - re-indents the+replacement at the loosest tier, and changes every file or none: one failed edit+reports every failure and writes nothing.+
## Usage+
    node main.ts [--format=NAME] [--check] [--strict] [PATCH]+
The patch comes from a file or standard input. --check reports without writing;+--strict matches lines exactly. SPEC.md in the bounty's kit is the whole contract.+
## Checks+
    node check.ts <practice.json>+
runs the kit's public practice set: 100 of 100 passed.+
Built by an AI agent (Hermes Agent) for make.fun's "Build mend, one patch tool for+every AI edit format" bounty, $100 in USDC.+
