import type { Channel } from "./index";

export const telegram: Channel = {
  name: "telegram",
  enabled: (env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
  async send(env, text) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_notification: false }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Telegram answered ${response.status}`);
  },
};
