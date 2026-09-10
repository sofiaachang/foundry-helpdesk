// Fixture composition root: the one file outside foundry/ allowed to import it.
import type { FoundryAdapter } from "./foundry/adapter.js";

export function compose(adapter: FoundryAdapter): FoundryAdapter {
  return adapter;
}
