// The real Foundry adapter (plan U8) is built on the generated OSDK package
// from the Developer Console app, which does not exist until gates G1 and G3
// clear. Until then this module refuses to construct, so a deploy that selects
// FOUNDRY_ADAPTER=osdk fails at boot rather than pretending to reach Foundry.
//
// Intended wiring once the generated SDK package is installed (plan KTD3, U8):
//
//   import { createClient } from "@osdk/client";
//   const client = createClient(config.foundry.stackUrl, config.foundry.ontologyRid, tokenProvider(auth));
//
// `createClient` accepts a `() => Promise<string>` token provider and calls it
// per request, so the delegated user's access token is refreshed by
// FoundryDelegatedAuth and never copied into the client.

import type { Config } from "../config.js";
import type { FoundryAuth } from "../lib/foundry-auth-types.js";
import type { FoundryAdapter } from "./adapter.js";

export type TokenProvider = () => Promise<string>;

/** Adapts the delegated-user auth holder to the token-provider shape `@osdk/client` expects. */
export function tokenProvider(auth: FoundryAuth): TokenProvider {
  return () => auth.getToken();
}

export function createOsdkAdapter(_config: Config, _getToken: TokenProvider): FoundryAdapter {
  throw new Error("OSDK adapter is not available until the generated SDK is installed (plan U8, gates G1 and G3)");
}
