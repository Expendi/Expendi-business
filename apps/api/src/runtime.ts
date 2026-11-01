import type { Layer } from "effect";
import { ManagedRuntime } from "effect";

import type { AppDeps, AppLayerError } from "./layers/main.js";
import { MainLayer } from "./layers/main.js";

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppDeps, AppLayerError>;

export function makeRuntime(
  layer: Layer.Layer<AppDeps, AppLayerError> = MainLayer,
): AppRuntime {
  return ManagedRuntime.make(layer);
}
