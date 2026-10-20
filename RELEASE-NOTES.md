# HillGuard release notes — zone-aware UI update

## Included in this build

- Persistent light/dark theme toggle in the application header; preference is stored locally in the browser and does not change server data.
- Digital Twin active-zone selector synchronized with the dashboard's selected zone.
- Selected-zone highlighting in the route visualization, including risk score and risk level on each zone label.
- Selected-zone context line with latest reading timestamp where available.
- Scenario inputs initialize from the selected zone's incline and latest available alignment/load/tension telemetry, bounded to the simulator's supported slider ranges. Derived conversions are engineering starting estimates, not calibrated sensor-to-physics equivalences.
- Component inspector follows the selected zone where a mapped component exists.
- Corrected the tail-pulley component association from non-existent `zone-f` to the configured `zone-e`.
- Added regression coverage for theme persistence and zone-aware Digital Twin elements.

## Verification performed in this build environment

- `node --check public/js/app.js` passed.
- `npm test`: 34 passed, 0 failed.
- Local server smoke test: `/api/health` returned `status: ok`, five zones, five assets, model ready, and healthy storage.

## Important limitations

- The telemetry stream is simulator-generated unless a real sensor integration is configured.
- The saved ML artifact is trained on synthetic events and is not validated against field data.
- A full interactive browser pass on all roles and screens has not been completed in this environment.
- The container could not complete registry access for `npm audit fix`; dependency audit findings from the user's local `npm audit` output must still be resolved and re-audited on a networked machine before public production deployment. Do not use `npm audit fix --force` without reviewing breaking changes.
- Default demo credentials are for local development only. Configure strong production secrets and persistent VAPID keys before deployment.
