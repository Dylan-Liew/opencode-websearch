import {
  ActiveModel,
  ProviderResolution,
  ProviderResolutionMap,
  ProviderType,
  SearchConfig,
} from "./types.js";
import { Plugin } from "@opencode/plugin";
import {
  ProviderData,
  formatNoProviderError,
  formatUnsupportedProviderError,
  resolveFromProviders,
  resolveModelOverrides,
} from "./config.js";
import { getCurrentMonthYear } from "./helpers.js";
import { CHATGPT_DEFAULT_BASE_URL } from "./providers/chatgpt/constants.js";
import { COPILOT_DEFAULT_BASE_URL } from "./providers/copilot/constants.js";
import { dispatchErrorMessage, dispatchSearch } from "./providers/index.js";
import {
  RESOLUTION_PRIORITY,
  detectProviderTypeFromNpm,
  detectProviderTypeFromProviderID,
} from "./providers/registry.js";

// ── Constants ──────────────────────────────────────────────────────────

const MIN_QUERY_LENGTH = 2;

// ── Provider detection ─────────────────────────────────────────────────

const detectUniformProviderType = (models: ProviderData["models"]): ProviderType | null => {
  let detectedType: ProviderType | null = null;

  for (const model of Object.values(models)) {
    const modelType = detectProviderTypeFromNpm(model.api.npm);
    if (!modelType) {
      continue;
    }

    if (!detectedType) {
      detectedType = modelType;
      continue;
    }

    if (detectedType !== modelType) {
      return null;
    }
  }

  return detectedType;
};

const detectProviderTypeFromProviderModels = (
  models: ProviderData["models"],
  activeModelID: string,
): ProviderType | null => {
  for (const model of Object.values(models)) {
    if (model.id !== activeModelID) {
      continue;
    }

    const modelType = detectProviderTypeFromNpm(model.api.npm);
    if (modelType) {
      return modelType;
    }
  }

  return detectUniformProviderType(models);
};

const detectTypeFromActiveProvider = (
  active: ActiveModel,
  providers: ProviderData[],
): ProviderType | null => {
  for (const provider of providers) {
    if (provider.id !== active.providerID) {
      continue;
    }

    const modelsType = detectProviderTypeFromProviderModels(provider.models, active.modelID);
    if (modelsType) {
      return modelsType;
    }

    const providerType = detectProviderTypeFromProviderID(provider.id);
    if (providerType) {
      return providerType;
    }
  }

  return null;
};

const detectTypeFromAnyModelMatch = (
  activeModelID: string,
  providers: ProviderData[],
): ProviderType | null => {
  for (const provider of providers) {
    for (const model of Object.values(provider.models)) {
      if (model.id !== activeModelID) {
        continue;
      }

      const modelType = detectProviderTypeFromNpm(model.api.npm);
      if (modelType) {
        return modelType;
      }
    }
  }

  return null;
};

const detectActiveProviderType = (
  active: ActiveModel | undefined,
  providers: ProviderData[],
): ProviderType | null => {
  if (!active) {
    return null;
  }

  const activeProviderType = detectTypeFromActiveProvider(active, providers);
  if (activeProviderType) {
    return activeProviderType;
  }

  const modelMatchType = detectTypeFromAnyModelMatch(active.modelID, providers);
  if (modelMatchType) {
    return modelMatchType;
  }

  return detectProviderTypeFromProviderID(active.providerID);
};

// ── Model resolution ───────────────────────────────────────────────────

interface ResolvedProvider {
  config: SearchConfig;
  providerType: ProviderType;
}

const buildSearchConfig = (resolution: ProviderResolution, modelID: string): SearchConfig => ({
  accountId: resolution.credentials.accountId,
  apiKey: resolution.credentials.apiKey,
  baseURL: resolution.credentials.baseURL,
  model: modelID,
});

const resolveModelByPriority = (
  resolutions: ProviderResolutionMap,
  modelKey: "fallbackModel" | "lockedModel",
): ResolvedProvider | null => {
  for (const providerType of RESOLUTION_PRIORITY) {
    const resolution = resolutions[providerType];
    if (!resolution) {
      continue;
    }

    const modelID = resolution[modelKey];
    if (!modelID) {
      continue;
    }

    return {
      config: buildSearchConfig(resolution, modelID),
      providerType,
    };
  }

  return null;
};

/**
 * Resolve the locked model for a given provider resolution.
 * Returns a ResolvedProvider if a locked model is set, otherwise null.
 */
const resolveLockedModel = (resolutions: ProviderResolutionMap): ResolvedProvider | null =>
  resolveModelByPriority(resolutions, "lockedModel");

/**
 * Resolve using the active model's provider directly.
 */
const resolveActiveModel = (
  activeType: ProviderType,
  active: ActiveModel,
  resolutions: ProviderResolutionMap,
): ResolvedProvider | null => {
  if (activeType === "openai" && resolutions.chatgpt) {
    return {
      config: buildSearchConfig(resolutions.chatgpt, active.modelID),
      providerType: "chatgpt",
    };
  }

  const resolution = resolutions[activeType];
  if (!resolution) {
    return null;
  }

  return {
    config: buildSearchConfig(resolution, active.modelID),
    providerType: activeType,
  };
};

/**
 * Resolve a fallback model from any provider with `"websearch": "auto"`.
 */
const resolveFallbackModel = (resolutions: ProviderResolutionMap): ResolvedProvider | null =>
  resolveModelByPriority(resolutions, "fallbackModel");

/**
 * Determine which provider and model to use for a web search call.
 *
 * Priority:
 * 1. Locked model (`"websearch": "always"`) from any provider — always wins
 * 2. Active model if it belongs to a supported provider — use directly
 * 3. Fallback model (`"websearch": "auto"`) from any provider — when active is unsupported
 * 4. null — no usable provider/model found
 */
const resolveSearchProvider = (
  resolutions: ProviderResolutionMap,
  active: ActiveModel | undefined,
  activeType: ProviderType | null,
): ResolvedProvider | null => {
  const locked = resolveLockedModel(resolutions);
  if (locked) {
    return locked;
  }

  if (activeType && active) {
    const resolved = resolveActiveModel(activeType, active, resolutions);
    if (resolved) {
      return resolved;
    }
  }

  return resolveFallbackModel(resolutions);
};

// ── Lazy provider resolution ───────────────────────────────────────────

interface ProviderState {
  list: ProviderData[];
  resolutions: ProviderResolutionMap;
}

const resolveProviderState = async (ctx: Plugin.Context): Promise<ProviderState> => {
  const [providers, models] = await Promise.all([ctx.provider.list(), ctx.model.list()]);
  const list: ProviderData[] = [];
  const oauth: ProviderResolutionMap = {};
  for (const provider of providers.data) {
    const options = { ...provider.settings };
    const connection = await ctx.integration.connection.active(
      provider.integrationID ?? provider.id,
    );
    const credential = connection && (await ctx.integration.connection.resolve(connection));
    if (credential?.type === "key") {
      options.apiKey = credential.key;
    }
    const entries = models.data.filter((model) => model.providerID === provider.id);
    list.push({
      id: provider.id,
      models: Object.fromEntries(
        entries.map((model) => [
          model.id,
          {
            api: { npm: (model.package ?? provider.package).replace(/^aisdk:/, "") },
            id: model.id,
            options: model.settings ?? {},
          },
        ]),
      ),
      options,
    });
    if (credential?.type !== "oauth") {
      continue;
    }
    if (provider.id === "openai" && !options.baseURL) {
      oauth.chatgpt = {
        credentials: {
          accountId: credential.metadata?.accountID as string | undefined,
          apiKey: credential.access,
          baseURL: CHATGPT_DEFAULT_BASE_URL,
        },
        providerType: "chatgpt",
      };
    }
    if (provider.id === "github-copilot") {
      let baseURL = COPILOT_DEFAULT_BASE_URL;
      const enterprise = credential.metadata?.enterpriseUrl;
      if (typeof enterprise === "string" && enterprise) {
        baseURL = `https://copilot-api.${enterprise.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
      }
      oauth.copilot = {
        credentials: { apiKey: credential.refresh, baseURL },
        providerType: "copilot",
      };
    }
  }
  const resolutions = resolveFromProviders(list);
  for (const type of ["chatgpt", "copilot"] as const) {
    const value = oauth[type];
    if (value) {
      let source: "openai" | "copilot" = "openai";
      if (type === "copilot") {
        source = "copilot";
      }
      resolutions[type] = { ...value, ...resolveModelOverrides(list, source) };
    }
  }
  return { list, resolutions };
};

const hasAnyProvider = (resolutions: ProviderResolutionMap): boolean => {
  if (resolutions.anthropic) {
    return true;
  }

  if (resolutions.chatgpt) {
    return true;
  }

  if (resolutions.openai) {
    return true;
  }

  if (resolutions.copilot) {
    return true;
  }

  return false;
};

// ── Plugin ─────────────────────────────────────────────────────────────

// oxlint-disable-next-line import/no-default-export -- plugin entry point requires default export
export default Plugin.define({
  id: "opencode-websearch",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        description: `Search the web for current information. Cite relevant source URLs as Markdown links in your response. It is currently ${getCurrentMonthYear()}.`,
        async execute(input, context) {
          const args = input as { query: string };
          const state = await resolveProviderState(ctx);
          if (!hasAnyProvider(state.resolutions)) {
            return { content: formatNoProviderError() };
          }
          const session = await ctx.session.get({ sessionID: context.sessionID });
          let active: ActiveModel | undefined;
          if (session.model) {
            active = { modelID: session.model.id, providerID: session.model.providerID };
          }
          const resolved = resolveSearchProvider(
            state.resolutions,
            active,
            detectActiveProviderType(active, state.list),
          );
          if (!resolved) {
            return { content: formatUnsupportedProviderError(active?.modelID ?? "unknown") };
          }
          try {
            return {
              content: await dispatchSearch(resolved.providerType, resolved.config, args.query),
            };
          } catch (error) {
            return { content: dispatchErrorMessage(resolved.providerType, error) };
          }
        },
        input: {
          additionalProperties: false,
          properties: {
            query: {
              description: "The search query to use",
              minLength: MIN_QUERY_LENGTH,
              type: "string",
            },
          },
          required: ["query"],
          type: "object",
        },
        name: "web-search",
      });
    });
  },
});
