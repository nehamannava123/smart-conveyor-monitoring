# HillGuard release notes — operational intelligence and evaluation

## Included in this build

- Explainable risk scores with measured sensor values, transformed score inputs, configured thresholds, anomaly boosts, terrain-aware weights, channel contributions, trigger reasons and severity rules.
- Sensor-health dashboard with freshness, last-seen time, missing/out-of-range/stale state, communication status, configured valid ranges, risk thresholds, calibration configuration and retained data-quality incident history.
- Incident investigation with triggering snapshots, nearby readings, probable and alternative causes, model status/limitations, recommended inspection steps, linked work-order creation, acknowledgement, repair notes and post-repair reading comparison.
- Historical trend charts and event replay across alignment, vibration, tension, slip, load, temperature and stored risk. Selected samples can be overlaid on the Digital Twin as a clearly labelled visualization-only replay.
- ML evaluation diagnostics from held-out synthetic predictions: confusion matrix, precision-recall curve, calibration bins, false-alarm rate, missed-event rate and synthetic fault-class subgroup metrics.
- Regenerated deterministic 5,000-sample synthetic ML artifact with evaluation diagnostics for nine model entries.
- Fixed tail-pulley component mapping from nonexistent `zone-f` to configured `zone-e`.
- Risk scoring excludes the exact persisted reading under evaluation from its rolling history, keeping pre-save and post-save point-in-time scores consistent.

## Verification status

- Backend and frontend JavaScript syntax checks passed.
- Focused test run: 18 passed, 0 failed.
- Full `npm test` run: 18 passed, 6 test files failed to initialize because runtime dependencies (`dotenv`, `bcryptjs`, `uuid`, etc.) could not be installed in this environment. `npm ci` timed out against the npm registry and the offline retry lacked cached packages. This is an environment limitation, not a passing full-suite result.
- See `IMPLEMENTATION-AND-VERIFICATION.md` and `FINAL-VERIFICATION-STATUS.md` for the exact scope and limitations.

## Important limitations

- Telemetry remains simulator-generated; no physical sensor adapter or calibration registry is configured.
- Historical replay is limited to 500 retained readings per zone.
- ML metrics describe synthetic held-out data only; field performance is not established.
- Digital Twin replay is visualization only and does not issue physical controls.
- A full interactive browser pass on all roles and screen sizes was not possible here.
- Before public production deployment, run `npm ci`, `npm test`, and `npm audit` in a networked environment, review advisories and any breaking dependency updates, and complete browser-based authorization and workflow testing.
- Demo credentials are for local development only. Configure strong production secrets and persistent VAPID keys before deployment.
