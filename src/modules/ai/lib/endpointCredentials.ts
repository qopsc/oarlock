/** Persisted beside the key in the keychain, never in preferences. */
export type EndpointCredential = { origin: string | null; key: string };
const FORMAT = "oarlock-endpoint-key-v1";

export function endpointOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export function bindEndpointKey(
  url: string,
  value: string,
): EndpointCredential {
  const origin = endpointOrigin(url);
  if (!origin)
    throw new Error("Enter an HTTP or HTTPS base URL before saving a key.");
  const key = value.trim();
  if (!key) throw new Error("API key is empty");
  return { origin, key };
}

export function encodeEndpointKey(credential: EndpointCredential): string {
  return JSON.stringify({ format: FORMAT, ...credential });
}

export function decodeEndpointKey(
  value: string | null | undefined,
): EndpointCredential | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value);
    if (
      record?.format === FORMAT &&
      typeof record.key === "string" &&
      record.key &&
      typeof record.origin === "string" &&
      endpointOrigin(record.origin) === record.origin
    ) {
      return { origin: record.origin, key: record.key };
    }
  } catch {
    /* Older keys have no trustworthy origin. Keep them until re-entered. */
  }
  return { origin: null, key: value };
}

export function endpointKeyFor(
  credential: EndpointCredential | null | undefined,
  url: string,
): string | null {
  const origin = endpointOrigin(url);
  return origin && credential?.origin === origin ? credential.key : null;
}
