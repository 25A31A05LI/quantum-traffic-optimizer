import React from 'react'
import { useStore, ROADS, VEHICLE_TYPES, totalForRoad } from '../store'

function ChooseRoad() {
  const selectedRoad = useStore((s) => s.selectedRoad)
  const traffic = useStore((s) => s.traffic)
  const setSelectedRoad = useStore((s) => s.setSelectedRoad)

  return (
    <div className="panel-section">
      <h3 className="section-title">🛣 CHOOSE ROAD</h3>
      <div className="road-buttons">
        {ROADS.map((road) => {
          const count = totalForRoad(traffic[road])
          const active = selectedRoad === road
          return (
            <button
              key={road}
              className={`btn-road ${active ? 'btn-road--active' : ''}`}
              onClick={() => setSelectedRoad(road)}
            >
              Road {road}
              <span className="btn-road__count">({count})</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ChooseVehicles() {
  const selectedRoad = useStore((s) => s.selectedRoad)
  const roadTraffic = useStore((s) => s.traffic[s.selectedRoad])
  const addVehicle = useStore((s) => s.addVehicle)

  return (
    <div className="panel-section">
      <h3 className="section-title">
        🚦 CHOOSE VEHICLES <span className="title-hint">— adding to Road {selectedRoad}</span>
      </h3>
      <div className="vehicle-buttons">
        {VEHICLE_TYPES.map((v) => (
          <button
            key={v.key}
            className="btn-vehicle"
            onClick={() => addVehicle(v.key)}
            title={`Add one ${v.label.toLowerCase()} to Road ${selectedRoad}`}
          >
            <span className="btn-vehicle__icon">{v.emoji}</span>
            <span className="btn-vehicle__name">{v.label}</span>
            <span className="btn-vehicle__count">{roadTraffic[v.key]}</span>
          </button>
        ))}
      </div>
      <p className="muted-note">
        Click a vehicle to add one per click — 5 clicks = 5 vehicles on Road {selectedRoad}.
      </p>
    </div>
  )
}

function VehicleCountDashboard() {
  const traffic = useStore((s) => s.traffic)

  const grandTotal = ROADS.reduce((sum, r) => sum + totalForRoad(traffic[r]), 0)
  const globalByType = VEHICLE_TYPES.map((v) => ({
    ...v,
    count: ROADS.reduce((sum, r) => sum + traffic[r][v.key], 0),
  }))

  return (
    <div className="panel-section">
      <h3 className="section-title">📊 VEHICLE COUNT DASHBOARD</h3>
      <div className="dashboard-grid">
        {ROADS.map((road) => {
          const rt = traffic[road]
          const total = totalForRoad(rt)
          return (
            <div key={road} className={`road-card ${total > 0 ? 'road-card--populated' : ''}`}>
              <div className="road-card__head">
                <span className="road-card__name">ROAD {road}</span>
                <span className="road-card__total">{total}</span>
              </div>
              <div className="road-card__breakdown">
                {total === 0 ? (
                  <span className="road-card__empty">No vehicles yet</span>
                ) : (
                  VEHICLE_TYPES.filter((v) => rt[v.key] > 0).map((v) => (
                    <span key={v.key} className="road-card__type">
                      {v.emoji} {v.label}: <b>{rt[v.key]}</b>
                    </span>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="summary-bar">
        <span className="summary-bar__total">
          TOTAL VEHICLES: <b>{grandTotal}</b>
        </span>
        {globalByType.map((v) => (
          <span key={v.key} className="summary-bar__type">
            {v.emoji} {v.count}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function ControlPanel() {
  const loading = useStore((s) => s.loading)
  const error = useStore((s) => s.error)
  const results = useStore((s) => s.results)
  const traffic = useStore((s) => s.traffic)
  const optimize = useStore((s) => s.optimize)
  const resetAll = useStore((s) => s.resetAll)

  const grandTotal = ROADS.reduce((sum, r) => sum + totalForRoad(traffic[r]), 0)
  const disabled = loading || grandTotal === 0

  return (
    <section className="glass control-panel">
      <ChooseRoad />
      <ChooseVehicles />
      <VehicleCountDashboard />

      {error && <div className="error-banner">⚠ {error}</div>}

      <div className="optimize-row">
        <button className="optimize-btn" disabled={disabled} onClick={optimize}>
          ⚛ Optimize with Quantum
        </button>
        <button
          className="reset-btn"
          disabled={loading}
          onClick={resetAll}
          title="Clear all vehicles and results"
        >
          ⟲ Reset
        </button>
      </div>
      {results && !loading && (
        <p className="muted-note success-note">
          ✓ Last optimization completed — signal cycle is animating with the quantum plan.
        </p>
      )}
    </section>
  )
}
