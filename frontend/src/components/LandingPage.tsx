import {
  ArrowRight,
  ArrowUpRight,
  BookOpenText,
  Github,
  LockKeyhole,
  Sparkles,
} from "lucide-react";

const GITHUB_REPOSITORY_URL = "https://github.com/hiuudc/meoing";
const ROADMAP_URL = `${GITHUB_REPOSITORY_URL}/blob/main/docs/roadmap.md`;

const principles = [
  {
    icon: BookOpenText,
    title: "Keep the material together",
    description: "Organize documents, vocabulary, phrases, and notes in one collection for each language project.",
  },
  {
    icon: Sparkles,
    title: "Turn study into practice",
    description: "Build structured practice from the material you choose, with clear controls around AI-assisted learning.",
  },
  {
    icon: LockKeyhole,
    title: "Keep control of your data",
    description: "Meoing is built around account permissions, explicit AI consent, usage limits, and a public security model.",
  },
];

export function LandingPage() {
  return (
    <main className="landing-page">
      <header className="landing-header">
        <a className="landing-brand" href="/" aria-label="Meoing home">
          <span className="landing-brand-mark" aria-hidden="true">M</span>
          <span>Meoing</span>
        </a>
        <nav className="landing-navigation" aria-label="Primary navigation">
          <a href={ROADMAP_URL} target="_blank" rel="noreferrer">Roadmap</a>
          <a href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">Source</a>
          <a className="landing-workspace-link" href="/app">
            Existing account <ArrowRight size={15} aria-hidden="true" />
          </a>
        </nav>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="landing-eyebrow"><span aria-hidden="true" /> Early public development</p>
        <h1 id="landing-title">A calmer place to turn study material into practice.</h1>
        <p className="landing-summary">
          Meoing is an open-source language-learning workspace for collecting material, structuring it into lessons, and tracking steady progress.
        </p>
        <div className="landing-actions">
          <a className="landing-primary-action" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">
            Explore the source <Github size={18} aria-hidden="true" />
          </a>
          <a className="landing-secondary-action" href={ROADMAP_URL} target="_blank" rel="noreferrer">
            Read the roadmap <ArrowUpRight size={17} aria-hidden="true" />
          </a>
        </div>
        <p className="landing-status" role="status">
          <strong>Early access is not open yet.</strong> The hosted workspace is currently limited to maintainers while core flows are being verified.
        </p>
      </section>

      <section className="landing-principles" aria-label="What Meoing is building">
        {principles.map(({ icon: Icon, title, description }) => (
          <article className="landing-principle" key={title}>
            <span className="landing-principle-icon" aria-hidden="true"><Icon size={21} /></span>
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <section className="landing-early-access" aria-labelledby="early-access-title">
        <div>
          <p className="landing-section-label">Open source first</p>
          <h2 id="early-access-title">Follow the work before public access opens.</h2>
          <p>
            The repository includes the website, Worker, shared contracts, security guidance, and the current product roadmap. Feedback and contributions are welcome there.
          </p>
        </div>
        <a className="landing-source-card" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">
          <Github size={21} aria-hidden="true" />
          <span>
            <strong>hiuudc/meoing</strong>
            <small>Apache-2.0 licensed</small>
          </span>
          <ArrowUpRight size={18} aria-hidden="true" />
        </a>
      </section>

      <footer className="landing-footer">
        <span>Meoing is an early-stage open-source project.</span>
        <nav aria-label="Legal">
          <a href="/privacy.html">Privacy</a>
          <a href="/terms.html">Terms</a>
          <a href="/support.html">Support</a>
        </nav>
      </footer>
    </main>
  );
}
