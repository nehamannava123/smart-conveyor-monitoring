# HillGuard verification status

## Verified in this environment
- `npm test`: 34 tests passed, 0 failed.
- Includes API/RBAC, ML pipeline/data-quality checks, persistence recovery, risk automation, Digital Twin physics/scenario persistence, video-analysis validation, assets, and work-order lifecycle.
- Frontend stylesheet received a theme consistency and responsive navigation pass.

## Important limitations
- The ML artifacts are trained/evaluated on synthetic data. Passing software tests does not establish real-world predictive accuracy; validate against independently collected, labeled conveyor telemetry before making operational claims.
- Sensor telemetry in the demo is simulator-generated unless connected to real hardware.
- Browser-level visual QA on multiple screen sizes and a full manual test of each role has not been completed here.
- Dependency security audit from the user's machine reported vulnerable versions. Run `npm audit fix` locally, then rerun `npm audit` and `npm test`; do not use `--force` without reviewing breaking changes.
- Configure strong production JWT secrets and persistent VAPID keys outside source control before deployment.
