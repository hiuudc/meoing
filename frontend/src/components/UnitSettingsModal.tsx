import { Eye, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { QUESTION_FORMAT_DEFINITIONS, QUESTION_FORMAT_REGISTRY } from "../learning/questionRegistry";
import {
  MAX_CUSTOM_QUESTION_TEMPLATES,
  defaultPresentationForFormat,
  getEffectiveUnitQuestionSettings,
  isSpeakingQuestionFormat,
  validateUnitQuestionSettings,
} from "../learning/questionSettings";
import { QuestionRenderer } from "../learning/QuestionRenderer";
import type {
  CustomQuestionTemplate,
  LearningProfile,
  LessonQuestion,
  QuestionAnswer,
  QuestionFormat,
  QuestionPresentationSettings,
  UnitQuestionSettings,
} from "../learning/types";
import { makeId } from "../store";
import type { Unit } from "../types";
import { cleanUnitName } from "../unit";
import { AnimatedModal } from "./AnimatedModal";

export type UnitSettingsTab = "general" | "questions";

export interface UnitSettingsRequest {
  unit: Unit;
  initialTab: UnitSettingsTab;
}

interface UnitSettingsModalProps {
  request: UnitSettingsRequest | null;
  profile: LearningProfile;
  onClose: () => void;
  onSave: (unit: Unit) => void;
}

interface GeneralDraft {
  name: string;
  description: string;
  instructionOverride: string;
}

function initialAnswer(question: LessonQuestion): QuestionAnswer {
  if (["multipleChoice", "wordBank", "reorderTokens", "reorderDialogue"].includes(question.type)) return [];
  if (["multiCloze", "matching", "categorize"].includes(question.type)) return {};
  return "";
}

function QuestionPreview({ format, language, previewId }: { format: QuestionFormat; language: string; previewId: string }) {
  const sample: LessonQuestion = { ...QUESTION_FORMAT_REGISTRY[format].sample, id: previewId };
  const [answer, setAnswer] = useState<QuestionAnswer>(() => initialAnswer(sample));
  return (
    <div className="unit-question-preview" aria-label={`${QUESTION_FORMAT_REGISTRY[format].label} preview`}>
      <p className="unit-question-preview-prompt">{sample.prompt}</p>
      <QuestionRenderer question={sample} answer={answer} language={language} onChange={setAnswer} />
    </div>
  );
}

function PresentationToggles({
  value,
  onChange,
  disabled,
}: {
  value: QuestionPresentationSettings;
  onChange: (value: QuestionPresentationSettings) => void;
  disabled?: boolean;
}) {
  const options: Array<{ key: keyof QuestionPresentationSettings; label: string }> = [
    { key: "readQuestion", label: "Read question" },
    { key: "readAnswers", label: "Read answers" },
    { key: "wordTooltips", label: "Word tooltips" },
  ];
  return (
    <div className="question-presentation-toggles" aria-label="Presentation settings">
      {options.map((option) => (
        <label key={option.key}>
          <input
            type="checkbox"
            checked={value[option.key]}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, [option.key]: event.target.checked })}
          />
          <span>{option.label}</span>
        </label>
      ))}
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
  return (
    <article className="question-blueprint-card">
      <div className="question-blueprint-heading">
        <label className="format-enable-control">
          <input
            type="checkbox"
            checked={template.enabled && !speakingUnavailable}
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
            onChange={(event) => {
              const baseFormat = event.target.value as QuestionFormat;
              onChange({ ...template, baseFormat, presentation: defaultPresentationForFormat(baseFormat) });
            }}
          >
            {QUESTION_FORMAT_DEFINITIONS.map((definition) => (
              <option
                key={definition.id}
                value={definition.id}
                disabled={!speakingEnabled && definition.badge === "speaking"}
              >
                {definition.label}
              </option>
            ))}
          </select>
        </label>
        <label className="question-blueprint-guidance">
          <span>AI generation guidance</span>
          <textarea
            rows={4}
            maxLength={2_000}
            value={template.guidance}
            onChange={(event) => onChange({ ...template, guidance: event.target.value })}
            placeholder="Example: Use a short workplace exchange and include one distractor from this unit."
          />
          <small>{template.guidance.length}/2,000. Treated as learning data, not executable instructions.</small>
        </label>
      </div>
      {speakingUnavailable ? <p className="settings-inline-warning">Enable speaking in the collection learning profile to use this blueprint.</p> : null}
      <PresentationToggles value={template.presentation} onChange={(presentation) => onChange({ ...template, presentation })} />
      <details className="question-preview-disclosure">
        <summary><Eye size={15} /> Preview</summary>
        <QuestionPreview
          key={`${template.id}:${template.baseFormat}`}
          format={template.baseFormat}
          language={language}
          previewId={`blueprint-preview-${template.id}`}
        />
      </details>
    </article>
  );
}

export function UnitSettingsModal({ request, profile, onClose, onSave }: UnitSettingsModalProps) {
  const [retainedRequest, setRetainedRequest] = useState(request);
  const [activeTab, setActiveTab] = useState<UnitSettingsTab>(request?.initialTab ?? "general");
  const [general, setGeneral] = useState<GeneralDraft>({ name: "", description: "", instructionOverride: "" });
  const [questionSettings, setQuestionSettings] = useState<UnitQuestionSettings>(() => getEffectiveUnitQuestionSettings(undefined, profile));
  const [questionsDirty, setQuestionsDirty] = useState(false);
  const activeRequest = request ?? retainedRequest;

  useEffect(() => {
    if (!request) return;
    setRetainedRequest(request);
    setActiveTab(request.initialTab);
    setGeneral({
      name: cleanUnitName(request.unit.name),
      description: request.unit.description,
      instructionOverride: request.unit.instructionOverride ?? "",
    });
    setQuestionSettings(getEffectiveUnitQuestionSettings(request.unit.questionSettings, profile));
    setQuestionsDirty(false);
  }, [profile, request]);

  if (!activeRequest) return null;

  const activeUnit = activeRequest.unit;
  const errors = validateUnitQuestionSettings(questionSettings, profile);
  const nameMissing = !general.name.trim();
  const canAddBlueprint = questionSettings.customTemplates.length < MAX_CUSTOM_QUESTION_TEMPLATES;

  function updateFormatEnabled(format: QuestionFormat, enabled: boolean) {
    setQuestionsDirty(true);
    setQuestionSettings((current) => ({
      ...current,
      enabledFormats: enabled
        ? [...current.enabledFormats, format]
        : current.enabledFormats.filter((candidate) => candidate !== format),
    }));
  }

  function updateFormatPresentation(format: QuestionFormat, presentation: QuestionPresentationSettings) {
    setQuestionsDirty(true);
    setQuestionSettings((current) => ({
      ...current,
      formatPresentation: { ...current.formatPresentation, [format]: presentation },
    }));
  }

  function addBlueprint() {
    if (!canAddBlueprint) return;
    setQuestionsDirty(true);
    const baseFormat = questionSettings.enabledFormats[0] ?? "singleChoice";
    const template: CustomQuestionTemplate = {
      id: makeId("question-template"),
      name: `Custom blueprint ${questionSettings.customTemplates.length + 1}`,
      baseFormat,
      guidance: "",
      enabled: true,
      presentation: defaultPresentationForFormat(baseFormat),
    };
    setQuestionSettings((current) => ({ ...current, customTemplates: [...current.customTemplates, template] }));
  }

  function updateBlueprint(index: number, template: CustomQuestionTemplate) {
    setQuestionsDirty(true);
    setQuestionSettings((current) => ({
      ...current,
      customTemplates: current.customTemplates.map((candidate, candidateIndex) => candidateIndex === index ? template : candidate),
    }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (nameMissing || errors.length) return;
    onSave({
      ...activeUnit,
      name: general.name.trim(),
      description: general.description.trim(),
      instructionOverride: general.instructionOverride.trim(),
      questionSettings: questionsDirty ? questionSettings : activeUnit.questionSettings,
    });
  }

  return (
    <AnimatedModal
      open={Boolean(request)}
      onClose={onClose}
      labelledBy="unit-settings-title"
      backdropClassName="modal-backdrop unit-settings-backdrop"
      panelClassName="unit-settings-modal"
    >
      <form onSubmit={submit}>
        <header className="unit-settings-header">
          <div>
            <p>Unit settings</p>
            <h2 id="unit-settings-title">{cleanUnitName(activeUnit.name)}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close unit settings" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="unit-settings-tabs" role="tablist" aria-label="Unit settings sections">
          {(["general", "questions"] as const).map((tab) => (
            <button
              key={tab}
              id={`unit-settings-${tab}-tab`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`unit-settings-${tab}-panel`}
              className={activeTab === tab ? "is-active" : ""}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "general" ? "General" : "Questions"}
            </button>
          ))}
        </div>

        <div className="unit-settings-content">
          {activeTab === "general" ? (
            <section id="unit-settings-general-panel" role="tabpanel" aria-labelledby="unit-settings-general-tab" className="unit-general-settings">
              <label>
                <span>Unit name</span>
                <input autoFocus value={general.name} onChange={(event) => setGeneral({ ...general, name: event.target.value })} />
              </label>
              <label>
                <span>Description</span>
                <textarea rows={4} value={general.description} onChange={(event) => setGeneral({ ...general, description: event.target.value })} />
              </label>
              <label>
                <span>Lesson instruction override</span>
                <textarea rows={5} value={general.instructionOverride} onChange={(event) => setGeneral({ ...general, instructionOverride: event.target.value })} />
                <small>This text is treated as untrusted learning context when a lesson is generated.</small>
              </label>
              {nameMissing ? <p className="settings-inline-error">Unit name is required.</p> : null}
            </section>
          ) : (
            <section id="unit-settings-questions-panel" role="tabpanel" aria-labelledby="unit-settings-questions-tab" className="unit-question-settings">
              <div className="question-settings-summary">
                <div><span>Lesson size</span><strong>{profile.lessonQuestionCount} questions</strong></div>
                <div><span>Enabled formats</span><strong>{questionSettings.enabledFormats.filter((format) => profile.speakingEnabled || !isSpeakingQuestionFormat(format)).length}/19</strong></div>
                <div><span>Enabled blueprints</span><strong>{questionSettings.customTemplates.filter((template) => template.enabled).length}/{profile.lessonQuestionCount}</strong></div>
              </div>

              <div className="settings-section-heading">
                <div>
                  <h3>Question formats</h3>
                  <p>Enable at least five formats, including one local and one AI-graded format.</p>
                </div>
              </div>
              <div className="question-format-grid">
                {QUESTION_FORMAT_DEFINITIONS.map((definition) => {
                  const speakingUnavailable = !profile.speakingEnabled && definition.badge === "speaking";
                  const enabled = questionSettings.enabledFormats.includes(definition.id) && !speakingUnavailable;
                  const formatPresentation = questionSettings.formatPresentation[definition.id]
                    ?? defaultPresentationForFormat(definition.id);
                  return (
                    <article className={`question-format-card ${enabled ? "is-enabled" : ""}`} data-question-format={definition.id} key={definition.id}>
                      <div className="question-format-heading">
                        <label className="format-enable-control">
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={speakingUnavailable}
                            onChange={(event) => updateFormatEnabled(definition.id, event.target.checked)}
                          />
                          <span>{definition.label}</span>
                        </label>
                        <span className={`question-format-badge is-${definition.badge}`}>{definition.badge === "ai" ? "AI" : definition.badge}</span>
                      </div>
                      <p>{definition.description}</p>
                      {speakingUnavailable ? <small>Collection speaking is disabled.</small> : null}
                      <PresentationToggles
                        value={formatPresentation}
                        disabled={!enabled}
                        onChange={(presentationValue) => updateFormatPresentation(definition.id, presentationValue)}
                      />
                      <details className="question-preview-disclosure">
                        <summary><Eye size={15} /> Preview</summary>
                        <QuestionPreview
                          format={definition.id}
                          language={profile.targetLanguage}
                          previewId={`format-preview-${definition.id}`}
                        />
                      </details>
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
                      onDelete={() => {
                        setQuestionsDirty(true);
                        setQuestionSettings((current) => ({
                          ...current,
                          customTemplates: current.customTemplates.filter((_, candidateIndex) => candidateIndex !== index),
                        }));
                      }}
                    />
                  ))}
                </div>
              ) : (
                <p className="question-blueprint-empty">No custom blueprints. Built-in formats will fill the lesson.</p>
              )}

              {errors.length ? (
                <div className="unit-settings-validation" role="alert">
                  <strong>Resolve these settings before saving:</strong>
                  <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
                </div>
              ) : (
                <p className="unit-settings-valid">These settings fit the collection lesson size.</p>
              )}
            </section>
          )}
        </div>

        <footer className="unit-settings-footer">
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={nameMissing || errors.length > 0}>Save changes</button>
        </footer>
      </form>
    </AnimatedModal>
  );
}
