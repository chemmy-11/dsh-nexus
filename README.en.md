# dsh-nexus

English | [中文](./README.md)

An observation plugin for DeepSeek Harness (`dsh`, package `@dsh-external/dsh-nexus`): **dual-panel quantitative observation** for your Obsidian vault and AI conversations — vault-side metadata snapshots and edit statistics, plus conversation-side per-turn telemetry and curve-shape analysis. Read-only against the vault; all observation data is stored privately (`~/.dsh/nexus/`) and survives restarts and reloads without loss or double-counting.

## ① Vault observation

- **Full scan**: at startup + periodic recalibration (default 6h) — path / mtime / size / char count (whitespace-stripped, frontmatter excluded);
- **Edit watching**: `fs.watch` (recursive) picks up vault changes live (works with Obsidian closed), 500ms debounce merge, idempotent `created`/`modified`/`deleted` accounting;
- **Dashboard**: total files / total chars, today & week edit stats, top active files, recent edit stream;
- **Pointing confirmation**: observation only reads from the pointed vault; history is isolated per root and can be switched back; exclude rules configurable.

## ② Session telemetry (L-field readings)

Turning "how far a conversation moved the knowledge base" into numbers — **session-level LLM observability + quantified self-review + curve-shape analysis**:

- **Metric definitions**: tokens (input/output/cache-hit), cache hit & miss rates (miss rate = the A projection), TPS & decode time, and a per-turn subjective clarity self-rating (0–1) — **objective and subjective tracks cross-validate each other, bounding each side's bias** (the objective curve is confounded by cache warm-up and novel topics; self-reports by reporting bias);
- **Direct official-event capture**: subscribes to the host's `session/event` (**zero host-source modifications, no third-party plugin dependencies**), with data isolated in a private directory (`~/.dsh/nexus/`, SQLite);
- **Two-tab dashboard**: SVG curves with **zoom, filtering (time window / session) and per-turn Q&A replay** (full transcript of any turn);
- **Repeatable analysis pipeline**: shape classification (sigmoid / rising / falling / inverse-sigmoid) · characteristic-time (τ_e) detection · bucketed comparison — first run: **vault sessions show a 13.7% miss rate vs 5.6% for non-pointed workspaces**, consistent with knowledge work's higher exploration density;
- **Self-review coverage**: per-session coverage badge (assessed / total turns + missing turn numbers), warning below 80%;
- **Hypothesis board**: P1–P9 annotations (pending / investigating / verified) with analysis conclusions written back.

> "L-field" is the author's personal research framing (L-theory); external readers can treat this panel simply as a **session-level LLM observability dashboard** — the metrics themselves (tokens / cache / TPS / self-review) are standard observability quantities.

## Pointing & views

- The plugin keeps two **independent pointings**: the **vault pointing** (observation target) and the **L-field pointing** (the vault root a session belongs to), both confirmable/switchable in the panel (double confirmation, history never deleted);
- Session attribution rule: **the workspace a session was initiated in** — sessions started inside the pointed vault's workspace form the vault view; everything else appears only in the global view; historical sessions are back-filled by the same rule;
- Two dashboard views: **global** (all workspaces) / **〈vault short name〉** (sessions initiated in the pointed workspace) — comparative analysis is a view switch.

## Installation

```sh
dsh plugin --profile <name> add github:chemmy-11/dsh-nexus
```

Git-form installs build on your machine (the `prepare` script needs a dsh source checkout: probes `$DSH_CHECKOUT` or `~/dsh-harness`); pnpm ≥10 requires allowing `allowBuilds` in the profile's `pnpm-workspace.yaml` on first install.

Config example (in the profile's `cordis.patch.yml`; `vaultRoot` is optional — confirm pointing in the panel instead, config only seeds it):

```yaml
- id: nexus
  config:
    vaultRoot: 'C:/path/to/your/obsidian/vault'
    exclude: [dsh-docs]
    watchEnabled: true
    pollIntervalMs: 21600000
    debounceMs: 500
```

## API (same-origin)

| Endpoint | Description |
|---|---|
| `GET /api/nexus/state` | vault totals / today / week / recent edit stream |
| `GET/POST /api/nexus/vault` | vault pointing status / switch |
| `GET /api/nexus/m2/state` | session readings (latest / totals / curve / selfcheck coverage; `?root=all` switches to the global view) |
| `GET/POST /api/nexus/m2/annotations` | hypothesis annotations read/write |
| `GET /api/nexus/m2/turn-text` | full Q&A transcript of a turn |
| `GET /api/nexus/m2/analysis` | white-box analysis (sigmoid / bursts / τ_e) |
| `GET/POST /api/nexus/lfield` | L-field pointing status / switch |

## Build

```sh
DSH_CHECKOUT=<dsh-checkout> bash scripts/build.sh   # = node scripts/prepare.mjs (host tsc + client esbuild)
```

The build chain is pure Node (`scripts/prepare.mjs` + `scripts/build-client.mjs`), independent of bash environment differences.

**Two build modes** (auto-selected by `scripts/prepare.mjs`):
- **checkout mode** (local dev): probes `$DSH_CHECKOUT` / `~/dsh-harness` → junction-links `cordis`/`schemastery`/`dsh-host-webserver` from the checkout and reuses its tsc/esbuild;
- **npm-devDeps mode** (CI / no checkout): `npm install` the devDependencies, then build from local deps — no dsh source needed.

## CI

`.github/workflows/ci.yml` runs `typecheck` + `build` (npm-devDeps mode) + tests + metadata checks (bundle patch / client halves / files manifest) on every push/PR; `.github/workflows/release.yml` builds a tgz and creates a GitHub Release on `v*` tags.

## Design principles

- **Independently installable**: depends only on official `cordis`/`schemastery`/`dsh-host-webserver`, coupled to no other plugin;
- **Observation leaves traces**: edit events and session readings accumulate forward from deployment (SQLite persistence — no loss, no double-counting across restarts/reloads);
- **Boundary awareness**: read-only against the vault, data kept private (never written into the vault, never mixed with other data sources);
- **Attribution never mixes**: sessions are attributed by their initiating workspace; vault sessions and other workspaces are analyzed separately (one classification rule, no time-based epochs).

## Security note

Installing a plugin means running third-party code with your own permissions. Read the source before installing; this plugin is strictly read-only against the target vault and performs no writes.
