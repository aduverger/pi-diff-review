# pi-diff-review

Native diff review for [pi](https://pi.dev), powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

## Install

```sh
pi install git:https://github.com/aduverger/pi-diff-review
```

## Usage

Run `/diff-review` from a Git workspace. If the workspace contains one clone, it opens directly; if it contains multiple clones, select the repository to review.

The review window provides two modes:

- **Uncommitted** reviews `HEAD` against the checkout, including staged, unstaged, untracked, deleted, renamed, conflicted, and type-changed files.
- **Compare** compares editable local base/head refs from their merge base. It only uses refs already present in the selected clone and never fetches.

Use the sidebar to switch files and search by path. Add comments to original or modified lines, to a whole file, or as an overall note. Submitting closes the window and inserts a structured feedback prompt into the pi editor; cancelling or closing the window discards the draft.

## Requirements

- Node.js 22.19.0 or newer
- `pi` and Git
- A desktop supported by Glimpse with its [platform prerequisites](https://github.com/hazat/glimpse#install)
- Internet access while reviewing, for the Tailwind and Monaco CDN assets

## Development

```sh
npm ci
npm run check
```
