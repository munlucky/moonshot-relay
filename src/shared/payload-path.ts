// Python execution caches are generated state, never managed payload source.
export const isGeneratedPythonArtifact = (filePath: string): boolean => {
  const segments = filePath.replaceAll('\\', '/').split('/');
  return segments.includes('__pycache__') || /\.py[co]$/i.test(segments.at(-1) || '');
};
