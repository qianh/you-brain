import { useCallback, useEffect, useState } from "react";

import type {
  DispatchDevicesResponse,
  DispatchOutboxEntry,
  DispatchPolicyPutBody,
  DispatchPolicyResponse,
} from "@you-brain/core/http/types.js";
import type { LaunchModeName } from "@you-brain/protocol";

import { BrowserDaemonError, type BrowserDaemon } from "../../api/client.js";
import { Banner } from "../../components/banner.js";
import { Button } from "../../components/button.js";
import { Card, CardHead, Section } from "../../components/card.js";
import { Chip } from "../../components/chip.js";
import { Row } from "../../components/row.js";
import { Toggle } from "../../components/toggle.js";
import { useToast } from "../../components/toast.js";
import { useDaemon } from "../../daemon-context.js";
import { SettingRow } from "./setting-row.js";
import {
  DISPATCH_MAX_MODES,
  OUTBOX_SUMMARY_MAX,
  buildSenderOptions,
  cancelFullAccessConfirm,
  commitPolicyPatch,
  confirmFullAccess,
  describeDispatchDevice,
  formatOutboxTime,
  initialFullAccessConfirm,
  mergeOutboxEntry,
  modeLabelKey,
  outboxStatusMeta,
  requestMaxModeChange,
  sortDispatchDevices,
  sortOutboxEntries,
  toggleAllowedProject,
  toggleAllowedSender,
  truncateSummary,
  type FullAccessConfirmState,
} from "./dispatch-model.js";

/** 我发出的派活列表轮询间隔；页面隐藏时跳过。 */
const OUTBOX_POLL_MS = 5_000;

function isUnsupportedError(error: unknown): boolean {
  if (error instanceof BrowserDaemonError) {
    return error.status === 404 || error.code === "NOT_SUPPORTED";
  }
  return false;
}

function isPolicyUnsupportedError(error: unknown): boolean {
  if (error instanceof BrowserDaemonError) {
    return error.status === 409;
  }
  return false;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}

export interface DispatchSectionProps {
  client?: BrowserDaemon;
  initialDevices?: DispatchDevicesResponse | null;
  initialPolicy?: DispatchPolicyResponse | null;
  initialPolicyUnavailable?: string | null;
  initialOutbox?: DispatchOutboxEntry[];
  initialExpandedId?: string | null;
  initialFullAccessPending?: boolean;
  initialDevicesError?: string | null;
  initialPolicyError?: string | null;
  initialOutboxError?: string | null;
}

/** 跨设备派活设置：在线设备总览、本机接收策略与我发出的派活列表。 */
export function DispatchSection(props: DispatchSectionProps = {}) {
  const daemon = useDaemon();
  const client = props.client ?? daemon.client;
  const { t, language, timeZone } = daemon;
  const { push } = useToast();

  const hasApi = typeof client.dispatchDevices === "function";

  const [unsupported, setUnsupported] = useState(!hasApi);
  const [devicesState, setDevicesState] = useState<DispatchDevicesResponse | null>(props.initialDevices ?? null);
  const [devicesError, setDevicesError] = useState<string | null>(props.initialDevicesError ?? null);

  const [policyData, setPolicyData] = useState<DispatchPolicyResponse | null>(props.initialPolicy ?? null);
  const [policyUnavailable, setPolicyUnavailable] = useState<string | null>(props.initialPolicyUnavailable ?? null);
  const [policyError, setPolicyError] = useState<string | null>(props.initialPolicyError ?? null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [fullAccessConfirm, setFullAccessConfirm] = useState<FullAccessConfirmState>(
    props.initialFullAccessPending ? { pending: true } : initialFullAccessConfirm(),
  );

  const [outbox, setOutbox] = useState<DispatchOutboxEntry[]>(
    props.initialOutbox ? sortOutboxEntries(props.initialOutbox) : [],
  );
  const [outboxError, setOutboxError] = useState<string | null>(props.initialOutboxError ?? null);
  const [expandedId, setExpandedId] = useState<string | null>(props.initialExpandedId ?? null);
  const [refreshingIds, setRefreshingIds] = useState<Record<string, boolean>>({});
  const [trustingIds, setTrustingIds] = useState<Record<string, boolean>>({});

  const loadDevices = useCallback(async () => {
    if (typeof client.dispatchDevices !== "function") {
      setUnsupported(true);
      return;
    }
    try {
      const next = await client.dispatchDevices();
      setDevicesState(next);
      setDevicesError(null);
      setUnsupported(false);
    } catch (error) {
      if (isUnsupportedError(error)) {
        setUnsupported(true);
        return;
      }
      setDevicesError(errorMessage(error, t("dispatchLoadError")));
    }
  }, [client, t]);

  const loadPolicy = useCallback(async () => {
    if (typeof client.dispatchPolicy !== "function") return;
    try {
      const next = await client.dispatchPolicy();
      setPolicyData(next);
      setPolicyUnavailable(null);
      setPolicyError(null);
    } catch (error) {
      if (isUnsupportedError(error)) return;
      if (isPolicyUnsupportedError(error)) {
        setPolicyData(null);
        setPolicyError(null);
        setPolicyUnavailable(errorMessage(error, t("dispatchLoadError")));
        return;
      }
      setPolicyError(errorMessage(error, t("dispatchLoadError")));
    }
  }, [client, t]);

  const loadOutbox = useCallback(async () => {
    if (typeof client.dispatchOutbox !== "function") return;
    try {
      const res = await client.dispatchOutbox();
      setOutbox(sortOutboxEntries(res.entries));
      setOutboxError(null);
    } catch (error) {
      if (isUnsupportedError(error)) return;
      setOutboxError(errorMessage(error, t("dispatchLoadError")));
    }
  }, [client, t]);

  const hasInitialSnapshot =
    props.initialDevices !== undefined ||
    props.initialPolicy !== undefined ||
    props.initialOutbox !== undefined ||
    props.initialDevicesError !== undefined ||
    props.initialPolicyError !== undefined ||
    props.initialOutboxError !== undefined;

  useEffect(() => {
    if (!hasApi) {
      setUnsupported(true);
      return;
    }
    if (hasInitialSnapshot) return;
    void Promise.all([loadDevices(), loadPolicy(), loadOutbox()]);
  }, [hasApi, hasInitialSnapshot, loadDevices, loadOutbox, loadPolicy]);

  useEffect(() => {
    if (!hasApi || unsupported || typeof client.dispatchOutbox !== "function") return;
    const poll = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadOutbox();
    };
    const timer = setInterval(poll, OUTBOX_POLL_MS);
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "hidden") {
        void loadOutbox();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [client, hasApi, loadOutbox, unsupported]);

  const savePolicy = useCallback(
    async (patch: DispatchPolicyPutBody) => {
      if (!policyData || typeof client.updateDispatchPolicy !== "function") return;
      const updatePolicy = client.updateDispatchPolicy.bind(client);
      setSavingPolicy(true);
      try {
        await commitPolicyPatch({
          current: policyData,
          patch,
          save: updatePolicy,
          onOptimistic: (next) => setPolicyData(next),
          onCommit: (saved) => {
            setPolicyData(saved);
            setPolicyError(null);
          },
          onRollback: (previous, message) => {
            setPolicyData(previous);
            push({ message, tone: "danger" });
          },
          fallbackError: t("dispatchPolicySaveFailed"),
        });
      } finally {
        setSavingPolicy(false);
      }
    },
    [client, policyData, push, t],
  );

  const handleSelectMaxMode = useCallback(
    (nextMode: LaunchModeName) => {
      if (!policyData) return;
      const transition = requestMaxModeChange(policyData.policy.maxMode, nextMode, fullAccessConfirm);
      setFullAccessConfirm(transition.state);
      if (transition.action === "apply") {
        void savePolicy({ maxMode: transition.mode });
      }
    },
    [fullAccessConfirm, policyData, savePolicy],
  );

  const handleConfirmFullAccess = useCallback(() => {
    const transition = confirmFullAccess(fullAccessConfirm);
    setFullAccessConfirm(transition.state);
    if (transition.action === "apply") {
      void savePolicy({ maxMode: transition.mode });
    }
  }, [fullAccessConfirm, savePolicy]);

  const refreshEntry = useCallback(
    async (dispatchId: string) => {
      if (typeof client.dispatchOutboxItem !== "function") return;
      setRefreshingIds((current) => ({ ...current, [dispatchId]: true }));
      try {
        const res = await client.dispatchOutboxItem(dispatchId, { refresh: true });
        setOutbox((current) => mergeOutboxEntry(current, res.entry));
        if (res.refreshError) {
          push({ message: res.refreshError, tone: "danger" });
        }
      } catch (error) {
        push({ message: errorMessage(error, t("dispatchOutboxRefreshFailed")), tone: "danger" });
      } finally {
        setRefreshingIds((current) => ({ ...current, [dispatchId]: false }));
      }
    },
    [client, push, t],
  );

  const handleTrustDevice = useCallback(
    async (deviceId: string, name: string) => {
      if (typeof client.dispatchTrustDevice !== "function") return;
      setTrustingIds((current) => ({ ...current, [deviceId]: true }));
      try {
        const saved = await client.dispatchTrustDevice({ deviceId });
        setPolicyData(saved);
        push({ message: t("dispatchTrustDeviceOk", { name }), tone: "success" });
      } catch (error) {
        push({ message: errorMessage(error, t("dispatchPolicySaveFailed")), tone: "danger" });
      } finally {
        setTrustingIds((current) => ({ ...current, [deviceId]: false }));
      }
    },
    [client, push, t],
  );

  if (!hasApi || unsupported) return null;

  const sortedDevices = devicesState ? sortDispatchDevices(devicesState.devices) : [];
  const selfDevice = sortedDevices.find((device) => device.self);
  const policy = policyData?.policy ?? null;
  const controlsDisabled = savingPolicy || !policy?.enabled;
  // 发送方名单同时服务「派活」与「查看 T3」，任何一个开着都能勾选。
  const sendersDisabled = savingPolicy || (!policy?.enabled && !policy?.viewT3);
  const senderOptions = policyData ? buildSenderOptions(policyData.knownSenders, policyData.policy) : [];
  const t3Unavailable =
    policyData !== null &&
    policyData.projects.length === 0 &&
    selfDevice?.dispatch?.t3.ready !== true;

  return (
    <Section title={t("dispatchTitle")}>
      <Card>
        <CardHead title={t("dispatchDevicesTitle")} />
        {devicesState !== null && !devicesState.enrolled ? (
          <div className="notion-form">
            <Banner tone="warn">{t("dispatchNotEnrolledHint")}</Banner>
          </div>
        ) : null}
        {devicesState !== null && devicesState.enrolled && !devicesState.connected ? (
          <div className="notion-form">
            <Banner tone="info">{t("dispatchDisconnectedHint")}</Banner>
          </div>
        ) : null}
        {devicesError ? (
          <div className="notion-form">
            <Banner
              tone="danger"
              action={
                <Button size="sm" variant="ghost" onClick={() => void loadDevices()}>
                  {t("retry")}
                </Button>
              }
            >
              {devicesError}
            </Banner>
          </div>
        ) : null}
        {!devicesError && sortedDevices.length === 0 ? (
          <div className="notion-form">
            <span className="settings-quiet">{t("dispatchDevicesEmpty")}</span>
          </div>
        ) : null}
        {sortedDevices.map((device) => {
          const row = describeDispatchDevice(device);
          const trustedIds = policyData?.trustedDeviceIds;
          const isTrusted = trustedIds ? trustedIds.includes(row.id) : false;
          const canTrust =
            !row.isSelf &&
            row.enrolled &&
            trustedIds !== undefined &&
            !isTrusted &&
            typeof client.dispatchTrustDevice === "function";
          const subtitleParts = [
            row.enrolled ? t("dispatchDeviceEnrolled") : t("dispatchDeviceNotEnrolled"),
            row.acceptsDispatch ? t("dispatchDeviceAccepting") : t("dispatchDeviceNotAccepting"),
            t("dispatchDeviceProjects", { count: row.projectCount }),
            t("dispatchDeviceMaxMode", { mode: t(modeLabelKey(row.maxMode)) }),
          ];
          return (
            <Row
              key={row.id}
              title={
                <span className="dispatch-chips">
                  <span>{row.name}</span>
                  {row.isSelf ? <Chip tone="accent">{t("dispatchDeviceSelf")}</Chip> : null}
                  {!row.isSelf && isTrusted ? <Chip tone="success">{t("dispatchDeviceTrusted")}</Chip> : null}
                </span>
              }
              titleText={row.name}
              subtitle={subtitleParts.join(" · ")}
              trailing={
                <span className="dispatch-chips">
                  {canTrust ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={trustingIds[row.id] === true}
                      onClick={() => void handleTrustDevice(row.id, row.name)}
                    >
                      {t("dispatchTrustDeviceBtn")}
                    </Button>
                  ) : null}
                  <Chip tone={row.onlineTone} dot>
                    {row.online ? t("dispatchDeviceOnline") : t("dispatchDeviceOffline")}
                  </Chip>
                </span>
              }
            />
          );
        })}
      </Card>

      <Card>
        <CardHead title={t("dispatchPolicyTitle")} />
        {policyUnavailable ? (
          <div className="notion-form">
            <Banner tone="info">{policyUnavailable}</Banner>
          </div>
        ) : null}
        {policyError ? (
          <div className="notion-form">
            <Banner
              tone="danger"
              action={
                <Button size="sm" variant="ghost" onClick={() => void loadPolicy()}>
                  {t("retry")}
                </Button>
              }
            >
              {policyError}
            </Banner>
          </div>
        ) : null}
        {policyData && policy ? (
          <>
            <SettingRow
              title={t("dispatchPolicyEnabled")}
              hint={t("dispatchPolicyEnabledHint")}
              control="toggle"
            >
              <Toggle
                checked={policy.enabled}
                label={t("dispatchPolicyEnabled")}
                disabled={savingPolicy}
                onChange={(checked) => {
                  if (!checked) setFullAccessConfirm(cancelFullAccessConfirm());
                  void savePolicy({ enabled: checked });
                }}
              />
            </SettingRow>

            <SettingRow
              title={t("dispatchPolicyNotify")}
              hint={t("dispatchPolicyNotifyHint")}
              control="toggle"
            >
              <Toggle
                checked={policy.notify}
                label={t("dispatchPolicyNotify")}
                disabled={controlsDisabled}
                onChange={(checked) => void savePolicy({ notify: checked })}
              />
            </SettingRow>

            <SettingRow
              title={t("dispatchPolicyViewT3")}
              hint={t("dispatchPolicyViewT3Hint")}
              control="toggle"
            >
              <Toggle
                checked={policy.viewT3}
                label={t("dispatchPolicyViewT3")}
                disabled={savingPolicy}
                onChange={(checked) => void savePolicy({ viewT3: checked })}
              />
            </SettingRow>

            <div className={controlsDisabled ? "dispatch-block is-disabled" : "dispatch-block"}>
              <span className="settings-kicker">{t("dispatchPolicyMaxMode")}</span>
              <span className="notion-label">{t("dispatchPolicyMaxModeHint")}</span>
              <div className="dispatch-options" role="radiogroup" aria-label={t("dispatchPolicyMaxMode")}>
                {DISPATCH_MAX_MODES.map((mode) => {
                  const checked = policy.maxMode === mode;
                  return (
                    <label
                      key={mode}
                      className={controlsDisabled ? "dispatch-option is-disabled" : "dispatch-option"}
                    >
                      <input
                        type="radio"
                        name="dispatch-max-mode"
                        value={mode}
                        checked={checked}
                        disabled={controlsDisabled}
                        onChange={() => handleSelectMaxMode(mode)}
                      />
                      <span>{t(modeLabelKey(mode))}</span>
                      {mode === "full-access" && (checked || fullAccessConfirm.pending) ? (
                        <span className="dispatch-risk">{t("dispatchFullAccessRisk")}</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              {fullAccessConfirm.pending && policy.enabled ? (
                <div className="dispatch-confirm-bar" role="region" aria-label={t("dispatchFullAccessConfirm")}>
                  <span className="dispatch-risk">{t("dispatchFullAccessRisk")}</span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={savingPolicy}
                    onClick={handleConfirmFullAccess}
                  >
                    {t("dispatchFullAccessConfirm")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={savingPolicy}
                    onClick={() => setFullAccessConfirm(cancelFullAccessConfirm())}
                  >
                    {t("dispatchFullAccessCancel")}
                  </Button>
                </div>
              ) : null}
            </div>

            <div className={controlsDisabled ? "dispatch-block is-disabled" : "dispatch-block"}>
              <span className="settings-kicker">{t("dispatchPolicyProjects")}</span>
              <span className="notion-label">{t("dispatchPolicyProjectsHint")}</span>
              <label className={controlsDisabled ? "dispatch-option is-disabled" : "dispatch-option"}>
                <input
                  type="checkbox"
                  checked={policy.allProjects}
                  disabled={controlsDisabled}
                  onChange={(event) => void savePolicy({ allProjects: event.target.checked })}
                />
                <span>{t("dispatchPolicyAllProjects")}</span>
              </label>
              {policy.allProjects ? null : t3Unavailable ? (
                <span className="settings-quiet">{t("dispatchT3Unavailable")}</span>
              ) : (
                <div className="dispatch-options">
                  {policyData.projects.map((project) => {
                    const checked = policy.allowedProjects.includes(project.id);
                    return (
                      <label
                        key={project.id}
                        className={controlsDisabled ? "dispatch-option is-disabled" : "dispatch-option"}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={controlsDisabled}
                          onChange={(event) => {
                            const nextProjects = toggleAllowedProject(
                              policy.allowedProjects,
                              project.id,
                              event.target.checked,
                            );
                            void savePolicy({ allowedProjects: nextProjects });
                          }}
                        />
                        <span>{project.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={sendersDisabled ? "dispatch-block is-disabled" : "dispatch-block"}>
              <span className="settings-kicker">{t("dispatchPolicySenders")}</span>
              <span className="notion-label">{t("dispatchPolicySendersHint")}</span>
              <label className={sendersDisabled ? "dispatch-option is-disabled" : "dispatch-option"}>
                <input
                  type="checkbox"
                  checked={policy.trustEnrolled}
                  disabled={sendersDisabled}
                  onChange={(event) => void savePolicy({ trustEnrolled: event.target.checked })}
                />
                <span>{t("dispatchPolicyTrustEnrolled")}</span>
              </label>
              {policy.trustEnrolled ? null : senderOptions.length === 0 ? (
                <span className="settings-quiet">{t("dispatchSendersEmpty")}</span>
              ) : (
                <div className="dispatch-options">
                  {senderOptions.map((sender) => {
                    const disabled = sendersDisabled || !sender.selectable;
                    return (
                      <label
                        key={sender.deviceId}
                        className={disabled ? "dispatch-option is-disabled" : "dispatch-option"}
                      >
                        <input
                          type="checkbox"
                          checked={sender.checked}
                          disabled={disabled}
                          onChange={(event) => {
                            const currentIds = policy.allowedSenders.map((item) => item.deviceId);
                            const nextIds = toggleAllowedSender(
                              currentIds,
                              { deviceId: sender.deviceId, enrolled: sender.enrolled },
                              event.target.checked,
                            );
                            void savePolicy({ allowedSenders: nextIds });
                          }}
                        />
                        <span>{sender.name}</span>
                        {!sender.enrolled ? (
                          <span className="settings-quiet">（{t("dispatchSenderNotEnrolled")}）</span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}
      </Card>

      <Card>
        <CardHead title={t("dispatchOutboxTitle")} />
        {outboxError ? (
          <div className="notion-form">
            <Banner
              tone="danger"
              action={
                <Button size="sm" variant="ghost" onClick={() => void loadOutbox()}>
                  {t("retry")}
                </Button>
              }
            >
              {outboxError}
            </Banner>
          </div>
        ) : null}
        {!outboxError && outbox.length === 0 ? (
          <div className="notion-form">
            <span className="settings-quiet">{t("dispatchOutboxEmpty")}</span>
          </div>
        ) : null}
        {outbox.map((entry) => {
          const statusMeta = outboxStatusMeta(entry.status);
          const preview = truncateSummary(entry.lastSummary, OUTBOX_SUMMARY_MAX);
          const expanded = expandedId === entry.dispatchId;
          const refreshing = refreshingIds[entry.dispatchId] === true;
          return (
            <div key={entry.dispatchId} className="row-wrap">
              <div className="dispatch-outbox-head">
                <button
                  type="button"
                  className="dispatch-outbox-toggle"
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedId((current) =>
                      current === entry.dispatchId ? null : entry.dispatchId,
                    )
                  }
                >
                  <span className="dispatch-outbox-title-row">
                    <span className="dispatch-outbox-title">{entry.title}</span>
                    <Chip tone={statusMeta.tone}>{t(statusMeta.labelKey)}</Chip>
                  </span>
                  <span className="dispatch-outbox-meta">
                    {entry.deviceName} · {formatOutboxTime(entry.updatedAt, language, timeZone)}
                  </span>
                  {preview.text ? (
                    <span className="dispatch-outbox-preview">{preview.text}</span>
                  ) : null}
                </button>
                {typeof client.dispatchOutboxItem === "function" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={refreshing}
                    onClick={() => void refreshEntry(entry.dispatchId)}
                  >
                    {t("dispatchOutboxRefresh")}
                  </Button>
                ) : null}
              </div>
              {expanded ? (
                <div className="row-detail dispatch-outbox-detail">
                  <p className="dispatch-outbox-summary">
                    {entry.lastSummary?.trim() ? entry.lastSummary : t("dispatchOutboxNoSummary")}
                  </p>
                  {entry.error ? (
                    <span className="settings-inline-bad">
                      {t("dispatchOutboxError")}: {entry.error}
                    </span>
                  ) : null}
                  {entry.threadUrl ? (
                    <div>
                      <span className="notion-label">{t("dispatchOutboxThreadUrl")}</span>
                      <code className="dispatch-thread-url">{entry.threadUrl}</code>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>
    </Section>
  );
}
