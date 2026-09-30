import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Html, Text, Float } from '@react-three/drei'
import * as THREE from 'three'
import orbitronFont from '@fontsource/orbitron/files/orbitron-latin-700-normal.woff'
import { useStore, ROADS } from '../store'

/* ================================================================== */
/* Layout configuration                                                */
/* ================================================================== */

// Road arms: A extends toward +X, B toward -X, C toward -Z (North arm), D toward +Z.
// Vehicles approach the intersection along their arm (travelling toward origin).
const ROAD_DIRECTIONS = {
  A: [1, 0],
  B: [-1, 0],
  C: [0, -1],
  D: [0, 1],
}

// RIGHT-side lateral sign per road = the DRIVER'S right while facing the
// intersection (right-hand traffic). The queue fills this side of the centre
// divider; the left side stays empty.
//   A (approach heading -X): right is -Z | B (heading +X): right is +Z
//   C (approach heading +Z): right is -X | D (heading -Z): right is +X
const RIGHT_SIGNS = {
  A: [0, -1],
  B: [0, 1],
  C: [-1, 0],
  D: [1, 0],
}

// Signal poles sit CLOSE TO THE CENTRAL CABIN on the inner diagonals.
const SIGNAL_CORNERS = {
  A: [2.2, 2.2],
  B: [-2.2, -2.2],
  C: [2.2, -2.2],
  D: [-2.2, 2.2],
}

/* ---------- geometry constants (all in world units) ---------- */

const GROUND_COLOR = '#11111a' // plain solid asphalt-dark ground
const ROAD_COLOR = '#666a6e' // realistic visible road gray (matched to reference)

const LANE_W = 2.5 // one lane wide enough for every vehicle model
const ROAD_WIDTH = 17 // 6 lanes (3 per side) + shoulders - major highway
const HALF_INTER = ROAD_WIDTH / 2 // intersection half-size (8.5)

// Right-side lane centres measured from the road centreline (divider).
// Lane 1 = inner (next to divider), Lane 3 = outer. Left side mirrors them.
const LANE_CENTERS = [1.25, 3.75, 6.25]

// Dynamic road length: arms start at this minimum and GROW as vehicles queue.
const ROAD_END_MIN = 24
const ROAD_END_MARGIN = 2.4 // tarmac margin behind the last vehicle
const MAX_VEHICLES_PER_ROAD = 30 // safety cap (10 rows x 3 lanes per road)

// Zebra crosswalk band: exactly at the road/intersection boundary.
const ZEBRA_CENTER = HALF_INTER + 1.05 // stripe band centre
const ZEBRA_LENGTH = 1.8 // stripe length along the travel axis
const ZEBRA_STRIPE_W = 1.6 // stripes aligned with the lane centres (both sides)

// Thick solid stop line just behind the zebra crossing.
const STOP_LINE_CENTER = ZEBRA_CENTER + ZEBRA_LENGTH / 2 + 0.35
const STOP_LINE_THICK = 0.5
const STOP_LINE_W = 16

// Vehicles queue with their FRONT BUMPER at this distance (behind the line).
const STOP_BUMPER = STOP_LINE_CENTER + STOP_LINE_THICK / 2 + 0.85
const ROW_GAP = 1.3 // gap between successive rows of the 3-lane grid

// Driving dynamics (ONLY active while the post-optimize simulation runs).
// Vehicles accelerate from standstill with staggered, CALIBRATED launch
// delays so each road's queue clears in ~its allotted green time - the
// signal-discharge behaviour of a real junction.
const CRUISE_SPEED = 6.0 // units / second once at speed
const ACCEL_RATE = 2.0 // units / s^2 (gentle pull-away from the line)
const LAUNCH_MARGIN = 5.5 // s a launched row needs to cross the box
const MIN_ROW_HEADWAY = 0.75 // s minimum between row launches (dense traffic)
const VANISH_MARGIN = 2.0 // fully clear the far crosswalk, then disappear

const VEHICLE_SPECS = {
  car: { halfLen: 0.85, color: '#3b82f6' },
  bus: { halfLen: 1.5, color: '#facc15' },
  truck: { halfLen: 1.45, color: '#ef4444' },
  motorcycle: { halfLen: 0.55, color: '#22c55e' },
  auto: { halfLen: 0.7, color: '#fb923c' },
  ambulance: { halfLen: 1.15, color: '#f1f5f9' },
}

// Respawn order per road (emergency first). Insertion order is preserved for
// live additions so existing vehicles NEVER shuffle when new ones are added.
const DISPLAY_PRIORITY = ['ambulance', 'truck', 'bus', 'car', 'auto', 'motorcycle']

/* ---------- queue layout: rows of 3 lanes, right side only ---------- */

/**
 * Assigns every vehicle in `arr` (insertion order) a position:
 *   laneIdx = i % 3  ->  LANE_CENTERS[laneIdx] on the RIGHT side
 *   row    = i // 3  ->  rows stacked backwards from the stop line
 * The first row fills lane 1, 2, 3 side-by-side; the next row starts only
 * after all three lanes of the previous row are taken.
 * Returns the rear-most distance occupied by the queue.
 */
function applyGridLayout(arr) {
  let rowFront = STOP_BUMPER
  let rowRear = 0
  for (let i = 0; i < arr.length; i++) {
    const rt = arr[i]
    const laneIdx = i % 3
    if (laneIdx === 0) {
      if (i > 0) rowFront = rowRear + ROW_GAP
      rowRear = 0
    }
    rt.laneIdx = laneIdx
    rt.row = Math.floor(i / 3)
    rt.d = rowFront + rt.halfLen
    rt.d0 = rt.d // rest position (analytic motion computes d = d0 - distance)
    rowRear = Math.max(rowRear, rt.d + rt.halfLen)
    const [sx, sz] = RIGHT_SIGNS[rt.road]
    const lateral = LANE_CENTERS[laneIdx]
    rt.lx = sx * lateral
    rt.lz = sz * lateral
  }
  return rowRear
}

/**
 * Calibrates each road's discharge so the queue clears within its allotted
 * green time (real signal behaviour): the green duration T is read from the
 * quantum plan; row launches are spread evenly across (T - crossing time),
 * with a small lane stagger. Each vehicle also gets a reference to the
 * vehicle directly ahead in its lane for simple car-following.
 */
function planLaunches(road, arr) {
  if (!arr.length) return
  const T = useStore.getState()?.results?.quantum?.[road]
  const rows = Math.max(...arr.map((rt) => (rt.row || 0) + 1))
  let headway = 1.2 // fallback (no plan yet / idle)
  if (T && T > 0) {
    // last row launches at (rows-1)*headway and needs ~LAUNCH_MARGIN seconds
    // to cross -> it exits the box right around the end of its green window.
    headway = Math.max((T - LAUNCH_MARGIN) / Math.max(rows - 1, 1), MIN_ROW_HEADWAY)
  }
  arr.forEach((rt, i) => {
    rt.launchDelay = (rt.row || 0) * headway + rt.laneIdx * 0.15
    rt.leader = i >= 3 ? arr[i - 3] : null // vehicle ahead in the same lane
  })
}

// Desired roster per road (priority order) derived from the traffic counts.
function desiredList(traffic, road) {
  const list = []
  for (const type of DISPLAY_PRIORITY) {
    const n = traffic[road][type] || 0
    for (let k = 0; k < n; k++) list.push({ id: `${road}-${type}-${k}`, type })
  }
  return list.slice(0, MAX_VEHICLES_PER_ROAD)
}

// Road length needed for the current queues (drives the DYNAMIC road growth).
function computeRoadEnd(traffic) {
  let end = ROAD_END_MIN
  for (const road of ROADS) {
    const list = desiredList(traffic, road)
    const mock = list.map((des) => ({ ...des, road, halfLen: VEHICLE_SPECS[des.type].halfLen }))
    const rear = applyGridLayout(mock)
    end = Math.max(end, rear + ROAD_END_MARGIN)
  }
  return end
}

/* ================================================================== */
/* Static scenery                                                      */
/* ================================================================== */

function Ground() {
  // Plain solid dark ground - NO grid helper, NO neon floor.
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[150, 150]} />
      <meshStandardMaterial color={GROUND_COLOR} roughness={1} metalness={0} />
    </mesh>
  )
}

function ZebraCrossing({ road }) {
  const [dx, dz] = ROAD_DIRECTIONS[road]
  const alongX = dx !== 0
  // 6 stripes across the road, aligned with the lane centres (+/- 1.25, 3.75, 6.25)
  const stripes = [1.25, 3.75, 6.25, -1.25, -3.75, -6.25]
  return (
    <group>
      {stripes.map((lateral) => (
        <mesh
          key={lateral}
          position={
            alongX
              ? [dx * ZEBRA_CENTER, 0.06, lateral]
              : [lateral, 0.06, dz * ZEBRA_CENTER]
          }
        >
          <boxGeometry
            args={alongX ? [ZEBRA_LENGTH, 0.02, ZEBRA_STRIPE_W] : [ZEBRA_STRIPE_W, 0.02, ZEBRA_LENGTH]}
          />
          <meshStandardMaterial
            color="#ffffff"
            emissive="#ffffff"
            emissiveIntensity={0.5}
            roughness={0.85}
          />
        </mesh>
      ))}
    </group>
  )
}

function Road({ road, end }) {
  const [dx, dz] = ROAD_DIRECTIONS[road]
  const alongX = dx !== 0

  // Arm runs from |HALF_INTER| to the DYNAMIC end on its axis.
  const armLen = end - HALF_INTER
  const armCentre = HALF_INTER + armLen / 2

  // Centre divider curb runs from just behind the stop line to the road end.
  const divStart = STOP_LINE_CENTER + STOP_LINE_THICK / 2 + 0.05
  const divLen = end - divStart
  const divCentre = divStart + divLen / 2

  // Dashed lane-boundary lines at +/- 2.5 and +/- 5.0 (between the 3 lanes).
  const boundaries = [2.5, -2.5, 5.0, -5.0]
  const dashes = []
  for (let d = divStart + 1.1; d < end - 0.9; d += 1.9) dashes.push(d)

  return (
    <group>
      {/* wide highway arm (grows dynamically with the queue) */}
      <mesh
        position={alongX ? [dx * armCentre, 0.02, 0] : [0, 0.02, dz * armCentre]}
        receiveShadow
      >
        <boxGeometry args={alongX ? [armLen, 0.04, ROAD_WIDTH] : [ROAD_WIDTH, 0.04, armLen]} />
        <meshStandardMaterial color={ROAD_COLOR} roughness={0.95} />
      </mesh>

      {/* pedestrian zebra crossing at the intersection boundary */}
      <ZebraCrossing road={road} />

      {/* ONE thick solid white stop line just behind the zebra crossing */}
      <mesh
        position={
          alongX
            ? [dx * STOP_LINE_CENTER, 0.06, 0]
            : [0, 0.06, dz * STOP_LINE_CENTER]
        }
      >
        <boxGeometry
          args={
            alongX
              ? [STOP_LINE_THICK, 0.02, STOP_LINE_W]
              : [STOP_LINE_W, 0.02, STOP_LINE_THICK]
          }
        />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#dfe6ff"
          emissiveIntensity={0.4}
        />
      </mesh>

      {/* raised centre divider curb: right side = through traffic,
          left side = empty (reserved for left-turning traffic) */}
      <mesh
        position={
          alongX
            ? [dx * divCentre, 0.18, 0]
            : [0, 0.18, dz * divCentre]
        }
      >
        <boxGeometry args={alongX ? [divLen, 0.36, 0.7] : [0.7, 0.36, divLen]} />
        <meshStandardMaterial color="#2a2d33" roughness={0.9} metalness={0.1} />
      </mesh>

      {/* DASHED lane boundary lines (3 lanes per side, reference style) */}
      {boundaries.map((lateral) =>
        dashes.map((dist) => (
          <mesh
            key={`dash-${lateral}-${dist}`}
            position={
              alongX
                ? [dx * dist, 0.058, lateral]
                : [lateral, 0.058, dz * dist]
            }
          >
            <boxGeometry args={alongX ? [0.95, 0.02, 0.14] : [0.14, 0.02, 0.95]} />
            <meshStandardMaterial
              color="#dfe3f0"
              emissive="#aab4d8"
              emissiveIntensity={0.3}
              roughness={0.85}
            />
          </mesh>
        ))
      )}

      {/* SOLID WHITE EDGE LINES along the outer borders of the highway */}
      {[8.1, -8.1].map((lateral) => (
        <mesh
          key={`edge-${lateral}`}
          position={
            alongX
              ? [dx * divCentre, 0.058, lateral]
              : [lateral, 0.058, dz * divCentre]
          }
        >
          <boxGeometry args={alongX ? [divLen, 0.02, 0.16] : [0.16, 0.02, divLen]} />
          <meshStandardMaterial
            color="#cdd3e6"
            emissive="#99a3c8"
            emissiveIntensity={0.2}
            roughness={0.85}
          />
        </mesh>
      ))}
    </group>
  )
}

function IntersectionCenter() {
  return (
    <mesh position={[0, 0.045, 0]} receiveShadow>
      <boxGeometry args={[ROAD_WIDTH, 0.09, ROAD_WIDTH]} />
      <meshStandardMaterial color="#6e7276" roughness={0.92} metalness={0.05} />
    </mesh>
  )
}

function Cabin() {
  // Reference-style control cabin: dark charcoal body, white corner pillars,
  // light roof slab and steel-blue glowing window bands.
  const pillars = [
    [0.66, 0.66],
    [0.66, -0.66],
    [-0.66, 0.66],
    [-0.66, -0.66],
  ]
  return (
    <group>
      {/* dark body */}
      <mesh position={[0, 0.95, 0]}>
        <boxGeometry args={[1.5, 1.9, 1.5]} />
        <meshStandardMaterial color="#1b1b26" metalness={0.4} roughness={0.5} />
      </mesh>
      {/* white corner pillars */}
      {pillars.map(([x, z]) => (
        <mesh key={`${x}-${z}`} position={[x, 0.95, z]}>
          <boxGeometry args={[0.15, 2.0, 0.15]} />
          <meshStandardMaterial color="#d8d8dd" metalness={0.3} roughness={0.5} />
        </mesh>
      ))}
      {/* light roof slab */}
      <mesh position={[0, 2.0, 0]}>
        <boxGeometry args={[1.72, 0.13, 1.72]} />
        <meshStandardMaterial color="#cfd2da" metalness={0.35} roughness={0.45} />
      </mesh>
      {/* steel-blue glowing window bands (front + back) */}
      <mesh position={[0, 1.28, 0.76]}>
        <boxGeometry args={[1.05, 0.42, 0.02]} />
        <meshStandardMaterial color="#4f7dd9" emissive="#4f7dd9" emissiveIntensity={1.2} />
      </mesh>
      <mesh position={[0, 1.28, -0.76]}>
        <boxGeometry args={[1.05, 0.42, 0.02]} />
        <meshStandardMaterial color="#4f7dd9" emissive="#4f7dd9" emissiveIntensity={1.2} />
      </mesh>
      {/* antenna with beacon */}
      <mesh position={[0, 2.6, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.7, 8]} />
        <meshStandardMaterial color="#8888aa" metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh position={[0, 3.0, 0]}>
        <sphereGeometry args={[0.08, 12, 12]} />
        <meshStandardMaterial color="#bcd0ff" emissive="#9db8ff" emissiveIntensity={2} />
      </mesh>
      <pointLight position={[0, 3.2, 0]} intensity={1.8} distance={8} color="#9db8ff" />
    </group>
  )
}

/* ================================================================== */
/* Signal lights (compact heads close to the cabin)                    */
/* ================================================================== */

function SignalLamp({ color, emissive, position, active, radius = 0.22 }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[radius, 18, 18]} />
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={active ? 2.2 : 0.1}
      />
    </mesh>
  )
}

function SignalLight({ road }) {
  const state = useStore((s) => s.signalStates[road])
  const timer = useStore((s) => s.signalTimers[road])
  const [x, z] = SIGNAL_CORNERS[road]
  // Head FACES THE ROAD: rotate so the lamp side (+Z of the group) points
  // outward along this road's arm, straight at the waiting queue.
  const [dirX, dirZ] = ROAD_DIRECTIONS[road]
  const yaw = Math.atan2(dirX, dirZ)
  const active = state === 'green' || state === 'yellow'

  return (
    <group position={[x, 0, z]} rotation={[0, yaw, 0]}>
      {/* slim pole (compact, close to the cabin like the reference) */}
      <mesh position={[0, 1.7, 0]}>
        <cylinderGeometry args={[0.06, 0.09, 3.4, 12]} />
        <meshStandardMaterial color="#2f2f45" metalness={0.75} roughness={0.3} />
      </mesh>
      {/* pole base plate */}
      <mesh position={[0, 0.09, 0]}>
        <cylinderGeometry args={[0.22, 0.26, 0.18, 12]} />
        <meshStandardMaterial color="#23233a" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* dark backboard plate behind the three lamps */}
      <mesh position={[0, 2.55, -0.02]}>
        <boxGeometry args={[0.95, 2.2, 0.14]} />
        <meshStandardMaterial color="#0b0b16" metalness={0.4} roughness={0.6} />
      </mesh>
      {/* lamps, slightly in front of the backboard */}
      <SignalLamp color="#7a1220" emissive="#ff2233" position={[0, 3.2, 0.18]} active={state === 'red'} />
      <SignalLamp color="#7a5c00" emissive="#ffcc00" position={[0, 2.55, 0.18]} active={state === 'yellow'} />
      <SignalLamp color="#0c5c2a" emissive="#22ff66" position={[0, 1.9, 0.18]} active={state === 'green'} />

      {/* light spill onto the road while active */}
      {active && (
        <pointLight
          position={[0, 2.55, 0.8]}
          intensity={2.2}
          distance={7}
          color={state === 'green' ? '#22ff88' : '#ffcc44'}
        />
      )}

      {/* big countdown overlay: solid black background, large bold font.
          Shows ONLY the live countdown; hides itself when idle. */}
      {timer > 0 && (
        <Html position={[0, 4.35, 0]} center distanceFactor={12} zIndexRange={[20, 0]}>
          <div
            className={`signal-timer signal-timer--${state}`}
            style={{
              background: 'rgba(0, 0, 0, 0.8)',
              fontSize: '22px',
              fontWeight: 800,
              padding: '9px 18px',
            }}
          >
            <span className="st-dot" />
            {timer}s
          </div>
        </Html>
      )}
    </group>
  )
}

/* ================================================================== */
/* Left-turn "always green" corner indicators                          */
/* ================================================================== */

function LeftTurnIndicator({ corner }) {
  const matRef = useRef(null)
  useFrame(({ clock }) => {
    if (matRef.current) {
      matRef.current.emissiveIntensity = 1.5 + Math.sin(clock.elapsedTime * 3) * 0.7
    }
  })
  const [x, z] = corner
  return (
    <group position={[x * 0.87, 0.105, z * 0.87]} rotation={[-Math.PI / 2, 0, Math.atan2(z, x)]}>
      <mesh>
        <circleGeometry args={[0.42, 24]} />
        <meshStandardMaterial
          ref={matRef}
          color="#0f8f4d"
          emissive="#22ff88"
          emissiveIntensity={1.5}
          transparent
          opacity={0.95}
        />
      </mesh>
      <mesh position={[0.06, -0.04, 0.002]}>
        <planeGeometry args={[0.09, 0.34]} />
        <meshBasicMaterial color="#052213" />
      </mesh>
      <mesh position={[-0.07, 0.12, 0.002]}>
        <planeGeometry args={[0.22, 0.09]} />
        <meshBasicMaterial color="#052213" />
      </mesh>
      <mesh position={[0.1, 0.12, 0.002]} rotation={[0, 0, Math.PI / 4]}>
        <planeGeometry args={[0.09, 0.14]} />
        <meshBasicMaterial color="#052213" />
      </mesh>
    </group>
  )
}

/* ================================================================== */
/* Road labels (real 3D text, large, at the dynamic road ends)         */
/* ================================================================== */

function RoadLabel({ road, end }) {
  const [dx, dz] = ROAD_DIRECTIONS[road]
  const rotationY = dx > 0 ? Math.PI / 2 : dx < 0 ? -Math.PI / 2 : dz > 0 ? 0 : Math.PI
  return (
    <Float speed={2} rotationIntensity={0} floatIntensity={0.5}>
      <Text
        font={orbitronFont}
        position={[dx * (end + 2.6), 1.15, dz * (end + 2.6)]}
        rotation={[0, rotationY, 0]}
        fontSize={1.35}
        color="#00f0ff"
        outlineWidth={0.045}
        outlineColor="#005a66"
        anchorX="center"
        anchorY="middle"
      >
        ROAD {road}
      </Text>
    </Float>
  )
}

/* ================================================================== */
/* Low-poly vehicle models (bodies + cylindrical wheels)               */
/* ================================================================== */

function Wheel({ position, radius, width, registry, index }) {
  return (
    <group
      position={position}
      ref={(el) => {
        if (registry) registry.current[index] = el
      }}
    >
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[radius, radius, width, 10]} />
        <meshStandardMaterial color="#14141c" roughness={0.9} metalness={0.2} />
      </mesh>
    </group>
  )
}

function AmbulanceLightBar() {
  const matRef = useRef(null)
  useFrame(({ clock }) => {
    if (matRef.current) {
      matRef.current.emissiveIntensity = Math.sin(clock.elapsedTime * 9) > 0 ? 3.0 : 0.15
    }
  })
  return (
    <mesh position={[0, 1.12, 0]}>
      <boxGeometry args={[0.55, 0.13, 0.28]} />
      <meshStandardMaterial ref={matRef} color="#ff5566" emissive="#ff2233" emissiveIntensity={2} />
    </mesh>
  )
}

function VehicleModel({ type, wheelRegistry }) {
  const spec = VEHICLE_SPECS[type]

  if (type === 'car') {
    return (
      <group>
        <mesh position={[0, 0.43, 0]}>
          <boxGeometry args={[0.9, 0.42, 1.7]} />
          <meshStandardMaterial color={spec.color} metalness={0.35} roughness={0.45} />
        </mesh>
        <mesh position={[0, 0.79, 0.12]}>
          <boxGeometry args={[0.74, 0.34, 0.9]} />
          <meshStandardMaterial color="#1e3a8a" metalness={0.4} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.79, -0.35]}>
          <boxGeometry args={[0.62, 0.26, 0.06]} />
          <meshStandardMaterial color="#0a0a18" metalness={0.9} roughness={0.15} />
        </mesh>
        <Wheel position={[0.44, 0.17, -0.52]} radius={0.17} width={0.14} registry={wheelRegistry} index={0} />
        <Wheel position={[-0.44, 0.17, -0.52]} radius={0.17} width={0.14} registry={wheelRegistry} index={1} />
        <Wheel position={[0.44, 0.17, 0.52]} radius={0.17} width={0.14} registry={wheelRegistry} index={2} />
        <Wheel position={[-0.44, 0.17, 0.52]} radius={0.17} width={0.14} registry={wheelRegistry} index={3} />
      </group>
    )
  }

  if (type === 'bus') {
    return (
      <group>
        <mesh position={[0, 0.63, 0]}>
          <boxGeometry args={[1.0, 0.85, 3.0]} />
          <meshStandardMaterial color={spec.color} metalness={0.3} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.86, 0.15]}>
          <boxGeometry args={[1.04, 0.3, 2.2]} />
          <meshStandardMaterial color="#0a0a18" metalness={0.85} roughness={0.2} />
        </mesh>
        <mesh position={[0, 0.86, -1.51]}>
          <boxGeometry args={[0.86, 0.34, 0.06]} />
          <meshStandardMaterial color="#0a0a18" metalness={0.85} roughness={0.2} />
        </mesh>
        <Wheel position={[0.5, 0.2, -0.95]} radius={0.2} width={0.16} registry={wheelRegistry} index={0} />
        <Wheel position={[-0.5, 0.2, -0.95]} radius={0.2} width={0.16} registry={wheelRegistry} index={1} />
        <Wheel position={[0.5, 0.2, 1.05]} radius={0.2} width={0.16} registry={wheelRegistry} index={2} />
        <Wheel position={[-0.5, 0.2, 1.05]} radius={0.2} width={0.16} registry={wheelRegistry} index={3} />
      </group>
    )
  }

  if (type === 'truck') {
    return (
      <group>
        <mesh position={[0, 0.56, -0.95]}>
          <boxGeometry args={[0.95, 0.72, 0.95]} />
          <meshStandardMaterial color={spec.color} metalness={0.35} roughness={0.45} />
        </mesh>
        <mesh position={[0, 0.72, -1.43]}>
          <boxGeometry args={[0.78, 0.3, 0.06]} />
          <meshStandardMaterial color="#0a0a18" metalness={0.9} roughness={0.15} />
        </mesh>
        <mesh position={[0, 0.66, 0.5]}>
          <boxGeometry args={[1.05, 0.88, 1.85]} />
          <meshStandardMaterial color="#b91c1c" metalness={0.3} roughness={0.55} />
        </mesh>
        <Wheel position={[0.52, 0.2, -1.0]} radius={0.2} width={0.16} registry={wheelRegistry} index={0} />
        <Wheel position={[-0.52, 0.2, -1.0]} radius={0.2} width={0.16} registry={wheelRegistry} index={1} />
        <Wheel position={[0.52, 0.2, 0.9]} radius={0.2} width={0.16} registry={wheelRegistry} index={2} />
        <Wheel position={[-0.52, 0.2, 0.9]} radius={0.2} width={0.16} registry={wheelRegistry} index={3} />
      </group>
    )
  }

  if (type === 'motorcycle') {
    return (
      <group>
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[0.24, 0.16, 1.0]} />
          <meshStandardMaterial color={spec.color} metalness={0.4} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.72, -0.32]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.04, 0.04, 0.55, 8]} />
          <meshStandardMaterial color="#1f2937" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.62, 0.12]}>
          <boxGeometry args={[0.26, 0.08, 0.45]} />
          <meshStandardMaterial color="#111827" roughness={0.8} />
        </mesh>
        <Wheel position={[0, 0.25, -0.42]} radius={0.23} width={0.09} registry={wheelRegistry} index={0} />
        <Wheel position={[0, 0.25, 0.42]} radius={0.23} width={0.09} registry={wheelRegistry} index={1} />
      </group>
    )
  }

  if (type === 'auto') {
    return (
      <group>
        <mesh position={[0, 0.5, 0.05]}>
          <boxGeometry args={[0.85, 0.5, 1.35]} />
          <meshStandardMaterial color={spec.color} metalness={0.3} roughness={0.5} />
        </mesh>
        <mesh position={[0, 1.02, 0.1]}>
          <boxGeometry args={[0.95, 0.06, 1.45]} />
          <meshStandardMaterial color="#7c2d12" metalness={0.3} roughness={0.6} />
        </mesh>
        <mesh position={[0, 0.72, -0.68]}>
          <boxGeometry args={[0.6, 0.34, 0.06]} />
          <meshStandardMaterial color="#0a0a18" metalness={0.85} roughness={0.2} />
        </mesh>
        <Wheel position={[0, 0.18, -0.6]} radius={0.18} width={0.1} registry={wheelRegistry} index={0} />
        <Wheel position={[0.44, 0.18, 0.5]} radius={0.18} width={0.12} registry={wheelRegistry} index={1} />
        <Wheel position={[-0.44, 0.18, 0.5]} radius={0.18} width={0.12} registry={wheelRegistry} index={2} />
      </group>
    )
  }

  // ambulance: white van + red cross + flashing light bar
  return (
    <group>
      <mesh position={[0, 0.63, 0]}>
        <boxGeometry args={[1.0, 0.85, 2.3]} />
        <meshStandardMaterial color={spec.color} metalness={0.25} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.88, -1.16]}>
        <boxGeometry args={[0.84, 0.34, 0.06]} />
        <meshStandardMaterial color="#0a0a18" metalness={0.9} roughness={0.15} />
      </mesh>
      {[0.507, -0.507].map((x) => (
        <group key={x} position={[x, 0.66, 0.1]} rotation={[0, Math.PI / 2, 0]}>
          <mesh>
            <planeGeometry args={[0.56, 0.2]} />
            <meshStandardMaterial
              color="#dc2626"
              emissive="#dc2626"
              emissiveIntensity={0.45}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh>
            <planeGeometry args={[0.2, 0.56]} />
            <meshStandardMaterial
              color="#dc2626"
              emissive="#dc2626"
              emissiveIntensity={0.45}
              side={THREE.DoubleSide}
            />
          </mesh>
        </group>
      ))}
      <AmbulanceLightBar />
      <Wheel position={[0.5, 0.19, -0.75]} radius={0.19} width={0.15} registry={wheelRegistry} index={0} />
      <Wheel position={[-0.5, 0.19, -0.75]} radius={0.19} width={0.15} registry={wheelRegistry} index={1} />
      <Wheel position={[0.5, 0.19, 0.75]} radius={0.19} width={0.15} registry={wheelRegistry} index={2} />
      <Wheel position={[-0.5, 0.19, 0.75]} radius={0.19} width={0.15} registry={wheelRegistry} index={3} />
    </group>
  )
}

/* ================================================================== */
/* Vehicles: fully STATIC until the post-optimize simulation runs      */
/* ================================================================== */

function MovingVehicle({ rt }) {
  const wheelRegistry = useRef([])
  // The central animator (inside TrafficSimulator) drives this vehicle's
  // group + wheels through these refs - no per-vehicle useFrame needed.
  rt.wheels = wheelRegistry
  return (
    <group
      ref={(el) => {
        rt.group = el
      }}
      rotation={[0, rt.yaw, 0]}
    >
      <VehicleModel type={rt.type} wheelRegistry={wheelRegistry} />
    </group>
  )
}

function TrafficSimulator({ isSimulationRunning }) {
  const traffic = useStore((s) => s.traffic)
  const runtime = useRef({ A: [], B: [], C: [], D: [] })
  const [, setTick] = useState(0) // bump to re-render the roster
  const lastEpoch = useRef(0)
  const lastToken = useRef(0)

  // Desired roster per road (priority order) from the traffic counts.
  const desired = useMemo(() => {
    const out = {}
    for (const road of ROADS) out[road] = desiredList(traffic, road)
    return out
  }, [traffic])

  // (Re)build the whole runtime queue from the desired roster. Used on
  // resets and at the start of every simulation cycle (looped demo).
  const respawnAll = () => {
    for (const road of ROADS) {
      const [dx, dz] = ROAD_DIRECTIONS[road]
      runtime.current[road] = desired[road].map((des) => ({
        ...des,
        road,
        halfLen: VEHICLE_SPECS[des.type].halfLen,
        yaw: Math.atan2(dx, dz), // face the intersection
        d: 0,
        gone: false,
      }))
      applyGridLayout(runtime.current[road])
      planLaunches(road, runtime.current[road])
    }
    setTick((t) => t + 1)
  }

  /* Reconcile roster with traffic input in INSERTION ORDER:
     existing vehicles keep their slot (nothing ever shuffles or slides when
     a new vehicle is clicked), new vehicles are APPENDED and the grid layout
     simply extends backwards - filling lane 1, 2, 3 of the next free row. */
  useEffect(() => {
    for (const road of ROADS) {
      const arr = runtime.current[road]
      const keep = new Set(arr.map((rt) => rt.id))
      const [dx, dz] = ROAD_DIRECTIONS[road]

      // append newly added vehicles (stable, append-only order)
      for (const des of desired[road]) {
        if (keep.has(des.id)) continue
        if (arr.length >= MAX_VEHICLES_PER_ROAD) break
        arr.push({
          ...des,
          road,
          halfLen: VEHICLE_SPECS[des.type].halfLen,
          yaw: Math.atan2(dx, dz),
          d: 0,
          gone: false,
        })
      }
      // drop vehicles the user removed (only via Reset -> all at once)
      runtime.current[road] = arr.filter((rt) =>
        desired[road].some((x) => x.id === rt.id)
      )
      applyGridLayout(runtime.current[road])
      planLaunches(road, runtime.current[road])
    }
    setTick((t) => t + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desired])

  // Cycle bookkeeping + THE SINGLE CENTRAL ANIMATOR for every vehicle.
  // Positions are computed ANALYTICALLY from the wall clock: each vehicle's
  // distance travelled is a pure function of (now - greenStart), so the
  // queue clears in exactly the allotted green time regardless of render
  // frame-rate. Launch slots are calibrated by planLaunches() from the
  // quantum plan; a vehicle may only START while its road is green, and
  // once started it keeps clearing the box (yellow/red included).
  const lastGreen = useRef({ A: false, B: false, C: false, D: false })
  const greenStart = useRef({})

  useFrame(() => {
    const st = useStore.getState()

    // respawn triggers (new optimize run / new loop epoch)
    if (st.cycleToken !== lastToken.current) {
      lastToken.current = st.cycleToken
      if (st.simulationRunning) respawnAll()
    }
    if (st.cycleEpoch !== lastEpoch.current) {
      lastEpoch.current = st.cycleEpoch
      if (st.simulationRunning) respawnAll()
    }

    const running = st.simulationRunning
    const now = performance.now() / 1000
    const tAcc = CRUISE_SPEED / ACCEL_RATE // time to reach cruise speed

    for (const road of ROADS) {
      const arr = runtime.current[road]
      const signal = st.signalStates[road]
      const green = signal === 'green'

      // a fresh green phase stamps this road's wall-clock start
      if (green && !lastGreen.current[road]) {
        greenStart.current[road] = now
        for (const rt of arr) rt.started = false
      }
      lastGreen.current[road] = green

      const t0 = greenStart.current[road]
      const elapsed = t0 ? Math.max(0, now - t0) : 0

      for (let i = 0; i < arr.length; i++) {
        const rt = arr[i]
        if (!rt.group) continue

        if (rt.gone) {
          if (rt.group.visible) rt.group.visible = false
          continue
        }

        // launching is allowed only inside the green window, at the slot
        if (running && green && elapsed >= (rt.launchDelay || 0)) rt.started = true

        if (running && rt.started) {
          const tau = Math.max(0, elapsed - (rt.launchDelay || 0))
          // accelerate to cruise, then hold: s(tau) = a*tau^2/2 | V*tau - V^2/(2a)
          const s =
            tau < tAcc
              ? 0.5 * ACCEL_RATE * tau * tau
              : CRUISE_SPEED * tau - (CRUISE_SPEED * CRUISE_SPEED) / (2 * ACCEL_RATE)
          rt.v = Math.min(ACCEL_RATE * tau, CRUISE_SPEED)
          rt.d = rt.d0 - s

          // visual wheel spin for this frame
          const spin = (rt.v * (1 / 60)) / 0.2
          const wheels = rt.wheels?.current
          if (wheels) for (const w of wheels) if (w) w.rotation.x -= spin

          // fully past the intersection centre + far crosswalk -> disappear
          if (rt.d < -(HALF_INTER + rt.halfLen + VANISH_MARGIN)) {
            rt.gone = true
            rt.group.visible = false
            continue
          }
        }

        const [dx, dz] = ROAD_DIRECTIONS[road]
        rt.group.position.set(dx * rt.d + rt.lx, 0.02, dz * rt.d + rt.lz)
      }
    }
  })

  return (
    <group>
      {ROADS.flatMap((road) =>
        runtime.current[road].map((rt) => (
          <MovingVehicle key={rt.id} rt={rt} />
        ))
      )}
    </group>
  )
}

/* ================================================================== */
/* Scene + canvas                                                      */
/* ================================================================== */

function Scene({ isSimulationRunning, roadEnd }) {
  return (
    <group>
      <Ground />
      {ROADS.map((road) => (
        <React.Fragment key={road}>
          <Road road={road} end={roadEnd} />
          <RoadLabel road={road} end={roadEnd} />
          <SignalLight road={road} />
        </React.Fragment>
      ))}
      <IntersectionCenter />
      <Cabin />
      <TrafficSimulator isSimulationRunning={isSimulationRunning} />
      {[
        [8.5, 8.5],
        [-8.5, 8.5],
        [8.5, -8.5],
        [-8.5, -8.5],
      ].map(([x, z]) => (
        <LeftTurnIndicator key={`${x}-${z}`} corner={[x, z]} />
      ))}
    </group>
  )
}

export default function Junction3D({ isSimulationRunning = false }) {
  const traffic = useStore((s) => s.traffic)

  // DYNAMIC ROADS: the arms grow with the queues and retract when cleared.
  const roadEnd = useMemo(() => computeRoadEnd(traffic), [traffic])

  const toggleFullscreen = () => {
    const el = document.querySelector('.scene-wrap')
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else if (el.requestFullscreen) {
      el.requestFullscreen()
    }
  }

  return (
    <div className="scene-wrap">
      <Canvas
        camera={{ position: [26, 20, 26], fov: 50 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#0a0a1a']} />
        <fog attach="fog" args={['#0a0a1a', 55, 115]} />
        <ambientLight intensity={0.5} />
        <directionalLight position={[18, 28, 14]} intensity={0.75} color="#cfd8ff" />
        <directionalLight position={[-16, 14, -18]} intensity={0.3} color="#7b2ff7" />
        <pointLight position={[0, 9, 0]} intensity={0.5} color="#7b2ff7" />

        <Scene isSimulationRunning={isSimulationRunning} roadEnd={roadEnd} />

        <OrbitControls
          target={[0, 0, 0]}
          maxPolarAngle={Math.PI * 0.44} /* ~80 degrees */
          minDistance={8}
          maxDistance={58}
          enableDamping
          dampingFactor={0.08}
        />
      </Canvas>
      <div className="leftturn-badge">← LEFT TURN: Always Green</div>
      <div className="scene-hint">drag to orbit · scroll to zoom</div>
      <button className="scene-fullscreen" onClick={toggleFullscreen} title="Toggle fullscreen">
        ⛶ Fullscreen
      </button>
    </div>
  )
}
