// Node-only loader for the real grid packs (lane b11): tests and tools load site/data/grid/* from disk with the
// same loadGrid() the worker uses. Never imported by the worker or the page.
//   diskFetch(dataDir) -> fetchBinary(path) for loadGrid
//   loadPacks(names = ['wide', 'fine'], {dataDir, layers}) -> G = { wide, fine } (a missing pack is left out)
//   packsPresent(name, dataDir) -> boolean
import { loadGrid } from './grid.js';

export const DATA_DIR = new URL('../../data/', import.meta.url);

const toDir = (d) => (d instanceof URL ? d : new URL(String(d).endsWith('/') ? 'file://' + d : 'file://' + d + '/'));

export function diskFetch(dataDir = DATA_DIR) {
  const base = toDir(dataDir);
  return async (path) => {
    const { readFile } = await import('node:fs/promises');
    const b = await readFile(new URL(path, base));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
}

export async function packsPresent(name, dataDir = DATA_DIR) {
  const { access } = await import('node:fs/promises');
  try {
    await access(new URL(`grid/${name}.json`, toDir(dataDir)));
    await access(new URL(`grid/${name}.dir.u8`, toDir(dataDir)));
    return true;
  } catch {
    return false;
  }
}

export async function loadPacks(names = ['wide', 'fine'], { dataDir = DATA_DIR, layers } = {}) {
  const G = {};
  const fetchBinary = diskFetch(dataDir);
  for (const name of names) {
    if (!(await packsPresent(name, dataDir))) continue;
    G[name] = await loadGrid(name, fetchBinary, layers ? { layers } : {});
  }
  return G;
}
