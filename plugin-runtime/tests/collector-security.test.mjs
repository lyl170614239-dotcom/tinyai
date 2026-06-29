import assert from "node:assert/strict";

import { isCollectorUploadAllowedForUrl } from "../dist/client.js";

assert.equal(isCollectorUploadAllowedForUrl("http://localhost:18080", ""), true);
assert.equal(isCollectorUploadAllowedForUrl("http://127.0.0.1:18080", ""), true);
assert.equal(isCollectorUploadAllowedForUrl("http://10.161.248.127:18080", ""), true);
assert.equal(isCollectorUploadAllowedForUrl("http://192.168.1.10:18080", ""), true);
assert.equal(isCollectorUploadAllowedForUrl("http://172.16.1.10:18080", ""), true);
assert.equal(isCollectorUploadAllowedForUrl("http://172.31.255.255:18080", ""), true);
assert.equal(isCollectorUploadAllowedForUrl("http://172.32.0.1:18080", ""), false);
assert.equal(isCollectorUploadAllowedForUrl("http://8.8.8.8:18080", ""), false);
assert.equal(isCollectorUploadAllowedForUrl("https://collector.example.com", "token"), true);
assert.equal(isCollectorUploadAllowedForUrl("https://collector.example.com", ""), false);
