import { describe, expect, test } from "bun:test";
import { DEFAULT_T3_URL } from "@you-brain/core/deck/t3/index.js";

import { isPrefKey } from "../../src/lib/prefs.js";
import {
  addEndpoint,
  isDuplicateEndpointUrl,
  LOCAL_T3_ID,
  MAX_T3_ENDPOINT_NAME,
  MAX_T3_ENDPOINTS,
  parseEndpoints,
  removeEndpoint,
  resolveActive,
  serializeEndpoints,
  T3_ACTIVE_KEY,
  T3_ENDPOINTS_KEY,
  T3_URL_KEY,
} from "../../src/lib/t3-endpoints.js";

describe("t3-endpoints prefs keys", () => {
  test("两个新偏好键与本机地址键都在 PREF_KEYS 白名单里", () => {
    expect(isPrefKey(T3_URL_KEY)).toBe(true);
    expect(isPrefKey(T3_ENDPOINTS_KEY)).toBe(true);
    expect(isPrefKey(T3_ACTIVE_KEY)).toBe(true);
  });
});

describe("parseEndpoints / serializeEndpoints", () => {
  test("空值、坏 JSON、非数组返回空数组", () => {
    expect(parseEndpoints(null)).toEqual([]);
    expect(parseEndpoints(undefined)).toEqual([]);
    expect(parseEndpoints("")).toEqual([]);
    expect(parseEndpoints("{not-json")).toEqual([]);
    expect(parseEndpoints(JSON.stringify({ id: "ep-1" }))).toEqual([]);
  });

  test("单条坏数据、非回环地址、重复项与超限项逐项丢弃，保留其余合法项", () => {
    const raw = JSON.stringify([
      { id: "ep-1", name: "  VPS  ", url: "http://127.0.0.1:3774" },
      { id: "local", name: "冒充本机", url: "http://127.0.0.1:3775" },
      { id: "ep-1", name: "重复 id", url: "http://127.0.0.1:3776" },
      { id: "ep-dup-url", name: "重复地址", url: "http://127.0.0.1:3774/" },
      { id: "ep-local-url", name: "与本机同址", url: "http://127.0.0.1:3773/" },
      { id: "ep-remote", name: "公网拒绝", url: "https://example.com/" },
      { id: "ep-path", name: "带路径拒绝", url: "http://127.0.0.1:3777/thread/1" },
      { id: "ep-empty-name", name: "   ", url: "http://127.0.0.1:3778" },
      { id: "ep-long", name: "这是一个非常非常非常非常非常非常非常非常长的名字", url: "http://localhost:3779" },
      "not-an-object",
    ]);

    const parsed = parseEndpoints(raw, DEFAULT_T3_URL);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ id: "ep-1", name: "VPS", url: "http://127.0.0.1:3774/" });
    expect(parsed[1]?.id).toBe("ep-long");
    expect(parsed[1]?.name.length).toBe(MAX_T3_ENDPOINT_NAME);
    expect(parsed[1]?.url).toBe("http://localhost:3779/");

    expect(parseEndpoints(serializeEndpoints(parsed), DEFAULT_T3_URL)).toEqual(parsed);
  });

  test("超过 8 个端点时只保留前 8 个有效项", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: `ep-${index}`,
      name: `节点 ${index}`,
      url: `http://127.0.0.1:${3800 + index}/`,
    }));
    const parsed = parseEndpoints(JSON.stringify(items));
    expect(parsed).toHaveLength(MAX_T3_ENDPOINTS);
    expect(parsed[0]?.id).toBe("ep-0");
    expect(parsed[7]?.id).toBe("ep-7");
  });
});

describe("addEndpoint / removeEndpoint / resolveActive", () => {
  test("正常添加回环端点、生成稳定短 id、空名称回落 host", () => {
    const first = addEndpoint([], { name: "VPS", url: " http://127.0.0.1:3774 " }, DEFAULT_T3_URL);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.endpoint).toEqual({ id: "ep-3774", name: "VPS", url: "http://127.0.0.1:3774/" });

    const second = addEndpoint(first.endpoints, { name: "  ", url: "http://localhost:3774" }, DEFAULT_T3_URL);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.endpoint.id).toBe("ep-3774-2");
    expect(second.endpoint.name).toBe("localhost:3774");
    expect(second.endpoint.url).toBe("http://localhost:3774/");
  });

  test("校验非法地址、与本机重复、与已有端点重复以及超出 8 个上限", () => {
    expect(addEndpoint([], { name: "坏地址", url: "https://remote.example.com/" }, DEFAULT_T3_URL)).toEqual({
      ok: false,
      error: "invalid-url",
    });
    expect(addEndpoint([], { name: "同本机", url: "http://127.0.0.1:3773" }, DEFAULT_T3_URL)).toEqual({
      ok: false,
      error: "duplicate-url",
    });

    const added = addEndpoint([], { name: "VPS", url: "http://127.0.0.1:3774/" }, DEFAULT_T3_URL);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(addEndpoint(added.endpoints, { name: "重复", url: "http://127.0.0.1:3774" }, DEFAULT_T3_URL)).toEqual({
      ok: false,
      error: "duplicate-url",
    });
    expect(isDuplicateEndpointUrl("http://127.0.0.1:3774", added.endpoints)).toBe(true);
    expect(isDuplicateEndpointUrl("http://127.0.0.1:3775", added.endpoints)).toBe(false);

    let list = added.endpoints;
    for (let port = 3775; port < 3775 + MAX_T3_ENDPOINTS - 1; port += 1) {
      const next = addEndpoint(list, { name: `E${port}`, url: `http://127.0.0.1:${port}/` }, DEFAULT_T3_URL);
      expect(next.ok).toBe(true);
      if (next.ok) list = next.endpoints;
    }
    expect(list).toHaveLength(MAX_T3_ENDPOINTS);
    expect(addEndpoint(list, { name: "第9个", url: "http://127.0.0.1:3999/" }, DEFAULT_T3_URL)).toEqual({
      ok: false,
      error: "limit",
    });
  });

  test("removeEndpoint 移除指定项；resolveActive 无效值回落 local", () => {
    const list = [
      { id: "ep-3774", name: "VPS", url: "http://127.0.0.1:3774/" },
      { id: "ep-3775", name: "Mac B", url: "http://127.0.0.1:3775/" },
    ];
    expect(resolveActive("ep-3774", list)).toBe("ep-3774");
    expect(resolveActive("local", list)).toBe(LOCAL_T3_ID);
    expect(resolveActive("missing", list)).toBe(LOCAL_T3_ID);
    expect(resolveActive(null, list)).toBe(LOCAL_T3_ID);

    const remaining = removeEndpoint(list, "ep-3774");
    expect(remaining).toEqual([{ id: "ep-3775", name: "Mac B", url: "http://127.0.0.1:3775/" }]);
    expect(resolveActive("ep-3774", remaining)).toBe(LOCAL_T3_ID);
  });
});
