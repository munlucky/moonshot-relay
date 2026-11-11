// Paths are materialized by the existing account-root installer.
const runtimeHome = '__MOONSHOT_RELAY_HOME__';
const { main } = await import('__MOONSHOT_RELAY_IO_HOOK_URL__');
await main(runtimeHome, __IO_READER_MIN_LINES__);
