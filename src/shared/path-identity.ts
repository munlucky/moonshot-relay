import path from 'node:path';

export const canonicalPathIdentity = (
  value: unknown,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): string => {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalized = pathApi.normalize(raw.replaceAll('\\', '/')).replaceAll('\\', '/');
  const relative = normalized.replace(/^\.\/+/, '') || '.';
  return platform === 'win32' ? relative.toLowerCase() : relative;
};

type DrivePathIdentity = {
  drive: string;
  suffix: string;
  surface: 'windows' | 'mounted';
};

const windowsReservedName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

const validWindowsPathComponent = (component: string): boolean => (
  Boolean(component)
  && !/[<>:"|?*\u0000-\u001f\u007f]/.test(component)
  && !/[. ]$/.test(component)
  && !windowsReservedName.test(component)
);

const drivePathIdentity = (value: unknown): DrivePathIdentity | null => {
  if (value === null || value === undefined) return null;
  const original = String(value);
  if (!original) return null;
  // Windows drive-relative paths such as C: are not drive roots. Cross-surface
  // identity requires an absolute drive path with an explicit slash. Detect the
  // Windows surface before changing separators: on POSIX, a backslash is a
  // filename character and must never turn a mounted path into ownership proof.
  const rawWindows = original.match(/^([a-z]):[\\/](.*)$/i);
  if (rawWindows) {
    if (original !== original.trim()) return null;
    const rawSuffix = String(rawWindows[2] || '').replaceAll('\\', '/');
    const rawComponents = rawSuffix.split('/').filter(Boolean);
    if (rawComponents.some((component) => (
      component === '.'
      || component === '..'
      || !validWindowsPathComponent(component)
    ))) {
      return null;
    }
    const normalizedWindows = path.win32.normalize(original).replaceAll('\\', '/');
    const windows = normalizedWindows.match(/^([a-z]):\/(.*)$/i);
    if (!windows) return null;
    return {
      drive: String(windows[1]).toLowerCase(),
      suffix: String(windows[2] || '').replace(/\/+/g, '/').replace(/\/+$/, ''),
      surface: 'windows',
    };
  }
  // Mounted spellings are POSIX paths. Leading/trailing whitespace is a
  // filename character there, not input decoration, so it cannot participate
  // in Windows cross-surface ownership equivalence.
  if (original !== original.trim()) return null;
  const normalized = original.replace(/\/+$/, '');
  if (normalized.includes('\\')) return null;
  const mounted = normalized.match(/^\/(?:mnt\/)?([a-z])(?:\/(.*))?$/);
  if (!mounted) return null;
  return {
    drive: String(mounted[1]),
    suffix: String(mounted[2] || '').replace(/\/+/g, '/'),
    surface: 'mounted',
  };
};

export const isValidWindowsAbsolutePathIdentity = (value: unknown): boolean => (
  drivePathIdentity(value)?.surface === 'windows'
);

export const samePathSurfaceIdentity = (
  left: unknown,
  right: unknown,
): boolean => {
  const leftDrive = drivePathIdentity(left);
  const rightDrive = drivePathIdentity(right);
  if (leftDrive?.surface === 'windows' || rightDrive?.surface === 'windows') {
    if (leftDrive?.surface !== 'windows' || rightDrive?.surface !== 'windows') return false;
    return leftDrive.drive.toLowerCase() === rightDrive.drive.toLowerCase()
      && leftDrive.suffix.toLowerCase() === rightDrive.suffix.toLowerCase();
  }
  const leftRaw = left === null || left === undefined ? '' : String(left);
  const rightRaw = right === null || right === undefined ? '' : String(right);
  if (leftRaw !== leftRaw.trim() || rightRaw !== rightRaw.trim()) {
    return leftRaw === rightRaw;
  }
  return path.posix.normalize(leftRaw) === path.posix.normalize(rightRaw);
};

export const sameCrossSurfacePathIdentity = (
  left: unknown,
  right: unknown,
): boolean => {
  const leftDrive = drivePathIdentity(left);
  const rightDrive = drivePathIdentity(right);
  if (
    leftDrive
    && rightDrive
    && (leftDrive.surface === 'windows' || rightDrive.surface === 'windows')
  ) {
    return leftDrive.drive.toLowerCase() === rightDrive.drive.toLowerCase()
      && leftDrive.suffix.toLowerCase() === rightDrive.suffix.toLowerCase();
  }
  const leftRaw = left === null || left === undefined ? '' : String(left);
  const rightRaw = right === null || right === undefined ? '' : String(right);
  if (leftRaw.startsWith('/') && rightRaw.startsWith('/')) {
    return path.posix.normalize(leftRaw) === path.posix.normalize(rightRaw);
  }
  if (leftRaw !== leftRaw.trim() || rightRaw !== rightRaw.trim()) return false;
  // Relative POSIX paths keep backslash as a literal character. Do not route
  // them through canonicalPathIdentity(), whose provider-facing normalization
  // intentionally treats backslash as a separator.
  return path.posix.normalize(leftRaw) === path.posix.normalize(rightRaw);
};
