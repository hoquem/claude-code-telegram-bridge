/**
 * The bridge's model vocabulary — tiers, resolution, and outage fallback.
 *
 * There is no prompt classifier. A model is chosen by an explicit pin, and
 * nothing else:
 *
 *   interactive chat   ANTHROPIC_MODEL_FORCE → /model pin → default tier
 *   subagent           the agent's own `model:` frontmatter → default tier
 *   cron job           ANTHROPIC_MODEL_FORCE → the job's `model` → default tier
 *
 * Tier names are the shared vocabulary across all three, and the id each one
 * resolves to is configurable — so a new model release is an env change, not
 * a code change.
 */

import { config } from "./config.mjs";

/** Tier names accepted by /model. "auto" clears a pin. */
export const MODEL_TIERS = ["fable", "sonnet", "haiku", "auto"];

/**
 * Claude Code's own frontmatter vocabulary, mapped onto these tiers.
 *
 * Subagent files are written for the CLI first, where `model: opus` and
 * `model: inherit` are the normal things to write. The bridge reads those
 * same files, so it has to speak that language: without this, an agent
 * pinned to the strongest model silently lands on the default tier.
 */
const TIER_ALIASES = {
  opus: "fable",     // both name the top tier
  inherit: null,     // "whatever the parent uses" is the default tier here
  default: null,
};

/** Reasoning-effort levels accepted by /effort. "auto" clears the setting. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "auto"];

/**
 * Resolve a tier name to a model id.
 *
 * :param tier: Tier name, or a full model id (passed through unchanged).
 * :param cfg: Config object supplying the per-tier ids.
 * :returns: Model id, or ``null`` for "auto", empty, and unrecognized input.
 *   Callers decide what an unresolvable value means — see ``resolveModelOr``.
 */
export function resolveModelTier(tier, cfg = config) {
  if (tier in TIER_ALIASES) tier = TIER_ALIASES[tier];
  switch (tier) {
    case "fable": return cfg.fableModel;
    case "sonnet": return cfg.sonnetModel;
    case "haiku": return cfg.haikuModel;
    default: return null;
  }
}

/** The model id used when nothing is pinned. */
export function defaultModel(cfg = config) {
  return resolveModelTier(cfg.defaultModelTier, cfg) || cfg.sonnetModel;
}

/**
 * Resolve a tier to a model id, falling back to the default tier — but never
 * silently. An unrecognized tier is a typo in someone's agent file or cron
 * job, and quietly running it on the wrong model is how that typo survives
 * for months.
 *
 * :param tier: Tier name to resolve; ``null``/undefined means "not pinned"
 *   and is not a warning.
 * :param source: Where the value came from, for the warning message.
 * :param onWarn: Called with a human-readable warning when a value is present
 *   but unrecognized.
 * :returns: Model id.
 */
export function resolveModelOr(tier, source, onWarn = console.warn, cfg = config) {
  if (!tier) return defaultModel(cfg);
  // An alias mapping to null ("inherit") is a deliberate choice, not a typo.
  if (tier in TIER_ALIASES && TIER_ALIASES[tier] === null) return defaultModel(cfg);
  // A full model id (contains a dash and isn't a tier name) is taken as-is:
  // it lets a job pin an exact snapshot without inventing a tier for it.
  const resolved = resolveModelTier(tier, cfg);
  if (resolved) return resolved;
  if (/^claude-/.test(tier)) return tier;
  onWarn(
    `${source}: unrecognized model "${tier}" — expected one of ` +
    `${MODEL_TIERS.filter((t) => t !== "auto").join("/")}, opus, inherit, or a claude-* model id. ` +
    `Using the default tier (${cfg.defaultModelTier}) instead.`
  );
  return defaultModel(cfg);
}

/**
 * Pick the model for a query.
 *
 * :param pin: An explicit tier or model id, if the caller has one.
 * :param source: Label used if ``pin`` turns out to be unrecognized.
 * :returns: Model id.
 */
export function pickModel(pin = null, source = "model", onWarn = console.warn, cfg = config) {
  if (cfg.modelForce) return cfg.modelForce;
  return resolveModelOr(pin, source, onWarn, cfg);
}

/**
 * Adjacent-tier model to retry on when the primary fails.
 *
 * Passed as ``options.fallbackModel``; the SDK retries on it when the primary
 * is overloaded, unavailable, or hitting a refusal-class outage. Policy:
 * fable → sonnet (quality-adjacent, separate pool); sonnet → haiku
 * (availability over quality); haiku → sonnet (different capacity pool —
 * haiku is the bottom tier, so it falls back *up* rather than to itself).
 * Never returns the primary.
 *
 * :param model: The primary model id.
 * :returns: A different model id.
 */
export function fallbackModelFor(model, cfg = config) {
  if (model === cfg.fableModel) return cfg.sonnetModel;
  if (model === cfg.sonnetModel) return cfg.haikuModel;
  if (model === cfg.haikuModel) return cfg.sonnetModel;
  // Unknown or force-pinned id: sonnet, unless that IS the model.
  return model === cfg.sonnetModel ? cfg.haikuModel : cfg.sonnetModel;
}

/**
 * Did the turn actually run on the model we routed it to?
 *
 * ``modelUsage`` keys are resolved model ids, which may carry a date suffix
 * the routed alias lacks (``claude-sonnet-4-5-20250929`` for a query routed
 * as ``claude-sonnet-4-5``). A strict equality check would report
 * "primary-model-not-used" on every single query and bury the real fallback
 * events it exists to surface.
 *
 * :param model: The model id the bridge asked for.
 * :param modelsUsed: Model ids reported in the result's ``modelUsage``.
 * :returns: ``true`` when at least one reported id is the routed model.
 */
export function usedPrimaryModel(model, modelsUsed) {
  return modelsUsed.some((id) => id === model || id.startsWith(`${model}-`));
}
