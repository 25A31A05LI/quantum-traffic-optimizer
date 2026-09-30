import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

const METHODS = [
  {
    key: 'normal',
    title: '🔴 Normal (No Optimization)',
    subtitle: 'Fixed equal split',
    cls: 'card-normal',
    bar: '#ff4455',
  },
  {
    key: 'ai',
    title: '🟡 AI Optimized',
    subtitle: 'Weighted proportional',
    cls: 'card-ai',
    bar: '#fbbf24',
  },
  {
    key: 'quantum',
    title: '🟢 Quantum Optimized (QAOA)',
    subtitle: 'Real Qiskit QAOA circuit',
    cls: 'card-quantum',
    bar: '#22ff88',
  },
]

const ROAD_KEYS = ['A', 'B', 'C', 'D']

function MethodCard({ method, times, metrics, totalCycle }) {
  return (
    <div className={`result-card ${method.cls}`}>
      <h4 className="result-card__title">{method.title}</h4>
      <p className="result-card__subtitle">{method.subtitle}</p>

      <div className="green-list">
        {ROAD_KEYS.map((road) => {
          const secs = times[road]
          const pct = (secs / totalCycle) * 100
          return (
            <div key={road} className="green-row">
              <span className="green-row__road">Road {road}</span>
              <div className="green-row__barwrap">
                <div
                  className="green-row__bar"
                  style={{ width: `${pct}%`, background: method.bar }}
                />
              </div>
              <span className="green-row__secs">
                {secs}s <span className="pct">({pct.toFixed(0)}%)</span>
              </span>
            </div>
          )
        })}
      </div>

      <div className="result-card__metrics">
        <div className="metric">
          <span className="metric__label">⏳ Est. wait / cycle</span>
          <span className="metric__value">{metrics.total_estimated_wait.toFixed(1)}s</span>
        </div>
        <div className="metric">
          <span className="metric__label">⚡ Throughput score</span>
          <span className="metric__value">{metrics.throughput_score.toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Collapsible point-wise reasoning sections                           */
/* ------------------------------------------------------------------ */

const ACC_SECTIONS = [
  {
    key: 'normal',
    field: 'reasons_normal',
    title: 'Normal (No Optimization)',
    icon: '🔴',
    variant: 'normal',
    bullet: '✖',
  },
  {
    key: 'ai',
    field: 'reasons_ai',
    title: 'AI Optimized',
    icon: '🟡',
    variant: 'ai',
    bullet: '✔',
  },
  {
    key: 'quantum',
    field: 'reasons_quantum',
    title: 'Quantum (QAOA)',
    icon: '🟢',
    variant: 'quantum',
    bullet: '✔',
  },
]

function AccordionSection({ title, icon, points, variant, bullet, open, onToggle }) {
  const bodyRef = useRef(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const measure = () => setHeight(open ? bodyRef.current?.scrollHeight || 0 : 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, points])

  return (
    <div className={`acc acc--${variant}${open ? ' acc--open' : ''}`}>
      <button className="acc-header" onClick={onToggle} aria-expanded={open}>
        <span className="acc-icon">{icon}</span>
        <span className="acc-title">{title}</span>
        <span className="acc-count">{points.length} insights</span>
        <span className={`acc-chevron${open ? ' acc-chevron--open' : ''}`}>▾</span>
      </button>
      <div className="acc-body" ref={bodyRef} style={{ maxHeight: height }}>
        <ul className="acc-list">
          {points.map((p, i) => (
            <li key={i} className={`acc-point acc-point--${variant}`}>
              <span className={`acc-bullet acc-bullet--${variant}`}>{bullet}</span>
              <span className="acc-text">{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default function ResultsPanel() {
  const results = useStore((s) => s.results)
  const [openSections, setOpenSections] = useState({ normal: false, ai: false, quantum: true })

  if (!results) return null

  const { normal, ai, quantum, reasoning, metrics, total_cycle: totalCycle } = results

  // Prefer the point-wise arrays; fall back to splitting the paragraph text
  // (line by line) if the backend ever returns only `reasoning`.
  const pointsFor = (section) => {
    const arr = results[section.field]
    if (Array.isArray(arr) && arr.length > 0) return arr
    const text = reasoning?.[section.key] || ''
    return text.split('\n').map((l) => l.trim()).filter(Boolean)
  }

  const toggle = (key) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))

  return (
    <section className="results-wrap">
      <div className="glass">
        <h3 className="section-title">📈 OPTIMIZATION RESULTS COMPARISON</h3>
        <div className="results-grid">
          <MethodCard method={METHODS[0]} times={normal} metrics={metrics.normal} totalCycle={totalCycle} />
          <MethodCard method={METHODS[1]} times={ai} metrics={metrics.ai} totalCycle={totalCycle} />
          <MethodCard method={METHODS[2]} times={quantum} metrics={metrics.quantum} totalCycle={totalCycle} />
        </div>
      </div>

      <div className="glass">
        <h3 className="section-title">🧠 WHY THESE TIMINGS? (Reasoning)</h3>
        <p className="reasoning-hint">Tap a header to expand / collapse the explanation points.</p>
        <div className="reasoning-accordion">
          {ACC_SECTIONS.map((section) => (
            <AccordionSection
              key={section.key}
              title={section.title}
              icon={section.icon}
              variant={section.variant}
              bullet={section.bullet}
              points={pointsFor(section)}
              open={openSections[section.key]}
              onToggle={() => toggle(section.key)}
            />
          ))}
        </div>
      </div>
    </section>
  )
}
