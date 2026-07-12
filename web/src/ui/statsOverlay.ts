import { getLifeStage } from '../core/ant';
import { type BenchmarkResult, runPheromoneBenchmark } from '../core/benchmark';
import type { PheromoneAlgorithm } from '../core/config';
import type { Simulation } from '../core/simulation';

const ALGORITHM_LABELS: Record<PheromoneAlgorithm, string> = {
  legacy: 'Legacy',
  gradient: 'Gradient',
  flow: 'Flow',
  diffusion: 'Diffusion',
};

/** Reuses the history charts' existing palette (population/food/throttle) plus one neutral grey,
 * rather than inventing a fifth color scheme just for this chart. */
const ALGORITHM_COLORS: Record<PheromoneAlgorithm, string> = {
  legacy: '#8b909a',
  gradient: '#3799bb',
  flow: '#4caf7d',
  diffusion: '#e8a33d',
};

const HISTOGRAM_BINS = 12;

interface ActivityCategory {
  label: string;
  color: string;
}

/** Colony activity right now, one bucket per behavioral mode an ant can be in — mirrors the
 * branches in `Simulation.stepAnt`/`stepUndergroundAnt` so the chart reads as a live snapshot
 * of the state machine actually driving the colony, not just a population count. */
const ACTIVITY_CATEGORIES = {
  resting: { label: 'Resting', color: '#5a6472' },
  foraging: { label: 'Foraging', color: '#3799bb' },
  returningWithFood: { label: 'Returning with food', color: '#e8a33d' },
  digging: { label: 'Digging / exploring', color: '#8a5a34' },
  delivering: { label: 'Delivering food', color: '#4caf7d' },
  nursing: { label: 'Nursing brood', color: '#b98cd6' },
  exiting: { label: 'Returning to surface', color: '#59c3b4' },
} satisfies Record<string, ActivityCategory>;
type ActivityKey = keyof typeof ACTIVITY_CATEGORIES;

/** The third overlay: a plain-DOM colony dashboard — population/brood/food/queen summary, a
 * live activity breakdown, rolling trend charts, and age/size histograms. Deliberately not a
 * PixiJS layer like the other two overlays — this is just numbers and charts, so plain DOM +
 * canvas is simpler and composes with normal layout. */
export class StatsOverlay {
  private readonly root: HTMLDivElement;
  private readonly summaryEl: HTMLDivElement;

  private readonly activityCanvas: HTMLCanvasElement;
  private readonly activityCtx: CanvasRenderingContext2D;

  private readonly populationChart: HTMLCanvasElement;
  private readonly populationCtx: CanvasRenderingContext2D;
  private readonly foodChart: HTMLCanvasElement;
  private readonly foodCtx: CanvasRenderingContext2D;
  private readonly throttleChart: HTMLCanvasElement;
  private readonly throttleCtx: CanvasRenderingContext2D;

  private readonly ageCanvas: HTMLCanvasElement;
  private readonly ageCtx: CanvasRenderingContext2D;
  private readonly sizeCanvas: HTMLCanvasElement;
  private readonly sizeCtx: CanvasRenderingContext2D;

  private readonly benchmarkButton: HTMLButtonElement;
  private readonly benchmarkStatus: HTMLDivElement;
  private readonly benchmarkCanvas: HTMLCanvasElement;
  private readonly benchmarkCtx: CanvasRenderingContext2D;
  private benchmarkResults: BenchmarkResult[] | null = null;
  private benchmarkRunning = false;

  constructor(host: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'stats-overlay';

    const summary = document.createElement('div');
    summary.className = 'stats-summary';
    root.appendChild(summary);

    root.appendChild(this.heading('Colony activity right now'));
    [this.activityCanvas, this.activityCtx] = this.makeCanvas(480, 232);
    root.appendChild(this.activityCanvas);

    root.appendChild(this.heading('Colony history'));
    const historyRow = document.createElement('div');
    historyRow.className = 'stats-chart-row';
    const [popChart, popTitled] = this.makeTitledChart('Population', 230, 140);
    const [foodChart, foodTitled] = this.makeTitledChart('Food stored', 230, 140);
    const [throttleChart, throttleTitled] = this.makeTitledChart('Foraging throttle', 230, 140);
    historyRow.append(popTitled, foodTitled, throttleTitled);
    root.appendChild(historyRow);
    this.populationChart = popChart;
    this.populationCtx = popChart.getContext('2d')!;
    this.foodChart = foodChart;
    this.foodCtx = foodChart.getContext('2d')!;
    this.throttleChart = throttleChart;
    this.throttleCtx = throttleChart.getContext('2d')!;

    const histogramRow = document.createElement('div');
    histogramRow.className = 'stats-chart-row';
    const [ageChart, ageTitled] = this.makeTitledChart('Ant age distribution (days)', 230, 180);
    const [sizeChart, sizeTitled] = this.makeTitledChart('Ant size distribution (mm)', 230, 180);
    histogramRow.append(ageTitled, sizeTitled);
    root.appendChild(histogramRow);
    this.ageCanvas = ageChart;
    this.ageCtx = ageChart.getContext('2d')!;
    this.sizeCanvas = sizeChart;
    this.sizeCtx = sizeChart.getContext('2d')!;

    root.appendChild(this.heading('Pheromone algorithm benchmark'));
    const benchmarkControls = document.createElement('div');
    benchmarkControls.className = 'stats-benchmark-controls';
    const benchmarkButton = document.createElement('button');
    benchmarkButton.type = 'button';
    benchmarkButton.className = 'tool-button';
    benchmarkButton.textContent = 'Run benchmark';
    benchmarkButton.addEventListener('click', () => this.runBenchmark());
    const benchmarkStatus = document.createElement('div');
    benchmarkStatus.className = 'stats-benchmark-status';
    benchmarkStatus.textContent = 'Runs all four algorithms on an identical small colony and compares delivery throughput.';
    benchmarkControls.append(benchmarkButton, benchmarkStatus);
    root.appendChild(benchmarkControls);
    const [benchmarkCanvas, benchmarkCtx] = this.makeCanvas(480, 160);
    root.appendChild(benchmarkCanvas);
    this.benchmarkButton = benchmarkButton;
    this.benchmarkStatus = benchmarkStatus;
    this.benchmarkCanvas = benchmarkCanvas;
    this.benchmarkCtx = benchmarkCtx;
    this.drawBenchmark();

    host.appendChild(root);
    this.root = root;
    this.summaryEl = summary;
  }

  private heading(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'panel-heading';
    el.textContent = text;
    return el;
  }

  private makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.className = 'stats-histogram';
    return [canvas, canvas.getContext('2d')!];
  }

  private makeTitledChart(title: string, width: number, height: number): [HTMLCanvasElement, HTMLDivElement] {
    const [canvas] = this.makeCanvas(width, height);
    const wrap = document.createElement('div');
    wrap.className = 'stats-chart';
    const label = document.createElement('div');
    label.className = 'stats-chart-title';
    label.textContent = title;
    wrap.append(label, canvas);
    return [canvas, wrap];
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
    const sizes: number[] = new Array(sim.ants.length);
    const activityCounts: Record<ActivityKey, number> = {
      resting: 0,
      foraging: 0,
      returningWithFood: 0,
      digging: 0,
      delivering: 0,
      nursing: 0,
      exiting: 0,
    };

    for (let i = 0; i < sim.ants.length; i++) {
      const ant = sim.ants[i];
      ages[i] = ant.ageDays;
      sizes[i] = ant.size;
      if (ant.ageDays > maxAge) maxAge = ant.ageDays;
      if (getLifeStage(ant, cfg) === 'callow') callow++;
      else mature++;

      if (ant.layer === 'underground') {
        underground++;
        if (ant.deliveringUnderground) activityCounts.delivering++;
        else if (ant.carriedBrood) activityCounts.nursing++;
        else if (ant.headingToSurface) activityCounts.exiting++;
        else activityCounts.digging++;
      } else {
        surface++;
        if (ant.paused) activityCounts.resting++;
        else if (ant.lookingFor === 'food') activityCounts.foraging++;
        else activityCounts.returningWithFood++;
      }
    }

    let eggs = 0;
    let larvae = 0;
    let pupae = 0;
    for (const b of sim.brood) {
      if (b.stage === 'egg') eggs++;
      else if (b.stage === 'larva') larvae++;
      else pupae++;
    }

    const foodPerDay = sim.deliveryEmaFast * cfg.framesPerDay;

    this.renderSummary([
      ['Population', `${sim.ants.length}`],
      ['Callow / mature', `${callow} / ${mature}`],
      ['Surface / underground', `${surface} / ${underground}`],
      ['Eggs', `${eggs}`],
      ['Larvae', `${larvae}`],
      ['Pupae (ready to eclose)', `${pupae}`],
      ['Food stored', sim.foodStored.toFixed(1)],
      ['Food gathered', `~${foodPerDay.toFixed(1)}/day`],
      ['Tunnels dug', `${sim.undergroundGrid.dugCount()}`],
      ['Queen age (days)', sim.queen.ageDays.toFixed(1)],
    ]);

    this.drawActivity(activityCounts, sim.ants.length);
    this.drawSparkline(this.populationCtx, this.populationChart, sim.history.map((s) => s.population), '#3799bb', 0);
    this.drawSparkline(this.foodCtx, this.foodChart, sim.history.map((s) => s.foodStored), '#4caf7d', 0);
    this.drawSparkline(this.throttleCtx, this.throttleChart, sim.history.map((s) => s.foragingThrottle), '#e8a33d', 2);
    this.drawHistogram(this.ageCtx, this.ageCanvas, ages, (n) => `${n.toFixed(0)}d`);
    this.drawHistogram(this.sizeCtx, this.sizeCanvas, sizes, (n) => `${n.toFixed(1)}mm`);
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

  /** Horizontal bar per activity category — easier to fit 7 readable labels than a vertical
   * layout, and immediately shows what fraction of the colony is doing what right now. */
  private drawActivity(counts: Record<ActivityKey, number>, total: number): void {
    const ctx = this.activityCtx;
    const canvas = this.activityCanvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (total === 0) return;

    const rowH = 24;
    const gap = 6;
    const leftPad = 150;
    const rightPad = 70;
    const barMaxW = canvas.width - leftPad - rightPad;
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';

    (Object.keys(ACTIVITY_CATEGORIES) as ActivityKey[]).forEach((key, i) => {
      const { label, color } = ACTIVITY_CATEGORIES[key];
      const count = counts[key];
      const frac = count / total;
      const y = i * (rowH + gap) + rowH / 2 + 4;
      const barW = frac * barMaxW;

      ctx.fillStyle = '#8b909a';
      ctx.textAlign = 'right';
      ctx.fillText(label, leftPad - 10, y);

      ctx.fillStyle = color;
      ctx.fillRect(leftPad, y - rowH / 2 + 2, Math.max(barW, 0), rowH - 4);

      ctx.fillStyle = '#d8dade';
      ctx.textAlign = 'left';
      ctx.fillText(`${count} (${(frac * 100).toFixed(0)}%)`, leftPad + barW + 8, y);
    });
  }

  /** Small trend line for one rolling `Simulation.history` metric, filled beneath the line so
   * it reads clearly even at this size. `fixed` controls decimal places on the min/max labels
   * (0 for whole-number counts, 2 for the throttle ratio). */
  private drawSparkline(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, values: number[], color: string, fixed: number): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (values.length < 2) {
      ctx.fillStyle = '#8b909a';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('gathering data…', canvas.width / 2, canvas.height / 2);
      return;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const padding = 22;
    const w = canvas.width - padding * 2;
    const h = canvas.height - padding * 2;

    ctx.beginPath();
    values.forEach((v, i) => {
      const x = padding + (i / (values.length - 1)) * w;
      const y = padding + h - ((v - min) / range) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.lineTo(padding + w, padding + h);
    ctx.lineTo(padding, padding + h);
    ctx.closePath();
    ctx.fillStyle = `${color}33`;
    ctx.fill();

    ctx.fillStyle = '#8b909a';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`min ${min.toFixed(fixed)}`, padding, padding + h + 14);
    ctx.textAlign = 'right';
    ctx.fillText(`max ${max.toFixed(fixed)}`, padding + w, padding + h + 14);
  }

  /** Generic bucketed histogram, shared by the age and size distributions. */
  private drawHistogram(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, values: number[], formatUpper: (n: number) => string): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (values.length === 0) return;

    const upper = Math.max(...values, 1);
    const binWidth = upper / HISTOGRAM_BINS;
    const counts = new Array(HISTOGRAM_BINS).fill(0);
    for (const v of values) {
      counts[Math.min(HISTOGRAM_BINS - 1, Math.floor(v / binWidth))]++;
    }
    const maxCount = Math.max(...counts, 1);

    const padding = 22;
    const chartW = canvas.width - padding * 2;
    const chartH = canvas.height - padding * 2;
    const slot = chartW / HISTOGRAM_BINS;

    ctx.fillStyle = '#3799bb';
    for (let i = 0; i < HISTOGRAM_BINS; i++) {
      const barHeight = (counts[i] / maxCount) * chartH;
      ctx.fillRect(padding + i * slot, padding + chartH - barHeight, Math.max(slot - 2, 1), barHeight);
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
    ctx.fillText(`max ${maxCount}`, padding, padding - 8);
    ctx.textAlign = 'right';
    ctx.fillText(formatUpper(upper), padding + chartW, padding + chartH + 14);
  }

  /** Runs `runPheromoneBenchmark` (four throwaway headless colonies, one per algorithm — fully
   * separate from whatever's on screen) and redraws the comparison chart when it settles. Guards
   * against overlapping runs from a double-click. */
  private async runBenchmark(): Promise<void> {
    if (this.benchmarkRunning) return;
    this.benchmarkRunning = true;
    this.benchmarkButton.disabled = true;
    this.benchmarkResults = null;
    this.drawBenchmark();

    const results = await runPheromoneBenchmark({
      onProgress: (algorithm, framesDone, framesTotal) => {
        this.benchmarkStatus.textContent = `Running ${ALGORITHM_LABELS[algorithm]}… ${framesDone}/${framesTotal} frames`;
      },
    });

    this.benchmarkResults = results;
    this.benchmarkRunning = false;
    this.benchmarkButton.disabled = false;
    this.benchmarkStatus.textContent = 'Deliveries over a fixed simulated window, identical small colony, same map for all four.';
    this.drawBenchmark();
  }

  /** Horizontal bar chart, same visual language as `drawActivity` — one bar per algorithm,
   * colored consistently with the history charts above. Shows a placeholder until the first run
   * completes. */
  private drawBenchmark(): void {
    const ctx = this.benchmarkCtx;
    const canvas = this.benchmarkCanvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!this.benchmarkResults) {
      ctx.fillStyle = '#8b909a';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Run the benchmark to compare algorithms', canvas.width / 2, canvas.height / 2);
      return;
    }

    const maxDeliveries = Math.max(...this.benchmarkResults.map((r) => r.deliveries), 1);
    const rowH = 28;
    const gap = 8;
    const leftPad = 90;
    const rightPad = 60;
    const barMaxW = canvas.width - leftPad - rightPad;
    ctx.font = '12px sans-serif';
    ctx.textBaseline = 'middle';

    this.benchmarkResults.forEach(({ algorithm, deliveries }, i) => {
      const y = i * (rowH + gap) + rowH / 2 + 4;
      const barW = (deliveries / maxDeliveries) * barMaxW;

      ctx.fillStyle = '#8b909a';
      ctx.textAlign = 'right';
      ctx.fillText(ALGORITHM_LABELS[algorithm], leftPad - 10, y);

      ctx.fillStyle = ALGORITHM_COLORS[algorithm];
      ctx.fillRect(leftPad, y - rowH / 2 + 3, Math.max(barW, 0), rowH - 6);

      ctx.fillStyle = '#d8dade';
      ctx.textAlign = 'left';
      ctx.fillText(`${deliveries}`, leftPad + barW + 8, y);
    });
  }
}
