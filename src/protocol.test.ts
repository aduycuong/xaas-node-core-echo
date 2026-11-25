import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheKey } from "./protocol";

test("cacheKey: the same parts give the same text, whatever the order of object keys", () => {
  assert.equal(cacheKey({ b: 1, a: [{ y: 2, x: 1 }] }, "https://acme.vn/a.png?1"), cacheKey({ a: [{ x: 1, y: 2 }], b: 1 }, "https://acme.vn/a.png?1"));
  assert.equal(cacheKey({ a: 1, skip: undefined }), cacheKey({ a: 1 }));
});

test("cacheKey: any change of a part changes the key, the order of parts too", () => {
  assert.notEqual(cacheKey("https://acme.vn/a.png?1"), cacheKey("https://acme.vn/a.png?2"));
  assert.notEqual(cacheKey({ etag: "e1" }), cacheKey({ etag: "e2" }));
  assert.notEqual(cacheKey("a", "b"), cacheKey("b", "a"));
});
