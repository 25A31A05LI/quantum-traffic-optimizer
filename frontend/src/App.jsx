import React, { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import Junction3D from './components/Junction3D'
import ControlPanel from './components/ControlPanel'
import ResultsPanel from './components/ResultsPanel'
import { useStore, ROADS } from './store'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const YELLOW_PHASE = 3 // last 3 seconds of each green are shown as yellow
const ALL_RED_CLEARANCE = 2000 // all-red buffer between phases (lets the box clear)

/**
 * If WebGL cannot start (blocked in an embedded viewer, hardware acceleration
 * off, ...), react-three-fiber throws during mount — without a boundary that
 * would unmount the ENTIRE page (blank screen). This boundary degrades
 * gracefully: the 3D scene is replaced by a notice while the dashboard,
 * controls and results keep working.
 */
class SceneErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('3D scene failed to start:', error)
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="scene-wrap scene-fallback">
          <div className="scene-fallback__box">
            <h3>⚠ 3D scene unavailable in this view</h3>
            <p>
              WebGL could not start here, so the 3D junction is hidden — every
              other feature still works normally.
            </p>
            <p>
              Open the dashboard in a regular browser tab (with hardware
              acceleration enabled) to see the animated 3D junction.
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Drives the 3D signal animation. After each optimization the junction cycles
 * A -> B -> C -> D using the QUANTUM green times (yellow for the final 3s of
 * each phase) and then LOOPS continuously until stopped or reset. The
 * vehicles in the 3D scene react to these signal states in real time, but
 * ONLY while `isSimulationRunning` is true.
 */
function useSignalCycle() {
  const cycleToken = useStore((s) => s.cycleToken)
  const results = useStore((s) => s.results)
  const setSignal = useStore((s) => s.setSignal)
  const resetSignals = useStore((s) => s.resetSignals)
  const stopRef = useRef(false)

  useEffect(() => {
    if (!cycleToken || !results) return undefined

    stopRef.current = false
    let cancelled = false

    const run = async () => {
      // PRIORITY CLEARANCE ORDER from the backend: ambulance roads first,
      // then descending weighted traffic score (fallback: A, B, C, D).
      const order =
        Array.isArray(results.priority_order) && results.priority_order.length === ROADS.length
          ? results.priority_order
          : ROADS

      while (!cancelled && !stopRef.current && useStore.getState().cycleRunning) {
        useStore.getState().bumpCycleEpoch() // new loop started -> respawn queues
        for (const road of order) {
          const duration = results.quantum[road] || 0
          for (let remaining = duration; remaining > 0; remaining--) {
            if (cancelled || stopRef.current) break
            const state = remaining > YELLOW_PHASE ? 'green' : 'yellow'
            setSignal(road, state, remaining)
            await sleep(1000)
          }
          if (cancelled || stopRef.current) break
          setSignal(road, 'red', 0)
          await sleep(ALL_RED_CLEARANCE) // let committed vehicles clear the box
        }
      }
      if (!cancelled) resetSignals()
    }

    run()
    return () => {
      cancelled = true
    }
  }, [cycleToken, results, setSignal, resetSignals])

  return {
    stop: () => {
      stopRef.current = true
    },
  }
}

export default function App() {
  /* ------------------------------------------------------------------
   * Vehicles are COMPLETELY STATIC until this flag flips to true, which
   * happens exclusively inside runOptimization() after the FastAPI
   * quantum-optimization call returns successfully.
   * ------------------------------------------------------------------ */
  const [isSimulationRunning, setIsSimulationRunning] = useState(false)

  const loading = useStore((s) => s.loading)
  const cycleRunning = useStore((s) => s.cycleRunning)
  const results = useStore((s) => s.results)
  const signalStates = useStore((s) => s.signalStates)
  const startCycle = useStore((s) => s.startCycle)

  const activeEntry = Object.entries(signalStates).find(([, v]) => v !== 'red')
  const activeRoad = activeEntry?.[0]
  const activeState = activeEntry?.[1]

  const { stop } = useSignalCycle()

  /* ------------------------------------------------------------------
   * runOptimization — calls the backend, stores the results, starts the
   * signal cycle, and ONLY on success allows the vehicles to move.
   * ------------------------------------------------------------------ */
  const runOptimization = useCallback(async () => {
    const { traffic, loading: busy } = useStore.getState()
    const totalVehicles = Object.values(traffic).reduce(
      (sum, road) => sum + Object.values(road).reduce((a, b) => a + b, 0),
      0
    )
    if (busy || totalVehicles === 0) return

    useStore.setState({ loading: true, error: null })
    try {
      const { data } = await axios.post('http://localhost:8000/api/optimize', traffic, {
        headers: { 'Content-Type': 'application/json' },
      })
      // Success: store results and kick off the signal cycle.
      useStore.setState({ results: data, loading: false })
      useStore.getState().startCycle()
      // ONLY here — after the quantum results came back — may vehicles move.
      // (Mirrored into the store so the 3D useFrame loop reads it LIVE.)
      setIsSimulationRunning(true)
      useStore.setState({ simulationRunning: true })
    } catch (err) {
      const detail = err?.response?.data?.detail?.[0]?.msg
      const message =
        detail || err?.message || 'Request failed - is the backend running on port 8000?'
      useStore.setState({
        loading: false,
        error: `Quantum optimization failed: ${message}`,
      })
      // Failure: vehicles stay frozen.
      setIsSimulationRunning(false)
    }
  }, [])

  // Route the ControlPanel's optimize button through runOptimization above
  // (the panel calls the store's `optimize` action).
  useEffect(() => {
    useStore.setState({ optimize: runOptimization })
  }, [runOptimization])

  // If the results are ever cleared (Reset), freeze the vehicles again.
  useEffect(() => {
    if (!results) setIsSimulationRunning(false)
  }, [results])

  const handleStopAnimation = () => {
    stop() // cancels the signal loop (lights return to red)
    useStore.setState({ simulationRunning: false }) // freeze vehicles (live flag)
    setIsSimulationRunning(false)
  }

  const handleRestartAnimation = () => {
    startCycle() // restarts the looping signal cycle
    useStore.setState({ simulationRunning: true })
    setIsSimulationRunning(true)
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="title-gradient">⚛ Quantum Traffic Optimizer</h1>
        <p className="subtitle">Real-time junction simulation powered by Qiskit QAOA</p>
      </header>

      <main className="layout">
        <div className="scene-column">
          <SceneErrorBoundary>
            <Junction3D isSimulationRunning={isSimulationRunning} />
          </SceneErrorBoundary>
          {cycleRunning && (
            <div className="cycle-banner">
              <span className="cycle-banner__text">
                {activeRoad
                  ? `SIGNAL CYCLE RUNNING — ROAD ${activeRoad} ${
                      activeState === 'yellow' ? 'YELLOW' : 'GREEN'
                    }`
                  : 'SIGNAL CYCLE RUNNING — CLEARING INTERSECTION'}
              </span>
              {results?.priority_order && (
                <span className="cycle-banner__order">
                  Clearance: {results.priority_order.join(' → ')}
                </span>
              )}
              <span className="cycle-banner__actions">
                <button className="cycle-btn cycle-btn--stop" onClick={handleStopAnimation}>
                  ⏹ Stop
                </button>
                <button className="cycle-btn cycle-btn--replay" onClick={handleRestartAnimation}>
                  ⟳ Restart
                </button>
              </span>
            </div>
          )}
        </div>

        <ControlPanel />
        <ResultsPanel />
      </main>

      <footer className="footer">
        Quantum Traffic Optimizer · FastAPI + Qiskit QAOA backend · React Three Fiber
        simulation
      </footer>

      {loading && (
        <div className="loading-overlay">
          <div className="loading-box">
            <div className="atom-spinner">
              <span className="atom-spinner__ring" />
              <span className="atom-spinner__ring atom-spinner__ring--2" />
              <span className="atom-spinner__core" />
            </div>
            <p className="loading-text">Running QUANTUM Optimization…</p>
            <p className="loading-sub">
              Preparing a 16-qubit QAOA circuit · superposition over all signal plans
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
