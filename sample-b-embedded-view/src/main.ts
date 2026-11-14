import { Forma } from "forma-embedded-view-sdk/auto";

// Probe extension: ask the Forma host for the basics and show exactly what
// comes back (or the exact error). This is the smallest extension that proves
// the Embedded View channel works end to end.
function show(id: string, value: unknown, isError = false): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  el.className = isError ? "err" : "ok";
}

async function probe<T>(id: string, fn: () => Promise<T>): Promise<void> {
  try {
    show(id, await fn());
  } catch (err) {
    show(id, err instanceof Error ? `${err.name}: ${err.message}` : String(err), true);
  }
}

await probe("ping", () => Forma.ping());
show("projectId", Forma.getProjectId());
await probe("project", () => Forma.project.get());
await probe("rootUrn", () => Forma.udm.getRootUrn());
