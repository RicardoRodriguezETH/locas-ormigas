import { Application } from 'pixi.js';
import type { PheromoneAlgorithm } from './core/config';
import { defaultConfig } from './core/config';
import { Simulation } from './core/simulation';
import { SimulationRenderer } from './render/renderer';
import { loadTextures } from './render/textures';
import { Panel, type Tool } from './ui/panel';

const IDEAL_CONTENT_HEIGHT = 720;
const NUM_ANTS_DESKTOP = 1500;
const NUM_ANTS_MOBILE = 600;
/** Cell tools that only place one thing per click; dragging them would spam duplicates. */
const CLICK_ONLY_TOOLS = new Set<Tool>(['cave', 'portal']);

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

  let sim: Simulation;
  let renderer: SimulationRenderer;
  let showPheromones = false;

  const updateContentScale = () => {
    renderer.camera.contentScale = app.renderer.height / IDEAL_CONTENT_HEIGHT;
  };

  /** (Re)creates the simulation and its renderer for the given algorithm, preserving the
   * current camera view when one already exists (so switching algorithms doesn't jolt you
   * back to the default zoom/pan). */
  function startSimulation(algorithm: PheromoneAlgorithm): void {
    const previousCamera = renderer?.camera;

    const cfg = { ...defaultConfig, pheromoneAlgorithm: algorithm };
    sim = new Simulation(cfg);
    sim.init(numAnts);

    renderer?.destroy();
    renderer = new SimulationRenderer(app, sim, textures);
    renderer.showPheromones = showPheromones;

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

  startSimulation(defaultConfig.pheromoneAlgorithm);
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
    onAlgorithmChange: (algorithm) => {
      startSimulation(algorithm);
    },
  });
  panel.setSelectedAlgorithm(defaultConfig.pheromoneAlgorithm);

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
    panel.updateStats(app.ticker.FPS, sim.ants.length);
  });
}

main().catch((err) => {
  console.error('Failed to start the simulation', err);
});
