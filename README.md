# n8n-manager

n8n-manager provides a ready-to-run n8n environment for humans and AI agents.

It does not just start n8n. It prepares n8n to run useful workflows by owning the infrastructure lifecycle, diagnostics, credential readiness, starter kits, and LLM proxy contract.

n8n-as-code is an independent community project and is not affiliated with, endorsed by, or sponsored by n8n.

## Positioning

`n8n-manager` is an independent runtime engine.

It does not own workflow generation or workflow intelligence. Those belong to the n8n-as-code workflow engine. User-facing facades such as `n8nac`, the VS Code/Cursor extension, MCP, Claude/OpenClaw plugins, YAGR, and future apps can import both engines:

```txt
facade
  -> workflow-core for generate / validate / search / explain
  -> n8n-manager for setup / credentials / deploy / run / inspect
```

The runtime engine must not depend on the workflow engine, and the workflow engine must not depend on this repo.

All facades should expose the same product choice:

```txt
How do you want to use n8n?

[Recommended] Create and manage a local n8n automatically
[Connect an existing n8n]
[Use generation-only mode]
```

## Packages

- `@n8n-as-code/n8n-manager-core`: lifecycle and diagnostics contracts.
- `@n8n-as-code/n8n-credentials-manager`: credential recipes, inventory, starter kits, and LLM source contracts.
- `@n8n-as-code/n8n-manager`: CLI entrypoint.

## CLI

```bash
n8n-manager setup --mode managed-local-docker
n8n-manager setup --mode managed-local-docker --tunnel
n8n-manager status
n8n-manager start
n8n-manager stop
n8n-manager restart
n8n-manager delete
n8n-manager credentials list
n8n-manager credentials setup llm-proxy
n8n-manager credentials delete llm-proxy
n8n-manager credentials starter-kit ai-workflows
n8n-manager credentials test llm-proxy
n8n-manager llm-proxy status
```

`n8n-manager` owns normal management operations. It can create/update instance configuration with `setup`, remove instance configuration with `delete`, and create/update/delete credentials through the credentials manager.

`managed-local-docker` creates a real local Docker container:

- image: `n8nio/n8n:latest`
- container: `n8n-manager-local`
- volume: `n8n-manager-local-data`
- URL: `http://127.0.0.1:5678`

These defaults can be overridden with `N8N_MANAGER_DOCKER_IMAGE`, `N8N_MANAGER_DOCKER_CONTAINER`, `N8N_MANAGER_DOCKER_VOLUME`, and `N8N_MANAGER_DOCKER_PORT`.

By default, managed local setup waits for n8n readiness, silently creates the owner account when possible, creates a scoped n8n API key, and stores it in the local n8n-manager state. CLI/status output redacts the raw key and reports `apiKeyAvailable`. Owner credentials are stored before first-run setup so retries can recover if n8n creates the owner but API key creation is interrupted. Set `N8N_MANAGER_OWNER_EMAIL` and `N8N_MANAGER_OWNER_PASSWORD` to reuse a known existing owner account.

Use `--tunnel` to expose the managed local n8n through Cloudflare Tunnel. `n8n-manager` resolves `cloudflared` from PATH or downloads it into `~/.n8n-manager/bin`.

Credential commands automatically use the managed local n8n URL/API key when `N8N_MANAGER_STATE_PATH` points at a managed state file and no explicit `--url`/`--api-key` is provided.

Destructive operations are supported only when they are explicit and guarded. Deleting managed runtime data requires `--destroy-data --force`; without `--destroy-data`, `delete` removes the managed container and leaves the Docker volume intact.

When `N8N_HOST` and `N8N_API_KEY` are set, or when `--url` and `--api-key` are passed, credential setup uses the n8n REST API to list, create, patch, delete, and probe credentials.

## Local development with n8n-as-code

Use `/home/etienne/repos/n8n-ecosystem-dev` for end-to-end local facade testing. It exports `N8N_MANAGER_COMMAND`, `N8N_MANAGER_STATE_PATH`, and `N8NAC_COMMAND` so generated agent instructions can target local builds while published installs keep using `npx --yes n8nac`.
