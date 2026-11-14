import { writeFileSync } from "node:fs";
import { loadToken, apsFetch } from "./aps.js";

// Forma Site Design HTTP API (Beta, /v1alpha) read path:
//   list proposals -> get one proposal revision -> walk its element tree.
// There is no simple "list buildings" endpoint: elements must be fetched by
// walking children recursively from the proposal root. This script records the
// raw responses so the hands-on notes can quote exactly what came back.
//
// NOTE: external HTTP access additionally requires this APS app's Client ID to
// be registered as a Service Account in a Forma Site Design extension that is
// installed on the target site. If calls return 403/404, that registration is
// the first thing to check (documented in the hands-on plan).

const BASE = "https://developer.api.autodesk.com/forma/v1alpha";
const token = loadToken();
const out: Record<string, unknown> = {};

const proposals = (await apsFetch(token, `${BASE}/proposals`)) as { data?: unknown[] };
out.proposals = proposals;
const list = (proposals as any)?.data ?? (proposals as any)?.proposals ?? [];
console.log(`proposals: ${Array.isArray(list) ? list.length : "unknown shape"}`);

if (Array.isArray(list) && list.length > 0) {
  const first = list[0];
  const proposalId = first.id ?? first.proposalId;
  console.log("first proposal:", proposalId, first.name ?? "");
  if (proposalId) {
    const detail = await apsFetch(token, `${BASE}/proposals/${proposalId}`);
    out.proposalDetail = detail;
  }
}

writeFileSync(new URL("../out-site-design.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("wrote out-site-design.json");
