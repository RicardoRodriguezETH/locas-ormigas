import { listSaveSlots, loadFromSlot, type SaveSlotMeta, saveToSlot } from '../core/saveSlots';
import type { Simulation } from '../core/simulation';

export interface SaveLoadCallbacks {
  /** The freshly-restored Simulation to swap in — this window doesn't touch the running game
   * itself, just hands the result back. */
  onLoad(sim: Simulation): void;
}

type Tab = 'save' | 'load';

function formatTimeAgo(savedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A small modal over the four fixed save slots (see `core/saveSlots.ts`) — a "Save" tab whose
 * buttons overwrite that slot with whatever's currently running, and a "Load" tab whose buttons
 * swap in that slot's game. Reads `getCurrentSimulation()` fresh each time Save is pressed
 * rather than being handed a live reference up front, since `main.ts` may swap the running
 * Simulation out entirely between window opens (a mode switch, or an earlier load). */
export class SaveLoadWindow {
  private readonly backdrop: HTMLDivElement;
  private readonly slotsRow: HTMLDivElement;
  private readonly saveTabButton: HTMLButtonElement;
  private readonly loadTabButton: HTMLButtonElement;
  private tab: Tab = 'save';
  private readonly getCurrentSimulation: () => Simulation;
  private readonly callbacks: SaveLoadCallbacks;

  constructor(host: HTMLElement, getCurrentSimulation: () => Simulation, callbacks: SaveLoadCallbacks) {
    this.getCurrentSimulation = getCurrentSimulation;
    this.callbacks = callbacks;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.hide();
    });

    const card = document.createElement('div');
    card.className = 'modal-card';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Save / Load';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'modal-close';
    closeButton.textContent = '✕';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.addEventListener('click', () => this.hide());
    header.append(title, closeButton);

    const tabRow = document.createElement('div');
    tabRow.className = 'panel-group panel-row';
    const saveTabButton = document.createElement('button');
    saveTabButton.type = 'button';
    saveTabButton.className = 'tool-button';
    saveTabButton.textContent = 'Save';
    saveTabButton.addEventListener('click', () => this.setTab('save'));
    const loadTabButton = document.createElement('button');
    loadTabButton.type = 'button';
    loadTabButton.className = 'tool-button';
    loadTabButton.textContent = 'Load';
    loadTabButton.addEventListener('click', () => this.setTab('load'));
    tabRow.append(saveTabButton, loadTabButton);
    this.saveTabButton = saveTabButton;
    this.loadTabButton = loadTabButton;

    const slotsRow = document.createElement('div');
    slotsRow.className = 'modal-slots';
    this.slotsRow = slotsRow;

    card.append(header, tabRow, slotsRow);
    backdrop.appendChild(card);
    host.appendChild(backdrop);
    this.backdrop = backdrop;
  }

  show(): void {
    this.tab = 'save';
    this.backdrop.classList.add('visible');
    this.render();
  }

  private hide(): void {
    this.backdrop.classList.remove('visible');
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
    this.render();
  }

  private render(): void {
    this.saveTabButton.classList.toggle('selected', this.tab === 'save');
    this.loadTabButton.classList.toggle('selected', this.tab === 'load');
    this.slotsRow.replaceChildren(...listSaveSlots().map((slot) => this.renderSlotButton(slot)));
  }

  private renderSlotButton(slot: SaveSlotMeta): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'modal-slot-button';

    const nameEl = document.createElement('div');
    nameEl.className = 'modal-slot-name';
    nameEl.textContent = slot.name ?? `Empty slot ${slot.index + 1}`;

    const metaEl = document.createElement('div');
    metaEl.className = 'modal-slot-meta';
    if (slot.name && slot.savedAt !== null) {
      const suffix = this.tab === 'save' ? ' — click to overwrite' : '';
      metaEl.textContent = `Frame ${slot.frame} · ${slot.gameMode} · ${formatTimeAgo(slot.savedAt)}${suffix}`;
    } else {
      metaEl.textContent = this.tab === 'save' ? 'Click to save here' : 'Empty';
    }

    button.append(nameEl, metaEl);
    if (this.tab === 'load' && !slot.name) {
      button.disabled = true;
    } else {
      button.addEventListener('click', () => this.handleSlotClick(slot.index));
    }
    return button;
  }

  private handleSlotClick(index: number): void {
    if (this.tab === 'save') {
      saveToSlot(index, this.getCurrentSimulation());
      this.render();
    } else {
      const loaded = loadFromSlot(index);
      if (!loaded) return;
      this.callbacks.onLoad(loaded);
      this.hide();
    }
  }
}
