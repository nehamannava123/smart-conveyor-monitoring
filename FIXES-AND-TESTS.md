# Fixes and verification report

## Changes

- Added persistent light/dark theme toggle.
- Added a Digital Twin active-zone picker synchronized with global zone selection.
- Zone nodes now show zone name, risk score, and risk level; the selected zone receives a distinct animated highlight.
- Digital Twin's active context shows the selected zone and sample time.
- Selected-zone context initializes the engineering scenario from available zone telemetry, with range clamping.
- Component inspection follows the selected zone when a component mapping exists.
- Fixed tail-pulley mapping from `zone-f` to existing `zone-e`.
- Added a frontend integrity regression test for the new features.

## Tests run

- `node --check public/js/app.js`: PASS.
- `npm test`: 34 passed, 0 failed.
- Local HTTP smoke test: `/api/health` returned `status: ok`, 5 zones, 5 assets, ML ready, storage healthy.

## Not claimed as verified

- Full browser-based interaction and visual verification across every page and role.
- Real physical sensor connectivity or real-world ML performance.
- Clean npm security audit. Registry access timed out in this environment; run `npm audit fix` on a networked machine, then `npm audit` and `npm test`. Review any remaining `uuid` major-version migration separately.
