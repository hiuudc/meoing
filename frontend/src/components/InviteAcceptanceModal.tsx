import { Check, LoaderCircle, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  acceptCollectionInvite,
  previewCollectionInvite,
  type InviteAcceptance,
  type InvitePreview,
} from "../api/collectionAdmin";
import { apiErrorMessage, type ApiClient } from "../api/client";
import { Turnstile } from "../auth/Turnstile";
import { AnimatedModal } from "./AnimatedModal";

interface InviteAcceptanceModalProps {
  api: ApiClient;
  token: string;
  turnstileSiteKey?: string;
  onAccepted: (collection: InviteAcceptance) => void | Promise<void>;
  onClose: () => void;
}

export function InviteAcceptanceModal({
  api,
  token,
  turnstileSiteKey,
  onAccepted,
  onClose,
}: InviteAcceptanceModalProps) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [challengeRevision, setChallengeRevision] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [actionError, setActionError] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const previewAttemptRef = useRef("");

  useEffect(() => {
    if (preview || previewError) return;
    if (turnstileSiteKey && !challengeToken) return;
    const attemptKey = `${token}:${challengeToken ?? `local-${challengeRevision}`}`;
    if (previewAttemptRef.current === attemptKey) return;
    previewAttemptRef.current = attemptKey;
    let active = true;
    setLoadingPreview(true);
    void previewCollectionInvite(api, token, challengeToken ?? "")
      .then((response) => {
        if (!active) return;
        setLoadingPreview(false);
        setPreview(response.data);
        setChallengeToken(null);
        setChallengeRevision((revision) => revision + 1);
      })
      .catch((error) => {
        if (!active) return;
        setLoadingPreview(false);
        setPreviewError(apiErrorMessage(error));
        setChallengeToken(null);
        if (turnstileSiteKey) setChallengeRevision((revision) => revision + 1);
      });
    return () => {
      active = false;
      if (previewAttemptRef.current === attemptKey) previewAttemptRef.current = "";
    };
  }, [
    api,
    challengeRevision,
    challengeToken,
    preview,
    previewError,
    token,
    turnstileSiteKey,
  ]);

  async function acceptInvite() {
    if (turnstileSiteKey && !challengeToken) return;
    setAccepting(true);
    setActionError("");
    try {
      const response = await acceptCollectionInvite(api, token, challengeToken ?? "");
      await onAccepted(response.data);
    } catch (error) {
      setActionError(apiErrorMessage(error));
      setChallengeToken(null);
      setChallengeRevision((revision) => revision + 1);
    } finally {
      setAccepting(false);
    }
  }

  function retryPreview() {
    setPreviewError("");
    setChallengeToken(null);
    setChallengeRevision((revision) => revision + 1);
  }

  return (
    <AnimatedModal
      open
      onClose={onClose}
      labelledBy="invite-acceptance-title"
      backdropClassName="modal-backdrop"
      panelClassName="invite-acceptance-modal"
    >
      <header className="modal-header">
        <div>
          <p>Collection invitation</p>
          <h2 id="invite-acceptance-title">Join a Meoing collection</h2>
        </div>
        <button type="button" aria-label="Close invitation" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <div className="invite-acceptance-body">
        {!preview ? (
          <>
            <div className="invite-acceptance-symbol" aria-hidden="true"><Users size={25} /></div>
            {loadingPreview ? (
              <p className="invite-acceptance-status" role="status">
                <LoaderCircle className="spin" size={17} /> Checking this invitation…
              </p>
            ) : previewError ? (
              <div className="collection-admin-message is-error" role="alert">{previewError}</div>
            ) : (
              <p>Complete the abuse check to preview this invitation.</p>
            )}
            {previewError ? (
              <button className="secondary-button" type="button" onClick={retryPreview}>
                Try again
              </button>
            ) : null}
          </>
        ) : (
          <section className="invite-acceptance-preview">
            <div className="invite-acceptance-symbol" aria-hidden="true"><Users size={25} /></div>
            <h3>{preview.collection.name}</h3>
            {preview.collection.description ? <p>{preview.collection.description}</p> : null}
            <dl>
              <div>
                <dt>Expires</dt>
                <dd>{preview.expiresAt ? new Date(preview.expiresAt).toLocaleString() : "Never"}</dd>
              </div>
              <div>
                <dt>Uses remaining</dt>
                <dd>{preview.remainingUses ?? "Unlimited"}</dd>
              </div>
            </dl>
            {actionError ? <div className="collection-admin-message is-error" role="alert">{actionError}</div> : null}
          </section>
        )}

        <Turnstile
          key={challengeRevision}
          siteKey={turnstileSiteKey}
          onToken={setChallengeToken}
        />

        <footer className="invite-acceptance-actions">
          <button className="secondary-button" type="button" disabled={accepting} onClick={onClose}>
            Not now
          </button>
          {preview ? (
            <button
              className="primary-button"
              type="button"
              disabled={accepting || Boolean(turnstileSiteKey && !challengeToken)}
              onClick={() => void acceptInvite()}
            >
              {accepting ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              Accept invitation
            </button>
          ) : null}
        </footer>
      </div>
    </AnimatedModal>
  );
}

export type { InviteAcceptanceModalProps };
