/**
 * Media handling — outbound file sending + media group debouncing.
 *
 * Outbound: Parses <outbound_files> blocks from Claude responses and sends them
 * as Telegram documents/photos.
 *
 * Debouncing: When Telegram sends a media group (multiple photos at once), they
 * arrive as separate messages with the same media_group_id. We debounce them into
 * a single Claude prompt.
 */

import { existsSync } from "fs";
import { basename, extname } from "path";

// ---------------------------------------------------------------------------
// Outbound file parsing
// ---------------------------------------------------------------------------

const FILE_BLOCK_RE = /<outbound_files>\s*([\s\S]*?)\s*<\/outbound_files>/g;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

/**
 * Parse outbound file paths from Claude's response text.
 * Returns { cleanText, files[] } where files have { path, caption }.
 */
export function parseOutboundFiles(text) {
  if (!text) return { cleanText: text, files: [] };

  const files = [];
  const cleanText = text.replace(FILE_BLOCK_RE, (_, content) => {
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Support "path | caption" or just "path"
      const [filePath, ...captionParts] = trimmed.split("|");
      const path = filePath.trim();
      const caption = captionParts.join("|").trim() || null;

      if (path && existsSync(path)) {
        files.push({ path, caption });
      }
    }
    return ""; // Remove the block from the text
  }).trim();

  return { cleanText, files };
}

/**
 * Send files via Telegram bot. Photos for images, documents for everything else.
 */
export async function sendOutboundFiles(bot, chatId, files) {
  const results = [];
  for (const file of files) {
    try {
      const ext = extname(file.path).toLowerCase();
      const opts = file.caption ? { caption: file.caption } : {};

      if (IMAGE_EXTS.has(ext)) {
        const msg = await bot.sendPhoto(chatId, file.path, opts);
        results.push({ path: file.path, type: "photo", ok: true, messageId: msg.message_id });
      } else {
        const msg = await bot.sendDocument(chatId, file.path, opts, {
          filename: basename(file.path),
        });
        results.push({ path: file.path, type: "document", ok: true, messageId: msg.message_id });
      }
    } catch (err) {
      results.push({ path: file.path, type: "unknown", ok: false, error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Media group debouncing
// ---------------------------------------------------------------------------

/**
 * Creates a debouncer for Telegram media groups.
 *
 * When multiple photos are sent as a group, Telegram delivers them as separate
 * messages with the same media_group_id. This collects them and fires the
 * callback once with all messages.
 *
 * Usage:
 *   const debouncer = createMediaGroupDebouncer(1500, (chatId, messages) => { ... });
 *   // In message handler:
 *   if (msg.media_group_id) {
 *     debouncer.add(msg);
 *     return; // Don't process individually
 *   }
 */
export function createMediaGroupDebouncer(delayMs = 1500, callback) {
  const pending = new Map(); // mediaGroupId -> { chatId, messages[], timer }

  return {
    add(msg) {
      const groupId = msg.media_group_id;
      if (!groupId) return false;

      const existing = pending.get(groupId);
      if (existing) {
        existing.messages.push(msg);
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => {
          pending.delete(groupId);
          callback(existing.chatId, existing.messages);
        }, delayMs);
      } else {
        const entry = {
          chatId: msg.chat.id,
          messages: [msg],
          timer: setTimeout(() => {
            pending.delete(groupId);
            callback(entry.chatId, entry.messages);
          }, delayMs),
        };
        pending.set(groupId, entry);
      }
      return true;
    },

    /** Number of groups currently waiting. */
    get pendingCount() {
      return pending.size;
    },

    /** Clear all pending groups (for shutdown). */
    clear() {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
      }
      pending.clear();
    },
  };
}
