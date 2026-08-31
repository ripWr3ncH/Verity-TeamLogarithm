'use client';

/**
 * VERITY — the rescheduling pattern, drawn rather than tabulated.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE TABLE BESIDE THIS IS CORRECT AND ILLEGIBLE.
 *
 *  "RS-1, 12 days. RS-2, 11 days. RS-3, 15 days. RS-4, 23 days." A banker
 *  reads that instantly. Everyone else sees a spreadsheet.
 *
 *  The thing being detected is temporal: reschedulings landing just before
 *  the statutory reference date, quarter after quarter. Rendering time as a
 *  column of numbers throws away the one dimension that carries the meaning.
 *  Drawn, the clustering is the picture — you do not have to be told.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * NO NEW DATA AND NO NEW CLAIM. Every value here is already on the page:
 * `classificationRefDate` and `daysToNextRefDate` per committed event, which
 * are d_j in equation (1) of §3.7.1. This only draws them.
 *
 * Deliberately NOT a chart library. A dependency for six circles and four
 * lines would be a worse trade than the SVG below, and inline SVG inherits the
 * theme tokens rather than fighting them.
 */

import type { LifecycleEvent } from '@/lib/api';

/** Inside this many days of a reference date, an event is drawn as clustered. */
const NEAR_DAYS = 30;

interface Props {
  events: LifecycleEvent[];
  /** Council-set alert threshold, only used to colour the closing marker. */
  eStar?: number;
}

export function ReschedulingTimeline({ events }: Props): React.ReactNode {
  const reschedules = events
    .filter((e) => e.type === 'RESCHEDULE' && e.classificationRefDate)
    .sort((a, b) => a.classificationRefDate.localeCompare(b.classificationRefDate));

  if (reschedules.length === 0) return null;

  // One column per reference date the exposure actually touched. The axis is
  // the statutory quarterly calendar, not a continuous time axis: what matters
  // is the distance to each period end, and evenly spaced columns make four
  // near-misses in four consecutive quarters read as a rhythm.
  const cols = reschedules.map((e) => ({
    ref: e.classificationRefDate.slice(0, 10),
    days: e.daysToNextRefDate,
    rs: e.rsSeq,
    near: e.daysToNextRefDate <= NEAR_DAYS,
  }));

  const W = 720;
  const H = 132;
  const padX = 46;
  const baseY = 84;
  const step = cols.length > 1 ? (W - padX * 2) / (cols.length - 1) : 0;
  const x = (i: number) => padX + i * step;

  // Vertical offset encodes proximity: the closer to the reference date, the
  // higher the dot sits above the axis. 0 days would sit at the top.
  const y = (days: number) => {
    const clamped = Math.max(0, Math.min(days, 90));
    return baseY - 46 * (1 - clamped / 90);
  };

  const nearCount = cols.filter((c) => c.near).length;

  return (
    <div className="card" style={{ marginTop: '1rem' }}>
      <h3 style={{ marginBottom: '.2rem' }}>When the reschedulings happened</h3>
      <p style={{ fontSize: '.87rem', color: 'var(--ink-2)', margin: '0 0 .6rem' }}>
        Each marker is one committed rescheduling, placed by how many days before the statutory
        quarter-end it fell. Higher means closer to the reference date.
      </p>

      <div className="scroller">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`${cols.length} reschedulings, ${nearCount} of them within ${NEAR_DAYS} days of a quarter-end`}
          style={{ display: 'block', minWidth: 480 }}
        >
          {/* The band inside which an event counts as clustered near period end. */}
          <rect
            x={padX - 22}
            y={y(NEAR_DAYS)}
            width={W - padX * 2 + 44}
            height={baseY - y(NEAR_DAYS)}
            fill="var(--amber-wash, rgba(138,97,0,.07))"
          />
          <text x={padX - 22} y={y(NEAR_DAYS) - 6} fontSize="11" fill="var(--amber, #8a6100)">
            within {NEAR_DAYS} days of quarter-end
          </text>

          {/* The statutory calendar. */}
          <line
            x1={padX - 22}
            y1={baseY}
            x2={W - padX + 22}
            y2={baseY}
            stroke="var(--rule, #d8d6cd)"
            strokeWidth="1.5"
          />

          {cols.map((c, i) => {
            const cx = x(i);
            const cy = y(c.days);
            const colour = c.near ? 'var(--coral, #c7382b)' : 'var(--ink-2, #555)';
            return (
              <g key={`${c.ref}-${c.rs}`}>
                {/* Quarter-end tick and its date. */}
                <line
                  x1={cx}
                  y1={baseY - 5}
                  x2={cx}
                  y2={baseY + 5}
                  stroke="var(--ink-2, #555)"
                  strokeWidth="1.5"
                />
                <text x={cx} y={baseY + 20} fontSize="10.5" textAnchor="middle" fill="var(--ink-2, #555)">
                  {c.ref}
                </text>

                {/* Drop line from the axis to the event. */}
                <line x1={cx} y1={baseY} x2={cx} y2={cy} stroke={colour} strokeWidth="1.5" />
                <circle cx={cx} cy={cy} r="7" fill={colour} />
                <text x={cx} y={cy - 12} fontSize="11" textAnchor="middle" fill={colour} fontWeight="600">
                  RS-{c.rs}
                </text>
                <text x={cx} y={cy + 4} fontSize="9" textAnchor="middle" fill="#fff" fontWeight="700">
                  {c.days}
                </text>
              </g>
            );
          })}

          <text x={padX - 22} y={baseY + 38} fontSize="10.5" fill="var(--ink-2, #555)">
            statutory classification reference dates
          </text>
        </svg>
      </div>

      <p className="hint">
        {nearCount} of {cols.length} fell within {NEAR_DAYS} days of a reference date.{' '}
        <strong>Clustering is not proof of anything on its own</strong> — ordinary forbearance
        clusters near period-end too, which is why the threshold is set against the measured base
        rate rather than against zero.
      </p>
    </div>
  );
}
