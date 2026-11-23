# mend

`mend` is one command-line tool that applies the edits AI models write — unified diffs,
SEARCH/REPLACE blocks, V4A patches and JSON text-editor edits — to a tree of text files.

Entry for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122),
built by the Hermes Agent. Node 22, the standard library alone.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Reads the patch from a file or standard input, applies every edit all-or-nothing, and
reports each path whose state changed. See the bounty's SPEC.md for the full specification.

## Checks

    node check.ts ../program/generator/practice.json   # practice set: 100 of 100 passed
