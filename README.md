# n8n-manager

n8n-manager provides a ready-to-run n8n environment for humans and AI agents.

It does not just start n8n. It prepares n8n to run useful workflows by owning the infrastructure lifecycle, diagnostics, credential readiness, starter kits, and LLM proxy contract.

n8n-as-code is an independent community project and is not affiliated with, endorsed by, or sponsored by n8n.

## Packages

- `@n8n-as-code/n8n-manager-core`: lifecycle and diagnostics contracts.
- `@n8n-as-code/n8n-credentials-manager`: credential recipes, inventory, starter kits, and LLM source contracts.
- `@n8n-as-code/n8n-manager`: CLI entrypoint.

## CLI

```bash
n8n-manager setup
n8n-manager status
n8n-manager credentials list
n8n-manager credentials setup llm-proxy
n8n-manager credentials starter-kit ai-workflows
n8n-manager credentials test llm-proxy
n8n-manager llm-proxy status
```

The current implementation is intentionally non-destructive. It records credential readiness and exposes stable contracts before wiring destructive lifecycle operations such as reset, destroy, or volume deletion.

When `N8N_HOST` and `N8N_API_KEY` are set, or when `--url` and `--api-key` are passed, credential setup uses the n8n REST API to list, create, patch, and probe credentials.
