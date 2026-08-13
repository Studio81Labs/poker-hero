import {
  CircleHelp,
  FlaskConical,
  Info,
  Settings,
  SlidersHorizontal,
  Target,
} from "lucide-react";

import "./AppToolbar.css";
import { ButtonControl } from "./FormControls";
import { SummaryMetric } from "./SummaryMetric";

export interface AppToolbarProps {
  automationEnabled: boolean;
  busy: boolean;
  historyTotal: number;
  liveStatusLabel: string;
  onConfigureAutomation: () => void;
  onConfigurePipeline: () => void;
  onOpenBenchmark: () => void;
  onOpenHelp: () => void;
  onOpenInfo: () => void;
  onOpenTraining: () => void;
  onToggleAutomation: () => void;
  queueCount: number;
  screenSharing: boolean;
}

export function AppToolbar({
  automationEnabled,
  busy,
  historyTotal,
  liveStatusLabel,
  onConfigureAutomation,
  onConfigurePipeline,
  onOpenBenchmark,
  onOpenHelp,
  onOpenInfo,
  onOpenTraining,
  onToggleAutomation,
  queueCount,
  screenSharing,
}: AppToolbarProps) {
  return (
    <section className="toolbar" aria-label="Analyzer controls">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          A
        </div>
        <div>
          <h1>Poker Training Analyzer</h1>
          <p>Post-hand review for Texas Hold&apos;em screenshots</p>
        </div>
      </div>
      <div className="toolbar-stats" aria-label="Session status">
        <SummaryMetric
          className="toolbar-stat"
          label="in queue"
          value={queueCount}
        />
        <i aria-hidden="true" />
        <SummaryMetric
          className="toolbar-stat"
          label="reviewed"
          value={historyTotal}
        />
        <div
          className={screenSharing ? "source-status active" : "source-status"}
        >
          <span aria-hidden="true" />
          <strong>{liveStatusLabel}</strong>
        </div>
        <i aria-hidden="true" />
        <div className="automation-header-control">
          <ButtonControl
            variant="secondary"
            className={
              automationEnabled
                ? "automation-master active"
                : "automation-master"
            }
            onClick={onToggleAutomation}
            aria-pressed={automationEnabled}
            aria-label={`Automation ${automationEnabled ? "On" : "Off"}`}
          >
            <span className="switch-mini" aria-hidden="true">
              <span />
            </span>
            <span className="automation-master-text">
              <strong>Automation</strong>
              <span>{automationEnabled ? "On" : "Off"}</span>
            </span>
          </ButtonControl>
          <ButtonControl
            variant="secondary"
            className="automation-config-button"
            onClick={onConfigureAutomation}
            aria-label="Configure automation"
          >
            <Settings size={17} aria-hidden="true" />
          </ButtonControl>
        </div>
        <ButtonControl
          variant="secondary"
          iconOnly
          className="header-icon-button"
          onClick={onConfigurePipeline}
          disabled={busy}
          title="Analysis plugins"
          aria-label="Configure analysis plugins"
        >
          <SlidersHorizontal size={18} aria-hidden="true" />
        </ButtonControl>
        <ButtonControl
          variant="secondary"
          iconOnly
          className="header-icon-button"
          onClick={onOpenHelp}
          title="How to use"
          aria-label="How to use Poker Training Analyzer"
        >
          <CircleHelp size={18} aria-hidden="true" />
        </ButtonControl>
        <ButtonControl
          variant="secondary"
          iconOnly
          className="header-icon-button"
          onClick={onOpenInfo}
          title="About this app"
          aria-label="About this app"
        >
          <Info size={18} aria-hidden="true" />
        </ButtonControl>
        <ButtonControl
          variant="secondary"
          iconOnly
          className="header-icon-button"
          onClick={onOpenTraining}
          disabled={busy}
          title="Training progress"
          aria-label="Training progress"
        >
          <Target size={18} aria-hidden="true" />
        </ButtonControl>
        <ButtonControl
          variant="secondary"
          iconOnly
          className="header-icon-button"
          onClick={onOpenBenchmark}
          disabled={busy}
          title="Parser benchmark"
          aria-label="Parser benchmark"
        >
          <FlaskConical size={18} aria-hidden="true" />
        </ButtonControl>
      </div>
    </section>
  );
}
