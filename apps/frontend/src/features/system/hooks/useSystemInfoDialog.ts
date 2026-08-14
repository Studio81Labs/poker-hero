import { useState } from "react";
import { getSystemInfo } from "../../../shared/api/client";
import type { SystemInfo } from "../../../shared/types";

export function useSystemInfoDialog() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mcpTokenPending, setMcpTokenPending] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(false);

  function openDialog() {
    setDialogOpen(true);
    if (systemInfo || loading) {
      return;
    }

    setLoading(true);
    void getSystemInfo()
      .then(setSystemInfo)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }

  function closeDialog(blocked = false) {
    if (blocked || mcpTokenPending) {
      return;
    }
    setDialogOpen(false);
  }

  return {
    closeDialog,
    dialogOpen,
    loading,
    mcpTokenPending,
    openDialog,
    setMcpTokenPending,
    systemInfo,
  };
}
