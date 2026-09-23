# opencode-websearch

Native web search for [OpenCode](https://opencode.ai), powered by your model's built-in search capability. No extra API keys or search services required. If you're on a supported provider, it works without any extra setup.

> [!IMPORTANT]
> Version 1.x supports OpenCode v2 only. OpenCode v1 is no longer supported; use the final 0.x release if you must remain on v1.

Inspired by Claude Code's WebSearch tool.

## Example

Asking OpenCode about the latest PostgreSQL version:

> **What's the latest Postgres version?**
>
> ⚙ `web-search` [query=latest PostgreSQL release version April 2026]
>
> As of now (April 2026), the latest PostgreSQL community release is PostgreSQL 18.3.  
> If you mean the latest major version line, that is PostgreSQL 18.
>
> Sources:
>
> - [PostgreSQL Roadmap](https://www.postgresql.org/developer/roadmap/)
> - [PostgreSQL News Archive (2026-02-26 release)](https://www.postgresql.org/about/newsarchive/-/20260226/)

## Supported providers

| Provider         | What you need                                                            |
| ---------------- | ------------------------------------------------------------------------ |
| Anthropic        | An Anthropic provider/model in OpenCode with built-in web search support |
| OpenAI / ChatGPT | OpenAI configured in OpenCode (API key or ChatGPT connected)             |
| GitHub Copilot   | GitHub Copilot connected in OpenCode                                     |

Model-level web search support depends on the provider and model you use.

## Install

This fork is released from GitHub because the unscoped npm package belongs to the upstream maintainer. Install the v2 release directly from GitHub:

```bash
opencode plugin add github:Dylan-Liew/opencode-websearch#v1.0.0
```

Or add the Git package specifier to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:Dylan-Liew/opencode-websearch#v1.0.0"]
}
```

## Configuration (optional)

By default the plugin uses your active model. The optional `"websearch"` flag lets you pin or provide a fallback model for search:

- `"always"`: always use this model for web search
- `"auto"`: use this model as fallback when your active provider is not supported

### Selection order

1. A model tagged `"websearch": "always"`
2. Your active model (if on a supported provider)
3. A model tagged `"websearch": "auto"`
4. Otherwise, the tool returns an error

### Example

```json
{
  "provider": {
    "openai": {
      "models": {
        "gpt-5.2": {
          "options": {
            "websearch": "always"
          }
        }
      }
    }
  }
}
```

## Development

### Local development

Clone the repo and symlink the source entry into your OpenCode plugin directory:

```sh
git clone https://github.com/Dylan-Liew/opencode-websearch ~/.config/opencode/opencode-websearch
cd ~/.config/opencode/opencode-websearch
bun install
mkdir -p ~/.config/opencode/plugin
ln -sf ~/.config/opencode/opencode-websearch/src/index.ts ~/.config/opencode/plugin/websearch.ts
```

OpenCode loads the plugin directly from source at startup.

> When using this symlink setup, remove the Git package specifier from the `plugins` array in `opencode.json` to avoid loading it twice.

### Commands

```sh
bun install
bun run format
bun run format:check
bun run lint
bun run lint:fix
bun run typecheck
bun run check
bun run build
```

## License

MIT
