import { loadApiConfig } from './config.js';
import { createApiRuntime } from './app.js';

export * from './config.js';
export * from './openapi.js';
export * from './app.js';

export async function startApi(): Promise<void> {
  const config = loadApiConfig();
  const runtime = await createApiRuntime(config);
  runtime.app.listen(config.port, () => undefined);
}

if (process.argv[1]?.endsWith('/index.js')) {
  startApi().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'API startup failed'}\n`);
    process.exitCode = 1;
  });
}
