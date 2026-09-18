import type { Env } from "./types";

/**
 * Who Cloudflare Access says is at the door.
 *
 * Access sits in front of `/admin` and lets nobody else through, so this is a
 * second lock on a door already locked. It is worth having: a Worker answers on
 * more than one hostname over its life — a `workers.dev` name, a preview, a
 * route added later — and Access is configured per hostname and path. The
 * signature is what makes the answer true wherever the request arrived.
 *
 * The token rides in a header on every request Access forwards, signed by a key
 * pair belonging to the account. The keys rotate every six weeks, so they are
 * fetched rather than pinned, and held for an hour: the endpoint is Cloudflare's
 * own and a fetch per request would put it in the path of every save.
 */
export type Identity = { email: string };

type Jwk = { kid: string; kty: string; alg: string; n: string; e: string };

let keys: { at: number; byKid: Map<string, CryptoKey> } | undefined;
const KEYS_GOOD_FOR = 3_600_000;

const decode = (part: string): Uint8Array => {
  const padded = part.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
};

const readJson = (part: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(decode(part))) as Record<string, unknown>;

async function signingKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  if (keys !== undefined && Date.now() - keys.at < KEYS_GOOD_FOR) return keys.byKid;
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`access certs: HTTP ${response.status}`);
  const body = await response.json() as { keys: Jwk[] };
  const byKid = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    byKid.set(jwk.kid, await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    ));
  }
  keys = { at: Date.now(), byKid };
  return byKid;
}

/**
 * The identity behind a request, or null if there is not a valid one. Null is
 * the only failure: a caller cannot tell a forged token from an expired one,
 * and neither gets in.
 */
export async function identify(request: Request, env: Env): Promise<Identity | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (!teamDomain || !audience) return null;

  const token = request.headers.get("cf-access-jwt-assertion");
  if (token === null) return null;
  const [header, payload, signature, ...rest] = token.split(".");
  if (header === undefined || payload === undefined || signature === undefined || rest.length > 0) return null;

  try {
    const { kid } = readJson(header) as { kid?: string };
    if (typeof kid !== "string") return null;
    const key = (await signingKeys(teamDomain)).get(kid);
    if (key === undefined) return null;

    const signed = new TextEncoder().encode(`${header}.${payload}`);
    const verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(signature), signed);
    if (!verified) return null;

    const claims = readJson(payload);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    if (typeof claims.email !== "string" || claims.email.length === 0) return null;
    return { email: claims.email };
  } catch {
    // A token that cannot be read is a token that does not let anybody in.
    return null;
  }
}
