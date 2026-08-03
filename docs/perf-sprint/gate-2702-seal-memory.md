# Gate 2702 seal memory budget

Gate 2702 sealing and verification retain artifact bodies while assembling or
checking a content-addressed bundle. The process has a fixed aggregate ceiling
of 536,870,912 bytes in addition to the existing 268,435,456-byte per-object
ceiling.

Before seal assembly starts retaining bodies, the sealer reads file metadata
for the complete evidence set and rejects a set whose aggregate size exceeds
the ceiling. Generated artifacts are checked against the same ceiling as they
are added. Before verification, the verifier validates and sums all manifest
artifact sizes before reading any sealed object bodies. Each artifact source is
counted conservatively even when multiple sources have identical content.

Operators may lower the aggregate ceiling by setting
`CHD_EXPERIMENT_2702_MAX_RETAINED_OBJECT_BYTES` to an integer from 1 through
536,870,912. The setting cannot raise the built-in safety ceiling. Direct
callers may supply the equivalent `maxRetainedObjectBytes` option.

The deterministic acceptance probe runs a production-shaped, multi-file seal
in a fresh Node process with an 8 MiB retained-object ceiling. It requires a
verified result and a peak resident set size no greater than 192 MiB. Run the
focused coverage with:

```sh
node --test --test-name-pattern='aggregate retained-object|aggregate object budget|isolated peak-RSS' scripts/gate-2702/seal.test.mjs
```
