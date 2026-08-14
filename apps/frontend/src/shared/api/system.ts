import type { ApplicationBackupRestoreResult } from "../types/backups";
import type { PipelineCapabilities } from "../types/pipeline";
import type { SystemInfo } from "../types/system";
import { apiUrl, readJson } from "./core";

export function applicationBackupUrl(): string {
  return apiUrl("/api/backups/export");
}

export async function restoreApplicationBackup(
  file: File,
): Promise<ApplicationBackupRestoreResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(apiUrl("/api/backups/restore"), {
    method: "POST",
    body: form,
    credentials: "include",
  });
  return readJson<ApplicationBackupRestoreResult>(response);
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const response = await fetch(apiUrl("/api/health"), {
    credentials: "include",
  });
  return readJson<SystemInfo>(response);
}

export async function getPipelineCapabilities(): Promise<PipelineCapabilities> {
  const response = await fetch(apiUrl("/api/pipeline"), {
    credentials: "include",
  });
  return readJson<PipelineCapabilities>(response);
}
