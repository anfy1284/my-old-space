const crypto = require('crypto');

// Try to locate memory_store in project modules (compatible with existing codebase)
let memoryStore = null;
try {
  memoryStore = require('../drive_root/memory_store');
} catch (e) {
  try {
    memoryStore = require('../../node_modules/my-old-space/drive_root/memory_store');
  } catch (e2) {
    memoryStore = null;
  }
}

function generateId() {
  return crypto.randomBytes(12).toString('hex') + '-' + Date.now().toString(36);
}

function storeDataset(payload, namespace = 'datasets') {
  try {
    const id = generateId();
    try {
      if (memoryStore && memoryStore._MEM) {
        if (!memoryStore._MEM.has(namespace)) memoryStore._MEM.set(namespace, new Map());
        memoryStore._MEM.get(namespace).set(id, { value: JSON.parse(JSON.stringify(payload)), created: Date.now(), modified: Date.now() });
      }
    } catch (err) {
      if (memoryStore && memoryStore._MEM) {
        if (!memoryStore._MEM.has(namespace)) memoryStore._MEM.set(namespace, new Map());
        memoryStore._MEM.get(namespace).set(id, { value: payload, created: Date.now(), modified: Date.now() });
      }
    }

    if (memoryStore && memoryStore.set) {
      try { memoryStore.set(namespace, id, payload).catch(() => {}); } catch (_) {}
    }

    return id;
  } catch (e) {
    try { console.error('[dataApp] storeDataset error', e); } catch (_) {}
    return null;
  }
}

async function getDataset(id, namespace = 'datasets') {
  try {
    if (!id) return null;
    if (!memoryStore) return null;

    try {
      if (memoryStore.getSync && memoryStore.getSync(namespace, id) !== null) {
        return memoryStore.getSync(namespace, id);
      }
    } catch (e) {}

    try {
      if (memoryStore.get) return await memoryStore.get(namespace, id);
    } catch (e) {}

    return null;
  } catch (e) {
    try { console.error('[dataApp] getDataset error', e); } catch (_) {}
    return null;
  }
}

const dataApp = {
  generateId,
  storeDataset,
  getDataset,
  memoryStore
};

module.exports = { dataApp };
