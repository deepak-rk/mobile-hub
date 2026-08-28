import { buildApp } from './app';
import { connectDB } from './db/connection';
import mongoose from 'mongoose';
import { env } from './config/env';
import { loadEffectiveConfig } from './config/config.service';
import { markStaleHostsOffline, HOST_STALE_CHECK_INTERVAL_MS } from './modules/hosts/hosts.service';
import { recoverOrphanedRuns } from './modules/execution/execution.service';
import {
  computeDailyAggregates,
  computeWeeklyAggregates,
  ANALYTICS_RECOMPUTE_INTERVAL_MS,
  WEEKLY_RECOMPUTE_INTERVAL_MS,
} from './modules/analytics/analytics.service';
import { runBuildGc, BUILD_GC_INTERVAL_MS } from './modules/builds/builds.service';
import { releaseExpiredLocks, DEVICE_LOCK_SWEEP_INTERVAL_MS } from './modules/devices/devices.service';
import { streamingService } from './modules/streaming/streaming.service';
import { agentTokenIsConfigured } from './modules/agent-auth/agent-auth';
import dynamicImport from './common/dynamic-import';
import type * as MongooseIndexGuard from 'mongoose-index-guard';

async function start(): Promise<void> {
  let config;
  try {
    config = await loadEffectiveConfig(env.ORG_CONFIG_PATH, env.PROJECT_CONFIG_PATH);
  } catch (err) {
    console.error(`❌ Invalid config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Fail closed in production: unauthenticated agent endpoints let anyone
  // register phantom devices, or claim a real machineId and report zero
  // devices to take that lab offline and release its locks.
  if (!agentTokenIsConfigured()) {
    if (env.NODE_ENV === 'production') {
      console.error(
        '❌ AGENT_TOKEN is required in production: without it, POST /api/hosts/heartbeat and ' +
          '/api/devices/sync are open to anyone who can reach this server. Generate one with ' +
          '`openssl rand -hex 32` and set it on the hub and every agent.',
      );
      process.exit(1);
    }
  }

  const app = await buildApp(config);

  if (!agentTokenIsConfigured()) {
    app.log.warn(
      'AGENT_TOKEN is not set — POST /api/hosts/heartbeat and /api/devices/sync are UNAUTHENTICATED. ' +
        'Acceptable for local development only; the server refuses to start like this in production.',
    );
  }

  try {
    await connectDB();
    app.log.info(`Connected to MongoDB`);
  } catch (err) {
    app.log.error(err, 'Failed to connect to MongoDB');
    process.exit(1);
  }

  // Fail fast on a broken index rather than serving traffic without the
  // uniqueness guarantees the app assumes. Real incident: a dropped DB lost
  // its unique index, duplicate registrations silently returned 201, and the
  // next restart's index rebuild failed on those duplicates with nothing in
  // the logs (see docs/LESSONS.md, 2026-08-23). ensureIndexes throws by
  // default rather than swallowing a build failure the way Mongoose's own
  // background index build does.
  try {
    // ESM-only package, dynamically imported — same workaround as
    // layered-config-ts and fastify-auth-kit (this backend is CommonJS).
    // Uses dynamicImport(), not raw `await import(...)`: tsc rewrites a
    // literal dynamic import to `require()` when compiling to CommonJS,
    // which breaks precisely this case (see common/dynamic-import.ts).
    const { ensureIndexes } = await dynamicImport<typeof MongooseIndexGuard>('mongoose-index-guard');
    await ensureIndexes(mongoose);
  } catch (err) {
    app.log.error(err instanceof Error ? err.message : err, 'Index build failed');
    process.exit(1);
  }

  const recovered = await recoverOrphanedRuns();
  if (recovered > 0) {
    app.log.warn(`Recovered ${recovered} execution run(s) left mid-flight by a previous restart`);
  }

  const address = await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  app.log.info(`Mobile Hub backend listening at ${address}`);

  const staleHostInterval = setInterval(() => {
    markStaleHostsOffline()
      .then(({ hosts, devices }) => {
        if (hosts > 0) {
          app.log.warn(`${hosts} host(s) stopped heartbeating; took ${devices} device(s) offline with them`);
        }
      })
      .catch((err: unknown) => {
        app.log.error(err, 'Failed to mark stale hosts offline');
      });
  }, HOST_STALE_CHECK_INTERVAL_MS);

  // Reaps captures whose last viewer left more than the grace period ago.
  streamingService.startIdleSweeper((err) => app.log.error(err, 'Stream idle sweep failed'));

  const analyticsInterval = setInterval(() => {
    computeDailyAggregates().catch((err: unknown) => {
      app.log.error(err, 'Failed to recompute daily analytics aggregates');
    });
  }, ANALYTICS_RECOMPUTE_INTERVAL_MS);

  // The current ISO week only changes as today's runs land in it, so a daily
  // cadence keeps it current without the hourly churn daily aggregates need.
  const weeklyAnalyticsInterval = setInterval(() => {
    computeWeeklyAggregates().catch((err: unknown) => {
      app.log.error(err, 'Failed to recompute weekly analytics aggregates');
    });
  }, WEEKLY_RECOMPUTE_INTERVAL_MS);

  // Keeps BUILDS_DIR from growing forever — see builds.service.ts's
  // runBuildGc doc comment for the retention policy itself.
  const buildGcInterval = setInterval(() => {
    runBuildGc(config)
      .then(({ purged, failures }) => {
        if (purged > 0) app.log.info(`Build GC purged ${purged} old build artifact(s)`);
        for (const f of failures) app.log.error(`Build GC failed to remove ${f.buildId}: ${f.reason}`);
      })
      .catch((err: unknown) => {
        app.log.error(err, 'Build GC sweep failed');
      });
  }, BUILD_GC_INTERVAL_MS);

  // The *online* counterpart to markStaleHostsOffline above: releases a lock
  // whose holder crashed or walked away while the device kept heartbeating,
  // so it never went offline and that sweep never touched it.
  const deviceLockSweepInterval = setInterval(() => {
    releaseExpiredLocks(config.devices.lockTtlMinutes)
      .then((released) => {
        if (released > 0) app.log.info(`Released ${released} expired device lock(s)`);
      })
      .catch((err: unknown) => {
        app.log.error(err, 'Device lock expiry sweep failed');
      });
  }, DEVICE_LOCK_SWEEP_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    clearInterval(staleHostInterval);
    clearInterval(analyticsInterval);
    clearInterval(weeklyAnalyticsInterval);
    clearInterval(buildGcInterval);
    clearInterval(deviceLockSweepInterval);
    // No capture process may outlive the server.
    await streamingService.shutdown();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void start();
