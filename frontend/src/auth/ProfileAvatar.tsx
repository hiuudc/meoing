import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client";
import { authorizeFileDownload } from "../api/files";

interface ProfileAvatarProps {
  api: ApiClient | null;
  assetId?: string | null;
  displayName: string;
  file?: File | null;
  className?: string;
}

export function ProfileAvatar({
  api,
  assetId,
  displayName,
  file,
  className = "profile-avatar",
}: ProfileAvatarProps) {
  const [source, setSource] = useState<string | null>(null);
  const initial = displayName.trim().charAt(0).toUpperCase() || "M";

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSource(null);
    if (file) {
      objectUrl = URL.createObjectURL(file);
      setSource(objectUrl);
    } else if (api && assetId) {
      void authorizeFileDownload(api, assetId)
        .then((url) => {
          if (active) setSource(url);
        })
        .catch(() => {
          if (active) setSource(null);
        });
    }
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, assetId, file]);

  return (
    <span className={className} aria-hidden="true">
      {source ? <img src={source} alt="" onError={() => setSource(null)} /> : initial}
    </span>
  );
}
