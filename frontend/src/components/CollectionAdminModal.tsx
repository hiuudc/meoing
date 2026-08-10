import {
  BookOpen,
  ArchiveRestore,
  Check,
  CircleHelp,
  Clipboard,
  FileClock,
  Link2,
  LoaderCircle,
  Pencil,
  Plus,
  ScrollText,
  Settings,
  Shield,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiErrorMessage, type ApiClient } from "../api/client";
import { uploadProfileImage } from "../api/files";
import {
  assignCollectionRole,
  createCollectionInvite,
  createCollectionRole,
  deleteCollectionRole,
  getCollectionMemberLanguageStats,
  getProgressDetail,
  leaveCollection,
  listCollectionAudit,
  listCollectionInvites,
  listCollectionLessons,
  listCollectionMembers,
  listCollectionRoles,
  listMemberProgress,
  publishLesson,
  removeCollectionMember,
  revokeCollectionInvite,
  transferCollectionOwnership,
  unassignCollectionRole,
  unpublishLesson,
  updateCollectionProfile,
  updateCollectionRole,
  type CollectionAuditEvent,
  type CollectionInvite,
  type CollectionMember,
  type CollectionPermission,
  type CollectionRole,
  type LessonSummary,
  type LanguageStats,
  type MemberProgress,
} from "../api/collectionAdmin";
import { SUPPORTED_LANGUAGE_NAMES } from "../learning/languages";
import { normalizeLearningProfile } from "../learning/profile";
import type { Collection } from "../types";
import type { CollectionQuestionSettings, LearningProfile } from "../learning/types";
import { normalizeHex } from "../theme";
import { AnimatedModal } from "./AnimatedModal";
import { CollectionQuestionSettingsPanel } from "./CollectionQuestionSettingsModal";
import { DeletedUnitsPanel } from "./DeletedUnitsModal";
import { HsvColorPicker } from "./HsvColorPicker";

export type AdminTab = "details" | "questions" | "units" | "members" | "roles" | "invites" | "audit" | "lessons";

export interface CollectionDetailsDraft {
  name: string;
  icon: string;
  accent: string;
  targetLanguage: string;
  sourceLanguage: string;
}

export interface CollectionAdminModalProps {
  collection: Collection;
  api: ApiClient;
  currentUserId: string;
  effectivePermissions: readonly CollectionPermission[];
  learningProfile: LearningProfile;
  questionSettings?: CollectionQuestionSettings;
  initialTab?: AdminTab;
  onSaveDetails: (details: CollectionDetailsDraft) => void | Promise<void>;
  onSaveQuestionSettings: (settings: CollectionQuestionSettings) => void | Promise<void>;
  onRestoreDeletedUnit: (unitId: string) => void | Promise<void>;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

interface RoleDraft {
  id: string | null;
  name: string;
  color: string;
  securityRank: string;
  permissions: CollectionPermission[];
  revision: number;
  isManaged: boolean;
}

interface TabDefinition {
  id: AdminTab;
  label: string;
  icon: typeof Users;
  permission?: CollectionPermission;
}

interface ProgressDetailState {
  attempts?: MemberProgress["attempts"];
  error?: string;
  loading: boolean;
}

const ADMIN_TABS: readonly TabDefinition[] = [
  { id: "details", label: "Details", icon: Settings, permission: "manage_collection" },
  { id: "questions", label: "Questions", icon: CircleHelp, permission: "manage_collection" },
  { id: "units", label: "Units", icon: ArchiveRestore, permission: "edit_content" },
  { id: "members", label: "Members", icon: Users },
  { id: "roles", label: "Roles", icon: Shield },
  { id: "invites", label: "Invites", icon: Link2, permission: "manage_invites" },
  { id: "audit", label: "Audit log", icon: ScrollText, permission: "view_audit_log" },
  { id: "lessons", label: "Lessons", icon: BookOpen },
];

const PERMISSION_OPTIONS: readonly {
  id: CollectionPermission;
  label: string;
  description: string;
}[] = [
  { id: "manage_collection", label: "Manage collection", description: "Edit collection-wide details and settings." },
  { id: "manage_roles", label: "Manage roles", description: "Create roles and assign roles below the actor." },
  { id: "manage_members", label: "Manage members", description: "Remove eligible members from the collection." },
  { id: "manage_invites", label: "Manage invites", description: "Create and revoke collection invitations." },
  { id: "view_audit_log", label: "View audit log", description: "Review security and content changes." },
  { id: "create_content", label: "Create content", description: "Create units and learning content." },
  { id: "edit_content", label: "Edit content", description: "Update existing units and content." },
  { id: "delete_content", label: "Delete content", description: "Soft-delete content and lessons where allowed." },
  { id: "create_lessons", label: "Create lessons", description: "Save new lesson drafts." },
  { id: "publish_lessons", label: "Publish lessons", description: "Review, publish, and unpublish lesson drafts." },
  { id: "view_member_progress", label: "View member progress", description: "See member session summaries and term statistics." },
  { id: "view_member_answers", label: "View raw answers", description: "See answers, transcripts, outcomes, and scores." },
  { id: "manage_collection_profiles", label: "Manage collection profiles", description: "Manage collection-specific profile overrides." },
];

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : DATE_FORMATTER.format(date);
}

function memberLabel(member: CollectionMember): string {
  return member.displayName || (member.username ? `@${member.username}` : member.userId);
}

function emptyRoleDraft(): RoleDraft {
  return {
    id: null,
    name: "",
    color: "#655bf5",
    securityRank: "1",
    permissions: [],
    revision: 0,
    isManaged: false,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function summaryEntries(summary: Record<string, unknown>): [string, string][] {
  return Object.entries(summary).flatMap(([key, value]) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return [[key, String(value)]];
    }
    return [];
  });
}

function readableAction(value: string): string {
  return value.replace(/_/g, " ");
}

export function collectionAdminTabsForPermissions(
  permissions: readonly CollectionPermission[],
): AdminTab[] {
  const allowed = new Set(permissions);
  return ADMIN_TABS
    .filter((tab) => !tab.permission || allowed.has(tab.permission))
    .map((tab) => tab.id);
}

const COLLECTION_ACCENT_PRESETS = ["#8B7CF6", "#E7AD67", "#72BDA3", "#EB7198", "#69A9E8"];

function CollectionDetailsPanel({
  collection,
  learningProfile,
  onSave,
}: {
  collection: Collection;
  learningProfile: LearningProfile;
  onSave: (details: CollectionDetailsDraft) => void | Promise<void>;
}) {
  const profile = normalizeLearningProfile(learningProfile);
  const [name, setName] = useState(collection.name);
  const [icon, setIcon] = useState(collection.icon);
  const [accent, setAccent] = useState(normalizeHex(collection.accent));
  const [targetLanguage, setTargetLanguage] = useState(profile.targetLanguage);
  const [sourceLanguage, setSourceLanguage] = useState(profile.sourceLanguage);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const nextProfile = normalizeLearningProfile(learningProfile);
    setName(collection.name);
    setIcon(collection.icon);
    setAccent(normalizeHex(collection.accent));
    setTargetLanguage(nextProfile.targetLanguage);
    setSourceLanguage(nextProfile.sourceLanguage);
    setError(null);
  }, [collection.accent, collection.icon, collection.name, collection.revision, learningProfile]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !icon.trim() || !targetLanguage || !sourceLanguage) {
      setError("Name, icon, and both languages are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        icon: icon.trim().slice(0, 2),
        accent: normalizeHex(accent),
        targetLanguage,
        sourceLanguage,
      });
    } catch (saveError) {
      setError(apiErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="collection-admin-section" aria-labelledby="collection-details-title">
      <div className="collection-admin-section-heading">
        <div>
          <h3 id="collection-details-title">Collection details</h3>
          <p>Manage the identity, language pair, and accent used across this collection.</p>
        </div>
      </div>
      <form className="collection-admin-card collection-admin-form-grid collection-details-form" onSubmit={(event) => void submit(event)}>
        <label className="collection-admin-form-wide">Collection name
          <input value={name} onChange={(event) => setName(event.target.value)} disabled={saving} autoFocus />
        </label>
        <label>Collection icon
          <input value={icon} onChange={(event) => setIcon(event.target.value.slice(0, 2))} disabled={saving} maxLength={2} />
        </label>
        <span className="collection-admin-field-note">Use one or two characters.</span>
        <label>Language learning
          <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value as typeof targetLanguage)} disabled={saving}>
            {SUPPORTED_LANGUAGE_NAMES.map((language) => <option key={language} value={language}>{language}</option>)}
          </select>
        </label>
        <label>Language speaking
          <select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value as typeof sourceLanguage)} disabled={saving}>
            {SUPPORTED_LANGUAGE_NAMES.map((language) => <option key={language} value={language}>{language}</option>)}
          </select>
        </label>
        <fieldset className="collection-admin-accent-field collection-admin-form-wide">
          <legend>Accent color</legend>
          <div className="collection-admin-accent-presets">
            {COLLECTION_ACCENT_PRESETS.map((value) => (
              <button
                key={value}
                aria-label={`Use ${value} accent`}
                aria-pressed={accent === value}
                className={accent === value ? "is-selected" : undefined}
                disabled={saving}
                onClick={(event) => {
                  event.preventDefault();
                  setAccent(value);
                }}
                style={{ background: value }}
                type="button"
              />
            ))}
          </div>
          <HsvColorPicker value={accent} onChange={setAccent} />
          <label>Custom hex
            <input
              value={accent}
              maxLength={7}
              onBlur={() => setAccent(normalizeHex(accent))}
              onChange={(event) => setAccent(event.target.value)}
              disabled={saving}
              spellCheck={false}
            />
          </label>
        </fieldset>
        {error ? <p className="collection-admin-inline-error collection-admin-form-wide" role="alert">{error}</p> : null}
        <div className="collection-admin-actions collection-admin-form-wide">
          <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save changes"}</button>
        </div>
      </form>
    </section>
  );
}

export function CollectionAdminModal({
  collection,
  api,
  currentUserId,
  effectivePermissions,
  learningProfile,
  questionSettings,
  initialTab = "details",
  onSaveDetails,
  onSaveQuestionSettings,
  onRestoreDeletedUnit,
  onClose,
  onChanged,
}: CollectionAdminModalProps) {
  const permissions = useMemo(() => new Set(effectivePermissions), [effectivePermissions]);
  const availableTabs = useMemo(
    () => ADMIN_TABS.filter((tab) => !tab.permission || permissions.has(tab.permission)),
    [permissions],
  );
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab);
  const [members, setMembers] = useState<CollectionMember[]>([]);
  const [roles, setRoles] = useState<CollectionRole[]>([]);
  const [invites, setInvites] = useState<CollectionInvite[]>([]);
  const [auditEvents, setAuditEvents] = useState<CollectionAuditEvent[]>([]);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [nextCursors, setNextCursors] = useState<Partial<Record<AdminTab, string | null>>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileAvatarAssetId, setProfileAvatarAssetId] = useState("");
  const [profileBio, setProfileBio] = useState("");
  const [profileTargetUserId, setProfileTargetUserId] = useState("");
  const [profileExpectedRevision, setProfileExpectedRevision] = useState(0);
  const [profileAvatarFile, setProfileAvatarFile] = useState<File | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleDraft>(() => emptyRoleDraft());
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [inviteMaxUses, setInviteMaxUses] = useState("");
  const [inviteRoleIds, setInviteRoleIds] = useState<string[]>([]);
  const [createdInviteToken, setCreatedInviteToken] = useState<string | null>(null);
  const [assignmentByMember, setAssignmentByMember] = useState<Record<string, string>>({});
  const [ownershipTargetUserId, setOwnershipTargetUserId] = useState("");
  const [progressMember, setProgressMember] = useState<CollectionMember | null>(null);
  const [progressItems, setProgressItems] = useState<MemberProgress[]>([]);
  const [progressCursor, setProgressCursor] = useState<string | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressDetails, setProgressDetails] = useState<Record<string, ProgressDetailState>>({});
  const [progressStats, setProgressStats] = useState<Record<string, LanguageStats>>({});
  const [progressStatsLoading, setProgressStatsLoading] = useState(false);
  const progressRequestId = useRef(0);

  const canManageRoles = permissions.has("manage_roles");
  const canManageMembers = permissions.has("manage_members");
  const canManageCollectionProfiles = permissions.has("manage_collection_profiles");
  const canManageInvites = permissions.has("manage_invites");
  const canViewProgress = permissions.has("view_member_progress");
  const canViewAnswers = permissions.has("view_member_answers");
  const canPublishLessons = permissions.has("publish_lessons");
  const isOwner = collection.ownerId === currentUserId
    || members.some((member) => member.userId === currentUserId && member.isOwner);
  const createdInviteUrl = createdInviteToken
    ? `${window.location.origin}/?invite=${encodeURIComponent(createdInviteToken)}`
    : null;

  useEffect(() => {
    progressRequestId.current += 1;
    const preferredTab = availableTabs.some((tab) => tab.id === initialTab)
      ? initialTab
      : availableTabs[0]?.id;
    if (preferredTab) setActiveTab(preferredTab);
    setMembers([]);
    setRoles([]);
    setInvites([]);
    setAuditEvents([]);
    setLessons([]);
    setNextCursors({});
    setProgressMember(null);
    setProgressItems([]);
    setProgressCursor(null);
    setProgressDetails({});
    setProgressStats({});
    setProgressStatsLoading(false);
    setOwnershipTargetUserId("");
    setProfileTargetUserId("");
    setError(null);
    setNotice(null);
  }, [availableTabs, collection.id, initialTab]);

  useEffect(() => {
    const targetUserId = profileTargetUserId || currentUserId;
    const target = members.find((member) => member.userId === targetUserId);
    const profile = target?.collectionProfile;
    setProfileDisplayName(profile?.displayName ?? "");
    setProfileAvatarAssetId(profile?.avatarAssetId ?? "");
    setProfileBio(profile?.bio ?? "");
    setProfileExpectedRevision(profile?.revision ?? 0);
    setProfileAvatarFile(null);
  }, [currentUserId, members, profileTargetUserId]);

  useEffect(() => {
    if (availableTabs.some((tab) => tab.id === activeTab)) return;
    const firstAvailableTab = availableTabs[0]?.id;
    if (firstAvailableTab) setActiveTab(firstAvailableTab);
  }, [activeTab, availableTabs]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function loadActiveTab() {
      try {
        if (activeTab === "details" || activeTab === "questions" || activeTab === "units") {
          return;
        } else if (activeTab === "members") {
          const [memberResponse, roleResponse] = await Promise.all([
            listCollectionMembers(api, collection.id, null, controller.signal),
            listCollectionRoles(api, collection.id, null, controller.signal),
          ]);
          setMembers(memberResponse.data.items);
          setRoles(roleResponse.data.items);
          setNextCursors((current) => ({
            ...current,
            members: memberResponse.data.nextCursor,
          }));
        } else if (activeTab === "roles") {
          const response = await listCollectionRoles(api, collection.id, null, controller.signal);
          setRoles(response.data.items);
          setNextCursors((current) => ({ ...current, roles: response.data.nextCursor }));
        } else if (activeTab === "invites" && canManageInvites) {
          const [inviteResponse, roleResponse] = await Promise.all([
            listCollectionInvites(api, collection.id, null, controller.signal),
            listCollectionRoles(api, collection.id, null, controller.signal),
          ]);
          setInvites(inviteResponse.data.items);
          setRoles(roleResponse.data.items);
          setNextCursors((current) => ({ ...current, invites: inviteResponse.data.nextCursor }));
        } else if (activeTab === "audit" && permissions.has("view_audit_log")) {
          const response = await listCollectionAudit(api, collection.id, null, controller.signal);
          setAuditEvents(response.data.items);
          setNextCursors((current) => ({ ...current, audit: response.data.nextCursor }));
        } else if (activeTab === "lessons") {
          const response = await listCollectionLessons(api, collection.id, null, controller.signal);
          setLessons(response.data.items);
          setNextCursors((current) => ({ ...current, lessons: response.data.nextCursor }));
        }
      } catch (loadError) {
        if (!isAbortError(loadError)) setError(apiErrorMessage(loadError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadActiveTab();
    return () => controller.abort();
  }, [
    activeTab,
    api,
    canManageInvites,
    collection.id,
    permissions,
    refreshVersion,
  ]);

  async function runMutation(action: () => Promise<unknown>, successMessage: string) {
    setActionLoading(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      await onChanged();
      setRefreshVersion((current) => current + 1);
      return true;
    } catch (mutationError) {
      setError(apiErrorMessage(mutationError));
      return false;
    } finally {
      setActionLoading(false);
    }
  }

  async function loadMore() {
    const cursor = nextCursors[activeTab];
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      if (activeTab === "members") {
        const response = await listCollectionMembers(api, collection.id, cursor);
        setMembers((current) => [...current, ...response.data.items]);
        setNextCursors((current) => ({ ...current, members: response.data.nextCursor }));
      } else if (activeTab === "roles") {
        const response = await listCollectionRoles(api, collection.id, cursor);
        setRoles((current) => [...current, ...response.data.items]);
        setNextCursors((current) => ({ ...current, roles: response.data.nextCursor }));
      } else if (activeTab === "invites" && canManageInvites) {
        const response = await listCollectionInvites(api, collection.id, cursor);
        setInvites((current) => [...current, ...response.data.items]);
        setNextCursors((current) => ({ ...current, invites: response.data.nextCursor }));
      } else if (activeTab === "audit" && permissions.has("view_audit_log")) {
        const response = await listCollectionAudit(api, collection.id, cursor);
        setAuditEvents((current) => [...current, ...response.data.items]);
        setNextCursors((current) => ({ ...current, audit: response.data.nextCursor }));
      } else if (activeTab === "lessons") {
        const response = await listCollectionLessons(api, collection.id, cursor);
        setLessons((current) => [...current, ...response.data.items]);
        setNextCursors((current) => ({ ...current, lessons: response.data.nextCursor }));
      }
    } catch (loadError) {
      setError(apiErrorMessage(loadError));
    } finally {
      setLoadingMore(false);
    }
  }

  async function submitProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let uploadedAssetId: string | null = null;
    const saved = await runMutation(
      async () => {
        const avatarAssetId = profileAvatarFile
          ? await uploadProfileImage(
              api,
              profileAvatarFile,
              collection.id,
              (assetId) => {
                uploadedAssetId = assetId;
              },
            )
          : profileAvatarAssetId.trim() || null;
        return updateCollectionProfile(api, collection.id, {
          ...(profileTargetUserId ? { userId: profileTargetUserId } : {}),
          displayName: profileDisplayName.trim() || null,
          avatarAssetId,
          bio: profileBio.trim() || null,
          expectedRevision: profileExpectedRevision,
        });
      },
      profileTargetUserId ? "Member collection profile updated." : "Your collection profile was updated.",
    );
    if (!saved && uploadedAssetId) {
      await api.delete(`/v1/files/${encodeURIComponent(uploadedAssetId)}`).catch(() => undefined);
      return;
    }
    if (saved) setProfileAvatarFile(null);
  }

  function editRole(role: CollectionRole) {
    setRoleDraft({
      id: role.id,
      name: role.name,
      color: role.color ?? "#655bf5",
      securityRank: String(role.securityRank),
      permissions: [...role.permissions],
      revision: role.revision,
      isManaged: role.isManaged,
    });
  }

  async function submitRole(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageRoles) return;
    const securityRank = Number(roleDraft.securityRank);
    if (!roleDraft.name.trim() || !Number.isInteger(securityRank) || securityRank < 0) {
      setError("Role name and a non-negative security rank are required.");
      return;
    }

    const saved = await runMutation(
      () => roleDraft.id
        ? updateCollectionRole(api, collection.id, roleDraft.id, {
            name: roleDraft.name.trim(),
            color: roleDraft.color || null,
            permissions: roleDraft.permissions,
            securityRank,
            expectedRevision: roleDraft.revision,
          })
        : createCollectionRole(api, collection.id, {
            name: roleDraft.name.trim(),
            color: roleDraft.color || null,
            permissions: roleDraft.permissions,
            securityRank,
          }),
      roleDraft.id ? "Role updated." : "Role created.",
    );
    if (saved) setRoleDraft(emptyRoleDraft());
  }

  async function removeRole(role: CollectionRole) {
    if (!canManageRoles || role.isManaged) return;
    if (!window.confirm(`Delete the ${role.name} role? Members will lose its permissions.`)) return;
    await runMutation(
      () => deleteCollectionRole(api, collection.id, role.id),
      "Role deleted.",
    );
  }

  async function assignRole(member: CollectionMember) {
    if (!canManageRoles) return;
    const roleId = assignmentByMember[member.userId];
    if (!roleId) return;
    const saved = await runMutation(
      () => assignCollectionRole(api, collection.id, roleId, member.userId),
      `Role assigned to ${memberLabel(member)}.`,
    );
    if (saved) {
      setAssignmentByMember((current) => {
        const next = { ...current };
        delete next[member.userId];
        return next;
      });
    }
  }

  async function unassignRole(member: CollectionMember, role: CollectionRole) {
    if (!canManageRoles || role.isManaged) return;
    await runMutation(
      () => unassignCollectionRole(api, collection.id, role.id, member.userId),
      `Role removed from ${memberLabel(member)}.`,
    );
  }

  async function removeMember(member: CollectionMember) {
    if (!canManageMembers || member.isOwner) return;
    if (!window.confirm(`Remove ${memberLabel(member)} from ${collection.name}?`)) return;
    await runMutation(
      () => removeCollectionMember(api, collection.id, member.userId),
      `${memberLabel(member)} was removed.`,
    );
  }

  async function transferOwnership() {
    if (!isOwner || !ownershipTargetUserId) return;
    const target = members.find((member) => member.userId === ownershipTargetUserId);
    if (!target) return;
    if (!window.confirm(
      `Transfer ownership of ${collection.name} to ${memberLabel(target)}? This takes effect immediately.`,
    )) return;
    const saved = await runMutation(
      () => transferCollectionOwnership(
        api,
        collection.id,
        target.userId,
        collection.revision ?? 1,
      ),
      `Ownership transferred to ${memberLabel(target)}.`,
    );
    if (saved) setOwnershipTargetUserId("");
  }

  async function leaveCurrentCollection() {
    if (isOwner) return;
    if (!window.confirm(
      `Leave ${collection.name}? Your global progress remains private, but you will lose access to this collection.`,
    )) return;
    const left = await runMutation(
      () => leaveCollection(api, collection.id),
      `You left ${collection.name}.`,
    );
    if (left) onClose();
  }

  async function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageInvites) return;
    const maxUses = inviteMaxUses.trim() ? Number(inviteMaxUses) : null;
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
      setError("Max uses must be a positive whole number.");
      return;
    }
    const expiration = inviteExpiresAt ? new Date(inviteExpiresAt) : null;
    if (expiration && Number.isNaN(expiration.valueOf())) {
      setError("Choose a valid invite expiration date.");
      return;
    }
    const expiresAt = expiration?.toISOString() ?? null;
    let createdToken: string | null = null;
    const saved = await runMutation(async () => {
      const response = await createCollectionInvite(api, collection.id, {
        expiresAt,
        maxUses,
        roleIds: inviteRoleIds,
      });
      createdToken = response.data.token;
    }, "Invite created. Copy its token now; it will not be listed again.");
    if (saved) {
      setCreatedInviteToken(createdToken);
      setInviteExpiresAt("");
      setInviteMaxUses("");
      setInviteRoleIds([]);
    }
  }

  async function revokeInvite(invite: CollectionInvite) {
    if (!canManageInvites || invite.revokedAt) return;
    if (!window.confirm("Revoke this invite? Existing members will not be affected.")) return;
    await runMutation(
      () => revokeCollectionInvite(api, collection.id, invite.id),
      "Invite revoked.",
    );
  }

  async function setLessonPublished(lesson: LessonSummary, publish: boolean) {
    if (!canPublishLessons) return;
    await runMutation(
      () => publish
        ? publishLesson(api, lesson.id, lesson.revision)
        : unpublishLesson(api, lesson.id, lesson.revision),
      publish ? "Lesson published." : "Lesson returned to draft.",
    );
  }

  async function showMemberProgress(member: CollectionMember) {
    if (!canViewProgress) return;
    const requestId = progressRequestId.current + 1;
    progressRequestId.current = requestId;
    setProgressMember(member);
    setProgressItems([]);
    setProgressCursor(null);
    setProgressDetails({});
    setProgressStats({});
    setProgressLoading(true);
    setProgressStatsLoading(true);
    setError(null);
    try {
      const response = await listMemberProgress(api, collection.id, member.userId);
      if (progressRequestId.current !== requestId) return;
      setProgressItems(response.data.items);
      setProgressCursor(response.data.nextCursor);
      const languages = [...new Set(response.data.items.map((item) => item.languageCode))];
      const stats = await Promise.all(
        languages.map((languageCode) => (
          getCollectionMemberLanguageStats(
            api,
            collection.id,
            member.userId,
            languageCode,
          ).then((result) => result.data)
        )),
      );
      if (progressRequestId.current !== requestId) return;
      setProgressStats(Object.fromEntries(stats.map((item) => [item.languageCode, item])));
    } catch (loadError) {
      if (progressRequestId.current === requestId) setError(apiErrorMessage(loadError));
    } finally {
      if (progressRequestId.current === requestId) {
        setProgressLoading(false);
        setProgressStatsLoading(false);
      }
    }
  }

  async function loadMoreProgress() {
    if (!progressMember || !progressCursor || !canViewProgress) return;
    setProgressLoading(true);
    setError(null);
    try {
      const response = await listMemberProgress(
        api,
        collection.id,
        progressMember.userId,
        progressCursor,
      );
      setProgressItems((current) => [...current, ...response.data.items]);
      setProgressCursor(response.data.nextCursor);
      const missingLanguages = [...new Set(
        response.data.items
          .map((item) => item.languageCode)
          .filter((languageCode) => !progressStats[languageCode]),
      )];
      if (missingLanguages.length) {
        const stats = await Promise.all(
          missingLanguages.map((languageCode) => (
            getCollectionMemberLanguageStats(
              api,
              collection.id,
              progressMember.userId,
              languageCode,
            ).then((result) => result.data)
          )),
        );
        setProgressStats((current) => ({
          ...current,
          ...Object.fromEntries(stats.map((item) => [item.languageCode, item])),
        }));
      }
    } catch (loadError) {
      setError(apiErrorMessage(loadError));
    } finally {
      setProgressLoading(false);
    }
  }

  async function loadProgressDetail(progressId: string) {
    if (!canViewAnswers || progressDetails[progressId]) return;
    setProgressDetails((current) => ({
      ...current,
      [progressId]: { loading: true },
    }));
    try {
      const response = await getProgressDetail(api, progressId);
      setProgressDetails((current) => ({
        ...current,
        [progressId]: {
          attempts: response.data.attempts ?? [],
          loading: false,
        },
      }));
    } catch (loadError) {
      setProgressDetails((current) => ({
        ...current,
        [progressId]: {
          error: apiErrorMessage(loadError),
          loading: false,
        },
      }));
    }
  }

  const roleById = new Map(roles.map((role) => [role.id, role]));
  const customRoles = roles.filter((role) => !role.isManaged);

  return (
    <AnimatedModal
      open
      onClose={onClose}
      labelledBy="collection-admin-title"
      backdropClassName="modal-backdrop collection-admin-backdrop"
      panelClassName="collection-admin-modal"
    >
      <div className="collection-admin-shell">
        <header className="collection-admin-header">
          <div>
            <p>Collection administration</p>
            <h2 id="collection-admin-title">{collection.name}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close collection administration" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="collection-admin-layout">
          <nav className="collection-admin-tabs" aria-label="Collection administration" role="tablist">
            {availableTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`collection-admin-tab-${tab.id}`}
                  aria-controls={`collection-admin-panel-${tab.id}`}
                  aria-selected={activeTab === tab.id}
                  className={activeTab === tab.id ? "is-active" : undefined}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={17} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          <main
            className="collection-admin-content"
            role="tabpanel"
            id={`collection-admin-panel-${activeTab}`}
            aria-labelledby={`collection-admin-tab-${activeTab}`}
          >
            {error ? <div className="collection-admin-message is-error" role="alert">{error}</div> : null}
            {notice ? <div className="collection-admin-message is-success" role="status">{notice}</div> : null}

            {loading ? (
              <div className="collection-admin-loading" role="status">
                <LoaderCircle className="spin" size={22} />
                <span>Loading {activeTab}…</span>
              </div>
            ) : null}

            {!loading && activeTab === "details" ? (
              <CollectionDetailsPanel
                collection={collection}
                learningProfile={learningProfile}
                onSave={onSaveDetails}
              />
            ) : null}

            {!loading && activeTab === "questions" ? (
              <CollectionQuestionSettingsPanel
                collection={{ ...collection, questionSettings }}
                profile={learningProfile}
                onSave={onSaveQuestionSettings}
              />
            ) : null}

            {!loading && activeTab === "units" ? (
              <section className="collection-admin-section" aria-labelledby="collection-units-title">
                <div className="collection-admin-section-heading">
                  <div>
                    <h3 id="collection-units-title">Recently deleted units</h3>
                    <p>Restore a unit and its retained content within the 30-day recovery window.</p>
                  </div>
                </div>
                <div className="collection-admin-card collection-admin-recovery-card">
                  <DeletedUnitsPanel
                    api={api}
                    collection={collection}
                    onRestored={async (unit) => {
                      await onRestoreDeletedUnit(unit.id);
                    }}
                  />
                </div>
              </section>
            ) : null}

            {!loading && activeTab === "members" ? (
              <section className="collection-admin-section" aria-labelledby="collection-members-title">
                <div className="collection-admin-section-heading">
                  <div>
                    <h3 id="collection-members-title">Members and profiles</h3>
                    <p>Collection profiles override display details here; usernames always come from the main profile.</p>
                  </div>
                  <span className="collection-admin-count">{members.length}</span>
                </div>

                <form className="collection-admin-card collection-admin-profile-form" onSubmit={submitProfile}>
                  <div className="collection-admin-card-heading">
                    <UserRound size={19} />
                    <div>
                      <h4>{profileTargetUserId ? "Member collection profile" : "Your collection profile"}</h4>
                      <p>Leave a field blank to clear that collection-specific override.</p>
                    </div>
                  </div>
                  <div className="collection-admin-form-grid">
                    {canManageCollectionProfiles ? (
                      <label className="collection-admin-form-wide">
                        Profile to edit
                        <select
                          value={profileTargetUserId}
                          onChange={(event) => setProfileTargetUserId(event.target.value)}
                        >
                          <option value="">My collection profile</option>
                          {members.filter((member) => member.userId !== currentUserId).map((member) => (
                            <option key={member.userId} value={member.userId}>
                              {memberLabel(member)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label>
                      Display name
                      <input
                        value={profileDisplayName}
                        maxLength={64}
                        placeholder="Collection display name"
                        onChange={(event) => setProfileDisplayName(event.target.value)}
                      />
                    </label>
                    <div className="collection-admin-form-wide collection-admin-avatar-field">
                      <label>
                        Avatar image
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={(event) => setProfileAvatarFile(event.target.files?.[0] ?? null)}
                        />
                        <small>
                          {profileAvatarFile?.name
                            ?? (profileAvatarAssetId ? "A private collection avatar is set." : "No collection avatar override.")}
                        </small>
                      </label>
                      {profileAvatarAssetId || profileAvatarFile ? (
                        <button
                          className="collection-profile-clear-avatar"
                          type="button"
                          onClick={() => {
                            setProfileAvatarAssetId("");
                            setProfileAvatarFile(null);
                          }}
                        >
                          Clear avatar
                        </button>
                      ) : null}
                    </div>
                    <label className="collection-admin-form-wide">
                      Bio
                      <textarea
                        value={profileBio}
                        maxLength={500}
                        rows={3}
                        placeholder="A short collection-specific bio"
                        onChange={(event) => setProfileBio(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="collection-admin-actions">
                    <button className="primary-button" type="submit" disabled={actionLoading}>
                      {actionLoading ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                      Save profile
                    </button>
                  </div>
                </form>

                <div className="collection-admin-list">
                  {members.map((member) => {
                    const assignedRoles = member.roleIds.flatMap((roleId) => {
                      const role = roleById.get(roleId);
                      return role ? [role] : [];
                    });
                    const assignableRoles = customRoles.filter((role) => !member.roleIds.includes(role.id));
                    return (
                      <article className="collection-admin-card collection-member-card" key={member.userId}>
                        <div className="collection-member-avatar" aria-hidden="true">
                          {(member.displayName || member.username || "?").slice(0, 1).toUpperCase()}
                        </div>
                        <div className="collection-member-main">
                          <div className="collection-admin-card-heading">
                            <div>
                              <h4>
                                {memberLabel(member)}
                                {member.isOwner ? <span className="collection-owner-badge">Owner</span> : null}
                              </h4>
                              <p>{member.username ? `@${member.username}` : "Username onboarding incomplete"}</p>
                            </div>
                            <time dateTime={member.joinedAt}>Joined {formatDate(member.joinedAt)}</time>
                          </div>
                          {member.bio ? <p className="collection-member-bio">{member.bio}</p> : null}
                          <div className="collection-role-badges" aria-label={`Roles for ${memberLabel(member)}`}>
                            {assignedRoles.length ? assignedRoles.map((role) => (
                              <span key={role.id} style={{ borderColor: role.color ?? undefined }}>
                                {role.name}
                                {canManageRoles && !role.isManaged ? (
                                  <button
                                    type="button"
                                    aria-label={`Remove ${role.name} from ${memberLabel(member)}`}
                                    disabled={actionLoading}
                                    onClick={() => void unassignRole(member, role)}
                                  >
                                    <X size={12} />
                                  </button>
                                ) : null}
                              </span>
                            )) : <small>No custom roles</small>}
                          </div>
                          {canManageRoles && assignableRoles.length ? (
                            <div className="collection-role-assignment">
                              <label>
                                <span className="visually-hidden">Role to assign to {memberLabel(member)}</span>
                                <select
                                  value={assignmentByMember[member.userId] ?? ""}
                                  onChange={(event) => setAssignmentByMember((current) => ({
                                    ...current,
                                    [member.userId]: event.target.value,
                                  }))}
                                >
                                  <option value="">Choose a role…</option>
                                  {assignableRoles.map((role) => (
                                    <option key={role.id} value={role.id}>{role.name}</option>
                                  ))}
                                </select>
                              </label>
                              <button
                                className="secondary-button"
                                type="button"
                                disabled={actionLoading || !assignmentByMember[member.userId]}
                                onClick={() => void assignRole(member)}
                              >
                                Assign
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <div className="collection-member-actions">
                          {canViewProgress ? (
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={() => void showMemberProgress(member)}
                            >
                              <FileClock size={15} />
                              Progress
                            </button>
                          ) : null}
                          {canManageMembers && !member.isOwner ? (
                            <button
                              className="collection-admin-danger"
                              type="button"
                              disabled={actionLoading}
                              onClick={() => void removeMember(member)}
                            >
                              <Trash2 size={15} />
                              Remove
                            </button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                  {!members.length ? <p className="collection-admin-empty">No members were returned.</p> : null}
                </div>

                <section className="collection-admin-card collection-ownership-card" aria-labelledby="collection-membership-title">
                  <div>
                    <h4 id="collection-membership-title">
                      {isOwner ? "Transfer ownership" : "Collection membership"}
                    </h4>
                    <p>
                      {isOwner
                        ? "Only an existing member can become owner. Transfer ownership before leaving the collection."
                        : "Leaving removes your membership and collection profile. Your private global learning stats remain."}
                    </p>
                  </div>
                  {isOwner ? (
                    <div className="collection-ownership-actions">
                      <label>
                        <span className="visually-hidden">New collection owner</span>
                        <select
                          value={ownershipTargetUserId}
                          onChange={(event) => setOwnershipTargetUserId(event.target.value)}
                        >
                          <option value="">Choose a new owner…</option>
                          {members
                            .filter((member) => member.userId !== currentUserId)
                            .map((member) => (
                              <option key={member.userId} value={member.userId}>
                                {memberLabel(member)}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={actionLoading || !ownershipTargetUserId}
                        onClick={() => void transferOwnership()}
                      >
                        Transfer ownership
                      </button>
                    </div>
                  ) : (
                    <button
                      className="collection-admin-danger"
                      type="button"
                      disabled={actionLoading}
                      onClick={() => void leaveCurrentCollection()}
                    >
                      Leave collection
                    </button>
                  )}
                </section>

                {progressMember ? (
                  <section className="collection-admin-progress" aria-labelledby="member-progress-title">
                    <div className="collection-admin-section-heading">
                      <div>
                        <h4 id="member-progress-title">Progress · {memberLabel(progressMember)}</h4>
                        <p>
                          {canViewAnswers
                            ? "Session summaries and authorized raw answers."
                            : "Session summaries only. Raw answers require a separate permission."}
                        </p>
                      </div>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label="Close member progress"
                        onClick={() => {
                          progressRequestId.current += 1;
                          setProgressMember(null);
                          setProgressDetails({});
                          setProgressStats({});
                        }}
                      >
                        <X size={17} />
                      </button>
                    </div>
                    {progressStatsLoading ? (
                      <div className="collection-admin-loading" role="status">
                        <LoaderCircle className="spin" size={18} />
                        Loading term statistics…
                      </div>
                    ) : null}
                    {Object.values(progressStats).map((stats) => (
                      <article className="collection-admin-card collection-language-stats" key={stats.languageCode}>
                        <div className="collection-admin-card-heading">
                          <div>
                            <h5>{stats.languageCode.toUpperCase()} term statistics</h5>
                            <p>Collection-only aggregate for this member.</p>
                          </div>
                          {stats.updatedAt ? (
                            <time dateTime={stats.updatedAt}>Updated {formatDate(stats.updatedAt)}</time>
                          ) : null}
                        </div>
                        <div className="collection-progress-summary">
                          <span><small>words</small><strong>{Object.keys(stats.words).length}</strong></span>
                          <span><small>phrases</small><strong>{Object.keys(stats.phrases).length}</strong></span>
                          <span><small>sentences</small><strong>{Object.keys(stats.sentences).length}</strong></span>
                          {summaryEntries(stats.aggregate).map(([key, value]) => (
                            <span key={key}><small>{readableAction(key)}</small><strong>{value}</strong></span>
                          ))}
                        </div>
                      </article>
                    ))}
                    {progressLoading && !progressItems.length ? (
                      <div className="collection-admin-loading" role="status">
                        <LoaderCircle className="spin" size={18} />
                        Loading progress…
                      </div>
                    ) : null}
                    <div className="collection-admin-list">
                      {progressItems.map((progress) => {
                        const detail = progressDetails[progress.id];
                        return (
                          <article className="collection-admin-card collection-progress-card" key={progress.id}>
                            <div className="collection-admin-card-heading">
                              <div>
                                <h5>{progress.status === "completed" ? "Completed session" : "In-progress session"}</h5>
                                <p>Lesson {progress.lessonId}</p>
                              </div>
                              <time dateTime={progress.startedAt}>{formatDate(progress.startedAt)}</time>
                            </div>
                            <div className="collection-progress-summary">
                              {summaryEntries(progress.summary).map(([key, value]) => (
                                <span key={key}><small>{readableAction(key)}</small><strong>{value}</strong></span>
                              ))}
                              {!summaryEntries(progress.summary).length ? <small>No summary metrics yet.</small> : null}
                            </div>
                            {canViewAnswers ? (
                              <details
                                onToggle={(event) => {
                                  if (event.currentTarget.open) void loadProgressDetail(progress.id);
                                }}
                              >
                                <summary>
                                  Raw answers
                                  {detail?.attempts ? ` (${detail.attempts.length})` : ""}
                                </summary>
                                {detail?.loading ? (
                                  <p role="status">Loading authorized answers…</p>
                                ) : null}
                                {detail?.error ? (
                                  <p className="collection-admin-inline-error" role="alert">{detail.error}</p>
                                ) : null}
                                {detail?.attempts?.length ? (
                                  <pre>{JSON.stringify(detail.attempts, null, 2)}</pre>
                                ) : null}
                                {detail && !detail.loading && !detail.error && !detail.attempts?.length ? (
                                  <p>No answer payloads were returned.</p>
                                ) : null}
                              </details>
                            ) : null}
                          </article>
                        );
                      })}
                      {!progressLoading && !progressItems.length ? (
                        <p className="collection-admin-empty">No progress sessions found for this member.</p>
                      ) : null}
                    </div>
                    {progressCursor ? (
                      <button
                        className="secondary-button collection-admin-load-more"
                        type="button"
                        disabled={progressLoading}
                        onClick={() => void loadMoreProgress()}
                      >
                        {progressLoading ? <LoaderCircle className="spin" size={15} /> : null}
                        Load more progress
                      </button>
                    ) : null}
                  </section>
                ) : null}
              </section>
            ) : null}

            {!loading && activeTab === "roles" ? (
              <section className="collection-admin-section" aria-labelledby="collection-roles-title">
                <div className="collection-admin-section-heading">
                  <div>
                    <h3 id="collection-roles-title">Collection roles</h3>
                    <p>Permissions only add capabilities. Security rank protects role hierarchy and is not UI ordering.</p>
                  </div>
                  {canManageRoles ? (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => setRoleDraft(emptyRoleDraft())}
                    >
                      <Plus size={16} />
                      New role
                    </button>
                  ) : null}
                </div>

                {canManageRoles ? (
                  <form className="collection-admin-card collection-role-form" onSubmit={submitRole}>
                    <div className="collection-admin-card-heading">
                      <Shield size={19} />
                      <div>
                        <h4>{roleDraft.id ? `Edit ${roleDraft.name}` : "Create a role"}</h4>
                        <p>The server enforces permission union and hierarchy limits.</p>
                      </div>
                    </div>
                    <div className="collection-admin-form-grid">
                      <label>
                        Role name
                        <input
                          required
                          maxLength={100}
                          disabled={roleDraft.isManaged}
                          value={roleDraft.name}
                          onChange={(event) => setRoleDraft((current) => ({ ...current, name: event.target.value }))}
                        />
                      </label>
                      <label>
                        Role color
                        <span className="collection-admin-color-input">
                          <input
                            type="color"
                            value={roleDraft.color}
                            onChange={(event) => setRoleDraft((current) => ({ ...current, color: event.target.value }))}
                          />
                          <code>{roleDraft.color}</code>
                        </span>
                      </label>
                      <label>
                        Security rank
                        <input
                          type="number"
                          min={0}
                          max={10_000}
                          required
                          disabled={roleDraft.isManaged}
                          value={roleDraft.securityRank}
                          onChange={(event) => setRoleDraft((current) => ({
                            ...current,
                            securityRank: event.target.value,
                          }))}
                        />
                      </label>
                    </div>
                    <fieldset className="collection-permission-grid">
                      <legend>Permissions</legend>
                      {PERMISSION_OPTIONS.map((permission) => (
                        <label key={permission.id}>
                          <input
                            type="checkbox"
                            checked={roleDraft.permissions.includes(permission.id)}
                            onChange={(event) => setRoleDraft((current) => ({
                              ...current,
                              permissions: event.target.checked
                                ? [...current.permissions, permission.id]
                                : current.permissions.filter((candidate) => candidate !== permission.id),
                            }))}
                          />
                          <span><strong>{permission.label}</strong><small>{permission.description}</small></span>
                        </label>
                      ))}
                    </fieldset>
                    <div className="collection-admin-actions">
                      {roleDraft.id ? (
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => setRoleDraft(emptyRoleDraft())}
                        >
                          Cancel edit
                        </button>
                      ) : null}
                      <button className="primary-button" type="submit" disabled={actionLoading}>
                        {actionLoading ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                        {roleDraft.id ? "Save role" : "Create role"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="collection-admin-readonly-note">You can inspect roles, but role management is not enabled for your profile.</p>
                )}

                <div className="collection-admin-list collection-role-list">
                  {roles.map((role) => (
                    <article className="collection-admin-card" key={role.id}>
                      <span className="collection-role-color" style={{ background: role.color ?? "var(--border)" }} />
                      <div className="collection-role-summary">
                        <div className="collection-admin-card-heading">
                          <div>
                            <h4>{role.name}{role.isManaged ? <span className="collection-managed-badge">Managed</span> : null}</h4>
                            <p>Security rank {role.securityRank} · revision {role.revision}</p>
                          </div>
                        </div>
                        <div className="collection-role-permissions">
                          {role.permissions.map((permission) => (
                            <span key={permission}>{readableAction(permission)}</span>
                          ))}
                          {!role.permissions.length ? <small>No permissions</small> : null}
                        </div>
                      </div>
                      {canManageRoles ? (
                        <div className="collection-admin-card-actions">
                          <button className="secondary-button" type="button" onClick={() => editRole(role)}>
                            <Pencil size={15} />
                            Edit
                          </button>
                          {!role.isManaged ? (
                            <button
                              className="collection-admin-danger"
                              type="button"
                              disabled={actionLoading}
                              onClick={() => void removeRole(role)}
                            >
                              <Trash2 size={15} />
                              Delete
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ))}
                  {!roles.length ? <p className="collection-admin-empty">No roles were returned.</p> : null}
                </div>
              </section>
            ) : null}

            {!loading && activeTab === "invites" && canManageInvites ? (
              <section className="collection-admin-section" aria-labelledby="collection-invites-title">
                <div className="collection-admin-section-heading">
                  <div>
                    <h3 id="collection-invites-title">Invites</h3>
                    <p>Create expiring, limited-use invitations. Only the token hash is stored by the server.</p>
                  </div>
                </div>

                <form className="collection-admin-card collection-invite-form" onSubmit={submitInvite}>
                  <div className="collection-admin-card-heading">
                    <Plus size={19} />
                    <div>
                      <h4>Create invite</h4>
                      <p>Selected roles are assigned atomically when the invite is accepted.</p>
                    </div>
                  </div>
                  <div className="collection-admin-form-grid">
                    <label>
                      Expires at
                      <input
                        type="datetime-local"
                        value={inviteExpiresAt}
                        onChange={(event) => setInviteExpiresAt(event.target.value)}
                      />
                    </label>
                    <label>
                      Max uses
                      <input
                        type="number"
                        min={1}
                        max={100_000}
                        placeholder="Unlimited"
                        value={inviteMaxUses}
                        onChange={(event) => setInviteMaxUses(event.target.value)}
                      />
                    </label>
                  </div>
                  <fieldset className="collection-invite-role-options">
                    <legend>Roles granted</legend>
                    {customRoles.map((role) => (
                      <label key={role.id}>
                        <input
                          type="checkbox"
                          checked={inviteRoleIds.includes(role.id)}
                          onChange={(event) => setInviteRoleIds((current) => event.target.checked
                            ? [...current, role.id]
                            : current.filter((roleId) => roleId !== role.id))}
                        />
                        <span>{role.name}</span>
                      </label>
                    ))}
                    {!customRoles.length ? <small>No custom roles are available.</small> : null}
                  </fieldset>
                  <div className="collection-admin-actions">
                    <button className="primary-button" type="submit" disabled={actionLoading}>
                      {actionLoading ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />}
                      Create invite
                    </button>
                  </div>
                </form>

                {createdInviteToken && createdInviteUrl ? (
                  <div className="collection-admin-token" role="status">
                    <div>
                      <strong>New invite link</strong>
                      <p>Copy it now. The secret token is not returned by the invite list.</p>
                    </div>
                    <code>{createdInviteUrl}</code>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void navigator.clipboard?.writeText(createdInviteUrl)}
                    >
                      <Clipboard size={15} />
                      Copy invite link
                    </button>
                  </div>
                ) : null}

                <div className="collection-admin-list">
                  {invites.map((invite) => {
                    const isExpired = Boolean(invite.expiresAt && new Date(invite.expiresAt) <= new Date());
                    const state = invite.revokedAt ? "Revoked" : isExpired ? "Expired" : "Active";
                    return (
                      <article className="collection-admin-card collection-invite-card" key={invite.id}>
                        <div>
                          <div className="collection-admin-card-heading">
                            <div>
                              <h4>Invite · {invite.tokenHint || invite.id.slice(0, 8)}</h4>
                              <p>{state} · {invite.usesCount}/{invite.maxUses ?? "∞"} uses</p>
                            </div>
                            <time dateTime={invite.createdAt}>{formatDate(invite.createdAt)}</time>
                          </div>
                          <div className="collection-role-badges">
                            {invite.roleIds.map((roleId) => (
                              <span key={roleId}>{roleById.get(roleId)?.name ?? roleId}</span>
                            ))}
                            {!invite.roleIds.length ? <small>No custom roles</small> : null}
                          </div>
                          <p className="collection-invite-expiry">Expires {formatDate(invite.expiresAt)}</p>
                        </div>
                        {!invite.revokedAt && !isExpired ? (
                          <button
                            className="collection-admin-danger"
                            type="button"
                            disabled={actionLoading}
                            onClick={() => void revokeInvite(invite)}
                          >
                            <Trash2 size={15} />
                            Revoke
                          </button>
                        ) : null}
                      </article>
                    );
                  })}
                  {!invites.length ? <p className="collection-admin-empty">No invites have been created.</p> : null}
                </div>
              </section>
            ) : null}

            {!loading && activeTab === "audit" && permissions.has("view_audit_log") ? (
              <section className="collection-admin-section" aria-labelledby="collection-audit-title">
                <div className="collection-admin-section-heading">
                  <div>
                    <h3 id="collection-audit-title">Audit log</h3>
                    <p>Append-only collection security and content events, newest first.</p>
                  </div>
                </div>
                <ol className="collection-audit-list">
                  {auditEvents.map((event) => (
                    <li className="collection-admin-card" key={event.id}>
                      <span className="collection-audit-icon"><ScrollText size={16} /></span>
                      <div>
                        <div className="collection-admin-card-heading">
                          <div>
                            <h4>{readableAction(event.action)}</h4>
                            <p>
                              {event.targetType ? `${event.targetType}${event.targetId ? ` · ${event.targetId}` : ""}` : "Collection event"}
                            </p>
                          </div>
                          <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                        </div>
                        <p className="collection-audit-actor">
                          Actor {event.actorUserId ?? "deleted user"}
                        </p>
                        {Object.keys(event.metadata).length ? (
                          <details>
                            <summary>Event metadata</summary>
                            <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                          </details>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
                {!auditEvents.length ? <p className="collection-admin-empty">No audit events were returned.</p> : null}
              </section>
            ) : null}

            {!loading && activeTab === "lessons" ? (
              <section className="collection-admin-section" aria-labelledby="collection-lessons-title">
                <div className="collection-admin-section-heading">
                  <div>
                    <h3 id="collection-lessons-title">Lessons</h3>
                    <p>
                      {canPublishLessons
                        ? "Review collection drafts and control publication status."
                        : "Published lessons and drafts visible to your account."}
                    </p>
                  </div>
                  <span className="collection-admin-count">{lessons.length}</span>
                </div>
                <div className="collection-admin-list collection-lesson-list">
                  {lessons.map((lesson) => (
                    <article className="collection-admin-card" key={lesson.id}>
                      <span className={`collection-lesson-status is-${lesson.status}`}>
                        {lesson.status}
                      </span>
                      <div className="collection-role-summary">
                        <div className="collection-admin-card-heading">
                          <div>
                            <h4>{lesson.title}</h4>
                            <p>{lesson.languageCode} · unit revision {lesson.unitRevision}</p>
                          </div>
                          <time dateTime={lesson.createdAt}>{formatDate(lesson.createdAt)}</time>
                        </div>
                        <p className="collection-lesson-meta">
                          Owner {lesson.ownerId} · revision {lesson.revision}
                        </p>
                      </div>
                      {canPublishLessons ? (
                        <button
                          className={lesson.status === "published" ? "secondary-button" : "primary-button"}
                          type="button"
                          disabled={actionLoading}
                          onClick={() => void setLessonPublished(lesson, lesson.status === "draft")}
                        >
                          {actionLoading ? <LoaderCircle className="spin" size={15} /> : null}
                          {lesson.status === "published" ? "Unpublish" : "Publish"}
                        </button>
                      ) : null}
                    </article>
                  ))}
                  {!lessons.length ? <p className="collection-admin-empty">No lessons were returned.</p> : null}
                </div>
              </section>
            ) : null}

            {!loading && nextCursors[activeTab] ? (
              <button
                className="secondary-button collection-admin-load-more"
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? <LoaderCircle className="spin" size={15} /> : null}
                Load more
              </button>
            ) : null}
          </main>
        </div>
      </div>
    </AnimatedModal>
  );
}
