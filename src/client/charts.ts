// Dependency-free SVG/DOM charts. Colours come from CSS custom properties, so
// they follow the light/dark theme automatically.
import { h } from './dom';
import { fmtMonth, inr, inrShort } from './format';

const SVG = 'http://www.w3.org/2000/svg';

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...kids: Node[]) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Grouped income/spend bars per month. */
export function monthlyBars(data: { month: string; income: number; spend: number }[]): Element {
  const W = 640;
  const H = 240;
  const pad = { top: 12, right: 8, bottom: 28, left: 56 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.income, d.spend)), 0));
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const band = innerW / Math.max(data.length, 1);
  const barW = Math.min(18, band * 0.32);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Income and spending by month' });

  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.append(
      s('line', { x1: pad.left, x2: W - pad.right, y1: y(v), y2: y(v), class: 'grid' }),
      s('text', { x: pad.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, document.createTextNode(inrShort(v))),
    );
  }

  const labelEvery = Math.ceil(data.length / 12);
  data.forEach((d, i) => {
    const cx = pad.left + band * i + band / 2;
    const bar = (value: number, x: number, cls: string, label: string) => {
      const rect = s('rect', { x, y: y(value), width: barW, height: Math.max(0, y(0) - y(value)), rx: 3, class: cls });
      rect.append(s('title', {}, document.createTextNode(`${fmtMonth(d.month)} ${label}: ${inr(value)}`)));
      return rect;
    };
    svg.append(bar(d.income, cx - barW - 1, 'bar-income', 'income'), bar(d.spend, cx + 1, 'bar-spend', 'spending'));
    if (i % labelEvery === 0) {
      svg.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'axis' }, document.createTextNode(fmtMonth(d.month))));
    }
  });

  return h('figure', { class: 'chart-wrap' },
    svg,
    h('figcaption', { class: 'legend' },
      h('span', { class: 'key key-income' }, 'Income'),
      h('span', { class: 'key key-spend' }, 'Spending'),
    ),
  );
}

/** Horizontal bar list, e.g. spending by category or budget progress. */
export function barList(
  rows: { label: string; value: number; max?: number; note?: string; href?: string }[],
): HTMLElement {
  const top = Math.max(...rows.map((r) => r.max ?? r.value), 1);
  return h('ul', { class: 'bar-list' },
    ...rows.map((r) => {
      const fill = h('span', { class: 'bar-fill' });
      const limit = r.max ?? top;
      const pct = Math.min(100, (r.value / limit) * 100);
      // Set through CSSOM (allowed by the strict CSP, unlike style="" attributes).
      fill.style.width = `${pct}%`;
      if (r.max !== undefined && r.value > r.max) fill.dataset.over = 'true';
      const label = r.href ? h('a', { href: r.href }, r.label) : h('span', null, r.label);
      return h('li', null,
        h('div', { class: 'bar-row' }, label, h('span', { class: 'num' }, r.note ?? inr(r.value))),
        h('div', { class: 'bar-track' }, fill),
      );
    }),
  );
}
