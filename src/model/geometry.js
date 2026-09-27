// Anchor resolution and orthogonal arrow routing.

import { WORK, FRAME, HEADER_H, FOOTER_H, STUB } from './types.js';
import { findBox } from './model.js';
import { textWidth } from '../util.js';

const OUTWARD = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** Resolve an endpoint to a point plus the outward normal of its surface. */
export function anchorOf(diagram, endpoint) {
  if (endpoint.type === 'boundary') return boundaryAnchor(endpoint.side, endpoint.pos);
  const [nx, ny] = OUTWARD[endpoint.side] || [1, 0];
  const box = findBox(diagram, endpoint.boxId);
  if (!box) return { x: WORK.x, y: WORK.y, nx, ny, boundary: false, ok: false };
  const p = clamp01(endpoint.pos);
  const pt = endpoint.side === 'left' ? { x: box.x, y: box.y + p * box.h }
    : endpoint.side === 'right' ? { x: box.x + box.w, y: box.y + p * box.h }
    : endpoint.side === 'top' ? { x: box.x + p * box.w, y: box.y }
    : { x: box.x + p * box.w, y: box.y + box.h };
  return { ...pt, nx, ny, boundary: false, ok: true };
}

const clamp01 = (v) => (v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v);

/** A boundary anchor sits on the drawing-area edge; "outward" points off-sheet. */
function boundaryAnchor(side, pos) {
  const [nx, ny] = OUTWARD[side] || [1, 0];
  const p = clamp01(pos);
  const pt = side === 'left' ? { x: WORK.x, y: WORK.y + p * WORK.h }
    : side === 'right' ? { x: WORK.x2, y: WORK.y + p * WORK.h }
    : side === 'top' ? { x: WORK.x + p * WORK.w, y: WORK.y }
    : { x: WORK.x + p * WORK.w, y: WORK.y2 };
  return { ...pt, nx, ny, boundary: true, ok: true };
}

/** How far a port's stub reaches into the drawing area from the sheet edge. */
const PORT_STUB = 26;

/**
 * `portShape(port)` — where a port (see model.js `ports`) is drawn: `edge` is
 * the anchor of its boundary endpoint (side, pos) on the drawing-area edge,
 * `inner` the point `PORT_STUB` units inward from it, where the open circle
 * sits. The same arithmetic, in the same order, as Geometry.swift.
 */
export function portShape(port) {
  const a = boundaryAnchor(port.side, port.pos);
  return {
    edge: { x: a.x, y: a.y },
    inner: { x: a.x - a.nx * PORT_STUB, y: a.y - a.ny * PORT_STUB },
  };
}

/** Position 0..1 along `side` of a rect for an arbitrary point. */
export function posOnSide(rect, side, pt) {
  const v = side === 'left' || side === 'right'
    ? (pt.y - rect.y) / rect.h
    : (pt.x - rect.x) / rect.w;
  return clamp01(v);
}

/** Nearest side of a rect to a point, with the hit position along it. */
export function nearestSide(rect, pt) {
  const d = {
    left: Math.abs(pt.x - rect.x),
    right: Math.abs(pt.x - (rect.x + rect.w)),
    top: Math.abs(pt.y - rect.y),
    bottom: Math.abs(pt.y - (rect.y + rect.h)),
  };
  const side = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
  return { side, pos: posOnSide(rect, side, pt) };
}

/* ------------------------------------------------------- shared end tests */

// How far a routed run stands off a box it has to get around.
const LANE_GAP = 26;
// A boundary source held out into this margin (between the frame and the
// drawing area) rather than looping under/over the box it nearly touches.
const BOUNDARY_MARGIN = 16;

const FRAME_X_LO = FRAME.x + 4, FRAME_X_HI = FRAME.x + FRAME.w - 4;
const FRAME_Y_LO = FRAME.y + HEADER_H + 4, FRAME_Y_HI = FRAME.y + FRAME.h - FOOTER_H - 4;

/** Keep a routed stub point off the frame border and the header/footer bands. */
function clampFrame(p) {
  return {
    x: Math.min(Math.max(p.x, FRAME_X_LO), FRAME_X_HI),
    y: Math.min(Math.max(p.y, FRAME_Y_LO), FRAME_Y_HI),
  };
}

/**
 * The stub point stub units out from anchor `p` (whose outward normal is
 * (nx, ny)) on the side the arrow actually runs — outside a box, but inside
 * the drawing area for the sheet boundary (an arrow never leaves the sheet).
 */
function stubPoint(p, stub, f) {
  return { x: p.x + p.nx * stub * f, y: p.y + p.ny * stub * f };
}

/**
 * Whether `a`'s route runs "feedback" — against the left-to-right reading
 * order, doubling back to a box already passed. FIPS 183 §3.3.3 rule 12 gives
 * these a fixed shape (§3.3.3 rule 12), which is also what keeps the arrow
 * clear of the boxes lying between the two ends. Only a real box output can
 * be a feedback source: a boundary anchor has nothing behind it to double
 * back over (see the degenerate case in routePoints).
 */
function feedbackLike(a, b, s0, s1) {
  const h0 = a.nx !== 0;
  return h0 && a.nx * (a.boundary ? -1 : 1) > 0 && !b.boundary && s1.x < s0.x - 1;
}

/**
 * `bendAxis(a, b, stub)` — the axis a route's middle run could be dragged
 * along, or null when the route has no visible bend to grab: a feedback (its
 * shape is fixed), or ends whose runs already point straight at each other.
 * Shares the feedback test with routePoints so the two never disagree about
 * what counts as feedback.
 */
export function bendAxis(a, b, stub = STUB) {
  const f0 = a.boundary ? -1 : 1;
  const f1 = b.boundary ? -1 : 1;
  const s0 = stubPoint(a, stub, f0);
  const s1 = stubPoint(b, stub, f1);
  const h0 = a.nx !== 0;
  const h1 = b.nx !== 0;
  if (feedbackLike(a, b, s0, s1) && !a.boundary) return null;
  if (h0 && h1) return Math.abs(s0.y - s1.y) > 0.5 ? 'x' : null;
  if (!h0 && !h1) return Math.abs(s0.x - s1.x) > 0.5 ? 'y' : null;
  return null;
}

/** The first obstacle whose face the anchor sits flush against — the box an
 *  L-shaped route is entering, so a corner can be routed clear of it. */
function targetRect(b, obstacles) {
  if (b.boundary) return null;
  if (b.nx !== 0) {
    for (const bx of obstacles) {
      const edge = b.nx < 0 ? bx.x : bx.x + bx.w;
      if (Math.abs(edge - b.x) < 0.01 && bx.y <= b.y && b.y <= bx.y + bx.h) return bx;
    }
  } else {
    for (const bx of obstacles) {
      const edge = b.ny < 0 ? bx.y : bx.y + bx.h;
      if (Math.abs(edge - b.y) < 0.01 && bx.x <= b.x && b.x <= bx.x + bx.w) return bx;
    }
  }
  return null;
}

const inWorkX = (v) => v > WORK.x + 4 && v < WORK.x2 - 4;
const inWorkY = (v) => v > WORK.y + 4 && v < WORK.y2 - 4;

/**
 * Rectilinear route between two anchors. Both ends leave/enter perpendicular
 * to their surface, which is what makes IDEF0 arrows read correctly.
 * `bend` optionally pins the position of the middle run. `laneOffset` shifts
 * a non-feedback middle run sideways (before it is cleared of boxes) so
 * parallel arrows between the same faces do not draw on top of one another —
 * see `routeArrow`, which supplies it; a direct call defaults to unoffset.
 */
export function routePoints(a, b, bend = null, obstacles = [], laneOffset = 0) {
  const p0 = { x: a.x, y: a.y };
  const p1 = { x: b.x, y: b.y };
  const f0 = a.boundary ? -1 : 1;
  const f1 = b.boundary ? -1 : 1;
  const h0 = a.nx !== 0;
  const h1 = b.nx !== 0;

  // Ends that face each other across a gap of less than two stub-lengths:
  // reach only the midline between them, not the box beyond it. This also
  // keeps two boxes placed close together from being misread as a feedback
  // below (a short forward gap and a reversed one are never both possible).
  let facing = false, g = 0;
  if (h0 === h1) {
    const d0 = (h0 ? a.nx : a.ny) * f0;
    const d1 = (h1 ? b.nx : b.ny) * f1;
    g = (h0 ? b.x - a.x : b.y - a.y) * d0;
    facing = d0 === -d1 && g > 0 && g < 2 * STUB;
  }

  let s0, s1, feedback, skipClearance;
  if (facing) {
    s0 = stubPoint(a, g / 2, f0);
    s1 = stubPoint(b, g / 2, f1);
    feedback = false;
    skipClearance = true;
  } else {
    s0 = stubPoint(a, STUB, f0);
    s1 = stubPoint(b, STUB, f1);
    const wouldBeFeedback = feedbackLike(a, b, s0, s1);
    feedback = wouldBeFeedback && !a.boundary;
    skipClearance = false;
    if (wouldBeFeedback && a.boundary) {
      // The source has nothing behind it to double back over: stand off
      // into the drawing margin instead of looping under/over the box, or
      // through it, the way the ordinary lanes would.
      s0 = { x: a.x + a.nx * BOUNDARY_MARGIN, y: a.y + a.ny * BOUNDARY_MARGIN };
      skipClearance = true;
    }
  }
  s0 = clampFrame(s0);
  s1 = clampFrame(s1);

  const mids = [];

  if (feedback) {
    const overTop = !h1 && b.ny < 0;
    const lane = overTop
      ? Math.max(laneAboveRaw(obstacles, s0.x, s1.x, Math.min(s0.y, s1.y)) + laneOffset, WORK.y + 6)
      : Math.min(laneBelowRaw(obstacles, s0.x, s1.x, Math.max(s0.y, s1.y)) + laneOffset, WORK.y2 - 6);
    mids.push({ x: s0.x, y: lane }, { x: s1.x, y: lane });
  } else if (h0 && h1) {
    const mx = bend ?? (skipClearance
      ? (s0.x + s1.x) / 2
      : clearVertical(obstacles, (s0.x + s1.x) / 2 + laneOffset, s0.y, s1.y));
    if (Math.abs(s0.y - s1.y) > 0.5) { mids.push({ x: mx, y: s0.y }, { x: mx, y: s1.y }); }
  } else if (!h0 && !h1) {
    const my = bend ?? (skipClearance
      ? (s0.y + s1.y) / 2
      : clearHorizontal(obstacles, (s0.y + s1.y) / 2 + laneOffset, s0.x, s1.x));
    if (Math.abs(s0.x - s1.x) > 0.5) { mids.push({ x: s0.x, y: my }, { x: s1.x, y: my }); }
  } else if (h0 && !h1) {
    // A single corner at (s1.x, s0.y) can send the run through the target
    // box when the corner sits on the box side of the face it is entering.
    // Route a Z with a lane beside the box instead, unless this route was
    // already sent around the box some other way above.
    let z = null;
    if (!skipClearance) {
      const t = targetRect(b, obstacles);
      if (t && (s0.y - b.y) * b.ny < 0) {
        let xc = s0.x < t.x ? t.x - LANE_GAP : t.x + t.w + LANE_GAP;
        if (!inWorkX(xc)) xc = s0.x < t.x ? t.x + t.w + LANE_GAP : t.x - LANE_GAP;
        z = xc;
      }
    }
    if (z !== null) { mids.push({ x: z, y: s0.y }, { x: z, y: s1.y }); } else { mids.push({ x: s1.x, y: s0.y }); }
  } else {
    let z = null;
    if (!skipClearance) {
      const t = targetRect(b, obstacles);
      if (t && (s0.x - b.x) * b.nx < 0) {
        let yc = s0.y < t.y ? t.y - LANE_GAP : t.y + t.h + LANE_GAP;
        if (!inWorkY(yc)) yc = s0.y < t.y ? t.y + t.h + LANE_GAP : t.y - LANE_GAP;
        z = yc;
      }
    }
    if (z !== null) { mids.push({ x: s0.x, y: z }, { x: s1.x, y: z }); } else { mids.push({ x: s0.x, y: s1.y }); }
  }

  return simplify([p0, s0, ...mids, s1, p1]);
}

/**
 * `routeArrow(diagram, arrow)` — an arrow's route, offsetting its middle run
 * away from any other unpinned arrow that runs between the same pair of
 * faces (excluding one it forks or joins with, sharing an end anchor), so
 * parallel arrows read as separate lines rather than one drawn on top of
 * another. Every renderer and hit-test in both apps routes through this
 * (not routePoints) so what is drawn is what is clickable.
 */
export function routeArrow(diagram, arrow) {
  const obstacles = diagram.boxes.map(rectOf);
  const a = anchorOf(diagram, arrow.from);
  const b = anchorOf(diagram, arrow.to);
  // A pinned bend, and a preview of an arrow not yet in the diagram (nothing
  // to group it against), route with no lane offset.
  if (arrow.bend != null || !diagram.arrows.includes(arrow)) return routePoints(a, b, arrow.bend ?? null, obstacles);
  const offset = laneOffsetOf(diagram, arrow, a, b, obstacles);
  return routePoints(a, b, null, obstacles, offset);
}

/** A run's grouping key: same orientation, same coordinate (within a unit),
 *  overlapping extent along the run. Only plain H-H, V-V and feedback runs —
 *  the ones a fixed lane offset actually separates — are grouped. */
function runOf(a, b, obstacles) {
  const h0 = a.nx !== 0, h1 = b.nx !== 0;
  const f0 = a.boundary ? -1 : 1, f1 = b.boundary ? -1 : 1;
  let facing = false, g = 0;
  if (h0 === h1) {
    const d0 = (h0 ? a.nx : a.ny) * f0;
    const d1 = (h1 ? b.nx : b.ny) * f1;
    g = (h0 ? b.x - a.x : b.y - a.y) * d0;
    facing = d0 === -d1 && g > 0 && g < 2 * STUB;
  }
  if (facing) return null;
  const s0 = stubPoint(a, STUB, f0);
  const s1 = stubPoint(b, STUB, f1);
  const wouldBeFeedback = feedbackLike(a, b, s0, s1);
  if (wouldBeFeedback && a.boundary) return null;
  if (wouldBeFeedback) {
    const overTop = !h1 && b.ny < 0;
    const coord = overTop ? laneAboveRaw(obstacles, s0.x, s1.x, Math.min(s0.y, s1.y))
      : laneBelowRaw(obstacles, s0.x, s1.x, Math.max(s0.y, s1.y));
    return { kind: 'fb', coord, lo: Math.min(s0.x, s1.x), hi: Math.max(s0.x, s1.x), heading: s1.x - s0.x, key: a.y };
  }
  if (h0 && h1) {
    if (Math.abs(s0.y - s1.y) <= 0.5) return null;
    const coord = clearVertical(obstacles, (s0.x + s1.x) / 2, s0.y, s1.y);
    return { kind: 'hh', coord, lo: Math.min(s0.y, s1.y), hi: Math.max(s0.y, s1.y), heading: s1.y - s0.y, key: a.y };
  }
  if (!h0 && !h1) {
    if (Math.abs(s0.x - s1.x) <= 0.5) return null;
    const coord = clearHorizontal(obstacles, (s0.y + s1.y) / 2, s0.x, s1.x);
    return { kind: 'vv', coord, lo: Math.min(s0.x, s1.x), hi: Math.max(s0.x, s1.x), heading: s1.x - s0.x, key: a.x };
  }
  return null;
}

const sameEnd = (x, y) => x.type === y.type && x.side === y.side && x.pos === y.pos
  && (x.type !== 'box' || x.boxId === y.boxId);

/** Whether two arrows fork or join — share the anchor at one end — and so are
 *  meant to be drawn overlapping rather than spread into separate lanes. */
function sharesEndpoint(p, q) {
  return sameEnd(p.from, q.from) || sameEnd(p.from, q.to) || sameEnd(p.to, q.from) || sameEnd(p.to, q.to);
}

/** Whether two runs are close enough, and overlap enough, to be spread apart. */
function runsCollide(p, q) {
  if (p.kind !== q.kind) return false;
  if (Math.abs(p.coord - q.coord) >= 1) return false;
  return p.lo < q.hi && q.lo < p.hi;
}

/**
 * Every unpinned arrow's lane offset. Two arrows "collide" when their default
 * routes run parallel, at the same coordinate, with overlapping extent, and
 * they do not fork or join (share an end anchor). Colliding is transitive —
 * three arrows that pairwise overlap share one group even if a forking pair
 * among them is not itself spread apart — so the group, and every member's
 * offset within it, comes out the same no matter which member asks.
 */
function laneOffsetOf(diagram, arrow, a, b, obstacles) {
  const arrows = diagram.arrows;
  const i = arrows.indexOf(arrow);
  const runs = arrows.map((ar, j) => {
    if (ar.bend != null) return null;
    const pa = j === i ? a : anchorOf(diagram, ar.from);
    const pb = j === i ? b : anchorOf(diagram, ar.to);
    return runOf(pa, pb, obstacles);
  });
  if (i < 0 || !runs[i]) return 0;
  // Breadth-first over the (symmetric) collision graph, so the group is the
  // same connected component regardless of which member it is computed from.
  const seen = new Set([i]);
  const queue = [i];
  while (queue.length) {
    const cur = queue.shift();
    for (let j = 0; j < arrows.length; j += 1) {
      if (seen.has(j) || !runs[j] || !runsCollide(runs[cur], runs[j])) continue;
      if (sharesEndpoint(arrows[cur], arrows[j])) continue;
      seen.add(j);
      queue.push(j);
    }
  }
  const group = [...seen];
  if (group.length < 2) return 0;
  group.sort((x, y) => runs[x].key - runs[y].key || x - y);
  const heading = runs[group[0]].heading;
  const ordered = heading >= 0 ? [...group].reverse() : group;
  const n = ordered.length;
  const k = ordered.indexOf(i);
  return (k - (n - 1) / 2) * 8;
}

/* ------------------------------------------------- keeping clear of boxes */

const spansX = (bx, x0, x1) =>
  bx.x + bx.w > Math.min(x0, x1) - 1 && bx.x < Math.max(x0, x1) + 1;
const spansY = (bx, y0, y1) =>
  bx.y + bx.h > Math.min(y0, y1) - 1 && bx.y < Math.max(y0, y1) + 1;

/** A y below every box between x0 and x1 — the "under" lane of a feedback,
 *  before it is offset and clamped into the drawing area. */
function laneBelowRaw(obstacles, x0, x1, floor) {
  let y = floor;
  for (const bx of obstacles) if (spansX(bx, x0, x1)) y = Math.max(y, bx.y + bx.h);
  return y + LANE_GAP;
}

/** A y above every box between x0 and x1 — the "over" lane of a feedback,
 *  before it is offset and clamped into the drawing area. */
function laneAboveRaw(obstacles, x0, x1, ceil) {
  let y = ceil;
  for (const bx of obstacles) if (spansX(bx, x0, x1)) y = Math.min(y, bx.y);
  return y - LANE_GAP;
}

/** Shift a vertical run sideways so it does not pass through a box. */
function clearVertical(obstacles, x, y0, y1) {
  const hits = obstacles.filter((bx) => spansY(bx, y0, y1) && bx.x - 10 < x && bx.x + bx.w + 10 > x);
  if (!hits.length) return x;
  const left = Math.min(...hits.map((bx) => bx.x)) - LANE_GAP;
  const right = Math.max(...hits.map((bx) => bx.x + bx.w)) + LANE_GAP;
  const okL = left > WORK.x + 4, okR = right < WORK.x2 - 4;
  if (okL && (!okR || Math.abs(left - x) <= Math.abs(right - x))) return left;
  return okR ? right : x;
}

/** Shift a horizontal run so it does not pass through a box. */
function clearHorizontal(obstacles, y, x0, x1) {
  const hits = obstacles.filter((bx) => spansX(bx, x0, x1) && bx.y - 10 < y && bx.y + bx.h + 10 > y);
  if (!hits.length) return y;
  const above = Math.min(...hits.map((bx) => bx.y)) - LANE_GAP;
  const below = Math.max(...hits.map((bx) => bx.y + bx.h)) + LANE_GAP;
  const okA = above > WORK.y + 4, okB = below < WORK.y2 - 4;
  if (okA && (!okB || Math.abs(above - y) <= Math.abs(below - y))) return above;
  return okB ? below : y;
}

/** Drop duplicate and collinear points so the path stays clean. */
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.4 && Math.abs(last.y - p.y) < 0.4) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (let i = out.length - 2; i >= 1; i -= 1) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const collinearX = Math.abs(a.x - b.x) < 0.4 && Math.abs(b.x - c.x) < 0.4;
    const collinearY = Math.abs(a.y - b.y) < 0.4 && Math.abs(b.y - c.y) < 0.4;
    if (!(collinearX || collinearY)) continue;
    // Only drop the vertex when both runs head the same way. A point where
    // the path reverses is the approach overshoot at a box face; removing it
    // is what used to let an arrow enter from the wrong side, or collapse to
    // zero length when a box sits flush against the drawing edge.
    const sameDir = collinearX
      ? (b.y - a.y) * (c.y - b.y) >= 0
      : (b.x - a.x) * (c.x - b.x) >= 0;
    if (sameDir) out.splice(i, 1);
  }
  return out;
}

/**
 * Path for a routed polyline. FIPS 183 §3.2.1.3: "Arrows that bend shall be
 * curved using only 90 degree arcs", so each interior vertex becomes a
 * quarter-circle cut back along both of its runs.
 */
export function pointsToPath(pts, radius = CORNER_R) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${r(pts[0].x)} ${r(pts[0].y)}`;
  let d = `M${r(pts[0].x)} ${r(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = pts[i - 1], p = pts[i], c = pts[i + 1];
    const lin = Math.hypot(p.x - a.x, p.y - a.y);
    const lout = Math.hypot(c.x - p.x, c.y - p.y);
    const rad = Math.min(radius, lin / 2, lout / 2);
    const ix = (p.x - a.x) / (lin || 1), iy = (p.y - a.y) / (lin || 1);
    const ox = (c.x - p.x) / (lout || 1), oy = (c.y - p.y) / (lout || 1);
    const cross = ix * oy - iy * ox;
    // Collinear runs and reversals have no corner to round.
    if (rad < 0.5 || Math.abs(cross) < 0.5) { d += ` L${r(p.x)} ${r(p.y)}`; continue; }
    d += ` L${r(p.x - ix * rad)} ${r(p.y - iy * rad)}`;
    d += ` A${r(rad)} ${r(rad)} 0 0 ${cross > 0 ? 1 : 0} ${r(p.x + ox * rad)} ${r(p.y + oy * rad)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${r(last.x)} ${r(last.y)}`;
}

const CORNER_R = 7;

const r = (v) => Math.round(v * 10) / 10;

/** Total length of a polyline. */
export function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i += 1) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** Point at a fraction along a polyline, with the local direction. */
export function pointAt(pts, t) {
  const total = pathLength(pts);
  let want = total * t;
  for (let i = 1; i < pts.length; i += 1) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (want <= seg || i === pts.length - 1) {
      const f = seg ? want / seg : 0;
      return {
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
        dx: seg ? (pts[i].x - pts[i - 1].x) / seg : 1,
        dy: seg ? (pts[i].y - pts[i - 1].y) / seg : 0,
      };
    }
    want -= seg;
  }
  const p = pts[pts.length - 1];
  return { x: p.x, y: p.y, dx: 1, dy: 0 };
}

/** Midpoint of the longest segment — where an arrow label reads best. */
export function longestSegmentMid(pts) {
  let best = 0, bi = 1;
  for (let i = 1; i < pts.length; i += 1) {
    const L = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (L > best) { best = L; bi = i; }
  }
  const a = pts[bi - 1], b = pts[bi];
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, horizontal, length: best };
}

export function distToPolyline(pts, pt) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i += 1) best = Math.min(best, distToSegment(pts[i - 1], pts[i], pt));
  return best;
}

/** The point of segment `a`-`b` nearest `p`, clamped to the segment itself. */
function segmentClosestPoint(a, b, p) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
  return { x: a.x + t * vx, y: a.y + t * vy };
}

function distToSegment(a, b, p) {
  const c = segmentClosestPoint(a, b, p);
  return Math.hypot(p.x - c.x, p.y - c.y);
}

/** The point of `pts` nearest `pt` (F66) — ties go to the earlier segment, as
 *  `distToPolyline`'s own `Math.min` scan would light on first. The origin
 *  for a fewer-than-two-point polyline, on which `distToPolyline` never gets
 *  called (every real route has at least the two endpoints). */
export function nearestPointOnPolyline(pts, pt) {
  let best = null, bestD = Infinity;
  for (let i = 1; i < pts.length; i += 1) {
    const c = segmentClosestPoint(pts[i - 1], pts[i], pt);
    const d = Math.hypot(pt.x - c.x, pt.y - c.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best || (pts[0] ? { x: pts[0].x, y: pts[0].y } : { x: 0, y: 0 });
}

export const rectOf = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });
export const pointInRect = (r2, p) => p.x >= r2.x && p.x <= r2.x + r2.w && p.y >= r2.y && p.y <= r2.y + r2.h;

/* -------------------------------------------------------------- labels */

// Helvetica label text, matching the web canvas's `.arr-lbl` class and the
// export CSS's font-size (render.js) — both read this same size.
const LABEL_FONT_SIZE = 10.5;
// A label's grabbable rectangle is a few units bigger than its measured
// glyphs each way (F39): a click near the text, not only exactly on ink,
// still lands, and the same slack keeps `labelPlacement`'s collision checks
// from hugging a box or an ICOM code too closely.
const LABEL_PAD_X = 3;
const LABEL_HALF_H = 8;

/** How far a label's displayed position must sit from its arrow's route
 *  before it needs a squiggle to say the two belong together (FIPS 183
 *  §3.2.2.3 rule 4). */
const SQUIGGLE_MIN = 18;

/**
 * The rectangle a label at `pos` (an `{ x, y, anchor }` from `labelPlacement`
 * or `labelPosition`) occupies for `width` sheet units of text — used both to
 * score a placement candidate in `labelPlacement` and to hit-test the label
 * as drawn (F39's `labelAt`), so the two never disagree about where the
 * label "is".
 */
export function labelRect(pos, width) {
  const x0 = pos.anchor === 'middle' ? pos.x - width / 2 : pos.anchor === 'end' ? pos.x - width : pos.x;
  return { x: x0 - LABEL_PAD_X, y: pos.y - LABEL_HALF_H, w: width + LABEL_PAD_X * 2, h: LABEL_HALF_H * 2 };
}

const rectsOverlap = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * The position `labelPosition` falls back to once a label carries a manual
 * `ldx`/`ldy`: the longest segment's midpoint, offset above it (a horizontal
 * run) or start-anchored just beside it (a vertical one) — the fixed shape
 * every arrow's label used before `labelPlacement` existed, and still the
 * base a manual offset is added to.
 */
export function legacyLabelBase(pts) {
  const mid = longestSegmentMid(pts);
  const off = mid.horizontal ? { x: 0, y: -9 } : { x: 12, y: 0 };
  return { x: mid.x + off.x, y: mid.y + off.y, anchor: mid.horizontal ? 'middle' : 'start' };
}

/**
 * `labelPlacement(pts, text, { icomEnds, boxes })` — where an arrow's label
 * reads best without colliding with a box, an ICOM code, or running off the
 * frame (FIPS 183 §3.2.2.3 rule 2e; B.2.4.2 #2 asks for a "reasonable"
 * distance from boxes). Candidates are every segment's midpoint, longest
 * first (a tie keeps the earlier segment, as `longestSegmentMid` itself
 * would); a horizontal segment offers a position above and below it, a
 * vertical one a start-anchored position 12 units out and an end-anchored one
 * 12 units the other way — `legacyLabelBase`'s own shape, so the first
 * candidate of the longest segment is identical to it and nothing moves when
 * nothing collides. Each candidate is scored against `boxes`, `icomEnds` and
 * the frame's unsafe margin (its border and the header/footer bands) with
 * fixed integer penalties, worst first: running off the frame is weighted
 * above an ICOM-code collision, which is weighted above a box overlap,
 * because that is the order in which the label actually gets harder to read
 * — cut off outright, glyphs interleaved with a 1-3 character code, or ink
 * simply crossing a box FIPS already draws the label over (F60). On a tie the
 * first minimal-penalty candidate wins, so both apps agree without depending
 * on how ties sort; a diagram cramped enough that nothing scores zero still
 * gets the least-bad placement rather than whichever candidate happened to be
 * default.
 */
const FRAME_PENALTY = 3;
const ICOM_PENALTY = 2;
const BOX_PENALTY = 1;

export function labelPlacement(pts, text, opts = {}) {
  const icomEnds = opts.icomEnds || [];
  const boxes = opts.boxes || [];
  const width = textWidth(text, LABEL_FONT_SIZE);

  const segs = [];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1], b = pts[i];
    segs.push({ a, b, length: Math.hypot(b.x - a.x, b.y - a.y), i });
  }
  segs.sort((p, q) => q.length - p.length || p.i - q.i);

  const candidates = [];
  for (const s of segs) {
    const mx = (s.a.x + s.b.x) / 2, my = (s.a.y + s.b.y) / 2;
    const horizontal = Math.abs(s.b.x - s.a.x) >= Math.abs(s.b.y - s.a.y);
    if (horizontal) {
      candidates.push({ x: mx, y: my - 9, anchor: 'middle' });
      candidates.push({ x: mx, y: my + 9, anchor: 'middle' });
    } else {
      candidates.push({ x: mx + 12, y: my, anchor: 'start' });
      candidates.push({ x: mx - 12, y: my, anchor: 'end' });
    }
  }
  if (!candidates.length) {
    const p = pts[0] || { x: 0, y: 0 };
    candidates.push({ x: p.x, y: p.y, anchor: 'middle' });
  }

  let best = candidates[0], bestPenalty = Infinity;
  for (const c of candidates) {
    const rect = labelRect(c, width);
    let penalty = 0;
    if (boxes.some((b) => rectsOverlap(rect, b))) penalty += BOX_PENALTY;
    if (icomEnds.some((r) => rectsOverlap(rect, r))) penalty += ICOM_PENALTY;
    if (rect.x < FRAME_X_LO || rect.x + rect.w > FRAME_X_HI || rect.y < FRAME_Y_LO || rect.y + rect.h > FRAME_Y_HI) penalty += FRAME_PENALTY;
    if (penalty < bestPenalty) { best = c; bestPenalty = penalty; }
    if (bestPenalty === 0) break;
  }
  return best;
}

/**
 * `labelPosition(pts, arrow, opts)` — where an arrow's label is actually
 * drawn: `labelPlacement`'s automatic choice while its offset is at the
 * default (0, 0), or `legacyLabelBase` plus `ldx`/`ldy` once the modeller has
 * dragged it. Every renderer and hit-test in both apps reads this, so what is
 * drawn is what is clickable — see `routeArrow`'s equivalent guarantee for
 * routes. `opts` is `labelPlacement`'s `{ icomEnds, boxes }`.
 */
export function labelPosition(pts, arrow, opts = {}) {
  const dx = arrow.ldx || 0, dy = arrow.ldy || 0;
  if (dx === 0 && dy === 0) return labelPlacement(pts, arrow.label || '', opts);
  const base = legacyLabelBase(pts);
  return { x: base.x + dx, y: base.y + dy, anchor: base.anchor };
}

/** The closest point to `pt` that still lies in `rect` — on its border, for a
 *  `pt` outside it, which is the only case `squigglePoints` calls this for. */
function clampToRect(pt, rect) {
  return {
    x: Math.min(Math.max(pt.x, rect.x), rect.x + rect.w),
    y: Math.min(Math.max(pt.y, rect.y), rect.y + rect.h),
  };
}

/**
 * `squigglePoints(pts, pos, width)` — FIPS 183 §3.2.2.3 rule 4's squiggle,
 * linking a label to its arrow "unless the ... relationship is obvious": a
 * short zig-zag from the near edge of the label's rectangle to the nearest
 * point on `pts`, returned only once the label's displayed position (`pos`,
 * from `labelPosition`) sits more than `SQUIGGLE_MIN` units from that nearest
 * point. An auto-placed label never needs one — every `labelPlacement`
 * candidate sits within 12 units of its own segment. Returns null otherwise.
 */
export function squigglePoints(pts, pos, width) {
  const target = nearestPointOnPolyline(pts, pos);
  if (Math.hypot(pos.x - target.x, pos.y - target.y) <= SQUIGGLE_MIN) return null;
  const edge = clampToRect(target, labelRect(pos, width));
  const dx = target.x - edge.x, dy = target.y - edge.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = -dy / len, uy = dx / len;
  const AMP = 3;
  return [
    edge,
    { x: edge.x + dx / 3 + ux * AMP, y: edge.y + dy / 3 + uy * AMP },
    { x: edge.x + (dx * 2) / 3 - ux * AMP, y: edge.y + (dy * 2) / 3 - uy * AMP },
    target,
  ];
}
