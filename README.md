# ⚛ Quantum Traffic Optimizer

A real-time **4-road junction traffic signal optimizer** with a **3D simulation dashboard** (React Three Fiber) and a **Python FastAPI backend** that runs a **genuine Qiskit QAOA quantum circuit** (Quantum Approximate Optimization Algorithm) to compute signal timings.

Stack a junction with cars, buses, trucks, motorcycles, autos and ambulances — then watch three optimizers compete for the best 120-second signal cycle:

| Optimizer | Strategy |
|---|---|
| 🔴 **Normal** | Fixed equal split — 30 s per road, no intelligence |
| 🟡 **AI** | Weighted proportional allocation + ambulance priority (+10,000 score) + heavy-vehicle tiebreaker |
| 🟢 **Quantum** | Real **Qiskit QAOA** on a 16-qubit QUBO built with `qiskit-optimization` |

---

## ✨ Features

- **Real quantum optimization** — every click on “Optimize with Quantum” formulates an integer program, converts it to a QUBO with `QuadraticProgramToQubo`, and solves it with `QAOA(reps=2)` driven by `COBYLA(maxiter=80)` on the `Sampler` primitive. Nothing is hardcoded — timings come from measured circuit results.
- **Interactive 3D junction** — wide 14-unit highways in realistic asphalt gray with **zebra crossings**, thick **stop lines**, **dashed lane lines + solid edge lines**, and raised **center divider curbs** (left lane reserved for turning); a reference-style control cabin (dark body, white pillars, blue-glow windows) surrounded by **compact signal heads placed right next to the cabin** with big solid-black countdown overlays; always-green left-turn indicators, 3D Orbitron road labels, and low-poly vehicles (cars, buses, trucks, motorcycles, autos, ambulances with flashing light bars) that queue **statically** behind the stop line on the right lane.
- **Traffic movement simulation** — vehicles stay completely frozen until you click Optimize; after the quantum results arrive they drive forward on their road's green (constant speed), stop instantly on red/yellow, and disappear after crossing the intersection. The cycle loops with the quantum timings until you stop or reset it.
- **Live signal animation** — after optimization the 3D lights run the full A → B → C → D cycle using the quantum timings (green, yellow for the last 3 s, red), then reset.
- **Explainable results** — every optimizer ships a dynamically generated reasoning report (weighted scores, ambulance detection, tiebreakers, QUBO formulation, per-road deltas vs normal, measured improvement).
- **Metrics** — estimated wait time and throughput score for all three methods, computed by the backend.

---

## 📁 Project structure

```
quantum-traffic/
├── backend/
│   ├── requirements.txt      # pinned Python dependencies
│   └── main.py               # FastAPI app: 3 optimizers + Qiskit QAOA + reasoning engine
├── frontend/
│   ├── package.json
│   ├── vite.config.js        # dev server :3000 with /api proxy -> :8000
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx           # layout + signal-cycle animation driver
│       ├── App.css           # dark neon glassmorphism theme
│       ├── store.js          # Zustand store (traffic, results, signal state, API call)
│       └── components/
│           ├── Junction3D.jsx    # React Three Fiber 3D scene
│           ├── ControlPanel.jsx  # road/vehicle pickers + dashboard + optimize button
│           └── ResultsPanel.jsx  # comparison cards + reasoning cards
└── README.md
```

---

## 🚀 Running the project

You need **two terminals**. Python **3.10–3.12** is required (the pinned `numpy 1.26.4` has no wheels for 3.13+).

### 1. Backend (port 8000)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

The API serves on `http://localhost:8000`. Verify:

```bash
curl http://localhost:8000/api/health
# {"status":"ok","quantum_backend":"qiskit_qaoa"}
```

### 2. Frontend (port 3000)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:3000**. The Vite dev server proxies every `/api/*` request to the FastAPI backend on port 8000.

### Using it

1. Pick a road (A–D), then click vehicle buttons to add vehicles (5 clicks = 5 of that type).
2. Press **⚛ Optimize with Quantum** — the QAOA run takes a few seconds (the loading overlay shows progress).
3. Compare the three timing plans, read the reasoning, and watch the 3D signals run the quantum cycle.

---

## 🧠 How the quantum optimization works

### 1. From traffic to an optimization problem

Each road gets a weighted priority score from its queue:

| Vehicle | Weight | Clearance (s/vehicle) |
|---|---|---|
| Ambulance | 100 (+10,000 emergency boost) | 4.0 |
| Truck | 8 | 3.5 |
| Bus | 6 | 3.0 |
| Car | 3 | 2.0 |
| Auto | 2 | 1.8 |
| Motorcycle | 1 | 1.2 |

The backend then builds a `QuadraticProgram`:

- **Integer variables** `t_A, t_B, t_C, t_D ∈ [2, 12]` — actual green seconds are `t × 5`, i.e. 10–60 s (the signal min/max).
- **Objective** `minimize −5·Σ(scoreᵣ · tᵣ)` — maximizing priority-weighted green time.
- **Constraint** `t_A + t_B + t_C + t_D = 24` — the cycle must total exactly 120 s.

### 2. QUBO conversion

`QuadraticProgramToQubo` converts the integer program into an unconstrained binary problem: each integer variable becomes binary qubits (binary encoding) and the equality constraint becomes a quadratic penalty term. The result is a **16-variable QUBO = a 16-qubit circuit**.

### 3. QAOA

`QAOA(reps=2, optimizer=COBYLA(maxiter=80))` wrapped in `MinimumEigenOptimizer`:

1. A uniform superposition of **all 2¹⁶ = 65,536 candidate signal plans** is prepared.
2. Alternating **cost layers** (encoding the QUBO energies) and **mixer layers** rotate amplitudes so high-quality, constraint-satisfying plans interfere constructively.
3. The circuit is measured via the `Sampler` primitive; **COBYLA** iteratively tunes the two `(γ, β)` angle pairs, using ~80 circuit evaluations.
4. The best measured bitstring is decoded back into `t_A…t_D` and mapped to green seconds, then normalized to exactly 120 s.

The run uses the Aer statevector `Sampler` (`qiskit-aer`, the same `qiskit.primitives.Sampler` interface in C++, ~5–10 s per request). If Aer is absent it transparently falls back to `qiskit.primitives.Sampler`; if the quantum run fails for *any* reason, the endpoint falls back to the AI optimizer and says so in the reasoning — the dashboard always gets a valid plan.

### Why QAOA finds good plans

The ambulance emergency (+10,000) dominates the objective, so the lowest-energy states concentrate amplitude on configurations that hand the ambulance road maximum green (t = 12 → 60 s) while the constraint penalty keeps the cycle at exactly 120 s. Superposition lets the circuit evaluate every split of the 120 s budget simultaneously; interference amplifies the best ones.

---

## 🔌 API documentation

### `GET /api/health`

```json
{ "status": "ok", "quantum_backend": "qiskit_qaoa" }
```

### `POST /api/optimize`

**Request** — vehicle counts per road (any subset of keys; missing keys default to 0):

```json
{
  "A": { "car": 5, "ambulance": 1 },
  "B": { "car": 10 },
  "C": { "bus": 3 },
  "D": { "motorcycle": 2 }
}
```

Vehicle types: `car`, `bus`, `truck`, `motorcycle`, `auto`, `ambulance`.

**Response**:

```json
{
  "normal":   { "A": 30, "B": 30, "C": 30, "D": 30 },
  "ai":       { "A": 60, "B": 20, "C": 20, "D": 20 },
  "quantum":  { "A": 60, "B": 25, "C": 25, "D": 10 },
  "reasoning": {
    "normal":  "NORMAL OPTIMIZER - Fixed Equal Split ...",
    "ai":      "AI OPTIMIZER - Weighted Proportional Distribution ...",
    "quantum": "QUANTUM OPTIMIZER - Qiskit QAOA (real quantum circuit run) ..."
  },
  "metrics": {
    "normal":  { "total_estimated_wait": 34.05, "throughput_score": 5.25 },
    "ai":      { "total_estimated_wait": 33.17, "throughput_score": 5.5 },
    "quantum": { "total_estimated_wait": 32.16, "throughput_score": 5.88 }
  },
  "total_cycle": 120
}
```

- `total_estimated_wait` = Σ over roads of `clearance_time × (120 − green)/120` (lower is better)
- `throughput_score` = Σ over roads of `vehicles × green/120` (higher is better)

Example with `curl`:

```bash
curl -X POST http://localhost:8000/api/optimize \
  -H "Content-Type: application/json" \
  -d '{"A":{"car":5,"ambulance":1},"B":{"car":10},"C":{"bus":3},"D":{"motorcycle":2}}'
```

---

## 🛠 Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.10–3.12, FastAPI 0.115, Uvicorn, Pydantic v2 |
| Quantum | Qiskit 1.2, qiskit-algorithms (QAOA), qiskit-optimization (QuadraticProgram, QUBO), qiskit-aer (statevector Sampler), NumPy |
| Frontend | React 18, Vite 5, Three.js + @react-three/fiber + @react-three/drei, Axios, Zustand |
| Fonts | Self-hosted Orbitron & Inter via Fontsource (no CDN needed) |

---

## 🔗 Connecting to a landing page

The dashboard is a self-contained Vite app, so wiring it behind an existing landing page is easy:

1. **Build the dashboard:** `cd frontend && npm run build` → static bundle in `frontend/dist/`.
2. **Static hosting (same origin):** copy or serve `dist/` from any path (e.g. `/simulator/`) and add a link/button on the landing page: `<a class="cta" href="/simulator/">Try the live demo</a>`.
3. **Reverse proxy:** point your web server at the built assets and forward `/api/` to the backend:
   - **Nginx:** `location /api/ { proxy_pass http://127.0.0.1:8000; }` plus `location / { root /var/www/quantum-traffic/dist; try_files $uri /index.html; }`
   - **Or keep Vite dev/proxy:** reuse `server.proxy` from `vite.config.js` in your own config.
4. **Separate domains:** host the built frontend anywhere and set `allow_origins=["*"]` (already enabled in `main.py`) so the browser can call `https://api.yourdomain.com/api/optimize` directly — just change the Axios base URL in `frontend/src/store.js` (`axios.post('/api/optimize', …)` → your absolute API URL).
5. **iframe embed:** because everything is same-origin-friendly, `<iframe src="https://your-host/" style="width:100%;height:900px;border:0"></iframe>` on the landing page works out of the box.

---

## ⚠️ Notes

- The QAOA request legitimately takes **5–15 seconds** (a real variational quantum circuit is being simulated and optimized) — the loading overlay covers this.
- Results can vary slightly between runs: QAOA is a sampling algorithm with a randomized initial point, which is exactly the point of quantum optimization.
- All timings are validated to respect 10–60 s per road and sum to exactly 120 s, no matter what the circuit returns.
