import { readFileSync, writeFileSync } from "node:fs";

const databaseId = process.env.D1_DATABASE_ID;
const output = process.argv[2] ?? ".wrangler.production.jsonc";
const placeholder = "${D1_DATABASE_ID}";

if (!databaseId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error("D1_DATABASE_ID must be a Cloudflare D1 UUID");
}

const template = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const occurrences = template.split(placeholder).length - 1;

if (occurrences !== 1) {
  throw new Error(`Expected one ${placeholder} placeholder, found ${occurrences}`);
}

writeFileSync(output, template.replace(placeholder, databaseId));
