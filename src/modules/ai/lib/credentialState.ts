/** Unavailable is never interchangeable with a confirmed missing credential. */
export type CredentialUnavailable = {
  status: "loading" | "failed";
  error?: string;
};
export type CredentialValue<T> = T | null | CredentialUnavailable;
export const CREDENTIAL_LOADING: CredentialUnavailable = { status: "loading" };
export function credentialUnavailable(
  value: unknown,
): value is CredentialUnavailable {
  return typeof value === "object" && value !== null && "status" in value;
}
export function credentialProblem(value: unknown): string | null {
  if (
    value === undefined ||
    (credentialUnavailable(value) && value.status === "loading")
  )
    return "Credentials are still loading. Try again when the lookup finishes.";
  if (credentialUnavailable(value))
    return `Could not read credentials. Retry, replace or remove the key in Settings → Models. ${value.error ?? ""}`.trim();
  return null;
}
export function readyKey(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function credentialValue<T>(
  value: CredentialValue<T> | undefined,
): T | null {
  return credentialUnavailable(value) ? null : (value ?? null);
}
