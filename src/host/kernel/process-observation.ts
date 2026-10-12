export interface HostProcessObservation {
  currentPid: number;
  isProcessAlive(pid: number): boolean;
}

export const createHostProcessObservation = (): HostProcessObservation => ({
  currentPid: process.pid,

  isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'EPERM',
      );
    }
  },
});
