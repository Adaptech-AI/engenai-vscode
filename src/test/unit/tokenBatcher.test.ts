import * as assert from "assert";
import { TokenBatcher } from "../../streaming/TokenBatcher.js";
import type { ExtensionToWebview } from "../../types/protocol.js";

suite("TokenBatcher", () => {
  test("batches tokens and flushes", (done) => {
    const messages: ExtensionToWebview[] = [];
    const batcher = new TokenBatcher((msg) => messages.push(msg));

    batcher.addToken("keith", "Hello ");
    batcher.addToken("keith", "world");

    // After batch interval (16ms), should flush
    setTimeout(() => {
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].type, "streamToken");
      if (messages[0].type === "streamToken") {
        assert.strictEqual(messages[0].content, "Hello world");
        assert.strictEqual(messages[0].agentId, "keith");
      }
      batcher.dispose();
      done();
    }, 30);
  });

  test("endStream flushes remaining and sends end event", () => {
    const messages: ExtensionToWebview[] = [];
    const batcher = new TokenBatcher((msg) => messages.push(msg));

    batcher.addToken("sophi", "partial");
    batcher.endStream("sophi");

    // Should have flushed the remaining content + sent streamEnd
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].type, "streamToken");
    assert.strictEqual(messages[1].type, "streamEnd");
    if (messages[1].type === "streamEnd") {
      assert.strictEqual(messages[1].agentId, "sophi");
    }
    batcher.dispose();
  });

  test("dispose clears timers and buffers", () => {
    const messages: ExtensionToWebview[] = [];
    const batcher = new TokenBatcher((msg) => messages.push(msg));

    batcher.addToken("marv", "test");
    batcher.dispose();

    // Timer cleared — no flush should happen
    setTimeout(() => {
      assert.strictEqual(messages.length, 0);
    }, 30);
  });
});
