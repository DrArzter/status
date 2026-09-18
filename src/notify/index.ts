import type { Announcement } from "../store";
import type { Env, Project } from "../types";
import { telegram } from "./telegram";
import { email } from "./email";
import { webhook } from "./webhook";

export type Channel = {
  name: string;
  /** A channel exists when its configuration does, so adding one is a secret. */
  enabled: (env: Env) => boolean;
  send: (env: Env, text: string) => Promise<void>;
};

const channels: Channel[] = [telegram, email, webhook];

function line(change: Announcement, projects: readonly Project[]): string {
  const project = projects.find((item) => item.id === change.projectId);
  const name = project?.name ?? change.projectId;
  if (change.to === "down") return `${name} is down${change.detail ? `: ${change.detail}` : ""}`;
  return `${name} is back up`;
}

/**
 * Announces changes, never states. A channel that fails is reported and
 * skipped: losing an alert must not cost the tick that found it.
 */
export async function announce(env: Env, changes: readonly Announcement[], projects: readonly Project[]): Promise<void> {
  if (changes.length === 0) return;
  const active = channels.filter((channel) => channel.enabled(env));
  if (active.length === 0) return;

  const text = changes.map((change) => line(change, projects)).join("\n");
  const results = await Promise.allSettled(active.map((channel) => channel.send(env, text)));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.error(`alert channel ${active[index]?.name} failed`, result.reason);
  });
}
