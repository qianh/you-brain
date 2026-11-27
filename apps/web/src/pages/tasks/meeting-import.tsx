import { useCallback, useEffect, useRef, useState } from "react";
import {
  MEETING_IMPORT_MAX_BYTES, type MeetingImportAction, type MeetingImportView, type MeetingTodoDraft,
  type TaskBoard, type TaskPriority, type TaskProject,
} from "@you-brain/core/tasks/types.js";

import { BrowserDaemonError } from "../../api/client.js";
import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Dialog } from "../../components/dialog.js";
import { Icon } from "../../components/icons.js";
import { Textarea } from "../../components/input.js";
import { Select } from "../../components/select.js";
import { Spinner } from "../../components/spinner.js";
import { useDaemon } from "../../daemon-context.js";
import { TASK_PRIORITY_KEYS } from "./logic.js";
import { ProjectPicker } from "./project-picker.js";

type Selection = Pick<MeetingTodoDraft, "id" | "projectId" | "relatedProjectIds" | "priority" | "selected">;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function MeetingImportDialog({ projects, onClose, onCreated }: {
  projects: TaskProject[];
  onClose: () => void;
  onCreated: (board: TaskBoard, count: number) => void;
}) {
  const { client, t } = useDaemon();
  const [view, setView] = useState<MeetingImportView | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<{ fileName: string; text: string } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [bulkProject, setBulkProject] = useState("");
  const [busy, setBusy] = useState<MeetingImportAction["action"] | "read" | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const working = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const draft = view?.draft;
  const consentKey = view?.model?.consentKey;
  const selected = draft?.items.filter((item) => item.selected).length ?? 0;
  const projectOptions = [{ value: "", label: t("tasksUnassigned") }, ...projects.map((project) => ({ value: project.id, label: project.name }))];
  const priorityOptions = TASK_PRIORITY_KEYS.map((key, index) => ({ value: String(index), label: t(key) }));

  const refresh = useCallback(async () => {
    setView(await client.meetingImport());
  }, [client]);

  useEffect(() => {
    let active = true;
    client.meetingImport().then((result) => { if (active) setView(result); })
      .catch((error: unknown) => { if (active) setError(errorMessage(error)); });
    return () => { active = false; };
  }, [client]);

  const loadFile = async (files: FileList | null) => {
    if (!files?.length || working.current || draft) return;
    working.current = true;
    setBusy("read");
    setError("");
    setFile(null);
    try {
      const selectedFile = files[0];
      if (files.length !== 1 || !selectedFile || !/\.(?:md|txt)$/iu.test(selectedFile.name) || selectedFile.size > MEETING_IMPORT_MAX_BYTES) {
        throw new Error();
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await selectedFile.arrayBuffer());
      if (!text.trim() || text.includes("\0")) throw new Error();
      setFile({ fileName: selectedFile.name, text });
    } catch {
      setError(t("tasksMeetingFileInvalid"));
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const send = async (action: MeetingImportAction) => {
    if (working.current) return;
    working.current = true;
    setBusy(action.action);
    setError("");
    try {
      let result = await client.meetingImportAction(action);
      setView(result);
      if (action.action === "import" && consentKey && result.draft) {
        setFile(null);
        setBusy("analyse");
        const { id, revision } = result.draft;
        result = await client.meetingImportAction({ action: "analyse", id, revision, consentKey });
        setView(result);
      }
      if (action.action === "revise" || action.action === "discard") setFeedback("");
      if (action.action === "discard") setDiscarding(false);
      if (result.created) onCreated(result.created.board, result.created.count);
    } catch (error) {
      if (error instanceof BrowserDaemonError && (error.status === 409 || error.status === 503)) {
        await refresh().catch(() => undefined);
      }
      setError(errorMessage(error));
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const select = (change: (item: Selection) => Selection) => {
    if (!draft) return;
    const items = draft.items.map(({ id, projectId, relatedProjectIds, priority, selected: checked }) => change({ id, projectId, relatedProjectIds, priority, selected: checked }));
    void send({ action: "select", id: draft.id, revision: draft.revision, items });
  };

  const analyse = () => {
    if (!consentKey) return;
    if (draft) void send({ action: "analyse", id: draft.id, revision: draft.revision, consentKey });
    else if (file) void send({ action: "import", ...file });
  };

  const disabled = busy !== null || discarding;
  return <Dialog open size="lg" className="tasks-meeting-dialog" title={t("tasksMeetingImport")}
    onClose={() => { if (!working.current) onClose(); }} footer={<>
      {draft?.analysed && selected > 0 && !discarding && <p className="tasks-meeting-muted tasks-meeting-queue-hint">{t("tasksMeetingQueueHint")}</p>}
      {draft && !discarding && <Button variant="ghost" disabled={busy !== null} onClick={() => setDiscarding(true)} icon={<Icon name="trash" />}>{t("tasksMeetingDiscard")}</Button>}
      <div className="tasks-meeting-footer">
        {discarding ? <>
          <Button variant="ghost" disabled={busy !== null} onClick={() => setDiscarding(false)}>{t("cancel")}</Button>
          <Button variant="danger" loading={busy === "discard"} onClick={() => {
            if (draft) void send({ action: "discard", id: draft.id, revision: draft.revision });
          }}>{t("tasksMeetingDiscard")}</Button>
        </> : <>
          <Button variant="ghost" disabled={busy !== null} onClick={onClose}>{t("tasksMeetingClose")}</Button>
          {draft?.analysed ? <Button variant="primary" loading={busy === "confirm"} disabled={disabled || !selected}
            onClick={() => void send({ action: "confirm", id: draft.id, revision: draft.revision })}>{t("tasksMeetingConfirm", { count: selected })}</Button>
            : <Button variant="primary" loading={busy === "analyse" || busy === "import"} disabled={disabled || !view || !(file || draft) || !consentKey}
              onClick={analyse}>{t("tasksMeetingAnalyse")}</Button>}
        </>}
      </div>
    </>}>
    <div className="tasks-meeting-content">
      {error && <Banner tone="danger" action={!view ? <Button size="sm" onClick={() => {
        setError("");
        void refresh().catch((error: unknown) => setError(errorMessage(error)));
      }}>{t("retry")}</Button> : undefined}>{error}</Banner>}
      {!view && !error && <div className="tasks-loading" role="status"><Spinner /></div>}
      {view && <>
        {!draft && <div className="tasks-meeting-drop" onDragOver={(event) => { event.preventDefault(); }}
          onDrop={(event) => { event.preventDefault(); void loadFile(event.dataTransfer.files); }}>
          <input ref={picker} type="file" accept=".md,.txt" hidden onChange={(event) => {
            void loadFile(event.currentTarget.files);
            event.currentTarget.value = "";
          }} />
          <Button disabled={disabled} onClick={() => picker.current?.click()} icon={<Icon name="folder" />}>{t("tasksMeetingFile")}</Button>
          <span>{file?.fileName ?? t("tasksMeetingFileHint")}</span>
        </div>}
        {draft && <div className="tasks-meeting-file"><Icon name="file" /><strong>{draft.fileName}</strong></div>}
        {!draft?.analysed && draft && <p className="tasks-meeting-muted">{t("tasksMeetingPending")}</p>}
        {busy === "analyse" && <div className="tasks-meeting-status" role="status"><Spinner />{t("tasksMeetingAnalysing")}</div>}
        {discarding && <Banner tone="warn">{t("tasksMeetingDiscardHint")}</Banner>}
        {draft?.analysed && <div className="tasks-meeting-review">
          <section aria-label={t("tasksMeetingItems")}>
            <div className="tasks-meeting-heading">
              <h3>{t("tasksMeetingItems")}</h3><span>{t("tasksMeetingSelected", { count: selected })}</span>
            </div>
            {draft.items.length > 0 ? <>
              {projects.length > 0 && <div className="tasks-meeting-bulk">
                <Select label={t("tasksMeetingBulkProject")} value={bulkProject} onChange={setBulkProject} disabled={disabled || !selected} options={projectOptions} />
                <Button size="sm" disabled={disabled || !selected} onClick={() => select((item) => item.selected ? { ...item, projectId: bulkProject || null, relatedProjectIds: [] } : item)}>{t("tasksMeetingApplyProject")}</Button>
              </div>}
              <ol className="tasks-meeting-items">
                {draft.items.map((item, index) => <li key={item.id}>
                  <label className="tasks-meeting-item-title">
                    <input type="checkbox" checked={item.selected} disabled={disabled} aria-label={t("tasksMeetingInclude", { title: item.title })}
                      onChange={(event) => { const checked = event.currentTarget.checked; select((row) => row.id === item.id ? { ...row, selected: checked } : row); }} />
                    <small>{String(index + 1).padStart(2, "0")}</small><strong>{item.title}</strong>
                  </label>
                  <p>{item.description}</p>
                  {item.quote ? <details><summary>{t("tasksMeetingSource")}</summary><blockquote>{item.quote}</blockquote></details>
                    : <small>{t("tasksMeetingUserSource")}</small>}
                  <div className="tasks-meeting-item-controls">
                    <ProjectPicker projects={projects} value={{ projectId: item.projectId ?? "", relatedProjectIds: item.relatedProjectIds }} allowNew={false}
                      onChange={(value) => { if ("projectId" in value) select((row) => row.id === item.id
                        ? { ...row, projectId: value.projectId || null, relatedProjectIds: value.relatedProjectIds ?? [] } : row); }} disabled={disabled} />
                    <Select label={`${t("tasksPriority")} · ${index + 1}`} value={String(item.priority)} onChange={(value) => select((row) => row.id === item.id ? { ...row, priority: Number(value) as TaskPriority } : row)} disabled={disabled} options={priorityOptions} />
                  </div>
                </li>)}
              </ol>
            </> : <p className="tasks-meeting-muted">{t("tasksMeetingNoItems")}</p>}
          </section>
          <aside className="tasks-meeting-feedback">
            {draft.questions.length > 0 && <section className="tasks-meeting-questions">
              <h3>{t("tasksMeetingQuestions")}</h3>
              <ul>{draft.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
            </section>}
            <form onSubmit={(event) => {
              event.preventDefault();
              if (consentKey && feedback.trim()) void send({ action: "revise", id: draft.id, revision: draft.revision, consentKey, feedback: feedback.trim() });
            }}>
              {draft.clarification && <Banner tone="warn">{draft.clarification}</Banner>}
              {draft.message && <p className="tasks-meeting-muted" role="status">{draft.message}</p>}
              <label>{t("tasksMeetingEdit")}<Textarea rows={4} maxLength={3000} value={feedback} disabled={disabled || !consentKey} placeholder={t("tasksMeetingEditPlaceholder")} onChange={(event) => setFeedback(event.currentTarget.value)} /></label>
              <Button type="submit" loading={busy === "revise"} disabled={disabled || !feedback.trim() || !consentKey}>{t("tasksMeetingRevise")}</Button>
              {busy === "revise" && <span className="tasks-meeting-muted" role="status">{t("tasksMeetingRevising")}</span>}
              <p className="tasks-meeting-muted">{consentKey && view.model ? t("tasksMeetingModel", { model: view.model.name }) : t("tasksMeetingNoModel")}</p>
            </form>
          </aside>
        </div>}
        {!draft?.analysed && <p className="tasks-meeting-muted">{consentKey && view.model ? t("tasksMeetingModel", { model: view.model.name }) : t("tasksMeetingNoModel")}</p>}
      </>}
    </div>
  </Dialog>;
}
