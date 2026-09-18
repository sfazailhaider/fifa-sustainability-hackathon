// What happens if the city actually fixes the top sites.
//
// The priority layer answers "where is the problem worst". That is a finding,
// not a decision: a city looking at forty ranked corners still has to ask what
// it gets for fixing five of them rather than one. This turns the ranking into
// the comparison the brief asks for — change an input, watch the outcome move.
//
// There is no new data here and nothing is re-routed. The demand simulation is
// already on disk, and shading a street does not move anybody's route: the
// walking router does not know where the trees are, so the same 1,000 trips
// pass the same corners either way. What changes is what those trips cost the
// people making them, which is arithmetic on numbers we already have.
//
// THE ONE ASSUMPTION, STATED OUT LOUD
//
// How much a treatment actually improves a corridor is a policy question, not
// something in the data — so it is a slider rather than a constant we picked.
// The user sets it, the UI says it is an assumption, and every figure below
// moves with it. A single hard-coded "shade cuts difficulty 30%" would have
// been a number invented here and reported as a finding.

/** priority = intensity x difficulty, so a cut to difficulty scales it directly. */
export function runScenario(sites, { count, reduction }) {
  const treated = sites.slice(0, count);
  const untreated = sites.slice(count);

  const totalBurden = sites.reduce((sum, s) => sum + s.priority, 0);
  const treatedBurden = treated.reduce((sum, s) => sum + s.priority, 0);
  const removed = treatedBurden * reduction;

  // Every route that crosses a treated corner benefits, but routes cross
  // several corners, so this counts passes rather than distinct people — which
  // is why it is labelled that way in the UI rather than dressed up as
  // "trips helped".
  const passes = treated.reduce((sum, s) => sum + s.trips, 0);

  const after = sites.map((s, i) =>
    i < count ? { ...s, priority: s.priority * (1 - reduction), cost: s.cost * (1 - reduction), treated: true } : { ...s, treated: false },
  );

  // Where the next dollar goes once these are done.
  const nextWorst = [...after].sort((a, b) => b.priority - a.priority)[0];

  const costBefore = treated.length
    ? treated.reduce((sum, s) => sum + s.cost, 0) / treated.length
    : 0;

  return {
    count,
    reduction,
    treated,
    untreated,
    totalBurden,
    treatedBurden,
    removed,
    sharePart: totalBurden > 0 ? removed / totalBurden : 0,
    passes,
    costBefore,
    costAfter: costBefore * (1 - reduction),
    nextWorst,
    // Which sites are treated, for the map.
    treatedNames: new Set(treated.map((s) => s.name)),
  };
}

const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * The readout. Two bars rather than a chart library: the comparison is one
 * number against one number, and a bar each says it faster than anything
 * with axes would.
 */
export function renderScenario(result, routed) {
  const remainingShare = 1 - result.sharePart;
  return `
    <div class="scn-figures">
      <div class="scn-fig">
        <span class="scn-big">${pct(result.sharePart)}</span>
        <span class="scn-cap">
          less walking difficulty city-wide<em>adding up every ranked corner, counting each one by how
          many people cross it</em>
        </span>
      </div>
      <div class="scn-fig">
        <span class="scn-big">${result.passes.toLocaleString()}</span>
        <span class="scn-cap">
          crossings improved<em>times one of the ${routed.toLocaleString()} simulated walks passes a fixed
          corner — one walk can cross several, so this runs past ${routed.toLocaleString()}</em>
        </span>
      </div>
    </div>

    <div class="scn-bars">
      <div class="scn-bar-row">
        <span class="scn-bar-label">Now</span>
        <span class="scn-bar"><i style="width:100%"></i></span>
        <span class="scn-bar-val">${result.totalBurden.toFixed(1)}</span>
      </div>
      <div class="scn-bar-row">
        <span class="scn-bar-label">After</span>
        <span class="scn-bar"><i class="is-after" style="width:${(remainingShare * 100).toFixed(1)}%"></i></span>
        <span class="scn-bar-val">${(result.totalBurden - result.removed).toFixed(1)}</span>
      </div>
      <p class="scn-axis">
        Total walking difficulty across all ${result.treated.length + result.untreated.length} ranked
        corners. The scale has no unit — only the drop matters.
      </p>
    </div>

    <p class="scn-note">
      The ground being fixed goes from
      <b>${result.costBefore.toFixed(2)}</b> to <b>${result.costAfter.toFixed(2)}</b> out of 10 for
      walking difficulty, where 10 is the hardest.
      ${
        result.nextWorst.treated
          ? `Even after the work, <b>${result.nextWorst.name}</b> is still the worst corner in the ` +
            `city at ${result.nextWorst.priority.toFixed(2)} — a ${pct(result.reduction)} improvement ` +
            `is not enough to move it off the top of the list.`
          : `The worst corner left is <b>${result.nextWorst.name}</b> at ` +
            `${result.nextWorst.priority.toFixed(2)} — where the next round of money goes.`
      }
    </p>
  `;
}
