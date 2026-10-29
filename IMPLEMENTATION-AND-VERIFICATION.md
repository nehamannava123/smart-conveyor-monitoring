# HillGuard implementation and verification notes

## Implemented in this revision

- Risk explainability: each channel includes the measured value, transformed/scored metric, warning and critical thresholds, rule score, anomaly boost, normalized terrain-aware weight, weighted contribution, threshold state and trigger reason. The risk response also describes the composite score formula and severity decision.
- Sensor health: authenticated endpoint and dashboard show per-zone channel freshness, last-seen age, missing/out-of-range/stale status, communication status, valid input range, configured risk thresholds, and explicit calibration configuration status. A retained-history scan surfaces missing values, out-of-range readings, and long telemetry gaps.
- Incident investigation: authenticated incident detail endpoint returns alert snapshot, nearby retained readings, point-in-time risk evidence, ML inference and limitations, recommended inspections, linked work-order creation, acknowledgement, repair notes and comparison of incident readings with latest readings.
- History and event replay: date-filtered history endpoint, synchronized charts for six telemetry channels and stored risk, incident timestamps, sample stepping, and historical sample overlay in the digital twin. The overlay is explicitly labelled as historical and does not control equipment.
- ML evaluation: model training now saves held-out precision-recall points, calibration bins, confusion matrix, false-alarm rate, missed-event rate, and synthetic fault-class subgroup metrics. The model evaluation UI renders those artifacts and labels their synthetic-data limitation.
- Fixed the tail pulley assembly mapping from nonexistent `zone-f` to configured `zone-e`.
- Risk scoring excludes the exact persisted sample being evaluated from its own rolling history so pre-save and post-save score calls do not differ solely due to self-inclusion.
- Added focused regression tests for risk explainability and evaluation diagnostics.

## Validation performed in this environment

- JavaScript syntax checks passed for the changed backend and frontend files.
- Model artifact regenerated successfully from the repository's deterministic 5,000-sample synthetic training pipeline; artifact contains diagnostics for all nine model entries.
- Focused test run passed: 18 tests, 0 failures (`operations_features`, `frontend_integrity`, `ml_pipeline`, `persistence`, and `simulator_reset`).
- A complete `npm test` run could not be completed because this environment could not install project dependencies. `npm ci` timed out fetching packages, and the offline retry reported a missing cached `zod` package. Consequently tests requiring Express, dotenv, bcryptjs, uuid and other runtime dependencies could not execute here. Run `npm ci` and then `npm test` in an environment with npm registry access before treating this release as fully verified.

## Important limitations

- Telemetry is simulated in this project; no real sensor adapter or calibration registry is configured by this change. Calibration is shown as `NOT_CONFIGURED` rather than assumed valid.
- Historical data is limited to the existing 500-reading per-zone rolling buffer. It is not long-term archival storage.
- Model diagnostics are computed on held-out synthetic samples. They are not evidence of field accuracy or safety certification.
- The digital-twin replay overlay is a visualization of a stored historical sample; it does not replay physical controls or send equipment commands.
- HillGuard is advisory software and must not replace a certified safety PLC, emergency-stop circuit, or site-approved engineering thresholds.
