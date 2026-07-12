import type { PheromoneAlgorithm } from '../core/config';
import type { PaintableCellType } from '../core/grid';
import type { GameMode } from '../core/simulation';

export type Tool = 'pan' | PaintableCellType;
export type ViewLayer = 'surface' | 'underground' | 'stats';

const LAYERS: Array<{ layer: ViewLayer; label: string }> = [
  { layer: 'surface', label: 'Earth' },
  { layer: 'underground', label: 'Underground' },
  { layer: 'stats', label: 'Stats' },
];

const MODES: Array<{ mode: GameMode; label: string }> = [
  { mode: 'testing', label: 'Testing' },
  { mode: 'gameplay', label: 'Gameplay' },
];

const TOOLS: Array<{ tool: Tool; label: string }> = [
  { tool: 'pan', label: 'Pan view' },
  { tool: 'block', label: 'Block' },
  { tool: 'grass', label: 'Grass' },
  { tool: 'food', label: 'Food' },
  { tool: 'ground', label: 'Remove' },
];

const ALGORITHMS: Array<{ algorithm: PheromoneAlgorithm; label: string }> = [
  { algorithm: 'legacy', label: 'Legacy' },
  { algorithm: 'legacy+', label: 'Legacy+' },
  { algorithm: 'gradient', label: 'Gradient' },
  { algorithm: 'flow', label: 'Flow' },
  { algorithm: 'diffusion', label: 'Diffusion' },
];

export interface PanelCallbacks {
  onToolChange(tool: Tool): void;
  onZoom(delta: number): void;
  onTogglePheromones(show: boolean): void;
  onAlgorithmChange(algorithm: PheromoneAlgorithm): void;
  onLayerChange(layer: ViewLayer): void;
  onModeChange(mode: GameMode): void;
  onOpenSaveLoad(): void;
}

/** The left-hand tool sidebar: cell-painting tools, zoom controls, and live stats. Plain DOM
 * rather than a canvas-drawn UI, so it composes cleanly with normal web layout/accessibility. */
export class Panel {
  selectedTool: Tool = 'pan';

  private readonly statsEl: HTMLDivElement;
  private readonly algorithmEl: HTMLDivElement;
  private readonly modeBadgeEl: HTMLDivElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly algorithmButtons = new Map<PheromoneAlgorithm, HTMLButtonElement>();
  private readonly layerButtons = new Map<ViewLayer, HTMLButtonElement>();
  private readonly modeButtons = new Map<GameMode, HTMLButtonElement>();

  constructor(host: HTMLElement, callbacks: PanelCallbacks) {
    host.replaceChildren();

    // topmost and its own distinct badge style — "clearly visible" is the whole point, so this
    // isn't just another same-looking label among the others.
    const modeBadge = document.createElement('div');
    modeBadge.className = 'panel-mode-badge';
    host.appendChild(modeBadge);
    this.modeBadgeEl = modeBadge;

    const stats = document.createElement('div');
    stats.className = 'panel-stats';
    host.appendChild(stats);
    this.statsEl = stats;

    const modeHeading = document.createElement('div');
    modeHeading.className = 'panel-heading';
    modeHeading.textContent = 'Game mode';
    host.appendChild(modeHeading);

    const modeGroup = document.createElement('div');
    modeGroup.className = 'panel-group panel-row';
    for (const { mode, label } of MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-button';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.setSelectedMode(mode);
        callbacks.onModeChange(mode);
      });
      modeGroup.appendChild(btn);
      this.modeButtons.set(mode, btn);
    }
    host.appendChild(modeGroup);
    this.setSelectedMode('testing');

    const saveLoadButton = document.createElement('button');
    saveLoadButton.type = 'button';
    saveLoadButton.className = 'tool-button';
    saveLoadButton.textContent = 'Save / Load…';
    saveLoadButton.addEventListener('click', () => callbacks.onOpenSaveLoad());
    host.appendChild(saveLoadButton);

    const layerGroup = document.createElement('div');
    layerGroup.className = 'panel-group panel-row';
    for (const { layer, label } of LAYERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tool-button';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.setSelectedLayer(layer);
        callbacks.onLayerChange(layer);
      });
      layerGroup.appendChild(btn);
      this.layerButtons.set(layer, btn);
    }
    host.appendChild(layerGroup);
    this.setSelectedLayer('surface');

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

  setSelectedLayer(layer: ViewLayer): void {
    for (const [l, btn] of this.layerButtons) {
      btn.classList.toggle('selected', l === layer);
    }
  }

  setSelectedMode(mode: GameMode): void {
    for (const [m, btn] of this.modeButtons) {
      btn.classList.toggle('selected', m === mode);
    }
    this.modeBadgeEl.textContent = mode === 'gameplay' ? 'Gameplay' : 'Testing';
    this.modeBadgeEl.classList.toggle('gameplay', mode === 'gameplay');
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
