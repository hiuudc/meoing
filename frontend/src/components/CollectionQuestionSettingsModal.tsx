import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiErrorMessage } from "../api/client";
import { LESSON_QUESTION_FORMAT_DEFINITIONS, QUESTION_FORMAT_REGISTRY } from "../learning/questionRegistry";
import {
  getEffectiveCollectionQuestionSettings,
  supportsQuestionFormatForLanguage,
  validateCollectionQuestionSettings,
} from "../learning/questionSettings";
import { QuestionRenderer } from "../learning/QuestionRenderer";
import type {
  CollectionQuestionSettings,
  LearningProfile,
  LessonQuestion,
  QuestionAnswer,
  QuestionFormat,
} from "../learning/types";
import type { Collection } from "../types";

interface CollectionQuestionSettingsPanelProps {
  collection: Collection;
  profile: LearningProfile;
  onSave: (settings: CollectionQuestionSettings) => void | Promise<void>;
}

function initialAnswer(question: LessonQuestion): QuestionAnswer {
  if (["multipleChoice", "wordBank", "reorderTokens", "reorderDialogue"].includes(question.type)) return [];
  if (["multiCloze", "matching", "audioMatching", "categorize"].includes(question.type)) return {};
  return "";
}

function QuestionPreview({
  disabled,
  format,
  language,
  previewId,
}: {
  disabled: boolean;
  format: QuestionFormat;
  language: string;
  previewId: string;
}) {
  const sample = { ...QUESTION_FORMAT_REGISTRY[format].sample, id: previewId } as LessonQuestion;
  const [answer, setAnswer] = useState<QuestionAnswer>(() => initialAnswer(sample));

  return (
    <fieldset
      className="collection-question-preview"
      aria-label={`${QUESTION_FORMAT_REGISTRY[format].label} preview`}
      disabled={disabled}
    >
      <p className="collection-question-preview-prompt">{sample.prompt}</p>
      <QuestionRenderer question={sample} answer={answer} language={language} onChange={setAnswer} />
    </fieldset>
  );
}

type QuestionFormatDefinition = (typeof LESSON_QUESTION_FORMAT_DEFINITIONS)[number];

interface QuestionFormatState {
  definition: QuestionFormatDefinition;
  enabled: boolean;
  languageUnavailable: boolean;
  speakingUnavailable: boolean;
}

function QuestionFormatCard({
  formatState,
  language,
  onToggle,
}: {
  formatState: QuestionFormatState;
  language: string;
  onToggle: (format: QuestionFormat, enabled: boolean) => void;
}) {
  const { definition, enabled, languageUnavailable, speakingUnavailable } = formatState;
  return (
    <article
      className={`question-format-card ${enabled ? "is-enabled" : "is-disabled"}`}
      data-question-format={definition.id}
    >
      <div className="question-format-heading">
        <label className="format-enable-control">
          <input
            type="checkbox"
            checked={enabled}
            disabled={speakingUnavailable || languageUnavailable}
            onChange={(event) => onToggle(definition.id, event.target.checked)}
          />
          <span>{definition.label}</span>
        </label>
        <span className={`question-format-badge is-${definition.badge}`}>
          {definition.badge === "ai" ? "AI" : definition.badge}
        </span>
      </div>
      <p>{definition.description}</p>
      {speakingUnavailable ? <small>Collection speaking is disabled.</small> : null}
      {languageUnavailable ? <small>Available only when learning Chinese, Japanese, or Korean.</small> : null}
      <div className="question-preview-column">
        <QuestionPreview
          key={`${definition.id}:${enabled}`}
          disabled={!enabled}
          format={definition.id}
          language={language}
          previewId={`format-preview-${definition.id}`}
        />
      </div>
    </article>
  );
}

export function CollectionQuestionSettingsPanel({
  collection,
  profile,
  onSave,
}: CollectionQuestionSettingsPanelProps) {
  const [questionSettings, setQuestionSettings] = useState<CollectionQuestionSettings>(
    () => getEffectiveCollectionQuestionSettings(collection.questionSettings, profile),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pendingFormatFocusRef = useRef<QuestionFormat | null>(null);

  useEffect(() => {
    setQuestionSettings(getEffectiveCollectionQuestionSettings(collection.questionSettings, profile));
    setError("");
    setNotice("");
  }, [collection.id, collection.questionSettings, profile]);

  useEffect(() => {
    const format = pendingFormatFocusRef.current;
    if (!format) return;
    pendingFormatFocusRef.current = null;
    document.querySelector<HTMLInputElement>(
      `[data-question-format="${format}"] input[type="checkbox"]`,
    )?.focus();
  }, [questionSettings.enabledFormats]);

  const errors = validateCollectionQuestionSettings(questionSettings, profile);
  const formatStates: QuestionFormatState[] = LESSON_QUESTION_FORMAT_DEFINITIONS.map((definition) => {
    const speakingUnavailable = !profile.speakingEnabled && definition.badge === "speaking";
    const languageUnavailable = !supportsQuestionFormatForLanguage(definition.id, profile.targetLanguage);
    return {
      definition,
      enabled: questionSettings.enabledFormats.includes(definition.id)
        && !speakingUnavailable
        && !languageUnavailable,
      languageUnavailable,
      speakingUnavailable,
    };
  });
  const enabledFormats = formatStates.filter((formatState) => formatState.enabled);
  const disabledFormats = formatStates.filter((formatState) => !formatState.enabled);

  function updateFormatEnabled(format: QuestionFormat, enabled: boolean) {
    pendingFormatFocusRef.current = format;
    setNotice("");
    setQuestionSettings((current) => ({
      ...current,
      enabledFormats: enabled
        ? [...current.enabledFormats, format]
        : current.enabledFormats.filter((candidate) => candidate !== format),
    }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (errors.length || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await onSave(questionSettings);
      setNotice("Question settings saved.");
    } catch (saveError) {
      setError(apiErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="collection-question-settings collection-question-settings-panel" onSubmit={(event) => void submit(event)}>
      <div className="collection-admin-section-heading">
        <div>
          <h3>Question formats</h3>
          <p>Configure which formats future lessons in {collection.name} may use.</p>
        </div>
      </div>

      <div className="question-settings-summary">
        <div><span>Lesson size</span><strong>{profile.lessonQuestionCount} questions</strong></div>
        <div><span>Enabled formats</span><strong>{enabledFormats.length}/{LESSON_QUESTION_FORMAT_DEFINITIONS.length}</strong></div>
      </div>

      <p className="question-settings-guidance">Enable at least five formats, including one local and one AI-graded format.</p>
      <div className="question-format-groups">
        {([
          { id: "enabled-question-formats", label: "Enabled formats", formats: enabledFormats, empty: "No formats are enabled." },
          { id: "disabled-question-formats", label: "Disabled formats", formats: disabledFormats, empty: "All available formats are enabled." },
        ] as const).map((group) => (
          <section className="question-format-group" aria-labelledby={`${group.id}-title`} key={group.id}>
            <div className="question-format-group-heading">
              <h4 id={`${group.id}-title`}>{group.label}</h4>
              <span>{group.formats.length}</span>
            </div>
            {group.formats.length ? (
              <div className="question-format-grid">
                {group.formats.map((formatState) => (
                  <QuestionFormatCard
                    key={formatState.definition.id}
                    formatState={formatState}
                    language={profile.targetLanguage}
                    onToggle={updateFormatEnabled}
                  />
                ))}
              </div>
            ) : <p className="question-format-empty">{group.empty}</p>}
          </section>
        ))}
      </div>

      {errors.length ? (
        <div className="question-settings-validation" role="alert">
          <strong>Resolve these settings before saving:</strong>
          <ul>{errors.map((validationError) => <li key={validationError}>{validationError}</li>)}</ul>
        </div>
      ) : <p className="question-settings-valid">These settings fit the collection lesson size.</p>}
      {error ? <div className="collection-admin-message is-error" role="alert">{error}</div> : null}
      {notice ? <div className="collection-admin-message is-success" role="status">{notice}</div> : null}

      <div className="collection-admin-actions question-settings-panel-actions">
        <button className="primary-button" type="submit" disabled={saving || errors.length > 0}>
          {saving ? <LoaderCircle className="spin" size={16} /> : null}
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
