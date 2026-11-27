import { useEffect, useState } from "react";
import { isTaskImageAttachment, isTaskImageMime, type TaskImage } from "@you-brain/core/tasks/types.js";
import { useDaemon } from "../../daemon-context.js";
import { Button } from "../../components/button.js";
import { Icon } from "../../components/icons.js";
import { Skeleton } from "../../components/skeleton.js";
import { formatAttachmentSize } from "./logic.js";

export function clipboardTaskImages(data: Pick<DataTransfer, "files" | "items"> | null): File[] {
  if (!data) return [];
  const files = [...data.files].filter((file) => file.type.startsWith("image/"));
  if (files.length) return files;
  return [...data.items].filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => { const file = item.getAsFile(); return file ? [file] : []; });
}

export function isAttachmentPreviewableImage(item: TaskImage | File): boolean {
  if (item instanceof File) return isTaskImageMime(item.type);
  return isTaskImageAttachment(item);
}

export function TaskImagePreview({ image, taskId, deviceId }: { image: TaskImage | File; taskId?: string; deviceId?: string | null | undefined }) {
  const { client, t } = useDaemon();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const previewable = isAttachmentPreviewableImage(image);

  useEffect(() => {
    if (!previewable) return;
    let disposed = false;
    let objectUrl: string | undefined;
    setUrl(null);
    setFailed(false);
    const load = image instanceof File
      ? Promise.resolve(image)
      : taskId
        ? client.taskImage(taskId, image.id, deviceId)
        : Promise.reject();
    void load.then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }, () => { if (!disposed) setFailed(true); });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, image, taskId, deviceId, previewable]);

  if (!previewable) {
    const size = image instanceof File ? image.size : image.sizeBytes;
    return (
      <div className="tasks-file-tile" title={`${image.name} (${formatAttachmentSize(size)})`}>
        <Icon name="file" size={18} />
        <span className="tasks-file-tile-name">{image.name}</span>
        <small>{formatAttachmentSize(size)}</small>
      </div>
    );
  }
  if (failed) return <span className="tasks-image-unavailable">{t("tasksImageUnavailable")}</span>;
  if (!url) return <Skeleton width="100%" height={64} />;
  return <img src={url} alt={image.name} onError={() => setFailed(true)} />;
}

export function TaskAttachmentCard({
  image,
  taskId,
  deviceId,
}: {
  image: TaskImage;
  taskId: string;
  deviceId?: string | null;
}) {
  const { client, t } = useDaemon();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isImg = isAttachmentPreviewableImage(image);

  const download = async (): Promise<void> => {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const blob = await client.taskImage(taskId, image.id, deviceId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = image.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError(t("tasksAttachmentDownloadFailed"));
    } finally {
      setDownloading(false);
    }
  };

  if (isImg) {
    return (
      <figure>
        <TaskImagePreview image={image} taskId={taskId} deviceId={deviceId} />
        <figcaption className="tasks-attachment-caption">
          <span>{image.name} ({formatAttachmentSize(image.sizeBytes)})</span>
          <Button size="sm" variant="ghost" loading={downloading} onClick={() => void download()}>
            {t("tasksDownloadAttachment")}
          </Button>
        </figcaption>
        {error ? <small className="tasks-image-unavailable">{error}</small> : null}
      </figure>
    );
  }

  return (
    <div className="tasks-attachment-row">
      <div className="tasks-attachment-row-meta">
        <Icon name="file" size={16} />
        <span className="tasks-attachment-row-name">{image.name}</span>
        <small>{formatAttachmentSize(image.sizeBytes)}</small>
      </div>
      <Button size="sm" variant="secondary" loading={downloading} onClick={() => void download()}>
        {t("tasksDownloadAttachment")}
      </Button>
      {error ? <small className="tasks-image-unavailable">{error}</small> : null}
    </div>
  );
}
