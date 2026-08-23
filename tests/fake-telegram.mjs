/**
 * A fake Telegram Bot API, just enough of it to drive the setup wizard.
 *
 * The wizard's interactive path is the first thing every new user hits and
 * the hardest part to test, because it needs a live bot, a real token, and a
 * human sending messages. This stands in for all three.
 *
 * Deliberately models the awkward cases rather than the happy one: a webhook
 * already set, privacy mode on until the operator fixes it, and a queue of
 * stale updates that must be drained before the wizard listens for the
 * message it just asked for.
 */

import { createServer } from "http";

export function startFakeTelegram({ port = 0 } = {}) {
  const state = {
    // Starts ON, like a real new bot. Flips when the wizard re-checks, which
    // stands in for the operator fixing it in BotFather.
    privacyMode: true,
    getMeCalls: 0,
    webhookUrl: "https://stale.example.com/hook",
    deletedWebhook: false,
    // Telegram keeps an update pending until the client asks for an offset
    // past it. Modelling that matters: the wizard drains without an offset,
    // then polls with one, and a fixture that simply hands everything over on
    // the first poll makes the second discovery step impossible.
    pending: [
      { update_id: 100, message: { chat: { id: 999, type: "private" }, from: { id: 999, first_name: "Stale" }, text: "old message" } },
      { update_id: 101, message: { chat: { id: 998, type: "private" }, from: { id: 998, first_name: "Older" }, text: "older still" } },
    ],
    // Updates that only appear once the client has acknowledged past a given
    // point, standing in for a person who sends a message when asked to.
    scripted: [],
  };

  /**
   * Queue an update that becomes visible once the client polls with an offset
   * at or beyond `afterOffset`.
   */
  function push(update, { afterOffset = 0 } = {}) {
    state.scripted.push({ afterOffset, update });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    const reply = (body, code = 200) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (!m) return reply({ ok: false, description: "Not Found" }, 404);
    const [, token, method] = m;

    // Validate by shape, as Telegram effectively does: <bot_id>:<secret>.
    // Anything else is Unauthorized, which is what the wizard's retry loop
    // needs to see.
    if (!/^\d{6,}:[\w-]{20,}$/.test(token)) {
      return reply({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    }

    switch (method) {
      case "getMe": {
        state.getMeCalls++;
        // Second call reports privacy mode fixed.
        if (state.getMeCalls > 1) state.privacyMode = false;
        return reply({
          ok: true,
          result: {
            id: 555, is_bot: true, first_name: "Test Bot", username: "test_bot",
            can_read_all_group_messages: !state.privacyMode,
          },
        });
      }
      case "getWebhookInfo":
        return reply({ ok: true, result: { url: state.deletedWebhook ? "" : state.webhookUrl, pending_update_count: 0 } });

      case "deleteWebhook":
        state.deletedWebhook = true;
        return reply({ ok: true, result: true });

      case "getUpdates": {
        const raw = url.searchParams.get("offset");
        const offset = raw === null ? null : Number(raw);
        if (offset !== null) {
          // An offset acknowledges everything below it.
          state.pending = state.pending.filter((u) => u.update_id >= offset);
        }
        // Scripted arrivals become visible once the client has got that far.
        const arrived = state.scripted.filter((sc) => sc.afterOffset <= (offset ?? 0));
        state.scripted = state.scripted.filter((sc) => sc.afterOffset > (offset ?? 0));
        state.pending.push(...arrived.map((sc) => sc.update));
        state.pending.sort((a, b) => a.update_id - b.update_id);
        const out = offset === null
          ? state.pending
          : state.pending.filter((u) => u.update_id >= offset);
        return reply({ ok: true, result: out });
      }
      default:
        return reply({ ok: false, description: `Unimplemented: ${method}` }, 400);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        state,
        push,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
