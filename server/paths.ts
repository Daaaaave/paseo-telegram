import { homedir } from "node:os";
import { join } from "node:path";

export const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
export const dataRoot = join(paseoHome, "plugin-data", "telegram");
export const connectionRoot = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid connection ID");
  return join(dataRoot, "connections", id);
};
