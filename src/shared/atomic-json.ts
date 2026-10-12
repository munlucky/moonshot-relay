import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeJsonAtomic(file: string, value: unknown): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
  return file;
}
