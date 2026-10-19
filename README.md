# PC_READER — Device Inventory & Tracking App

Internal tool for registering agency computers, collecting their hardware specs automatically on Windows and macOS, tagging units and components with inventory numbers, and tracking assignments, status history, network health and Preventive Maintenance reports from a web dashboard.

## Documentation

- [Technical specification](docs/technical-spec.md): goals, architecture, components, data model, scan field mapping, agent API, reporting behavior, security, non-functional requirements, deployment and open questions.
- [Milestone 1 plan](plans/m1-thin-slice/plan.md): the end-to-end thin slice being built now.

## Run the test server (Milestone 1)

Requires Docker Desktop (or Docker Engine with Compose).

```sh
cp .env.example .env        # then set ENROLLMENT_KEY and POSTGRES_PASSWORD
docker compose up -d --build
```

Open http://localhost:3000. Other computers on the same network use `http://<this computer's IP>:3000` (allow port 3000 through the firewall). Milestone 1 uses plain HTTP and has no dashboard login, so run it only on a trusted network.

## Develop

Requires [bun](https://bun.sh) 1.4 and PostgreSQL 16.

```sh
bun install
bun run lint
bun run test                       # uses DATABASE_URL, default postgres://postgres@127.0.0.1:5432/pcreader_test
cd server && DATABASE_URL=... ENROLLMENT_KEY=... bun run db:migrate && bun run dev
```

See [CLAUDE.md](CLAUDE.md) for layout and conventions.
