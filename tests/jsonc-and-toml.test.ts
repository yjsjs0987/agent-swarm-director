/**
 * Tests for JSONC parser, TOML fence manager, and secret redactor.
 * Uses node:test and node:assert/strict.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseJsonc, upsertTomlFence, removeTomlFence } from "../src/core/jsonc.ts";
import { redactSecrets } from "../src/core/redact.ts";
import { ASD_VERSION } from "../src/core/types.ts";

describe("jsonc.ts - parseJsonc", () => {
  test("parses valid JSON without comments", () => {
    const input = '{"a": 1, "b": [1, 2, 3]}';
    const result = parseJsonc(input);
    assert.deepEqual(result, { a: 1, b: [1, 2, 3] });
  });

  test("strips single-line // comments", () => {
    const input = `{
      "a": 1, // this is a comment
      "b": 2
    }`;
    const result = parseJsonc(input);
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  test("strips block /* */ comments", () => {
    const input = `{
      "a": 1, /* this is a
      multi-line comment */
      "b": 2
    }`;
    const result = parseJsonc(input);
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  test("removes trailing commas before }", () => {
    const input = `{
      "a": 1,
      "b": 2,
    }`;
    const result = parseJsonc(input);
    assert.deepEqual(result, { a: 1, b: 2 });
  });

  test("removes trailing commas before ]", () => {
    const input = `{
      "arr": [1, 2, 3,]
    }`;
    const result = parseJsonc(input);
    assert.deepEqual(result, { arr: [1, 2, 3] });
  });

  test("preserves // inside string literals (URLs)", () => {
    const input = '{"url": "https://example.com/path"}';
    const result = parseJsonc(input);
    assert.deepEqual(result, { url: "https://example.com/path" });
  });

  test("preserves /* inside string literals", () => {
    const input = '{"text": "hello /* not a comment */ world"}';
    const result = parseJsonc(input);
    assert.deepEqual(result, { text: "hello /* not a comment */ world" });
  });

  test("handles nested objects and arrays", () => {
    const input = `{
      "obj": {
        "nested": [1, 2, {"deep": true},]
      },
      "arr": [
        {"x": 1},
        {"y": 2},
      ]
    }`;
    const result = parseJsonc(input);
    assert.deepEqual(result, {
      obj: { nested: [1, 2, { deep: true }] },
      arr: [{ x: 1 }, { y: 2 }],
    });
  });

  test("throws descriptive SyntaxError on invalid JSON", () => {
    const input = '{"a": 1, "b": }';
    assert.throws(
      () => parseJsonc(input),
      /Invalid JSONC:/
    );
  });

  test("throws on unclosed string", () => {
    const input = '{"a": "unclosed}';
    assert.throws(
      () => parseJsonc(input),
      /Invalid JSONC:/
    );
  });

  test("handles empty object and array", () => {
    assert.deepEqual(parseJsonc("{}"), {});
    assert.deepEqual(parseJsonc("[]"), []);
  });

  test("handles comments at start and end", () => {
    const input = `// comment at start
    {"a": 1} // comment at end`;
    const result = parseJsonc(input);
    assert.deepEqual(result, { a: 1 });
  });

  test("handles mixed comment styles", () => {
    const input = `/* block */ {"a": 1, "b": 2} // line
    /* another block */`;
    const result = parseJsonc(input);
    assert.deepEqual(result, { a: 1, b: 2 });
  });
});

describe("jsonc.ts - TOML fence management", () => {
  const testContent = "key = \"value\"\nother = 123";

  test("upsertTomlFence into empty string", () => {
    const result = upsertTomlFence("", testContent);
    assert.ok(result.includes(BEGIN_FENCE));
    assert.ok(result.includes(END_FENCE));
    assert.ok(result.includes(testContent));
  });

  test("upsertTomlFence is idempotent", () => {
    const first = upsertTomlFence("", testContent);
    const second = upsertTomlFence(first, testContent);
    assert.equal(first, second);
  });

  test("upsertTomlFence replaces content when called with different content", () => {
    const first = upsertTomlFence("", "old = 1");
    const second = upsertTomlFence(first, "new = 2");
    assert.ok(!second.includes("old = 1"));
    assert.ok(second.includes("new = 2"));
  });

  test("upsertTomlFence replaces fence with different version marker", () => {
    const first = upsertTomlFence("", testContent, "1.0.0");
    const second = upsertTomlFence(first, testContent, "2.0.0");
    assert.ok(second.includes("v2.0.0"));
    assert.ok(!second.includes("v1.0.0"));
  });

  test("upsertTomlFence preserves non-fenced user content", () => {
    const userContent = "# User config\nuser_key = \"user_value\"\n";
    const result = upsertTomlFence(userContent, testContent);
    assert.ok(result.includes("user_key = \"user_value\""));
    assert.ok(result.includes(testContent));
  });

  test("removeTomlFence removes fence and markers", () => {
    const withFence = upsertTomlFence("", testContent);
    const result = removeTomlFence(withFence);
    assert.ok(!result.includes(BEGIN_FENCE));
    assert.ok(!result.includes(END_FENCE));
    assert.ok(!result.includes(testContent));
  });

  test("removeTomlFence preserves non-fenced content", () => {
    const userContent = "# User config\nuser_key = \"user_value\"\n";
    const withFence = upsertTomlFence(userContent, testContent);
    const result = removeTomlFence(withFence);
    assert.ok(result.includes("user_key = \"user_value\""));
  });

  test("removeTomlFence handles multiple fences", () => {
    let toml = upsertTomlFence("", "first = 1", "1.0.0");
    toml = upsertTomlFence(toml, "second = 2", "2.0.0");
    const result = removeTomlFence(toml);
    assert.ok(!result.includes("first = 1"));
    assert.ok(!result.includes("second = 2"));
    assert.ok(!result.includes(BEGIN_FENCE));
    assert.ok(!result.includes(END_FENCE));
  });

  test("F19: upsertTomlFence places managed block before the first [table] header so root keys never fall into a table", () => {
    const userWithTables = [
      'model = "gpt-5.4"',
      "",
      "[features]",
      "web_search = true",
      "",
      "[profiles.fast]",
      'model = "gpt-5-mini"',
    ].join("\n");

    const fenced = upsertTomlFence(userWithTables, 'notify = ["node", "hook.js"]');
    const idxModel = fenced.indexOf('model = "gpt-5.4"');
    const idxFence = fenced.indexOf(BEGIN_FENCE);
    const idxNotify = fenced.indexOf('notify = ["node", "hook.js"]');
    const idxEndFence = fenced.indexOf(END_FENCE);
    const idxFeatures = fenced.indexOf("[features]");

    assert.ok(idxModel !== -1 && idxFence !== -1 && idxFeatures !== -1);
    assert.ok(idxModel < idxFence, "Root user keys must stay above fence");
    assert.ok(idxNotify < idxFeatures, "notify in fence must appear BEFORE [features] table header");
    assert.ok(idxEndFence < idxFeatures, "END_FENCE must appear BEFORE [features] table header");

    // Idempotency check with tables
    const second = upsertTomlFence(fenced, 'notify = ["node", "hook.js"]');
    assert.equal(fenced, second);

    // Also relocates an existing legacy fence that was previously below [features]
    const legacyMisplaced = `model = "gpt-5.4"\n\n[features]\nweb_search = true\n\n${BEGIN_FENCE}\nnotify = ["old"]\n${END_FENCE}\n`;
    const relocated = upsertTomlFence(legacyMisplaced, 'notify = ["node", "hook.js"]');
    assert.ok(
      relocated.indexOf('notify = ["node", "hook.js"]') < relocated.indexOf("[features]"),
      "Legacy fence below [features] must be relocated before [features]"
    );
  });
});

describe("redact.ts - redactSecrets", () => {
  test("redacts AWS AKIA keys", () => {
    const input = "AKIAIOSFODNN7EXAMPLE";
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts AWS ASIA keys", () => {
    const input = "ASIAIOSFODNN7EXAMPLE";
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts JWT tokens", () => {
    const input = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts PEM private key blocks", () => {
    const input = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD...
-----END PRIVATE KEY-----`;
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts OpenAI/Anthropic sk- keys", () => {
    const input = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts GitHub ghp_ tokens", () => {
    const input = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts Google AIza keys", () => {
    const input = "AIzaSyB-abcdefghijklmnopqrstuvwxyz12345";
    const result = redactSecrets(input);
    assert.equal(result, "[REDACTED]");
  });

  test("redacts password=value assignments", () => {
    const input = 'password=secret123';
    const result = redactSecrets(input);
    assert.equal(result, 'password=[REDACTED]');
  });

  test("redacts password: value assignments", () => {
    const input = 'password: secret123';
    const result = redactSecrets(input);
    assert.equal(result, 'password: [REDACTED]');
  });

  test("redacts quoted password assignments", () => {
    const input = '"password": "secret123"';
    const result = redactSecrets(input);
    assert.equal(result, '"password": "[REDACTED]"');
  });

  test("redacts secret assignments", () => {
    const input = 'secret=mysecret';
    const result = redactSecrets(input);
    assert.equal(result, 'secret=[REDACTED]');
  });

  test("redacts token assignments", () => {
    const input = 'token=mytoken123';
    const result = redactSecrets(input);
    assert.equal(result, 'token=[REDACTED]');
  });

  test("redacts api_key assignments", () => {
    const input = 'api_key=myapikey';
    const result = redactSecrets(input);
    assert.equal(result, 'api_key=[REDACTED]');
  });

  test("redacts api-key assignments (with hyphen)", () => {
    const input = 'api-key=myapikey';
    const result = redactSecrets(input);
    assert.equal(result, 'api-key=[REDACTED]');
  });

  test("does not redact already redacted values", () => {
    const input = 'password=[REDACTED]';
    const result = redactSecrets(input);
    assert.equal(result, 'password=[REDACTED]');
  });

  test("redacts multiple patterns in one string", () => {
    const input = `AKIAIOSFODNN7EXAMPLE password=secret sk-abcdefghijklmnop`;
    const result = redactSecrets(input);
    assert.equal(result, '[REDACTED] password=[REDACTED] [REDACTED]');
  });

  test("preserves non-secret text", () => {
    const input = 'const url = "https://example.com"; const name = "test";';
    const result = redactSecrets(input);
    assert.equal(result, input);
  });
});

// Import the fence constants for testing
const BEGIN_FENCE = `# >>> BEGIN MANAGED BY ASD-V2 (v${ASD_VERSION}) >>>`;
const END_FENCE = `# <<< END MANAGED BY ASD-V2 <<<`;