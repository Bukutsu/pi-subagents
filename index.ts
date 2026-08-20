import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "./src/manager.js";
import { registerSubagentModule } from "./src/subagent.js";

declare global {
  var __PI_SUBAGENTS_CHILD_RESOURCE_LOAD__: number | undefined;
}

export default function (pi: ExtensionAPI) {
  if ((globalThis.__PI_SUBAGENTS_CHILD_RESOURCE_LOAD__ ?? 0) > 0) return;
  const manager = new SubagentManager(pi);
  manager.init();

  registerSubagentModule(pi, manager);
}
