// Generated from src/shared/atomic-json.ts. Edit the source and run npm run build.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function writeJsonAtomic(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, file);
    return file;
}
