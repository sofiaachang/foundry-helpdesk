// The real Foundry adapter (plan U8) is built on the generated OSDK package
// from the Developer Console app, which does not exist until gates G1 and G3
// clear. Until then this module refuses to construct, so a deploy that selects
// FOUNDRY_ADAPTER=osdk fails at boot rather than pretending to reach Foundry.

import type { Config } from "../config.js";
import type { FoundryAdapter } from "./adapter.js";

export function createOsdkAdapter(_config: Config): FoundryAdapter {
  throw new Error("OSDK adapter is not available until the generated SDK is installed (plan U8, gates G1 and G3)");
}
