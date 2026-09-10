// Fixture routes with a planted violation: a direct import of the adapter.
import { OsdkAdapter } from "../foundry/adapter.js";

export function register(): OsdkAdapter {
  return new OsdkAdapter();
}
