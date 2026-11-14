import { loadToken } from "./aps.js";

// Construction-side domain APIs (RFIs / Forms / Issues) with a 3-legged token.
// Originally verified on 2026-11-14 with throwaway scripts; this file is the
// kept version of those checks (see VERIFICATION.md in the hands-on notes).
//
// Findings baked in:
// - Domain APIs require a user context: with a 2-legged token, RFIs v2
//   returns 403 ("missing userid in x-ads-token-data header") and Forms v1
//   returns 401. Always use the 3-legged token from `npm run login`.
// - The project id for domain APIs is the Data Management project id WITHOUT
//   the "b." prefix.
// - Creating an RFI requires status: "draft" in the body (a missing status
//   returns 400 naming the missing property).
// - Issues v2 returned 404 on every variant tried against the trial hub
//   (with/without "b.", v1, issue-definitions). Cause unresolved — the
//   Issues module may simply not be enabled on that hub. This script reports
//   the status instead of failing so the behaviour stays visible.
//
// Usage:
//   npm run domain                # read-only checks (RFIs / Forms / Issues)
//   npm run domain -- --create-rfi  # also POST one draft RFI, then re-list

const BASE = "https://developer.api.autodesk.com";
const token = loadToken();

async function softFetch(url: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  console.log(`${init.method ?? "GET"} ${url} -> ${res.status}`);
  let json: any = undefined;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  if (!res.ok) console.log("  body:", text.slice(0, 500));
  return { status: res.status, json };
}

// Discover hub -> project through Data Management (same chain as `npm run acc`).
const hubs = await softFetch(`${BASE}/project/v1/hubs`);
const hubId: string | undefined = hubs.json?.data?.[0]?.id;
if (!hubId) {
  console.log("No hubs visible. The app is probably not provisioned yet:");
  console.log("add its Client ID under ACC Settings -> Custom Integrations first.");
  process.exit(1);
}
const projects = await softFetch(`${BASE}/project/v1/hubs/${hubId}/projects`);
const dmProjectId: string = projects.json?.data?.[0]?.id;
const projectId = dmProjectId.replace(/^b\./, "");
console.log(`project: ${dmProjectId} (domain APIs use: ${projectId})`);

// RFIs v2 — list
const rfis = await softFetch(`${BASE}/construction/rfis/v2/projects/${projectId}/rfis`);
const rfiList: any[] = rfis.json?.results ?? rfis.json?.data ?? [];
console.log(`RFIs: ${Array.isArray(rfiList) ? rfiList.length : "?"} item(s)`);

// Forms v1 — form templates
const forms = await softFetch(`${BASE}/construction/forms/v1/projects/${projectId}/form-templates`);
const tplList: any[] = forms.json?.results ?? forms.json?.data ?? [];
console.log(`Form templates: ${Array.isArray(tplList) ? tplList.length : "?"} item(s)`);

// Issues v2 — expected to 404 on hubs where the module is not enabled.
const issues = await softFetch(`${BASE}/construction/issues/v2/projects/${projectId}/issues`);
console.log(`Issues: status ${issues.status} (404 here means "not enabled / not found" on this hub, see notes above)`);

// Optional write check: create one draft RFI, then list again.
if (process.argv.includes("--create-rfi")) {
  const created = await softFetch(`${BASE}/construction/rfis/v2/projects/${projectId}/rfis`, {
    method: "POST",
    body: JSON.stringify({ title: "hands-on write test", status: "draft" }),
  });
  console.log(`RFI create: ${created.status} id=${created.json?.id ?? "?"}`);
  const after = await softFetch(`${BASE}/construction/rfis/v2/projects/${projectId}/rfis`);
  const afterList: any[] = after.json?.results ?? after.json?.data ?? [];
  console.log(`RFIs after create: ${Array.isArray(afterList) ? afterList.length : "?"} item(s)`);
}
