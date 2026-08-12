import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentManager } from "./src/manager.js";
import { registerSubagentModule } from "./src/subagent.js";

export default function (pi: ExtensionAPI) {
  const manager = new SubagentManager(pi);
  manager.init();

  registerSubagentModule(pi, manager);
}
