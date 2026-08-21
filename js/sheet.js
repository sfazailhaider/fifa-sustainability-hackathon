// The mobile bottom sheet.
//
// Below 900px the side panel becomes a sheet over a full-screen map, dragged
// between three snap points. Two rules keep it predictable:
//
//   1. Only the handle is draggable. Dragging from the body would compete
//      with the scrolling list inside it, and that fight is what makes
//      home-grown sheets feel broken.
//   2. Snapping is by nearest point on release, with a velocity nudge so a
//      quick flick carries to the next stop rather than falling back.

const MOBILE = '(max-width: 900px)';
const PEEK_PX = 78; // how much of the sheet stays on screen when minimised

const NO_SHEET = {
  snapTo() {},
  isMobile: () => false,
  current: () => 'full',
};

export function initSheet({ panel, handle, scroll, onSnap }) {
  // The sheet is an enhancement. If the environment cannot answer media
  // queries, fall back to the plain panel rather than taking the app down.
  if (!panel || !handle || typeof window.matchMedia !== 'function') return NO_SHEET;

  const media = window.matchMedia(MOBILE);

  let snaps = { full: 0, half: 0, min: 0 };
  let current = 'half';
  let dragging = false;
  let startY = 0;
  let startOffset = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;

  let sheetHeight = 0;

  function measure() {
    sheetHeight = panel.getBoundingClientRect().height;
    snaps = {
      full: 0,
      half: Math.max(0, sheetHeight - window.innerHeight * 0.46),
      min: Math.max(0, sheetHeight - PEEK_PX),
    };
  }

  /**
   * The sheet is taller than the screen and slid down into place, so the part
   * below the viewport is simply off-screen. The scrolling area therefore has
   * to be sized to what is actually visible at this snap point — otherwise the
   * list is clipped rather than scrollable, and its bottom is unreachable.
   */
  function fitScrollArea(name) {
    if (!scroll) return;
    const visible = { full: sheetHeight, half: window.innerHeight * 0.46, min: PEEK_PX }[name];
    const handleHeight = handle.getBoundingClientRect().height;
    scroll.style.height = `${Math.max(0, Math.round(visible - handleHeight))}px`;
  }

  function apply(offset) {
    panel.style.transform = `translateY(${offset}px)`;
  }

  function snapTo(name, { animate = true } = {}) {
    current = name;
    panel.classList.toggle('is-dragging', !animate);
    apply(snaps[name]);
    fitScrollArea(name);
    panel.dataset.sheet = name;
    handle.setAttribute('aria-expanded', String(name !== 'min'));
    onSnap?.(name);
  }

  function nearest(offset, distance) {
    const entries = Object.entries(snaps);
    // A short, quick flick means "next stop that way". A long drag means
    // "put it where I left it" — otherwise hauling the sheet to the bottom
    // would spring back to the middle.
    if (Math.abs(velocity) > 0.5 && distance < 60) {
      const order = ['full', 'half', 'min'];
      const index = order.indexOf(current);
      const next = velocity > 0 ? index + 1 : index - 1;
      return order[Math.min(order.length - 1, Math.max(0, next))];
    }
    return entries.reduce((best, [name, value]) =>
      Math.abs(value - offset) < Math.abs(snaps[best] - offset) ? name : best,
      entries[0][0],
    );
  }

  function onPointerDown(event) {
    if (!media.matches) return;
    dragging = true;
    startY = event.clientY;
    lastY = event.clientY;
    lastTime = event.timeStamp;
    velocity = 0;
    startOffset = snaps[current];
    panel.classList.add('is-dragging');
    handle.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (!dragging) return;
    const delta = event.clientY - startY;
    const offset = Math.min(snaps.min, Math.max(0, startOffset + delta));

    const dt = event.timeStamp - lastTime;
    if (dt > 0) velocity = (event.clientY - lastY) / dt;
    lastY = event.clientY;
    lastTime = event.timeStamp;

    apply(offset);
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-dragging');

    const moved = Math.abs(event.clientY - startY);
    // A press rather than a drag: cycle to the next size up, wrapping round.
    if (moved < 6) {
      const order = ['min', 'half', 'full'];
      snapTo(order[(order.indexOf(current) + 1) % order.length]);
      return;
    }
    snapTo(nearest(snaps[current] + (event.clientY - startY), moved));
  }

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);

  handle.addEventListener('keydown', (event) => {
    if (!media.matches) return;
    const order = ['min', 'half', 'full'];
    const index = order.indexOf(current);
    if (event.key === 'ArrowUp') snapTo(order[Math.min(order.length - 1, index + 1)]);
    else if (event.key === 'ArrowDown') snapTo(order[Math.max(0, index - 1)]);
    else return;
    event.preventDefault();
  });

  function reset() {
    if (!media.matches) {
      panel.style.transform = '';
      if (scroll) scroll.style.height = '';
      delete panel.dataset.sheet;
      return;
    }
    measure();
    snapTo(current, { animate: false });
    // Re-enable the transition once the jump has been painted.
    requestAnimationFrame(() => panel.classList.remove('is-dragging'));
  }

  window.addEventListener('resize', reset);
  media.addEventListener?.('change', reset);
  reset();

  return {
    snapTo,
    isMobile: () => media.matches,
    current: () => current,
  };
}
