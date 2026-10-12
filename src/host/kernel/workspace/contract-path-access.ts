import { existsSync, lstatSync, realpathSync } from 'node:fs';

export const contractPathAccess = Object.freeze({
  resolveRealpath: realpathSync,
  checkExists: existsSync,
  lstatPath: lstatSync,
});
