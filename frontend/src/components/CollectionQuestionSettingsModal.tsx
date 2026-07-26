import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { AnimatedModal } from "./AnimatedModal";

interface CollectionQuestionSettingsModalProps {
  collection: Collection | null;
  profile: LearningProfile;
  onClose: () => void;
  onSave: (settings: CollectionQuestionSettings) => void;
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

function PreviewColumn({
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
  return (
    <div className="question-preview-column">
      <QuestionPreview
        key={`${previewId}:${format}`}
        disabled={disabled}
        format={format}
        language={language}
        previewId={previewId}
      />
    </div>
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
  const {
    definition,
    enabled,
    languageUnavailable,
    speakingUnavailable,
  } = formatState;

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
      <PreviewColumn
        disabled={!enabled}
        format={definition.id}
        language={language}
        previewId={`format-preview-${definition.id}`}
      />
    </article>
  );
}

export function CollectionQuestionSettingsModal({
  collection,
  profile,
  onClose,
  onSave,
}: CollectionQuestionSettingsModalProps) {
  const [retainedCollection, setRetainedCollection] = useState(collection);
  const [questionSettings, setQuestionSettings] = useState<CollectionQuestionSettings>(
    () => getEffectiveCollectionQuestionSettings(collection?.questionSettings, profile),
  );
  const pendingFormatFocusRef = useRef<QuestionFormat | null>(null);
  const activeCollection = collection ?? retainedCollection;

  useEffect(() => {
    if (!collection) return;
    setRetainedCollection(collection);
    setQuestionSettings(getEffectiveCollectionQuestionSettings(collection.questionSettings, profile));
  }, [collection, profile]);

  useEffect(() => {
    const format = pendingFormatFocusRef.current;
    if (!format) return;
    pendingFormatFocusRef.current = null;
    document.querySelector<HTMLInputElement>(
      `[data-question-format="${format}"] input[type="checkbox"]`,
    )?.focus();
  }, [questionSettings.enabledFormats]);

  if (!activeCollection) return null;

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
    setQuestionSettings((current) => ({
      ...current,
      enabledFormats: enabled
        ? [...current.enabledFormats, format]
        : current.enabledFormats.filter((candidate) => candidate !== format),
    }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (errors.length) return;
    onSave(questionSettings);
  }

  return (
    <AnimatedModal
      open={Boolean(collection)}
      onClose={onClose}
      labelledBy="collection-question-settings-title"
      backdropClassName="modal-backdrop question-settings-backdrop"
      panelClassName="question-settings-modal"
    >
      <form onSubmit={submit}>
        <header className="question-settings-header">
          <div>
            <p>Collection question settings</p>
            <h2 id="collection-question-settings-title">{activeCollection.name}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close question settings" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="question-settings-content">
          <section className="collection-question-settings" aria-label="Question configuration">
            <div className="question-settings-summary">
              <div><span>Lesson size</span><strong>{profile.lessonQuestionCount} questions</strong></div>
              <div><span>Enabled formats</span><strong>{enabledFormats.length}/{LESSON_QUESTION_FORMAT_DEFINITIONS.length}</strong></div>
            </div>

            <div className="settings-section-heading">
              <div>
                <h3>Question formats</h3>
                <p>Enable at least five formats, including one local and one AI-graded format.</p>
              </div>
            </div>
            <div className="question-format-groups">
              {([
                {
                  id: "enabled-question-formats",
                  label: "Enabled formats",
                  formats: enabledFormats,
                  emptyMessage: "No formats are enabled.",
                },
                {
                  id: "disabled-question-formats",
                  label: "Disabled formats",
                  formats: disabledFormats,
                  emptyMessage: "All available formats are enabled.",
                },
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
                  ) : (
                    <p className="question-format-empty">{group.emptyMessage}</p>
                  )}
                </section>
              ))}
            </div>

            {errors.length ? (
              <div className="question-settings-validation" role="alert">
                <strong>Resolve these settings before saving:</strong>
                <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
              </div>
            ) : (
              <p className="question-settings-valid">These settings fit the collection lesson size.</p>
            )}
          </section>
        </div>

        <footer className="question-settings-footer">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={errors.length > 0}>Save changes</button>
        </footer>
      </form>
    </AnimatedModal>
  );
}
