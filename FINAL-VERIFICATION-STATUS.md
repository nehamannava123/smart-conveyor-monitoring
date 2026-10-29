# HillGuard final verification status

## Finalized in this archive
- Expanded, deterministic synthetic dataset: 25,000 rows, seed 42, raw sensor channels, derived ML features, fault/anomaly/hazard labels, and reproducible candidate partition column.
- Regenerated model artifact using 25,000 synthetic scenarios (20,000 train candidates / 5,000 held-out candidates).
- Autoencoder nominal reconstruction threshold raised from the 95th to the 99th percentile to reduce nuisance anomaly alerts; thresholds and metrics are stored in the model artifact.
- Corrected the tail-pulley mapping to an existing route zone (`zone-e`).
- Updated README benchmark table to match the bundled model artifact and removed the incorrect claim of a chronological split.
- Cleaned persisted demo database and backup of test-generated alerts, test work orders, throwaway scenarios, and test audit events.
- Added dataset generator, metadata, documentation, dataset schema/partition tests, and responsive/accessibility styling refinements.

## Checks completed in this environment
- JavaScript syntax check across server, frontend, and test JavaScript files: PASS.
- Dataset generator: PASS (25,000 rows generated deterministically with seed 42).
- Model training: PASS (25,000 samples; artifact generated successfully).
- Focused automated tests: **17 passed, 0 failed** across dataset integrity, frontend integrity, risk explainability, evaluation diagnostics, and ML inference.
- ZIP archive integrity: verified after packaging.

## Tests not fully verified
- The complete test suite and full HTTP/browser integration suite could not be run because npm dependencies could not be downloaded in this environment (registry install timed out). Tests that import unavailable runtime dependencies such as `uuid` and `dotenv` cannot initialize until `npm ci` succeeds.
- Interactive browser testing across all roles, devices, and pages has not been completed.
- No physical sensor, PLC, or production-host deployment was available for end-to-end validation.

## Data and safety limitations
- The bundled dataset and model evaluation are synthetic. Synthetic timestamps are for reproducibility; rows are independently generated scenarios, not a physically continuous plant recording.
- Labels are generated from simulation rules, so model metrics measure agreement with those rules and do not establish field performance.
- Sensor calibration is not configured. Risk thresholds must be reviewed against the specific installation and engineering requirements.
- Digital-twin replay and auto-stop are simulation/advisory features, not certified machine-safety controls.

## Run locally
```bash
npm ci
npm test
npm start
```

Regenerate the dataset or model artifact:
```bash
npm run dataset:generate -- 25000 42
npm run train:ml -- 25000 42
```
