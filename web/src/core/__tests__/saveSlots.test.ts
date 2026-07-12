import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { generateSaveName, listSaveSlots, loadFromSlot, SAVE_SLOT_COUNT, saveToSlot } from '../saveSlots';
import { Simulation } from '../simulation';

/** Node has no built-in `localStorage`; a minimal in-memory stand-in is enough for these tests. */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();
});

describe('generateSaveName', () => {
  it('produces a non-empty, human-readable name', () => {
    const name = generateSaveName();
    expect(name.length).toBeGreaterThan(0);
    expect(name).toMatch(/^[A-Za-z]+ [A-Za-z]+ #\d+$/);
  });
});

describe('save slots', () => {
  it('reports all slots empty before anything is saved', () => {
    const slots = listSaveSlots();
    expect(slots).toHaveLength(SAVE_SLOT_COUNT);
    expect(slots.every((s) => s.name === null)).toBe(true);
  });

  it('saves into a slot, then loads an equivalent simulation back out', () => {
    const sim = new Simulation(defaultConfig, { randomizeGrid: false });
    sim.initGameplay();
    for (let i = 0; i < 50; i++) sim.update();

    const name = saveToSlot(2, sim);
    expect(name.length).toBeGreaterThan(0);

    const slots = listSaveSlots();
    expect(slots[2].name).toBe(name);
    expect(slots[2].frame).toBe(sim.frame);
    expect(slots[2].gameMode).toBe('gameplay');
    expect(slots.filter((s) => s.name !== null)).toHaveLength(1);

    const loaded = loadFromSlot(2);
    expect(loaded).not.toBeNull();
    expect(loaded!.frame).toBe(sim.frame);
    expect(loaded!.ants).toHaveLength(sim.ants.length);
  });

  it('returns null loading an empty slot', () => {
    expect(loadFromSlot(0)).toBeNull();
  });

  it('overwrites a slot on a second save, replacing its name', () => {
    const sim = new Simulation(defaultConfig, { randomizeGrid: false });
    sim.initGameplay();

    saveToSlot(0, sim);
    for (let i = 0; i < 100; i++) sim.update();
    const secondName = saveToSlot(0, sim);

    const slots = listSaveSlots();
    expect(slots[0].name).toBe(secondName);
    expect(slots[0].frame).toBe(100);
    expect(slots.filter((s) => s.name !== null)).toHaveLength(1);
  });
});
