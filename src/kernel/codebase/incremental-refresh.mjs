import { buildCodebaseIndex } from './build-index.mjs';

export const incrementalRefresh = (options = {}) => buildCodebaseIndex({ ...options, force: false });
