# n8n-manager

Ready-to-run n8n environment manager for humans and AI agents.

`n8n-manager` owns the infrastructure lifecycle, diagnostics, credential readiness, starter kits, and native n8n credential operations.

`n8n-as-code` is an independent community project and is not affiliated with, endorsed by, or sponsored by n8n.

## Positioning

`n8n-manager` is an independent runtime engine. It does not own workflow generation or workflow intelligence. Those belong to the `n8n-as-code` workflow engine.

```txt
facade
  -> workflow-core for generate / validate / search / explain
  -> n8n-manager for setup / credentials / deploy / run / inspect
```

The runtime engine must not depend on the workflow engine, and the workflow engine must not depend on this repo.

## Packages

- `@n8n-as-code/n8n-manager-core`: lifecycle and diagnostics contracts
- `@n8n-as-code/n8n-credentials-manager`: n8n-backed credential catalog, inventory, starter overlays, and starter kits
- `@n8n-as-code/n8n-manager`: CLI entrypoint

## Quick start

```bash
# Managed local Docker n8n (creates container, volume, owner account, API key)
n8n-manager setup --mode managed-local-docker

# With Cloudflare tunnel for remote access
n8n-manager setup --mode managed-local-docker --tunnel

# Check status
n8n-manager status

# Start / stop / restart
n8n-manager start
n8n-manager stop
n8n-manager restart

# Clean up (keeps data volume)
n8n-manager delete

# Clean up including data
n8n-manager delete --destroy-data --force
```

## CLI commands

### Instance management

```bash
# Setup a new instance
n8n-manager setup --mode managed-local-docker|managed-local-direct|existing|generation-only [--id ID] [--name NAME] [--url URL] [--tunnel] [--no-bootstrap-owner]

# List all configured instances
n8n-manager instances list

# Add an existing remote instance
n8n-manager instances add --name NAME --mode existing --url URL --api-key KEY
n8n-manager instances add --name NAME --mode existing --url URL --api-key-stdin  # key from stdin

# Add a managed local Docker instance
n8n-manager instances add --name NAME --mode managed-local-docker [--tunnel] [--no-bootstrap-owner]

# Select active instance
n8n-manager instances select <id-or-name>

# Setup an existing instance (managed-local-docker only)
n8n-manager instances setup <id-or-name> [--tunnel] [--no-bootstrap-owner]

# Start / stop / restart / status
n8n-manager instances start <id-or-name>
n8n-manager instances stop <id-or-name>
n8n-manager instances restart <id-or-name>
n8n-manager instances status <id-or-name>

# Tunnel management
n8n-manager instances tunnel start|stop|refresh|status|url <id-or-name>

# Delete instance
n8n-manager instances delete <id-or-name> [--destroy-data --force]
```

### Legacy top-level commands

```bash
n8n-manager status [--instance <id-or-name>]
n8n-manager start [--instance <id-or-name>]
n8n-manager stop [--instance <id-or-name>]
n8n-manager restart [--instance <id-or-name>]
n8n-manager delete [--destroy-data --force]
```

### Configuration

```bash
# View full config
n8n-manager config get

# Set workflow sync folder
n8n-manager config set-sync-folder <path>
```

### Authentication

```bash
# Register an existing n8n instance
n8n-manager auth set --url URL (--api-key KEY | --api-key-stdin) [--name NAME] [--id ID] [--no-select]

# Test connection
n8n-manager auth test [--instance <id-or-name>]
```

### Projects

```bash
# List projects
n8n-manager projects list [--instance <id-or-name>]

# Select default project
n8n-manager projects select <project-id-or-name> [--instance <id-or-name>]
```

### Credentials

```bash
# List configured credentials
n8n-manager credentials list

# Show credential catalog (all known credential types)
n8n-manager credentials catalog

# Show schema for a credential type
n8n-manager credentials schema <credential-type>

# List available recipes
n8n-manager credentials recipes

# Setup credential from recipe
n8n-manager credentials setup <recipe-id> [--name NAME] [--key=value...]

# Bootstrap a starter kit
n8n-manager credentials starter-kit [starter-kit-id]

# Test a credential
n8n-manager credentials test <credential-id-or-recipe-id>

# Delete a credential
n8n-manager credentials delete <credential-id-or-recipe-id>
```

### LLM proxy

```bash
# Check LLM proxy credential status
n8n-manager llm-proxy status
n8n-manager yagrProxy
```

### Auth bridge (local tunnel for browser auth)

```bash
# Check auth bridge status
n8n-manager auth-bridge status

# Start auth bridge
n8n-manager auth-bridge start [--tunnel]
```

### Agent tooling

```bash
# Generate agent instructions
n8n-manager agent instructions [--write PATH] [--workspace-root PATH]
```

### Workflow presentation

```bash
n8n-manager presentWorkflowResult --workflow-id <id> [--instance <id-or-name>] [--workspace-root PATH]
```

## Managed local Docker instance

Creates a real local Docker container:

- image: `n8nio/n8n:latest`
- container: `n8n-manager-local`
- volume: `n8n-manager-local-data`
- URL: `http://127.0.0.1:5678`

Docker defaults can be overridden:

```bash
N8N_MANAGER_DOCKER_IMAGE=n8nio/n8n:1.5.0
N8N_MANAGER_DOCKER_CONTAINER=my-n8n
N8N_MANAGER_DOCKER_VOLUME=my-n8n-data
N8N_MANAGER_DOCKER_PORT=5679
```

### Owner account bootstrap

By default, managed local setup waits for n8n readiness, silently creates the owner account when possible, creates a scoped n8n API key, and stores it in the local n8n-manager state.

CLI/status output redacts the raw key and reports `apiKeyAvailable`.

Owner credentials are stored before first-run setup so retries can recover if n8n creates the owner but API key creation is interrupted.

Override owner credentials:

```bash
N8N_MANAGER_OWNER_EMAIL=owner@example.com
N8N_MANAGER_OWNER_PASSWORD=secret
N8N_MANAGER_OWNER_FIRST_NAME=John
N8N_MANAGER_OWNER_LAST_NAME=Doe
```

Reuse a known existing owner account by setting `N8N_MANAGER_OWNER_EMAIL` and `N8N_MANAGER_OWNER_PASSWORD` before setup.

### Cloudflare Tunnel

Use `--tunnel` to expose the managed local n8n through Cloudflare Tunnel:

```bash
n8n-manager setup --mode managed-local-docker --tunnel
```

`n8n-manager` resolves `cloudflared` from PATH or downloads it into `~/.n8n-manager/bin`.

Override cloudflared path:

```bash
N8N_MANAGER_CLOUDFLARED_BIN=/usr/local/bin/cloudflared
```

### Destructive operations

Deleting managed runtime data requires `--destroy-data --force`:

```bash
# Removes container, keeps volume
n8n-manager delete

# Removes container and volume (irreversible)
n8n-manager delete --destroy-data --force
```

## State and configuration

```bash
# State file location (default)
~/.n8n-manager/instance.json

# Override state path
N8N_MANAGER_STATE_PATH=/path/to/state.json

# Override n8n-manager home directory
N8N_MANAGER_HOME=~/.config/n8n-manager
```

### Credential commands auto-target

Credential commands automatically use the managed local n8n URL/API key when `N8N_MANAGER_STATE_PATH` points at a managed state file and no explicit `--url`/`--api-key` is provided.

When `N8N_HOST` and `N8N_API_KEY` are set, or when `--url` and `--api-key` are passed, credential setup uses the n8n REST API to list, create, patch, delete, and probe credentials.

## Environment variables

| Variable | Description |
|----------|-------------|
| `N8N_MANAGER_STATE_PATH` | Path to state file |
| `N8N_MANAGER_HOME` | Override n8n-manager home directory |
| `N8N_HOST` | n8n instance URL for credential operations |
| `N8N_API_KEY` | n8n API key for credential operations |
| `N8N_PROJECT_ID` | Default project ID |
| `N8N_CREDENTIAL_ONTOLOGY_PATH` | Path to `n8n-credentials-ontology.json` |
| `N8N_MANAGER_DOCKER_IMAGE` | Docker image for managed local |
| `N8N_MANAGER_DOCKER_CONTAINER` | Container name for managed local |
| `N8N_MANAGER_DOCKER_VOLUME` | Volume name for managed local |
| `N8N_MANAGER_DOCKER_PORT` | Port for managed local |
| `N8N_MANAGER_OWNER_EMAIL` | Owner email for bootstrap |
| `N8N_MANAGER_OWNER_PASSWORD` | Owner password for bootstrap |
| `N8N_MANAGER_OWNER_FIRST_NAME` | Owner first name |
| `N8N_MANAGER_OWNER_LAST_NAME` | Owner last name |
| `N8N_MANAGER_TUNNEL` | Default tunnel behavior (`true`/`false`) |
| `N8N_MANAGER_CLOUDFLARED_BIN` | Path to cloudflared binary |
| `N8N_MANAGER_WAIT_FOR_READY` | Wait for n8n ready (`true`/`false`, default `true`) |
| `N8N_MANAGER_RESET_STALE_OWNER` | Auto-reset stale owner (`true`/`false`, default `true`) |

## Local development with n8n-as-code

Use `/home/etienne/repos/n8n-ecosystem-dev` for end-to-end local facade testing. It exports `N8N_MANAGER_COMMAND`, `N8N_MANAGER_STATE_PATH`, `N8NAC_COMMAND`, and `N8N_CREDENTIAL_ONTOLOGY_PATH` so generated agent instructions can target local builds while published installs keep using `npx --yes n8nac`.

## Build from source

```bash
npm install
npm run check:deps
npm run sync:deps
npm run build
npm run test
npm run typecheck
```

## Contributors

Internal workspace dependencies are exact-pinned and auto-aligned to the current local package versions.

- `npm run sync:deps` rewrites stale internal workspace dependency specs locally.
- `npm run check:deps` is the CI-safe validation command and fails when a workspace manifest is out of sync.
- The pre-commit hook runs dependency sync and stages only the manifest updates it makes.
- Release automation may patch-bump dependent packages solely to publish updated internal dependency pins.
