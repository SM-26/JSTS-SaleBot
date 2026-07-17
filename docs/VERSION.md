# JSTS-saleBot Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/):

    MAJOR.MINOR.PATCH

- **MAJOR** version: Incompatible API or feature changes
- **MINOR** version: Backward-compatible new features
- **PATCH** version: Backward-compatible bug fixes

> Versions before `1.0.0` used a pre-release `0.Major.Minor` scheme. From `1.0.0`
> onward this project uses standard `MAJOR.MINOR.PATCH` as described above.  
> sometime a bug fix will not trigger a version bump.

## Current Version
1.0.0

## Changelog

See [CHANGELOG.md](../docs/CHANGELOG.md) for the full version history and release notes.

## How to update

- Bump the version in this file, in `package.json` and in release notes when making changes.
- Tag releases in git using `git tag vX.Y.Z`.
- push with `git push --tags`.

---

For more details, see [semver.org](https://semver.org/).