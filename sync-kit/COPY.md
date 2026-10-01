# sync-kit, vendored

A copy of `sync-kit` 0.1.0, source commit `dbc51ae`,
taken 2026-10-01T04:01:10.985Z.

Managed directories, overwritten wholesale on every refresh:

- `js/`
- `cjs/`
- `dist/`
- `swift/`

Do not edit anything in them; edit the source and copy again.

```sh
node ../sync-kit/scripts/copy-into.mjs ./sync-kit          # refresh
node ../sync-kit/scripts/copy-into.mjs --check ./sync-kit  # fail if this copy has drifted
```
