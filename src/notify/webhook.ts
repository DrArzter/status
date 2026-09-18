import type { Channel } from "./index";

// The escape hatch: anything that accepts a JSON POST. Discord, Slack and a
// home-made receiver all fit without another module.
export const webhook: Channel = {
  name: "webhook",
  enabled: (env) => Boolean(env.ALERT_WEBHOOK_URL),
  async send(env, text) {
    const response = await fetch(env.ALERT_WEBHOOK_URL as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Webhook answered ${response.status}`);
  },
};
