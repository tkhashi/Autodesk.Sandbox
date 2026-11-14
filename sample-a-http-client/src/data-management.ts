import { writeFileSync } from "node:fs";
import { loadToken, apsFetch } from "./aps.js";

// Construction side read path via the Data Management API (GA):
//   GET hubs -> pick the Forma (ACC) hub -> GET projects -> GET top folders.
// This is the fastest way to prove "the API actually answers" on the
// Forma for Construction side (the Data Management trial hub + the
// Snowdon Towers sample project should appear here).

const BASE = "https://developer.api.autodesk.com";
const token = loadToken();
const out: Record<string, unknown> = {};

const hubs = (await apsFetch(token, `${BASE}/project/v1/hubs`)) as any;
out.hubs = hubs;
const hubList = hubs?.data ?? [];
console.log(`hubs: ${hubList.length}`);
for (const h of hubList) console.log(` - ${h.id}  ${h.attributes?.name ?? ""} (${h.attributes?.region ?? "?"})`);

if (hubList.length > 0) {
  const hubId = hubList[0].id;
  const projects = (await apsFetch(token, `${BASE}/project/v1/hubs/${hubId}/projects`)) as any;
  out.projects = projects;
  const projList = projects?.data ?? [];
  console.log(`projects in first hub: ${projList.length}`);
  for (const p of projList) console.log(` - ${p.id}  ${p.attributes?.name ?? ""}`);
  if (projList.length > 0) {
    const projectId = projList[0].id;
    const folders = await apsFetch(token, `${BASE}/project/v1/hubs/${hubId}/projects/${projectId}/topFolders`);
    out.topFolders = folders;
    console.log("top folders recorded");
  }
}

writeFileSync(new URL("../out-data-management.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("wrote out-data-management.json");
