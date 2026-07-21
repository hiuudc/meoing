import { Flame, MoreHorizontal, Sparkles } from "lucide-react";
import type { StudyItem, Unit } from "../types";
import { cleanUnitName } from "../unit";

interface OverviewPanelProps {
  unit?: Unit;
  recentWords: StudyItem[];
}

export function OverviewPanel({ unit, recentWords }: OverviewPanelProps) {
  return (
    <aside className="overview-panel" aria-label="Unit overview">
      <div className="overview-title-row">
        <h2>Unit overview</h2>
        <button type="button" aria-label="More overview options">
          <MoreHorizontal size={17} />
        </button>
      </div>
      <p className="overview-unit-name">{unit ? cleanUnitName(unit.name) : "Choose a unit"}</p>

      <div className="progress-block">
        <div className="progress-ring" aria-label="64 percent complete">
          <span>64%</span>
        </div>
        <div>
          <strong>Steady progress</strong>
          <p>Keep your daily rhythm going.</p>
        </div>
      </div>

      <div className="goal-row">
        <span className="goal-icon"><Flame size={16} /></span>
        <div>
          <strong>12 items today</strong>
          <p>4 more to reach your goal</p>
        </div>
      </div>

      <div className="overview-section-heading">
        <h3>Recent words</h3>
        <Sparkles size={15} />
      </div>
      <div className="recent-word-list">
        {recentWords.length ? (
          recentWords.slice(0, 4).map((word) => (
            <div className="recent-word-row" key={word.id}>
              <span>{word.text}</span>
              <small>{word.translation}</small>
            </div>
          ))
        ) : (
          <p className="empty-copy">Add words to see them here.</p>
        )}
      </div>

      <button className="review-button" type="button">
        Start quick review
      </button>
    </aside>
  );
}
