import type { PaseoApi } from "@getpaseo/client";
import { UserFacingError } from "./errors.ts";

type Agent = ReturnType<PaseoApi["agents"]["ref"]>;

/** A stored `closed` snapshot is not necessarily an unavailable chat. Reading
 * its timeline lets Paseo resume the saved session without sending a prompt. */
export async function refreshLinkedAgent(agent: Agent) {
  let snapshot = await agent.refresh();
  if (
    snapshot &&
    !snapshot.agent.archivedAt &&
    snapshot.agent.status === "closed"
  ) {
    const timeline = await agent.timeline.refetch({ direction: "tail", limit: 1 });
    if (timeline.error)
      throw new UserFacingError(
        "The linked Paseo chat could not be resumed. Check its provider and workspace in Paseo before retrying.",
      );
    snapshot = await agent.refresh();
  }
  return snapshot;
}
