// Shared test harness for film-state.js — runs the content-script registry in a
// node:vm sandbox with a mock chrome.storage. Used by the film-state unit specs.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const filmStatePath = fileURLToPath(new URL('../../film-state.js', import.meta.url));
const filmStateSource = fs.readFileSync(filmStatePath, 'utf8');

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

export function waitForDebounce(ms = 350) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createStorageArea(initial = {}) {
  const store = clone(initial) || {};
  return {
    store,
    get(keys, callback) {
      const result = {};
      if (Array.isArray(keys)) {
        for (const key of keys) result[key] = clone(store[key]);
      } else if (typeof keys === 'string') {
        result[keys] = clone(store[keys]);
      } else if (keys && typeof keys === 'object') {
        for (const [key, defaultValue] of Object.entries(keys)) {
          result[key] = key in store ? clone(store[key]) : clone(defaultValue);
        }
      } else {
        Object.assign(result, clone(store));
      }
      callback(result);
    },
    set(items, callback) {
      Object.assign(store, clone(items));
      callback?.();
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete store[key];
      callback?.();
    }
  };
}

export function createFilmStateRuntime(localInitial = {}, syncInitial = {}, sharedAreas = null) {
  const sentMessages = [];
  const localArea = sharedAreas?.local || createStorageArea(localInitial);
  const syncArea = sharedAreas?.sync || createStorageArea(syncInitial);
  const context = {
    console,
    setTimeout,
    clearTimeout,
    window: {},
    chrome: {
      storage: { local: localArea, sync: syncArea },
      runtime: {
        sendMessage(message) { sentMessages.push(clone(message)); }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(filmStateSource, context, { filename: filmStatePath });
  return {
    api: context.window.VypodeFilmState,
    localStore: localArea.store,
    syncStore: syncArea.store,
    sentMessages
  };
}
