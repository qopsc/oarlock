import { expect, it } from "vitest";
import {
  bindEndpointKey,
  decodeEndpointKey,
  encodeEndpointKey,
  endpointKeyFor,
  endpointOrigin,
} from "./endpointCredentials";

it("binds keys to scheme, hostname and effective port, while permitting path changes", () => {
  const key = bindEndpointKey("https://EXAMPLE.com:443/v1", " secret ");
  expect(key).toEqual({ origin: "https://example.com", key: "secret" });
  for (const url of [
    "https://example.com/v2",
    "https://example.com:443/other",
  ]) {
    expect(endpointKeyFor(key, url)).toBe("secret");
  }
  for (const url of [
    "http://example.com/v1",
    "https://other.example/v1",
    "https://example.com:444/v1",
    "https://user:pass@example.com/v1",
    "not a url",
  ]) {
    expect(endpointKeyFor(key, url)).toBeNull();
  }
  expect(decodeEndpointKey(encodeEndpointKey(key))).toEqual(key);
});
it("retains legacy and malformed values without giving them an origin", () => {
  for (const value of [
    "old-secret",
    '{"key":"secret","origin":"https://example.com"}',
    '{"format":"oarlock-endpoint-key-v1","key":"secret","origin":"null"}',
  ]) {
    const record = decodeEndpointKey(value);
    expect(record).toEqual({ origin: null, key: value });
    expect(endpointKeyFor(record, "https://example.com")).toBeNull();
  }
  expect(decodeEndpointKey(null)).toBeNull();
  expect(decodeEndpointKey("")).toBeNull();
});
it("refuses opaque, local-file and credential-bearing URL bindings", () => {
  for (const url of [
    "file:///tmp/a",
    "data:text/plain,a",
    "ftp://example.com",
    "https://user@example.com",
    "example.com",
  ]) {
    expect(endpointOrigin(url)).toBeNull();
    expect(() => bindEndpointKey(url, "secret")).toThrow();
  }
});
