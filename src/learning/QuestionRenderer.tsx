import { ArrowDown, ArrowUp, Headphones, Plus, RotateCcw, X } from "lucide-react";
import type { ChoiceOption, LessonQuestion, QuestionAnswer, SpeakingSubmission } from "./types";
import { SpeakingRecorder } from "./SpeakingRecorder";
import { languageTagForSpeech } from "./speech";

interface QuestionRendererProps {
  question: LessonQuestion;
  answer: QuestionAnswer;
  language: string;
  disabled?: boolean;
  onChange: (answer: QuestionAnswer) => void;
  onSpeakingChange?: (submission: SpeakingSubmission | null) => void;
}

function stringAnswer(answer: QuestionAnswer): string {
  return typeof answer === "string" ? answer : "";
}

function stringArrayAnswer(answer: QuestionAnswer): string[] {
  return Array.isArray(answer) ? answer : [];
}

function mapAnswer(answer: QuestionAnswer): Record<string, string> {
  return answer && typeof answer === "object" && !Array.isArray(answer) ? answer : {};
}

function TextResponse({ value, onChange, disabled, label, multiline = false }: { value: string; onChange: (value: string) => void; disabled?: boolean; label: string; multiline?: boolean }) {
  return (
    <label className="question-text-response">
      <span>{label}</span>
      {multiline ? (
        <textarea rows={5} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} />
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} autoComplete="off" />
      )}
    </label>
  );
}

function ReorderResponse({ options, value, onChange, disabled }: { options: ChoiceOption[]; value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const labels = new Map(options.map((option) => [option.id, option.label]));
  const available = options.filter((option) => !value.includes(option.id));

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="reorder-response">
      <p className="question-control-label">Selected order</p>
      <ol className="reorder-selected-list">
        {value.map((id, index) => (
          <li key={id}>
            <span>{labels.get(id) ?? id}</span>
            <span className="reorder-buttons">
              <button type="button" aria-label={`Move ${labels.get(id) ?? id} up`} onClick={() => move(index, -1)} disabled={disabled || index === 0}><ArrowUp size={14} /></button>
              <button type="button" aria-label={`Move ${labels.get(id) ?? id} down`} onClick={() => move(index, 1)} disabled={disabled || index === value.length - 1}><ArrowDown size={14} /></button>
              <button type="button" aria-label={`Remove ${labels.get(id) ?? id}`} onClick={() => onChange(value.filter((valueId) => valueId !== id))} disabled={disabled}><X size={14} /></button>
            </span>
          </li>
        ))}
      </ol>
      {available.length ? (
        <div className="token-bank" aria-label="Available tokens">
          {available.map((option) => (
            <button type="button" key={option.id} onClick={() => onChange([...value, option.id])} disabled={disabled}>
              <Plus size={13} /> {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {value.length ? (
        <button className="question-reset-button" type="button" onClick={() => onChange([])} disabled={disabled}>
          <RotateCcw size={14} /> Reset order
        </button>
      ) : null}
    </div>
  );
}

function speakText(text: string, language: string) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = languageTagForSpeech(language);
  window.speechSynthesis.speak(utterance);
}

export function QuestionRenderer({ question, answer, language, disabled, onChange, onSpeakingChange }: QuestionRendererProps) {
  switch (question.type) {
    case "singleChoice":
      return (
        <fieldset className="choice-list" disabled={disabled}>
          <legend className="sr-only">Choose one answer</legend>
          {question.options.map((option) => (
            <label key={option.id} className={stringAnswer(answer) === option.id ? "is-selected" : ""}>
              <input type="radio" name={question.id} value={option.id} checked={stringAnswer(answer) === option.id} onChange={() => onChange(option.id)} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      );
    case "multipleChoice": {
      const selected = stringArrayAnswer(answer);
      return (
        <fieldset className="choice-list" disabled={disabled}>
          <legend className="question-control-label">Choose all matching answers</legend>
          {question.options.map((option) => (
            <label key={option.id} className={selected.includes(option.id) ? "is-selected" : ""}>
              <input
                type="checkbox"
                value={option.id}
                checked={selected.includes(option.id)}
                onChange={(event) => onChange(event.target.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      );
    }
    case "trueFalse":
      return (
        <fieldset className="choice-list choice-list-inline" disabled={disabled}>
          <legend>{question.statement}</legend>
          {[{ value: true, label: "True" }, { value: false, label: "False" }].map((option) => (
            <label key={String(option.value)} className={answer === option.value ? "is-selected" : ""}>
              <input type="radio" name={question.id} checked={answer === option.value} onChange={() => onChange(option.value)} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      );
    case "fillBlank":
      return (
        <div className="blank-response">
          <p>{question.template}</p>
          <TextResponse label="Missing word or phrase" value={stringAnswer(answer)} onChange={onChange} disabled={disabled} />
        </div>
      );
    case "multiCloze": {
      const values = mapAnswer(answer);
      return (
        <div className="multi-cloze-response">
          <p>{question.template}</p>
          <div className="cloze-input-grid">
            {question.blanks.map((blank, index) => (
              <TextResponse
                key={blank.id}
                label={`Blank ${index + 1}`}
                value={values[blank.id] ?? ""}
                onChange={(value) => onChange({ ...values, [blank.id]: value })}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      );
    }
    case "wordBank":
      return <ReorderResponse options={question.tokens} value={stringArrayAnswer(answer)} onChange={onChange} disabled={disabled} />;
    case "matching": {
      const values = mapAnswer(answer);
      return (
        <div className="mapping-response" role="group" aria-label="Match pairs">
          {question.pairs.map((pair) => (
            <label key={pair.leftId}>
              <span>{pair.left}</span>
              <select value={values[pair.leftId] ?? ""} onChange={(event) => onChange({ ...values, [pair.leftId]: event.target.value })} disabled={disabled}>
                <option value="">Choose a match...</option>
                {question.pairs.map((candidate) => <option value={candidate.rightId} key={candidate.rightId}>{candidate.right}</option>)}
              </select>
            </label>
          ))}
        </div>
      );
    }
    case "reorderTokens":
      return <ReorderResponse options={question.tokens} value={stringArrayAnswer(answer)} onChange={onChange} disabled={disabled} />;
    case "reorderDialogue":
      return (
        <ReorderResponse
          options={question.turns.map((turn) => ({ id: turn.id, label: `${turn.speaker}: ${turn.label}` }))}
          value={stringArrayAnswer(answer)}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case "categorize": {
      const values = mapAnswer(answer);
      return (
        <div className="mapping-response" role="group" aria-label="Categorize items">
          {question.items.map((item) => (
            <label key={item.id}>
              <span>{item.label}</span>
              <select value={values[item.id] ?? ""} onChange={(event) => onChange({ ...values, [item.id]: event.target.value })} disabled={disabled}>
                <option value="">Choose a category...</option>
                {question.categories.map((category) => <option value={category.id} key={category.id}>{category.label}</option>)}
              </select>
            </label>
          ))}
        </div>
      );
    }
    case "translation":
      return (
        <div className="open-response">
          <blockquote>{question.sourceText}</blockquote>
          <TextResponse label={`${question.targetLanguage} translation`} value={stringAnswer(answer)} onChange={onChange} disabled={disabled} multiline />
          <p className="rubric-copy">ChatGPT rubric: {question.rubric.join(" · ")}</p>
        </div>
      );
    case "shortAnswer":
      return (
        <div className="open-response">
          <TextResponse label="Answer" value={stringAnswer(answer)} onChange={onChange} disabled={disabled} multiline />
          <p className="rubric-copy">Required ideas: {question.requiredIdeas.join(" · ")}</p>
        </div>
      );
    case "errorCorrection":
      return (
        <div className="open-response">
          <blockquote className="incorrect-source">{question.incorrectText}</blockquote>
          <TextResponse label="Corrected sentence" value={stringAnswer(answer)} onChange={onChange} disabled={disabled} />
        </div>
      );
    case "sentenceTransformation":
      return (
        <div className="open-response">
          <blockquote>{question.sourceText}</blockquote>
          <p className="constraint-copy">Constraint: {question.constraint}</p>
          <TextResponse label="New sentence" value={stringAnswer(answer)} onChange={onChange} disabled={disabled} />
        </div>
      );
    case "dictation":
      return (
        <div className="open-response">
          <button className="secondary-button" type="button" onClick={() => speakText(question.transcript, language)} disabled={disabled || !("speechSynthesis" in window)}>
            <Headphones size={16} /> Play sentence
          </button>
          <TextResponse label="What you heard" value={stringAnswer(answer)} onChange={onChange} disabled={disabled} />
          <details className="transcript-fallback"><summary>Cannot hear it? Show the fallback transcript</summary><p>{question.transcript}</p></details>
        </div>
      );
    case "freeWriting": {
      const value = stringAnswer(answer);
      const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0;
      return (
        <div className="open-response">
          <TextResponse label="Writing response" value={value} onChange={onChange} disabled={disabled} multiline />
          <p className="rubric-copy">{wordCount}/{question.minWords}-{question.maxWords} words · {question.rubric.join(" · ")}</p>
        </div>
      );
    }
    case "speakingRepeat":
      return (
        <div className="speaking-response">
          <blockquote>{question.modelText}</blockquote>
          <SpeakingRecorder language={languageTagForSpeech(language)} disabled={disabled} onChange={(submission) => onSpeakingChange?.(submission)} onTranscriptChange={onChange} />
          <TextResponse label="Transcript (editable)" value={stringAnswer(answer)} onChange={onChange} disabled={disabled} multiline />
        </div>
      );
    case "speakingRoleplay":
      return (
        <div className="speaking-response">
          <dl className="roleplay-brief">
            <div><dt>Role</dt><dd>{question.role}</dd></div>
            <div><dt>Scenario</dt><dd>{question.scenario}</dd></div>
            <div><dt>Goal</dt><dd>{question.goal}</dd></div>
          </dl>
          <SpeakingRecorder language={languageTagForSpeech(language)} disabled={disabled} onChange={(submission) => onSpeakingChange?.(submission)} onTranscriptChange={onChange} />
          <TextResponse label="Transcript (editable)" value={stringAnswer(answer)} onChange={onChange} disabled={disabled} multiline />
        </div>
      );
  }
}
