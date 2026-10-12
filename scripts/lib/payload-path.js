// Generated from src/shared/payload-path.ts. Edit the source and run npm run build.
// Python execution caches are generated state, never managed payload source.
export const isGeneratedPythonArtifact = (filePath) => {
    const segments = filePath.replaceAll('\\', '/').split('/');
    return segments.includes('__pycache__') || /\.py[co]$/i.test(segments.at(-1) || '');
};
