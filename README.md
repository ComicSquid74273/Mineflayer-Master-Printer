# Mineflayer Master Printer

Connection and dashboard foundation for a Mineflayer bot that will later print `.litematic` and `.schem` structures.

This phase includes:

- the reference connection-profile model with `testserver` and `6b6t` profiles
- `ComicBot` configured for a test server (host is set in `config/config.json` or via `MINECRAFT_HOST`)
- offline `/login` and `/register` prompt handling with the password supplied via `MINECRAFT_LOGIN_PASSWORD`
- SOCKS proxy support for bot connections
- ElytraFly loaded after the bot spawns so travel APIs are available for the next phase
- the same dashboard UI/service, extended to upload `.litematic`, `.schem`, `.schematic`, legacy `.nbt`, and `.zip` files
- 6b6t 450Y maximum Elytra flight height ceiling (`MAX_FLIGHT_ALTITUDE_Y = 450`)
- Bottom-to-top chunk slice printing with 2-block vertical clearance to prevent hit/suffocation damage
- Mid-air disconnect/crash auto-recovery with instant anti-fall ElytraFly hover and state restoration
- Glide flare landing with gentle -0.5 BPS descent to prevent kinetic fall damage

Repository: [https://github.com/ComicSquid74273/Mineflayer-Master-Printer.git](https://github.com/ComicSquid74273/Mineflayer-Master-Printer.git)

## Flight Safety & Printing Rules

- **450Y Ceiling**: On 6b6t, max Elytra flight height is 450Y. Clamped across `clampVelocity`, `engageElytraHover`, `flyToTargetInAir`, `moveToLandingApproach`, and `travelToAnchor`.
- **Bottom-to-Top Ordering**: Chunk slices are sorted strictly bottom to top (Y ascending).
- **2-Block Clearance**: When printing in air, the bot hovers at `block.y + 2.4` and maintains $\ge 2$ blocks vertical space from placed blocks to avoid suffocation/hit damage.
- **Glide Landing**: Approaching the ground ($\le 3.5$ blocks), the bot cuts downward thrust, levels pitch, glides horizontally, and cushions descent to -0.5 BPS.

## Install

```powershell
npm install
```

## Run

Start the dashboard:

```powershell
npm run dashboard
```

Start ComicBot on the test server:

```powershell
npm run start:testserver
```

### Storage & Anchor Registration

- Common anchor target block: `-326, 97, -100` (used as the flight takeoff, approach, and landing point for storage scans).
- The dashboard fleet header includes a global `Register Storage For All` action with configurable X/Y/Z anchor inputs.
- Each bot card includes an anchor override plus an individual `Register Storage` button.
- Commands are queued sequentially through `/api/bots/:botName/commands`, claimed via `/claim`, and completed with their full storage snapshot.
- Bots Elytra-fly to the anchor, verify the landing pad, wake if sleeping, and walk container-to-container without moving items.
- Nested shulker contents are decoded directly from container components or legacy `BlockEntityTag` NBT while opening chests; empty source chests are ignored.
- All three trapped chests are registered as overflow drop containers (`1 -> 2 -> 3`).

Run the bounded live Elytra diagnostic:

```powershell
npm run test:elytra:live
```

Open `http://127.0.0.1:4080/`. On first start, the generated dashboard admin password is stored in `dashboard-service/data/operators.json`.

Switch the same runtime to 6b6t:

```powershell
npm run start:6b6t -- --username=your_microsoft_account
```

Microsoft device authentication is cached under `auth-cache/`.

## Configuration

`config/config.json` is a sanitized full import of the reference Mapart Bot config. The new runtime currently consumes only connection, bot, dashboard, proxy, reconnect, and ElytraFly-related values; printer and machine values remain available for later phases.

Useful overrides:

```powershell
$env:MINECRAFT_USERNAME = "ComicBot"
$env:MINECRAFT_LOGIN_PASSWORD = "another-demo-password"
$env:MINECRAFT_HOST = "your-server-host"
$env:MINECRAFT_PORT = "25565"
$env:NERV_CONNECTION = "testserver"
$env:NERV_DASHBOARD_URL = "http://127.0.0.1:4080"
```
