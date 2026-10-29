# HillGuard synthetic conveyor dataset

- **File:** `conveyor_synthetic_25000_seed42.csv`
- **Rows:** 25,000
- **Seed:** 42
- **Provenance:** synthetic simulation only; not field validated.
- **Regenerate:** `npm run dataset:generate -- 25000 42`

The CSV contains raw synthetic sensor channels, derived ML features, a generated fault class, anomaly flag, and a synthetic 10-minute hazard label. The timestamps are simulated at a 2-second interval, but each row is generated independently and should not be interpreted as continuous real-world time-series data. Labels are rule-generated from the synthetic scenario, so held-out metrics measure agreement with these simulation rules rather than proven field performance.
