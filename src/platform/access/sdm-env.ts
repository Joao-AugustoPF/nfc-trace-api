import { config as loadEnv } from 'dotenv';

export function loadSdmEnv(): void {
  if (
    !process.env.SDM_ENV_FILE ||
    (process.env.SDM_ACTIVE_MASTER_VERSION && process.env.SDM_MASTER_KEYS_JSON)
  )
    return;
  const privateEnv: NodeJS.ProcessEnv = {};
  const result = loadEnv({ quiet: true, path: process.env.SDM_ENV_FILE, processEnv: privateEnv });
  if (result.error) throw new Error('Private SDM configuration could not be loaded');
  // The private file cannot change database, HTTP, authentication or other runtime settings.
  for (const name of ['SDM_ACTIVE_MASTER_VERSION', 'SDM_MASTER_KEYS_JSON'])
    if (!process.env[name]) process.env[name] = privateEnv[name];
}
