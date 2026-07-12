import { Simulation, type SaveData } from './simulation';

const STORAGE_PREFIX = 'locas-ormigas-save-';
/** "4 gameplays" — a small, fixed number of slots is simpler to reason about (as a player and in
 * the UI) than an open-ended list, and matches how most games' save systems work. */
export const SAVE_SLOT_COUNT = 4;

export interface SaveSlotMeta {
  index: number;
  /** null = the slot is empty. */
  name: string | null;
  savedAt: number | null;
  frame: number | null;
  gameMode: SaveData['gameMode'] | null;
}

interface StoredSlot {
  name: string;
  savedAt: number;
  data: SaveData;
}

function slotKey(index: number): string {
  return `${STORAGE_PREFIX}${index}`;
}

function readSlot(index: number): StoredSlot | null {
  const raw = localStorage.getItem(slotKey(index));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSlot;
  } catch {
    return null; // corrupted/foreign value under our key — treat as empty rather than throwing
  }
}

/** Current state of all `SAVE_SLOT_COUNT` slots, for rendering the save/load window. */
export function listSaveSlots(): SaveSlotMeta[] {
  return Array.from({ length: SAVE_SLOT_COUNT }, (_, index) => {
    const slot = readSlot(index);
    return {
      index,
      name: slot?.name ?? null,
      savedAt: slot?.savedAt ?? null,
      frame: slot?.data.frame ?? null,
      gameMode: slot?.data.gameMode ?? null,
    };
  });
}

const NAME_ADJECTIVES = ['Wandering', 'Diligent', 'Restless', 'Golden', 'Hidden', 'Sunlit', 'Quiet', 'Bold', 'Tireless', 'Ancient', 'Humming', 'Stubborn'];
const NAME_NOUNS = ['Hive', 'Colony', 'Nest', 'Warren', 'Anthill', 'Burrow', 'Formicary', 'Mound'];

/** A short, ant-colony-themed name rather than a raw ID — the numeric suffix just keeps repeats
 * from colliding, not for the player to actually read as meaningful. */
export function generateSaveName(): string {
  const adjective = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
  const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${adjective} ${noun} #${suffix}`;
}

/** Saves `sim`'s current state into `index`, overwriting whatever was there — slots are meant to
 * be overwritten, not confirmed one at a time (matches "just buttons": press a slot, it saves).
 * Returns the freshly-generated name. */
export function saveToSlot(index: number, sim: Simulation): string {
  const name = generateSaveName();
  const stored: StoredSlot = { name, savedAt: Date.now(), data: sim.toSaveData() };
  localStorage.setItem(slotKey(index), JSON.stringify(stored));
  return name;
}

/** Loads `index` into a fresh `Simulation`, or null if the slot is empty/corrupted. */
export function loadFromSlot(index: number): Simulation | null {
  const slot = readSlot(index);
  if (!slot) return null;
  return Simulation.fromSaveData(slot.data);
}
