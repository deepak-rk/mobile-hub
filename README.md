# Mobile Hub

Open-source mobile device testing & automation platform for the community — a shared device lab, Appium-driven test execution, live device streaming, and a results dashboard, built from the ground up to be config-driven rather than prescriptive.

**Status:** implementation in progress. See [`docs/TODO.md`](docs/TODO.md) for the live, verified checklist of what's actually built and tested vs. what's still a model/stub.

## What's here

- **`backend/`** — Node.js/Fastify API: device inventory, host/Appium-server orchestration, build fetch & integrity validation, execution pipeline, config service, auth. See [`backend/CLAUDE.md`](backend/CLAUDE.md).
- **`frontend/`** — React/Vite dashboard: device grid, live device viewer, execution/build UI, analytics. See [`frontend/CLAUDE.md`](frontend/CLAUDE.md).
- **`docs/`** — architecture blueprint, module specs, deployment guide, the build checklist, and the project's running lessons-learned log.

## Quick start

```bash
npm install

# Backend needs MongoDB and a JWT_SECRET (see backend/.env.example)
docker run -d -p 27017:27017 mongo:7
cp backend/.env.example backend/.env   # then fill in JWT_SECRET

npm run dev   # runs backend + frontend together
```

Or via Docker Compose (builds both images, runs Mongo alongside):

```bash
cp .env.example .env   # fill in JWT_SECRET
docker compose up
```

Org/project-level configuration (build source, feature toggles, automation repo layout) is optional — copy `mobilehub.org.yaml.example` to `mobilehub.org.yaml` (and/or `mobilehub.project.yaml.example` to `mobilehub.project.yaml`) to customize; the platform runs on sane defaults without either file.

## Design principles

- **Configurable, not prescriptive** — org/project YAML config, pluggable build-source adapters, no assumed automation repo layout. See `CLAUDE.md` § Config-driven, organisation-aware.
- **Multi-host aware from the schema up** — `machineId` is a first-class field everywhere device/session state lives, not a bolted-on afterthought.
- **Built to avoid known gaps in prior tools in this space** — streaming fan-out, artifact integrity validation, and RBAC are designed in from day one rather than retrofitted. See `CLAUDE.md` § Lessons carried in.

## Contributing

This is a community project — PRs and issues welcome. See `CLAUDE.md` § Contribution norms, and each package's own `CLAUDE.md` for stack-specific conventions before sending a change.

## License

MIT
