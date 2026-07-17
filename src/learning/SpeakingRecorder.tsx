import { Mic, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SpeakingSubmission } from "./types";

const MAX_RECORDING_MS = 20_000;
const MAX_RECORDING_BYTES = 1_048_576;

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface SpeakingRecorderProps {
  language?: string;
  disabled?: boolean;
  onChange: (submission: SpeakingSubmission | null) => void;
  onTranscriptChange: (transcript: string) => void;
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

function countWords(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

export function SpeakingRecorder({ language = "en-US", disabled, onChange, onTranscriptChange }: SpeakingRecorderProps) {
  const [state, setState] = useState<"idle" | "recording" | "recorded">("idle");
  const [audioUrl, setAudioUrl] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const lastSpeechAtRef = useRef(0);
  const pauseCountRef = useRef(0);
  const transcriptRef = useRef("");

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(Math.min(MAX_RECORDING_MS, elapsed));
      if (elapsed >= MAX_RECORDING_MS) recorderRef.current?.stop();
    }, 200);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recognitionRef.current?.stop();
  }, [audioUrl]);

  function finishTranscript(durationMs: number, audio?: Blob) {
    const transcript = transcriptRef.current.trim();
    const minutes = durationMs / 60_000;
    const submission: SpeakingSubmission = {
      transcript: transcript || undefined,
      durationMs,
      wordsPerMinute: transcript && minutes > 0 ? Math.round(countWords(transcript) / minutes) : undefined,
      pauseCount: pauseCountRef.current,
      pronunciationAvailable: Boolean(audio),
      audio,
    };
    onTranscriptChange(transcript);
    onChange(submission);
  }

  function startRecognition() {
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) return;
    try {
      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = language;
      recognition.onresult = (event) => {
        let transcript = "";
        for (let index = 0; index < event.results.length; index += 1) transcript += `${event.results[index][0]?.transcript ?? ""} `;
        const now = Date.now();
        if (lastSpeechAtRef.current && now - lastSpeechAtRef.current > 1_200) pauseCountRef.current += 1;
        lastSpeechAtRef.current = now;
        transcriptRef.current = transcript.trim();
        onTranscriptChange(transcriptRef.current);
      };
      recognition.onerror = () => {
        recognitionRef.current = null;
      };
      recognition.start();
      recognitionRef.current = recognition;
    } catch {
      recognitionRef.current = null;
    }
  }

  async function startRecording() {
    setError("");
    setElapsedMs(0);
    chunksRef.current = [];
    transcriptRef.current = "";
    pauseCountRef.current = 0;
    lastSpeechAtRef.current = 0;
    startedAtRef.current = Date.now();
    startRecognition();

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      if (!speechRecognitionConstructor()) {
        setError("Trình duyệt này không hỗ trợ recording hoặc Speech Recognition. Hãy nhập transcript bên dưới.");
        return;
      }
      setState("recording");
      window.setTimeout(() => stopRecording(), MAX_RECORDING_MS);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 });
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        chunksRef.current.push(event.data);
        const size = chunksRef.current.reduce((total, chunk) => total + chunk.size, 0);
        if (size > MAX_RECORDING_BYTES) {
          setError("Recording vượt quá 1 MiB và đã được dừng. Hãy thu câu ngắn hơn.");
          recorder.stop();
        }
      };
      recorder.onstop = () => {
        const durationMs = Math.min(MAX_RECORDING_MS, Date.now() - startedAtRef.current);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recognitionRef.current?.stop();
        recognitionRef.current = null;
        if (blob.size > MAX_RECORDING_BYTES) {
          chunksRef.current = [];
          setState("idle");
          finishTranscript(durationMs);
          return;
        }
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        const nextUrl = URL.createObjectURL(blob);
        setAudioUrl(nextUrl);
        setState("recorded");
        finishTranscript(durationMs, blob);
      };
      recorderRef.current = recorder;
      recorder.start(250);
      setState("recording");
    } catch {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setError("Không thể truy cập microphone. Bạn vẫn có thể nhập transcript để được chấm nội dung.");
      setState("idle");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.stop();
      recorderRef.current = null;
      return;
    }
    const durationMs = Math.min(MAX_RECORDING_MS, Date.now() - startedAtRef.current);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setState("recorded");
    finishTranscript(durationMs);
  }

  function resetRecording() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    setElapsedMs(0);
    setError("");
    setState("idle");
    transcriptRef.current = "";
    onTranscriptChange("");
    onChange(null);
  }

  return (
    <section className="speaking-recorder" aria-label="Speaking recorder">
      <div className="speaking-recorder-actions">
        {state === "idle" ? (
          <button className="secondary-button" type="button" onClick={startRecording} disabled={disabled}>
            <Mic size={16} /> Thu âm tối đa 20 giây
          </button>
        ) : null}
        {state === "recording" ? (
          <button className="recording-stop-button" type="button" onClick={stopRecording}>
            <Square size={15} /> Dừng ({Math.ceil(elapsedMs / 1_000)}s)
          </button>
        ) : null}
        {state === "recorded" ? (
          <>
            {audioUrl ? (
              <audio controls src={audioUrl} aria-label="Nghe lại recording">
                <a href={audioUrl}>Nghe recording</a>
              </audio>
            ) : (
              <span className="transcript-only-badge"><Pause size={14} /> Transcript only</span>
            )}
            <button className="icon-text-button" type="button" onClick={startRecording} disabled={disabled}>
              <RotateCcw size={15} /> Thu lại
            </button>
            <button className="icon-text-button" type="button" onClick={resetRecording}>
              <Trash2 size={15} /> Xóa
            </button>
          </>
        ) : null}
      </div>
      <p className="speaking-limit-copy">
        <Play size={13} /> Audio chỉ dùng để phát lại trong browser. Meoi chỉ gửi transcript và chỉ số nhịp nói; transcript-only không có điểm pronunciation.
      </p>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </section>
  );
}
