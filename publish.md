# Publish Plan for `pi-executor`

This document maps the npm publishing guide step by step to the current state of this repository.

Goal: turn this package into something we can publish confidently, with a clear record of:

- what is already done
- what still needs to change
- what order to do it in

## Current Snapshot

What is already in place:

- TypeScript source exists in `src/`
- Tests exist in `test/`
- A build script exists: `npm run build`
- A typecheck script exists: `npm run typecheck`
- The package already has a README
- The repo is already initialized as a git repository on `main`

What is missing or incomplete for a publish-ready package:

- no initial git commit yet
- no git remote configured yet
- no `.gitignore`
- no `LICENSE`
- no `description`, `homepage`, `bugs`, `author`, `repository`, or `main` field in `package.json`
- no `exports` or `types` field in `package.json`
- no Prettier setup
- no GitHub Actions workflow
- no Changesets setup
- no release checklist or dry-run publish check

## Step-by-Step Plan

| Step | Status | What is already done | What still needs to change |
| --- | --- | --- | --- |
| 1. Git | Partial | The repo exists and `main` is checked out. | Create an initial commit, add a remote GitHub repository, push the branch, and add `.gitignore` so `node_modules` and build output stay out of git. |
| 2. `package.json` | Partial | `name`, `version`, `type`, `files`, `peerDependencies`, and basic scripts already exist. | Add the publish metadata fields: `description`, `homepage`, `bugs`, `author`, `repository`, `license`, `main`, and ideally `types` and `exports`. Decide whether `files` should stay broad or be narrowed before publish. |
| 2.1. LICENSE | Missing | None. | Add a `LICENSE` file and set the `license` field in `package.json`. |
| 2.4. README | Mostly done | `README.md` already exists and explains the package purpose. | Expand it with install, usage, entry points, and publish notes so npm visitors can understand the package quickly. |
| 3. TypeScript | Mostly done | TypeScript is already configured with strict checks, `declaration`, and build output to `dist/`. Source and test files already exist. | Verify the public API entrypoint is what we want to publish. Add or adjust `main`, `types`, and `exports` so consumers get the built output, not internal source files. |
| 3.3. DOM lib choice | Done | `tsconfig.json` already includes `DOM`, which matches the package’s current runtime assumptions. | No change unless we later want to remove DOM globals from the type surface. |
| 3.4-3.9 Build and CI scripts | Partial | `build` and `typecheck` already exist. | Add a `ci` script if we want a single release gate, and make sure it includes build plus tests. |
| 4. Prettier | Missing | None. | Install Prettier, add `.prettierrc`, add `format` and `check-format` scripts, and decide whether formatting should be enforced in CI. |
| 5. Testing with Vitest | Not adopted | The package already has tests, but they use Node’s built-in test runner instead of Vitest. | Decide whether to keep the current test setup or migrate to Vitest for consistency with the guide. If we keep Node tests, update the plan to reflect that this step is optional rather than required. |
| 6. GitHub Actions CI | Missing | None. | Add `.github/workflows/ci.yml` to run install, build, format check, and tests on push and pull request. |
| 7. Changesets | Missing | None. | Install `@changesets/cli`, initialize Changesets, set `access` to `public`, set `commit` to `true`, add `local-release`, and add `prepublishOnly` so publishing always runs CI first. |
| 7.8-7.10 Release verification | Missing | None. | Add a changeset, create the first release commit, run a dry-run publish check, and confirm the package contents look correct before publishing to npm. |

## Recommended Execution Order

1. Add `.gitignore`
2. Add `LICENSE`
3. Fill in the missing `package.json` metadata
4. Decide whether to keep Node test runner or move to Vitest
5. Add Prettier if we want formatted output enforced
6. Add a `ci` script that covers build, lint/format, and tests
7. Add GitHub Actions CI
8. Initialize Changesets and configure publishing
9. Create the initial commit
10. Push to GitHub
11. Run a dry-run package publish check
12. Publish the first version

## Notes On This Repo

- This repository is not starting from an empty directory, so the tutorial’s exact setup is not a perfect fit.
- The package already has real runtime code and tests, so the main work is packaging discipline rather than writing the first implementation.
- Because the current test suite is already working, the biggest publishability gaps are metadata, license, git hygiene, CI, and release tooling.
- The current `files` list includes `.pi`, `src`, `dist`, and `README.md`; that may be intentional for this package. Before publishing, confirm that every listed file should really ship to npm.

## Definition Of Done

This package is publish-ready when all of the following are true:

- `npm run build` passes
- `npm run test` passes
- formatting is consistent and checked
- `LICENSE` exists and matches the chosen license
- `package.json` has complete npm metadata
- `.gitignore` excludes build output and dependencies
- CI runs on push and pull request
- Changesets is configured for public publishing
- `npm pack --dry-run` shows only the files we want to ship
- the first release has been committed and pushed
