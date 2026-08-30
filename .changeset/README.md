# Changesets

This repository uses [Changesets](https://github.com/changesets/changesets) to
manage versioning and changelogs for the `@realtimesdk/*` packages.

## Adding a changeset

When you make a change that affects the published packages, run:

```bash
bun run changeset
```

Select the affected packages and the bump type (`patch`, `minor`, or `major`),
then write a short summary. Commit the generated `.changeset/*.md` file with
your change.

## How releases work

- Pushing changesets to `main` triggers the **Release** workflow, which opens a
  **Version Packages** pull request.
- Merging that PR bumps all `@realtimesdk/*` packages together (they are
  released in lockstep), updates each package `CHANGELOG.md`, and publishes the
  packages to npm.

## Tooling

- `bun run changeset` — create a changeset
- `bun run changeset:version` — apply pending changesets (bump versions, write changelogs)
- `bun run changeset:publish` — build and publish all packages
