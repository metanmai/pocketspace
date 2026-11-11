const prefix = 'pocketspace-output-';
export const diskThreshold = 64 * 1024 * 1024;
let storage;

async function openStorage() {
  if (!navigator.storage?.getDirectory || !navigator.locks) {
    throw new Error('Local scratch storage is unavailable.');
  }
  const root = await navigator.storage.getDirectory();
  for await (const name of root.keys()) {
    if (!name.startsWith(prefix)) continue;
    await navigator.locks.request(name, { ifAvailable: true }, async lock => {
      if (lock) await root.removeEntry(name).catch(() => {});
    });
  }
  return root;
}

export async function createDiskOutput() {
  const root = await (storage ??= openStorage());
  const name = prefix + crypto.randomUUID();
  let release;
  let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const lease = navigator.locks.request(name, () => {
    acquired();
    return held;
  });
  await Promise.race([ready, lease]);
  let writable;
  const dispose = async () => {
    try {
      await writable?.abort().catch(() => {});
      await root.removeEntry(name).catch(() => {});
    } finally {
      release();
    }
  };
  try {
    const handle = await root.getFileHandle(name, { create: true });
    writable = await handle.createWritable();
    return {
      writable,
      async blob(type) {
        const file = await handle.getFile();
        return file.slice(0, file.size, type);
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
