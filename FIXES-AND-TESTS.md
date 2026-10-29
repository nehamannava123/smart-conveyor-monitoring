# Fixes and tests

## Final adjustments
- Added `data/datasets/conveyor_synthetic_25000_seed42.csv` with 25,000 labeled synthetic scenarios and metadata.
- Added deterministic dataset generation via `npm run dataset:generate -- 25000 42`.
- Regenerated `data/models/model-artifact.json` from 25,000 synthetic scenarios with a deterministic 80/20 held-out split.
- Raised the autoencoder's nominal reconstruction threshold to the 99th percentile to reduce nuisance alerts.
- Fixed the tail-pulley digital-twin mapping to `zone-e`.
- Cleaned test-generated data from both the primary and backup demo databases.
- Added dataset integrity and partition tests.
- Refined responsive styles and keyboard focus visibility.
- Corrected documentation that previously described an IID synthetic split as chronological.

## Verification
- JavaScript syntax checks: PASS.
- Dataset generation and structural validation: PASS.
- Model training on 25,000 samples: PASS.
- Focused tests: 17 passed, 0 failed.
- Full test suite: BLOCKED because npm registry access timed out and runtime dependencies were not available. Do not treat the full suite as passed until `npm ci && npm test` succeeds locally.
