# Module: Builds Library

**Status:** planned — no code written.
**Blueprint ref:** [architecture-blueprint.md §4 (Build, InstallJob), §11 (BuildProviderRegistry), §12b](../architecture-blueprint.md)
**Competitive context:** [competitive-analysis.md §4g, §4h](../competitive-analysis.md)

---

## Purpose

Manage the lifecycle of mobile application build artifacts — fetching from wherever the org stores them (Nexus, S3, direct URL, or a custom provider), validating their integrity before marking them usable, and tracking download progress in real time. Different organisations store builds in completely different systems; this module adapts to them rather than imposing a layout.

---

## The core problems this module solves

1. **Silent corruption.** No open-source device lab validates build artifacts before marking them ready. Corrupted downloads surface only as mysterious test failures after the fact. Mobile Hub gates `Build.status = 'ready'` behind a passed integrity check.

2. **Provider lock-in.** BrowserStack and Sauce Labs accept S3 presigned URLs as their only "custom provider" option. Organisations with Nexus, Artifactory, or internal storage have to write custom fetch scripts today. Mobile Hub ships first-class adapters for the most common providers behind a stable interface.

3. **Concurrent download races.** Two simultaneous requests for the same build can both start a download, both write to the same artifact path, and both mark themselves complete — resulting in a corrupt file with a clean status. Mobile Hub prevents this with an atomic precondition check before any download starts.

---

## Data models

### Build
```ts
{
  _id,
  project: string,
  platform: 'android' | 'ios',
  version: string,
  artifactUrl: string,          // source URL (Nexus, S3, direct, etc.)
  artifactPath: string,         // resolved local path after download
  sizeBytes: number,
  checksum: string,             // expected SHA-256 (provided by caller or fetched from provider)
  checksumAlgorithm: 'sha256',
  status: 'downloading' | 'validated' | 'corrupt' | 'ready',
  integrityValidatedAt: Date | null,
  fetchedAt: Date | null,
  createdAt, updatedAt
}
```

`status` can only reach `'ready'` after `integrityValidatedAt` is set. The service enforces this — there is no code path that sets `status: 'ready'` without first writing `integrityValidatedAt`.

### InstallJob
Tracks the asynchronous download/validate pipeline for a single build artifact:

```ts
{
  _id,
  buildId: ref Build,
  project: string,
  platform: 'android' | 'ios',
  version: string,
  status: 'queued' | 'pending' | 'downloading' | 'validating' | 'complete' | 'error',
  progress: number,             // 0–100, updated during streaming download
  sizeBytes: number | null,
  downloadedBytes: number,
  error: string | null,
  startedAt: Date | null,
  completedAt: Date | null,
  createdAt
}
```

`InstallJob.progress` is pushed to the frontend over WebSocket while downloading — clients show a progress bar. The `Build` record's `status` updates only after the `InstallJob` reaches `'complete'` and the integrity check passes.

---

## Build provider system

### Why providers exist

Different organisations store builds differently: some use Nexus, some push to S3, some have a plain download URL, some have a custom CI artifact server. Mobile Hub does not pick one and force the rest to adapt — it exposes a `BuildProvider` interface and ships adapters for common cases.

### Provider selection

Provider is configured in `mobilehub.org.yaml` (with optional project-level override):

```yaml
builds:
  provider: nexus     # nexus | s3 | direct-url | custom
  nexus:
    baseUrl: https://nexus.internal.example.com
    repo: mobile-releases
    tlsSkipVerify: false    # explicit opt-in only — never silently bypassed
  # s3:
  #   bucket: my-mobile-builds
  #   region: ap-south-1
  # direct-url: (no extra config — artifact URL is passed directly per build)
  # custom:
  #   fetchScript: ./scripts/fetch-build.sh
  #   listScript: ./scripts/list-builds.sh
```

### BuildProvider interface

```ts
interface BuildProvider {
  fetchBuild(project: string, version: string): Promise<{ artifactPath: string; sizeBytes: number }>;
  listBuilds(project: string): Promise<BuildSummary[]>;
}
```

The rest of the system only calls this interface — never the adapter directly. Swapping providers doesn't touch `BuildsService` or any controller.

### Adapters

| Adapter | Notes |
|---|---|
| `NexusBuildProvider` | Maven/Nexus 3 repository; `tlsSkipVerify` is an explicit YAML key, defaults to `false` — never silently bypassed |
| `S3BuildProvider` | AWS S3 or S3-compatible storage (MinIO, Cloudflare R2); uses AWS SDK v3 |
| `DirectUrlBuildProvider` | Plain HTTPS download; URL provided per-build at trigger time |
| `CustomBuildProvider` | Calls a user-defined shell script or webhook; escape hatch for anything not natively supported |

`BuildProviderRegistry` maps the `provider` string from config to the correct adapter class. It is initialized once at startup from the resolved `OrgConfig`.

---

## Download and integrity pipeline

```
Trigger fetch
  │
  ▼
BuildsService.fetchBuild()
  ├── atomic findOneAndUpdate: if Build already exists with status 'downloading' → return existing InstallJob (race guard)
  ├── create Build record (status: 'downloading')
  ├── create InstallJob (status: 'pending')
  │
  ▼
BuildProvider.fetchBuild()  ← streams the artifact to disk
  ├── streams to artifactPath via Node crypto pipeline
  ├── computes SHA-256 on the fly during streaming (no temp-file-then-hash)
  ├── updates InstallJob.downloadedBytes + progress at ~1s intervals → push to frontend via WS
  │
  ▼
Integrity check
  ├── compare computed checksum against expected
  ├── PASS → set integrityValidatedAt, Build.status = 'ready', InstallJob.status = 'complete'
  └── FAIL → Build.status = 'corrupt', InstallJob.status = 'error', artifact deleted
```

**SHA-256 via streaming pipeline:** `crypto.createHash('sha256')` is piped alongside the write stream during download. No separate post-download hash step, no subprocess. The hash is computed in one pass as data flows to disk.

**Progress reporting:** `InstallJob.progress` is updated in `BuildsService` every ~1 second based on `downloadedBytes / sizeBytes`. A background interval pushes the current `InstallJob` state to any WS subscribers watching that job. When `sizeBytes` is unknown (provider doesn't expose Content-Length), `progress` stays at `0` until `'complete'`.

---

## BuildsService responsibilities

| Responsibility | Notes |
|---|---|
| `fetchBuild(project, version)` | Atomic race guard + triggers the download pipeline |
| `listBuilds(project)` | Delegates to `BuildProvider.listBuilds()`, merges with DB status |
| `getBuild(buildId)` | Returns full `Build` + latest `InstallJob` state |
| `serveArtifact(buildId, res)` | Streams the local artifact file for install; only serves `status: 'ready'` builds |
| Integrity validation | Runs inline during download, updates `Build` and `InstallJob` on completion |
| Progress push | Interval-based WS push of `InstallJob` state to subscribers |

Controllers stay thin — they parse and validate the request with Zod, call one `BuildsService` method, and format the response. No download logic in controllers.

---

## API surface

### REST
```
GET  /api/builds                    — list builds for the current project (viewer+)
GET  /api/builds/:buildId           — get build + latest InstallJob state (viewer+)
POST /api/builds/fetch              — trigger a build fetch (operator+)
     body: { project, version, platform, artifactUrl? }
GET  /api/builds/:buildId/download  — stream the artifact file (operator+)
GET  /api/builds/jobs/:jobId        — poll InstallJob state (viewer+)
```

### WebSocket
```
/ws/builds/jobs/:jobId  — subscribe to real-time InstallJob progress (viewer+)
```

Events pushed on the jobs WS:
```json
{ "type": "progress", "jobId": "...", "progress": 45, "downloadedBytes": 23000000 }
{ "type": "complete", "jobId": "...", "buildId": "..." }
{ "type": "error",    "jobId": "...", "error": "Checksum mismatch" }
```

---

## Org config integration

`BuildsService` reads from the resolved `OrgConfig` (via `ConfigService`) at startup and on config reload:
- If `features.builds === false` for an org, all build endpoints return `403 Feature disabled`.
- The active `BuildProvider` adapter is determined by `builds.provider` in the merged org+project config.
- Project-level config can override `builds.provider` entirely for a specific project — different projects in the same org can pull from different sources.

---

## Known issues from reference — and Mobile Hub fixes

| Reference issue | Root cause | Mobile Hub fix |
|---|---|---|
| Concurrent download race: two fetches corrupt the same artifact | No atomic guard before starting download | `findOneAndUpdate` with `status` precondition — second request gets the existing `InstallJob` |
| TLS verification silently disabled for internal Nexus servers | `rejectUnauthorized: false` hardcoded in provider | Explicit `tlsSkipVerify: boolean` in `mobilehub.org.yaml`; defaults `false`; visible in config audit |
| Integrity check ran post-hoc after test failures surfaced corruption | No integrity gate on `Build.status` | `status: 'ready'` is unreachable without a passed checksum check and `integrityValidatedAt` set |
| Download progress not visible to users | No job model, no WS push | `InstallJob` with `progress` field, interval WS push to subscribed viewers |
| Org slugs hardcoded in build paths | Tight coupling to internal naming conventions | `OrgConfig.orgId` + `ProjectConfig.projectId` — no hardcoded identifiers |
