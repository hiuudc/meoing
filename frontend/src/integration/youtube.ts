const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

export function extractYouTubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
    const id = url.hostname.toLowerCase() === "youtu.be" ? url.pathname.split("/").filter(Boolean)[0] : url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function youtubeNoCookieEmbedUrl(value: string): string | null {
  const id = extractYouTubeVideoId(value);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

export function isAllowedTranscriptFile(file: File): boolean {
  return file.size <= 512_000 && /\.(srt|vtt|txt)$/i.test(file.name);
}
