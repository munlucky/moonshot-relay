import path from 'node:path';
import { mkdir, open, rename, rm } from 'node:fs/promises';

const syncDirectory = async (directory) => {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows and some filesystem providers do not expose directory fsync.
    // The file itself is still flushed and atomically replaced; only ignore
    // the platform-level "directory sync unavailable" cases.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
};

export const atomicWriteText = async (file, value) => {
  const target = path.resolve(file);
  const directory = path.dirname(target);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(directory, { recursive: true });
  let handle;
  try {
    handle = await open(temporary, 'w');
    await handle.writeFile(String(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return target;
};
