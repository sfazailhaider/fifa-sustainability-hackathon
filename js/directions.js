// Turn-by-turn directions from OSRM steps.
//
// Two jobs: turn OSRM's maneuver objects into sentences a person can follow,
// and score each individual step against the green layer — so the directions
// say which turns are shaded and which put you on a feeder road, which is the
// whole point of this app.

import { pathGreenMetrics, isBigRoad } from './scoring.js';
import { MODES } from './config.js';

const TURN_WORD = {
  left: 'Turn left',
  right: 'Turn right',
  'sharp left': 'Sharp left',
  'sharp right': 'Sharp right',
  'slight left': 'Bear left',
  'slight right': 'Bear right',
  straight: 'Continue straight',
  uturn: 'Make a U-turn',
};

const ARROW = {
  left: '←',
  right: '→',
  'sharp left': '↰',
  'sharp right': '↱',
  'slight left': '↖',
  'slight right': '↗',
  straight: '↑',
  uturn: '↩',
  depart: '●',
  arrive: '◎',
  roundabout: '↻',
  merge: '⤵',
  fork: '⑂',
};

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

function ordinal(n) {
  return ORDINAL[n - 1] || `${n}th`;
}

/** What to call the road for this step; OSM leaves plenty of paths unnamed. */
function roadName(step, mode) {
  if (step.name) return step.name;
  if (step.ref) return step.ref;
  if (step.mode === 'ferry') return 'the ferry';
  return mode === 'car' ? 'the unnamed road' : 'the path';
}

/**
 * OSRM's `name` is "the way along which travel proceeds" for *this* step —
 * i.e. the road the maneuver puts you on, not the one you are leaving. So the
 * street in every instruction comes from the step itself, never the next one.
 * Unnamed sidewalks and cut-throughs are common in Houston OSM data, and there
 * the bare turn word is more honest than inventing a street.
 */
function onto(step, mode) {
  return step.name || step.ref ? ` onto ${roadName(step, mode)}` : '';
}

/** One human sentence for an OSRM step. */
export function instructionFor(step, mode, destinationLabel) {
  const { type, modifier, exit } = step.maneuver;
  const named = Boolean(step.name || step.ref);
  const road = roadName(step, mode);
  const verb = MODES[mode].verb;

  switch (type) {
    case 'depart':
      return named ? `${verb} on ${road}` : `${verb} along the path`;

    case 'arrive': {
      const where = destinationLabel ? ` at ${destinationLabel}` : ' at your destination';
      const side =
        modifier === 'left' ? ', on your left' : modifier === 'right' ? ', on your right' : '';
      return `Arrive${where}${side}`;
    }

    case 'new name':
      return named ? `Continue onto ${road}` : 'Continue ahead';

    case 'continue':
      return named ? `Continue on ${road}` : 'Continue ahead';

    case 'turn':
    case 'end of road':
    case 'fork': {
      const word = TURN_WORD[modifier] || 'Continue';
      if (modifier === 'straight') return named ? `Continue on ${road}` : 'Continue ahead';
      return `${word}${onto(step, mode)}`;
    }

    case 'merge':
      return `Merge${onto(step, mode)}`;

    case 'on ramp':
      return `Take the ramp${onto(step, mode)}`;

    case 'off ramp':
      return `Take the exit${modifier?.includes('left') ? ' on the left' : ''}${onto(step, mode)}`;

    case 'roundabout':
    case 'rotary':
      return exit
        ? `At the roundabout, take the ${ordinal(exit)} exit${onto(step, mode)}`
        : `Enter the roundabout${onto(step, mode)}`;

    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto(step, mode)}`;

    default:
      return named ? `Continue on ${road}` : 'Continue ahead';
  }
}

function arrowFor(step) {
  const { type, modifier } = step.maneuver;
  if (type === 'depart' || type === 'arrive') return ARROW[type];
  if (type === 'roundabout' || type === 'rotary') return ARROW.roundabout;
  if (type === 'merge') return ARROW.merge;
  if (type === 'fork') return ARROW[modifier] || ARROW.fork;
  return ARROW[modifier] || ARROW.straight;
}

function stepPoints(step) {
  const coords = step.geometry?.coordinates || [];
  return coords.map(([lon, lat]) => [lat, lon]);
}

/**
 * Flatten a route's legs into a scored, display-ready instruction list.
 * Steps shorter than `mergeUnder` metres are folded into the previous one so
 * a walking route doesn't produce 75 lines of "continue for 8 m".
 */
export function buildDirections(route, layer, mode, destinationLabel, { mergeUnder = 25 } = {}) {
  const raw = [];
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) raw.push(step);
  }
  if (!raw.length) return [];

  const merged = [];
  for (const step of raw) {
    const type = step.maneuver.type;
    const last = merged[merged.length - 1];
    const keep = type === 'depart' || type === 'arrive';

    // Two kinds of noise worth folding away: steps too short to act on, and
    // "continue" steps that just restate the road you are already on.
    const tooShort = step.distance < mergeUnder;
    const sameRoad =
      Boolean(step.name) &&
      step.name === last?.raw.name &&
      ['continue', 'new name', 'notification'].includes(type);

    if (last && !keep && (tooShort || sameRoad)) {
      last.distance += step.distance;
      last.duration += step.duration;
      last.points = last.points.concat(stepPoints(step).slice(1));
      continue;
    }

    merged.push({
      raw: step,
      distance: step.distance,
      duration: step.duration,
      points: stepPoints(step),
    });
  }

  let cumulative = 0;
  return merged.map((entry, index) => {
    const step = entry.raw;
    const green = pathGreenMetrics(entry.points, layer, 20);
    const start = cumulative;
    cumulative += entry.distance;

    return {
      index,
      instruction: instructionFor(step, mode, destinationLabel),
      arrow: arrowFor(step),
      // Only a real street name belongs in the meta line — the generic
      // "the path" fallback already appears in the instruction itself.
      road: step.name || step.ref || '',
      distance: entry.distance,
      duration: entry.duration,
      distanceFromStart: start,
      location: [step.maneuver.location[1], step.maneuver.location[0]],
      points: entry.points,
      shadeShare: green.shadeShare,
      greenShare: green.greenShare,
      bigRoad: isBigRoad(step.name || '', step.ref || ''),
      isArrival: step.maneuver.type === 'arrive',
    };
  });
}

/** "450 ft" / "0.4 mi" — imperial, because this is Texas. */
export function stepDistance(metres) {
  const feet = metres * 3.28084;
  if (feet < 800) return `${Math.max(10, Math.round(feet / 10) * 10)} ft`;
  const miles = metres / 1609.34;
  return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
}
