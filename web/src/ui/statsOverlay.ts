import { getLifeStage } from '../core/ant';
import type { Simulation } from '../core/simulation';

const HISTOGRAM_BINS = 12;

/** The third overlay: a plain-DOM colony dashboard (population by life stage/layer, brood
 * counts, food stored, queen age) plus a canvas-drawn age histogram. Deliberately not a PixiJS
 * layer like the other two overlays — this is just numbers and a bar chart, so plain DOM/canvas
 * is simpler and composes with normal layout. */
export class StatsOverlay {
  private readonly root: HTMLDivElement;
  private readonly summaryEl: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(host: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'stats-overlay';

    const summary = document.createElement('div');
    summary.className = 'stats-summary';
    root.appendChild(summary);

    const heading = document.createElement('div');
    heading.className = 'panel-heading';
    heading.textContent = 'Ant age distribution (days)';
    root.appendChild(heading);

    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 220;
    canvas.className = 'stats-histogram';
    root.appendChild(canvas);

    host.appendChild(root);

    this.root = root;
    this.summaryEl = summary;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  set visible(value: boolean) {
    this.root.classList.toggle('visible', value);
  }

  get visible(): boolean {
    return this.root.classList.contains('visible');
  }

  /** Recomputes and redraws from current simulation state. Cheap to call every frame, but
   * skips the per-ant scan entirely while hidden. */
  update(sim: Simulation): void {
    if (!this.visible) return;

    const cfg = sim.config;
    let callow = 0;
    let mature = 0;
    let underground = 0;
    let surface = 0;
    let maxAge = 0;
    const ages: number[] = new Array(sim.ants.length);
    for (let i = 0; i < sim.ants.length; i++) {
      const ant = sim.ants[i];
      ages[i] = ant.ageDays;
      if (ant.ageDays > maxAge) maxAge = ant.ageDays;
      if (getLifeStage(ant, cfg) === 'callow') callow++;
      else mature++;
      if (ant.layer === 'underground') underground++;
      else surface++;
    }

    let eggs = 0;
    let larvae = 0;
    let pupae = 0;
    for (const b of sim.brood) {
      if (b.stage === 'egg') eggs++;
      else if (b.stage === 'larva') larvae++;
      else pupae++;
    }

    this.renderSummary([
      ['Population', `${sim.ants.length}`],
      ['Callow / mature', `${callow} / ${mature}`],
      ['Surface / underground', `${surface} / ${underground}`],
      ['Eggs', `${eggs}`],
      ['Larvae', `${larvae}`],
      ['Pupae (ready to eclose)', `${pupae}`],
      ['Food stored', sim.foodStored.toFixed(1)],
      ['Queen age (days)', sim.queen.ageDays.toFixed(1)],
    ]);
    this.drawHistogram(ages, maxAge);
  }

  private renderSummary(rows: Array<[string, string]>): void {
    this.summaryEl.replaceChildren(
      ...rows.map(([label, value]) => {
        const row = document.createElement('div');
        row.className = 'stats-row';
        const l = document.createElement('span');
        l.className = 'stats-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'stats-value';
        v.textContent = value;
        row.append(l, v);
        return row;
      }),
    );
  }

  private drawHistogram(ages: number[], maxAge: number): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (ages.length === 0) return;

    const upper = Math.max(maxAge, 1);
    const binWidth = upper / HISTOGRAM_BINS;
    const counts = new Array(HISTOGRAM_BINS).fill(0);
    for (const age of ages) {
      counts[Math.min(HISTOGRAM_BINS - 1, Math.floor(age / binWidth))]++;
    }
    const maxCount = Math.max(...counts, 1);

    const padding = 26;
    const chartW = canvas.width - padding * 2;
    const chartH = canvas.height - padding * 2;
    const slot = chartW / HISTOGRAM_BINS;

    ctx.fillStyle = '#3799bb';
    for (let i = 0; i < HISTOGRAM_BINS; i++) {
      const barHeight = (counts[i] / maxCount) * chartH;
      ctx.fillRect(padding + i * slot, padding + chartH - barHeight, slot - 2, barHeight);
    }

    ctx.strokeStyle = '#8b909a';
    ctx.beginPath();
    ctx.moveTo(padding, padding + chartH + 0.5);
    ctx.lineTo(padding + chartW, padding + chartH + 0.5);
    ctx.stroke();

    ctx.fillStyle = '#8b909a';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('0', padding, padding + chartH + 14);
    ctx.fillText(`max ${maxCount} ants`, padding, padding - 8);
    ctx.textAlign = 'right';
    ctx.fillText(`${upper.toFixed(0)}d`, padding + chartW, padding + chartH + 14);
  }
}
