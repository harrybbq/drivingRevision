// The phone bottom sheet: three heights (peek, half, full). Drag the handle, or
// tap it to step up. On desktop the panel is a sidebar and this does nothing.

const DESKTOP = '(min-width: 900px)';
const STATES = ['peek', 'half', 'full'];
const PEEK = 148;

export class Sheet {
  constructor(panel, grab, { onChange = () => {} } = {}) {
    this.panel = panel;
    this.grab = grab;
    this.onChange = onChange;
    this.state = 'peek';
    this.desktopQuery = matchMedia(DESKTOP);
    this.desktopQuery.addEventListener('change', () => this.apply());
    addEventListener('resize', () => this.apply());
    grab.addEventListener('pointerdown', (e) => this.drag(e));
    grab.addEventListener('click', () => {
      if (this.suppressClick) this.suppressClick = false;
      else this.set({ peek: 'half', fit: 'half', half: 'full', full: 'peek' }[this.state]);
    });
    this.apply();
  }

  get desktop() {
    return this.desktopQuery.matches;
  }

  heights() {
    const room = this.panel.parentElement.clientHeight;
    const half = Math.max(PEEK, Math.round(room * 0.5));
    return { peek: PEEK, half, full: Math.max(PEEK, room - 32), fit: Math.min(half, this.fitPx ?? PEEK) };
  }

  // Just tall enough for short content (the place/move prompts), up to half height.
  fit(px) {
    this.fitPx = Math.ceil(px);
    this.set('fit');
  }

  // How much of the map the sheet hides, so the map can keep pins in the visible part.
  covered() {
    return this.desktop ? 0 : this.heights()[this.state];
  }

  set(state) {
    this.state = state;
    this.apply();
  }

  apply(px) {
    const root = document.documentElement;
    if (this.desktop) {
      root.style.removeProperty('--sheet-h');
    } else {
      root.style.setProperty('--sheet-h', `${px ?? this.heights()[this.state]}px`);
      this.grab.setAttribute('aria-expanded', String(this.state !== 'peek'));
    }
    if (px === undefined) this.onChange(this.desktop ? 'desktop' : this.state);
  }

  drag(down) {
    if (this.desktop || down.button > 0) return;
    const startY = down.clientY;
    const startH = this.heights()[this.state];
    const startT = performance.now();
    let moved = false;
    this.grab.setPointerCapture(down.pointerId);
    const move = (e) => {
      const dy = startY - e.clientY;
      if (!moved && Math.abs(dy) < 6) return;
      if (!moved) this.panel.classList.add('is-dragging');
      moved = true;
      const { peek, full } = this.heights();
      this.apply(Math.max(peek - 40, Math.min(full, startH + dy)));
    };
    const up = (e) => {
      this.grab.removeEventListener('pointermove', move);
      this.grab.removeEventListener('pointerup', up);
      this.grab.removeEventListener('pointercancel', up);
      this.panel.classList.remove('is-dragging');
      if (!moved) return; // a tap: the click handler steps the sheet
      this.suppressClick = true;
      setTimeout(() => { this.suppressClick = false; }, 0);
      const dy = startY - e.clientY;
      const speed = dy / Math.max(1, performance.now() - startT); // px per ms, up is positive
      const heights = this.heights();
      const target = startH + dy;
      let index = STATES.reduce((best, s, i) => (Math.abs(heights[s] - target) < Math.abs(heights[STATES[best]] - target) ? i : best), 0);
      const current = Math.max(0, STATES.indexOf(this.state));
      if (speed > 0.6) index = Math.min(STATES.length - 1, current + 1);
      if (speed < -0.6) index = Math.max(0, current - 1);
      this.set(STATES[index]);
    };
    this.grab.addEventListener('pointermove', move);
    this.grab.addEventListener('pointerup', up);
    this.grab.addEventListener('pointercancel', up);
  }
}
