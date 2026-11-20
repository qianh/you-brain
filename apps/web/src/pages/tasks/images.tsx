import { useEffect, useState } from "react";
import type { TaskImage } from "@you-brain/core/tasks/types.js";
import { useDaemon } from "../../daemon-context.js";
import { Skeleton } from "../../components/skeleton.js";

export function clipboardTaskImages(data: Pick<DataTransfer, "files" | "items"> | null): File[] {
  if (!data) return [];
  const images = [...data.files].filter((file) => file.type.startsWith("image/"));
  if (images.length) return images;
  return [...data.items].filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => { const file = item.getAsFile(); return file ? [file] : []; });
}

export function TaskImagePreview({ image, taskId }: { image: TaskImage | File; taskId?: string }) {
  const { client, t } = useDaemon();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setUrl(null);
    setFailed(false);
    const load = image instanceof File ? Promise.resolve(image) : taskId ? client.taskImage(taskId, image.id) : Promise.reject();
    void load.then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }, () => { if (!disposed) setFailed(true); });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, image, taskId]);
  if (failed) return <span className="tasks-image-unavailable">{t("tasksImageUnavailable")}</span>;
  if (!url) return <Skeleton width="100%" height={64} />;
  return <img src={url} alt={image.name} onError={() => setFailed(true)} />;
}
