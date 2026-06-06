# Agent Instructions for Model/Provider Updates

## Overview

This document describes how to audit and port model/provider definitions from upstream Cline (`cline/cline`) to this fork (`ec-jt/Roo-Code`).

## Architecture Differences

- **Cline** uses a monorepo structure: `apps/vscode/src/shared/api.ts` contains ALL model definitions in a single ~136KB file.
- **Roo Code** uses a modular structure: `packages/types/src/providers/` contains one file per provider (e.g., `openai.ts`, `anthropic.ts`, `gemini.ts`).

### Key Structural Differences

| Concept | Cline | Roo Code |
|---------|-------|----------|
| Model info type | `ModelInfo` with `supportsReasoning?: boolean` | `ModelInfo` with `supportsReasoningBudget?: boolean` and `supportsReasoningEffort?: string[]` |
| Reasoning config | `thinkingConfig: { maxBudget, outputPrice, geminiThinkingLevel }` | `maxThinkingTokens`, `supportsReasoningBudget`, `requiredReasoningBudget` |
| Provider list | `ApiProvider` union type in `api.ts` | `providerNames` array in `packages/types/src/provider-settings.ts` |
| Dynamic providers | Not categorized | Categorized as `dynamicProviders`, `localProviders`, `internalProviders`, `customProviders`, `fauxProviders` |
| 1M context | `:1m` suffix models (e.g., `claude-opus-4-6:1m`) | `tiers` array with `contextWindow: 1_000_000` + beta flag system |
| Temperature | `temperature?: number` on model | `supportsTemperature?: boolean` + `defaultTemperature?: number` |
| Tool preferences | Not present | `includedTools` / `excludedTools` arrays |
| Cache config | Not present | `minTokensPerCachePoint`, `maxCachePoints`, `cachableFields` (Bedrock) |

## How to Port Models

### Step 1: Read Cline's definitions
Use the GitHub MCP server to read `cline/cline` repo file `apps/vscode/src/shared/api.ts`.

### Step 2: Read Roo Code's definitions
Read the corresponding file in `packages/types/src/providers/<provider>.ts`.

### Step 3: Compare and identify gaps
Look for:
- New model IDs that Cline has but Roo doesn't
- Updated pricing (input/output/cache prices)
- New context window sizes
- New capability flags

### Step 4: Adapt the model definition
When porting a model from Cline to Roo Code:

1. **Map `supportsReasoning: true`** → Use `supportsReasoningBudget: true` for extended thinking models, or `supportsReasoningEffort: ["low", "medium", "high"]` for effort-based models.
2. **Map `thinkingConfig.maxBudget`** → Use `maxThinkingTokens` field.
3. **Map `temperature: number`** → Use `supportsTemperature: true` and optionally `defaultTemperature: number`.
4. **Map `:1m` suffix models** → Instead of creating separate model entries, add a `tiers` array with the 1M context pricing.
5. **Map `systemRole: "developer"`** → Not needed in Roo Code (handled at the handler level).
6. **Map `apiFormat: ApiFormat.OPENAI_RESPONSES`** → Not needed (Roo Code detects this automatically).
7. **Add `includedTools` / `excludedTools`** if the model works better with specific tools (e.g., `apply_patch` for GPT models).

### Step 5: Update related files if adding a new provider
If adding an entirely new provider (not just new models to existing providers):
1. Create `packages/types/src/providers/<provider>.ts`
2. Export from `packages/types/src/providers/index.ts`
3. Add to `providerNames` in `packages/types/src/provider-settings.ts`
4. Add provider schema and settings
5. Create handler in `src/api/providers/`
6. Add to `MODELS_BY_PROVIDER` in `provider-settings.ts`

## File Locations

| Purpose | Path |
|---------|------|
| Provider model definitions | `packages/types/src/providers/*.ts` |
| Provider settings/types | `packages/types/src/provider-settings.ts` |
| Model type definition | `packages/types/src/model.ts` |
| API handler options | `src/shared/api.ts` |
| Provider implementations | `src/api/providers/` |

## Providers in Roo Code (as of last audit)

### Active Providers
anthropic, openrouter, bedrock, vertex, openai, ollama, lmstudio, gemini, gemini-cli, openai-native, openai-codex, mistral, deepseek, poe, moonshot, minimax, requesty, unbound, xai, baseten, litellm, sambanova, zai, fireworks, qwen-code, vercel-ai-gateway, vscode-lm, fake-ai

### Retired Providers (migrated to dynamic routers)
cerebras, chutes, deepinfra, doubao, featherless, groq, huggingface, io-intelligence, roo

## Providers in Cline NOT in Roo Code
These providers exist in Cline but not in Roo Code. Porting them would require full provider implementation (handler + UI), not just model definitions:
- `claude-code` (Claude CLI integration)
- `together` (Together AI)
- `qwen` (full Qwen/Alibaba provider — Roo has `qwen-code` only)
- `nebius` (Nebius AI Studio)
- `asksage` (AskSage)
- `sapaicore` (SAP AI Core)
- `huawei-cloud-maas` (Huawei Cloud)
- `dify` (Dify.ai)
- `oca` (OCA)
- `aihubmix` (AIHubMix)
- `hicap` (HiCap)
- `nousResearch` (Nous Research)
- `wandb` (Weights & Biases)
- `cline` (Cline's own managed provider)
