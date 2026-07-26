import { Eye, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { LESSON_QUESTION_FORMAT_DEFINITIONS, QUESTION_FORMAT_REGISTRY } from "../learning/questionRegistry";
import {
  MAX_CUSTOM_QUESTION_TEMPLATES,
  getEffectiveCollectionQuestionSettings,
  isSpeakingQuestionFormat,
  supportsQuestionFormatForLanguage,
  validateCollectionQuestionSettings,
} from "../learning/questionSettings";
import { QuestionRenderer } from "../learning/QuestionRenderer";
import type {
  CollectionQuestionSettings,
  CustomQuestionTemplate,
  LearningProfile,
  LessonQuestion,
  QuestionAnswer,
  QuestionFormat,
} from "../learning/types";
import { makeId } from "../store";
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
  const sample: LessonQuestion = { ...QUESTION_FORMAT_REGISTRY[format].sample, id: previewId };
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
      <div className="question-preview-label"><Eye size={15} /> Preview</div>
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

function BlueprintEditor({
  template,
  language,
  speakingEnabled,
  onChange,
  onDelete,
}: {
  template: CustomQuestionTemplate;
  language: string;
  speakingEnabled: boolean;
  onChange: (template: CustomQuestionTemplate) => void;
  onDelete: () => void;
}) {
  const speakingUnavailable = !speakingEnabled && isSpeakingQuestionFormat(template.baseFormat);
  const enabled = template.enabled && !speakingUnavailable;

  return (
    <article className={`question-blueprint-card ${enabled ? "is-enabled" : "is-disabled"}`}>
      <div className="question-blueprint-settings">
        <div className="question-blueprint-heading">
          <label className="format-enable-control">
            <input
              type="checkbox"
              checked={enabled}
              disabled={speakingUnavailable}
              onChange={(event) => onChange({ ...template, enabled: event.target.checked })}
            />
            <span>Enabled</span>
          </label>
          <button className="icon-button" type="button" aria-label={`Delete ${template.name}`} onClick={onDelete}>
            <Trash2 size={16} />
          </button>
        </div>
        <div className="question-blueprint-fields">
          <label>
            <span>Name</span>
            <input
              value={template.name}
              maxLength={80}
              onChange={(event) => onChange({ ...template, name: event.target.value })}
            />
            <small>{template.name.length}/80</small>
          </label>
          <label>
            <span>Base format</span>
            <select
              value={template.baseFormat}
              onChange={(event) => onChange({ ...template, baseFormat: event.target.value as QuestionFormat })}
            >
              {LESSON_QUESTION_FORMAT_DEFINITIONS.map((definition) => (
                <option
                  key={definition.id}
                  value={definition.id}
                  disabled={(!speakingEnabled && definition.badge === "speaking")
                    || !supportsQuestionFormatForLanguage(definition.id, language)}
                >
                  {definition.label}
                </option>
              ))}
            </select>
          </label>
          <label className="question-blueprint-guidance">
            <span>AI generation guidance</span>
            <textarea
              rows={6}
              maxLength={2_000}
              value={template.guidance}
              onChange={(event) => onChange({ ...template, guidance: event.target.value })}
              placeholder="Example: Use a short workplace exchange and include one distractor from this collection."
            />
            <small>{template.guidance.length}/2,000. Treated as learning data, not executable instructions.</small>
          </label>
        </div>
        {speakingUnavailable ? (
          <p className="settings-inline-warning">Enable speaking in the collection learning profile to use this blueprint.</p>
        ) : null}
      </div>
      <PreviewColumn
        disabled={!enabled}
        format={template.baseFormat}
        language={language}
        previewId={`blueprint-preview-${template.id}`}
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
  const activeCollection = collection ?? retainedCollection;

  useEffect(() => {
    if (!collection) return;
    setRetainedCollection(collection);
    setQuestionSettings(getEffectiveCollectionQuestionSettings(collection.questionSettings, profile));
  }, [collection, profile]);

  if (!activeCollection) return null;

  const errors = validateCollectionQuestionSettings(questionSettings, profile);
  const canAddBlueprint = questionSettings.customTemplates.length < MAX_CUSTOM_QUESTION_TEMPLATES;

  function updateFormatEnabled(format: QuestionFormat, enabled: boolean) {
    setQuestionSettings((current) => ({
      ...current,
      enabledFormats: enabled
        ? [...current.enabledFormats, format]
        : current.enabledFormats.filter((candidate) => candidate !== format),
    }));
  }

  function addBlueprint() {
    if (!canAddBlueprint) return;
    const template: CustomQuestionTemplate = {
      id: makeId("question-template"),
      name: `Custom blueprint ${questionSettings.customTemplates.length + 1}`,
      baseFormat: questionSettings.enabledFormats[0] ?? "singleChoice",
      guidance: "",
      enabled: true,
    };
    setQuestionSettings((current) => ({
      ...current,
      customTemplates: [...current.customTemplates, template],
    }));
  }

  function updateBlueprint(index: number, template: CustomQuestionTemplate) {
    setQuestionSettings((current) => ({
      ...current,
      customTemplates: current.customTemplates.map((candidate, candidateIndex) => (
        candidateIndex === index ? template : candidate
      )),
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
              <div><span>Enabled formats</span><strong>{questionSettings.enabledFormats.length}/{LESSON_QUESTION_FORMAT_DEFINITIONS.length}</strong></div>
              <div><span>Enabled blueprints</span><strong>{questionSettings.customTemplates.filter((template) => template.enabled).length}/{profile.lessonQuestionCount}</strong></div>
            </div>

            <div className="settings-section-heading">
              <div>
                <h3>Question formats</h3>
                <p>Enable at least five formats, including one local and one AI-graded format.</p>
              </div>
            </div>
            <div className="question-format-grid">
              {LESSON_QUESTION_FORMAT_DEFINITIONS.map((definition) => {
                const speakingUnavailable = !profile.speakingEnabled && definition.badge === "speaking";
                const languageUnavailable = !supportsQuestionFormatForLanguage(definition.id, profile.targetLanguage);
                const enabled = questionSettings.enabledFormats.includes(definition.id)
                  && !speakingUnavailable
                  && !languageUnavailable;

                return (
                  <article
                    className={`question-format-card ${enabled ? "is-enabled" : "is-disabled"}`}
                    data-question-format={definition.id}
                    key={definition.id}
                  >
                    <div className="question-format-heading">
                      <label className="format-enable-control">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={speakingUnavailable || languageUnavailable}
                          onChange={(event) => updateFormatEnabled(definition.id, event.target.checked)}
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
                      language={profile.targetLanguage}
                      previewId={`format-preview-${definition.id}`}
                    />
                  </article>
                );
              })}
            </div>

            <div className="settings-section-heading question-blueprint-section-heading">
              <div>
                <h3>Custom blueprints</h3>
                <p>Each enabled blueprint must appear in every newly generated lesson. Saved lessons keep their copied settings.</p>
              </div>
              <button className="secondary-button" type="button" onClick={addBlueprint} disabled={!canAddBlueprint}>
                <Plus size={16} /> Add blueprint
              </button>
            </div>
            {questionSettings.customTemplates.length ? (
              <div className="question-blueprint-list">
                {questionSettings.customTemplates.map((template, index) => (
                  <BlueprintEditor
                    key={template.id}
                    template={template}
                    language={profile.targetLanguage}
                    speakingEnabled={profile.speakingEnabled}
                    onChange={(nextTemplate) => updateBlueprint(index, nextTemplate)}
                    onDelete={() => setQuestionSettings((current) => ({
                      ...current,
                      customTemplates: current.customTemplates.filter((_, candidateIndex) => candidateIndex !== index),
                    }))}
                  />
                ))}
              </div>
            ) : (
              <p className="question-blueprint-empty">No custom blueprints. Built-in formats will fill the lesson.</p>
            )}

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
