const CHATGPT_ORIGIN = "https://chatgpt.com";
const CONVERSATION_ID_PATTERN = "[A-Za-z0-9-]+";
const PROJECT_ID_PATTERN = "[A-Za-z0-9-]+";
const DIRECT_CONVERSATION_PATH = new RegExp(`^/c/(${CONVERSATION_ID_PATTERN})/?$`);
const PROJECT_CONVERSATION_PATH = new RegExp(`^/g/(${PROJECT_ID_PATTERN})/c/(${CONVERSATION_ID_PATTERN})/?$`);
const PROJECT_HOME_PATH = new RegExp(`^/g/(${PROJECT_ID_PATTERN})/project/?$`);

interface ChatgptConversationLocation {
  conversationId: string;
  projectId?: string;
}

function parseChatgptUrl(value?: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === CHATGPT_ORIGIN ? url : null;
  } catch {
    return null;
  }
}

export function chatgptConversationLocation(value?: string): ChatgptConversationLocation | null {
  const url = parseChatgptUrl(value);
  if (!url) return null;
  const projectMatch = url.pathname.match(PROJECT_CONVERSATION_PATH);
  if (projectMatch) return { projectId: projectMatch[1], conversationId: projectMatch[2] };
  const directMatch = url.pathname.match(DIRECT_CONVERSATION_PATH);
  return directMatch ? { conversationId: directMatch[1] } : null;
}

export function conversationIdFromUrl(value?: string): string | null {
  return chatgptConversationLocation(value)?.conversationId ?? null;
}

export function canonicalConversationUrl(value?: string): string | null {
  const location = chatgptConversationLocation(value);
  if (!location) return null;
  return location.projectId
    ? `${CHATGPT_ORIGIN}/g/${location.projectId}/c/${location.conversationId}`
    : `${CHATGPT_ORIGIN}/c/${location.conversationId}`;
}

export function isConversationUrl(value?: string): value is string {
  return Boolean(chatgptConversationLocation(value));
}

export function isProjectHomeUrl(value?: string): value is string {
  const url = parseChatgptUrl(value);
  return Boolean(url && PROJECT_HOME_PATH.test(url.pathname));
}

export function isChatUrl(value?: string): value is string {
  const url = parseChatgptUrl(value);
  return Boolean(url && (url.pathname === "/" || chatgptConversationLocation(value)));
}

export function sameConversation(left?: string, right?: string): boolean {
  const leftId = conversationIdFromUrl(left);
  return Boolean(leftId && leftId === conversationIdFromUrl(right));
}
