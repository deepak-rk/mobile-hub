import { buildApp } from './app';
import { connectDB } from './db/connection';
import { env } from './config/env';
import { loadEffectiveConfig } from './config/config.service';
import { markStaleHostsOffline, HOST_STALE_CHECK_INTERVAL_MS } from './modules/hosts/hosts.service';
import { recoverOrphanedRuns } from './modules/execution/execution.service';
import { computeDailyAggregates, ANALYTICS_RECOMPUTE_INTERVAL_MS } from './modules/analytics/analytics.service';

async function start(): Promise<void> {
  let config;
  try {
    config = await loadEffectiveConfig(env.ORG_CONFIG_PATH, env.PROJECT_CONFIG_PATH);
  } catch (err) {
    console.error(`❌ Invalid config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const app = await buildApp(config);

  try {
    await connectDB();
    app.log.info(`Connected to MongoDB`);
  } catch (err) {
    app.log.error(err, 'Failed to connect to MongoDB');
    process.exit(1);
  }

  const recovered = await recoverOrphanedRuns();
  if (recovered > 0) {
    app.log.warn(`Recovered ${recovered} execution run(s) left mid-flight by a previous restart`);
  }

  const address = await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  app.log.info(`Mobile Hub backend listening at ${address}`);

  const staleHostInterval = setInterval(() => {
    markStaleHostsOffline().catch((err: unknown) => {
      app.log.error(err, 'Failed to mark stale hosts offline');
    });
  }, HOST_STALE_CHECK_INTERVAL_MS);

  const analyticsInterval = setInterval(() => {
    computeDailyAggregates().catch((err: unknown) => {
      app.log.error(err, 'Failed to recompute daily analytics aggregates');
    });
  }, ANALYTICS_RECOMPUTE_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    clearInterval(staleHostInterval);
    clearInterval(analyticsInterval);
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void start();
