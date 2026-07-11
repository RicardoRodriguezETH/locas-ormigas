import type { PheromoneAlgorithm } from '../core/config';
import type { PaintableCellType } from '../core/grid';

export type Tool = 'pan' | PaintableCellType;

const TOOLS: Array<{ tool: Tool; label: string }> = [
  { tool: 'pan', label: 'Pan view' },
  { tool: 'block', label: 'Block' },
  { tool: 'grass', label: 'Grass' },
  { tool: 'cave', label: 'Cave' },
  { tool: 'food', label: 'Food' },
  { tool: 'portal', label: 'Portal' },
  { tool: 'ground', label: 'Remove' },
];

const ALGORITHMS: Array<{ algorithm: PheromoneAlgorithm; label: string }> = [
  { algorithm: 'legacy', label: 'Legacy' },
  { algorithm: 'gradient', label: 'Gradient' },
];

export interface PanelCallbacks {
  onToolChange(tool: Tool): void;
  onZoom(delta: number): void;
  onTogglePheromones(show: boolean): void;
  onAlgorithmChange(algorithm: PheromoneAlgorithm): void;
}

/** The left-hand tool sidebar: cell-painting tools, zoom controls, and live stats. Plain DOM
 * rather than a canvas-drawn UI, so it composes cleanly with normal web layout/accessibility. */
export class Panel {
  selectedTool: Tool = 'pan';

  private readonly statsEl: HTMLDivElement;
  private readonly algorithmEl: HTMLDivElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly algorithmButtons = new Map<PheromoneAlgorithm, HTMLButtonElement>();

  constructor(host: HTMLElement, callbacks: PanelCallbacks) {
    host.replaceChildren();

    const stats = document.createElement('div');
    stats.className = 'panel-stats';
    host.appendChild(stats);
    this.statsEl = stats;

    const algorithmLabel = document.createElement('div');
    algorithmLabel.className = 'panel-algorithm';
    host.appendChild(algorithmLabel);
    this.algorithmEl = algorithmLabel;

    const toolGroup = document.createElement('div');
    toolGroup.className = 'panel-group';
    for (const { tool, label } of TOOLS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-button';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.setSelectedTool(tool);
        callbacks.onToolChange(tool);
      });
      toolGroup.appendChild(btn);
      this.toolButtons.set(tool, btn);
    }
    host.appendChild(toolGroup);
    this.setSelectedTool('pan');

    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'panel-group panel-row';
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.className = 'tool-button';
    zoomIn.textContent = 'Zoom +';
    zoomIn.addEventListener('click', () => callbacks.onZoom(0.5));
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.className = 'tool-button';
    zoomOut.textContent = 'Zoom −';
    zoomOut.addEventListener('click', () => callbacks.onZoom(-0.5));
    zoomGroup.append(zoomIn, zoomOut);
    host.appendChild(zoomGroup);

    const pheromoneLabel = document.createElement('label');
    pheromoneLabel.className = 'panel-checkbox';
    const pheromoneCheckbox = document.createElement('input');
    pheromoneCheckbox.type = 'checkbox';
    pheromoneCheckbox.addEventListener('change', () => callbacks.onTogglePheromones(pheromoneCheckbox.checked));
    pheromoneLabel.append(pheromoneCheckbox, document.createTextNode(' Show pheromones'));
    host.appendChild(pheromoneLabel);

    const algoHeading = document.createElement('div');
    algoHeading.className = 'panel-heading';
    algoHeading.textContent = 'Pheromone algorithm';
    host.appendChild(algoHeading);

    const algoGroup = document.createElement('div');
    algoGroup.className = 'panel-group panel-row';
    for (const { algorithm, label } of ALGORITHMS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-button';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.setSelectedAlgorithm(algorithm);
        callbacks.onAlgorithmChange(algorithm);
      });
      algoGroup.appendChild(btn);
      this.algorithmButtons.set(algorithm, btn);
    }
    host.appendChild(algoGroup);
    this.setSelectedAlgorithm('gradient');
  }

  setSelectedTool(tool: Tool): void {
    this.selectedTool = tool;
    for (const [t, btn] of this.toolButtons) {
      btn.classList.toggle('selected', t === tool);
    }
  }

  setSelectedAlgorithm(algorithm: PheromoneAlgorithm): void {
    for (const [a, btn] of this.algorithmButtons) {
      btn.classList.toggle('selected', a === algorithm);
    }
    this.algorithmEl.textContent = `Algorithm: ${algorithm}`;
  }

  updateStats(fps: number, antCount: number): void {
    this.statsEl.textContent = `${fps.toFixed(0)} FPS · ${antCount} ants`;
  }
}
