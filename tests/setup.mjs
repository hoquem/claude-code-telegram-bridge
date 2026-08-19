/**
 * Test bootstrap, loaded via `node --import ./tests/setup.mjs`.
 *
 * config.mjs refuses to start without an allowlist — deliberately, so a real
 * deployment can't boot wide open. Tests need that same module, so they
 * supply a throwaway allowlist here, before any static import runs.
 */

process.env.ALLOWED_TELEGRAM_USERS ||= "111111";
process.env.TELEGRAM_BOT_TOKEN ||= "test-token";

// Pin model ids so tier-resolution assertions don't move when the defaults do.
process.env.FABLE_MODEL_ID ||= "claude-fable-5";
process.env.SONNET_MODEL_ID ||= "claude-sonnet-4-5";
process.env.HAIKU_MODEL_ID ||= "claude-haiku-4-5";
delete process.env.ANTHROPIC_MODEL_FORCE;
