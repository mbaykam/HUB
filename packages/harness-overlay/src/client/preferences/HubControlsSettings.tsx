import { useEffect, useRef } from "react";
import { installHubSettingsControls } from "../host/hub-settings-controls.ts";
import type { VoiceHistorySessions } from "../host/mobile-voice-history.ts";
import type { VoiceHistoryClient } from "../host/voice-history.ts";

export function HubControlsSettings({ sessions, history }: {
  sessions: VoiceHistorySessions;
  history: VoiceHistoryClient;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = container.current;
    if (node) return installHubSettingsControls(node, node.ownerDocument, sessions, history);
  }, [sessions, history]);
  return <div ref={container} />;
}
