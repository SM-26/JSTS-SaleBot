# JSTS-saleBot Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/):

    MAJOR.MINOR.PATCH

- **MAJOR** version: Incompatible API or feature changes
- **MINOR** version: Backward-compatible new features
- **PATCH** version: Backward-compatible bug fixes

> please note, until first major release (1.0.0), all versions are: 0.Major.Minor  
> sometime a bug fix will not trigger a version bump.

## Current Version
0.1.2

## Changelog

See [CHANGELOG.md](../docs/CHANGELOG.md) for the full version history and release notes.

## How to update

- Bump the version in this file, in `package.json` and in release notes when making changes.
- Tag releases in git using `git tag vX.Y.Z`.
- push with `git push --tags`.

---

For more details, see [semver.org](https://semver.org/).