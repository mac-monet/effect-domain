# Changelog

## 0.2.0

Fundamental representation change: **projections are plain data**.

### Breaking

- **Per-field `Result` wrapping is gone.** `execute`/`subscribe`/`dispatch`
  successes and the wire success payload are the plain selected tree
  (`{ id: "1", fullName: "Ada" }`), JSON-native. `responseSchema` /
  `dispatchResultSchema` describe the plain shapes. The operation-level
  dispatch envelope (`Result` with `GatewayError | OperationError`) is
  unchanged.
- **Strict failure semantics.** A computed/batched field's typed failure now
  fails the whole operation: in-process it surfaces in the Effect error
  channel as the raw field error; over the wire as `OperationError` with that
  cause. Field defects still die. There is no partially-failed data tree.
- **Nullish is `null`.** Nullable roots and nullish sub-selected values are
  plain `null` (previously `Option.none()` / `{"_tag":"None"}` on the wire).
- **Selection `args` on a field that accepts none** is now a defect
  in-process (the wire boundary already rejects it as `SelectionParseError`).
- **Type family replaced.** `Domain.ResultOf` / `RootResultOf` /
  `NarrowBySelection` / `ResultTree` are removed; use `Domain.SelectedOf` /
  `Domain.RootSelectedOf` (plain narrowed trees). `annotatePaths` and its
  `Path`/`PathEntry` types are removed — there is no per-field error array to
  annotate.
- **`execute`'s error and requirement channels are now complete.** `E`
  includes every reachable computed field's declared failures (`OperationE`),
  and `R` includes field requirements (`OperationR`) — previously field `R`
  was silently dropped, so a domain could typecheck as fully provided yet die
  at runtime.

### Added

- `field({ error })` — declared error schema for fallible fields, the mirror
  of `operation({ error })`. Wire handlers union every reachable field error
  schema into the operation's failure codec; `Domain.MissingErrorSchemas`
  (and therefore `wireClient`/`handleDispatch`) rejects fallible fields
  without one at compile time.
- `NodeMeta` phantom on `node()` types carrying field defs to the type level
  (`NodeE`/`NodeR`), plus `reachableFieldErrorSchemas` on the registry.

### Migration notes

- Delete client-side unwrapping of `{_tag:"Success"}` field wrappers — the
  data is already plain.
- Consumers fingerprinting results by `JSON.stringify` (e.g. the
  live-queries example's change detection) will emit one spurious change
  event per query on upgrade, since the serialized shape changed. Durable
  stores of encoded responses (sync-engine events) do not decode across this
  boundary.
