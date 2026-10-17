# Mineflayer Master Printer

An autonomous Minecraft map-art printing fleet built on [Mineflayer](https://github.com/PrismarineJS/mineflayer). Upload a structure (`.litematic`, Sponge `.schem`/`.schematic`, vanilla `.nbt`, or a `.zip` of them) through a web dashboard, and self-driving bots slice it into chunk jobs, fly there by elytra, place every block at a server-friendly rate, restock themselves from registered storage chests, recover from crashes mid-print, and keep queue progress visible to operators the whole time.

The project has two cooperating parts:

| Part | What it is |
| --- | --- |
| `src/` | The bot runtime — connection management, elytra flight, chunk printing, inventory planning, shulker logistics, storage scanning, and crash recovery. |
| `dashboard-service/` | A zero-dependency Node HTTP service — operator web UI, auth/roles, structure upload + slicing, chunk queue, fleet commands, and bot heartbeats. |

```
        upload .litematic/.schem/.nbt/.zip                claim chunk job
┌──────────────────────────────┐   slice   ┌───────────────────────────┐
│  Dashboard service (':4080') │ ────────► │  chunk queue (files.json) │
└──────────┬───────────────────┘           └─────────────┬─────────────┘
           │ commands / alerts                           │ claim + download
           ▼                                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ Bot runtime (src/) — heartbeats every 5 s, polls commands every 3 s │
│  elytra flight → hover over chunk → TPS-budgeted block placement   │
│  → layer verification → restock detours → storage registration      │
└────────────────────────────────────────────────────────────────────┘
```

## Feature highlights

- **Structure pipeline** — Litematica, Sponge schematic (v1/v2), and vanilla structure NBT are parsed into a normalized block list, bucketed into 16×16 chunk slices, and queued as independently claimable jobs (attempts, holds, retries, `failed-final` escalation).
- **Meteor-style elytra flight** — a physics-tick controller ported from Meteor Client drives takeoff, climb, cruise, approach, and flare landing, with skyway routing above terrain and obstacle-aware BFS re-entry.
- **TPS-aware printing** — a token-bucket action budget scales placement speed with measured server TPS (pause below 10 TPS or on stale ticks), with a per-tick burst cap and a hard 30 packets/second ceiling; blocks are only ever placed below the bot, within reach.
- **Self-sufficient logistics** — bots plan material demand from the storage registration, unbox shulkers through a fleet-serialized staging flow (place → open → withdraw → mine → catch → return), keep a dedicated hotbar layout, and eat golden apples below 12 health.
- **Crash recovery everywhere** — mid-air disconnects trigger instant anti-fall hover; interrupted chunks resume from durable per-block progress (`print-progress.json`) or re-claim their queue lease after restart; grounded and airborne print recovery each retry with route replanning.
- **Fleet operations** — per-bot and per-node start/pause/chat controls, fleet-wide actions, role-based operator accounts, teleport whitelist sync, runtime stall alerts, and per-bot inventory / VM metrics views.

## Flight safety rules

These are enforced in code, not conventions:

- **Altitude ceilings** — hard flight ceiling `MAX_FLIGHT_ALTITUDE_Y = 324`, pathing ceiling `maxPathingY = 322` by default; cruise altitudes are computed below both, and the planner throws rather than route under a configured ceiling that is unsafe.
- **Verified landing pads only** — a pad must be a full-cube surface with headroom, is checked as 3×3 then 1×1, and is re-verified every loop. Water, lava, cactus, fire, magma, powder snow, berry bushes, wither roses, bubble columns, pointed dripstone, campfires, leaves, and portals are rejected.
- **Staged flare descent** — descent slows progressively near the ground (20 → 10 → 4 bps, then 1.5/0.75/0.3/0.08 bps in the final meter); glide flare engages within 5 blocks of ground, and any landing that costs health fails the flight.
- **Speed policing** — per-tick velocity clamps, an absolute measured-speed limit (default 70 bps), and rubberband classification (≥ 1.5-block correction, repeated backward corrections, or clustered corrections) that fails the flight instead of fighting the server.
- **Glide confirmation** — the bot refuses to survival-land unless the server confirms `elytraFlying`; water escapes are pathfound within a 20-second budget.

## Printing rules

- **Bottom-to-top ordering** — within each chunk slice, blocks are placed in ascending Y (then Z, then X), in layer bands of 1–3 layers (default 2) with hover lanes at `layerY + 2`, keeping ≥ 2 blocks of clearance so the bot never suffocates in its own print.
- **Verification loop** — a parallel layer check repairs missing blocks from up to 3 layers back; any missing block at chunk end rewinds progress to the earliest gap.
- **Existing blocks are never broken** — mismatches are skipped and logged.
- **Emergency durability handling** — elytra durability below 10 interrupts the print and returns the bot to the station (preferring a `/home platform` chat command over a risky flight).

## Quick start

Requirements: **Node.js ≥ 22** (bot runtime) — the dashboard service has zero npm dependencies.

```powershell
git clone https://github.com/ComicSquid74273/Mineflayer-Master-Printer.git
cd Mineflayer-Master-Printer
npm install
```

### 1. Start the dashboard

```powershell
npm run dashboard
```

Open <http://127.0.0.1:4080/>. Viewing is public; on first start the service seeds one admin account into `dashboard-service/data/operators.json` — the password is taken from `DASHBOARD_ADMIN_PASSWORD` or auto-generated and written there. Use it to log in from the home page or the dashboard header.

### 2. Point the bot at a server

Edit `config/config.json`: the `connection.profiles` map holds named profiles (`local`, `testserver`, `6b6t`, …) that overlay the base `bot` section — set each profile's `host`/`port`/`auth`/`version`. Everything can also be overridden per run:

```powershell
$env:MINECRAFT_HOST = "your-server-host"
$env:MINECRAFT_PORT = "25565"
$env:MINECRAFT_USERNAME = "ComicBot"
$env:MINECRAFT_LOGIN_PASSWORD = "chat-auth-password-if-the-server-uses-/login"
```

Offline-mode servers that prompt `/login` or `/register` are handled automatically by pattern matching (`chatLogin` section of the profile).

### 3. Start the bot

```powershell
npm start                      # uses the config's active profile
npm run start:testserver       # --connection=testserver
npm run start:6b6t             # --connection=6b6t, Microsoft device auth
```

Microsoft authentication caches under `auth-cache/` (gitignored). SOCKS4/5 proxy support is built in via the account-level `proxy*` fields.

### 4. Print something

1. In the dashboard's **Upload Structure** panel, select a structure file and set the **North-West Bottom anchor** X/Y/Z.
2. The service slices it into chunk jobs and queues them (or distributes them to specific nodes/bots).
3. Bots parked in the station bounds auto-start printing when eligible work exists; you can also press start on any bot or node card.
4. Before the first run, register the restock station once — set the storage anchor in the header and press **Register Storage** (or run `npm run test:storage:live`). The bot flies there, scans every chest/barrel/shulker (reading nested shulker contents from item NBT without opening them), and builds the material index used for restock planning.

## Configuration

`config/config.json` is the bot's main config. Top-level sections:

| Section | Controls |
| --- | --- |
| `bot` | account list (`usernames[]` with per-account proxy settings), version, view distance, reconnect policy |
| `connection` | `active` profile name + the `profiles` map that overlays `bot`, `elytraFly`, `multiUser`, `printer`, and `advanced` per server |
| `printer` | placement engine — `blocksPerSecond` (default 20), `minimumTps`, `perTickBurstCap`, `range`, `layersPerPass`, `printWhileFlying`, hotbar lookahead |
| `elytraFly` | flight model (`vanilla`/`meteor`), speeds, acceleration, altitude/pathing ceilings, crash lookahead, landing flare tuning |
| `storageRegistration` | station anchor, scan radii, container limits, open timeouts |
| `multiUser` | fleet coordination — sync, heartbeats, join/start staggering |
| `dashboard` | service URL, host label, heartbeat/poll intervals |
| `files` | input mode, machine config profile, NBT/structure folders, resume behavior |
| `advanced` | ~200 fine-tuning flags (restock timing, repair/rescan, post-print map workflow, dump station, latency-safe mode, …) |
| `anchorTranslation` | optional source→target anchor remap |

`nerv-printer-config/_configs/` holds deployment configs in the same schema (fleet nodes with their own `hostLabel`s, a delivery-bot config, and carpet-printer machine-layout configs describing the physical map-finishing station). The dashboard reads and edits these through its config panel.

### Common CLI flags and environment variables

| Purpose | CLI | Environment |
| --- | --- | --- |
| Config file | `--config=` | `NERV_CONFIG_FILE` |
| Connection profile | `--connection=` | `NERV_CONNECTION` |
| Account | `--username=` | `MINECRAFT_USERNAME` / `NERV_USERNAME` |
| Server | `--host=`, `--port=`, `--auth=`, `--version=` | `MINECRAFT_HOST` / `MINECRAFT_PORT` / `MINECRAFT_AUTH` / `MINECRAFT_VERSION` |
| Chat-login password | `--password=` | `MINECRAFT_LOGIN_PASSWORD` / `NERV_LOGIN_PASSWORD` |
| Print speed | `--speed-bps=` | `PRINTER_BPS` |
| Elytra speeds | `--elytra-horizontal-speed=`, `--elytra-vertical-speed=` | `ELYTRA_HORIZONTAL_SPEED` / `ELYTRA_VERTICAL_SPEED` |
| Dashboard | — | `NERV_DASHBOARD_URL`, `NERV_DASHBOARD_ENABLED`, `NERV_DASHBOARD_HOST_LABEL` |
| Debug | `--debug` | `PRINTER_DEBUG` / `NERV_DEBUG` |

## Dashboard service

- **Operator console** (`/`) — queue tracker with ETAs, fleet panel grouped by node, uploads, operators, per-node NBT file inventories, log downloads, teleport whitelist, audit trail, bot inventories, and VM metrics.
- **Public home page** (`/home`) — marketing/support landing page with an operator login form and a rate-limited support-query form (stored locally; emailed only when SMTP is configured via `DASHBOARD_SUPPORT_MAIL_TO` + `smtp-config.env`).
- **Roles** — `viewer`, `bot-controller`, `bot-operator`, `operator`, `admin`, built from ten permission flags; bot IPs are visible only to accounts that can manage operators, and exact bot positions only to admins. Sessions are HMAC-signed cookies (7-day default).
- **Bot-facing API** — heartbeats (`/api/bots/status`), command claim/result, queue claim/download/result, storage-registration storage/retrieval, and delivery plans. All state persists as JSON under `dashboard-service/data/` with atomic writes.

Key environment variables: `DASHBOARD_HOST` / `DASHBOARD_PORT` (defaults `0.0.0.0:4080`), `DASHBOARD_DATA_DIR`, `DASHBOARD_SESSION_SECRET`, `DASHBOARD_ADMIN_USERNAME` / `DASHBOARD_ADMIN_PASSWORD`, `DASHBOARD_TRUST_PROXY_IP_HEADERS`, and the `DASHBOARD_MAX_*` family for upload/ZIP/structure limits (defaults: 512 MiB per upload, 64 MiB per request/ZIP entry, 5000 ZIP entries, 10 000 stored structures).

## Live test scripts

`scripts/` contains runnable end-to-end drills against a real server (wired to `test:*:live` npm scripts): elytra flight and reconnect recovery, storage registration (single and 100-iteration stress with p50/p95 timings), gear restock and forced shulker unboxing, multi-chunk queue printing, a mid-print kill-and-recover drill (`print-queue-chunk-recovery-live.js`), repeated glide-landing verification, and a schematic upload → chunk pull round-trip.

`scripts/local-folia/` manages a throwaway local test server: `install.ps1` (Folia 26.2 + JDK, SHA256-verified downloads, loopback bind, generated RCON password), `start.ps1`, `stop.ps1` (graceful RCON stop).

## Development

```powershell
npm test     # 196 bot-runtime tests + 47 dashboard-service tests (node:test)
npm run check
```

Runtime state (auth cache, logs, per-chunk progress, dashboard data, the local Folia install) is gitignored — see `.gitignore`. No credentials belong in the repo: server addresses, passwords, and proxy settings are supplied through config/environment.

## Project layout

```
src/                     bot runtime
  index.js               entry point: load config, run connection manager
  config.js              config + connection-profile loading and overrides
  connection-manager.js  session loop, reconnect policy, plugins, events
  chat-login.js          /login //register prompt handling on offline servers
  dashboard-client.js    heartbeats, command polling, auto-start gating
  elytra-flight.js       flight library: hover, glide, landing, water escape
  meteor-elytra-controller.js  Meteor-style physics-tick flight controller
  flight-trajectory-planner.js skyway routes, print checkpoints, BFS re-entry
  printer.js             chunk placement engine (batches, verify, recovery)
  printer-runtime.js     whole-job orchestration, retries, station return
  job-manager.js         queue claims, durable progress, restart recovery
  schematic-loader.js    Litematica / Sponge / vanilla NBT parsing + slicing
  inventory-manager.js   demand planning, hotbar layout, restock execution
  gear-restock.js        shulker unboxing pipeline, gear preparation
  storage-registration.js station/platform/container scanning
  tps-budget.js          TPS-scaled placement action budget
  runtime-lock.js        one bot per (username, host, port) on this machine
  shared/                proxy connect, block interaction, protocol compat
dashboard-service/       operator UI + queue/API service (no dependencies)
config/                  default bot config
nerv-printer-config/     deployment/fleet/machine configs
scripts/                 live drills + local Folia server management
test/                    bot-runtime tests (node:test)
```

Repository: [https://github.com/ComicSquid74273/Mineflayer-Master-Printer.git](https://github.com/ComicSquid74273/Mineflayer-Master-Printer.git)
