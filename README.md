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

## Inventory numbers, statuses and labels (Milestone 4)

Devices (not components yet) get an inventory number, a status and a location from the device page.

- **Format:** generated numbers are `IA-YYYY-NNNNN` (e.g. `IA-2026-00123`): the year in `DISPLAY_TIMEZONE`, then a 5-digit counter that restarts each year. Staff can instead type an existing sticker number (trimmed, at most 50 characters, unique ignoring case).
- **Counter:** `inventory_counters` holds the highest value issued per year and only goes up. "Assign next number" bumps it inside the transaction (row-locked), so two staff cannot get the same number; a typed number that matches the pattern raises the counter to at least its value. Clearing or changing a number never lowers the counter, so a number is not issued twice. Year 2026 stops at `IA-2026-99999`.
- **Statuses:** In use, Spare, Under repair, For disposal, Disposed, Lost. Changes are one device at a time with an optional reason.
- **History:** `status_history` (status) and `device_field_history` (number, location) are append-only; the device page merges them with assignment changes into one timeline. `changed_by` is null until the dashboard has staff login.
- **API:** `POST /api/dashboard/devices/{id}/inventory` with `{ "action": "assign_next" | "set_number" | "clear_number" | "set_status" | "set_location", "value"?, "status"?, "reason"? }`. Errors: 400 bad input, 404 unknown device, 409 number taken or device already numbered.
- **Label:** `/devices/{id}/label` is a print-friendly page (number, QR code of the number, hostname, serial number) that uses the browser's print dialog. The QR code is generated on the server; no external service is used.
- **List:** `/devices` shows number, status and location, can be filtered by status, department, OS and connection, and searched by number, hostname, serial number, user name or employee ID.
