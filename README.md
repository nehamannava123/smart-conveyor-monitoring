# HillGuard — Industrial Predictive Monitoring & Conveyor Dislodgement Prevention

HillGuard is a full-stack industrial condition-monitoring and predictive-maintenance application designed for belt conveyors operating on undulating and steep hilly terrain.

It integrates physics-grounded telemetry ingestion, deterministic engineering rule bounds (CEMA / ISO 10816), reproducible offline machine-learning hazard forecasting, computer-vision video inspection, maintenance work-order management, equipment asset registries, and a real-time digital-twin dashboard.

---

## 1. System Architecture & Core Flow

```
                               ┌────────────────────────────────────────────────────────┐
                               │                 Sensor Integration Layer               │
                               │  - Simulated Telemetry Engine (server/services/sim.js) │
                               │  - Standardized Schema (MQTT / OPC-UA / PLC ready)     │
                               └──────────────────────────┬─────────────────────────────┘
                                                          │ 0.5 Hz (every 2s)
                                                          ▼
                               ┌────────────────────────────────────────────────────────┐
                               │                    Data Quality Guard                  │
                               │  - Stale reading detection (>60s old)                  │
                               │  - Missing/NaN channel verification                    │
                               │  - Sensor physical range plausibility checks           │
                               └──────────────────────────┬─────────────────────────────┘
                                                          │
                               ┌──────────────────────────┴─────────────────────────────┐
                               ▼                                                        ▼
    ┌─────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────┐
    │          Deterministic Risk Engine v2           │   │         Offline ML Artifact Engine (v2)         │
    │  - Engineering thresholds (CEMA / ISO 10816)    │   │  - Pre-trained versioned artifact loading       │
    │  - Terrain-aware weighting (grade & curves)     │   │  - 10-minute dislodgement hazard forecasting    │
    │  - Rolling z-score statistical anomaly boost    │   │  - Multi-model suite (RF, GB, Logistic, Tree)   │
    │  - Isolated inspectable channel contributions   │   │  - Directional feature influence explainability │
    └──────────────────────────┬──────────────────────┘   └────────────────────────┬────────────────────────┘
                               │                                                   │
                               └──────────────────────────┬────────────────────────┘
                                                          │
                                                          ▼
                               ┌────────────────────────────────────────────────────────┐
                               │               Automation & Safety Engine               │
                               │  - Alert generation with suppression & debouncing      │
                               │  - Software-simulated auto-stop interlock              │
                               │  - Push notifications (VAPID Web Push)                 │
                               └──────────────────────────┬─────────────────────────────┘
                                                          │
                               ┌──────────────────────────┴─────────────────────────────┐
                               ▼                                                        ▼
    ┌─────────────────────────────────────────────────┐   ┌─────────────────────────────────────────────────┐
    │           Operational Workflows Layer           │   │          Hardened Persistence Layer             │
    │  - Equipment Asset Registry (Motors, Winches)   │   │  - Atomic write-to-temp and rename operations   │
    │  - Maintenance Work Orders (Alert -> Task)      │   │  - Automated snapshot backups (db.json.bak)     │
    │  - Audit Trail (Admin-only RBAC inspection)     │   │  - Instant corruption recovery                  │
    │  - Exportable CSV / PDF Operational Reports     │   │  - Immediate flush on critical state mutations  │
    └──────────────────────────┬──────────────────────┘   └─────────────────────────────────────────────────┘
                               │
                               ▼
    ┌───────────────────────────────────────────────────────────────────────────────────┐
    │                   Realtime WebSocket & Control Room Dashboard                     │
    │  - 3D / 2D Digital Twin, live terrain elevation map, responsive control room UI  │
    └───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Security & Role-Based Access Control (RBAC)

HillGuard enforces granular role-based access across all endpoints and real-time events:

| Role | Permissions & Responsibilities |
|---|---|
| **ADMIN** | Full system administration, audit log inspection (`GET /api/audit`), closing/signing off work orders, provisioning new user accounts, asset creation, manual conveyor control overrides. |
| **OPERATOR** | Control room monitoring, manual start/stop/reset conveyor zone controls, acknowledging and resolving alerts, creating maintenance work orders, advancing task progress (`IN_PROGRESS`, `RESOLVED`), generating diagnoses, video inspection. |
| **VIEWER** | Read-only inspection of live telemetry, terrain profiles, model metrics, and digital twin state. Manual control buttons, state mutations, and audit logs are strictly restricted. |

### Security Safeguards Implemented
- **Production Credential Bootstrapping**: Default demo passwords (`admin123`, etc.) are strictly prohibited when `NODE_ENV=production`. Production startup requires explicitly configured `INITIAL_ADMIN_PASSWORD` and an unguessable `JWT_SECRET` (minimum 32 characters).
- **Cryptographic Algorithm Pinning**: Tokens are pinned to `HS256` explicitly during signing and verification to prevent algorithm confusion attacks (`none`, public-key confusion).
- **Audit Access Enforcement**: `/api/audit` is strictly restricted to `ADMIN`. Non-admin attempts return `403 Forbidden` and are logged.
- **Private Video Inspection Scoping**: Socket.IO progress and inspection outputs are emitted exclusively to the user's private scoped room (`user:<id>`), preventing cross-user inspection leakage.
- **Upload Hardening**: Uploaded video files undergo magic-byte signature validation (MP4, WebM, MKV, AVI) rather than trusting client MIME types or file extensions. Ingestion is bounded by a concurrency semaphore (max 1 concurrent analysis) and 45-second execution timeouts.
- **Production HTTP Security**: Configured with Helmet Content Security Policy (CSP), rate limiting (15 login attempts per 15 min; 600 API requests per min), and configurable `CORS_ORIGIN` allowlists.

---

## 3. Machine Learning Architecture & Benchmarks

Expensive model training is completely decoupled from application boot. Models are trained through a reproducible, seeded offline workflow and serialized into `data/models/model-artifact.json`.

### 3.1 Distinct Prediction Tasks
1. **Task A: Dislodgement Hazard Forecasting (~10 min Horizon)**: Supervised binary classification estimating the probability of a belt derailment or dislodgement event in the upcoming 10 minutes based on causal rolling sensor trends.
2. **Task B: Fault Classification**: Multi-class categorization isolating the physical failure mode (`MISTRACKING`, `SLIPPAGE`, `TENSION_LOSS`, `STRUCTURE_VIBRATION`, `MATERIAL_IMBALANCE`, `MOTOR_OVERHEAT`, or `NORMAL`).
3. **Task C: Statistical Anomaly Detection**: Rolling z-score deviations measuring statistical drift against historical baselines.
4. **Task D: Remaining Useful Life (RUL)**: Treated strictly as a future capability requiring empirical run-to-failure degradation curves. HillGuard does **not** fabricate an arbitrary countdown or present a risk score as RUL.

### 3.2 Evaluation Benchmarks & Metrics (Bundled artifact: seed 42, 25,000 synthetic scenarios)
Metrics below are calculated on a deterministic 20% held-out synthetic set. They describe agreement with the synthetic scenario labels only; they are not field performance estimates. Values are read from the bundled `data/models/model-artifact.json` and may change when the model is retrained.

| Model / Baseline | Accuracy | Precision | Recall | F1 Score | ROC-AUC | Brier Score | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| Logistic Regression (L2) | 97.1% | 91.3% | 74.9% | 82.3% | 0.992 | 0.0224 | Candidate |
| Sparse Logistic Regression (L1) | 95.9% | 92.6% | 59.2% | 72.2% | 0.986 | 0.0273 | Candidate |
| Decision Tree Classifier | 96.7% | 88.4% | 72.0% | 79.4% | 0.977 | 0.0262 | Candidate |
| Random Forest | 96.4% | 83.3% | 74.9% | 78.9% | 0.982 | 0.0247 | Candidate |
| Gradient Boosting | 94.3% | 73.5% | 56.5% | 63.9% | 0.912 | 0.0525 | Candidate |
| Physics-Informed Hybrid | 96.4% | 84.6% | 72.4% | 78.0% | 0.990 | 0.0244 | Candidate |
| Multi-Model Ensemble | 96.8% | 87.2% | 74.7% | 80.4% | 0.988 | 0.0259 | Candidate |
| Isolation Forest (anomaly task) | 94.1% | 93.2% | 89.8% | 91.5% | 0.982 | 0.1809 | Anomaly model |
| Neural Autoencoder (anomaly task) | 98.9% | 97.9% | 99.1% | 98.5% | 0.995 | 0.1496 | Anomaly model |

### 3.3 Synthetic Data Provenance vs. Field Validation
- **Synthetic Training Data**: The training dataset is derived from parameterized physics models incorporating terrain grade, curvature, friction, and tension dynamics.
- **Limitation**: Synthetic labels are generated from the same scenario rules that produce sensor perturbations. Models can learn those rules, so strong held-out metrics do not establish real-world generalization. The bundled CSV is independently generated synthetic scenarios with simulated timestamps, not continuous field telemetry. Validate against independently labeled sensor histories and maintenance outcomes before operational use.

---


### 3.4 Included Dataset
The repository includes `data/datasets/conveyor_synthetic_25000_seed42.csv` with 25,000 labeled synthetic rows, raw sensor channels, derived features, fault classes, anomaly labels, synthetic 10-minute hazard labels, and a reproducible 80/20 candidate partition column. See `data/datasets/README.md` and `metadata.json` for provenance, class distribution, column definitions, and limitations. Regenerate with `npm run dataset:generate -- 25000 42`. Do not describe these rows as field data.

## 4. Maintenance Workflows & Operations

### 4.1 Equipment Asset Registry
Monitors key physical components across all zones:
- `asset-mot-01`: Primary Incline Drive Motor (450 kW, Zone B)
- `asset-takeup-01`: Gravity Take-Up Winch & Carriage (12T, Zone E)
- `asset-train-01`: Curved Training Idler Bank (CEMA E, Zone C)
- `asset-truss-01`: Ridge Structural Truss & Anchors (Zone D)
- `asset-chute-01`: Centering Loading Chute & Skirtboard (Zone A)

Tracks asset specifications, serial numbers, operating hours, health scores, and service logs.

### 4.2 Maintenance Work Orders
Operators and Admins can convert confirmed alerts into structured maintenance tasks:
- **Status Lifecycle**: `OPEN` ➔ `ASSIGNED` ➔ `IN_PROGRESS` ➔ `AWAITING_PARTS` ➔ `RESOLVED` ➔ `CLOSED`.
- **Integrations**: Links directly to the originating alert, maintains an inspection checklist, captures repair notes, and logs every transition into the permanent audit trail.
- **Sign-off Control**: Closing and signing off on a work order requires the `ADMIN` role.

### 4.3 Operational Analytics & Export
- **Summary Dashboard**: Real-time MTTR (Mean Time to Resolution), active task backlog, critical event tallies, and per-zone sensor telemetry quality.
- **CSV Data Export**: Direct downloadable CSV endpoints (`/api/reports/export/alerts.csv` and `/api/reports/export/work-orders.csv`) for CMMS integration and statutory auditing.
- **PDF Condition Report**: Formatted multi-page PDF generation detailing zone status, sensor snapshots, and recommended actions.

---

## 5. Persistence, Atomic Writes, and Reliability

Storage is managed by a hardened JSON persistence engine (`server/config/db.js`):
- **Atomic Operations**: State is written to a unique temporary file (`db.json.tmp.<ts>.<rnd>`) in the same filesystem, flushed to disk, and atomically renamed to `db.json`.
- **Backup Snapshots**: Every successful write maintains a duplicate `db.json.bak` snapshot.
- **Crash Recovery**: If `db.json` experiences truncation or corruption during an unexpected power loss, the engine automatically recovers from `db.json.bak` and logs the recovery event.
- **Immediate Flush**: High-consequence mutations (audit entries, work order status changes, alert updates, user provisioning) flush synchronously.

---

## 6. Safety & Automated Intervention Boundaries

> [!CAUTION]
> **Industrial Safety Notice**:
> HillGuard's automated emergency stop (`AUTO_STOP_ENABLED=true`) is a **software simulation** intended for operator training and control room emulation.
>
> In real mining and overland materials-handling operations, machine-stop interlocks must be mediated by certified, independent hardware safety systems:
> - Fail-safe emergency pull-cord switches along the conveyor walkway.
> - SIL-2 / SIL-3 rated safety PLCs and dual-channel safety relays.
> - Hardwired underspeed switches and zero-speed switches directly breaking the motor contactor coil circuit.
>
> HillGuard predictions must never be wired directly to high-voltage variable frequency drives (VFDs) without certified independent safety interlocks.

---

## 7. Installation & Running

### Requirements
- **Node.js**: v18.0.0 or newer (tested on Node v22.23.2 LTS).
- **FFmpeg**: Optional; only required for the Video Inspection feature.

### Quick Start (Development)
```bash
# 1. Install dependencies
npm install

# 2. Retrain or verify ML model artifacts (optional, artifact is pre-bundled)
npm run train:ml -- 25000 42

# 3. Run automated test suite
npm test

# Optional: generate 25,000 labeled synthetic rows (seed 42)
npm run dataset:generate -- 25000 42

# 4. Start the server in development mode
npm start
```
Open **http://localhost:4000** in your browser.

#### Demo Credentials (Development Only)
| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | ADMIN |
| `operator` | `operator123` | OPERATOR |
| `viewer` | `viewer123` | VIEWER |

### Production Deployment via Docker Compose
```bash
# Create your private environment file first (never commit or share it):
cp .env.example .env
# Set JWT_SECRET to output from: openssl rand -hex 32
# Set INITIAL_ADMIN_PASSWORD to a unique, strong password.
# For remote access, set CORS_ORIGIN only to the exact frontend origin(s).
docker compose up -d --build
```

---

## 8. Automated Test Suite

HillGuard includes a native test suite run via Node's built-in runner (`node:test`):
```bash
npm test
```

### Test coverage (run `npm test` in an environment with dependencies installed)
1. **`tests/auth_security.test.js`**: Password complexity, credential verification, case-normalization, JWT HS256 algorithm enforcement, and RBAC middleware.
2. **`tests/persistence.test.js`**: Atomic write integrity, data survival across restarts, and corruption recovery from `db.json.bak`.
3. **`tests/ml_pipeline.test.js`**: Feature extraction consistency, data quality checks (stale/missing sensors), explainability output, multi-task separation (10m hazard forecasting, unsupervised anomaly detection, fault classification), Isolation Forest path lengths, Neural Autoencoder reconstruction residuals, Physics-Informed CEMA mechanical constraints, and candidate evaluation audit.
4. **`tests/risk_automation.test.js`**: Engineering threshold bounds, anomaly z-scores, alert debouncing, and simulated auto-stop safety boundaries.
5. **`tests/workorders_assets.test.js`**: Equipment registry retrieval, maintenance logging, work order lifecycle (`OPEN` -> `IN_PROGRESS` -> `RESOLVED` -> `CLOSED`), and RBAC sign-off checks.
6. **`tests/video.test.js`**: Video frame band scoring, lateral drift / vibration proxy evaluation, and graceful handling of missing `ffmpeg`.
7. **`tests/api_routes.test.js`**: End-to-end integration tests for `/api/health`, `/api/audit`, `/api/assets`, `/api/work-orders`, and CSV report exports.
8. **`tests/frontend_integrity.test.js`**: Command-center and sensor snapshot elements are present; dynamically generated controls comply with the strict Content Security Policy.
9. **`tests/simulator_reset.test.js`**: Verifies reset clears in-memory simulator fault state and returns stopped-zone readings to a safe baseline.
10. **`tests/twin_physics.test.js`**: CEMA 7th Ed. / ISO 5048 physical formulas, downhill regenerative power detection, Euler capstan slip margins, threshold violation alarms, comparative deltas, and `/api/twin/*` HTTP CRUD endpoints.
11. **`tests/operations_features.test.js`**: risk explainability evidence, held-out model evaluation diagnostics, digital-twin zone mapping, and committed artifact diagnostics.



## Dashboard and integration improvements

- The Dashboard now opens as a responsive command center with zone, running-state, elevated-risk, open-alert, and telemetry-health KPIs.
- The selected zone shows a live six-channel sensor snapshot (alignment, vibration, tension, slip, material load, and motor temperature) using thresholds aligned to the risk engine. Historical charts use stored/live readings rather than fabricated sample points.
- Alerts, zone controls, work orders, asset maintenance, and audit refreshes are synchronized through the shared API and Socket.IO events. Asset creation is available to Admins; maintenance logging and work-order progression are available to Operators/Admins, with Viewer access remaining read-only.
- Dynamic work-order and saved-scenario actions use delegated event listeners so they work with the strict CSP instead of relying on blocked inline event-handler attributes.
- The simulator is the current telemetry source unless a physical sensor adapter is separately integrated. ML artifacts are trained/evaluated on synthetic data and are not field-validated safety equipment. The latest focused test run passed 18 tests; full-suite execution in this environment was blocked by unavailable npm dependencies. See `FINAL-VERIFICATION-STATUS.md`.
