import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addRpc,
  choicesRpc,
  disconnectRpc,
  listRpc,
  pairRpc,
  revokeRpc,
  saveRpc,
} from "./shared/contracts.ts";
import { Manager } from "./server/manager.ts";
import { dataRoot, paseoHome } from "./server/paths.ts";

export default function contribute(server: PluginServerContext) {
  const manager = new Manager(dataRoot, paseoHome);
  server.handle(listRpc, () => manager.list());
  server.handle(choicesRpc, () => manager.choices());
  server.handle(addRpc, (input) => manager.add(input));
  server.handle(saveRpc, (input) => manager.save(input));
  server.handle(pairRpc, ({ id }) => manager.pair(id));
  server.handle(disconnectRpc, ({ id }) => manager.disconnect(id));
  server.handle(revokeRpc, ({ id, chatId }) => manager.revoke(id, chatId));
  server.on("agent.created", ({ agent }, { paseo }) =>
    manager.onAgentCreated(agent.id, paseo),
  );
  server.on("agent.permission_resolved", ({ agent, requestId }) =>
    manager.onPermissionResolved(agent.id, requestId),
  );
  manager.start();
  return () => manager.stop();
}
