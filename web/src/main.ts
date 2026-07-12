import { Application } from 'pixi.js';
import type { PheromoneAlgorithm } from './core/config';
import { defaultConfig } from './core/config';
import { type GameMode, Simulation } from './core/simulation';
import { SimulationRenderer } from './render/renderer';
import { loadTextures } from './render/textures';
import { UndergroundRenderer } from './render/undergroundRenderer';
import { Panel, type Tool, type ViewLayer } from './ui/panel';
import { SaveLoadWindow } from './ui/saveLoadWindow';
import { StatsOverlay } from './ui/statsOverlay';

const IDEAL_CONTENT_HEIGHT = 720;
const NUM_ANTS_DESKTOP = 1500;
const NUM_ANTS_MOBILE = 600;
/** Cell tools that only place one thing per click; dragging them would spam duplicates. */
const CLICK_ONLY_TOOLS = new Set<Tool>([]);

async function main(): Promise<void> {
  const canvasHost = document.getElementById('canvas-host') as HTMLDivElement;
  const panelHost = document.getElementById('panel') as HTMLDivElement;

  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const numAnts = isCoarsePointer ? NUM_ANTS_MOBILE : NUM_ANTS_DESKTOP;

  const app = new Application();
  await app.init({
    resizeTo: canvasHost,
    backgroundColor: 0x000000,
    antialias: false,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  canvasHost.appendChild(app.canvas);

  const textures = await loadTextures('images');
  const statsOverlay = new StatsOverlay(canvasHost);

  let sim: Simulation;
  let renderer: SimulationRenderer;
  let undergroundRenderer: UndergroundRenderer;
  let showPheromones = false;
  let currentLayer: ViewLayer = 'surface';

  const updateContentScale = () => {
    renderer.camera.contentScale = app.renderer.height / IDEAL_CONTENT_HEIGHT;
  };

  const applyLayerVisibility = () => {
    renderer.visible = currentLayer === 'surface';
    undergroundRenderer.visible = currentLayer === 'underground';
    statsOverlay.visible = currentLayer === 'stats';
  };

  /** Swaps in an already-constructed (and initialized) Simulation, rebuilding the renderers to
   * point at it and preserving the current camera view when one already exists (so switching
   * modes or loading a save doesn't jolt you back to the default zoom/pan). The underground
   * renderer shares the surface renderer's camera, so panning/zooming stays in sync between the
   * two overlays. Does *not* handle algorithm changes — see `onAlgorithmChange` below, which
   * hot-swaps the live config instead of going through here at all. */
  function installSimulation(newSim: Simulation): void {
    const previousCamera = renderer?.camera;
    sim = newSim;

    renderer?.destroy();
    undergroundRenderer?.destroy();
    renderer = new SimulationRenderer(app, sim, textures);
    renderer.showPheromones = showPheromones;
    undergroundRenderer = new UndergroundRenderer(app, sim, textures, renderer.camera);
    applyLayerVisibility();

    if (previousCamera) {
      renderer.camera.translation = previousCamera.translation;
      renderer.camera.scale = previousCamera.scale;
      renderer.camera.contentScale = previousCamera.contentScale;
    } else {
      renderer.camera.scale = 2;
      updateContentScale();
      // center the initial view on the colony entrance, not the unrelated world origin
      const s = renderer.camera.scale * renderer.camera.contentScale;
      renderer.camera.translation = {
        x: app.renderer.width / 2 - sim.cavePosition.x * s,
        y: app.renderer.height / 2 - sim.cavePosition.y * s,
      };
    }
  }

  /** Builds a brand-new colony for the given mode/algorithm and installs it — used for the
   * initial boot and for mode switches, both of which really do need a fresh Simulation (unlike
   * an algorithm change on its own). */
  function startFresh(mode: GameMode, algorithm: PheromoneAlgorithm): void {
    const cfg = { ...defaultConfig, pheromoneAlgorithm: algorithm };
    const newSim = new Simulation(cfg);
    if (mode === 'gameplay') newSim.initGameplay();
    else newSim.init(numAnts);
    installSimulation(newSim);
  }

  startFresh('testing', defaultConfig.pheromoneAlgorithm);
  window.addEventListener('resize', updateContentScale);

  let currentTool: Tool = 'pan';
  const panel = new Panel(panelHost, {
    onToolChange: (tool) => {
      currentTool = tool;
    },
    onZoom: (delta) => {
      renderer.camera.zoomOrigin = { x: app.renderer.width / 2, y: app.renderer.height / 2 };
      renderer.camera.zoom(delta);
    },
    onTogglePheromones: (show) => {
      showPheromones = show;
      renderer.showPheromones = show;
    },
    // hot-swapped on the *running* colony instead of restarting — `sim.config` is read fresh
    // every frame throughout the simulation, so just mutating the live field is enough (`config`
    // itself is a readonly binding, but nothing stops mutating a field on the object it points
    // at). A restart here would throw away an in-progress 'gameplay' colony every time you just
    // wanted to compare algorithms.
    onAlgorithmChange: (algorithm) => {
      sim.config.pheromoneAlgorithm = algorithm;
    },
    onLayerChange: (layer) => {
      currentLayer = layer;
      applyLayerVisibility();
    },
    onModeChange: (mode) => {
      startFresh(mode, sim.config.pheromoneAlgorithm);
    },
    onOpenSaveLoad: () => {
      saveLoadWindow.show();
    },
  });
  panel.setSelectedAlgorithm(defaultConfig.pheromoneAlgorithm);

  const saveLoadWindow = new SaveLoadWindow(document.body, () => sim, {
    onLoad: (loadedSim) => {
      installSimulation(loadedSim);
      panel.setSelectedAlgorithm(loadedSim.config.pheromoneAlgorithm);
      panel.setSelectedMode(loadedSim.gameMode);
    },
  });
  // `resizeTo: canvasHost` took its first snapshot back at app.init(), before the panel above had
  // any content — on the mobile stacked layout the panel's height is content-driven, so that
  // snapshot was of a not-yet-final canvas-host box (its empty panel sibling briefly ceded it
  // nearly the whole column). Force one correction now that the real panel height exists.
  app.renderer.resize(canvasHost.clientWidth, canvasHost.clientHeight);
  updateContentScale();

  const paintAt = (clientX: number, clientY: number) => {
    const rect = app.canvas.getBoundingClientRect();
    const world = renderer.camera.screenToWorld(clientX - rect.left, clientY - rect.top);
    sim.setCell(currentTool as Exclude<Tool, 'pan'>, world);
  };

  let pointerDown = false;
  let lastX = 0;
  let lastY = 0;

  app.canvas.addEventListener('pointerdown', (e) => {
    pointerDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    app.canvas.setPointerCapture(e.pointerId);

    if (currentTool !== 'pan' && e.button === 0) {
      paintAt(e.clientX, e.clientY);
    }
  });

  app.canvas.addEventListener('pointermove', (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    const panning = currentTool === 'pan' || e.buttons === 2 || e.buttons === 4;
    if (panning) {
      renderer.camera.pan(dx, dy);
    } else if (e.buttons === 1 && !CLICK_ONLY_TOOLS.has(currentTool)) {
      paintAt(e.clientX, e.clientY);
    }
  });

  const stopDrag = () => {
    pointerDown = false;
  };
  app.canvas.addEventListener('pointerup', stopDrag);
  app.canvas.addEventListener('pointercancel', stopDrag);
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  app.canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = app.canvas.getBoundingClientRect();
      renderer.camera.zoomOrigin = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      renderer.camera.zoom(-e.deltaY * 0.002);
    },
    { passive: false },
  );

  app.ticker.add(() => {
    sim.update();
    renderer.render();
    undergroundRenderer.render();
    statsOverlay.update(sim);
    panel.updateStats(app.ticker.FPS, sim.ants.length);
  });
}

main().catch((err) => {
  console.error('Failed to start the simulation', err);
});
