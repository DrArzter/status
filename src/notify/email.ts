import type { Channel } from "./index";

// A Worker cannot speak SMTP, so email goes through a provider's HTTP API.
// Resend is the one wired here; swapping it is this file and nothing else.
export const email: Channel = {
  name: "email",
  enabled: (env) => Boolean(env.RESEND_API_KEY && env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM),
  async send(env, text) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM,
        to: [env.ALERT_EMAIL_TO],
        subject: text.split("\n")[0]?.slice(0, 120) ?? "Status change",
        text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Email provider answered ${response.status}`);
  },
};
