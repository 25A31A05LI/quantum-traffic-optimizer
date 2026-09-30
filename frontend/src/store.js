import { create } from 'zustand'
import axios from 'axios'

export const ROADS = ['A', 'B', 'C', 'D']

export const VEHICLE_TYPES = [
  { key: 'car', label: 'Car', emoji: '🚗' },
  { key: 'bus', label: 'Bus', emoji: '🚌' },
  { key: 'truck', label: 'Truck', emoji: '🚛' },
  { key: 'motorcycle', label: 'Motorcycle', emoji: '🏍️' },
  { key: 'auto', label: 'Auto', emoji: '🛺' },
  { key: 'ambulance', label: 'Ambulance', emoji: '🚑' },
]

const emptyRoad = () => ({
  car: 0,
  bus: 0,
  truck: 0,
  motorcycle: 0,
  auto: 0,
  ambulance: 0,
})

const emptyTraffic = () => ({
  A: emptyRoad(),
  B: emptyRoad(),
  C: emptyRoad(),
  D: emptyRoad(),
})

const allRed = () => ({ A: 'red', B: 'red', C: 'red', D: 'red' })
const zeroTimers = () => ({ A: 0, B: 0, C: 0, D: 0 })

export const totalForRoad = (road) =>
  Object.values(road).reduce((sum, n) => sum + n, 0)

export const useStore = create((set, get) => ({
  // --- traffic input state -------------------------------------------------
  selectedRoad: 'A',
  traffic: emptyTraffic(),

  // --- results / request state ---------------------------------------------
  results: null,
  loading: false,
  error: null,
  simulationRunning: false, // mirrored flag: vehicles read this LIVE inside useFrame

  // --- 3D signal state ------------------------------------------------------
  signalStates: allRed(),
  signalTimers: zeroTimers(),
  cycleRunning: false,
  cycleToken: 0, // incremented to (re)start the animation cycle
  cycleEpoch: 0, // incremented at the START of every simulation loop (drives queue respawn)

  // --- actions ---------------------------------------------------------------
  setSelectedRoad: (road) => set({ selectedRoad: road }),

  addVehicle: (type) =>
    set((state) => ({
      traffic: {
        ...state.traffic,
        [state.selectedRoad]: {
          ...state.traffic[state.selectedRoad],
          [type]: state.traffic[state.selectedRoad][type] + 1,
        },
      },
    })),

  resetAll: () =>
    set({
      traffic: emptyTraffic(),
      results: null,
      error: null,
      signalStates: allRed(),
      signalTimers: zeroTimers(),
      cycleRunning: false,
    }),

  setSignal: (road, signalState, timer) =>
    set((state) => ({
      signalStates: { ...state.signalStates, [road]: signalState },
      signalTimers: { ...state.signalTimers, [road]: timer },
    })),

  resetSignals: () =>
    set({ signalStates: allRed(), signalTimers: zeroTimers(), cycleRunning: false }),

  startCycle: () =>
    set((state) => ({ cycleToken: state.cycleToken + 1, cycleRunning: true })),

  bumpCycleEpoch: () => set((state) => ({ cycleEpoch: state.cycleEpoch + 1 })),

  optimize: async () => {
    const { traffic, loading } = get()
    const totalVehicles = Object.values(traffic).reduce(
      (sum, road) => sum + totalForRoad(road),
      0
    )
    if (loading || totalVehicles === 0) return

    set({ loading: true, error: null })
    try {
      const { data } = await axios.post('/api/optimize', traffic, {
        headers: { 'Content-Type': 'application/json' },
      })
      set({ results: data, loading: false })
      get().startCycle() // kick off the 3D signal animation
    } catch (err) {
      const detail = err?.response?.data?.detail?.[0]?.msg
      const message =
        detail || err?.message || 'Request failed - is the backend running on port 8000?'
      set({ loading: false, error: `Quantum optimization failed: ${message}` })
    }
  },
}))
