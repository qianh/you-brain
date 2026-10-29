import { useEffect, useRef, useState } from "react";

import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/dialog.js";
import { EmptyState } from "../components/empty.js";
import { Page, PageHeader } from "../components/page.js";
import { SkeletonRow } from "../components/skeleton.js";
import { useDelayed } from "../components/use-delayed.js";
import { useDaemon } from "../daemon-context.js";
import { settingsHref, type SettingsSection } from "../lib/route.js";
import { useRoute } from "../router.js";
import { AccountSection } from "./settings/account.js";
import { AppearanceSection } from "./settings/appearance.js";
import { CaptureSection } from "./settings/capture.js";
import { ConsolidationSection } from "./settings/consolidation.js";
import { IntegrationsSection } from "./settings/integrations.js";
import { settingsNavItem } from "./settings/meta.js";
import { DevicesPage } from "./devices.js";
import { ModelSection } from "./settings/model.js";
import { PortraitPage } from "./portrait.js";
import { StatusPage } from "./status.js";
import { OAuthClientSection } from "./settings/oauth.js";
import { SettingsNav } from "./settings/nav.js";
import { PortraitSection } from "./settings/portrait.js";
import { RefineSection } from "./settings/refine.js";
import { SaveBar } from "./settings/save-bar.js";
import { useSettingsDraft } from "./settings/use-draft.js";
import { useLeaveGuard } from "./settings/use-leave-guard.js";

export function SettingsPage() {
  const { t, config, error: loadError, reload } = useDaemon();
  const { location, navigate } = useRoute();
  const section = location.section;
  const draftApi = useSettingsDraft();
  const { draft, rolesDraft, dirty, busy, error, save, revert } = draftApi;
  const mainRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const { allowNext } = useLeaveGuard(dirty, setPending);
  const pendingLoad = !draft || !rolesDraft;
  const showSkeleton = useDelayed(pendingLoad && !loadError, 150);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [section]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (dirty) void save().then((ok) => {
        if (ok) setPending(null);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  const openSection = (next: SettingsSection): void => {
    navigate(settingsHref(next));
  };

  const confirmLeave = (): void => {
    const href = pending;
    if (!href) return;
    setPending(null);
    revert();
    allowNext();
    navigate(href);
  };

  const meta = settingsNavItem(section);

  return (
    <Page>
      <div className="settings-page">
        <PageHeader title={t("settings")} description={t("settingsLead")} />
        <div className="settings-layout">
          <SettingsNav section={section} onOpen={openSection} />
          <div
            id="settings-panel"
            role="tabpanel"
            ref={mainRef}
            className={dirty ? "settings-main has-dirty" : "settings-main"}
          >
            {pendingLoad ? (
              loadError ? (
                <EmptyState
                  icon="alert-circle"
                  title={t("settingsLoadTitle")}
                  description={loadError || t("settingsLoadBody")}
                  action={<Button onClick={() => void reload()}>{t("retry")}</Button>}
                />
              ) : showSkeleton ? (
                <div className="card" aria-hidden="true">
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                </div>
              ) : (
                <div className="settings-hold" />
              )
            ) : draft && rolesDraft ? (
              <>
                <header className="settings-section-head">
                  <h2>{t(meta.label)}</h2>
                  <p>{t(meta.hint)}</p>
                </header>
                <SectionBody section={section} draftApi={draftApi} savedProvider={config?.llm.provider ?? draft.llm.provider} />
              </>
            ) : null}
            {dirty ? (
              <SaveBar
                container={mainRef}
                busy={busy}
                error={error}
                onRevert={() => {
                  setPending(null);
                  revert();
                }}
                onSave={() => {
                  void save().then((ok) => {
                    if (ok) setPending(null);
                  });
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={pending !== null}
        tone="danger"
        title={t("settingsDiscardTitle")}
        description={t("settingsDiscardBody")}
        confirmLabel={t("settingsDiscard")}
        cancelLabel={t("settingsStay")}
        onClose={() => setPending(null)}
        onConfirm={confirmLeave}
      />
    </Page>
  );
}

function SectionBody({
  section,
  draftApi,
  savedProvider,
}: {
  section: SettingsSection;
  draftApi: ReturnType<typeof useSettingsDraft>;
  savedProvider: string;
}) {
  const { draft, rolesDraft } = draftApi;
  // 这三页不依赖设置草稿,直接渲染迁移过来的页面内容。
  if (section === "status") return <StatusPage embedded />;
  if (section === "devices") return <DevicesPage embedded />;
  if (!draft || !rolesDraft) return null;
  if (section === "portrait") {
    return (
      <>
        <PortraitPage embedded />
        <PortraitSection
          draft={draft}
          issues={draftApi.issues}
          onDraft={draftApi.editDraft}
        />
      </>
    );
  }
  if (section === "account") {
    return (
      <>
        <AccountSection draft={draft} issues={draftApi.issues} onDraft={draftApi.editDraft} />
        <OAuthClientSection />
      </>
    );
  }
  if (section === "model") {
    return (
      <ModelSection
        draft={draft}
        savedProvider={savedProvider}
        issues={draftApi.issues}
        apiKey={draftApi.apiKey}
        replacingKey={draftApi.replacingKey}
        stored={draftApi.storedKeys.has(draft.llm.provider)}
        onDraft={draftApi.editDraft}
        onApiKey={draftApi.editApiKey}
        onReplace={() => draftApi.setReplacingKey(true)}
        onStored={draftApi.markKeyStored}
      />
    );
  }
  if (section === "capture") return <CaptureSection draft={draft} onDraft={draftApi.editDraft} />;
  if (section === "refine") return <RefineSection draft={draft} issues={draftApi.issues} onDraft={draftApi.editDraft} />;
  if (section === "consolidation") {
    return (
      <ConsolidationSection
        draft={draft}
        roles={rolesDraft}
        issues={draftApi.issues}
        onDraft={draftApi.editDraft}
        onRoles={draftApi.editRoles}
      />
    );
  }
  if (section === "integrations") return <IntegrationsSection draft={draft} onDraft={draftApi.editDraft} />;
  return <AppearanceSection draft={draft} onAppearance={draftApi.persistAppearance} />;
}
