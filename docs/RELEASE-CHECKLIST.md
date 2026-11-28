# Release Checklist

Releases are **fully automated**. Every green push to `main` triggers the CD pipeline in `.github/workflows/cd.yml`. This checklist documents the steps that happen automatically and what a maintainer must do manually only in edge cases.

## Normal flow (automated)

| Step | Who | How |
|------|-----|-----|
| Open PR with conventional commit title | Contributor | PR title drives the version bump |
| All CI checks pass (unit × 3 nodes via `ci.yml`, Docker e2e via `e2e.yml`, eval via `ci.yml`) | GitHub Actions | Runs on every PR |
| Merge PR to `main` | Maintainer | Squash or merge |
| CD pipeline triggers | GitHub Actions | `.github/workflows/cd.yml` |
| Next semver computed | `scripts/next-version.mjs` | Conventional commits since last tag |
| `vX.Y.Z` tag pushed | GitHub Actions bot | Tags tested SHA; `package.json` updated in runner workspace only (no commit to `main`) |
| GitHub Release created with auto-generated notes | `gh release create` | Attached: `install-ubuntu.sh`, `SKILL.md` |
| `npm publish --tag next` | GitHub Actions | Only when `NPM_TOKEN` secret is set |
| **Manual review** in GitHub Environment `production` | **Edson** | Required approval gate |
| `npm dist-tag add openclaw-sub@X.Y.Z latest` | GitHub Actions | Runs after approval |

## Semver bump rules

| Conventional commit | Bump | Notes |
|---------------------|------|-------|
| `feat:` / `feat(scope):` | **minor** | 0.x line stays minor |
| `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`, etc. | **patch** | |
| `feat!:`, `fix!:`, or `BREAKING CHANGE:` footer | **major** | Capped as **minor** until the repo has a `v1.x` tag |
| No qualifying commits | **patch** | Floor: at least one bump per merge |

## Secrets & environments required

| Secret / Setting | Where to set | Purpose |
|-----------------|--------------|---------|
| `NPM_TOKEN` | Repo → Settings → Secrets → Actions | Publishes to npm |
| `production` environment | Repo → Settings → Environments | Gates `latest` promotion; add **Edson** as required reviewer |

## Edge cases

### Superseded releases (older merge not released)

When two merges land close together, the release job is serialized via a `concurrency` group so only one runs at a time. The guard step skips any run where `origin/main` has already advanced past the merge's SHA **and** no release tag has been pushed for that SHA yet.

This means: if the second merge's gates fail (e.g. flaky tests) or its commit message contains `[skip ci]`, the first (now-older) merge's release run is skipped and that commit never ships independently. The first commit's changes will be bundled into the next successful release instead.

To release the older commit explicitly in this situation, tag it manually and push:

```bash
git checkout <older-sha>
npm version X.Y.Z --no-git-tag-version
git tag vX.Y.Z <older-sha> && git push origin vX.Y.Z
gh release create vX.Y.Z --generate-notes
npm publish --tag next --access public  # requires NPM_TOKEN set locally
git checkout main
```

### Skip the release on a hot-fix merge
Add `[skip ci]` to the commit message. The CD pipeline will not run.

### Force a specific version
Versions are computed automatically from conventional commits since the last tag. To force the next automated release to a specific version, push a tag at the commit you want to become the new base **before** merging:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

**Important:** this tag becomes the *base* for the next CD run. The CD pipeline will compute the next version *above* `v1.0.0` based on the commits in the merge (e.g. a `fix:` merge produces `v1.0.1`). To publish a package at exactly `v1.0.0` and skip the automated bump, tag and publish manually instead:

```bash
git tag v1.0.0 && git push origin v1.0.0
npm version 1.0.0 --no-git-tag-version
npm publish --access public
```

The CD pipeline will **not** publish exactly `v1.0.0`: it tags the tested merge commit (not any pre-pushed tag), so it will compute the next version above `v1.0.0` for that merge. The manual `npm publish` above also publishes straight to `latest`, bypassing the `production` approval gate — add the dist-tag explicitly after review if you want to keep the gated flow. Use `[skip ci]` in the merge commit message to suppress the CD run entirely for that merge.

### Roll back a bad publish
```bash
npm dist-tag add openclaw-sub@<previous-good-version> latest
npm deprecate openclaw-sub@<bad-version> "Reverted — see release notes"
```

### Re-run the promote step
Go to Actions → CD — Continuous Delivery → find the run → re-run failed jobs. Edson's approval will be re-requested.
